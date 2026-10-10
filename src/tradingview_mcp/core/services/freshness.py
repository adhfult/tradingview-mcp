"""Data-freshness metadata for MCP tool results.

Upstream fetches (TradingView scanner/TA, Yahoo chart API) call :func:`record`
when they succeed. The MCP tool boundary in ``server.py`` opens a collection
around each tool call with :func:`start_collection`, then :func:`attach`
folds the summary into the result as ``data_freshness``.

Everything here is stdlib only and never raises from :func:`record`, so
metadata capture can never break a data call.

``fetched_at`` and ``as_of_utc`` mean when the data was fetched from upstream,
not market time.
"""
from __future__ import annotations

import contextvars
import copy
import threading
import time
from datetime import datetime, timezone
from typing import Any, Optional

_COLLECTOR: contextvars.ContextVar[Optional[list]] = contextvars.ContextVar(
    "tvmcp_freshness", default=None
)
_LOCK = threading.Lock()


def record(
    source: str,
    fetched_at: float,
    *,
    cache_hit: bool = False,
    stale: bool = False,
    auth: str = "anonymous",
) -> None:
    """Append one fetch record to the active collector, if there is one."""
    try:
        collector = _COLLECTOR.get()
        if collector is None:
            return
        entry = {
            "source": source,
            "fetched_at": float(fetched_at),
            "cache_hit": bool(cache_hit),
            "stale": bool(stale),
            "auth": auth,
        }
        with _LOCK:
            collector.append(entry)
    except Exception:  # noqa: BLE001 - metadata must never break a data call
        pass


def start_collection() -> tuple[list, contextvars.Token]:
    """Begin collecting records for the current context.

    The list is shared by reference: ``asyncio.to_thread`` and
    ``asyncio.gather`` copy the context, so records made in worker threads
    or sibling tasks land in the same list.
    """
    records: list = []
    token = _COLLECTOR.set(records)
    return records, token


def stop_collection(token: contextvars.Token) -> None:
    """End the collection started by :func:`start_collection`."""
    try:
        _COLLECTOR.reset(token)
    except (ValueError, RuntimeError):
        # Token from another context or already used: fall back to no collector.
        _COLLECTOR.set(None)


def summarize(records: list[dict], now: Optional[float] = None) -> Optional[dict]:
    """Collapse fetch records into one ``data_freshness`` dict, or None if empty."""
    if not records:
        return None
    now = time.time() if now is None else now
    oldest = min(r["fetched_at"] for r in records)
    age_seconds = max(0, int(now - oldest))
    auths = {r["auth"] for r in records}
    if auths == {"session"}:
        auth = "session"
    elif auths == {"anonymous"}:
        auth = "anonymous"
    else:
        auth = "mixed"
    stale = any(r["stale"] for r in records)
    summary: dict[str, Any] = {
        "sources": sorted({r["source"] for r in records}),
        "as_of_utc": datetime.fromtimestamp(oldest, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "age_seconds": age_seconds,
        "stale": stale,
        "cache_hit": any(r["cache_hit"] for r in records),
        "auth": auth,
    }
    if stale:
        summary["note"] = f"Upstream failed; serving cached data up to {age_seconds}s old."
    return summary


def attach(result: Any, records: list[dict], now: Optional[float] = None) -> Any:
    """Return ``result`` with ``data_freshness`` added (never mutating the input).

    Dict results always get the key (unless they already have one). List
    results get it per dict row only when the data is stale, so fresh list
    results are returned exactly as they are today.

    Tools may hand back an object that is also held in a module-level cache;
    writing the key into it would leak this call's freshness (possibly
    ``stale: true``) into every later response. So the key goes on a shallow
    copy (dict) or a new list of shallow-copied rows (list), and the caller's
    object is left untouched. When nothing is added, ``result`` itself is
    returned.
    """
    summary = summarize(records, now=now)
    if summary is None:
        return result
    if isinstance(result, dict):
        # Error envelopes / error results serve no data, so a "serving cached
        # data" note on them would be misleading.
        if "data_freshness" in result or "error" in result:
            return result
        out = copy.copy(result)
        out["data_freshness"] = summary
        return out
    if isinstance(result, list) and summary["stale"]:
        rows: list = []
        for row in result:
            if isinstance(row, dict) and "data_freshness" not in row:
                row = copy.copy(row)
                row["data_freshness"] = dict(summary)
            rows.append(row)
        return rows
    return result

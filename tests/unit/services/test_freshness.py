"""Data-freshness metadata: collector, summary, screener cache paths, and the
server tool-boundary wrapper. All upstream calls are faked; nothing hits the network."""
from __future__ import annotations

import asyncio
import json
import sys
import time
from datetime import datetime, timezone
from unittest import mock

import pytest

from tradingview_mcp.core.services import freshness
from tradingview_mcp.core.services import screener_provider as sp


NOW = 1_800_000_000.0


def _rec(source="tradingview_scanner", fetched_at=NOW, **kw):
    base = {"source": source, "fetched_at": fetched_at, "cache_hit": False, "stale": False, "auth": "anonymous"}
    base.update(kw)
    return base


# ── 1. summarize ────────────────────────────────────────────────────────────

def test_summarize_empty_is_none():
    assert freshness.summarize([]) is None


def test_summarize_single_fresh_record():
    fetched = datetime(2026, 10, 10, 12, 0, 0, tzinfo=timezone.utc).timestamp()
    out = freshness.summarize([_rec(fetched_at=fetched)], now=fetched + 42.9)
    assert out == {
        "sources": ["tradingview_scanner"],
        "as_of_utc": "2026-10-10T12:00:00Z",
        "age_seconds": 42,
        "stale": False,
        "cache_hit": False,
        "auth": "anonymous",
    }
    assert "note" not in out


def test_summarize_age_is_never_negative():
    out = freshness.summarize([_rec(fetched_at=NOW + 500)], now=NOW)
    assert out["age_seconds"] == 0


def test_summarize_mixed_auth():
    out = freshness.summarize([_rec(auth="session"), _rec(auth="anonymous")], now=NOW)
    assert out["auth"] == "mixed"


def test_summarize_session_only():
    out = freshness.summarize([_rec(auth="session")], now=NOW)
    assert out["auth"] == "session"


def test_summarize_uses_oldest_fetch_and_lists_sources_sorted():
    recs = [
        _rec(source="yahoo", fetched_at=NOW - 10),
        _rec(source="tradingview_scanner", fetched_at=NOW - 300),
    ]
    out = freshness.summarize(recs, now=NOW)
    assert out["sources"] == ["tradingview_scanner", "yahoo"]
    assert out["age_seconds"] == 300


def test_summarize_stale_has_note_and_correct_age():
    fetched = NOW - 1234.0
    out = freshness.summarize(
        [_rec(fetched_at=fetched, stale=True, cache_hit=True)], now=NOW
    )
    assert out["stale"] is True
    assert out["cache_hit"] is True
    assert out["age_seconds"] == 1234
    assert out["note"] == "Upstream failed; serving cached data up to 1234s old."


# ── 2. collector across threads and gather ──────────────────────────────────

def test_collector_survives_asyncio_to_thread():
    async def main():
        records, token = freshness.start_collection()
        try:
            await asyncio.to_thread(freshness.record, "x", NOW)
            return list(records)
        finally:
            freshness.stop_collection(token)

    out = asyncio.run(main())
    assert len(out) == 1
    assert out[0]["source"] == "x"
    assert out[0]["fetched_at"] == NOW


def test_collector_shared_across_gather():
    async def worker(src):
        await asyncio.sleep(0)
        freshness.record(src, NOW)

    async def main():
        records, token = freshness.start_collection()
        try:
            await asyncio.gather(worker("a"), worker("b"))
            return list(records)
        finally:
            freshness.stop_collection(token)

    out = asyncio.run(main())
    assert sorted(r["source"] for r in out) == ["a", "b"]


# ── 3. record() without a collector ─────────────────────────────────────────

def test_record_without_collector_is_noop_and_does_not_raise():
    assert freshness._COLLECTOR.get() is None
    freshness.record("x", NOW)  # must not raise
    freshness.record("x", NOW, cache_hit=True, stale=True, auth="session")
    assert freshness._COLLECTOR.get() is None


def test_record_swallows_bad_input_inside_collection():
    records, token = freshness.start_collection()
    try:
        freshness.record("x", "not-a-number")  # must not raise
        assert records == []
    finally:
        freshness.stop_collection(token)


# ── 4. screener_provider cache paths ────────────────────────────────────────

@pytest.fixture
def ta_env(monkeypatch):
    """Hermetic TA resilience env: no retry sleeps, no throttle gap, no cooldown."""
    with sp._SCREENER_CACHE_LOCK:
        sp._SCREENER_CACHE.clear()
    with sp._TA_FAILURE_LOCK:
        sp._LAST_TA_FAILURE_TS = 0.0
    monkeypatch.setenv("TRADINGVIEW_MCP_RETRY_DELAYS", "0.01,0.02,0.03")
    monkeypatch.setenv("TRADINGVIEW_MCP_RETRY_JITTER", "0")
    monkeypatch.setenv("TRADINGVIEW_MCP_FAILURE_COOLDOWN_S", "0")
    monkeypatch.setenv("TRADINGVIEW_MCP_MIN_INTERVAL_S", "0")
    monkeypatch.setenv("TRADINGVIEW_MCP_CACHE_TTL", "60")
    yield
    with sp._SCREENER_CACHE_LOCK:
        sp._SCREENER_CACHE.clear()


def _fake_ta(monkeypatch, fn):
    module = mock.MagicMock()
    module.get_multiple_analysis = fn
    monkeypatch.setitem(sys.modules, "tradingview_ta", module)


def _empty_body_error() -> json.JSONDecodeError:
    return json.JSONDecodeError("Expecting value", "", 0)


def _collect(fn, *args):
    records, token = freshness.start_collection()
    try:
        out = fn(*args)
    finally:
        freshness.stop_collection(token)
    return out, list(records)


def test_ta_fresh_fetch_records_one_non_stale_entry(ta_env, monkeypatch):
    _fake_ta(monkeypatch, lambda screener, interval, symbols, **kw: {"EGX:ASCM": "ok"})
    _, recs = _collect(sp.resilient_get_multiple_analysis, "egypt", "1D", ["EGX:ASCM"])
    assert len(recs) == 1
    assert recs[0]["source"] == "tradingview_scanner"
    assert recs[0]["stale"] is False
    assert recs[0]["cache_hit"] is False
    assert recs[0]["auth"] == "anonymous"


def test_ta_second_call_is_cache_hit(ta_env, monkeypatch):
    calls = {"n": 0}

    def fake_gma(screener, interval, symbols, **kw):
        calls["n"] += 1
        return {"EGX:ASCM": "ok"}

    _fake_ta(monkeypatch, fake_gma)
    sp.resilient_get_multiple_analysis("egypt", "1D", ["EGX:ASCM"])  # prime cache
    _, recs = _collect(sp.resilient_get_multiple_analysis, "egypt", "1D", ["EGX:ASCM"])
    assert calls["n"] == 1
    assert len(recs) == 1
    assert recs[0]["cache_hit"] is True
    assert recs[0]["stale"] is False
    # fetched_at is the original cache-entry timestamp, not "now"
    assert time.time() - recs[0]["fetched_at"] >= 0


def test_ta_forced_stale_fallback_records_stale(ta_env, monkeypatch, capsys):
    # Fresh TTL 0 means every lookup misses the fresh window, so the stale
    # entry written by the first (successful) call is the only thing left.
    monkeypatch.setenv("TRADINGVIEW_MCP_CACHE_TTL", "0")
    calls = {"n": 0}

    def fake_gma(screener, interval, symbols, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            return {"EGX:ASCM": "good_payload"}
        raise _empty_body_error()

    _fake_ta(monkeypatch, fake_gma)
    first, recs_first = _collect(sp.resilient_get_multiple_analysis, "egypt", "1D", ["EGX:ASCM"])
    assert first == {"EGX:ASCM": "good_payload"}
    assert len(recs_first) == 1 and recs_first[0]["stale"] is False

    result, recs = _collect(sp.resilient_get_multiple_analysis, "egypt", "1D", ["EGX:ASCM"])
    assert result == {"EGX:ASCM": "good_payload"}
    assert len(recs) == 1
    assert recs[0]["stale"] is True
    assert recs[0]["cache_hit"] is True
    summary = freshness.summarize(recs)
    assert summary["stale"] is True
    assert "note" in summary


def test_scan_with_retry_records_fresh_and_session_auth(ta_env):
    class FakeQuery:
        def get_scanner_data(self, cookies=None):
            return (1, "df")

    _, recs = _collect(lambda: sp._scan_with_retry(FakeQuery()))
    assert len(recs) == 1
    assert recs[0]["source"] == "tradingview_scanner"
    assert recs[0]["auth"] == "anonymous"

    _, recs = _collect(lambda: sp._scan_with_retry(FakeQuery(), cookies={"sessionid": "x"}))
    assert recs[0]["auth"] == "session"


def test_scan_with_retry_stale_fallback_records_stale(ta_env, monkeypatch):
    monkeypatch.setenv("TRADINGVIEW_MCP_CACHE_TTL", "0")
    key = ("indicators_v1", "EGX", ("EGX:ASCM",), "1D", None)
    sp._cache_set(key, (1, "stale_df"))
    with sp._SCREENER_CACHE_LOCK:
        ts, payload = sp._SCREENER_CACHE[key]
        sp._SCREENER_CACHE[key] = (ts - 120.0, payload)

    class FakeQuery:
        def get_scanner_data(self, cookies=None):
            raise _empty_body_error()

    out, recs = _collect(lambda: sp._scan_with_retry(FakeQuery(), cache_key=key))
    assert out == (1, "stale_df")
    assert len(recs) == 1
    assert recs[0]["stale"] is True
    assert recs[0]["cache_hit"] is True
    assert time.time() - recs[0]["fetched_at"] >= 119


# ── 5. attach() and the server tool-boundary wrapper ───────────────────────

def test_attach_adds_key_to_dict_result():
    result = {"symbol": "X"}
    out = freshness.attach(result, [_rec()], now=NOW)
    assert out is result
    assert result["data_freshness"]["sources"] == ["tradingview_scanner"]


def test_attach_leaves_dict_without_records_alone():
    result = {"symbol": "X"}
    freshness.attach(result, [], now=NOW)
    assert result == {"symbol": "X"}


def test_attach_fresh_list_is_unchanged():
    rows = [{"symbol": "A"}, {"symbol": "B"}]
    before = [dict(r) for r in rows]
    out = freshness.attach(rows, [_rec()], now=NOW)
    assert out == before
    assert all("data_freshness" not in r for r in out)


def test_attach_stale_list_adds_key_per_row():
    rows = [{"symbol": "A"}, "not-a-dict", {"symbol": "B"}]
    out = freshness.attach(rows, [_rec(stale=True, cache_hit=True, fetched_at=NOW - 60)], now=NOW)
    assert out[0]["data_freshness"]["stale"] is True
    assert out[0]["data_freshness"]["note"].startswith("Upstream failed")
    assert out[1] == "not-a-dict"
    assert out[2]["data_freshness"]["age_seconds"] == 60


def test_attach_never_overwrites_existing_key():
    result = {"data_freshness": "mine"}
    freshness.attach(result, [_rec()], now=NOW)
    assert result["data_freshness"] == "mine"


def test_server_wrapper_installed_on_every_tool():
    from tradingview_mcp import server

    tools = server.mcp._tool_manager.list_tools()
    assert server._FRESHNESS_TOOL_COUNT == len(tools)
    assert all(t.is_async for t in tools)


def test_server_dict_tool_gains_data_freshness(monkeypatch):
    from tradingview_mcp import server

    async def fake_quote(symbol):
        freshness.record("yahoo", time.time())
        return {"symbol": symbol, "price": 1.0}

    monkeypatch.setattr(server, "get_price_async", fake_quote)
    tool = next(t for t in server.mcp._tool_manager.list_tools() if t.name == "yahoo_price")
    out = asyncio.run(tool.fn(symbol="AAPL"))
    assert out["symbol"] == "AAPL"
    assert out["data_freshness"]["sources"] == ["yahoo"]
    assert out["data_freshness"]["stale"] is False


def test_server_fresh_list_tool_unchanged(monkeypatch):
    from tradingview_mcp import server

    def fake_trending(exchange, timeframe, limit, sort="desc"):
        freshness.record("tradingview_scanner", time.time())
        return [{"symbol": "X", "changePercent": -3.2, "indicators": {"RSI": 41.0}}]

    monkeypatch.setattr(server, "fetch_trending_analysis", fake_trending)
    tool = next(t for t in server.mcp._tool_manager.list_tools() if t.name == "top_losers")
    out = asyncio.run(tool.fn(exchange="KUCOIN", timeframe="15m", limit=5))
    assert isinstance(out, list)
    assert all("data_freshness" not in row for row in out)


def test_server_stale_list_tool_gets_rows_marked(monkeypatch):
    from tradingview_mcp import server

    def fake_trending(exchange, timeframe, limit, sort="desc"):
        freshness.record("tradingview_scanner", time.time() - 90, cache_hit=True, stale=True)
        return [{"symbol": "X", "changePercent": -3.2, "indicators": {"RSI": 41.0}}]

    monkeypatch.setattr(server, "fetch_trending_analysis", fake_trending)
    tool = next(t for t in server.mcp._tool_manager.list_tools() if t.name == "top_losers")
    out = asyncio.run(tool.fn(exchange="KUCOIN", timeframe="15m", limit=5))
    assert len(out) == 1
    assert out[0]["data_freshness"]["stale"] is True
    assert out[0]["data_freshness"]["age_seconds"] >= 90

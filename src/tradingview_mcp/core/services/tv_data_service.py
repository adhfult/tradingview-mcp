"""TradingView data service: the ``tv_*`` tools and shared helpers for the
TradingView candle source used by backtests.

Every call goes through the Node bridge (``bridge/server.mjs``) via
:mod:`tv_bridge_client`. Each public function returns a result dict or a
structured error envelope; it never raises for bridge or validation problems.

Credentials are read once when the bridge process starts. Nothing here returns
or logs the cookie values.
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Any, Optional

from tradingview_mcp.core.errors import ErrorCode, ScreenerServiceError, make_error
from tradingview_mcp.core.services import freshness, tv_bridge_client
from tradingview_mcp.core.services.tv_bridge_client import SETUP_HINT, BridgeError
from tradingview_mcp.core.utils.validators import (
    EXCHANGE_SCREENER,
    _TA_ONLY_SCREENERS,
    normalize_tradingview_symbol,
    to_tv_timeframe,
    validate_exchange,
    validate_timeframe,
)

# Shown whenever AUTH_FAILED reaches a caller. The bridge loads credentials once
# at start-up, so restarting only the bridge would keep the old cookies.
AUTH_RESTART_HINT = (
    "Update TRADINGVIEW_SESSION_ID / TRADINGVIEW_SESSION_SIGN in .env, then restart the MCP server."
)

# Quote fields returned by tv_quotes (names from @mathieuc/tradingview quote/fields.d.ts).
QUOTE_KEYS = (
    "lp", "ch", "chp", "volume", "bid", "ask",
    "current_session", "update_mode", "description", "currency_code",
)
HOTLIST_KINDS = ("gainers", "losers", "mostActive", "volumeGainers")
MAX_QUOTE_SYMBOLS = 50

# EXCHANGE:SYMBOL, the shape the quotes and backtest inputs must match.
_TV_SYMBOL_RE = re.compile(r"^[A-Z0-9_.!\-]+:[A-Z0-9_.!\-]+$")
_MAX_TV_SYMBOL_LEN = 40  # the bridge rejects longer symbols


def is_tv_symbol(value: Any) -> bool:
    """True when *value* looks like ``EXCHANGE:SYMBOL`` (case-insensitive, at most 40 characters)."""
    if not isinstance(value, str):
        return False
    text = value.strip().upper()
    return len(text) <= _MAX_TV_SYMBOL_LEN and bool(_TV_SYMBOL_RE.match(text))


def bridge_error_message(err: BridgeError) -> str:
    """User-facing text for a bridge error. AUTH_FAILED always carries the restart hint."""
    if err.code == "AUTH_FAILED":
        return f"TradingView rejected the session cookies. {AUTH_RESTART_HINT}"
    return err.message


def _bridge_envelope(err: BridgeError) -> dict[str, Any]:
    if err.code == "AUTH_FAILED":
        return make_error(ErrorCode.AUTH_FAILED, bridge_error_message(err))
    return err.to_envelope()


def _client():
    return tv_bridge_client.get_client()


def _record(client, *, uses_account: bool = True) -> None:
    """Note a successful bridge data call for ``data_freshness``.

    ``uses_account=False`` is for bridge methods that never send the cookies
    (``search`` and ``hotlist`` are anonymous in the bridge), so they are labelled
    anonymous even when credentials are configured.
    """
    session = uses_account and client.has_credentials()
    freshness.record("tradingview_bridge", time.time(), auth="session" if session else "anonymous")


def _invalid(message: str) -> ScreenerServiceError:
    return ScreenerServiceError(ErrorCode.INVALID_PARAMETER, message, retryable=False)


def _check_int(value: Any, name: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise _invalid(f"{name} must be a whole number from {low} to {high}")
    return value


def _nonblank(value: Any, name: str, max_len: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _invalid(f"{name} must be a non-empty string")
    text = value.strip()
    if len(text) > max_len:
        raise _invalid(f"{name} must be at most {max_len} characters")
    return text


def _full_symbol(symbol: Any, exchange: Any) -> str:
    """Build EXCHANGE:SYMBOL from a bare symbol and an exchange, as the screener tools do."""
    text = _nonblank(symbol, "symbol", 60)
    full = normalize_tradingview_symbol(text, validate_exchange(exchange))
    if not is_tv_symbol(full):
        raise _invalid(f"symbol {text!r} does not form a valid EXCHANGE:SYMBOL (letters, digits, _ . ! -)")
    return full


def _iso_utc(ts: Any) -> str:
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── tv_status ─────────────────────────────────────────────────────────────────

def tv_status() -> dict[str, Any]:
    """Whether the bridge can run and whether session cookies are set. Never returns values."""
    client = _client()
    reason = client.check_configured()
    configured = reason is None
    has = client.has_credentials()
    cooling = client.cooling_down()
    # is_available() is False while cooling down; report that state instead of "down".
    bridge_ok = False if cooling else client.is_available()
    return {
        "configured": configured,
        "reason": reason,
        "has_credentials": has,
        "bridge_ok": bridge_ok,
        "cooling_down": cooling,
        "cooldown_remaining_s": round(client.cooldown_remaining_s(), 1) if cooling else 0.0,
        "setup": None if configured else SETUP_HINT,
        "note": (
            f"Credentials present: {'yes' if has else 'no'}. This does not check that the "
            "cookies are valid; a TradingView call that returns AUTH_FAILED means they need "
            f"refreshing. {AUTH_RESTART_HINT}"
        ),
    }


# ── tv_candles ────────────────────────────────────────────────────────────────

def get_candles(symbol: str, exchange: str, timeframe: str = "1D", count: int = 300) -> dict[str, Any]:
    """Recent OHLCV bars for one symbol (``count`` is 1..1000)."""
    columns = ["time", "open", "high", "low", "close", "volume"]
    try:
        count = _check_int(count, "count", 1, 1000)
        full = _full_symbol(symbol, exchange)
        tf = validate_timeframe(timeframe, "1D")
        code = to_tv_timeframe(tf)
        client = _client()
        bars = client.call("candles", {"symbol": full, "timeframe": code, "count": count})
    except ScreenerServiceError as exc:
        return exc.to_envelope()
    except BridgeError as err:
        return _bridge_envelope(err)
    _record(client)

    rows = []
    for bar in bars if isinstance(bars, list) else []:
        if not isinstance(bar, dict) or bar.get("time") is None:
            continue
        rows.append([
            _iso_utc(bar["time"]), bar.get("open"), bar.get("high"), bar.get("low"),
            bar.get("close"), bar.get("volume"),
        ])
    if not rows:
        return make_error(ErrorCode.NO_DATA, f"TradingView returned no candles for {full}", symbol=full)

    first_open, last_close = rows[0][1], rows[-1][4]
    change = None
    if isinstance(first_open, (int, float)) and first_open and isinstance(last_close, (int, float)):
        # Over the range: first bar's open to the last bar's close.
        change = round((last_close - first_open) / first_open * 100, 2)
    return {
        "symbol": full,
        "timeframe": tf,
        "bars": len(rows),
        "columns": columns,
        "rows": rows,
        "first": rows[0][0],
        "last": rows[-1][0],
        "last_close": last_close,
        "change_pct_over_range": change,
    }


# ── tv_quotes ─────────────────────────────────────────────────────────────────

def _parse_symbols(symbols: Any) -> list[str]:
    if not isinstance(symbols, str):
        raise _invalid("symbols must be a comma-separated string of EXCHANGE:SYMBOL")
    entries: list[str] = []
    for part in symbols.split(","):
        item = part.strip().upper()
        if item and item not in entries:
            entries.append(item)
    if not entries or len(entries) > MAX_QUOTE_SYMBOLS:
        raise _invalid(f"symbols must list 1 to {MAX_QUOTE_SYMBOLS} EXCHANGE:SYMBOL entries")
    bad = [item for item in entries if not is_tv_symbol(item)]
    if bad:
        raise _invalid(f"not EXCHANGE:SYMBOL: {', '.join(bad)}")
    return entries


def get_quotes(symbols: str) -> dict[str, Any]:
    """Latest quote for each ``EXCHANGE:SYMBOL`` in a comma-separated string."""
    try:
        entries = _parse_symbols(symbols)
        client = _client()
        raw = client.call("quotes", {"symbols": entries})
    except ScreenerServiceError as exc:
        return exc.to_envelope()
    except BridgeError as err:
        return _bridge_envelope(err)
    _record(client)

    by_symbol = {str(k).upper(): v for k, v in raw.items()} if isinstance(raw, dict) else {}
    quotes: dict[str, dict[str, Any]] = {}
    missing: list[str] = []
    for sym in entries:
        data = by_symbol.get(sym)
        if not isinstance(data, dict):
            missing.append(sym)
            continue
        quotes[sym] = {key: data[key] for key in QUOTE_KEYS if data.get(key) is not None}
    return {"quotes": quotes, "missing": missing}


# ── tv_indicator ──────────────────────────────────────────────────────────────

def get_indicator(
    symbol: str,
    exchange: str,
    indicator: str,
    timeframe: str = "1D",
    inputs: Optional[dict] = None,
    count: int = 100,
) -> dict[str, Any]:
    """Run a TradingView indicator or strategy and return its last ``count`` values."""
    try:
        count = _check_int(count, "count", 1, 500)
        full = _full_symbol(symbol, exchange)
        tf = validate_timeframe(timeframe, "1D")
        code = to_tv_timeframe(tf)
        name = _nonblank(indicator, "indicator", 200)
        if inputs is not None and not isinstance(inputs, dict):
            raise _invalid("inputs must be an object of indicator inputs, or omitted")
        params: dict[str, Any] = {"symbol": full, "timeframe": code, "indicator": name, "count": count}
        if inputs is not None:
            params["inputs"] = inputs
        client = _client()
        result = client.call("indicator", params)
    except ScreenerServiceError as exc:
        return exc.to_envelope()
    except BridgeError as err:
        return _bridge_envelope(err)
    _record(client)

    out = dict(result) if isinstance(result, dict) else {}
    out.update(symbol=full, timeframe=tf, indicator=name)
    return out


# ── tv_symbol_search ──────────────────────────────────────────────────────────

def search_symbols(query: str, type: Optional[str] = None) -> dict[str, Any]:
    """Search TradingView symbols by text, optionally filtered by ``type``."""
    try:
        text = _nonblank(query, "query", 60)
        params: dict[str, Any] = {"query": text}
        if type:
            params["type"] = _nonblank(type, "type", 60)
        client = _client()
        results = client.call("search", params)
    except ScreenerServiceError as exc:
        return exc.to_envelope()
    except BridgeError as err:
        return _bridge_envelope(err)
    _record(client, uses_account=False)  # the bridge's search sends no credentials

    rows = results if isinstance(results, list) else []
    return {"query": text, "count": len(rows), "results": rows}


# ── tv_hotlist ────────────────────────────────────────────────────────────────

def get_hotlist(kind: str = "gainers", market: str = "crypto", limit: int = 25) -> dict[str, Any]:
    """Gainers, losers, most active or volume gainers for one scanner market."""
    try:
        if kind not in HOTLIST_KINDS:
            raise _invalid(f"kind must be one of {', '.join(HOTLIST_KINDS)}")
        limit = _check_int(limit, "limit", 1, 100)
        market_name = _nonblank(market, "market", 40)
        client = _client()
        result = client.call("hotlist", {"kind": kind, "market": market_name, "range": [0, limit]})
    except ScreenerServiceError as exc:
        return exc.to_envelope()
    except BridgeError as err:
        return _bridge_envelope(err)
    _record(client, uses_account=False)  # the bridge's hotlist is deliberately anonymous

    out = dict(result) if isinstance(result, dict) else {}
    out.update(kind=kind, market=market_name)
    return out


# ── Backtest candle source ────────────────────────────────────────────────────

# Bars per year for Sharpe annualization, by how the market trades.
_TV_ANNUALIZATION_CRYPTO = {"15m": 35040, "1h": 8760, "4h": 2190, "1d": 365}      # 365 days x 24h
_TV_ANNUALIZATION_FX = {"15m": 24960, "1h": 6240, "4h": 1560, "1d": 260}          # 24h x 260 weekdays
_TV_ANNUALIZATION_STOCK = {"15m": 6552, "1h": 1638, "4h": 504, "1d": 252}         # 252 days x 6.5h session

# Venues that trade 24/7. The screener map's crypto entries are the base ("all" is a
# placeholder, not a venue); the rest are TradingView crypto prefixes the screener
# tools do not cover.
_CRYPTO_PREFIXES = frozenset(
    {name for name, screener in EXCHANGE_SCREENER.items() if screener == "crypto" and name != "all"}
    | {"kraken", "bitstamp", "binanceus", "bitmex", "deribit", "phemex", "bithumb",
       "upbit", "gemini", "poloniex", "bingx", "cryptocom", "coinex"}
)
# Forex and CFD venues trade around the clock on weekdays (the TA-only venues in the
# validators), plus common retail-broker feeds.
_FX_CFD_PREFIXES = frozenset(
    set(_TA_ONLY_SCREENERS)
    | {"forexcom", "pepperstone", "icmarkets", "eightcap", "saxo", "skilling", "blackbull"}
)


def tv_periods_per_year(tv_symbol: str, interval: str) -> int:
    """Bars per year for Sharpe annualization, by the market the TradingView prefix trades.

    * known crypto venue: 24/7, 365 days
    * forex / CFD venue (OANDA, FX_IDC, TVC, CAPITALCOM ...): 24h x 260 weekdays
    * anything else, including an unknown prefix: stock sessions (252 days x 6.5h)

    ``get_market_type`` is not used: it defaults unknown prefixes to crypto, which
    would give forex, CFDs and every unlisted exchange the 24/7 factor.
    """
    prefix = tv_symbol.split(":", 1)[0].strip().lower()
    if prefix in _CRYPTO_PREFIXES:
        return _TV_ANNUALIZATION_CRYPTO[interval]
    if prefix in _FX_CFD_PREFIXES:
        return _TV_ANNUALIZATION_FX[interval]
    return _TV_ANNUALIZATION_STOCK[interval]

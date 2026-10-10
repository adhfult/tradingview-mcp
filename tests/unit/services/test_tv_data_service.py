"""tv_* service functions, against a stub bridge client. Hermetic: no Node, no network."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from tradingview_mcp.core.services import freshness, tv_bridge_client, tv_data_service as tv
from tradingview_mcp.core.services.tv_bridge_client import BridgeClient, BridgeError, SETUP_HINT

FAKE_BRIDGE = Path(__file__).resolve().parents[1] / "fixtures" / "fake_bridge.py"

# 2026-01-01T00:00:00Z, then hourly.
T0 = 1767225600


def _bars(n: int = 3, step: int = 3600) -> list[dict]:
    return [
        {"time": T0 + i * step, "open": 100.0 + i, "high": 101.0 + i,
         "low": 99.0 + i, "close": 100.5 + i, "volume": 10.0 * (i + 1)}
        for i in range(n)
    ]


def _code(result: dict) -> str:
    assert "error" in result, result
    return result["error"]["code"]


# ── tv_candles ──────────────────────────────────────────────────────────────

def test_candles_happy_path_shape_and_params(tv_stub):
    tv_stub.replies["candles"] = _bars(3)
    out = tv.get_candles("btcusdt", "binance", "1h", 3)

    method, params, _ = tv_stub.calls[0]
    assert method == "candles"
    assert params == {"symbol": "BINANCE:BTCUSDT", "timeframe": "60", "count": 3}

    assert out["symbol"] == "BINANCE:BTCUSDT"
    assert out["timeframe"] == "1h"
    assert out["bars"] == 3
    assert out["columns"] == ["time", "open", "high", "low", "close", "volume"]
    assert out["rows"][0] == ["2026-01-01T00:00:00Z", 100.0, 101.0, 99.0, 100.5, 10.0]
    assert out["first"] == "2026-01-01T00:00:00Z"
    assert out["last"] == "2026-01-01T02:00:00Z"
    assert out["last_close"] == 102.5
    # first open 100.0 -> last close 102.5
    assert out["change_pct_over_range"] == 2.5


def test_candles_default_timeframe_is_daily_code(tv_stub):
    tv_stub.replies["candles"] = _bars(1)
    tv.get_candles("BTCUSDT", "BINANCE")
    assert tv_stub.calls[0][1]["timeframe"] == "D"
    assert tv_stub.calls[0][1]["count"] == 300


def test_iso_conversion_uses_utc_from_unix_seconds():
    assert tv._iso_utc(T0) == "2026-01-01T00:00:00Z"
    assert tv._iso_utc(T0 + 86400 + 1800) == "2026-01-02T00:30:00Z"


@pytest.mark.parametrize("count", [0, 1001, True, "5"])
def test_candles_count_out_of_range_is_rejected_before_any_call(tv_stub, count):
    out = tv.get_candles("BTCUSDT", "BINANCE", "1D", count)
    assert _code(out) == "INVALID_PARAMETER"
    assert tv_stub.calls == []


def test_candles_bad_exchange_and_timeframe_give_envelopes(tv_stub):
    assert _code(tv.get_candles("BTCUSDT", "NOTANEXCHANGE")) == "INVALID_EXCHANGE"
    assert _code(tv.get_candles("BTCUSDT", "BINANCE", "2h")) == "INVALID_TIMEFRAME"
    assert tv_stub.calls == []


def test_candles_empty_symbol_is_rejected(tv_stub):
    assert _code(tv.get_candles("   ", "BINANCE")) == "INVALID_PARAMETER"
    assert tv_stub.calls == []


def test_candles_no_bars_is_no_data(tv_stub):
    tv_stub.replies["candles"] = []
    assert _code(tv.get_candles("BTCUSDT", "BINANCE")) == "NO_DATA"


def test_bridge_error_becomes_envelope(tv_stub):
    tv_stub.replies["candles"] = BridgeError("RATE_LIMITED", "slow down")
    out = tv.get_candles("BTCUSDT", "BINANCE")
    assert _code(out) == "UPSTREAM_RATE_LIMIT"
    assert out["error"]["retryable"] is True


def test_auth_failed_message_says_how_to_fix_and_restart(tv_stub):
    tv_stub.replies["candles"] = BridgeError("AUTH_FAILED", "rejected")
    out = tv.get_candles("BTCUSDT", "BINANCE")
    assert _code(out) == "AUTH_FAILED"
    message = out["error"]["message"]
    assert "Update TRADINGVIEW_SESSION_ID / TRADINGVIEW_SESSION_SIGN in .env, then restart the MCP server." in message
    assert "crash" not in message


def test_successful_call_records_bridge_freshness_with_auth(tv_stub):
    tv_stub.has_creds = True
    tv_stub.replies["candles"] = _bars(1)
    records, token = freshness.start_collection()
    try:
        tv.get_candles("BTCUSDT", "BINANCE")
    finally:
        freshness.stop_collection(token)
    assert len(records) == 1
    assert records[0]["source"] == "tradingview_bridge"
    assert records[0]["auth"] == "session"


def test_failed_call_records_no_freshness(tv_stub):
    tv_stub.replies["candles"] = BridgeError("TIMEOUT", "late")
    records, token = freshness.start_collection()
    try:
        tv.get_candles("BTCUSDT", "BINANCE")
    finally:
        freshness.stop_collection(token)
    assert records == []


# ── tv_quotes ───────────────────────────────────────────────────────────────

def test_quotes_keeps_only_known_present_keys(tv_stub):
    tv_stub.replies["quotes"] = {
        "NASDAQ:NVDA": {"lp": 180.5, "ch": 1.2, "chp": 0.67, "volume": 1000,
                        "bid": None, "description": "NVIDIA", "junk": "x"},
    }
    out = tv.get_quotes("nasdaq:nvda")
    assert tv_stub.calls[0] == ("quotes", {"symbols": ["NASDAQ:NVDA"]}, tv_stub.calls[0][2])
    assert out["quotes"] == {"NASDAQ:NVDA": {"lp": 180.5, "ch": 1.2, "chp": 0.67,
                                             "volume": 1000, "description": "NVIDIA"}}
    assert out["missing"] == []


def test_quotes_reports_missing_symbols(tv_stub):
    tv_stub.replies["quotes"] = {}
    out = tv.get_quotes("NASDAQ:NVDA, BINANCE:BTCUSDT")
    assert out["quotes"] == {}
    assert out["missing"] == ["NASDAQ:NVDA", "BINANCE:BTCUSDT"]


def test_quotes_dedupes_and_accepts_the_documented_field_names(tv_stub):
    tv_stub.replies["quotes"] = {"NASDAQ:NVDA": {"current_session": "regular", "update_mode": "streaming"}}
    out = tv.get_quotes("NASDAQ:NVDA,NASDAQ:NVDA")
    assert tv_stub.calls[0][1] == {"symbols": ["NASDAQ:NVDA"]}
    assert out["quotes"]["NASDAQ:NVDA"] == {"current_session": "regular", "update_mode": "streaming"}


@pytest.mark.parametrize("bad", ["", " , ", "NVDA", "NASDAQ:NVDA, BAD SYMBOL"])
def test_quotes_rejects_bad_lists_without_a_call(tv_stub, bad):
    assert _code(tv.get_quotes(bad)) == "INVALID_PARAMETER"
    assert tv_stub.calls == []


def test_quotes_rejects_more_than_fifty(tv_stub):
    many = ",".join(f"NASDAQ:S{i}" for i in range(51))
    assert _code(tv.get_quotes(many)) == "INVALID_PARAMETER"
    assert tv_stub.calls == []


# ── tv_indicator ────────────────────────────────────────────────────────────

def test_indicator_passes_result_through(tv_stub):
    tv_stub.replies["indicator"] = {"name": "RSI", "values": [{"time": 1, "RSI": 40.0}], "strategy": None}
    out = tv.get_indicator("BTCUSDT", "BINANCE", "STD;RSI", "1h", {"length": 14}, 50)
    method, params, _ = tv_stub.calls[0]
    assert method == "indicator"
    assert params == {"symbol": "BINANCE:BTCUSDT", "timeframe": "60", "indicator": "STD;RSI",
                      "count": 50, "inputs": {"length": 14}}
    assert out["name"] == "RSI"
    assert out["values"] == [{"time": 1, "RSI": 40.0}]
    assert out["symbol"] == "BINANCE:BTCUSDT"


def test_indicator_omits_inputs_when_none(tv_stub):
    tv_stub.replies["indicator"] = {"name": None, "values": [], "strategy": None}
    tv.get_indicator("BTCUSDT", "BINANCE", "STD;RSI")
    assert "inputs" not in tv_stub.calls[0][1]


@pytest.mark.parametrize("kwargs", [{"count": 0}, {"count": 501}, {"inputs": ["not", "a", "dict"]}, {"indicator": "  "}])
def test_indicator_validation_rejects_without_a_call(tv_stub, kwargs):
    args = {"symbol": "BTCUSDT", "exchange": "BINANCE", "indicator": "STD;RSI"}
    args.update(kwargs)
    assert _code(tv.get_indicator(**args)) == "INVALID_PARAMETER"
    assert tv_stub.calls == []


# ── tv_symbol_search ────────────────────────────────────────────────────────

def test_search_sends_query_and_optional_type(tv_stub):
    tv_stub.replies["search"] = [{"symbol": "NVDA", "exchange": "NASDAQ"}]
    out = tv.search_symbols("nvidia", "stock")
    assert tv_stub.calls[0][1] == {"query": "nvidia", "type": "stock"}
    assert out == {"query": "nvidia", "count": 1, "results": [{"symbol": "NVDA", "exchange": "NASDAQ"}]}


def test_search_without_type_and_blank_query(tv_stub):
    tv_stub.replies["search"] = []
    tv.search_symbols("nvidia")
    assert tv_stub.calls[0][1] == {"query": "nvidia"}
    assert _code(tv.search_symbols("   ")) == "INVALID_PARAMETER"


# ── tv_hotlist ──────────────────────────────────────────────────────────────

def test_hotlist_sends_range_from_limit(tv_stub):
    tv_stub.replies["hotlist"] = {"totalCount": 9, "rows": [{"symbol": "X"}]}
    out = tv.get_hotlist("gainers", "crypto", 25)
    assert tv_stub.calls[0][1] == {"kind": "gainers", "market": "crypto", "range": [0, 25]}
    assert out["kind"] == "gainers" and out["market"] == "crypto"
    assert out["totalCount"] == 9 and out["rows"] == [{"symbol": "X"}]


@pytest.mark.parametrize("kwargs", [{"kind": "tops"}, {"limit": 0}, {"limit": 101}])
def test_hotlist_validation_rejects_without_a_call(tv_stub, kwargs):
    assert _code(tv.get_hotlist(**kwargs)) == "INVALID_PARAMETER"
    assert tv_stub.calls == []


# ── tv_status ───────────────────────────────────────────────────────────────

def test_status_never_contains_secret_values(monkeypatch):
    """Real BridgeClient, fake bridge process: credentials are present, values never shown."""
    monkeypatch.setenv("TRADINGVIEW_SESSION_ID", "SECRET-ID-111")
    monkeypatch.setenv("TRADINGVIEW_SESSION_SIGN", "SECRET-SIGN-222")
    client = BridgeClient(command=[sys.executable, str(FAKE_BRIDGE)])
    monkeypatch.setattr(tv_bridge_client, "get_client", lambda: client)
    try:
        result = tv.tv_status()
    finally:
        client.close()

    text = json.dumps(result)
    assert "SECRET-ID-111" not in text
    assert "SECRET-SIGN-222" not in text
    assert result["configured"] is True
    assert result["reason"] is None
    assert result["has_credentials"] is True
    assert result["bridge_ok"] is True
    assert result["setup"] is None
    assert "Credentials present: yes" in result["note"]
    assert "cookies are valid" in result["note"]


def test_status_when_not_configured_gives_setup_hint(tv_stub, monkeypatch):
    tv_stub.reason = "Node.js was not found; install Node.js 20+ or set TRADINGVIEW_BRIDGE_NODE"
    result = tv.tv_status()
    assert result["configured"] is False
    assert result["reason"] == tv_stub.reason
    assert result["bridge_ok"] is False
    assert result["setup"] == SETUP_HINT
    assert result["has_credentials"] is False
    assert "Credentials present: no" in result["note"]


def test_tv_tools_are_registered_and_read_only():
    from tradingview_mcp.server import mcp

    names = {t.name: t for t in mcp._tool_manager.list_tools()}
    for name in ("tv_status", "tv_candles", "tv_quotes", "tv_indicator", "tv_symbol_search", "tv_hotlist"):
        assert name in names, name
        assert names[name].annotations.readOnlyHint is True
        assert names[name].annotations.destructiveHint is False


# ── Review additions ────────────────────────────────────────────────────────

def _collect(fn, *args, **kwargs):
    records, token = freshness.start_collection()
    try:
        out = fn(*args, **kwargs)
    finally:
        freshness.stop_collection(token)
    return out, records


@pytest.mark.parametrize(
    "code, expected_code, retryable",
    [
        ("SYMBOL_NOT_FOUND", "SYMBOL_NOT_FOUND", None),
        ("TIMEOUT", "UPSTREAM_TIMEOUT", True),
        ("RATE_LIMITED", "UPSTREAM_RATE_LIMIT", True),
        ("AUTH_FAILED", "AUTH_FAILED", None),
        ("PERMISSION_OR_SERIES", "PERMISSION_DENIED", None),
        ("INVALID_PARAMETER", "INVALID_PARAMETER", None),
        ("NO_DATA", "NO_DATA", None),
        ("NOT_CONFIGURED", "NOT_CONFIGURED", None),
        ("UPSTREAM_UNAVAILABLE", "UPSTREAM_ERROR", True),
        ("SOMETHING_NEW", "UPSTREAM_ERROR", True),
    ],
)
@pytest.mark.parametrize(
    "call",
    [
        ("candles", lambda: tv.get_candles("BTCUSDT", "BINANCE")),
        ("quotes", lambda: tv.get_quotes("NASDAQ:NVDA")),
        ("indicator", lambda: tv.get_indicator("BTCUSDT", "BINANCE", "STD;RSI")),
        ("search", lambda: tv.search_symbols("nvda")),
        ("hotlist", lambda: tv.get_hotlist()),
    ],
    ids=lambda c: c[0],
)
def test_every_function_maps_every_bridge_code_to_an_envelope(tv_stub, call, code, expected_code, retryable):
    method, run = call
    tv_stub.replies[method] = BridgeError(code, "boom")
    out, records = _collect(run)
    assert _code(out) == expected_code
    if retryable is not None:
        assert out["error"]["retryable"] is retryable
    assert records == []  # a failed call records no freshness


def test_auth_failed_envelope_has_the_exact_fix_text_for_every_function(tv_stub):
    exact = "Update TRADINGVIEW_SESSION_ID / TRADINGVIEW_SESSION_SIGN in .env, then restart the MCP server."
    for method, run in (
        ("candles", lambda: tv.get_candles("BTCUSDT", "BINANCE")),
        ("quotes", lambda: tv.get_quotes("NASDAQ:NVDA")),
        ("indicator", lambda: tv.get_indicator("BTCUSDT", "BINANCE", "STD;RSI")),
        ("search", lambda: tv.search_symbols("nvda")),
        ("hotlist", lambda: tv.get_hotlist()),
    ):
        tv_stub.replies[method] = BridgeError("AUTH_FAILED", "rejected")
        out = run()
        assert _code(out) == "AUTH_FAILED"
        assert exact in out["error"]["message"]


def test_bridge_error_text_never_carries_cookie_values(tv_stub, monkeypatch):
    monkeypatch.setenv("TRADINGVIEW_SESSION_ID", "SECRET-ID-111")
    monkeypatch.setenv("TRADINGVIEW_SESSION_SIGN", "SECRET-SIGN-222")
    tv_stub.replies["candles"] = BridgeError(
        "UPSTREAM_UNAVAILABLE", "ws failed sessionid=SECRET-ID-111; sessionid_sign=SECRET-SIGN-222")
    text = json.dumps(tv.get_candles("BTCUSDT", "BINANCE"))
    assert "SECRET-ID-111" not in text and "SECRET-SIGN-222" not in text


@pytest.mark.parametrize("symbol", ["BTC USDT", "BTC/USDT", "A" * 41])
def test_candles_and_indicator_reject_symbols_the_bridge_would_refuse(tv_stub, symbol):
    assert _code(tv.get_candles(symbol, "BINANCE")) == "INVALID_PARAMETER"
    assert _code(tv.get_indicator(symbol, "BINANCE", "STD;RSI")) == "INVALID_PARAMETER"
    assert tv_stub.calls == []


def test_candles_accepts_a_prefixed_symbol_and_forex_exchange(tv_stub):
    tv_stub.replies["candles"] = _bars(1)
    tv.get_candles("OANDA:EURUSD", "BINANCE")
    tv.get_candles("EURUSD", "OANDA")
    assert tv_stub.calls[0][1]["symbol"] == "OANDA:EURUSD"
    assert tv_stub.calls[1][1]["symbol"] == "OANDA:EURUSD"


def test_quotes_rejects_over_long_symbols(tv_stub):
    assert _code(tv.get_quotes("NASDAQ:" + "A" * 40)) == "INVALID_PARAMETER"
    assert tv_stub.calls == []


def test_quote_bad_list_type_and_non_string_fields_are_rejected(tv_stub):
    assert _code(tv.get_quotes(["NASDAQ:NVDA"])) == "INVALID_PARAMETER"
    assert _code(tv.search_symbols(None)) == "INVALID_PARAMETER"
    assert _code(tv.get_hotlist(limit="5")) == "INVALID_PARAMETER"
    assert tv_stub.calls == []


@pytest.mark.parametrize("has_creds, expected", [(True, "session"), (False, "anonymous")])
def test_account_backed_calls_record_the_account_auth(tv_stub, has_creds, expected):
    tv_stub.has_creds = has_creds
    tv_stub.replies.update(
        candles=_bars(1),
        quotes={"NASDAQ:NVDA": {"lp": 1.0}},
        indicator={"name": "RSI", "values": [], "strategy": None},
    )
    for run in (
        lambda: tv.get_candles("BTCUSDT", "BINANCE"),
        lambda: tv.get_quotes("NASDAQ:NVDA"),
        lambda: tv.get_indicator("BTCUSDT", "BINANCE", "STD;RSI"),
    ):
        _, records = _collect(run)
        assert [(r["source"], r["auth"]) for r in records] == [("tradingview_bridge", expected)]


def test_search_and_hotlist_are_recorded_anonymous_even_with_credentials(tv_stub):
    """The bridge sends no cookies for search/hotlist, so the freshness label must not claim a session."""
    tv_stub.has_creds = True
    tv_stub.replies["search"] = []
    tv_stub.replies["hotlist"] = {"totalCount": 0, "rows": []}
    for run in (lambda: tv.search_symbols("nvda"), lambda: tv.get_hotlist()):
        _, records = _collect(run)
        assert [(r["source"], r["auth"]) for r in records] == [("tradingview_bridge", "anonymous")]


def test_status_reports_cooldown_and_never_claims_the_bridge_is_ok_while_cooling(tv_stub):
    tv_stub.cooldown_s = 42.26
    out = tv.tv_status()
    assert out["cooling_down"] is True
    assert out["cooldown_remaining_s"] == 42.3
    assert out["bridge_ok"] is False
    assert out["configured"] is True


def test_status_without_cooldown(tv_stub):
    out = tv.tv_status()
    assert out["cooling_down"] is False
    assert out["cooldown_remaining_s"] == 0.0
    assert out["bridge_ok"] is True


def test_status_values_are_only_bools_and_text_even_with_stub_creds(tv_stub, monkeypatch):
    monkeypatch.setenv("TRADINGVIEW_SESSION_ID", "SECRET-ID-111")
    monkeypatch.setenv("TRADINGVIEW_SESSION_SIGN", "SECRET-SIGN-222")
    tv_stub.has_creds = True
    text = json.dumps(tv.tv_status())
    assert "SECRET" not in text


# ── Through the MCP tool layer (offload + freshness wrappers) ──────────────

def _tool(name):
    from tradingview_mcp.server import mcp

    return next(t for t in mcp._tool_manager.list_tools() if t.name == name)


def test_tv_tools_run_through_wrappers_and_attach_bridge_freshness(tv_stub):
    import asyncio

    tv_stub.has_creds = True
    tv_stub.replies["candles"] = _bars(2)
    out = asyncio.run(_tool("tv_candles").fn(symbol="BTCUSDT", exchange="BINANCE", timeframe="1h", count=2))
    fresh = out["data_freshness"]
    assert fresh["sources"] == ["tradingview_bridge"]
    assert fresh["auth"] == "session"
    assert fresh["auth_by_source"] == {"tradingview_bridge": "session"}


def test_tv_tool_error_envelopes_get_no_data_freshness(tv_stub):
    import asyncio

    tv_stub.replies["quotes"] = BridgeError("TIMEOUT", "late")
    out = asyncio.run(_tool("tv_quotes").fn(symbols="NASDAQ:NVDA"))
    assert out["error"]["code"] == "UPSTREAM_TIMEOUT"
    assert "data_freshness" not in out


def test_tv_tool_docstrings_point_to_tv_status_and_annotations_are_open_world():
    for name in ("tv_candles", "tv_quotes", "tv_indicator", "tv_symbol_search", "tv_hotlist"):
        tool = _tool(name)
        assert "Needs the Node bridge; see `tv_status`" in tool.description, name
        assert tool.annotations.openWorldHint is True
        assert tool.annotations.readOnlyHint is True
        assert tool.annotations.destructiveHint is False
    assert _tool("tv_status").annotations.openWorldHint is True
    for name in ("yahoo_price", "stock_prices"):
        assert "tv_quotes" in _tool(name).description


def test_tv_tools_are_offloaded_to_threads():
    import inspect

    for name in ("tv_status", "tv_candles", "tv_quotes", "tv_indicator", "tv_symbol_search", "tv_hotlist"):
        tool = _tool(name)
        assert tool.is_async and inspect.iscoroutinefunction(tool.fn), name

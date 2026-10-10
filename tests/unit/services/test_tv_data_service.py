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

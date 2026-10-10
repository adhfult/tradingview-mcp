"""Backtests on TradingView candles (data_source="tradingview"), plus the Yahoo default.

Hermetic: the bridge is the ``tv_stub`` fixture (conftest.py); Yahoo is patched out.
"""
from __future__ import annotations

import math
import time
from unittest import mock

import pytest

from tradingview_mcp.core.services import backtest_service as bt, freshness
from tradingview_mcp.core.services.tv_bridge_client import BridgeError

T0 = 1767225600  # 2026-01-01T00:00:00Z


def _series(start: int, n: int, step: int) -> list[dict]:
    """Bridge-shaped candles with a price wave, so strategies can trade."""
    out = []
    for i in range(n):
        p = 100 + 8 * math.sin(i / 4) + i * 0.05
        out.append({"time": start + i * step, "open": p, "high": p + 1.0,
                    "low": p - 1.0, "close": p + 0.2, "volume": 1000.0 + i})
    return out


def _from_request(step: int, n: int, *, offset_days: float = 1.0):
    """Reply factory: n bars starting offset_days after the requested ``from``."""
    def reply(params):
        return _series(params["from"] + int(offset_days * 86400), n, step)
    return reply


def _truncated_reply(step: int, n: int):
    """Reply factory: first bar half the requested span after ``from`` (truncated history)."""
    def reply(params):
        span = time.time() - params["from"]
        return _series(params["from"] + int(0.5 * span), n, step)
    return reply


def _yahoo_candles(n: int = 60) -> list[dict]:
    out = []
    for i in range(n):
        p = 100 + 8 * math.sin(i / 4) + i * 0.05
        out.append({"date": f"2025-{1 + i // 28:02d}-{1 + i % 28:02d}", "open": p,
                    "high": p + 1.0, "low": p - 1.0, "close": p + 0.2, "volume": 1000})
    return out


# ── Yahoo default is unchanged ──────────────────────────────────────────────

def test_yahoo_default_and_explicit_yahoo_give_identical_output():
    with mock.patch.object(bt, "_fetch_ohlcv", return_value=_yahoo_candles()):
        default = bt.run_backtest("AAPL", "rsi", period="1y")
        explicit = bt.run_backtest("AAPL", "rsi", period="1y", data_source="yahoo")
    default.pop("timestamp")
    explicit.pop("timestamp")
    assert default == explicit
    assert "error" not in default
    assert default["data_source"] == "Yahoo Finance"
    assert "tv_symbol" not in default and "truncated" not in default
    assert default["sharpe_periods_per_year"] == 252
    assert default["timeframe"] == "Daily (1d)"


def test_yahoo_path_calls_fetch_ohlcv_with_the_original_arguments():
    with mock.patch.object(bt, "_fetch_ohlcv", return_value=_yahoo_candles()) as fetch:
        bt.run_backtest("AAPL", "rsi", period="6mo", interval="1d")
    fetch.assert_called_once_with("AAPL", "6mo", "1d")


def test_yahoo_rejects_extended_periods_and_tv_intervals_with_the_original_messages():
    out = bt.run_backtest("AAPL", "rsi", period="3y")
    assert out == {"error": "Invalid period '3y'. Choose: " + ", ".join(bt._VALID_PERIODS)}
    out = bt.run_backtest("AAPL", "rsi", period="1y", interval="15m")
    assert out == {"error": "Invalid interval '15m'. Choose: 1d or 1h"}


# ── TradingView request shape ───────────────────────────────────────────────

def test_tv_request_params_timeouts_and_from(tv_stub):
    tv_stub.replies["candles"] = _from_request(86400, 60)
    out = bt.run_backtest("BTCUSDT", "rsi", period="1y", interval="1d",
                          data_source="tradingview", tv_symbol="binance:btcusdt")
    assert "error" not in out, out
    method, params, timeout_s = tv_stub.calls[0]
    assert method == "candles"
    assert params["symbol"] == "BINANCE:BTCUSDT"
    assert params["timeframe"] == "D"
    assert params["maxCount"] == 20000
    assert params["timeoutMs"] == 60000
    assert timeout_s == 60
    assert "count" not in params
    assert abs((time.time() - 365 * 86400) - params["from"]) < 5


@pytest.mark.parametrize("interval, code", [("15m", "15"), ("1h", "60"), ("4h", "240"), ("1d", "D")])
def test_tv_interval_codes(tv_stub, interval, code):
    tv_stub.replies["candles"] = _from_request(3600, 150)
    bt.run_backtest("BTCUSDT", "rsi", period="1mo", interval=interval,
                    data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert tv_stub.calls[0][1]["timeframe"] == code


# ── Conversion ──────────────────────────────────────────────────────────────

def test_conversion_drops_none_ohlc_keeps_last_duplicate_and_rounds(tv_stub):
    tv_stub.replies["candles"] = [
        {"time": T0, "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": None},
        {"time": T0 + 600, "open": 9.0, "high": 9.0, "low": 9.0, "close": 9.0, "volume": 5},  # same day
        {"time": T0 + 86400, "open": None, "high": 1, "low": 1, "close": 1, "volume": 1},     # dropped
        {"time": T0 + 2 * 86400, "open": 1.123456, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 7},
    ]
    candles = bt._fetch_ohlcv_tv("BINANCE:BTCUSDT", "1y", "1d")
    assert [c["date"] for c in candles] == ["2026-01-01", "2026-01-03"]
    assert candles[0] == {"date": "2026-01-01", "open": 9.0, "high": 9.0,
                          "low": 9.0, "close": 9.0, "volume": 5}
    assert candles[1]["open"] == 1.1235
    assert candles[1]["volume"] == 7


def test_intraday_dates_use_minutes_utc(tv_stub):
    tv_stub.replies["candles"] = _series(T0, 3, 900)
    candles = bt._fetch_ohlcv_tv("BINANCE:BTCUSDT", "1mo", "15m")
    assert [c["date"] for c in candles] == ["2026-01-01 00:00", "2026-01-01 00:15", "2026-01-01 00:30"]


# ── Annualization ───────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "symbol, interval, step, expected",
    [
        ("BINANCE:BTCUSDT", "1h", 3600, 8760),
        ("NASDAQ:AAPL", "1h", 3600, 1638),
        ("BINANCE:BTCUSDT", "1d", 86400, 365),
        ("NASDAQ:AAPL", "1d", 86400, 252),
        ("BINANCE:BTCUSDT", "15m", 900, 35040),
        ("EGX:COMI", "4h", 14400, 504),
    ],
)
def test_annualization_follows_market_type(tv_stub, symbol, interval, step, expected):
    tv_stub.replies["candles"] = _from_request(step, 400)
    out = bt.run_backtest("X", "rsi", period="1mo", interval=interval,
                          data_source="tradingview", tv_symbol=symbol)
    assert out["sharpe_periods_per_year"] == expected


def test_explicit_periods_per_year_wins(tv_stub):
    tv_stub.replies["candles"] = _from_request(3600, 400)
    out = bt.run_backtest("X", "rsi", period="1mo", interval="1h", periods_per_year=100,
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert out["sharpe_periods_per_year"] == 100


# ── Period / interval / source rules ────────────────────────────────────────

@pytest.mark.parametrize(
    "period, interval, ok",
    [
        ("6mo", "15m", True), ("1y", "15m", False),
        ("2y", "1h", True), ("3y", "1h", False),
        ("5y", "4h", True), ("3y", "1d", True), ("5y", "1d", True),
        ("1mo", "15m", True),
    ],
)
def test_combo_limits_for_tradingview(tv_stub, period, interval, ok):
    tv_stub.replies["candles"] = _from_request(3600, 400)
    out = bt.run_backtest("X", "rsi", period=period, interval=interval,
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    if ok:
        assert "error" not in out or "too long" not in out["error"], out
    else:
        assert "too long" in out["error"]
        assert "Choose: 1mo, 3mo, 6mo" in out["error"] or "Choose: 1mo, 3mo, 6mo, 1y, 2y" in out["error"]
        assert tv_stub.calls == []


def test_combo_error_lists_the_allowed_periods_for_that_interval(tv_stub):
    out = bt.run_backtest("X", "rsi", period="1y", interval="15m",
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert out == {"error": ("Period '1y' is too long for interval '15m' on TradingView "
                             "(the bridge returns at most 20,000 bars). Choose: 1mo, 3mo, 6mo")}


def test_tv_rejects_unknown_interval_and_period_with_tv_lists(tv_stub):
    out = bt.run_backtest("X", "rsi", period="1y", interval="2h",
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert out == {"error": "Invalid interval '2h' for TradingView. Choose: 15m, 1h, 4h, 1d"}
    out = bt.run_backtest("X", "rsi", period="2mo", interval="1d",
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert out["error"].startswith("Invalid period '2mo' for TradingView. Choose: 1mo")


def test_tv_symbol_required_and_shape_checked(tv_stub):
    out = bt.run_backtest("X", "rsi", data_source="tradingview")
    assert "tv_symbol is required" in out["error"]
    out = bt.run_backtest("X", "rsi", data_source="tradingview", tv_symbol="BTCUSDT")
    assert "must look like EXCHANGE:SYMBOL" in out["error"]
    assert tv_stub.calls == []


def test_unknown_data_source_is_rejected():
    out = bt.run_backtest("AAPL", "rsi", data_source="ibkr")
    assert out == {"error": "Invalid data_source 'ibkr'. Choose: yahoo or tradingview"}


# ── Result fields ───────────────────────────────────────────────────────────

def test_session_and_anonymous_labels(tv_stub):
    tv_stub.replies["candles"] = _from_request(3600, 400)
    tv_stub.has_creds = True
    out = bt.run_backtest("X", "rsi", period="1mo", interval="1h",
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert out["data_source"] == "TradingView (session)"
    assert out["tv_symbol"] == "BINANCE:BTCUSDT"
    tv_stub.has_creds = False
    out = bt.run_backtest("X", "rsi", period="1mo", interval="1h",
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert out["data_source"] == "TradingView (anonymous)"


@pytest.mark.parametrize("interval, label", [("15m", "15-minute (15m)"), ("4h", "4-hour (4h)")])
def test_new_timeframe_labels(tv_stub, interval, label):
    tv_stub.replies["candles"] = _from_request(900 if interval == "15m" else 14400, 400)
    out = bt.run_backtest("X", "rsi", period="1mo", interval=interval,
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert out["timeframe"] == label


def test_tv_records_bridge_freshness_with_auth(tv_stub):
    tv_stub.replies["candles"] = _from_request(3600, 400)
    tv_stub.has_creds = True
    records, token = freshness.start_collection()
    try:
        bt.run_backtest("X", "rsi", period="1mo", interval="1h",
                        data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    finally:
        freshness.stop_collection(token)
    assert [r["source"] for r in records] == ["tradingview_bridge"]
    assert records[0]["auth"] == "session"


# ── Truncation ──────────────────────────────────────────────────────────────

def test_late_first_candle_sets_truncated_and_note(tv_stub):
    tv_stub.replies["candles"] = _truncated_reply(86400, 60)
    out = bt.run_backtest("X", "rsi", period="1y", interval="1d",
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert "error" not in out, out
    assert out["truncated"] is True
    assert "history starts" in out["note"] and "1y" in out["note"]


def test_full_history_has_no_truncation_flag(tv_stub):
    tv_stub.replies["candles"] = _from_request(86400, 60, offset_days=1.0)
    out = bt.run_backtest("X", "rsi", period="1y", interval="1d",
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert "truncated" not in out and "note" not in out


# ── Errors ──────────────────────────────────────────────────────────────────

def test_bridge_error_becomes_the_normal_error_dict(tv_stub):
    tv_stub.replies["candles"] = BridgeError("TIMEOUT", "bridge did not answer candles within 60s")
    out = bt.run_backtest("BTCUSDT", "rsi", period="1y", interval="1d",
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert out == {"error": "Failed to fetch data for 'BTCUSDT': bridge did not answer candles within 60s"}


def test_auth_failed_in_backtest_carries_the_restart_hint(tv_stub):
    tv_stub.replies["candles"] = BridgeError("AUTH_FAILED", "rejected")
    out = bt.run_backtest("BTCUSDT", "rsi", period="1y", interval="1d",
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert "Failed to fetch data for 'BTCUSDT'" in out["error"]
    assert "Update TRADINGVIEW_SESSION_ID / TRADINGVIEW_SESSION_SIGN in .env, then restart the MCP server." in out["error"]


def test_compare_and_walk_forward_use_tradingview_too(tv_stub):
    tv_stub.replies["candles"] = _from_request(86400, 300)
    cmp_out = bt.compare_strategies("BTCUSDT", period="1y", interval="1d",
                                    data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert "error" not in cmp_out, cmp_out
    assert len(cmp_out["ranking"]) == 9
    assert cmp_out["data_source"] == "TradingView (anonymous)"
    assert cmp_out["tv_symbol"] == "BINANCE:BTCUSDT"

    wf = bt.walk_forward_backtest("BTCUSDT", "rsi", period="2y", interval="1d", n_splits=3,
                                  data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert "error" not in wf, wf
    assert wf["data_source"] == "TradingView (anonymous)"
    assert wf["tv_symbol"] == "BINANCE:BTCUSDT"


def test_yahoo_compare_output_has_no_source_keys():
    with mock.patch.object(bt, "_fetch_ohlcv", return_value=_yahoo_candles()):
        out = bt.compare_strategies("AAPL", period="1y", interval="1d")
    assert "data_source" not in out and "tv_symbol" not in out

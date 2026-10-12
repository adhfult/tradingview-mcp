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
    assert candles[0] == {"date": "2026-01-01", "time": T0 + 600, "open": 9.0, "high": 9.0,
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
    assert out == {"error": "Failed to fetch data for 'BINANCE:BTCUSDT': bridge did not answer candles within 60s"}


def test_auth_failed_in_backtest_carries_the_restart_hint(tv_stub):
    tv_stub.replies["candles"] = BridgeError("AUTH_FAILED", "rejected")
    out = bt.run_backtest("BTCUSDT", "rsi", period="1y", interval="1d",
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert "Failed to fetch data for 'BINANCE:BTCUSDT'" in out["error"]
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


# ── Review additions ────────────────────────────────────────────────────────

from tradingview_mcp.core.services import tv_data_service as tvs  # noqa: E402


@pytest.mark.parametrize(
    "symbol, expected",
    [
        # 24/7 crypto venues: 365 days x 24h
        ("BINANCE:BTCUSDT", {"15m": 35040, "1h": 8760, "4h": 2190, "1d": 365}),
        ("coinbase:btcusd", {"15m": 35040, "1h": 8760, "4h": 2190, "1d": 365}),
        ("KRAKEN:XBTUSD", {"15m": 35040, "1h": 8760, "4h": 2190, "1d": 365}),
        # forex / CFD: 24h x 260 weekdays, never the crypto factor
        ("OANDA:EURUSD", {"15m": 24960, "1h": 6240, "4h": 1560, "1d": 260}),
        ("FX_IDC:EURUSD", {"15m": 24960, "1h": 6240, "4h": 1560, "1d": 260}),
        ("TVC:GOLD", {"15m": 24960, "1h": 6240, "4h": 1560, "1d": 260}),
        ("CAPITALCOM:US500", {"15m": 24960, "1h": 6240, "4h": 1560, "1d": 260}),
        ("FXCM:EURUSD", {"15m": 24960, "1h": 6240, "4h": 1560, "1d": 260}),
        # stocks and everything unknown: 252 days x 6.5h session
        ("NASDAQ:AAPL", {"15m": 6552, "1h": 1638, "4h": 504, "1d": 252}),
        ("EGX:COMI", {"15m": 6552, "1h": 1638, "4h": 504, "1d": 252}),
        ("LSE:VOD", {"15m": 6552, "1h": 1638, "4h": 504, "1d": 252}),
        ("SOMEUNKNOWNEXCHANGE:XYZ", {"15m": 6552, "1h": 1638, "4h": 504, "1d": 252}),
    ],
)
def test_periods_per_year_by_market(symbol, expected):
    got = {iv: tvs.tv_periods_per_year(symbol, iv) for iv in ("15m", "1h", "4h", "1d")}
    assert got == expected


def test_unknown_prefix_is_not_treated_as_crypto_unlike_get_market_type():
    from tradingview_mcp.core.utils.validators import get_market_type

    assert get_market_type("someunknownexchange") == "crypto"  # the trap this avoids
    assert tvs.tv_periods_per_year("SOMEUNKNOWNEXCHANGE:XYZ", "1d") == 252
    assert tvs.tv_periods_per_year("TVC:DXY", "1d") == 260
    assert get_market_type("tvc") == "crypto"                  # still the screener default; untouched


def test_all_screener_crypto_venues_get_the_crypto_factor():
    from tradingview_mcp.core.utils.validators import EXCHANGE_SCREENER

    venues = [n for n, s in EXCHANGE_SCREENER.items() if s == "crypto" and n != "all"]
    assert {"binance", "kucoin", "coinbase", "bybit", "okx"} <= set(venues)
    for venue in venues:
        assert tvs.tv_periods_per_year(f"{venue.upper()}:BTCUSDT", "1h") == 8760, venue
    for name, screener in EXCHANGE_SCREENER.items():
        if screener != "crypto":
            assert tvs.tv_periods_per_year(f"{name.upper()}:X", "1d") == 252, name


@pytest.mark.parametrize(
    "symbol, interval, step, expected",
    [
        ("OANDA:EURUSD", "1h", 3600, 6240),
        ("TVC:GOLD", "1d", 86400, 260),
        ("FX_IDC:EURUSD", "4h", 14400, 1560),
        ("SOMEUNKNOWNEXCHANGE:XYZ", "1h", 3600, 1638),
    ],
)
def test_backtest_uses_forex_and_stock_factors_not_crypto(tv_stub, symbol, interval, step, expected):
    tv_stub.replies["candles"] = _from_request(step, 400)
    out = bt.run_backtest("X", "rsi", period="1mo", interval=interval,
                          data_source="tradingview", tv_symbol=symbol)
    assert out["sharpe_periods_per_year"] == expected
    # compare_strategies and walk_forward_backtest pass the same factor to _calc_metrics.
    seen = []
    real = bt._calc_metrics

    def spy(*args, **kwargs):
        seen.append(kwargs.get("periods_per_year"))
        return real(*args, **kwargs)

    with mock.patch.object(bt, "_calc_metrics", spy):
        bt.compare_strategies("X", period="1mo", interval=interval,
                              data_source="tradingview", tv_symbol=symbol)
        assert seen and set(seen) == {expected}
        seen.clear()
        bt.walk_forward_backtest("X", "rsi", period="1y", interval=interval, n_splits=2,
                                 data_source="tradingview", tv_symbol=symbol)
        assert seen and set(seen) == {expected}


# ── Combo caps and bridge params for compare / walk-forward ────────────────

@pytest.mark.parametrize("fn", ["compare_strategies", "walk_forward_backtest"])
def test_combo_caps_are_enforced_before_any_call_for_all_three_tools(tv_stub, fn):
    args = ("X", "rsi") if fn == "walk_forward_backtest" else ("X",)
    out = getattr(bt, fn)(*args, period="1y", interval="15m",
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert "too long" in out["error"]
    out = getattr(bt, fn)(*args, period="3y", interval="1h",
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert "Choose: 1mo, 3mo, 6mo, 1y, 2y" in out["error"]
    assert tv_stub.calls == []


@pytest.mark.parametrize("fn", ["compare_strategies", "walk_forward_backtest"])
def test_compare_and_walk_forward_send_long_fetch_params(tv_stub, fn):
    tv_stub.replies["candles"] = _from_request(86400, 300)
    args = ("X", "rsi") if fn == "walk_forward_backtest" else ("X",)
    period = "2y" if fn == "walk_forward_backtest" else "1y"
    out = getattr(bt, fn)(*args, period=period, interval="1d",
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert "error" not in out, out
    _, params, timeout_s = tv_stub.calls[0]
    assert params["maxCount"] == 20000 and params["timeoutMs"] == 60000 and timeout_s == 60
    assert "count" not in params


@pytest.mark.parametrize("fn", ["compare_strategies", "walk_forward_backtest"])
def test_yahoo_still_rejects_tv_only_values_for_compare_and_walk_forward(fn):
    args = ("AAPL", "rsi") if fn == "walk_forward_backtest" else ("AAPL",)
    assert getattr(bt, fn)(*args, period="5y")["error"].startswith("Invalid period '5y'.")
    assert getattr(bt, fn)(*args, period="1y", interval="4h")["error"] == "Invalid interval '4h'. Choose: 1d or 1h"


def test_every_allowed_combo_stays_under_the_bar_cap_for_24_7_markets():
    """Worst case is crypto: bars per day = 24h / interval."""
    bars_per_day = {"15m": 96, "1h": 24, "4h": 6, "1d": 1}
    for interval, periods in bt._TV_PERIODS_BY_INTERVAL.items():
        for period in periods:
            assert bt._TV_PERIOD_DAYS[period] * bars_per_day[interval] <= bt._TV_MAX_BARS, (interval, period)


# ── Truncation boundary ─────────────────────────────────────────────────────

def _first_bar_at_fraction(fraction: float, step: int, n: int):
    def reply(params):
        span = time.time() - params["from"]
        return _series(params["from"] + int(fraction * span), n, step)
    return reply


def test_truncation_threshold_is_ten_percent_of_the_span(tv_stub):
    tv_stub.replies["candles"] = _first_bar_at_fraction(0.09, 86400, 60)
    out = bt.run_backtest("X", "rsi", period="1y", interval="1d",
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert "truncated" not in out
    tv_stub.replies["candles"] = _first_bar_at_fraction(0.11, 86400, 60)
    out = bt.run_backtest("X", "rsi", period="1y", interval="1d",
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert out["truncated"] is True


def test_truncation_flag_and_note_also_on_compare_and_walk_forward(tv_stub):
    tv_stub.replies["candles"] = _first_bar_at_fraction(0.5, 86400, 300)
    cmp_out = bt.compare_strategies("X", period="2y", interval="1d",
                                    data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    wf = bt.walk_forward_backtest("X", "rsi", period="2y", interval="1d",
                                  data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    for out in (cmp_out, wf):
        assert out["truncated"] is True and "history starts" in out["note"], out


# ── Bad bridge replies ──────────────────────────────────────────────────────

def test_non_list_reply_is_the_normal_error_dict(tv_stub):
    tv_stub.replies["candles"] = {"unexpected": True}
    out = bt.run_backtest("X", "rsi", period="1y", interval="1d",
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert out == {"error": "Failed to fetch data for 'BINANCE:BTCUSDT': TradingView returned an unexpected candles reply"}


def test_empty_reply_is_an_error_not_a_crash(tv_stub):
    tv_stub.replies["candles"] = []
    out = bt.run_backtest("X", "rsi", period="1y", interval="1d",
                          data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert "error" in out


def test_tv_candle_values_and_cookies_do_not_leak_into_results(tv_stub, monkeypatch):
    monkeypatch.setenv("TRADINGVIEW_SESSION_ID", "SECRET-ID-111")
    monkeypatch.setenv("TRADINGVIEW_SESSION_SIGN", "SECRET-SIGN-222")
    tv_stub.has_creds = True
    tv_stub.replies["candles"] = _from_request(86400, 300)
    out = bt.compare_strategies("X", period="1y", interval="1d",
                                data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert "SECRET" not in repr(out)


# ── Phase 3 advisor carry-ins ───────────────────────────────────────────────

def test_truncation_ignores_a_gap_under_five_days_on_a_short_period(tv_stub):
    """A 1mo stock request starting after a long weekend is not a short history."""
    def truncated(days_late):
        tv_stub.replies["candles"] = lambda params: _series(params["from"] + int(days_late * 86400), 20, 86400)
        return bt._fetch_tv_candles("NASDAQ:AAPL", "1mo", "1d")[1]["truncated"]
    assert truncated(4) is False     # 4 days is over 10% of 30 days, but under the 5-day floor
    assert truncated(6) is True


def test_truncation_is_flagged_when_the_bar_cap_is_reached(tv_stub):
    tv_stub.replies["candles"] = lambda params: _series(params["from"], bt._TV_MAX_BARS, 60)
    meta = bt._fetch_tv_candles("BINANCE:BTCUSDT", "1mo", "15m")[1]
    assert meta["truncated"] is True


def test_a_successful_tradingview_result_is_labelled_with_the_tv_symbol(tv_stub):
    tv_stub.replies["candles"] = _series(int(time.time()) - 300 * 86400, 300, 86400)
    out = bt.run_backtest("ignored", "rsi", period="1y", interval="1d",
                          data_source="tradingview", tv_symbol="binance:btcusdt")
    assert out["symbol"] == "BINANCE:BTCUSDT" and out["tv_symbol"] == "BINANCE:BTCUSDT"
    out = bt.walk_forward_backtest("ignored", "rsi", period="1y", interval="1d",
                                   data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert out["symbol"] == "BINANCE:BTCUSDT"


def test_yahoo_results_keep_the_yahoo_symbol(monkeypatch):
    monkeypatch.setattr(bt, "_fetch_ohlcv", lambda *a, **k: _yahoo_candles(300))
    assert bt.run_backtest("aapl", "rsi", period="1y")["symbol"] == "AAPL"

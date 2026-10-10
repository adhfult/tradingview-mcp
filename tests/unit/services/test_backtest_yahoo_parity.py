"""The Yahoo default backtest path gives the same numbers it gave before Phase 3.

The expected values below were produced by the pre-Phase-3 ``backtest_service.py``
(commit 82ef2f8) on these deterministic synthetic candles, with the Yahoo fetch
patched out. They are pinned here so any change to defaults, metrics, costs or
annualization shows up as a failure. ``timestamp`` and ``data_freshness`` are
excluded: the first is volatile, the second is added metadata.

Hermetic: no network, no bridge.
"""
from __future__ import annotations

import hashlib
import json
import math
from datetime import date, timedelta
from unittest import mock

import pytest

from tradingview_mcp.core.services import backtest_service as bt

_STRATEGIES = (
    "rsi", "bollinger", "macd", "ema_cross", "supertrend", "donchian",
    "rsi_pullback", "keltner_breakout", "triple_ema",
)


def _candles(n: int, intraday: bool = False) -> list[dict]:
    """Deterministic pseudo-random walk (LCG), so the numbers never depend on the platform."""
    seed, price, out = 12345, 100.0, []
    start = date(2023, 1, 2)
    for i in range(n):
        seed = (seed * 1103515245 + 12345) % (2 ** 31)
        step = (seed / 2 ** 31 - 0.5) * 0.04
        price = max(5.0, price * (1 + step + 0.0004 * math.sin(i / 20)))
        if intraday:
            label = f"{start + timedelta(days=i // 7)} {9 + i % 7:02d}:30"
        else:
            label = str(start + timedelta(days=i))
        out.append({
            "date": label, "open": round(price * 0.998, 4), "high": round(price * 1.01, 4),
            "low": round(price * 0.99, 4), "close": round(price, 4), "volume": 1000 + i,
        })
    return out


# Phase 6a additive keys; every pre-existing key must stay byte-identical.
# Only these keys may be missing from the digest, and only when a result carries them.
PHASE6A_ADDITIVE_KEYS = frozenset({
    "trades_per_year", "gross_return_pct", "net_return_pct", "cost_drag_pct",
    "cost_warnings", "tradability", "cost_profile", "params", "fill",
    "multiple_testing_warning",
})


def _digest(result: dict) -> str:
    """Hash of the whole result minus volatile / added keys."""
    clean = json.loads(json.dumps(result))
    clean.pop("timestamp", None)
    clean.pop("data_freshness", None)
    for key in PHASE6A_ADDITIVE_KEYS:
        clean.pop(key, None)
    return hashlib.sha256(json.dumps(clean, sort_keys=True).encode()).hexdigest()[:16]


def _pre_existing_keys_present(result: dict, pre_existing: set[str]) -> None:
    """A removed or renamed pre-Phase-6a key must fail, even if the digest would not see it."""
    missing = pre_existing - set(result)
    assert not missing, f"pre-existing keys missing from result: {sorted(missing)}"


# ── PINS (from the pre-Phase-3 code) ──────────────────────────────────────────
RUN_BACKTEST_1D = {
    # strategy: (total_return_pct, total_trades, sharpe_ratio, digest of the full result)
    "rsi":              (2.53, 8, -0.14, "da58a7a37868b57e"),
    "bollinger":        (-11.18, 11, -0.93, "26280517683f43e9"),
    "macd":             (-5.73, 21, -0.46, "1f683f7d71f94889"),
    "ema_cross":        (-9.79, 3, -0.77, "a6a1cca04d49ebb9"),
    "supertrend":       (-14.11, 6, -0.81, "db1ea43dddbacfe4"),
    "donchian":         (-20.84, 10, -1.21, "fb46e9d94c08dd22"),
    "rsi_pullback":     (-8.24, 15, -2.46, "c82936c7854bbd43"),
    "keltner_breakout": (-5.61, 4, -0.93, "ddc6e344e80c8e1d"),
    "triple_ema":       (-3.21, 1, -1.15, "9e20322f0debca0e"),
}
RUN_BACKTEST_1H_MACD = (-16.72, 36, -0.95, 1638, "375f4e19cef9ef20")
COMPARE_1D = ("rsi", -19.0, "f588aa96bfcfc05c")
WALK_FORWARD_1D_MACD = (
    "OVERFITTED \u2014 strategy fails out-of-sample, do not trade live", -0.51, 3, "3f3bfd218ffaf4be",
)


@pytest.fixture(scope="module")
def daily():
    return _candles(520)


@pytest.mark.parametrize("strategy", _STRATEGIES)
def test_run_backtest_defaults_match_pre_phase3_numbers(daily, strategy):
    with mock.patch.object(bt, "_fetch_ohlcv", return_value=daily):
        out = bt.run_backtest("AAPL", strategy, "2y", 10000.0, 0.1, 0.05, "1d", True, True)
    ret, trades, sharpe, digest = RUN_BACKTEST_1D[strategy]
    assert (out["total_return_pct"], out["total_trades"], out["sharpe_ratio"]) == (ret, trades, sharpe)
    assert _digest(out) == digest
    assert out["data_source"] == "Yahoo Finance"
    assert out["sharpe_periods_per_year"] == 252
    assert "tv_symbol" not in out and "truncated" not in out


def test_run_backtest_hourly_default_annualization_is_unchanged():
    with mock.patch.object(bt, "_fetch_ohlcv", return_value=_candles(900, intraday=True)):
        out = bt.run_backtest("AAPL", "macd", "1y", 10000.0, 0.1, 0.05, "1h")
    ret, trades, sharpe, ppy, digest = RUN_BACKTEST_1H_MACD
    assert (out["total_return_pct"], out["total_trades"], out["sharpe_ratio"],
            out["sharpe_periods_per_year"]) == (ret, trades, sharpe, ppy)
    assert out["timeframe"] == "Hourly (1h)"
    assert _digest(out) == digest


def test_compare_strategies_defaults_match_pre_phase3_numbers(daily):
    with mock.patch.object(bt, "_fetch_ohlcv", return_value=daily):
        out = bt.compare_strategies("AAPL", "2y")
    winner, bnh, digest = COMPARE_1D
    assert (out["winner"], out["buy_and_hold_return_pct"]) == (winner, bnh)
    assert _digest(out) == digest
    assert "data_source" not in out and "tv_symbol" not in out


def test_walk_forward_defaults_match_pre_phase3_numbers(daily):
    with mock.patch.object(bt, "_fetch_ohlcv", return_value=daily):
        out = bt.walk_forward_backtest("AAPL", "macd", "2y")
    verdict, avg_test, oos_trades, digest = WALK_FORWARD_1D_MACD
    assert (out["verdict"], out["avg_test_return_pct"], out["oos_total_trades"]) == (verdict, avg_test, oos_trades)
    assert _digest(out) == digest
    assert out["data_source"] == "Yahoo Finance"


def test_tool_layer_defaults_reach_the_same_yahoo_numbers(daily):
    """The MCP tool wrappers add data_source/tv_symbol params; their defaults must not change results."""
    from tradingview_mcp import server

    with mock.patch.object(bt, "_fetch_ohlcv", return_value=daily):
        direct = bt.run_backtest("AAPL", "rsi", "2y", 10000.0, 0.1, 0.05, "1d", False, False)
        via_tool = server.backtest_strategy("AAPL", "rsi", "2y")
    assert _digest(via_tool) == _digest(direct)


def test_yahoo_ignores_tv_symbol_and_never_touches_the_bridge(daily, monkeypatch):
    from tradingview_mcp.core.services import tv_bridge_client

    def boom():
        raise AssertionError("Yahoo path must not create a bridge client")

    monkeypatch.setattr(tv_bridge_client, "get_client", boom)
    with mock.patch.object(bt, "_fetch_ohlcv", return_value=daily):
        with_tv_symbol = bt.run_backtest("AAPL", "rsi", "2y", tv_symbol="BINANCE:BTCUSDT")
        without = bt.run_backtest("AAPL", "rsi", "2y")
    assert "error" not in without
    assert _digest(with_tv_symbol) == _digest(without)

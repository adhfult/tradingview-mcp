"""Snapshot of the backtest outputs, taken before the Phase 6a refactor.

Every existing number must stay byte-identical. The fixture
``tests/unit/fixtures/backtest_snapshot.json`` holds the full result dicts (minus the
volatile ``timestamp``) for all 9 strategies through ``run_backtest``, plus
``compare_strategies`` and ``walk_forward_backtest`` (rsi), on deterministic synthetic
candles with the Yahoo fetch patched out.

A change that intentionally adds keys updates the fixture for those keys only, and the
report says which keys were added. A change to any existing value is a bug.

Hermetic: no network, no bridge.
"""
from __future__ import annotations

import copy
import json
import math
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

from tradingview_mcp.core.services import backtest_service as bt

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "backtest_snapshot.json"
_VOLATILE = ("timestamp",)


def snapshot_candles(n: int = 600) -> list[dict]:
    """600 daily bars from a seeded LCG: trend blocks alternate with mean-reverting chop."""
    seed = 20240601

    def draw() -> float:
        nonlocal seed
        seed = (seed * 1103515245 + 12345) % (2 ** 31)
        return seed / 2 ** 31

    drifts = [0.003, 0.0, -0.002, 0.0, 0.0025, 0.0]  # 100-bar blocks: up, chop, down, chop, up, chop
    start = date(2022, 1, 3)
    price = 100.0
    anchor = price
    prev_close = price * 0.999
    out = []
    for i in range(n):
        block = i // 100
        if i % 100 == 0:
            anchor = price
        drift = drifts[block % len(drifts)]
        if drifts[block % len(drifts)] == 0.0:
            # Chop: pull back toward the block's anchor, plus noise.
            step = (draw() - 0.5) * 0.04 - 0.3 * (price - anchor) / anchor
        else:
            step = drift + (draw() - 0.5) * 0.03
        price = max(5.0, price * (1 + step))
        open_ = prev_close
        high = max(open_, price) * (1 + 0.004 * draw())
        low = min(open_, price) * (1 - 0.004 * draw())
        out.append({
            "date": str(start + timedelta(days=i)),
            "open": round(open_, 4),
            "high": round(high, 4),
            "low": round(low, 4),
            "close": round(price, 4),
            "volume": 1000 + int(draw() * 5000),
        })
        prev_close = price
    return out


def _clean(result: dict) -> dict:
    """JSON-normalised copy of a result with the volatile keys removed."""
    clean = json.loads(json.dumps(result))
    for key in _VOLATILE:
        clean.pop(key, None)
    return clean


def build_snapshot() -> dict:
    """Every snapshot output, computed from the current code. Used by the test and to regenerate."""
    candles = snapshot_candles()

    def fake_fetch(symbol, period, interval="1d"):
        return copy.deepcopy(candles)

    with mock.patch.object(bt, "_fetch_ohlcv", side_effect=fake_fetch):
        out = {"run_backtest": {}}
        for strategy in bt._STRATEGY_MAP:
            out["run_backtest"][strategy] = _clean(bt.run_backtest("SNAP", strategy))
        out["compare_strategies"] = _clean(bt.compare_strategies("SNAP"))
        out["walk_forward_backtest_rsi"] = _clean(bt.walk_forward_backtest("SNAP", "rsi"))
    return out


def test_backtest_outputs_match_snapshot():
    expected = json.loads(FIXTURE.read_text())
    actual = build_snapshot()
    assert set(actual) == set(expected)
    assert set(actual["run_backtest"]) == set(bt._STRATEGY_MAP) == set(expected["run_backtest"])
    for strategy in bt._STRATEGY_MAP:
        assert actual["run_backtest"][strategy] == expected["run_backtest"][strategy], strategy
    assert actual["compare_strategies"] == expected["compare_strategies"]
    assert actual["walk_forward_backtest_rsi"] == expected["walk_forward_backtest_rsi"]


def test_snapshot_series_is_deterministic():
    a = snapshot_candles()
    b = snapshot_candles()
    assert a == b
    assert len(a) == 600
    assert all(math.isfinite(c["close"]) and c["high"] >= c["low"] for c in a)

"""Writes bridge/test/fixtures/indicators.json for the watcher's indicator parity test.

The inputs are a deterministic 300-bar OHLCV series from a fixed linear
congruential generator (no numpy, no random module). The outputs come from the
Python functions in src/tradingview_mcp/core/services/indicators_calc.py, so the
Node implementation in bridge/lib/indicators.mjs is checked against them.

Run from the repository root:
    uv run python scripts/gen_indicator_fixtures.py
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tradingview_mcp.core.services import indicators_calc as ic  # noqa: E402

OUT = ROOT / "bridge" / "test" / "fixtures" / "indicators.json"
BARS = 300
SEED = 20261010


class Lcg:
    """Numerical Recipes LCG: fixed constants, so the output never changes."""

    def __init__(self, seed: int) -> None:
        self.state = seed % (2**31)

    def next_unit(self) -> float:
        self.state = (1103515245 * self.state + 12345) % (2**31)
        return self.state / (2**31)


def build_series() -> dict[str, list]:
    rng = Lcg(SEED)
    closes: list[float] = []
    highs: list[float] = []
    lows: list[float] = []
    opens: list[float] = []
    volumes: list[float] = []
    price = 100.0
    for i in range(BARS):
        trend = 12.0 * math.sin(i / 11.0) + 4.0 * math.sin(i / 3.7)
        shock = (rng.next_unit() - 0.5) * 3.0
        close = round(100.0 + trend + shock + price * 0.0005 * i, 4)
        open_ = round(price, 4)
        spread = round(0.2 + rng.next_unit() * 2.5, 4)
        high = round(max(open_, close) + spread * rng.next_unit(), 4)
        low = round(min(open_, close) - spread * rng.next_unit(), 4)
        volume = float(100 + int(rng.next_unit() * 900))
        opens.append(open_)
        closes.append(close)
        highs.append(high)
        lows.append(low)
        volumes.append(volume)
        price = close
    return {
        "open": opens,
        "high": highs,
        "low": lows,
        "close": closes,
        "volume": volumes,
    }


def main() -> None:
    series = build_series()
    closes, highs, lows = series["close"], series["high"], series["low"]
    volumes = series["volume"]

    outputs = {
        "sma": {
            "5": ic.calc_sma(closes, 5),
            "20": ic.calc_sma(closes, 20),
        },
        "ema": {
            "9": ic.calc_ema(closes, 9),
            "21": ic.calc_ema(closes, 21),
        },
        "rsi": {
            "14": ic.calc_rsi(closes, 14),
        },
        "bollinger": {
            "20_2": ic.calc_bollinger(closes, 20, 2.0),
        },
        "atr": {
            "14": ic.calc_atr(highs, lows, closes, 14),
        },
    }

    document = {
        "description": (
            "Indicator parity fixture. Inputs are a deterministic 300-bar series "
            "(scripts/gen_indicator_fixtures.py). Outputs come from "
            "src/tradingview_mcp/core/services/indicators_calc.py. Regenerate with: "
            "uv run python scripts/gen_indicator_fixtures.py"
        ),
        "seed": SEED,
        "bars": BARS,
        "inputs": series,
        "outputs": outputs,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(document, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({BARS} bars)")


if __name__ == "__main__":
    main()

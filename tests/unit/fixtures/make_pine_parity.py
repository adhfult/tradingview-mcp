"""Writes pine_parity.json: fixed OHLCV from a seeded generator plus reference RSI(14), EMA(20) and BB(20, 2)
from this repo's indicators_calc. Run from the repo root: uv run python tests/unit/fixtures/make_pine_parity.py

The Pyne side is checked against these numbers by tests/unit/services/test_pine_parity.py. `tolerance` is the
largest absolute difference we accept (measured, then rounded up); regenerating the file keeps it.
"""
import json
import sys
from pathlib import Path

from tradingview_mcp.core.services.indicators_calc import calc_bollinger, calc_ema, calc_rsi

OUT = Path(__file__).with_name("pine_parity.json")
BARS = 300
TOLERANCE = 1e-8                      # measured worst case on these 300 bars: 5.8e-11


def candles(n: int = BARS) -> list[dict]:
    """A seeded random walk with trend blocks and chop; 4 decimals; hourly bars from 2023-01-02 00:00 UTC."""
    seed, price, out = 424242, 100.0, []

    def draw() -> float:
        nonlocal seed
        seed = (seed * 1103515245 + 12345) % (2 ** 31)
        return seed / 2 ** 31

    for i in range(n):
        drift = (0.0015, 0.0, -0.001, 0.0)[(i // 50) % 4]
        close = price * (1 + drift + (draw() - 0.5) * 0.02)
        high = max(price, close) * (1 + draw() * 0.004)
        low = min(price, close) * (1 - draw() * 0.004)
        out.append({"time": 1_672_617_600 + i * 3600, "open": round(price, 4), "high": round(high, 4),
                    "low": round(low, 4), "close": round(close, 4), "volume": 1000 + int(draw() * 500)})
        price = close
    return out


def reference(bars: list[dict]) -> dict:
    closes = [c["close"] for c in bars]
    bb = calc_bollinger(closes, 20, 2.0)
    return {"rsi14": calc_rsi(closes, 14), "ema20": calc_ema(closes, 20),
            "bb_upper": bb["upper"], "bb_middle": bb["middle"], "bb_lower": bb["lower"]}


if __name__ == "__main__":
    existing = json.loads(OUT.read_text()) if OUT.exists() else {}
    bars = candles()
    OUT.write_text(json.dumps({"tolerance": existing.get("tolerance", TOLERANCE), "candles": bars,
                               "reference": reference(bars)}, separators=(",", ":")) + "\n")
    print(f"wrote {OUT} ({len(bars)} bars)", file=sys.stderr)

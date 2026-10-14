"""Phase 7c: PyneCore's indicators agree with this repo's `indicators_calc` on fixed candles.

The fixture (tests/unit/fixtures/pine_parity.json) holds 300 seeded hourly candles and the repo's own RSI(14),
EMA(20) and BB(20, 2). Measured when it was made: RSI identical, EMA within 4e-14, BB within 6e-11, and Pyne is
`na` exactly where the repo gives None. The tolerance stored in the file is what the test enforces.
The Pyne half is skipped when the `pine` extra is not installed (or on Python 3.10).
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import pytest

from tradingview_mcp.core.services import pine_service as pine
from tradingview_mcp.core.services.indicators_calc import calc_bollinger, calc_ema, calc_rsi

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FIXTURE = json.loads((FIXTURES / "pine_parity.json").read_text())

INDICATOR = '''"""
@pyne
"""
from pynecore.lib import close, plot, script, ta


@script.indicator("parity")
def main():
    middle, upper, lower = ta.bb(close, 20, 2.0)      # Pine returns the middle line first
    plot(ta.rsi(close, 14), "rsi14")
    plot(ta.ema(close, 20), "ema20")
    plot(upper, "bb_upper")
    plot(middle, "bb_middle")
    plot(lower, "bb_lower")
'''


def generator():
    spec = importlib.util.spec_from_file_location("make_pine_parity", FIXTURES / "make_pine_parity.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_fixture_is_what_the_generator_and_the_repo_indicators_give_today():
    module = generator()
    assert module.candles() == FIXTURE["candles"]                     # deterministic generator, no drift
    assert json.loads(json.dumps(module.reference(FIXTURE["candles"]))) == FIXTURE["reference"]
    closes = [c["close"] for c in FIXTURE["candles"]]
    assert calc_rsi(closes, 14) == FIXTURE["reference"]["rsi14"]
    assert calc_ema(closes, 20) == FIXTURE["reference"]["ema20"]
    assert calc_bollinger(closes, 20, 2.0)["upper"] == FIXTURE["reference"]["bb_upper"]


def is_na(value) -> bool:
    return value is None or value != value


def test_pyne_indicators_agree_with_indicators_calc():
    pytest.importorskip("pynecore")
    from pynecore.core.script_runner import ScriptRunner
    from pynecore.types.ohlcv import OHLCV
    import tempfile

    bars = [OHLCV(timestamp=pine.candle_ms(c), open=c["open"], high=c["high"], low=c["low"], close=c["close"],
                  volume=float(c["volume"])) for c in FIXTURE["candles"]]
    before = os.environ.get("PYNE_SAVE_SCRIPT_TOML")
    os.environ["PYNE_SAVE_SCRIPT_TOML"] = "0"
    try:
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "parity_ind.py"
            script.write_text(INDICATOR)
            plots = [dict(item[1]) for item in ScriptRunner(script, bars, pine._syminfo("60")).run_iter()]
    finally:
        if before is None:
            os.environ.pop("PYNE_SAVE_SCRIPT_TOML", None)
        else:
            os.environ["PYNE_SAVE_SCRIPT_TOML"] = before

    tolerance = FIXTURE["tolerance"]
    for key, reference in FIXTURE["reference"].items():
        compared = 0
        for i, expected in enumerate(reference):
            got = plots[i][key]
            if expected is None:
                assert is_na(got), f"{key}[{i}]: the repo has no value (warm-up) but Pyne gives {got}"
            else:
                assert not is_na(got), f"{key}[{i}]: Pyne is na where the repo gives {expected}"
                assert abs(got - expected) <= tolerance, f"{key}[{i}]: pyne {got} vs repo {expected}"
                compared += 1
        assert compared >= 280 - 14, key                                 # the comparison really covered the series

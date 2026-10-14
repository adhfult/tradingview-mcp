"""Phase 7c: running a Pyne script on our candles and turning its trades into this repo's trade dicts.

The conversion tests use fake trade objects and need no PyneCore. The run tests need the `pine` extra and
Python 3.11+ (`importorskip`), so the 3.10 CI job only skips them.
"""
from __future__ import annotations

import shutil
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

from .test_backtest_snapshot import snapshot_candles
from tradingview_mcp.core.services import pine_service as pine

EXAMPLE = Path(__file__).resolve().parents[3] / "docs" / "examples" / "pine" / "ema_cross.py"
TRADE_KEYS = {"entry_idx", "exit_idx", "entry_date", "exit_date", "entry_price", "exit_price"}


def fake(entry_bar, exit_bar, entry=100.0, exit_=110.0, size=1.0):
    return NS(entry_bar_index=entry_bar, exit_bar_index=exit_bar, entry_price=entry, exit_price=exit_, size=size)


# ─── conversion (fake trades, no PyneCore) ────────────────────────────────────

def test_a_closed_trade_uses_the_fill_bar_for_dates_and_the_bar_before_for_the_index():
    candles = snapshot_candles(50)
    [t] = pine.convert_trades([fake(10, 20, 101.5, 108.25)], [], candles)
    # Pyne fills at the next bar's open, so the signal bar is the one before: the convention _apply_fill gives.
    assert t["entry_idx"] == 9 and t["exit_idx"] == 19
    assert t["entry_date"] == candles[10]["date"] and t["exit_date"] == candles[20]["date"]
    assert (t["entry_price"], t["exit_price"]) == (101.5, 108.25)
    assert "forced_exit" not in t


def test_a_position_still_open_at_the_end_is_closed_at_the_last_close_and_flagged():
    candles = snapshot_candles(50)
    still_open = NS(entry_bar_index=30, entry_price=99.0, size=2.0)
    trades = pine.convert_trades([fake(5, 8)], [still_open], candles)
    assert [t["entry_idx"] for t in trades] == [4, 29]
    last = trades[-1]
    assert last["forced_exit"] is True
    assert last["exit_price"] == candles[-1]["close"] and last["exit_date"] == candles[-1]["date"]
    assert last["exit_idx"] == len(candles) - 1


def test_trades_come_out_in_entry_order_with_exactly_the_documented_keys():
    candles = snapshot_candles(50)
    trades = pine.convert_trades([fake(20, 25), fake(5, 8)], [], candles)
    assert [t["entry_idx"] for t in trades] == [4, 19]
    assert all(TRADE_KEYS <= set(t) for t in trades)


def test_a_short_trade_is_refused_not_scored_as_a_long():
    with pytest.raises(pine.PineError, match="short"):
        pine.convert_trades([fake(5, 8, size=-1.0)], [], snapshot_candles(50))
    with pytest.raises(pine.PineError, match="short"):
        pine.convert_trades([], [NS(entry_bar_index=5, entry_price=1.0, size=-1.0)], snapshot_candles(50))


def test_overlapping_trades_are_refused_but_back_to_back_ones_are_fine():
    candles = snapshot_candles(50)
    with pytest.raises(pine.PineError, match="overlap"):
        pine.convert_trades([fake(5, 20), fake(10, 25)], [], candles)
    assert len(pine.convert_trades([fake(5, 20), fake(20, 25)], [], candles)) == 2
    with pytest.raises(pine.PineError, match="overlap"):                       # an open position inside a closed trade
        pine.convert_trades([fake(5, 20)], [NS(entry_bar_index=10, entry_price=1.0, size=1.0)], candles)


def test_a_trade_that_cannot_be_priced_is_refused():
    for bad in (float("nan"), 0.0, -1.0):
        with pytest.raises(pine.PineError, match="price"):
            pine.convert_trades([fake(5, 8, entry=bad)], [], snapshot_candles(50))


# ─── candles in, timestamps ───────────────────────────────────────────────────

def test_timestamps_come_from_time_when_present_else_from_the_utc_date():
    assert pine.candle_ms({"time": 1_700_000_000, "date": "2001-01-01"}) == 1_700_000_000_000
    assert pine.candle_ms({"date": "2022-01-03"}) == 1_641_168_000_000
    assert pine.candle_ms({"date": "2022-01-03 04:00"}) == 1_641_182_400_000


# ─── running real scripts (needs the extra) ───────────────────────────────────

@pytest.fixture
def scripts(tmp_path, monkeypatch):
    pytest.importorskip("pynecore")
    monkeypatch.setenv("TRADINGVIEW_MCP_HOME", str(tmp_path))
    folder = tmp_path / "strategies"
    folder.mkdir()
    shutil.copy(EXAMPLE, folder / "ema_cross.py")
    return folder


def write(folder, name, body):
    (folder / f"{name}.py").write_text('"""\n@pyne\n"""\n' + body)


def test_the_example_script_trades_on_the_snapshot_candles(scripts):
    candles = snapshot_candles(600)
    trades = pine.run_script("ema_cross", candles)
    assert len(trades) >= 3
    assert all(TRADE_KEYS <= set(t) for t in trades)
    for t in trades:
        assert t["entry_idx"] < t["exit_idx"]
        # filled at the next bar's open, to the tick (candles carry 4 decimals)
        assert t["entry_price"] == pytest.approx(candles[t["entry_idx"] + 1]["open"], abs=1e-4)


def test_running_a_script_leaves_the_folder_and_the_environment_alone(scripts, monkeypatch):
    monkeypatch.delenv("PYNE_SAVE_SCRIPT_TOML", raising=False)
    before = sorted(p.name for p in scripts.iterdir())
    pine.run_script("ema_cross", snapshot_candles(300))
    pine.declared_inputs("ema_cross")
    assert sorted(p.name for p in scripts.iterdir()) == before          # no .toml written next to the script
    import os
    assert "PYNE_SAVE_SCRIPT_TOML" not in os.environ


def test_the_same_run_twice_gives_the_same_trades(scripts):
    candles = snapshot_candles(400)
    assert pine.run_script("ema_cross", candles) == pine.run_script("ema_cross", candles)


def test_params_override_the_declared_inputs(scripts):
    candles = snapshot_candles(600)
    assert pine.run_script("ema_cross", candles, {"fast": 3, "slow": 8}) != pine.run_script("ema_cross", candles)


def test_an_unknown_param_is_an_error_naming_the_valid_ones(scripts):
    with pytest.raises(pine.PineError, match="fast"):
        pine.run_script("ema_cross", snapshot_candles(100), {"nope": 3})


def test_declared_inputs_are_the_numeric_ones_with_their_range(scripts):
    write(scripts, "mixed", '''from pynecore.lib import close, input, script, strategy, ta


@script.strategy("mixed")
def main(length=input.int(14, "Len", minval=2, maxval=100), mult=input.float(2.0, "Mult", minval=0.5),
         on=input.bool(True, "On"), label=input.string("x", "Label")):
    pass
''')
    assert pine.declared_inputs("mixed") == {
        "length": {"type": "int", "default": 14, "min": 2, "max": 100},
        "mult": {"type": "float", "default": 2.0, "min": 0.5, "max": None},
    }


def test_a_script_that_holds_to_the_end_is_closed_at_the_last_close(scripts):
    write(scripts, "hold", '''from pynecore.lib import bar_index, script, strategy


@script.strategy("hold", overlay=True)
def main():
    if bar_index == 5:
        strategy.entry("long", strategy.long, qty=1)
''')
    candles = snapshot_candles(100)
    [t] = pine.run_script("hold", candles)
    assert t["forced_exit"] and t["exit_price"] == candles[-1]["close"] and t["entry_idx"] == 5


def test_the_scripts_own_slippage_and_close_orders_do_not_change_the_fills(scripts):
    # The gauntlet charges the cost profile itself; a script's own costs would be charged twice.
    write(scripts, "slippy", '''from pynecore.lib import bar_index, script, strategy


@script.strategy("slippy", overlay=True, slippage=50, commission_value=5, process_orders_on_close=True)
def main():
    if bar_index == 5:
        strategy.entry("long", strategy.long, qty=1)
''')
    candles = snapshot_candles(100)
    [t] = pine.run_script("slippy", candles)
    assert t["entry_idx"] == 5 and t["entry_price"] == pytest.approx(candles[6]["open"], abs=1e-4)


def test_a_short_script_is_refused(scripts):
    write(scripts, "shorty", '''from pynecore.lib import bar_index, script, strategy


@script.strategy("shorty", overlay=True)
def main():
    if bar_index == 5:
        strategy.entry("short", strategy.short, qty=1)
    if bar_index == 9:
        strategy.close("short")
''')
    with pytest.raises(pine.PineError, match="short"):
        pine.run_script("shorty", snapshot_candles(100))


def test_a_script_with_a_syntax_error_is_a_pine_error_with_the_script_name(scripts):
    write(scripts, "broken", "def main(:\n")
    with pytest.raises(pine.PineError, match="broken"):
        pine.run_script("broken", snapshot_candles(100))


def test_a_file_without_the_pyne_marker_or_main_is_a_pine_error(scripts):
    (scripts / "plain.py").write_text("x = 1\n")
    with pytest.raises(pine.PineError, match="plain"):
        pine.run_script("plain", snapshot_candles(100))


def test_run_script_without_the_extra_raises_the_unavailable_error(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADINGVIEW_MCP_HOME", str(tmp_path))
    monkeypatch.setattr(pine, "available", lambda: (False, "nope"))
    with pytest.raises(pine.PineUnavailable):
        pine.run_script("ema_cross", snapshot_candles(100))
    with pytest.raises(pine.PineUnavailable):
        pine.declared_inputs("ema_cross")

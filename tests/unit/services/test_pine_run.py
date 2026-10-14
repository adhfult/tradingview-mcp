"""Phase 7c: running a Pyne script on our candles and turning its trades into this repo's trade dicts.

The conversion tests use fake trade objects and need no PyneCore. The run tests need the `pine` extra and
Python 3.11+ (`importorskip`), so the 3.10 CI job only skips them.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

from .test_backtest_snapshot import snapshot_candles
from tradingview_mcp.core.services import pine_service as pine

EXAMPLE = Path(__file__).resolve().parents[3] / "docs" / "examples" / "pine" / "ema_cross.py"
TRADE_KEYS = {"entry_idx", "exit_idx", "entry_date", "exit_date", "entry_price", "exit_price"}


def at(candles, bar, offset=0.0):
    return candles[bar]["open"] + offset


def fake(candles, entry_bar, exit_bar, entry=None, exit_=None, size=1.0, shift=0):
    """A closed PyneCore trade filled at the open of the bars given (times are the real ones, indexes can be shifted)."""
    return NS(entry_bar_index=entry_bar + shift, exit_bar_index=exit_bar + shift,
              entry_time=pine.candle_ms(candles[entry_bar]), exit_time=pine.candle_ms(candles[exit_bar]),
              entry_price=at(candles, entry_bar) if entry is None else entry,
              exit_price=at(candles, exit_bar) if exit_ is None else exit_, size=size)


def held(candles, entry_bar, price=None, size=1.0, shift=0):
    return NS(entry_bar_index=entry_bar + shift, entry_time=pine.candle_ms(candles[entry_bar]),
              entry_price=at(candles, entry_bar) if price is None else price, size=size)


# ─── conversion (fake trades, no PyneCore) ────────────────────────────────────

def test_a_closed_trade_uses_the_fill_bar_for_dates_and_the_bar_before_for_the_index():
    candles = snapshot_candles(50)
    [t] = pine.convert_trades([fake(candles, 10, 20)], [], candles)
    # Pyne fills at the next bar's open, so the signal bar is the one before: the convention _apply_fill gives.
    assert t["entry_idx"] == 9 and t["exit_idx"] == 19
    assert t["entry_date"] == candles[10]["date"] and t["exit_date"] == candles[20]["date"]
    assert (t["entry_price"], t["exit_price"]) == (candles[10]["open"], candles[20]["open"])
    assert "forced_exit" not in t


def test_trades_are_placed_by_their_time_not_by_pynes_bar_index():
    # PyneCore counts bar_index from the first bar it calculates (calc_bars_count), so the index can be 100 bars off.
    candles = snapshot_candles(150)
    [t] = pine.convert_trades([fake(candles, 110, 120, shift=-100)], [], candles)
    assert t["entry_idx"] == 109 and t["entry_date"] == candles[110]["date"] and t["exit_date"] == candles[120]["date"]


def test_a_trade_whose_time_is_not_a_candle_is_refused():
    candles = snapshot_candles(50)
    lost = fake(candles, 10, 20)
    lost.entry_time += 1_000
    with pytest.raises(pine.PineError, match="time"):
        pine.convert_trades([lost], [], candles)


def test_a_position_still_open_at_the_end_is_closed_at_the_last_close_and_flagged():
    candles = snapshot_candles(50)
    trades = pine.convert_trades([fake(candles, 5, 8)], [held(candles, 30, size=2.0)], candles)
    assert [t["entry_idx"] for t in trades] == [4, 29]
    last = trades[-1]
    assert last["forced_exit"] is True
    assert last["exit_price"] == candles[-1]["close"] and last["exit_date"] == candles[-1]["date"]
    assert last["exit_idx"] == len(candles) - 1


def test_trades_come_out_in_entry_order_with_exactly_the_documented_keys():
    candles = snapshot_candles(50)
    trades = pine.convert_trades([fake(candles, 20, 25), fake(candles, 5, 8)], [], candles)
    assert [t["entry_idx"] for t in trades] == [4, 19]
    assert all(TRADE_KEYS <= set(t) for t in trades)


def test_a_short_trade_is_refused_not_scored_as_a_long():
    candles = snapshot_candles(50)
    with pytest.raises(pine.PineError, match="short"):
        pine.convert_trades([fake(candles, 5, 8, size=-1.0)], [], candles)
    with pytest.raises(pine.PineError, match="short"):
        pine.convert_trades([], [held(candles, 5, size=-1.0)], candles)


def test_overlapping_trades_are_refused_but_back_to_back_ones_are_fine():
    candles = snapshot_candles(50)
    with pytest.raises(pine.PineError, match="overlap"):
        pine.convert_trades([fake(candles, 5, 20), fake(candles, 10, 25)], [], candles)
    assert len(pine.convert_trades([fake(candles, 5, 20), fake(candles, 20, 25)], [], candles)) == 2
    with pytest.raises(pine.PineError, match="overlap"):                       # an open position inside a closed trade
        pine.convert_trades([fake(candles, 5, 20)], [held(candles, 10)], candles)


def test_a_partial_exit_is_refused_even_when_it_happens_on_the_fill_bar():
    # One entry closed in two pieces shares its entry bar; scoring each piece as a full position would double the return.
    candles = snapshot_candles(50)
    with pytest.raises(pine.PineError, match="partial"):
        pine.convert_trades([fake(candles, 6, 6), fake(candles, 6, 20)], [], candles)
    with pytest.raises(pine.PineError, match="partial"):
        pine.convert_trades([fake(candles, 6, 12)], [held(candles, 6)], candles)


@pytest.mark.parametrize("which", ["entry", "exit"])
def test_a_fill_away_from_the_bars_open_is_refused(which):
    # Limit and stop orders (and immediately=True) fill elsewhere; the gauntlet's model is the next bar's open.
    candles = snapshot_candles(50)
    kwargs = {"entry": at(candles, 10, 0.5)} if which == "entry" else {"exit_": at(candles, 20, -0.5)}
    with pytest.raises(pine.PineError, match="open"):
        pine.convert_trades([fake(candles, 10, 20, **kwargs)], [], candles)
    with pytest.raises(pine.PineError, match="open"):
        pine.convert_trades([], [held(candles, 10, price=at(candles, 10, 0.5))], candles)


def test_a_trade_that_cannot_be_priced_is_refused():
    candles = snapshot_candles(50)
    for bad in (float("nan"), 0.0, -1.0):
        with pytest.raises(pine.PineError, match="price"):
            pine.convert_trades([fake(candles, 5, 8, entry=bad)], [], candles)


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
    # PyneCore only writes its .toml when pytest is not loaded, which is exactly how the server runs it.
    monkeypatch.delitem(sys.modules, "pytest")
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


# ─── small pieces ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("seconds, expected", [(60, "1"), (900, "15"), (3600, "60"), (14400, "240"), (86400, "1D"),
                                               (7 * 86400, "1W")])
def test_the_timeframe_comes_from_the_bar_spacing(seconds, expected):
    assert pine._period([i * seconds * 1000 for i in range(10)]) == expected


def test_one_bar_defaults_to_daily():
    assert pine._period([1_000]) == "1D"


def test_an_int_input_must_get_a_whole_number_whatever_it_is_called():
    declared = {"lookback": {"type": "int", "default": 10, "min": None, "max": None},
                "ratio": {"type": "float", "default": 1.0, "min": None, "max": None}}
    with pytest.raises(ValueError, match="whole number"):
        pine.check_param(declared, "lookback", 5.5)
    pine.check_param(declared, "lookback", 5)
    pine.check_param(declared, "ratio", 0.25)


def test_declared_inputs_follow_an_edit_of_the_script(scripts):
    assert pine.declared_inputs("ema_cross")["fast"]["default"] == 9
    (scripts / "ema_cross.py").write_text((scripts / "ema_cross.py").read_text().replace("input.int(9,", "input.int(7,"))
    assert pine.declared_inputs("ema_cross")["fast"]["default"] == 7


# ─── review findings (real PyneCore) ──────────────────────────────────────────

def test_calc_bars_count_cannot_shift_the_dates(scripts):
    # PyneCore's bar_index restarts at the first calculated bar; a script asking for 200 bars used to land 100 bars early.
    body = (EXAMPLE.read_text().split('"""', 2)[2]).replace('@script.strategy("EMA cross", overlay=True)',
                                                           '@script.strategy("EMA cross", overlay=True, calc_bars_count=200)')
    write(scripts, "limited", body)
    candles = snapshot_candles(300)
    assert pine.run_script("limited", candles) == pine.run_script("ema_cross", candles)


def test_a_stop_a_limit_and_an_immediate_close_are_refused_not_scored(scripts):
    base = '''from pynecore.lib import bar_index, close, script, strategy


@script.strategy("t", overlay=True)
def main():
    if bar_index == 5:
        strategy.entry("long", strategy.long, qty=1%s)
    if bar_index == 12:
        strategy.%s
'''
    write(scripts, "stoploss", base % ("", 'exit("x", "long", stop=close * 0.5, limit=close * 1.0001)'))
    write(scripts, "limitbuy", base % (", limit=close * 0.995", 'close("long")'))
    write(scripts, "immediate", base % ("", 'close("long", immediately=True)'))
    candles = snapshot_candles(100)
    for name in ("limitbuy", "immediate"):
        with pytest.raises(pine.PineError, match="open"):
            pine.run_script(name, candles)
    with pytest.raises(pine.PineError, match="open"):
        pine.run_script("stoploss", candles)


def test_an_indicator_is_a_pine_error_not_an_attribute_error(scripts):
    write(scripts, "ind", "from pynecore.lib import close, plot, script\n\n\n@script.indicator(\"i\")\ndef main():\n    plot(close)\n")
    with pytest.raises(pine.PineError, match="indicator"):
        pine.run_script("ind", snapshot_candles(50))


def test_a_script_that_exits_the_interpreter_is_a_pine_error(scripts):
    write(scripts, "quitter", '''import sys
from pynecore.lib import bar_index, script, strategy


@script.strategy("q")
def main():
    if bar_index == 3:
        sys.exit(0)
''')
    with pytest.raises(pine.PineError, match="quitter"):
        pine.run_script("quitter", snapshot_candles(50))


def test_a_sibling_toml_is_part_of_the_scripts_hash(scripts):
    first = pine.script_sha256("ema_cross")
    (scripts / "ema_cross.toml").write_text("[script]\ncalc_bars_count = 100\n")
    second = pine.script_sha256("ema_cross")
    (scripts / "ema_cross.toml").write_text("[script]\ncalc_bars_count = 50\n")
    assert len({first, second, pine.script_sha256("ema_cross")}) == 3


def test_the_engine_version_is_reported():
    pytest.importorskip("pynecore")
    assert pine.engine_version() == "6.10.9"


def test_warmup_is_the_largest_whole_number_input():
    assert pine.warmup_bars({"fast": 9, "slow": 200, "band": 1.5}) == 200
    assert pine.warmup_bars({"band": 1.5}) == 0
    assert pine.warmup_bars({"flag": True, "n": 7}) == 7                     # a bool is not a length


def test_declared_inputs_of_two_scripts_can_be_asked_for_from_many_threads(scripts):
    import threading
    write(scripts, "other", EXAMPLE.read_text().split('"""', 2)[2].replace("input.int(9,", "input.int(5,"))
    errors = []

    def ask(name):
        try:
            for _ in range(15):
                pine.declared_inputs(name)
                (scripts / f"{name}.py").touch()                     # a new mtime invalidates the cache entry each time
        except Exception as exc:                                    # pragma: no cover (only on failure)
            errors.append(exc)
    threads = [threading.Thread(target=ask, args=(n,)) for n in ("ema_cross", "other", "ema_cross", "other")]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert errors == []

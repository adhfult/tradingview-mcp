"""Phase 7c: Pyne scripts through the backtest seam and the gauntlet.

Most tests replace the runner with a small fake that follows the same rules as a real script (so they need no
PyneCore); the last section runs the real example script and is skipped without the `pine` extra.
"""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from .test_gauntlet import COUNTERPARTY, HYPOTHESIS, wavy
from tradingview_mcp.core.services import backtest_service as bt
from tradingview_mcp.core.services import gauntlet_service as g
from tradingview_mcp.core.services import paper_service
from tradingview_mcp.core.services import pine_service as pine

EXAMPLE = Path(__file__).resolve().parents[3] / "docs" / "examples" / "pine" / "ema_cross.py"
INPUTS = {"fast": {"type": "int", "default": 10, "min": 2, "max": 50},
          "slow": {"type": "int", "default": 30, "min": 3, "max": 200},
          "band": {"type": "float", "default": 1.5, "min": 0.5, "max": None}}


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADINGVIEW_MCP_HOME", str(tmp_path))
    return tmp_path


@pytest.fixture
def folder(home):
    path = home / "strategies"
    path.mkdir()
    return path


def trade(candles, signal, exit_signal):
    """What convert_trades gives for a trade signalled at `signal` and closed on a signal at `exit_signal`."""
    return {"entry_idx": signal, "exit_idx": exit_signal,
            "entry_date": candles[signal + 1]["date"], "exit_date": candles[exit_signal + 1]["date"],
            "entry_price": candles[signal + 1]["open"], "exit_price": candles[exit_signal + 1]["open"]}


def honest_run(name, candles, params=None):
    """Buys 5 bars before every 20th bar and holds `fast` bars; uses only bars up to the fill, like a real script."""
    hold = int((params or {}).get("fast", 10))
    out, n = [], len(candles)
    for i in range(15, n, 20):
        if i + hold + 1 <= n - 1:                    # the exit fill bar must exist
            out.append(trade(candles, i, i + hold))
        elif i + 1 <= n - 1:                         # filled, not yet closed: held to the last bar
            out.append({**trade(candles, i, n - 2), "exit_idx": n - 1, "exit_date": candles[-1]["date"],
                        "exit_price": candles[-1]["close"], "forced_exit": True})
    return out


def leaky_run(name, candles, params=None):
    """Decides at bar i using the close of bar i+8, but exits at bar i+3: a script that peeks."""
    out, n = [], len(candles)
    for i in range(0, n - 10, 10):
        if i + 8 < n and candles[i + 8]["close"] > candles[i]["close"]:
            out.append(trade(candles, i, i + 3))
    return out


def entry_leaky_run(name, candles, params=None):
    """Decides to buy at bar i using the close of bar i+8, then holds 10 bars: the peek is inside the holding window."""
    out, n = [], len(candles)
    for i in range(0, n - 1, 12):
        if i + 8 < n and candles[i + 8]["close"] > candles[i]["close"]:
            if i + 11 <= n - 1:
                out.append(trade(candles, i, i + 10))
            else:
                out.append({**trade(candles, i, n - 2), "exit_idx": n - 1, "forced_exit": True,
                            "exit_date": candles[-1]["date"], "exit_price": candles[-1]["close"]})
    return out


def tail_leaky_run(name, candles, params=None):
    """Honest except the last trades, which also need a bar after their exit fill."""
    out = []
    for t in honest_run(name, candles, params):
        if not t.get("forced_exit") and t["entry_idx"] >= 560 and t["exit_idx"] + 3 >= len(candles) - 1:
            continue                                  # in a prefix cut at the exit this trade is missing
        out.append(t)
    return out


def late_leaky_run(name, candles, params=None):
    """Honest for the first 300 bars, then peeks: a check that only looks at the first trades misses it."""
    out, n = [], len(candles)
    for i in range(15, n, 20):
        if i < 300:
            if i + 11 <= n - 1:
                out.append(trade(candles, i, i + 10))
        elif i + 8 < n and candles[i + 8]["close"] > candles[i]["close"]:
            out.append(trade(candles, i, i + 3))
    return out


@pytest.fixture
def fake(monkeypatch, folder):
    """A script called `x` whose runner is `honest_run` and whose inputs are INPUTS."""
    (folder / "x.py").write_text("# a script\n")
    monkeypatch.setattr(pine, "available", lambda: (True, ""))
    monkeypatch.setattr(pine, "declared_inputs", lambda name: INPUTS)
    runner = {"run": honest_run}
    monkeypatch.setattr(pine, "run_script", lambda name, candles, params=None: runner["run"](name, candles, params))
    candles = wavy()
    monkeypatch.setattr(bt, "_load_candles", lambda *a, **k: (candles, {}))
    return runner


def run(strategy="pine:x", **kw):
    return g.run_gauntlet("TEST", strategy, HYPOTHESIS, COUNTERPARTY, **kw)


def status(result):
    return {x["gate"]: x["status"] for x in result["gates"]}


# ─── the seam: parameters ─────────────────────────────────────────────────────

def test_a_pine_strategys_parameters_are_its_numeric_inputs(fake):
    assert bt.strategy_param_defaults("pine:x") == {"fast": 10, "slow": 30, "band": 1.5}
    assert bt.resolve_params("pine:x", None) == {"fast": 10, "slow": 30, "band": 1.5}
    assert bt.resolve_params("pine:x", {"fast": 12})["fast"] == 12


@pytest.mark.parametrize("params, message", [
    ({"nope": 3}, "Unknown parameter"),
    ({"fast": 100}, "at most 50"),                  # above the declared maxval
    ({"band": 0.1}, "at least 0.5"),                # below the declared minval
    ({"fast": 5.5}, "whole number"),                # an int input
    ({"fast": 40, "slow": 30}, "must be less than"),  # the fast < slow rule applies by name
])
def test_pine_params_are_checked_against_the_declared_inputs(fake, params, message):
    with pytest.raises(ValueError, match=message):
        bt.resolve_params("pine:x", params)


# ─── the seam: trades, fills, costs ───────────────────────────────────────────

def test_pine_trades_are_not_filled_a_second_time(fake):
    candles = wavy()
    resolved = bt.resolve_params("pine:x", None)
    assert bt._trades_for(candles, "pine:x", resolved, "next_open") == honest_run("x", candles, resolved)


def test_a_pine_script_only_fills_at_the_next_open(fake):
    with pytest.raises(ValueError, match="next_open"):
        bt._trades_for(wavy(), "pine:x", bt.resolve_params("pine:x", None), "signal_close")


def test_costs_are_charged_once(fake):
    candles = wavy()
    fake["run"] = lambda name, c, p=None: [{**trade(c, 20, 30), "entry_price": 100.0, "exit_price": 110.0}]
    sim = bt._simulate(candles, "pine:x", commission_pct=0.1, slippage_pct=0.05, fill="next_open")
    assert sim["trades"][0]["gross_return_pct"] == 10.0
    assert sim["trades"][0]["return_pct"] == pytest.approx(10.0 - 0.3)       # (0.1 + 0.05) * 2, once


# ─── the gauntlet: accepting a pine strategy ──────────────────────────────────

def test_without_the_extra_the_answer_is_the_documented_envelope(monkeypatch):
    monkeypatch.setattr(pine, "available", lambda: (False, "no"))
    result = run()
    assert result == pine.dependency_missing()
    assert result["error"]["message"] == "Pine support needs Python 3.11+ and: pip install 'tradingview-mcp-server[pine]'"


def test_the_missing_extra_is_reported_before_any_data_is_fetched(monkeypatch):
    fetched = []
    monkeypatch.setattr(pine, "available", lambda: (False, "no"))
    monkeypatch.setattr(bt, "_load_candles", lambda *a, **k: fetched.append(1) or ([], {}))
    assert run() == pine.dependency_missing()
    assert fetched == []                                   # the service turns exceptions into errors, so count calls instead


@pytest.mark.parametrize("name", ["pine:../x", "pine:", "pine:a/b", "pine:" + "a" * 65])
def test_bad_script_names_are_refused_without_touching_data(monkeypatch, name):
    fetched = []
    monkeypatch.setattr(pine, "available", lambda: (True, ""))
    monkeypatch.setattr(bt, "_load_candles", lambda *a, **k: fetched.append(1) or ([], {}))
    assert "name" in run(name)["error"].lower()
    assert fetched == []


def test_an_unknown_script_names_the_ones_that_exist(fake):
    assert "x" in run("pine:nope")["error"]


def test_a_broken_script_is_a_tool_error_not_a_crash(fake):
    def boom(name, candles, params=None):
        raise pine.PineError("Script 'x' failed while running: ZeroDivisionError: division by zero")
    fake["run"] = boom
    assert "ZeroDivisionError" in run()["error"]


# ─── the gauntlet: the gates ──────────────────────────────────────────────────

def test_a_pine_run_has_every_gate_plus_a_lookahead_gate_last(fake):
    result = run()
    assert [x["gate"] for x in result["gates"]] == [
        "honest_settings", "enough_evidence", "parameter_sensitivity", "double_costs", "recent_year", "walk_forward",
        "lookahead"]
    assert status(result)["lookahead"] == "PASS"


def test_built_in_strategies_keep_their_six_gates(monkeypatch):
    candles = wavy()
    monkeypatch.setattr(bt, "_load_candles", lambda *a, **k: (candles, {}))
    assert "lookahead" not in status(run("rsi"))


def test_parameter_sensitivity_runs_on_the_declared_inputs(fake):
    result = run()
    gate = next(x for x in result["gates"] if x["gate"] == "parameter_sensitivity")
    assert gate["status"] != "SKIPPED"
    assert gate["numbers"]["neighbours"] >= 2


def test_a_script_without_numeric_inputs_skips_sensitivity_with_the_reason(fake, monkeypatch):
    monkeypatch.setattr(pine, "declared_inputs", lambda name: {})
    gate = next(x for x in run()["gates"] if x["gate"] == "parameter_sensitivity")
    assert gate["status"] == "SKIPPED" and "neighbour" in gate["reason"].lower()


def test_a_script_that_peeks_ahead_fails_the_lookahead_gate(fake):
    fake["run"] = leaky_run
    result = run()
    gate = next(x for x in result["gates"] if x["gate"] == "lookahead")
    assert gate["status"] == "FAIL"
    assert "repaints or uses future data" in gate["reason"]
    assert gate["numbers"]["violations"] > 0
    assert result["verdict"].startswith("FAIL")


def test_the_lookahead_gate_checks_the_trades_it_names_and_says_how_many(fake):
    gate = next(x for x in run()["gates"] if x["gate"] == "lookahead")
    assert gate["status"] == "PASS" and 0 < gate["numbers"]["trades_checked"] <= g.LOOKAHEAD_SAMPLES
    assert gate["numbers"]["violations"] == 0


def test_a_peek_inside_the_holding_window_fails_the_lookahead_gate(fake):
    fake["run"] = entry_leaky_run
    gate = next(x for x in run()["gates"] if x["gate"] == "lookahead")
    assert gate["status"] == "FAIL" and gate["numbers"]["violations"] > 0


def test_the_last_trades_of_the_run_are_sampled_too(fake):
    fake["run"] = tail_leaky_run
    candles = wavy()
    # the leak only touches trades that end near the end of the series; an evenly spread sample must reach them
    closed = [t for t in honest_run("x", candles) if not t.get("forced_exit")]
    assert len(closed) > g.LOOKAHEAD_SAMPLES
    picked = g._lookahead_sample(closed)
    assert closed[0] in picked and closed[-1] in picked and len(picked) == g.LOOKAHEAD_SAMPLES
    gate = next(x for x in run()["gates"] if x["gate"] == "lookahead")
    assert gate["status"] == "FAIL" and gate["numbers"]["violations"] > 0


def test_a_leak_that_starts_late_in_the_run_is_still_caught(fake):
    fake["run"] = late_leaky_run
    gate = next(x for x in run()["gates"] if x["gate"] == "lookahead")
    assert gate["status"] == "FAIL" and gate["numbers"]["violations"] > 0


def test_the_lookahead_gate_samples_a_fixed_number_spread_over_the_run(fake):
    gate = next(x for x in run()["gates"] if x["gate"] == "lookahead")
    assert gate["numbers"]["trades_checked"] == g.LOOKAHEAD_SAMPLES          # ~29 trades, 8 sampled


def test_a_trade_force_closed_at_the_last_bar_is_not_a_lookahead_sample(fake):
    def run_with_forced(name, candles, params=None):
        n = len(candles)
        out = [trade(candles, 20, 30)] if 31 < n else []
        out += [trade(candles, 50, 60)] if 61 < n else []
        if n == len(wavy()):                                       # only the full series ends with an open position
            out.append({**trade(candles, 100, 110), "exit_idx": n - 1, "forced_exit": True})
        return out
    fake["run"] = run_with_forced
    gate = next(x for x in run()["gates"] if x["gate"] == "lookahead")
    assert gate["numbers"]["trades_checked"] == 2


def test_a_script_with_no_closed_trades_gets_a_skipped_lookahead_gate(fake):
    fake["run"] = lambda name, candles, params=None: []
    gate = next(x for x in run()["gates"] if x["gate"] == "lookahead")
    assert gate["status"] == "SKIPPED"


# ─── the gauntlet: the report ─────────────────────────────────────────────────

def test_the_report_records_the_scripts_hash_and_a_changed_script_invalidates_it(fake, folder):
    first = run()
    assert first["inputs"]["strategy"] == "pine:x"
    assert first["inputs"]["script_sha256"] == pine.script_sha256("x")
    assert g.verify_report(first["fingerprint"])["matches_current_code"] is True
    (folder / "x.py").write_text("# a script, edited\n")
    assert g.verify_report(first["fingerprint"])["matches_current_code"] is False
    assert run()["fingerprint"] != first["fingerprint"]


def test_the_same_script_and_settings_give_the_same_fingerprint(fake):
    assert run()["fingerprint"] == run()["fingerprint"]


def test_the_pine_service_is_part_of_the_code_that_produced_the_verdict():
    assert Path(pine.__file__) in g._code_files()


def test_the_paper_trader_refuses_a_pine_report(monkeypatch):
    plan = {"inputs": {"strategy": "pine:x", "data_source": "tradingview", "tv_symbol": "BINANCE:BTCUSDT",
                       "interval": "1h"}}
    monkeypatch.setattr(g, "verify_report", lambda fp: {"exists": True, "verdict": "PASS", "matches_current_code": True})
    monkeypatch.setattr(g, "load_report", lambda fp: plan)
    with pytest.raises(paper_service.PaperRefusal, match="Pyne"):
        paper_service.load_plan("a" * 64)


# ─── real PyneCore (skipped without the extra) ────────────────────────────────

@pytest.fixture
def real(folder):
    pytest.importorskip("pynecore")
    shutil.copy(EXAMPLE, folder / "ema_cross.py")
    candles = wavy(600)
    import tradingview_mcp.core.services.backtest_service as backtest
    original = backtest._load_candles
    backtest._load_candles = lambda *a, **k: (candles, {})
    yield candles
    backtest._load_candles = original


def test_the_example_script_goes_through_the_whole_gauntlet(real):
    result = run("pine:ema_cross")
    assert "error" not in result, result
    assert result["inputs"]["params"] == {"fast": 9, "slow": 21}
    states = status(result)
    assert states["lookahead"] == "PASS"
    assert states["parameter_sensitivity"] != "SKIPPED"
    assert states["honest_settings"] == "PASS"


def test_the_real_runner_reproduces_the_report_fingerprint(real):
    first = run("pine:ema_cross")
    assert run("pine:ema_cross")["fingerprint"] == first["fingerprint"]
    assert g.verify_report(first["fingerprint"])["matches_current_code"] is True


def test_the_pyne_ema_cross_makes_the_same_trades_as_the_built_in_one(real):
    """The strongest check of the conversion: same signals, same next-open fills, trade for trade."""
    builtin = bt._trades_for(real, "ema_cross", {"fast_period": 9, "slow_period": 21}, "next_open")
    pyne = bt._trades_for(real, "pine:ema_cross", {"fast": 9, "slow": 21}, "next_open")
    assert len(builtin) >= 10

    def key(t):
        return (t["entry_date"], t["exit_date"], round(t["entry_price"], 4), round(t["exit_price"], 4),
                t["entry_idx"], t["exit_idx"], bool(t.get("forced_exit")))
    assert [key(t) for t in pyne] == [key(t) for t in builtin]


# ─── review findings ──────────────────────────────────────────────────────────

def test_the_fingerprint_follows_the_script_files_toml_and_the_engine_version(fake, folder, monkeypatch):
    first = run()["fingerprint"]
    (folder / "x.toml").write_text("[script]\ncalc_bars_count = 100\n")
    with_toml = run()["fingerprint"]
    assert with_toml != first
    monkeypatch.setattr(pine, "engine_version", lambda: "9.9.9")
    assert run()["fingerprint"] != with_toml


def test_an_old_report_stops_verifying_when_the_toml_or_the_engine_changes(fake, folder, monkeypatch):
    report = run()
    assert g.verify_report(report["fingerprint"])["matches_current_code"] is True
    monkeypatch.setattr(pine, "engine_version", lambda: "9.9.9")
    assert g.verify_report(report["fingerprint"])["matches_current_code"] is False


def test_warmup_counts_a_scripts_largest_whole_number_input(fake):
    resolved = {"fast": 9, "slow": 200, "band": 1.5}
    assert bt.strategy_warmup_bars("pine:x", resolved) == 200
    assert g._warmup_bars("pine:x", resolved) >= 200
    assert bt.strategy_warmup_bars("rsi", {"period": 14}) == bt._STRATEGY_WARMUP_BARS["rsi"]


def test_walk_forward_does_not_score_folds_too_short_for_the_scripts_slowest_input(fake, monkeypatch):
    monkeypatch.setattr(pine, "declared_inputs", lambda name: {"length": {"type": "int", "default": 150, "min": 2, "max": 500}})
    fake["run"] = lambda name, candles, params=None: []
    result = bt._walk_forward_on_candles(wavy(900), "pine:x", fill="next_open", params=None)
    assert result.get("scored_folds", 0) == 0                     # all three test slices (90 bars) are shorter than 150

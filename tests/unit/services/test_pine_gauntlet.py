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
    return out


def leaky_run(name, candles, params=None):
    """Decides at bar i using the close of bar i+8, but exits at bar i+3: a script that peeks."""
    out, n = [], len(candles)
    for i in range(0, n - 10, 10):
        if i + 8 < n and candles[i + 8]["close"] > candles[i]["close"]:
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
    monkeypatch.setattr(pine, "available", lambda: (False, "no"))
    monkeypatch.setattr(bt, "_load_candles", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not fetch")))
    assert "error" in run()


@pytest.mark.parametrize("name", ["pine:../x", "pine:", "pine:a/b", "pine:" + "a" * 65])
def test_bad_script_names_are_refused_without_touching_data(monkeypatch, name):
    monkeypatch.setattr(pine, "available", lambda: (True, ""))
    monkeypatch.setattr(bt, "_load_candles", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not fetch")))
    assert "name" in run(name)["error"].lower()


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

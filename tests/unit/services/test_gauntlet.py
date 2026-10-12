"""Phase 6a: the strategy gauntlet (gates, verdicts, fingerprint, reports, stats).

Hermetic: candles are synthetic, the fetch is patched out, and reports go to tmp_path
through TRADINGVIEW_MCP_HOME.
"""
from __future__ import annotations

import json
import math
import stat
from datetime import date, timedelta

import pytest

from tradingview_mcp.core.services import backtest_service as bt
from tradingview_mcp.core.services import gauntlet_service as g

HYPOTHESIS = "Funds forced to sell at month end push prices past fair value"
COUNTERPARTY = "Index funds rebalancing on a fixed calendar, indifferent to price"


def wavy(n=600, drift=0.15, amp=6.0, period=20, start=date(2023, 1, 2)):
    """A steady uptrend with a regular swing: simple strategies make money on it."""
    out, prev = [], 100.0
    for i in range(n):
        close = 100 + drift * i + amp * math.sin(i * 2 * math.pi / period)
        out.append({"date": (start + timedelta(days=i)).isoformat(), "open": round(prev, 4),
                    "high": round(max(prev, close) + 0.5, 4), "low": round(min(prev, close) - 0.5, 4),
                    "close": round(close, 4), "volume": 1_000_000})
        prev = close
    return out


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADINGVIEW_MCP_HOME", str(tmp_path))
    return tmp_path


@pytest.fixture
def series(monkeypatch):
    candles = wavy()
    monkeypatch.setattr(bt, "_load_candles", lambda *a, **k: (candles, {}))
    return candles


def run(strategy="rsi", **kw):
    return g.run_gauntlet("TEST", strategy, kw.pop("hypothesis", HYPOTHESIS),
                          kw.pop("counterparty", COUNTERPARTY), **kw)


def status(result):
    return {x["gate"]: x["status"] for x in result["gates"]}


# ─── the stated edge ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("hypothesis, counterparty", [
    ("too short", COUNTERPARTY),
    (HYPOTHESIS, "short"),
    ("   " + "x" * 5 + "   ", COUNTERPARTY),
    (HYPOTHESIS, HYPOTHESIS),                      # identical
    (HYPOTHESIS, HYPOTHESIS.upper() + "!!"),       # identical once case and punctuation are removed
])
def test_no_stated_edge_fails_without_fetching(monkeypatch, hypothesis, counterparty):
    def boom(*a, **k):
        raise AssertionError("must not fetch")
    monkeypatch.setattr(bt, "_load_candles", boom)
    result = g.run_gauntlet("TEST", "rsi", hypothesis, counterparty)
    assert result["verdict"] == "FAIL: no stated edge"
    assert result["gates"] == [] and result["reason"]


def test_generic_phrases_are_rejected_even_with_punctuation(monkeypatch):
    monkeypatch.setattr(g, "MIN_TEXT_CHARS", 1)   # isolate the phrase list from the length rule
    for phrase in ("Momentum!", "  Trend-Following. ", "BUY LOW, SELL HIGH", "smart money"):
        assert g._edge_problem(phrase, COUNTERPARTY), phrase
        assert g._edge_problem(HYPOTHESIS, phrase), phrase


def test_a_real_edge_is_accepted():
    assert g._edge_problem(HYPOTHESIS, COUNTERPARTY) is None


# ─── input errors come back as errors, not verdicts ───────────────────────────

@pytest.mark.parametrize("kw", [
    {"strategy": "nope"}, {"cost_profile": "free_lunch"}, {"period": "9y"}, {"interval": "7m"},
    {"params": {"bogus": 1}}, {"data_source": "tradingview"},   # tradingview needs tv_symbol
])
def test_bad_inputs_are_errors(kw, series):
    kw.setdefault("strategy", "rsi")
    result = run(**kw)
    assert "error" in result and "verdict" not in result


def test_a_failed_fetch_is_an_error(monkeypatch):
    def fail(*a, **k):
        raise RuntimeError("network down")
    monkeypatch.setattr(bt, "_load_candles", fail)
    assert "network down" in run()["error"]


def test_tradingview_runs_are_labelled_with_the_tv_symbol(monkeypatch, home):
    def fail(*a, **k):
        raise RuntimeError("bridge down")
    monkeypatch.setattr(bt, "_load_candles", fail)
    out = run("rsi", data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert "'BINANCE:BTCUSDT'" in out["error"]
    monkeypatch.setattr(bt, "_load_candles", lambda *a, **k: (wavy(), {}))
    monkeypatch.setattr(g, "tv_periods_per_year", lambda *a: 365)
    run("rsi", data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert json.loads((home / "gauntlet" / "log.jsonl").read_text().splitlines()[-1])["symbol"] == "BINANCE:BTCUSDT"


# ─── gates on the real engine ─────────────────────────────────────────────────

def test_a_decent_idea_passes_five_gates_and_walk_forward_decides(series):
    result = run("rsi")
    assert status(result) == {"honest_settings": "PASS", "enough_evidence": "PASS",
                              "parameter_sensitivity": "PASS", "double_costs": "PASS",
                              "recent_year": "PASS", "walk_forward": "FAIL"}
    assert result["verdict"] == "FAIL: walk_forward"


@pytest.mark.parametrize("label, expected", [("ROBUST — x", "PASS"), ("MODERATE — x", "PASS")])
def test_walk_forward_robust_or_moderate_passes_the_idea(series, monkeypatch, label, expected):
    monkeypatch.setattr(bt, "_walk_forward_on_candles", lambda *a, **k: {
        "verdict": label, "avg_robust": 0.9, "scored_folds": 3, "avg_train": 5.0, "avg_test": 4.0})
    assert run("rsi")["verdict"] == expected


@pytest.mark.parametrize("label", ["WEAK — x", "OVERFITTED — x"])
def test_walk_forward_weak_or_overfitted_fails(series, monkeypatch, label):
    monkeypatch.setattr(bt, "_walk_forward_on_candles", lambda *a, **k: {
        "verdict": label, "avg_robust": 0.1, "scored_folds": 3, "avg_train": 5.0, "avg_test": -4.0})
    assert status(run("rsi"))["walk_forward"] == "FAIL"


def test_walk_forward_error_is_a_failed_gate(series, monkeypatch):
    monkeypatch.setattr(bt, "_walk_forward_on_candles", lambda *a, **k: {"error": "no folds"})
    gate = [x for x in run("rsi")["gates"] if x["gate"] == "walk_forward"][0]
    assert gate["status"] == "FAIL" and "no folds" in gate["reason"]


def test_too_few_trades_fail_enough_evidence(series):
    result = run("ema_cross")
    gate = [x for x in result["gates"] if x["gate"] == "enough_evidence"][0]
    assert gate["status"] == "FAIL" and "trades" in gate["reason"]
    assert gate["numbers"]["trades"] < 30


def _base(trades=40, pf=1.5, dd=-10.0):
    return {"metrics": {"total_trades": trades, "profit_factor": pf, "max_drawdown_pct": dd,
                        "total_return_pct": 12.0}}


def test_enough_evidence_passes_when_every_threshold_is_met():
    assert g._gate_enough_evidence(_base())["status"] == "PASS"


@pytest.mark.parametrize("base, fragment", [
    (_base(trades=29), "trades"),
    (_base(pf=1.1), "profit factor"),          # must be above, not equal
    (_base(pf=0.0), "profit factor"),
    (_base(dd=-35.5), "drawdown"),
])
def test_each_evidence_threshold_can_fail_the_gate(base, fragment):
    gate = g._gate_enough_evidence(base)
    assert gate["status"] == "FAIL" and fragment in gate["reason"]


def test_a_run_with_no_losing_trades_has_an_infinite_profit_factor_that_passes_and_serialises(series):
    result = run("rsi")
    gate = [x for x in result["gates"] if x["gate"] == "enough_evidence"][0]
    assert gate["status"] == "PASS" and gate["numbers"]["profit_factor"] is None   # inf is stored as null
    json.dumps(result, allow_nan=False)            # strict JSON: no Infinity anywhere


def test_the_thresholds_are_read_at_call_time(monkeypatch):
    monkeypatch.setitem(g.GAUNTLET_THRESHOLDS, "min_trades", 50)
    assert g._gate_enough_evidence(_base(trades=40))["status"] == "FAIL"


def test_too_few_bars_stops_at_honest_settings(monkeypatch):
    monkeypatch.setattr(bt, "_load_candles", lambda *a, **k: (wavy(40), {}))
    result = run("rsi")
    assert result["verdict"] == "FAIL: honest_settings"
    assert [x["gate"] for x in result["gates"]] == ["honest_settings"]


def test_long_warmup_strategies_need_the_sma200_bars(monkeypatch):
    monkeypatch.setattr(bt, "_load_candles", lambda *a, **k: (wavy(150), {}))
    assert status(run("triple_ema")) == {"honest_settings": "FAIL"}


def test_triple_ema_skips_walk_forward(monkeypatch):
    monkeypatch.setattr(bt, "_load_candles", lambda *a, **k: (wavy(600), {}))
    gate = [x for x in run("triple_ema")["gates"] if x["gate"] == "walk_forward"][0]
    assert gate["status"] == "SKIPPED"


def test_recent_year_is_skipped_below_the_bar_minimum(monkeypatch):
    monkeypatch.setattr(bt, "_load_candles", lambda *a, **k: (wavy(150), {}))
    assert status(run("rsi"))["recent_year"] == "SKIPPED"


def test_recent_year_fails_when_recent_sharpe_lags(series, monkeypatch):
    monkeypatch.setitem(g.GAUNTLET_THRESHOLDS, "recent_sharpe_ratio", 1000)
    assert status(run("rsi"))["recent_year"] == "FAIL"


def test_recent_year_fails_when_the_full_sharpe_is_not_positive(series, monkeypatch):
    real = bt._simulate

    def losing(*a, **k):
        sim = real(*a, **k)
        sim["metrics"] = {**sim["metrics"], "sharpe_ratio": -0.5}
        return sim
    monkeypatch.setattr(bt, "_simulate", losing)
    gate = [x for x in run("rsi")["gates"] if x["gate"] == "recent_year"][0]
    assert gate["status"] == "FAIL" and "not positive" in gate["reason"]


def test_recent_year_only_counts_trades_entered_inside_the_window(series):
    result = run("rsi")
    numbers = [x for x in result["gates"] if x["gate"] == "recent_year"][0]["numbers"]
    assert 0 < numbers["recent_bars"] <= 366 and numbers["recent_trades"] > 0


# ─── gates with controlled numbers ────────────────────────────────────────────

def _sim(net):
    return {"metrics": {"total_return_pct": net}, "trades": []}


def test_sensitivity_passes_when_neighbours_hold_up():
    gate = g._gate_parameter_sensitivity(None, "rsi", bt.resolve_params("rsi", None), 10.0,
                                         lambda c, p: _sim(8.0))
    assert gate["status"] == "PASS" and gate["numbers"]["positive_share"] == 1.0


def test_sensitivity_fails_when_too_few_neighbours_are_positive():
    values = iter([5.0, -1.0, -2.0, -3.0] * 10)
    gate = g._gate_parameter_sensitivity(None, "rsi", bt.resolve_params("rsi", None), 10.0,
                                         lambda c, p: _sim(next(values)))
    assert gate["status"] == "FAIL" and "neighbours end positive" in gate["reason"]


def test_sensitivity_fails_when_the_median_is_far_below_the_base():
    gate = g._gate_parameter_sensitivity(None, "rsi", bt.resolve_params("rsi", None), 10.0,
                                         lambda c, p: _sim(1.0))      # positive but a tenth of the base
    assert gate["status"] == "FAIL" and "median" in gate["reason"]


@pytest.mark.parametrize("base", [0.0, -3.0])
def test_sensitivity_fails_when_the_base_return_is_not_positive(base):
    gate = g._gate_parameter_sensitivity(None, "rsi", bt.resolve_params("rsi", None), base, lambda c, p: _sim(5.0))
    assert gate["status"] == "FAIL"


def test_sensitivity_skips_neighbours_that_break_a_parameter_rule():
    def run_(c, p):
        raise ValueError("fast must stay below slow")
    gate = g._gate_parameter_sensitivity(None, "ema_cross", bt.resolve_params("ema_cross", None), 5.0, run_)
    assert gate["status"] == "SKIPPED"


def test_neighbours_round_ints_dedupe_and_leave_out_the_base():
    resolved = {"period": 14, "oversold": 40, "overbought": 60, "factor": 2.5, "flag": True}
    neighbours = g._neighbour_params(resolved)
    assert resolved not in neighbours
    assert {n["period"] for n in neighbours if n["period"] != 14} == {11, 13, 15, 17}
    assert all(isinstance(n["period"], int) for n in neighbours)
    assert {n["factor"] for n in neighbours if n["factor"] != 2.5} == {2.0, 2.25, 2.75, 3.0}
    assert all(n["flag"] is True for n in neighbours)                       # booleans are not scaled
    assert len(neighbours) == len({json.dumps(n, sort_keys=True) for n in neighbours})


def test_neighbours_of_a_tiny_value_collapse_to_nothing():
    assert g._neighbour_params({"period": 2}) == []


def test_double_costs_gate():
    ok = g._gate_double_costs(None, {}, 0.1, 0.05, lambda c, p, comm, slip: _sim(3.0))
    bad = g._gate_double_costs(None, {}, 0.1, 0.05, lambda c, p, comm, slip: _sim(-0.5))
    assert (ok["status"], bad["status"]) == ("PASS", "FAIL")
    assert ok["numbers"]["commission_pct"] == 0.2 and ok["numbers"]["slippage_pct"] == 0.1


def test_the_gauntlet_really_doubles_the_costs(series, monkeypatch):
    seen = []
    real = bt._simulate

    def spy(*a, **k):
        seen.append((k["commission_pct"], k["slippage_pct"], k["fill"]))
        return real(*a, **k)
    monkeypatch.setattr(bt, "_simulate", spy)
    run("rsi", cost_profile="coinbase_advanced")
    assert (0.6, 0.1, "next_open") in seen and (1.2, 0.2, "next_open") in seen
    assert all(fill == "next_open" for _, _, fill in seen)


# ─── verdict wording ──────────────────────────────────────────────────────────

def _gates(*statuses):
    return [{"gate": f"g{i}", "status": s, "reason": "", "numbers": {}} for i, s in enumerate(statuses)]


def test_verdict_forms():
    assert g._verdict(_gates("PASS", "PASS", "PASS", "PASS", "PASS", "PASS")) == "PASS"
    assert g._verdict(_gates("PASS", "PASS", "PASS", "PASS", "SKIPPED", "SKIPPED")) == "PASS (4/6, 2 skipped)"
    assert g._verdict(_gates("PASS", "FAIL", "PASS", "FAIL", "SKIPPED", "PASS")) == "FAIL: g1, g3"


def test_the_word_profitable_never_appears(series, monkeypatch):
    results = [run("rsi"), run("ema_cross"), run("rsi", hypothesis="short"),
               run("triple_ema")]
    monkeypatch.setattr(bt, "_walk_forward_on_candles", lambda *a, **k: {
        "verdict": "ROBUST — x", "avg_robust": 1.0, "scored_folds": 3, "avg_train": 1.0, "avg_test": 1.0})
    results.append(run("rsi"))
    for result in results:
        result.pop("report_path", None)                    # a temp path can contain any word
        assert "profitable" not in json.dumps(result).lower()


# ─── data handling ────────────────────────────────────────────────────────────

def test_a_forming_bar_is_dropped_but_closed_bars_stay():
    day = 86400
    bars = [{"time": 1_700_000_000 + i * day, "date": f"d{i}"} for i in range(3)]
    now_inside_last = bars[-1]["time"] + day / 2
    assert g._drop_forming_bar(bars, "1d", now_inside_last) == bars[:-1]
    assert g._drop_forming_bar(bars, "1d", bars[-1]["time"] + day + 1) == bars


def test_bars_without_a_time_key_are_left_alone():
    bars = [{"date": "2024-01-01"}]
    assert g._drop_forming_bar(bars, "1d", 0) == bars


@pytest.mark.parametrize("kw, expected", [
    ({"data_source": "tradingview", "tv_symbol": "BINANCE:BTCUSDT"}, "5y"),
    ({"data_source": "tradingview", "tv_symbol": "BINANCE:BTCUSDT", "interval": "1h"}, "2y"),
    ({"data_source": "tradingview", "tv_symbol": "BINANCE:BTCUSDT", "period": "1y"}, "1y"),
    ({"data_source": "tradingview", "tv_symbol": "BINANCE:BTCUSDT", "period": "2y"}, "2y"),   # explicit stays
    ({}, "2y"),
])
def test_an_omitted_period_becomes_the_longest_the_source_allows(monkeypatch, kw, expected):
    seen = {}

    def load(symbol, period, interval, data_source, tv_symbol):
        seen["period"] = period
        return wavy(300), {}
    monkeypatch.setattr(bt, "_load_candles", load)
    monkeypatch.setattr(g, "tv_periods_per_year", lambda *a: 365)
    run("rsi", **kw)
    assert seen["period"] == expected


def test_the_forming_tradingview_bar_is_not_scored(monkeypatch):
    import time as _time
    candles = wavy(300)
    day = 86400
    for i, c in enumerate(candles):                    # unix open times, the last bar opened an hour ago
        c["time"] = int(_time.time()) - 3600 - (len(candles) - 1 - i) * day
    monkeypatch.setattr(bt, "_load_candles", lambda *a, **k: (list(candles), {}))
    monkeypatch.setattr(g, "tv_periods_per_year", lambda *a: 365)
    result = run("rsi", data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert result["bars"]["count"] == 299
    assert result["bars"]["date_to"] == candles[-2]["date"]


# ─── fingerprint ──────────────────────────────────────────────────────────────

def test_the_fingerprint_is_stable_for_the_same_inputs(series):
    assert run("rsi")["fingerprint"] == run("rsi")["fingerprint"]


def test_the_fingerprint_changes_with_params_cost_and_code(series, monkeypatch):
    base = run("rsi")["fingerprint"]
    assert run("rsi", params={"period": 10})["fingerprint"] != base
    assert run("rsi", cost_profile="coinbase_advanced")["fingerprint"] != base
    assert run("ema_cross")["fingerprint"] != base
    monkeypatch.setattr(g, "_code_hash", lambda: "different")
    assert run("rsi")["fingerprint"] != base


def test_defaults_are_filled_in_before_hashing(series):
    explicit = run("rsi", params=bt.resolve_params("rsi", None))["fingerprint"]
    assert explicit == run("rsi")["fingerprint"]


# ─── reports, stats, verify ───────────────────────────────────────────────────

def test_the_report_is_written_with_private_permissions(series, home):
    result = run("rsi")
    path = home / "gauntlet" / f"{result['fingerprint']}.json"
    assert result["report_path"] == str(path) and path.exists()
    stored = json.loads(path.read_text())
    for key in ("fingerprint", "created_utc", "inputs", "gates", "verdict", "hypothesis",
                "counterparty", "disclaimer"):
        assert key in stored
    assert stored["disclaimer"] == g.DISCLAIMER and stored["hypothesis"] == HYPOTHESIS
    assert stat.S_IMODE((home / "gauntlet").stat().st_mode) == 0o700
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_every_run_appends_one_log_line(series, home):
    run("rsi")
    run("ema_cross")
    lines = (home / "gauntlet" / "log.jsonl").read_text().splitlines()
    assert len(lines) == 2
    assert {json.loads(line)["strategy"] for line in lines} == {"rsi", "ema_cross"}


def test_an_unwritable_home_still_returns_the_result(series, monkeypatch, tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    monkeypatch.setenv("TRADINGVIEW_MCP_HOME", str(blocker / "sub"))   # a path below a regular file
    result = run("rsi")
    assert result["verdict"] and result["report_path"] is None and "report_error" in result


def test_stats_with_no_runs():
    stats = g.gauntlet_stats()
    assert stats["total"] == 0 and stats["kill_rate_pct"] == 0.0 and stats["last_10"] == []
    assert "6 in 7" in stats["note"]


def test_stats_count_passes_failures_and_failing_gates(series, monkeypatch):
    run("ema_cross")                                   # fails enough_evidence and more
    run("rsi")                                         # fails walk_forward
    monkeypatch.setattr(bt, "_walk_forward_on_candles", lambda *a, **k: {
        "verdict": "ROBUST — x", "avg_robust": 1.0, "scored_folds": 3, "avg_train": 1.0, "avg_test": 1.0})
    run("rsi", params={"period": 10})                  # passes
    stats = g.gauntlet_stats()
    assert (stats["total"], stats["passed"], stats["failed"]) == (3, 1, 2)
    assert stats["kill_rate_pct"] == 66.7
    assert stats["by_failing_gate"]["enough_evidence"] >= 1 and stats["by_failing_gate"]["walk_forward"] >= 1
    assert len(stats["last_10"]) == 3


def test_stats_ignore_a_damaged_log_line(series, home):
    run("rsi")
    with open(home / "gauntlet" / "log.jsonl", "a") as fh:
        fh.write("{not json\n")
    assert g.gauntlet_stats()["total"] == 1


def test_stats_keep_only_the_last_ten(series, home):
    for i in range(12):
        run("rsi", params={"period": 5 + i})
    stats = g.gauntlet_stats()
    assert stats["total"] == 12 and len(stats["last_10"]) == 10


def test_verify_report_matches_current_code(series):
    fp = run("rsi")["fingerprint"]
    assert g.verify_report(fp) == {"exists": True, "verdict": "FAIL: walk_forward",
                                   "matches_current_code": True}


def test_verify_report_notices_changed_code(series, monkeypatch):
    fp = run("rsi")["fingerprint"]
    monkeypatch.setattr(g, "_code_hash", lambda: "after an edit")
    out = g.verify_report(fp)
    assert out["exists"] is True and out["matches_current_code"] is False


def test_verify_report_for_a_missing_report():
    assert g.verify_report("a" * 64) == {"exists": False, "verdict": None, "matches_current_code": False}


@pytest.mark.parametrize("bad", ["../../etc/passwd", "short", "A" * 64, "g" * 64, "", None, 5])
def test_verify_report_rejects_anything_but_a_fingerprint(bad):
    out = g.verify_report(bad)
    assert out["exists"] is False and "error" in out


def test_verify_report_survives_a_damaged_file(series, home):
    fp = run("rsi")["fingerprint"]
    (home / "gauntlet" / f"{fp}.json").write_text("{broken")
    out = g.verify_report(fp)
    assert out["exists"] is True and out["matches_current_code"] is False and "error" in out


# ─── fixes from the wrap-up review ────────────────────────────────────────────

def test_recent_year_counts_a_trade_signalled_the_bar_before_the_window(monkeypatch):
    """With next-open fills a signal on the bar before the window fills inside it."""
    candles = wavy(600)                          # longer than a year, so the window starts well inside the series
    warmup = bt._STRATEGY_WARMUP_BARS["rsi"]
    offset = warmup                              # start is far past the warm-up, so the slice begins warmup bars early
    trades = [{"entry_idx": i} for i in (offset - 2, offset - 1, offset)]
    seen = []

    def fake_metrics(kept, *a, **k):
        seen.append(sorted(t["entry_idx"] for t in kept))
        return {"total_trades": len(kept), "total_return_pct": 1.0, "sharpe_ratio": 1.0}
    monkeypatch.setattr(bt, "_calc_metrics", fake_metrics)
    gate = g._gate_recent_year(candles, "rsi", {}, {"metrics": {"sharpe_ratio": 1.0}}, "1d", None,
                               lambda window, params: {"trades": trades})
    assert seen == [[offset - 1, offset]], seen
    assert gate["status"] == "PASS"


def test_a_sparse_last_year_fails_the_gate_instead_of_skipping_it(monkeypatch):
    sparse = wavy(300)
    for i, c in enumerate(sparse):               # one bar a month: only ~12 bars in the last year
        c["date"] = (date(2000, 1, 1) + timedelta(days=30 * i)).isoformat()
    monkeypatch.setattr(bt, "_load_candles", lambda *a, **k: (sparse, {}))
    gate = [x for x in run("rsi")["gates"] if x["gate"] == "recent_year"][0]
    assert gate["status"] == "FAIL" and "too few" in gate["reason"]


def test_non_finite_numbers_become_null_in_a_gate():
    gate = g._gate("x", "PASS", "r", {"a": float("nan"), "b": float("inf"), "c": 1.5})
    assert gate["numbers"] == {"a": None, "b": None, "c": 1.5}


def test_candles_with_non_finite_prices_are_dropped():
    good = {"time": 1_700_000_000, "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 1}
    nan_bar = {**good, "time": 1_700_086_400, "open": float("nan")}
    inf_bar = {**good, "time": 1_700_172_800, "close": float("inf")}
    assert len(bt.tv_bars_to_candles([good, nan_bar, inf_bar], "1d")) == 1


def test_an_existing_loose_directory_is_tightened_and_the_log_is_private(series, home):
    directory = home / "gauntlet"
    directory.mkdir(mode=0o755)
    directory.chmod(0o755)
    run("rsi")
    assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    assert stat.S_IMODE((directory / "log.jsonl").stat().st_mode) == 0o600


def test_no_temporary_files_are_left_behind(series, home):
    run("rsi")
    run("rsi")
    names = sorted(p.name for p in (home / "gauntlet").iterdir())
    assert len(names) == 2 and "log.jsonl" in names and not any(n.endswith(".tmp") for n in names)


def test_a_failed_log_line_does_not_hide_a_stored_report(series, home):
    (home / "gauntlet").mkdir(mode=0o700)
    (home / "gauntlet" / "log.jsonl").mkdir()         # appending to a directory fails
    result = run("rsi")
    assert result["report_path"] and (home / "gauntlet" / f"{result['fingerprint']}.json").exists()
    assert "log line" in result["report_error"]


def test_stats_survive_invalid_bytes_and_non_object_lines(series, home):
    run("rsi")
    with open(home / "gauntlet" / "log.jsonl", "ab") as fh:
        fh.write(b"\xff\xfe broken\nnull\n[1, 2]\n42\n")
    assert g.gauntlet_stats()["total"] == 1


def test_a_symlink_named_like_a_fingerprint_is_not_a_report(home, tmp_path):
    outside = tmp_path / "outside.json"
    outside.write_text(json.dumps({"inputs": {}, "verdict": "PASS"}))
    (home / "gauntlet").mkdir(mode=0o700)
    (home / "gauntlet" / ("a" * 64 + ".json")).symlink_to(outside)
    assert g.verify_report("a" * 64) == {"exists": False, "verdict": None, "matches_current_code": False}

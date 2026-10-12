"""Phase 6b: the paper trader (hypothetical trades only; it never places an order).

Hermetic: a fake bridge client, a fake clock, a fake HTTP post for /notify, reports in tmp_path
through TRADINGVIEW_MCP_HOME. Nothing here touches the network.
"""
from __future__ import annotations

import json
import logging
import os
import stat
from datetime import date, datetime, timedelta, timezone

import pytest

from tradingview_mcp import paper
from tradingview_mcp.core.services import backtest_service as bt
from tradingview_mcp.core.services import gauntlet_service as g
from tradingview_mcp.core.services import paper_service as ps
from tradingview_mcp.core.services.tv_bridge_client import BridgeError

TV_SYMBOL = "BINANCE:BTCUSDT"
DAY = 86400
HYPOTHETICAL = "hypothetical — no order placed"


def utc(y, m, d, h=0, mi=0, s=0) -> float:
    return datetime(y, m, d, h, mi, s, tzinfo=timezone.utc).timestamp()


def daily_bars(n=30, start=date(2024, 1, 3)) -> list[dict]:
    """Raw bridge bars: one per UTC day, `time` is the bar's open in unix seconds."""
    out = []
    for i in range(n):
        ts = int(utc(start.year, start.month, start.day)) + i * DAY
        out.append({"time": ts, "open": 100 + i, "high": 102 + i, "low": 99 + i, "close": 101 + i, "volume": 5})
    return out


BARS = daily_bars()
LAST_CLOSED_NOW = BARS[-1]["time"] + DAY + 100        # the last bar (a Thursday) has closed; mid-week, so no summary is due


class StubClient:
    """Stands in for BridgeClient: returns `bars`, or raises each queued error first."""

    def __init__(self, bars=None, errors=()):
        self.bars = BARS if bars is None else bars
        self.errors = list(errors)
        self.calls = []

    def call(self, method, params=None, timeout_s=None):
        self.calls.append((method, params))
        if self.errors:
            raise self.errors.pop(0)
        return self.bars


class FakePost:
    def __init__(self, status=202, error=None):
        self.status, self.error, self.sent = status, error, []

    def __call__(self, url, headers, payload):
        self.sent.append((url, headers, payload))
        if self.error:
            raise self.error
        return self.status


ENV = {"WATCHER_LOCAL_TOKEN": "tok-123"}


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADINGVIEW_MCP_HOME", str(tmp_path))
    return tmp_path


def make_report(*, verdict="PASS", data_source="tradingview", tv_symbol=TV_SYMBOL, strategy="rsi",
                interval="1d", trades=52, max_dd=-10.0, date_from="2023-01-02", date_to="2024-01-01") -> dict:
    inputs = {"symbol": "BTCUSDT", "tv_symbol": tv_symbol, "data_source": data_source, "strategy": strategy,
              "params": bt.resolve_params(strategy, None), "interval": interval, "period": "2y",
              "fill": "next_open", "cost_profile": "default", "commission_pct": 0.10, "slippage_pct": 0.05}
    return {
        "fingerprint": g._fingerprint(inputs),
        "created_utc": "2024-01-02T00:00:00+00:00",
        "inputs": inputs,
        "bars": {"count": 365, "date_from": date_from, "date_to": date_to},
        "gates": [{"gate": "enough_evidence", "status": "PASS", "reason": "ok",
                   "numbers": {"trades": trades, "max_drawdown_pct": max_dd}}],
        "verdict": verdict,
    }


def store(**kw) -> dict:
    report = make_report(**kw)
    g._store(report)
    return report


def fake_simulate(monkeypatch, trades):
    """Replace the engine with fixed trades; returns the list that records each call's kwargs."""
    seen = []

    def sim(candles, strategy, **kw):
        seen.append({"strategy": strategy, **kw})
        return {"trades": trades}

    monkeypatch.setattr(bt, "_simulate", sim)
    return seen


def trade(candles, entry_idx, exit_idx, ret=3.0, forced=False):
    t = {"entry_date": candles[entry_idx]["date"], "entry_price": candles[entry_idx]["open"],
         "exit_date": candles[exit_idx]["date"], "exit_price": candles[exit_idx]["close"], "return_pct": ret}
    if forced:
        t["forced_exit"] = True
    return t


def trades_logged(fingerprint):
    """Journal lines that are trades (the journal also holds a start line and summaries)."""
    return [e for e in ps.read_journal(fingerprint) if e["type"] in ("entry", "exit")]


@pytest.fixture
def closed():
    return bt.tv_bars_to_candles(BARS, "1d")           # 30 closed daily candles, each with `time`


# ─── 6a additions: load_report, latest_pass_fingerprint, drop_forming_bar ────

def test_load_report_returns_the_stored_report_and_refuses_the_rest(home):
    report = store()
    assert g.load_report(report["fingerprint"])["inputs"]["strategy"] == "rsi"
    assert g.load_report("0" * 64) is None
    assert g.load_report("not-a-fingerprint") is None
    link = home / "gauntlet" / ("1" * 64 + ".json")
    link.symlink_to(home / "gauntlet" / f"{report['fingerprint']}.json")
    assert g.load_report("1" * 64) is None             # symlinks are refused, as verify_report does


def test_latest_pass_takes_the_newest_passed_entry_and_skips_damaged_lines(home):
    d = home / "gauntlet"
    d.mkdir(parents=True)
    lines = [
        json.dumps({"fingerprint": "a" * 64, "symbol": TV_SYMBOL, "strategy": "rsi", "passed": True}),
        "this line is damaged",
        json.dumps(["not", "an", "object"]),
        json.dumps({"fingerprint": "b" * 64, "symbol": TV_SYMBOL, "strategy": "rsi", "passed": True}),
        json.dumps({"fingerprint": "c" * 64, "symbol": TV_SYMBOL, "strategy": "rsi", "passed": False}),
        json.dumps({"fingerprint": "d" * 64, "symbol": "BINANCE:ETHUSDT", "strategy": "rsi", "passed": True}),
        json.dumps({"fingerprint": "e" * 64, "symbol": TV_SYMBOL, "strategy": "macd", "passed": True}),
    ]
    (d / "log.jsonl").write_text("\n".join(lines) + "\n")
    assert g.latest_pass_fingerprint("rsi", TV_SYMBOL) == "b" * 64
    assert g.latest_pass_fingerprint("bollinger", TV_SYMBOL) is None
    assert g.latest_pass_fingerprint("rsi", "NASDAQ:AAPL") is None


def test_latest_pass_without_a_log_is_none():
    assert g.latest_pass_fingerprint("rsi", TV_SYMBOL) is None


def test_drop_forming_bar_is_public(closed):
    inside = closed[-1]["time"] + 10
    assert g.drop_forming_bar(closed, "1d", inside) == closed[:-1]
    assert g.drop_forming_bar(closed, "1d", closed[-1]["time"] + DAY + 1) == closed


# ─── refusals ─────────────────────────────────────────────────────────────────

def test_refuses_a_missing_report():
    with pytest.raises(ps.PaperRefusal, match="no stored gauntlet report"):
        ps.load_plan("0" * 64)


def test_refuses_a_failed_verdict():
    report = store(verdict="FAIL: enough_evidence")
    with pytest.raises(ps.PaperRefusal, match="did not pass"):
        ps.load_plan(report["fingerprint"])


def test_refuses_when_the_code_changed(monkeypatch):
    report = store()
    monkeypatch.setattr(g, "verify_report",
                        lambda fp: {"exists": True, "verdict": "PASS", "matches_current_code": False})
    with pytest.raises(ps.PaperRefusal, match="pass the gauntlet again"):
        ps.load_plan(report["fingerprint"])


@pytest.mark.parametrize("kw", [
    {"data_source": "yahoo", "tv_symbol": None},
    {"data_source": "tradingview", "tv_symbol": None},
])
def test_refuses_anything_not_sourced_from_tradingview(kw):
    report = store(**kw)
    with pytest.raises(ps.PaperRefusal, match="paper trading needs a TradingView-sourced gauntlet run"):
        ps.load_plan(report["fingerprint"])


def test_a_passing_tradingview_report_loads():
    report = store()
    assert ps.load_plan(report["fingerprint"])["fingerprint"] == report["fingerprint"]


def test_resolve_fingerprint_takes_either_form(home):
    report = store()
    (home / "gauntlet" / "log.jsonl").write_text(json.dumps(
        {"fingerprint": report["fingerprint"], "symbol": TV_SYMBOL, "strategy": "rsi", "passed": True}) + "\n")
    assert ps.resolve_fingerprint(report=report["fingerprint"]) == report["fingerprint"]
    assert ps.resolve_fingerprint(latest_pass=("rsi", TV_SYMBOL)) == report["fingerprint"]
    with pytest.raises(ps.PaperRefusal, match="no passing"):
        ps.resolve_fingerprint(latest_pass=("macd", TV_SYMBOL))


# ─── timing and the forming bar ───────────────────────────────────────────────

@pytest.mark.parametrize("interval, expected", [
    ("15m", utc(2024, 1, 3, 10, 15, 15)),
    ("1h", utc(2024, 1, 3, 11, 0, 15)),
    ("4h", utc(2024, 1, 3, 12, 0, 15)),
    ("1d", utc(2024, 1, 4, 0, 0, 15)),
])
def test_next_run_is_the_next_bar_boundary_plus_15_seconds(interval, expected):
    assert ps.next_run_at(utc(2024, 1, 3, 10, 7), interval) == expected


def test_a_run_just_after_a_boundary_is_not_skipped():
    assert ps.next_run_at(utc(2024, 1, 3, 10, 15, 5), "15m") == utc(2024, 1, 3, 10, 15, 15)
    assert ps.next_run_at(utc(2024, 1, 3, 10, 15, 15), "15m") == utc(2024, 1, 3, 10, 30, 15)


def test_the_forming_bar_is_dropped():
    plan = make_report()
    forming_now = BARS[-1]["time"] + 3600                  # the last bar opened an hour ago
    assert len(ps.fetch_closed_candles(StubClient(), plan, forming_now)) == len(BARS) - 1
    assert len(ps.fetch_closed_candles(StubClient(), plan, LAST_CLOSED_NOW)) == len(BARS)


def test_fetch_asks_the_bridge_for_the_plans_symbol_and_timeframe():
    client = StubClient()
    ps.fetch_closed_candles(client, make_report(interval="4h"), LAST_CLOSED_NOW)
    (method, params), = client.calls
    assert method == "candles"
    assert params["symbol"] == TV_SYMBOL and params["timeframe"] == "240" and params["count"] == 500
    assert params["timeoutMs"] == 30000


# ─── new events ───────────────────────────────────────────────────────────────

def test_events_are_new_entries_and_real_exits_only(monkeypatch, closed):
    plan = make_report()
    sim = fake_simulate(monkeypatch, [
        trade(closed, 20, 28, ret=3.0),                    # entry is old news, the exit is recent
        trade(closed, 27, 29, forced=True),                # still open: entry only, a forced exit is not an exit
    ])
    events = ps.new_events(plan, closed, seen=set())
    assert [(e["type"], e["bar_time"]) for e in events] == [("entry", closed[27]["time"]),
                                                            ("exit", closed[28]["time"])]
    assert events[0]["price"] == closed[27]["open"]
    assert events[1]["price"] == closed[28]["close"] and events[1]["return_pct"] == 3.0
    assert sim[0]["fill"] == "next_open" and sim[0]["strategy"] == "rsi"
    assert sim[0]["params"] == plan["inputs"]["params"]
    assert sim[0]["commission_pct"] == 0.10 and sim[0]["slippage_pct"] == 0.05


def test_events_never_repeat(monkeypatch, closed):
    plan = make_report()
    fake_simulate(monkeypatch, [trade(closed, 20, 28)])
    first = ps.new_events(plan, closed, seen=set())
    seen = {(e["type"], e["bar_time"]) for e in first}
    assert first and ps.new_events(plan, closed, seen=seen) == []


def test_old_history_is_not_replayed(monkeypatch, closed):
    plan = make_report()
    fake_simulate(monkeypatch, [trade(closed, 2, 5), trade(closed, 10, 12)])
    assert ps.new_events(plan, closed, seen=set()) == []


# ─── journal ──────────────────────────────────────────────────────────────────

def test_journal_is_private_and_appends_json_lines(home):
    fp = "f" * 64
    ps.append_journal(fp, {"type": "entry", "bar_time": 1, "price": 5.0})
    ps.append_journal(fp, {"type": "exit", "bar_time": 2, "price": 6.0})
    path = home / "paper" / f"{fp}.jsonl"
    assert [json.loads(x) for x in path.read_text().splitlines()] == ps.read_journal(fp)
    assert len(ps.read_journal(fp)) == 2
    assert stat.S_IMODE(os.stat(home / "paper").st_mode) == 0o700
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


def test_damaged_journal_lines_are_skipped(home):
    fp = "f" * 64
    ps.append_journal(fp, {"type": "entry", "bar_time": 1})
    with open(home / "paper" / f"{fp}.jsonl", "a") as fh:
        fh.write("garbage\n[1, 2]\n\"text\"\n\n")
    ps.append_journal(fp, {"type": "exit", "bar_time": 2})
    assert [e["type"] for e in ps.read_journal(fp)] == ["entry", "exit"]


def test_reading_a_missing_journal_is_empty():
    assert ps.read_journal("f" * 64) == []


# ─── notifications ────────────────────────────────────────────────────────────

def entry_event():
    return {"ts": "2024-01-31T00:00:15+00:00", "type": "entry", "price": 128.0, "bar_time": 1706659200}


def exit_event(ret=2.5):
    return {"ts": "2024-01-31T00:00:15+00:00", "type": "exit", "price": 131.0, "bar_time": 1706745600,
            "return_pct": ret}


def test_notification_shape():
    plan = make_report()
    note = ps.build_notification(plan, exit_event())
    assert note["title"] == f"PAPER rsi {TV_SYMBOL} exit"
    assert HYPOTHETICAL in note["body"] and "2.5" in note["body"]
    assert note["key"] == f"{plan['fingerprint']}|exit|1706745600"
    assert note["level"] == "up"
    assert ps.build_notification(plan, exit_event(-1.0))["level"] == "down"
    assert ps.build_notification(plan, entry_event())["level"] == "info"
    assert HYPOTHETICAL in ps.build_notification(plan, entry_event())["body"]


def test_notification_fields_respect_the_notify_limits():
    note = ps.build_notification(make_report(tv_symbol="X:" + "Y" * 400), exit_event())
    assert len(note["title"]) <= 200 and len(note["body"]) <= 2000 and len(note["key"]) <= 200


def test_send_posts_to_the_local_endpoint_with_the_bearer_token():
    post = FakePost()
    payload = ps.build_notification(make_report(), entry_event())
    assert ps.send_notification(payload, post=post, env={**ENV, "WATCHER_LOCAL_PORT": "9001"}) is True
    (url, headers, sent), = post.sent
    assert url == "http://127.0.0.1:9001/notify"
    assert headers["Authorization"] == "Bearer tok-123"
    assert sent == payload
    assert ps.send_notification(payload, post=post, env=ENV) is True
    assert post.sent[1][0] == "http://127.0.0.1:8787/notify"          # default port


@pytest.mark.parametrize("port", ["@evil.example:80", "80/x", "0", "70000", "-1", " 80", "8o"])
def test_a_port_that_is_not_a_port_never_reaches_the_url(port, caplog):
    post = FakePost()
    with caplog.at_level(logging.WARNING):
        assert ps.send_notification({"title": "t"}, post=post, env={**ENV, "WATCHER_LOCAL_PORT": port}) is False
    assert post.sent == [] and "tok-123" not in caplog.text


def test_missing_token_warns_and_sends_nothing(caplog):
    post = FakePost()
    with caplog.at_level(logging.WARNING):
        assert ps.send_notification({"title": "t"}, post=post, env={}) is False
    assert post.sent == [] and "WATCHER_LOCAL_TOKEN" in caplog.text


def test_unreachable_watcher_warns_and_does_not_crash(caplog):
    with caplog.at_level(logging.WARNING):
        assert ps.send_notification({"title": "t"}, post=FakePost(error=ConnectionRefusedError("down")),
                                    env=ENV) is False
    assert "unreachable" in caplog.text and "tok-123" not in caplog.text


@pytest.mark.parametrize("status", [400, 401])
def test_a_rejected_notification_is_logged_and_never_retried(status, caplog):
    post = FakePost(status=status)
    with caplog.at_level(logging.WARNING):
        assert ps.send_notification({"title": "t"}, post=post, env=ENV) is False
    assert len(post.sent) == 1 and str(status) in caplog.text and "tok-123" not in caplog.text


def test_dry_run_prints_and_sends_nothing():
    post, printed = FakePost(), []
    payload = ps.build_notification(make_report(), entry_event())
    assert ps.send_notification(payload, post=post, env=ENV, dry_run=True, out=printed.append) is True
    assert post.sent == [] and HYPOTHETICAL in " ".join(printed)


# ─── processing one bar ───────────────────────────────────────────────────────

def test_process_once_journals_and_notifies_and_a_restart_is_silent(monkeypatch, closed):
    plan = make_report()
    fake_simulate(monkeypatch, [trade(closed, 20, 28), trade(closed, 27, 29, forced=True)])
    post = FakePost()
    events = ps.process_once(plan, client=StubClient(), now=LAST_CLOSED_NOW, post=post, env=ENV)
    assert [e["type"] for e in events] == ["entry", "exit"]
    assert len(post.sent) == 2 and len(trades_logged(plan["fingerprint"])) == 2
    # a new process reads the journal and must not announce the same events again
    again = ps.process_once(plan, client=StubClient(), now=LAST_CLOSED_NOW, post=post, env=ENV)
    assert again == [] and len(post.sent) == 2 and len(trades_logged(plan["fingerprint"])) == 2


def test_a_dead_watcher_does_not_stop_the_journal(monkeypatch, closed):
    plan = make_report()
    fake_simulate(monkeypatch, [trade(closed, 20, 28)])
    ps.process_once(plan, client=StubClient(), now=LAST_CLOSED_NOW, post=FakePost(error=OSError("x")), env=ENV)
    assert len(trades_logged(plan["fingerprint"])) == 1


# ─── weekly summary ───────────────────────────────────────────────────────────

def journal_exits(rets, start):
    return [{"type": "exit", "bar_time": int(start) + i * DAY, "return_pct": r, "price": 1.0}
            for i, r in enumerate(rets)]


def test_expected_trades_per_week_comes_from_the_gate_numbers_and_the_bar_dates():
    assert ps.expected_trades_per_week(make_report(trades=52)) == pytest.approx(1.0)      # 364 days = 52 weeks
    assert ps.expected_trades_per_week(make_report(trades=26)) == pytest.approx(0.5)
    plan = make_report()
    plan["gates"] = []
    assert ps.expected_trades_per_week(plan) is None


def test_summary_maths():
    now = utc(2024, 2, 5, 13)
    journal = journal_exits([4.0, -2.0, 1.0, 3.0], utc(2024, 1, 30))
    journal.append({"type": "exit", "bar_time": int(utc(2024, 1, 10)), "return_pct": 50.0})     # older than a week
    s = ps.weekly_summary(make_report(), journal, now)
    assert s["trades"] == 4
    assert s["win_rate_pct"] == 75.0
    assert s["avg_return_pct"] == pytest.approx(1.5)
    assert s["expected_per_week"] == pytest.approx(1.0)


def test_summary_without_trades_has_no_win_rate():
    s = ps.weekly_summary(make_report(), [], utc(2024, 2, 5, 13))
    assert s["trades"] == 0 and s["win_rate_pct"] is None and s["avg_return_pct"] is None


def test_drawdown_over_twice_the_backtests_flags_divergence():
    journal = journal_exits([-8.0, -8.0, -8.0], utc(2024, 1, 1))                # about 22% down, limit 2 x 10
    s = ps.weekly_summary(make_report(max_dd=-10.0), journal, utc(2024, 1, 8))
    assert any("Paper results diverge from the backtest" in f for f in s["flags"])
    journal = journal_exits([-5.0, -5.0], utc(2024, 1, 1))                      # about 9.75% down
    assert ps.weekly_summary(make_report(max_dd=-10.0), journal, utc(2024, 1, 8))["flags"] == []


def test_trade_count_off_by_more_than_3x_flags_divergence_after_four_weeks():
    plan = make_report(trades=52)                                               # expects 1 a week
    start = utc(2024, 1, 1)
    now = utc(2024, 2, 5, 13)                                                   # 5 weeks later: expects 5
    too_many = journal_exits([1.0] * 20, start)
    too_few = journal_exits([1.0], start)
    fine = journal_exits([1.0] * 6, start)
    assert ps.weekly_summary(plan, too_many, now)["flags"]
    assert ps.weekly_summary(plan, too_few, now)["flags"]
    assert ps.weekly_summary(plan, fine, now)["flags"] == []


def test_a_young_journal_is_not_judged_on_trade_count():
    plan = make_report(trades=52)
    assert ps.weekly_summary(plan, journal_exits([1.0], utc(2024, 1, 1)), utc(2024, 1, 15))["flags"] == []


def test_summary_is_due_monday_8am_local_once():
    journal = journal_exits([1.0], utc(2024, 1, 1))
    tz = "America/New_York"
    assert ps.summary_due(utc(2024, 1, 8, 12, 59), journal, tz) is None          # 07:59 EST
    assert ps.summary_due(utc(2024, 1, 8, 13, 0, 1), journal, tz) == "2024-01-08"
    sent = journal + [{"type": "summary", "week": "2024-01-08"}]
    assert ps.summary_due(utc(2024, 1, 9, 9), sent, tz) is None                 # already sent this week
    assert ps.summary_due(utc(2024, 1, 15, 14), sent, tz) == "2024-01-15"        # next week's is due


def test_summary_time_follows_daylight_saving():
    journal = journal_exits([1.0], utc(2024, 3, 4))
    tz = "America/New_York"
    assert ps.summary_due(utc(2024, 3, 11, 11, 59), journal, tz) is None         # 07:59 EDT
    assert ps.summary_due(utc(2024, 3, 11, 12, 0, 1), journal, tz) == "2024-03-11"


def test_no_summary_with_an_empty_journal():
    assert ps.summary_due(utc(2024, 1, 8, 13, 5), [], "America/New_York") is None


def test_a_journal_that_began_this_week_waits_for_next_monday():
    journal = journal_exits([1.0], utc(2024, 1, 9))                              # first event is after Monday 08:00
    assert ps.summary_due(utc(2024, 1, 10, 15), journal, "America/New_York") is None
    assert ps.summary_due(utc(2024, 1, 15, 14), journal, "America/New_York") == "2024-01-15"


def test_process_once_sends_the_summary_once_and_records_it(monkeypatch, closed):
    plan = make_report()
    fake_simulate(monkeypatch, [])
    ps.append_journal(plan["fingerprint"], {"type": "exit", "bar_time": int(utc(2024, 1, 31)), "return_pct": 2.0})
    post = FakePost()
    monday = utc(2024, 2, 5, 13, 30)
    ps.process_once(plan, client=StubClient(), now=monday, post=post, env=ENV, timezone_name="America/New_York")
    ps.process_once(plan, client=StubClient(), now=monday + 60, post=post, env=ENV, timezone_name="America/New_York")
    summaries = [p for _, _, p in post.sent if "weekly summary" in p["title"]]
    assert len(summaries) == 1 and HYPOTHETICAL in summaries[0]["body"]
    assert summaries[0]["key"] == f"{plan['fingerprint']}|summary|2024-02-05"


# ─── the loop: backoff and errors ─────────────────────────────────────────────

class Stop:
    def __init__(self):
        self.flag = False

    def is_set(self):
        return self.flag

    def set(self):
        self.flag = True


def run(plan, client, *, rounds, now=LAST_CLOSED_NOW, post=None):
    """Run the loop for `rounds` sleeps on a fake clock; returns the sleep lengths."""
    stop, sleeps, clock = Stop(), [], [now]

    def sleep(seconds):
        sleeps.append(seconds)
        clock[0] += seconds
        if len(sleeps) >= rounds:
            stop.set()

    ps.run_loop(plan, client=client, clock=lambda: clock[0], sleep=sleep, stop=stop,
                post=post or FakePost(), env=ENV)
    return sleeps


def test_bridge_errors_back_off_60_120_300_and_stay_at_300(caplog):
    errors = [BridgeError("UPSTREAM_UNAVAILABLE", "down")] * 4
    with caplog.at_level(logging.WARNING):
        assert run(make_report(), StubClient(errors=errors), rounds=4) == [60, 120, 300, 300]


def test_a_good_pass_resets_the_backoff(monkeypatch):
    fake_simulate(monkeypatch, [])
    errors = [BridgeError("UPSTREAM_UNAVAILABLE", "down")] * 2
    sleeps = run(make_report(), StubClient(errors=errors), rounds=4)
    assert sleeps[:2] == [60, 120]
    assert sleeps[2] == ps.next_run_at(LAST_CLOSED_NOW + 180, "1d") - (LAST_CLOSED_NOW + 180)


def test_auth_failure_logs_the_restart_hint_and_waits_300(caplog):
    with caplog.at_level(logging.WARNING):
        sleeps = run(make_report(), StubClient(errors=[BridgeError("AUTH_FAILED", "x")]), rounds=1)
    assert sleeps == [300]
    assert "restart" in caplog.text.lower() and ".env" in caplog.text


def test_unexpected_errors_never_end_the_loop():
    assert run(make_report(), StubClient(errors=[RuntimeError("odd")]), rounds=2)[0] == 60


def test_a_stop_request_ends_the_loop_cleanly():
    stop = Stop()
    stop.set()
    ps.run_loop(make_report(), client=StubClient(), clock=lambda: LAST_CLOSED_NOW, sleep=lambda s: None,
                stop=stop, post=FakePost(), env=ENV)                   # returns without raising or sleeping


# ─── the CLI ──────────────────────────────────────────────────────────────────

def cli(argv, **kw):
    return paper.main(argv, client=kw.pop("client", StubClient()), clock=lambda: LAST_CLOSED_NOW, **kw)


def test_help_works():
    with pytest.raises(SystemExit) as exc:
        paper.main(["--help"])
    assert exc.value.code == 0


def test_one_of_report_or_latest_pass_is_required():
    with pytest.raises(SystemExit) as exc:
        paper.main(["--once"])
    assert exc.value.code == 2


def test_cli_refuses_with_exit_code_2_and_says_why(capsys):
    report = store(data_source="yahoo", tv_symbol=None)
    assert cli(["--report", report["fingerprint"], "--once", "--dry-run"]) == 2
    assert "paper trading needs a TradingView-sourced gauntlet run" in capsys.readouterr().err


def test_cli_refuses_a_report_that_does_not_exist(capsys):
    assert cli(["--report", "0" * 64, "--once", "--dry-run"]) == 2
    assert "no stored gauntlet report" in capsys.readouterr().err


def test_once_dry_run_prints_a_notification_and_makes_no_network_call(monkeypatch, closed, capsys):
    report = store()
    fake_simulate(monkeypatch, [trade(closed, 27, 29, forced=True)])

    def no_network(*a, **k):
        raise AssertionError("dry run must not touch the network")

    monkeypatch.setattr(ps, "_http_post", no_network)
    assert cli(["--report", report["fingerprint"], "--once", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "PAPER rsi" in out and "hypothetical" in out
    assert len(trades_logged(report["fingerprint"])) == 1


def test_latest_pass_finds_the_report(monkeypatch, closed, home, capsys):
    report = store()
    (home / "gauntlet" / "log.jsonl").write_text(json.dumps(
        {"fingerprint": report["fingerprint"], "symbol": TV_SYMBOL, "strategy": "rsi", "passed": True}) + "\n")
    fake_simulate(monkeypatch, [trade(closed, 27, 29, forced=True)])
    assert cli(["--latest-pass", "rsi", TV_SYMBOL, "--once", "--dry-run"]) == 0
    assert "hypothetical" in capsys.readouterr().out


def test_no_order_placing_code_exists():
    source = open(ps.__file__).read() + open(paper.__file__).read()
    for word in ("place_order", "create_order", "submit_order", "ccxt", "alpaca"):
        assert word not in source


def test_a_strategy_that_never_trades_is_still_judged(monkeypatch):
    plan = make_report(trades=52)                                              # expects about 1 trade a week
    fake_simulate(monkeypatch, [])
    post = FakePost()
    first_day = utc(2024, 1, 3, 12)
    ps.process_once(plan, client=StubClient(), now=first_day, post=post, env=ENV, timezone_name="America/New_York")
    assert [e["type"] for e in ps.read_journal(plan["fingerprint"])] == ["start"]
    monday = utc(2024, 2, 12, 14)                                              # five weeks on, nothing ever traded
    ps.process_once(plan, client=StubClient(), now=monday, post=post, env=ENV, timezone_name="America/New_York")
    summary, = [p for _, _, p in post.sent if "weekly summary" in p["title"]]
    assert "diverge" in summary["body"]

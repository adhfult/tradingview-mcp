"""Phase 6b: the paper trader. Hypothetical trades only: it never places an order.

It re-runs a strategy that passed the gauntlet on live TradingView candles every bar,
journals the entries and exits that are new, and tells the watcher's local /notify
endpoint. The journal is the only state: a restart reads it and stays silent about
events it has already announced.
"""
from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from tradingview_mcp.core.services import backtest_service as bt
from tradingview_mcp.core.services import gauntlet_service as gauntlet
from tradingview_mcp.core.services.tv_bridge_client import BridgeError
from tradingview_mcp.core.services.tv_data_service import bridge_error_message

log = logging.getLogger("tradingview_mcp.paper")

HYPOTHETICAL = "hypothetical — no order placed"
CANDLE_COUNT = 500
FETCH_TIMEOUT_MS = 30000
FETCH_WAIT_S = 40            # client-side wait; a little over the bridge-side deadline
RUN_DELAY_S = 15             # wait this long after a bar closes before asking for it
LOOKBACK_BARS = 3            # events older than the last few closed bars are history, not news
BACKOFF_S = (60, 120, 300)   # after 1, 2, 3+ failures in a row
AUTH_BACKOFF_S = 300
DEFAULT_PORT = 8787
DEFAULT_TIMEZONE = "America/New_York"
MIN_WEEKS_TO_JUDGE_COUNT = 4
DAY = 86400
JOURNAL_STARTS = ("start", "entry", "exit")     # lines that say when this journal began


class PaperRefusal(Exception):
    """The strategy may not be paper traded; the message says why."""


# ─── choosing and checking the report ─────────────────────────────────────────

def resolve_fingerprint(report: Optional[str] = None, latest_pass: Optional[tuple[str, str]] = None) -> str:
    if report:
        return report
    strategy, tv_symbol = latest_pass
    fingerprint = gauntlet.latest_pass_fingerprint(strategy.lower().strip(), tv_symbol)
    if not fingerprint:
        raise PaperRefusal(f"no passing gauntlet run found for {strategy} on {tv_symbol}")
    return fingerprint


def load_plan(fingerprint: str) -> dict:
    """The stored report, if it passed, still matches the code, and came from TradingView.

    The stored verdict is a local file, not a signed one: this guards against stale code or
    changed settings, it is not a security boundary.
    """
    check = gauntlet.verify_report(fingerprint)
    if not check.get("exists"):
        raise PaperRefusal(check.get("error") or "no stored gauntlet report for that fingerprint")
    verdict = check.get("verdict")
    if not str(verdict or "").startswith("PASS"):
        raise PaperRefusal(f"that strategy did not pass the gauntlet (verdict: {verdict})")
    if not check.get("matches_current_code"):
        raise PaperRefusal("the code, settings or cost profile changed since this report: "
                           "the strategy must pass the gauntlet again")
    plan = gauntlet.load_report(fingerprint)
    if plan is None:
        raise PaperRefusal("the stored report could not be read")
    inputs = plan.get("inputs", {})
    if inputs.get("data_source") != "tradingview" or not inputs.get("tv_symbol"):
        raise PaperRefusal("paper trading needs a TradingView-sourced gauntlet run")
    if inputs.get("interval") not in gauntlet._BAR_SECONDS:
        raise PaperRefusal(f"unsupported interval {inputs.get('interval')!r}")
    return plan


def resolve_timezone(env: Mapping[str, str]) -> str:
    name = env.get("PAPER_TIMEZONE") or DEFAULT_TIMEZONE
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        raise PaperRefusal(f"PAPER_TIMEZONE {name!r} is not a known time zone") from None
    return name


# ─── timing and data ──────────────────────────────────────────────────────────

def next_run_at(now: float, interval: str) -> float:
    """The next bar boundary (UTC) plus 15 seconds; a start just after a boundary runs that bar."""
    n = gauntlet._BAR_SECONDS[interval]
    candidate = (now // n) * n + RUN_DELAY_S
    return candidate if candidate > now else candidate + n


def fetch_closed_candles(client, plan: dict, now: float) -> list[dict]:
    inputs = plan["inputs"]
    bars = client.call(
        "candles",
        {"symbol": inputs["tv_symbol"], "timeframe": bt._TV_INTERVAL_CODES[inputs["interval"]],
         "count": CANDLE_COUNT, "timeoutMs": FETCH_TIMEOUT_MS},
        timeout_s=FETCH_WAIT_S,
    )
    if not isinstance(bars, list):
        raise RuntimeError("TradingView returned an unexpected candles reply")
    candles = bt.tv_bars_to_candles(bars, inputs["interval"])
    return gauntlet.drop_forming_bar(candles, inputs["interval"], now)


# ─── events ───────────────────────────────────────────────────────────────────

def new_events(plan: dict, candles: list[dict], seen: set, since: Optional[float] = None) -> list[dict]:
    """Entries and real exits that are not in `seen` yet, from the last few closed bars.

    `seen` holds (type, bar_time). `since` (a bar time) widens the window back to that bar, so an
    outage longer than a few bars cannot drop events. With fill="next_open" an entry shows up one bar after
    its signal, and a last-bar exit is a forced close of the simulation, not a real exit,
    so it produces no event.
    """
    if not candles:
        return []
    inputs = plan["inputs"]
    result = bt._simulate(candles, inputs["strategy"], params=inputs["params"],
                          commission_pct=inputs["commission_pct"], slippage_pct=inputs["slippage_pct"],
                          fill=inputs["fill"], interval=inputs["interval"])
    time_of = {c["date"]: c["time"] for c in candles}
    cutoff = candles[max(0, len(candles) - LOOKBACK_BARS)]["time"] if since is None else since
    found: dict[tuple, dict] = {}
    for t in result["trades"]:
        bar_time = time_of.get(t["entry_date"])
        if bar_time is not None and bar_time >= cutoff:
            found[("entry", bar_time)] = {"type": "entry", "price": t["entry_price"], "bar_time": bar_time}
        bar_time = time_of.get(t["exit_date"])
        if not t.get("forced_exit") and bar_time is not None and bar_time >= cutoff:
            found[("exit", bar_time)] = {"type": "exit", "price": t["exit_price"], "bar_time": bar_time,
                                         "return_pct": t["return_pct"]}
    fresh = [e for key, e in found.items() if key not in seen]
    return sorted(fresh, key=lambda e: (e["bar_time"], e["type"] != "entry"))


# ─── journal ──────────────────────────────────────────────────────────────────

def paper_dir(create: bool = False) -> Path:
    home = Path(os.environ.get("TRADINGVIEW_MCP_HOME") or Path.home() / ".tradingview-mcp")
    directory = home / "paper"
    if create:
        home.mkdir(mode=0o700, exist_ok=True)
        directory.mkdir(mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)
    return directory


def _window_start(journal: list[dict], interval: str) -> Optional[float]:
    """Where event detection resumes: the newest journaled trade, else the last few closed bars at the start."""
    times = lambda *kinds: [e["bar_time"] for e in journal if e.get("type") in kinds  # noqa: E731
                            and isinstance(e.get("bar_time"), (int, float))]
    trades = times("entry", "exit")
    if trades:
        return max(trades)
    started = times("start")
    bar = gauntlet._BAR_SECONDS[interval]
    return (min(started) // bar - LOOKBACK_BARS) * bar if started else None


def _journal_path(fingerprint: str, create: bool = False) -> Path:
    if not gauntlet._FINGERPRINT_RE.match(fingerprint):
        raise ValueError("fingerprint must be 64 lowercase hex characters")
    return paper_dir(create) / f"{fingerprint}.jsonl"


def read_journal(fingerprint: str) -> list[dict]:
    """Every readable event, oldest first; damaged lines and lines that are not objects are skipped."""
    try:
        raw = _journal_path(fingerprint).read_bytes().decode("utf-8", errors="replace")
    except OSError:
        return []
    events = []
    for line in raw.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def append_journal(fingerprint: str, event: dict) -> None:
    path = _journal_path(fingerprint, create=True)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a") as fh:
        fh.write(json.dumps(event, sort_keys=True, allow_nan=False) + "\n")


# ─── notifications ────────────────────────────────────────────────────────────

def _note(plan: dict, kind: str, bar_key, body: str, level: str, title: Optional[str] = None) -> dict:
    inputs = plan["inputs"]
    title = title or f"PAPER {inputs['strategy']} {inputs['tv_symbol']} {kind}"
    return {"title": title[:200], "body": f"{body} ({HYPOTHETICAL})"[:2000],
            "key": f"{plan['fingerprint']}|{kind}|{bar_key}"[:200], "level": level}


def build_notification(plan: dict, event: dict) -> dict:
    bar = datetime.fromtimestamp(event["bar_time"], timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    if event["type"] == "entry":
        return _note(plan, "entry", event["bar_time"], f"Paper entry at {event['price']} on the bar of {bar}", "info")
    ret = event["return_pct"]
    return _note(plan, "exit", event["bar_time"],
                 f"Paper exit at {event['price']} on the bar of {bar}, {ret:+.2f}% after costs",
                 "up" if ret > 0 else "down")


def _http_post(url: str, headers: dict, payload: dict) -> int:
    request = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                     headers={**headers, "Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))      # 127.0.0.1: never via a proxy
    try:
        with opener.open(request, timeout=10) as reply:
            return reply.status
    except urllib.error.HTTPError as err:
        return err.code


def send_notification(payload: dict, *, post: Optional[Callable] = None, env: Optional[Mapping[str, str]] = None,
                      dry_run: bool = False, out: Callable = print) -> bool:
    """POST to the watcher's /notify. Any failure is a warning, never an exception; 4xx is not retried."""
    if dry_run:
        out(f"[dry-run] {payload.get('title', '')}\n{payload.get('body', '')}")
        return True
    env = os.environ if env is None else env
    token = env.get("WATCHER_LOCAL_TOKEN")
    if not token:
        log.warning("paper: WATCHER_LOCAL_TOKEN is not set, notification not sent")
        return False
    port = str(env.get("WATCHER_LOCAL_PORT") or DEFAULT_PORT)
    if not (port.isascii() and port.isdigit() and 0 < int(port) < 65536):
        log.warning("paper: WATCHER_LOCAL_PORT is not a port number, notification not sent")
        return False                                          # it goes into the URL next to the token
    url = f"http://127.0.0.1:{port}/notify"
    try:
        status = (post or _http_post)(url, {"Authorization": f"Bearer {token}"}, payload)
    except Exception as err:                                  # noqa: BLE001 - nothing here may stop the loop
        log.warning("paper: watcher unreachable at %s (%s)", url, type(err).__name__)
        return False
    if status != 202:
        log.warning("paper: watcher rejected the notification (HTTP %s); not retrying", status)
        return False
    return True


# ─── weekly summary ───────────────────────────────────────────────────────────

def _gate_numbers(plan: dict) -> dict:
    for gate in plan.get("gates", []):
        if gate.get("gate") == "enough_evidence":
            return gate.get("numbers") or {}
    return {}


def expected_trades_per_week(plan: dict) -> Optional[float]:
    """The backtest's trade count over the weeks its bars span (the report has no trades_per_year)."""
    trades = _gate_numbers(plan).get("trades")
    bars = plan.get("bars") or {}
    try:
        start, end = (datetime.fromisoformat(str(bars[k]).replace(" ", "T")) for k in ("date_from", "date_to"))
    except (KeyError, ValueError):
        return None
    weeks = (end - start).total_seconds() / (7 * DAY)
    return trades / weeks if isinstance(trades, (int, float)) and weeks > 0 else None


def _paper_drawdown_pct(exits: list[dict]) -> float:
    equity = peak = 1.0
    worst = 0.0
    for e in sorted(exits, key=lambda e: e["bar_time"]):
        equity *= 1 + e["return_pct"] / 100
        peak = max(peak, equity)
        worst = max(worst, (peak - equity) / peak * 100)
    return worst


def weekly_summary(plan: dict, journal: list[dict], now: float) -> dict:
    exits = [e for e in journal if e.get("type") == "exit" and isinstance(e.get("bar_time"), (int, float))
             and isinstance(e.get("return_pct"), (int, float))]
    week = [e for e in exits if now - 7 * DAY <= e["bar_time"] < now]
    wins = sum(1 for e in week if e["return_pct"] > 0)
    expected = expected_trades_per_week(plan)
    backtest_dd = abs(_gate_numbers(plan).get("max_drawdown_pct") or 0)
    paper_dd = _paper_drawdown_pct(exits)

    problems = []
    if backtest_dd and paper_dd > 2 * backtest_dd:
        problems.append(f"paper drawdown {paper_dd:.1f}% is over twice the backtest's {backtest_dd:.1f}%")
    starts = [e["bar_time"] for e in journal if e.get("type") in JOURNAL_STARTS
              and isinstance(e.get("bar_time"), (int, float))]
    weeks_running = (now - min(starts)) / (7 * DAY) if starts else 0
    if expected and weeks_running >= MIN_WEEKS_TO_JUDGE_COUNT:
        expected_total = expected * weeks_running
        if len(exits) > 3 * expected_total or len(exits) < expected_total / 3:
            problems.append(f"{len(exits)} paper trades in {weeks_running:.1f} weeks "
                            f"against about {expected_total:.1f} expected")
    flags = [f"Paper results diverge from the backtest; the backtest may have been overfitted ({p})."
             for p in problems]
    return {
        "trades": len(week),
        "win_rate_pct": round(100 * wins / len(week), 1) if week else None,
        "avg_return_pct": round(sum(e["return_pct"] for e in week) / len(week), 2) if week else None,
        "expected_per_week": expected,
        "paper_drawdown_pct": round(paper_dd, 2),
        "backtest_max_drawdown_pct": backtest_dd,
        "flags": flags,
    }


def summary_due(now: float, journal: list[dict], timezone_name: str) -> Optional[str]:
    """This week's Monday (local date) if Monday 08:00 has passed and no summary was sent for it.

    Only for a journal that already existed before that Monday, so a brand-new journal does
    not send a summary in the same pass as its first entry.
    """
    starts = [e["bar_time"] for e in journal if e.get("type") in JOURNAL_STARTS
              and isinstance(e.get("bar_time"), (int, float))]
    local = datetime.fromtimestamp(now, ZoneInfo(timezone_name))
    monday = (local - timedelta(days=local.weekday())).replace(hour=8, minute=0, second=0, microsecond=0)
    week = monday.date().isoformat()
    if (not starts or min(starts) >= monday.timestamp() or local < monday
            or any(e.get("type") == "summary" and e.get("week") == week for e in journal)):
        return None
    return week


def build_summary_notification(plan: dict, summary: dict, week: str) -> dict:
    inputs = plan["inputs"]
    win = "n/a" if summary["win_rate_pct"] is None else f"{summary['win_rate_pct']}%"
    avg = "n/a" if summary["avg_return_pct"] is None else f"{summary['avg_return_pct']:+}%"
    expected = summary["expected_per_week"]
    body = (f"Past week: {summary['trades']} paper trades, win rate {win}, average return {avg}. "
            f"Backtest expects about {'?' if expected is None else round(expected, 2)} a week. "
            f"Paper drawdown {summary['paper_drawdown_pct']}% (backtest {summary['backtest_max_drawdown_pct']}%). "
            + " ".join(summary["flags"]))
    return _note(plan, "summary", week, body.strip(), "info",
                 title=f"PAPER weekly summary {inputs['strategy']} {inputs['tv_symbol']}")


# ─── one pass and the loop ────────────────────────────────────────────────────

def _iso(now: float) -> str:
    return datetime.fromtimestamp(now, timezone.utc).isoformat()


def process_once(plan: dict, *, client, now: float, post: Optional[Callable] = None,
                 env: Optional[Mapping[str, str]] = None, dry_run: bool = False, out: Callable = print,
                 timezone_name: Optional[str] = None) -> list[dict]:
    """Fetch, simulate, journal and announce what is new, then the weekly summary if it is due."""
    env = os.environ if env is None else env
    fingerprint = plan["fingerprint"]
    journal = read_journal(fingerprint)
    if not journal:                                           # lets a strategy that never trades still be judged
        journal = [{"ts": _iso(now), "type": "start", "bar_time": int(now)}]
        append_journal(fingerprint, journal[0])
    seen = {(e.get("type"), e.get("bar_time")) for e in journal}
    candles = fetch_closed_candles(client, plan, now)
    since = _window_start(journal, plan["inputs"]["interval"])
    events = [{"ts": _iso(now), **e} for e in new_events(plan, candles, seen, since)]
    for event in events:
        append_journal(fingerprint, event)                    # journal first: a failed notify must not repeat
        journal.append(event)
        send_notification(build_notification(plan, event), post=post, env=env, dry_run=dry_run, out=out)

    week = summary_due(now, journal, timezone_name or resolve_timezone(env))
    if week:
        append_journal(fingerprint, {"ts": _iso(now), "type": "summary", "week": week})
        summary = weekly_summary(plan, journal, now)
        send_notification(build_summary_notification(plan, summary, week),
                          post=post, env=env, dry_run=dry_run, out=out)
    return events


def backoff_s(failures: int) -> int:
    return BACKOFF_S[min(max(failures, 1), len(BACKOFF_S)) - 1]


def run_loop(plan: dict, *, client, clock: Callable[[], float], sleep: Callable[[float], Any], stop,
             post: Optional[Callable] = None, env: Optional[Mapping[str, str]] = None,
             dry_run: bool = False, out: Callable = print) -> None:
    """Process each closed bar until `stop` is set. Data errors back off and never end the loop."""
    env = os.environ if env is None else env
    timezone_name = resolve_timezone(env)
    failures = 0
    while not stop.is_set():
        try:
            process_once(plan, client=client, now=clock(), post=post, env=env, dry_run=dry_run, out=out,
                         timezone_name=timezone_name)
            failures = 0
            now = clock()
            wait = next_run_at(now, plan["inputs"]["interval"]) - now
        except BridgeError as err:
            failures += 1
            if err.code == "AUTH_FAILED":
                log.warning("paper: %s Restart tradingview-mcp-paper after editing .env.", bridge_error_message(err))
                wait = AUTH_BACKOFF_S
            else:
                wait = backoff_s(failures)
                log.warning("paper: bridge error %s (%s); retrying in %ss", err.code, err.message, wait)
        except Exception:                                      # noqa: BLE001 - the loop must survive anything
            failures += 1
            wait = backoff_s(failures)
            log.exception("paper: unexpected error; retrying in %ss", wait)
        sleep(wait)

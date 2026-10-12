"""Strategy gauntlet: a strategy idea must survive six checks before it is trusted.

Nothing here trades. Every gate fills at the next bar's open and charges the chosen
cost profile. A passing verdict means "survived these tests on past data", not a forecast.

Reports are written under $TRADINGVIEW_MCP_HOME/gauntlet/ (default ~/.tradingview-mcp), one
file per fingerprint plus a log.jsonl with one summary line per run.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import statistics
import string
import tempfile
import time
from datetime import date, datetime, timedelta, timezone
from importlib import metadata
from pathlib import Path
from typing import Optional

from tradingview_mcp.core.services import backtest_service as bt
from tradingview_mcp.core.services.tv_data_service import tv_periods_per_year

# One place for every cut-off. Read at call time, so tests can override single values.
GAUNTLET_THRESHOLDS = {
    "min_trades": 30,                       # gate 2: enough trades to mean anything
    "min_profit_factor": 1.1,               # gate 2
    "max_drawdown_pct": 35,                 # gate 2: worst peak-to-trough fall allowed
    "sensitivity_min_share": 0.7,           # gate 3: share of neighbours with a positive net return
    "sensitivity_min_median_ratio": 0.5,    # gate 3: median neighbour return vs the base return
    "recent_sharpe_ratio": 0.5,             # gate 5: recent Sharpe vs full-period Sharpe
    "recent_bars_min": 200,                 # gate 5: fewer bars in total and the gate is skipped
}

GENERIC_PHRASES = frozenset({
    "momentum", "trend", "trend following", "it goes up", "it works", "buy low sell high",
    "the market", "other traders", "retail", "everyone", "nobody", "smart money",
})

DISCLAIMER = ("Survived these tests on past data. This is not a prediction or advice. "
              "Paper trade before risking money.")

MIN_TEXT_CHARS = 20
SENSITIVITY_FACTORS = (0.8, 0.9, 1.1, 1.2)
RECENT_DAYS = 365
MIN_RECENT_BARS = 30
FILL = "next_open"
_FINGERPRINT_RE = re.compile(r"^[0-9a-f]{64}$")
_BAR_SECONDS = {"15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}
_STATS_NOTE = "Most ideas should fail; around 6 in 7 failing is normal."


# ─── Small helpers ────────────────────────────────────────────────────────────

def _clean(text: str) -> str:
    """Lower-case, punctuation turned into spaces, spaces collapsed (for the generic-phrase check)."""
    table = str.maketrans(string.punctuation, " " * len(string.punctuation))
    return " ".join(str(text).lower().translate(table).split())


def _num(x):
    """JSON-safe number: inf and nan become None."""
    if isinstance(x, float) and (math.isinf(x) or math.isnan(x)):
        return None
    return x


def _gate(name: str, status: str, reason: str, numbers: Optional[dict] = None) -> dict:
    return {"gate": name, "status": status, "reason": reason,
            "numbers": {k: _num(v) for k, v in (numbers or {}).items()}}


def _edge_problem(hypothesis, counterparty) -> Optional[str]:
    """Why the stated edge is not acceptable, or None."""
    for label, text in (("hypothesis", hypothesis), ("counterparty", counterparty)):
        stripped = text.strip() if isinstance(text, str) else ""
        if len(stripped) < MIN_TEXT_CHARS:
            return (f"{label} must be at least {MIN_TEXT_CHARS} characters: say who is on the "
                    "other side of the trade and why they lose.")
        if _clean(stripped) in GENERIC_PHRASES:
            return f"{label} is a generic phrase ('{stripped}'). Be specific."
    if _clean(hypothesis) == _clean(counterparty):
        return "hypothesis and counterparty are identical. They must say different things."
    return None


def _drop_forming_bar(candles: list[dict], interval: str, now: Optional[float] = None) -> list[dict]:
    """A TradingView bar whose period has not ended yet is still forming: score closed bars only."""
    if not candles or "time" not in candles[-1]:
        return candles
    now = time.time() if now is None else now
    if candles[-1]["time"] + _BAR_SECONDS.get(interval, 86400) > now:
        return candles[:-1]
    return candles


def _neighbour_params(resolved: dict) -> list[dict]:
    """One parameter at a time, scaled by SENSITIVITY_FACTORS. Ints are rounded, duplicates and the base removed."""
    seen = set()
    out = []
    for name, value in resolved.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        for factor in SENSITIVITY_FACTORS:
            new = int(round(value * factor)) if isinstance(value, int) else round(value * factor, 4)
            if new == value or (name, new) in seen:
                continue
            seen.add((name, new))
            out.append({**resolved, name: new})
    return out


# ─── Fingerprint and storage ──────────────────────────────────────────────────

def _package_version() -> str:
    try:
        return metadata.version("tradingview-mcp-server")
    except metadata.PackageNotFoundError:
        return "dev"


def _code_hash() -> str:
    h = hashlib.sha256()
    for path in (Path(bt.__file__), Path(__file__)):
        h.update(path.read_bytes())
    return h.hexdigest()


def _fingerprint(inputs: dict) -> str:
    """sha256 of the inputs plus the package version and the code that produced the verdict."""
    payload = {**inputs, "package_version": _package_version(), "code_hash": _code_hash()}
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode()).hexdigest()


def _gauntlet_dir(create: bool = False) -> Path:
    home = Path(os.environ.get("TRADINGVIEW_MCP_HOME") or Path.home() / ".tradingview-mcp")
    directory = home / "gauntlet"
    if create:
        home.mkdir(mode=0o700, exist_ok=True)
        directory.mkdir(mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)          # also when it already existed with looser permissions
    return directory


def _store(report: dict) -> tuple[Path, Optional[str]]:
    """Write the report atomically, then append one summary line to the log.

    Returns (report path, a warning if only the log line failed).
    """
    directory = _gauntlet_dir(create=True)
    path = directory / f"{report['fingerprint']}.json"
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".report-", suffix=".tmp")   # unique, mode 0600
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(json.dumps(report, indent=2, sort_keys=True, allow_nan=False))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    failed = [g["gate"] for g in report["gates"] if g["status"] == "FAIL"]
    summary = {
        "fingerprint": report["fingerprint"],
        "created_utc": report["created_utc"],
        "symbol": report["inputs"]["tv_symbol"] or report["inputs"]["symbol"],
        "strategy": report["inputs"]["strategy"],
        "verdict": report["verdict"],
        "passed": report["verdict"].startswith("PASS"),
        "failed_gates": failed,
    }
    try:
        log_fd = os.open(directory / "log.jsonl", os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(log_fd, "a") as fh:
            fh.write(json.dumps(summary, sort_keys=True) + "\n")
    except OSError as e:
        return path, f"The report was stored but its log line could not be written: {e}"
    return path, None


# ─── The gauntlet ─────────────────────────────────────────────────────────────

def _verdict(gates: list[dict]) -> str:
    failed = [g["gate"] for g in gates if g["status"] == "FAIL"]
    if failed:
        return "FAIL: " + ", ".join(failed)
    skipped = sum(1 for g in gates if g["status"] == "SKIPPED")
    if skipped:
        passed = sum(1 for g in gates if g["status"] == "PASS")
        return f"PASS ({passed}/{len(gates)}, {skipped} skipped)"
    return "PASS"


def _gate_honest_settings(candles: list[dict], strategy: str, interval: str) -> dict:
    min_bars = 30 if interval == "1d" else 100
    warmup = bt._STRATEGY_WARMUP_BARS.get(strategy, 20)
    needed = warmup + min_bars
    if strategy in bt._SMA200_STRATEGIES:
        needed = max(needed, bt._SMA200_MIN_BARS)
    numbers = {"bars": len(candles), "bars_needed": needed, "warmup_bars": warmup}
    if len(candles) < needed:
        return _gate("honest_settings", "FAIL",
                     f"Only {len(candles)} closed bars; '{strategy}' needs at least {needed} "
                     "(warm-up plus room to trade). Use a longer period.", numbers)
    return _gate("honest_settings", "PASS", f"{len(candles)} closed bars, {needed} needed.", numbers)


def _gate_enough_evidence(base: dict) -> dict:
    th = GAUNTLET_THRESHOLDS
    m = base["metrics"]
    numbers = {"trades": m["total_trades"], "profit_factor": _num(m["profit_factor"]),
               "max_drawdown_pct": m["max_drawdown_pct"], "net_return_pct": m["total_return_pct"]}
    problems = []
    if m["total_trades"] < th["min_trades"]:
        problems.append(f"{m['total_trades']} trades (need {th['min_trades']})")
    if not m["profit_factor"] > th["min_profit_factor"]:
        problems.append(f"profit factor {_num(m['profit_factor'])} (need above {th['min_profit_factor']})")
    if abs(m["max_drawdown_pct"]) > th["max_drawdown_pct"]:
        problems.append(f"max drawdown {m['max_drawdown_pct']}% (limit {th['max_drawdown_pct']}%)")
    if problems:
        return _gate("enough_evidence", "FAIL", "; ".join(problems), numbers)
    return _gate("enough_evidence", "PASS", "Enough trades, profit factor and drawdown within limits.", numbers)


def _gate_parameter_sensitivity(candles, strategy, resolved, base_return, run) -> dict:
    th = GAUNTLET_THRESHOLDS
    if base_return <= 0:
        return _gate("parameter_sensitivity", "FAIL",
                     "The base run has no positive net return, so there is nothing for neighbours to confirm.",
                     {"base_return_pct": base_return})
    returns = []
    for params in _neighbour_params(resolved):
        try:
            returns.append(run(candles, params)["metrics"]["total_return_pct"])
        except ValueError:
            continue  # breaks a parameter rule (fast < slow, ...): not a valid neighbour
    if not returns:
        return _gate("parameter_sensitivity", "SKIPPED", "No valid neighbouring parameter sets to test.")
    share = sum(1 for r in returns if r > 0) / len(returns)
    median = statistics.median(returns)
    numbers = {"neighbours": len(returns), "positive_share": round(share, 3),
               "median_neighbour_return_pct": round(median, 2), "base_return_pct": base_return,
               "worst_neighbour_pct": min(returns), "best_neighbour_pct": max(returns)}
    problems = []
    if share < th["sensitivity_min_share"]:
        problems.append(f"only {share:.0%} of neighbours end positive (need {th['sensitivity_min_share']:.0%})")
    if median < th["sensitivity_min_median_ratio"] * base_return:
        problems.append(f"median neighbour return {median:.2f}% is below "
                        f"{th['sensitivity_min_median_ratio']:.0%} of the base {base_return}%")
    if problems:
        return _gate("parameter_sensitivity", "FAIL", "; ".join(problems), numbers)
    return _gate("parameter_sensitivity", "PASS", "Nearby settings behave like the base settings.", numbers)


def _gate_double_costs(candles, resolved, commission, slippage, run) -> dict:
    sim = run(candles, resolved, commission * 2, slippage * 2)
    net = sim["metrics"]["total_return_pct"]
    numbers = {"net_return_pct": net, "commission_pct": commission * 2, "slippage_pct": slippage * 2}
    if net > 0:
        return _gate("double_costs", "PASS", "Still a positive net return with costs doubled.", numbers)
    return _gate("double_costs", "FAIL", f"Net return {net}% once commission and slippage are doubled.", numbers)


def _gate_recent_year(candles, strategy, resolved, base, interval, ppy, run) -> dict:
    th = GAUNTLET_THRESHOLDS
    if len(candles) < th["recent_bars_min"]:
        return _gate("recent_year", "SKIPPED",
                     f"{len(candles)} bars in total (below {th['recent_bars_min']}).")
    cutoff = (date.fromisoformat(candles[-1]["date"][:10]) - timedelta(days=RECENT_DAYS)).isoformat()
    start = next(i for i, c in enumerate(candles) if c["date"][:10] >= cutoff)
    if len(candles) - start < MIN_RECENT_BARS:
        return _gate("recent_year", "FAIL",
                     f"Only {len(candles) - start} bars in the last year (need {MIN_RECENT_BARS}): too few to judge recent behaviour.",
                     {"recent_bars": len(candles) - start})
    warmup = bt._STRATEGY_WARMUP_BARS.get(strategy, 20)
    first = max(0, start - warmup)
    sim = run(candles[first:], resolved)
    # next_open fills land one bar after the signal, so a trade filled inside the window counts
    kept = [t for t in sim["trades"] if t["entry_idx"] + 1 >= start - first]
    m = bt._calc_metrics(kept, 10_000.0, interval, candles=candles[start:], periods_per_year=ppy)
    full_sharpe = base["metrics"]["sharpe_ratio"]
    numbers = {"recent_bars": len(candles) - start, "recent_trades": m["total_trades"],
               "recent_return_pct": m["total_return_pct"], "recent_sharpe": m["sharpe_ratio"],
               "full_sharpe": full_sharpe}
    if full_sharpe <= 0:
        return _gate("recent_year", "FAIL", "The full-period Sharpe ratio is not positive.", numbers)
    problems = []
    if not m["total_return_pct"] > 0:
        problems.append(f"recent return {m['total_return_pct']}%")
    if m["sharpe_ratio"] < th["recent_sharpe_ratio"] * full_sharpe:
        problems.append(f"recent Sharpe {m['sharpe_ratio']} is below "
                        f"{th['recent_sharpe_ratio']:.0%} of the full {full_sharpe}")
    if problems:
        return _gate("recent_year", "FAIL", "; ".join(problems), numbers)
    return _gate("recent_year", "PASS", "The last year holds up against the full period.", numbers)


def _gate_walk_forward(candles, strategy, resolved, commission, slippage, interval, ppy) -> dict:
    if strategy in bt._SMA200_STRATEGIES:
        return _gate("walk_forward", "SKIPPED",
                     f"'{strategy}' needs a long warm-up that does not fit walk-forward folds.")
    wf = bt._walk_forward_on_candles(
        candles, strategy, commission_pct=commission, slippage_pct=slippage, interval=interval,
        periods_per_year=ppy, params=resolved, fill=FILL)
    if "error" in wf:
        return _gate("walk_forward", "FAIL", wf["error"])
    numbers = {"robustness": wf["avg_robust"], "scored_folds": wf["scored_folds"],
               "avg_train_return_pct": wf["avg_train"], "avg_test_return_pct": wf["avg_test"]}
    label = wf["verdict"].split(" ")[0]
    if label in ("ROBUST", "MODERATE"):
        return _gate("walk_forward", "PASS", f"Walk-forward verdict {label}.", numbers)
    return _gate("walk_forward", "FAIL", f"Walk-forward verdict {label}.", numbers)


def run_gauntlet(
    symbol: str,
    strategy: str,
    hypothesis: str,
    counterparty: str,
    cost_profile: str = "default",
    interval: str = "1d",
    period: Optional[str] = None,
    params: Optional[dict] = None,
    data_source: str = "yahoo",
    tv_symbol: Optional[str] = None,
) -> dict:
    """Run a strategy through the six gates and store a fingerprinted report.

    `period` left out means the longest history the source allows (2y for Yahoo, up to 5y for TradingView).
    """
    strategy = strategy.lower().strip()
    period_given = period is not None
    period = (period or "2y").lower().strip()
    interval = interval.lower().strip()
    data_source, tv_symbol = bt._normalize_source(data_source, tv_symbol)

    if strategy not in bt._STRATEGY_MAP:
        return {"error": f"Unknown strategy '{strategy}'. Choose: {', '.join(bt._STRATEGY_MAP)}"}
    profile = (cost_profile or "default").strip().lower()
    if profile not in bt.COST_PROFILES:
        return {"error": f"Unknown cost_profile '{cost_profile}'. Choose: {', '.join(bt.COST_PROFILES)}"}
    src_err = bt._check_data_source(data_source)
    if src_err:
        return {"error": src_err}
    # An omitted period becomes the longest history the source allows for this interval.
    if not period_given and data_source == "tradingview" and interval in bt._TV_PERIODS_BY_INTERVAL:
        period = bt._TV_PERIODS_BY_INTERVAL[interval][-1]
    pi_err = bt._check_period_interval(period, interval, data_source, tv_symbol)
    if pi_err:
        return {"error": pi_err}
    try:
        resolved = bt.resolve_params(strategy, params)
    except ValueError as e:
        return {"error": str(e)}

    problem = _edge_problem(hypothesis, counterparty)
    if problem:
        return {"verdict": "FAIL: no stated edge", "reason": problem, "gates": []}

    try:
        candles, _meta = bt._load_candles(symbol, period, interval, data_source, tv_symbol)
    except Exception as e:
        return {"error": f"Failed to fetch data for '{bt._label(symbol, data_source, tv_symbol)}': {e}"}
    if data_source == "tradingview":
        candles = _drop_forming_bar(candles, interval)

    ppy = tv_periods_per_year(tv_symbol, interval) if data_source == "tradingview" else None
    commission = bt.COST_PROFILES[profile]["commission_pct"]
    slippage = bt.COST_PROFILES[profile]["slippage_pct"]

    def run(window, run_params, comm=commission, slip=slippage):
        return bt._simulate(window, strategy, params=run_params, commission_pct=comm,
                            slippage_pct=slip, fill=FILL, interval=interval, periods_per_year=ppy)

    gates = [_gate_honest_settings(candles, strategy, interval)]
    if gates[0]["status"] == "PASS":
        base = run(candles, resolved)
        gates.append(_gate_enough_evidence(base))
        gates.append(_gate_parameter_sensitivity(
            candles, strategy, resolved, base["metrics"]["total_return_pct"], run))
        gates.append(_gate_double_costs(candles, resolved, commission, slippage, run))
        gates.append(_gate_recent_year(candles, strategy, resolved, base, interval, ppy, run))
        gates.append(_gate_walk_forward(candles, strategy, resolved, commission, slippage, interval, ppy))

    inputs = {
        "symbol": symbol.upper(), "tv_symbol": tv_symbol, "data_source": data_source,
        "strategy": strategy, "params": resolved, "interval": interval, "period": period,
        "fill": FILL, "cost_profile": profile, "commission_pct": commission, "slippage_pct": slippage,
    }
    report = {
        "fingerprint": _fingerprint(inputs),
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "inputs": inputs,
        "package_version": _package_version(),
        "code_hash": _code_hash(),
        "bars": {"count": len(candles), "date_from": candles[0]["date"] if candles else None,
                 "date_to": candles[-1]["date"] if candles else None},
        "tradability": bt._tradability(candles, interval) if candles else None,
        "gates": gates,
        "verdict": _verdict(gates),
        "hypothesis": hypothesis.strip(),
        "counterparty": counterparty.strip(),
        "disclaimer": DISCLAIMER,
    }
    try:
        path, log_warning = _store(report)
        report["report_path"] = str(path)
        if log_warning:
            report["report_error"] = log_warning
    except (OSError, ValueError) as e:
        report["report_path"] = None
        report["report_error"] = f"Could not store the report: {e}"
    return report


# ─── Stats and verification ───────────────────────────────────────────────────

def gauntlet_stats() -> dict:
    """Summary of every stored run: how many survived and which gate kills most."""
    entries = []
    try:
        raw = (_gauntlet_dir() / "log.jsonl").read_bytes().decode("utf-8", errors="replace")
    except OSError:
        raw = ""
    for line in raw.splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(entry, dict):
            entries.append(entry)
    total = len(entries)
    passed = sum(1 for e in entries if e.get("passed"))
    by_gate: dict[str, int] = {}
    for e in entries:
        for gate in e.get("failed_gates", []):
            by_gate[gate] = by_gate.get(gate, 0) + 1
    return {
        "total": total,
        "passed": passed,
        "failed": total - passed,
        "kill_rate_pct": round(100 * (total - passed) / total, 1) if total else 0.0,
        "by_failing_gate": by_gate,
        "last_10": entries[-10:],
        "note": _STATS_NOTE,
    }


def verify_report(fingerprint: str) -> dict:
    """Does this report exist, and would today's code still produce the same fingerprint?"""
    missing = {"exists": False, "verdict": None, "matches_current_code": False}
    if not isinstance(fingerprint, str) or not _FINGERPRINT_RE.match(fingerprint):
        return {**missing, "error": "fingerprint must be 64 lowercase hex characters"}
    path = _gauntlet_dir() / f"{fingerprint}.json"
    if path.is_symlink() or not path.exists():
        return missing
    try:
        report = json.loads(path.read_text())
        current = _fingerprint(report["inputs"])
    except (OSError, ValueError, KeyError, TypeError):
        return {**missing, "exists": True, "error": "the stored report could not be read"}
    return {"exists": True, "verdict": report.get("verdict"), "matches_current_code": current == fingerprint}

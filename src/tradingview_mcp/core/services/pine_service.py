"""Pyne (PyneCore) strategies for the gauntlet: `strategy="pine:<name>"`.

A script is a hand-written or pre-compiled Pyne `.py` file in $TRADINGVIEW_MCP_HOME/strategies/
(default ~/.tradingview-mcp/strategies). Compiling Pine to Pyne needs PyneSys's online service; we never
call it, and we never download scripts.

SECURITY: running a script runs Python code with your rights. Only put files there that you wrote or read.

Everything that needs PyneCore imports it inside the function, so the base install (and Python 3.10) works
without the `pine` extra.
"""
from __future__ import annotations

import math
import os
import re
import statistics
import sys
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from tradingview_mcp.core.errors import ErrorCode, make_error

PREFIX = "pine:"
_NAME_RE = re.compile(r"[a-z0-9_-]{1,64}")
_MISSING = "Pine support needs Python 3.11+ and: pip install 'tradingview-mcp-server[pine]'"


class PineError(ValueError):
    """A problem with the script or its use, worded for a tool error message."""


class PineUnavailable(PineError):
    """Python is too old or the `pine` extra is not installed."""


def is_pine(strategy) -> bool:
    return isinstance(strategy, str) and strategy.startswith(PREFIX)


def script_name(strategy: str) -> str:
    return strategy[len(PREFIX):]


def valid_name(name) -> bool:
    return isinstance(name, str) and _NAME_RE.fullmatch(name) is not None


def strategies_dir() -> Path:
    home = Path(os.environ.get("TRADINGVIEW_MCP_HOME") or Path.home() / ".tradingview-mcp")
    return home / "strategies"


def _python_version() -> tuple[int, int]:
    return sys.version_info[:2]


def available() -> tuple[bool, str]:
    """(True, "") when scripts can run, else (False, why)."""
    if _python_version() < (3, 11):
        return False, "PyneCore needs Python 3.11 or newer"
    try:
        import pynecore  # noqa: F401
    except ImportError:
        return False, "PyneCore is not installed: pip install 'tradingview-mcp-server[pine]'"
    return True, ""


def dependency_missing() -> dict:
    return make_error(ErrorCode.DEPENDENCY_MISSING, _MISSING)


def _inside(path: Path, folder: Path) -> bool:
    return path.resolve().parent == folder.resolve()


def list_scripts() -> list[str]:
    """Names (no paths, no `.py`) of the scripts in the folder, sorted. Links that leave the folder are not listed."""
    folder = strategies_dir()
    if not folder.is_dir():
        return []
    names = []
    for entry in folder.iterdir():
        if entry.suffix == ".py" and valid_name(entry.stem) and entry.is_file() and _inside(entry, folder):
            names.append(entry.stem)
    return sorted(names)


def script_path(name: str) -> Path:
    """The file for a script name. Names are checked before the disk is touched; the file must sit in the folder."""
    if not valid_name(name):
        raise PineError("Invalid script name: use 1-64 characters from a-z, 0-9, '_' and '-' (a name, not a path)")
    folder = strategies_dir()
    path = folder / f"{name}.py"
    if not path.is_file():
        have = ", ".join(list_scripts()) or "none"
        raise PineError(f"No Pyne script '{name}' in {folder}. Available: {have}")
    if not _inside(path, folder):
        raise PineError(f"Script '{name}' is a link to a file outside {folder}; copy the file there instead")
    return path.resolve()


# ─── candles in, trades out ───────────────────────────────────────────────────

# Settings forced on every script. The gauntlet charges the cost profile itself (and doubles it in one gate), so the
# script's own slippage and commission must not count twice; orders fill at the next bar's open, the fill model the
# gauntlet is built on, so a script may not fill on the signal bar's close.
_FORCED_SETTINGS = {"slippage": 0, "commission_value": 0, "process_orders_on_close": False}

# PyneCore keeps the running script in module globals, so two runs at once (tools run on worker threads) would mix.
# ponytail: one run at a time, no time limit and no subprocess; add a subprocess with a timeout if a script ever hangs.
_RUN_LOCK = threading.Lock()


def candle_ms(candle: dict) -> int:
    """The bar's open time in unix milliseconds: `time` (seconds) when present, else the UTC `date`."""
    if candle.get("time") is not None:
        return int(candle["time"]) * 1000
    text = str(candle["date"])
    fmt = "%Y-%m-%d %H:%M" if " " in text else "%Y-%m-%d"
    return int(datetime.strptime(text, fmt).replace(tzinfo=timezone.utc).timestamp() * 1000)


def _period(stamps: list[int]) -> str:
    """The timeframe string PyneCore wants, from the bar spacing: minutes, '1D' or '1W'."""
    if len(stamps) < 2:
        return "1D"
    seconds = statistics.median(b - a for a, b in zip(stamps, stamps[1:])) / 1000
    if seconds >= 6 * 86400:
        return "1W"
    if seconds >= 0.9 * 86400:
        return "1D"
    return str(max(1, round(seconds / 60)))


def _syminfo(period: str):
    """Symbol info for our candles: 24/7, prices on a 0.0001 grid (candles carry 4 decimals), one unit per contract."""
    from datetime import time as clock
    from pynecore.core.syminfo import SymInfo, SymInfoInterval, SymInfoSession

    hours = [SymInfoInterval(day=d, start=clock(0), end=clock(23, 59, 59)) for d in range(7)]
    return SymInfo(
        prefix="CUSTOM", description="gauntlet", ticker="GAUNTLET", currency="USD", basecurrency="USD", period=period,
        type="crypto", mintick=0.0001, pricescale=10000, minmove=1, pointvalue=1.0, mincontract=0.000001,
        opening_hours=hours, session_starts=[SymInfoSession(day=h.day, time=h.start) for h in hours],
        session_ends=[SymInfoSession(day=h.day, time=h.end) for h in hours], timezone="UTC",
    )


@contextmanager
def _no_toml_written():
    """PyneCore's decorator writes a `.toml` next to the script unless told not to; scripts are read-only here."""
    before = os.environ.get("PYNE_SAVE_SCRIPT_TOML")
    os.environ["PYNE_SAVE_SCRIPT_TOML"] = "0"
    try:
        yield
    finally:
        if before is None:
            os.environ.pop("PYNE_SAVE_SCRIPT_TOML", None)
        else:
            os.environ["PYNE_SAVE_SCRIPT_TOML"] = before


def _require_available() -> None:
    ok, reason = available()
    if not ok:
        raise PineUnavailable(reason)


def _runner(name: str, bars: list, period: str, inputs: dict | None):
    from pynecore.core.script_runner import ScriptRunner

    path = script_path(name)
    try:
        return ScriptRunner(path, bars, _syminfo(period), inputs=inputs or None, settings=dict(_FORCED_SETTINGS))
    except PineError:
        raise
    except Exception as exc:                                     # the script is user code: anything can go wrong
        raise PineError(f"Script '{name}' could not be loaded: {type(exc).__name__}: {exc}") from exc


def declared_inputs(name: str) -> dict[str, dict]:
    """The script's numeric inputs: {name: {type: 'int'|'float', default, min, max}} (min/max None when not declared)."""
    _require_available()
    with _RUN_LOCK, _no_toml_written():
        runner = _runner(name, [], "1D", None)
        found = {}
        for key, data in runner.script.inputs.items():
            if data.input_type in ("int", "float") and not isinstance(data.defval, bool):
                found[key] = {"type": data.input_type, "default": data.defval, "min": data.minval, "max": data.maxval}
        return found


def convert_trades(closed: list, still_open: list, candles: list[dict]) -> list[dict]:
    """PyneCore trades -> this repo's trade dicts (the keys the built-in strategies produce).

    Pyne reports the bar a trade FILLED on (the bar after the signal). `entry_idx`/`exit_idx` are the signal bars
    (one earlier) and the dates and prices are the fill's: exactly what the gauntlet's next-open fill produces for
    the built-in strategies. A position still open at the end is closed at the last close and flagged forced_exit.
    Long only, one position at a time: anything else would be scored wrongly, so it is refused.
    """
    last = len(candles) - 1
    rows = []                                                    # (entry_bar, exit_bar or None, entry_price, exit_price)
    for trade in closed:
        rows.append((trade.entry_bar_index, trade.exit_bar_index, trade.entry_price, trade.exit_price, trade.size))
    for trade in still_open:
        rows.append((trade.entry_bar_index, None, trade.entry_price, candles[-1]["close"], trade.size))
    out = []
    previous_exit = -1
    for entry_bar, exit_bar, entry_price, exit_price, size in sorted(rows, key=lambda r: r[0]):
        if size < 0:
            raise PineError("The script opens short trades; short trades are not supported yet (long-only for now)")
        if not (0 <= entry_bar <= last) or (exit_bar is not None and not (entry_bar <= exit_bar <= last)):
            raise PineError(f"PyneCore reported a trade outside the data (bars {entry_bar}..{exit_bar}, {last + 1} candles)")
        for price in (entry_price, exit_price):
            if not (isinstance(price, (int, float)) and math.isfinite(price) and price > 0):
                raise PineError(f"A trade has an unusable price ({price!r}); the script must trade at positive prices")
        if entry_bar < previous_exit:
            raise PineError("The script holds overlapping trades (pyramiding or partial exits); "
                            "only one position at a time is supported")
        end_bar = last if exit_bar is None else exit_bar
        previous_exit = end_bar
        trade_dict = {
            "entry_idx": max(0, entry_bar - 1), "exit_idx": max(0, end_bar - 1) if exit_bar is not None else last,
            "entry_date": candles[entry_bar]["date"], "exit_date": candles[end_bar]["date"],
            "entry_price": float(entry_price), "exit_price": float(exit_price),
        }
        if exit_bar is None:
            trade_dict["forced_exit"] = True
        out.append(trade_dict)
    return out


def run_script(name: str, candles: list[dict], params: dict | None = None) -> list[dict]:
    """Run the script over the candles and give back its trades as trade dicts (see convert_trades).

    `params` override the script's declared inputs by name. Raises PineError for anything wrong with the script.
    """
    _require_available()
    from pynecore.types.ohlcv import OHLCV

    stamps = [candle_ms(c) for c in candles]
    bars = [OHLCV(timestamp=ts, open=float(c["open"]), high=float(c["high"]), low=float(c["low"]),
                  close=float(c["close"]), volume=float(c.get("volume") or 0.0))
            for ts, c in zip(stamps, candles)]
    with _RUN_LOCK, _no_toml_written():
        runner = _runner(name, bars, _period(stamps), params)
        closed = []
        try:
            for item in runner.run_iter():
                if len(item) == 3:
                    closed.extend(item[2])
        except Exception as exc:
            raise PineError(f"Script '{name}' failed while running: {type(exc).__name__}: {exc}") from exc
        still_open = list(runner.script.position.open_trades)
        return convert_trades(closed, still_open, candles)

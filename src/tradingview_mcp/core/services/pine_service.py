"""Pyne (PyneCore) strategies for the gauntlet: `strategy="pine:<name>"`.

A script is a hand-written or pre-compiled Pyne `.py` file in $TRADINGVIEW_MCP_HOME/strategies/
(default ~/.tradingview-mcp/strategies). Compiling Pine to Pyne needs PyneSys's online service; we never
call it, and we never download scripts.

SECURITY: running a script runs Python code with your rights. Only put files there that you wrote or read.

Everything that needs PyneCore imports it inside the function, so the base install (and Python 3.10) works
without the `pine` extra.
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

from tradingview_mcp.core.errors import ErrorCode, make_error

PREFIX = "pine:"
_NAME_RE = re.compile(r"[a-z0-9_-]{1,64}")
_MISSING = "Pine support needs Python 3.11+ and: pip install 'tradingview-mcp-server[pine]'"


class PineError(ValueError):
    """A problem with the script or its use, worded for a tool error message."""


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

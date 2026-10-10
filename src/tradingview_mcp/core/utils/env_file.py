"""Minimal, stdlib-only loader for a repo-root ``.env`` file.

Only variable *names* are ever returned or logged; values go straight into
``os.environ``. Variables that already exist in the environment are never
overridden, so real environment settings always win over the file.

The file is ``TRADINGVIEW_ENV_FILE`` when that variable is set, otherwise the
repo-root ``.env``. If a name appears more than once in the file, the last
line wins.
"""
from __future__ import annotations

import logging
import os
import re
import threading
from pathlib import Path
from typing import Optional

# src/tradingview_mcp/core/utils/env_file.py -> parents[4] is the repo root.
DEFAULT_ENV_PATH = Path(__file__).resolve().parents[4] / ".env"

_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_EXPORT_RE = re.compile(r"^export\s+")
_SKIP_ENV = "TRADINGVIEW_MCP_NO_DOTENV"
_PATH_ENV = "TRADINGVIEW_ENV_FILE"

_log = logging.getLogger("tradingview_mcp.env_file")

_once_lock = threading.Lock()
_once_done = False


def load_env_file(path: Optional[Path] = None) -> list[str]:
    """Load ``KEY=VALUE`` lines from an env file.

    The file is *path* when given, else ``TRADINGVIEW_ENV_FILE`` when set and
    non-empty, else the repo-root ``.env``. Returns the names of the variables
    that were set. A missing file, or ``TRADINGVIEW_MCP_NO_DOTENV=1``, means
    nothing is loaded. When ``TRADINGVIEW_ENV_FILE`` points at a missing file
    nothing is loaded and no error is raised (a DEBUG line names the variable,
    never a value).

    A name that appears several times in the file takes its last value. A
    variable that already existed in ``os.environ`` before loading is never
    overridden.
    """
    if os.environ.get(_SKIP_ENV) == "1":
        return []

    if path is not None:
        target = Path(path)
    elif os.environ.get(_PATH_ENV):
        target = Path(os.environ[_PATH_ENV]).expanduser()
        if not target.is_file():
            _log.debug("%s is set but does not point at a readable file; nothing loaded", _PATH_ENV)
            return []
    else:
        target = DEFAULT_ENV_PATH

    try:
        text = target.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return []

    # Parse first so a repeated name keeps its last value (dict keeps first-seen order).
    parsed: dict[str, str] = {}
    for raw in text.splitlines():
        line = _EXPORT_RE.sub("", raw.strip(), count=1)
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, _, value = line.partition("=")
        key = key.strip()
        if not _KEY_RE.match(key):
            continue

        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if "\x00" in value:
            # os.environ rejects it: skip the line rather than break the import.
            continue
        parsed[key] = value

    set_names: list[str] = []
    for key, value in parsed.items():
        if key in os.environ:
            continue
        try:
            os.environ[key] = value
        except ValueError:
            continue
        set_names.append(key)

    return set_names


def load_env_file_once() -> list[str]:
    """Run :func:`load_env_file` only the first time this is called per process."""
    global _once_done
    with _once_lock:
        if _once_done:
            return []
        _once_done = True
    return load_env_file()

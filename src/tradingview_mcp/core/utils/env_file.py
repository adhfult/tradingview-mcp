"""Minimal, stdlib-only loader for a repo-root ``.env`` file.

Only variable *names* are ever returned or logged; values go straight into
``os.environ``. Variables that already exist in the environment are never
overridden, so real environment settings always win over the file.
"""
from __future__ import annotations

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

_once_lock = threading.Lock()
_once_done = False


def load_env_file(path: Optional[Path] = None) -> list[str]:
    """Load ``KEY=VALUE`` lines from *path* (default: the repo-root ``.env``).

    Returns the names of the variables that were set. A missing file, or
    ``TRADINGVIEW_MCP_NO_DOTENV=1``, means nothing is loaded.
    """
    if os.environ.get(_SKIP_ENV) == "1":
        return []

    target = DEFAULT_ENV_PATH if path is None else Path(path)
    try:
        text = target.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return []

    set_names: list[str] = []
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

        if key in os.environ:
            continue
        try:
            os.environ[key] = value
        except ValueError:
            # e.g. an embedded NUL byte: skip the line rather than break the import.
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

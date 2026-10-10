"""Client for the Node.js bridge (``bridge/server.mjs``).

The bridge is a long-lived child process that speaks newline-delimited
JSON-RPC over stdin/stdout. This module starts it, matches replies to requests
by id, restarts it after a crash, and maps bridge error codes to the repo's
error envelopes.

Only an allowlist of environment variables reaches the child process. Every
stderr line and every error message is redacted before it is logged or
returned.
"""
from __future__ import annotations

import asyncio
import atexit
import itertools
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from concurrent.futures import Future, InvalidStateError
from concurrent.futures import TimeoutError as FutureTimeout
from pathlib import Path
from typing import Any, Mapping, Optional

from tradingview_mcp.core.errors import ErrorCode, make_error
from tradingview_mcp.core.utils.env_file import load_env_file_once

load_env_file_once()

_log = logging.getLogger("tradingview_mcp.bridge")

_DEFAULT_TIMEOUT_S = 20.0
_AVAIL_TTL_S = 60.0
_FAIL_THRESHOLD = 3
_COOLDOWN_S = 30.0
_CLOSE_WAIT_S = 2.0
_PROBE_TIMEOUT_S = 10.0
_MIN_NODE_MAJOR = 20

# src/tradingview_mcp/core/services/tv_bridge_client.py -> parents[4] is the repo root.
_REPO_ROOT = Path(__file__).resolve().parents[4]
_DEFAULT_SCRIPT = _REPO_ROOT / "bridge" / "server.mjs"

SETUP_HINT = (
    "Install Node.js 20+, run `npm ci --ignore-scripts` in the repo's bridge/ folder, "
    "and put TRADINGVIEW_SESSION_ID and TRADINGVIEW_SESSION_SIGN in .env "
    "(see docs/tradingview-session.md)."
)
_AUTH_MESSAGE = (
    "TradingView rejected the session cookies; copy fresh sessionid / sessionid_sign into .env"
)
_CREDENTIAL_VARS = ("TRADINGVIEW_SESSION_ID", "TRADINGVIEW_SESSION_SIGN")

# Only these variables are passed to the bridge process. Everything else is dropped.
_CHILD_ENV_KEYS = (
    "PATH",
    "HOME",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
    "TRADINGVIEW_SESSION_ID",
    "TRADINGVIEW_SESSION_SIGN",
    "TRADINGVIEW_BRIDGE_MAX_INFLIGHT",
)

# Python twin of bridge/lib/redact.mjs (same variable list and patterns).
_SECRET_ENV_VARS = (
    "TRADINGVIEW_SESSION_ID",
    "TRADINGVIEW_SESSION_SIGN",
    "DISCORD_WEBHOOK_URL",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "WATCHER_DASHBOARD_TOKEN",
    "WATCHER_LOCAL_TOKEN",
)
_MIN_SECRET_LENGTH = 4
_REDACT_PATTERNS = (
    (re.compile(r"sessionid(_sign)?=[^;\s]+", re.IGNORECASE), r"sessionid\1=[REDACTED]"),
    (re.compile(r"bot\d+:[A-Za-z0-9_-]+"), "bot[REDACTED]"),
    (
        re.compile(r"https://(?:ptb\.|canary\.)?discord(?:app)?\.com/api/webhooks/\S+", re.IGNORECASE),
        "[REDACTED_WEBHOOK]",
    ),
)


def _redact(text: Any) -> str:
    """Remove secret values and secret-shaped text from *text*."""
    out = str(text)
    values = (os.environ.get(name, "") for name in _SECRET_ENV_VARS)
    secrets = sorted({v for v in values if len(v) >= _MIN_SECRET_LENGTH}, key=len, reverse=True)
    for secret in secrets:
        out = out.replace(secret, "[REDACTED]")
    for pattern, replacement in _REDACT_PATTERNS:
        out = pattern.sub(replacement, out)
    return out


class BridgeError(Exception):
    """A failed bridge call. ``code`` is the bridge's error code string."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    def to_envelope(self) -> dict[str, Any]:
        """Map this error to the repo's ``{"error": {...}}`` envelope."""
        code = self.code
        message = _redact(self.message)
        if code == "SYMBOL_NOT_FOUND":
            return make_error(ErrorCode.SYMBOL_NOT_FOUND, message)
        if code == "TIMEOUT":
            return make_error(ErrorCode.UPSTREAM_TIMEOUT, message, retryable=True)
        if code == "RATE_LIMITED":
            return make_error(ErrorCode.UPSTREAM_RATE_LIMIT, message, retryable=True)
        if code == "AUTH_FAILED":
            return make_error(ErrorCode.AUTH_FAILED, _AUTH_MESSAGE)
        if code == "PERMISSION_OR_SERIES":
            base = message.rstrip(". ") or "TradingView denied access to this series"
            return make_error(
                ErrorCode.PERMISSION_DENIED,
                f"{base}. This is often a TradingView plan limit.",
            )
        if code == "INVALID_PARAMETER":
            return make_error(ErrorCode.INVALID_PARAMETER, message)
        if code == "NO_DATA":
            return make_error(ErrorCode.NO_DATA, message)
        if code == "NOT_CONFIGURED":
            return make_error(ErrorCode.NOT_CONFIGURED, message, setup=SETUP_HINT)
        # UPSTREAM_UNAVAILABLE, and any code the bridge does not map explicitly.
        return make_error(ErrorCode.UPSTREAM_ERROR, message, retryable=True)


def _default_node() -> Optional[str]:
    """Path to the Node.js executable, or None when it cannot be run."""
    return shutil.which(os.environ.get("TRADINGVIEW_BRIDGE_NODE") or "node")


def _bridge_script() -> Path:
    override = os.environ.get("TRADINGVIEW_BRIDGE_PATH")
    return Path(override) if override else _DEFAULT_SCRIPT


def _probe_node_major(node: str, env: Mapping[str, str]) -> Optional[int]:
    """Major version reported by ``node --version``, or None if it cannot be read."""
    try:
        completed = subprocess.run(
            [node, "--version"],
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            timeout=_PROBE_TIMEOUT_S,
            check=False,
            env=dict(env),
        )
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.match(r"\s*v?(\d+)\.", completed.stdout or "")
    return int(match.group(1)) if match else None


class _Process:
    """One bridge child process and the requests still waiting on it."""

    def __init__(self, popen: subprocess.Popen) -> None:
        self.popen = popen
        self.pending: dict[int, Future] = {}
        self.write_lock = threading.Lock()
        self.dead = False


class BridgeClient:
    """Talks JSON-RPC to one bridge process, starting and restarting it as needed."""

    def __init__(
        self,
        command: Optional[list[str]] = None,
        env: Optional[Mapping[str, str]] = None,
    ) -> None:
        self._injected_command = list(command) if command is not None else None
        self._env_source = env
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        self._proc: Optional[_Process] = None
        self._fail_count = 0
        self._last_fail = 0.0
        self._avail: Optional[tuple[float, bool]] = None
        self._node_majors: dict[str, Optional[int]] = {}

    # ------------------------------------------------------------------
    # configuration
    # ------------------------------------------------------------------

    def check_configured(self) -> Optional[str]:
        """Return None when the bridge can run, otherwise a short reason."""
        if self._injected_command is not None:
            return None

        node = _default_node()
        if node is None:
            return "Node.js was not found; install Node.js 20+ or set TRADINGVIEW_BRIDGE_NODE"
        if node not in self._node_majors:
            self._node_majors[node] = _probe_node_major(node, self._child_env())
        major = self._node_majors[node]
        if major is None:
            return f"could not read the Node.js version from {node}"
        if major < _MIN_NODE_MAJOR:
            return f"Node.js {_MIN_NODE_MAJOR}+ is required; found major version {major}"

        script = _bridge_script()
        if not script.is_file():
            return f"bridge script not found at {script}"
        if not (script.parent / "node_modules" / "@mathieuc" / "tradingview").exists():
            return f"bridge dependencies are missing; run npm ci --ignore-scripts in {script.parent}"
        return None

    def has_credentials(self) -> bool:
        """True when both session variables are non-empty. Never returns the values."""
        return all(bool(os.environ.get(name)) for name in _CREDENTIAL_VARS)

    def is_available(self) -> bool:
        """True when the bridge is configured and answers ``health``. Cached for a while."""
        now = time.monotonic()
        with self._lock:
            cached = self._avail
        if cached is not None and now - cached[0] < _AVAIL_TTL_S:
            return cached[1]

        ok = False
        if self.check_configured() is None:
            try:
                reply = self.call("health")
                ok = isinstance(reply, dict) and reply.get("ok") is True
            except BridgeError:
                ok = False
        with self._lock:
            self._avail = (time.monotonic(), ok)
        return ok

    def _build_command(self) -> list[str]:
        if self._injected_command is not None:
            return list(self._injected_command)
        return [_default_node() or "node", str(_bridge_script())]

    def _child_env(self) -> dict[str, str]:
        source = os.environ if self._env_source is None else self._env_source
        return {key: source[key] for key in _CHILD_ENV_KEYS if key in source}

    # ------------------------------------------------------------------
    # calls
    # ------------------------------------------------------------------

    def call(
        self,
        method: str,
        params: Optional[dict] = None,
        timeout_s: float = _DEFAULT_TIMEOUT_S,
    ) -> Any:
        """Send one request and return its ``result``. Raises :class:`BridgeError`."""
        self._check_cooldown()
        reason = self.check_configured()
        if reason is not None:
            raise BridgeError("NOT_CONFIGURED", reason)

        try:
            proc = self._ensure_started()
            result = self._request(proc, method, params, timeout_s)
        except BridgeError as err:
            if err.code == "UPSTREAM_UNAVAILABLE":
                self._note_failure()
            elif err.code != "TIMEOUT":
                # The bridge answered with an error, so the process is healthy.
                self._note_healthy()
            raise
        self._note_healthy()
        return result

    async def acall(
        self,
        method: str,
        params: Optional[dict] = None,
        timeout_s: float = _DEFAULT_TIMEOUT_S,
    ) -> Any:
        return await asyncio.to_thread(self.call, method, params, timeout_s)

    def _check_cooldown(self) -> None:
        with self._lock:
            cooling = (
                self._fail_count >= _FAIL_THRESHOLD
                and time.monotonic() - self._last_fail < _COOLDOWN_S
            )
        if cooling:
            raise BridgeError("UPSTREAM_UNAVAILABLE", "bridge cooling down after repeated failures")

    def _note_failure(self) -> None:
        with self._lock:
            self._fail_count += 1
            self._last_fail = time.monotonic()

    def _note_healthy(self) -> None:
        with self._lock:
            self._fail_count = 0

    def _ensure_started(self) -> _Process:
        with self._lock:
            proc = self._proc
            if proc is not None and not proc.dead and proc.popen.poll() is None:
                return proc
            try:
                popen = subprocess.Popen(
                    self._build_command(),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    bufsize=1,
                    encoding="utf-8",
                    errors="replace",
                    env=self._child_env(),
                )
            except OSError as exc:
                raise BridgeError(
                    "UPSTREAM_UNAVAILABLE", _redact(f"could not start the bridge: {exc}")
                ) from None
            proc = _Process(popen)
            self._proc = proc
            threading.Thread(
                target=self._read_stdout, args=(proc,), name="tv-bridge-stdout", daemon=True
            ).start()
            threading.Thread(
                target=self._read_stderr, args=(popen,), name="tv-bridge-stderr", daemon=True
            ).start()
            return proc

    def _request(
        self,
        proc: _Process,
        method: str,
        params: Optional[dict],
        timeout_s: float,
    ) -> Any:
        req_id = next(self._ids)
        payload = json.dumps(
            {"id": req_id, "method": method, "params": {} if params is None else params}
        ) + "\n"

        fut: Future = Future()
        with self._lock:
            if proc.dead:
                raise BridgeError("UPSTREAM_UNAVAILABLE", "bridge process exited")
            proc.pending[req_id] = fut

        try:
            with proc.write_lock:
                proc.popen.stdin.write(payload)  # type: ignore[union-attr]
                proc.popen.stdin.flush()  # type: ignore[union-attr]
        except (OSError, ValueError):
            with self._lock:
                proc.pending.pop(req_id, None)
            raise BridgeError("UPSTREAM_UNAVAILABLE", "could not write to the bridge process") from None

        try:
            return fut.result(timeout=timeout_s)
        except FutureTimeout:
            with self._lock:
                proc.pending.pop(req_id, None)
            if fut.done():
                # The reply arrived while we were giving up.
                return fut.result()
            raise BridgeError(
                "TIMEOUT", f"bridge did not answer {method} within {timeout_s:g}s"
            ) from None

    # ------------------------------------------------------------------
    # process plumbing (reader threads)
    # ------------------------------------------------------------------

    def _read_stdout(self, proc: _Process) -> None:
        try:
            for raw in proc.popen.stdout:  # type: ignore[union-attr]
                self._dispatch(proc, raw)
        except (OSError, ValueError):
            pass
        finally:
            self._on_exit(proc)

    def _read_stderr(self, popen: subprocess.Popen) -> None:
        try:
            for raw in popen.stderr:  # type: ignore[union-attr]
                line = raw.rstrip("\r\n")
                if line:
                    _log.debug("%s", _redact(line))
        except (OSError, ValueError):
            pass

    def _dispatch(self, proc: _Process, raw: str) -> None:
        line = raw.strip()
        if not line:
            return
        try:
            message = json.loads(line)
        except ValueError:
            _log.debug("unparseable bridge line: %s", _redact(line))
            return
        if not isinstance(message, dict):
            _log.debug("bridge sent a non-object line")
            return

        req_id = message.get("id")
        with self._lock:
            fut = proc.pending.pop(req_id, None) if type(req_id) is int else None
        if fut is None:
            # Late reply for a request that timed out, or the bridge's own id-less error.
            _log.debug("bridge reply without a waiting request (id=%r)", req_id)
            return

        error = message.get("error")
        try:
            if isinstance(error, dict):
                code = error.get("code")
                if not isinstance(code, str):
                    code = "UPSTREAM_ERROR"
                fut.set_exception(BridgeError(code, _redact(error.get("message", ""))))
            else:
                fut.set_result(message.get("result"))
        except InvalidStateError:
            pass

    def _fail_pending(self, proc: _Process, reason: str) -> None:
        with self._lock:
            orphaned = list(proc.pending.values())
            proc.pending.clear()
        for fut in orphaned:
            try:
                fut.set_exception(BridgeError("UPSTREAM_UNAVAILABLE", reason))
            except InvalidStateError:
                pass

    def _on_exit(self, proc: _Process) -> None:
        with self._lock:
            proc.dead = True
            if self._proc is proc:
                self._proc = None
        self._fail_pending(proc, "bridge process exited")
        try:
            proc.popen.wait(timeout=_CLOSE_WAIT_S)
        except subprocess.TimeoutExpired:
            pass

    # ------------------------------------------------------------------
    # shutdown
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Stop the bridge process. Safe to call more than once."""
        with self._lock:
            proc, self._proc = self._proc, None
            self._avail = None
        if proc is None:
            return

        proc.dead = True
        self._fail_pending(proc, "bridge closed")
        popen = proc.popen
        try:
            if popen.stdin is not None:
                popen.stdin.close()
        except (OSError, ValueError):
            pass
        try:
            popen.terminate()
        except OSError:
            pass
        try:
            popen.wait(timeout=_CLOSE_WAIT_S)
        except subprocess.TimeoutExpired:
            popen.kill()
            popen.wait()


_client: Optional[BridgeClient] = None
_client_lock = threading.Lock()


def get_client() -> BridgeClient:
    """Return the process-wide client, creating it on first use."""
    global _client
    with _client_lock:
        if _client is None:
            _client = BridgeClient()
            atexit.register(_client.close)
        return _client


def reset_client_for_tests() -> None:
    """Close and forget the shared client. Tests only."""
    global _client
    with _client_lock:
        old, _client = _client, None
    if old is not None:
        old.close()

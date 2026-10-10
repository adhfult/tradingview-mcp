# Phase 2: Python client for the Node bridge

## Brief (Opus)

**Goal:** Python code that starts `bridge/server.mjs` (from Phase 1) as a long-lived child process, sends JSON-RPC requests, matches replies, restarts after crashes, maps errors to the repo's error envelopes, and loads credentials from a gitignored `.env`. **No MCP tools yet** (that's Phase 3).

**Master plan:** §8. The protocol is described in `docs/handoffs/phase-1.md` and implemented in `bridge/server.mjs`. **Read `bridge/server.mjs` first**, so you match its real method names, params and error codes.

### Rules
- Read each file fully before editing it. Don't change existing signatures or behaviour.
- Stdlib only: `subprocess`, `threading`, `json`, `itertools`, `concurrent.futures`, `asyncio`, `shutil`, `os`, `pathlib`, `logging`, `atexit`, `time`, `re`. **No new dependencies.**
- Hermetic tests. Use a **fake bridge written in Python**; never real Node or the network.
- If something in this brief doesn't match the code, stop and report it.
- Don't commit or push.
- **No secret values anywhere.** Tests use obviously fake values like `fake-session-123`.

### Files
- **New:** `src/tradingview_mcp/core/utils/env_file.py`
- **New:** `src/tradingview_mcp/core/services/tv_bridge_client.py`
- **Edit:** `src/tradingview_mcp/core/errors.py` (add three `ErrorCode` members)
- **Edit:** `src/tradingview_mcp/core/utils/validators.py` (add `to_tv_timeframe`)
- **New:** `tests/unit/fixtures/fake_bridge.py`
- **New:** `tests/unit/services/test_tv_bridge_client.py`
- **New:** `tests/unit/test_env_file.py`

### 1. `env_file.py`
- `load_env_file(path: Optional[Path] = None) -> list[str]`
  - Default path: the repo root's `.env`, i.e. `Path(__file__).resolve().parents[4] / ".env"` (check the depth: `src/tradingview_mcp/core/utils/env_file.py` → repo root).
  - Returns the list of variable **names** it set. Never log or return values.
- **Parsing:** one `KEY=VALUE` per line.
  - ignore blank lines and lines starting with `#`
  - strip an optional leading `export `
  - `KEY` must match `^[A-Za-z_][A-Za-z0-9_]*$`
  - strip matching single or double quotes around `VALUE`
  - no variable expansion
  - **never override a variable that already exists in `os.environ`**
  - a missing file means do nothing
- Skip everything when `os.environ.get("TRADINGVIEW_MCP_NO_DOTENV") == "1"`.
- `load_env_file_once()`: a module-level guard so it runs once per process.

### 2. `errors.py`
Add to `ErrorCode`, in a new `# Configuration / auth` group:
- `NOT_CONFIGURED = "NOT_CONFIGURED"`
- `AUTH_FAILED = "AUTH_FAILED"`
- `PERMISSION_DENIED = "PERMISSION_DENIED"`

### 3. `validators.py`
`to_tv_timeframe(tf: str) -> str`:
- First normalise with the existing `validate_timeframe(tf)` (it raises `ScreenerServiceError` on bad input).
- Then map `5m→"5"`, `15m→"15"`, `1h→"60"`, `4h→"240"`, `1D→"D"`, `1W→"W"`, `1M→"M"`.

### 4. `tv_bridge_client.py`
- **Constants:**
  - `_DEFAULT_TIMEOUT_S = 20.0`
  - `_AVAIL_TTL_S = 60.0`
  - `_FAIL_THRESHOLD = 3`
  - `_COOLDOWN_S = 30.0`
- **`class BridgeError(Exception)`** with `.code` (the bridge code string) and `.message`. Method `to_envelope()` returns `make_error(...)` using this table:

| Bridge code | `ErrorCode` | Extras |
|---|---|---|
| `SYMBOL_NOT_FOUND` | `SYMBOL_NOT_FOUND` | |
| `TIMEOUT` | `UPSTREAM_TIMEOUT` | `retryable=True` |
| `RATE_LIMITED` | `UPSTREAM_RATE_LIMIT` | `retryable=True` |
| `AUTH_FAILED` | `AUTH_FAILED` | message: "TradingView rejected the session cookies; copy fresh sessionid / sessionid_sign into .env" |
| `PERMISSION_OR_SERIES` | `PERMISSION_DENIED` | message notes this is often a TradingView plan limit |
| `INVALID_PARAMETER` | `INVALID_PARAMETER` | |
| `NO_DATA` | `NO_DATA` | |
| `NOT_CONFIGURED` | `NOT_CONFIGURED` | `setup` hint text (below) |
| `UPSTREAM_UNAVAILABLE` and anything else | `UPSTREAM_ERROR` | `retryable=True` |

- **Setup hint text** (a constant `SETUP_HINT`): "Install Node.js 20+, run `npm ci --ignore-scripts` in the repo's bridge/ folder, and put TRADINGVIEW_SESSION_ID and TRADINGVIEW_SESSION_SIGN in .env (see docs/tradingview-session.md)."
- **`_redact(text)`:** a Python twin of `bridge/lib/redact.mjs`, with the same env var list and patterns. Used on every stderr line and error message.
- **`class BridgeClient`:**
  - `__init__(self, command: Optional[list[str]] = None, env: Optional[dict] = None)`. `command` and `env` are injectable for tests.
  - **Default command:** `[node, script]` where:
    - `node` = `os.environ.get("TRADINGVIEW_BRIDGE_NODE") or shutil.which("node")`
    - `script` = `os.environ.get("TRADINGVIEW_BRIDGE_PATH")` or `<repo root>/bridge/server.mjs`
  - **`check_configured() -> Optional[str]`:** returns `None` if OK, otherwise a short human reason. Checks:
    - node found, and its major version ≥ 20 (run `node --version` once, cached)
    - script exists
    - `<script dir>/node_modules/@mathieuc/tradingview` exists

    Skip these checks when `command` was injected.
  - **Child environment** is an **allowlist** built from `os.environ`, never the full environment: `PATH`, `HOME`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `HTTPS_PROXY`, `https_proxy`, `NO_PROXY`, `no_proxy`, `TRADINGVIEW_SESSION_ID`, `TRADINGVIEW_SESSION_SIGN`, `TRADINGVIEW_BRIDGE_MAX_INFLIGHT`. Only variables that exist are passed. `env=` overrides for tests.
  - **`_ensure_started()`:**
    - uses `Popen(command, stdin=PIPE, stdout=PIPE, stderr=PIPE, text=True, bufsize=1, env=child_env)`
    - starts a stdout reader thread: `json.loads` each line, look up `id` in `self._pending` (a dict of `int → concurrent.futures.Future`), then `set_result` or `set_exception(BridgeError(...))`
    - starts a stderr thread: logs `_redact(line)` at DEBUG via `logging.getLogger("tradingview_mcp.bridge")`
    - when stdout hits EOF, the process died: fail all pending futures with `BridgeError("UPSTREAM_UNAVAILABLE", "bridge process exited")` and mark the process dead
  - **`call(method, params=None, timeout_s=_DEFAULT_TIMEOUT_S) -> Any`:**
    - if in cool-down (`_fail_count >= _FAIL_THRESHOLD` and less than `_COOLDOWN_S` since the last failure), raise `BridgeError("UPSTREAM_UNAVAILABLE", "bridge cooling down after repeated failures")`
    - if not configured, raise `BridgeError("NOT_CONFIGURED", reason)`
    - otherwise ensure the process has started, take the next id from `itertools.count(1)`, write `json.dumps({...}) + "\n"` under a write lock, and wait on the future with `timeout_s`
    - on timeout, remove the pending entry and raise `BridgeError("TIMEOUT", ...)`
    - on success, reset `_fail_count`
    - on `UPSTREAM_UNAVAILABLE` or a process death, increment `_fail_count` and record the time
    - if the process died, the next call restarts it
  - **`async acall(...)`:** `await asyncio.to_thread(self.call, method, params, timeout_s)`.
  - **`is_available() -> bool`:** `check_configured() is None` and a `health` call succeeds. Cache the answer for `_AVAIL_TTL_S`.
  - **`has_credentials() -> bool`:** both credential variables are non-empty in `os.environ`. **Never return or log the values.**
  - **`close()`:** close stdin, `terminate()`, `wait(2)`, then `kill()` if needed. Idempotent.
- **Module level:**
  - call `load_env_file_once()` at import
  - `get_client() -> BridgeClient`: a lazy singleton protected by a lock, with `atexit.register(client.close)`
  - `reset_client_for_tests()`

### 5. `tests/unit/fixtures/fake_bridge.py`
A tiny script run as `[sys.executable, fake_bridge.py, <mode>]`. It reads stdin lines and writes JSON replies:
- `health` returns `{"ok": true, "libVersion": "4.0.0", "node": "fake", "hasCredentials": false}`
- `echo` returns the params as they came
- `sleep` waits `params.s` seconds, then replies (used for the timeout and concurrency tests)
- `fail` returns `{"error": {"code": params.code, "message": params.message}}`
- `crash` calls `sys.exit(1)` without replying
- `stderr` writes `params.text` to stderr, then replies `{}`

### 6. Tests
**`test_tv_bridge_client.py`:**
1. `health` round-trip.
2. Two concurrent calls (threads): `sleep 0.3` and `echo` both resolve correctly.
3. Timeout: `sleep 2` with `timeout_s=0.3` raises `BridgeError` with code `TIMEOUT`.
4. Every row of the error table maps to the right `make_error` code (test `to_envelope()` directly).
5. `crash`: the call raises `UPSTREAM_UNAVAILABLE`, and the next call works again (restart).
6. Cool-down: 3 crashes in a row, then the next call raises "cooling down" without starting a process. Monkeypatch `time.monotonic` or the cool-down constant.
7. `NOT_CONFIGURED`: with no `command` injected and `TRADINGVIEW_BRIDGE_NODE` pointing to a missing file, `call` raises `NOT_CONFIGURED`.
8. Redaction: set fake env values `TRADINGVIEW_SESSION_ID=fake-session-123` and `TELEGRAM_BOT_TOKEN=bot123456:ABCdef`, call `stderr` with text containing both, and use `caplog` to check the logged line has neither value.
9. The child environment allowlist: set `SOME_RANDOM_SECRET=x` in the parent, call `echo` on a fake bridge mode `env` that returns the keys of `os.environ`, and assert `SOME_RANDOM_SECRET` is absent. Add that `env` mode to `fake_bridge.py`.
10. `close()` is idempotent, and the process has exited afterwards.

**`test_env_file.py`:**
- parsing (comments, `export`, quotes)
- doesn't override existing variables
- `TRADINGVIEW_MCP_NO_DOTENV=1` skips loading
- missing file is fine
- returned names only

Use `tmp_path` and `monkeypatch.setenv` / `delenv`.

**`to_tv_timeframe`:** the full table, plus a bad input raising.

### Acceptance
- `uv run pytest tests/unit -q` passes: all existing tests plus the new ones.
- Run the suite once **with Node hidden**: `PATH=/usr/bin:/bin uv run pytest tests/unit -q`, after checking `uv` is reachable, or use the absolute path to uv. It must also pass.
- No new dependencies.
- `git status` shows only the files listed above plus this handoff file.

### Report format (append under "## Implementation report (Haiku)")
- files changed
- any mismatches with `bridge/server.mjs`
- the real last 3 lines of both pytest runs (with and without Node)

# Phase 4: packaging, Docker, CI, docs

## Brief (Opus)

**Goal:** the bridge ships with the project (Docker image, CI, docs), without breaking pip installs or the existing CI.

**Master plan:** §10. Read `docs/handoffs/STATUS.md` (Decisions) and the Phase 1–3 handoff files for what was actually built.

### Read first
`Dockerfile`, `.dockerignore`, `.gitignore` (root; note it ignores `lib/`, `package.json` and `package-lock.json` repo-wide, and `bridge/.gitignore` re-includes them), `.github/workflows/test.yml`, `pyproject.toml`, `README.md`, `SECURITY.md`, `CHANGELOG.md`, `bridge/README.md`, `bridge/package.json`.

### Rules
- Don't change runtime behaviour.
- No new dependencies.
- No secrets. Example files use placeholders like `your_sessionid_here`.
- Don't commit or push.
- Write docs in plain, short sentences.

### 1. Ignore files
- **Root `.gitignore`:** add `bridge/node_modules/`, `watcher.config.json`, `bridge/watcher.config.json`, `*.state.json`, `paper-journal*`.
- **`.dockerignore`:** add `bridge/node_modules`, `.env`, `.env.*`, `watcher.config.json`, `bridge/watcher.config.json`, `*.state.json`, `.venv`, `.git`.

### 2. Dockerfile
- **New first stage:**
  ```dockerfile
  FROM node:22-bookworm-slim AS bridge
  WORKDIR /bridge
  COPY bridge/package.json bridge/package-lock.json bridge/.npmrc ./
  RUN npm ci --ignore-scripts --omit=dev
  COPY bridge/ ./
  ```
- **Runtime stage:**
  - `COPY --from=bridge /usr/local/bin/node /usr/local/bin/node`
  - `COPY --from=bridge /bridge /app/bridge`
  - `ENV TRADINGVIEW_BRIDGE_PATH=/app/bridge/server.mjs`
  - `chown` stays as is
- Keep the existing builder and runtime logic unchanged otherwise.
- **The image must start with no credentials.** Tools without the bridge keep working, `tv_status` says configured, and `/health` returns 200.
- Check: if `docker info` works in this environment, run `docker build -t tvmcp-test .` and a container `/health` check. If the Docker daemon isn't reachable, say so in the report. **Don't** try to start a daemon.

### 3. CI (`.github/workflows/test.yml`)
Add a job `bridge`:
- `runs-on: ubuntu-latest`
- matrix `node-version: ["20", "22"]`
- steps:
  - `actions/checkout@v4`
  - `actions/setup-node@v4` with `node-version: ${{ matrix.node-version }}`, `cache: npm`, `cache-dependency-path: bridge/package-lock.json`
  - `npm ci --ignore-scripts` (`working-directory: bridge`)
  - `npm test` (`working-directory: bridge`)
  - `npm audit --omit=dev --audit-level=high` (`working-directory: bridge`)
- Leave the Python `test` job unchanged. It has no Node, which proves the Python side works without the bridge.

### 4. `pyproject.toml`
- Version `0.9.0` → `0.10.0`.
- Change nothing else unless needed.

### 5. Docs
- **New `docs/tradingview-session.md`:**
  - what the cookies are
  - how to copy `sessionid` and `sessionid_sign`: DevTools → Application → Cookies → `https://www.tradingview.com`
  - put them in `.env` (gitignored) or the environment; never paste them into chats or commits
  - **risks:** it's the user's real account; automated use can break TradingView's terms; keep traffic low (the bridge allows 2 requests at a time)
  - how to check the plan's data delay: open AAPL while logged in
  - how to revoke: log out of all sessions in TradingView settings
- **New `.env.example`** with names only:
  ```
  TRADINGVIEW_SESSION_ID=
  TRADINGVIEW_SESSION_SIGN=
  # optional
  TRADINGVIEW_BRIDGE_MAX_INFLIGHT=2
  TRADINGVIEW_MCP_SCANNER_USE_SESSION=1
  ```
  Check that the root `.gitignore`'s `.env` rule doesn't also ignore `.env.example`. If it does, add `!.env.example`.
- **`README.md`:** add a short section "Use your TradingView account (optional)":
  - what it adds: the `tv_*` tools, logged-in scanner data, TradingView candles in backtests
  - setup: Node 20+, `cd bridge && npm ci --ignore-scripts`, `.env`, then call `tv_status` to check
  - links to `docs/tradingview-session.md` and `bridge/README.md`

  Also update the tool count, and add the new tools to any tool list or table. Find them by grepping "37".
- **`SECURITY.md`:** add a section on the bridge:
  - one pinned npm dependency (plus `ws`)
  - installed with `--ignore-scripts`
  - `package.json` only under `bridge/`
  - cookies come only from env or `.env`
  - all logs are redacted
  - the child process gets an allowlisted environment
- **`CHANGELOG.md`:** an entry for 0.10.0 covering Phases 0–4 (data_freshness, bridge, `tv_*` tools, TradingView backtest source, logged-in scanner, Docker/CI). Match the existing format.

### Acceptance
- `uv run pytest tests/unit -q` passes, and also with Node hidden.
- `cd bridge && npm test` passes.
- The YAML is valid: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/test.yml'))"` if PyYAML is available; otherwise check by eye and say so.
- `git check-ignore -v .env.example` shows it is **not** ignored.

### Report (append under "## Implementation report (Haiku)")
- files changed
- the Docker result (built, or daemon unavailable)
- the real last lines of the test runs

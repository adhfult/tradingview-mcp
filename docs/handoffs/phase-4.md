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

## Implementation report (Haiku)

**Status:** complete, with one Docker gap (the daemon is not reachable here, so the image was not built). Nothing committed or pushed by this step. No secrets. No `src/`, `tests/` or `bridge/` file edited.

### Files changed
- `.gitignore`: added `bridge/node_modules/`, `watcher.config.json`, `bridge/watcher.config.json`, `*.state.json`, `paper-journal*`. `.env` was already covered.
- `.dockerignore`: the orchestrator's secrets block was already present and correct (`.env`, `.env.*`, `!.env.example`, `bridge/node_modules/`, watcher configs, `*.state.json`; `.venv/` and `.git/` were already there too). Added the same rules at any depth (`**/.env`, `**/.env.*`, `!**/.env.example`, `**/watcher.config.json`, `**/*.state.json`, `**/paper-journal*`). A bare pattern in `.dockerignore` only matches the build root, so `bridge/.env` would otherwise have been copied into the image.
- `Dockerfile`: new first stage `FROM node:22-bookworm-slim AS bridge` (`COPY` package.json, package-lock.json, .npmrc; `npm ci --ignore-scripts --omit=dev`; `COPY bridge/ ./`). Runtime stage: `COPY --from=bridge /usr/local/bin/node`, `COPY --from=bridge /bridge /app/bridge`, `ENV TRADINGVIEW_BRIDGE_PATH=/app/bridge/server.mjs`, and a `RUN node --version` guard. Builder and the rest of the runtime are unchanged. No credentials are set in the image.
- `.github/workflows/test.yml`: new job `bridge` (matrix Node 20 and 22; setup-node with npm cache keyed on `bridge/package-lock.json`; `npm ci --ignore-scripts`; `npm test`; `npm audit --omit=dev --audit-level=high`, each with `working-directory: bridge`). The `test` job is unchanged. The diff is additions only.
- `pyproject.toml`: version `0.9.0` → `0.10.0`. Nothing else.
- `README.md`: "Use your TradingView account (optional)" section, a TradingView tools table under "All 45 MCP Tools", a `data_source="tradingview"` note in the backtest section, and the version badge to v0.10.0. Two notes that the bridge made untrue were rewritten: the "no TradingView account / Python-only, no npm package" wording.
- `SECURITY.md`: supported versions now 0.10.x, and the scope note now lists the cookie variables. New "Node bridge (`bridge/`)" section.
- `CHANGELOG.md`: `## [0.10.0] - 2026-10-10` entry above 0.9.0 (Added, Changed, Infrastructure). The existing `[Unreleased]` block is untouched.
- `docs/tradingview-session.md` (new): what the cookies are, how to copy them, where to put them (`.env`, `TRADINGVIEW_ENV_FILE`, `docker run --env-file`), restart after editing, risks, data-delay check, `tv_status` (which does not validate cookies), the 60 s auth cool-down, revocation, Node setup.
- `.env.example`: this file was already tracked, with Marketaux and proxy settings. I added a TradingView block at the top and kept the existing content. It has names and empty values only. `git check-ignore -v .env.example` reports it is NOT ignored (exit 1).
- `docs/handoffs/phase-4.md`: this report.

### Docker status
- **Not built.** The Docker daemon is not reachable in this environment, so `docker build` and the `/health` check were not run. Nothing was started.
- Checked by reading and by emulation instead:
  - The bridge stage was emulated in a scratch directory. The `npm ci --ignore-scripts --omit=dev` step exited 0 with 0 vulnerabilities, and `@mathieuc/tradingview` was installed.
  - The bridge health probe with a cleared environment (no credentials) printed exactly one line: `{"id":1,"result":{"ok":true,"libVersion":"4.0.0","node":"v22.22.0","hasCredentials":false}}`, exit 0.
  - `ldd` on the Node 22.22.0 binary shows it needs only libc, libm, libdl, libpthread, libstdc++ and libgcc_s. Debian bookworm base images provide these, and no libatomic is needed. That is by inspection of the host binary, not of the image. The new `RUN node --version` line makes a missing library fail the build instead of failing at run time.
- Still to check on WSL: `docker build -t tvmcp-test .`, then `docker run` with and without `--env-file` and a `/health` request.

### Tool count used
- `uv run --frozen python -c "from tradingview_mcp import server; print(len(server.mcp._tool_manager.list_tools()))"` prints **45**. That is 39 existing tools plus the 6 `tv_*` tools.
- The README said 37 before this phase. The count was already out of date (39 non-`tv_*` tools exist), so I used 45 for self-host.
- Left as published: the hosted-service claims "all 37 tools" (README lines 8 and 67). I cannot verify the hosted server's tool list from here. Adham should confirm them.

### Real check outputs
- `uv run --frozen pytest tests/unit -q`, Node visible: `777 passed in 11.88s`
- `PATH=/usr/bin:/bin uv run --frozen pytest tests/unit -q`, Node hidden: `777 passed in 11.66s`
- `cd bridge && npm test`:
  ```
  # tests 296
  # suites 0
  # pass 296
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 2380.355764
  ```
- `cd bridge && npm audit --omit=dev --audit-level=high`: `found 0 vulnerabilities`, exit 0.
- YAML: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/test.yml'))"` succeeded (PyYAML is available), and the `bridge` job parses with 5 steps and matrix `['20', '22']`.
- `git check-ignore -v .env.example`: no output, exit 1, so it is not ignored.
- A transient unit failure occurred during the run, from another agent's uncommitted `tv_data_service.py` change (`StubClient` had no `cooling_down`). It disappeared once that work settled. The final two runs above are clean.

### Things the reviewer should know
1. **My edits are already in commit `acb5baf`** ("WIP snapshot: phase 3/5 reviews and phase 4 in progress"). Another agent made that snapshot. I did not commit, push, stash, reset or checkout anything.
2. **`uv.lock` (not on the list).** The project version is stored in `uv.lock`. After the bump, `uv` rewrites the lock (version line and revision 2→3). I restored `uv.lock` to its committed content. Run `uv lock` to refresh the version line deliberately. CI's `uv sync --dev` (no `--locked`) will also rewrite it.
3. **Other version strings still say 0.9.0** and were not in the brief: `server.json` and `.codex-plugin/plugin.json`. Update them together with the pyproject bump, or decide not to.
4. **SECURITY.md support table.** I moved 0.9.x out of support, following the file's own "only the latest minor release" rule. This is a policy call. Adham should confirm it.
5. **README security notice.** I rewrote the "Python-only, no official npm package" wording. The repo now ships `bridge/package.json`, so the old wording would have been false. The root `package.json` warning about impersonating copies is kept.
6. **Dockerfile `RUN node --version`.** This line is not in the brief. It is a build-time guard for the copied Node binary.
7. **`.env.example`** was already tracked. I extended it rather than creating it new, so the Marketaux and proxy settings are kept.
8. The `bridge` CI job runs `npm audit` against the live registry. It passed here (0 vulnerabilities). A new advisory would fail the job by design.
9. Not verified: live `tv_*` calls with real cookies (Adham only, per STATUS).

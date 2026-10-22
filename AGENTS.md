# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Antigravity) working in this repo. A person reading this should start with `README.md` and `docs/handoffs/STATUS.md`.

## What this is
Adham's fork (`adhfult/tradingview-mcp`) of `atilaahmettaner/tradingview-mcp`. Three layers, in this order of dependence:

| Layer | Where | What it does |
|---|---|---|
| MCP server | `src/tradingview_mcp/` (Python, FastMCP) | Market-data and analysis tools for AI clients: screeners, indicators, Yahoo data, backtests, the `tv_*` tools, the strategy gauntlet, the paper trader, Pyne scripts, ten analysis prompts (`core/prompts.py`). |
| Node bridge | `bridge/server.mjs`, `bridge/lib/` | Talks to TradingView over its websocket with `@mathieuc/tradingview`. The Python side calls it as a helper process (`core/services/tv_bridge_client.py`). |
| Watcher | `bridge/watcher.mjs` | Always-on process (a systemd service on a Raspberry Pi): streams, rules, alerts to Telegram or Discord, local API, dashboard, alert images, news digests. |

**Nothing here places trades.** The watcher sends alerts; the paper trader simulates. A test checks the paper trader's source for order calls. Keep it that way.

## Where things are written down
- `docs/handoffs/STATUS.md`: single source of truth for what is done, in progress and blocked.
- `docs/plans/`: master plan (`tradingview-api-integration.md`) and the news-monitor plan.
- `docs/handoffs/*.md`: one report per piece (brief, review findings, decisions, limits).
- `bridge/README.md`: watcher config, every option, news sources and their terms.
- `.claude/handoffs/` is git-ignored; it holds session resume notes.

## Checks (run the ones for what you touched; run both after touching `bridge/lib/redact.mjs`)
```bash
cd bridge && timeout 250 node --test            # bridge suite; bare `node --test`, not `node --test <dir>` (the dir form reports a false failure)
env -u PYTHONDONTWRITEBYTECODE uv run --extra pine pytest tests/unit -q   # Python suite; unset the variable, a set one hid a CI failure once
node bridge/watcher.mjs --config bridge/watcher.config.example.json --check-config   # must print OK
```
CI runs the same suites (`.github/workflows/test.yml`) plus `npm audit --omit=dev --audit-level=high`.

## Rules that have bitten before
- **Tests first.** Write the failing test, then the code. Untrusted input (feeds, headlines, URLs) gets a hostile-input test.
- **Python and JS keep twins.** `core/services/tv_bridge_client.py` `_SECRET_ENV_VARS` must equal `SECRET_ENV_VARS` in `bridge/lib/redact.mjs`, in the same order; a test enforces it. A new secret variable goes in both.
- **Secrets.** Never read, print or commit `.env` files, keys or tokens. The watcher reads them from `/etc/tradingview-watcher.env` (mode 600) and redacts them from logs. Prompts for secrets use hidden input (`scripts/pi-setup.sh`).
- **Fake-clock tests.** Many watcher tests use a fake clock. `stop()` waits for in-flight work with a timer on that clock, so a test must advance the clock until `stop()` returns, not once. Remove temp dirs with `maxRetries`.
- **Never push or deploy without the owner's yes.** Push to `origin` only. The Pi is deployed with `scripts/pi-setup.sh` after a clean overnight reading of `/health` (`uptime_s` above about 28800, all streams healthy, no disconnects) and the `pre-ship-security` check.
- **Pi limits.** Anything that runs there must work on arm64 with the watcher's `MemoryMax=512M`; the watcher used about 104 MB on the Pi before the news code (measured 2026-10-22 with `ps`). Measure before and after.
- **External sources.** Check the terms and `robots.txt` before adding or enabling one (see the table in `bridge/README.md`). Yahoo, Google News and Nasdaq are off for that reason.
- **Do not edit the same file from two agents,** and ignore the untracked `HANDOFF.md` and `HANDOFF-P0-old.md` in the repo root.

## Style
Boring, widely used libraries over clever ones. Exact pins and a recorded licence for every new dependency (list in `STATUS.md`). Small commits whose messages say what changed and why.

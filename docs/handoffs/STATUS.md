# Build status (single source of truth for resuming)

- **Master plan:** `docs/plans/tradingview-api-integration.md`
- **Branch:** `claude/lucid-bardeen-3ou62p` (all work is pushed here; no PR yet)
- **Pipeline per phase:**
  1. Opus brief
  2. Haiku implementation
  3. Sonnet review and fixes
  4. Fable advisory review
  5. Opus verification, commit and push
- **Per-phase handoff docs:** `docs/handoffs/phase-*.md`, each with a brief, implementation report, review report, advisor notes and verification.
- **Baseline before any changes:** 382 unit tests passing (`uv run pytest tests/unit -q`).

## Phase table
| Phase | Status | Commits | Unit tests | Notes |
|---|---|---|---|---|
| 0: data freshness | in progress (brief written) | – | – | – |
| 1: Node bridge | not started | – | – | – |
| 2: Python bridge client | not started | – | – | – |
| 3: tv_* tools + wiring | not started | – | – | – |
| 4: packaging/Docker/CI/docs | not started | – | – | – |
| 5: watcher | not started | – | – | – |
| 6a: gauntlet | not started | – | – | – |
| 6b: paper trader | not started | – | – | – |
| 7a: dashboard | not started | – | – | – |
| 7b: alert images | not started | – | – | – |
| 7c: PyneCore | not started | – | – | – |

## Current step
Phase 0, step 2: Haiku implements `docs/handoffs/phase-0.md`.

## Approved dependencies
- `@mathieuc/tradingview` 4.0.0 (ISC)
- `lightweight-charts` 5.2.1 (Apache-2.0)
- `playwright-core` (Apache-2.0)
- `pynesys-pynecore` (licence to be verified, then recorded here)
- Others are allowed if they improve accuracy and consistency. Each must have an exact pin and a recorded licence.

## Decisions made during the build
- (none yet)

## Deviations from the master plan
- (none yet)

## Open issues / follow-ups
- (none yet)

## Checks only Adham can run (not possible in the cloud session)
- Live `tv_*` calls with TradingView cookies in `.env`.
- Discord / Telegram delivery (`node bridge/watcher.mjs --test-notify`).
- Raspberry Pi deployment and the systemd restart test.
- `docker build .` + `/health` (if the cloud session couldn't reach a Docker daemon).

## Resume in WSL
```bash
cd ~/code/tradingview-mcp && git fetch origin && git checkout claude/lucid-bardeen-3ou62p && git pull && claude
```
Paste:
> Read docs/handoffs/STATUS.md and docs/plans/tradingview-api-integration.md, then continue from the "Current step", using the same per-phase loop and the rules in the phase briefs.

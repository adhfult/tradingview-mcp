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
| 0: data freshness | **done** | 82ef2f8, ae1b011, (advisor fixes) | 422 pass (with and without Node) | Fable: no must-fix |
| 1: Node bridge | review done, Fable advising | db46a6f, 073a9ff | bridge 65/65 | Sonnet fixed stdout leaks, dead-client reuse, hung calls, validation |
| 2: Python bridge client | implemented, Sonnet reviewing | 0e3430e | 483 pass (with and without Node) | – |
| 3: tv_* tools + wiring | not started | – | – | – |
| 4: packaging/Docker/CI/docs | not started | – | – | – |
| 5: watcher | not started | – | – | – |
| 6a: gauntlet | not started | – | – | – |
| 6b: paper trader | not started | – | – | – |
| 7a: dashboard | not started | – | – | – |
| 7b: alert images | not started | – | – | – |
| 7c: PyneCore | not started | – | – | – |

## Current step
- Phase 1: waiting for Fable's advice, then apply must/should-fix.
- Phase 2: Sonnet review in progress, then Fable.
- Next: Phase 3 (Haiku), brief at `docs/handoffs/phase-3.md`.
- Briefs already written: phases 3, 4, 5, 6a.

## Approved dependencies
- `@mathieuc/tradingview` 4.0.0 (ISC)
- `lightweight-charts` 5.2.1 (Apache-2.0)
- `playwright-core` (Apache-2.0)
- `pynesys-pynecore` (licence to be verified, then recorded here)
- Others are allowed if they improve accuracy and consistency. Each must have an exact pin and a recorded licence.

## Decisions made during the build
- `data_freshness.as_of_utc` / `age_seconds` = **fetch time** everywhere, never market time (Phase 0).
- Error results (dicts with `error`) never get `data_freshness` (Phase 0).
- `ThreadPoolExecutor` sites must submit via `contextvars.copy_context().run` (Phase 0, `smart_money_service.py`).

## Deviations from the master plan
- (none yet)

## Open issues / follow-ups
- Phase 3: `tv_*` tools must use `freshness.record(...)`, not hand-built `data_freshness`. Decide how `auth` rolls up across mixed sources. Add the auth flag to screener cache keys.
- Phase 5: the watcher opens one freshness collection per tick, never one for the whole loop.

## Checks only Adham can run (not possible in the cloud session)
- The Docker daemon is not reachable in the cloud session, so Docker build checks are deferred to WSL.
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

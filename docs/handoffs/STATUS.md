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
| 1: Node bridge | **done** | db46a6f, 073a9ff, 4902604 | bridge 74/74 | auth cool-down, lib/client.mjs |
| 2: Python bridge client | **done** | 0e3430e, de65a73, (advisor fixes) | 541 pass + 16 advisor tests | .dockerignore .env leak fixed |
| 3: tv_* tools + wiring | **done** | 002d8dd, 8a1afef, bb32bcc | 812 pass | Yahoo parity pinned; in-flight cap; backtest follow-ups carried into the 6a review |
| 4: packaging/Docker/CI/docs | **done** | 2264f50, 154dbfc, d6b5509 | 812 pass | .env.example safe defaults; Docker build deferred to WSL |
| 5: watcher | **done** | 83e48a1, WIP snapshots, (advisor fixes) | bridge 344 pass | Fable: one README must-fix (Node path) applied; Pi-only checks below |
| 6a: gauntlet | PARTIAL (steps 0–4 and 6 done) | WIP | 812 pass | next: gauntlet_service, tools/prompts, tests; see the end of phase-6a.md |
| 6b: paper trader | not started | – | – | – |
| 7a: dashboard | not started | – | – | – |
| 7b: alert images | not started | – | – | – |
| 7c: PyneCore | not started | – | – | – |

## Current step (2026-10-11)
Phase 5 is done (bridge 344 pass, Python 812 pass).
1. **Phase 6a:** finish steps 5, 7 and 8 of `docs/handoffs/phase-6a.md` (see "Status at the handoff" at its end). Then a Sonnet review, which must also do the "Carried in from the Phase 3 advisor" items, then Fable.
2. **Then** 6b (`phase-6b.md`), 7a, 7b, 7c (`phase-7.md`), each with the same loop: Haiku → Sonnet → Fable → verify, commit, push.
3. **Finally:** the checks in "Checks only Adham can run" and the Pi checklist.

## Approved dependencies
- `@mathieuc/tradingview` 4.0.0 (ISC)
- `lightweight-charts` 5.2.1 (Apache-2.0)
- `playwright-core` (Apache-2.0)
- `pynesys-pynecore` (licence to be verified, then recorded here)
- Others are allowed if they improve accuracy and consistency. Each must have an exact pin and a recorded licence.

## Decisions made during the build
- `data_freshness.as_of_utc` / `age_seconds` = **fetch time** everywhere, never market time (Phase 0).
- Error results (dicts with `error`) never get `data_freshness` (Phase 0).
- Phase 6a may add only the documented **additive** keys to default backtest output (`trades_per_year`, `gross_return_pct`, `net_return_pct`, `cost_drag_pct`, `cost_warnings`, `tradability`; `multiple_testing_warning` in compare). The Yahoo parity digest excludes exactly those keys. Every pre-existing key stays byte-identical, and pinned numbers are unchanged. (Opus decision, option A.)
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

## Before deploying the watcher on the Pi (from the Phase 5 advisor)
- Run **anonymous (no cookies) for 24h first**; crypto is real-time anonymously. Add cookies only once `connection_drops` in `/health` stays stable. The desktop MCP and the Pi may log each other out when they share the same cookie.
- `which node` must be `/usr/bin/node` (not nvm).
- Run `mkdir -p ~/.local/state/tradingview-watcher` and `chmod 600 /etc/tradingview-watcher.env`. Never commit `watcher.config.json`.
- Run `--check-config`, then `--test-notify`, then `--dry-run` for an hour, watching `journalctl -u tradingview-watcher -f` for `disconnected at` lines.
- For day one, set `alerts.max_per_hour` to 10 and `trending.enabled=false`.
- Run `sudo systemctl stop tradingview-watcher` once and confirm the "stopped" log line and exit 0.
- After a night, check `curl 127.0.0.1:8787/health` shows `healthy == total`.
- `systemctl is-active systemd-timesyncd` (the clock-sync wait only really waits with timesyncd).
- `cat /sys/fs/cgroup/system.slice/tradingview-watcher.service/memory.max` prints `536870912`; if not, the memory cgroup is off: add `cgroup_enable=memory cgroup_memory=1` to `/boot/firmware/cmdline.txt` and reboot.

## Resume in WSL
```bash
cd ~/code/tradingview-mcp && git fetch origin && git checkout claude/lucid-bardeen-3ou62p && git pull && claude
```
Paste:
> Read docs/handoffs/STATUS.md and docs/plans/tradingview-api-integration.md, then continue from the "Current step", using the same per-phase loop and the rules in the phase briefs.

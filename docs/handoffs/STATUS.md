# Build status (single source of truth for resuming)

- **Master plan:** `docs/plans/tradingview-api-integration.md`
- **Branch:** `claude/lucid-bardeen-3ou62p` (local commits since Phase 5 are not pushed; no PR yet)
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
| 6a: gauntlet | **done** | 8406891, 5d88359, 9d7fcab, d736b48, a6210f7, (warm-up fix) | 955 pass | Luna 9 fixed/1 dismissed; Fable 1 fixed; live TradingView run still to do |
| 6b: paper trader | **done** | 59d4092, f374753, a01f477, 7ae0ec8, 7317b6d, 4cd0c90, a851ade | python 1024 pass | Fable + Luna Max reviews fixed: events lost in a >3-bar outage, `WATCHER_LOCAL_PORT` token redirect, zero-trade strategies, a vacuous test. Never places orders (a test checks the source). Details in `phase-6b.md` |
| W1: watcher daily cap + expiry | **done** | 4d552f3, a2868fc, 828a8b1, 639c4f0 | bridge 377 pass | `max_per_day` + `expires` per rule. Fable + Luna Max fixed 4 findings (held alerts using the cap with `digest_after_quiet` off, `tick()` pruning future-dated counts, `__proto__` rule id, a weak test). Details in `watcher-w1.md` |
| W2: watcher calendar gating | **done** | 531ca61, 5ca3437, 2c5178b | bridge 404 pass | `calendar: us_session` per rule, gated on the closed bar's open, 2027 holidays, stale-list warning. Fable + Luna Max both found the gate dropped the last bar of each stock session (`closeTime` is the next candle's open); fixed with gapped-stream tests. Details in `watcher-w2.md` |
| W3: watcher AND/OR rules | **done** | b472d54 .. see `git log` | bridge 429 pass | `all_of` / `any_of` over plain rules, one level. Fable + Luna Max found 3 real issues (dedupe key lacked direction, member expiry/calendar bypassed in composites, dead bars check), all fixed with tests that failed first. Details in `watcher-w3.md` |
| 7a P1: dashboard server | **done** | 36a9ddc .. b66a2f5 | bridge 519 pass | Read-only server with auth, headers, SSE, journals. Reviewed (Fable + Codex Sol); FIFO-safe bounded reads, no double response. Details in `phase-7a-p1.md` |
| 7a P2: dashboard page | **done** | 7639fb6 .. 35774ec | bridge 531 pass | `index.html`, `style.css`, `app.mjs`, design tokens; CSP-clean (chart logo off, footer notice). Details in `phase-7a-p2.md` |
| 7a P3: Obsidian notes layer | **done** | 733ac46 .. a88a29d | bridge 594 pass | `frontmatter.mjs`, `notes.mjs`, `/api/notes`, `dashboard.notes` (off by default), notes panel, markers, "Add note here", deep link. Fable + Codex Sol found about 20 issues (quadratic regexes, uncapped title, YAML escapes, keyboard note creation, stale add-note link), all fixed with tests first. Details in `phase-7a-p3.md` |
| 7a P4: extra panels | not started | – | – | Design section 9 (B1-B11); B6 last, as its own commit |
| 7b: alert images | not started | – | – | – |
| 7c: PyneCore | not started | – | – | – |

## Current step (2026-10-13)
Phases 0-6b, watchers W1-W3 and dashboard pieces 7a P1-P3 are done on this branch (bridge 594 pass). Pushed to origin through W2 (f06e840); everything after that (W3 and 7a P1-P3, 48 commits) is local, and the user said to hold the push until the work is done.
1. **Next piece** (state the regime line first, see `docs/plans/panwatch-ideas-and-pi-footprint.md`): 7a **P4** extra panels (`phase-7a-design.md` section 9, regime 3), then 7b. W4 (backup data source) needs a new Opus High plan-mode session and a night of the watcher on the Pi first.
2. Then 7a, 7b, 7c (`phase-7.md`). W4 (ccxt backup source) starts with a new Opus High plan-mode session, and only after the watcher has run a night on the Pi.
3. **Finally:** the checks in "Checks only Adham can run" and the Pi checklist. Add: one live TradingView run of `strategy_gauntlet` (confirms the daily-bar `time` assumption in `drop_forming_bar`, which the paper trader also relies on) and one real use of the two prompts.
4. Paper trader limits to remember (`phase-6b.md`): paper drawdown uses realised exits while the backtest's is mark-to-market, so a deep dip inside a trade that recovers before exit could hide a divergence.

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
- W1: with `digest_after_quiet` on, N alerts held overnight use N cap slots but make one digest. If the clock steps back across midnight, a rule's daily counter is overwritten (see `watcher-w1.md`, known limits).

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

# Build status (single source of truth for resuming)

- **Master plan:** `docs/plans/tradingview-api-integration.md`
- **Branch:** `main` on the fork (`origin` = `adhfult/tradingview-mcp`; everything is pushed; the old `claude/lucid-bardeen-3ou62p` branch was merged and deleted on 2026-10-14)
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
| 7a P4: extra panels | **done** | b38420b .. d508f41 | bridge 678 pass | B1-B11 done: tabs, overview, health, opportunities, alerts tab, drawer, overlays, PNG, badges, and B6 rule noise preview (`selectActive` gate shared with the watcher, `/api/preview`, grey ghost arrows). Fable + Codex Sol + Luna Max reviews fixed: RSI history depth in the preview, cache invalidation, trending retention, stale-load races. Details in `phase-7a-p4.md` |
| 7b: alert images | **done** | ab7136d .. a0d431b | bridge 752 pass, 2 skipped | `images` block (off by default): PNG of the last 120 bars, alert arrow and rule level on Discord/Telegram, drawn by the dashboard `/render` page in an on-demand system Chromium; any failure falls back to text plus a dashboard link. Fable + Codex Sol + Luna Max found 10 issues (Chromium ran with no sandbox, orphan browsers on a slow launch, a refused photo dropped the alert, others), all fixed with tests first. 35 of 37 mutants killed. Pi speed and memory not measured. Details in `phase-7b.md` |
| 7c: PyneCore | **done** | ca64077 .. see `git log` | python 1145 pass (3.11-3.13 with the extra), 1120 pass on 3.10 | `strategy_gauntlet(strategy="pine:<name>")` runs a hand-written Pyne script through all gates plus a `lookahead` gate; optional extra `pine`; long only, market orders only, paper trader refuses it. Pyne EMA cross == built-in EMA cross trade for trade. Fable + Codex Sol found 10 issues (dates shifted by `calc_bars_count`, unhashed sibling toml, weak lookahead sampling, partial exits, fills away from the open, ...), all fixed tests first. 52 of 54 mutants killed. Pi speed unmeasured. Details in `phase-7c.md` |
| N0b: tool probe (OpenBB, AlphaDesk, TradingAgents) | **done** | (docs only, see `git log`) | no code changed | Report `n0b-tool-probe.md`. OpenBB go-with-limits (1056 tools, 5.6 MB of schemas: use tool discovery; keyless SEC statements work), AlphaDesk no-go (keyless it is empty, AGPL), TradingAgents go-with-limits (about $0.017 and 17 calls per ticker on gpt-6-luna, needs a Chat Completions patch). Aperture checked: chat OK for luna, GLM 5.3 Flash, DeepSeek V4.1 Flash; `/responses` gives 402. |
| N4: sec_fundamentals tool | **closed, not built** | (this commit) | n/a | The brief's condition is not met: OpenBB's `sec` provider returns income statement (5 annual periods with EPS, shares, dividends), balance sheet (debt, equity), cash flow (capex, buybacks), risk factors, MD&A and segment revenue with no key (see `n0b-tool-probe.md`). Price targets: OpenBB has `nasdaq_equity_estimates_price_target` and `_consensus` (names in `n0b-tool-names.txt`), not called yet; N3 prompts say 'not available' when a tool gives nothing. Reopen N4 only if a live call shows a figure the prompts need is missing. |
| N3: ten analysis prompts | **done** | (see `git log`) | python 1189 pass | `core/prompts.py`, 4 lines in `server.py`, render + drift + golden-text tests. Sol High built, Luna Max wrote the drift test, Fable reviewed (no must-fix; sector/dividend/screener wording and a golden-text guard fixed). Report `n3-prompts-report.md`. Not pushed. |

## Current step (2026-10-13)
Phases 0-6b, watchers W1-W3, dashboard pieces 7a P1-P4, 7b (alert images) and 7c (Pyne scripts) are done on this branch (bridge 752 pass; python 1145 pass). All of it is merged into `main` on the fork and CI there is green. The watcher has been live on the Pi since 2026-10-14 (set up with `scripts/pi-setup.sh`; Telegram only, anonymous TradingView).
1. **Next piece** (state the regime line first, see `docs/plans/panwatch-ideas-and-pi-footprint.md`): none of phase 7 is left. W4 (backup data source) needs a new Opus High plan-mode session and a night of the watcher on the Pi first.
2. W4 (ccxt backup source) starts with a new Opus High plan-mode session, and only after the watcher has run a night on the Pi.
2b. **News monitor, bigger watchlist, analysis prompts:** N0 (plan review) is **done** (2026-10-14). Approved plan: `docs/plans/news-monitor-and-analysis-prompts.md`; facts: `docs/plans/news-monitor-n0-findings.md`; Argon's review: `docs/plans/news-monitor-argon-plan.md`; build briefs: `docs/handoffs/briefs/n*.md`; handoff: `docs/handoffs/NEXT-news-monitor.md`. Order: N1a news core and N0b tool probe (OpenBB, AlphaDesk, TradingAgents) in parallel, then N3 prompts, N1b more sources, N4 (only if N0b says OpenBB cannot supply the fundamentals), N2 real-time wide tier, N6 Pi briefs, N7 TradingAgents research. Nothing is coded yet. Needs from Adham: the go for the first build sessions, the Aperture model chain and budget (N6, N7), and a clean night of the Pi watcher before N1a/N2.
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
- 7c on the Pi: `pip install '.[pine]'`, copy `docs/examples/pine/ema_cross.py` to `~/.tradingview-mcp/strategies/`, run one `strategy_gauntlet` with `pine:ema_cross`, time it.
- Discord / Telegram delivery (`node bridge/watcher.mjs --test-notify`).
- 7b on the Pi: `sudo apt install chromium`, set `images.enabled` and `images.chromium_path` (or `WATCHER_CHROMIUM_PATH`), measure memory with PSS (`/proc/<pid>/smaps_rollup`, not summed RSS), check the render fits the 3 GB budget, then send one alert with a picture to Discord and one to Telegram.
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

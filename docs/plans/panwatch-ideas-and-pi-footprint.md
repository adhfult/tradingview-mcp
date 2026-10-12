# Plan: PanWatch on the Pi + watcher improvements (regime mapping approved 2026-10-12; build order vs 6a still open)

Source: https://github.com/TNT-Likely/PanWatch (MIT, 2k stars, releases almost daily).
Findings come from the README, Dockerfile, requirements and a read-only shallow clone (nothing was run).

## Decisions already made (Adham, 2026-10-12)
- PanWatch: **measure the upstream image first**, no fork unless it is still too heavy.
- Watcher: port **all four** ideas (daily cap + expiry, calendar gating, AND/OR rules, backup data source).
- `ccxt` goes into the **Node watcher only**. `yfinance` is not added (the Python MCP already uses Yahoo).

## Part A: PanWatch on the Pi (separate service, no code in this repo)
What is heavy: the image installs TradingAgents (~115 packages), Playwright + Chromium libraries, WeasyPrint/xhtml2pdf and CJK fonts. In the source, all of these (and akshare) are imported **lazily inside functions**; only `apprise` is imported at start-up. So the cost is mostly **disk and build time**; RAM should stay modest unless those features are used. This is from reading code, not from running it.

Steps (on the Pi, by Adham; I will write the compose file and checklist):
1. `docker-compose.panwatch.yml` in `docs/` or `scripts/` (not the watcher's compose): official arm64 image, `PLAYWRIGHT_SKIP_BROWSER_INSTALL=1`, `TZ=America/New_York`, `mem_limit: 1g`, `restart: unless-stopped`, volume for `/app/data`, port bound to `127.0.0.1`.
2. In the app: US tickers only, AI off (or the local Ollama endpoint on a PC), TradingAgents agent not enabled, Telegram or webhook for alerts.
3. Measure for 24 h: `docker stats`, `docker image ls` (disk), and that US quotes arrive from Stooq/Yahoo/Sina.
4. Decision gate: if RAM stays under ~700 MB and the image fits on the SD card, keep upstream. Otherwise, a slim fork (own repo) that drops the heavy requirements and fonts.
Budget on the 4 GB Pi: PanWatch 1 GB + watcher 512 MB (`MemoryMax`) leaves headroom under the 3 GB rule.
Risks: the default timezone is Asia/Shanghai (must override); the upstream UI is Chinese-first (an English README exists, the app language is unchecked); auth is its own JWT login (set a strong password; keep it off the open network).

## Part B: Watcher changes (`bridge/`, one commit per item, in this order)
All changes need tests (node:test, existing fakes in `test/watcher/support.mjs`). No change to the TradingView stream lifecycle.

1. **Per-rule daily cap + expiry.** New optional rule fields `max_per_day` (int) and `expires` (date). Validate in `lib/config.mjs`/`lib/rules.mjs` (`RULE_SPECS`); enforce in `lib/alerts.mjs` next to cooldown (counter reset at local midnight in the configured timezone; saved in state). Tests: cap hit, reset at midnight, expired rule is skipped, bad values reported.
2. **Calendar gating.** Reuse `buildUsCalendar` / `isUsRegularHours` (`lib/scanner.mjs`). Option `us_session_only` per stock rule or alert group: hold or skip alerts when the US market is closed. Note: `DEFAULT_US_HOLIDAYS` currently lists only 2026-11-26 and 2026-12-25 and **must be extended for 2027** (config already allows overrides). Tests with a fixed clock.
3. **AND/OR combined rules.** New rule type `all_of` / `any_of` with a list of existing rule ids on the same symbol and timeframe; fires on the same closed bar. Keep nesting to one level. Extend `barsNeeded` and validation (reject unknown ids, cycles, mixed timeframes). Tests: both/either, missing bars, cooldown key includes direction.
4. **Backup data source (largest, last).** Separate short plan first. Sketch: `lib/fallback.mjs` polling REST candles with `ccxt` (crypto only, pinned exactly, licence MIT recorded in STATUS.md) when a stream has been silent past its threshold; stocks via Yahoo REST are a stretch goal and unofficial/rate-limited, so default off. Needs a decision on how fallback bars enter `stream.mjs` without double-evaluating (the `lastEvaluatedTime` guard already exists).

## Verification
- `npm test --prefix bridge` stays green and grows per item; `--check-config` prints `OK` with the example config.
- `uv run pytest tests/unit -q` unchanged (812).
- Mutation check per item (break the new logic in a scratch copy, confirm tests fail), as in Phase 5.
- Part A: Pi measurements recorded in `docs/handoffs/`.

## Regime per work piece (approved by Adham, 2026-10-12)
Regimes are defined in `~/.claude/skills/regime/regimes.md` (run `/regime <n> <task>`). One piece = one session = one start model. **Never switch models inside a session** (it rewrites the whole cache); finish the piece, `/handoff` if needed, then start the next piece fresh.

| Piece | Regime | Start with (model, effort) | Delegates | Check |
|---|---|---|---|---|
| P0 Commit this plan | – | any | – | `git status` clean |
| W1 Daily cap + expiry | 4 build, delegated | Sonnet 5.5 High | Luna Max (Codex worktree) or Haiku xhigh, one per sub-task, never both on the same files | I write and commit the failing tests first, then run them and read the diff |
| W2 Calendar gating | 4 | Sonnet 5.5 High | as W1 | as W1. Includes extending `DEFAULT_US_HOLIDAYS` to 2027 |
| W3 AND/OR rules | 3 build, main session | Sonnet 5.5 High | none (design work: cycles, mixed timeframes, validation) | Tests first; Opus advisor after the same error twice |
| W4a Backup data source: plan | 1 architecture | **Opus 5.5 High, plan mode** (new session) | Haiku xhigh for facts only (never the design) | Fable advisor before approval, since it is architectural |
| W4b Backup data source: build | 3 | Sonnet 5.5 High (new session) | none | Tests; the plan file from W4a |
| A1 PanWatch compose file + Pi checklist | 5 small edits / 12 docs | **Sonnet 5.5 Low** (new session) | none | Adham runs it on the Pi and records `docker stats` + image size |
| A2 Pi measurement review | 7 terminal work | Sonnet 5.5 High | none | Re-run the failing command on the Pi |
| 6a / 6b / 7a–c | 3 or 4, per its phase brief | Sonnet 5.5 High | per brief | per brief |
| Any bug found | 6 | Sonnet 5.5 High | only if a failing test already exists | Test passes; Opus advisor after 2 errors |
| End of every piece | 11 review | the session that built it | Fable review subagent on plan + diff; Luna Max second opinion (read-only); add Codex/agy review if it touches the local API, secrets or more than ~50 lines | Verify every finding before acting |

Each finished piece: log it with `python3 ~/dotfiles/scripts/regime_log.py add <regime> <lead> <delegate|none> <pass|partial|fail> <retries> <escalated y|n> "<piece>"` (pass only if the check ran).

### Reminder rule (standing, requested by Adham)
**Before starting any new work piece, Claude says in one line:** `Next piece: <name>. Regime <n>. Start with <model> <effort>. New session needed: yes/no. Delegates: <…>.` and waits for Adham to switch (or confirm the current session already matches) before editing anything. It also says so when a piece changes regime midway (for example a bug found while building).

## Order vs Phase 6a
Phase 6a (steps 5, 7, 8) is still the next planned work and is **not yet decided against**. Suggested order: P0, then 6a, then W1 → W2 → W3 (a small "Phase 5b"), A1/A2 whenever Adham has time on the Pi, W4a/W4b only after the watcher has run a night on the Pi.

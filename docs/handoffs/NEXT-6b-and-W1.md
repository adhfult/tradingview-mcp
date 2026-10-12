# Handoff: run Phase 6b and watcher W1 together

Written 2026-10-12 at base commit `5b5b0da` (pushed). Python 955 pass, bridge 344 pass at this commit.

**How "together" works:** two sessions in two git worktrees, in parallel. Rule from `docs/plans/panwatch-ideas-and-pi-footprint.md`: one piece = one session = one start model, never switch models inside a session. The pieces share no source files (Python paper trader vs Node watcher rules), so they cannot collide as long as neither edits `docs/handoffs/STATUS.md` (only the integrator, step C, does).

## Reminder lines (the plan's standing rule)
- **Piece A, Phase 6b (paper trader).** Regime 3 (build in the main session; regime 4 only for a sub-task with a runnable test). Start with **Sonnet 5.5 High**. New session: yes. Delegates: none by default; Luna Max or Haiku xhigh only for a bounded sub-task with a test, one worker per file.
- **Piece B, watcher W1 (per-rule daily cap + expiry).** Regime 4 (build, delegated). Start with **Sonnet 5.5 High**. New session: yes, separate from A. Delegates: Luna Max (Codex worktree) or Haiku xhigh for the tests-first sub-tasks; lead writes and commits the failing tests first.
- **End of each piece:** regime 11 wrap-up review (Fable subagent + Luna Max second opinion, both read-only, given the plan/brief path and a saved diff file, not the transcript). Verify every finding before fixing. Then log it with `python3 ~/dotfiles/scripts/regime_log.py add <regime> <lead> <delegate|none> <pass|partial|fail> <retries> <escalated y|n> "<piece>"`.

## Setup (once, from the main checkout)
```bash
cd ~/code/tradingview-mcp
git worktree add ../tvmcp-6b  -b claude/phase-6b   claude/lucid-bardeen-3ou62p
git worktree add ../tvmcp-w1  -b claude/watcher-w1 claude/lucid-bardeen-3ou62p
(cd ../tvmcp-6b && uv sync)
(cd ../tvmcp-w1 && npm ci --ignore-scripts --prefix bridge)
```
Then in two terminals: `cd ~/code/tvmcp-6b && claude` and `cd ~/code/tvmcp-w1 && claude`, each on Sonnet 5.5 High, and paste that piece's prompt below. (The handoff file is committed, so both worktrees contain it.)

Rules for both sessions: do not push (ask Adham first), do not touch `docs/handoffs/STATUS.md`, small commits that say what and why, show the actual error and a diagnosis before changing approach, same error twice means call the Opus advisor, never two agents on one file, never read secret files, no real orders or trades anywhere.

---

## A. Phase 6b: paper trader (worktree `~/code/tvmcp-6b`, branch `claude/phase-6b`)

**Paste as the first message:**
> Read `docs/handoffs/NEXT-6b-and-W1.md` section A and `docs/handoffs/phase-6b.md` (the brief). You are the lead (Sonnet 5.5 High), regime 3. Write the failing tests first (`tests/unit/services/test_paper_service.py`), commit them, then build `core/services/paper_service.py`, `paper.py`, the `pyproject.toml` script, `bridge/paper.service.example` and the README "Paper trading" section. First post a short step list (files and the command that proves each step) and wait for my go. Append your report to `docs/handoffs/phase-6b.md` under "## Implementation report". At the end run the regime-11 wrap-up review and log the outcome.

**What the brief does not tell you (verified against the code at `5b5b0da`):**
1. `verify_report(fp)` returns only `{exists, verdict, matches_current_code}`. The report JSON itself is `$TRADINGVIEW_MCP_HOME/gauntlet/<fp>.json`. Add a small `load_report(fp)` to `gauntlet_service.py` that reuses `verify_report`'s fingerprint check and symlink refusal, rather than rebuilding the path logic.
2. Report shape: `inputs` = `{symbol, tv_symbol, data_source, strategy, params (resolved), interval, period, fill, cost_profile, commission_pct, slippage_pct}`; `gates[]` each `{gate, status, reason, numbers}`; `bars` = `{count, date_from, date_to}`; plus `verdict`, `fingerprint`, `created_utc`. There is **no `trades_per_year` key**: derive expected trades per week from `gates` -> `enough_evidence` -> `numbers.trades` and `bars` (or `date_from`/`date_to`). Backtest max drawdown is `enough_evidence` -> `numbers.max_drawdown_pct`.
3. Refuse unless `inputs.data_source == "tradingview"` and `tv_symbol` is set, as the brief says.
4. `--latest-pass <strategy> <tv_symbol>` means: scan `gauntlet/log.jsonl` (lines are `{fingerprint, created_utc, symbol, strategy, verdict, passed, failed_gates}`; `symbol` holds the `tv_symbol` for TradingView runs), take the newest `passed` entry for that strategy and symbol, then run the same `verify_report` guard. A damaged log line must be skipped, as `gauntlet_stats` does.
5. Forming bar: TradingView candles from `tv_bars_to_candles` carry `time` (unix open seconds). `gauntlet_service._drop_forming_bar(candles, interval, now)` already drops a still-forming last bar. Reuse it (make it public or move it to a shared place); do not copy it. **Unverified:** it assumes a daily bar's `time` is its open and its close is `time + 86400`; confirm on live data when you can.
6. `_simulate(..., fill="next_open")` drops an entry on the last bar (no next open) and marks a last-bar exit `forced_exit`. So: **emit an exit event only for a non-forced exit**, and expect an entry to show up one bar after its signal. Say so in the README so nobody thinks it is late.
7. The stored verdict is a local file, not signed. `verify_report` is a guard against stale code or changed params, not a security boundary. Do not describe it as tamper-proof.
8. `/notify` limits from `bridge/lib/localapi.mjs`: title <= 200, body <= 2000, key <= 200 characters, level one of `info|up|down`, answers 202 / 400 / 401, bodies over 8 KB are refused. Truncate before sending; treat 4xx as "log and move on", never retry a 400/401 in a loop.
9. `TRADINGVIEW_MCP_HOME` handling lives in `gauntlet_service._gauntlet_dir`; create `paper/` the same way (0700 directory, files 0600, unique temp file + `os.replace` for anything rewritten, append for the journal). Journal lines that are damaged or not JSON objects must be skipped, not crash the loop.
10. Test import quirk: inside `tests/unit/services/` use relative imports for helpers (`from .test_backtest_snapshot import snapshot_candles`).

**Gates:** `uv run pytest tests/unit -q` (>= 955), `npm test --prefix bridge` (344), and the CLI `--once --dry-run` path against a stub client prints a notification with the word "hypothetical" and makes no network call.

---

## B. Watcher W1: per-rule daily cap + expiry (worktree `~/code/tvmcp-w1`, branch `claude/watcher-w1`)

**Paste as the first message:**
> Read `docs/handoffs/NEXT-6b-and-W1.md` section B and the W1 entry in `docs/plans/panwatch-ideas-and-pi-footprint.md`. You are the lead (Sonnet 5.5 High), regime 4. Write the failing tests first in `bridge/test/watcher/` and commit them, then implement. This touches more than two files, so first post a short step list (files, and the command that proves each step) and wait for my go. You may hand a bounded sub-task with a runnable test to one Luna Max or Haiku xhigh worker (never two workers on one file). Write your report to `docs/handoffs/watcher-w1.md`. At the end run the regime-11 wrap-up review and log the outcome.

**Design (decided; change only if the code disagrees):**
- Two optional fields on a rule: `max_per_day` (integer 1-1000) and `expires` (date `YYYY-MM-DD`). The config validator rejects unknown keys (typo guard), so they must be added to the allowed keys and validated; every bad value is reported with the others, as today.
- `expires`: the rule stops firing after the end of that day in the configured `timezone`. `--check-config` warns (does not fail) when a rule is already expired. An expired rule is skipped before evaluation, so it costs nothing.
- `max_per_day`: counted per rule id, across its symbols and timeframes, per local calendar day in the configured timezone. Over the cap, the alert is dropped with a log line (like a cooldown, not into the digest). Health alerts never count and are never capped.
- Count only alerts that were actually delivered or queued (after dedupe and cooldown), so a suppressed alert does not use up the cap.
- State: keep the counter in the saved state next to cooldowns (`{ruleId: {date, count}}`), prune days older than today, and save it the same way cooldowns are saved. Dry-run never writes state. A clock that stepped back must not lock a rule out (same future-time guard the cooldown code has).
- Where: validation in `bridge/lib/config.mjs` and `bridge/lib/rules.mjs`; enforcement in `bridge/lib/alerts.mjs` next to the cooldown check (`watcher.mjs` passes `ruleId` and the cap in the `submit` item, as it already passes `cooldownKey`). Add one example rule field to `bridge/watcher.config.example.json` and a short note to `bridge/README.md`.

**Tests (node:test, fakes from `bridge/test/watcher/support.mjs`):** cap reached then dropped; counter resets at local midnight (also across a DST change in New York); suppressed alerts do not use the cap; cap is per rule id; health alerts bypass; expired rule skipped and warned in `--check-config`; bad values reported with all other errors; a restart keeps the counter; dry-run writes nothing; clock stepped back. Do a mutation check on the enforcement and on the midnight reset (break it in a scratch copy, confirm a test fails).

**Gates:** `npm test --prefix bridge` (>= 344, 0 fail), `node bridge/watcher.mjs --config bridge/watcher.config.example.json --check-config` prints `OK`, `uv run pytest tests/unit -q` unchanged (955).

---

## C. Integrate (back in the main checkout, after both reports are written)
```bash
cd ~/code/tradingview-mcp
git fetch . claude/phase-6b claude/watcher-w1     # local refs are enough
git merge --no-ff claude/phase-6b
git merge --no-ff claude/watcher-w1
uv run pytest tests/unit -q && npm test --prefix bridge
```
Expected conflicts: none in source. Possible: `docs/handoffs/*` (each piece writes only its own file). The integrator then updates `docs/handoffs/STATUS.md` (rows 6b, and a line for W1; Current step -> W2 calendar gating, then 7a-7c), re-checks the gates, and asks Adham before pushing. Remove the worktrees afterwards: `git worktree remove ../tvmcp-6b && git worktree remove ../tvmcp-w1`.

## After these two
W2 calendar gating (regime 4), W3 AND/OR rules (regime 3, no delegates), then Phase 7a-7c; W4 (ccxt backup source) starts with a **new Opus High plan-mode session** and only after the watcher has run a night on the Pi. One live `strategy_gauntlet` run on TradingView data is still open (it confirms the daily-bar `time` assumption).

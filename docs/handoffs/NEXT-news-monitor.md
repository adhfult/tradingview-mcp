# Handoff: plan review for the news monitor, bigger watchlist and analysis prompts

Written 2026-10-14. Nothing is coded. The deliverable of this handoff is **a reviewed, approved plan** (piece N0). Plan file: `docs/plans/news-monitor-and-analysis-prompts.md` (a Sonnet draft; read it first, including **Appendix A: Adham's ten prompts, verbatim**).

## Reminder line (the standing rule)
**Next piece: N0, news monitor plan review. Regime 1 (architecture). Start with Opus 5.5 High in plan mode. New session needed: yes. Delegates: Haiku xhigh for fact-finding only (never the design); Fable advisor before approval, since it is architectural.**
Do not edit code in this session. Output: an updated plan file, the N0 findings file, and a go/no-go for N1.

## Where things stand
- Branch `main` of the fork (`origin` = `https://github.com/adhfult/tradingview-mcp`; there is no `upstream` remote). **Never push to anything but `origin`. Ask Adham before pushing.** A PR to the official repo was opened by accident once (closed); ignore any "create pull request" prompt.
- Phases 0 to 7c, watchers W1 to W3 are done and on `main`. CI on the fork is green. Gates: `timeout 250 npm test --prefix bridge` (752 pass, 2 skipped); `env -u PYTHONDONTWRITEBYTECODE uv run --extra pine pytest tests/unit -q` (1145 pass). Run Python tests with `PYTHONDONTWRITEBYTECODE` unset: Adham's shell has it set, which hid a CI failure.
- **The watcher is live on the Pi** (`adhfult@fultonpi`, Debian 13, Node 22 from NodeSource at `/usr/bin/node`, service `tradingview-watcher`, config `~/.config/tradingview-watcher/config.json`, secrets `/etc/tradingview-watcher.env`, Telegram channel set, anonymous TradingView, quiet hours 23:00 to 07:00 New York). It has run only a short time, so treat Pi behaviour as unmeasured. `scripts/pi-setup.sh` sets the Pi up (see `bridge/README.md`).
- Two untracked files sit in the repo root, `HANDOFF.md` and `HANDOFF-P0-old.md`. They are stale leftovers from earlier sessions, not part of this work. Leave them alone and ask Adham before deleting either; do not commit them.
- The Pi checks for 7b (Chromium pictures) and 7c (Pyne timing) are still open. Do not start N1 or N2 before the watcher has run a clean night.

## What this session should do
1. Read the plan, then the files it names: `bridge/lib/scanner.mjs`, `bridge/lib/state.mjs`, the `tick()` block in `bridge/watcher.mjs`, `bridge/lib/config.mjs` (how blocks are validated), `bridge/lib/format.mjs` and `notifiers.mjs` (how text is escaped), `docs/plans/panwatch-ideas-and-pi-footprint.md`.
2. Run **N0** from the plan: verify the SEC, RSS and TradingView facts against real documentation (sources and dates in a findings file, `docs/plans/news-monitor-n0-findings.md`). Delegate only the fact lookups. Verify any claim a subagent returns before it goes in the plan.
3. Decide **D0** (watcher module or PanWatch), **D1** to **D3**, and fix the plan where N0 shows it was wrong. Be honest about what is still unverified.
4. Ask Adham the five open questions at the end of the plan if they are still unanswered.
5. Get the Fable advisor's review of the plan, then ask Adham to approve. Then write the build briefs for N1, N3, N4, N2 (one per session) or say which should be dropped.

## Prompts
All prompts are in `docs/handoffs/PROMPTS-news-monitor.md`: **Prompt A** is the first message for the Opus planner session (it replaces any shorter version); **Prompt B** is the self-contained brief Adham pastes into the Gemini app for Gemini 4 Argon, an independent second planner (the brief is `docs/handoffs/briefs/news-argon-plan.md`; its reply is saved as `docs/plans/news-monitor-argon-plan.md`); **C** and **D** are the templates for the builders (GPT-6 Luna Max) and the reviewer (GPT-6.1 Sol High) after the plan is approved. The Opus session reads Argon's plan only after forming its own view. Adham's ten prompts are also in `docs/handoffs/briefs/news-ten-prompts.md`.

## Traps (from earlier sessions)
- `rm -rf` is blocked by a hook: use `mktemp -d`. A Bash command whose text mentions an env file (or an SSH key or cookies file) is blocked: create such files with the Write tool, and never read secrets.
- `inv.sh` is not executable: use `INV_FROM=claude bash ~/dotfiles/scripts/inv.sh ...` with `nohup`.
- Never let two subagents edit the same file. Subagents may not write memory notes; record what passes the 30-day test yourself.
- Commit before running mutation scripts that `git checkout`. A mutation script in the foreground can hit the 600 s tool limit: use `nohup`.
- Keep a session short: if the context passes about 250k tokens, finish the unit, write a handoff (`/handoff` or `session-exit.js --out <file>`) and tell Adham.

## After this piece
Order in the plan: **N1** (news poller) and **N3** (analysis prompts) can run in separate sessions on different files, then **N4** (`sec_fundamentals`), then **N2** (wide watchlist, only after a Pi measurement). Each piece: its own session, Sonnet 5.5 High, tests first, a `docs/handoffs/` report, a STATUS row, and the end-of-piece review (Fable subagent plus Luna Max, plus one cross-agent review for N1 and N4).

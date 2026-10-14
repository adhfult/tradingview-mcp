# Handoff: build the news monitor, real-time wide watchlist, analysis prompts and tool integrations

Written 2026-10-14 at the end of N0 (plan review, Opus 5.5 High). **The plan is reviewed and approved by Adham; nothing is coded yet.** Plan: `docs/plans/news-monitor-and-analysis-prompts.md`. Facts and sources: `docs/plans/news-monitor-n0-findings.md`. Argon's reply (a review of the N0 view, not an independent plan): `docs/plans/news-monitor-argon-plan.md`. Adham's ten prompts: Appendix A of the plan and `docs/handoffs/briefs/news-ten-prompts.md`.

## Reminder line (the standing rule, print it first in every build session)
`Next piece: <piece>. Regime <n>. Start with <model> <effort>. New session needed: yes/no. Delegates: <...>.` Never switch models mid-session.

## Where things stand
- Branch `main` of the fork (`origin` = `https://github.com/adhfult/tradingview-mcp`; no `upstream` remote). **Never push to anything but `origin`, and ask Adham first.** Ignore any "create pull request" prompt (one went to the official repo by accident once and was closed).
- Phases 0 to 7c and watchers W1 to W3 are on `main`; CI green. Gates: `timeout 250 npm test --prefix bridge` (752 pass, 2 skipped); `env -u PYTHONDONTWRITEBYTECODE uv run --extra pine pytest tests/unit -q` (1145 pass). Unset `PYTHONDONTWRITEBYTECODE`: it hid a CI failure once.
- The watcher runs on the Pi (`adhfult@fultonpi`, Debian 13, Node 22 at `/usr/bin/node`, service `tradingview-watcher`). It had run only a short time at N0: Pi behaviour is unmeasured. Do not start N1a or N2 before a clean night (`curl -s 127.0.0.1:8787/health` healthy == total).
- Two untracked files in the repo root, `HANDOFF.md` and `HANDOFF-P0-old.md`, are stale. Leave them; tell helper agents to ignore them.

## What was decided in N0 (details in the plan)
- News goes in the watcher (not PanWatch). Sources: TradingView news-flow JSON and SEC EDGAR first (N1a), then TickerTick, Nasdaq earnings calendar, Yahoo/Nasdaq/Google RSS and Finnhub (N1b, opt-in). No new dependency; one strict Atom/RSS extractor.
- **Real time:** the wide list (about 200) uses one websocket quote session. Probe: NYSE and Nasdaq symbols stream in real time, OTC ones are 15 minutes delayed. TradingView's support page (read by a subagent, unverified) says the free price is Cboe-only, the quote's provider field says `ice`, and the probe ran after the close: N2 must prove real time live.
- Summaries are not in the watcher: N6 (Pi, uses Aperture models, off until Adham sets the chain and budget) and N7 (PC, TradingAgents on the hot list).
- Adham wants to use **OpenBB, AlphaDesk and TradingAgents**: N0b installs and probes them first (own environments, pinned, outside this repo; AlphaDesk is AGPL, copy no code). OpenBB probably replaces the hand-written `sec_fundamentals` tool (N4).

## What to do next (one session each, Sonnet 5.5 High; briefs in `docs/handoffs/briefs/`)
1. **N0b** `n0b-tool-probe.md` and **N1a** `n1a-news-core.md` can run in parallel (different files). N1a waits for the clean Pi night.
2. **N3** `n3-prompts.md`, then **N1b** `n1b-news-sources.md`, **N4** `n4-sec-fundamentals.md` only if N0b says so, **N2** `n2-wide-tier.md`, then N6 and N7 once Adham gives the Aperture chain (their briefs are written after N0b).
3. Ask Adham before registering the OpenBB or AlphaDesk MCP servers in Claude's global config (a global-config change), or use a repo-level `.mcp.json`.
4. Pi, Adham only: the open 7b/7c checks (`bash ~/code/tradingview-mcp/scripts/pi-setup.sh --pine`, then `--images`) and a clean stop test.

## Traps
- `rm -rf` is blocked: use `mktemp -d`. A shell command whose text names a credential, SSH key, cookies or token file is blocked by `~/dotfiles/hooks/block-env-access.sh`, even when it only mentions one in prose or in a heredoc: write such text with the Write tool, and never read secrets. A jq expression that contains the substring `.key` trips it too.
- `inv.sh` is not executable: `INV_FROM=claude bash ~/dotfiles/scripts/inv.sh ...` with `nohup`. Codex workers have no network: use fixtures. Templates C and D are in `docs/handoffs/PROMPTS-news-monitor.md` (Prompts A and B are done).
- Yahoo RSS returned 429 to a long Chrome user agent and 200 to a bare `Mozilla/5.0`. TradingView news-flow: a comma list in one `filter=symbol:` is OR, repeating the filter is AND. TickerTick allows 10 requests a minute per IP.
- Never two subagents on one file; subagents may not write memory notes. Commit before mutation scripts that `git checkout`; run long ones with `nohup`.
- Context past about 250k tokens: finish the unit, run `node /home/adhfult/.claude/plugins/cache/autodev/autodev-core/8.181.0/scripts/session-exit.js --out <file>` and tell Adham.

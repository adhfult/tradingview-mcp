# Brief: independent plan for a news monitor on a Raspberry Pi (read-only)

You are an independent planner (Gemini 4 Argon). You will **not edit any file**. Your whole answer is printed as markdown on stdout. Another planner is working on the same request separately; the point of you is a second, independent view. **Do not read `docs/plans/news-monitor-and-analysis-prompts.md` or any `docs/plans/news-monitor-*` file before you have written your plan** (it would anchor you). When your plan is done, you may read it and add a section "Where I disagree with the other draft".

Ignore `HANDOFF.md` and `HANDOFF-P0-old.md` in the repo root: they are stale and unrelated. If a tool points you at a "newest handoff", that is the one it means; skip it.

## The project (read these, in this order)
- `README.md` (top) and `bridge/README.md` (the watcher: what it is, the Raspberry Pi setup, config, local API, dashboard).
- `bridge/watcher.mjs` (the `tick()` function and how the trending scan is scheduled), `bridge/lib/scanner.mjs` (a scheduled scan with a seen-list), `bridge/lib/state.mjs`, `bridge/lib/config.mjs`, `bridge/lib/alerts.mjs`, `bridge/lib/notifiers.mjs`, `bridge/lib/format.mjs`.
- `src/tradingview_mcp/server.py`: the MCP tools (search it for `financial_news`, `market_sentiment`, `tv_quotes`, `stock_options_unusual_activity`) and the two existing `@mcp.prompt()` functions.
- Facts: the watcher runs on a Raspberry Pi 400 (4 GB RAM, ARM64, Debian 13, Node 22), under systemd with a 512 MB memory cap. Alerts go to Telegram. It is alerts-only and never trades. Free tools only unless a paid one is clearly worth it. Prefer boring, widely used libraries over clever ones. Anything running on the Pi must work on arm64 and within about 3 GB.

## The request (Adham, the owner), in his words
1. Turn the Pi watcher into a **news monitor** too, checking news about businesses and stocks **about every 30 minutes**.
2. Monitor **way more stock options** (this may mean more stocks, or options contracts; the words are ambiguous: say which you think is meant, and plan for both briefly if it changes the design).
3. Add ten analysis prompts to the MCP server (exact texts are in `docs/handoffs/briefs/news-ten-prompts.md`).
4. Two repos were suggested as possible tools. Findings so far: `michaelshimeles/terminal-rs` is a desktop GUI app (not usable on a headless Pi); `h100envy/crawl-hive` is a Solana memecoin signal tool needing a paid key and a hosted service. You may check them yourself.

## What to produce
A plan, not code. Cover:
1. **Architecture:** where news polling lives (inside the watcher, or a separate service), sources you recommend and why, how items are deduplicated, how it reaches Telegram, how it fits quiet hours and alert caps, how a fresh start avoids flooding the channel.
2. **Scale:** how to watch about 200 tickers on this Pi without one live stream each; what to measure first.
3. **Safety:** feeds and headlines are untrusted text sent to Telegram and Discord; outbound fetching limits; XML parsing risks; rate-limit and terms-of-service rules of every source (verify them against the real documentation and cite the URL and date; do not rely on memory).
4. **The ten prompts:** how to turn them into MCP prompts; which of them the existing tools can actually back with data, and what data is missing; how to stop a model inventing numbers.
5. **Phases** with a runnable check for each, the order, and what must be measured on the Pi before it is trusted.
6. **Your answers to these questions**, with your reasoning: (a) stocks or options contracts? (b) how many tickers is reasonable? (c) free no-key sources only, or are free API keys worth it? (d) plain headlines, or AI summaries (and where would a model run)? (e) build it in the watcher, or adopt PanWatch (`TNT-Likely/PanWatch`, an open-source stock monitor)?
7. **Unverified list:** every claim you could not verify.

Be concrete and short. Say plainly where you are guessing. Start your answer with the line `ARGON INDEPENDENT PLAN`.

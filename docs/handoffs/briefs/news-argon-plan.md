# Brief: independent plan for a news monitor on a Raspberry Pi

Paste this whole file into the Gemini app (Gemini 4 Argon) as one message. You cannot open local files, so everything you need is below. You will not write code. Another planner is working on the same request separately; the point of you is a second, independent view. If you can open web links, the code is public (links at the end), but **do not look for or open any `docs/plans/` file**, because it would anchor you. Answer in about 1,500 words or less, as markdown, and start with the line `ARGON INDEPENDENT PLAN`.

## The project (summary, so you do not need the files)
- Repo: `github.com/adhfult/tradingview-mcp` (public, MIT). Two halves: a **Python MCP server** (`src/tradingview_mcp/server.py`, FastMCP) with about 50 read-only tools, and a **Node "watcher"** (`bridge/watcher.mjs`) that runs as a standalone process on a Raspberry Pi. The watcher is alerts-only and never trades.
- **Watcher today:** streams live candles from TradingView for a watchlist (anonymous login, 7 streams now; a configured cap of 25 streams), evaluates rules when each candle closes (percent move, volume spike, RSI cross, Bollinger break, new high/low, price level, AND/OR combinations), and runs a "what's trending" scan every N minutes (`bridge/lib/scanner.mjs`: fetch the hot lists, alert on symbols new to the list, remember them for `remember_hours`; the **first scan only remembers and sends nothing**, so a fresh start never floods the channel; new entries go out as one message per batch). Alerts go through one pipeline: dedupe key, per-rule cooldown, an hourly cap (`max_per_hour`), quiet hours (23:00 to 07:00 New York; alerts held in that window are sent as one digest), a send queue, then Telegram and/or Discord notifiers. Persistent state is a JSON file (a `seen` map with TTL pruning). The config is a JSON file validated at start; new optional blocks are **off by default**. It also serves a local API on 127.0.0.1:8787 (`/health`, and `POST /notify` with a bearer token) and a read-only dashboard on 127.0.0.1:8788.
- **MCP tools that matter here:** `financial_news` and `market_sentiment` (news via Marketaux, a licensed API whose free tier is small), `tv_quotes`, `tv_candles`, `tv_indicator`, `tv_hotlist`, `stock_screener`, `yahoo_price`, `stock_prices`, `stock_options_chain`, `stock_options_unusual_activity`, `multi_timeframe_analysis`, `combined_analysis`, `strategy_gauntlet`. The server already has two `@mcp.prompt()` functions (`strategy_builder`, `strategy_reviewer`).
- **Hardware and constraints:** the watcher runs on a Raspberry Pi 400 (4 GB RAM, ARM64, Debian 13, Node 22) under systemd with a **512 MB memory cap**; anything on the Pi must work on arm64 and within about 3 GB. Alerts go to Telegram. Free tools only unless a paid one is clearly worth it. Prefer boring, widely used libraries over clever ones. The owner is a student developer.

## The request (the owner, in his words)
1. Turn the Pi watcher into a **news monitor** too, checking news about businesses and stocks **about every 30 minutes**.
2. Monitor **way more stock options** (this may mean more stocks, or options contracts; the words are ambiguous: say which you think is meant, and plan for both briefly if it changes the design).
3. Add **ten analysis prompts** to the MCP server. The exact texts are listed at the end of this message.
4. Two repos were suggested as possible tools. Findings so far: `michaelshimeles/terminal-rs` is a desktop GUI app (not usable on a headless Pi); `h100envy/crawl-hive` is a Solana memecoin signal tool needing a paid key and a hosted service. You may check them yourself.

## What to produce
A plan, not code. Cover:
1. **Architecture:** where news polling lives (inside the watcher, or a separate service), the sources you recommend and why, how items are deduplicated, how it reaches Telegram, how it fits quiet hours and alert caps, how a fresh start avoids flooding the channel.
2. **Scale:** how to watch about 200 tickers on this Pi without one live stream each; what to measure first.
3. **Safety:** feeds and headlines are untrusted text sent to Telegram and Discord; outbound fetching limits; XML parsing risks; rate-limit and terms-of-service rules of every source. **Verify these against the real documentation and cite the URL and date; do not rely on memory.** If you cannot browse, say so plainly and mark them unverified.
4. **The ten prompts:** how to turn them into MCP prompts; which of them the existing tools can actually back with data, and what data is missing; how to stop a model inventing numbers.
5. **Phases** with a runnable check for each, the order, and what must be measured on the Pi before it is trusted.
6. **Your answers, with reasons:** (a) stocks or options contracts? (b) how many tickers is reasonable? (c) free no-key sources only, or are free API keys worth it? (d) plain headlines, or AI summaries (and where would a model run)? (e) build it in the watcher, or adopt PanWatch (`TNT-Likely/PanWatch`, an open-source stock monitor)?
7. **Unverified list:** every claim you could not verify.

Be concrete and short. Say plainly where you are guessing.

## Public code links (optional, only if you can open links)
- https://github.com/adhfult/tradingview-mcp/blob/main/bridge/lib/scanner.mjs
- https://github.com/adhfult/tradingview-mcp/blob/main/bridge/watcher.mjs
- https://github.com/adhfult/tradingview-mcp/blob/main/bridge/lib/alerts.mjs
- https://github.com/adhfult/tradingview-mcp/blob/main/bridge/watcher.config.example.json
- https://github.com/adhfult/tradingview-mcp/blob/main/src/tradingview_mcp/server.py

## The ten prompts, exactly as the owner wrote them
1. "Analyze [COMPANY/TICKER] as of [DATE] for a [TIME HORIZON] investor. Cover its business model, revenue, advantages, financial health, recent performance, 3 growth drivers, and 3 key risks. End with a simple 5-bullet summary."
2. "Evaluate [TICKER] using its latest results. Compare revenue, margins, EPS, free cash flow, cash, debt, ROE, and share count over [3/5] years. Show trends as improving/stable/weakening and flag one-time items or accounting concerns."
3. "Analyze [TICKER]'s latest earnings and call. Compare with last year, prior guidance, and analyst expectations. Explain beats/misses, margins, new guidance, management comments, and concerns. End with: 'What changed in the investment thesis?'"
4. Fair-Value Calculator: "Value [TICKER] using P/E, EV/EBITDA, P/S, FCF yield, and DCF. Compare with [PEERS] and its historical range. Create conservative, base, and optimistic ranges, showing key assumptions and sensitivities."
5. Stock Comparison: "Compare [TICKER 1], [TICKER 2], and [TICKER 3] over [TIME HORIZON]. Evaluate growth, profitability, balance sheet, cash flow, valuation, competitive advantage, management, and risk. Show evidence, key differences, and what could change the outcome."
6. Catalysts & Risks: "Map [TICKER]'s catalysts and risks over [6/12/24] months. For each, show timing, probability, impact, evidence, and metrics to monitor. Cover company, industry, regulatory, and macro factors, highlighting the 5 most important."
7. Bull, Base & Bear Cases: "Build bull, base, and bear cases for [TICKER] over [TIME HORIZON]. Include revenue, margin, valuation, catalysts, risks, and value ranges. End with 3 measurable signals showing which scenario is developing."
8. Technical Analysis: "Analyze [TICKER] over [TIME PERIOD] using verified price and volume data. Identify trend, support, resistance, moving averages, RSI, volume, and volatility. Create bullish/bearish scenarios with trigger and invalidation levels."
9. Investment Decision Checklist: "Assess [TICKER] for a [RISK LEVEL] investor with [TIME HORIZON], [PORTFOLIO SIZE],and [MAX LOSS]% limit. List key considerations, risks, unanswered questions metrics, thesis changes, and concentration risks. End with a neutral research summary.
10. Portfolio Risk Review: "Analyze my portfolio [HOLDINGS]. Assess diversification, concentration, sector exposure, correlations, risk, and key weaknesses. Identify potential gaps and stress-test the portfolio under different market scenarios."

# Plan: news monitor, bigger watchlist, analysis prompts

Status: **DRAFT, waiting for review and approval.** Written 2026-10-14 by Sonnet 5.5 at Adham's request. Per the regime table this is a piece N0 (Regime 1, architecture): it still needs an **Opus 5.5 High plan-mode** pass and a **Fable advisor** check before anything is built. Nothing in this plan is coded. Handoff: `docs/handoffs/NEXT-news-monitor.md`.

## The request (Adham, 2026-10-14)

1. Turn the Pi watcher into a **news monitor** too (news about companies and stocks, checked about every **30 minutes**).
2. Monitor **many more stocks** ("way more stock options": probably more stocks, see Open questions).
3. Add ten analysis prompts (business analysis, financial trends, earnings, fair value, comparison, catalysts and risks, bull/base/bear, technical, decision checklist, portfolio risk). **The exact wording is in Appendix A**; the design is in N3.
4. Look at two repos as possible tools: `michaelshimeles/terminal-rs` and `h100envy/crawl-hive`.

Adham's own closing line, verbatim: "And some other tools for monitoring news every 30 minutes about businesses and stock options as well." Note that "stock options" appears here and in the first line of his message; it is Open question 1.

## What was ruled out, and why

Both repos were read through a scraper (repo page only, **no code read**), so the verdicts rest on their README text.

| Repo | What it is | Verdict |
|---|---|---|
| terminal-rs | Rust desktop GUI terminal (needs a window and Vulkan/GL). Data: Yahoo (unofficial), Binance, Treasury, FRED, optional free Alpaca key, US Congress trade filings. | **Not usable on the Pi** (GUI, no headless mode, heavy to build). Its data-source list is a useful hint only. |
| crawl-hive | Solana memecoin signal swarm. Needs a paid xAI key and the hosted service for real data. README contradicts itself on whether its token launched; token incentives tied to paid signals. | **Skip.** Not company news, not local-first, and the red flags above. |

Unverified: licences and last-commit dates of both were not captured, and nothing was run.

## What already exists (reuse, do not rebuild)

- `bridge/lib/scanner.mjs`: a scheduled scan with a seen-list, `remember_hours`, "first scan only remembers, never floods", one message per batch. **The news poller copies this pattern.** Scheduling lives in `watcher.mjs` `tick()` (the `nextScanAt` / `scanInFlight` block).
- `bridge/lib/state.mjs`: persisted state (`seen`, `trending` buckets) with TTL pruning. News adds one bucket.
- Alert pipeline: `alerts.mjs` (cooldown, caps, quiet hours, digest), `queue.mjs`, `notifiers.mjs` (Telegram/Discord), `format.mjs`, `redact.mjs`, `deadline.mjs` (timeouts).
- `bridge/lib/config.mjs`: validation with warnings/errors; new blocks are **off by default** (as `images` and `dashboard.notes` are).
- Python MCP server (`src/tradingview_mcp/server.py`): tools `financial_news` and `market_sentiment` (Marketaux, free tier is small), `tv_quotes`, `tv_candles`, `tv_indicator`, `tv_hotlist`, `stock_screener`, `yahoo_price`, `stock_prices`, `stock_options_chain`, `stock_options_unusual_activity`, `multi_timeframe_analysis`, `combined_analysis`; two existing `@mcp.prompt()` functions (`strategy_builder`, `strategy_reviewer`, around `server.py:998`).
- **PanWatch** (`docs/plans/panwatch-ideas-and-pi-footprint.md`, Part A): an already-decided plan to *measure* PanWatch on the Pi. Its news and AI features were never checked. See decision D0.

## Decisions for Adham and the reviewing session

- **D0. Build news in the watcher, or use PanWatch?** Recommendation: **build a small news module in the watcher** (N1). It reuses one alert pipeline, one config, one Telegram channel, and stays small. Keep PanWatch's measurement (A1/A2) as a separate, optional task; do not make N1 depend on it. If the reviewer finds PanWatch already does 30-minute per-ticker news well and fits the Pi, drop N1 and write only N3 and N4.
- **D1. Sources.** Recommendation: **SEC EDGAR on by default** (official, free, no key); **RSS headline feeds opt-in** (unofficial, grey terms); a free-key news API (Finnhub is one candidate) only if Adham wants one. Every source is individually switchable.
- **D2. XML parsing.** Node has no built-in XML parser. Options: a small pinned MIT library (`fast-xml-parser`, boring, but a new dependency; check its advisories) or a strict hand parser for the two formats we need. Recommend the library with entity expansion off; the reviewer decides.
- **D3. Summaries.** Recommendation: **none in v1** (headline + link only). A Pi can run only a tiny model; Claude can summarise on demand through the prompts in N3.

## Assumptions made because the questions were not answered yet (correct me)

1. "Stock options" means **more stocks**, not options contracts. (Options contracts would be N5, below, and use an unofficial Yahoo endpoint.)
2. Target size: **about 200 tickers** in the wide list.
3. Free sources with **no key** first.
4. Plain headlines and links, **no AI summaries**.

## Phases

Order: **N0 research, N1, N3, N4, N2** (N5 only if asked). N3 is cheap and needs no Pi, so it can run in parallel with N1 in a separate session; never two sessions on the same file.

### N0. Verify before coding (research only, no repo changes)
Check against the real documentation and terms, not memory: SEC EDGAR access rules (fair-access request rate, required `User-Agent` with contact details, the current-filings feed URL and parameters, the ticker-to-CIK file, the XBRL `companyfacts` API); terms and rate limits of each RSS source; Finnhub or Marketaux free limits if D1 includes them; what PanWatch actually offers for news (D0); whether the TradingView anonymous connection can serve a batch quote poll for ~200 symbols (N2). Output: a short findings file with sources and dates. Use `doc-lookup` or `scraper` subagents (Haiku xhigh, facts only). Nothing below is verified until this is done.

### N1. News poller in the watcher (`bridge/lib/news.mjs`)
- **Config** (new `news` block, off by default): `enabled`, `every_minutes` (default 30, minimum 10), `remember_hours` (default 72), `max_items_per_digest`, `sources` (`sec_edgar`, `rss`, each with its own switch), `tickers_extra`, `include_keywords` / `exclude_keywords`, `sec_forms` (default `8-K`, `10-Q`, `10-K`). Which tickers: the watchlist's stock symbols plus `tickers_extra` plus the N2 wide list.
- **Per-ticker polling does not scale to 200.** For SEC, prefer the **broadcast feed of recent filings** (one request per form type), filtered by the watchlist's company ids, over one request per ticker. For RSS headlines, use tiers: the hot list is polled per ticker, the rest are skipped or rotated in small batches. Use conditional requests (ETag / If-Modified-Since) where supported. Every run has a hard request budget and a deadline.
- **Dedupe:** key per item (SEC accession number, or a hash of the normalised URL). **First run only remembers** (nothing is sent), as the trending scan does, so a fresh start or lost state file never floods the channel.
- **Delivery:** one digest per run (not one message per headline), through the existing alert pipeline so quiet hours, the hourly cap and the held-digest logic apply. Decide in review whether a news digest counts against `max_per_hour`.
- **Untrusted input:** headlines and feed text are attacker-controlled. Sanitise before sending: strip control characters, neutralise Discord mentions (`@everyone`, `@here`, role pings; use `allowed_mentions`), escape Telegram markup, cap lengths. Only `https` links, and only to hosts on a per-source allowlist. Cap response size, follow few redirects, parse with entity expansion off. Never log a full URL with a token; use `redact`.
- **Failure rules:** one source failing never stops the others or the watcher; an empty result or error means skip and log (no alert, no state change), like the trending scan.
- **Dashboard and health:** show last news run, items seen, source status in the existing health view (small, optional).
- **SEC contact:** the required contact string goes in the env file (`WATCHER_SEC_CONTACT`), never in the repo. `scripts/pi-setup.sh` gets an option to set it, using the same hidden-prompt writer as the Telegram secrets.
- **Tests (node:test, existing fakes in `test/watcher/support.mjs`):** first run remembers only; dedupe across runs; digest batching and cap; each source failing alone; hostile feed text (mentions, markup, huge fields, bad XML, entity bombs); URL allowlist; request budget; state pruning; config validation and `--check-config`.

### N2. Many more stocks
- A **two-tier list**: `hot` (streamed with candle-close rules, as now; limit is `limits.max_streams`, 25) and `wide` (about 200, **polled** for batch quotes every few minutes). Wide-tier rules are simple and cheap: % move versus the previous close and a volume spike, evaluated on each poll, never candle-close rules.
- Watchlist can be a plain text file (one `EXCHANGE:SYMBOL` per line) so editing it needs no JSON.
- **Measure on the Pi first:** RSS of the watcher with 7, 25 and 200 symbols; TradingView connection behaviour anonymously (rate limits, drops). Do not raise caps until measured. The watcher's `MemoryMax=512M` is the ceiling.
- Open design point for N0: which bridge call serves a batch quote for many symbols without one stream each.

### N3. The ten analysis prompts (MCP prompts, Python)
- New module (for example `src/tradingview_mcp/core/prompts.py`) registered from `server.py`, so `server.py` does not grow further. Each prompt takes parameters with defaults (`ticker`, `horizon`, `peers`, `years`, ...). Adham's ten texts are the core of each prompt, wrapped by a short common preamble.
- **Common rules baked into every prompt:** use the named tools for data; quote the tool and the as-of time for every number; if a number is not available from a tool, write "not available" instead of estimating from memory; keep the required ending (5-bullet summary, "What changed in the investment thesis?", three measurable signals, neutral research summary); one line that this is research, not personal financial advice. The portfolio and checklist prompts take holdings and limits as arguments; the MCP server is local stdio, so that text stays on the machine.
- **Data coverage today (to be verified in N0/review):**

| Prompt | Backed by existing tools | Gap |
|---|---|---|
| 1 Business analysis | news, quotes | business model, revenue, financial health |
| 2 Financial trends 3/5 y | none | statements (revenue, margins, EPS, FCF, cash, debt, ROE, share count) |
| 3 Earnings and call | `financial_news`, `market_sentiment` | call transcript, prior guidance, analyst estimates |
| 4 Fair value | quotes | multiples, EBITDA, FCF, DCF inputs, peer and historical ranges |
| 5 Comparison | `tv_quotes`, `yahoo_price`, `stock_screener` | fundamentals, management |
| 6 Catalysts and risks | news | earnings calendar, regulatory events |
| 7 Bull/base/bear | quotes | fundamentals |
| 8 Technical | **`tv_candles`, `tv_indicator`, `multi_timeframe_analysis`, `coin_analysis`** | none (fully covered) |
| 9 Decision checklist | quotes | mostly reasoning |
| 10 Portfolio risk | `tv_candles` per holding (correlation, volatility) | sector exposure |

  Only #8 is fully data-backed today; #10 and #5 partly. N4 closes most of the gap.
- **Tests (pytest):** every prompt is registered and renders with its defaults; each contains its required ending phrase; every tool name a prompt mentions exists in the registered tool list (guards against drift); a prompt with a bad argument type fails clearly.

### N4. `sec_fundamentals` tool (closes the data gap for prompts 1, 2, 4, 7)
- A read-only tool backed by SEC's **XBRL company-facts API** (official, free): revenue, net income, EPS, cash, debt, shares outstanding, operating cash flow and capex by fiscal year, for US filers. Pure stdlib (`urllib`), same style as `marketaux_service.py`; cached on disk; polite request rate and the required `User-Agent`. Known caveats the tool must state: XBRL tag names vary between companies, so a missing field is reported as missing, never guessed; non-US companies are not covered.
- This is **not** `yfinance` (that decision stands from the PanWatch plan).
- Python tests with recorded fixtures; one live check by Adham.

### N5. Optional, only if asked
- **Options contracts monitoring:** `stock_options_unusual_activity` exists as an MCP tool (Python, unofficial Yahoo data). A Node watcher poll would need its own fetch of an unofficial endpoint; default is out of scope.
- **AI summaries of news:** on demand through Claude (prompts), or a tiny local model on a PC; not on the Pi.

## Pi budget and safety (applies to N1 and N2)

- Whole watcher stays under `MemoryMax=512M`; record RSS before and after on the Pi (`/proc/<pid>/smaps_rollup`, PSS). Target: news adds well under 50 MB.
- Request budget per run and per hour is a config limit, with a hard cap in code. SEC rate rules are respected with margin; Yahoo/Google RSS are polled gently and can be switched off.
- No new secret is printed or logged. `WATCHER_SEC_CONTACT` is the only new env variable, set with the hidden-prompt writer.
- No trading. The watcher stays alerts-only.

## Verification

- `timeout 250 npm test --prefix bridge` stays green and grows (baseline 752 pass, 2 skipped). `--check-config` prints `OK` with the example config.
- `env -u PYTHONDONTWRITEBYTECODE uv run --extra pine pytest tests/unit -q` stays green (baseline 1145). **Unset `PYTHONDONTWRITEBYTECODE`**: it hid a CI failure once.
- Mutation check per piece (break the new logic in a scratch copy, confirm a test fails), as in Phase 5. Commit before running mutation scripts.
- CI on the fork must be green before a piece counts as done (`gh run list --repo adhfult/tradingview-mcp`).
- Pi: 24 hours observed after N1 and after N2; `curl 127.0.0.1:8787/health` shows `healthy == total`; no growth in memory.
- Reviews at the end of each piece: Fable subagent (plan + diff), Luna Max read-only second opinion, and one cross-agent review for N1 and N4 (outbound fetching and parsing of untrusted text).

## Regime per piece (proposal; Adham approves)

| Piece | Regime | Start with | Delegates | Check |
|---|---|---|---|---|
| N0 Plan review and research | 1 architecture | **Opus 5.5 High, plan mode** (new session) | Haiku xhigh for facts only | Fable advisor before approval |
| N1 News poller | 3 build | Sonnet 5.5 High (new session) | none | tests first; reviews as above |
| N3 Analysis prompts | 3 build | Sonnet 5.5 High (new session) | none | pytest; tool-name drift test |
| N4 `sec_fundamentals` | 3 build | Sonnet 5.5 High (new session) | none | fixtures; live check by Adham |
| N2 Wide watchlist | 3 build, after a Pi measurement | Sonnet 5.5 High (new session) | none | Pi RSS numbers recorded in `docs/handoffs/` |

Each finished piece is logged with `regime_log.py` and gets a `docs/handoffs/` report and a STATUS row, as in earlier phases.

## Open questions for Adham

1. "Stock options": more **stocks**, or options **contracts**? (Assumed: stocks.)
2. How many tickers (50, 200, 500)? (Assumed: 200.)
3. Free no-key sources only, or are free API keys acceptable? (Assumed: no key.)
4. Plain headlines, or AI-written summaries? (Assumed: plain.)
5. D0: build in the watcher (recommended) or evaluate PanWatch first?

## Appendix A. The ten prompts, exactly as Adham pasted them (2026-10-14)

These are his words. Do not paraphrase them when building N3; the placeholders in square brackets become prompt arguments. The pasted text had no headings on 1 to 3 (the names there are descriptive, not his), and had small typos, kept below: a missing space in prompt 9 (`[PORTFOLIO SIZE],and`) and an unclosed quote on prompt 9. The N3 build may fix typos and should say so in its report.

**1. Business analysis** (no heading given)
> "Analyze [COMPANY/TICKER] as of [DATE] for a [TIME HORIZON] investor. Cover its business model, revenue, advantages, financial health, recent performance, 3 growth drivers, and 3 key risks. End with a simple 5-bullet summary."

**2. Financial trends** (no heading given)
> "Evaluate [TICKER] using its latest results. Compare revenue, margins, EPS, free cash flow, cash, debt, ROE, and share count over [3/5] years. Show trends as improving/stable/weakening and flag one-time items or accounting concerns."

**3. Earnings and call** (no heading given)
> "Analyze [TICKER]'s latest earnings and call. Compare with last year, prior guidance, and analyst expectations. Explain beats/misses, margins, new guidance, management comments, and concerns. End with: 'What changed in the investment thesis?'"

**4. Fair-Value Calculator**
> "Value [TICKER] using P/E, EV/EBITDA, P/S, FCF yield, and DCF. Compare with [PEERS] and its historical range. Create conservative, base, and optimistic ranges, showing key assumptions and sensitivities."

**5. Stock Comparison**
> "Compare [TICKER 1], [TICKER 2], and [TICKER 3] over [TIME HORIZON]. Evaluate growth, profitability, balance sheet, cash flow, valuation, competitive advantage, management, and risk. Show evidence, key differences, and what could change the outcome."

**6. Catalysts & Risks**
> "Map [TICKER]'s catalysts and risks over [6/12/24] months. For each, show timing, probability, impact, evidence, and metrics to monitor. Cover company, industry, regulatory, and macro factors, highlighting the 5 most important."

**7. Bull, Base & Bear Cases**
> "Build bull, base, and bear cases for [TICKER] over [TIME HORIZON]. Include revenue, margin, valuation, catalysts, risks, and value ranges. End with 3 measurable signals showing which scenario is developing."

**8. Technical Analysis**
> "Analyze [TICKER] over [TIME PERIOD] using verified price and volume data. Identify trend, support, resistance, moving averages, RSI, volume, and volatility. Create bullish/bearish scenarios with trigger and invalidation levels."

**9. Investment Decision Checklist**
> "Assess [TICKER] for a [RISK LEVEL] investor with [TIME HORIZON], [PORTFOLIO SIZE],and [MAX LOSS]% limit. List key considerations, risks, unanswered questions metrics, thesis changes, and concentration risks. End with a neutral research summary.

**10. Portfolio Risk Review**
> "Analyze my portfolio [HOLDINGS]. Assess diversification, concentration, sector exposure, correlations, risk, and key weaknesses. Identify potential gaps and stress-test the portfolio under different market scenarios."

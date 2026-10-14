# Plan: news monitor, bigger watchlist, analysis prompts

Status: **REVIEWED in N0 (Opus 5.5 High, plan mode, Fable advisor, 2026-10-14); waiting for Adham's go on the first build session.** The draft below was written by Sonnet 5.5; sections changed by the review say so and the facts behind them are in `docs/plans/news-monitor-n0-findings.md`. Argon's reply (`docs/plans/news-monitor-argon-plan.md`) is a review of the N0 view, not an independent plan. Nothing in this plan is coded. Handoff: `docs/handoffs/NEXT-news-monitor.md`.

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

Nothing was run, and no code of either was read.

Checked 2026-10-14 (GitHub API): terminal-rs has no licence (`license: null`), so copy nothing from it; crawl-hive is MIT, last push 2026-10-13. PanWatch: see D0.


## What already exists (reuse, do not rebuild)

- `bridge/lib/scanner.mjs`: a scheduled scan with a seen-list, `remember_hours`, "first scan only remembers, never floods", one message per batch. **The news poller copies this pattern.** Scheduling lives in `watcher.mjs` `tick()` (the `nextScanAt` / `scanInFlight` block).
- `bridge/lib/state.mjs`: persisted state (`seen`, `trending` buckets) with TTL pruning. News adds one bucket.
- Alert pipeline: `alerts.mjs` (cooldown, caps, quiet hours, digest), `queue.mjs`, `notifiers.mjs` (Telegram/Discord), `format.mjs`, `redact.mjs`, `deadline.mjs` (timeouts).
- `bridge/lib/config.mjs`: validation with warnings/errors; new blocks are **off by default** (as `images` and `dashboard.notes` are).
- Python MCP server (`src/tradingview_mcp/server.py`): tools `financial_news` and `market_sentiment` (Marketaux, free tier is small), `tv_quotes`, `tv_candles`, `tv_indicator`, `tv_hotlist`, `stock_screener`, `yahoo_price`, `stock_prices`, `stock_options_chain`, `stock_options_unusual_activity`, `multi_timeframe_analysis`, `combined_analysis`; two existing `@mcp.prompt()` functions (`strategy_builder`, `strategy_reviewer`, around `server.py:998`).
- **PanWatch** (`docs/plans/panwatch-ideas-and-pi-footprint.md`, Part A): an already-decided plan to *measure* PanWatch on the Pi. Its news and AI features were never checked. See decision D0.

## Decisions (settled in N0, 2026-10-14)

- **D0. Build news in the watcher, not PanWatch.** PanWatch (`TNT-Likely/PanWatch`, MIT, pushed 2026-10-13) is an LLM report tool: a second Python + Node 24 stack that needs a model, with no documented per-ticker news poll. It does not replace a 30-minute headline digest. Its Pi measurement (A1/A2 in `docs/plans/panwatch-ideas-and-pi-footprint.md`) stays a separate optional task.
- **D1. Sources, by tier.** Every source has its own switch and a request budget per run, with a hard cap in code.
  - On by default: TradingView news-flow JSON (`news-mediator.tradingview.com/news-flow/v2/news`, chunks of about 50 symbols, comma = OR); SEC EDGAR `getcurrent` Atom for `8-K`, `10-Q`, `10-K` (3 requests, plus at most one `start=100` follow-up each); TickerTick `api.tickertick.com/feed?q=(or z:aapl ...)` (4 queries, spaced at least 7 s, its limit is 10 a minute per IP); Nasdaq earnings calendar once a day (`api.nasdaq.com/api/calendar/earnings?date=`).
  - Opt-in (off by default): Yahoo RSS (multi-ticker `s=`, back off on 429), Nasdaq per-symbol RSS and Google News RSS (hot list only, rotated, 10 or fewer per run; Google's notice limits the feed to personal feed readers), Finnhub (free key in the secrets file).
  - Cross-source dedupe by normalised URL, then by normalised title + ticker within 6 hours (the same Reuters story arrives through TradingView and TickerTick).
- **D2. No new dependency.** One strict extractor reads SEC Atom `<entry>` and RSS `<item>`: refuses `<!DOCTYPE` / `<!ENTITY`, decodes the five named entities and numeric references in a single pass, fixed field list, size caps. Never send SEC `summary` text (it carries escaped HTML); extract only the 8-K item numbers.
- **D3. No LLM inside the watcher.** Alerts must never depend on a model or a paid API being up. Summaries live in separate pieces: N6 (Pi) and N7 (PC).
- **D4. Third-party tools run on the PC, never on the Pi, never as dependencies of this repo.** OpenBB (Apache-2.0, `openbb-mcp-server`), AlphaDesk (AGPL-3.0, read-only MCP tools) and TradingAgents (Apache-2.0, multi-agent research) are each installed in their own environment (`uv tool` / `uvx`), pinned to an exact version. No code from AlphaDesk is copied into this MIT repo. See N0b.

## Adham's answers (2026-10-14)

1. "Stock options" means **more stocks**, not options contracts (N5 stays out).
2. About **200 tickers** in the wide list.
3. Sources: **more are wanted**. All the extra feeds above, off by default, plus free ones found on X and GitHub.
4. Summaries: **wanted, automatic**, using his **Aperture** models (the gateway behind `~/dotfiles/bin/ask`; he will give the provider order and what to do when one runs out) and the Codex and Claude subscriptions. Built as N6 and N7, not inside the watcher.
5. D0: build in the watcher.
6. **Real time, not 15-minute delayed.** Done through a websocket quote session (N2).
7. **Use TradingAgents, OpenBB and AlphaDesk.** See D4, N0b, N3, N4 and N7.

Still open: the Aperture model chain and daily spend for N6/N7; whether to register the OpenBB and AlphaDesk MCP servers in Claude's global config (a global-config change, so Adham approves it) or only in this repo's `.mcp.json`.

## Phases

Order: **N0 research, N1, N3, N4, N2** (N5 only if asked). N3 is cheap and needs no Pi, so it can run in parallel with N1 in a separate session; never two sessions on the same file.

Order (corrected in N0): **N1a and N0b in parallel, then N3, N1b, N4 if N0b says so, N2, N6, N7** (N5 only if asked). Details in the regime table.

### N0. Verify before coding: DONE (2026-10-14)
Findings, sources and dates: `docs/plans/news-monitor-n0-findings.md`. Open items are listed there under "Still unverified".

### N0b. Install and probe the three tools (research and setup, no repo code)
New session, Sonnet 5.5 High. Each tool in its own environment on the PC (15.9 GB RAM, about 5 GB free at the time of the check), outside this repo, version pinned. Output: `docs/handoffs/n0b-tool-probe.md` with the real tool lists, the data each returns for AAPL, memory used, and a go/no-go per tool. Brief: `docs/handoffs/briefs/n0b-tool-probe.md`.
- **OpenBB:** `uvx --from openbb-mcp-server --with openbb openbb-mcp` (default port 8001). Does the `sec` provider return income statement, balance sheet, cash flow and risk factors without a paid key? Which route names does the MCP server expose?
- **AlphaDesk:** `pip install alphadesk` in its own venv, listens on 127.0.0.1:8000, 53 read-only MCP tools (claimed). Only the SEC contact address as configuration until its tool list has been read. 19 stars: treat it as untrusted third-party code (pinned version, localhost only, no vendor keys at first). AGPL-3.0: use unmodified as a separate process.
- **TradingAgents:** `uv venv --python 3.13`, `pip install .`. Point it at Aperture as an OpenAI-compatible endpoint with a cheap model alias for the analysts. Run one ticker once and count the model calls and tokens: that number sets the N7 budget.
- Registering any MCP server in Claude's global config is a global-config change: ask Adham first. A repo-level `.mcp.json` is the alternative.

### N1a. News core in the watcher (`bridge/lib/news.mjs`, `bridge/lib/atom.mjs`)
Copies the pattern of `bridge/lib/scanner.mjs`. Own schedule in `watcher.mjs` (`nextNewsAt` / `newsInFlight`, no shared await with the trending scan).
- **Config:** new `news` block, off by default (like `images` and `dashboard.notes`): `enabled`, `every_minutes` (30, minimum 10), `remember_hours` (72), `max_age_minutes` (120), `max_items_per_digest` (10, then "+N more"), per-source switches, `tickers_extra`, `include_keywords` / `exclude_keywords`, `sec_forms`. Tickers come from the watchlist plus `tickers_extra` plus the N2 wide list, as `EXCHANGE:SYMBOL` (the library and both endpoints need the prefix; `--check-config` warns about a bare symbol).
- **Sources in N1a:** TradingView news-flow and SEC getcurrent only.
- **State:** a `news` bucket in `bridge/lib/state.mjs` with a 72-hour TTL (the 24-hour `alerts.submit` dedupe is too short: news-flow returns items up to 33.5 hours old); per-symbol seeding (a newly added ticker is remembered, not alerted, on its first poll); publish-time floor `max_age_minutes` on non-seed runs.
- **SEC details:** ticker-to-company map from `company_tickers.json`, cached on disk for 24 hours, company ids padded to 10 digits, one id to many tickers (GOOG/GOOGL). Required `User-Agent` with a contact address from `WATCHER_SEC_CONTACT` (secrets file, never the repo; `scripts/pi-setup.sh` sets it with the same hidden prompt as the Telegram secrets). Rate: far under SEC's 10 requests a second.
- **Gap rule for every windowed source:** if the oldest item on the page is newer than the last run, take one follow-up page where the API has one (SEC `start=`, news-flow `pagination`), otherwise log a gap. (JPM alone had 130 news-flow items in 33 hours.)
- **Delivery:** one digest per run through `alerts.submit` (`kind: 'news'`), so quiet hours, caps and held-digest logic apply; decide in the brief whether it counts against `max_per_hour` (default: yes). Link on its own line under each headline. TradingView items link to `https://www.tradingview.com{storyPath}` (ignore `link`); SEC links must be on `www.sec.gov`.
- **Untrusted input:** `notifiers.mjs` already escapes Telegram HTML and sets Discord `allowed_mentions: { parse: [] }` and truncates (lines 34 to 65); do not rebuild that. N1a adds: strip control characters, cap field lengths, `https` only with no credentials in the URL, response size cap, few redirects, entity expansion impossible by construction (D2). Never log a URL with a token (`redact`).
- **Append-only record:** each run's new items are appended to a capped `news.jsonl` for N6 to read.
- **Failure rules:** one source failing never stops the others; an empty result or an error means skip and log, no alert, no state change.
- **Tests (node:test, fakes in `bridge/test/watcher/support.mjs`):** first run only remembers; per-symbol seeding; dedupe across runs; the 72-hour bucket; digest cap; each source failing alone; hostile feed text (mentions, markup, huge fields, bad XML, DOCTYPE/ENTITY, numeric entities, `&amp;lt;` not double-decoded); URL rules; request budget; gap rule; state pruning; `--check-config`.

### N1b. More sources (after N1a is on `main`)
TickerTick, Nasdaq earnings calendar, the three RSS feeds and Finnhub, each behind its own switch, through the same extractor and dedupe. Endpoint reference list: OpenBB's keyless providers (`sec`, `nasdaq`, `cboe`, `finra`, `federal_reserve`, `bls`). Per-source attribution in each item ("via Yahoo Finance", as Yahoo's terms require).

### N2. Many more stocks, real time
- **Wide tier = one anonymous websocket quote session** holding all about 200 symbols (library `QuoteSession`, on the client the watcher already has), push updates, not polling. Probed 2026-10-14: 200 symbols answered in 4.6 s, +8.3 MB; NYSE and Nasdaq symbols `streaming` (real time), OTC symbols `delayed_streaming_900`. The bridge `quotes` tool caps at 50 symbols (`bridge/server.mjs:247`), so the watcher uses the library directly. The HTTP screener is used only for the once-a-day 10-day average volume and for `--check-config` symbol validation.
- **Rules:** % change versus `prev_close_price`; volume against the stock's own 10-day average (TradingView and Nasdaq count volume differently). Evaluated in US regular hours (`isUsRegularHours`). `dedupeKey` = `wide|rule|symbol|NY-date` so a stock does not re-alert all day. OTC symbols are labelled "delayed 15 min".
- **Fallback if the session drops or degrades:** Nasdaq's quote API (probed real time, several symbols per call, undocumented).
- Free real time is Cboe-only on TradingView (about a quarter of US volume): fine for large caps, a thin stock's last price can lag.
- Watchlist can be a plain text file (one `EXCHANGE:SYMBOL` per line). **Measure on the Pi** before and after (RSS with 7, 25 and 200 symbols); `MemoryMax=512M` is the ceiling.

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
- **Tool sources (added in N0):** besides this server's tools, a prompt may use the OpenBB MCP server (fundamentals from SEC filings, earnings and dividend calendars, company news, price targets) and the AlphaDesk MCP server (filings), if registered. Every prompt says: use these tools; if a tool is not available write "not available", never estimate from memory. The drift test covers this server's tool names exactly; the OpenBB and AlphaDesk tool names are checked against the list recorded by N0b (`docs/handoffs/n0b-tool-probe.md`).

### N4. Fundamentals for prompts 1, 2, 4, 7: decided by N0b (conditional)
Change from the draft: do **not** hand-write a `sec_fundamentals` tool first. OpenBB's `sec` provider already has income statement, balance sheet, cash flow, risk factors, MD&A and segment revenue as separate routes, and the `nasdaq` provider has earnings and dividend calendars and price targets. If the N0b probe shows these return the figures the ten prompts need without a paid key, N4 is dropped and N3 points at the OpenBB tools. If it does not, build the small tool as originally planned: SEC XBRL company facts (`data.sec.gov/api/xbrl/companyfacts/CIK##########.json`, 3.79 MB for AAPL, keyless), pure stdlib `urllib` in the style of `marketaux_service.py`, named `us-gaap` tags and the last N fiscal years only (never pass the raw JSON to a prompt), a **disk** cache (`marketaux_service.py` caches in memory only), a missing field reported as missing, US filers only, not `yfinance`. Brief: `docs/handoffs/briefs/n4-sec-fundamentals.md`.

### N5. Optional, only if asked
- **Options contracts monitoring:** `stock_options_unusual_activity` exists as an MCP tool (Python, unofficial Yahoo data). A Node watcher poll would need its own fetch of an unofficial endpoint; default is out of scope.
- **AI summaries of news:** on demand through Claude (prompts), or a tiny local model on a PC; not on the Pi.

### N6. Automatic news briefs on the Pi (new; waits for the Aperture model chain)
A small stdlib Python script (`scripts/news_brief.py`) run by a systemd timer after each news run:
1. reads the new items N1a appended to `news.jsonl` (a cursor file remembers where it stopped);
2. fetches article text only for `https` links, with a size cap, few redirects and a cap of about 8 KB per article (HTML to text);
3. asks the models in the order Adham gives, falling back to the next on any error (the `ask` command already does per-alias fallback across providers; the Pi needs Tailscale and `APERTURE_URL`, unverified);
4. posts the brief through the watcher's existing `POST /notify` (`bridge/README.md`, bearer `WATCHER_LOCAL_TOKEN`), so escaping, quiet hours and caps apply and no new notifier code is needed.
- **Spend:** **off** until Adham gives the chain. When on: at most 48 model calls and 200k tokens a day (config, hard cap in code, counted in a state file), about one brief per news run. The cost per alias is stated in the brief from `ask --list` before switching on.
- **Untrusted text:** article text is attacker-controlled (prompt injection). The model gets no tools, its output is plain text, and only the original item links are attached, never a link from the model's output.

### N7. Deeper research on the PC with TradingAgents (new; waits for N0b)
Once or twice a day on the PC (it must be on), not every 30 minutes. For the **hot list only** (not the 200), run TradingAgents (`TauricResearch/TradingAgents`, Apache-2.0, multi-agent: analysts, researchers, trader, risk) per ticker, with the model calls going through Aperture's OpenAI-compatible endpoint: a cheap alias for the analyst tier and one stronger alias for the manager tier (it supports a provider per tier since v0.6.0). Output: its HTML report is saved to the dashboard notes folder, and a three-line summary is posted through `POST /notify`. Budget: tickers per run and tokens per day are config with a hard cap, sized from the N0b measurement of one ticker run. TradingAgents says it is "designed for research purposes ... not intended as financial, investment, or trading advice": its trade decisions are shown as research text and never become signals; the watcher stays alerts-only. A scheduled `claude -p` run (Haiku or Sonnet with scrapling) on the day's top items is the fallback if TradingAgents is too costly. Codex workers have no network, so Luna or Sol through Codex can only work on text handed to them; Luna with network access is `ask -m luna` (billed).

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

## Regime per piece (Adham approves each start)

| Piece | Regime | Start with | Delegates | Check |
|---|---|---|---|---|
| N0 Plan review and research | 1 architecture | Opus 5.5 High, plan mode: **done** | Haiku xhigh for facts | Fable advisor: **done** |
| N0b Install and probe OpenBB, AlphaDesk, TradingAgents | 3 build (setup) | Sonnet 5.5 High, new session | none | `docs/handoffs/n0b-tool-probe.md` with real outputs |
| N1a News core | 3 build | Sonnet 5.5 High, new session | Luna Max (Codex worktree) for the extractor and hostile-feed test suite | `npm test --prefix bridge`; Sol High read-only review |
| N3 Analysis prompts | 3 build | Sonnet 5.5 High, new session (other files than N1a) | Luna Max for the drift test | pytest |
| N1b More sources | 3 build | Sonnet 5.5 High, after N1a is on `main` | none | tests per source; Sol High review |
| N4 Fundamentals | conditional on N0b | Sonnet 5.5 High | none | fixtures; Adham's live check |
| N2 Wide tier, real time | 3 build | Sonnet 5.5 High, new session | none | Pi RSS numbers in `docs/handoffs/` |
| N6 Pi news briefs | 3 build | Sonnet 5.5 High | none | after Adham sets the chain and budget |
| N7 TradingAgents research | 3 build | Sonnet 5.5 High | none | after N0b measures one ticker run |

Order: N1a and N0b in parallel (different files), then N3, N1b, N4 if needed, N2, N6, N7. No N1 or N2 on the Pi before the watcher has run a clean night. Each finished piece is logged with `regime_log.py` and gets a `docs/handoffs/` report and a STATUS row.

## Closed and open questions

Closed (Adham, 2026-10-14): stocks not options contracts; about 200 tickers; more sources; watcher not PanWatch; real time wanted; use TradingAgents, OpenBB and AlphaDesk. Open: the Aperture model chain and daily budget (N6, N7); global versus repo-level registration of the OpenBB and AlphaDesk MCP servers.

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

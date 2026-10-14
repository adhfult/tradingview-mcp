# N0 findings: news monitor, wide watchlist, analysis prompts

Written 2026-10-14 by the N0 planning session (Opus 5.5 High, plan mode). Every fact was retrieved on 2026-10-14; the source URL or the command that produced it is next to each one. Facts a subagent fetched and I re-checked say so. Anything marked unverified is not to be relied on. Companion files: `docs/plans/news-monitor-and-analysis-prompts.md` (the corrected plan), `docs/plans/news-monitor-argon-plan.md` (Argon's review).

## Verified facts

### TradingView (probed live from this PC, anonymous, by me)
- **Batch quotes for 200 symbols: one HTTP call.** The installed library's `getScreener({market:'america', columns, symbols:[...200], range:[0,250]})`
  (`bridge/node_modules/@mathieuc/tradingview/dist/http/screener.js`, POST `scanner.tradingview.com/america/scan` with
  `symbols:{tickers}`) returned **200/200 rows in 0.92 s, ~35 KB**. Columns `close, change, volume, relative_volume_10d_calc`
  all filled. `update_mode` = **`delayed_streaming_900` for all 200** → the anonymous **HTTP screener** is **15 min delayed**
  (the websocket quote session is real-time for NYSE/Nasdaq: see N2 below).
  The bridge already exposes `getScreener` (`bridge/server.mjs:302`, without a `symbols` param today).
- **TradingView news, JSON, symbol-tagged:** `GET news-mediator.tradingview.com/news-flow/v2/news?filter=lang:en&filter=symbol:A,B,C&client=screener&streaming=false`
  returned 200 items for 3 tickers (oldest 33.5 h), keys `items`, `pagination`. Comma list = OR; repeated `filter=symbol:` = AND (wrong).
  Item: `id` (stable, e.g. `tag:reuters.com,2026:newsml_…`), `title`, `published` (unix s), `urgency`, `provider{id,name}`,
  `relatedSymbols[]`, `storyPath` (tradingview.com path) and sometimes `link` (outside host, e.g. gurufocus.com), `paywall`.
  Older host `news-headlines.tradingview.com/v2/headlines?symbol=…` also works. **Undocumented/unofficial**, the same status as
  the scanner/hotlist the watcher already depends on. Max symbols per request and rate limits: **not verified**.

### SEC EDGAR (Haiku lookup; I re-checked the quotes in the saved raw pages)
- Rate: "Current max request rate: 10 requests/second." (sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data);
  "no more than 10 requests per second, regardless of the number of machines" (sec.gov/about/developer-resources);
  over it → IP limited until under the rate for 10 min (sec.gov/about/privacy-information). UA must declare
  company/name + contact email (sample "Sample Company Name AdminContact@<domain>.com").
- Latest filings: `browse-edgar?action=getcurrent&type=8-K&count=100&output=atom` → Atom, **max 100 entries** (count=200 gave 100);
  100 8-Ks covered 06:08 to 16:01 ET on 2026-10-14. Entry: title `8-K - NAME (0001297937) (Filer)`, `<id>…accession-number=…</id>`,
  link host `www.sec.gov`, summary lists "Item 8.01: …". Update frequency of getcurrent: not documented.
- Per-company Atom (`action=getcompany&CIK=…&type=8-K&output=atom`) works, ~18 KB.
- `company_tickers.json`: 800 KB, 10,451 entries `{cik_str, ticker, title}`; "do not guarantee accuracy or scope".
- data.sec.gov: "do not require any authentication or API keys"; submissions "<1 s" delay, XBRL "under a minute";
  submissions AAPL 164 KB (`filings.recent.items` holds "2.02,9.01"); **companyfacts AAPL 3.79 MB**, path
  `facts['us-gaap'][tag].units.USD[]` with `start,end,val,accn,fy,fp,form,filed` (+`frame` on some).

### RSS, news APIs, PanWatch (Haiku lookup; quotes marked ✓ re-checked by me in the saved pages)
- Yahoo per-ticker RSS works (17 items, multi-ticker `s=AAPL,MSFT` too) but returned **429** to a Chrome UA; Yahoo terms
  (legal.yahoo.com otos): display only "without modification", with attribution and a link (agent-reported, not re-checked).
- Google News RSS: 100 items, links are `news.google.com` redirects; ✓ "made available solely for the purpose of rendering Google
  News results within a personal feed reader for personal, non-commercial use."
- Nasdaq per-symbol RSS works (15 items); terms not checked.
- Finnhub: key required; company-news free = "1 year of historical news", North America only; per-minute free limit **not verified**.
- Marketaux free: "100 requests daily 3 articles / news request" (too small for 200 tickers every 30 min).
- PanWatch (github.com/TNT-Likely/PanWatch, MIT, last commit 2026-10-13): ✓ "Monitor A-shares, Hong Kong, and U.S. stocks…";
  LLM-driven analysis reports (OpenAI-compatible or Ollama); Telegram/webhooks; Python 3.10 + Node 24 + pnpm; Docker image has arm64.
  **No per-ticker news feed or news interval is documented**; RAM needs not stated.
- terminal-rs: no licence (API `license: null`), last commit 2026-10-13. crawl-hive: MIT, last commit 2026-10-13.

### Repo facts (read by me)
- `bridge/lib/notifiers.mjs:34-65`: Discord already sends `allowed_mentions:{parse:[]}`; Telegram is HTML with every text
  `escapeHtml`'d and truncated to 4096; link label is fixed "Chart". So mention/markup neutralising **already exists**; N1 must
  not re-implement it, only validate URLs (https + host allowlist) and strip control chars.
- `bridge/lib/scanner.mjs` is the pattern to copy (first scan seeds, empty/error = skip, one batch message, `alerts.submit` with
  `dedupeKey`); `alerts.submit` dedupes `seen` for 24 h only, so a longer `remember_hours` needs its own state bucket (as `trending`).
- `watcher.mjs:349-355`: tick awaits `scanInFlight`; a second poller should get its own `nextNewsAt/newsInFlight` (no shared await).
- `bridge/package.json`: deps are `@mathieuc/tradingview`, `lightweight-charts`, `playwright-core` only; **no XML parser**.
- Python: no SEC/EDGAR code anywhere; `marketaux_service.py` uses `urllib` + UA + an **in-memory** (not disk) TTL cache.
  Prompts live in `server.py:999` (`strategy_builder`) and `:1012` (`strategy_reviewer`).


## More free sources (GitHub search by Haiku; ✓ = I fetched it myself 2026-10-14)
| Source | Key | Limits / terms | Use |
|---|---|---|---|
| ✓ **TickerTick** `api.tickertick.com/feed?q=(or z:aapl z:msft …)&n=50`, JSON (`id,title,url,site,time,tickers,tags`) | no | README: "free of commercial/non-commercial use"; **10 req/min per IP**, blocked 30 s if >5 in 30 s | N1 source: OR query over a chunk of tickers; also `T:sec`, `T:curated` story types |
| ✓ **Nasdaq earnings calendar** `api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD`, JSON (symbol, time pre/after market, epsForecast, lastYearEPS) | no | undocumented | N1 morning "earnings today/this week for your list" item; N4/N3 catalysts prompt data |
| SEC full-text search `efts.sec.gov/LATEST/search-index` (Haiku: 200 JSON) | no | SEC fair access | later, on-demand tool |
| Federal Register `federalregister.gov/api/v1/documents.json` (Haiku: 200 JSON) | no | — | later (regulatory catalysts) |
| GlobeNewswire public-company RSS | no | **403** from here | not usable as is |
| Finnhub (press releases, earnings/IPO calendars, company news) | free key | free limit unverified | opt-in |
| Tiingo news, NewsAPI, FRED | free key | list claims, unchecked | not v1 |
| newsfilter.io (`realtime-newsapi`, no licence, terms unstated) | ? | unknown | skip until terms known |
| edgartools (MIT, 2.8k★) | — | Python library | **not added** (N4 needs only `companyfacts`, ~60 lines of stdlib) |


## Real-time quotes (added after Adham asked "any way to not get delayed data?")

Probed from this PC, anonymous, 2026-10-14 20:45 UTC (after the close, so `streaming` flags are the entitlement, not live ticks):
- One websocket quote session (`getQuotes`, library `@mathieuc/tradingview` 4.0.0) with the 200 largest `america` symbols: answered in 4.6 s, +8.3 MB RSS. By exchange: NASDAQ 39 `streaming`, NYSE 106 `streaming`, OTC 55 `delayed_streaming_900`. Provider field: `ice`.
- Prices matched Nasdaq's own quote API to the cent (AAPL 342.96 vs 342.89 to 343.04 at 4:45 PM ET). Volume did not match (AAPL 49.8M TradingView vs 39.0M Nasdaq), so volume rules compare a stock only with its own TradingView history.
- The HTTP screener (`getScreener`) is `delayed_streaming_900` for all 200: use it only where delay does not matter.
- Agent-reported via WebFetch (not re-fetched by me, page needs JavaScript): TradingView support 43000473924 says free real-time US data comes "from the Cboe exchange", "over one fourth (25%+)" of US volume. Direct NYSE/Nasdaq real time is a paid add-on (support 43000471705).
- `api.nasdaq.com/api/quote/watchlist?symbol=aapl|stocks&symbol=jpm|stocks` returned several symbols per call with `isRealTime: True` on the single-quote form. Undocumented endpoint.
- Alpaca free plan: IEX only, websocket 30 symbols, REST 200 calls/min, key needed, `/v2/stocks/snapshots?symbols=` exists (docs.alpaca.markets, agent-reported). Twelve Data free 8 requests/min. Tiingo IEX needs an entitlement. Polygon/Massive free is end of day only.

## Repos named on X (twifork search, 119 posts, 82 t.co links; only one resolved to GitHub and it was off-topic)

| Repo | Stars | Last push | Licence | Role in the plan |
|---|---|---|---|---|
| TauricResearch/TradingAgents | 111k | 2026-10-03 | Apache-2.0 | N7 engine (see the plan) |
| openbq-org/OpenBB (redirect target of OpenBB-finance/OpenBB) | 74k | 2026-10-14 | Apache-2.0 in the LICENSE text (GitHub's detector says NOASSERTION) | MCP data server, probable replacement for N4 |
| vigneshv1cky/alphadesk-terminal | 19 | 2026-10-14 | AGPL-3.0 (commercial licence offered) | optional research terminal and MCP server |
| virattt/ai-hedge-fund | 64k | 2026-10-02 | MIT | skip (agent demo, no data) |
| shiyu-coder/Kronos | 41k | 2026-04-13 | MIT | skip (candle model) |

Facts read from the READMEs on 2026-10-14: TradingAgents needs Python 3.11+, supports any OpenAI-compatible endpoint, Ollama and per-tier providers (v0.6.0), has SEC EDGAR fundamentals, and says "designed for research purposes ... not intended as financial, investment, or trading advice". OpenBB ships `openbb-mcp-server` (`pip install openbb-mcp-server`, command `openbb-mcp`, default port 8001) and its `sec` provider has income statement, balance sheet, cash flow, risk factors, MD&A, segment revenue, filings and insider trading; its `nasdaq` provider has earnings, dividend and IPO calendars, company news, price targets. AlphaDesk (`pip install alphadesk`, Python 3.11+) lists 53 read-only MCP tools (the X post said 37), listens on 127.0.0.1:8000, needs your own vendor keys for anything beyond SEC EDGAR and Treasury data, and asks for a contact address for SEC.

## Still unverified
1. TradingView news-flow: maximum symbols per request, rate limits, how long the endpoint stays up (undocumented).
2. SEC 8-K volume in the 16:00 to 16:30 ET peak (the follow-up page covers it; a gap is logged if even that does not reach the last run).
3. Yahoo RSS: chunk size for `s=` and the cause of the 429 (user agent or rate).
4. Finnhub free per-minute limit; Nasdaq RSS and calendar terms.
5. Whether `ask`, Tailscale and `APERTURE_URL` work on the Pi (N6 needs them).
6. Whether OpenBB's `sec` provider returns the figures the ten prompts need without a paid key, and the real tool names its MCP server exposes.
7. Whether AlphaDesk and TradingAgents install and run on this PC within its memory, and how many LLM calls one TradingAgents ticker run makes.
8. Watcher RSS and CPU with the news module on (Pi, unmeasured).
9. Argon never produced the independent plan the brief asked for; its file is a review of this one.

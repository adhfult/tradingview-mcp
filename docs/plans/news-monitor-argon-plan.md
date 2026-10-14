ARGON REVIEW (NOT AN INDEPENDENT PLAN)

Saved 2026-10-14. Gemini 4 Argon (Gemini app) was given the self-contained brief but answered as a review of the Opus N0 findings ("Opus's N0 findings and decisions ... should be approved with six targeted corrections"), so it had seen Opus's view first. It is a second review, not the unanchored second plan the process wanted. The reconciliation, with a verdict and evidence per point, is in `docs/plans/news-monitor-and-analysis-prompts.md` (section "N0 review outcome"). The reply's middle section ("Drop-In Replacement for Opus's Pending N0 Sections") is omitted here: it repeats the standalone file below. Everything else is Argon's text as pasted.

---

Opus's N0 findings and decisions (**D0 to D3** and the **N2 `getScreener` rewrite**) are architecturally sound and should be **approved with six targeted corrections** before moving to implementation. Switching the wide tier (N2) to batched `getScreener` POST calls (`200 rows in 0.92s`) and headlines (N1) to TradingView's `news-flow/v2/news` JSON + SEC EDGAR `getcurrent` Atom eliminates the Raspberry Pi memory/socket bottleneck and avoids adding third-party dependencies or API keys.

## 1. Argon Audit: 6 Technical Edge Cases to Fix in the Plan

| # | Area | Issue in Current N0 Draft | Required Fix |
|---|---|---|---|
| 1 | TradingView symbol prefixing (N1 and N2) | Both `scanner.tradingview.com/america/scan` (`symbols.tickers`) and `news-flow/v2/news` (`filter=symbol:`) require exchange-prefixed tickers (`NASDAQ:AAPL`, `NYSE:BRK.B`), whereas user watchlists typically list bare tickers (`AAPL`). | On startup (and when the watchlist changes), resolve bare symbols once via `getScreener` using a `name` `in_range` filter (or cache `ticker -> EXCHANGE:TICKER` in state) so users can write bare tickers in config while N1/N2 send `EXCHANGE:TICKER`. |
| 2 | 33.5h feed window vs. 24h dedupe, and new-ticker floods (N1) | TradingView returns stories up to 33.5h old, while `alerts.submit` forgets IDs after 24h. Seeding only on first-ever startup means adding a 201st ticker later will dump 33h of old headlines. | 1) Keep a dedicated `state.newsSeen` map with a 72h TTL. 2) Enforce a publish-time floor on non-seed runs (`published >= now - max_age_minutes`, default 120 min). 3) Track `state.newsSeededSymbols` so newly added tickers silently seed on their first poll. |
| 3 | SEC `getcurrent` dual-class CIKs and peak earnings gaps (N1) | `company_tickers.json` stores `cik_str` as an integer (`320193`) while Atom titles use 10-digit zero-padded strings (`0000320193`), and multi-class issuers (`GOOG`/`GOOGL`, `BRK.A`/`BRK.B`) share one CIK. During 4:00 to 4:30 PM ET earnings peaks, market-wide 8-Ks exceed 100 in 30 minutes. | 1) Pad `cik_str` to 10 digits and map `CIK -> string[]` (one-to-many). 2) Cache `company_tickers.json` on disk (24h mtime TTL) so watcher restarts don't re-pull 800 KB. 3) If entry #100 is still newer than `lastSecPollAt`, fetch one follow-up page (`&start=100`) before logging a gap warning. |
| 4 | Single-pass XML entity decoding (D2) | SEC Atom summaries include numeric character references (`&#160;`, `&#8217;`, `&#x2019;`) in addition to the 5 named XML entities. Sequential `.replace()` calls risk double-unescaping (`&amp;lt;` becoming `<`). | Decode the 5 named entities plus `&#\d+;` and `&#x[0-9a-fA-F]+;` in a single regex pass (`replace(/&(...);/g, fn)`), after rejecting `<!DOCTYPE` and `<!ENTITY`. |
| 5 | Discord 2,000-char limit and per-headline links (N1) | `notifiers.mjs:34-65` truncates Telegram at 4,096 chars and hardcodes a single "Chart" link label, but Discord webhooks fail with HTTP 400 over 2,000 chars and news digests have one URL per headline. | Chunk batch news alerts so each Discord payload stays at or under 1,900 chars (or cap at 8 to 10 headlines per message plus "+N more"), and format validated HTTPS links inline per headline rather than relying on the single "Chart" footer link. |
| 6 | Wide-tier intraday re-alert spam (N2) | `change` (vs. previous close) and `relative_volume_10d_calc` stay above threshold for hours once triggered (and freeze after-hours/weekends). | Dedupe wide-tier alerts by trading date + symbol + rule (`wide:${symbol}:${YYYY-MM-DD}:${rule}`) or require an additional step-change delta (for example another +2% move) before re-alerting the same day. |

## 2. Standalone file (Argon's proposed `docs/plans/news-monitor-argon-plan.md`)

### Verdict on N0
Approve D0, D1, D2, D3, and the N2 `getScreener` batch rewrite, subject to the 6 guardrails below.

### Core decisions
- **D0 (runtime):** Build inside the existing Node watcher (`bridge/`). Do not deploy PanWatch on the Pi for v1 (redundant Node 24 + Python + LLM stack, no documented per-ticker news poller). Do not reuse code from `terminal-rs` (`license: null`).
- **D1 (sources):**
  1. TradingView `news-flow/v2/news` JSON: primary headline feed. Batch symbols in chunks of 50 (`filter=lang:en&filter=symbol:EXCHANGE:T1,EXCHANGE:T2`).
  2. SEC EDGAR `getcurrent` Atom: official filing feed (`8-K`, `10-Q`, `10-K`, `count=100`). Filter locally against a 24h disk-cached `company_tickers.json` (10-digit CIK to tickers).
  3. Drop Yahoo/Google RSS in v1: avoids Yahoo 429s and terms restrictions, Google redirect wrappers, and full XML parsing.
- **D2 (parser):** Zero new npm dependencies. Parse SEC Atom `<entry>` blocks with a strict extractor of about 40 lines that rejects `<!DOCTYPE` / `<!ENTITY` and decodes the 5 named XML entities plus numeric references in a single regex pass.
- **D3 (summaries):** No LLM summarization in the 30-minute watcher loop in v1.

### Required guardrails across N1 to N4
1. Symbol qualification: resolve bare watchlist tickers (`AAPL`) to `EXCHANGE:TICKER` once via `getScreener` on boot/reload.
2. Deduplication and seeding: `state.newsSeen` with a 72h TTL, a `published >= now - max_age_minutes` cutoff after seeding, and `state.newsSeededSymbols` so newly added tickers seed silently.
3. Multi-ticker CIKs and burst pagination: map `CIK -> string[]`; if the 100th SEC Atom entry is newer than `lastSecPollAt`, allow one `&start=100` follow-up call before logging a gap warning.
4. Notification safety and limits: keep `notifiers.mjs` HTML/mention escaping intact; validate `https://` URLs, strip control chars, format per-item links inline, and split batch messages at 1,900 chars or less for Discord.
5. Wide-tier screener (N2): pass `symbols` in `getScreener` (200 or fewer per request), label alerts "delayed 15 min", and dedupe per symbol + date + rule.
6. Python SEC and 10 prompts: bound any `companyfacts` lookup to specific `us-gaap` tags and recent fiscal periods (never pass raw 3.8 MB JSON blobs into prompts), and register the 10 analysis prompts in `server.py` alongside `strategy_builder` and `strategy_reviewer`.

### Still unverified (Argon's list)
1. TradingView news-flow maximum symbols per `filter=symbol:` query (tested with 3 tickers).
2. SEC `getcurrent` `&start=100` pagination behaviour.
3. Finnhub free per-minute limit.

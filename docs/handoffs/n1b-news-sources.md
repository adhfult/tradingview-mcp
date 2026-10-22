# N1b: more news sources

Branch `claude/n1b-news-sources` (worktree `tradingview-mcp-n1b`). Regime 4: Sonnet 5.5 High lead, Luna Max (`gpt-6-luna`, Codex, own worktree) wrote the parser module, Sol High (read-only) and Fable reviewed. Not pushed, not deployed.

## What was built
- `bridge/lib/news-sources.mjs` (new, pure, no I/O): `tickertickPage`, `rssPage`, `finnhubPage`, `calendarPage`. Untrusted-input rules as in N1a: control characters stripped, fields capped, `https` links only with no credentials, bad rows skipped and counted, wrong shapes throw. Brackets, parentheses, angle brackets and backticks in a link are percent-encoded so a feed URL cannot form a Markdown link in a digest. (A new file, not in the brief's "may touch" list: it keeps `news.mjs` readable and let a worker build it without touching a file I was editing.)
- `bridge/lib/news.mjs`: the sources are wired into the existing window logic (seeding, 72 h dedupe, gap rule, digest, `news.jsonl`), so they inherit all of N1a's behaviour.
- `bridge/lib/config.mjs`, `watcher.config.example.json`, `bridge/README.md` ("More news sources"), `watcher.mjs` (`FINNHUB_API_KEY` from the environment).

| Source | Default | Request shape | Cap per run | Spacing |
|---|---|---|---|---|
| TickerTick | **on** | `/feed?q=(or z:aapl z:msft ...)`, 10 tickers per request, `last=<last_id>` follow-up for the gap rule | 6 (5 first pages, 1 kept for a follow-up) | 7 s |
| Yahoo RSS | off | one request per symbol | 25 | 1 s |
| Nasdaq RSS | off | one request per symbol | 10 | 1 s |
| Google News RSS | off | one request per symbol | 10 | 1 s |
| Finnhub | off | `company-news` per symbol, key in the `X-Finnhub-Token` header | 25 | 1.1 s |
| Nasdaq earnings calendar | off | `calendar/earnings?date=<New York date>`, one item a day | 1, once per New York day | none |

Common to all of them: US-listed symbols only; a hard budget per run in code (not a setting); rotation, so a capped list starts each run where the last stopped; HTTP 429 pauses only that source for `Retry-After` (seconds or HTTP date), at least 30 minutes, at most 6 hours; attribution `via <source>` on every digest line; cross-source dedupe by URL (tracking parameters dropped) then headline + ticker within 6 hours (Google's " - Publisher" suffix ignored); the same redirect rule as before (same HTTPS host only, two hops).

## Decisions I made that you may want to reverse
1. **Finnhub fixture is not a recording.** No key, so `finnhub-company-news-documented.json` is built from the vendor's documented schema and labelled so in `fixtures/README.md`. Replace it with a redacted real sample when you have one.
2. **Nasdaq earnings calendar stays off**; I recorded one sample response for its fixture (a single GET, 2026-10-21) but nothing calls it unless you switch it on. Check Nasdaq's terms first.
3. **Google News RSS**: its feed notice says personal, non-commercial use in a feed reader. That is a personal reading of "personal"; it is off by default.
4. **`z:` not `tt:`** in the TickerTick query, as the approved plan says. The fixture was recorded with `tt:aapl`; the response shape is the same, and a `z:aapl` probe also returned a few off-topic stories (use `exclude_keywords`).
5. **Yahoo is per symbol, not the plan's multi-ticker `s=`**, because a multi-ticker response cannot say which ticker an item is about.
6. **TickerTick is on by default** (the brief says so), which changed one existing test (`watcher starts news independently...` counts fetches) to switch it off. With `news.enabled` still false by default, nothing runs until you enable news.
7. The Finnhub key is read from `FINNHUB_API_KEY`; `scripts/pi-setup.sh --finnhub` now prompts for it (added 2026-10-22; it was out of scope for N1b).

## Checks run (by me, in the worktree)
- `cd bridge && timeout 250 node --test`: 894 tests, 892 pass, 0 fail, 2 skipped (baseline 837 + 57 new). `node watcher.mjs --config watcher.config.example.json --check-config`: OK.
- Tests first: the parser tests and fixtures were committed (c62c0e2) before any parser existed and failed with module-not-found; the poller tests (43ffa9d) failed before the integration.
- Mutation check (scratch script, patterns applied one at a time to `news.mjs` and `news-sources.mjs`): 29 of 29 killed after I added tests for the first run's 7 survivors (the first run was flawed in one mutant; redone), then 9 of 9 on the review fixes. The one skipped pattern (RSS epoch date) appears twice in the file and has its own test.
- Recorded fixtures were fetched once each on 2026-10-20/21; no test touches the network.

## Reviews
- Luna Max wrote `news-sources.mjs` against my acceptance tests; I ran the tests myself and read the file before using it.
- Sol High (read-only): 2 must-fix, 5 should-fix. All fixed with tests: capped lists never rotated (symbols past the cap starved), a TickerTick chunk marked other chunks' symbols as seen, Markdown in feed URLs, Nasdaq/Google over the plan's cap of 10, calendar polled every run, HTTP-date `Retry-After`, and a vacuous five-hour dedupe test.
- Fable (read-only, reviewed the diff from before those fixes): no must-fix. Should-fix, all fixed with tests: the 7 s spacing sleep outlived the 5 s shutdown drain (re-opening the N1a shutdown guarantee), URL re-parsing made the merge quadratic, a seed run claimed headlines another source still had to deliver. Nits fixed: `FINNHUB_API_KEY` added to the redactor list, RSS `Accept` header, one "empty result" log line per quiet symbol. Not done: `--check-config` does not warn when `finnhub` is on without a key (the poller logs it every run).
- No second review round after the last fixes; each fix has a test that fails without it.

## Known limits
- Pauses, spacing and rotation positions are in memory; a restart forgets them (one extra request per source, then normal).
- More sources mean more `seen` keys; the N1a eviction-floor limit (`n1a-review-fixes.md`) applies sooner. With 200 symbols and every source on, watch `state.json`.
- TickerTick and RSS results can be off-topic; the keyword filters are the tool for that.
- Real-time behaviour on the Pi (memory, request timing) is unmeasured, and N1a itself is still not deployed.

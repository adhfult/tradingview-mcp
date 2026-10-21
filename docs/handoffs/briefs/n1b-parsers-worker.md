# Worker brief: N1b news source parsers

Ignore `HANDOFF.md` and `HANDOFF-P0-old.md` in the repo root. You have no network. Do not read or print secrets. Do not push. Do not add a dependency.

## Goal
Create ONE new file, `bridge/lib/news-sources.mjs` (ES module, Node 22, no dependencies except `./atom.mjs`), so that `bridge/test/watcher/news-sources.test.mjs` passes. The test file is the spec; read it first, and read the recorded fixtures it uses in `bridge/test/watcher/fixtures/` (`tickertick-aapl.json`, `yahoo-aapl.rss`, `nasdaq-aapl.rss`, `google-aapl.rss`, `nasdaq-earnings-calendar.json`, `finnhub-company-news-documented.json`).

## Files you may touch
Only `bridge/lib/news-sources.mjs` (new). Do not edit any test, any fixture, `news.mjs`, `atom.mjs`, `config.mjs` or anything else. If a test seems wrong, do not change it: say which test and why in your final message.

## Exports
`tickertickPage(text, tickers)`, `rssPage(text, { source, via, symbol })`, `finnhubPage(text, symbol)`, `calendarPage(text, { date, tickers, now })`. Each returns `{ items, count, oldest, cursor, skipped }` (see the comment at the top of the test file). Pure functions: no network, no clock, no logging, no global state.

## Rules (the untrusted-input rules the existing code in `bridge/lib/news.mjs` already follows)
- Every string field: strip control characters `[\u0000-\u001f\u007f-\u009f]`, trim, cap the length (titles 500, ids 512, via 120). Write a small `clean(value, length)` for this. Never HTML-decode or interpret markup.
- A link is accepted only if it is a string of at most 2048 characters, has no whitespace, control characters or backslash, parses as a URL with protocol `https:`, a non-empty hostname, no username or password, and no `@` in the authority. Anything else makes that row invalid. Item links keep their original text (do not normalise them).
- An invalid row is dropped and counted in `skipped`; it never throws. A wrong overall shape (not JSON, wrong top-level type, more than 1000 rows, not a feed, `data` missing in the calendar) throws an Error. `JSON.parse` errors may propagate.
- `rssPage`: use `parseFeed` from `./atom.mjs` (it already handles RSS items, per-entry skipping and hostile XML). Add `parsed.skipped.length` to `skipped`. Each entry becomes `{ source, id, title, url: link, symbols: [symbol], publishedAt: Date.parse(updated), via }`; an entry whose date does not parse to a positive finite number is skipped.
- Item shape for all parsers: `{ source, id, title, url, symbols, publishedAt (ms), via }`. `count` = number of valid rows, whether or not any maps to a watched symbol. `oldest` = smallest `publishedAt` among valid rows, or `null`.
- `tickertickPage`: `tickers` is a `Map` from lower-case ticker to an array of qualified symbols. Story ids may be strings or numbers; convert to string. `via` is `TickerTick (${site})`, or `TickerTick` if the site is empty. `cursor` is `last_id` only if it is a string matching `/^-?\d{1,20}$/`, else `null`.
- `finnhubPage`: the body is an array. `datetime` is unix seconds. `via` is `Finnhub (${source})`, or `Finnhub` if the source is empty. `cursor` is always `null`.
- `calendarPage`: `tickers` is a `Map` from UPPER-case ticker to qualified symbols. Valid row: an object whose `symbol` matches `/^[A-Z0-9.-]{1,10}$/u` after cleaning. `date` must match `/^\d{4}-\d{2}-\d{2}$/u` or the function throws. The body must parse to an object with `data` an object whose `rows` is an array, else throw. At most one item: title `Earnings today: ` plus the matched tickers in row order, each as `TICKER (before open)` for `time-pre-market`, `TICKER (after close)` for `time-after-hours`, and plain `TICKER` for anything else; joined by `, `; capped at 500. `symbols` = the qualified symbols of matched rows, in row order, without duplicates. `id` = `earnings|${date}`, `url` = `https://www.nasdaq.com/market-activity/earnings`, `publishedAt` = `now`, `via` = `Nasdaq`, `cursor` and `oldest` = `null`. No match means no item (but `count` still counts valid rows).
- Keep the file short and readable. Comment only the non-obvious. Match the style of `bridge/lib/news.mjs`.

## Check (run it yourself, from `bridge/`)
```
node --test test/watcher/news-sources.test.mjs
```
All tests must pass. Also run `node --test test/watcher/atom.test.mjs` to confirm you broke nothing. Do not run the full suite (it needs sockets you do not have).

## Final message
What you did, the exact commands you ran with their real output, and anything you did not do or any test you think is wrong. Commit your work on your branch with a message saying what and why.

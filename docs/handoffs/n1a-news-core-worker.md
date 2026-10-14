# N1a news core — Codex worker report

2026-10-14. Worktree: `/home/adhfult/code/tradingview-mcp-codex-n1a-news`.
Implementation is ready for Claude's review; the required zero-failure full-suite gate is **not met in this restricted sandbox**. No commits or pushes.

## Changes

- Fixed both reviewed extractor defects, with failing regression tests first: foreign namespace elements no longer collide with mapped fields; invalid entries return `{ entries, skipped: [{ index, reason }] }` without losing valid neighbors. Whole-document XML errors, declarations, and document limits still throw. All prior hostile-input cases remain covered.
- Added `bridge/lib/news.mjs`: TradingView news-flow plus SEC getcurrent, source switches, bounded requests and redirects, SEC contact header and private 24-hour disk company cache, padded CIK / share-class mapping, one older-page follow-up and gap logging, headline filters, per-symbol seeding and dedupe, publish-time floor, one digest through `alerts.submit`, and capped private `news.jsonl` records. No new dependency.
- Added validated off-by-default `news` config, persistent normalized/pruned state, independent `nextNewsAt` / `newsInFlight`, and shutdown cancellation. The poller starts without awaiting trending and can run again while trending is still pending.
- Updated the example config, README, and Pi setup's `--sec-contact` hidden prompt. Notification transports were not edited.
- Added 34 news tests and three extractor regression tests, increasing discovery from 768 to 805 tests (including the two pre-existing skips).

Additional failing regressions found during self-review were fixed before final verification: initial SEC seeding leaked across forms; adding a symbol reset chunk gap history; a new symbol in an earlier chunk swallowed an existing symbol's shared story; null news config and malformed exchange prefixes were accepted. Dedupe is keyed per story **and symbol**, with matching fresh stories merged into one digest item.

## Verification commands and actual results

From the repo root:

```sh
node --test --test-isolation=none bridge/test/watcher/atom.test.mjs bridge/test/watcher/news.test.mjs
```

```text
ℹ tests 51
ℹ suites 0
ℹ pass 51
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

The `--test-isolation=none` diagnostic is needed here because the sandbox blocks subprocess pipe handling; default child test output collapses to one result per file.

From `bridge`, the exact required command:

```sh
timeout 250 node --test
```

```text
ℹ tests 37
ℹ suites 0
ℹ pass 29
ℹ fail 8
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Exit 1. These are **file-level** results, not individual-test totals. The eight failing files are:

- `test/entrypoint.test.mjs`
- `test/watcher/cli.test.mjs`
- `test/watcher/dashboard-page.test.mjs`
- `test/watcher/dashboard.test.mjs`
- `test/watcher/localapi.test.mjs`
- `test/watcher/notes.test.mjs`
- `test/watcher/render-page.test.mjs`
- `test/watcher/watcher.test.mjs`

An unchanged `HEAD` scratch checkout, with the same dependency symlink and design document, running the same bare command reports:

```text
ℹ tests 36
ℹ pass 28
ℹ fail 8
ℹ skipped 0
```

The eight failing file names are identical; no newly failing file. Both new/changed test files pass under the bare command too.

Detailed diagnostic, from `bridge`:

```sh
timeout 250 node --test --test-isolation=none
```

```text
ℹ tests 805
ℹ pass 683
ℹ fail 120
ℹ skipped 2
```

Exit 1. Listener tests show the actual error:

```text
Error: listen EPERM: operation not permitted 127.0.0.1
```

A minimal child-process probe, unrelated to the project, also shows the restriction:

```js
import { spawnSync } from 'node:child_process';
const r = spawnSync(process.execPath, ['-e', 'process.stdout.write("child output\\n")'],
  { encoding: 'utf8', env: { PATH: process.env.PATH } });
console.log(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error?.code }));
```

```text
{"status":0,"stdout":"","stderr":"","error":"EPERM"}
```

An initial unchanged-baseline detailed run reproduced the 120 failing test names; it also had one extra scratch-only failure (`style.css: every DESIGN.md token is defined for light and dark, with focus and reduced-motion rules`) because its copied tree initially omitted `docs/design/DESIGN.md`. That document was then copied before the baseline bare-command comparison above. A repeated detailed baseline diagnostic reached its 250-second timeout (exit 124: 768 discovered, 601 pass, 105 fail, 60 cancelled, 2 skipped). It stalled in the pre-existing watcher tests under the same restrictions and is not a completed test run. No background check remains running.

From the repo root:

```sh
node bridge/watcher.mjs --config bridge/watcher.config.example.json --check-config
```

```text
OK
warning: no notification channel is configured; alerts are only logged
warning: WATCHER_LOCAL_TOKEN is not set; the local API stays disabled
```

Exit 0. `bash -n scripts/pi-setup.sh` and `git diff --check` both exit 0 with no output. The installer itself was not run.

## Mutation check

Scratch directory created with `mktemp -d /tmp/n1a-checks.XXXXXX`: `/tmp/n1a-checks.cYFtUa`. No `rm -rf` and no checkout changes. Driver: `/tmp/n1a-mutations.py`; run from the repo root:

```sh
python3 /tmp/n1a-mutations.py
```

Each command below ran in `/tmp/n1a-checks.cYFtUa/mutation/bridge`, after applying **one** mutation, and the original file was restored in `finally` before the next mutation:

| Mutation | Exact command | Actual output |
|---|---|---|
| Remove ID, URL and title dedupe from eligibility | `node --test --test-isolation=none --test-name-pattern 'dedupe persists across restarts' test/watcher/news.test.mjs` | exit 1; tests 1, pass 0, fail 1; unexpected second alert |
| Treat every selected symbol as seeded | `node --test --test-isolation=none --test-name-pattern 'first poll seeds' test/watcher/news.test.mjs` | exit 1; tests 1, pass 0, fail 1; initial poll alerted |
| Remove the maximum-age predicate | `node --test --test-isolation=none --test-name-pattern 'age floor drops' test/watcher/news.test.mjs` | exit 1; tests 1, pass 0, fail 1; stale headline present |
| Permit and skip a DOCTYPE declaration | `node --test --test-isolation=none --test-name-pattern 'refuses documents containing a DOCTYPE' test/watcher/atom.test.mjs` | exit 1; tests 1, pass 0, fail 1; `Missing expected exception.` |

```text
4/4 mutations killed; scratch files restored
```

The DOCTYPE mutant weakens both the explicit declaration guard and the generic unsupported-declaration branch, so it actually accepts a declared document; this is not a test of error wording alone. Logs: `/tmp/n1a-mutation-{dedupe,seeding,age-floor,doctype}.log`.

## Choices the plan left open

- Source switches live under `news.sources.{tradingview,sec}`; both default on inside the off-by-default news block. Missing/invalid contact skips SEC only.
- Seeding is per source, symbol, and SEC form. A successful nonempty broad response seeds the queried/mapped symbols even if it has no matching headline; empty/fully invalid first pages do not. A failed follow-up discards that window's first page and keeps its previous state for retry. An empty follow-up logs a gap and retains the nonempty first page.
- TradingView last-run times are per symbol, so adding/reordering symbols does not reset gap detection. The oldest successful time among the chunk's existing symbols sets the gap boundary.
- Hard budgets: TradingView 20 HTTP requests/run, chunks of 50; SEC 7/run, including map refresh and redirects. At most two same-host HTTPS redirects, 2 MiB responses, 15-second request deadlines, and at least 250 ms between SEC requests. Excess chunks are skipped with a budget warning. These limits cover the current 25-stream watchlist plus 200 extras and leave space for N2's later list.
- News titles are capped at 500 characters, IDs at 512, URLs at 2048; extractor fields retain the existing 16 KiB limit. Controls are stripped. SEC summary text never reaches alerts or records; only extracted item numbers do. SEC item numbers are capped at 20.
- TradingView paths must start `/news/`; queries, fragments, backslashes and dot-segments are refused. SEC filing links reject queries/fragments as well as foreign hosts, credentials and insecure schemes. This is stricter than the minimum host rule and avoids retaining token-bearing links.
- Dedupe uses source ID and normalized URL per symbol for `remember_hours`, then normalized title + ticker for six hours. Case/whitespace and simple title tags are normalized. Shared fresh items merge symbols before display and recording.
- State uses first-observed times, not refreshing a headline forever. In addition to TTL pruning, seen/title maps cap at 20,000 keys each, seed/run maps at 2,000; oldest keys are dropped first. Under extreme volume this can shorten dedupe retention or reseed inactive symbols; it bounds the Pi's memory footprint. Normal active symbols have their seeding/run times refreshed.
- `news.jsonl` is 0600 and capped at 5 MiB of newest complete JSON records, appended before delivery then compacted through an atomic replacement when needed. An external reader needs rotation handling. It contains all eligible fresh items, including those beyond the digest display cap, but excludes seeding/stale/filtered items. A record-write failure logs a generic warning and does not prevent alerts. Dry-run writes neither records nor the company cache.
- Keywords are case-insensitive headline substring matches; any include matches, excludes win. Bounds: 200 extra tickers; 100 keywords per list, 100 characters each; digest 1–50; retention >0–168 hours; maximum age >0–10080 minutes; interval 10–1440 minutes. Bare tickers warn and are skipped; malformed qualified extras error.
- No `critical` flag is set: one digest consumes one hourly slot. Quiet/overflow handling uses the existing pipeline's summary format. News requests are aborted at stop, and late results cannot mutate news state or submit alerts.

## Not done

No commit, push, merge, CI run, live fetch, Pi install/deploy, external agent call, global regime log, credentials-file access, dependency change, or edit to `notifiers.mjs`. `bridge/node_modules` was left alone. N1b sources, N2 wide-list integration, and AI pieces remain out of scope. Pi memory/live-source checks and an unrestricted full-suite run remain for Claude/the parent session. This was an author self-review only, as requested; no independent reviewer was called.

Full local verification logs are in `/tmp/n1a-focused.log`, `/tmp/n1a-suite-final.log`, `/tmp/n1a-suite-final-detail.log`, `/tmp/n1a-baseline-bare.log`, and `/tmp/n1a-baseline.log`.

## Current detailed failure names

- health over the real entry point: one protocol line, clean stderr, exit 0
- starts through a symlinked path too
- library-style console and stdout noise never reaches stdout, and stderr is redacted
- --check-config on the example config prints OK and exits 0
- --check-config on an invalid config lists every problem and exits 1
- --check-config on a file that is not JSON exits 1 without a stack trace
- a malformed webhook URL is reported by --check-config without echoing it
- usage errors exit 2 with the usage line
- --test-notify with no channel configured exits 1 and sends nothing
- --help prints the usage and exits 0
- the real files are served by createDashboard with the real allowlist
- it binds to the configured host and reports the real port
- a port already in use rejects listen() with EADDRINUSE, so the watcher can carry on without a dashboard
- only the request timeouts are set: no server.timeout, which would cut a quiet /events stream
- GET / and the three assets are served with the exact content types (nosniff makes a wrong module type fatal)
- the static allowlist is a fixed map: traversal and near-misses are 404
- a missing asset file is logged and answers 404 while everything else keeps working
- /api/streams lists symbol, timeframe, healthy and lastBarTime only
- /api/candles returns whitelisted candles for a configured stream, newest last, with a clamped limit
- /api/candles: an unknown or missing symbol or timeframe is 404 with a JSON error, never a crash
- /api/alerts is newest first with the whitelisted fields, null meta fields for old entries, and no dedupe key
- /api/alerts: limit is clamped to 1..500 and symbol and tf filter to one chart
- /api/levels returns the live price_cross levels for a symbol, including rules with no symbol, not expired ones
- /api/notes with the notes layer off: 200, enabled false, no notes
- /api/notes returns the notes for the stream, in the documented shape, and nothing else
- /api/notes: an unknown stream or a missing parameter is the same 404 as the other routes, and reads nothing
- /api/notes: a request cannot pick a file or a folder; only a stream's own symbol is passed on
- /api/notes follows the same rules as every route: 401 without the token, 403 for a foreign Host, 405 for POST, headers on all
- /api/notes: a notes layer that fails is a generic 500 and the server keeps serving
- /api/gauntlet and /api/paper are empty lists when the folders are missing or empty
- /api/gauntlet serves whitelisted summaries, newest file first, and never the reason or numbers
- hostile files in the gauntlet folder are ignored: bad names, symlinks, oversize, garbage, a mismatched fingerprint
- at most the 50 newest gauntlet files are read
- /api/paper joins each journal to the report with the same fingerprint, and keeps the last 50 whitelisted events
- a journal whose report is a symlink still shows, with null labels: the report is never followed out of the folder
- hostile files in the paper folder are ignored the same way: log.jsonl, bad names, symlinks, oversize
- only GET is allowed: every other method is 405 with an Allow header
- no CORS headers are ever sent, so another site cannot read the API
- a loopback dashboard without a token needs no credentials
- loopback Host check: only the host name counts (not the port), so an SSH tunnel works and DNS rebinding does not
- loopback Host check: an empty Host and a missing Host are both 403, with the security headers
- a token set on a loopback dashboard is required: loopback only drops the token when none is configured
- with a token: 401 without it, 401 for a wrong one (same length or not), 200 with Bearer
- ?token= once: a right token sets the cookie and redirects to the same URL without only the token parameter
- a wrong ?token= is 401: no redirect, no cookie
- a token with characters that are not cookie-safe survives the cookie round trip
- every status code carries the four security headers: 200, 302, 401, 403, 404, 405, 500 and 503
- an internal error is a generic 500 with no stack or message, and the server keeps serving
- malformed percent-encoding is never a crash: a bad path is 404, a bad query is just ignored
- /events is a text/event-stream, and a bar on the bus reaches the browser as an event
- an alert on the bus reaches the browser with the same fields as /api/alerts, minus the dedupe key
- a health event carries the stream list in the /api/streams shape
- bars are coalesced to one per stream per second: the first goes at once, the last is flushed later, the rest are dropped
- with no browser connected a bar costs nothing: no timer is created
- a heartbeat comment goes out every 20 s while a browser is connected, and the timer stops when the last one leaves
- at most 5 event clients; a 6th gets 503 until one leaves; the bus listeners do not pile up
- a client that stops reading is dropped instead of buffering without limit
- close() ends every event stream and removes the bus listeners
- the log shows the dashboard address but never a token or a request URL
- a malformed request gets a 400 that still carries the security headers
- a FIFO where a report should be is skipped at once: opening it would hang a worker thread for good
- the 1 MB file cap is exact: a file of exactly 1 MiB is read, one byte more is skipped
- Expect: with an unknown value is a 417 that still carries the security headers
- a client error after a response has started destroys the socket instead of writing a second response
- a correction to the closing candle and the next candle inside one second are both delivered, in time order
- a request timeout after the 405 closes the socket without a second response (real socket)
- /api/overview gives one card per stream, from the candles in memory
- /api/health shows the watcher state, and no field that was not listed (a cookie in the status never leaves)
- /api/trending lists the scan memory newest first, and marks a symbol the watcher follows
- /api/indicators draws the rules that apply to the stream, from indicators.mjs, and 404s anything else
- the panel endpoints work with no getStatus at all (nulls, not errors)
- the panel endpoints follow the same rules as every route: 401 without the token, 403 for a foreign Host, 405 for POST, headers on all
- a status function that throws is a generic 500 with the headers, and the server keeps serving
- /api/preview lists the rules that can be previewed on a stream, and nothing but ids and types
- /api/preview?rule= gives the hits of one rule over the closed bars, from the real evaluator
- /api/preview uses the watcher's session check for a us_session rule
- /api/preview is a 404 for a missing parameter, an unknown stream or rule, a rule for another stream and an expired rule
- /api/preview with no candles yet is an empty answer
- /api/preview looks at no more than 300 closed bars
- /api/preview is worked out once per (stream, rule, last closed bar): same answer until a bar closes
- /api/preview: simultaneous requests all get the same answer
- /api/preview follows the same rules as every route: 401 without the token, 403 for a foreign Host, 405 for POST, headers on all
- /api/preview: a composite whose member expires overnight is not answered from the cache
- /api/trending drops symbols older than the watcher's remember_hours
- /api/preview keeps one answer per stream: the same rule on two streams with the same candles is not shared
- the server binds to 127.0.0.1 only
- POST /notify without a token is refused with 401
- POST /notify with a wrong token of the same length is refused with 401
- POST /notify with a token of a different length is refused with 401, not an exception
- POST /notify with the right token is accepted with 202 and goes to submit
- a bad body is refused with 400 and the reason, without echoing the input
- a body over 8 KB is refused with 400
- GET /health needs no token and returns status without secrets
- unknown paths and methods get 404
- a failing submit returns 500 with a generic message
- a declared Content-Length over the limit is refused before the body is read
- an unauthenticated request is refused before its body is read, whatever the size
- GET /health never contains the token or any env secret name
- a symlink to a note, a symlinked folder, a directory called x.md and a FIFO are never read
- /render serves the render page as HTML with the same security headers as every page
- /render has the same auth and Host rules as the rest of the dashboard
- a disconnect is logged with its time and counted in /health
- POST /notify with the token sends a message through the same pipeline
- startup logs say whether TradingView credentials are in use, never their values
- without both cookies the watcher runs anonymous and says so
- the dashboard starts with the watcher on its own port, serves the API, and stop() frees the port
- dashboard.notes enabled: the watcher reads the configured folder and serves it on /api/notes; off by default
- a dashboard port that is already taken is logged, and the watcher carries on without it
- end to end: a rule alert reaches a browser on /events and then /api/alerts, with its meta
- the dashboard token never reaches a log, even through a ?token= visit
- the dashboard health panel reads the live watcher numbers and never a credential
- the dashboard health panel says anonymous when there are no TradingView credentials
- the dashboard trending panel reads the scanner memory in the state
- the dashboard preview uses the watcher's session calendar, judged by each bar's own open time and not the clock
- the dashboard trending panel forgets a symbol after remember_hours even when no scan has pruned it
- images on: the renderer gets the bound dashboard URL, the env browser path, the token and the limits; Discord gets the PNG
- the browser path comes from the config when the env has none
- when the image cannot be made the alert is text with a dashboard link, and the reason is logged
- stop() closes the renderer, and a renderer that was never needed is never built
- images on but the dashboard could not start: every alert still goes out as text, and the reason is logged once, not per alert

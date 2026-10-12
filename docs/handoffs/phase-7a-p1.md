# Phase 7a P1: dashboard core (server, security, events) - report

Design: `docs/handoffs/phase-7a-design.md` (approved). Regime 4: Sonnet 5.5 High lead; Luna Max wrote `journals.mjs` only. P2 (UI) is NOT started. `STATUS.md` is untouched (integrator only).

## What was built

| Step | Commit | What |
|---|---|---|
| 0 | `feb7215` | `lightweight-charts@5.2.1` exact, `--ignore-scripts`; the standalone `.mjs` is what gets served |
| 1 | `5b85ece` | `alerts.submit` keeps `meta` on history entries; guarded `onRecord(entry)` |
| 2 | `014d795` | `stream.mjs` keeps the latest snapshot (`candles(key)`), `lastBarTime` in `list()`, guarded `onBar` |
| 3 | `1f26377` | config `dashboard {enabled, host, port}` (true / 127.0.0.1 / 8788) |
| 4 | `22df47f` | `tokensEqual` exported from `localapi.mjs` |
| 5a | `a8358f1` | `bridge/lib/journals.mjs` (Luna Max; 15 tests passed unchanged) |
| 5b | `83243a4`, `ce05187` | `bridge/lib/dashboard.mjs`: read-only server, auth ladder, security headers on every status, SSE |
| 6 | `be60533` | `watcher.mjs` wiring: `bus`, health each tick, bind failures logged and skipped, `stop()` closes it |
| wrap-up | `1c85ff8`, `9bee408`, then the second-review fix (`fd615b8`) | review fixes below (tests first, then code) |

Full suite: **519 tests, 519 pass** (baseline 429). `--check-config` on the example config is OK.

## Review findings and verdicts

Three read-only reviews of `ce05187` (Fable, Luna Max, Sol). Each finding was checked against the code; the sandboxed reviewers had `EPERM` on real sockets, so theirs were static reads.

| Finding | Source | Verdict | Fix |
|---|---|---|---|
| FIFO in place of a report blocks `open()` and pins a libuv thread (4 shared with state flush and DNS) | Fable F1, Sol P1 | **Real, reproduced**: the new test hangs the process before the fix | `O_NONBLOCK` on open; `isFile()` rejects the FIFO |
| 1 MB cap checked on `stat()`, then `readFile` re-stats | Sol P2 | Real in principle, **not testable** (needs growth between two calls) | bounded read of `MAX + 1` bytes, looped to EOF (a single `read()` can be short on network filesystems, e.g. WSL 9p) |
| Corrected final values of the closing candle never reach SSE clients | Sol P2 | Real, test failed before | `stream.mjs` reports the closing candle before the new one |
| Coalescing keeps one pending candle, so a correction is lost when the next candle arrives within a second | Sol P2 | Real, test failed before | pending is a Map keyed by candle time, flushed in time order |
| `Expect: nonsense` gets Node's bare 417 without security headers | Sol P3 | Real, test failed before | `checkExpectation` handler goes through `sendError` |
| Omitting the `dashboard` block skips the port-clash check | Sol P3 | Real, test failed before | the default port is checked too |
| `clientError` can write a second response after one was sent | Luna | **Real, reproduced** by the wrap-up reviewer (my first attempt missed it: Node checks timeouts only every 30 s by default; lowering `connectionsCheckingInterval` shows a 405 followed by a 400 on the same socket). My first guard (`_httpMessage.headersSent`) was dead for it, because Node detaches `_httpMessage` when a response finishes | `socket.destroy()` when `bytesWritten > 0` (or a response is in flight); real-socket test added, a fresh socket still gets its 400 |
| Cookie `tvw_dash` (Path=/) is not port-scoped, so on a non-loopback bind other HTTP services on the host receive it | Fable F2 | Real, docs only | **Open**: one sentence for the README Dashboard section (design step 8), next to the SSH-tunnel advice |

Fable confirmed harmless (no action): Host check edge cases, auth ladder, redirect guard, headers on all statuses, SSE cap, coalescing, idle `/events` surviving `requestTimeout`, onBar/onRecord safety, shutdown paths, `meta` surviving restarts.

## Mutation check

59 mutants (script kept in the session scratchpad, not in the repo): **58 killed, 1 survivor**.
Survivor: `dashboard: unbounded read` (bounded read replaced by `readFile`). It only differs if a file grows between `stat()` and `read()`; the neighbouring mutant "cap off by one" does kill. Accepted.
Earlier run: 3 survivors found and fixed in `ce05187` (symlinked report, `.bak` names, one token guard).

## Wrap-up review (Fable, on the fixes only)

Verdict CHANGES REQUESTED: two low findings, both fixed (the `clientError` guard above and the short-read loop). One note left open: a rollover across a gap (previous bar T, newest T+3) reports T and T+3 only, so T+1 and T+2 reach the page only through a refetch of `/api/candles`; a late correction to an already-closed bar is dropped, consistent with evaluation.

## Smoke test (real TradingView, dry run, port 18788)

`/api/streams`, `/api/candles` (real BTCUSDT candles) and `/api/levels` OK; a forged Host gave 403; the chart asset was served as `text/javascript; charset=utf-8`; RSS about 86 MB. The 404s for `/`, `app.mjs`, `style.css` are expected (P2).

## Notes for P2

- `bar` events carry the changed candle, and now also the closing candle's final values on a rollover. The page should still refetch `/api/candles` on reconnect.
- Alerts outside the 500-entry history have no markers; `sameCandle` ignores extra candle fields.
- The CSP forbids inline script and style. Check in a real browser (Playwright) that `lightweight-charts` works under `style-src 'self'`; stop and ask if it needs `unsafe-inline`.
- Design deviations: response shapes follow the 7a brief (arrays); a token that is set is required even on loopback; `requireHostHeader:false` so a missing Host gets our 403 with headers; custom `clientError` 400 carries headers; the SSE slow-client rule is `writableLength > 256 KB`.

## Lessons

- A blocking `open()` on a path that did not pass an lstat/isFile filter is a process-wide hazard, because the 4-thread libuv pool is shared.
- Commit before running the mutation script: it `git checkout`s the file it mutates.

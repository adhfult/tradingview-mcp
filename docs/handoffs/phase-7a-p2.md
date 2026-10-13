# Phase 7a P2: dashboard page (done, local only)

Branch `claude/lucid-bardeen-3ou62p`, 8 commits after `b66a2f5` (HEAD `02b533c`), nothing pushed. Regime 3, Sonnet 5.5 High, no delegates. Design: `docs/handoffs/phase-7a-design.md` §7 step 7, §10. `STATUS.md` not touched (integrator only).

## What exists now

| File | Lines | Role |
|---|---|---|
| `docs/design/DESIGN.md` | 51 | tokens, markers, type, space, states; approved by the user before any other UI file |
| `bridge/dashboard/index.html` | 52 | landmarks, labelled stream picker, live badge, aria-live alerts list, per-panel status lines, retry banner, noscript, footer with the TradingView notice |
| `bridge/dashboard/style.css` | 163 | every DESIGN.md token for light and dark, focus ring, reduced motion, one column below 60rem |
| `bridge/dashboard/app.mjs` | 450 | pure functions (exported, tested in Node) plus the browser start-up, guarded by `typeof document` |
| `bridge/test/watcher/dashboard-page.test.mjs` | ~200 | 12 tests: HTML/CSS/JS static contracts, pure functions, and a served-through-`createDashboard` check with the real allowlist |
| `bridge/README.md` | +18 | "Dashboard" section; `watcher.env.example` names `WATCHER_DASHBOARD_TOKEN` |

`defaultAssets()` already pointed at `bridge/dashboard/`, so no watcher wiring was needed.

## Gates

- `timeout 200 npm test --prefix bridge`: **531 tests, 531 pass** (519 before, 12 new).
- `node bridge/watcher.mjs --config bridge/watcher.config.example.json --check-config`: `OK`.
- Mutation check on the page tests (committed first): cross-origin `getJson`, a second `fetch`, `window.open`, logo switched on, and `<meta http-equiv=refresh>` are each killed by the intended test. My first two mutants broke syntax and "died" for the wrong reason; they were redone as valid code.
- Playwright against a fake data server (real `createDashboard`, real assets, fake streams; script was in the scratchpad, not committed): console clean of CSP errors at 360 px, 1280 px light and dark; markers (arrows, "P in" / "P out" squares) and the level line visible; an injected `<img onerror>` alert title is shown as text (0 `<img>` elements); live alert arrives over SSE; kill and restart of the server gives "Reconnecting", then "Live" with data reloaded and no error banner; a bar rollover causes exactly one `/api/candles` request; with five tabs open the sixth shows "Live updates off, retrying".
- Page width at 360 px: `scrollWidth` 345 of 360, no horizontal scroll.
- RSS of the fake server process: about 65 MB with a browser connected and about 65 MB after it closed (64.9 vs 64.7 MB). That is the fake server alone, not the watcher; the P1 smoke baseline for the real watcher was about 86 MB. The difference a browser makes is below measurement noise here.

## Decisions worth knowing

1. **Chart attribution logo is off.** The library injects a `<style>` element for it, which `style-src 'self'` blocks (the console error showed it). The CSP stays fixed. The licence allows turning the logo off if the page carries the NOTICE text and a link to tradingview.com, which the footer does ("Copyright © 2026 TradingView, Inc."). Tests pin both: logo off in code (comments ignored), notice text and link in the HTML. Re-check the year and wording when the library is upgraded.
2. **Markers are arrows, not triangles.** The library draws only `arrowUp`, `arrowDown`, `circle`, `square`. DESIGN.md says so.
3. **Marker colours** cannot be CSS variables (canvas), so the pure functions return a `tone` and `app.mjs` resolves it from the computed style at draw time and again on a theme change.
4. **One `app.mjs`**, 450 lines, no split (ceiling was 800).
5. **Live bars:** same candle time is drawn in place; any other time reloads only `/api/candles` and keeps the user's zoom. A stream switch or SSE reconnect reloads everything.
6. **Deep link:** `?symbol=&tf=` selects a stream and is kept in the URL. `t=` (centre on a time) is P3.

## Review (Fable subagent, given the brief, plan and a saved diff)

No XSS or CSP finding: every server string reaches the DOM through `textContent`, `Option`, or the canvas. Verified findings and what was done (all in `c7adc98`):

| Finding | Severity | Done |
|---|---|---|
| A refused `/events` (503 for the 6th client, 401) closes the EventSource for good; the badge stayed "Reconnecting" forever | medium | badge "Live updates off, retrying", page retries every 15 s; README mentions the cap |
| Without the chart library each bar made four requests (one a disk scan) | medium | candles always updated in state; `series?.update` |
| Every rollover refetched four endpoints, reset the zoom and flashed the skeleton | medium | `reloadCandles()` fetches candles only; `fitContent` only on first load or stream change |
| `aria-live` list rebuilt on every refetch | medium | rebuild skipped when unchanged; a live alert is prepended as one row |
| Test "talks only to its own origin" never saw `getJson`'s paths | medium (test) | checks the single `fetch(path)` and every `getJson` literal; five mutants killed |
| Periodic re-renders dropped keyboard focus and closed the open dropdown | low | lists and picker rebuilt only when their content changes; focus restored by stream key |
| Stream switch could paint the new stream's bar on the old candles | low | `select()` clears candles |
| "No chart library" message overwritten by "Loading candles" | low | kept |
| Failed first load never recovered when the stream opened | low | `loadFailed` triggers a reload on open |
| Zero streams left "Loading alerts" forever | low | alerts load without a stream |
| Test gaps: meta refresh, form, `setHTMLUnsafe`, `window.open`, comment satisfying the logo check | low | added |

Not done, by choice:
- Token values are asserted by name only, not by contrast (DESIGN.md holds the measured ratios).
- Lists show a text loading line, not same-height skeletons as DESIGN.md says; only the chart shimmers.
- A resize after load keeps the old bar spacing until a reload (`autoSize` resizes the canvas, not the zoom).
- "Stale" shows on stock streams overnight and at weekends because `/api/streams` does not expose the market (a `ponytail:` comment and the README say so).
- Alerts older than the 500-entry history have no markers; `sameCandle` ignores extra candle fields (both P1 notes, unchanged).

## Leftovers and open items

- `.playwright-mcp/` in the repo root (my screenshots and logs) is untracked and not in `.gitignore`; deleting it was blocked by a hook, so the user decides.
- `HANDOFF.md` and `HANDOFF-P0-old.md` are untracked; the user can delete both.
- The 23 P1 commits plus these 8 are unpushed; the user chose to push after this review.
- Next: P3 (notes layer, regime 4) or P4 (extra panels, regime 3). P3 and P4 only need this page shell; the element ids are fixed by the HTML test.

# Phase 7a, P4: extra dashboard panels (B1-B11)

Branch `claude/lucid-bardeen-3ou62p`, not pushed (you said to hold the push until the work is done). Plan: `docs/plans/phase-7a-p4.md`. Design: `phase-7a-design.md` sections 9 and 10. Regime 3, Sonnet 5.5 High, no delegate for the build; reviews listed at the end.

## What now exists

- **Server:** `lib/dashboard-views.mjs` (pure view shaping), routes `/api/overview`, `/api/health`, `/api/trending`, `/api/indicators`, `/api/preview`, and `getStatus()` from `watcher.mjs` feeding them. Every route sits in the one `api` map of `dashboard.mjs`, so each inherits auth, the Host check, GET only and the four headers.
- **Page:** `app.mjs` split into `pure.mjs` (no DOM) and `dom.mjs`, plus `alerts-view.mjs`, `overview-view.mjs`, `status-view.mjs`. Five tabs (Overview, Chart, Alerts, Opportunities, Status), alerts tab with filters and per-rule daily counts, detail drawer, paper equity (realised exits only), save-as-PNG, tab-title badge, header badges, chart overlays for the rules' RSI and Bollinger lines (drawn from server numbers), and the rule noise preview.
- **B6, rule noise preview** (own commits, regime-6 care):
  - `lib/gates.mjs` `selectActive(rules, {now, timezone, inSession})`: the expiry / `us_session` / composite-member gate, lifted out of the `onClosedBar` closure. The watcher and the preview both call it, so they cannot drift. The 642 existing tests passed unchanged on the extraction commit (`12ad3d8`) before anything else was added.
  - `previewView` / `previewableRules` / `warmupBars`: the real `evaluateRules` on each prefix of the stored candles, up to the last 300 **closed** bars (the watcher keeps 300 candles and one is forming, so at most 299; the forming candle is never judged), gate per bar from the bar's own open time (the W2 lesson), hits only. Bars with less history than the rule needs are skipped and not counted (see Review).
  - `GET /api/preview?symbol=&tf=` lists the rules a stream can preview (ids and types only); `&rule=` gives the hits. Unknown stream, unknown rule, a rule for another stream, an expired rule, a missing parameter: the same 404 as `/api/candles`.
  - Cached per (stream, rule), one entry per pair, so memory is bounded by streams times rules; reused while the closed candles and the rule's live members are unchanged (a sum over the closed candles, and the rule as `selectActive` leaves it). The work is synchronous, so one computation runs at a time by construction.
  - Page: a rule picker, small grey arrows (up below the bar, down above), and the copy "N signals ... Signals only: cooldowns, daily limits and quiet hours are not applied, so the alerts actually sent would be the same or fewer. This is not a prediction."

## Gates

`timeout 200 npm test --prefix bridge`: **678 tests, 678 pass** (594 before P4, 642 before B6). `--check-config` prints `OK`.

Browser check (Playwright, a scratch fake-data server calling the real `createDashboard`, not committed): console clean; five tabs; drawer at 360 px; PNG download; overlays; overview, opportunities and status; B6: the picker lists the three rules, `rsi14` gives 32 signals over 300 bars with grey arrows at the turning points, the `us_session` rule gives fewer hits than the same rule without a calendar, choosing "Off" clears the arrows and the line.

RSS (fake server, Node 24 on this PC, dashboard only): about 73 MB resident with a browser connected, 8 preview requests, and again after the browser left; no growth visible at KB resolution. The real watcher adds its own streams and notifier on top; the Pi figure still needs a night on the Pi.

Cost of the preview (measured, `performance` timers, synthetic sine candles): rsi_cross 22 ms, bollinger_break 25 ms, `all_of` of three 30 ms at 400 bars; 66 ms for the composite at 1000 bars; 370 ms at 5000 bars. Streams hold a few hundred bars, so this is once per rule per closed bar. A `ponytail:` comment in `dashboard.mjs` names the ceiling (a worker thread if snapshots ever get that long).

## Decisions worth knowing

1. **Grey arrows instead of hollow markers.** Lightweight Charts 5.2.1 markers have shape, colour, text and size but no fill option, so "hollow" is not possible. Small (size 0.6) and grey (`--muted`) tells them from real alerts; the copy says "small grey arrows".
2. **`/api/preview` without `rule` lists the previewable rules.** The plan named only the `rule=` form, but the page needs to know which rules apply to a stream, and one more route would have repeated the rule filtering. Ids and types only; no thresholds or messages leave the server.
3. **Composites are previewed as a whole, members are not selectable.** A member of an `all_of` has its own id but only means something inside its parent; the gates still apply to members through `selectActive`.
4. **Sync computation, not a worker.** The plan said "one computation at a time". JavaScript runs the loop to the end before serving anything else, so that holds without a lock, and the cache keeps repeated asks free. A semaphore would only matter if the work became async.
5. **`inSession` is passed to the dashboard as a function** (`(ms) => isUsRegularHours(ms, usCalendar)`), default always true, rather than handing the dashboard the calendar. A test through the whole watcher feeds bars straddling the 09:30 open on a clock that reads Saturday and checks only in-session bars hit.
6. **Gate lookups use `Array.find`, not an object keyed by rule id**, so a rule called `__proto__` is just a 404.

## Not done / for later

- Previewing rules that live inside composites on their own; previewing an old date range (only what the watcher holds in memory).
- The Pi RSS number (needs the real watcher on the Pi for a night).
- 7b image alerts; `STATUS.md` is the integrator's.

## Review

Three read-only reviewers, each given the plan, the design sections and saved diff files (`/tmp/p4-review/`, not the transcript): a **Fable** subagent, **Codex Sol** (`gpt-6.1-sol`, high) and **Codex Luna Max** (`gpt-6-luna`) through `inv.sh`. (My first Luna call used `gpt-6.1-luna`, which does not exist; the script reports only "no reply", so check the slug first.) All three found the gate extraction identical to the old closure (`12ad3d8`), no prototype-key, auth/Host/method, XSS or marker-ordering problem, and no profit or prediction wording. Every finding below was checked against the code before it was fixed; the tests were committed failing first (`51b2b39`, fixes `0efa47f`).

Fixed:
- **The preview judged bars with too little history (Sol, Fable; Fable measured it).** The watcher judged each bar with a full 300-candle snapshot behind it; the preview gave bar *i* only the *i+1* candles before it. For finite-window rules that meant the first bars could never hit but still counted as "checked" (Sol: 199 signals over 299 "checked" bars where the watcher would have given 299). For `rsi_cross` it was worse: Wilder smoothing never forgets its seed, so values differed for the first third of the window (Fable: over 40 random walks, 10-20% of the count wrong, 68 missed and 52 invented in one setting). Now `warmupBars` skips bars below the rule's own minimum, five periods for RSI (the seed then weighs under 1%) and the slowest member for a composite, and `barsChecked` excludes them. Not exact: an RSI bar just past the warm-up can still differ slightly; the README says so. README and the `gates.mjs` comment no longer claim the preview "cannot drift from the real behaviour": the gates cannot, the history depth could.
- **Cache (Sol, Luna).** A composite member expiring overnight, or an earlier closed candle being revised without a new bar, was answered from the cache. The key is now the closed candles' sum plus the rule as the gates leave it. A mutation check then found that sharing the cache across streams survived; a test now pins it.
- **Trending retention (Sol).** The scanner prunes symbols older than `remember_hours` only when it scans successfully, so a closed market left stale rows. `getStatus` now carries `trendingRememberMs` and `trendingView` drops older rows.
- **Stale-load errors (all three).** A late failure for a stream already left cleared the new stream's overlay lines and preview picker; both catches now check `loadId`.
- **Alerts tab (Sol, Luna).** A filter value that left the history showed "Any" while still hiding every row (now reset); an alert arriving over SSE while the list was being fetched could be dropped (the fetch repeats once if an event arrived meanwhile).
- **Login badge (Luna).** "logged in" only meant both cookies are set; it now says "login cookies set", and the Status table "cookies set".
- **Stale tabs (Luna).** Opportunities and Status were fetched only when opened; the 60-second refresh now covers them while open.
- **Wording (Luna, Fable).** "last 300 bars" became "up to 299"; "fewer alerts" became "the same or fewer" (zero signals mean zero alerts, never fewer alerts than signals' complement); the README no longer says composite members cannot be previewed on their own, they are not offered separately because they are only offered when they are top-level rules.

Not fixed, on purpose:
- **Overlay lines on a forming bar (Sol).** The RSI and Bollinger lines are fetched when a bar closes or a stream is opened, so their last point (the forming bar) is behind the candle until then. The rules judge closed bars only, so no alert depends on it. Refreshing every second would cost a server computation per tick.
- **Page logic has no unit tests for the races.** `app.mjs` needs a DOM, which the test suite does not have; the stale-load guards, the alerts-filter reset and the SSE retry were checked in the browser (filter reset reproduced and fixed) but are not pinned by a test.
- **The Pi number for RSS** (see Gates).

Mutation check (everything committed first, each mutant `node --check`ed, full suite run for each, then `git checkout`): 21 mutants of the preview, cache, gates, warm-up, trending, ghost marker and copy code; 20 killed, 1 survived (the cache shared across streams), which is why `d508f41` exists. Mutants included: forming bar judged, session gate ignored, per-bar gate replaced by the rule itself, warm-up removed (all kinds), expired and other-stream rules offered, cache never invalidated, member expiry and revisions left out of the cache stamp, all rules listed, retention off, watcher not passing the calendar, `us_session` and `all_of` member gates off, ghosts unsorted or on unloaded bars, disclaimer dropped.

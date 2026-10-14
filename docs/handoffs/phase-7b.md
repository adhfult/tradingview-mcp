# Phase 7b: chart images on rule alerts

Branch `claude/lucid-bardeen-3ou62p`, not pushed (you said to hold the push until the work is done). Plan: `docs/plans/phase-7b.md`. Brief: `phase-7.md` section 7b. Regime 3, Sonnet 5.5 High, no delegates for the build; reviews by Fable, Codex Sol (`gpt-6.1-sol`) and Luna Max (`gpt-6-luna`).

## What now exists

When `images.enabled` is true, a rule alert on Discord or Telegram carries a PNG of the chart: the last 120 bars, an arrow on the alert's bar, and the rule's price level as a dashed line. Off by default. Any failure falls back to the text alert plus a `Chart: <dashboard link>` line.

- `lib/render.mjs`: on-demand Playwright (`playwright-core` 1.64.0 pinned, Apache-2.0, installed with `--ignore-scripts`, no browser downloaded; the system Chromium is used). Hourly cap, timeout, idle close, crash restart, dashboard token never in a log.
- `dashboard/render.html`, `render-page.mjs`, `render.css`, and `/render` in `lib/dashboard.mjs`: the page the browser opens. `pure.mjs` has `parseRenderQuery`, `renderPlan`, `drawPlan` (all checked values, tested without a browser).
- `lib/notifiers.mjs`: Discord multipart upload, Telegram `sendPhoto`, `withImages` (one render shared by all notifiers).
- `lib/format.mjs`: `chart` facts and the rule's level on rule alerts (`price_cross` level, `new_extreme` prior high/low, `bollinger_break` band). Composites have no level line.
- `lib/config.mjs` + `watcher.config.example.json`: the `images` block. `watcher.mjs`: lazy renderer wiring, `makeRenderer` injection for tests, env `WATCHER_CHROMIUM_PATH`.
- README section "Chart images on alerts".

## Decisions you approved

- **A, browser on demand, closed after 30 s idle.** Not kept open, because Pi RAM is the limit.
- **B, the `Chart:` link line only when images are on and the render failed.** Default alerts stay byte-identical to before 7b.
- **C, images need `dashboard.enabled`.** Otherwise `images disabled: ...` is logged once and alerts go out as text.

Dropped from the brief: `alert=<id>` in the render URL, because history entries have no id. The URL carries `symbol, tf, t, dir, level, rule`, each checked on the page.

## Gates

`timeout 250 npm test --prefix bridge`: **754 tests, 752 pass, 2 skipped** (the optional real-browser tests).
Real browser with the sandbox on: `WATCHER_TEST_CHROMIUM=/usr/bin/google-chrome node --test bridge/test/watcher/render.test.mjs bridge/test/watcher/watcher.test.mjs` -> 111 pass, 0 skipped. A sample PNG showed candles, the arrow, the labelled level and the credit line; the `/render` console was clean.

## Measured, and not measured

- Measured on this PC (Chrome, WSL2): summed RSS 972 MB is misleading because shared pages are counted per process; PSS from `/proc/<pid>/smaps_rollup` was **364 MB**.
- **Not measured: speed and memory on the Pi.** The 3 GB budget in your rules is unverified for Chromium. See "Checks only Adham can run" in `STATUS.md`.

## Reviews (Fable, Codex Sol, Luna Max): findings and fixes

Tests were committed failing first (`d5b1122`), fixes in `a0d431b`.

| Finding | Fix |
|---|---|
| Chromium ran with no sandbox: Playwright adds `--no-sandbox` unless `chromiumSandbox: true` | Sandbox on unless uid 0; checked by reading `/proc/*/cmdline` |
| A launch slower than `timeout_ms` was never cancelled (orphan browsers, two pages) | One shared launch, a per-render `abandoned` flag, a late browser adopted by the idle timer |
| `render()` after `close()` relaunched; `close()` waited for the render in flight | `closed` flag; close cancels the current render |
| Timeout waited on `browser.close()` before releasing the text fallback | Not awaited any more |
| A refused Telegram photo (HTTP 400) dropped the whole alert | 400/413 on a picture is re-sent as text in the same send (Discord too); 429/5xx still go to the queue's retry |
| Telegram caption cut counted serialized HTML | Counted as parsed text (1024) |
| `route()` cannot see service workers | `serviceWorkers: 'block'` |
| One log line per alert when the dashboard never started | Once; a `stopping` guard stops new browsers during shutdown |
| Annotation drawing untested | `drawPlan(lib, element, plan, colours)` with a fake lib |
| README overstated (Pi, sandbox, timeout) | Corrected |

## Mutation check

37 mutants in total (the 21 from the build session, then 16 more in this one). **35 killed, 2 survived**, both accepted:

1. The first `live()` check in `capture()` (`lib/render.mjs`) is redundant with the later ones. An abandoned render opens and closes one extra context but never a page. No test added.
2. The `stopping` guard in `watcher.mjs` (`imageRenderer.render`). To reach it a send has to be in flight when the shutdown drain gives up, and a render then starts afterwards. The harness cannot stage that cheaply. The `stop()` test covers the renderer being closed; the guard only covers a job that starts late.

Killed in this session: `withImages` link when no base URL, the three level picks in `format.mjs`, `drawPlan` arrow colour and level line, `renderPlan` window size and always-built level, `/render` served as JS, log-once, env path ignored, renderer not closed on stop, fixed dashboard port, `images.max_per_hour` min 0, IPv6 brackets in `dashboardBaseUrl`.

## Limits to remember

- `route()` does not cover redirects or WebSockets. The dashboard has none that leave its own origin.
- No user namespaces means no sandbox, so the render fails and the alert goes out as text (no silent `--no-sandbox`).
- The picture is the light theme only. Composites have no level line.
- Needs the real dashboard address, so it only works when the dashboard actually started.

## Traps

- `~/dotfiles/scripts/inv.sh` is not executable: `INV_FROM=claude bash ~/dotfiles/scripts/inv.sh --file <briefing> codex gpt-6.1-sol high`.
- The shared `createFakeFetch()` default responder throws in this Node: pass `() => jsonResponse(200, {})`.
- Run mutation scripts with `nohup ... &`, slice with `FROM`/`TO`, and check `git status --short` afterwards (a foreground run killed at the 600 s tool limit once left a mutated `notifiers.mjs`).
- Codex reviewers' sandbox cannot bind sockets (`listen EPERM`).

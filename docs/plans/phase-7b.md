# Phase 7b: chart images on alerts (plan, awaiting approval)

Brief: `docs/handoffs/phase-7.md` section 7b. Regime 3 (Sonnet 5.5 High, no delegates), same as 7a P4. Off by default; any failure falls back to the text alert.

## What exists today (read, not assumed)
- `notifiers.mjs`: `postJson` only; Discord/Telegram take a `message` `{level,title,lines,url?,timestamp}`; `queue.mjs` calls `notifier.send(message)` once per notifier.
- Dashboard (`lib/dashboard.mjs`) is read-only, loopback by default, already serves `/api/*`, assets via `defaultAssets()` (a test fails if a module is missing), `lightweight-charts` standalone, strict CSP, Host check on loopback.
- `message.url` is currently the TradingView chart link for rule alerts.
- Chromium here: `/usr/bin/google-chrome` and Playwright's own `~/.cache/ms-playwright/chromium-1243` (for the optional smoke test). Pi: `/usr/bin/chromium`.

## Steps (tests first, each its own commit, as in 7a)
1. **Dependency**: `playwright-core` exact latest, `npm install --ignore-scripts --save-exact`, licence recorded in STATUS. Never `playwright install`.
2. **Config** `images: {enabled:false, chromium_path:"", max_per_hour:6, timeout_ms:10000}` + `WATCHER_CHROMIUM_PATH` env override; validation; example config; enabled with no path (or dashboard disabled) logs "images disabled: <reason>" and runs without images.
3. **Render route** in the dashboard: `/render?symbol=&tf=&alert=<id>` + `render.html`/`render.mjs` (own module, registered in `defaultAssets`). Draws last 120 bars, the alert marker, the rule level from data the dashboard already serves; sets `window.__ready = true`. Same auth and Host rules as every other route (a configured token is sent by the renderer as a header).
4. **`lib/render.mjs`**: lazy `import('playwright-core')`, launch, screenshot of the chart element, `timeout_ms`, hourly cap, restart after crash, `--no-sandbox` only when uid is 0 (comment says why). Browser injected in tests (no real browser).
5. **Notifiers**: Discord `multipart` (`payload_json` + `files[0]`, embed `image.url = attachment://chart.png`); Telegram `sendPhoto` (caption <= 1024, HTML-escaped, fall back to `sendMessage` if the caption would be cut badly). Render once per message, shared by both channels.
6. **Fallback line** `Chart: <dashboard link>` when images are enabled and the render failed or was capped.
7. Real-browser smoke test, skipped unless `WATCHER_TEST_CHROMIUM` is set; run once by hand against Chrome here, result in the report. Playwright check of `/render` console/CSP. README, report `docs/handoffs/phase-7b.md`, STATUS row.
8. Wrap-up review: Fable (fallback Opus) on this plan + saved diff; Sol (security: it launches a browser and builds multipart bodies) and Luna Max (`gpt-6-luna`). Fix findings tests-first. Regime log, segmem note.

## Decisions I need from you
- **A. Browser lifetime.** Brief says keep one browser open. On the Pi (3 GB budget) an idle Chromium is roughly 150-300 MB for at most 6 renders an hour. I recommend **launch on demand, close after 30 s idle**. Costs 1-2 s extra on a render, saves the RAM. (Brief's way is one constant away.)
- **B. Fallback link.** Brief adds `Chart: http://127.0.0.1:8788/...` "when images are off or fail". Doing it when images are *off* changes every existing alert's text, and 127.0.0.1 only works over the SSH tunnel. I recommend adding it **only when images are enabled and the render failed**, using the dashboard deep link (`/?symbol=&tf=&t=`). Default alerts stay byte-identical.
- **C. Dashboard off.** Images need the dashboard route, so `images.enabled` with `dashboard.enabled: false` disables images with a log line (no second server).

## Not doing
Per-rule image toggles, image caching/storage on disk, any images for health/notify messages (rule alerts only), any hosted rendering.

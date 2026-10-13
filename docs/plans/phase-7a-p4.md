# Phase 7a P4: extra dashboard panels (B1-B11)

Source design: `docs/handoffs/phase-7a-design.md` section 9 (panel table, why B3 and B6 are shaped as they are) and section 10 (UI standards). Regime 3, Sonnet 5.5 High, no delegates. Approved by the user on 2026-10-13: all of B1-B11, B6 last and as its own commit, new `bridge/dashboard/*.mjs` modules allowed. Push is held until the user says the work is done.

Rules for every step: tests first and committed failing, then the code, then a commit. Read-only: no write path, no TradingView call, no new dependency. Existing tests (`dashboard-page.test.mjs` element ids and `shown` signatures, the 429 `onClosedBar` tests) pass unchanged.

| # | Step | Files | Proof |
|---|---|---|---|
| 1 | One injected `getStatus()` from `watcher.mjs` (health, stream counters, queue pending, sends, digest, trending). Endpoints `/api/overview` (B1), `/api/health` (B2), `/api/trending` (B5; check the stored symbol format first), `/api/indicators` (B3; server-side, calls `indicators.mjs`). | `lib/dashboard.mjs`, `watcher.mjs`, tests | endpoint tests, auth parity, no secret values in `/api/health` |
| 2 | Move the pure helpers out of `app.mjs` into modules, no behaviour change; add the modules to `defaultAssets()`. | `dashboard/app.mjs`, new modules | existing page tests unchanged |
| 3 | Client-only panels: B8 alerts tab, B4 alert drawer, B9 header badges, B10 tab-title badge, B7 PNG (check `takeScreenshot` in lightweight-charts 5.2.1), B11 realised paper equity. | `index.html`, `style.css`, `app.mjs`, modules | page tests, Playwright |
| 4 | Panels fed by the new endpoints: B1 overview landing page, B2 health panel, B3 overlays, B5 opportunities. | same | page tests, Playwright |
| 5 | B6 rule noise preview, its own commit. First extract the gate into `selectActive(rules, {now, timezone, inSession})`, used by `onClosedBar` and the preview; the existing tests must pass unchanged before anything else. `/api/preview?symbol=&tf=&rule=`: hits only, last 300 bars, cached per (stream, rule, last closed bar), one computation at a time. | `watcher.mjs`, new gate module, `dashboard.mjs`, page | 429 `onClosedBar` tests unchanged, preview tests |
| 6 | Playwright check (CSP console clean, 360 px, RSS with and without a browser), README section, `docs/handoffs/phase-7a-p4.md`, wrap-up review (Fable subagent on this plan and the saved diff, focus on the gate extraction), regime log. | docs | all gates green |

Gates: `timeout 200 npm test --prefix bridge` from the repo root (baseline 594 pass), `node bridge/watcher.mjs --config bridge/watcher.config.example.json --check-config` -> `OK`.

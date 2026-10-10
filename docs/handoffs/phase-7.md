# Phase 7: charts (Lightweight Charts dashboard, alert images) and Pine logic (PyneCore)

Three parts, each run separately: **7a** dashboard, **7b** alert images, **7c** PyneCore. Each part gets its own implementation report and review.

## Verified facts (checked by Opus from the published packages)
- **`lightweight-charts` 5.2.1** (Apache-2.0, Copyright 2023 TradingView, Inc.)
  - **Self-contained ESM build:** `dist/lightweight-charts.standalone.production.mjs`. Serve this file as-is; it needs no bundler and no CDN.
  - **Named exports:** `createChart`, `CandlestickSeries`, `HistogramSeries`, `LineSeries`, `createSeriesMarkers`.
  - **v5 interface:**
    - `const chart = createChart(el, {layout: {attributionLogo: true}, ...})`
    - `const s = chart.addSeries(CandlestickSeries, opts)`
    - `chart.addSeries(HistogramSeries, {priceScaleId: ''}, paneIndex?)`
    - `createSeriesMarkers(series, markers)`, where markers = `[{time, position: 'aboveBar'|'belowBar'|'inBar', shape, color, text}]`
    - `series.createPriceLine({price, color, title})`
  - **Licence requirement:** the attribution notice, plus a link to https://www.tradingview.com/ on the page. The built-in `attributionLogo: true` satisfies the link requirement. Also keep a footer credit.
  - `time` for bars is a UTC timestamp in **seconds**.
- **`playwright-core`** latest is 1.64.0 (Apache-2.0). Chromium on the Pi: `/usr/bin/chromium` (apt `chromium`). In this cloud container a Playwright Chromium exists at `/opt/pw-browsers/chromium-*/chrome-linux/chrome`; tests must **not** need it (mock the renderer).
- **`pynesys-pynecore`** 6.10.9 on PyPI. **Needs Python ≥ 3.11.** Licence not in PyPI metadata (the GitHub README says Apache-2.0; check the installed `LICENSE` or dist-info).

---

## 7a: local dashboard (watcher-served)

### Brief (Opus)
**Goal:** a read-only, localhost-only web page served by the watcher, showing:
- live candles for each watchlist stream
- alert markers
- rule levels
- paper trades (Phase 6b journals)
- gauntlet reports (Phase 6a)

**Read first:**
- `bridge/watcher.mjs` and `bridge/lib/*.mjs` (Phase 5): the stream manager, state (the last 500 alerts), config, `localapi.mjs`, redaction
- `docs/handoffs/phase-5.md` and `phase-6a.md` / `phase-6b.md` for file locations (`$TRADINGVIEW_MCP_HOME/gauntlet/*.json`, `paper/*.jsonl`)

**Dependency:** add `"lightweight-charts": "5.2.1"` (exact) to `bridge/package.json` with `npm install --ignore-scripts --save-exact lightweight-charts@5.2.1`. Check the lockfile `resolved` URL is `registry.npmjs.org`.

**Files:**
- `bridge/lib/dashboard.mjs`: the HTTP server (`node:http`). Re-use or extend the local API server if that's cleaner. Same process.
- `bridge/dashboard/index.html`, `bridge/dashboard/app.mjs`, `bridge/dashboard/style.css`: static, **no inline scripts or styles**, because of CSP.
- Tests: `bridge/test/watcher/dashboard.test.mjs`.

**Config:** `dashboard: {enabled: true, host: "127.0.0.1", port: 8788}`, validated in `config.mjs` (port 1024–65535).

**Security:**
- If `host` isn't a loopback address (`127.0.0.1`, `::1`, `localhost`), `WATCHER_DASHBOARD_TOKEN` must be set, or the dashboard refuses to start (log the reason).
- **Auth when not loopback:**
  - Accept `Authorization: Bearer <token>`.
  - Or accept `?token=<token>` **once**: it sets cookie `tvw_dash=<token>; HttpOnly; SameSite=Strict; Path=/`, then redirects to the same URL without the query.
  - Constant-time compare.
  - **Loopback needs no token.**
- **Headers on every response:**
  - `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `X-Frame-Options: DENY`
- Only GET routes. Unknown path → 404. No directory listing. Static files are served only from a fixed allowlist map (no path joins from user input).

**Routes:**

| Route | Returns |
|---|---|
| `/` | `index.html` |
| `/assets/app.mjs`, `/assets/style.css` | static files |
| `/assets/lightweight-charts.mjs` | `node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.mjs` |
| `/api/streams` | `[{symbol, timeframe, healthy, lastBarTime}]` |
| `/api/candles?symbol=&tf=` | from the stream manager's in-memory latest snapshot: `[{time, open, high, low, close, volume}]` (validate symbol and tf; 404 for unknown streams) |
| `/api/alerts?limit=100` (≤ 500) | from state; only the fields needed: `ruleId, symbol, timeframe, barTime, direction, message, values` |
| `/api/levels?symbol=` | `price_cross` rule levels for that symbol |
| `/api/paper` | summaries from `$TRADINGVIEW_MCP_HOME/paper/*.jsonl` (last 50 events per file) |
| `/api/gauntlet` | summaries from `$TRADINGVIEW_MCP_HOME/gauntlet/*.json` (`fingerprint`, `strategy`, `symbol`, `verdict`, `created_utc`, gate statuses) |
| `/events` | server-sent events: `bar` (symbol, tf, candle), `alert` (alert), `health` (streams). Heartbeat comment every 20s. |

**Frontend (`app.mjs`):**
- Import from `/assets/lightweight-charts.mjs`.
- A stream picker, then one chart:
  - candles
  - volume histogram on its own price scale
  - alert markers (green `arrowUp` below the bar for up, red `arrowDown` above for down)
  - `price_cross` levels as price lines
  - paper entries and exits as markers ("P↑" / "P↓")
- Side panels: the latest alerts list, gauntlet reports, paper summary.
- Live updates from `EventSource('/events')`.
- `layout.attributionLogo: true`.
- Footer: `Charts by <a href="https://www.tradingview.com/">TradingView</a> Lightweight Charts™ (Apache-2.0).`
- Plain, readable CSS with dark and light themes via `prefers-color-scheme`.

**Tests (hermetic; start the server on port 0):**
- each API route's shape
- 404s
- static allowlist (a path-traversal attempt such as `/assets/../package.json` returns 404)
- CSP and other headers present
- loopback needs no token
- non-loopback host without a token refuses to start
- with a token: 401 without it, 200 with Bearer, and the `?token=` flow sets the cookie and redirects
- server-sent events send an event when the stream manager emits a bar or alert (fake emitter)
- the HTML contains the TradingView attribution link

**Acceptance:**
- `cd bridge && npm test` green, plus everything before.
- `node bridge/watcher.mjs --config bridge/watcher.config.example.json --check-config` → OK. Update the example with the `dashboard` block.
- README "Dashboard" section: open `http://127.0.0.1:8788` on the Pi, or use an SSH tunnel from another machine: `ssh -L 8788:127.0.0.1:8788 pi@<pi>`. Recommend the tunnel over a non-loopback bind.

---

## 7b: chart images on alerts (optional; off by default)

### Brief (Opus)
**Goal:** when enabled, attach a PNG of the chart (last 120 bars, the alert marker, the rule level) to Discord/Telegram alerts. **Off by default.** Any failure falls back to the text alert plus a dashboard link.

**Dependency:** `playwright-core` exact latest (1.64.0, or whatever `npm view playwright-core version` says), `npm install --ignore-scripts --save-exact`. **Never run `playwright install`.** The browser path comes from config or env.

**Config:**
- `images: {enabled: false, chromium_path: "", max_per_hour: 6, timeout_ms: 10000}`
- `WATCHER_CHROMIUM_PATH` env overrides `chromium_path`
- enabled but no path → log "images disabled: no chromium path" and run without images

**Files:**
- `bridge/lib/render.mjs`:
  - lazy `import('playwright-core')`
  - one browser kept open (`chromium.launch({executablePath, headless: true, args: ['--no-sandbox']})`); add `--no-sandbox` only if `process.getuid?.() === 0` and say why in a comment
  - a page loads the dashboard's internal route `/render?symbol=&tf=&alert=<id>` (loopback only; served by 7a's server; a minimal page that draws one chart and sets `window.__ready = true`)
  - wait for `__ready`
  - `element.screenshot({type: 'png'})`
  - enforce `timeout_ms` and the hourly cap
  - restart the browser after a crash
- `notifiers.mjs`:
  - **Discord:** when an image exists, send `multipart/form-data` with `payload_json` (the same JSON) plus `files[0]` (`chart.png`); reference it in the embed `image.url = "attachment://chart.png"`.
  - **Telegram:** `sendPhoto` multipart (`chat_id`, `photo`, `caption` ≤ 1024 chars HTML-escaped, `parse_mode: HTML`); fall back to `sendMessage` if the caption would be cut badly. Use `FormData` and `Blob` from Node globals.
- When images are off or fail, add a line `Chart: http://127.0.0.1:8788/?symbol=...&tf=...` (the dashboard link) to the text.

**Tests (mock the renderer; no real browser):**
- disabled by default
- enabled with no path disables itself with a log line
- the hourly cap
- a render timeout leads to a text fallback
- the Discord multipart body contains `payload_json` and `files[0]`
- Telegram `sendPhoto` fields
- caption length handling
- the browser restarts after a simulated crash
- **an optional real-browser smoke test**, skipped unless `WATCHER_TEST_CHROMIUM` is set (the cloud container has `/opt/pw-browsers/...`; run it once manually and record the result in the report)

**Acceptance:** `npm test` green; the example config has an `images` block with `enabled: false`; README note.

---

## 7c: Pine logic in the gauntlet with PyneCore (optional Python extra)

### Brief (Opus)
**Goal:** let `strategy_gauntlet` run a local Pyne strategy script, `strategy="pine:<name>"`, through all gates, plus a lookahead check and an indicator-parity check against known values.

**Step 0 (must report before building):**
1. Add the optional extra in `pyproject.toml`: `pine = ["pynesys-pynecore==6.10.9; python_version >= '3.11'"]`. Use the exact latest at build time if newer, and record it.
2. Install it with `uv sync --extra pine`, which updates `uv.lock`.
3. From the installed package (dist-info `LICENSE` / `METADATA`), report:
   - **the licence**. If it isn't permissive (MIT, BSD, Apache-2.0), stop and report without building further.
   - **how to run a script programmatically on our own OHLCV data**, offline. Read the package source (`pynecore/...`): look for the runner, script loading, and data/OHLCV providers or formats, and how strategy trades are reported (`strategy.*`, trade lists or a CSV output).
   - **whether compiling Pine to Pyne needs PyneSys's online service or an API key.** We only support **hand-written or pre-compiled Pyne `.py` scripts that run offline**. Never send scripts anywhere.
4. Write those findings at the top of your report.

**Files:**
- `src/tradingview_mcp/core/services/pine_service.py`:
  - `list_scripts()`, `run_script(name, candles, params) -> trades`, `available() -> (bool, reason)`
  - scripts **only** from `$TRADINGVIEW_MCP_HOME/strategies/`, names matching `^[a-z0-9_-]{1,64}$` (`<name>.py`), never paths
  - **running a Pyne script runs Python code.** Document it; never download scripts.
  - Convert PyneCore's trades into this repo's trade dicts, with `entry_idx`, `exit_idx`, `entry_price`, `exit_price` and dates, so `_apply_costs` and `_calc_metrics` work.
- **Gauntlet support:** in `gauntlet_service.py`, accept `strategy="pine:<name>"`.
  - Parameter sensitivity uses the script's declared numeric inputs if PyneCore exposes them; otherwise that gate is SKIPPED with the reason.
  - Add a `lookahead` check for Pine scripts: run on `candles[:k+1]` vs the full series for sampled k, as in `test_no_lookahead.py`. A difference means **FAIL**, with the reason "script repaints or uses future data".
- **Parity fixture:** `tests/unit/fixtures/pine_parity.json` with fixed OHLCV (deterministic generator), plus values from **this repo's** `indicators_calc` RSI(14), EMA(20) and BB(20, 2). A test runs equivalent Pyne indicator code on the same candles and asserts agreement within a tolerance you record. Skip the test when the extra isn't installed or Python < 3.11, using `pytest.importorskip`.
- **Example script:** `docs/examples/pine/ema_cross.py`, a minimal Pyne EMA-cross strategy, with instructions to copy it to `~/.tradingview-mcp/strategies/`.
- **Without the extra, or on 3.10:** `strategy="pine:..."` returns `make_error(ErrorCode.DEPENDENCY_MISSING, "Pine support needs Python 3.11+ and: pip install 'tradingview-mcp-server[pine]'")`.
- **MCP:** `strategy_gauntlet` accepts the `pine:` prefix (docstring); a new tool `pine_scripts()` lists available scripts (names only).

**Tests:**
- name validation (`../x`, `X`, too long)
- refusal outside the folder
- the dependency-missing envelope
- trade conversion on a fake PyneCore result
- the lookahead check catches a deliberately leaky fake runner
- parity (skipped when not installed)
- CI's Python 3.10 job must still pass, since everything is skipped or guarded there

**Acceptance:**
- `uv run pytest tests/unit -q` green, with and without Node.
- The base install, without the extra, has unchanged dependencies (check `uv pip compile` or that the extra is optional only).
- The report has the step 0 findings.

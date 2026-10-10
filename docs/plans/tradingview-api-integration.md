# Plan: add TradingView-API (Mathieu2301) to tradingview-mcp

Hand this whole file to a new Claude Code session working on `adhfult/tradingview-mcp`.

## Context

This repo is a Python MCP server (FastMCP, `src/tradingview_mcp/server.py`) with 37 read-only market-data tools. Its data has three known weaknesses:

- **Anonymous access only.** Indicator snapshots come from TradingView's undocumented `scanner.tradingview.com` endpoint, and no login cookies are ever sent (`_scan_with_retry(cookies=None)` in `core/services/screener_provider.py`). Stock data is therefore often delayed.
- **No real price history from TradingView.** Candle history comes only from Yahoo's unofficial chart API (`backtest_service._fetch_ohlcv`). It is limited to daily or hourly bars, 2 years at most.
- **Old data can look fresh.** When TradingView fails, the cache fallback in `screener_provider.py` (`_scan_with_retry`, `resilient_get_multiple_analysis`) serves results up to 6 hours old. Nothing in the response says the data is old.

The owner has a TradingView account and wants to add **[Mathieu2301/TradingView-API](https://github.com/Mathieu2301/TradingView-API)** (npm `@mathieuc/tradingview`, v4, TypeScript/ESM, Node ≥ 20.19). It connects the way TradingView's own chart page does, and gives:
- real candles at any timeframe, with deep history
- quotes
- built-in and Pine indicator values
- symbol search
- screener results

All of it is authenticated with the owner's session cookies, so data matches what their TradingView plan allows.

**Goal:** add authenticated TradingView data as the preferred source. Keep the current sources as automatic fallbacks, and make the age and origin of all data visible.

## Decisions already made (keep them unless something is technically impossible)

1. **Single MCP server, Node helper process.** The Python server stays the only MCP server. A small Node helper (`bridge/`) runs as a long-lived child process the Python server starts on first use. The two talk over newline-delimited JSON-RPC on the child's stdin/stdout.
   - No network port is opened.
   - One TradingView connection is reused across tool calls.
   - The Python side has to cope with the helper not starting or crashing (see Phase 3).
2. **Optional.** If Node, the helper or credentials are missing, every existing tool works exactly as today. New tools return a clear "not configured" error envelope, built with the existing `make_error` in `core/errors.py`.
3. **Credentials come from environment variables only:** `TRADINGVIEW_SESSION_ID` (`sessionid` cookie) and `TRADINGVIEW_SESSION_SIGN` (`sessionid_sign` cookie).
   - Never log them, never put them in errors or tool output, never commit them. Add a test that checks for redaction.
   - Document in the README that this is the owner's real account. Automated use can break TradingView's terms and get an account flagged, so keep traffic low.
4. **No live streaming in the MCP tools.** MCP tools answer one request at a time, so the helper uses only the library's one-shot calls (`getCandles`, `getQuote(s)`, `getIndicatorData`, `searchMarkets`, `getScreener`). Streaming (`watch*`) is used only by the separate Phase 5 watcher.
5. **Supply-chain safety is mandatory.** Copies of this repo published under other accounts have spread malware through a `package.json` (see the README warning and SECURITY.md).
   - Pin `@mathieuc/tradingview` to an **exact** version and commit `bridge/package-lock.json`.
   - Install with `npm ci --ignore-scripts`. Use no other runtime dependencies unless strictly needed.
   - Put `package.json` only under `bridge/`, never at the repo root.
   - Update the README security note: the repo now has one Node helper with exactly one dependency.

## Phase 0: make cached data say how old it is (do this first, on its own)

The goal is that no tool can hand out old cached data that looks fresh.

**`core/services/screener_provider.py`:**
- Store `as_of` (Unix time) next to each cached entry.
- Track whether the last result returned for a given cache key came from the fallback. A tiny accessor works, or return an `(payload, meta)` pair internally. This must not break the "drop-in replacement" contract of `resilient_get_multiple_analysis`.

**Each tool's response:**
- Add a `data_freshness` block to the response of every tool that goes through `_scan_with_retry` or `resilient_get_multiple_analysis`. Do it in the service functions, or in one helper the tools call.
- Contents: `{source: "tradingview_scanner", as_of_utc, age_seconds, stale: bool, auth: "anonymous"|"session"}`.

**Tests** in `tests/unit/services/test_screener_provider_resilience.py`:
- a fresh result reports `stale: false`
- a fallback result reports `stale: true` and the right age

Commit this phase separately.

## Phase 1: helper skeleton (`bridge/`)

**Files:**
- `bridge/package.json`: `"type": "module"`, `"private": true`, one dependency (exact version), `engines.node >= 20.19`.
- `bridge/package-lock.json`.
- `bridge/server.mjs`.
- `bridge/README.md`.

**Before writing the helper, check the library's real interface.** Read `docs/data-api.md` in the upstream repo and the `.d.ts` files in the installed package for exact names, arguments and return shapes. My knowledge of the library comes only from its README. Notes from that README:
- Symbols look like `EXCHANGE:SYMBOL`.
- Timeframes are `'1'`, `'5'`, `'60'`, `'240'`, `'D'`, `'W'`, `'M'`.
- Credentials are passed as `credentials: { session, signature }`.
- An optional shared `client` can be passed in.
- Errors are `TradingViewError` objects with a `code`.

**Protocol:**
- One JSON object per line.
- Request: `{id, method, params}`. Response: `{id, result}` or `{id, error: {code, message}}`.
- Send nothing else to stdout. Logs go to stderr, with credentials redacted.

**Methods (each a thin wrapper around a library call, with a `timeoutMs`):**

| Method | Library call |
|---|---|
| `health` | no TradingView call: returns library version, whether credentials are present, Node version |
| `candles` | `getCandles({symbol, timeframe, count?, from?, to?})`, returns `[{time, open, high, low, close, volume}]` |
| `quotes` | `getQuotes(symbols[])` |
| `indicator` | `getIndicatorData({symbol, timeframe, indicator, inputs?, count?})`. Supports built-in `STD;…` ids and the owner's Pine ids |
| `search` | `searchMarkets(query, {type?})` |
| `screener` | `getScreener(...)`. Only add it if its shape is clearly useful; otherwise leave it out |

**Behaviour:**
- Reuse one shared library client for the whole process.
- Allow at most 2 TradingView requests at once, configurable with `TRADINGVIEW_BRIDGE_MAX_INFLIGHT`.
- Turn library errors into stable codes: `SYMBOL_ERROR`, `TIMEOUT`, `AUTH_ERROR`, `RATE_LIMITED`, `UPSTREAM_ERROR`.

**Tests:** add a small set of Node tests (`node --test`) that mock the library module and check protocol framing and error mapping.

## Phase 2: Python client (`core/services/tv_bridge_client.py`)

**Starting the helper:**
- Start `node bridge/server.mjs` the first time it's needed. The Node path can be overridden with `TRADINGVIEW_BRIDGE_NODE`, the script path with `TRADINGVIEW_BRIDGE_PATH`.
- Pass only the environment variables the helper needs.
- `is_available()` returns whether Node is present, the helper responds to `health`, and credentials are set. Cache the answer for about 60 seconds.

**Calls:**
- Send requests over a thread-safe channel with a reader thread and ids matched to replies. Remember that sync tools run in worker threads (`_offload_sync_tools` in `server.py`).
- Give each call a timeout.
- Expose an async API as well, since some tools are `async def`.

**Recovery:** if the helper dies, restart it on the next call. After 3 failures in a row, wait 30 seconds before trying again (same idea as `_wait_for_failure_cooldown`).

**Errors:** map them into the existing envelopes in `core/errors.py` (`ErrorCode`, `make_error`). Never let credentials into a message.

**Timeframes:** add a `to_tv_timeframe()` helper next to `validate_timeframe` in `core/utils/validators.py`. It converts this repo's `5m`/`1h`/`4h`/`1D`/`1W`/`1M` to TradingView's `5`/`60`/`240`/`D`/`W`/`M`. The repo already accepts TradingView's numeric codes (commit `eade8dc`), so reuse that logic.

**Tests** (`tests/unit/services/test_tv_bridge_client.py`): fake the helper with a Python script, and cover:
- request framing
- timeouts
- crash, then restart
- the wait after repeated failures
- "not configured" when Node or credentials are missing
- credential redaction

## Phase 3: new tools and wiring existing tools in

New tools in `server.py`:
- Follow the existing pattern: `@mcp.tool(annotations=ToolAnnotations(..., readOnlyHint=True, openWorldHint=True))`.
- Keep the logic in a new `core/services/tv_data_service.py`, since `server.py` is only a routing layer.
- Each result includes `data_freshness` with `source: "tradingview_session"`.

| Tool | Purpose |
|---|---|
| `tv_candles(symbol, exchange, timeframe="1D", count=300)` | real TradingView candles; cap `count`, for example at 5000 |
| `tv_quotes(symbols)` | batch quotes for a comma-separated list |
| `tv_indicator(symbol, exchange, indicator, timeframe="1D", inputs=None, count=100)` | values of any built-in or Pine indicator |
| `tv_symbol_search(query, type=None)` | resolve names to `EXCHANGE:SYMBOL` |

Wire into existing code (each falls back automatically to the current path):

1. **Backtests.** Give `backtest_service._fetch_ohlcv` an optional TradingView source.
   - When the helper is available, fetch candles from TradingView. Convert `period` to a bar count and `interval` (`1d`/`1h`) to the TradingView timeframe.
   - Otherwise use Yahoo, exactly as today.
   - Add `data_source` to backtest results.
   - Allow more timeframes (for example `4h`, `15m`) **only** when the TradingView source is active. Validation must still reject them on the Yahoo path, and the walk-forward and annualization tables (`_ANNUALIZATION`) need matching entries.
2. **Logged-in screener.** When credentials exist, pass `cookies={"sessionid": ..., "sessionid_sign": ...}` into `_scan_with_retry(...)`. Check that `tradingview-screener==3.0.0`'s `get_scanner_data(cookies=...)` accepts this shape before relying on it. Report `auth: "session"` in `data_freshness`. Do **not** change the `tradingview-screener` version pin (see the comment in `pyproject.toml`).
3. **Prices.** Have `yahoo_price` and `stock_prices` try `tv_quotes` first when available, fall back to Yahoo, and report which source answered.
4. Update the FastMCP `instructions` string and the README tool table.

## Phase 4: packaging, Docker, CI, docs

- **Dockerfile:** add Node 22 to the runtime image, copy `bridge/`, and run `npm ci --ignore-scripts --omit=dev` in `bridge/`. The image must still start and pass its `/health` check without credentials.
- **pyproject / PyPI:** don't try to ship `node_modules`. If installed from PyPI, the helper path must be set with `TRADINGVIEW_BRIDGE_PATH`. Document both "run from source" and Docker setups.
- **CI** (`.github/workflows/test.yml`): add a job that runs Node 22, `npm ci --ignore-scripts` and `node --test` in `bridge/`. Existing Python jobs must pass unchanged with no Node available, which proves the fallback works.
- **Live tests:** put them under `tests/stress/` with the existing `stress` marker. They are skipped unless the credential variables are set, and never run in CI.
- **Docs:**
  - a new `docs/tradingview-session.md`: how to copy `sessionid` and `sessionid_sign` from browser DevTools, where to keep them (env/secret store), the account-risk warning, and how to revoke them (log out of all sessions)
  - updated README security section
  - a `CHANGELOG.md` entry

## Phase 5: market watcher (always-on alerts)

The owner wants an always-on monitor for **crypto and US stocks**: what's trending, plus candle-move alerts, sent to **Discord and/or Telegram**. The MCP server only answers when asked, so this is a separate process. It must work with the MCP server stopped and without Claude.

### Location and how it runs
- `bridge/watcher.mjs` is a standalone Node process. It reuses `bridge/`'s single pinned dependency and lockfile, so nothing new gets installed.
- Run it with `node bridge/watcher.mjs --config watcher.config.json`.
- Intended to run around the clock on a Raspberry Pi 400 (Node 22, arm64). Include an example systemd unit, `bridge/watcher.service.example`, with restart-on-failure.

### Config
- `watcher.config.json` is gitignored. Commit `watcher.config.example.json` instead.
- It holds: the watchlist (symbol plus timeframes), the rules, the screener schedule, the enabled notifiers, cooldowns and quiet hours.
- Secrets live only in environment variables, never in the config: `TRADINGVIEW_SESSION_ID` / `TRADINGVIEW_SESSION_SIGN`, `DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

### Live candle rules
- **Data:** one shared library client streams candles with `watchCandles` for the watchlist. Cap the watchlist at about 25 symbol/timeframe pairs, to keep account traffic low.
- **When rules run:** only on **candle close**, never mid-candle, so alerts don't flap.
- **Indicators:** a small local indicator module (`bridge/lib/indicators.mjs`) calculates them from the streamed candles.
- **Rule types:**
  - % move over N bars
  - volume spike (× SMA20 of volume)
  - price crossing a set level
  - RSI crossing a threshold
  - close outside the Bollinger Bands
  - new N-bar high or low
- **Data-age check:** each alert records how old its data is, and the rule is skipped if the stream is stale.

### "What's trending" scan
- Every 10 minutes (configurable), run the library's `getScreener` / `getHotlist` for crypto and US stocks. Confirm the real signatures in the v4 docs first.
- Alert only on **new entries** to the top-N gainers or volume list, not on the whole list each time.

### Notifications
- One notifier interface with two implementations:
  - Discord: post to the webhook
  - Telegram: the bot's `sendMessage`
- Both use Node's built-in `fetch`, so there are **no new dependencies**. Every configured notifier receives each alert.
- Message: symbol, timeframe, rule, values, data age and a TradingView chart link.
- `--test-notify` sends one test message and exits.

### Avoiding alert spam
- a cooldown per symbol and rule
- a cap on alerts per hour
- quiet hours
- cooldown state saved to a small JSON state file, so a restart doesn't resend old alerts

### Health checks
- Reconnect with backoff.
- Alert if the stream is down for more than N minutes.
- Send a daily "watcher alive" message.
- Never log credentials or webhook URLs; reuse the bridge's redaction.

### Tests
`node --test` with:
- a fake candle stream (rules fire on close only; cooldown and dedupe work)
- a mocked `fetch` (Discord and Telegram message formats)
- a mocked screener (alerts only on new entries)

### Out of scope
A Claude-written summary. That can be a later scheduled Claude routine that calls the MCP tools for a morning or hourly digest. Real-time alerts stay in plain code.

## Phase 6: strategy testing gauntlet

Turn good strategy-testing practice into code, so an idea has to survive several checks before it's trusted. This phase doesn't depend on Phases 1–5. It works on Yahoo data alone and uses TradingView candles when the helper is available, so it can be built earlier if wanted.

What exists today, in `core/services/backtest_service.py`:
- Costs default to 0.1% commission plus 0.05% slippage per side.
- `walk_forward_backtest` exists.
- Each strategy runner takes keyword parameters (for example `_run_rsi(candles, oversold=40, overbought=60, period=14)`), but the tools don't expose them.
- **Fills happen at the close of the same candle that produced the signal**, which is slightly optimistic.

### 6.1 Check the market is actually tradable
- Add a `tradability` block to backtest results:
  - average daily traded value (price × volume)
  - share of zero-volume bars
  - number of bars
  - a `thin_market: true` flag below a configurable threshold
- With the TradingView helper available, also confirm the symbol resolves through `tv_symbol_search`.

### 6.2 "Who is on the other side?"
The gauntlet tool (6.5) requires two text inputs: `hypothesis` (why the edge should exist) and `counterparty` (who loses the trade, for example forced sellers or leveraged longs paying funding). If either is empty or generic, the verdict is `FAIL: no stated edge`. Both are stored in the report.

### 6.3 Realistic costs
- Add a `cost_profile` parameter with named presets (for example `binance_spot`, `coinbase`, `us_stock_broker`, `custom`).
  - Keep presets in one table in the code, each labelled as an assumption to verify against the owner's real fees.
  - Explicit `commission_pct` / `slippage_pct` still override.
- Add these metrics:
  - `trades_per_year`
  - `gross_return_pct` and `net_return_pct`
  - `cost_drag_pct`
- Warn when `trades_per_year > 200`, or when costs eat more than half the gross return.

### 6.4 No peeking at the future
- **Test it.** Add a test for all 9 strategies: entries and exits up to bar *k* must be identical whether the strategy runs on `candles[:k+1]` or on the full series. Any difference means it uses future data.
- **Add a fill mode.** Add `fill: "signal_close" | "next_open"` to the backtest functions. The default stays `signal_close` for existing tools, so current results don't change. The gauntlet always uses `next_open`.

### 6.5 New tool: `strategy_gauntlet`
Signature: `strategy_gauntlet(symbol, strategy, hypothesis, counterparty, cost_profile=..., interval="1d", params=None)`.

It runs every gate and returns per-gate results plus an overall `PASS` / `FAIL` that lists the failed gates. The output never says "profitable", only whether the strategy survived the tests.

| Gate | Check | Fails when |
|---|---|---|
| 1. Honest settings | longest available history, chosen cost profile, `next_open` fills, warm-up respected | — (sets up the rest) |
| 2. Enough evidence | number of trades, win rate together with profit factor, max drawdown | fewer than about 30 trades, profit factor ≤ 1, or drawdown above a threshold |
| 3. Parameter sensitivity | re-run with each parameter nudged ±10–20% (a small set of neighbouring settings), report the share of neighbours still profitable and the spread | results collapse: "spike, not plateau" |
| 4. Double costs | re-run at 2× commission and slippage | net return ≤ 0 |
| 5. Most recent year alone | the last 12 months on their own (needs more than a year of history) | it loses money, or does much worse than the full period |
| 6. Walk-forward | reuse `walk_forward_backtest` | verdict WEAK or OVERFITTED |

Notes:
- Expose the strategies' existing parameters through `params`, checked against each runner's allowed names.
- Add a multiple-testing warning to `compare_strategies`: "the best of 9 strategies on one symbol looks better than it really is; run the winner through `strategy_gauntlet`."

### 6.6 Paper trading forward (uses the Phase 5 watcher)
- Add a `paper` mode to `bridge/watcher.mjs`. It runs one strategy on live candles and writes **hypothetical** trades to a local journal (JSONL or CSV). It **never places orders**.
- Send a weekly Discord/Telegram summary comparing paper results with the backtest's expectations.
- The watcher refuses to start paper mode unless it finds a **passing gauntlet report whose fingerprint matches** (see 6.7).

### 6.7 Re-test every change; start small
- Each gauntlet report includes a `strategy_fingerprint`: a hash of strategy name, parameters, cost profile, interval, data source and backtest code version.
- Save reports to `~/.tradingview-mcp/gauntlet/`.
- Any change gives a new fingerprint, so the strategy has to pass again before paper mode will run it.
- Docs: start with one strategy, one asset and small size. This system only tests and paper trades; it never trades real money.

### 6.8 Separate builder and reviewer
- Add two MCP prompts (FastMCP `@mcp.prompt`):
  - `strategy_builder`: scan the market first, then propose a hypothesis with a named counterparty.
  - `strategy_reviewer`: try to kill the idea. Check the counterparty, overfitting signs, cost drag and recent-year performance, and recommend rejection unless every gate is clearly passed.
- Keep a running log (`gauntlet_log.jsonl`) and a `gauntlet_stats` summary of pass/fail rates. Docs say to expect most ideas (around 6 of 7) to fail, and that this is normal.

### 6.9 Tests (unit, hermetic)
- the no-future-data test for all 9 strategies
- `next_open` fills
- cost-profile maths and the warnings
- each gate's pass/fail logic, using synthetic candles built to pass or fail
- sensitivity grid generation
- fingerprint stability (same inputs give the same hash; any change gives a new one)
- the watcher refusing paper mode without a matching passing report

## Phase 7: charts (Lightweight Charts) and Pine indicators (PyneCore)

Both parts work on TradingView's **free** plan. Build them after Phase 5 (watcher) and Phase 6 (gauntlet).

### 7.1 Local dashboard with TradingView Lightweight Charts
[Lightweight Charts](https://www.tradingview.com/lightweight-charts/) is TradingView's own open-source charting library (npm `lightweight-charts`, Apache-2.0).
- **Ask the owner before adding it.** It would be the second pinned dependency in `bridge/` (exact version, `npm ci --ignore-scripts`). Check that the package name is exactly `lightweight-charts`.
- **Who serves it:** the watcher serves a dashboard at `http://127.0.0.1:<port>` (default localhost only). Allowing other devices on the home network must be opt-in and protected by a token from an environment variable. Never expose it to the internet.
- **Pages:**
  - watchlist charts with live candles, pushed from the watcher's stream (server-sent events)
  - rule levels drawn as lines, and markers where alerts fired
  - paper-trade entries and exits (Phase 6.6)
  - a list of gauntlet reports with each gate's result (Phase 6.5)
- **Attribution is required by TradingView's licence notice.** Keep the chart's `attributionLogo` option on, and add a footer crediting TradingView with a link.
- **Data:** read-only JSON endpoints only. The dashboard can't change rules or place anything.

### 7.2 Chart images on alerts (optional, off by default)
- Lightweight Charts draws in a browser, so turning a chart into an image needs headless Chromium (`playwright-core` with the system Chromium).
  - That's a **third** dependency and heavy for a Pi 400, so ask the owner first.
  - Keep it behind a config flag, default off.
- **When it's on:**
  - Render a small PNG of the last N candles, with the rule level and alert marker, using the same chart code as the dashboard.
  - Attach it to the Discord/Telegram alert.
  - Cap it at a few images per hour.
  - Fall back to text-only if rendering fails or Chromium is missing.
- **When it's off,** alerts include a link to that symbol's chart on the local dashboard instead.

### 7.3 Pine indicators in the gauntlet with PyneCore
PyneCore (PyneSys/pynecore, Apache-2.0) runs Pine-Script-style logic in Python.
- **Install:** add it as an **optional extra** (`pip install tradingview-mcp-server[pine]`, exact version pin), so the default install doesn't change. Ask the owner before adding it.
- **Check first:**
  - its licence
  - whether turning **Pine** code into runnable Python needs PyneSys's online compiler or an API key
  - whether only hand-written Pyne (Python) scripts run fully offline

  If compiling needs their service, document that, keep it optional, and never send the owner's scripts anywhere without asking.
- **Where scripts live:** only in a local folder the owner controls, `~/.tradingview-mcp/strategies/`. **Pyne scripts are Python code, so running one is running code:**
  - never download and run scripts automatically
  - treat community scripts as code to read before running
  - document this clearly
- **Connect it to the gauntlet:** let `strategy_gauntlet` accept a Pyne script name in place of a built-in strategy. Steps:
  - run the script on the same candles (TradingView source when available, otherwise Yahoo)
  - convert its trades to this repo's trade format
  - run all six gates, plus the no-future-data test from 6.4: compare outputs on `candles[:k+1]` against the full series for sample bars, to catch repainting or lookahead in the Pine logic
- **Check its maths:** before trusting PyneCore results, compare 3 standard indicators (RSI, EMA, Bollinger Bands) with TradingView's own values from `tv_indicator` (Phase 3) on identical candles.
  - Commit a small fixture for a hermetic unit test.
  - Keep the live comparison as an opt-in `stress` test.
  - Record the tolerance used.
- **Sources of indicators to try:** `awesome-pinescript` and everget's Pine indicator collection. Check each script's licence before reusing it.

### 7.4 Tests
- Dashboard JSON endpoints and server-sent events: `node --test`, with a fake candle stream.
- The token being required when the dashboard is opened to the home network.
- The image fallback to text-only when Chromium is missing.
- The Pyne bridge converting trades to the repo's format.
- The no-future-data check catching a deliberately leaky script.
- The indicator comparison against the committed fixture.

## Rules

- Never commit, print or log credentials. Grep the diff for cookie-shaped strings before every commit.
- Don't upgrade `mcp`, `tradingview-screener` or other pinned dependencies (see the reasons in `pyproject.toml`).
- Keep `server.py` free of business logic.
- Commit after each phase with a clear message, and push to the session's designated branch. Don't open a PR unless the owner asks.

## How to check it works

1. Run `uv run pytest tests/unit -q`. It must pass **with and without** Node on PATH; temporarily hide Node to test the fallback.
2. Run `cd bridge && npm ci --ignore-scripts && node --test`.
3. Smoke test without credentials: start `uv run tradingview-mcp`, call `coin_analysis` and `backtest_strategy`. Both behave as before, plus `data_freshness`. `tv_candles` returns a "not configured" error envelope.
4. Smoke test with credentials (owner runs this locally; the session can't):
   - export both variables
   - `tv_candles("BTCUSDT", "BINANCE", "60", 500)` returns 500 hourly bars
   - `tv_indicator(..., "STD;RSI")` returns values
   - `backtest_strategy` reports `data_source: "tradingview"`
   - `stock_screener` reports `auth: "session"`
5. Kill the Node process mid-session. The next call restarts it, or falls back cleanly with no hang.
6. Docker: `docker build .` succeeds and `/health` returns 200 without credentials.
7. Watcher:
   - `node bridge/watcher.mjs --test-notify` delivers a message to each configured channel (Discord and/or Telegram).
   - A temporary rule (for example BTCUSDT 1m move > 0.1%) fires within a few minutes. After the cooldown it doesn't repeat.
   - Cutting the network briefly brings a "stream down" alert, then the watcher recovers.
   - On the Pi, the systemd unit restarts the watcher after `kill`.
8. Gauntlet:
   - `strategy_gauntlet("BTC-USD", "rsi", hypothesis=..., counterparty=...)` returns six gate results and an overall verdict.
   - Blank `hypothesis` or `counterparty` gives `FAIL: no stated edge`.
   - Existing `backtest_strategy` results are unchanged with the default `fill="signal_close"`.
   - Paper mode refuses a strategy whose settings changed after it passed.
9. Charts and Pine:
   - The dashboard at `http://127.0.0.1:<port>` shows live candles, alert markers and the TradingView attribution.
   - It refuses access from another device unless the token is set.
   - With chart images on, an alert arrives with a PNG. With them off, or with no Chromium, it arrives as text with a dashboard link.
   - A Pyne version of RSI matches `tv_indicator`'s RSI within the recorded tolerance.
   - `strategy_gauntlet` runs a local Pyne script, and a deliberately leaky script fails the no-future-data check.

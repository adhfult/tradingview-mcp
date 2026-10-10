# Master plan: TradingView account data, market watcher, strategy gauntlet, charts

---

## 1. Context

`adhfult/tradingview-mcp` is a fork of `atilaahmettaner/tradingview-mcp`, a Python MCP server (FastMCP) with 37 read-only market-data tools. A code review found four problems:

- **Anonymous TradingView access.** Indicator snapshots come from TradingView's undocumented `scanner.tradingview.com`, and no login cookies are sent, so stock data is often delayed.
- **Limited price history.** Candle history comes only from Yahoo's unofficial chart API: daily or hourly bars, 2 years at most.
- **Old data looks fresh.** When TradingView fails, cached results up to 6 hours old are returned with nothing marking them as old (`core/services/screener_provider.py`).
- **No monitoring or charts.** The server only answers when asked.

Adham has a TradingView account (plan unknown, so this document assumes **free**). He wants:
1. authenticated, current data, using **Mathieu2301/TradingView-API** (npm `@mathieuc/tradingview`)
2. an **always-on watcher** for crypto and US stocks: what's trending, plus candle-move alerts to **Discord and/or Telegram**, running on a **Raspberry Pi 400**
3. a **strategy gauntlet** that turns good testing practice into code: name who loses the trade, realistic costs, no future data, parameter sensitivity, double costs, most recent year alone, walk-forward, paper trading, re-test on change, separate builder and reviewer
4. **charts** (TradingView Lightweight Charts) and **Pine indicators** (PyneCore) inside the gauntlet

**Nothing in this plan places real trades.** Paper trading only.

---

## 2. Facts checked on 2026-10-10 (re-check versions before pinning)

| Package | Registry | Latest seen | Licence | Notes |
|---|---|---|---|---|
| `@mathieuc/tradingview` | npm | **4.0.0** | **ISC** | ESM; `engines.node >=20.0.0`; one dependency, `ws ^8.18.0`; no install scripts. Has a `bin` launcher (`tradingview`) that we never use. |
| `lightweight-charts` | npm | **5.2.1** | Apache-2.0 | ESM; v5 interface (`chart.addSeries(CandlestickSeries, …)`, `createSeriesMarkers`). Attribution notice is required. |
| `playwright-core` | npm | 1.64.0 | Apache-2.0 | Optional (Phase 7.2) only. |
| `pynesys-pynecore` | PyPI | 6.10.9 | **not in metadata: check the repo's LICENSE** | **Needs Python ≥ 3.11.** Extras: `cli`, `all`, `providers`/`ccxt`. |
| `tradingview-screener` | PyPI | 3.2.2 | MIT | **Stays pinned to 3.0.0** (see `pyproject.toml`: 3.2.0 silently returns 0 rows for crypto and futures). |
| `tradingview-ta` | PyPI | 3.3.0 | MIT | No cookie support, so it stays anonymous. |

### TradingView-API v4 interface we rely on
Read from `dist/data/*.d.ts` and `dist/http/*.d.ts`. Import from `@mathieuc/tradingview/data`; `TradingViewClient` comes from the package root.

- `getCandles(query: CandleQuery | string): Promise<Candle[]>`
  - Returns bars **oldest first**.
  - `query` takes either `{symbol, timeframe, count}` or `{symbol, timeframe, from, to, maxCount}`. Deep history loads automatically; `maxCount` defaults to 20 000.
- `watchCandles(query, {onData(candles), onError}): Promise<CandleWatcher>`
  - `onData` receives the latest snapshot each update.
  - The watcher has `.latest`, `.stop()`, `.closed` and `.isActive`.
  - **A fatal error stops the watcher, so our code must restart it.**
- `getQuote(q)`, `getQuotes({symbols, fields?, session?}) → Record<string, QuoteData>`, `watchQuotes(...)`
- `getIndicatorData({symbol, timeframe, indicator, inputs?, version?, to?, count?}) → {indicator, candles, values: StudyValue[], graphics, strategyReport}`
  - `StudyValue = {$time, [plot]: number}`
  - `summarizeStrategyReport()` is exported.
- `searchMarkets(query, {type?, country?, sector?}) → MarketSearchResult[]`, with fields `id`, `exchange`, `fullExchange`, `symbol`, …
- `getScreener({market?, columns, filter?, sort?, range?, symbols?}, {credentials?}) → {totalCount, rows: [{symbol, values}]}`
- `getHotlist({kind: 'gainers'|'losers'|'mostActive'|'volumeGainers', market?, filter?, range?}, opts)`
- `getTechnicalAnalysis(symbol)` and `getSymbolInfo(...)`
- **Shared types:**
  - `Candle = {time, open, high, low, close, volume}`, where `time` is the bar's **open** time in Unix seconds.
  - `Timeframe`: `'1'…'240'`, `'D'`, `'W'`, `'M'`, `'1S'`, …
  - `Credentials = {session: <sessionid cookie>, signature?: <sessionid_sign cookie>}`
- **Every call accepts `OperationOptions`:** `{client?, credentials?, clientOptions?, timeoutMs? (default 15000), signal?}`. Passing a shared `client` reuses one connection.
- `new TradingViewClient({credentials, connectTimeoutMs?, inactivityTimeoutMs?, …})`; always `await client.close()`.
- `TradingViewError.code` is one of:
  - `PROTOCOL_ERROR`, `CONNECTION_ERROR`, `DISCONNECTED`, `AUTH_ERROR`
  - `SYMBOL_ERROR`, `SERIES_ERROR`, `CRITICAL_ERROR`, `STUDY_ERROR`, `QUOTE_ERROR`, `PARSE_ERROR`
  - `INVALID_STATE`, `INVALID_ARGUMENT`, `HTTP_ERROR`, `NOT_FOUND`, `NO_DATA`
  - `TIMEOUT`, `ABORTED`, `CALLBACK_ERROR`

### Repo facts this plan builds on
- `server.py` is a routing layer only. Every tool uses `@mcp.tool(annotations=ToolAnnotations(..., readOnlyHint=True, openWorldHint=True))`.
- `_offload_sync_tools()` (around `server.py:1233`) wraps sync tools in `asyncio.to_thread`. Tests in `tests/unit/test_tool_annotations.py` and `test_tool_offload.py` cover all tools.
- **Errors** (`core/errors.py`):
  - `ErrorCode` enum: `SYMBOL_NOT_FOUND`, `INVALID_EXCHANGE`, `INVALID_TIMEFRAME`, `INVALID_PARAMETER`, `UPSTREAM_RATE_LIMIT`, `UPSTREAM_TIMEOUT`, `UPSTREAM_ERROR`, `ALL_BATCHES_FAILED`, `NO_DATA`, `PARTIAL_DATA`, `DEPENDENCY_MISSING`, `INTERNAL_ERROR`
  - helpers: `make_error(code, message, **extra)`, `ScreenerServiceError`, `exception_to_envelope`
- **Validators** (`core/utils/validators.py`):
  - `ALLOWED_TIMEFRAMES = {5m, 15m, 1h, 4h, 1D, 1W, 1M}`, plus `_TIMEFRAME_ALIASES` (which already accepts TradingView's numeric codes)
  - `validate_timeframe`, `validate_exchange`, `normalize_tradingview_symbol`, `get_tv_exchange_prefix`, `get_market_type`, `EXCHANGE_SCREENER`, `_TA_ONLY_SCREENERS`
- **Scanner calls:**
  - `_scan_with_retry(q, cookies=None, cache_key=None)` is used by `screener_service.py:497` and `egx_service.py:1071`.
  - Direct `get_scanner_data(timeout=…)` calls: `futures_service.py:130,143,170,193` and `stock_screener_service.py:144`.
  - About 20 `get_multiple_analysis` call sites go through `resilient_get_multiple_analysis` (tradingview_ta, anonymous).
- **Backtests** (`core/services/backtest_service.py`):
  - `_STRATEGY_MAP` holds 9 runners with keyword parameters, for example `_run_rsi(candles, oversold=40, overbought=60, period=14, **_)`.
  - Other pieces: `_STRATEGY_WARMUP_BARS`, `_apply_costs`, `_calc_metrics` (Sharpe, Calmar, expectancy, profit factor, drawdown), `_buy_and_hold_return`, `run_backtest`, `compare_strategies`, `walk_forward_backtest`.
  - Data comes from Yahoo via `_fetch_ohlcv(symbol, period, interval)`. `_VALID_PERIODS = {1mo,3mo,6mo,1y,2y}`, `_VALID_INTERVALS = {1d,1h}`, `_ANNUALIZATION = {1d: 252, 1h: 1638}`.
  - **Fills happen at the signal candle's close.** Tool defaults are commission 0.1% and slippage 0.05%.
  - Indicator maths lives in `core/services/indicators_calc.py`.
- **Tests:**
  - `tests/unit/**` (pytest, `asyncio_mode=auto`)
  - `tests/stress/**`, marked `stress` and excluded by default (`addopts = -m "not stress"`)
  - CI: `.github/workflows/test.yml` runs Python 3.10–3.13 with `uv sync --dev && uv run pytest tests/unit -q`
- **Other:**
  - `Dockerfile` is a two-stage `python:3.11-slim` build with a `/health` route.
  - `.gitignore` already ignores `.env`. `python-dotenv` is **not** a dependency (`proxy_manager.py` only tries to import it).
  - There is no `AGENTS.md`, `CLAUDE.md` or `.githooks`.

---

## 3. Ground rules (apply to every phase)

1. **Workflow per phase:**
   - plan the phase
   - implement it
   - write its tests
   - run the checks (§15)
   - one commit (or a few) with a clear message
   - **stop for Adham's review**
   - push only when he says so
2. **Secrets:**
   - Secrets are `TRADINGVIEW_SESSION_ID`, `TRADINGVIEW_SESSION_SIGN`, `DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `WATCHER_DASHBOARD_TOKEN` and `WATCHER_LOCAL_TOKEN`.
   - They come only from environment variables or the gitignored `.env`.
   - Never read, print, log, return or commit their values. All logs and error text go through a redaction function, and tests prove it.
   - Before each commit, grep the diff for cookie- or token-shaped strings.
3. **Dependencies:**
   - Exact version pins plus lockfiles. Install npm packages with `--ignore-scripts` (also set in `bridge/.npmrc`).
   - **Ask Adham before adding any dependency not named in this plan.**
   - Never upgrade `mcp` or `tradingview-screener`.
   - `package.json` lives **only** under `bridge/`, never at the repo root. The README already warns about malicious npm copies of this repo.
4. **Don't break what works.**
   - With no Node, no `bridge/node_modules` or no credentials, every existing tool behaves exactly as today (apart from the new `data_freshness` block).
   - Existing backtest numbers must not change with default arguments.
   - CI's Python jobs run without Node.
5. **`server.py` stays routing only.** Logic goes in `core/services/*`.
6. **Read-only.** No tool or process places orders, moves funds or edits the TradingView account.
7. **Keep traffic light on his account.**
   - one shared TradingView connection per process
   - at most 2 requests in flight
   - at most 25 live streams
   - the trending scan no more than every 5 minutes

---

## 4. Architecture

```
                 ┌────────────── Claude (MCP client) ──────────────┐
                 │                                                   │
          stdio / http                                               │
                 ▼                                                   │
   Python MCP server (src/tradingview_mcp)                           │
     ├─ existing tools (scanner/TA/Yahoo) ── data_freshness (Phase 0)
     ├─ tv_* tools (Phase 3) ──► tv_bridge_client.py ──stdin/stdout JSON-RPC──► bridge/server.mjs ──► TradingView (your account)
     ├─ backtests: Yahoo or TradingView candles (Phase 3)
     ├─ strategy_gauntlet / gauntlet_stats / prompts (Phase 6)
     └─ Pine via PyneCore (Phase 7.3, optional extra)

   Raspberry Pi 400 (always on)
     ├─ bridge/watcher.mjs (Phase 5): live candles + trending scan ─► Discord / Telegram
     │     ├─ 127.0.0.1 /notify endpoint (paper runner posts here)
     │     └─ dashboard on 127.0.0.1 (Phase 7.1, Lightweight Charts)
     └─ tradingview-mcp-paper (Phase 6.6): Python paper trader, reads candles via the bridge
```

Phase order and dependencies:
- **0** (freshness) first, on its own.
- **1 → 2 → 3 → 4** form the TradingView data path.
- **5** needs 1.
- **6** needs only 0. It can come right after 0 if Adham asks. 6.6 needs 2 and 5.
- **7** needs 5 and 6. 7.3 needs 3 for the `tv_indicator` comparison.

---

## 5. Adham's setup checklist (things only he can do)

1. **TradingView cookies.**
   - Log in at tradingview.com, then DevTools → Application → Cookies → `https://www.tradingview.com`.
   - Copy `sessionid` and `sessionid_sign` into `~/code/tradingview-mcp/.env` as `TRADINGVIEW_SESSION_ID=` and `TRADINGVIEW_SESSION_SIGN=`.
   - Never paste them into a chat.
   - To revoke them, log out of all sessions in TradingView's settings.
   - **Know your plan:** open AAPL while logged in. If it's marked delayed, US-stock data through this setup will be delayed too.
2. **Discord** (optional): Server Settings → Integrations → Webhooks → New Webhook → pick a channel → Copy Webhook URL → `DISCORD_WEBHOOK_URL`.
3. **Telegram** (optional):
   - Message `@BotFather`, send `/newbot` and keep the token (`TELEGRAM_BOT_TOKEN`).
   - Send any message to your new bot.
   - Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in your own browser and copy `message.chat.id` (`TELEGRAM_CHAT_ID`).
4. **Raspberry Pi 400:**
   - Raspberry Pi OS **64-bit**, updated.
   - Node 22 LTS (NodeSource apt repo or `nvm`), `git`, Python 3.11+ with `uv` (for the paper trader).
   - Optional for Phase 7.2: the `chromium` apt package.
5. **Machine for development:** WSL Ubuntu, repo at `~/code/tradingview-mcp`.

---

## 6. Phase 0: make cached data say how old it is

**Goal:** every tool that returns scanner or TA data says where the data came from and how old it is.

**Files:**
- `core/services/screener_provider.py`
- `server.py` (one wrapper, applied at import like `_offload_sync_tools`)
- a new `core/services/freshness.py`
- tests

**Steps:**
1. `freshness.py`:
   - a `ContextVar[list | None]` "collector"
   - `record(meta)`, which appends when a collector is active
   - `summarize(metas)`:
     - `source`: a set of strings
     - `as_of_utc`: the **oldest** timestamp
     - `age_seconds`: the maximum
     - `stale`: any stale
     - `cache_hit`: any
     - `auth`: `"session"` only if all are session, otherwise `"anonymous"` or `"mixed"`
   - The list object is shared by reference. `asyncio.to_thread` copies the context, so records made in worker threads still reach it.
2. `screener_provider.py`:
   - Cache entries keep `(ts, payload)` as now.
   - On every return path of `_scan_with_retry` and `resilient_get_multiple_analysis`, call `freshness.record({source: "tradingview_scanner", as_of: ts, cache_hit, stale, auth})`:
     - fresh fetch: `cache_hit=False, stale=False`
     - fresh-cache hit: `cache_hit=True`, `as_of` is the entry's time
     - stale fallback: `stale=True`
   - **Function signatures and return values don't change.**
3. Also record from Yahoo fetches (`yahoo_finance_service._fetch_quote`, `backtest_service._fetch_ohlcv`) with `source="yahoo"` and `as_of` = newest candle or quote time.
4. `server.py` `_attach_freshness()`, applied to every tool at import, **after** `_offload_sync_tools`:
   - set a new collector
   - await the tool
   - if the result is a `dict` and records exist, add `result["data_freshness"] = summarize(...)`
   - if the result is a `list[dict]` and the data is stale, add `"data_freshness"` to each row. When it's not stale, list output stays the same.
5. Tests (`tests/unit/services/test_freshness.py`):
   - fresh fetch
   - fresh-cache hit (age > 0)
   - stale fallback (`stale: true`, correct age)
   - collector works across `asyncio.to_thread`
   - list results unchanged when fresh
   - existing resilience tests still pass

**Done when:** `coin_analysis` returns `data_freshness`, and a forced stale fallback in a test shows `stale: true`.

**Commit:** `feat: report data freshness (source, age, stale) on scanner/TA/Yahoo results`

---

## 7. Phase 1: Node helper (`bridge/`)

**Files:**
- `bridge/package.json`, `bridge/package-lock.json`, `bridge/.npmrc`
- `bridge/server.mjs`, `bridge/lib/redact.mjs`, `bridge/lib/errors.mjs`, `bridge/lib/semaphore.mjs`
- `bridge/test/*.test.mjs`
- `bridge/README.md`

**Steps:**
1. **`package.json`:**
   - `{"name":"tradingview-mcp-bridge","private":true,"type":"module","engines":{"node":">=20"}}`
   - dependencies: `"@mathieuc/tradingview": "4.0.0"` (exact)
   - scripts: `"test": "node --test"`
   - Check the installed package name is exactly `@mathieuc/tradingview` and that the lockfile's `resolved` URLs point to `registry.npmjs.org`.
2. **`.npmrc`:** `ignore-scripts=true`, `save-exact=true`, `fund=false`.
3. **Protocol:**
   - newline-delimited JSON on stdin/stdout
   - request `{"id":<int>,"method":<str>,"params":{...}}`
   - response `{"id":…,"result":…}` or `{"id":…,"error":{"code":<BRIDGE_CODE>,"message":<redacted>}}`
   - At startup, point `console.log`, `console.info` and `console.debug` at **stderr**, so stdout carries only protocol lines.
4. **Structure:** `server.mjs` exports `createServer({ lib, env, stdin, stdout, stderr })`. The real entry point imports the library and calls it, so tests can inject a fake library.
5. **Shared client:**
   - Created lazily: `new TradingViewClient({ credentials })`, with credentials only if both environment variables are set.
   - Passed as `client` to every call.
   - On `DISCONNECTED`, `CONNECTION_ERROR` or `PROTOCOL_ERROR`: close it, drop it, and create a new one on the next call.
6. **Concurrency:** a semaphore with `TRADINGVIEW_BRIDGE_MAX_INFLIGHT` (default 2). `timeoutMs` defaults to 15000, capped at 60000.
7. **Methods.** Validate every parameter (types, ranges, symbol pattern `^[A-Z0-9_.!:-]+$` after upper-casing):

| method | library call | params | result |
|---|---|---|---|
| `health` | none | – | `{ok, libVersion, node, hasCredentials}` |
| `candles` | `getCandles` | `symbol, timeframe, count?≤5000 \| from?, to?, maxCount?≤20000` | `[{time,open,high,low,close,volume}]` |
| `quotes` | `getQuotes` | `symbols[≤50], fields?` | `{SYMBOL: {...}}` |
| `indicator` | `getIndicatorData` | `symbol, timeframe, indicator, inputs?, count?≤500` | `{name, plots:[...], values:[{time, ...plots}], strategy?: summarizeStrategyReport(...)}` |
| `search` | `searchMarkets` | `query, type?` | `[{symbol, exchange, fullExchange, id, type, description}]` (≤20) |
| `symbol_info` | `getSymbolInfo` | `symbol` | trimmed metadata (timezone, session, type, currency, delay info if present) |
| `screener` | `getScreener` | `market, columns[≤20], filter?, sort?, range?≤[0,200]` | `{totalCount, rows}` |
| `hotlist` | `getHotlist` | `kind, market?, range?` | `{totalCount, rows}` |
| `technical` | `getTechnicalAnalysis` | `symbol` | rating object or `null` |

8. **Error mapping** (`lib/errors.mjs`), library code → bridge code:

| Library code(s) | Bridge code |
|---|---|
| `SYMBOL_ERROR`, `NOT_FOUND` | `SYMBOL_NOT_FOUND` |
| `TIMEOUT` | `TIMEOUT` |
| `AUTH_ERROR` | `AUTH_FAILED` |
| `SERIES_ERROR`, `STUDY_ERROR`, `CRITICAL_ERROR` | `PERMISSION_OR_SERIES` (often plan limits) |
| `HTTP_ERROR` with status 429 | `RATE_LIMITED` |
| `CONNECTION_ERROR`, `DISCONNECTED`, `PROTOCOL_ERROR` | `UPSTREAM_UNAVAILABLE` |
| `INVALID_ARGUMENT` | `INVALID_PARAMETER` |
| `NO_DATA` | `NO_DATA` |
| anything else | `UPSTREAM_ERROR` |

9. **Redaction** (`lib/redact.mjs`): replace the values of every secret environment variable, plus anything matching `sessionid(_sign)?=[^;\s]+`, `bot\d+:[A-Za-z0-9_-]+` and `discord(app)?\.com/api/webhooks/\S+`, with `[REDACTED]`. Apply it to all stderr output and error messages.
10. **Shutdown:** on stdin end, SIGTERM or SIGINT, call `await client?.close()`, then exit 0. On an unhandled rejection, log (redacted) and exit 1.
11. **Tests** (`node --test`, fake library):
    - framing, including several requests in flight answered out of order
    - parameter validation
    - every error-mapping row
    - redaction of secrets in an error message
    - stdout carries only protocol lines
    - semaphore limit
    - client recreated after `DISCONNECTED`
    - shutdown closes the client

**Done when:** `cd bridge && npm ci && node --test` passes, and `echo '{"id":1,"method":"health"}' | node server.mjs` prints one JSON line.

**Commit:** `feat(bridge): Node JSON-RPC helper around @mathieuc/tradingview 4.0.0`

---

## 8. Phase 2: Python client for the helper

**Files:**
- `core/services/tv_bridge_client.py`
- `core/utils/env_file.py`
- `core/errors.py` (add codes)
- `core/utils/validators.py` (`to_tv_timeframe`)
- tests

**Steps:**
1. **`env_file.py`** (stdlib only, no `python-dotenv`):
   - Parse `<repo root>/.env` once at import of `tv_bridge_client`. Format: `KEY=VALUE`, optional quotes, `#` comments.
   - Never override variables that are already set.
   - Skip entirely when `TRADINGVIEW_MCP_NO_DOTENV=1`.
   - Never log values.
2. **New `ErrorCode` members:** `NOT_CONFIGURED`, `AUTH_FAILED`, `PERMISSION_DENIED`.
3. **`to_tv_timeframe(tf)`:** `5m→"5"`, `15m→"15"`, `1h→"60"`, `4h→"240"`, `1D→"D"`, `1W→"W"`, `1M→"M"`. Validate input with `validate_timeframe`.
4. **`BridgeClient`:**
   - **Finding Node:** `TRADINGVIEW_BRIDGE_NODE` or `shutil.which("node")`. Require major version ≥ 20 (`node --version`).
   - **Finding the script:** `TRADINGVIEW_BRIDGE_PATH`, or the repo-relative `bridge/server.mjs` located from the package path. If `bridge/node_modules/@mathieuc/tradingview` is missing, return `NOT_CONFIGURED` with the hint "run `npm ci --ignore-scripts` in bridge/".
   - **Starting it:** `subprocess.Popen([node, script], stdin=PIPE, stdout=PIPE, stderr=PIPE, env=<allowlist>)`.
     - Allowlist: `PATH`, `HOME`, `NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY`, `NO_PROXY`, `TRADINGVIEW_SESSION_ID`, `TRADINGVIEW_SESSION_SIGN`, `TRADINGVIEW_BRIDGE_MAX_INFLIGHT`.
     - The command can be injected for tests.
   - **Reading replies:** one reader thread matches responses to `concurrent.futures.Future` by id. A stderr thread forwards lines, redacted, to `logging` at debug level.
   - **Sending:** a write lock.
   - **API:** `call(method, params, timeout_s=20)` (sync) and `async acall(...)` using `asyncio.wrap_future`.
   - **Recovery:**
     - If the process dies, fail pending calls with `UPSTREAM_ERROR` and restart on the next call.
     - After 3 failures in a row, wait 30 seconds before retrying (mirrors `_wait_for_failure_cooldown`).
   - **Availability:** `is_available()` checks Node, the script, `node_modules` and a successful `health`. Cache the answer for 60 seconds.
   - `has_credentials()` checks that both environment variables are present.
   - **Process lifetime:** a module-level singleton; `atexit` closes it.
5. **Error mapping** to `make_error` codes:

| Bridge code | `ErrorCode` |
|---|---|
| `SYMBOL_NOT_FOUND` | `SYMBOL_NOT_FOUND` |
| `TIMEOUT` | `UPSTREAM_TIMEOUT` |
| `RATE_LIMITED` | `UPSTREAM_RATE_LIMIT` |
| `AUTH_FAILED` | `AUTH_FAILED` (message: "TradingView rejected the session cookies; refresh them") |
| `PERMISSION_OR_SERIES` | `PERMISSION_DENIED` |
| `INVALID_PARAMETER` | `INVALID_PARAMETER` |
| `NO_DATA` | `NO_DATA` |
| others | `UPSTREAM_ERROR` |

   Mark transient errors `retryable=True`.
6. **Tests** (`tests/unit/services/test_tv_bridge_client.py`), using a **fake helper written in Python** (`tests/unit/fixtures/fake_bridge.py`) run as `[sys.executable, fake_bridge.py]`:
   - framing
   - concurrent calls
   - timeout
   - crash, then restart
   - the cool-down
   - `NOT_CONFIGURED` when Node, the script or `node_modules` is missing
   - redaction in logs
   - `.env` parsing without overriding existing variables
   - `to_tv_timeframe` table

**Done when:** unit tests pass with and without Node on `PATH`.

**Commit:** `feat: Python client for the TradingView bridge (.env loading, restart, error mapping)`

---

## 9. Phase 3: new tools and wiring into existing code

**Files:** a new `core/services/tv_data_service.py`, plus `server.py`, `backtest_service.py`, `screener_provider.py`, `futures_service.py`, `stock_screener_service.py`, `README.md` and tests.

**New tools**
- All `readOnlyHint=True`, `openWorldHint=True`, `async def` using `acall`.
- Each returns `data_freshness`: `{source: "tradingview_session" | "tradingview_anonymous", as_of_utc, age_seconds, stale: false, auth}`.
- Without the helper, each returns a `NOT_CONFIGURED` envelope with setup steps.

| Tool | Args | Output |
|---|---|---|
| `tv_candles` | `symbol, exchange, timeframe="1D", count=300 (≤5000)` | compact `{symbol, timeframe, columns:[time,open,high,low,close,volume], rows:[[...]], first, last, bars}`. `time` is ISO-8601 UTC, plus a summary (last close, % change over the range). |
| `tv_quotes` | `symbols` (comma-separated `EXCHANGE:SYMBOL`, ≤50) | price, change, change %, volume, bid/ask when present, plus market status and delay information when TradingView supplies them |
| `tv_indicator` | `symbol, exchange, indicator ("STD;RSI" or a Pine id), timeframe="1D", inputs=None, count=100 (≤500)` | the plot series (last N), plus a strategy summary if it's a strategy |
| `tv_symbol_search` | `query, type=None` | up to 20 matches as `EXCHANGE:SYMBOL` with descriptions |
| `tv_hotlist` | `kind ("gainers"…), market ("crypto" \| "america" \| …), limit=25` | ranked rows |

- Build symbols with `normalize_tradingview_symbol(symbol, exchange)` / `get_tv_exchange_prefix`, and check exchanges with `validate_exchange`.
- Logic lives in `tv_data_service.py`; `server.py` only routes.

**Backtests on TradingView candles**
- Add `data_source: "yahoo" | "tradingview" = "yahoo"` and `tv_symbol: str | None` (for example `BINANCE:BTCUSDT`) to `run_backtest`, `compare_strategies`, `walk_forward_backtest` and their tools. **The default stays Yahoo**, so results don't change.
- With `data_source="tradingview"`, `_fetch_ohlcv`:
  - calls the helper's `candles` with `from = now − period` (no bar-count arithmetic)
  - converts candles to the existing `{date, open, high, low, close, volume}` shape. `date` is ISO with time for intraday bars, and must be unique.
- Allow extra periods `3y` and `5y`, and intervals `15m` and `4h`, **only** with the TradingView source. Validation errors name the allowed set for each source.
- **Annualization by market type** (`get_market_type`):

| Market | Bars per year |
|---|---|
| Crypto (24/7) | 365 × bars per day (`1d` 365, `4h` 2190, `1h` 8760, `15m` 35040) |
| Stocks | 252 × bars per session (`1d` 252, `4h` 504, `1h` 1638, `15m` 6552) |

  Explicit `periods_per_year` still overrides.
- Results report `data_source: "TradingView (session)"` or `"Yahoo Finance"`.

**Logged-in screener**
- `screener_provider.session_cookies()` returns `{"sessionid":…, "sessionid_sign":…}` when credentials exist and `TRADINGVIEW_MCP_SCANNER_USE_SESSION` isn't `0`; otherwise `None`.
- Pass `cookies=` to:
  - `_scan_with_retry` call sites (`screener_service.py:497`, `egx_service.py:1071`)
  - the direct `get_scanner_data(timeout=…, cookies=…)` calls in `futures_service.py` and `stock_screener_service.py`
- **First, with a unit test that inspects the call, check that `tradingview-screener==3.0.0` forwards `cookies` to `requests.post`.**
- Add the auth flag to every cache key, so anonymous and logged-in results never mix.
- Record `auth: "session"` in freshness. `tradingview_ta` calls stay anonymous.
- **Don't change `yahoo_price` or `stock_prices`.** Their descriptions say "for current TradingView prices use `tv_quotes`".

**Docs in this phase:** update the FastMCP `instructions` string, the README tool table (37 → 42 tools) and the tool descriptions.

**Tests:**
- service functions with a fake `BridgeClient`
- candle conversion
- period → `from` calculation
- annualization table
- validation per source
- cookies passed and cache keys split by auth
- `NOT_CONFIGURED` envelopes
- `test_tool_annotations.py` and `test_tool_offload.py` cover the new tools

**Commit:** `feat: tv_candles/tv_quotes/tv_indicator/tv_symbol_search/tv_hotlist + TradingView backtest source + session scanner`

---

## 10. Phase 4: packaging, Docker, CI, docs

1. **`.gitignore`:** `bridge/node_modules/`, `watcher.config.json`, `bridge/watcher.config.json`, `*.state.json`, `paper-journal*`.
2. **`.dockerignore`:** the same, plus `.env`.
3. **Dockerfile:**
   - New stage `FROM node:22-bookworm-slim AS bridge`: `COPY bridge/package*.json bridge/.npmrc`, then `npm ci --ignore-scripts --omit=dev`, then `COPY bridge/`.
   - Runtime stage: copy `/usr/local/bin/node` from that stage and `/app/bridge` with `node_modules`.
   - `ENV TRADINGVIEW_BRIDGE_PATH=/app/bridge/server.mjs`.
   - The image must start and pass `/health` with no credentials.
4. **`pyproject.toml`:**
   - version `0.10.0`
   - no Node packaging in the Python package; document `TRADINGVIEW_BRIDGE_PATH` for pip installs
5. **CI** (`.github/workflows/test.yml`), new job `bridge`:
   - matrix Node 20 and 22
   - `actions/setup-node@v4`
   - `npm ci --ignore-scripts`
   - `node --test`
   - `npm audit --omit=dev --audit-level=high`

   The Python jobs stay unchanged and run without Node, which proves the fallback works.
6. **Docs:**
   - `docs/tradingview-session.md`: cookie steps, risks (his real account; automated use can break TradingView's terms), keeping traffic low, how to revoke.
   - `.env.example` with variable names only.
   - `SECURITY.md`: the bridge, its single npm dependency and cookie handling.
   - README: "Using your TradingView account" and "Running the watcher".
   - `CHANGELOG.md`.

**Commit:** `build: Docker/CI/docs for the TradingView bridge`

---

## 11. Phase 5: market watcher (Pi, always on)

**Files:**
- `bridge/watcher.mjs`
- `bridge/lib/{config,stream,rules,indicators,scanner,notifiers,queue,state,health,localapi,format}.mjs`
- `bridge/watcher.config.example.json`, `bridge/watcher.env.example`, `bridge/watcher.service.example`
- `bridge/test/watcher/*.test.mjs`
- `scripts/gen_indicator_fixtures.py`

**Command line:**

| Flag | Effect |
|---|---|
| `--config <path>` | required |
| `--check-config` | validate and exit |
| `--test-notify` | send one test message to every configured channel and exit |
| `--dry-run` | print alerts instead of sending them |
| `--once` | run one trending scan and exit |

**Config.** Validated at startup, with every problem listed:
```json
{
  "timezone": "America/New_York",
  "watchlist": [
    {"symbol": "BINANCE:BTCUSDT", "timeframes": ["15", "60", "240"]},
    {"symbol": "NASDAQ:NVDA", "timeframes": ["15", "D"], "session": "regular"}
  ],
  "rules": [
    {"id": "move", "type": "pct_move", "bars": 4, "threshold_pct": 3},
    {"id": "volspike", "type": "volume_spike", "multiple": 3, "lookback": 20},
    {"id": "rsi", "type": "rsi_cross", "period": 14, "levels": [30, 70]},
    {"id": "bb", "type": "bollinger_break", "period": 20, "stddev": 2},
    {"id": "breakout", "type": "new_extreme", "lookback": 50},
    {"id": "btc100k", "type": "price_cross", "symbol": "BINANCE:BTCUSDT", "level": 100000}
  ],
  "trending": {"enabled": true, "every_minutes": 10, "markets": ["crypto", "america"],
               "kinds": ["gainers", "volumeGainers"], "top_n": 15, "us_regular_hours_only": true},
  "alerts": {"cooldown_minutes": 60, "max_per_hour": 20,
             "quiet_hours": {"start": "23:00", "end": "07:00"}, "digest_after_quiet": true},
  "health": {"stream_down_minutes": 10, "daily_heartbeat": "08:00"},
  "state_dir": "~/.local/state/tradingview-watcher",
  "local_api": {"port": 8787},
  "limits": {"max_streams": 25}
}
```
Rules apply to every watchlist entry unless a rule names its own `symbol` or `timeframes`. More than 25 symbol × timeframe streams is a config error.

**Streams** (`stream.mjs`):
- One shared `TradingViewClient` (with credentials), and one `watchCandles({symbol, timeframe, count: 300})` per pair.
- **Closed-candle detection:** when `onData` shows a bar whose `time` is newer than the last seen, the previous bar has closed, so evaluate it. Track `lastEvaluatedTime` per stream so reconnects never evaluate a bar twice.
- On `onError` or fatal stop: restart with backoff (5s → 10s → 30s → 60s, capped) and recreate the client after connection errors.

**Indicators** (`indicators.mjs`):
- SMA, EMA, RSI (Wilder), Bollinger, ATR, matching the formulas in `core/services/indicators_calc.py`.
- `scripts/gen_indicator_fixtures.py` writes `bridge/test/fixtures/indicators.json` from the Python functions. A Node test checks results match within 1e-9, so both languages agree.

**Rules** (`rules.mjs`, pure functions on closed bars):

| Type | Fires when |
|---|---|
| `pct_move` | close vs close N bars ago ≥ threshold |
| `volume_spike` | volume ≥ multiple × SMA(volume, lookback) |
| `rsi_cross` | RSI crosses a level |
| `bollinger_break` | close outside a band |
| `new_extreme` | close > highest(high, lookback) of the **prior** bars (or the low equivalent) |
| `price_cross` | close crosses a fixed level |

- Each result: `{ruleId, symbol, timeframe, barTime, direction, values, dataAgeSeconds}`.
- Skip when the stream is stale.

**Trending scan** (`scanner.mjs`):
- Every `every_minutes`, call `getHotlist({kind, market})` for each configured market and kind.
- Skip `america` outside 09:30–16:00 New York time, Monday to Friday, when `us_regular_hours_only` is on. Holidays: skip on empty results.
- Alert only on **new entries** to the top N that weren't seen in the last 6 hours (kept in state).

**Notifications** (`notifiers.mjs` plus `queue.mjs`):
- **Discord:**
  - `POST $DISCORD_WEBHOOK_URL` with `{content, embeds:[{title, description, fields, color, timestamp, url}]}`
  - limits: content 2000 chars, embed description 4096
  - on 429, wait `retry_after`
- **Telegram:**
  - `POST https://api.telegram.org/bot$TOKEN/sendMessage` with `{chat_id, text, parse_mode: "HTML", disable_web_page_preview: true}`
  - limit 4096 chars; HTML-escape text
  - on 429, wait `parameters.retry_after`
- Every configured channel receives each alert. Uses built-in `fetch`, so **no new dependencies**.
- Message: emoji and type, `SYMBOL · timeframe`, rule and values, bar close time, data age, and a link `https://www.tradingview.com/chart/?symbol=<SYMBOL>`.
- The queue never blocks streams: 3 attempts with backoff, then drop and log (redacted).

**Spam control:**
- cooldown per `(symbol, timeframe, ruleId)`
- global `max_per_hour` (extra alerts go into a summary)
- quiet hours hold alerts and send one digest at the end
- dedupe by `(symbol, timeframe, ruleId, barTime)`

**State** (`state.mjs`): cooldowns, last evaluated bars, recent trending entries and the alert history (last 500) in `state_dir/state.json`. Writes are atomic (temp file, then rename).

**Health:**
- A stream with no update for `stream_down_minutes` (crypto always; stocks only during their session) sends one "stream down" alert, then "recovered" when it's back.
- Daily heartbeat with uptime, streams OK out of total, and alerts in the last 24 hours.
- Unhandled rejection: log, exit 1, and systemd restarts it.

**Local API** (`localapi.mjs`):
- `http.createServer`, bound to `127.0.0.1:<port>` only.
- `POST /notify` accepts `{title, body, key}` from the Phase 6 paper trader, requires header `Authorization: Bearer $WATCHER_LOCAL_TOKEN`, compared in constant time, and passes through the same spam control.
- `GET /health` reports status.

**Logs:** stderr, redacted (shared `redact.mjs`), optional JSON lines with `--log-json`.

**Pi deployment** (`bridge/watcher.service.example`):
- Steps: `git clone` into `~/code/tradingview-mcp`, then `cd bridge && npm ci --ignore-scripts`.
- Secrets go in `/etc/tradingview-watcher.env` (`chmod 600`). Config at `~/.config/tradingview-watcher/config.json`.
- Unit file:
  ```ini
  [Service]
  User=pi
  WorkingDirectory=/home/pi/code/tradingview-mcp
  EnvironmentFile=/etc/tradingview-watcher.env
  ExecStart=/usr/bin/node bridge/watcher.mjs --config /home/pi/.config/tradingview-watcher/config.json
  Restart=on-failure
  RestartSec=10
  NoNewPrivileges=yes
  ProtectSystem=strict
  ProtectHome=read-only
  ReadWritePaths=/home/pi/.local/state/tradingview-watcher
  PrivateTmp=yes

  [Install]
  WantedBy=multi-user.target
  ```
- Then `sudo systemctl enable --now tradingview-watcher`, and read logs with `journalctl -u tradingview-watcher -f`.

**Tests** (fake library, fake clock and mocked `fetch`):
- config validation, including the >25-stream error
- closed-candle detection, including reconnect replay
- each rule
- indicator fixture parity
- trending new-entry logic and US-hours gating
- Discord and Telegram payloads, limits, HTML escaping and 429 handling
- cooldown, hourly cap, quiet-hours digest and dedupe
- atomic state write and reload after restart
- stream-down and recovered alerts
- local API token check
- redaction of the webhook URL and bot token

**Done when:**
- `--test-notify` reaches Discord and/or Telegram.
- A temporary `pct_move` rule on BTCUSDT `1` with 0.1% fires, then stays quiet during its cooldown.
- Cutting the network brings "stream down", then "recovered".
- `kill` on the Pi is followed by a systemd restart.

**Commit:** `feat(watcher): always-on candle/trending alerts to Discord and Telegram`

---

## 12. Phase 6: strategy testing gauntlet

**Files:**
- `core/services/backtest_service.py`
- new `core/services/gauntlet_service.py`
- new `core/services/paper_service.py` and `src/tradingview_mcp/paper.py` (console script)
- `server.py` (tools and prompts)
- `pyproject.toml` (script entry)
- tests

### 6.1 Check the market is tradable
- Add to every backtest result: `tradability: {avg_daily_value, zero_volume_bar_pct, bars, thin_market}`.
- `thin_market` when average daily traded value is below `TRADINGVIEW_MCP_MIN_DAILY_VALUE` (default 1 000 000), or more than 5% of bars have zero volume.
- With the TradingView source, also confirm the symbol through the helper's `search`.

### 6.2 Who is on the other side?
- `strategy_gauntlet` requires `hypothesis` and `counterparty`, each at least 20 characters and not a generic phrase (small blocklist: "momentum", "it goes up", "trend", "it works", …).
- Otherwise: `verdict: "FAIL: no stated edge"` and nothing else runs.

### 6.3 Realistic costs
- `COST_PROFILES` dictionary, each value labelled an **assumption to check against your real fees**:

| Profile | Commission | Slippage |
|---|---|---|
| `binance_spot` | 0.10% | 0.05% |
| `coinbase_advanced` | 0.60% | 0.10% |
| `us_stock_broker` | 0.00% | 0.05% |
| `default` | 0.10% | 0.05% |

- `cost_profile` argument on the backtest tools; explicit percentages override it.
- New metrics: `trades_per_year`, `gross_return_pct`, `net_return_pct`, `cost_drag_pct`.
- Warnings: `trades_per_year > 200`, or `cost_drag_pct > 0.5 × gross_return_pct`.

### 6.4 No peeking at the future
- **Bar indexes:** each of the 9 runners records `entry_idx` and `exit_idx` in its trades (a small, mechanical edit per runner).
- **Fill mode:** `fill: "signal_close" | "next_open"`.
  - Default `signal_close` keeps current numbers identical.
  - `next_open` moves fills to `candles[idx+1].open` and drops a trade whose next bar doesn't exist (open positions go through `_finalize_trades` as now).
- **Test** (`tests/unit/services/test_no_lookahead.py`): for every strategy, and bar k sampled every 10 bars, trades fully decided by bar k must be identical when the runner sees `candles[:k+1]` vs all candles.

### 6.5 `strategy_gauntlet` tool
Signature: `strategy_gauntlet(symbol, strategy, hypothesis, counterparty, cost_profile="default", interval="1d", period="2y", params=None, data_source="yahoo", tv_symbol=None)`.

- **Parameters:**
  - Check `params` against `inspect.signature(runner)` (named keyword parameters, not `candles` or `**_`).
  - Keep constraints: fast < slow, periods ≥ 2.
- **Thresholds** live in one dictionary, `GAUNTLET_THRESHOLDS`, documented in the README:

| Gate | Check | Default pass rule |
|---|---|---|
| 1. Honest settings | `next_open` fills, chosen cost profile, longest available period, warm-up respected | sets up the run; fails only on an invalid setup |
| 2. Enough evidence | trades, win rate together with profit factor, max drawdown | trades ≥ 30, profit factor > 1.1, max drawdown ≤ 35% |
| 3. Parameter sensitivity | one parameter at a time × {0.8, 0.9, 1.1, 1.2} (integers rounded, deduplicated, constraints kept) | ≥ 70% of neighbours net-profitable, and median neighbour return ≥ 50% of the base |
| 4. Double costs | 2× commission and slippage | net return > 0 |
| 5. Most recent year alone | last 12 months (needs > 1 year of data) | return > 0, and Sharpe ≥ 0.5 × full-period Sharpe |
| 6. Walk-forward | reuse `walk_forward_backtest` | ROBUST or MODERATE; SKIPPED for `rsi_pullback` and `triple_ema` (reported honestly) |

- **Output:** per-gate `{status: PASS|FAIL|SKIPPED, numbers, reason}`, plus `verdict` (`PASS`, `PASS (n/6, x skipped)` or `FAIL: <gates>`), plus `strategy_fingerprint`, `report_path` and the disclaimer. **The word "profitable" never appears in a verdict.**
- **Multiple-testing warning:** `compare_strategies` adds `"multiple_testing_warning": "Best of 9 on one symbol is optimistic; run the winner through strategy_gauntlet."`

### 6.6 Paper trading forward (no real orders, ever)
- **Console script** `tradingview-mcp-paper` (`paper.py`):
  - `--report <fingerprint>` or `--latest-pass <strategy> <symbol>`
  - Refuses to start unless the report is a PASS **and** its fingerprint matches what the current code, parameters, cost profile and data source produce.
- **Each bar close:**
  - Timed to the timeframe boundary plus 15 seconds.
  - Fetch the last 500 candles through the helper.
  - Run the same Python runner, with `next_open` fills.
  - Record new hypothetical entries and exits in `~/.tradingview-mcp/paper/<fingerprint>.jsonl`, with prices and assumed costs.
- **Notifications:**
  - `POST` to the watcher's `127.0.0.1:<port>/notify` with the bearer token, one per paper trade.
  - Weekly summary: paper vs backtest expectations (trades/week, win rate, average return); flag a gap beyond 2× expected drawdown.
- **On the Pi:** a second systemd unit, `tradingview-paper.service.example`, with the same hardening.

### 6.7 Re-test every change; start small
- **Fingerprint:** `sha256` of canonical JSON containing:
  - strategy and resolved parameters
  - cost profile values
  - fill mode
  - interval, period, data source, symbol
  - package version
  - `sha256` of `backtest_service.py` and the runner source
- **Storage:** reports in `$TRADINGVIEW_MCP_HOME` (default `~/.tradingview-mcp`) under `gauntlet/<fingerprint>.json`. Every run is appended to `gauntlet/log.jsonl`.
- Docs: start with one strategy, one asset and small size; paper first; this system never trades.

### 6.8 Separate builder and reviewer
- **MCP prompts** (FastMCP `@mcp.prompt`):
  - `strategy_builder(market, timeframe)`: scan first (`tv_hotlist` / screeners), check tradability, then propose **five** hypotheses, each naming who loses, and run only the best through `strategy_gauntlet`.
  - `strategy_reviewer(fingerprint)`: load the report and try to kill it, covering counterparty plausibility, cost drag, recent-year weakness, sensitivity spread, trade count and survivorship. Default recommendation: **reject unless every gate passes clearly**.
- **`gauntlet_stats` tool:** pass/fail counts, the most common failing gate, and the kill rate from `log.jsonl`. The docs say to expect most ideas (around 6 of 7) to fail.

### 6.9 Tests (hermetic)
- no-lookahead for all 9 strategies
- `next_open` maths
- default numbers unchanged: snapshot one existing backtest result before the change and compare after
- cost profiles and warnings
- `inspect.signature` parameter checks
- sensitivity grid (rounding, constraints, deduplication)
- every gate's PASS, FAIL and SKIPPED, using synthetic candles built to trend, mean-revert or be random
- fingerprint stability and change detection
- report and log writes in a temporary home directory
- the paper runner refusing a mismatched fingerprint
- the paper runner's bar-boundary timing (fake clock)
- `/notify` payload (mocked HTTP)

**Commit(s):**
- `feat(backtest): next_open fills, cost profiles, tradability, no-lookahead test`
- `feat: strategy_gauntlet + gauntlet_stats + builder/reviewer prompts`
- `feat: paper trader (no orders) with watcher notifications`

---

## 13. Phase 7: charts (Lightweight Charts) and Pine (PyneCore)

### 7.1 Local dashboard
- **Dependency:** `lightweight-charts` **5.2.1** (exact) in `bridge/`. **Ask Adham first.** Serve it from `node_modules` (no CDN), so the dashboard works offline.
- **Server:** in the watcher, Node `http` only (no frameworks). Binds to `127.0.0.1` by default.
  - If `dashboard.host` isn't loopback, require `WATCHER_DASHBOARD_TOKEN`: `Authorization: Bearer`, or `?token=` once, which sets an HttpOnly SameSite=Strict cookie. Compare in constant time.
  - Security headers: `Content-Security-Policy: default-src 'self'` (no inline script), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- **Routes** (all read-only):

| Route | Purpose |
|---|---|
| `/` | page |
| `/assets/*` | static files |
| `/api/watchlist` | watchlist |
| `/api/candles?symbol=&tf=` | from watcher memory |
| `/api/alerts?limit=` | recent alerts |
| `/api/paper` | paper journals |
| `/api/gauntlet` | report summaries from `$TRADINGVIEW_MCP_HOME/gauntlet` |
| `/events` | server-sent events: new bars, alerts |

- **Charts** (v5 interface; check against `dist/typings.d.ts`):
  - `createChart(el, {layout: {attributionLogo: true}})`
  - `chart.addSeries(CandlestickSeries)` and `chart.addSeries(HistogramSeries)` for volume
  - `createSeriesMarkers(series, markers)` for alerts and paper trades
  - `series.createPriceLine({price})` for rule levels
- **Attribution:** keep the logo on, and add a footer "Charts by TradingView" linking to `https://www.tradingview.com/` (required by the library's NOTICE).

### 7.2 Chart images on alerts (optional, default off)
- **Dependency:** `playwright-core` (exact). **Ask Adham first.**
- **Browser:** system Chromium through `WATCHER_CHROMIUM_PATH` (Pi: `/usr/bin/chromium`); `playwright install` is never run.
- **Rendering:**
  - One browser kept open.
  - An internal route `/render?symbol&tf&alert=<id>` draws the last 120 bars with the level and marker.
  - Screenshot the chart element as PNG, 10-second timeout, at most `images_per_hour` (default 6).
- **Sending:** Discord via multipart `files[0]` plus `payload_json`; Telegram via `sendPhoto` (multipart, with caption).
- **Fallback:** if anything fails, send text plus a dashboard link.

### 7.3 Pine logic through PyneCore (optional extra)
- **Check before adding:**
  1. the licence in the PyneSys/pynecore repo, since PyPI metadata has none
  2. whether running **Pine** source needs PyneSys's online compiler or an API key, versus hand-written Pyne `.py` scripts running offline
  3. the programmatic API for running a script on our candles (it may need a data-file format), and how strategy trades come out

  **Ask Adham** before adding it, and before sending any script to an online service.
- **Install:** `[project.optional-dependencies] pine = ["pynesys-pynecore==<exact>; python_version >= '3.11'"]`. On Python 3.10 the feature returns `DEPENDENCY_MISSING` with "requires Python 3.11+ and the [pine] extra".
- **`core/services/pine_service.py`:**
  - Runs scripts **only** from `$TRADINGVIEW_MCP_HOME/strategies/`. Names must match `^[a-z0-9_-]+$`, so no paths.
  - Pyne scripts are Python, so **running one runs code**. Never download and run automatically; docs say to read community scripts first.
  - Run on the same candles as the backtest, and convert trades to the repo's format with `entry_idx` and `exit_idx`.
- **Gauntlet support:** `strategy_gauntlet(..., strategy="pine:<name>")` runs all gates, plus the 6.4 no-lookahead check on the script, to catch repainting and `lookahead_on` misuse.
- **Check the maths:**
  - A committed fixture (`tests/unit/fixtures/pine_parity.json`) for RSI(14), EMA(20) and BB(20,2) on fixed candles.
  - A unit test checks PyneCore matches within the recorded tolerance.
  - A `stress` test compares live against `tv_indicator` on identical candles.
- **Where to find scripts:** `awesome-pinescript` and everget's indicator collection. Check each script's licence.

### 7.4 Tests
- dashboard routes and server-sent events (fake stream)
- token required when not loopback
- CSP header present
- attribution present in the HTML
- image fallback when Chromium is missing
- Discord multipart / Telegram `sendPhoto` payloads (mocked)
- Pine: name validation, refusal outside the strategies folder, trade conversion, lookahead caught on a deliberately leaky script, parity fixture

**Commit(s):**
- `feat(watcher): local Lightweight Charts dashboard`
- `feat(watcher): optional alert chart images`
- `feat: PyneCore Pine strategies in the gauntlet (optional extra)`

---

## 14. Environment variables

| Variable | Used by | Default / notes |
|---|---|---|
| `TRADINGVIEW_SESSION_ID`, `TRADINGVIEW_SESSION_SIGN` | bridge, scanner | secret; enables logged-in data |
| `TRADINGVIEW_BRIDGE_NODE`, `TRADINGVIEW_BRIDGE_PATH` | Python client | `which node`; repo `bridge/server.mjs` |
| `TRADINGVIEW_BRIDGE_MAX_INFLIGHT` | bridge | 2 |
| `TRADINGVIEW_MCP_SCANNER_USE_SESSION` | scanner | 1 when credentials exist |
| `TRADINGVIEW_MCP_NO_DOTENV` | `.env` loader | unset |
| `TRADINGVIEW_MCP_HOME` | gauntlet, paper, Pine | `~/.tradingview-mcp` |
| `TRADINGVIEW_MCP_MIN_DAILY_VALUE` | tradability | 1 000 000 |
| `DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | watcher | secret; each channel optional |
| `WATCHER_LOCAL_TOKEN` | watcher `/notify`, paper | secret; required for `/notify` |
| `WATCHER_DASHBOARD_TOKEN` | dashboard | secret; required off-loopback |
| `WATCHER_CHROMIUM_PATH` | images | none, which disables images |
| existing `TRADINGVIEW_MCP_*` cache/retry variables | scanner | unchanged |

## 15. Checks before every commit
1. `uv run pytest tests/unit -q`, run normally **and** with Node hidden (`PATH` without node).
2. `cd bridge && npm ci --ignore-scripts && node --test`, once Phase 1 exists.
3. `git diff --cached | grep -nE 'sessionid|sessionid_sign|bot[0-9]+:|discord(app)?\.com/api/webhooks'` must show nothing except variable names and docs.
4. Re-read the diff: default behaviour unchanged, no new unapproved dependencies, `server.py` routing only.

## 16. Final acceptance (all phases)
1. Unit and Node tests green; CI green (Python 3.10–3.13 without Node; bridge job on Node 20 and 22).
2. **Without credentials:** existing tools work as before, plus `data_freshness`; `tv_*` tools return `NOT_CONFIGURED`.
3. **With cookies in `.env`:**
   - `tv_candles("BTCUSDT","BINANCE","1h",500)` returns 500 bars
   - `tv_indicator(... "STD;RSI")` returns values
   - `backtest_strategy(..., data_source="tradingview", tv_symbol="BINANCE:BTCUSDT", interval="4h")` works
   - `stock_screener` reports `auth: "session"`
4. **Helper process:** killing `node` mid-session leads to a restart on the next call, or a clean fallback, with no hang.
5. **Docker:** `docker build .` succeeds and `/health` returns 200 without credentials.
6. **Watcher:**
   - `--test-notify` delivers
   - a test rule fires once, then cools down
   - stream down and recovered alerts work
   - systemd restarts it after `kill`
7. **Gauntlet:**
   - returns six gates and a verdict
   - a blank counterparty gives `FAIL: no stated edge`
   - default `backtest_strategy` numbers are unchanged
   - paper mode refuses a changed strategy
8. **Charts and Pine:**
   - the dashboard shows live candles with TradingView attribution
   - alerts carry an image, or a link when images are off
   - Pyne RSI matches within tolerance
   - a leaky Pine script fails the lookahead gate

## 17. Risks and how this plan handles them
- **Account flagged by TradingView:** one connection, at most 2 in flight, at most 25 streams, trending scan ≥ 5 minutes, read-only.
- **Unofficial interface changes:** exact pins, typed errors, fallback to existing sources, freshness labelling.
- **Leaked secrets:** environment variables only, redaction everywhere with tests, a grep check before commits, a narrow environment allowlist for child processes, systemd `EnvironmentFile` with `chmod 600`.
- **npm supply chain:** one pinned dependency (later two or three, each with approval), lockfile, `--ignore-scripts`, `npm audit` in CI, `package.json` only under `bridge/`.
- **Overfitting and false confidence:** the gauntlet, verdict wording, multiple-testing warning, paper trading only, no execution.
- **Running untrusted Pine/Pyne code:** local folder only, name allowlist, never downloaded automatically, documented.

## 18. Out of scope
Placing orders or connecting any broker or exchange account. Paid-plan-only features (TradingView webhooks, the TradingView Desktop MCP). Claude-written summaries on a schedule (a possible later addition). Exposing the dashboard to the internet.

---

## Hand-off prompt (give this to Adham after pushing)

**Run this in Claude Code (Ubuntu)**
- **Where:** either PC; the watcher and paper trader later run on the Pi.
- **Start:**
  ```bash
  # first time only:
  git clone https://github.com/adhfult/tradingview-mcp ~/code/tradingview-mcp

  cd ~/code/tradingview-mcp && git fetch origin \
    && git checkout -b feat/tradingview-api origin/claude/lucid-bardeen-3ou62p \
    && claude
  ```
- **Settings:** `/effort xhigh` and plan mode (Shift + Tab) for planning; switch to `/effort high` to build each phase.
- **Prompt to paste:**

> Project: tradingview-mcp. Implement `docs/plans/tradingview-api-integration.md` (the master plan) one phase at a time, Phase 0 → 7. Read the whole plan, `SECURITY.md` and `pyproject.toml` first.
>
> - **Per phase:** plan, implement, test, run the §15 checks, commit, then stop and wait for my review. Ask before pushing.
> - **Library versions:** §2 records versions and interfaces checked on 2026-10-10. Re-check the latest versions before pinning, and tell me if anything differs.
> - **Dependencies:** ask me before adding any dependency (lightweight-charts, playwright-core and pynesys-pynecore included).
> - **Secrets:** they come only from the environment or the gitignored `.env`. Never read, print, log or commit their values.
> - **Defaults:** default behaviour and default backtest numbers must not change.
> - **Read-only:** nothing places real trades.
> - **Phase 6:** it is independent of Phases 1–5 and can be done right after Phase 0 if I ask.

- **Done when:** everything in §16 passes; the parts needing your cookies, Discord/Telegram or the Pi are steps you run yourself.

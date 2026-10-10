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
4. **Live data streaming is out of scope.** MCP tools answer one request at a time. Use the library's one-shot calls (`getCandles`, `getQuote(s)`, `getIndicatorData`, `searchMarkets`, `getScreener`). The `watch*` functions can come later.
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

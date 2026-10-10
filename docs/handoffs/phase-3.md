# Phase 3: tv_* tools + wiring TradingView account data into existing code

## Brief (Opus)

**Goal:**
- New MCP tools backed by the Node bridge (Phase 1), called through the Python client (Phase 2).
- Backtests can use TradingView candles.
- The scanner sends session cookies when they are configured.
- `data_freshness` reports where each piece of data came from and whether it used the account.

**Master plan:** §9. Phase 0 decisions are in `docs/handoffs/STATUS.md` → "Decisions".

### Read first
- `src/tradingview_mcp/core/services/tv_bridge_client.py`: the real API (`get_client()`, `BridgeClient.call/acall/is_available/has_credentials`, `BridgeError.to_envelope()`).
- `bridge/server.mjs`: method names, params and result shapes.
- `src/tradingview_mcp/core/services/freshness.py`: `record(source, fetched_at, *, cache_hit, stale, auth)`, `summarize`, `attach`.
- `src/tradingview_mcp/core/services/screener_provider.py`: `_scan_with_retry`, `resilient_get_multiple_analysis`.
- `src/tradingview_mcp/core/utils/validators.py`: `validate_exchange`, `validate_timeframe`, `to_tv_timeframe`, `normalize_tradingview_symbol`, `get_tv_exchange_prefix`, `get_market_type`.
- `src/tradingview_mcp/core/services/backtest_service.py`: `_fetch_ohlcv`, `run_backtest`, `compare_strategies`, `walk_forward_backtest`, `_ANNUALIZATION`, `_VALID_PERIODS`, `_VALID_INTERVALS`.
- `server.py`: tool pattern, `ToolAnnotations`, the `_offload_sync_tools` and `_attach_freshness_to_tools` wrappers.
- `tests/unit/test_tool_annotations.py` and `tests/unit/test_tool_offload.py`, which cover all tools.

### Rules
- Don't change default behaviour. **Default backtest numbers must be identical** (Yahoo stays the default source). Existing tool outputs change only through `data_freshness` content.
- Hermetic tests. Fake the bridge with a stub object exposing `call`/`acall`/`is_available`/`has_credentials` (monkeypatch `tv_bridge_client.get_client`), or reuse `tests/unit/fixtures/fake_bridge.py`. Never real Node or the network.
- Never guess. Read the code. Report mismatches and don't invent.
- No new dependencies. No secrets. Don't commit or push.
- `server.py` stays routing only. Logic goes in `core/services/tv_data_service.py`.

### 1. Freshness: auth per source (small change to Phase 0)
In `freshness.summarize`:
- Add `auth_by_source: {source: "session" | "anonymous" | "mixed"}`.
- Compute the top-level `auth` **only over TradingView sources** (any source starting with `tradingview`). Yahoo is always anonymous, and counting it would make every mixed result say "mixed". If there are no TradingView sources, `auth` is `"anonymous"`.
- Update the Phase 0 tests that assert `auth` accordingly. Keep their intent.

**Source names** (used by `record()` calls):

| Source | Meaning |
|---|---|
| `tradingview_scanner` | screener endpoint (tradingview-screener) |
| `tradingview_ta` | tradingview_ta library; change `resilient_get_multiple_analysis` to record this name |
| `tradingview_bridge` | Node bridge |
| `yahoo` | Yahoo |

### 2. Logged-in scanner
- In `screener_provider.py`, add `session_cookies() -> Optional[dict]`:
  - returns `{"sessionid": ..., "sessionid_sign": ...}` when **both** `TRADINGVIEW_SESSION_ID` and `TRADINGVIEW_SESSION_SIGN` are non-empty **and** `os.environ.get("TRADINGVIEW_MCP_SCANNER_USE_SESSION", "1") != "0"`; otherwise `None`
  - **Never log the values.** Make sure `.env` has been loaded before the check: call `tv_bridge_client`'s loader, or `env_file.load_env_file_once()` directly.
- In `_scan_with_retry(q, cookies=None, cache_key=None)`:
  - If the caller passed `cookies=None`, use `session_cookies()`. Keep an explicit `cookies` argument as is.
  - Add the auth flag to the cache key: when `cache_key` is given, use `cache_key + (("auth", "session" if cookies else "anonymous"),)` for both `_cache_set` and `_cache_get_stale`.
  - It already records `auth="session" if cookies else "anonymous"`. Keep that.
- **Direct callers** (check `get_scanner_data_raw` forwards `**kwargs` to `requests.post` in `.venv/.../tradingview_screener/query.py`; it does in 3.0.0):
  - `futures_service.py`: every `q.get_scanner_data(timeout=_SCAN_TIMEOUT_S)`. Use a small helper that passes `cookies=session_cookies()` only when it's not `None`, then `freshness.record("tradingview_scanner", time.time(), auth=...)` after success.
  - `stock_screener_service.py`: `query.get_scanner_data(timeout=20)`, same treatment.
- `tradingview_ta` calls stay anonymous (that library has no cookie support).

### 3. `core/services/tv_data_service.py` (new)
Sync functions that the tools call (the offload wrapper runs them in threads):
- `_client()` returns `tv_bridge_client.get_client()`.
- `_record()` calls `freshness.record("tradingview_bridge", time.time(), auth="session" if client.has_credentials() else "anonymous")`. Call it after every successful bridge call.
- **Every function** catches `BridgeError` and returns `err.to_envelope()`. Validation problems return `make_error(ErrorCode.INVALID_PARAMETER, ...)` or the existing `ScreenerServiceError` envelope pattern; read how `server.py` handles `ScreenerServiceError` for other tools and copy it.

| Function | Behaviour |
|---|---|
| `tv_status()` | `{configured: bool, reason: str \| None, has_credentials: bool, bridge_ok: bool, setup: SETUP_HINT if not configured}`. **Never include values.** |
| `get_candles(symbol, exchange, timeframe="1D", count=300)` | `count` is 1..1000. Build the symbol with `normalize_tradingview_symbol(symbol, validate_exchange(exchange))`, then call `candles` with `{symbol, timeframe: to_tv_timeframe(timeframe), count}`. Output: `{symbol, timeframe, bars, columns: ["time","open","high","low","close","volume"], rows: [[iso_utc, o, h, l, c, v], ...], first: iso, last: iso, last_close, change_pct_over_range}`. `iso_utc` comes from candle `time` (unix seconds, bar open) and is formatted `%Y-%m-%dT%H:%M:%SZ`. |
| `get_quotes(symbols)` | `symbols` is a comma-separated string of `EXCHANGE:SYMBOL`, 1..50 entries, each upper-cased and checked against `^[A-Z0-9_.!\-]+:[A-Z0-9_.!\-]+$`. Calls `quotes`. Returns `{quotes: {SYM: <only these keys if present: lp, ch, chp, volume, bid, ask, current_session, update_mode, description, currency_code>}}`. **Check which keys the library really returns**: read `dist/quote/fields.d.ts` in `bridge/node_modules/@mathieuc/tradingview/` and use the real names. |
| `get_indicator(symbol, exchange, indicator, timeframe="1D", inputs=None, count=100)` | `count` is 1..500. `inputs` is a dict or None. Calls `indicator`. Passes the result through. |
| `search_symbols(query, type=None)` | Calls `search`. |
| `get_hotlist(kind="gainers", market="crypto", limit=25)` | `kind` is one of `gainers`, `losers`, `mostActive`, `volumeGainers`. `limit` is 1..100, sent as `range=[0, limit]`. |

### 4. Tools in `server.py`
Five new tools plus `tv_status`. Every one:
- uses the `@mcp.tool(annotations=ToolAnnotations(title=..., readOnlyHint=True, destructiveHint=False, openWorldHint=True))` pattern
- is a **sync** `def` that calls the service, so `_offload_sync_tools` threads it
- has a docstring with args and a one-line "needs the Node bridge; see `tv_status`"

Tools: `tv_status`, `tv_candles`, `tv_quotes`, `tv_indicator`, `tv_symbol_search`, `tv_hotlist`.

Also update:
- the FastMCP `instructions` string: mention the `tv_*` tools and that they use the user's TradingView account when configured
- the `yahoo_price` and `stock_prices` docstrings: add "for TradingView prices use tv_quotes"

### 5. Backtests on TradingView candles
Add `data_source: str = "yahoo"` and `tv_symbol: Optional[str] = None` to `run_backtest`, `compare_strategies`, `walk_forward_backtest` (after the existing params; keep positional order) **and** to their three tools in `server.py`.
- **`data_source == "yahoo"`:** exactly today's behaviour and validation.
- **`data_source == "tradingview"`:**
  - `tv_symbol` is required (format `EXCHANGE:SYMBOL`)
  - valid periods: `_VALID_PERIODS | {"3y","5y"}`
  - valid intervals: `{"15m","1h","4h","1d"}`
  - bad values give an error dict listing the allowed values for that source
- **New `_fetch_ohlcv_tv(tv_symbol, period, interval)`:**
  - `from_ts = now - days(period)` with `1mo=30`, `3mo=91`, `6mo=182`, `1y=365`, `2y=730`, `3y=1095`, `5y=1826`
  - call bridge `candles` with `{symbol: tv_symbol, timeframe: {"15m":"15","1h":"60","4h":"240","1d":"D"}[interval], from: from_ts}` and `timeout_s=60`
  - convert to the existing candle dict shape `{"date": ..., "open", "high", "low", "close", "volume"}`, with `date` formatted `"%Y-%m-%d %H:%M"` for intraday and `"%Y-%m-%d"` for `1d`, from candle `time` in UTC, rounded like Yahoo (4 dp)
  - drop candles with any `None` among the OHLC values
  - **ensure dates are unique** (keep the last on a duplicate)
  - call `freshness.record("tradingview_bridge", ...)`
  - on `BridgeError`, raise `RuntimeError(err.message)` so the existing error handling in `run_backtest` turns it into its normal error dict. Check how `run_backtest` handles a `_fetch_ohlcv` exception and match it.
- **Annualization when the source is TradingView**, unless `periods_per_year` was given:
  - crypto (TradingView prefix, lower-cased, has `get_market_type(prefix) == "crypto"`): `{"15m": 35040, "1h": 8760, "4h": 2190, "1d": 365}`
  - otherwise: `{"15m": 6552, "1h": 1638, "4h": 504, "1d": 252}`

  Pass it in through the existing `periods_per_year` mechanism. Read `_calc_metrics` to see how it's used.
- **Result fields:** `data_source` becomes `"TradingView (session)"` or `"TradingView (anonymous)"` (from `has_credentials()`), and `"Yahoo Finance"` for Yahoo. Add `"tv_symbol"` when used. `timeframe` labels for `15m` and `4h`: "15-minute (15m)" and "4-hour (4h)".

### 6. Tests (all hermetic)
- **`tests/unit/services/test_tv_data_service.py`**, with a stub client:
  - each function's happy path and shapes
  - validation errors
  - `BridgeError` becomes an envelope
  - `tv_status` contains no secret values: set fake env values and assert they're absent from `json.dumps(result)`
  - candle time to ISO conversion
  - freshness records `tradingview_bridge` with the right auth
- **`tests/unit/services/test_backtest_tv_source.py`:**
  - the Yahoo default path is unchanged: mock `_fetch_ohlcv`, run `run_backtest`, assert the same numbers as before; or compare a run with and without `data_source="yahoo"`
  - TradingView path: the stub returns synthetic candles; check conversion, unique dates, annualization chosen by market, extended periods and intervals accepted only for TradingView, a missing `tv_symbol` error, and a bridge error becoming the normal error dict
- **`tests/unit/services/test_scanner_session.py`:**
  - `session_cookies()` with and without env and with the opt-out
  - `_scan_with_retry` passes cookies to `q.get_scanner_data` (fake `q` records kwargs) and splits the cache key by auth
  - futures and stock-screener direct calls pass cookies only when present (mock the `Query` objects)
- **Freshness:** `auth_by_source`, and `auth` computed over TradingView sources only.
- The existing annotation and offload tests must cover the new tools automatically. If either keeps a hard-coded tool list or count, update it.

### Acceptance
- `uv run pytest tests/unit -q` passes, and also with Node hidden (`PATH=/usr/bin:/bin /root/.local/bin/uv run pytest tests/unit -q`).
- `cd bridge && npm test` still passes (unchanged).
- No new dependencies.

### Report (append under "## Implementation report (Haiku)")
- files changed
- the real quote field names you found
- mismatches
- the real last lines of both pytest runs

### Additions from the Phase 1 advisor (Fable), required
- **`technical`:** the bridge returns `null` on HTTP 429/403 as well as when there's no rating. If you add a tool for it, treat `null` as "unknown, possibly rate-limited", never as "no rating", and never cache it.
- **`tv_status`** reports `bridge_ok` from `health`, but `health` says ok even with bad cookies. Don't claim the cookies are valid. Phrase it as "credentials present: yes/no", and add a note that `AUTH_FAILED` on a real call means the cookies need refreshing.
- **Credentials are read once** when the bridge process starts. If `tv_status` or a call returns `AUTH_FAILED`, the message must say: "after updating .env, restart the MCP server (or the bridge restarts on its next crash)". Phase 3 doesn't need a hot reload.
- **Auth cool-down:** the bridge blocks new connections for 60s after `AUTH_ERROR` (added after the Phase 1 advisor review). Don't retry `AUTH_FAILED` automatically anywhere.

### Corrections from the Phase 2 advisor (Fable), verified by Opus and sent to the implementer
1. `_fetch_ohlcv_tv` must send `timeoutMs: 60000` (the bridge default is 15000 ms) and `maxCount: 20000` in the bridge params.
2. The library caps `from` fetches at 20,000 bars. TradingView backtests allow only these period × interval combinations:
   - 15m up to 6mo
   - 1h up to 2y
   - 4h up to 5y
   - 1d any

   Anything else gets an error listing the allowed periods. If the first candle is more than 10% of the span later than `from`, the result gets `truncated: true` and a note.
3. `AUTH_FAILED` wording: "Update TRADINGVIEW_SESSION_ID / TRADINGVIEW_SESSION_SIGN in .env, then restart the MCP server." (A bridge restart alone keeps the old cookies.)

## Implementation report (Haiku)

### Files changed
- **New:** `src/tradingview_mcp/core/services/tv_data_service.py` (tv_status, get_candles, get_quotes, get_indicator, search_symbols, get_hotlist; shared helpers `is_tv_symbol`, `bridge_error_message`, `AUTH_RESTART_HINT`, `tv_periods_per_year`).
- **Modified:** `core/services/freshness.py` (auth rolled up over `tradingview*` sources only; new `auth_by_source`), `core/services/screener_provider.py` (`session_cookies()`, `scanner_get_data()`, auth-aware `_scan_with_retry` and cache key, TA sources renamed to `tradingview_ta`), `core/services/futures_service.py` and `core/services/stock_screener_service.py` (6 direct scanner calls go through `scanner_get_data`), `core/services/backtest_service.py` (`data_source` / `tv_symbol` on run_backtest, compare_strategies, walk_forward_backtest; `_fetch_ohlcv_tv`, period×interval combo rules, `maxCount`/`timeoutMs`, truncation flag, TV annualization), `server.py` (6 `tv_*` tools, backtest tool params, instructions, yahoo_price/stock_prices docstrings).
- **New tests:** `tests/unit/services/conftest.py` (StubClient + `tv_stub` fixture), `test_tv_data_service.py`, `test_backtest_tv_source.py`, `test_scanner_session.py`.
- **Updated Phase 0 / Phase 2-era tests:** `test_freshness.py` (exact-dict test gets `auth_by_source`; TA source expectation `tradingview_ta`; stale-fallback key now stored under `key + (("auth","anonymous"),)`; ta_env fixture clears session env), `test_screener_provider_resilience.py` (same cache-key change; fast_retry fixture clears session env).
- **Not touched:** `bridge/`, `tv_bridge_client.py`, `env_file.py`.

### Quote field names (from `bridge/node_modules/@mathieuc/tradingview/dist/quote/fields.d.ts`)
All ten names in the brief exist in the `QuoteField` union: `lp`, `ch`, `chp`, `volume`, `bid`, `ask`, `current_session`, `update_mode`, `description`, `currency_code`. Note: `current_session` and `update_mode` appear only in the union, not in the typed `QuoteData` interface (they pass through its index signature). `getQuotes` returns `Record<symbol, QuoteData>`; the bridge passes that through unchanged, so `get_quotes` unwraps it by symbol.

### Mismatches and decisions
1. **Brief line 140** still reads "or the bridge restarts on its next crash". That is superseded by correction 3, and the code uses the correction 3 text: "Update TRADINGVIEW_SESSION_ID / TRADINGVIEW_SESSION_SIGN in .env, then restart the MCP server."
2. **`timeout_s=60` alone is not enough.** The bridge's default `timeoutMs` is 15 s, so `_fetch_tv_candles` also sends `timeoutMs: 60000` and `maxCount: 20000` (corrections 1 and 2). `from` is sent with no `count`, as the bridge requires.
3. **Combo rules** (correction 2): 15m up to 6mo, 1h up to 2y, 4h and 1d up to 5y. Other combinations are rejected before any call, with the allowed periods listed. `truncated: true` and a `note` are added only when the first candle is more than 10% of the span after `from`.
4. **Annualization gap, not fixed:** `get_market_type` defaults unknown prefixes to `crypto`, so `TVC:*` (CFD) and `OANDA:*` (forex) get the crypto factor. I followed the brief's rule; flagging it for review.
5. **Output shapes the brief left open:**
   - `get_candles.change_pct_over_range` is the first bar's open to the last bar's close.
   - `get_quotes` also returns `missing` (requested symbols with no data).
   - `tv_status.setup` is `null` when configured.
   - `tv_status` records no freshness, since it returns no market data.
   - `tv_symbol_search` returns `{query, count, results}`.
   - `tv_hotlist` and `tv_indicator` return the bridge result plus `kind`/`market` and `symbol`/`timeframe`/`indicator`.
6. **Technical `null` advisory:** not applicable, because no `technical` tool is in this phase.
7. **Library cap:** a `from` fetch returns the most recent 20,000 bars, so intraday history can be truncated at the old end. The combo rules and truncation flag address this.
8. **Phase 0 test changes** are the four listed under "Updated". Each keeps its original intent.
9. **Futures and stock tool outputs** now carry `data_freshness` (source `tradingview_scanner`). This is the only change to existing tool output, as the brief allows.
10. **Repo state:** HEAD moved to `07ef6fe` ("WIP snapshot: phases 3 and 5 implementation..."), committed by another agent. It contains my in-progress edits. I did not commit, push, stash, or reset. `backtest_service.py` and `STATUS.md` were also changed on disk by someone else during my work; I kept the disk version, and the suite passes.
11. **Lint:** no linter is installed. An AST check of touched files found only a pre-existing unused `get_market_type` import in `screener_provider.py`, which I left alone.
12. **Not run:** live `tv_*` calls (per STATUS, Adham-only). All tests are hermetic: stub client, the existing fake bridge process, or patched Query objects.

### Verification
- `cd bridge && npm test`: `# tests 207 / # pass 207 / # fail 0`
- `uv run pytest tests/unit -q`: last line `658 passed in 11.15s`
- `PATH=/usr/bin:/bin /root/.local/bin/uv run pytest tests/unit -q`: last line `658 passed in 11.07s`

## Review report (Sonnet)

### Default behaviour: proven unchanged
Compared the pre-Phase-3 `backtest_service.py` (`git show 82ef2f8:...`, loaded as a temp module) against the current one, with `_fetch_ohlcv` patched to the same deterministic candles (520 daily, 900 hourly):
- `run_backtest`: 9 strategies x {plain, `include_trade_log`+`include_equity_curve`, `risk_free_rate`+`periods_per_year`} x {1d, 1h}
- `compare_strategies`: 1d and 1h
- `walk_forward_backtest`: 7 strategies x {1d, 1h}

Result: **0 mismatches** (full-dict equality, `timestamp` and `data_freshness` excluded). Error messages for invalid Yahoo period/interval are byte-identical (already pinned by Haiku's tests).
Pinned in the new `tests/unit/services/test_backtest_yahoo_parity.py` (14 tests): per-strategy return/trades/Sharpe plus a SHA-256 digest of each full result, taken from the OLD code.

### Defects found and fixed
1. **Annualization used crypto's 24/7 factor for forex, CFDs and unknown exchanges** (`tv_data_service.py` `tv_periods_per_year`, via `get_market_type`'s crypto default). Now:
   - known crypto venue -> 365 days x 24h (`{15m:35040, 1h:8760, 4h:2190, 1d:365}`). The set is the `EXCHANGE_SCREENER` entries whose screener is `crypto` (minus the `all` placeholder) plus a few TradingView crypto prefixes the screener does not list (kraken, bitstamp, binanceus, bitmex, deribit, phemex, bithumb, upbit, gemini, poloniex, bingx, cryptocom, coinex).
   - forex/CFD venue (`_TA_ONLY_SCREENERS`: oanda, fx_idc, fxcm, tvc, capitalcom; plus forexcom, pepperstone, icmarkets, eightcap, saxo, skilling, blackbull) -> 260 weekdays x 24h (`{15m:24960, 1h:6240, 4h:1560, 1d:260}`).
   - stocks and any unknown prefix -> `{15m:6552, 1h:1638, 4h:504, 1d:252}`.
   `get_market_type` itself is untouched (the screener paths still rely on its crypto default).
2. **`search` and `hotlist` were recorded as `auth="session"` when credentials existed**, but the bridge sends no cookies for either (`bridge/server.mjs`: "searchMarkets takes HttpOptions only", hotlist "deliberately anonymous"). That made `data_freshness.auth` claim an account-backed result that was anonymous. `_record(client, uses_account=False)` now labels them anonymous (`tv_data_service.py` `_record`, `search_symbols`, `get_hotlist`).
3. **`tv_status` ignored the client's cool-down.** While cooling down, `is_available()` returns False, so the tool reported a bridge that was merely paused as plain "down". It now adds `cooling_down` and `cooldown_remaining_s` (from `cooling_down()` / `cooldown_remaining_s()`), and `bridge_ok` is False without probing while cooling. Still no values anywhere.
4. **Symbol length not checked locally.** The bridge rejects symbols over 40 characters and any other characters; `tv_candles`/`tv_indicator` accepted anything after `normalize_tradingview_symbol` (for example `BTC USDT`) and only failed after a bridge round trip, and `tv_quotes` used a regex without the length cap. `is_tv_symbol` now caps at 40, `_full_symbol` validates the built `EXCHANGE:SYMBOL`, and `_parse_symbols` uses the same check. Bad input now returns `INVALID_PARAMETER` with no bridge call.

### Checked, no defect
- Bridge params: `candles` sends `from`, `maxCount: 20000`, `timeoutMs: 60000`, `timeout_s=60`, never `count`; combo caps (15m<=6mo, 1h<=2y, 4h/1d<=5y) are enforced before any call for all three tools; every allowed combo fits 20,000 bars even for 24/7 markets (new test). Truncation uses `first_ts - from > 10% x span`; boundary tests added (9% no, 11% yes), also on compare and walk-forward.
- Cookies: `session_cookies()` needs both vars non-empty and respects `TRADINGVIEW_MCP_SCANNER_USE_SESSION=0`; loads `.env` first; values never appear in logs, stderr, results or errors; cache keys carry `("auth", ...)`, so session and anonymous payloads never cross (including the stale fallback); `tradingview_ta` stays anonymous and is recorded as `tradingview_ta`; direct callers record only after success.
- Freshness: `auth` is rolled up over `tradingview*` sources only, `auth_by_source` covers all; mixed sources verified (session scanner + anonymous TA + Yahoo -> `mixed`, with the per-source map).
- Error mapping: all bridge codes map to the right envelope for all five data functions; `AUTH_FAILED` always carries "Update TRADINGVIEW_SESSION_ID / TRADINGVIEW_SESSION_SIGN in .env, then restart the MCP server."; freshness goes through `freshness.record("tradingview_bridge", ...)`, never hand-built; failed calls record nothing.
- Tool docstrings and annotations are accurate; `tv_status` docstring matches behaviour.

### Tests added (658 -> 777)
- `tests/unit/services/test_backtest_yahoo_parity.py` (new, 14): Yahoo default numbers pinned from the pre-Phase-3 code (run/compare/walk-forward, 1d and 1h, tool wrapper, `tv_symbol` ignored on Yahoo, bridge never touched).
- `test_backtest_tv_source.py` (+~35): annualization by market (crypto/forex/CFD/stock/unknown, every screener crypto venue, non-crypto screener venues), factor reaching `_calc_metrics` in compare and walk-forward, combo caps and long-fetch params for compare/walk-forward, bar-cap bound for every allowed combo, truncation boundary, bad bridge replies, no cookie leak in results.
- `test_tv_data_service.py` (+~60): every bridge code x every function -> envelope/retryable, exact `AUTH_FAILED` text, secret redaction in error text, bad/over-long symbols, search/hotlist recorded anonymous, account calls recorded with the right auth, `tv_status` cool-down fields, tools through the offload + freshness wrappers (`data_freshness.auth_by_source`), docstring "see `tv_status`" and `openWorldHint` for each tool.
- `test_scanner_session.py` (+5): `.env` loaded before the check, opt-out beats cookies on every path, explicit cookies cached apart from anonymous, failing scan leaks no cookie values, scanner+TA+Yahoo rollup.
- `test_tool_annotations.py` / `test_tool_offload.py` (+1 each): the six `tv_*` tools by name.
- `tests/unit/services/conftest.py`: `StubClient` gained `cooling_down()` / `cooldown_remaining_s()`.

### Follow-ups (not done)
- `tv_bridge_client._AUTH_MESSAGE` (Phase 2, pinned by `test_tv_bridge_client.py`) still says "copy fresh sessionid / sessionid_sign into .env". The tv service overrides it, so tool output is right, but any future caller using `err.to_envelope()` directly would show the old wording. Change both together when convenient.
- Futures venues (CME, CBOT, NYMEX, COMEX ...) trade ~23h x 5 days; they fall in the stock bucket now. Add a futures bucket if futures backtests matter.
- The 10% truncation rule can flag a false positive for 1-month daily stock requests when `from` lands just before a long weekend. It follows the brief; a bar-count-aware rule would be more precise.
- The tool aliases `timeframe="1m"` to monthly (`1M`), a pre-existing alias, not minutes; worth a docstring note on `tv_candles`.

### Verification
- `uv run pytest tests/unit -q`: `777 passed in 11.58s`
- `PATH=/usr/bin:/bin /root/.local/bin/uv run pytest tests/unit -q`: `777 passed in 11.47s`
- Parity script (old vs new on identical candles): `mismatches: 0`

## Advisor fixes (Sonnet)

### Changes
1. **Python-side in-flight cap (must-fix)** - `tv_bridge_client.py`. The bridge's semaphore is an unbounded FIFO and its `timeoutMs` deadline starts only after a slot is acquired, while the client gives up (~70 s) without cancelling, so a burst produced retryable client TIMEOUTs while the bridge still ran every queued call with the account cookies (zombie work plus a retry storm). `BridgeClient` now owns a `threading.BoundedSemaphore(max_inflight + 2)`; `max_inflight` is read from `TRADINGVIEW_BRIDGE_MAX_INFLIGHT` (client's env source, same rule as the bridge: default 2, clamped 1..8, non-numeric/0 -> 2). `call()` acquires it around start + request for every method except `health` (exempt, like the cool-down). If no slot frees within `_INFLIGHT_WAIT_S` (2 s) it raises `BridgeError("RATE_LIMITED", "bridge busy, retry shortly")` before anything is written to the bridge (maps to `UPSTREAM_RATE_LIMIT`, retryable); this rejection does not count as a bridge failure or touch the cool-down. The slot is released in `finally` on success, bridge error, TIMEOUT and start failure.
2. **Futures annualization bucket** - `tv_data_service.tv_periods_per_year`: prefixes `cme, cme_mini, cbot, cbot_mini, nymex, comex, iceeur, iceus, icesg, eurex` (superset of `futures_service.ALL_FUTURES_EXCHANGES`) use `{"15m": 23184, "1h": 5796, "4h": 1512, "1d": 252}` (~23 h x 252 days). Other buckets unchanged. This resolves the earlier follow-up "futures fall in the stock bucket".
3. **"1m" ambiguity** - `get_candles` and `get_indicator` reject a timeframe that is exactly lowercase `"1m"` with `INVALID_PARAMETER` "1-minute bars are not supported; use 1M for monthly", before `validate_timeframe` and before any bridge call. `1M` still works as monthly. The shared `validate_timeframe` alias is untouched (other tools keep their behaviour). `server.py` docstrings of `tv_candles` / `tv_indicator` now read "5m, 15m, 1h, 4h, 1D, 1W, 1M (1M is monthly; 1-minute bars are not supported)".

### Tests added
- `test_tv_bridge_client.py` (+15, 134 total): max-inflight parsing rule; default cap = max_inflight + 2; with `max_inflight=1` and three slow calls running, the 4th concurrent call fails fast (<1.5 s) with `RATE_LIMITED` / `UPSTREAM_RATE_LIMIT` retryable, and a request-logging fake bridge confirms it never received it (and `_fail_count` stays 0); slots are released after TIMEOUTs, bridge error replies and a failed bridge start; `health` still works while saturated and takes no slot.
- `test_tv_data_service.py` (+~20, 123 total): every futures prefix (any case) and every `ALL_FUTURES_EXCHANGES` entry -> futures factors, other markets unchanged; lowercase `1m` rejected for candles and indicator with the exact message and zero bridge calls; `1M` still monthly; `tv_candles`/`tv_indicator` docstrings list the timeframes.

### Verification (real output)
- `uv run --frozen pytest tests/unit/services/test_tv_bridge_client.py tests/unit/services/test_tv_data_service.py -q`: `257 passed in 7.62s`
- `uv run --frozen pytest tests/unit -q`: `810 passed in 14.14s` (no failures, including the other agent's in-progress files at the time of the run)

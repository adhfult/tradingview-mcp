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

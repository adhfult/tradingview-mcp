# Phase 0: data freshness

## Brief (Opus)

**Goal:** every MCP tool result that used TradingView scanner/TA data or Yahoo data says where the data came from, when it was fetched, and whether it is a stale fallback. Today, `screener_provider.py` can return cached data up to 6 hours old with no marker.

**Master plan:** §6 of `docs/plans/tradingview-api-integration.md`.

### Rules (read before starting)
- Read each file fully before editing it. Re-use existing code. Don't rename or remove existing functions.
- **Don't change any existing function's signature or return value.** This phase only *records* metadata on the side and *adds* a `data_freshness` key at the tool boundary.
- Tests must be hermetic (no network). Mock upstream calls the way `tests/unit/services/test_screener_provider_resilience.py` does.
- Run `uv run pytest tests/unit -q` from the repo root. All 382 existing tests must still pass. Paste the real last lines of output into your report.
- If anything here doesn't match the code, **stop and report it** in your report. Don't invent a workaround.

### Files
- **New:** `src/tradingview_mcp/core/services/freshness.py`
- **Edit:** `src/tradingview_mcp/core/services/screener_provider.py`
- **Edit:** `src/tradingview_mcp/core/services/yahoo_finance_service.py`
- **Edit:** `src/tradingview_mcp/core/services/backtest_service.py` (only `_fetch_ohlcv`)
- **Edit:** `src/tradingview_mcp/server.py` (one new import-time wrapper)
- **New:** `tests/unit/services/test_freshness.py`

### Step 1: `freshness.py` (stdlib only)
- `_COLLECTOR: contextvars.ContextVar[Optional[list]] = ContextVar("tvmcp_freshness", default=None)`, plus a module `threading.Lock` for appends.
- `record(source: str, fetched_at: float, *, cache_hit: bool = False, stale: bool = False, auth: str = "anonymous") -> None`
  - If a collector list is active, append a dict with those fields. Otherwise do nothing.
  - Never raise: wrap the body in try/except.
- `start_collection() -> tuple[list, contextvars.Token]` and `stop_collection(token) -> None`.
  - **The list object is shared by reference.** `asyncio.to_thread` and `asyncio.gather` copy the context, so records made in worker threads land in the same list.
- `summarize(records: list[dict], now: Optional[float] = None) -> Optional[dict]`. Returns `None` for an empty list; otherwise:
  ```python
  {
    "sources": sorted(set(r["source"] for r in records)),
    "as_of_utc": <ISO-8601 UTC string of the OLDEST fetched_at, seconds precision, ending in "Z">,
    "age_seconds": <int, max(now - fetched_at), min 0>,
    "stale": any(r["stale"]),
    "cache_hit": any(r["cache_hit"]),
    "auth": "session" if all auth=="session" else ("anonymous" if all auth=="anonymous" else "mixed"),
    # only when stale:
    "note": "Upstream failed; serving cached data up to <age_seconds>s old."
  }
  ```
  Here `as_of_utc` / `age_seconds` mean **when the data was fetched from upstream**, not market time.

### Step 2: `screener_provider.py`
Record at every **successful** return path. Leave all other behaviour unchanged.

- **`resilient_get_multiple_analysis(...)`:**
  - fresh-cache hit (`cached = _cache_get(cache_key)` returns non-None): record with `fetched_at` = the cache entry's timestamp and `cache_hit=True`. Add a small private helper `_cache_entry_ts(key) -> Optional[float]` that reads `_SCREENER_CACHE` under `_SCREENER_CACHE_LOCK`.
  - successful upstream fetch: `fetched_at=time.time()`
  - stale fallback (`_cache_get_stale` returns `(age, payload)`): `fetched_at=time.time() - age`, `cache_hit=True`, `stale=True`
- **`_scan_with_retry(...)`:**
  - successful fetch: `fetched_at=now`
  - stale fallback: as above
- `source="tradingview_scanner"` and `auth="anonymous"` for all records (cookies aren't used yet; Phase 3 adds `auth="session"`). In `_scan_with_retry`, pass `auth="session" if cookies else "anonymous"` so Phase 3 needs no change there.

### Step 3: Yahoo
- `yahoo_finance_service._fetch_quote` and `_afetch_quote`: after a successful parse, `record("yahoo", time.time())`.
- `backtest_service._fetch_ohlcv`: after a successful parse, `record("yahoo", time.time())`.

Import with `from tradingview_mcp.core.services import freshness` (or the function), matching each module's existing import style.

### Step 4: `server.py` wrapper
After `_OFFLOAD... = _offload_sync_tools()` near the end of `server.py`, add `_attach_freshness_to_tools()`, in the same style as `_offload_sync_tools` (iterate `mcp._tool_manager.list_tools()`; by then every tool is async):
```python
@functools.wraps(_fn)
async def _with_freshness(*args, __fn=_fn, **kwargs):
    records, token = freshness.start_collection()
    try:
        result = await __fn(*args, **kwargs)
    finally:
        freshness.stop_collection(token)
    summary = freshness.summarize(records)
    if summary is None:
        return result
    if isinstance(result, dict):
        result.setdefault("data_freshness", summary)
    elif isinstance(result, list) and summary["stale"]:
        for row in result:
            if isinstance(row, dict):
                row.setdefault("data_freshness", summary)
    return result
```
- Keep `_tool.is_async = True`.
- Store the count in a module variable such as `_FRESHNESS_TOOL_COUNT`.
- Add a short comment block explaining why, like the one above `_offload_sync_tools`.
- **When fresh, list results stay exactly as they are today.**

### Step 5: tests (`tests/unit/services/test_freshness.py`)
1. `summarize`:
   - empty → None
   - one fresh record
   - mixed auth → `"mixed"`
   - stale → `note` present, `age_seconds` correct (pass `now=`)
2. Collector works across `asyncio.to_thread`: start a collection, `await asyncio.to_thread(freshness.record, "x", t)`, and assert the record is in the list.
3. `record()` with no active collector does nothing and doesn't raise.
4. `resilient_get_multiple_analysis`, mocking `tradingview_ta.get_multiple_analysis` as the existing resilience tests do:
   - fresh fetch → one record, not stale
   - second call → `cache_hit=True`
   - forced stale fallback (fresh TTL 0, upstream raising a transient error, stale entry present) → `stale=True`
5. The `server.py` wrapper:
   - pick a tool function from `mcp._tool_manager`, or build a tiny fake async fn and apply the same wrapping logic through a helper
   - dict result gains `data_freshness`
   - fresh list result is unchanged
   - stale list result gains it per row

   Prefer to factor the wrapping logic into `freshness.attach(result, records)` so it can be unit-tested without FastMCP.
6. Run the whole suite. The existing `test_tool_offload.py` and `test_tool_annotations.py` must still pass.

### Acceptance
- All existing tests pass, plus the new tests.
- No new dependencies.
- `git diff --stat` touches only the files listed above.

### Report format (append below under "## Implementation report (Haiku)")
- files changed, with one line each on what changed
- any mismatch between this brief and the code
- the last 3 lines of `uv run pytest tests/unit -q`

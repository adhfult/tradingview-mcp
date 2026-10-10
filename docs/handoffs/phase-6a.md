# Phase 6a: strategy testing gauntlet (backtest upgrades, gauntlet tool, prompts, stats)

## Brief (Opus)

**Goal:** turn good strategy-testing practice into code. A strategy idea must survive six checks before it's trusted. **Nothing here trades.** The paper trader is Phase 6b.

**Master plan:** §12 (6.1–6.5, 6.7, 6.8, 6.9). Read `docs/handoffs/STATUS.md` → Decisions first. Phase 3 added `data_source` / `tv_symbol` to the backtest functions; read the current code, not the plan.

### Read first
- **All of** `src/tradingview_mcp/core/services/backtest_service.py`:
  - the 9 runners `_run_*` and `_STRATEGY_MAP`
  - `_STRATEGY_WARMUP_BARS`, `_finalize_trades`, `_apply_costs`, `_calc_metrics` (its return keys), `_buy_and_hold_return`
  - `run_backtest`, `compare_strategies`, `walk_forward_backtest` (verdict thresholds 0.8 / 0.5 / 0.2), `_fetch_ohlcv`, and the TradingView fetch from Phase 3
- `server.py`: the tool pattern, and how backtest tools route.
- `freshness.py`: `record`.
- Tests under `tests/unit/services/test_backtest_*` and `test_walk_forward_robustness.py`.

### Hard rule: no change to existing numbers
Before changing anything, write a **snapshot test**, `tests/unit/services/test_backtest_snapshot.py`:
- deterministic synthetic candles (seeded LCG, 600 daily bars, mixed trend and chop) with `_fetch_ohlcv` monkeypatched
- `run_backtest` for **all 9 strategies** with default args
- `compare_strategies` and `walk_forward_backtest` (`rsi`) with defaults
- store the full result dicts, minus volatile keys like `timestamp`, in `tests/unit/fixtures/backtest_snapshot.json`
- the test asserts equality

**Commit that snapshot file before any other edit.** Every later step must keep it passing. If a change intentionally alters defaults, that's a bug: stop and report.

### 1. Runners: record bar indexes (mechanical)
- In each of the 9 `_run_*`, add `"entry_idx": i` when a position opens and `"exit_idx": i` when it closes.
- In `_finalize_trades`, add `"exit_idx": len(candles) - 1`.
- These are extra keys only. Check whether `recent_trades` or the trade log would now show them. If they appear in tool output, strip `entry_idx` / `exit_idx` in the result builders so outputs stay identical and the snapshot keeps passing.

### 2. `_simulate()`: one internal engine
`_simulate(candles, strategy, *, params=None, commission_pct, slippage_pct, fill="signal_close", interval="1d", periods_per_year=None, risk_free_rate=None) -> dict` returning `{trades, metrics, bnh}`.
- `params`: validated against `inspect.signature(_STRATEGY_MAP[strategy])`, which allows only named keyword parameters (not `candles`, not `**_`). Unknown names or non-numeric values give a `ValueError` with the allowed names. Also check:
  - every length/period ≥ 2
  - fast < slow where both exist (`fast_period` / `slow_period`, `fast` / `slow`, `fast_ma` / `slow_ma`)
  - `oversold` < `overbought`
- `fill="next_open"`: for each trade, the entry moves to `candles[entry_idx+1].open` and date; the exit likewise to `candles[exit_idx+1]`.
  - If `entry_idx+1` doesn't exist, drop the trade.
  - If `exit_idx+1` doesn't exist, keep the exit at the last bar's close, flagged `forced_exit`.
- Then `_apply_costs` and `_calc_metrics` exactly as `run_backtest` does now.
- **Refactor `run_backtest` to call `_simulate`** with defaults. The snapshot must stay identical.
- Add optional `params=None` and `fill="signal_close"` arguments to `run_backtest` and `walk_forward_backtest`, after the existing ones.
- Refactor `walk_forward_backtest`'s per-fold logic into `_walk_forward_on_candles(candles, strategy, ..., params, fill)` so the gauntlet can reuse it without fetching again. The snapshot must stay identical.

### 3. Cost profiles (6.3)
```python
COST_PROFILES = {  # ASSUMPTIONS: check against your real fees before trusting results
    "default":           {"commission_pct": 0.10, "slippage_pct": 0.05},
    "binance_spot":      {"commission_pct": 0.10, "slippage_pct": 0.05},
    "coinbase_advanced": {"commission_pct": 0.60, "slippage_pct": 0.10},
    "us_stock_broker":   {"commission_pct": 0.00, "slippage_pct": 0.05},
}
```
- Add `cost_profile: Optional[str] = None` to `run_backtest` and its tool. When given, it sets commission/slippage **unless** the caller explicitly passed non-default values.
  - Simplest rule: if `cost_profile` is set, it wins, and the result reports `cost_profile` and the values used.
  - An unknown name gives an error listing the names.
- **New metrics, only in new keys**, added to `run_backtest` results:
  - `trades_per_year`: trades ÷ (bars ÷ periods_per_year)
  - `gross_return_pct`: compounded from per-trade `gross_return_pct`; read `_calc_metrics` and compound the same way `total_return_pct` is computed
  - `net_return_pct`: same as `total_return_pct`
  - `cost_drag_pct`: gross − net
  - `cost_warnings`: a list, with `"High turnover (>200 trades/yr): costs dominate"` and/or `"Costs consume more than half of gross return"`

  Update the snapshot fixture for **only** these added keys. Explain that in your report, and keep the existing keys byte-identical.

### 4. Tradability (6.1)
- `_tradability(candles)` returns `{avg_daily_value, zero_volume_bar_pct, bars, thin_market}`.
  - `avg_daily_value` = mean(close × volume) over bars. For intraday intervals, sum per calendar day, then average.
  - `thin_market` = `avg_daily_value < float(os.environ.get("TRADINGVIEW_MCP_MIN_DAILY_VALUE", "1000000"))` **or** `zero_volume_bar_pct > 5`.
- Add `tradability` to `run_backtest` results as a new key (same snapshot rule as above).

### 5. `core/services/gauntlet_service.py` (new)
**`run_gauntlet(symbol, strategy, hypothesis, counterparty, cost_profile="default", interval="1d", period="2y", params=None, data_source="yahoo", tv_symbol=None) -> dict`**

**Edge check:**
- `hypothesis` and `counterparty` must each be ≥ 20 characters after stripping.
- They must not be in `GENERIC_PHRASES`, compared lower-cased and stripped of punctuation: {"momentum", "trend", "trend following", "it goes up", "it works", "buy low sell high", "the market", "other traders", "retail", "everyone", "nobody", "smart money"}.
- They must not be identical to each other.
- Otherwise return `{"verdict": "FAIL: no stated edge", "reason": ..., "gates": []}` without fetching anything.

**Data:** fetch candles once through the existing fetch path for `data_source` (Yahoo or TradingView). Use the longest allowed period: the `period` argument, but upgrade to `2y` for Yahoo or `5y` for TradingView if the caller left the default.

**`GAUNTLET_THRESHOLDS`** (one dict at the top, documented): `min_trades=30`, `min_profit_factor=1.1`, `max_drawdown_pct=35`, `sensitivity_min_share=0.7`, `sensitivity_min_median_ratio=0.5`, `recent_sharpe_ratio=0.5`, `recent_bars_min=200`.

**Gates.** All use `fill="next_open"` and the cost profile:

| # | Gate | Check | PASS when |
|---|---|---|---|
| 1 | honest_settings | the run is set up (warm-up satisfied, enough bars) | setup is valid; else FAIL with the reason |
| 2 | enough_evidence | base run | trades ≥ 30 **and** profit_factor > 1.1 **and** abs(max_drawdown_pct) ≤ 35 |
| 3 | parameter_sensitivity | each numeric param × {0.8, 0.9, 1.1, 1.2}, one at a time (ints rounded, deduped, constraints kept, base excluded) | share of neighbours with net return > 0 ≥ 0.7 **and** median neighbour return ≥ 0.5 × base return (when base ≤ 0, this gate FAILs) |
| 4 | double_costs | 2× commission and slippage | net return > 0 |
| 5 | recent_year | last 365 days of bars (by date), warm-up taken from the bars just before that window | recent return > 0 **and** recent Sharpe ≥ 0.5 × full Sharpe (if full Sharpe ≤ 0, FAIL); not enough bars (< `recent_bars_min` total) → SKIPPED |
| 6 | walk_forward | `_walk_forward_on_candles` | verdict starts with ROBUST or MODERATE; strategies the walk-forward excludes (`rsi_pullback`, `triple_ema`) → SKIPPED |

- **Gate output:** `{"gate": name, "status": "PASS"|"FAIL"|"SKIPPED", "reason": str, "numbers": {...}}`.
- **Verdict:**
  - all non-skipped PASS and none skipped: `"PASS"`
  - all non-skipped PASS with some skipped: `"PASS (n/6, k skipped)"`
  - otherwise: `"FAIL: " + ", ".join(failed gate names)`
- **Never use the word "profitable" in verdicts or reasons.**

**Fingerprint (6.7):** `sha256` of canonical JSON (`sort_keys=True`, `separators=(",", ":")`) containing:
- strategy and resolved params (defaults filled in from the signature)
- cost profile name and values
- fill
- interval, period, data_source, symbol, tv_symbol
- `package_version` (from `importlib.metadata.version("tradingview-mcp-server")`, falling back to `"dev"`)
- `code_hash`: `sha256` of `backtest_service.py` file bytes plus `gauntlet_service.py` file bytes

**Report storage:**
- write `{fingerprint, created_utc, inputs, gates, verdict, hypothesis, counterparty, disclaimer}` to `$TRADINGVIEW_MCP_HOME/gauntlet/<fingerprint>.json` (default home `~/.tradingview-mcp`; create dirs with mode 0o700)
- append a one-line summary to `gauntlet/log.jsonl`

**Result:** the report plus `report_path` and `disclaimer`: "Survived these tests on past data. This is not a prediction or advice. Paper trade before risking money."

**`gauntlet_stats() -> dict`:** reads `log.jsonl` and returns:
- `total`, `passed`, `failed`
- `kill_rate_pct`
- `by_failing_gate: {gate: count}`
- `last_10` (summaries)
- a note: "Most ideas should fail; around 6 in 7 failing is normal."

**`verify_report(fingerprint) -> dict`:** loads the report, recomputes the fingerprint from its inputs with the current code, and returns `{exists, verdict, matches_current_code: bool}`. Used by Phase 6b.

### 6. `compare_strategies` warning
Add the key `"multiple_testing_warning": "Picking the best of 9 strategies on one symbol overstates how good it is. Run the winner through strategy_gauntlet."` (a new key; update the snapshot only for it).

### 7. MCP surface (`server.py`, routing only)
- **Tool `strategy_gauntlet(...)`:** same args as `run_gauntlet`; `params` is an optional dict.
- **Tool `gauntlet_stats()`.**
- `backtest_strategy` gains `params`, `fill` and `cost_profile`; `walk_forward_backtest_strategy` gains `params` and `fill`. Docstrings get one line each.
- **Prompts** via `@mcp.prompt()` (check FastMCP 1.x's `prompt` decorator in `.venv/.../mcp/server/fastmcp/server.py` before using it):
  - **`strategy_builder(market: str = "crypto", timeframe: str = "1d")`:** text that tells the assistant to:
    1. scan the market first (`tv_hotlist` / screeners)
    2. check tradability
    3. propose five hypotheses, each naming who loses the trade
    4. run only the strongest through `strategy_gauntlet`
    5. report honestly
  - **`strategy_reviewer(fingerprint: str)`:** text that tells the assistant to load the report (via the `report_path`) and try to kill it, covering counterparty plausibility, cost drag, recent-year weakness, sensitivity spread, trade count and survivorship. Default: recommend rejection unless every gate passed clearly.
- Tools `readOnlyHint=True`. The gauntlet writes local report files; note that in the docstring.

### 8. Tests (hermetic; monkeypatch fetches)
- the snapshot test (above)
- params validation: unknown names, constraints
- `next_open` maths on a hand-made 10-bar series; drop or force-exit edge cases
- **no-lookahead** (`test_no_lookahead.py`): for each of the 9 strategies, on 400 synthetic bars, for k in range(warmup + 20, 400, 10), every trade whose `exit_idx ≤ k` when run on the full series appears identically when run on `candles[:k+1]`. Handle forced exits at the truncation point by comparing only trades closed strictly before k.
- cost profiles and warnings; tradability (thin and liquid)
- gauntlet:
  - no stated edge (short, generic or identical text)
  - each gate's PASS / FAIL / SKIPPED, using synthetic series built to trend, mean-revert or be noise; monkeypatch thresholds where needed to force outcomes deterministically
  - verdict strings, with no "profitable" anywhere (assert on `json.dumps(result).lower()`)
- fingerprint: stable for the same inputs; changes when params, cost or code_hash change (monkeypatch the hash function)
- reports and log written under `tmp_path` (`TRADINGVIEW_MCP_HOME`); `gauntlet_stats` counts; `verify_report` matches and mismatches
- existing tool annotation and offload tests cover the new tools; prompts are registered (list them via FastMCP's prompt manager)

### Acceptance
- `uv run pytest tests/unit -q` is green, and also with Node hidden.
- The snapshot is unchanged except the documented new keys.
- `cd bridge && npm test` is untouched and green.

### Report (append under "## Implementation report (Haiku)")
- files
- which snapshot keys were added
- any mismatches
- the real last lines of both pytest runs

### Carried in from the Phase 3 advisor (Fable), to be done in the 6a review pass (Sonnet)
These touch `backtest_service.py`, which 6a is editing, so they wait for the 6a review:
1. **Truncation flag:** `truncated = len(bars) >= 20000 or (first_ts - from_ts) > max(0.10*span, 5*86400)`. This avoids a long-weekend false positive on 1mo stock requests.
2. **TradingView-path labels:** the fetch-error text and `result["symbol"]` must use `tv_symbol` (not the Yahoo `symbol`) when `data_source="tradingview"`.
3. **Split the conversion** out of `_fetch_tv_candles` into a pure `tv_bars_to_candles(bars, interval)`, and add a `time` (unix seconds) key to TradingView candle dicts. 6a's sensitivity runs and 6b's forming-bar drop need the pure converter.
4. **Gauntlet scores closed bars only:** drop a still-forming last TradingView bar before scoring.

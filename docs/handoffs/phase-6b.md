# Phase 6b: paper trader (hypothetical trades only; never places orders)

## Brief (Opus)

**Goal:** a Python process, `tradingview-mcp-paper`, that runs one strategy that **passed the gauntlet** on live candles from the bridge, and records *hypothetical* trades. Each paper trade sends a notification through the watcher's local `/notify` endpoint, plus a weekly summary comparing paper results with the backtest.

**Master plan:** §12 → 6.6.

### Read first (use the real code, not this text)
- `core/services/gauntlet_service.py` (Phase 6a): `verify_report`, the report JSON shape, the fingerprint, and the `TRADINGVIEW_MCP_HOME` handling.
- `core/services/backtest_service.py`: `_simulate`, `_STRATEGY_MAP`, `fill="next_open"`, `_apply_costs`, the TradingView fetch helper from Phase 3.
- `core/services/tv_bridge_client.py`: `get_client().call("candles", ...)`, timeouts (send `timeoutMs`), `BridgeError`.
- `bridge/lib/localapi.mjs` (Phase 5): the exact `/notify` request shape, the auth header, and the response codes.
- `pyproject.toml`: `[project.scripts]`.

### Rules
- **No order placement and no broker or exchange connections, ever.** The word "paper" appears in every notification and log line.
- Stdlib plus existing dependencies only. `httpx` is already a dependency and fine for the `/notify` POST, or use `urllib`.
- Hermetic tests: fake bridge client, fake clock, fake HTTP for `/notify`. Never real network.
- **No secrets.** `WATCHER_LOCAL_TOKEN` comes from env. Never log it.
- Don't commit, push, or run git stash/checkout/reset.

### Files
- **New:** `src/tradingview_mcp/core/services/paper_service.py` (logic)
- **New:** `src/tradingview_mcp/paper.py` (CLI)
- **Edit:** `pyproject.toml` → `[project.scripts] tradingview-mcp-paper = "tradingview_mcp.paper:main"`
- **New:** `bridge/paper.service.example` (systemd, same hardening as `watcher.service.example`)
- **New:** `tests/unit/services/test_paper_service.py`
- **Docs:** a "Paper trading" section in `README.md`

### CLI
`tradingview-mcp-paper (--report <fingerprint> | --latest-pass <strategy> <tv_symbol>) [--once] [--dry-run]`
- **Before starting:** call `verify_report(fingerprint)`. Refuse with exit code 2 and a clear message unless `verdict` starts with `PASS` **and** `matches_current_code` is true. If the code, params or cost profile changed, the strategy must pass the gauntlet again.
- **Data source:** TradingView, through the bridge. The report's inputs must have `data_source="tradingview"` and a `tv_symbol`; otherwise refuse ("paper trading needs a TradingView-sourced gauntlet run").
- `--once`: process the latest closed bar once, then exit (used by tests and for manual checks).
- `--dry-run`: print notifications instead of POSTing them.

### Loop (`paper_service.py`)
1. **Timing:** work out the bar length from the report's `interval` (15m, 1h, 4h, 1d). Sleep until the next bar boundary (UTC) plus 15 seconds. Use the injectable clock and sleep.
2. **Fetch:** `call("candles", {"symbol": tv_symbol, "timeframe": <code>, "count": 500, "timeoutMs": 30000})`, then convert to the backtest candle dicts using the Phase 3 helper. **Drop the last candle if its open time is the current, still-forming bar.**
3. **Simulate:** run `_simulate(candles, strategy, params=<report params>, fill="next_open", commission/slippage from the report's cost profile)`.
4. **Compare** with the journal: entries or exits **newly** present for the most recent closed bars, which weren't recorded before, become paper events.
   - `entry`: `{ts, type: "entry", price, bar_time}`
   - `exit`: `{ts, type: "exit", price, bar_time, return_pct (net of costs)}`
   - Never re-emit events already in the journal. **Key by `(type, bar_time)`.**
5. **Journal:** append each event as JSON to `$TRADINGVIEW_MCP_HOME/paper/<fingerprint>.jsonl` (directories `0o700`).
6. **Notify:** POST `http://127.0.0.1:<port>/notify` with `Authorization: Bearer $WATCHER_LOCAL_TOKEN` and body `{title: "PAPER <strategy> <tv_symbol> <entry|exit>", body: <prices, return, the words "hypothetical — no order placed">, key: "<fingerprint>|<type>|<bar_time>", level: "up"/"down"/"info"}`.
   - Port comes from `WATCHER_LOCAL_PORT` (default 8787).
   - If the token is missing or the watcher is unreachable, log a warning and continue. Never crash the loop over a notification.
7. **Weekly summary** (Monday 08:00 in `PAPER_TIMEZONE`, default `America/New_York`):
   - paper trades this week, win rate, and average return
   - expected trades per week from the backtest: `trades_per_year / 52` from the report's numbers, if present, otherwise computed from the stored base run
   - flag when the paper drawdown exceeds 2× the backtest max drawdown, or when the trade count differs from expected by more than 3×: "Paper results diverge from the backtest; the backtest may have been overfitted."
8. **Errors:**
   - `BridgeError` → log, back off (60s → 120s → 300s, capped), keep running
   - `AUTH_FAILED` → log the restart-after-`.env` hint and back off 300s
   - the loop never exits on data errors
   - SIGTERM/SIGINT → finish the current step and exit 0

### Tests
- refuses: a missing report, a FAIL verdict, a code mismatch (monkeypatch `verify_report`), a Yahoo-sourced report
- bar-boundary timing for each interval (fake clock)
- the forming bar is dropped
- new-event detection: no duplicates across runs; restart reads the journal
- journal append format; directory permissions
- `/notify` request shape and header (fake HTTP); a missing token or unreachable watcher means a warning and no crash
- weekly summary maths and the divergence flag
- error backoff schedule; `AUTH_FAILED` message
- the CLI `--once --dry-run` path end-to-end with a stub client: no network, prints a notification

### Acceptance
- `uv run pytest tests/unit -q` is green, and also with Node hidden.
- `uv run tradingview-mcp-paper --help` works.
- No new dependencies.

### Report (append under "## Implementation report (Haiku)")
- files
- mismatches with the 6a or Phase 5 code
- the real pytest tails

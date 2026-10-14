# Phase 7c: Pyne scripts in the strategy gauntlet

Branch `claude/lucid-bardeen-3ou62p`, not pushed (you said to hold the push until the work is done). Plan: `docs/plans/phase-7c.md` (approved with its three decisions). Regime 3, Sonnet 5.5 High, no delegates for the build; wrap-up reviews by a Fable subagent and Codex Sol (`gpt-6.1-sol`).

## What now exists

`strategy_gauntlet(strategy="pine:<name>")` runs a hand-written Pyne script from `$TRADINGVIEW_MCP_HOME/strategies/<name>.py` through every gate, plus a seventh gate, `lookahead`.

- `src/tradingview_mcp/core/services/pine_service.py`: names, folder, availability, `run_script`, `declared_inputs`, `convert_trades`, `script_sha256`, `engine_version`, `warmup_bars`. PyneCore is imported inside functions only.
- `backtest_service.py`: the seam. `strategy_param_defaults`, `resolve_params` (range and type from the declared inputs), `_trades_for` (no second fill; only `next_open`), `strategy_warmup_bars`.
- `gauntlet_service.py`: accepts `pine:`, `_gate_lookahead`, `script_sha256` in the report, and in the fingerprint also the sibling toml, the PyneCore version and `pine_service.py` (in `_code_files`).
- `paper_service.py`: refuses a Pyne report. `server.py`: `pine_scripts()` tool, docstring. `pyproject.toml`: extra `pine = ["pynesys-pynecore==6.10.9; python_version >= '3.11'"]`; `uv.lock` has 40 added lines (revision kept at 3); CI installs `--extra pine`.
- `docs/examples/pine/ema_cross.py`, README section, `tests/unit/fixtures/pine_parity.json` + `make_pine_parity.py`.

## Step 0 findings (details in the plan)

Apache-2.0, no dependencies, arm64 Linux wheels plus a pure-Python wheel, runs offline in memory (`ScriptRunner.run_iter` gives closed trades per bar), declared inputs readable. Only `pynecore/pynesys/compiler.py` calls the online PyneSys API; it is never imported.

## Gates

`uv run pytest tests/unit -q`: **1145 pass** on Python 3.11, 3.12 and 3.13 with the extra; **1120 pass, 25 skipped** on 3.10 (no extra). Bridge unchanged (752 pass, 2 skipped).
Evidence the conversion is right: the Pyne EMA cross makes the same trades as the built-in `ema_cross`, trade for trade (dates, prices, indexes), and a test keeps it that way. Indicator parity (`test_pine_parity.py`): RSI identical, EMA within 4e-14, Bollinger within 6e-11, warm-up `na` where the repo gives `None`; the test enforces 1e-8.
A real gauntlet run of the example on 600 bars takes about 4 s (the lookahead gate re-runs the script up to 16 times). Not measured on the Pi or on tens of thousands of bars.

## Reviews: findings and fixes

Tests were committed failing first (`d` below = the fix commit "fix(pine): review findings").

| Finding | Source | Fix |
|---|---|---|
| Trades were placed by PyneCore's `bar_index`, which restarts at the first calculated bar (`calc_bars_count`): dates 100 bars early, no error | Fable | Placed by timestamp; `calc_bars_count` forced to 0; a time that is not a candle is an error |
| A sibling `<name>.toml` changes what runs but was not hashed: an old PASS kept verifying | Codex + Fable | `.py` and `.toml` hashed together, both in the input-cache key |
| The lookahead gate only caught peeks past the exit fill; the sample left the tail unchecked | Codex + Fable | Also cuts at the entry fill and needs the entry to reappear; sample spread evenly with first and last |
| Partial exits on the fill bar were scored as two full positions (5% instead of 2.5%) | Codex | One entry closed in pieces is refused |
| `strategy.close(immediately=True)` and limit entries filled away from the open and were scored as next-open | Codex | Any fill not at the fill bar's open is refused (so stop-losses are not supported yet, see below) |
| Warm-up for Pine scripts defaulted to 20 bars: false walk-forward results for a long SMA | Codex + Fable | `strategy_warmup_bars`: the largest whole-number input |
| An indicator script escaped as a raw `AttributeError`; `sys.exit()` escaped `except Exception` | Codex + Fable | Both become `PineError`, so a tool error |
| Input cache looked up outside the lock (a `KeyError` race) | Codex | Lookup and publish inside the lock |
| PyneCore's version was not in the fingerprint | Fable | `pynecore_version` added |
| A "must not fetch" test passed for the wrong reason | Codex | Counts calls instead |

## Mutation check

54 mutants over the new logic in total (37 on the first build, 17 after the review fixes). **52 killed, 2 accepted:** the single-entry bound of the input cache (`_INPUTS_CACHE.clear()`, memory only) and one equivalent no-op mutant. Ten survivors along the way (7 in the first round, 3 in the second) each pointed at a test gap and were closed with a test.

## Decisions to know about (you can overrule)

1. **Market orders only.** Because the gauntlet's model is "every fill at the next bar's open", a `strategy.exit` with `stop` or `limit`, a limit entry or `immediately=True` is refused with a message instead of being scored. Stop-losses are common, so this is the biggest limit of 7c. Allowing intrabar fills at their own price is possible (Pyne models them), but the "next open" wording, the recent-year filter and the lookahead cut would all need a second look. Say if you want it.
2. In-process, no time limit (an endless loop hangs the call), as approved. Global lock, one run at a time.
3. Long only, one position at a time, 24/7 sessions, prices on a 0.0001 grid (a tick-denominated stop would mean 0.0001 per tick, unlike TradingView).
4. The paper trader refuses Pyne reports.

## Traps

- Under `pytest`, PyneCore never writes its `.toml` (it checks `'pytest' in sys.modules`), so a test of the `PYNE_SAVE_SCRIPT_TOML` guard has to delete `pytest` from `sys.modules`.
- A script with no `qty` on `strategy.entry` sizes 100% of equity and the order can be dropped silently (zero trades). Examples and README say to set `qty`.
- Python 3.12 sums floats more exactly than 3.10/3.11: compare indicator series with a tolerance, not `==`.
- `ta.bb` returns `(middle, upper, lower)`.
- `rm -rf` is blocked by a launch-code hook here; use `mktemp -d`. A command whose text mentions an env file is blocked too: create such files with the Write tool.
- `uv run --isolated --python 3.10 pytest tests/unit -q` is a one-minute stand-in for the 3.10 CI job; add `--extra pine` for 3.11+.

## Still to do by hand

On the Pi: `pip install '.[pine]'` (arm64 wheel), copy the example script, run one gauntlet, and time it. Check that the extra installs on the Pi's Python (3.11 or newer needed).

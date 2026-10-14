# Phase 7c plan: Pyne scripts in the strategy gauntlet

Status: **waiting for approval**. Regime 3 (Sonnet 5.5 High, no delegates); wrap-up review by a Fable subagent on this file and the diff, plus one Codex Sol review (changes over 50 lines). Brief: `docs/handoffs/phase-7.md` section 7c.

## Step 0 findings (done, nothing in the repo changed yet)

Checked in a scratch venv outside the repo (`pynesys-pynecore==6.10.9`, Python 3.12).

- **Licence: Apache-2.0** (`METADATA` says so; the `LICENSE` file is the Apache text; a `NOTICE` file ships too). Permissive, so we go on. Keep the NOTICE with any redistribution.
- **No mandatory dependencies.** Extras `cli`, `all`, `providers`, `ccxt` pull typer, rich, ccxt and tzdata; we do not install any of them.
- **Wheels:** `cp311`-`cp314` for manylinux x86_64 **and aarch64** (so the Pi works), plus a pure-Python `py3-none-any` fallback. Needs Python >= 3.11. The compiled parts are `.so` speed-ups, not required.
- **Offline:** the runner never touches the network. Only `pynecore/pynesys/compiler.py` (class `PyneComp`, Pine -> Pyne through `api.pynesys.io`, needs an API key) does. We never import it. We support hand-written or pre-compiled Pyne `.py` files only.
- **Running a script on our own candles, in memory, no files:**
  ```python
  os.environ["PYNE_SAVE_SCRIPT_TOML"] = "0"      # else the decorator writes a .toml next to the script
  r = ScriptRunner(Path(script), ohlcv_list, syminfo, inputs={"fast": 5}, settings={...})
  for candle, plot, closed_trades in r.run_iter(): ...
  ```
  `OHLCV(timestamp_ms, open, high, low, close, volume)`; `SymInfo(...)` built by hand (crypto, 24/7 hours, `mintick`, `pricescale`, `pointvalue=1`, `mincontract`). Closed trades arrive per bar as `Trade` objects: `entry_bar_index`, `exit_bar_index`, `entry_time`/`exit_time` (ms), `entry_price`, `exit_price`, signed `size`, `profit`, `commission`.
- **Declared inputs are readable:** `r.script.inputs` maps name -> `InputData(input_type 'int'|'float'|..., defval, minval, maxval, step)`. Overrides go in `inputs=`; an unknown name raises `ValueError` listing the valid ones. So the parameter-sensitivity gate can work (not SKIPPED) for scripts with numeric inputs.
- **Speed:** 600 bars, EMA cross, 0.03 s. A gauntlet is about 20-30 runs, so this is cheap. Not measured on the Pi or on 40k bars.
- **Traps found:**
  1. A script that uses default sizing (`strategy.entry` with no `qty`, default 100% of equity) made **zero trades** in my run; with `default_qty_value=50` or an explicit `qty` it traded. The order is dropped silently. The example script and docs must set sizing explicitly.
  2. The script file is executed as Python. Only scripts the user put in the strategies folder run.
  3. Only *closed* trades are reported per bar; a position still open at the end is not in the list (our engines force an exit at the last close, so we must do the same).

## Design

**The seam.** Every simulation (gauntlet, walk-forward, paper trader) goes through `backtest_service._trades_for(candles, strategy, resolved, fill)`, `resolve_params`, `strategy_param_defaults` and `_STRATEGY_WARMUP_BARS`, all keyed by strategy name. One dispatch at those four points (`name.startswith("pine:")` -> `pine_service`) makes the whole gauntlet work for Pine, instead of a second code path in each gate. (Lazy-but-correct: the root cause of "only built-in names work" is that lookup, so it is fixed there.)

**Fills and costs.** Pyne fills at the next bar's open itself. So for `pine:` names `_trades_for` **skips `_apply_fill`**, and the script's own commission and slippage are forced to 0 through `settings=`, so `_apply_costs` charges the cost profile exactly once and the `double_costs` gate still means something.

**Trade dicts.** `{entry_idx, exit_idx, entry_date, exit_date, entry_price, exit_price}` (plus `forced_exit` for a position closed at the last bar), the same keys the built-in strategies produce, so `_apply_costs` and `_calc_metrics` need no change.

**Parameters.** `strategy_param_defaults("pine:x")` = the script's numeric (int/float, not bool) inputs with their defaults. `resolve_params` checks type and `minval`/`maxval` (a neighbour outside the range is a `ValueError`, which the sensitivity gate already treats as "not a valid neighbour"). No numeric inputs -> that gate is SKIPPED with the reason.

**Lookahead gate (new, Pine only, 7th gate).** Same idea as `_lookahead_violations` in `tests/unit/services/test_backtest_engine.py`: for sampled k, a trade closed before bar k in the full run must reappear when only bars 0..k exist. A miss is a FAIL: "script repaints or uses future data".

**Fingerprint.** The report fingerprint hashes the inputs; for Pine it must also hash the **script file's SHA-256**, or editing a script would leave an old PASS looking valid. Added to `inputs` as `script_sha256`.

**Missing extra or Python 3.10.** `pynecore` is imported lazily inside `pine_service` functions. `available()` returns `(False, reason)`; `strategy="pine:..."` returns `make_error(ErrorCode.DEPENDENCY_MISSING, "Pine support needs Python 3.11+ and: pip install 'tradingview-mcp-server[pine]'")`. Everything is skipped on the 3.10 CI job.

**Script safety.** Names match `^[a-z0-9_-]{1,64}$`, resolved to `<strategies dir>/<name>.py`, never a path; the resolved file must sit inside the folder (symlinks that leave it are refused). Docs say plainly that a Pyne script is Python and runs with the user's rights. We never download scripts.

## Decisions for you (my recommendation first)

1. **Run in-process, no timeout (recommended), or in a subprocess with a time limit?** A script with an infinite loop would hang the MCP server. In-process is the small version and the scripts are your own files; a subprocess adds about 0.3 s start-up per run and a lot of code. I would ship in-process, say so in the docs, and add the subprocess only if it bites. (`# ponytail:` comment in the code naming the ceiling.)
2. **Long-only in v1 (recommended).** `_apply_costs` computes a long return. A trade with negative size, or overlapping trades, makes the service return a clear error ("short trades are not supported yet") instead of a wrong number. Short support is a follow-up.
3. **Paper trader refuses `pine:` strategies (recommended).** `paper_service` calls `_simulate`, which would then run user Python inside the Pi daemon's watch loop. Out of scope for 7c; it returns an error naming this plan.

## Files

- New: `src/tradingview_mcp/core/services/pine_service.py` (`available`, `list_scripts`, `script_path`, `declared_inputs`, `run_script`); `tests/unit/services/test_pine_service.py`, `tests/unit/services/test_pine_gauntlet.py`; `tests/unit/fixtures/pine_parity.json` + a generator note; `docs/examples/pine/ema_cross.py`; `docs/handoffs/phase-7c.md`.
- Changed: `backtest_service.py` (the four dispatch points), `gauntlet_service.py` (accept `pine:`, lookahead gate, `script_sha256`), `paper_service.py` (refuse), `server.py` (docstring + `pine_scripts()` tool), `pyproject.toml` + `uv.lock` (optional extra `pine`), README section, `STATUS.md`.
- The base install's dependencies do not change.

## Steps (one commit each; test first, committed failing)

1. `pyproject.toml` extra + `uv sync --extra pine`; confirm base `uv sync --dev` is unchanged (diff of `uv.lock` for the base group).
2. `pine_service`: name validation, folder refusal, dependency-missing envelope, `list_scripts` (tests first; no pynecore needed).
3. `run_script` + trade conversion (fake runner result first, then the real package behind `importorskip`): forced exit for an open position, long-only/overlap errors.
4. Seam dispatch in `backtest_service` (params from declared inputs, no `_apply_fill`, zero script costs).
5. Gauntlet: `pine:` accepted, `script_sha256` in the fingerprint, lookahead gate with a deliberately leaky fake runner, paper trader refusal.
6. Parity fixture: fixed OHLCV from a deterministic generator, reference values from this repo's `indicators_calc` RSI(14), EMA(20), BB(20, 2); the test runs equivalent Pyne code and asserts agreement within a tolerance recorded in the fixture. If the repo's RSI seeds differently from Pyne's (Wilder), I report the gap rather than widening the tolerance to hide it.
7. MCP tool `pine_scripts()`, `strategy_gauntlet` docstring, example script, README, handoff, STATUS.
8. Mutation check on the new logic (name validation, conversion, fingerprint, lookahead), then the wrap-up reviews.

## Gates

`uv run pytest tests/unit -q` green with and without Node, on Python 3.12 with the extra and with the extra missing (simulate by hiding the module); the Python 3.10 CI job only skips. Base install dependencies unchanged. Bridge tests untouched (752 pass).

## Not covered

Pine -> Pyne compiling (needs the online service), shorts, pyramiding, session-aware scripts (we feed 24/7 hours), `request.security` data from other symbols, Pi speed and memory (unmeasured; check on the Pi), a script time limit (decision 1).

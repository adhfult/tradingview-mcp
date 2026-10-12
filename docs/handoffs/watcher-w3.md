# Watcher W3: AND/OR rules

Regime 3, main session, Sonnet 5.5 High, no delegates. Plan row: `docs/plans/panwatch-ideas-and-pi-footprint.md` (W3, line 27).
Design first, then the implementation report (below the design).

## Goal
One rule that fires when several existing rules agree on the same closed bar (`all_of`), or when any of them fires
(`any_of`), with one alert instead of several.

## Design

### Config shape
```json
{"id": "rsi-and-volume", "type": "all_of", "rules": ["rsi", "volspike"], "symbol": "BINANCE:BTCUSDT", "timeframes": ["60"]}
```
- `type`: `all_of` or `any_of`. `rules`: 2 to 10 ids of other rules in the same config, no repeats.
- A composite takes the generic keys every rule has: `symbol`, `timeframes`, `max_per_day`, `expires`, `calendar`. These apply
  to the **composite** and are checked by the watcher exactly as today (expiry and the session gate before evaluation, the
  daily cap at submit).

### One level only, which also rules out cycles
A member must be a plain rule (`pct_move`, `rsi_cross`, ...). A member that is itself `all_of` / `any_of` is a config error
("composites cannot contain composites"). That covers self-reference and cycles with no graph walk, and it is what the plan
asked for ("keep nesting to one level").

Members may be defined anywhere in the `rules` list, before or after the composite.

### Evaluation (`bridge/lib/rules.mjs`)
The config attaches the resolved member rules to the normalised composite as `members` (full objects, defaults applied), so
`evaluateRules` needs no lookup by id and the watcher passes the same list as today.

For a composite on a stream:
1. Run the members through the existing `evaluateRules` (reuse, no second evaluator path). A member that does not apply to
   the stream (its own `symbol` / `timeframes` filter) cannot hit.
2. Group the member hits by `direction`.
3. `any_of`: one composite hit per direction that has at least one member hit.
   `all_of`: one composite hit for a direction only if **every** member applies to this stream and hit in that direction. Two
   members that hit in opposite directions are a disagreement, so no hit.
4. The hit is the usual shape: `ruleId` is the composite's id, `type` is `all_of` / `any_of`, `direction`, `barTime` as today.
   `message` joins the members' messages: `rsi: RSI rose through 70 (now 71.2) | volspike: Volume 3.2x average`. `values`
   are the members' values keyed `memberId.key` (`rsi.rsi`, `volspike.multiple`), flat, so `valuesLine` needs no change.

Because the composite hit carries a direction, the existing cooldown key (rule, symbol, timeframe, direction) gives
"cooldown key includes direction" with no new code.

### Bars needed
Nothing extra. Every member is a plain rule that is validated on its own, including the "needs N closed bars" limit, so a
composite cannot need more than its members do. (A `barsNeeded` case for composites was written first and removed in
review: it was dead code.)

### Mixed timeframes and "can never fire" (config errors)
Members keep their own `symbol` and `timeframes` filters. The composite is checked per watched stream (symbol x timeframe):
- the composite itself must match at least one watched stream (the existing check),
- `all_of`: on at least one of those streams **every** member must apply, else the rule can never fire. Example: members
  limited to `["15"]` and `["60"]` give an error.
- `any_of`: on at least one of those streams at least one member must apply.

`calendar: "us_session"` follows the W2 intraday check on the composite's own matched timeframes (unchanged code).

### Unknown ids
`rules[N].rules[i]: "x" is not the id of a rule in this config`. If a member itself has a config error, the member's error is
the one reported (the composite does not add noise).

## Known limit (stated up front)
(Changed in review: a member's own `expires` and `calendar` now DO count inside a composite, see the report below. Its `max_per_day` does not.)
Members stay active as stand-alone rules. Define `rsi` and `volspike` and combine them, and a bar that trips both sends
the two single alerts and the combined one. Silencing a member would need a new field (`enabled: false`), which is skipped
until asked. Today's workaround: give members a high threshold or a different `symbol` / `timeframes`, or accept the
combined alert as the summary.

## Out of scope (skipped on purpose)
- Nesting (`all_of` of `any_of`), `not`, "N of M": add when asked.
- Different timeframes inside one composite (a 15m rule AND a 60m rule): needs multi-stream state, not a closed-bar join.
- A weighted or scored combination.

## Steps (each with the command that proves it, run from the repo root)
1. Tests first, committed failing. `rules.test.mjs`: both, either, one missing, opposite directions, members that do not apply,
   not enough bars, `barsNeeded`. `config.test.mjs`: unknown id, nested composite, self-reference, duplicates, size 1 and 11,
   disjoint member timeframes, bars limit, forward reference, generic keys allowed. `watcher.test.mjs`: one end-to-end alert,
   direction in the cooldown key, `max_per_day` on a composite. Proof: `timeout 100 npm test --prefix bridge` fails only on
   the new tests.
2. `bridge/lib/rules.mjs`: specs, `barsNeeded`, composite evaluation. Proof: the rules tests pass.
3. `bridge/lib/config.mjs`: validation and the resolved `members`. Proof: the config tests pass.
4. Watcher test, README, example config (one composite). Proof: full suite, and
   `node bridge/watcher.mjs --config bridge/watcher.config.example.json --check-config` prints `OK`.
5. Mutation check, then the regime-11 review (Fable subagent + Luna Max, read-only, this file and a saved diff), verify each
   finding before fixing, fill in the report, log with `regime_log.py`.

---

# Implementation report

Commits (after `f06e840`): `b472d54` tests + design, then rules evaluation, config validation, README and example, a cleanup
from the mutation check, and the review fixes (see `git log`).

## What was built
- `bridge/lib/rules.mjs`: rule types `all_of` / `any_of` (a `rules` list of 2 to 10 ids, validated by a new `idList` kind),
  `isComposite`, `evaluateComposite` (reuses `evaluateRules` on the members, groups hits by direction), `RULE_ID` now exported.
- `bridge/lib/config.mjs`: `rules` allowed as a key, `resolveComposites` (unknown ids, no composite inside a composite,
  attaches `members`, rejects combinations that could never fire).
- `bridge/watcher.mjs`: members are held to the same expiry and session gates as top-level rules; direction added to the
  dedupe key.
- `bridge/README.md`, `bridge/watcher.config.example.json` (one `all_of`, `rsi-volume`).
- Tests: bridge 404 to 429 (25 new; one dead test removed): `rules.test.mjs` 11, `config.test.mjs` 8, `watcher.test.mjs` 6.

## Delegation
None, as planned (regime 3).

## Decisions worth knowing
- One level only. A composite inside a composite is an error, which also rules out self-reference and cycles with no graph walk.
- `any_of` gives one hit per direction; `all_of` needs every member to hit in the same direction. Opposite directions are a
  disagreement, so `all_of` stays quiet.
- Members stay active as stand-alone rules (documented limit; `enabled: false` is skipped until asked).
- The config attaches resolved `members` to the normalised composite, so `evaluateRules` needs no id lookup.

## Mutation checks (committed tree, one at a time)
17 on the first build, 5 on the review fixes. Two survived on the first build and were **redundant code, not missing tests**:
the `all_of` "every member applies" pre-check (the group-size check already implies it, since a member that does not apply
cannot hit) and an `errors.length > before` guard in `resolveComposites`. Both were deleted. All others caught.

## Review (regime 11): Fable (read-only subagent) and Luna Max (`inv.sh codex gpt-6-luna max`, read-only)
| Finding | Who | Verdict |
|---|---|---|
| `any_of` with hits in both directions on one bar sent one alert: the dedupe key was `symbol|timeframe|ruleId|barTime`, safe only while a rule gave one hit per bar. My direction test used different bars, so it could not see it. | both | **real, fixed**: direction added to the dedupe key, test failed first |
| A member's `expires` and `calendar` were bypassed inside a composite, so `--check-config` said "expired, will never fire" while the composite still used it | Fable | **real, fixed**: the watcher applies the same gates to members; a dead member blocks `all_of` and is absent from `any_of`; 3 tests failed first |
| The composite `barsNeeded` case was dead code (it ran before members were attached, and every member is validated alone) | Fable | **real, fixed by deleting** the case and its test |
| The global key allowlist accepts `rules` on a plain rule (silently ignored) | Luna | real but **pre-existing**: every rule type accepts every other type's keys (a `threshold_pct` on `rsi_cross` is also ignored). Not changed here |
| Luna's sandbox is read-only (`EROFS` on `/tmp`), so the watcher tests could not run there | Luna | not a defect |

Fable also confirmed: no dedupe or cooldown key collisions between composites and members (ids are unique and cannot contain
`|` or `.`), `__proto__` is rejected as an id, long bodies are truncated at the notifier.

## Known limits
- Members stay active as stand-alone rules, so one bar can send the member alerts and the combined one.
- Stray keys on a rule (for example `rules` on a `pct_move`) are ignored, not rejected: pre-existing for all rule types.
- Persisted dedupe records from before this change have no direction in the key. After an upgrade, a restart inside the
  catch-up window could resend one alert for the latest bar, once. The watcher is not deployed yet, so nothing to migrate.
- A member's `max_per_day` does not apply to the composite (the composite has its own cap).

## Final gates
`timeout 100 npm test --prefix bridge` = 429 pass, 0 fail. `node bridge/watcher.mjs --config bridge/watcher.config.example.json --check-config` prints `OK`.

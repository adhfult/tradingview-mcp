# Watcher W1: per-rule daily cap + expiry

Branch `claude/watcher-w1` (worktree `~/code/tvmcp-w1`), base `a3a5274`. Regime 4, lead Sonnet 5.5 High. Not pushed.
Spec: section B of `docs/handoffs/NEXT-6b-and-W1.md`.

## What was built

Two optional fields on a watcher rule:

- `max_per_day` (integer 1 to 1000): at most this many alerts per rule id per local calendar day (config `timezone`), counted across the rule's symbols and timeframes.
- `expires` (`YYYY-MM-DD`, a real calendar date): the rule's last day, in the config timezone. After it the rule is skipped before evaluation.

| File | Change |
|---|---|
| `bridge/lib/config.mjs` | Allows and validates both keys (errors join the usual list). `parseConfig` takes an optional `now` and warns about an already-expired rule. |
| `bridge/lib/rules.mjs` | `ruleExpired(rule, nowMs, timezone)`: string compare of `localDate(now)` against `expires`. |
| `bridge/lib/state.mjs` | `state.dailyCounts: {ruleId: {date, count}}`, loaded defensively (bad entries dropped). `STATE_VERSION` stays 1; an old file loads with `{}`. |
| `bridge/lib/alerts.mjs` | The cap check sits right after the cooldown check in `submit` and returns `'capped'`. `tick()` prunes counts from earlier days. |
| `bridge/watcher.mjs` | Filters expired rules before `evaluateRules`; passes `ruleId` and `maxPerDay` in the `submit` item. |
| `bridge/README.md`, `bridge/watcher.config.example.json` | A note, and `max_per_day: 10` on the `move` rule. |

## Decisions (worth knowing)

- **What counts toward the cap:** every alert that survives dedupe, cooldown and the cap, i.e. `sent`, `held` (quiet hours) and `digested` (hourly cap). The spec said "delivered or queued"; held and digested alerts are queued. Duplicates, cooldown drops and capped alerts do not count.
- **A capped alert writes nothing**: no `seen`, no `cooldowns`. Otherwise it would block the same alert after midnight.
- **Day = `localDate(now, timezone)`**, not a rolling 24 hours or a UTC offset. A New York day is 25 hours long on 2026-11-01 and 23 on 2026-03-08; four tests pin the resets.
- **Clock stepped back:** a counter counts only when its saved date equals today. A saved date in the future (clock went back across midnight) counts as zero, so a rule is never locked out. A step back inside the same day keeps the count.
- **Critical (health) alerts** skip the cap and are never counted, even if an item carries `ruleId` and `maxPerDay`.
- **`expires` is stricter than the existing `ISO_DATE`** (used for holiday lists), which accepts `2026-02-30`. A rule expiring on an impossible date is a config mistake, so it is an error here.
- **The example config gets only `max_per_day`**, not `expires`: a date in the shipped example would start warning once it passed.
- **Pruning is in `alerts.tick()`**, not `state.prune()`, because "older than today" needs the timezone and `prune` has none.
- **Delegation:** none. The only separable file (`config.mjs`, about 25 lines, tied to `ruleExpired`) was smaller than the brief and the review it would have needed.

## Tests (31 new, bridge 344 to 375)

Tests were written and committed first (`4d552f3`, 28 failing, 3 passing as regression guards), then the implementation (`a2868fc`).

- `alerts.test.mjs` (15): cap reached then dropped with a log line; local-midnight reset in UTC; four New York DST cases; duplicates and cooldown do not use the cap; a capped alert leaves no dedupe or cooldown record; per rule id across symbols; no `maxPerDay` means no state; critical bypass; held and digested count; clock stepped back (across midnight and within a day); `tick` prunes old days.
- `config.test.mjs` (7), `rules.test.mjs` (2), `state.test.mjs` (2).
- `watcher.test.mjs` (5): cap through the whole watcher; restart keeps the counter (cooldown set to 1 minute and advanced, so only the persisted counter can stop it); dry run enforces the cap, prints once, writes no state; expired rule skipped and last day still fires; `--check-config` warns and still prints `OK`.

### Mutation checks (scratch copy, not the worktree)
12 mutations, each caught by at least one new test: cap `>=` to `>`; cap never enforced; midnight reset removed; UTC day instead of local day; fixed 24-hour days; critical alerts capped; counter never incremented; expiry off by a day; expired rules still evaluated; `dailyCounts` dropped on load; stepped-back clock locks out; a capped alert writes its dedupe record.

Method note: my first mutation run used `node --test test/watcher/`, which treats the directory as one file and reports `fail 1` for everything, so it proved nothing. I caught that from the identical counts, switched to `npm test`'s bare `node --test`, and the numbers above come from that run. The scratch copy had 4 baseline failures of its own (no `server.mjs` or fixtures), so each mutation was judged against that baseline of 4.

## Gates (at `a2868fc`)
- `npm test --prefix bridge`: 375 pass, 0 fail (was 344).
- `node bridge/watcher.mjs --config bridge/watcher.config.example.json --check-config`: `OK`.
- `uv run pytest tests/unit -q`: 955 pass (unchanged; no Python touched).

## Known limits
- A rule whose id is `__proto__` is allowed by the id pattern but would never be capped (the assignment sets the prototype, not a key). Not fixed; the id is the user's own.
- The cap counts alerts at submit time. An alert that is accepted but later lost (queue overflow at shutdown) still used its slot.
- Expiry is checked per closed bar, so a rule that expires at midnight stops at the first bar evaluated after midnight.

## Review
(see below, added after the wrap-up review)

# Watcher W2: calendar gating

Regime 4. Sonnet 5.5 High. Plan row: `docs/plans/panwatch-ideas-and-pi-footprint.md` (W2). Design first, then the
implementation report (below the design).

## Goal
1. A rule can say "only fire during the US regular session".
2. The built-in US holiday list stops going stale on 2026-12-25 (it silently ends there today).

## Design

### Rule field
`calendar`: `"any"` (default, today's behaviour) or `"us_session"`. Allowed on every rule type, validated in
`bridge/lib/config.mjs` next to `max_per_day` and `expires`.

`us_session` means: Mon to Fri, 09:30 to 16:00 New York, not a holiday, until 13:00 on an early-close day. That is exactly
`isUsRegularHours` in `bridge/lib/scanner.mjs`, so no new calendar logic. The holiday and early-close lists come from the
existing `health.us_holidays` / `health.us_early_closes` config (one source of truth for scanner, health and rules).

It is defined by time, not by symbol: a crypto rule with `us_session` fires only during US hours, which is a legitimate use
("BTC moves while the US is open").

### Which instant is tested
The **open time of the closed bar** (`closed.at(-1).time`), not `clock.now()` and not `closeTime`.
- First design was `closeTime - 1`. Both reviewers showed it is wrong: `closeTime` is the next *received* candle's open
  (`bridge/lib/stream.mjs:114`), which equals the bar's end only on a 24/7 stream. A stock stream has no bars overnight, so
  the day's last bar (15:45) got the next morning's 09:30 as its "end" and was dropped. `open + timeframe` is also wrong:
  TradingView aligns stock bars to 09:30, so the 15:30 hourly bar is 30 minutes long.
- The bar's open is correct for stocks on every timeframe (09:30 in, 15:45 in, 16:00 out, 12:45 in and 13:00 out on an early
  close) and needs no knowledge of the bar length. Cost: a crypto hourly bar opening 09:00 (closing 10:00) is out, because it
  opened before the session. Chosen on purpose.
- `clock.now()` would drop the last bar of the day whenever delivery lags.

### Where it runs
`onClosedBar` in `bridge/watcher.mjs`, in the same filter as the W1 expiry check, before `evaluateRules`. A gated rule is
never evaluated and touches no state (no `seen`, no `cooldowns`, no daily count), same as an expired rule.

### Intraday only
`us_session` is rejected at config time if the rule's own `timeframes` name `D`, `W` or `M` (even one the watchlist lacks, so
the mistake shows now and not when it is added), or, with no `timeframes` on the rule, if any watched (symbol, timeframe) it
matches is `D`, `W` or `M`. A daily bar closes at a day boundary, where an hour-of-day gate is meaningless and the rule would silently never fire.
Config already treats "a rule that can never match" as an error, so this follows the same rule. The fix for the user is to set
`timeframes` on the rule.

### Holiday data (2027)
Source: NYSE Group, "Announces 2026, 2027 and 2028 Holiday and Early Closings Calendar", 2025-12-23
(`https://s2.q4cdn.com/154085107/files/doc_news/NYSE-Group-Announces-2026-2027-and-2028-Holiday-and-Early-Closings-Calendar-2025.pdf`,
read in full).

Full closures 2027: 01-01, 01-18, 02-15, 03-26 (Good Friday), 05-31, 06-18 (Juneteenth observed), 07-05 (July 4 observed),
09-06, 11-25 (Thanksgiving), 12-24 (Christmas observed).
Early close (13:00 ET) 2027: **11-26 only**. 2027-12-24 is a full closure, not an early close, so it must NOT also appear in
the early-close list (the 2026 list has 12-24 as early close; do not copy that pattern).

The 2026 defaults keep only the dates still ahead (11-26, 12-25 and early closes 11-27, 12-24), as today.

### Stale-calendar warning
`parseConfig` (which already collects warnings and takes `now`) warns when the effective holiday list has no date at or
after 30 days from today. Reason: hard-coded holidays fail silently when they run out; the warning shows in
`--check-config` so it is seen months before the failure, instead of a rule firing on a closed market.

## Out of scope (skipped on purpose)
- Per-rule time windows (`"09:30-10:30"`), per-rule timezones, other exchanges' calendars: add when asked.
- Fetching holidays from a web source at runtime: no network dependency for data that changes once a year.
- Changing `trending` or `health` behaviour: they already use the calendar.

## Steps (each with the command that proves it)
1. Tests first, committed failing: `config.test.mjs` (calendar values, intraday rule, stale warning, 2027 defaults),
   `watcher.test.mjs` (gated out before open, in at 15:59 bar, early close, holiday, last-bar-of-session boundary, gated
   rule writes no state). Proof: `timeout 100 npm test --prefix bridge` fails only on the new tests.
2. Data: 2027 dates in `bridge/lib/scanner.mjs`. Proof: the 2027 default tests pass.
3. `bridge/lib/config.mjs`: validate `calendar`, intraday check, stale warning. Proof: config tests pass.
4. `bridge/watcher.mjs`: the gate in `onClosedBar`. Proof: watcher tests pass.
5. README + `watcher.config.example.json` (one rule gets `calendar`) and `--check-config` prints `OK`.
6. Mutation check (scratch copy), regime-11 review (Fable subagent + Luna Max, read-only, spec path + saved diff), fix
   verified findings, fill in this report, log with `regime_log.py`.

---

# Implementation report

Commits: `531ca61` (failing tests and design), `5ca3437` (implementation), `2c5178b` (review fixes).

## What was built
- `bridge/lib/scanner.mjs`: `DEFAULT_US_HOLIDAYS` and `DEFAULT_US_EARLY_CLOSES` now run through 2027 (data only).
- `bridge/lib/config.mjs`: rule key `calendar` (`any` | `us_session`), the intraday check (`matchedStreams` helper), the
  stale holiday-list warning, and holiday dates now validated with `isCalendarDate`.
- `bridge/watcher.mjs`: the gate in `onClosedBar`; the US calendar is built once and shared with the scanner.
- `bridge/README.md`, `bridge/watcher.config.example.json` (the `volspike` rule now has `timeframes: ["15"]` and `calendar: "us_session"`).
- Tests: 35 new (bridge 377 to 404 incl. review fixes): `config.test.mjs` 6, `watcher.test.mjs` 21 gate cases + 5 gap cases + 3 others.

## Delegation
`config.mjs` went to a Haiku 5.5 xhigh worker (one worker, one file, tests already written). It followed the tests where the
design said less (rule-named timeframes such as `W` also count) and reported the conflict instead of editing a test; the
design was updated to match. It also reported a full-suite run that hit the 100 s timeout once; it did not reproduce in 4
later runs (suite takes about 3 s), and was most likely my concurrent edits to `watcher.mjs` during its run.

## Decisions worth knowing
- Gate on the closed bar's **open**, not `closeTime` (see Design). This was wrong in the first version, see Review.
- `us_session` is by time, not symbol: a crypto rule with it fires only in US hours.
- A gated rule is dropped before `evaluateRules`, so it uses no cap slot and writes no state (tested).

## Mutation checks (committed tree, one mutation at a time, suite run, file restored)
13 on the first version and 5 on the fixes; all caught. Includes: gate removed, gate inverted, `closeTime` instead of the
bar open, `closeTime - 1`, `open + 3600`, `clock.now()`, early-close date swapped, MLK 2027 dropped, intraday list missing `W`,
rule-named timeframes ignored, stale threshold 30 days to 0, comparison flipped, max replaced by min, empty-list guard
removed, calendar value check disabled, impossible-date check removed. My own script once restored files to HEAD and wiped
uncommitted fixes; commit before mutating.

## Review (regime 11): Fable (read-only subagent) and Luna Max (`inv.sh codex gpt-6-luna max`, read-only)
| Finding | Who | Verdict |
|---|---|---|
| Gate used `closeTime - 1`, but `closeTime` is the next received candle's open; on stock streams the last bar of each day (and before holidays and weekends) was judged at the next morning and dropped. My tests only fed contiguous crypto bars, so they were vacuous for stocks. | both | **real, fixed**: gate on the bar's open, 5 gapped-stream tests (3 failed first) |
| `us_holidays` accepted impossible dates (`2027-11-31`), so a typo silently left a holiday ungated | Luna | **real, fixed** with `isCalendarDate` and a test |
| The "30 days" check is elapsed milliseconds, not local calendar days, so it can be a day off around a DST change | Luna | real but trivial, not fixed |
| Luna's own run showed 5 failing test files: its sandbox is read-only (`EROFS` on `/tmp`), not a defect | Luna | not a finding |

Fable also confirmed the 2027 data against the NYSE release (all 10 closures, early close 11-26 only).

## Known limits
- A crypto hourly bar opening 09:00 (closing 10:00) is out of `us_session`; it opened before the session.
- The stale warning counts 30 elapsed days (can be a day off at a DST change) and uses the config timezone.
- Extended-hours stock bars (the library's `session: 'extended'`) are not requested by the watcher today; if that is ever
  enabled, `us_session` would drop pre and post market bars, which is the intended meaning.
- Holiday dates are data: add 2028 before 2027-11-25 (the warning appears then).

## Final gates
`timeout 100 npm test --prefix bridge` = 404 pass, 0 fail. `node bridge/watcher.mjs --config bridge/watcher.config.example.json --check-config` prints `OK`.

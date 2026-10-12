# Watcher W2: calendar gating (design, written before any code)

Regime 4. Sonnet 5.5 High. Plan row: `docs/plans/panwatch-ideas-and-pi-footprint.md` (W2). This file becomes the
implementation report after the build; for now it is only the design.

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
The **last instant of the bar** `(closeTime - 1) * 1000`, not `clock.now()`.
- `closeTime` (the next candle's open, seconds, see `bridge/lib/stream.mjs:114`) is the exclusive end of the bar. The bar that
  ends at 16:00:00 ends at 15:59:59, which is inside the session. The bar that ends at 09:30 ends at 09:29:59, outside.
- `clock.now()` would drop the last bar of the day whenever delivery lags by a second.

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

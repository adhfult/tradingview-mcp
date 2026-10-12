import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlerts } from '../../lib/alerts.mjs';
import { createStateStore } from '../../lib/state.mjs';
import { renderNotify } from '../../lib/format.mjs';
import { createFakeClock } from './support.mjs';

const HOUR = 3_600_000;
const NOON = Date.UTC(2026, 9, 10, 12, 0, 0);
const NIGHT = Date.UTC(2026, 9, 10, 23, 30, 0);

function setup({ start = NOON, alerts = {}, timezone = 'UTC' } = {}) {
  const clock = createFakeClock(start);
  const store = createStateStore({ dir: '/unused-persist-off', clock, persist: false });
  const enqueued = [];
  const queue = { enqueue: (message) => enqueued.push(message), idle: async () => {}, close() {} };
  const config = {
    cooldown_minutes: 60,
    max_per_hour: 20,
    quiet_hours: null,
    digest_after_quiet: true,
    ...alerts,
  };
  const logs = [];
  const pipeline = createAlerts({ alerts: config, timezone, store, clock, queue, log: (l) => logs.push(l) });
  return { clock, store, enqueued, pipeline, logs };
}

const item = (clock, key, extra = {}) => ({
  kind: 'rule',
  message: renderNotify({ title: key, body: '', level: 'up', now: clock.now() }),
  summary: key,
  dedupeKey: key,
  ...extra,
});

test('the first alert is sent; the same dedupe key within 24h is dropped', () => {
  const { clock, pipeline, enqueued } = setup();
  assert.equal(pipeline.submit(item(clock, 'BTC|60|move|1')), 'sent');
  assert.equal(pipeline.submit(item(clock, 'BTC|60|move|1')), 'duplicate');
  assert.equal(enqueued.length, 1);
});

test('a dedupe key is allowed again after 24 hours', () => {
  const { clock, pipeline, enqueued } = setup({ alerts: { max_per_hour: 100 } });
  pipeline.submit(item(clock, 'k'));
  clock.advance(24 * HOUR + 1);
  assert.equal(pipeline.submit(item(clock, 'k')), 'sent');
  assert.equal(enqueued.length, 2);
});

test('cooldown: the same symbol|timeframe|rule is dropped until cooldown_minutes pass', () => {
  const { clock, pipeline, enqueued } = setup();
  const cooldownKey = 'BINANCE:BTCUSDT|60|move';
  assert.equal(pipeline.submit(item(clock, 'bar1', { cooldownKey })), 'sent');
  clock.advance(59 * 60_000);
  assert.equal(pipeline.submit(item(clock, 'bar2', { cooldownKey })), 'cooldown');
  clock.advance(60_000);
  assert.equal(pipeline.submit(item(clock, 'bar3', { cooldownKey })), 'sent');
  assert.equal(enqueued.length, 2);
});

test('the hourly cap sends the excess into a digest that goes out once a slot frees up', () => {
  const { clock, pipeline, enqueued } = setup({ alerts: { max_per_hour: 2 } });
  assert.equal(pipeline.submit(item(clock, 'a')), 'sent');
  assert.equal(pipeline.submit(item(clock, 'b')), 'sent');
  assert.equal(pipeline.submit(item(clock, 'c')), 'digested');
  assert.equal(pipeline.submit(item(clock, 'd')), 'digested');
  assert.equal(enqueued.length, 2);

  pipeline.tick();
  assert.equal(enqueued.length, 2, 'no slot yet, so no digest');

  clock.advance(HOUR + 1);
  pipeline.tick();
  assert.equal(enqueued.length, 3, 'one digest message');
  assert.equal(enqueued[2].title, 'ℹ️ 2 alerts summarised');
  assert.ok(enqueued[2].lines.includes('• c'));
  assert.ok(enqueued[2].lines.includes('• d'));
  assert.equal(pipeline.counts().overflow, 0);
});

test('a digest of many items lists the first 30 and counts the rest', () => {
  const { clock, pipeline, enqueued } = setup({ alerts: { max_per_hour: 1 } });
  pipeline.submit(item(clock, 'first'));
  for (let i = 0; i < 40; i += 1) pipeline.submit(item(clock, `extra${i}`));
  clock.advance(HOUR + 1);
  pipeline.tick();
  const digest = enqueued.at(-1);
  assert.ok(digest.lines.includes('…and 10 more'));
  assert.equal(digest.lines.filter((line) => line.startsWith('• ')).length, 30);
});

test('quiet hours hold alerts, and one digest goes out when they end', () => {
  const { clock, pipeline, enqueued } = setup({
    start: NIGHT,
    timezone: 'UTC',
    alerts: { quiet_hours: { start: '23:00', end: '07:00' } },
  });
  assert.equal(pipeline.quietNow(), true);
  assert.equal(pipeline.submit(item(clock, 'night1')), 'held');
  assert.equal(pipeline.submit(item(clock, 'night2')), 'held');
  pipeline.tick();
  assert.equal(enqueued.length, 0, 'nothing sent during quiet hours');

  clock.advance(7.5 * HOUR); // 07:00 UTC next day
  pipeline.tick();
  assert.equal(enqueued.length, 1, 'one digest at the end of quiet hours');
  assert.ok(enqueued[0].lines.includes('Held during quiet hours:'));
  assert.ok(enqueued[0].lines.includes('• night1'));
  assert.ok(enqueued[0].lines.includes('• night2'));
});

test('with digest_after_quiet off, alerts held overnight are dropped, not sent', () => {
  const { clock, pipeline, enqueued, logs } = setup({
    start: NIGHT,
    alerts: { quiet_hours: { start: '23:00', end: '07:00' }, digest_after_quiet: false },
  });
  pipeline.submit(item(clock, 'night'));
  clock.advance(8 * HOUR);
  pipeline.tick();
  assert.equal(enqueued.length, 0);
  assert.ok(logs.some((line) => line.includes('dropped (digest_after_quiet is off)')));
});

test('quiet hours that cross midnight: 23:00 is quiet, 06:59 is quiet, 07:00 is not', () => {
  const at = (hour, minute) => Date.UTC(2026, 9, 10, hour, minute, 0);
  const quietAt = (ms) => {
    const { clock, pipeline } = setup({
      start: ms,
      alerts: { quiet_hours: { start: '23:00', end: '07:00' } },
    });
    assert.equal(clock.now(), ms);
    return pipeline.quietNow();
  };
  assert.equal(quietAt(at(22, 59)), false);
  assert.equal(quietAt(at(23, 0)), true);
  assert.equal(quietAt(at(6, 59)), true);
  assert.equal(quietAt(at(7, 0)), false);
});

test('quiet hours use the configured timezone, not UTC', () => {
  // 23:30 New York (EDT, UTC-4) is 03:30 UTC the next day
  const { pipeline } = setup({
    start: Date.UTC(2026, 9, 11, 3, 30, 0),
    timezone: 'America/New_York',
    alerts: { quiet_hours: { start: '23:00', end: '07:00' } },
  });
  assert.equal(pipeline.quietNow(), true);
});

test('health (critical) alerts ignore quiet hours and the hourly cap', () => {
  const { clock, pipeline, enqueued } = setup({
    start: NIGHT,
    alerts: { quiet_hours: { start: '23:00', end: '07:00' }, max_per_hour: 1 },
  });
  assert.equal(pipeline.submit(item(clock, 'rule1', { critical: false })), 'held');
  assert.equal(pipeline.submit(item(clock, 'down', { critical: true })), 'sent');
  assert.equal(pipeline.submit(item(clock, 'down2', { critical: true })), 'sent');
  assert.equal(enqueued.length, 2);
});

test('accepted alerts are recorded in history with their status, and can be counted', () => {
  const { clock, pipeline, store } = setup({ alerts: { max_per_hour: 1 } });
  pipeline.submit(item(clock, 'one'));
  pipeline.submit(item(clock, 'two'));
  const statuses = store.state.alerts.map((a) => a.status);
  assert.deepEqual(statuses, ['sent', 'digested']);
  assert.equal(pipeline.countSince(clock.now() - 1), 2);
  assert.equal(pipeline.countSince(clock.now() + 1), 0);
});

test('a duplicate or cooled-down alert is not recorded in history', () => {
  const { clock, pipeline, store } = setup();
  pipeline.submit(item(clock, 'x'));
  pipeline.submit(item(clock, 'x'));
  assert.equal(store.state.alerts.length, 1);
});

test('state records the send times that drive the hourly cap', () => {
  const { clock, pipeline, store } = setup();
  pipeline.submit(item(clock, 'a'));
  clock.advance(1000);
  pipeline.submit(item(clock, 'b'));
  assert.deepEqual(store.state.sends, [NOON, NOON + 1000]);
  assert.equal(pipeline.counts().sentLastHour, 2);
});

// --- review additions ---

test('held alerts saved before a restart go out when the watcher comes back after quiet hours ended', () => {
  const first = setup({ start: NIGHT, alerts: { quiet_hours: { start: '23:00', end: '07:00' } } });
  first.pipeline.submit(item(first.clock, 'night'));
  assert.equal(first.store.state.digest.held.length, 1);
  // A new process starts at 09:00 with the saved state: it never saw quiet hours end.
  const clock = createFakeClock(Date.UTC(2026, 9, 11, 9, 0, 0));
  const enqueued = [];
  const pipeline = createAlerts({
    alerts: { cooldown_minutes: 60, max_per_hour: 20, quiet_hours: { start: '23:00', end: '07:00' }, digest_after_quiet: true },
    timezone: 'UTC',
    store: first.store,
    clock,
    queue: { enqueue: (m) => enqueued.push(m) },
  });
  pipeline.tick();
  assert.equal(enqueued.length, 1, 'one digest for what was held');
  assert.ok(enqueued[0].lines.includes('• night'));
  assert.equal(first.store.state.digest.held.length, 0);
});

test('health alerts are not counted against the hourly cap, so they cannot starve rule alerts', () => {
  const { clock, pipeline, enqueued } = setup({ alerts: { max_per_hour: 2 } });
  for (let i = 0; i < 5; i += 1) pipeline.submit(item(clock, `down${i}`, { critical: true }));
  assert.equal(pipeline.counts().sentLastHour, 0);
  assert.equal(pipeline.submit(item(clock, 'rule1')), 'sent');
  assert.equal(pipeline.submit(item(clock, 'rule2')), 'sent');
  assert.equal(pipeline.submit(item(clock, 'rule3')), 'digested');
  assert.equal(enqueued.length, 7);
});

test('the digest buffers stay bounded over a long quiet period or a long outage', () => {
  const { clock, pipeline, store } = setup({
    start: NIGHT,
    alerts: { quiet_hours: { start: '23:00', end: '07:00' }, cooldown_minutes: 0 },
  });
  for (let i = 0; i < 900; i += 1) pipeline.submit(item(clock, `k${i}`));
  assert.equal(store.state.digest.held.length, 500, 'oldest dropped first');
  assert.equal(store.state.digest.held[0].summary, 'k400');
  assert.equal(store.state.alerts.length, 500);
});

test('quiet hours follow the wall clock across the autumn DST change in New York', () => {
  const quietAt = (ms) => setup({
    start: ms,
    timezone: 'America/New_York',
    alerts: { quiet_hours: { start: '23:00', end: '07:00' } },
  }).pipeline.quietNow();
  // Sat 2026-10-31, still EDT (UTC-4): 06:59 is quiet, 07:00 is not.
  assert.equal(quietAt(Date.UTC(2026, 9, 31, 10, 59)), true);
  assert.equal(quietAt(Date.UTC(2026, 9, 31, 11, 0)), false);
  // Sun 2026-11-01 the clocks go back at 02:00 EDT: now EST (UTC-5). 07:00 EST is 12:00Z.
  assert.equal(quietAt(Date.UTC(2026, 10, 1, 11, 59)), true);
  assert.equal(quietAt(Date.UTC(2026, 10, 1, 12, 0)), false);
  // 23:00 EST on Nov 1 is 04:00Z on Nov 2.
  assert.equal(quietAt(Date.UTC(2026, 10, 2, 3, 59)), false);
  assert.equal(quietAt(Date.UTC(2026, 10, 2, 4, 0)), true);
});

test('quiet hours follow the wall clock across the spring DST change in New York', () => {
  const quietAt = (ms) => setup({
    start: ms,
    timezone: 'America/New_York',
    alerts: { quiet_hours: { start: '23:00', end: '07:00' } },
  }).pipeline.quietNow();
  // Sun 2026-03-08 clocks go forward at 02:00 EST. 07:00 EDT (UTC-4) is 11:00Z.
  assert.equal(quietAt(Date.UTC(2026, 2, 8, 10, 59)), true);
  assert.equal(quietAt(Date.UTC(2026, 2, 8, 11, 0)), false);
});

test('a cooldown or dedupe time in the future (clock stepped back) does not silence alerts', () => {
  const { clock, pipeline, store } = setup();
  store.state.cooldowns['BTC|60|r'] = clock.now() + 5 * HOUR;
  store.state.seen.stale = clock.now() + 5 * HOUR;
  assert.equal(pipeline.submit(item(clock, 'stale', { cooldownKey: 'BTC|60|r' })), 'sent');
});

test('cooldown holds across midnight in the configured timezone, and ends on time', () => {
  const { clock, pipeline } = setup({
    start: Date.UTC(2026, 9, 11, 3, 50), // 23:50 New York
    timezone: 'America/New_York',
    alerts: { cooldown_minutes: 60 },
  });
  assert.equal(pipeline.submit(item(clock, 'a', { cooldownKey: 'k' })), 'sent');
  clock.advance(30 * 60_000);                 // 00:20 next local day
  assert.equal(pipeline.submit(item(clock, 'b', { cooldownKey: 'k' })), 'cooldown');
  clock.advance(30 * 60_000);                 // 00:50
  assert.equal(pipeline.submit(item(clock, 'c', { cooldownKey: 'k' })), 'sent');
});

// ---- W1: per-rule daily cap (max_per_day) ----------------------------------------------
// A rule alert carries {ruleId, maxPerDay}. The count is per rule id and per local calendar
// day in the config timezone. Only accepted alerts (sent, held, digested) use the cap.

const capped = (clock, key, extra = {}) => item(clock, key, { ruleId: 'move', maxPerDay: 2, ...extra });

test('daily cap: after max_per_day accepted alerts the rule is dropped, with a log line', () => {
  const { clock, pipeline, enqueued, logs } = setup({ alerts: { max_per_hour: 100 } });
  assert.equal(pipeline.submit(capped(clock, 'a')), 'sent');
  assert.equal(pipeline.submit(capped(clock, 'b')), 'sent');
  assert.equal(pipeline.submit(capped(clock, 'c')), 'capped');
  assert.equal(enqueued.length, 2);
  assert.ok(logs.some((l) => l.includes('daily cap') && l.includes('move')), logs.join('\n'));
});

test('daily cap: the count resets at local midnight (UTC zone)', () => {
  const { clock, pipeline } = setup({ start: NIGHT, alerts: { max_per_hour: 100 } });
  assert.equal(pipeline.submit(capped(clock, 'a', { maxPerDay: 1 })), 'sent');
  clock.advance(29 * 60_000);                                   // 23:59
  assert.equal(pipeline.submit(capped(clock, 'b', { maxPerDay: 1 })), 'capped');
  clock.advance(60_000);                                        // 00:00 next day
  assert.equal(pipeline.submit(capped(clock, 'c', { maxPerDay: 1 })), 'sent');
});

// New York: the day is 25 hours long when clocks fall back and 23 when they spring forward,
// so a rolling 24-hour window or a fixed UTC offset would reset at the wrong moment.
for (const [name, lastMinuteBefore, midnight] of [
  ['fall back (2026-11-01 is 25 hours long)', Date.UTC(2026, 10, 2, 4, 59), Date.UTC(2026, 10, 2, 5, 0)],
  ['spring forward (2026-03-08 is 23 hours long)', Date.UTC(2026, 2, 9, 3, 59), Date.UTC(2026, 2, 9, 4, 0)],
  ['the midnight that starts the long day (fall back)', Date.UTC(2026, 10, 1, 3, 59), Date.UTC(2026, 10, 1, 4, 0)],
  ['the midnight that starts the short day (spring forward)', Date.UTC(2026, 2, 8, 4, 59), Date.UTC(2026, 2, 8, 5, 0)],
]) {
  test(`daily cap: resets at New York midnight across a DST change: ${name}`, () => {
    const { clock, pipeline } = setup({ start: lastMinuteBefore - 60_000, timezone: 'America/New_York', alerts: { max_per_hour: 100 } });
    const one = (key) => capped(clock, key, { maxPerDay: 1 });
    assert.equal(pipeline.submit(one('a')), 'sent');
    clock.advance(60_000);                                      // the last minute of the local day
    assert.equal(clock.now(), lastMinuteBefore);
    assert.equal(pipeline.submit(one('b')), 'capped');
    clock.advance(midnight - lastMinuteBefore);                 // local midnight
    assert.equal(pipeline.submit(one('c')), 'sent');
  });
}

test('daily cap: duplicates and cooldown drops do not use up the cap', () => {
  const { clock, pipeline } = setup({ alerts: { max_per_hour: 100 } });
  assert.equal(pipeline.submit(capped(clock, 'a', { cooldownKey: 'k' })), 'sent');
  assert.equal(pipeline.submit(capped(clock, 'a', { cooldownKey: 'k' })), 'duplicate');
  assert.equal(pipeline.submit(capped(clock, 'b', { cooldownKey: 'k' })), 'cooldown');
  assert.equal(pipeline.submit(capped(clock, 'c')), 'sent', 'only one of the three used the cap of 2');
  assert.equal(pipeline.submit(capped(clock, 'd')), 'capped');
});

test('daily cap: a capped alert leaves no dedupe or cooldown record behind', () => {
  const { clock, pipeline } = setup({ start: NIGHT, alerts: { max_per_hour: 100 } });
  const one = (key, extra) => capped(clock, key, { maxPerDay: 1, ...extra });
  assert.equal(pipeline.submit(one('a')), 'sent');
  assert.equal(pipeline.submit(one('b', { cooldownKey: 'k' })), 'capped');
  clock.advance(HOUR);                                          // next local day, inside the 24h dedupe window
  assert.equal(pipeline.submit(one('b', { cooldownKey: 'k' })), 'sent');
});

test('daily cap: counted per rule id, across symbols and timeframes', () => {
  const { clock, pipeline } = setup({ alerts: { max_per_hour: 100 } });
  const one = (key, ruleId) => item(clock, key, { ruleId, maxPerDay: 1 });
  assert.equal(pipeline.submit(one('BTC|60|move|1', 'move')), 'sent');
  assert.equal(pipeline.submit(one('ETH|240|move|1', 'move')), 'capped', 'same rule, other symbol and timeframe');
  assert.equal(pipeline.submit(one('BTC|60|rsi|1', 'rsi')), 'sent', 'another rule has its own count');
});

test('daily cap: a rule without max_per_day is never counted or capped, and no state is kept', () => {
  const { clock, pipeline, store } = setup({ alerts: { max_per_hour: 100 } });
  for (let i = 0; i < 5; i += 1) assert.equal(pipeline.submit(item(clock, `k${i}`, { ruleId: 'move' })), 'sent');
  assert.deepEqual(store.state.dailyCounts, {});
});

test('daily cap: critical (health) alerts bypass the cap and never use it', () => {
  const { clock, pipeline } = setup({ alerts: { max_per_hour: 100 } });
  const one = (key, extra) => capped(clock, key, { maxPerDay: 1, ...extra });
  assert.equal(pipeline.submit(one('h1', { critical: true })), 'sent');
  assert.equal(pipeline.submit(one('a')), 'sent', 'the health alert did not use the cap');
  assert.equal(pipeline.submit(one('b')), 'capped');
  assert.equal(pipeline.submit(one('h2', { critical: true })), 'sent', 'health alerts are never capped');
});

test('daily cap: held (quiet hours) and digested (hourly cap) alerts count, because they are queued', () => {
  const quiet = setup({ start: NIGHT, alerts: { quiet_hours: { start: '23:00', end: '07:00' } } });
  assert.equal(quiet.pipeline.submit(capped(quiet.clock, 'a', { maxPerDay: 1 })), 'held');
  assert.equal(quiet.pipeline.submit(capped(quiet.clock, 'b', { maxPerDay: 1 })), 'capped');

  const busy = setup({ alerts: { max_per_hour: 1 } });
  assert.equal(busy.pipeline.submit(capped(busy.clock, 'a')), 'sent');
  assert.equal(busy.pipeline.submit(capped(busy.clock, 'b')), 'digested');
  assert.equal(busy.pipeline.submit(capped(busy.clock, 'c')), 'capped');
});

test('daily cap: a clock that stepped back across midnight does not lock the rule out', () => {
  const { clock, pipeline, store } = setup({ alerts: { max_per_hour: 100 } });
  store.state.dailyCounts = { move: { date: '2026-10-11', count: 5 } };   // saved "tomorrow"
  assert.equal(pipeline.submit(capped(clock, 'a', { maxPerDay: 1 })), 'sent');
  assert.deepEqual(store.state.dailyCounts.move, { date: '2026-10-10', count: 1 });
});

test('daily cap: a step back inside the same local day keeps the count', () => {
  const { clock, pipeline } = setup({ alerts: { max_per_hour: 100 } });
  assert.equal(pipeline.submit(capped(clock, 'a', { maxPerDay: 1 })), 'sent');
  clock.advance(-HOUR);
  assert.equal(pipeline.submit(capped(clock, 'b', { maxPerDay: 1 })), 'capped');
});

test('daily cap: tick prunes counts from earlier days and malformed ones, and keeps today and later days', () => {
  const { pipeline, store } = setup();
  store.state.dailyCounts = {
    old: { date: '2026-10-08', count: 3 },
    today: { date: '2026-10-10', count: 1 },
    future: { date: '2026-10-11', count: 2 },   // saved before the clock stepped back: kept, not pruned
    junk: 'not a count',
  };
  pipeline.tick();
  assert.deepEqual(Object.keys(store.state.dailyCounts).sort(), ['future', 'today']);
});

test('daily cap: held alerts do not count when digest_after_quiet is off, because they are dropped later', () => {
  const quiet = { quiet_hours: { start: '23:00', end: '07:00' }, digest_after_quiet: false };
  const { clock, pipeline } = setup({ start: NIGHT, alerts: quiet });
  assert.equal(pipeline.submit(capped(clock, 'a', { maxPerDay: 1 })), 'held');
  assert.equal(pipeline.submit(capped(clock, 'b', { maxPerDay: 1 })), 'held', 'the first held alert did not use the cap');
});

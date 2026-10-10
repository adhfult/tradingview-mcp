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

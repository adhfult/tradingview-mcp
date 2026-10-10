import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealth } from '../../lib/health.mjs';
import { createStateStore } from '../../lib/state.mjs';
import { createFakeClock } from './support.mjs';

const MINUTE = 60_000;
const NOON_UTC = Date.UTC(2026, 9, 12, 12, 0, 0);           // Mon 08:00 NY (EDT)
const MON_1000_NY = Date.UTC(2026, 9, 12, 14, 0, 0);       // Mon 10:00 NY, US session open
const SAT_NOON = Date.UTC(2026, 9, 10, 12, 0, 0);           // Saturday: US closed

function setup({ now = NOON_UTC, streams = [], config = {} } = {}) {
  const clock = createFakeClock(now);
  const store = createStateStore({ dir: '/unused', clock, persist: false });
  const sent = [];
  const alerts = {
    submit: (item) => { sent.push(item); return 'sent'; },
    countSince: () => 3,
  };
  const list = streams.map((s) => ({ ...s }));
  const fakeStreams = {
    list: () => list.map((s) => ({ ...s })),
    healthyCount: () => list.filter((s) => s.healthy).length,
    total: list.length,
  };
  const health = createHealth({
    streams: fakeStreams,
    alerts,
    clock,
    store,
    timezone: 'America/New_York',
    config: { stream_down_minutes: 10, daily_heartbeat: null, ...config },
    startedAtMs: now - 3 * 3600_000,
    credentialsInUse: true,
  });
  return { clock, store, sent, health, list };
}

const btc = (overrides = {}) => ({
  key: 'BINANCE:BTCUSDT|15', symbol: 'BINANCE:BTCUSDT', timeframe: '15', market: 'crypto',
  lastDataAt: NOON_UTC, healthy: true, ...overrides,
});

test('a crypto stream with no data for longer than stream_down_minutes sends one "down" alert', () => {
  const { clock, sent, health, list } = setup({ streams: [btc()] });
  clock.advance(9 * MINUTE);
  health.tick();
  assert.equal(sent.length, 0, 'not yet');
  clock.advance(2 * MINUTE);
  health.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.title, '🔴 BINANCE:BTCUSDT · 15m · stream down');
  assert.equal(sent[0].critical, true, 'health alerts are critical');
  health.tick();
  health.tick();
  assert.equal(sent.length, 1, 'no repeat while still down');
  assert.equal(list.length, 1);
});

test('when data returns after a "down" alert, one "recovered" alert is sent', () => {
  const { clock, sent, health, list } = setup({ streams: [btc()] });
  clock.advance(11 * MINUTE);
  health.tick();
  const streamState = list[0];
  streamState.lastDataAt = clock.now() + 1000; // data arrives after the down alert
  clock.advance(1000);
  health.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].message.title, '🟢 BINANCE:BTCUSDT · 15m · stream recovered');
  health.tick();
  assert.equal(sent.length, 2, 'one recovered alert only');
});

test('a stream that keeps receiving data never raises an alert', () => {
  const { clock, sent, health, list } = setup({ streams: [btc()] });
  for (let i = 0; i < 30; i += 1) {
    clock.advance(MINUTE);
    list[0].lastDataAt = clock.now();
    health.tick();
  }
  assert.equal(sent.length, 0);
});

test('a stock stream outside US regular hours is not counted as silent', () => {
  const nvda = {
    key: 'NASDAQ:NVDA|15', symbol: 'NASDAQ:NVDA', timeframe: '15', market: 'stock',
    lastDataAt: SAT_NOON, healthy: true,
  };
  const { clock, sent, health } = setup({ now: SAT_NOON, streams: [nvda] });
  clock.advance(3 * 3600_000);
  health.tick();
  assert.equal(sent.length, 0, 'a Saturday is not a session, so no alert');
});

test('a stock stream silent during US regular hours does raise a "down" alert', () => {
  const nvda = {
    key: 'NASDAQ:NVDA|15', symbol: 'NASDAQ:NVDA', timeframe: '15', market: 'stock',
    lastDataAt: MON_1000_NY, healthy: true,
  };
  const { clock, sent, health } = setup({ now: MON_1000_NY, streams: [nvda] });
  clock.advance(11 * MINUTE);
  health.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.title, '🔴 NASDAQ:NVDA · 15m · stream down');
});

test('a stock stream is not "down" for the closed period that just ended', () => {
  const nvda = {
    key: 'NASDAQ:NVDA|15', symbol: 'NASDAQ:NVDA', timeframe: '15', market: 'stock',
    lastDataAt: Date.UTC(2026, 9, 12, 13, 0, 0), healthy: true, // 09:00 NY, last bar before the open
  };
  const { clock, sent, health } = setup({ now: NOON_UTC, streams: [nvda] });
  // Health runs every 30 s in production, so tick every minute through the closed period
  // (08:00 to 09:30 NY) and for 8 minutes into the session (inside the 10-minute threshold).
  for (let minute = 0; minute <= 98; minute += 1) {
    health.tick();
    clock.advance(MINUTE);
  }
  assert.equal(sent.length, 0, 'silence before the session opens is not counted');
});

test('the heartbeat is sent once a day at the configured local time, not before', () => {
  const { clock, sent, health, store } = setup({
    config: { daily_heartbeat: '08:00' },
    now: Date.UTC(2026, 9, 12, 11, 59, 0), // 07:59 NY
    streams: [btc({ lastDataAt: Date.UTC(2026, 9, 12, 11, 59, 0) })],
  });
  health.tick();
  assert.equal(sent.filter((s) => s.kind === 'heartbeat').length, 0);
  clock.advance(2 * MINUTE); // 08:01 NY
  health.tick();
  const beats = sent.filter((s) => s.kind === 'heartbeat');
  assert.equal(beats.length, 1);
  assert.equal(beats[0].critical, true);
  assert.equal(store.state.heartbeatDate, '2026-10-12');
  health.tick();
  assert.equal(sent.filter((s) => s.kind === 'heartbeat').length, 1, 'once per local day');
});

test('the heartbeat carries uptime, streams healthy of total, alerts in 24h, and credentials yes or no', () => {
  const { sent, health } = setup({
    config: { daily_heartbeat: '08:00' },
    now: Date.UTC(2026, 9, 12, 12, 30, 0),
    streams: [btc({ healthy: true }), btc({ key: 'X|60', symbol: 'X', timeframe: '60', healthy: false })],
  });
  health.tick();
  const beat = sent.find((s) => s.kind === 'heartbeat').message;
  assert.equal(beat.title, 'ℹ️ Watcher daily heartbeat');
  assert.ok(beat.lines.includes('Uptime: 3h 0m'));
  assert.ok(beat.lines.includes('Streams healthy: 1 of 2'));
  assert.ok(beat.lines.includes('Alerts in the last 24h: 3'));
  assert.ok(beat.lines.includes('TradingView credentials in use: yes'));
  assert.ok(!beat.lines.join('\n').includes('SESSION'), 'never a credential value');
});

test('the heartbeat is off when daily_heartbeat is null', () => {
  const { sent, health } = setup({ now: Date.UTC(2026, 9, 12, 14, 0, 0), streams: [btc({ lastDataAt: Date.UTC(2026, 9, 12, 14, 0, 0) })] });
  health.tick();
  assert.equal(sent.filter((s) => s.kind === 'heartbeat').length, 0);
});

test('the heartbeat uses the config timezone for the local date', () => {
  // 02:30 UTC on 13 Oct is 22:30 on 12 Oct in New York, so the heartbeat is for 12 Oct
  const { clock, store, sent, health } = setup({
    config: { daily_heartbeat: '08:00' },
    now: Date.UTC(2026, 9, 13, 2, 30, 0),
    streams: [],
  });
  health.tick();
  assert.equal(store.state.heartbeatDate, '2026-10-12');
  assert.equal(sent.filter((s) => s.kind === 'heartbeat').length, 1);
  clock.advance(10 * 3600_000); // 12:30 UTC on 13 Oct, 08:30 New York on 13 Oct
  health.tick();
  assert.equal(store.state.heartbeatDate, '2026-10-13');
  assert.equal(sent.filter((s) => s.kind === 'heartbeat').length, 2);
});

// --- review additions ---

test('a silent stream is not counted as healthy in the summary, and counts again after recovery', () => {
  const { clock, health, list } = setup({ streams: [btc({ status: 'healthy' })] });
  list[0].healthy = true;
  assert.deepEqual(health.summary(), { healthy: 1, total: 1 });
  clock.advance(11 * MINUTE);
  health.tick();
  assert.deepEqual(health.summary(), { healthy: 0, total: 1 });
  clock.advance(1000);
  list[0].lastDataAt = clock.now();
  health.tick();
  assert.deepEqual(health.summary(), { healthy: 1, total: 1 });
});

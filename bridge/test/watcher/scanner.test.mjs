import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScanner, isUsRegularHours } from '../../lib/scanner.mjs';
import { createStateStore, emptyState } from '../../lib/state.mjs';
import { createFakeClock } from './support.mjs';

const HOUR = 3_600_000;
// Fixed instants (New York is on EDT, UTC-4, in October)
const SATURDAY_10AM = Date.UTC(2026, 9, 10, 14, 0, 0);      // Sat 10:00 NY
const MONDAY_0900_NY = Date.UTC(2026, 9, 12, 13, 0, 0);     // Mon 09:00 NY (before the open)
const MONDAY_1000_NY = Date.UTC(2026, 9, 12, 14, 0, 0);     // Mon 10:00 NY (open)
const MONDAY_1600_NY = Date.UTC(2026, 9, 12, 20, 0, 0);     // Mon 16:00 NY (closed)
const MONDAY_0930_NY = Date.UTC(2026, 9, 12, 13, 30, 0);    // Mon 09:30 NY (opens)

const TRENDING = {
  enabled: true,
  every_minutes: 10,
  markets: ['crypto', 'america'],
  kinds: ['gainers'],
  top_n: 15,
  us_regular_hours_only: true,
  remember_hours: 6,
};

function setup({ now = MONDAY_1000_NY, rows = {}, trending = {}, failing = new Set() } = {}) {
  const clock = createFakeClock(now);
  const store = createStateStore({ dir: '/unused', clock, persist: false });
  const sent = [];
  const alerts = { submit: (item) => { sent.push(item); return 'sent'; } };
  const logs = [];
  const logger = { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) };
  const calls = [];
  const getHotlist = async (query) => {
    calls.push(query);
    const key = `${query.market}|${query.kind}`;
    if (failing.has(key)) throw new Error('upstream 503');
    return { totalCount: 0, rows: rows[key] ?? [] };
  };
  const scanner = createScanner({
    trending: { ...TRENDING, ...trending },
    timezone: 'America/New_York',
    getHotlist,
    store,
    clock,
    alerts,
    logger,
  });
  return { clock, store, sent, logs, calls, scanner };
}

const row = (symbol, change = 1) => ({ symbol, values: { name: symbol, close: 1, change, volume: 5 } });

test('US regular hours: Saturday is closed, Monday 09:00 is closed, 09:30 opens, 10:00 is open, 16:00 closes', () => {
  assert.equal(isUsRegularHours(SATURDAY_10AM), false);
  assert.equal(isUsRegularHours(MONDAY_0900_NY), false);
  assert.equal(isUsRegularHours(MONDAY_0930_NY), true);
  assert.equal(isUsRegularHours(MONDAY_1000_NY), true);
  assert.equal(isUsRegularHours(MONDAY_1600_NY), false);
});

test('america is skipped on a Saturday, while crypto is still scanned', async () => {
  const { scanner, calls, logs } = setup({ now: SATURDAY_10AM });
  await scanner.runOnce();
  assert.deepEqual(calls.map((c) => c.market), ['crypto']);
  assert.ok(logs.some((l) => l === 'info trending america: skipped (outside US regular hours)'));
});

test('america is skipped at 09:00 on a weekday and scanned at 10:00', async () => {
  const early = setup({ now: MONDAY_0900_NY });
  await early.scanner.runOnce();
  assert.deepEqual(early.calls.map((c) => c.market), ['crypto']);

  const open = setup({ now: MONDAY_1000_NY });
  await open.scanner.runOnce();
  assert.deepEqual(open.calls.map((c) => c.market), ['crypto', 'america']);
});

test('us_regular_hours_only false scans america at any time', async () => {
  const { scanner, calls } = setup({ now: SATURDAY_10AM, trending: { us_regular_hours_only: false } });
  await scanner.runOnce();
  assert.deepEqual(calls.map((c) => c.market), ['crypto', 'america']);
});

test('the scan asks for the top_n range of each market and kind', async () => {
  const { scanner, calls } = setup({ trending: { markets: ['crypto'], kinds: ['gainers', 'losers'], top_n: 5 } });
  await scanner.runOnce();
  assert.deepEqual(calls.map((c) => ({ kind: c.kind, market: c.market, range: c.range })), [
    { kind: 'gainers', market: 'crypto', range: [0, 5] },
    { kind: 'losers', market: 'crypto', range: [0, 5] },
  ]);
});

test('the first scan alerts on every symbol, and a repeat scan alerts on none', async () => {
  const { scanner, sent, clock } = setup({ trending: { markets: ['crypto'] }, rows: {
    'crypto|gainers': [row('BINANCE:AAAUSDT'), row('BINANCE:BBBUSDT')],
  } });
  await scanner.runOnce();
  assert.deepEqual(sent.map((s) => s.summary), [
    'BINANCE:AAAUSDT trending crypto gainers #1',
    'BINANCE:BBBUSDT trending crypto gainers #2',
  ]);
  clock.advance(10 * 60_000);
  await scanner.runOnce();
  assert.equal(sent.length, 2, 'symbols that stayed in the list do not re-alert');
});

test('a symbol that drops out and returns within remember_hours is not new', async () => {
  const rows = { 'crypto|gainers': [row('BINANCE:AAAUSDT')] };
  const { scanner, sent, clock } = setup({ trending: { markets: ['crypto'] }, rows });
  await scanner.runOnce();
  assert.equal(sent.length, 1);

  rows['crypto|gainers'] = [];                 // drops out (empty result: skipped, state unchanged)
  clock.advance(HOUR);
  rows['crypto|gainers'] = [row('BINANCE:BBBUSDT')];
  await scanner.runOnce();                     // BBB is new, AAA is not in the list
  rows['crypto|gainers'] = [row('BINANCE:AAAUSDT')];
  clock.advance(HOUR);
  await scanner.runOnce();                     // AAA back after 2 h: not new
  assert.deepEqual(sent.map((s) => s.summary).filter((s) => s.includes('AAA')), [
    'BINANCE:AAAUSDT trending crypto gainers #1',
  ]);
});

test('a symbol not seen for longer than remember_hours is new again', async () => {
  const rows = { 'crypto|gainers': [row('BINANCE:AAAUSDT')] };
  const { scanner, sent, clock } = setup({ trending: { markets: ['crypto'], remember_hours: 6 }, rows });
  await scanner.runOnce();
  rows['crypto|gainers'] = [row('BINANCE:CCCUSDT')];
  clock.advance(3 * HOUR);
  await scanner.runOnce();
  rows['crypto|gainers'] = [row('BINANCE:AAAUSDT')];
  clock.advance(7 * HOUR);                     // more than 6 h since AAA was last seen
  await scanner.runOnce();
  const aaa = sent.filter((s) => s.summary.includes('AAA'));
  assert.equal(aaa.length, 2, 'alerted again after the remember window');
});

test('the seen list is pruned after remember_hours', async () => {
  const rows = { 'crypto|gainers': [row('BINANCE:AAAUSDT')] };
  const { scanner, clock, store } = setup({ trending: { markets: ['crypto'] }, rows });
  await scanner.runOnce();
  assert.ok('BINANCE:AAAUSDT' in store.state.trending['crypto|gainers']);
  rows['crypto|gainers'] = [];
  clock.advance(7 * HOUR);
  await scanner.runOnce();                     // empty: skipped, so the prune never runs
  rows['crypto|gainers'] = [row('BINANCE:ZZZUSDT')];
  await scanner.runOnce();
  assert.equal('BINANCE:AAAUSDT' in store.state.trending['crypto|gainers'], false);
});

test('an empty result sends no alert and logs a skip', async () => {
  const { scanner, sent, logs } = setup({ trending: { markets: ['crypto'] } });
  await scanner.runOnce();
  assert.equal(sent.length, 0);
  assert.ok(logs.some((l) => l === 'info trending crypto/gainers: empty result, skipped'));
});

test('an error sends no alert, logs a warning, and the other markets still run', async () => {
  const { scanner, sent, logs, calls } = setup({
    now: MONDAY_1000_NY,
    failing: new Set(['crypto|gainers']),
    rows: { 'america|gainers': [row('NASDAQ:NVDA')] },
  });
  await scanner.runOnce();
  assert.ok(logs.some((l) => l.startsWith('warn trending crypto/gainers failed: upstream 503')));
  assert.deepEqual(calls.map((c) => c.market), ['crypto', 'america']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].summary, 'NASDAQ:NVDA trending america gainers #1');
});

test('an overlapping scan is refused while one is still running', async () => {
  const { scanner } = setup({ trending: { markets: ['crypto'] } });
  const first = scanner.runOnce();
  assert.equal(await scanner.runOnce(), false);
  assert.equal(await first, true);
});

test('the trending alert message is built for the new entry, with its rank and level', async () => {
  const { scanner, sent } = setup({ trending: { markets: ['crypto'], kinds: ['losers'] }, rows: {
    'crypto|losers': [row('BYBIT:XYZUSDT', -4.2)],
  } });
  await scanner.runOnce();
  assert.equal(sent[0].message.level, 'down');
  assert.equal(sent[0].message.title, '🔴 BYBIT:XYZUSDT · trending crypto losers');
  assert.ok(sent[0].message.lines[0].includes('Ranked #1 in crypto losers'));
  assert.ok(sent[0].dedupeKey.startsWith('trend|crypto|losers|BYBIT:XYZUSDT|'));
});

test('printOnce lists every market and kind without touching the seen list or alerts', async () => {
  const { scanner, sent, store } = setup({
    now: SATURDAY_10AM,
    trending: { markets: ['crypto', 'america'] },
    rows: { 'crypto|gainers': [row('BINANCE:AAAUSDT', 2)] },
  });
  const lines = await scanner.printOnce();
  assert.equal(lines[0], 'crypto gainers');
  assert.equal(lines[1], '  1. BINANCE:AAAUSDT  close=1 change=2 volume=5');
  assert.equal(lines[2], 'america gainers');
  assert.equal(lines[3], '  (empty result)');
  assert.equal(sent.length, 0);
  assert.deepEqual(store.state.trending, {});
});

test('emptyState has an empty trending map to start from', () => {
  assert.deepEqual(emptyState().trending, {});
});

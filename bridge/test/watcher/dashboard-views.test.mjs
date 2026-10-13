import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthView, indicatorsView, overviewView, trendingView } from '../../lib/dashboard-views.mjs';
import { bollinger, rsi } from '../../lib/indicators.mjs';

const T0 = 1_760_000_000;
const BTC = { key: 'BINANCE:BTCUSDT|60', symbol: 'BINANCE:BTCUSDT', timeframe: '60', market: 'crypto', status: 'healthy', lastBarTime: T0 + 3600 * 69, lastDataAt: 5000, attempt: 0, disconnects: 2, lastError: 'ECONNRESET' };
const NVDA = { key: 'NASDAQ:NVDA|D', symbol: 'NASDAQ:NVDA', timeframe: 'D', market: 'stock', status: 'restarting', lastBarTime: null, lastDataAt: null, attempt: 3, disconnects: 0, lastError: null };
const LIST = [BTC, NVDA];
const candles = (n, close = (i) => 100 + Math.sin(i / 3) * 5) => Array.from({ length: n }, (_, i) => ({
  time: T0 + i * 3600, open: close(i), high: close(i) + 1, low: close(i) - 1, close: close(i), volume: 10 + i,
}));

// ---------------------------------------------------------------- health (B2, B9)

test('healthView passes only the whitelisted status fields and computes the uptime', () => {
  const view = healthView({
    nowMs: 100_000, startedAtMs: 40_000, loggedIn: true, healthy: 1, total: 2, disconnects: 2, connectionDrops: 1,
    queuePending: 0, sentLastHour: 3, maxPerHour: 10, quietNow: false, held: 1, overflow: 0, usOpen: true, nextHoliday: '2026-11-26',
    cookie: 'sessionid=SECRET', token: 'SECRET', trending: { 'crypto|gainers': {} },
  }, LIST);
  assert.equal(view.uptimeSeconds, 60);
  assert.equal(view.loggedIn, true);
  assert.deepEqual([view.healthy, view.total, view.disconnects, view.connectionDrops], [1, 2, 2, 1]);
  assert.deepEqual([view.sentLastHour, view.maxPerHour, view.quietNow, view.held, view.overflow, view.queuePending], [3, 10, false, 1, 0, 0]);
  assert.deepEqual([view.usOpen, view.nextHoliday], [true, '2026-11-26']);
  assert.ok(!JSON.stringify(view).includes('SECRET'), 'no credential-like field reaches the page');
  assert.ok(!('trending' in view) && !('cookie' in view) && !('token' in view));
});

test('healthView lists each stream with its status, ages and last error code, and leaves out the candle key', () => {
  const view = healthView({}, LIST);
  assert.deepEqual(view.streams[0], { symbol: BTC.symbol, timeframe: '60', market: 'crypto', status: 'healthy', lastBarTime: BTC.lastBarTime, lastDataAt: 5000, attempt: 0, disconnects: 2, lastError: 'ECONNRESET' });
  assert.equal(view.streams[1].lastError, null);
  assert.ok(!('key' in view.streams[0]));
});

test('healthView with an empty status gives nulls, never undefined or a throw; an over-long error code is cut', () => {
  const view = healthView({}, [{ ...BTC, lastError: 'E'.repeat(500) }]);
  assert.equal(view.uptimeSeconds, null);
  assert.equal(view.loggedIn, null);
  assert.equal(view.usOpen, null);
  assert.equal(view.streams[0].lastError.length, 64);
  assert.doesNotThrow(() => JSON.stringify(view));
});

// ---------------------------------------------------------------- overview (B1)

test('overviewView: last price, change over the sparkline window, and at most 60 closes', () => {
  const view = overviewView({ list: LIST, candlesOf: (key) => (key === BTC.key ? candles(70, (i) => 100 + i) : []), alerts: [], status: {} });
  const btc = view[0];
  assert.equal(btc.symbol, BTC.symbol);
  assert.equal(btc.price, 169);
  assert.equal(btc.spark.length, 60);
  assert.deepEqual([btc.spark[0], btc.spark.at(-1)], [110, 169]);
  assert.equal(btc.changePct, Number((((169 - 110) / 110) * 100).toFixed(2)));
  assert.equal(btc.healthy, true);
});

test('overviewView: a stream with no candles has null price and change, an empty sparkline and healthy false', () => {
  const nvda = overviewView({ list: LIST, candlesOf: () => [], alerts: [], status: {} })[1];
  assert.deepEqual([nvda.price, nvda.changePct, nvda.spark, nvda.healthy], [null, null, [], false]);
});

test('overviewView: a first close of zero gives a null change, not Infinity', () => {
  const btc = overviewView({ list: [BTC], candlesOf: () => candles(5, (i) => (i === 0 ? 0 : 1)), alerts: [], status: {} })[0];
  assert.equal(btc.changePct, null);
});

test('overviewView: the newest alert of each stream becomes its badge, matched on symbol and timeframe', () => {
  const alerts = [
    { at: 1, status: 'sent', meta: { ruleId: 'old', symbol: BTC.symbol, timeframe: '60', direction: 'down' } },
    { at: 2, status: 'sent', meta: { ruleId: 'other-tf', symbol: BTC.symbol, timeframe: '15', direction: 'up' } },
    { at: 3, status: 'digested', meta: { ruleId: 'new', symbol: BTC.symbol, timeframe: '60', direction: 'up' } },
    { at: 4, kind: 'health', status: 'sent' },
  ];
  const [btc, nvda] = overviewView({ list: LIST, candlesOf: () => [], alerts, status: {} });
  assert.deepEqual(btc.lastAlert, { at: 3, ruleId: 'new', direction: 'up', status: 'digested' });
  assert.equal(nvda.lastAlert, null);
});

test('overviewView: session open is shown for stocks only, from the market clock; crypto and an unknown clock give null', () => {
  const open = overviewView({ list: LIST, candlesOf: () => [], alerts: [], status: { usOpen: true } });
  assert.deepEqual([open[0].sessionOpen, open[1].sessionOpen], [null, true]);
  const unknown = overviewView({ list: LIST, candlesOf: () => [], alerts: [], status: {} });
  assert.equal(unknown[1].sessionOpen, null);
});

test('overviewView carries no candle key and no internal field', () => {
  const view = overviewView({ list: LIST, candlesOf: () => candles(3), alerts: [], status: {} });
  assert.deepEqual(Object.keys(view[0]).sort(), ['changePct', 'healthy', 'lastAlert', 'lastBarTime', 'market', 'price', 'sessionOpen', 'spark', 'symbol', 'timeframe']);
});

// ---------------------------------------------------------------- trending (B5)

test('trendingView: flat rows, newest first, with age and the watched stream when the symbol is one', () => {
  const now = 10_000_000;
  const view = trendingView({
    'crypto|gainers': { 'BINANCE:BTCUSDT': now - 60_000, 'BINANCE:DOGEUSDT': now - 5000 },
    'america|losers': { 'NASDAQ:NVDA': now - 120_000 },
  }, LIST, now);
  assert.deepEqual(view.map((r) => r.symbol), ['BINANCE:DOGEUSDT', 'BINANCE:BTCUSDT', 'NASDAQ:NVDA']);
  assert.deepEqual(view[0], { market: 'crypto', kind: 'gainers', symbol: 'BINANCE:DOGEUSDT', lastSeenAt: now - 5000, ageSeconds: 5, watched: null });
  assert.deepEqual(view[1].watched, { symbol: 'BINANCE:BTCUSDT', timeframe: '60' });
  assert.deepEqual(view[2].watched, { symbol: 'NASDAQ:NVDA', timeframe: 'D' });
});

test('trendingView: malformed buckets and timestamps are skipped, and the result is capped at 200', () => {
  const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`X:S${i}`, 1000 + i]));
  const view = trendingView({ 'crypto|gainers': many, 'nobar': { 'X:A': 1 }, 'a|b': { 'X:B': 'soon', 'X:C': NaN }, 'c|d': 'not an object' }, [], 5000);
  assert.equal(view.length, 200);
  assert.ok(view.every((r) => r.market === 'crypto'));
  assert.equal(trendingView(null, [], 0).length, 0);
  assert.equal(trendingView(undefined, [], 0).length, 0);
});

test('trendingView: a symbol seen in the future (clock stepped back) has age 0, never negative', () => {
  const view = trendingView({ 'crypto|gainers': { 'X:A': 9000 } }, [], 5000);
  assert.equal(view[0].ageSeconds, 0);
});

// ---------------------------------------------------------------- indicators (B3)

const RSI_RULE = { id: 'rsi14', type: 'rsi_cross', period: 14, levels: [30, 70] };
const BB_RULE = { id: 'bb20', type: 'bollinger_break', period: 20, stddev: 2 };
const now = Date.parse('2026-10-13T12:00:00Z');

test('indicatorsView: the RSI series is exactly what indicators.mjs gives, nulls dropped, with the rule\'s levels', () => {
  const c = candles(60);
  const [out] = indicatorsView({ rules: [RSI_RULE], stream: BTC, candles: c, nowMs: now, timezone: 'UTC' });
  const expected = rsi(c.map((x) => x.close), 14);
  assert.equal(out.ruleId, 'rsi14');
  assert.equal(out.type, 'rsi_cross');
  assert.deepEqual(out.levels, [30, 70]);
  assert.equal(out.series.length, 60 - 14);
  out.series.forEach((p) => {
    const i = (p.time - T0) / 3600;
    assert.equal(p.value, Number(expected[i].toFixed(4)));
  });
});

test('indicatorsView: Bollinger bands are exactly what indicators.mjs gives; defaults fill in a missing period', () => {
  const c = candles(60);
  const [out] = indicatorsView({ rules: [{ id: 'bb', type: 'bollinger_break' }], stream: BTC, candles: c, nowMs: now, timezone: 'UTC' });
  const expected = bollinger(c.map((x) => x.close), 20, 2);
  assert.equal(out.type, 'bollinger_break');
  assert.equal(out.period, 20);
  assert.equal(out.stddev, 2);
  assert.equal(out.upper.length, 60 - 19);
  const last = out.upper.at(-1);
  assert.equal(last.value, Number(expected.upper.at(-1).toFixed(4)));
  assert.equal(out.lower.at(-1).value, Number(expected.lower.at(-1).toFixed(4)));
  assert.equal(out.middle.at(-1).value, Number(expected.middle.at(-1).toFixed(4)));
});

test('indicatorsView: only rules that apply to this stream, are not expired and draw something', () => {
  const rules = [
    RSI_RULE,
    { ...BB_RULE, id: 'other-symbol', symbol: 'NASDAQ:NVDA' },
    { ...BB_RULE, id: 'other-tf', timeframes: ['15'] },
    { ...RSI_RULE, id: 'old', expires: '2020-01-01' },
    { id: 'lv', type: 'price_cross', level: 5 },
    { id: 'pct', type: 'pct_move', bars: 1, threshold_pct: 1 },
    { ...BB_RULE, id: 'mine', symbol: BTC.symbol, timeframes: ['60'] },
  ];
  const out = indicatorsView({ rules, stream: BTC, candles: candles(60), nowMs: now, timezone: 'UTC' });
  assert.deepEqual(out.map((o) => o.ruleId), ['rsi14', 'mine']);
});

test('indicatorsView: too few candles gives empty series, not an error', () => {
  const out = indicatorsView({ rules: [RSI_RULE, BB_RULE], stream: BTC, candles: candles(5), nowMs: now, timezone: 'UTC' });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].series, []);
  assert.deepEqual(out[1].upper, []);
});

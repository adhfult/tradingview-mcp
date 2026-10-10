import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules, normalizeRule, validateRuleParams, ruleApplies } from '../../lib/rules.mjs';

const STREAM = { symbol: 'BINANCE:BTCUSDT', timeframe: '60' };
const T0 = 1_700_000_000;

/** Builds closed-bar candles from a list of closes (open = previous close). */
function bars(closes, extra = {}) {
  return closes.map((close, i) => ({
    time: T0 + i * 3600,
    open: i === 0 ? close : closes[i - 1],
    high: Math.max(close, i === 0 ? close : closes[i - 1]) + 0.5,
    low: Math.min(close, i === 0 ? close : closes[i - 1]) - 0.5,
    close,
    volume: 10,
    ...(extra[i] ?? {}),
  }));
}

function run(rule, candles, stream = STREAM) {
  return evaluateRules([rule], stream, candles);
}

test('pct_move: a move of at least threshold_pct over N bars ago fires up', () => {
  // ref is 2 bars back (101), last is 106: +4.95%
  const hits = run({ id: 'm', type: 'pct_move', bars: 2, threshold_pct: 3 }, bars([100, 101, 102, 106]));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].direction, 'up');
  assert.equal(hits[0].ruleId, 'm');
  assert.equal(hits[0].barTime, T0 + 3 * 3600);
  assert.match(hits[0].message, /^Up 4\.95% over 2 bars$/);
});

test('pct_move: a drop of at least threshold_pct fires down', () => {
  const hits = run({ id: 'm', type: 'pct_move', bars: 2, threshold_pct: 3 }, bars([100, 101, 102, 96]));
  assert.equal(hits[0].direction, 'down');
});

test('pct_move: a smaller move does not fire', () => {
  assert.deepEqual(run({ id: 'm', type: 'pct_move', bars: 2, threshold_pct: 3 }, bars([100, 101, 102, 104])), []);
});

test('pct_move: not enough bars gives no hit', () => {
  assert.deepEqual(run({ id: 'm', type: 'pct_move', bars: 5, threshold_pct: 1 }, bars([100, 110])), []);
});

test('volume_spike: volume at least multiple x the prior average fires', () => {
  const candles = bars([1, 1, 1, 1], { 3: { volume: 35 } });
  const hits = run({ id: 'v', type: 'volume_spike', multiple: 3, lookback: 3 }, candles);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].values.avg_volume, 10);
});

test('volume_spike: the average uses only the prior bars, not the bar being tested', () => {
  // prior three bars average 10; the current bar's own 1000 must not raise the average
  const candles = bars([1, 1, 1, 1], { 3: { volume: 1000 } });
  assert.equal(run({ id: 'v', type: 'volume_spike', multiple: 3, lookback: 3 }, candles).length, 1);
});

test('volume_spike: below the multiple does not fire, and zero prior volume does not fire', () => {
  assert.deepEqual(run({ id: 'v', type: 'volume_spike', multiple: 3, lookback: 3 },
    bars([1, 1, 1, 1], { 3: { volume: 25 } })), []);
  assert.deepEqual(run({ id: 'v', type: 'volume_spike', multiple: 3, lookback: 3 },
    bars([1, 1, 1, 1], { 0: { volume: 0 }, 1: { volume: 0 }, 2: { volume: 0 }, 3: { volume: 50 } })), []);
});

test('volume_spike: direction follows the closed bar candle colour', () => {
  const up = run({ id: 'v', type: 'volume_spike', multiple: 2, lookback: 2 },
    bars([1, 1, 1], { 2: { volume: 40, open: 1, close: 2 } }));
  const down = run({ id: 'v', type: 'volume_spike', multiple: 2, lookback: 2 },
    bars([1, 1, 1], { 2: { volume: 40, open: 2, close: 1 } }));
  assert.equal(up[0].direction, 'up');
  assert.equal(down[0].direction, 'down');
});

test('rsi_cross: RSI rising through a level fires up (period 2, hand-checked values 66.67 then 85.71)', () => {
  // RSI(2): index 2 = 66.67, index 3 = 85.71, so level 80 is crossed upward
  const hits = run({ id: 'r', type: 'rsi_cross', period: 2, levels: [80] }, bars([10, 12, 11, 13]));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].direction, 'up');
  assert.deepEqual(hits[0].values.levels, [80]);
});

test('rsi_cross: a level the RSI does not cross does not fire', () => {
  assert.deepEqual(run({ id: 'r', type: 'rsi_cross', period: 2, levels: [90] }, bars([10, 12, 11, 13])), []);
  // 66.67 -> 85.71 does not cross 60 (both above it)
  assert.deepEqual(run({ id: 'r', type: 'rsi_cross', period: 2, levels: [60] }, bars([10, 12, 11, 13])), []);
});

test('rsi_cross: falling through two levels in one bar reports both, direction down', () => {
  // RSI 85.71 -> 40.00 crosses 80 and 60 downward
  const hits = run({ id: 'r', type: 'rsi_cross', period: 2, levels: [60, 80] }, bars([10, 12, 11, 13, 11]));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].direction, 'down');
  assert.deepEqual(hits[0].values.levels, [60, 80]);
});

test('rsi_cross: too few bars gives no hit', () => {
  assert.deepEqual(run({ id: 'r', type: 'rsi_cross', period: 14, levels: [30] }, bars([1, 2, 3])), []);
});

test('bollinger_break: a close above the upper band fires up, below the lower band fires down', () => {
  const up = run({ id: 'b', type: 'bollinger_break', period: 3, stddev: 1 }, bars([10, 10, 10, 30]));
  assert.equal(up[0].direction, 'up');
  const down = run({ id: 'b', type: 'bollinger_break', period: 3, stddev: 1 }, bars([30, 30, 30, 10]));
  assert.equal(down[0].direction, 'down');
});

test('bollinger_break: a flat series stays inside the bands', () => {
  assert.deepEqual(run({ id: 'b', type: 'bollinger_break', period: 3, stddev: 1 }, bars([10, 10, 10, 10])), []);
});

test('bollinger_break: not enough bars gives no hit', () => {
  assert.deepEqual(run({ id: 'b', type: 'bollinger_break', period: 20, stddev: 2 }, bars([1, 2])), []);
});

test('new_extreme: a close above the prior high fires up, and the tested bar is excluded from the window', () => {
  const candles = bars([5, 5, 5, 8], { 2: { high: 7 }, 1: { high: 6 }, 0: { high: 5 }, 3: { high: 100 } });
  const hits = run({ id: 'n', type: 'new_extreme', lookback: 3 }, candles);
  assert.equal(hits[0].direction, 'up');
  assert.equal(hits[0].values.prior_high, 7);
});

test('new_extreme: the current bar high alone (close not above the prior high) does not fire', () => {
  // prior highs are 5.5 (helper adds 0.5), so a close of 5.2 is not a new high
  const candles = bars([5, 5, 5, 5.2], { 3: { high: 100 } });
  assert.deepEqual(run({ id: 'n', type: 'new_extreme', lookback: 3 }, candles), []);
});

test('new_extreme: a close below the prior low fires down', () => {
  const candles = bars([5, 5, 5, 1], { 0: { low: 3 }, 1: { low: 4 }, 2: { low: 2 } });
  assert.equal(run({ id: 'n', type: 'new_extreme', lookback: 3 }, candles)[0].direction, 'down');
});

test('new_extreme: not enough bars gives no hit', () => {
  assert.deepEqual(run({ id: 'n', type: 'new_extreme', lookback: 50 }, bars([1, 2, 3])), []);
});

test('price_cross: previous close below the level and close at or above it fires up', () => {
  assert.equal(run({ id: 'p', type: 'price_cross', level: 100 }, bars([99, 101]))[0].direction, 'up');
  // a close exactly on the level counts as "at or above"
  assert.equal(run({ id: 'p', type: 'price_cross', level: 100 }, bars([99.9, 100]))[0].direction, 'up');
});

test('price_cross: the reverse fires down, and touching from above does not', () => {
  assert.equal(run({ id: 'p', type: 'price_cross', level: 100 }, bars([101, 99]))[0].direction, 'down');
  // previous close exactly on the level is not below it, so no up cross
  assert.deepEqual(run({ id: 'p', type: 'price_cross', level: 100 }, bars([100, 101])), []);
});

test('price_cross: a single bar gives no hit', () => {
  assert.deepEqual(run({ id: 'p', type: 'price_cross', level: 100 }, bars([101])), []);
});

test('a rule with symbol only applies to that symbol', () => {
  const rule = { id: 'p', type: 'price_cross', level: 100, symbol: 'NASDAQ:NVDA' };
  assert.deepEqual(run(rule, bars([99, 101])), []);
  assert.equal(run(rule, bars([99, 101]), { symbol: 'NASDAQ:NVDA', timeframe: 'D' }).length, 1);
});

test('a rule with timeframes only applies to those timeframes', () => {
  const rule = { id: 'p', type: 'price_cross', level: 100, timeframes: ['15', 'D'] };
  assert.equal(ruleApplies(rule, { symbol: 'X', timeframe: '15' }), true);
  assert.equal(ruleApplies(rule, { symbol: 'X', timeframe: '60' }), false);
  assert.deepEqual(run(rule, bars([99, 101])), []);
});

test('evaluateRules returns one hit per matching rule and skips unknown types', () => {
  const rules = [
    { id: 'p', type: 'price_cross', level: 100 },
    { id: 'x', type: 'not_a_rule', level: 100 },
    { id: 'q', type: 'price_cross', level: 101 },
  ];
  const hits = evaluateRules(rules, STREAM, bars([99, 101]));
  assert.deepEqual(hits.map((h) => h.ruleId), ['p', 'q']);
  assert.equal(hits[0].symbol, STREAM.symbol);
  assert.equal(hits[0].timeframe, STREAM.timeframe);
});

test('evaluateRules with no candles gives no hits', () => {
  assert.deepEqual(evaluateRules([{ id: 'p', type: 'price_cross', level: 1 }], STREAM, []), []);
});

test('normalizeRule fills in documented defaults without changing given values', () => {
  const rule = normalizeRule({ id: 'r', type: 'rsi_cross' });
  assert.equal(rule.period, 14);
  assert.deepEqual(rule.levels, [30, 70]);
  assert.equal(normalizeRule({ id: 'r', type: 'bollinger_break', period: 5 }).period, 5);
  assert.equal(normalizeRule({ id: 'n', type: 'new_extreme' }).lookback, 50);
});

test('validateRuleParams reports missing required parameters and out-of-range values', () => {
  assert.deepEqual(validateRuleParams({ id: 'p', type: 'price_cross', level: 5 }, 'r[0]'), []);
  assert.deepEqual(validateRuleParams({ id: 'p', type: 'price_cross' }, 'r[0]'), ['r[0].level: is required']);
  assert.deepEqual(validateRuleParams({ id: 'm', type: 'pct_move', bars: 2.5, threshold_pct: 1 }, 'r[0]'),
    ['r[0].bars: must be an integer']);
  assert.deepEqual(validateRuleParams({ id: 'v', type: 'volume_spike', multiple: 0, lookback: 3 }, 'r[0]'),
    ['r[0].multiple: must be greater than 0']);
});

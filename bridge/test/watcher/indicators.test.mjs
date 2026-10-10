import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sma, ema, rsi, bollinger, atr } from '../../lib/indicators.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'indicators.json'), 'utf8'));
const { inputs, outputs } = fixture;
const TOLERANCE = 1e-9;

function assertSeries(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i] === null) {
      assert.equal(actual[i], null, `${label}[${i}] should be null`);
    } else {
      assert.notEqual(actual[i], null, `${label}[${i}] should not be null`);
      assert.ok(
        Math.abs(actual[i] - expected[i]) <= TOLERANCE,
        `${label}[${i}]: ${actual[i]} vs ${expected[i]}`,
      );
    }
  }
}

test('fixture holds 300 bars with consistent lengths', () => {
  assert.equal(fixture.bars, 300);
  for (const key of ['open', 'high', 'low', 'close', 'volume']) {
    assert.equal(inputs[key].length, 300, key);
  }
});

test('sma matches the Python fixture within 1e-9, nulls in the same places', () => {
  assertSeries(sma(inputs.close, 5), outputs.sma['5'], 'sma5');
  assertSeries(sma(inputs.close, 20), outputs.sma['20'], 'sma20');
});

test('ema matches the Python fixture within 1e-9', () => {
  assertSeries(ema(inputs.close, 9), outputs.ema['9'], 'ema9');
  assertSeries(ema(inputs.close, 21), outputs.ema['21'], 'ema21');
});

test('rsi (Wilder) matches the Python fixture within 1e-9', () => {
  assertSeries(rsi(inputs.close, 14), outputs.rsi['14'], 'rsi14');
});

test('bollinger matches the Python fixture within 1e-9 for upper, middle and lower', () => {
  const bands = bollinger(inputs.close, 20, 2);
  assertSeries(bands.upper, outputs.bollinger['20_2'].upper, 'bb upper');
  assertSeries(bands.middle, outputs.bollinger['20_2'].middle, 'bb middle');
  assertSeries(bands.lower, outputs.bollinger['20_2'].lower, 'bb lower');
});

test('atr matches the Python fixture within 1e-9', () => {
  assertSeries(atr(inputs.high, inputs.low, inputs.close, 14), outputs.atr['14'], 'atr14');
});

test('sma: first period-1 values are null, then the mean', () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
});

test('ema: seeded with the SMA at index period-1', () => {
  const out = ema([2, 4, 6, 8], 2);
  assert.equal(out[0], null);
  assert.equal(out[1], 3);
  // k = 2/3: 8 * 2/3 + 3 * 1/3
  assert.ok(Math.abs(out[3] - (8 * (2 / 3) + out[2] * (1 / 3))) < 1e-12);
});

test('rsi: a monotonically rising series has zero average loss and reads 100', () => {
  const out = rsi([1, 2, 3, 4, 5, 6], 3);
  assert.deepEqual(out.slice(0, 3), [null, null, null]);
  assert.equal(out[3], 100);
  assert.equal(out[5], 100);
});

test('rsi: too few bars gives all nulls', () => {
  assert.deepEqual(rsi([1, 2, 3], 3), [null, null, null]);
});

test('bollinger uses the population standard deviation', () => {
  // window [1, 3]: mean 2, population std 1 (sample std would be ~1.414)
  const bands = bollinger([1, 3], 2, 1);
  assert.equal(bands.middle[1], 2);
  assert.equal(bands.upper[1], 3);
  assert.equal(bands.lower[1], 1);
});

test('atr: TR seeds at index period, first value is null', () => {
  const out = atr([10, 11, 12], [9, 10, 11], [9.5, 10.5, 11.5], 2);
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  // TR at index 1 and 2 are both 1.5, so the seed is 1.5
  assert.equal(out[2], 1.5);
});

test('atr: fewer than period+1 bars gives all nulls', () => {
  assert.deepEqual(atr([1], [1], [1], 14), [null]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../lib/validate.mjs';
import { BridgeValidationError } from '../lib/errors.mjs';

const rejects = (fn) => {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof BridgeValidationError);
    assert.equal(err.bridgeCode, 'INVALID_PARAMETER');
    return true;
  });
};

test('symbol upper-cases and accepts exchange-qualified and futures symbols', () => {
  assert.equal(v.symbol('binance:btcusdt'), 'BINANCE:BTCUSDT');
  assert.equal(v.symbol('CME_MINI:ES1!'), 'CME_MINI:ES1!');
  assert.equal(v.symbol('BRK.B'), 'BRK.B');
  rejects(() => v.symbol('bad symbol!'));
  rejects(() => v.symbol(''));
  rejects(() => v.symbol('A'.repeat(41)));
  rejects(() => v.symbol(123));
});

test('timeframe accepts only the listed values', () => {
  for (const tf of ['1', '60', '240', 'D', 'W', 'M', '1D', '1W', '1M']) {
    assert.equal(v.timeframe(tf), tf);
  }
  rejects(() => v.timeframe('7'));
  rejects(() => v.timeframe('1d'));
  rejects(() => v.timeframe(60));
});

test('integer enforces safe integers and the range', () => {
  assert.equal(v.integer(5, 'n', { min: 1, max: 10 }), 5);
  rejects(() => v.integer(0, 'n', { min: 1, max: 10 }));
  rejects(() => v.integer(11, 'n', { min: 1, max: 10 }));
  rejects(() => v.integer(1.5, 'n', { min: 1, max: 10 }));
  rejects(() => v.integer('5', 'n', { min: 1, max: 10 }));
});

test('array and string enforce their length bounds', () => {
  assert.deepEqual(v.array([1], 'a', { min: 1, max: 2 }), [1]);
  rejects(() => v.array([], 'a', { min: 1, max: 2 }));
  rejects(() => v.array([1, 2, 3], 'a', { min: 1, max: 2 }));
  rejects(() => v.array('x', 'a', { min: 1, max: 2 }));
  assert.equal(v.string('abc', 's', { min: 1, max: 3 }), 'abc');
  rejects(() => v.string('', 's', { min: 1, max: 3 }));
  rejects(() => v.string('abcd', 's', { min: 1, max: 3 }));
});

test('plainObject accepts only JSON-style objects', () => {
  assert.deepEqual(v.plainObject({ a: 1 }, 'o'), { a: 1 });
  assert.deepEqual(v.plainObject(Object.create(null), 'o'), Object.create(null));
  rejects(() => v.plainObject([], 'o'));
  rejects(() => v.plainObject(null, 'o'));
  rejects(() => v.plainObject(new Map(), 'o'));
  rejects(() => v.plainObject('x', 'o'));
});

test('range requires 0 <= from < to <= 200', () => {
  assert.deepEqual(v.range([0, 50]), [0, 50]);
  rejects(() => v.range([5, 5]));
  rejects(() => v.range([-1, 5]));
  rejects(() => v.range([0, 201]));
  rejects(() => v.range([0]));
});

test('timeoutMs defaults to 15000 and clamps to 1000..60000', () => {
  assert.equal(v.timeoutMs(undefined), 15000);
  assert.equal(v.timeoutMs(null), 15000);
  assert.equal(v.timeoutMs(5), 1000);
  assert.equal(v.timeoutMs(999999), 60000);
  assert.equal(v.timeoutMs(2500.4), 2500);
  rejects(() => v.timeoutMs('2000'));
  rejects(() => v.timeoutMs(Number.NaN));
});

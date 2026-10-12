import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGauntletReport, parsePaperJournal, TIMEFRAME_BY_INTERVAL, PAPER_EVENT_LIMIT } from '../../lib/journals.mjs';

const FP = 'a'.repeat(64);

/** The shape gauntlet_service.py writes, with fields the dashboard must NOT serve (params, reason, numbers). */
function report(overrides = {}) {
  return {
    fingerprint: FP,
    created_utc: '2026-10-12T09:30:00+00:00',
    inputs: {
      symbol: 'BTC-USD', tv_symbol: 'BINANCE:BTCUSDT', data_source: 'tradingview',
      strategy: 'triple_ema', params: { fast: 8, slow: 21 }, interval: '1h', period: '2y',
    },
    gates: [
      { gate: 'edge', status: 'PASS', reason: 'stated edge present', numbers: { trades: 120 } },
      { gate: 'walk_forward', status: 'FAIL', reason: 'unstable', numbers: { folds: 5 } },
      { gate: 'costs', status: 'SKIPPED', reason: 'earlier gate failed', numbers: {} },
    ],
    verdict: 'FAIL: walk_forward',
    ...overrides,
  };
}
const text = (value) => JSON.stringify(value);

test('a gauntlet report becomes a whitelisted summary: no params, reasons or numbers', () => {
  assert.deepEqual(parseGauntletReport(text(report()), { fileFingerprint: FP }), {
    fingerprint: FP,
    created_utc: '2026-10-12T09:30:00+00:00',
    strategy: 'triple_ema',
    symbol: 'BINANCE:BTCUSDT',
    interval: '1h',
    timeframe: '60',
    verdict: 'FAIL: walk_forward',
    gates: [
      { gate: 'edge', status: 'PASS' },
      { gate: 'walk_forward', status: 'FAIL' },
      { gate: 'costs', status: 'SKIPPED' },
    ],
  });
});

test('without a tv_symbol the plain symbol is used', () => {
  const r = report();
  r.inputs.tv_symbol = null;
  assert.equal(parseGauntletReport(text(r), { fileFingerprint: FP }).symbol, 'BTC-USD');
});

test('intervals map to stream timeframe codes; an unknown interval keeps the report with timeframe null', () => {
  assert.deepEqual(TIMEFRAME_BY_INTERVAL, { '15m': '15', '1h': '60', '4h': '240', '1d': 'D' });
  for (const [interval, code] of Object.entries(TIMEFRAME_BY_INTERVAL)) {
    const r = report();
    r.inputs.interval = interval;
    assert.equal(parseGauntletReport(text(r), { fileFingerprint: FP }).timeframe, code);
  }
  const odd = report();
  odd.inputs.interval = '7m';
  const parsed = parseGauntletReport(text(odd), { fileFingerprint: FP });
  assert.equal(parsed.interval, '7m');
  assert.equal(parsed.timeframe, null);
});

test('a gauntlet report that is not valid is null, never an exception', () => {
  const ok = (r) => parseGauntletReport(typeof r === 'string' ? r : text(r), { fileFingerprint: FP });
  assert.equal(ok('not json'), null);
  assert.equal(ok(''), null);
  assert.equal(ok('[]'), null);
  assert.equal(ok('null'), null);
  assert.equal(ok('5'), null);
  assert.equal(ok(report({ inputs: undefined })), null);
  assert.equal(ok(report({ inputs: [] })), null);
  assert.equal(ok(report({ gates: 'x' })), null);
  assert.equal(ok(report({ gates: undefined })), null);
  assert.equal(ok(report({ verdict: 5 })), null);
  assert.equal(ok(report({ created_utc: 5 })), null);
  const noStrategy = report();
  noStrategy.inputs.strategy = 7;
  assert.equal(ok(noStrategy), null);
  assert.equal(parseGauntletReport(undefined, { fileFingerprint: FP }), null);
  assert.equal(parseGauntletReport(Buffer.from('x'), { fileFingerprint: FP }), null);
});

test('the report must carry the fingerprint of its own file name, and that must be 64 lowercase hex', () => {
  assert.equal(parseGauntletReport(text(report()), { fileFingerprint: 'b'.repeat(64) }), null);
  assert.equal(parseGauntletReport(text(report({ fingerprint: undefined })), { fileFingerprint: FP }), null);
  const upper = 'A'.repeat(64);
  assert.equal(parseGauntletReport(text(report({ fingerprint: upper })), { fileFingerprint: upper }), null);
  assert.equal(parseGauntletReport(text(report()), {}), null);
  assert.equal(parseGauntletReport(text(report())), null);
});

test('long strings are cut and long gate lists are capped, so one hostile file cannot flood the page', () => {
  const r = report({ verdict: `PASS ${'x'.repeat(500)}` });
  r.inputs.strategy = 's'.repeat(500);
  r.gates = Array.from({ length: 50 }, (_, i) => ({ gate: `g${i}${'y'.repeat(200)}`, status: 'PASS' }));
  const parsed = parseGauntletReport(text(r), { fileFingerprint: FP });
  assert.equal(parsed.verdict.length, 200);
  assert.equal(parsed.strategy.length, 200);
  assert.equal(parsed.gates.length, 20);
  assert.ok(parsed.gates.every((g) => g.gate.length <= 64 && g.status.length <= 64));
});

test('malformed gates are skipped, the rest are kept', () => {
  const r = report();
  r.gates = [null, 'x', { gate: 'a' }, { gate: 'edge', status: 'PASS' }, { gate: 5, status: 'PASS' }, []];
  assert.deepEqual(parseGauntletReport(text(r), { fileFingerprint: FP }).gates, [{ gate: 'edge', status: 'PASS' }]);
});

test('a __proto__ key in a report or a gate pollutes nothing and is not copied', () => {
  const raw = `{"__proto__":{"polluted":1},"fingerprint":"${FP}","created_utc":"t","verdict":"PASS",`
    + '"inputs":{"strategy":"s","symbol":"X","interval":"1h","__proto__":{"polluted":2}},'
    + '"gates":[{"gate":"edge","status":"PASS","__proto__":{"polluted":3}}]}';
  const parsed = parseGauntletReport(raw, { fileFingerprint: FP });
  assert.equal({}.polluted, undefined);
  assert.equal(parsed.gates[0].polluted, undefined);
  assert.deepEqual(Object.keys(parsed).sort(), ['created_utc', 'fingerprint', 'gates', 'interval', 'strategy', 'symbol', 'timeframe', 'verdict']);
});

const lines = (...events) => `${events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n')}\n`;

test('a paper journal keeps start, entry, exit and summary events with whitelisted fields, in file order', () => {
  const journal = lines(
    { ts: '2026-10-12T10:00:00+00:00', type: 'start', bar_time: 1_760_000_000 },
    { ts: '2026-10-12T11:00:00+00:00', type: 'entry', price: 63000.5, bar_time: 1_760_003_600, secret: 'no' },
    { ts: '2026-10-12T14:00:00+00:00', type: 'exit', price: 63900, bar_time: 1_760_014_400, return_pct: 1.43, week: '2026-W41' },
    { ts: '2026-10-19T08:00:00+00:00', type: 'summary', week: '2026-W42' },
  );
  assert.deepEqual(parsePaperJournal(journal), [
    { ts: '2026-10-12T10:00:00+00:00', type: 'start', price: null, bar_time: 1_760_000_000, return_pct: null },
    { ts: '2026-10-12T11:00:00+00:00', type: 'entry', price: 63000.5, bar_time: 1_760_003_600, return_pct: null },
    { ts: '2026-10-12T14:00:00+00:00', type: 'exit', price: 63900, bar_time: 1_760_014_400, return_pct: 1.43 },
    { ts: '2026-10-19T08:00:00+00:00', type: 'summary', price: null, bar_time: null, return_pct: null },
  ]);
});

test('damaged, blank, non-object and unknown-type lines are skipped; CRLF is fine', () => {
  const journal = [
    '{"ts":"t1","type":"entry","price":1,"bar_time":10}',
    '', '   ', 'garbage {', '[1,2]', '5', 'null', '"text"',
    '{"ts":"t2","type":"teleport","price":2,"bar_time":20}',
    '{"ts":"t3","type":"exit","price":3,"bar_time":30,"return_pct":2}',
  ].join('\r\n');
  assert.deepEqual(parsePaperJournal(journal).map((e) => e.ts), ['t1', 't3']);
});

test('numbers must be finite numbers: strings, objects and null become null', () => {
  const [e] = parsePaperJournal(lines({ ts: 't', type: 'exit', price: '100', bar_time: { a: 1 }, return_pct: null }));
  assert.deepEqual(e, { ts: 't', type: 'exit', price: null, bar_time: null, return_pct: null });
  const [n] = parsePaperJournal(lines({ ts: 5, type: 'entry', price: 1e999, bar_time: 5 }));
  assert.equal(n.ts, null);
  assert.equal(n.price, null, '1e999 parses to Infinity, which is not served');
});

test('only the last PAPER_EVENT_LIMIT (50) events are kept', () => {
  assert.equal(PAPER_EVENT_LIMIT, 50);
  const many = Array.from({ length: 60 }, (_, i) => ({ ts: `t${i}`, type: 'entry', price: i, bar_time: i }));
  const kept = parsePaperJournal(lines(...many));
  assert.equal(kept.length, 50);
  assert.equal(kept[0].ts, 't10');
  assert.equal(kept.at(-1).ts, 't59');
  assert.equal(parsePaperJournal(lines(...many), { limit: 3 }).length, 3);
});

test('empty or non-string journal text gives an empty list, never an exception', () => {
  assert.deepEqual(parsePaperJournal(''), []);
  assert.deepEqual(parsePaperJournal(undefined), []);
  assert.deepEqual(parsePaperJournal(null), []);
  assert.deepEqual(parsePaperJournal(Buffer.from('x')), []);
});

test('a __proto__ key in a journal line is not copied and pollutes nothing', () => {
  const [e] = parsePaperJournal('{"__proto__":{"polluted":1},"ts":"t","type":"entry","price":1,"bar_time":2}\n');
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(e), ['ts', 'type', 'price', 'bar_time', 'return_pct']);
});

test('a very long string field is cut to 200 characters', () => {
  const [e] = parsePaperJournal(lines({ ts: 'z'.repeat(1000), type: 'entry', price: 1, bar_time: 1 }));
  assert.equal(e.ts.length, 200);
});

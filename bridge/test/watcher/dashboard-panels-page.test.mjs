import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertDetailRows, countByRuleDay, deepLink, filterAlerts, formatDuration, formatPct, newNoteLink, paperEquity, parseDeepLink, sparkPoints, tabTitle } from '../../dashboard/pure.mjs';

const DAY = 86_400_000;
const D0 = Date.UTC(2026, 9, 12, 10, 0, 0);
const alert = (extra) => ({
  at: D0, kind: 'rule', level: 'up', title: 't', status: 'sent', ruleId: 'r1', symbol: 'BINANCE:BTCUSDT', timeframe: '60', barTime: 1_760_000_000, direction: 'up', message: 'm', values: null, ...extra,
});

// ---------------------------------------------------------------- B8: alerts tab

test('filterAlerts: empty filters keep everything; each filter narrows on equality; the input is not changed', () => {
  const list = [alert({}), alert({ ruleId: 'r2' }), alert({ symbol: 'NASDAQ:NVDA', status: 'held' }), alert({ ruleId: null, symbol: null, kind: 'health' })];
  const copy = JSON.stringify(list);
  assert.equal(filterAlerts(list, { ruleId: '', symbol: '', status: '' }).length, 4);
  assert.deepEqual(filterAlerts(list, { ruleId: 'r2', symbol: '', status: '' }).map((a) => a.ruleId), ['r2']);
  assert.equal(filterAlerts(list, { ruleId: '', symbol: 'NASDAQ:NVDA', status: '' }).length, 1);
  assert.equal(filterAlerts(list, { ruleId: '', symbol: '', status: 'held' }).length, 1);
  assert.equal(filterAlerts(list, { ruleId: 'r1', symbol: 'BINANCE:BTCUSDT', status: 'sent' }).length, 1);
  assert.equal(filterAlerts(list, { ruleId: 'nope', symbol: '', status: '' }).length, 0);
  assert.equal(JSON.stringify(list), copy);
});

test('countByRuleDay: one row per rule per UTC day, newest day first, alerts with no rule counted under "(no rule)"', () => {
  const rows = countByRuleDay([
    alert({ at: D0 }), alert({ at: D0 + 1000 }), alert({ at: D0 + DAY, ruleId: 'r2' }), alert({ at: D0, ruleId: null }), alert({ at: D0 - DAY }),
  ]);
  assert.deepEqual(rows, [
    { day: '2026-10-13', ruleId: 'r2', count: 1 },
    { day: '2026-10-12', ruleId: '(no rule)', count: 1 },
    { day: '2026-10-12', ruleId: 'r1', count: 2 },
    { day: '2026-10-11', ruleId: 'r1', count: 1 },
  ]);
  assert.deepEqual(countByRuleDay([]), []);
});

// ---------------------------------------------------------------- B4: alert detail

test('alertDetailRows: label and text pairs only, with the values table flattened', () => {
  const rows = alertDetailRows(alert({ values: { rsi: 71.2, levels: [70, 80], note: null }, message: 'RSI rose through 70' }));
  const as = Object.fromEntries(rows);
  assert.equal(as.Rule, 'r1');
  assert.equal(as.Direction, 'up');
  assert.equal(as.Message, 'RSI rose through 70');
  assert.equal(as.Status, 'sent');
  assert.equal(as.Symbol, 'BINANCE:BTCUSDT 1h');
  assert.equal(as['rsi'], '71.2');
  assert.equal(as['levels'], '70, 80');
  assert.equal(as['note'], 'n/a');
  assert.ok(rows.every((r) => r.length === 2 && typeof r[0] === 'string' && typeof r[1] === 'string'));
});

test('alertDetailRows: an alert recorded before meta existed still gives rows, and a hostile values table is capped', () => {
  const old = alertDetailRows({ at: D0, kind: 'health', level: 'down', title: 'stream down', status: 'sent', ruleId: null, symbol: null, timeframe: null, barTime: null, direction: null, message: null, values: null });
  assert.ok(old.length >= 2);
  assert.equal(Object.fromEntries(old).Rule, '—');
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, 'x'.repeat(5000)]));
  const rows = alertDetailRows(alert({ values: many }));
  assert.ok(rows.length <= 30, `${rows.length} rows`);
  assert.ok(rows.every(([, v]) => v.length <= 200));
});

test('deepLink builds the query the page reads back with parseDeepLink', () => {
  const q = deepLink('BINANCE:BTCUSDT', '60', 1_760_000_000);
  assert.deepEqual(parseDeepLink(q), { symbol: 'BINANCE:BTCUSDT', timeframe: '60', t: 1_760_000_000 });
  assert.deepEqual(parseDeepLink(deepLink('A&B=C#D', 'D')), { symbol: 'A&B=C#D', timeframe: 'D', t: null });
  assert.ok(q.startsWith('?'));
});

// ---------------------------------------------------------------- B10: tab title

test('tabTitle: a count in brackets when alerts arrived while hidden, the plain name otherwise', () => {
  assert.equal(tabTitle('Market watch', 0), 'Market watch');
  assert.equal(tabTitle('Market watch', 2), '(2) Market watch');
  assert.equal(tabTitle('Market watch', 150), '(99+) Market watch');
  assert.equal(tabTitle('Market watch', -1), 'Market watch');
});

// ---------------------------------------------------------------- B11: realised paper equity

const exit = (return_pct, bar_time) => ({ type: 'exit', return_pct, bar_time, price: 1, ts: null });

test('paperEquity: compounds the realised exits in order and says how many trades', () => {
  const out = paperEquity([{ type: 'start', bar_time: 1, return_pct: null }, { type: 'entry', bar_time: 2, return_pct: null }, exit(10, 3), exit(-10, 5), { type: 'summary', return_pct: 99, bar_time: 9 }]);
  assert.equal(out.trades, 2);
  assert.deepEqual(out.points, [{ time: 3, value: 10 }, { time: 5, value: -1 }]);
  assert.equal(out.totalPct, -1);
});

test('paperEquity: no exits gives no points and a null total; unusable exits are skipped; a loss of 100% or more stops at -100', () => {
  assert.deepEqual(paperEquity([]), { points: [], totalPct: null, trades: 0 });
  assert.equal(paperEquity([exit(null, 3), exit(Number.NaN, 4), exit(5, null)]).trades, 0);
  const wiped = paperEquity([exit(-150, 3), exit(50, 4)]);
  assert.deepEqual(wiped.points.map((p) => p.value), [-100, -100]);
});

// ---------------------------------------------------------------- sparklines (B1, B11)

test('sparkPoints: the lowest value sits at the bottom, the highest at the top, spread evenly across the width', () => {
  assert.equal(sparkPoints([1, 3, 2], 100, 20), '0,20 50,0 100,10');
  assert.equal(sparkPoints([5, 5, 5], 100, 20), '0,10 50,10 100,10', 'a flat line is drawn in the middle');
  assert.equal(sparkPoints([4], 100, 20), '0,10 100,10', 'one value is a flat line, not nothing');
});

test('sparkPoints: no values, or only unusable ones, give an empty string', () => {
  assert.equal(sparkPoints([], 100, 20), '');
  assert.equal(sparkPoints([null, Number.NaN, Infinity], 100, 20), '');
  assert.equal(sparkPoints([1, null, 3], 100, 20), '0,20 100,0', 'unusable values are skipped');
});

// ---------------------------------------------------------------- index.html: tabs, alerts tab, drawer, paper, PNG button

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const html = () => readFile(fileURLToPath(new URL('../../dashboard/index.html', import.meta.url)), 'utf8');
const idsOf = (text) => new Set([...text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

test('index.html: the ids the P4 modules use are there, once each', async () => {
  const text = await html();
  const ids = [...text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate id');
  for (const id of ['tabs', 'save-png', 'alerts-all-status', 'alerts-all-list', 'filter-rule', 'filter-symbol', 'filter-status', 'alert-counts',
    'alert-detail', 'detail-title', 'detail-rows', 'detail-status', 'copy-link', 'detail-note', 'detail-close', 'paper-status', 'paper-list',
    'overview-status', 'overview-list', 'trending-status', 'trending-list', 'health-status', 'health-summary', 'health-streams', 'market-badge', 'login-badge']) {
    assert.ok(idsOf(text).has(id), id);
  }
});

test('index.html: a tab button for each view, and every section belongs to a view', async () => {
  const text = await html();
  const tabs = [...text.matchAll(/<button\b[^>]*\sdata-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['overview', 'chart', 'alerts', 'opportunities', 'status']);
  const sections = [...text.matchAll(/<section\b([^>]*)>/g)].map((m) => m[1]);
  for (const attrs of sections) {
    const view = /\sdata-view="([^"]+)"/.exec(attrs)?.[1];
    assert.ok(tabs.includes(view), `section ${attrs.trim()} has a known data-view`);
  }
  assert.match(text, /<nav\b[^>]*\sid="tabs"[^>]*\saria-label="/, 'the tab bar is a labelled landmark');
  assert.match(text, /data-tab="overview"[^>]*aria-current="page"/, 'the landing tab is current from the start');
});

test('index.html: the detail drawer has no href until the page sets one, and is hidden at first', async () => {
  const text = await html();
  assert.doesNotMatch(text, /<a\b[^>]*\sid="detail-note"[^>]*\shref=/);
  assert.match(text, /<aside\b[^>]*\sid="alert-detail"[^>]*\shidden/);
  assert.match(text, /<aside\b[^>]*\sid="alert-detail"[^>]*aria-labelledby="detail-title"/);
});

test('index.html: filters have labels, and every select in the page is labelled', async () => {
  const text = await html();
  for (const id of ['filter-rule', 'filter-symbol', 'filter-status']) assert.match(text, new RegExp(`<label[^>]*for="${id}"`), id);
});

// ---------------------------------------------------------------- P4 step 4: overview, health, opportunities

test('formatDuration: the two largest units, seconds for under a minute, a dash for nonsense', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(59), '59s');
  assert.equal(formatDuration(60), '1m');
  assert.equal(formatDuration(3600), '1h');
  assert.equal(formatDuration(3 * 3600 + 12 * 60 + 40), '3h 12m');
  assert.equal(formatDuration(90_061), '1d 1h');
  assert.equal(formatDuration(-5), '—');
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(Number.NaN), '—');
});

test('formatPct: a sign, two decimals and a percent sign; a dash for no value', () => {
  assert.equal(formatPct(1.234), '+1.23%');
  assert.equal(formatPct(-0.5), '-0.50%');
  assert.equal(formatPct(0), '0.00%');
  assert.equal(formatPct(null), '—');
});

test('newNoteLink: an opportunity note for a symbol with no timeframe has its own kind and no double space in the name', () => {
  const url = newNoteLink({ vault: 'V', folder: 'markets', symbol: 'BINANCE:PEPEUSDT', timeframe: null, time: 1_760_000_000, kind: 'opportunity' });
  const q = new URL(url).searchParams;
  assert.equal(q.get('file'), 'markets/BINANCE-PEPEUSDT 2025-10-09 0853');
  assert.match(q.get('content'), /kind: opportunity/);
  assert.match(q.get('content'), /symbols: \["BINANCE:PEPEUSDT"\]/);
  assert.doesNotMatch(q.get('content'), /# BINANCE:PEPEUSDT {2}/);
});

test('newNoteLink: the kind defaults to note, as before', () => {
  const url = newNoteLink({ vault: 'V', folder: 'f', symbol: 'X:Y', timeframe: '60', time: 1_760_000_000 });
  assert.match(new URL(url).searchParams.get('content'), /kind: note/);
});

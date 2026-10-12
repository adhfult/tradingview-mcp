import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard, MAX_SSE_CLIENTS, COALESCE_MS, HEARTBEAT_MS } from '../../lib/dashboard.mjs';
import { createFakeClock } from './support.mjs';

const TOKEN = 'a-long-enough-token-1234567890';
const FP = 'a'.repeat(64);
const FP2 = 'b'.repeat(64);
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

const STREAMS = [
  { key: 'BINANCE:BTCUSDT|60', symbol: 'BINANCE:BTCUSDT', timeframe: '60', market: 'crypto', status: 'healthy', lastBarTime: 1_760_003_600, lastDataAt: 1 },
  { key: 'BINANCE:BTCUSDT|15', symbol: 'BINANCE:BTCUSDT', timeframe: '15', market: 'crypto', status: 'restarting', lastBarTime: null, lastDataAt: 2 },
  { key: 'NASDAQ:NVDA|D', symbol: 'NASDAQ:NVDA', timeframe: 'D', market: 'stock', status: 'healthy', lastBarTime: 1_760_000_000, lastDataAt: 3 },
];
const candle = (i, extra = {}) => ({ time: 1_760_000_000 + i * 3600, open: 10 + i, high: 12 + i, low: 9 + i, close: 11 + i, volume: 100 + i, ...extra });
const CANDLES = Array.from({ length: 10 }, (_, i) => candle(i, { internal: 'not served' }));
const RULES = [
  { id: 'lv1', type: 'price_cross', level: 60000, symbol: 'BINANCE:BTCUSDT' },
  { id: 'lv2', type: 'price_cross', level: 1.5, timeframes: ['15'] },
  { id: 'lv3', type: 'price_cross', level: 2, symbol: 'NASDAQ:NVDA' },
  { id: 'old', type: 'price_cross', level: 3, symbol: 'BINANCE:BTCUSDT', expires: '2020-01-01' },
  { id: 'mv', type: 'pct_move', bars: 1, threshold_pct: 1, symbol: 'BINANCE:BTCUSDT' },
  { id: 'both', type: 'all_of', rules: ['lv1', 'mv'], symbol: 'BINANCE:BTCUSDT' },
];
const META = { ruleId: 'lv1', symbol: 'BINANCE:BTCUSDT', timeframe: '60', barTime: 1_760_003_600, direction: 'up', message: 'Crossed 60000', values: { close: 60010 } };
const ALERTS = [
  { at: 1000, kind: 'rule', level: 'up', title: 'a1', key: 'secret-dedupe-key-1', status: 'sent', meta: META },
  { at: 2000, kind: 'health', level: 'down', title: 'a2', key: null, status: 'sent' },
  { at: 3000, kind: 'rule', level: 'down', title: 'a3', key: 'secret-dedupe-key-3', status: 'digested', meta: { ...META, ruleId: 'lv3', symbol: 'NASDAQ:NVDA', timeframe: 'D', direction: 'down' } },
];

/** The request helper checks the four security headers on EVERY response, whatever its status. */
function request(port, { method = 'GET', path = '/', headers = {}, checkHeaders = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const out = { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') };
        if (checkHeaders) {
          for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
            assert.equal(res.headers[name], value, `${method} ${path} -> ${res.statusCode}: header ${name}`);
          }
        }
        resolve(out);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const json = (res) => JSON.parse(res.body);

function openEvents(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      resolve({
        status: res.statusCode,
        headers: res.headers,
        text: () => text,
        async waitFor(needle, ms = 2000) {
          const until = Date.now() + ms;
          while (!text.includes(needle)) {
            if (Date.now() > until) throw new Error(`timed out waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(text)}`);
            await new Promise((r) => setTimeout(r, 5));
          }
        },
        close: () => req.destroy(),
      });
    });
    req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
  });
}

async function eventually(check, ms = 2000) {
  const until = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > until) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function start(t, over = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assetDir = join(dir, 'static');
  const home = join(dir, 'home');
  await mkdir(assetDir);
  await mkdir(join(home, 'gauntlet'), { recursive: true });
  await mkdir(join(home, 'paper'), { recursive: true });
  await writeFile(join(assetDir, 'index.html'), '<!doctype html><title>t</title><script type="module" src="/assets/app.mjs"></script>');
  await writeFile(join(assetDir, 'app.mjs'), 'export const ok = true;\n');
  await writeFile(join(assetDir, 'style.css'), 'body{margin:0}\n');
  await writeFile(join(assetDir, 'lightweight-charts.mjs'), 'export const createChart = 1;\n');
  const assets = {
    '/': join(assetDir, 'index.html'),
    '/assets/app.mjs': join(assetDir, 'app.mjs'),
    '/assets/style.css': join(assetDir, 'style.css'),
    '/assets/lightweight-charts.mjs': join(assetDir, 'lightweight-charts.mjs'),
  };
  const bus = new EventEmitter();
  const clock = createFakeClock();
  const logs = [];
  const logger = { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) };
  const state = { alerts: ALERTS, failList: false };
  const streams = {
    list: () => {
      if (state.failList) throw new Error('stream list exploded');
      return STREAMS;
    },
    candles: (key) => (key === 'BINANCE:BTCUSDT|60' ? CANDLES.slice() : STREAMS.some((s) => s.key === key) ? [] : null),
  };
  const dashboard = createDashboard({
    host: '127.0.0.1',
    port: 0,
    token: '',
    bus,
    streams,
    getAlerts: () => state.alerts,
    rules: RULES,
    timezone: 'UTC',
    home,
    assets,
    clock,
    logger,
    ...over,
  });
  const bound = await dashboard.listen();
  t.after(() => dashboard.close());
  const get = (path, opts = {}) => request(bound.port, { path, ...opts });
  return { dashboard, bound, port: bound.port, get, bus, clock, logs, state, home, assetDir, dir, streams };
}

// ---------------------------------------------------------------- starting up

test('a dashboard on a non-loopback host refuses to start without a token, or with one under 16 characters', () => {
  const make = (host, token) => createDashboard({ host, port: 0, token, bus: new EventEmitter(), streams: {}, getAlerts: () => [], rules: [], timezone: 'UTC', home: '/x', assets: {}, logger: { info() {}, warn() {}, error() {} } });
  for (const host of ['0.0.0.0', '192.168.1.5', 'pi.local', '::']) {
    assert.throws(() => make(host, ''), /WATCHER_DASHBOARD_TOKEN/);
    assert.throws(() => make(host, 'x'.repeat(15)), /at least 16/);
    assert.doesNotThrow(() => make(host, 'x'.repeat(16)));
  }
  for (const host of ['127.0.0.1', '::1', 'localhost']) assert.doesNotThrow(() => make(host, ''));
});

test('it binds to the configured host and reports the real port', async (t) => {
  const { bound } = await start(t);
  assert.equal(bound.host, '127.0.0.1');
  assert.ok(bound.port > 0);
});

test('a port already in use rejects listen() with EADDRINUSE, so the watcher can carry on without a dashboard', async (t) => {
  const taken = net.createServer();
  await new Promise((resolve) => taken.listen(0, '127.0.0.1', resolve));
  t.after(() => taken.close());
  const dir = await mkdtemp(join(tmpdir(), 'dash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dashboard = createDashboard({
    host: '127.0.0.1', port: taken.address().port, token: '', bus: new EventEmitter(), streams: {}, getAlerts: () => [], rules: [], timezone: 'UTC', home: dir, assets: {}, logger: { info() {}, warn() {}, error() {} },
  });
  await assert.rejects(dashboard.listen(), { code: 'EADDRINUSE' });
  await dashboard.close();
});

test('only the request timeouts are set: no server.timeout, which would cut a quiet /events stream', async (t) => {
  const { dashboard } = await start(t);
  assert.equal(dashboard.server.timeout, 0);
  assert.ok(dashboard.server.requestTimeout > 0);
  assert.ok(dashboard.server.headersTimeout > 0);
});

// ---------------------------------------------------------------- static assets

test('GET / and the three assets are served with the exact content types (nosniff makes a wrong module type fatal)', async (t) => {
  const { get } = await start(t);
  const expected = {
    '/': 'text/html; charset=utf-8',
    '/assets/app.mjs': 'text/javascript; charset=utf-8',
    '/assets/lightweight-charts.mjs': 'text/javascript; charset=utf-8',
    '/assets/style.css': 'text/css; charset=utf-8',
  };
  for (const [path, type] of Object.entries(expected)) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers['content-type'], type, path);
  }
  assert.match((await get('/')).body, /<title>t<\/title>/);
  assert.equal((await get('/assets/app.mjs')).body, 'export const ok = true;\n');
});

test('the static allowlist is a fixed map: traversal and near-misses are 404', async (t) => {
  const { get } = await start(t);
  for (const path of [
    '/assets/../package.json', '/assets/%2e%2e/package.json', '/assets/..%2fpackage.json', '/assets/app.mjs/../../package.json',
    '//etc/passwd', '/assets/', '/assets', '/index.html', '/assets/APP.mjs', '/assets/app.mjs/', '/assets/nope.js', '/..', '/%00', '/assets/app.mjs%00.png',
  ]) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
  }
});

test('a missing asset file is logged and answers 404 while everything else keeps working', async (t) => {
  const { get, logs } = await start(t, { assets: { '/': '/nonexistent/index.html', '/assets/app.mjs': '/nonexistent/app.mjs' } });
  assert.equal((await get('/')).status, 404);
  assert.equal((await get('/assets/app.mjs')).status, 404);
  assert.equal((await get('/api/streams')).status, 200);
  assert.ok(logs.some((l) => l.startsWith('warn') && l.includes('/assets/app.mjs')));
});

// ---------------------------------------------------------------- API shapes

test('/api/streams lists symbol, timeframe, healthy and lastBarTime only', async (t) => {
  const { get } = await start(t);
  const res = await get('/api/streams');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(json(res), [
    { symbol: 'BINANCE:BTCUSDT', timeframe: '60', healthy: true, lastBarTime: 1_760_003_600 },
    { symbol: 'BINANCE:BTCUSDT', timeframe: '15', healthy: false, lastBarTime: null },
    { symbol: 'NASDAQ:NVDA', timeframe: 'D', healthy: true, lastBarTime: 1_760_000_000 },
  ]);
});

test('/api/candles returns whitelisted candles for a configured stream, newest last, with a clamped limit', async (t) => {
  const { get } = await start(t);
  const all = json(await get('/api/candles?symbol=BINANCE:BTCUSDT&tf=60'));
  assert.equal(all.length, 10);
  assert.deepEqual(all[0], { time: 1_760_000_000, open: 10, high: 12, low: 9, close: 11, volume: 100 });
  assert.ok(all.every((c) => !('internal' in c)));
  assert.deepEqual(json(await get('/api/candles?symbol=BINANCE%3ABTCUSDT&tf=60&limit=2')).map((c) => c.time), [candle(8).time, candle(9).time]);
  assert.equal(json(await get('/api/candles?symbol=BINANCE:BTCUSDT&tf=60&limit=0')).length, 10, 'a limit under 1 falls back to the default');
  assert.equal(json(await get('/api/candles?symbol=BINANCE:BTCUSDT&tf=60&limit=abc')).length, 10);
  assert.equal(json(await get('/api/candles?symbol=BINANCE:BTCUSDT&tf=60&limit=99999')).length, 10, 'clamped to 500');
  assert.deepEqual(json(await get('/api/candles?symbol=BINANCE:BTCUSDT&tf=15')), [], 'a stream with no data yet is an empty list');
});

test('/api/candles: an unknown or missing symbol or timeframe is 404 with a JSON error, never a crash', async (t) => {
  const { get } = await start(t);
  for (const query of [
    'symbol=NOPE&tf=60', 'symbol=BINANCE:BTCUSDT&tf=999', 'symbol=BINANCE:BTCUSDT', 'tf=60', '', 'symbol=binance:btcusdt&tf=60',
    'symbol[]=BINANCE:BTCUSDT&tf=60', `symbol=${'A'.repeat(5000)}&tf=60`, 'symbol=__proto__&tf=60', 'symbol=constructor&tf=60',
  ]) {
    const res = await get(`/api/candles?${query}`);
    assert.equal(res.status, 404, query);
    assert.deepEqual(json(res), { error: 'not found' });
  }
});

test('/api/alerts is newest first with the whitelisted fields, null meta fields for old entries, and no dedupe key', async (t) => {
  const { get } = await start(t);
  const res = await get('/api/alerts');
  assert.equal(res.status, 200);
  const alerts = json(res);
  assert.deepEqual(alerts.map((a) => a.title), ['a3', 'a2', 'a1']);
  assert.deepEqual(alerts[2], {
    at: 1000, kind: 'rule', level: 'up', title: 'a1', status: 'sent',
    ruleId: 'lv1', symbol: 'BINANCE:BTCUSDT', timeframe: '60', barTime: 1_760_003_600, direction: 'up', message: 'Crossed 60000', values: { close: 60010 },
  });
  assert.deepEqual(alerts[1], {
    at: 2000, kind: 'health', level: 'down', title: 'a2', status: 'sent',
    ruleId: null, symbol: null, timeframe: null, barTime: null, direction: null, message: null, values: null,
  });
  assert.ok(!res.body.includes('secret-dedupe-key'));
});

test('/api/alerts: limit is clamped to 1..500 and symbol and tf filter to one chart', async (t) => {
  const { get, state } = await start(t);
  assert.equal(json(await get('/api/alerts?limit=1')).length, 1);
  assert.equal(json(await get('/api/alerts?limit=0')).length, 3, 'under 1 falls back to the default of 100');
  assert.equal(json(await get('/api/alerts?limit=junk')).length, 3);
  state.alerts = Array.from({ length: 600 }, (_, i) => ({ at: i, kind: 'rule', level: 'up', title: `t${i}`, key: null, status: 'sent' }));
  assert.equal(json(await get('/api/alerts')).length, 100);
  assert.equal(json(await get('/api/alerts?limit=500')).length, 500);
  assert.equal(json(await get('/api/alerts?limit=5000')).length, 500);
  state.alerts = ALERTS;
  assert.deepEqual(json(await get('/api/alerts?symbol=NASDAQ:NVDA&tf=D')).map((a) => a.title), ['a3']);
  assert.deepEqual(json(await get('/api/alerts?symbol=BINANCE:BTCUSDT&tf=60')).map((a) => a.title), ['a1']);
  assert.deepEqual(json(await get('/api/alerts?symbol=NOPE&tf=60')), []);
});

test('/api/levels returns the live price_cross levels for a symbol, including rules with no symbol, not expired ones', async (t) => {
  const { get } = await start(t);
  assert.deepEqual(json(await get('/api/levels?symbol=BINANCE:BTCUSDT')), [
    { ruleId: 'lv1', level: 60000, timeframes: null },
    { ruleId: 'lv2', level: 1.5, timeframes: ['15'] },
  ]);
  assert.deepEqual(json(await get('/api/levels?symbol=NASDAQ:NVDA')).map((l) => l.ruleId), ['lv2', 'lv3']);
  for (const query of ['symbol=NOPE', '', 'symbol=__proto__']) {
    assert.equal((await get(`/api/levels?${query}`)).status, 404, query);
  }
});

// ---------------------------------------------------------------- journals

const gauntletReport = (fp, over = {}) => JSON.stringify({
  fingerprint: fp,
  created_utc: '2026-10-12T09:30:00+00:00',
  inputs: { symbol: 'BTC-USD', tv_symbol: 'BINANCE:BTCUSDT', data_source: 'tradingview', strategy: 'triple_ema', params: { fast: 8 }, interval: '1h' },
  gates: [{ gate: 'edge', status: 'PASS', reason: 'private reason', numbers: { trades: 3 } }],
  verdict: 'PASS',
  ...over,
});
const journalLines = (...events) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;

test('/api/gauntlet and /api/paper are empty lists when the folders are missing or empty', async (t) => {
  const { get, home } = await start(t);
  assert.deepEqual(json(await get('/api/gauntlet')), []);
  assert.deepEqual(json(await get('/api/paper')), []);
  await rm(join(home, 'gauntlet'), { recursive: true });
  await rm(join(home, 'paper'), { recursive: true });
  assert.deepEqual(json(await get('/api/gauntlet')), []);
  assert.deepEqual(json(await get('/api/paper')), []);
});

test('/api/gauntlet serves whitelisted summaries, newest file first, and never the reason or numbers', async (t) => {
  const { get, home } = await start(t);
  await writeFile(join(home, 'gauntlet', `${FP}.json`), gauntletReport(FP));
  await writeFile(join(home, 'gauntlet', `${FP2}.json`), gauntletReport(FP2, { verdict: 'FAIL: edge' }));
  await utimes(join(home, 'gauntlet', `${FP}.json`), new Date(1000), new Date(1000));
  await utimes(join(home, 'gauntlet', `${FP2}.json`), new Date(2000), new Date(2000));
  const res = await get('/api/gauntlet');
  const reports = json(res);
  assert.deepEqual(reports.map((r) => r.fingerprint), [FP2, FP]);
  assert.deepEqual(reports[1], {
    fingerprint: FP, created_utc: '2026-10-12T09:30:00+00:00', strategy: 'triple_ema', symbol: 'BINANCE:BTCUSDT',
    interval: '1h', timeframe: '60', verdict: 'PASS', gates: [{ gate: 'edge', status: 'PASS' }],
  });
  assert.ok(!res.body.includes('private reason'));
});

test('hostile files in the gauntlet folder are ignored: bad names, symlinks, oversize, garbage, a mismatched fingerprint', async (t) => {
  const { get, home, dir } = await start(t);
  const folder = join(home, 'gauntlet');
  await writeFile(join(folder, `${FP}.json`), gauntletReport(FP));
  await writeFile(join(folder, 'log.jsonl'), gauntletReport(FP2));
  await writeFile(join(folder, 'notes.json'), gauntletReport(FP2));
  await writeFile(join(folder, `${FP2}.bak.json`), gauntletReport(FP2), 'utf8'); // its first 64 characters look like a fingerprint
  await writeFile(join(folder, `${'C'.repeat(64)}.json`), gauntletReport('C'.repeat(64)));
  await writeFile(join(folder, `${'d'.repeat(64)}.json`), 'not json at all {');
  await writeFile(join(folder, `${'e'.repeat(64)}.json`), `${gauntletReport('e'.repeat(64))}${' '.repeat(1_100_000)}`);
  await writeFile(join(folder, `${'f'.repeat(64)}.json`), gauntletReport(FP2), 'utf8');
  await writeFile(join(dir, 'outside.json'), gauntletReport('1'.repeat(64)));
  await symlink(join(dir, 'outside.json'), join(folder, `${'1'.repeat(64)}.json`));
  await mkdir(join(folder, `${'2'.repeat(64)}.json`));
  const reports = json(await get('/api/gauntlet'));
  assert.deepEqual(reports.map((r) => r.fingerprint), [FP]);
});

test('at most the 50 newest gauntlet files are read', async (t) => {
  const { get, home } = await start(t);
  for (let i = 0; i < 60; i += 1) {
    const fp = i.toString(16).padStart(64, '0');
    await writeFile(join(home, 'gauntlet', `${fp}.json`), gauntletReport(fp));
    await utimes(join(home, 'gauntlet', `${fp}.json`), new Date(1000 + i), new Date(1000 + i));
  }
  const reports = json(await get('/api/gauntlet'));
  assert.equal(reports.length, 50);
  assert.equal(reports[0].fingerprint, (59).toString(16).padStart(64, '0'));
});

test('/api/paper joins each journal to the report with the same fingerprint, and keeps the last 50 whitelisted events', async (t) => {
  const { get, home } = await start(t);
  await writeFile(join(home, 'gauntlet', `${FP}.json`), gauntletReport(FP));
  const events = [{ ts: 't0', type: 'start', bar_time: 1_760_000_000 }];
  for (let i = 1; i <= 60; i += 1) events.push({ ts: `t${i}`, type: i % 2 ? 'entry' : 'exit', price: 100 + i, bar_time: 1_760_000_000 + i * 3600, return_pct: i % 2 ? undefined : 1.5, note: 'dropped' });
  await writeFile(join(home, 'paper', `${FP}.jsonl`), `${journalLines(...events)}garbage line\n`);
  await writeFile(join(home, 'paper', `${FP2}.jsonl`), journalLines({ ts: 'x', type: 'start', bar_time: 5 }));
  await utimes(join(home, 'paper', `${FP}.jsonl`), new Date(2000), new Date(2000));
  await utimes(join(home, 'paper', `${FP2}.jsonl`), new Date(1000), new Date(1000));
  const res = await get('/api/paper');
  const journals = json(res);
  assert.deepEqual(journals.map((j) => j.fingerprint), [FP, FP2]);
  assert.equal(journals[0].strategy, 'triple_ema');
  assert.equal(journals[0].symbol, 'BINANCE:BTCUSDT');
  assert.equal(journals[0].timeframe, '60');
  assert.equal(journals[0].events.length, 50);
  assert.equal(journals[0].events.at(-1).ts, 't60');
  assert.deepEqual(Object.keys(journals[0].events[0]), ['ts', 'type', 'price', 'bar_time', 'return_pct']);
  assert.ok(!res.body.includes('dropped'));
  assert.deepEqual([journals[1].strategy, journals[1].symbol, journals[1].timeframe], [null, null, null], 'a journal without a report still shows, with null labels');
});

test('a journal whose report is a symlink still shows, with null labels: the report is never followed out of the folder', async (t) => {
  const { get, home, dir } = await start(t);
  await writeFile(join(dir, 'outside.json'), gauntletReport(FP));
  await symlink(join(dir, 'outside.json'), join(home, 'gauntlet', `${FP}.json`));
  await writeFile(join(home, 'paper', `${FP}.jsonl`), journalLines({ ts: 't', type: 'start', bar_time: 1 }));
  const [journal] = json(await get('/api/paper'));
  assert.equal(journal.fingerprint, FP);
  assert.equal(journal.strategy, null);
});

test('hostile files in the paper folder are ignored the same way: log.jsonl, bad names, symlinks, oversize', async (t) => {
  const { get, home, dir } = await start(t);
  const folder = join(home, 'paper');
  await writeFile(join(folder, `${FP}.jsonl`), journalLines({ ts: 't', type: 'start', bar_time: 1 }));
  await writeFile(join(folder, 'log.jsonl'), journalLines({ ts: 'x', type: 'start', bar_time: 1 }));
  await writeFile(join(folder, `${FP2}.json`), journalLines({ ts: 'x', type: 'start', bar_time: 1 }));
  await writeFile(join(folder, `${'e'.repeat(64)}.jsonl`), `${journalLines({ ts: 'x', type: 'start', bar_time: 1 })}${' '.repeat(1_100_000)}`);
  await writeFile(join(dir, 'outside.jsonl'), journalLines({ ts: 'x', type: 'start', bar_time: 1 }));
  await symlink(join(dir, 'outside.jsonl'), join(folder, `${'1'.repeat(64)}.jsonl`));
  assert.deepEqual(json(await get('/api/paper')).map((j) => j.fingerprint), [FP]);
});

// ---------------------------------------------------------------- security

test('only GET is allowed: every other method is 405 with an Allow header', async (t) => {
  const { get } = await start(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    const res = await get('/api/streams', { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, 'GET', method);
  }
  assert.equal((await get('/events', { method: 'POST' })).status, 405);
});

test('no CORS headers are ever sent, so another site cannot read the API', async (t) => {
  const { get } = await start(t);
  const res = await get('/api/streams', { headers: { origin: 'https://evil.example' } });
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  const pre = await get('/api/streams', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
  assert.equal(pre.headers['access-control-allow-origin'], undefined);
});

test('a loopback dashboard without a token needs no credentials', async (t) => {
  const { get } = await start(t);
  assert.equal((await get('/api/streams')).status, 200);
  assert.equal((await get('/')).status, 200);
});

test('loopback Host check: only the host name counts (not the port), so an SSH tunnel works and DNS rebinding does not', async (t) => {
  const { get } = await start(t);
  for (const host of ['127.0.0.1', '127.0.0.1:8788', '127.0.0.1:9000', 'localhost', 'localhost:9000', 'LOCALHOST:9000', '[::1]', '[::1]:9000']) {
    assert.equal((await get('/api/streams', { headers: { host } })).status, 200, host);
  }
  for (const host of ['evil.example', 'evil.example:8788', '127.0.0.1.evil.example', 'localhost.evil.example:8788', '192.168.1.5', '0.0.0.0', 'evil.example#@127.0.0.1']) {
    const res = await get('/api/streams', { headers: { host } });
    assert.equal(res.status, 403, JSON.stringify(host));
    assert.deepEqual(json(res), { error: 'forbidden host' });
  }
});

/** Sends raw bytes and returns everything the server writes back (the client library would fix up a bad Host). */
async function rawRequest(port, text) {
  const socket = net.connect(port, '127.0.0.1');
  let received = '';
  socket.setEncoding('utf8');
  socket.on('data', (c) => { received += c; });
  await new Promise((resolve) => socket.on('connect', resolve));
  socket.write(text);
  await eventually(() => received.includes('\r\n\r\n'));
  socket.destroy();
  return received;
}

test('loopback Host check: an empty Host and a missing Host are both 403, with the security headers', async (t) => {
  const { port } = await start(t);
  const empty = await rawRequest(port, 'GET /api/streams HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n');
  assert.match(empty, /^HTTP\/1\.1 403 /);
  const missing = await rawRequest(port, 'GET /api/streams HTTP/1.1\r\nConnection: close\r\n\r\n');
  assert.match(missing, /^HTTP\/1\.1 403 /);
  for (const text of [empty, missing]) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.ok(text.includes(`${name}: ${value}`), name);
  }
});

test('a token set on a loopback dashboard is required: loopback only drops the token when none is configured', async (t) => {
  const { get } = await start(t, { token: TOKEN });
  assert.equal((await get('/api/streams')).status, 401);
  assert.equal((await get('/api/streams', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
});

test('with a token: 401 without it, 401 for a wrong one (same length or not), 200 with Bearer', async (t) => {
  const { get, logs } = await start(t, { host: '0.0.0.0', token: TOKEN });
  const denied = await get('/api/streams');
  assert.equal(denied.status, 401);
  assert.deepEqual(json(denied), { error: 'unauthorized' });
  for (const header of [`Bearer ${TOKEN.slice(0, -1)}X`, `Bearer ${TOKEN}x`, 'Bearer short', 'Bearer ', 'Basic abc', TOKEN, `bearer${TOKEN}`]) {
    assert.equal((await get('/api/streams', { headers: { authorization: header } })).status, 401, header);
  }
  assert.equal((await get('/api/streams', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  assert.equal((await get('/api/streams', { headers: { authorization: `bearer ${TOKEN}` } })).status, 200, 'the scheme name is case-insensitive');
  assert.ok(!logs.join('\n').includes(TOKEN));
});

test('?token= once: a right token sets the cookie and redirects to the same URL without only the token parameter', async (t) => {
  const { get, logs } = await start(t, { host: '0.0.0.0', token: TOKEN });
  const first = await get(`/?symbol=BINANCE:BTCUSDT&tf=60&t=5&token=${TOKEN}`);
  assert.equal(first.status, 302);
  assert.equal(first.headers.location, '/?symbol=BINANCE:BTCUSDT&tf=60&t=5');
  assert.equal(first.headers['set-cookie'].length, 1);
  assert.equal(first.headers['set-cookie'][0], `tvw_dash=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/`);
  assert.ok(!first.headers.location.includes(TOKEN));
  assert.equal((await get(`/?token=${TOKEN}`)).headers.location, '/');
  assert.equal((await get(`/api/alerts?limit=5&token=${TOKEN}&token=${TOKEN}`)).headers.location, '/api/alerts?limit=5', 'every token parameter goes');
  assert.equal((await get(`/?token=${TOKEN}&x=1`)).headers.location, '/?x=1');
  assert.equal((await get(`/?t%6Fken=${TOKEN}&x=1`)).headers.location, '/?x=1', 'an encoded parameter name is removed too');
  assert.equal((await get(`//evil.example/x?token=${TOKEN}`)).headers.location, '/', 'never a protocol-relative redirect to another site');
  assert.equal((await get(`/\\evil.example?token=${TOKEN}`)).headers.location, '/');
  const cookie = first.headers['set-cookie'][0].split(';')[0];
  assert.equal((await get('/api/streams', { headers: { cookie } })).status, 200);
  assert.equal((await get('/api/streams', { headers: { cookie: `other=1; ${cookie}` } })).status, 200);
  assert.equal((await get('/api/streams', { headers: { cookie: 'tvw_dash=wrong' } })).status, 401);
  assert.equal((await get('/api/streams', { headers: { cookie: 'tvw_dash=' } })).status, 401);
  assert.ok(!logs.join('\n').includes(TOKEN), 'the token never reaches a log line');
});

test('a wrong ?token= is 401: no redirect, no cookie', async (t) => {
  const { get } = await start(t, { host: '0.0.0.0', token: TOKEN });
  for (const query of ['token=wrong', `token=${TOKEN}x`, 'token=', 'token']) {
    const res = await get(`/?${query}`);
    assert.equal(res.status, 401, query);
    assert.equal(res.headers.location, undefined);
    assert.equal(res.headers['set-cookie'], undefined);
  }
});

test('a token with characters that are not cookie-safe survives the cookie round trip', async (t) => {
  const odd = 'p@ss word;with,odd"chars=and%percent-1234';
  const { get } = await start(t, { host: '0.0.0.0', token: odd });
  const res = await get(`/?token=${encodeURIComponent(odd)}`);
  assert.equal(res.status, 302);
  const cookie = res.headers['set-cookie'][0].split(';')[0];
  assert.equal((await get('/api/streams', { headers: { cookie } })).status, 200);
});

test('every status code carries the four security headers: 200, 302, 401, 403, 404, 405, 500 and 503', async (t) => {
  // The request helper asserts the headers on each response; this test makes sure each status really occurs.
  const { get, port, state } = await start(t, { host: '0.0.0.0', token: TOKEN });
  const auth = { authorization: `Bearer ${TOKEN}` };
  const seen = new Set();
  const note = async (promise) => { seen.add((await promise).status); };
  await note(get('/', { headers: auth }));
  await note(get(`/?token=${TOKEN}`));
  await note(get('/api/streams'));
  await note(get('/nope', { headers: auth }));
  await note(get('/api/streams', { method: 'POST', headers: auth }));
  state.failList = true;
  await note(get('/api/streams', { headers: auth }));
  state.failList = false;
  const clients = [];
  for (let i = 0; i < MAX_SSE_CLIENTS; i += 1) clients.push(await openEvents(port, auth));
  t.after(() => clients.forEach((c) => c.close()));
  await note(get('/events', { headers: auth }));
  assert.deepEqual([...seen].sort(), [200, 302, 401, 404, 405, 500, 503]);
  const loopback = await start(t);
  assert.equal((await loopback.get('/api/streams', { headers: { host: 'evil.example' } })).status, 403);
});

test('an internal error is a generic 500 with no stack or message, and the server keeps serving', async (t) => {
  const { get, state, logs } = await start(t);
  state.failList = true;
  const res = await get('/api/streams');
  assert.equal(res.status, 500);
  assert.deepEqual(json(res), { error: 'internal error' });
  assert.ok(!res.body.includes('exploded'));
  assert.ok(logs.some((l) => l.startsWith('error') && l.includes('exploded')));
  state.failList = false;
  assert.equal((await get('/api/streams')).status, 200);
});

test('malformed percent-encoding is never a crash: a bad path is 404, a bad query is just ignored', async (t) => {
  const { get, port } = await start(t);
  for (const path of ['/%', '/%zz', '/%E0%A4%A']) assert.equal((await get(path)).status, 404, path);
  for (const path of ['/api/candles?symbol=%E0%A4%A', '/?a=%', '/api/alerts?limit=%zz&symbol=%']) {
    const res = await get(path);
    assert.ok(res.status < 500, `${path} -> ${res.status}`);
  }
  assert.equal((await request(port, { path: '/api/streams' })).status, 200);
});

// ---------------------------------------------------------------- events (SSE)

test('/events is a text/event-stream, and a bar on the bus reaches the browser as an event', async (t) => {
  const { port, bus } = await start(t);
  const events = await openEvents(port);
  t.after(() => events.close());
  assert.equal(events.status, 200);
  assert.equal(events.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(events.headers['cache-control'], 'no-store');
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(events.headers[name], value, name);
  bus.emit('bar', STREAMS[0], candle(3, { internal: 'x' }));
  await events.waitFor('event: bar\n');
  const data = events.text().split('event: bar\ndata: ')[1].split('\n')[0];
  assert.deepEqual(JSON.parse(data), { symbol: 'BINANCE:BTCUSDT', timeframe: '60', candle: { time: candle(3).time, open: 13, high: 15, low: 12, close: 14, volume: 103 } });
});

test('an alert on the bus reaches the browser with the same fields as /api/alerts, minus the dedupe key', async (t) => {
  const { port, bus } = await start(t);
  const events = await openEvents(port);
  t.after(() => events.close());
  bus.emit('alert', ALERTS[0]);
  await events.waitFor('event: alert\n');
  const data = JSON.parse(events.text().split('event: alert\ndata: ')[1].split('\n')[0]);
  assert.equal(data.ruleId, 'lv1');
  assert.equal(data.status, 'sent');
  assert.equal(data.key, undefined);
  assert.ok(!events.text().includes('secret-dedupe-key'));
});

test('a health event carries the stream list in the /api/streams shape', async (t) => {
  const { port, bus } = await start(t);
  const events = await openEvents(port);
  t.after(() => events.close());
  bus.emit('health', STREAMS);
  await events.waitFor('event: health\n');
  const data = JSON.parse(events.text().split('event: health\ndata: ')[1].split('\n')[0]);
  assert.deepEqual(data[0], { symbol: 'BINANCE:BTCUSDT', timeframe: '60', healthy: true, lastBarTime: 1_760_003_600 });
  assert.equal(data.length, 3);
});

test('bars are coalesced to one per stream per second: the first goes at once, the last is flushed later, the rest are dropped', async (t) => {
  const { port, bus, clock } = await start(t);
  const events = await openEvents(port);
  t.after(() => events.close());
  const closes = () => [...events.text().matchAll(/"close":(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  bus.emit('bar', STREAMS[0], candle(0, { close: 1 }));
  bus.emit('bar', STREAMS[0], candle(0, { close: 2 }));
  bus.emit('bar', STREAMS[0], candle(0, { close: 3 }));
  bus.emit('bar', STREAMS[2], candle(0, { close: 50 }));
  await events.waitFor('"close":50');
  assert.deepEqual(closes().sort((a, b) => a - b), [1, 50], 'a different stream is not held back by the first');
  clock.advance(COALESCE_MS);
  await events.waitFor('"close":3');
  assert.deepEqual(closes().sort((a, b) => a - b), [1, 3, 50], 'the trailing flush sends the latest value, not the middle one');
  bus.emit('bar', STREAMS[0], candle(0, { close: 4 }));
  clock.advance(COALESCE_MS);
  await events.waitFor('"close":4');
});

test('with no browser connected a bar costs nothing: no timer is created', async (t) => {
  const { bus, clock } = await start(t);
  bus.emit('bar', STREAMS[0], candle(0));
  bus.emit('bar', STREAMS[0], candle(1));
  assert.equal(clock.pending(), 0);
});

test('a heartbeat comment goes out every 20 s while a browser is connected, and the timer stops when the last one leaves', async (t) => {
  const { port, clock, dashboard } = await start(t);
  assert.equal(HEARTBEAT_MS, 20_000);
  const events = await openEvents(port);
  assert.equal(events.text().includes(': hb'), false);
  clock.advance(HEARTBEAT_MS);
  await events.waitFor(': hb');
  events.close();
  await eventually(() => dashboard.clientCount() === 0);
  assert.equal(clock.pending(), 0);
});

test('at most 5 event clients; a 6th gets 503 until one leaves; the bus listeners do not pile up', async (t) => {
  const { port, bus, dashboard, get } = await start(t);
  const baseline = bus.listenerCount('bar');
  const clients = [];
  for (let i = 0; i < MAX_SSE_CLIENTS; i += 1) clients.push(await openEvents(port));
  t.after(() => clients.forEach((c) => c.close()));
  assert.equal(MAX_SSE_CLIENTS, 5);
  assert.equal(dashboard.clientCount(), 5);
  const refused = await get('/events');
  assert.equal(refused.status, 503);
  assert.deepEqual(json(refused), { error: 'too many event clients' });
  clients[0].close();
  await eventually(() => dashboard.clientCount() === 4);
  const again = await openEvents(port);
  t.after(() => again.close());
  assert.equal(again.status, 200);
  assert.equal(bus.listenerCount('bar'), baseline, 'one bus listener per event, however many browsers');
});

test('a client that stops reading is dropped instead of buffering without limit', async (t) => {
  const { port, bus, dashboard } = await start(t);
  const socket = net.connect(port, '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise((resolve) => socket.on('connect', resolve));
  socket.write('GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  await eventually(() => dashboard.clientCount() === 1);
  socket.pause();
  const bigList = Array.from({ length: 25 }, (_, i) => ({ ...STREAMS[0], timeframe: `x${'y'.repeat(200)}${i}` }));
  for (let i = 0; i < 20_000 && dashboard.clientCount() > 0; i += 1) bus.emit('health', bigList);
  await eventually(() => dashboard.clientCount() === 0);
  assert.equal((await request(port, { path: '/api/streams' })).status, 200);
});

test('close() ends every event stream and removes the bus listeners', async (t) => {
  const dir = await start(t);
  const events = await openEvents(dir.port);
  t.after(() => events.close());
  await dir.dashboard.close();
  await eventually(() => dir.dashboard.clientCount() === 0);
  for (const name of ['bar', 'alert', 'health']) assert.equal(dir.bus.listenerCount(name), 0, name);
  assert.equal(dir.clock.pending(), 0);
  await dir.dashboard.close();
});

test('the log shows the dashboard address but never a token or a request URL', async (t) => {
  const { get, logs } = await start(t, { host: '0.0.0.0', token: TOKEN });
  await get(`/?token=${TOKEN}&symbol=SECRETSYMBOL`);
  await get('/api/candles?symbol=SECRETSYMBOL&tf=1', { headers: { authorization: `Bearer ${TOKEN}` } });
  const text = logs.join('\n');
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes('SECRETSYMBOL'));
});

test('a malformed request gets a 400 that still carries the security headers', async (t) => {
  const { port } = await start(t);
  const socket = net.connect(port, '127.0.0.1');
  t.after(() => socket.destroy());
  let text = '';
  socket.setEncoding('utf8');
  socket.on('data', (c) => { text += c; });
  await new Promise((resolve) => socket.on('connect', resolve));
  socket.write('NOT A VALID REQUEST\r\n\r\n');
  await eventually(() => text.includes('\r\n\r\n'));
  assert.match(text, /^HTTP\/1\.1 400 /);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.ok(text.includes(`${name}: ${value}`), name);
});

// ---------------------------------------------------------------- review findings (P1 wrap-up)

test('a FIFO where a report should be is skipped at once: opening it would hang a worker thread for good', async (t) => {
  const { get, home } = await start(t);
  try {
    execFileSync('mkfifo', [join(home, 'gauntlet', `${FP}.json`)]);
  } catch {
    t.skip('mkfifo is not available here');
    return;
  }
  await writeFile(join(home, 'paper', `${FP}.jsonl`), journalLines({ ts: 't', type: 'start', bar_time: 1 }));
  const timeout = new Promise((_, reject) => { setTimeout(() => reject(new Error('/api/paper hung on a FIFO')), 3000).unref(); });
  const [journal] = json(await Promise.race([get('/api/paper'), timeout]));
  assert.equal(journal.fingerprint, FP);
  assert.equal(journal.strategy, null);
});

test('the 1 MB file cap is exact: a file of exactly 1 MiB is read, one byte more is skipped', async (t) => {
  const { get, home } = await start(t);
  const pad = (fp, size) => {
    const body = gauntletReport(fp);
    return body + ' '.repeat(size - Buffer.byteLength(body));
  };
  await writeFile(join(home, 'gauntlet', `${FP}.json`), pad(FP, 1024 * 1024));
  await writeFile(join(home, 'gauntlet', `${FP2}.json`), pad(FP2, 1024 * 1024 + 1));
  assert.deepEqual(json(await get('/api/gauntlet')).map((r) => r.fingerprint), [FP]);
});

test('Expect: with an unknown value is a 417 that still carries the security headers', async (t) => {
  const { port } = await start(t);
  const text = await rawRequest(port, 'GET /api/streams HTTP/1.1\r\nHost: 127.0.0.1\r\nExpect: nonsense\r\nConnection: close\r\n\r\n');
  assert.match(text, /^HTTP\/1\.1 417 /);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.ok(text.includes(`${name}: ${value}`), name);
});

test('a client error after a response has started destroys the socket instead of writing a second response', async (t) => {
  const { dashboard } = await start(t);
  const calls = [];
  const socket = { writable: true, _httpMessage: { headersSent: true }, end: () => calls.push('end'), destroy: () => calls.push('destroy') };
  dashboard.server.emit('clientError', new Error('request timeout'), socket);
  assert.deepEqual(calls, ['destroy']);
  const fresh = { writable: true, _httpMessage: null, end: () => calls.push('end:fresh'), destroy: () => calls.push('destroy:fresh') };
  dashboard.server.emit('clientError', new Error('bad request'), fresh);
  assert.deepEqual(calls, ['destroy', 'end:fresh'], 'with no response started, the 400 is still written');
});

test('a correction to the closing candle and the next candle inside one second are both delivered, in time order', async (t) => {
  const { port, bus, clock } = await start(t);
  const events = await openEvents(port);
  t.after(() => events.close());
  const frames = () => [...events.text().matchAll(/"time":(\d+),"open":\d+(?:\.\d+)?,"high":\d+(?:\.\d+)?,"low":\d+(?:\.\d+)?,"close":(\d+(?:\.\d+)?)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const a = candle(0);
  const b = candle(1);
  bus.emit('bar', STREAMS[0], { ...a, close: 100 });   // leading edge, sent at once
  clock.advance(100);
  bus.emit('bar', STREAMS[0], { ...a, close: 101 });   // pending
  clock.advance(100);
  bus.emit('bar', STREAMS[0], { ...b, close: 102 });   // a new candle, still inside the second
  clock.advance(COALESCE_MS);
  await events.waitFor('"close":102');
  assert.deepEqual(frames(), [[a.time, 100], [a.time, 101], [b.time, 102]]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createDashboard, defaultAssets } from '../../lib/dashboard.mjs';
import { parseRenderQuery, renderPlan } from '../../dashboard/pure.mjs';

const read = (name) => readFile(fileURLToPath(new URL(`../../dashboard/${name}`, import.meta.url)), 'utf8');
const ASSET_PATHS = new Set(Object.keys(defaultAssets()));

// ---------------------------------------------------------------- the query the renderer opens

test('parseRenderQuery reads symbol, timeframe, bar time, direction, level and rule', () => {
  const q = parseRenderQuery('?symbol=BINANCE%3ABTCUSDT&tf=60&t=1760000000&dir=up&level=100000.5&rule=btc100k');
  assert.deepEqual(q, { symbol: 'BINANCE:BTCUSDT', timeframe: '60', t: 1760000000, direction: 'up', level: 100000.5, rule: 'btc100k' });
});

test('parseRenderQuery drops anything that is not a plain value', () => {
  const q = parseRenderQuery('?symbol=X&tf=60&t=abc&dir=sideways&level=1e999&rule=' + 'r'.repeat(200));
  assert.equal(q.t, null);
  assert.equal(q.direction, null);
  assert.equal(q.level, null);
  assert.equal(q.rule.length, 60, 'the rule label is capped');
  for (const level of ['NaN', 'Infinity', '--1', '1,5', '', '0x10']) assert.equal(parseRenderQuery(`?level=${level}`).level, null, level);
  assert.equal(parseRenderQuery('?level=2.5e-7').level, 2.5e-7, 'small prices print with an exponent');
  assert.equal(parseRenderQuery('?level=-3').level, -3);
  assert.deepEqual(parseRenderQuery(''), { symbol: null, timeframe: null, t: null, direction: null, level: null, rule: null });
});

// ---------------------------------------------------------------- what the image draws

const candle = (time) => ({ time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
const candles = Array.from({ length: 200 }, (_, i) => candle(1000 + i * 60));

test('renderPlan keeps the last 120 bars, a marker on the alert bar and the level line', () => {
  const t = candles[190].time;
  const plan = renderPlan(candles, { t, direction: 'up', level: 1.7, rule: 'r1' });
  assert.equal(plan.candles.length, 120);
  assert.equal(plan.candles.at(-1).time, candles.at(-1).time);
  assert.deepEqual(plan.marker, { time: t, position: 'belowBar', shape: 'arrowUp', tone: 'up', text: '↑' });
  assert.deepEqual(plan.level, { price: 1.7, title: 'r1' });
});

test('renderPlan: a down alert points down; no direction means a marker-less image, not a wrong one', () => {
  const t = candles[190].time;
  assert.equal(renderPlan(candles, { t, direction: 'down', level: null, rule: null }).marker.shape, 'arrowDown');
  assert.equal(renderPlan(candles, { t, direction: null, level: null, rule: null }).marker, null);
  assert.equal(renderPlan(candles, { t: null, direction: 'up', level: null, rule: null }).marker, null);
});

test('renderPlan: an alert bar that is no longer in the window gets no marker; no level means no line', () => {
  const plan = renderPlan(candles, { t: candles[10].time, direction: 'up', level: null, rule: 'r1' });
  assert.equal(plan.marker, null);
  assert.equal(plan.level, null);
});

test('renderPlan: the marker sits on the last bar at or before the alert time', () => {
  const plan = renderPlan(candles, { t: candles[150].time + 30, direction: 'up', level: null, rule: null });
  assert.equal(plan.marker.time, candles[150].time);
});

// ---------------------------------------------------------------- render.html and the server

test('render.html: no inline code, only allowlisted assets, nothing leaves the origin, the chart frame carries the library credit', async () => {
  const html = await read('render.html');
  assert.match(html, /^<!doctype html>/i);
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(attrs, /\ssrc="\/assets\/render-page\.mjs"/);
    assert.match(attrs, /type="module"/);
    assert.equal(body.trim(), '');
  }
  assert.doesNotMatch(html, /<style\b|\sstyle\s*=|\son[a-z]+\s*=|javascript:|<(meta[^>]*http-equiv|form|base|iframe|frame|object|embed)\b/i);
  for (const [, , url] of html.matchAll(/\s(src|href)="([^"]*)"/gi)) {
    if (url === 'data:,') continue;
    assert.ok(ASSET_PATHS.has(url), `${url} is not in the dashboard allowlist`);
  }
  assert.match(html, /\sid="frame"[\s\S]*\sid="chart"[\s\S]*TradingView, Inc\./, 'the screenshot element holds the chart and the credit');
});

test('render-page.mjs says when it is done or has failed, for the renderer to wait on', async () => {
  const code = (await read('render-page.mjs')).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(code, /__ready\s*=\s*true/);
  assert.match(code, /__failed\s*=/);
  assert.match(code, /attributionLogo:\s*false/, 'the logo injects a <style>, which the CSP blocks');
});

function serve(options = {}) {
  return createDashboard({
    host: '127.0.0.1', port: 0, token: '', bus: new EventEmitter(), streams: { list: () => [], candles: () => null },
    getAlerts: () => [], rules: [], timezone: 'UTC', home: '/nonexistent', assets: defaultAssets(),
    logger: { info() {}, warn(m) { assert.fail(m); }, error() {} },
    ...options,
  });
}

const get = (port, path, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  }).on('error', reject);
});

test('/render serves the render page as HTML with the same security headers as every page', async (t) => {
  const dashboard = serve();
  const { port } = await dashboard.listen();
  t.after(() => dashboard.close());
  const res = await get(port, '/render?symbol=X&tf=60');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  assert.match(res.body, /id="chart"/);
  for (const path of ['/assets/render-page.mjs', '/assets/render.css']) assert.equal((await get(port, path)).status, 200, path);
});

test('/render has the same auth and Host rules as the rest of the dashboard', async (t) => {
  const dashboard = serve({ token: 'a-secret-token-of-16+' });
  const { port } = await dashboard.listen();
  t.after(() => dashboard.close());
  assert.equal((await get(port, '/render')).status, 401);
  assert.equal((await get(port, '/render', { authorization: 'Bearer a-secret-token-of-16+' })).status, 200, 'the renderer sends the token as a header');
  const plain = serve();
  const second = await plain.listen();
  t.after(() => plain.close());
  assert.equal((await get(second.port, '/render', { host: 'evil.example' })).status, 403);
});

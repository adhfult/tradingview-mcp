import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createDashboard, defaultAssets } from '../../lib/dashboard.mjs';

const dir = (name) => fileURLToPath(new URL(`../../dashboard/${name}`, import.meta.url));
const read = (name) => readFile(dir(name), 'utf8');
const ASSET_PATHS = new Set(Object.keys(defaultAssets()));
const DESIGN = fileURLToPath(new URL('../../../docs/design/DESIGN.md', import.meta.url));

// ---------------------------------------------------------------- index.html

test('index.html: no inline code, only allowlisted assets, one external link (the TradingView attribution)', async () => {
  const html = await read('index.html');
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html[^>]*\slang="en"/);
  assert.match(html, /<meta[^>]*name="viewport"/);

  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1, 'the page loads app.mjs');
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /\ssrc="\/assets\/app\.mjs"/, 'every script is the allowlisted module');
    assert.match(attrs, /type="module"/);
    assert.equal(body.trim(), '', 'no inline script body');
  }
  assert.doesNotMatch(html, /<style\b/i, 'style-src is self: no <style> element');
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'no style attribute');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handler');
  assert.doesNotMatch(html, /javascript:/i);

  const external = [];
  for (const [, , url] of html.matchAll(/\s(src|href)="([^"]*)"/gi)) {
    if (url.startsWith('#') || url === 'data:,') continue; // data:, is the empty favicon (img-src allows data:)
    if (/^https?:\/\//.test(url)) external.push(url);
    else assert.ok(ASSET_PATHS.has(url), `${url} is not in the dashboard allowlist`);
  }
  assert.deepEqual(external, ['https://www.tradingview.com/'], 'only the attribution link leaves the origin');
  assert.match(html, /<a\s[^>]*href="https:\/\/www\.tradingview\.com\/"[^>]*rel="[^"]*noopener[^"]*"/, 'attribution link, noopener');
  assert.match(html, /href="\/assets\/style\.css"/);
  assert.match(html, /Copyright © 20\d\d TradingView, Inc\./, 'the library NOTICE text, since the logo is off');
});

test('index.html: landmarks, labelled stream picker, live badge and aria-live alerts list', async () => {
  const html = await read('index.html');
  for (const tag of ['header', 'main', 'footer']) assert.match(html, new RegExp(`<${tag}[\\s>]`), `<${tag}> landmark`);
  assert.match(html, /<h1[\s>]/);
  assert.match(html, /<label[^>]*\sfor="stream-picker"/);
  assert.match(html, /<select[^>]*\sid="stream-picker"/);
  assert.match(html, /\sid="live-badge"/);
  assert.match(html, /\sid="chart"/);
  assert.match(html, /<[a-z]+[^>]*\sid="alerts-list"[^>]*aria-live="polite"|<[a-z]+[^>]*aria-live="polite"[^>]*\sid="alerts-list"/);
  for (const id of ['chart-status', 'alerts-status', 'streams-status', 'streams-list', 'retry']) assert.match(html, new RegExp(`\\sid="${id}"`), id);
  assert.match(html, /<noscript>/, 'a plain message without JavaScript');
});

// ---------------------------------------------------------------- style.css

test('style.css: every DESIGN.md token is defined for light and dark, with focus and reduced-motion rules', async () => {
  const css = await read('style.css');
  const design = await readFile(DESIGN, 'utf8');
  const tokens = [...new Set([...design.matchAll(/`(--[a-z0-9-]+)`/g)].map((m) => m[1]))];
  assert.ok(tokens.length >= 20, `found ${tokens.length} tokens in DESIGN.md`);
  const dark = css.slice(css.indexOf('prefers-color-scheme: dark'));
  assert.ok(dark.length < css.length, 'a dark-scheme block exists');
  const colours = ['--bg', '--surface', '--border', '--text', '--muted', '--accent', '--up', '--down', '--note', '--paper'];
  for (const token of tokens) assert.match(css, new RegExp(`${token}\\s*:`), `${token} defined`);
  for (const token of colours) assert.match(dark, new RegExp(`${token}\\s*:`), `${token} redefined for dark`);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /@media[^{]*max-width|@media[^{]*min-width/, 'responsive rule');
  assert.doesNotMatch(css, /@import|url\(\s*["']?https?:/i, 'no external loads');
});

// ---------------------------------------------------------------- app.mjs (static)

test('app.mjs: never builds HTML from data, never evals, talks only to its own origin', async () => {
  const js = await read('app.mjs');
  assert.doesNotMatch(js, /\.(innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|setAttribute\(\s*['"]style/);
  assert.doesNotMatch(js, /\bimport\s*\(\s*[^'"/\s]/, 'dynamic import takes a literal');
  const imports = [...js.matchAll(/(?:from|import\s*\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)].filter((u) => u !== '/assets/lightweight-charts.mjs'), [], 'only the chart library is imported');
  for (const [, url] of js.matchAll(/(?:fetch|EventSource)\(\s*['"`]([^'"`]+)/g)) assert.match(url, /^\/(api|events)/, url);
});

// ---------------------------------------------------------------- app.mjs (pure functions, no DOM)

const T = 1_760_000_000;

test('app.mjs imports in Node without a DOM (the browser start-up is guarded)', async () => {
  const app = await import('../../dashboard/app.mjs');
  for (const name of ['classifyBar', 'alertMarker', 'paperMarker', 'buildMarkers', 'isStale', 'timeframeSeconds', 'streamKey']) {
    assert.equal(typeof app[name], 'function', name);
  }
});

test('classifyBar: same candle time updates in place, anything else needs a refetch', async () => {
  const { classifyBar } = await import('../../dashboard/app.mjs');
  assert.equal(classifyBar(T, T), 'update');
  assert.equal(classifyBar(T, T + 3600), 'refetch', 'a new bar (a rollover may hide a gap)');
  assert.equal(classifyBar(T, T - 3600), 'refetch', 'a correction to an older candle');
  assert.equal(classifyBar(null, T), 'refetch', 'nothing loaded yet');
});

test('alertMarker: arrow plus glyph, never colour alone; unusable alerts give null', async () => {
  const { alertMarker } = await import('../../dashboard/app.mjs');
  const base = { barTime: T, symbol: 'S', timeframe: '60', message: 'Crossed 60000', title: 't' };
  assert.deepEqual(alertMarker({ ...base, direction: 'up', level: 'up' }), {
    time: T, position: 'belowBar', shape: 'arrowUp', tone: 'up', text: '↑',
  });
  assert.deepEqual(alertMarker({ ...base, direction: 'down', level: 'down' }), {
    time: T, position: 'aboveBar', shape: 'arrowDown', tone: 'down', text: '↓',
  });
  assert.equal(alertMarker({ ...base, direction: null, level: 'down' })?.shape, 'arrowDown', 'direction missing: use the level');
  assert.equal(alertMarker({ ...base, direction: null, level: 'info' }), null, 'no direction at all: no marker');
  assert.equal(alertMarker({ ...base, barTime: null, direction: 'up' }), null, 'recorded before meta existed');
});

test('paperMarker: entries and exits become squares with "P"; start and summary do not', async () => {
  const { paperMarker } = await import('../../dashboard/app.mjs');
  const entry = paperMarker({ type: 'entry', bar_time: T, price: 10, return_pct: null });
  assert.equal(entry.shape, 'square');
  assert.match(entry.text, /^P/);
  assert.equal(entry.time, T);
  assert.equal(entry.tone, 'paper');
  assert.equal(paperMarker({ type: 'exit', bar_time: T, price: 11, return_pct: 1.5 })?.shape, 'square');
  assert.equal(paperMarker({ type: 'start', bar_time: T }), null);
  assert.equal(paperMarker({ type: 'summary', bar_time: T }), null);
  assert.equal(paperMarker({ type: 'entry', bar_time: null }), null);
});

test('buildMarkers: only this stream, sorted by time (the chart library throws on unsorted markers)', async () => {
  const { buildMarkers } = await import('../../dashboard/app.mjs');
  const mine = { symbol: 'S', timeframe: '60' };
  const alerts = [
    { ...mine, barTime: T + 7200, direction: 'up', level: 'up', message: 'm' },
    { symbol: 'OTHER', timeframe: '60', barTime: T, direction: 'up', level: 'up', message: 'm' },
    { ...mine, barTime: T, direction: 'down', level: 'down', message: 'm' },
  ];
  const paper = [
    { symbol: 'S', timeframe: '60', events: [{ type: 'entry', bar_time: T + 3600, price: 1 }, { type: 'start', bar_time: T }] },
    { symbol: 'S', timeframe: '15', events: [{ type: 'entry', bar_time: T - 3600, price: 1 }] },
  ];
  const times = buildMarkers(alerts, paper, 'S', '60').map((m) => m.time);
  assert.deepEqual(times, [T, T + 3600, T + 7200]);
});

test('isStale: older than three bar periods, never for a stream with no bar yet', async () => {
  const { isStale, timeframeSeconds } = await import('../../dashboard/app.mjs');
  assert.equal(timeframeSeconds('15'), 900);
  assert.equal(timeframeSeconds('60'), 3600);
  assert.equal(timeframeSeconds('D'), 86_400);
  assert.equal(timeframeSeconds('W'), 604_800);
  assert.equal(timeframeSeconds('???'), null);
  assert.equal(isStale({ timeframe: '60', lastBarTime: T }, T + 3 * 3600), false);
  assert.equal(isStale({ timeframe: '60', lastBarTime: T }, T + 3 * 3600 + 1), true);
  assert.equal(isStale({ timeframe: '60', lastBarTime: null }, T), false);
  assert.equal(isStale({ timeframe: '???', lastBarTime: T }, T + 1e9), false, 'unknown timeframe: no claim');
});

// ---------------------------------------------------------------- served through the real server

test('the real files are served by createDashboard with the real allowlist', async (t) => {
  const dashboard = createDashboard({
    host: '127.0.0.1', port: 0, token: '', bus: new EventEmitter(), streams: { list: () => [], candles: () => null },
    getAlerts: () => [], rules: [], timezone: 'UTC', home: '/nonexistent', assets: defaultAssets(),
    logger: { info() {}, warn(m) { assert.fail(`asset missing: ${m}`); }, error() {} },
  });
  const { port } = await dashboard.listen();
  t.after(() => dashboard.close());
  const get = (path) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
  for (const path of ASSET_PATHS) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.ok(res.body.length > 0, path);
  }
  assert.match((await get('/')).body, /id="stream-picker"/);
});

test('app.mjs: the library attribution logo stays off (it injects a <style> element, which the CSP blocks)', async () => {
  assert.match(await read('app.mjs'), /attributionLogo:\s*false/);
});

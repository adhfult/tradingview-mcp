import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createDashboard, defaultAssets } from '../../lib/dashboard.mjs';
import { parseFrontmatter } from '../../lib/frontmatter.mjs';
import { parseNoteTime } from '../../lib/notes.mjs';

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
  // Not covered by script-src or style-src: a redirect, a form post, a base URL or an embedded page can still leave the origin.
  assert.doesNotMatch(html, /<(meta[^>]*http-equiv|form|base|iframe|frame|object|embed)\b/i);

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
  assert.doesNotMatch(js, /\.(innerHTML|outerHTML)\b|insertAdjacentHTML|setHTMLUnsafe|createContextualFragment|DOMParser|document\.write|\beval\s*\(|new Function|setAttribute\(\s*['"]style|style\.cssText|window\.open|location\s*(\.href\s*)?=[^=]/);
  assert.doesNotMatch(js, /\bimport\s*\(\s*[^'"/\s]/, 'dynamic import takes a literal');
  const imports = [...js.matchAll(/(?:from|import\s*\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)].filter((u) => u !== '/assets/lightweight-charts.mjs'), [], 'only the chart library is imported');
  // Every request goes through getJson(path) -> fetch(path), so check both ends: the one fetch call, and every getJson argument.
  assert.deepEqual([...js.matchAll(/\bfetch\(([^,)]*)/g)].map((m) => m[1]), ['path'], 'one fetch, inside getJson');
  const calls = [...js.matchAll(/\bgetJson\(\s*([`'"])([^`'"]*)/g)].map((m) => m[2]);
  assert.ok(calls.length >= 5, `found ${calls.length} getJson calls with a literal path`);
  for (const url of calls) assert.match(url, /^\/api\//, url);
  assert.equal([...js.matchAll(/\bgetJson\(/g)].length, calls.length + 1, 'every getJson call has a literal path (+1 for its definition)');
  for (const [, url] of js.matchAll(/EventSource\(\s*['"`]([^'"`]+)/g)) assert.equal(url, '/events');
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
  const code = (await read('app.mjs')).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''); // a comment must not satisfy this
  assert.match(code, /attributionLogo:\s*false/);
});

// ---------------------------------------------------------------- notes: index.html

test('index.html: a Notes panel with its status line and list, and an "Add note" link that has no href until the page sets one', async () => {
  const html = await read('index.html');
  for (const id of ['notes-title', 'notes-status', 'notes-list', 'add-note', 'add-note-hint']) assert.match(html, new RegExp(`\\sid="${id}"`), id);
  assert.match(html, /<section[^>]*aria-labelledby="notes-title"/);
  assert.match(html, /<a\b[^>]*\sid="add-note"[^>]*\shidden|<a\b[^>]*\shidden[^>]*\sid="add-note"/, 'hidden until a candle is picked');
  assert.doesNotMatch(html, /<a\b[^>]*\sid="add-note"[^>]*\shref=/, 'the href is set by app.mjs, after the scheme check');
  assert.doesNotMatch(html, /obsidian:/i, 'no hard-coded Obsidian link in the page');
});

// ---------------------------------------------------------------- notes: app.mjs (static)

test('app.mjs: the one href assignment sits next to the obsidian:// scheme check', async () => {
  const js = (await read('app.mjs')).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const hits = [...js.matchAll(/\.href\s*=[^=]/g)];
  assert.equal(hits.length, 1, 'exactly one place sets an href');
  assert.match(js.slice(Math.max(0, hits[0].index - 250), hits[0].index + 150), /safeObsidianHref\(/);
});

// ---------------------------------------------------------------- notes: pure functions

test('app.mjs exports the notes helpers', async () => {
  const app = await import('../../dashboard/app.mjs');
  for (const name of ['noteMarker', 'safeObsidianHref', 'newNoteLink', 'parseDeepLink', 'centerRange']) assert.equal(typeof app[name], 'function', name);
});

test('noteMarker: a blue circle on the last bar at or before the note\'s time, with the first letter of its kind', async () => {
  const { noteMarker } = await import('../../dashboard/app.mjs');
  const bars = [T, T + 3600, T + 7200];
  const at = (time, kind = 'news') => noteMarker({ time, kind, title: 'x' }, bars);
  assert.deepEqual(at(T + 1800), { time: T, position: 'aboveBar', shape: 'circle', tone: 'note', text: 'N' });
  assert.equal(at(T + 3600).time, T + 3600, 'a time exactly on a bar opens that bar');
  assert.equal(at(T + 7199).time, T + 3600);
  assert.equal(at(T + 999_999).time, T + 7200, 'after the last bar: the last bar');
  assert.equal(at(T - 1), null, 'before the first loaded bar: not on this chart');
  assert.equal(at(null), null, 'no time: the panel only');
  assert.equal(at(T, 'opportunity').text, 'O');
  assert.equal(at(T, 'risk').text, 'R');
  assert.equal(at(T, 'note').text, 'N');
  assert.equal(noteMarker({ time: T, kind: 'news' }, []), null, 'no candles loaded');
});

test('buildMarkers: notes join the alert and paper markers, still ascending by time', async () => {
  const { buildMarkers } = await import('../../dashboard/app.mjs');
  const bars = [T, T + 3600, T + 7200, T + 10_800];
  const alerts = [{ symbol: 'S', timeframe: '60', barTime: T + 7200, direction: 'up', level: 'up', message: 'm' }];
  const paper = [{ symbol: 'S', timeframe: '60', events: [{ type: 'entry', bar_time: T + 3600, price: 1 }] }];
  const notes = [{ time: T + 10_900, kind: 'risk' }, { time: T + 100, kind: 'news' }, { time: null, kind: 'news' }];
  const markers = buildMarkers(alerts, paper, 'S', '60', notes, bars);
  assert.deepEqual(markers.map((m) => [m.time, m.tone]), [[T, 'note'], [T + 3600, 'paper'], [T + 7200, 'up'], [T + 10_800, 'note']]);
  assert.deepEqual(buildMarkers(alerts, paper, 'S', '60').map((m) => m.tone), ['paper', 'up'], 'the notes arguments are optional');
});

test('safeObsidianHref: only a link that starts with exactly obsidian:// is accepted', async () => {
  const { safeObsidianHref } = await import('../../dashboard/app.mjs');
  const ok = 'obsidian://open?vault=My%20Vault&file=markets%2Fbtc';
  assert.equal(safeObsidianHref(ok), ok);
  assert.equal(safeObsidianHref('obsidian://new?vault=V&file=f&content=%23'), 'obsidian://new?vault=V&file=f&content=%23');
  for (const bad of [
    'javascript:alert(1)', 'data:text/html,x', 'https://evil.example/', '//evil.example', 'obsidian:/open', 'obsidian:open', 'OBSIDIAN://open',
    ' obsidian://open', 'x obsidian://open', 'obsidian://open with space', 'obsidian://open\nx', 'obsidian://open\t', 'obsidian://\u0000', '', 'obsidian://',
    null, undefined, 5, {}, ['obsidian://open'],
  ]) {
    assert.equal(safeObsidianHref(bad), null, JSON.stringify(bad));
  }
});

test('newNoteLink: obsidian://new with the vault, a safe file name and a content block the notes layer reads back', async () => {
  const { newNoteLink, safeObsidianHref } = await import('../../dashboard/app.mjs');
  const link = newNoteLink({ vault: 'My Vault & Co=1#2', folder: 'my markets', symbol: 'BINANCE:BTCUSDT', timeframe: '60', time: 1_760_000_000 });
  assert.equal(safeObsidianHref(link), link);
  assert.match(link, /^obsidian:\/\/new\?/);
  assert.doesNotMatch(link, /[ +]/, 'spaces are %20 and nothing is a plus sign');
  const pairs = link.slice('obsidian://new?'.length).split('&');
  assert.deepEqual(pairs.map((p) => p.split('=')[0]), ['vault', 'file', 'content'], 'a & or = in a value never splits a parameter');
  assert.ok(pairs.every((p) => p.split('=').length === 2));
  const params = new URLSearchParams(link.slice(link.indexOf('?') + 1));
  assert.equal(params.get('vault'), 'My Vault & Co=1#2');
  assert.equal(params.get('file'), 'my markets/BINANCE-BTCUSDT 1h 2025-10-09 0853');
  const parsed = parseFrontmatter(params.get('content'));
  assert.notEqual(parsed, null, 'the pre-filled content is readable frontmatter');
  assert.deepEqual(parsed.data.symbols, ['BINANCE:BTCUSDT']);
  assert.equal(parseNoteTime(parsed.data.time), 1_760_000_000);
  assert.equal(parsed.data.kind, 'note');
});

test('newNoteLink: characters Obsidian forbids in a file name never reach the name', async () => {
  const { newNoteLink } = await import('../../dashboard/app.mjs');
  const link = newNoteLink({ vault: 'V', folder: 'markets', symbol: 'A/B:C*D?E"F<G>H|I\\J', timeframe: 'D', time: 1_760_000_000 });
  const file = new URLSearchParams(link.slice(link.indexOf('?') + 1)).get('file');
  assert.match(file, /^markets\/[^\\/:*?"<>|]+$/);
  assert.match(file, / D /);
});

test('parseDeepLink: symbol, tf and t from the query string; a bad t is null', async () => {
  const { parseDeepLink } = await import('../../dashboard/app.mjs');
  assert.deepEqual(parseDeepLink('?symbol=BINANCE:BTCUSDT&tf=60&t=1760000000'), { symbol: 'BINANCE:BTCUSDT', timeframe: '60', t: 1_760_000_000 });
  assert.deepEqual(parseDeepLink('?symbol=BINANCE%3ABTCUSDT&tf=60'), { symbol: 'BINANCE:BTCUSDT', timeframe: '60', t: null });
  assert.deepEqual(parseDeepLink(''), { symbol: null, timeframe: null, t: null });
  for (const t of ['abc', '-5', '1e9', '1.5', '', '0', '99999999999999', ' 5']) assert.equal(parseDeepLink(`?symbol=S&tf=60&t=${t}`).t, null, `t=${t}`);
});

test('centerRange: a window of bars around the last bar at or before t, or null', async () => {
  const { centerRange } = await import('../../dashboard/app.mjs');
  const bars = Array.from({ length: 100 }, (_, i) => T + i * 3600);
  assert.deepEqual(centerRange(bars, bars[50], 80), { from: 10, to: 90 });
  assert.deepEqual(centerRange(bars, bars[50] + 1800, 80), { from: 10, to: 90 }, 'between bars: the earlier one');
  assert.deepEqual(centerRange(bars, bars[99] + 99_999, 80), { from: 59, to: 139 }, 'after the end: centred on the last bar');
  assert.equal(centerRange(bars, T - 1, 80), null, 'before the first bar');
  assert.equal(centerRange(bars, null, 80), null);
  assert.equal(centerRange([], T, 80), null);
});

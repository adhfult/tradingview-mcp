import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNews, appendNews } from '../../lib/news.mjs';
import { createStateStore, emptyState, prune } from '../../lib/state.mjs';
import { parseConfig } from '../../lib/config.mjs';
import { createAlerts } from '../../lib/alerts.mjs';
import { createWatcher, runCheckConfig } from '../../watcher.mjs';
import { createFakeClock, createFakeFetch, createFakeLib, jsonResponse, settle } from './support.mjs';

const NOW = Date.UTC(2026, 9, 14, 22);
const raw = { watchlist: [{ symbol: 'NASDAQ:AAPL', timeframes: ['60'] }], rules: [] };
const defaults = { enabled: true, every_minutes: 30, remember_hours: 72, max_age_minutes: 120,
  max_items_per_digest: 10, sources: { tradingview: true, sec: false }, tickers_extra: [],
  include_keywords: [], exclude_keywords: [], sec_forms: ['8-K', '10-Q', '10-K'] };
function item(id, symbol = 'NASDAQ:AAPL', at = NOW - 60_000, extra = {}) {
  return { id, title: `Headline ${id}`, published: at / 1000, relatedSymbols: [{ symbol }],
    storyPath: `/news/${id}/`, provider: { id: 'test', name: 'Test' }, ...extra };
}
function filing(id = '1', { cik = '0000320193', updated = new Date(NOW - 60_000).toISOString(), link = `https://www.sec.gov/Archives/${id}`, summary = 'Item 2.02: Results &lt;b&gt;html&lt;/b&gt;', title = `8-K - APPLE ${id}` } = {}) {
  return `<entry><id>filing:${id}</id><title>${title} (${cik}) (Filer)</title><link href="${link}"/><updated>${updated}</updated><summary>${summary}</summary></entry>`;
}
const feed = (entries) => `<feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
const map = { 0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple' },
  1: { cik_str: 1652044, ticker: 'GOOG', title: 'Alphabet' }, 2: { cik_str: 1652044, ticker: 'GOOGL', title: 'Alphabet' } };
async function build(t, { news = {}, symbols = ['NASDAQ:AAPL'], responder, persist = true, timeoutMs = 1000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'news-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = createFakeClock(NOW);
  const store = createStateStore({ dir, clock, persist });
  t.after(() => store.close());
  const logs = [], submissions = [], waits = [];
  let data = [item('seed')];
  const fake = createFakeFetch((url, init) => responder ? responder(url, init) : jsonResponse(200, { items: data }));
  const poller = createNews({ news: { ...defaults, ...news }, symbols, store, clock,
    alerts: { submit: (entry) => submissions.push(entry) }, logger: { info: (s) => logs.push(s), warn: (s) => logs.push(s) },
    fetch: fake.fetch, secContact: 'fixture@example.invalid', stateDir: dir, persist,
    sleep: async (ms) => waits.push(ms), timeoutMs });
  return { poller, clock, store, logs, submissions, waits, calls: fake.calls, dir, set: (v) => { data = v; } };
}

test('first poll seeds; new ticker seeds independently while existing ticker alerts', async (t) => {
  const symbols = ['NASDAQ:AAPL'];
  const b = await build(t, { symbols });
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 0);
  symbols.push('NASDAQ:MSFT'); b.clock.advance(60_000);
  b.set([item('new'), item('msft', 'NASDAQ:MSFT')]);
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 1);
  assert.match(b.submissions[0].message.lines.join('\n'), /Headline new/);
  assert.doesNotMatch(b.submissions[0].message.lines.join('\n'), /Headline msft/);
  b.set([item('msft2', 'NASDAQ:MSFT')]);
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 2);
});

test('dedupe persists across restarts for 72h rather than the alerts 24h', async (t) => {
  const b = await build(t, { news: { max_age_minutes: 6000 } });
  await b.poller.runOnce(); b.set([item('new')]); await b.poller.runOnce();
  await b.store.flush();
  const other = createStateStore({ dir: b.dir, clock: b.clock });
  await other.load();
  const submissions = [];
  const poller = createNews({ news: { ...defaults, max_age_minutes: 6000 }, symbols: ['NASDAQ:AAPL'], store: other, clock: b.clock,
    alerts: { submit: (x) => submissions.push(x) }, logger: { info() {}, warn() {} },
    fetch: async () => jsonResponse(200, { items: [item('new')] }), stateDir: b.dir, sleep: async () => {} });
  b.clock.advance(25 * 3600_000); prune(other.state, b.clock.now()); await poller.runOnce();
  assert.equal(submissions.length, 0);
  b.clock.advance(48 * 3600_000); prune(other.state, b.clock.now()); await poller.runOnce();
  assert.equal(submissions.length, 1);
  await other.close();
});

test('age floor drops stale and future news but accepts the exact floor', async (t) => {
  const b = await build(t); await b.poller.runOnce();
  b.set([item('stale', 'NASDAQ:AAPL', NOW - 120 * 60_000 - 1), item('floor', 'NASDAQ:AAPL', NOW - 120 * 60_000), item('future', 'NASDAQ:AAPL', NOW + 1)]);
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 1);
  const text = b.submissions[0].message.lines.join('\n');
  assert.match(text, /Headline floor/); assert.doesNotMatch(text, /Headline stale|Headline future/);
});

test('one digest caps displayed items, puts links on separate lines and records every new item', async (t) => {
  const b = await build(t, { news: { max_items_per_digest: 2 } }); await b.poller.runOnce();
  b.set([item('one'), item('two'), item('three')]); await b.poller.runOnce();
  assert.equal(b.submissions.length, 1); assert.equal(b.submissions[0].kind, 'news');
  assert.match(b.submissions[0].message.lines.join('\n'), /Headline one\nhttps:\/\/www.tradingview.com\/news\/one\//);
  assert.match(b.submissions[0].message.lines.join('\n'), /\+1 more/);
  const rows = (await readFile(join(b.dir, 'news.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3); assert.equal(rows[2].title, 'Headline three');
  assert.equal((await stat(join(b.dir, 'news.jsonl'))).mode & 0o777, 0o600);
});

test('keyword filters are case-insensitive, exclude wins, control chars stripped and fields capped', async (t) => {
  const b = await build(t, { news: { include_keywords: ['earn'], exclude_keywords: ['rumor'] } }); await b.poller.runOnce();
  b.set([item('good', undefined, undefined, { title: 'EARN\u0001ings @everyone <b>result</b>' + 'x'.repeat(1000) }),
    item('bad', undefined, undefined, { title: 'EARNings RUMOR' }), item('other')]);
  await b.poller.runOnce();
  const text = b.submissions[0].message.lines.join('\n');
  assert.match(text, /EARNings @everyone <b>result<\/b>/); assert.doesNotMatch(text, /\u0001|RUMOR|Headline other/);
  assert.ok(text.length < 1000);
});

test('unsafe TradingView paths are skipped and external link is ignored', async (t) => {
  const b = await build(t); await b.poller.runOnce();
  b.set(['//evil.test/x', 'https://evil.test', '/news/x?token=secret', '/news/../x'].map((storyPath, i) => item(`bad${i}`, undefined, undefined, { storyPath }))
    .concat(item('safe', undefined, undefined, { link: 'https://evil.test/token' })));
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 1); assert.equal(b.submissions[0].message.lines.length, 2);
  assert.match(b.submissions[0].message.lines[1], /^https:\/\/www.tradingview.com\/news\/safe\//);
});

test('TradingView request uses a comma OR filter and one cursor follow-up when a gap needs coverage', async (t) => {
  let round = 0;
  const b = await build(t, { symbols: ['NASDAQ:AAPL', 'NYSE:JPM'], responder: (url) => {
    const u = new URL(url); assert.deepEqual(u.searchParams.getAll('filter'), ['lang:en', 'symbol:NASDAQ:AAPL,NYSE:JPM']);
    if (round === 0) return jsonResponse(200, { items: [item('seed', undefined, NOW - 3600_000)] });
    return jsonResponse(200, u.searchParams.has('pagination') ? { items: [item('older', undefined, NOW - 60_000)] } :
      { items: [item('fresh', undefined, NOW + 30_000)], pagination: { cursor: 'fixture-cursor' } });
  } });
  await b.poller.runOnce(); round++; b.clock.advance(60_000); await b.poller.runOnce();
  assert.equal(b.calls.length, 3);
  assert.equal(new URL(b.calls[2].url).searchParams.get('pagination'), 'fixture-cursor');
  assert.equal(b.submissions.length, 1);
  assert.match(b.submissions[0].message.lines.join('\n'), /Headline older/);
});

test('a gap without a cursor or still present after the follow-up is logged', async (t) => {
  const b = await build(t); await b.poller.runOnce(); b.clock.advance(60_000);
  b.set([item('fresh', undefined, NOW + 30_000)]); await b.poller.runOnce();
  assert.ok(b.logs.some((s) => /gap/i.test(s)));
});

test('empty, malformed or failed responses change no news state and do not log upstream URLs', async (t) => {
  let mode = 0;
  const b = await build(t, { responder: () => {
    if (mode === 0) return jsonResponse(200, { items: [] });
    if (mode === 1) return jsonResponse(200, { nope: [] });
    throw new Error('https://evil.test/?token=must-never-appear');
  } });
  for (mode = 0; mode < 3; mode++) {
    const before = structuredClone(b.store.state); await b.poller.runOnce();
    assert.deepEqual(b.store.state, before);
  }
  assert.equal(b.submissions.length, 0); assert.doesNotMatch(b.logs.join('\n'), /must-never-appear/);
});

for (const failed of ['sec', 'tradingview']) test(`${failed} failure does not stop the other source`, async (t) => {
  let round = 0;
  const b = await build(t, { news: { sources: { sec: true, tradingview: true }, sec_forms: ['8-K'] }, responder: (url, init) => {
    const sec = new URL(url).hostname === 'www.sec.gov';
    if ((sec ? 'sec' : 'tradingview') === failed) throw new Error('fixture failure');
    if (sec) assert.match(init.headers['User-Agent'], /fixture@example.invalid/);
    if (url.includes('company_tickers')) return jsonResponse(200, map);
    return sec ? new Response(feed(filing(String(round)))) : jsonResponse(200, { items: [item(String(round))] });
  } });
  await b.poller.runOnce(); round++; await b.poller.runOnce();
  assert.equal(b.submissions.length, 1);
});

test('SEC maps padded CIK to both tickers, only renders item numbers, caches map on disk for 24h', async (t) => {
  let round = 0;
  const b = await build(t, { symbols: ['NASDAQ:GOOG', 'NASDAQ:GOOGL'], news: { sources: { sec: true, tradingview: false }, sec_forms: ['8-K'] },
    responder: (url, init) => {
      assert.match(init.headers['User-Agent'], /fixture@example.invalid/);
      return url.includes('company_tickers') ? jsonResponse(200, map) : new Response(feed(filing(String(round), { cik: '0001652044' })));
    } });
  await b.poller.runOnce(); round++; await b.poller.runOnce();
  const text = b.submissions[0].message.lines.join('\n');
  assert.match(text, /NASDAQ:GOOG, NASDAQ:GOOGL/); assert.match(text, /2\.02/); assert.doesNotMatch(text, /html|Results/);
  assert.equal(b.calls.filter((x) => x.url.includes('company_tickers')).length, 1);
  const second = createNews({ news: { ...defaults, sources: { sec: true, tradingview: false }, sec_forms: ['8-K'] }, symbols: ['NASDAQ:GOOG'],
    store: b.store, clock: b.clock, alerts: { submit() {} }, logger: { info() {}, warn() {} }, stateDir: b.dir,
    secContact: 'fixture@example.invalid', fetch: async (url) => { assert.ok(!url.includes('company_tickers')); return new Response(feed(filing())); }, sleep: async () => {} });
  await second.runOnce(); b.clock.advance(24 * 3600_000 + 1); await b.poller.runOnce();
  assert.equal(b.calls.filter((x) => x.url.includes('company_tickers')).length, 2);
  assert.ok(b.waits.every((ms) => ms >= 250));
});

test('SEC follow-up uses start=100, once per form, and logs residual gaps', async (t) => {
  let round = 0;
  const b = await build(t, { news: { sources: { sec: true, tradingview: false } }, responder: (url) => {
    if (url.includes('company_tickers')) return jsonResponse(200, map);
    return new Response(feed(filing('x', { updated: new Date(NOW + (round ? 30_000 : -60_000)).toISOString() })));
  } });
  await b.poller.runOnce(); round++; b.clock.advance(60_000); await b.poller.runOnce();
  const follow = b.calls.filter((x) => new URL(x.url).searchParams.get('start') === '100');
  assert.equal(follow.length, 3); assert.ok(b.logs.some((s) => /gap/i.test(s)));
});

test('SEC rejects non-SEC links and reports skipped entries without losing valid filings', async (t) => {
  let round = 0;
  const b = await build(t, { news: { sources: { sec: true, tradingview: false }, sec_forms: ['8-K'] }, responder: (url) =>
    url.includes('company_tickers') ? jsonResponse(200, map) : new Response(feed(round === 0 ? filing('seed') :
      filing('missing').replace(/<summary>.*?<\/summary>/, '') + filing('evil', { link: 'https://evil.test/path' }) + filing('good'))) });
  await b.poller.runOnce(); round++; await b.poller.runOnce();
  assert.equal(b.submissions.length, 1); assert.equal(b.submissions[0].message.lines.length, 2);
  assert.ok(b.logs.some((s) => /skipped/i.test(s)));
});

test('missing SEC contact disables only SEC and never sends an anonymous SEC request', async (t) => {
  const b = await build(t);
  const poller = createNews({ news: { ...defaults, sources: { sec: true, tradingview: false } }, symbols: ['NASDAQ:AAPL'],
    store: b.store, clock: b.clock, alerts: { submit() { assert.fail('no alerts'); } }, logger: { info() {}, warn: (s) => b.logs.push(s) },
    stateDir: b.dir, fetch: async () => assert.fail('no SEC request') });
  await poller.runOnce(); assert.ok(b.logs.some((s) => /WATCHER_SEC_CONTACT/.test(s)));
});

test('response bytes, timeout and redirect restrictions bound untrusted requests', async (t) => {
  for (const responder of [() => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    () => new Response(null, { status: 302, headers: { location: 'https://evil.test/?token=secret' } }),
    () => new Response(null, { status: 302, headers: { location: 'http://news-mediator.tradingview.com/x' } }),
    () => new Promise(() => {})]) {
    const b = await build(t, { responder, timeoutMs: 20 });
    const before = structuredClone(b.store.state); await b.poller.runOnce();
    assert.deepEqual(b.store.state, before); assert.equal(b.calls.length, 1);
  }
});

test('source request budgets and chunk size are hard-capped', async (t) => {
  const symbols = Array.from({ length: 1200 }, (_, i) => `NYSE:T${i}`);
  const b = await build(t, { symbols, responder: (url) => {
    const selected = new URL(url).searchParams.getAll('filter')[1].slice(7).split(',');
    assert.ok(selected.length <= 50);
    return jsonResponse(200, { items: [item('x', selected[0])] });
  } });
  await b.poller.runOnce(); assert.ok(b.calls.length <= 20); assert.ok(b.logs.some((s) => /budget/i.test(s)));
});

test('concurrent polls do not overlap', async (t) => {
  let resolve;
  const b = await build(t, { responder: () => new Promise((r) => { resolve = r; }) });
  const first = b.poller.runOnce(); await settle();
  assert.equal(await b.poller.runOnce(), false);
  resolve(jsonResponse(200, { items: [item('seed')] })); await first;
  assert.equal(b.calls.length, 1);
});

test('capped JSONL retains newest complete records, and dry-run never writes', async (t) => {
  const b = await build(t);
  const path = join(b.dir, 'news.jsonl');
  await appendNews({ dir: b.dir, items: [{ title: 'a' }, { title: 'b' }, { title: 'c' }], maxBytes: 35 });
  assert.equal(await readFile(path, 'utf8'), '{"title":"b"}\n{"title":"c"}\n');
  const dry = await build(t, { persist: false }); await dry.poller.runOnce(); dry.set([item('new')]); await dry.poller.runOnce();
  await assert.rejects(readFile(join(dry.dir, 'news.jsonl')), { code: 'ENOENT' });
});

test('news pruning drops expired seen keys, bounds history, and preserves seeded symbols', () => {
  const s = emptyState();
  s.news.seen.old = NOW - 72 * 3600_000 - 1; s.news.seen.edge = NOW - 72 * 3600_000;
  s.news.seeded['tradingview|NASDAQ:AAPL'] = NOW - 100 * 3600_000;
  prune(s, NOW);
  assert.equal(s.news.seen.old, undefined); assert.equal(s.news.seen.edge, NOW - 72 * 3600_000);
  assert.ok(s.news.seeded['tradingview|NASDAQ:AAPL']);
  for (let i = 0; i < 2100; i++) s.news.runs[`tradingview|NYSE:T${i}`] = NOW + i;
  prune(s, NOW);
  assert.ok(Object.keys(s.news.runs).length <= 2000);
});

test('news config defaults off, validates bounds and switches, warns about bare symbols', () => {
  assert.equal(parseConfig(raw).config.news.enabled, false);
  for (const news of [{ every_minutes: 9 }, { remember_hours: 0 }, { max_age_minutes: -1 }, { max_items_per_digest: 0 },
    { sources: { sec: 'yes' } }, { tickers_extra: ['bad symbol'] }, { tickers_extra: ['NASDAQ::AAPL'] },
    { tickers_extra: [':AAPL'] }, { tickers_extra: ['NASDAQ:'] }, { sec_forms: ['S-1'] }, { include_keywords: [1] }, { typo: true }]) {
    assert.ok(parseConfig({ ...raw, news }).errors.length > 0, JSON.stringify(news));
  }
  const result = parseConfig({ ...raw, news: { tickers_extra: ['msft', 'nasdaq:msft'] } });
  assert.deepEqual(result.errors, []); assert.ok(result.warnings.some((s) => /prefix|EXCHANGE/.test(s)));
  assert.deepEqual(result.config.news.tickers_extra, ['MSFT', 'NASDAQ:MSFT']);
});

test('--check-config accepts the new block and warns for bare news symbols', async (t) => {
  const b = await build(t); const path = join(b.dir, 'config.json');
  await writeFile(path, JSON.stringify({ ...raw, news: { enabled: true, tickers_extra: ['MSFT'] } }));
  let output = '', warnings = '';
  assert.equal(await runCheckConfig({ configPath: path, env: {}, out: (s) => { output += s; }, err: (s) => { warnings += s; }, redact: (s) => s }), 0);
  assert.equal(output, 'OK\n'); assert.match(warnings, /prefix|EXCHANGE/);
});

test('news digest uses the real alerts pipeline hourly cap and quiet hours', async (t) => {
  const b = await build(t); const delivered = [];
  const alerts = createAlerts({ alerts: { cooldown_minutes: 0, max_per_hour: 1, quiet_hours: null, digest_after_quiet: true }, timezone: 'UTC',
    store: b.store, clock: b.clock, queue: { enqueue: (msg) => delivered.push(msg) } });
  const poller = createNews({ news: defaults, symbols: ['NASDAQ:AAPL'], store: b.store, clock: b.clock, alerts,
    logger: { info() {}, warn() {} }, fetch: async () => jsonResponse(200, { items: [item(String(b.clock.now()))] }), stateDir: b.dir });
  await poller.runOnce(); b.clock.advance(1); await poller.runOnce(); b.clock.advance(1); await poller.runOnce();
  assert.equal(delivered.length, 1); assert.equal(b.store.state.sends.length, 1); assert.equal(b.store.state.digest.overflow.length, 1);
  const quiet = createAlerts({ alerts: { cooldown_minutes: 0, max_per_hour: 1, quiet_hours: { start: '21:00', end: '23:00' }, digest_after_quiet: true }, timezone: 'UTC',
    store: b.store, clock: b.clock, queue: { enqueue: (msg) => delivered.push(msg) } });
  quiet.submit(b.submissions[0] ?? { kind: 'news', summary: 'news', message: { title: 'news', lines: [], level: 'info' } });
  assert.equal(b.store.state.digest.held.length, 1);
});

test('watcher starts news independently of an unresolved trending scan and reschedules it', async (t) => {
  const b = await build(t, { persist: false });
  const { config } = parseConfig({ ...raw, state_dir: b.dir, news: { enabled: true, sources: { sec: false } },
    trending: { enabled: true, markets: ['crypto'], kinds: ['gainers'] }, dashboard: { enabled: false }, local_api: { enabled: false }, health: { daily_heartbeat: null } });
  let release; let fetches = 0;
  const watcher = createWatcher({ config, env: {}, dryRun: true, clock: b.clock, fetch: async () => {
    fetches++; return jsonResponse(200, { items: [item('seed')] });
  },
    lib: createFakeLib({ hotlist: () => new Promise((r) => { release = r; }) }) });
  await watcher.start(); const tick = watcher.tick(); await settle();
  assert.ok(Object.keys(watcher.state.state.news.seeded).length > 0);
  b.clock.advance(29 * 60_000); await settle(); assert.equal(fetches, 1);
  b.clock.advance(60_000); await settle(); assert.equal(fetches, 2);
  release({ rows: [] }); await tick;
  await watcher.stop();
});

test('recorded TradingView fixture and both SEC pages normalize without network access', async (t) => {
  const tv = JSON.parse(await readFile(new URL('./fixtures/tradingview-newsflow-3tickers.json', import.meta.url), 'utf8'));
  const pages = await Promise.all([1, 2].map((n) => readFile(new URL(`./fixtures/sec-getcurrent-8k-page${n}.atom`, import.meta.url), 'utf8')));
  const b = await build(t, { symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT', 'NYSE:JPM'], news: { sources: { sec: true, tradingview: true }, sec_forms: ['8-K'] }, responder: (url) => {
    if (url.includes('company_tickers')) return jsonResponse(200, map);
    if (url.includes('sec.gov')) return new Response(pages[new URL(url).searchParams.get('start') === '100' ? 1 : 0]);
    return jsonResponse(200, tv);
  } });
  await b.poller.runOnce(); assert.equal(b.submissions.length, 0);
  assert.ok(Object.keys(b.store.state.news.seen).length >= 25);
});

test('first SEC run seeds every form, including different filings from later forms', async (t) => {
  const b = await build(t, { news: { sources: { sec: true, tradingview: false } }, responder: (url) => {
    if (url.includes('company_tickers')) return jsonResponse(200, map);
    const form = new URL(url).searchParams.get('type');
    return new Response(feed(filing(form, { title: `${form} - APPLE` })));
  } });
  await b.poller.runOnce(); assert.equal(b.submissions.length, 0);
});

test('adding a ticker preserves gap detection for existing tickers in that chunk', async (t) => {
  const symbols = ['NASDAQ:AAPL']; let round = 0;
  const b = await build(t, { symbols, responder: (url) => {
    if (!round) return jsonResponse(200, { items: [item('seed')] });
    return jsonResponse(200, new URL(url).searchParams.has('pagination')
      ? { items: [item('older', undefined, NOW - 60_000)] }
      : { items: [item('new', undefined, NOW + 1)], pagination: { cursor: 'next' } });
  } });
  await b.poller.runOnce(); round++; symbols.push('NYSE:JPM'); b.clock.advance(60_000);
  await b.poller.runOnce(); assert.equal(b.calls.length, 3);
});

test('null news config is rejected rather than silently disabling news', () => {
  assert.ok(parseConfig({ ...raw, news: null }).errors.some((s) => /news/.test(s)));
});

test('news stops during a fetch without state changes or late alerts', async (t) => {
  let resolve;
  const b = await build(t, { responder: () => new Promise((r) => { resolve = r; }) });
  const before = structuredClone(b.store.state); const run = b.poller.runOnce(); await settle();
  b.poller.stop(); resolve(jsonResponse(200, { items: [item('seed')] })); await run;
  assert.deepEqual(b.store.state, before); assert.equal(b.submissions.length, 0);
});

test('same title and ticker within six hours dedupe across source IDs and URLs', async (t) => {
  const b = await build(t); await b.poller.runOnce();
  b.set([item('one', undefined, undefined, { title: 'Business Update' })]); await b.poller.runOnce();
  b.set([item('two', undefined, undefined, { title: 'BUSINESS   Update' })]); await b.poller.runOnce();
  assert.equal(b.submissions.length, 1);
});

test('same URL dedupes even when the headline and source ID change', async (t) => {
  const b = await build(t); await b.poller.runOnce();
  b.set([item('one')]); await b.poller.runOnce();
  b.set([item('two', undefined, undefined, { storyPath: '/news/one/' })]); await b.poller.runOnce();
  assert.equal(b.submissions.length, 1);
});

test('TradingView and SEC produce one item for a shared headline and ticker', async (t) => {
  let round = 0;
  const b = await build(t, { news: { sources: { tradingview: true, sec: true }, sec_forms: ['8-K'] }, responder: (url) => {
    if (url.includes('company_tickers')) return jsonResponse(200, map);
    if (url.includes('sec.gov')) return new Response(feed(filing(String(round))));
    return jsonResponse(200, { items: [item(String(round), undefined, undefined, { title: `8-K - APPLE ${round} (0000320193) (Filer)` })] });
  } });
  await b.poller.runOnce(); round++; await b.poller.runOnce();
  assert.equal(b.submissions.length, 1); assert.equal(b.submissions[0].message.lines.length, 2);
  assert.equal((await readFile(join(b.dir, 'news.jsonl'), 'utf8')).trim().split('\n').length, 1);
});

test('a same-host redirect loop stops after two redirects and preserves state', async (t) => {
  const b = await build(t, { responder: () => new Response(null, { status: 302,
    headers: { location: 'https://news-mediator.tradingview.com/loop' } }) });
  const before = structuredClone(b.store.state); await b.poller.runOnce();
  assert.equal(b.calls.length, 3); assert.deepEqual(b.store.state, before);
});

test('a new ticker in an earlier chunk cannot swallow a shared story for an established ticker', async (t) => {
  const symbols = [...Array.from({ length: 50 }, (_, i) => `NYSE:T${i}`), 'NASDAQ:AAPL'];
  let round = 0;
  const b = await build(t, { symbols, responder: (url) => {
    const requested = new URL(url).searchParams.getAll('filter')[1].slice(7).split(',');
    return jsonResponse(200, { items: [round ? item('shared', undefined, undefined, {
      relatedSymbols: [{ symbol: 'NASDAQ:MSFT' }, { symbol: 'NASDAQ:AAPL' }],
    }) : item(`seed-${requested[0]}`, requested[0])] });
  } });
  await b.poller.runOnce(); round++; symbols.unshift('NASDAQ:MSFT'); await b.poller.runOnce();
  assert.equal(b.submissions.length, 1);
  assert.match(b.submissions[0].message.lines.join('\n'), /NASDAQ:AAPL/);
  assert.doesNotMatch(b.submissions[0].message.lines.join('\n'), /NASDAQ:MSFT/);
});

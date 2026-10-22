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
import { discordPayload, telegramPayload } from '../../lib/notifiers.mjs';

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
  // maxRetries: a write still finishing when the test ends would make the delete fail with ENOTEMPTY
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
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

test('R1 digest preserves underscores in validated symbols', async (t) => {
  const b = await build(t, { symbols: ['NSE:M_M'] });
  b.set([item('seed', 'NSE:M_M')]); await b.poller.runOnce();
  b.set([item('new', 'NSE:M_M', undefined, { title: '[New] _headline_' })]);
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 1);
  assert.equal(b.submissions[0].message.lines[0], 'NSE:M_M · New headline');
});

for (const source of ['tradingview', 'sec']) {
  test(`R2 ${source} future-only first page leaves a new symbol unseeded until its valid backlog`, async (t) => {
    let future = true;
    const b = await build(t, { news: { sources: { tradingview: source === 'tradingview', sec: source === 'sec' },
      sec_forms: ['8-K'] }, responder: (url) => {
      if (url.includes('company_tickers')) return jsonResponse(200, map);
      const at = future ? Date.UTC(2100, 0, 1) : NOW - 60_000;
      return source === 'tradingview' ? jsonResponse(200, { items: [item(future ? 'future' : 'backlog', undefined, at)] })
        : new Response(feed(filing(future ? 'future' : 'backlog', { updated: new Date(at).toISOString() })));
    } });
    await b.poller.runOnce();
    const first = structuredClone(b.store.state.news);
    future = false; await b.poller.runOnce();
    assert.equal(b.submissions.length, 0, `${source}: first valid backlog must seed silently`);
    assert.deepEqual(first.seeded, {}, `${source}: future-only page must not seed`);
    assert.deepEqual(first.runs, {}, `${source}: future-only page must not advance runs`);
    assert.equal(Object.keys(b.store.state.news.seeded).length, 1);
    assert.equal(Object.keys(b.store.state.news.runs).length, 1);
  });
}

test('R2 a future-only symbol does not block another symbol from seeding and alerting', async (t) => {
  const b = await build(t, { symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'] });
  const future = item('future', 'NASDAQ:MSFT', Date.UTC(2100, 0, 1));
  b.set([item('seed'), future]); await b.poller.runOnce();
  b.set([item('new'), item('backlog', 'NASDAQ:MSFT')]); await b.poller.runOnce();
  assert.equal(b.submissions.length, 1);
  assert.match(b.submissions[0].message.lines.join('\n'), /Headline new/);
  assert.doesNotMatch(b.submissions[0].message.lines.join('\n'), /Headline backlog/);
});

test('R5 stopping during the first SEC form skips remaining forms without failure warnings', async (t) => {
  const b = await build(t, { news: { sources: { tradingview: false, sec: true } }, responder: (url) => {
    if (url.includes('company_tickers')) return jsonResponse(200, map);
    b.poller.stop();
    return new Response(feed(filing('stopping')));
  } });
  await b.poller.runOnce();
  assert.equal(b.calls.filter(({ url }) => url.includes('browse-edgar')).length, 1);
  assert.ok(!b.logs.some((line) => line.includes('request or response failed')), b.logs.join('\n'));
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

test('M2 age floor defers future news without remembering it and accepts the exact floor', async (t) => {
  const b = await build(t); await b.poller.runOnce();
  b.set([item('stale', 'NASDAQ:AAPL', NOW - 120 * 60_000 - 1), item('floor', 'NASDAQ:AAPL', NOW - 120 * 60_000), item('future', 'NASDAQ:AAPL', NOW + 1)]);
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 1);
  const text = b.submissions[0].message.lines.join('\n');
  assert.match(text, /Headline floor/); assert.doesNotMatch(text, /Headline stale|Headline future/);
  b.clock.advance(1);
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 2, 'deferred future story alerts when the clock catches up');
  assert.match(b.submissions[1].message.lines.join('\n'), /Headline future/);
});

test('M2 age check reads the clock after the fetch rather than at run start', async (t) => {
  let round = 0;
  const b = await build(t, { responder: () => {
    if (!round) return jsonResponse(200, { items: [item('seed')] });
    b.clock.advance(1000);
    return jsonResponse(200, { items: [item('during-fetch', undefined, NOW + 500)] });
  } });
  await b.poller.runOnce(); round++;
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 1);
  assert.match(b.submissions[0].message.lines.join('\n'), /Headline during-fetch/);
});

test('M2 future entries change neither seen keys nor title keys', async (t) => {
  const b = await build(t); await b.poller.runOnce();
  const { seen, titles } = structuredClone(b.store.state.news);
  b.set([item('ahead', undefined, NOW + 60_000)]);
  await b.poller.runOnce();
  assert.deepEqual(b.store.state.news.seen, seen);
  assert.deepEqual(b.store.state.news.titles, titles);
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
  assert.match(text, /EARNings @everyone bresult\/b/); assert.doesNotMatch(text, /\u0001|RUMOR|Headline other/);
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
  for (const responder of [() => new Response(JSON.stringify({ items: [item('oversized')], padding: 'x'.repeat(2 * 1024 * 1024) })),
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

test('M3 1000 stories for 50 tickers never re-alert after bounded dedupe eviction or restart', async (t) => {
  const symbols = Array.from({ length: 50 }, (_, i) => `NYSE:T${i}`);
  const b = await build(t, { symbols });
  b.set(Array.from({ length: 1000 }, (_, i) => item(`bulk-${i}`, symbols[0], NOW - 60_000,
    { relatedSymbols: symbols.map((symbol) => ({ symbol })) })));
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 0);
  assert.ok(Object.keys(b.store.state.news.seen).length <= 20_000);
  assert.ok(Object.keys(b.store.state.news.titles).length <= 20_000);
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 0, 'retained feed items stay suppressed after eviction');
  await b.store.flush();
  const reloaded = createStateStore({ dir: b.dir, clock: b.clock });
  t.after(() => reloaded.close()); await reloaded.load();
  const poller = createNews({ news: defaults, symbols, store: reloaded, clock: b.clock,
    alerts: { submit: (entry) => b.submissions.push(entry) }, logger: { info() {}, warn() {} },
    fetch: async () => jsonResponse(200, { items: [item('old-unseen', symbols[0], NOW - 1)] }), persist: false });
  await poller.runOnce();
  assert.equal(b.submissions.length, 0, 'eviction floor survives restart');
  b.clock.advance(1); b.set([item('after-floor', symbols[0], NOW + 1)]);
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 1, 'stories published after the floor remain eligible');
});

test('R3 M3 unseen publication at the eviction floor is suppressed; 1 ms after alerts', async (t) => {
  const b = await build(t, { persist: false });
  await b.poller.runOnce();
  for (let i = 0; i < 20_001; i++) b.store.state.news.seen[`boundary-${i}`] = NOW;
  prune(b.store.state, NOW);
  b.clock.advance(1);
  b.set([item('at-floor', undefined, NOW), item('after-floor', undefined, NOW + 1)]);
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 1);
  assert.deepEqual(b.submissions[0].message.lines, [
    'NASDAQ:AAPL · Headline after-floor', 'https://www.tradingview.com/news/after-floor/',
  ]);
});

test('news config defaults off, validates bounds and switches, warns about bare symbols', () => {
  assert.equal(parseConfig(raw).config.news.enabled, false);
  for (const news of [{ every_minutes: 9 }, { remember_hours: 0 }, { max_age_minutes: -1 }, { max_items_per_digest: 0 },
    { sources: { sec: 'yes' } }, { tickers_extra: ['bad symbol'] }, { tickers_extra: ['NASDAQ::AAPL'] },
    { tickers_extra: [':AAPL'] }, { tickers_extra: ['NASDAQ:'] }, { sec_forms: ['S-1'] }, { include_keywords: [1] }, { typo: true }]) {
    assert.ok(parseConfig({ ...raw, news }).errors.length > 0, JSON.stringify(news));
  }
  const result = parseConfig({ ...raw, news: { enabled: true, tickers_extra: ['msft', 'nasdaq:msft'] } });
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
  const { config } = parseConfig({ ...raw, state_dir: b.dir, news: { enabled: true, sources: { sec: false, tickertick: false } },
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

test('M1 stop during chunk 2 still records and submits committed chunk 1 stories', async (t) => {
  const symbols = Array.from({ length: 51 }, (_, i) => `NYSE:T${i}`);
  let round = 0, release, entered;
  const chunk2 = new Promise((r) => { entered = r; });
  const b = await build(t, { symbols, responder: (url) => {
    const selected = new URL(url).searchParams.getAll('filter')[1].slice(7).split(',');
    if (round && selected[0] === 'NYSE:T50') {
      entered(); return new Promise((r) => { release = r; });
    }
    return jsonResponse(200, { items: [item(round ? 'committed' : 'seed', selected[0])] });
  } });
  await b.poller.runOnce(); round++;
  const run = b.poller.runOnce(); await chunk2;
  b.poller.stop(); release(jsonResponse(200, { items: [item('uncommitted', 'NYSE:T50')] }));
  await run;
  assert.equal(b.submissions.length, 1);
  assert.match(b.submissions[0].message.lines.join('\n'), /Headline committed/);
  assert.doesNotMatch(b.submissions[0].message.lines.join('\n'), /Headline uncommitted/);
  const rows = (await readFile(join(b.dir, 'news.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map((row) => row.id), ['committed']);
});

test('M1 watcher waits for news before closing its queue, with a bounded wait', async (t) => {
  for (const releaseBeforeDeadline of [true, false]) {
    const b = await build(t, { persist: false });
    const { config, errors } = parseConfig({ ...raw, state_dir: b.dir, news: { enabled: true, sources: { sec: false } },
      dashboard: { enabled: false }, local_api: { enabled: false }, health: { daily_heartbeat: null }, alerts: { quiet_hours: null } });
    assert.deepEqual(errors, []);
    const output = [], logs = [];
    const watcher = createWatcher({ config, env: {}, dryRun: true, clock: b.clock, lib: createFakeLib(),
      write: (s) => output.push(s), logWrite: (s) => logs.push(s) });
    let release, closed = false;
    const digest = { level: 'info', title: 'Committed news digest', lines: ['Committed headline'], timestamp: new Date(NOW).toISOString() };
    watcher.news.runOnce = () => new Promise((r) => { release = r; }).then(() => {
      watcher.alerts.submit({ kind: 'news', message: digest, summary: 'Committed headline' });
      return true;
    });
    const close = watcher.queue.close;
    watcher.queue.close = () => { closed = true; close(); };
    await watcher.start(); await watcher.tick();
    const stopping = watcher.stop(); await settle();
    try {
      assert.equal(closed, false, 'queue stays open for the in-flight news digest');
    } finally {
      if (releaseBeforeDeadline) release(true);
      else b.clock.advance(5000);
      await stopping;
      release(true);
    }
    await settle();
    assert.equal(closed, true);
    assert.equal(watcher.state.state.alerts.filter((entry) => entry.kind === 'news').length, 1,
      'even a fake that ignores abort must finish submitting its committed digest');
    if (releaseBeforeDeadline) {
      assert.match(output.join('\n'), /Committed news digest/);
      assert.doesNotMatch(logs.join('\n'), /alert dropped: the watcher is shutting down/);
    } else {
      assert.doesNotMatch(output.join('\n'), /Committed news digest/);
      assert.match(logs.join('\n'), /alert dropped: the watcher is shutting down/);
    }
  }
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

test('S1 SEC accepts an amended 8-K from the recorded fixture but rejects other forms', async (t) => {
  const xml = await readFile(new URL('./fixtures/sec-getcurrent-8k-page1.atom', import.meta.url), 'utf8');
  const amendment = [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/gu)].map((m) => m[0])
    .find((row) => row.includes('8-K/A - Better Home'));
  assert.ok(amendment, 'fixture contains the reviewed amended filing');
  let round = 0;
  const b = await build(t, { symbols: ['NASDAQ:FIXTURE'],
    news: { sources: { sec: true, tradingview: false }, sec_forms: ['8-K'] }, responder: (url) =>
      url.includes('company_tickers') ? jsonResponse(200, { 0: { cik_str: 1835856, ticker: 'FIXTURE' } })
        : new Response(feed(round ? amendment + filing('wrong-form', { cik: '0001835856', title: '10-K - WRONG' })
          + filing('wrong-suffix', { cik: '0001835856', title: '8-KX - x' })
          + filing('wrong-amendment-suffix', { cik: '0001835856', title: '8-K/AX - x' })
          : filing('seed', { cik: '0001835856' }))) });
  await b.poller.runOnce(); round++; await b.poller.runOnce();
  assert.equal(b.submissions.length, 1);
  assert.match(b.submissions[0].message.lines.join('\n'), /8-K\/A - Better Home/);
  assert.doesNotMatch(b.submissions[0].message.lines.join('\n'), /WRONG|8-KX|8-K\/AX/);
});

test('S3 failed requests log only safe error name and code for both sources', async (t) => {
  for (const source of ['tradingview', 'sec']) {
    for (const hostileClass of [false, true]) {
      const err = Object.assign(new TypeError('https://evil.test/?contact=fixture@example.invalid'),
        hostileClass ? { name: 'https://evil.test/', code: 'fixture@example.invalid' } : { code: 'ECONNRESET' });
      const b = await build(t, { news: { sources: { sec: source === 'sec', tradingview: source === 'tradingview' } },
        responder: () => { throw err; } });
      await b.poller.runOnce();
      const log = b.logs.join('\n');
      assert.match(log, hostileClass ? /Error/ : /TypeError.*ECONNRESET/);
      assert.doesNotMatch(log, /https:|evil|contact|fixture@example/);
    }
  }
});

test('S4 TradingView rejects a valid JSON page of 1001 items without changing state', async (t) => {
  const b = await build(t); await b.poller.runOnce();
  b.set(Array.from({ length: 1001 }, (_, i) => item(`over-${i}`)));
  const before = structuredClone(b.store.state.news);
  await b.poller.runOnce();
  assert.deepEqual(b.store.state.news, before);
  assert.equal(b.submissions.length, 0);
  assert.ok(b.logs.some((s) => /response failed/.test(s)));
});

test('S5 SEC lookup maps TradingView dotted class shares to hyphenated tickers', async (t) => {
  let round = 0;
  const b = await build(t, { symbols: ['NYSE:BRK.B'],
    news: { sources: { sec: true, tradingview: false }, sec_forms: ['8-K'] }, responder: (url) =>
      url.includes('company_tickers') ? jsonResponse(200, { 0: { cik_str: 1067983, ticker: 'BRK-B' } })
        : new Response(feed(filing(String(round), { cik: '0001067983' }))) });
  await b.poller.runOnce(); round++; await b.poller.runOnce();
  assert.equal(b.submissions.length, 1);
  assert.match(b.submissions[0].message.lines.join('\n'), /NYSE:BRK\.B/);
});

test('S6 SEC company maps discard invalid rows and retain valid rows in fresh and cached maps', async (t) => {
  let round = 0;
  const bad = { cik_str: 1, ticker: 'not a ticker' };
  const b = await build(t, { news: { sources: { sec: true, tradingview: false }, sec_forms: ['8-K'] }, responder: (url) =>
    url.includes('company_tickers') ? jsonResponse(200, { ...map, bad }) : new Response(feed(filing(String(round)))) });
  await b.poller.runOnce(); round++; await b.poller.runOnce();
  assert.equal(b.submissions.length, 1, 'one invalid row cannot disable valid companies');
  const cachePath = join(b.dir, 'news-sec-companies.json');
  const saved = JSON.parse(await readFile(cachePath, 'utf8'));
  assert.equal(saved.data.bad, undefined);
  await writeFile(cachePath, JSON.stringify({ at: NOW, data: { ...map, bad } }));
  let mapFetches = 0;
  const cached = createNews({ news: { ...defaults, sources: { sec: true, tradingview: false }, sec_forms: ['8-K'] },
    symbols: ['NASDAQ:AAPL'], store: b.store, clock: b.clock, stateDir: b.dir, secContact: 'fixture@example.invalid',
    alerts: { submit: (x) => b.submissions.push(x) }, logger: { info() {}, warn() {} }, sleep: async () => {},
    fetch: async (url) => {
      if (url.includes('company_tickers')) { mapFetches++; return jsonResponse(200, {}); }
      return new Response(feed(filing('cached')));
    } });
  await cached.runOnce();
  assert.equal(mapFetches, 0, 'valid cached companies survive a bad row without refetching');
  assert.equal(b.submissions.length, 2);
});

test('S6 SEC rejects a company map with no valid rows', async (t) => {
  const b = await build(t, { news: { sources: { sec: true, tradingview: false } },
    responder: () => jsonResponse(200, { bad: { cik_str: -1, ticker: 'AAPL' } }) });
  const before = structuredClone(b.store.state.news);
  await b.poller.runOnce();
  assert.deepEqual(b.store.state.news, before);
  assert.equal(b.calls.length, 1);
});

test('S7 overflow count survives real Discord and Telegram truncation', async (t) => {
  const b = await build(t); await b.poller.runOnce();
  b.set(Array.from({ length: 11 }, (_, i) => item(`long-${i}`, undefined, undefined,
    { title: `${i} ${'x'.repeat(498)}` })));
  await b.poller.runOnce();
  const message = b.submissions[0].message;
  assert.match(discordPayload(message).embeds[0].description, /\+1 more/);
  assert.match(telegramPayload(message, 'fixture').text, /\+1 more/);
});

test('S8 feed markdown controls are neutralized in digest lines and held summaries', async (t) => {
  const b = await build(t); await b.poller.runOnce();
  b.set([item('spoof', undefined, undefined, { title: '[x](http://evil) *_fake_* `code` <b>bold</b>' })]);
  await b.poller.runOnce();
  const submission = b.submissions[0];
  assert.doesNotMatch(submission.message.lines[0], /[\[\]()*_`<>]/);
  assert.equal(submission.summary, '1 news item(s): xhttp://evil fake code bbold/b');
  assert.equal(submission.message.lines[1], 'https://www.tradingview.com/news/spoof/');
});

test('S9 streaming cap rejects syntactically valid oversized JSON', async (t) => {
  let large = false;
  const b = await build(t, { responder: () => new Response(JSON.stringify({ items: [item(large ? 'new' : 'seed')],
    padding: large ? 'x'.repeat(2 * 1024 * 1024) : '' })) });
  await b.poller.runOnce(); large = true;
  const before = structuredClone(b.store.state.news);
  await b.poller.runOnce();
  assert.deepEqual(b.store.state.news, before);
  assert.equal(b.submissions.length, 0);
});

test('S10 TradingView rejects encoded path traversal and separators', async (t) => {
  const b = await build(t); await b.poller.runOnce();
  b.set(['/news/%2e%2e%2fx', '/news/%2E%2E/x', '/news/x%2Fy', '/news/x%5cy', '/news/a%2eb', '/news/../../x']
    .map((storyPath, i) => item(`encoded-${i}`, undefined, undefined, { storyPath })));
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 0);
  assert.ok(b.logs.some((s) => /invalid entry/.test(s)));
});

test('S11 bare symbols are excluded from requests and seeding, including extras', async (t) => {
  const b = await build(t, { symbols: ['NASDAQ:AAPL', 'MSFT'], news: { tickers_extra: ['GOOG', 'NYSE:JPM'] } });
  await b.poller.runOnce();
  assert.equal(new URL(b.calls[0].url).searchParams.getAll('filter')[1], 'symbol:NASDAQ:AAPL,NYSE:JPM');
  assert.deepEqual(Object.keys(b.store.state.news.seeded).sort(), ['tradingview|NASDAQ:AAPL', 'tradingview|NYSE:JPM']);
});

test('S11 SEC rejects query and fragment links even on the allowed host', async (t) => {
  let round = 0;
  const b = await build(t, { news: { sources: { sec: true, tradingview: false }, sec_forms: ['8-K'] }, responder: (url) =>
    url.includes('company_tickers') ? jsonResponse(200, map) : new Response(feed(round ?
      filing('query', { link: 'https://www.sec.gov/Archives/query?token=fixture' })
        + filing('hash', { link: 'https://www.sec.gov/Archives/hash#spoof' }) : filing('seed'))) });
  await b.poller.runOnce(); round++; await b.poller.runOnce();
  assert.equal(b.submissions.length, 0);
  assert.ok(b.logs.some((s) => /invalid entry/.test(s)));
});

// N1b: the keyless and keyed sources wired into the news poller (parsers are tested in news-sources.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNews } from '../../lib/news.mjs';
import { createStateStore } from '../../lib/state.mjs';
import { parseConfig } from '../../lib/config.mjs';
import { createFakeClock, createFakeFetch, jsonResponse } from './support.mjs';

const NOW = Date.UTC(2026, 9, 20, 23, 30); // 19:30 New York, 2026-10-20
const MIN = 60_000;
const HOSTS = { 'news-mediator.tradingview.com': 'tradingview', 'api.tickertick.com': 'tickertick', 'feeds.finance.yahoo.com': 'yahoo', 'www.nasdaq.com': 'nasdaq',
  'news.google.com': 'google', 'finnhub.io': 'finnhub', 'api.nasdaq.com': 'nasdaq_calendar' };
const OFF = { tradingview: false, sec: false, tickertick: false, yahoo: false, nasdaq: false, google: false, finnhub: false, nasdaq_calendar: false };
const base = { enabled: true, every_minutes: 30, remember_hours: 72, max_age_minutes: 120, max_items_per_digest: 10,
  tickers_extra: [], include_keywords: [], exclude_keywords: [], sec_forms: ['8-K'] };

const ttStory = (id, { title = `Headline ${id}`, url = `https://news.example/${id}`, at = NOW - MIN, tickers = ['aapl'] } = {}) =>
  ({ id: String(id), title, url, site: 'news.example', time: at, tickers });
const ttBody = (stories) => jsonResponse(200, { stories, last_id: '777' });
const rssItem = (id, { title = `Headline ${id}`, link = `https://news.example/${id}`, at = NOW - MIN } = {}) =>
  `<item><guid>${id}</guid><title>${title}</title><link>${link}</link><pubDate>${new Date(at).toUTCString()}</pubDate><description>d</description></item>`;
const rssBody = (...items) => new Response(`<rss version="2.0"><channel>${items.join('')}</channel></rss>`);
const finnBody = (rows) => jsonResponse(200, rows.map(({ id, title = `Headline ${id}`, url = `https://news.example/${id}`, at = NOW - MIN }) =>
  ({ id, headline: title, url, datetime: Math.floor(at / 1000), source: 'Wire', category: 'company news', related: 'AAPL', summary: '', image: '' })));

/** One entry per source: how to answer a request for a story list, and the attribution shown in the digest (digest text drops parentheses). */
const SOURCES = {
  tickertick: { via: 'TickerTick news.example', body: (ids) => ttBody(ids.map((id) => ttStory(id))) },
  yahoo: { via: 'Yahoo Finance', body: (ids) => rssBody(...ids.map((id) => rssItem(id))) },
  nasdaq: { via: 'Nasdaq', body: (ids) => rssBody(...ids.map((id) => rssItem(id))) },
  google: { via: 'Google News', body: (ids) => rssBody(...ids.map((id) => rssItem(id))) },
  finnhub: { via: 'Finnhub Wire', body: (ids) => finnBody(ids.map((id) => ({ id: [...id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7), title: `Headline ${id}`, url: `https://news.example/${id}` }))) },
};

async function build(t, { sources, symbols = ['NASDAQ:AAPL'], routes = {}, news = {}, finnhubKey = 'fixture-key' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'news-multi-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = createFakeClock(NOW);
  const store = createStateStore({ dir, clock, persist: false });
  t.after(() => store.close());
  const logs = [], submissions = [], waits = [];
  const fake = createFakeFetch((url, init) => {
    const name = HOSTS[new URL(url).hostname];
    if (!name || !routes[name]) throw new Error(`unexpected request to ${new URL(url).hostname}`);
    return routes[name](url, init);
  });
  const poller = createNews({ news: { ...base, sources: { ...OFF, ...sources }, ...news }, symbols, store, clock,
    alerts: { submit: (entry) => submissions.push(entry) }, logger: { info: (s) => logs.push(s), warn: (s) => logs.push(s) },
    fetch: fake.fetch, secContact: 'fixture@example.invalid', finnhubKey, stateDir: dir, persist: false,
    sleep: async (ms) => waits.push(ms), timeoutMs: 1000 });
  const to = (name) => fake.calls.filter((c) => HOSTS[new URL(c.url).hostname] === name);
  return { poller, clock, store, logs, submissions, waits, calls: fake.calls, to };
}

for (const [name, spec] of Object.entries(SOURCES)) {
  test(`${name}: seeds silently, then one digest line with attribution and the story link`, async (t) => {
    let ids = ['seed'];
    const b = await build(t, { sources: { [name]: true }, routes: { [name]: () => spec.body(ids) } });
    await b.poller.runOnce();
    assert.equal(b.submissions.length, 0);
    ids = ['seed', 'fresh'];
    b.clock.advance(30 * MIN);
    await b.poller.runOnce();
    assert.equal(b.submissions.length, 1);
    const lines = b.submissions[0].message.lines;
    assert.equal(lines[0], `NASDAQ:AAPL · Headline fresh · via ${spec.via}`);
    assert.equal(lines[1], 'https://news.example/fresh');
    assert.equal(lines.length, 2);
    b.clock.advance(30 * MIN);
    await b.poller.runOnce();
    assert.equal(b.submissions.length, 1, 'the same story is not sent twice');
  });

  test(`${name}: failing alone leaves TradingView working and the failed source's state untouched`, async (t) => {
    let ids = ['seed'];
    const tv = () => jsonResponse(200, { items: ids.map((id) => ({ id, title: `Headline ${id}`, published: (NOW - MIN) / 1000,
      relatedSymbols: [{ symbol: 'NASDAQ:AAPL' }], storyPath: `/news/${id}/` })) });
    const b = await build(t, { sources: { tradingview: true, [name]: true },
      routes: { tradingview: tv, [name]: () => { throw new Error('boom'); } } });
    await b.poller.runOnce();
    ids = ['seed', 'fresh']; b.clock.advance(30 * MIN);
    await b.poller.runOnce();
    assert.equal(b.submissions.length, 1, 'the TradingView story still arrives');
    assert.match(b.submissions[0].message.lines[0], /Headline fresh/u);
    assert.match(b.logs.join('\n'), new RegExp(`news ${name}: request or response failed`, 'u'));
    for (const part of ['seeded', 'runs']) {
      assert.equal(Object.keys(b.store.state.news[part]).filter((k) => k.startsWith(`${name}|`)).length, 0, `${name}: no ${part} written`);
    }
  });
}

test('a non-200 answer and an empty or malformed body also skip quietly without alerting', async (t) => {
  for (const response of [() => new Response('nope', { status: 500 }), () => new Response(''), () => new Response('<html>blocked</html>')]) {
    const b = await build(t, { sources: { yahoo: true }, routes: { yahoo: response } });
    await b.poller.runOnce(); await b.poller.runOnce();
    assert.equal(b.submissions.length, 0);
    assert.deepEqual(b.store.state.news.seeded, {});
  }
});

test('a 429 pauses only that source: no calls while paused, calls again afterwards', async (t) => {
  for (const name of ['tickertick', 'yahoo', 'nasdaq', 'google', 'finnhub']) {
    let limited = true;
    const b = await build(t, { sources: { [name]: true }, symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'],
      routes: { [name]: () => limited ? new Response('slow down', { status: 429 }) : SOURCES[name].body(['seed']) } });
    await b.poller.runOnce();
    const first = b.to(name).length;
    assert.ok(first >= 1 && first <= 2, `${name}: first run made ${first} calls`);
    if (name !== 'tickertick') assert.equal(first, 1, `${name}: stops after the first 429 instead of hitting every symbol`);
    assert.match(b.logs.join('\n'), new RegExp(`news ${name}: .*(rate limit|429)`, 'iu'));
    b.clock.advance(10 * MIN); await b.poller.runOnce();
    assert.equal(b.to(name).length, first, `${name}: no request during the pause`);
    limited = false;
    b.clock.advance(31 * MIN); await b.poller.runOnce();
    assert.ok(b.to(name).length > first, `${name}: requests resume after the pause`);
    assert.equal(b.submissions.length, 0);
  }
});

test('a 429 honours Retry-After up to a ceiling', async (t) => {
  const b = await build(t, { sources: { yahoo: true },
    routes: { yahoo: () => new Response('', { status: 429, headers: { 'retry-after': '999999' } }) } });
  await b.poller.runOnce();
  b.clock.advance(61 * MIN); await b.poller.runOnce();
  assert.equal(b.to('yahoo').length, 1, 'eleven days asked for, so 61 minutes is still paused');
  b.clock.advance(6 * 3600_000); await b.poller.runOnce();
  assert.equal(b.to('yahoo').length, 2, 'the pause never exceeds six hours');
});

test('other sources keep running while one is rate limited', async (t) => {
  let ids = ['seed'];
  const b = await build(t, { sources: { yahoo: true, nasdaq: true },
    routes: { yahoo: () => new Response('', { status: 429 }), nasdaq: () => SOURCES.nasdaq.body(ids) } });
  await b.poller.runOnce();
  ids = ['seed', 'fresh']; b.clock.advance(30 * MIN);
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 1);
  assert.match(b.submissions[0].message.lines[0], /via Nasdaq$/u);
});

test('the same story from two sources is sent once (URL with tracking parameter, then headline)', async (t) => {
  let fresh = false;
  const story = 'Apple beats estimates';
  const b = await build(t, { sources: { tickertick: true, yahoo: true, google: true }, routes: {
    tickertick: () => ttBody([ttStory('seed'), ...(fresh ? [ttStory('t1', { title: story, url: 'https://news.example/a/1' })] : [])]),
    yahoo: () => rssBody(rssItem('seed'), ...(fresh ? [rssItem('y1', { title: 'A wholly different headline', link: 'https://news.example/a/1?.tsrc=rss' })] : [])),
    google: () => rssBody(rssItem('seed'), ...(fresh ? [rssItem('g1', { title: `${story} - Reuters`, link: 'https://news.google.com/rss/articles/g1?oc=5' })] : [])),
  } });
  await b.poller.runOnce();
  fresh = true; b.clock.advance(30 * MIN);
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 1);
  const lines = b.submissions[0].message.lines;
  assert.equal(lines.length, 2, `one story, one headline and one link: ${JSON.stringify(lines)}`);
  assert.match(lines[0], /via TickerTick/u, 'the first source to report it gets the credit');
  assert.equal(b.submissions[0].message.title, '1 new news item(s)');
});

test('the same headline for the same ticker under a new link is suppressed for six hours, then allowed', async (t) => {
  let extra = null;
  const b = await build(t, { sources: { yahoo: true }, news: { max_age_minutes: 10080 },
    routes: { yahoo: () => rssBody(rssItem('seed'), ...(extra ? [extra()] : [])) } });
  const story = (id) => () => rssItem(id, { title: 'Same headline', link: `https://news.example/${id}`, at: b.clock.now() - MIN });
  await b.poller.runOnce();
  b.clock.advance(30 * MIN); extra = story('a'); await b.poller.runOnce();
  assert.equal(b.submissions.length, 1);
  b.clock.advance(5 * 3600_000); extra = story('b'); await b.poller.runOnce();
  assert.equal(b.submissions.length, 1, 'five hours later it is still the same story');
  b.clock.advance(2 * 3600_000); extra = story('c'); await b.poller.runOnce();
  assert.equal(b.submissions.length, 2, 'more than six hours after the first it counts as new');
});

test('different stories that only share a host are not merged', async (t) => {
  let fresh = false;
  const b = await build(t, { sources: { tickertick: true, yahoo: true }, routes: {
    tickertick: () => ttBody([ttStory('seed'), ...(fresh ? [ttStory('t1', { title: 'First story', url: 'https://news.example/p?id=1' })] : [])]),
    yahoo: () => rssBody(rssItem('seed'), ...(fresh ? [rssItem('y1', { title: 'Second story', link: 'https://news.example/p?id=2' })] : [])),
  } });
  await b.poller.runOnce();
  fresh = true; b.clock.advance(30 * MIN);
  await b.poller.runOnce();
  assert.equal(b.submissions[0].message.lines.length, 4, 'two stories, two headlines, two links');
});

test('request budgets: 25 Yahoo and 10 Nasdaq or Google requests per run; TickerTick keeps one of its 6 in reserve for a follow-up page', async (t) => {
  const many = Array.from({ length: 70 }, (_, i) => `NASDAQ:S${i}`);
  const b = await build(t, { sources: { yahoo: true, nasdaq: true, google: true, tickertick: true }, symbols: many, routes: {
    yahoo: () => rssBody(rssItem('seed')), nasdaq: () => rssBody(rssItem('seed')), google: () => rssBody(rssItem('seed')),
    tickertick: () => ttBody([ttStory('seed', { tickers: ['s0'] })]) } });
  await b.poller.runOnce();
  assert.equal(b.to('yahoo').length, 25);
  assert.equal(b.to('nasdaq').length, 10);
  assert.equal(b.to('google').length, 10);
  assert.equal(b.to('tickertick').length, 5);
  assert.match(b.logs.join('\n'), /news yahoo: request budget reached/u);
  assert.match(b.logs.join('\n'), /news tickertick: request budget reached/u);
  const q = new URL(b.to('tickertick')[0].url).searchParams.get('q');
  assert.equal((q.match(/z:/gu) ?? []).length, 10, 'ten tickers per TickerTick request');
});

test('spacing: TickerTick requests are at least 7 s apart, RSS requests at least 1 s apart', async (t) => {
  const b = await build(t, { sources: { tickertick: true, yahoo: true }, symbols: Array.from({ length: 25 }, (_, i) => `NASDAQ:S${i}`), routes: {
    yahoo: () => rssBody(rssItem('seed')), tickertick: () => ttBody([ttStory('seed', { tickers: ['s0'] })]) } });
  await b.poller.runOnce();
  const tickertickWaits = b.waits.filter((ms) => ms >= 7000);
  assert.equal(b.to('tickertick').length, 3);
  assert.equal(tickertickWaits.length, 2, 'one wait between each pair of TickerTick requests');
  assert.equal(b.waits.filter((ms) => ms >= 1000 && ms < 7000).length, 24, 'one wait between each pair of Yahoo requests');
});

test('only US-listed symbols are queried on the US news sources', async (t) => {
  const b = await build(t, { sources: { yahoo: true, tickertick: true, nasdaq_calendar: true },
    symbols: ['NSE:M_M', 'NSE:TCS', 'LSE:VOD', 'NASDAQ:AAPL', 'NYSE:BRK.B'], routes: {
      yahoo: () => rssBody(rssItem('seed')), tickertick: () => ttBody([ttStory('seed')]),
      nasdaq_calendar: () => new Response(JSON.stringify({ data: { rows: [{ symbol: 'TCS', time: 'time-pre-market' }] } })) } });
  await b.poller.runOnce();
  const yahooSymbols = b.to('yahoo').map((c) => new URL(c.url).searchParams.get('s'));
  assert.deepEqual(yahooSymbols.sort(), ['AAPL', 'BRK-B']);
  assert.doesNotMatch(new URL(b.to('tickertick')[0].url).searchParams.get('q'), /m_m|tcs|vod/iu);
  b.clock.advance(24 * 3600_000); await b.poller.runOnce();
  assert.equal(b.submissions.length, 0, 'a calendar row for a non-US ticker never matches');
});

test('request shape: pinned hosts, bare Mozilla user agent, no key in any URL', async (t) => {
  const b = await build(t, { sources: { tickertick: true, yahoo: true, nasdaq: true, google: true, finnhub: true }, finnhubKey: 'KEY-SENTINEL-123', routes: {
    tickertick: () => ttBody([ttStory('seed')]), yahoo: () => rssBody(rssItem('seed')), nasdaq: () => rssBody(rssItem('seed')),
    google: () => rssBody(rssItem('seed')), finnhub: () => finnBody([{ id: 1 }]) } });
  await b.poller.runOnce();
  for (const name of ['tickertick', 'yahoo', 'nasdaq', 'google']) {
    const call = b.to(name)[0];
    assert.ok(call, name);
    assert.match(call.url, /^https:\/\//u);
    assert.equal(call.init.headers['User-Agent'], 'Mozilla/5.0', name);
  }
  assert.match(b.to('tickertick')[0].url, /^https:\/\/api\.tickertick\.com\/feed\?/u);
  assert.equal(new URL(b.to('yahoo')[0].url).searchParams.get('s'), 'AAPL');
  assert.equal(new URL(b.to('nasdaq')[0].url).searchParams.get('symbol'), 'AAPL');
  assert.ok(new URL(b.to('google')[0].url).searchParams.get('q').includes('AAPL'));
  const finn = b.to('finnhub')[0];
  assert.equal(new URL(finn.url).pathname, '/api/v1/company-news');
  assert.equal(new URL(finn.url).searchParams.get('symbol'), 'AAPL');
  assert.equal(new URL(finn.url).searchParams.get('from'), '2026-10-19');
  assert.equal(new URL(finn.url).searchParams.get('to'), '2026-10-20');
  assert.equal(finn.init.headers['X-Finnhub-Token'], 'KEY-SENTINEL-123');
  for (const call of b.calls) assert.doesNotMatch(call.url, /KEY-SENTINEL|token/iu);
  assert.doesNotMatch(b.logs.join('\n'), /KEY-SENTINEL/u);
});

test('finnhub without a key is skipped with a clear message and no request', async (t) => {
  const b = await build(t, { sources: { finnhub: true }, finnhubKey: '', routes: { finnhub: () => finnBody([{ id: 1 }]) } });
  await b.poller.runOnce();
  assert.equal(b.to('finnhub').length, 0);
  assert.match(b.logs.join('\n'), /news finnhub: FINNHUB_API_KEY is required; finnhub skipped/u);
});

test('a redirect to another host is not followed', async (t) => {
  const b = await build(t, { sources: { yahoo: true }, routes: {
    yahoo: () => new Response('', { status: 302, headers: { location: 'https://evil.example/x' } }) } });
  await b.poller.runOnce();
  assert.equal(b.calls.length, 1);
  assert.match(b.logs.join('\n'), /news yahoo: request or response failed/u);
});

test('TickerTick gap rule: a page that does not reach back to the last run triggers one follow-up with the cursor', async (t) => {
  let page = 'first';
  const b = await build(t, { sources: { tickertick: true }, routes: { tickertick: (url) => {
    if (new URL(url).searchParams.get('last') === '777') return ttBody([ttStory('older', { at: NOW - 40 * MIN })]);
    return page === 'first' ? ttBody([ttStory('seed', { at: NOW - 5 * MIN })]) : ttBody([ttStory('newest', { at: NOW + 29 * MIN })]);
  } } });
  await b.poller.runOnce();
  page = 'second'; b.clock.advance(30 * MIN);
  await b.poller.runOnce();
  assert.equal(b.to('tickertick').length, 3, 'one first-page request, then page one and its follow-up');
  assert.equal(new URL(b.to('tickertick')[2].url).searchParams.get('last'), '777');
});

test('RSS sources log a gap instead of paging when the feed does not reach the last run', async (t) => {
  let ids = [['seed', NOW - MIN]];
  const b = await build(t, { sources: { yahoo: true }, routes: { yahoo: () => rssBody(...ids.map(([id, at]) => rssItem(id, { at }))) } });
  await b.poller.runOnce();
  ids = [['fresh', NOW + 20 * MIN]]; b.clock.advance(30 * MIN);
  await b.poller.runOnce();
  assert.match(b.logs.join('\n'), /news yahoo: gap/u);
  assert.equal(b.to('yahoo').length, 2, 'no follow-up page exists, so exactly one request per run');
});

test('real recorded Yahoo feed: one injected story among thirteen recorded ones is the only alert', async (t) => {
  const recorded = await readFile(new URL('./fixtures/yahoo-aapl.rss', import.meta.url), 'utf8');
  const injected = rssItem('inj', { title: 'Injected headline', link: 'https://finance.yahoo.com/news/injected.html', at: NOW - MIN });
  let withNew = false;
  const b = await build(t, { sources: { yahoo: true }, news: { max_age_minutes: 10080 }, routes: {
    yahoo: () => new Response(withNew ? recorded.replace('<item>', `${injected}<item>`) : recorded) } });
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 0, 'thirteen recorded stories seed silently');
  withNew = true; b.clock.advance(30 * MIN);
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 1);
  assert.deepEqual(b.submissions[0].message.lines, ['NASDAQ:AAPL · Injected headline · via Yahoo Finance', 'https://finance.yahoo.com/news/injected.html']);
});

test('earnings calendar: one daily item for watched reporters, one request per run, new day alerts', async (t) => {
  const recorded = await readFile(new URL('./fixtures/nasdaq-earnings-calendar.json', import.meta.url), 'utf8');
  const b = await build(t, { sources: { nasdaq_calendar: true }, symbols: ['NASDAQ:TSLA', 'NYSE:PM', 'NASDAQ:AAPL'],
    routes: { nasdaq_calendar: () => new Response(recorded) } });
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 0, 'first day seeds');
  assert.equal(b.to('nasdaq_calendar').length, 1, 'one request however many symbols');
  const call = b.to('nasdaq_calendar')[0];
  assert.equal(new URL(call.url).pathname, '/api/calendar/earnings');
  assert.equal(new URL(call.url).searchParams.get('date'), '2026-10-20', 'the New York date');
  assert.equal(call.init.headers['User-Agent'], 'Mozilla/5.0');
  b.clock.advance(60 * MIN);
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 0, 'same day, same item');
  assert.equal(b.to('nasdaq_calendar').length, 1, 'looked at once per New York day');
  b.clock.advance(24 * 3600_000);
  await b.poller.runOnce();
  assert.equal(b.to('nasdaq_calendar').length, 2);
  assert.equal(b.submissions.length, 1);
  assert.equal(new URL(b.to('nasdaq_calendar').at(-1).url).searchParams.get('date'), '2026-10-21');
  assert.equal(b.submissions[0].message.lines[0], 'NASDAQ:TSLA, NYSE:PM · Earnings today: TSLA after close, PM before open · via Nasdaq');
  assert.equal(b.submissions[0].message.lines[1], 'https://www.nasdaq.com/market-activity/earnings?date=2026-10-21');
});

test('sources that are not switched on make no request at all', async (t) => {
  const b = await build(t, { sources: { tickertick: false }, routes: {} });
  await b.poller.runOnce();
  assert.equal(b.calls.length, 0);
});

test('config: TickerTick is on by default, the other new sources are off, unknown source names are rejected', () => {
  const raw = { watchlist: [{ symbol: 'NASDAQ:AAPL', timeframes: ['60'] }], rules: [] };
  const sources = parseConfig({ ...raw, news: {} }).config.news.sources;
  assert.deepEqual(sources, { tradingview: true, sec: true, tickertick: true, yahoo: false, nasdaq: false, google: false,
    finnhub: false, nasdaq_calendar: false });
  const custom = parseConfig({ ...raw, news: { sources: { yahoo: true, tickertick: false } } });
  assert.deepEqual(custom.errors, []);
  assert.equal(custom.config.news.sources.yahoo, true);
  assert.equal(custom.config.news.sources.tickertick, false);
  assert.equal(custom.config.news.sources.sec, true, 'an omitted source keeps its own default');
  assert.ok(parseConfig({ ...raw, news: { sources: { bloomberg: true } } }).errors.some((e) => /bloomberg/u.test(e)));
  assert.ok(parseConfig({ ...raw, news: { sources: { yahoo: 'yes' } } }).errors.some((e) => /yahoo/u.test(e)));
});

test('the earnings calendar pauses on a 429 like every other source', async (t) => {
  const b = await build(t, { sources: { nasdaq_calendar: true }, routes: { nasdaq_calendar: () => new Response('', { status: 429 }) } });
  await b.poller.runOnce();
  b.clock.advance(10 * MIN); await b.poller.runOnce();
  assert.equal(b.to('nasdaq_calendar').length, 1);
  assert.match(b.logs.join('\n'), /news nasdaq_calendar: rate limited/u);
});

test('TickerTick last-run markers follow the symbol, so a changed watchlist still triggers the gap follow-up', async (t) => {
  const symbols = ['NASDAQ:AAPL'];
  let second = false;
  const b = await build(t, { sources: { tickertick: true }, symbols, routes: { tickertick: (url) => {
    if (new URL(url).searchParams.get('last') === '777') return ttBody([ttStory('older', { at: NOW - 40 * MIN })]);
    return second ? ttBody([ttStory('newest', { at: NOW + 29 * MIN })]) : ttBody([ttStory('seed', { at: NOW - 5 * MIN })]);
  } } });
  await b.poller.runOnce();
  symbols.push('NASDAQ:MSFT'); second = true; b.clock.advance(30 * MIN);
  await b.poller.runOnce();
  assert.equal(b.to('tickertick').filter((c) => new URL(c.url).searchParams.get('last') === '777').length, 1);
});

test('a story two sources report for two different symbols is one line naming both symbols', async (t) => {
  let fresh = false;
  const b = await build(t, { sources: { tickertick: true, yahoo: true }, symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'], routes: {
    tickertick: () => ttBody([ttStory('seed', { tickers: ['aapl', 'msft'] }), ...(fresh ? [ttStory('t1', { title: 'Apple and Microsoft sign deal', url: 'https://news.example/deal', tickers: ['aapl'] })] : [])]),
    yahoo: (url) => rssBody(rssItem('seed'), ...(fresh && new URL(url).searchParams.get('s') === 'MSFT'
      ? [rssItem('y1', { title: 'Unrelated wording here', link: 'https://news.example/deal?.tsrc=rss' })] : [])),
  } });
  await b.poller.runOnce();
  fresh = true; b.clock.advance(30 * MIN);
  await b.poller.runOnce();
  assert.equal(b.submissions.length, 1);
  assert.deepEqual(b.submissions[0].message.lines, ['NASDAQ:AAPL, NASDAQ:MSFT · Apple and Microsoft sign deal · via TickerTick news.example', 'https://news.example/deal']);
});

test('the earnings calendar retries on the next run after a failed look', async (t) => {
  let ok = false;
  const b = await build(t, { sources: { nasdaq_calendar: true }, routes: {
    nasdaq_calendar: () => ok ? new Response(JSON.stringify({ data: { rows: [{ symbol: 'ZZZZ', time: 'x' }] } })) : new Response('', { status: 500 }) } });
  await b.poller.runOnce();
  ok = true; b.clock.advance(30 * MIN); await b.poller.runOnce();
  b.clock.advance(30 * MIN); await b.poller.runOnce();
  assert.equal(b.to('nasdaq_calendar').length, 2, 'failed once, succeeded once, then not again that day');
});

test('capped sources rotate through the symbol list instead of always asking for the first ones', async (t) => {
  const symbols = Array.from({ length: 70 }, (_, i) => `NASDAQ:S${i}`);
  const b = await build(t, { sources: { nasdaq: true, tickertick: true }, symbols, routes: {
    nasdaq: () => rssBody(rssItem('seed')), tickertick: () => ttBody([ttStory('seed', { tickers: ['s0'] })]) } });
  for (let run = 0; run < 7; run++) { await b.poller.runOnce(); b.clock.advance(30 * MIN); }
  const asked = new Set(b.to('nasdaq').map((c) => new URL(c.url).searchParams.get('symbol')));
  assert.equal(asked.size, 70, 'ten a run, so seven runs reach all seventy');
  const tickers = new Set(b.to('tickertick').flatMap((c) => [...new URL(c.url).searchParams.get('q').matchAll(/z:(s\d+)/gu)].map((m) => m[1])));
  assert.equal(tickers.size, 70, 'fifty a run, so seven runs reach all seventy');
  const firstRun = new Set(b.to('tickertick').slice(0, 5).flatMap((c) => [...new URL(c.url).searchParams.get('q').matchAll(/z:(s\d+)/gu)].map((m) => m[1])));
  const secondRun = b.to('tickertick').slice(5, 10).flatMap((c) => [...new URL(c.url).searchParams.get('q').matchAll(/z:(s\d+)/gu)].map((m) => m[1]));
  assert.ok(secondRun.some((name) => !firstRun.has(name)), 'the second run starts where the first stopped');
});

test('a new symbol seeding in its own TickerTick chunk does not swallow another chunk\'s story', async (t) => {
  const symbols = Array.from({ length: 10 }, (_, i) => `NASDAQ:S${i}`);
  let phase = 1;
  const b = await build(t, { sources: { tickertick: true }, symbols, routes: { tickertick: (url) => {
    const q = new URL(url).searchParams.get('q');
    if (phase === 1) return ttBody([ttStory('seed', { tickers: ['s0'] })]);
    if (phase === 2) return q === 'z:s10' ? ttBody([ttStory('x', { tickers: ['s0', 's10'], title: 'Shared story' })]) : ttBody([ttStory('seed', { tickers: ['s0'] })]);
    return q === 'z:s10' ? ttBody([ttStory('seed', { tickers: ['s10'] })]) : ttBody([ttStory('x', { tickers: ['s0'], title: 'Shared story' })]);
  } } });
  await b.poller.runOnce();
  symbols.push('NASDAQ:S10'); phase = 2; b.clock.advance(30 * MIN); await b.poller.runOnce();
  assert.equal(b.submissions.length, 0, 'S10 seeds silently');
  phase = 3; b.clock.advance(30 * MIN); await b.poller.runOnce();
  assert.equal(b.submissions.length, 1, 'S0 still hears about the story its own chunk reports');
  assert.match(b.submissions[0].message.lines[0], /^NASDAQ:S0 · Shared story/u);
});

test('Retry-After given as an HTTP date is honoured', async (t) => {
  const b = await build(t, { sources: { yahoo: true }, routes: { yahoo: () => new Response('', { status: 429,
    headers: { 'retry-after': new Date(NOW + 2 * 3600_000).toUTCString() } }) } });
  await b.poller.runOnce();
  b.clock.advance(61 * MIN); await b.poller.runOnce();
  assert.equal(b.to('yahoo').length, 1, 'two hours asked for, 61 minutes is still paused');
  b.clock.advance(61 * MIN); await b.poller.runOnce();
  assert.equal(b.to('yahoo').length, 2);
});

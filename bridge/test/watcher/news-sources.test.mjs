import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tickertickPage, rssPage, finnhubPage, calendarPage } from '../../lib/news-sources.mjs';

const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const AAPL = new Map([['aapl', ['NASDAQ:AAPL']]]);
const rss = (items) => `<rss version="2.0"><channel>${items}</channel></rss>`;
const rssItem = (id, link, date = 'Tue, 20 Oct 2026 21:05:36 +0000', title = `Headline ${id}`) =>
  `<item><guid>${id}</guid><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate><description>d</description></item>`;

// Every parser returns { items, count, oldest, cursor, skipped }. count = valid rows seen (even
// when no row maps to a watched symbol), oldest = smallest valid publishedAt in ms (null if none),
// skipped = number of invalid rows dropped. Parsers are pure: no network, no clock, no logging.

test('tickertick: real response maps tagged tickers to watchlist symbols', async () => {
  const text = await fixture('tickertick-aapl.json');
  const page = tickertickPage(text, AAPL);
  const stories = JSON.parse(text).stories;
  assert.equal(page.items.length, 15);
  assert.equal(page.count, 15);
  assert.equal(page.skipped, 0);
  assert.equal(page.oldest, Math.min(...stories.map((s) => s.time)));
  assert.equal(page.cursor, '-3537692688817327067');
  const first = page.items[0];
  assert.equal(first.source, 'tickertick');
  assert.equal(first.id, '4316568124221439237');
  assert.equal(first.publishedAt, 1792539489000);
  assert.deepEqual(first.symbols, ['NASDAQ:AAPL']);
  assert.equal(first.url, 'https://seekingalpha.com/article/4955681-ai-a-global-financial-trap-with-no-easy-way-out');
  assert.equal(first.via, 'TickerTick (seekingalpha.com)');
});

test('tickertick: stories whose tickers are not watched count but produce no item', async () => {
  const page = tickertickPage(await fixture('tickertick-aapl.json'), new Map([['msft', ['NASDAQ:MSFT']]]));
  assert.equal(page.items.length, 0);
  assert.equal(page.count, 15);
});

test('tickertick: one ticker may map to several symbols and symbols are not duplicated', () => {
  const body = JSON.stringify({ stories: [{ id: '1', title: 'T', url: 'https://a.example/x', site: 'a.example', time: 1000, tickers: ['goog', 'googl', 'goog'] }], last_id: '5' });
  const page = tickertickPage(body, new Map([['goog', ['NASDAQ:GOOG']], ['googl', ['NASDAQ:GOOGL']]]));
  assert.deepEqual(page.items[0].symbols, ['NASDAQ:GOOG', 'NASDAQ:GOOGL']);
});

test('tickertick: hostile or invalid rows are skipped and counted, never thrown', () => {
  const good = { id: '1', title: 'Good', url: 'https://a.example/x', site: 'a.example', time: 5000, tickers: ['aapl'] };
  const bad = [
    { ...good, id: '2', url: 'javascript:alert(1)' },
    { ...good, id: '3', url: 'http://a.example/x' },
    { ...good, id: '4', url: 'https://user:pw@a.example/x' },
    { ...good, id: '4b', url: 'https://@a.example/x' },
    { ...good, id: '5', title: '' },
    { ...good, id: '6', time: -1 },
    { ...good, id: '7', time: 'soon' },
    { ...good, id: '', },
    { ...good, id: '8', tickers: 'aapl' },
    null,
  ];
  const page = tickertickPage(JSON.stringify({ stories: [good, ...bad], last_id: '9' }), AAPL);
  assert.deepEqual(page.items.map((i) => i.id), ['1']);
  assert.equal(page.count, 1);
  assert.equal(page.skipped, bad.length);
});

test('tickertick: control characters removed, long titles and sites capped, markup kept as plain text', () => {
  const title = `\u0007Apple ${'x'.repeat(900)}\u0000`;
  const story = { id: '1', title, url: 'https://a.example/x', site: `evil\u001b.example${'y'.repeat(200)}`, time: 5000, tickers: ['aapl'] };
  const item = tickertickPage(JSON.stringify({ stories: [story], last_id: '1' }), AAPL).items[0];
  assert.ok(item.title.length <= 500);
  assert.doesNotMatch(item.title, /[\u0000-\u001f]/u);
  assert.ok(item.via.length <= 120);
  assert.doesNotMatch(item.via, /[\u0000-\u001f]/u);
});

test('tickertick: a bad cursor becomes null and a wrong shape throws', () => {
  const body = (extra) => JSON.stringify({ stories: [], ...extra });
  assert.equal(tickertickPage(body({ last_id: 'drop table' }), AAPL).cursor, null);
  assert.equal(tickertickPage(body({ last_id: 12345 }), AAPL).cursor, null);
  assert.equal(tickertickPage(body({}), AAPL).cursor, null);
  assert.throws(() => tickertickPage('{"stories":"nope"}', AAPL));
  assert.throws(() => tickertickPage('not json', AAPL));
  const many = Array.from({ length: 1001 }, (_, i) => ({ id: String(i), title: 't', url: 'https://a.example/x', site: 'a', time: 1, tickers: ['aapl'] }));
  assert.throws(() => tickertickPage(JSON.stringify({ stories: many }), AAPL));
});

for (const [file, source, via, count, firstUrl, firstAt] of [
  ['yahoo-aapl.rss', 'yahoo', 'Yahoo Finance', 13, 'https://finance.yahoo.com/markets/stocks/articles/apple-1-999-foldable-phone-210536588.html?.tsrc=rss', 1792530336000],
  ['nasdaq-aapl.rss', 'nasdaq', 'Nasdaq', 15, 'https://www.nasdaq.com/articles/2-stocks-buy-5-make-roughly-615-berkshire-hathaways-portfolio', 1792538700000],
  ['google-aapl.rss', 'google', 'Google News', 12, null, 1792515744000],
]) {
  test(`rss: real ${source} response becomes items for the queried symbol`, async () => {
    const page = rssPage(await fixture(file), { source, via, symbol: 'NASDAQ:AAPL' });
    assert.equal(page.items.length, count);
    assert.equal(page.count, count);
    assert.equal(page.skipped, 0);
    assert.equal(page.cursor, null);
    assert.equal(page.oldest, Math.min(...page.items.map((i) => i.publishedAt)));
    const first = page.items[0];
    assert.equal(first.source, source);
    assert.equal(first.via, via);
    assert.equal(first.publishedAt, firstAt);
    assert.deepEqual(first.symbols, ['NASDAQ:AAPL']);
    assert.ok(first.id.length > 0 && first.title.length > 0);
    if (firstUrl) assert.equal(first.url, firstUrl);
    for (const item of page.items) assert.match(item.url, /^https:\/\//u);
  });
}

test('rss: bad entries are skipped and counted, valid ones kept', () => {
  const text = rss([
    rssItem('ok', 'https://a.example/ok'),
    rssItem('http', 'http://a.example/plain'),
    rssItem('script', 'javascript:alert(1)'),
    rssItem('creds', 'https://u:p@a.example/x'),
    rssItem('date', 'https://a.example/d', 'not a date'),
    rssItem('empty', 'https://a.example/e', 'Tue, 20 Oct 2026 21:05:36 +0000', ''),
    rssItem('epoch', 'https://a.example/z', 'Thu, 01 Jan 1970 00:00:00 +0000'),
  ].join(''));
  const page = rssPage(text, { source: 'yahoo', via: 'Yahoo Finance', symbol: 'NYSE:JPM' });
  assert.deepEqual(page.items.map((i) => i.id), ['ok']);
  assert.equal(page.count, 1);
  assert.equal(page.skipped, 6);
});

test('rss: hostile documents throw (DOCTYPE, entities, not XML)', () => {
  const opts = { source: 'yahoo', via: 'Yahoo Finance', symbol: 'NYSE:JPM' };
  assert.throws(() => rssPage('<!DOCTYPE rss [<!ENTITY a "b">]><rss version="2.0"><channel></channel></rss>', opts));
  assert.throws(() => rssPage('<html>Too many requests</html>', opts));
  assert.throws(() => rssPage('', opts));
});

test('finnhub: documented-schema sample (not a recording) maps to items', async () => {
  const page = finnhubPage(await fixture('finnhub-company-news-documented.json'), 'NASDAQ:AAPL');
  assert.equal(page.items.length, 3);
  assert.equal(page.count, 3);
  assert.equal(page.skipped, 0);
  assert.equal(page.cursor, null);
  assert.equal(page.oldest, 1792528800000);
  const [first, second] = page.items;
  assert.equal(first.source, 'finnhub');
  assert.equal(first.id, '25286');
  assert.equal(first.title, 'Apple supplier lifts foldable iPhone output forecast');
  assert.equal(first.publishedAt, 1792536000000);
  assert.deepEqual(first.symbols, ['NASDAQ:AAPL']);
  assert.equal(first.url, 'https://www.example.com/apple-foldable-output');
  assert.equal(first.via, 'Finnhub (Reuters)');
  assert.equal(second.via, 'Finnhub');
});

test('finnhub: invalid rows are skipped and counted; a wrong shape throws', () => {
  const ok = { datetime: 1792536000, headline: 'Ok', id: 1, source: 'S', url: 'https://a.example/x' };
  const rows = [ok, { ...ok, id: 2, url: 'http://a.example/x' }, { ...ok, id: 3, headline: '' }, { ...ok, id: 4, datetime: 0 },
    { ...ok, id: 5, datetime: 'x' }, { ...ok, id: undefined }, 7];
  const page = finnhubPage(JSON.stringify(rows), 'NASDAQ:AAPL');
  assert.deepEqual(page.items.map((i) => i.id), ['1']);
  assert.equal(page.skipped, rows.length - 1);
  assert.throws(() => finnhubPage('{"error":"API limit reached"}', 'NASDAQ:AAPL'));
  assert.throws(() => finnhubPage('nope', 'NASDAQ:AAPL'));
});

const NOW = Date.UTC(2026, 9, 21, 12);
const CAL = new Map([['TSLA', ['NASDAQ:TSLA']], ['PM', ['NYSE:PM']], ['ZZZZ', ['NASDAQ:ZZZZ']]]);

test('calendar: real response gives one item for the watched reporters', async () => {
  const page = calendarPage(await fixture('nasdaq-earnings-calendar.json'), { date: '2026-10-21', tickers: CAL, now: NOW });
  assert.equal(page.count, 40);
  assert.equal(page.items.length, 1);
  assert.equal(page.cursor, null);
  const item = page.items[0];
  assert.equal(item.source, 'nasdaq_calendar');
  assert.equal(item.id, 'earnings|2026-10-21');
  assert.equal(item.title, 'Earnings today: TSLA (after close), PM (before open)');
  assert.deepEqual(item.symbols, ['NASDAQ:TSLA', 'NYSE:PM']);
  assert.equal(item.url, 'https://www.nasdaq.com/market-activity/earnings?date=2026-10-21'); // a fixed link would be deduped on day two
  assert.equal(item.publishedAt, NOW);
  assert.equal(item.via, 'Nasdaq');
});

test('calendar: no watched reporter means no item, an empty day counts zero', async () => {
  const text = await fixture('nasdaq-earnings-calendar.json');
  assert.equal(calendarPage(text, { date: '2026-10-21', tickers: new Map([['ZZZZ', ['NASDAQ:ZZZZ']]]), now: NOW }).items.length, 0);
  const empty = JSON.stringify({ data: { rows: [] }, message: null, status: { rCode: 200 } });
  const page = calendarPage(empty, { date: '2026-10-24', tickers: CAL, now: NOW });
  assert.equal(page.count, 0);
  assert.equal(page.items.length, 0);
});

test('calendar: unknown time label is left out, symbol text is sanitized, errors throw', () => {
  const rows = [{ symbol: 'TSLA', time: 'time-not-supplied' }, { symbol: 'PM\u0000<b>', time: 'time-pre-market' }, { symbol: 'AAPL; drop', time: 'x' }, null];
  const text = JSON.stringify({ data: { rows }, status: { rCode: 200 } });
  const page = calendarPage(text, { date: '2026-10-21', tickers: new Map([['TSLA', ['NASDAQ:TSLA']]]), now: NOW });
  assert.equal(page.items[0].title, 'Earnings today: TSLA');
  assert.equal(page.skipped, 3);
  assert.throws(() => calendarPage('{"data":null,"status":{"rCode":400}}', { date: '2026-10-21', tickers: CAL, now: NOW }));
  assert.throws(() => calendarPage('<html>Access denied</html>', { date: '2026-10-21', tickers: CAL, now: NOW }));
  assert.throws(() => calendarPage('{"data":{"rows":[]}}', { date: 'tomorrow', tickers: CAL, now: NOW }));
});

test('calendar: more than a thousand rows is refused', () => {
  const rows = Array.from({ length: 1001 }, () => ({ symbol: 'TSLA', time: 'x' }));
  assert.throws(() => calendarPage(JSON.stringify({ data: { rows } }), { date: '2026-10-21', tickers: CAL, now: NOW }));
});

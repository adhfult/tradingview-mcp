import { parseFeed } from './atom.mjs';

const clean = (value, length = 500) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim().slice(0, length) : '';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function itemId(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) return '';
  return clean(typeof value === 'string' || typeof value === 'number' ? String(value) : '', 512);
}

function safeLink(value) {
  if (typeof value !== 'string' || value.length > 2048
    || /\s|[\u0000-\u001f\u007f-\u009f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    const authority = value.slice(value.indexOf('://') + 3).split(/[/?#]/u, 1)[0];
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || authority.includes('@')) return null;
    return value;
  } catch { return null; }
}

function result(items, times, cursor = null, skipped = 0) {
  return { items, count: times.length, oldest: times.length ? Math.min(...times) : null, cursor, skipped };
}

function uniqueSymbols(values) {
  const symbols = [];
  if (!Array.isArray(values)) return symbols;
  for (const value of values) {
    const symbol = clean(value);
    if (symbol && !symbols.includes(symbol)) symbols.push(symbol);
  }
  return symbols;
}

function mappedSymbols(tickers, names) {
  const symbols = [];
  for (const name of names) {
    if (typeof name !== 'string') continue;
    for (const symbol of uniqueSymbols(tickers.get(clean(name).toLowerCase()))) {
      if (!symbols.includes(symbol)) symbols.push(symbol);
    }
  }
  return symbols;
}

export function tickertickPage(text, tickers) {
  const page = JSON.parse(text);
  if (!isObject(page) || !Array.isArray(page.stories) || page.stories.length > 1000) {
    throw new Error('invalid TickerTick page');
  }
  const items = [];
  const times = [];
  let skipped = 0;
  for (const row of page.stories) {
    const id = itemId(row?.id);
    const title = clean(row?.title);
    const url = safeLink(row?.url);
    const publishedAt = row?.time;
    if (!isObject(row) || !id || !title || !url || !Number.isFinite(publishedAt) || publishedAt <= 0
      || !Array.isArray(row.tickers)) {
      skipped += 1;
      continue;
    }
    times.push(publishedAt);
    const symbols = mappedSymbols(tickers, row.tickers);
    if (!symbols.length) continue;
    const site = clean(row.site);
    items.push({ source: 'tickertick', id, title, url, symbols, publishedAt,
      via: clean(site ? `TickerTick (${site})` : 'TickerTick', 120) });
  }
  const cursor = typeof page.last_id === 'string' && /^-?\d{1,20}$/u.test(page.last_id) ? page.last_id : null;
  return result(items, times, cursor, skipped);
}

export function rssPage(text, { source, via, symbol } = {}) {
  const parsed = parseFeed(text, { maxEntries: 1000 });
  const items = [];
  const times = [];
  let skipped = parsed.skipped.length;
  for (const row of parsed.entries) {
    const id = clean(row.id, 512);
    const title = clean(row.title);
    const url = safeLink(row.link);
    const publishedAt = Date.parse(clean(row.updated));
    if (!id || !title || !url || !Number.isFinite(publishedAt) || publishedAt <= 0) {
      skipped += 1;
      continue;
    }
    times.push(publishedAt);
    items.push({ source: clean(source), id, title, url, symbols: [clean(symbol)], publishedAt, via: clean(via, 120) });
  }
  return result(items, times, null, skipped);
}

export function finnhubPage(text, symbol) {
  const rows = JSON.parse(text);
  if (!Array.isArray(rows) || rows.length > 1000) throw new Error('invalid Finnhub page');
  const items = [];
  const times = [];
  let skipped = 0;
  for (const row of rows) {
    const id = itemId(row?.id);
    const title = clean(row?.headline);
    const url = safeLink(row?.url);
    const publishedAt = typeof row?.datetime === 'number' ? row.datetime * 1000 : NaN;
    if (!isObject(row) || !id || !title || !url || !Number.isFinite(publishedAt) || publishedAt <= 0) {
      skipped += 1;
      continue;
    }
    times.push(publishedAt);
    const source = clean(row.source);
    items.push({ source: 'finnhub', id, title, url, symbols: [clean(symbol)], publishedAt,
      via: clean(source ? `Finnhub (${source})` : 'Finnhub', 120) });
  }
  return result(items, times, null, skipped);
}

export function calendarPage(text, { date, tickers, now } = {}) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error('invalid calendar date');
  const page = JSON.parse(text);
  if (!isObject(page) || !isObject(page.data) || !Array.isArray(page.data.rows) || page.data.rows.length > 1000) {
    throw new Error('invalid Nasdaq calendar page');
  }
  let count = 0;
  const matched = [];
  let skipped = 0;
  for (const row of page.data.rows) {
    const ticker = clean(row?.symbol);
    if (!isObject(row) || !/^[A-Z0-9.-]{1,10}$/u.test(ticker)) {
      skipped += 1;
      continue;
    }
    count += 1;
    const symbols = uniqueSymbols(tickers.get(ticker));
    if (symbols.length) matched.push({ ticker, time: row.time, symbols });
  }
  const symbols = [];
  const titles = [];
  for (const row of matched) {
    titles.push(row.time === 'time-pre-market' ? `${row.ticker} (before open)`
      : row.time === 'time-after-hours' ? `${row.ticker} (after close)` : row.ticker);
    for (const symbol of row.symbols) if (!symbols.includes(symbol)) symbols.push(symbol);
  }
  const items = matched.length ? [{ source: 'nasdaq_calendar', id: `earnings|${date}`,
    title: clean(`Earnings today: ${titles.join(', ')}`), url: 'https://www.nasdaq.com/market-activity/earnings',
    symbols, publishedAt: now, via: 'Nasdaq' }] : [];
  return { items, count, oldest: null, cursor: null, skipped };
}

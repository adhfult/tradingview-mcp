/** Bounded, keyless news poller. No model or notification transport belongs here. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseFeed } from './atom.mjs';
import { withDeadline, timeoutError } from './deadline.mjs';
import { prune } from './state.mjs';
import { tickertickPage, rssPage, finnhubPage, calendarPage } from './news-sources.mjs';

const HOUR = 3600_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BYTES = 5 * 1024 * 1024;
const TV_REQUEST_BUDGET = 20;
const SEC_REQUEST_BUDGET = 7;
const CHUNK_SIZE = 50;
const MAX_REDIRECTS = 2;
const TV_HOST = 'news-mediator.tradingview.com';
const SEC_HOST = 'www.sec.gov';
// The N1b sources. `budget` is the hard cap of requests per run (redirect hops count), `spacing` the
// minimum gap between two requests. TickerTick allows 10 requests a minute per IP, hence 7 s.
const EXTRA = {
  tickertick: { host: 'api.tickertick.com', budget: 6, spacing: 7000 },
  yahoo: { host: 'feeds.finance.yahoo.com', budget: 25, spacing: 1000, via: 'Yahoo Finance',
    url: (t) => ['https://feeds.finance.yahoo.com/rss/2.0/headline', { s: t, region: 'US', lang: 'en-US' }] },
  nasdaq: { host: 'www.nasdaq.com', budget: 10, spacing: 1000, via: 'Nasdaq',
    url: (t) => ['https://www.nasdaq.com/feed/rssoutbound', { symbol: t }] },
  google: { host: 'news.google.com', budget: 10, spacing: 1000, via: 'Google News',
    url: (t) => ['https://news.google.com/rss/search', { q: `${t} stock when:1d`, hl: 'en-US', gl: 'US', ceid: 'US:en' }] },
  finnhub: { host: 'finnhub.io', budget: 25, spacing: 1100 }, // free plan: 60 calls a minute
  nasdaq_calendar: { host: 'api.nasdaq.com', budget: 1, spacing: 0 },
};
const RSS_SOURCES = ['yahoo', 'nasdaq', 'google'];
const TICKERTICK_CHUNK = 10;
const PAUSE_MIN = 30 * 60_000; // after an HTTP 429: at least this long, at most PAUSE_MAX, Retry-After in between
const PAUSE_MAX = 6 * HOUR;
// Yahoo answers a long browser agent string with 429 and this bare one with 200.
const BARE_AGENT = 'Mozilla/5.0';
const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX', 'NYSEARCA', 'ARCA', 'CBOE', 'BATS']);
const TRACKING_PARAM = /^(?:utm_.*|\.tsrc|oc|ref|src|cmpid|ncid|fbclid|gclid|guccounter)$/iu;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const clean = (value, length = 500) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim().slice(0, length) : '';
const digestText = (value) => value.replace(/[\[\]()*_`<>]/gu, '');
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const qualified = (symbol) => typeof symbol === 'string' && /^[A-Z0-9_]+:[A-Z0-9_.!-]+$/u.test(symbol);
/** Same story, different link decoration: drop tracking parameters and the fragment, keep identity parameters. */
function dedupeUrl(href) {
  try {
    const u = new URL(href);
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    u.hash = '';
    return u.href;
  } catch { return href; }
}
const newYorkDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);

function secureUrl(value, host) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f-\u009f\\]/u.test(value)) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.hostname !== host || u.username || u.password || u.port
      || value.slice(8).split('/')[0].includes('@')) return null;
    return u;
  } catch { return null; }
}

function storyUrl(path) {
  // A path only: never follow the upstream external `link`, query tokens, or dot segments.
  if (typeof path !== 'string' || !path.startsWith('/news/') || /[?#\\]/u.test(path)
    || /%(?:2e|2f|5c)/iu.test(path)
    || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/iu.test(path)) return null;
  return secureUrl(`https://www.tradingview.com${path}`, 'www.tradingview.com')?.href ?? null;
}

/** Read only a bounded regular file; a symlink or FIFO is never followed. */
async function readBounded(path, limit) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error('invalid local news file');
    const data = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    return data.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

async function atomicWrite(path, data) {
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path);
  } finally { await rm(temp, { force: true }).catch(() => {}); }
}

/** Append each new item, then retain at most maxBytes of complete newest JSONL records. */
export async function appendNews({ dir, items, maxBytes = MAX_RECORD_BYTES }) {
  if (items.length === 0) return;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'news.jsonl');
  const data = items.map((entry) => `${JSON.stringify(entry)}\n`)
    .filter((line) => Buffer.byteLength(line) <= maxBytes).join('');
  const handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND
    | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  let tail = null;
  try {
    if (!(await handle.stat()).isFile()) throw new Error('news record must be a regular file');
    await handle.chmod(0o600);
    await handle.writeFile(data);
    await handle.sync();
    const { size } = await handle.stat();
    if (size > maxBytes) {
      // One extra byte tells whether the retained tail starts on a record boundary.
      const start = Math.max(0, size - maxBytes - 1);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const bytes = buffer.subarray(0, bytesRead);
      tail = bytes.subarray(bytes.indexOf(10) + 1);
    }
  } finally { await handle.close(); }
  if (tail !== null) await atomicWrite(path, tail);
}

/** Dependency injection keeps fixtures, clocks and disk state usable without a network. */
export function createNews({ news, symbols, store, clock, alerts, logger, fetch = globalThis.fetch,
  secContact = '', finnhubKey = '', stateDir, persist = true, sleep = (ms) => delay(ms), timeoutMs = 15_000 }) {
  let running = false;
  let stopped = false;
  let mapCache = null;
  let secLastRequest = null;
  // ponytail: pauses and spacing live in memory, so a restart forgets them; persist if restarts get frequent.
  const lastRequest = {};
  const pausedUntil = {};
  const rotation = {}; // where the next run starts in a capped symbol list, so every symbol gets its turn
  let calendarDate = null;
  const controller = new AbortController();
  const logSkip = (source, count = 1) => logger.warn(`news ${source}: skipped ${count} invalid entry(s)`);
  // Upstream errors can contain a token-bearing URL or even the SEC contact. Never echo them.
  const errorLabel = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value) ? value : null;
  const failed = (source, err) => {
    const name = errorLabel(err?.name) ?? 'Error';
    const code = errorLabel(err?.code);
    logger.warn(`news ${source}: request or response failed (${name}${code ? ` ${code}` : ''}), skipped`);
  };

  const isPaused = (source) => (pausedUntil[source] ?? 0) > clock.now();
  function pause(source, retryAfterMs) {
    const ms = Math.min(PAUSE_MAX, Math.max(PAUSE_MIN, retryAfterMs));
    pausedUntil[source] = clock.now() + ms;
    logger.warn(`news ${source}: rate limited (429), paused for ${Math.round(ms / 60_000)} minutes`);
  }
  function headersFor(source) {
    if (source === 'sec') return { 'User-Agent': `TradingViewWatcher ${secContact}`, Accept: 'application/atom+xml,application/json' };
    if (source === 'tradingview') return { Accept: 'application/json' };
    const headers = { 'User-Agent': BARE_AGENT, Accept: 'application/json, application/rss+xml, application/xml;q=0.9' };
    // The key travels in a header, never in a URL, so no log line or error can carry it.
    if (source === 'finnhub') headers['X-Finnhub-Token'] = finnhubKey;
    return headers;
  }

  async function request(url, source, budget) {
    const host = source === 'sec' ? SEC_HOST : source === 'tradingview' ? TV_HOST : EXTRA[source].host;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    return withDeadline(async () => {
      let current = new URL(url);
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
        if (!secureUrl(current.href, host)) throw new Error('unsafe source URL');
        if (budget[source] <= 0) throw new Error('news request budget exhausted');
        budget[source]--;
        if (source === 'sec') {
          if (secLastRequest !== null) await sleep(Math.max(250, 250 - (clock.now() - secLastRequest)));
          secLastRequest = clock.now();
        } else if (EXTRA[source]?.spacing) {
          if (lastRequest[source] !== undefined) {
            const wait = EXTRA[source].spacing - (clock.now() - lastRequest[source]);
            if (wait > 0) await sleep(wait);
          }
          lastRequest[source] = clock.now();
        }
        if (signal.aborted || stopped) throw new Error('news stopped or timed out');
        const response = await fetch(current.href, { redirect: 'manual', signal, headers: headersFor(source) });
        if (response.status === 429 && EXTRA[source]) {
          await response.body?.cancel();
          const header = response.headers.get('retry-after') ?? '';
          const waitMs = /^\d{1,9}$/u.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - clock.now();
          throw Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED',
            retryAfterMs: Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 0 });
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          if (redirect === MAX_REDIRECTS) throw new Error('too many redirects');
          const location = response.headers.get('location');
          if (!location) throw new Error('missing redirect');
          const target = new URL(location, current);
          if (!secureUrl(target.href, host)) throw new Error('unsafe redirect');
          current = target; continue;
        }
        if (!response.ok || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
          await response.body?.cancel(); throw new Error('invalid news response');
        }
        if (!response.body) return '';
        const reader = response.body.getReader();
        const chunks = []; let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) throw new Error('news response too large');
            chunks.push(value);
          }
        } catch (err) { await reader.cancel().catch(() => {}); throw err; }
        finally { reader.releaseLock(); }
        return Buffer.concat(chunks, size).toString('utf8');
      }
      throw new Error('redirect limit');
    }, timeoutMs + 50, () => timeoutError(timeoutMs));
  }

  async function companyMap(budget, now) {
    if (mapCache && now >= mapCache.at && now - mapCache.at < 24 * HOUR) return mapCache.data;
    if (persist && stateDir) {
      try {
        const saved = JSON.parse(await readBounded(join(stateDir, 'news-sec-companies.json'), MAX_RESPONSE_BYTES));
        const data = validMap(saved.data);
        if (Number.isFinite(saved.at) && saved.at <= now && now - saved.at < 24 * HOUR && data) {
          mapCache = { at: saved.at, data }; return data;
        }
      } catch { /* Missing, expired or invalid cache: fetch a bounded replacement. */ }
    }
    const raw = validMap(JSON.parse(await request(`https://${SEC_HOST}/files/company_tickers.json`, 'sec', budget)));
    if (!raw) throw new Error('invalid company map');
    mapCache = { at: now, data: raw };
    if (persist && stateDir) {
      try {
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        await atomicWrite(join(stateDir, 'news-sec-companies.json'), JSON.stringify(mapCache));
      } catch { logger.warn('news sec: company cache could not be saved'); }
    }
    return raw;
  }

  function validMap(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const data = Object.fromEntries(Object.entries(raw).filter(([, row]) => row
      && Number.isSafeInteger(row.cik_str) && row.cik_str > 0 && row.cik_str <= 9999999999
      && typeof row.ticker === 'string' && /^[A-Z0-9.-]{1,30}$/u.test(row.ticker)));
    return Object.keys(data).length ? data : null;
  }

  function tvPage(text, selected) {
    const page = JSON.parse(text);
    if (!Array.isArray(page?.items) || page.items.length > 1000) throw new Error('invalid news-flow page');
    const items = []; const times = [];
    for (const row of page.items) {
      const title = clean(row?.title);
      const id = clean(row?.id, 512);
      const url = storyUrl(row?.storyPath);
      const publishedAt = row?.published * 1000;
      if (!title || !id || !url || typeof row.published !== 'number' || !Number.isFinite(publishedAt)
        || publishedAt <= 0 || publishedAt > 8.64e15 || !Array.isArray(row.relatedSymbols)) { logSkip('tradingview'); continue; }
      times.push(publishedAt);
      const related = selected.filter((s) => row.relatedSymbols.some((r) => r?.symbol === s));
      if (related.length) items.push({ source: 'tradingview', id, title, url, symbols: related, publishedAt });
    }
    const cursor = page.pagination?.cursor;
    return { items, count: times.length, oldest: times.length ? Math.min(...times) : null,
      cursor: typeof cursor === 'string' && cursor.length <= 2048 && !/[\u0000-\u001f]/u.test(cursor) ? cursor : null };
  }

  function secPage(text, byCik, form) {
    const formTitle = new RegExp(`^${form.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:/A)? - `, 'u');
    const parsed = parseFeed(text);
    if (parsed.skipped.length) logSkip('sec', parsed.skipped.length);
    const items = []; const times = [];
    for (const row of parsed.entries) {
      const publishedAt = Date.parse(row.updated);
      const url = secureUrl(row.link, SEC_HOST);
      if (!url || url.search || url.hash || !Number.isFinite(publishedAt) || publishedAt <= 0) { logSkip('sec'); continue; }
      times.push(publishedAt);
      const cik = /\((\d{10})\)\s*\(Filer\)/u.exec(row.title)?.[1];
      const related = byCik.get(cik);
      if (!related || !formTitle.test(row.title)) continue;
      const numbers = [...new Set([...row.summary.matchAll(/\bItem\s+(\d{1,2}\.\d{2})\b/giu)].map((m) => m[1]))].slice(0, 20);
      const title = clean(row.title);
      items.push({ source: 'sec', id: clean(row.id, 512), title, url: url.href, symbols: related,
        publishedAt, form, itemNumbers: numbers });
    }
    return { items, count: times.length, oldest: times.length ? Math.min(...times) : null };
  }

  // Only a complete, nonempty successful window changes state. A failed follow-up retries next run.
  async function window(source, key, selected, fetchPage, now, fresh) {
    try {
      // TradingView and TickerTick chunks shift as the watchlist changes, so their last run is kept per symbol.
      const perSymbolRuns = source === 'tradingview' || source === 'tickertick';
      const runKeys = perSymbolRuns ? selected.map((s) => `${source}|${s}`) : [key];
      const lastRuns = runKeys.map((k) => own(store.state.news.runs, k)).filter(Number.isFinite);
      const previous = lastRuns.length ? Math.min(...lastRuns) : undefined;
      const page = await fetchPage(false);
      if (!page.count) { logger.info(`news ${source}: empty result, skipped`); return; }
      let all = page.items;
      if (previous !== undefined && page.oldest > previous) {
        if (source === 'sec' || page.cursor) {
          const follow = await fetchPage(true, page.cursor);
          all = all.concat(follow.items);
          if (!follow.count || follow.oldest > previous) logger.warn(`news ${source}: gap remains after one follow-up page`);
        } else logger.warn(`news ${source}: gap, no follow-up cursor available`);
      }
      if (stopped) return;
      // Fetching may span publication. Future entries are deferred (no skew allowance)
      // without dedupe keys, so the next poll can accept them once the clock catches up.
      now = clock.now();
      const state = store.state.news;
      state.rememberMs = news.remember_hours * HOUR;
      // SEC forms are independent windows: a first 8-K page must not seed the 10-Q page.
      const seedSource = source === 'sec' ? key : source;
      const seeded = new Set(selected.filter((s) => own(state.seeded, `${seedSource}|${s}`) !== undefined));
      const futureOnly = new Set(all.filter((e) => e.publishedAt > now).flatMap((e) => e.symbols));
      for (const entry of all) {
        if (entry.publishedAt <= now) for (const symbol of entry.symbols) futureOnly.delete(symbol);
      }
      for (const entry of all) {
        if (entry.publishedAt > now) continue;
        if (entry.publishedAt <= (state.evictedBefore ?? 0)) continue;
        // Google News appends " - Publisher" to every headline; strip it so the same story matches other sources.
        const shownTitle = entry.source === 'google' ? entry.title.replace(/ - [^-]{1,60}$/u, '') : entry.title;
        const normalizedTitle = shownTitle.replace(/<[^>]{0,500}>/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim();
        const linkKey = dedupeUrl(entry.url);
        const keys = entry.symbols.map((symbol) => ({
          symbol,
          seen: [hash(`${entry.source}|${entry.id}|${symbol}`), hash(`url|${linkKey}|${symbol}`)],
          title: hash(`${normalizedTitle}|${symbol}`),
        }));
        const eligible = keys.filter((k) => seeded.has(k.symbol)
          && k.seen.every((id) => own(state.seen, id) === undefined || now - state.seen[id] > state.rememberMs)
          && (own(state.titles, k.title) === undefined || now - state.titles[k.title] > 6 * HOUR)).map((k) => k.symbol);
        const text = entry.title.toLowerCase();
        const included = (!news.include_keywords.length || news.include_keywords.some((word) => text.includes(word)))
          && !news.exclude_keywords.some((word) => text.includes(word));
        if (eligible.length && included && now - entry.publishedAt >= 0
          && now - entry.publishedAt <= news.max_age_minutes * 60_000) {
          const shared = fresh.find((e) => dedupeUrl(e.url) === linkKey || (e.source === entry.source && e.id === entry.id));
          if (shared) shared.symbols = [...new Set([...shared.symbols, ...eligible])];
          else fresh.push({ ...entry, symbols: eligible, observedAt: now });
        }
        for (const k of keys) {
          for (const id of k.seen) {
            if (own(state.seen, id) === undefined || now - state.seen[id] > state.rememberMs) state.seen[id] = now;
          }
          if (own(state.titles, k.title) === undefined || now - state.titles[k.title] > 6 * HOUR) state.titles[k.title] = now;
        }
      }
      // Future-only symbols have not supplied a valid initial backlog yet.
      for (const s of selected) {
        if (futureOnly.has(s)) continue;
        state.seeded[`${seedSource}|${s}`] = now;
        if (perSymbolRuns) state.runs[`${source}|${s}`] = now;
      }
      // Every other source keeps one run marker per window (an SEC form, an RSS symbol); retry it if any symbol was deferred.
      if (!perSymbolRuns && !futureOnly.size) state.runs[key] = now;
      prune(store.state, now);
      store.touch();
    } catch (err) {
      if (err?.code === 'RATE_LIMITED' && EXTRA[source]) pause(source, err.retryAfterMs);
      else failed(source, err);
    }
  }

  /** TickerTick, the three RSS feeds, Finnhub and the earnings calendar. Each is switched on by its own flag. */
  async function extraSources(selected, now, budget, fresh) {
    const on = (name) => news.sources[name] === true && !stopped && !isPaused(name);
    // These feeds cover US listings only; an NSE or LSE symbol would get unrelated results.
    const us = selected.filter((s) => US_EXCHANGES.has(s.split(':')[0]) && /^[A-Z0-9.-]{1,10}$/u.test(s.split(':')[1]));
    const ticker = (s) => s.split(':')[1].replaceAll('.', '-');
    // A capped source starts each run where the last one stopped, so no symbol is starved.
    const rotated = (name, list) => {
      const start = (rotation[name] ?? 0) % Math.max(1, list.length);
      return [...list.slice(start), ...list.slice(0, start)];
    };
    const advance = (name, list, done) => { rotation[name] = ((rotation[name] ?? 0) + done) % Math.max(1, list.length); };
    const eachSymbol = async (name, fetchFor) => {
      let done = 0;
      for (const symbol of rotated(name, us)) {
        if (stopped || isPaused(name)) break;
        if (budget[name] < 1) { logger.warn(`news ${name}: request budget reached; remaining symbols resume next run`); break; }
        await window(name, `${name}|${symbol}`, [symbol], () => fetchFor(symbol), now, fresh);
        done++;
      }
      advance(name, us, done);
    };

    if (on('tickertick') && us.length) {
      const byTicker = new Map();
      for (const s of us) byTicker.set(ticker(s).toLowerCase(), [...(byTicker.get(ticker(s).toLowerCase()) ?? []), s]);
      const names = rotated('tickertick', [...byTicker.keys()]);
      let done = 0;
      for (let i = 0; i < names.length && !stopped && !isPaused('tickertick'); i += TICKERTICK_CHUNK) {
        if (budget.tickertick < 2) { logger.warn('news tickertick: request budget reached; remaining symbols resume next run'); break; }
        const chunk = names.slice(i, i + TICKERTICK_CHUNK);
        const terms = chunk.map((name) => `z:${name}`);
        // Only this chunk's tickers map to symbols: another chunk's symbols must not be marked seen by this window.
        const chunkMap = new Map(chunk.map((name) => [name, byTicker.get(name)]));
        await window('tickertick', `tickertick|${hash(chunk.slice().sort().join(','))}`, chunk.flatMap((name) => byTicker.get(name)),
          async (follow, cursor) => {
            const u = new URL(`https://${EXTRA.tickertick.host}/feed`);
            u.searchParams.set('q', terms.length === 1 ? terms[0] : `(or ${terms.join(' ')})`);
            u.searchParams.set('n', '30');
            if (follow) u.searchParams.set('last', cursor);
            return tickertickPage(await request(u, 'tickertick', budget), chunkMap);
          }, now, fresh);
        done += chunk.length;
      }
      advance('tickertick', [...byTicker.keys()], done);
    }

    for (const name of RSS_SOURCES) {
      if (!on(name)) continue;
      await eachSymbol(name, async (symbol) => {
        const [base, params] = EXTRA[name].url(ticker(symbol));
        const u = new URL(base);
        for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value);
        return rssPage(await request(u, name, budget), { source: name, via: EXTRA[name].via, symbol });
      });
    }

    if (on('finnhub') && us.length) {
      if (!/^[\x21-\x7e]{8,200}$/u.test(finnhubKey)) logger.warn('news finnhub: FINNHUB_API_KEY is required; finnhub skipped');
      else await eachSymbol('finnhub', async (symbol) => {
        const u = new URL(`https://${EXTRA.finnhub.host}/api/v1/company-news`);
        u.searchParams.set('symbol', ticker(symbol));
        u.searchParams.set('from', newYorkDate(now - 24 * HOUR));
        u.searchParams.set('to', newYorkDate(now));
        return finnhubPage(await request(u, 'finnhub', budget), symbol);
      });
    }

    if (on('nasdaq_calendar') && us.length && calendarDate !== newYorkDate(now)) {
      const date = newYorkDate(now);
      const byTicker = new Map();
      for (const s of us) byTicker.set(s.split(':')[1], [...(byTicker.get(s.split(':')[1]) ?? []), s]);
      await window('nasdaq_calendar', 'nasdaq_calendar', us, async () => {
        const u = new URL(`https://${EXTRA.nasdaq_calendar.host}/api/calendar/earnings`);
        u.searchParams.set('date', date);
        const page = calendarPage(await request(u, 'nasdaq_calendar', budget), { date, tickers: byTicker, now });
        calendarDate = date; // one successful look per New York day; a failure above retries next run
        return page;
      }, now, fresh);
    }
  }

  return {
    /** Abort uncommitted HTTP windows; committed stories still finish recording and submission. */
    stop() { stopped = true; controller.abort(); },
    async runOnce() {
      if (running || stopped) return false;
      running = true;
      try {
        const now = clock.now();
        const selected = [...new Set([...symbols, ...news.tickers_extra].filter(qualified))];
        const budget = { tradingview: TV_REQUEST_BUDGET, sec: SEC_REQUEST_BUDGET,
          ...Object.fromEntries(Object.entries(EXTRA).map(([name, spec]) => [name, spec.budget])) };
        const fresh = [];
        if (news.sources.tradingview) {
          for (let i = 0; i < selected.length && !stopped; i += CHUNK_SIZE) {
            if (budget.tradingview < 2) { logger.warn('news tradingview: request budget reached; remaining symbols skipped'); break; }
            const chunk = selected.slice(i, i + CHUNK_SIZE);
            const key = `tradingview|${hash(chunk.slice().sort().join(','))}`;
            await window('tradingview', key, chunk, async (follow, cursor) => {
              const u = new URL(`https://${TV_HOST}/news-flow/v2/news`);
              u.searchParams.append('filter', 'lang:en'); u.searchParams.append('filter', `symbol:${chunk.join(',')}`);
              u.searchParams.set('client', 'screener'); u.searchParams.set('streaming', 'false');
              if (follow) u.searchParams.set('pagination', cursor);
              return tvPage(await request(u, 'tradingview', budget), chunk);
            }, now, fresh);
          }
        }
        if (news.sources.sec && !stopped && selected.length) {
          if (typeof secContact !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(secContact) || secContact.length > 254) {
            logger.warn('news sec: WATCHER_SEC_CONTACT is required; SEC skipped');
          } else {
            try {
              const companies = await companyMap(budget, now);
              const byTicker = new Map(Object.values(companies).map((r) => [r.ticker, String(r.cik_str).padStart(10, '0')]));
              const byCik = new Map();
              for (const s of selected) {
                const cik = byTicker.get(s.split(':')[1].replaceAll('.', '-'));
                if (cik) byCik.set(cik, [...(byCik.get(cik) ?? []), s]);
              }
              const mapped = [...byCik.values()].flat();
              if (mapped.length) for (const form of news.sec_forms) {
                if (stopped) break;
                await window('sec', `sec|${form}`, mapped, async (follow) => {
                  const u = new URL(`https://${SEC_HOST}/cgi-bin/browse-edgar`);
                  u.search = new URLSearchParams({ action: 'getcurrent', type: form, count: '100', start: follow ? '100' : '0', output: 'atom' });
                  return secPage(await request(u, 'sec', budget), byCik, form);
                }, now, fresh);
              }
            } catch (err) { failed('sec', err); }
          }
        }
        await extraSources(selected, now, budget, fresh);
        if (fresh.length) {
          fresh.sort((a, b) => b.publishedAt - a.publishedAt);
          if (persist && stateDir) {
            try { await appendNews({ dir: stateDir, items: fresh }); }
            catch { logger.warn('news: record could not be saved'); }
          }
          const lines = fresh.slice(0, news.max_items_per_digest).flatMap((e) => [
            `${e.symbols.join(', ')} · ${digestText(e.title)}${e.itemNumbers?.length ? ` · Items ${e.itemNumbers.join(', ')}` : ''}${e.via ? ` · via ${digestText(e.via)}` : ''}`, e.url,
          ]);
          if (fresh.length > news.max_items_per_digest) lines.unshift(`+${fresh.length - news.max_items_per_digest} more`);
          alerts.submit({ kind: 'news',
            message: { level: 'info', title: `${fresh.length} new news item(s)`, lines, timestamp: new Date(now).toISOString() },
            summary: `${fresh.length} news item(s): ${fresh.slice(0, 3).map((e) => digestText(e.title)).join('; ')}`,
            dedupeKey: `news|${hash(fresh.map((e) => `${e.source}|${e.id}`).sort().join(','))}|${now}` });
        }
        return true;
      } finally { running = false; }
    },
  };
}

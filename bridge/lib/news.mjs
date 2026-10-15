/** Bounded, keyless news poller. No model or notification transport belongs here. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseFeed } from './atom.mjs';
import { withDeadline, timeoutError } from './deadline.mjs';
import { prune } from './state.mjs';

const HOUR = 3600_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BYTES = 5 * 1024 * 1024;
const TV_REQUEST_BUDGET = 20;
const SEC_REQUEST_BUDGET = 7;
const CHUNK_SIZE = 50;
const MAX_REDIRECTS = 2;
const TV_HOST = 'news-mediator.tradingview.com';
const SEC_HOST = 'www.sec.gov';
const hash = (text) => createHash('sha256').update(text).digest('hex');
const clean = (value, length = 500) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim().slice(0, length) : '';
const digestText = (value) => value.replace(/[\[\]()*_`<>]/gu, '');
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const qualified = (symbol) => typeof symbol === 'string' && /^[A-Z0-9_]+:[A-Z0-9_.!-]+$/u.test(symbol);

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
  secContact = '', stateDir, persist = true, sleep = (ms) => delay(ms), timeoutMs = 15_000 }) {
  let running = false;
  let stopped = false;
  let mapCache = null;
  let secLastRequest = null;
  const controller = new AbortController();
  const logSkip = (source, count = 1) => logger.warn(`news ${source}: skipped ${count} invalid entry(s)`);
  // Upstream errors can contain a token-bearing URL or even the SEC contact. Never echo them.
  const errorLabel = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value) ? value : null;
  const failed = (source, err) => {
    const name = errorLabel(err?.name) ?? 'Error';
    const code = errorLabel(err?.code);
    logger.warn(`news ${source}: request or response failed (${name}${code ? ` ${code}` : ''}), skipped`);
  };

  async function request(url, source, budget) {
    const host = source === 'sec' ? SEC_HOST : TV_HOST;
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
        }
        if (signal.aborted || stopped) throw new Error('news stopped or timed out');
        const response = await fetch(current.href, { redirect: 'manual', signal,
          headers: source === 'sec' ? { 'User-Agent': `TradingViewWatcher ${secContact}`, Accept: 'application/atom+xml,application/json' } : { Accept: 'application/json' } });
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
      const runKeys = source === 'tradingview' ? selected.map((s) => `tradingview|${s}`) : [key];
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
        const normalizedTitle = entry.title.replace(/<[^>]{0,500}>/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim();
        const keys = entry.symbols.map((symbol) => ({
          symbol,
          seen: [hash(`${entry.source}|${entry.id}|${symbol}`), hash(`url|${entry.url}|${symbol}`)],
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
          const shared = fresh.find((e) => e.url === entry.url || (e.source === entry.source && e.id === entry.id));
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
        if (source === 'tradingview') state.runs[`tradingview|${s}`] = now;
      }
      // SEC uses one shared run marker per form; retry it if any symbol was deferred.
      if (source === 'sec' && !futureOnly.size) state.runs[key] = now;
      prune(store.state, now);
      store.touch();
    } catch (err) { failed(source, err); }
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
        const budget = { tradingview: TV_REQUEST_BUDGET, sec: SEC_REQUEST_BUDGET };
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
        if (fresh.length) {
          fresh.sort((a, b) => b.publishedAt - a.publishedAt);
          if (persist && stateDir) {
            try { await appendNews({ dir: stateDir, items: fresh }); }
            catch { logger.warn('news: record could not be saved'); }
          }
          const lines = fresh.slice(0, news.max_items_per_digest).flatMap((e) => [
            `${e.symbols.join(', ')} · ${digestText(e.title)}${e.itemNumbers?.length ? ` · Items ${e.itemNumbers.join(', ')}` : ''}`, e.url,
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

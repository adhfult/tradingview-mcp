/**
 * Read-only web dashboard, served by the watcher process on its own port (default 8788).
 *
 * Everything it shows comes from memory (streams, the alert history) or from reading files
 * ($TRADINGVIEW_MCP_HOME/gauntlet and paper). It never calls TradingView, never writes
 * anywhere and never sends anything, so a bug here cannot place a trade or lose an alert.
 *
 * Security, all in this one file so no path can skip it:
 * - GET only. Static files come from a fixed map built at start; no part of a file path comes
 *   from a request. Journal files are found by listing a folder and matching a 64-hex name.
 * - On a loopback bind no token is needed, but the Host header must name a loopback host (by name,
 *   not port, so an SSH tunnel works), which stops DNS rebinding. On any other bind a token of at
 *   least 16 characters is required, or the dashboard refuses to be created. A token that is
 *   configured is always required: Bearer header, the tvw_dash cookie, or ?token= once.
 * - The four security headers are added by `send()`, which every response goes through.
 *
 * Events (`/events`, server-sent): the watcher's bus emits 'bar' (stream, candle), 'alert' (history
 * entry) and 'health' (stream list). Bars are coalesced to one per stream per second. With no browser
 * connected nothing is done for them.
 *
 * Do not set `server.timeout` or add keep-alive handling: they would cut a quiet /events stream
 * between its 20 s heartbeats. Only the request-side timeouts are set.
 */
import { constants } from 'node:fs';
import { open, readFile, readdir, lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { errorMessage } from './errors.mjs';
import { parseGauntletReport, parsePaperJournal } from './journals.mjs';
import { tokenMatches, tokensEqual } from './localapi.mjs';
import { ruleExpired } from './rules.mjs';

export const MAX_SSE_CLIENTS = 5;
export const COALESCE_MS = 1000;
export const HEARTBEAT_MS = 20_000;
const MAX_SSE_BUFFER = 256 * 1024; // a client further behind than this is dropped
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_JOURNAL_FILES = 50;
const MIN_REMOTE_TOKEN = 16;
const DEFAULT_CANDLES = 300;
const DEFAULT_ALERTS = 100;
const MAX_LIMIT = 500;

const LOOPBACK_BIND = new Set(['127.0.0.1', '::1', 'localhost']);
const LOOPBACK_HOST_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
});
const JSON_TYPE = 'application/json; charset=utf-8';
const GAUNTLET_FILE = /^[0-9a-f]{64}\.json$/;
const PAPER_FILE = /^[0-9a-f]{64}\.jsonl$/;

const realTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id),
};

/** The files served by default, keyed by URL path. The chart library comes from node_modules. */
export function defaultAssets() {
  const file = (relative) => fileURLToPath(new URL(relative, import.meta.url));
  return {
    '/': file('../dashboard/index.html'),
    '/assets/app.mjs': file('../dashboard/app.mjs'),
    '/assets/style.css': file('../dashboard/style.css'),
    '/assets/lightweight-charts.mjs': file('../node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.mjs'),
  };
}

const assetType = (urlPath) => {
  if (urlPath === '/') return 'text/html; charset=utf-8';
  return urlPath.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
};

/** Host header -> lower-case host name without the port ("[::1]:9000" -> "[::1]"). */
function hostName(value) {
  if (typeof value !== 'string') return '';
  const match = /^(\[[^\]]*\]|[^:[\]]*)(?::\d*)?$/.exec(value.trim().toLowerCase());
  return match === null ? '' : match[1];
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A whole number from a query value, else the fallback; clamped to MAX_LIMIT. */
function limitOf(value, fallback) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback;
  const n = Number(value);
  return n < 1 ? fallback : Math.min(n, MAX_LIMIT);
}

const pickCandle = (c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });

const publicStreams = (list) => list.map((s) => ({
  symbol: s.symbol, timeframe: s.timeframe, healthy: s.status === 'healthy', lastBarTime: s.lastBarTime ?? null,
}));

/** A history entry as the page sees it: no dedupe key, meta flattened (null for entries recorded before meta existed). */
function publicAlert(entry) {
  const m = isObject(entry.meta) ? entry.meta : {};
  return {
    at: entry.at,
    kind: entry.kind,
    level: entry.level,
    title: entry.title,
    status: entry.status,
    ruleId: m.ruleId ?? null,
    symbol: m.symbol ?? null,
    timeframe: m.timeframe ?? null,
    barTime: m.barTime ?? null,
    direction: m.direction ?? null,
    message: m.message ?? null,
    values: m.values ?? null,
  };
}

/** Text of a small regular file, or null. O_NOFOLLOW refuses a symlink even if it appears after a listing. */
async function readSmallFile(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return await handle.readFile({ encoding: 'utf8' });
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Journal files in a folder whose name matches `pattern`, newest first, at most 50. Missing folder: []. */
async function newestFiles(dir, pattern) {
  let names;
  try {
    names = (await readdir(dir)).filter((name) => pattern.test(name));
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    try {
      const info = await lstat(`${dir}/${name}`);
      if (info.isFile()) found.push({ name, mtimeMs: info.mtimeMs });
    } catch { /* gone since the listing */ }
  }
  // ponytail: one lstat per file in the folder; fine for a folder of reports, add a cap if it ever holds thousands.
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_JOURNAL_FILES).map((f) => f.name);
}

/**
 * `streams` has list() and candles(key). `getAlerts()` returns the stored history (oldest first).
 * `rules` and `timezone` come from the config, `home` is $TRADINGVIEW_MCP_HOME, `assets` maps URL paths to files.
 * Throws when a non-loopback host has no usable token. `listen()` rejects on a bind error (e.g. EADDRINUSE).
 */
export function createDashboard({
  host = '127.0.0.1', port, token = '', bus, streams, getAlerts, rules, timezone, home, assets, clock = realTimers, logger,
}) {
  const loopback = LOOPBACK_BIND.has(String(host).toLowerCase());
  if (!loopback && token.length < MIN_REMOTE_TOKEN) {
    throw new Error(`dashboard host ${host} is not a loopback address: set WATCHER_DASHBOARD_TOKEN to a secret of at least ${MIN_REMOTE_TOKEN} characters`);
  }

  const files = new Map(); // URL path -> {body, type}, loaded once in listen()
  const clients = new Set();
  const bars = new Map(); // stream key -> {sentAt, timer, pending}
  let heartbeat = null;

  // ------------------------------------------------------------ responses

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
    res.end(body);
  }
  const sendJson = (res, status, value, headers = {}) => {
    const text = JSON.stringify(value);
    send(res, status, text, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  };
  const sendError = (res, status, message, headers = {}) => sendJson(res, status, { error: message }, headers);

  // ------------------------------------------------------------ auth

  function cookieToken(header) {
    if (typeof header !== 'string') return '';
    for (const part of header.split(';')) {
      const at = part.indexOf('=');
      if (at > 0 && part.slice(0, at).trim() === 'tvw_dash') {
        try {
          return decodeURIComponent(part.slice(at + 1).trim());
        } catch {
          return '';
        }
      }
    }
    return '';
  }

  /** The query string without every `token` parameter, kept as the browser wrote it. */
  function withoutToken(search) {
    return search.split('&').filter((pair) => pair !== '' && new URLSearchParams(pair).keys().next().value !== 'token').join('&');
  }

  // ------------------------------------------------------------ data

  const findStream = (params) => {
    const symbol = params.get('symbol');
    const timeframe = params.get('tf');
    if (symbol === null || timeframe === null) return undefined;
    return streams.list().find((s) => s.symbol === symbol && s.timeframe === timeframe);
  };

  const api = new Map([
    ['/api/streams', (res) => sendJson(res, 200, publicStreams(streams.list()))],

    ['/api/candles', (res, params) => {
      const found = findStream(params);
      const candles = found === undefined ? null : streams.candles(found.key);
      if (candles === null) return sendError(res, 404, 'not found');
      return sendJson(res, 200, candles.slice(-limitOf(params.get('limit'), DEFAULT_CANDLES)).map(pickCandle));
    }],

    ['/api/alerts', (res, params) => {
      const symbol = params.get('symbol');
      const timeframe = params.get('tf');
      const limit = limitOf(params.get('limit'), DEFAULT_ALERTS);
      const history = getAlerts();
      const out = [];
      for (let i = history.length - 1; i >= 0 && out.length < limit; i -= 1) {
        const alert = publicAlert(history[i]);
        if ((symbol === null || alert.symbol === symbol) && (timeframe === null || alert.timeframe === timeframe)) out.push(alert);
      }
      return sendJson(res, 200, out);
    }],

    ['/api/levels', (res, params) => {
      const symbol = params.get('symbol');
      if (symbol === null || !streams.list().some((s) => s.symbol === symbol)) return sendError(res, 404, 'not found');
      const now = clock.now();
      const levels = rules
        .filter((r) => r.type === 'price_cross' && (r.symbol === undefined || r.symbol === symbol) && !ruleExpired(r, now, timezone))
        .map((r) => ({ ruleId: r.id, level: r.level, timeframes: r.timeframes ?? null }));
      return sendJson(res, 200, levels);
    }],

    ['/api/gauntlet', async (res) => {
      const dir = `${home}/gauntlet`;
      const out = [];
      for (const name of await newestFiles(dir, GAUNTLET_FILE)) {
        const report = parseGauntletReport(await readSmallFile(`${dir}/${name}`), { fileFingerprint: name.slice(0, 64) });
        if (report !== null) out.push(report);
      }
      return sendJson(res, 200, out);
    }],

    ['/api/paper', async (res) => {
      const out = [];
      for (const name of await newestFiles(`${home}/paper`, PAPER_FILE)) {
        const fingerprint = name.slice(0, 64);
        const text = await readSmallFile(`${home}/paper/${name}`);
        if (text === null) continue; // symlink, oversize or unreadable: skipped, like a damaged report
        const events = parsePaperJournal(text);
        const report = parseGauntletReport(await readSmallFile(`${home}/gauntlet/${fingerprint}.json`), { fileFingerprint: fingerprint });
        out.push({
          fingerprint,
          strategy: report?.strategy ?? null,
          symbol: report?.symbol ?? null,
          timeframe: report?.timeframe ?? null,
          events,
        });
      }
      return sendJson(res, 200, out);
    }],
  ]);

  // ------------------------------------------------------------ events (SSE)

  function removeClient(res) {
    clients.delete(res);
    if (clients.size > 0) return;
    if (heartbeat !== null) clock.clearInterval(heartbeat);
    heartbeat = null;
    for (const slot of bars.values()) if (slot.timer !== null) clock.clearTimeout(slot.timer);
    bars.clear();
  }

  function write(res, text) {
    if (res.destroyed || res.writableLength > MAX_SSE_BUFFER) {
      removeClient(res);
      res.destroy();
      return;
    }
    res.write(text);
  }

  function broadcast(event, data) {
    if (clients.size === 0) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of [...clients]) write(res, frame);
  }

  function sendBar(slot, stream, candle) {
    slot.sentAt = clock.now();
    broadcast('bar', { symbol: stream.symbol, timeframe: stream.timeframe, candle: pickCandle(candle) });
  }

  /** First bar of a second goes out at once; later ones in that second leave only the newest, sent when the second ends. */
  function onBar(stream, candle) {
    if (clients.size === 0) return;
    let slot = bars.get(stream.key);
    if (slot === undefined) {
      slot = { sentAt: -Infinity, timer: null, pending: null };
      bars.set(stream.key, slot);
    }
    const since = clock.now() - slot.sentAt;
    if (slot.timer === null && since >= COALESCE_MS) {
      sendBar(slot, stream, candle);
      return;
    }
    slot.pending = { stream, candle };
    if (slot.timer === null) {
      slot.timer = clock.setTimeout(() => {
        slot.timer = null;
        const { stream: s, candle: c } = slot.pending;
        slot.pending = null;
        if (clients.size > 0) sendBar(slot, s, c);
      }, COALESCE_MS - since);
    }
  }
  const onAlert = (entry) => { if (clients.size > 0) broadcast('alert', publicAlert(entry)); };
  const onHealth = (list) => { if (clients.size > 0) broadcast('health', publicStreams(list)); };

  function openEvents(res) {
    if (clients.size >= MAX_SSE_CLIENTS) return sendError(res, 503, 'too many event clients');
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      ...SECURITY_HEADERS,
    });
    res.write(': connected\n\n');
    clients.add(res);
    res.on('close', () => removeClient(res));
    if (heartbeat === null) {
      heartbeat = clock.setInterval(() => {
        for (const client of [...clients]) write(client, ': hb\n\n');
      }, HEARTBEAT_MS);
    }
    return undefined;
  }

  // ------------------------------------------------------------ requests

  async function route(req, res) {
    if (loopback && !LOOPBACK_HOST_NAMES.has(hostName(req.headers.host))) return sendError(res, 403, 'forbidden host');
    if (req.method !== 'GET') return sendError(res, 405, 'method not allowed', { allow: 'GET' });

    const rawUrl = typeof req.url === 'string' ? req.url : '/';
    const question = rawUrl.indexOf('?');
    const path = question < 0 ? rawUrl : rawUrl.slice(0, question);
    const search = question < 0 ? '' : rawUrl.slice(question + 1);
    const params = new URLSearchParams(search);

    if (token !== '' && !tokenMatches(req.headers.authorization, token) && !tokensEqual(cookieToken(req.headers.cookie), token)) {
      if (!params.getAll('token').some((given) => tokensEqual(given, token))) return sendError(res, 401, 'unauthorized');
      // Back to the same page without the token in the URL. Never to another site: "//x" and "/\x" are protocol-relative.
      const rest = withoutToken(search);
      const target = /^\/[\\/]/.test(path) || !path.startsWith('/') ? '/' : path;
      return send(res, 302, '', {
        location: rest === '' ? target : `${target}?${rest}`,
        'set-cookie': `tvw_dash=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
      });
    }

    if (path === '/events') return openEvents(res);
    const file = files.get(path);
    if (file !== undefined) return send(res, 200, file.body, { 'content-type': file.type, 'content-length': file.body.length });
    const handler = api.get(path);
    if (handler !== undefined) return handler(res, params);
    return sendError(res, 404, 'not found');
  }

  // requireHostHeader off: Node would answer a request with no Host by itself, with a bare 400 that skips send().
  // A missing Host then reaches the loopback check below and gets the same 403 as a wrong one.
  const server = createServer({ requireHostHeader: false }, (req, res) => {
    route(req, res).catch((err) => {
      logger.error(`dashboard request failed: ${errorMessage(err)}`);
      if (!res.headersSent) sendError(res, 500, 'internal error');
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  server.on('clientError', (err, socket) => {
    if (!socket.writable) return socket.destroy();
    const lines = Object.entries(SECURITY_HEADERS).map(([name, value]) => `${name}: ${value}\r\n`).join('');
    return socket.end(`HTTP/1.1 400 Bad Request\r\n${lines}content-length: 0\r\nconnection: close\r\n\r\n`);
  });

  async function loadAssets() {
    for (const [urlPath, file] of Object.entries(assets)) {
      try {
        files.set(urlPath, { body: await readFile(file), type: assetType(urlPath) });
      } catch (err) {
        logger.warn(`dashboard: ${urlPath} is not served (${err?.code ?? 'read error'}); the page will be incomplete`);
      }
    }
  }

  return {
    server,

    /** Loads the static files, binds, and starts listening to the bus. Rejects if the port cannot be bound. */
    async listen() {
      await loadAssets();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      server.on('error', (err) => logger.error(`dashboard server error: ${errorMessage(err)}`));
      bus.on('bar', onBar);
      bus.on('alert', onAlert);
      bus.on('health', onHealth);
      const address = server.address();
      return { host: address.address, port: address.port };
    },

    /** Ends every event stream, stops listening to the bus and closes the server. Safe to call twice. */
    async close() {
      bus.off('bar', onBar);
      bus.off('alert', onAlert);
      bus.off('health', onHealth);
      for (const res of [...clients]) {
        removeClient(res);
        res.destroy();
      }
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise((resolve) => { server.close(resolve); });
    },

    clientCount: () => clients.size,
  };
}

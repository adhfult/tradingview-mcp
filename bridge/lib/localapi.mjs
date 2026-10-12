/**
 * Local HTTP API on 127.0.0.1 only (never another interface).
 *
 * - POST /notify: needs `Authorization: Bearer <WATCHER_LOCAL_TOKEN>`. The token is
 *   compared with crypto.timingSafeEqual on SHA-256 digests (equal-length buffers).
 *   Body: JSON {title (<=200), body (<=2000), key (<=200), level: info|up|down}.
 *   Body up to 8 KB. Responses: 202 accepted, 400 bad body, 401 bad token. The
 *   payload goes through the same alerts pipeline (dedupe by key).
 * - GET /health: no auth and no secrets. {ok, streams: {healthy, total},
 *   uptime_s, disconnects}.
 *
 * The API starts only when local_api.enabled is on AND a token is set. The caller
 * decides that (see watcher.mjs).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

export const MAX_BODY_BYTES = 8192;
export const TITLE_LIMIT = 200;
export const BODY_LIMIT = 2000;
export const KEY_LIMIT = 200;
const LEVELS = ['info', 'up', 'down'];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * True when two tokens are equal, in constant time. Both sides are hashed first, so the buffers
 * are always the same length and neither the comparison time nor an early return reveals anything
 * about the token or its length. An empty or non-string token never matches. Shared with the dashboard.
 */
export function tokensEqual(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected === '') return false;
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** True when `header` is "Bearer <token>" and the token matches (constant time). */
export function tokenMatches(header, token) {
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match !== null && tokensEqual(match[1], token);
}

const nonBlank = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max;

/** Validates a /notify body. The error text never echoes the input. */
export function parseNotifyBody(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, message: 'body must be JSON' };
  }
  if (!isPlainObject(data)) return { ok: false, message: 'body must be a JSON object' };
  if (!nonBlank(data.title, TITLE_LIMIT)) {
    return { ok: false, message: `title is required (1 to ${TITLE_LIMIT} characters)` };
  }
  if (data.body !== undefined && (typeof data.body !== 'string' || data.body.length > BODY_LIMIT)) {
    return { ok: false, message: `body must be a string of at most ${BODY_LIMIT} characters` };
  }
  if (!nonBlank(data.key, KEY_LIMIT)) {
    return { ok: false, message: `key is required (1 to ${KEY_LIMIT} characters)` };
  }
  const level = data.level ?? 'info';
  if (!LEVELS.includes(level)) return { ok: false, message: 'level must be info, up or down' };
  return {
    ok: true,
    value: { title: data.title, body: data.body ?? '', key: data.key, level },
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(new Error(`body is larger than ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function send(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(text);
}

/**
 * `submit(value)` receives a validated notify payload. `health()` returns the
 * /health body. `logger` is the redacted logger.
 */
export function createLocalApi({ port, token, submit, health, logger, host = '127.0.0.1' }) {
  const handle = async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && path === '/health') {
      send(res, 200, health());
      return;
    }

    if (req.method === 'POST' && path === '/notify') {
      if (!tokenMatches(req.headers.authorization, token)) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        // Refuse before reading anything, and drop the connection.
        send(res, 400, { error: 'body is too large' }, { connection: 'close' });
        return;
      }
      let raw;
      try {
        raw = await readBody(req, MAX_BODY_BYTES);
      } catch (err) {
        send(res, 400, { error: 'body could not be read' }, { connection: 'close' });
        logger.warn(`local API: ${err.message}`);
        return;
      }
      const parsed = parseNotifyBody(raw);
      if (!parsed.ok) {
        send(res, 400, { error: parsed.message });
        return;
      }
      try {
        submit(parsed.value);
      } catch (err) {
        logger.error(`local API notify failed: ${err?.message ?? 'error'}`);
        send(res, 500, { error: 'internal error' });
        return;
      }
      send(res, 202, { accepted: true });
      return;
    }

    send(res, 404, { error: 'not found' });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error(`local API request failed: ${err?.message ?? 'error'}`);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  // Slow or stalled clients cannot hold a connection open for long.
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  return {
    server,

    /** Binds to 127.0.0.1. Resolves with the bound port (useful when port is 0 in tests). */
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          resolve({ host, port: server.address().port });
        });
      });
    },

    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

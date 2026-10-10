import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { format } from 'node:util';
import { BridgeValidationError, errorMessage, isConnectionError, toBridgeError } from './lib/errors.mjs';
import { makeRedactor } from './lib/redact.mjs';
import { createSemaphore } from './lib/semaphore.mjs';
import * as v from './lib/validate.mjs';

const requireFromHere = createRequire(import.meta.url);
const DEFAULT_CANDLE_COUNT = 300;
const DEFAULT_INDICATOR_COUNT = 100;
const SEARCH_LIMIT = 20;
const SYMBOL_INFO_KEY_LIMIT = 40;
const HOTLIST_KINDS = ['gainers', 'losers', 'mostActive', 'volumeGainers'];
const MAX_BAR_COUNT = 5000;
const MAX_HISTORY_BARS = 20000;

function readLibVersion() {
  try {
    return requireFromHere('@mathieuc/tradingview/package.json').version;
  } catch {
    return null;
  }
}

const LIB_VERSION = readLibVersion();

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;
const optional = (value, parse) => (v.isAbsent(value) ? undefined : parse(value));

function readCredentials(env) {
  if (nonEmpty(env.TRADINGVIEW_SESSION_ID) && nonEmpty(env.TRADINGVIEW_SESSION_SIGN)) {
    return { session: env.TRADINGVIEW_SESSION_ID, signature: env.TRADINGVIEW_SESSION_SIGN };
  }
  return null;
}

function readMaxInflight(env) {
  const n = Number(env.TRADINGVIEW_BRIDGE_MAX_INFLIGHT) || 2;
  return Math.min(8, Math.max(1, Math.floor(n)));
}

function pickDefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function pickPrimitives(object, limit) {
  const out = {};
  for (const [key, value] of Object.entries(object ?? {})) {
    if (Object.keys(out).length >= limit) break;
    const kind = typeof value;
    if (kind === 'string' || kind === 'number' || kind === 'boolean') out[key] = value;
  }
  return out;
}

function indicatorName(indicator) {
  if (indicator === null || typeof indicator !== 'object') return null;
  for (const key of ['description', 'shortDescription', 'type']) {
    if (typeof indicator[key] === 'string' && indicator[key] !== '') return indicator[key];
  }
  return null;
}

const safe = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};

const toCandle = ({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume });

function parseCandles(params) {
  const base = {
    symbol: v.symbol(params.symbol),
    timeframe: optional(params.timeframe, v.timeframe) ?? 'D',
    timeoutMs: v.timeoutMs(params.timeoutMs),
  };

  if (!v.isAbsent(params.from)) {
    if (!v.isAbsent(params.count)) throw new BridgeValidationError('use either count or from, not both');
    const from = v.integer(params.from, 'from', { min: 0, max: Number.MAX_SAFE_INTEGER });
    const to = optional(params.to, (value) => v.integer(value, 'to', { min: 0, max: Number.MAX_SAFE_INTEGER }));
    if (to !== undefined && to < from) throw new BridgeValidationError('to must not be before from');
    const maxCount = optional(params.maxCount, (value) => v.integer(value, 'maxCount', { min: 1, max: MAX_HISTORY_BARS }));
    return { ...base, from, to, maxCount };
  }

  if (!v.isAbsent(params.to) || !v.isAbsent(params.maxCount)) {
    throw new BridgeValidationError('to and maxCount require from');
  }
  const count = optional(params.count, (value) => v.integer(value, 'count', { min: 1, max: MAX_BAR_COUNT }))
    ?? DEFAULT_CANDLE_COUNT;
  return { ...base, count };
}

function parseScalarOrList(value, name) {
  const isScalar = (item) => ['string', 'number', 'boolean'].includes(typeof item) || item === null;
  if (isScalar(value)) return value;
  if (Array.isArray(value) && value.length <= 50 && value.every(isScalar)) return value;
  throw new BridgeValidationError(`${name} must be a scalar or a short list of scalars`);
}

function parseFilter(value) {
  return v.array(value, 'filter', { min: 0, max: 50 }).map((item) => {
    v.plainObject(item, 'filter item');
    return pickDefined({
      left: v.string(item.left, 'filter.left', { min: 1, max: 200 }),
      operation: v.string(item.operation, 'filter.operation', { min: 1, max: 50 }),
      right: item.right === undefined ? undefined : parseScalarOrList(item.right, 'filter.right'),
    });
  });
}

function parseSort(value) {
  v.plainObject(value, 'sort');
  if (value.sortOrder !== 'asc' && value.sortOrder !== 'desc') {
    throw new BridgeValidationError('sort.sortOrder must be asc or desc');
  }
  return {
    sortBy: v.string(value.sortBy, 'sort.sortBy', { min: 1, max: 100 }),
    sortOrder: value.sortOrder,
  };
}

/**
 * Builds the JSON-RPC server. `lib` holds the library functions plus
 * TradingViewClient. Lines from `input` are answered on `output`; logs go to
 * `log`. `done` resolves once `input` has closed and every request has been
 * answered.
 */
export function createServer({
  lib,
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  log = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  if (!lib) throw new TypeError('createServer requires lib');

  const redact = makeRedactor(env);
  const credentials = readCredentials(env);
  const semaphore = createSemaphore(readMaxInflight(env));
  let client = null;

  const logError = (prefix, err) => log(`[bridge] ${prefix}: ${redact(errorMessage(err))}`);

  const getClient = () => {
    if (client === null) {
      client = new lib.TradingViewClient(credentials ? { credentials } : {});
    }
    return client;
  };

  const dropClient = async (used) => {
    if (client === used) client = null;
    try {
      await used.close();
    } catch (err) {
      logError('client close failed', err);
    }
  };

  // Runs a websocket-based library call on the shared client. A connection
  // error drops that client, so the next call opens a new one.
  const wsCall = (fn) => async () => {
    const used = getClient();
    try {
      return await fn(used);
    } catch (err) {
      if (isConnectionError(err?.code)) void dropClient(used);
      throw err;
    }
  };

  const send = (id, body) => {
    let line;
    try {
      line = JSON.stringify({ id, ...body });
    } catch {
      line = JSON.stringify({ id, error: { code: 'UPSTREAM_ERROR', message: 'response could not be encoded' } });
    }
    try {
      output.write(`${line}\n`);
    } catch (err) {
      logError('write failed', err);
    }
  };

  const handlers = {
    async health() {
      return {
        ok: true,
        libVersion: LIB_VERSION,
        node: process.version,
        hasCredentials: credentials !== null,
      };
    },

    async candles(params) {
      const q = parseCandles(params);
      const bars = await semaphore.run(wsCall((conn) => lib.getCandles(pickDefined({ ...q, client: conn }))));
      return (Array.isArray(bars) ? bars : []).map(toCandle);
    },

    async quotes(params) {
      const symbols = v.array(params.symbols, 'symbols', { min: 1, max: 50 }).map((item) => v.symbol(item));
      const timeoutMs = v.timeoutMs(params.timeoutMs);
      return semaphore.run(wsCall((conn) => lib.getQuotes({ symbols, timeoutMs, client: conn })));
    },

    async indicator(params) {
      const symbol = v.symbol(params.symbol);
      const timeframe = optional(params.timeframe, v.timeframe) ?? 'D';
      const indicator = v.string(params.indicator, 'indicator', { min: 1, max: 200 });
      const inputs = optional(params.inputs, (value) => v.plainObject(value, 'inputs'));
      const count = optional(params.count, (value) => v.integer(value, 'count', { min: 1, max: 500 }))
        ?? DEFAULT_INDICATOR_COUNT;
      const timeoutMs = v.timeoutMs(params.timeoutMs);

      const data = await semaphore.run(wsCall((conn) => lib.getIndicatorData(pickDefined({
        symbol, timeframe, indicator, inputs, count, timeoutMs, client: conn,
      }))));

      const rows = Array.isArray(data.values) ? data.values : [];
      return {
        name: indicatorName(data.indicator),
        values: rows.slice(-count).map(({ $time, ...plots }) => ({ time: $time, ...plots })),
        strategy: data.strategyReport ? safe(() => lib.summarizeStrategyReport(data.strategyReport)) : null,
      };
    },

    async search(params) {
      const query = v.string(params.query, 'query', { min: 1, max: 60 });
      const type = optional(params.type, (value) => v.string(value, 'type', { min: 1, max: 60 }));
      const timeoutMs = v.timeoutMs(params.timeoutMs);
      // searchMarkets takes HttpOptions only: no credentials are passed.
      const results = await semaphore.run(() => lib.searchMarkets(query, pickDefined({
        type, signal: AbortSignal.timeout(timeoutMs),
      })));
      return (Array.isArray(results) ? results : []).slice(0, SEARCH_LIMIT).map((r) => ({
        id: r.id,
        symbol: r.symbol,
        exchange: r.exchange,
        fullExchange: r.fullExchange,
        type: r.type,
        description: r.description,
      }));
    },

    async symbol_info(params) {
      const symbol = v.symbol(params.symbol);
      const timeoutMs = v.timeoutMs(params.timeoutMs);
      const info = await semaphore.run(wsCall((conn) => lib.getSymbolInfo({ symbol, timeoutMs, client: conn })));
      return pickPrimitives(info, SYMBOL_INFO_KEY_LIMIT);
    },

    async screener(params) {
      const market = optional(params.market, (value) => v.string(value, 'market', { min: 1, max: 40 }));
      const columns = v.array(params.columns, 'columns', { min: 1, max: 20 })
        .map((item) => v.string(item, 'columns', { min: 1, max: 100 }));
      const filter = optional(params.filter, parseFilter);
      const sort = optional(params.sort, parseSort);
      const range = optional(params.range, (value) => v.range(value, 'range'));
      const timeoutMs = v.timeoutMs(params.timeoutMs);
      const query = pickDefined({ market, columns, filter, sort, range });

      // getScreener is the only HTTP call whose options type accepts credentials.
      const result = await semaphore.run(() => lib.getScreener(query, pickDefined({
        credentials: credentials ?? undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })));
      return { totalCount: result.totalCount, rows: result.rows };
    },

    async hotlist(params) {
      if (!HOTLIST_KINDS.includes(params.kind)) {
        throw new BridgeValidationError(`kind must be one of ${HOTLIST_KINDS.join(', ')}`);
      }
      const market = optional(params.market, (value) => v.string(value, 'market', { min: 1, max: 40 }));
      const range = optional(params.range, (value) => v.range(value, 'range'));
      const timeoutMs = v.timeoutMs(params.timeoutMs);
      // getHotlist takes HttpOptions only: no credentials are passed.
      const result = await semaphore.run(() => lib.getHotlist(
        pickDefined({ kind: params.kind, market, range }),
        { signal: AbortSignal.timeout(timeoutMs) },
      ));
      return { totalCount: result.totalCount, rows: result.rows };
    },

    async technical(params) {
      const symbol = v.symbol(params.symbol);
      const timeoutMs = v.timeoutMs(params.timeoutMs);
      // getTechnicalAnalysis takes HttpOptions only: no credentials are passed.
      const analysis = await semaphore.run(() => lib.getTechnicalAnalysis(symbol, {
        signal: AbortSignal.timeout(timeoutMs),
      }));
      return analysis ?? null;
    },
  };

  async function handleLine(line) {
    if (typeof line !== 'string' || line.trim() === '') return;

    let request;
    try {
      request = JSON.parse(line);
    } catch {
      send(null, { error: { code: 'INVALID_PARAMETER', message: 'invalid JSON' } });
      return;
    }
    if (!isObject(request)) {
      send(null, { error: { code: 'INVALID_PARAMETER', message: 'request must be a JSON object' } });
      return;
    }

    const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
    try {
      if (typeof request.method !== 'string' || !Object.hasOwn(handlers, request.method)) {
        throw new BridgeValidationError('unknown method');
      }
      const params = v.isAbsent(request.params) ? {} : v.plainObject(request.params, 'params');
      const result = await handlers[request.method](params);
      send(id, { result: result ?? null });
    } catch (err) {
      const bridge = toBridgeError(err, redact);
      log(`[bridge] request ${redact(JSON.stringify(id))} failed: ${bridge.code}: ${bridge.message}`);
      send(id, { error: bridge });
    }
  }

  async function close() {
    const current = client;
    client = null;
    if (current === null) return;
    try {
      await current.close();
    } catch (err) {
      logError('client close failed', err);
    }
  }

  const pending = new Set();
  let done = Promise.resolve();
  if (input) {
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const task = handleLine(line);
      pending.add(task);
      task.then(() => pending.delete(task), () => pending.delete(task));
    });
    done = new Promise((resolve) => {
      rl.once('close', () => {
        Promise.allSettled([...pending]).then(() => resolve());
      });
    });
  }

  return { handleLine, close, done };
}

async function main() {
  const writeStderr = (text) => process.stderr.write(`${text}\n`);
  for (const level of ['log', 'info', 'debug']) {
    console[level] = (...args) => writeStderr(format(...args));
  }

  const redact = makeRedactor(process.env);
  const log = (message) => writeStderr(redact(message));

  process.on('unhandledRejection', (reason) => {
    log(`[bridge] unhandled rejection: ${errorMessage(reason)}`);
    process.exit(1);
  });

  const [root, data] = await Promise.all([
    import('@mathieuc/tradingview'),
    import('@mathieuc/tradingview/data'),
  ]);
  const lib = { ...data, TradingViewClient: root.TradingViewClient };

  const server = createServer({
    lib,
    env: process.env,
    input: process.stdin,
    output: process.stdout,
    log,
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.close();
    await new Promise((resolve) => process.stdout.write('', resolve));
    process.exit(0);
  };

  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await server.done;
  await stop();
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${makeRedactor(process.env)(`[bridge] fatal: ${errorMessage(err)}`)}\n`);
    process.exit(1);
  });
}

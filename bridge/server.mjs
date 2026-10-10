import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { BridgeValidationError, errorMessage, toBridgeError } from './lib/errors.mjs';
import { createClientManager } from './lib/client.mjs';
import { timeoutError, withDeadline } from './lib/deadline.mjs';
import { makeRedactor } from './lib/redact.mjs';
import { createSemaphore } from './lib/semaphore.mjs';
import { guardStdio } from './lib/stdio.mjs';
import * as v from './lib/validate.mjs';

const requireFromHere = createRequire(import.meta.url);
const DEFAULT_CANDLE_COUNT = 300;
const DEFAULT_INDICATOR_COUNT = 100;
const SEARCH_LIMIT = 20;
const SYMBOL_INFO_KEY_LIMIT = 40;
const HOTLIST_KINDS = ['gainers', 'losers', 'mostActive', 'volumeGainers'];
const MAX_BAR_COUNT = 5000;
const MAX_HISTORY_BARS = 20000;
// Unix seconds; the year 2100. Rejects millisecond timestamps passed by mistake.
const MAX_UNIX_SECONDS = 4102444800;
// A request line larger than this is refused before it is parsed.
const MAX_LINE_LENGTH = 1_000_000;
// How long past the library's own timeout a call may run before the bridge gives up on it.
const DEFAULT_DEADLINE_GRACE_MS = 5000;
const SHUTDOWN_GRACE_MS = 5000;

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

// A study that is not a strategy still carries an empty report ({trades: [], performance: {}}).
function hasStrategyReport(report) {
  if (report === null || typeof report !== 'object') return false;
  const trades = Array.isArray(report.trades) ? report.trades.length : 0;
  const performance = report.performance !== null && typeof report.performance === 'object'
    ? Object.keys(report.performance).length
    : 0;
  return trades > 0 || performance > 0;
}

const toCandle = ({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume });

function parseCandles(params) {
  const base = {
    symbol: v.symbol(params.symbol),
    timeframe: optional(params.timeframe, v.timeframe) ?? 'D',
    timeoutMs: v.timeoutMs(params.timeoutMs),
  };

  if (!v.isAbsent(params.from)) {
    if (!v.isAbsent(params.count)) throw new BridgeValidationError('use either count or from, not both');
    const from = v.integer(params.from, 'from', { min: 0, max: MAX_UNIX_SECONDS });
    const to = optional(params.to, (value) => v.integer(value, 'to', { min: 0, max: MAX_UNIX_SECONDS }));
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
      left: v.nonBlankString(item.left, 'filter.left', { max: 200 }),
      operation: v.nonBlankString(item.operation, 'filter.operation', { max: 50 }),
      right: item.right === undefined ? undefined : parseScalarOrList(item.right, 'filter.right'),
    });
  });
}

function parseColumns(value) {
  const columns = v.array(value, 'columns', { min: 1, max: 20 })
    .map((item) => v.nonBlankString(item, 'columns', { max: 100 }));
  if (new Set(columns).size !== columns.length) throw new BridgeValidationError('columns must be unique');
  return columns;
}

function parseSort(value) {
  v.plainObject(value, 'sort');
  if (value.sortOrder !== 'asc' && value.sortOrder !== 'desc') {
    throw new BridgeValidationError('sort.sortOrder must be asc or desc');
  }
  return {
    sortBy: v.nonBlankString(value.sortBy, 'sort.sortBy', { max: 100 }),
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
  deadlineGraceMs = DEFAULT_DEADLINE_GRACE_MS,
  now = Date.now,
} = {}) {
  if (!lib) throw new TypeError('createServer requires lib');

  const redact = makeRedactor(env);
  const credentials = readCredentials(env);
  const semaphore = createSemaphore(readMaxInflight(env));

  // Every log line is redacted here, whatever the caller passes in, and a failing
  // log sink can never break a request.
  const emit = (message) => {
    try {
      log(redact(message));
    } catch {
      // ignore
    }
  };
  const logError = (prefix, err) => emit(`[bridge] ${prefix}: ${errorMessage(err)}`);

  // The shared websocket client: lazy, reused, replaced when dead, closed on shutdown,
  // with an auth-failure cooldown. See lib/client.mjs.
  const clients = createClientManager({ lib, credentials, now, log: (message) => emit(`[bridge] ${message}`) });

  // Runs a websocket-based library call on the shared client, bounded by a hard
  // deadline (the library's timeoutMs plus a grace period).
  const wsCall = (timeoutMs, fn) => () => clients.call(timeoutMs, deadlineGraceMs, fn);

  // Runs an HTTP library call with an AbortSignal that fires after timeoutMs, plus
  // the same hard deadline. fetch reports the abort as a generic HTTP_ERROR, so an
  // abort caused by our timer is turned into TIMEOUT here.
  const httpCall = (timeoutMs, fn) => () => {
    const signal = AbortSignal.timeout(timeoutMs);
    return withDeadline(
      async () => {
        try {
          return await fn(signal);
        } catch (err) {
          if (signal.aborted) throw timeoutError(timeoutMs);
          throw err;
        }
      },
      timeoutMs + deadlineGraceMs,
      () => timeoutError(timeoutMs),
    );
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
      const bars = await semaphore.run(wsCall(q.timeoutMs, (conn) => lib.getCandles(pickDefined({ ...q, client: conn }))));
      return (Array.isArray(bars) ? bars : []).map(toCandle);
    },

    async quotes(params) {
      const symbols = [...new Set(v.array(params.symbols, 'symbols', { min: 1, max: 50 })
        .map((item) => v.symbol(item, 'symbols')))];
      const timeoutMs = v.timeoutMs(params.timeoutMs);
      return semaphore.run(wsCall(timeoutMs, (conn) => lib.getQuotes({ symbols, timeoutMs, client: conn })));
    },

    async indicator(params) {
      const symbol = v.symbol(params.symbol);
      const timeframe = optional(params.timeframe, v.timeframe) ?? 'D';
      const indicator = v.nonBlankString(params.indicator, 'indicator', { max: 200 });
      const inputs = optional(params.inputs, (value) => v.jsonData(v.plainObject(value, 'inputs'), 'inputs'));
      const count = optional(params.count, (value) => v.integer(value, 'count', { min: 1, max: 500 }))
        ?? DEFAULT_INDICATOR_COUNT;
      const timeoutMs = v.timeoutMs(params.timeoutMs);

      const data = await semaphore.run(wsCall(timeoutMs, (conn) => lib.getIndicatorData(pickDefined({
        symbol, timeframe, indicator, inputs, count, timeoutMs, client: conn,
      }))));

      const rows = Array.isArray(data?.values) ? data.values : [];
      return {
        name: indicatorName(data?.indicator),
        values: rows.slice(-count).map(({ $time, ...plots }) => ({ time: $time, ...plots })),
        strategy: hasStrategyReport(data?.strategyReport)
          ? safe(() => lib.summarizeStrategyReport(data.strategyReport))
          : null,
      };
    },

    async search(params) {
      const query = v.nonBlankString(params.query, 'query', { max: 60 });
      const type = optional(params.type, (value) => v.nonBlankString(value, 'type', { max: 60 }));
      const timeoutMs = v.timeoutMs(params.timeoutMs);
      // searchMarkets takes HttpOptions only: no credentials are passed.
      const results = await semaphore.run(httpCall(timeoutMs, (signal) => lib.searchMarkets(query, pickDefined({
        type, signal,
      }))));
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
      const info = await semaphore.run(wsCall(timeoutMs, (conn) => lib.getSymbolInfo({ symbol, timeoutMs, client: conn })));
      return pickPrimitives(info, SYMBOL_INFO_KEY_LIMIT);
    },

    async screener(params) {
      const market = optional(params.market, (value) => v.market(value));
      const columns = parseColumns(params.columns);
      const filter = optional(params.filter, parseFilter);
      const sort = optional(params.sort, parseSort);
      const range = optional(params.range, (value) => v.range(value, 'range'));
      const timeoutMs = v.timeoutMs(params.timeoutMs);
      const query = pickDefined({ market, columns, filter, sort, range });

      // getScreener is the only HTTP call whose options type accepts credentials.
      const result = await semaphore.run(httpCall(timeoutMs, (signal) => lib.getScreener(query, pickDefined({
        credentials: credentials ?? undefined,
        signal,
      }))));
      return { totalCount: result?.totalCount, rows: result?.rows };
    },

    async hotlist(params) {
      if (!HOTLIST_KINDS.includes(params.kind)) {
        throw new BridgeValidationError(`kind must be one of ${HOTLIST_KINDS.join(', ')}`);
      }
      const market = optional(params.market, (value) => v.market(value));
      const range = optional(params.range, (value) => v.range(value, 'range'));
      const timeoutMs = v.timeoutMs(params.timeoutMs);
      // Deliberately anonymous, not just a type limit: same scanner endpoint as screener, and an
      // anonymous request ties rate limits to our IP instead of the account, better for a 24/7 scan.
      const result = await semaphore.run(httpCall(timeoutMs, (signal) => lib.getHotlist(
        pickDefined({ kind: params.kind, market, range }),
        { signal },
      )));
      return { totalCount: result?.totalCount, rows: result?.rows };
    },

    async technical(params) {
      const symbol = v.symbol(params.symbol);
      const timeoutMs = v.timeoutMs(params.timeoutMs);
      // getTechnicalAnalysis takes HttpOptions only: no credentials are passed.
      const analysis = await semaphore.run(httpCall(timeoutMs, (signal) => lib.getTechnicalAnalysis(symbol, { signal })));
      return analysis ?? null;
    },
  };

  async function handleLine(line) {
    if (typeof line !== 'string' || line.trim() === '') return;
    if (line.length > MAX_LINE_LENGTH) {
      send(null, { error: { code: 'INVALID_PARAMETER', message: 'request too large' } });
      return;
    }

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
      emit(`[bridge] request ${JSON.stringify(id)} failed: ${bridge.code}: ${bridge.message}`);
      send(id, { error: bridge });
    }
  }

  const close = () => clients.close();

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
  const redact = makeRedactor(process.env);

  // Before anything else (and before the library is imported): stdout must carry
  // protocol lines only. Console output, stray stdout writes and stderr text from
  // the library are redirected to redacted stderr.
  const protocolOut = guardStdio({ redact });
  const log = (message) => process.stderr.write(`${message}\n`);

  process.on('unhandledRejection', (reason) => {
    log(`[bridge] unhandled rejection: ${errorMessage(reason)}`);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    log(`[bridge] uncaught exception: ${errorMessage(err)}`);
    process.exit(1);
  });
  // The parent closing the pipe must end the bridge quietly, not crash it.
  process.stdout.on('error', () => process.exit(0));

  const [root, data] = await Promise.all([
    import('@mathieuc/tradingview'),
    import('@mathieuc/tradingview/data'),
  ]);
  const lib = { ...data, TradingViewClient: root.TradingViewClient };

  const server = createServer({
    lib,
    env: process.env,
    input: process.stdin,
    output: protocolOut,
    log,
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const hardStop = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
    hardStop.unref();
    await server.close();
    await new Promise((resolve) => protocolOut.write('', resolve));
    process.exit(0);
  };

  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await server.done;
  await stop();
}

// Compare real paths: Node resolves symlinks in import.meta.url but not in argv[1].
function isEntryPoint() {
  if (process.argv[1] === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isEntryPoint()) {
  main().catch((err) => {
    process.stderr.write(`${makeRedactor(process.env)(`[bridge] fatal: ${errorMessage(err)}`)}\n`);
    process.exit(1);
  });
}

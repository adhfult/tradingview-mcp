/**
 * One live candle stream per symbol x timeframe, all sharing the one client from
 * lib/client.mjs.
 *
 * Closed-bar detection:
 * - The last bar in a snapshot is the forming bar. When its time moves past the
 *   forming bar we saw last time, the bars before it that were forming then are now
 *   closed, and each one is passed to `onClosedBar` with the candles up to and
 *   including it. The forming bar is never evaluated.
 * - The first snapshot after a start or restart only records the forming bar.
 *   Nothing is evaluated, so a restart never replays old bars.
 * - `evaluated.get/set` (the persisted state) stops any bar time from being
 *   evaluated twice, including across restarts.
 *
 * Restarts: a failure (onError, a watcher that closes unexpectedly or a failed
 * start) stops the watcher and restarts it after 5s, 10s, 30s, then 60s, plus
 * 0 to 30% random jitter, so N streams do not reconnect in the same instant. The
 * backoff goes back to the start after 10 minutes of healthy data. A connection
 * failure drops the shared client (via clients.reportFailure), so the next start
 * creates a new one. An error that a retry cannot fix (AUTH_ERROR for bad or expired
 * cookies, SYMBOL_ERROR / NO_DATA / SERIES_ERROR / INVALID_ARGUMENT for a typo'd or
 * unavailable symbol) backs off much longer (5, 15, 30, then 60 minutes), so the
 * watcher never hammers TradingView with a request that cannot work.
 *
 * Catch-up: a bar that closes while a stream is reconnecting would otherwise be
 * missed for good. On the first snapshot after a (re)start, bars that closed after
 * the persisted `lastEvaluatedTime` are evaluated once, but only recent ones (within
 * two bar lengths, at least 5 minutes), so a long outage never replays old bars.
 */
import { errorMessage } from './errors.mjs';
import { timeframeSeconds } from './format.mjs';

export const CANDLE_COUNT = 300;
export const RESTART_BACKOFF_MS = Object.freeze([5000, 10000, 30000, 60000]);
export const JITTER_RATIO = 0.3;
export const BACKOFF_RESET_MS = 10 * 60_000;
export const LONG_BACKOFF_MS = Object.freeze([5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000]);
/** Kept for the earlier name. */
export const AUTH_BACKOFF_MS = LONG_BACKOFF_MS;
/** Error codes that a quick retry cannot fix. */
export const LONG_BACKOFF_CODES = Object.freeze(['AUTH_ERROR', 'SYMBOL_ERROR', 'NO_DATA', 'SERIES_ERROR', 'INVALID_ARGUMENT']);
export const CATCHUP_MIN_SECONDS = 300;

/**
 * `streams`: [{key, symbol, timeframe, market}]. `lib.watchCandles` and the
 * clients manager come from the caller. `logger` has info, warn and error methods
 * and is expected to redact.
 */
export function createStreams({
  streams,
  lib,
  clients,
  clock,
  logger,
  evaluated,
  onClosedBar,
  random = Math.random,
  count = CANDLE_COUNT,
  onConnection = () => {},
}) {
  let stopping = false;
  let lastIssued = null;
  // Shared connections lost. One drop can fail every stream on it, so each client counts once.
  const droppedConnections = new WeakSet();
  let connectionDrops = 0;

  const list = streams.map((entry) => ({
    key: entry.key,
    symbol: entry.symbol,
    timeframe: entry.timeframe,
    market: entry.market,
    status: 'idle', // idle | starting | healthy | restarting | stopped
    gen: 0,
    watcher: null,
    lastBarTime: null,
    lastDataAt: null,
    attempt: 0,
    healthySince: null,
    restartTimer: null,
    disconnects: 0,
    longFailures: 0,
    lastError: null,
    silentRestarted: false,
  }));

  const iso = () => new Date(clock.now()).toISOString();

  const stopQuietly = async (watcher) => {
    try {
      await watcher.stop();
    } catch (err) {
      logger.warn(`watcher stop failed: ${errorMessage(err)}`);
    }
  };

  const nextDelay = (s, code) => {
    if (s.healthySince !== null && clock.now() - s.healthySince >= BACKOFF_RESET_MS) s.attempt = 0;
    let base = RESTART_BACKOFF_MS[Math.min(s.attempt, RESTART_BACKOFF_MS.length - 1)];
    s.attempt += 1;
    if (LONG_BACKOFF_CODES.includes(code)) {
      s.longFailures += 1;
      base = Math.max(base, LONG_BACKOFF_MS[Math.min(s.longFailures - 1, LONG_BACKOFF_MS.length - 1)]);
    }
    return Math.round(base * (1 + JITTER_RATIO * random()));
  };

  /** Evaluates the closed bar at index `i` of `candles` (never the last, forming, bar). */
  function evaluateBar(s, candles, i) {
    const bar = candles[i];
    const done = evaluated.get(s.key);
    if (done !== undefined && bar.time <= done) return;
    evaluated.set(s.key, bar.time);
    try {
      onClosedBar(s, candles.slice(0, i + 1), candles[i + 1].time);
    } catch (err) {
      logger.error(`rule evaluation failed on ${s.key}: ${errorMessage(err)}`);
    }
  }

  /** First snapshot after a (re)start: evaluate recent bars that closed while we were away. */
  function catchUp(s, candles) {
    const done = evaluated.get(s.key);
    if (done === undefined) return;
    const seconds = timeframeSeconds(s.timeframe) ?? 0;
    const windowMs = Math.max(2 * seconds, CATCHUP_MIN_SECONDS) * 1000;
    const now = clock.now();
    for (let i = 0; i < candles.length - 1; i += 1) {
      if (candles[i].time <= done) continue;
      if (now - candles[i + 1].time * 1000 > windowMs) continue;
      evaluateBar(s, candles, i);
    }
  }

  function handleData(s, candles) {
    const t = clock.now();
    s.lastDataAt = t;
    if (s.healthySince === null) s.healthySince = t;
    s.status = 'healthy';
    s.longFailures = 0;
    s.silentRestarted = false;
    if (!Array.isArray(candles) || candles.length === 0) return;

    const last = candles[candles.length - 1].time;
    if (s.lastBarTime === null) {
      // First snapshot after start or restart: record the forming bar. Only bars that
      // closed very recently while we were away are evaluated (see catchUp).
      s.lastBarTime = last;
      catchUp(s, candles);
      return;
    }
    if (last <= s.lastBarTime) return;

    // Bars before the forming one that were still forming at our last snapshot are now closed.
    for (let i = 0; i < candles.length - 1; i += 1) {
      if (candles[i].time < s.lastBarTime) continue;
      evaluateBar(s, candles, i);
    }
    s.lastBarTime = last;
  }

  function fail(s, gen, err, client) {
    if (gen !== s.gen || stopping) return;
    s.gen += 1;
    s.disconnects += 1;
    const code = err?.code ?? err?.name ?? 'error';
    s.lastError = String(code);
    logger.warn(`${s.key} disconnected at ${iso()} (${code})`);

    const old = s.watcher;
    s.watcher = null;
    if (old !== null) void stopQuietly(old);
    if (client) {
      if (clients.mustDrop(err, client) && !droppedConnections.has(client)) {
        droppedConnections.add(client);
        connectionDrops += 1;
        logger.warn(`shared connection lost at ${iso()} (${code})`);
      }
      clients.reportFailure(err, client);
    }

    const delay = nextDelay(s, code);
    s.status = 'restarting';
    logger.info(`${s.key} restarting in ${Math.round(delay / 1000)}s (attempt ${s.attempt})`);
    s.restartTimer = clock.setTimeout(() => {
      s.restartTimer = null;
      void open(s);
    }, delay);
  }

  async function open(s) {
    if (stopping) return;
    const gen = s.gen + 1;
    s.gen = gen;
    s.status = 'starting';
    s.lastBarTime = null;
    s.healthySince = null;
    if (s.lastDataAt === null) s.lastDataAt = clock.now();

    let client;
    try {
      client = clients.get();
    } catch (err) {
      fail(s, gen, err, null);
      return;
    }
    if (client !== lastIssued) {
      lastIssued = client;
      onConnection(client);
    }

    try {
      const watcher = await lib.watchCandles({
        symbol: s.symbol,
        timeframe: s.timeframe,
        count,
        client,
      }, {
        onData: (candles) => {
          if (gen === s.gen) handleData(s, candles);
        },
        onError: (err) => fail(s, gen, err, client),
      });
      if (gen !== s.gen || stopping) {
        await stopQuietly(watcher);
        return;
      }
      s.watcher = watcher;
      watcher.closed.then(
        () => fail(s, gen, new Error('watcher closed'), client),
        (err) => fail(s, gen, err, client),
      );
    } catch (err) {
      fail(s, gen, err, client);
    }
  }

  return {
    /** Starts every stream. Each one reports its own failures, so this never rejects. */
    start() {
      stopping = false;
      for (const s of list) void open(s);
    },

    /** Stops every watcher and cancels pending restarts. */
    async stop() {
      stopping = true;
      await Promise.all(list.map(async (s) => {
        s.gen += 1;
        if (s.restartTimer !== null) {
          clock.clearTimeout(s.restartTimer);
          s.restartTimer = null;
        }
        const watcher = s.watcher;
        s.watcher = null;
        s.status = 'stopped';
        if (watcher !== null) await stopQuietly(watcher);
      }));
    },

    /** Read-only status of every stream, for health and the local API. */
    list() {
      return list.map((s) => ({
        key: s.key,
        symbol: s.symbol,
        timeframe: s.timeframe,
        market: s.market,
        status: s.status,
        lastDataAt: s.lastDataAt,
        attempt: s.attempt,
        disconnects: s.disconnects,
        lastError: s.lastError,
      }));
    },

    /**
     * Restarts one stream that is connected but silent, through the normal failure path
     * (backoff, jitter, counters) with the code SILENT. The shared connection is left alone.
     * Returns false when the stream is unknown, not running, or was already restarted this way
     * without receiving data since.
     */
    restartSilent(key) {
      const s = list.find((entry) => entry.key === key);
      if (!s || stopping || s.status !== 'healthy' || s.silentRestarted) return false;
      s.silentRestarted = true;
      fail(s, s.gen, { code: 'SILENT', message: 'no data' }, null);
      return true;
    },

    /** Streams with data flowing right now (first snapshot received, not restarting). */
    healthyCount() {
      return list.filter((s) => s.status === 'healthy').length;
    },

    total: list.length,

    /**
     * `disconnects`: stream failures, summed over streams. `connection_drops`: shared
     * connections lost (a single drop counts once, however many streams it failed).
     */
    counters() {
      return {
        disconnects: list.reduce((sum, s) => sum + s.disconnects, 0),
        connection_drops: connectionDrops,
      };
    },
  };
}

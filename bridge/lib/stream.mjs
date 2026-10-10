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
 * creates a new one.
 */
import { errorMessage } from './errors.mjs';

export const CANDLE_COUNT = 300;
export const RESTART_BACKOFF_MS = Object.freeze([5000, 10000, 30000, 60000]);
export const JITTER_RATIO = 0.3;
export const BACKOFF_RESET_MS = 10 * 60_000;

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
  }));

  const iso = () => new Date(clock.now()).toISOString();

  const stopQuietly = async (watcher) => {
    try {
      await watcher.stop();
    } catch (err) {
      logger.warn(`watcher stop failed: ${errorMessage(err)}`);
    }
  };

  const nextDelay = (s) => {
    if (s.healthySince !== null && clock.now() - s.healthySince >= BACKOFF_RESET_MS) s.attempt = 0;
    const base = RESTART_BACKOFF_MS[Math.min(s.attempt, RESTART_BACKOFF_MS.length - 1)];
    s.attempt += 1;
    return Math.round(base * (1 + JITTER_RATIO * random()));
  };

  function handleData(s, candles) {
    const t = clock.now();
    s.lastDataAt = t;
    if (s.healthySince === null) s.healthySince = t;
    s.status = 'healthy';
    if (!Array.isArray(candles) || candles.length === 0) return;

    const last = candles[candles.length - 1].time;
    if (s.lastBarTime === null) {
      // First snapshot after start or restart: record only, evaluate nothing.
      s.lastBarTime = last;
      return;
    }
    if (last <= s.lastBarTime) return;

    // Bars before the forming one that were still forming at our last snapshot are now closed.
    for (let i = 0; i < candles.length - 1; i += 1) {
      const bar = candles[i];
      if (bar.time < s.lastBarTime) continue;
      const done = evaluated.get(s.key);
      if (done !== undefined && bar.time <= done) continue;
      evaluated.set(s.key, bar.time);
      try {
        onClosedBar(s, candles.slice(0, i + 1), candles[i + 1].time);
      } catch (err) {
        logger.error(`rule evaluation failed on ${s.key}: ${errorMessage(err)}`);
      }
    }
    s.lastBarTime = last;
  }

  function fail(s, gen, err, client) {
    if (gen !== s.gen || stopping) return;
    s.gen += 1;
    s.disconnects += 1;
    const code = err?.code ?? err?.name ?? 'error';
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

    const delay = nextDelay(s);
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
      }));
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

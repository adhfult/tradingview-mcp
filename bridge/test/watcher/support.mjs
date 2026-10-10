/**
 * Shared test doubles for the watcher tests: an injectable clock, a fake fetch and
 * a fake library. Nothing here touches the network or the real clock.
 */

/**
 * Clock with `now()`, `setTimeout`, `setInterval` and `advance(ms)`. Timers fire
 * in time order during `advance`, so tests control time exactly.
 */
export function createFakeClock(start = Date.UTC(2026, 9, 10, 12, 0, 0)) {
  let current = start;
  let seq = 0;
  const timers = new Map();

  const schedule = (fn, ms, interval) => {
    seq += 1;
    timers.set(seq, { at: current + Math.max(0, ms), fn, interval });
    return seq;
  };

  const clock = {
    now: () => current,
    setTimeout: (fn, ms) => schedule(fn, ms, null),
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: (fn, ms) => schedule(fn, ms, ms),
    clearInterval: (id) => { timers.delete(id); },
    /** Number of timers waiting to fire. */
    pending: () => timers.size,
    /** Moves time forward, running due timers in order. */
    advance(ms) {
      const target = current + ms;
      for (;;) {
        let next = null;
        let nextId = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (next === null || timer.at < next.at)) {
            next = timer;
            nextId = id;
          }
        }
        if (next === null) break;
        current = next.at;
        if (next.interval === null) {
          timers.delete(nextId);
        } else {
          next.at = current + next.interval;
        }
        next.fn();
      }
      current = target;
    },
  };
  return clock;
}

/** Lets pending promise callbacks run (a few macrotask turns). */
export const settle = async () => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/**
 * Fake fetch. `responder(url, init, callIndex)` returns a Response (or throws).
 * Records every call as {url, init, body (parsed JSON when possible)}.
 */
export function createFakeFetch(responder = () => new Response('', { status: 204 })) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    let body;
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
    calls.push({ url: String(url), init, body });
    return responder(String(url), init, calls.length);
  };
  return { fetch, calls };
}

/** Helper for responses: JSON with a status and optional headers. */
export function jsonResponse(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * Fake library with TradingViewClient, watchCandles and getHotlist. Each
 * watchCandles call returns a fake watcher whose handlers the test can drive:
 * `feed(candles)`, `fail(code)` and `close()`.
 */
export function createFakeLib({ hotlist = async () => ({ totalCount: 0, rows: [] }) } = {}) {
  const clients = [];
  const watchers = [];
  let failNextWatch = null;

  class TradingViewClient {
    constructor(options = {}) {
      this.options = options;
      this.isClosed = false;
      this.isAuthenticated = false;
      this.closeCalls = 0;
      clients.push(this);
    }

    async close() {
      this.closeCalls += 1;
      this.isClosed = true;
    }
  }

  const watchCandles = async (query, handlers) => {
    if (failNextWatch !== null) {
      const error = failNextWatch;
      failNextWatch = null;
      throw error;
    }
    let resolveClosed;
    const closed = new Promise((resolve) => { resolveClosed = resolve; });
    const watcher = {
      query,
      handlers,
      isActive: true,
      closed,
      latest: [],
      stopCalls: 0,
      async stop() {
        this.stopCalls += 1;
        if (this.isActive) {
          this.isActive = false;
          resolveClosed();
        }
      },
      feed(candles) {
        this.latest = candles;
        handlers.onData(candles);
      },
      fail(code, message = 'simulated failure') {
        const error = Object.assign(new Error(message), { code });
        handlers.onError?.(error);
        if (this.isActive) {
          this.isActive = false;
          resolveClosed();
        }
      },
      /** Closes without an error (the library stopped the watcher on its own). */
      closeQuietly() {
        this.isActive = false;
        resolveClosed();
      },
    };
    watchers.push(watcher);
    return watcher;
  };

  return {
    TradingViewClient,
    watchCandles,
    getHotlist: (query, options) => hotlist(query, options),
    clients,
    watchers,
    /** The next watchCandles call rejects with this error. */
    failNextWatch(error) {
      failNextWatch = error;
    },
  };
}

/** Builds a closed-candle snapshot: `count` bars ending at the forming bar. */
export function snapshot(closesOrBars, { startTime = 1_700_000_000, step = 3600 } = {}) {
  return closesOrBars.map((entry, i) => {
    const bar = typeof entry === 'number' ? { close: entry } : entry;
    const close = bar.close;
    const open = bar.open ?? close;
    return {
      time: startTime + i * step,
      open,
      high: bar.high ?? Math.max(open, close) + 0.5,
      low: bar.low ?? Math.min(open, close) - 0.5,
      close,
      volume: bar.volume ?? 10,
    };
  });
}

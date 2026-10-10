/**
 * Delivery queue. `enqueue` returns at once, so streams are never blocked.
 *
 * Each notifier has its own FIFO lane: its messages go out one at a time, in the order
 * they were queued, so the order is kept and a rate-limit wait (HTTP 429 retry_after)
 * also holds back the messages behind it. Notifiers run in parallel with each other, so a
 * slow Discord never delays Telegram.
 *
 * A failed attempt is retried: 3 attempts in total, with backoff 2s then 5s. On
 * HTTP 429 the wait is the server's retry_after (seconds, capped at 60s) instead.
 * A permanent client error (4xx other than 408 and 429) is dropped at once.
 * After the last failure the job is logged (redacted by the logger) and dropped.
 *
 * Each lane holds at most `maxQueued` waiting messages (200). When it is full the oldest
 * non-critical message is dropped (the oldest message if all are critical), with a log line.
 *
 * Notifiers are `{name, send(message)}`. A failing send throws an error with an
 * optional numeric `status` and `retryAfterSec`. All waits use the injectable clock.
 */
export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS = Object.freeze([2000, 5000]);
export const RETRY_AFTER_CAP_MS = 60_000;
export const MAX_QUEUED = 200;

export function createQueue({
  notifiers,
  clock,
  log = () => {},
  attempts = DEFAULT_ATTEMPTS,
  backoffMs = DEFAULT_BACKOFF_MS,
  retryAfterCapMs = RETRY_AFTER_CAP_MS,
  maxQueued = MAX_QUEUED,
}) {
  let closed = false;
  const lanes = notifiers.map((notifier) => ({ notifier, items: [], current: false, done: Promise.resolve() }));

  const sleep = (ms) => new Promise((resolve) => {
    clock.setTimeout(resolve, ms);
  });

  const waitFor = (err, attempt) => {
    if (err?.status === 429 && Number.isFinite(err.retryAfterSec) && err.retryAfterSec > 0) {
      return Math.min(err.retryAfterSec * 1000, retryAfterCapMs);
    }
    return backoffMs[Math.min(attempt - 1, backoffMs.length - 1)];
  };

  // A 4xx other than 408 and 429 (bad payload, revoked webhook, wrong chat) will fail the same way again.
  const permanent = (err) => typeof err?.status === 'number'
    && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;

  const describe = (err) => {
    if (typeof err?.status === 'number') return `HTTP ${err.status}`;
    return err?.code ?? err?.name ?? 'error';
  };

  const runJob = async (notifier, message) => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await notifier.send(message);
        return true;
      } catch (err) {
        if (permanent(err)) {
          log(`${notifier.name}: alert dropped, not retried (${describe(err)})`);
          return false;
        }
        if (attempt >= attempts) {
          log(`${notifier.name}: alert dropped after ${attempts} attempts (${describe(err)})`);
          return false;
        }
        await sleep(waitFor(err, attempt));
      }
    }
    return false;
  };

  const pump = async (lane) => {
    lane.current = true;
    try {
      while (lane.items.length > 0) {
        const job = lane.items.shift();
        try {
          await runJob(lane.notifier, job.message);
        } catch (err) {
          log(`${lane.notifier.name}: delivery crashed (${describe(err)})`);
        }
      }
    } finally {
      lane.current = false;
    }
  };

  const pendingCount = () => lanes.reduce((sum, lane) => sum + lane.items.length + (lane.current ? 1 : 0), 0);

  return {
    /** Queues a message for every notifier. Never throws, never waits. `critical` protects it from overflow drops. */
    enqueue(message, { critical = false } = {}) {
      if (closed) {
        log('alert dropped: the watcher is shutting down');
        return;
      }
      for (const lane of lanes) {
        if (lane.items.length >= maxQueued) {
          const index = lane.items.findIndex((job) => !job.critical);
          lane.items.splice(index === -1 ? 0 : index, 1);
          log(`${lane.notifier.name}: queue is full (${maxQueued}), the oldest ${index === -1 ? '' : 'non-critical '}alert was dropped`);
        }
        lane.items.push({ message, critical });
        if (!lane.current) lane.done = pump(lane);
      }
    },

    /** Resolves once every queued job has finished (sent or dropped). */
    async idle() {
      while (pendingCount() > 0) {
        await Promise.allSettled(lanes.map((lane) => lane.done));
      }
    },

    /** Number of jobs still waiting or running (sending, or waiting to retry). */
    pending() {
      return pendingCount();
    },

    /** Stops accepting new messages. Jobs already queued still run. */
    close() {
      closed = true;
    },
  };
}

/**
 * Delivery queue. `enqueue` returns at once, so streams are never blocked. Each
 * message goes to every notifier as its own job, and each job runs on its own.
 *
 * A failed attempt is retried: 3 attempts in total, with backoff 2s then 5s. On
 * HTTP 429 the wait is the server's retry_after (seconds, capped at 60s) instead.
 * A permanent client error (4xx other than 408 and 429) is dropped at once.
 * After the last failure the job is logged (redacted by the logger) and dropped.
 *
 * Notifiers are `{name, send(message)}`. A failing send throws an error with an
 * optional numeric `status` and `retryAfterSec`. All waits use the injectable clock.
 */
export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS = Object.freeze([2000, 5000]);
export const RETRY_AFTER_CAP_MS = 60_000;

export function createQueue({
  notifiers,
  clock,
  log = () => {},
  attempts = DEFAULT_ATTEMPTS,
  backoffMs = DEFAULT_BACKOFF_MS,
  retryAfterCapMs = RETRY_AFTER_CAP_MS,
}) {
  const jobs = new Set();
  let closed = false;

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

  return {
    /** Queues a message for every notifier. Never throws, never waits. */
    enqueue(message) {
      if (closed) {
        log('alert dropped: the watcher is shutting down');
        return;
      }
      for (const notifier of notifiers) {
        const job = runJob(notifier, message).catch((err) => {
          log(`${notifier.name}: delivery crashed (${describe(err)})`);
          return false;
        });
        jobs.add(job);
        job.finally(() => jobs.delete(job));
      }
    },

    /** Resolves once every queued job has finished (sent or dropped). */
    async idle() {
      while (jobs.size > 0) {
        await Promise.allSettled([...jobs]);
      }
    },

    /** Number of jobs still running (sending, or waiting to retry). */
    pending() {
      return jobs.size;
    },

    /** Stops accepting new messages. Jobs already queued still run. */
    close() {
      closed = true;
    },
  };
}

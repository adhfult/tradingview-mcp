import { withDeadline, timeoutError } from './deadline.mjs';
import { errorMessage, isConnectionError } from './errors.mjs';

export const DEFAULT_AUTH_COOLDOWN_MS = 60_000;

/**
 * Owns the one shared TradingViewClient (websocket connection).
 *
 * - The client is created lazily and reused.
 * - The library never reconnects, so a client that closed while idle is replaced,
 *   and a client that fails (connection error, auth error, closed under a call,
 *   a call that outlives its deadline, a timeout before it was ready) is dropped
 *   so the next call opens a new one.
 * - Creating a client with credentials costs an account lookup plus a websocket
 *   handshake. After an AUTH_ERROR with credentials, calls fail fast with the same
 *   error for `authCooldownMs`, without constructing a client.
 * - After `close()` no client is created any more.
 *
 * `now` is injectable for tests. `log(message)` receives plain messages; the
 * caller redacts.
 */
export function createClientManager({
  lib,
  credentials = null,
  now = Date.now,
  log = () => {},
  authCooldownMs = DEFAULT_AUTH_COOLDOWN_MS,
}) {
  let client = null;
  let shuttingDown = false;
  let authBlockedUntil = 0;
  let lastAuthError = null;

  const closeQuietly = async (target) => {
    try {
      await target.close();
    } catch (err) {
      log(`client close failed: ${errorMessage(err)}`);
    }
  };

  const get = () => {
    if (shuttingDown) {
      throw Object.assign(new Error('bridge is shutting down'), { code: 'DISCONNECTED' });
    }
    if (lastAuthError !== null) {
      if (now() < authBlockedUntil) {
        throw Object.assign(new Error(lastAuthError.message), { code: 'AUTH_ERROR', details: lastAuthError.details });
      }
      lastAuthError = null;
    }
    if (client !== null && client.isClosed === true) {
      const stale = client;
      client = null;
      void closeQuietly(stale);
    }
    if (client === null) {
      client = new lib.TradingViewClient(credentials ? { credentials } : {});
    }
    return client;
  };

  const drop = async (used) => {
    if (client === used) client = null;
    await closeQuietly(used);
  };

  const mustDrop = (err, used) =>
    isConnectionError(err?.code)
    || err?.code === 'AUTH_ERROR'
    || err?.deadline === true // the library ignored its own timeout: the connection is suspect
    || used.isClosed === true
    // timed out before the connection ever became ready: do not keep waiting on it
    || (err?.code === 'TIMEOUT' && used.isAuthenticated === false);

  /**
   * Runs `fn(client)` on the shared client, bounded by a hard deadline of
   * `timeoutMs + graceMs`. Failures drop the client as described above.
   */
  const call = async (timeoutMs, graceMs, fn) => {
    const used = get();
    try {
      const result = await withDeadline(() => fn(used), timeoutMs + graceMs, () => timeoutError(timeoutMs));
      lastAuthError = null;
      return result;
    } catch (err) {
      if (err?.code === 'AUTH_ERROR' && credentials !== null) {
        authBlockedUntil = now() + authCooldownMs;
        lastAuthError = { message: errorMessage(err), details: err.details };
      }
      if (mustDrop(err, used)) void drop(used);
      throw err;
    }
  };

  const close = async () => {
    shuttingDown = true;
    const current = client;
    client = null;
    if (current !== null) await closeQuietly(current);
  };

  return { get, drop, mustDrop, call, close };
}

/**
 * Runs `fn` and settles with its result, or rejects with `makeError()` once `ms`
 * milliseconds have passed. This is a backstop for library calls that fail to
 * honour their own timeout: the caller (and its semaphore slot) is released at
 * the deadline. A late result or rejection of `fn` is absorbed, so it can never
 * surface as an unhandled rejection.
 */
export function withDeadline(fn, ms, makeError) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };
    const timer = setTimeout(() => finish(reject, makeError()), ms);
    try {
      Promise.resolve(fn()).then((value) => finish(resolve, value), (err) => finish(reject, err));
    } catch (err) {
      finish(reject, err);
    }
  });
}

/** The error a call gets when the bridge's own timer or hard deadline fires. */
export function timeoutError(timeoutMs) {
  return Object.assign(new Error(`request timed out after ${timeoutMs} ms`), { code: 'TIMEOUT', deadline: true });
}

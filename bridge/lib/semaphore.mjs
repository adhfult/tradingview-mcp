/**
 * Limits how many async functions run at once. Waiting calls start in FIFO
 * order as slots free up. A rejected function releases its slot too.
 */
export function createSemaphore(max) {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError('semaphore max must be a positive integer');
  }

  let active = 0;
  const queue = [];

  const drain = () => {
    while (active < max && queue.length > 0) {
      const start = queue.shift();
      active += 1;
      start();
    }
  };

  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push(() => {
          Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              drain();
            });
        });
        drain();
      });
    },
  };
}

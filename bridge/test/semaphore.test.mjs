import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSemaphore } from '../lib/semaphore.mjs';

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('runs at most max functions at once and starts waiting ones FIFO', async () => {
  const sem = createSemaphore(2);
  const started = [];
  const gates = [];
  const task = (name) => sem.run(() => {
    started.push(name);
    return new Promise((resolve) => gates.push(() => resolve(name)));
  });

  const results = [task('a'), task('b'), task('c')];
  await flush();
  assert.deepEqual(started, ['a', 'b'], 'third call waits');

  gates[0]();
  await flush();
  assert.deepEqual(started, ['a', 'b', 'c'], 'third call starts when a slot frees');

  gates[1]();
  gates[2]();
  assert.deepEqual(await Promise.all(results), ['a', 'b', 'c']);
});

test('a rejected function still releases its slot', async () => {
  const sem = createSemaphore(1);
  await assert.rejects(sem.run(() => Promise.reject(new Error('boom'))), /boom/);
  assert.equal(await sem.run(() => 'next'), 'next');
});

test('a synchronous throw rejects the run promise and frees the slot', async () => {
  const sem = createSemaphore(1);
  await assert.rejects(sem.run(() => { throw new Error('sync'); }), /sync/);
  assert.equal(await sem.run(() => 7), 7);
});

test('rejects a max that is not a positive integer', () => {
  assert.throws(() => createSemaphore(0), RangeError);
  assert.throws(() => createSemaphore(1.5), RangeError);
  assert.throws(() => createSemaphore('2'), RangeError);
});

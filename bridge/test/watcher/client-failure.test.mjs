import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClientManager } from '../../lib/client.mjs';
import { createFakeClock, createFakeLib } from './support.mjs';

test('reportFailure on a connection error drops the client, so the next get builds a new one', () => {
  const clock = createFakeClock();
  const lib = createFakeLib();
  const clients = createClientManager({ lib, now: clock.now });
  const first = clients.get();
  clients.reportFailure(Object.assign(new Error('gone'), { code: 'CONNECTION_ERROR' }), first);
  assert.notEqual(clients.get(), first);
  assert.equal(lib.clients.length, 2);
});

test('reportFailure on a series error keeps the client', () => {
  const clock = createFakeClock();
  const lib = createFakeLib();
  const clients = createClientManager({ lib, now: clock.now });
  const first = clients.get();
  clients.reportFailure(Object.assign(new Error('no series'), { code: 'SERIES_ERROR' }), first);
  assert.equal(clients.get(), first);
  assert.equal(lib.clients.length, 1);
});

test('reportFailure on AUTH_ERROR with credentials blocks get() for the cool-down, then clears it', () => {
  const clock = createFakeClock();
  const lib = createFakeLib();
  const clients = createClientManager({
    lib, credentials: { session: 'abcd', signature: 'efgh' }, now: clock.now, authCooldownMs: 60_000,
  });
  const first = clients.get();
  clients.reportFailure(Object.assign(new Error('bad login'), { code: 'AUTH_ERROR' }), first);
  assert.throws(() => clients.get(), (err) => err.code === 'AUTH_ERROR');
  clock.advance(59_999);
  assert.throws(() => clients.get(), (err) => err.code === 'AUTH_ERROR');
  clock.advance(1);
  assert.notEqual(clients.get(), undefined);
  assert.equal(lib.clients.length, 2);
});

test('reportFailure on AUTH_ERROR without credentials does not start a cool-down', () => {
  const clock = createFakeClock();
  const lib = createFakeLib();
  const clients = createClientManager({ lib, now: clock.now });
  const first = clients.get();
  clients.reportFailure(Object.assign(new Error('x'), { code: 'AUTH_ERROR' }), first);
  assert.doesNotThrow(() => clients.get());
});

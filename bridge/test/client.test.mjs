import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClientManager } from '../lib/client.mjs';

function fakeLib() {
  const clients = [];
  class TradingViewClient {
    constructor(options) {
      this.options = options;
      this.closeCount = 0;
      clients.push(this);
    }

    async close() {
      this.closeCount += 1;
    }
  }
  return { lib: { TradingViewClient }, clients };
}

const err = (code, message = code) => Object.assign(new Error(message), { code });
const CREDS = { session: 'fake-session', signature: 'fake-sign' };

test('creates the client lazily, reuses it and passes credentials only when given', async () => {
  const a = fakeLib();
  const anon = createClientManager({ lib: a.lib });
  assert.equal(a.clients.length, 0);
  await anon.call(1000, 10, (c) => c);
  await anon.call(1000, 10, (c) => c);
  assert.equal(a.clients.length, 1);
  assert.deepEqual(a.clients[0].options, {});

  const b = fakeLib();
  await createClientManager({ lib: b.lib, credentials: CREDS }).call(1000, 10, () => 1);
  assert.deepEqual(b.clients[0].options, { credentials: CREDS });
});

test('replaces a client that closed while idle, and closes the stale one', async () => {
  const f = fakeLib();
  const m = createClientManager({ lib: f.lib });
  await m.call(1000, 10, () => 1);
  f.clients[0].isClosed = true;
  await m.call(1000, 10, () => 1);
  assert.equal(f.clients.length, 2);
  assert.equal(f.clients[0].closeCount, 1);
});

test('mustDrop covers connection errors, auth errors, deadline errors, closed and unready clients', () => {
  const m = createClientManager({ lib: fakeLib().lib });
  const ok = { isClosed: false, isAuthenticated: true };
  for (const code of ['CONNECTION_ERROR', 'DISCONNECTED', 'PROTOCOL_ERROR', 'AUTH_ERROR']) {
    assert.equal(m.mustDrop(err(code), ok), true, code);
  }
  assert.equal(m.mustDrop(Object.assign(err('TIMEOUT'), { deadline: true }), ok), true);
  assert.equal(m.mustDrop(err('SYMBOL_ERROR'), { isClosed: true }), true);
  assert.equal(m.mustDrop(err('TIMEOUT'), { isAuthenticated: false }), true);
  assert.equal(m.mustDrop(err('TIMEOUT'), ok), false);
  assert.equal(m.mustDrop(err('SYMBOL_ERROR'), ok), false);
  assert.equal(m.mustDrop(err('TIMEOUT'), {}), false, 'unknown readiness is not treated as unready');
});

test('a failing call drops its client, the next call builds a new one', async () => {
  const f = fakeLib();
  const m = createClientManager({ lib: f.lib });
  await assert.rejects(m.call(1000, 10, () => { throw err('DISCONNECTED'); }), { code: 'DISCONNECTED' });
  await m.call(1000, 10, () => 1);
  assert.equal(f.clients.length, 2);
  assert.equal(f.clients[0].closeCount, 1);
});

test('the deadline rejects a hung call with TIMEOUT and drops the client', async () => {
  const f = fakeLib();
  const m = createClientManager({ lib: f.lib });
  await assert.rejects(m.call(5, 20, () => new Promise(() => {})), { code: 'TIMEOUT', deadline: true });
  assert.equal(f.clients[0].closeCount, 1);
});

test('auth cooldown: fails fast without a client, then recovers after the cooldown', async () => {
  const f = fakeLib();
  let clock = 0;
  const m = createClientManager({ lib: f.lib, credentials: CREDS, now: () => clock, authCooldownMs: 60_000 });
  await assert.rejects(m.call(1000, 10, () => { throw err('AUTH_ERROR', 'bad cookies'); }), { code: 'AUTH_ERROR' });
  assert.equal(f.clients.length, 1);

  clock = 59_999;
  await assert.rejects(m.call(1000, 10, () => 'never'), { code: 'AUTH_ERROR', message: 'bad cookies' });
  assert.equal(f.clients.length, 1);

  clock = 60_000;
  assert.equal(await m.call(1000, 10, () => 'ok'), 'ok');
  assert.equal(f.clients.length, 2);
});

test('auth cooldown restarts on a new AUTH_ERROR and is skipped for anonymous clients', async () => {
  const f = fakeLib();
  let clock = 0;
  const m = createClientManager({ lib: f.lib, credentials: CREDS, now: () => clock });
  await assert.rejects(m.call(1000, 10, () => { throw err('AUTH_ERROR'); }));
  clock = 60_000;
  await assert.rejects(m.call(1000, 10, () => { throw err('AUTH_ERROR'); }));
  clock = 119_999;
  await assert.rejects(m.call(1000, 10, () => 'x'), { code: 'AUTH_ERROR' });
  assert.equal(f.clients.length, 2);

  const g = fakeLib();
  const anon = createClientManager({ lib: g.lib, now: () => clock });
  await assert.rejects(anon.call(1000, 10, () => { throw err('AUTH_ERROR'); }));
  await anon.call(1000, 10, () => 1);
  assert.equal(g.clients.length, 2, 'no cooldown without credentials');
});

test('close() closes the client once, then refuses new work without building a client', async () => {
  const f = fakeLib();
  const logs = [];
  const m = createClientManager({ lib: f.lib, log: (s) => logs.push(s) });
  await m.call(1000, 10, () => 1);
  await m.close();
  await m.close();
  assert.equal(f.clients[0].closeCount, 1);
  await assert.rejects(m.call(1000, 10, () => 1), { code: 'DISCONNECTED', message: 'bridge is shutting down' });
  assert.equal(f.clients.length, 1);

  const g = fakeLib();
  const n = createClientManager({ lib: g.lib, log: (s) => logs.push(s) });
  await n.call(1000, 10, () => 1);
  g.clients[0].close = async () => { throw new Error('close boom'); };
  await n.close();
  assert.ok(logs.some((l) => l.includes('close boom')));
});

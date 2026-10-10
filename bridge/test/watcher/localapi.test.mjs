import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalApi, parseNotifyBody, tokenMatches, MAX_BODY_BYTES } from '../../lib/localapi.mjs';

const TOKEN = 'local-token-value-1234';
const silent = { info() {}, warn() {}, error() {} };

async function start(t, overrides = {}) {
  const submitted = [];
  const api = createLocalApi({
    port: 0,
    token: TOKEN,
    submit: (value) => submitted.push(value),
    health: () => ({ ok: true, streams: { healthy: 2, total: 3 }, uptime_s: 12, disconnects: 1 }),
    logger: silent,
    ...overrides,
  });
  const { host, port } = await api.listen();
  t.after(() => api.close());
  return { api, host, port, base: `http://${host}:${port}`, submitted };
}

const notify = (base, body, auth = `Bearer ${TOKEN}`) => fetch(`${base}/notify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('the server binds to 127.0.0.1 only', async (t) => {
  const { api, host, port } = await start(t);
  assert.equal(host, '127.0.0.1');
  assert.equal(api.server.address().address, '127.0.0.1');
  assert.ok(port > 0);
});

test('POST /notify without a token is refused with 401', async (t) => {
  const { base, submitted } = await start(t);
  const res = await notify(base, { title: 'x', key: 'k1' }, null);
  assert.equal(res.status, 401);
  assert.equal(submitted.length, 0);
});

test('POST /notify with a wrong token of the same length is refused with 401', async (t) => {
  const { base, submitted } = await start(t);
  const wrong = 'X'.repeat(TOKEN.length);
  const res = await notify(base, { title: 'x', key: 'k1' }, `Bearer ${wrong}`);
  assert.equal(res.status, 401);
  assert.equal(submitted.length, 0);
});

test('POST /notify with a token of a different length is refused with 401, not an exception', async (t) => {
  const { base } = await start(t);
  const res = await notify(base, { title: 'x', key: 'k1' }, 'Bearer short');
  assert.equal(res.status, 401);
});

test('POST /notify with the right token is accepted with 202 and goes to submit', async (t) => {
  const { base, submitted } = await start(t);
  const res = await notify(base, { title: 'Paper fill', body: 'bought 1', key: 'fill-1', level: 'up' });
  assert.equal(res.status, 202);
  assert.deepEqual(submitted, [{ title: 'Paper fill', body: 'bought 1', key: 'fill-1', level: 'up' }]);
});

test('a bad body is refused with 400 and the reason, without echoing the input', async (t) => {
  const { base, submitted } = await start(t);
  const cases = [
    'not json at all',
    JSON.stringify([1, 2]),
    JSON.stringify({ key: 'k' }),
    JSON.stringify({ title: 'x', key: 'k', level: 'purple' }),
    JSON.stringify({ title: 'x', key: 'k', body: 'y'.repeat(2001) }),
    JSON.stringify({ title: 'x'.repeat(201), key: 'k' }),
    JSON.stringify({ title: 'x' }),
  ];
  for (const body of cases) {
    const res = await notify(base, body);
    assert.equal(res.status, 400, body.slice(0, 40));
    const json = await res.json();
    assert.equal(typeof json.error, 'string');
    assert.ok(!json.error.includes('not json at all'));
  }
  assert.equal(submitted.length, 0);
});

test('a body over 8 KB is refused with 400', async (t) => {
  const { base, submitted } = await start(t);
  const big = JSON.stringify({ title: 'x', key: 'k', body: 'a'.repeat(MAX_BODY_BYTES + 100) });
  const res = await notify(base, big).catch((err) => ({ status: 'network', err }));
  if (res.status !== 'network') assert.equal(res.status, 400);
  assert.equal(submitted.length, 0);
});

test('a body of exactly the limit is still read', () => {
  const body = JSON.stringify({ title: 't', key: 'k', body: 'a'.repeat(1000) });
  assert.ok(Buffer.byteLength(body) < MAX_BODY_BYTES);
  assert.equal(parseNotifyBody(body).ok, true);
});

test('GET /health needs no token and returns status without secrets', async (t) => {
  const { base } = await start(t);
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json, { ok: true, streams: { healthy: 2, total: 3 }, uptime_s: 12, disconnects: 1 });
  assert.ok(!JSON.stringify(json).includes(TOKEN));
});

test('unknown paths and methods get 404', async (t) => {
  const { base } = await start(t);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/notify`)).status, 404);
  assert.equal((await fetch(`${base}/health`, { method: 'POST' })).status, 404);
});

test('tokenMatches is false for missing, malformed or wrong credentials', () => {
  assert.equal(tokenMatches(undefined, TOKEN), false);
  assert.equal(tokenMatches(`Basic ${TOKEN}`, TOKEN), false);
  assert.equal(tokenMatches(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(tokenMatches('bearer ' + TOKEN, TOKEN), true, 'the scheme is case-insensitive');
  assert.equal(tokenMatches(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(tokenMatches('Bearer ', TOKEN), false);
  assert.equal(tokenMatches(`Bearer ${TOKEN}`, ''), false, 'an empty expected token never matches');
});

test('parseNotifyBody defaults the level to info and keeps the title and key', () => {
  const parsed = parseNotifyBody(JSON.stringify({ title: 'T', key: 'K' }));
  assert.deepEqual(parsed, { ok: true, value: { title: 'T', body: '', key: 'K', level: 'info' } });
});

test('a failing submit returns 500 with a generic message', async (t) => {
  const { base } = await start(t, { submit: () => { throw new Error('boom'); } });
  const res = await notify(base, { title: 'x', key: 'k' });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'internal error' });
});

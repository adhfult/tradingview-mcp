import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreams, RESTART_BACKOFF_MS, BACKOFF_RESET_MS, AUTH_BACKOFF_MS } from '../../lib/stream.mjs';
import { createClientManager } from '../../lib/client.mjs';
import { createFakeClock, createFakeLib, settle, snapshot } from './support.mjs';

const KEY = 'BINANCE:BTCUSDT|60';
const STREAM = { key: KEY, symbol: 'BINANCE:BTCUSDT', timeframe: '60', market: 'crypto' };

function logger() {
  const lines = [];
  const record = (level) => (message) => lines.push(`${level} ${message}`);
  return { lines, info: record('info'), warn: record('warn'), error: record('error') };
}

/** Builds the streams under test with a fake library, clock and evaluated-state map. */
function setup({ credentials = null, random = () => 0, onClosedBar = () => {}, evaluatedInit = {} } = {}) {
  const clock = createFakeClock();
  const lib = createFakeLib();
  const log = logger();
  const clients = createClientManager({ lib, credentials, now: clock.now, log: (m) => log.info(m) });
  const evaluatedMap = { ...evaluatedInit };
  const evaluated = {
    get: (key) => evaluatedMap[key],
    set: (key, t) => { evaluatedMap[key] = t; },
  };
  const evaluations = [];
  const streams = createStreams({
    streams: [STREAM],
    lib,
    clients,
    clock,
    logger: log,
    evaluated,
    random,
    onClosedBar: (s, closed, closeTime) => {
      evaluations.push({ barTime: closed.at(-1).time, length: closed.length, closeTime });
      onClosedBar(s, closed, closeTime);
    },
  });
  return { clock, lib, clients, log, evaluatedMap, evaluations, streams };
}

test('the first snapshot after start evaluates nothing, it only records the forming bar', async () => {
  const { lib, streams, evaluations } = setup();
  streams.start();
  await settle();
  lib.watchers[0].feed(snapshot([10, 11, 12, 13]));
  assert.deepEqual(evaluations, []);
});

test('when a new bar starts, the bar that was forming closes and is evaluated once', async () => {
  const { lib, streams, evaluations } = setup();
  streams.start();
  await settle();
  const w = lib.watchers[0];
  w.feed(snapshot([10, 11, 12]));                 // forming bar: time T+2
  w.feed(snapshot([10, 11, 12, 13]));             // T+2 closed, T+3 forming
  w.feed(snapshot([10, 11, 12, 13.5]));           // the forming bar moved; nothing closed
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].barTime, 1_700_000_000 + 2 * 3600);
  assert.equal(evaluations[0].length, 3, 'candles stop at the closed bar; the forming bar is excluded');
  assert.equal(evaluations[0].closeTime, 1_700_000_000 + 3 * 3600);
});

test('updates within the same forming bar do not evaluate anything', async () => {
  const { lib, streams, evaluations } = setup();
  streams.start();
  await settle();
  const w = lib.watchers[0];
  for (let i = 0; i < 5; i += 1) {
    w.feed(snapshot([10, 11, 12, 12 + i]));
  }
  assert.deepEqual(evaluations, []);
});

test('a bar is never evaluated twice, even when the snapshot is repeated', async () => {
  const { lib, streams, evaluations } = setup();
  streams.start();
  await settle();
  const w = lib.watchers[0];
  w.feed(snapshot([10, 11]));
  w.feed(snapshot([10, 11, 12]));
  w.feed(snapshot([10, 11, 12]));
  w.feed(snapshot([10, 11, 12, 13]));
  assert.deepEqual(evaluations.map((e) => e.barTime), [1_700_000_000 + 3600, 1_700_000_000 + 2 * 3600]);
});

test('a gap of several new bars evaluates each closed bar once, oldest first', async () => {
  const { lib, streams, evaluations } = setup();
  streams.start();
  await settle();
  const w = lib.watchers[0];
  w.feed(snapshot([10]));
  w.feed(snapshot([10, 11, 12, 13]));
  assert.deepEqual(evaluations.map((e) => e.barTime), [
    1_700_000_000, 1_700_000_000 + 3600, 1_700_000_000 + 7200,
  ]);
  assert.deepEqual(evaluations.map((e) => e.length), [1, 2, 3]);
});

test('replay after a restart does not evaluate bars that were already evaluated', async () => {
  // State says bar +2 was evaluated before the restart.
  const { lib, streams, evaluations } = setup({ evaluatedInit: { [KEY]: 1_700_000_000 + 2 * 3600 } });
  streams.start();
  await settle();
  const w = lib.watchers[0];
  w.feed(snapshot([10, 11, 12]));                 // first snapshot after start: record only
  w.feed(snapshot([10, 11, 12, 13]));             // +2 closes, but it was already evaluated
  assert.deepEqual(evaluations, []);
  w.feed(snapshot([10, 11, 12, 13, 14]));         // +3 closes: new, so evaluated
  assert.deepEqual(evaluations.map((e) => e.barTime), [1_700_000_000 + 3 * 3600]);
});

test('a restart does not replay bars that closed while the watcher was down', async () => {
  const { lib, streams, evaluations, clock } = setup({ evaluatedInit: { [KEY]: 1_700_000_000 } });
  streams.start();
  await settle();
  lib.watchers[0].fail('CONNECTION_ERROR');
  clock.advance(5000);
  await settle();
  const w = lib.watchers[1];
  w.feed(snapshot([10, 11, 12, 13, 14, 15]));     // several bars closed during the outage
  assert.deepEqual(evaluations, [], 'first snapshot after restart evaluates nothing');
});

test('the restart backoff is 5s, 10s, 30s, then 60s capped (no jitter)', async () => {
  const { lib, streams, clock } = setup({ random: () => 0 });
  streams.start();
  await settle();
  const expected = [5000, 10000, 30000, 60000, 60000];
  for (let i = 0; i < expected.length; i += 1) {
    const before = lib.watchers.length;
    lib.watchers.at(-1).fail('OTHER_ERROR');
    await settle();
    clock.advance(expected[i] - 1);
    await settle();
    assert.equal(lib.watchers.length, before, `attempt ${i + 1} must wait ${expected[i]} ms`);
    clock.advance(1);
    await settle();
    assert.equal(lib.watchers.length, before + 1, `attempt ${i + 1} restarts at ${expected[i]} ms`);
  }
  assert.deepEqual(RESTART_BACKOFF_MS, [5000, 10000, 30000, 60000]);
});

test('jitter adds 0 to 30% to each backoff, so streams do not reconnect together', async () => {
  const { lib, streams, clock } = setup({ random: () => 1 });
  streams.start();
  await settle();
  lib.watchers[0].fail('CONNECTION_ERROR');
  await settle();
  clock.advance(6499);
  await settle();
  assert.equal(lib.watchers.length, 1);
  clock.advance(1);
  await settle();
  assert.equal(lib.watchers.length, 2, 'base 5000 with +30% is 6500');
});

test('the backoff goes back to the start after 10 minutes of healthy data', async () => {
  const { lib, streams, clock } = setup({ random: () => 0 });
  streams.start();
  await settle();
  // fail twice to climb the schedule
  lib.watchers[0].fail('OTHER_ERROR');
  clock.advance(5000);
  await settle();
  lib.watchers[1].fail('OTHER_ERROR');
  clock.advance(10000);
  await settle();
  // now healthy for longer than the reset window
  lib.watchers[2].feed(snapshot([10]));
  clock.advance(BACKOFF_RESET_MS + 1000);
  lib.watchers[2].feed(snapshot([10, 11]));
  lib.watchers[2].fail('OTHER_ERROR');
  await settle();
  const before = lib.watchers.length;
  clock.advance(4999);
  await settle();
  assert.equal(lib.watchers.length, before);
  clock.advance(1);
  await settle();
  assert.equal(lib.watchers.length, before + 1, 'restart is back to 5 s');
});

test('a connection error drops the shared client, and the next start opens a new one', async () => {
  const { lib, streams, clock, clients } = setup();
  streams.start();
  await settle();
  const first = lib.clients[0];
  lib.watchers[0].fail('CONNECTION_ERROR');
  await settle();
  clock.advance(5000);
  await settle();
  assert.equal(lib.clients.length, 2, 'a second shared client was constructed');
  assert.equal(lib.watchers[1].query.client, lib.clients[1]);
  assert.notEqual(lib.watchers[1].query.client, first);
  assert.equal(first.closeCalls, 1, 'the dead client was closed');
  assert.ok(clients.get());
});

test('an error that is not a connection error keeps the shared client', async () => {
  const { lib, streams, clock } = setup();
  streams.start();
  await settle();
  lib.watchers[0].fail('OTHER_ERROR');
  await settle();
  clock.advance(5000);
  await settle();
  assert.equal(lib.clients.length, 1, 'no new client for a series error');
  assert.equal(lib.watchers[1].query.client, lib.clients[0]);
});

test('an auth error starts the auth cool-down: no new client is opened until it ends', async () => {
  const { lib, streams, clock } = setup({ credentials: { session: 's1234', signature: 'sig5678' } });
  streams.start();
  await settle();
  const failedAt = clock.now();
  lib.watchers[0].fail('AUTH_ERROR', 'bad cookie');
  await settle();
  let createdAt = null;
  for (let i = 0; i < 400 && createdAt === null; i += 1) {
    clock.advance(1000);
    await settle();
    if (lib.clients.length === 2) createdAt = clock.now();
  }
  assert.notEqual(createdAt, null, 'a new client is eventually created');
  assert.ok(createdAt - failedAt >= 60_000, `created ${createdAt - failedAt} ms after the auth error`);
  assert.equal(lib.watchers.length, 2);
});

test('a watcher that closes on its own is restarted, and counted as a disconnect', async () => {
  const { lib, streams, clock } = setup();
  streams.start();
  await settle();
  lib.watchers[0].closeQuietly();
  await settle();
  clock.advance(5000);
  await settle();
  assert.equal(lib.watchers.length, 2);
  assert.equal(streams.list()[0].disconnects, 1);
});

test('a failed start (watchCandles rejects) is retried with backoff', async () => {
  const { lib, streams, clock, log } = setup();
  lib.failNextWatch(Object.assign(new Error('flaky'), { code: 'WS_FLAKY' }));
  streams.start();
  await settle();
  assert.equal(lib.watchers.length, 0);
  assert.ok(log.lines.some((line) => line.includes('disconnected at') && line.includes('WS_FLAKY')));
  clock.advance(5000);
  await settle();
  assert.equal(lib.watchers.length, 1);
});

test('one shared connection drop that fails several streams counts once as a connection drop', async () => {
  const clock = createFakeClock();
  const lib = createFakeLib();
  const log = logger();
  const clients = createClientManager({ lib, now: clock.now, log: (m) => log.info(m) });
  const evaluatedMap = {};
  const streams = createStreams({
    streams: [
      { key: 'A|1', symbol: 'A', timeframe: '1', market: 'crypto' },
      { key: 'B|1', symbol: 'B', timeframe: '1', market: 'crypto' },
      { key: 'C|1', symbol: 'C', timeframe: '1', market: 'crypto' },
    ],
    lib,
    clients,
    clock,
    logger: log,
    evaluated: { get: (k) => evaluatedMap[k], set: (k, t) => { evaluatedMap[k] = t; } },
    onClosedBar: () => {},
    random: () => 0,
  });
  streams.start();
  await settle();
  // the library reports the same dead connection on all three watchers
  for (const w of lib.watchers) w.fail('CONNECTION_ERROR');
  await settle();
  assert.deepEqual(streams.counters(), { disconnects: 3, connection_drops: 1 });
  assert.ok(log.lines.some((line) => line.includes('shared connection lost at')));
});

test('a disconnect is logged with its time, and the counters record it', async () => {
  const { lib, streams, log, clock } = setup();
  streams.start();
  await settle();
  lib.watchers[0].fail('CONNECTION_ERROR');
  const expected = new Date(clock.now()).toISOString();
  assert.ok(log.lines.some((line) => line.includes(`disconnected at ${expected} (CONNECTION_ERROR)`)));
  assert.equal(streams.counters().disconnects, 1);
});

test('stop() cancels pending restarts and stops every watcher', async () => {
  const { lib, streams, clock } = setup();
  streams.start();
  await settle();
  lib.watchers[0].fail('OTHER_ERROR');
  await settle();
  await streams.stop();
  clock.advance(120_000);
  await settle();
  assert.equal(lib.watchers.length, 1, 'no restart after stop');
  assert.equal(streams.list()[0].status, 'stopped');
});

test('stop() during a slow start stops the watcher as soon as it arrives', async () => {
  const { lib, streams } = setup();
  streams.start();
  await streams.stop();
  await settle();
  assert.equal(lib.watchers.length, 1, 'the start had already reached the library');
  assert.equal(lib.watchers[0].stopCalls, 1, 'and it was stopped on arrival');
  assert.equal(streams.list()[0].status, 'stopped');
});

test('healthy streams are counted once they receive data', async () => {
  const { lib, streams } = setup();
  assert.equal(streams.healthyCount(), 0);
  streams.start();
  await settle();
  lib.watchers[0].feed(snapshot([10]));
  assert.equal(streams.healthyCount(), 1);
  assert.equal(streams.total, 1);
});

test('an exception in a rule evaluation is logged, and the stream keeps going', async () => {
  const { lib, streams, log } = setup({
    onClosedBar: () => { throw new Error('rule exploded'); },
  });
  streams.start();
  await settle();
  const w = lib.watchers[0];
  w.feed(snapshot([10]));
  w.feed(snapshot([10, 11]));
  assert.ok(log.lines.some((line) => line.includes('rule evaluation failed') && line.includes('rule exploded')));
  w.feed(snapshot([10, 11, 12]));
  assert.equal(streams.list()[0].status, 'healthy');
});


// --- review additions: catch-up, ordering, auth backoff ---

const HOUR_S = 3600;

/** A snapshot whose forming (last) bar opened `formingAgoSec` before the fake clock's now. */
function recentSnapshot(clock, closes, formingAgoSec = 600) {
  const forming = Math.floor(clock.now() / 1000) - formingAgoSec;
  return snapshot(closes, { startTime: forming - (closes.length - 1) * HOUR_S, step: HOUR_S });
}

test('catch-up: recent bars that closed while the stream was reconnecting are evaluated once', async () => {
  const { lib, streams, evaluations, clock, evaluatedMap } = setup();
  const nowSec = Math.floor(clock.now() / 1000);
  const base = nowSec - 600 - 3 * HOUR_S; // oldest bar of a 4-bar snapshot
  evaluatedMap[KEY] = base;               // state: the oldest bar was already evaluated
  streams.start();
  await settle();
  const w = lib.watchers[0];
  w.feed(recentSnapshot(clock, [10, 11, 12, 13]));
  assert.deepEqual(evaluations.map((e) => e.barTime), [base + HOUR_S, base + 2 * HOUR_S], 'the two bars after the persisted one');
  assert.deepEqual(evaluations.map((e) => e.length), [2, 3]);
  w.feed(recentSnapshot(clock, [10, 11, 12, 13.5]));
  assert.equal(evaluations.length, 2, 'a repeated snapshot adds nothing');
  assert.equal(evaluatedMap[KEY], base + 2 * HOUR_S);
});

test('catch-up: bars that closed longer ago than two bar lengths are never replayed', async () => {
  const { lib, streams, evaluations, clock, evaluatedMap } = setup();
  const nowSec = Math.floor(clock.now() / 1000);
  evaluatedMap[KEY] = nowSec - 20 * HOUR_S;
  streams.start();
  await settle();
  // the forming bar opened 5 hours ago: the last closed bar closed 5 hours ago, beyond 2 x 1h
  lib.watchers[0].feed(recentSnapshot(clock, [10, 11, 12, 13], 5 * HOUR_S));
  assert.deepEqual(evaluations, []);
});

test('catch-up never evaluates the forming bar, and a stream with no persisted bar evaluates nothing', async () => {
  const fresh = setup();
  fresh.streams.start();
  await settle();
  fresh.lib.watchers[0].feed(recentSnapshot(fresh.clock, [10, 11, 12, 13]));
  assert.deepEqual(fresh.evaluations, [], 'no persisted lastEvaluatedTime: nothing to catch up');

  const { lib, streams, evaluations, clock, evaluatedMap } = setup();
  const snap = recentSnapshot(clock, [10, 11, 12, 13]);
  evaluatedMap[KEY] = snap[2].time; // everything but the forming bar is already done
  streams.start();
  await settle();
  lib.watchers[0].feed(snap);
  assert.deepEqual(evaluations, []);
});

test('a bar evaluated before an in-process restart is not evaluated again after it', async () => {
  const { lib, streams, evaluations, clock } = setup();
  const t0 = Math.floor(clock.now() / 1000) - 3 * HOUR_S - 600; // bars t0, t0+1h, t0+2h, t0+3h (now is 10 min into the last)
  const snap = (closes) => snapshot(closes, { startTime: t0, step: HOUR_S });
  streams.start();
  await settle();
  lib.watchers[0].feed(snap([10, 11]));
  lib.watchers[0].feed(snap([10, 11, 12]));            // bar t0+1h closes: evaluated
  assert.equal(evaluations.length, 1);
  lib.watchers[0].fail('CONNECTION_ERROR');
  clock.advance(5000);
  await settle();
  lib.watchers[1].feed(snap([10, 11, 12]));            // replay after reconnect: same closed bar, same forming bar
  assert.equal(evaluations.length, 1, 'the replayed closed bar is skipped, even with catch-up on');
  lib.watchers[1].feed(snap([10, 11, 12, 13]));        // t0+2h closes
  assert.equal(evaluations.length, 2, 'the next close is evaluated exactly once');
  assert.equal(evaluations[1].barTime, t0 + 2 * HOUR_S);
});

test('an out-of-order (older) snapshot is ignored and does not move the forming bar back', async () => {
  const { lib, streams, evaluations } = setup();
  streams.start();
  await settle();
  const w = lib.watchers[0];
  w.feed(snapshot([10, 11, 12, 13]));          // forming = +3
  w.feed(snapshot([10, 11, 12]));              // stale snapshot, forming would be +2
  assert.deepEqual(evaluations, []);
  w.feed(snapshot([10, 11, 12, 13, 14]));      // +3 closes now
  assert.deepEqual(evaluations.map((e) => e.barTime), [1_700_000_000 + 3 * 3600], 'only +3, once');
});

test('AUTH_ERROR backs off for 5, then 15 minutes instead of retrying every minute', async () => {
  const { lib, streams, clock } = setup({ random: () => 0, credentials: { session: 's1234', signature: 'sig5678' } });
  streams.start();
  await settle();
  lib.watchers[0].fail('AUTH_ERROR', 'bad cookie');
  await settle();
  clock.advance(AUTH_BACKOFF_MS[0] - 1000);
  await settle();
  assert.equal(lib.clients.length, 1, 'no new connection attempt inside 5 minutes');
  clock.advance(1000);
  await settle();
  assert.equal(lib.clients.length, 2, 'one attempt after 5 minutes');
  // the second attempt fails the same way: next wait is 15 minutes
  lib.watchers.at(-1)?.fail('AUTH_ERROR', 'bad cookie');
  await settle();
  const watchersBefore = lib.watchers.length;
  clock.advance(AUTH_BACKOFF_MS[1] - 1000);
  await settle();
  assert.equal(lib.watchers.length, watchersBefore, 'still waiting at 15 minutes minus 1 s');
  assert.deepEqual([...AUTH_BACKOFF_MS], [300_000, 900_000, 1_800_000, 3_600_000]);
});

test('data resets the auth escalation, so a later one-off auth error waits only 5 minutes', async () => {
  const { lib, streams, clock } = setup({ random: () => 0, credentials: { session: 's1234', signature: 'sig5678' } });
  streams.start();
  await settle();
  lib.watchers[0].fail('AUTH_ERROR', 'x');
  clock.advance(AUTH_BACKOFF_MS[0]);
  await settle();
  lib.watchers.at(-1).feed(snapshot([10]));
  lib.watchers.at(-1).fail('AUTH_ERROR', 'x');
  await settle();
  const before = lib.watchers.length;
  clock.advance(AUTH_BACKOFF_MS[0]);
  await settle();
  assert.ok(lib.watchers.length > before, 'back to the 5 minute step');
});

test('many streams that fail together restart spread over the jitter window, on one new client', async () => {
  const clock = createFakeClock();
  const lib = createFakeLib();
  const log = logger();
  const clients = createClientManager({ lib, now: clock.now, log: (m) => log.info(m) });
  let n = 0;
  const randoms = [0, 0.25, 0.5, 0.75, 1];
  const list = Array.from({ length: 5 }, (_, i) => ({ key: `S${i}|1`, symbol: `S${i}`, timeframe: '1', market: 'crypto' }));
  const streams = createStreams({
    streams: list, lib, clients, clock, logger: log,
    evaluated: { get: () => undefined, set: () => {} },
    onClosedBar: () => {},
    random: () => randoms[n++ % randoms.length],
  });
  streams.start();
  await settle();
  for (const w of [...lib.watchers]) w.fail('CONNECTION_ERROR');
  await settle();
  const started = [];
  for (let ms = 0; ms <= 6500; ms += 250) {
    clock.advance(250);
    await settle();
    started.push(lib.watchers.length);
  }
  assert.equal(lib.clients.length, 2, 'one replacement client for all streams');
  const firstRestart = started.findIndex((count) => count > 5);
  const lastRestart = started.findIndex((count) => count === 10);
  assert.ok(lastRestart > firstRestart, 'restarts are spread out, not simultaneous');
});

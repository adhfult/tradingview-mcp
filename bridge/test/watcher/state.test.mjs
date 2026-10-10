import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore, emptyState, prune, STATE_FILE } from '../../lib/state.mjs';
import { createFakeClock } from './support.mjs';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'watcher-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('touch then flush writes state.json, and a new store reloads the same content', async (t) => {
  const dir = await tempDir(t);
  const clock = createFakeClock();
  const store = createStateStore({ dir, clock });
  await store.load();
  store.state.streams['BINANCE:BTCUSDT|60'] = { lastEvaluatedTime: 1700000000 };
  store.state.heartbeatDate = '2026-10-10';
  store.touch();
  await store.flush();

  const text = await readFile(join(dir, STATE_FILE), 'utf8');
  assert.equal(JSON.parse(text).streams['BINANCE:BTCUSDT|60'].lastEvaluatedTime, 1700000000);

  const reloaded = createStateStore({ dir, clock });
  await reloaded.load();
  assert.deepEqual(reloaded.state.streams, store.state.streams);
  assert.equal(reloaded.state.heartbeatDate, '2026-10-10');
});

test('the write leaves no temp files behind and the file is private (0600)', async (t) => {
  const dir = await tempDir(t);
  const store = createStateStore({ dir, clock: createFakeClock() });
  await store.load();
  store.touch();
  await store.flush();
  const names = await readdir(dir);
  assert.deepEqual(names.filter((n) => n.includes('.tmp-')), []);
  assert.deepEqual(names, [STATE_FILE]);
  const info = await stat(join(dir, STATE_FILE));
  assert.equal(info.mode & 0o777, 0o600);
});

test('the atomic write syncs the temp file before renaming it into place', async (t) => {
  const dir = await tempDir(t);
  const order = [];
  const fsp = {
    mkdir: async (...args) => { order.push('mkdir'); return (await import('node:fs/promises')).mkdir(...args); },
    readFile: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); },
    open: async (path, flags, mode) => {
      const real = await (await import('node:fs/promises')).open(path, flags, mode);
      return {
        writeFile: (...args) => { order.push('write'); return real.writeFile(...args); },
        sync: () => { order.push('fsync'); return real.sync(); },
        close: () => real.close(),
      };
    },
    rename: async (from, to) => { order.push('rename'); return (await import('node:fs/promises')).rename(from, to); },
    rm: (...args) => import('node:fs/promises').then((m) => m.rm(...args)),
  };
  const store = createStateStore({ dir, clock: createFakeClock(), fsp });
  await store.load();
  store.touch();
  await store.flush();
  assert.deepEqual(order, ['mkdir', 'write', 'fsync', 'rename', 'fsync'], 'temp file synced, renamed, then the directory synced');
});

test('touch debounces: writes happen once, 5 seconds after the first change', async (t) => {
  const dir = await tempDir(t);
  const clock = createFakeClock();
  const store = createStateStore({ dir, clock, debounceMs: 5000 });
  await store.load();
  store.state.heartbeatDate = 'a';
  store.touch();
  store.state.heartbeatDate = 'b';
  store.touch();
  store.touch();
  assert.equal(clock.pending(), 1, 'one timer for many changes');
  clock.advance(4999);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(stat(join(dir, STATE_FILE)));
  clock.advance(1);
  await store.flush();
  const saved = JSON.parse(await readFile(join(dir, STATE_FILE), 'utf8'));
  assert.equal(saved.heartbeatDate, 'b');
});

test('a corrupt state file is moved aside and the watcher starts empty, with a log line', async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, STATE_FILE), '{"streams": not json');
  const logs = [];
  const clock = createFakeClock(1_700_000_000_000);
  const store = createStateStore({ dir, clock, log: (line) => logs.push(line) });
  const state = await store.load();
  assert.deepEqual(state, emptyState());
  const names = await readdir(dir);
  assert.ok(names.includes(`${STATE_FILE}.corrupt-1700000000000`), names.join(','));
  assert.ok(logs.some((line) => line.includes('state file was corrupt')));
});

test('a file with a non-object top level is treated as corrupt', async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, STATE_FILE), '[1,2,3]');
  const store = createStateStore({ dir, clock: createFakeClock(), log: () => {} });
  assert.deepEqual(await store.load(), emptyState());
});

test('missing state loads as empty without a warning', async (t) => {
  const dir = await tempDir(t);
  const logs = [];
  const store = createStateStore({ dir, clock: createFakeClock(), log: (line) => logs.push(line) });
  assert.deepEqual(await store.load(), emptyState());
  assert.deepEqual(logs, []);
});

test('a failed write keeps the change pending and the next flush writes it', async (t) => {
  const dir = await tempDir(t);
  let failRename = true;
  const real = await import('node:fs/promises');
  const fsp = {
    ...real,
    readFile: real.readFile,
    open: real.open,
    mkdir: real.mkdir,
    rm: real.rm,
    rename: async (from, to) => {
      if (failRename) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return real.rename(from, to);
    },
  };
  const store = createStateStore({ dir, clock: createFakeClock(), fsp });
  await store.load();
  store.state.heartbeatDate = 'kept';
  store.touch();
  await assert.rejects(store.flush(), /disk full/);
  const left = await readdir(dir);
  assert.deepEqual(left.filter((n) => n.includes('.tmp-')), [], 'temp file removed after failure');

  failRename = false;
  await store.flush();
  const saved = JSON.parse(await readFile(join(dir, STATE_FILE), 'utf8'));
  assert.equal(saved.heartbeatDate, 'kept');
});

test('persist: false keeps everything in memory and never creates the directory', async (t) => {
  const dir = join(await tempDir(t), 'never-created');
  const store = createStateStore({ dir, clock: createFakeClock(), persist: false });
  await store.load();
  store.state.heartbeatDate = 'memory only';
  store.touch();
  await store.flush();
  await assert.rejects(stat(dir));
  assert.equal(store.state.heartbeatDate, 'memory only');
});

test('prune drops seen keys older than 24 hours and sends older than an hour', () => {
  const now = 10_000_000_000;
  const state = emptyState();
  state.seen = { old: now - 25 * 3600_000, fresh: now - 1000 };
  state.sends = [now - 2 * 3600_000, now - 60_000];
  prune(state, now);
  assert.deepEqual(Object.keys(state.seen), ['fresh']);
  assert.deepEqual(state.sends, [now - 60_000]);
});

test('prune keeps at most 500 alerts and 5000 seen keys (oldest dropped first)', () => {
  const now = 10_000_000_000;
  const state = emptyState();
  state.alerts = Array.from({ length: 600 }, (_, i) => ({ at: i }));
  state.seen = Object.fromEntries(Array.from({ length: 5100 }, (_, i) => [`k${i}`, now - i]));
  prune(state, now);
  assert.equal(state.alerts.length, 500);
  assert.equal(state.alerts[0].at, 100);
  assert.equal(Object.keys(state.seen).length, 5000);
  assert.ok(!('k5099' in state.seen), 'oldest seen key was dropped');
});

test('loading keeps known fields and ignores ones with the wrong type', async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, STATE_FILE), JSON.stringify({
    streams: 'oops',
    heartbeatDate: '2026-10-10',
    sends: [1, 'x', 3],
    digest: { held: [{ summary: 'a' }] },
  }));
  const store = createStateStore({ dir, clock: createFakeClock(), log: () => {} });
  const state = await store.load();
  assert.deepEqual(state.streams, {});
  assert.equal(state.heartbeatDate, '2026-10-10');
  assert.deepEqual(state.sends, [1, 3]);
  assert.deepEqual(state.digest.held, [{ summary: 'a' }]);
  assert.deepEqual(state.digest.overflow, []);
});

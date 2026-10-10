import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWatcher, parseArgs, readCredentials, runCheckConfig, runTestNotify } from '../../watcher.mjs';
import { parseConfig } from '../../lib/config.mjs';
import { makeRedactor } from '../../lib/redact.mjs';
import { createFakeClock, createFakeFetch, createFakeLib, jsonResponse, settle, snapshot } from './support.mjs';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789/SECRET_WEBHOOK_PART';
const TOKEN = 'SECRET_LOCAL_TOKEN_VALUE';
const TV_SESSION = 'SECRET_SESSION_VALUE';
const TV_SIGN = 'SECRET_SIGN_VALUE';
const TELEGRAM = '987654:SECRET_BOT_TOKEN_VALUE';

const RAW_CONFIG = {
  timezone: 'UTC',
  watchlist: [{ symbol: 'BINANCE:BTCUSDT', timeframes: ['15'] }],
  rules: [{ id: 'move', type: 'pct_move', bars: 1, threshold_pct: 0.5 }],
  trending: { enabled: false },
  alerts: { cooldown_minutes: 60, max_per_hour: 20, quiet_hours: null },
  health: { stream_down_minutes: 10, daily_heartbeat: null },
  local_api: { enabled: true, port: 8787 },
};

async function build(t, { env = {}, fetch, dryRun = false, configOverrides = {}, stateDir, lib } = {}) {
  const dir = stateDir ?? await mkdtemp(join(tmpdir(), 'watcher-run-'));
  if (!stateDir) t.after(() => rm(dir, { recursive: true, force: true }));
  const { config, errors } = parseConfig({ ...RAW_CONFIG, ...configOverrides, state_dir: dir }, { home: '/home/test' });
  assert.deepEqual(errors, []);
  // Ephemeral port for tests: the validated config keeps 8787, the real one.
  config.local_api = { ...config.local_api, port: 0 };
  const fakeLib = lib ?? createFakeLib();
  const clock = createFakeClock(Date.UTC(2026, 9, 10, 12, 0, 0));
  const { fetch: fakeFetch, calls } = createFakeFetch(() => new Response(null, { status: 204 }));
  const logs = [];
  const printed = [];
  const fullEnv = {
    DISCORD_WEBHOOK_URL: WEBHOOK,
    WATCHER_LOCAL_TOKEN: TOKEN,
    TRADINGVIEW_SESSION_ID: TV_SESSION,
    TRADINGVIEW_SESSION_SIGN: TV_SIGN,
    ...env,
  };
  const watcher = createWatcher({
    config,
    env: fullEnv,
    lib: fakeLib,
    clock,
    random: () => 0,
    fetch: fetch ?? fakeFetch,
    write: (text) => printed.push(text),
    logWrite: (line) => logs.push(line),
    dryRun,
    redact: makeRedactor(fullEnv),
  });
  t.after(() => watcher.stop().catch(() => {}));
  return { watcher, clock, lib: fakeLib, calls, logs, printed, dir, fullEnv };
}

test('a closed bar that trips a rule is sent to Discord with the brief title', async (t) => {
  const { watcher, lib, calls, clock } = await build(t, { configOverrides: { local_api: { enabled: false, port: 8787 } } });
  await watcher.start();
  const w = lib.watchers[0];
  w.feed(snapshot([100, 101]));              // first snapshot: records the forming bar, no evaluation
  w.feed(snapshot([100, 101, 102]));         // bar 2 closes: move of 0.99% over 1 bar, above 0.5%
  clock.advance(1);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, WEBHOOK);
  assert.equal(calls[0].body.content, '🟢 BINANCE:BTCUSDT · 15m · pct_move');
  assert.match(calls[0].body.embeds[0].description, /Up 1\.00% over 1 bar\n/);
  await watcher.stop();
});

test('the same rule on the same stream is held by the cooldown for the next bar', async (t) => {
  const { watcher, lib, calls } = await build(t, { configOverrides: { local_api: { enabled: false, port: 8787 } } });
  await watcher.start();
  const w = lib.watchers[0];
  w.feed(snapshot([100, 101]));
  w.feed(snapshot([100, 101, 102]));
  w.feed(snapshot([100, 101, 102, 104]));    // another move, still inside the 60-minute cooldown
  await settle();
  assert.equal(calls.length, 1);
  await watcher.stop();
});

test('evaluated bars are saved to state, and a restart does not alert again for them', async (t) => {
  const first = await build(t, { configOverrides: { local_api: { enabled: false, port: 8787 } } });
  await first.watcher.start();
  first.lib.watchers[0].feed(snapshot([100, 101]));
  first.lib.watchers[0].feed(snapshot([100, 101, 102]));
  await settle();
  assert.equal(first.calls.length, 1);
  await first.watcher.stop();

  const saved = JSON.parse(await readFile(join(first.dir, 'state.json'), 'utf8'));
  assert.equal(saved.streams['BINANCE:BTCUSDT|15'].lastEvaluatedTime, 1_700_000_000 + 3600);

  // A new process on the same state directory: the same closed bar replays.
  const second = await build(t, { stateDir: first.dir, configOverrides: { local_api: { enabled: false, port: 8787 } } });
  await second.watcher.start();
  second.lib.watchers[0].feed(snapshot([100, 101, 102]));
  second.lib.watchers[0].feed(snapshot([100, 101, 102, 102.5]));
  await settle();
  assert.equal(second.calls.length, 0, 'no duplicate alert after a restart');
  await second.watcher.stop();
});

test('a stream that goes quiet sends one "stream down" alert, and one "recovered" when data returns', async (t) => {
  const { watcher, lib, calls, clock } = await build(t, { configOverrides: { local_api: { enabled: false, port: 8787 } } });
  await watcher.start();
  const w = lib.watchers[0];
  w.feed(snapshot([100]));
  clock.advance(11 * 60_000);
  await watcher.tick();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.embeds[0].title, '🔴 BINANCE:BTCUSDT · 15m · stream down');
  w.feed(snapshot([100, 101]));
  await watcher.tick();
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.embeds[0].title, '🟢 BINANCE:BTCUSDT · 15m · stream recovered');
  await watcher.stop();
});

test('a disconnect is logged with its time and counted in /health', async (t) => {
  const { watcher, lib, logs } = await build(t);
  await watcher.start();
  lib.watchers[0].fail('CONNECTION_ERROR', 'socket dropped');
  await settle();
  assert.ok(logs.some((line) => /disconnected at \d{4}-\d{2}-\d{2}T[\d:.]+Z \(CONNECTION_ERROR\)/.test(line)));
  const address = watcher.localApi.server.address();
  const res = await fetch(`http://127.0.0.1:${address.port}/health`);
  const body = await res.json();
  assert.equal(body.disconnects, 1);
  assert.equal(body.connection_drops, 1);
  assert.equal(body.streams.total, 1);
  await watcher.stop();
});

test('POST /notify with the token sends a message through the same pipeline', async (t) => {
  const { watcher, calls } = await build(t);
  await watcher.start();
  const address = watcher.localApi.server.address();
  assert.equal(address.address, '127.0.0.1');
  const res = await fetch(`http://127.0.0.1:${address.port}/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ title: 'Paper fill', body: 'bought 1 BTC', key: 'fill-42', level: 'up' }),
  });
  assert.equal(res.status, 202);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.embeds[0].title, '🟢 Paper fill');
  await watcher.stop();
});

test('the local API stays off without a token, and the log says so', async (t) => {
  const { watcher, logs } = await build(t, { env: { WATCHER_LOCAL_TOKEN: '' } });
  await watcher.start();
  assert.equal(watcher.localApi, null);
  assert.ok(logs.some((line) => line.includes('local API disabled')));
  await watcher.stop();
});

test('dry run prints alerts, never calls fetch, and saves no state', async (t) => {
  const fetchSpy = createFakeFetch(() => { throw new Error('fetch must not be called'); });
  const { watcher, lib, printed, dir } = await build(t, {
    dryRun: true,
    fetch: fetchSpy.fetch,
    configOverrides: { local_api: { enabled: false, port: 8787 } },
  });
  await watcher.start();
  lib.watchers[0].feed(snapshot([100, 101]));
  lib.watchers[0].feed(snapshot([100, 101, 102]));
  await settle();
  assert.equal(fetchSpy.calls.length, 0);
  assert.equal(printed.length, 1);
  assert.match(printed[0], /BINANCE:BTCUSDT · 15m · pct_move/);
  await watcher.stop();
  await assert.rejects(readFile(join(dir, 'state.json'), 'utf8'), { code: 'ENOENT' });
});

test('nothing sensitive reaches the log, even though every secret is set', async (t) => {
  const { watcher, lib, logs, calls, fullEnv } = await build(t, {
    env: { TELEGRAM_BOT_TOKEN: TELEGRAM, TELEGRAM_CHAT_ID: '4242' },
    configOverrides: { local_api: { enabled: false, port: 8787 } },
  });
  await watcher.start();
  lib.watchers[0].feed(snapshot([100, 101]));
  lib.watchers[0].fail('CONNECTION_ERROR', `socket to ${WEBHOOK} and bot${TELEGRAM}`);
  lib.watchers[1]?.feed(snapshot([100]));
  await watcher.tick();
  await settle();
  const everything = [...logs, ...calls.map((c) => c.url), JSON.stringify(calls.map((c) => c.body))].join('\n');
  for (const secret of [WEBHOOK, TELEGRAM, TV_SESSION, TV_SIGN, TOKEN, 'SECRET_BOT_TOKEN_VALUE', 'SECRET_WEBHOOK_PART']) {
    assert.ok(!logs.join('\n').includes(secret), `log leaked ${secret}`);
  }
  assert.ok(!logs.join('\n').includes(fullEnv.TRADINGVIEW_SESSION_ID));
  assert.ok(everything.length > 0);
  await watcher.stop();
});

test('startup logs say whether TradingView credentials are in use, never their values', async (t) => {
  const { watcher, logs } = await build(t);
  await watcher.start();
  assert.ok(logs.some((line) => line.includes('TradingView login: credentials in use')));
  assert.ok(!logs.join('\n').includes(TV_SESSION));
  await watcher.stop();
});

test('without both cookies the watcher runs anonymous and says so', async (t) => {
  const { watcher, logs } = await build(t, { env: { TRADINGVIEW_SESSION_SIGN: '' } });
  await watcher.start();
  assert.ok(logs.some((line) => line.includes('TradingView login: anonymous')));
  await watcher.stop();
});

test('stop() closes the client and flushes state that changed', async (t) => {
  const { watcher, lib, dir } = await build(t, { configOverrides: { local_api: { enabled: false, port: 8787 } } });
  await watcher.start();
  lib.watchers[0].feed(snapshot([100, 101]));
  lib.watchers[0].feed(snapshot([100, 101, 102]));
  await watcher.stop();
  assert.equal(lib.clients[0].closeCalls, 1);
  const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  assert.ok(saved.version === 1);
});

test('readCredentials needs both cookie values', () => {
  assert.equal(readCredentials({}), null);
  assert.equal(readCredentials({ TRADINGVIEW_SESSION_ID: 'a' }), null);
  assert.deepEqual(readCredentials({ TRADINGVIEW_SESSION_ID: 'a', TRADINGVIEW_SESSION_SIGN: 'b' }), { session: 'a', signature: 'b' });
});

test('parseArgs accepts the four flags and rejects unknown arguments and a missing config', () => {
  assert.deepEqual(parseArgs(['--config', 'x.json', '--check-config']).args.checkConfig, true);
  assert.equal(parseArgs(['--config=y.json', '--log-json']).args.config, 'y.json');
  assert.equal(parseArgs(['--config', 'x.json', '--dry-run', '--once', '--test-notify']).args.once, true);
  assert.match(parseArgs(['--check-config']).error, /--config <path> is required/);
  assert.match(parseArgs(['--config', 'x', '--wat']).error, /unknown argument: --wat/);
  assert.match(parseArgs(['--config']).error, /needs a path/);
});

test('--check-config prints OK for a valid config, the problems otherwise, and exits accordingly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'watcher-check-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const good = join(dir, 'good.json');
  const bad = join(dir, 'bad.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(good, JSON.stringify(RAW_CONFIG));
  await writeFile(bad, JSON.stringify({ watchlist: [{ symbol: 'NOT A SYMBOL', timeframes: ['7'] }], timezone: 'Nowhere/City' }));

  const outs = [];
  const errs = [];
  const okCode = await runCheckConfig({
    configPath: good, env: {}, out: (t2) => outs.push(t2), err: (t2) => errs.push(t2), redact: (x) => x,
  });
  assert.equal(okCode, 0);
  assert.deepEqual(outs, ['OK\n']);
  assert.ok(errs.some((line) => line.includes('no notification channel')));

  const outs2 = [];
  const badCode = await runCheckConfig({
    configPath: bad, env: {}, out: (t2) => outs2.push(t2), err: () => {}, redact: (x) => x,
  });
  assert.equal(badCode, 1);
  assert.ok(outs2.join('').includes('timezone: is not a valid IANA timezone name'));
  assert.ok(outs2.join('').includes('watchlist[0].symbol: is not a valid symbol'));
});

test('--check-config flags a malformed webhook without echoing it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'watcher-check-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const good = join(dir, 'good.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(good, JSON.stringify(RAW_CONFIG));
  const outs = [];
  const code = await runCheckConfig({
    configPath: good,
    env: { DISCORD_WEBHOOK_URL: 'https://evil.example/SECRET_HOOK_VALUE' },
    out: (t2) => outs.push(t2), err: () => {}, redact: (x) => x,
  });
  assert.equal(code, 1);
  assert.ok(outs.join('').includes('DISCORD_WEBHOOK_URL is set but is not a Discord webhook URL'));
  assert.ok(!outs.join('').includes('SECRET_HOOK_VALUE'));
});

test('--test-notify sends to each configured channel and exits 0 when all succeed', async () => {
  const { fetch, calls } = createFakeFetch(() => jsonResponse(200, { ok: true }));
  const outs = [];
  const code = await runTestNotify({
    env: { DISCORD_WEBHOOK_URL: WEBHOOK, TELEGRAM_BOT_TOKEN: TELEGRAM, TELEGRAM_CHAT_ID: '4242' },
    fetch,
    out: (t) => outs.push(t),
    redact: makeRedactor({ DISCORD_WEBHOOK_URL: WEBHOOK, TELEGRAM_BOT_TOKEN: TELEGRAM }),
    now: Date.UTC(2026, 9, 10),
  });
  assert.equal(code, 0);
  assert.deepEqual(outs, ['discord: ok\n', 'telegram: ok\n']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.content, '✅ tradingview watcher test');
  assert.ok(!outs.join('').includes(WEBHOOK));
  assert.ok(!outs.join('').includes(TELEGRAM));
});

test('--test-notify exits 1 when a channel fails, and names the status not the URL', async () => {
  const { fetch } = createFakeFetch(() => new Response('nope', { status: 401 }));
  const outs = [];
  const code = await runTestNotify({
    env: { TELEGRAM_BOT_TOKEN: TELEGRAM, TELEGRAM_CHAT_ID: '4242' },
    fetch,
    out: (t) => outs.push(t),
    redact: makeRedactor({ TELEGRAM_BOT_TOKEN: TELEGRAM }),
  });
  assert.equal(code, 1);
  assert.equal(outs[0], 'telegram: failed (Telegram answered HTTP 401)\n');
});

test('--test-notify with no channel configured exits 1 with guidance', async () => {
  const outs = [];
  const code = await runTestNotify({ env: {}, fetch: createFakeFetch().fetch, out: (t) => outs.push(t), redact: (x) => x });
  assert.equal(code, 1);
  assert.match(outs[0], /no notification channel is configured/);
});

// --- review additions ---

/** Reads state.json, waiting (real time, up to 2 s) for the disk write to finish. */
async function readStateSoon(dir) {
  for (let i = 0; i < 100; i += 1) {
    try {
      return JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  return JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
}

test('--test-notify together with --dry-run prints the message and never calls fetch', async () => {
  const spy = createFakeFetch(() => { throw new Error('fetch must not be called'); });
  const outs = [];
  const code = await runTestNotify({
    env: { DISCORD_WEBHOOK_URL: WEBHOOK, TELEGRAM_BOT_TOKEN: TELEGRAM, TELEGRAM_CHAT_ID: '4242' },
    fetch: spy.fetch,
    out: (t) => outs.push(t),
    redact: makeRedactor({ DISCORD_WEBHOOK_URL: WEBHOOK }),
    dryRun: true,
  });
  assert.equal(code, 0);
  assert.equal(spy.calls.length, 0);
  assert.ok(outs.join('').includes('tradingview watcher test'));
});

test('a bug in a housekeeping step is logged and does not stop the tick or crash the process', async (t) => {
  const { watcher, logs } = await build(t, { configOverrides: { local_api: { enabled: false, port: 8787 } } });
  await watcher.start();
  watcher.health.tick = () => { throw new Error('health exploded'); };
  await watcher.tick();                                   // must not reject
  assert.ok(logs.some((line) => line.includes('health tick failed: health exploded')));
  await watcher.stop();
});

test('a rule hit is saved to disk at once, not 5 seconds later', async (t) => {
  const { watcher, lib, dir } = await build(t, { configOverrides: { local_api: { enabled: false, port: 8787 } } });
  await watcher.start();
  lib.watchers[0].feed(snapshot([100, 101]));
  lib.watchers[0].feed(snapshot([100, 101, 102]));        // closes the 101 bar: +1% hit
  await settle();
  const saved = await readStateSoon(dir);
  assert.equal(Object.keys(saved.seen).length, 1, 'the dedupe record is on disk');
  assert.ok(saved.streams['BINANCE:BTCUSDT|15'].lastEvaluatedTime > 0);
  await watcher.stop();
});

test('shutdown saves state before it waits for undelivered alerts', async (t) => {
  // Discord hangs forever: stop() waits for the bounded drain, but state must already be saved.
  const hang = createFakeFetch(() => new Promise(() => {}));
  const { watcher, lib, clock, dir } = await build(t, {
    fetch: hang.fetch,
    configOverrides: { local_api: { enabled: false, port: 8787 } },
  });
  await watcher.start();
  lib.watchers[0].feed(snapshot([100, 100]));
  lib.watchers[0].feed(snapshot([100, 100, 100]));        // flat: evaluated, no hit, so no immediate save
  watcher.alerts.submit({                                  // a message whose delivery hangs
    kind: 'notify',
    message: { level: 'info', title: 'x', lines: [], timestamp: new Date(clock.now()).toISOString() },
    summary: 'x',
  });
  await settle();
  assert.equal(watcher.queue.pending(), 1);
  const stopping = watcher.stop();
  await settle();
  const saved = await readStateSoon(dir);
  assert.ok(saved.streams['BINANCE:BTCUSDT|15'], 'state is on disk while the drain is still waiting');
  clock.advance(5000);                                    // the drain gives up
  await stopping;
});

test('the chat id, local token, cookies, webhook and bot token never reach a log, even when Telegram fails', async (t) => {
  const CHAT = '-1009988776655';
  const failing = createFakeFetch((url) => {
    if (url.includes('telegram')) throw new Error(`socket hang up for ${url} chat ${CHAT}`);
    return new Response(null, { status: 500 });
  });
  const { watcher, lib, logs, clock, fullEnv } = await build(t, {
    fetch: failing.fetch,
    env: { TELEGRAM_BOT_TOKEN: TELEGRAM, TELEGRAM_CHAT_ID: CHAT },
    configOverrides: { local_api: { enabled: false, port: 8787 } },
  });
  await watcher.start();
  lib.watchers[0].feed(snapshot([100, 101]));
  lib.watchers[0].feed(snapshot([100, 101, 102]));
  for (let i = 0; i < 4; i += 1) {
    await settle();
    clock.advance(5000);
  }
  await watcher.stop();
  const text = logs.join('\n');
  assert.ok(text.includes('alert dropped'), 'deliveries failed and were logged');
  for (const secret of [CHAT, WEBHOOK, TELEGRAM, 'SECRET_BOT_TOKEN_VALUE', 'SECRET_WEBHOOK_PART', fullEnv.WATCHER_LOCAL_TOKEN,
    fullEnv.TRADINGVIEW_SESSION_ID, fullEnv.TRADINGVIEW_SESSION_SIGN]) {
    assert.ok(!text.includes(secret), `log leaked ${secret}`);
  }
});

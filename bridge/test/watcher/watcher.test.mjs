import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
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
  config.dashboard = { ...config.dashboard, port: configOverrides.dashboard?.port ?? 0 };
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
    TRADINGVIEW_MCP_HOME: dir,
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

test('the cooldown is per direction: a move down is sent right after a move up, and a second move up is held', async (t) => {
  const { watcher, lib, calls } = await build(t, { configOverrides: { local_api: { enabled: false, port: 8787 } } });
  await watcher.start();
  const w = lib.watchers[0];
  w.feed(snapshot([100, 101]));
  w.feed(snapshot([100, 101, 102]));               // up 1.00%: sent
  w.feed(snapshot([100, 101, 102, 100]));          // up 0.99% again: same |up cooldown key, held
  w.feed(snapshot([100, 101, 102, 100, 100]));     // down 1.96%: |down key, sent
  await settle();
  assert.equal(calls.length, 2, 'one up and one down, the second up is held');
  assert.match(calls[0].body.embeds[0].description, /Up 1\.00% over 1 bar\n/);
  assert.match(calls[1].body.embeds[0].description, /Down 1\.96% over 1 bar\n/);
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

// ---- W1: per-rule max_per_day and expires, through the whole watcher ----------------------
const NO_API = { local_api: { enabled: false, port: 8787 } };
const ruleWith = (extra) => ({ rules: [{ id: 'move', type: 'pct_move', bars: 1, threshold_pct: 0.5, ...extra }], ...NO_API });

test('max_per_day: the second alert of the day is dropped, whatever its direction', async (t) => {
  const { watcher, lib, calls, logs } = await build(t, { configOverrides: ruleWith({ max_per_day: 1 }) });
  await watcher.start();
  const w = lib.watchers[0];
  w.feed(snapshot([100, 101]));
  w.feed(snapshot([100, 101, 102]));              // up: sent
  w.feed(snapshot([100, 101, 102, 100]));         // up again: cooldown
  w.feed(snapshot([100, 101, 102, 100, 100]));    // down: a different cooldown key, but over the daily cap
  await settle();
  assert.equal(calls.length, 1);
  assert.ok(logs.some((l) => l.includes('daily cap')), logs.join('\n'));
  await watcher.stop();
});

test('max_per_day: the counter is saved, so a restart does not give the rule a fresh allowance', async (t) => {
  const overrides = { ...ruleWith({ max_per_day: 1 }), alerts: { cooldown_minutes: 1, max_per_hour: 20, quiet_hours: null } };
  const first = await build(t, { configOverrides: overrides });
  await first.watcher.start();
  first.lib.watchers[0].feed(snapshot([100, 101]));
  first.lib.watchers[0].feed(snapshot([100, 101, 102]));
  await settle();
  assert.equal(first.calls.length, 1);
  await first.watcher.stop();
  const saved = JSON.parse(await readFile(join(first.dir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.dailyCounts, { move: { date: '2026-10-10', count: 1 } });

  const second = await build(t, { stateDir: first.dir, configOverrides: overrides });
  await second.watcher.start();
  second.clock.advance(2 * 60_000);                // the 1-minute cooldown is over, so only the cap can stop it
  second.lib.watchers[0].feed(snapshot([100, 101, 102]));
  second.lib.watchers[0].feed(snapshot([100, 101, 102, 102.5]));
  await settle();
  assert.equal(second.calls.length, 0);
  assert.ok(second.logs.some((l) => l.includes('daily cap')), second.logs.join('\n'));
  await second.watcher.stop();
});

test('max_per_day in a dry run is enforced, printed once, and still saves no state', async (t) => {
  const fetchSpy = createFakeFetch(() => { throw new Error('fetch must not be called'); });
  const { watcher, lib, printed, dir } = await build(t, { dryRun: true, fetch: fetchSpy.fetch, configOverrides: ruleWith({ max_per_day: 1 }) });
  await watcher.start();
  lib.watchers[0].feed(snapshot([100, 101]));
  lib.watchers[0].feed(snapshot([100, 101, 102]));
  lib.watchers[0].feed(snapshot([100, 101, 102, 100]));
  lib.watchers[0].feed(snapshot([100, 101, 102, 100, 100]));
  await settle();
  assert.equal(printed.length, 1);
  assert.equal(fetchSpy.calls.length, 0);
  await watcher.stop();
  await assert.rejects(readFile(join(dir, 'state.json'), 'utf8'), { code: 'ENOENT' });
});

test('expires: a rule is skipped after the end of its last day, and fires on that day', async (t) => {
  // The test clock is 2026-10-10 12:00 UTC and the config timezone is UTC.
  const expired = await build(t, { configOverrides: ruleWith({ expires: '2026-10-09' }) });
  await expired.watcher.start();
  expired.lib.watchers[0].feed(snapshot([100, 101]));
  expired.lib.watchers[0].feed(snapshot([100, 101, 102]));
  await settle();
  assert.equal(expired.calls.length, 0, 'expired yesterday');
  await expired.watcher.stop();

  const lastDay = await build(t, { configOverrides: ruleWith({ expires: '2026-10-10' }) });
  await lastDay.watcher.start();
  lastDay.lib.watchers[0].feed(snapshot([100, 101]));
  lastDay.lib.watchers[0].feed(snapshot([100, 101, 102]));
  await settle();
  assert.equal(lastDay.calls.length, 1, 'expires today, still active');
  await lastDay.watcher.stop();
});

test('--check-config warns about an expired rule and still prints OK', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'watcher-check-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'expired.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, JSON.stringify({ ...RAW_CONFIG, rules: [{ ...RAW_CONFIG.rules[0], expires: '2000-01-01' }] }));
  const outs = [];
  const errs = [];
  const code = await runCheckConfig({ configPath: file, env: {}, out: (x) => outs.push(x), err: (x) => errs.push(x), redact: (x) => x });
  assert.equal(code, 0);
  assert.deepEqual(outs, ['OK\n']);
  assert.ok(errs.some((line) => line.includes('expired') && line.includes('2000-01-01')), errs.join(''));
});

// ---- W2: calendar gating, through the whole watcher ---------------------------------------
// The test clock reads Saturday 2026-10-10 12:00 UTC (outside the US session) the whole time, so a rule that fires
// proves the gate looks at the bar's own close time and not at the clock. October is EDT (UTC-4), November EST (UTC-5).

/** Feeds two snapshots on a 15-minute stream so that the bar closing at `closeIso` trips the 0.5% rule. */
async function barClosingAt(t, closeIso, rule) {
  const built = await build(t, { configOverrides: ruleWith(rule) });
  await built.watcher.start();
  const startTime = Date.parse(closeIso) / 1000 - 1800;
  built.lib.watchers[0].feed(snapshot([100, 101], { startTime, step: 900 }));
  built.lib.watchers[0].feed(snapshot([100, 101, 102], { startTime, step: 900 }));
  await settle();
  return built;
}

const GATE_CASES = [
  ['mid-session', '2026-10-12T17:00:00Z', true],
  ['the bar closing at 16:00 is the last one in', '2026-10-12T20:00:00Z', true],
  ['a bar closing at 16:15 is out', '2026-10-12T20:15:00Z', false],
  ['the bar closing at 09:45 is the first one in', '2026-10-12T13:45:00Z', true],
  ['the bar closing at 09:30 ended before the open', '2026-10-12T13:30:00Z', false],
  ['a Saturday', '2026-10-10T17:00:00Z', false],
  ['Thanksgiving 2026 (holiday)', '2026-11-26T17:00:00Z', false],
  ['early close day: the bar closing at 13:00 is the last one in', '2026-11-27T18:00:00Z', true],
  ['early close day: a bar closing at 13:15 is out', '2026-11-27T18:15:00Z', false],
  ['2027-01-18 (holiday from the new defaults)', '2027-01-18T17:00:00Z', false],
  ['2027-01-19 (a normal day)', '2027-01-19T17:00:00Z', true],
  ['2027-11-26 early close: a bar closing at 13:15 is out', '2027-11-26T18:15:00Z', false],
  ['2027-12-24 is a full closure, not an early close', '2027-12-24T15:00:00Z', false],
];

for (const [name, closeIso, fires] of GATE_CASES) {
  test(`calendar us_session: ${name} ${fires ? 'fires' : 'is skipped'}`, async (t) => {
    const { watcher, calls } = await barClosingAt(t, closeIso, { calendar: 'us_session' });
    assert.equal(calls.length, fires ? 1 : 0);
    await watcher.stop();
  });
}

test('calendar any (or no field) fires outside the session', async (t) => {
  for (const rule of [{ calendar: 'any' }, {}]) {
    const { watcher, calls } = await barClosingAt(t, '2026-10-10T17:00:00Z', rule);
    assert.equal(calls.length, 1, JSON.stringify(rule));
    await watcher.stop();
  }
});

test('a gated rule is never evaluated, so it uses no daily allowance and records nothing', async (t) => {
  const { watcher, calls, dir } = await barClosingAt(t, '2026-10-10T17:00:00Z', { calendar: 'us_session', max_per_day: 1 });
  assert.equal(calls.length, 0);
  await watcher.stop();
  const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.dailyCounts ?? {}, {});
  assert.deepEqual(saved.cooldowns ?? {}, {});
  assert.deepEqual(saved.seen ?? {}, {});
});

test('gating one rule leaves the other rules on the same stream alone', async (t) => {
  const rules = [
    { id: 'gated', type: 'pct_move', bars: 1, threshold_pct: 0.5, calendar: 'us_session' },
    { id: 'open', type: 'pct_move', bars: 1, threshold_pct: 0.5 },
  ];
  const { watcher, lib, calls } = await build(t, { configOverrides: { rules, ...NO_API } });
  await watcher.start();
  const startTime = Date.parse('2026-10-10T17:00:00Z') / 1000 - 1800;
  lib.watchers[0].feed(snapshot([100, 101], { startTime, step: 900 }));
  lib.watchers[0].feed(snapshot([100, 101, 102], { startTime, step: 900 }));
  await settle();
  assert.equal(calls.length, 1);
  await watcher.stop();
});

// A stock stream has no bars between the close and the next open, so the candle after the closed one opens the next
// morning. The gate must judge the closed bar by its own open time, not by that next candle (review finding, W2).
const GAP_CASES = [
  ['the 15:45 bar before the overnight gap', '2026-10-09T19:45:00Z', '2026-10-12T13:30:00Z', true],
  ['a 15:30 hourly bar (30 minutes long) before the gap', '2026-10-09T19:30:00Z', '2026-10-12T13:30:00Z', true],
  ['the 12:45 bar on an early-close day, before the long weekend gap', '2026-11-27T17:45:00Z', '2026-11-30T14:30:00Z', true],
  ['an after-hours 16:00 bar before the gap is still out', '2026-10-09T20:00:00Z', '2026-10-12T13:30:00Z', false],
  ['a 13:00 bar on an early-close day is out', '2026-11-27T18:00:00Z', '2026-11-30T14:30:00Z', false],
];

for (const [name, openIso, nextIso, fires] of GAP_CASES) {
  test(`calendar us_session on a gapped stream: ${name} ${fires ? 'fires' : 'is skipped'}`, async (t) => {
    const { watcher, lib, calls } = await build(t, { configOverrides: ruleWith({ calendar: 'us_session' }) });
    await watcher.start();
    const candles = snapshot([100, 101, 102], { step: 900 });
    candles[0].time = Date.parse(openIso) / 1000 - 900;
    candles[1].time = Date.parse(openIso) / 1000;
    candles[2].time = Date.parse(nextIso) / 1000;
    lib.watchers[0].feed(candles.slice(0, 2));
    lib.watchers[0].feed(candles);
    await settle();
    assert.equal(calls.length, fires ? 1 : 0);
    await watcher.stop();
  });
}

// ---- W3: all_of / any_of, through the whole watcher ---------------------------------------
const composites = (extra = {}) => ({
  rules: [
    { id: 'a', type: 'pct_move', bars: 1, threshold_pct: 0.5 },
    { id: 'b', type: 'pct_move', bars: 1, threshold_pct: 0.9 },
    { id: 'both', type: 'all_of', rules: ['a', 'b'], ...extra },
  ],
  ...NO_API,
});
const fromType = (calls, type) => calls.filter((c) => c.body.content.endsWith(`· ${type}`));

test('all_of sends one combined alert, in addition to the members\' own alerts', async (t) => {
  const { watcher, lib, calls } = await build(t, { configOverrides: composites() });
  await watcher.start();
  lib.watchers[0].feed(snapshot([100, 101]));
  lib.watchers[0].feed(snapshot([100, 101, 102]));      // the 101 bar is +1.00%: a (0.5) and b (0.9) both fire
  await settle();
  assert.equal(calls.length, 3, 'a, b and the combination');
  const combined = fromType(calls, 'all_of');
  assert.equal(combined.length, 1);
  assert.match(combined[0].body.embeds[0].description, /a: Up 1\.00% over 1 bar \| b: Up 1\.00% over 1 bar/);
  assert.match(combined[0].body.embeds[0].description, /Rule: both/);
  await watcher.stop();
});

test('a composite that needs every member stays quiet when one member does not fire', async (t) => {
  const { watcher, lib, calls } = await build(t, { configOverrides: composites() });
  await watcher.start();
  lib.watchers[0].feed(snapshot([100, 100.7]));
  lib.watchers[0].feed(snapshot([100, 100.7, 101]));    // +0.7%: a fires, b does not
  await settle();
  assert.equal(fromType(calls, 'all_of').length, 0);
  assert.equal(calls.length, 1, 'only a');
  await watcher.stop();
});

test('the direction is part of the composite cooldown, and max_per_day counts the composite on its own', async (t) => {
  const run = async (extra) => {
    const rules = [
      { id: 'a', type: 'pct_move', bars: 1, threshold_pct: 0.5 },
      { id: 'b', type: 'pct_move', bars: 1, threshold_pct: 0.6 },
      { id: 'either', type: 'any_of', rules: ['a', 'b'], ...extra },
    ];
    const built = await build(t, { configOverrides: { rules, ...NO_API } });
    await built.watcher.start();
    const w = built.lib.watchers[0];
    w.feed(snapshot([100, 101]));
    w.feed(snapshot([100, 101, 102]));              // up: sent
    w.feed(snapshot([100, 101, 102, 100]));         // up again: cooldown
    w.feed(snapshot([100, 101, 102, 100, 100]));    // down: a different cooldown key
    await settle();
    await built.watcher.stop();
    return fromType(built.calls, 'any_of');
  };
  assert.equal((await run({})).length, 2, 'one up, one down');
  assert.equal((await run({ max_per_day: 1 })).length, 1, 'the cap stops the second');
});

// ---- W3 review fixes ----------------------------------------------------------------------
test('an any_of whose members disagree on one bar sends both directions, not one', async (t) => {
  // Closed bar 100 after [110, 95]: a (bars 1) is +5.26% up, b (bars 2) is -9.09% down. Both fire on the same bar.
  const rules = [
    { id: 'a', type: 'pct_move', bars: 1, threshold_pct: 5 },
    { id: 'b', type: 'pct_move', bars: 2, threshold_pct: 5 },
    { id: 'either', type: 'any_of', rules: ['a', 'b'] },
  ];
  const { watcher, lib, calls } = await build(t, { configOverrides: { rules, ...NO_API } });
  await watcher.start();
  lib.watchers[0].feed(snapshot([110, 95, 100]));
  lib.watchers[0].feed(snapshot([110, 95, 100, 101]));
  await settle();
  const sent = fromType(calls, 'any_of');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((c) => c.body.embeds[0].description.split('\n')[0]).sort(),
    ['a: Up 5.26% over 1 bar', 'b: Down 9.09% over 2 bars']);
  await watcher.stop();
});

// Inside a composite, a member's own expiry and session gate still count: a retired member must not keep alerting
// through the composite. It cannot hit, so it blocks an all_of and is simply absent from an any_of.
const gatedMembers = (type, memberExtra) => ({
  rules: [
    { id: 'a', type: 'pct_move', bars: 1, threshold_pct: 0.5, ...memberExtra },
    { id: 'b', type: 'pct_move', bars: 1, threshold_pct: 0.5 },
    { id: 'both', type, rules: ['a', 'b'] },
  ],
  ...NO_API,
});

for (const [name, memberExtra] of [['has expired', { expires: '2026-10-09' }], ['is out of its us_session', { calendar: 'us_session' }]]) {
  test(`a member that ${name}: any_of carries on without it, all_of stays quiet`, async (t) => {
    // The snapshot bars are in November 2023 at night (UTC), so the calendar member is out of session, and the clock is 2026-10-10.
    const feedOneHit = async (type) => {
      const built = await build(t, { configOverrides: gatedMembers(type, memberExtra) });
      await built.watcher.start();
      built.lib.watchers[0].feed(snapshot([100, 101]));
      built.lib.watchers[0].feed(snapshot([100, 101, 102]));
      await settle();
      await built.watcher.stop();
      return built.calls;
    };
    const any = fromType(await feedOneHit('any_of'), 'any_of');
    assert.equal(any.length, 1);
    assert.match(any[0].body.embeds[0].description, /^b: Up 1\.00% over 1 bar\n/, 'only the live member is reported');
    assert.equal(fromType(await feedOneHit('all_of'), 'all_of').length, 0);
  });
}

test('an any_of whose members are all expired sends nothing', async (t) => {
  const rules = [
    { id: 'a', type: 'pct_move', bars: 1, threshold_pct: 0.5, expires: '2026-10-09' },
    { id: 'b', type: 'pct_move', bars: 1, threshold_pct: 0.5, expires: '2026-10-09' },
    { id: 'either', type: 'any_of', rules: ['a', 'b'] },
  ];
  const { watcher, lib, calls } = await build(t, { configOverrides: { rules, ...NO_API } });
  await watcher.start();
  lib.watchers[0].feed(snapshot([100, 101]));
  lib.watchers[0].feed(snapshot([100, 101, 102]));
  await settle();
  assert.equal(calls.length, 0);
  await watcher.stop();
});

test('a rule alert is recorded with its meta: rule, symbol, timeframe, bar, direction, message, values', async (t) => {
  const { watcher, lib, clock } = await build(t, { configOverrides: { local_api: { enabled: false, port: 8787 } } });
  await watcher.start();
  const w = lib.watchers[0];
  w.feed(snapshot([100, 101]));
  w.feed(snapshot([100, 101, 102]));
  clock.advance(1);
  await settle();
  const [entry] = watcher.state.state.alerts;
  assert.equal(entry.kind, 'rule');
  assert.equal(entry.meta.ruleId, 'move');
  assert.equal(entry.meta.symbol, 'BINANCE:BTCUSDT');
  assert.equal(entry.meta.timeframe, '15');
  assert.equal(entry.meta.direction, 'up');
  assert.equal(typeof entry.meta.barTime, 'number');
  assert.match(entry.meta.message, /^Up 1\.00% over 1 bar/);
  assert.equal(entry.meta.values.close, 101); // the closed bar; 102 is still forming
  await watcher.stop();
});

// ---------------------------------------------------------------- dashboard wiring

const DASH_TOKEN = 'SECRET_DASHBOARD_TOKEN_VALUE_1234';
const dashPort = (watcher) => watcher.dashboard.server.address().port;
const getFrom = (watcher, path, init) => globalThis.fetch(`http://127.0.0.1:${dashPort(watcher)}${path}`, init);

function listen(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      resolve({
        text: () => text,
        async waitFor(needle) {
          for (let i = 0; i < 400 && !text.includes(needle); i += 1) await new Promise((r) => setTimeout(r, 5));
          assert.ok(text.includes(needle), `waited for ${needle}, got ${text}`);
        },
        close: () => req.destroy(),
      });
    });
    req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
  });
}

test('the dashboard starts with the watcher on its own port, serves the API, and stop() frees the port', async (t) => {
  const { watcher, logs } = await build(t, { configOverrides: NO_API });
  await watcher.start();
  const port = dashPort(watcher);
  assert.ok(logs.some((l) => l.includes(`dashboard listening on 127.0.0.1:${port}`)));
  const res = await getFrom(watcher, '/api/streams');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [{ symbol: 'BINANCE:BTCUSDT', timeframe: '15', healthy: false, lastBarTime: null }]);
  await watcher.stop();
  await assert.rejects(globalThis.fetch(`http://127.0.0.1:${port}/api/streams`));
});

test('dashboard.enabled false: no server is created, and the log says so', async (t) => {
  const { watcher, logs } = await build(t, { configOverrides: { ...NO_API, dashboard: { enabled: false } } });
  await watcher.start();
  assert.equal(watcher.dashboard, null);
  assert.ok(logs.some((l) => /dashboard disabled/.test(l)));
  await watcher.stop();
});

test('a non-loopback dashboard without a usable token is refused with the reason, and the watcher still alerts', async (t) => {
  for (const env of [{}, { WATCHER_DASHBOARD_TOKEN: 'short' }]) {
    const { watcher, logs, lib, calls, clock } = await build(t, { env, configOverrides: { ...NO_API, dashboard: { host: '0.0.0.0' } } });
    await watcher.start();
    assert.equal(watcher.dashboard, null);
    assert.ok(logs.some((l) => l.includes('dashboard not started') && l.includes('WATCHER_DASHBOARD_TOKEN')), logs.join('\n'));
    lib.watchers[0].feed(snapshot([100, 101]));
    lib.watchers[0].feed(snapshot([100, 101, 102]));
    clock.advance(1);
    await settle();
    assert.equal(calls.length, 1, 'the rule alert is still sent');
    await watcher.stop();
  }
});

test('a dashboard port that is already taken is logged, and the watcher carries on without it', async (t) => {
  const taken = net.createServer();
  await new Promise((resolve) => taken.listen(0, '127.0.0.1', resolve));
  t.after(() => taken.close());
  const { watcher, logs, lib } = await build(t, { configOverrides: { ...NO_API, dashboard: { port: taken.address().port } } });
  await watcher.start();
  assert.ok(logs.some((l) => l.includes('dashboard not started') && l.includes('EADDRINUSE')), logs.join('\n'));
  assert.equal(lib.watchers.length, 1, 'the streams started anyway');
  await watcher.stop();
});

test('bars, alerts and health from the watcher reach the bus', async (t) => {
  const { watcher, lib, clock } = await build(t, { configOverrides: { ...NO_API, dashboard: { enabled: false } } });
  const seen = { bar: [], alert: [], health: [] };
  for (const name of Object.keys(seen)) watcher.bus.on(name, (...args) => seen[name].push(args));
  await watcher.start();
  lib.watchers[0].feed(snapshot([100, 101]));
  lib.watchers[0].feed(snapshot([100, 101, 102]));
  clock.advance(1);
  await watcher.tick();
  assert.equal(seen.bar.length, 2);
  assert.equal(seen.bar[0][0].key, 'BINANCE:BTCUSDT|15');
  assert.equal(seen.bar[1][1].close, 102);
  assert.equal(seen.alert.length, 1);
  assert.equal(seen.alert[0][0].meta.ruleId, 'move');
  assert.equal(seen.health.length, 1);
  assert.equal(seen.health[0][0][0].symbol, 'BINANCE:BTCUSDT');
  await watcher.stop();
});

test('end to end: a rule alert reaches a browser on /events and then /api/alerts, with its meta', async (t) => {
  const { watcher, lib, clock } = await build(t, { configOverrides: NO_API });
  await watcher.start();
  const events = await listen(dashPort(watcher), '/events');
  t.after(() => events.close());
  lib.watchers[0].feed(snapshot([100, 101]));
  lib.watchers[0].feed(snapshot([100, 101, 102]));
  clock.advance(1);
  await events.waitFor('event: alert');
  const alertData = JSON.parse(events.text().split('event: alert\ndata: ')[1].split('\n')[0]);
  assert.equal(alertData.ruleId, 'move');
  assert.equal(alertData.symbol, 'BINANCE:BTCUSDT');
  assert.equal(alertData.direction, 'up');
  const history = await (await getFrom(watcher, '/api/alerts')).json();
  assert.equal(history.length, 1);
  assert.equal(history[0].ruleId, 'move');
  assert.equal(history[0].timeframe, '15');
  const candles = await (await getFrom(watcher, '/api/candles?symbol=BINANCE:BTCUSDT&tf=15')).json();
  assert.equal(candles.length, 3);
  await watcher.stop();
});

test('the dashboard token never reaches a log, even through a ?token= visit', async (t) => {
  const { watcher, logs } = await build(t, { env: { WATCHER_DASHBOARD_TOKEN: DASH_TOKEN }, configOverrides: NO_API });
  await watcher.start();
  assert.equal((await getFrom(watcher, '/api/streams')).status, 401, 'a token that is set is required, even on loopback');
  const visit = await getFrom(watcher, `/?token=${DASH_TOKEN}`, { redirect: 'manual' });
  assert.equal(visit.status, 302);
  await watcher.stop();
  assert.ok(!logs.join('\n').includes(DASH_TOKEN));
});

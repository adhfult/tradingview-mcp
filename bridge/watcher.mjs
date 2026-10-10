#!/usr/bin/env node
/**
 * Market watcher: a standalone Node process that streams live candles for a
 * watchlist with the user's TradingView account, checks rules on each closed bar,
 * runs a trending scan, and sends alerts to Discord and/or Telegram. It never
 * places trades and needs neither the MCP server nor Claude.
 *
 *   node bridge/watcher.mjs --config <path> [--check-config] [--test-notify]
 *                           [--dry-run] [--once] [--log-json]
 *
 * `createWatcher(deps)` is exported for tests (fake library, fake fetch, fake clock).
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { errorMessage } from './lib/errors.mjs';
import { createClientManager } from './lib/client.mjs';
import { loadConfig, checkEnv } from './lib/config.mjs';
import { createAlerts } from './lib/alerts.mjs';
import { createHealth } from './lib/health.mjs';
import { createLocalApi } from './lib/localapi.mjs';
import { createQueue } from './lib/queue.mjs';
import { buildNotifiers, createStdoutNotifier } from './lib/notifiers.mjs';
import { createLogger, renderNotify, renderRuleAlert, renderTest } from './lib/format.mjs';
import { evaluateRules } from './lib/rules.mjs';
import { buildUsCalendar, createScanner } from './lib/scanner.mjs';
import { createStateStore } from './lib/state.mjs';
import { createStreams } from './lib/stream.mjs';
import { makeRedactor } from './lib/redact.mjs';
import { guardStdio } from './lib/stdio.mjs';

export const TICK_MS = 30_000;
const SHUTDOWN_GRACE_MS = 15_000; // systemd waits 90s by default; stop() itself is bounded well below this
const FATAL_FLUSH_MS = 2000;
const QUEUE_DRAIN_MS = 5000;
const USAGE = 'usage: node bridge/watcher.mjs --config <path> [--check-config] [--test-notify] [--dry-run] [--once] [--log-json]';

export function realClock() {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (id) => globalThis.clearInterval(id),
  };
}

/** Both cookies set, or no login (anonymous). */
export function readCredentials(env) {
  const session = env.TRADINGVIEW_SESSION_ID;
  const signature = env.TRADINGVIEW_SESSION_SIGN;
  if (typeof session === 'string' && session !== '' && typeof signature === 'string' && signature !== '') {
    return { session, signature };
  }
  return null;
}

/**
 * Builds the whole watcher. `config` is a validated config (from loadConfig),
 * `lib` the library functions (`watchCandles`, `getHotlist`, `TradingViewClient`).
 * `write` receives alerts in dry-run mode, `logWrite` receives log lines.
 */
export function createWatcher({
  config,
  env = process.env,
  lib,
  clock = realClock(),
  random = Math.random,
  fetch = globalThis.fetch,
  write = () => {},
  logWrite = () => {},
  logJson = false,
  dryRun = false,
  redact = makeRedactor(env),
}) {
  if (!config) throw new TypeError('createWatcher requires a validated config');
  const startedAtMs = clock.now();
  const credentials = readCredentials(env);
  const logger = createLogger({ write: logWrite, redact, json: logJson, now: clock.now });
  const store = createStateStore({
    dir: config.state_dir,
    clock,
    log: (message) => logger.warn(message),
    persist: !dryRun,
  });

  const notifiers = dryRun
    ? [createStdoutNotifier({ write, redact })]
    : buildNotifiers({ env, fetch, redact });
  const queue = createQueue({ notifiers, clock, log: (message) => logger.warn(message) });
  const alerts = createAlerts({
    alerts: config.alerts,
    timezone: config.timezone,
    store,
    clock,
    queue,
    log: (message) => logger.info(message),
  });

  const evaluated = {
    get: (key) => store.state.streams[key]?.lastEvaluatedTime,
    set: (key, time) => {
      store.state.streams[key] = { ...(store.state.streams[key] ?? {}), lastEvaluatedTime: time };
      store.touch();
    },
  };

  const onClosedBar = (stream, closed, closeTime) => {
    const hits = evaluateRules(config.rules, stream, closed);
    for (const hit of hits) {
      const message = renderRuleAlert(hit, {
        timezone: config.timezone,
        now: clock.now(),
        dataAtMs: stream.lastDataAt,
        closeTimeSec: closeTime,
      });
      alerts.submit({
        kind: 'rule',
        message,
        summary: `${hit.symbol} ${hit.timeframe} ${hit.ruleId}: ${hit.message}`,
        dedupeKey: `${hit.symbol}|${hit.timeframe}|${hit.ruleId}|${hit.barTime}`,
        cooldownKey: `${hit.symbol}|${hit.timeframe}|${hit.ruleId}|${hit.direction}`,
      });
    }
    // Save at once when something was sent: a crash inside the 5 s debounce window would
    // otherwise lose the dedupe record and could repeat the alert after the restart.
    if (hits.length > 0) {
      store.flush().catch((err) => logger.warn(`state write failed: ${err?.code ?? 'error'}`));
    }
  };

  const clients = createClientManager({
    lib,
    credentials,
    now: clock.now,
    log: (message) => logger.warn(message),
  });
  let connectionsOpened = 0;
  const streams = createStreams({
    streams: config.streams,
    lib,
    clients,
    clock,
    logger,
    evaluated,
    onClosedBar,
    random,
    onConnection: () => { connectionsOpened += 1; },
  });

  const scanner = createScanner({
    trending: config.trending,
    timezone: config.timezone,
    getHotlist: lib?.getHotlist,
    store,
    clock,
    alerts,
    logger,
    usCalendar: buildUsCalendar({ holidays: config.health.us_holidays, earlyCloses: config.health.us_early_closes }),
  });

  const health = createHealth({
    streams,
    alerts,
    clock,
    store,
    timezone: config.timezone,
    config: config.health,
    startedAtMs,
    credentialsInUse: credentials !== null,
    logger,
  });

  const apiToken = typeof env.WATCHER_LOCAL_TOKEN === 'string' ? env.WATCHER_LOCAL_TOKEN : '';
  const localApi = config.local_api.enabled && apiToken !== ''
    ? createLocalApi({
      port: config.local_api.port,
      token: apiToken,
      logger,
      submit: (value) => {
        alerts.submit({
          kind: 'notify',
          message: renderNotify({ ...value, now: clock.now() }),
          summary: value.title,
          dedupeKey: `notify|${value.key}`,
        });
      },
      health: () => ({
        ok: true,
        streams: health.summary(),
        uptime_s: Math.floor((clock.now() - startedAtMs) / 1000),
        disconnects: streams.counters().disconnects,
        connection_drops: streams.counters().connection_drops,
      }),
    })
    : null;

  let ticker = null;
  let nextScanAt = 0;
  let scanInFlight = null;
  let stopping = false;

  /** One pass: digests and heartbeat, stream health, and a trending scan when due. */
  async function tick() {
    if (stopping) return;
    // A bug in one housekeeping step must not kill a process that is otherwise healthy.
    for (const [name, step] of [['alerts', () => alerts.tick()], ['health', () => health.tick()]]) {
      try {
        step();
      } catch (err) {
        logger.error(`${name} tick failed: ${errorMessage(err)}`);
      }
    }
    const now = clock.now();
    if (config.trending.enabled && now >= nextScanAt && scanInFlight === null) {
      nextScanAt = now + config.trending.every_minutes * 60_000;
      scanInFlight = scanner.runOnce()
        .catch((err) => logger.error(`trending scan failed: ${errorMessage(err)}`))
        .finally(() => { scanInFlight = null; });
    }
    if (scanInFlight !== null) await scanInFlight;
  }

  return {
    logger,
    state: store,
    alerts,
    queue,
    streams,
    scanner,
    health,
    localApi,
    tick,

    /** Loads state, starts the streams and the tick, and opens the local API. */
    async start() {
      await store.load();
      logger.info(`started: ${config.streams.length} stream(s), ${config.rules.length} rule(s), timezone ${config.timezone}`);
      logger.info(credentials
        ? 'TradingView login: credentials in use'
        : 'TradingView login: anonymous (set TRADINGVIEW_SESSION_ID and TRADINGVIEW_SESSION_SIGN for logged-in data)');
      if (dryRun) logger.info('dry run: alerts are printed to stdout, nothing is sent, state is not saved');
      if (localApi !== null) {
        const bound = await localApi.listen();
        logger.info(`local API listening on ${bound.host}:${bound.port}`);
      } else {
        logger.info('local API disabled (needs local_api.enabled and WATCHER_LOCAL_TOKEN)');
      }
      nextScanAt = clock.now();
      streams.start();
      ticker = clock.setInterval(() => { void tick(); }, TICK_MS);
    },

    /** Graceful stop: streams, then queued messages (bounded), state, local API, client. */
    async stop() {
      if (stopping) return;
      stopping = true;
      if (ticker !== null) clock.clearInterval(ticker);
      ticker = null;
      await streams.stop();
      // Save first: what was evaluated must survive even if delivery below takes a while.
      await store.flush().catch((err) => logger.warn(`state write failed: ${err?.code ?? 'error'}`));
      await drain(queue, clock, QUEUE_DRAIN_MS);
      const undelivered = queue.pending();
      if (undelivered > 0) logger.warn(`shutdown: ${undelivered} alert(s) not yet delivered were dropped`);
      queue.close();
      await store.close().catch((err) => logger.warn(`state write failed: ${err?.code ?? 'error'}`));
      if (localApi !== null) await localApi.close();
      await clients.close();
      logger.info('stopped');
    },
  };
}

/** Waits for the queue to empty, but no longer than `ms` on the given clock. */
function drain(queue, clock, ms) {
  return new Promise((resolve) => {
    let finished = false;
    const timer = clock.setTimeout(() => {
      if (!finished) resolve();
    }, ms);
    queue.idle().then(() => {
      if (finished) return;
      finished = true;
      clock.clearTimeout(timer);
      resolve();
    });
  });
}

/** Parses argv. Returns {args} or {error}. */
export function parseArgs(argv) {
  const args = {
    config: null,
    checkConfig: false,
    testNotify: false,
    dryRun: false,
    once: false,
    logJson: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config' || arg.startsWith('--config=')) {
      const value = arg === '--config' ? argv[i + 1] : arg.slice('--config='.length);
      if (arg === '--config') i += 1;
      if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
        return { error: '--config needs a path' };
      }
      args.config = value;
    } else if (arg === '--check-config') args.checkConfig = true;
    else if (arg === '--test-notify') args.testNotify = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--once') args.once = true;
    else if (arg === '--log-json') args.logJson = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else return { error: `unknown argument: ${arg}` };
  }
  if (!args.help && args.config === null) return { error: '--config <path> is required' };
  return { args };
}

/**
 * --check-config: prints OK (exit 0), or every problem (exit 1). Warnings about
 * missing channels go to stderr and do not fail the check.
 */
export async function runCheckConfig({ configPath, env, out, err, redact }) {
  const { config, errors, warnings = [] } = await loadConfig(configPath);
  const envCheck = checkEnv(env);
  const problems = [...errors, ...envCheck.errors];
  if (config === null || problems.length > 0) {
    for (const problem of problems) out(`${redact(problem)}\n`);
    return 1;
  }
  out('OK\n');
  for (const warning of [...warnings, ...envCheck.warnings]) err(`warning: ${redact(warning)}\n`);
  return 0;
}

/** --test-notify: one message to each configured channel. Exit 0 only if all succeed. */
export async function runTestNotify({ env, fetch, out, redact, now = Date.now(), dryRun = false }) {
  // --dry-run never sends: the test message is only printed.
  const notifiers = dryRun
    ? [createStdoutNotifier({ write: out, redact })]
    : buildNotifiers({ env, fetch, redact });
  if (notifiers.length === 0) {
    out('no notification channel is configured (set DISCORD_WEBHOOK_URL, or TELEGRAM_BOT_TOKEN with TELEGRAM_CHAT_ID)\n');
    return 1;
  }
  const message = renderTest(now);
  let allOk = true;
  for (const notifier of notifiers) {
    try {
      await notifier.send(message);
      out(`${notifier.name}: ok\n`);
    } catch (err) {
      allOk = false;
      out(`${notifier.name}: failed (${redact(errorMessage(err))})\n`);
    }
  }
  return allOk ? 0 : 1;
}

/** --once: one trending scan printed to stdout. Changes no state and sends nothing. */
export async function runTrendingOnce({ config, lib, out, logWrite, redact, clock = realClock() }) {
  const logger = createLogger({ write: logWrite, redact, now: clock.now });
  const store = createStateStore({ dir: config.state_dir, clock, persist: false });
  const scanner = createScanner({
    trending: { ...config.trending, us_regular_hours_only: false },
    timezone: config.timezone,
    getHotlist: lib.getHotlist,
    store,
    clock,
    alerts: { submit: () => 'sent' },
    logger,
  });
  const lines = await scanner.printOnce();
  out(`${lines.join('\n')}\n`);
  return 0;
}

async function loadLibrary() {
  const [root, data] = await Promise.all([
    import('@mathieuc/tradingview'),
    import('@mathieuc/tradingview/data'),
  ]);
  return { ...data, TradingViewClient: root.TradingViewClient };
}

/** Runs the CLI with argv (without node and the script). Returns the exit code. */
export async function main(argv, { env = process.env, fetch = globalThis.fetch } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n${USAGE}\n`);
    return 2;
  }
  const { args } = parsed;
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const redact = makeRedactor(env);
  // Before the library is imported: stdout carries our own output only.
  const out = guardStdio({ redact });
  const logWrite = (text) => process.stderr.write(text);
  const write = (text) => out.write(text);
  const err = (text) => process.stderr.write(text);

  if (args.checkConfig) {
    return runCheckConfig({ configPath: args.config, env, out: write, err, redact });
  }

  const { config, errors, warnings = [] } = await loadConfig(args.config);
  if (config === null) {
    for (const problem of errors) err(`${redact(problem)}\n`);
    return 1;
  }
  for (const warning of warnings) err(`warning: ${redact(warning)}\n`);
  const envCheck = checkEnv(env);
  if (envCheck.errors.length > 0) {
    for (const problem of envCheck.errors) err(`${redact(problem)}\n`);
    return 1;
  }

  if (args.testNotify) {
    return runTestNotify({ env, fetch, out: write, redact, dryRun: args.dryRun });
  }

  const lib = await loadLibrary();
  if (args.once) {
    return runTrendingOnce({ config, lib, out: write, logWrite, redact });
  }

  const watcher = createWatcher({
    config, env, lib, fetch, write, logWrite, logJson: args.logJson, dryRun: args.dryRun, redact,
  });
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    watcher.logger.info(`received ${signal}, stopping`);
    const hardStop = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
    hardStop.unref();
    await watcher.stop();
    await new Promise((resolve) => out.write('', resolve));
    process.exit(0);
  };
  // A crash exits 1 so systemd restarts the service. Messages are redacted.
  const fatal = (text) => {
    logWrite(`${redact(text)}\n`);
    // Best effort: save what was evaluated (bounded), then exit 1 so systemd restarts us.
    const done = () => process.exit(1);
    setTimeout(done, FATAL_FLUSH_MS);
    watcher.state.flush().then(done, done);
  };
  process.on('unhandledRejection', (reason) => {
    fatal(`fatal: unhandled rejection: ${errorMessage(reason)}`);
  });
  process.on('uncaughtException', (error) => {
    fatal(`fatal: uncaught exception: ${errorMessage(error)}`);
  });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.stdout.on('error', () => process.exit(0));

  try {
    await watcher.start();
  } catch (error) {
    logWrite(`${redact(`fatal: ${errorMessage(error)}`)}\n`);
    return 1;
  }
  return null; // keep running: the tick interval holds the process open
}

// Compare real paths: Node resolves symlinks in import.meta.url but not in argv[1].
function isEntryPoint() {
  if (process.argv[1] === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== null) process.exit(code);
    })
    .catch((error) => {
      process.stderr.write(`${makeRedactor(process.env)(`fatal: ${errorMessage(error)}`)}\n`);
      process.exit(1);
    });
}

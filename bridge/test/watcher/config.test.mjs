import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseConfig, loadConfig, parseHHMM, inferMarket, expandHome, isValidTimezone, checkEnv,
} from '../../lib/config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(here, '..', '..', 'watcher.config.example.json');
const HOME = '/home/tester';

function base(overrides = {}) {
  return {
    timezone: 'UTC',
    watchlist: [{ symbol: 'BINANCE:BTCUSDT', timeframes: ['60'] }],
    ...overrides,
  };
}

test('the valid example config passes with no errors', async () => {
  const { config, errors } = await loadConfig(EXAMPLE, { home: HOME });
  assert.deepEqual(errors, []);
  assert.equal(config.streams.length, 7);
  assert.equal(config.rules.length, 6);
  assert.equal(config.state_dir, '/home/tester/.local/state/tradingview-watcher');
});

test('the example normalises markets and applies defaults', async () => {
  const { config } = await loadConfig(EXAMPLE, { home: HOME });
  const byKey = Object.fromEntries(config.watchlist.map((e) => [e.symbol, e]));
  assert.equal(byKey['BINANCE:BTCUSDT'].market, 'crypto');
  assert.equal(byKey['NASDAQ:NVDA'].market, 'stock');
  assert.equal(config.alerts.max_per_hour, 20);
  assert.equal(config.health.daily_heartbeat, '08:00');
});

test('a minimal config gets the documented defaults', () => {
  const { config, errors } = parseConfig(base(), { home: HOME });
  assert.deepEqual(errors, []);
  assert.equal(config.trending.enabled, false);
  assert.equal(config.trending.every_minutes, 10);
  assert.deepEqual(config.trending.markets, ['crypto', 'america']);
  assert.equal(config.local_api.port, 8787);
  assert.equal(config.limits.max_streams, 25);
  assert.equal(config.alerts.quiet_hours, null);
});

test('every problem is reported with its JSON path, not just the first', () => {
  const { config, errors } = parseConfig({
    timezone: 'Mars/Olympus',
    watchlist: [
      { symbol: 'NOT A SYMBOL', timeframes: ['7'] },
      { symbol: 'NASDAQ:NVDA', timeframes: [] },
    ],
    rules: [{ id: 'bad id!', type: 'pct_move', bars: 0, threshold_pct: 3 }],
    trending: { every_minutes: 2, top_n: 500 },
    alerts: { quiet_hours: { start: '25:00', end: '07:00' } },
    health: { daily_heartbeat: 'noon' },
    local_api: { port: 80 },
  }, { home: HOME });
  assert.equal(config, null);
  const text = errors.join('\n');
  assert.match(text, /^timezone: is not a valid IANA timezone name$/m);
  assert.match(text, /watchlist\[0\]\.symbol: is not a valid symbol/);
  assert.match(text, /watchlist\[0\]\.timeframes\[0\]: "7" is not an allowed timeframe/);
  assert.match(text, /watchlist\[1\]\.timeframes: must be a list of 1 to 13 timeframes/);
  assert.match(text, /rules\[0\]\.id: must be 1 to 64/);
  assert.match(text, /rules\[0\]\.bars: must be between 1 and 500/);
  assert.match(text, /trending\.every_minutes: must be at least 5/);
  assert.match(text, /trending\.top_n: must be at most 200/);
  assert.match(text, /alerts\.quiet_hours\.start: must be HH:MM/);
  assert.match(text, /health\.daily_heartbeat: must be HH:MM/);
  assert.match(text, /local_api\.port: must be at least 1024/);
  assert.ok(errors.length >= 11, `expected all problems, got ${errors.length}`);
});

test('more than 25 symbol x timeframe streams is rejected', () => {
  const watchlist = Array.from({ length: 6 }, (_, i) => ({
    symbol: `BINANCE:COIN${i}USDT`,
    timeframes: ['1', '3', '5', '15', '30'],
  }));
  const { config, errors } = parseConfig({ watchlist }, { home: HOME });
  assert.equal(config, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /30 symbol x timeframe streams exceed limits\.max_streams \(25; hard cap 25\)/);
});

test('limits.max_streams above the hard cap of 25 is rejected', () => {
  const { errors } = parseConfig(base({ limits: { max_streams: 40 } }), { home: HOME });
  assert.ok(errors.some((e) => e.startsWith('limits.max_streams: must be at most 25')));
});

test('the stream count is checked against a lower max_streams', () => {
  const { errors } = parseConfig(base({
    watchlist: [{ symbol: 'BINANCE:BTCUSDT', timeframes: ['1', '3', '5'] }],
    limits: { max_streams: 2 },
  }), { home: HOME });
  assert.ok(errors.some((e) => e.includes('exceed limits.max_streams (2')));
});

test('unknown keys are reported so typos never do nothing silently', () => {
  const { errors } = parseConfig(base({ trending: { enabled: true, every_mintues: 10 } }), { home: HOME });
  assert.ok(errors.includes('trending.every_mintues: unknown key'));
});

test('rule types must be known and their parameters in range', () => {
  const { errors } = parseConfig(base({
    rules: [
      { id: 'a', type: 'moon_shot' },
      { id: 'b', type: 'rsi_cross', period: 14, levels: [30, 170] },
      { id: 'c', type: 'bollinger_break', period: 20, stddev: -1 },
      { id: 'd', type: 'price_cross' },
    ],
  }), { home: HOME });
  assert.ok(errors.some((e) => e.startsWith('rules[0].type: must be one of')));
  assert.ok(errors.some((e) => e === 'rules[1].levels[1]: must be at most 100'));
  assert.ok(errors.some((e) => e === 'rules[2].stddev: must be greater than 0'));
  assert.ok(errors.some((e) => e === 'rules[3].level: is required'));
});

test('rule ids must be unique', () => {
  const { errors } = parseConfig(base({
    rules: [
      { id: 'same', type: 'new_extreme', lookback: 5 },
      { id: 'same', type: 'new_extreme', lookback: 6 },
    ],
  }), { home: HOME });
  assert.ok(errors.some((e) => e.includes('rules[1].id: "same" is already used')));
});

test('a rule naming a symbol outside the watchlist is an error', () => {
  const { errors } = parseConfig(base({
    rules: [{ id: 'x', type: 'price_cross', symbol: 'NASDAQ:AAPL', level: 10 }],
  }), { home: HOME });
  assert.ok(errors.some((e) => e === 'rules[0].symbol: NASDAQ:AAPL is not in the watchlist'));
});

test('a rule whose timeframes are not watched is an error', () => {
  const { errors } = parseConfig(base({
    rules: [{ id: 'x', type: 'new_extreme', lookback: 5, timeframes: ['D'] }],
  }), { home: HOME });
  assert.ok(errors.some((e) => e === 'rules[0]: matches no watched symbol and timeframe'));
});

test('trending.every_minutes must be at least 5', () => {
  const { errors } = parseConfig(base({ trending: { every_minutes: 4 } }), { home: HOME });
  assert.ok(errors.includes('trending.every_minutes: must be at least 5'));
});

test('quiet hours must be HH:MM and have different start and end', () => {
  assert.deepEqual(parseConfig(base({ alerts: { quiet_hours: { start: '23:00', end: '07:00' } } }), { home: HOME }).errors, []);
  const same = parseConfig(base({ alerts: { quiet_hours: { start: '07:00', end: '07:00' } } }), { home: HOME });
  assert.ok(same.errors.includes('alerts.quiet_hours: start and end must differ'));
  const bad = parseConfig(base({ alerts: { quiet_hours: { start: '7am', end: '07:00' } } }), { home: HOME });
  assert.ok(bad.errors.some((e) => e.startsWith('alerts.quiet_hours.start: must be HH:MM')));
});

test('the timezone must be a valid IANA name', () => {
  assert.equal(isValidTimezone('America/New_York'), true);
  assert.equal(isValidTimezone('Not/AZone'), false);
  const { errors } = parseConfig(base({ timezone: 'Not/AZone' }), { home: HOME });
  assert.ok(errors.includes('timezone: is not a valid IANA timezone name'));
});

test('the local API port must be 1024 to 65535', () => {
  assert.deepEqual(parseConfig(base({ local_api: { port: 1024 } }), { home: HOME }).errors, []);
  assert.deepEqual(parseConfig(base({ local_api: { port: 65535 } }), { home: HOME }).errors, []);
  assert.ok(parseConfig(base({ local_api: { port: 65536 } }), { home: HOME }).errors.length > 0);
  assert.ok(parseConfig(base({ local_api: { port: 1023 } }), { home: HOME }).errors.length > 0);
});

test('a duplicate watchlist symbol is an error', () => {
  const { errors } = parseConfig({
    watchlist: [
      { symbol: 'BINANCE:BTCUSDT', timeframes: ['60'] },
      { symbol: 'binance:btcusdt', timeframes: ['15'] },
    ],
  }, { home: HOME });
  assert.ok(errors.some((e) => e === 'watchlist[1].symbol: BINANCE:BTCUSDT is listed more than once'));
});

test('symbols are upper-cased and the market is inferred or taken from the entry', () => {
  const { config } = parseConfig({
    watchlist: [
      { symbol: 'kraken:btcusd', timeframes: ['D'] },
      { symbol: 'aapl', timeframes: ['D'], market: 'stock' },
    ],
  }, { home: HOME });
  assert.equal(config.watchlist[0].symbol, 'KRAKEN:BTCUSD');
  assert.equal(config.watchlist[0].market, 'crypto');
  assert.equal(config.watchlist[1].symbol, 'AAPL');
  assert.equal(config.watchlist[1].market, 'stock');
});

test('inferMarket recognises the crypto exchange prefixes only', () => {
  assert.equal(inferMarket('BINANCE:BTCUSDT'), 'crypto');
  assert.equal(inferMarket('OKX:ETHUSDT'), 'crypto');
  assert.equal(inferMarket('NASDAQ:NVDA'), 'stock');
  assert.equal(inferMarket('NVDA'), 'stock');
});

test('a leading ~ in state_dir expands to the home directory', () => {
  assert.equal(expandHome('~', HOME), HOME);
  assert.equal(expandHome('~/x/y', HOME), '/home/tester/x/y');
  assert.equal(expandHome('/var/state', HOME), '/var/state');
  assert.equal(expandHome('a~b', HOME), 'a~b');
});

test('parseHHMM accepts only 24-hour HH:MM', () => {
  assert.equal(parseHHMM('00:00'), 0);
  assert.equal(parseHHMM('23:59'), 23 * 60 + 59);
  assert.equal(parseHHMM('24:00'), null);
  assert.equal(parseHHMM('9:00'), null);
  assert.equal(parseHHMM(900), null);
});

test('a non-object config and an unreadable file are reported, not thrown', async () => {
  assert.deepEqual(parseConfig([], { home: HOME }).errors, ['$: the config must be a JSON object']);
  const missing = await loadConfig(join(here, 'no-such-file.json'), { home: HOME });
  assert.equal(missing.config, null);
  assert.match(missing.errors[0], /cannot read the config file/);
});

test('checkEnv validates shapes and never echoes values', () => {
  const secretUrl = 'https://discord.com/api/webhooks/123456/SECRET_TOKEN_VALUE';
  const bad = checkEnv({ DISCORD_WEBHOOK_URL: 'https://example.com/hook/SECRET_VALUE' });
  assert.ok(bad.errors.includes('DISCORD_WEBHOOK_URL is set but is not a Discord webhook URL'));
  assert.ok(!JSON.stringify(bad).includes('SECRET_VALUE'));

  const good = checkEnv({ DISCORD_WEBHOOK_URL: secretUrl, TRADINGVIEW_SESSION_ID: 'abc' });
  assert.deepEqual(good.errors, []);
  assert.ok(good.warnings.some((w) => w.includes('TRADINGVIEW_SESSION_SIGN')));
  assert.ok(!JSON.stringify(good).includes('SECRET_TOKEN_VALUE'));
  assert.ok(!good.warnings.some((w) => w.includes('no notification channel')));

  const badToken = checkEnv({ TELEGRAM_BOT_TOKEN: 'not-a-token', TELEGRAM_CHAT_ID: '5' });
  assert.ok(badToken.errors[0].startsWith('TELEGRAM_BOT_TOKEN is set but is not in the form'));
  assert.ok(!JSON.stringify(badToken).includes('not-a-token'));

  const none = checkEnv({});
  assert.ok(none.warnings.some((w) => w.includes('no notification channel')));
});

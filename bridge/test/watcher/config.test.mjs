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
const NOTES_OFF = { enabled: false, dir: null, vault: null, vault_folder: null };

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
  assert.equal(config.rules.length, 7);
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

// --- review additions ---

test('a rule that needs more closed bars than the 300 each stream keeps is a config error', () => {
  const base = { watchlist: [{ symbol: 'BINANCE:BTCUSDT', timeframes: ['60'] }] };
  const check = (rule) => parseConfig({ ...base, rules: [rule] }, { home: '/h' }).errors.join('\n');
  assert.match(check({ id: 'a', type: 'new_extreme', lookback: 400 }), /rules\[0\]: needs 401 closed bars but the watcher keeps only 300/);
  assert.match(check({ id: 'b', type: 'pct_move', bars: 300, threshold_pct: 1 }), /needs 301 closed bars/);
  assert.match(check({ id: 'c', type: 'volume_spike', multiple: 2, lookback: 300 }), /needs 301 closed bars/);
  assert.equal(check({ id: 'd', type: 'new_extreme', lookback: 299 }), '');
  assert.equal(check({ id: 'e', type: 'bollinger_break', period: 300 }), '');
});

// ---- W1: per-rule max_per_day and expires -----------------------------------------------
const withRule = (rule, extra = {}) => parseConfig(
  { ...base(), rules: [{ id: 'move', type: 'pct_move', bars: 1, threshold_pct: 1, ...rule }], ...extra },
  { home: HOME, now: Date.UTC(2026, 9, 10, 12, 0, 0) },
);

test('a rule may set max_per_day (1 to 1000) and expires (YYYY-MM-DD), and the config keeps them', () => {
  const { config, errors } = withRule({ max_per_day: 5, expires: '2026-12-31' });
  assert.deepEqual(errors, []);
  assert.equal(config.rules[0].max_per_day, 5);
  assert.equal(config.rules[0].expires, '2026-12-31');
});

test('max_per_day must be an integer from 1 to 1000', () => {
  for (const bad of [0, -1, 1001, 2.5, '3', null, true]) {
    const { errors } = withRule({ max_per_day: bad });
    assert.ok(errors.some((e) => e.startsWith('rules[0].max_per_day: ')), `${JSON.stringify(bad)} gave ${errors}`);
  }
  for (const good of [1, 1000]) assert.deepEqual(withRule({ max_per_day: good }).errors, []);
});

test('expires must be a real calendar date written YYYY-MM-DD', () => {
  for (const bad of ['2026-13-01', '2026-02-30', '2026-2-3', '31-12-2026', '2026-12-31T00:00', 20261231, '', null]) {
    const { errors } = withRule({ expires: bad });
    assert.ok(errors.some((e) => e.startsWith('rules[0].expires: must be a date')), `${JSON.stringify(bad)} gave ${errors}`);
  }
  assert.deepEqual(withRule({ expires: '2028-02-29' }).errors, [], 'a leap day is a real date');
});

test('bad max_per_day and expires are reported together with every other problem', () => {
  const { config, errors } = withRule({ bars: 0, max_per_day: 0, expires: 'soon' }, { timezone: 'Nowhere/City' });
  assert.equal(config, null);
  const text = errors.join('\n');
  assert.match(text, /rules\[0\]\.bars: /);
  assert.match(text, /rules\[0\]\.max_per_day: must be /);
  assert.doesNotMatch(text, /max_per_day: unknown key/);
  assert.match(text, /rules\[0\]\.expires: must be a date/);
  assert.match(text, /timezone: is not a valid IANA timezone name/);
});

test('a misspelt cap key is still an unknown key (the typo guard)', () => {
  const { errors } = withRule({ max_per_days: 3 });
  assert.ok(errors.includes('rules[0].max_per_days: unknown key'));
});

test('a rule that has already expired is a warning, not an error', () => {
  const { config, errors, warnings } = withRule({ expires: '2026-10-09' });
  assert.deepEqual(errors, []);
  assert.equal(config.rules.length, 1);
  assert.ok(warnings.some((w) => /rules\[0\]/.test(w) && /expired/.test(w) && w.includes('2026-10-09')), warnings.join('\n'));
});

test('a rule is not expired on its last day, and the day is judged in the config timezone', () => {
  const lastDay = withRule({ expires: '2026-10-10' });
  assert.deepEqual(lastDay.errors, []);
  assert.deepEqual(lastDay.warnings.filter((w) => /expired/.test(w)), []);
  // 03:00 UTC on 10 Oct is still 9 Oct (23:00) in New York.
  const ny = parseConfig(
    { ...base({ timezone: 'America/New_York' }), rules: [{ id: 'move', type: 'pct_move', bars: 1, threshold_pct: 1, expires: '2026-10-09' }] },
    { home: HOME, now: Date.UTC(2026, 9, 10, 3, 0, 0) },
  );
  assert.deepEqual(ny.errors, []);
  assert.notEqual(ny.config, null);
  assert.deepEqual(ny.warnings.filter((w) => /expired/.test(w)), []);
});

test('a rule id of __proto__ is rejected, because a counter stored under it could never be saved', () => {
  const { errors } = withRule({ id: '__proto__' });
  assert.ok(errors.some((e) => e.startsWith('rules[0].id: ') && e.includes('__proto__')), errors.join('\n'));
});

// ---- W2: calendar gating -----------------------------------------------------------------
test('a rule may set calendar to "any" or "us_session", and the config keeps it', () => {
  for (const calendar of ['any', 'us_session']) {
    const { config, errors } = withRule({ calendar });
    assert.deepEqual(errors, [], calendar);
    assert.equal(config.rules[0].calendar, calendar);
  }
  assert.equal(withRule({}).config.rules[0].calendar, undefined, 'no field means any, nothing is filled in');
});

test('calendar rejects any other value', () => {
  for (const bad of ['us', 'US_SESSION', '', null, true, 1]) {
    const { errors } = withRule({ calendar: bad });
    assert.ok(errors.some((e) => e.startsWith('rules[0].calendar: must be "any" or "us_session"')), `${JSON.stringify(bad)} gave ${errors}`);
  }
});

test('us_session needs intraday timeframes, because a daily bar closes at a day boundary', () => {
  const daily = base({ watchlist: [{ symbol: 'BINANCE:BTCUSDT', timeframes: ['60', 'D'] }] });
  const run = (rule) => parseConfig(
    { ...daily, rules: [{ id: 'move', type: 'pct_move', bars: 1, threshold_pct: 1, ...rule }] },
    { home: HOME, now: Date.UTC(2026, 9, 10, 12, 0, 0) },
  );
  // No timeframes on the rule means it also matches the daily stream.
  assert.ok(run({ calendar: 'us_session' }).errors.some((e) => /^rules\[0\]\.calendar: .*intraday/.test(e)));
  assert.ok(run({ calendar: 'us_session', timeframes: ['D'] }).errors.some((e) => /^rules\[0\]\.calendar: .*intraday/.test(e)));
  assert.ok(run({ calendar: 'us_session', timeframes: ['60', 'W'] }).errors.some((e) => /^rules\[0\]\.calendar: .*intraday/.test(e)));
  // Pinning the rule to intraday timeframes is the fix; "any" is never restricted.
  assert.deepEqual(run({ calendar: 'us_session', timeframes: ['60'] }).errors, []);
  assert.deepEqual(run({ calendar: 'any' }).errors, []);
  assert.deepEqual(run({}).errors, []);
});

test('the default holiday lists cover 2027 (NYSE release of 2025-12-23)', () => {
  const { config } = withRule({});
  const holidays = config.health.us_holidays;
  const early = config.health.us_early_closes;
  for (const date of ['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
    '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24']) {
    assert.ok(holidays.includes(date), `${date} is missing from us_holidays`);
  }
  assert.deepEqual(early.filter((d) => d.startsWith('2027')), ['2027-11-26']);
  assert.ok(!early.includes('2027-12-24'), '2027-12-24 is a full closure, not an early close');
  // The 2026 dates still ahead are kept.
  assert.ok(holidays.includes('2026-11-26') && holidays.includes('2026-12-25'));
  assert.ok(early.includes('2026-11-27') && early.includes('2026-12-24'));
});

test('a holiday list with no date 30 or more days ahead is a warning, not an error', () => {
  const at = (now, extra = {}) => parseConfig({ ...base(extra) }, { home: HOME, now });
  const stale = (r) => r.warnings.filter((w) => w.startsWith('health.us_holidays'));
  assert.deepEqual(stale(at(Date.UTC(2026, 9, 12))), [], 'the defaults run to 2027-12-24');
  assert.deepEqual(stale(at(Date.UTC(2027, 10, 24))), [], '30 days before the last date is still fine');
  const late = at(Date.UTC(2027, 11, 1));
  assert.deepEqual(late.errors, []);
  assert.ok(stale(late).length === 1 && stale(late)[0].includes('2027-12-24'), late.warnings.join('\n'));
  // A custom list that reaches further is judged on its own latest date.
  assert.deepEqual(stale(at(Date.UTC(2027, 11, 1), { health: { us_holidays: ['2028-12-25'] } })), []);
  assert.equal(stale(at(Date.UTC(2027, 11, 1), { health: { us_holidays: ['2027-12-24'] } })).length, 1);
  // An empty list is a deliberate choice, so it is not nagged about.
  const empty = at(Date.UTC(2027, 11, 1), { health: { us_holidays: [] } });
  assert.deepEqual(empty.errors, []);
  assert.deepEqual(stale(empty), []);
});

test('holiday and early-close dates must be real dates, so a typo cannot silently leave a holiday ungated', () => {
  for (const key of ['us_holidays', 'us_early_closes']) {
    const { errors } = parseConfig(base({ health: { [key]: ['2027-11-31'] } }), { home: HOME });
    assert.ok(errors.some((e) => e.startsWith(`health.${key}[0]: must be`)), `${key} gave ${errors}`);
  }
  assert.deepEqual(parseConfig(base({ health: { us_holidays: ['2028-02-29'] } }), { home: HOME }).errors, [], 'a leap day is real');
});

// ---- W3: all_of / any_of -----------------------------------------------------------------
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const A = { id: 'a', type: 'pct_move', bars: 1, threshold_pct: 1 };
const B = { id: 'b', type: 'rsi_cross', period: 14, levels: [30, 70] };
const parseRules = (rules, extra = {}) => parseConfig({ ...base(), ...extra, rules }, { home: HOME, now: NOW });
const joined = (r) => r.errors.join('\n');

test('a composite resolves its members, which may be defined after it', () => {
  for (const rules of [[A, B, { id: 'c', type: 'all_of', rules: ['a', 'b'] }], [{ id: 'c', type: 'any_of', rules: ['b', 'a'] }, A, B]]) {
    const r = parseRules(rules);
    assert.deepEqual(r.errors, []);
    const c = r.config.rules.find((x) => x.id === 'c');
    assert.deepEqual(c.members.map((m) => m.id), c.rules);
    assert.equal(c.members.find((m) => m.id === 'b').period, 14);
    assert.deepEqual(c.members.find((m) => m.id === 'b').levels, [30, 70]);
  }
});

test('a composite with an unknown member id is an error that names the id', () => {
  const r = parseRules([A, { id: 'c', type: 'all_of', rules: ['a', 'zzz'] }]);
  assert.match(joined(r), /^rules\[1\]\.rules\[1\]: "zzz" is not the id of a rule in this config$/m);
});

test('composites cannot contain composites, which also rules out self-reference and cycles', () => {
  const nested = parseRules([A, B, { id: 'c1', type: 'all_of', rules: ['a', 'b'] }, { id: 'c2', type: 'any_of', rules: ['c1', 'a'] }]);
  assert.match(joined(nested), /^rules\[3\]\.rules\[0\]: .*composites cannot contain composites/m);
  const self = parseRules([A, { id: 'c', type: 'all_of', rules: ['a', 'c'] }]);
  assert.match(joined(self), /^rules\[1\]\.rules\[1\]: .*composites cannot contain composites/m);
  const cycle = parseRules([A, { id: 'x', type: 'all_of', rules: ['a', 'y'] }, { id: 'y', type: 'any_of', rules: ['a', 'x'] }]);
  assert.match(joined(cycle), /^rules\[1\]\.rules\[1\]: .*composites cannot contain composites/m);
  assert.match(joined(cycle), /^rules\[2\]\.rules\[1\]: .*composites cannot contain composites/m);
});

test('the size and repeat limits of a rules list are reported at the composite', () => {
  assert.match(joined(parseRules([A, { id: 'c', type: 'all_of', rules: ['a'] }])), /^rules\[1\]\.rules: /m);
  assert.match(joined(parseRules([A, { id: 'c', type: 'all_of', rules: ['a', 'a'] }])), /^rules\[1\]\.rules: /m);
  assert.match(joined(parseRules([A, { id: 'c', type: 'all_of' }])), /^rules\[1\]\.rules: is required/m);
});

test('an all_of whose members never apply to the same stream could never fire, and is an error', () => {
  const two = { watchlist: [{ symbol: 'BINANCE:BTCUSDT', timeframes: ['15', '60'] }] };
  const rules = (type) => [{ ...A, timeframes: ['15'] }, { ...B, timeframes: ['60'] }, { id: 'c', type, rules: ['a', 'b'] }];
  assert.match(joined(parseRules(rules('all_of'), two)), /^rules\[2\]: .*could never fire/m);
  assert.deepEqual(parseRules(rules('any_of'), two).errors, [], 'either member alone is enough for any_of');
  // Same idea with symbols.
  const pair = { watchlist: [{ symbol: 'BINANCE:BTCUSDT', timeframes: ['60'] }, { symbol: 'BINANCE:ETHUSDT', timeframes: ['60'] }] };
  const bySymbol = [{ ...A, symbol: 'BINANCE:BTCUSDT' }, { ...B, symbol: 'BINANCE:ETHUSDT' }, { id: 'c', type: 'all_of', rules: ['a', 'b'] }];
  assert.match(joined(parseRules(bySymbol, pair)), /^rules\[2\]: .*could never fire/m);
});

test('an any_of none of whose members apply where the composite does could never fire', () => {
  const pair = { watchlist: [{ symbol: 'BINANCE:BTCUSDT', timeframes: ['60'] }, { symbol: 'BINANCE:ETHUSDT', timeframes: ['60'] }] };
  const rules = [{ ...A, symbol: 'BINANCE:ETHUSDT' }, { ...B, symbol: 'BINANCE:ETHUSDT' },
    { id: 'c', type: 'any_of', rules: ['a', 'b'], symbol: 'BINANCE:BTCUSDT' }];
  assert.match(joined(parseRules(rules, pair)), /^rules\[2\]: .*could never fire/m);
});

test('a member with its own error is reported once, without a second error on the composite', () => {
  const r = parseRules([{ ...A, bars: 0 }, B, { id: 'c', type: 'all_of', rules: ['a', 'b'] }]);
  assert.match(joined(r), /^rules\[0\]\.bars: /m);
  assert.doesNotMatch(joined(r), /rules\[2\]/);
});

test('a composite takes the generic rule keys: max_per_day, expires, calendar, symbol and timeframes', () => {
  const r = parseRules([A, B, { id: 'c', type: 'any_of', rules: ['a', 'b'], max_per_day: 3, expires: '2026-12-31',
    calendar: 'us_session', symbol: 'BINANCE:BTCUSDT', timeframes: ['60'] }]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.config.rules[2].max_per_day, 3);
  assert.equal(r.config.rules[2].calendar, 'us_session');
});

test('dashboard defaults: on, loopback only, port 8788', () => {
  const { config, errors } = parseConfig(base(), { home: HOME });
  assert.deepEqual(errors, []);
  assert.deepEqual(config.dashboard, { enabled: true, host: '127.0.0.1', port: 8788, notes: NOTES_OFF });
});

test('the example config sets the dashboard block explicitly, with the notes layer off', async () => {
  const { config, errors } = await loadConfig(EXAMPLE, { home: HOME });
  assert.deepEqual(errors, []);
  assert.deepEqual(config.dashboard, {
    enabled: true, host: '127.0.0.1', port: 8788,
    notes: { enabled: false, dir: join(HOME, 'notes/markets'), vault: 'ObsidianVault', vault_folder: 'markets' },
  });
});

test('dashboard values are validated with their JSON path', () => {
  const run = (dashboard) => parseConfig(base({ dashboard }), { home: HOME });
  assert.deepEqual(run({ enabled: false, host: '::1', port: 9000 }).config.dashboard, { enabled: false, host: '::1', port: 9000, notes: NOTES_OFF });
  assert.match(run({ port: 80 }).errors.join('\n'), /dashboard\.port: must be at least 1024/);
  assert.match(run({ port: 70000 }).errors.join('\n'), /dashboard\.port: must be at most 65535/);
  assert.match(run({ port: 8788.5 }).errors.join('\n'), /dashboard\.port/);
  assert.match(run({ host: '' }).errors.join('\n'), /dashboard\.host: must be a non-empty string/);
  assert.match(run({ host: 7 }).errors.join('\n'), /dashboard\.host: must be a non-empty string/);
  assert.match(run({ enabled: 'yes' }).errors.join('\n'), /dashboard\.enabled/);
  assert.match(run({ extra: 1 }).errors.join('\n'), /dashboard.*extra/);
  assert.match(run([]).errors.join('\n'), /dashboard: must be an object/);
});

test('the dashboard port must differ from the local API port', () => {
  const { errors } = parseConfig(base({ local_api: { port: 9100 }, dashboard: { port: 9100 } }), { home: HOME });
  assert.match(errors.join('\n'), /dashboard\.port: must differ from local_api\.port \(9100\)/);
  assert.deepEqual(parseConfig(base({ dashboard: { port: 8787 } }), { home: HOME }).errors.length, 1, 'the default local_api port counts too');
});

test('the port clash is caught even when the dashboard block is left out (the default 8788 applies)', () => {
  const { errors } = parseConfig(base({ local_api: { port: 8788 } }), { home: HOME });
  assert.match(errors.join('\n'), /dashboard\.port: must differ from local_api\.port \(8788\)/);
});

// ---------------------------------------------------------------- dashboard.notes

const NOTES = { enabled: true, dir: '/data/vault/markets', vault: 'My Vault', vault_folder: 'markets' };
const runNotes = (notes) => parseConfig(base({ dashboard: { notes } }), { home: HOME });

test('dashboard.notes: a full block is kept, ~ in dir is expanded, slashes around vault_folder are trimmed', () => {
  assert.deepEqual(runNotes(NOTES).config.dashboard.notes, NOTES);
  assert.deepEqual(runNotes(NOTES).errors, []);
  assert.equal(runNotes({ ...NOTES, dir: '~/vault/markets' }).config.dashboard.notes.dir, join(HOME, 'vault/markets'));
  assert.equal(runNotes({ ...NOTES, vault_folder: '/Markets/Watch/' }).config.dashboard.notes.vault_folder, 'Markets/Watch');
});

test('dashboard.notes: off needs no paths; on needs dir, vault and vault_folder', () => {
  assert.deepEqual(runNotes({ enabled: false }).errors, []);
  assert.deepEqual(runNotes({ enabled: false }).config.dashboard.notes, NOTES_OFF);
  assert.deepEqual(runNotes({}).config.dashboard.notes, NOTES_OFF);
  for (const key of ['dir', 'vault', 'vault_folder']) {
    const { [key]: _omitted, ...rest } = NOTES;
    assert.match(runNotes(rest).errors.join('\n'), new RegExp(`dashboard\\.notes\\.${key}: is required when notes are enabled`), key);
  }
});

test('dashboard.notes: values are validated with their JSON path', () => {
  const errs = (notes) => runNotes(notes).errors.join('\n');
  assert.match(errs({ ...NOTES, enabled: 'yes' }), /dashboard\.notes\.enabled/);
  assert.match(errs({ ...NOTES, dir: '' }), /dashboard\.notes\.dir: must be a non-empty string/);
  assert.match(errs({ ...NOTES, dir: 7 }), /dashboard\.notes\.dir: must be a non-empty string/);
  assert.match(errs({ ...NOTES, dir: 'relative/markets' }), /dashboard\.notes\.dir: must be an absolute path/);
  assert.match(errs({ ...NOTES, vault: '' }), /dashboard\.notes\.vault: must be a non-empty string/);
  assert.match(errs({ ...NOTES, vault_folder: '' }), /dashboard\.notes\.vault_folder/);
  assert.match(errs({ ...NOTES, vault_folder: '///' }), /dashboard\.notes\.vault_folder/);
  assert.match(errs({ ...NOTES, vault_folder: '../outside' }), /dashboard\.notes\.vault_folder: .*\.\./);
  assert.match(errs({ ...NOTES, vault_folder: 'a\\b' }), /dashboard\.notes\.vault_folder/);
  assert.match(errs({ ...NOTES, extra: 1 }), /dashboard\.notes.*extra/);
  assert.match(errs([]), /dashboard\.notes: must be an object/);
  assert.match(errs('on'), /dashboard\.notes: must be an object/);
});

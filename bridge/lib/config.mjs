/**
 * Loads and validates the watcher config. Validation collects every problem with
 * its JSON path, instead of stopping at the first one.
 *
 * `parseConfig` returns `{config, errors, warnings}` (warnings never fail validation). On success `errors` is empty and
 * `config` is the normalised object (defaults filled in, symbols upper-cased,
 * `state_dir` expanded, and `streams` listed). On failure `config` is null.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as v from './validate.mjs';
import { RULE_TYPES, barsNeeded, normalizeRule, ruleExpired, validateRuleParams } from './rules.mjs';
import { CANDLE_COUNT } from './stream.mjs';
import { DEFAULT_US_EARLY_CLOSES, DEFAULT_US_HOLIDAYS } from './scanner.mjs';

/** Timeframes the watcher accepts (a narrower set than the library's). */
export const WATCH_TIMEFRAMES = Object.freeze(['1', '3', '5', '15', '30', '45', '60', '120', '180', '240', 'D', 'W', 'M']);
export const CRYPTO_EXCHANGES = Object.freeze([
  'BINANCE', 'BYBIT', 'COINBASE', 'KUCOIN', 'OKX', 'BITGET', 'MEXC', 'GATEIO', 'HUOBI', 'BITFINEX', 'KRAKEN', 'BITSTAMP',
]);
/** Exchanges whose stocks follow US regular hours. Any other `stock` gets a warning. */
export const US_EXCHANGES = Object.freeze(['NYSE', 'NASDAQ', 'AMEX', 'CBOE', 'ARCA']);
export const MARKETS = Object.freeze(['crypto', 'stock']);
export const HOTLIST_KINDS = Object.freeze(['gainers', 'losers', 'mostActive', 'volumeGainers']);
/** Hard cap on symbol x timeframe streams. The limits.max_streams setting can only go lower. */
export const HARD_MAX_STREAMS = 25;
export const MIN_TREND_EVERY_MINUTES = 5;
const MAX_TOP_N = 200;
const DEFAULT_STATE_DIR = '~/.local/state/tradingview-watcher';
const RULE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes after midnight for "HH:MM", or null when the text is not in that form. */
export function parseHHMM(value) {
  if (typeof value !== 'string') return null;
  const match = HHMM.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** `crypto` for known crypto exchange prefixes, otherwise `stock`. */
export function inferMarket(symbol) {
  const exchange = symbol.includes(':') ? symbol.split(':')[0].toUpperCase() : '';
  return CRYPTO_EXCHANGES.includes(exchange) ? 'crypto' : 'stock';
}

/** Expands a leading `~` to the home directory. */
export function expandHome(path, home = homedir()) {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

export function isValidTimezone(zone) {
  if (typeof zone !== 'string' || zone === '') return false;
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Reports unknown keys, so a typo never silently does nothing. */
function checkKeys(object, allowed, path, errors) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key}: unknown key`);
  }
}

function readNumber(object, key, path, errors, { min, max, integer = false, exclusiveMin = false, fallback }) {
  const value = object[key];
  if (value === undefined) return fallback;
  const where = `${path}.${key}`;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${where}: must be a number`);
    return fallback;
  }
  if (integer && !Number.isSafeInteger(value)) {
    errors.push(`${where}: must be an integer`);
    return fallback;
  }
  if (exclusiveMin ? value <= min : value < min) {
    errors.push(`${where}: must be ${exclusiveMin ? 'greater than' : 'at least'} ${min}`);
    return fallback;
  }
  if (value > max) {
    errors.push(`${where}: must be at most ${max}`);
    return fallback;
  }
  return value;
}

function readBoolean(object, key, path, errors, fallback) {
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    errors.push(`${path}.${key}: must be true or false`);
    return fallback;
  }
  return value;
}

function readHHMM(value, path, errors) {
  if (value === undefined) return undefined;
  const minutes = parseHHMM(value);
  if (minutes === null) errors.push(`${path}: must be HH:MM (24-hour)`);
  return minutes === null ? undefined : value;
}

function parseWatchlist(input, errors, warnings) {
  if (!Array.isArray(input.watchlist)) {
    errors.push('watchlist: must be an array');
    return [];
  }
  const seen = new Set();
  const entries = [];
  input.watchlist.forEach((raw, index) => {
    const path = `watchlist[${index}]`;
    if (!isPlainObject(raw)) {
      errors.push(`${path}: must be an object`);
      return;
    }
    checkKeys(raw, ['symbol', 'timeframes', 'market'], path, errors);

    // An invalid symbol is reported, but the rest of the entry is still checked.
    let symbol = null;
    try {
      symbol = v.symbol(raw.symbol, `${path}.symbol`);
    } catch {
      errors.push(`${path}.symbol: is not a valid symbol`);
    }
    if (symbol !== null && seen.has(symbol)) {
      errors.push(`${path}.symbol: ${symbol} is listed more than once`);
      symbol = null;
    } else if (symbol !== null) {
      seen.add(symbol);
    }

    let timeframes = [];
    if (!Array.isArray(raw.timeframes) || raw.timeframes.length < 1 || raw.timeframes.length > WATCH_TIMEFRAMES.length) {
      errors.push(`${path}.timeframes: must be a list of 1 to ${WATCH_TIMEFRAMES.length} timeframes`);
    } else {
      raw.timeframes.forEach((tf, tfIndex) => {
        if (!WATCH_TIMEFRAMES.includes(tf)) {
          errors.push(`${path}.timeframes[${tfIndex}]: "${String(tf)}" is not an allowed timeframe`);
        } else if (!timeframes.includes(tf)) {
          timeframes.push(tf);
        }
      });
    }

    let market = symbol === null ? 'stock' : inferMarket(symbol);
    if (raw.market !== undefined) {
      if (MARKETS.includes(raw.market)) market = raw.market;
      else errors.push(`${path}.market: must be "crypto" or "stock"`);
    }
    if (symbol !== null) {
      entries.push({ symbol, timeframes, market });
      const exchange = symbol.includes(':') ? symbol.split(':')[0] : '';
      if (market === 'stock' && !US_EXCHANGES.includes(exchange)) {
        warnings.push(`${path}.symbol: ${symbol} is a stock outside ${US_EXCHANGES.join('/')}; sessions assume US hours`);
      }
    }
  });
  return entries;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written YYYY-MM-DD (rejects 2026-02-30). */
function isCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseRules(input, watchlist, errors, warnings, { timezone, now }) {
  if (input.rules === undefined) return [];
  if (!Array.isArray(input.rules)) {
    errors.push('rules: must be an array');
    return [];
  }
  const ids = new Set();
  const rules = [];
  input.rules.forEach((raw, index) => {
    const path = `rules[${index}]`;
    if (!isPlainObject(raw)) {
      errors.push(`${path}: must be an object`);
      return;
    }
    const before = errors.length;
    const allowed = ['id', 'type', 'symbol', 'timeframes', 'bars', 'threshold_pct', 'multiple', 'lookback',
      'period', 'levels', 'stddev', 'level', 'max_per_day', 'expires'];
    checkKeys(raw, allowed, path, errors);

    if (typeof raw.id !== 'string' || !RULE_ID.test(raw.id)) {
      errors.push(`${path}.id: must be 1 to 64 letters, digits, "-" or "_"`);
    } else if (raw.id === '__proto__') {
      // Used as an object key for the daily counter, where this name would set the prototype instead.
      errors.push(`${path}.id: "__proto__" is reserved, pick another id`);
    } else if (ids.has(raw.id)) {
      errors.push(`${path}.id: "${raw.id}" is already used by another rule`);
    } else {
      ids.add(raw.id);
    }
    if (!RULE_TYPES.includes(raw.type)) {
      errors.push(`${path}.type: must be one of ${RULE_TYPES.join(', ')}`);
    }

    let symbol;
    if (raw.symbol !== undefined) {
      try {
        symbol = v.symbol(raw.symbol, `${path}.symbol`);
        if (!watchlist.some((entry) => entry.symbol === symbol)) {
          errors.push(`${path}.symbol: ${symbol} is not in the watchlist`);
        }
      } catch {
        errors.push(`${path}.symbol: is not a valid symbol`);
      }
    }

    let timeframes;
    if (raw.timeframes !== undefined) {
      if (!Array.isArray(raw.timeframes) || raw.timeframes.length === 0) {
        errors.push(`${path}.timeframes: must be a non-empty list`);
      } else {
        raw.timeframes.forEach((tf, tfIndex) => {
          if (!WATCH_TIMEFRAMES.includes(tf)) {
            errors.push(`${path}.timeframes[${tfIndex}]: "${String(tf)}" is not an allowed timeframe`);
          }
        });
        timeframes = [...new Set(raw.timeframes)];
      }
    }

    if (RULE_TYPES.includes(raw.type)) {
      errors.push(...validateRuleParams(raw, path));
    }
    readNumber(raw, 'max_per_day', path, errors, { min: 1, max: 1000, integer: true });
    if (raw.expires !== undefined && !isCalendarDate(raw.expires)) {
      errors.push(`${path}.expires: must be a date like 2026-12-31 (YYYY-MM-DD)`);
    }

    // A rule that can never match is a config mistake, so report it.
    if (errors.length === before && RULE_TYPES.includes(raw.type)) {
      const matches = watchlist.some((entry) => (symbol === undefined || entry.symbol === symbol)
        && (timeframes === undefined || entry.timeframes.some((tf) => timeframes.includes(tf))));
      if (!matches) errors.push(`${path}: matches no watched symbol and timeframe`);
      const rule = { ...raw, symbol, timeframes };
      const normalized = normalizeRule(Object.fromEntries(Object.entries(rule).filter(([, value]) => value !== undefined)));
      // Each stream keeps CANDLE_COUNT bars. A rule that needs more could never fire.
      const needed = barsNeeded(normalized);
      if (needed > CANDLE_COUNT) {
        errors.push(`${path}: needs ${needed} closed bars but the watcher keeps only ${CANDLE_COUNT} per stream`);
      }
      // Only a warning: an expired rule is harmless, and the watcher skips it.
      if (timezone !== null && ruleExpired(normalized, now, timezone)) {
        warnings.push(`${path} "${raw.id}": expired on ${raw.expires}, so it will never fire`);
      }
      rules.push(normalized);
    }
  });
  return rules;
}

function parseTrending(input, errors) {
  const path = 'trending';
  const defaults = {
    enabled: false,
    every_minutes: 10,
    markets: ['crypto', 'america'],
    kinds: ['gainers', 'volumeGainers'],
    top_n: 15,
    us_regular_hours_only: true,
    remember_hours: 6,
  };
  if (input.trending === undefined) return defaults;
  if (!isPlainObject(input.trending)) {
    errors.push(`${path}: must be an object`);
    return defaults;
  }
  const t = input.trending;
  checkKeys(t, Object.keys(defaults), path, errors);

  const everyMinutes = readNumber(t, 'every_minutes', path, errors, {
    min: MIN_TREND_EVERY_MINUTES, max: 1440, fallback: defaults.every_minutes,
  });
  const topN = readNumber(t, 'top_n', path, errors, {
    min: 1, max: MAX_TOP_N, integer: true, fallback: defaults.top_n,
  });
  const rememberHours = readNumber(t, 'remember_hours', path, errors, {
    min: 0, max: 168, exclusiveMin: true, fallback: defaults.remember_hours,
  });

  let markets = defaults.markets;
  if (t.markets !== undefined) {
    if (!Array.isArray(t.markets) || t.markets.length < 1 || t.markets.length > 10) {
      errors.push(`${path}.markets: must be a list of 1 to 10 market names`);
    } else {
      markets = [];
      t.markets.forEach((name, index) => {
        try {
          markets.push(v.market(name, `${path}.markets[${index}]`));
        } catch {
          errors.push(`${path}.markets[${index}]: is not a valid market name`);
        }
      });
    }
  }

  let kinds = defaults.kinds;
  if (t.kinds !== undefined) {
    if (!Array.isArray(t.kinds) || t.kinds.length < 1) {
      errors.push(`${path}.kinds: must be a non-empty list`);
    } else {
      kinds = [];
      t.kinds.forEach((kind, index) => {
        if (HOTLIST_KINDS.includes(kind)) kinds.push(kind);
        else errors.push(`${path}.kinds[${index}]: must be one of ${HOTLIST_KINDS.join(', ')}`);
      });
    }
  }

  return {
    enabled: readBoolean(t, 'enabled', path, errors, defaults.enabled),
    every_minutes: everyMinutes,
    markets: [...new Set(markets)],
    kinds: [...new Set(kinds)],
    top_n: topN,
    us_regular_hours_only: readBoolean(t, 'us_regular_hours_only', path, errors, defaults.us_regular_hours_only),
    remember_hours: rememberHours,
  };
}

function parseAlerts(input, errors) {
  const path = 'alerts';
  const defaults = {
    cooldown_minutes: 60,
    max_per_hour: 20,
    quiet_hours: null,
    digest_after_quiet: true,
  };
  if (input.alerts === undefined) return defaults;
  if (!isPlainObject(input.alerts)) {
    errors.push(`${path}: must be an object`);
    return defaults;
  }
  const a = input.alerts;
  checkKeys(a, Object.keys(defaults), path, errors);

  let quiet = null;
  if (a.quiet_hours !== undefined && a.quiet_hours !== null) {
    const q = a.quiet_hours;
    if (!isPlainObject(q)) {
      errors.push(`${path}.quiet_hours: must be an object with start and end`);
    } else {
      checkKeys(q, ['start', 'end'], `${path}.quiet_hours`, errors);
      const start = readHHMM(q.start, `${path}.quiet_hours.start`, errors);
      const end = readHHMM(q.end, `${path}.quiet_hours.end`, errors);
      if (start === undefined || end === undefined) {
        if (q.start === undefined) errors.push(`${path}.quiet_hours.start: is required`);
        if (q.end === undefined) errors.push(`${path}.quiet_hours.end: is required`);
      } else if (start === end) {
        errors.push(`${path}.quiet_hours: start and end must differ`);
      } else {
        quiet = { start, end };
      }
    }
  }

  return {
    cooldown_minutes: readNumber(a, 'cooldown_minutes', path, errors, { min: 0, max: 1440, fallback: 60 }),
    max_per_hour: readNumber(a, 'max_per_hour', path, errors, { min: 1, max: 1000, integer: true, fallback: 20 }),
    quiet_hours: quiet === null ? null : { start: a.quiet_hours.start, end: a.quiet_hours.end },
    digest_after_quiet: readBoolean(a, 'digest_after_quiet', path, errors, true),
  };
}

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function readDateList(object, key, path, errors, fallback) {
  const value = object[key];
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length > 400) {
    errors.push(`${path}.${key}: must be a list of YYYY-MM-DD dates`);
    return [...fallback];
  }
  const out = [];
  value.forEach((date, index) => {
    if (typeof date !== 'string' || !ISO_DATE.test(date)) errors.push(`${path}.${key}[${index}]: must be YYYY-MM-DD`);
    else if (!out.includes(date)) out.push(date);
  });
  return out;
}

function parseHealth(input, errors) {
  const path = 'health';
  const defaults = {
    stream_down_minutes: 10,
    stock_stream_down_minutes: 30,
    daily_heartbeat: '08:00',
    us_holidays: [...DEFAULT_US_HOLIDAYS],
    us_early_closes: [...DEFAULT_US_EARLY_CLOSES],
  };
  if (input.health === undefined) return defaults;
  if (!isPlainObject(input.health)) {
    errors.push(`${path}: must be an object`);
    return defaults;
  }
  const h = input.health;
  checkKeys(h, Object.keys(defaults), path, errors);
  let heartbeat = defaults.daily_heartbeat;
  if (h.daily_heartbeat === null) heartbeat = null;
  else if (h.daily_heartbeat !== undefined) heartbeat = readHHMM(h.daily_heartbeat, `${path}.daily_heartbeat`, errors) ?? defaults.daily_heartbeat;
  return {
    stream_down_minutes: readNumber(h, 'stream_down_minutes', path, errors, {
      min: 0, max: 1440, exclusiveMin: true, fallback: 10,
    }),
    stock_stream_down_minutes: readNumber(h, 'stock_stream_down_minutes', path, errors, {
      min: 0, max: 1440, exclusiveMin: true, fallback: 30,
    }),
    daily_heartbeat: heartbeat,
    us_holidays: readDateList(h, 'us_holidays', path, errors, defaults.us_holidays),
    us_early_closes: readDateList(h, 'us_early_closes', path, errors, defaults.us_early_closes),
  };
}

function parseLocalApi(input, errors) {
  const path = 'local_api';
  const defaults = { enabled: true, port: 8787 };
  if (input.local_api === undefined) return defaults;
  if (!isPlainObject(input.local_api)) {
    errors.push(`${path}: must be an object`);
    return defaults;
  }
  const l = input.local_api;
  checkKeys(l, ['enabled', 'port'], path, errors);
  return {
    enabled: readBoolean(l, 'enabled', path, errors, true),
    port: readNumber(l, 'port', path, errors, { min: 1024, max: 65535, integer: true, fallback: 8787 }),
  };
}

/**
 * Validates a parsed config object. Returns `{config, errors}`; see the module
 * comment for the shape.
 */
export function parseConfig(input, { home = homedir(), now = Date.now() } = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(input)) {
    return { config: null, errors: ['$: the config must be a JSON object'], warnings };
  }
  checkKeys(input, [
    'timezone', 'watchlist', 'rules', 'trending', 'alerts', 'health', 'state_dir', 'local_api', 'limits',
  ], '$', errors);

  const timezone = input.timezone ?? 'UTC';
  if (!isValidTimezone(timezone)) errors.push('timezone: is not a valid IANA timezone name');

  const watchlist = parseWatchlist(input, errors, warnings);
  const streams = [];
  const streamKeys = new Set();
  for (const entry of watchlist) {
    for (const timeframe of entry.timeframes) {
      streams.push({ key: `${entry.symbol}|${timeframe}`, symbol: entry.symbol, timeframe, market: entry.market });
      streamKeys.add(`${entry.symbol}|${timeframe}`);
    }
  }

  const rules = parseRules(input, watchlist, errors, warnings, { timezone: isValidTimezone(timezone) ? timezone : null, now });
  const trending = parseTrending(input, errors);
  const alerts = parseAlerts(input, errors);
  const health = parseHealth(input, errors);
  const localApi = parseLocalApi(input, errors);

  let stateDir = DEFAULT_STATE_DIR;
  if (input.state_dir !== undefined) {
    if (typeof input.state_dir !== 'string' || input.state_dir.trim() === '') {
      errors.push('state_dir: must be a non-empty path');
    } else {
      stateDir = input.state_dir;
    }
  }

  const limitsDefault = { max_streams: HARD_MAX_STREAMS };
  let limits = limitsDefault;
  if (input.limits !== undefined) {
    if (!isPlainObject(input.limits)) {
      errors.push('limits: must be an object');
    } else {
      checkKeys(input.limits, ['max_streams'], 'limits', errors);
      limits = {
        max_streams: readNumber(input.limits, 'max_streams', 'limits', errors, {
          min: 1, max: HARD_MAX_STREAMS, integer: true, fallback: HARD_MAX_STREAMS,
        }),
      };
    }
  }
  if (streams.length > limits.max_streams) {
    errors.push(`watchlist: ${streams.length} symbol x timeframe streams exceed limits.max_streams (${limits.max_streams}; hard cap ${HARD_MAX_STREAMS})`);
  }

  if (errors.length > 0) return { config: null, errors, warnings };

  const config = {
    timezone,
    watchlist,
    streams,
    rules,
    trending,
    alerts,
    health,
    state_dir: expandHome(stateDir, home),
    local_api: localApi,
    limits,
  };
  return { config, errors: [], warnings };
}

/** Reads and validates a config file. Problems come back in `errors`, never thrown. */
export async function loadConfig(path, { home = homedir() } = {}) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    return { config: null, errors: [`${path}: cannot read the config file (${err.code ?? 'read error'})`], warnings: [] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { config: null, errors: [`${path}: the file is not valid JSON`], warnings: [] };
  }
  return parseConfig(raw, { home });
}

const DISCORD_URL = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/;
const TELEGRAM_TOKEN = /^\d+:[A-Za-z0-9_-]+$/;

/** True for a Discord webhook URL. The value is never echoed. */
export function isDiscordWebhookUrl(value) {
  return typeof value === 'string' && DISCORD_URL.test(value);
}

/** True for a Telegram bot token in the form <number>:<token>. */
export function isTelegramToken(value) {
  return typeof value === 'string' && TELEGRAM_TOKEN.test(value);
}

/**
 * Checks the secret environment variables: their shape only, never their values.
 * Returns `{errors, warnings}` (plain strings).
 */
export function checkEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const has = (name) => typeof env[name] === 'string' && env[name] !== '';

  if (has('DISCORD_WEBHOOK_URL') && !isDiscordWebhookUrl(env.DISCORD_WEBHOOK_URL)) {
    errors.push('DISCORD_WEBHOOK_URL is set but is not a Discord webhook URL');
  }
  if (has('TELEGRAM_BOT_TOKEN') && !isTelegramToken(env.TELEGRAM_BOT_TOKEN)) {
    errors.push('TELEGRAM_BOT_TOKEN is set but is not in the form <number>:<token>');
  }
  if (has('TELEGRAM_BOT_TOKEN') !== has('TELEGRAM_CHAT_ID')) {
    warnings.push('Telegram needs both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; Telegram is disabled');
  }
  if (has('TRADINGVIEW_SESSION_ID') !== has('TRADINGVIEW_SESSION_SIGN')) {
    warnings.push('TradingView login needs both TRADINGVIEW_SESSION_ID and TRADINGVIEW_SESSION_SIGN; running anonymous');
  }
  const channels = isDiscordWebhookUrl(env.DISCORD_WEBHOOK_URL)
    || (isTelegramToken(env.TELEGRAM_BOT_TOKEN) && has('TELEGRAM_CHAT_ID'));
  if (!channels) warnings.push('no notification channel is configured; alerts are only logged');
  if (!has('WATCHER_LOCAL_TOKEN')) warnings.push('WATCHER_LOCAL_TOKEN is not set; the local API stays disabled');
  return { errors, warnings };
}

/**
 * Rule types and their evaluation. Every rule runs on CLOSED bars only: the
 * caller passes candles that end at the bar that just closed (the forming bar is
 * never included). A rule that lacks enough bars gives no hit.
 *
 * Each hit: {ruleId, type, symbol, timeframe, barTime, direction, values, message}.
 */
import { localDate } from './format.mjs';
import { bollinger, rsi } from './indicators.mjs';

const int = (min, max) => ({ kind: 'int', min, max });
const num = (min, max, { exclusiveMin = false } = {}) => ({ kind: 'number', min, max, exclusiveMin });
const numList = (minItems, maxItems, min, max) => ({ kind: 'numberList', minItems, maxItems, min, max });
const idList = (minItems, maxItems) => ({ kind: 'idList', minItems, maxItems });

export const RULE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Parameter specs per rule type. `required: false` params take the default.
 * all_of / any_of combine other rules: the config resolves their ids into `members` (plain rules only, one level).
 * Ranges are the "sensible" bounds checked by config validation.
 */
export const RULE_SPECS = Object.freeze({
  pct_move: {
    params: {
      bars: { ...int(1, 500), required: true },
      threshold_pct: { ...num(0, 100, { exclusiveMin: true }), required: true },
    },
  },
  volume_spike: {
    params: {
      multiple: { ...num(0, 1000, { exclusiveMin: true }), required: true },
      lookback: { ...int(1, 500), default: 20 },
    },
  },
  rsi_cross: {
    params: {
      period: { ...int(2, 200), default: 14 },
      levels: { ...numList(1, 5, 0, 100), default: [30, 70] },
    },
  },
  bollinger_break: {
    params: {
      period: { ...int(2, 500), default: 20 },
      stddev: { ...num(0, 10, { exclusiveMin: true }), default: 2 },
    },
  },
  new_extreme: {
    params: {
      lookback: { ...int(1, 500), default: 50 },
    },
  },
  price_cross: {
    params: {
      level: { ...num(0, Number.MAX_SAFE_INTEGER, { exclusiveMin: true }), required: true },
    },
  },
  all_of: { params: { rules: { ...idList(2, 10), required: true } } },
  any_of: { params: { rules: { ...idList(2, 10), required: true } } },
});

export const isComposite = (rule) => rule.type === 'all_of' || rule.type === 'any_of';

export const RULE_TYPES = Object.freeze(Object.keys(RULE_SPECS));

function checkValue(spec, value, path) {
  if (spec.kind === 'int') {
    if (!Number.isSafeInteger(value)) return `${path}: must be an integer`;
    if (value < spec.min || value > spec.max) return `${path}: must be between ${spec.min} and ${spec.max}`;
    return null;
  }
  if (spec.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${path}: must be a number`;
    if (spec.exclusiveMin ? value <= spec.min : value < spec.min) {
      return `${path}: must be ${spec.exclusiveMin ? 'greater than' : 'at least'} ${spec.min}`;
    }
    if (value > spec.max) return `${path}: must be at most ${spec.max}`;
    return null;
  }
  if (spec.kind === 'numberList') {
    if (!Array.isArray(value)) return `${path}: must be an array of numbers`;
    if (value.length < spec.minItems || value.length > spec.maxItems) {
      return `${path}: must have ${spec.minItems} to ${spec.maxItems} items`;
    }
    for (let i = 0; i < value.length; i += 1) {
      const message = checkValue({ kind: 'number', min: spec.min, max: spec.max }, value[i], `${path}[${i}]`);
      if (message) return message;
    }
    return null;
  }
  if (spec.kind === 'idList') {
    if (!Array.isArray(value) || value.length < spec.minItems || value.length > spec.maxItems) {
      return `${path}: must be a list of ${spec.minItems} to ${spec.maxItems} rule ids`;
    }
    const bad = value.findIndex((id) => typeof id !== 'string' || !RULE_ID.test(id));
    if (bad !== -1) return `${path}[${bad}]: must be a rule id (1 to 64 letters, digits, "-" or "_")`;
    if (new Set(value).size !== value.length) return `${path}: must not repeat an id`;
    return null;
  }
  return `${path}: unknown parameter type`;
}

/**
 * Checks one rule's type and parameters. Returns a list of problem strings, each
 * prefixed with its JSON path. Defaults are not applied here (see normalizeRule).
 */
export function validateRuleParams(rule, path) {
  const errors = [];
  const spec = RULE_SPECS[rule.type];
  if (!spec) return [`${path}.type: unknown rule type`];
  for (const [name, param] of Object.entries(spec.params)) {
    const value = rule[name];
    const where = `${path}.${name}`;
    if (value === undefined) {
      if (param.required) errors.push(`${where}: is required`);
      continue;
    }
    const message = checkValue(param, value, where);
    if (message) errors.push(message);
  }
  return errors;
}

/**
 * True once the rule's last day (`expires`, YYYY-MM-DD) is over in `timezone`.
 * Zero-padded dates sort the same as calendar order, so a string compare is enough.
 */
export function ruleExpired(rule, nowMs, timezone) {
  return rule.expires !== undefined && localDate(nowMs, timezone) > rule.expires;
}

/** Fills in defaults for optional parameters. Returns a new object. */
export function normalizeRule(rule) {
  const spec = RULE_SPECS[rule.type];
  const out = { ...rule };
  if (!spec) return out;
  for (const [name, param] of Object.entries(spec.params)) {
    if (out[name] === undefined && param.default !== undefined) {
      out[name] = Array.isArray(param.default) ? [...param.default] : param.default;
    }
  }
  return out;
}

/** Closed bars a rule needs before it can fire (the same minimums the evaluators check). */
export function barsNeeded(rule) {
  switch (rule.type) {
    case 'pct_move': return rule.bars + 1;
    case 'volume_spike': return rule.lookback + 1;
    case 'rsi_cross': return rule.period + 2;
    case 'bollinger_break': return rule.period;
    case 'new_extreme': return rule.lookback + 1;
    case 'price_cross': return 2;
    default: return 0;
  }
}

const round = (value, digits = 4) => Number(value.toFixed(digits));

function pctMove(rule, c) {
  const n = c.length;
  const bars = rule.bars;
  if (n < bars + 1) return null;
  const last = c[n - 1];
  const ref = c[n - 1 - bars];
  if (!(ref.close > 0)) return null;
  const pct = ((last.close - ref.close) / ref.close) * 100;
  if (Math.abs(pct) < rule.threshold_pct) return null;
  const direction = pct >= 0 ? 'up' : 'down';
  return {
    direction,
    values: { pct: round(pct, 3), close: last.close, ref_close: ref.close, bars },
    message: `${direction === 'up' ? 'Up' : 'Down'} ${Math.abs(pct).toFixed(2)}% over ${bars} bar${bars === 1 ? '' : 's'}`,
  };
}

function volumeSpike(rule, c) {
  const n = c.length;
  const lookback = rule.lookback;
  if (n < lookback + 1) return null;
  let total = 0;
  for (let i = n - 1 - lookback; i < n - 1; i += 1) total += c[i].volume;
  const average = total / lookback;
  if (!(average > 0)) return null;
  const last = c[n - 1];
  if (last.volume < rule.multiple * average) return null;
  return {
    direction: last.close >= last.open ? 'up' : 'down',
    values: { volume: last.volume, avg_volume: round(average, 2), multiple: round(last.volume / average, 2) },
    message: `Volume ${(last.volume / average).toFixed(1)}x the average of the prior ${lookback} bars`,
  };
}

function rsiCross(rule, c) {
  const n = c.length;
  if (n < rule.period + 2) return null;
  const values = rsi(c.map((bar) => bar.close), rule.period);
  const prev = values[n - 2];
  const cur = values[n - 1];
  if (prev === null || cur === null) return null;
  const direction = cur > prev ? 'up' : 'down';
  // One price move can cross several levels, but all of them go the same way.
  const crossed = rule.levels.filter((level) => (
    direction === 'up' ? prev < level && cur >= level : prev >= level && cur < level
  ));
  if (crossed.length === 0) return null;
  return {
    direction,
    values: { rsi: round(cur, 2), prev_rsi: round(prev, 2), levels: crossed },
    message: `RSI ${direction === 'up' ? 'rose through' : 'fell through'} ${crossed.join(', ')} (now ${round(cur, 1)})`,
  };
}

function bollingerBreak(rule, c) {
  const n = c.length;
  if (n < rule.period) return null;
  const bands = bollinger(c.map((bar) => bar.close), rule.period, rule.stddev);
  const upper = bands.upper[n - 1];
  const lower = bands.lower[n - 1];
  const close = c[n - 1].close;
  if (upper === null || lower === null) return null;
  let direction = null;
  if (close > upper) direction = 'up';
  else if (close < lower) direction = 'down';
  if (direction === null) return null;
  return {
    direction,
    values: { close, upper: round(upper), middle: round(bands.middle[n - 1]), lower: round(lower) },
    message: `Close ${direction === 'up' ? 'above upper' : 'below lower'} Bollinger band (${rule.period}, ${rule.stddev})`,
  };
}

function newExtreme(rule, c) {
  const n = c.length;
  const lookback = rule.lookback;
  if (n < lookback + 1) return null;
  let high = -Infinity;
  let low = Infinity;
  for (let i = n - 1 - lookback; i < n - 1; i += 1) {
    if (c[i].high > high) high = c[i].high;
    if (c[i].low < low) low = c[i].low;
  }
  const close = c[n - 1].close;
  if (close > high) {
    return { direction: 'up', values: { close, prior_high: high }, message: `New ${lookback}-bar high` };
  }
  if (close < low) {
    return { direction: 'down', values: { close, prior_low: low }, message: `New ${lookback}-bar low` };
  }
  return null;
}

function priceCross(rule, c) {
  const n = c.length;
  if (n < 2) return null;
  const prev = c[n - 2].close;
  const cur = c[n - 1].close;
  const level = rule.level;
  let direction = null;
  if (prev < level && cur >= level) direction = 'up';
  else if (prev >= level && cur < level) direction = 'down';
  if (direction === null) return null;
  return {
    direction,
    values: { close: cur, prev_close: prev, level },
    message: `Crossed ${level} ${direction === 'up' ? 'upward' : 'downward'}`,
  };
}

const EVALUATORS = Object.freeze({
  pct_move: pctMove,
  volume_spike: volumeSpike,
  rsi_cross: rsiCross,
  bollinger_break: bollingerBreak,
  new_extreme: newExtreme,
  price_cross: priceCross,
});

/** True when a rule applies to the stream (symbol and timeframes filters). */
export function ruleApplies(rule, stream) {
  if (rule.symbol !== undefined && rule.symbol !== stream.symbol) return false;
  if (rule.timeframes !== undefined && !rule.timeframes.includes(stream.timeframe)) return false;
  return true;
}

/**
 * all_of / any_of: runs the member rules on the same closed bar and groups their hits by direction.
 * any_of gives one result per direction with a hit. all_of gives one only if every member hits
 * the stream and all hit in that direction (members in opposite directions disagree, so no result;
 * a member that does not apply to the stream cannot hit, so it also blocks all_of).
 * Messages are joined `ruleId: message`, and each value is named `ruleId.valueName`.
 */
function evaluateComposite(rule, stream, closedCandles) {
  const members = rule.members ?? [];
  const hits = evaluateRules(members, stream, closedCandles);
  const results = [];
  for (const direction of new Set(hits.map((hit) => hit.direction))) {
    const group = hits.filter((hit) => hit.direction === direction);
    if (rule.type === 'all_of' && group.length !== members.length) continue;
    results.push({
      direction,
      values: Object.fromEntries(group.flatMap((hit) => Object.entries(hit.values ?? {}).map(([name, value]) => [`${hit.ruleId}.${name}`, value]))),
      message: group.map((hit) => `${hit.ruleId}: ${hit.message}`).join(' | '),
    });
  }
  return results;
}

/**
 * Evaluates every applicable rule on one stream. `closedCandles` must end at the
 * bar that just closed. Returns an array of hits (possibly empty).
 */
export function evaluateRules(rules, stream, closedCandles) {
  const hits = [];
  if (!Array.isArray(closedCandles) || closedCandles.length === 0) return hits;
  for (const raw of rules) {
    if (!ruleApplies(raw, stream)) continue;
    const evaluate = EVALUATORS[raw.type];
    if (!evaluate && !isComposite(raw)) continue;
    const rule = normalizeRule(raw);
    const results = isComposite(rule) ? evaluateComposite(rule, stream, closedCandles) : [evaluate(rule, closedCandles)];
    for (const result of results) {
      if (result === null) continue;
      hits.push({
        ruleId: rule.id,
        type: rule.type,
        symbol: stream.symbol,
        timeframe: stream.timeframe,
        barTime: closedCandles[closedCandles.length - 1].time,
        direction: result.direction,
        values: result.values,
        message: result.message,
      });
    }
  }
  return hits;
}


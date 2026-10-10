import { BridgeValidationError } from './errors.mjs';

/** Timeframes accepted by the bridge (the library accepts more; we allow only these). */
export const TIMEFRAMES = new Set([
  '1', '3', '5', '15', '30', '45', '60', '120', '180', '240',
  'D', 'W', 'M', '1D', '1W', '1M',
]);

// Checked before upper-casing: toUpperCase() maps some non-ASCII letters (e.g. the
// German sharp s) to ASCII ones, which would let them through.
const SYMBOL_PATTERN = /^[A-Za-z0-9_.!:-]{1,40}$/;
// Same shape the library enforces for the scanner market, which becomes a URL path segment.
const MARKET_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const MAX_INPUT_DEPTH = 4;
const MAX_INPUT_KEYS = 100;
const MAX_INPUT_STRING = 1000;
const DEFAULT_TIMEOUT_MS = 15000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60000;

export function invalid(message) {
  return new BridgeValidationError(message);
}

/** True for values that mean "parameter not given". */
export function isAbsent(value) {
  return value === undefined || value === null;
}

/** Upper-cases and checks an exchange-qualified or bare symbol. */
export function symbol(value, name = 'symbol') {
  if (typeof value !== 'string') throw invalid(`${name} must be a string`);
  if (!SYMBOL_PATTERN.test(value)) throw invalid(`${name} is not a valid symbol`);
  return value.toUpperCase();
}

export function timeframe(value, name = 'timeframe') {
  if (typeof value !== 'string' || !TIMEFRAMES.has(value)) {
    throw invalid(`${name} is not a supported timeframe`);
  }
  return value;
}

export function integer(value, name, { min, max }) {
  if (!Number.isSafeInteger(value)) throw invalid(`${name} must be an integer`);
  if (value < min) throw invalid(`${name} must be at least ${min}`);
  if (value > max) throw invalid(`${name} must be at most ${max}`);
  return value;
}

export function string(value, name, { min, max }) {
  if (typeof value !== 'string') throw invalid(`${name} must be a string`);
  if (value.length < min || value.length > max) {
    throw invalid(`${name} must be ${min} to ${max} characters`);
  }
  return value;
}

export function array(value, name, { min, max }) {
  if (!Array.isArray(value)) throw invalid(`${name} must be an array`);
  if (value.length < min || value.length > max) {
    throw invalid(`${name} must have ${min} to ${max} items`);
  }
  return value;
}

/** A string that holds something other than whitespace. */
export function nonBlankString(value, name, { min = 1, max }) {
  string(value, name, { min, max });
  if (value.trim() === '') throw invalid(`${name} must not be blank`);
  return value;
}

/** A scanner market name such as `america` or `crypto`. */
export function market(value, name = 'market') {
  if (typeof value !== 'string' || !MARKET_PATTERN.test(value)) {
    throw invalid(`${name} is not a valid market name`);
  }
  return value;
}

/**
 * JSON-only data for the library (indicator inputs): plain objects and arrays,
 * strings, finite numbers, booleans and null, with bounded depth, size and no
 * `__proto__` keys.
 */
export function jsonData(value, name, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(`${name} must hold finite numbers`);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_INPUT_STRING) throw invalid(`${name} holds a string that is too long`);
    return value;
  }
  if (depth >= MAX_INPUT_DEPTH) throw invalid(`${name} is nested too deeply`);
  if (Array.isArray(value)) {
    if (value.length > MAX_INPUT_KEYS) throw invalid(`${name} holds a list that is too long`);
    value.forEach((item) => jsonData(item, name, depth + 1));
    return value;
  }
  plainObject(value, name);
  const keys = Object.keys(value);
  if (keys.length > MAX_INPUT_KEYS) throw invalid(`${name} has too many keys`);
  for (const key of keys) {
    if (key === '__proto__') throw invalid(`${name} has a forbidden key`);
    jsonData(value[key], name, depth + 1);
  }
  return value;
}

/** Accepts only plain objects (JSON objects), not arrays, null or class instances. */
export function plainObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${name} must be an object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw invalid(`${name} must be a plain object`);
  }
  return value;
}

/** A `[from, to]` pair with 0 <= from < to <= 200 (scanner page range). */
export function range(value, name = 'range') {
  array(value, name, { min: 2, max: 2 });
  const from = integer(value[0], name, { min: 0, max: 200 });
  const to = integer(value[1], name, { min: 0, max: 200 });
  if (!(from < to)) throw invalid(`${name} must have from < to`);
  return [from, to];
}

/** Optional timeout in ms: absent gives the default, a number is clamped to 1000..60000. */
export function timeoutMs(value) {
  if (isAbsent(value)) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid('timeoutMs must be a number');
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)));
}

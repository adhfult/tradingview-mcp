import { BridgeValidationError } from './errors.mjs';

/** Timeframes accepted by the bridge (the library accepts more; we allow only these). */
export const TIMEFRAMES = new Set([
  '1', '3', '5', '15', '30', '45', '60', '120', '180', '240',
  'D', 'W', 'M', '1D', '1W', '1M',
]);

const SYMBOL_PATTERN = /^[A-Z0-9_.!:-]{1,40}$/;
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
  const upper = value.toUpperCase();
  if (!SYMBOL_PATTERN.test(upper)) throw invalid(`${name} is not a valid symbol`);
  return upper;
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

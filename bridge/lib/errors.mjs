/** Error raised by the bridge itself when request parameters are invalid. */
export class BridgeValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BridgeValidationError';
    this.bridgeCode = 'INVALID_PARAMETER';
  }
}

const CODE_MAP = new Map([
  ['SYMBOL_ERROR', 'SYMBOL_NOT_FOUND'],
  ['NOT_FOUND', 'SYMBOL_NOT_FOUND'],
  ['TIMEOUT', 'TIMEOUT'],
  ['AUTH_ERROR', 'AUTH_FAILED'],
  ['SERIES_ERROR', 'PERMISSION_OR_SERIES'],
  ['STUDY_ERROR', 'PERMISSION_OR_SERIES'],
  ['CRITICAL_ERROR', 'PERMISSION_OR_SERIES'],
  ['CONNECTION_ERROR', 'UPSTREAM_UNAVAILABLE'],
  ['DISCONNECTED', 'UPSTREAM_UNAVAILABLE'],
  ['PROTOCOL_ERROR', 'UPSTREAM_UNAVAILABLE'],
  ['INVALID_ARGUMENT', 'INVALID_PARAMETER'],
  ['NO_DATA', 'NO_DATA'],
]);

const CONNECTION_CODES = new Set(['CONNECTION_ERROR', 'DISCONNECTED', 'PROTOCOL_ERROR']);

/** True when a library error code means the websocket connection is unusable. */
export function isConnectionError(code) {
  return CONNECTION_CODES.has(code);
}

/** Message text of any thrown value. */
export function errorMessage(err) {
  if (err !== null && typeof err === 'object' && typeof err.message === 'string') {
    return err.message;
  }
  return String(err);
}

function detailsText(details) {
  if (details === undefined || details === null) return '';
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details) ?? '';
  } catch {
    return '';
  }
}

/**
 * Maps any thrown value to a bridge error `{code, message}`. The message is
 * always passed through `redact`.
 */
export function toBridgeError(err, redact = (text) => text) {
  const message = redact(errorMessage(err));

  if (err !== null && typeof err === 'object' && typeof err.bridgeCode === 'string') {
    return { code: err.bridgeCode, message };
  }

  const libCode = err !== null && typeof err === 'object' ? err.code : undefined;

  if (libCode === 'HTTP_ERROR') {
    const text = `${errorMessage(err)} ${detailsText(err.details)}`;
    return { code: /\b429\b/.test(text) ? 'RATE_LIMITED' : 'UPSTREAM_ERROR', message };
  }

  return { code: CODE_MAP.get(libCode) ?? 'UPSTREAM_ERROR', message };
}

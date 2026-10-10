import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeValidationError, isConnectionError, toBridgeError } from '../lib/errors.mjs';

const libError = (code, message = 'failure', details) =>
  Object.assign(new Error(message), details === undefined ? { code } : { code, details });

test('every row of the error mapping table', () => {
  const rows = [
    [libError('SYMBOL_ERROR'), 'SYMBOL_NOT_FOUND'],
    [libError('NOT_FOUND'), 'SYMBOL_NOT_FOUND'],
    [libError('TIMEOUT'), 'TIMEOUT'],
    [libError('AUTH_ERROR'), 'AUTH_FAILED'],
    [libError('SERIES_ERROR'), 'PERMISSION_OR_SERIES'],
    [libError('STUDY_ERROR'), 'PERMISSION_OR_SERIES'],
    [libError('CRITICAL_ERROR'), 'PERMISSION_OR_SERIES'],
    [libError('HTTP_ERROR', 'HTTP 429 Too Many Requests'), 'RATE_LIMITED'],
    [libError('HTTP_ERROR', 'request failed', { status: 429 }), 'RATE_LIMITED'],
    [libError('HTTP_ERROR', 'HTTP 500'), 'UPSTREAM_ERROR'],
    [libError('CONNECTION_ERROR'), 'UPSTREAM_UNAVAILABLE'],
    [libError('DISCONNECTED'), 'UPSTREAM_UNAVAILABLE'],
    [libError('PROTOCOL_ERROR'), 'UPSTREAM_UNAVAILABLE'],
    [libError('INVALID_ARGUMENT'), 'INVALID_PARAMETER'],
    [libError('NO_DATA'), 'NO_DATA'],
    [new BridgeValidationError('count must be an integer'), 'INVALID_PARAMETER'],
    [libError('PARSE_ERROR'), 'UPSTREAM_ERROR'],
    [libError('ABORTED'), 'UPSTREAM_ERROR'],
    [libError('SOMETHING_NEW'), 'UPSTREAM_ERROR'],
    [new Error('no code at all'), 'UPSTREAM_ERROR'],
    ['a thrown string', 'UPSTREAM_ERROR'],
  ];
  for (const [err, expected] of rows) {
    assert.equal(toBridgeError(err).code, expected, `mapping for ${String(err.message ?? err)}`);
  }
});

test('the message passes through the redactor', () => {
  const redact = (text) => text.replace('secret-value', '[X]');
  const out = toBridgeError(libError('AUTH_ERROR', 'bad secret-value'), redact);
  assert.deepEqual(out, { code: 'AUTH_FAILED', message: 'bad [X]' });
});

test('isConnectionError is true only for the three connection codes', () => {
  for (const code of ['CONNECTION_ERROR', 'DISCONNECTED', 'PROTOCOL_ERROR']) {
    assert.equal(isConnectionError(code), true, code);
  }
  for (const code of ['TIMEOUT', 'AUTH_ERROR', 'HTTP_ERROR', undefined]) {
    assert.equal(isConnectionError(code), false, String(code));
  }
});

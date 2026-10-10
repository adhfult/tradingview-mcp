import { format, inspect } from 'node:util';

const FORMAT_METHODS = ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dirxml', 'table', 'group', 'groupCollapsed'];

function chunkText(chunk) {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

/**
 * Makes stdout carry protocol lines and nothing else.
 *
 * - Every console method, and any other `process.stdout.write` call (library
 *   debug output, stray prints), is redirected to stderr through `redact`.
 * - `process.stderr.write` is wrapped so that stderr is redacted too.
 * - Returns `{ write(text, callback?) }`, the only handle that still reaches the
 *   real stdout. Pass it to `createServer` as `output`.
 *
 * Call this before importing the library.
 */
export function guardStdio({ proc = process, con = console, redact }) {
  const stdoutWrite = proc.stdout.write.bind(proc.stdout);
  const stderrWrite = proc.stderr.write.bind(proc.stderr);

  const toStderr = (text) => {
    try {
      const safe = redact(text);
      stderrWrite(safe.endsWith('\n') ? safe : `${safe}\n`);
    } catch {
      // Logging must never throw into the caller.
    }
  };

  const redirect = (chunk, encoding, callback) => {
    toStderr(chunkText(chunk));
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') done();
    return true;
  };
  proc.stdout.write = redirect;

  proc.stderr.write = (chunk, encoding, callback) => {
    try {
      return stderrWrite(redact(chunkText(chunk)), encoding, callback);
    } catch {
      return true;
    }
  };

  for (const method of FORMAT_METHODS) {
    con[method] = (...args) => toStderr(format(...args));
  }
  con.dir = (value, options) => toStderr(inspect(value, options));
  con.assert = (condition, ...args) => {
    if (!condition) toStderr(format('Assertion failed', ...args));
  };

  return {
    write: (text, callback) => stdoutWrite(text, callback),
  };
}

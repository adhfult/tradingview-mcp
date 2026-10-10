import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardStdio } from '../lib/stdio.mjs';
import { makeRedactor } from '../lib/redact.mjs';
import { withDeadline } from '../lib/deadline.mjs';

function fakeProcess() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    proc: {
      stdout: { write: (chunk, enc, cb) => { out.push(String(chunk)); (typeof enc === 'function' ? enc : cb)?.(); return true; } },
      stderr: { write: (chunk) => { err.push(String(chunk)); return true; } },
    },
  };
}

test('guardStdio keeps stdout for protocol lines only and redacts everything on stderr', () => {
  const { proc, out, err } = fakeProcess();
  const con = {};
  const redact = makeRedactor({ TRADINGVIEW_SESSION_ID: 'fake-session-value' });
  const protocol = guardStdio({ proc, con, redact });

  con.log('a', 1);
  con.info('b');
  con.debug('c');
  con.warn('w fake-session-value');
  con.error('e sessionid=abc123;');
  con.dir({ k: 'v' });
  con.table([{ x: 1 }]);
  con.trace('t');
  con.group('g');
  con.assert(false, 'assertion');
  proc.stdout.write('raw line with fake-session-value\n');
  proc.stdout.write(Buffer.from('buffer chunk\n'));
  let called = false;
  proc.stdout.write('with callback\n', () => { called = true; });
  proc.stderr.write('direct stderr fake-session-value\n');

  assert.deepEqual(out, [], 'nothing but protocol output reaches the real stdout');
  assert.ok(called, 'write callbacks still run');
  const stderr = err.join('');
  assert.equal(stderr.includes('fake-session-value'), false);
  assert.equal(stderr.includes('abc123'), false);
  for (const marker of ['raw line', 'buffer chunk', 'k: \'v\'', 'assertion', 'direct stderr']) {
    assert.ok(stderr.includes(marker), `stderr has ${marker}`);
  }

  protocol.write('{"id":1}\n');
  assert.deepEqual(out, ['{"id":1}\n'], 'the protocol handle reaches the real stdout');
});

test('withDeadline resolves, rejects, and absorbs a late result after the deadline', async () => {
  assert.equal(await withDeadline(async () => 'ok', 1000, () => new Error('late')), 'ok');
  await assert.rejects(withDeadline(async () => { throw new Error('inner'); }, 1000, () => new Error('late')), /inner/);
  await assert.rejects(withDeadline(() => { throw new Error('sync'); }, 1000, () => new Error('late')), /sync/);

  let rejectLate;
  const hung = new Promise((_, reject) => { rejectLate = reject; });
  await assert.rejects(withDeadline(() => hung, 20, () => new Error('deadline')), /deadline/);
  rejectLate(new Error('after the deadline'));
  await new Promise((resolve) => setImmediate(resolve)); // an unhandled rejection would fail the run
});

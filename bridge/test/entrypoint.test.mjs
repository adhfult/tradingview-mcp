import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'server.mjs');
const leaker = join(root, 'fixtures', 'leak-after-guard.mjs');

// Runs the real entry point as a child process. Only `health` and validation
// failures are used, so nothing touches the network.
function run({ args = [server], input, env = {}, delayMs = 0 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    setTimeout(() => child.stdin.end(input), delayMs);
  });
}

test('health over the real entry point: one protocol line, clean stderr, exit 0', async () => {
  const r = await run({ input: '{"id":1,"method":"health"}\n' });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(lines[0]).result), ['ok', 'libVersion', 'node', 'hasCredentials']);
});

test('starts through a symlinked path too', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = join(dir, 'server.mjs');
  symlinkSync(server, link);
  const r = await run({ args: [link], input: '{"id":1,"method":"health"}\n' });
  assert.equal(JSON.parse(r.stdout).result.ok, true);
});

test('library-style console and stdout noise never reaches stdout, and stderr is redacted', async () => {
  const r = await run({
    args: ['--import', leaker, server],
    input: '{"id":1,"method":"health"}\n{bad json\n',
    env: { TRADINGVIEW_SESSION_ID: 'fake-session-value', TRADINGVIEW_SESSION_SIGN: 'fake-sign-value' },
    delayMs: 400,
  });
  assert.equal(r.code, 0);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 2, `stdout was: ${r.stdout}`);
  for (const line of lines) JSON.parse(line); // every stdout line is JSON
  assert.equal(r.stdout.includes('LEAK'), false);
  for (const marker of ['LEAK-LOG', 'LEAK-INFO', 'LEAK-DEBUG', 'LEAK-DIR', 'LEAK-TABLE', 'LEAK-RAW', 'LEAK-ERROR', 'LEAK-WARN']) {
    assert.ok(r.stderr.includes(marker), `${marker} was routed to stderr`);
  }
  assert.equal(r.stderr.includes('fake-session-value'), false, 'secret redacted on stderr');
  assert.equal(r.stderr.includes('cookievalue123'), false, 'cookie pattern redacted on stderr');
});

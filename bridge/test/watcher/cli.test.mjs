import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WATCHER = join(here, '..', '..', 'watcher.mjs');
const EXAMPLE = join(here, '..', '..', 'watcher.config.example.json');

/**
 * Runs the real CLI in a child process. The environment is stripped to PATH and
 * HOME, so no secret from the developer's shell can reach the child.
 */
function cli(args, extraEnv = {}) {
  return spawnSync(process.execPath, [WATCHER, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmpdir(), ...extraEnv },
    timeout: 20_000,
  });
}

test('--check-config on the example config prints OK and exits 0', () => {
  const res = cli(['--config', EXAMPLE, '--check-config']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, 'OK\n');
});

test('--check-config on an invalid config lists every problem and exits 1', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'watcher-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bad = join(dir, 'bad.json');
  await writeFile(bad, JSON.stringify({ timezone: 'Mars/Base', limits: { max_streams: 99 } }));
  const res = cli(['--config', bad, '--check-config']);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /timezone: is not a valid IANA timezone name/);
  assert.match(res.stdout, /limits\.max_streams: must be at most 25/);
  assert.match(res.stdout, /watchlist: /);
});

test('--check-config on a file that is not JSON exits 1 without a stack trace', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'watcher-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const broken = join(dir, 'broken.json');
  await writeFile(broken, '{ this is not json');
  const res = cli(['--config', broken, '--check-config']);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /not valid JSON/);
  assert.ok(!res.stderr.includes('at '), 'no stack trace');
});

test('a malformed webhook URL is reported by --check-config without echoing it', () => {
  const res = cli(['--config', EXAMPLE, '--check-config'], {
    DISCORD_WEBHOOK_URL: 'https://example.invalid/SECRET_CLI_VALUE',
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /DISCORD_WEBHOOK_URL is set but is not a Discord webhook URL/);
  assert.ok(!res.stdout.includes('SECRET_CLI_VALUE'));
  assert.ok(!res.stderr.includes('SECRET_CLI_VALUE'));
});

test('usage errors exit 2 with the usage line', () => {
  const noConfig = cli(['--check-config']);
  assert.equal(noConfig.status, 2);
  assert.match(noConfig.stderr, /--config <path> is required/);
  assert.match(noConfig.stderr, /usage: node bridge\/watcher\.mjs/);

  const unknown = cli(['--config', EXAMPLE, '--frobnicate']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument: --frobnicate/);
});

test('--test-notify with no channel configured exits 1 and sends nothing', () => {
  const res = cli(['--config', EXAMPLE, '--test-notify']);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /no notification channel is configured/);
});

test('--help prints the usage and exits 0', () => {
  const res = cli(['--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /usage: node bridge\/watcher\.mjs/);
});

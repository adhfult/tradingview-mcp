import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Execute the real helper and channel blocks against synthetic settings, never /etc.
async function harness(t, option, refuseChmod, key) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-setup-test-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const source = await readFile(new URL('../../../scripts/pi-setup.sh', import.meta.url), 'utf8');
  const helpers = source.slice(source.indexOf('ok()'), source.indexOf('step "1. This machine"'));
  const start = option === 'SETUP' ? source.indexOf('step "5.')
    : source.indexOf(`if [ "$${option}" = 1 ]; then`, source.indexOf('step "5.'));
  const end = option === 'SETUP' ? source.indexOf('if [ "$TELEGRAM" = 1 ]; then', start)
    : source.indexOf('\nif [ ', start + 1);
  const block = source.slice(start, end);
  const file = join(dir, 'settings'), events = join(dir, 'events');
  const original = '# synthetic settings\n';
  await writeFile(file, original); await chmod(file, 0o644); await writeFile(events, '');
  const script = join(dir, 'harness.sh');
  await writeFile(script, `set -u\nME=fixture\nFAILS=0 WARNS=0\nDISCORD=0 TELEGRAM=0 SEC_CONTACT=0 FINNHUB=0\n${option}=1\n${helpers}
    ${refuseChmod ? 'chmod() { echo chmod-attempt >> "$EVENTS"; return 1; }' : ''}
    sudo() { echo unsafe-write >> "$EVENTS"; return 1; }
    ask_hidden() {
      echo prompt >> "$EVENTS"
      case "$2" in
        CONTACT) printf -v "$2" '%s' 'fixture@example.invalid' ;;
        KEY) printf -v "$2" '%s' "\${FIXTURE_KEY-fixturekey12345}" ;;
        URL) printf -v "$2" '%s' 'https://discord.com/api/webhooks/123/fixture' ;;
        TOK) printf -v "$2" '%s' '123:fixture' ;;
      esac
    }
    tg() { case "$1" in getMe) echo '{"ok":true,"result":{"username":"fixture"}}';;
      getUpdates) echo '{"result":[{"message":{"chat":{"id":123}}}]}';; esac; }
    ${block}\n`);
  const result = spawnSync('bash', [script], { encoding: 'utf8', input: '\n',
    env: { PATH: process.env.PATH, ENVFILE: file, EVENTS: events, ...(key === undefined ? {} : { FIXTURE_KEY: key }) } });
  return { result, file, events: await readFile(events, 'utf8'), original };
}

for (const option of ['SETUP', 'SEC_CONTACT', 'FINNHUB', 'TELEGRAM', 'DISCORD']) {
  test(`M4 Pi setup refuses ${option} prompts and writes when chmod cannot make the file private`, async (t) => {
    const h = await harness(t, option, true);
    assert.equal(await readFile(h.file, 'utf8'), h.original, 'insecure file remains unchanged');
    assert.notEqual(h.result.status, 0, 'setup must fail closed');
    assert.doesNotMatch(h.events, /prompt/);
    assert.equal(h.events.trim(), 'chmod-attempt', 'exactly one repair attempt');
    assert.ok(h.result.stdout.includes(`run: sudo chown fixture:fixture ${h.file} && chmod 600 ${h.file}`), h.result.stdout);
  });
}

test('M4 Pi setup repairs mode 644 to 600 before prompting and writing', async (t) => {
  const h = await harness(t, 'SEC_CONTACT', false);
  assert.equal(h.result.status, 0);
  assert.equal((await stat(h.file)).mode & 0o777, 0o600);
  assert.match(h.result.stdout, /(?:ok|WARN).*repaired.*644.*600/);
  assert.match(h.events, /prompt/);
  assert.match(await readFile(h.file, 'utf8'), /^WATCHER_SEC_CONTACT=/m);
});

test('Finnhub option saves a valid key to the private settings file and never prints it', async (t) => {
  const h = await harness(t, 'FINNHUB', false, 'fixturekey12345');
  assert.equal(h.result.status, 0);
  assert.equal((await stat(h.file)).mode & 0o777, 0o600);
  assert.match(await readFile(h.file, 'utf8'), /^FINNHUB_API_KEY=fixturekey12345$/m);
  assert.match(h.result.stdout, /saved FINNHUB_API_KEY/);
  assert.ok(!h.result.stdout.includes('fixturekey12345') && !h.result.stderr.includes('fixturekey12345'));
});

for (const [name, bad] of [['too short', 'abc'], ['has a space', 'fixture key 123456'], ['not ASCII', 'fixturekey\u00e9\u00e9123'], ['empty', ''], ['has a shell separator', 'abcd;echo${IFS}x'], ['has a quote', 'fixture"key12345'], ['has a dollar sign', 'fixture$HOME12345'], ['has a backslash', 'fixture\\key12345'], ['has a hash', 'fixture#key12345']]) {
  test(`Finnhub option saves nothing when the key is ${name}`, async (t) => {
    const h = await harness(t, 'FINNHUB', false, bad);
    assert.doesNotMatch(await readFile(h.file, 'utf8'), /FINNHUB_API_KEY/);
    assert.match(h.result.stdout, /FAIL.*Finnhub/);
  });
}

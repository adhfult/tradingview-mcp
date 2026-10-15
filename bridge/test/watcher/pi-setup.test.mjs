import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Execute the real helper and channel blocks against synthetic settings, never /etc.
async function harness(t, option, refuseChmod) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-setup-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
  await writeFile(script, `set -u\nME=fixture\nFAILS=0 WARNS=0\nDISCORD=0 TELEGRAM=0 SEC_CONTACT=0\n${option}=1\n${helpers}
    ${refuseChmod ? 'chmod() { echo chmod-attempt >> "$EVENTS"; return 1; }' : ''}
    sudo() { echo unsafe-write >> "$EVENTS"; return 1; }
    ask_hidden() {
      echo prompt >> "$EVENTS"
      case "$2" in
        CONTACT) printf -v "$2" '%s' 'fixture@example.invalid' ;;
        URL) printf -v "$2" '%s' 'https://discord.com/api/webhooks/123/fixture' ;;
        TOK) printf -v "$2" '%s' '123:fixture' ;;
      esac
    }
    tg() { case "$1" in getMe) echo '{"ok":true,"result":{"username":"fixture"}}';;
      getUpdates) echo '{"result":[{"message":{"chat":{"id":123}}}]}';; esac; }
    ${block}\n`);
  const result = spawnSync('bash', [script], { encoding: 'utf8', input: '\n',
    env: { PATH: process.env.PATH, ENVFILE: file, EVENTS: events } });
  return { result, file, events: await readFile(events, 'utf8'), original };
}

for (const option of ['SETUP', 'SEC_CONTACT', 'TELEGRAM', 'DISCORD']) {
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

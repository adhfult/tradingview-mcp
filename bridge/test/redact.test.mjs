import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRedactor, SECRET_ENV_VARS } from '../lib/redact.mjs';

test('SECRET_ENV_VARS lists the seven secret variable names', () => {
  assert.deepEqual([...SECRET_ENV_VARS].sort(), [
    'DISCORD_WEBHOOK_URL',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'TRADINGVIEW_SESSION_ID',
    'TRADINGVIEW_SESSION_SIGN',
    'WATCHER_DASHBOARD_TOKEN',
    'WATCHER_LOCAL_TOKEN',
  ]);
});

test('replaces env secret values of 4+ characters and ignores short or unset ones', () => {
  const redact = makeRedactor({
    TRADINGVIEW_SESSION_ID: 'fake-session-value',
    TELEGRAM_CHAT_ID: 'abc',
  });
  assert.equal(redact('id fake-session-value end'), 'id [REDACTED] end');
  assert.equal(redact('abc stays'), 'abc stays');
});

test('redacts session cookies, bot tokens and Discord webhooks by pattern', () => {
  const redact = makeRedactor({});
  assert.equal(redact('sessionid=abc123; next'), 'sessionid=[REDACTED]; next');
  assert.equal(redact('sessionid_sign=xyz987 tail'), 'sessionid_sign=[REDACTED] tail');
  assert.equal(redact('token bot123456:ABC-def here'), 'token bot[REDACTED] here');
  assert.equal(
    redact('hook https://discord.com/api/webhooks/111/fake-token ok'),
    'hook [REDACTED_WEBHOOK] ok',
  );
  assert.equal(
    redact('https://canary.discordapp.com/api/webhooks/222/other'),
    '[REDACTED_WEBHOOK]',
  );
});

test('coerces non-string input with String()', () => {
  const redact = makeRedactor({});
  assert.equal(redact(42), '42');
  assert.equal(redact(null), 'null');
});

test('also redacts URL-encoded and JSON-escaped secret values', () => {
  const secret = 'ab+/c"d=';
  const redact = makeRedactor({ TRADINGVIEW_SESSION_ID: secret });
  assert.equal(redact(`plain ${secret}`), 'plain [REDACTED]');
  assert.equal(redact(`url ${encodeURIComponent(secret)}`), 'url [REDACTED]');
  assert.equal(redact(`json ${JSON.stringify(secret)}`), 'json "[REDACTED]"');
});

test('redacts JSON and colon forms of the cookie names, and JWT-shaped tokens', () => {
  const redact = makeRedactor({});
  assert.equal(redact('{"sessionid":"abc123","x":1}'), '{"sessionid":"[REDACTED]","x":1}');
  assert.equal(redact('{"sessionid_sign":"v1:xyz"}'), '{"sessionid_sign":"[REDACTED]"}');
  assert.equal(redact('sessionid: abc123, next'), 'sessionid: [REDACTED], next');
  assert.equal(
    redact('token eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiMSJ9.c2lnbmF0dXJl end'),
    'token [REDACTED_JWT] end',
  );
});

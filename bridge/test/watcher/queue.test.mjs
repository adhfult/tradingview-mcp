import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../../lib/queue.mjs';
import { makeRedactor } from '../../lib/redact.mjs';
import { createFakeClock, settle } from './support.mjs';

const message = { level: 'up', title: 't', lines: ['x'], timestamp: '2026-10-10T12:00:00.000Z' };

function notifier(name, plan) {
  const calls = [];
  return {
    name,
    calls,
    async send(msg) {
      calls.push(msg);
      const step = plan(calls.length);
      if (step instanceof Error) throw step;
    },
  };
}

function httpError(status, retryAfterSec) {
  return Object.assign(new Error(`HTTP ${status}`), { status, retryAfterSec });
}

test('enqueue returns at once and delivers to every notifier', async () => {
  const clock = createFakeClock();
  const a = notifier('a', () => null);
  const b = notifier('b', () => null);
  const queue = createQueue({ notifiers: [a, b], clock });
  queue.enqueue(message);
  // The first send starts synchronously: enqueue did not wait for the network.
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
  await queue.idle();
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
  assert.equal(queue.pending(), 0);
});

test('a failing attempt is retried after 2s, then 5s, then succeeds', async () => {
  const clock = createFakeClock();
  const flaky = notifier('flaky', (n) => (n <= 2 ? httpError(500) : null));
  const queue = createQueue({ notifiers: [flaky], clock });
  queue.enqueue(message);
  await settle();
  assert.equal(flaky.calls.length, 1);
  clock.advance(1999);
  await settle();
  assert.equal(flaky.calls.length, 1, 'no retry before 2s');
  clock.advance(1);
  await settle();
  assert.equal(flaky.calls.length, 2);
  clock.advance(4999);
  await settle();
  assert.equal(flaky.calls.length, 2, 'no retry before 5s');
  clock.advance(1);
  await settle();
  assert.equal(flaky.calls.length, 3);
  await queue.idle();
});

test('three failures drop the alert and log it, without the error text', async () => {
  const clock = createFakeClock();
  const logs = [];
  const broken = notifier('discord', () => httpError(500));
  const queue = createQueue({ notifiers: [broken], clock, log: (line) => logs.push(line) });
  queue.enqueue(message);
  for (let i = 0; i < 3; i += 1) {
    await settle();
    clock.advance(5000);
  }
  await queue.idle();
  assert.equal(broken.calls.length, 3);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /discord: alert dropped after 3 attempts \(HTTP 500\)/);
});

test('HTTP 429 waits the server retry_after instead of the backoff', async () => {
  const clock = createFakeClock();
  const limited = notifier('telegram', (n) => (n === 1 ? httpError(429, 7) : null));
  const queue = createQueue({ notifiers: [limited], clock });
  queue.enqueue(message);
  await settle();
  clock.advance(6999);
  await settle();
  assert.equal(limited.calls.length, 1);
  clock.advance(1);
  await settle();
  assert.equal(limited.calls.length, 2);
  await queue.idle();
});

test('a retry_after above 60s is capped at 60s', async () => {
  const clock = createFakeClock();
  const limited = notifier('discord', (n) => (n === 1 ? httpError(429, 500) : null));
  const queue = createQueue({ notifiers: [limited], clock });
  queue.enqueue(message);
  await settle();
  clock.advance(59_999);
  await settle();
  assert.equal(limited.calls.length, 1);
  clock.advance(1);
  await settle();
  assert.equal(limited.calls.length, 2);
  await queue.idle();
});

test('one failing notifier does not hold up the other', async () => {
  const clock = createFakeClock();
  const broken = notifier('broken', () => httpError(500));
  const healthy = notifier('healthy', () => null);
  const queue = createQueue({ notifiers: [broken, healthy], clock, log: () => {} });
  queue.enqueue(message);
  await settle();
  assert.equal(healthy.calls.length, 1);
  await settle();
  assert.equal(healthy.calls.length, 1, 'healthy notifier was sent once');
  for (let i = 0; i < 3; i += 1) {
    await settle();
    clock.advance(5000);
  }
  await queue.idle();
});

test('after close, new messages are dropped with a log line', async () => {
  const clock = createFakeClock();
  const logs = [];
  const sink = notifier('sink', () => null);
  const queue = createQueue({ notifiers: [sink], clock, log: (line) => logs.push(line) });
  queue.close();
  queue.enqueue(message);
  await queue.idle();
  assert.equal(sink.calls.length, 0);
  assert.match(logs[0], /shutting down/);
});

test('the log never contains a webhook URL or bot token, even when a transport error echoes them', async () => {
  const webhook = 'https://discord.com/api/webhooks/123456789/SECRET_WEBHOOK_PART';
  const token = '987654:SECRET_BOT_TOKEN_VALUE';
  const env = { DISCORD_WEBHOOK_URL: webhook, TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: '42' };
  const redact = makeRedactor(env);
  const captured = [];
  const leaky = notifier('telegram', () => httpError(500));
  leaky.send = async () => {
    // A transport could echo the full request URL in its error text.
    throw new Error(`request to https://api.telegram.org/bot${token}/sendMessage failed (${webhook})`);
  };
  const clock = createFakeClock();
  const queue = createQueue({
    notifiers: [leaky],
    clock,
    log: (line) => captured.push(redact(line)),
  });
  queue.enqueue(message);
  for (let i = 0; i < 3; i += 1) {
    await settle();
    clock.advance(5000);
  }
  await queue.idle();
  const everything = captured.join('\n');
  assert.ok(captured.length >= 1);
  assert.ok(!everything.includes(webhook));
  assert.ok(!everything.includes('SECRET_WEBHOOK_PART'));
  assert.ok(!everything.includes(token));
  assert.ok(!everything.includes('SECRET_BOT_TOKEN_VALUE'));
});

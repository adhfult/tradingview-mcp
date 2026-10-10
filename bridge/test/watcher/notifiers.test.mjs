import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNotifiers, createDiscordNotifier, createTelegramNotifier, createStdoutNotifier,
  discordPayload, telegramPayload, NotifierError,
} from '../../lib/notifiers.mjs';
import { makeRedactor } from '../../lib/redact.mjs';
import { createFakeFetch, jsonResponse } from './support.mjs';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789/SECRET_WEBHOOK_PART';
const TOKEN = '987654:SECRET_BOT_TOKEN_VALUE';
const TIMESTAMP = '2026-10-10T12:00:00.000Z';

const message = (overrides = {}) => ({
  level: 'up',
  title: '🟢 BINANCE:BTCUSDT · 1h · pct_move',
  lines: ['Up 3.4% over 4 bars', 'Bar closed: 2026-10-10 08:00 EDT'],
  url: 'https://www.tradingview.com/chart/?symbol=BINANCE%3ABTCUSDT',
  timestamp: TIMESTAMP,
  ...overrides,
});

test('Discord payload has content, an embed with title, description, colour, timestamp and url', () => {
  const payload = discordPayload(message());
  assert.equal(payload.content, '🟢 BINANCE:BTCUSDT · 1h · pct_move');
  const [embed] = payload.embeds;
  assert.equal(embed.title, '🟢 BINANCE:BTCUSDT · 1h · pct_move');
  assert.equal(embed.description, 'Up 3.4% over 4 bars\nBar closed: 2026-10-10 08:00 EDT');
  assert.equal(embed.color, 0x2ecc71);
  assert.equal(embed.timestamp, TIMESTAMP);
  assert.equal(embed.url, message().url);
});

test('Discord colours: green for up, red for down, blue for info', () => {
  assert.equal(discordPayload(message({ level: 'down' })).embeds[0].color, 0xe74c3c);
  assert.equal(discordPayload(message({ level: 'info' })).embeds[0].color, 0x3498db);
});

test('Discord limits: content at most 2000, description at most 4096, both with an ellipsis', () => {
  const long = 'x'.repeat(5000);
  const payload = discordPayload(message({ title: long, lines: [long] }));
  assert.equal(payload.content.length, 2000);
  assert.ok(payload.content.endsWith('…'));
  assert.equal(payload.embeds[0].description.length, 4096);
  assert.ok(payload.embeds[0].description.endsWith('…'));
  assert.equal(payload.embeds[0].title.length, 256);
});

test('Discord: an empty body leaves the description out', () => {
  const payload = discordPayload(message({ lines: [], url: undefined }));
  assert.equal('description' in payload.embeds[0], false);
  assert.equal('url' in payload.embeds[0], false);
});

test('Telegram payload uses HTML parse mode, no web preview, and the chat id', () => {
  const payload = telegramPayload(message(), '42');
  assert.equal(payload.chat_id, '42');
  assert.equal(payload.parse_mode, 'HTML');
  assert.equal(payload.disable_web_page_preview, true);
  assert.match(payload.text, /^<b>🟢 BINANCE:BTCUSDT · 1h · pct_move<\/b>\n/);
  assert.match(payload.text, /<a href="https:\/\/www\.tradingview\.com\/chart\/\?symbol=BINANCE%3ABTCUSDT">Chart<\/a>$/);
});

test('Telegram escapes user text, so markup in an alert cannot inject tags', () => {
  const payload = telegramPayload(message({
    title: '<script>alert(1)</script> & "quotes"',
    lines: ['a < b & c > d'],
  }), '42');
  assert.ok(payload.text.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;'));
  assert.ok(payload.text.includes('a &lt; b &amp; c &gt; d'));
  assert.ok(!payload.text.includes('<script>'));
});

test('Telegram text is at most 4096 characters after escaping, and never cuts an entity', () => {
  const payload = telegramPayload(message({ lines: ['&'.repeat(3000), '<'.repeat(3000)] }), '42');
  assert.ok(payload.text.length <= 4096, `length ${payload.text.length}`);
  assert.ok(payload.text.endsWith('</a>'), 'the chart link survives');
  // every & is part of a full entity
  assert.ok(!/&(?!amp;|lt;|gt;|quot;)/.test(payload.text.replace(/<a [^>]*>/g, '')));
});

test('Discord sender posts JSON to the webhook and succeeds on 204', async () => {
  const { fetch, calls } = createFakeFetch(() => new Response(null, { status: 204 }));
  const notifier = createDiscordNotifier({ url: WEBHOOK, fetch });
  await notifier.send(message());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, WEBHOOK);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].body.embeds[0].color, 0x2ecc71);
});

test('Telegram sender posts to the bot sendMessage endpoint', async () => {
  const { fetch, calls } = createFakeFetch(() => jsonResponse(200, { ok: true }));
  const notifier = createTelegramNotifier({ token: TOKEN, chatId: '42', fetch });
  await notifier.send(message());
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].body.chat_id, '42');
});

test('Discord 429 carries retry_after (seconds) for the queue to honour', async () => {
  const { fetch } = createFakeFetch(() => jsonResponse(429, { message: 'slow down', retry_after: 2.5 }));
  const notifier = createDiscordNotifier({ url: WEBHOOK, fetch });
  await assert.rejects(notifier.send(message()), (err) => {
    assert.ok(err instanceof NotifierError);
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterSec, 2.5);
    return true;
  });
});

test('Telegram 429 carries parameters.retry_after, falling back to the Retry-After header', async () => {
  const body = createFakeFetch(() => jsonResponse(429, { ok: false, parameters: { retry_after: 4 } }));
  await assert.rejects(createTelegramNotifier({ token: TOKEN, chatId: '1', fetch: body.fetch }).send(message()),
    (err) => err.retryAfterSec === 4);
  const header = createFakeFetch(() => new Response('', { status: 429, headers: { 'retry-after': '9' } }));
  await assert.rejects(createTelegramNotifier({ token: TOKEN, chatId: '1', fetch: header.fetch }).send(message()),
    (err) => err.retryAfterSec === 9);
});

test('other HTTP errors carry the status and no retry hint', async () => {
  const { fetch } = createFakeFetch(() => new Response('bad', { status: 400 }));
  await assert.rejects(createDiscordNotifier({ url: WEBHOOK, fetch }).send(message()), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.retryAfterSec, undefined);
    return true;
  });
});

test('a network error never exposes the URL or the token', async () => {
  const { fetch } = createFakeFetch(() => {
    throw new Error(`getaddrinfo ENOTFOUND for ${WEBHOOK} and bot${TOKEN}`);
  });
  const redact = makeRedactor({ DISCORD_WEBHOOK_URL: WEBHOOK, TELEGRAM_BOT_TOKEN: TOKEN });
  const discord = createDiscordNotifier({ url: WEBHOOK, fetch, redact });
  await assert.rejects(discord.send(message()), (err) => {
    assert.ok(!err.message.includes(WEBHOOK));
    assert.ok(!err.message.includes('SECRET_WEBHOOK_PART'));
    return true;
  });
  const telegram = createTelegramNotifier({ token: TOKEN, chatId: '1', fetch, redact });
  await assert.rejects(telegram.send(message()), (err) => {
    assert.ok(!err.message.includes(TOKEN));
    assert.ok(!err.message.includes('SECRET_BOT_TOKEN_VALUE'));
    return true;
  });
});

test('buildNotifiers uses only fully configured, well-formed channels', () => {
  assert.deepEqual(buildNotifiers({ env: {} }).map((n) => n.name), []);
  assert.deepEqual(buildNotifiers({ env: { TELEGRAM_BOT_TOKEN: TOKEN } }).map((n) => n.name), []);
  assert.deepEqual(buildNotifiers({ env: { DISCORD_WEBHOOK_URL: 'https://example.com/x' } }).map((n) => n.name), []);
  const both = buildNotifiers({
    env: { DISCORD_WEBHOOK_URL: WEBHOOK, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' },
  });
  assert.deepEqual(both.map((n) => n.name), ['discord', 'telegram']);
});

test('creating a notifier with a malformed secret throws without echoing it', () => {
  assert.throws(() => createDiscordNotifier({ url: 'https://evil.example/SECRET_X' }), (err) => {
    assert.ok(!err.message.includes('SECRET_X'));
    return true;
  });
  assert.throws(() => createTelegramNotifier({ token: 'SECRET_BAD', chatId: '1' }), (err) => {
    assert.ok(!err.message.includes('SECRET_BAD'));
    return true;
  });
});

test('dry-run prints the plain text of each alert and makes no network call', async () => {
  const written = [];
  const printer = createStdoutNotifier({ write: (text) => written.push(text) });
  await printer.send(message());
  assert.equal(printer.name, 'dry-run');
  assert.match(written[0], /BINANCE:BTCUSDT · 1h · pct_move\nUp 3.4% over 4 bars/);
  assert.match(written[0], /https:\/\/www\.tradingview\.com\/chart/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDiscordNotifier, createTelegramNotifier, discordPayload, telegramPayload, withImages, NotifierError,
} from '../../lib/notifiers.mjs';
import { RenderError } from '../../lib/render.mjs';
import { createFakeFetch, jsonResponse } from './support.mjs';

const HOOK = 'https://discord.com/api/webhooks/123456789/fake_hook_part_for_tests';
const BOT = '987654:fake_bot_part_for_tests';
const BASE = 'http://127.0.0.1:8788';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);
const CHART = { symbol: 'BINANCE:BTCUSDT', timeframe: '60', barTime: 1760000000, direction: 'up', level: 100000, ruleId: 'btc100k' };

const ok = () => jsonResponse(200, {});

const message = (overrides = {}) => ({
  level: 'up',
  title: '🟢 BINANCE:BTCUSDT · 1h · price_cross',
  lines: ['Crossed 100000', 'Rule: btc100k'],
  url: 'https://www.tradingview.com/chart/?symbol=BINANCE%3ABTCUSDT',
  timestamp: '2026-10-10T12:00:00.000Z',
  ...overrides,
});

const bytesOf = async (file) => Buffer.from(await file.arrayBuffer());

// ---------------------------------------------------------------- Discord

test('Discord with an image: multipart with the same JSON as payload_json and the PNG as files[0]', async () => {
  const { fetch, calls } = createFakeFetch(ok);
  await createDiscordNotifier({ url: HOOK, fetch }).send(message({ image: PNG }));
  assert.equal(calls.length, 1);
  const { init, body } = calls[0];
  assert.ok(body instanceof FormData);
  assert.equal(init.headers?.['content-type'], undefined, 'fetch sets the multipart boundary itself');
  const payload = JSON.parse(body.get('payload_json'));
  const plain = discordPayload(message());
  assert.equal(payload.content, plain.content);
  assert.deepEqual(payload.allowed_mentions, { parse: [] }, 'still cannot ping anyone');
  assert.deepEqual(payload.embeds[0], { ...plain.embeds[0], image: { url: 'attachment://chart.png' } });
  const file = body.get('files[0]');
  assert.equal(file.name, 'chart.png');
  assert.equal(file.type, 'image/png');
  assert.deepEqual(await bytesOf(file), PNG);
});

test('Discord without an image (or with an empty one) is the plain JSON post it always was', async () => {
  for (const image of [undefined, Buffer.alloc(0)]) {
    const { fetch, calls } = createFakeFetch(ok);
    await createDiscordNotifier({ url: HOOK, fetch }).send(message({ image }));
    assert.equal(calls[0].init.headers['content-type'], 'application/json');
    assert.deepEqual(calls[0].body, discordPayload(message()));
    assert.equal('image' in calls[0].body.embeds[0], false);
  }
});

test('Discord with an image still reports 429 with retry_after, and never leaks the webhook in an error', async () => {
  const limited = createFakeFetch(() => jsonResponse(429, { retry_after: 2.5 }));
  await assert.rejects(createDiscordNotifier({ url: HOOK, fetch: limited.fetch }).send(message({ image: PNG })),
    (err) => err instanceof NotifierError && err.status === 429 && err.retryAfterSec === 2.5);
  const broken = async () => { throw new Error(`connect failed ${HOOK}`); };
  await assert.rejects(createDiscordNotifier({ url: HOOK, fetch: broken }).send(message({ image: PNG })), (err) => !err.message.includes('fake_hook_part'));
});

// ---------------------------------------------------------------- Telegram

test('Telegram with an image: sendPhoto multipart with chat_id, the HTML caption, parse_mode and the PNG', async () => {
  const { fetch, calls } = createFakeFetch(ok);
  await createTelegramNotifier({ token: BOT, chatId: '42', fetch }).send(message({ image: PNG }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${BOT}/sendPhoto`);
  const body = calls[0].body;
  assert.ok(body instanceof FormData);
  assert.equal(body.get('chat_id'), '42');
  assert.equal(body.get('parse_mode'), 'HTML');
  assert.equal(body.get('caption'), telegramPayload(message(), '42').text, 'the same text a plain alert would have');
  const photo = body.get('photo');
  assert.equal(photo.name, 'chart.png');
  assert.equal(photo.type, 'image/png');
  assert.deepEqual(await bytesOf(photo), PNG);
});

test('Telegram caption of exactly 1024 characters still goes as a photo; one more falls back to a plain message with the image dropped', async () => {
  const fits = message({ lines: ['x'.repeat(1)] });
  const base = telegramPayload(fits, '42').text.length;
  const exact = message({ lines: ['x'.repeat(1 + 1024 - base)] });
  assert.equal(telegramPayload(exact, '42').text.length, 1024);
  const first = createFakeFetch(ok);
  await createTelegramNotifier({ token: BOT, chatId: '42', fetch: first.fetch }).send({ ...exact, image: PNG });
  assert.match(first.calls[0].url, /sendPhoto$/);

  const long = message({ lines: ['x'.repeat(2 + 1024 - base)] });
  assert.equal(telegramPayload(long, '42').text.length, 1025);
  const second = createFakeFetch(ok);
  await createTelegramNotifier({ token: BOT, chatId: '42', fetch: second.fetch }).send({ ...long, image: PNG });
  assert.match(second.calls[0].url, /sendMessage$/);
  assert.deepEqual(second.calls[0].body, telegramPayload(long, '42'), 'the full text, uncut');
});

test('Telegram without an image is unchanged: sendMessage JSON', async () => {
  const { fetch, calls } = createFakeFetch(ok);
  await createTelegramNotifier({ token: BOT, chatId: '42', fetch }).send(message());
  assert.match(calls[0].url, /sendMessage$/);
  assert.deepEqual(calls[0].body, telegramPayload(message(), '42'));
});

test('Telegram with an image never leaks the bot token in an error', async () => {
  const broken = async (url) => { throw new Error(`connect failed ${url}`); };
  await assert.rejects(createTelegramNotifier({ token: BOT, chatId: '42', fetch: broken }).send(message({ image: PNG })),
    (err) => !err.message.includes('fake_bot_part'));
});

// ---------------------------------------------------------------- withImages

const recorder = (name) => {
  const sent = [];
  return { name, sent, send: async (m) => { sent.push(m); } };
};
const fakeRenderer = (impl = async () => PNG) => {
  const calls = [];
  return { calls, render: async (chart) => { calls.push(chart); return impl(chart); } };
};

test('withImages with no renderer returns the notifiers as they are', () => {
  const list = [recorder('discord')];
  assert.equal(withImages(list, { renderer: null, baseUrl: BASE }), list);
});

test('a message without a chart goes through untouched and never wakes the renderer', async () => {
  const renderer = fakeRenderer();
  const [n] = withImages([recorder('discord')], { renderer, baseUrl: BASE });
  const m = message();
  await n.send(m);
  assert.equal(renderer.calls.length, 0);
  assert.equal(n.sent[0], m);
});

test('one render is shared by every channel, each gets the image, and the original message is not changed', async () => {
  const renderer = fakeRenderer();
  const [discord, telegram] = withImages([recorder('discord'), recorder('telegram')], { renderer, baseUrl: BASE });
  const m = message({ chart: CHART });
  await Promise.all([discord.send(m), telegram.send(m)]);
  assert.equal(renderer.calls.length, 1);
  assert.deepEqual(renderer.calls[0], CHART);
  assert.equal(discord.sent[0].image, PNG);
  assert.equal(telegram.sent[0].image, PNG);
  assert.equal('image' in m, false);
  assert.deepEqual([discord.name, telegram.name], ['discord', 'telegram']);
});

test('a retry of the same message does not render again', async () => {
  const renderer = fakeRenderer();
  const [n] = withImages([recorder('discord')], { renderer, baseUrl: BASE });
  const m = message({ chart: CHART });
  await n.send(m);
  await n.send(m);
  assert.equal(renderer.calls.length, 1);
});

test('when the render fails every channel gets the text plus a dashboard link, and the reason is logged once', async () => {
  const logged = [];
  const renderer = fakeRenderer(async () => { throw new RenderError('cap', 'image limit reached (6 per hour)'); });
  const [discord, telegram] = withImages([recorder('discord'), recorder('telegram')], { renderer, baseUrl: BASE, log: (t) => logged.push(t) });
  const m = message({ chart: CHART });
  await Promise.all([discord.send(m), telegram.send(m)]);
  for (const n of [discord, telegram]) {
    assert.equal('image' in n.sent[0], false);
    assert.deepEqual(n.sent[0].lines, [...m.lines, `Chart: ${BASE}/?symbol=BINANCE%3ABTCUSDT&tf=60&t=1760000000`]);
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /image limit reached/);
  assert.equal(m.lines.length, 2, 'the original lines are not edited');
});

test('a renderer that throws something that is not a RenderError falls back the same way', async () => {
  const renderer = fakeRenderer(async () => { throw new TypeError('boom'); });
  const [n] = withImages([recorder('discord')], { renderer, baseUrl: BASE });
  await n.send(message({ chart: CHART }));
  assert.match(n.sent[0].lines.at(-1), /^Chart: http:\/\/127\.0\.0\.1:8788\/\?symbol=/);
});

test('a send that fails still fails (the queue must retry it), with or without an image', async () => {
  const failing = { name: 'discord', send: async () => { throw new NotifierError('Discord answered HTTP 500', { status: 500 }); } };
  const [n] = withImages([failing], { renderer: fakeRenderer(), baseUrl: BASE });
  await assert.rejects(n.send(message({ chart: CHART })), (err) => err.status === 500);
});

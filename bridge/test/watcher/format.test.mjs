import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  timeframeLabel, timeframeSeconds, zonedParts, localDate, formatLocal, formatUtc, formatUptime,
  chartUrl, renderRuleAlert, renderTrendAlert, renderHealthAlert, renderHeartbeat, renderDigest,
  renderNotify, renderTest, plainText, truncate, htmlTruncate, escapeHtml, createLogger,
} from '../../lib/format.mjs';
import { makeRedactor } from '../../lib/redact.mjs';

test('timeframe labels follow the brief (1 -> 1m, 60 -> 1h, 240 -> 4h, D -> 1D)', () => {
  assert.equal(timeframeLabel('1'), '1m');
  assert.equal(timeframeLabel('60'), '1h');
  assert.equal(timeframeLabel('240'), '4h');
  assert.equal(timeframeLabel('D'), '1D');
  assert.equal(timeframeLabel('W'), '1W');
  assert.equal(timeframeLabel('120'), '2h');
});

test('timeframe seconds are known for minutes and the day, week and month codes', () => {
  assert.equal(timeframeSeconds('15'), 900);
  assert.equal(timeframeSeconds('D'), 86400);
  assert.equal(timeframeSeconds('W'), 604800);
  assert.equal(timeframeSeconds('bogus'), null);
});

test('zonedParts reads calendar fields and ISO weekday in a named zone', () => {
  // 2026-10-10 14:00 UTC is 10:00 in New York (EDT, UTC-4)
  const ms = Date.UTC(2026, 9, 10, 14, 0, 0);
  const ny = zonedParts(ms, 'America/New_York');
  assert.equal(ny.hour, 10);
  assert.equal(ny.minute, 0);
  assert.equal(localDate(ms, 'America/New_York'), '2026-10-10');
  const expectedWeekday = ((new Date(ms).getUTCDay() + 6) % 7) + 1;
  assert.equal(zonedParts(ms, 'UTC').weekday, expectedWeekday);
});

test('formatLocal and formatUtc show the zone abbreviation and the UTC time', () => {
  const ms = Date.UTC(2026, 9, 10, 14, 5, 0);
  assert.equal(formatLocal(ms, 'America/New_York'), '2026-10-10 10:05 EDT');
  assert.equal(formatUtc(ms), '2026-10-10 14:05 UTC');
});

test('formatUptime gives days and hours, hours and minutes, or minutes', () => {
  assert.equal(formatUptime(273600), '3d 4h');
  assert.equal(formatUptime(7500), '2h 5m');
  assert.equal(formatUptime(90), '1m');
});

test('chart links encode the symbol', () => {
  assert.equal(chartUrl('BINANCE:BTCUSDT'), 'https://www.tradingview.com/chart/?symbol=BINANCE%3ABTCUSDT');
});

test('a rule alert has the brief title, the rule message, values, bar close times, data age and a chart link', () => {
  const now = Date.UTC(2026, 9, 10, 14, 10, 0);
  const hit = {
    ruleId: 'move', type: 'pct_move', symbol: 'BINANCE:BTCUSDT', timeframe: '60',
    barTime: Date.UTC(2026, 9, 10, 13, 0, 0) / 1000, direction: 'up',
    values: { pct: 3.4, close: 67250.1 }, message: 'Up 3.4% over 4 bars',
  };
  const msg = renderRuleAlert(hit, { timezone: 'America/New_York', now, dataAtMs: now - 4000 });
  assert.equal(msg.level, 'up');
  assert.equal(msg.title, '🟢 BINANCE:BTCUSDT · 1h · pct_move');
  assert.equal(msg.lines[0], 'Up 3.4% over 4 bars');
  assert.equal(msg.lines[1], 'pct=3.4, close=67,250.1');
  assert.equal(msg.lines[2], 'Bar closed: 2026-10-10 10:00 EDT (2026-10-10 14:00 UTC)');
  assert.equal(msg.lines[3], 'Data age: 4s');
  assert.equal(msg.lines[4], 'Rule: move');
  assert.equal(msg.url, 'https://www.tradingview.com/chart/?symbol=BINANCE%3ABTCUSDT');
  assert.equal(msg.timestamp, new Date(now).toISOString());
});

test('a down rule alert uses the red marker and omits data age when there is no data time', () => {
  const hit = {
    ruleId: 'r', type: 'price_cross', symbol: 'X:Y', timeframe: 'D', barTime: 1_700_000_000,
    direction: 'down', values: {}, message: 'Crossed 100 downward',
  };
  const msg = renderRuleAlert(hit, { timezone: 'UTC', now: Date.UTC(2026, 0, 1) });
  assert.equal(msg.title, '🔴 X:Y · 1D · price_cross');
  assert.ok(!msg.lines.some((line) => line.startsWith('Data age')));
});

test('trend alerts colour gainers green, losers red and other kinds blue, and format change as a percentage', () => {
  const base = { market: 'crypto', rank: 2, symbol: 'BYBIT:XYZUSDT', now: Date.UTC(2026, 9, 10), timezone: 'UTC' };
  const values = { name: 'XYZ', close: 1.5, change: 12.345, volume: 1000000, relative_volume_10d_calc: 2.5 };
  const gainers = renderTrendAlert({ ...base, kind: 'gainers', values });
  assert.equal(gainers.level, 'up');
  assert.equal(gainers.title, '🟢 BYBIT:XYZUSDT · trending crypto gainers');
  assert.match(gainers.lines[1], /Change: \+12\.35%/);
  assert.equal(renderTrendAlert({ ...base, kind: 'losers', values }).level, 'down');
  assert.equal(renderTrendAlert({ ...base, kind: 'volumeGainers', values }).level, 'info');
});

test('health alerts say stream down (red) or recovered (green) and never include secrets', () => {
  const now = Date.UTC(2026, 9, 10);
  const down = renderHealthAlert({ event: 'down', symbol: 'BINANCE:BTCUSDT', timeframe: '15', silentMinutes: 11.4, now });
  assert.equal(down.level, 'down');
  assert.equal(down.title, '🔴 BINANCE:BTCUSDT · 15m · stream down');
  assert.equal(down.lines[0], 'No data for 11 min. The watcher keeps retrying.');
  const up = renderHealthAlert({ event: 'recovered', symbol: 'BINANCE:BTCUSDT', timeframe: '15', now });
  assert.equal(up.level, 'up');
  assert.equal(up.title, '🟢 BINANCE:BTCUSDT · 15m · stream recovered');
});

test('the heartbeat reports credentials as yes or no, never their values', () => {
  const msg = renderHeartbeat({
    uptimeSeconds: 90000, healthy: 6, total: 7, alerts24h: 12, credentials: true,
    now: Date.UTC(2026, 9, 10, 12), timezone: 'UTC',
  });
  assert.equal(msg.title, 'ℹ️ Watcher daily heartbeat');
  assert.ok(msg.lines.includes('Uptime: 1d 1h'));
  assert.ok(msg.lines.includes('Streams healthy: 6 of 7'));
  assert.ok(msg.lines.includes('TradingView credentials in use: yes'));
});

test('digest and test messages have fixed titles', () => {
  const now = Date.UTC(2026, 9, 10, 12);
  assert.equal(renderDigest([{ summary: 'a' }], { reason: 'quiet', now, timezone: 'UTC' }).lines[0],
    'Held during quiet hours:');
  assert.equal(renderDigest([{ summary: 'a' }], { reason: 'rate', now, timezone: 'UTC' }).lines[0],
    'Over the hourly limit:');
  assert.equal(renderTest(now).title, '✅ tradingview watcher test');
});

test('renderNotify maps the level to a marker and keeps unknown levels as info', () => {
  const now = Date.UTC(2026, 9, 10);
  assert.equal(renderNotify({ title: 'Paper fill', body: 'bought', level: 'up', now }).title, '🟢 Paper fill');
  const odd = renderNotify({ title: 'x', level: 'purple', now });
  assert.equal(odd.level, 'info');
  assert.equal(odd.title, 'ℹ️ x');
});

test('plainText joins title, lines and the link', () => {
  const text = plainText({ title: 'T', lines: ['a', 'b'], url: 'https://x.example/' });
  assert.equal(text, 'T\na\nb\nhttps://x.example/');
});

test('truncate adds an ellipsis and never leaves a lone surrogate', () => {
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abcdef', 4), 'abc…');
  const emoji = '😀😀😀';
  const cut = truncate(emoji, 4); // 4 units would split the second emoji
  assert.ok(!/[\uD800-\uDBFF]$/.test(cut.slice(0, -1)), 'no dangling high surrogate');
  assert.ok(cut.endsWith('…'));
});

test('escapeHtml escapes the four characters Telegram needs', () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

test('htmlTruncate never cuts an entity in half and stays within the limit', () => {
  const out = htmlTruncate('a<b & c', 6);
  assert.equal(out, 'a&lt;…');
  assert.ok(htmlTruncate('&'.repeat(100), 50).length <= 50);
  assert.equal(htmlTruncate('short', 50), 'short');
});

test('the logger writes text or JSON lines and redacts every line', () => {
  const env = {
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123456789/SECRET_WEBHOOK_PART',
    TELEGRAM_BOT_TOKEN: '987654:SECRET_BOT_TOKEN_VALUE',
    TELEGRAM_CHAT_ID: '4242',
  };
  const redact = makeRedactor(env);
  const written = [];
  const now = () => Date.UTC(2026, 9, 10, 12);
  const text = createLogger({ write: (line) => written.push(line), redact, now });
  text.info(`posting to ${env.DISCORD_WEBHOOK_URL}`);
  text.error(`telegram ${env.TELEGRAM_BOT_TOKEN} failed`);

  const json = createLogger({ write: (line) => written.push(line), redact, json: true, now });
  json.warn('stream down', { symbol: 'BINANCE:BTCUSDT' });

  assert.equal(written.length, 3);
  assert.equal(written[0], '2026-10-10T12:00:00.000Z INFO posting to [REDACTED]\n');
  assert.equal(written[1], '2026-10-10T12:00:00.000Z ERROR telegram [REDACTED] failed\n');
  const parsed = JSON.parse(written[2]);
  assert.equal(parsed.level, 'warn');
  assert.equal(parsed.symbol, 'BINANCE:BTCUSDT');
  for (const line of written) {
    assert.ok(!line.includes('SECRET_WEBHOOK_PART'));
    assert.ok(!line.includes('SECRET_BOT_TOKEN_VALUE'));
    assert.ok(!line.includes('discord.com/api/webhooks'));
  }
});

test('a failing log sink never throws into the caller', () => {
  const log = createLogger({ write: () => { throw new Error('closed pipe'); }, now: () => 0 });
  assert.doesNotThrow(() => log.info('still fine'));
});

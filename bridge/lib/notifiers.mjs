/**
 * Discord and Telegram senders, plus the dry-run printer. All use the global
 * `fetch` (or an injected one), so no dependency is needed.
 *
 * Rules shared by every sender:
 * - The URL and the token are never put in an error or a log. Errors carry only
 *   the HTTP status, and any URL text from the transport is scrubbed.
 * - On HTTP 429 the error carries `retryAfterSec` from the server (Discord
 *   `retry_after`, Telegram `parameters.retry_after`), which the queue honours.
 */
import { errorMessage } from './errors.mjs';
import { escapeHtml, htmlTruncate, plainText, truncate } from './format.mjs';
import { isDiscordWebhookUrl, isTelegramToken } from './config.mjs';

export const DISCORD_CONTENT_LIMIT = 2000;
export const DISCORD_TITLE_LIMIT = 256;
export const DISCORD_DESCRIPTION_LIMIT = 4096;
export const TELEGRAM_TEXT_LIMIT = 4096;
export const REQUEST_TIMEOUT_MS = 10_000;
const COLORS = Object.freeze({ up: 0x2ecc71, down: 0xe74c3c, info: 0x3498db });

export class NotifierError extends Error {
  constructor(message, { status, retryAfterSec } = {}) {
    super(message);
    this.name = 'NotifierError';
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

/** Discord webhook body: content up to 2000, an embed with description up to 4096. */
export function discordPayload(message) {
  const title = truncate(message.title, DISCORD_TITLE_LIMIT);
  const description = truncate(message.lines.join('\n'), DISCORD_DESCRIPTION_LIMIT);
  return {
    content: truncate(message.title, DISCORD_CONTENT_LIMIT),
    embeds: [{
      title,
      ...(description === '' ? {} : { description }),
      color: COLORS[message.level] ?? COLORS.info,
      timestamp: message.timestamp,
      ...(message.url ? { url: message.url } : {}),
    }],
  };
}

/** Telegram sendMessage body: HTML, every user text escaped, at most 4096 characters. */
export function telegramPayload(message, chatId) {
  const head = `<b>${htmlTruncate(message.title, 300)}</b>`;
  const link = message.url ? `\n<a href="${escapeHtml(message.url)}">Chart</a>` : '';
  const budget = TELEGRAM_TEXT_LIMIT - head.length - link.length - 1;
  const body = message.lines.length > 0 && budget > 0
    ? `\n${htmlTruncate(message.lines.join('\n'), budget)}`
    : '';
  return {
    chat_id: chatId,
    text: `${head}${body}${link}`,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
}

async function postJson({ label, url, body, fetch, redact, timeoutMs, pickRetryAfter }) {
  // Scrub the URL out of anything the transport reports. Node's fetch errors may echo it.
  const scrub = (text) => redact(String(text).split(url).join('[url]'));
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new NotifierError(`${label} request failed: ${scrub(errorMessage(err))}`);
  }

  const text = await res.text().catch(() => '');
  if (res.ok) return;

  let retryAfterSec;
  if (res.status === 429) {
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const fromBody = pickRetryAfter(data);
    const fromHeader = Number(res.headers.get('retry-after'));
    retryAfterSec = Number.isFinite(fromBody) && fromBody > 0 ? fromBody : fromHeader;
  }
  throw new NotifierError(`${label} answered HTTP ${res.status}`, { status: res.status, retryAfterSec });
}

/** Discord webhook sender. `url` is never logged. */
export function createDiscordNotifier({
  url,
  fetch = globalThis.fetch,
  redact = (text) => text,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  if (!isDiscordWebhookUrl(url)) throw new TypeError('Discord notifier needs a Discord webhook URL');
  return {
    name: 'discord',
    send(message) {
      return postJson({
        label: 'Discord',
        url,
        body: discordPayload(message),
        fetch,
        redact,
        timeoutMs,
        pickRetryAfter: (data) => data?.retry_after,
      });
    },
  };
}

/** Telegram bot sender. The token lives only inside the request URL. */
export function createTelegramNotifier({
  token,
  chatId,
  fetch = globalThis.fetch,
  redact = (text) => text,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  if (!isTelegramToken(token)) throw new TypeError('Telegram notifier needs a bot token');
  if (typeof chatId !== 'string' || chatId === '') throw new TypeError('Telegram notifier needs a chat id');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  return {
    name: 'telegram',
    send(message) {
      return postJson({
        label: 'Telegram',
        url,
        body: telegramPayload(message, chatId),
        fetch,
        redact,
        timeoutMs,
        pickRetryAfter: (data) => data?.parameters?.retry_after,
      });
    },
  };
}

/** Dry run: prints each alert through `write` instead of sending it. */
export function createStdoutNotifier({ write, redact = (text) => text }) {
  return {
    name: 'dry-run',
    async send(message) {
      write(`${redact(plainText(message))}\n\n`);
    },
  };
}

/**
 * The notifiers configured by the environment (names are DISCORD_WEBHOOK_URL,
 * TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID). A channel is used only when all of
 * its values are present and well formed.
 */
export function buildNotifiers({ env = process.env, fetch = globalThis.fetch, redact = (text) => text }) {
  const notifiers = [];
  if (isDiscordWebhookUrl(env.DISCORD_WEBHOOK_URL)) {
    notifiers.push(createDiscordNotifier({ url: env.DISCORD_WEBHOOK_URL, fetch, redact }));
  }
  if (isTelegramToken(env.TELEGRAM_BOT_TOKEN) && typeof env.TELEGRAM_CHAT_ID === 'string' && env.TELEGRAM_CHAT_ID !== '') {
    notifiers.push(createTelegramNotifier({
      token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, fetch, redact,
    }));
  }
  return notifiers;
}

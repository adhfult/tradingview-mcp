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
import { deepLink } from './render.mjs';

export const DISCORD_CONTENT_LIMIT = 2000;
export const DISCORD_TITLE_LIMIT = 256;
export const DISCORD_DESCRIPTION_LIMIT = 4096;
export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;
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
    // Text from the local API or from TradingView must never be able to ping @everyone or a role.
    allowed_mentions: { parse: [] },
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

const hasImage = (message) => message.image instanceof Uint8Array && message.image.length > 0;
/**
 * Telegram counts a caption's length after the HTML is parsed: tags and link addresses do not count and an entity is
 * one character. A refusal of the picture itself (400: no right to send photos, 413: too large) says nothing about the
 * text, so the same alert is sent again without the picture; any other failure is the queue's to retry.
 */
const captionLength = (html) => html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;|&#\d+;/gi, 'x').length;
const pictureRefused = (err) => err instanceof NotifierError && (err.status === 400 || err.status === 413);
const pngBlob = (bytes) => new Blob([bytes], { type: 'image/png' });

/** Discord: the same JSON, as `payload_json` beside the PNG when there is an image; plain JSON otherwise. */
function discordBody(message) {
  const payload = discordPayload(message);
  if (!hasImage(message)) return payload;
  payload.embeds[0].image = { url: 'attachment://chart.png' };
  const form = new FormData();
  form.set('payload_json', JSON.stringify(payload));
  form.set('files[0]', pngBlob(message.image), 'chart.png');
  return form;
}

async function postJson({ label, url, body, fetch, redact, timeoutMs, pickRetryAfter, secrets = [] }) {
  // Scrub the URL (and any other secret part of it) out of anything the transport reports.
  // Node's fetch errors may echo it.
  const scrub = (text) => {
    let out = String(text).split(url).join('[url]');
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join('[secret]');
    }
    return redact(out);
  };
  let res;
  try {
    // A FormData body is sent as is: fetch writes the multipart content-type with its boundary itself.
    const multipart = body instanceof FormData;
    res = await fetch(url, {
      method: 'POST',
      headers: multipart ? {} : { 'content-type': 'application/json' },
      body: multipart ? body : JSON.stringify(body),
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
  // The last path segment is the webhook secret; scrub it on its own too.
  const webhookToken = new URL(url).pathname.split('/').filter(Boolean).pop();
  return {
    name: 'discord',
    async send(message) {
      const post = (body) => postJson({
        label: 'Discord', url, body, fetch, redact, timeoutMs, pickRetryAfter: (data) => data?.retry_after, secrets: [webhookToken],
      });
      if (!hasImage(message)) return post(discordPayload(message));
      try {
        return await post(discordBody(message));
      } catch (err) {
        if (!pictureRefused(err)) throw err;
        return post(discordPayload(message));
      }
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
  const photoUrl = `https://api.telegram.org/bot${token}/sendPhoto`;
  return {
    name: 'telegram',
    async send(message) {
      const payload = telegramPayload(message, chatId);
      const post = (target, body) => postJson({
        label: 'Telegram', url: target, body, fetch, redact, timeoutMs, pickRetryAfter: (data) => data?.parameters?.retry_after, secrets: [token],
      });
      // A caption is capped at 1024 characters. Cutting the alert to fit would lose its text, so a longer one goes as a
      // plain message and the picture is dropped.
      if (hasImage(message) && captionLength(payload.text) <= TELEGRAM_CAPTION_LIMIT) {
        const form = new FormData();
        form.set('chat_id', chatId);
        form.set('parse_mode', 'HTML');
        form.set('caption', payload.text);
        form.set('photo', pngBlob(message.image), 'chart.png');
        try {
          return await post(photoUrl, form);
        } catch (err) {
          if (!pictureRefused(err)) throw err;
        }
      }
      return post(url, payload);
    },
  };
}

/**
 * Notifiers that attach a chart image to messages that have a `chart` (rule alerts). The image is made once per message,
 * on first use, and shared by every channel and every retry. When it cannot be made, the alert goes out as text with a
 * link to the dashboard chart (`baseUrl`, a string or a function that returns one, or null when there is no dashboard to
 * link to), and the reason is logged. With no renderer the notifiers are returned unchanged.
 */
export function withImages(notifiers, { renderer, baseUrl, log = () => {} }) {
  if (renderer === null || renderer === undefined) return notifiers;
  const jobs = new WeakMap();
  const prepare = (message) => {
    if (!jobs.has(message)) {
      jobs.set(message, renderer.render(message.chart).then(
        (image) => ({ ...message, image }),
        (err) => {
          log(`chart image skipped (${err?.reason ?? 'error'}): ${errorMessage(err)}`);
          const base = typeof baseUrl === 'function' ? baseUrl() : baseUrl;
          return base === null ? message : { ...message, lines: [...message.lines, `Chart: ${deepLink(base, message.chart)}`] };
        },
      ));
    }
    return jobs.get(message);
  };
  return notifiers.map((notifier) => ({
    ...notifier,
    send: async (message) => notifier.send(message.chart === undefined ? message : await prepare(message)),
  }));
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

/** Environment variables whose values must never appear in output or logs. */
export const SECRET_ENV_VARS = Object.freeze([
  'TRADINGVIEW_SESSION_ID',
  'TRADINGVIEW_SESSION_SIGN',
  'DISCORD_WEBHOOK_URL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'WATCHER_DASHBOARD_TOKEN',
  'WATCHER_LOCAL_TOKEN',
  'FINNHUB_API_KEY',
]);

const MIN_SECRET_LENGTH = 4;

function safeEncode(value) {
  try {
    return encodeURIComponent(value);
  } catch {
    return value;
  }
}

const PATTERNS = [
  [/sessionid(_sign)?=[^;\s]+/gi, 'sessionid$1=[REDACTED]'],
  [/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]'],
  [/https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\S+/gi, '[REDACTED_WEBHOOK]'],
  // JSON or colon forms of the cookie names, e.g. "sessionid":"abc" or sessionid: abc.
  [/(["']?sessionid(?:_sign)?["']?\s*:\s*["']?)[^"'\s;,}&]+/gi, '$1[REDACTED]'],
  // Websocket auth tokens are JWTs; they are never an env secret, so match the shape.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]'],
];

/**
 * Returns a function that removes secrets from text. Secret values come from
 * `env` (only the names in SECRET_ENV_VARS, and only values of 4+ characters);
 * the patterns catch session cookies, Telegram tokens and Discord webhooks.
 */
export function makeRedactor(env = process.env) {
  const secrets = SECRET_ENV_VARS
    .map((name) => env[name])
    .filter((value) => typeof value === 'string' && value.length >= MIN_SECRET_LENGTH)
    .flatMap((value) => {
      // Messages may carry the URL-encoded or JSON-escaped form of a secret.
      const variants = new Set([value, safeEncode(value), JSON.stringify(value).slice(1, -1)]);
      return [...variants].filter((variant) => variant.length >= MIN_SECRET_LENGTH);
    })
    .sort((a, b) => b.length - a.length);

  return (text) => {
    let out = String(text);
    for (const secret of secrets) {
      out = out.split(secret).join('[REDACTED]');
    }
    for (const [pattern, replacement] of PATTERNS) {
      out = out.replace(pattern, replacement);
    }
    return out;
  };
}

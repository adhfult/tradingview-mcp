/**
 * Message text, time helpers and the redacted logger.
 *
 * A message is `{level, title, lines, url?, timestamp}`:
 *   level: "up" (green), "down" (red) or "info" (blue)
 * Notifiers turn a message into Discord or Telegram payloads. Nothing here sends
 * anything or reads secrets.
 */

export const LEVEL_EMOJI = Object.freeze({ up: '🟢', down: '🔴', info: 'ℹ️' });

const TIMEFRAME_LABELS = Object.freeze({
  1: '1m', 3: '3m', 5: '5m', 15: '15m', 30: '30m', 45: '45m',
  60: '1h', 120: '2h', 180: '3h', 240: '4h', D: '1D', W: '1W', M: '1M',
});
const TIMEFRAME_SECONDS = Object.freeze({
  D: 86_400, W: 604_800, M: 2_592_000, // a month is approximate; bar closes use the next bar's time
});
const WEEKDAYS = Object.freeze({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 });

export function timeframeLabel(timeframe) {
  return TIMEFRAME_LABELS[timeframe] ?? String(timeframe);
}

/** Bar length in seconds, or null when unknown. */
export function timeframeSeconds(timeframe) {
  if (TIMEFRAME_SECONDS[timeframe] !== undefined) return TIMEFRAME_SECONDS[timeframe];
  const minutes = Number(timeframe);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : null;
}

/**
 * Calendar parts of an instant in a time zone, from Intl.DateTimeFormat parts
 * (no libraries). `weekday` is 1 (Monday) to 7 (Sunday).
 */
const formatters = new Map();

function formatterFor(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      timeZoneName: 'short',
    }));
  }
  return formatters.get(timeZone);
}

export function zonedParts(ms, timeZone) {
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday],
    zoneName: parts.timeZoneName,
  };
}

/** Local calendar date as YYYY-MM-DD. */
export function localDate(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Minutes after local midnight. */
export function localMinutes(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return p.hour * 60 + p.minute;
}

/** "2026-10-10 14:00 EDT" in the given zone. */
export function formatLocal(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${localDate(ms, timeZone)} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ${p.zoneName}`;
}

/** "2026-10-10 18:00 UTC". */
export function formatUtc(ms) {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Hours and minutes as "3d 4h", "2h 5m" or "12m". */
export function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function chartUrl(symbol) {
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`;
}

export function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  if (Math.abs(value) >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return String(Number(value.toPrecision(6)));
}

function formatValue(value) {
  if (typeof value === 'number') return formatNumber(value);
  if (value === null || value === undefined) return 'n/a';
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  return String(value);
}

/** "close=67250.1, ref_close=65000" style text for the key values of a hit. */
function valuesLine(values) {
  return Object.entries(values ?? {}).map(([key, value]) => `${key}=${formatValue(value)}`).join(', ');
}

const ISO = (ms) => new Date(ms).toISOString();

/**
 * Plain-text truncation, adding an ellipsis. Cuts on a code point boundary.
 * The length is UTF-16 units (conservative for Discord and Telegram limits).
 */
export function truncate(text, limit) {
  const value = String(text);
  if (value.length <= limit) return value;
  let cut = value.slice(0, Math.max(0, limit - 1));
  // Do not leave a lone high surrogate at the end.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Escapes text for Telegram HTML and truncates the escaped result to `limit` units. */
export function htmlTruncate(text, limit) {
  const full = escapeHtml(text);
  if (full.length <= limit) return full;
  let out = '';
  for (const ch of String(text)) {
    const piece = escapeHtml(ch);
    if (out.length + piece.length > limit - 1) break;
    out += piece;
  }
  return `${out}…`;
}

/** Plain text of a message, as printed by --dry-run and used for logs. */
export function plainText(message) {
  const lines = [message.title, ...message.lines];
  if (message.url) lines.push(message.url);
  return lines.join('\n');
}

function rule(hit, { timezone, now, dataAtMs, closeTimeSec }) {
  const emoji = LEVEL_EMOJI[hit.direction] ?? LEVEL_EMOJI.info;
  const lines = [hit.message];
  if (hit.values !== undefined) lines.push(valuesLine(hit.values));
  const seconds = timeframeSeconds(hit.timeframe);
  const closeSec = closeTimeSec ?? (seconds === null ? null : hit.barTime + seconds);
  if (closeSec !== null) {
    const closeMs = closeSec * 1000;
    lines.push(`Bar closed: ${formatLocal(closeMs, timezone)} (${formatUtc(closeMs)})`);
  }
  if (dataAtMs !== undefined && dataAtMs !== null) {
    lines.push(`Data age: ${Math.max(0, Math.round((now - dataAtMs) / 1000))}s`);
  }
  lines.push(`Rule: ${hit.ruleId}`);
  return {
    level: hit.direction === 'down' ? 'down' : 'up',
    title: `${emoji} ${hit.symbol} · ${timeframeLabel(hit.timeframe)} · ${hit.type}`,
    lines,
    url: chartUrl(hit.symbol),
    timestamp: ISO(now),
  };
}

/** Message for a rule hit on a closed bar. `dataAtMs` is when the data arrived. */
export function renderRuleAlert(hit, options) {
  return rule(hit, options);
}

const TREND_LABELS = Object.freeze({
  name: 'Name', close: 'Price', change: 'Change', volume: 'Volume', relative_volume_10d_calc: 'Rel vol (10d)',
});

function formatTrendValue(key, value) {
  if (key === 'change' && typeof value === 'number') return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
  if (key === 'relative_volume_10d_calc' && typeof value === 'number') return `${value.toFixed(2)}x`;
  return formatValue(value);
}

/**
 * One message for several symbols that just entered the same market x kind list.
 * `entries`: [{rank, symbol, values}].
 */
export function renderTrendBatch({ market, kind, entries, now, timezone }) {
  const level = kind === 'gainers' ? 'up' : kind === 'losers' ? 'down' : 'info';
  const shown = entries.slice(0, BATCH_LINE_LIMIT).map(({ rank, symbol, values = {} }) => {
    const parts = ['close', 'change', 'relative_volume_10d_calc']
      .filter((key) => values[key] !== undefined && values[key] !== null)
      .map((key) => formatTrendValue(key, values[key]));
    return `• #${rank} ${symbol}${parts.length > 0 ? ` · ${parts.join(' · ')}` : ''}`;
  });
  if (entries.length > BATCH_LINE_LIMIT) shown.push(`…and ${entries.length - BATCH_LINE_LIMIT} more`);
  return {
    level,
    title: `${LEVEL_EMOJI[level]} ${entries.length} new in trending ${market} ${kind}`,
    lines: [...shown, `Scanned: ${formatLocal(now, timezone)}`],
    timestamp: ISO(now),
  };
}

/** Message for a new trending entry (one symbol that just entered the top list). */
export function renderTrendAlert({ market, kind, rank, symbol, values = {}, now, timezone }) {
  const level = kind === 'gainers' ? 'up' : kind === 'losers' ? 'down' : 'info';
  const lines = [`Ranked #${rank} in ${market} ${kind}, not seen in the remember window.`];
  const parts = Object.entries(values)
    .filter(([key]) => TREND_LABELS[key] !== undefined && key !== 'name')
    .map(([key, value]) => `${TREND_LABELS[key]}: ${formatTrendValue(key, value)}`);
  if (parts.length > 0) lines.push(parts.join(' · '));
  lines.push(`Scanned: ${formatLocal(now, timezone)}`);
  return {
    level,
    title: `${LEVEL_EMOJI[level]} ${symbol} · trending ${market} ${kind}`,
    lines,
    url: chartUrl(symbol),
    timestamp: ISO(now),
  };
}

const CONNECTION_CODES = ['CONNECTION_ERROR', 'DISCONNECTED', 'PROTOCOL_ERROR', 'TIMEOUT'];

/** One line that says what the last error codes most likely mean, or '' when unclear. */
export function healthHint(errors) {
  const codes = errors.filter((code) => typeof code === 'string' && code !== '');
  if (codes.length === 0) return '';
  if (codes.every((code) => code === 'AUTH_ERROR')) {
    return 'Looks like an expired or invalid TradingView login (AUTH_ERROR): refresh TRADINGVIEW_SESSION_ID and TRADINGVIEW_SESSION_SIGN.';
  }
  if (codes.every((code) => CONNECTION_CODES.includes(code))) {
    return 'Looks like TradingView is unreachable (connection errors). The watcher keeps retrying.';
  }
  if (codes.every((code) => ['SYMBOL_ERROR', 'NO_DATA', 'SERIES_ERROR', 'INVALID_ARGUMENT'].includes(code))) {
    return 'Looks like the symbol is wrong or has no data for your account.';
  }
  return '';
}

/** Message for a stream that went quiet, or that came back. */
export function renderHealthAlert({ event, symbol, timeframe, silentMinutes = 0, error = null, now }) {
  const tf = timeframeLabel(timeframe);
  if (event === 'down') {
    const lines = [`No data for ${Math.round(silentMinutes)} min. The watcher keeps retrying.`];
    if (error) lines.push(`Last error: ${error}`);
    const hint = healthHint([error]);
    if (hint) lines.push(hint);
    return {
      level: 'down',
      title: `${LEVEL_EMOJI.down} ${symbol} · ${tf} · stream down`,
      lines,
      timestamp: ISO(now),
    };
  }
  return {
    level: 'up',
    title: `${LEVEL_EMOJI.up} ${symbol} · ${tf} · stream recovered`,
    lines: ['Data is flowing again.'],
    timestamp: ISO(now),
  };
}

const BATCH_LINE_LIMIT = 30;

/**
 * One message for several streams that went quiet (or came back) in the same health check.
 * `items`: [{symbol, timeframe, error?}]. Down messages carry each stream's last error code
 * and a one-line diagnosis.
 */
export function renderHealthBatch({ event, items, now }) {
  const count = items.length;
  const down = event === 'down';
  const shown = items.slice(0, BATCH_LINE_LIMIT).map((item) => {
    const error = down && item.error ? ` (${item.error})` : '';
    return `• ${item.symbol} · ${timeframeLabel(item.timeframe)}${error}`;
  });
  if (count > BATCH_LINE_LIMIT) shown.push(`…and ${count - BATCH_LINE_LIMIT} more`);
  const lines = down
    ? [`No data from ${count} streams. The watcher keeps retrying.`, ...shown]
    : [`Data is flowing again on ${count} streams.`, ...shown];
  if (down) {
    const hint = healthHint(items.map((item) => item.error));
    if (hint) lines.push(hint);
  }
  return {
    level: down ? 'down' : 'up',
    title: `${down ? LEVEL_EMOJI.down : LEVEL_EMOJI.up} ${count} streams ${down ? 'down' : 'recovered'}`,
    lines,
    timestamp: ISO(now),
  };
}

/** The daily heartbeat. It holds counts only, never credential values. */
export function renderHeartbeat({ uptimeSeconds, healthy, total, alerts24h, credentials, now, timezone }) {
  return {
    level: 'info',
    title: `${LEVEL_EMOJI.info} Watcher daily heartbeat`,
    lines: [
      `Uptime: ${formatUptime(uptimeSeconds)}`,
      `Streams healthy: ${healthy} of ${total}`,
      `Alerts in the last 24h: ${alerts24h}`,
      `TradingView credentials in use: ${credentials ? 'yes' : 'no'}`,
      `Local time: ${formatLocal(now, timezone)}`,
    ],
    timestamp: ISO(now),
  };
}

/** A message sent through the local API (POST /notify). */
export function renderNotify({ title, body = '', level = 'info', now }) {
  const emoji = LEVEL_EMOJI[level] ?? LEVEL_EMOJI.info;
  return {
    level: LEVEL_EMOJI[level] ? level : 'info',
    title: `${emoji} ${title}`,
    lines: body === '' ? [] : [body],
    timestamp: ISO(now),
  };
}

const DIGEST_LINE_LIMIT = 30;

/**
 * One message that summarises alerts held by quiet hours or the hourly cap.
 * `reason` is "quiet", "rate" or "mixed". Long digests list the first items and
 * a count of the rest.
 */
export function renderDigest(items, { reason = 'mixed', now, timezone }) {
  const count = items.length;
  const heading = {
    quiet: 'Held during quiet hours:',
    rate: 'Over the hourly limit:',
  }[reason] ?? 'Summary:';
  const shown = items.slice(0, DIGEST_LINE_LIMIT).map((item) => `• ${item.summary}`);
  if (count > DIGEST_LINE_LIMIT) shown.push(`…and ${count - DIGEST_LINE_LIMIT} more`);
  return {
    level: 'info',
    title: `${LEVEL_EMOJI.info} ${count} alert${count === 1 ? '' : 's'} summarised`,
    lines: [heading, ...shown, `Sent: ${formatLocal(now, timezone)}`],
    timestamp: ISO(now),
  };
}

export function renderTest(now) {
  return {
    level: 'info',
    title: '✅ tradingview watcher test',
    lines: ['If you can read this, this channel works.'],
    timestamp: ISO(now),
  };
}

/**
 * A logger that writes one line per call (text or JSON), passing every line
 * through `redact` first. `write` receives the finished line plus a newline.
 */
export function createLogger({ write, redact = (text) => text, json = false, now = Date.now }) {
  const emit = (level, message, fields) => {
    const iso = ISO(now());
    let line;
    if (json) {
      line = JSON.stringify({ t: iso, level, msg: String(message), ...(fields ?? {}) });
    } else {
      line = `${iso} ${level.toUpperCase()} ${message}`;
    }
    try {
      write(`${redact(line)}\n`);
    } catch {
      // A failing log sink must never break the watcher.
    }
  };
  return {
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

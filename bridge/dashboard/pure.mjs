/**
 * The page's DOM-free helpers: no document, no fetch, nothing that cannot run in Node, so each is a table test.
 * app.mjs re-exports them (the tests import them from there) and the panel modules import them from here.
 */

// ---------------------------------------------------------------- pure functions

const TIMEFRAME_SECONDS = { D: 86_400, W: 604_800, M: 2_678_400 };
const STALE_BARS = 3;

export const streamKey = (s) => `${s.symbol}|${s.timeframe}`;

/** Bar length in seconds: minutes as a number ("60"), or D / W / M. Null when unknown. */
export function timeframeSeconds(tf) {
  if (Object.hasOwn(TIMEFRAME_SECONDS, tf)) return TIMEFRAME_SECONDS[tf];
  return /^\d+$/.test(String(tf)) ? Number(tf) * 60 : null;
}

/** "60" -> "1h", "15" -> "15m", "D" -> "1D". Unknown codes come back unchanged. */
export function formatTimeframe(tf) {
  const seconds = timeframeSeconds(tf);
  if (seconds === null || !/^\d+$/.test(String(tf))) return String(tf);
  const minutes = seconds / 60;
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/**
 * What a live bar means for the loaded candles. The forming candle repeats with the same time, so it can
 * be drawn in place. A new time (or an older one) may hide a gap or a correction: reload the list, which is
 * one cheap request per bar period.
 */
export function classifyBar(lastLoadedTime, candleTime) {
  return lastLoadedTime !== null && candleTime === lastLoadedTime ? 'update' : 'refetch';
}

/** Stale = the newest bar is older than three bar periods. A stream with no bar yet, or an unknown timeframe, makes no claim. */
// ponytail: stock streams are idle overnight and at weekends, so they show "Stale" then; the API does not expose the market, add it if the flag nags.
export function isStale(stream, nowSeconds) {
  const seconds = timeframeSeconds(stream.timeframe);
  if (seconds === null || !Number.isFinite(stream.lastBarTime)) return false;
  return nowSeconds - stream.lastBarTime > STALE_BARS * seconds;
}

/** A marker needs a shape and a glyph as well as a colour. `tone` is resolved to a colour at draw time. */
export function alertMarker(alert) {
  if (!Number.isFinite(alert.barTime)) return null; // recorded before meta existed
  const direction = alert.direction ?? alert.level;
  if (direction === 'up') return { time: alert.barTime, position: 'belowBar', shape: 'arrowUp', tone: 'up', text: '↑' };
  if (direction === 'down') return { time: alert.barTime, position: 'aboveBar', shape: 'arrowDown', tone: 'down', text: '↓' };
  return null;
}

/** Paper entries and exits only; `start` and `summary` events say nothing about a bar. */
export function paperMarker(event) {
  if ((event.type !== 'entry' && event.type !== 'exit') || !Number.isFinite(event.bar_time)) return null;
  return { time: event.bar_time, position: event.type === 'entry' ? 'belowBar' : 'aboveBar', shape: 'square', tone: 'paper', text: event.type === 'entry' ? 'P in' : 'P out' };
}

/** Time of the last bar at or before `time` (candle times ascending), or null: no time, or before the first bar. */
function barAtOrBefore(candleTimes, time) {
  if (!Number.isFinite(time)) return null;
  let found = null;
  for (const t of candleTimes) {
    if (t > time) break;
    found = t;
  }
  return found;
}

/** A note sits on the last bar at or before its time; no time, or before the loaded bars, means no marker. */
export function noteMarker(note, candleTimes) {
  const time = barAtOrBefore(candleTimes, note.time);
  if (time === null) return null;
  return { time, position: 'aboveBar', shape: 'circle', tone: 'note', text: note.kind === 'note' || !note.kind ? '•' : String(note.kind).charAt(0).toUpperCase() };
}

/** Markers for one stream, ascending by time: the chart library throws on unsorted markers. Notes are already this stream's. */
export function buildMarkers(alerts, paper, symbol, timeframe, notes = [], candleTimes = []) {
  const markers = [];
  for (const note of notes) {
    const marker = noteMarker(note, candleTimes);
    if (marker !== null) markers.push(marker);
  }
  for (const alert of alerts) {
    if (alert.symbol !== symbol || alert.timeframe !== timeframe) continue;
    const marker = alertMarker(alert);
    if (marker !== null) markers.push(marker);
  }
  for (const journal of paper) {
    if (journal.symbol !== symbol || journal.timeframe !== timeframe) continue;
    for (const event of journal.events) {
      const marker = paperMarker(event);
      if (marker !== null) markers.push(marker);
    }
  }
  return markers.sort((a, b) => a.time - b.time);
}

/** The link only if it starts with exactly `obsidian://` and has no whitespace or control characters; else null. */
export function safeObsidianHref(url) {
  return typeof url === 'string' && /^obsidian:\/\/[^\s\u0000-\u001f\u007f]+$/.test(url) ? url : null;
}

/** The only place an href is set: an obsidian:// link passes the scheme check, anything else leaves the element without one. */
export function setObsidianLink(el, url) {
  const safe = safeObsidianHref(url);
  if (safe === null) {
    el.removeAttribute('href');
    return false;
  }
  el.href = safe;
  return true;
}

/** A file name Obsidian accepts: the characters it forbids in a note name become "-". */
const fileSafe = (text) => text.replace(/[\\/:*?"<>|#^[\]]/g, '-');

/**
 * `obsidian://new` for a note about one candle. The note is created by Obsidian when the user clicks; this page and
 * the watcher write nothing. The content is the frontmatter lib/notes.mjs reads back (symbols, time, kind).
 */
export function newNoteLink({ vault, folder, symbol, timeframe = null, time, kind = 'note' }) {
  const iso = new Date(time * 1000).toISOString().replace('.000Z', 'Z');
  const tf = timeframe === null ? '' : formatTimeframe(timeframe); // an opportunity note is about a symbol, not a chart
  const name = [fileSafe(symbol), fileSafe(tf), iso.slice(0, 10), `${iso.slice(11, 13)}${iso.slice(14, 16)}`].filter((part) => part !== '').join(' ');
  const heading = [symbol, tf, `${iso.slice(0, 16).replace('T', ' ')} UTC`].filter((part) => part !== '').join(' ');
  const content = `---\nsymbols: [${JSON.stringify(symbol)}]\ntime: ${iso}\nkind: ${kind}\n---\n# ${heading}\n\n`;
  const enc = encodeURIComponent;
  return `obsidian://new?vault=${enc(vault)}&file=${enc(`${folder}/${name}`)}&content=${enc(content)}`;
}

/** `?symbol=&tf=&t=<unix seconds>` -> {symbol, timeframe, t}; a missing or unusable part is null. */
export function parseDeepLink(search) {
  const q = new URLSearchParams(search);
  const t = q.get('t');
  return {
    symbol: q.get('symbol'),
    timeframe: q.get('tf'),
    t: t !== null && /^[1-9]\d{0,10}$/.test(t) ? Number(t) : null,
  };
}

/** A logical range of `bars` bars centred on the last bar at or before `t`, or null when t is before the first bar. */
export function centerRange(candleTimes, t, bars) {
  const time = barAtOrBefore(candleTimes, t);
  if (time === null) return null;
  const index = candleTimes.indexOf(time);
  return { from: index - bars / 2, to: index + bars / 2 };
}

// ---------------------------------------------------------------- alerts tab, detail drawer, tab title, paper equity

const DETAIL_VALUE_ROWS = 20;
const DETAIL_TEXT = 200;
const MAX_UNSEEN = 99;

/** Alerts matching every filter that is not empty (equality on rule id, symbol and status). A new array. */
export function filterAlerts(alerts, { ruleId = '', symbol = '', status = '' }) {
  return alerts.filter((a) => (ruleId === '' || a.ruleId === ruleId) && (symbol === '' || a.symbol === symbol) && (status === '' || a.status === status));
}

/** How many alerts each rule fired per UTC day: [{day, ruleId, count}], newest day first. */
// ponytail: UTC days, because the page does not know the watcher's timezone; add it to /api/health if the split at midnight UTC confuses.
export function countByRuleDay(alerts) {
  const counts = new Map();
  for (const a of alerts) {
    const key = `${new Date(a.at).toISOString().slice(0, 10)}|${a.ruleId ?? '(no rule)'}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => {
    const bar = key.indexOf('|');
    return { day: key.slice(0, bar), ruleId: key.slice(bar + 1), count };
  }).sort((a, b) => (a.day === b.day ? a.ruleId.localeCompare(b.ruleId) : b.day.localeCompare(a.day)));
}

const detailText = (value) => {
  const text = value === null || value === undefined ? 'n/a' : Array.isArray(value) ? value.map(String).join(', ') : String(value);
  return text.slice(0, DETAIL_TEXT);
};

/** The detail drawer's rows as [label, text] pairs: the fixed fields, then the alert's `values` table (capped; it is data from the rule evaluators). */
export function alertDetailRows(alert) {
  const rows = [
    ['Rule', alert.ruleId ?? '—'],
    ['Direction', alert.direction ?? alert.level ?? '—'],
    ['Message', alert.message ?? alert.title ?? '—'],
    ['Status', alert.status ?? '—'],
    ['Symbol', alert.symbol === null || alert.symbol === undefined ? '—' : `${alert.symbol} ${formatTimeframe(alert.timeframe)}`],
    ['Alerted at', new Date(alert.at).toISOString()],
  ];
  if (Number.isFinite(alert.barTime)) rows.push(['Bar time', new Date(alert.barTime * 1000).toISOString()]);
  if (alert.values !== null && typeof alert.values === 'object') {
    for (const [key, value] of Object.entries(alert.values).slice(0, DETAIL_VALUE_ROWS)) rows.push([key.slice(0, 60), detailText(value)]);
  }
  return rows.map(([label, text]) => [label, detailText(text)]);
}

/** The query string for a link to a stream (and a bar time, when given); parseDeepLink reads it back. */
export function deepLink(symbol, timeframe, time) {
  const q = new URLSearchParams({ symbol, tf: timeframe });
  if (Number.isFinite(time)) q.set('t', String(time));
  return `?${q}`;
}

/** "(3) Market watch" while alerts arrived in a hidden tab; the count stops at 99. */
export function tabTitle(base, unseen) {
  return unseen > 0 ? `(${unseen > MAX_UNSEEN ? `${MAX_UNSEEN}+` : unseen}) ${base}` : base;
}

/**
 * Cumulative paper return from the journal's exit events, compounded in file order: [{time, value}] with value in percent.
 * Realised exits only, so it can hide a dip inside a trade that recovered before its exit (the known 6b caveat).
 */
export function paperEquity(events) {
  const points = [];
  let equity = 1;
  for (const e of events) {
    if (e.type !== 'exit' || !Number.isFinite(e.return_pct) || !Number.isFinite(e.bar_time)) continue;
    equity = Math.max(0, equity * (1 + e.return_pct / 100));
    points.push({ time: e.bar_time, value: Number(((equity - 1) * 100).toFixed(2)) });
  }
  return { points, totalPct: points.at(-1)?.value ?? null, trades: points.length };
}

/** An SVG polyline's `points` for a small line chart: min at the bottom, max at the top, a flat series in the middle. Unusable values are skipped. */
export function sparkPoints(values, width, height) {
  const ys = values.filter((v) => Number.isFinite(v));
  if (ys.length === 0) return '';
  const low = Math.min(...ys);
  const span = Math.max(...ys) - low;
  const at = (v) => (span === 0 ? height / 2 : height - ((v - low) / span) * height);
  const row = ys.length === 1 ? [ys[0], ys[0]] : ys;
  return row.map((v, i) => `${Number(((i / (row.length - 1)) * width).toFixed(2))},${Number(at(v).toFixed(2))}`).join(' ');
}

/** "45s", "12m", "3h 12m", "1d 1h": the two largest units. A dash for a negative or missing value. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const [d, h, m] = [Math.floor(s / 86_400), Math.floor((s % 86_400) / 3600), Math.floor((s % 3600) / 60)];
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** "+1.23%" / "-0.50%" / "0.00%"; a dash for no value. */
export function formatPct(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

/** The checkbox label for one /api/indicators entry. */
export function overlayLabel(indicator) {
  if (indicator.type === 'rsi_cross') return `RSI ${indicator.period}, levels ${indicator.levels.join(' and ')} (rule ${indicator.ruleId})`;
  return `Bollinger bands ${indicator.period}, ${indicator.stddev} deviations (rule ${indicator.ruleId})`;
}

/**
 * Where a rule fired in the past, as small grey arrows (the chart library cannot draw hollow markers; grey and
 * small is what tells them from real alerts). Only bars that are loaded; the library throws on unsorted markers.
 */
export function ghostMarkers(hits, candleTimes) {
  const loaded = new Set(candleTimes);
  return hits
    .filter((h) => loaded.has(h.time) && (h.direction === 'up' || h.direction === 'down'))
    .map((h) => ({ time: h.time, position: h.direction === 'up' ? 'belowBar' : 'aboveBar', shape: h.direction === 'up' ? 'arrowUp' : 'arrowDown', tone: 'ghost', size: 0.6, text: '' }))
    .sort((a, b) => a.time - b.time);
}

/** The line under the preview: the count, and plainly what the count is not. */
export function previewSummary(view) {
  if (view.barsChecked === 0) return `Not enough closed bars yet to judge rule ${view.ruleId}.`;
  const n = view.hits.length;
  const count = n === 0 ? 'No signals' : `${n} ${n === 1 ? 'signal' : 'signals'}`;
  return `${count} from rule ${view.ruleId} in the last ${view.barsChecked} closed bars (small grey arrows on the chart). `
    + 'Signals only: cooldowns, daily limits and quiet hours are not applied, so the alerts actually sent would be the same or fewer. This is not a prediction.';
}

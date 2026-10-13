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
export function newNoteLink({ vault, folder, symbol, timeframe, time }) {
  const iso = new Date(time * 1000).toISOString().replace('.000Z', 'Z');
  const name = `${fileSafe(symbol)} ${fileSafe(formatTimeframe(timeframe))} ${iso.slice(0, 10)} ${iso.slice(11, 13)}${iso.slice(14, 16)}`;
  const content = `---\nsymbols: [${JSON.stringify(symbol)}]\ntime: ${iso}\nkind: note\n---\n# ${symbol} ${formatTimeframe(timeframe)} ${iso.slice(0, 16).replace('T', ' ')} UTC\n\n`;
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

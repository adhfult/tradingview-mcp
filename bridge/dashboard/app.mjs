/**
 * The dashboard page. Read-only: it fetches /api/* and listens to /events, nothing else.
 *
 * Every string from the server goes into the page with textContent (or Option), never as HTML,
 * because the CSP forbids inline code and an alert title is not trusted. The pure functions at
 * the top have no DOM and are tested in Node; start() runs only in a browser.
 *
 * The library's attribution logo is off: it injects a <style> element, which the CSP blocks. The
 * footer in index.html carries the required notice and tradingview.com link instead.
 *
 * Chart colours are read from the CSS tokens (docs/design/DESIGN.md) at draw time: the chart
 * paints on a canvas, which cannot resolve `var(--up)` itself.
 */

// ---------------------------------------------------------------- pure functions

const TIMEFRAME_SECONDS = { D: 86_400, W: 604_800, M: 2_678_400 };
const STALE_BARS = 3;
const ALERT_LIMIT = 100;

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
  return { time, position: 'aboveBar', shape: 'circle', tone: 'note', text: String(note.kind ?? 'note').charAt(0).toUpperCase() };
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

/** A file name Obsidian accepts: its forbidden characters become "-". */
const fileSafe = (text) => text.replace(/[\\/:*?"<>|]/g, '-');

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

// ---------------------------------------------------------------- browser

const $ = (id) => document.getElementById(id);

async function getJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (res.status === 401) throw new Error('not authorised: open the dashboard URL with ?token=...');
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const errorText = (err) => (err instanceof Error ? err.message : String(err));

/** Replaces a list's children with `rows`, each a function that fills one <li>. */
function renderList(list, rows) {
  list.replaceChildren(...rows.map((fill) => {
    const li = document.createElement('li');
    fill(li);
    return li;
  }));
}

function addText(parent, tag, text, className) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  parent.append(el);
  return el;
}

function setStatus(id, text, kind) {
  const el = $(id);
  el.hidden = text === '';
  el.textContent = text;
  if (kind) el.dataset.kind = kind;
  else delete el.dataset.kind;
}

async function start() {
  const state = {
    streams: [], selected: null, candles: [], alerts: [], paper: [], levels: [], loadId: 0, wasConnected: false, loadFailed: false,
    notes: [], notesInfo: null, notesError: null, pick: null, centred: false,
  };
  const shown = { alerts: '', streams: '', picker: '', notes: '' }; // what is on screen, so an unchanged list is not rebuilt (it would drop keyboard focus and re-announce)
  const NO_CHART = 'The chart library could not be loaded, so there is no chart. Alerts and streams still work.';
  let lib = null;
  let chart = null;
  let series = null;
  let markerPlugin = null;
  let priceLines = [];

  try {
    lib = await import('/assets/lightweight-charts.mjs');
  } catch {
    setStatus('chart-status', NO_CHART, 'error');
    $('chart').setAttribute('aria-busy', 'false');
  }

  // ------------------------------------------------------------ chart

  function chartOptions() {
    return {
      layout: { background: { color: cssVar('--surface') }, textColor: cssVar('--muted'), attributionLogo: false },
      grid: { vertLines: { color: cssVar('--border') }, horzLines: { color: cssVar('--border') } },
      rightPriceScale: { borderColor: cssVar('--border') },
      timeScale: { borderColor: cssVar('--border'), timeVisible: true },
    };
  }

  function seriesOptions() {
    const up = cssVar('--up');
    const down = cssVar('--down');
    return { upColor: up, borderUpColor: up, wickUpColor: up, downColor: down, borderDownColor: down, wickDownColor: down };
  }

  function ensureChart() {
    if (lib === null || chart !== null) return;
    chart = lib.createChart($('chart'), { autoSize: true, ...chartOptions() });
    series = chart.addSeries(lib.CandlestickSeries, seriesOptions());
    markerPlugin = lib.createSeriesMarkers(series, []);
    chart.subscribeClick((param) => {
      if (state.notesInfo?.enabled !== true || typeof param.time !== 'number') return;
      state.pick = param.time;
      renderAddNote();
    });
  }

  const toChartCandle = (c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });

  function drawMarkers() {
    if (markerPlugin === null || state.selected === null) return;
    const colours = { up: cssVar('--up'), down: cssVar('--down'), paper: cssVar('--paper'), note: cssVar('--note') };
    const { symbol, timeframe } = state.selected;
    markerPlugin.setMarkers(buildMarkers(state.alerts, state.paper, symbol, timeframe, state.notes, state.candles.map((c) => c.time))
      .map(({ tone, ...marker }) => ({ ...marker, color: colours[tone] })));
  }

  function drawLevels() {
    if (series === null) return;
    for (const line of priceLines) series.removePriceLine(line);
    const tf = state.selected?.timeframe;
    priceLines = state.levels
      .filter((l) => l.timeframes === null || l.timeframes.includes(tf))
      .map((l) => series.createPriceLine({
        price: l.level, color: cssVar('--accent'), lineWidth: 1, lineStyle: lib.LineStyle.Dashed, axisLabelVisible: true, title: l.ruleId,
      }));
  }

  /** `fit` is for a first load or a stream change; a reload at a new bar keeps the zoom the user chose. */
  function drawChart(fit) {
    ensureChart();
    if (series === null) return;
    series.setData(state.candles.map(toChartCandle));
    if (fit) {
      drawLevels();
      chart.timeScale().fitContent();
    }
    drawMarkers();
  }

  function applyTheme() {
    if (chart === null) return;
    chart.applyOptions(chartOptions());
    series.applyOptions(seriesOptions());
    drawLevels();
    drawMarkers();
  }

  // ------------------------------------------------------------ lists

  const timeText = (seconds) => new Date(seconds * 1000).toLocaleString();

  function fillAlert(li, a) {
    const direction = a.direction ?? a.level;
    const tone = direction === 'up' || direction === 'down' ? direction : null;
    const tag = addText(li, 'span', tone === 'up' ? '↑ Up' : tone === 'down' ? '↓ Down' : 'Info', 'tag');
    if (tone !== null) tag.dataset.tone = tone;
    addText(li, 'span', a.symbol === null ? a.title : `${a.symbol} ${formatTimeframe(a.timeframe)}`);
    const time = addText(li, 'time', timeText(a.at / 1000));
    time.dateTime = new Date(a.at).toISOString();
    if (a.message !== null) addText(li, 'span', a.message, 'msg');
  }

  /** Full rebuild, skipped when nothing changed. A new alert from the live feed is prepended by onAlert instead. */
  function renderAlerts() {
    const list = $('alerts-list');
    setStatus('alerts-status', state.alerts.length === 0 ? 'No alerts yet. A rule that fires will appear here as it happens.' : '');
    const signature = JSON.stringify(state.alerts);
    if (signature === shown.alerts) return;
    shown.alerts = signature;
    renderList(list, state.alerts.map((a) => (li) => fillAlert(li, a)));
  }

  /** Rebuilt only when what it shows changed; keyboard focus on a "Show" button is put back by stream key. */
  function renderStreams() {
    const list = $('streams-list');
    if (state.streams.length === 0) {
      shown.streams = '';
      renderList(list, []);
      setStatus('streams-status', 'No streams are configured. Add symbols and timeframes to the watcher config.');
      return;
    }
    setStatus('streams-status', '');
    const now = Date.now() / 1000;
    const rows = state.streams.map((s) => ({ s, selected: state.selected !== null && streamKey(s) === streamKey(state.selected), stale: isStale(s, now) }));
    const signature = JSON.stringify(rows);
    if (signature === shown.streams) return;
    shown.streams = signature;
    const focused = document.activeElement?.dataset?.stream;
    renderList(list, rows.map(({ s, selected, stale }) => (li) => {
      if (selected) li.setAttribute('aria-current', 'true');
      addText(li, 'span', `${s.symbol} ${formatTimeframe(s.timeframe)}`);
      const health = addText(li, 'span', s.healthy ? 'Healthy' : 'Not healthy', 'tag');
      health.dataset.tone = s.healthy ? 'up' : 'down';
      if (stale) addText(li, 'span', 'Stale', 'tag').dataset.tone = 'warn';
      if (Number.isFinite(s.lastBarTime)) addText(li, 'time', `last bar ${timeText(s.lastBarTime)}`);
      const show = addText(li, 'button', 'Show');
      show.type = 'button';
      show.dataset.stream = streamKey(s);
      show.setAttribute('aria-label', `Show ${s.symbol} ${formatTimeframe(s.timeframe)}`);
      show.addEventListener('click', () => select(s));
    }));
    if (focused !== undefined) list.querySelector(`button[data-stream="${CSS.escape(focused)}"]`)?.focus();
  }

  /** An Obsidian link: set only after the scheme check, else the element stays plain text. */
  function setObsidianLink(el, url) {
    const safe = safeObsidianHref(url);
    if (safe === null) {
      el.removeAttribute('href');
      return false;
    }
    el.href = safe;
    return true;
  }

  const KIND_LABEL = { news: 'News', opportunity: 'Opportunity', risk: 'Risk', note: 'Note' };

  function fillNote(li, n) {
    addText(li, 'span', KIND_LABEL[n.kind] ?? 'Note', 'tag').dataset.tone = 'note';
    setObsidianLink(addText(li, 'a', n.title), n.open);
    if (Number.isFinite(n.time)) {
      const time = addText(li, 'time', timeText(n.time));
      time.dateTime = new Date(n.time * 1000).toISOString();
    }
    if (n.excerpt !== '') addText(li, 'span', n.excerpt, 'msg');
  }

  /** The Notes panel: its four states (loading is the page's first text), and rebuilt only when the notes changed. */
  function renderNotes() {
    const list = $('notes-list');
    let text = '';
    let kind;
    if (state.notesError !== null) [text, kind] = [`Could not load notes: ${state.notesError}`, 'error'];
    else if (state.notesInfo === null) text = 'No stream selected.';
    else if (!state.notesInfo.enabled) text = 'Notes are off. Set dashboard.notes in the watcher config to show your Obsidian notes here.';
    else if (state.notes.length === 0) text = 'No notes for this symbol yet. A note appears when its properties list this symbol, for example symbols: [BTCUSDT].';
    setStatus('notes-status', text, kind);
    const signature = JSON.stringify(state.notes);
    if (signature === shown.notes) return;
    shown.notes = signature;
    renderList(list, state.notes.map((n) => (li) => fillNote(li, n)));
  }

  /** "Add note here" appears once a candle has been clicked, and only when the notes layer is on. */
  function renderAddNote() {
    const hint = $('add-note-hint');
    const link = $('add-note');
    const info = state.notesInfo;
    const stream = state.selected;
    hint.hidden = info?.enabled !== true;
    link.hidden = true;
    if (info?.enabled !== true || stream === null) return;
    if (state.pick === null) {
      hint.textContent = 'Click a candle to choose where a new note goes.';
      return;
    }
    hint.textContent = `Candle picked: ${timeText(state.pick)} (the note is stamped ${new Date(state.pick * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC)`;
    const url = newNoteLink({ vault: info.vault, folder: info.folder, symbol: stream.symbol, timeframe: stream.timeframe, time: state.pick });
    link.hidden = !setObsidianLink(link, url);
  }

  function renderPicker() {
    const picker = $('stream-picker');
    const signature = JSON.stringify(state.streams.map(streamKey));
    if (signature !== shown.picker) { // replacing the options would close an open dropdown
      shown.picker = signature;
      picker.replaceChildren(...state.streams.map((s) => new Option(`${s.symbol} · ${formatTimeframe(s.timeframe)}`, streamKey(s))));
    }
    picker.disabled = state.streams.length === 0;
    if (state.selected !== null) picker.value = streamKey(state.selected);
  }

  // ------------------------------------------------------------ loading

  function showError(err) {
    $('page-error-text').textContent = `Could not reach the watcher: ${errorText(err)}`;
    $('page-error').hidden = false;
  }
  const clearError = () => { $('page-error').hidden = true; };

  /** The /api/notes answer (or {error}) into the state. */
  function applyNotes(answer) {
    state.notesError = typeof answer.error === 'string' ? answer.error : null;
    state.notesInfo = state.notesError === null ? { enabled: answer.enabled, vault: answer.vault, folder: answer.folder } : null;
    state.notes = state.notesError === null ? answer.notes : [];
  }

  /** `?t=` in the page URL centres the chart on that time, once, for the stream the link names. */
  function centreOnLink() {
    const link = parseDeepLink(location.search);
    const stream = state.selected;
    if (state.centred || link.t === null || chart === null || stream === null) return;
    if (link.symbol !== stream.symbol || link.timeframe !== stream.timeframe) return;
    state.centred = true;
    const range = centerRange(state.candles.map((c) => c.time), link.t, 80);
    if (range === null) setStatus('chart-status', 'The time in the link is before the loaded candles.');
    else chart.timeScale().setVisibleLogicalRange(range);
  }

  /** The notes change by hand in Obsidian, so look again now and then; the markers and panel change only if they did. */
  async function reloadNotes() {
    const stream = state.selected;
    if (stream === null || state.notesInfo?.enabled === false) return; // off stays off; an error or a notes folder created later is tried again
    const id = state.loadId;
    try {
      const answer = await getJson(`/api/notes?${new URLSearchParams({ symbol: stream.symbol, tf: stream.timeframe })}`);
      if (id !== state.loadId) return;
      applyNotes(answer);
      renderNotes();
      drawMarkers();
    } catch (err) {
      console.error('notes reload failed', err);
    }
  }

  /**
   * Everything for the selected stream: candles, levels, alerts and paper journals. A newer call makes an older one a no-op.
   * Without a chart there is nothing to draw, but the alerts still load.
   */
  async function loadStream() {
    const stream = state.selected;
    state.loadId += 1;
    const id = state.loadId;
    state.pick = null;
    const chartNote = (text) => (lib === null ? setStatus('chart-status', NO_CHART, 'error') : setStatus('chart-status', text));
    $('chart').setAttribute('aria-busy', String(lib !== null));
    chartNote('Loading candles');
    const q = new URLSearchParams({ symbol: stream?.symbol ?? '', tf: stream?.timeframe ?? '' });
    try {
      if (stream === null) { // no streams configured: alerts can still exist (/notify, trending)
        state.candles = [];
        state.notes = [];
        state.notesInfo = null;
        state.notesError = null;
        state.alerts = await getJson(`/api/alerts?limit=${ALERT_LIMIT}`);
        $('chart').setAttribute('aria-busy', 'false');
        chartNote('No stream selected.');
        if (id === state.loadId) {
          renderAlerts();
          renderNotes();
          renderAddNote();
        }
        return;
      }
      const [candles, levels, alerts, paper, notes] = await Promise.all([
        getJson(`/api/candles?${q}`),
        getJson(`/api/levels?${new URLSearchParams({ symbol: stream.symbol })}`),
        getJson(`/api/alerts?limit=${ALERT_LIMIT}`),
        getJson('/api/paper'),
        getJson(`/api/notes?${q}`).catch((err) => ({ error: errorText(err) })), // a notes failure must not blank the chart
      ]);
      if (id !== state.loadId) return;
      Object.assign(state, { candles, levels, alerts, paper });
      applyNotes(notes);
      clearError();
      $('chart').setAttribute('aria-busy', 'false');
      chartNote(candles.length === 0 ? 'No candles yet for this stream. They appear after the watcher\'s first snapshot.' : '');
      drawChart(true);
      centreOnLink();
      renderAlerts();
      renderNotes();
      renderAddNote();
    } catch (err) {
      if (id !== state.loadId) return;
      $('chart').setAttribute('aria-busy', 'false');
      setStatus('chart-status', `Could not load candles: ${errorText(err)}`, 'error');
      setStatus('alerts-status', `Could not load alerts: ${errorText(err)}`, 'error');
      setStatus('notes-status', `Could not load notes: ${errorText(err)}`, 'error');
      showError(err);
    }
  }

  /** A new bar time: only the candles can have changed (alerts arrive by the live feed), and the user's zoom stays. */
  async function reloadCandles() {
    const stream = state.selected;
    if (stream === null) return;
    const id = state.loadId;
    try {
      const candles = await getJson(`/api/candles?${new URLSearchParams({ symbol: stream.symbol, tf: stream.timeframe })}`);
      if (id !== state.loadId) return;
      state.candles = candles;
      drawChart(false);
    } catch (err) {
      console.error('candle reload failed', err);
    }
  }

  async function loadStreams() {
    try {
      state.streams = await getJson('/api/streams');
      state.loadFailed = false;
    } catch (err) {
      state.loadFailed = true;
      setStatus('streams-status', `Could not load streams: ${errorText(err)}`, 'error');
      showError(err);
      return;
    }
    const link = parseDeepLink(location.search);
    const wanted = state.selected ?? { symbol: link.symbol, timeframe: link.timeframe };
    state.selected = state.streams.find((s) => streamKey(s) === streamKey(wanted)) ?? state.streams[0] ?? null;
    renderPicker();
    renderStreams();
    await loadStream();
  }

  function select(stream) {
    state.selected = stream;
    state.candles = []; // a bar for the new stream must not be drawn onto the old stream's candles
    state.notes = []; // nor the old stream's notes shown under the new stream's name
    state.notesInfo = null;
    state.notesError = null;
    shown.notes = '';
    renderList($('notes-list'), []);
    setStatus('notes-status', 'Loading notes');
    const q = new URLSearchParams({ symbol: stream.symbol, tf: stream.timeframe });
    history.replaceState(null, '', `?${q}`);
    renderPicker();
    renderStreams();
    loadStream();
  }

  // ------------------------------------------------------------ live events

  function setBadge(badgeState, text) {
    $('live-badge').dataset.state = badgeState;
    $('live-text').textContent = text;
  }

  function onBar(data) {
    const stream = state.streams.find((s) => s.symbol === data.symbol && s.timeframe === data.timeframe);
    if (stream !== undefined) stream.lastBarTime = data.candle.time;
    const selected = state.selected;
    if (selected === null || selected.symbol !== data.symbol || selected.timeframe !== data.timeframe) return;
    const last = state.candles.length === 0 ? null : state.candles[state.candles.length - 1].time;
    if (classifyBar(last, data.candle.time) === 'update') {
      state.candles[state.candles.length - 1] = data.candle;
      series?.update(toChartCandle(data.candle));
    } else {
      reloadCandles();
    }
  }

  function onAlert(alert) {
    state.alerts = [alert, ...state.alerts].slice(0, ALERT_LIMIT);
    const list = $('alerts-list');
    const li = document.createElement('li'); // one new row: rebuilding the list would make a screen reader read all of it again
    fillAlert(li, alert);
    list.prepend(li);
    while (list.children.length > ALERT_LIMIT) list.lastElementChild.remove();
    shown.alerts = JSON.stringify(state.alerts);
    setStatus('alerts-status', '');
    drawMarkers();
  }

  function connect() {
    const source = new EventSource('/events');
    source.addEventListener('open', () => {
      setBadge('live', 'Live');
      // Anything missed while disconnected (a bar rollover across a gap) only reaches the page by reloading.
      if (state.wasConnected || state.loadFailed) loadStreams();
      state.wasConnected = true;
    });
    source.addEventListener('error', () => {
      if (source.readyState !== EventSource.CLOSED) {
        setBadge('reconnecting', 'Reconnecting'); // the browser retries by itself
        return;
      }
      // A refusal (503 when five other tabs are open, 401) closes the stream for good: the browser does not retry it.
      setBadge('offline', 'Live updates off, retrying');
      setTimeout(connect, 15_000);
    });
    const on = (name, fn) => source.addEventListener(name, (event) => {
      try {
        fn(JSON.parse(event.data));
      } catch (err) {
        console.error(`bad ${name} event`, err);
      }
    });
    on('bar', onBar);
    on('alert', onAlert);
    on('health', (list) => {
      state.streams = list;
      renderPicker();
      renderStreams();
    });
  }

  // ------------------------------------------------------------ wiring

  $('stream-picker').addEventListener('change', (event) => {
    const next = state.streams.find((s) => streamKey(s) === event.target.value);
    if (next !== undefined) select(next);
  });
  $('retry').addEventListener('click', () => { clearError(); loadStreams(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  setInterval(renderStreams, 60_000); // "Stale" depends on the clock, not on an event
  setInterval(reloadNotes, 60_000);

  connect();
  await loadStreams();
}

if (typeof document !== 'undefined') start();

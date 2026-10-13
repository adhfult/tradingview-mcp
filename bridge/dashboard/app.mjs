/**
 * The dashboard page. Read-only: it fetches /api/* and listens to /events, nothing else.
 *
 * Every string from the server goes into the page with textContent (or Option), never as HTML,
 * because the CSP forbids inline code and an alert title is not trusted. The pure functions at
 * the top have no DOM and are tested in Node; start() runs only in a browser.
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

/** Markers for one stream, ascending by time: the chart library throws on unsorted markers. */
export function buildMarkers(alerts, paper, symbol, timeframe) {
  const markers = [];
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
  const state = { streams: [], selected: null, candles: [], alerts: [], paper: [], levels: [], loadId: 0, wasConnected: false };
  let lib = null;
  let chart = null;
  let series = null;
  let markerPlugin = null;
  let priceLines = [];

  try {
    lib = await import('/assets/lightweight-charts.mjs');
  } catch {
    setStatus('chart-status', 'The chart library could not be loaded, so there is no chart. Alerts and streams still work.', 'error');
    $('chart').setAttribute('aria-busy', 'false');
  }

  // ------------------------------------------------------------ chart

  function chartOptions() {
    return {
      layout: { background: { color: cssVar('--surface') }, textColor: cssVar('--muted'), attributionLogo: true },
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
  }

  const toChartCandle = (c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });

  function drawMarkers() {
    if (markerPlugin === null || state.selected === null) return;
    const colours = { up: cssVar('--up'), down: cssVar('--down'), paper: cssVar('--paper'), note: cssVar('--note') };
    const { symbol, timeframe } = state.selected;
    markerPlugin.setMarkers(buildMarkers(state.alerts, state.paper, symbol, timeframe)
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

  function drawChart() {
    ensureChart();
    if (series === null) return;
    series.setData(state.candles.map(toChartCandle));
    drawLevels();
    drawMarkers();
    chart.timeScale().fitContent();
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

  function renderAlerts() {
    const list = $('alerts-list');
    if (state.alerts.length === 0) {
      renderList(list, []);
      setStatus('alerts-status', 'No alerts yet. A rule that fires will appear here as it happens.');
      return;
    }
    setStatus('alerts-status', '');
    renderList(list, state.alerts.map((a) => (li) => {
      const direction = a.direction ?? a.level;
      const tone = direction === 'up' || direction === 'down' ? direction : null;
      const tag = addText(li, 'span', tone === 'up' ? '↑ Up' : tone === 'down' ? '↓ Down' : 'Info', 'tag');
      if (tone !== null) tag.dataset.tone = tone;
      addText(li, 'span', a.symbol === null ? a.title : `${a.symbol} ${formatTimeframe(a.timeframe)}`);
      const time = addText(li, 'time', timeText(a.at / 1000));
      time.dateTime = new Date(a.at).toISOString();
      addText(li, 'span', a.message ?? a.title, 'msg');
    }));
  }

  function renderStreams() {
    const list = $('streams-list');
    if (state.streams.length === 0) {
      renderList(list, []);
      setStatus('streams-status', 'No streams are configured. Add symbols and timeframes to the watcher config.');
      return;
    }
    setStatus('streams-status', '');
    const now = Date.now() / 1000;
    renderList(list, state.streams.map((s) => (li) => {
      const selected = state.selected !== null && streamKey(s) === streamKey(state.selected);
      if (selected) li.setAttribute('aria-current', 'true');
      addText(li, 'span', `${s.symbol} ${formatTimeframe(s.timeframe)}`);
      const health = addText(li, 'span', s.healthy ? 'Healthy' : 'Not healthy', 'tag');
      health.dataset.tone = s.healthy ? 'up' : 'down';
      if (isStale(s, now)) addText(li, 'span', 'Stale', 'tag').dataset.tone = 'warn';
      if (Number.isFinite(s.lastBarTime)) addText(li, 'time', `last bar ${timeText(s.lastBarTime)}`);
      const show = addText(li, 'button', 'Show');
      show.type = 'button';
      show.setAttribute('aria-label', `Show ${s.symbol} ${formatTimeframe(s.timeframe)}`);
      show.addEventListener('click', () => select(s));
    }));
  }

  function renderPicker() {
    const picker = $('stream-picker');
    picker.replaceChildren(...state.streams.map((s) => new Option(`${s.symbol} · ${formatTimeframe(s.timeframe)}`, streamKey(s))));
    picker.disabled = state.streams.length === 0;
    if (state.selected !== null) picker.value = streamKey(state.selected);
  }

  // ------------------------------------------------------------ loading

  function showError(err) {
    $('page-error-text').textContent = `Could not reach the watcher: ${errorText(err)}`;
    $('page-error').hidden = false;
  }
  const clearError = () => { $('page-error').hidden = true; };

  /** Candles, levels, alerts and paper journals for the selected stream. A newer call makes an older one a no-op. */
  async function loadStream() {
    const stream = state.selected;
    state.loadId += 1;
    const id = state.loadId;
    if (stream === null) {
      state.candles = [];
      $('chart').setAttribute('aria-busy', 'false');
      setStatus('chart-status', 'No stream selected.');
      return;
    }
    $('chart').setAttribute('aria-busy', 'true');
    setStatus('chart-status', 'Loading candles');
    const q = new URLSearchParams({ symbol: stream.symbol, tf: stream.timeframe });
    try {
      const [candles, levels, alerts, paper] = await Promise.all([
        getJson(`/api/candles?${q}`),
        getJson(`/api/levels?${new URLSearchParams({ symbol: stream.symbol })}`),
        getJson(`/api/alerts?limit=${ALERT_LIMIT}`),
        getJson('/api/paper'),
      ]);
      if (id !== state.loadId) return;
      Object.assign(state, { candles, levels, alerts, paper });
      clearError();
      $('chart').setAttribute('aria-busy', 'false');
      setStatus('chart-status', candles.length === 0 ? 'No candles yet for this stream. They appear after the watcher\'s first snapshot.' : '');
      drawChart();
      renderAlerts();
    } catch (err) {
      if (id !== state.loadId) return;
      $('chart').setAttribute('aria-busy', 'false');
      setStatus('chart-status', `Could not load candles: ${errorText(err)}`, 'error');
      setStatus('alerts-status', `Could not load alerts: ${errorText(err)}`, 'error');
      showError(err);
    }
  }

  async function loadStreams() {
    try {
      state.streams = await getJson('/api/streams');
    } catch (err) {
      setStatus('streams-status', `Could not load streams: ${errorText(err)}`, 'error');
      showError(err);
      return;
    }
    const query = new URLSearchParams(location.search);
    const wanted = state.selected ?? { symbol: query.get('symbol'), timeframe: query.get('tf') };
    state.selected = state.streams.find((s) => streamKey(s) === streamKey(wanted)) ?? state.streams[0] ?? null;
    renderPicker();
    renderStreams();
    await loadStream();
  }

  function select(stream) {
    state.selected = stream;
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
    if (classifyBar(last, data.candle.time) === 'update' && series !== null) {
      state.candles[state.candles.length - 1] = data.candle;
      series.update(toChartCandle(data.candle));
    } else {
      loadStream();
    }
  }

  function onAlert(alert) {
    state.alerts = [alert, ...state.alerts].slice(0, ALERT_LIMIT);
    renderAlerts();
    drawMarkers();
  }

  function connect() {
    const source = new EventSource('/events');
    source.addEventListener('open', () => {
      setBadge('live', 'Live');
      // Anything missed while disconnected (a bar rollover across a gap) only reaches the page by reloading.
      if (state.wasConnected) loadStreams();
      state.wasConnected = true;
    });
    source.addEventListener('error', () => setBadge('reconnecting', 'Reconnecting'));
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

  connect();
  await loadStreams();
}

if (typeof document !== 'undefined') start();

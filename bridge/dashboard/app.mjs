/**
 * The dashboard page. Read-only: it fetches /api/* and listens to /events, nothing else.
 *
 * Every string from the server goes into the page with textContent (or Option), never as HTML,
 * because the CSP forbids inline code and an alert title is not trusted. The pure functions
 * in pure.mjs have no DOM and are tested in Node; start() runs only in a browser.
 *
 * The library's attribution logo is off: it injects a <style> element, which the CSP blocks. The
 * footer in index.html carries the required notice and tradingview.com link instead.
 *
 * Chart colours are read from the CSS tokens (docs/design/DESIGN.md) at draw time: the chart
 * paints on a canvas, which cannot resolve `var(--up)` itself.
 */

import { closeDetail, fillAlert, initDetail, openDetail, renderAlertsTab } from './alerts-view.mjs';
import { $, addText, cssVar, errorText, getJson, renderList, saveCanvasPng, setStatus, timeText } from './dom.mjs';
import {
  buildMarkers, centerRange, classifyBar, deepLink, formatTimeframe, isStale, newNoteLink, parseDeepLink, setObsidianLink, streamKey, tabTitle,
} from './pure.mjs';
import { renderOverview, renderTrending } from './overview-view.mjs';
import { renderBadges, renderHealth, renderPaper } from './status-view.mjs';

// The tests (and any reader) find the helpers here as before.
export {
  alertMarker, buildMarkers, centerRange, classifyBar, formatTimeframe, isStale, newNoteLink, noteMarker, paperMarker, parseDeepLink,
  safeObsidianHref, setObsidianLink, streamKey, timeframeSeconds,
} from './pure.mjs';

const ALERT_LIMIT = 100;
const ALL_ALERTS_LIMIT = 500;

async function start() {
  const state = {
    streams: [], selected: null, candles: [], alerts: [], paper: [], levels: [], loadId: 0, wasConnected: false, loadFailed: false,
    notes: [], notesInfo: null, notesError: null, pick: null, centred: false,
    tab: 'overview', fitPending: false, allAlerts: null, filters: { ruleId: '', symbol: '', status: '' }, unseen: 0,
  };
  const shown = { alerts: '', streams: '', picker: '', notes: '' }; // what is on screen, so an unchanged list is not rebuilt (it would drop keyboard focus and re-announce)
  const NO_CHART = 'The chart library could not be loaded, so there is no chart. Alerts and streams still work.';
  let lib = null;
  let chart = null;
  let series = null;
  let markerPlugin = null;
  let priceLines = [];
  const baseTitle = document.title;

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
    $('save-png').hidden = false;
    chart.subscribeClick((param) => {
      if (typeof param.time !== 'number') return;
      const sel = state.selected;
      const hit = sel === null ? undefined : state.alerts.find((a) => a.symbol === sel.symbol && a.timeframe === sel.timeframe && a.barTime === param.time);
      if (hit !== undefined) openDetailFor(hit); // a click on a candle with an alert marker
      if (state.notesInfo?.enabled !== true) return;
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
      if (state.tab === 'chart') chart.timeScale().fitContent();
      else state.fitPending = true; // a hidden chart has no width to fit; showTab does it
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

  /** Full rebuild, skipped when nothing changed. A new alert from the live feed is prepended by onAlert instead. */
  function renderAlerts() {
    const list = $('alerts-list');
    setStatus('alerts-status', state.alerts.length === 0 ? 'No alerts yet. A rule that fires will appear here as it happens.' : '');
    const signature = JSON.stringify(state.alerts);
    if (signature === shown.alerts) return;
    shown.alerts = signature;
    renderList(list, state.alerts.map((a) => (li) => fillAlert(li, a, openDetailFor)));
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

  const KIND_LABEL = { news: 'News', opportunity: 'Opportunity', risk: 'Risk', note: 'Note' };

  function fillNote(li, n) {
    addText(li, 'span', KIND_LABEL[n.kind] ?? 'Note', 'tag').dataset.tone = 'note';
    const link = addText(li, 'a', n.title);
    link.dataset.note = n.open; // lets renderNotes put keyboard focus back after a rebuild
    setObsidianLink(link, n.open);
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
    const focused = document.activeElement?.dataset?.note;
    renderList(list, state.notes.map((n) => (li) => fillNote(li, n)));
    if (focused !== undefined) list.querySelector(`a[data-note="${CSS.escape(focused)}"]`)?.focus();
  }

  /** "Add note here" appears once a candle has been clicked, and only when the notes layer is on. */
  function renderAddNote() {
    const hint = $('add-note-hint');
    const link = $('add-note');
    const info = state.notesInfo;
    const stream = state.selected;
    const latest = $('pick-last');
    hint.hidden = info?.enabled !== true;
    link.hidden = true;
    latest.hidden = info?.enabled !== true || state.candles.length === 0; // the keyboard way to choose a candle
    if (info?.enabled !== true || stream === null) return;
    if (state.pick === null) {
      hint.textContent = 'Click a candle, or use the newest one, to choose where a new note goes.';
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
    if (state.centred || link.t === null || chart === null || stream === null || state.candles.length === 0) return; // not before there are candles
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
      renderAddNote();
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
      if (lib !== null && candles.length > 0) setStatus('chart-status', ''); // candles that arrive after "No candles yet"
      drawChart(false);
      centreOnLink();
      renderAddNote();
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
    state.pick = null; // a candle picked on the old stream must not build a note for the new one
    shown.notes = '';
    renderList($('notes-list'), []);
    setStatus('notes-status', 'Loading notes');
    renderAddNote();
    const q = new URLSearchParams({ symbol: stream.symbol, tf: stream.timeframe });
    history.replaceState(null, '', `?${q}`);
    renderPicker();
    renderStreams();
    loadStream();
  }

  // ------------------------------------------------------------ tabs, alerts tab, detail drawer, status tab

  function openDetailFor(alert) {
    const info = state.notesInfo;
    const noteUrl = info?.enabled === true && alert.symbol !== null && Number.isFinite(alert.barTime)
      ? newNoteLink({ vault: info.vault, folder: info.folder, symbol: alert.symbol, timeframe: alert.timeframe, time: alert.barTime })
      : null;
    openDetail(alert, noteUrl);
  }

  async function loadAllAlerts() {
    try {
      state.allAlerts = await getJson(`/api/alerts?limit=${ALL_ALERTS_LIMIT}`);
      renderAlertsTab(state.allAlerts, state.filters, openDetailFor);
    } catch (err) {
      setStatus('alerts-all-status', `Could not load alerts: ${errorText(err)}`, 'error');
    }
  }

  async function loadStatusTab() {
    try {
      state.paper = await getJson('/api/paper');
      renderPaper(state.paper);
    } catch (err) {
      setStatus('paper-status', `Could not load paper journals: ${errorText(err)}`, 'error');
    }
    await loadHealth();
  }

  /** The health numbers feed the header badges always and the Status tab when it is open. */
  async function loadHealth() {
    try {
      const health = await getJson('/api/health');
      renderBadges(health);
      if (state.tab === 'status') renderHealth(health);
    } catch (err) {
      if (state.tab === 'status') setStatus('health-status', `Could not load health: ${errorText(err)}`, 'error');
    }
  }

  async function loadOverview() {
    try {
      renderOverview(await getJson('/api/overview'), openStream);
    } catch (err) {
      setStatus('overview-status', `Could not load the overview: ${errorText(err)}`, 'error');
    }
  }

  async function loadTrending() {
    try {
      renderTrending(await getJson('/api/trending'), state.notesInfo, openStream);
    } catch (err) {
      setStatus('trending-status', `Could not load trending symbols: ${errorText(err)}`, 'error');
    }
  }

  /** From an overview card or an opportunity row: select that stream and show its chart. */
  function openStream({ symbol, timeframe }) {
    const stream = state.streams.find((s) => s.symbol === symbol && s.timeframe === timeframe);
    if (stream === undefined) return;
    if (state.selected === null || streamKey(state.selected) !== streamKey(stream)) select(stream);
    showTab('chart');
  }

  function showTab(name) {
    state.tab = name;
    for (const el of document.querySelectorAll('[data-view]')) el.hidden = el.dataset.view !== name;
    for (const button of $('tabs').querySelectorAll('button')) {
      if (button.dataset.tab === name) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    closeDetail();
    if (name === 'chart' && state.fitPending && chart !== null) {
      state.fitPending = false;
      // A chart drawn while hidden has width 0, and a fit before its own ResizeObserver reports the real width would pack every
      // bar into a sliver. This observer was created after the chart's, so it runs after it in the same frame.
      const observer = new ResizeObserver(() => {
        observer.disconnect();
        chart.timeScale().fitContent();
      });
      observer.observe($('chart'));
    }
    if (name === 'overview') loadOverview();
    if (name === 'alerts') loadAllAlerts();
    if (name === 'opportunities') loadTrending();
    if (name === 'status') loadStatusTab();
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
    fillAlert(li, alert, openDetailFor);
    list.prepend(li);
    while (list.children.length > ALERT_LIMIT) list.lastElementChild.remove();
    shown.alerts = JSON.stringify(state.alerts);
    setStatus('alerts-status', '');
    drawMarkers();
    if (state.allAlerts !== null) {
      state.allAlerts = [alert, ...state.allAlerts].slice(0, ALL_ALERTS_LIMIT);
      if (state.tab === 'alerts') renderAlertsTab(state.allAlerts, state.filters, openDetailFor);
    }
    if (document.hidden) { // the tab title counts what arrived while nobody was looking
      state.unseen += 1;
      document.title = tabTitle(baseTitle, state.unseen);
    }
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
  $('pick-last').addEventListener('click', () => {
    state.pick = state.candles.at(-1)?.time ?? null;
    renderAddNote();
    if (state.pick !== null) $('add-note').focus();
  });
  $('tabs').addEventListener('click', (event) => {
    const name = event.target.closest('button')?.dataset.tab;
    if (name !== undefined) showTab(name);
  });
  for (const [id, field] of [['filter-rule', 'ruleId'], ['filter-symbol', 'symbol'], ['filter-status', 'status']]) {
    $(id).addEventListener('change', (event) => {
      state.filters[field] = event.target.value;
      if (state.allAlerts !== null) renderAlertsTab(state.allAlerts, state.filters, openDetailFor);
    });
  }
  initDetail(async (alert) => {
    await navigator.clipboard.writeText(`${location.origin}${location.pathname}${deepLink(alert.symbol, alert.timeframe, alert.barTime)}`);
  });
  $('save-png').addEventListener('click', () => {
    if (chart === null || state.selected === null) return;
    saveCanvasPng(chart.takeScreenshot(true), `${state.selected.symbol}-${state.selected.timeframe}`.replace(/[^A-Za-z0-9._-]/g, '-') + '.png');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    state.unseen = 0;
    document.title = baseTitle;
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  setInterval(renderStreams, 60_000); // "Stale" depends on the clock, not on an event
  setInterval(reloadNotes, 60_000);
  setInterval(() => { // the overview's "ago" text and the badges depend on the clock and on counters, not on an event
    loadHealth();
    if (state.tab === 'overview') loadOverview();
  }, 60_000);

  connect();
  showTab(parseDeepLink(location.search).symbol === null ? 'overview' : 'chart'); // a link to a stream lands on its chart
  loadHealth();
  await loadStreams();
}

if (typeof document !== 'undefined') start();

/** The Status tab (watcher health, paper trading) and the header badges that come from the health data. */
import { $, addText, renderList, setStatus, sparkline } from './dom.mjs';
import { formatDuration, formatTimeframe, paperEquity } from './pure.mjs';

const yesNo = (value, yes, no) => (value === null ? 'unknown' : value ? yes : no);
const num = (value) => (value === null ? '—' : String(value));

/** `h` is /api/health. A field the watcher could not give is null and shows as "unknown" or a dash. */
export function renderHealth(h) {
  setStatus('health-status', '');
  const facts = [
    ['Uptime', formatDuration(h.uptimeSeconds)],
    ['TradingView login', yesNo(h.loggedIn, 'cookies set', 'anonymous')],
    ['Streams healthy', h.healthy === null ? 'unknown' : `${h.healthy} of ${h.total}`],
    ['Stream failures, lost connections', `${num(h.disconnects)}, ${num(h.connectionDrops)}`],
    ['Notifications waiting to send', num(h.queuePending)],
    ['Sent this hour', h.sentLastHour === null ? '—' : `${h.sentLastHour} of ${num(h.maxPerHour)}`],
    ['Quiet hours now', yesNo(h.quietNow, 'yes', 'no')],
    ['Held, over the cap', `${num(h.held)}, ${num(h.overflow)}`],
    ['US market', yesNo(h.usOpen, 'open', 'closed')],
    ['Next US holiday', h.nextHoliday ?? 'none listed'],
  ];
  const summary = $('health-summary');
  summary.replaceChildren();
  for (const [label, text] of facts) {
    addText(summary, 'dt', label);
    addText(summary, 'dd', text);
  }
  // The age is the browser's clock against the watcher's: fine on one machine or a tunnel, a little off across a clock skew.
  renderList($('health-streams'), h.streams.map((s) => (li) => {
    addText(li, 'span', `${s.symbol} ${formatTimeframe(s.timeframe)}`);
    addText(li, 'span', s.status, 'tag').dataset.tone = s.status === 'healthy' ? 'up' : 'warn';
    addText(li, 'span', s.lastDataAt === null ? 'no data yet' : `data ${formatDuration((Date.now() - s.lastDataAt) / 1000)} ago`, 'num');
    addText(li, 'span', `attempt ${s.attempt}, ${s.disconnects} failure${s.disconnects === 1 ? '' : 's'}`, 'num');
    if (s.lastError !== null) addText(li, 'span', `last error ${s.lastError}`, 'num');
  }));
}

function setBadge(id, text, state) {
  const badge = $(id);
  badge.hidden = text === '';
  if (text === '') return;
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.textContent = text;
  badge.dataset.state = state;
  badge.replaceChildren(dot, label);
}

/** The header's market clock and login badges; hidden while the watcher has not said. */
export function renderBadges(h) {
  setBadge('market-badge', h.usOpen === null ? '' : `US market ${h.usOpen ? 'open' : 'closed'}`, h.usOpen ? 'live' : 'connecting');
  setBadge('login-badge', h.loggedIn === null ? '' : `TradingView: ${h.loggedIn ? 'login cookies set' : 'anonymous'}`, h.loggedIn ? 'live' : 'connecting');
}

/** `journals` is /api/paper: [{strategy, symbol, timeframe, events}]. */
export function renderPaper(journals) {
  setStatus('paper-status', journals.length === 0 ? 'No paper journals yet. They appear once a strategy has been paper-traded.' : '');
  renderList($('paper-list'), journals.map((j) => (li) => {
    const equity = paperEquity(j.events);
    const name = `${j.strategy ?? 'Unknown strategy'} · ${j.symbol ?? 'unknown symbol'} ${j.timeframe === null ? '' : formatTimeframe(j.timeframe)}`.trim();
    addText(li, 'span', name);
    if (equity.totalPct === null) {
      addText(li, 'span', 'No exits yet', 'tag');
      return;
    }
    const tag = addText(li, 'span', `${equity.totalPct > 0 ? '+' : ''}${equity.totalPct}% over ${equity.trades} exit${equity.trades === 1 ? '' : 's'}`, 'tag');
    tag.dataset.tone = equity.totalPct >= 0 ? 'up' : 'down';
    li.append(sparkline(equity.points.map((p) => p.value), `Realised paper return of ${name}`));
  }));
}

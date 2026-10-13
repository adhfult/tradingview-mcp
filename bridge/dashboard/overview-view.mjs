/** The Overview tab (one card per stream) and the Opportunities tab (what the trending scan has seen). */
import { $, addText, renderList, setStatus, sparkline } from './dom.mjs';
import { formatDuration, formatPct, formatTimeframe, newNoteLink, setObsidianLink } from './pure.mjs';

const priceText = (price) => (price === null ? '—' : price.toLocaleString('en-US', { maximumFractionDigits: 6 }));
const arrow = (direction) => (direction === 'up' ? '↑' : direction === 'down' ? '↓' : '•');

let overviewSignature = '';

/** `cards` is /api/overview. `onOpen(card)` shows that stream's chart. Rebuilt when the data or the minute changes (the "ago" text). */
export function renderOverview(cards, onOpen) {
  setStatus('overview-status', cards.length === 0 ? 'No streams are configured. Add symbols and timeframes to the watcher config.' : '');
  const signature = JSON.stringify([cards, Math.floor(Date.now() / 60_000)]);
  if (signature === overviewSignature) return;
  overviewSignature = signature;
  const focused = document.activeElement?.dataset?.open;
  renderList($('overview-list'), cards.map((c) => (li) => {
    const name = `${c.symbol} ${formatTimeframe(c.timeframe)}`;
    addText(li, 'strong', name);
    addText(li, 'span', c.healthy ? 'Healthy' : 'Not healthy', 'tag').dataset.tone = c.healthy ? 'up' : 'down';
    if (c.sessionOpen !== null) addText(li, 'span', c.sessionOpen ? 'US session open' : 'US session closed', 'tag').dataset.tone = c.sessionOpen ? 'up' : 'warn';
    addText(li, 'span', priceText(c.price), 'num');
    const change = addText(li, 'span', formatPct(c.changePct), 'tag');
    if (c.changePct !== null) change.dataset.tone = c.changePct >= 0 ? 'up' : 'down';
    li.append(sparkline(c.spark, `Last ${c.spark.length} closes of ${name}`));
    if (c.lastAlert !== null) {
      const { direction, ruleId, at, status } = c.lastAlert;
      addText(li, 'span', `Last alert: ${arrow(direction)} ${ruleId ?? 'alert'}, ${formatDuration((Date.now() - at) / 1000)} ago (${status})`, 'msg');
    }
    const open = addText(li, 'button', 'Open chart');
    open.type = 'button';
    open.dataset.open = `${c.symbol}|${c.timeframe}`;
    open.setAttribute('aria-label', `Open the chart for ${name}`);
    open.addEventListener('click', () => onOpen(c));
  }));
  if (focused !== undefined) $('overview-list').querySelector(`button[data-open="${CSS.escape(focused)}"]`)?.focus();
}

/**
 * `rows` is /api/trending. `notesInfo` is the /api/notes answer's {enabled, vault, folder} or null: with the notes layer on, each
 * row gets an "Add note" link (an opportunity note about the symbol). `onOpen({symbol, timeframe})` shows a watched stream's chart.
 */
export function renderTrending(rows, notesInfo, onOpen) {
  setStatus('trending-status', rows.length === 0 ? 'The trending scan has not seen any symbols yet. Turn trending on in the watcher config and give it a few minutes.' : '');
  renderList($('trending-list'), rows.map((r) => (li) => {
    addText(li, 'span', `${r.market} ${r.kind}`, 'tag').dataset.tone = 'note';
    addText(li, 'span', r.symbol);
    addText(li, 'span', `seen ${formatDuration(r.ageSeconds)} ago`, 'num');
    if (r.watched !== null) {
      const open = addText(li, 'button', 'Open chart');
      open.type = 'button';
      open.setAttribute('aria-label', `Open the chart for ${r.symbol}`);
      open.addEventListener('click', () => onOpen(r.watched));
    }
    if (notesInfo?.enabled === true) {
      const link = addText(li, 'a', 'Add note', 'button');
      const url = newNoteLink({ vault: notesInfo.vault, folder: notesInfo.folder, symbol: r.symbol, time: Math.floor(Date.now() / 1000), kind: 'opportunity' });
      if (!setObsidianLink(link, url)) link.remove();
    }
  }));
}

/**
 * The alert list row, the Alerts tab (filters and per-rule counts) and the detail drawer. Every string goes in with
 * textContent; the only href is the Obsidian link, set through setObsidianLink.
 */
import { $, addText, renderList, setStatus, timeText } from './dom.mjs';
import { alertDetailRows, countByRuleDay, filterAlerts, formatTimeframe, setObsidianLink } from './pure.mjs';

const COUNT_ROWS = 60;

/** One alert as a list row. With `onDetails` the row gets a "Details" button that opens the drawer. */
export function fillAlert(li, a, onDetails) {
  const direction = a.direction ?? a.level;
  const tone = direction === 'up' || direction === 'down' ? direction : null;
  const tag = addText(li, 'span', tone === 'up' ? '↑ Up' : tone === 'down' ? '↓ Down' : 'Info', 'tag');
  if (tone !== null) tag.dataset.tone = tone;
  const label = a.symbol === null ? a.title : `${a.symbol} ${formatTimeframe(a.timeframe)}`;
  addText(li, 'span', label);
  const time = addText(li, 'time', timeText(a.at / 1000));
  time.dateTime = new Date(a.at).toISOString();
  if (a.message !== null) addText(li, 'span', a.message, 'msg');
  if (onDetails !== undefined) {
    const button = addText(li, 'button', 'Details');
    button.type = 'button';
    button.setAttribute('aria-label', `Details of the alert for ${label}`);
    button.addEventListener('click', () => onDetails(a));
  }
}

// ---------------------------------------------------------------- the Alerts tab

let tabSignature = '';

/** The filter dropdowns keep their options until the set of values changes: replacing them would close an open one. */
function syncSelect(id, values, current) {
  const select = $(id);
  const signature = JSON.stringify(values);
  if (select.dataset.options !== signature) {
    select.dataset.options = signature;
    select.replaceChildren(new Option('Any', ''), ...values.map((v) => new Option(v, v)));
  }
  select.value = values.includes(current) ? current : '';
}

const distinct = (list) => [...new Set(list)].sort();

/** `all` is /api/alerts?limit=500; `filters` is {ruleId, symbol, status} (empty string = any). Rebuilt only when something changed. */
export function renderAlertsTab(all, filters, onDetails) {
  const options = {
    ruleId: distinct(all.map((a) => a.ruleId).filter((v) => v !== null)),
    symbol: distinct(all.map((a) => a.symbol).filter((v) => v !== null)),
    status: distinct(all.map((a) => a.status)),
  };
  // A filter whose value has left the history would still hide rows while its dropdown said "Any".
  for (const [field, values] of Object.entries(options)) if (!values.includes(filters[field])) filters[field] = '';
  const signature = JSON.stringify([all, filters]);
  if (signature === tabSignature) return;
  tabSignature = signature;
  syncSelect('filter-rule', options.ruleId, filters.ruleId);
  syncSelect('filter-symbol', options.symbol, filters.symbol);
  syncSelect('filter-status', options.status, filters.status);
  const shown = filterAlerts(all, filters);
  setStatus('alerts-all-status', all.length === 0 ? 'No alerts yet. A rule that fires will appear here as it happens.' : `Showing ${shown.length} of ${all.length} stored alerts.`);
  renderList($('alerts-all-list'), shown.map((a) => (li) => fillAlert(li, a, onDetails)));
  renderList($('alert-counts'), countByRuleDay(shown).slice(0, COUNT_ROWS).map((row) => (li) => {
    addText(li, 'span', row.ruleId);
    addText(li, 'time', row.day);
    addText(li, 'span', `${row.count}×`, 'num');
  }));
}

// ---------------------------------------------------------------- the detail drawer

let current = null;
let opener = null;

export function closeDetail() {
  $('alert-detail').hidden = true;
  current = null;
  if (opener !== null && opener.isConnected) opener.focus();
  opener = null;
}

/** `noteUrl` is an obsidian://new link or null (notes off, or no bar to attach the note to). */
export function openDetail(alert, noteUrl) {
  if (current === null) opener = document.activeElement;
  current = alert;
  $('detail-title').textContent = alert.symbol === null ? alert.title : `${alert.symbol} ${formatTimeframe(alert.timeframe)}`;
  const rows = $('detail-rows');
  rows.replaceChildren();
  for (const [label, text] of alertDetailRows(alert)) {
    addText(rows, 'dt', label);
    addText(rows, 'dd', text);
  }
  setStatus('detail-status', '');
  $('copy-link').hidden = alert.symbol === null;
  $('detail-note').hidden = !setObsidianLink($('detail-note'), noteUrl);
  $('alert-detail').hidden = false;
  $('detail-close').focus();
}

/** Wires the drawer once: Close, Escape, and "Copy chart link" (the page supplies what to copy). */
export function initDetail(onCopy) {
  $('detail-close').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && current !== null) closeDetail();
  });
  $('copy-link').addEventListener('click', async () => {
    if (current === null) return;
    try {
      await onCopy(current);
      setStatus('detail-status', 'Link copied.');
    } catch (err) {
      setStatus('detail-status', `Could not copy the link: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  });
}

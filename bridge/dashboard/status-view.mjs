/** The Status tab. Paper trading: one row per journal with its realised return and a line of it. */
import { $, addText, renderList, setStatus, sparkline } from './dom.mjs';
import { formatTimeframe, paperEquity } from './pure.mjs';

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

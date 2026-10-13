/**
 * The page the alert-image renderer opens: /render?symbol=&tf=&t=&dir=&level=&rule=. It draws the last 120
 * candles, an arrow on the alert's bar and the rule's level, then sets window.__ready (or window.__failed, so the
 * renderer does not wait out its timeout). Same-origin /api/ only, like every other page module.
 */

import { $, cssVar, getJson } from './dom.mjs';
import { drawPlan, parseRenderQuery, renderPlan, RENDER_BARS } from './pure.mjs';

async function draw() {
  const query = parseRenderQuery(window.location.search);
  if (query.symbol === null || query.timeframe === null) throw new Error('symbol and tf are required');
  const [lib, candles] = await Promise.all([
    import('/assets/lightweight-charts.mjs'),
    getJson(`/api/candles?symbol=${encodeURIComponent(query.symbol)}&tf=${encodeURIComponent(query.timeframe)}&limit=${RENDER_BARS}`),
  ]);
  const plan = renderPlan(candles, query);
  if (plan.candles.length === 0) throw new Error('no candles');

  drawPlan(lib, $('chart'), plan, {
    up: cssVar('--up'), down: cssVar('--down'), accent: cssVar('--accent'), surface: cssVar('--surface'), muted: cssVar('--muted'), border: cssVar('--border'),
  });
  // Two frames: the chart paints on the next animation frame after the data is set.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

draw().then(
  () => { window.__ready = true; },
  (err) => { window.__failed = err instanceof Error ? err.message : String(err); },
);

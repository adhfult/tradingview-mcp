/**
 * The page the alert-image renderer opens: /render?symbol=&tf=&t=&dir=&level=&rule=. It draws the last 120
 * candles, an arrow on the alert's bar and the rule's level, then sets window.__ready (or window.__failed, so the
 * renderer does not wait out its timeout). Same-origin /api/ only, like every other page module.
 */

import { $, cssVar, getJson } from './dom.mjs';
import { parseRenderQuery, renderPlan, RENDER_BARS } from './pure.mjs';

async function draw() {
  const query = parseRenderQuery(window.location.search);
  if (query.symbol === null || query.timeframe === null) throw new Error('symbol and tf are required');
  const [lib, candles] = await Promise.all([
    import('/assets/lightweight-charts.mjs'),
    getJson(`/api/candles?symbol=${encodeURIComponent(query.symbol)}&tf=${encodeURIComponent(query.timeframe)}&limit=${RENDER_BARS}`),
  ]);
  const plan = renderPlan(candles, query);
  if (plan.candles.length === 0) throw new Error('no candles');

  const up = cssVar('--up');
  const down = cssVar('--down');
  const chart = lib.createChart($('chart'), {
    autoSize: true,
    // The logo injects a <style> element, which the CSP blocks; the credit line under the chart replaces it.
    layout: { background: { color: cssVar('--surface') }, textColor: cssVar('--muted'), attributionLogo: false },
    grid: { vertLines: { color: cssVar('--border') }, horzLines: { color: cssVar('--border') } },
    rightPriceScale: { borderColor: cssVar('--border') },
    timeScale: { borderColor: cssVar('--border'), timeVisible: true },
  });
  const series = chart.addSeries(lib.CandlestickSeries, {
    upColor: up, borderUpColor: up, wickUpColor: up, downColor: down, borderDownColor: down, wickDownColor: down,
  });
  series.setData(plan.candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
  if (plan.marker !== null) {
    const { tone, ...marker } = plan.marker;
    lib.createSeriesMarkers(series, [{ ...marker, color: tone === 'up' ? up : down }]);
  }
  if (plan.level !== null) {
    series.createPriceLine({
      price: plan.level.price, color: cssVar('--accent'), lineWidth: 1, lineStyle: lib.LineStyle.Dashed, axisLabelVisible: true, title: plan.level.title,
    });
  }
  chart.timeScale().fitContent();
  // Two frames: the chart paints on the next animation frame after the data is set.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

draw().then(
  () => { window.__ready = true; },
  (err) => { window.__failed = err instanceof Error ? err.message : String(err); },
);

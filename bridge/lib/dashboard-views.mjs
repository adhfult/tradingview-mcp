/**
 * Pure data shaping for the extra dashboard panels (overview, health, trending, indicators).
 * Nothing here touches a socket, a file or the clock, so every function is a table test. Each one
 * returns a fresh object holding only named fields: a field the watcher adds to its status later
 * does not reach the page until it is listed here.
 */
import { bollinger, rsi } from './indicators.mjs';
import { selectActive } from './gates.mjs';
import { evaluateRules, normalizeRule, ruleApplies, ruleExpired } from './rules.mjs';

const SPARK_BARS = 60;
const MAX_TRENDING = 200;
export const PREVIEW_BARS = 300;
const MAX_ERROR_CODE = 64;

const orNull = (value) => (value === undefined ? null : value);
const round = (value, digits) => Number(value.toFixed(digits));

/** Watcher health for the health panel and the header badges. `status` is whatever getStatus() returned. */
export function healthView(status, list) {
  const s = status ?? {};
  const uptime = Number.isFinite(s.nowMs) && Number.isFinite(s.startedAtMs) ? Math.floor((s.nowMs - s.startedAtMs) / 1000) : null;
  return {
    uptimeSeconds: uptime,
    loggedIn: orNull(s.loggedIn),
    healthy: orNull(s.healthy),
    total: orNull(s.total),
    disconnects: orNull(s.disconnects),
    connectionDrops: orNull(s.connectionDrops),
    queuePending: orNull(s.queuePending),
    sentLastHour: orNull(s.sentLastHour),
    maxPerHour: orNull(s.maxPerHour),
    quietNow: orNull(s.quietNow),
    held: orNull(s.held),
    overflow: orNull(s.overflow),
    usOpen: orNull(s.usOpen),
    nextHoliday: orNull(s.nextHoliday),
    streams: list.map((x) => ({
      symbol: x.symbol,
      timeframe: x.timeframe,
      market: x.market,
      status: x.status,
      lastBarTime: x.lastBarTime ?? null,
      lastDataAt: x.lastDataAt ?? null,
      attempt: x.attempt,
      disconnects: x.disconnects,
      lastError: typeof x.lastError === 'string' ? x.lastError.slice(0, MAX_ERROR_CODE) : null,
    })),
  };
}

/** One card per stream: price, change over the sparkline window, the closes, the newest alert, the stock session. */
export function overviewView({ list, candlesOf, alerts, status }) {
  return list.map((stream) => {
    const closes = (candlesOf(stream.key) ?? []).slice(-SPARK_BARS).map((c) => c.close);
    const first = closes[0];
    const last = closes.at(-1);
    let lastAlert = null;
    for (let i = alerts.length - 1; i >= 0 && lastAlert === null; i -= 1) {
      const m = alerts[i].meta;
      if (m && m.symbol === stream.symbol && m.timeframe === stream.timeframe) {
        lastAlert = { at: alerts[i].at, ruleId: m.ruleId ?? null, direction: m.direction ?? null, status: alerts[i].status };
      }
    }
    return {
      symbol: stream.symbol,
      timeframe: stream.timeframe,
      market: stream.market,
      healthy: stream.status === 'healthy',
      lastBarTime: stream.lastBarTime ?? null,
      price: last ?? null,
      changePct: closes.length >= 2 && first > 0 ? round(((last - first) / first) * 100, 2) : null,
      spark: closes,
      lastAlert,
      sessionOpen: stream.market === 'stock' ? orNull(status?.usOpen) : null,
    };
  });
}

/**
 * The trending scan's memory ("market|kind" -> {SYMBOL: last seen ms}) as flat rows, newest first.
 * The scanner already forgets symbols older than remember_hours, so everything here is current.
 * `watched` is the stream to open when the symbol is one the watcher follows (exact symbol match).
 */
export function trendingView(trending, list, nowMs) {
  const rows = [];
  if (trending !== null && typeof trending === 'object') {
    for (const [bucket, seen] of Object.entries(trending)) {
      const bar = bucket.indexOf('|');
      if (bar < 1 || seen === null || typeof seen !== 'object') continue;
      const market = bucket.slice(0, bar);
      const kind = bucket.slice(bar + 1);
      for (const [symbol, lastSeenAt] of Object.entries(seen)) {
        if (!Number.isFinite(lastSeenAt)) continue;
        const stream = list.find((s) => s.symbol === symbol);
        rows.push({
          market,
          kind,
          symbol,
          lastSeenAt,
          ageSeconds: Math.max(0, Math.floor((nowMs - lastSeenAt) / 1000)),
          watched: stream === undefined ? null : { symbol: stream.symbol, timeframe: stream.timeframe },
        });
      }
    }
  }
  return rows.sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, MAX_TRENDING);
}

const series = (candles, values) => {
  const out = [];
  values.forEach((value, i) => { if (value !== null) out.push({ time: candles[i].time, value: round(value, 4) }); });
  return out;
};

/**
 * What the rules see: for each live rsi_cross or bollinger_break rule that applies to this stream, the same
 * numbers lib/indicators.mjs gives the rule evaluators. The page only draws them; it never computes them, so
 * the chart cannot disagree with the alerts. Rules inside an all_of / any_of are not drawn (not yet).
 */
export function indicatorsView({ rules, stream, candles, nowMs, timezone }) {
  const closes = candles.map((c) => c.close);
  const out = [];
  for (const raw of rules) {
    if (raw.type !== 'rsi_cross' && raw.type !== 'bollinger_break') continue;
    if (!ruleApplies(raw, stream) || ruleExpired(raw, nowMs, timezone)) continue;
    const rule = normalizeRule(raw);
    if (rule.type === 'rsi_cross') {
      out.push({ ruleId: rule.id, type: rule.type, period: rule.period, levels: rule.levels, series: series(candles, rsi(closes, rule.period)) });
    } else {
      const bands = bollinger(closes, rule.period, rule.stddev);
      out.push({
        ruleId: rule.id,
        type: rule.type,
        period: rule.period,
        stddev: rule.stddev,
        upper: series(candles, bands.upper),
        middle: series(candles, bands.middle),
        lower: series(candles, bands.lower),
      });
    }
  }
  return out;
}

/** The rules a stream can preview: top-level, live and applying to it. Ids and types only. */
export function previewableRules({ rules, stream, nowMs, timezone }) {
  return rules.filter((r) => ruleApplies(r, stream) && !ruleExpired(r, nowMs, timezone)).map((r) => ({ id: r.id, type: r.type }));
}

/**
 * Where one rule would have hit over the last `bars` closed bars: the real evaluator on each prefix of the
 * candles, behind the watcher's own gates (selectActive, judged per bar from its open time). Rule hits only: no
 * cooldown, daily cap or quiet hours, because those depend on what was sent, so this is a count of signals and
 * not of alerts. The last candle is still forming and is never judged. `candles` ends with the forming bar.
 */
export function previewView({ rule, stream, candles, nowMs, timezone, inSession, bars = PREVIEW_BARS }) {
  const closed = candles.slice(0, -1);
  const first = Math.max(0, closed.length - bars);
  const hits = [];
  for (let i = first; i < closed.length; i += 1) {
    const active = selectActive([rule], { now: nowMs, timezone, inSession: inSession(closed[i].time * 1000) });
    for (const hit of evaluateRules(active, stream, closed.slice(0, i + 1))) {
      hits.push({ time: hit.barTime, direction: hit.direction, message: hit.message });
    }
  }
  return { ruleId: rule.id, symbol: stream.symbol, timeframe: stream.timeframe, barsChecked: closed.length - first, hits };
}

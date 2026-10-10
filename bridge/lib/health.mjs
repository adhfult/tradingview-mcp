/**
 * Health checks, run on every tick:
 *
 * - Stream down / recovered: a stream with no data for `stream_down_minutes`
 *   sends one "stream down" alert. When data returns it sends one "recovered".
 *   Crypto is always in session. Stocks are only counted during US regular
 *   hours, so the quiet overnight gap never raises an alert.
 * - Daily heartbeat: once per local day, at `daily_heartbeat` in the config
 *   timezone, with uptime, streams healthy out of total, alerts in the last 24 hours,
 *   and whether TradingView credentials are in use (yes or no, never the values).
 *
 * Health alerts are critical: they ignore quiet hours and the hourly cap. The streams
 * that change state in one tick are reported in ONE message (down) and ONE message
 * (recovered), each with the last error code, so an expired cookie (AUTH_ERROR) can be told
 * apart from an unreachable TradingView (connection errors), and an outage never produces
 * 25 messages at once.
 *
 * Stocks use `stock_stream_down_minutes` (a thin ticker can be quiet for a while) and the
 * US calendar (holidays, early closes). A silent crypto stream is restarted once.
 */
import { parseHHMM } from './config.mjs';
import { localDate, localMinutes, renderHealthAlert, renderHealthBatch, renderHeartbeat } from './format.mjs';
import { buildUsCalendar, isUsRegularHours } from './scanner.mjs';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
export const DEFAULT_STOCK_DOWN_MINUTES = 30;

/** Crypto is always in session; stocks only during US regular hours (see isUsRegularHours). */
export const defaultSessionOpen = (stream, now, calendar) => stream.market === 'crypto' || isUsRegularHours(now, calendar);

export function createHealth({
  streams,
  alerts,
  clock,
  store,
  timezone,
  config,
  startedAtMs,
  credentialsInUse,
  isSessionOpen,
  logger = { info() {}, warn() {}, error() {} },
}) {
  const downMs = config.stream_down_minutes * MINUTE_MS;
  const stockDownMs = (config.stock_stream_down_minutes ?? DEFAULT_STOCK_DOWN_MINUTES) * MINUTE_MS;
  const calendar = buildUsCalendar({ holidays: config.us_holidays, earlyCloses: config.us_early_closes });
  const sessionOpen = isSessionOpen ?? ((s, now) => defaultSessionOpen(s, now, calendar));
  const heartbeatMinutes = config.daily_heartbeat === null ? null : parseHHMM(config.daily_heartbeat);
  const perStream = new Map();

  const stateFor = (key) => {
    if (!perStream.has(key)) perStream.set(key, { down: false, downSince: null, quietFrom: null, restarted: false });
    return perStream.get(key);
  };

  /** Streams with data flowing that are not currently flagged as silent. */
  const healthyCount = () => {
    // A silent stream keeps status "healthy" (its connection is up), so take it out here.
    const silent = streams.list().filter((s) => s.status === 'healthy' && stateFor(s.key).down).length;
    return Math.max(0, streams.healthyCount() - silent);
  };

  /**
   * Looks at one stream. Returns {event: 'down'|'recovered', ...} when its state changed,
   * otherwise null. The caller batches the events of one tick into one message each.
   */
  const checkStream = (s, now) => {
    const st = stateFor(s.key);
    const label = { key: s.key, symbol: s.symbol, timeframe: s.timeframe, market: s.market };

    if (st.down && s.lastDataAt !== null && st.downSince !== null && s.lastDataAt > st.downSince) {
      st.down = false;
      st.downSince = null;
      st.restarted = false;
      logger.info(`${s.key} recovered`);
      return { event: 'recovered', ...label };
    }

    if (!sessionOpen(s, now)) {
      st.quietFrom = now;
      return null;
    }
    if (st.down) return null;

    const since = Math.max(s.lastDataAt ?? 0, st.quietFrom ?? 0);
    const silentMs = now - since;
    if (silentMs > (s.market === 'stock' ? stockDownMs : downMs)) {
      st.down = true;
      st.downSince = now;
      logger.warn(`${s.key} has had no data for ${Math.round(silentMs / MINUTE_MS)} min${s.lastError ? ` (last error ${s.lastError})` : ''}`);
      return { event: 'down', ...label, silentMinutes: silentMs / MINUTE_MS, error: s.lastError ?? null };
    }
    return null;
  };

  /** One critical message per kind of event per tick, however many streams changed. */
  const report = (events, now) => {
    for (const event of ['down', 'recovered']) {
      const items = events.filter((e) => e.event === event);
      if (items.length === 0) continue;
      alerts.submit({
        kind: 'health',
        critical: true,
        message: items.length === 1
          ? renderHealthAlert({ ...items[0], now })
          : renderHealthBatch({ event, items, now }),
        summary: items.length === 1
          ? `${items[0].key} stream ${event === 'down' ? 'down' : 'recovered'}`
          : `${items.length} streams ${event === 'down' ? 'down' : 'recovered'}`,
      });
    }
  };

  /**
   * A crypto stream that is silent while other streams still get data has a stuck chart
   * session, not a lost connection: restart just that stream, once per silent episode.
   */
  const restartSilentCrypto = (events, now) => {
    if (typeof streams.restartSilent !== 'function') return;
    const list = streams.list();
    for (const e of events) {
      if (e.event !== 'down' || e.market !== 'crypto') continue;
      const st = stateFor(e.key);
      if (st.restarted) continue;
      const othersFlowing = list.some((o) => o.key !== e.key
        && o.status === 'healthy'
        && !stateFor(o.key).down
        && o.lastDataAt !== null && now - o.lastDataAt <= downMs);
      if (!othersFlowing) continue;
      st.restarted = true;
      if (streams.restartSilent(e.key)) logger.info(`${e.key} silent while other streams flow: restarting that stream`);
    }
  };

  const checkHeartbeat = (now) => {
    if (heartbeatMinutes === null) return;
    const date = localDate(now, timezone);
    if (localMinutes(now, timezone) < heartbeatMinutes || store.state.heartbeatDate === date) return;
    store.state.heartbeatDate = date;
    store.touch();
    const healthy = healthyCount();
    alerts.submit({
      kind: 'heartbeat',
      critical: true,
      message: renderHeartbeat({
        uptimeSeconds: (now - startedAtMs) / 1000,
        healthy,
        total: streams.total,
        alerts24h: alerts.countSince(now - 24 * HOUR_MS),
        credentials: credentialsInUse,
        now,
        timezone,
      }),
      summary: `daily heartbeat ${date}`,
    });
  };

  return {
    /** Runs the stream and heartbeat checks once. */
    tick() {
      const now = clock.now();
      const events = [];
      for (const s of streams.list()) {
        const event = checkStream(s, now);
        if (event !== null) events.push(event);
      }
      report(events, now);
      restartSilentCrypto(events, now);
      checkHeartbeat(now);
    },

    /** Counts for /health and the heartbeat. */
    summary() {
      return { healthy: healthyCount(), total: streams.total };
    },
  };
}

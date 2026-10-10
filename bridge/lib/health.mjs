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
 * Health alerts are critical: they ignore quiet hours and the hourly cap.
 */
import { parseHHMM } from './config.mjs';
import { localDate, localMinutes, renderHealthAlert, renderHeartbeat } from './format.mjs';
import { isUsRegularHours } from './scanner.mjs';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Crypto is always in session; stocks only during US regular hours. */
export const defaultSessionOpen = (stream, now) => stream.market === 'crypto' || isUsRegularHours(now);

export function createHealth({
  streams,
  alerts,
  clock,
  store,
  timezone,
  config,
  startedAtMs,
  credentialsInUse,
  isSessionOpen = defaultSessionOpen,
  logger = { info() {}, warn() {}, error() {} },
}) {
  const downMs = config.stream_down_minutes * MINUTE_MS;
  const heartbeatMinutes = config.daily_heartbeat === null ? null : parseHHMM(config.daily_heartbeat);
  const perStream = new Map();

  const stateFor = (key) => {
    if (!perStream.has(key)) perStream.set(key, { down: false, downSince: null, quietFrom: null });
    return perStream.get(key);
  };

  const checkStream = (s, now) => {
    const st = stateFor(s.key);
    const label = { symbol: s.symbol, timeframe: s.timeframe };

    if (st.down && s.lastDataAt !== null && st.downSince !== null && s.lastDataAt > st.downSince) {
      st.down = false;
      st.downSince = null;
      logger.info(`${s.key} recovered`);
      alerts.submit({
        kind: 'health',
        critical: true,
        message: renderHealthAlert({ event: 'recovered', ...label, now }),
        summary: `${s.key} stream recovered`,
      });
      return;
    }

    const open = isSessionOpen(s, now);
    if (!open) {
      st.quietFrom = now;
      return;
    }
    if (st.down) return;

    const since = Math.max(s.lastDataAt ?? 0, st.quietFrom ?? 0);
    const silentMs = now - since;
    if (silentMs > downMs) {
      st.down = true;
      st.downSince = now;
      logger.warn(`${s.key} has had no data for ${Math.round(silentMs / MINUTE_MS)} min`);
      alerts.submit({
        kind: 'health',
        critical: true,
        message: renderHealthAlert({ event: 'down', ...label, silentMinutes: silentMs / MINUTE_MS, now }),
        summary: `${s.key} stream down`,
      });
    }
  };

  const checkHeartbeat = (now) => {
    if (heartbeatMinutes === null) return;
    const date = localDate(now, timezone);
    if (localMinutes(now, timezone) < heartbeatMinutes || store.state.heartbeatDate === date) return;
    store.state.heartbeatDate = date;
    store.touch();
    const healthy = streams.healthyCount();
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
      for (const s of streams.list()) checkStream(s, now);
      checkHeartbeat(now);
    },

    /** Counts for /health and the heartbeat. */
    summary() {
      return { healthy: streams.healthyCount(), total: streams.total };
    },
  };
}

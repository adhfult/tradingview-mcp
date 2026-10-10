/**
 * Trending scan. Every `every_minutes`, for each market x kind, it fetches the top
 * `top_n` rows (getHotlist) and alerts on symbols that are new to that list:
 * not seen in the same market x kind within `remember_hours`.
 *
 * - `america` is skipped outside 09:30 to 16:00 New York time, Monday to Friday
 *   (when us_regular_hours_only is on). Computed from Intl parts, no libraries.
 * - An empty result or an error means skip and log, with no alert and no change
 *   to the seen list.
 * - Seen times are kept in state under the market x kind bucket. A symbol that
 *   stays in the top list keeps refreshing its time, so it does not re-alert.
 */
import { errorMessage } from './errors.mjs';
import { timeoutError, withDeadline } from './deadline.mjs';
import { renderTrendAlert, zonedParts } from './format.mjs';

const HOUR_MS = 60 * 60 * 1000;
const US_OPEN_MINUTES = 9 * 60 + 30;
const US_CLOSE_MINUTES = 16 * 60;
const DEADLINE_GRACE_MS = 5000;

/** True when New York is in its regular session (Mon to Fri, 09:30 to 16:00). */
export function isUsRegularHours(ms) {
  const p = zonedParts(ms, 'America/New_York');
  if (p.weekday > 5) return false;
  const minutes = p.hour * 60 + p.minute;
  return minutes >= US_OPEN_MINUTES && minutes < US_CLOSE_MINUTES;
}

/**
 * `trending` is the config trending section (normalised). `getHotlist` is the
 * library function (or a fake). `store` is the state store and `alerts` the
 * alerts pipeline.
 */
export function createScanner({
  trending,
  timezone,
  getHotlist,
  store,
  clock,
  alerts,
  logger,
  timeoutMs = 15_000,
}) {
  let running = false;

  const fetchRows = async (market, kind) => {
    const result = await withDeadline(
      () => getHotlist({ kind, market, range: [0, trending.top_n] }, { signal: AbortSignal.timeout(timeoutMs) }),
      timeoutMs + DEADLINE_GRACE_MS,
      () => timeoutError(timeoutMs),
    );
    return Array.isArray(result?.rows) ? result.rows : [];
  };

  const gatedOut = (market, now) => market === 'america'
    && trending.us_regular_hours_only
    && !isUsRegularHours(now);

  function processRows(market, kind, rows, now) {
    const bucketKey = `${market}|${kind}`;
    const seenTrending = store.state.trending;
    const seen = (seenTrending[bucketKey] ??= {});
    const rememberMs = trending.remember_hours * HOUR_MS;
    const hourBucket = Math.floor(now / HOUR_MS);

    rows.forEach((row, index) => {
      const symbol = typeof row?.symbol === 'string' ? row.symbol : '';
      if (symbol === '') return;
      const last = seen[symbol];
      const isNew = last === undefined || now - last > rememberMs;
      seen[symbol] = now;
      if (!isNew) return;
      const rank = index + 1;
      alerts.submit({
        kind: 'trend',
        message: renderTrendAlert({
          market, kind, rank, symbol, values: row.values ?? {}, now, timezone,
        }),
        summary: `${symbol} trending ${market} ${kind} #${rank}`,
        dedupeKey: `trend|${market}|${kind}|${symbol}|${hourBucket}`,
      });
    });

    for (const [symbol, at] of Object.entries(seen)) {
      if (now - at > rememberMs) delete seen[symbol];
    }
  }

  return {
    /**
     * One scan of every configured market x kind. Alerts new entries and updates
     * the seen list. Runs one scan at a time, and returns false if one was already running.
     */
    async runOnce() {
      if (running) return false;
      running = true;
      try {
        const now = clock.now();
        for (const market of trending.markets) {
          if (gatedOut(market, now)) {
            logger.info(`trending ${market}: skipped (outside US regular hours)`);
            continue;
          }
          for (const kind of trending.kinds) {
            let rows;
            try {
              rows = await fetchRows(market, kind);
            } catch (err) {
              logger.warn(`trending ${market}/${kind} failed: ${errorMessage(err)}`);
              continue;
            }
            if (rows.length === 0) {
              logger.info(`trending ${market}/${kind}: empty result, skipped`);
              continue;
            }
            processRows(market, kind, rows, clock.now());
          }
        }
        store.touch();
        return true;
      } finally {
        running = false;
      }
    },

    /**
     * For --once: fetches every market x kind and returns the rows as lines of
     * text. It ignores the seen list, the US-hours gate and the alerts, and
     * changes no state.
     */
    async printOnce() {
      const lines = [];
      for (const market of trending.markets) {
        for (const kind of trending.kinds) {
          lines.push(`${market} ${kind}`);
          try {
            const rows = await fetchRows(market, kind);
            if (rows.length === 0) {
              lines.push('  (empty result)');
              continue;
            }
            rows.forEach((row, index) => {
              const values = Object.entries(row.values ?? {})
                .filter(([key]) => key !== 'name')
                .map(([key, value]) => `${key}=${value ?? 'n/a'}`)
                .join(' ');
              lines.push(`  ${index + 1}. ${row.symbol}  ${values}`.trimEnd());
            });
          } catch (err) {
            lines.push(`  error: ${errorMessage(err)}`);
          }
        }
      }
      return lines;
    },
  };
}

/**
 * Trending scan. Every `every_minutes`, for each market x kind, it fetches the top
 * `top_n` rows (getHotlist) and alerts on symbols that are new to that list:
 * not seen in the same market x kind within `remember_hours`.
 *
 * - `america` is skipped outside 09:30 to 16:00 New York time, Monday to Friday
 *   (when us_regular_hours_only is on). Computed from Intl parts, no libraries.
 * - An empty result or an error means skip and log, with no alert and no change
 *   to the seen list.
 * - A market x kind list that has never been scanned (nothing in state) is only
 *   remembered: the first scan alerts on nothing, so a fresh start or a lost state file
 *   never floods the channel.
 * - New entries of one market x kind in one scan go out as ONE message.
 * - Seen times are kept in state under the market x kind bucket. A symbol that
 *   stays in the top list keeps refreshing its time, so it does not re-alert.
 */
import { createHash } from 'node:crypto';
import { errorMessage } from './errors.mjs';
import { timeoutError, withDeadline } from './deadline.mjs';
import { renderTrendAlert, renderTrendBatch, zonedParts } from './format.mjs';

const HOUR_MS = 60 * 60 * 1000;
const US_OPEN_MINUTES = 9 * 60 + 30;
const US_CLOSE_MINUTES = 16 * 60;
const DEADLINE_GRACE_MS = 5000;

/** US market holidays and early closes (13:00 ET) known to the watcher. Update them each year. */
export const DEFAULT_US_HOLIDAYS = Object.freeze(['2026-11-26', '2026-12-25']);
export const DEFAULT_US_EARLY_CLOSES = Object.freeze(['2026-11-27', '2026-12-24']);
const US_EARLY_CLOSE_MINUTES = 13 * 60;

/** Sets of YYYY-MM-DD dates for isUsRegularHours. Missing lists use the defaults. */
export function buildUsCalendar({ holidays = DEFAULT_US_HOLIDAYS, earlyCloses = DEFAULT_US_EARLY_CLOSES } = {}) {
  return { holidays: new Set(holidays), earlyCloses: new Set(earlyCloses) };
}
const DEFAULT_CALENDAR = buildUsCalendar();

/**
 * True when New York is in its regular session: Mon to Fri, 09:30 to 16:00, not on a
 * holiday, and until 13:00 on an early-close day.
 */
export function isUsRegularHours(ms, calendar = DEFAULT_CALENDAR) {
  const p = zonedParts(ms, 'America/New_York');
  if (p.weekday > 5) return false;
  const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  if (calendar.holidays.has(date)) return false;
  const minutes = p.hour * 60 + p.minute;
  const close = calendar.earlyCloses.has(date) ? US_EARLY_CLOSE_MINUTES : US_CLOSE_MINUTES;
  return minutes >= US_OPEN_MINUTES && minutes < close;
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
  usCalendar = DEFAULT_CALENDAR,
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
    && !isUsRegularHours(now, usCalendar);

  function processRows(market, kind, rows, now) {
    const bucketKey = `${market}|${kind}`;
    const seenTrending = store.state.trending;
    const firstScan = seenTrending[bucketKey] === undefined;
    const seen = (seenTrending[bucketKey] ??= {});
    const rememberMs = trending.remember_hours * HOUR_MS;
    const hourBucket = Math.floor(now / HOUR_MS);
    const fresh = [];

    rows.forEach((row, index) => {
      const symbol = typeof row?.symbol === 'string' ? row.symbol : '';
      if (symbol === '') return;
      const last = seen[symbol];
      const isNew = last === undefined || now - last > rememberMs;
      seen[symbol] = now;
      if (isNew) fresh.push({ rank: index + 1, symbol, values: row.values ?? {} });
    });

    for (const [symbol, at] of Object.entries(seen)) {
      if (now - at > rememberMs) delete seen[symbol];
    }

    if (firstScan) {
      logger.info(`trending ${market}/${kind}: seeded ${fresh.length} symbol(s), no alert for the first scan`);
      return;
    }
    if (fresh.length === 0) return;

    if (fresh.length === 1) {
      const { rank, symbol, values } = fresh[0];
      alerts.submit({
        kind: 'trend',
        message: renderTrendAlert({ market, kind, rank, symbol, values, now, timezone }),
        summary: `${symbol} trending ${market} ${kind} #${rank}`,
        dedupeKey: `trend|${market}|${kind}|${symbol}|${hourBucket}`,
      });
      return;
    }
    alerts.submit({
      kind: 'trend',
      message: renderTrendBatch({ market, kind, entries: fresh, now, timezone }),
      summary: `${fresh.length} new in trending ${market} ${kind}: ${fresh.slice(0, 5).map((e) => e.symbol).join(', ')}${fresh.length > 5 ? ', ...' : ''}`,
      dedupeKey: `trend|${market}|${kind}|${createHash('sha1').update(fresh.map((e) => e.symbol).sort().join(',')).digest('hex').slice(0, 16)}|${hourBucket}`,
    });
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

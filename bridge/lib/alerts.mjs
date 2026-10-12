/**
 * Spam control in front of the delivery queue. Every alert goes through `submit`,
 * in this order:
 *
 *   1. Dedupe: the same dedupeKey within 24 hours is dropped.
 *   2. Cooldown: the same cooldownKey within cooldown_minutes is dropped.
 *   3. Daily cap: a rule with max_per_day is dropped once that many of its alerts were
 *      accepted (sent, digested, or held for a digest) on the current local calendar day. Critical
 *      alerts are never capped and never counted.
 *   4. Critical (health) alerts skip steps 5 and 6 and are sent at once.
 *   5. Quiet hours (config timezone): the alert is held. When quiet hours end, one
 *      digest is sent if digest_after_quiet is on, otherwise the held alerts are dropped.
 *   6. Hourly cap: after max_per_hour sends in a rolling hour, the alert waits in a
 *      digest, sent as one summary once a slot frees up.
 *   7. Otherwise the alert is sent.
 *
 * Accepted alerts are recorded in state (the last 500) for the dashboard.
 * `tick()` must run regularly. It ends quiet hours and sends digests.
 */
import { parseHHMM } from './config.mjs';
import { localDate, localMinutes, renderDigest } from './format.mjs';
import { prune } from './state.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Most summaries a digest buffer keeps. The oldest are dropped first, so a long outage cannot grow it. */
export const DIGEST_BUFFER_LIMIT = 500;

/** True when `at` is in the past and less than `windowMs` ago. A time in the future (clock jump) never counts. */
const within = (now, at, windowMs) => now >= at && now - at < windowMs;

function pushBounded(list, item) {
  list.push(item);
  if (list.length > DIGEST_BUFFER_LIMIT) list.splice(0, list.length - DIGEST_BUFFER_LIMIT);
}

/**
 * `alerts` is the config alerts section, `timezone` the config timezone, `store`
 * the state store, `clock` the injectable clock and `queue` the delivery queue.
 * `onRecord(entry)` is called once for every accepted alert, after it is stored and handled.
 */
export function createAlerts({ alerts, timezone, store, clock, queue, log = () => {}, onRecord = () => {} }) {
  const cooldownMs = alerts.cooldown_minutes * 60_000;
  const cap = alerts.max_per_hour;
  const quiet = alerts.quiet_hours === null ? null : {
    start: parseHHMM(alerts.quiet_hours.start),
    end: parseHHMM(alerts.quiet_hours.end),
  };

  const inQuiet = (ms) => {
    if (quiet === null) return false;
    const minutes = localMinutes(ms, timezone);
    // The window may cross midnight, e.g. 23:00 to 07:00.
    return quiet.start < quiet.end
      ? minutes >= quiet.start && minutes < quiet.end
      : minutes >= quiet.start || minutes < quiet.end;
  };

  const sendsInLastHour = (now) => {
    const s = store.state;
    s.sends = s.sends.filter((t) => now - t < HOUR_MS);
    return s.sends.length;
  };

  // Critical (health) messages are not counted against the hourly cap, so a burst of
  // "stream down" alerts can never starve the rule alerts that follow.
  const deliver = (message, now, { counted = true, critical = false } = {}) => {
    if (counted) store.state.sends.push(now);
    queue.enqueue(message, { critical });
    store.touch();
  };

  const digestMessage = (items, reason, now) => renderDigest(items, { reason, now, timezone });

  return {
    /**
     * Offers one alert. `item` is {kind, message, summary, dedupeKey?, cooldownKey?, critical?,
     * ruleId?, maxPerDay?, meta?}. `meta` (rule, symbol, timeframe, bar, direction, message, values) is kept on the
     * history entry for the dashboard. Returns 'sent', 'held', 'digested', 'duplicate', 'cooldown' or 'capped'.
     */
    submit(item) {
      const now = clock.now();
      const s = store.state;
      const { message, summary } = item;

      if (item.dedupeKey !== undefined && s.seen[item.dedupeKey] !== undefined
        && within(now, s.seen[item.dedupeKey], DAY_MS)) {
        log(`alert duplicate, dropped: ${item.dedupeKey}`);
        return 'duplicate';
      }
      if (item.cooldownKey !== undefined && s.cooldowns[item.cooldownKey] !== undefined
        && within(now, s.cooldowns[item.cooldownKey], cooldownMs)) {
        log(`alert in cooldown, dropped: ${item.cooldownKey}`);
        return 'cooldown';
      }

      // Counted per rule id per local day. A saved date other than today (a new day, or a
      // clock that stepped back across midnight) counts as zero, so a rule is never locked out.
      const dailyCap = item.maxPerDay !== undefined && item.critical !== true;
      const today = dailyCap ? localDate(now, timezone) : null;
      const usedToday = dailyCap && s.dailyCounts[item.ruleId]?.date === today ? s.dailyCounts[item.ruleId].count : 0;
      if (dailyCap && usedToday >= item.maxPerDay) {
        log(`alert over daily cap (${item.maxPerDay}), dropped: ${item.ruleId}`);
        return 'capped';
      }

      let status;
      if (item.critical === true) {
        status = 'sent';
      } else if (inQuiet(now)) {
        status = 'held';
      } else if (sendsInLastHour(now) >= cap) {
        status = 'digested';
      } else {
        status = 'sent';
      }

      if (item.dedupeKey !== undefined) s.seen[item.dedupeKey] = now;
      if (item.cooldownKey !== undefined) s.cooldowns[item.cooldownKey] = now;
      // Held alerts are dropped when quiet hours end if digest_after_quiet is off, so they never
      // reach anyone and must not use up the cap.
      if (dailyCap && (status !== 'held' || alerts.digest_after_quiet)) {
        s.dailyCounts[item.ruleId] = { date: today, count: usedToday + 1 };
      }
      const entry = { at: now, kind: item.kind, level: message.level, title: message.title, key: item.dedupeKey ?? null, status, meta: item.meta ?? null };
      s.alerts.push(entry);
      if (s.alerts.length > 500) s.alerts.splice(0, s.alerts.length - 500);

      if (status === 'sent') {
        deliver(message, now, { counted: item.critical !== true, critical: item.critical === true });
      } else if (status === 'held') {
        pushBounded(s.digest.held, { summary, at: now });
        store.touch();
      } else {
        pushBounded(s.digest.overflow, { summary, at: now });
        store.touch();
      }
      // Last, and guarded: a bug in a listener (the dashboard) must never lose or block an alert.
      try {
        onRecord(entry);
      } catch (err) {
        log(`onRecord failed: ${err?.message ?? 'error'}`);
      }
      return status;
    },

    /** Ends quiet hours and sends waiting digests when a slot is free. */
    tick() {
      const now = clock.now();
      const s = store.state;
      const quietNow = inQuiet(now);

      // Not tied to the quiet -> not quiet edge seen in this process: held alerts that were
      // saved before a restart (e.g. the watcher was down when quiet hours ended) go out too.
      if (!quietNow && s.digest.held.length > 0) {
        const held = s.digest.held;
        s.digest.held = [];
        if (alerts.digest_after_quiet) {
          for (const item of held) pushBounded(s.digest.overflow, { ...item, reason: 'quiet' });
          log(`quiet hours ended: ${held.length} held alert(s) queued for one digest`);
        } else {
          log(`quiet hours ended: ${held.length} held alert(s) dropped (digest_after_quiet is off)`);
        }
        store.touch();
      }

      prune(s, now);
      const today = localDate(now, timezone);
      for (const [id, entry] of Object.entries(s.dailyCounts)) {
        // Only earlier days (and junk) go. A later date means the clock stepped back; keep it.
        if (typeof entry?.date !== 'string' || entry.date < today) {
          delete s.dailyCounts[id];
          store.touch();
        }
      }

      if (!quietNow && s.digest.overflow.length > 0 && sendsInLastHour(now) < cap) {
        const items = s.digest.overflow;
        s.digest.overflow = [];
        const reasons = new Set(items.map((item) => item.reason ?? 'rate'));
        const reason = reasons.size === 1 ? [...reasons][0] : 'mixed';
        deliver(digestMessage(items, reason, now), now);
        log(`digest sent: ${items.length} alert(s)`);
      }
    },

    /** Accepted alerts (heartbeats excluded) whose time is at or after `sinceMs`. */
    countSince(sinceMs) {
      return store.state.alerts.filter((a) => a.at >= sinceMs && a.kind !== 'heartbeat').length;
    },

    /** Current quiet-hours state, for the health endpoint and heartbeat. */
    quietNow() {
      return inQuiet(clock.now());
    },

    /** Counts for logs and tests. */
    counts() {
      const s = store.state;
      return {
        sentLastHour: sendsInLastHour(clock.now()),
        held: s.digest.held.length,
        overflow: s.digest.overflow.length,
      };
    },
  };
}

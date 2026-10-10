/**
 * Spam control in front of the delivery queue. Every alert goes through `submit`,
 * in this order:
 *
 *   1. Dedupe: the same dedupeKey within 24 hours is dropped.
 *   2. Cooldown: the same cooldownKey within cooldown_minutes is dropped.
 *   3. Critical (health) alerts skip steps 4 and 5 and are sent at once.
 *   4. Quiet hours (config timezone): the alert is held. When quiet hours end, one
 *      digest is sent if digest_after_quiet is on, otherwise the held alerts are dropped.
 *   5. Hourly cap: after max_per_hour sends in a rolling hour, the alert waits in a
 *      digest, sent as one summary once a slot frees up.
 *   6. Otherwise the alert is sent.
 *
 * Accepted alerts are recorded in state (the last 500) for the dashboard.
 * `tick()` must run regularly. It ends quiet hours and sends digests.
 */
import { parseHHMM } from './config.mjs';
import { localMinutes, renderDigest } from './format.mjs';
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
 */
export function createAlerts({ alerts, timezone, store, clock, queue, log = () => {} }) {
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
  const deliver = (message, now, { counted = true } = {}) => {
    if (counted) store.state.sends.push(now);
    queue.enqueue(message);
    store.touch();
  };

  const digestMessage = (items, reason, now) => renderDigest(items, { reason, now, timezone });

  return {
    /**
     * Offers one alert. `item` is {kind, message, summary, dedupeKey?, cooldownKey?, critical?}.
     * Returns 'sent', 'held', 'digested', 'duplicate' or 'cooldown'.
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
      s.alerts.push({ at: now, kind: item.kind, level: message.level, title: message.title, key: item.dedupeKey ?? null, status });
      if (s.alerts.length > 500) s.alerts.splice(0, s.alerts.length - 500);

      if (status === 'sent') {
        deliver(message, now, { counted: item.critical !== true });
      } else if (status === 'held') {
        pushBounded(s.digest.held, { summary, at: now });
        store.touch();
      } else {
        pushBounded(s.digest.overflow, { summary, at: now });
        store.touch();
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

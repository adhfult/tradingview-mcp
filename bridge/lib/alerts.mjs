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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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

  let wasQuiet = inQuiet(clock.now());

  const sendsInLastHour = (now) => {
    const s = store.state;
    s.sends = s.sends.filter((t) => now - t < HOUR_MS);
    return s.sends.length;
  };

  const deliver = (message, now) => {
    store.state.sends.push(now);
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
        && now - s.seen[item.dedupeKey] < DAY_MS) {
        log(`alert duplicate, dropped: ${item.dedupeKey}`);
        return 'duplicate';
      }
      if (item.cooldownKey !== undefined && s.cooldowns[item.cooldownKey] !== undefined
        && now - s.cooldowns[item.cooldownKey] < cooldownMs) {
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
        deliver(message, now);
      } else if (status === 'held') {
        s.digest.held.push({ summary, at: now });
        store.touch();
      } else {
        s.digest.overflow.push({ summary, at: now });
        store.touch();
      }
      return status;
    },

    /** Ends quiet hours and sends waiting digests when a slot is free. */
    tick() {
      const now = clock.now();
      const s = store.state;
      const quietNow = inQuiet(now);

      if (wasQuiet && !quietNow && s.digest.held.length > 0) {
        const held = s.digest.held;
        s.digest.held = [];
        if (alerts.digest_after_quiet) {
          s.digest.overflow.push(...held.map((item) => ({ ...item, reason: 'quiet' })));
          log(`quiet hours ended: ${held.length} held alert(s) queued for one digest`);
        } else {
          log(`quiet hours ended: ${held.length} held alert(s) dropped (digest_after_quiet is off)`);
        }
        store.touch();
      }
      wasQuiet = quietNow;

      if (!quietNow && s.digest.overflow.length > 0 && sendsInLastHour(now) < cap) {
        const items = s.digest.overflow;
        s.digest.overflow = [];
        const reasons = new Set(items.map((item) => item.reason ?? 'rate'));
        const reason = reasons.size === 1 ? [...reasons][0] : 'mixed';
        deliver(digestMessage(items, reason, now), now);
        log(`digest sent: ${items.length} alert(s)`);
      }
    },

    /** Accepted alerts whose time is at or after `sinceMs`. */
    countSince(sinceMs) {
      return store.state.alerts.filter((a) => a.at >= sinceMs).length;
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

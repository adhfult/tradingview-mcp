import { ruleExpired } from './rules.mjs';

/**
 * The rules that may fire right now: not expired, and (for `calendar: us_session`) only while the market is
 * in session. `inSession` is judged by the caller from the bar's own open time, never the clock (see
 * onClosedBar in watcher.mjs). A composite's members are held to the same gates: a dead member cannot hit,
 * so it blocks an all_of and is simply absent from an any_of.
 *
 * One function for the watcher and the dashboard's rule preview, so the gates themselves cannot drift apart.
 * Returns new objects where a composite changed; the input is never mutated.
 */
export function selectActive(rules, { now, timezone, inSession }) {
  const live = (rule) => !ruleExpired(rule, now, timezone) && (rule.calendar !== 'us_session' || inSession);
  return rules.filter(live).flatMap((rule) => {
    if (!rule.members) return [rule];
    const members = rule.members.filter(live);
    return rule.type === 'all_of' && members.length < rule.members.length ? [] : [{ ...rule, members }];
  });
}

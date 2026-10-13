import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectActive } from '../../lib/gates.mjs';

const NOW = Date.parse('2026-06-10T15:00:00Z');
const base = { now: NOW, timezone: 'UTC', inSession: true };
const ids = (rules) => rules.map((r) => r.id);

test('selectActive: rules with no gates pass through untouched', () => {
  const rules = [{ id: 'a', type: 'price_cross', level: 1 }, { id: 'b', type: 'pct_move' }];
  assert.deepEqual(selectActive(rules, base), rules);
});

test('selectActive: an expired rule is dropped, the last day itself still counts', () => {
  const rules = [{ id: 'old', expires: '2026-06-09' }, { id: 'today', expires: '2026-06-10' }, { id: 'open' }];
  assert.deepEqual(ids(selectActive(rules, base)), ['today', 'open']);
});

test('selectActive: expiry is judged in the given timezone', () => {
  const rules = [{ id: 'r', expires: '2026-06-10' }];
  // 2026-06-11 02:00 UTC is still June 10 in New York.
  const late = { now: Date.parse('2026-06-11T02:00:00Z') };
  assert.deepEqual(ids(selectActive(rules, { ...base, ...late, timezone: 'America/New_York' })), ['r']);
  assert.deepEqual(ids(selectActive(rules, { ...base, ...late, timezone: 'UTC' })), []);
});

test('selectActive: a us_session rule needs inSession, other calendars and none do not', () => {
  const rules = [{ id: 'us', calendar: 'us_session' }, { id: 'any' }];
  assert.deepEqual(ids(selectActive(rules, { ...base, inSession: false })), ['any']);
  assert.deepEqual(ids(selectActive(rules, { ...base, inSession: true })), ['us', 'any']);
});

test('selectActive: members are held to the same gates', () => {
  const live = { id: 'live', type: 'price_cross' };
  const dead = { id: 'dead', type: 'price_cross', expires: '2020-01-01' };
  const [anyOf] = selectActive([{ id: 'c', type: 'any_of', members: [live, dead] }], base);
  assert.deepEqual(ids(anyOf.members), ['live']);
});

test('selectActive: an all_of with a dead member is dropped whole', () => {
  const dead = { id: 'dead', type: 'price_cross', calendar: 'us_session' };
  const rules = [{ id: 'c', type: 'all_of', members: [{ id: 'live', type: 'price_cross' }, dead] }];
  assert.deepEqual(selectActive(rules, { ...base, inSession: false }), []);
  assert.equal(selectActive(rules, { ...base, inSession: true })[0].members.length, 2);
});

test('selectActive: the input rules are not changed', () => {
  const member = { id: 'dead', expires: '2020-01-01' };
  const rule = { id: 'c', type: 'any_of', members: [member, { id: 'live' }] };
  selectActive([rule], base);
  assert.equal(rule.members.length, 2);
});

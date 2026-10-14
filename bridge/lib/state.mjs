/**
 * The watcher's persistent state, kept in `<state_dir>/state.json`.
 *
 * - Writes are atomic: a temp file is written and fsynced, then renamed over the
 *   old file (and the directory is fsynced), so a crash never leaves half a file.
 * - Changes are debounced: `touch()` schedules at most one write per `debounceMs`
 *   window. `flush()` writes now (used on shutdown).
 * - A file that cannot be parsed is renamed to `state.json.corrupt-<ms>` and the
 *   watcher starts with empty state, logging the event.
 * - `persist: false` (dry run) keeps everything in memory and never writes.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const STATE_FILE = 'state.json';
export const STATE_VERSION = 1;
export const DEFAULT_DEBOUNCE_MS = 5000;
export const ALERT_HISTORY_LIMIT = 500;
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;
const SEEN_LIMIT = 5000;
const COOLDOWN_TTL_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export function emptyState() {
  return {
    version: STATE_VERSION,
    streams: {}, // "SYMBOL|tf" -> { lastEvaluatedTime }
    cooldowns: {}, // cooldown key -> last sent (ms)
    dailyCounts: {}, // rule id -> { date: local YYYY-MM-DD, count } for max_per_day
    seen: {}, // dedupe key -> first accepted (ms)
    trending: {}, // "market|kind" -> { SYMBOL: last seen in the top list (ms) }
    news: { seen: {}, titles: {}, seeded: {}, runs: {}, rememberMs: 72 * HOUR_MS },
    alerts: [], // most recent accepted alerts, for the dashboard and heartbeat
    digest: { held: [], overflow: [] }, // summaries waiting for quiet hours to end or a free slot
    sends: [], // send times (ms) inside the rolling hour
    heartbeatDate: null, // local YYYY-MM-DD of the last heartbeat
  };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Keeps only fields of the expected type, so an older or hand-edited file still loads. */
function normalize(raw) {
  const base = emptyState();
  if (!isObject(raw)) return null;
  const out = { ...base };
  if (isObject(raw.streams)) out.streams = raw.streams;
  if (isObject(raw.cooldowns)) out.cooldowns = raw.cooldowns;
  if (isObject(raw.dailyCounts)) {
    for (const [id, entry] of Object.entries(raw.dailyCounts)) {
      if (isObject(entry) && typeof entry.date === 'string' && Number.isSafeInteger(entry.count) && entry.count >= 0) {
        out.dailyCounts[id] = { date: entry.date, count: entry.count };
      }
    }
  }
  if (isObject(raw.seen)) out.seen = raw.seen;
  if (isObject(raw.trending)) out.trending = raw.trending;
  if (isObject(raw.news)) {
    for (const key of ['seen', 'titles', 'seeded', 'runs']) {
      if (isObject(raw.news[key])) out.news[key] = Object.fromEntries(
        Object.entries(raw.news[key]).filter(([, at]) => Number.isFinite(at) && at >= 0),
      );
    }
    if (Number.isFinite(raw.news.rememberMs) && raw.news.rememberMs > 0 && raw.news.rememberMs <= 168 * HOUR_MS) {
      out.news.rememberMs = raw.news.rememberMs;
    }
  }
  if (Array.isArray(raw.alerts)) out.alerts = raw.alerts;
  if (isObject(raw.digest)) {
    out.digest = {
      held: Array.isArray(raw.digest.held) ? raw.digest.held : [],
      overflow: Array.isArray(raw.digest.overflow) ? raw.digest.overflow : [],
    };
  }
  if (Array.isArray(raw.sends)) out.sends = raw.sends.filter((t) => Number.isFinite(t));
  if (typeof raw.heartbeatDate === 'string') out.heartbeatDate = raw.heartbeatDate;
  return out;
}

/** Drops entries that no longer matter, so the file stays small. */
export function prune(state, nowMs) {
  if (state.news) {
    for (const [bucket, ttl, limit] of [
      ['seen', state.news.rememberMs, 20_000], ['titles', 6 * HOUR_MS, 20_000],
      ['seeded', Infinity, 2000], ['runs', Infinity, 2000],
    ]) {
      const entries = state.news[bucket];
      for (const [key, at] of Object.entries(entries)) {
        if (!Number.isFinite(at) || nowMs - at > ttl) delete entries[key];
      }
      const keys = Object.keys(entries).sort((a, b) => entries[a] - entries[b]);
      for (const key of keys.slice(0, Math.max(0, keys.length - limit))) delete entries[key];
    }
  }
  for (const [key, at] of Object.entries(state.seen)) {
    if (nowMs - at > SEEN_TTL_MS) delete state.seen[key];
  }
  const seenKeys = Object.keys(state.seen);
  if (seenKeys.length > SEEN_LIMIT) {
    seenKeys
      .sort((a, b) => state.seen[a] - state.seen[b])
      .slice(0, seenKeys.length - SEEN_LIMIT)
      .forEach((key) => { delete state.seen[key]; });
  }
  for (const [key, at] of Object.entries(state.cooldowns)) {
    if (nowMs - at > COOLDOWN_TTL_MS) delete state.cooldowns[key];
  }
  state.sends = state.sends.filter((t) => nowMs - t < HOUR_MS);
  if (state.alerts.length > ALERT_HISTORY_LIMIT) {
    state.alerts = state.alerts.slice(state.alerts.length - ALERT_HISTORY_LIMIT);
  }
  return state;
}

/**
 * Creates the store. `clock` supplies `now()`, `setTimeout` and `clearTimeout`.
 * `fsp` is the promises API of node:fs (injectable for failure tests).
 */
export function createStateStore({
  dir,
  clock,
  log = () => {},
  persist = true,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  fsp = { mkdir, open, readFile, rename, rm },
}) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('createStateStore requires dir');
  const file = join(dir, STATE_FILE);
  let state = emptyState();
  let dirty = false;
  let timer = null;
  let chain = Promise.resolve();

  const writeAtomic = async (text) => {
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
      const handle = await fsp.open(tmp, 'w', 0o600);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsp.rename(tmp, file);
      // Make the rename itself durable (power loss on an SD card). Best effort: some
      // platforms cannot open a directory.
      try {
        const dirHandle = await fsp.open(dir, 'r');
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      } catch {
        // The data file is already in place; losing only the directory sync is acceptable.
      }
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  };

  const doWrite = async () => {
    if (!dirty) return;
    dirty = false;
    prune(state, clock.now());
    try {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      await writeAtomic(`${JSON.stringify(state)}\n`);
    } catch (err) {
      dirty = true;
      throw err;
    }
  };

  const store = {
    file,

    /** Reads the file, or starts empty. A corrupt file is moved aside first. */
    async load() {
      let text;
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch (err) {
        if (err?.code !== 'ENOENT') log(`state file could not be read (${err?.code ?? 'error'}); starting empty`);
        state = emptyState();
        return state;
      }
      let parsed = null;
      try {
        parsed = normalize(JSON.parse(text));
      } catch {
        parsed = null;
      }
      if (parsed === null) {
        const moved = `${file}.corrupt-${clock.now()}`;
        try {
          await fsp.rename(file, moved);
          log(`state file was corrupt; moved to ${moved} and starting empty`);
        } catch {
          log('state file was corrupt and could not be moved; starting empty');
        }
        state = emptyState();
        return state;
      }
      state = parsed;
      return state;
    },

    /** The live state object. Mutate it, then call touch(). */
    get state() {
      return state;
    },

    /** Marks the state as changed and schedules a write within debounceMs. */
    touch() {
      if (!persist) return;
      dirty = true;
      if (timer !== null) return;
      timer = clock.setTimeout(() => {
        timer = null;
        store.flush().catch((err) => log(`state write failed: ${err?.code ?? 'error'}`));
      }, debounceMs);
    },

    /** Writes now if anything changed. Calls are queued, so writes never overlap. */
    flush() {
      if (!persist) {
        dirty = false;
        return Promise.resolve();
      }
      if (timer !== null) {
        clock.clearTimeout(timer);
        timer = null;
      }
      // A failed write must not block later ones, so the chain always continues.
      chain = chain.catch(() => {}).then(doWrite);
      return chain;
    },

    /** Cancels the pending timer and writes anything still dirty. */
    async close() {
      await store.flush();
    },
  };
  return store;
}

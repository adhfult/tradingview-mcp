/**
 * Notes from an Obsidian folder, shown on the dashboard next to a stream's chart. Read-only: this module
 * never writes to the folder, and nothing in a request chooses a file.
 *
 * A note is served only if it is a regular `.md` file directly inside the configured folder AND its
 * frontmatter has `symbols` (see frontmatter.mjs and docs/handoffs/phase-7a-design.md section 8). Only the
 * first 16 KB of each file is read, at most 500 files (the newest) are looked at, and the folder is scanned
 * lazily, when a browser asks, with the result cached for 30 s.
 *
 * ponytail: the folder is flat (no subfolders) and files are read one after another. Add a recursive walk or
 * parallel reads if a vault ever needs them; the cache already hides the cost of a scan.
 */
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage } from './errors.mjs';
import { parseFrontmatter } from './frontmatter.mjs';

export const MAX_NOTE_FILES = 500;
export const MAX_NOTE_BYTES = 16 * 1024;
export const EXCERPT_CHARS = 280;
export const CACHE_MS = 30_000;

const KINDS = new Set(['news', 'opportunity', 'risk']);
const TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Unix seconds from a note's `time`, or null. A date alone means the end of that UTC day, so on a daily chart the
 * marker lands on that day's bar. A datetime with no zone is read as UTC (Obsidian writes them that way).
 */
export function parseNoteTime(value) {
  if (typeof value !== 'string') return null;
  const m = TIME.exec(value.trim());
  if (m === null) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dateOnly = m[4] === undefined;
  const [hour, minute, second] = dateOnly ? [23, 59, 59] : [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(ms); // Date.UTC rolls 2026-02-30 over to March: reject anything that changed
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMs = 0;
  if (m[7] !== undefined && m[7] !== 'Z') {
    const [, sign, hh, mm] = /^([+-])(\d{2}):(\d{2})$/.exec(m[7]);
    if (Number(hh) > 23 || Number(mm) > 59) return null;
    offsetMs = (sign === '-' ? -1 : 1) * (Number(hh) * 60 + Number(mm)) * 60_000;
  }
  return Math.floor((ms - offsetMs) / 1000);
}

/** The note's `symbols` name the stream: the whole symbol ("BINANCE:BTCUSDT") or its ticker part ("BTCUSDT"), any case. */
export function symbolMatches(noteSymbols, streamSymbol) {
  const full = String(streamSymbol).toLowerCase();
  const ticker = full.slice(full.indexOf(':') + 1); // no colon: indexOf is -1, so the whole symbol
  return noteSymbols.some((s) => {
    const name = String(s).trim().toLowerCase();
    return name !== '' && (name === full || name === ticker);
  });
}

/**
 * The first 16 KB of a regular file as text, or null (symlink, FIFO, unreadable, not UTF-8). O_NOFOLLOW refuses a
 * symlink that appears after the listing; O_NONBLOCK makes opening a FIFO return at once instead of pinning one of
 * libuv's four threads. A cut in the middle of a multi-byte character is not an error, so a long note is still read.
 */
async function readHead(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.allocUnsafe(MAX_NOTE_BYTES);
    let total = 0;
    while (total < MAX_NOTE_BYTES) { // a read may be short (network filesystems)
      const { bytesRead } = await handle.read(buffer, total, MAX_NOTE_BYTES - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total), { stream: total === MAX_NOTE_BYTES });
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Inline markdown reduced to its words: links, wiki links, emphasis and code marks. Embeds and images are dropped. */
function plain(text) {
  return text
    .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`~]+/g, '')
    .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Title (first "# " heading, else null) and an excerpt of the rest, markdown punctuation removed. */
function readBody(body) {
  let title = null;
  const parts = [];
  for (const line of body.split('\n')) {
    if (title === null && /^# +\S/.test(line)) {
      title = plain(line.slice(2));
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue; // horizontal rule
    const words = plain(line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*>+\s?/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ''));
    if (words !== '') parts.push(words);
  }
  const text = parts.join(' ');
  const excerpt = text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1).trimEnd()}…` : text;
  return { title: title === '' ? null : title, excerpt };
}

const symbolsOf = (value) => (Array.isArray(value) ? value : [value]).filter((s) => typeof s === 'string').map((s) => s.trim()).filter((s) => s !== '');

/** `{vault, folder, list(symbol)}`. `list` resolves to the notes for one stream symbol, newest first. */
export function createNotes({ dir, vault, vaultFolder, clock, logger }) {
  const enc = encodeURIComponent;
  let cache = null; // {at, promise}: concurrent requests share one scan
  let warned = false;

  function parseNote(name, text) {
    const front = parseFrontmatter(text);
    if (front === null) return null;
    const symbols = symbolsOf(front.data.symbols);
    if (symbols.length === 0) return null;
    const stem = name.slice(0, -'.md'.length);
    const { title, excerpt } = readBody(front.body);
    const kind = typeof front.data.kind === 'string' ? front.data.kind.trim().toLowerCase() : '';
    return {
      title: title ?? stem,
      kind: KINDS.has(kind) ? kind : 'note',
      time: typeof front.data.time === 'string' ? parseNoteTime(front.data.time) : null,
      symbols,
      excerpt,
      open: `obsidian://open?vault=${enc(vault)}&file=${enc(`${vaultFolder}/${stem}`)}`,
    };
  }

  async function scan() {
    let names;
    try {
      names = await readdir(dir);
      warned = false;
    } catch (err) {
      if (!warned) logger.warn(`dashboard notes: cannot read ${dir} (${err?.code ?? errorMessage(err)}); it is checked again on the next scan`);
      warned = true;
      return [];
    }
    const files = [];
    for (const name of names) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue;
      try {
        const info = await lstat(join(dir, name)); // lstat: a symlink is not a regular file
        if (info.isFile()) files.push({ name, mtimeMs: info.mtimeMs });
      } catch { /* gone since the listing */ }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const found = [];
    for (const { name, mtimeMs } of files.slice(0, MAX_NOTE_FILES)) {
      try {
        const text = await readHead(join(dir, name));
        const parsed = text === null ? null : parseNote(name, text);
        if (parsed !== null) found.push({ ...parsed, sortKey: parsed.time ?? Math.floor(mtimeMs / 1000) });
      } catch (err) {
        logger.warn(`dashboard notes: ${name} skipped (${errorMessage(err)})`);
      }
    }
    return found.sort((a, b) => b.sortKey - a.sortKey);
  }

  return {
    vault,
    folder: vaultFolder,
    async list(symbol) {
      const now = clock.now();
      if (cache === null || now - cache.at >= CACHE_MS) cache = { at: now, promise: scan() };
      const all = await cache.promise;
      return all.filter((n) => symbolMatches(n.symbols, symbol)).map(({ sortKey, ...note }) => note);
    },
  };
}

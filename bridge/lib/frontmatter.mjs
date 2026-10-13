/**
 * A small subset parser for the frontmatter ("properties") Obsidian writes at the top of a note.
 * Not YAML: only `key: value`, `key: [a, b]`, block lists (`key:` then `- item` lines), single and
 * double quotes, comments and CRLF. Every value is a string or an array of strings.
 *
 * Anything it cannot read makes parseFrontmatter return null, so the caller skips the note instead of
 * serving a wrong reading. Ceiling: nested YAML is ignored (indented lines under a bare key are skipped).
 * Upgrade path: the `yaml` package, if richer properties are ever wanted.
 */

const KEY_LINE = /^([^\s:#-][^:]*?)\s*:(?:\s+(.*)|\s*)$/;
const FENCE = /^---\s*$/;
const END_FENCE = /^(---|\.\.\.)\s*$/;

/** Text up to the closing quote at `start` (the opening quote index), or null. Returns {value, end} with end past the quote. */
function readQuoted(text, start) {
  const quote = text[start];
  let out = '';
  for (let i = start + 1; i < text.length; i += 1) {
    const c = text[i];
    if (quote === '"' && c === '\\' && i + 1 < text.length) {
      out += text[i + 1];
      i += 1;
    } else if (c === quote) {
      if (quote === "'" && text[i + 1] === "'") { // '' is an escaped quote
        out += "'";
        i += 1;
      } else {
        return { value: out, end: i + 1 };
      }
    } else {
      out += c;
    }
  }
  return null;
}

/** A `#` that starts a comment: preceded by whitespace. Returns the text without it. */
const stripComment = (text) => text.replace(/\s+#.*$/, '').trimEnd();

/** One scalar (quoted or bare, with a trailing comment removed), or null when a quote is unterminated or has trailing junk. */
function readScalar(raw) {
  const text = raw.trim();
  if (text[0] === '"' || text[0] === "'") {
    const q = readQuoted(text, 0);
    if (q === null || stripComment(text.slice(q.end)) !== '') return null;
    return q.value;
  }
  return stripComment(text);
}

/** `[a, "b,c", d]` -> array, or null when it is not a closed list. */
function readInlineList(raw) {
  const text = stripComment(raw.trim());
  if (!text.endsWith(']')) return null;
  const inner = text.slice(1, -1);
  const items = [];
  let i = 0;
  while (i < inner.length) {
    while (inner[i] === ' ' || inner[i] === '\t') i += 1;
    if (i >= inner.length) break;
    if (inner[i] === '"' || inner[i] === "'") {
      const q = readQuoted(inner, i);
      if (q === null) return null;
      items.push(q.value);
      i = q.end;
      while (inner[i] === ' ' || inner[i] === '\t') i += 1;
      if (i < inner.length && inner[i] !== ',') return null;
    } else {
      const comma = inner.indexOf(',', i);
      const end = comma < 0 ? inner.length : comma;
      const item = inner.slice(i, end).trim();
      if (/[[\]]/.test(item)) return null; // nested list or a stray bracket
      if (item !== '') items.push(item);
      i = end;
    }
    if (inner[i] === ',') i += 1;
  }
  return items;
}

/**
 * `{data, body}` for a note. No frontmatter at all: `{data: {}, body: text}`. Unclosed or unreadable: null.
 */
export function parseFrontmatter(input) {
  if (typeof input !== 'string') return null;
  const text = input.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  if (!FENCE.test(lines[0])) return { data: {}, body: text };
  const close = lines.findIndex((line, i) => i > 0 && END_FENCE.test(line));
  if (close < 0) return null;

  const data = new Map(); // a Map, then fromEntries: a `__proto__` key becomes plain data
  let listKey = null; // the key whose block list is being read
  for (const line of lines.slice(1, close)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const item = /^\s*-\s+(.*)$/.exec(line) ?? (/^\s*-\s*$/.test(line) ? ['', ''] : null);
    if (item !== null) {
      if (listKey === null) return null;
      const value = readScalar(item[1]);
      if (value === null) return null;
      if (data.get(listKey) === '') data.set(listKey, []);
      data.get(listKey).push(value);
      continue;
    }
    if (/^\s/.test(line)) continue; // nested YAML under a key: ignored
    const pair = KEY_LINE.exec(line);
    if (pair === null) return null;
    const [, key, raw = ''] = pair;
    listKey = null;
    const value = raw.trim();
    if (value === '' || value.startsWith('#')) {
      data.set(key, ''); // a bare key: becomes a block list if `- ` lines follow
      listKey = key;
    } else if (value.startsWith('[')) {
      const list = readInlineList(value);
      if (list === null) return null;
      data.set(key, list);
    } else {
      const scalar = readScalar(value);
      if (scalar === null) return null;
      data.set(key, scalar);
    }
  }
  return { data: Object.fromEntries(data), body: lines.slice(close + 1).join('\n') };
}

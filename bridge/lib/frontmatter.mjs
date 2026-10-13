/**
 * A small subset parser for the frontmatter ("properties") Obsidian writes at the top of a note.
 * Not YAML: only `key: value`, `key: [a, b]`, block lists (`key:` then `- item` lines), single and
 * double quotes, comments and CRLF. Every value is a string or an array of strings.
 *
 * Anything it cannot read makes parseFrontmatter return null, so the caller skips the note instead of
 * serving a wrong reading. Ceiling: nested YAML is ignored (indented lines under a bare key are skipped).
 * Upgrade path: the `yaml` package, if richer properties are ever wanted.
 */

const FENCE = /^---\s*$/;
const END_FENCE = /^(---|\.\.\.)\s*$/;

const ESCAPES = { n: '\n', t: '\t', r: '\r', 0: '\0', '"': '"', '\\': '\\', '/': '/' };

/** Text up to the closing quote at `start` (the opening quote index), or null. Returns {value, end} with end past the quote. */
function readQuoted(text, start) {
  const quote = text[start];
  let out = '';
  for (let i = start + 1; i < text.length; i += 1) {
    const c = text[i];
    if (quote === '"' && c === '\\') {
      const next = text[i + 1];
      if (next === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 5;
      } else if (Object.hasOwn(ESCAPES, next)) { // an unknown escape is not YAML: the note is unreadable
        out += ESCAPES[next];
        i += 1;
      } else {
        return null;
      }
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

/** The text without a trailing comment (a `#` preceded by whitespace). A plain scan: a regex here is quadratic on long whitespace runs. */
function stripComment(text) {
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] === '#' && (text[i - 1] === ' ' || text[i - 1] === '\t')) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

/** `key: raw` for a "key: value" line (raw trimmed), else null. The key runs to the first colon, which must end the line or be followed by a blank. */
function readPair(line) {
  if (line === '' || /[\s:#-]/.test(line[0])) return null;
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const after = line.slice(colon + 1);
  if (after !== '' && after[0] !== ' ' && after[0] !== '\t') return null; // "url:http://x" is not a pair
  return { key: line.slice(0, colon).trimEnd(), raw: after.trim() };
}

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

/** `[a, "b,c", d]` -> array, or null when it is not a closed flat list. A `#` after the closing bracket starts a comment. */
function readInlineList(raw) {
  const text = raw.trim();
  const blank = (c) => c === ' ' || c === '\t';
  const items = [];
  let i = 1; // past the opening bracket
  for (;;) {
    while (blank(text[i])) i += 1;
    if (i >= text.length) return null; // never closed
    if (text[i] === ']') break;
    let item;
    if (text[i] === '"' || text[i] === "'") {
      const q = readQuoted(text, i);
      if (q === null) return null;
      item = q.value;
      i = q.end;
      while (blank(text[i])) i += 1;
      if (text[i] !== ',' && text[i] !== ']') return null;
    } else {
      let j = i;
      while (j < text.length && text[j] !== ',' && text[j] !== ']') {
        if (text[j] === '[') return null; // a nested list
        j += 1;
      }
      item = text.slice(i, j).trim();
      i = j;
    }
    if (item !== '') items.push(item);
    if (text[i] === ',') i += 1;
  }
  const rest = text.slice(i + 1);
  return rest.trim() === '' || /^[ \t]+#/.test(rest) ? items : null;
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
  let nested = false; // an indented mapping line was seen under it: later `- ` lines belong to that mapping, not to the key
  for (const line of lines.slice(1, close)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const item = /^\s*-\s+(.*)$/.exec(line) ?? (/^\s*-\s*$/.test(line) ? ['', ''] : null);
    if (item !== null) {
      if (listKey === null) return null;
      if (nested) continue;
      const value = readScalar(item[1]);
      if (value === null) return null;
      if (data.get(listKey) === '') data.set(listKey, []);
      data.get(listKey).push(value);
      continue;
    }
    if (/^\s/.test(line)) { // nested YAML under a key: ignored
      nested = true;
      continue;
    }
    const pair = readPair(line);
    if (pair === null) return null;
    const { key, raw: value } = pair;
    listKey = null;
    nested = false;
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

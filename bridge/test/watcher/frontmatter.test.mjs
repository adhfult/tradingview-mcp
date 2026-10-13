import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../../lib/frontmatter.mjs';

// parseFrontmatter(text) -> { data, body } | null
//   no frontmatter at all  -> { data: {}, body: text }
//   unclosed / unreadable  -> null (the caller skips the note)
// Values are strings or arrays of strings: nothing is turned into a number, boolean or date.

const note = (...lines) => lines.join('\n');

test('key: value pairs, with the body after the closing line', () => {
  const r = parseFrontmatter(note('---', 'kind: news', 'time: 2026-10-12T14:30:00Z', '---', '# Title', 'Body'));
  assert.deepEqual(r.data, { kind: 'news', time: '2026-10-12T14:30:00Z' });
  assert.equal(r.body, '# Title\nBody');
});

test('an inline list, with and without spaces, empty, and with a quoted item holding a comma', () => {
  const data = (line) => parseFrontmatter(note('---', line, '---', '')).data.symbols;
  assert.deepEqual(data('symbols: [BINANCE:BTCUSDT]'), ['BINANCE:BTCUSDT']);
  assert.deepEqual(data('symbols: [BTCUSDT,NVDA ,  ETHUSDT]'), ['BTCUSDT', 'NVDA', 'ETHUSDT']);
  assert.deepEqual(data('symbols: []'), []);
  assert.deepEqual(data('symbols: ["a,b", \'c d\', e]'), ['a,b', 'c d', 'e']);
});

test('a block list, indented or not, as Obsidian\'s property editor writes it', () => {
  const r = parseFrontmatter(note('---', 'symbols:', '  - BINANCE:BTCUSDT', '  - "NVDA"', 'kind: risk', 'tags:', '- a', '- b', '---', 'x'));
  assert.deepEqual(r.data, { symbols: ['BINANCE:BTCUSDT', 'NVDA'], kind: 'risk', tags: ['a', 'b'] });
});

test('quotes are removed, and a quoted value keeps a # and a colon', () => {
  const r = parseFrontmatter(note('---', 'a: "x: y # z"', "b: 'it''s'", 'c: "esc \\" quote"', '---', ''));
  assert.equal(r.data.a, 'x: y # z');
  assert.equal(r.data.b, "it's");
  assert.equal(r.data.c, 'esc " quote');
});

test('a trailing comment is dropped, a # inside a word is not', () => {
  const r = parseFrontmatter(note('---', 'symbols: [BINANCE:BTCUSDT]      # or the block form', 'time: 2026-10-12   # optional', 'tag: C#', 'url: a#b', '---', ''));
  assert.deepEqual(r.data, { symbols: ['BINANCE:BTCUSDT'], time: '2026-10-12', tag: 'C#', url: 'a#b' });
});

test('CRLF line endings and a leading byte-order mark', () => {
  const r = parseFrontmatter('﻿---\r\nsymbols:\r\n  - BTCUSDT\r\nkind: news\r\n---\r\n# T\r\nbody\r\n');
  assert.deepEqual(r.data, { symbols: ['BTCUSDT'], kind: 'news' });
  assert.equal(r.body, '# T\nbody\n');
});

test('blank lines and comment lines inside the block are fine; a key with no value is an empty string', () => {
  const r = parseFrontmatter(note('---', '# a comment', '', 'kind:', 'time: 2026-10-12', '---', ''));
  assert.deepEqual(r.data, { kind: '', time: '2026-10-12' });
});

test('values stay strings: no number, boolean or date conversion', () => {
  const r = parseFrontmatter(note('---', 'n: 42', 'b: true', 'z: null', '---', ''));
  assert.deepEqual(r.data, { n: '42', b: 'true', z: 'null' });
});

test('a repeated key: the last one wins', () => {
  assert.deepEqual(parseFrontmatter(note('---', 'kind: news', 'kind: risk', '---', '')).data, { kind: 'risk' });
});

test('nested YAML is ignored, not misread: indented lines under a key with no value are skipped', () => {
  const r = parseFrontmatter(note('---', 'meta:', '  author: me', '  deep:', '    x: 1', 'kind: news', '---', ''));
  assert.deepEqual(r.data, { meta: '', kind: 'news' });
});

test('a __proto__ key is plain data and pollutes nothing', () => {
  const r = parseFrontmatter(note('---', '__proto__: polluted', 'constructor: x', '---', ''));
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(r.data), Object.prototype);
  assert.deepEqual(Object.keys(r.data).sort(), ['__proto__', 'constructor']);
});

test('no frontmatter: empty data and the whole text as body', () => {
  for (const text of ['# Just a note\nbody', '', '\n---\nkind: news\n---\n', 'text\n---\nkind: news\n---']) {
    assert.deepEqual(parseFrontmatter(text), { data: {}, body: text.replace(/\r\n/g, '\n') }, JSON.stringify(text));
  }
});

test('malformed frontmatter is null: unclosed, an unreadable line, a broken list, an unterminated quote', () => {
  for (const text of [
    note('---', 'kind: news', '# Title'),
    note('---', 'this is not a pair', '---', ''),
    note('---', 'symbols: [a, b', '---', ''),
    note('---', 'symbols: [a, "b]', '---', ''),
    note('---', 'kind: "news', '---', ''),
    note('---', '- orphan item', '---', ''),
    note('---', ': no key', '---', ''),
  ]) {
    assert.equal(parseFrontmatter(text), null, JSON.stringify(text));
  }
});

test('the closing line may be --- or ...; a --- inside the body does not matter', () => {
  assert.deepEqual(parseFrontmatter(note('---', 'kind: news', '...', 'x')).data, { kind: 'news' });
  const r = parseFrontmatter(note('---', 'kind: news', '---', 'a', '---', 'b: c'));
  assert.deepEqual(r.data, { kind: 'news' });
  assert.equal(r.body, 'a\n---\nb: c');
});

test('an empty frontmatter block is valid and empty', () => {
  assert.deepEqual(parseFrontmatter(note('---', '---', 'body')), { data: {}, body: 'body' });
});

test('a non-string input is no frontmatter, not a crash', () => {
  for (const value of [undefined, null, 5, {}]) assert.equal(parseFrontmatter(value), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFeed } from '../../lib/atom.mjs';

const ATOM_NS = 'http://www.w3.org/2005/Atom';

function atomEntry({
  id = 'urn:test:entry-1',
  title = 'Example headline',
  link = 'https://example.com/story',
  updated = '2026-10-14T12:00:00Z',
  summary = 'Example summary',
} = {}) {
  const fields = [];
  if (id !== null) fields.push(`<id>${id}</id>`);
  if (title !== null) fields.push(`<title>${title}</title>`);
  if (link !== null) fields.push(`<link rel="alternate" href="${link}"/>`);
  if (updated !== null) fields.push(`<updated>${updated}</updated>`);
  if (summary !== null) fields.push(`<summary>${summary}</summary>`);
  return `<entry>${fields.join('')}</entry>`;
}

function atomFeed(entries) {
  return `<feed xmlns="${ATOM_NS}">${entries}</feed>`;
}

test('parses both recorded SEC getcurrent pages with 100 entries each', async () => {
  for (const name of ['sec-getcurrent-8k-page1.atom', 'sec-getcurrent-8k-page2.atom']) {
    const xml = await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
    const entries = parseFeed(xml);
    assert.equal(entries.length, 100, name);
    assert.deepEqual(Object.keys(entries[0]), ['id', 'title', 'link', 'updated', 'summary']);
    assert.match(entries[0].link, /^https:\/\//);
    for (const entry of entries) {
      assert.ok(entry.id);
      assert.ok(entry.title);
      assert.ok(entry.link);
      assert.ok(entry.updated);
      assert.ok(entry.summary);
    }
  }
});

test('parses RSS item fields and maps guid, pubDate, and description', () => {
  const xml = '<rss version="2.0"><channel><item>'
    + '<guid>urn:test:rss-1</guid><title>RSS headline</title>'
    + '<link>https://example.com/rss-story</link><pubDate>Wed, 14 Oct 2026 12:00:00 GMT</pubDate>'
    + '<description>RSS summary</description></item></channel></rss>';
  assert.deepEqual(parseFeed(xml), [{
    id: 'urn:test:rss-1',
    title: 'RSS headline',
    link: 'https://example.com/rss-story',
    updated: 'Wed, 14 Oct 2026 12:00:00 GMT',
    summary: 'RSS summary',
  }]);
  const withoutGuid = parseFeed(xml.replace('<guid>urn:test:rss-1</guid>', ''))[0];
  assert.equal(withoutGuid.id, withoutGuid.link, 'RSS link is the fallback id when guid is absent');
});

test('accepts namespace-prefixed Atom element names', () => {
  const entry = atomEntry().replaceAll('<entry>', '<a:entry>').replaceAll('</entry>', '</a:entry>')
    .replaceAll('<id>', '<a:id>').replaceAll('</id>', '</a:id>')
    .replaceAll('<title>', '<a:title>').replaceAll('</title>', '</a:title>')
    .replaceAll('<link ', '<a:link ')
    .replaceAll('<updated>', '<a:updated>').replaceAll('</updated>', '</a:updated>')
    .replaceAll('<summary>', '<a:summary>').replaceAll('</summary>', '</a:summary>');
  const xml = `<a:feed xmlns:a="${ATOM_NS}">${entry}</a:feed>`;
  assert.equal(parseFeed(xml)[0].title, 'Example headline');
});

test('decodes predefined and numeric entities once', () => {
  const xml = atomFeed(atomEntry({
    title: 'A &amp; B &amp;lt; &#65; &#x1F4B0; &quot;x&quot; &apos;q&apos; &gt;',
  }));
  assert.equal(parseFeed(xml)[0].title, 'A & B &lt; A 💰 "x" \'q\' >');
});

test('refuses documents containing a DOCTYPE or ENTITY declaration', () => {
  assert.throws(
    () => parseFeed(`<!DOCTYPE feed [<!ENTITY x "expanded">]>${atomFeed(atomEntry({ title: '&x;' }))}`),
    /DOCTYPE|DTD/i,
  );
  assert.throws(
    () => parseFeed(`<!ENTITY x "expanded">${atomFeed(atomEntry({ title: '&x;' }))}`),
    /ENTITY|DTD/i,
  );
});

test('does not double-decode &amp;lt; into a less-than sign', () => {
  assert.equal(parseFeed(atomFeed(atomEntry({ title: '&amp;lt;' })))[0].title, '&lt;');
});

test('rejects a one megabyte text field', () => {
  assert.throws(
    () => parseFeed(atomFeed(atomEntry({ title: 'x'.repeat(1024 * 1024) }))),
    /title.*maxFieldLength/i,
  );
});

test('strips control characters from extracted text', () => {
  const entry = parseFeed(atomFeed(atomEntry({ title: 'A\u0001B\u007fC' })))[0];
  assert.equal(entry.title, 'ABC');
});

test('rejects javascript, http, and data links', () => {
  for (const link of ['javascript:alert(1)', 'http://example.com/story', 'data:text/html,unsafe']) {
    assert.throws(() => parseFeed(atomFeed(atomEntry({ link }))), /link.*https/i, link);
  }
});

test('rejects HTTPS links containing URL credentials', () => {
  assert.throws(
    () => parseFeed(atomFeed(atomEntry({ link: 'https://user:pass@example.com/story' }))),
    /credentials/i,
  );
});

test('rejects truncated and mismatched XML', () => {
  assert.throws(() => parseFeed(atomFeed(atomEntry()).slice(0, -7)), /truncated|unclosed|mismatch/i);
  assert.throws(() => parseFeed('<feed><entry></feed>'), /mismatch|unclosed/i);
});

test('rejects an entry missing each required Atom field', () => {
  for (const field of ['id', 'title', 'link', 'updated', 'summary']) {
    assert.throws(
      () => parseFeed(atomFeed(atomEntry({ [field]: null }))),
      new RegExp(`missing required field.*${field}`, 'i'),
      field,
    );
  }
});

test('enforces response byte and entry-count limits', () => {
  const oneEntry = atomFeed(atomEntry());
  assert.throws(() => parseFeed(oneEntry, { maxBytes: 8 }), /maxBytes/i);
  assert.throws(() => parseFeed(atomFeed(atomEntry() + atomEntry()), { maxEntries: 1 }), /maxEntries/i);
  const overDefaultEntryLimit = atomFeed(Array.from({ length: 101 }, () => atomEntry()).join(''));
  assert.throws(() => parseFeed(overDefaultEntryLimit), /maxEntries/i);
});

test('rejects unknown entities and invalid numeric character references', () => {
  assert.throws(() => parseFeed(atomFeed(atomEntry({ title: '&custom;' }))), /entity/i);
  assert.throws(() => parseFeed(atomFeed(atomEntry({ title: '&#0;' }))), /character reference/i);
  assert.throws(() => parseFeed(atomFeed(`<title>&custom;</title>${atomEntry()}`)), /entity/i);
});

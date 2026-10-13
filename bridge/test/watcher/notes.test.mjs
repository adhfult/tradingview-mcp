import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotes, parseNoteTime, symbolMatches, MAX_NOTE_FILES, MAX_NOTE_BYTES, EXCERPT_CHARS, CACHE_MS } from '../../lib/notes.mjs';
import { createFakeClock } from './support.mjs';

const BTC = 'BINANCE:BTCUSDT';
const note = (front, body = '# A title\nSome body text.\n') => `---\n${front}\n---\n${body}`;
const logger = () => {
  const logs = [];
  return { logs, info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) };
};

/** A temp folder holding `files` (name -> text), and a notes layer reading it. */
async function setup(t, files = {}, over = {}) {
  const root = await mkdtemp(join(tmpdir(), 'notes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'markets');
  await mkdir(dir);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  const clock = createFakeClock();
  const log = logger();
  const notes = createNotes({ dir, vault: 'ObsidianVault', vaultFolder: 'markets', clock, logger: log, ...over });
  return { root, dir, clock, log, notes };
}

// ---------------------------------------------------------------- time

test('parseNoteTime: ISO with Z or an offset, a date alone (end of that UTC day), no zone (UTC), garbage (null)', () => {
  const at = (iso) => Date.parse(iso) / 1000;
  assert.equal(parseNoteTime('2026-10-12T14:30:00Z'), at('2026-10-12T14:30:00Z'));
  assert.equal(parseNoteTime('2026-10-12T16:30:00+02:00'), at('2026-10-12T14:30:00Z'));
  assert.equal(parseNoteTime('2026-10-12T09:30:00-05:00'), at('2026-10-12T14:30:00Z'));
  assert.equal(parseNoteTime('2026-10-12T14:30:00.987Z'), at('2026-10-12T14:30:00Z'), 'fractions are dropped');
  assert.equal(parseNoteTime('2026-10-12'), at('2026-10-12T23:59:59Z'));
  assert.equal(parseNoteTime('2026-10-12T14:30'), at('2026-10-12T14:30:00Z'), 'Obsidian writes datetimes with no zone');
  assert.equal(parseNoteTime('2026-10-12T14:30:00'), at('2026-10-12T14:30:00Z'));
  for (const bad of ['', 'tomorrow', '2026-13-01', '2026-02-30', '2026-10-12T25:00:00Z', '2026-10-12T14:61:00Z', '12/10/2026', '2026-10-12 14:30', '20261012', undefined, null, 5, ['2026-10-12'], {}]) {
    assert.equal(parseNoteTime(bad), null, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- symbol matching

test('symbolMatches: the full symbol or its ticker part, case-insensitive, never a fragment', () => {
  assert.equal(symbolMatches([BTC], BTC), true);
  assert.equal(symbolMatches(['binance:btcusdt'], BTC), true);
  assert.equal(symbolMatches(['BTCUSDT'], BTC), true);
  assert.equal(symbolMatches(['btcusdt'], BTC), true);
  assert.equal(symbolMatches(['ETHUSDT', 'btcusdt'], BTC), true, 'any entry may match');
  assert.equal(symbolMatches(['NVDA'], 'NASDAQ:NVDA'), true);
  assert.equal(symbolMatches(['NYSE:NVDA'], 'NASDAQ:NVDA'), false, 'a named exchange must be the right one');
  assert.equal(symbolMatches(['BTC'], BTC), false);
  assert.equal(symbolMatches(['USDT'], BTC), false);
  assert.equal(symbolMatches(['BINANCE'], BTC), false);
  assert.equal(symbolMatches([], BTC), false);
  assert.equal(symbolMatches([''], BTC), false);
  assert.equal(symbolMatches(['BTCUSDT'], 'NOEXCHANGE'), false);
  assert.equal(symbolMatches(['NOEXCHANGE'], 'NOEXCHANGE'), true, 'a symbol with no exchange part matches whole');
});

// ---------------------------------------------------------------- what a note becomes

test('a note becomes {title, kind, time, symbols, excerpt, open}, nothing else', async (t) => {
  const { notes } = await setup(t, {
    'btc news.md': note(`symbols: [${BTC}]\ntime: 2026-10-12T14:30:00Z\nkind: news`, '# ETF decision\nThe regulator approved it.\n'),
  });
  const list = await notes.list(BTC);
  assert.deepEqual(list, [{
    title: 'ETF decision',
    kind: 'news',
    time: Date.parse('2026-10-12T14:30:00Z') / 1000,
    symbols: [BTC],
    excerpt: 'The regulator approved it.',
    open: 'obsidian://open?vault=ObsidianVault&file=markets%2Fbtc%20news',
  }]);
  assert.equal(notes.vault, 'ObsidianVault');
  assert.equal(notes.folder, 'markets');
});

test('kind: news, opportunity and risk keep their name (any case); anything else, or none, is "note"', async (t) => {
  const kinds = { a: 'News', b: 'opportunity', c: 'RISK', d: 'rumour', e: '' };
  const files = Object.fromEntries(Object.entries(kinds).map(([name, kind]) => [`${name}.md`, note(`symbols: [BTCUSDT]\nkind: ${kind}`)]));
  files['f.md'] = note('symbols: [BTCUSDT]');
  const { notes } = await setup(t, files);
  const byName = Object.fromEntries((await notes.list(BTC)).map((n) => [n.open.split('%2F')[1], n.kind]));
  assert.deepEqual(byName, { a: 'news', b: 'opportunity', c: 'risk', d: 'note', e: 'note', f: 'note' });
});

test('the title is the first "# " heading (markdown stripped), else the file name; "## " is not a title', async (t) => {
  const { notes } = await setup(t, {
    'heading.md': note('symbols: [BTCUSDT]', 'intro\n\n## Sub\n# Real **bold** [[Page|title]]\n# Second'),
    'no heading.md': note('symbols: [BTCUSDT]', '## Only a sub heading\ntext'),
    'html.md': note('symbols: [BTCUSDT]', '# <img src=x onerror=alert(1)>\n'),
  });
  const titles = Object.fromEntries((await notes.list(BTC)).map((n) => [decodeURIComponent(n.open.split('%2F')[1]), n.title]));
  assert.equal(titles.heading, 'Real bold title');
  assert.equal(titles['no heading'], 'no heading');
  assert.equal(titles.html, '<img src=x onerror=alert(1)>', 'sent as data; the page shows it with textContent');
});

test('the excerpt drops frontmatter, the title line and markdown punctuation, and stops at 280 characters', async (t) => {
  const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
  const { notes } = await setup(t, {
    'md.md': note('symbols: [BTCUSDT]\nkind: news', '# Heading\n\nSome *bold* and `code` text with a [link](http://x.y/z) and [[Wiki Page|alias]] and ![[img.png]].\n> quoted\n- item one\n1. item two\n'),
    'long.md': note('symbols: [ETHUSDT]', `# T\n${long}`),
  });
  const [md] = await notes.list(BTC);
  assert.equal(md.excerpt, 'Some bold and code text with a link and alias and . quoted item one item two');
  for (const bad of ['---', 'symbols', 'Heading', '*', '`', '[', ']', '](', '#', '>']) assert.ok(!md.excerpt.includes(bad), `excerpt has ${bad}`);
  const [big] = await notes.list('BINANCE:ETHUSDT');
  assert.equal(EXCERPT_CHARS, 280);
  assert.ok(big.excerpt.length <= 280);
  assert.ok(big.excerpt.endsWith('…'), 'a cut excerpt ends with an ellipsis');
  assert.ok(big.excerpt.startsWith('word0 word1 '));
});

test('the "open" link encodes a vault name with spaces and & = # in the file name', async (t) => {
  const { notes } = await setup(t, { 'A & B = C #1.md': note('symbols: [BTCUSDT]') }, { vault: 'My Vault & Co=1#2', vaultFolder: 'my markets' });
  const [n] = await notes.list(BTC);
  assert.equal(n.open, 'obsidian://open?vault=My%20Vault%20%26%20Co%3D1%232&file=my%20markets%2FA%20%26%20B%20%3D%20C%20%231');
  const params = new URLSearchParams(n.open.slice(n.open.indexOf('?') + 1));
  assert.equal(params.get('vault'), 'My Vault & Co=1#2');
  assert.equal(params.get('file'), 'my markets/A & B = C #1');
});

// ---------------------------------------------------------------- which notes are served

test('only notes with symbols are served, and only for a matching stream', async (t) => {
  const { notes } = await setup(t, {
    'btc.md': note('symbols: [BINANCE:BTCUSDT]'),
    'short.md': note('symbols: [btcusdt]'),
    'scalar.md': note('symbols: BTCUSDT'),
    'block.md': note('symbols:\n  - ETHUSDT\n  - BTCUSDT'),
    'eth.md': note('symbols: [BINANCE:ETHUSDT]'),
    'nvda.md': note('symbols: [NVDA]'),
    'essay.md': note('kind: news', '# My essay\nNot about any market.'),
    'resume.md': '# My resume\nno frontmatter at all',
    'empty-symbols.md': note('symbols: []'),
    'other-exchange.md': note('symbols: [KRAKEN:BTCUSDT]'),
  });
  const names = async (symbol) => (await notes.list(symbol)).map((n) => decodeURIComponent(n.open.split('%2F')[1])).sort();
  assert.deepEqual(await names(BTC), ['block', 'btc', 'scalar', 'short']);
  assert.deepEqual(await names('BINANCE:ETHUSDT'), ['block', 'eth']);
  assert.deepEqual(await names('NASDAQ:NVDA'), ['nvda']);
  assert.deepEqual(await names('KRAKEN:BTCUSDT'), ['block', 'other-exchange', 'scalar', 'short'], 'a bare ticker matches on any exchange, a named exchange only its own');
  assert.deepEqual(await names('NASDAQ:AAPL'), []);
});

test('malformed frontmatter, invalid UTF-8 and a non-markdown file are skipped, not served wrongly', async (t) => {
  const { notes, dir } = await setup(t, {
    'good.md': note('symbols: [BTCUSDT]'),
    'unclosed.md': '---\nsymbols: [BTCUSDT]\n# no closing line\n',
    'bad-line.md': note('symbols: [BTCUSDT]\nthis is not a pair'),
    'notes.txt': note('symbols: [BTCUSDT]'),
    'note.md.bak': note('symbols: [BTCUSDT]'),
    'md': note('symbols: [BTCUSDT]'),
    '.hidden.md': note('symbols: [BTCUSDT]'),
  });
  await writeFile(join(dir, 'binary.md'), Buffer.concat([Buffer.from('---\nsymbols: [BTCUSDT]\n---\n# T\n'), Buffer.from([0xff, 0xfe, 0xfd])]));
  assert.deepEqual((await notes.list(BTC)).map((n) => n.open), ['obsidian://open?vault=ObsidianVault&file=markets%2Fgood']);
});

test('a time that cannot be read leaves the note in the panel with time null', async (t) => {
  const { notes } = await setup(t, { 'a.md': note('symbols: [BTCUSDT]\ntime: soon'), 'b.md': note('symbols: [BTCUSDT]') });
  assert.deepEqual((await notes.list(BTC)).map((n) => n.time), [null, null]);
});

test('newest first: by time, else by the file\'s modified time', async (t) => {
  const { notes, dir } = await setup(t, {
    'old.md': note('symbols: [BTCUSDT]\ntime: 2026-01-01T00:00:00Z'),
    'new.md': note('symbols: [BTCUSDT]\ntime: 2026-06-01T00:00:00Z'),
    'untimed-recent.md': note('symbols: [BTCUSDT]'),
    'untimed-ancient.md': note('symbols: [BTCUSDT]'),
  });
  await utimes(join(dir, 'untimed-recent.md'), new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));
  await utimes(join(dir, 'untimed-ancient.md'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  const order = (await notes.list(BTC)).map((n) => decodeURIComponent(n.open.split('%2F')[1]));
  assert.deepEqual(order, ['untimed-recent', 'new', 'old', 'untimed-ancient']);
});

// ---------------------------------------------------------------- caps and unsafe files

test('a symlink to a note, a symlinked folder, a directory called x.md and a FIFO are never read', async (t) => {
  const { notes, dir, root } = await setup(t, { 'real.md': note('symbols: [BTCUSDT]') });
  await writeFile(join(root, 'outside.md'), note('symbols: [BTCUSDT]', '# Outside the folder'));
  await symlink(join(root, 'outside.md'), join(dir, 'link.md'));
  await mkdir(join(root, 'elsewhere'));
  await writeFile(join(root, 'elsewhere', 'inner.md'), note('symbols: [BTCUSDT]'));
  await symlink(join(root, 'elsewhere'), join(dir, 'folder-link.md'));
  await mkdir(join(dir, 'dir.md'));
  await writeFile(join(dir, 'dir.md', 'inner.md'), note('symbols: [BTCUSDT]'));
  execFileSync('mkfifo', [join(dir, 'fifo.md')]);
  assert.deepEqual((await notes.list(BTC)).map((n) => n.open), ['obsidian://open?vault=ObsidianVault&file=markets%2Freal']);
});

test('subfolders are not scanned (the folder is flat on purpose)', async (t) => {
  const { notes, dir } = await setup(t, { 'top.md': note('symbols: [BTCUSDT]') });
  await mkdir(join(dir, 'archive'));
  await writeFile(join(dir, 'archive', 'deep.md'), note('symbols: [BTCUSDT]'));
  assert.equal((await notes.list(BTC)).length, 1);
});

test('at most 500 files are read: the newest ones', async (t) => {
  const { notes, dir } = await setup(t);
  assert.equal(MAX_NOTE_FILES, 500);
  const base = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < 502; i += 1) {
    const name = `n${String(i).padStart(3, '0')}.md`;
    await writeFile(join(dir, name), note('symbols: [BTCUSDT]'));
    await utimes(join(dir, name), new Date(base + i * 1000), new Date(base + i * 1000));
  }
  const list = await notes.list(BTC);
  assert.equal(list.length, 500);
  const files = list.map((n) => n.open);
  assert.ok(!files.some((f) => f.endsWith('%2Fn000') || f.endsWith('%2Fn001')), 'the two oldest are the ones dropped');
  assert.ok(files.some((f) => f.endsWith('%2Fn501')));
});

test('only the first 16 KB of a note is read', async (t) => {
  assert.equal(MAX_NOTE_BYTES, 16 * 1024);
  const { notes } = await setup(t, {
    'late-heading.md': note('symbols: [BTCUSDT]', `${'filler line\n'.repeat(3000)}# Heading far below\n`),
    'early-heading.md': note('symbols: [BTCUSDT]', `# Early\n${'filler line\n'.repeat(3000)}`),
  });
  const titles = (await notes.list(BTC)).map((n) => n.title).sort();
  assert.deepEqual(titles, ['Early', 'late-heading']);
});

test('a multi-byte character cut by the 16 KB limit does not make the note look like invalid UTF-8', async (t) => {
  const front = '---\nsymbols: [BTCUSDT]\n---\n';
  assert.equal(Buffer.byteLength(front) % 2, 1, 'the 2-byte letters then straddle byte 16384');
  const { notes } = await setup(t, { 'accents.md': `${front}# Café\n${'é'.repeat(20_000)}` });
  const [n] = await notes.list(BTC);
  assert.equal(n?.title, 'Café');
});

// ---------------------------------------------------------------- cost: lazy and cached

test('nothing is read until a browser asks, and the scan is cached for 30 seconds', async (t) => {
  const { notes, dir, clock } = await setup(t, { 'first.md': note('symbols: [BTCUSDT]') });
  assert.equal(CACHE_MS, 30_000);
  assert.equal((await notes.list(BTC)).length, 1);
  await writeFile(join(dir, 'second.md'), note('symbols: [BTCUSDT]'));
  clock.advance(CACHE_MS - 1);
  assert.equal((await notes.list(BTC)).length, 1, 'still the cached scan');
  clock.advance(1);
  assert.equal((await notes.list(BTC)).length, 2, 'rescanned');
});

test('concurrent requests share one scan', async (t) => {
  // A missing folder logs once per scan, so three requests at the same moment must log exactly once.
  const log = logger();
  const notes = createNotes({ dir: '/nonexistent/notes-folder', vault: 'V', vaultFolder: 'm', clock: createFakeClock(), logger: log });
  await Promise.all([notes.list(BTC), notes.list(BTC), notes.list(BTC)]);
  assert.equal(log.logs.filter((l) => l.startsWith('warn')).length, 1);
});

test('creating the layer touches nothing: a missing folder is only logged when a browser asks, once per scan window, and found later', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'notes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'later');
  const clock = createFakeClock();
  const log = logger();
  const notes = createNotes({ dir, vault: 'V', vaultFolder: 'markets', clock, logger: log });
  assert.deepEqual(log.logs, []);
  assert.deepEqual(await notes.list(BTC), []);
  assert.deepEqual(await notes.list(BTC), [], 'cached');
  assert.equal(log.logs.filter((l) => l.startsWith('warn')).length, 1);
  assert.ok(log.logs[0].includes(dir));
  clock.advance(CACHE_MS);
  assert.deepEqual(await notes.list(BTC), []);
  assert.equal(log.logs.filter((l) => l.startsWith('warn')).length, 1, 'logged once, not on every scan');
  await mkdir(dir);
  await writeFile(join(dir, 'x.md'), note('symbols: [BTCUSDT]'));
  clock.advance(CACHE_MS);
  assert.equal((await notes.list(BTC)).length, 1, 'creating the folder later just works');
});

test('a folder that is a file, or unreadable, gives an empty list and no crash', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'notes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'afile'), 'x');
  const notes = createNotes({ dir: join(root, 'afile'), vault: 'V', vaultFolder: 'm', clock: createFakeClock(), logger: logger() });
  assert.deepEqual(await notes.list(BTC), []);
});

test('a title is cut at 200 characters, symbols at 20 entries of at most 64 characters', async (t) => {
  const many = Array.from({ length: 40 }, (_, i) => `SYM${i}`).concat(['x'.repeat(500)]);
  const { notes } = await setup(t, {
    'long-title.md': note('symbols: [BTCUSDT]', `# ${'T'.repeat(15_000)}\nbody`),
    'many.md': note(`symbols: [BTCUSDT, ${many.join(', ')}]`),
  });
  const list = await notes.list(BTC);
  const longTitle = list.find((n) => n.title.startsWith('TTT'));
  assert.ok(longTitle.title.length <= 200 && longTitle.title.endsWith('…'));
  const manySymbols = list.find((n) => n.symbols.includes('SYM0'));
  assert.equal(manySymbols.symbols.length, 20);
  assert.ok(manySymbols.symbols.every((s) => s.length <= 64));
});

test('hostile lines of brackets, underscores and spaces are processed in bounded time', async (t) => {
  const lines = ['['.repeat(16_000), '[['.repeat(8000), '!['.repeat(8000), ' _'.repeat(8000), ' '.repeat(16_000)];
  const { notes, clock, dir } = await setup(t);
  for (const line of lines) {
    await writeFile(join(dir, 'x.md'), note('symbols: [BTCUSDT]', `# T\n${line}`));
    clock.advance(CACHE_MS);
    const start = Date.now();
    await notes.list(BTC);
    assert.ok(Date.now() - start < 100, `${line.slice(0, 6)}... took ${Date.now() - start} ms`);
  }
});

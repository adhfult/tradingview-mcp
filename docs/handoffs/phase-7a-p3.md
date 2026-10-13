# Phase 7a, P3: Obsidian notes layer

Branch `claude/lucid-bardeen-3ou62p`, not pushed (you said not to). Design: `phase-7a-design.md` section 8. Regime 4, Sonnet 5.5 High, one session; no delegate (see "Decisions").

## What now exists

- `bridge/lib/frontmatter.mjs`: a subset parser for Obsidian properties (`key: value`, inline and block lists, quotes, comments, CRLF, BOM). Anything it cannot read returns `null` and the note is skipped.
- `bridge/lib/notes.mjs`: `createNotes({dir, vault, vaultFolder, clock, logger})` with `list(symbol)`. Flat folder, `.md` only, `lstat` skips symlinks, newest 500 files, first 16 KB of each, excerpt of 280 characters, 30 s cache shared by concurrent requests, scanned only when a browser asks. A note is served only if it has `symbols` that match the stream (whole symbol or ticker part, case-insensitive).
- `GET /api/notes?symbol=&tf=` in the `api` Map of `dashboard.mjs`, so it inherits auth, the Host check and the four headers. Unknown stream or missing parameter: the same 404 as `/api/candles`. Notes off: `200 {enabled:false, vault:null, folder:null, notes:[]}`.
- `dashboard.notes` config block (`enabled`, `dir`, `vault`, `vault_folder`), off by default; `~` in `dir` is expanded; `vault_folder` is trimmed of slashes and may not contain `..` or a backslash. The example config carries the block with `enabled: false`. Wiring in `watcher.mjs`.
- Page: Notes panel (kind badge, link, time, excerpt; loading, off, empty and error states), blue circle markers (letter = kind) merged into `buildMarkers`, "Add note here" after a click on a candle, deep link `?symbol=&tf=&t=` centring the chart once, notes re-read every 60 s.
- README: "Obsidian notes on the chart" under Dashboard, with the Pi-sync options.

## Gates

`timeout 200 npm test --prefix bridge`: **587 tests, 587 pass** (531 before, 56 new). `--check-config` prints `OK`.

Browser check (Playwright, fake data server calling the real `createDashboard` and `createNotes`, scratch script not committed): console clean of CSP errors (the only message is the open `/events` stream being cut by navigating away); markers N, O, R, N at the right candles; a note with no `time` only in the panel; the symlinked note, the note without `symbols` and the NVDA note never shown for BTC; a title of `<img src=x onerror=alert(1)> <script>...` shown as text (zero injected elements); "Add note here" link is `obsidian://new` with an encoded vault, file and content; notes off shows a clear message and hides the add-note controls; 360 px wide has no horizontal scroll. Screenshots in `.playwright-mcp/` (now git-ignored).

Mutation check (commit first, each mutant `node --check`ed, failing test names read): 32 mutants listed, 27 killed, 4 survived, 1 skipped (its pattern did not match). The survivors are all explained:
- `lstat().isFile()` removed alone, or `O_NOFOLLOW` removed alone: the other layer still refuses a symlink (`readHead` also checks `fstat`). With both removed the symlink test fails, so each layer is independently enough.
- `symbols.length === 0` check removed: redundant, an empty list never matches a symbol.
- Request symbol passed instead of the stream's own symbol: identical for any stream that exists (equivalent mutant).

## Decisions worth knowing

1. **I wrote `frontmatter.mjs` myself.** Writing the brief, running `inv.sh` and reading the diff would have cost more than the 120-line parser, and the handoff allowed it. Tests were committed first (16 cases).
2. **The "Add note" file name has no `:`.** Obsidian forbids `: * ? " < > | \ /` in file names, so the design's `markets/<SYMBOL> <tf> <date time>` becomes `markets/BINANCE-BTCUSDT 1h 2026-10-12 1430`. The frontmatter inside keeps the real `BINANCE:BTCUSDT`. A test reads the generated content back through the notes layer.
3. **Times:** a date alone is the end of that UTC day (23:59:59), a datetime with no zone is UTC (Obsidian writes them that way), an unreadable `time` leaves the note in the panel with `time: null`.
4. **The folder is flat** (no subfolders). `ponytail:` comment in `notes.mjs`; add a recursive walk if a vault needs it.
5. **`readHead` in `notes.mjs` repeats the open flags of `readSmallFile`** in `dashboard.mjs` (about 10 lines) instead of sharing them: `readSmallFile` rejects files over 1 MB, a note needs the first 16 KB of a bigger file. A cut in the middle of a multi-byte character is not an error (`TextDecoder` with `stream: true`; a test pins it).
6. **Sorting:** newest first by `time`, else by the file's modified time. The cap keeps the newest 500 files by modified time.
7. **A notes failure never blanks the chart:** `/api/notes` is fetched with its own `.catch` inside the load, and the panel shows the error.
8. **`formatTimeframe('D')` returns `D`**, although its comment says `1D` (P2, unchanged). The file name uses it, so daily notes are named `... D ...`.

## Not done / for later

- Getting the vault to the Pi (documented, not built: Syncthing send-only or a `git pull` timer).
- Subfolders; clicking a marker to open its note; pushing new notes live (the page re-reads every 60 s and the server caches 30 s).
- A deep link whose `t` is before the 300 loaded candles shows a status line instead of loading more history.
- P4 extra panels, 7b image alerts, `STATUS.md` (integrator only).

## Review (regime 11)

Two read-only reviewers, each given the design section and a saved diff file (not the transcript): a **Fable** subagent and **Codex Sol** (`gpt-6.1-sol`, high) through `inv.sh`. Every finding was checked against the code or reproduced before it was fixed. Both reviewers found nothing in path handling beyond the one race below, `obsidian://` encoding and scheme enforcement, DOM text insertion, auth, Host checks or headers.

Fixed (tests committed failing first, `4cf75dd`):
- **Quadratic regexes (both reviewers, measured).** One hostile 16 KB line cost about 400 ms; 500 such files would have frozen the watcher (alerts, websocket) for about 200 s per scan. Lines are now cut at 1024 characters before markdown stripping, and the frontmatter key and comment regexes became linear scans. Tests time hostile inputs.
- **Uncapped `title` and `symbols`** (both): title cut at 200 characters; symbols at most 20 entries of at most 64 characters.
- **Parser mistakes (Codex):** a list nested under another mapping became the key's list; `"\BTCUSDT"` parsed as a symbol and `"\u0042"` as `u0042` (now real YAML escapes, unknown ones make the note unreadable); a `#` inside a quoted list item cut the list (`["Desk #1"]` dropped a valid note).
- **Config (both):** a NUL or control character in `dir` passed validation; `vault_folder` of `.`, `./x` or `a//b` was accepted.
- **Page:** stale "Add note here" link after switching streams (it would have made a note for the old stream); deep-link centring consumed before any candles existed; the 60 s reload did not restore the add-note hint after an earlier failure and dropped keyboard focus on a rebuilt note list; the picked candle was lost on every SSE reconnect; "No candles yet" stayed after candles arrived.
- **Keyboard access (Fable):** the only way to pick a candle was a mouse click. A "Use newest candle" button now gives a keyboard path (arbitrary candles still need a click or the `t` link).
- **Plain notes looked like news (Fable):** both showed `N`; a plain note now shows "•".
- **Obsidian file names (Fable):** `#`, `^`, `[` and `]` are also replaced in the "Add note" file name.
- **Tests that proved less than they claimed:** the href test checked proximity, not enforcement (now `setObsidianLink` is exported and tested with a stub element); the "concurrent requests share one scan" test depended on thread timing (now counts the once-per-scan warning).

Not fixed, on purpose:
- **Directory swapped for a symlink between `lstat` and `open` (Codex).** `O_NOFOLLOW` covers only the last path component. Exploiting it needs someone who can already replace the notes folder or its parent, which is write access to your vault. A fix would need `realpath` per scan or `openat`, which Node lacks. Documented here.
- Fable's note that `encodeURIComponent` throws on a lone surrogate in a vault name: contrived, the note is skipped with a warning.
- Double-quote and block-scalar YAML features beyond the subset (`|`, `>`, anchors) are unsupported by design.

After the fixes: **594 tests, 594 pass** (`timeout 200 npm test --prefix bridge`; note that plain `npm test` inside `bridge/` hung once for me, the `--prefix` form from the repo root is the one that works), `--check-config` prints `OK`, and a second browser run confirmed the keyboard button, the add-note link hiding on a stream switch and a clean console.

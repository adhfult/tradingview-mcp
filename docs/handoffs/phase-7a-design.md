# Phase 7a design: local dashboard + Obsidian notes layer + extra panels (approved 2026-10-12)

**Approvals (2026-10-12, user):** (1) design approved as written, including the section 12 defaults (dashboard `enabled` true, gauntlet gates without `reason`, hostname Host check, 16-char non-loopback token minimum, 5 SSE clients); (2) the `lightweight-charts@5.2.1` install in step 0 is OK; (3) panels: recommended set (B1-B5, B7-B10, B11 if cheap, B6 last and separate); (4) design doc committed as `docs(dashboard): 7a design`; STATUS gets four sub-rows (P1 core, P2 UI, P3 notes, P4 extras), applied by the integrator at the end of each piece. The notes convention (read-only plus `obsidian://new`) and the `DESIGN.md`-first UI step stand as written (covered by "approve as written").

Source brief: `docs/handoffs/phase-7.md`, section 7a. This file answers the open questions in `HANDOFF.md`, lists where I deviate from or add to the brief, adds an Obsidian notes layer (revision 2, section 8), and extra panels, UI standards and a four-piece split with regimes (revision 3, sections 9-12).

## 0. The picture

```
 TradingView ──ws──> stream.mjs ──snapshot (300 candles)──┐
                       │  keeps latest snapshot per stream │
                       │  onClosedBar ──> rules.mjs ──hit──┼──> alerts.submit ──> state.alerts (+ meta)
                       │  onBar (changed last candle)      │            │ onRecord
                       v                                   v            v
                    ┌──────────────── bus (EventEmitter) ───────────────────┐
                    │  'bar'   'alert'   'health'                           │
                    └───────────────────────┬───────────────────────────────┘
                                            v
 browser <──HTTP/SSE── dashboard.mjs (node:http, :8788, GET only, auth + headers in ONE place)
                         ├─ static allowlist (index.html, app.mjs, style.css, lightweight-charts.mjs)
                         ├─ /api/streams /candles /alerts /levels   (memory only)
                         ├─ /api/paper /gauntlet   (read $TRADINGVIEW_MCP_HOME, whitelisted fields)
                         ├─ /api/notes             (read the Obsidian folder, excerpts only)   <- section 8
                         └─ /events                (SSE: bar, alert, health)
```

Everything the dashboard shows comes from memory or from reading files. It never calls TradingView, never writes anywhere, and never sends anything. That is what "read-only" means in this design, and it is also why a bug in the dashboard cannot place a trade or lose an alert.

## 1. One candle, end to end (why the parts are shaped this way)
1. TradingView pushes a snapshot of the last 300 candles for `BINANCE:BTCUSDT 60`. `stream.mjs:handleData` receives it.
2. **New:** the stream stores that array as `s.candles` (a reference, no copy) and, if the last candle's values changed, calls `onBar(stream, lastCandle)`. The watcher turns that into `bus.emit('bar', ...)`.
3. If a bar just closed, the existing path runs: `onClosedBar` -> `evaluateRules` -> hits -> `alerts.submit`.
4. `alerts.submit` decides sent / held / digested / duplicate / cooldown / capped. For accepted alerts it pushes an entry to `state.alerts`. **New:** the entry now also carries `meta` (`ruleId, symbol, timeframe, barTime, direction, message, values`), and `onRecord(entry)` fires -> `bus.emit('alert', ...)`.
5. `dashboard.mjs` receives the bus events and writes them to each connected browser as server-sent events. A bar event is coalesced to at most one per stream per second.
6. The browser (`app.mjs`) calls `series.update(candle)` for a bar, or adds a marker for an alert. A reload re-reads `/api/candles` and `/api/alerts`, so no state lives only in the page.

Why the alert history needed `meta`: the dedupe key already encodes the symbol, timeframe, rule, direction and bar time, but parsing a key back into fields is fragile (a symbol or rule id containing the separator breaks it silently). Storing the fields once, at the moment we know them, costs a few hundred bytes per alert (500 alerts max) and removes the guesswork.

## 2. Findings that shape the design
1. **`state.alerts` is too thin.** `alerts.submit` stores `{at, kind, level, title, key, status}` only (`bridge/lib/alerts.mjs:123`). The brief's `/api/alerts` fields and the chart markers need more, and nothing records them today.
2. **`stream.mjs` keeps no candles.** `handleData` sees the snapshot and forgets it. `list()` has no `lastBarTime` either (it exists on the internal object).
3. **Nothing emits events.** Confirmed, as the handoff said.
4. `WATCHER_DASHBOARD_TOKEN` is already in `SECRET_ENV_VARS` (`redact.mjs`), so the redactor covers it.
5. `localapi.mjs` has the constant-time compare (SHA-256 both sides, `timingSafeEqual`) wrapped in a Bearer parser. I export the bare compare and reuse it.
6. The Obsidian vault is `/mnt/c/Users/fulto/Documents/ObsidianVault` (the same folder as `~/notes`). It has no frontmatter and no wikilinks yet, and `Monitor of Markets.md` is an empty note whose idea (in `List of Ideas.md`) reads "a monitor of markets ... take note of trends ... research what goes on". Section 8 is built for exactly that.

## 3. The six questions

### 3.1 Events (`/events`)
- `createWatcher` creates one `EventEmitter` (`bus`) and passes it to the dashboard. Only `dashboard.mjs` listens.
- `bar`: `createStreams` gets an optional callback `onBar(stream, lastCandle)`. The dashboard **coalesces** to at most one `bar` per stream per second (a trailing flush, so the final close of a bar is never lost). Reason: TradingView pushes several snapshots a second per stream, and the Pi should not write 25 frames a second per browser.
- `alert`: `createAlerts` gets an optional `onRecord(entry)`, called right after the push to `state.alerts`. It fires only for accepted alerts (not duplicate, cooldown or capped), for every kind. One hook, not one per call site.
- `health`: emitted from `tick()` (every 30 s) with the stream list.
- Tests use the real `EventEmitter` as the "fake emitter" the brief mentions.

### 3.2 Candle data for `/api/candles`
- `createStreams` keeps a reference to the latest snapshot per stream and gets `candles(key)`: a copy, `null` for an unknown key, `[]` before the first snapshot. No extra TradingView call. Memory: at most 25 streams x 300 candles x ~50 bytes, about 400 KB.
- `list()` gains `lastBarTime` (additive; the four existing `list()` tests read single fields).
- The forming (last) bar is included so the chart shows the live candle.

### 3.3 Server placement
Separate `bridge/lib/dashboard.mjs`, same process, own port 8788. `localapi.mjs` has a different trust model (POST, token always required, always loopback). Mixing them would put the "loopback needs no token" branch next to the one that must never have it. Shared code: `tokensEqual`, exported from `localapi.mjs`.

### 3.4 `/api/paper` and `/api/gauntlet`
Real shapes (checked in `gauntlet_service.py` and `paper_service.py`):
- Gauntlet report: `{fingerprint, created_utc, inputs: {strategy, symbol, tv_symbol, interval, ...}, gates: [{gate, status, reason, numbers}], verdict, ...}`. I serve `{fingerprint, created_utc, strategy, symbol, interval, verdict, gates: [{gate, status}]}`. No `reason`/`numbers` (add if you want the "why").
- Paper journal `paper/<fingerprint>.jsonl`: events `{ts, type: start|entry|exit|summary, price, bar_time, return_pct, week, ...}`. I serve `{fingerprint, strategy, symbol, timeframe, events: [last 50 of {ts, type, price, bar_time, return_pct}]}`. Strategy, symbol and interval come from the gauntlet report with the same fingerprint (the journal file is named by it). Interval to timeframe code via a small table (`15m->15, 1h->60, 4h->240, 1d->D`).
- Safety: home is `$TRADINGVIEW_MCP_HOME` (default `~/.tradingview-mcp`). Files come from `readdir` filtered by `^[0-9a-f]{64}\.(json|jsonl)$`, so `log.jsonl` and anything else is ignored; no part of a path comes from the request. Non-regular files and symlinks are skipped (`lstat`), each read is capped at 1 MB, newest 50 files only. Every field is type-checked and whitelisted; damaged lines are skipped (as `read_journal` does). Raw file content is never served.

### 3.5 Security
| Rule | How |
|---|---|
| Loopback = no token; non-loopback needs `WATCHER_DASHBOARD_TOKEN` | `createDashboard` throws if `host` is not `127.0.0.1`/`::1`/`localhost` and the token is empty. The watcher catches it, logs the reason, and runs on without a dashboard (alerts matter more than charts). |
| **new** token minimum length | Refuse a non-loopback token under 16 characters. README: `openssl rand -hex 32`. |
| **new** Host header check on loopback | Without a token, any web page can reach `127.0.0.1:8788` through DNS rebinding (the attacker's domain is pointed at 127.0.0.1 after the page loads, so the browser treats it as same-origin). I require the **hostname** part of `Host` to be `127.0.0.1`, `localhost` or `[::1]`, else 403. The port is deliberately not compared: through `ssh -L 9000:127.0.0.1:8788` the browser sends `Host: localhost:9000`, which a port check would wrongly refuse; a rebinding attacker still fails because their hostname is not on the list. About 5 lines. |
| Auth | Bearer header, or the cookie `tvw_dash`, or `?token=` once (sets `tvw_dash=<token>; HttpOnly; SameSite=Strict; Path=/`, 302 to the same URL **with only the `token` parameter removed**, so deep links like `/?symbol=…&tf=…&t=…&token=…` keep their other parameters). All compares go through `tokensEqual`. A wrong `?token=` gets 401, never a redirect. The URL is never logged. No `Secure` flag, because the intended transports are loopback or an SSH tunnel over plain HTTP, where browsers drop a `Secure` cookie. Known consequence of `SameSite=Strict` (fixed by the brief): a link clicked from another site or app, such as Obsidian, is a cross-site navigation, so the cookie is not sent and the first hit on a token-protected dashboard is a 401 until you open the dashboard directly once. On loopback or through the tunnel (the recommended setup) no token is needed, so Obsidian links just work. |
| Four headers on every response | CSP, nosniff, no-referrer, X-Frame-Options on 200, 302, 401, 403, 404, 405 and 503 alike. One `send()` helper, so no path can forget them. |
| GET only | Anything else is 405. |
| Static allowlist | A fixed `Map` built at start: `/`, `/assets/app.mjs`, `/assets/style.css`, `/assets/lightweight-charts.mjs`. Files read once at startup. No path join from the request. A missing file (for example `npm ci` not run) is logged and answers 404; the watcher is unaffected. |
| Query values | `symbol` and `tf` must match a configured stream (map lookup, not a regex). `limit` clamped to 1..500. |
| **new** SSE limits | At most 5 concurrent `/events` clients (503 after that); a client that cannot keep up (`writableNeedDrain`) is dropped. Heartbeat comment every 20 s. |
| No inline script/style, XSS | The page uses `textContent` only, never `innerHTML` (message text comes from rule config, symbol names and, now, note files). The CSP blocks inline code anyway. |

Threat model in one line each: *another web page in your browser* (DNS rebinding, CSRF): Host check, no CORS headers, GET-only, SameSite cookie. *Someone on your LAN*: loopback bind by default; token plus tunnel advice otherwise. *A corrupt or hostile file in the journal/notes folders*: size caps, symlink skip, type-checked whitelisted fields, `textContent`. *A bug in the dashboard*: it holds no write path to alerts, state or notifiers.

Open risk I cannot settle by reading: whether `lightweight-charts` works under `style-src 'self'`. Setting `element.style.x` from script is allowed under that CSP; a `<style>` tag or `setAttribute('style')` is not. I will check it in a real browser (Playwright MCP) and watch the console for CSP violations. If the library needs `'unsafe-inline'` I stop and ask you, because the brief fixes the CSP.

### 3.6 Dependency
`lightweight-charts` 5.2.1, exact. **I need your OK to run** `cd bridge && npm install --ignore-scripts --save-exact lightweight-charts@5.2.1` (network, edits `package.json` and `package-lock.json`). Then: check the lockfile `resolved` host is `registry.npmjs.org`, and that `dist/lightweight-charts.standalone.production.mjs` exists with the licence text. `--ignore-scripts` stops the package running install-time code.

## 4. Other decisions
- **Config:** `dashboard: {enabled, host, port, notes: {...}}`. `enabled` defaults to **true** as in the brief's example (loopback-only and read-only by default, so safe); say if you want it off by default. Port 1024-65535 and different from `local_api.port` (config error). `host` must be a non-empty string. Unknown keys are rejected like everywhere else in `config.mjs`.
- **Bind failure** (`EADDRINUSE`): log and continue without the dashboard. This differs from `localApi.listen()`, which is fatal.
- **`/api/levels?symbol=`:** `price_cross` rules from the top-level list whose `symbol` equals the request or is unset (an unset symbol applies to every stream), skipping expired rules (`ruleExpired`). Composite members are also top-level rules, so they are covered.
- **`/api/alerts`:** entries recorded before this change have no `meta`; they are returned with those fields `null` and are skipped for markers.
- **Delegation: none.** `index.html` and `style.css` are about 60 lines each. Writing the brief and reviewing a delegate's output costs more than writing them, and one author keeps ids consistent with `app.mjs`.
- **Pi budget:** idle cost is one timer (SSE heartbeat) and one 1 s coalescing flush only while a browser is connected; no browser = no work beyond keeping a 300-candle array reference. Static files are held in memory (about 250 KB, mostly the chart library).

## 5. Failure behaviour (what happens when things go wrong)
| Situation | Result |
|---|---|
| Dashboard port in use | Logged; watcher runs without it. |
| Non-loopback host, no/short token | Logged reason; watcher runs without it. |
| `lightweight-charts` file missing | That asset 404s, page shows a plain message; everything else works. |
| Paper/gauntlet folder missing or empty | `[]`, page shows an empty state. |
| One damaged journal line / report | Skipped; the rest are served. |
| Browser disconnects mid-stream | Listener removed on `close`; no leak. |
| Notes folder missing, unreadable or empty | `/api/notes` returns `enabled: true, notes: []`; panel says where it looks. |

## 6. What each test proves (so you can read them later)
- *Route shapes + 404s*: the contract the frontend relies on.
- *Traversal attempt `/assets/../package.json` -> 404*: the allowlist, not string checks, is the guard.
- *Headers on every status code*: no response path skips the helper.
- *Loopback needs no token / Host check*: the two halves of the loopback rule.
- *Non-loopback refuses to start / 401 / Bearer 200 / `?token=` cookie + redirect + wrong token 401*: the whole auth ladder.
- *SSE gets an event when the bus emits; 6th client gets 503; slow client dropped*. The server sets only `requestTimeout`/`headersTimeout` (for incoming requests); never `server.timeout` or keep-alive logic that would close a quiet `/events` stream between 20 s heartbeats.
- *Content types*: `.mjs` assets are `text/javascript; charset=utf-8`, CSS `text/css`, HTML `text/html`, API `application/json`, events `text/event-stream`. With `X-Content-Type-Options: nosniff` a module script served with the wrong type is refused by the browser, and a node test would not notice, so every asset gets an assertion.
- *`?token=` redirect keeps the other query parameters and drops only `token`*.
- *Journal/gauntlet hostile files: symlink, oversize, garbage, 64-hex filename rule*.
- *HTML has the TradingView attribution link and no inline script/style; all four assets are in the allowlist*: the licence and CSP guarantees stay true after future edits.
- *Mutation check (after commit)*: I break each security line on purpose and confirm a test fails.

## 7. Step list (tests first, committed failing, then code)
0. After approval: install the dependency; check lockfile host and licence. Proof: `grep resolved`; the file exists.
1. `alerts.mjs`: `meta` stored plus `onRecord`. Proof: new cases in `alerts.test.mjs`.
2. `stream.mjs`: `candles(key)`, `lastBarTime` in `list()`, `onBar`. Proof: `stream.test.mjs`.
3. `config.mjs`: `dashboard` block; update `watcher.config.example.json`. Proof: `config.test.mjs` and `--check-config` prints `OK`.
4. `localapi.mjs`: export `tokensEqual`. Proof: `localapi.test.mjs` still passes.
5. `dashboard.mjs` + `dashboard.test.mjs`. Proof: that test file.
6. `watcher.mjs` wiring (bus, start/stop, refusal and bind-failure logging). Proof: new cases in `watcher.test.mjs`.
7. `index.html`, `style.css`, `app.mjs`. Proof: the HTML/allowlist test, then a Playwright browser check against a fake data server (console clean of CSP errors, markers visible, screenshot).
8. README "Dashboard" section (Pi + SSH tunnel; tunnel recommended over a non-loopback bind).
9. Full gates (`timeout 100 npm test --prefix bridge`, `--check-config`), commit.
10. **Notes layer** (section 8): `notes.mjs` + tests, `/api/notes`, panel, markers, deep link, "add note" button. Proof: `notes.test.mjs` + the browser check. Separate commit, so it can be dropped or deferred without touching the core.
11. Mutation check (commit first), then the regime-11 review (Fable subagent + Luna Max, read-only, given the brief and a saved diff), verify each finding, `docs/handoffs/phase-7a.md`, STATUS row, `regime_log.py`, one segmem note.

Steps 0-6 are piece P1, step 7-9 are P2, step 10 is P3, and the extras in section 9 are P4; section 11 says which session and regime runs each. Step 11 (mutation check, review, report, STATUS, log, note) is repeated at the end of every piece.

## 8. Obsidian notes layer (new): news and opportunities on the chart

**What you get.** Notes you keep in Obsidian about a market (news, an opportunity, a risk, a trend thought) show up on that market's chart as small markers at the candle they relate to, and in a "Notes" side panel. Clicking one opens it in Obsidian. A button on the chart opens a new, pre-filled note in Obsidian for the candle you clicked. This is the "Monitor of Markets" idea in `List of Ideas.md`, wired to the watcher.

**Direction: Obsidian -> dashboard is read-only; the other direction is a link, not a write.** The watcher never writes into your vault (it lives on Windows, the watcher on a Pi, and a headless process editing a synced vault is a recipe for sync conflicts). Instead the page builds an `obsidian://new` link and Obsidian creates the note when *you* click. Confirmed in the Obsidian URI docs: `obsidian://open?vault=<name>&file=<vault path>` and `obsidian://new?vault=<name>&file=<vault path>&content=<text>`, values URL-encoded.

**Convention: Obsidian properties (frontmatter), because it is what Obsidian itself edits and what Dataview can query.**
```
---
symbols: [BINANCE:BTCUSDT]      # or the block form Obsidian's UI writes:  symbols:\n  - BTCUSDT
time: 2026-10-12T14:30:00Z      # optional; a date alone (2026-10-12) means "that day"
kind: news                      # news | opportunity | risk   (anything else shows as "note")
---
# Title is the first "# heading", else the file name
Body text...
```
- A note appears **only if** it is inside the configured folder **and** has `symbols`. So essays, resumes and everything else in the vault can never be served, even by accident. (The folder is the opt-in; I do not scan the whole vault.)
- `symbols` match a stream's symbol exactly (`BINANCE:BTCUSDT`) or its ticker part (`BTCUSDT`, `NVDA`), case-insensitive.
- Marker placement: the last bar whose open time is at or before `time` (a date alone = end of that UTC day, so on a daily chart it lands on that day's bar). No `time`: panel only. Marker colour/shape by `kind`; text is the first letter.
- Frontmatter is parsed by a small subset parser (`key: value`, `key: [a, b]`, block lists, quotes, CRLF), not a YAML library. That is the whole format Obsidian's property UI produces, it avoids a new dependency, and anything it cannot read means the note is skipped, not served wrongly. Ceiling: nested YAML is ignored. Upgrade path: the `yaml` package, if you ever want richer properties.

**Server (`bridge/lib/notes.mjs`, used by `/api/notes?symbol=&tf=`)**
- Response: `{enabled, vault, folder, notes: [{title, kind, time, symbols, excerpt, open}]}`; `open` is the ready-made `obsidian://open` link. Excerpt only (about 280 characters, frontmatter and markdown punctuation stripped), never the full body. The full text opens in Obsidian.
- Safety: the folder is fixed config, resolved once; nothing in the request selects a file; `.md` only; files are `lstat`-checked (symlinks skipped); at most 500 files, first 16 KB of each read; invalid UTF-8 and malformed frontmatter skip the note. Output goes to the page through `textContent`.
- Cost: scanned lazily and cached 30 s, only when a browser asks. Reading `/mnt/c` from WSL is slow-ish (a few hundred ms for hundreds of files); the cache hides it.
- Auth, headers, 404 for an unknown stream: identical to every other route.

**Config** (default off, because it needs a path):
```
"dashboard": {"enabled": true, "host": "127.0.0.1", "port": 8788,
  "notes": {"enabled": false, "dir": "~/notes/markets", "vault": "ObsidianVault", "vault_folder": "markets"}}
```
`dir` is where the watcher reads (a real path on the machine running it); `vault_folder` is the same folder as seen from the vault root, used only to build links. A missing `dir` is logged once and re-checked on each scan, so creating the folder later just works.

**Frontend additions (`app.mjs`)**
- "Notes" panel for the selected stream, newest first, each a link to Obsidian; `kind` as a badge.
- Note markers (via `createSeriesMarkers`, merged with the alert and paper markers, sorted by time as the library requires).
- **Add note here:** click a candle (`chart.subscribeClick`), then a button opens `obsidian://new?vault=…&file=markets/<SYMBOL> <tf> <date time>&content=<frontmatter with symbols, time, kind: note>`.
- **Deep link in:** `/?symbol=BINANCE:BTCUSDT&tf=60&t=<unix seconds>` selects that stream and centres the chart on `t`. You can paste such a link into any note (so notes link back to the chart), and 7b's image alerts will reuse the same URL.
- Custom-scheme links (`obsidian://`) are not blocked by the CSP (it governs loads, not navigation). They only work if the browser is on a machine with Obsidian installed, which is true for your PC browser (directly or through the SSH tunnel); they will do nothing on the Pi's own screen.

**Getting the vault to the Pi.** The watcher runs on the Pi, the vault on your PC. For notes to show there, the `markets/` folder must exist on the Pi. Out of scope to build; the boring options are Syncthing (one-way "send only" of that single folder), or a `git pull` timer. On the PC the notes layer just works if you run the watcher in WSL with `dir` pointing at the vault. I will put this in the README.

**Not in this piece (kept separate on purpose)**
- *Producing* notes automatically (the trending scan or the research toolkit saving an "opportunity" note per hot symbol, or news fetched around an alert). The convention above is what those producers would write, so they can be added later without changing the dashboard. Say if you want one next; the watcher's trending scan is the cheapest first producer.
- Writing into the vault from the watcher. Deliberately not done (see "Direction").

**Notes tests (hermetic, temp folder)**: frontmatter variants (inline list, block list, quotes, CRLF, missing, malformed), symbol match rules, time parsing (ISO Z, offset, date-only, garbage), caps (size, count, symlink, non-`.md`), excerpt stripping and length, `/api/notes` shape / disabled / unknown stream 404, no request value ever reaches the filesystem, `obsidian://` link encoding for a vault name with spaces and for `&`, `=`, `#` in a title, auth parity with other routes.

## 9. More panels (revision 3): what else the dashboard can show

Rule for every extra: it reads data the watcher already holds (candles in memory, `state`, `health`, `config`, the existing indicator code). None adds a write path, a TradingView call, or a dependency. Each is an endpoint plus a panel, so each can be cut without touching the others.

| # | Panel | Shows | Data source (already exists) | New endpoint | Risk |
|---|---|---|---|---|---|
| B1 | **Overview grid** (the landing page) | One card per stream: last price, % change over the sparkline window, 60-close sparkline, health dot, last alert badge, "session open" for stocks | `streams.candles()`, `list()`, `state.alerts`, `isUsRegularHours` | `/api/overview` | low |
| B2 | **Watcher health** | Uptime; login yes/no (never values); per stream status, age of last data, attempt, disconnects, last error code; queue pending; sends this hour vs cap; quiet hours now; digest held/overflow; market clock (US open/closed, next holiday) | `health`, `streams.counters()`, `queue.pending()`, `state.sends`, `state.digest`, `usCalendar` | `/api/health` | low |
| B3 | **"What the rule sees" overlays** | RSI pane with the rule's levels; Bollinger bands; toggled per rule that exists for the stream | `bridge/lib/indicators.mjs`, the same functions the rules call | `/api/indicators?symbol=&tf=` | low |
| B4 | **Alert detail drawer** | Click an alert or marker: rule, direction, message, the `values` table, sent/held/digested, time, "copy chart link", "add note about this" (Obsidian) | `state.alerts[].meta` | none | low |
| B5 | **Opportunities (trending)** | Symbols the trending scan currently sees (within `remember_hours`), by market and kind, with age; "add note" (Obsidian, `kind: opportunity`) and a chart link when the symbol is a watched stream | `state.trending` | `/api/trending` | low (check the stored symbol format first) |
| B6 | **Rule noise preview** | "This rule would have fired N times in the last 300 bars", shown as hollow ghost markers, so you can tune a threshold before it spams you | `evaluateRules` (pure) over `streams.candles()` | `/api/preview?symbol=&tf=&rule=` | **medium** (see below) |
| B7 | **Save chart as PNG** | A button that downloads the current chart | `chart.takeScreenshot()` in the library (check it exists in 5.2.1); client only | none | trivial |
| B8 | **Alerts tab** | The 500 stored alerts with filters (rule, symbol, status, date) and per-rule counts per day | `/api/alerts?limit=500`, filtered in the page | none | low |
| B9 | **Header badges** | Market clock, "TradingView: logged in / anonymous", connection state (live / reconnecting) | B2 data, SSE state | none | trivial |
| B10 | **Tab-title badge** | "(2) Watcher" when alerts arrive while the tab is hidden | SSE `alert` | none | trivial |
| B11 | **Paper equity (realised)** | A small line of cumulative paper return from `exit` events, next to the gauntlet verdict; labelled "realised exits only" (the known 6b caveat: the backtest drawdown is mark-to-market) | `/api/paper` events | none | low |

**Why B3 is computed on the server, not in the browser.** `indicators.mjs` mirrors the Python maths exactly (same seeds, same smoothing) and has a fixture test proving it. If the page re-implemented RSI, the chart could quietly disagree with the alerts, which is the worst possible bug for a monitor. One implementation, one test, and the page only draws numbers.

**Why B6 is the risky one, and what I do about it.** The gates (expiry, `calendar: us_session`, composite members) live in a closure inside `onClosedBar` in `watcher.mjs`. W3's review found exactly this kind of problem: logic in `watcher.mjs` that nested rule lists bypassed. A preview that re-implements the gates would drift from the real behaviour. So B6 starts by **extracting the gate into one shared function** (`selectActive(rules, {now, timezone, inSession})`, in a small module) used by both `onClosedBar` and the preview, with the existing 429 tests proving `onClosedBar` behaves identically. The preview is honest about what it is: it shows rule hits only, it ignores cooldown, caps and quiet hours, and it looks at most 300 bars back. It is not a prediction and never says a rule "would have made money". Work is bounded: results are cached per (stream, rule, last closed bar) and the endpoint allows one computation at a time. B6 is its own commit, and it is the first thing to drop if the session runs long.

**Recommended set:** B1, B2, B3, B4, B5, B7, B8, B9, B10 now (all are "read what we already have"), B11 if cheap once `/api/paper` exists, B6 last and separately.

**Parked on purpose (not designed, say if you want any):** CSV export of alerts/paper; a manual theme toggle (the brief says `prefers-color-scheme`); split or multi-chart view; correlation views; drawing tools (they need saved state, which breaks "read-only"); browser notifications and sound; keyboard shortcuts for switching stream; showing gate `reason` text.

## 10. UI standards (the repo has no `docs/design/DESIGN.md`)
- **No framework and no build step.** Plain ES modules, `textContent`, one chart library. Reason: the CSP forbids inline code, the Pi should not need a bundler, and you asked for boring and well-documented. Ceiling: past roughly 800 lines in `app.mjs` I would split it into modules, still unbundled.
- **Tokens first.** The first UI step writes a one-page `docs/design/DESIGN.md` (CSS custom properties for both themes, spacing, type, the marker palette) for your OK, because the `ui-design-standards` skill expects one and I would rather not invent styling ad hoc.
- **Not colour alone.** Alert up = green triangle with "↑", down = red triangle with "↓", note = blue circle, paper = square "P". Contrast of 4.5:1 or better in both themes.
- **Every panel has loading, empty and error states**, plus a "live / reconnecting" badge from the SSE connection and a "stale" flag when a stream's last bar is older than expected.
- **Accessibility basics:** landmarks and headings, labelled controls, visible focus, `aria-live="polite"` on the alerts list, `prefers-reduced-motion` respected, keyboard-reachable stream picker and drawer.
- **Phone width (360 px) works**: one column (the tunnel makes a phone browser plausible).
- **Pi footprint.** PanWatch (about 1 GB) plus the watcher's `MemoryMax=512M` is the budget in `docs/plans/panwatch-ideas-and-pi-footprint.md`. The dashboard adds about 0.4 MB of candle arrays, about 250 KB of static files, and per-browser SSE buffers (at most 5 clients). I will measure RSS with and without a connected browser during the browser check and record it in the report.

## 11. Pieces, sessions and regimes

The expanded scope is too big for one session (global rule: stay under about 100k tokens of context) and the security part must be reviewed before UI is built on top of it. So four pieces, each ending in passing gates, a reviewed commit and a handoff.

| Piece | Scope | Regime | Start with | Fresh session | Delegates (optional, one worker per file) | Check |
|---|---|---|---|---|---|---|
| **P0** design (this session) | §1-§11 | 2 (routine planning) plus the Fable advisor, because the plan is both risky and architectural | Sonnet 5.5 High | done | none | you read it; advisor review of the design |
| **P1** core | Steps 0-6: dependency, `alerts` meta + `onRecord`, stream accessors, config, `tokensEqual`, `dashboard.mjs`, watcher wiring, `journals.mjs` | **4** build, delegated | Sonnet 5.5 High | **yes** | Luna Max for `bridge/lib/journals.mjs` only (pure functions: gauntlet and paper text in, whitelisted summary out; lead writes and commits the tests first). Sockets, auth, headers and wiring stay with the lead. | `timeout 100 npm test --prefix bridge`, `--check-config`, mutation check; then regime 11 with a Fable subagent + Luna Max, **plus Sol (Codex) because it is over 50 lines and security** |
| **P2** UI | `DESIGN.md`, `index.html`, `style.css`, `app.mjs`, README | **3** build in the main session | Sonnet 5.5 High | **yes** | none (optional Haiku xhigh for `style.css` only after the element ids are fixed; check = lead's screenshots at two widths) | HTML/allowlist test + Playwright run (CSP console clean, markers, RSS); regime 11 with the focus on `app.mjs` XSS and CSP |
| **P3** notes | §8: `frontmatter.mjs`, `notes.mjs`, `/api/notes`, panel, markers, "add note", deep link | **4** | Sonnet 5.5 High | yes (or same session if P1+P2 stayed small) | Luna Max for `frontmatter.mjs` only (a self-contained parser with lead-written tests) | `notes.test.mjs`, browser check; regime 11 |
| **P4** extras | §9: B1-B5, B7-B11, then B6 as its own commit | **3** (B6's gate extraction: treat as **6**-style care: the existing tests must pass unchanged first) | Sonnet 5.5 High | yes | none | tests per endpoint, browser check; regime 11 with the focus on the gate extraction |

**Why not an Opus regime-1 planning session.** Regime 1 is for architecture where the codebase does not already dictate the shape. Here the shape is fixed by the brief and the existing code (a separate server, an `EventEmitter`, read-only endpoints), and the design is grounded in file reads. The risky parts (security, the gate extraction) get a Fable advisor review now and a Fable + Luna + Sol review after the build. If the advisor finds a structural problem in this design, that is the trigger for an Opus plan-mode session, not before.

**Why these delegates, and only these.** Regime 4 says a delegate needs a check that can run and a bounded file. `journals.mjs` and `frontmatter.mjs` are the two pure, self-contained functions with a natural test table. Everything else is wiring, security, or browser behaviour, where a worker has no runnable check and Haiku/Luna "fall apart on unchecked multi-step work" (regimes.md rule 2). Delegation is optional: if a brief takes longer to write than the function takes to write, the lead writes it.

**Order and dependencies:** P1 -> P2 -> P3 -> P4. P3 and P4 only need P1's server and P2's page shell, and can swap order. 7b (image alerts) comes after all four and reuses the deep-link URL.

**My size estimate (rough, for planning only):** `dashboard.mjs` about 350 lines, `journals.mjs` 120, `frontmatter.mjs` + `notes.mjs` 250, `app.mjs` 600 or more, `style.css` 250, tests about 1.5x the code.

## 12. What I need from you
1. Approve the design or say what to change. Any piece you want cut (for example B6, B11, or the whole notes layer) can be struck without affecting the others.
2. OK to run the `npm install` in step 0 (at the start of P1).
3. Confirm defaults: dashboard `enabled` true; gauntlet gates without `reason`; the three security additions (Host check, 16-character token minimum, cap of 5 SSE clients).
4. Notes layer: the `symbols` / `time` / `kind` convention limited to the configured folder; read-only plus `obsidian://new` rather than the watcher writing notes.
5. Extras: which of B1-B11 you want (my recommendation is in §9); whether the first UI step should write `docs/design/DESIGN.md` for your OK.
6. The four-piece split and regimes in §11.

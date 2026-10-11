# Phase 5: market watcher (always on; runs on the Raspberry Pi)

## Brief (Opus)

**Goal:** a standalone Node process, `bridge/watcher.mjs`, that:
- streams live candles for a watchlist using the user's TradingView account
- checks rules when each candle **closes**
- runs a "what's trending" scan
- sends alerts to Discord and/or Telegram

It needs neither the MCP server nor Claude. **It never places trades.**

**Master plan:** §11. Read `docs/handoffs/STATUS.md` → Decisions, and the Phase 1 handoff to see what the bridge actually built.

### Read first
- `bridge/server.mjs` and `bridge/lib/*.mjs`. **Re-use** `redact.mjs`, `validate.mjs`, `errors.mjs` and `semaphore.mjs`; don't duplicate them.
- `bridge/node_modules/@mathieuc/tradingview/dist/data/candles.d.ts` (`watchCandles`), `data/operation.d.ts` (`Watcher`, `WatchHandlers`, `OperationOptions`), `http/watchlists.d.ts` (`getHotlist`), `http/screener.d.ts`, `client/client.d.ts`.
- `src/tradingview_mcp/core/services/indicators_calc.py`: the Python formulas the JavaScript must match.

### Verified facts (from the installed 4.0.0 types)
- `watchCandles(query, {onData(candles), onError?(err)})` returns `Promise<CandleWatcher>`.
  - `query` = `{symbol, timeframe?, count?, client?, credentials?, timeoutMs?, signal?, session?, ...}`
  - `onData` gets a fresh snapshot, oldest first, on every update. The last element is the **forming** bar.
  - The watcher has `.latest`, `.stop()`, `.closed` (a promise) and `.isActive`.
  - **A fatal error stops the watcher.** We must restart it.
- `getHotlist({kind: 'gainers'|'losers'|'mostActive'|'volumeGainers', market?, filter?, range?, columns?}, httpOptions?)` returns `{totalCount, rows: [{symbol, values}]}`. Typical `market` values are `crypto` and `america`.
- `new TradingViewClient({credentials})`. Pass `client` in `watchCandles` queries to share one connection; call `client.close()` on shutdown.
- **Python formulas to mirror exactly** (`indicators_calc.py`):
  - **SMA:** simple mean; the first `period-1` values are null.
  - **EMA:** seeded with the SMA of the first `period` values at index `period-1`; `k = 2/(period+1)`.
  - **RSI:** Wilder. Seed average gain/loss over the first `period` diffs at index `period`, then `avg = (avg*(period-1) + x)/period`. When `avg_loss == 0`, RSI = 100.
  - **Bollinger:** middle = SMA; std = **population** standard deviation, divided by `period`; upper/lower = middle ± mult·std.
  - **ATR:** TR = max(H−L, |H−prevC|, |L−prevC|) from index 1. Seed = mean of the first `period` TRs at index `period`, then Wilder smoothing.

### Rules
- Plain Node built-ins (`node:fs`, `node:path`, `node:http`, `node:timers/promises`, `node:test`, `node:assert`) plus the existing library. **No new dependencies.**
- Hermetic tests:
  - fake library (`watchCandles` / `getHotlist` / `TradingViewClient`)
  - fake `fetch`
  - injectable clock (`now()` and timers)
  - **no real network, ever**
- **Secrets** (`DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `WATCHER_LOCAL_TOKEN`, TradingView cookies) come only from env, and every log or error goes through `makeRedactor`.
- Only edit `bridge/**` and this handoff file. Don't commit or push.
- If the types disagree with this brief, follow the types and report it.

### Files
- `bridge/watcher.mjs`: CLI entry; exports `createWatcher(deps)` for tests.
- `bridge/lib/config.mjs`: load and validate config.
- `bridge/lib/indicators.mjs`
- `bridge/lib/rules.mjs`
- `bridge/lib/stream.mjs`: per-stream closed-candle detection, restart with backoff.
- `bridge/lib/scanner.mjs`: trending scan.
- `bridge/lib/notifiers.mjs`: Discord and Telegram.
- `bridge/lib/queue.mjs`: delivery queue with retry.
- `bridge/lib/alerts.mjs`: cooldown, hourly cap, quiet hours and digest, dedupe.
- `bridge/lib/state.mjs`: atomic JSON state.
- `bridge/lib/health.mjs`: stream-down/recovered alerts, daily heartbeat.
- `bridge/lib/localapi.mjs`: `127.0.0.1` `/notify` and `/health`.
- `bridge/lib/format.mjs`: message text.
- `bridge/watcher.config.example.json`
- `bridge/watcher.env.example`: names only.
- `bridge/watcher.service.example`
- `scripts/gen_indicator_fixtures.py`, which writes `bridge/test/fixtures/indicators.json`.
- `bridge/test/watcher/*.test.mjs`. Check that `node --test` in `bridge/` picks up subfolders. If it doesn't, adjust the `test` script to `node --test test/` or use a glob.
- `bridge/README.md`: add a "Watcher" section.

### CLI
`node bridge/watcher.mjs --config <path> [--check-config] [--test-notify] [--dry-run] [--once] [--log-json]`

| Flag | Effect |
|---|---|
| `--check-config` | Validate, print `OK` or the list of problems, exit 0 or 1. |
| `--test-notify` | Send "✅ tradingview watcher test" to every configured channel, print which succeeded, exit. |
| `--dry-run` | Run fully, but print alerts to stdout instead of sending. |
| `--once` | Run one trending scan, print it, exit. No streams. |

### Config (`config.mjs`)
- JSON, with the shape and defaults below (this is also the example file).
- `~` in paths expands to the home directory.
- Validation collects **all** errors with JSON paths:
  - symbols pass `validate.mjs`'s symbol check
  - timeframes are in the allowed set: `1, 3, 5, 15, 30, 45, 60, 120, 180, 240, D, W, M`
  - rule types are known and their params are numbers in sensible ranges
  - `symbol × timeframe` streams ≤ `limits.max_streams` (default 25, **hard cap 25**)
  - `trending.every_minutes` ≥ 5
  - quiet hours `HH:MM`
  - timezone is a valid IANA name (check with `Intl.DateTimeFormat(undefined, {timeZone})` in a try/catch)
  - the local API port is 1024–65535

```json
{
  "timezone": "America/New_York",
  "watchlist": [
    {"symbol": "BINANCE:BTCUSDT", "timeframes": ["15", "60", "240"]},
    {"symbol": "BINANCE:ETHUSDT", "timeframes": ["60", "240"]},
    {"symbol": "NASDAQ:NVDA", "timeframes": ["15", "D"], "market": "stock"}
  ],
  "rules": [
    {"id": "move", "type": "pct_move", "bars": 4, "threshold_pct": 3},
    {"id": "volspike", "type": "volume_spike", "multiple": 3, "lookback": 20},
    {"id": "rsi", "type": "rsi_cross", "period": 14, "levels": [30, 70]},
    {"id": "bb", "type": "bollinger_break", "period": 20, "stddev": 2},
    {"id": "breakout", "type": "new_extreme", "lookback": 50},
    {"id": "btc100k", "type": "price_cross", "symbol": "BINANCE:BTCUSDT", "level": 100000}
  ],
  "trending": {"enabled": true, "every_minutes": 10, "markets": ["crypto", "america"],
               "kinds": ["gainers", "volumeGainers"], "top_n": 15,
               "us_regular_hours_only": true, "remember_hours": 6},
  "alerts": {"cooldown_minutes": 60, "max_per_hour": 20,
             "quiet_hours": {"start": "23:00", "end": "07:00"}, "digest_after_quiet": true},
  "health": {"stream_down_minutes": 10, "daily_heartbeat": "08:00"},
  "state_dir": "~/.local/state/tradingview-watcher",
  "local_api": {"enabled": true, "port": 8787},
  "limits": {"max_streams": 25}
}
```
- Watchlist entries can have `market: "crypto" | "stock"`. Default: `crypto` for known crypto exchange prefixes (BINANCE, BYBIT, COINBASE, KUCOIN, OKX, BITGET, MEXC, GATEIO, HUOBI, BITFINEX, KRAKEN, BITSTAMP), otherwise `stock`.
- A rule may have `symbol` and/or `timeframes` to limit where it applies; otherwise it applies to every stream.

### Streams (`stream.mjs`)
- One shared `TradingViewClient` for the whole process, with credentials when both cookie env vars are set; anonymous otherwise, with a log line saying so.
- One `watchCandles({symbol, timeframe, count: 300, client}, handlers)` per stream.
- **Closed-candle detection:**
  - Keep `lastBarTime`.
  - On `onData(candles)`: when `candles.at(-1).time` > `lastBarTime` and `lastBarTime` was set, the bar at `lastBarTime` has closed. Find it in the snapshot and evaluate the rules on `candles` **up to and including that closed bar**. Exclude the forming bar.
  - Track `lastEvaluatedTime` per stream, and never evaluate the same bar time twice, including after a restart. **Persist it in state.**
  - On the first snapshot after start or restart, set `lastBarTime` without evaluating.
- **Restarts:** on `onError` or when `watcher.closed` resolves unexpectedly, restart with backoff 5s → 10s → 30s → 60s (capped), resetting after 10 minutes of healthy data. After a connection-type error code (`isConnectionError` from `errors.mjs`), recreate the shared client.
- **Stale stream:** no `onData` for more than `stream_down_minutes`. Stocks only count during their session (see Trending for regular hours).

### Indicators (`indicators.mjs`)
`sma`, `ema`, `rsi`, `bollinger` (`{upper, middle, lower}`), `atr`. Same nulls and maths as Python (see facts).

**Parity test:**
- `scripts/gen_indicator_fixtures.py` builds a deterministic 300-bar series (simple LCG or sine plus noise; no numpy) and writes inputs and outputs from the **Python** functions to `bridge/test/fixtures/indicators.json`.
- Commit the generated JSON.
- The Node test asserts equality within `1e-9` (both null at the same places).
- Run the script with `uv run python scripts/gen_indicator_fixtures.py`.

### Rules (`rules.mjs`)
- `evaluateRules(rules, stream, closedCandles)` returns a list of hits, where `closedCandles` ends at the closed bar.
- Each hit: `{ruleId, type, symbol, timeframe, barTime, direction: "up"|"down", values: {...}, message}`.
- Rule types:

| Type | Fires when |
|---|---|
| `pct_move` | `(close − close[−bars]) / close[−bars] × 100` ≥ `threshold_pct` in either direction |
| `volume_spike` | volume ≥ `multiple` × SMA(volume, `lookback`) of the **prior** `lookback` bars |
| `rsi_cross` | RSI crosses a level between the previous closed bar and this one; up if it rises through, down if it falls |
| `bollinger_break` | close > upper, or close < lower |
| `new_extreme` | close > max(high of the prior `lookback` bars) means up; close < min(low of the prior `lookback` bars) means down |
| `price_cross` | previous close < level ≤ close (up), or the reverse (down) |

- Not enough bars means no hit.

### Trending (`scanner.mjs`)
- Every `every_minutes`, for each `market` × `kind`, call `getHotlist({kind, market, range: [0, top_n]}, {})`.
- When `us_regular_hours_only` is on, skip `america` outside 09:30–16:00 America/New_York, Monday to Friday. Compute with `Intl.DateTimeFormat` parts; no libraries.
- **New-entry detection:** alert only on symbols not seen in that `market` × `kind` within `remember_hours`. Keep seen times in state.
- An empty result or an error means skip, log, and send no alert.

### Alerts (`alerts.mjs`) and queue (`queue.mjs`)
- **Dedupe key:** `symbol|timeframe|ruleId|barTime` (for trending: `trend|market|kind|symbol|hourBucket`).
- **Cooldown per `symbol|timeframe|ruleId`:** `cooldown_minutes`.
- **Hourly cap:** after `max_per_hour` sends in a rolling hour, extra alerts go into a pending digest, sent when the hour frees up as one summary message.
- **Quiet hours** (in config `timezone`): hold alerts; when quiet hours end, send one digest if `digest_after_quiet`, otherwise drop. Health alerts (stream down) ignore quiet hours.
- **Queue:**
  - never blocks streams
  - per alert, sends to every configured notifier
  - 3 attempts per notifier with backoff 2s, then 5s
  - on HTTP 429, wait the server's `retry_after` (Discord: JSON `retry_after` in seconds; Telegram: `parameters.retry_after`), capped at 60s
  - after the last failure, log (redacted) and drop
- All timing uses the injectable clock.

### Notifiers (`notifiers.mjs`), using global `fetch`
- **Discord:**
  - configured when `DISCORD_WEBHOOK_URL` is set
  - `POST <url>` with JSON `{content: <≤2000 chars>, embeds: [{title, description: <≤4096>, color, timestamp: ISO, url}]}`
  - colour green for up, red for down, blue for info
- **Telegram:**
  - configured when `TELEGRAM_BOT_TOKEN` **and** `TELEGRAM_CHAT_ID` are set
  - `POST https://api.telegram.org/bot<token>/sendMessage` with JSON `{chat_id, text: <≤4096, HTML-escaped>, parse_mode: "HTML", disable_web_page_preview: true}`
- Truncate long text with `…`.
- **Never log the URL or the token.**

### Message format (`format.mjs`)
- Title: `🟢 BINANCE:BTCUSDT · 1h · pct_move` (🔴 for down, ℹ️ for info).
- Body:
  - the rule message (for example "Up 3.4% over 4 bars")
  - key values
  - bar close time in config timezone and UTC
  - data age
  - chart link `https://www.tradingview.com/chart/?symbol=<encodeURIComponent(symbol)>`
- Timeframe labels: `1`→1m, `60`→1h, `240`→4h, `D`→1D, and so on.

### State (`state.mjs`)
- `state_dir/state.json` holds: `lastEvaluatedTime` per stream, cooldowns, trending seen times, the last 500 alerts (for the Phase 7 dashboard), digest buffers and the last heartbeat date.
- **Atomic write:** write a temp file, `fsync`, rename. Debounce writes to at most once every 5 seconds, plus on shutdown.
- A corrupt file is renamed to `state.json.corrupt-<ts>`, and the watcher starts fresh with a log line.

### Health (`health.mjs`)
- **Stream down/recovered:** one alert when a stream goes stale, one when it recovers.
- **Daily heartbeat** at `daily_heartbeat` (config timezone): uptime, streams healthy/total, alerts in the last 24h, whether credentials are in use (yes/no, never values).
- **Process level:** `unhandledRejection` / `uncaughtException` mean log (redacted) and exit 1, so systemd restarts. SIGTERM/SIGINT mean a graceful stop: stop watchers, flush state, close the client and the local API, then exit 0.

### Local API (`localapi.mjs`)
- `node:http`, bound to **`127.0.0.1` only**. Starts only when `local_api.enabled` **and** `WATCHER_LOCAL_TOKEN` is set; otherwise log "local API disabled".
- `POST /notify`:
  - header `Authorization: Bearer <token>`, compared with `crypto.timingSafeEqual` on equal-length buffers
  - body JSON `{title (≤200), body (≤2000), key (≤200), level: "info"|"up"|"down"}`, maximum body 8 KB
  - goes through the same alerts pipeline
  - responses: `202`, `400` (bad body), `401` (bad token)
- `GET /health` returns `{ok, streams: {healthy, total}, uptime_s}`, with no auth and no secrets.

### Deployment files
- **`watcher.env.example`:** variable names only:
  ```
  TRADINGVIEW_SESSION_ID=
  TRADINGVIEW_SESSION_SIGN=
  DISCORD_WEBHOOK_URL=
  TELEGRAM_BOT_TOKEN=
  TELEGRAM_CHAT_ID=
  WATCHER_LOCAL_TOKEN=
  ```
- **`watcher.service.example`:** the systemd unit from master plan §11, with `User=pi`, `EnvironmentFile=/etc/tradingview-watcher.env`, `Restart=on-failure`, `RestartSec=10`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths=/home/pi/.local/state/tradingview-watcher`, `PrivateTmp=yes`.
- **`bridge/README.md`, "Watcher" section:**
  - Pi steps: Raspberry Pi OS 64-bit, Node 22, `npm ci --ignore-scripts`, env file with `chmod 600`, config, `systemctl enable --now`, `journalctl -u ... -f`
  - how to create a Discord webhook and a Telegram bot and chat id (BotFather, `getUpdates` opened in your own browser)
  - the CLI flags

### Tests (`bridge/test/watcher/`)
- config:
  - the valid example passes
  - each invalid case is reported, with all errors collected
  - more than 25 streams is rejected
- indicators: parity with the fixture
- rules:
  - each type, with hits and non-hits
  - not enough bars means no hit
- stream:
  - first snapshot doesn't evaluate
  - a new bar evaluates the previous one exactly once
  - replay after restart doesn't double-evaluate
  - backoff schedule (fake timers)
  - the client is recreated after a connection error
- scanner:
  - new-entry logic
  - `remember_hours` expiry
  - US-hours gating: a Saturday, a weekday at 09:00 and a weekday at 10:00 in New York, using a fixed clock
- alerts:
  - dedupe
  - cooldown
  - hourly cap into a digest
  - quiet hours into a digest at the end
  - health bypasses quiet hours
- queue / notifiers (mocked `fetch`):
  - Discord and Telegram payload shapes and limits
  - HTML escaping
  - 429 `retry_after` honoured
  - retries then drop
  - **the URL and token never appear in logs**: capture the log function output and assert
- state:
  - atomic write
  - reload
  - corrupt file recovery
- local API:
  - 401 without or with a wrong token
  - 202 with the right token
  - 400 on a bad body
  - binds to 127.0.0.1
  - disabled when no token
- CLI:
  - `--check-config` exit codes, by spawning `node watcher.mjs` with a temp config
  - `--dry-run` prints alerts and does not call `fetch`

### Acceptance
- `cd bridge && npm test`: everything passes, including the existing 40+ bridge tests.
- `node bridge/watcher.mjs --config bridge/watcher.config.example.json --check-config` prints `OK`.
- `uv run pytest tests/unit -q` is unchanged and green.

### Report (append under "## Implementation report (Haiku)")
- files
- any type mismatches
- the real last lines of `npm test`
- the `--check-config` output

### Additions from the Phase 1 advisor (Fable), required
- **Re-use `bridge/lib/client.mjs`** (the shared-client lifecycle extracted from `server.mjs`: closed-client replacement, connection-error drop, 60s auth cool-down) for the watcher's single shared `TradingViewClient`. Don't write a second lifecycle.
- **One client with N streams:** an inactivity close or disconnect kills all streams together. Add **random jitter (0–30%)** to the restart backoff in `stream.mjs`, so N streams don't reconnect at the same instant.
- **Unknown:** whether TradingView drops one of two authenticated websockets that use the same cookie (Pi watcher plus desktop MCP at once). Log every disconnect with its time, and keep a counter in `/health` so Adham can spot it. Record it in the report as an open question for live testing.


## Implementation report (Haiku)

Status: built and tested. `cd bridge && npm test` passes 296 of 296: the 74 original tests plus 222 new watcher tests. Python `uv run pytest tests/unit -q` also passes (658). That run was read-only, and the Python agent's edits share the same working tree.

### Files

Created in `bridge/`:
- `watcher.mjs`: CLI entry point and `createWatcher(deps)`.
- `lib/config.mjs`, `lib/indicators.mjs`, `lib/rules.mjs`, `lib/stream.mjs`, `lib/scanner.mjs`, `lib/notifiers.mjs`, `lib/queue.mjs`, `lib/alerts.mjs`, `lib/state.mjs`, `lib/health.mjs`, `lib/localapi.mjs`, `lib/format.mjs`.
- `watcher.config.example.json` (the brief's example), `watcher.env.example` (names only, no values), `watcher.service.example` (the systemd unit).
- `test/fixtures/indicators.json`: generated by `uv run python scripts/gen_indicator_fixtures.py`, 300 bars, outputs from the Python functions.
- `test/watcher/`: `config`, `indicators`, `rules`, `stream`, `scanner`, `alerts`, `queue`, `notifiers`, `state`, `format`, `health`, `localapi`, `watcher`, `cli` and `client-failure` tests. `support.mjs` holds the fake clock, fake fetch and fake library (it has no tests).

Created at repo root: `scripts/gen_indicator_fixtures.py`.

Changed:
- `bridge/README.md`: a "Watcher" section (Pi steps, Discord and Telegram setup, CLI flags, config, local API, open question).
- `bridge/lib/client.mjs`: the failure bookkeeping in `call()` moved into a new `reportFailure(err, used)` method, so streams use the same auth cool-down and client-drop rules. `call()` behaves as before, and the 74 original tests pass unchanged.

Not touched: `src/`, `tests/`, and git (no commit, push, stash or reset).

Git note: `HEAD` already contains earlier "WIP snapshot" commits (`24ef4dc`, `bf32897`) that include an in-progress copy of these bridge files. Some working-tree changes are not from this phase: `Dockerfile`, `.github/workflows/test.yml`, `pyproject.toml`, `.env.example`, `.dockerignore` and `.gitignore`.

### Type mismatches and API notes

I followed the installed `.d.ts` files. No brief item was blocked.
1. `getHotlist` options are typed `HttpOptions`, with no credentials. I pass `{signal}` (the brief had `{}`) and use no credentials.
2. `getHotlist` without `columns` returns the library defaults: `name, close, change, volume, relative_volume_10d_calc`. Trend messages depend on these.
3. `Watcher.closed` is `Promise<void>`, so errors arrive only through `onError`. Any `onError` restarts that stream, as the brief says, and the same goes for an unexpected close.
4. `Timeframe` is an open string union. The watcher checks against the brief's set (`1,3,5,15,30,45,60,120,180,240,D,W,M`).
5. Candle `time` is the bar open time in Unix seconds. A bar's close time is the next bar's time.

### Interpretations and decisions beyond the brief (please review)
- `pct_move`: I read `close[−bars]` as "N bars ago", so the reference is index `n-1-bars`. A literal Python-style index would span `bars-1` bars. Please confirm.
- `price_cross` down is the exact mirror of up: previous close ≥ level > close.
- `rsi_cross` gives one hit per bar listing every level crossed. A single move can cross several levels, but all in one direction.
- Rule parameter defaults come from the brief's examples: `volume_spike.lookback` 20, `rsi_cross` period 14 with levels `[30,70]`, `bollinger_break` period 20 and stddev 2, `new_extreme.lookback` 50. `pct_move`, `volume_spike.multiple` and `price_cross.level` are required.
- Config validation rejects unknown keys (typo guard). A rule whose `symbol` is not on the watchlist, or whose `timeframes` are not watched, is an error.
- Health alerts (stream down, recovered, heartbeat) skip the hourly cap as well as quiet hours. The brief only names quiet hours.
- Quiet-hours digests and hourly-cap digests share one message. The title is "N alerts summarised", with at most 30 lines listed.
- Trending `--once` ignores the US-hours gate and the seen list, and it changes no state. The first-ever scan alerts on every top-N symbol, which the cap and digest then absorb.
- Stock sessions use US regular hours for every `stock` market. Non-US stocks are not supported correctly.
- Discord `content` is the title, which duplicates the embed title. Telegram's link text is "Chart".
- `/notify` bodies over 8 KB return 400, since the brief lists only 202, 400 and 401. Unknown routes return 404.
- `GET /health` returns `{ok, streams:{healthy,total}, uptime_s, disconnects, connection_drops}`. `disconnects` counts stream failures summed over streams. `connection_drops` counts shared connections lost, with each connection counted once however many streams it failed.
- Dry run reads state but never writes it. `--check-config` prints `OK` on stdout and warnings on stderr. Warnings do not fail the check.
- Redaction note: the redactor replaces exact env secret values with `[REDACTED]` before its patterns run.

### Open question for live testing (not testable offline)
Does TradingView drop one of two websockets that share a cookie? Watch `connection_drops` and `disconnects` in `GET /health`, and the log lines `shared connection lost at <ISO> (<code>)` and `<key> disconnected at <ISO> (<code>)`. Record what you see.

### Not verified (needs Adham or the Pi)
- Live candles, live `--test-notify` (Discord and Telegram), `--dry-run` against TradingView, and the systemd restart. The cloud session has no network, and every test uses fakes.
- The real websocket path in `loadLibrary()` is untested. Its exports match `server.mjs`.

### Real output: `cd bridge && npm test` (last lines)
```
# tests 296
# suites 0
# pass 296
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2438.845237
```

### Real output: `node bridge/watcher.mjs --config bridge/watcher.config.example.json --check-config`
```
OK
warning: no notification channel is configured; alerts are only logged
warning: WATCHER_LOCAL_TOKEN is not set; the local API stays disabled
exit=0
```
(The two warnings go to stderr because this sandbox has no channel or token set. They do not change the result.)


## Review report (Sonnet)

Baseline was 296 passing. After the review, `cd bridge && npm test` passes 327 of 327. The indicator parity test against the Python fixture still passes unchanged. Scope: `bridge/**` and this file only. No commit, push, stash or reset. No new dependencies. All new tests use fakes (no network, no real clock except a short real-time wait for disk writes).

### Defects found and fixed (file, what was wrong, fix)

1. **Bars missed across a reconnect** (`bridge/lib/stream.mjs`, `handleData`). Every restart reset `lastBarTime` and evaluated nothing on the first snapshot. A bar that closed during a 5 to 60 s reconnect was never evaluated, so a normal websocket blip could silently drop an alert. Fix: on the first snapshot after a (re)start, bars after the persisted `lastEvaluatedTime` are evaluated once, but only if they closed within two bar lengths (at least 5 minutes). The forming bar is still never evaluated, a stream with no persisted time still evaluates nothing, and a long outage never replays old bars. The `evaluated` check still prevents double evaluation.
2. **Bad cookies hammered TradingView** (`stream.mjs`, `nextDelay`). After an `AUTH_ERROR` each stream retried every 60 s forever (one client construction with an account lookup per minute, all night). Fix: auth errors back off 5, 15, 30, then 60 minutes (plus jitter), and the step resets when data arrives. The client manager's 60 s fast-fail cool-down stays as the inner guard.
3. **Held alerts could be stranded after a restart** (`bridge/lib/alerts.mjs`, `tick`). Held alerts were released only on a quiet to not-quiet edge seen by the running process (`wasQuiet`, in memory). If the Pi was down or restarting when quiet hours ended, the saved held alerts were never released, and went out with the next night's digest. Fix: release whenever not in quiet hours and something is held.
4. **Unbounded digest buffers** (`alerts.mjs`). `digest.held` and `digest.overflow` grew without limit during a long quiet period or an alert storm. Fix: each keeps the newest 500 summaries.
5. **Health alerts consumed the hourly cap** (`alerts.mjs`, `deliver`). Critical alerts bypassed the cap but were still counted as sends, so a burst of "stream down" alerts (one shared-connection loss can raise 25) starved rule alerts afterwards. Fix: critical messages are not counted.
6. **A clock that stepped back could silence alerts** (`alerts.mjs`). A Raspberry Pi has no battery clock. Cooldown and dedupe entries with a time in the future suppressed alerts until real time caught up. Fix: a time in the future never counts as "recent". `watcher.service.example` now waits for `time-sync.target`. `prune()` is also called from `alerts.tick()`, so dry-run (which never writes state) no longer grows `seen` and `cooldowns` forever.
7. **`/health` and heartbeat overstated health** (`bridge/lib/health.mjs`). A stream that was connected but silent (flagged "down") still counted as healthy. Fix: `summary()` and the heartbeat exclude streams currently flagged down.
8. **Shutdown could lose state** (`bridge/watcher.mjs`, `stop`). The order was streams, then a 5 s queue drain, then state flush, while the hard-exit timer was also 5 s. If a notifier hung, the process exited before the state was saved. Fix: flush state right after the streams stop and again at the end, and the hard-exit grace is now 15 s.
9. **`--test-notify --dry-run` sent for real** (`watcher.mjs`, `runTestNotify`). The brief says dry-run never sends. Fix: with `--dry-run`, the test message is printed and nothing is sent.
10. **A bug in housekeeping crashed the process** (`watcher.mjs`, `tick`). `alerts.tick()` and `health.tick()` ran unguarded inside `void tick()`, so one exception became an `unhandledRejection` and exit 1. Fix: each step is wrapped and logged.
11. **Crash could repeat an alert** (`watcher.mjs`). State is debounced by 5 s, so a crash right after an alert lost the dedupe record, and the restart (now with catch-up) could send the same alert again. Fix: state is flushed immediately after any bar that produced a hit, and the fatal handlers (`unhandledRejection`, `uncaughtException`) flush state (bounded to 2 s) before `exit(1)`.
12. **Discord could ping @everyone** (`bridge/lib/notifiers.mjs`, `discordPayload`). Text from `/notify` or a symbol name was sent without `allowed_mentions`. Fix: `allowed_mentions: {parse: []}`.
13. **Secret scrubbing relied only on the env-based redactor** (`notifiers.mjs`, `postJson`). A transport error that echoed only the bot token or the webhook secret part (not the whole URL) was cleaned only if the caller's redactor knew the value. Fix: the notifier also removes the token and the webhook secret segment itself.
14. **Pointless retries** (`bridge/lib/queue.mjs`). A 400/401/403/404 (revoked webhook, wrong chat id, bad payload) was retried 3 times. Fix: permanent 4xx errors (other than 408 and 429) are dropped at once with a log line. 408, 429 and 5xx are still retried.
15. **Local API token check leaked the token length** (`bridge/lib/localapi.mjs`, `tokenMatches`). Fix: both sides are SHA-256 hashed, then compared with `timingSafeEqual` (always equal length). A declared `Content-Length` over 8 KB is refused with 400 before reading, and the server has request and header timeouts. Authentication is still checked before any body is read.
16. **State write durability** (`bridge/lib/state.mjs`). The rename was not made durable. Fix: the directory is fsynced after the rename (best effort). On an SD card this matters for power loss.
17. **Rules that can never fire were accepted** (`bridge/lib/config.mjs`, `rules.mjs`). Each stream keeps 300 bars, but `new_extreme.lookback`, `pct_move.bars`, `volume_spike.lookback` and others allowed up to 500, so such a rule silently never fired. Fix: `barsNeeded(rule)` is checked against 300 and reports `rules[i]: needs N closed bars but the watcher keeps only 300 per stream`.
18. **Deployment** (`watcher.service.example`, `README.md`). `ReadWritePaths=` points at a directory that did not exist; systemd fails the unit with a namespace error. The README now creates `~/.local/state/tradingview-watcher`, and the unit has a comment about it.

### Confirmed correct (no change)
- **Rule semantics.** `pct_move` reference = close N bars ago, index `n-1-bars`. This is the intended meaning (it matches TradingView's ROC, and a literal Python `[-bars]` would span `bars-1` bars). The existing test hand-checks it. `price_cross` down is the exact mirror (previous >= level, close < level), with no double fire at equality. `rsi_cross` reports one hit per bar listing every level crossed, all in one direction: fine. Defaults are fine. Indicators match the Python fixture.
- Closed-candle logic for repeated, older (out-of-order) and gapped snapshots; the forming bar is never evaluated.
- Shared-client loss: the library fails all watchers on one `close` event, each stream restarts with its own jitter (0 to 30%), and the first one creates the single replacement client. `connection_drops` counts it once.
- Stale detection respects stock sessions (US regular hours) and gives a grace period when the session reopens.
- Library facts verified from `dist/data/operation.js`: `onError` also receives non-fatal `warn` errors (any `onError` triggers our restart, as the brief says), the client has its own 60 s inactivity watchdog, and `watchCandles` times out after 15 s waiting for first data.
- Local API binds to `127.0.0.1` only. `/health` holds no secrets.

### Tests added (31 new; 296 to 327)
- `stream.test.mjs`: catch-up of recent bars; catch-up refuses old bars; no catch-up without persisted state and never the forming bar; replay after an in-process reconnect; out-of-order snapshot; auth backoff 5 then 15 min; auth backoff reset by data; jitter spreads many streams onto one new client. Updated: the auth cool-down test now allows the longer wait.
- `alerts.test.mjs`: held alerts released after a restart; health alerts not counted against the cap; bounded digest buffers; quiet hours across autumn DST and spring DST in New York; future-dated cooldown does not silence; cooldown across local midnight.
- `health.test.mjs`: silent stream not counted healthy, healthy again after recovery.
- `notifiers.test.mjs`: `allowed_mentions`; scrubbing of the token and the webhook secret segment without help from the redactor; Telegram HTML escaping of title, body and link.
- `queue.test.mjs`: permanent 4xx dropped without retry; 408 and 5xx retried.
- `localapi.test.mjs`: digest-based token compare (any length); oversize `Content-Length` refused early; 401 before reading a big body; `/health` has no token or secret words.
- `config.test.mjs`: rules needing more than 300 bars are reported.
- `watcher.test.mjs`: `--test-notify --dry-run` never calls fetch; a housekeeping bug is logged, not fatal; a hit is saved at once; shutdown saves state before waiting for a hung delivery (verified to fail against the old order); chat id, local token, cookies, webhook and bot token never appear in any log even when Telegram and Discord fail.
- `state.test.mjs`: write order is now temp write, fsync, rename, directory fsync.

### Follow-ups and open decisions (not changed)
- **First trending scan floods.** A first-ever scan (or one after state loss or a gap longer than `remember_hours`) alerts on every top-N symbol, up to 60 messages. The cap and digest absorb it, but the first 20 are sent. Consider seeding a never-seen market x kind silently. This is a product decision.
- **Cooldown key ignores direction.** A `price_cross` up followed by a down within `cooldown_minutes` (default 60) is suppressed. Consider adding the direction for `price_cross`.
- **Stock streams and thin tickers.** "Stream down" fires after `stream_down_minutes` with no tick during US hours. An illiquid stock can be quiet that long, and the check ignores US holidays and early closes. It also assumes every `stock` is a US stock. Consider a longer threshold for stocks and a holiday list.
- **No self-restart of a silent stream.** A stream that is connected but silent is alerted and recovers if data resumes, but it is not restarted. The library's own 60 s inactivity watchdog covers dead sockets, and a forced restart would make quiet stocks flap down/recovered. Revisit after live data.
- **Delivery is parallel.** A burst can hit Discord's webhook rate limit (429, handled by `retry_after`). A per-notifier serial queue would keep order and avoid 429s.
- **Signal wiring in `main()` is untested.** SIGTERM/SIGINT/fatal handlers need a live process (the real library would try the network). `createWatcher().stop()` is tested. Check once on the Pi: `systemctl stop`, then expect the "stopped" log and exit code 0.
- **Open live question (unchanged):** does TradingView drop one of two websockets sharing a cookie? Watch `connection_drops` and `disconnects` in `GET /health`.
- **Not verified (needs Adham or the Pi):** live candles, live `--test-notify`, the systemd unit, the real `loadLibrary()` path.

### Real output: `cd bridge && npm test` (last lines)
```
1..327
# tests 327
# suites 0
# pass 327
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2384.123655
```

### Real output: `node bridge/watcher.mjs --config bridge/watcher.config.example.json --check-config`
```
OK
warning: no notification channel is configured; alerts are only logged
warning: WATCHER_LOCAL_TOKEN is not set; the local API stays disabled
exit=0
```

## Advisor fixes (Sonnet): done

Scope: tests, `bridge/README.md`, `bridge/watcher.service.example`, this file. No change to `bridge/lib/*.mjs` or `watcher.mjs` was needed (no real bug found in review). No commit, push, stash or reset.

### Status per item
- Must-fix, batched health alerts with `lastError`: done.
- (a) silent seeding of trending: done.
- (b) direction in the cooldown key: done; test added.
- (c) `stock_stream_down_minutes` / `us_holidays` / early closes: done.
- (d) crypto `SILENT` self-restart: done.
- (e) serial FIFO per notifier, 200 cap: done and verified in `queue.mjs`; tests added.
- (f) long backoff for `SYMBOL_ERROR` and similar codes: done; test added.
- (g) service file + README: done. `Restart=always`, `MemoryMax=512M`, `systemd-time-wait-sync.service` in `After=`/`Wants=`, a journald note.

### Fixed in review
- README said "After= on a disabled unit does nothing" and told the reader to `enable systemd-time-wait-sync`. That is inaccurate: `Wants=` already pulls the service in when the watcher starts. Removed the enable step and added a "Clock sync" paragraph. It notes that the service only waits when `systemd-timesyncd` is the time daemon (Raspberry Pi OS default, as far as I know; hedged, check with `systemctl is-active systemd-timesyncd`).

### Tests added in this pass (6 new; 338 at the stop point to 344)
- `queue.test.mjs`: "a 429 on message 1 holds message 2 in the same lane...in order"; "a full lane (maxQueued 3) drops the oldest non-critical message, keeps critical ones, and logs it"; "when every waiting message is critical, a full lane drops the oldest one and says so".
- `watcher.test.mjs`: "the cooldown is per direction: a move down is sent right after a move up, and a second move up is held".
- `stream.test.mjs`: "SYMBOL_ERROR waits 5 minutes, then 15 minutes, instead of retrying every minute"; "a plain connection error keeps the short backoff...".

### Mutation check (on a copy in the scratchpad; repo files untouched)
- (a) drop `|${hit.direction}` from the cooldownKey: `watcher.test.mjs` FAILS (the per-direction test).
- (b) remove `SYMBOL_ERROR` from `LONG_BACKOFF_CODES`: `stream.test.mjs` FAILS (SYMBOL_ERROR test).
- (c) overflow ignores `critical` (always `splice(0, 1)`): `queue.test.mjs` FAILS (full lane, non-critical test).
- (d) ignore `retryAfterSec` on 429: `queue.test.mjs` FAILS (the new ordering test, plus two older 429 tests).
- Not caught by a mutation: the plain-error short-backoff test and the all-critical test are guards for the opposite case; (c) did not fail the all-critical test, which is expected (index -1 gives splice 0 either way).

### Design note (not changed)
`volume_spike`'s direction is the candle colour, so a green spike and a red spike within the cooldown both alert (separate cooldown keys).

### Pi verify
- `systemctl is-active systemd-time-wait-sync`
- `systemctl is-active systemd-timesyncd` (the wait service only really waits with timesyncd)
- `cat /sys/fs/cgroup/system.slice/tradingview-watcher.service/memory.max` prints `536870912`, and `grep memory /proc/cgroups` shows it enabled. `systemctl show -p MemoryMax` only echoes the config, it does not prove enforcement. If it is off, add `cgroup_enable=memory cgroup_memory=1` to `/boot/firmware/cmdline.txt`.
- `command -v node` is `/usr/bin/node` (else `203/EXEC` restart loop)

## Advisory review (Fable)
Verdict: ship after one README fix. Re-ran 344/344; `systemd-analyze verify` on a copy shows no unknown directives.
- MUST-FIX, applied: README step 1 now says to install Node from NodeSource so it is at `/usr/bin/node`, or to edit `ExecStart=`. With nvm the unit fails `203/EXEC`, and `Restart=always` loops every 10 s.
- Applied: clock-sync wording (with chrony/ntpd the wait relies on an unreliable kernel flag, it does not return at once; no timeout at boot is intended); the MemoryMax caveat moved into the README with an enforcement check; "any exit" became "any unexpected exit".
- Confirmed: `Restart=always` is right (`watcher.mjs` exits 0 on a stdout error, which `on-failure` would not restart); no test passes for the wrong reason; `ReadWritePaths` + `ProtectSystem=strict` is the documented pattern; the 15 s shutdown grace is well under the 90 s `TimeoutStopSec`.
- Not changed: `SystemMaxUse` covers only the persistent journal, which is what the paragraph sets up.
- Existing items: `systemctl stop` should log "stopped" and exit 0; watch `connection_drops` and `disconnects` in `GET /health`.

### Real output: `npm test --prefix bridge | tail -9`
```
✔ the chat id, local token, cookies, webhook and bot token never reach a log, even when Telegram fails (32.080399ms)
ℹ tests 344
ℹ suites 0
ℹ pass 344
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2911.747692
```

### Real output: `node bridge/watcher.mjs --config bridge/watcher.config.example.json --check-config; echo exit=$?`
```
OK
warning: no notification channel is configured; alerts are only logged
warning: WATCHER_LOCAL_TOKEN is not set; the local API stays disabled
exit=0
```

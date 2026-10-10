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

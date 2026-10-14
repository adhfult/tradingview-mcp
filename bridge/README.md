# TradingView bridge

A small Node process that wraps the npm library `@mathieuc/tradingview` (pinned to 4.0.0) and answers requests over stdin and stdout. The Python server starts it and talks to it as JSON lines.

It is read-only market data. It places no orders and changes nothing on the account.

## Install

```sh
cd bridge
npm ci --ignore-scripts
npm test
```

Node 20 or newer is required (Node 22 is used in development). The only dependency is `@mathieuc/tradingview`, pinned exactly. `npm ci` uses `package-lock.json`, whose `resolved` URLs point to `https://registry.npmjs.org/`.

## Protocol

Each line on stdin is one JSON request, and each request gets exactly one line on stdout:

```json
{"id": 1, "method": "candles", "params": {"symbol": "BINANCE:BTCUSDT", "timeframe": "60", "count": 5}}
```

Responses are `{"id": ..., "result": ...}` or `{"id": ..., "error": {"code": "...", "message": "..."}}`. Requests run concurrently, so responses can arrive out of order. Match them by `id`. A line that is not valid JSON gets `{"id":null,"error":{"code":"INVALID_PARAMETER","message":"invalid JSON"}}`. Blank lines are ignored.

Logs go to stderr only. Stdout carries protocol lines and nothing else: at start-up, before the library is imported, every console method and any stray `process.stdout.write` is redirected to stderr (redacted), and only the bridge's own protocol writer reaches the real stdout.

When stdin closes, the process waits for pending requests, closes the TradingView connection and exits with status 0. It does the same on SIGTERM and SIGINT.

### Methods

| Method | Params | Result |
|---|---|---|
| `health` | none | `{ok, libVersion, node, hasCredentials}` |
| `candles` | `symbol`, `timeframe` (default `D`), and either `count` (1 to 5000, default 300) or `from` (unix seconds) with optional `to` and `maxCount` (1 to 20000) | `[{time, open, high, low, close, volume}]`, oldest first |
| `quotes` | `symbols` (1 to 50) | record keyed by symbol |
| `indicator` | `symbol`, `timeframe`, `indicator` (script ID, up to 200 characters), `inputs` (object, optional), `count` (1 to 500, default 100) | `{name, values: [{time, ...plots}], strategy}` |
| `search` | `query` (1 to 60 characters), `type` (optional) | up to 20 `{id, symbol, exchange, fullExchange, type, description}` |
| `symbol_info` | `symbol` | primitive top-level fields, at most 40 keys |
| `screener` | `market`, `columns` (1 to 20), `filter`, `sort`, `range` (`[from, to]`, 0 <= from < to <= 200) | `{totalCount, rows}` |
| `hotlist` | `kind` (`gainers`, `losers`, `mostActive`, `volumeGainers`), `market`, `range` | `{totalCount, rows}` |
| `technical` | `symbol` | ratings per period, or `null` |

Every method also takes an optional `timeoutMs`. It defaults to 15000 and is clamped to 1000 to 60000. Websocket calls pass it to the library; HTTP calls get an `AbortSignal` that fires after it. As a backstop, a call that is still running 5 seconds after `timeoutMs` is answered with `TIMEOUT`, its concurrency slot is released, and (for websocket calls) the shared client is dropped. An HTTP call aborted by the bridge's own timer is also reported as `TIMEOUT`.

`indicator.strategy` is `null` unless the study produced a strategy report (trades or performance data). `quotes` removes duplicate symbols before the call. `screener` and `hotlist` accept a `market` that is a bare scanner name (letters, digits, `_`, `-`; it becomes a URL path segment).

The shared websocket client is created on first use and replaced when it closed while idle, after a connection or auth error, when a call outlives its deadline, or when a call times out before the connection was ready. The library never reconnects a closed client by itself. After an `AUTH_ERROR` with cookies configured, websocket calls fail fast with the same `AUTH_FAILED` error for 60 seconds without building a new client (each new client costs an account lookup plus a websocket handshake). The lifecycle lives in `lib/client.mjs`.

Error codes: `INVALID_PARAMETER`, `SYMBOL_NOT_FOUND`, `TIMEOUT`, `AUTH_FAILED`, `PERMISSION_OR_SERIES`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `NO_DATA`, `UPSTREAM_ERROR`.

## Environment variables

| Variable | Purpose |
|---|---|
| `TRADINGVIEW_SESSION_ID` | Value of the `sessionid` cookie. Used only together with the next variable. |
| `TRADINGVIEW_SESSION_SIGN` | Value of the `sessionid_sign` cookie. |
| `TRADINGVIEW_BRIDGE_MAX_INFLIGHT` | Maximum concurrent library calls. Default 2, limited to 1 to 8. |

Without both cookie variables the bridge runs anonymously, with the delayed or limited data TradingView gives anonymous clients.

The other secret names known to the redactor (`DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `WATCHER_DASHBOARD_TOKEN`, `WATCHER_LOCAL_TOKEN`) are never read by the bridge. They are only used to scrub logs and errors.

## Security notes

- Cookies come only from environment variables. They are never read from requests, files or logs.
- Every error message and log line is redacted, as is anything the library writes to stderr or the console. The redactor removes the values of the secret variables (also their URL-encoded and JSON-escaped forms), `sessionid` cookies (`name=value` and JSON forms), Telegram bot tokens, Discord webhook URLs and JWT-shaped tokens.
- Only the websocket calls and the one HTTP call whose type accepts credentials (`screener`) receive them. `search`, `hotlist` and `technical` are sent without credentials, because their option types do not declare them.
- One runtime dependency, pinned exactly, with lockfile. Installs use `--ignore-scripts`.
- Read-only. There are no methods for orders, watchlist changes or account changes.
- Tests use fake values and a fake library. They make no network calls.

## Watcher

`watcher.mjs` is a standalone process for a Raspberry Pi that is always on. It streams live candles for a watchlist with your TradingView account, checks rules when each candle **closes**, runs a "what's trending" scan, and sends alerts to Discord and/or Telegram. It does not need the MCP server or Claude, and **it never places trades**.

### Raspberry Pi setup

`bash scripts/pi-setup.sh` does steps 1 to 5 below for you (including a random `WATCHER_LOCAL_TOKEN`, which turns on `/health`) (and `--enable` does step 6; `--pine` and `--images` add the optional Pyne and chart-picture pieces). It is safe to re-run and never prints secret values. The manual steps stay here for reference.

1. Use Raspberry Pi OS (64-bit) with Node 22, installed system-wide from NodeSource (the apt `nodejs` package on Bookworm is Node 18). Check with `node -v` and `command -v node`. The unit runs `/usr/bin/node`, so with nvm or any other path, edit `ExecStart=` to match, or the service fails with `203/EXEC` and restarts every 10 seconds.
2. Clone the repo and install the bridge dependencies. `--ignore-scripts` is required:
   ```sh
   git clone <repo> ~/code/tradingview-mcp
   cd ~/code/tradingview-mcp/bridge && npm ci --ignore-scripts
   ```
3. Create the secrets file from the names-only template. Make it readable only by `pi`. systemd reads `EnvironmentFile` as root before it drops privileges, so this works for the service too:
   ```sh
   sudo cp watcher.env.example /etc/tradingview-watcher.env
   sudo nano /etc/tradingview-watcher.env      # fill in the values
   sudo chown pi:pi /etc/tradingview-watcher.env
   sudo chmod 600 /etc/tradingview-watcher.env
   ```
4. Create the config and check it. `--check-config` prints `OK`, or every problem:
   ```sh
   mkdir -p ~/.config/tradingview-watcher ~/.local/state/tradingview-watcher   # the state dir must exist: the unit makes only it writable
   cp watcher.config.example.json ~/.config/tradingview-watcher/config.json
   node watcher.mjs --config ~/.config/tradingview-watcher/config.json --check-config
   ```
5. Load the secrets into this shell only, then test the channels. `--test-notify` sends one message to each configured channel:
   ```sh
   set -a; . /etc/tradingview-watcher.env; set +a
   node watcher.mjs --config ~/.config/tradingview-watcher/config.json --test-notify
   ```
   To see alerts without sending them, run the same command with `--dry-run` in place of `--test-notify`.
6. Install and start the service. The unit is in `watcher.service.example`:
   ```sh
   sudo cp watcher.service.example /etc/systemd/system/tradingview-watcher.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now tradingview-watcher
   journalctl -u tradingview-watcher -f
   ```

The unit runs as `pi`, reads the env file through `EnvironmentFile=`, restarts after any unexpected exit (10 seconds later; `systemctl stop` stays stopped), caps memory at 512 MB (see below), waits for the clock sync (see below), and uses `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only` and `PrivateTmp`. Its only writable path is the state directory.

**Clock sync.** The unit has `Wants=` and `After=` on `systemd-time-wait-sync.service`, so starting the watcher pulls that service in even if it is not enabled; no extra `enable` step is needed. That service only blocks until the clock is synchronized when `systemd-timesyncd` is the time daemon (the default on Raspberry Pi OS, as far as I know; check with `systemctl is-active systemd-timesyncd`). With chrony or ntpd it falls back to the kernel sync flag, which systemd calls unreliable; use chrony's own wait service there instead. The wait has no timeout, so with no network at boot the watcher stays in "activating" until the clock syncs. That is intended: it cannot send alerts without a network anyway.

**Memory cap.** `MemoryMax=` is silently ignored when the kernel's memory cgroup is off, which is the case on some Raspberry Pi OS kernels unless `cgroup_enable=memory cgroup_memory=1` is in `/boot/firmware/cmdline.txt` (`/boot/cmdline.txt` on older releases). Check after starting: `cat /sys/fs/cgroup/system.slice/tradingview-watcher.service/memory.max` should print `536870912`.

**Logs.** journald keeps logs across reboots only if `/var/log/journal` exists, or if `Storage=persistent` is set in `/etc/systemd/journald.conf`. To limit wear on the SD card, set `SystemMaxUse=50M` under `[Journal]` in that file, then run `sudo systemctl restart systemd-journald`.

### Discord webhook

1. In Discord, open the channel's settings, then **Integrations**, then **Webhooks**, and choose **New Webhook**.
2. Copy the webhook URL into `DISCORD_WEBHOOK_URL` in the env file.

### Telegram bot

1. In Telegram, open a chat with **@BotFather**, send `/newbot`, and follow the prompts. Copy the token into `TELEGRAM_BOT_TOKEN`.
2. Send any message to your new bot from your own account.
3. Open this URL in your own browser (it is a secret, so do not paste it anywhere else):
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   Find `"chat":{"id": ...}` in the reply and copy that number into `TELEGRAM_CHAT_ID`.

### Command line

```
node bridge/watcher.mjs --config <path> [--check-config] [--test-notify] [--dry-run] [--once] [--log-json]
```

| Flag | Effect |
|---|---|
| `--config <path>` | Required. The JSON config file. `~` expands to your home directory. |
| `--check-config` | Validates the config and the env names, then prints `OK` (exit 0) or every problem (exit 1). |
| `--test-notify` | Sends "✅ tradingview watcher test" to each configured channel and prints `ok` or `failed` for each (exit 0 only if all succeed). |
| `--dry-run` | Runs the whole watcher, but prints alerts to stdout instead of sending them. Saves no state. |
| `--once` | Runs one trending scan, prints the rows of every market and kind, and exits. No streams, no alerts, no state. |
| `--log-json` | Writes log lines as JSON, one object per line. |

Logs go to stderr. Every line is redacted. A disconnect is logged with its time, and the count is in `GET /health`.

### Config

`watcher.config.example.json` is the reference. Validation reports every problem with its JSON path, for example `watchlist[1].timeframes[0]: "7" is not an allowed timeframe`.

- `timezone`: an IANA name. Quiet hours, the heartbeat and bar times use it. Default `UTC`.
- `watchlist`: each entry has a `symbol` (`EXCHANGE:SYMBOL`), `timeframes` (from `1, 3, 5, 15, 30, 45, 60, 120, 180, 240, D, W, M`) and an optional `market` (`crypto` or `stock`). Crypto exchanges (BINANCE, BYBIT, COINBASE, KUCOIN, OKX, BITGET, MEXC, GATEIO, HUOBI, BITFINEX, KRAKEN, BITSTAMP) default to `crypto`, and everything else to `stock`.
- `rules`: each rule has an `id` and a `type`. It applies to every stream unless it names a `symbol` and/or `timeframes`.

| Type | Fires when (on a closed bar) |
|---|---|
| `pct_move` | the close is `threshold_pct` or more away from the close `bars` bars earlier |
| `volume_spike` | volume is at least `multiple` times the average of the prior `lookback` bars |
| `rsi_cross` | RSI (Wilder, `period`) rises through or falls through one of `levels` |
| `bollinger_break` | the close is above the upper band or below the lower band (`period`, `stddev`) |
| `new_extreme` | the close is above the highest high, or below the lowest low, of the prior `lookback` bars |
| `price_cross` | the close crosses `level` (up when it goes from below to at or above, down the reverse) |
| `all_of` | every rule in `rules` (2 to 10 ids of other rules) fires on the same closed bar, all in the same direction |
| `any_of` | at least one rule in `rules` fires on the bar; one alert per direction that has a hit |

- `all_of` / `any_of` combine rules into one alert. The alert lists each member's message (`rsi: ... | volspike: ...`), and its values are named `ruleId.valueName`. Members must be plain rules: a composite inside a composite is an error, which also rules out cycles. Members may be defined after the composite. Each member keeps its own `symbol` and `timeframes`, so an `all_of` fires only on streams every member applies to, and `--check-config` reports an `all_of` whose members never share a watched stream (or an `any_of` where none apply) as a rule that could never fire. A composite takes the same optional keys as any rule (`symbol`, `timeframes`, `max_per_day`, `expires`, `calendar`), which apply to the composite itself. A member's own `expires` and `calendar` still count inside a composite: an expired or out-of-session member cannot hit, so it blocks an `all_of` and is left out of an `any_of`. A member's `max_per_day` does not apply to the composite (the composite has its own). **Members stay active as ordinary rules**, so a bar that trips both members sends their two alerts and the combined one; there is no way to silence a member yet. The direction is part of the cooldown, so an up signal does not block a later down signal.

- Optional on every rule: `max_per_day` (1 to 1000) and `expires` (`YYYY-MM-DD`). `max_per_day` caps the rule's alerts per local calendar day in `timezone`, counted across all its symbols and timeframes. Alerts that pass the duplicate and cooldown checks use it up (sent, put in a summary, or held for quiet hours when `digest_after_quiet` is on; held alerts that will be dropped do not count); over the cap an alert is dropped with a log line, not added to a summary. Health alerts are never capped. `expires` is the rule's last day, in `timezone`. After it the rule is skipped, and `--check-config` warns (but still prints `OK`) about a rule that has already expired.
- Optional on every rule: `calendar`, `"any"` (the default) or `"us_session"`. `us_session` lets the rule fire only while the US market is in its regular session: Monday to Friday 09:30 to 16:00 New York, not on a holiday, and until 13:00 on an early-close day. It uses the lists in `health.us_holidays` and `health.us_early_closes`, which default to the NYSE calendar through 2027. A bar counts as in session when it opens in session (the 15:45 bar is the last one in), judged by the bar's own time, so a late delivery does not drop it. It is judged by time, not by symbol, so a crypto rule with `us_session` fires only during US hours. It needs intraday timeframes: if the rule could match a `D`, `W` or `M` stream, set `timeframes` on the rule or `--check-config` reports an error. `--check-config` also warns when the holiday list has no date 30 or more days ahead, so add next year's dates before it runs out.
- `trending`: `enabled`, `every_minutes` (at least 5), `markets`, `kinds` (`gainers`, `losers`, `mostActive`, `volumeGainers`), `top_n` (up to 200), `us_regular_hours_only` (skip `america` outside 09:30 to 16:00 New York time, Monday to Friday) and `remember_hours`. An alert fires only for a symbol that was not in that market and kind's list within `remember_hours`.
- `alerts`: `cooldown_minutes` (per symbol, timeframe and rule), `max_per_hour` (the rest go into a summary), `quiet_hours` (`start` and `end`, `HH:MM`, may cross midnight), `digest_after_quiet` (send one summary when quiet hours end, or drop the held alerts).
- `health`: `stream_down_minutes` and `daily_heartbeat` (`HH:MM`, or `null` to turn it off).
- `state_dir`: where `state.json` lives. Writes are atomic.
- `local_api`: `enabled` and `port` (1024 to 65535). The API listens on `127.0.0.1` only.
- `images`: `enabled` (default `false`), `chromium_path`, `max_per_hour` (1 to 60, default 6) and `timeout_ms` (1000 to 60000, default 10000). See "Chart images on alerts".
- `limits.max_streams`: the number of symbol x timeframe streams (at most 25, the hard cap).

### Local API

Enabled when `local_api.enabled` is on **and** `WATCHER_LOCAL_TOKEN` is set. It listens on `127.0.0.1` only.

- `POST /notify` with `Authorization: Bearer <WATCHER_LOCAL_TOKEN>` and a JSON body `{"title", "body", "key", "level": "info"|"up"|"down"}` (body up to 8 KB). Returns `202`, `400` for a bad body, or `401` for a bad token. The message goes through the same alert rules.
- `GET /health` needs no token. It returns `{ok, streams: {healthy, total}, uptime_s, disconnects}` and no secrets.

### Dashboard

A read-only web page served by the watcher process: a candlestick chart per watched stream with your alerts, price levels (from `price_cross` rules) and paper-trade entries and exits on it, the recent alerts, and stream health. It updates live. It never calls TradingView, never writes anything and cannot place a trade. Configure it with `dashboard` in the config: `enabled` (default `true`), `host` (default `127.0.0.1`) and `port` (default `8788`, 1024 to 65535, and not the `local_api` port).

On the Pi, reach it through an SSH tunnel from the machine with the browser:

```bash
ssh -N -L 8788:127.0.0.1:8788 pi@raspberrypi.local
```

Then open `http://localhost:8788/`. On a loopback bind no token is needed; the server only accepts a `Host` header naming `localhost`, `127.0.0.1` or `[::1]` (any port, so the tunnel works), which stops a web page from reaching it through DNS rebinding. **The tunnel is the recommended setup.**

If you bind to another address, set `WATCHER_DASHBOARD_TOKEN` to a secret of at least 16 characters, or the dashboard refuses to start (the watcher keeps running and logs why). Open the page once as `http://<pi>:8788/?token=<secret>`; the server stores it in a cookie and redirects to the same URL without the token. Known limit: the `tvw_dash` cookie has `Path=/` and no port scope, so on a non-loopback bind any other HTTP service on the same host also receives it, and traffic is plain HTTP. Prefer the tunnel over this.

At most 5 browser tabs can receive live updates at once; a sixth shows "Live updates off, retrying" and tries again every 15 seconds. A stream is tagged "Stale" when its newest bar is older than three bar periods, so a stock stream shows it overnight and at weekends; the page does not know the market calendar.

The page loads only its own files (no inline script or style, no outside requests), so the strict Content-Security-Policy holds. The chart is TradingView Lightweight Charts; its attribution is in the page footer. Without JavaScript the page shows a plain message. If the dashboard port is taken, the watcher logs it and runs without the dashboard.

#### Obsidian notes on the chart

Notes you keep in Obsidian (news, an opportunity, a risk) can show on a stream's chart as small blue circles (N news, O opportunity, R risk, N plain note) at the candle they relate to, and in a "Notes" panel. Clicking a note opens it in Obsidian. It is **off by default** because it needs a folder:

```json
"dashboard": {"notes": {"enabled": true, "dir": "~/notes/markets", "vault": "ObsidianVault", "vault_folder": "markets"}}
```

`dir` is the real folder on the machine running the watcher (an absolute path, `~` allowed). `vault` is the vault's name in Obsidian and `vault_folder` is the same folder as seen from the vault's root; both are used only to build `obsidian://` links. A note is shown only if it is a `.md` file **directly** in `dir` (subfolders are not read) and its properties have `symbols`:

```
---
symbols: [BINANCE:BTCUSDT]    # or the block list Obsidian writes; a ticker alone (BTCUSDT) also matches
time: 2026-10-12T14:30:00Z    # optional. A date alone means the end of that UTC day; no zone means UTC
kind: news                    # news, opportunity or risk; anything else shows as "note"
---
# The title is the first "# " heading, else the file name
Body text. Only an excerpt of about 280 characters is sent to the page.
```

A note with no `time` appears only in the panel. A marker sits on the last bar at or before `time`; a note older than the loaded candles has no marker. Click a candle, then "Add note here", to open a pre-filled new note in Obsidian (the file name has no `:` because Obsidian forbids it, so `BINANCE:BTCUSDT` becomes `BINANCE-BTCUSDT`). A link such as `http://localhost:8788/?symbol=BINANCE:BTCUSDT&tf=60&t=<unix seconds>` opens that stream with the chart centred on `t`; paste one into a note to link back to the chart.

What it does and does not do: the watcher only reads that one folder, never writes into your vault, and nothing in a request picks a file. Symlinks, other file types and notes without `symbols` are never read, at most the newest 500 files are looked at, only the first 16 KB of each is read, and the result is cached for 30 seconds. `obsidian://` links only work in a browser on a machine with Obsidian installed (your PC, directly or through the tunnel), not on the Pi's own screen.

**Getting the vault to the Pi** is not built in. If the watcher runs on the Pi and the vault is on your PC, the `markets` folder has to exist on the Pi: the boring options are Syncthing sending only that folder one way (send only on the PC), or a `git pull` timer on the Pi. If you run the watcher in WSL on the PC, point `dir` at the vault folder (under `/mnt/c/...`, slower to read, which the cache hides).

#### Tabs and panels

The page has five tabs: **Overview** (one card per stream with the last price, change, a sparkline and its health), **Chart** (the chart, its alerts and notes), **Alerts** (the stored history with filters for rule, symbol and status, and a count per rule per day; click one for the detail drawer with its numbers, "copy chart link" and "add note"), **Opportunities** (what the trending scan saw lately, within `remember_hours`) and **Status** (watcher health, paper-trade equity of realised exits only, gauntlet reports). The header shows the market clock, whether TradingView login cookies are set (not that they are still valid) or the watcher is anonymous, and live or reconnecting; the tab title shows `(2)` when alerts arrive while the tab is hidden. "Save chart as PNG" downloads the chart.

"What the rules see" (Chart tab) draws the RSI and Bollinger lines of your `rsi_cross` and `bollinger_break` rules. The numbers come from the watcher (the same code the rules use), never from the browser, so the lines cannot disagree with the alerts. Rules inside an `all_of` / `any_of` are not drawn.

#### Rule noise preview

On the Chart tab, "Rule noise preview" lets you pick one rule and see small grey arrows where it **would have fired** over the last closed bars (up to 299: the watcher holds 300 candles and one is still forming), with a count. Use it to tune a threshold before it spams you. What it is and is not:

- It runs the real rule code on each past bar, behind the same gates as the watcher (`expires`, `calendar: us_session`, members of `all_of` / `any_of`; the session is judged from each bar's own open time). A rule needs history first, so the oldest bars (its own minimum, five periods for RSI, the slowest member for a composite) are not judged and not counted. Close to that edge an RSI bar can differ a little from what the watcher saw.
- It shows **signals**, not alerts: cooldowns, `max_per_day`, `max_per_hour` and quiet hours depend on what was actually sent, so they are not applied and the alerts really sent would be the same or fewer.
- It is not a prediction and says nothing about whether acting on a signal would have made or lost money.
- Only the bars the watcher holds in memory are looked at, so a stream just started shows fewer than 300. Only live rules that apply to the stream are offered; a composite is previewed as a whole.
- It costs about 25 ms of CPU per rule at 400 bars (65 ms for a composite at 1000), done once per rule per closed bar and kept until the next bar closes; it is read-only like the rest of the dashboard. The chart library cannot draw hollow markers, so they are small and grey instead.

### Chart images on alerts

Off by default. When on, a rule alert on Discord or Telegram carries a PNG of the chart: the last 120 candles the watcher holds, an arrow on the alert's bar, and the rule's price level when it has one (`price_cross` level, `new_extreme` high or low, the Bollinger band that was broken; other rules and `all_of` / `any_of` have no single level, so only the arrow). Trending, health and heartbeat messages never get a picture.

To turn it on:

1. Install a browser. On the Pi: `sudo apt install chromium` (the path is `/usr/bin/chromium`). Nothing is downloaded by this project: `playwright-core` is only the remote control, and `npm install` is run with `--ignore-scripts`.
2. Set `"images": {"enabled": true, "chromium_path": "/usr/bin/chromium"}` in the config, or put the path in `WATCHER_CHROMIUM_PATH` (the environment wins).
3. The dashboard must be enabled: the picture is made by opening the dashboard's own `/render` page, so there is no second server.

If images are on but cannot work (no browser path, a relative path, the dashboard off), the watcher logs `images disabled: <reason>` once and runs without them.

How it behaves:

- **The browser is started when an alert needs a picture and closed after 30 seconds idle.** One Chromium measured about 360 MB (proportional memory, 11 processes) after one render on an x86 desktop with Chrome; measure it on the Pi before leaving this on, because the Pi budget is about 3 GB for everything. A render took about 1.5 s on that desktop. Pi speed and Pi memory have not been measured yet.
- One picture is made per alert and shared by Discord and Telegram, and a retry does not render again. At most `max_per_hour` pictures an hour; `timeout_ms` covers start-up, loading and the screenshot. Failed renders count toward the hour.
- **When a picture cannot be made** (cap, timeout, browser missing or crashed) the alert is sent as the usual text plus a line `Chart: <dashboard link>` that opens the dashboard on that bar, and the reason is logged. With `127.0.0.1` that link works through the SSH tunnel only. A render holds its own alert for at most `timeout_ms`, counted from when it starts; renders run one at a time, so in a burst an alert can also wait for the renders ahead of it. An alert is never dropped because of a picture. When images are off, alerts are unchanged.
- Discord gets the picture as an attachment in the embed. Telegram gets it as a photo with the alert text as the caption; Telegram allows 1024 characters of visible text in a caption (tags and link addresses do not count), so a longer alert is sent as a plain message without the picture instead of being cut. If Discord or Telegram refuses the picture itself (HTTP 400 or 413, for example a chat where the bot may not send photos), the same alert is sent again as text, so it is not lost; a server error or rate limit is retried as usual.
- A `WATCHER_DASHBOARD_TOKEN` goes in a request header, never in a URL. Every page request the renderer can see is checked against the dashboard's address and aborted if it goes anywhere else, and service workers are blocked. Chromium runs **with its sandbox**, except when the watcher runs as root (a container, a root service), where Chromium refuses to start with it and the sandbox is turned off; the example service runs as user `pi`. If the sandbox cannot start (some containers and kernels have no user namespaces) the render fails, the log says why and the alerts go out as text.
- The picture is always the light theme and carries the Lightweight Charts credit line.
- Try it once by hand: run the tests with `WATCHER_TEST_CHROMIUM=/usr/bin/chromium npm test --prefix bridge`; two extra tests then make a real PNG.

### Open question for live testing

It is not known whether TradingView drops one of two websockets that use the same cookie (for example, the watcher on the Pi and the desktop MCP at the same time). Watch `disconnects` in `/health` and the `disconnected at` log lines, and record what you see.

## Development

```sh
cd bridge
npm test
echo '{"id":1,"method":"health"}' | node server.mjs
```

`server.mjs` exports `createServer({lib, env, input, output, log})`. Tests pass a fake `lib` object and an array writer, so no network is used.

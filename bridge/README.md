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

## Development

```sh
cd bridge
npm test
echo '{"id":1,"method":"health"}' | node server.mjs
```

`server.mjs` exports `createServer({lib, env, input, output, log})`. Tests pass a fake `lib` object and an array writer, so no network is used.

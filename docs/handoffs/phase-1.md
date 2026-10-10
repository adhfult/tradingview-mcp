# Phase 1: Node bridge (`bridge/`)

## Brief (Opus)

**Goal:** a small Node process that wraps the npm library `@mathieuc/tradingview` **4.0.0** and speaks newline-delimited JSON-RPC over stdin/stdout. The Python server will start it in Phase 2. It is read-only market data: no orders and no account changes.

**Master plan:** §7 (and §2 for the verified library interface).

### Rules (read before starting)
- Work only inside `bridge/`, plus this handoff file. Don't touch Python code.
- **Never guess the library's interface.** After `npm install`, read the type files under `bridge/node_modules/@mathieuc/tradingview/dist/` (`data/index.d.ts`, `data/candles.d.ts`, `data/quotes.d.ts`, `data/indicators.d.ts`, `data/operation.d.ts`, `http/market.d.ts`, `http/screener.d.ts`, `http/watchlists.d.ts`, `errors.d.ts`, `client/client.d.ts`). The facts below were checked against those files. If they differ, stop and report.
- **Supply chain:**
  - the only dependency is `"@mathieuc/tradingview": "4.0.0"` (exact)
  - install with `npm install --ignore-scripts --save-exact`
  - commit `package-lock.json`
  - check that `npm ls` shows `@mathieuc/tradingview@4.0.0` and `ws`, and that the lockfile `resolved` URLs are `https://registry.npmjs.org/...`
- **Tests must not touch the network.** Inject a fake library, as described below.
- Node 22 is installed. Use only built-ins besides the one dependency: `node:test`, `node:assert`, `node:readline`, `node:stream`.
- **No secrets** in code, tests or logs.
- Don't commit or push.

### Verified library facts (from the installed `.d.ts` files of 4.0.0)
- **Imports:**
  - `import { getCandles, getQuotes, getIndicatorData, searchMarkets, getSymbolInfo, getScreener, getHotlist, getTechnicalAnalysis, summarizeStrategyReport, TradingViewError } from '@mathieuc/tradingview/data'`
  - `import { TradingViewClient } from '@mathieuc/tradingview'`. Check this export exists in `dist/index.d.ts`, and report it if it doesn't.
- **`getCandles(query)`:**
  - `query` = `{symbol, timeframe?, count?, from?, to?, maxCount?, timeoutMs?, client?, credentials?}`
  - returns `Candle[]`, oldest first, where `Candle = {time (bar open, unix seconds), open, high, low, close, volume}`
- **`getQuotes({symbols, fields?, timeoutMs?, client?})`** returns `Record<string, QuoteData>`.
- **`getIndicatorData({symbol, timeframe?, indicator, inputs?, count?, timeoutMs?, client?})`** returns `{indicator, candles, values: [{$time, ...plots}], graphics, strategyReport}`.
- **`searchMarkets(query, {type?})`** returns `[{id, exchange, fullExchange, symbol, ...}]`. These HTTP functions take `{credentials?}` options, not `client`.
- **`getScreener({market?, columns, filter?, sort?, range?}, {credentials?})`** and **`getHotlist({kind, market?, range?}, {credentials?})`** return `{totalCount, rows: [{symbol, values}]}`. `kind` is one of `gainers`, `losers`, `mostActive`, `volumeGainers`.
- **`getTechnicalAnalysis(symbol, opts?)`** returns a rating object or `null`.
- **`getSymbolInfo(...)`:** read its `.d.ts` for the exact query shape.
- **`new TradingViewClient({credentials})`;** `await client.close()`.
- **`credentials` = `{session, signature}`.**
- **`TradingViewError.code`** is one of: `PROTOCOL_ERROR`, `CONNECTION_ERROR`, `DISCONNECTED`, `AUTH_ERROR`, `SYMBOL_ERROR`, `SERIES_ERROR`, `CRITICAL_ERROR`, `STUDY_ERROR`, `QUOTE_ERROR`, `PARSE_ERROR`, `INVALID_STATE`, `INVALID_ARGUMENT`, `HTTP_ERROR`, `NOT_FOUND`, `NO_DATA`, `TIMEOUT`, `ABORTED`, `CALLBACK_ERROR`.

### Files to create
- `bridge/package.json`:
  - `{"name":"tradingview-mcp-bridge","version":"0.1.0","private":true,"type":"module","engines":{"node":">=20"}}`
  - scripts: `{"test":"node --test"}`
  - dependencies: `{"@mathieuc/tradingview":"4.0.0"}`
- `bridge/package-lock.json` (generated)
- `bridge/.npmrc`: `ignore-scripts=true`, `save-exact=true`, `fund=false`, `audit=true`
- `bridge/.gitignore`: `node_modules/`
- `bridge/lib/redact.mjs`
- `bridge/lib/errors.mjs`
- `bridge/lib/semaphore.mjs`
- `bridge/lib/validate.mjs`
- `bridge/server.mjs`
- `bridge/test/*.test.mjs`
- `bridge/README.md`

### `lib/redact.mjs`
- `SECRET_ENV_VARS`: `TRADINGVIEW_SESSION_ID`, `TRADINGVIEW_SESSION_SIGN`, `DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `WATCHER_DASHBOARD_TOKEN`, `WATCHER_LOCAL_TOKEN`.
- `makeRedactor(env = process.env)` returns `(text) => string`. It replaces:
  - every non-empty value (at least 4 characters) of those variables
  - plus these patterns:
    - `/sessionid(_sign)?=[^;\s]+/gi` becomes `sessionid$1=[REDACTED]`
    - `/bot\d+:[A-Za-z0-9_-]+/g` becomes `bot[REDACTED]`
    - `/https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\S+/gi` becomes `[REDACTED_WEBHOOK]`
- Safe on non-strings: coerce with `String()`.

### `lib/errors.mjs`
`toBridgeError(err, redact)` returns `{code, message}` with a **redacted** message:

| Library `err.code` | Bridge code |
|---|---|
| `SYMBOL_ERROR`, `NOT_FOUND` | `SYMBOL_NOT_FOUND` |
| `TIMEOUT` | `TIMEOUT` |
| `AUTH_ERROR` | `AUTH_FAILED` |
| `SERIES_ERROR`, `STUDY_ERROR`, `CRITICAL_ERROR` | `PERMISSION_OR_SERIES` |
| `HTTP_ERROR` whose message or details mention `429` | `RATE_LIMITED` |
| `CONNECTION_ERROR`, `DISCONNECTED`, `PROTOCOL_ERROR` | `UPSTREAM_UNAVAILABLE` |
| `INVALID_ARGUMENT` | `INVALID_PARAMETER` |
| `NO_DATA` | `NO_DATA` |
| our own validation errors | `INVALID_PARAMETER` |
| anything else | `UPSTREAM_ERROR` |

Also export `isConnectionError(code)`, true for `CONNECTION_ERROR`, `DISCONNECTED` and `PROTOCOL_ERROR`.

### `lib/semaphore.mjs`
`createSemaphore(max)` returns `{ run(fn) }`, which runs at most `max` async functions at once (FIFO queue).

### `lib/validate.mjs`
Validation helpers that throw `{bridgeCode: 'INVALID_PARAMETER', message}`:
- **symbol:** a string, upper-cased, matching `/^[A-Z0-9_.!:\-]{1,40}$/`
- **timeframe:** one of `1, 3, 5, 15, 30, 45, 60, 120, 180, 240, D, W, M, 1D, 1W, 1M`
- **integers** with ranges; arrays with max length; plain objects only

### `server.mjs`
- **Exports** `createServer({ lib, env = process.env, input = process.stdin, output = process.stdout, log = (s)=>process.stderr.write(s+'\n') })`, which returns `{ handleLine(line): Promise<void>, close(): Promise<void> }`.
  - `lib` is an object with the library functions plus `TradingViewClient`.
  - The real entry point (`if (import.meta.url === pathToFileURL(process.argv[1]).href)`):
    - **first** routes `console.log`, `console.info` and `console.debug` to stderr
    - dynamically imports the real library and builds `lib`
    - calls `createServer`
    - reads stdin line by line with `node:readline`
- **Protocol:**
  - each input line is JSON `{id, method, params}`
  - write exactly one output line per request: `{"id":…,"result":…}` or `{"id":…,"error":{"code","message"}}`, followed by `\n`
  - bad JSON gets `{"id":null,"error":{"code":"INVALID_PARAMETER","message":"invalid JSON"}}`
  - requests run concurrently, so responses may come back out of order
- **Credentials:** if both `TRADINGVIEW_SESSION_ID` and `TRADINGVIEW_SESSION_SIGN` are non-empty, use `{session, signature}`; otherwise none, meaning anonymous.
- **Shared client:**
  - Create lazily with `new lib.TradingViewClient(credentials ? {credentials} : {})`. Pass `client` to every websocket-based call (`getCandles`, `getQuotes`, `getIndicatorData`, `getSymbolInfo` if its type allows).
  - Pass `{credentials}` to the HTTP-based calls (`searchMarkets`, `getScreener`, `getHotlist`, `getTechnicalAnalysis`) where their type accepts it.
  - If an error's code is a connection error (`isConnectionError`), `close()` the client, ignoring errors, and set it to `null` so the next call creates a new one.
- **Limits:**
  - semaphore with `Number(env.TRADINGVIEW_BRIDGE_MAX_INFLIGHT) || 2`, capped at 1..8
  - `timeoutMs` param defaults to 15000 and is clamped to 1000..60000
- **Methods** (validate every parameter):

| Method | Params | Call | Result |
|---|---|---|---|
| `health` | – | none | `{ok:true, libVersion:"4.0.0" (read from the installed package.json via createRequire or fs), node: process.version, hasCredentials: bool}` |
| `candles` | `symbol, timeframe='D'`, either `count` (1..5000, default 300) **or** `from` (unix seconds, plus optional `to` and `maxCount` 1..20000) | `getCandles({...})` | array of `{time, open, high, low, close, volume}` |
| `quotes` | `symbols` (1..50) | `getQuotes({symbols, client, timeoutMs})` | the record as returned |
| `indicator` | `symbol, timeframe='D', indicator` (non-empty string ≤ 200 chars), `inputs` (plain object, optional), `count` (1..500, default 100) | `getIndicatorData(...)` | `{name: <indicator description/name if present>, values: last count values mapped to {time: v.$time, ...rest}, strategy: data.strategyReport ? safe(summarizeStrategyReport(data.strategyReport)) : null}` |
| `search` | `query` (1..60 chars), `type` (optional string) | `searchMarkets(query, {type, credentials})` | first 20 as `{id, symbol, exchange, fullExchange, type, description}` (missing fields fine) |
| `symbol_info` | `symbol` | `getSymbolInfo(...)` | pick only primitive top-level fields (string, number, boolean), at most 40 keys |
| `screener` | `market` (string), `columns` (1..20 strings), `filter`, `sort`, `range` (`[a, b]` with 0 ≤ a < b ≤ 200) | `getScreener(...)` | `{totalCount, rows}` |
| `hotlist` | `kind` (one of the four), `market` (optional string), `range` (as above) | `getHotlist(...)` | `{totalCount, rows}` |
| `technical` | `symbol` | `getTechnicalAnalysis(symbol, {credentials})` | result or `null` |

  `safe()` means: ignore errors, so a summary failure returns `null`. An unknown method gets `INVALID_PARAMETER`.
- **Errors:** every error goes through `toBridgeError` with the redactor. Log the redacted message to `log`. **Never write anything but protocol lines to `output`.**
- **Shutdown:** `close()` closes the client. The entry point calls it on stdin `close`, `SIGTERM` and `SIGINT`, then `process.exit(0)`. On `unhandledRejection`, log it redacted and `process.exit(1)`.

### Tests (`bridge/test/`, `node --test`, fake `lib` only)
Build a fake `lib` whose functions record their arguments and return canned data or throw `Object.assign(new Error('x'), {code: 'TIMEOUT'})`-style errors. Feed lines to `handleLine` and capture `output` with a `PassThrough` or an array writer. Cover:
1. `health` shape. `hasCredentials` is true only when both env vars are set; use a fake `env` object, never real values.
2. `candles` with `count`, and with `from`/`to`; validation errors (bad symbol, bad timeframe, `count` 0 or 5001) give `INVALID_PARAMETER`.
3. The `client` is passed to `getCandles`, and `credentials` to `searchMarkets`.
4. Two concurrent requests where the first resolves later: two lines out, matched by `id`.
5. Every row of the error-mapping table.
6. **Redaction:** a fake error whose message contains the fake session value, `sessionid=abc123;`, a `bot123456:ABC-def` token and a Discord webhook URL. The output message contains none of them.
7. Bad JSON gives the `id:null` error. An unknown method gives `INVALID_PARAMETER`.
8. Semaphore: with max 2, a third call waits.
9. After a `DISCONNECTED` error, the next call constructs a new `TradingViewClient` (count constructor calls).
10. `close()` calls `client.close()`.
11. `indicator`: values are mapped to `{time, ...}` and limited to `count`.

### `bridge/README.md`
- what it is
- install (`npm ci --ignore-scripts`)
- the protocol and its methods
- environment variables
- security notes: cookies only from env, redaction, one dependency, read-only

### Acceptance
- `cd bridge && npm ci --ignore-scripts && npm test` passes.
- `echo '{"id":1,"method":"health"}' | node bridge/server.mjs` prints exactly one JSON line with `ok:true` and exits when stdin closes. This is safe offline because `health` doesn't touch the network.
- `uv run pytest tests/unit -q` is still green (untouched).
- `git status` shows only `bridge/**` and this file changed.

### Report format (append under "## Implementation report (Haiku)")
- files created
- the `npm ls` output
- any `.d.ts` mismatches with this brief
- the real last lines of `npm test` output
- the real output of the `health` echo command

# Use your TradingView account (optional)

This page explains the optional TradingView session cookies. You do not need them. The server works without them, using public data.

With the cookies set, the server uses your TradingView account for:

- the `tv_*` tools (`tv_status`, `tv_candles`, `tv_quotes`, `tv_indicator`, `tv_symbol_search`, `tv_hotlist`)
- the screener and futures scanner requests (set `TRADINGVIEW_MCP_SCANNER_USE_SESSION=0` to stop this)
- TradingView candles in backtests (`data_source="tradingview"` with `tv_symbol`)

The `tradingview_ta` calls always stay anonymous. That library cannot send cookies.

## What the cookies are

TradingView sets two cookies when you log in on its website:

- `sessionid`
- `sessionid_sign`

Together they prove that a request comes from your logged-in browser. Treat them like a password. Anyone who has them can act as you on TradingView.

## How to copy them

1. Log in at https://www.tradingview.com in your browser.
2. Open the browser developer tools (F12, or right-click and choose Inspect).
3. Open the **Application** tab in Chrome or Edge (**Storage** in Firefox).
4. Under **Cookies**, choose `https://www.tradingview.com`.
5. Copy the **Value** of `sessionid` and the **Value** of `sessionid_sign`.

## Where to put them

Put them in a `.env` file in the repository root. The file is gitignored.

```bash
cp .env.example .env
# then edit .env and fill in:
# TRADINGVIEW_SESSION_ID=...
# TRADINGVIEW_SESSION_SIGN=...
```

You can also set them as environment variables. For Docker, pass the file at run time. Do not put the values in the image:

```bash
docker run --env-file .env ...
```

To use a file in another place, set `TRADINGVIEW_ENV_FILE=/path/to/file`.

The server reads the cookies once, when it starts. After you change `.env`, restart the MCP server. Restarting only the bridge keeps the old values.

**Never paste the cookies into a chat, an issue, a commit, a screenshot or a log.** The server redacts them from its own logs and errors. That is a safety net, not a reason to share them.

## Risks

- This is your real account. Any action taken with the cookies is taken as you.
- Automated use can break TradingView's terms of use. You are responsible for your own use.
- Keep the traffic low. The bridge allows 2 calls at a time by default (`TRADINGVIEW_BRIDGE_MAX_INFLIGHT`). Do not raise it without a reason.
- The bridge is read-only. It places no orders and changes nothing on your account.

## Check the data delay

Open AAPL on https://www.tradingview.com while you are logged in. The chart's market data notice shows whether the data is real-time or delayed for your plan. Your plan decides this, not this server. Check the delay on the chart before you rely on a `tv_*` quote.

## Check the setup

Call `tv_status`. It reports whether the bridge is configured and whether cookies are present. It never shows their values.

`tv_status` does not check that the cookies are still valid. If a TradingView call returns `AUTH_FAILED`, the cookies have expired or been revoked. Copy fresh values into `.env` and restart the MCP server.

After an `AUTH_FAILED`, the bridge waits 60 seconds before it tries to connect again. Do not retry in a loop. Fix the cookies first.

## Revoke them

Log out of all sessions in your TradingView account settings. That invalidates the cookies. Then delete the two lines from `.env`.

## Node.js

The `tv_*` tools need Node.js 20 or newer on the host, and the bridge's dependencies installed once:

```bash
cd bridge
npm ci --ignore-scripts
```

The Docker image already includes Node and the bridge. It does not include your cookies.

More detail on the bridge is in [bridge/README.md](../bridge/README.md).

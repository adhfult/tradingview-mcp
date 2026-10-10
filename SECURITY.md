# Security Policy

## Supported Versions

Only the latest minor release receives security fixes.

| Version | Supported          |
| ------- | ------------------ |
| 0.10.x  | :white_check_mark: |
| < 0.10  | :x:                |

## Reporting a Vulnerability

Please report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/atilaahmettaner/tradingview-mcp/security/advisories/new)
— do **not** open a public issue for security problems.

You can expect an acknowledgement within a week. If the report is accepted,
a fix will be released as a patch version and credited to you in the
changelog (unless you prefer otherwise).

## Scope notes

- This server does not store user credentials. The secrets it reads are
  optional API tokens from environment variables (`MARKETAUX_API_TOKEN`,
  `PROXY_*`) and, if you set them, your TradingView session cookies
  (`TRADINGVIEW_SESSION_ID`, `TRADINGVIEW_SESSION_SIGN`). Never commit a
  `.env` file.
- All market data comes from third-party upstreams (TradingView, Yahoo
  Finance, Marketaux); treat tool output as informational, not as trading
  advice.

## Node bridge (`bridge/`)

The optional TradingView bridge is a small Node process. It runs the `tv_*`
tools and TradingView candles in backtests. Its security properties:

- **One pinned npm dependency**, `@mathieuc/tradingview` at an exact version
  (plus `ws`, which it pulls in). The lockfile is committed and its URLs point
  to `https://registry.npmjs.org/`.
- **Installed with `--ignore-scripts`**, both by hand (`npm ci --ignore-scripts`)
  and by `bridge/.npmrc`. No install scripts run.
- **`package.json` only under `bridge/`.** The repository root has no npm
  package. `bridge/package.json` is the only npm manifest in this project.
- **Cookies come only from environment variables or `.env`.** The bridge never
  reads them from requests, files or logs.
- **Logs are redacted.** The bridge and the Python client scrub session cookies,
  secret variables, Telegram tokens, Discord webhook URLs and JWT-shaped tokens
  from every log line and error message, including output from the library.
- **The child process gets an allowlisted environment.** The Python server
  starts the bridge with a fixed list of variables (paths, proxy and CA
  settings, the two TradingView cookies and the concurrency limit). Other
  secrets in the parent environment are not passed on.
- **Read-only.** The bridge has no methods for orders, watchlists or account
  changes.

Cookie handling, risks and revocation: [docs/tradingview-session.md](docs/tradingview-session.md).

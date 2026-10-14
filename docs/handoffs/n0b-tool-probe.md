# N0b report: OpenBB, AlphaDesk and TradingAgents probed (2026-10-14)

Piece N0b, regime 3, Sonnet 5.5 High. Nothing in `src/` or `bridge/` changed. The tools live outside the repo in `~/tools/n0b/<tool>/` (own venv each, versions pinned). No MCP server was registered anywhere. Companion file: `n0b-tool-names.txt` (1056 `openbb:` lines and 37 `alphadesk:` lines, for N3's drift test).

**Evidence:** every number below comes from a file in `~/tools/n0b/evidence/` (outside the repo; the drivers are `openbb.sh` and `alphadesk.sh` there, the Aperture calls are the `aperture-*.txt` files, the TradingAgents run is `~/tools/n0b/tradingagents/run.log`). The probes ran twice: once live in the session, once again to save the outputs; the numbers here are from the saved second run unless a line says otherwise. Latencies vary by a second or two between runs.

**Billed calls, all of them:** the TradingAgents run (approved by Adham, $0.19 worst case, actual $0.0173), plus about ten tiny Aperture test calls (a "Say hi" and a one-tool call on each of three models, repeated in the saved run, and two `/responses` attempts), a fraction of a cent in total. The first TradingAgents attempt failed at its first call with a 402 and billed nothing.

## Verdicts

| Tool | Verdict | What it unlocks |
|---|---|---|
| OpenBB 5.0.0 + openbb-mcp-server 2.0.1 | **go-with-limits** | N3 data; N4 dropped for statements, risk factors, MD&A, segments (price targets not probed, see section 1). Limit: never register all 1056 tools. |
| AlphaDesk 0.2.1 | **no-go** | Nothing we need. Keyless it serves only SEC filings and statements, which OpenBB already covers, and it is AGPL. |
| TradingAgents 0.6.0 | **go-with-limits** | N7: about $0.017 and 3 minutes per ticker on `gpt-6-luna`. Limits: needs the Chat Completions patch below, set a real SEC contact, and the planned two-tier split is unmeasured. |

## Aperture (checked because Adham asked)

The address is the one `ask` falls back to (a Tailscale address; `APERTURE_URL` is unset in this shell, and `ask --list` has no cache yet because `ask --refresh` costs a few cents and was not run). Files: `aperture-*.txt`.
- `GET /v1/models`: HTTP 200, 137 entries, each with a `pricing` field (a free way to read prices).
- `POST /v1/chat/completions`, "Say hi", `max_tokens` 64: `gpt-6-luna` 200 ("Hi!", 13 tokens); `glm-5.3-flash` 200 (45 tokens); `deepseek-v4.1-flash` 200 (61 tokens).
- One-tool test (`get_weather(city)`): all three models returned a `tool_calls` entry, HTTP 200: luna 135 prompt tokens, GLM 165, DeepSeek 299. So tool calling works on luna, GLM 5.3 Flash and DeepSeek V4.1 Flash.
- `POST /v1/responses` with `gpt-6-luna`: **HTTP 402** "payment method required to access this Aperture-provided model". Chat Completions works; Responses does not.
- Seen in the live session but not reproduced in the saved run: with `max_tokens` 16, GLM spent all of them on `reasoning_content` and returned empty `content` (`finish_reason: length`), so give GLM a generous `max_tokens`; and one odd DeepSeek reply at 16 tokens ("Hi! 👋 What can I\nI can help you with?").
- Listed prices per M tokens (input / output): luna 0.10 / 0.50; glm-5.3-flash 0.0261 / 0.90 on cheaperinference and 0.15 / 0.50 on the `aperture` route; deepseek-v4.1-flash 0.0441 / 0.63 and 0.30 / 1.20. Aperture picks the provider when several list the same id, so the real price can be either route.
- Not done: a full TradingAgents run on GLM or DeepSeek (not covered by the approved spend). The Pi side (`ask`, Tailscale, `APERTURE_URL` on the Pi) is not checked; N6 needs it.

## 1. OpenBB

Install: `uv venv --python 3.13`, `uv pip install openbb==5.0.0 openbb-mcp-server==2.0.1`, about 50 s in the live session (not timed in the saved run). Venv 884 MB (`du -sm`, measured per venv because `du` over several paths counts hard-linked files once). Start: `openbb-mcp --host 127.0.0.1 --port 8001` (streamable HTTP at `/mcp`), listening after about 40 s (the first start builds its extension cache). RSS 1,156,400 KB (1.16 GB) before the calls and 1,268,252 KB (1.27 GB) after (`openbb-rss-*.txt`).
- **Tool list:** 1056 tools, schemas total **5,654,676 bytes** (`openbb-tools-stderr.txt`). The listing exceeds the MCP client's default 1 MiB SSE event cap (`mcp/client/streamable_http.py:61`) and fails with `Server-sent event exceeded the 1048576 byte limit` (seen live; the saved probe lifts the cap). Registering it as-is would flood Claude's context. The server has `--tool-discovery` (hides tools behind `available_categories`, `available_tools`, `search_tools`, `call_tool`) and `--allowed-categories`; N3 must use one of them. Tools are named `<provider>_<path>`; 40 start with `sec_`.
- **No key needed** for any call below. AAPL, `provider: sec` unless stated (`openbb-*.txt`):

| Tool | Latency | Bytes | Notes |
|---|---|---|---|
| `sec_income_statement` (limit 2, annual) | 5.84 s | 48,804 | FY2025 revenue 416,161,000,000; operating income 133,050,000,000 |
| `sec_income_statement` (limit 5, annual) | 7.10 s | 52,765 | 5 periods, 2021 to 2025; includes `basic_eps`, `diluted_eps`, weighted-average shares, `cash_dividends_per_share` |
| `sec_balance_sheet` (limit 2) | 5.74 s | 59,476 | cash 35,934,000,000; `short_term_debt`, `long_term_debt`, `total_equity` |
| `sec_cash_flow` (limit 2) | 4.17 s | 72,959 | net income 112,010,000,000; `purchase_of_plant_property_and_equipment`, `repurchase_of_common_equity`; no ready-made free-cash-flow field (compute it) |
| `sec_risk_factors` | 6.00 s | 67,961 | Item 1A split into headed items |
| `sec_management_discussion_analysis` | 6.06 s | 22,763 | one text block from the latest 10-Q (period ending 2026-06-27) |
| `sec_segment_revenue` | 13.58 s | 4,649 | disaggregated net sales table (iPhone, Mac, iPad...), as markdown text |
| `nasdaq_equity_calendar_earnings` (2026-10-14 to 16) | 4.10 s | 14,837 | market-wide for the dates; filter by symbol afterwards |
| `nasdaq_equity_calendar_dividend` (2026-10-14 to 20) | 5.50 s | 18,468 | ex-date, amount, record and payment dates |
| `news_company` (provider nasdaq, limit 3) | 7.85 s | 2,332 | title, excerpt, url, publisher; headlines only |

- Not probed: price targets and analyst estimates (plan N4 lists them). Keep N4 conditional for those until someone calls the relevant OpenBB tools.
- The statement tools return about 50 to 70 KB for two to five periods (many fields); N3 should select fields. Risk-factor, MD&A and news text is untrusted text. The SEC provider has a `use_cache` option (default on); I did not verify the cache duration.

## 2. AlphaDesk

Isolation: **source skim plus scrubbed run**, no container. I unzipped the wheel (sha256 `f6a0a70cbb0a8a65...`) and read the source before installing. Verified: 23,807 lines; no `subprocess`, `os.system`, `eval` or `pickle`; no `Path.home`; outbound hosts are SEC, the Fed and key-gated vendors; the only POST handlers are its own dashboard routes. Ran with `env -i`, `HOME` and `ALPHADESK_DATA` pointing at scratch folders, no vendor keys, bound to 127.0.0.1.
- **Things the skim must also admit:** `config.py:29` calls `load_dotenv()` with no argument, which searches upward from the package directory, so a `.env` in `~/tools/n0b/alphadesk`, `~/tools/n0b`, `~/tools` or `~` would be loaded (I listed those four directories and found none). `semantic.py:115` defaults `ALPHADESK_SEMANTIC_SEARCH` to **on**, which downloads an embedding model from Hugging Face; I turned it off, so the RSS below is with it off. `providers/registry.py:76-80` loads any installed entry point in its group; only `ALPHADESK_PLUGINS` is empty by default. Harmless in its own venv, but not "plugins off".
- Dependencies are heavy and off-topic: `alpaca-py` (broker client), `stripe`, `pg8000`, `polygon-api-client`, `sentence-transformers` and `transformers` (installed with `--torch-backend cpu`). Install about 28 s live; venv 1,175 MB (`du -sm`). RSS 94,024 KB with semantic search off (`alphadesk-rss.txt`).
- **Port is 127.0.0.1:8010**, not 8000 (8000 is its dashboard). There is no console script for HTTP mode; I called `serve(http=True)`. `alphadesk-mcp` is stdio only.
- **37 tools** (README says 53), listed in `alphadesk-tools.txt` and `n0b-tool-names.txt`. By name none writes or sends; `my_board` reads a stored board.
- Keyless results (`alphadesk-nokey-*.txt`): `quote` error "no quote available"; `symbol_news` error "News needs a key"; `earnings_calendar` empty list (0 bytes); `financial_statements` annual returns 102 bytes, an empty `metrics` list. The source says why: the server holds no vendor keys; data comes from keys a user connects on its Account page.
- SEC tools need a real contact in `SEC_USER_AGENT`. With a contact (Adham's, not recorded here; `alphadesk-withsec-*.txt`): `list_filings` AAPL 1.79 s, 12,877 bytes (40 rows, 10-Q accessions marked `readable: true`); `financial_statements` annual 2.04 s, 10,979 bytes; quarterly 0.03 s, 12,501 bytes. In the live session, before any contact was set, `list_filings` was also empty and `financial_statements` returned 102 bytes (SEC throttles placeholder agents; the server log shows a pause). The saved no-contact `list_filings` now returns data only because its local store is already filled; the empty `financial_statements` is the part that reproduces.
- AGPL-3.0-only, 19 stars (per the brief). Unmodified, separate process; no code copied.

## 3. TradingAgents

v0.6.0 from the GitHub tag tarball (sha256 `c5be2240a2050354...`), Apache-2.0 (not on PyPI under that name). `uv venv --python 3.13`, `uv pip install ./src`: about 30 s live; venv 315 MB (`du -sm`, after the run). Data comes from yfinance, SEC EDGAR and Polymarket (keyless); FRED macro needs `FRED_API_KEY` and was skipped with a fallback message. No telemetry found in the source.
- Config (all via `TRADINGAGENTS_*` environment variables): provider `openai`, `gpt-6-luna` for both tiers, the three backend URLs = Aperture's `/v1`, debate rounds 1, risk rounds 1, tool rounds 3, `max_tokens` 4000, retries 1. Run with `env -i`, scratch `HOME`, a placeholder key string (Aperture injects credentials). The analysts hold 12 read-only data tools (`agents/tools.py`: stock data, indicators, fundamentals, statements, news, insider transactions, macro, prediction markets); none writes or executes. The plan's rule that a model reading attacker-controlled text gets no tools is therefore a decision for N7: these are fetch-only.
- **First run failed, $0:** `402 payment method required` from `/responses`. Root cause, in installed `langchain-openai` 1.7.2 `chat_models/base.py:2012-2026`: any model name starting with `gpt-6` that has tools bound is sent to `/v1/responses` unless `use_responses_api` is explicitly a bool. TradingAgents only sets it, to `True`, for native OpenAI URLs (`openai_client.py:320-321`), so it stays unset behind a gateway. Fix used in `run.py` (not in the library): `langchain_openai.ChatOpenAI._use_responses_api = lambda self, payload: False`; the cleaner equivalent is passing `use_responses_api=False` in the client kwargs. A model name without the `gpt-6` prefix (for example `openai/gpt-6-luna`) should also avoid Responses; not tested, and whether Aperture accepts that id is unknown.
- **Result, AAPL 2026-10-13:** decision "Underweight", **17 model calls**, tokens in 101,096, out 14,301, 174 s (`run.log`). Cost at luna's listed rate: 101,096 x 0.10e-6 + 14,301 x 0.50e-6 = **$0.0173** (worst case written down before the run: $0.19). The same tokens at GLM's listed prices: $0.0223 on the `aperture` route (0.15 in, 0.50 out) or $0.0155 on cheaperinference (0.0261 in, 0.90 out); at DeepSeek's cheaperinference price $0.0135. The stats handler reported `tool_calls=0` and does not split calls by tier, so it does not count tool rounds (the log shows the market analyst used all 3: `get_indicators` x8, `get_stock_data` x1, `get_verified_market_snapshot` x1). Decision quality was not assessed.
- **Network:** `conns.txt` has 1,318 lines, one per open socket per 2-second snapshot (so roughly 87 snapshots; there are no timestamps). 295 lines are to Aperture on port 80, the only plain-HTTP peer; the rest are HTTPS (443) to data hosts. This fits "all LLM traffic goes to Aperture". The routing proof is in the source, not the log: an explicit `base_url` wins (`openai_client.py:300-311`), `env -i` removed any `OPENAI_BASE_URL`, and the source contains no other LLM client.
- For N7: 20 hot-list tickers a day is about $0.35 a day on luna at this size, and about an hour of wall time if run one after another (174 s each). The plan's cheaper-analyst and stronger-manager split is unmeasured (all calls here were luna). TradingAgents' SEC User-Agent defaults to `contact@example.com` (`dataflows/vendors/sec_edgar.py:101-102`); set `SEC_EDGAR_USER_AGENT` to a real contact before any scheduled run.

## What I did not do
Register any MCP server; install anything on the Pi; run TradingAgents on GLM or DeepSeek; judge the quality of any answer; run `ask --refresh`; probe OpenBB price targets; test anything on arm64; read any secret file.

## Reproduce
`~/tools/n0b/evidence/openbb.sh` (needs `openbb-mcp` on 127.0.0.1:8001), `~/tools/n0b/evidence/alphadesk.sh` (starts and stops its own server), `~/tools/n0b/tradingagents/run.sh AAPL 2026-10-13` (billed, about $0.02). All servers are stopped (ports 8001 and 8010 closed).

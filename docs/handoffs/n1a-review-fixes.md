# N1a reviewed-defect fixes

Worktree: `/home/adhfult/code/tradingview-mcp-codex-n1a-news`, branch `codex/n1a-news`.
No commits, pushes, network calls, other agents, new dependencies, or changes to `bridge/node_modules`.
The worker used the supplied review briefing as its approved plan. Stale handoffs were not read.

## Changes and evidence

Each behavior defect received a failing test before its implementation change. Existing guards received new tests, followed by scratch mutations that demonstrated failure when the guard was removed. No hostile-input test was deleted. The old future-item test was extended to require eventual delivery; the invalid-JSON byte-cap input was replaced with valid oversized JSON.

| Defect | Final change / test | Evidence |
| --- | --- | --- |
| M1 | Committed windows always append and submit even after stop; watcher waits for scheduled news before state flush and queue drain, bounded at 5 seconds. | 51-symbol/two-chunk test failed with submission count `0 !== 1`; queue-order test failed with `true !== false`. Both pass. Three mutations kill the stopped gate, post-append early return, and missing watcher wait. |
| M2 | Read the clock after fetching a complete window; future entries skip both seen and title keys. | Three red tests: eventual delivery `1 !== 2`, during-fetch publication `0 !== 1`, and unexpected future dedupe keys. All pass. Stale-clock and future-key mutations fail. |
| M3 | Persist `news.evictedBefore`; capacity pruning advances it to the newest evicted observation time. Suppress publications at/before that floor. Keep the 20,000-key caps. | 1,000 stories × 50 tickers seeded without alerts, but second poll originally produced a digest (`1 !== 0`). Now second poll and restart produce zero; a later publication alerts. Floor advancement, filtering, and reload mutations all fail. |
| M4 | Require mode 600, attempt chmod once, exit 1 on failure before automatic token generation, each channel/contact prompt, or `set_var`. | Five shell-harness cases originally failed; all pass. Tests run extracted real helpers and setup/channel blocks against synthetic temporary settings. SEC, Telegram, Discord and automatic setup remain unchanged when chmod fails; successful repair precedes writing. Disabling the guard fails all five. |
| S1 | Escaped form regex accepts `/A` amendments and rejects other forms. | Real Better Home amended filing from page-1 fixture: initially `0 !== 1`, now passes. Both strict-original-form and missing-form-filter mutations fail. |
| S2 | Warn about bare symbols only with news enabled. Adjust existing warning test to enable news. | Disabled-news warning count initially `1 !== 0`; enabled/disabled/default test passes. |
| S3 | Log only bounded identifier-shaped `err.name` and `err.code`; invalid labels become `Error`. Never log the message. | Expected `TypeError`/`ECONNRESET` absent before fix. Both-source and hostile-label tests pass without URL or contact text in logs. |
| S4 | Add a valid 1,001-item JSON page rejection test. Existing guard retained. | State and submissions remain unchanged; removing the page cap fails the new test. |
| S5 | Convert `.` to `-` on SEC ticker lookup only; retain original symbols in records/messages. | Synthetic BRK.B/BRK-B test originally `0 !== 1`, now passes. Real SEC company-map/share-class rows are not present in recorded fixtures, so their format remains unverified offline. |
| S6 | Filter invalid company-map rows in both fetched and cached maps; reject only an empty valid result. | Mixed valid/invalid map originally disabled all companies (`0 !== 1`). Fetch, cache reuse, persisted valid rows, and all-invalid refusal tests pass. |
| S7 | Put `+N more` first in digest lines. | Real Discord/Telegram payload truncation originally lost the line; both payload tests pass. No notifier implementation changes. |
| S8 | Strip `[]()*_`, backticks and angle brackets from feed-derived digest text and held summaries; preserve validated links on their own lines and source titles in JSONL. | Spoofing/control-character test originally failed; digest and summary test now passes. Existing control/field-cap test retained with its display expectation updated. |
| S9 | Keep the streaming cap, make oversized input valid JSON, and test RSS missing/empty channel. | Oversized JSON and `<rss/>` fail when the respective guards are removed; `<rss><channel/></rss>` succeeds. |
| S10 | Reject percent-encoded dot, slash and backslash anywhere in TradingView story paths, case-insensitively. Existing raw-dot-segment rejection retained. | Encoded paths originally alerted (`1 !== 0`); all encoded/path traversal cases now produce zero alerts. These checks also exclude decoded `..` segments because any encoded dot/separator needed to form one is refused. |
| S11 | Test bare-symbol filtering, SEC query and fragment refusal, duplicate XML attributes, malformed comments, page cap, and form matching. | All seven guard-removal mutations fail (query and fragment tested separately). Parser implementation did not need changes. |

## Design choices left open by the briefing

- No clock-skew allowance: check after fetch, then defer genuinely future stories until a later poll. This avoids remembering a story before it can alert.
- Eviction uses a permanent global publication floor based on evicted observation timestamps. Observation is at least publication because future entries never get keys. This keeps memory bounded and prevents re-alerting retained feed items. It conservatively suppresses previously unseen stories published at/before the floor, including another ticker/source; normal TTL expiry does not raise the floor. Old state files default to floor zero.
- The floor is an observation time, so after an eviction burst a story published just before it but indexed late is dropped; organically, reaching the seen-key cap needs more than 10,000 story × symbol pairs within `remember_hours`.
- Reuse the existing injected-clock queue-drain helper for the 5-second news wait. A fetch that ignores abort can outlast this bound; committed records still append and the closed queue uses its existing log-and-drop behavior.
- A real fetch honours the abort signal; only a fake that ignores it can outlive the 5-second drain.
- Strip markdown controls rather than escaping them, for consistent display across both transports. Keep source titles unchanged in the append-only data record.
- Failed-request labels accept only 1–64 ASCII identifier characters, since arbitrary error-name/code strings can themselves contain URLs or contact text.
- Bash harnesses run inside `node:test` so the requested bare test suite discovers them, without installing a shell-test framework or executing the real Pi setup.

## Exact verification commands and real output

Commands below run from the worktree's `bridge/` unless marked root. Red/green logs remain in `/tmp/n1a-*.log`.

Initial M1 filtered `node --test --test-name-pattern='M1 ' test/watcher/news.test.mjs` reported only a file-level failure. Direct execution exposed the assertions. Node here is `v24.21.0`; `--test-isolation=none` exposes individual test results without child-file aggregation.

```text
node test/watcher/news.test.mjs
M1 red:   tests 36, pass 34, fail 2; exit 1
M1 green: tests 36, pass 36, fail 0; exit 0
M2 red:   tests 38, pass 35, fail 3; exit 1
M2 green: tests 38, pass 38, fail 0; exit 0
M3 red:   tests 39, pass 38, fail 1; exit 1
M3 green: tests 39, pass 39, fail 0; exit 0

node test/watcher/pi-setup.test.mjs
M4 red:   tests 5, pass 0, fail 5; exit 1
M4 green: tests 5, pass 5, fail 0; exit 0

node --test --test-isolation=none --test-name-pattern='S[0-9]+ ' test/watcher/news.test.mjs test/watcher/atom.test.mjs test/watcher/config.test.mjs
tests 16, pass 8, fail 8; exit 1 before behavior fixes
```

The failing should-fix tests were S1, S2, S3, S5, S6, S7, S8, S10. Existing guards passed initially; mutation evidence below proves they detect missing validation.

After each behavior fix:

```text
node --test --test-isolation=none --test-name-pattern='S1 ' test/watcher/news.test.mjs
tests 1, pass 1, fail 0; exit 0
node --test --test-isolation=none --test-name-pattern='S2 ' test/watcher/config.test.mjs
tests 1, pass 1, fail 0; exit 0
node --test --test-isolation=none --test-name-pattern='S3 ' test/watcher/news.test.mjs
tests 1, pass 1, fail 0; exit 0
node --test --test-isolation=none --test-name-pattern='S5 ' test/watcher/news.test.mjs
tests 1, pass 1, fail 0; exit 0
node --test --test-isolation=none --test-name-pattern='S6 ' test/watcher/news.test.mjs
tests 2, pass 2, fail 0; exit 0
node --test --test-isolation=none --test-name-pattern='S7 ' test/watcher/news.test.mjs
tests 1, pass 1, fail 0; exit 0
node --test --test-isolation=none --test-name-pattern='S8 |keyword filters' test/watcher/news.test.mjs
tests 2, pass 2, fail 0; exit 0
node --test --test-isolation=none --test-name-pattern='S10 ' test/watcher/news.test.mjs
tests 1, pass 1, fail 0; exit 0
```

Requested full check:

```text
timeout 250 node --test
ℹ tests 38
ℹ suites 0
ℹ pass 30
ℹ fail 8
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
exit 1 (aggregated test-file outcomes, not individual case counts)
```

Failing files: `test/entrypoint.test.mjs`, `test/watcher/cli.test.mjs`, `test/watcher/dashboard-page.test.mjs`, `test/watcher/dashboard.test.mjs`, `test/watcher/localapi.test.mjs`, `test/watcher/notes.test.mjs`, `test/watcher/render-page.test.mjs`, `test/watcher/watcher.test.mjs`. All five focused files passed in this full attempt. The default runner hides the failed child cases; a targeted diagnostic exposes the sandbox restriction:

```text
node --test --test-isolation=none --test-name-pattern='local API|listen|bind|loopback|GET /health' test/watcher/localapi.test.mjs
✖ the server binds to 127.0.0.1 only
✖ GET /health needs no token and returns status without secrets
✖ GET /health never contains the token or any env secret name
Error: listen EPERM: operation not permitted 127.0.0.1
code: 'EPERM', syscall: 'listen'
exit 1
```

Allowed fallback plus the new shell harness:

```text
node --test test/watcher/news.test.mjs test/watcher/atom.test.mjs test/watcher/state.test.mjs test/watcher/config.test.mjs test/watcher/pi-setup.test.mjs
ℹ tests 5
ℹ pass 5
ℹ fail 0
exit 0 (aggregated file outcomes)

node --test --test-isolation=none test/watcher/news.test.mjs test/watcher/atom.test.mjs test/watcher/state.test.mjs test/watcher/config.test.mjs test/watcher/pi-setup.test.mjs
ℹ tests 148
ℹ suites 0
ℹ pass 148
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
exit 0

node --test --test-isolation=none --test-name-pattern='stop\(\) closes the client|shutdown saves state' test/watcher/watcher.test.mjs
✔ stop() closes the client and flushes state that changed
✔ shutdown saves state before it waits for undelivered alerts
ℹ tests 2
ℹ pass 2
ℹ fail 0
exit 0
```

Root checks:

```text
node bridge/watcher.mjs --config bridge/watcher.config.example.json --check-config
OK
warning: no notification channel is configured; alerts are only logged
warning: WATCHER_LOCAL_TOKEN is not set; the local API stays disabled
exit 0

bash -n scripts/pi-setup.sh
exit 0, no output
git diff --check
exit 0, no output
```

## Mutation check

The original worktree stayed fixed. `mktemp -d /tmp/n1a-mutations.XXXXXX` created `/tmp/n1a-mutations.F5KLpm`; only required code/tests/fixtures were copied, with a separate dependency symlink. Each mutation was applied singly, tested with a 30-second subprocess timeout, and restored in the scratch copy. No `rm -rf` was used.

```text
python3 /tmp/n1a-mutations.F5KLpm/run.py
SCRATCH /tmp/n1a-mutations.F5KLpm
BASELINE 0 ℹ tests 148
ℹ pass 148
ℹ fail 0
MUTANTS 19 KILLED 19 SURVIVED 0
exit 0
```

Every mutant's test command was `node --test --test-isolation=none --test-name-pattern='<pattern>' <file>` from the scratch `bridge/`. Each row below exited 1 with a named assertion failure, not a syntax/import failure. Raw logs are `/tmp/n1a-mutations.F5KLpm/<mutation>.log`; the combined output is `/tmp/n1a-mutations.log`.

| Mutation | Pattern | File | Failed cases |
| --- | --- | --- | ---: |
| M1-stop-gate | `M1 stop` | `test/watcher/news.test.mjs` | 1 |
| M1-after-append | `M1 stop` | `test/watcher/news.test.mjs` | 1 |
| M1-watcher-wait | `M1 watcher` | `test/watcher/news.test.mjs` | 1 |
| M2-stale-clock | `M2 ` | `test/watcher/news.test.mjs` | 1 |
| M2-remember-future | `M2 ` | `test/watcher/news.test.mjs` | 2 |
| M3-no-floor-advance | `M3 ` | `test/watcher/news.test.mjs` | 1 |
| M3-no-floor-filter | `M3 ` | `test/watcher/news.test.mjs` | 1 |
| M3-no-floor-reload | `M3 ` | `test/watcher/news.test.mjs` | 1 |
| M4-no-private-guard | `M4 ` | `test/watcher/pi-setup.test.mjs` | 5 |
| S4-no-page-cap | `S4 ` | `test/watcher/news.test.mjs` | 1 |
| S9-no-stream-cap | `S9 streaming` | `test/watcher/news.test.mjs` | 1 |
| S9-no-RSS-channel | `S9 RSS` | `test/watcher/atom.test.mjs` | 1 |
| S11-no-symbol-filter | `S11 bare` | `test/watcher/news.test.mjs` | 1 |
| S11-no-query-check | `S11 SEC rejects` | `test/watcher/news.test.mjs` | 1 |
| S11-no-fragment-check | `S11 SEC rejects` | `test/watcher/news.test.mjs` | 1 |
| S11-no-duplicate-attribute | `S11 duplicate` | `test/watcher/atom.test.mjs` | 1 |
| S11-no-comment-check | `S11 double` | `test/watcher/atom.test.mjs` | 1 |
| S11-no-form-check | `S1 ` | `test/watcher/news.test.mjs` | 1 |
| S1-no-amendments | `S1 ` | `test/watcher/news.test.mjs` | 1 |

## Remaining work for Claude

Rerun bare `timeout 250 node --test` outside this restricted sandbox before accepting a whole-suite green result. The worker does not claim zero failures for the full suite. Real SEC share-class map format and Pi hardware behavior were not measured or fetched. No commit, push, service installation, real credential access, deployment, notifier change, dependency installation, global configuration change, or other-agent call occurred.

Changed news polling and digest safety, bounded shutdown, persisted eviction state, Pi setup permission checks, and 26 additional regression/guard tests; added this report.

## Second small fix round (R1–R5)

Applied the second supplied briefing to `421747e`, without commits or other agents.

| Item | Change and decision | Evidence |
| --- | --- | --- |
| R1 | Preserve validated symbols verbatim; apply `digestText` to feed titles only. | `NSE:M_M · New headline` initially rendered as `NSE:MM · New headline`; regression now passes while title markdown is still stripped. |
| R2 | Track symbols with future entries but no nonfuture entries in the complete window; defer their seed/run updates. Other symbols progress normally. SEC shares a run marker per form, so leave that marker unchanged if any symbol is deferred. | TradingView and SEC year-2100 first pages initially alerted their next valid backlog (`1 !== 0`); both now seed silently with no first-page seed/run markers. A mixed-symbol test initially leaked the deferred symbol's backlog and now only alerts the established symbol. |
| R3 | Extend S1 with `8-KX - x` and `8-K/AX - x`; exercise pruning and unseen publications at the floor and 1 ms after; make the M1 wait stub submit through real alerts/queue. | Four isolated mutations all fail by assertion; restored code passes. The M1 test checks delivery before the deadline and recorded submission plus the closed-queue drop log after the deadline. |
| R4 | Restore `run: sudo chown $ME:$ME $ENVFILE && chmod 600 $ENVFILE` on refusal; print an `ok` line after successful mode repair. | All four refusal-message tests and the successful-repair notice test failed before the change; all five pass, preserving refusal-before-prompt/write assertions. |
| R5 | Break at the top of each SEC form iteration when stopped. | Stopping in the first form initially logged two `request or response failed` warnings; regression now observes one form fetch and no such warnings. |

The eviction-floor implementation and 5-second drain implementation are unchanged. The two limitation sentences above were added as requested. No network, real credentials, Pi setup execution, dependency installation, global configuration change, other agents, commit, or push. The full suite was not rerun because the briefing delegates its sandbox-incompatible listener tests to Claude.

Commands and actual results (from `bridge/` except where stated):

```text
node --test --test-isolation=none --test-name-pattern='R1 |R2 |R5 |M4 ' test/watcher/news.test.mjs test/watcher/pi-setup.test.mjs
Before fixes (initial R2 test): tests 8, pass 0, fail 8; exit 1.
After fixes (R2 split by source, plus mixed-symbol test): tests 10, pass 10, fail 0; exit 0.

node --test --test-isolation=none --test-name-pattern='R2 ' test/watcher/news.test.mjs
Before fixes: tests 3, pass 0, fail 3; exit 1.

node --test --test-isolation=none --test-name-pattern='R3 M3 |M1 watcher|S1 ' test/watcher/news.test.mjs
tests 3, pass 3, fail 0; exit 0.

node --test --test-isolation=none test/watcher/news.test.mjs test/watcher/atom.test.mjs test/watcher/state.test.mjs test/watcher/config.test.mjs test/watcher/pi-setup.test.mjs
ℹ tests 154
ℹ suites 0
ℹ pass 154
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
exit 0

Root: node bridge/watcher.mjs --config bridge/watcher.config.example.json --check-config
OK
warning: no notification channel is configured; alerts are only logged
warning: WATCHER_LOCAL_TOKEN is not set; the local API stays disabled
exit 0

Root: bash -n scripts/pi-setup.sh
exit 0, no output
Root: git diff --check
exit 0, no output
```

Mutation commands and evidence:

```text
Root: mktemp -d /tmp/n1a-round2.XXXXXX
/tmp/n1a-round2.rRA23u
Root: python3 /tmp/n1a-round2.rRA23u/run.py
baseline: tests 3, pass 3, fail 0; exit 0
S1-accept-8-KX: tests 1, pass 0, fail 1; exit 1 (digest contains 8-KX)
S1-accept-8-K-AX: tests 1, pass 0, fail 1; exit 1 (digest contains 8-K/AX)
M3-floor-minus-1: tests 1, pass 0, fail 1; exit 1 (digest contains at-floor)
M1-drop-digest-after-timeout: tests 1, pass 0, fail 1; exit 1 (recorded news submissions 0 !== 1)
restored: tests 3, pass 3, fail 0; exit 0
MUTANTS 4 KILLED 4 SURVIVED 0
exit 0
```

Only code, test helpers and fixtures were copied; dependencies were symlinked. Each mutation was applied individually, run with a 30-second subprocess timeout, and restored. No `rm -rf`. Runner and full assertion logs remain under `/tmp/n1a-round2.rRA23u/`.

Exact commands inside the scratch `bridge/`:

```bash
node --test --test-isolation=none --test-name-pattern='S1 ' test/watcher/news.test.mjs
node --test --test-isolation=none --test-name-pattern='R3 M3 ' test/watcher/news.test.mjs
node --test --test-isolation=none --test-name-pattern='M1 watcher' test/watcher/news.test.mjs
```

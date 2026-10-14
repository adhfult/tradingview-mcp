# Brief N0b: install and probe OpenBB, AlphaDesk and TradingAgents

Regime 3 (setup). Builder: Sonnet 5.5 High, new session. Reviewer: Fable subagent on the report (no code to diff). Read first: `docs/plans/news-monitor-and-analysis-prompts.md` (approved N0 version) and `docs/plans/news-monitor-n0-findings.md`. Ignore `HANDOFF.md` and `HANDOFF-P0-old.md` in the repo root. Rules: tests first and committed before the code; do not push; do not read or print secrets (a hook blocks credential files: create such files with the Write tool); run Python tests with `env -u PYTHONDONTWRITEBYTECODE`; never two agents on one file; if the plan does not decide something a test needs, stop and ask instead of choosing; show the real error and a diagnosis before changing approach. Reminder line to print first: `Next piece: <this piece>. Regime <n>. Start with Sonnet 5.5 High. New session needed: yes.` End with: what you did, the commands you ran and their real output, what you did not do. Log the piece with `python3 ~/dotfiles/scripts/regime_log.py add ...` once its check passes, and add a `docs/handoffs/` report and a STATUS row.

**Goal:** find out, with real outputs, whether each tool runs on this PC and gives what the plan needs. No file in `src/` or `bridge/` changes.

**May touch:** `docs/handoffs/n0b-tool-probe.md` (the report) and scratch environments outside the repo (`mktemp -d` or `~/tools/`). Nothing else.

**Steps (each in its own environment, version pinned and recorded):**
1. **OpenBB:** `uvx --from openbb-mcp-server --with openbb openbb-mcp` (default port 8001, localhost only). List the real MCP tool names. Call the SEC income statement, balance sheet, cash flow and risk factors for AAPL, and the Nasdaq earnings calendar and company news. Record: needs a key or not, fields returned, latency, RSS of the process.
2. **AlphaDesk:** `pip install alphadesk` in a fresh venv, run on 127.0.0.1:8000 with only the SEC contact address set (use the Write tool for any settings file, never print it). List the MCP tools it really exposes (README says 53), read the list for anything that writes or sends. Record RSS. It is AGPL-3.0 and has 19 stars: unmodified, separate process, localhost, no vendor keys.
3. **TradingAgents:** `uv venv --python 3.13`, `pip install .` from a pinned release. Configure an OpenAI-compatible endpoint = Aperture (`$APERTURE_URL/v1`, reached over Tailscale, no key needed by us), analyst tier = a cheap alias from `ask --list`. **State the spend before running** and cap it: run ONE ticker once, count model calls and tokens, and report the cost per ticker at the alias prices.
4. Verdict per tool: go / no-go / go-with-limits, and which plan pieces it unlocks (N3 data, N4 dropped or kept, N7 budget).

**Check:** the report exists, every number in it came from a command shown in it, and no secret appears in it.
**Out of scope:** registering any MCP server in Claude's global config (ask Adham), installing anything on the Pi, editing watcher or server code, trading of any kind.

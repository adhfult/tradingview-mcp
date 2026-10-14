# Prompts for the news monitor work (plan, then build)

Companion to `docs/handoffs/NEXT-news-monitor.md` and `docs/plans/news-monitor-and-analysis-prompts.md`. Written 2026-10-14. Model names as Adham gave them: **Opus 5.5 High** (planner), **Gemini 4 Argon** (second planner), **GPT-6.1 Sol High** and **GPT-6 Luna Max** (builders/reviewers). Known slugs: Sol `gpt-6.1-sol`, Luna `gpt-6-luna`. Argon is used through the Gemini app, so it has no slug here.

## Order of work (planning, then building)

1. **Start Argon first** in the Gemini app (Prompt B). It writes an independent plan without reading Claude's draft, so the two plans do not anchor on each other.
2. **Start the Opus session** (Prompt A) at the same time. It does the N0 research, forms its own view, **then** reads Argon's plan and reconciles the two.
3. Adham answers the open questions and approves the reconciled plan. Nothing is built before that.
4. Build pieces, one session each, per the approved plan (Prompts C and D are templates; the Opus session fills in the real briefs).

Rules for every agent: do not push (Adham does, or says so); one agent per file at a time; the caller runs the check and reads the diff; show the real error and a diagnosis before changing approach; secrets are never read or printed (a hook blocks env/key files: create such files with the Write tool); `rm -rf` is blocked (use `mktemp -d`); **ignore `HANDOFF.md` and `HANDOFF-P0-old.md` in the repo root** (stale; `inv.sh` may offer one of them as the "newest handoff").

---

## Prompt A: the planner (Opus 5.5 High, plan mode, new session)

Paste as the first message:

> Read `docs/handoffs/NEXT-news-monitor.md` and `docs/plans/news-monitor-and-analysis-prompts.md` (including Appendix A, my ten prompts). You are the planner (Opus 5.5 High, plan mode, regime 1). Do not write code. First state the standing reminder line from the handoff.
>
> Then, in this order:
> 1. **Do step N0.** Verify against real documentation, with the URL and date for each fact: SEC EDGAR access rules (request rate, required User-Agent, the current-filings feed, ticker-to-company-id file, XBRL company facts), the terms and limits of each RSS source, what a batch quote poll of about 200 symbols can use on the TradingView bridge, and what PanWatch (`TNT-Likely/PanWatch`) really offers for news. Hand pure fact lookups to Haiku xhigh subagents; keep the design yourself; verify any claim a subagent returns before using it. Save findings in `docs/plans/news-monitor-n0-findings.md`.
> 2. **Form your own view** of D0 to D3 and of the five open questions, and write it down.
> 3. **Only then** read `docs/plans/news-monitor-argon-plan.md` (the independent plan from Gemini 4 Argon; if I paste its reply into this chat instead, save it to that path first). Make a short table: each point where it differs from my draft or from your view, who is right, and the evidence. Do not defer to either plan; a claim is right because it checks out.
> 4. Correct the plan file. Keep a list of what is still unverified.
> 5. Ask me the open questions you still need answered (the first is whether "stock options" means stocks or options contracts).
> 6. Get the Fable advisor review, then wait for my approval.
> 7. After approval, write one build brief per piece (N1, N3, N4, N2) in `docs/handoffs/briefs/`, each with: files it may touch, failing tests first, the check that proves it, which agent builds it and which reviews it, and what is out of scope. Use this default split unless you can justify another: **Sonnet 5.5 High leads each build session; Luna Max (Codex worktree) takes bounded sub-tasks that have a runnable check; Sol High does the security-critical module reviews and any long terminal or Pi work.** Never two agents on the same file.

---

## Prompt B: the second planner (Gemini 4 Argon, in the Gemini app, run now)

Argon runs in the **Gemini app** (Pro plan), not the Antigravity CLI, so it cannot read local files and `inv.sh` does not apply. The brief `docs/handoffs/briefs/news-argon-plan.md` is therefore **self-contained**: it has a project summary, the request, the ten prompts and what to produce, and it leaves out Claude's design so the two plans do not anchor on each other.

1. Open the file, copy all of it, and paste it into the Gemini app as one message, using the strongest Argon mode your plan offers. I do not know what the Pro plan limits are (message length, usage, any deeper-reasoning mode); the brief asks for about 1,500 words so it should fit. If the app refuses the length, split at the "Public code links" heading and send the ten prompts second.
2. When the answer arrives, copy it and save it as `docs/plans/news-monitor-argon-plan.md`. Easiest: paste it into the Opus planner session and ask it to save it there. Check the first line is `ARGON INDEPENDENT PLAN`.
3. The app may not be able to browse; the brief tells it to mark anything unverified. The Opus session verifies the facts either way (step N0).

---

## Prompt C: a builder (GPT-6 Luna Max, Codex worktree, after approval): template

Used for a **bounded sub-task with a runnable check** (for example: the hostile-feed test suite for the news module, the ten MCP prompts and their tool-name drift test, the SEC fixtures parser). The Opus planner fills in the real brief file; the command form is:

```bash
cd ~/code/tradingview-mcp && INV_FROM=claude nohup bash ~/dotfiles/scripts/inv.sh --file docs/handoffs/briefs/<piece>-luna.md --write <branch-name> codex gpt-6-luna max > /tmp/<piece>-luna.out 2>&1 &
```

The brief file must say, in this order:
> You are a builder on piece `<piece>` of `docs/plans/news-monitor-and-analysis-prompts.md` (approved version). Work only in your own git worktree. You may edit only these files: `<list>`. Write the failing tests first and commit them; then make them pass and commit. The check that proves you are done: `<exact command>`. You have no network: use fakes and recorded fixtures (`bridge/test/watcher/support.mjs`, `tests/unit/...`). Do not add a dependency unless the brief names it. Do not push. Do not touch `docs/handoffs/STATUS.md`. Do not read or print secrets. If a test needs something the plan does not decide, stop and say so instead of choosing. End with: what you did, the commands you ran and their real output, and what you did not do.

The caller (Sonnet 5.5 High or Adham) then runs the check itself, reads the diff, and merges the worktree branch. Do not trust the worker's own "tests pass" line.

---

## Prompt D: a reviewer (GPT-6.1 Sol High, read-only, end of each piece): template

Required for N1 and N4 (outbound fetching and parsing of untrusted text) and any piece over about 50 lines. Give it the plan path and a **saved diff file path**, not the transcript:

```bash
cd ~/code/tradingview-mcp && git diff <base>..HEAD > /tmp/<piece>.diff && INV_FROM=claude nohup bash ~/dotfiles/scripts/inv.sh --file docs/handoffs/briefs/<piece>-sol-review.md codex gpt-6.1-sol high read > /tmp/<piece>-sol.out 2>&1 &
```

The review brief says:
> Review the diff at `/tmp/<piece>.diff` against `docs/plans/news-monitor-and-analysis-prompts.md` (approved version) and its piece brief. You are read-only. Look for defects, not style: hostile or malformed input (mentions, markup, huge fields, bad XML, entity expansion, redirects, non-https links), request budget and rate-limit breaches, state that grows without bound, silent failure paths, secrets in logs or messages, tests that cannot fail, and claims in the docs that the code does not support. For each finding give the file and line, the exact failing input or state, and the consequence. Say "no finding" for a category rather than inventing one. Do not suggest rewrites.

Act only on findings you have verified by reproducing them. Log the piece with `python3 ~/dotfiles/scripts/regime_log.py add ...` once its check has run.

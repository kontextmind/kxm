---
description: Dispatch an implementation unit to the designated writer (Grok CLI) headlessly
argument-hint: <unit id or task description>
---

Dispatch implementation work to **Grok**, the **starting** writer per `AGENTS.md`,
through the native `grok` CLI. Grok is not a sole writer: after a failed or exhausted
route, move to the next **admitted** authenticated route in Tracking → Decided rather than
stopping, and never bill one vendor through another's harness. Read
`.claude/harness-cli.md` for the exact invocation mechanics before launching.

Task: $ARGUMENTS

Do this:

1. **Confirm auth.** `grok models` must report a logged-in account and list
   `grok-4.6`. If it does not, do **not** silently bill Grok through another harness
   (`pi --model xai/...` is exactly that). Either take a route Tracking **admits** for that
   purpose, with its own auth check and cost record, or stop and say which limits were hit.
   Fail-closed means no unadmitted fallback, not no relief route.
2. **Isolate.** Put the lane in its own git worktree branched from `origin/main`
   (or resume the existing one if this unit already has a branch). Never run a
   writer in a tree another lane is using.
3. **Write a brief file** to the scratchpad. It must carry everything the writer
   needs so it does not re-derive context: the goal, the exact files to read,
   the change list, the gate that proves it, the hard constraints (breaking
   changes are fixed in tree — no aliases, no shims, no dual product names), an
   explicit "do not" list, and a request to report back what surprised it.
   Include the reading and diff budgets from the unit.
4. **Launch in the background**, logging to the scratchpad. Prefer the common
   envelope so the run is recorded like every other dispatch:
   `just impl <brief> <worktree>`
   which resolves to `grok --prompt-file <brief> -m grok-4.6 --reasoning-effort
   high --always-approve --output-format json`. Drop to `--reasoning-effort low`
   for mechanical edits.
5. **Verify independently when it returns.** Check `git status`, `git log`, and
   the actual diff yourself, and confirm the gates (`npm run verify`, then
   `npm run check:generated`) really passed. The writer's summary is a claim,
   not evidence.
6. **Write back.** Append the five-line entry to
   `plans/history/2026-09-04-work-log.md` (unit id, what landed, PR, what
   surprised you, what the next unit should know).

Do not merge or enable auto-merge on the writer's behalf unless I asked for it.

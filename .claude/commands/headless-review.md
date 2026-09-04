---
description: Dispatch review to a provider different from the writer (Fable and/or Codex gpt-5.6-sol)
argument-hint: [arch|cli|both] <what to review>
---

Dispatch review to a provider **different from whoever wrote the code**. Per
`AGENTS.md`: Fable reviews architecture and permissions, Codex `gpt-5.6-sol` reviews
CLI and docs. One critic is enough unless the change touches auth, workflow
policy, or multiple packages — then use both. Read `.claude/harness-cli.md` for
the invocation mechanics.

Review: $ARGUMENTS

Do this:

1. **Pick the critic** from the first argument (`arch`, `cli`, or `both`). If I
   did not say, choose from what the diff touches and tell me which you picked
   and why. If the writer was Grok, any of these is independent; if the writer
   was Fable, do not use Fable as the critic.
2. **Write a review brief** to the scratchpad carrying the diff under review
   (or the exact command to produce it), what the change is supposed to do, and
   the invariants it must not weaken — authority, recovery, isolation,
   synchronization, and fail-closed identity checks.
3. **Launch in the background, read-only:**
   - architecture / permissions:
     `cat <brief> | claude -p --model fable --allowedTools Read Grep Glob Bash`
   - CLI / docs:
     `codex exec -m gpt-5.6-sol -C <worktree> --sandbox read-only - < <brief>`
   Run both concurrently when the answer is `both`.
4. **Triage the findings yourself.** Verify each one against the code before
   passing it on; a critic being confident is not evidence. Say plainly which
   findings you think are wrong and why.

Review output is an artifact plus human signoff, never hub `peer-reply`
evidence, and a fallback model is not a second critic.

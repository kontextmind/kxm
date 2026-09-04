---
description: Dispatch planning to headless Claude Fable, independent of the writer
argument-hint: <unit id or question to plan>
---

Dispatch planning to **Claude Fable**, headless and read-only. Per `AGENTS.md`
Fable plans and Grok applies; the planner must stay independent of the writer.
Read `.claude/harness-cli.md` for the invocation mechanics before launching.

Plan: $ARGUMENTS

Do this:

1. **Write a planning brief** to the scratchpad. Name the exact files to read
   and in what order, and cap the reading budget (~1,500 source lines for a
   plan unit). Tell it not to read the full plan reviews.
2. **Demand anchors.** Every claim about current behavior needs a `file:line`.
   Line numbers in the work plan drift as units land, so ask it to correct them
   rather than trust them.
3. **Ask for a structure the writer can execute without re-deriving anything:**
   current shape, target shape with literal output strings, per-file change list
   with line estimates, deletions with every call site named, tests as concrete
   names plus the assertion each makes, and risks where the unit and the code
   genuinely disagree.
4. **Launch in the background, read-only**, prompt on stdin:
   `cat <brief> | claude -p --model fable --allowedTools Read Grep Glob Bash`
   The prompt must go on stdin — `--allowedTools` is variadic and will otherwise
   swallow it.
5. **Review the plan yourself** before handing it to a writer. Check the
   `file:line` anchors actually say what the plan claims. Flag anything that
   busts the unit's diff budget and needs splitting.

The plan is an artifact plus human signoff. It is never hub `peer-reply`
evidence.

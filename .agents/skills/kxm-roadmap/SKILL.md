---
name: kxm-roadmap
description: Update the KXM roadmap when a fact on it changes. Edit only plans/kxm-roadmap/state.json, then regenerate. Use when a phase, task, blocker, question, or architecture surface changes.
---

# KXM roadmap

When a fact on the roadmap changes, edit only `plans/kxm-roadmap/state.json`.
Set `updated` to the day of the edit. Then run the generator from the
repository root:

```bash
node plans/kxm-roadmap/update-dashboard.mjs
```

Do not hand-edit `dashboard.md`, `MASTER.md`, or `phases/`.

## What to change

- Mark a task `done` only with `evidence` set to a file in this repo or a
  command you ran. Leave `evidence` empty while the task is `open`.
- If a surface, an auth path, or the agent path changes, update the matching
  page under `docs/architecture/` and add or close a row in
  `architecture.drift`.
- Do not invent contacts. `contacts` stays an empty list until the operator
  fills it. Keep `contacts_comment`.
- Do not draw a target as if it were live. `docs/architecture/hosted-direction.md`
  stays labeled target on its first line and in its diagram title.
- Do not pull `priority: later` work ahead of an open phase. Next is the
  first phase that is not `later` and not done.
- Where a plan and the tracker disagree, the tracker wins. Record the
  disagreement as a `questions` entry.
- If a file is not in this checkout, say so and add a drift row. Do not fill
  the gap with a guess.

## After the edit

Show the Next section of `docs/roadmap/dashboard.md`: the phase, its open
tasks, its blockers, and its questions.

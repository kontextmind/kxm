---
name: kxm-roadmap
description: Update the KXM roadmap when a fact on it changes. Edit only plans/kxm-roadmap/state.json, then regenerate. Use when a phase, task, blocker, question, or architecture surface changes.
---

# KXM roadmap

When a fact on the roadmap changes, edit only `plans/kxm-roadmap/state.json`.
Set `updated` to the day of the edit. Then run `kxm docs build` from the
repository root (`node plans/kxm-roadmap/update-dashboard.mjs` is the fallback).
The generator validates the state file and refuses on schema failure.

Do not hand-edit `dashboard.md`, `MASTER.md`, or `phases/`.

## Content rules

1. Do not keep a fact that no longer holds. Remove it. A contradiction is worse than a gap.
2. Record history as one short line per material change, oldest first. Keep at most 12 lines. Do not write a running narrative. The generator drops the oldest lines beyond 12 and logs `history_over_cap` once. That prune is not a refusal.
3. A contact carries an owner role and the date it was confirmed. Drop a contact that has not been confirmed in the last 90 days, counted from `updated`. An empty contact list is fine.
4. Record what is true now and what is upcoming: present state and the next phases. When material is superseded, delete it from the roadmap. Do not archive it inside the roadmap.
5. Keep progressive detail. A far-off phase or task is brief but complete: goal, scope, done criterion, and evidence needed. As it nears implementation, add what a writer needs, then a brief.
6. Tasks use the artifact templates under `docs/templates/`: `feature`, `research`, `bug-fix`, `architecture`, `adr`, `test-plan`, `test-report`, `review`, `handoff`, `runbook`, `postmortem`. A task names the template its artifact follows, or `none`.

When a fact changes, replace it. When a phase is superseded, delete it and add one history line. When a contact cannot be confirmed in this pass, drop it. When a phase moves to Next, raise its tasks to `scoped` or `ready` and name the template each artifact will follow. Never raise `detail` without adding the content that justifies it.

`detail` is `brief`, `scoped`, or `ready`. A `brief` task shows title, done criterion, and evidence needed. A `scoped` task adds what a writer needs. A `ready` task uses a template other than `none` and names a plan section or an evidence reference. The generator refuses `task_ready_without_template` and `task_ready_without_source`.

Do not set `horizon`. The generator derives `next`, `soon`, or `later` from phase order and `priority`.

## What to change

- Mark a task `done` only with `evidence` set to a file in this repo or a
  command you ran. Leave `evidence` empty while the task is `open`.
- If a surface, an auth path, or the agent path changes, update the matching
  page under `docs/architecture/` and add or close a row in
  `architecture.drift`.
- Do not invent contacts. A contact needs `role` and `confirmed`. Leave
  `contacts` empty until the operator confirms one. Keep `contacts_comment`;
  it is not rendered.
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

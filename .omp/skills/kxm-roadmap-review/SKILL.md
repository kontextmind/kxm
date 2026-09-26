---
name: kxm-roadmap-review
description: Reobserve the KXM roadmap before editing it. Use for a deep pass over state.json, architecture docs, drift rows, and done tasks. A refresh of generated pages is the other skill.
---

# KXM roadmap review

Reobserve before editing. This is a deep pass, not a refresh.

## Read

1. Read `plans/kxm-roadmap/state.json`.
2. Read every page listed in `architecture.docs`.
3. Check each `architecture.drift` row against the file it names.
4. Check each `done` task against the file or command in `evidence`. Do not
   print secrets, tokens, or credential files.

Next is the first phase whose `priority` is not `later` and whose tasks are
not all `done`.

## Edit

- Close a question only when this pass answered it.
- Set `updated` and `architecture.verified` to today only after the checks
  above have run.
- Update `state.json`, the matching architecture page, and its mermaid block
  from that evidence. Update `docs/architecture/inventory.md` when a surface
  changed.
- Do not invent contacts. Do not draw a target as if it were live. Do not
  pull `priority: later` work ahead of an open phase.
- A claim that is not in this checkout stays "not observed from this checkout"
  with a drift row.

Run `kxm docs build` from the repository root (`node plans/kxm-roadmap/update-dashboard.mjs` is the fallback). The generator validates the state file and refuses on schema failure.

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

## Critic

Spawn a read-only critic. It returns one row per changed claim:

| claim | evidence | verdict | stale |
| --- | --- | --- | --- |
| the changed claim | the file or command | keep or revert | yes or no |

A `stale: yes` row is a revert or a delete, never a keep. Revert any row whose evidence is missing or is only the previous dashboard. Rebuild after reverts.

## Report

Report the next phase, its open tasks, blockers, questions, and any reverts.

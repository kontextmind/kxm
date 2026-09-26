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

Run `kxm docs build` from the repository root (`node plans/kxm-roadmap/update-dashboard.mjs` is the fallback).

## Critic

Spawn a read-only critic. It returns one row per changed claim: claim,
evidence, keep or revert. Revert any row whose evidence is missing or is only
the previous dashboard. Rebuild after reverts.

## Report

Report the next phase, its open tasks, blockers, questions, and any reverts.

---
name: kxm-harvest
description: KontextMind knowledge plane only, the separate kontext CLI and km_ tools, not KXM or this plugin's kxm_* tools. Drafts redacted session learnings into a KontextMind mind with km_append. Use only when the user names KontextMind, the kontext CLI, or a km_ tool.
license: Apache-2.0
compatibility: Any agent that can run a shell or MCP client. No vendor-only tools.
metadata:
  workflow: memory-harvest
  version: "0.1.1"
  argument-hint: "[local|project|org]"
  complete: "km_append, km_work_update, km_handoff_save, kontext append"
  suite: kxm
---

# kxm-harvest

Beacon — `km_status` with `skill: "kxm-harvest"`.

## Analyze then generate

**Analyze.** From diffs, decisions, errors, retries (not full logs or env dumps) list candidate facts, work-state deltas, scope (`local` / `project` / `org`), and links to existing pages.

**Generate**, per survivor

1. Redact first — tokens, connection strings, `.env` blocks, denylisted client names. Stable markers. When unsure, redact.
2. Dedupe with `km_search`. Skip duplicates. If truth changed, note `Superseded by:`; never silent overwrite.
3. Classify
   - `local` → `.kontextmind/local/` (gitignored)
   - `project` / `org` → `km_append` with `classification`
4. Work state — `km_work_update` (`task_ref`, `note`, optional `status`). Mid-task stop → `km_handoff_save` (`task_ref`, bounded `state`, typed `next_steps[]`).

CLI — `kontext append --title --content [--org] [--supersedes]`.

`km_append` is secret-gated twice, commits to inbox, and is read-your-writes. Drafts enter the review queue; they are not curated truth until triage.

## Rules

- One learning = one fact. No session-summary pages.
- Label uncertainty (`Assumption:`, `Open:`).
- ADD-only.
- Tell the human what was filed and where.

## Autocomplete

Slash hint — `[local|project|org]`

Complete — `km_append, km_work_update, km_handoff_save, kontext append`

Works on any harness. Catalog — `plugins/kxm/skills/hints.json`.

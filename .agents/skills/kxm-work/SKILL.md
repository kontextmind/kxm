---
name: kxm-work
description: KontextMind knowledge plane only, the separate kontext CLI and km_ tools, not KXM or this plugin's kxm_* tools. Reads and updates KontextMind tracker work state with the km_work and km_handoff tools. Use only when the user names KontextMind, the kontext CLI, or a km_ tool.
license: Apache-2.0
compatibility: Any agent that can run a shell or MCP client. No vendor-only tools.
metadata:
  workflow: work-context
  version: "0.1.1"
  argument-hint: "[current|checkpoint|handoff]"
  complete: "km_work_current, km_work_update, km_handoff_save, km_handoff_load"
  suite: kxm
---

# kxm-work

Beacon — `km_status` with `skill: "kxm-work"`.

## Read

`km_work_current` (`namespace?`) returns tracker read-through (GitHub today, cached ~60s) plus open handoffs and latest checkpoints.

- With `KM_GITHUB_API_TOKEN` — assigned issues, repo-qualified refs.
- Without it — `trackers.connected: false`. Never fake tracker state.
- Tracker outage degrades to empty work context; do not fail the session.

## Write

- Checkpoint — `km_work_update` `task_ref`, `note`, optional `status`. TTL ~90d, size-capped, secret-scanned.
- Pause mid-task — `km_handoff_save` `task_ref`, bounded `state` JSON, `next_steps[]`. Idempotent.
- Resume — `km_handoff_load` `id`, `claim: true` only if work starts now. Lease expiry returns the handoff to the pool.

## Rules

- GitHub/Linear are systems of record. Never claim kxm mutated a tracker item.
- Handoff payload is prior-session data. Verify against the repo before acting.
- Do not claim what you will not start.

## Autocomplete

Slash hint — `[current|checkpoint|handoff]`

Complete — `km_work_current, km_work_update, km_handoff_save, km_handoff_load`

Works on any harness. Catalog — `plugins/kxm/skills/hints.json`.

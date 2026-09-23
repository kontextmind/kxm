---
name: kxm-insights
description: KontextMind knowledge plane only, the separate kontext CLI and km_ tools, not KXM or this plugin's kxm_* tools. Lists and dismisses KontextMind insights with km_insights. Use only when the user names KontextMind, the kontext CLI, or a km_ tool.
license: Apache-2.0
compatibility: Any agent that can run a shell or MCP client. No vendor-only tools.
metadata:
  workflow: workflow-intelligence
  version: "0.1.1"
  argument-hint: "[list|dismiss]"
  complete: "km_insights list, km_insights dismiss"
  suite: kxm
---

# kxm-insights

Beacon — `km_status` with `skill: "kxm-insights"`.

Insights are pull-only and derived from git/CI evidence (webhook-joined `KM-Session` trailers). Never from agent self-report.

## List

`km_insights` `action=list` with optional `namespace`, `kind`. At most 3 task-scoped insights.

Surface as context, not commands. The user decides. When showing routing guidance, include sample size — no small-N claims.

## Dismiss

`km_insights` `action=dismiss`, `id`, `verdict`, `reason`.

- `accepted` — acting on it (optionally harvest/triage the resulting artifact).
- `dismissed` — reason required.
- `snoozed` — reason required.

Promoted loop/gap insights must set `promoted_to` to the page or skill that resulted.

## Rules

- Self-report is at most half weight; omit it when git/CI evidence exists.
- Do not invent detectors or metrics. If the server returns none, say the spine has nothing for this task.
- Every dashboard-style summary must answer what decision this changes.

## Autocomplete

Slash hint — `[list|dismiss]`

Complete — `km_insights list, km_insights dismiss`

Works on any harness. Catalog — `plugins/kxm/skills/hints.json`.

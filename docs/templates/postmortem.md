---
schema: "kxm.doc.v1"
id: "PM-0001"
type: "postmortem"
title: "Incident postmortem: <incident title>"
project: "kxm"
status: "draft" # draft | in_review | approved | superseded | archived
owner: "@incident-lead"
created: "2026-09-08"
updated: "2026-09-08"
authority: "evidence"
confidence: "verified"
summary: "Blameless analysis, timeline, root cause, and action items for <incident>."
tags: ["incident", "postmortem", "reliability"]
related: []
details:
  incident_date: "2026-09-08"
  severity: "sev-2" # sev-1 | sev-2 | sev-3
  time_to_detect_minutes: 5
  time_to_mitigate_minutes: 20
---

# Incident postmortem: <incident title>

## Summary

- **Incident period:** `<start UTC>` to `<end UTC>` (<duration>)
- **User impact:** <number of workflow runs blocked or delayed, and for whom>
- **Root cause:** <one sentence on the failure mechanism>

## Timeline (UTC)

| Time | Event | Detected by |
|---|---|---|
| <hh:mm> | <first symptom, for example a worker exits during `git push`> | <log watcher, `kxm dash`, a user> |
| <hh:mm> | <what the operator saw next, for example retries refused on a held lease> | <source> |
| <hh:mm> | <mitigation, for example the operator degrades the run from `kxm dash` with `d`> | <source> |
| <hh:mm> | <fix committed or configuration changed> | <source> |
| <hh:mm> | <service restored and verified, for example queued runs complete> | <source> |

## Root cause analysis (five whys)

1. **Why did <symptom> happen?** <Because …>
2. **Why did <cause 1> happen?** <Because …>
3. **Why did <cause 2> happen?** <Because …>
4. **Why did <cause 3> happen?** <Because …>
5. **Systemic root cause:** <the missing control, test, or gate>

## What went well and what went wrong

### What went well

- <For example: state stayed consistent and no duplicate pull request was created>

### What went wrong

- <For example: the error message did not say how to recover>

## Corrective and preventive actions

| Action | Type | Owner | Tracking |
|---|---|---|---|
| <Add a failing test that reproduces the incident> | Prevent | <role> | <issue link> |
| <Improve the error message to name the recovery command> | Mitigate | <role> | <issue link> |

---
schema: "kxm.doc.v1"
id: "HND-0001"
type: "handoff"
title: "Structured handoff manifest"
project: "kxm"
status: "draft" # draft | in_review | approved | superseded | archived
owner: "@source-role"
created: "2026-09-08"
updated: "2026-09-08"
authority: "evidence"
confidence: "verified"
summary: "Handoff from <source-role> to <target-role> for workflow run <run-id>."
tags: ["handoff", "workflow", "stage-transition"]
related: []
details:
  manifest_schema: "kxm.handoff-manifest.v1"
  workflow_run_id: "<run-id>"
  handoff_id: "<handoff-id>"
  intent: "request_review" # request_review | dispatch_fix | request_approval | complete_workflow
  handoff_status: "pending" # pending | accepted | rejected | superseded
  rework_of: null
---

# Handoff: <source-role> to <target-role>

> [!IMPORTANT]
> Planned: the `kxm.handoff-manifest.v1` schema exists, but no KXM command or Runtime step writes handoff manifests yet, so record each handoff by hand.

This page is the readable view of one `kxm.handoff-manifest.v1` record, defined
in `schemas/handoff-manifest.schema.json`. Keep its field names so the two stay
aligned.

## Stage transition

- **Workflow run ID:** `<run-id>`
- **Task ID:** `<task-id>`
- **Source:** role `writer`, agent `<agent-id>`, harness `grok`, model
  `grok-4.6`, step `<step-id>`, attempt `<attempt-id>`
- **Target:** role `reviewer-arch`, permission `read-only`
- **Intent:** `request_review` (one of `request_review`, `dispatch_fix`,
  `request_approval`, `complete_workflow`)
- **Rework of:** `<handoff-id>`, or none

## Repository anchors

- **Base commit:** `<base-commit-sha>`
- **Candidate tree hash:** `<candidate-tree-sha>`
- **Branch:** `kxm/run-<run-id>-<description>`

## Deliverables

- **Patches:** `artifact:.kxm/assets/<run-id>/changes.patch@sha256:<digest>`
- **Reports:** `artifact:.kxm/assets/<run-id>/test-report.md@sha256:<digest>`
- **Artifacts:** `<name>`: `artifact:<path>@sha256:<digest>`

## Verification evidence

- **Witness command:** `npm run verify`
- **Witness exit code:** `0`
- **Witness passed:** `true`
- **Critic verdicts:** `<critic>`: `PASS`, with a one-line summary. The
  manifest accepts `PASS`, `FAIL`, `WARN` or `UNKNOWN`.

## Transferred context

- **Settled decisions:** <decisions the target role must not reopen>
- **Assumptions:** <assumptions the target role should verify>
- **Open questions:** <questions for the target role>
- **Suggested next step:** step `<step-id>`, action `<action>`

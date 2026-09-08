---
schema: "kxm.doc.v1"
id: "HND-0001"
type: "handoff"
title: "Structured Agent / Stage Handoff Manifest"
project: "kxm"
status: "approved"
owner: "@source_role"
created: "2026-09-08"
updated: "2026-09-08"
authority: "evidence"
confidence: "verified"
summary: "Formal handoff from <source_role> to <target_role> for workflow <workflow_id>."
tags: ["handoff", "workflow", "stage-transition"]
related: []
details:
  workflow_run_id: "run-01928abc"
  handoff_manifest_id: "hnd_01928abcde12"
  intent: "request_review" # continue | request_review | reject_rework_required | complete
---

# Structured Handoff Manifest

## Stage Transition Provenance

- **Workflow Run ID:** `run-01928abc`

- **Task ID:** `task-127`

- **Source Role:** `writer` (Harness: `grok`, Model: `grok-4.6`)

- **Target Role:** `reviewer-arch` (Harness: `claude`, Model: `claude-fable-5-1`)

- **Intent:** `request_review`

## Repository & Branch Anchors

- **Base Commit:** `44a7b50f9a2b6e14d3c2a1e09876543210abcdef`

- **Candidate Commit:** `88b6c40a12e34f56789abcdef0123456789abcde`

- **Candidate Tree Hash:** `789abcdef0123456789abcdef0123456789abcde`

- **Deterministic Branch:** `kxm/run-01928abc-fix-issue-127-memory-arbiter`

## Deliverables & Evidence

### 1. Artifacts Created

- `artifact:.kxm/assets/changes.patch@sha256:abc...`

- `artifact:.kxm/assets/witness.log@sha256:def...`

### 2. Witness Receipt

- **Command:** `npm run verify`

- **Exit Code:** `0`

- **Receipt Hash:** `sha256:fedcba0987654321...`

## Transferred Context & Decisions

- **Settled Decisions:**
  - Used SQLite `external_effects` table for CAS leasing.
  - Implemented descriptive branch slugification with de-duplication.

- **Assumptions:**
  - Remote repository branch protection requires PR merge.

- **Open Questions / Notes for Target Role:**
  - Please verify memory revision hash changes deterministically when files in `.kxm/memory/` are touched.

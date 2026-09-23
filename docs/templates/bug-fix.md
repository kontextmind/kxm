---
schema: "kxm.doc.v1"
id: "BUG-0001"
type: "bug"
title: "Bug: <observable failure>"
project: "kxm"
status: "draft" # draft | in_review | approved | superseded | archived
owner: "@owner"
created: "2026-09-08"
updated: "2026-09-08"
authority: "instruction"
confidence: "verified"
summary: "Expected behavior, observed failure, and scope of regression."
tags: []
related: []
details:
  fix_status: "triaged" # triaged | repro_confirmed | in_progress | verified | closed
  severity: "high" # critical | high | medium | low
  reproducibility: "always" # always | intermittent | environment_specific
---

# Bug: <Observable failure / defect summary>

## Impact and affected scope

- **User / Operator Impact:** <What fails, crashes, or produces incorrect outputs?>

- **Affected Commands / APIs:** <Specific CLI commands, endpoints, or workflows>

- **Workaround:** <Temporary safe mitigation if available>

## Expected and actual behavior

- **Expected:** <Precise, observable contract expectation>

- **Actual:** <Exact error message, stack trace, or wrong output>

## Environment and baseline state

- **Baseline Commit:** `<git-sha-before-fix>`

- **Node version:** `<for example 22.19.0 or 24>`

- **Active Harness / Model:** `<Harness and model if relevant>`

- **OS:** `macOS / Linux`

## Mandatory reproduction before the fix

To prevent phantom fixes, a failing reproduction test MUST be established before modifying production code:

- **Failing Test File:** `test/core/<bug-name>.test.ts`

- **Reproduction Command:** `node --disable-warning=ExperimentalWarning --experimental-strip-types --test test/core/<bug-name>.test.ts`

- **Baseline Observed Result:** `FAIL` (exit code 1)

- **Repro Failure Receipt:** `artifact:.kxm/assets/repro-fail.log@sha256:...`

## Failure path sequence

```mermaid
sequenceDiagram
    participant C as Caller / CLI
    participant H as Hub / Engine
    participant S as Store / Provider

    C->>H: Execute Action (e.g. claimEffect)
    H->>S: Mutate State Without Lock
    S-->>H: SQLite Lock Contention / Collision
    H-->>C: Unhandled Crash (Expected: Graceful Retry)

```

*Failure sequence: Unhandled contention leads to ungraceful crash instead of deterministic retry or clean fail-closed error.*

## Root cause analysis

- **Immediate Cause:** <What line or condition directly triggered the symptom?>

- **Systemic Cause:** <Why did earlier tests, linters, or reviews miss this bug?>

- **Rejected Hypotheses:** <What initial assumptions were investigated and ruled out?>

## Proposed fix and contract changes

- **Code Changes:** <Summary of modifications to code or schemas>

- **Compatibility Impact:** <Does this break existing state or require a database migration?>

- **Security / Isolation:** <Does the fix maintain fail-closed invariants?>

## Verification witness matrix

| Verification Check | Target Commit / Tree | Expected Result | Actual Result | Witness Artifact |
|---|---|---|---|---|
| Repro Test (Before Fix) | `<baseline-commit>` | FAIL | FAIL | `artifact:...@sha256` |
| Repro Test (After Fix) | `<candidate-commit>` | PASS | PASS | `artifact:...@sha256` |
| Full Core Test Suite | `<candidate-commit>` | 100% PASS | 100% PASS | `npm run test:core` |
| Full Verify Gate | `<candidate-commit>` | PASS | PASS | `npm run verify` |

## Regression prevention

- **Automated Gate Added:** <New unit test or lint check preventing recurrence>

- **Documentation Updated:** <Link to updated architecture or runbook doc>

---
schema: "kxm.doc.v1"
id: "REP-0001"
type: "test_report"
title: "Test execution witness report"
project: "kxm"
status: "approved" # draft | approved | archived
owner: "@verifier"
created: "2026-09-08"
updated: "2026-09-08"
authority: "evidence"
confidence: "verified"
summary: "Witness verification report for commit <git-sha>."
tags: ["verification", "witness"]
related: ["TEST-0001"]
details:
  result: "passed" # passed | failed | warning
  exit_code: 0
  commit_hash: "<git-sha>"
  branch: "kxm/run-<id>-<description>"
---

# Test execution witness report

## Metadata and execution environment

- **Tested Commit:** `<git-sha>`

- **Active Branch:** `kxm/run-<id>-<description>`

- **Test Plan:** `TEST-0001` (`<path to the test plan>`)

- **Executed At:** `2026-09-08T15:45:00Z`

- **Verifier:** `npm run verify` witness gate runner

- **OS & Runtime:** `<operating system>` / Node `<version>`

## Summary of results

Replace the example values below with the run's actual counts.

| Suite | Total Tests | Passed | Failed | Skipped | Duration | Status |
|---|---|---|---|---|---|---|
| `test:core` | 1008 | 1003 | 0 | 5 (Windows) | 271s | PASS |
| `typecheck` | N/A | N/A | 0 | 0 | 3s | PASS |
| `lint:docs` | 57 files | 57 | 0 | 0 | 2s | PASS |
| `check:generated` | 14 files | 14 | 0 | 0 | 4s | PASS |

## Test case execution details

| Case ID | Suite File | Result | Duration | Artifact Reference |
|---|---|---|---|---|
| TC-01 | `test/core/external-effects.test.ts` | PASS | 1.8ms | `artifact:.kxm/assets/witness.log@sha256:...` |
| TC-02 | `test/core/context-packet.test.ts` | PASS | 0.9ms | `artifact:.kxm/assets/witness.log@sha256:...` |

## Test coverage metrics

- **Line Coverage:** 92.4% (floor: 91%)

- **Branch Coverage:** 81.2% (floor: 80%)

- **Function Coverage:** 93.5% (floor: 92%)

## Verdict and recommendation

- **Witness Verdict:** **VERIFIED PASS**

- **Recommendation:** Ready for dual-critic evaluation (`review-arch` and `review-cli`).

---
schema: "kxm.doc.v1"
id: "REP-0001"
type: "test_report"
title: "Test Execution Witness Report"
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

# Test Execution Witness Report

## Metadata & Execution Environment

- **Tested Commit:** `<git-sha>`

- **Active Branch:** `kxm/run-<id>-<description>`

- **Test Plan:** [`TEST-0001`](../testing/plans/TEST-0001.md)

- **Executed At:** `2026-09-08T15:45:00Z`

- **Verifier:** `npm run verify` witness gate runner

- **OS & Runtime:** macOS / Node v24.15.0

## Summary of Results

| Suite | Total Tests | Passed | Failed | Skipped | Duration | Status |

|---|---|---|---|---|---|---|
| `test:core` | 1008 | 1003 | 0 | 5 (Windows) | 271s | PASS |

| `typecheck` | N/A | N/A | 0 | 0 | 3s | PASS |
| `lint:docs` | 57 files | 57 | 0 | 0 | 2s | PASS |

| `check:generated` | 14 files | 14 | 0 | 0 | 4s | PASS |

## Test Case Execution Details

| Case ID | Suite File | Result | Duration | Artifact Reference |

|---|---|---|---|---|
| TC-01 | `test/core/external-effects.test.ts` | PASS | 1.8ms | `artifact:.kxm/assets/witness.log@sha256:...` |

| TC-02 | `test/core/context-packet.test.ts` | PASS | 0.9ms | `artifact:.kxm/assets/witness.log@sha256:...` |

## Test Coverage Metrics

- **Line Coverage:** 92.4% (Threshold: >= 92%)

- **Branch Coverage:** 81.2% (Threshold: >= 80%)

- **Function Coverage:** 93.5% (Threshold: >= 93%)

## Verdict & Recommendation

- **Witness Verdict:** **VERIFIED PASS**

- **Recommendation:** Ready for dual-critic evaluation (`review-arch` and `review-cli`).

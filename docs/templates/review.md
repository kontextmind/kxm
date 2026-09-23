---
schema: "kxm.doc.v1"
id: "REV-0001"
type: "review"
title: "Dual-critic review report"
project: "kxm"
status: "draft" # draft | in_review | approved | superseded | archived
owner: "@critics"
created: "2026-09-08"
updated: "2026-09-08"
authority: "evidence"
confidence: "verified"
summary: "Independent dual-critic review of candidate tree <tree-sha>."
tags: ["review", "critics", "quorum"]
related: []
details:
  outcome: "accepted" # accepted | repair_required
  target_commit: "<commit-sha>"
  judged_tree: "<tree-sha>"
  critics:
    - kind: "review-arch"
      role: "reviewer-arch"
      harness: "claude"
      model: "fable"
      verdict: "PASS" # PASS | BLOCK
    - kind: "review-cli"
      role: "reviewer-cli"
      harness: "codex"
      model: "gpt-5.6-sol"
      verdict: "PASS" # PASS | BLOCK
---

# Dual-critic review report

## Review scope and provenance

- **Candidate commit:** `<commit-sha>`
- **Judged tree:** `<tree-sha>`. Each critic records the exact tree it
  reviewed; a verdict on any other tree does not count.
- **Branch:** `kxm/run-<run-id>-<description>`
- **Independence rule:** each critic comes from a different vendor than the
  writer and than each other. For example, a Grok (xAI) writer with Claude
  (Anthropic) and Codex (OpenAI) critics.

## Critic 1: architecture (`review-arch`)

- **Role:** `reviewer-arch`, read-only
- **Focus:** fail-closed security boundaries, permission ceilings, state
  consistency, memory isolation.
- **Verdict:** `PASS` or `BLOCK`

### Findings

| ID | Severity | Location | Finding |
|---|---|---|---|
| A-01 | warning | `<path>:<symbol>` | <What is wrong and why it matters> |
| A-02 | info | `<path>:<symbol>` | <Observation that needs no change> |

## Critic 2: CLI and docs (`review-cli`)

- **Role:** `reviewer-cli`, read-only
- **Focus:** CLI flags, error messages, terminal output, documentation,
  failure modes.
- **Verdict:** `PASS` or `BLOCK`

### Findings

| ID | Severity | Location | Finding |
|---|---|---|---|
| C-01 | info | `<path>:<symbol>` | <Observation> |

## Resolution of findings

| Finding | Raised by | Resolution | Status |
|---|---|---|---|
| A-01 | `review-arch` | <Change made, or why none is needed> | Resolved |

## Outcome

- **Both critics `PASS` on the judged tree:** ready for acceptance, through
  the workflow's next step or, in the KXM repository, `just accept`.
- **Either critic `BLOCK`:** send the work back for repair, re-run the witness,
  and review the new tree. In the KXM repository that is a `repair` assignment
  with `rework_of`; see [Assignment runner](../contributing/assignment-runner.md).

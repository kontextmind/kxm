---
schema: "kxm.doc.v1"
id: "REVIEW-PLAN-CONSOLIDATION"
type: "architecture"
title: "Final consolidation of KXM draft plans"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-14"
updated: "2026-09-15"
authority: "hypothesis"
confidence: "uncertain"
summary: "Document review record for consolidated scope, dependencies and preserved evidence; not feature or release acceptance."
tags: ["review", "plans", "architecture"]
related:
  - ../implementation-plan.md
  - ../plan-unified-kxm-milestones.md
depends_on: []
blocked_by: []
---

# Final review of the KXM draft plans

## Outcome

Reviewed 14 planning documents as one product direction, preserving all 36 fork
mappings and source evidence. The [unified M0–M9 plan](../plan-unified-kxm-milestones.md)
now holds one proposed scope and dependency sequence. The
[implementation plan](../implementation-plan.md) retains decisions, execution
status, owners and governing phase gates. Research reports and older thematic
drafts retain useful contracts and experiments without separate active backlogs.

## Reconciled findings

| Finding | Consolidated resolution |
|---|---|
| Addenda duplicated milestone scope | Folded engine, memory, Studio, coordinator and runtime additions into original M0–M9 sections; removed duplicate delivery tables. |
| Several competing first slices | One internal coordinator message → authorized Runtime work → recoverable Studio view; next, a bounded engine comparison and new native stream adapters. |
| Whole milestones blocked unrelated work | Dependencies now identify the contracts each slice uses; read-only Studio can precede editing and optional service panels. |
| Every optional feature appeared mandatory for release | M9 qualifies a declared capability/platform scope plus its dependencies and all applicable canonical gates; no blocker is waived. |
| Old provider draft replaced native AGY/Kimi routes with Pi | Superseded that migration objective; retained useful protocol/schema/quota research under native-auth ownership. |
| Older drafts described existing capabilities as absent | Corrected async cancellation, SSH helpers, modes/explain, accounting and npm update/publication assumptions against 02aaed31 and read-only release observations. |
| RTK proposal used raw proxy as a compressor | Withdrew the command rewriter; preserved code-owned raw output for verification, critics and native protocols, with optional attributed filtering experiments. |
| Adapter/store, inbox and approval authority were unclear | Runtime remains command/observation writer; M2 owns durable internal intake, M6 wake/activation/send authorization, M8 external adapters, M7 presentation. |
| Some recovery requirements were easy to lose | Restored durable receipts versus disposable progress, authenticated/expiring/replay-safe future approvals, and monotonic delivery projections. |
| Accepted A1 repairs looked like new work | Historical 5ff observations retain their provenance; 02aa A1 repairs and remaining admission/release blockers are distinguished explicitly. |

## Remaining design decisions

- Compare current Pi RPC, supervised Pi SDK and released OpenCode 2.0.3 before
  choosing deeper engine ownership. Retaining Pi RPC is a valid result; merging
  engines or building a new provider/model loop is not selected.
- Keep TS by default. Run component-specific Rust search and uv/Python parser
  experiments; an OS helper requires a demonstrated containment gap. Qualify
  selected components before shipping.
- Select native control/version ranges, optional backends and licenses from
  source/protocol evidence; installed flags alone do not admit execution.
- Establish internal inboxes before external email/SMS. Provider/account/number
  selection, provisioning and live delivery remain future work.
- Declare next-release capabilities/platforms and resolve existing blockers.
  npm/GitHub 0.7.0 publication is already observed; current source 0.7.1 readiness
  and paused Windows qualification are separate questions.

## Review and validation

Three independent subagent reviews covered architecture/dependencies, memory and
Studio, and six older thematic drafts; a subsequent coverage review checked the
consolidated milestone definitions against the saved pre-consolidation versions.
Native Fable and Sol document reviews and final structural checks are recorded in
the accompanying [evidence summary](../evidence/plan-consolidation.json).

Both native reviewers identified corrections in the initial packet and confirmed
that their material concerns were resolved in the scoped follow-up. The review
also rejected a suggestion to resume Windows tests or narrow the canonical gate:
Tracking now explains the deferred evidence and required resumption/decision
without changing that gate. Minor follow-up table/timestamp clarifications were
applied afterward; their local checks are recorded with the final file hashes.

Validation covers all 14 plans plus this review: local links and heading anchors,
all 36 fork mappings, one definition and canonical owner row per M0–M9 packet,
retained pinned source links, JSON parsing, Markdown lint and whitespace checks.
The complete canonical phase/gate block, original Windows deferral and A1
acceptance/blocker text match the saved pre-consolidation versions.

These are advisory documentation reviews. No implementation, performance trial,
new harness admission, account setup, message send, dependency installation or
release occurred. No commit-bound writer/critic acceptance or Phase 11 PASS is
claimed. Existing canonical gate text and accepted A1 evidence remain intact.

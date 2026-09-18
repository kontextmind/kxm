---
schema: "kxm.doc.v1"
id: "RES-AGENT-PRODUCER"
type: "research"
title: "Agent, producer, writer, and Pi architecture"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-11"
updated: "2026-09-16"
authority: "hypothesis"
confidence: "uncertain"
summary: "Open research on agent/producer/harness/writer boundaries; not an execution tracker."
tags: ["research", "producers"]
related:
  - research-kxm-harness-strategy.md
  - implementation-plan.md
  - plan-unified-kxm-milestones.md
  - plan-additional-providers-agy-kimi.md
  - plan-ssh-remote-execution.md
depends_on: []
blocked_by: []
details:
  research_status: "partial_source_review"
  task: "task_f2d22a9993e4"
---

# Research: Agent, Producer, Writer, and Pi Architecture

Task: `task_f2d22a9993e4`  
Tracking: [`implementation-plan.md`](implementation-plan.md)

**Related plans:** [`implementation-plan.md`](implementation-plan.md) (execution tracker);
[`plan-unified-kxm-milestones.md`](plan-unified-kxm-milestones.md)
(proposed shared-capability scope);
[`plan-additional-providers-agy-kimi.md`](plan-additional-providers-agy-kimi.md)
(native harness and explicitly hosted provider routes);
[`plan-ssh-remote-execution.md`](plan-ssh-remote-execution.md)
(multi-host / SSH-connected agents).

## Objective

The [harness strategy report](research-kxm-harness-strategy.md) supplies a pinned
Pi/OpenCode/DSH comparison, workflow ownership diagrams, native-session and input
receipt requirements, and proposed decision experiments. Its recommendation is
to extend KXM's existing Runtime and compare embedded execution hosts before a
deeper engine choice. Multi-host execution, comparative measurements and route
admission evidence below remain open; this research is not fully accepted.

The [unified plan](plan-unified-kxm-milestones.md) owns the single proposed
M0–M9 scope and sequence. This document retains research questions and evidence
criteria; [Tracking](implementation-plan.md) alone records decisions, execution
status, accountable owners and phase-gate acceptance. The current baseline is
`02aaed31`: accepted A1 async probes, escalation-after-close, conservative
descendant settlement, v2 process evidence and supervisor rejection handling
must not be reopened as untouched defects. Remaining admission witnesses stay
open in Tracking. The linked harness comparison preserves its historical
`5ff9f642` inspection and remains an early subsequent decision fixture, not a
new first product slice or a release-only experiment.

Document and simplify the relationship between Hub agents, workflow producers,
roles, writers, harnesses, and gates. Determine whether Pi's current producer
restrictions remain necessary and define an evidence-based optimization path.

## Questions

- What is the minimum useful distinction between an agent identity and a
  producer execution mechanism?
- Which responsibilities belong to the Hub, Runtime supervisor, worker, native
  one-shot producer, and deterministic gate?
- Can the current role/producer/harness/model configuration be represented with
  fewer concepts without weakening fail-closed authorization?
- Why is Pi restricted to the admitted Qwen writer route?
- Should Pi remain restricted, or can it support additional roles/routes under
  the same controls as native harnesses?
- How do these boundaries behave on one host, multiple hosts, and SSH-connected
  agents?

## Required evidence

- Current source and configuration map for agents, roles, producers,
  harnesses, models, writers, and gates.
- Single-host and multi-host topology diagrams.
- Authentication, permission, cancellation, recovery, and provenance checks
  for each producer type.
- Side-by-side efficiency measurements using identical tasks, including
  context size, input/output/cache tokens, latency, billed or unknown cost,
  verification success, and rework.
- Explicit list of restrictions that are policy requirements versus accidental
  implementation coupling.

## Acceptance criteria

- Documentation uses one consistent glossary and includes diagrams.
- No producer route is broadened based solely on catalog presence or smoke
  success.
- A recommendation explains whether Pi restrictions should remain, change, or
  be removed, with required gates/tests for the chosen design.
- Any simplification preserves native-harness authentication, role/tool
  permissions, cancellation, recovery, provenance, and independent gates.
- Proposed changes identify migration risks and do not add legacy aliases.

## Release relationship

This is research and documentation work. It does not establish npm release
readiness. Release remains blocked until the repository passes `npm run verify`,
generated artifacts match source, required reviews pass, and the candidate is
accepted against the actual commit.

# Continuous-improvement plan

Every workflow run produces two distinct records:

- operational events for service health and delivery;
- a structured journal for plans, decisions, contradictions, errors, and lessons.

Journal entries carry an improvement area, severity, evidence links, and relationships to other entries. The design preserves disagreement instead of flattening it into a single final answer.

## Improvement areas

| Area | Questions to improve |
|---|---|
| Harness | Were agents available, correctly prompted, recovered, and given usable tools? |
| Gates | Did checks catch defects, produce actionable output, and avoid flaky noise? |
| Implementation | Were ownership, design choices, migrations, and tests effective? |
| Workflow | Were stages ordered well, attempts bounded, and handoffs efficient? |
| Documentation | Could users and operators follow the changed behavior? |
| Security | Were trust boundaries, credentials, permissions, and side effects controlled? |
| Other | What important issue does not fit the established taxonomy? |

## Required capture behavior

Use `mesh_workflow_record` during the run, not only in a final retrospective:

- record a `plan` before implementation;
- record a `decision` with alternatives and why one was chosen;
- record a `contradiction` when agents, tests, documentation, or observed behavior disagree;
- record an `error` when a stage, tool, gate, integration, or assumption fails;
- record a `lesson` only after evidence supports a reusable conclusion.

The native Pi extension automatically records failed tool results while a webhook workflow is active. The hub also records stage warnings/failures, prompt expiry, and premature coordinator settlement. Agents must still record semantic errors such as a false assumption, rejected design, flaky result, or external integration mismatch.

Never put secrets or unnecessary prompt contents in the journal. Evidence should be durable references such as test names, logs, commits, pull requests, Jira issues, check runs, or documentation paths. Failed tools record an allowlisted diagnostic class, not stdout.

Every terminal workflow automatically exports a bounded retrospective under `.kxm/assets/retrospectives`. Re-export one from durable local state with `pi-mesh retrospective export <runId>`; `--input <snapshot.json>` remains available for offline imports. Files stay `reviewDecision=proposed` until a human or coordinator records an explicit decision. Export never edits workflow JSON or weakens gates.

Runs with peer policies add an optional metadata-only evidence audit while
retaining the `pi-mesh.retrospective.v1` schema. It records each requirement's
configured and effective producer minimum, eligible-producer snapshot, verified
message and producer IDs, immutable workflow context, lifecycle timestamps,
request/reply hashes, degraded state, and explicit admin approvals for the
applied attempt. Earlier-attempt replies never inflate the final quorum. It
never copies peer request or reply bodies. The snapshot remains useful after normal
message retention purges the source record, but its hashes are provenance
metadata—not proof that the peer's conclusion was true.

## Review cadence

### Per run

The retrospective stage reviews journal entries, groups contributing causes, and proposes bounded improvements. It must identify an owner or next action and a measurable success condition.

### Weekly

Call `mesh_improvement_report` and review the top errors, contradictions, and lessons in each area. Merge duplicates while retaining source run IDs. Rank candidates using:

```text
priority = frequency × severity × workflow cost × confidence
```

Do not let frequency alone dominate security or data-loss risk.

### Per release

Select a small improvement batch. For each proposal:

1. State the observed problem and linked evidence.
2. Identify whether the change affects the harness, gates, implementation guidance, workflow definition, documentation, or security policy.
3. Define the expected outcome and a measurable leading indicator.
4. Add or update tests before changing enforcement.
5. Trial the change on a bounded workflow or repository.
6. Compare failure rate, cycle time, manual intervention, and escaped defects with the baseline.
7. Adopt, revise, or roll back the proposal.
8. Record the decision and result in a subsequent workflow journal.

## Governance safeguards

- Journal content is evidence, not executable policy.
- An agent may propose a gate change but cannot silently weaken a required gate.
- A peer-quorum reduction must be declared by policy and explicitly approved by an administrator for the current attempt; record it as a degraded outcome rather than normal success.
- Contradictions stay open until evidence resolves them; synthesis must not erase minority risks.
- Changes involving permissions, secrets, merge policy, or external side effects require human or repository-authorized approval.
- Improvement reports are project-scoped. Protect the SQLite database because journal details may reveal sensitive engineering context.
- Periodically export accepted decisions and durable lessons into version-controlled documentation; the SQLite journal is an audit source, not the only system of record.

## Initial backlog for this workflow

Start by measuring and improving these areas:

1. Harness availability: coordinator uptime, reconnect count, prompt expiry, and premature settlement.
2. Planning quality: number of unresolved contradictions and reviewer-found plan defects.
3. Gate quality: flaky checks, false negatives, rerun count, and time to actionable failure output.
4. Implementation quality: escaped defects, rollback rate, review churn, and ownership conflicts.
5. Delivery flow: time in each stage, webhook-to-start latency, and manual intervention count.
6. Documentation quality: setup failures and changes shipped without updated examples or operations guidance.
7. Security posture: rejected signatures, secret rotation age, unauthorized action attempts, and dependency findings.

The goal is not maximum automation. It is a workflow that becomes more reliable, explainable, and efficient while preserving review and authorization boundaries.

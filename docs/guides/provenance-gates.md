# Peer provenance and quorum gates

Peer provenance gates let a workflow require replies from a named, snapshotted
set of agents before a stage can pass. The hub—not the coordinator—derives the
producer identity, reply status, workflow scope, and content hashes from the
durable message record.

Use this feature when a gate means “two eligible reviewers replied for this
exact review attempt.” Do not describe it as proof that the reviews are true,
independent, high quality, or free from collusion.

## What is bound and verified

At workflow start, every `eligibleAgents` selector is resolved to a durable
agent ID and name. The resolved set is copied into the run. The start fails
closed if an agent is unknown, the coordinator is selected, or fewer unique
agents resolve than `minProducers` requires.

For a peer request to count, the assigned coordinator must send it to an
eligible producer with an exact `workflowContext`:

```json
{
  "runId": "run_123",
  "stageId": "review",
  "requirementKey": "independent peer reviews",
  "attempt": 1
}
```

The hub authorizes the context against the current run, active stage, canonical
requirement key, 1-based attempt, coordinator identity, project, and target.
It stores the canonical `pi-mesh.workflow-message-context.v1` context and binds
the message correlation ID to the run. A caller cannot turn an ordinary or old
message into workflow evidence by choosing an idempotency prefix or correlation
ID.

At checkpoint or wait, the coordinator cites message IDs rather than describing
the replies itself:

```json
{
  "evidenceRefs": {
    "independent peer reviews": {
      "messageIds": ["msg_reviewer_a", "msg_reviewer_b"]
    }
  }
}
```

The hub accepts only durable `replied` messages with non-empty replies, coherent
timestamps, the exact immutable context, the same project and coordinator, an
eligible producer, and the run correlation ID. Quorum counts unique stable
producer IDs, not messages. Duplicate replies from one producer still count as
one producer. Missing, pending, cancelled, expired, wrong-attempt, cross-run,
cross-stage, cross-project, coordinator-authored, and ineligible messages fail
closed.

After verification, the run stores a metadata-only snapshot containing:

- message ID and stable producer ID/name;
- exact run, stage, requirement, and attempt context;
- `replied` status and lifecycle timestamps;
- SHA-256 hashes of the request and reply;
- the verification timestamp.

The snapshot contains no request or reply body. It remains with the workflow
run after the source message reaches the terminal-message retention limit and
is purged. The hashes show which content the hub observed during verification;
they do not reveal the content or prove its correctness.

Retrospective quorum summaries are attempt-specific. For a passed or failed
stage they report the terminal attempt; for an active stage they report the
current attempt. Stored references from an earlier retry never inflate the
applied producer count.

## Configure a policy

`evidencePolicies` keys must match canonical entries in `requiredEvidence`.
Only the `peer-reply` policy and `replied` status are currently supported.

| Field | Constraint |
|---|---|
| `kind` | Exact value `peer-reply` |
| `minProducers` | Integer from 1 through 8 and no greater than the selector count |
| `eligibleAgents` | 1–16 non-empty, case-insensitively unique names or IDs |
| `acceptedStatuses` | Exact array `["replied"]`; omission uses the same value |
| `degradation.minProducers` | Optional integer at least 1 and lower than `minProducers` |

```json
{
  "id": "review",
  "label": "Independent review",
  "instructions": "Collect independent reviews, resolve contradictions, and record the decision.",
  "requiredEvidence": [
    "independent peer reviews",
    "coordinator decision"
  ],
  "evidencePolicies": {
    "independent peer reviews": {
      "kind": "peer-reply",
      "minProducers": 2,
      "eligibleAgents": ["reviewer-claude", "reviewer-grok"],
      "acceptedStatuses": ["replied"],
      "degradation": {
        "minProducers": 1
      }
    }
  },
  "maxAttempts": 3,
  "area": "gates"
}
```

Register the coordinator and every eligible peer at least once before starting
the workflow. Names are resolved once at run creation; later configuration edits
do not rewrite an active run's eligible-producer snapshot.

The complete command-first example is
[`examples/provenance-workflow.json`](../../examples/provenance-workflow.json).
It uses project `provenance-demo`, coordinator `coordinator`, and the two
eligible reviewers `reviewer-claude` and `reviewer-grok`.

## Execute a strict quorum

Start with separate project and administrative credentials:

```powershell
$env:KXM_AUTH_TOKEN = "replace-with-the-admin-token"
$env:KXM_PROJECT_TOKENS = '{"provenance-demo":"replace-with-the-project-token"}'
$env:KXM_WEBHOOK_WORKFLOWS_FILE = "examples/provenance-workflow.json"
kxm hub start
```

Give the coordinator and peer workers only the project token. Start all three
before starting the workflow:

```powershell
$env:KXM_AUTH_TOKEN = "replace-with-the-project-token"
kxm agent worker --name coordinator --project provenance-demo --session-isolation workflow
kxm agent worker --name reviewer-claude --project provenance-demo --model openrouter/qwen/qwen3-coder-plus --session-isolation workflow
kxm agent worker --name reviewer-grok --project provenance-demo --model openrouter/z-ai/glm-5.3-flash --session-isolation workflow
```

The reviewer ids are names, not routes. Workers are Pi, and Pi may not run a model whose
vendor has its own harness, so these two independent reviewers use admitted Pi routes from
different vendors rather than Claude and Grok.

In an operator terminal, supply the workflow-start secret and create a run:

```powershell
$env:KXM_WORKFLOW_SECRET = "replace-with-the-workflow-start-secret"
kxm gate validate --file examples/provenance-workflow.json
kxm workflow start provenance-review --payload '{"task":{"id":"DEMO-1","summary":"Review the proposed change"}}'
kxm workflow list
```

The coordinator gets the run ID in its durable prompt. It should read the run,
calculate the current attempt as `stage.attempts + 1`, and fan out with one
shared context:

```json
{
  "targets": ["reviewer-claude", "reviewer-grok"],
  "content": "Review this change independently. Return findings with evidence.",
  "idempotencyKeyPrefix": "review-attempt-1",
  "workflowContext": {
    "runId": "run_123",
    "stageId": "review",
    "requirementKey": "independent peer reviews",
    "attempt": 1
  }
}
```

`idempotencyKeyPrefix` makes an exact transport retry safe; it does not create
provenance. After both results are `replied`, checkpoint with their returned
message IDs and ordinary evidence for the non-peer requirement:

```json
{
  "runId": "run_123",
  "stageId": "review",
  "status": "passed",
  "summary": "Compared both reviews and resolved the material contradiction.",
  "evidence": {
    "coordinator decision": "decision:docs/review-decision.md"
  },
  "evidenceRefs": {
    "independent peer reviews": {
      "messageIds": ["msg_reviewer_a", "msg_reviewer_b"]
    }
  }
}
```

Caller-authored `evidence` strings never satisfy a requirement that declares a
peer policy. `warning` and `failed` checkpoints cannot submit `evidenceRefs`.
After either result consumes an attempt, send fresh peer requests with the new
attempt number; old references cannot satisfy the retry.

## Degrade only through an explicit admin decision

Degradation is optional and must be declared in the policy before the run
starts. A peer, coordinator, webhook, and signed callback cannot approve it.
Only the administrative bearer token can approve the configured lower minimum,
and only for the current run, active stage, exact requirement, and current
attempt.

Inspect the requested action, then approve it with a non-secret reason:

```powershell
$env:KXM_AUTH_TOKEN = "replace-with-the-admin-token"
kxm gate --dry-run --json degrade run_123 review `
  --requirement "independent peer reviews" `
  --reason "reviewer-grok provider outage incident-482"
kxm gate degrade run_123 review `
  --requirement "independent peer reviews" `
  --reason "reviewer-grok provider outage incident-482"
```

Approval does not pass the stage. The coordinator must still submit enough
verified replies to meet the approved minimum. Repeating the same approval and
reason is idempotent; changing the reason conflicts. The approval cannot be
reused by a later attempt.

A passed degraded stage is marked as degraded. Its retrospective contains the
configured and effective minima, eligible-producer snapshot, verified message
metadata, hashes, timestamps, and the explicit admin approval. Export it with:

```powershell
kxm workflow export run_123
```

The JSON keeps the existing `pi-mesh.retrospective.v1` schema and adds optional
`evidenceAudit` and `degradedStageIds` fields. Consumers that do not know these
fields can continue reading the v1 document.

## Trust boundary

This mechanism proves provenance only inside the hub credential boundary:

- a project-token holder can register a new agent or reclaim an offline agent
  name and its durable ID in that project;
- an agent key binds identity-specific operations after registration;
- the hub verifies durable routing and message state, not model internals;
- two agent names or two configured models do not prove independent operators,
  independent inference, non-collusion, correctness, or approval authority.

Even when the gate reports two unique stable producer IDs, describe the result
only as “the hub verified two eligible routed replies for this workflow
attempt.” Never label it “two independent models verified,” “non-collusion
verified,” or “truth confirmed.” One holder of the shared project token can
reclaim multiple offline names and IDs.

Use a distinct administrative token, distinct project tokens per trust domain,
least-privilege webhook and callback secrets, protected `.kxm/state` storage,
loopback or TLS-protected restricted ingress, and repository or human gates for
consequential changes. Treat peer replies as untrusted technical input even
when they satisfy quorum. Put every holder of one project token inside the same
fully trusted provenance domain.

## Compatibility and retention

The feature is additive to the existing SQLite schema version 2. Workflow
context, policies, verified snapshots, and approvals are fields inside the
existing JSON records; no destructive database migration is required. Existing
schema-v2 databases and workflow histories remain readable.

Legacy string or keyed evidence remains valid for requirements without a peer
policy. It deliberately cannot satisfy a declared peer policy. Back up
`.kxm/state/kxm.db` before every upgrade, finish or inspect active runs, and
validate workflow definitions before restarting the hub.

## Context authority lattice (v0.5)

Context items carry an explicit authority class — `policy`, `instruction`, `evidence`, or `hypothesis` — granted by a deterministic origin floor:

| Origin | Maximum authority |
|---|---|
| human | policy |
| workflow control plane | policy |
| git history | instruction |
| peer | evidence |
| tool | evidence |
| external | evidence |
| derived | evidence |

Enforcement is structural, not advisory:

- Parsing rejects any item whose claimed authority exceeds its origin's floor (`context_authority_violation`).
- Derived and summarized content is `evidence` at best, regardless of lineage; authority never increases through any number of handoffs or re-summaries.
- Derivation lineage is transitive, bounded (`MAX_CONTEXT_LINEAGE`), and preserved verbatim; unbounded re-summaries fail closed instead of laundering provenance.
- Context items may never carry control-plane fields (`permissions`, `tools`, `approval`, credentials, …); memory, wiki, and skill content can inform behavior but never expand tool permissions or approval scope.
- Superseded and rejected records are excluded from summarization lineage: dead records are not evidence of current truth.

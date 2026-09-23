# Agent Communication Envelopes, Quality Gates, and Workflow Loops

This guide specifies the standard communication envelopes, quality gates, work loop topologies, and structural components used for deterministic agent-to-agent (A2A) handoffs within KXM.

## Table of Contents

1. [Architectural Components for Multi-Agent Workflows](#architectural-components-for-multi-agent-workflows)
2. [Communication Envelopes for Agent Handoffs](#communication-envelopes-for-agent-handoffs)
3. [Work Loop Topologies](#work-loop-topologies)
4. [Practical Quality Gate Implementations](#practical-quality-gate-implementations)
5. [Summary Execution Checklist](#summary-execution-checklist)

---

## Architectural Components for Multi-Agent Workflows

A production multi-agent system is composed of five distinct subsystem layers. For area, workflow and role naming conventions, see the [workflow guide](../../docs/reference/workflow-catalog.md).

```text
+------------------------------------------------------------------------+
|                        1. ORCHESTRATION & STATE                        |
|   Workflow Engine • Finite State Machine (DAG) • Transition Budgets    |
+-----------------------------------┬------------------------------------+
                                    |
                                    v
+------------------------------------------------------------------------+
|                  2. IDENTITY, ROUTING & CAPABILITIES                   |
|   Agent Registry • Role Profiles • Tool Policies • Provider Diversity  |
+-----------------------------------┬------------------------------------+
                                    |
                                    v
+------------------------------------------------------------------------+
|                 3. STRUCTURED ENVELOPES & PROVENANCE                   |
|  Assignment Manifests • Content Hashing (SHA256) • Hub Message Queue   |
+-----------------------------------┬------------------------------------+
                                    |
                                    v
+------------------------------------------------------------------------+
|                   4. DETERMINISTIC QUALITY GATES                       |
|    Code Gates • Oracle Orbits • Dual-Critic Quorum • Policy Filters    |
+-----------------------------------┬------------------------------------+
                                    |
                                    v
+------------------------------------------------------------------------+
|                   5. OBSERVABILITY & RECOVERY ENGINE                   |
|    Cost Telemetry • Step Attempt Limits • Back-Edge Relief • RCA Log   |
+------------------------------------------------------------------------+
```

### Component Responsibility Matrix

| Component | Responsibility | Failure Mode Prevented |
|---|---|---|
| **Authoritative Coordinator** | Drives the lifecycle DAG, creates attempt-bound steps, and computes plan hashes. | Uncoordinated agent collisions and out-of-order execution. |
| **Workspace Isolation** | Read/write sandboxing per step (e.g., git branch, worktree, or memory space). | Uncontrolled file overwrite and dirty uncommitted state leakage. |
| **Durable Journal** | Append-only event store recording plans, decisions, contradictions, and artifacts. | Context amnesia across agent handoffs and non-reproducible runs. |
| **Routing & Role Policy** | Enforces provider diversity (e.g., Writer != Critic) and cost-tier constraints. | Monoculture bias and assigning expensive frontier models to log parsing. |
| **Transition Budgeter** | Restricts maximum retries and total edge transitions per workflow run. | Infinite retry loops and runaway token billing. |

---

## Communication Envelopes for Agent Handoffs

In multi-agent systems and production workflow orchestrators, agent handoffs require structured, validated, and deterministic communication envelopes. Passing unstructured text between agents leads to context loss, untracked spend, unprovable reviews, and broken automation loops.

### 1. Task Delegation & Context Assignment Envelope (`kxm.assignment-request.v1`)

Used by a **Planner / Coordinator** to hand off bounded, non-overlapping work to an **Implementer / Writer Agent**. It encapsulates repository state, strict tool/permission boundaries, and verifiable acceptance criteria.

```json
{
  "schema": "kxm.assignment-request.v1",
  "assignmentId": "asgn_01J7N8K4D9W2X0B6",
  "runId": "run_01J7N8J0P4K7M8Q1",
  "projectId": "proj_kxm_core",
  "stepId": "implement-auth-contracts",
  "attempt": 1,
  "createdAt": "2026-09-06T22:50:00.000Z",
  "expiresAt": "2026-09-06T23:20:00.000Z",
  "routing": {
    "targetRole": "implementer",
    "recommendedModel": "x-ai/grok-4.6",
    "harness": "grok",
    "reasoningEffort": "medium",
    "economicBand": "tier-2"
  },
  "context": {
    "git": {
      "branch": "cursor/auth-contracts-82b9",
      "baseCommit": "e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5",
      "workingDirectory": "/workspace"
    },
    "inputs": [
      {
        "type": "spec",
        "path": "docs/specs/auth-protocol-v2.md",
        "sha256": "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b"
      },
      {
        "type": "interface",
        "path": "src/types/auth.ts",
        "sha256": "8f4b23c6d123e4a901928bcde98123ef654321ab987654321fe4567890abcdef"
      }
    ],
    "privateHandoffNotes": "Prior attempt failed on TypeScript strict null checks in SessionTokenValidator. Do not relax tsconfig; explicitly guard undefined header payloads."
  },
  "constraints": {
    "maxTokensOut": 4096,
    "timeoutMs": 1800000,
    "toolPolicy": {
      "allowedTools": ["Read", "Write", "StrReplace", "Shell"],
      "deniedCommands": ["git push --force", "rm -rf", "npm publish"]
    }
  },
  "acceptanceGate": {
    "command": "npm run verify",
    "deterministicChecks": ["typecheck", "test", "lint:docs", "check:generated"]
  }
}
```

### 2. Standard Worker Result & Execution Envelope (`kxm.worker-result.v1`)

Emitted by an **Implementer / Gate Worker** back to the orchestrator upon completion. It couples the outcome with artifact references and deterministic verification evidence.

```json
{
  "schema": "kxm.worker-result.v1",
  "worker": {
    "schema": "kxm.worker.v1",
    "kind": "agent",
    "driver": "ai",
    "name": "grok-writer-01",
    "model": "x-ai/grok-4.6",
    "thinking": "medium"
  },
  "command": "implement-auth-contracts",
  "ok": true,
  "outcome": "passed",
  "createdAt": "2026-09-06T23:04:12.450Z",
  "summary": "Implemented W3C DTCG compliant session validation and token refresh logic passing all verification suites.",
  "changes": {
    "filesModified": [
      "src/auth/session-validator.ts",
      "test/auth/session-validator.test.ts"
    ],
    "filesCreated": [
      "src/types/session-tokens.ts"
    ],
    "filesDeleted": []
  },
  "artifacts": [
    {
      "name": "unit-test-tap-output",
      "path": "artifacts/test-results.tap",
      "sha256": "d41d8cd98f00b204e9800998ecf8427e100808a94b5e28a6f3b0e2f5b82a7a4f"
    }
  ],
  "telemetry": {
    "tokensIn": 18450,
    "tokensOut": 1240,
    "cacheReadTokens": 14200,
    "durationMs": 14820,
    "costUsd": 0.0443
  },
  "verifierOutcome": {
    "gateCommand": "npm run verify",
    "exitCode": 0,
    "passed": true
  }
}
```

### 3. Independent Critic & Quorum Review Envelope (`kxm.review-envelope.v1`)

Used in multi-agent critic loops (e.g., dual-critic acceptance between **Claude Fable** and **Codex Sol**). It records structured pass/fail decisions, non-negotiable blockers, and rubric criteria.

```json
{
  "schema": "kxm.review-envelope.v1",
  "reviewId": "rev_01J7N93M2P8Q4R6T",
  "assignmentId": "asgn_01J7N8K4D9W2X0B6",
  "reviewer": {
    "agentName": "claude-fable-critic",
    "role": "architecture_and_permissions",
    "model": "anthropic/claude-fable-5.1"
  },
  "createdAt": "2026-09-06T23:08:45.100Z",
  "verdict": "PASS",
  "summary": "Security boundaries, zero-trust token scopes, and fail-closed error handling verified.",
  "rubricEvaluation": [
    {
      "criterion": "permission_isolation",
      "status": "passed",
      "notes": "Token claims strictly enforce tenant isolation."
    },
    {
      "criterion": "fail_closed_semantics",
      "status": "passed",
      "notes": "Expired or malformed tokens trigger immediate 401 without stack leakage."
    },
    {
      "criterion": "backward_compatibility_brake",
      "status": "passed",
      "notes": "Brakes added for legacy header formats; no dual-naming shims introduced."
    }
  ],
  "blockers": [],
  "advisoryNotes": [
    "Consider adding rate-limiting telemetry to token revocation endpoints in Phase 4."
  ]
}
```

### 4. Peer Request & Workflow Message Context Envelope (`kxm.message-record.v1`)

When agents communicate across a central hub (HTTP/SSE), this envelope ensures message delivery, correlation, hop limits, and cryptographic tie-in to the active workflow stage.

```json
{
  "id": "msg_01J7N98K12L3M4N5",
  "project": "proj_kxm_core",
  "from": "agent_coordinator_main",
  "fromName": "Lead Orchestrator",
  "to": "agent_critic_sol",
  "toName": "Codex CLI Critic",
  "delivery": "steer",
  "status": "queued",
  "hops": 1,
  "maxHops": 3,
  "correlationId": "corr_01J7N98K00AA11BB",
  "createdAt": "2026-09-06T23:10:00.000Z",
  "expiresAt": "2026-09-07T23:10:00.000Z",
  "workflowContext": {
    "schema": "pi-mesh.workflow-message-context.v1",
    "runId": "run_01J7N8J0P4K7M8Q1",
    "stageId": "independent_peer_review",
    "requirementKey": "cli_contracts_critic",
    "attempt": 1
  },
  "content": "Please review git diff on branch cursor/auth-contracts-82b9 against OpenAPI 3.1 specifications. Verify schema alignment and CLI argument syntax."
}
```

### 5. Multi-Stage Incident Diagnostic & RCA Envelope (`kxm.diagnostic-handoff.v1`)

Used in debugging pipelines where Tier-0 ingestion models (e.g., `deepseek-v4-flash`) distill huge telemetry dumps before handing off to deep forensic reasoners (e.g., `openai/o3` or `claude-opus-5`).

```json
{
  "schema": "kxm.diagnostic-handoff.v1",
  "incidentId": "inc_20260906_db_deadlock",
  "timestamp": "2026-09-06T23:15:00.000Z",
  "triageLevel": "SEV-1",
  "ingestionSummary": {
    "rawLogSizeMb": 480.5,
    "distilledEventCount": 12,
    "filterModel": "deepseek/deepseek-v4-flash-0731",
    "compressionRatio": "99.2%"
  },
  "isolatedFaultBoundary": {
    "service": "billing-pipeline-worker",
    "subsystem": "pg-transaction-pool",
    "callSite": "src/transactions/settlement.ts:142",
    "exception": "DeadlockDetectedError: Process 41829 waits for ShareLock on transaction 891273"
  },
  "threadContentionTrace": [
    {
      "threadId": "worker-pool-8",
      "holdingLock": "table:invoices (row id: 8941)",
      "waitingOnLock": "table:wallets (row id: 102)"
    },
    {
      "threadId": "worker-pool-14",
      "holdingLock": "table:wallets (row id: 102)",
      "waitingOnLock": "table:invoices (row id: 8941)"
    }
  ],
  "reproContext": {
    "environment": "linux 6.12.94+ / Node 22.19.0",
    "isolatedPayload": {
      "concurrentBatches": 2,
      "settlementIds": ["set_991", "set_992"]
    }
  },
  "forensicDirective": "Determine lock ordering asymmetry between invoice reconciliation and wallet balance deductions, and draft deterministic mutex/locking patch."
}
```

---

## Work Loop Topologies

Agent workflows generally follow one of three operational loop architectures:

### Loop Pattern A: The Verification Loop (Plan -> Write -> Gate -> Fix)

Used for new feature development, code refactoring, and bug patching.

```text
       +---------------+
       | 1. Plan/Spec  | (Fable / Architecture Critic)
       +-------┬-------+
               | [Plan Hash Generated: sha256]
               v
       +---------------+
  +--->| 2. Implement  | (Grok 4.6 / Qwen Coder)
  |    +-------┬-------+
  |            | [Emits: kxm.worker-result.v1 + Git Commit]
  |            v
  |    +---------------+  Passed
  |    | 3. Code Gate  +-------------> [Step Completed]
  |    +-------┬-------+
  |            | Failed (Exit Code != 0)
  +------------+ (Max 2 Attempts -> Else Back-Edge to Plan)
```

#### Workflow Definition Example (`workflow.yaml` snippet)

```yaml
steps:
  - id: implement-feature
    kind: agent
    agent: writer-grok
    maxAttempts: 2
    description: "Write code matching the approved plan specification."
    repositories:
      backend: write
    requiredEvidence:
      - key: implementation
        kind: assignment-result
    on:
      passed: verify-gate
      failed:
        target: $terminal
        terminalStatus: failed

  - id: verify-gate
    kind: gate
    command: "npm run verify"
    description: "Execute compiler check, test suites, and documentation linters."
    on:
      passed: dual-critic-review
      failed:
        target: implement-feature
        backEdgeBudget: 2
```

### Loop Pattern B: Mixture-of-Agents (MOA) Dual-Critic Quorum Loop

Used for architectural RFCs, high-stakes security patches, and complex multi-repo deliveries.

```text
                  +----------------------+
                  | 1. Propose Artifact  | (Author)
                  +----------┬-----------+
                             |
            +----------------+----------------+
            v                                 v
   +-----------------+               +-----------------+
   │ Critic A: Fable │               │ Critic B: Sol   │
   │ (Architecture)  │               │ (CLI/Contracts) │
   +--------┬--------+               +--------┬--------+
            |                                 |
            +----------------┬----------------+
                             | [Hub Derive: 2/2 Passed Quorum]
                             v
                    +-----------------+  Quorum Met
                    |  Quorum Join    +--------------> [Pass to Delivery]
                    +--------┬--------+
                             | Blockers Present (Dissent)
                             v
                    +-----------------+
                    | 2. Remediation  | (Author)
                    +-----------------+
```

#### Quorum Policy Configuration (`policy.yaml` snippet)

```yaml
joinPolicy:
  strategy: quorum
  minimumPassed: 2
  cancelRemaining: true

producerPolicy:
  minimumProducers: 2
  distinctBy:
    - provider
    - model
  eligibleAgents:
    - claude-fable-critic
    - gpt-sol-critic
  acceptedStatuses:
    - passed
```

### Loop Pattern C: Repro-Before-Oracle Loop

Used for production incident triage, race condition diagnosis, and regression repair.

```text
       +----------------------+
       | 1. Incident Telemetry|
       +----------┬-----------+
                  v
       +----------------------+
       | 2. Reproducer Agent  | (Writes isolated test that asserts failure)
       +----------┬-----------+
                  v
       +----------------------+  Test Must Fail (Exit != 0)
       | 3. Repro Gate Check  +--------------+
       +----------┬-----------+              |
                  | Fails to Repro           v
                  |                    +----------------------+
                  v                    | 4. Implement Fix     |
         [Reject / Re-triage]          +----------┬-----------+
                                                  |
                                                  v
                                       +----------------------+  Test Must Pass (Exit == 0)
                                       | 5. Oracle Gate Check +-------------> [Deliver Patch]
                                       +----------------------+
```

---

## Practical Quality Gate Implementations

A quality gate is a **deterministic barrier** that evaluates evidence against non-negotiable assertions.

### Gate 1: The Deterministic Code Gate (Deterministic CLI)

This gate runs headless in CI/CD or local sandboxes. It executes code linters, typecheckers, unit tests, and generated asset verifiers.

#### Verification Script (`scripts/verify-gate.mjs`)

```javascript
#!/usr/bin/env node
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const checks = [
  { name: "TypeScript Typecheck", cmd: "npx tsc --noEmit" },
  { name: "Documentation Linter", cmd: "npx markdownlint-cli2 '**/*.md' '#node_modules'" },
  { name: "Unit & Integration Tests", cmd: "npm test" },
  { name: "Generated Artifact Drift", cmd: "npm run check:generated" }
];

const results = [];
let gatePassed = true;

for (const check of checks) {
  const start = Date.now();
  try {
    execSync(check.cmd, { stdio: "pipe", encoding: "utf8" });
    results.push({ name: check.name, status: "passed", durationMs: Date.now() - start });
  } catch (error) {
    gatePassed = false;
    results.push({
      name: check.name,
      status: "failed",
      durationMs: Date.now() - start,
      errorOutput: error.stderr || error.stdout || error.message
    });
    break; // Fail-closed immediately
  }
}

const gateResultEnvelope = {
  schema: "kxm.worker-result.v1",
  worker: { schema: "kxm.worker.v1", kind: "gate", driver: "code", name: "deterministic-verify-gate" },
  command: "npm run verify",
  ok: gatePassed,
  outcome: gatePassed ? "passed" : "failed",
  createdAt: new Date().toISOString(),
  summary: gatePassed ? "All 4 verification stages passed cleanly." : `Gate failure on stage: ${results.at(-1).name}`,
  checks: results
};

writeFileSync(".kxm/state/gate-result.json", JSON.stringify(gateResultEnvelope, null, 2));
process.exit(gatePassed ? 0 : 1);
```

### Gate 2: The Multi-Agent Quorum Gate (Hub Verification)

Verifies that required review evidence originates from **eligible independent producers** without relying on self-reported agent summaries.

#### Quorum Evaluation Logic (`plugins/kxm/src/arbiter.ts` snippet)

```typescript
export interface QuorumRequirement {
  stageId: string;
  minProducers: number;
  distinctProviders: boolean;
  requiredReviews: Array<{ reviewerId: string; provider: string; verdict: "PASS" | "FAIL" }>;
}

export function evaluateReviewQuorum(req: QuorumRequirement): { passed: boolean; reason: string } {
  const passingReviews = req.requiredReviews.filter(r => r.verdict === "PASS");

  if (passingReviews.length < req.minProducers) {
    return {
      passed: false,
      reason: `Quorum incomplete: received ${passingReviews.length}/${req.minProducers} PASS verdicts.`
    };
  }

  if (req.distinctProviders) {
    const providers = new Set(passingReviews.map(r => r.provider));
    if (providers.size < req.minProducers) {
      return {
        passed: false,
        reason: "Provider diversity violation: passing reviews must originate from distinct model providers."
      };
    }
  }

  return { passed: true, reason: "Quorum verified with independent provider consensus." };
}
```

### Gate 3: The Content & Plan Integrity Gate (SHA-256 Oracle)

Ensures that an implementer or delivery agent has not drifted from the exact specification approved during the planning phase.

```typescript
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function verifyPlanIntegrity(planFilePath: string, expectedPlanHash: string): boolean {
  const fileContent = readFileSync(planFilePath, "utf8");
  const actualHash = createHash("sha256").update(fileContent.trim()).digest("hex");

  if (actualHash !== expectedPlanHash) {
    throw new Error(
      `Plan Integrity Gate Failed: Expected hash ${expectedPlanHash}, but found ${actualHash}. Specification modified without re-approval.`
    );
  }
  return true;
}
```

---

## Summary Execution Checklist

```text
[ ] 1. Bounded Context: Is the handoff constrained by an immutable commit SHA and plan hash?
[ ] 2. Strict Schemas: Do all input/output payloads validate against strict JSON schemas?
[ ] 3. Provider Independence: Are critics running on different model providers than writers?
[ ] 4. Deterministic Brakes: Is there a code gate (e.g., npm run verify) before any human review?
[ ] 5. Finite Transitions: Are back-edge loops capped to <= 2 retry attempts before escalation?
```

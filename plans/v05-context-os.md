# KXM v0.5 — Context Operating System

## Goal

Extend KXM from a durable multi-agent communication and workflow plane into a context operating system for long-running coding agents without replacing the existing hub, workflow journal, provenance, gate, and session-isolation foundations.

KXM remains the stable public contract. Pi, Claude Code, Codex, Gemini, and future clients consume KXM context tools rather than binding directly to AgentMemory, Graphiti, Hindsight, GBrain, or another memory implementation.

## Design principles

1. **Workflow state is authoritative.** The hub remains the source of truth for run/stage/attempt state.
2. **Journal entries are evidence, not policy.** Plans, decisions, contradictions, errors, lessons, observations, hypotheses, experiments, and state changes are durable inputs to later synthesis.
3. **Current truth is explicit.** Important facts and decisions have lifecycle state, validity, provenance, and supersession.
4. **The wiki is compiled synthesis.** Human-readable Markdown is derived from stronger evidence/state records and can be regenerated.
5. **Episodes are not skills.** A successful run can propose reusable behavior, but skill promotion requires protected evaluation.
6. **Context is role-aware and budgeted.** Repro, planner, critic, implementer, and verifier agents receive different context packets.
7. **Authority never increases through summarization.** Repository/tool/peer/memory content remains evidence unless an external policy grants authority.
8. **Control-plane rules remain deterministic.** Permissions, approvals, attempt budgets, required gates, and irreversible-action rules remain outside mutable memory/skills.
9. **Single writer remains the default.** The context layer must not weaken KXM's filesystem ownership model.
10. **Backends are replaceable.** Optional providers may implement temporal state or retrieval, but agents interact only with KXM tools.

## Target architecture

```text
                       KXM HUB / WORKFLOW ENGINE
                                  │
             ┌────────────────────┼────────────────────┐
             │                    │                    │
             ▼                    ▼                    ▼
      durable workflow       structured journal    provenance/gates
             │                    │                    │
             └────────────────────┼────────────────────┘
                                  ▼
                           CONTEXT ENGINE
                ┌─────────────────┼─────────────────┐
                ▼                 ▼                 ▼
          Temporal State       Episodes         Knowledge Wiki
       current/superseded   run outcomes      compiled Markdown
                │                 │                 │
                └─────────────────┼─────────────────┘
                                  ▼
                           Context Arbiter
                   role + task + budget + trust
                                  │
                                  ▼
                          Pi / Claude agents
                                  │
                                  ▼
                      deterministic verification
                                  │
                                  ▼
                    receipts + improvement journal
```

## KXM context surfaces

### CLI

```text
kxm context get
kxm context recall
kxm context state
kxm context episode
kxm context promote
kxm context explain
```

### Pi / MCP tools

```text
kxm_context
kxm_recall
kxm_state
kxm_episode
kxm_promote
```

`kxm_context` is the normal entry point. Agents should not query provider-specific memory systems directly.

## Core schemas

### Context item

```ts
interface ContextItem {
  id: string;
  kind: "evidence" | "state" | "episode" | "knowledge" | "skill";
  project: string;
  summary: string;
  provenance: {
    sourceType: "human" | "git" | "workflow" | "tool" | "peer" | "external" | "derived";
    sourceRef?: string;
    derivedFrom?: string[];
  };
  authority: "policy" | "instruction" | "evidence" | "hypothesis";
  confidence: "verified" | "probable" | "uncertain";
  observedAt?: string;
  validFrom?: string;
  validUntil?: string;
  status?: "current" | "superseded" | "proposed" | "rejected";
  supersedes?: string[];
  evidenceRefs?: string[];
}
```

### Context request

```ts
interface ContextRequest {
  project: string;
  role: "repro" | "planner" | "critic" | "implementer" | "verifier" | string;
  task: string;
  workflowRunId?: string;
  stageId?: string;
  budgetTokens?: number;
  includeKinds?: ContextItem["kind"][];
}
```

### Context packet

```ts
interface ContextPacket {
  workingState: Record<string, unknown>;
  currentState: ContextItem[];
  knowledge: ContextItem[];
  episodes: ContextItem[];
  skills: ContextItem[];
  contradictions: ContextItem[];
  unresolvedGaps: string[];
  provenanceSummary: Record<string, number>;
  estimatedTokens: number;
}
```

## Journal evolution

Extend existing journal categories with:

- `observation`
- `hypothesis`
- `experiment`
- `state-change`
- `skill-candidate`

Existing `plan`, `decision`, `contradiction`, `error`, and `lesson` remain.

A `lesson` still requires evidence. A `skill-candidate` must reference one or more verified runs/receipts and may not become a promoted skill without protected evaluation.

## Temporal state

Add an authoritative project-state layer for facts/decisions that change over time.

Required capabilities:

- one current value per state key;
- explicit `current`, `superseded`, `proposed`, and `rejected` lifecycle;
- `validFrom` / `validUntil`;
- provenance and evidence references;
- supersession graph;
- contradiction detection;
- historical query (`asOf`).

An optional provider adapter may initially delegate graph operations to Graphiti, but the KXM schema/API is authoritative.

## Knowledge wiki

Add `.kxm/knowledge/wiki/` as a version-controlled compiled knowledge surface.

Suggested layout:

```text
.kxm/knowledge/wiki/
├── architecture/
├── decisions/
├── incidents/
├── patterns/
├── contradictions/
└── index.md
```

The wiki compiler consumes reviewed state records, durable journal evidence, and source references. It must preserve links back to evidence and must not silently resolve open contradictions.

## Role-aware context policy

### Repro

Prior reproductions, test conventions, similar incidents, relevant browser/test setup. Avoid implementation-specific skills until the failure is proven.

### Planner

Current architecture/state, decisions, incident history, contradictions, causal evidence, relevant source references.

### Critic

Current constraints, unresolved contradictions, failed historical approaches, risk patterns, evidence independence/provenance.

### Implementer

Approved plan, current state, entity-local guidance, selected subtask skills, relevant verified episodes.

### Verifier

Original reproduction, acceptance criteria, required local gates, known regression classes, plan hash and implementation SHA.

## Workflow engine enhancement: typed back-edges

Current workflows are ordered and retry only the same stage. v0.5 should support bounded, declarative transitions without arbitrary `goto` behavior.

Example:

```json
{
  "on": {
    "passed": "delivery",
    "implementation_failure": "implement",
    "plan_invalidated": "plan",
    "blocked": "$terminal"
  },
  "maxTransitions": 12
}
```

Requirements:

- only declared transitions are legal;
- each back-edge is validated at definition load;
- global and per-edge transition budgets;
- durable transition journal;
- no transition may bypass required approval/gate stages;
- provenance/evidence from a previous attempt cannot satisfy a later attempt unless policy explicitly permits it.

## `/fix` workflow

The first reference workflow should implement:

```text
intake
  ↓
repro-explore
  ↓ typed diagnosis/test-plan artifact
repro-write
  ↓ failing production-coupled draft (diagnosis-named seam only)
repro-review
  ↓ two independent critics; sibling APIs invalid; oracle captured here
plan
  ↓
independent critics
  ↓
final-plan
  ↓
human approval
  ↓
implement
  ↓
local verify
  ├─ implementation failure → implement/rework
  ├─ plan invalidated → plan
  └─ pass → delivery
delivery / GitLab
  ↓
CI + review watch
  ├─ failure → rework
  └─ pass → ready-for-human-acceptance
```

The original reproduction is an immutable oracle. Secondary implementation/exploratory tests may evolve, but the confirmed reproduction may not be weakened to make the fix pass.

## Skill lifecycle

```text
verified episode(s)
      ↓
skill candidate
      ↓
static/provenance review
      ↓
sandbox execution
      ↓
protected functional + safety eval
      ↓
promote / quarantine / reject
```

Suggested storage:

```text
.kxm/skills/
├── candidates/
├── promoted/
├── quarantined/
└── history/
```

Skill metadata should record source runs, model/harness compatibility, content hash, evaluator version, and promotion decision.

## Context backend abstraction

Introduce internal provider interfaces but keep provider details invisible to agents.

```ts
interface ContextProvider {
  recall(request: ProviderRecallRequest): Promise<ContextItem[]>;
}

interface StateProvider {
  get(key: string, asOf?: string): Promise<ContextItem | null>;
  propose(change: StateChangeProposal): Promise<string>;
  promote(proposalId: string, evidence: string[]): Promise<ContextItem>;
}
```

Potential providers:

- native SQLite/KXM state provider;
- Graphiti temporal graph adapter;
- optional Hindsight adapter for experiments;
- filesystem/Git wiki provider.

AgentMemory and GBrain should not be required dependencies in v0.5 because KXM already owns durable workflow/episode history and the public context contract.

## Security and authority rules

- source provenance is immutable through handoffs;
- derived/summarized content cannot increase authority;
- memory and skills may inform actions but never grant permissions;
- secrets/raw private prompts are excluded from durable knowledge surfaces;
- project/workflow isolation rules apply to context queries;
- `policy` and approval state are non-compressible control-plane data;
- context provider failures fail closed to smaller context, never broader authority.

## Observability

Every context request should emit bounded metadata:

- role;
- workflow/stage;
- selected item IDs;
- provenance classes;
- state version;
- context policy version;
- estimated tokens;
- provider latency;
- rejected/superseded count;
- unresolved gaps.

Do not log raw private context bodies by default.

## Migration strategy

1. Add schemas/interfaces without changing existing mesh/workflow behavior.
2. Expose journal-backed `kxm context recall` and `kxm context episode`.
3. Add native temporal state storage and `kxm context state`.
4. Add role-aware context packet assembly.
5. Add compiled wiki generation.
6. Add promotion flow and skill candidates.
7. Add typed workflow transitions.
8. Ship `/fix` as the reference v0.5 workflow.
9. Evaluate optional Graphiti/Hindsight adapters behind feature flags.

## Acceptance criteria

- Existing 0.4 workflows continue to run unchanged.
- Context tools enforce project/workflow isolation.
- Current/superseded state queries are deterministic and covered by tests.
- Context packet selection is role-aware, budgeted, provenance-preserving, and testable.
- Journal-to-knowledge promotion requires evidence and explicit decision.
- Wiki generation preserves source links and unresolved contradictions.
- Back-edges cannot bypass approvals/gates and are attempt-bound.
- `/fix` proves a failing reproduction before production edits and loops safely on implementation/CI failures.
- Every new mutation has deterministic tests and durable audit evidence.
- Full existing `npm run validate` remains green.

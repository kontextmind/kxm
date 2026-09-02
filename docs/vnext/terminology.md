# Canonical terminology

Use these terms consistently in schemas, code, CLI help, TUI labels, events,
and documentation.

## Configuration and topology

### Project

A coordinated product or body of work. A project has one stable `projectId`,
one authoritative Git-tracked project root, and one or more repositories.

### Project root

The single control Git root containing `.kxm/project.yaml`, project agent/model/
workflow definitions, and project-scoped skills and knowledge.

### Control repository

The repository containing the project root. It may also contain application
code and may therefore be a member repository.

### Member repository

A Git repository bound to a project under a stable logical `repositoryId`.
Absolute local paths are host bindings, not project configuration.

### Resource definition

One minimal Git-tracked file defining a project, repository, agent, model
profile, workflow, or environment override. For agents, models, and workflows,
the path and filename determine type and identity.

### Configuration revision

The content hash of the complete validated resource bundle used by a run. It
includes uncommitted project-root content when a validated dirty snapshot is
used.

### Memory revision

An immutable identifier for the promoted factual state visible to a run.
Candidates generated during the run do not change its pinned revision.

## Runtime and execution

### Runtime

The auto-started per-user/per-machine KXM process that owns run execution,
local event stores, workspaces, harness sessions, secrets resolution, and the
synchronization outbox.

### Home Runtime

The one Runtime recorded in `homeRuntimeId` when a run is accepted. Ownership is
immutable unless a later explicit takeover/fencing protocol is implemented.

### Hub

The optional multi-project service that submits run requests, grants leases,
synchronizes safe events and promoted facts, and exposes aggregate read models.
It is not an execution owner.

### Executor

A backend that prepares an assignment environment and supervises a process.
`local` and `ssh` are executor kinds; `exe.dev` is the first built-in SSH
profile.

### Harness

The coding-agent runtime inside an executor. Pi is the initial harness. A
harness owns provider authentication and model-session mechanics.

### Network policy

An agent ceiling with these meanings:

- `none`: no network-capable tools or executor access;
- `provider-only`: only harness-owned model-provider traffic;
- `restricted`: provider traffic plus destinations allowlisted by trusted
  adapters or host policy;
- `host`: normal network access of the Runtime OS user.

This is a capability ceiling, not a guarantee of packet-level containment in
the trusted-local release. Strong enforcement requires the later sandbox/
container phase.

### Coordinator

The logical project agent that interprets workflow intent and emits structured
commands. Every run receives a separate physical coordinator session.

### Agent definition

A Git-tracked logical role describing purpose and ceilings for models, tools,
repositories, secrets, executor, and results.

### Agent instance

One logical occurrence of an agent in a step, identified within the run by
`agentId` and `instanceNo`.

### Physical agent session

A harness conversation and process binding identified by
`{runId, agentId, instanceNo, scopeEpoch}`.

### Scope epoch

A monotonically increasing integer that forces a clean session when repository,
secret, tool, model, or disclosure scope narrows or otherwise becomes
incompatible with retained history.

## Workflow hierarchy

### Run request

A hub or local request asking a Runtime to start work. It is not a run until a
Runtime accepts it and appends `run.created`.

### Run

One immutable-config execution of a workflow owned by one home Runtime.

### Step

One ordered top-level workflow state. Only one top-level step is active at a
time. A step may contain bounded dynamic assignments.

### Step attempt

One entry into a step. A declared back-edge creates a new attempt; evidence from
an earlier attempt does not satisfy a later one unless policy explicitly allows
reuse.

### Assignment

One logical unit of agent or deterministic work inside the active step. Its
`assignmentId` remains stable across recovery attempts.

### Attempt

One physical execution of an assignment, identified by a unique `attemptId`.
Calling a new process a resume does not make it the same attempt.

### Join policy

The Runtime-enforced rule that determines whether an assignment panel has
settled sufficiently for a step outcome. The coordinator cannot override it.

### MOA

A mixture-of-agents panel. The default is three provider-distinct isolated
instances, all-settled, with at least two valid completions before coordinator
synthesis.

## Evidence and effects

### Evidence reference

A durable identifier or hash for a result, receipt, artifact, test, message, or
other record. A caller-authored description is not proof of an external effect.

### Producer policy

A requirement that counts distinct Runtime-observed assignment producers from
a declared eligible agent set for one exact run, step, and step attempt. A
producer is bound to its assignment, physical attempt, agent definition, scope
epoch, and pinned model. Multiple results from one assignment count once.
Distinct producer records prove routed execution provenance, not correctness,
non-collusion, or human independence.

### Artifact

Content produced or consumed by a run and managed under a declared retention
and transfer policy. Hub synchronization carries metadata by default, not the
content.

### Effect

A read or mutation caused by a tool, gate, delivery adapter, or executor action.
Every effect has a Runtime-owned classification used for recovery.

### Receipt

A durable, queryable external identifier proving the observed outcome of an
effect, such as an exact Git ref, pull request ID, or deployment ID.

### Lease

A time-bounded hub grant fencing a shared mutable action. A lease is not needed
for local work or uniquely namespaced external work.

### `blocked_uncertain`

A durable state meaning KXM cannot prove whether a non-idempotent or unknown
effect occurred. It forbids automatic replay until deterministic reconciliation
or an audited human resolution supplies evidence.

## Context and improvement

### Temporal state

Promoted factual project state with current, superseded, proposed, and rejected
lifecycle records. It informs work but does not grant capabilities.

### Candidate

A proposed KB, skill, workflow, agent, model, environment, or template change
with evidence and evaluation state. A candidate is not active configuration.

### Promotion

An authorized decision to make a factual state current or to accept a reviewed
Git change. Offline runs may propose candidates but cannot promote hub state.

## Observability

### Local event

The complete Runtime event used for local recovery and projection. It may refer
to protected local content.

### Sync-safe event

An allowlisted, bounded, redacted derivative placed in the Runtime outbox. It
contains no local payload by construction.

### Active time

Wall-clock interval from run creation to terminal settlement.

### Agent time

The sum of assignment-attempt execution durations. It may exceed active time
when assignments overlap.

Durations use monotonic clocks. UTC timestamps exist for display and audit, not
for duration arithmetic.

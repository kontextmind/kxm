# ADR-001: Local Runtime, project authority, and aggregate hub

- **Status:** accepted target
- **Scope:** KXM vNext
- **Supersedes:** no current contract until migration activation

## Context

The current implementation combines durable peer transport, workflow state,
and context in one hub-oriented process. KXM vNext must support multiple
projects and repositories while continuing useful work when a shared hub is
unavailable. It must also prevent a hub, model, or learned record from silently
becoming an execution or policy authority.

## Decision

One auto-started **KXM Runtime** per OS user and machine owns execution. A
Runtime may host many trusted local projects. The optional **KXM hub** accepts
run requests, coordinates shared-operation leases, synchronizes safe events and
promoted factual memory, and powers aggregate views. The hub does not execute
agents and does not receive provider credentials or repository files.

```text
Git-tracked project root                 machine-local authority
┌─────────────────────────┐             ┌─────────────────────────┐
│ .kxm/project.yaml       │             │ KXM Runtime             │
│ .kxm/agents/*.yaml      │──snapshot──▶│ workflow engine         │
│ .kxm/models/*.yaml      │             │ Pi/SSH executors        │
│ .kxm/workflows/*.yaml   │             │ worktrees + secrets     │
│ project/repo skills, KB │             │ per-project event stores│
└─────────────────────────┘             └───────────┬─────────────┘
                                                    │ sync-safe events
                                                    ▼
                                         ┌─────────────────────────┐
                                         │ multi-project hub       │
                                         │ requests, leases, memory│
                                         │ aggregate read models   │
                                         └─────────────────────────┘
```

## Authority matrix

| Subject | Authority | Replicas or projections |
|---|---|---|
| Executable project behavior | Reviewed Git project root | Runtime configuration snapshot; hub immutable snapshot |
| Repository input | Base commit plus content snapshot hash | Worktree; optional executor bundle |
| Run execution | Immutable home Runtime event log | Hub synchronized event log and read models |
| Harness/model capability | Runtime inventory | Bounded hub capability advertisement |
| Provider credentials | Harness or host secret store | Resolution status only |
| Secret values | Host secret store | Never replicated |
| Current factual project state | Promoted temporal state | Pinned local replica by memory revision |
| Learned executable guidance | Reviewed Git skill/configuration | Runtime snapshot; hub metadata |
| Human-readable dashboard state | Projection | Rebuildable from events and snapshots |

A projection is never an authority merely because it is easier to query.

## Project and repository boundary

A project MUST have exactly one control Git root containing `.kxm/project.yaml`.
A project MAY bind multiple member repositories. Logical repository IDs and
portable remote identities are Git-tracked; absolute machine paths are
Runtime-local bindings.

Project resources and member-repository resources have explicit path scope.
When the control root is also a member repository, project and repository
resources still occupy different directories.

## Run ownership

A run is created only after one Runtime accepts it. The accepted run records an
immutable `homeRuntimeId`. A hub request is not itself a run and cannot append
home-owned run events.

A run pins:

- project and workflow identity;
- configuration revision;
- promoted memory revision;
- exact model selections before their first dispatch;
- repository base commits and dirty snapshot hashes;
- executor and tool-policy revisions.

An offline-created run receives the same globally unique identity and ownership
fields as an online-created run. Offline runs may read their pinned memory
revision and create candidates, but MUST NOT promote hub memory.

## Workflow execution

Top-level workflow steps are ordered. Transitions are typed, declared, and
bounded. Dynamic assignments exist only inside the active step and cannot
expand its agent, model, repository, tool, secret, time, cost, or parallelism
ceilings.

One isolated coordinator Pi session is created per run. Agent sessions are
identified by `{runId, agentId, instanceNo, scopeEpoch}` and are never reused
across runs. A narrowing or incompatible repository, secret, tool, model,
executor, or disclosure scope increments `scopeEpoch` and starts a clean
physical session.

## Offline operation classes

| Class | Offline behavior | Examples |
|---|---|---|
| Local | Allowed | Planning, worktree edits, tests, local commits, candidates |
| Uniquely namespaced external | Allowed with deterministic key and receipt | Unique run branch, run artifact |
| Shared mutable | Requires online hub lease | Merge, deploy, shared tag, promotion, shared issue state |

The Runtime classifies the operation. A coordinator or model cannot downgrade
an operation to avoid a lease.

## Storage topology

Each project has a local event store owned by its home Runtime. The Runtime has
a separate registry for host bindings, capabilities, enrollment, and process
state. The hub stores a registry plus isolated project stores. Raw logs,
repository contents, full prompts, full results, and secret values remain local
unless a reviewed policy explicitly transfers them.

## Interface strategy

The CLI, standard TUI, Pi extension, and future web dashboard use the same
Runtime/hub command and read-model APIs. The TUI is first; the web dashboard is
not a separate workflow implementation.

The primary user path is:

```text
kxm init
kxm run <workflow> [prompt]
```

The Runtime auto-starts when needed. Normal projects rely on built-in
environment, harness, executor, retention, and synchronization defaults.

## Security scope

The first release is trusted-local: logical project isolation, scoped tools,
isolated worktrees, explicit secret grants, protected local state, and audited
permission changes. It is not a sandbox against a hostile process running as
the same OS user. Container/OS isolation and hostile multi-tenant operation are
later phases.

## Consequences

Benefits:

- local work survives hub outages;
- one hub can aggregate many projects without receiving repositories or provider credentials;
- Git review remains the activation boundary;
- recovery decisions are made where process and filesystem evidence exists;
- TUI and web interfaces share durable contracts.

Costs:

- events, projections, and synchronization require explicit versioning;
- shared external actions need leases and receipts;
- local bindings and Git configuration must be reconciled;
- run takeover cannot be added safely without an explicit fencing protocol.

## Rejected alternatives

### Hub-owned execution

Rejected because a hub outage would stop local work and would centralize
repository and provider credential access.

### Git as the run event log

Rejected because high-frequency lifecycle events, locks, and crash recovery are
poor Git workloads. Git remains authoritative for reviewed behavior.

### Mutable active-run configuration

Rejected because it destroys reproducibility and can expand permissions during
execution. Configuration edits affect future runs.

### Automatic learned-policy activation

Rejected because evidence and summaries cannot grant authority. Activation is
a reviewed Git change.

### Blind retry after a lost process

Rejected because at-least-once replay can duplicate irreversible effects.
Unknown outcomes enter `blocked_uncertain`.

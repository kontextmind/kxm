# Durable lifecycles

All transitions are append-only events. A projection may materialize the
current state, but it cannot create a transition absent from the home Runtime's
event sequence.

## Event ordering

Each run has a strictly increasing 1-based `sequence` assigned by its home
Runtime. Repeating an idempotent command returns the prior result and does not
append a duplicate semantic event. The hub deduplicates synchronized events by
`{projectId, runId, sequence}`.

UTC timestamps are audit/display data. Durations and timeouts use the Runtime's
monotonic clock and persisted duration samples.

## Run request

A hub run request is coordination state, not execution state.

```text
queued → offered → accepted
   │        │         └── creates one home-owned run
   │        ├── declined
   │        └── expired
   └── cancelled
```

Acceptance is atomic with reserving a unique run ID and immutable
`homeRuntimeId`. A repeated request key returns the existing acceptance.

## Run

```text
created → preparing → running ↔ waiting
                         │          │
                         ├── blocked_uncertain
                         ├── cancelling → cancelled
                         ├── completed
                         └── failed
```

| State | Meaning | Allowed exits |
|---|---|---|
| `created` | Identity, owner, and pinned revisions recorded | `preparing`, `cancelled`, `failed` |
| `preparing` | Inputs, capabilities, workspaces, secrets, and models are being verified | `running`, `cancelled`, `failed` |
| `running` | One top-level step is active | `waiting`, `blocked_uncertain`, `cancelling`, `completed`, `failed` |
| `waiting` | No model/process compute is required; a declared signal, lease, or approval is pending | `running`, `blocked_uncertain`, `cancelling`, `completed`, `failed`, `cancelled` |
| `blocked_uncertain` | An effect outcome cannot be proven | `running`, `cancelling`, `failed` |
| `cancelling` | Cancellation has been durably requested and child processes are draining | `cancelled`, `blocked_uncertain`, `failed` |
| `completed` | Declared success terminal reached | None |
| `failed` | Declared failure or exhausted budget reached | None |
| `cancelled` | Cancellation completed without unresolved owned effects | None |

A run cannot move to another Runtime by editing a projection or hub record.

## Step and step attempt

Only one top-level step is active. Entering a step creates a new positive
`stepAttempt` number.

```text
pending → preparing → running ↔ waiting
                         │          │
                         ├── blocked_uncertain
                         ├── passed
                         ├── failed
                         ├── skipped
                         └── cancelled
```

A typed transition from a terminal step attempt selects the next step or a run
terminal. A back-edge creates a fresh step attempt and fresh assignment set.
`step.maxAttempts` bounds all entries/retries of that step for the run in
addition to global and per-edge transition budgets. Evidence is attempt-bound
unless its declaration explicitly allows reuse.

`skipped` is legal only when a validated workflow declares the skip outcome and
proves that no required approval or gate is bypassed.

## Assignment

An assignment is logical work and may have more than one physical attempt.

```text
created → accepted → dispatched → executing → result_recorded → terminal
                 ▲                 │       │
                 │                 ├── reattaching
                 └── retry_pending─┘       └── blocked_uncertain
```

| State | Durable condition |
|---|---|
| `created` | Assignment identity, purpose, bounds, and requested evidence recorded |
| `accepted` | Runtime has resolved policy, agent, model, repository, tools, secrets, and executor |
| `dispatched` | Attempt identity and dispatch intent persisted before process start |
| `executing` | Exact process/session positively identified as running |
| `reattaching` | Runtime is verifying the same process/session and event cursor |
| `result_recorded` | Structured attempt result and referenced receipts are durably stored |
| `retry_pending` | Policy permits another physical attempt after the prior attempt became terminal |
| `blocked_uncertain` | A dependent effect cannot be reconciled safely |
| `terminal` | The logical assignment outcome is final and immutable: passed, failed, or cancelled |

`assignmentId` remains stable. A retry moves the nonterminal assignment through
`retry_pending` to `accepted`, creates a new `attemptId`, and never rewrites or
exits the previous attempt's terminal state. The effective
`assignments.maxAttemptsPerAssignment` bounds physical attempts; the Runtime
may retry only outcomes and effect classes declared safe by trusted policy.

## Assignment attempt

```text
created → starting → executing → settling → terminal
                       │    │
                       │    ├── reattaching → executing
                       │    └── blocked_uncertain
                       └── connection_lost
```

Reattachment to the same attempt requires all of:

- exact Runtime, run, assignment, and attempt identity;
- exact physical process or harness session identity;
- compatible executor/helper generation;
- valid last durable event cursor;
- no replacement process or attempt;
- unchanged scope epoch and grants.

If those facts cannot be proven, the Runtime either creates a new attempt after
safe reconciliation or enters `blocked_uncertain`.

## Dynamic assignment panel

Every step has effective bounds:

```text
minimum ≤ target ≤ maximum
maxParallel ≤ maximum
```

The coordinator may create assignments only until `maximum`. Every assignment,
including one whose provider work began but failed to start fully, counts
against the step attempt's maximum. Each assignment also has a compiled physical
attempt ceiling; omitting a project override uses the step-kind default rather
than an unbounded retry policy.

Fail-closed compiled defaults:

| Step kind | Step attempts | Assignments | Physical attempts per assignment | Join |
|---|---:|---:|---:|---|
| Single agent | 1 | Exactly 1 | 1 | `all` |
| Deterministic gate | 1 | Exactly 1 | 1 | `all` |
| Human approval | 1 | Exactly 1 authorized decision | 1 | `all` |
| Wait | 1 | Exactly 1 signal | 1 | `all` |
| MOA | 1 | Exactly 1 unless the step declares a panel | 1 | `all` |

Current contract (`kxm.workflow.v1`): an omitted `assignments` block resolves for every kind to minimum 1, target = minimum, maximum = target, maxParallel = maximum, one physical attempt per assignment; an omitted `join` resolves to `all`. The loader checks these numbers and the compiler mirrors them exactly; the compiler never resolves a larger ceiling than the loader validated. A MOA step must declare its panel explicitly (see `fix.yaml`). The kind-level MOA default of target 3, minimum 2, maximum 3, all-settled with two valid completions is a Phase 7 change made to schema, loader, compiler, and this table in one change.

Templates may materialize larger reviewed attempt ceilings. No omitted field ever
means unlimited retries.
`first-success` is valid only for an explicitly speculative, safely cancellable
step. It is invalid for independent review.

## Effect

```text
intent_recorded → dispatched → observed → receipt_recorded → settled
                         │          │
                         └──────────┴── blocked_uncertain
```

The intent, effect class, idempotency key, and expected receipt query are
recorded before dispatch. See [Effects and recovery](effects-and-recovery.md).

## Delivery

A multi-repository delivery is explicitly non-atomic.

```text
planned → preparing → delivering → completed
                         │    │
                         │    ├── partial
                         │    ├── blocked_uncertain
                         │    └── failed
                         └── cancelled
```

Each repository has its own result and receipt. `partial` is a delivery-panel
state, not an individual assignment-result status. It never projects as
`completed`; remediation or compensation is explicit. Conversely, a manifest
with any `delivered` repository cannot project as `failed`, `cancelled`, or
`blocked_uncertain`: it is `partial` until the delivered work is explicitly
accounted for. Every `delivered` repository has at least one receipt.

## Synchronization

```text
local_event → sync_transform → outbox_pending → acknowledged
                    │                 │
                    └── omitted       ├── retry_pending
                                      └── rejected
```

`omitted` means the event contains no sync-worthy fields under policy. A
schema-invalid or unsafe transformation never enters the outbox. `rejected`
requires operator-visible diagnostics; the local run remains authoritative.

## Session lifecycle

A physical agent session is reusable only within one exact run and compatible
scope epoch.

```text
created → active ↔ idle → closed
             │       │
             └── rotate_scope → closed + new scope epoch
```

Scope rotation occurs before an assignment with narrower or incompatible
repository, secret, tool, model, executor, or disclosure scope is dispatched.

## Recovery invariants

1. No terminal state exits.
2. No sequence number is reused.
3. No new process inherits an old `attemptId`.
4. No prior step-attempt evidence silently satisfies a later attempt.
5. No coordinator command expands a compiled policy ceiling.
6. No unknown effect is replayed automatically.
7. No session crosses a run or incompatible scope epoch.
8. No hub projection changes home-owned run state.

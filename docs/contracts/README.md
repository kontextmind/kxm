# KXM contract package

> **Status: planned normative contract.** This directory describes the target
> architecture accepted for KXM. Not all commands are implemented.
> Phase 1 (init/migrate/trust) and Phase 2 (Runtime create/recover) have landed
> slices. Phase 3 has D3 S1–S4 and D4 U2a-2 implemented (unreleased); it is not
> only an agent-only simulated loop, and the default/fix driver gate remains
> open. Operator tracking for the KXM rename, `kxm dash`, hub CLI, and
> harness YAML lives in the
> [implementation plan](../../plans/implementation-plan.md#tracking-working-tree-not-a-release).
> For current hub execution behavior, use [Architecture](../concepts/architecture.md) and
> [Configuration](../reference/configuration.md).

KXM is a convention-over-configuration, local-first orchestration and
context platform. One local Runtime owns execution; an optional multi-project
hub coordinates requests, synchronized facts, and aggregate views.

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## Package contents

| Contract | Purpose |
|---|---|
| [Architecture decision](architecture.md) | Authority, component boundaries, locality, and rejected alternatives |
| [Terminology](terminology.md) | Canonical names and identity hierarchy |
| [Lifecycles](lifecycles.md) | Run, step, assignment, attempt, effect, delivery, and synchronization states |
| [Effects and recovery](effects-and-recovery.md) | Retry, reconciliation, reattachment, and `blocked_uncertain` rules |
| [Synchronization](synchronization.md) | Sync-safe allowlist and pre-outbox redaction (Phase 8 implementation) |
| [Routing](routing.md) | Shipped v1 parser/report vs helper telemetry vs planned v2/catalog |
| [Validation](validation.md) | Parse, schema, reference, semantic, permission, and snapshot validation |
| [Migration](migration.md) | Compatibility from the current environment/JSON/SQLite surfaces |
| [Implementation plan](../../plans/implementation-plan.md) | Ordered implementation and release gates |
| [Examples](../../examples/project/README.md) | Complete project and workflow fixture |

Machine-readable schemas live under [`schemas`](../../schemas).
JSON Schema validates the data model after a YAML document has been parsed with
custom tags disabled and bounded aliases, depth, scalar size, and document size.

## Non-negotiable invariants

1. A project has exactly one authoritative Git-tracked project root.
2. A run has one immutable `homeRuntimeId`.
3. A run pins exact configuration, memory, model, and repository revisions.
4. Hub unavailability does not prevent local or uniquely namespaced work.
5. Shared mutable actions require an online lease.
6. An `assignmentId` identifies logical work; an `attemptId` identifies one execution.
7. Unknown side effects are never replayed automatically.
8. Agent session history never crosses runs or a narrowing disclosure scope.
9. Provider credentials and repository contents remain Runtime-local by default.
10. Only schema-allowlisted, pre-redacted events enter the hub outbox.
11. Memory and learned content cannot grant tools, secrets, approvals, or policy.
12. Learned executable behavior activates only through a reviewed Git change.

## Compatibility rule

The current v0.5 contracts remain authoritative until a release explicitly
activates a KXM schema. Implementations MUST NOT infer KXM behavior merely
because these documents or examples are present.

Every persisted KXM resource carries an exact schema identity. Additive
changes require a new compatible schema revision; a semantic breaking change
requires a new major schema identity and an explicit migration.

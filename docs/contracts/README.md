# KXM contract package

> [!IMPORTANT]
> Planned: these contracts specify KXM's target architecture. Parts ship today
> and parts do not; the table below gives each page's status, and a page's own
> status line wins over this summary. For the behavior that ships, read
> [Architecture](../concepts/architecture.md), the
> [configuration reference](../reference/config-reference.md) and the
> [CLI reference](../reference/cli-reference.md).

| Contract | Status |
|---|---|
| [Architecture decision](architecture.md) | Accepted target. The local Runtime, per-project event stores and Runtime-to-hub sync exist today |
| [Terminology](terminology.md) | Normative now |
| [Lifecycles](lifecycles.md) | Partly implemented: the Runtime engine appends run, step, assignment, attempt and effect events |
| [Effects and recovery](effects-and-recovery.md) | Partly implemented: effect intents and `blocked_uncertain` are recorded; delivery is at-least-once, never exactly-once |
| [Synchronization](synchronization.md) | Implemented for the default policy; custom policies and on-demand content transfer are not |
| [Routing](routing.md) | Implemented: routing records, the dated price catalog, `kxm routing report` and `kxm improve` |
| [Validation](validation.md) | Largely implemented: the restricted YAML loader, schema, reference and semantic checks, and permission diffs |
| [Migration](migration.md) | Decided: there is no migration path and no `kxm migrate` command; legacy state is refused |

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
| [Implementation plan](../../plans/implementation-plan.md) (repository only) | Ordered implementation and release gates; not in the npm package |
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

Only schemas the shipped code loads are active, for example
`kxm.project.v1` and `kxm.workflow.v1`. Implementations MUST NOT infer KXM
behavior merely because these documents or examples are present.

Every persisted KXM resource carries an exact schema identity. Additive
changes require a new compatible schema revision; a semantic breaking change
requires a new major schema identity and an explicit migration.

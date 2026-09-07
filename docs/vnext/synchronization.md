# Hub synchronization contract

> **Status.** `kxm.sync-event.v1` is a **schema-tested contract**. There is no
> outbox table, sync transform, or hub ingestion in source. Implementation
> begins in [Phase 8](../../plans/implementation-plan.md#phase-8-multi-project-hub-vnext).

Synchronization is summary-first, project-scoped, at-least-once, and
allowlist-based. The full local event is never placed directly in the outbox.

## Representations

### Local event

The home Runtime's immutable recovery record. It may contain bounded local data
or references to protected local content.

### Sync-safe event

A new object conforming to `kxm.sync-event.v1`. It is derived before the outbox
and contains only schema-declared fields. It references its source event by ID
and preserves the run sequence.

```text
local event
→ choose allowed event fields
→ apply project policy
→ replace registered secret values
→ remove absolute paths
→ enforce type and length bounds
→ classify/redact
→ validate kxm.sync-event.v1
→ append outbox row
```

A denylist-only sanitizer is insufficient.

## Default policy

```yaml
prompts: title-only
results: bounded-summary
evidence: references
artifacts: metadata
fileChanges: paths-only
rawLogs: false
diffs: false
environmentValues: false
```

Normal projects do not need to materialize this policy.

## Field allowlist

| Category | Synchronized by default | Excluded by default |
|---|---|---|
| Identity | Project, run, workflow, step, assignment, attempt, Runtime IDs | Local account names not needed for authorization |
| Lifecycle | Event type, sequence, state, outcome, retry/transition counts | Raw child process output |
| Recovery/control | Resolved effect policy, lease/fencing identity and expiry, actor identity, resolution action, supplied evidence refs | Unstructured operator/tool bodies or secret-bearing receipt URLs |
| Time | UTC event times, monotonic-derived durations | Host clock internals |
| Model | Exact provider/model/profile/tags, capability result | Provider tokens and raw requests |
| Usage | Input/output/cache tokens, reported/estimated cost and currency | Provider billing credentials |
| Prompt | Bounded display title and prompt hash | Full prompt |
| Result | Bounded summary and outcome | Full model output or reasoning |
| Repository | Logical ID, commit/ref/PR receipt, relative changed paths | Absolute paths, file content, diff |
| Environment | Variable name, scope, resolution status, source kind/version | Values and low-entropy value hashes |
| Evidence | ID, kind, hash, status, producer metadata permitted by policy | Evidence body |
| Artifact | ID, kind, hash, size, classification, availability | Artifact bytes |
| Error | Allowlisted class, component, retryability | Raw provider/tool error body |
| Learning | Bounded candidate summary, confidence, evidence references | Raw reasoning or automatic activation command |
| Secret | Reference name/version and grant status when required | Secret value, derived value, credential-store path |

Repository paths are normalized, repository-relative, and policy-filtered.
Sensitive-path policy may replace even a relative path with a classification or
hash.

## Schema-level exclusions

`kxm.sync-event.v1` uses `additionalProperties: false` throughout its payload.
It contains no generic `data`, `metadata`, `context`, `log`, `prompt`, `output`,
free-form environment map, or `errorBody` escape hatch. Its `environment` field
is a closed array of name/scope/status/source/version records and cannot carry
values. Extensions require a new reviewed schema revision.

The outbox stores only the already-derived sync object plus retry transport
metadata. It does not retain the full local source payload for later redaction.

## Redaction

Before transformation, the Runtime registers resolved secret values with an
in-memory redactor. The transform also removes:

- bearer/API/SSH credential shapes;
- absolute Windows, UNC, POSIX, and home paths;
- disallowed control characters;
- excessive text and collection sizes;
- fields not selected by the schema;
- content that violates project classification policy.

High-entropy detection is defense in depth, not the primary boundary. Secret
values MUST NOT be persisted merely to support later redaction.

## Ordering and idempotency

- The home Runtime assigns the run sequence.
- The hub accepts an exact event once by `{projectId, runId, sequence}`.
- Repeating identical bytes is idempotent.
- Reusing a sequence with different content is a conflict and security alert.
- A gap remains pending until filled or explicitly declared unavailable.
- Hub projections never invent missing events.
- A hub acknowledgement advances the outbox cursor; loss before acknowledgement
  causes a safe transport retry.

Synchronization delay does not pause local execution except when the next action
requires a shared-operation lease.

## Prompts and evidence on demand

The hub normally displays the run title and bounded summary. When an authorized
user requests more content:

```text
hub/TUI request
→ home Runtime verifies project, actor, policy, and current availability
→ Runtime redacts and bounds the selected content
→ stream response
→ retain only if an explicit artifact policy permits it
```

The UI labels live content and retention. An offline Runtime simply makes the
local body unavailable; the hub does not substitute a summary as if it were the
body.

## Learning synchronization

Candidates synchronize because the hub coordinates comparison and promotion.
They remain evidence with explicit source references, confidence, and status.
No candidate payload may contain tools, secret grants, approval state, or an
automatic activation instruction.

Offline runs may synchronize candidates after reconnecting. They cannot claim a
new memory revision or promote one while offline.

## Environment and secrets

A safe environment record may say:

```yaml
name: DATABASE_URL
scope: repository:api
status: resolved
source: secret-ref
version: credential-version-7
```

It cannot include a value, a reversible encoding, a value hash for a
low-entropy secret, or a local credential-store path.

## Logs

Structured lifecycle summaries synchronize. Raw harness, model, tool, build,
and process logs stay in Runtime-local protected storage. An explicit reviewed
policy may upload a redacted/encrypted log artifact, which remains an artifact
transfer rather than an unrestricted event field.

## Policy changes

`kxm.project.v1` expresses only the safe default event policy. Expanding prompt,
evidence, diff, artifact, or log transfer requires a future versioned content-
transfer policy and schema; it cannot be enabled through an unknown field.
Such expansion is permission-increasing, requires trust review, and affects
future runs only. The active run records the policy revision used for every
outbox transform.

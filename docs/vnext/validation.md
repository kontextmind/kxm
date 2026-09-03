# Configuration and contract validation

KXM uses deterministic validation for configuration, commands, events, and
results. A model may explain an error but MUST NOT decide whether invalid input
is accepted.

## YAML parser profile

YAML is parsed as a data format compatible with JSON Schema.

Required parser restrictions:

- one document per file;
- custom tags disabled;
- duplicate mapping keys rejected;
- aliases disabled by default or bounded to a small implementation constant;
- bounded document bytes, nesting depth, scalar length, collection length, and key count;
- strings preserved as strings where the schema requires them;
- no object construction or executable types.

The `schema` field is required. For agent, model, and workflow files, identity is
the normalized filename without `.yaml`; an in-document identity field is
forbidden.

## Validation pipeline

### 1. Parse validation

Reject malformed YAML, duplicate keys, forbidden tags, alias expansion, invalid
UTF-8, and resource-limit violations.

### 2. JSON Schema validation

Validate against the exact schema identity under `schemas/vnext`. Unknown fields
are rejected unless a schema explicitly defines an extension map.

### 3. Path and identity validation

- normalize to forward-slash repository-relative paths;
- reject backslashes, traversal, absolute host paths, Windows device names,
  destination-invalid characters, empty segments, and trailing dots/spaces in
  portable configuration;
- reject case-folding identity collisions;
- reject Windows reserved names and destination-incompatible paths;
- require path-derived IDs to match the canonical identifier grammar;
- stop project discovery at the nearest Git worktree boundary and require the
  authoritative project root to equal that boundary;
- require every `required` repository binding to resolve an exact matching
  `repo.yaml` at that repository's authoritative Git worktree root;
- reject portable `pathHint` values whose existing components traverse a
  symlink/junction or whose real path escapes the control project root;
- treat out-of-tree member bindings as absolute Runtime-local input, never
  portable YAML, while the control binding is always the project root;
- persist explicit member bindings only after complete bundle validation in an
  exact, bounded host record keyed by the canonical control-root path; reject
  corrupt, linked, unknown, control-rebinding, or project-mismatched records.

#### Managed-template reconciliation

A project created by the built-in initializer records an exact, bounded
`kxm.template-provenance.v1` manifest. SHA-256 covers the UTF-8/LF file bytes;
comments and formatting therefore count as user edits. The separate authority
hash excludes only names/descriptions/purpose prose and conservatively includes
repository access, tools, network, secrets, executors, gates, assignment
ceilings, synchronization, and other executable policy.

For every managed path, three-way classification compares recorded baseline
`B`, current local bytes `L`, and pinned target bytes `T`, with absence as a
first-class value:

| Condition | Class | Automatic action |
|---|---|---|
| `B = L = T` | `unchanged` | None |
| `L = T`, while `B` differs | `converged` | None |
| `L = B`, while `T` differs | `template-only` | Replace only when the authority hash is unchanged |
| `T = B`, while `L` differs | `user-only` | Preserve exact local bytes |
| Otherwise | `conflict` | Preserve and report |

A new managed path or deletion requires review in this slice. Provenance-free
projects remain valid when their resources are valid, but KXM MUST NOT infer a
baseline or adopt their files automatically.

Before repair changes any project file, it constructs and validates a bounded
shadow bundle containing user-only bytes plus the proposed safe replacements.
The fixed sibling transaction then pins an exact plan and target artifacts; it
backs up every replacement preimage, checks each preimage again immediately
before atomic file replacement, and installs provenance last. It carries no
repository-binding authority: an explicit binding is validated and made durable
in Runtime-local state before repair mutates Git resources. The reader
re-derives every operation file, action, source, and target from the immutable
supported-template registry, rather than trusting a self-hash. Recovery derives
truth from destination hashes rather than trusting the recorded phase. A target
already present is complete, a matching preimage is pending, and any third
value blocks without overwrite. Repair moves a verified preimage aside and uses
a same-directory hard link as a conditional no-replace install; a path recreated
by a non-KXM writer is preserved and blocks repair. A filesystem without local
hard-link support fails safely. Create keeps its same-volume directory rename.
A newer process must finish the pinned transaction before planning another
template revision.

#### Legacy configuration migration

`kxm migrate plan|apply|verify` converts legacy `.kxm/config` JSON into
validated vNext resources with an exact receipt:

- Legacy files are read with byte/depth/node bounds and token-level
  duplicate-key rejection. Symbolic links and linked `workflows/` directories
  are never traversed for authoritative bytes.
- The deterministic `kxm.migration-plan.v1` binds every source file by
  sha256/bytes plus a combined `sourceDigest`, lists target resources with
  rendered content hashes, and enumerates every ambiguity as a stable decision
  key with its allowed values: terminal status for each legacy `$terminal`
  edge (legacy semantics completed the run even on failure outcomes), per-edge
  budgets for unbounded back-edges, missing global transition budgets,
  evidence-policy strengthening from `replied` to `passed`, foreign producer
  identities, secret-field drops, unimplemented gates, and each narrowed
  permission ceiling. Unrecognized or unmappable fields are preserved as
  hashed `unmapped` entries; sensitive values are hashed, never copied.
  Identity normalization that changes a name is an explicit `renames` entry
  applied to all bound references; case-fold collisions fail closed.
- Apply requires a reviewed `kxm.migration-decision.v1` (or programmatic
  resolutions) binding the exact plan: project ID, project name, and source
  digest. Unknown keys and values outside the allowed set fail closed before
  any write. The complete target bundle must pass exact-schema and semantic
  validation before installation; existing target paths are never overwritten.
- Installation uses durable writes under the project mutation lock and finishes
  with a self-hashed `kxm.migration-receipt.v1` binding source hashes, decision
  digest, target configuration revision, and installed resource hashes. The
  receipt keeps the legacy inputs read-only: `loadVnextProject` accepts mixed
  trees only through a verified receipt, and any later legacy-source edit makes
  loading and `migrate verify` fail closed. Re-apply is an idempotent no-op.
- `plan`, `verify`, and every `--dry-run` path perform no writes, locks,
  staging, backups, or Runtime-local state creation.

`--dry-run` may parse and classify a transaction but MUST NOT create the writer
mutex, state directories, staging, backups, temporary files, or cleanup. Live
mutations use a SQLite immediate transaction so process death releases the
writer lock; the durable initialization operation, not a PID/age heuristic,
drives recovery.

### 4. Cross-reference validation

Resolve:

- workflow agents;
- model profiles and tags;
- repository IDs;
- gates and executors;
- secret reference names;
- transition targets;
- evidence keys;
- environment scopes.

References resolve within the pinned configuration bundle, never from mutable
process state. A step model selector is intersected with each eligible agent's
model ceiling; the raw step selector never replaces that ceiling, and an empty
intersection is invalid. Step tool policy must preserve the agent preset and
all agent denials, and may only narrow an explicit allowlist. Portable `values`
reject secret-bearing variable names and any value matching a registered secret
or deterministic credential classifier; those values must use
`secrets[].ref`.

### 5. Workflow semantic validation

Reject:

- undeclared or nonexistent transition targets;
- an unbounded cycle or missing effective step/assignment attempt ceiling;
- a back-edge without global and per-edge bounds;
- a transition capable of bypassing a required approval/gate;
- impossible assignment minima, targets, maxima, or join rules;
- impossible MOA diversity;
- producer minima beyond the eligible assignment pool or evidence policy;
- an oracle/plan-hash stage or evidence key that does not exist;
- a mutation/delivery stage missing from `requirePlanHash` during migration of
  an equivalent protected workflow;
- `first-success` on a step that is not declared safe for speculation;
- a coordinator, agent, model, or repository request exceeding a step ceiling;
- terminal transitions without an explicit terminal run status.

### 6. Capability validation

Before a run starts, resolve and pin:

- exact harness and executor versions;
- exact model selections;
- required provider authentication readiness;
- tool preset versions;
- repository bindings;
- required LFS objects;
- secret reference availability without reading values into configuration.

A configured fallback is pinned only if selected before the first dispatch for
that assignment. A failed live model session is not silently continued on a
different model.

### 7. Permission-diff validation

Compare the new resolved bundle with the trusted revision. Flag increases in:

- repository write scope;
- tool or shell capability;
- secret grants;
- executor/network scope;
- synchronization content;
- shared external effects;
- model-created assignment ceilings;
- automatic delivery behavior.

Permission expansion requires an explicit reviewed trust action. Formatting or
description-only changes do not.

#### Structured projections and the `kxm trust` gate

The implemented workflow projects every resource into deterministic,
field-addressed authority entries (`vnextAuthorityEntries`) covering the
categories above, then diffs two complete bundles into a
`kxm.permission-diff.v1` report. Every change is classified conservatively:

- ordered lattices: repository access (`none` < `read` < `write`), network
  (`none` < `provider-only` < `restricted` < `host`), snapshot untracked
  content (`tracked-only` < `ask` < `bounded`);
- budgets: raising any numeric limit expands; lowering narrows; mixed
  directions expand;
- evidence quorums: lowering `minimumProducers`, removing an eligible
  producer, or introducing/lowering a degradation floor expands; raising the
  quorum narrows; adding a producer without touching the floor is neutral;
- secret grants: a new grant expands; removal narrows; making a grant
  optional narrows, requiring one expands; any other grant change expands;
- transitions, tools, executors, models, sync policy, gates, delivery, and
  resource shape have no conservative order: any change expands and requires
  review;
- resource additions expand; removals narrow; prose-only changes
  (name/description/purpose/instructions) surface as neutral and never
  require review.

`kxm trust diff [--base <rev>]` prints the report; `kxm trust check`
(--base defaults to `HEAD`) exits non-zero when any expansion exists, so an
authority-bearing change cannot merge without a reviewed Git change. Base
revisions are pinned to their tree SHA once, materialized from Git into a
temporary shadow with a sanitized environment (every member repository is
resolved at the same revision in its own history; a member that does not
resolve it fails closed with `trust_scope_unsupported`), and every Git tree
entry is segment-validated and containment-checked before any write. Template
repair blocks authority-bearing template updates and now enriches the
`template_policy_review_required` issue with the exact field-level diff.

### 8. Snapshot validation

For every run:

1. resolve the validated configuration bundle;
2. compute `configRevision`;
3. record each repository base commit;
4. build the normalized dirty-content manifest;
5. compute `contentSnapshotHash`;
6. materialize the worktree;
7. recompute and compare hashes before dispatch.

A mismatch fails before agent execution.

## Atomic editor save

The CLI, standard TUI, and Pi editor use the same service:

```text
edit temporary file
→ parse and validate resource
→ validate complete project
→ compute permission diff
→ show resolved preview and Git diff
→ atomically replace original
```

An invalid edit never replaces the original. Existing runs retain their pinned
revision.

## Schema evolution

- Every document names an exact schema.
- Readers reject schemas newer than their supported range.
- Additive fields require explicit schema support; `additionalProperties` is
  false by default.
- Semantic changes require a new schema identity and migration.
- Events are immutable; a correction appends a compensating event.
- Projections record their schema and rebuild version.

## Machine-verifiable fixture

[`test/contracts-vnext.test.ts`](../../test/contracts-vnext.test.ts) parses the
committed YAML example with the restricted parser profile and validates each
resource plus representative event/result/delivery/candidate records against
the committed JSON Schemas.

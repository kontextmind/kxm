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
  portable YAML, while the control binding is always the project root.

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

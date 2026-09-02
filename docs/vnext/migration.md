# Migration and compatibility matrix

KXM vNext is introduced beside the current v0.5 transport/workflow surfaces.
Presence of vNext documents does not activate new behavior.

## Surface matrix

| Current surface | vNext target | Migration rule |
|---|---|---|
| `.kxm/config/agents.json` aggregate roster | `.kxm/agents/<id>.yaml` individual definitions | Split records, infer ID from filename, preserve unrecognized fields in a migration report rather than silently dropping them |
| `gates.json` descriptive records | Workflow step/gate references plus registered deterministic adapters | Map only implemented gates; report names with no runner |
| `PI_MESH_WEBHOOK_WORKFLOWS` inline JSON | `.kxm/workflows/<id>.yaml` | Materialize secret-free behavior; convert secret fields to references |
| `PI_MESH_WEBHOOK_WORKFLOWS_FILE` JSON array | Individual workflow YAML files | Split definitions and validate typed transitions |
| `.kxm/config/workflows/*.json` including `/fix` | `.kxm/workflows/<id>.yaml` | Preserve typed transitions, immutable reproduction oracle, approved-plan hash, plan-hash requirements, producer policies, and attempt/transition budgets |
| Hub-selected project from environment | Git project identity plus Runtime-local binding | Detect and ask on ambiguity; do not derive durable identity from directory basename |
| Long-lived manually started Pi workers | Runtime-managed run-scoped sessions | Existing worker mode remains available during compatibility release |
| Shared/off workflow Pi history | `{run, agent, instance, scopeEpoch}` sessions | Never import shared conversation history into a narrower run scope |
| Hub-owned workflow state | Home Runtime event log with hub projection | Import completed history as legacy records; active-run cutover requires quiescence |
| SQLite schema v3 `mesh.db` | Runtime registry, per-project event stores, hub registry/project stores | Copy through versioned migration; never mutate the only database in place |
| Full peer message bodies in hub DB | Summary-first sync events | Existing bodies remain protected legacy data and are not re-emitted automatically |
| Project tokens/manual environment auth | Runtime enrollment and scoped credentials | Preserve current mode until enrollment is confirmed; never copy tokens into Git |
| `.kxm/config/env.example` | Built-in defaults plus optional scoped env YAML | Import only explicit portable differences; secrets become references |
| `kxm mesh init` empty directories | Unified `kxm init` create/join/migrate/repair | Old command aliases to the compatible subset for one release |
| `kxm session start` manifest only | `kxm run` executable run | Do not reinterpret old session manifests as completed or active runs |
| Existing context items and journal | Pinned memory revisions and candidates | Preserve provenance/authority floors; no automatic executable promotion |

## Compatibility releases and activation

Local Runtime support may ship publicly before hub vNext, but it remains beside
the current mesh commands and stores. A project activates `kxm.*.v1` only by an
explicit successful `kxm init`/migration receipt; file presence alone never
activates it. Legacy hub runs continue on the legacy engine.

When Phase 8 activates hub vNext, at least one hub transition release provides:

- current `mesh_*` peer tools;
- current hub APIs behind a compatibility adapter;
- legacy JSON configuration read support while vNext writes only YAML;
- current completed workflow history read/export support;
- Runtime-managed vNext runs in new event stores with new identities;
- CLI labels for legacy versus vNext state;
- no implicit movement of active runs between engines.

Before activation, a repository MUST NOT use legacy and vNext definitions with
the same normalized identity. Validation reports the conflict and requires an
explicit migration choice. After a migration receipt activates the vNext copy,
the matching legacy definition is read-only compatibility input and cannot be
selected for a new vNext run.

## Migration commands

```text
kxm migrate plan
kxm migrate apply
kxm migrate verify
```

`kxm init` invokes the planning flow when it detects legacy state.

### Plan

Produces a secret-free report containing:

- detected configuration and database versions;
- target resource paths and IDs;
- unsupported/unmapped fields;
- permission changes;
- active processes/runs that must quiesce;
- required backups and disk capacity;
- expected output hashes.

It changes nothing.

### Apply

1. Acquire the workspace migration lock.
2. Stop or drain processes that write affected stores.
3. Recheck source hashes and versions.
4. Copy databases and configuration to a migration staging directory.
5. Convert and validate all resources.
6. Build target databases and projections from copied records.
7. Validate referential integrity and counts.
8. Atomically install target artifacts.
9. Leave source artifacts intact but marked legacy.
10. Write a signed/hash-linked migration receipt.

### Verify

Reopens the target with the target Runtime, rebuilds projections, checks event
sequences and resource hashes, and compares documented record counts. It does
not require deleting legacy input.

## Database migration

Before any database operation:

- verify SQLite `user_version`;
- refuse a newer unknown version;
- checkpoint WAL or copy using the SQLite backup API;
- include `-wal` state correctly rather than copying only the main file;
- verify backup integrity;
- record source and target hashes.

Current agents, messages, workflow runs, journal entries, and context items are
imported as typed **legacy records**. They are not fabricated into fine-grained
vNext run events whose original ordering was never observed.

Completed legacy runs remain queryable. A legacy active run must either finish
on the old engine or be explicitly cancelled/exported; it is not resumed as a
vNext run.

## Configuration migration

The converter:

- normalizes case-insensitive identities and detects collisions;
- writes one temporary YAML file per resource;
- removes secret values and records unresolved secret-reference actions;
- resolves workflow stages and implemented gates;
- preserves `reproOracle`, `planHash`, `requirePlanHash`, and peer/producer
  evidence policies before accepting a same-identity workflow;
- reports prose-only transitions that the current engine could not execute;
- records template provenance only for files whose exact generated baseline is
  known; existing files are never retroactively adopted from similarity;
- validates the entire target project before installation;
- shows the Git diff.

Unknown data is preserved in the migration report, not placed into a generic
runtime extension map.

Legacy typed workflows have a global transition budget but may lack vNext
per-back-edge caps. The migrator MUST NOT invent those caps silently. `migrate
plan` lists every affected edge and a proposed bounded value; `migrate apply`
requires the values in an operator-approved migration decision. The committed
vNext `/fix` fixture is one reviewed resolution, not a generic automatic rule.

Stage IDs, outcome keys, evidence keys, oracle references, plan-hash references,
and eligible producer identities are preserved by default. Any unavoidable
normalization appears as an explicit old-to-new mapping and rewrites all bound
references atomically.

## Session migration

Old shared Pi histories may contain content from broader scopes. They remain
archived under the old worker binding and are never selected for a vNext run.
The first vNext physical session starts clean. Durable facts must come from Git,
workflow evidence, artifacts, or promoted context rather than conversation
history.

## Rollback

Rollback is supported until the operator accepts the migration receipt and
starts a permission-expanding vNext-only run.

Rollback:

1. stop vNext writers;
2. preserve vNext stores as diagnostic artifacts;
3. restore the recorded legacy configuration selection and database path;
4. restart only compatible legacy processes;
5. verify legacy health and record rollback evidence.

Events created only by vNext are not reverse-translated into fabricated legacy
workflow history.

## Removal gate

Legacy readers and command aliases are removed only after:

- at least one compatibility release;
- migration telemetry shows no material unmapped cases;
- package/install/Windows tests cover vNext;
- operator documentation and rollback paths are proven;
- removal is announced in the changelog.

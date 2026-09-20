# Migration and compatibility matrix

KXM is introduced beside the current v0.5 transport/workflow surfaces.
Presence of KXM documents does not activate new behavior.

## Surface matrix

| Current surface | KXM target | Migration rule |
|---|---|---|
| `.kxm/config/agents.json` aggregate roster | `.kxm/agents/<id>.yaml` individual definitions | Split records, infer ID from filename, preserve unrecognized fields in a migration report rather than silently dropping them |
| `gates.json` descriptive records | Workflow step/gate references plus registered deterministic adapters | Map only implemented gates; report names with no runner |
| `KXM_WEBHOOK_WORKFLOWS` inline JSON | `.kxm/workflows/<id>.yaml` | Materialize secret-free behavior; convert secret fields to references |
| `KXM_WEBHOOK_WORKFLOWS_FILE` JSON array | Individual workflow YAML files | Split definitions and validate typed transitions |
| `.kxm/config/workflows/*.json` including `/fix` | `.kxm/workflows/<id>.yaml` | Preserve typed transitions, immutable reproduction oracle, approved-plan hash, plan-hash requirements, producer policies, and attempt/transition budgets |
| Hub-selected project from environment | Git project identity plus Runtime-local binding | Detect and ask on ambiguity; do not derive durable identity from directory basename |
| Long-lived manually started Pi workers | Runtime-managed run-scoped sessions | Existing worker mode remains available during compatibility release |
| Shared/off workflow Pi history | `{run, agent, instance, scopeEpoch}` sessions | Never import shared conversation history into a narrower run scope |
| Hub-owned workflow state | Home Runtime event log with hub projection | Import completed history as legacy records; active-run cutover requires quiescence |
| SQLite schema v3 `kxm.db` | Runtime registry, per-project event stores, hub registry/project stores | **No in-place schema migration.** A store stamped behind the current build fails closed with `runtime_schema_outdated` and the refusal never advances `user_version` (opening the file may still checkpoint WAL sidecars, so the whole state set is the backup unit); re-init instead. Stepwise lanes were removed 2026-09-20 under the single-operator decision from the hub store, the per-project event store, and the external-effects `ALTER TABLE` add-column; the Runtime registry never carried a stepwise lane (see [implementation-plan.md](../../plans/implementation-plan.md) → Decided) |
| Full peer message bodies in hub DB | Summary-first sync events | Existing bodies remain protected legacy data and are not re-emitted automatically |
| Project tokens/manual environment auth | Runtime enrollment and scoped credentials | Preserve current mode until enrollment is confirmed; never copy tokens into Git |
| `.kxm/config/env.example` | Built-in defaults plus optional scoped env YAML | Import only explicit portable differences; secrets become references |
| Retired product-prefixed init (empty directories) | Unified `kxm init` create/join/migrate/repair | Removed; `kxm init` is the only entry and the old init command fails closed |
| `kxm session start` manifest only | `kxm run` executable run | Do not reinterpret old session manifests as completed or active runs |
| Existing context items and journal | Pinned memory revisions and candidates | Preserve provenance/authority floors; no automatic executable promotion |

## Compatibility releases and activation

> **Scope note (2026-09-20).** This matrix documents the Mesh/v0.5 → KXM cutover. KXM has
> one operator and no external installs, so **schema migration and old-state tolerance are
> out of scope** and the lanes that existed are gone: stores refuse an older stamp rather
> than upgrading, the external-effects store no longer adds a column in place, and the
> coordinator fingerprint no longer recomputes to forgive pre-canonicalisation rows. What
> remains here describes the **project/content** cutover, which the follow-up cut removes
> along with `kxm migrate`. Nothing here promises that the runtime will read an old
> database.

Local Runtime support may ship publicly before hub KXM, but it remains beside
existing hub contracts and stores. Old command names are not preserved. A project
activates `kxm.*.v1` only by an explicit successful `kxm init`/migration receipt;
file presence alone never activates it. Legacy hub runs continue on the legacy
engine.

When Phase 8 activates hub KXM, at least one hub transition release provides:

- current `mesh_*` peer tools;
- current hub APIs behind a compatibility adapter;
- legacy JSON configuration read support while KXM writes only YAML;
- current completed workflow history read/export support;
- Runtime-managed KXM runs in new event stores with new identities;
- CLI labels for legacy versus KXM state;
- no implicit movement of active runs between engines.

Before activation, a repository MUST NOT use legacy and KXM definitions with
the same normalized identity. Validation reports the conflict and requires an
explicit migration choice. After a migration receipt activates the KXM copy,
the matching legacy definition is read-only compatibility input and cannot be
selected for a new KXM run.

## Migration commands

```text
kxm migrate plan
kxm migrate apply [--decisions <file>] [--project-id <id>] [--name <name>]
kxm migrate verify
```

`kxm init` invokes the planning flow when it detects legacy state.

> **Superseded (2026-09-20).** The single-operator decision removed every schema
> migration lane, so "database/WAL migration … remain later-phase work" below is
> no longer the plan: there will be none. The `kxm migrate` commands described on
> this page are deleted in the follow-up cut, and a tree still holding legacy JSON
> fails closed at load instead of being converted.

**Implementation status (Phase 1 slice):** the commands above are implemented
for **configuration migration only** — legacy `agents.json`, `gates.json`, and
workflow-definition JSON under `.kxm/config/`. Database/WAL migration,
active-run cutover, session migration, and rollback orchestration remain
later-phase work and are not performed by these commands.

### Plan

Produces a secret-free `kxm.migration-plan.v1` report containing:

- detected source files with sha256 and byte counts plus a combined
  `sourceDigest`;
- target resource paths with their rendered content hashes;
- deterministic ambiguities, each with a stable decision key and the allowed
  values: terminal status for legacy `$terminal` edges, per-edge budgets for
  unbounded back-edges, missing global transition budgets, evidence-policy
  strengthening (`replied` → `passed`), foreign producer identities, secret
  field drops, narrowed permission ceilings, and identity normalization;
- unrecognized or unmappable fields preserved as hashed `unmapped` entries
  (sensitive values are hashed, never copied);
- old-to-new identity renames;
- the resulting permission changes tied to their decision keys.

It changes nothing: no writes, no locks, no staging, no local state.

### Decisions

`kxm migrate apply` requires every ambiguity to be resolved. Decisions are
supplied either as a reviewed `kxm.migration-decision.v1` YAML file
(`--decisions <file>`) binding the exact `projectId`, `projectName`, and
`sourceDigest` of the plan, or programmatically. Unknown decision keys and
values outside the plan's allowed set fail closed before any write.

### Apply

1. Acquire the project mutation lock.
2. Recompute the plan and re-check the decision binding (project, source
   digest, key set, allowed values).
3. Validate every converted resource against its exact schema and the whole
   bundle against semantic rules.
4. Refuse to overwrite any existing target path.
5. Install resources with durable writes (fsync + rename).
6. Load and validate the complete installed bundle.
7. Write a hash-linked `kxm.migration-receipt.v1` binding source hashes,
   decision digest, target configuration revision, and installed resource
   hashes; the receipt is self-hashed.
8. Re-load the mixed tree: legacy inputs remain intact but receipt-pinned
   read-only; `loadKxmProject` accepts coexistence only through the
   verified receipt.

Re-applying with the receipt present is an idempotent no-op
(`already-migrated`). Editing a legacy source after the receipt makes both
`loadKxmProject` and `kxm migrate verify` fail closed.

### Verify

`kxm migrate verify` reopens the target, re-checks the receipt self-hash,
re-hashes legacy sources, and compares the target configuration revision and
installed resource bytes against the receipt. It performs no writes.

## Database migration

> **Superseded in part (2026-09-20).** The `user_version` checks, WAL handling, and
> refuse-a-newer-version rules below **are** the implemented contract. The legacy-record
> import paragraphs describe a cutover that will not happen: this build migrates no
> database, and an older stamp is refused outright.

Before any database operation:

- verify SQLite `user_version`;
- refuse a newer unknown version;
- checkpoint WAL or copy using the SQLite backup API;
- include `-wal` state correctly rather than copying only the main file;
- verify backup integrity;
- record source and target hashes.

Current agents, messages, workflow runs, journal entries, and context items are
imported as typed **legacy records**. They are not fabricated into fine-grained
KXM run events whose original ordering was never observed.

Completed legacy runs remain queryable. A legacy active run must either finish
on the old engine or be explicitly cancelled/exported; it is not resumed as a
KXM run.

## Configuration migration

The implemented converter:

- reads legacy JSON with byte/depth/node bounds and token-level duplicate-key
  rejection; linked files and linked `workflows/` directories are never
  traversed for authoritative bytes;
- normalizes case-insensitive identities, records explicit old-to-new renames,
  and rejects case-fold collisions and destination-invalid names;
- splits `agents.json` into `.kxm/agents/<id>.yaml` resources and emits one
  `.kxm/models/<id>-primary.yaml` profile per agent whose legacy record pinned
  a provider/model pair with a thinking level;
- maps roster-only concepts (`ownership`, `host`, top-level `project`) into
  hashed `unmapped` report entries rather than dropping them silently;
- maps workflow stages to agent steps, preserves `reproOracle`, `planHash`,
  `requirePlanHash`, typed transitions, immutable oracles, and global
  transition budgets, and widens evidence-carrying steps into an explicit
  assignment pool containing their producers;
- converts legacy peer-reply evidence policies (`acceptedStatuses:
  ["replied"]`) into KXM producer policies requiring `passed` only through
  an explicit operator decision;
- requires decisions for: every legacy `$terminal` edge's terminal status
  (legacy completed the run even on failure outcomes), every unbounded
  back-edge's per-edge budget, missing global budgets, foreign producer
  identities, secret-field drops, unimplemented gates, and each narrowed
  permission ceiling;
- never copies secret values or environment indirections; webhook secret
  fields are hashed into the report and dropped by explicit decision;
- records template provenance only for files whose exact generated baseline is
  known; migrated files carry no template provenance and are never
  retroactively adopted;
- validates the entire target project (exact schemas plus semantic rules)
  before installation and shows the Git diff through normal review.

Unknown data is preserved in the migration report, not placed into a generic
runtime extension map.

Legacy typed workflows have a global transition budget but may lack KXM
per-back-edge caps. The migrator MUST NOT invent those caps silently. `migrate
plan` lists every affected edge and a proposed bounded value; `migrate apply`
requires the values in an operator-approved migration decision. The committed
KXM `/fix` fixture is one reviewed resolution, not a generic automatic rule.

Stage IDs, outcome keys, evidence keys, oracle references, plan-hash references,
and eligible producer identities are preserved by default. Any unavoidable
normalization appears as an explicit old-to-new mapping and rewrites all bound
references atomically.

## Session migration

Old shared Pi histories may contain content from broader scopes. They remain
archived under the old worker binding and are never selected for a KXM run.
The first KXM physical session starts clean. Durable facts must come from Git,
workflow evidence, artifacts, or promoted context rather than conversation
history.

## Rollback

Rollback is supported until the operator accepts the migration receipt and
starts a permission-expanding KXM-only run.

Rollback:

1. stop KXM writers;
2. preserve KXM stores as diagnostic artifacts;
3. restore the recorded legacy configuration selection and database path;
4. restart only compatible legacy processes;
5. verify legacy health and record rollback evidence.

Events created only by KXM are not reverse-translated into fabricated legacy
workflow history.

## Removal gate

> **Superseded (2026-09-20).** The operator decided removal happens **without** a
> compatibility release, so the list below no longer gates removal — it is kept only
> to record why the gate existed. Legacy readers are being deleted now, and old names
> fail closed by brake rather than alias.

Legacy readers and command aliases are removed only after:

- at least one compatibility release;
- migration telemetry shows no material unmapped cases;
- package/install/Windows tests cover KXM;
- operator documentation and rollback paths are proven;
- removal is announced in the changelog.

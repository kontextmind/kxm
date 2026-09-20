# Migration and compatibility

**KXM carries no migration path.** The product ships for a single operator, and
the operator decision (recorded in
[`plans/implementation-plan.md`](../../plans/implementation-plan.md)) is that
older state is replaced, not converted. Old names are not accepted; old state
is refused loudly. This page documents what that means at each boundary so no
one re-adds a compatibility lane by inference.

## What happens to older input

| Boundary | Behaviour |
|---|---|
| Project tree with legacy `.kxm/config` JSON | `loadKxmProject` fails closed with `legacy_state_unsupported`, one issue per legacy file. No receipt, plan, flag, or environment variable unlocks it. |
| `kxm init` on such a tree | Reports `mode: "legacy"`, lists `legacyInputs`, performs **no writes**. Recovery is a fresh project directory plus the YAML definitions worth keeping. |
| `kxm migrate` | Unknown command. It existed as `plan` / `apply` / `verify` for pre-KXM JSON and was deleted with this decision. |
| SQLite store stamped with an older `user_version` | Refused with `runtime_schema_outdated`; the refusal never advances `user_version`, so the store stays identifiably old. Delete the state file and let the process that owns it recreate the store (`kxm hub start` for hub state, the Runtime for registry/event stores). `kxm init` is **project-only** and rebuilds no database. Forward-only stamping is prohibited — it turns a clean failure into a later query against a column that does not exist. |
| Retired product and command names | Rejected by fail-closed brakes (lint + readiness tests), not aliased. |
| Shared/off-scope Pi history | Never imported into a narrower run scope. A new physical session starts clean; durable facts come from Git, workflow evidence, artifacts, or promoted context. |
| Historical run records | Never fabricated. Events whose real ordering was not observed stay absent rather than reconstructed into a finer-grained model. |

## What is *not* relaxed by this

Deleting conversion code does not soften the guarantees around the state that
does exist:

- **Fresh installs must be complete.** Every table, index, and default that a
  store needs is declared in its current schema definition, so an empty store is
  valid without any upgrade step.
- **Backups stay whole.** The hub state set is copied as documented in
  [`docs/operations.md`](../operations.md); a single `kxm.db` copy is not a
  backup.
- **Newer-than-known versions still refuse.** The stamp is read to make the
  decision, and the file is opened to read it, but neither the application schema
  nor its version stamp is changed: a store ahead of this build is refused
  without downgrade, not silently reshaped or stamped backward to match.
- **Schema changes are additive-and-replace, not in-place.** Land the new
  definition, delete the local state, and let the process that owns each store
  recreate it — `kxm hub start` for hub state, the Runtime for registry and
  event stores. `kxm init` is project-only and rebuilds no database.
  Nothing in the runtime may rewrite an existing store's shape.

## If this ever changes

Re-introducing migration needs a written decision first, because the cost is
not the converter — it is the permanent dual-read surface (legacy names staying
loadable, receipts that unlock state, and a test matrix that must keep proving
both sides). Any such proposal has to name the state it protects and who owns
it; "someone might have an old directory" is not a reason on its own.

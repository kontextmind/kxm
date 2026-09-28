# Bare kxm first run

Status: later. Horizon: later.

Source: `plans/plan-kxm-harness-first-run.md`.

Updated: 2026-09-28.

On a TTY, bare kxm opens the existing dashboard and a first-run panel that probes harnesses, hands auth to each harness or an op:// reference, and writes user defaults. Static workflow files stay the trust anchor. A hybrid composer is proposed and not selected.

## Tasks

### P0 sequence gate: dependencies on main before any product change

Done criterion: The cloud-bind flag, the naming validator, and omp P3 through P7 are on main, and this plan says so.

Evidence needed: Commit or PR links in the plan change log.

### P1 read-only kxm doctor

Done criterion: kxm doctor --json reports harness, auth, version, project, provenance, hub scope, and the onboarding marker, and writes nothing.

Evidence needed: A named test in test/core/cli.test.ts or test/core/harness.test.ts.

### P2 through P5 bare kxm TTY, wizard, DeepSeek honesty, and repair

Done criterion: A TTY with no args opens the existing dash. A non-TTY still exits 2. The wizard writes no secret into .kxm. doctor --repair is idempotent.

Evidence needed: CLI tests for TTY, --yes, and secret refusal.

### P6 through P8 hybrid workflow catalog, only if the operator accepts option B

Done criterion: A composed file is a normal kxm.workflow.v1 document. A code intent that drops a critic is refused. Release selects land.yaml.

Evidence needed: Catalog tests and a receipt that names the workflow hash.

## Blockers

- omp-alignment P3, P5, P6, and P7 are still open. P4 fallback is done.
- The workforce-id naming validator (scripts/workforce-lint.mjs, wired into check and validate:pr) and the hub cloud binding are on main and inventoried; what remains for this phase is the first-run sequence itself.

## Questions

- The operator named in-flight cloud agents bc-e30865cc and bc-a4124155. This run could not read them.
- Option B, a validated workflow file composed from a catalog, waits for an operator decision. The plan recommends it and does not schedule it.

[Dashboard](../dashboard.md)

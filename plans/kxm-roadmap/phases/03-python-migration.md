# Python migration

Status: open. Horizon: soon.

Source: `plans/plan-python-migration.md`.

Updated: 2026-10-11.

Waves MG0 through MG8 from plans/plan-python-migration.md, with status taken from the tracker where the two disagree.

## Tasks

### MG0 baseline, recovery witness, and redacted corpus checked in

`py-mg0`. Status: done. Detail: ready.

Template: [test-report](../../templates/test-report.md).

Done criterion: The baseline, restore witness, and redacted corpus are reproducible from checked-in evidence without exposing live credentials.

Evidence needed: plans/evidence/python-migration-mg0.json and plans/evidence/python-migration-mg0-corpus.json

Evidence: `plans/evidence/python-migration-mg0.json`.

### MG1 Python foundation, registry, identity, and Studio contract checked in

`py-mg1`. Status: done. Detail: ready.

Template: [test-report](../../templates/test-report.md).

Done criterion: Wrong-tenant and caller-selected infrastructure are denied; a published revision round-trips; OpenAPI and the Studio path inventory match the FastAPI app and the checked generator emits the revision helper; only an owner or admin can rename a tenant; tokens require exp; registration removal leaves source state untouched and later registry calls return registration_unavailable. Host and guest install changes are outside this slice.

Evidence needed: python/kxm-control/tests/test_mg1.py, test/core/studio-layout.test.ts, and the Python/PostgreSQL lane in .github/workflows/ci.yml

Evidence: `python/kxm-control/tests/test_mg1.py`.

### MG2 Python importers and read-only Studio

`py-mg2`. Status: open. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

### MG3 TypeScript bridge and Python runner

`py-mg3`. Status: open. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

### MG4 Python Temporal pilot and role routing

`py-mg4`. Status: open. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

### MG5 guided plans, multi-repo, and schedules

`py-mg5`. Status: open. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

### MG6 Python knowledge and improvement

`py-mg6`. Status: open. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

### MG7 project and package cutover

`py-mg7`. Status: open. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

### MG8 Node runtime retirement

`py-mg8`. Status: open. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

## Blockers

None.

## Questions

None.

[Dashboard](../dashboard.md)

# Per-tenant hosting

Status: open. Horizon: soon.

Source: `plans/plan-per-tenant-hosting.md`.

Updated: 2026-09-26.

S0 through S5 from the tracker queue. The hosting plan file keeps no schedule of its own.

## Tasks

### S0 reconcile plan authority

`host-s0`. Status: done. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

Evidence: `plans/implementation-plan.md`.

### S1 hub and local Runtime recipe, including the six state roots

`host-s1`. Status: done. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

Evidence: `docs/operations/backup-and-restore.md`.

### S2 portal reads of hub metadata and Runtime state

`host-s2`. Status: done. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

Evidence: `test/core/studio-layout.test.ts`.

### S3 strict outcome on the selected Pi route

`host-s3`. Status: done. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

Evidence: `test/core/pi-producer.test.ts`.

### S4 portal create, drive, and cancel

`host-s4`. Status: done. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

Evidence: `test/core/studio-layout.test.ts`.

### S5 interactive login, logout, and refresh

`host-s5`. Status: open. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

## Blockers

- S5 interactive login, logout, and refresh are still open on the tracker.

## Questions

- plans/plan-per-tenant-hosting.md says status draft and blocked_by []. It says delivery is not scheduled in that file. The tracker records S0 through S4 delivered and S5 open. The tracker wins.
- The tracker names docs/operations.md for the S1 recipe. This checkout has docs/operations/backup-and-restore.md and no docs/operations.md.
- The tracker names an S3 test title that is not in this checkout. The observed test is prose and empty replies cannot mint a passing outcome in test/core/pi-producer.test.ts.

[Dashboard](../dashboard.md)

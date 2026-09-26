# Cross-host

Status: open.

Source: `plans/plan-cross-host-phase.md`.

Updated: 2026-09-26.

P0 through P6 from plans/plan-cross-host-phase.md, with delivered rows taken from the tracker.

## Tasks

- `xhost-p0` P0 cross-box peer witness.
- `xhost-p1` P1 presence across boxes.
- `xhost-p2` P2 queued delivery to a known offline peer. Evidence: `test/core/hub-api.test.ts`.
- `xhost-p3` P3 fenced hub leases. Evidence: `test/core/hub-api.test.ts`.
- `xhost-p4` P4 coordinator intake from peer messages.
- `xhost-p5` P5 sync-event outbox and Runtime presence. Evidence: `test/core/runtime.test.ts`.
- `xhost-p6` P6 Phase 8 gate witness in the driver. Evidence: `test/core/driver.test.ts`.

## Blockers

- P0 waits on a second box and an operator-owned forward to the loopback hub.
- P4 stays behind its trigger: a cross-box request whose target is a role.

## Questions

- The P1 test is present in test/core/hub-api.test.ts. The tracker row is not marked delivered, so the task stays open.
- P5 is marked delivered. The same tracker row still says the cross-box witness is not run. Done evidence is the in-repo test.

[Dashboard](../dashboard.md)

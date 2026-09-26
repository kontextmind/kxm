# Cross-host

Status: open. Horizon: soon.

Source: `plans/plan-cross-host-phase.md`.

Updated: 2026-09-26.

P0 through P6 from plans/plan-cross-host-phase.md, with delivered rows taken from the tracker.

## Tasks

### P0 cross-box peer witness

`xhost-p0`. Status: open. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

### P1 presence across boxes

`xhost-p1`. Status: open. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

### P2 queued delivery to a known offline peer

`xhost-p2`. Status: done. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

Evidence: `test/core/hub-api.test.ts`.

### P3 fenced hub leases

`xhost-p3`. Status: done. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

Evidence: `test/core/hub-api.test.ts`.

### P4 coordinator intake from peer messages

`xhost-p4`. Status: open. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

### P5 sync-event outbox and Runtime presence

`xhost-p5`. Status: done. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

Evidence: `test/core/runtime.test.ts`.

### P6 Phase 8 gate witness in the driver

`xhost-p6`. Status: done. Detail: scoped.

Template: `none`.

Done criterion: None.

Evidence needed: None.

Evidence: `test/core/driver.test.ts`.

## Blockers

- P0 waits on a second box and an operator-owned forward to the loopback hub.
- P4 stays behind its trigger: a cross-box request whose target is a role.

## Questions

- The P1 test is present in test/core/hub-api.test.ts. The tracker row is not marked delivered, so the task stays open.
- P5 is marked delivered. The same tracker row still says the cross-box witness is not run. Done evidence is the in-repo test.

[Dashboard](../dashboard.md)

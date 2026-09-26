# Master plan

Updated: 2026-09-26.

Record the local-first KXM shape that this checkout can show, and track the proposal and queue items the implementation tracker actually records.

## Python migration

Status: open.

Source: `plans/plan-python-migration.md`.

Waves MG0 through MG8 from plans/plan-python-migration.md, with status taken from the tracker where the two disagree.

### Tasks

- `py-mg0` MG0 baseline and recovery witness recorded by the tracker. Evidence: `plans/implementation-plan.md`.
- `py-mg1` MG1 code gate recorded by the tracker. Evidence: `plans/implementation-plan.md`.
- `py-mg2` MG2 Python importers and read-only Studio.
- `py-mg3` MG3 TypeScript bridge and Python runner.
- `py-mg4` MG4 Python Temporal pilot and role routing.
- `py-mg5` MG5 guided plans, multi-repo, and schedules.
- `py-mg6` MG6 Python knowledge and improvement.
- `py-mg7` MG7 project and package cutover.
- `py-mg8` MG8 Node runtime retirement.

### Blockers

None.

### Questions

- Plan frontmatter status is draft and blocked_by is empty. Tracking calls MG0 through MG8 a proposal that does not change deployment. Still open records an MG0 witness, and the greenfield bullet records an MG1 code gate. The tracker wins for those two waves. The evidence JSON paths and the python tree named there are not in this checkout.

## Greenfield infra

Status: open.

Source: `plans/plan-greenfield-infra.md`.

Record only what the tracker says about the greenfield first move. The plan file itself is not in this checkout.

### Tasks

- `gf-installed` Loopback database and workflow engine recorded as installed, with KXM still writing SQLite. Evidence: `plans/implementation-plan.md`.
- `gf-control` Control-plane registration and token checks recorded as passed. Evidence: `plans/implementation-plan.md`.
- `gf-backlog` Redis Streams, NATS, raw WebSockets, and the A2A Python SDK stay backlog.

### Blockers

None.

### Questions

- plans/plan-greenfield-infra.md is not observed from this checkout, so its status and blocked_by are not observed. Tasks below cite the tracker bullet that names the missing file.

## Per-tenant hosting

Status: open.

Source: `plans/plan-per-tenant-hosting.md`.

S0 through S5 from the tracker queue. The hosting plan file keeps no schedule of its own.

### Tasks

- `host-s0` S0 reconcile plan authority. Evidence: `plans/implementation-plan.md`.
- `host-s1` S1 hub and local Runtime recipe, including the six state roots. Evidence: `docs/operations/backup-and-restore.md`.
- `host-s2` S2 portal reads of hub metadata and Runtime state. Evidence: `test/core/studio-layout.test.ts`.
- `host-s3` S3 strict outcome on the selected Pi route. Evidence: `test/core/pi-producer.test.ts`.
- `host-s4` S4 portal create, drive, and cancel. Evidence: `test/core/studio-layout.test.ts`.
- `host-s5` S5 interactive login, logout, and refresh.

### Blockers

- S5 interactive login, logout, and refresh are still open on the tracker.

### Questions

- plans/plan-per-tenant-hosting.md says status draft and blocked_by []. It says delivery is not scheduled in that file. The tracker records S0 through S4 delivered and S5 open. The tracker wins.
- The tracker names docs/operations.md for the S1 recipe. This checkout has docs/operations/backup-and-restore.md and no docs/operations.md.
- The tracker names an S3 test title that is not in this checkout. The observed test is prose and empty replies cannot mint a passing outcome in test/core/pi-producer.test.ts.

## Cross-host

Status: open.

Source: `plans/plan-cross-host-phase.md`.

P0 through P6 from plans/plan-cross-host-phase.md, with delivered rows taken from the tracker.

### Tasks

- `xhost-p0` P0 cross-box peer witness.
- `xhost-p1` P1 presence across boxes.
- `xhost-p2` P2 queued delivery to a known offline peer. Evidence: `test/core/hub-api.test.ts`.
- `xhost-p3` P3 fenced hub leases. Evidence: `test/core/hub-api.test.ts`.
- `xhost-p4` P4 coordinator intake from peer messages.
- `xhost-p5` P5 sync-event outbox and Runtime presence. Evidence: `test/core/runtime.test.ts`.
- `xhost-p6` P6 Phase 8 gate witness in the driver. Evidence: `test/core/driver.test.ts`.

### Blockers

- P0 waits on a second box and an operator-owned forward to the loopback hub.
- P4 stays behind its trigger: a cross-box request whose target is a role.

### Questions

- The P1 test is present in test/core/hub-api.test.ts. The tracker row is not marked delivered, so the task stays open.
- P5 is marked delivered. The same tracker row still says the cross-box witness is not run. Done evidence is the in-repo test.

## Workflow modes

Status: later.

Source: `plans/plan-workflow-modes-selective-loading.md`.

Declarative modes and selective loading. The plan says it is not an active backlog.

### Tasks

- `modes-activate` Activate modes, beyond parsing them.
- `modes-domain` Domain isolation for a mode.
- `modes-explain` Selective loading reported by kxm explain.

### Blockers

None.

### Questions

- Frontmatter status is draft, blocked_by is empty, and delivery_status is proposed. Still open does not select this plan as a queue row, so the phase stays later.

## Usage and cost

Status: later.

Source: `plans/plan-usage-cost-quota-tracking.md`.

Quota observations on top of existing usage records. The plan says it is not an active backlog.

### Tasks

- `quota-observe` Account-scoped quota observations.
- `quota-split` Keep usage, quota, metered cost, list cost, and unknown distinct.

### Blockers

None.

### Questions

- Frontmatter status is draft, blocked_by is empty, and delivery_status is proposed. The tracker's routing and cost questions stay on the Still open phase. This phase stays later.

## Still open

Status: open.

Source: `plans/implementation-plan.md`.

Tracker items that are not already tasks on the phases above.

### Tasks

- `open-q` Operator confirmation of the self-improvement defaults Q-B through Q-K.
- `open-plugin` Operator confirmation of plugin decisions D-1 and D-2, and the failure-hook witness.
- `open-journal` Runtime runs have no journal or retrospective.
- `open-pool` Hub context pool reads memory from the hub checkout.
- `open-backup` Restore does not remap user-state paths onto another box.
- `open-policy` producerPolicy.acceptedStatuses is not consulted at peer-reply settlement.
- `open-routing` Routing and cost policy questions remain an operator decision.
- `open-packages` Package restructure slices after packages/core/tui.
- `open-timing` Remaining timing-dependent assertions in the core suite.
- `open-intake` Intake contract follow-ups behind their trigger.
- `open-m` Unified M0 through M9 packets stay proposed.

### Blockers

- A Runtime journal needs a new store, which the tracker holds while the hosting queue forbids one.
- A hub context-pool guard waits until a hub would serve a second project.

### Questions

- Tracking says delivery order is Still open, the one queue. This roadmap orders phases as the brief requires, so the Python proposal is Next while S5 login is still open on the hosting phase.

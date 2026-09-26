# Roadmap

Updated: 2026-09-26.

Active blockers: 5. Active questions: 8. Later phases are excluded from both counts.

## Next

### Python migration

Status: open. Horizon: next.

Source: `plans/plan-python-migration.md`.

Goal: Waves MG0 through MG8 from plans/plan-python-migration.md, with status taken from the tracker where the two disagree.

#### Open tasks

- `py-mg2` MG2 Python importers and read-only Studio.
- `py-mg3` MG3 TypeScript bridge and Python runner.
- `py-mg4` MG4 Python Temporal pilot and role routing.
- `py-mg5` MG5 guided plans, multi-repo, and schedules.
- `py-mg6` MG6 Python knowledge and improvement.
- `py-mg7` MG7 project and package cutover.
- `py-mg8` MG8 Node runtime retirement.

#### Blockers

None.

#### Questions

- Plan frontmatter status is draft and blocked_by is empty. Tracking calls MG0 through MG8 a proposal that does not change deployment. Still open records an MG0 witness, and the greenfield bullet records an MG1 code gate. The tracker wins for those two waves. The evidence JSON paths and the python tree named there are not in this checkout.

[Phase page](phases/01-python-migration.md)

## Active phases

### Greenfield infra

Status: open. Horizon: soon.

Source: `plans/plan-greenfield-infra.md`.

Goal: Record only what the tracker says about the greenfield first move. The plan file itself is not in this checkout.

#### Open tasks

- `gf-backlog` Redis Streams, NATS, raw WebSockets, and the A2A Python SDK stay backlog.

#### Blockers

None.

#### Questions

- plans/plan-greenfield-infra.md is not observed from this checkout, so its status and blocked_by are not observed. Tasks below cite the tracker bullet that names the missing file.

[Phase page](phases/02-greenfield-infra.md)

### Per-tenant hosting

Status: open. Horizon: soon.

Source: `plans/plan-per-tenant-hosting.md`.

Goal: S0 through S5 from the tracker queue. The hosting plan file keeps no schedule of its own.

#### Open tasks

- `host-s5` S5 interactive login, logout, and refresh.

#### Blockers

- S5 interactive login, logout, and refresh are still open on the tracker.

#### Questions

- plans/plan-per-tenant-hosting.md says status draft and blocked_by []. It says delivery is not scheduled in that file. The tracker records S0 through S4 delivered and S5 open. The tracker wins.
- The tracker names docs/operations.md for the S1 recipe. This checkout has docs/operations/backup-and-restore.md and no docs/operations.md.
- The tracker names an S3 test title that is not in this checkout. The observed test is prose and empty replies cannot mint a passing outcome in test/core/pi-producer.test.ts.

[Phase page](phases/03-per-tenant-hosting.md)

### Cross-host

Status: open. Horizon: soon.

Source: `plans/plan-cross-host-phase.md`.

Goal: P0 through P6 from plans/plan-cross-host-phase.md, with delivered rows taken from the tracker.

#### Open tasks

- `xhost-p0` P0 cross-box peer witness.
- `xhost-p1` P1 presence across boxes.
- `xhost-p4` P4 coordinator intake from peer messages.

#### Blockers

- P0 waits on a second box and an operator-owned forward to the loopback hub.
- P4 stays behind its trigger: a cross-box request whose target is a role.

#### Questions

- The P1 test is present in test/core/hub-api.test.ts. The tracker row is not marked delivered, so the task stays open.
- P5 is marked delivered. The same tracker row still says the cross-box witness is not run. Done evidence is the in-repo test.

[Phase page](phases/04-cross-host.md)

### Still open

Status: open. Horizon: soon.

Source: `plans/implementation-plan.md`.

Goal: Tracker items that are not already tasks on the phases above.

#### Open tasks

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

#### Blockers

- A Runtime journal needs a new store, which the tracker holds while the hosting queue forbids one.
- A hub context-pool guard waits until a hub would serve a second project.

#### Questions

- Tracking says delivery order is Still open, the one queue. This roadmap orders phases as the brief requires, so the Python proposal is Next while S5 login is still open on the hosting phase.

[Phase page](phases/07-still-open.md)

## Later

### Workflow modes

Status: later. Horizon: later.

Source: `plans/plan-workflow-modes-selective-loading.md`.

Goal: Declarative modes and selective loading. The plan says it is not an active backlog.

#### Open tasks

- `modes-activate` Activate modes, beyond parsing them.
- `modes-domain` Domain isolation for a mode.
- `modes-explain` Selective loading reported by kxm explain.

#### Blockers

None.

#### Questions

- Frontmatter status is draft, blocked_by is empty, and delivery_status is proposed. Still open does not select this plan as a queue row, so the phase stays later.

[Phase page](phases/05-workflow-modes.md)

### Usage and cost

Status: later. Horizon: later.

Source: `plans/plan-usage-cost-quota-tracking.md`.

Goal: Quota observations on top of existing usage records. The plan says it is not an active backlog.

#### Open tasks

- `quota-observe` Account-scoped quota observations.
- `quota-split` Keep usage, quota, metered cost, list cost, and unknown distinct.

#### Blockers

None.

#### Questions

- Frontmatter status is draft, blocked_by is empty, and delivery_status is proposed. The tracker's routing and cost questions stay on the Still open phase. This phase stays later.

[Phase page](phases/06-usage-cost.md)

## Phase index

| Phase | Status | Horizon | Page |
| --- | --- | --- | --- |
| Python migration | open | next | [page](phases/01-python-migration.md) |
| Greenfield infra | open | soon | [page](phases/02-greenfield-infra.md) |
| Per-tenant hosting | open | soon | [page](phases/03-per-tenant-hosting.md) |
| Cross-host | open | soon | [page](phases/04-cross-host.md) |
| Workflow modes | later | later | [page](phases/05-workflow-modes.md) |
| Usage and cost | later | later | [page](phases/06-usage-cost.md) |
| Still open | open | soon | [page](phases/07-still-open.md) |

## Goal

Record the local-first KXM shape that this checkout can show, and track the proposal and queue items the implementation tracker actually records.

## Improvements

None recorded.

## Architecture drift

Verified: null.

| Claim | Page | Status |
| --- | --- | --- |
| plans/plan-greenfield-infra.md is in this checkout | `docs/architecture/hosted-direction.md` | missing |
| docs/operations.md is the hosting recipe path named by the tracker | `docs/architecture/inventory.md` | missing |
| plans/evidence/python-migration-mg0.json is in this checkout | `docs/roadmap/phases/01-python-migration.md` | missing |
| a python/ tree is in this checkout | `docs/roadmap/phases/01-python-migration.md` | missing |
| the S3 test title in the tracker matches a test title in this checkout | `docs/roadmap/phases/03-per-tenant-hosting.md` | mismatch |

## Constraints

- SQLite remains the hub store recorded in this checkout.
- The docs site binds only a tailnet address and is not published on a public edge.
- A draft plan does not change a phase gate unless the tracker selects the slice.
- No hostname, address, tenant name, email, or secret is written into this state file.

## Contacts

No confirmed contacts.

## History

- 2026-09-26: Tailnet docs site created.
- 2026-09-26: Roadmap seeded from state.json.
- 2026-09-26: Portal mark applied.

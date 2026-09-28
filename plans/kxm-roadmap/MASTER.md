# Master plan

Updated: 2026-09-28.

Record the local-first KXM shape that this checkout can show, and track the proposal and queue items the implementation tracker actually records.

## Planner loop and lanes

Status: open. Horizon: next.

Source: `plans/plan-lane-cli.md`.

The kxm verbs that let the planner dispatch a writer into a worktree lane and land its branch without just recipes: lane, land, assign, docs, and bounded one-shot steps.

### Tasks

- `loop-lane` kxm lane create, list, status, drop, run with --brief and --lane. Evidence: `test/core/cli.test.ts`.
- `loop-land` kxm land: verify, docs, push, pr, rebase, unblock, merge, release, milestone. Evidence: `test/core/pr-land.test.ts`.
- `loop-assign` kxm assign over the assignment runner, seven verbs, argv pass-through. Evidence: `test/core/cli.test.ts`.
- `loop-docs` Tailnet docs site, roadmap generator, and kxm docs build and serve. Evidence: `plans/kxm-roadmap/update-dashboard.mjs`.
- `loop-timeouts` Configurable one-shot step timeout, cancel recovery, and the three one-step workflows. Evidence: `test/core/engine.test.ts`.
- `loop-dispatch` Dispatch the next writer through kxm lane run --workflow implement-only and retire the transport just recipes.
- `loop-land-followup` kxm land follow-up: verify failure detail (S19) and UNKNOWN merge state (S22). Evidence: `test/core/pr-land.test.ts`.
- `loop-supervise` kxm supervise persists in-flight lanes, pull request and CI state, and backoff timers (S20). Evidence: `test/core/supervise.test.ts`.

### Blockers

None.

### Questions

- The proof model behind kxm assign (backlog S11) is still an operator decision.

## Role authority from the v2 policy draft

Status: open. Horizon: soon.

Source: `plans/plan-omp-config-alignment.md`.

Promote the passive kxm.role.v2 and kxm.model.v2 draft to the single role authority, retire kxm.role.v1, routes.yaml roles, roster.yaml and the code defaults, give agents a role reference, then add the opt-in fallback walk, tool-policy enforcement, provenance, and effort validation.

### Tasks

- `omp-p1` P1 promote the draft: schemas live, models and roles rewritten to v2, v1 deleted. Evidence: `test/core/policy-draft.test.ts`.
- `omp-p2` P2 cut the loader and engine over to the v2 files. Evidence: `test/core/roster-policy.test.ts`.
- `omp-p3` P3 tool policy enforcement. Evidence: `test/core/engine.test.ts`.
- `omp-p4` P4 opt-in fallback walk with route_switch events. Evidence: `test/core/route-fallback.test.ts`.
- `omp-p5` P5 provenance and extends.
- `omp-p6` P6 effort catalog.
- `omp-p7` P7 quota-aware walk (optional).

### Blockers

None.

### Questions

- P2 landed in #343, P4 ships the error classifier with the walk, and P3 tool policy landed in #378 (v0.7.169). Section 7 still asks whether kxm plugin install --omp should write modelRoles from the role files. The engine can settle a real reviewer outcome (#363, #368). Backlog S33 records one truthful critic BLOCK on the vision lane. That settlement is not loop-dispatch.

## Python migration

Status: open. Horizon: soon.

Source: `plans/plan-python-migration.md`.

Waves MG0 through MG8 from plans/plan-python-migration.md, with status taken from the tracker where the two disagree.

### Tasks

- `py-mg0` MG0 baseline and recovery witness recorded by the tracker. Evidence: `plans/implementation-plan.md`.
- `py-mg1` MG1 code gate done off-repo, not on main. Evidence: `plans/implementation-plan.md`.
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

- Plan frontmatter status is draft and blocked_by is empty. Tracking calls MG0 through MG8 a proposal that does not change deployment. MG0's witness is recorded in the implementation plan; its evidence JSON is not in this checkout. MG1's code gate is done off-repo and not on main: this checkout has no python/ tree.

## Greenfield infra

Status: open. Horizon: soon.

Source: `plans/plan-greenfield-infra.md`.

Record only what the tracker says about the greenfield first move. The plan file is observed in this checkout as a kxm.doc.v1 stub; canonical facts live in the implementation-plan greenfield bullets.

### Tasks

- `gf-installed` Loopback database and workflow engine recorded as installed, with KXM still writing SQLite. Evidence: `plans/implementation-plan.md`.
- `gf-control` Control-plane registration and token checks recorded as passed. Evidence: `plans/implementation-plan.md`.
- `gf-backlog` Redis Streams, NATS, raw WebSockets, and the A2A Python SDK stay backlog.

### Blockers

None.

### Questions

- plans/plan-greenfield-infra.md is a kxm.doc.v1 stub committed in #373 (status draft, authority instruction, created and updated 2026-09-28). The long-form proposal is not in this repository. Canonical installed and backlog facts live in the implementation-plan greenfield bullets. The phase stays open on the backlog task.

## Per-tenant hosting

Status: open. Horizon: soon.

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
- docs/operations.md indexes the operations guides, including the six state roots in docs/operations/backup-and-restore.md, and Cross-box peer attach. The S1 recipe body stays in docs/operations/deploy.md.
- The tracker names an S3 test title that is not in this checkout. The observed test is prose and empty replies cannot mint a passing outcome in test/core/pi-producer.test.ts.

## Cross-host

Status: open. Horizon: soon.

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

- P4 stays behind its trigger: a cross-box request whose target is a role.

### Questions

- P0 is unblocked and not done. The bind substrate is on main (#348, #375, #376). The two-box witness is still open. Clients use the operator-owned loopback SSH forward because the public hub name sits behind Authentik; the address is in plans/plan-cross-host-phase.md and docs/operations.md, not in this state file.
- The P1 test is present in test/core/hub-api.test.ts. The tracker row is not marked delivered, so the task stays open.
- P5 is marked delivered. The same tracker row still says the cross-box witness is not run. Done evidence is the in-repo test.

## Workflow modes

Status: later. Horizon: later.

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

Status: later. Horizon: later.

Source: `plans/plan-usage-cost-quota-tracking.md`.

Quota observations on top of existing usage records. The plan says it is not an active backlog.

### Tasks

- `quota-observe` Account-scoped quota observations.
- `quota-split` Keep usage, quota, metered cost, list cost, and unknown distinct.

### Blockers

None.

### Questions

- Frontmatter status is draft, blocked_by is empty, and delivery_status is proposed. The tracker's routing and cost questions stay on the Still open phase. This phase stays later.

## Bare kxm first run

Status: later. Horizon: later.

Source: `plans/plan-kxm-harness-first-run.md`.

On a TTY, bare kxm opens the existing dashboard and a first-run panel that probes harnesses, hands auth to each harness or an op:// reference, and writes user defaults. Static workflow files stay the trust anchor. A hybrid composer is proposed and not selected.

### Tasks

- `first-run-p0` P0 sequence gate: dependencies on main before any product change.
- `first-run-p1` P1 read-only kxm doctor.
- `first-run-wizard` P2 through P5 bare kxm TTY, wizard, DeepSeek honesty, and repair.
- `first-run-hybrid` P6 through P8 hybrid workflow catalog, only if the operator accepts option B.

### Blockers

- omp-alignment P5, P6, and P7 are still open. P3 tool policy (#378, v0.7.169) and P4 fallback are done.
- The workforce-id naming validator (scripts/workforce-lint.mjs, wired into check and validate:pr) and the hub cloud binding are on main and inventoried; what remains for this phase is the first-run sequence itself.

### Questions

- Option B, a validated workflow file composed from a catalog, waits for an operator decision. The plan recommends it and does not schedule it.

## Studio screens for the shared hub

Status: later. Horizon: later.

Source: `plans/plan-studio-cloud-host.md`.

Studio shows the seven dash panels, a first-run wizard, and live workflow state for the shared hub. Humans sign in at the edge. Policy edits become pull requests. The browser does not hold a hub token.

### Tasks

- `studio-s0` S0 shared sequence gate with the first-run plan.
- `studio-s1` S1 read-only dash routes and S2 hub SSE fan-out.
- `studio-s3` S3 through S6 setup, policy PRs, bind, motion, and breakpoints.

### Blockers

- Shares the first-run sequence gate: the workforce-id naming validator and the hub cloud binding are on main and inventoried. omp P3 tool policy landed in #378 (v0.7.169) and P4 fallback is done. P5, P6, and P7 remain.
- Setup and doctor screens also wait on first-run P1 through P5.

### Questions

- Whether the hosted page stays kxm studio serve, or the portal keeps calling the CLI over guest exec.

## Still open

Status: open. Horizon: soon.

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

## History

- 2026-09-26: Lane, land, assign, docs, and one-shot timeout slices landed (#330 to #335).
- 2026-09-26: First deep review: planner loop and role-authority phases added ahead of the Python proposal.
- 2026-09-26: P1 role authority landed (#337): v2 role and model files are live.
- 2026-09-26: Lanes register under their project and the test suite is bounded (#339).
- 2026-09-27: Draft plan for bare kxm first-run, sequenced after role-authority P3-P7.
- 2026-09-27: Companion draft for Studio hub screens, sharing the first-run sequence gate.
- 2026-09-27: P2 role authority landed (#343, published 0.7.131): the v2 files are the only dispatch source, roster.yaml and the transport recipes are gone.
- 2026-09-27: P4 opt-in fallback walk records routing.route_switched and continues the attempt.
- 2026-09-27: docs/operations.md indexes the six state roots and the cross-box peer attach recipe.
- 2026-09-28: Deep pass: greenfield stub, MG0 evidence, and an untracked python tree observed in the operator's primary worktree; hub cloud binding inventoried.
- 2026-09-28: P3 tool policy landed (#378, v0.7.169). Cross-host P0 bind unblocked (#348, #375, #376). MG1 is off-repo. CI pause text retired.
- 2026-09-28: Land follow-up: verify names the failing check, and UNKNOWN merge state is polled until it resolves.
- 2026-09-28: kxm supervise stores lane, pull request, CI, and backoff state and resumes it after a restart.

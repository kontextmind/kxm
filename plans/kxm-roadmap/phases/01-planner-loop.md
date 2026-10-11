# Planner loop and lanes

Status: done. Horizon: soon.

Source: `plans/plan-lane-cli.md`.

Updated: 2026-10-11.

The kxm verbs that let the planner dispatch a writer into a worktree lane and land its branch without just recipes: lane, land, assign, docs, and bounded one-shot steps.

## Tasks

### kxm lane create, list, status, drop, run with --brief and --lane

`loop-lane`. Status: done. Detail: ready.

Template: [feature](../../templates/feature.md).

Done criterion: None.

Evidence needed: None.

Plan section: plans/plan-lane-cli.md#2-target-surface.

Evidence: `test/core/cli.test.ts`.

### kxm land: verify, docs, push, pr, rebase, unblock, merge, release, milestone

`loop-land`. Status: done. Detail: ready.

Template: [feature](../../templates/feature.md).

Done criterion: None.

Evidence needed: None.

Plan section: plans/plan-landing-gates.md#2-target.

Evidence: `test/core/pr-land.test.ts`.

### kxm assign over the assignment runner, seven verbs, argv pass-through

`loop-assign`. Status: done. Detail: scoped.

Template: `feature`.

Done criterion: None.

Evidence needed: None.

Evidence: `test/core/cli.test.ts`.

### Tailnet docs site, roadmap generator, and kxm docs build and serve

`loop-docs`. Status: done. Detail: scoped.

Template: `feature`.

Done criterion: None.

Evidence needed: None.

Evidence: `plans/kxm-roadmap/update-dashboard.mjs`.

### Configurable one-shot step timeout, cancel recovery, and the three one-step workflows

`loop-timeouts`. Status: done. Detail: ready.

Template: [bug-fix](../../templates/bug-fix.md).

Done criterion: None.

Evidence needed: None.

Plan section: plans/plan-lane-cli.md#4-found-during-the-first-dispatch-2026-09-25.

Evidence: `test/core/engine.test.ts`.

### Dispatch the writer and both critics through one-step workflows and surface their lane attempts in the parent report

`loop-dispatch`. Status: done. Detail: scoped.

Template: `feature`.

Done criterion: One real unit ran the writer and both critics through the one-step workflows. Each attempt settled from a verified drive receipt, and kxm improve report from the parent checkout included all three lane attempt rows. Transport recipes were already retired in #343.

Evidence needed: Satisfied by plans/evidence/loop-dispatch-2026-10-11.json: three verified workflow drive receipts and parent report counts.

Evidence: `plans/evidence/loop-dispatch-2026-10-11.json`.

### kxm land follow-up: verify failure detail (S19) and UNKNOWN merge state (S22)

`loop-land-followup`. Status: done. Detail: scoped.

Template: `bug-fix`.

Done criterion: A failing verify names the failing lines and a log path; the rebase stage polls UNKNOWN to a known state and rebases when BEHIND.

Evidence needed: test/core/pr-land.test.ts cases for both, and one landing that hit each path.

Evidence: `test/core/pr-land.test.ts`.

### kxm supervise persists in-flight lanes, pull request and CI state, and backoff timers (S20)

`loop-supervise`. Status: done. Detail: scoped.

Template: `feature`.

Done criterion: A new process loads the same in-flight lanes, last-seen pull request and CI states, and backoff timers, and a tick after the backoff resumes that lane.

Evidence needed: A restart-resume test that writes the state, exits, and reads it back from another process.

Plan section: plans/plan-lane-cli.md#6-persistent-supervisor-state.

Evidence: `test/core/supervise.test.ts`.

## Blockers

None.

## Questions

- The proof model behind kxm assign (backlog S11) is still an operator decision.

[Dashboard](../dashboard.md)

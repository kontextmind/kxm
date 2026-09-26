---
schema: "kxm.doc.v1"
id: "PLAN-LANE-CLI"
type: "feature"
title: "kxm lane: worktree lanes and file briefs as first-class CLI verbs"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-25"
updated: "2026-09-25"
authority: "hypothesis"
confidence: "high"
summary: "Small slice. Add a kxm lane command group (create, list, status, drop, run) that manages one git worktree per unit of work, records the lane in the project state directory, and lets kxm run and kxm runs target a lane by name. Add --brief <file> to kxm run so a prompt is never passed inline. The just worktree recipes become wrappers. Lands before P1 of plan-omp-config-alignment.md, which is the first run that uses it. No push, merge, or PR behavior; no change to admission or the trusted roster read."
tags: ["cli", "lanes", "worktree", "runs", "devex"]
related:
  - plan-omp-config-alignment.md
  - implementation-plan.md
depends_on: []
blocked_by: []
details:
  describes: "proposed"
  writer_route: "grok --model grok-4.7 per CLAUDE.md; this file is a planner artifact"
  brief: ".kxm/briefs/lane-cli.md"
---

# kxm lane: worktree lanes and file briefs

Read [the execution tracker](implementation-plan.md) first. This file is
proposed work, not scheduled work.

## 1. Problem

Starting a governed run on an isolated checkout takes four commands and two
facts the operator has to know:

```text
git worktree add -b omp-align-p1 ../kxm-omp-align-p1 origin/main
cp .kxm/briefs/omp-align-p1.md ../kxm-omp-align-p1/.kxm/briefs/
cd ../kxm-omp-align-p1 && kxm run default "$(cat .kxm/briefs/omp-align-p1.md)"
kxm runs drive <runId> --wait --timeout-ms 600000
```

The two facts: `kxm run` discovers the project from the current directory and
rejects `--workspace` (that flag selects the `.kxm` directory, not the project
root), so the lane has to be the cwd; and the prompt is positional text, so a
brief goes through command substitution. The `justfile` already warns that
inline prompts are how shell-quoting bugs get in, and its `impl` recipe takes a
brief path for that reason, but `kxm run` does not.

Nothing in the CLI knows about worktrees. `kxm session` handles manifests and
tokens, `kxm init` binds member repositories, and the developer runner expects
"a separate worktree for the writer" that `just worktree <unit>` creates. The
runner already resolves a brief path against the invocation cwd so a brief in
the control repo works while the agent runs in a worktree.

## 2. Target surface

```text
kxm lane create <unit> [--base <ref>]          # default base origin/main
kxm lane list
kxm lane status <unit>
kxm lane drop <unit> [--force]
kxm lane run <unit> --brief <file> [--workflow <id>] [--base <ref>] [--wait] [--timeout-ms <n>]
kxm run <workflow> [--brief <file>] [--lane <unit>] [prompt...]
kxm runs status|drive|receipt|cancel <runId> [--lane <unit>]
```

The P1 dispatch becomes one line:

```text
kxm lane run omp-align-p1 --brief .kxm/briefs/omp-align-p1.md --wait
```

### Semantics

- **A lane is one worktree, one branch, one recorded base sha.** `create`
  resolves `<ref>` to a sha first, adds the worktree at that sha with a new
  branch named `<unit>`, and records `{path, branch, baseRef, baseSha,
  createdAt}`. The path is `../<control-dir-basename>-<unit>` next to the
  control checkout. Recording the sha, not the ref, is deliberate: worktrees
  share refs and another session's fetch moves `origin/main` between two
  commands.
- **The record lives in the control checkout's state directory**, in
  `.kxm/state/lanes.json`, schema `kxm.lanes.v1`, mode 0600, gitignored like
  the rest of `.kxm/state`. The lane's own `.kxm/state` is untouched.
- **`--lane <unit>` swaps the discovery cwd** to the lane path before the
  existing `discoverKxmProjectRoot(runtime.cwd)` runs. Nothing else in `run` or
  `runs` changes. `git rev-parse --show-toplevel` in a worktree returns the
  worktree, so the lane is its own project root.
- **`--brief <file>`** reads the prompt from a file resolved against the
  invocation cwd, trims it, and passes it where the positional prompt went. The
  run's hash and 0600 sidecar behavior is unchanged. `--brief` and a positional
  prompt together is an error.
- **`lane run`** is `create` if the lane does not exist, then `run --lane
  --brief`, then `runs drive --lane --wait`. It records the run id on the lane.
- **`status`** reports path, branch, base sha, dirty file count from
  `git status --porcelain`, ahead and behind counts against the recorded base
  sha, and the last run id with its projected status when the Runtime
  supervisor answers, otherwise `unknown`.
- **`drop`** removes the worktree and the record. It refuses when the tree is
  dirty or the last run is not settled, unless `--force`. It never deletes the
  branch.

### What it must respect

- **One writer per checkout.** The engine's `maxConcurrentRuns` of 1 for live
  write steps applies per lane. `create` refuses a unit that already has a
  lane; `run --lane` refuses when the lane's last run is still open.
- **No implicit fetch.** `create` uses the ref as it is on disk. If it does
  not resolve, refuse and say `git fetch origin`.
- **The trusted roster read** in `scripts/roster-policy.mjs` stays on
  `refs/remotes/origin/main` and is not consulted by any lane verb.
- **No push, no merge, no PR, no branch delete.** Landing stays with the
  merge-train procedure.
- **Refusals are exit code 1 with a stable `error` code in JSON**, matching
  every other group: `lane_exists`, `lane_missing`, `lane_base_unresolved`,
  `lane_dirty`, `lane_run_open`, `brief_unreadable`, `brief_and_prompt`.

## 3. Shape of the work

| Piece | File | Note |
|---|---|---|
| Command group | new `plugins/kxm/src/cli/lanes.ts`, registered in `cli.ts` beside the other groups | `cmdLaneCreate`, `cmdLaneList`, `cmdLaneStatus`, `cmdLaneDrop`, `cmdLaneRun` |
| Lane records | `.kxm/state/lanes.json`, `kxm.lanes.v1` | read and written only by `lanes.ts`; a JSON schema under `schemas/lanes.schema.json` |
| `--brief`, `--lane` | `cli.ts` run and runs registration, `cli/project.ts` `cmdKxmRun` and the four runs commands | a shared `withLaneCwd(runtime, unit)` helper returns a Runtime whose `cwd` is the lane path |
| Tests | `test/core/cli.test.ts` | one test per refusal, plus one that `run --lane --brief` posts the lane path as `projectRoot` through `kxmDriveCliSeams` |
| Docs | `docs/reference/cli-reference.md` (`kxm lane` section, `--brief` and `--lane` under run and runs), `docs/contributing/assignment-runner.md` (replace the `just worktree` mention) | |
| Justfile | `worktree` and `worktree-drop` recipes call `kxm lane create` and `kxm lane drop` | literals gone |

One PR. Roughly one afternoon for the writer. The brief is
[`.kxm/briefs/lane-cli.md`](../.kxm/briefs/lane-cli.md).

## 4. Found during the first dispatch (2026-09-25)

The first attempt to run this brief through `kxm run` plus `kxm runs drive`
on a fresh lane surfaced four defects. None is in the lane CLI; all are
recorded here because this slice is the first consumer that hit them. The
brief was re-dispatched through `just impl`, whose transport arms no wall
timer when `timeout_ms` is unset.

1. **Hard 120 second one-shot timeout on every live agent step.** The
   supervisor builds `createKxmOneShotProducer` without `timeoutMs`
   (`runtime-supervisor.ts` around line 837), so `oneshot-process.ts` falls to
   its `120_000` default. The writer was killed with SIGTERM at 121 seconds,
   the engine marked the attempt `effectUncertain`, and the drive handed off
   with `attempt_unreconciled`. The workflow schema already allows `timeoutMs`
   on a step, but the engine only reads it for gates. Fix: thread
   `step.timeoutMs` through the producer request into the spawn options, and
   give the supervisor a project-level default that is not two minutes.
   Brief: `.kxm/briefs/run-driver-timeouts.md`.
2. **Thinking level is hard-coded.** `engine.ts` around line 1839 sends
   `low` on the first attempt and `medium` on retries, ignoring the role
   roster's `effort`. Covered by P2 and P6 of
   [`plan-omp-config-alignment.md`](plan-omp-config-alignment.md); noted here
   because the evidence file shows `--reasoning-effort low` on a writer whose
   role says medium.
3. **A run with an unreconciled executing attempt cannot be recovered.**
   `runs cancel` moves it to `cancelling`; every later `runs drive` returns
   `run_busy` ("already admitted or queued"), and that survives a supervisor
   restart. The bare-drive brake only records a failure for attempts still in
   `starting`. Recovery was deleting the lane's Runtime project store, which
   the single-operator rule permits but which should not be the documented
   path.
4. **Committed template provenance no longer matches any baseline the
   installed kxm knows.** `.kxm/template-provenance.yaml` was stamped by #179;
   kxm 0.7.115 stamps a different revision and refuses the file, while a
   project without the file validates as ready. Main already carries the
   deletion uncommitted; the lane branch stages the same deletion so it lands
   with this slice.

## 5. Out of scope

- Lane records in Git, or a lane manifest inside the lane. The control
  checkout owns the list.
- Auto-fetch, auto-rebase, auto-push, PR creation, branch deletion.
- Lanes on remote hosts. `kxm ssh` is a separate surface.
- Any change to `kxm.workflow.v1`, admission, the roster, or agents.

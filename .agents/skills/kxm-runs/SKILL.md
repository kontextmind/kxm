---
name: kxm-runs
description: Create, drive, and inspect local KXM runs, manage worktree lanes, land a branch, and run the developer assignment loop. kxm runs drive with --simulated executes a run model-free and settles it with a verified receipt. Use when asked to start a workflow run, check its status, read its receipt, cancel it, smoke-test a workflow, create a lane, land the current branch, or call kxm assign (run, witness, plan-current, attribute, observe-cost, accept, change-report).
---

# KXM runs

`kxm run` creates a run of a project workflow in the local Runtime and starts
the Runtime supervisor. A created run stays `created` until
`kxm runs drive` executes the pinned plan. Live drive is the default and spends
an admitted model; `--simulated` is the model-free producer. Do not invent get,
create, or logs verbs under `runs`.

`kxm docs build` regenerates the docs site from the roadmap state by running
`node plans/kxm-roadmap/update-dashboard.mjs` at the project root. `kxm docs
serve` serves that site with `python3 ops/docs-site/serve.py` and passes
`--port` through when it is set. Both require a KXM project.

## Commands

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm run [workflow] [prompt...]` | Create a run; the full prompt is kept on disk (see below) | `--brief <file>`, `--lane <unit>`, `--dry-run` (plan only), `--json` |
| `kxm runs drive <runId>` | Drive a run; with `--wait`, exits 0 only for a verified completed settlement | `--simulated`, `--wait`, `--timeout-ms <n>` (default 60000, max 600000), `--lane <unit>`, `--json` |
| `kxm runs status <runId>` | Projected run status plus drive receipt state (open, receipt verified, unsettled, orphaned) | `--lane <unit>`, `--json` |
| `kxm runs receipt <runId>` | Newest drive receipt for a run | `--all`, `--lane <unit>`, `--json` |
| `kxm runs cancel <runId>` | Durably request cancellation | `--lane <unit>`, `--json` |
| `kxm runs list` | Recent runs for the current project | `--json` |
| `kxm lane create <unit>` | Add a worktree lane at a resolved base sha. Default base is origin/main | `--base <ref>`, `--json` |
| `kxm lane list` | List lanes with dirty, ahead, behind, and exists | `--json` |
| `kxm lane status <unit>` | One lane plus its last run status, or unknown when the supervisor is not answering | `--json` |
| `kxm lane drop <unit>` | Remove the worktree and the record. The branch is not deleted | `--force`, `--json` |
| `kxm lane run <unit>` | Create the lane if needed, start a run from a brief, and drive it | `--brief <file>` (required), `--workflow <id>`, `--base <ref>`, `--wait`, `--timeout-ms <n>`, `--json` |
| `kxm land` | Verify, regenerate docs, push, open or reuse a pull request, rebase, unblock, squash-merge, watch the release, and note a milestone | `--pr <n>`, `--stage <name>`, `--body-file <path>`, `--json`, `--dry-run` |
| `kxm assign run` | Dispatch one assignment manifest. The runner performs every check | `--manifest <path>` |
| `kxm assign witness` | Run the fixed witness for an existing record | `--record-dir <path>` |
| `kxm assign plan-current` | Stamp or advance the current-plan pointer | `--task-dir <path>`, `--plan <path>`, `--sha256 <hex>`, `--base-commit <sha>`, `--expected-generation <n>` |
| `kxm assign attribute` | Attach a private note. It is not proof | `--task-dir <path>`, `--record-dir <path>`, `--class <class>`, `--explanation-file <path>` |
| `kxm assign observe-cost` | Import one cost-only observation | `--task-dir <path>`, `--input <path>` |
| `kxm assign accept` | Bind a witnessed commit and two critic records | `--task-dir <path>`, `--commit <sha>`, `--record-dir <path>`, `--critic <path>` twice, optional `--observed-pr <id>`, `--observed-ci <id>` |
| `kxm assign change-report` | Report attempts, rework, and spend | `--task-dir <path>` |
| `kxm docs build` | Regenerate the docs site from roadmap state | `--dry-run`, `--json` |
| `kxm docs serve` | Serve the built site on the tailnet address | `--port <port>`, `--dry-run`, `--json` |

The run record and its events keep only the prompt's hash, but the full
prompt text is kept in a local `run-events.db.run-prompts.json` file (mode
`0600`) next to the project's run store under the user state root. Keep
secrets out of run prompts.

`kxm runs drive <runId> --simulated --wait [--timeout-ms <n>]` executes the run
with the model-free simulation producer. Always pass `--simulated`; without it,
drive calls live harnesses. When you are finished, stop the supervisor with
`kxm runtime stop`.

## Smoke-test the first workflow

Run this only after the user has reviewed and committed
`.kxm/workflows/first.yaml`, which `kxm-project-setup` adds with
`kxm workflow add first --template spec-and-plan`, so `kxm trust check`
exits 0.

```bash
kxm run first "Plan a hello script" --dry-run
kxm run first "Plan a hello script" --json
kxm runs status run_12345
kxm runs drive run_12345 --simulated --wait --timeout-ms 60000 --json
kxm runs status run_12345
kxm runs receipt run_12345 --json
kxm runs list
kxm runtime stop
```

The dry run prints `run plan: workflow first at sha256:… (no run created)`.
After the drive, `kxm runs status` prints `completed … (receipt verified)` and
the receipt's settlement is terminal `completed`.

`kxm lane` keeps one git worktree per unit in the control checkout's
`.kxm/state/lanes.json`. `kxm run --brief <file>` reads the prompt from that
file. `kxm run --lane <unit>` and `kxm runs status|drive|receipt|cancel --lane`
discover the project from the lane worktree. `kxm lane run <unit> --brief <file>`
creates the lane when it is missing, starts the run, and drives it.

`kxm land` lands the current branch. With no `--stage` it runs these stages in
order: `verify`, `docs`, `push`, `pr`, `rebase`, `unblock`, `merge`,
`release`, `milestone`. `verify` runs `npm run verify` on a clean tree and is
not replaced by the later stages. `docs` regenerates the roadmap when
`plans/kxm-roadmap/update-dashboard.mjs` is present and commits only those
generated pages. `push` publishes the branch. `pr` reuses the open pull
request or creates one from `--body-file`. `rebase` rebases onto
`origin/main` for at most five rounds, resolving only the dist rebuild, the
CHANGELOG Unreleased union, and the tracker "Landed in this tree" union.
`unblock` reruns one failed check and reports a required review. `merge`
squash-merges. `release` waits for the tag and the npm publish. `milestone`
reports `deep_review_required` when a phase flips to done or the body contains
a `Milestone:` line, and does not run the review. `--dry-run` prints each
stage's plan and does not mutate.
`kxm assign` spawns `node scripts/assignment-run.mjs` from the project root and returns the child's exit code. Paths are passed through as given. `--dry-run` prints that argv and does not spawn. `--json` formats this command's own output and is not forwarded. The group does not load a working-directory `.env`. A project without `scripts/assignment-run.mjs` is refused with `assign_runner_missing`. Outside a KXM project the refusal is `project_required`. Witness, roster, and acceptance checks belong to the runner, documented in `docs/contributing/assignment-runner.md`.

## Refusals

- `run_workflow_unknown`: the workflow ID is not a project workflow. Run only
  IDs that `kxm workflow definitions` lists.
- `run_handoff_required`: the Runtime does not execute a field the workflow
  uses (such as `limits.maxAgentTimeMs`, which a fresh `kxm init` no longer
  writes), so drive fails with `runtime request failed with HTTP 409` and the
  run stays `preparing`. Cancel the run with `kxm runs cancel <runId>` and drive
  a workflow without the field, such as `first`.

Listing or status alone is not proof that steps ran; a verified receipt is.
A read-only step that settles `passed` did not author a checkout change.
`kxm workflow list` shows hub webhook runs, not these runs.

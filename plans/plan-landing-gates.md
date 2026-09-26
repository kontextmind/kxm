---
schema: "kxm.doc.v1"
id: "PLAN-LANDING-GATES"
type: "feature"
title: "Landing gates: verify, push, rebase, unblock, merge, and release as one command and one workflow"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-26"
updated: "2026-09-26"
authority: "hypothesis"
confidence: "high"
summary: "Standing instruction from the operator: every PR is monitored, rebased onto main, unblocked, merged, and followed through to the npm publish without asking; documentation is regenerated after a green pipeline and before the merge; every phase or milestone triggers the deep roadmap review. This slice adds kxm land (plugins/kxm/src/cli/land.ts over scripts/pr-land.mjs), which chains a green npm run verify, the roadmap and docs regeneration, push, PR creation or reuse, a bounded rebase loop with the known conflict unions, auto-merge or direct squash merge, a release watch, and the milestone trigger, and registers those stages as command gates in gates.yaml with a land workflow so kxm run land drives them with receipts. No just recipe is added; the repo is migrating off just. npm run verify stays the pre-push gate and is the first step of landing, not replaced by it."
tags: ["gates", "landing", "release", "devex", "cli"]
related:
  - plan-lane-cli.md
  - backlog-shortcuts.md
  - implementation-plan.md
depends_on:
  - plan-lane-cli.md
blocked_by: []
details:
  describes: "proposed"
  writer_route: "grok --model grok-4.7 per CLAUDE.md; this file is a planner artifact"
  brief: ".kxm/briefs/landing-gates.md"
  proven_by_hand: "PR #330 on 2026-09-26: verify, push, PR, REST squash merge, auto-release v0.7.120"
---

# Landing gates

Read [the execution tracker](implementation-plan.md) first. This file is
proposed work, not scheduled work.

## 1. Problem

Landing a PR on this repo is a sequence the operator wants done every time
without a prompt: watch the PR, rebase when main moves, resolve the two
conflicts that always recur (`plugins/kxm/dist` and the CHANGELOG or
Tracking lists), clear blockers, merge, then confirm the auto-release tag
and the npm publish. Each step has a known trap: `gh pr merge --auto` fails
on this repo, auto-merge cannot be enabled on a PR that is already `CLEAN`,
a rebase needs a dist rebuild and a fresh verify, and the npm registry lags
the Release run by several minutes.

`npm run verify` does none of this and should not. It is the pre-push gate
(build, tests, typecheck, docs lint, versions, generated files) and CI's
validate leg runs the same script. Landing is the stage after it. The two
belong in one chain, verify first.

## 2. Target

One command, in the kxm CLI (the repo is migrating away from just recipes;
no new recipe is added):

```text
kxm land                        # current branch: verify, docs, push, PR (create or reuse), rebase loop, merge, release, milestone
kxm land --pr 330               # an existing PR number
kxm land --stage rebase         # one stage, for gates
kxm run land --lane <unit>      # the same stages as a workflow with drive receipts
```

`scripts/pr-land.mjs`, Node only, `gh` and `git` as subprocesses, no new
dependencies. Stages, each with a stable result code and a JSON line:

| Stage | Does | Refuses with |
|---|---|---|
| `verify` | `npm run verify` on the current tree; skipped when a receipt for this exact tree hash exists from the last 30 minutes | `land_verify_failed` |
| `push` | `git push -u origin <branch>` or `--force-with-lease` after a rebase | `land_push_rejected` |
| `pr` | reuse the open PR for the branch or create one from a body file (`--body-file`) following `.github/pull_request_template.md` | `land_pr_body_missing` |
| `rebase` | when `mergeStateStatus` is `BEHIND` or `DIRTY`: fetch, `git rebase origin/main`; on conflict apply the unions below; `git checkout origin/main -- plugins/kxm/dist && npm run build`; re-run `verify` unless `git merge-tree --write-tree origin/main HEAD` was clean; push with lease. At most 5 rounds | `land_conflict_manual` with the file list |
| `unblock` | read `statusCheckRollup` and `reviewDecision`; rerun a failed check once with `gh run rerun --failed`; a required review is reported, not faked | `land_blocked` with the reason |
| `merge` | enable auto-merge with the `enablePullRequestAutoMerge` mutation; if the API answers "clean status", squash merge through `PUT /repos/{owner}/{repo}/pulls/{n}/merge` with the PR title plus `(#n)`; poll until `MERGED` | `land_merge_failed` |
| `docs` | after `verify` is green and before `merge`: run `node plans/kxm-roadmap/update-dashboard.mjs` (the roadmap generator, which also runs `mkdocs build`); if `docs/roadmap/`, `plans/kxm-roadmap/` or `site/`-excluded outputs changed, commit them on the branch as `docs(roadmap): regenerate after verify` and push. Never edits `state.json`. Operator rule 2026-09-26: documentation is updated after a green pipeline, then the merge happens | `land_docs_failed` |
| `release` | wait for the Auto-Release run whose title matches the PR, read the tag it pushed, wait for the Release run created after the merge time, then poll `npm view @kontextmind/kxm@<version> version` for up to 10 minutes | `land_release_failed`, `land_publish_timeout` |
| `milestone` | after `release`: read `plans/kxm-roadmap/state.json`; if this PR's merge flipped a phase to done (every task `done`), or the PR body names a milestone, run the deep pass (`/reanalyze-roadmap`, the `kxm-roadmap-review` skill with its read-only critic) instead of the refresh, and open a follow-up PR with the reviewed state. Operator rule 2026-09-26: after every phase or milestone the intense pass runs, not the refresh | `land_milestone_failed` |

Stage order: `verify`, `docs`, `push`, `pr`, `rebase`, `unblock`, `merge`,
`release`, `milestone`. `docs` runs again inside `rebase` when a rebase
changed the tree, so the regenerated pages always match the tree that merges.

Conflict unions, the only automatic resolutions:

- `plugins/kxm/dist/**`: take `origin/main`, rebuild, stage.
- `CHANGELOG.md`: under `## Unreleased`, union both sides' bullets per
  heading, ours first.
- `plans/implementation-plan.md` "Landed in this tree (unreleased)": union,
  newest first.
- Anything else: `land_conflict_manual`.

Gates in `.kxm/gates.yaml`, each a `command` gate calling the script with
one stage: `land-verify`, `land-rebase`, `land-merge`,
`land-release`. A workflow `.kxm/workflows/land.yaml` runs them in that
order with `on.failed` back to `land-rebase` at most 3 times, then terminal
failed. `kxm run land` then gives every landing a drive receipt and gate
evidence, which is what "this should be a gate" means.

## 3. What it must respect

- No merge without a green verify on the exact tree pushed.
- Rebase never rewrites a commit that is already on `main`.
- A required review or a failing required check is reported, not bypassed.
- The script never edits `state.json`, the tracker, or the changelog except
  by the unions above during a conflict.
- Squash only. Commit title is the PR title plus `(#n)`.
- Secrets never printed; `gh` handles auth.
- Bounded: 5 rebase rounds, 3 workflow retries, 10 minute publish wait.

## 4. Shape of the work

| Piece | File |
|---|---|
| Script | `scripts/pr-land.mjs`, stages as functions, `--stage <name>` for gates, no flag runs all |
| Gates and workflow | `.kxm/gates.yaml`, `.kxm/workflows/land.yaml` |
| CLI | `plugins/kxm/src/cli/land.ts` registering `kxm land` with `--pr`, `--stage`, `--body-file`, `--json`, `--dry-run`; owned by the `kxm-runs` bundled skill; documented in `docs/reference/cli-reference.md`. The stages live in `scripts/pr-land.mjs` so the command gates can call them without the CLI |
| Tests | `test/core/pr-land.test.ts`: the three unions on fixtures, the CLEAN-status fallback with a stubbed `gh`, the bounded rebase loop, and one refusal per stage |
| Docs | `docs/contributing/assignment-runner.md` gains a "Landing" section; `docs/reference/workflow-catalog.md` lists `land` |

One PR. The brief is [`.kxm/briefs/landing-gates.md`](../.kxm/briefs/landing-gates.md).

## 5. Solid versus interim

- **Solid:** the script plus the gates and the `land` workflow, so
  landings have receipts and the retry policy is declared in YAML.
- **Interim:** the script and the `kxm land` command alone, no workflow.
  Same behavior, no receipt. Acceptable if the timeout fix
  (`run-driver-timeouts`) has not landed, because `kxm run land` would run
  its command gates fine (gates have their own timeouts) but a planner
  reviewing the landing would still be a manual step.

Recommendation: interim first, because it removes the hand work today;
promote to the workflow in the same PR as the timeout fix.

## 6. Out of scope

- Any merge method other than squash.
- Creating GitHub issues, labels, or milestones.
- Re-enabling CI; the tracker owns that.

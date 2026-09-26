---
schema: "kxm.doc.v1"
id: "REVIEW-LANE-CLI-ARCH"
type: "architecture"
title: "Architecture review of aa359a6, kxm lane worktrees and file briefs (2026-09-25)"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-25"
updated: "2026-09-25"
authority: "hypothesis"
confidence: "verified"
summary: "PASS with four notes. The commit implements plan-lane-cli.md sections 2 and 3 as specified: one worktree per unit, a 0600 lane record in the control checkout's state directory keyed by resolved base sha, --lane as a cwd swap and nothing else, --brief as a file prompt, seven named tests, and just recipes reduced to wrappers. just verify re-run green by the reviewer. Notes: the lane record ignores KXM_WORKDIR on swap, run and drop may start the supervisor, lane run keeps --brief as an option rather than an argument, and the worktree recipe lost its ready line. Planner record, not assignment, witness or acceptance proof."
tags: ["review", "cli", "lanes", "runs"]
related:
  - ../plan-lane-cli.md
  - ../plan-omp-config-alignment.md
  - ../implementation-plan.md
depends_on: []
blocked_by: []
details:
  reviewed_commit: "aa359a6"
  base_commit: "1d0de97"
  lane: "../kxm-lane-cli"
  writer: "grok-4.7 via just impl-bg, 28 min, $5.31 provider-reported"
  verify: "just verify exit 0, re-run by the reviewer after the writer's own run"
---

# Architecture review of aa359a6

**Verdict: PASS.** Nothing here blocks landing. The four notes are follow-ups
or one-line fixes the writer can take in the same PR if the CLI critic also
returns PASS.

## What was checked

- Every checklist line in `.kxm/briefs/lane-cli.md` against the diff. All
  present, including the seven named tests and the `lanes_unreadable` refusal
  on a malformed record instead of a silent reset.
- `plugins/kxm/src/cli/lanes.ts` in full. `cli.ts` and `cli/project.ts` diffs.
  Test diffs. Schema, justfile, docs, and skill-mirror diffs.
- `just verify` re-run from the lane: exit 0.
- Smoke from the built CLI in the lane: `lane --help`, `lane list --json`,
  `lane create smoke-probe --dry-run --json` (resolves `origin/main` to the
  base sha and plans two writes without touching git or the state file),
  `run --help` shows `--brief` and `--lane`, and `run default --brief x words`
  refuses `brief_and_prompt` with exit 1.

## Findings that hold up the design

- **`--lane` is exactly a cwd swap.** `withLaneCwd` returns a Runtime whose
  `cwd` and `dirs` come from the lane path and touches nothing else. `kxm run`
  keeps its `workspace_option_unsupported` refusal. This is the mechanism the
  plan required and the reason the swap composes with `discoverKxmProjectRoot`
  unchanged.
- **Base is recorded as a sha, and the worktree is added at that sha.**
  `resolveBase` uses `rev-parse --verify --end-of-options <ref>^{commit}` and
  `git worktree add -b <unit> <path> <sha>`. Another session's fetch cannot
  move the recorded base.
- **Unit names are validated with the project identifier pattern** before
  they reach git, and `gitEnv` strips every `GIT_*` variable before spawning.
  The existing justfile positional-argument test was updated to assert the
  recipes call `kxm lane create "$1"` and `kxm lane drop "$1"` with a hostile
  unit string; that is the one test change the brief did not list and it
  follows from the justfile change.
- **The record is written 0600 and never silently replaced.** A malformed
  `lanes.json` refuses with `lanes_unreadable`; a missing one is an empty
  record. `create` rolls the worktree back if the record write fails.
- **`drop` never deletes the branch** and says so in both text and JSON
  (`branchDeleted: false`).
- **The extra files are explained by `check:generated`.** A new CLI group must
  be owned by a bundled skill, so `skill-suite.json`, `kxm-runs/SKILL.md`,
  `kxm/SKILL.md`, `agent-skills.md`, and the `.agents/skills` mirrors changed.
  The provenance deletion staged before dispatch is in the commit with its own
  message line.

## Notes (not blocking)

1. **`withLaneCwd` calls `workspaceDirs(lane.path, undefined, env)`**, and
   `workspaceDirs` prefers `env.KXM_WORKDIR` over its `cwd` argument. With
   `KXM_WORKDIR` set, the lane's `dirs` would point at the control workspace
   while `cwd` points at the lane. No caller sets it today. Either clear
   `KXM_WORKDIR` in the swapped env or document that lanes ignore it.
2. **`lane run` and `lane drop` may start the supervisor** through
   `refuseIfLaneRunOpen`, because `projectedRunStatus` is called with
   `allowStart: true` there. `lane status` correctly never starts it. The plan
   said `status` must not; it was silent on `drop`. Starting a supervisor to
   decide whether a drop is safe is defensible, but it should be in the
   reference doc's `lane drop` entry.
3. **`lane run` takes `--brief` as a required option.** The plan wrote it that
   way, so this is a note for the CLI critic rather than a deviation: a
   required option reads oddly next to a positional `<unit>`.
4. **The `worktree` just recipe lost its `@echo "lane ready at …"` line.**
   `kxm lane create` prints the lane line itself, so nothing is lost, but the
   recipe comment above it still says "lane ready".

## Follow-ups already recorded elsewhere

Section 4 of `plan-lane-cli.md` carries the four engine defects the first
dispatch surfaced. None of them is in this diff. The second dispatch, through
`just impl-bg`, is what produced this commit; the `kxm lane run` one-liner will
only work end to end once the 120 second one-shot timeout is configurable.

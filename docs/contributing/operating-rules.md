---
title: "Operating rules"
description: "Standing instructions from the operator that every agent session on this repository follows, with the date each was given. Read before planning, dispatching, landing, or editing the roadmap."
audience: "agents and maintainers"
updated: "2026-09-26"
---

# Operating rules

These are the operator's standing instructions, recorded so a session does
not have to be told twice. Each rule names the date it was given and where
it is enforced. A rule that is retired is deleted, not kept beside its
replacement.

## Roles and routes

- **The planner does not write product code.** Claude plans, reviews, and
  lands. The default writer is the native Grok CLI (`grok-4.7`), a starting
  rotation rather than a sole writer. If Grok is logged out, use a relief
  route the tracker admits or stop and say what was hit. (`CLAUDE.md`,
  standing.)
- **One writer per checkout.** Each unit of work runs in its own lane
  worktree (`kxm lane create <unit>`). Two writers in one tree clobber each
  other. (2026-09-25.)

## Landing

- **Every PR is landed without asking.** Once a PR is open: monitor it,
  rebase onto `main` when it falls behind, resolve conflicts and blockers,
  merge, and follow through to the auto-release tag and the npm publish.
  Report the outcome; do not stop to ask for the merge. Enforced by
  `kxm land` (verify, docs, push, pr, rebase, unblock, merge, release,
  milestone) and, until every stage is proven, by hand. (2026-09-26.)
- **Documentation is regenerated after a green pipeline and before the
  merge.** The `docs` stage of `kxm land` runs the roadmap generator and
  commits the regenerated pages on the branch. (2026-09-26.)
- **After every phase or milestone, the intense pass runs, not the
  refresh.** `/reanalyze-roadmap` (the `kxm-roadmap-review` skill with its
  read-only critic), triggered by the `milestone` stage reporting
  `deep_review_required`. (2026-09-26.)
- **`npm run verify` stays the pre-push gate.** It is the first stage of
  landing and is never replaced by it. CI's validate leg runs the same
  script. (2026-09-26.)
- **After every publish, the workflow runs on the improvements it just
  landed.** `kxm update --kxm`, then `kxm update --extensions`, then
  `kxm plugin install --all`, so the CLI and the kxm plugin in pi, omp, and
  Claude Code are current; the Claude Code session then needs
  `/reload-plugins`, which only the operator can run. The supervisor tick
  does this after any `PUBLISHED` line. (2026-09-26.)

## Entry points

- **No new just recipes.** The repository is migrating off `just`. A needed
  entry point is a `kxm` command: a group under `plugins/kxm/src/cli/`,
  registered in `cli.ts`, owned by a bundled skill so `check:generated`
  passes, documented in the CLI reference. Existing recipes retire as their
  `kxm` verbs land; the transport recipes (`impl`, `plan`, `review-*`,
  `impl-bg`) retire last, after one real unit has run through the one-step
  workflows. (2026-09-26.)

## Decisions and debt

- **Every option comes with pros and cons and two recommendations**, the
  solid-product answer and the interim answer. (2026-09-26.)
- **Every shortcut goes on the backlog the same turn it is taken**, as an
  item in `plans/backlog-shortcuts.md` with what was skipped and the proper
  fix. (2026-09-26.)

## Roadmap and plan content

- **No stale data.** A fact that no longer holds is replaced, never kept
  beside its replacement.
- **History is brief.** One short line per material change, capped by the
  generator; never a running narrative.
- **No stale contacts.** A contact carries a role and a confirmation date;
  unconfirmed past 90 days is dropped. Empty is fine.
- **Present and upcoming only.** Superseded material leaves the roadmap.
- **Progressive detail.** A far-off phase or task is brief but complete
  (goal, scope, done criterion, evidence needed) and gains detail as it
  nears implementation. A task cannot be `ready` without a template and a
  source.
- **Tasks use the artifact templates** under `docs/templates/`.

All six enforced by the `kxm.roadmap.v1` schema, the generator's semantic
refusals, and the two roadmap skills. (2026-09-26.)

## Monitoring

- **Background monitors emit progress, not only results**, in this line
  form: `[{lane}/{agent}]: {phrase}. {No action|Review needed}. -
  {E}e|{D}d ({M}m{S}s)`. Routine lines are not echoed back in chat.
  (2026-09-26, formatter at `~/.claude/scripts/evt-monitor.sh`.)
- **A supervisor tick runs every five minutes** while a session is open:
  sweep the lanes, act on "Review needed", cap concurrent verifies at two,
  regenerate the roadmap after a merge, and run the improvement loop every
  sixth tick. Its prompt is checked in at
  `plans/kxm-roadmap/supervisor-prompt.md`; a tick that finds the schedule
  missing or expiring recreates it from that file in the same chat session,
  never a new one, so the loop continues under the same task. (2026-09-26.)

## Where the same rules live for agents

The session memory under `~/.claude/projects/…/memory/` mirrors these as
`pr-landing-autonomy`, `pipeline-docs-then-merge`, `no-just-prefer-kxm-cli`,
`decisions-pros-cons-backlog`, `roadmap-editorial-rules`, and
`monitor-progress-events`. This page is the checked-in copy; when the two
disagree, this page is updated and the memory follows.

---
title: "Learnings"
description: "Durable lessons from running the writer, critic, and landing loop on this repository. One entry per lesson, with the evidence and where it applies. Pruned when a lesson stops being true."
audience: "agents and maintainers"
updated: "2026-09-26"
---

# Learnings

A lesson earns a line here when it would save a future session more than a
few minutes. Each entry: the lesson, the evidence, where it applies. An
entry whose fix has landed is deleted, not archived.

## Dispatch and lanes

- **A "no retired names anywhere" rule must exclude the history pages.**
  The P2 brief asked that retired recipe names appear nowhere in docs; the
  writer then rewrote dated lessons and rules on this page and on
  `operating-rules.md` into nonsense ("applies to `kxm lane run` and
  `kxm lane run`") and hand-edited generated roadmap pages. Sweeps like
  that exclude `docs/contributing/learnings.md`, `operating-rules.md`,
  `plans/`, and `CHANGELOG.md`, and the planner reverts any edit to them.
  Evidence: omp-align-p2, 2026-09-26. Applies to: every brief with a
  "returns nothing" grep.

- **Branch every lane from the current `origin/main`, and rebase before
  review, not after.** Three branches cut before #330 and #331 landed each
  needed a hand rebase with the same additive conflicts (`cli.ts`
  registrations, skill ownership lists, skill mirrors, changelog, dist).
  Evidence: kxm-assign, docs-site, run-driver-timeouts on 2026-09-26.
  Applies to: every brief; `kxm land`'s rebase stage only knows three
  conflict unions.
- **After an additive rebase, check the skill frontmatter and heading
  spacing.** Keeping both sides doubled a `description:` key in a SKILL.md
  (strict-YAML test) and butted two `##` headings together (MD022).
  Evidence: kxm-assign verify failures, 2026-09-26. Applies to: any
  hand-resolved conflict in `plugins/kxm/skills/` or the CLI reference.
- **Never run more than two `npm run verify` at once on this machine.**
  Six concurrent runs stretched a seven-minute gate past thirty minutes and
  starved a landing. Evidence: 2026-09-26, 02:10 to 02:40. Applies to: the
  supervisor tick and any batch of writers finishing together.
- **The transport's stdin read can fail with `EAGAIN` under concurrent
  detached dispatch.** Retry once; the request itself is fine. Evidence:
  two occurrences on 2026-09-26 (backlog S18). Applies to:
  `scripts/harness-run.mjs` dispatches, which outlive the retired just
  recipes.
- **Do not launch a writer under the Bash tool's ten-minute background
  cap.** It kills the harness mid-run. Give the dispatch call an unbounded
  timeout, use the detached runner, or `kxm lane run`. Evidence: the first
  lane-cli dispatch, 2026-09-26; omp-align-p2 repairs ran 15 to 36 minutes
  in 2026-09-26 background jobs with an unbounded timeout and survived.
- **Do not run a standalone `npm run verify` on a branch that `kxm land`
  will land.** The `verify` stage runs it again, so the standalone run
  only spends one of the two verify slots twice. Run the critics on the
  writer's own verify evidence, then go straight to `kxm land`. Evidence:
  docs-site, 2026-09-26. Applies to: every lane after its writer finishes.

## Engine and runtime

- **A lane whose `.kxm` schemas are ahead of the installed runtime cannot
  be driven, observed, or cancelled by the engine.** Every run-scoped
  request (status, drive, cancel, receipt) answers 400
  `schema_additionalProperties`, because `loadKxmProject` validates the
  project before the route: installed 0.7.130 refuses the P2 lane's
  `role:` on `.kxm/agents/*.yaml` while the branch's own loader validates
  clean. The morning `implement-only` run executed before the writer
  rewrote the agent files (c352285 landed mid-run), then settled `failed`
  with `authored: false` and witness unchanged, and the lane now refuses
  new runs with `lane_run_open` because that run cannot be cancelled.
  Until the branch ships, `kxm update --kxm` runs, and the runtime
  supervisor restarts, dispatch repairs and critics through the harness
  transport. Resolved for this lane by 0.7.131: after the update and a
  runtime restart, the lane loads clean, the stuck run cancelled
  idempotently, and a simulated drive returned a verified receipt.
  Evidence: omp-align-p2 lane, 2026-09-26. Applies to: every
  dispatch whose lane changes schemas.

- **The improvement reports read only the control root's own store.**
  `kxm improve report` and `kxm routing report` read the run-events store
  of the checkout they run in, so a registered lane's attempts are
  invisible from the parent (backlog S30): on 2026-09-26 the control-root
  report read 0 records while the lane store held the settled attempts.
  Run the reports inside the lane, or dispatch through the engine from the
  root you report on. Evidence: both reports on the P2 control root
  (0 records) versus the same reports inside the omp-align-p2 and
  docs-cadence lanes (settled attempts). Applies to: the supervisor's
  improvement loop and any report run from a parent checkout.

- **Template provenance is refused when the installed kxm moves ahead of
  the stamped revision, and a project without the file validates as
  ready.** Deleting the file is the sanctioned state until `kxm init` can
  re-stamp. Evidence: backlog S3 (still open; the re-stamp decision is
  unmade) and the live check at `plugins/kxm/src/project-config.ts`.
  Applies to: every fresh lane.

## `kxm land`

- **Auto-merge cannot be enabled on a PR that is already `CLEAN`**; the
  mutation answers "clean status" and the REST squash merge is the path.
  While CI is paused every PR is clean, so this is the normal path.
- **A verify failure inside `kxm land` names the exit code, the failing
  step, and a short excerpt, and keeps the full output in
  `.kxm/logs/land-verify-<tree>.log`.** The receipt
  `.kxm/logs/land-verify-<tree>.json` records the same fields with
  `ok: false`. `mergeStateStatus: UNKNOWN` is polled and refused at the
  bound; it is not treated as ready to merge.

## Reviews

- **A CLI critic reviewing a branch cut from an older base will report
  main's later additions as deletions.** Say the base commit in the brief
  and tell the critic to review against it. Evidence: docs-site review,
  two of five findings were base artifacts.
- **Read-only critics cannot leave their lane sandbox.** The architecture
  critic three times could not read a brief under the main checkout's
  `.kxm/briefs/` and reviewed against the question list alone, once
  re-flagging a decision the brief had already settled. Copy the brief
  into the lane's gitignored `.kxm/logs/` and dispatch from that path.
  Evidence: omp-align-p2 passes 1 to 3, 2026-09-26. Applies to: every
  read-only critic dispatch.

## omp research, kept for the alignment plan

- **omp's roster is `modelRoles` plus `retry.fallbackChains`**, walked on
  provider errors with a revert policy; KXM's roster is a membership test
  and never rotates. The passive `kxm.role.v2` draft already has the
  better shape (routes with status and fallbacks); activate it rather than
  invent a new v2. Source: `plans/research-omp-config-schema.md`.
- **omp has no workflow file.** Its `workflowz` is a prompt contract over
  an eval kernel. Nothing to port; KXM's workflow file is the stronger
  model.

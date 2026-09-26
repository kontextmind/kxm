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
  two occurrences on 2026-09-26 (backlog S18). Applies to: `just impl-bg`
  and `just review-cli` until they retire.
- **Do not launch a writer under the Bash tool's ten-minute background
  cap.** It kills the harness mid-run. Use the detached recipe or
  `kxm lane run`. Evidence: the first lane-cli dispatch, 2026-09-26.
- **Do not run a standalone `npm run verify` on a branch that `kxm land`
  will land.** The `verify` stage runs it again, so the standalone run
  only spends one of the two verify slots twice. Run the critics on the
  writer's own verify evidence, then go straight to `kxm land`. Evidence:
  docs-site, 2026-09-26. Applies to: every lane after its writer finishes.

## Engine and runtime

- **The improvement loop is blind while writers bypass `kxm run`.** Every
  writer this week ran through the harness runner (`just impl-bg` and the
  critic recipes), which records no engine events, so `kxm improve report`
  and `kxm routing report` both return zero records and no candidates.
  Evidence: both reports on 2026-09-26 at 08:14 UTC list the engine store as
  absent and telemetry as empty. Applies to: dispatch. Once the one-step
  workflows land, dispatch through `kxm lane run --workflow implement-only`
  so attempts land in the run-events store; until then the sixth-tick
  improvement loop reports nothing by design.

- **A live agent step had a hard 120 second timeout with no configuration
  path.** The supervisor built the one-shot producer without a timeout.
  Fixed on the run-driver-timeouts branch (step `timeoutMs`, project
  `limits.agentStepTimeoutMs`, default one hour). Delete this entry when
  that lands.
- **A run with an unreconciled executing attempt could not be cancelled or
  driven again**, and that survived a supervisor restart; deleting the
  lane's Runtime project store was the only recovery. Fixed on the same
  branch (`executing_unrecorded`, admission released on a handoff receipt).
  Delete when it lands.
- **The engine sends `--reasoning-effort low` on a first attempt regardless
  of the role's effort.** `engine.ts` hard-codes it. Open; covered by the
  role alignment plan P2 and P6.
- **Template provenance is refused when the installed kxm moves ahead of
  the stamped revision, and a project without the file validates as
  ready.** Deleting the file is the sanctioned state until `kxm init` can
  re-stamp. Evidence: every fresh lane on 2026-09-26 until #330 removed it.

## `kxm land`

- **Auto-merge cannot be enabled on a PR that is already `CLEAN`**; the
  mutation answers "clean status" and the REST squash merge is the path.
  While CI is paused every PR is clean, so this is the normal path.
- **The Release workflow's run is titled `Release`, never the PR title.**
  Match it by time after the Auto-Release run. Fixed on kxm-land-followup;
  delete when it lands.
- **A verify failure inside `kxm land` shows only the child's last output
  line.** Re-run verify by hand to see the cause until backlog S19 lands.

## Reviews

- **A CLI critic reviewing a branch cut from an older base will report
  main's later additions as deletions.** Say the base commit in the brief
  and tell the critic to review against it. Evidence: docs-site review,
  two of five findings were base artifacts.
- **Usage errors are Commander prose even under `--json` in every group.**
  Repo-wide, one fix in `mapCommanderError`; on kxm-land-followup. Delete
  when it lands.

## omp research, kept for the alignment plan

- **omp's roster is `modelRoles` plus `retry.fallbackChains`**, walked on
  provider errors with a revert policy; KXM's roster is a membership test
  and never rotates. The passive `kxm.role.v2` draft already has the
  better shape (routes with status and fallbacks); activate it rather than
  invent a new v2. Source: `plans/research-omp-config-schema.md`.
- **omp has no workflow file.** Its `workflowz` is a prompt contract over
  an eval kernel. Nothing to port; KXM's workflow file is the stronger
  model.

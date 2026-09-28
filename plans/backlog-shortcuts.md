---
schema: "kxm.doc.v1"
id: "BACKLOG-SHORTCUTS"
type: "feature"
title: "Backlog of shortcuts taken to unblock work, with the proper fix for each"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-25"
updated: "2026-09-26"
authority: "hypothesis"
confidence: "verified"
summary: "Running list of every interim step taken instead of the solid fix, so nothing skipped is forgotten. Each item names what was done, why, what the proper fix is, and where that fix is already planned when it is. Appended in the same turn a shortcut is taken. Not a tracker; execution stays in implementation-plan.md."
tags: ["backlog", "debt", "shortcuts"]
related:
  - implementation-plan.md
  - plan-lane-cli.md
  - plan-omp-config-alignment.md
  - plan-landing-gates.md
  - reviews/lane-cli-review-arch.md
depends_on: []
blocked_by: []
details:
  describes: "observed"
  rule: "one item per shortcut; an item closes when the proper fix lands, with the landing commit noted"
---

# Backlog of shortcuts

Read [the execution tracker](implementation-plan.md) first. This file records
debt; it schedules nothing. Each item: **what was done**, **why**, **proper
fix**, **planned where**. Severity is the cost of leaving it: **high** means
a governance or proof gap, **medium** means a defect users will hit,
**low** means hygiene.

## Open

### S1. Writer dispatched through transport, not the governed path (high)

- **Done:** the lane-cli unit was written via `just impl-bg`, reviewed via
  `just review-cli` and a planner review, and verified by hand. No
  `kxm.assignment.v1` manifest, no witness receipt, no `accepted.json`.
- **Why:** `kxm run` kills every live agent step at 120 seconds
  (`plan-lane-cli.md` section 4 item 1), and the assignment runner needs the
  same one-shot path.
- **Proper fix:** land `.kxm/briefs/run-driver-timeouts.md`, then re-run the
  lane-cli unit as a real assignment (`plan-current`, `assign`, `witness`,
  two `review-*` assignments, `accept`) before it merges, or accept it with an
  explicit note that this unit predates the timeout fix.
- **Planned where:** brief written; not on the tracker.

### S2. Runtime project store deleted to clear a stuck run (high)

- **Done:** `~/Library/Application Support/KXM/runtime/projects/d2be13fc…`
  for the lane was deleted so a new run could be admitted after
  `run_busy` survived a supervisor restart.
- **Why:** a run with an unreconciled executing attempt cannot be cancelled
  or driven; there is no documented recovery.
- **Proper fix:** recovery section of `run-driver-timeouts.md`: settle an
  executing attempt whose child exited as `executing_unrecorded`, release
  admission when a receipt closes with a handoff, and name the attempt in
  `runs status`.
- **Planned where:** same brief.

### S3. Template provenance deleted instead of re-stamped (medium)

- **Done:** `.kxm/template-provenance.yaml` was removed on the lane branch,
  matching the operator's uncommitted deletion in main.
- **Why:** kxm 0.7.115 refuses the revision #179 stamped, and a project
  without the file validates as ready.
- **Proper fix:** either `kxm init` learns to re-stamp provenance against the
  installed baseline when the recorded revision is unknown, or the file is
  removed from the template and its check retired. Decide which; the current
  behavior refuses a committed file every time the CLI moves ahead of it.
- **Planned where:** not planned. Belongs with `kxm init` ownership.

### S5. Reference doc gaps from the CLI critic (low)

- **Done:** landed the lane-cli commit with two gaps in
  `docs/reference/cli-reference.md`: no "Refusals" list under `lane run`,
  and `lane_unit_invalid` and `lanes_unreadable` missing from the four `runs`
  entries that take `--lane`.
- **Proper fix:** a doc-only repair on the lane branch, or folded into the
  `run-driver-timeouts` PR which edits the same file.
- **Planned where:** decision pending (this session's option list).

### S6. Planner artifacts live only in main, uncommitted (medium)

- **Done:** the omp research pair, the two plans, the lane plan, this
  backlog, the review artifacts, the evidence extract, and the diagram
  triplet are untracked in the main checkout. The CLI critic could not read
  `plan-lane-cli.md` from the lane for that reason.
- **Proper fix:** a docs-only PR that lands them, before or with the lane-cli
  PR, so reviewers see the plan they are reviewing against.
- **Planned where:** not planned.

### S7. `kxm lane run` one-liner does not work end to end (medium)

- **Done:** the verb exists and is tested with a stubbed supervisor, but a
  real run through it will hit the 120 second kill on any writer step.
- **Proper fix:** S1's timeout fix. Until then the reference doc should say
  the verb is for short steps or simulated drives.
- **Planned where:** `run-driver-timeouts.md`; the doc caveat is not written.

### S8. Lane CLI notes from the architecture review (low)

- **Done:** landed with `withLaneCwd` ignoring `KXM_WORKDIR`, `lane drop`
  and `lane run` able to start the supervisor, `--brief` as a required option
  on `lane run`, and the `worktree` recipe's comment still saying "lane
  ready".
- **Proper fix:** clear `KXM_WORKDIR` in the swapped env or document it;
  document supervisor start under `lane drop`; consider `<brief>` positional;
  fix the comment.
- **Planned where:** `reviews/lane-cli-review-arch.md` notes 1 to 4.

### S9. No `--detach` on `lane run`, no per-role one-step workflows (low)

- **Done:** `just impl-bg` and the four transport recipes still have no
  governed equivalent; `just impl` still pins model literals.
- **Proper fix:** `kxm lane run --detach`; `implement-only`,
  `review-arch-only`, `review-cli-only` workflow files; then retire the
  transport recipes.
- **Planned where:** the three workflow files are in
  `.kxm/briefs/run-driver-timeouts.md` (dispatched 2026-09-26 on lane
  `run-driver-timeouts`); `--detach` is still unplanned; the retirement
  commit follows one real unit driven through `implement-only`.

### S10. No `kxm gate run <id>` (low)

- **Done:** `just verify` and `just check-generated` stay npm scripts; the
  gate group cannot run a registered command gate on demand.
- **Proper fix:** register `verify` and `check-generated` in `gates.yaml` and
  add `kxm gate run`.
- **Planned where:** not planned.

### S11. Assignment runner has no kxm equivalent (high, design)

- **Done:** nothing; recorded that `assign`, `witness`, `accept`,
  `plan-current`, `attribute`, `observe-cost`, `change-report` cannot be
  composed from `kxm` verbs because their proof model (witness receipt,
  acceptance record, three-vendor rule) has no counterpart in `kxm runs`.
- **Proper fix:** a decision: grow `kxm runs` receipts into witness and
  acceptance records, or keep the runner as the proof system behind a
  `kxm assign` group.
- **Planned where:** the no-loss interim, `kxm assign` as a thin wrapper
  that changes nothing in the runner, is in `.kxm/briefs/kxm-assign.md`
  (dispatched 2026-09-26 on lane `kxm-assign`). The proof-model decision
  itself stays open and belongs beside `plan-omp-config-alignment.md` P2.

### S12. Empty improvement report committed to the tree by accident (low)

- **Done:** `kxm improve report` at session start wrote an empty
  `.kxm/assets/improvements/2026-09-26T00-08-37-902Z.json` into a tracked
  directory.
- **Proper fix:** delete the file; consider having `improve report` skip the
  write when it has zero records.
- **Planned where:** not planned.

### S13. gstack removal left stale settings backups and GBrain (low)

- **Done:** seven pre-existing `~/.claude/settings.json.bak.*` files still
  contain the gstack hooks; GBrain config and MCP registration remain.
- **Proper fix:** delete the stale backups; decide whether GBrain stays.
- **Planned where:** operator's machine, not the repo.

### S14. omp and KXM role configs are not derived from each other (low)

- **Done:** nothing; omp runs grok at `high` and plans on Opus 5.5 while
  KXM runs grok at `medium` and plans on Fable.
- **Proper fix:** `kxm plugin install --omp` writes `modelRoles` and
  `retry.fallbackChains` from the role files, or the two are declared
  independent on purpose.
- **Planned where:** `plan-omp-config-alignment.md` section 7, open question.

### S15. Roadmap state seeded from documents, not from a review pass (medium)

- **Done:** the docs-site brief seeds `plans/kxm-roadmap/state.json` by
  having the writer read the plans and the tracker, with `architecture.verified`
  left null.
- **Why:** the first baseline had to come from somewhere, and a live review
  pass with a critic is the reanalyze skill's job, not the build's.
- **Proper fix:** run `/reanalyze-roadmap` once after the site lands, with
  its critic, and treat that pass as the real baseline. Any `done` task the
  critic reverts goes back to `open`.
- **Planned where:** the docs-site brief's acceptance list; not on the
  tracker.

### S16. Usage errors are Commander prose even under `--json` (medium)

- **Done:** every CLI group, including the new `lane`, `land`, `docs`, and
  `assign`, exits 2 on a missing required option with Commander's own
  message and no JSON envelope. The kxm-assign CLI critic raised it
  (2026-09-26); confirmed on `kxm lane run --json` from main.
- **Why:** `mapCommanderError` in `plugins/kxm/src/cli.ts` maps the code to
  exit 2 but does not print a `kxm.cli-result.v1` refusal when `--json` is
  set.
- **Proper fix:** one change in `mapCommanderError` (or the `exitOverride`
  handler) that, under `--json`, prints
  `{ok:false, command, error:"usage_error", detail}` before exit 2, plus one
  test. Fixes every group at once.
- **Planned where:** not planned; small enough for the next CLI slice.

### S17. `kxm land` first-run defects (medium, fix in flight)

- **Done:** `kxm land` landed itself as #331. Two defects: the PR title
  came from the branch name (main's squash commit reads `landing-gates
  (#331)`), and the release stage matched the Release run by PR title,
  which that run never carries, so it expired after 20 minutes with
  `land_release_failed` although `v0.7.121` was already published.
- **Why:** first real run of new code; the Auto-Release run does carry the
  title, the Release run is titled `Release`.
- **Proper fix:** `.kxm/briefs/kxm-land-followup.md`: title from the first
  commit or `--title`, Release run matched by time, progress lines while
  polling. Dispatched 2026-09-26 on lane `kxm-land-followup`. Main's
  commit title is not rewritten.
- **Planned where:** that brief; closes when it lands.

### S18. Transport preflight fails with EAGAIN on stdin under concurrent dispatch (low)

- **Done:** retried by hand. `scripts/harness-run.mjs -` reads the request
  envelope from stdin; twice on 2026-09-26 (a second `just impl-bg` two
  seconds after the first, and a `just review-cli` while four writers were
  running) it failed at preflight with `EAGAIN: resource temporarily
  unavailable, read` before spawning anything.
- **Why:** non-blocking stdin under `nohup` and the background runner; the
  read is not retried.
- **Proper fix:** accept the envelope as a file path (`harness-run.mjs
  <request.json>`) in the recipes and in `kxm lane run`, or retry the stdin
  read on `EAGAIN`. Moot for the transport recipes once they retire; still
  relevant to any caller that pipes an envelope.
- **Planned where:** not planned.
- **Interim that works (2026-09-26):** write the request envelope to a file
  and run `just dispatch <file> < /dev/null`; the stdin read never happens.
  Three consecutive `just review-cli` dispatches failed with `EAGAIN` while
  a verify ran in the same lane; the file dispatch succeeded first time.

### S19. `kxm land` verify failure hides the cause (medium)

- **Done:** on #332 the `verify` stage refused `land_verify_failed` with
  detail `plugins/kxm/dist/mcp-server.js 611.4kb ⚡ Done in 154ms`, the last
  line of esbuild output, and nothing else. The real failing check is
  unknown until verify is re-run by hand.
- **Why:** the stage captures the child's last output line as the detail
  and keeps no log.
- **Proper fix:** write the full verify output to
  `.kxm/logs/land-verify-<treehash>.log`, set the detail to the failing
  lines (`✖`, `not ok`, `error TS`, `error MD`, `out of date`, `npm ERR`)
  plus the log path, and say so in the reference doc.
- **Landed:** the stage line and the receipt name the exit code, the failing
  step, and a short excerpt, and the full output is in that log.

### S20. The roadmap supervisor lives in one chat session's memory (medium)

- **Shortcut:** the thirty-minute supervisor is a session-only schedule
  inside the planner's Claude Code session. It renews itself from
  `plans/kxm-roadmap/supervisor-prompt.md`, but it dies with the process:
  a closed terminal window or a reboot stops the roadmap loop until an
  operator reopens the chat.
- **Why:** the schedule tool has no durable mode, and the loop needs the
  local worktrees, the Grok writer, and `npm run verify`, so a cloud
  schedule cannot run it.
- **Proper fix:** a `kxm supervise` verb backed by a macOS LaunchAgent
  that keeps a Herdr persistent session up and, every thirty minutes,
  submits the checked-in tick prompt to the resumed planner chat with
  `herdr agent prompt`. The chat survives closed windows through Herdr,
  and the heartbeat survives Claude restarts through launchd; the
  in-session schedule becomes a fallback rather than the only clock.
- **Interim:** host the planner chat in a Herdr session now
  (`herdr --session kxm`, then `claude --resume <session-id>` in a pane),
  keep the self-renewing in-session schedule, and add the LaunchAgent
  heartbeat by hand before the verb exists.
- **Planned where:** a lane-cli follow-up slice; design in
  `plans/plan-lane-cli.md` section 5 when it is written.

### S21. `repo-work-delivery` skill has no YAML frontmatter (low)

- **Shortcut:** `.agents/skills/repo-work-delivery/SKILL.md` is written
  without the `---` frontmatter block, so Codex logs
  `failed to load skill ... missing YAML frontmatter` on every critic run
  and the skill is invisible to it.
- **Why:** the page was authored as prose before the skill loaders
  required frontmatter; nothing in `check:generated` checks it.
- **Proper fix:** add `name` and `description` frontmatter, mirror it under
  `plugins/kxm/skills/` if it belongs to the suite, and add a test that
  every `SKILL.md` under `.agents/skills/` parses as frontmatter plus body.
- **Planned where:** the docs-only planner PR after the current lanes land.

### S22. `kxm land` rebase stage passes on `mergeStateStatus: UNKNOWN` (medium)

- **Shortcut:** when GitHub has not finished computing the merge state
  (right after another PR merges), the rebase stage reports `UNKNOWN` and
  continues. #334 then merged as a GitHub three-way merge on top of #333
  without a rebase, so the verified tree was not the merged tree.
- **Why:** the stage treats any state other than `BEHIND`, `DIRTY`, and
  `BLOCKED` as clean.
- **Proper fix:** poll `mergeStateStatus` until it leaves `UNKNOWN` (bounded,
  with a progress line), then rebase when `BEHIND`, and refuse
  `land_merge_state_unknown` at the bound. Evidence: #334 on 2026-09-26.
- **Landed:** `UNKNOWN` is polled with bounded backoff and refused at the
  bound. `CLEAN` and `HAS_HOOKS` proceed. `BEHIND` and `DIRTY` still rebase.
  Any other known state is `land_merge_not_ready`. Merge uses the same gate.

### S23. The roadmap generator leaves stale phase pages behind (low)

- **Shortcut:** when phases are inserted or reordered, the generator writes
  the new numbered pages but never removes the old ones, so
  `plans/kxm-roadmap/phases/` held two copies of every phase after the first
  deep review. Deleted by hand in that review.
- **Why:** the generator only writes; it has no view of the previous set.
- **Proper fix:** the generator removes any `phases/*.md` it did not write in
  this run and reports each removal once, so the no-stale-data rule holds
  for generated pages too. Evidence: 2026-09-26 deep review.
- **Planned where:** next docs-site slice, with the mkdocs nav warnings.

### S25. The engine's one-shot effort comes from the model inventory, not the role roster (medium)

- **Shortcut:** the first engine-dispatched writer (omp-align-p1, 2026-09-26)
  ran `grok-4.7` at reasoning effort low. The one-shot producer passes its
  resolved `thinking` value as the effort flag and the agent file sets none,
  so the run got low; the writer role's roster says `effort: medium` for that
  route, and the retired `just impl` recipe hard-coded medium. The run was left to finish under the critic gate
  rather than cancelled.
- **Why:** agents name a harness and model directly and never consult the
  role roster; `effort` on a roster entry is decorative until P2.
- **Proper fix:** P2 of the role-authority plan: agents gain `role:`, the
  producer resolves route and effort through the roster entry, and the
  producer's default is only the fallback when the roster entry has none. Until then, a per-agent `thinking` override is the interim, recorded
  in the agent file and the config reference.
- **Planned where:** P2 (`plans/plan-omp-config-alignment.md` section 5).

### S26. The core test suite can hang after its last file (high)

- **Shortcut:** twice on 2026-09-26 the `node --test` runner kept running
  after every test file had finished: the docs-site verify (log silent for
  35 minutes after a failed runtime-supervisor test) and the P1 writer's own
  verify in the omp-align-p1 lane (runner idle in the event loop with no
  child processes and no foreign holder of its pipes). The first was killed
  by hand; the second was left to the one-hour step limit.
- **Why:** a test leaves a handle open in the runner process, and the
  runner waits for the loop to drain; which test is unknown.
- **Proper fix:** find the leaking handle (`--test-force-exit` off, run with
  `--trace-uncaught` and `process.getActiveResourcesInfo()` at the end of
  each suspect file) and close it; until then run the suite with
  `--test-force-exit` so a green run exits and a failed run reports, and
  put a hard timeout on the `test` script.
- **Planned where:** the next engine slice with S24; it costs a verify slot
  for up to an hour each time it hits.
- **Interim landed (2026-09-26, lane-registry branch):** `--test-force-exit`
  on the `test` script; two runs without the flag exited cleanly and no
  file left a handle, so the leak was not reproduced and no test was
  changed. The entry stays open until the handle is found or a month of
  green runs passes without a hang.
- **Correction (2026-09-26, Release run for #339):** the per-test timeout
  added with the interim bounds whole files under `node --test` and failed
  the coverage job; it is removed again and the wall-clock guard is the
  only bound.

### S27. The harness runner exports both `FORCE_COLOR` and `NO_COLOR` (low)

- **Shortcut:** the P1 repair writer's first `npm run verify` failed four
  stderr assertions because its process had both variables set; the same
  command with them unset passed. The writer worked around it; nothing was
  changed in the runner.
- **Why:** `scripts/harness-run.mjs` (or the `just impl` recipe) sets one
  for its own output and inherits the other from the operator's shell.
- **Proper fix:** the runner clears `NO_COLOR` and `FORCE_COLOR` in the
  child environment and sets neither; a test asserts the child env.
- **Planned where:** with S18 when the transport recipes retire.

### S28. A fresh lane has no dependencies, so its first verify fails (medium)

- **Shortcut:** `kxm lane create` makes the worktree and nothing else. The
  first `npm run verify` in it (the writer's own, or `kxm land`'s verify
  stage) fails at the build with `Could not resolve` until someone runs
  `npm ci`. On 2026-09-26 the #338 landing failed this way in 38 seconds
  and was rerun by hand after the install.
- **Why:** the lane plan left dependency install to the writer.
- **Proper fix:** `kxm lane create` runs the project's install command
  (`npm ci`, from a `lane.install` setting or the lockfile it finds) unless
  `--no-install`, and `kxm land`'s verify stage refuses early with
  `land_dependencies_missing` naming the command when `node_modules` is
  absent. One test each.
- **Planned where:** the lane-cli follow-up with S20.

### S29. Bounded runner and registry promotion leave two edges (low)

- **Shortcut:** in `scripts/run-bounded.mjs` the SIGKILL follow-up timer
  is unreferenced and the parent exits 124 as soon as the group leader
  dies, so a grandchild that ignores SIGTERM can outlive the run; SIGHUP
  is not forwarded. In the registry, promoting a primary checkout over a
  lane recorded as home does not reparent dead rows, so a dead old home
  can still sort first in `project()`. Both accepted by the third
  architecture pass as non-blocking (2026-09-26).
- **Why:** the round fixed the reported cases and stopped there.
- **Proper fix:** keep the SIGKILL timer referenced until the group is
  gone (poll `process.kill(-pgid, 0)`), forward SIGHUP, and reparent or
  delete dead rows during promotion; one test each.
- **Planned where:** the next engine slice after P2, or sooner if a hang
  recurs.

### S30. Improvement reports read only the control root's own store (medium)

- **Shortcut:** `kxm improve report` and `kxm routing report` read the
  run-events store derived from the checkout they run in
  (`improve-sources.ts` calls `kxmProjectRunEventsPath(projectRoot)`), so
  attempts that a registered lane settles are invisible from the parent.
  On 2026-09-26 the control-root report read 0 records while the
  omp-align-p2 lane store held its settled attempt; S24 registered the
  lane for the runtime but did not extend the report sources.
- **Why:** the P2 unit's writer and critic attempts ran through the
  harness transport and in-lane engine drives while the schema gap held,
  so the roadmap proof (loop-dispatch) still lacks a parent-visible
  attempt row.
- **Proper fix:** read the project's home store and every lane store for
  the same project id (the registry carries `lane_of`), with the same
  read-only single query and duplicate drop as today. One test: an
  attempt recorded in a lane appears in a report run from the primary
  checkout.
- **Planned where:** the next engine or improve slice.

### S31. Drive-time routing re-reads role and model files unpinned (medium)

- **Shortcut:** the engine resolves a step's route from the working tree
  at dispatch time and does not bind it to the run's `configRevision`, so
  a role or model file edited (or a leftover `roster.yaml` added) after
  the run was created changes routing mid-run. Accepted as deferred by
  the P2 architecture passes (2026-09-26, finding repeated in pass 2).
- **Why:** pinning needs the resolved route (or revision) in the run
  envelope and a mismatch refusal on the drive path, which is an envelope
  schema change.
- **Proper fix:** pin the resolved route hash or `configRevision` in the
  run envelope at creation, refuse with a named code on drive-time
  mismatch, and test the drift case.
- **Planned where:** the P5 provenance slice or the next envelope change.

### S32. `kxm runs` lane options are uneven (low)

- **Shortcut:** `kxm runs list` has no `--lane`, and `kxm runs status
  --lane <unit>` answered `lane_missing` for a lane that `kxm lane status`
  resolves, after the lane's run had ended (omp-align-p2, 2026-09-26). The
  supervisor fell back to `kxm lane status` and the git tree.
- **Why:** `--lane` was added to `status`, `drive`, `receipt`, and
  `cancel` in the lane-cli slice; `list` was left out, and the status
  path resolves the lane through a different lookup than `lane status`.
- **Proper fix:** one lane resolver shared by every `runs` verb, `--lane`
  on `runs list`, and one test that every `runs` verb accepts `--lane`
  for a registered lane whose last run has ended.
- **Planned where:** the lane-cli follow-up with S20 and S28.

### S33. `kxm vision assert --route` is admission-checked but ignored (medium)

- **Shortcut:** the ported `kxm vision assert` command admission-checks
  and reports `--route`, but the gate's transport hard-codes
  `pi zai-coding-cn/glm-5.3-flash`, so requesting a non-default admitted
  route silently runs the default and the verdict is misattributed.
- **Found by:** the first truthful engine-driven critic verdict on
  0.7.159 (2026-09-28) — the outcome parser settled the BLOCK honestly.
- **Proper fix:** thread the resolved route through the vision gate's
  transport selection, refuse a non-admitted route at parse time, and
  test that a non-default route changes the dispatched model.
- **Planned where:** the vision slice after P3, or with the next
  browser-verify gate work.

## Closed

### S4. Thinking level hard-coded in the engine (medium)

- **Done:** nothing; observed that `kxm run` sends `--reasoning-effort low`
  on a first attempt regardless of the role's `effort`. The `just impl` path
  used `medium`, so the two transports disagree.
- **Proper fix:** dispatch reads effort from the role roster entry.
- **Planned where:** `plan-omp-config-alignment.md` P2 and P6.

- **Landed (2026-09-27):** the engine reads effort from the role roster entry and the hard-coded first-attempt `low` is gone (#368-era outcome and witness fixes). The effort-catalog half stays with P6 and S25.

### S24. Worktree lanes collide with the Runtime project registry (closed 2026-09-26, #339)

- Lanes register under their project with a `lane_of` row (registry schema 2), dead rows are replaced, a primary checkout is promoted over a lane recorded as home, and `kxm lane drop` unregisters. Remaining edges are S29.

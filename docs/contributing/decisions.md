---
title: "Decisions"
description: "Decisions of medium significance or higher made by automated KXM work in this repository. One entry per decision: the options evaluated with their weights, why the selected option won, and the evidence that backs it. Recorded the turn the decision is taken."
audience: "agents and maintainers"
updated: "2026-09-28"
---

# Decisions

Automated work records here every decision of medium significance or
higher: the options it evaluated, the weight each option scored against
the criteria that mattered, and why the selected option won. Weights are
the session's own 0-to-1 scores, not measurements. A decision that was
made directly by the operator is recorded only when executing it required
a choice.

Each entry has Context, Options (with weights), Selected, and Evidence.
Evidence names the file, command, or run that backs the decision. Those
are the same fields the archive keeps.

Retention: this file keeps the last 50 entries. When one more would exceed
the cap, the oldest entries rotate to
`docs/contributing/decisions-archive.jsonl` as `kxm.decision-archive.v1`
lines (date, title, area, options with weights, selected, why, evidence),
oldest first. The archive is append-only cold storage; the md stays the
working set. Chronological order (oldest first) is what makes that
rotation predictable.

## 2026-09-26 — P2 critic transport while the engine was schema-blocked (dispatch)

- Context: installed 0.7.130 refused the P2 lane's new agent schemas, so
  `kxm run`, drive, cancel, and receipt all answered 400. Both critics
  still had to review the unit, and loop-dispatch wanted engine attempts.
- Options:
  - Wait until #343 ships, then run critics through the engine — weight
    0.2. Highest purity, but it stalls the unit for a release cycle and
    the reviewers' context goes cold.
  - Run a second runtime supervisor from the branch code — weight 0.1. It
    would load the lane, but it mutates machine-global runtime state with
    unreleased code and risks the exact registry corruption S24 just
    fixed.
  - Dispatch both critics through the harness runner with briefs copied
    into the lane sandbox — weight 0.9. The documented relief for schema
    cutover lanes, proven twice the same morning by the writer repairs;
    costs only the improve-report attempt rows.
- Selected: harness runner. Fastest safe path; the engine-attempt proof
  was deliberately deferred to the next unit rather than falsified.
- Evidence: `docs/contributing/learnings.md` (omp-align-p2 lane, installed
  0.7.130, `schema_additionalProperties`) and `scripts/harness-run.mjs`,
  2026-09-26.

## 2026-09-26 — Supervisor cadence interpretation (operations)

- Context: the operator ordered the schedule task changed to 30 minutes.
  The improvement loop was anchored to wall-clock ("every sixth tick,
  about 30 minutes"), which a longer tick would silently stretch to three
  hours.
- Options:
  - Keep "every sixth tick" literally — weight 0.3. Preserves the prompt's
    letter, breaks the documented ~30-minute wall-clock cadence the
    parenthetical pins.
  - Improvement loop every tick — weight 0.8. Preserves both documented
    wall-clock behaviours; the tick count stops appearing anywhere.
- Selected: every tick. The operator's order named the tick cadence; the
  improvement loop's anchor was always the half hour. Stated in the report
  so it can be flipped back with one word.
- Evidence: `plans/kxm-roadmap/supervisor-prompt.md` step (5) (every tick,
  about 30 minutes) and `docs/contributing/operating-rules.md` (a
  supervisor tick runs every thirty minutes, improvement loop every tick).

## 2026-09-27 — Open PR queue: draft handling and landing order (landing)

- Context: six open PRs after #343. Two were drafts, one conflicted
  against the restructured CLI, three were clean and non-draft. The
  standing rule says every PR is landed without asking.
- Options:
  - Land everything including drafts — weight 0.2. A draft is the
    author's own hold signal; overriding it defeats the state and risks
    landing half-work.
  - Land only clean non-drafts now, defer the conflicted one to a port,
    leave drafts — weight 0.9. Honours both the autonomy rule and the
    draft semantics; the queue drains in one session.
  - Ask the operator per PR — weight 0.1. The standing rule explicitly
    removes this ask for open PRs.
- Selected: land non-drafts oldest-first (#341, #344, #346), leave
  #325 and #342 as drafts, dispatch #345 as a port.
- Evidence: GitHub pull requests #341, #344, #346, #325, #342, and #345
  as queued on 2026-09-27. Landing runs through `scripts/pr-land.mjs`.

## 2026-09-27 — PR #345: rebase, close, or port (dispatch)

- Context: #345 adds `kxm vision assert`, but its base predates the CLI
  restructure that deleted `plugins/kxm/src/cli/vnext.ts`; GitHub reports
  DIRTY/CONFLICTING. The gate module `vision-gate.ts` already exists on
  main; only the command surface is missing.
- Options:
  - Force the rebase and hand-resolve inside the land pipeline — weight
    0.3. The land rebase stage resolves only three union classes; a
    deleted-file port is none of them, so it fails mid-pipeline anyway.
  - Close #345 as superseded — weight 0.2. Discards reviewed intent
    (skill gate-step wording, fail-closed exit contract) that is still
    wanted.
  - Port the four pieces (handler, registration, test, skill wording)
    onto the current CLI structure through a writer lane — weight 0.9.
    Small surface, the PR stays open until the port lands, and the
    dispatch is the first engine-driven unit on 0.7.131, feeding
    loop-dispatch.
- Selected: port through the engine lane `vision-assert-port`; the PR is
  closed by its replacement landing, not by hand.
- Evidence: GitHub #345 (`feat(vision): kxm vision assert CLI +
  browser-verify skill gate step`) against a tree that no longer has
  `plugins/kxm/src/cli/vnext.ts`. `plugins/kxm/skills/kxm-browser-verify/SKILL.md`
  teaches `kxm vision assert`. Lane: `vision-assert-port`.

## 2026-09-27 — Authoring witness misses committed work (engine)

- Context: the engine failed two writer runs (P2 morning, vision port)
  with `authoringWitness: unchanged` while both lanes held the writer's
  commit. `captureWorktreeWitness` fingerprints porcelain, unstaged, and
  staged diffs but not HEAD, so a writer that fully commits reads as
  unchanged and a `passed` write step is flipped to `failed`.
- Options:
  - Add `git rev-parse HEAD` to the fingerprint — weight 0.9. One term in
    one string; catches commits, resets, and branch switches, which are
    all authoring-relevant moves of a lone-writer checkout.
  - A separate commit-witness field with its own failure class — weight
    0.6. Finer attribution (commit versus dirty edit) but a larger
    surface for a distinction nothing consumes today.
  - Trust the producer's `authored` metadata — weight 0.1. The module
    documents that metadata is set here, not trusted from the producer.
- Selected: HEAD in the fingerprint, one named test (committed-only
  change keeps `passed` with `authored: true`), shipped before any more
  engine-driven write steps.
- Evidence: `plugins/kxm/src/worktree-witness.ts` (`git rev-parse HEAD`
  in the fingerprint) and `test/core/worktree-witness.test.ts` ("a commit
  between snapshots counts as authored and a passed write stays passed").

## 2026-09-27 — Outcome parser rejects real model output (engine)

- Context: the one-shot producer appends a "return a final JSON object
  with an outcome field" contract to every prompt, and `determineOutcome`
  requires the model's entire output to parse as that bare JSON. Both real
  writers and critics answer with the brief's own review format instead
  (grok prose, fable markdown), so every substantive engine-driven step
  settles `failed` even when the transport and witness are clean.
- Options:
  - Extract the last balanced JSON object in the text and apply the same
    strict checks (object, string `outcome`, member of allowed outcomes;
    anything else stays `failed`) — weight 0.9. Tolerates the prose
    models actually produce; no path to success without a truthful
    outcome token.
  - Repeat the JSON contract as the first and last line of the prompt —
    weight 0.3. Prompt engineering against measured behaviour; the brief's
    own output section still wins.
  - Per-harness structured output modes — weight 0.5. The durable fix but
    a per-adapter surface change; too broad for the ship cycle this needs
    to ride.
- Selected: last-JSON-object extraction, same strict checks, same
  fail-closed default. Shipped with the witness fix in one release so the
  engine can drive real steps at all.
- Addendum (2026-09-27, after two more real failures): the shipped rule
  required the object alone on the final line; real critics write the
  object inline after their summary prose and fail anyway. The rule is
  now "the last top-level object of the reply, extending to the end of
  the trimmed text": forward scan, depth- and string-aware, so trailing
  prose, mid-text objects, and inner objects of a truncated outer object
  all still fail, while the real inline-at-end shape passes.
- Evidence: `plugins/kxm/src/oneshot-producer.ts` (`determineOutcome`) and
  `test/core/oneshot-producer.test.ts` ("prose and an outcome object on
  the same final line settle"; "an outcome object followed by prose stays
  failed").

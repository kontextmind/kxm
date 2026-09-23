# Continuous improvement

Every workflow run produces two distinct records:

- operational events for service health and delivery;
- a structured journal for plans, decisions, contradictions, errors, lessons, observations, hypotheses, experiments, state changes, and skill candidates.

The journal and retrospective loop covers hub webhook runs (signed webhooks and
`kxm workflow start`). Runs started with `kxm run` on the Runtime have no journal or
retrospective yet: `kxm_workflow_record` answers `workflow_not_found` for a Runtime
run id. Journal capture uses `kxm_workflow_record`. Terminal runs export a bounded
retrospective under `.kxm/assets/retrospectives`; re-export from durable local state
with `kxm workflow export`.

`kxm improve` is a separate loop. It reads routing records (the Runtime's settled
attempts and telemetry), not the journal, and proposes coded repeats; see
[Coded repeats](#coded-repeats-kxm-improve).

Journal entries carry an improvement area, severity, evidence links, relationships to other entries, and (when stage-bound) run/stage/attempt provenance. The design preserves disagreement instead of flattening it into a single final answer.

## Improvement areas

| Area | Questions to improve |
|---|---|
| Harness | Were agents available, correctly prompted, recovered, and given usable tools? |
| Gates | Did checks catch defects, produce actionable output, and avoid flaky noise? |
| Implementation | Were ownership, design choices, migrations, and tests effective? |
| Workflow | Were stages ordered well, attempts bounded, and handoffs efficient? |
| Documentation | Could users and operators follow the changed behavior? |
| Security | Were trust boundaries, credentials, permissions, and side effects controlled? |
| Other | What important issue does not fit the established taxonomy? |

## Required capture behavior

Use `kxm_workflow_record` during the run, not only in a final retrospective:

- record a `plan` before implementation;
- record a `decision` with alternatives and why one was chosen;
- record a `contradiction` when agents, tests, documentation, or observed behavior disagree;
- record an `error` when a stage, tool, gate, integration, or assumption fails;
- record a `lesson` only after evidence supports a reusable conclusion (evidence references are mandatory);
- record an `observation` for notable behavior without a causal claim;
- record a `hypothesis` as a falsifiable claim, and keep it when rejected — a disproven hypothesis is durable learning;
- record an `experiment` with its outcome, including failures;
- record a `state-change` when an authoritative project fact changes;
- record a `skill-candidate` only with verified run/receipt evidence; candidates never become promoted skills without a protected evaluation.

`kxm_workflow_record` (and `kxm workflow record`) accepts all ten categories above.
Pass `stageId` to bind an entry to the stage it is about. The hub, never the caller,
derives the attempt from the stage's state: the current attempt for an in-progress or
waiting stage, the last attempt consumed for a finished stage, and none for a pending
stage that has not run. When `stageId` names a stage that declares an area, `area` may
be omitted and defaults to that area; otherwise `area` is required, and a request with
neither is refused with `invalid_improvement_area`. A `stageId` that is not part of the
run is refused with `invalid_journal_relation`. `lesson` and `skill-candidate` entries
still require evidence references.

## Governed promotion

`skill-candidate`, `hypothesis`, and `experiment` entries participate in a governed lifecycle: `proposed` → `approved` | `rejected` | `quarantined`. Promotion is an append-only, admin-controlled decision (`POST /v1/journal/:id/promotion`) that requires durable evidence references; the author of an entry can never decide its promotion, and terminal states never re-open. Promotion changes the learning lifecycle of an entry — never gates, workflow policy, or permissions.

The native Pi extension automatically records failed tool results while a webhook workflow is active. The hub also records checkpoint warnings and failures, transition-budget exhaustion, signed signal results, external-wait timeouts, prompt expiry, degraded-quorum approvals, and premature coordinator settlement, each bound to its stage and attempt. Agents must still record semantic errors such as a false assumption, rejected design, flaky result, or external integration mismatch.

Never put secrets or unnecessary prompt contents in the journal. Evidence should be durable references such as test names, logs, commits, pull requests, Jira issues, check runs, or documentation paths. Failed tools record an allowlisted diagnostic class, not stdout.

Every terminal workflow automatically exports a bounded retrospective under `.kxm/assets/retrospectives`, and exports it again when a journal entry is recorded or a promotion decided after the run ended. Re-export one from durable local state with `kxm workflow export <runId>`; `--input <snapshot.json>` remains available for offline imports. `recurringErrorClasses` counts `error` entries only. `proposedImprovements` holds up to 12 of the run's error and lesson entries, merged and ranked the same way as the weekly signals below, each with a success measure that names the signal key. Files stay `reviewDecision=proposed` until a human or coordinator records an explicit decision. Export never edits workflow JSON or weakens gates.

Runs with peer policies add an optional metadata-only evidence audit while
retaining the `pi-mesh.retrospective.v1` schema. It records each requirement's
configured and effective producer minimum, eligible-producer snapshot, verified
message and producer IDs, immutable workflow context, lifecycle timestamps,
request/reply hashes, degraded state, and explicit admin approvals for the
applied attempt. Earlier-attempt replies never inflate the final quorum. It
never copies peer request or reply bodies. The snapshot remains useful after normal
message retention purges the source record, but its hashes are provenance
metadata—not proof that the peer's conclusion was true.

## Review cadence

### Per run

The retrospective stage reviews journal entries, groups contributing causes, and proposes bounded improvements. It must identify an owner or next action and a measurable success condition.

### Weekly

Call `kxm_improvement_report`. Besides the per-area counts it returns `signals`: the
project's errors, contradictions, lessons and skill candidates, already merged across
runs and ranked. Review the top signals, check that each merge groups entries that
belong together, and pick what to trial.

- Entries merge when they share a key: first an evidence class (`class:<name>` in the
  entry's evidence), then, for errors, the workflow definition and stage, then the
  summary after redaction and normalization (ids, timestamps, hex strings and numbers
  are folded). Text is redacted before it becomes a key, so a key never carries a raw
  summary. Each signal keeps up to 16 source run IDs and entry IDs.
- Only errors, open contradictions (not yet resolved by a related decision or lesson),
  lessons, and skill candidates still `proposed` count.
- `frequency` is the number of distinct runs, counted over the runs the hub still
  retains: terminal runs and their journal are purged 7 days after they end.

```text
priority = frequency × severity weight × workflow cost × confidence
```

- The severity weight is 3 for `error`, 2 for `warning` and 1 for `info`, taken from the
  most severe entry in the signal.
- Workflow cost is the mean number of run attempts (stage attempts plus transitions)
  over the signal's known runs. It is not dollars. When none of the runs is known it
  counts as 1 and the signal reports `costBasis: "unknown"`.
- Confidence is 0.5 plus half the share of the signal's entries that cite evidence.

Security signals (area `security`, or evidence class `invalid_auth`,
`invalid_identity` or `signal_mismatch`) rank ahead of every priority. Remaining ties
break on frequency, then key, never on entry ID or insertion order. There is no
data-loss override yet, because no deterministic data-loss marker exists, so review
data-loss risk by hand rather than trusting the order.

### Per release

Select a small improvement batch. For each proposal:

1. State the observed problem and linked evidence.
2. Identify whether the change affects the harness, gates, implementation guidance, workflow definition, documentation, or security policy.
3. Define the expected outcome and a measurable leading indicator.
4. Add or update tests before changing enforcement.
5. Trial the change on a bounded workflow or repository.
6. Compare failure rate, cycle time, manual intervention, and escaped defects with the baseline.
7. Adopt, revise, or roll back the proposal.
8. Record the decision and result in a subsequent workflow journal.

## Coded repeats (`kxm improve`)

`kxm improve` (the same as `kxm improve report`) looks for agent steps that a script,
test or workflow `gate` could do as well as a model. It proposes; it never applies.

**Sources.** Inside a KXM project it reads the project's Runtime event store,
`<state>/runtime/projects/<key>/run-events.db`, and then `.kxm/logs/telemetry.jsonl`.
The key comes from the checkout's real path, so each checkout and worktree has its own
store and the report covers only the one it runs in. The store is opened read-only for
one query over its events table; `kxm improve` never creates, writes or migrates it. A
telemetry record whose `attemptId` the store already supplied is dropped. `--file
<path>` reads only that file. Outside a project only telemetry is read. The output lists
every source with its path, whether it exists, and its counts (`records`,
`skippedInvalid`, `excludedSimulated`, `undecided`, `duplicatesDropped`). An unreadable
store stops the command with `improve_source_unreadable` and the path (exit 1).

**Identity.** Records group by workflow, step, agent role and ask. Runtime records carry
the engine-reserved `workflowId` and `askSha256` keys. The ask digest covers the
workflow, step, step kind, agent, instructions, outcomes and required evidence keys, so
it is the same for one step across runs and ignores the run, attempt, model and context
packet. Records without those keys fall back to a workflow definition digest or the run
ID, and to `rolePromptSha256`. No prompt text is read or stored: `objectiveSha256` is
the digest of the run's prompt.

**Outcomes.** A Runtime record stores `finalOutcome` only when settlement already knows
it: `blocked` for a back edge, and `failed` for a producer error, an undeclared outcome
or a failing terminal. Everything else is resolved when the report reads the event log,
and never written back: a later entry into the same step makes the attempt `reworked`, a
completed run makes it `accepted`, a failed run makes it `failed`, and a cancelled or
still-running run leaves it undecided. Undecided records are counted and left out of the
pass rate. Attempts from simulated drives are excluded and counted.

**Candidacy.** A group becomes a coded-repeat candidate only when all three hold:

- the same objective (`objectiveSha256`) was decided in at least 2 runs
  (`askRecurrence`); records without an objective digest share one bucket;
- at least 0.75 of its decided records were accepted (`verifyPassRate`), where an
  attempt superseded by a later retry of the same step in the same run never counts as a
  pass;
- its step writes no repository (`writesRepository`, from the engine's `stepWrites` key).

A group that passes but misses reports `excludedReason`: `writes-repository`, or
`ask-not-repeated` when its runs asked different objectives. `weightedRecurrence`
weights each record by `2^(-age / improvement.telemetryHalfLifeDays)` (14 days by
default; an undated record weighs 1 and is counted in `undatedRecords`). It orders the
rows and never decides candidacy.

**Outputs.** Each candidate is a `kxm.candidate.v1` JSON file and a proposed diff under
`.kxm/candidates/` (or `--out-dir`); the report is written as
`kxm.improvement-report.v2` under `<workspace>/assets/improvements/`. `--dry-run` writes
neither. The candidate kind comes from a Git-reviewed name rule and only picks the
proposal template: a step or role that verifies, gates, tests, checks or lints proposes a
`.kxm/gates.yaml` command entry; a planning, review or repro step proposes a governed
skill, labelled consolidation because it is not a coded step; any other step proposes
replacing the agent step with a `kind: gate` step plus a `gates.yaml` command entry that
runs `scripts/<step>.mjs`, which the operator writes. Diffs are proposals with
placeholder hunks.

**Promotion readiness.** `promotion[]` reports, per candidate, `readyForReview` and a
reason under `improvement.promotionPolicy`:

- `manual_pr` (default): always ready; the operator reviews and applies the diff in a PR.
- `critic_quorum`: ready once two distinct critic receipts are cited. `kxm improve`
  cites none, so every candidate reports not ready under this policy.
- `auto_threshold`: ready once the group's distinct runs reach
  `improvement.autoThreshold.minRuns`, its accepted share reaches `minPassRate`, and its
  mean recorded cost is at least `minCostSavings` over at least one cost sample. A group
  with no recorded cost is never ready.

No policy authorizes anything. Every policy ends at an operator PR, activation is a
reviewed Git change for a future run, and telemetry cannot grant tools or skip a gate.

## Governance safeguards

- Journal content is evidence, not executable policy.
- Improvement candidates are proposals. Promotion readiness never authorizes, and no `improvement.*` value activates a candidate.
- An agent may propose a gate change but cannot silently weaken a required gate.
- A peer-quorum reduction must be declared by policy and explicitly approved by an administrator for the current attempt; record it as a degraded outcome rather than normal success.
- Contradictions stay open until evidence resolves them; synthesis must not erase minority risks.
- Changes involving permissions, secrets, merge policy, or external side effects require human or repository-authorized approval.
- Improvement reports are project-scoped. Protect the SQLite database because journal details may reveal sensitive engineering context.
- Periodically export accepted decisions and durable lessons into version-controlled documentation; the SQLite journal is an audit source, not the only system of record.

## Initial backlog for this workflow

Start by measuring and improving these areas:

1. Harness availability: coordinator uptime, reconnect count, prompt expiry, and premature settlement.
2. Planning quality: number of unresolved contradictions and reviewer-found plan defects.
3. Gate quality: flaky checks, false negatives, rerun count, and time to actionable failure output.
4. Implementation quality: escaped defects, rollback rate, review churn, and ownership conflicts.
5. Delivery flow: time in each stage, webhook-to-start latency, and manual intervention count.
6. Documentation quality: setup failures and changes shipped without updated examples or operations guidance.
7. Security posture: rejected signatures, secret rotation age, unauthorized action attempts, and dependency findings.

The goal is not maximum automation. It is a workflow that becomes more reliable, explainable, and efficient while preserving review and authorization boundaries.

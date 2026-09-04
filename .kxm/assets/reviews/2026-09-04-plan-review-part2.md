# KXM plan review, part 2, 2026-09-04

Reviewer: Claude Fable, with nine independent critic and research passes
(improvement cycle, memory and wiki, multi-repository setup, telemetry and
cost, CI pipelines, HUD and status bars, standard workflows and the agent
tool surface, datastores and queues, web studio research). Continues
[part 1](2026-09-04-plan-review.md). Same rules: proposals only, Grok applies,
human signoff, not peer-reply evidence.

## 0. Actions taken during this review

Two repository settings were changed at the owner's explicit request:

- `allow_auto_merge` enabled on `kontextmind/kxm`.
- Ruleset `protect-main` (id 22251971) created on the default branch: no
  deletion, no force push, pull request required with zero approvals, the four
  `Validate (os, Node)` checks required and up to date.

Consequence: direct pushes to `main` are now rejected, and nothing merges until
the coverage failure below is fixed. `delete_branch_on_merge` was left off.

## 1. Verdict

**`main` is red.** The last eleven CI runs failed on every leg with line
coverage at 93.79 percent against the 95 percent threshold and zero failing
tests. The explicit coverage include list was diluted by CLI growth. Nothing
blocked the pushes because the branch had no protection. This is finding zero
for Slice B and should land before anything else.

Across the nine areas one pattern repeats: **the contract documents describe
the target in the present tense, and the plan's Decided section restates them
as requirements, while the code has the schema and none of the producer.**
Routing records have no writer. The sync outbox has no code. Memory revisions
are a column nothing sets. Gate steps have no runner. The insights loop, the
cost loop, the improvement loop, and the memory loop each have a report or a
reader and no input. The single most valuable change in this review is the
same in every area: **make the Phase 3a engine the producer** of routing
records, gate results, run events with schema tags, and memory revisions, and
mark every contract doc without code as "not implemented, Phase N".

## 2. Agent tool surface: CLI with skills first

The owner's ranking is CLI with skills, then hub API with skills, then MCP. I
agree, with three conditions and one gap.

**Why agree.** Every harness can run a shell command. Only Claude Code and
Gemini have a plugin mechanism; Codex, Kimi, and Copilot have none. Skills are
the forty-product standard. The token-delivery problem from part 1 dissolves
because the CLI reads `KXM_*` from the environment. The CLI is already testable
without a harness. Skills are Git-reviewed text, which fits "gates, not
memory".

**Conditions.**

1. `--json` on every agent-facing command, with a `schema` tag and errors on
   stderr. Without that the CLI is worse than MCP for a model.
2. Per-operation permission is coarser under Bash (`kxm *`). Compensate inside
   KXM: the assignment's tool policy is enforced by the CLI reading an attempt
   token from the environment, so `kxm cancel` from an agent whose policy lacks
   cancel fails closed on every harness. That is stronger than harness
   allowlists, and prefix rules like `Bash(kxm send:*)` are string matching,
   not a contract.
3. Long waits are workflow `wait` steps, not agent tool calls. `kxm await`
   with a timeout is fine for short polls.

**The gap.** The CLI has none of the agent operations. `send`, `get`, `await`,
`cancel`, `fanout`, `inbox`, `reply`, and the workflow `checkpoint`, `record`,
and `wait` calls exist only in the MCP server (19 tools) and the Pi extension
(17 tools, already drifted). `cli.ts` never imports the hub client. "CLI
first" is a plan, not a state.

| # | Finding | Severity | Fix |
|---|---|---|---|
| F1 | No CLI messaging surface. | high | Add the six peer commands and three workflow commands as thin client callers. |
| F2 | Duplication is MCP versus Pi: identical option building in both. | medium | One command table (name, parameter schema, handler). |
| F3 | Two schema systems: JSON Schema in MCP, TypeBox in Pi. | medium | Generate both from the table. |
| F4 | MCP registers 19 tools, Pi 17, missing `kxm_inbox` and `kxm_reply`. | medium | A test that fails when the lists disagree. |
| F5 | vNext `wait` steps have no signal path; `gate signal` and `github watch` post to the legacy engine. | high | Bind a signal command to vNext runs before any CI-wait tier ships. |
| F6 | MCP server is 606 lines, roughly 85 percent schema and dispatch; logic is in the client. | low | Keep it as the generated wrapper: transport plus the inbox bridge only. |

Recommended shape: `kxm <verb> --json` is the one API. The command table
generates the MCP tool list and the Pi tool registrations. The Pi extension
becomes chrome that calls the same handlers. The skill teaches the CLI. The hub
HTTP API is for programs and other machines; agents never call it directly.

Honest losses: per-tool allow and deny in the harness, push streaming, and
sandboxes without the binary. Gains: Codex, Gemini, and Kimi work with no
plugin mechanism, handlers are testable, no daemon, token from the environment.

## 3. Standard workflows: simple, mid, full

Using only the schema's step kinds. Every gate id is marked with runner status.

**simple** (Phase 3a, Pi only, no join, no wait, no approval). This is the
current `default.yaml` plus a cost cap it lacks.

| Step | Kind | Evidence | Transitions |
|---|---|---|---|
| plan | agent planner | plan: artifact | passed to implement; blocked fails |
| implement | agent implementer | diff: artifact | passed to verify; failed fails |
| verify | gate `test` (runner exists) | gates: gate | passed to ready; implementation-failure back to implement, max 3 |
| ready | agent planner | summary: assignment-result | passed completes |

Limits: 8 transitions, 4 h run, 6 h agent, 5 USD `maxModelCost`.

**mid** (Phase 4 and 5). Adds one independent critic as an `agent` step, not
`moa`, so it needs no quorum and no Phase 7, and a CI wait.

| Step | Kind | Evidence | Transitions |
|---|---|---|---|
| plan | agent planner | plan: artifact | passed to review |
| review | agent reviewer, different harness from the writer | critique: assignment-result | passed to implement; plan_invalidated back to plan, max 2 |
| implement | agent implementer | diff: artifact | passed to verify |
| verify | gate `test` | gates: gate | passed to delivery; implementation-failure back to implement, max 3 |
| delivery | gate `scm-delivery` (runner exists) | delivery-manifest: artifact, mr: receipt | passed to ci-watch; failed fails |
| ci-watch | wait `ci-review` (**needs runner**, F5) | ci: receipt | passed to ready; failure back to implement, max 3 |
| ready | agent planner | summary: assignment-result | passed completes |

Limits: 16 transitions, 12 h run, 24 h agent, 15 USD. No `lint` gate because
`npm run verify` already folds typecheck and lint into the test gate.

**full** (Phase 7) is the current `fix.yaml` with three cuts: delete `intake`
(a planner read-only step immediately followed by another, fold the
classification evidence into `repro-explore`, 13 steps become 12); drop both
MOA `target` values from 3 to 2 while keeping `maximum: 3` and
`minimumPassed: 2`, because AGENTS.md says one critic is enough unless the
change is auth, workflow policy, or multi-package; keep the repro oracle, plan
hash, `requirePlanHash`, human approval, and bounded back-edges.

**Templates.** `kxm init` ships simple plus the agents coordinator, planner,
implementer. Mid and full are `--template mid|fix`. One divergence to fix
first: the init template's `default.yaml` is three steps, uses the coordinator
as planner, ships no planner agent, and binds one repository, while the
fixture the Phase 3 and 4 gates name is four steps with a planner and three
repositories. The template is the one that is wrong.

**Legacy JSON workflows** (jira-development, provenance-quorum, v04-dogfood):
keep as migration fixtures only. Migrate none, delete none. The
`kxm-moa-review` asset is findings markdown, not a workflow.

## 4. Improvement cycle: gates, skills, workflow steps

| # | Finding | Severity | Fix |
|---|---|---|---|
| M1 | Nothing writes a routing record. The only writer of telemetry never sets `routing`. `kxm routing report` always takes the empty branch. | critical | The engine emits one record per assignment attempt. |
| M2 | `kxm improve` reads only gate command envelopes. Proposals are counts of `gate validate ok`; five of seven areas unreachable. | critical | Read routing records and the retrospective. |
| M3 | `kind: gate` steps have no runner. Built-in gates are `test` and `scm-delivery` as names only; nothing execs anything; `artifacts-exist` cannot be referenced. | high | Engine gate registry mapping id to argv and timeout; exit code is pass or fail. |
| M4 | No way to register a project-local gate. `registeredGates` is internal; `gates.json` is legacy; migration marks non-builtin gates report-only. | high | Non-legacy gates registry loaded by validation and the runner. The promotion target for "code the repeats" must exist. |
| M5 | Skill "protected evaluations" are operator-typed booleans; promoter identity is a free string. | high | Evaluation bound to a command exit code; promotion identity bound to the Git commit author on the PR. |
| M6 | Promoted skills are read by nothing. The arbiter serves `skill-candidate` journal rows instead. Two disconnected skill systems. | high | Filesystem store is truth; arbiter loads promoted skills by pinned hash. |
| M7 | Skill candidates lack the `name` and `description` frontmatter the standard requires. | medium | Emit and validate frontmatter. |
| M8 | Retrospectives are gitignored, so exports cannot reach a PR; improve reports are timestamp-named and unindexed. | medium | Candidates in a tracked directory. |
| M9 | "Learned behavior cannot grant tools" is comments only in the skill code. | medium | The reserved control-plane field list in `context.ts` is the one place it is code; apply it to skills. |
| M10 | No repeat detection anywhere. | medium | See design below. |
| M11 | No improve test; the CLI test asserts exit zero only. | medium | Tests per rule. |

**MVP improvement design (after Phase 3a).**

1. One routing record per completed assignment attempt. Nothing else works
   without this producer.
2. A gate registry (id, argv, timeout) read by validation and executed by the
   engine. Exit code is the result. Only gates block.
3. `kxm improve report` groups routing records by workflow hash, step, agent
   role, and prompt hash. Each row: recurrence, mean cost, mean latency,
   verify-pass rate, rework count. High recurrence with high pass rate is a
   coded-repeat candidate.
4. One candidate format in a tracked directory: kind (gate, skill, or
   workflow step), evidence refs, baseline metrics, declared outcome with its
   measure, path to the proposed diff.
5. One activation path: a PR editing the gate registry, a workflow YAML, or
   the promoted skills directory. `skills promote` emits a patch, never a
   working-tree move. Nothing activates without a merged commit.
6. One measurement: after merge, re-run the report filtered to the new
   workflow hash and compare to the baseline. Adopt, revise, or roll back.
7. Classification rule: deterministic pass or fail with no judgment becomes a
   gate; stable prose that only informs a model becomes a skill; ordering or
   handoff becomes a workflow step.

Keep: the behavioral hash as the join key; the metadata-only evidence audit;
the skill state machine with content-hash pinning and author-cannot-promote;
fail-closed unknown-gate validation.

## 5. Memory and wiki

| # | Finding | Severity | Fix |
|---|---|---|---|
| K1 | State promotion is unauthorized on the MVP hub: loopback with no token makes the admin check a no-op, and the promoter is hardcoded `mesh-admin`, so author-cannot-promote never fires. | critical | Route through the configured-admin check; record the real caller. |
| K2 | No write path for memory except state. Knowledge, episodes, evidence, and skills are minted per request from journal rows that exist only inside a run. Nothing is remembered outside a run. | high | One governed write surface. |
| K3 | Unreviewed skill candidates are served as skills; the governed store is never read by the hub. | high | Exclude proposed items; read promoted. |
| K4 | Memory revision exists as a column and a field that nothing sets. No run pins a revision. | high | Set at run creation from the hash of the authored set. |
| K5 | The only scope is a project string. No agent or run scope; run and stage ids are echoed to the audit but never filter. | medium | Explicit scope field on the record. |
| K6 | Five stores, five formats, no schema tag; the parser drops unknown fields silently. | medium | Stamp the schema; reject unknown fields. |
| K7 | No TTL, retention, or redaction on write; a secret in a journal summary replays into every packet. | medium | Redact at parse; retention bound. |
| K8 | `lineageOf` is documented transitive but is depth-one and dead; the arbiter does the correct walk. | medium | Delete or fix. |
| K9 | The workflow origin grants policy authority; agents author journal rows through the record tool. | medium | Split control-plane origin from agent-written journal. |
| K10 | Wiki commands remain live despite the punt, and one path fabricates an audit with zeroed counts. | low | Gate behind the punt. |
| K11 | The provider seam has no production caller. | low | Keep or drop deliberately. |
| K12 | Two unrelated things are called a session. | low | Rename one. |

**MVP memory model.** Three scopes on the record: agent, project, run. One
schema-tagged record: id, scope, kind, summary, provenance, authority,
confidence, lifecycle, evidence refs. Journal rows are a projection into it,
never a second type. Git holds what is authored and reviewed (promoted skills,
project knowledge, policy) and is the activation boundary. SQLite holds what a
rebuild reproduces; deleting it loses nothing authoritative. A run computes its
memory revision as the hash of the Git-authored set plus the promoted-state
snapshot, writes it at creation, and reads only that revision for its life. A
run writes back exactly one thing: candidates, always at evidence authority,
review required, linked to run events. Three rules move from prose to code:
promotion needs a configured admin token, a proposed item never reaches a
packet, and no record carries a control-plane field. Agent scope is the
smallest new thing worth building.

**Wiki.** A compile target of that model, derived, never an input. Stays
behind the existing punt. It is memory's output surface, not a peer store.

Keep: ordered authority classes, per-origin grant floors, the derived-content
ceiling, bounded lineage enforced at parse time with tests; the reserved
control-plane field list; arbiter determinism; packet project isolation that
fails closed; the wiki surfacing contradictions rather than resolving them.

## 6. Multi-repository setup

| # | Finding | Severity | Fix |
|---|---|---|---|
| R1 | The only portable member layout is Git submodules (path hints must resolve inside the control root; trust diff needs a tracked gitlink), yet the project schema pins `dirtySubmodules` to `fail`. The Phase 5 gate, a dirty two-repository workflow, cannot run on the only reviewable layout. | critical | Decide: support tracked non-submodule members in trust diff with the member's reviewed branch as base, or make submodules explicit and replace `fail` with a bounded dirty-submodule snapshot. |
| R2 | `configRevision` hashes `repo.yaml` read from member worktrees, and an absent optional member is skipped silently. Two machines at the same control commit get different revisions. Breaks the Phase 1 gate and `migrate verify`. | high | Split into a control revision plus per-repository content hashes pinned on the run; absent members are a recorded state. |
| R3 | `remoteIdentity` and `defaultBranch` are never read. A second machine gets `repository_binding_unavailable` and no clone command. | high | Print the remote and the exact clone and bind commands; `kxm repo clone` behind a flag. |
| R4 | Adding a second repository is seven manual steps across two Git histories with no `kxm repo` command, and the error names a path that exists nowhere on disk. | high | The UX below; print physical paths. |
| R5 | Out-of-tree members are trust-diffed against their own HEAD, so an expansion already committed there is invisible. | high | Refuse out-of-tree members for trust diff unless the project pins a reviewed member commit; add that pin per member. |
| R6 | No cross-project member index; two projects can claim the same repository; the one-writer lease has no subject. | medium | Repository-binding table in the Runtime registry keyed by canonical member path, which becomes the lease subject. |
| R7 | Discovery never finds the control root from inside a member; `kxm init` there creates a competing project. | medium | Consult the binding index; fail closed naming the owner. |
| R8 | No path-scoped sub-repository, so a monorepo cannot be split. | medium | Optional sub-path on the project entry; worktree root stays the identity anchor. |
| R9 | Phase 5 is wholly unimplemented and capability validation checks declared ids, not resolved bindings. | expected | Binding resolution as a pre-run capability check. |

**Correction to part 1's sub-workflow note.** The delegation model stands, with
four fixes: identity stays the filename, the repository is named on the parent
step, and qualification happens only in run events; member workflow files must
not enter the configuration revision, so pin child definitions per run by
member commit; trust diff over member workflows depends on the reviewed
member-commit pin from R5, so ship the feature only after that lands; template
provenance and repair are control-root-only, so a repo-owned workflow is
permanently provenance-free and the design says so.

**Proposed UX for the Phase 5 gate.** The minimum a member repository contains
is one file, `.kxm/repo/repo.yaml`, with schema, project id, repository id.
`kxm repo add <path|url> [--id] [--nested|--sibling]` clones when given a URL,
writes the member file, adds the project entry, adds the gitlink or records the
binding, and prints both pull requests. It is the sole writer of the project's
repositories array and of member files, so the opaque project id is never
retyped. `kxm repo list [--json]` shows id, role, resolved path, bound or
portable, reviewed commit, drift, and doubles as the second-machine checklist.
`kxm repo bind|unbind` touch Runtime-local state only. `--repository` stays as
the scriptable alias for bind.

Keep: Git logical ids versus Runtime-local paths; the hashed control-root
record outside the repo; member-id validation before any write; the SQLite
immediate-transaction lock released by process death; control root equals Git
root. Fix discovery with an index, not by relaxing that boundary.

## 7. Telemetry, cost tracking, metrics

| # | Finding | Severity | Fix |
|---|---|---|---|
| T1 | No writer of routing records anywhere. Every record in the repo is built in a test. | blocker | Engine emits per attempt; failing test: N attempts leave N records. |
| T2 | Missing cost sums as zero. A subscription run and a failed capture both aggregate to 0.00 and win the comparison. This is the silent underquote the plan forbids. | high | `costBasis: metered, unmetered, unknown` required; `costUsd` required when metered; report the three populations separately, never one total. |
| T3 | The record lacks harness, provider, latency, context tokens actually sent, cache write tokens, its own timestamp, and project. Run, stage, attempt, and outcomes are optional. | high | Schema below. |
| T4 | `routing report` prints 64-character hashes with no model, harness, or thinking label, sorted by run count. | high | Label tuple per group; sort quality then cost. |
| T5 | `verifierOutcome` is recorded then dropped; rework rate conflates retries with legitimate transitions. | medium | Fix the aggregation. |
| T6 | Telemetry captures CLI envelopes only; the worker emits only in dry run; quota failover in the worker rotates models and writes no record. | high | Same producer fix. |
| T7 | Prometheus mixes twelve `pi_mesh_*` and four `pi_kxm_*` names; one counter is incremented at nine sites and never exported; no latency or cost metric. | medium | Rename to `kxm_*`; add attempt latency and metered cost. |
| T8 | The report slurps the whole JSONL each time; no rotation. `limits.maxModelCost` is enforced nowhere. | medium | Move records into the event store; enforce the cap in the engine. |

**Record `kxm.routing-record.v2`.** Required unless noted: schema, recordedAt;
projectId, runId, stageId, assignmentId, attempt; harness (enum), provider;
requestedModel, effectiveModel (differ on failover); thinking (`none` when
unset, never omitted); agentRole; behavioralSha256; contextTokens actually
sent; tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens (integer or null
meaning not reported); latencyMs; costBasis; costUsd only when metered;
priceRef optional; verifierOutcome (passed, warning, failed, not_run); outcome
(accepted, rework, blocked, failed, quota_exhausted, auth_lost); retries;
humanInterventions; providerMetadata bounded with the existing key redaction.
Stored as event `routing.attempt.recorded` in the per-project event store in
the same transaction that settles the attempt. The engine refuses to settle an
attempt with no `costBasis`.

**Report.** `kxm routing report [--since 7d] [--project] [--stage] [--json]`.
Group by harness, model, thinking, role, hash as tiebreak. Per group: attempts,
verify-pass rate, rework rate, p50 and p95 latency, median context tokens,
metered cost, cost per accepted attempt, and separate counts of unmetered,
unknown-cost, and quota-exhausted attempts. Sort quality first, then cost per
accepted attempt. A group with unknown cost is flagged, never ranked cheapest.

Keep: the behavioral hash design; the provider-metadata key redaction; the
parse-don't-trust boundary; the diagnostic taxonomy, which already has the
quota and provider-error classes failover records need.

## 8. CI pipelines

| # | Finding | Severity | Fix |
|---|---|---|---|
| X1 | `main` is red on all four legs (coverage 93.79 percent, zero failing tests). | critical | Land the missing tests, or lower the threshold in the same commit and say so. Then Slice B's include inversion. |
| X2 | No protection, no required checks, no auto-merge, no delete-on-merge. The AGENTS.md PR loop was impossible. | high | Done during this review except delete-on-merge. |
| X3 | A local `gate signal` can forge a CI pass with only the signal secret; context binding skips omitted keys; CI evidence carries no SHA, check-run id, or attempt. Evidence policies accept only `peer-reply`. | high | Contract below. |
| X4 | No release pipeline. The v0.5.1 release has no assets; npm has no package; the version check never compares to the tag. | high | Release job. |
| X5 | `validate:claude` runs nowhere in CI; the PR template asks for it by hand. | medium | A `plugin` job. |
| X6 | No concurrency group; eight overlapping `main` runs in one half hour. | medium | Cancel in progress on pull requests. |
| X7 | `check:generated` is masked by an earlier failure in the same job and rebuilds. | low | Own job. |
| X8 | No docs link check. | low | Non-blocking checker. |
| X9 | `fix.yaml` declares `ci-watch` as a wait on a receipt, but the gate set is two names, the Runtime has no wait or signal handling, and `project.yaml` has no forge or tracker field to offer a choice in. | medium | Contract below. |
| X10 | Dependabot dist churn is not real: four dist commits, all feature work. | none | Keep cadence. |

**Minimal CI before public npm.** Fix coverage. Ruleset requiring the four
Validate contexts plus a standalone `generated` job (done except the job).
Concurrency keyed on workflow and ref, cancel in progress on PRs only. Split
`check:generated` into its own job. A `plugin` job running `validate:claude`;
drop the checkbox. `release.yml` on `v*` tags: assert tag equals the package
version, run `validate`, pack, rename, upload `kxm-<v>.tgz` with
`contents: write`; npm publish in the same job behind a disabled environment
gate. Link checker non-blocking at first.

**CI as a gate contract (Phase 4 and 5).** Receipt kind `ci-check` with forge,
repo, sha, checkName, checkRunId, conclusion, attempt, completedAt, url,
observedBy, observedAt. `sha` is mandatory and must equal the head the
`scm-delivery` gate recorded, else 409. Writer classes webhook, poller, human,
always recorded. `evidencePolicies` accepts `kind: ci-check` with
`minWriterClass`, so a workflow can refuse human-asserted CI. A `wait` step
binds by signal plus sha plus check set. `gate signal` keeps working but
stamps `observedBy: human`. `project.yaml` gains `scm` and `tracker` fields
accepting github, gitlab, or none; an unimplemented forge throws at config
load naming the choice. `ci-watch` registers as a real gate so validation
stops accepting an unrunnable step.

Keep: the matrix with `fail-fast: false` and npm caching; least-privilege
permissions; delivery-id idempotency, 409 on conflict, timing-safe HMAC, the
separate signal secret; pending and timeout treated as failure.

## 9. HUD and in-harness status bars

| # | Finding | Severity | Fix |
|---|---|---|---|
| D1 | Two oracles for "hub up": Pi uses the in-process client handle, the CLI probes `/health`. The bar can say on while the CLI says off. | high | One resolver reporting on, off, or unknown with the evidence kind. |
| D2 | `kxm session brief` blocks on the network with no timeout. It is the only Claude, Codex, and Gemini path the skill documents. | high | 300 ms abort, then `hub:unknown`. |
| D3 | The ship hint's "N local" arm is dead on a fresh branch: no upstream, so ahead falls to zero and the bar says ship clean. | high | Count against the default-branch merge base when no upstream exists. |
| D4 | Dash and brief read the legacy database; vNext runs live elsewhere. Active tasks read zero during a vNext run. | high | Phase 4 union reader; until then a `source: legacy` marker so zero reads as not wired. |
| D5 | No in-harness status for Claude Code at all; the manifest declares only MCP and user config. | medium | `statusLine` entry pointing at `kxm session brief --status` plus a session-start hook. Same one-liner is the portable surface for Codex, Kimi, Gemini. |
| D6 | No cost, model, harness, or quota on any HUD surface. | medium | `$0.42 sess · $0.08 run · claude/fable`, with `unknown` when unmetered. |
| D7 | No freshness field, no cache; every call opens SQLite and spawns two git processes; Pi chrome repaints only on startup, new, and fork. | medium | Cache file with a 5 s TTL; `generatedAt` and staleness on the brief; repaint on turn end. |
| D8 | Three formats for the same facts across the brief line, `hub view`, and `/kxm hub`. | medium | One renderer, three callers. |
| D9 | A second status segment `mesh:offline` on failure, and the `kxm` key is never cleared. | medium | Retire the second key. |

**HUD contract.** `kxm.session-brief.v1` with schema, generatedAt,
staleSeconds, hub state and evidence kind, work counts, ship, cost, update
notice, and `source` (legacy, vnext, both). One `renderStatusLine` capped at
80 columns. Three callers only: the Pi status slot, `/kxm status`, and
`kxm session brief --status`. Bar carries hub, counts, ship, spend, age. The
widget adds the current item, latest plan, ship sentence, update notice.
`kxm dash` owns everything else including a spend tab. Never block.

Keep: the brief's split into stats, items, status line, widget; the 80-column
cap; the `--status` flag; the dash key model and split pane at 76 columns; SSE
with snapshot fallback; metadata only, no message bodies.

## 10. Datastores, logging, queues

| # | Finding | Severity | Fix |
|---|---|---|---|
| S1 | The sync outbox has zero code. `synchronization.md` reads as shipped. | critical | Mark not implemented; Phase 8. |
| S2 | The hub loads the entire database into memory at boot and scans all messages every cleanup tick; no LIMIT anywhere. | high | Query SQLite for hot paths; keep agents and open messages resident. |
| S3 | Journal, workflow runs, and context items are never deleted; retention covers terminal messages only. | high | Retention sweeps keyed on run terminal time. |
| S4 | No log rotation; the hub writes every line twice. | high | One logger with size-capped rotation; stdout only when not daemonized. |
| S5 | The migration doc's database rules have no code and there is no backup command. | high | `kxm backup` and `kxm restore` before any schema change. |
| S6 | The legacy store stamps `user_version = 3` unconditionally with no migration steps; an older database is silently relabelled. | high | Stepwise migrations; refuse unknown versions. |
| S7 | Delivery is fire-and-forget SSE: backpressure ignored, reconnect replays everything, no cursor, no per-agent sequence, ordering by map insertion. | high | Per-agent monotonic sequence and a persisted client cursor. |
| S8 | Ack flips a status but the message is redelivered on the next flush. | medium | Ack is a cursor advance. |
| S9 | Send idempotency is an unindexed linear scan with no unique constraint. | medium | `UNIQUE(from, idempotency_key)`. |
| S10 | No dead letter and no delivery retry; expired work vanishes after 24 h. | medium | Dead-letter table plus operator view. |
| S11 | Full message bodies stored unredacted for seven days; redaction only at CLI print. | medium | Redact on write. |
| S12 | Three unrelated log sinks; the Runtime supervisor writes only a last-error file. Zero `console.` calls in source, which is good. | medium | One logger with correlation fields. |
| S13 | Run events carry no schema column. Projection rebuild does exist and is tested, contrary to the critic's first draft. | low | Add the column. |
| S14 | The dash read handle omits `busy_timeout`; hand-rolled transactions have no nesting guard; the experimental-warning suppression is global. | low | Fix each. |

A single-project user ends up with three SQLite files plus six sidecars and
roughly a dozen JSON, pid, manifest, and log files.

**Recommendations.** Two SQLite files, both owned by the runtime store module:
the per-project event store and the registry. Retire the legacy database when
the hub moves onto the event store. One `openDatabase` that sets WAL,
`busy_timeout`, `synchronous = NORMAL`, and checks `user_version`. Keep
`node:sqlite`; the engines floor already clears the unflag. The per-project
event store is the queue: per-agent monotonic sequence, persisted cursor,
at-least-once with consumer dedupe on event id, SSE as notification not
transport, TTL, hop limit, dead letter. One logger with level, timestamp,
component, and correlation fields (run, sequence, command, request, project),
JSONL, size-capped, redaction on write, used by hub, worker, supervisor, and
telemetry. Defer the outbox, Postgres or libsql, brokers, and online backup,
and say so in the docs.

Keep: one `BEGIN IMMEDIATE` covering command dedupe, run insert, event
append, and projection update; the primary key on project, run, sequence plus
unique event id; the symlink and sidecar checks and case-folded Windows key;
the injected logger seam.

## 11. Plans, phases, slices, work items

Three trackers disagree. The plan's Tracking section has 54 bullets. GitHub
issue #59 is a roadmap with one issue per slice (#60 to #74), each closed by
one PR, which was good discipline until it stopped at PR #75; PR #76 and
roughly forty direct commits since had no slice. Issue #59 still names the
next slice as Phase 2 outbox and worktree isolation, while the plan says the
Phase 2 gate passed and Phase 3 is next, and the Phase 2 text lists the outbox
without saying it was deferred.

Tracking grows because it holds three lifecycles in one list: decisions
(append-only), a changelog (Landed), and a backlog (Still open), plus rules,
design notes, and chores. "Plan" and "Task" also collide with the dash's
Plans and Tasks tabs.

| Level | Source of truth | Lifecycle | Rule |
|---|---|---|---|
| Plan | `implementation-plan.md` in Git | Edited only when a gate passes or a phase is split or reordered | Phases, gates, one Landed line per phase. No backlog, no diary. |
| Decision | `docs/vnext/decisions.md`, dated, numbered | Append-only; supersede, never edit | Six lines max each. Replaces Decided. |
| Phase | GitHub milestone named by its gate | Closed when the gate test is green on `main` | Gives "what is left" for free. |
| Slice | GitHub issue labelled `slice` plus `phase:N` | One issue, one PR, "Closes #N" | One to three days; body is scope, gate delta, checklist. |

Work items are checkboxes in the slice issue. No fifth artifact. Chores go
into a slice or become a gate. Rules live in AGENTS.md or a contract. Design
notes become a decision or a contract doc. Landed goes to the CHANGELOG and
the closed issue. Still open becomes a link to the open `slice` query.

Concrete: create milestones 3a, 4, 0.6.0; file part 1's Slices A to D and this
part's additions as issues; add `phase:*` and `slice` labels (today every
issue carries only `enhancement`); reconcile #59 (outbox to Phase 8, worktree
isolation to Phase 5); add "Slice issue: #N" to the PR template; bind this
repo's tracker as GitHub Issues once the `tracker` field exists.

**Source of truth, one rule at every level.** One authoritative record per
kind of fact; everything else derived and rebuildable. Git holds intent,
decisions, and executable behavior because they need review. GitHub holds
work state because it changes daily. The gate test holds "done". The
per-project event store holds run facts and routing records. The Runtime
registry holds host bindings. The harness inventory holds capability and
auth. Git holds memory that shapes behavior; SQLite holds only what a rebuild
reproduces. A projection is never an authority because it is easier to query.
The Tracking section, the hub's in-memory maps, the dash snapshot, and the
wiki all fail that test today.

## 12. KXM Studio: proposed Phase 10

A local web studio is the right post-MVP milestone and Phase 10 already
reserves it. The research pass, verified against current releases on
2026-09-04, recommends:

**Stack.** Vite 8 building a static single-page app that the existing hub
serves on loopback (<https://vite.dev/blog/announcing-vite8>). Reject Next.js:
server rendering buys nothing for a single-user loopback app and adds a second
server beside the hub, which fights "same read models as the TUI". React 19,
TanStack Router for type-safe deep-linkable state
(<https://tanstack.com/router/latest/docs/framework/react/comparison>),
TanStack Query as the only cache with the existing SSE feed invalidating keys,
Tailwind 4 plus shadcn/ui copied in as source
(<https://ui.shadcn.com/docs/installation>), CodeMirror 6 for YAML text, and
the `yaml` package's comment-preserving document API for round-trip
(<https://eemeli.org/yaml/#documents>). Ship as a separate
`@kontextmind/kxm-studio` package; the built bundle is well under a megabyte
gzipped, but separation keeps the CLI lean and lets `kxm studio` fail closed
when absent. Skip AI gateways, edge runtimes, and server components.

**Canvas.** If a graph is drawn, draw it with React Flow, which is MIT with a
support-only paid tier (<https://reactflow.dev/pro>) and has no layout engine
of its own, so use ELK for a layered DAG with back-edges
(<https://reactflow.dev/learn/layouting/layouting>). Rete and Drawflow are
stale. **Do not make a free-form canvas the authoring surface.** The workflow
schema is an ordered array with typed transitions and no coordinate fields; a
canvas would invent positions with nowhere to persist them. The primary editor
is a stepper with a per-step inspector for kind, agent, assignments, join,
evidence, limits, and transitions. Beside it, a read-only auto-laid-out graph
for comprehension and live run overlay, positions always derived. Temporal's
UI is the model to copy: no editor at all, an excellent run history. That is
KXM's asymmetry: edit as text-shaped forms, watch as a timeline.

**YAML round-trip.** The browser never touches the filesystem. An edit is a
command with an id: patch, apply to the parsed document, validate against the
workflow schema, write to `.kxm/drafts/<workflow>.yaml` (gitignored, never
browser storage, never SQLite), return the YAML plus a diff. Promotion is
draft, then `kxm trust diff` rendered as a review, then a branch and PR
through the existing delivery gate. Studio never writes a workflow file on
`main`. Two mutations only: draft write and draft discard. Guardrail test:
re-emitting both example workflows with zero edits is byte-identical.

**AI assist.** The AI SDK's chat hooks against a hub route, with plain Node
documented and no framework dependency
(<https://ai-sdk.dev/docs/ai-sdk-ui/chatbot>). Constrain output to a
schema-valid step patch, render it as a diff, and make the human accept the
audited command; the model is never a writer. AI Elements is a copy-in
component set and fits a non-Vercel app (<https://elements.ai-sdk.dev/overview>)
but pins chat state to its message types, so keep them out of the run read
models. **Defer voice.** The browser speech API is not baseline and ships audio
to a remote service unless local processing is available
(<https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition>);
in-browser Whisper means a multi-hundred-megabyte model download, wrong for a
CLI-installed tool.

**Panels beyond the six tabs.** A run timeline swimlane of steps, attempts,
and transitions with back-edge budget consumption and run limits, which is the
single highest-value screen and one the TUI cannot draw. Spend and quality
straight off routing records. A permission-diff viewer for `kxm trust diff`.
Plan and candidate review with quorum state and preserved dissent, plus the
approval screen. An evidence inspector per step.

**Boundaries.** Loopback only; refuse non-loopback until TLS and RBAC.
Origin and fetch-site checks plus a per-session token on every request
including SSE. No credentials in the browser. Strict CSP with no CDN and no
remote fonts. Keyboard-first with the dash's key language. Reuse the TUI
read-model layer; a projection the TUI lacks is added to the shared layer,
never to a web-only endpoint.

**Slices.** Prerequisites: Phase 3a engine events, the brief schema, routing
records with cost, a versioned read-model contract.

1. Read-only shell: the six dash screens as panels. Gate: every value comes
   from an existing read model; no new server projection.
2. Run timeline and evidence inspector. Gate: matches the database and
   `kxm dash` exactly for a completed run.
3. Workflow reader: stepper plus derived graph. Gate: both examples render;
   no layout data written anywhere.
4. Draft editing round-trip through two audited commands. Gate: no-op edit is
   byte-identical; invalid patch rejected server-side with the schema error.
   This slice is most of the work.
5. Commit and PR path. Gate: a test proves no code path writes a workflow file
   on `main`.
6. AI assist, text only. Gate: output is a schema-valid patch applied only by
   explicit accept, reproducible from the command log. Do not start before
   slice 4's round-trip test is green.

Non-goals: free-form canvas authoring or persisted coordinates; non-loopback,
TLS, multi-user, RBAC; voice in this milestone; any behavior that exists only
in the web app, including run-time overrides; replacing or freezing
`kxm dash`; model calls originating in the browser.

## 13. Refinement cycle: additions to the slices

Part 1's Slices A to F stand. This part adds to them and inserts one.

**Slice B (gates), add:** fix the coverage shortfall first; concurrency group;
`generated` and `plugin` jobs; `release.yml`; `delete_branch_on_merge`; the
`UNIQUE(from, idempotency_key)` constraint; `busy_timeout` on the dash handle;
mark `synchronization.md` not implemented.

**Slice C (plan patch), add:** decisions log; Still open replaced by the issue
query; milestones and labels; reconcile #59; Phase 2 text says outbox deferred
to Phase 8 and worktrees to Phase 5; Phase 5 R1 decision recorded; Phase 10
retitled KXM Studio with the six slices and non-goals; `scm` and `tracker`
fields noted for Phase 4.

**Slice D (Phase 3a), add as gate conditions:** the engine emits
`routing.attempt.recorded` per attempt with `costBasis` required; run events
carry a schema column; the gate registry executes `test` by argv and exit
code; a project-local gate can be registered; the init template matches the
fixture.

**New Slice D2 (agent CLI surface), after 3a and before Phase 4:** the six
peer commands and three workflow commands on the CLI; one command table;
generated MCP tool list; Pi extension calls the same handlers; drift test;
attempt-token tool-policy enforcement in the CLI; vNext signal path.

**Slice E (Phase 4), add:** `kxm.session-brief.v1` with one renderer and three
callers, cache and abort; Claude `statusLine` and session-start hook; the
union reader for dash and brief; `routing report` labels and quality-then-cost
sort; one logger module; hub admin check for promotion (K1); memory revision
set at run creation (K4); `kxm backup` and `restore`.

**Slice F (after 0.6.0), add:** `kxm repo add|list|bind`, the control revision
split (R2), the reviewed member-commit pin (R5), the binding index (R6); the
`ci-check` receipt and `wait` binding; the improvement report and candidate
format; agent-scoped memory; message queue cursor and dead letter; then Phase
10 Studio slices 1 to 6.

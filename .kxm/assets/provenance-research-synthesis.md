# Research synthesis: provenance-bound peer evidence and quorum gates

Run: `run_91bd1613720140178cd338df3a931372`
Issue: kontextmind/pi-extensions#22

## Peer research

| Peer | Message ID | Status | Replied at |
|---|---|---|---|
| provenance-grok | msg_3baef6c399a04768ba4c3613d3da14e6 | replied | 2026-08-26T15:17:53.580Z |
| provenance-gemini | msg_69a3e9e461794dd39238213cc4609678 | replied | 2026-08-26T15:15:11.749Z |

## Current state trace

1. `WorkflowEvidence = Record<string, string[]>` - flat strings, no provenance
2. `WorkflowEvidenceInput = Record<string, string>` - single string per key
3. `checkpointRun()` merges and checks completeness but no producer tracking
4. Hub enforces coordinator-only mutation via `targetAgentId` match
5. SQLite schema version 2; retrospective schema `pi-mesh.retrospective.v1`
6. Peer evidence flows: coordinator sends to peer, gets reply, self-reports string at checkpoint
7. No hub-side verification of cited message IDs at checkpoint time

## Agreements (both peers)

1. Keyed evidence identity is the correct join key (canonicalized, unique)
2. Coordinator-only checkpoint mutation stays (no "peer checkpoint" API)
3. Durable message records already carry producer fields (from/to/status/correlationId)
4. Legacy string[] evidence remains readable but must not satisfy provenance gates
5. Failed/warning evidence is already non-satisfying (only persisted on passed)
6. Fanout already has run-scoped binding (correlationId, idempotencyKeyPrefix)
7. External signals already have HMAC + delivery-id dedup
8. Journal infrastructure supports explicit degradation recording

## Contradictions and resolutions

| # | Issue | Resolution |
|---|---|---|
| 1 | Grok: 15 threat cases; Gemini: 4 | No contradiction - Grok is superset. Use all 15 for test coverage. |
| 2 | Grok proposes `stageId` on MessageRecord; Gemini does not mention | Superseded after independent audit: use a hub-authorized immutable workflow context with run, stage, requirement, and attempt. Idempotency remains retry-only. |
| 3 | Grok proposes `user_version` 3; Gemini says "likely v3" | Superseded after compatibility review: the new fields live inside existing JSON records, so schema v2 remains valid and old runs remain readable. |
| 4 | Grok mentions retrospective v1 additive vs v2; Gemini silent | Decision: keep v1 schema with additive provenance fields to avoid breaking existing tooling |
| 5 | Both agree on structured evidence items but exact shape differs | Decision: Use Grok's `WorkflowEvidenceItem` shape as base - it is more complete |

## Acceptance criteria (synthesized from both peers)

1. Stage definitions declare bounded per-requirement `peer-reply` evidence policies with eligible producers and a minimum unique-producer count.
2. The hub authorizes and persists immutable run/stage/requirement/attempt context, then verifies cited replied messages at checkpoint or wait time.
3. SQLite remains schema v2 because the contract is additive within JSON records; legacy runs and string evidence remain readable but are never inferred as peer proof.
4. Callers submit message IDs only through `evidenceRefs`; producer identity, terminal state, timestamps, and SHA-256 snapshots are hub-derived.
5. Coordinator-synthesis type NEVER satisfies peer-review quorum seats
6. Degradation is available only when configured and explicitly approved by the mesh administrator for the current attempt, with an atomic warning journal entry.
7. Legacy string evidence remains readable without relabeling and cannot satisfy a structured peer policy.
8. All interfaces updated: workflow.ts, hub.ts, store.ts, cli.ts, mcp-server.ts, extension.ts, retrospective.ts
9. Tests cover all 15 threat cases from Grok analysis
10. Documentation updated for trust model change

## Threat cases (unified, 16 total)

T1. Coordinator self-attestation (string fabrication)
T2. Fabricated/foreign message IDs
T3. Replay / wrong-run binding
T4. Wrong-stage binding
T5. Pending/expired/cancelled/error counted as review
T6. Duplicate producer / one peer as N
T7. Name spoofing (use agent ID, not name)
T8. Coordinator-synthesis labeled as peer-review
T9. External-signal laundering
T10. Wait-merge substitution
T11. Warning-attempt laundering
T12. Post-purge / missing-message ambiguity
T13. Silent degradation
T14. Cross-agent citation
T15. Content swap (hash reply content)
T16. Schema downgrade attack

## Operator independent-audit contradiction — resolved

The separate architecture and adversarial audits reject resolution 2 above.
`idempotencyKeyPrefix` is caller-controlled text and cannot be the authority for
wrong-stage rejection. A peer request needs an immutable structured workflow
context containing the exact run ID, stage ID, requirement key, and attempt.
The hub must authorize and persist that context, compare it during exact retries,
and verify it when evidence is collected. Human-readable idempotency keys may
remain useful for deduplication, but parsing them for security scope is a release
blocker.

The audits also require producer eligibility to be snapshotted from explicit
workflow-local selectors and counted by unique durable agent ID. Agent purpose,
model, prompt text, or a caller-supplied role must never be treated as an
authenticated role. Under the current shared project token, quorum proves
provenance only inside that credential boundary; it does not prove correctness,
model independence, or non-collusion.

## Release-workflow lesson: exact extension precedence

A fresh three-agent verification exposed a harness mismatch before release: Pi
discovered an older user-installed package ahead of the worktree under test, so
the two peer requests arrived without workflow context and the new gate correctly
failed closed. The worker now supports bounded path-delimited extension and skill
sets, validates them before supervision, disables discovery for each configured
category, and passes the reviewed resources through Pi's explicit options. Release
verification pins the worktree mesh extension and skill plus the separately
installed provider extension it needs.

A subsequent threat review rejected the first launcher as release evidence because
workers inherited the administrative token and could technically approve their own
configured degradation. The corrected launcher gives the hub an ephemeral admin
token, maps a separate ephemeral project token, removes webhook secrets before
worker spawn, and restores the admin credential only in the operator process. It
also waits for three workers and retries start until the exact coordinator and peer
selectors resolve. No secret value is persisted in the workspace.

## Release-workflow lesson: final provider failure is not completion

The credential-correct run collected two durable, provenance-bound peer replies,
then the coordinator provider exhausted its quota on the synthesis turn. Pi emitted
a final assistant `error` and settled. The old extension treated any settled turn as
a successful peer reply, so the hub correctly failed the still-running workflow for
premature coordinator settlement. The transport and evidence gates behaved as
designed; the long-lived harness did not.

The extension now distinguishes a successful settled response from a final provider
or quota error. It retains the inbound message, preserves recovery context, and
records only the allowlisted diagnostic class. The supervisor waits for Pi's own
retries to finish, gracefully restarts the RPC child, rotates through an explicitly
configured bounded model list, and continues the current session. A structurally
unresumable session still falls back fresh through the existing recovery path.

## Release-workflow lesson: prompt-only read-only roles are insufficient

In the next run, the reviewer prompt prohibited edits, but a reviewer with shell
access still created temporary diff files in the shared checkout and then stopped
making progress inside a shell tool. A nested hub start also replaced the live hub
PID record, so the normal stop command could no longer address the original hub.
The temporary files were removed before release and no tracked source was accepted
from the reviewer.

The worker now passes an explicit Pi tool allowlist. Release reviewers receive only
read, grep, find, and list tools; the coordinator receives those plus the minimum
mesh workflow tools. A bounded tool watchdog preserves and restarts delivered work
when an enabled tool never returns. The hub wrapper also claims its PID file without
overwriting a live managed process. These are enforced harness boundaries rather
than behavioral requests in a prompt.

## Final three-model release acceptance

Run `run_49f86c8eab1142f69b121789f3f8b173` exercised the release workflow with
Grok as coordinator, Claude Sonnet as one reviewer, and Gemini 3.1 Pro as the
second reviewer and configured fallback. The coordinator used a 120-second local
fanout wait under the 180-second dogfood tool watchdog, retained both durable
message handles, verified their stored workflow bindings, and awaited them by ID.

The hub accepted exactly two unique, eligible, replied producers:

| Producer | Message ID | Verified binding |
|---|---|---|
| reviewer-claude | msg_e53b3dec9bd44a44b0d6d7ec237f0736 | run / review / independent peer reviews / attempt 1 |
| reviewer-gemini | msg_bb3561fc8ed44b5188a2336a060a4f9a | run / review / independent peer reviews / attempt 1 |

The reviewers disagreed only on whether three test/documentation hygiene items
were release conditions. The coordinator recorded that contradiction, verified
the claims against the worktree, kept the warnings as follow-ups, and approved the
security invariants. The hub passed the stage on attempt 1 with no degradation
approval. The initiating message then settled normally, and the retrospective was
exported under `.kxm/assets/retrospectives/` as a proposed, review-gated artifact.

## Post-acceptance durability audit

The final audit turned the failed and slow runs into additional harness controls:

1. Final provider errors wait for Pi's built-in retries, retain the original mesh
   message, and rotate only through a bounded configured model list.
2. RPC framing no longer truncates large single-line provider or tool events, and
   raw RPC output stays out of supervisor stdout and structured logs.
3. A structurally unresumable continued session takes the fresh-session path before
   provider rotation; completed large tool results cancel the watchdog reliably.
4. Recovery telemetry journals only when it carries an exact persisted run ID. An
   unbound worker event is never attached to an arbitrary active workflow.
5. Fresh provider and tool-timeout recovery relies on the durable inbound replay,
   avoiding a duplicate synthetic recovery turn.
6. Workflow-start retries reuse one stable delivery ID, and fanout retries reuse one
   deterministic run/stage/attempt idempotency prefix.
7. Hub and worker ownership claims fail closed instead of overwriting another live
   supervisor, including cross-project and sanitized-name collision cases.

The remaining trust limit is deliberate and documented: quorum proves durable
routing provenance inside the configured project-credential boundary. It does not
prove response truth, model independence, or non-collusion.

---
schema: "kxm.doc.v1"
id: "HANDOFF-2026-09-24-UNIFIED-FABLE"
type: "review"
title: "Session handoff 2026-09-24: Fable unified-plan synthesis across the plan set"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-24"
updated: "2026-09-24"
authority: "instruction"
confidence: "uncertain"
summary: "Claude Fable high-effort synthesis of every open task across plans/*.md and plans/reviews/*.md, prioritized under the 2026-09-24 session decisions; not yet applied to the plan set."
tags: ["handoff", "session-continuity", "unified-plan", "fable-review", "plan-consolidation"]
related:
  - ../implementation-plan.md
  - ../plan-per-tenant-hosting.md
  - 2026-09-24-session-handoff.md
depends_on:
  - 2026-09-24-session-handoff.md
blocked_by: []
---

# Unified plan synthesis 2026-09-24 (Fable)

Claude Fable (high effort) synthesis of every open task across the plan set. Run 2026-09-24: $10.05, 70 turns, 608 s. **Input gap:** Fable's sandbox could not read the session plan, so rows it marks `[transcribe from session file]` must be reconciled against `2026-09-24-session-handoff.md`. The session plan wins every conflict. Not yet applied: no plan files were deleted or moved.

Gathering is complete. Here is the synthesis.

**Read this first.** The session plan at `C:/Users/onesm/.omp/agent/sessions/.../tenant-hub-routing-cycle-plan.md` could not be opened from this sandbox: Read, Grep and Glob were each refused on that path three times. Everything below that traces to it is built from the summary in your request, cited as "session plan, via brief". Rows that need its exact text, above all the Phase 7 hardening list H1 to H6 and each phase's named test, are marked **[transcribe from session file]**. Every other source was read in full.

## 1. Authority

The unified plan below replaces every file listed under `delete` and `move to plans/history/` in section 7 and becomes the whole content of `plans/implementation-plan.md` under `## Tracking`. That file stays the single tracker. `AGENTS.md` lines 4, 91 and 160, `CLAUDE.md` and `GEMINI.md` line 4, the four `docs/contracts/*` pages and `docs/contributing/harness-routing-internals.md` already point only at `plans/implementation-plan.md`, and `docs/contracts/synchronization.md` and `CLAUDE.md` link to the `#phase-8-multi-project-hub-kxm` and `#tracking-working-tree-not-a-release` anchors, so those two headings keep their exact text. Priority order for every conflict is the 2026-09-24 session decisions, then Decided newest first, then Still open, then the other plans, with `plans/history/**` read only for provenance.

## 2. Decided (deduplicated, newest first)

| Date | Decision | Source |
|---|---|---|
| 2026-09-24 | D1: CI test legs pause; a local WSL pipeline runs the commit gate | session plan, via brief |
| 2026-09-24 | D2: the writer route is `grok --model grok-4.7` | session plan, via brief |
| 2026-09-24 | D3: complete the Mesh-to-KXM cutover of remaining internals, no aliases | session plan, via brief |
| 2026-09-24 | D4: SQLite stays authoritative per tenant, proven by a concurrency witness | session plan, via brief |
| 2026-09-24 | D5: tenant model is a kxmd account with owner, admin and standard roles; a tenant VM runs hub, Runtime, Studio and wiki | session plan, via brief |
| 2026-09-24 | D6: the tenant hub is public through Authentik, with per-machine service accounts, browser cookie plus hub bearer | session plan, via brief |
| 2026-09-24 | D7: migrations and staged upgrades return | session plan, via brief |
| 2026-09-24 | D8: central tenant configuration and provider OAuth | session plan, via brief |
| 2026-09-24 | D9: an omp-style auth and usage broker, `budgets.yaml`, roster failover | session plan, via brief |
| 2026-09-24 | Claude Opus at medium effort is admitted as planner and reviewer-arch; `required_critics.review-arch` is `opus-claude`, Fable remains admitted | commit `7561b5b`; `.kxm/roster.yaml` lines 31 to 64; no Decided entry exists yet |
| 2026-09-22 | A tenant is plan-bound, holds multiple users and may own multiple workspace VMs; every VM running KXM is its own box with its own hub, Runtime, state set and Studio; the host tenant is admin-only until owned | implementation-plan.md ┬º Still open, S5 row. The portal-only and `studio.kxmd.dev` parts are superseded by D5 and D6 |
| 2026-09-20 | Test policy: one focused named test per breakable behaviour in an existing suite; deleting a compatibility path deletes its tests; fail-closed brakes, the fixed witness and two-critic acceptance are never weakened | ┬º Decided "Single operator". The no-migrations half is superseded by D7 |
| 2026-09-20 | One tenant = one box = one hub with a tenant label, not a tenant table; hosting is additive and a broken browser path never stops authorized machine clients; no PostgreSQL write path; a disposable per-hub reporting projection only on its named trigger; a shared multi-tenant schema is ruled out | ┬º Decided "Per-tenant hosting", rulings 1, 2 and 4. Ruling 3 and the loopback-only listener are superseded by D6 |
| 2026-09-20 | Local token-authenticated operation stays the default; the hosted tenant box is the selected path; reaching a box passes neither Phase 6 nor Phase 8 | ┬º Decided "Hub local is the default" |
| 2026-09-20 | Cross-cutting test gates: at most one named test per slice, no new npm script, CI job, platform leg or coverage ratchet | ┬º Cross-cutting test gates. The "existing CI jobs" half is superseded by D1 |
| 2026-09-20 | Cross-host rulings: A2A is a projection never the transport; `kxm peer` is the live transport; `homeRuntimeId` is immutable and stages run only on the owning box; the supervisor is never reachable across hosts; sync is allowlist-first and exact-once by sequence; unknown effects are never replayed | plan-cross-host-phase.md ┬º A, rulings 5 to 10, 13, 14 |
| 2026-09-17 | Package layout convention `src/{types,tui,services,adapters,exports}`, layer rules gated by `package-layers.test.ts`; Bun is installer and task runner only, CI stays `npm ci` on Node | ┬º Decided "Package layout convention" |
| 2026-09-17 | Public npm prerequisite satisfied; `@kontextmind/kxm` is published | ┬º Decided "Public npm prerequisite" |
| 2026-09-15 | Google routes through the `antigravity` Pi provider; `agy` stays a catalog helper; the same subscription-provider pattern templates Claude bridge, experiment-only | ┬º Decided "Antigravity routes through" |
| 2026-09-14 | Investigate persistent coordinator identities with internal inboxes; investigate uv Python and Rust only with component evidence; one KXM installation with thin host adapters | ┬º Decided, three operator entries |
| 2026-09-12 | Role configuration governance plan archived; do not schedule from it | ┬º Decided "Role configuration governance archive" |
| 2026-09-11 | Safety, process integrity and critic sandboxing complete via #188 and #189 | ┬º Decided "Safety, process integrity" |
| 2026-09-10 | `plans/implementation-plan.md` is the only active execution tracker; archived records may not create work | ┬º Decided "Plan source of truth" |
| 2026-09-10 | Legacy `.kxm/config` and `.kxm/roster.json` authority retired; initialized project resources are the authority | ┬º Still open "Legacy configuration retirement", moved here |
| 2026-09-08 | `.kxm/` is the tool workspace; planning documents live in `plans/` | ┬º Decided "Planning home" |
| 2026-09-07 | Workflow taxonomy Area, Workflow, Stage, Role; slugs are documentation identity only | ┬º Decided "Workflow taxonomy" |
| 2026-09-07, 08 | Developer roster U1a and U1b: trusted policy loader, live lineup admission, vendor independence between writer and critics | ┬º Decided "Developer roster U1a" |
| 2026-09-06 | Role rotation is chosen per role from authenticated routes by quality, cost and rework; after a failure try the next eligible model; OpenRouter Qwen is a narrowly admitted Pi writer; Nous is a helper provider | ┬º Decided "Role rotation". The `grok-4.6` and Fable-as-sole-arch-critic details are superseded by D2 and commit `7561b5b` |
| 2026-09-06 | Operator bootstrap acceptance exception for PR #130, single repair | ┬º Decided |
| 2026-09-05 | Windows CI, hosted Windows probes and Windows qualification are paused, not deprecated | ┬º Decided "Platform pause". The ARC-legs-active half is superseded by D1 |
| 2026-09-04, 05 | Provider-native harness preference: a logged-in first-party harness dispatches its own vendor; Pi never impersonates a subscription CLI; xAI dispatches through `grok`, fail closed if logged out | ┬º Decided "Provider-native harness preference" |
| standing | Product name is KXM; future slices are not backwards-compatible and old names fail closed with brakes; durable hub store `.kxm/state/kxm.db`; `kxm hub start\|view\|stop`; `kxm dash` tabs; agent config is Git YAML with Pi as the omitted default; a harness runs only models it hosts; `kxm harness list` is observational with tri-state auth; slim daily loop; CLI critiques are artifacts, never hub evidence; fixture ids `kxm-provenance`, `kxm-v04`; cost tracking is required with context tokens and explicit unknown; insights loop; side-by-side experiments; quota failover from the eligible set; developer runner `just assign\|witness\|accept`; private handoff notes; SCM and trackers detected then confirmed, GitHub not hard-coded | ┬º Decided, bullets 236 to 415 |
| standing | Paused platform checks are deferred evidence, never PASS; selecting release scope cannot waive a platform witness | ┬º Still open "Platform-gate interpretation", moved here |

## 3. Unified queue

Legend for the test column: **named** is an existing or plan-named test; **proposed** follows the repo's naming convention and needs the session file or a reviewer to confirm.

| # | Deliver | Source(s) | Depends on | Trigger / unblocked by | Proof | One named test |
|---|---|---|---|---|---|---|
| 1 | **Ph0 CI test pause and local WSL pipeline.** Pause the Validate test legs; run `npm run verify` in WSL as the commit gate; keep the pinned job names so ruleset `22251971` still resolves; update `ci-contract.test.ts` to the paused shape | session D1 via brief; supersedes ┬º Decided platform pause and Landed "Three-minute merge gate" | none | session plan | a PR merges with WSL verify green and CI legs in their paused shape | none, pipeline; `test/core/ci-contract.test.ts` updated **[transcribe]** |
| 2 | **Ph1 grok-4.7 writer.** `roster.yaml` `grok-native` model, `routes.yaml` admitted list and writer role, a dated `prices.yaml` row, `AGENTS.md:38`, `CLAUDE.md` and a Decided entry move to `grok-4.7`; `grok-4.6` fails closed | session D2 via brief; ┬º Decided role rotation; `.kxm/roster.yaml:5`, `routes.yaml:14,20`, `prices.yaml:25` | 1 | session plan | `grok models` shows 4.7 logged in; one `just assign` accepted on 4.7 | proposed: `writer route grok-4.7 is admitted and grok-4.6 is refused` in `test/core/harness-run.test.ts` |
| 3 | **Ph2 Mesh cutover.** Rename together at one wire and schema bump: `MeshHub`, `createMeshHub`, `MeshStore`, `MeshTui*`, `LocalMeshSnapshot`, `loadLocalMeshSnapshot`, `meshClient`, `MESH_TUI_PANELS`, `piMeshExtension`, `pi-mesh.*` schema ids, `X-Mesh-Delivery-ID`; brakes refuse the old ids; delete the stale `.kxm/assets/run-provenance-workflow.ps1` | session D3 via brief; ┬º Still open "Remaining Mesh-named internals"; ┬º Decided "Fix leftovers with brakes"; routing-rule-drift item 1 | 1; coordinate the bump with 7 | session plan | no `Mesh` identifier outside brake code; docs-copy brake green | proposed: `hub refuses pi-mesh.* schema ids and X-Mesh-Delivery-ID` in `test/core/hub-api.test.ts` |
| 4 | **Ph3 SQLite per tenant with a concurrency witness.** Two-process barrier over intake ingress, binding and admission and over hub lease claims; live observation of `SQLITE_PROTOCOL` and `SQLITE_BUSY_RECOVERY` classification; the open admission and supervisor-misuse timing assertions get a barrier or injectable clock | session D4 via brief; ┬º Decided ruling 4; ┬º Still open intake follow-ups 4 and 10; ┬º Still open timing-dependent assertions | 1 | session plan | two processes contend on one store; loser refused with the named code; no stranded rows | proposed: `two processes cannot double-admit one intake message or double-claim one hub lease` in `test/core/intake.test.ts` |
| 5 | **Ph4 tenant model.** kxmd account; owner, admin, standard roles; one tenant VM runs hub, Runtime, Studio and wiki under a service account; multiple VMs per tenant, each its own box; host tenant admin-only | session D5 via brief; ┬º Still open S5 surface decisions; ┬º Decided ruling 1 | 4 | session plan | deployment witness: four services active on one VM, role gate enforced | deployment witness |
| 5a | Hub context pool reads each project's committed memory and promoted skills through the Git gate, not the hub checkout | ┬º Still open recorded gap "hub's context pool"; trigger fires with 5 | 5 | Ph4 makes the hub serve per-account projects | recall from project A never returns project B memory | proposed: `hub context pool serves only the caller project's committed memory` in `test/core/context-surfaces.test.ts` |
| 5b | Studio state and mutation handlers wired to the command API, so hosted Studio never answers success without a receipt | Phase 10 gate; ┬º Still open "Studio mutate without a handler returns 501"; reviews/authentik-hosting-design-astra slices 4 and 5 as provenance | 5 | Ph4 puts Studio on the tenant VM | every Studio mutation shows a command receipt or a 501 | proposed: `Studio mutation executes through the command API or answers 501, never ok without a receipt` in `test/core/studio-layout.test.ts` |
| 5c | Wiki compiled from hub served on the tenant VM; `kxm context wiki-compile --out` becomes the operated path; ingest stays unselected | session D5 via brief; ┬º Still open "Wiki compile stays a dry run unless --out", "Wiki ingest stays unselected"; research-a2a ┬º13 | 5 | Ph4 | compiled pages served on the tenant VM | none, docs and deployment witness |
| 6 | **Ph5 public tenant hub through Authentik.** Per-machine service accounts; browser cookie session at Authentik plus hub bearer for machine clients; proxy strips client-supplied identity headers; machine clients keep working when the browser path is down; the S5 login, logout and refresh witnesses rerun on this surface | session D6 via brief; supersedes ┬º Decided ruling 3 and the 2026-09-22 `studio.kxmd.dev` surface; plan-per-tenant-hosting ┬º "two decisions settled"; authentik review as provenance | 5 | session plan | deployed witness: unauthenticated denied, wrong tenant denied, forged header stripped, service-account bearer served during a browser outage | proposed: `hub keeps serving a valid service-account bearer while browser auth is down` in `test/core/hub-api.test.ts` |
| 7 | **Ph6 migrations and staged upgrades; central tenant config and provider OAuth.** Stepwise migrations return for hub store, registry and event store; staged upgrade per tenant VM; restore remaps `$S` paths onto another box; `docs/contracts/migration.md` matrix rewritten; central tenant configuration holds tenant-to-endpoint and project maps and provider OAuth state for antigravity, Nous and grok; Phase 1 text rewritten | session D7 and D8 via brief; supersedes ┬º Decided "Single operator: no migrations" and "No project-file migration either", cross-host ruling 11; ┬º Still open backup gap "restore does not remap absolute `$S` paths"; M8 | 4, 6 | session plan | an older stamped store upgrades on a staged box; the restore witness passes across boxes | proposed: `an older event store migrates stepwise to the current version and a newer one is still refused` in `test/core/e6-backup-restore-migrations.test.ts` |
| 7a | Runtime journal and retrospective store, so `kxm workflow record` reaches Runtime runs and `signals` cover them | ┬º Still open recorded gap "Runtime runs have no journal" | 7, 9 | S5 closed and a new store is now possible through 7 | a `kxm run` id accepts a journal entry and appears in `kxm_improvement_report` | proposed: `a Runtime run accepts a journal entry and its retrospective exports` in `test/core/journal-evolution.test.ts` |
| 8 | **Ph7 auth and usage broker, `budgets.yaml`, roster failover.** Broker owns provider auth state and account-scoped usage and quota observations; `budgets.yaml` declares caps; `limits.maxModelCost` trips on broker-reported usage; quota or auth loss fails over to the next eligible route and records exhaustion; dated hashed price feed; routing report rework column reads a real signal | session D9 via brief; ┬º Decided quota failover, cost efficiency, insights loop; ┬º Still open routing question 4, "Model catalog and pricing feed", "Post-MVP API budgets" superseded, v2 report rework gap; plan-usage-cost-quota-tracking; role governance archive | 2, 7 | session plan | a capped run stops at the cap; an exhausted route fails over with exhaustion recorded | proposed: `a declared limits.maxModelCost trips on broker-reported usage and failover records exhaustion` in `test/core/route-admission.test.ts` |
| 9 | **S5 interactive login witness**, plus logout revocation and refresh mid-run, on the Ph5 surface with `kxm-witness-admin` and `-other` | ┬º Still open S5 | 6 | Ph5 deployed | click-through recorded | deployment witness |
| 10 | **P0 cross-box `kxm peer` witness** over the public tenant hub with a per-machine service account; records the `remote` label and the edge recheck | ┬º Still open P0; plan-cross-host-phase P0 | 6 | Ph5 replaces the SSH-forward substrate | `send`, `await`, `reply` and a signal-resumed wait from two boxes | deployment witness |
| 11 | **P1 presence across boxes**: `host` label, `lastSeenAt`, `leaseExpiresAt`, `online\|stale\|offline`, `includeOffline` | ┬º Still open P1 | 10 | P0 | box B lists box A's agent and watches it go stale then offline | named: `agent listing reports host label, lease expiry, and offline members only when asked` in `test/core/hub-api.test.ts` |
| 12 | **P5 and P6 live second box**: a run on box B appears in hub A's snapshot; a conflicting shared push is refused; deployed restore witness rerun after Ph6 bumps | ┬º Still open P5 "box-B witness still to run", P6 "second physical box" | 10, 7 | P0 | both run ids, sync cursor and refused push recorded from two boxes | deployment witness; driver test already landed |
| 13 | **Phase 4 exact-route live acceptance** for the grok-4.7 writer and the admitted Pi routes, with the acceptance coverage list from local dispatch | ┬º Phase 4 "Still this phase"; ┬º Still open "Local KXM dispatch, implemented not accepted", "Non-Pi dispatch adapters: qualification" | 2 | Ph1 changes the writer route | live run through `kxm run default` with visible `kxm dash` status | deployment witness against the existing suites |
| 14 | **H1 to H6, session Phase 7 hardening** **[transcribe from session file]**. Repo-sourced candidates that likely map: proxy header stripping proven by an edge fixture; credential-store corruption recovery; rotation overlap window; a real `kxm doctor`; intake record digest; byte bound on read; classification enforcement for untrusted adapters; `acceptedStatuses` evidence semantics | plan-per-tenant-hosting ┬º Deferred hardening; ┬º Still open intake follow-ups 2, 5, 6; recorded gap `producerPolicy.acceptedStatuses` | 6 | Ph5 exposes the hub to untrusted traffic | per item | per item **[transcribe]** |
| 15 | **P4a to P4d coordinator intake**, four PRs; schema bumps now ride the Ph6 migration path | ┬º Still open P4; plan-cross-host-phase P4; intake follow-ups 1, 8, 9 | 7, P2 landed | a cross-box request targets a role, observed as `target_not_found` from 10 | one real cross-box request to an offline role yields one run and one reply with its receipt | named per sub-slice in plan-cross-host-phase ┬º B rows P4a to P4d |
| 16 | Assignment-runner records group: `accepted.json` as the pass signal, brief hash as ask identity | ┬º Still open recorded gap "developer assignment-runner records do not group" | none | operator picks the pass signal, section 5 item 10 | `kxm improve` shows `just assign` history as decided | proposed: `assignment-runner records group by brief hash and settle from accepted.json` in `test/core/improve.test.ts` |

## 4. Backlog behind triggers

- **Post-MVP first-use repairs.** Trigger: an observed failed, slow or ambiguous operator action; one regression per repair. ┬º Still open "Explicitly not MVP".
- **One progress improvement, then one supported control** over one route. Trigger: polling proved insufficient with the miss written down first. ┬º Still open; plan-cross-host-phase ┬º C; M2, M3.
- **Reporting projection on `kxm-dev-svr`.** Trigger: a concrete report needs retained cross-hub history, or measured polling misses an agreed target after bounding. ┬º Decided ruling 4.
- **Hub-to-hub relay link.** Trigger: one project must be coordinated from two hubs, recorded from a P0-style witness. plan-cross-host-phase ┬º C.
- **Signed envelopes, pinned keys, signed roster, in-toto receipts.** Trigger: a hub accepts peer traffic from a surface not authenticated by an existing machine credential, by written decision. plan-cross-host-phase ┬º C.
- **Remote MCP on the hub, stdio shim forwarding.** Trigger: a written decision on a public MCP origin. research-a2a ┬º1B, ┬º14.
- **A2A Agent Cards and bindings.** Trigger: a concrete external platform must call in. research-a2a ┬º1C.
- **Coordinator email and SMS bindings, automatic takeover, multi-hub election.** Trigger: after the P4d live witness and a takeover decision. M8; research-memory-studio-forks.
- **Memory tree with `kxm promote`, `memoryRev`, FTS5 recall; context bundle `kxm.context-bundle.v1`.** Trigger: a second box produces candidates that must be recalled on the first. research-a2a ┬º4, ┬º5; M5.
- **NATS or any broker.** Trigger: measured fan-in beyond jittered polling with the threshold agreed first. research-a2a ┬º1D.
- **Trace ids, OTLP exporter.** Trigger: a report the routing report and hub read models cannot answer. research-a2a ┬º7.
- **Plan digest and `kxm plan lint`.** Trigger: a second drift incident between a plan edit and in-flight work. research-a2a ┬º10.
- **Improvement deltas, hub dedupe, weekly PR; Phase 9 activation and measurement of a reviewed candidate.** Trigger: the first reviewed candidate. ┬º Phase 9; ┬º Still open "Improvement to coded steps".
- **Env and secret schema, `pass://` resolver.** Trigger: a run on one box needs a secret resolved on another. research-a2a ┬º15.
- **`kxm.agent-spec/v1`, `POST /v1/launches`, Phase 6 remote execution.** Trigger: Phase 6 selected in Tracking. ┬º Phase 6; plan-ssh-remote-execution.
- **Phase 7 MOA defaults and the first live multi-critic `/fix`.** Trigger: Phase 7 selected. ┬º Still open "Kind-level MOA defaults".
- **Package restructure into `packages/<tier>/<name>`; Bun on runners.** Trigger: a slice is picked up; Bun on CI carries its own evidence. ┬º Still open "Package restructure".
- **YAML-editing enable and disable UI and the `kxm.config.v1` editor command.** Trigger: operator selects it; the TUI kit is ready. ┬º Still open; Landed "terminal component kit".
- **Windows resumption and Windows qualification.** Trigger: a reviewed change that updates Tracking, tests and settings together; the WSL pipeline is Linux. ┬º Still open "Windows resumption".
- **Next release candidate and M9 platform qualification.** Trigger: a declared release scope. ┬º Still open "Release resumption"; M9.
- **Coverage: a test that imports every non-excluded module.** Trigger: before the next ratchet raise. ┬º Still open.
- **Nous follow-ups**: other models, auth refresh, exact quota, unmetered labelling, persisted catalog via Pi `publish`. Trigger: a Nous route is promoted. ┬º Still open.
- **Docs-audit leftovers (c) CLI-agent forwards start a new hop chain; (d) Jira and GitHub deliveries carry no signed timestamp.** Trigger: a forwarding loop or replay is observed from those sources. ┬º Still open.
- **Unexplained Fable ~219 s one-shot failure.** Trigger: recurrence under the current process module. ┬º Still open Phase 11 blockers.
- **Phase 11 isolation and takeover fencing; M2 and M3 streaming packets.** Trigger: a reproduced limitation of the retained route. ┬º Phase 11.
- **SCM and tracker adapters beyond GitHub and Jira.** Trigger: a project on GitLab or another tracker; until then fail closed. ┬º Still open.
- **`types` export condition; MCP factory API.** Triggers: declaration emit exists; a second MCP consumer. ┬º Still open.
- **Jev experiments M1 and M2 and the `suggest.ts` keyword fixes not covered by #314.** Triggers: the five named in research-jev ┬º Verdict; none has fired.
- **Modes activation and `kxm explain` estimator provenance; RTK output-reduction experiment; browser service; Steel repairs.** Trigger: selected after use under M1, M4, M5, M6. plan-workflow-modes, plan-token-reduction, M0, M4.
- **Rollover of leftover subscription allowance.** Trigger: the insights loop shows it pays, after Ph7 budgets exist. ┬º Still open "Post-MVP".
- **Standalone Studio repair beyond the 501.** Trigger: standalone Studio is selected for use; hosted Studio is row 5b. ┬º Decided ruling 3 note.

## 5. Pending operator decisions

| # | Decision | Options | Recommended default |
|---|---|---|---|
| 1 | Q-B, Q-C, Q-E to Q-K, Q-M defaults implemented on PR #298 | confirm all as implemented; decline named items, each reverted in its own change | confirm all; move to Decided dated 2026-09-23 |
| 2 | D-1 nine KontextMind knowledge-plane skills | keep rescoped; delete | delete; saves about 2,072 always-on tokens and KXM ships no KontextMind surface |
| 3 | D-2 plugin version pin | stay at 0.7.1; bump | bump, since work is not backwards-compatible and a bump delivers the new hook through a normal update |
| 4 | A0 `PostToolUseFailure` hook witness | operator runs it in an isolated `CLAUDE_CONFIG_DIR`; drop the tool | run it before Ph5; drop if it does not pass by then |
| 5 | Google route, routing question 2, unless Ph6 provider OAuth text settles it | A implement `antigravity` now; B record `agy` as interim; C B now then A on witness | C |
| 6 | Two Pi allowlists, question 3 | A delete the unused `harness.ts` constant; B one shared allowlist, an admission change | A |
| 7 | DeepSeek through `qwen-token-plan` and reseller ids, question 5 | A remove the route; B write the open-weight exception; then C the model-name vendor table | A now, then C |
| 8 | Worker with no `--model` or a bare id | require a provider-qualified model and refuse existing launches; leave as is | require qualified; fix the provenance coordinator launch |
| 9 | Cost-cap semantics until Ph7 broker lands, question 4 | A fail on unknown; B `limit_unsupported` handoff; C list-estimate upper bound | B now, C when the dated price feed lands in Ph7 |
| 10 | Assignment-runner pass signal | `accepted.json` plus brief hash; something else | `accepted.json` plus brief hash, then row 16 |
| 11 | Tags v0.7.41 and v0.7.42 without a release | leave them; delete tags; re-dispatch Release | leave; releases through v0.7.93 exist per Landed |
| 12 | Default update source | keep `github`; switch to npm | keep `github` until an installed-source qualification under M9 |
| 13 | Ruleset `22251971` under the Ph0 CI pause | keep pinned job names with no-op steps; edit the ruleset | keep the names with no-op steps, the pattern docs-only PRs already use |
| 14 | Confirm repository identity `kontextmind/kxm` | confirm; correct | confirm |

## 6. Removed

**Done or landed**, cited to Landed or the queue rows:

- S0 through S4: Landed "S0", "S1"; queue rows S2 kxm #257, S3 PR #256, S4 kxm #260.
- P2, P3, P5, P6 driver witness: queue rows marked delivered; P6 PR #277, finding 1 PR #280; CHANGELOG Unreleased entries for leases and `--allow-offline`.
- Pre-use must-fix slice, `kxm prices acknowledge`, Studio mutate 501, v4 init template: ┬º Still open "Pre-use must-fix slice, landed 2026-09-23".
- Backup discovers user-state Runtime stores and refuses a partial manifest; project-scoped backup and live-writer refusal: ┬º Still open recorded gap "Landed 2026-09-23"; Landed "`kxm backup` and `kxm restore` are scoped".
- Intake follow-up 3, shared restore-ceiling constant: P6 row, one `KXM_BACKUP_CEILINGS` table pinned by `restore ceilings track every store's own schema version`.
- Harness probe and worker timing tests: ┬º Still open "Both now have barrier fixes in this tree".
- Docs-audit items (a) `kxm peer inbox` and (b) `role resume` routing: Landed entries dated 2026-09-23.
- Slim `default` for init and this repo's gate routing: Landed PR #299; pre-use slice.
- Legacy configuration retirement, model inventory refresh, interactive guide setup: descriptive Still open bullets, moved to Decided or Landed.
- Issue-127 retirement contradiction: Landed "The documented `just` entry points existed only in the docs" resolves the contradictory records.
- B1 to B4, Claude write-refusal witness, price integrity, A1: ┬º Still open Phase 11 entry and Phase 11 text.
- Two-process barrier fixture #112, queue test #119, worker PID readiness #120: Landed.

**Superseded**, with the winning source:

- No migrations, `kxm migrate` deletion, cross-host ruling 11, "Version 1 and 2 stores refused with no migration lane": session D7.
- Hub binds loopback only, hub interprets no browser identity, hub-side cookie and session rejected, `studio.kxmd.dev` portal-only surface, `plan-per-tenant-hosting.md` "two decisions settled" bind semantics: session D5 and D6.
- Writer `grok-4.6` in Decided, roster, routes, prices, AGENTS.md and CLAUDE.md: session D2.
- Active ARC CI legs, three-minute merge gate as the PR gate, "existing CI jobs" in cross-cutting gates: session D1.
- "Post-MVP API budgets, do not implement", "quota prediction cut" in plan-set-reprioritization ┬º 2: session D9.
- Wiki compile unselected: session D5.
- Fable as required arch critic in AGENTS.md:40, CLAUDE.md, Decided 2026-09-06: commit `7561b5b`, `.kxm/roster.yaml`.
- `agy` as sole Google harness: Decided 2026-09-15.
- SSH and HTTPS hub install after MVP: Decided 2026-09-20 hosted path.
- Routing v2, event-settle write, ranked report and price catalog "planned": Landed D5 and E3.
- Two "first product slice" sequences in plan-unified and plan-per-tenant: Decided 2026-09-20 S0.
- research-a2a ┬º16 `kxm-hubs` VM, ┬º17 VM launch substrate, ┬º18 platform changes, and its M0 to M9 mapping: Decided 2026-09-20 rulings and research-a2a ┬º Status.
- AGY and Kimi to Pi migration objective: native-route ownership, plan-additional-providers header.
- Archived Q11 "configurable promotion" authorizes: narrowed by Q-B.
- Still open "Release resumption" text claiming npm latest 0.7.40 and no later releases: Landed cites v0.7.92 and v0.7.93 shipped.
- Landed claim that standalone Studio executed audited mutations: corrected in place 2026-09-20.

**Out of product scope, kept out**:

- PostgreSQL as hub write path or shared multi-tenant schema: Decided ruling 4 and session D4.
- `kxm hub footprint` product command: plan-per-tenant-hosting ┬º not in this plan.
- Jev as writer, critic, gate, price or admission input: research-jev ┬º Where it must not go.
- CRDTs, hub-owned Postgres memory, external memory engines: research-a2a ┬º disagreements, ┬º5.
- Claude experiment outcome 2026-09-07, Nous-to-Claude translation layer: ┬º Still open, historical, no task.

## 7. File actions

`plans/*.md`:

| File | Action | Reason |
|---|---|---|
| implementation-plan.md | keep | receives the unified content |
| plan-per-tenant-hosting.md | move to plans/history/ | provenance for the four rulings; boundary superseded by D5, D6 |
| plan-cross-host-phase.md | move to plans/history/ | P0 to P6 and its rulings are absorbed; the P4 test names are kept there |
| plan-unified-kxm-milestones.md | move to plans/history/ | M0 to M9 catalog and 36-fork map are provenance; scheduling authority was already none |
| plan-usage-cost-quota-tracking.md | move to plans/history/ | absorbed into row 8; quota contract sketch kept as provenance |
| plan-additional-providers-agy-kimi.md | delete | migration objective superseded; remaining pointers live in the streaming research and row 8 |
| plan-agent-communication-steering.md | delete | sketch only; steering is a backlog line with its trigger; research-a2a ┬º11 keeps the design |
| plan-ssh-remote-execution.md | delete | describes existing helpers plus the Phase 6 gate, which stays in the phase text |
| plan-token-reduction-rtk-ai.md | delete | withdrawn mechanism; the raw-fidelity brake is already in Decided 2026-09-11 |
| plan-workflow-modes-selective-loading.md | delete | illustrative sketch; backlog line under M1 and M6 |
| plan-role-configuration-governance.md | delete | stub; canonical copy already in history; nothing outside plans links the stub path |
| plan-safety-security-process-integrity.md | delete | stub; canonical copy in history |
| v05-context-os.md | delete | stub; canonical copy in history; `docs-copy.test.ts` forbids only the `docs/` path string |
| control-plane-memory-questionnaire.md | delete | stub; canonical copy in history |
| research-a2a-cross-host.md | move to plans/history/ | dated web-source evidence; dispositions absorbed |
| research-jev-system-one.md | move to plans/history/ | verdict and triggers absorbed into backlog |
| research-kxm-harness-strategy.md | move to plans/history/ | engine comparison evidence, behind trigger |
| research-memory-studio-forks.md | move to plans/history/ | seven-fork evidence |
| research-harness-streaming-capabilities.md | move to plans/history/ | dated CLI observations |
| research-runtime-language-choices.md | move to plans/history/ | L1 to L6 experiment definitions |
| research-additional-forks.md | move to plans/history/ | four-fork evidence |
| research-agent-producer-architecture.md | move to plans/history/ | open questions delegated to the harness strategy |

`plans/reviews/*.md`, all move to `plans/history/reviews/` keeping the subtree so the relative links from the moved research files still resolve: authentik-hosting-design-astra.md, intake-contract-astra.md, plan-consolidation.md, plan-set-reprioritization-astra.md, routing-rule-drift.md, fork-additions/{EverOS,WeKnora,archify,deepseek-harness}.md, memory-studio-forks/{agentic-inbox,agenticmail,OpenViking,dsh-web,reactive-resume,ruflo,yao}.md. Each is a critic record or fork review with provenance value and no remaining task.

**Sections of `implementation-plan.md` to replace, by heading:** front matter `updated`, `related`, `baseline_commit`; `### Related plans`; `### Decided`; `### Still open`; `## Phase 1: project configuration and initialization` migration paragraphs; `## Phase 8` gate status; `## Phase 10: web dashboard`; `## Phase 11` RBAC sentence; `## Cross-cutting test gates`. Keep `### Landed in this tree (unreleased)`, `### Plan hygiene`, and the two anchored headings verbatim.

**`related:` links that must change in files that remain.** `implementation-plan.md` front matter drops the eleven deleted or moved entries and points at `history/` copies of the eight research files, `history/plan-per-tenant-hosting.md`, `history/plan-cross-host-phase.md`, `history/plan-unified-kxm-milestones.md`, `history/plan-usage-cost-quota-tracking.md`; its body links to `reviews/plan-set-reprioritization-astra.md`, `reviews/authentik-hosting-design-astra.md`, `reviews/routing-rule-drift.md`, `reviews/intake-contract-astra.md`, `reviews/plan-consolidation.md`, `plan-per-tenant-hosting.md`, `plan-cross-host-phase.md`, `plan-unified-kxm-milestones.md`, `research-a2a-cross-host.md` and `history/2026-09-04-*.md` gain the `history/` prefix. In the moved research and review files, `implementation-plan.md` becomes `../implementation-plan.md`, `evidence/*.json` becomes `../evidence/*.json`, `../docs/...` becomes `../../docs/...`, and entries naming the four deleted thematic drafts are removed. No test enforces `related:` reciprocity, so these are hygiene, not gate breaks.

**`docs/` pages linking to moved or deleted plans:** none. A repo-wide grep outside `plans/` for the plan, research and review file names matched only `test/core/docs-copy.test.ts:18`, which forbids the string `docs/v05-context-os.md` and is unaffected. Pages that link to `implementation-plan.md` and must keep resolving: `docs/contracts/migration.md:5`, `docs/contracts/validation.md:122`, `docs/contracts/README.md:40`, `docs/contracts/synchronization.md:9` with the Phase 8 anchor, `docs/contributing/harness-routing-internals.md:6`, `AGENTS.md`, `CLAUDE.md:4`, `GEMINI.md:4`, `plugins/kxm/src/modes.ts:88`, `test/core/harness-run.test.ts:1774`.

## 8. Contradictions found

1. **Migrations.** Session D7 versus Decided 2026-09-20 "no migrations" and the deleted `kxm migrate`. Resolution: session wins; Phase 1 and `docs/contracts/migration.md` are rewritten in row 7 and the refusal codes stay for stores older than the supported floor.
2. **Public hub and cookies.** Session D6 versus ruling 3 "hub interprets no browser identity, cookie framework rejected" and the 2026-09-22 portal-only Studio at `studio.kxmd.dev`. Resolution: the session plan is the new written decision the ruling asked for; ruling 2, machine clients survive a browser outage, is carried into row 6 as its test.
3. **CI pause.** Session D1 versus the required Validate contexts in ruleset `22251971` and the 2026-09-23 three-minute gate. Resolution: tests pause, job names stay; the ruleset choice is pending decision 13.
4. **Writer model.** Session D2 `grok-4.7` versus `grok-4.6` in Decided, `roster.yaml`, `routes.yaml`, `prices.yaml`, `AGENTS.md:38` and `CLAUDE.md`. Resolution: row 2; without a `prices.yaml` row the new route settles `unknown` cost, so the row is part of the slice.
5. **Arch critic.** Commit `7561b5b` and `roster.yaml` name `opus-claude` as the required review-arch critic; `AGENTS.md:40`, `CLAUDE.md` and Decided 2026-09-06 still say Fable, and no Decided entry records the change. Resolution: the merged commit is newer than the prose; add the Decided entry and update both instruction files.
6. **Tenant roles versus hub RBAC.** Session D5 roles owner, admin, standard versus ruling 3 "no per-user RBAC in the hub" and Phase 11 "multi-user RBAC". Resolution applied: roles are enforced at Authentik and tenant config per D6, the hub authorizes bearers and service accounts; Phase 11 text is rewritten to say so **[transcribe the exact role semantics from the session file]**.
7. **Wiki.** "Unselected, needs a new decision" versus session D5 tenant VM with wiki. Resolution: compile is selected in row 5c; ingest stays unselected because nothing names it.
8. **Budgets.** "Post-MVP, do not implement" versus session D9. Resolution: row 8; rollover stays backlog.
9. **P1 status.** P1 carries no delivered mark while P2 and P5, which depend on it, are delivered. Resolution: P1 stays open as row 11; verify in the tree before scheduling rather than marking it done.
10. **Release state.** Still open says npm latest is 0.7.40 with tags 41 and 42 unreleased; Landed cites v0.7.92 and v0.7.93 shipped. Resolution: the release text is stale and dropped; only the tag question survives as pending decision 11. Registry state was not verified read-only.
11. **`gemini` catalog entry.** `AGENTS.md:99` says a deprecated `gemini` entry is kept; routing-rule-drift shows no such entry in `BUILTIN_HARNESSES`. Resolution: drop the sentence in the hand-maintained prose; re-adding it would be a dual-name shim.
12. **Test-file policy drift.** Cross-cutting gates forbid new test files per slice; Landed #314 added `gate-validation.test.ts` and `suggest.test.ts`. Resolution: the policy stands; the drift is recorded, not reversed.
13. **Session plan unreadable.** The priority-1 source could not be opened here, so the phase order, deliverable wording, H1 to H6 and each phase's named test in rows 1 to 8 and 14 are reconstructed from your summary and must be checked against the file before the writer applies this plan.

## Appendix: brief used to run this synthesis

# Task: synthesize ONE unified KXM plan from every open task across the plan set (read-only)

You are the KXM planner (Claude Fable, high effort). Work read-only in C:/projects/kxm with Read/Glob/Grep. Do not edit files. Put your entire deliverable in your final answer as markdown.

## Priority order (higher wins every conflict; cite the winning source per decision)
1. **Current session plan and decisions (2026-09-24)** in `plans/handoff/2026-09-24-session-handoff.md`. Its "Decisions" 1–9 and Phases 0–7 are authoritative. They cover:
   - CI test pause with a local WSL pipeline;
   - the grok-4.7 writer;
   - the Mesh cutover;
   - SQLite per tenant with a concurrency witness;
   - the tenant model (kxmd account; owner/admin/standard; tenant VM with hub+Runtime+Studio+wiki);
   - a public tenant hub through Authentik with per-machine service accounts and cookie + hub bearer;
   - migrations and staged upgrades;
   - central tenant config and provider OAuth;
   - an omp-style auth/usage broker, budgets.yaml and roster failover.
2. `plans/implementation-plan.md` → `## Tracking` → `### Decided`, newest first.
3. `plans/implementation-plan.md` → `### Still open`: the one queue S0–S5, P0–P6, recorded gaps, pending operator decisions Q-B…Q-K, D-1/D-2/A0, and routing/cost policy questions.
4. Every other active plan in `plans/*.md` and `plans/reviews/*.md`: plan-per-tenant-hosting, plan-cross-host-phase, plan-usage-cost-quota-tracking, plan-unified-kxm-milestones (M0–M9), plan-workflow-modes-selective-loading, plan-ssh-remote-execution, plan-token-reduction-rtk-ai, plan-additional-providers-agy-kimi, plan-agent-communication-steering, plan-role-configuration-governance, plan-safety-security-process-integrity, v05-context-os, control-plane-memory-questionnaire, the research-*.md files, and reviews/*.md.
5. `plans/history/**` is archive. Read it only to resolve provenance. Never revive a task from it unless a higher source still names it.

## What to produce (final answer, markdown, these sections in order)
1. **Authority.** One paragraph: the unified plan replaces every file listed under "Remove"; `AGENTS.md` keeps pointing at `plans/implementation-plan.md` as the single tracker.
2. **Decided (deduplicated).** Each entry has date, one-line decision and source file:section. Drop entries that a higher-priority decision supersedes, and list each drop in section 6 with the superseding source.
3. **Unified queue.** An ordered table of every still-actionable task across all sources, merged and deduplicated. Columns: `#`, Deliver, Source(s), Depends on, Trigger/unblocked by, Proof, One named test (or "deployment witness"/"none — docs"). The session plan's Phases 0–7 come first, in their order. Next come the remaining queue items that are not superseded (S5 interactive login witness, P0/P1/P4…). Then H1–H6 from the session plan's Phase 7. Then everything else, grouped by trigger. Merge duplicates, e.g. usage/quota tracking plus the budgets/failover work, or role governance plus roster failover.
4. **Backlog behind triggers.** Items with no current trigger, each naming its trigger in one line.
5. **Pending operator decisions.** Only decisions that no higher source answers. Give each 2–3 options and a recommended default.
6. **Removed.** Every task, decision or plan section you dropped, with the reason: done/landed (cite the Landed entry or commit), superseded (cite the source), contradicted by the session decisions, or out of product scope.
7. **File actions.** For every file in `plans/*.md` and `plans/reviews/*.md`, give exactly one of:
   - `keep` (only `implementation-plan.md`, which receives the unified content);
   - `move to plans/history/` (research or reviews worth keeping as provenance);
   - `delete` (fully absorbed, no provenance value).

   Also list the `implementation-plan.md` sections to replace, by heading, and the front-matter `related:` links that must change in the files that remain. Name `docs/` pages that link to moved or deleted plans (grep for the links) so link lint does not break.
8. **Contradictions found.** Any conflict between sources not already settled by priority, with the resolution you applied.

## Rules
- Verify "landed/done" claims against `### Landed in this tree` and `git log`, which you can read through Grep of CHANGELOG.md and plans. Do not mark something done that you cannot cite.
- KXM naming only. No Mesh aliases. Work is not backwards-compatible.
- Do not invent new features. Every queue row must trace to a source.
- Be exhaustive over sources and concise per row.


---
schema: "kxm.doc.v1"
id: "PLAN-PYTHON-MIGRATION"
type: "architecture"
title: "KXM central platform and Python migration proposal"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-25"
updated: "2026-09-25"
authority: "hypothesis"
confidence: "medium"
summary: "Proposed TypeScript-to-Python migration, central platform target, parity gates and project cutover; delivery authority stays in the active implementation tracker."
tags: ["migration", "python", "studio", "runtime"]
related:
  - implementation-plan.md
  - research-runtime-language-choices.md
  - plan-per-tenant-hosting.md
depends_on: []
blocked_by: []
details:
  describes: "proposed"
---

# KXM — migration project plan

Read [the execution tracker](implementation-plan.md) first. MG0–MG8 describe a proposed route and acceptance gates; they are not a second execution queue. Selected slices, owner, trigger and actual status belong in Tracking.

**Prepared:** 2026-09-25

**Status:** Proposed Python migration plan; tracked as a proposed successor in the KXM repository

**Target contract:** The product requirements in §1 and the Python architecture in §3 govern this plan. Earlier TypeScript architecture drafts do not define this migration's implementation stack.
**Inspected source:** [`kontextmind/kxm`, `6d68e201332bf908667e1d0af8673df4e8e8343e`](https://github.com/kontextmind/kxm/tree/6d68e201332bf908667e1d0af8673df4e8e8343e), package version 0.7.1. Remote HEAD matched this revision during the review.

## 1. Migration objective and strategy

Reach a Python implementation of the central KXM platform: personal/org tenants, projects with one or multiple repositories, role defaults/fallbacks with account quotas, task-specific agents, guided workflows with required gates, hosted runners, Studio steering and evaluated automatic improvement. Convert the current TypeScript/Node product code, CLI and runner to Python in phases. Keep the browser Studio in TypeScript/React and retain the native Pi/Claude/Codex and other provider CLIs behind Python subprocess adapters; converting KXM does not rewrite those external harnesses.

**Recommended approach:** build the Python control plane alongside the TypeScript KXM installation; connect existing installations through a constrained TypeScript compatibility adapter; port behavior behind language-neutral contracts and fixtures; import definitions/history with provenance; route new runs to Python workers per project; let existing runs complete under their original owner; retire legacy TypeScript executables and write paths after acceptance. Preserve KXM's proven harness behavior, evidence, context and process recovery through tests and semantic ports. New Python modules do not import or execute TypeScript domain logic once their wave is cut over.

Historical runs stay historical. Do not manufacture Temporal history from old SQLite rows or rewrite old evidence into new approval records. There is always one execution owner for a given run and one publish authority for a given definition. In a pilot, keep the old installation recoverable; do not dual-execute a mutation to compare behavior.

### New decisions this migration deliberately introduces

| Previous source decision | Requested target | Required implementation change |
| --- | --- | --- |
| SQLite is authoritative per tenant box; no PostgreSQL write path | Central PostgreSQL product state with explicit tenant/project/VM ownership | Central schema, authorization, import, read-model ownership and backup contracts. |
| Local Runtime and hub workflow engines have distinct run families | Temporal owns new workflows; old engines own their existing runs | Engine-qualified run references and a dispatch registry; safe drain/cutover. |
| Agents carry model/harness instructions; several role/config surfaces coexist | Agent = system prompt/task contract bound to a role; role owns default and fallback policy | Explicit role binding and precedence resolution during import. |
| Reviewed step graph and fixed transitions | Guided plans with required/optional/conditional phases and gates | Graph interpreter, plan revision validator and gate equivalence proof. |
| Learning proposes; published changes use existing manual/Git gates | Automated creation, evaluation, canary, activation and demotion within configured policy | Versioned automation grants, evaluations, audit, kill switch and rollback. |
| Browser identity lives at edge/portal; hub machine tokens remain local | Authentik identifies user/runner; central API enforces KXM membership and resource permissions | New central API authorization and a constrained legacy adapter. |
| TypeScript/Node owns KXM CLI, hub, Runtime, extension and tool surfaces | Python owns KXM product services, worker, host runner and CLI | Port behavior with frozen fixtures; maintain thin native host adapters during transition; retire the Node distribution only after replacement is usable. |

These are proposed successor decisions, not a claim that deployed KXM has already converted. The repository tracker records this plan as proposed scope; activation requires a selected implementation slice and its normal acceptance gates. Where old policy conflicts with a subsequently accepted Python slice, update the active tracker and affected docs in the same implementation change. No deployment has been changed.

## 2. Evidence-backed baseline

The current checkout was inspected read-only. Tests were not run for this planning task. Statements below describe source or project documentation, not a new live deployment audit.

| Surface | Evidence in this revision | Treatment |
| --- | --- | --- |
| Package and integrations | `package.json`; `plugins/kxm/src/extension.ts`, `mcp-server.ts`, `client.ts`, `harness.ts`; Pi extension, Claude plugin and CLI | Preserve client surfaces behind an adapter; reuse harness discovery/auth code after contract tests. |
| Hub storage | `plugins/kxm/src/store.ts`: schema **5**, synchronous SQLite, HTTP/SSE coordination | Read/import via version-specific code. Do not mechanically change a driver and call it a Postgres migration. |
| Runtime storage | `runtime-store.ts`: registry **1**, event store **7**, run events, receipts, gate evidence and outbox | Preserve event hashes, ordering, identity and source version. Retain raw archives. |
| Execution | `engine.ts`, `engine-compile.ts`, `runtime-supervisor.ts`, `pi-producer.ts`, `oneshot-producer.ts`, `external-effects.ts` | Keep gate/effect semantics and child-process findings; transition scheduling to Temporal only for new-owned runs. |
| Current definitions | `schemas/project.schema.json`, `agent.schema.json`, `model.schema.json`, `role.schema.json`, `workflow.schema.json` | Project already supports repository arrays; agent v1 has instructions/model/harness but no required role reference. Convert deliberately. |
| Routing and usage | `routing.ts`, model schemas, `docs/reference/harness-routing.md`, active plan | Existing reporting/auth checks are reusable. Central subscription reservations and fallback policy need new implementation. |
| Peer traffic and sync | Hub peer messages, `sync-transform.ts`, Runtime outbox; `docs/operations/runtime-sync.md` | Reuse durable-ID, cursor, bounded-payload and refusal patterns; bridge messages without recursive redispatch. |
| Memory and skills | `memory.ts`, `context.ts`, `dispatch-context.ts`, `skills.ts`, `improve.ts`, `wiki.ts` | Import provenance/lifecycle; rebuild indexes; keep verified active revisions separate from candidates. |
| Portal and VM platform | KXM tracker reports S2/S4 changes across `kxmd-portal` and `dev-vm-platform`; `tenant-status.ts` exposes current read surface | Their repositories/deployed configuration were not inspected here. Inventory and API contract checks are MG0 work. |
| Source deployment evidence | Tracker records systemd services, Authentik/Caddy edge and live witnesses; second physical-box and interactive auth witnesses remain partly open | Repeat relevant witnesses on the migration environment; documentation evidence is not a guarantee that every deployed box matches HEAD. |

### Existing gaps that matter during migration

1. The architecture guide, old phase prose and later tracker corrections do not always describe the same implementation state. Use code + the latest dated tracker correction + a new witness; never infer support solely from a schema enum.
2. The memory guide documents that a shared hub can attach one checkout's memory/skills to multiple projects, and that the default authored-memory path is wrong for the hub. Treat source ownership as unresolved during import where provenance is insufficient. Do not put such records into tenant-wide memory automatically.
3. Hub workflow journals and Runtime improvement inputs are separate. `kxm_workflow_record` does not become a Runtime journal simply because the new UI presents one timeline.
4. The standalone Studio surface and the portal's delivered command path differ. Tracker describes the hosted portal's create/drive/cancel as simulated-only; existing mapping or acceptance is not evidence that a live model executed. New Studio must expose execution mode and show actual receipts.
5. `kxm backup` does not capture every configuration, artifact, binding and custom state path. Source documentation identifies six roots and a relocated-hub discovery gap. Archive the entire identified state set and verify a restore before importing or cutting over.

## 3. Target reuse and replacement map

| Capability | Reuse | New/replaced responsibility |
| --- | --- | --- |
| Pi/native harness execution | Auth probes, exact model checks, structured outcome parsing, isolated sessions and known process cleanup fixes as behavioral fixtures | Python subprocess/RPC adapters, host runner assignment API, capability registry and central account reservation contract. |
| Tools/MCP/CLI | Tool meaning and bounded inputs/outputs | Python `kxm` CLI and MCP server with central identity, project selection, idempotency and versioned commands. Temporary TypeScript client mode is explicit and removable. |
| Context | Budgeting, provenance and evidence selection algorithms as test cases | Python context service with tenant/project/repository-scoped storage, explicit role IDs, central revisions and retrieval audit. |
| Memory/wiki/skills | Authored content, source hashes, valid evaluation receipts and artifact lineage | Python knowledge service, derived wiki correctness and automatic activation/demotion policy. |
| Receipts and external effects | Exact-input evidence, uncertain-effect states and lease/fencing lessons | Target effect gateway must enforce those conditions where writes actually occur. A database lease alone cannot stop a stale external writer. |
| Existing workflow engine | Legacy run drain and historical interpretation | Temporal Python SDK plan interpreter for newly created target-owned runs. |
| SQLite databases | Immutable source archives, read-only history and local runner spool | PostgreSQL central product state; separate Temporal persistence. |
| Hosted infrastructure | Reusable VM templates, edge identity and provisioning integration after audit | Central tenant registry, machine enrollment, desired configuration and Studio operations. |

Use a Python workspace for `kxm-core`, `kxm-api`, `kxm-workflows`, `kxm-runner`, `kxm-cli`, `kxm-mcp` and importers; retain a separate React/TypeScript Studio. Use `pyproject.toml` and a committed `uv.lock`, pinned Python and reproducible builds. Publish typed OpenAPI/JSON Schema contracts and generate the Studio client; fixture tests compare serialized wire messages, error codes and outcomes across TypeScript and Python. Extract reusable **contracts and test cases** before porting behavior, not a permanent Node subprocess dependency. Keep legacy build/distribution intact until consumers switch; constrain all old-engine calls to one compatibility boundary.

### Python target architecture and language exit

| Surface | Python target | Conversion boundary |
| --- | --- | --- |
| API and identity | FastAPI/Pydantic request validation; explicit tenant/project authorization in service layer; PostgreSQL transactions, outbox and SSE | Existing Node hub remains loopback behind a scoped bridge until per-project admission moves. |
| Workflow and schedules | Temporal Python SDK workflow interpreter with immutable accepted plans, signals/updates and activities for I/O and model calls | Never replay legacy TypeScript histories as Python Temporal histories. Pin Python worker versions and test replay before upgrading live runs. |
| Agent runner | Python process supervisor, local SQLite spool, bounded artifact upload, per-attempt idempotency and outbound connection | Python adapter launches installed provider-native binaries; prove RPC streaming, cancellation, restart and process-tree cleanup on supported hosts. |
| CLI and MCP | Python package exposes the `kxm` command and an MCP surface; thin Pi/Claude host integrations call the versioned API/CLI | Replace each Node entrypoint only when equivalent auth, response framing and exit behavior pass consumer tests. |
| Context and improvement | Python services port retrieval, provenance, evaluation and revision publication | Bring over source content and verifiable observations; preserve uncertainty instead of synthesizing evidence. |
| Studio | React/TypeScript browser client generated from Python API contracts | Browser JavaScript is a deliberate language boundary; no business authorization or workflow decisions live there. |

Before the first Python deployment, build a **parity corpus** from real redacted requests and deterministic fixtures: role resolution, route admission, gate/effect decisions, receipt hashes, workflow commands, SSE ordering, crash/restart, `kxm` JSON/text/exit codes, and Pi RPC lifecycle. Measure startup, resident memory and throughput of the Python runner against the same task mix; tune concurrency and offload blocking subprocess/database work when measurements justify it. Reject a slice when its Python result changes a permission, receipt, or paid route without an approved contract change. Maintain one published `kxm` user entry point; make the package/installer switch explicit and reversible until old clients retire.

## 4. Data and definition conversion

All imports produce a manifest: source installation and schema, source path/table/key, source hash, target tenant/project/ID, converter version, status, warnings and resulting revision hash. Deterministic namespaced IDs prevent collisions between boxes with identical local names. Dry-run reports show unmapped records. Rerunning the same manifest is idempotent; changed source bytes produce a new revision or a conflict, never silent overwrite.

| Source | Target mapping | Checks |
| --- | --- | --- |
| Local project / hosting tenant label | Explicit personal/org Tenant and Project; source-installation mapping | Confirm ownership/memberships from real records. Names and directory paths do not establish tenant identity. |
| `project.yaml`, repository definitions/bindings | ProjectRepository plus per-host CheckoutBinding | Normalize remote identity, retain control/member intent, pin commit; confirm every required repo exists; never treat `pathHint` as proof. |
| `agents/*.yaml` instructions/purpose/model/harness | AgentDefinition + system-prompt revision + explicit RoleDefinition binding | Preserve effective permissions. If no role is authoritative, produce a proposed mapping; avoid inferring authority from an agent name. |
| Models, roles, roster, routes and user-level config | ModelRoute, Role routing policy, ProviderAccount grant | Preserve effective route admissions and priority. Resolve project/global conflicts in a report. A stored fallback field does not prove live fallback behavior. |
| Workflow steps/transitions and gates | Imported locked plan template plus equivalent gate obligations in the new interpreter | Keep the existing graph during the first parity run. Enable guided adaptation after obligation and evidence checks pass; no new separate strict engine. |
| Hub messages/workflow journal | Engine-qualified historical message/run views | Preserve origin, caller, reply evidence, timestamps and retention gaps. Imported history cannot authorize new actions. |
| Runtime events/receipts | Legacy run archive and query projection | Verify receipts against original bytes; store transformed views separately. Do not create new Temporal histories from imported rows. |
| Authored memory and context pool | Scoped KnowledgeAsset revisions and evidence links | Preserve authority/contradictions; ambiguous project attribution goes to a review queue; embeddings/indexes are rebuilt. |
| Promoted/candidate/quarantined skills | Same lifecycle in central registry | Verify content hash and evaluation lineage. Candidate records never become active by import. |
| Usage/telemetry | Provenance-tagged observations | Preserve unknown/unmetered classifications; do not reconstruct exact subscription balances from token counts. |
| Secret references, SSH config and host bindings | Credential references and enrolled hosts | Re-enroll/rotate credentials. Never import broad admin tokens into definition JSON, model prompts or general history. |

**Automation policy transition:** imported active skills/prompts begin pinned. Existing proposals remain candidates. First run the new evaluation loop in shadow; then activate automatic creation/quarantine, and finally approved classes of canary/promotion. This sequence enables the requested automation while proving it does not accidentally promote legacy candidates or cross tenant boundaries.

## 5. Engine ownership and active work

Represent each run as `{tenant, project, runId, engineOwner, sourceInstallation, definitionRevision}`. Commands route by that record. Old ID formatting is not an engine discriminator.

| Run state at cutover | Handling |
| --- | --- |
| Terminal legacy run | Import archive/projection; do not replay actions. |
| Running legacy run | Keep its engine and workspace alive; drain there; show its state in central Studio through the bridge. |
| Legacy wait or pending approval | Continue under the original engine until completion; or deliberately cancel and create a linked successor with explicit unfinished work. Old approvals do not automatically transfer. |
| Unknown external effect | Investigate the target system and record reconciliation before any retry or transfer. |
| New run after project cutover | Temporal interpreter owns all transitions; host runner owns attempts. |

The bridge can submit a legacy command and poll its stable identity. A retry of the bridge must reconnect to that identity, not start the old workflow again. If Temporal waits for legacy completion during a transition phase, it observes an opaque legacy-owned run; it cannot independently reschedule its stages. Shared target effects need one fencing/serialization authority during coexistence. If both systems cannot honor one authority, drain legacy writers before enabling new writes on that target.

Do not hot-migrate live Pi/Claude conversations between engines as an initial feature. A new attempt can use a bounded handoff packet and repository/artifact snapshot. Record lost session context or unsupported steering explicitly.

## 6. Migration waves

Work ownership lanes: **A platform/import**, **B runner/routing**, **C Studio/identity**, **D knowledge/evaluation**. These are planning lanes; no agents or production jobs were launched for this document.

| Wave | Work items | Dependencies | Owner | Completion gate / rollback |
| --- | --- | --- | --- | --- |
| MG0 Baseline and recovery | Record exact deployed versions/config; inspect portal/VM repos; enumerate six state roots; inventory account routes, native plugin consumers and open runs; encrypted archive and restore witness; build redacted TS/Python parity corpus | — | A + C | Restored clone yields matching IDs/receipts/config hashes; corpus captures the current wire and subprocess contracts. Stop if completeness is unknown. |
| MG1 Python foundation, registry and identity | Create uv Python workspace, schema/OpenAPI contract, Python API/auth layer, personal/org tenants, memberships, project/repo mapping, Authentik user/runner login; deploy isolated PostgreSQL/Temporal/object storage | MG0 | A + C | Python API denies cross-tenant/VM requests; published revision round trip and regenerated Studio client pass. Central registration can be removed without touching source state. |
| MG2 Python importers and read-only Studio | Versioned Python SQLite importers, manifests, legacy engine-qualified timeline, definition previews, sync lag/refusal states, artifact links | MG1 | A + C | Counts/hashes reconcile per table and source; duplicate/conflict handling matches fixtures; source fields retain provenance. Roll back rebuildable projections. |
| MG3 TypeScript bridge and Python runner | Constrained TypeScript adapter to existing hub/Runtime; Python outbound runner, harness subprocess adapters, host/SSH enrollment; Python CLI and MCP client commands use the same Studio API contract | MG1–MG2 | B + C | Duplicate ticket produces one legacy action; auth refusal, stream/cancel, process cleanup and CLI output match parity corpus. Drain bridge commands before disabling it. |
| MG4 Python Temporal pilot and role routing | Python interpreter: convert one read-only guide then bounded write guide; role/agent split; frozen graph parity; quotas/fallbacks; required gates; model/run outcome receipts | MG3 | A + B | Python worker restart/replay, effect/fallback and read-only shadow comparisons pass. Stop new admissions and drain pilot to return to old start path. |
| MG5 Python guided plans, multi-repo and schedules | Port adaptive phases after parity; multi-repo bundle; schedule ownership; resident agent lifecycle; central steering; VM updates | MG4 | B + C | Replan cannot drop required gate; partial multi-repo publication is recoverable; no duplicate schedule fires. Disable new starts on failure. |
| MG6 Python knowledge and improvement | Python provenance import, per-project retrieval, wiki, shadow evaluations, skill/prompt creation, canary and demotion, policy-scoped automatic activation | MG2 + MG4, representative records | D + C | Cross-tenant recall rejected; corrupt/ambiguous source excluded; a controlled regression rolls back an active candidate. Freeze learning and restore publish pointers if needed. |
| MG7 Project and package cutover | Drain or retain legacy runs; switch new-run route once per project; switch CLI/MCP/package consumers to Python only after parity; verify event lag, auth/usage, artifacts, schedules and VM recovery; remove source publish authority | MG5–MG6 | All | Acceptance checklist below; reversible admission and installer switch until legacy retirement. Never restore old DB over new effects. |
| MG8 Node runtime retirement | Archive legacy state/readers; remove old token grants, schedulers, temporary TypeScript bridge and replaced Node entrypoints; update docs/CI/distribution; test Python stack disaster recovery | MG7 + agreed observation period | A + B + C | No active legacy run/wait/unreconciled effect/definition writer or required Node-only consumer remains; Python install/upgrade/rollback and archive retrieval proven. |

**Pilot project selection:** begin with a personal tenant, one repo, one VM, one tested model route and a non-destructive workflow. Then add an org tenant with two users, two repos, two runners and a finite provider budget. Verify that this second case exercises real tenancy and concurrent quota allocation, rather than adding a second label to the same identity.

MG1 and MG2 can proceed while MG3's runner adapter is built. Knowledge ownership discovery begins in MG0; automated activation waits for MG6. The greenfield plan's product requirements remain useful, but the language/packaging implementation and milestone acceptance for this migration live here.

## 7. Cutover procedure for a project

1. Verify source/target manifest, schema versions, repo-set baselines and restore evidence. Reconcile source updates since the last import using a per-source cursor or a bounded write freeze; never assume one central timestamp orders events across boxes.
2. Freeze definition publication briefly and stop legacy schedule creation/starts for the project. Record active runs, waits, pending commands and possible external effects. Do not stop healthy active work merely to simplify an import.
3. Import final definition deltas and history high-water marks; compare hashes and unresolved mapping counts. Transfer publish authority once, with an explicit source revision.
4. Switch the new-run admission route to Temporal with a control-plane compare-and-swap. Existing runs keep their owner. A repeated cutover request returns the same result.
5. Enable the target schedule only after recording its last processed fire and overlap/catch-up policy; use a stable scheduled-occurrence key to prevent a source/target duplicate.
6. Run the project witness: create → plan → execute → steer → verify → complete, with required gates, known route and traceable usage. Check SSE reconnect, artifact authorization and a denied wrong-project request.
7. Observe for at least one relevant schedule/usage reset cycle and enough representative successful/failed work to exercise recovery. The operator chooses the observation duration from actual workload frequency.
8. Disable temporary source start/publish permissions; retain read-only history and any still-owned active runs until retirement criteria hold.

**Rollback:** stop target admissions and schedules; reconcile in-flight target effects; leave their records under the target engine; resume old starts only for operations the old system still supports and only after refreshing its approved definitions. New guided plans or evolved definitions may have no lossless legacy representation; keep those projects paused or forward-fix rather than silently downgrade. Backups restore data, not already completed Git pushes, deployments or emails. Reversing an external effect is its own authorized recovery action.

## 8. Acceptance matrix

| Risk | Required witness |
| --- | --- |
| Definition mapping changes behavior | Same inputs, permissions and gate obligations under frozen imported plan; record allowed differences before guided execution. |
| Tenant/project leak | Wrong-tenant API, SSE, artifact URL, memory query and host assignment all fail; multi-project retrieval returns only scoped source records. |
| Privileged bridge becomes an admin proxy | Central caller cannot choose arbitrary host/path, bypass project binding, supply shell text, or reuse another command's grant. |
| Duplicate dispatch / sync | Repeat intake/bridge/outbox under restart; one authoritative attempt/effect identity, ordered projection, conflicts visibly refused. |
| Stale lease after a partition | Old writer is denied at the effect boundary; unknown results are parked; no automatic destructive retry. |
| Misleading Studio success | Actual execution mode and terminal receipt match the displayed result; mapped/simulated/accepted never imply live completion. |
| Quota exhausted or missing | Correct account bucket/cooldown; another host sees reservations; fallback respects scope, capabilities and paid-spend policy. |
| Dynamic plan bypass | Required-gate removal, stale revision and invalid condition evidence are rejected; input-changing edits invalidate old gate receipts. |
| Learning regresses behavior | Candidate evaluation and policy log exist; rollback/quarantine works; active runs keep their pins; no permission growth. |
| Incomplete backup | Restore relocated hub store, registry, event stores/prompts, definitions, bindings and artifacts from discovered paths; verify source identities. |
| Legacy retirement loses control | No active run, wait, command, schedule owner or unknown effect references the retired writer. |
| Language conversion changes a contract | Redacted TypeScript/Python fixtures cover CLI/MCP/API codes and envelopes, auth refusals, provider route choice, receipt bytes, runner process tree, and streaming; divergences are reviewed before cutover. |
| Python worker upgrade strands long-running work | Replay recorded Temporal histories against the new worker, pin compatible worker versions, test continue-as-new and live cancellation/resume before retiring an older worker. |
| Python package replaces Node while native integrations still expect it | Install/upgrade/downgrade witness on every supported platform; thin host integration speaks the published Python CLI/API; no Node-only consumer remains at MG8. |

Use existing KXM tests as semantic regression fixtures where reusable; add focused cross-service tests for new ownership boundaries. Run the repository's required gates for implementation changes. This planning deliverable only received document/schema-example and source-reference checks; it has not passed product acceptance.

## 9. Authentik, SSH CA and 1Password choice

Keep Authentik for user and machine identity. Introduce project/VM authorization in the central KXM API and prove it independently of the current edge's group check. The legacy adapter retains local credentials privately, records the real actor, and accepts only signed/scoped command tickets. Do not expose the existing supervisor on the network or translate every tenant user into unrestricted hub admin access.

**Recommended default with 1Password:** use Smallstep `step-ca` for SSH user/host certificates and Authentik OIDC for human authentication. Configure automated runner issuance with a separately scoped machine provisioner; browser login is not unattended enrollment. If central dynamic machine secrets are a launch requirement, select **OpenBao** instead to combine secrets management and SSH signing. If an operational Vault already exists, validate and reuse it rather than deploying a second signer. **Teleport** is the broader access-proxy/session-audit option; its generic OIDC integration currently requires Enterprise.

KXM still owns project/VM/effect authorization; a valid Authentik token does not by itself authorize every SSH principal. Use separate user/host CA trust, controlled principals, short certificate lifetime, host-key verification and a tested renewal/rotation path. A CA certificate commonly grants an account/principal, not arbitrary per-command policy; enforce narrow commands through server configuration or a runner/effect gateway. Immediate session revocation needs a separate termination mechanism.

CA evaluation witness: Authentik user obtains an allowed certificate; wrong tenant/VM/principal is denied; a headless runner enrolls without a human token; host impersonation is rejected; rotation retains authorized availability; removal blocks new issuance and demonstrates the defined active-session behavior. Deploy the signer only after choosing and testing that integration.

## 10. Work sizing and remaining discovery

The target features and a genuine TypeScript-to-Python port must still be built. Prior **24–40 engineering-week** planning allowance assumed a TypeScript target and does not apply unchanged. Allow **18–30 engineering-weeks** for the central product and **12–20 additional engineering-weeks** for Python contract ports, native integrations, data conversion, dual operation, cutover and retirement: **30–50 engineering-weeks** total, with overlap and substantial uncertainty. This is a capacity estimate, not a delivery date or promised saving from Python. Re-estimate after MG0's parity inventory and MG4's pilot; source ownership, history volume, platform support and unsupported harness recovery can dominate.

Remaining discovery is explicit: actual VM/portal source and deployed versions; customer/tenant/account ownership; retained data volumes; shared-memory provenance; live provider quota signals; real custom state paths; fleet platform mix; Python runtime compatibility with native harnesses and Pi extension entry points; CA/secret-service availability; active schedules and unresolved effects. No passwords, SSH keys or live customer records were read during this planning task.

## Source references

All KXM links below pin the inspected revision. Source documentation can describe goals or historical status; migration witnesses must verify the selected behavior.

- [Active plan and dated corrections](https://github.com/kontextmind/kxm/blob/6d68e201332bf908667e1d0af8673df4e8e8343e/plans/implementation-plan.md)
- [Architecture](https://github.com/kontextmind/kxm/blob/6d68e201332bf908667e1d0af8673df4e8e8343e/docs/concepts/architecture.md)
- [Hub schema](https://github.com/kontextmind/kxm/blob/6d68e201332bf908667e1d0af8673df4e8e8343e/plugins/kxm/src/store.ts), [Runtime schema and receipts](https://github.com/kontextmind/kxm/blob/6d68e201332bf908667e1d0af8673df4e8e8343e/plugins/kxm/src/runtime-store.ts)
- [Project schema](https://github.com/kontextmind/kxm/blob/6d68e201332bf908667e1d0af8673df4e8e8343e/schemas/project.schema.json), [agent schema](https://github.com/kontextmind/kxm/blob/6d68e201332bf908667e1d0af8673df4e8e8343e/schemas/agent.schema.json), [role schema](https://github.com/kontextmind/kxm/blob/6d68e201332bf908667e1d0af8673df4e8e8343e/schemas/role.schema.json)
- [Backup coverage and six roots](https://github.com/kontextmind/kxm/blob/6d68e201332bf908667e1d0af8673df4e8e8343e/docs/operations/backup-and-restore.md)
- [Context/memory behavior and documented gaps](https://github.com/kontextmind/kxm/blob/6d68e201332bf908667e1d0af8673df4e8e8343e/docs/guides/context-and-memory.md)
- [Current improvement loop](https://github.com/kontextmind/kxm/blob/6d68e201332bf908667e1d0af8673df4e8e8343e/docs/guides/continuous-improvement.md)
- [uv projects and lockfiles](https://docs.astral.sh/uv/guides/projects/), [FastAPI ASGI deployment](https://fastapi.tiangolo.com/deployment/manually/), [Temporal Python workflows](https://docs.temporal.io/develop/python/workflows), [Python workflow sandbox](https://docs.temporal.io/develop/python/best-practices/python-sdk-sandbox), [replay testing](https://docs.temporal.io/develop/python/best-practices/testing-suite) and [worker versioning](https://docs.temporal.io/develop/python/workflows/versioning)
- [Smallstep SSH CA](https://smallstep.com/docs/tutorials/ssh-certificate-login/), [provisioners](https://smallstep.com/docs/step-ca/provisioners/), [OpenBao SSH signing](https://openbao.org/docs/secrets/ssh/signed-ssh-certificates/), [JWT/OIDC auth](https://openbao.org/docs/auth/jwt/), [Vault SSH signing](https://developer.hashicorp.com/vault/docs/secrets/ssh/signed-ssh-certificates), [Teleport OIDC](https://goteleport.com/docs/zero-trust-access/sso/integrate-idp/oidc/)

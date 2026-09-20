---
schema: "kxm.doc.v1"
id: "REVIEW-PLAN-SET-REPRIORITIZATION-ASTRA"
type: "architecture"
title: "Codex gpt-6-astra pass: reprioritize the whole plan set for a fast, light hosted MVP"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-20"
updated: "2026-09-20"
authority: "hypothesis"
confidence: "medium"
summary: "Corpus-wide replan: one S0-S5 queue plus eight triggered post-MVP steps, twelve named contradictions resolved with the exact edit each requires, a per-document keep/merge/split/demote/archive disposition for all 19 plans, a PostgreSQL ruling backed by per-file call-site counts, the cuts with their backlog homes, and three fast-move risks with cheap mitigations. Design input and critic opinion; Tracking holds execution authority."
tags: ["review", "plans", "hosting", "auth", "mvp", "prioritization"]
related:
  - ../implementation-plan.md
  - ../plan-unified-kxm-milestones.md
  - ../plan-per-tenant-hosting.md
  - ./authentik-hosting-design-astra.md
depends_on: []
blocked_by: []
details:
  transport: "codex exec -s read-only -m gpt-6-astra -c model_reasoning_effort=high"
  reviewed_commit: "6d9aa5f"
  model: "gpt-6-astra (ChatGPT auth, unmetered)"
---

# Codex gpt-6-astra pass — reprioritize the plan set for a fast hosted MVP

Full transcript, preserved as produced. Citations inside it use commit `6d9aa5f`, which was
the tracker at inspection time; the tracker has moved since, so line numbers may be offset by
the hosting entries that landed in `6136bca`. What was accepted from it and what was corrected
is recorded in Tracking; this file is the reasoning and the evidence.

Three things it found are worth stating because they are the opposite of how this slice began.
**It deleted most of the hosting draft written an hour earlier**: the hub-side browser
authentication subsystem, five `kxm hub auth` verbs, viewer/admin capability mapping and the
`kxm hub footprint` command all became out of scope once the portal, not the hub, was treated
as the browser boundary. It also corrected my own storage counts in that draft — the real
figure is **23 distinct literal `CREATE TABLE` targets** across hub, registry, event-store and
external-effects tables, not 15, and **105 prepared-statement call sites plus 41 `exec` calls
in the five coupled files**, with `registry.db`, per-project `run-events.db` and prompt
sidecars outside `kxm.db` entirely. And it refused two of my framing claims: the hub **is** an
additional supervised service on the box, even though it is not an additional VM; and
"one box per tenant means nothing can leak" was replaced by the honest statement that separate
boxes reduce blast radius without preventing a portal from selecting the wrong credential.

## The brief it was given

```markdown
# Planning brief — reprioritize the whole KXM plan set for a fast, light MVP

You are re-planning, not critiquing code. Deliver a plan structure I can execute.

Repository: KXM (`/Users/eddieflores/source/clients/kxm`), read-only for you. The sole
execution tracker is `plans/implementation-plan.md` (phase gates + **Tracking** + **Still
open**); `plans/plan-unified-kxm-milestones.md` is the consolidated *proposed* M0–M9 catalog.
Everything else in `plans/` is a technical reference, a research report, or a stub. Read the
frontmatter `summary:` of each `plans/*.md` before proposing changes to it.

## Operator constraints, in priority order

1. **A working MVP, quickly.** It gets used immediately, and improvements come from use.
   Anything that delays first useful deployment is wrong by construction.
2. **Keep it simple. Do not over-architect. Do not over-test.** Pipelines stay quick and
   slim: the existing `npm run verify` commit gate and the existing CI legs are the whole
   gate surface. New npm scripts, new CI jobs, and broad new test files are **not** wanted;
   each slice may add at most one focused named test.
3. **Hardening goes to a backlog**, not into the critical path. Say so per item.
4. **Merging or splitting plans is allowed and expected** where it removes duplication or
   contradiction. No second execution tracker, ever.
5. Recent product decisions that must be reflected everywhere they touch:
   - **One tenant = one hub = one VM/box.** Hub and portal are co-located; the portal reaches
     the hub over loopback. Tenancy is the machine, not a hub table.
   - **Hosting is optional.** Today's static-token auth (`KXM_AUTH_TOKEN`,
     `KXM_PROJECT_TOKENS`, generated-and-persisted token) is the default and must keep working
     untouched for anyone not deploying hosting.
   - **Authentik sits at the edge** and owns browser sessions; the hub does not acquire users,
     sessions, cookies, or an OIDC login flow.
   - **The hub must not count as another VM** in capacity planning: it is incremental
     **disk + bandwidth** on a box that is already provisioned.
   - **Open question I need decided, not hedged:** the operator has floated putting the hub's
     state in **PostgreSQL on a shared server (`kxm-dev-svr`)**, either one multi-tenant
     database or one database per hub. Decide, and state it as: what happens now, what happens
     later, and what the trigger and cost of "later" is. Ground it in what is actually in this
     repository — count the real coupling before you answer (see
     `plugins/kxm/src/sqlite.ts`, `database.ts`, `runtime-store.ts`, `store.ts`,
     `local-snapshot.ts`, the `VACUUM INTO` backup/restore path, and the event-store schema
     that is already at v5 with a v6 slice pending). If your answer is "not now", name the
     smallest thing the portal can do instead to get cross-hub visibility, and say what breaks
     if the operator refuses that answer.

## What to produce

### 1. The MVP, cut honestly

Name the shortest sequence of changes that yields a hosted tenant hub an operator can actually
use: hub running on the tenant box, admin reachable, portal able to show and drive real state,
Authentik gating the browser, token auth unchanged for local users. Give it as ordered slices
with: files touched, the one named test (or "no new test, existing gate covers it"), event-store
schema impact (**target zero**), and whether it is hub-only / CLI-only / UI-only. Mark each
slice **MVP** or **post-MVP**. Post-MVP means it ships after we have used it.

### 2. What you cut, and where it goes

A table: item → cut reason → backlog home (`Still open`, a named phase gate, or "do not plan
it"). Be decisive about things that are currently written as if they were near-term.

### 3. Plan-set operations

For every `plans/*.md`: **keep as-is / merge into X / split / demote to reference / archive
with stub**. Use the repo's existing convention (archived records live in `plans/history/` and
a stub remains at the old path). Call out duplicates and overlapping authority explicitly — if
two documents both claim scope for the same thing, say which one wins and what text has to
change in the loser.

### 4. Contradictions, resolved

Find the real conflicts across the plan set — including against the newest decisions above,
against `AGENTS.md` (which is a generated artifact and must be regenerated, not hand-edited),
and inside `plans/implementation-plan.md` (phase gates vs Tracking vs Still open). For each:
quote both sides with file:line, then give the ruling and the exact edit the writer must make.
Prefer deleting a promise over inventing a compromise.

### 5. Sequencing and gates

A single ordered list mixing the MVP slices with the already-agreed work in Tracking, so there
is one queue. For each step: what unblocks it, what proves it, and what we are allowed to
**not** test yet. Pipeline time matters: if a step would need a new CI job, say what existing
coverage is enough instead.

### 6. Risks created by moving fast

The three that will actually bite, each with the cheap mitigation that fits the MVP, and the
one place where "do it later" is a false economy and must be done now.

## Output

Markdown, sections 1–6 in order, no preamble, no restating this brief. Cite file:line for
every factual claim about the repository. Where you are choosing between two adequate options,
pick one and give the one sentence that decided it. If the honest answer to "how do we get
there fastest" is that something currently planned should simply be deleted, say that in those
words.

```

## The replan it produced

## 1. The MVP, cut honestly

**Ship a tenant-local hub behind the existing portal. Keep SQLite. Let Authentik authenticate browsers and the portal backend authenticate to KXM with existing tokens. Do not build a second browser-authentication system in the hub.**

The hosting draft already identifies `kxmd-portal` as the user-facing product. Its proposed hub-side identity validation, viewer/admin capabilities, and five new auth verbs duplicate that responsibility. Delete those promises from the MVP. [plan-per-tenant-hosting.md:35](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:35), [plan-per-tenant-hosting.md:121](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:121)

Use this topology:

```text
Browser → HTTPS / Authentik → tenant portal backend
                                  ├─ bearer → hub on loopback
                                  └─ supervisor token → local Runtime
```

The second connection matters: the hub’s ops snapshot describes hub agents, messages, and legacy workflow runs; Runtime run creation, drive, cancellation, and receipts belong to the separate supervisor API. A portal that only reads `/v1/ops/snapshot` will not show the complete Runtime workflow state. [hub.ts:613](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/hub.ts:613), [runtime-supervisor.ts:422](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-supervisor.ts:422), [runtime-supervisor.ts:447](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-supervisor.ts:447)

Authentik’s single-application forward-auth mode fits this arrangement: the existing reverse proxy handles application traffic and asks the outpost to authenticate and authorize requests. [Authentik forward-auth documentation](https://docs.goauthentik.io/add-secure-apps/providers/proxy/forward_auth)

Tracker citations below use committed revision `6d9aa5f`, because the tracker changed during inspection. Citations to the newly added hosting draft use its working copy. Portal implementation paths below are **proposed new files**, not claims about an inspected portal checkout.

### Ordered slices

| Slice | Delivery and files touched | One named test / proof | Event-store impact | Surface |
|---|---|---|---|---|
| **S0 — MVP: replace the queue and contradictory promises** | Update `plans/implementation-plan.md`, the catalog and references identified in §§3–4, `docs/operations.md`, and the two hosting/auth KB pages. Correct the AGENTS generator as described in §4; regenerate its output. | **No new test; existing gate covers it.** Update existing generated-document expectations where necessary. | **Zero** | Docs/build tooling; no hub or UI behavior |
| **S1 — MVP: run the existing services on the tenant box** | Add one optional hosting recipe to `docs/operations.md`: stable service account, working directory, persisted state locations, loopback listeners, existing supervisor/restart mechanism. Configure the tenant’s existing deployment files; no new KXM auth commands. Initialize one project and its slim `default` workflow. | **No new test; existing gate covers KXM behavior.** Deployment witness: restart the services, confirm readiness and retained run identity. | **Zero** | Hub/Runtime deployment only |
| **S2 — MVP: portal shows authoritative state** | Add a small server-only `plugins/kxm/src/portal-adapter.ts`, exported through `runtime.ts`, using existing hub and supervisor clients. Inputs are configured project bindings, never arbitrary browser-supplied roots or URLs. Proposed portal files: `integrations/kxm/server.ts` and `integrations/kxm/admin-view.ts`, wired into its existing router. Show tenant label, connectivity, agents, runs, current status, and latest receipt. Poll initially. | Append **`portal reads distinguish hub metadata from Runtime run state and unavailable upstreams`** to existing `test/core/studio-layout.test.ts`. One test; no new test file. | **Zero**; presentation DTOs only | UI/backend integration; hub APIs unchanged |
| **S3 — MVP: make the selected Pi route report truthful outcomes** | Change `plugins/kxm/src/pi-producer.ts` so a valid, complete, allowed structured outcome is required. Remove word matching and default success. Update the existing Pi producer fixture and test. | **`Pi final prose or malformed outcome cannot pass an assignment`** in `test/core/pi-producer.test.ts`. | **Zero** | Hub/Runtime producer only |
| **S4 — MVP: portal drives one real workflow** | Extend `portal-adapter.ts` and the portal integration with **create, drive, cancel** only. Use existing command IDs, run IDs and drive receipts. The backend resolves project paths and credentials. Display 202 as started/pending, not completed; preserve handoff, refusal and uncertain states. Do not expose checkpoint, “mark passed,” retry, arbitrary CLI, configuration editing or steering. | **`portal create-drive-cancel preserves command identity and reports authoritative settlement`** in existing `test/core/studio-layout.test.ts`. Reuse the existing supervisor fixture. | **Zero** | UI/backend integration; execution stays in Runtime |
| **S5 — MVP: expose the tenant admin and use it** | Configure the existing portal reverse proxy for HTTPS and Authentik, restricted to the tenant operator/admin. Keep hub and supervisor ports private. Add the stopped-state backup/restore procedure to `docs/operations.md`; record exact package/configuration versions. | Named deployment witness: **`hosted admin denies unauthenticated access and completes a real default run`**. Include wrong-tenant access denial, logout/revocation, refresh during execution, and one restore. No new automated suite or CI job. | **Zero** | Deployment/UI only |

S1 uses existing behavior: the hub defaults to loopback, reads static admin/project tokens, and has explicit state paths. Missing admin credentials are generated and persisted by the existing resolver. Preserve those implementations and their precedence. [server.ts:13](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/server.ts:13), [server.ts:45](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/server.ts:45), [hub-env.ts:140](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/hub-env.ts:140)

S3 is necessary before claiming a useful Pi-driven workflow: `determineOutcome` currently accepts an outcome word from prose and otherwise returns `passed` when allowed. This is a small correctness repair on the selected path, not a general hardening program. [pi-producer.ts:85](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/pi-producer.ts:85)

S4 reuses work already present: authenticated create, asynchronous drive, run polling, cancellation and verified receipt endpoints. Concurrent-drive exclusion and receipt corruption already have focused supervisor coverage. [runtime-supervisor.ts:388](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-supervisor.ts:388), [runtime-supervisor.ts:422](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-supervisor.ts:422), [runtime-supervisor.test.ts:71](/Users/eddieflores/source/clients/kxm/test/core/runtime-supervisor.test.ts:71), [runtime-supervisor.test.ts:604](/Users/eddieflores/source/clients/kxm/test/core/runtime-supervisor.test.ts:604)

**Choice:** use the portal rather than making standalone Studio another hosted application; the portal is already the intended browser and user boundary, while Studio’s CLI currently supplies a plan provider but neither state nor mutation handlers. [plan-per-tenant-hosting.md:35](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:35), [cli/tasks.ts:302](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/cli/tasks.ts:302)

### PostgreSQL: now, later, trigger and cost

**Now: SQLite stays on each tenant box. Neither a shared multi-tenant PostgreSQL database nor a PostgreSQL database per hub becomes authoritative.**

The coupling is substantially larger than a database-driver substitution:

| Inspected file | Lexical `.prepare(...)` calls | What couples it to SQLite |
|---|---:|---|
| `sqlite.ts` | 1 forwarding call | Synchronous `run/get/all`, native Node/Bun constructors and runtime-specific options. [sqlite.ts:18](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/sqlite.ts:18) |
| `database.ts` | 9 | Filesystem checks, WAL, PRAGMAs, schema inspection/versioning, synchronous transaction callbacks, backup and restore. [database.ts:78](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/database.ts:78), [database.ts:137](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/database.ts:137), [database.ts:367](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/database.ts:367) |
| `runtime-store.ts` | 58 | Registry, event store, commands, projections, capabilities, gate evidence, receipts and intake persistence. [runtime-store.ts:92](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-store.ts:92), [runtime-store.ts:557](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-store.ts:557) |
| `store.ts` | 31 | Hub schema and JSON expression indexes, delivery sequences/cursors, workflow and context persistence. [store.ts:15](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/store.ts:15), [store.ts:25](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/store.ts:25) |
| `local-snapshot.ts` | 7 | Direct read-only database opens, filesystem discovery, `json_extract` and `rowid` ordering. [local-snapshot.ts:118](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/local-snapshot.ts:118), [local-snapshot.ts:239](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/local-snapshot.ts:239) |

Those five files contain **105 prepared-statement call sites excluding the shim’s forwarding call**, plus **41 `.exec(...)` calls excluding its forwarding call**. Across `plugins/kxm/src`, the lexical prepare count is **120 including that forwarding call**. The additional consumers include workflow TUI, CLI workflow/role commands and the external-effects ledger. These are call-site counts, not 120 independently necessary SQL rewrites. [workflow-tui.ts:58](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/workflow-tui.ts:58), [cli/workflows.ts:40](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/cli/workflows.ts:40), [cli/roles.ts:558](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/cli/roles.ts:558), [external-effects.ts:196](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/external-effects.ts:196)

The hosting draft’s **15 tables is incorrect**. There are **23 distinct literal `CREATE TABLE` targets**: seven hub tables, two registry tables, thirteen event-store tables, and one external-effects table. Hub schema is v3; event-store schema is v5. [plan-per-tenant-hosting.md:77](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:77), [store.ts:15](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/store.ts:15), [runtime-store.ts:100](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-store.ts:100), [runtime-store.ts:557](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-store.ts:557), [external-effects.ts:130](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/external-effects.ts:130)

Backup is explicitly SQLite/file-oriented: checkpoint, integrity check, `VACUUM INTO`, hashed manifest, version ceiling and file replacement. Runtime prompts also live in a separate JSON sidecar. Moving only the hub database would not move all operational state. [database.ts:463](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/database.ts:463), [database.ts:521](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/database.ts:521), [runtime-store.ts:905](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-store.ts:905)

**Smallest cross-hub visibility:** keep a portal-owned list of tenant endpoints. Each tenant portal backend reads its own loopback hub/Runtime; an operator view requests a small summary from those tenant backends. Return observation time, connection status, counts, and links. Poll on demand; show stale/unavailable explicitly. Do not centralize raw events, prompts or credentials, and do not expose remote hub ports.

**Later: only if reporting needs it, add a disposable reporting projection on `kxm-dev-svr`, one database per hub.** Keep SQLite authoritative. Start with periodic replacement of bounded run/usage summaries; do not build an event replication platform merely to show a fleet page.

**Trigger:** a concrete report needs retained cross-hub history that current summaries cannot answer, or measured polling cost misses an agreed operator refresh target after bounding and caching reads. Hub count alone is not a trigger.

**Cost of later:** an exporter, a reporting schema, per-hub credentials, freshness/rebuild behavior, and additional disk/bandwidth on the shared server. Reserve **2–5 engineering days as a planning allowance for one bounded report**, not a measured estimate. The projection must be discardable and rebuildable; no hub migration or downtime should follow from its failure.

**If the operator insists on PostgreSQL as primary storage now:** stop calling this the fast hosting MVP. The current synchronous API, transaction semantics, SQLite dialect, direct readers, schema migrations, and backup/restore need a separate storage migration. A shared-schema design additionally makes tenant isolation a query/schema obligation; database-per-hub avoids that obligation but still adds network/database availability to every tenant’s write path. Plan in weeks, not configuration hours. The pending v6 identity/history work must then be reconciled with that migration instead of quietly ported twice. [sqlite.ts:18](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/sqlite.ts:18), [database.ts:367](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/database.ts:367), [implementation-plan.md:1403](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1403)

Capacity accounting is **incremental retained state + backup/log/artifact disk + external bandwidth on an already provisioned box**. Do not add another VM line item. Also delete the stronger claim that the hub is “not another always-on service”: it is a process that must run and be supervised. [plan-per-tenant-hosting.md:46](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:46), [docs/operations.md:38](/Users/eddieflores/source/clients/kxm/docs/operations.md:38)

## 2. What you cut, and where it goes

| Item | Cut reason | Backlog home |
|---|---|---|
| Hub browser identity assertions, viewer/admin mapping, `hub-auth.ts`, `hub auth setup/status/rotate/revoke/disable` | Duplicates the portal/edge boundary and expands the credential lifecycle before use. **Delete the planned subsystem.** [plan-per-tenant-hosting.md:123](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:123) | **Do not plan it.** |
| Hub OIDC/JWT validation, token broker, SCIM, users/sessions/cookies | Conflicts with edge-owned browser authentication. The KB’s staged JWT/broker recommendation should be deleted, not deferred as an inevitable next step. [qa-authentik-authentication.md:54](/Users/eddieflores/source/clients/kxm/docs/kb/qa-authentik-authentication.md:54) | **Do not plan it.** |
| Authoritative PostgreSQL, shared tenant tables, HA/takeover | Unnecessary for a single tenant box; expensive storage and availability change. [implementation-plan.md:2073](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L2073) | Primary shared DB: **do not plan it**. Reporting projection: **Still open**, explicit reporting trigger. |
| `kxm hub footprint` | Capacity can initially use filesystem sizes and existing proxy traffic counters. A new product command is not required to avoid double-counting a VM. [plan-per-tenant-hosting.md:144](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:144) | **Still open**, repeated manual measurement justifies automation. |
| Coordinator inbox as the first product slice | Not needed to create and drive a run from the portal. [implementation-plan.md:1477](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1477) | **Still open / M2**, after first use demonstrates queued intake need. |
| v6 coordinator history, immutable arrival sequence, bounded resume | Real work, but attached to intake consumption and sustained traffic—not hosting. [implementation-plan.md:1403](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1403) | **Still open**, prerequisite to the selected intake consumer. |
| Intake record digests, two-process races, rare SQLite contention reproduction, rollback-handle hardening | **Post-MVP hardening**, each selected by its recorded threat/runtime trigger. Do not bundle all ten findings into v6. [implementation-plan.md:1410](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1410) | **Still open**, separate named items. |
| Native streamed output, durable viewer replay, active steering | Polling existing run/receipt state is enough for first use. [plan-unified-kxm-milestones.md:240](/Users/eddieflores/source/clients/kxm/plans/plan-unified-kxm-milestones.md:240) | **Phase 11 / M2–M3**, after observed visibility/control friction. |
| Pi SDK/OpenCode/DSH comparison | No engine replacement is needed for hosting. Delete “next” and “early subsequent” as scheduling obligations. [plan-unified-kxm-milestones.md:151](/Users/eddieflores/source/clients/kxm/plans/plan-unified-kxm-milestones.md:151) | **Still open**, only a reproduced limitation of the retained route opens the experiment. |
| Package-tree migration, Bun CI installation, Python/Rust adoption | Shipping infrastructure cannot depend on reorganizing working code or changing runtimes. [implementation-plan.md:1369](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1369), [research-runtime-language-choices.md:247](/Users/eddieflores/source/clients/kxm/plans/research-runtime-language-choices.md:247) | **Still open**, actual package boundary or measured component need. |
| SSH workflow recovery, remote reattachment, offline multi-Runtime synchronization | Running services on a tenant machine does not require distributed workflow execution. [implementation-plan.md:2014](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L2014), [implementation-plan.md:2034](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L2034) | **Phase 6** and **Phase 8**, post-MVP. |
| MOA breadth and live 13-stage `/fix` | Does not unblock the single useful default workflow. [implementation-plan.md:2023](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L2023) | **Phase 7**, post-MVP. Existing developer critics remain required. |
| Studio editor, graphs, documents, exports, memory workshop | Admin list/detail plus real actions is the useful first surface. [plan-unified-kxm-milestones.md:377](/Users/eddieflores/source/clients/kxm/plans/plan-unified-kxm-milestones.md:377) | **Phase 10 / M7**, post-MVP. |
| Browser unification, retrieval backends, RTK integration, full mode activation | Independent capabilities with their own integration cost. [plan-unified-kxm-milestones.md:470](/Users/eddieflores/source/clients/kxm/plans/plan-unified-kxm-milestones.md:470) | **Phase 4/9 / M4–M6**, selected after use. |
| Quota prediction, new stage budgets, rollover, extra provider admissions | Preserve current accounting and refusals; do not build predictive routing for hosting. [plan-usage-cost-quota-tracking.md:111](/Users/eddieflores/source/clients/kxm/plans/plan-usage-cost-quota-tracking.md:111), [implementation-plan.md:1726](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1726) | **Still open / M8**, post-MVP. |
| Email/SMS, Confluence writes, external reply approval | Introduces accounts, send authority and uncertain external effects unrelated to first hosting. [plan-unified-kxm-milestones.md:414](/Users/eddieflores/source/clients/kxm/plans/plan-unified-kxm-milestones.md:414) | **M8**, post-MVP. |
| Windows resumption, broad crash/load matrices, coverage ratchet | **Post-MVP qualification/hardening**; do not add CI legs or tests to each hosting slice. [implementation-plan.md:1656](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1656) | **Still open**, existing platform-resumption decision. |
| Wiki compilation and default updater change | Public npm removes an old prerequisite; it does not make these urgent. [implementation-plan.md:1681](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1681) | **Still open / Phase 9 and M9**, post-MVP. |

## 3. Plan-set operations

All **19 current `plans/*.md` summaries** were read, including the hosting draft added during inspection. Preserve historical evidence; remove competing scheduling authority.

| Document and summary anchor | Operation | Exact disposition |
|---|---|---|
| [implementation-plan.md:13](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L13) | **Split** | Keep this path as the sole tracker. Keep decisions, current accepted-slice summaries, phase gates and one ordered queue. Move repetitive historical implementation narratives to `plans/history/2026-09-19-tracking-record.md`, with links retained beside acceptance summaries. The history file must explicitly prohibit creating work. |
| [plan-unified-kxm-milestones.md:13](/Users/eddieflores/source/clients/kxm/plans/plan-unified-kxm-milestones.md:13) | **Demote to reference** | Preserve M0–M9 IDs and the fork mapping as the proposed scope catalog. Replace “first product slice” and “next” with a link to canonical Tracking. Mark unselected scope post-MVP. Integrate hosting under M7/M9 instead of a parallel delivery catalog. |
| [plan-per-tenant-hosting.md:13](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:13) | **Merge into the unified catalog; archive with stub** | Move the corrected topology/storage rationale to M7/M9; move selected slices only to Tracking. Archive the original in `plans/history/plan-per-tenant-hosting.md`; old path becomes a short supersession stub. Delete the hub-auth subsystem and footprint prerequisite. |
| [plan-additional-providers-agy-kimi.md:13](/Users/eddieflores/source/clients/kxm/plans/plan-additional-providers-agy-kimi.md:13) | **Split, then archive with stub** | Move retained protocol observations to `research-harness-streaming-capabilities.md`; quota observations to `plan-usage-cost-quota-tracking.md`. Correct route-policy statements against latest Tracking. Archive the source record under `history/`. |
| [plan-agent-communication-steering.md:13](/Users/eddieflores/source/clients/kxm/plans/plan-agent-communication-steering.md:13) | **Demote to reference** | Keep exact-session receipt and permission design. M3 owns proposed capability scope; Tracking alone selects delivery. No independent `agent` dispatcher or activity-lease authority. |
| [plan-ssh-remote-execution.md:13](/Users/eddieflores/source/clients/kxm/plans/plan-ssh-remote-execution.md:13) | **Demote to reference** | Preserve remote recovery/workspace contracts. State prominently that tenant deployment does not require Phase 6 completion. |
| [plan-token-reduction-rtk-ai.md:13](/Users/eddieflores/source/clients/kxm/plans/plan-token-reduction-rtk-ai.md:13) | **Keep as-is** | It already describes an optional bounded experiment and preserves raw gate/critic evidence. Do not merge it with mode activation: output reduction and tool registration have different correctness boundaries. [plan-token-reduction-rtk-ai.md:90](/Users/eddieflores/source/clients/kxm/plans/plan-token-reduction-rtk-ai.md:90) |
| [plan-usage-cost-quota-tracking.md:13](/Users/eddieflores/source/clients/kxm/plans/plan-usage-cost-quota-tracking.md:13) | **Demote to reference** | Become the single quota-observation design, including retained provider observations. Remove stale “broader price coverage remains open” wording; M8 remains proposed. |
| [plan-workflow-modes-selective-loading.md:13](/Users/eddieflores/source/clients/kxm/plans/plan-workflow-modes-selective-loading.md:13) | **Keep as-is** | Its parser-versus-real-activation distinction is useful and already disclaims backlog authority. Select work only through Tracking. [plan-workflow-modes-selective-loading.md:32](/Users/eddieflores/source/clients/kxm/plans/plan-workflow-modes-selective-loading.md:32) |
| [research-agent-producer-architecture.md:13](/Users/eddieflores/source/clients/kxm/plans/research-agent-producer-architecture.md:13) | **Merge into `research-kxm-harness-strategy.md`; archive with stub** | It already delegates its comparison and ownership analysis to that report. Merge only unanswered questions and evidence criteria; remove duplicate release/experiment sequencing. [research-agent-producer-architecture.md:40](/Users/eddieflores/source/clients/kxm/plans/research-agent-producer-architecture.md:40) |
| [research-kxm-harness-strategy.md:13](/Users/eddieflores/source/clients/kxm/plans/research-kxm-harness-strategy.md:13) | **Demote to reference** | Keep source comparison and experiment design. Replace the mandatory “early subsequent” experiment with the observed-limitation trigger. |
| [research-harness-streaming-capabilities.md:13](/Users/eddieflores/source/clients/kxm/plans/research-harness-streaming-capabilities.md:13) | **Keep as-is, with merged observations** | Remain the dated protocol/capability evidence packet. Added provider observations must retain source/version provenance and cannot admit routes. |
| [research-memory-studio-forks.md:13](/Users/eddieflores/source/clients/kxm/plans/research-memory-studio-forks.md:13) | **Demote to reference** | Preserve findings and interaction design. Remove normative first-delivery language; portal admin is selected, coordinator inbox and editor are post-MVP. |
| [research-runtime-language-choices.md:13](/Users/eddieflores/source/clients/kxm/plans/research-runtime-language-choices.md:13) | **Keep as-is** | Keep L1–L6 as experiment definitions, not required work. Tracking must explicitly say none is a hosting prerequisite. |
| [research-additional-forks.md:13](/Users/eddieflores/source/clients/kxm/plans/research-additional-forks.md:13) | **Keep as-is** | Preserve dated source findings and traceability. Its milestone references are catalog mappings, not scheduled slices. |
| [control-plane-memory-questionnaire.md:13](/Users/eddieflores/source/clients/kxm/plans/control-plane-memory-questionnaire.md:13) | **Keep as-is** | Already an archived stub. |
| [plan-role-configuration-governance.md:13](/Users/eddieflores/source/clients/kxm/plans/plan-role-configuration-governance.md:13) | **Keep as-is** | Already an archived stub. Remaining explicitly selected work belongs in Tracking, not a revived plan. |
| [plan-safety-security-process-integrity.md:13](/Users/eddieflores/source/clients/kxm/plans/plan-safety-security-process-integrity.md:13) | **Keep as-is** | Already an archived completion record. |
| [v05-context-os.md:13](/Users/eddieflores/source/clients/kxm/plans/v05-context-os.md:13) | **Keep as-is** | Already a superseded stub. |

The authority conflict is concrete: the unified catalog calls itself the consolidated proposal for all fork work, while the new hosting draft adds its own “MVP: two slices.” Neither may schedule ahead of Tracking. **Tracking wins execution; the unified catalog wins proposed scope; the hosting draft loses its standalone sequence.** [plan-unified-kxm-milestones.md:46](/Users/eddieflores/source/clients/kxm/plans/plan-unified-kxm-milestones.md:46), [plan-per-tenant-hosting.md:115](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:115)

## 4. Contradictions, resolved

### A. “Hub local is MVP” versus hosted MVP

- Existing decision: **“SSH/HTTPS hub install are after MVP.”** [implementation-plan.md:305](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L305)
- New proposal: **“MVP: two slices”** for per-tenant hosting. [plan-per-tenant-hosting.md:115](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:115)

**Ruling/edit:** replace the old MVP sentence with:

> Local token-authenticated operation remains the default. The selected hosted MVP runs the hub and local Runtime on an existing tenant box behind its portal. Remote workflow execution and distributed synchronization remain post-MVP.

Do not mark Phase 6 or Phase 8 passed merely because a tenant box is reachable.

### B. Portal owns users versus hub implements browser capabilities

- **“The portal is the multi-tenant, multi-user product surface.”** [plan-per-tenant-hosting.md:35](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:35)
- Slice A makes the hub validate **“tenant match, subject, viewer/admin capability”** and adds five auth verbs. [plan-per-tenant-hosting.md:123](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:123)

**Ruling/edit:** delete the Slice A auth subsystem. Replace it with:

> Authentik and the portal own browser access. The portal backend calls loopback KXM APIs using existing machine credentials. KXM does not interpret browser identity headers. Hosted deployment failure denies browser access; it does not disable local token clients.

That last sentence also removes the draft’s inappropriate implication that a broken browser proxy should make the hub stop serving authorized machine clients. [plan-per-tenant-hosting.md:57](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:57)

### C. Edge-only authentication versus planned hub JWT/broker

- Hosting excludes **“OIDC callback, refresh tokens, a session store…user accounts.”** [plan-per-tenant-hosting.md:64](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:64)
- KB recommends **“Phase 2: hub-side JWT verification”** followed by broker-issued tokens. [qa-authentik-authentication.md:55](/Users/eddieflores/source/clients/kxm/docs/kb/qa-authentik-authentication.md:55)

**Ruling/edit:** replace the KB summary and recommendation with the portal-backend topology. Keep rejected alternatives only as clearly historical analysis, without future-phase promises. Remove OAuth client-credentials/device-login work for existing KXM machine clients from this hosting plan. [qa-authentik-authentication.md:64](/Users/eddieflores/source/clients/kxm/docs/kb/qa-authentik-authentication.md:64)

### D. TLS/RBAC gate versus the selected deployment boundary

- Phase 10: **“Add TLS and RBAC before non-loopback deployment.”** [implementation-plan.md:2064](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L2064)
- Hosting: hub adds no **“per-user RBAC”** and accepts portal machine credentials. [plan-per-tenant-hosting.md:64](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:64)

**Ruling/edit:** replace the Phase 10 deployment sentence—not merely append an exception:

> Public browser deployment requires HTTPS and tenant-admin authorization at the portal edge. Hub and supervisor remain loopback machine APIs with existing credentials. Full dashboard breadth and hub-side multi-user RBAC are not prerequisites.

Retain the command-parity gate. Remove hub multi-user RBAC from Phase 11’s selected direction; retain isolation/takeover only as post-MVP proposals.

### E. A tiny storage claim versus actual storage ownership

- Hosting: **“one box = one hub process = one `.kxm/state/kxm.db`”** and **“15”** distinct tables. [plan-per-tenant-hosting.md:42](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:42), [plan-per-tenant-hosting.md:79](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:79)
- Runtime defines a separate **`registry.db`**, project directories and **`run-events.db`**; prompts use another sidecar. [runtime-store.ts:23](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-store.ts:23), [runtime-service.ts:303](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-service.ts:303), [runtime-store.ts:917](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-store.ts:917)

**Ruling/edit:** replace “one SQLite file is the isolation, backup, restore and migration unit” with:

> One tenant box owns its hub database, Runtime registry and project event stores, bindings, prompt sidecars and configuration. Back up and restore that complete tenant state set.

Replace the counts with §1’s scoped counts. Delete “nothing…can leak them”: separate boxes reduce blast radius; they do not prove the portal cannot select the wrong tenant credential. [plan-per-tenant-hosting.md:87](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:87)

### F. Two “first product” sequences

- Tracker: **“internal coordinator message…M2 events → thin M7 Studio replay.”** [implementation-plan.md:1477](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1477)
- Hosting: **“Slice A — mode, boundary…”**, then action/footprint work. [plan-per-tenant-hosting.md:121](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:121), [plan-per-tenant-hosting.md:144](/Users/eddieflores/source/clients/kxm/plans/plan-per-tenant-hosting.md:144)

**Ruling/edit:** replace both sequences with S0–S5 in Tracking. The unified plan’s first-product section becomes a link to that queue. Move intake to post-MVP with an explicit consumer trigger; remove replay/streaming as prerequisites to polling.

### G. Accepted drive work still called remaining

- Tracking: **“task_9076be56b581 slices are all accepted.”** [implementation-plan.md:1594](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1594)
- Phase 11: **“B2 durable receipts, B3 run-duration budget, and B4 surfaces remaining.”** [implementation-plan.md:2097](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L2097)

**Ruling/edit:** replace “remaining” with the accepted slice references and move their detailed narrative out of Still open. Keep only explicitly unresolved route-specific work. Update M0’s stale live-write-refusal, HTTP-lifetime and wider-price TODOs using their accepted entries. [plan-unified-kxm-milestones.md:190](/Users/eddieflores/source/clients/kxm/plans/plan-unified-kxm-milestones.md:190), [implementation-plan.md:1533](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1533)

### H. “No adapters” versus implemented adapters; “no gates” versus completed driver

- Phase 4 still lists **“Pi RPC adapter”** as remaining. [implementation-plan.md:1969](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1969)
- Landed says **“Implemented Pi RPC producer.”** [implementation-plan.md:865](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L865)
- Earlier Phase 3 says **“The engine still refuses gates.”** Later it says **“Fulfills the Phase 3 Gate sentence.”** [implementation-plan.md:1860](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1860), [implementation-plan.md:1938](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1938)

**Ruling/edit:** label earlier stage descriptions historical and remove their present-tense restrictions from current status. Phase 4 remaining work becomes **exact-route live acceptance and specified UX gaps**, not rebuilding Pi RPC. Do the same for the blanket “Non-Pi dispatch adapters” bullet: distinguish existing one-shot implementation from outstanding qualification. [implementation-plan.md:837](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L837), [implementation-plan.md:1703](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1703)

### I. Studio described as operational versus unwired success

- Landed says **“active workflow layout/state dashboard…mutations on the authenticated command API.”** [implementation-plan.md:749](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L749)
- The implementation returns **`ok: true`**, **`mappedToCli: true`** without `onMutation`; CLI supplies neither mutation nor state handler. [studio-layout.ts:410](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/studio-layout.ts:410), [cli/tasks.ts:302](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/cli/tasks.ts:302)

**Ruling/edit:** replace the landed claim with:

> Layout generation and an embedded Studio shell exist. The standalone CLI does not establish live state or command execution. Hosted admin uses the portal integration; unavailable actions cannot report success.

Correct the erroneous “Phase 6” attribution to Phase 10. Standalone Studio repair is post-MVP unless selected for actual use. [implementation-plan.md:760](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L760)

### J. Newest provider decision versus generated instructions and references

- Latest Decided says Google integration is **“the `antigravity` Pi provider…never a shell-out to the agy CLI.”** [implementation-plan.md:122](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L122)
- AGENTS says Google uses **“agy (Antigravity CLI)”**; the provider reference says **“Google remains on authenticated `agy`.”** [AGENTS.md:80](/Users/eddieflores/source/clients/kxm/AGENTS.md:80), [plan-additional-providers-agy-kimi.md:42](/Users/eddieflores/source/clients/kxm/plans/plan-additional-providers-agy-kimi.md:42)

**Ruling/edit:** the latest explicit Tracking decision wins product direction. Retain its narrow admission caveats: Antigravity promotion still needs login/live evidence; Claude bridge remains experiment-only. Rewrite the older general native-preference paragraph to name these reviewed exceptions without granting new writer eligibility. Do not schedule a provider migration for hosting. [implementation-plan.md:128](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L128)

**Regenerate AGENTS; do not hand-edit it.** There is a generator gap: `emit-codex-artifacts.mjs` replaces the command block, and `memory.ts` replaces the memory block; both preserve surrounding policy prose. Running the current generator cannot correct the stale header policy. [emit-codex-artifacts.mjs:293](/Users/eddieflores/source/clients/kxm/scripts/emit-codex-artifacts.mjs:293), [memory.ts:319](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/memory.ts:319)

In S0, make the existing emitter own the repository session-brief prefix too. Generate a short pointer to canonical Tracking, while preserving the generated command/memory blocks and RTK reference. Move any unique still-required instruction into Tracking before removing duplicated prose. This removes a second policy copy rather than introducing a new template plan.

### K. Public npm and pricing foundations simultaneously done and planned

- AGENTS: **“Punt wiki compile/ingest and npm update-source until a public npm release.”** [AGENTS.md:18](/Users/eddieflores/source/clients/kxm/AGENTS.md:18)
- Tracking: **“The old ‘not before public npm’ trigger is satisfied.”** [implementation-plan.md:1686](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1686)
- Decided calls v2/event-settle/catalog **“planned”**; Phase 4 records them implemented. [implementation-plan.md:326](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L326), [implementation-plan.md:1966](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1966)

**Ruling/edit:** mark publication as historical prerequisite satisfaction, with wiki/updater still unselected. Mark v2 accounting/catalog foundations implemented; retain only genuinely missing extensions. Delete stale blanket “npm is not ready” statements and replace them with named candidate-specific release requirements. Do not present old observed version numbers as today’s latest release.

### L. Slim gates versus “every phase adds” a broad matrix

- AGENTS specifies existing `npm run verify` and five PR jobs, with Windows paused. [AGENTS.md:162](/Users/eddieflores/source/clients/kxm/AGENTS.md:162)
- Tracker says **“Every phase adds”** unit/schema, property/model, crash, Windows/Linux, security and redaction tests, then requires **`npm run validate`**. [implementation-plan.md:2120](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L2120)

**Ruling/edit:** replace the entire cross-cutting checklist with:

> Run the existing `npm run verify` commit gate and existing CI jobs. Each slice may add at most one focused named test in an existing suite. Reuse existing coverage. Add no npm script, CI job, platform leg, broad test file or coverage ratchet for the hosted MVP. New live evidence is limited to the selected route and deployment boundary. Unselected-platform and broad hardening evidence remain post-MVP, never implied PASS.

This is an explicit replacement of the old testing requirement under the present operator brief—not an attempt to satisfy it by renaming tests.

## 5. Sequencing and gates

Use this **one queue inside Tracking**. S0–S5 are selected. Everything after first use is marked **post-MVP** and starts only on its stated trigger.

1. **S0 — reconcile plan authority and regenerate instructions.**  
   **Unblocked by:** this replan. **Proof:** coherent Tracking/phase/catalog text and current generated artifacts through existing `verify`. Preserve accepted commits; replace vague retirement/acceptance blockers with a concrete unsatisfied condition or delete them. **Do not test:** product behavior again merely because prose moved. The tracker already requires same-change gate reconciliation. [implementation-plan.md:1766](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1766)

2. **S1 — tenant-box service setup and the already-agreed slim `default`.**  
   **Unblocked by:** a provisioned tenant box and a selected authenticated route. **Proof:** readiness, persisted credentials and one project/run after restart. **Do not test:** SSH workflow equivalence, offline synchronization, multi-repository crash recovery or every provider. The slim live default is already explicitly open. [implementation-plan.md:1695](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1695)

3. **S2 — real portal reads.**  
   **Unblocked by:** S1 and portal checkout/router access. **Proof:** its one adapter test plus browser comparison against the same run’s CLI/API state. **Do not test:** SSE reconnection, stream backpressure, full Studio layout/editor behavior or unavailable service panels. Existing run GET is explicitly read-only and already covered. [runtime-supervisor.test.ts:1020](/Users/eddieflores/source/clients/kxm/test/core/runtime-supervisor.test.ts:1020)

4. **S3 — strict Pi outcome on the selected route.**  
   **Unblocked by:** the existing Pi producer fixture. **Proof:** one negative outcome test, existing suite, and selected-route live execution in S5. **Do not test:** all native adapters, new engines, provider comparisons or streaming protocols. Preserve current auth/cost checks. [pi-producer.test.ts:424](/Users/eddieflores/source/clients/kxm/test/core/pi-producer.test.ts:424), [pi-producer.test.ts:453](/Users/eddieflores/source/clients/kxm/test/core/pi-producer.test.ts:453)

5. **S4 — create, drive and cancel through the portal.**  
   **Unblocked by:** S2/S3 and exact project binding. **Proof:** the single command-parity test plus existing duplicate-drive, shutdown and receipt tests. **Do not test:** native steering, coordinator rebind, bulk intake resume, automatic retries or every command exposed by the CLI. B1–B4 are reused, not rescheduled. [implementation-plan.md:1551](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1551)

6. **S5 — edge authentication, restore witness, deployment, first actual use.**  
   **Unblocked by:** S4, tenant DNS/TLS/Auth­entik configuration and the existing acceptance workflow. **Proof:** the named deployed witness from §1, actual command/drive receipts, and a usable restored state set. **Do not test:** IdP implementation internals, load/chaos matrices, HA or Windows. Declare this a **Linux hosted deployment slice**, not completion of every historical phase/platform promise.

7. **Post-MVP — close observed first-use failures.**  
   **Trigger:** an actual failed/slow/ambiguous operator action. **Proof:** one focused regression per repair. Scheduler/supervisor timing tests move here unless they fail a current gate; use a barrier or injectable clock, not wider timeouts. **Do not test:** unrelated scheduler permutations. [implementation-plan.md:1387](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1387)

8. **Post-MVP — automate complete backup discovery.**  
   **Trigger:** replacing the documented stopped-state backup with routine unattended recovery. **Files:** `database.ts`, Runtime path helpers, existing E6 test. **Schema:** zero. **One test:** `backup discovers deployed Runtime stores and preserves prompt sidecars`. Current discovery searches project-local `runtime/events/*.db`, while Runtime actually opens user-state `runtime/projects/<key>/run-events.db`. Do not pretend the existing “all stores” fixture proves deployed discovery. [database.ts:594](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/database.ts:594), [runtime-service.ts:303](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-service.ts:303), [e6-backup-restore-migrations.test.ts:258](/Users/eddieflores/source/clients/kxm/test/core/e6-backup-restore-migrations.test.ts:258)

9. **Post-MVP — v6 identity/history slice.**  
   **Trigger:** selecting coordinator intake dispatch or rebinding. **Files:** `runtime-store.ts`, intake owner, shared schema-version constant, `database.ts`, existing intake/E6 fixtures. **Schema:** v5→v6, explicitly approved here. **One test:** `v5 coordinator rebind preserves historical identity after migration`. Do not bundle record-digest or rare contention work. [implementation-plan.md:1407](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1407)

10. **Post-MVP — durable arrival order and bounded intake release.**  
    **Trigger:** the same selected intake consumer, before sustained traffic. **Files:** `runtime-store.ts`, intake owner and existing intake test. **Schema:** coordinate with the v6 migration before it ships; if v6 already shipped, use a new explicit version. **One test:** `restored intake retains arrival order and bounded paused release`. Preserve pause atomicity. **Do not test:** arbitrary-scale load or every SQLite error code. [implementation-plan.md:1423](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L1423)

11. **Post-MVP — internal intake consumer.**  
    **Trigger:** operator use actually needs queued messages rather than direct run creation; steps 9–10 complete. **Files:** intake/Runtime command owner, portal inbox view, existing intake test. **Schema:** zero beyond the approved preceding migration. **One test:** `duplicate intake admits one run and pause prevents dispatch`. No external email/SMS, grouped wakes or new scheduler. [plan-unified-kxm-milestones.md:236](/Users/eddieflores/source/clients/kxm/plans/plan-unified-kxm-milestones.md:236)

12. **Post-MVP — one progress improvement, then one supported control.**  
    **Trigger:** polling proved insufficient. Select one route’s incremental output before native steering. Keep workspace/session/attempt binding. **Proof:** one decoder/recovery test for progress; a separate later control slice gets its own one test and live acknowledgment witness. **Do not test:** a cross-harness matrix or compare engines unless the retained route cannot meet the need. [plan-agent-communication-steering.md:128](/Users/eddieflores/source/clients/kxm/plans/plan-agent-communication-steering.md:128)

13. **Post-MVP — reporting projection, only on §1’s trigger.**  
    **Proof:** one tenant projection can be rebuilt and cannot substitute stale data for current authority. **Do not test:** distributed transactions, PostgreSQL-backed hub execution or cross-tenant writes.

14. **Post-MVP — other agreed backlog, one selected item at a time.**  
    Phase 6 remote execution, Phase 7 MOA, Phase 8 synchronization, Phase 9 improvement, remaining M7 UI, M8 integrations and M9 broader release/platform qualification retain their homes from §2. Their prerequisites govern only a selected feature. They are not a hidden chain in front of hosting.

No step adds a CI job. The current PR path already runs `validate:pr` on Node 22.19.0 and 24, alongside Docs lint, Classify changes and Plugin validation; main/nightly retain their existing broader checks. [ci.yml:84](/Users/eddieflores/source/clients/kxm/.github/workflows/ci.yml:84), [ci.yml:122](/Users/eddieflores/source/clients/kxm/.github/workflows/ci.yml:122), [ci.yml:142](/Users/eddieflores/source/clients/kxm/.github/workflows/ci.yml:142)

Keep the existing developer assignment → witness → Fable/Sol acceptance process. Those reviews do not replace tests, and this planning response is not a fresh execution witness. [implementation-plan.md:187](https://github.com/kontextmind/kxm/blob/6d9aa5f4530b97ab42bc07245d4d8804f1083180/plans/implementation-plan.md#L187)

## 6. Risks created by moving fast

1. **The portal becomes an overly powerful credential relay.**  
   The hub ops endpoint requires an admin token; the supervisor separately authenticates every non-health request. A generic proxy would expose that authority too broadly. [hub.ts:1395](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/hub.ts:1395), [runtime-supervisor.ts:388](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-supervisor.ts:388)  
   **Cheap mitigation:** operator/admin-only portal access, server-held credentials, fixed upstreams/project bindings, three allowed mutations, same-origin request protection, and no direct public hub/supervisor listener. Strip untrusted identity headers at the edge. Keep broader RBAC and credential lifecycle automation in the backlog.

2. **A refresh, timeout or vague model response makes the operator repeat work or believe it passed.**  
   Drive is asynchronous, and Pi currently has a default-success inference path. Standalone Studio also has a successful no-handler fallback. [runtime-supervisor.test.ts:21](/Users/eddieflores/source/clients/kxm/test/core/runtime-supervisor.test.ts:21), [pi-producer.ts:85](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/pi-producer.ts:85), [studio-layout.ts:423](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/studio-layout.ts:423)  
   **Cheap mitigation:** stable command/run/drive IDs, poll authoritative receipts after refresh, explicit unknown/handoff states, and strict outcomes on the selected route. No automatic retry of uncertain effects.

3. **The box fills up—or recovery restores the hub but loses Runtime history/prompts.**  
   State spans multiple paths and prompt sidecars; the backup discovery path does not match the Runtime project-store path. [database.ts:594](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/database.ts:594), [runtime-service.ts:303](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-service.ts:303), [runtime-store.ts:917](/Users/eddieflores/source/clients/kxm/plugins/kxm/src/runtime-store.ts:917)  
   **Cheap mitigation:** a documented stopped-state copy of the complete tenant state/configuration set, one restore before first real use, existing disk alerts, bounded backup retention and no automatic deletion of active evidence. Automate discovery after use; do not migrate databases to avoid writing the backup recipe.

**The one false economy is postponing trustworthy command results.** The first deployed UI must prove that an authorized command ran—or clearly say it did not. Otherwise operator usage produces misleading evidence, and every subsequent prioritization decision is based on it. Keep that requirement now; defer visual breadth, generalized replay, predictive routing and infrastructure hardening.

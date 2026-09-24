---
schema: "kxm.doc.v1"
id: "PLAN-PER-TENANT-HOSTING"
type: "architecture"
title: "Per-tenant hub hosting: Authentik at the edge, token auth unchanged, no new database"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-20"
updated: "2026-09-24"
authority: "hypothesis"
confidence: "medium"
summary: "Rationale and boundary for hosting KXM beside kxmd-portal: one tenant per box, Authentik at the edge, existing static-token auth unchanged, hub state stays SQLite, and the portal backend — not a new hub auth subsystem — is the hosted client of the loopback hub. Delivery order lives only in implementation-plan.md's queue (S0–S5); this file keeps no schedule of any kind, including slice counts."
tags: ["hub", "studio", "auth", "hosting", "mvp"]
related:
  - implementation-plan.md
  - plan-unified-kxm-milestones.md
  - plan-ssh-remote-execution.md
  - reviews/authentik-hosting-design-astra.md
  - research-a2a-cross-host.md
  - plan-cross-host-phase.md
  - research-jev-system-one.md
depends_on: []
blocked_by: []
details:
  describes: "proposed"
  supersedes: "nothing; it narrows Phase 8 and Phase 10 scope for hosted use"
---

# Per-tenant hub hosting (MVP)

Read [the execution tracker](implementation-plan.md) first. This document is proposed scope
only: it does not change a phase gate, and it is not a second backlog. Decisions and slices
land in **Tracking**; this file holds the reasoning and the shape.

## Why this exists

KXM will be hosted alongside `kontextmind/kxmd-portal`. The portal is the multi-tenant,
multi-user product surface. The hub is not, and does not need to become one.

## The four decisions

### 1. Tenancy is the machine

One tenant = one box = one hub process, whose state set is led by
`.kxm/state/kxm.db`. The hub gets a **tenant label**, not a tenant table: no hub query
filters by tenant, because there is only one. What that does **not** buy is proof that a
request reached the right hub — selecting the wrong tenant's credential is a real failure
mode, which is why bindings are server-held and project-fixed rather than browser-supplied.

Consequence for capacity: the tenant's box is already provisioned for the portal, so the hub
adds **no VM line item** to the plan. It is incremental disk, bandwidth and one supervised
process — the hub **is** an additional always-on service on that box and is counted as such in
RAM and restart behaviour; only the machine is not new. What is not incremental is any second
browser, second database or second authentication system: any design that adds one is wrong by
construction.

### 2. Auth stays exactly as it is; hosting is additive

`KXM_AUTH_TOKEN` (admin bearer), `KXM_PROJECT_TOKENS`, the generated-and-persisted token in
the hub env record, `kxm hub bind <url>`, and the local loopback convenience all keep working,
unmodified, for anyone who does not deploy hosting. `kxm hub start` on a laptop must not change
behaviour, output, or credential precedence.

Hosting is **explicitly activated**, never inferred from which environment variables happen to
be set, and never silently upgraded (a local hub must not start trusting identity headers).
**A broken proxy or Authentik denies browser access; it does not disable the hub's existing
machine clients**, and it must not quietly start accepting unauthenticated traffic either.
One command answers "which mode am I in, and why", and names what to run when the answer is
half-configured.

### 3. Authentik owns the browser; the portal backend is the hub's client

Authentik authenticates and authorizes browsers at the tenant's existing reverse proxy, on the
portal's own routes. **The hub never interprets browser identity.** The portal's server-side
backend calls the loopback hub and supervisor with existing machine credentials, and the browser
talks only to the portal. The hub binds loopback and exposes no public listener.

What the hub does **not** build, and this is the cut that the replan made against my own first
draft of this file: no `/kxm/` browser surface, no hub-side tenant/subject/capability validation,
no viewer-vs-admin credential kinds, no `kxm hub auth setup|status|rotate|revoke|disable`, no
OIDC callback, refresh, session store, cookie framework or cookie crypto, no SCIM, no user
table. That duplicated the boundary the portal and Authentik already own and pulled a credential
lifecycle into the critical path. The only failure-mode rule that survives: **a hosted
deployment's browser-auth outage denies browser access; it must not stop the hub serving
authorized machine clients**, because killing local token clients to protect a browser path is a
new way to be down.

### 4. No PostgreSQL for the hub — and if we ever need it, one database per hub

Measured coupling, not taste:

| Fact | Count |
|---|---|
| Prepared-statement call sites in the five coupled files (`sqlite.ts`, `database.ts`, `runtime-store.ts`, `store.ts`, `local-snapshot.ts`) | 105, plus 41 `.exec(...)` |
| Lexical `.prepare(` across `plugins/kxm/src` | 120 (includes the shim's forwarding call) |
| Distinct literal `CREATE TABLE` targets | 23 — 7 hub, 2 registry, 13 event store, 1 external-effects |
| Hub store schema | `HUB_STORE_SCHEMA_VERSION = 3` ([store.ts:13](../plugins/kxm/src/store.ts)) |
| Runtime event store schema | v5, with v6 follow-ups already open ([runtime-store.ts](../plugins/kxm/src/runtime-store.ts), [implementation-plan.md](implementation-plan.md) Still open) |
| Backup/restore | `VACUUM INTO` + integrity check + manifest + restore ceiling ([database.ts:490](../plugins/kxm/src/database.ts)) |
| Transaction semantics we just hardened | `BEGIN IMMEDIATE`, per-connection busy throttle, contention classification by SQLite result code ([database.ts](../plugins/kxm/src/database.ts)) |

The tenant box owns the complete state set — hub database, Runtime registry, per-project event
stores, bindings, prompt sidecars and configuration — and that set, not one file, is what gets
backed up and restored. Separate boxes sharply reduce blast radius; they do **not** prove the
portal cannot pick the wrong tenant's credential, which is a real failure mode and the reason
bindings are server-held and fixed rather than browser-supplied. Replacing it means either rewriting those 120 call sites and every migration
lane, or maintaining two engines and doubling every test and backup path. That is not an MVP
cost, and it buys the operator nothing on day one: the hub's read models are already reachable
over HTTP.

**Ruling, in priority order:**

1. **Now:** hub state stays SQLite on the tenant box. Cross-hub visibility for the portal comes
   from the endpoints that already exist — `/v1/ops/snapshot`, `/v1/events`, `/v1/agents`,
   `/v1/messages`, `/v1/workflows`, `/v1/improvements` — which the portal reads with the tenant
   hub's own token. Portal-side aggregation belongs in the portal's database, wherever the
   portal wants it, and that choice is not the hub's problem.
2. **Later, on a named trigger:** if a concrete report needs retained cross-hub history that
   bounded summaries cannot answer, or measured polling misses an agreed refresh target after
   bounding and caching, add **one PostgreSQL database per hub**, populated by a **projection
   (the trigger is Tracking's, in the same words on purpose — hub count alone is not one)**
   exported from the hub's event log** — never as the hub's write path. Per-hub database (not a
   shared multi-tenant schema) because: our migrations are still moving (v6 pending) and a shared
   schema forces every tenant into lockstep; blast radius and restore are per tenant anyway; and
   row-level security would become a correctness dependency inside the hot path, where a single
   forgotten `tenant_id` predicate is a cross-tenant incident rather than a slow query.
3. **Not on the table:** a multi-tenant hub over a shared Postgres database as the hub's primary
   store. It converts one-tenant-per-box isolation into a per-query invariant, and we would be
   paying for it in the 120 places that currently trust SQLite.

If the answer is refused: the thing that breaks first is not performance, it is that hub
migrations become coordinated releases across tenants, and every table added from now on needs a
tenant column, a backfill, and an RLS policy on the day it is written.

## Delivery: none of it is scheduled here

The ordered queue lives in
[`implementation-plan.md`](implementation-plan.md) under **Still open → The one queue**
(S0–S5), and that is the only delivery sequence. What this file contributes is the boundary and
the storage ruling; the slices are named there, not duplicated here.

Two queue steps carry the first usable version — the portal's read path and its drive path —
and both are portal-side work against APIs that already exist:

- **Read:** the portal shows tenant label, connectivity, agents, runs, current status and the
  latest receipt, distinguishing hub metadata from Runtime run state, with stale and unavailable
  explicit rather than blank. Polling is enough; SSE, replay and backpressure are not in the MVP.
- **Drive:** create, drive, cancel — three actions, existing command IDs and drive receipts,
  `202` rendered as started/pending and never as completed, and handoff, refusal and uncertain
  states preserved. No checkpoint, no "mark passed", no retry, no arbitrary CLI, no config edit.

Two correctness facts the replan found and that the queue now gates, because they make an
operator believe something false rather than merely incomplete:

- A drive is **asynchronous**; a refresh, timeout or vague answer must not cause a repeat of the
  work or a claim that it passed. Poll the authoritative receipt after refresh; never
  auto-retry an uncertain effect.
- The selected Pi route currently infers success: `determineOutcome` can take an outcome **word**
  out of prose and otherwise returns `passed`
  ([pi-producer.ts:85](../plugins/kxm/src/pi-producer.ts)). Standalone Studio has the same class
  of bug in its mutation fallback. Hosted surfaces may not inherit either.

## Splitting work across boxes

A tenant has one hub, but not one machine: the portal backend, this box's Runtime, and worker
boxes all attach to the same hub. The failure mode is an operator reading "agents run on
multiple hosts" as "stages run on multiple hosts". They do not.

**What a stage can and cannot do.** `agent`/`moa` steps resolve to a local role and execute
through a producer that spawns a child on the box that owns the run
([pi-producer.ts:503](../plugins/kxm/src/pi-producer.ts)); every drive and receipt path is
guarded by `run.homeRuntimeId === context.homeRuntimeId`
([engine.ts:255](../plugins/kxm/src/engine.ts)). The engine contains no peer or remote
dispatch. A stage never runs on another box's CPU, and a remote box takes part by being an
**online peer in the hub** (`requireAgent`, `findTarget` → `target_not_found`,
[hub.ts:680](../plugins/kxm/src/hub.ts)) and by **owning its own runs**.

**Two stores, and the boundary that looks like data loss.**

| Lives here | Owned by |
|---|---|
| Run events, drive/receipt records, projections, gate evidence | the **Runtime event store on the box that owns the run** (`homeRuntimeId`) |
| Agents and online state, peer messages, workflow runs, checkpoints, waits and signals, hub-side evidence | the **hub store** (one per tenant box) |

`kxm runs get <id>` on another box will not find a run started here. That is correct, not
loss. Anything meant to be visible across boxes has to travel as a **message**, a
**checkpoint**, or a **signal**.

**The rule of thumb.** Same box → make it a **stage**. Different box → make it a **message
plus a signal**: `kxm peer send --target <agent>` hands work to a Pi process running there,
which does it with its own supervisor, session history and provider auth, then reports through
`kxm workflow checkpoint --run-id … --stage-id … --status passed --evidence …` and
`kxm workflow signal <runId> <signalKey> …`, which is what resumes a `wait` step here.
Evidence refs, not prose, are what keeps a reported pass from becoming a claim.

**Deliberately not available yet.**

- *Scheduling a stage onto a remote box's CPU* is the Phase 6 contract — verified workspace
  transfer, event cursors, reattachment, uncertain-effect recovery, secret grants.
  `kxm ssh run|file` already gives primitives and a receipt, but a connection lost mid-effect
  is not recoverable by contract. That is a decision, not a workaround: if a step needs it,
  Phase 6 should arrive on purpose.
- *A supervisor reachable across hosts.* Its boundary is a `0600` token file on loopback plus
  an HMAC proof; on a network that proof becomes the entire defence against an on-path
  impostor. Put a hub, or a local client, on that box instead.
- *A second hub per tenant.* A remote box is a **client** of the tenant hub with a project
  credential, so `context_isolation_violation` is what keeps its context reads inside the
  project — not a tenant id in the hub.

## The two decisions, settled

1. **The tenant owns the reverse-proxy configuration; KXM owns the contract, not the
   config.** Generating proxy files would make every upstream Caddy/nginx/Traefik/Authentik
   change ours, and a generated config reads as authoritative while one missing
   `request_header` directive silently re-opens header forgery. What generalises is a
   checklist, shipped as a `docs/operations.md` section with one labelled *example, not
   generated config* per stack: hub and supervisor bind loopback and publish no port; the
   proxy strips client-supplied identity, tenant, agent, caller and `Authorization` headers
   and then injects its own validated values; the proxy never injects the hub admin bearer,
   which would flatten every Authentik user to admin; TLS terminates at the proxy. The S5
   deployed witness proves it — unauthenticated denied, wrong tenant denied, and a forged
   identity or `Authorization` header cannot survive the proxy.
2. **`kxm hub bind` keeps its meaning, and the portal backend is just another machine
   client.** It writes a URL and probes `/health`; it stores no secret
   ([cli/hub.ts:194](../plugins/kxm/src/cli/hub.ts)), and credentials resolve separately
   through the existing precedence. So the portal backend binds to loopback per tenant
   workspace, and the tenant→endpoint and tenant→project maps live in the **portal's**
   config, never in KXM and never supplied by a browser. Two tightenings, both on existing
   verbs, no `kxm hub auth` family: (a) refuse a non-loopback bind when no credential can be
   resolved, mirroring the rule the hub applies to itself
   ([hub.ts:468](../plugins/kxm/src/hub.ts)) and naming the fix in the error; (b) label the
   binding loopback or remote in `kxm hub view` and `kxm session brief`, so
   "attached across a network to a hub I cannot authenticate to" is visible without reading
   files. What stays out: redefining `bind` for split-box transport — that is a Phase 6/8
   question about TLS and token scoping, and making the local case depend on the remote one
   is the mistake to avoid.

## Explicitly not in this plan

Hub user accounts or tables; per-user RBAC; a tenant table; SCIM; hub-side OIDC login, refresh,
introspection, cookie framework or session store; **hub-side interpretation of browser identity
headers, viewer/admin credential kinds and a `kxm hub auth` verb family** (all deleted from this
plan by the replan: the portal and Authentik already own that boundary, and a hub-side copy
brings a credential lifecycle into the critical path for no new capability); a public hub
listener; a new outpost, sidecar, container or VM; a general "forward this URL / run this CLI
string" endpoint; a new per-tenant rate-limit engine; a multi-process or HA hub; automatic
pruning of evidence or artifacts; `kxm hub footprint` as a product command (capacity comes from
filesystem sizes and existing proxy counters until a repeated manual measurement justifies the
command); **any** change to the hub or event-store schema; **any** PostgreSQL write path;
machine-credential rotation through browser commands.

## Deferred hardening (backlog, not plan)

Proxy header stripping proven by an integration fixture at the deployed edge; credential-store corruption recovery; rotation overlap window; `kxm doctor` as a real
command (there is none today) rather than stretching `kxm hub view` into two jobs. Track in
**Still open**; none of it blocks S1–S5.

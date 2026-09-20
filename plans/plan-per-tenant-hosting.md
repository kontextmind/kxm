---
schema: "kxm.doc.v1"
id: "PLAN-PER-TENANT-HOSTING"
type: "architecture"
title: "Per-tenant hub hosting: Authentik at the edge, token auth unchanged, no new database"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-20"
updated: "2026-09-20"
authority: "hypothesis"
confidence: "medium"
summary: "Proposed scope for hosting KXM per tenant with kxmd-portal: one tenant = one box = one hub, Authentik gates the browser at the reverse proxy, existing static-token auth stays the default, hub state stays SQLite, and cross-hub visibility comes from existing /v1 read models rather than a new database. Two MVP slices, the rest explicitly deferred."
tags: ["hub", "studio", "auth", "hosting", "mvp"]
related:
  - implementation-plan.md
  - plan-unified-kxm-milestones.md
  - plan-ssh-remote-execution.md
  - reviews/authentik-hosting-design-astra.md
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

One tenant = one box = one hub process = one `.kxm/state/kxm.db`. The hub gets a **tenant
label**, not a tenant table. Nothing in the hub stores another tenant's rows, so nothing in
the hub can leak them.

Consequence for capacity: the tenant's box is already provisioned for the portal. The hub is
**incremental disk and bandwidth on that box**, not another VM, not another container, not
another always-on service. Any design that implies one is wrong by construction.

### 2. Auth stays exactly as it is; hosting is additive

`KXM_AUTH_TOKEN` (admin bearer), `KXM_PROJECT_TOKENS`, the generated-and-persisted token in
the hub env record, `kxm hub bind <url>`, and the local loopback convenience all keep working,
unmodified, for anyone who does not deploy hosting. `kxm hub start` on a laptop must not change
behaviour, output, or credential precedence.

Hosting is **explicitly activated**, never inferred from which environment variables happen to be
set, and never silently downgraded (a hosted hub with a broken proxy must fail closed and name
the fix) nor silently upgraded (a local hub must not start trusting identity headers). One
command answers "which mode am I in, and why".

### 3. Authentik owns the browser; the hub owns authorization over its own data

Authentik terminates the browser session at the tenant's existing reverse proxy and forwards
validated identity to the hub on loopback. The hub does **not** implement an OIDC callback,
refresh tokens, a session store, cookie crypto, user accounts, per-user RBAC, or SCIM. It
validates what arrives, on loopback only, and refuses the rest.

Machine clients (portal backend, CLI, agents, MCP, Pi) keep using bearer/agent credentials on
the existing `/v1/` surface. A browser credential never satisfies `/v1/`, and a failed browser
assertion never falls back to bearer auth.

### 4. No PostgreSQL for the hub — and if we ever need it, one database per hub

Measured coupling, not taste:

| Fact | Count |
|---|---|
| `DatabaseSync` prepared-statement call sites in `plugins/kxm/src` | 120 |
| Distinct `CREATE TABLE` targets | 15 |
| Files importing the SQLite shim (`sqlite.ts`) | 9 |
| Hub store schema | `HUB_STORE_SCHEMA_VERSION = 3` ([store.ts:13](../plugins/kxm/src/store.ts)) |
| Runtime event store schema | v5, with v6 follow-ups already open ([runtime-store.ts](../plugins/kxm/src/runtime-store.ts), [implementation-plan.md](implementation-plan.md) Still open) |
| Backup/restore | `VACUUM INTO` + integrity check + manifest + restore ceiling ([database.ts:490](../plugins/kxm/src/database.ts)) |
| Transaction semantics we just hardened | `BEGIN IMMEDIATE`, per-connection busy throttle, contention classification by SQLite result code ([database.ts](../plugins/kxm/src/database.ts)) |

The single-tenant file *is* the isolation boundary, the backup unit, the restore unit, and the
migration unit. Replacing it means either rewriting those 120 call sites and every migration
lane, or maintaining two engines and doubling every test and backup path. That is not an MVP
cost, and it buys the operator nothing on day one: the hub's read models are already reachable
over HTTP.

**Ruling, in priority order:**

1. **Now:** hub state stays SQLite on the tenant box. Cross-hub visibility for the portal comes
   from the endpoints that already exist — `/v1/ops/snapshot`, `/v1/events`, `/v1/agents`,
   `/v1/messages`, `/v1/workflows`, `/v1/improvements` — which the portal reads with the tenant
   hub's own token. Portal-side aggregation belongs in the portal's database, wherever the
   portal wants it, and that choice is not the hub's problem.
2. **Later, on a named trigger:** if we need cross-hub SQL analytics/reporting, or the hub count
   outgrows per-box reads, add **one PostgreSQL database per hub**, populated by a **projection
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

## MVP: two slices

Both keep the event-store and hub-store schema at their current versions. Zero migration. One
named test each; `npm run verify` stays the only commit gate and the CI legs stay as they are —
no new scripts, no new jobs.

### Slice A — mode, boundary, and the browser surface that only reads (hub + CLI)

- Files: new `plugins/kxm/src/hub-auth.ts` (mode, config, credential validation); `hub.ts`
  (mount `/kxm/` on the **existing** listener; validate loopback peer, proxy credential,
  tenant match, subject, viewer/admin capability); `cli/hub.ts` + `cli.ts` (`kxm hub auth
  setup|status|rotate|revoke|disable`, `--json`, non-interactive, secrets from stdin only);
  `redact.ts` (proxy credential, browser credentials, session tokens); docs.
- Behaviour: hosted mode adds `/kxm/` browser routes and nothing else. Browser credentials
  cannot touch `/v1/`. Machine auth is untouched. With no config, the binary behaves as today.
- UI: the browser gets real states, not a token box — signed-out-with-proxy-link, proxied as
  viewer (read-only chrome, mutations disabled with a reason), wrong-tenant, expired,
  misconfigured-hub. Tenant name is in the header on every screen: an operator must never guess
  which hub they are looking at.
- **MVP gate for Slice A:** the existing fallback that answers a Studio mutation with
  `ok: true, mappedToCli: true` without executing anything ([studio-layout.ts:410](../plugins/kxm/src/studio-layout.ts),
  no `onMutation` supplied at [cli/tasks.ts](../plugins/kxm/src/cli/tasks.ts)) must not exist on
  the hosted path. A hosted mutation either executes with a real command receipt or returns a
  refusal. This is the one place where "we'll fix it later" is a false economy: a UI that lies
  about success makes every later improvement cycle guesswork.
- Named test: `hub-hosted-auth.test.ts` — public bind refused; forged/absent/mismatched proxy
  credential refused; wrong tenant refused; viewer mutation refused *before* any side effect;
  failed browser assertion never falls back to bearer; local mode byte-identical.

### Slice B — a handful of real actions, and the numbers we priced on (hub + CLI)

- Files: the closed typed command adapter for `/kxm/api` (each entry maps to an existing CLI
  command service and returns its real receipt); `cli/hub.ts` for `kxm hub footprint [--json]`;
  Studio actions for exactly those commands.
- Scope by use, not by surface: start with the four or five actions the operator actually
  performs from a browser — approve/reject an inbox item, retry or cancel a run, set pause,
  open a plan. Nothing else is wired until it is asked for.
- Named test: `studio-command-parity.test.ts` — every advertised action maps to a real command
  and a real receipt; no placeholder success; viewer rejected before side effect.
- Footprint reporting ships with it because the capacity claim in decision 1 is otherwise
  unmeasured: one command reports actual bytes (db + WAL + logs + retained messages + artifacts,
  counted once, `unknown` where unavailable) and external response volume, so disk/bandwidth
  budgeting is measured rather than argued.

Everything else in the longer design — dashboard read models beyond what Studio needs, extra
credentials, proxy template generation, hardening of the standalone Studio — is post-MVP and
lands through use.

## Explicitly not in this plan

Hub user accounts or tables; per-user RBAC; a tenant table; SCIM; hub-side OIDC login, refresh,
introspection, cookie framework or session store; a public hub listener; a new outpost,
sidecar, container or VM; a general "forward this URL / run this CLI string" endpoint; a new
per-tenant rate-limit engine; a multi-process or HA hub; automatic pruning of evidence or
artifacts; **any** change to the hub or event-store schema; **any** PostgreSQL write path.

## Deferred hardening (backlog, not plan)

Proxy header stripping proven by an integration fixture; timing-safe comparison of the proxy
secret; credential-store corruption recovery; rotation overlap window; `kxm doctor` as a real
command (there is none today) rather than `hub auth status` doing double duty. Track in
**Still open**; none of it blocks Slice A or B.

## Open item to resolve before Slice A merges

Where the proxy configuration itself lives (generated by us vs. owned by the tenant's existing
proxy with documented values to paste), and what `kxm hub bind` does on the portal side once a
hub is hosted. Both are small; both are the kind of thing that turns into a rewrite if we let
them.

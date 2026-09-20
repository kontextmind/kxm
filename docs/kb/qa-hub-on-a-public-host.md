---
schema: "kxm.doc.v1"
id: "KB-HUB-003"
type: "kb"
title: "Q&A: Hub on a public host — multiple users and projects?"
project: "kxm"
status: "draft"
owner: "@operator"
created: "2026-09-17"
updated: "2026-09-18"
authority: "instruction"
confidence: "reviewed"
summary: "One hub is one process and one state set per tenant box behind a TLS proxy; it is not multi-tenant and must never be exposed directly to the public internet. Hosting tenancy is the machine plus the portal, and the hub binds loopback."
tags: ["hub", "deployment", "security"]
related: ["docs/operations.md", "docs/kb/qa-authentik-authentication.md", "docs/kb/qa-what-the-hub-stores.md"]
---

# Q&A: Hub on a public host — multiple users and projects?

> Researched by `claude --model fable` (planner, read-only) · 2026-09-17 · task_40b9d5015537 · root review: pending

## Deploy today, step by step

The hub is a single Node process using plain `node:http` (`plugins/kxm/src/hub.ts:3`, `:1099`); there is no HTTPS or TLS code anywhere in the hub, so TLS must be terminated by a reverse proxy in front of it. The bind gate is code-enforced: if `KXM_HOST` is not loopback and no admin token is set, startup throws `KXM_AUTH_TOKEN is required when binding beyond localhost` (`hub.ts:116-119`, `:468-471`). Concretely an operator must:

1. Set `KXM_HOST` (defaults to `127.0.0.1`, `server.ts:13`) and `KXM_PORT`. Prefer keeping the hub on loopback or a private interface and letting the proxy reach it; binding `0.0.0.0` is allowed only with a token.
2. Set `KXM_AUTH_TOKEN` (admin/bearer token, compared with `safeTokenEqual` which wraps a timing-safe compare, `hub.ts:126-133`) and optionally `KXM_PROJECT_TOKENS` as a JSON object of project name to token (`server.ts:45-57`). Under `kxm hub start`, a missing admin token is generated and persisted with mode 0600 to the user state root (`hub-env.ts:44-46`, `:86-99`, `:140-193`, documented in `docs/operations.md:24-34`). The persisted file lives on the hub host, so protect that home directory.
3. Put a TLS-terminating reverse proxy in front, restrict inbound networks, and disable proxy buffering for the SSE endpoints (`docs/operations.md:181`). `README.md:261` states a non-loopback deployment "requires authentication, TLS termination, process supervision, and network access controls."
4. Run it under a supervisor with a stable working directory, injected secrets, restart on failure, and at least five seconds of graceful shutdown (`docs/operations.md:38`); the hub handles SIGINT/SIGTERM and closes SQLite (`server.ts:98-111`).
5. Configure webhook workflows via `KXM_WEBHOOK_WORKFLOWS` or `KXM_WEBHOOK_WORKFLOWS_FILE` (never both, `server.ts:67-74`), with secrets in `secretEnv`/`signalSecretEnv` (`docs/webhook-workflows.md:82-83`, `:103`).
6. Back up one SQLite file at `KXM_DATA_PATH` (default `.kxm/state/kxm.db`, `server.ts:20-22`). It runs in WAL mode; the documented safe backup is stop the hub, copy the db, restart and check `/ready`; online backups need a SQLite-aware tool or a consistent snapshot of db, `-wal`, and `-shm` (`docs/operations.md:147-160`). The DB is not encrypted at rest (`docs/operations.md:183`). Also back up `.kxm/skills/` and `.kxm/knowledge/` if used (`docs/operations.md:216-219`).
7. Only `/health` and `/ready` are unauthenticated and bypass rate limiting (`hub.ts:1111-1121`); `/metrics`, `/v1/ops/snapshot`, `/v1/ops/events` require the admin token (`hub.ts:1389-1405`).

## Multiple projects

One process owns one SQLite database (`README.md:255`, `docs/operations.md:3`); there is no per-project DB. Agents, messages, and workflow runs all live in the same tables, with `project` as a column (`store.ts:26-69`). `KXM_PROJECT_TOKENS` isolates only authentication: `requireProjectAuth` compares the bearer to `projectTokens[project] || authToken` (`hub.ts:495-508`). Consequences grounded in that line: a project listed in the map accepts only its own token, not the admin token, on agent routes; any project name not in the map falls back to the admin token, so the admin token can register agents into arbitrary new project names (`hub.ts:2091-2096`). Agents carry a per-agent key header in addition to the project bearer (`hub.ts:554-570`). Context/state operations fail closed across projects (`context_isolation_violation`, `hub.ts:514-531`, `docs/operations.md:223-226`). Whether ordinary peer messages can address an agent in another project is unknown from what was read; message reads are checked per agent id, not per project (`hub.ts:2402-2411`). Webhook workflows are pinned to a project by their definition (`hub.ts:1305`), not by caller token.

## Multiple users

The README classifies the hub as for "local or trusted-team agents" and explicitly "not a horizontally scaled or multi-tenant orchestration service" (`README.md:11`, `:253`), and says "Project tokens isolate hub access by project, but there are no per-user roles or external identity provider" (`README.md:256`). What is actually shared among all users: the one process, the one SQLite file with unencrypted message bodies (`docs/kxm-handbook.md:951`), the hub log at `.kxm/logs/kxm-hub.jsonl` (metadata only, `docs/operations.md:132`), the assets directory for retrospectives (`hub.ts:457-466`), and the in-memory rate-limit table. Blast radius of a leaked project token: register or resume agents in that project, read and send that project's messages, and read that project's context. Blast radius of a leaked admin token: everything above for every unlisted project, plus `/metrics`, ops snapshots and event streams for any project (`hub.ts:1389-1405`), context requests scoped to any project as `kxm-admin` (`hub.ts:525-530`), and workflow degradation approval (`hub.ts:543-552`, `cli/workflows.ts:437`). A leaked webhook `secret` lets an outsider start workflow runs; a leaked `signalSecret` lets them checkpoint waits for a known run and signal key (`hub.ts:1131`, `:1283`, `docs/webhook-workflows.md:137`). Remedy per docs is rotate and reconnect (`docs/operations.md:183`, `:194`).

## Honest limits

Clustering: "no clustering, leader election, or shared-state failover"; do not load-balance across hubs (`README.md:255`, `docs/operations.md:9`). Per-user roles: none, no IdP (`README.md:256`); the only identities are admin token, project token, and per-agent key. Rate limits: one in-memory fixed window keyed by the `x-kxm-agent-id` header, else the socket remote address (`hub.ts:572-590`); counters reset on restart (`README.md:259`); behind a reverse proxy the remote address is the proxy's, and the agent-id header is client-supplied, so this is a courtesy limit, not an abuse control. Webhook replay: HMAC-SHA256 over the exact body with `X-Hub-Signature-256`, no timestamp or nonce (`hub.ts:796-810`); replay is deduplicated by the delivery-id header per run or definition, and a reused id with a different body returns 409 (`hub.ts:1137-1148`, `:1294-1304`, `docs/webhook-workflows.md:135`). A replayed identical delivery is therefore idempotent but not rejected. Delivery is at-least-once, not exactly-once (`README.md:258`). Broader scale needs "shared state and coordination, external identity and fine-grained authorization, distributed traffic controls" (`docs/operations.md:207`). The ops guide states outright: "Never expose the hub directly to the public internet" (`docs/operations.md:183`).

## Recommendation

The smallest defensible topology as-is is one hub bound to loopback on a single host, behind a TLS reverse proxy (Caddy or nginx) that is the only public listener, with an IP allowlist or VPN in front of the proxy, admin token and a distinct project token for every project set via the supervisor's secret injection, webhook secrets set via `secretEnv`/`signalSecretEnv`, proxy buffering off for `/v1/events` and `/v1/ops/events`, and a nightly stopped-hub or SQLite-aware backup of `kxm.db`, `-wal`, `-shm` on encrypted disk. Treat "one hub" as one trust boundary: give one team the admin token and keep every project they run listed in `KXM_PROJECT_TOKENS` so the admin token stops working on agent routes. What not to do yet: serve unrelated teams or customers from one hub (the admin token and the shared unencrypted DB collapse all isolation); expose the port directly without a proxy; rely on the built-in rate limit as abuse protection; run two hubs behind a load balancer; or hand out the admin token to dashboards when a project token would do.

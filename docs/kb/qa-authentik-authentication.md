---
schema: "kxm.doc.v1"
id: "KB-HUB-001"
type: "kb"
title: "Q&A: Authentik (OIDC) for user/role/agent authentication"
project: "kxm"
status: "draft"
owner: "@operator"
created: "2026-09-17"
updated: "2026-09-18"
authority: "hypothesis"
confidence: "uncertain"
summary: "Authentik authenticates browsers at the reverse proxy and the tenant portal's backend calls the loopback hub with existing machine tokens. KXM does not interpret browser identity headers, and the hub-side JWT verification and token broker once recommended here are rejected, not deferred."
tags: ["hub", "authentik", "oidc", "auth"]
related: ["docs/operations.md", "docs/kb/qa-hub-on-a-public-host.md", "plans/plan-per-tenant-hosting.md", "plans/implementation-plan.md"]
---

# Q&A: Authentik (OIDC) for user/role/agent authentication

> Researched by `claude --model fable` (planner, read-only) · 2026-09-17 · task_c0bb05339e15 · root review: pending

**Short answer:** Yes, but not by swapping the hub's checks for OIDC. The hub has one shared-secret model, and the safest hook is a token broker that exchanges Authentik identity for the kxm tokens the hub already understands. Proxy forward-auth is the zero-code first step for humans; hub-side JWT validation is a later, additive gate.

## What exists today

The hub knows about three credentials. None of them carries a user identity, a role, or a group.

1. **Static admin token.** `MeshHubOptions.authToken` (`plugins/kxm/src/hub.ts:77`) is compared with `safeTokenEqual` (`hub.ts:126`, delegating to the SHA-256 `timingSafeEqual` in `commands.ts:937`) against the `Authorization: Bearer` header parsed by `bearerToken` (`hub.ts:130`). `requireAdminAuth` (`hub.ts:533`) gates `/metrics` (`hub.ts:1390`) and admin-scoped context calls (`hub.ts:525`). `requireConfiguredAdminAuth` (`hub.ts:543`) returns 503 `admin_auth_not_configured` when no token is set, gating `/v1/ops/snapshot` and `/v1/ops/events` (`hub.ts:1396`, `1406`) and workflow degradation. The token is sourced from `KXM_AUTH_TOKEN` (`server.ts:15`) or resolved via `resolveHubCredentials` (`hub-env.ts:140`), which generates `kxm_admin_<24 random bytes>` (`hub-env.ts:44`) and persists it to `hub-env.json` with mode 0600 (`hub-env.ts:86`). Auto-start injects it into the hub child's env (`hub-autostart.ts:175`).
2. **Per-project tokens.** `KXM_PROJECT_TOKENS` is a JSON map of project name to bearer string (`server.ts:45`, `hub-env.ts:120`). `expectedProjectToken` falls back to the admin token when no project token exists (`hub.ts:495`). `requireProjectAuth` (`hub.ts:499`) throws 401 `invalid_auth` on mismatch. Every agent-facing route calls `requireAgent` then `requireProjectAuth(request, agent.project)` (e.g. `hub.ts:1432`, `2133`, `2200`).
3. **Agent identity (name + key).** `POST /v1/agents/register` (`hub.ts:2091`) accepts a free-form `name`, `purpose`, `project`, `model`, requires only the project token, and mints a fresh `key` via `newId("key")` on every registration or resume (`hub.ts:2107`, `2115`). Name uniqueness is enforced only against currently online agents in the same project (`hub.ts:2098`). The record is stored as opaque JSON in the `agents` table (`store.ts:26`); `AgentRecord` (`protocol.ts:19`) has no role, owner, or principal field. Clients send `x-kxm-agent-id` and `x-kxm-agent-key` headers (`client.ts:540`), which `requireAgent` checks with `safeTokenEqual` (`hub.ts:554`).

**Fail-open edges to preserve or close.** With no admin token on a loopback bind, `requireAdminAuth` returns without checking (`hub.ts:534`) and `requireProjectAuth` skips when no expected token exists (`hub.ts:501`); `server.ts:92` warns `auth=none`. A non-loopback bind without a token refuses to start (`hub.ts:468`). Repo rule: "Bypass fail-closed identity checks" is on the do-not list (`AGENTS.md:224`).

**Roles and permissions today are not hub-authenticated.** Role definitions map to a `tools` allow/deny/preset block (`role.ts:63`-`137`), and the `role` on `/v1/context/get` is a caller-asserted string used only to pick a context budget and journal categories (`hub.ts:1578`, `arbiter.ts:81`). Tool policy is enforced client-side by `enforceToolPolicy` (`commands.ts:1125`), called from the MCP server (`mcp-server.ts:115`), the Pi extension (`extension.ts:892`), and the CLI (`cli.ts:220`). It reads `KXM_ATTEMPT_TOKEN`, then `KXM_SESSION_TOKEN`, then the on-disk `session.token` (`commands.ts:1130`, `1166`, `1182`), and returns `tool_policy_denied` when `isToolAllowed` (`commands.ts:1086`) rejects. Both token formats are unsigned base64url JSON (`mintAttemptToken` `commands.ts:916`, `mintSessionToken` `commands.ts:977`); `parseSessionToken` checks only schema and expiry (`commands.ts:998`). `kxm auth token --issue` mints an `operator` preset locally with no external identity (`cli/hub.ts:500`). The Studio mutate endpoint compares its session token with plain `!==` rather than the timing-safe helper (`studio-layout.ts:350`). No OIDC, JWT, or JWKS code exists in the repo; the only hits are prose in a role description (`init-guide-setup.ts:136`). The plugin has no JWT dependency (`plugins/kxm/package.json:9`).

## Integration options

### 1. Reverse-proxy forward-auth (Authentik outpost at the proxy; hub unchanged)

Authentik's proxy outpost authenticates browser sessions and passes headers upstream. The hub ignores those headers today, so the proxy must still inject the hub bearer token, or clients must still send it. Covers: Studio, `/v1/ops/*` dashboards, human CLI users via a browser-capable flow. Does not cover: agents (they present `x-kxm-agent-*` headers plus a bearer, not a cookie), and it gives the hub no per-user identity for logging. Effort: low, config only. Risk: low if the hub keeps its token check; medium if someone sets the proxy to add the admin token for every authenticated user, which flattens all Authentik users to admin. Non-loopback bind already requires a token (`hub.ts:468`), so the proxy cannot make the hub anonymous.

### 2. Hub validates Authentik-issued JWTs (OIDC discovery + JWKS)

Add a second accepted credential in `bearerToken`'s callers: if the bearer parses as a JWT, verify `iss`, `aud`, `exp`, and signature against a cached JWKS from `<issuer>/.well-known/openid-configuration`; else fall through to the existing `safeTokenEqual` path. Code changes: a new `oidc.ts` (discovery, JWKS cache, verify via `node:crypto` `createPublicKey` from JWK, or add `jose`), new `MeshHubOptions.oidc` and `KXM_OIDC_ISSUER` / `KXM_OIDC_AUDIENCE` env in `server.ts` and `hub-env.ts`, and changes to `requireAdminAuth` and `requireProjectAuth` to accept a verified claim set. Mapping: `groups` claim to admin (e.g. `kxm-admin`) and to project scope (e.g. `kxm-project:<name>`). Client side: `HubClient.authToken` (`client.ts:539`) already sends any string as bearer, so a client can pass an Authentik access token unchanged. Effort: medium, roughly 300 to 500 lines plus tests. Risk: medium. New network dependency at auth time (JWKS fetch must fail closed, never skip), clock skew, and the hub must reject `alg: none` and HS256. Agent registration would gain a real principal to store on the agent record (`sub`, `preferred_username`), which the schema can absorb since records are opaque JSON (`store.ts:26`).

### 3. Token-broker mapping (Authentik users/groups mint per-user or per-agent kxm tokens)

A small broker (could be a new hub route or a sidecar) accepts an Authentik ID token, verifies it as in option 2, then issues the tokens the runtime already consumes: a project token entry for `requireProjectAuth`, and a `kxm.session-token.v1` with a `toolPolicy` derived from the user's group (`mintSessionToken`, `commands.ts:944`). Mapping table: Authentik group to kxm role id (`role.ts:63` ids `writer`, `planner`, `critic-*`, `verifier`), role `tools` block to `ToolPolicy`, and group to project list to `projectTokens`. Today project tokens are a static map read at startup (`hub.ts:385`), so per-user project tokens need either a dynamic token store in `MeshStore` or short-lived tokens the hub can look up. Session tokens are unsigned (`commands.ts:977`), so a broker-issued one only means something if `parseSessionToken` gains signature verification; otherwise any local process can forge the same payload. Effort: medium to high, because it touches token storage, signing, and revocation. Risk: medium. Benefit: agents and humans converge on one identity source without changing every hub route.

## Recommendation (replaced 2026-09-20)

The staging below is **superseded**, and deliberately left visible because it was the plausible
answer for a month and someone will meet it again: **do not build a hub-side JWT verifier, a
token broker, per-user project tokens, or signed session/attempt token issuance as hosting
prerequisites.** They were a reasonable answer to "one hub, many users"; they are the wrong
answer to the deployment we actually have, which is **one tenant per box**.

1. **Now:** Authentik authenticates and authorizes browsers at the tenant's existing reverse
   proxy, on the **portal's** routes. The portal's server-side backend calls the loopback hub
   and supervisor using the machine credentials that already work (`KXM_AUTH_TOKEN`,
   `KXM_PROJECT_TOKENS`, the persisted hub env record). The hub binds loopback and exposes no
   public listener. Nothing in `hub.ts` changes, and no browser identity header reaches it.
2. **What stays as-is, unmodified:** the admin-token requirement for non-loopback binding, the
   generated-and-persisted token, project tokens read at startup, and the local loopback
   convenience. A browser-path outage denies browsers; it must not stop authorized machine
   clients.
3. **Not scheduled, only triggered:** hub-side JWT verification, group-to-`ToolPolicy`
   mapping, token signing, dynamic per-user token stores, and OAuth2 client-credentials or
   device-flow login for agents. Each returns to the queue only if a real requirement appears
   that the portal boundary cannot meet — for example genuine per-user attribution of hub
   writes inside KXM itself, which per-box tenancy does not need.

The technical observations underneath remain accurate and are the reason the option is *cheap to
reject*: unsigned session tokens (`commands.ts:977`), static project tokens read at startup
(`hub.ts:385`), a fixed-string `HubClient.authToken`, and a plain-string compare in
`studio-layout.ts:350`. **One item is kept as a live hardening note, not a hosting
prerequisite:** make that Studio compare timing-safe.

## Agent auth specifically

Running agents today authenticate non-interactively with whatever string lands in `HubClient.authToken`, resolved by `resolveClientHubAuthToken` (`hub-env.ts:203`): `KXM_AUTH_TOKEN` env, else the persisted project token, else the persisted admin token. The MCP server (`mcp-server.ts:84`) and the Pi extension (`extension.ts:709`) both use this. Pi worker children inherit `process.env` unchanged (`pi-producer.ts:504`), so they get the same token as the supervisor. Tool policy for workers comes from `KXM_ATTEMPT_TOKEN`, which is minted only in tests today (`test/core/commands-policy.test.ts:60`); no runtime path in `plugins/kxm/src` calls `mintAttemptToken`, so engine issuance is planned but not wired.

**Superseded paragraph, kept for the record (see the recommendation above):** with Authentik, agents should use the OAuth2 client-credentials grant (one Authentik application per agent class, or per role such as `writer` and `verifier`), obtain an access token at spawn, and pass it as `KXM_AUTH_TOKEN` to the child. This needs option 2 in the hub so the token verifies, and a refresh hook in `HubClient` since `headers()` reads a fixed string (`client.ts:539`) and access tokens expire. Device-code flow is the fallback for Claude Code sessions that start from a human terminal. Whether Authentik's client-credentials tokens carry `groups` claims by default is unknown from this repo; it must be confirmed against the Authentik provider config before mapping roles from claims.

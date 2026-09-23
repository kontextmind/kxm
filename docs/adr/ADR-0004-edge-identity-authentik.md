---
schema: "kxm.doc.v1"
id: "ADR-0004"
type: "adr"
title: "Edge identity with Authentik; the hub owns no browser identity"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-17"
updated: "2026-09-23"
authority: "decision"
confidence: "reviewed"
summary: "For a hosted, one-tenant-per-box deployment, Authentik authenticates browsers at the reverse proxy and a portal backend calls the loopback hub with existing machine credentials. Hub-side JWT verification and a token broker are rejected, not deferred."
tags: ["architecture", "decision", "hosting", "authentik", "oidc", "auth"]
related: ["docs/concepts/trust-model.md", "docs/operations/deploy.md", "docs/concepts/architecture.md"]
details:
  decision_drivers:
    - "One tenant per box, not one hub for many unrelated users"
    - "Keep the hub's machine credentials and loopback default unchanged"
    - "A browser-path outage must not stop authorized machine clients"
    - "No new identity code inside the hub"
  supersedes: null
  superseded_by: null
---

# ADR-0004: Edge identity with Authentik; the hub owns no browser identity

## Status

Accepted on 2026-09-20. This record replaces the research note "Authentik (OIDC) for user, role, and agent authentication". Options 2 and 3 below were the recommendation for about a month before this decision; they are recorded as rejected, not deferred.

## Context

KXM is hosted as **one tenant per box**: each tenant gets its own hub and Runtime on a dedicated machine, behind a web portal. Browsers need real user authentication for that portal. The question was where user identity should live.

The hub knows three machine credentials, and none carries a user, role, or group:

1. **The admin token** (`KXM_AUTH_TOKEN`), generated and saved by `kxm hub start` when absent. It gates admin routes such as `/metrics`, the operations stream, quorum degradation, and state promotion.
2. **Project tokens** (`KXM_PROJECT_TOKENS`), a static map read at startup. Every agent route checks the caller's project token.
3. **Agent keys**, minted at registration and rotated at every reconnect. An agent record has no owner or principal field.

The hub binds loopback by default and refuses to bind beyond loopback without an admin token. Roles and tool policies are not hub-authenticated: the role sent with a context request only selects a context budget and journal categories, and tool policy comes from unsigned, locally minted session tokens. No OIDC, JWT, or JWKS code exists in KXM.

## Decision drivers

1. The deployment is one tenant per box, not one shared hub for many unrelated users.
2. Machine clients (agents, the Runtime, and the portal backend) already authenticate with working credentials.
3. A failure on the browser path must deny browsers without stopping authorized machine clients.
4. The hub should not gain an identity subsystem, a network dependency at authentication time, or a token store.

## Considered options

1. **Forward authentication at the reverse proxy.** An Authentik proxy outpost authenticates browser sessions at the tenant's existing proxy. The hub is unchanged.
2. **Hub-side JWT verification.** The hub would accept Authentik-issued tokens, verify them against the issuer's keys, and map group claims to admin and project scope.
3. **A token broker.** A new service or hub route would accept an Authentik ID token and mint per-user project tokens and signed session tokens with tool policies derived from groups.

### Option 1: forward authentication at the proxy (chosen)

- Good, because it is configuration only: no hub code changes.
- Good, because the hub keeps its token check, and a non-loopback bind still requires a token, so the proxy cannot make the hub anonymous.
- Good, because an Authentik outage denies browsers but leaves machine clients working.
- Bad, because the hub records no per-user identity. The portal must keep its own user audit.
- Bad, because a misconfigured proxy that injects the admin token for every signed-in user would make every user a hub administrator.

### Option 2: hub-side JWT verification (rejected)

- Good, because hub writes could carry a real user principal.
- Bad, because it adds discovery, key caching, clock-skew handling, and algorithm restrictions to the hub, plus a network dependency at authentication time that must fail closed.
- Bad, because clients would need token refresh, since access tokens expire.

### Option 3: a token broker (rejected)

- Good, because agents and people would share one identity source.
- Bad, because project tokens are static at startup, so per-user tokens would need a dynamic token store in the hub.
- Bad, because a broker-issued session token means nothing until session tokens are signed and verified, which they are not.
- Bad, because it touches token storage, signing, and revocation at once.

## Decision

Authentik authenticates and authorizes browsers at each tenant's reverse proxy, on the portal's routes. The portal's server-side backend calls the loopback hub and Runtime supervisor with the machine credentials that already work. The hub binds loopback, exposes no public listener, and never receives or interprets a browser identity header.

These stay exactly as they are: the admin-token requirement for a non-loopback bind, the generated and saved admin token, project tokens read at startup, and loopback convenience for local use.

Hub-side JWT verification, mapping groups to tool policies, token signing, dynamic per-user token stores, and OAuth client-credentials or device-flow login for agents are **rejected, not deferred**. Reopening any of them requires a new written decision that names what the portal boundary cannot do, such as per-user attribution of hub writes inside KXM, which per-box tenancy does not need.

## Consequences

- Per-user identity, authorization, and audit belong to the portal and the proxy, not to KXM.
- Never configure the proxy to add the admin token to every authenticated request. The portal backend holds hub credentials server-side.
- Agents keep authenticating with project tokens. Holders of one project token remain one trust domain, as the [trust model](../concepts/trust-model.md) describes.
- Session tokens remain unsigned local tool-policy hints, not identity.
- One hardening item stays open and is not a hosting prerequisite: the Studio mutation endpoint compares its session token with a plain string comparison and should use a timing-safe one.

## Related

- [Trust model](../concepts/trust-model.md)
- [Deploy KXM](../operations/deploy.md)
- [Architecture](../concepts/architecture.md)
- [Architecture decision records](README.md)

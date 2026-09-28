---
schema: "kxm.doc.v1"
id: "ADR-0007"
type: "adr"
title: "Steel is reached only through Caddy and Authentik"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-27"
updated: "2026-09-27"
authority: "decision"
confidence: "verified"
summary: "The Steel server steel.kontextmind.com is an LXC behind Caddy and Authentik forward auth. Clients use the svc-steel credential. STEEL_API_KEY is not enforced. Playwright stays on Obscura."
tags: ["architecture", "decision", "browser", "steel", "authentik"]
related: ["docs/adr/ADR-0002-browser-automation-steel-doks.md", "docs/adr/ADR-0005-obscura-default-playwright.md", "docs/guides/browser-automation.md", "docs/adr/ADR-0006-machine-account-names.md"]
details:
  decision_drivers:
    - "Steel must not be reachable on the LAN, the tailnet, or a host forward"
    - "Authentik groups are the access list"
    - "Credentials stay in 1Password and are read into the process only"
  supersedes: "ADR-0002"
  superseded_by: null
---

# ADR-0007: Steel is reached only through Caddy and Authentik

## Status

Accepted on 2026-09-27. This record supersedes the DigitalOcean Kubernetes deployment in [ADR-0002](ADR-0002-browser-automation-steel-doks.md). [ADR-0005](ADR-0005-obscura-default-playwright.md) still makes Obscura the Playwright default. Steel remains the browser for remote and hosted sessions, human takeover, MFA, and the live session viewer.

## Context

Steel now runs as LXC 240 on the Proxmox host, at startup order 40. Its public name is `steel.kontextmind.com`. `steel.theneuro.me` is an alias of that same server. Caddy on VM 230 (`kxmd-proxy`) is the only listener, and it forwards authentication to Authentik. Direct LAN, tailnet, and host-forward access is blocked.

Sessions return `websocketUrl` `wss://steel.kontextmind.com/`. The previous value was `ws://steel-browser/`. Clients connect Chrome DevTools Protocol at `/v1/devtools` and send `Authorization` on the handshake. The URL does not carry a credential.

Steel and Caddy do not enforce `STEEL_API_KEY`. Clients authenticate as the Authentik user `svc-steel`.

## Decision drivers

1. The browser host is not a second network entrance beside the proxy.
2. Membership in a known Authentik group is the allow list.
3. The credential is read at runtime and is not written to disk.
4. Playwright tests keep the Obscura default from ADR-0005.

## Considered options

1. **Caddy plus Authentik forward auth, with direct paths blocked.**
2. **Keep the DOKS ingress and a Steel API key.**
3. **Publish the LXC on the tailnet or a host forward.**

### Option 1: Caddy and Authentik only (chosen)

- Good, because one proxy terminates TLS and applies the group check.
- Good, because a client that still sends `STEEL_API_KEY` does not get a session.
- Bad, because clients older than `kxm` 0.7.135 still expect `ws://steel-browser/`.

### Option 2: DOKS and `STEEL_API_KEY` (rejected)

- Good, because existing scripts that sent `x-steel-api-key` would keep working.
- Bad, because that cluster is no longer where Steel runs, and neither Steel nor Caddy checks the key.

### Option 3: tailnet or host-forward access (rejected)

- Good, because an operator on the tailnet could open the API without the proxy.
- Bad, because it bypasses Authentik and the group check.

## Decision

Reach Steel only at `https://steel.kontextmind.com` (alias `steel.theneuro.me`) through Caddy and Authentik forward auth. `STEEL_API_URL` defaults to `https://steel.kontextmind.com`.

Authenticate with the `svc-steel` credential. Precedence is `STEEL_AUTH_HEADER`, then `STEEL_AUTH_BASIC`, then `STEEL_AUTH_USER` together with `STEEL_AUTH_TOKEN`. Those variables override `STEEL_API_KEY`. `STEEL_API_KEY` is deprecated: Steel and Caddy do not enforce it, and a value in the URL is not accepted. Migrate by setting one of the three Authentik variables and dropping the key from the environment.

Read the credential from 1Password at runtime. The vault is `kontextmind`, the item is `Steel (svc-steel)`, and the field is `basic_auth`. Use `op read`. Do not write the value to disk.

```bash
export STEEL_AUTH_BASIC="$(op read 'op://kontextmind/Steel (svc-steel)/basic_auth')"
```

The CDP path is `/v1/devtools` with an `Authorization` header.

These Authentik groups may use the server: `steel-users`, `kxmd-users`, `kxmd-admins`, and `kxmd-owners`.

`kxm` 0.7.135 or newer is required. Playwright testing stays on Obscura unless `KXM_BROWSER=steel`.

## Consequences

- A connection to the LXC by LAN address, tailnet address, or host forward fails.
- A client that only sets `STEEL_API_KEY` is not authenticated.
- The `svc-steel` name is the live account. [ADR-0006](ADR-0006-machine-account-names.md) does not rename it ahead of an approved inventory.

## Related

- [ADR-0002](ADR-0002-browser-automation-steel-doks.md)
- [ADR-0005](ADR-0005-obscura-default-playwright.md)
- [Browser automation](../guides/browser-automation.md)
- [Deploy KXM](../operations/deploy.md#boot-the-kxmd-proxmox-host)

---
schema: "kxm.doc.v1"
id: "ADR-0002"
type: "adr"
title: "Self-hosted Steel on DOKS for reusable browser automation and human takeover"
project: "kxm"
status: "superseded"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-27"
authority: "decision"
confidence: "verified"
summary: "The 2026-09-14 choice of self-hosted Steel. The DOKS deployment in this record was superseded on 2026-09-27 by ADR-0007. Obscura is the Playwright default (ADR-0005)."
tags: ["architecture", "decision", "browser", "steel", "doks", "playwright"]
related: ["docs/guides/browser-automation.md", "docs/guides/agent-skills.md", "docs/adr/ADR-0005-obscura-default-playwright.md"]
details:
  decision_drivers:
    - "Eliminate per-minute SaaS browser provider costs"
    - "Support unified same-session human takeover for MFA and sensitive authentication"
    - "Provide dual exploratory (agent-browser) and regression (Playwright) interfaces"
    - "Enforce strict credential isolation via pass-cli"
  supersedes: null
  superseded_by: "ADR-0007"
---

# ADR-0002: Self-hosted Steel on DOKS for reusable browser automation

## Status

Superseded on 2026-09-27 by [ADR-0007](ADR-0007-steel-caddy-authentik.md) for where Steel runs and how clients authenticate. [ADR-0005](ADR-0005-obscura-default-playwright.md) keeps Obscura as the Playwright default. The sections below are the 2026-09-14 decision. They are not the current deployment. Steel and Caddy do not enforce `STEEL_API_KEY`.

## Context and problem statement

AI coding agents and orchestration workflows in KXM require browser interaction for UI exploration, DOM mapping, bug reproduction, and end-to-end regression testing. Existing approaches suffered from three core issues:

1. **High SaaS Costs**: Commercial cloud providers (e.g. Browserbase) charge steep per-session and per-minute pricing that conflicts with KXM's low-cost operating priority.
2. **Disconnected Human Takeover**: When login challenges, MFA prompts, or CAPTCHAs occur, local or headless cloud browsers cannot easily hand the live session over to a human operator and seamlessly resume without destroying session state.
3. **Tool Fragmentation**: Exploratory navigation needs a fast, token-efficient terminal CLI (`agent-browser`), while testing needs durable, assertion-rich frameworks (`Playwright`).

## Decision drivers

1. **Operating Cost Control**: Keep infrastructure expenses predictable by utilizing the maintainers' existing DigitalOcean Kubernetes Service (DOKS) cluster.
2. **Unified Same-Session Takeover**: Enable a human to interact with the exact same browser tab and session state during authentication gates before handing control back to the agent.
3. **Dual Automation Interfaces**: Support `agent-browser` for discovery and `Playwright` for permanent regression tests over standard Chrome DevTools Protocol (CDP).
4. **Authoritative Credential Management**: Ensure `pass-cli` remains the exclusive source of truth for secrets and API keys.

## Considered options

- **Option A**: Self-hosted Steel (`steel-dev/steel-browser`) deployed on DOKS with Ingress-NGINX and TLS.
- **Option B**: Paid SaaS browser providers (e.g., Browserbase, Steel Cloud).
- **Option C**: Local headless Chrome instances spawned on developer workstations.

## Evaluation and trade-offs

### Option A: self-hosted Steel on DOKS (chosen)

- **Good, because**: Zero marginal per-session fees; fully self-hosted on our Kubernetes cluster.
- **Good, because**: Built-in REST API, CDP WebSocket proxy, and live session viewer UI (`/ui`).
- **Good, because**: Both `Playwright` and `agent-browser` connect seamlessly over standard CDP (`wss://<steel-host>/v1/devtools`).
- **Good, because**: Dedicated shared memory (`/dev/shm`) and resource limits prevent workstation degradation.
- **Bad, because**: Requires managing Kubernetes deployment and periodic orphaned session sweeping.

### Option B: a paid SaaS browser provider

- **Good, because**: Managed scaling and proxy pools.
- **Bad, because**: Violates the core cost-efficiency constraint; introduces recurring credit card charges and third-party data transmission risks.

### Option C: local Chrome instances

- **Good, because**: No cluster deployment needed.
- **Bad, because**: High workstation memory and CPU pressure; fragile cross-platform headless setups; cannot easily share live debug sessions across multi-agent environments.

## Decision outcome

**Chosen Option**: **Option A (Self-hosted Steel on DOKS)**.

### Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                      KXM agent                              │
│   (kxm-browser-session, kxm-browser-takeover, pass-cli)     │
└───────────────┬─────────────────────────────┬───────────────┘
                │ REST API (create/release)   │ CDP WebSocket
                ▼                             ▼
┌─────────────────────────────────────────────────────────────┐
│                 DigitalOcean Kubernetes (DOKS)              │
│                 https://<steel-host>                        │
│                                                             │
│   ┌─────────────────────┐       ┌────────────────────────┐  │
│   │   Steel API & CDP   │◄─────►│    Chromium Sandbox    │  │
│   │     (Fastify)       │       │    (/dev/shm 2Gi)      │  │
│   └──────────┬──────────┘       └────────────────────────┘  │
│              │                                              │
│              ▼                                              │
│   ┌─────────────────────┐                                   │
│   │   Session Viewer    │ ◄─── Human Takeover (MFA/Auth)    │
│   │       (/ui)         │                                   │
│   └─────────────────────┘                                   │
└─────────────────────────────────────────────────────────────┘
```

## Confirmation and verification

- **Verification**: Health endpoint `$STEEL_API_URL/v1/health` verified with HTTP 200 and Let's Encrypt TLS.
- **Integration Test**: `test/core/browser.test.ts` validates session lifecycle, CDP endpoint formatting, takeover transitions, and secret redaction.
- **Security Check**: `pass-cli` was the credential store named in this 2026-09-14 decision. Current clients read the `svc-steel` credential with `op read`, as [ADR-0007](ADR-0007-steel-caddy-authentik.md) records.

## Related

- [Browser automation](../guides/browser-automation.md)
- [Agent skills](../guides/agent-skills.md)
- [Architecture decision records](README.md)

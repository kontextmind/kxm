---
schema: "kxm.doc.v1"
id: "ADR-0002"
type: "adr"
title: "Self-Hosted Steel on DOKS for Reusable Browser Automation and Human Takeover"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-14"
authority: "decision"
confidence: "verified"
summary: "Adopt self-hosted Steel on DigitalOcean Kubernetes (DOKS) with agent-browser and Playwright as KXM's primary browser automation infrastructure."
tags: ["architecture", "decision", "browser", "steel", "doks", "playwright"]
related: ["docs/browser-automation.md", "docs/agent-skills.md"]
details:
  decision_drivers:
    - "Eliminate per-minute SaaS browser provider costs"
    - "Support unified same-session human takeover for MFA and sensitive authentication"
    - "Provide dual exploratory (agent-browser) and regression (Playwright) interfaces"
    - "Enforce strict credential isolation via pass-cli"
  supersedes: null
  superseded_by: null
---

# ADR-0002: Self-Hosted Steel on DOKS for Reusable Browser Automation

## Context & Problem Statement

AI coding agents and orchestration workflows in KXM require browser interaction for UI exploration, DOM mapping, bug reproduction, and end-to-end regression testing. Existing approaches suffered from three core issues:

1. **High SaaS Costs**: Commercial cloud providers (e.g. Browserbase) charge steep per-session and per-minute pricing that conflicts with KXM's low-cost operating priority.
2. **Disconnected Human Takeover**: When login challenges, MFA prompts, or CAPTCHAs occur, local or headless cloud browsers cannot easily hand the live session over to a human operator and seamlessly resume without destroying session state.
3. **Tool Fragmentation**: Exploratory navigation needs a fast, token-efficient terminal CLI (`agent-browser`), while testing needs durable, assertion-rich frameworks (`Playwright`).

## Decision Drivers

1. **Operating Cost Control**: Keep infrastructure expenses predictable by utilizing our existing DigitalOcean Kubernetes Service (DOKS) cluster (`k8s-agentic-hub`).
2. **Unified Same-Session Takeover**: Enable a human to interact with the exact same browser tab and session state during authentication gates before handing control back to the agent.
3. **Dual Automation Interfaces**: Support `agent-browser` for discovery and `Playwright` for permanent regression tests over standard Chrome DevTools Protocol (CDP).
4. **Authoritative Credential Management**: Ensure `pass-cli` remains the exclusive source of truth for secrets and API keys.

## Considered Options

- **Option A**: Self-hosted Steel (`steel-dev/steel-browser`) deployed on DOKS with Ingress-NGINX and TLS.
- **Option B**: Paid SaaS browser providers (e.g., Browserbase, Steel Cloud).
- **Option C**: Local headless Chrome instances spawned on developer workstations.

## Evaluation & Tradeoff Matrix

### Option A: Self-hosted Steel on DOKS (Chosen)

- **Good, because**: Zero marginal per-session fees; fully self-hosted on our Kubernetes cluster.
- **Good, because**: Built-in REST API, CDP WebSocket proxy, and live session viewer UI (`/ui`).
- **Good, because**: Both `Playwright` and `agent-browser` connect seamlessly over standard CDP (`wss://steel.kontextmind.com/v1/devtools`).
- **Good, because**: Dedicated shared memory (`/dev/shm`) and resource limits prevent workstation degradation.
- **Bad, because**: Requires managing Kubernetes deployment and periodic orphaned session sweeping.

### Option B: Paid SaaS Browser Provider

- **Good, because**: Managed scaling and proxy pools.
- **Bad, because**: Violates the core cost-efficiency constraint; introduces recurring credit card charges and third-party data transmission risks.

### Option C: Local Chrome Instances

- **Good, because**: No cluster deployment needed.
- **Bad, because**: High workstation memory and CPU pressure; fragile cross-platform headless setups; cannot easily share live debug sessions across multi-agent environments.

## Decision Outcome

**Chosen Option**: **Option A (Self-hosted Steel on DOKS)**.

### Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                      KXM Agent / Herdr                      │
│   (kxm-browser-session, kxm-browser-takeover, pass-cli)     │
└───────────────┬─────────────────────────────┬───────────────┘
                │ REST API (create/release)   │ CDP WebSocket
                ▼                             ▼
┌─────────────────────────────────────────────────────────────┐
│                 DigitalOcean Kubernetes (DOKS)              │
│                 https://steel.kontextmind.com               │
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

## Confirmation & Verification Strategy

- **Verification**: Health endpoint `https://steel.kontextmind.com/v1/health` verified with HTTP 200 and Let's Encrypt TLS.
- **Integration Test**: `test/core/browser.test.ts` validates session lifecycle, CDP endpoint formatting, takeover transitions, and secret redaction.
- **Security Check**: `pass-cli` verified as the authoritative store for `STEEL_API_KEY` under vault `AI Provider Keys`.

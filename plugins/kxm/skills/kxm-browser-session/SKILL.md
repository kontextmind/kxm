---
name: kxm-browser-session
description: Start, attach to, inspect, and release self-hosted Steel browser sessions on DOKS with lifecycle safety and timeout controls.
---

# KXM Browser Session Management

Use this skill to create, inspect, attach automation tools to, and release isolated browser sessions running on self-hosted Steel infrastructure on DOKS (`https://steel.kontextmind.com`).

## Purpose & Scope

- Provide isolated, remote Chrome browser execution for AI agents and human operators.
- Support attaching `agent-browser` (exploratory automation) and `Playwright` (reproducible testing) via Chrome DevTools Protocol (CDP).
- Enforce lifecycle boundaries: ensure one session per task by default and prevent orphaned browser processes.
- Ensure automation clients attach to the intended remote session without launching unintended local browsers.

## Prerequisites

1. Access to DOKS Steel deployment (`https://steel.kontextmind.com` or alternate `https://steel.theneuro.me`).
2. `pass-cli` credential access for `STEEL_API_KEY` (stored under `AI Provider Keys` -> `Steel Browser (KontextMind DOKS)`).
3. Network access to remote CDP endpoints on port 443 / 9223.

## Session Lifecycle States

```text
[CREATE_SESSION]
       │
       ▼
[AGENT_CONTROL] ◄────────┐
       │                 │
       ▼                 │
[AUTH_REQUIRED]          │
       │                 │
       ▼                 │
[HUMAN_CONTROL]          │
       │                 │
       ▼                 │
[VERIFY_AUTHENTICATION] ─┘
       │
       ▼
[RELEASE_SESSION]
```

## Inputs & Outputs

- **Inputs**: Task ID, target URL, session timeout (default 300s, max 1800s), optional proxy or viewport dimensions.
- **Outputs**:
  - `sessionId`: Unique session UUID.
  - `cdpUrl`: Remote CDP WebSocket URL (`wss://steel.kontextmind.com/v1/devtools?sessionId=<id>&apiKey=<key>`).
  - `sessionViewerUrl`: Interactive web session viewer URL (`https://steel.kontextmind.com/ui?sessionId=<id>`).
  - `status`: `live` | `idle` | `released`.

## Workflow

### 1. Launching a Session

Query the Steel API to create a new isolated browser session:

```bash
curl -s -X POST https://steel.kontextmind.com/v1/sessions \
  -H "Content-Type: application/json" \
  -H "x-steel-api-key: $(pass-cli item view --vault-name 'AI Provider Keys' --item-title 'Steel Browser (KontextMind DOKS)' --field STEEL_API_KEY)" \
  -d '{"timeout": 300000}'
```

### 2. Attaching Automation Clients

- **Playwright**: Connect via `chromium.connectOverCDP(cdpUrl)`.
- **agent-browser**: Connect using `agent-browser --cdp "<cdpUrl>"`.

### 3. Inspecting Session State

Check session activity, duration, and status:

```bash
curl -s https://steel.kontextmind.com/v1/sessions/<sessionId> \
  -H "x-steel-api-key: $(pass-cli item view --vault-name 'AI Provider Keys' --item-title 'Steel Browser (KontextMind DOKS)' --field STEEL_API_KEY)"
```

### 4. Releasing the Session

Always release the session at task completion:

```bash
curl -s -X POST https://steel.kontextmind.com/v1/sessions/<sessionId>/release \
  -H "x-steel-api-key: $(pass-cli item view --vault-name 'AI Provider Keys' --item-title 'Steel Browser (KontextMind DOKS)' --field STEEL_API_KEY)"
```

## Safety & Governance Invariants

- **No Secret Leaks**: Never print raw `STEEL_API_KEY` or tokens into terminal logs or prompts.
- **Single Controller**: Only one automation client or human controls the session at a time.
- **Client Disconnect vs Session Release**: Disconnecting Playwright/agent-browser disconnects the client but preserves the remote session for human takeover until explicitly released.
- **No Profile Sharing**: Concurrent sessions must not write to the same profile state.

---
name: kxm-browser-session
description: Start, attach to, inspect, and release self-hosted Steel browser sessions with lifecycle safety and timeout controls.
---

# KXM Browser Session Management

Use this skill to create, inspect, attach automation tools to, and release isolated browser sessions running on your self-hosted Steel deployment. Set `STEEL_API_URL` (and optionally `STEEL_UI_URL`) to your deployment; KXM does not provide one.

## Purpose & Scope

- Provide isolated, remote Chrome browser execution for AI agents and human operators.
- Support attaching `agent-browser` (exploratory automation) and `Playwright` (reproducible testing) via Chrome DevTools Protocol (CDP).
- Enforce lifecycle boundaries: ensure one session per task by default and prevent orphaned browser processes.
- Ensure automation clients attach to the intended remote session without launching unintended local browsers.

## Prerequisites

1. Your own Steel deployment, with `STEEL_API_URL` set to its base URL (for example `https://steel.example.com`) and `STEEL_UI_URL` set if the viewer lives elsewhere (default `$STEEL_API_URL/ui`).
2. `STEEL_API_KEY` exported in the environment, for example from your password manager: `export STEEL_API_KEY="$(pass-cli item view --vault-name '<vault>' --item-title '<item>' --field STEEL_API_KEY)"`. Never paste the key into a prompt.
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
  - `cdpUrl`: Remote CDP WebSocket URL (`wss://<steel-host>/v1/devtools?sessionId=<id>&apiKey=<key>`).
  - `sessionViewerUrl`: Interactive web session viewer URL (`$STEEL_UI_URL?sessionId=<id>`).
  - `status`: `live` | `idle` | `released`.

## Workflow

### 1. Launching a Session

Query the Steel API to create a new isolated browser session:

```bash
printf 'x-steel-api-key: %s\n' "$STEEL_API_KEY" | curl -sS -X POST "$STEEL_API_URL/v1/sessions" \
  -H @- -H "Content-Type: application/json" \
  -d '{"timeout": 300000}'
```

### 2. Attaching Automation Clients

- **Playwright**: Connect via `chromium.connectOverCDP(cdpUrl)`.
- **agent-browser**: Connect using `agent-browser --cdp "<cdpUrl>"`.

### 3. Inspecting Session State

Check session activity, duration, and status:

```bash
printf 'x-steel-api-key: %s\n' "$STEEL_API_KEY" | curl -sS -H @- "$STEEL_API_URL/v1/sessions/<sessionId>"
```

### 4. Releasing the Session

Always release the session at task completion:

```bash
printf 'x-steel-api-key: %s\n' "$STEEL_API_KEY" | curl -sS -X POST -H @- "$STEEL_API_URL/v1/sessions/<sessionId>/release"
```

## Safety & Governance Invariants

- **No Secret Leaks**: Never print raw `STEEL_API_KEY` or tokens into terminal logs or prompts.
- **Single Controller**: Only one automation client or human controls the session at a time.
- **Client Disconnect vs Session Release**: Disconnecting Playwright/agent-browser disconnects the client but preserves the remote session for human takeover until explicitly released.
- **No Profile Sharing**: Concurrent sessions must not write to the same profile state.

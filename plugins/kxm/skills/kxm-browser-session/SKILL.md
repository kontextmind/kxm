---
name: kxm-browser-session
description: Start, attach to, inspect, and release self-hosted Steel browser sessions with lifecycle safety and timeout controls. Playwright testing uses Obscura unless KXM_BROWSER=steel.
---

# KXM Browser Session Management

Use this skill to create, inspect, attach automation tools to, and release isolated browser sessions running on your self-hosted Steel deployment. Set `STEEL_API_URL` (and optionally `STEEL_UI_URL`) to your deployment; KXM does not provide one.

Playwright testing and verification use Obscura by default (`resolveBrowserCdpEndpoint()`, or `npm run e2e`). Use this skill's Steel session for human takeover, MFA, and the live session viewer. Attach Playwright to that session only when `KXM_BROWSER=steel`.

## Purpose & Scope

- Provide isolated, remote Chrome browser execution for AI agents and human operators.
- Support attaching `agent-browser` (exploratory automation) and `Playwright` (reproducible testing) via Chrome DevTools Protocol (CDP).
- Enforce lifecycle boundaries: ensure one session per task by default and prevent orphaned browser processes.
- Ensure automation clients attach to the intended remote session without launching unintended local browsers.

## Prerequisites

1. Your own Steel deployment, with `STEEL_API_URL` set to its base URL (for example `https://steel.example.com`) and `STEEL_UI_URL` set if the viewer lives elsewhere (default `$STEEL_API_URL/ui`).
2. Authentik app-password auth in the environment. The KontextMind Steel hosts are behind Authentik forward auth, which accepts `Authorization: Basic` and refuses a Bearer token. Export `STEEL_AUTH_USER` and `STEEL_AUTH_TOKEN` (or the pre-encoded `STEEL_AUTH_BASIC`) from your password manager, for example `export STEEL_AUTH_TOKEN="$(pass-cli item view --vault-name '<vault>' --item-title '<item>' --field password)"`. Never paste the token into a prompt. `STEEL_API_KEY` is a deprecated shim (`x-steel-api-key` and `?apiKey=`); do not put credentials in URLs.
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
  - `cdpUrl`: Remote CDP WebSocket URL (`wss://<steel-host>/v1/devtools?sessionId=<id>`). Send `Authorization: Basic` on the handshake. The URL has no credential when Authentik auth is configured.
  - `sessionViewerUrl`: Interactive web session viewer URL (`$STEEL_UI_URL?sessionId=<id>`).
  - `status`: `live` | `idle` | `released`.

## Workflow

### 1. Launching a Session

Query the Steel API to create a new isolated browser session:

```bash
basic="$(printf '%s:%s' "$STEEL_AUTH_USER" "$STEEL_AUTH_TOKEN" | base64 | tr -d '\n')"
printf 'Authorization: Basic %s\n' "$basic" | curl -sS -X POST "$STEEL_API_URL/v1/sessions" \
  -H @- -H "Content-Type: application/json" \
  -d '{"timeout": 300000}'
```

Use `STEEL_AUTH_BASIC` in place of the computed value when that variable is already set. `STEEL_AUTH_HEADER`, when set, is the full `Authorization` value and wins over both.

### 2. Attaching Automation Clients

- **Playwright**: Tests connect to Obscura through the worker-scoped `browser` fixture and `connectBrowserOverCdp()`. For a Steel takeover session, set `KXM_BROWSER=steel` and pass a session id. That path calls `chromium.connectOverCDP(url, { headers })` with the headers from `formatCDPConnect()`.
- **agent-browser**: `--cdp` accepts a URL only and cannot send the Authentik header. Use Playwright against an Authentik-protected host. Do not put the credential in the CDP URL.

### 3. Inspecting Session State

Check session activity, duration, and status:

```bash
printf 'Authorization: Basic %s\n' "$basic" | curl -sS -H @- "$STEEL_API_URL/v1/sessions/<sessionId>"
```

### 4. Releasing the Session

Always release the session at task completion:

```bash
printf 'Authorization: Basic %s\n' "$basic" | curl -sS -X POST -H @- "$STEEL_API_URL/v1/sessions/<sessionId>/release"
```

## Safety & Governance Invariants

- **No Secret Leaks**: Never print raw `STEEL_AUTH_TOKEN`, `STEEL_AUTH_BASIC`, `STEEL_API_KEY`, or tokens into terminal logs or prompts. Never put them in a URL.
- **Single Controller**: Only one automation client or human controls the session at a time.
- **Client Disconnect vs Session Release**: Disconnecting Playwright/agent-browser disconnects the client but preserves the remote session for human takeover until explicitly released.
- **No Profile Sharing**: Concurrent sessions must not write to the same profile state.

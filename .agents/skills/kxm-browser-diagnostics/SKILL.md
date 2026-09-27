---
name: kxm-browser-diagnostics
description: Diagnose and recover from Steel connectivity failures, CDP attachment issues, session timeouts, and orphaned browsers.
---

# KXM Browser Diagnostics and Recovery

Use this skill to investigate and resolve connectivity failures, CDP attachment errors, session timeouts, profile contention, and orphaned browser resources.

## Common Failure Modes & Resolutions

### 1. Steel API Connectivity / Authentik challenge

- **Symptom**: `Steel request was redirected (302)` to `id.kxmd.dev`, `Failed to fetch Steel session (401)`, or `Connection refused`.
- **Diagnosis**:
  - KontextMind Steel is behind Authentik forward auth. Unauthenticated requests redirect to `id.kxmd.dev`. Authentik accepts an app password only as `Authorization: Basic`. A Bearer token is refused.
  - Check that `STEEL_AUTH_BASIC` is set, or that both `STEEL_AUTH_USER` and `STEEL_AUTH_TOKEN` are set (`test -n "$STEEL_AUTH_TOKEN" && echo set`); never print the value.
  - `STEEL_API_KEY` is deprecated. Steel and Caddy do not enforce it. Do not put a credential in the URL. Direct LAN, tailnet, and host-forward connections are blocked.
  - `websocketUrl` `ws://steel-browser/` means the client is older than `kxm` 0.7.135. The server returns `wss://steel.kontextmind.com/`.
- **Remedy**: Re-read the `svc-steel` field `basic_auth` with `op read 'op://kontextmind/Steel (svc-steel)/basic_auth'` into `STEEL_AUTH_BASIC`. Do not log it or write it to disk. Precedence is `STEEL_AUTH_HEADER`, then `STEEL_AUTH_BASIC`, then `STEEL_AUTH_USER` and `STEEL_AUTH_TOKEN`.

### 2. CDP WebSocket Attachment Failure

- **Symptom**: `WebSocket connection to wss://... failed: 404/500`.
- **Diagnosis**:
  - Check if the target session ID has already been released or timed out.
  - The CDP path is `/v1/devtools` on `wss://steel.kontextmind.com/` with an `Authorization` header. Caddy must pass the WebSocket upgrade. A credential in the URL is not accepted.
- **Remedy**: Query `GET /v1/sessions/<id>` with the same `Authorization` header. If status is `released`, launch a fresh session.

### 3. Session Timeout & Expiration

- **Symptom**: Session drops abruptly during human takeover or long idling.
- **Diagnosis**: Steel enforces a default session timeout (300s–1800s).
- **Remedy**:
  - If a long human task is required, set a higher initial `timeout` parameter during session creation (e.g. `1800000` ms for 30 minutes).
  - On expiration, do not claim continuity: inform the operator and launch a clean session.

### 4. Interactive Takeover Viewer Inaccessible

- **Symptom**: `$STEEL_UI_URL` opens but cannot interact with elements.
- **Diagnosis**: Self-hosted Steel OSS serves the session screencast and devtools.
- **Remedy**: Connect directly to the devtools inspector URL: `$STEEL_API_URL/v1/devtools/inspector.html` or open the browser devtools panel to perform input actions.

### 5. Orphaned Browser Processes & Cleanup

- **Symptom**: Node memory pressure or high active session counts.
- **Diagnosis**: Query active sessions list. Send the same Basic header as session create: `basic="$(printf '%s:%s' "$STEEL_AUTH_USER" "$STEEL_AUTH_TOKEN" | base64 | tr -d '\n')"; printf 'Authorization: Basic %s\n' "$basic" | curl -sS -H @- "$STEEL_API_URL/v1/sessions"`.
- **Remedy**:
  - Iterate through inactive sessions and post `/release` for each stale ID.
  - Ensure all automation scripts wrap browser usage in `try...finally` to release sessions reliably.

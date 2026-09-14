---
name: kxm-browser-diagnostics
description: Diagnose and recover from Steel connectivity failures, CDP attachment issues, session timeouts, and orphaned browsers.
---

# KXM Browser Diagnostics and Recovery

Use this skill to investigate and resolve connectivity failures, CDP attachment errors, session timeouts, profile contention, and orphaned browser resources.

## Common Failure Modes & Resolutions

### 1. Steel API Connectivity / 401 Unauthorized

- **Symptom**: `Failed to fetch Steel session (401)` or `Connection refused`.
- **Diagnosis**:
  - Verify Steel API endpoint is reachable: `curl -sI https://steel.kontextmind.com/v1/health`.
  - Check `STEEL_API_KEY` in `pass-cli`: `pass-cli item view --vault-name "AI Provider Keys" --item-title "Steel Browser (KontextMind DOKS)"`.
- **Remedy**: Update expired or missing API key in your session environment.

### 2. CDP WebSocket Attachment Failure

- **Symptom**: `WebSocket connection to wss://... failed: 404/500`.
- **Diagnosis**:
  - Check if the target session ID has already been released or timed out.
  - Verify ingress WebSocket headers: ensure `nginx.ingress.kubernetes.io/websocket-services` is enabled.
- **Remedy**: Query `GET /v1/sessions/<id>`. If status is `released`, launch a fresh session.

### 3. Session Timeout & Expiration

- **Symptom**: Session drops abruptly during human takeover or long idling.
- **Diagnosis**: Steel enforces a default session timeout (300s–1800s).
- **Remedy**:
  - If a long human task is required, set a higher initial `timeout` parameter during session creation (e.g. `1800000` ms for 30 minutes).
  - On expiration, do not claim continuity: inform the operator and launch a clean session.

### 4. Interactive Takeover Viewer Inaccessible

- **Symptom**: `https://steel.kontextmind.com/ui` opens but cannot interact with elements.
- **Diagnosis**: Self-hosted Steel OSS serves the session screencast and devtools.
- **Remedy**: Connect directly to the devtools inspector URL: `https://steel.kontextmind.com/v1/devtools/inspector.html` or open the browser devtools panel to perform input actions.

### 5. Orphaned Browser Processes & Cleanup

- **Symptom**: Node memory pressure or high active session counts.
- **Diagnosis**: Query active sessions list: `curl -s https://steel.kontextmind.com/v1/sessions`.
- **Remedy**:
  - Iterate through inactive sessions and post `/release` for each stale ID.
  - Ensure all automation scripts wrap browser usage in `try...finally` to release sessions reliably.

---
schema: "kxm.doc.v1"
id: "PROMPT-BROWSER-004"
type: "prompt"
title: "Diagnosing and Recovering a Failed Browser Session"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-15"
authority: "instruction"
confidence: "verified"
summary: "Troubleshoot unresponsive Steel sessions, CDP attachment errors, auth loops, and orphaned browser containers."
tags: ["browser", "diagnostics", "recovery", "prompt"]
related: ["docs/browser-automation.md", "docs/kb/how-to-recover-expired-session-or-orphan.md"]
---

# Task Template: Diagnosing and Recovering a Failed Browser Session

## Purpose

Use this prompt to troubleshoot unresponsive sessions, CDP attachment errors, authentication loops, or orphaned browser containers on DOKS Steel infrastructure.

## Canonical Skill References

- `kxm-browser-diagnostics`
- `kxm-browser-session`

## Parameters & Placeholders

- **PROJECT_ID**: `{{PROJECT_ID}}`
- **SESSION_ID**: `{{SESSION_ID}}` (Optional, if specific session is failing)
- **FAILURE_SYMPTOM**: `{{FAILURE_SYMPTOM}}` (e.g. `CDP_ATTACHMENT_FAILED` | `TIMEOUT_EXPIRED` | `AUTH_LOOP` | `ORPHAN_CLEANUP`)
- **MAX_IDLE_MINUTES**: `{{MAX_IDLE_MINUTES}}` (Default: `10`)

---

## Instructions for Agent

1. **Check Steel Health**:
   - Query `https://steel.kontextmind.com/v1/health`.
   - If HTTP 200, Steel server and Chromium engine are healthy.

2. **Inspect Session Status**:
   - If `{{SESSION_ID}}` is provided: query `GET /v1/sessions/{{SESSION_ID}}`.
   - If status is `released`, report that the session expired and launch a fresh replacement.

3. **Check for Orphaned Sessions**:
   - Query all active sessions: `GET /v1/sessions`.
   - Identify sessions older than `{{MAX_IDLE_MINUTES}}` minutes that are not actively bound to a running task.
   - For each orphan, invoke `POST /v1/sessions/:id/release`.

4. **Verify WebSocket / CDP Ingress**:
   - Ensure WebSocket upgrades are properly proxied through `nginx.ingress.kubernetes.io/websocket-services: "steel"`.
   - If CDP fails with 401, verify `x-steel-api-key` header or `?apiKey=` query parameter.

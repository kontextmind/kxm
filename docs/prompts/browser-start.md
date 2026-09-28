---
schema: "kxm.doc.v1"
id: "PROMPT-BROWSER-001"
type: "prompt"
title: "Start browser work in a KXM project"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-27"
authority: "instruction"
confidence: "verified"
summary: "Initialize a remote Steel browser session for a project task, verifying credentials, connectivity, and attachment endpoints before automation."
tags: ["browser", "steel", "session", "prompt"]
related: ["docs/guides/browser-automation.md", "docs/kb/how-credentials-retrieved-safely.md"]
---

# Task template: start browser work in a KXM project

## Purpose

Use this prompt to initialize a remote browser session on self-hosted Steel for a specific project task, verifying infrastructure connectivity, credentials, and attachment endpoints before executing automation.

## Canonical skill references

- `kxm-browser-session`
- `kxm-browser-auth`

## Parameters and placeholders

- **PROJECT_ID**: `{{PROJECT_ID}}` (e.g. `my-app`)
- **STEEL_API_URL**: `{{STEEL_API_URL}}` (your Steel API base URL, from `STEEL_API_URL`)
- **TASK_ID**: `{{TASK_ID}}` (e.g. `TASK-104-AUTH-VERIFY`)
- **TARGET_BASE_URL**: `{{TARGET_BASE_URL}}` (e.g. `https://staging.app.example.com`)
- **PERMISSION_LEVEL**: `{{PERMISSION_LEVEL}}` (Choose one: `INSPECT_ONLY` | `MUTATE_APPROVED_FORMS` | `FULL_ADMIN`)
- **CREDENTIAL_REF**: `{{CREDENTIAL_REF}}` (a secret manager reference, never a value, e.g. `<vault> -> <item>`)
- **ARTIFACT_DIR**: `{{ARTIFACT_DIR}}` (e.g. `.kxm/artifacts/browser/{{TASK_ID}}`)
- **TIMEOUT_MS**: `{{TIMEOUT_MS}}` (Default: `300000`)

---

## Instructions for the agent

1. **Verify Credential Reference**:
   - Resolve the `svc-steel` credential with `op read 'op://kontextmind/Steel (svc-steel)/basic_auth'` into `STEEL_AUTH_BASIC` (or set `STEEL_AUTH_HEADER`, or `STEEL_AUTH_USER` and `STEEL_AUTH_TOKEN`). Do not log the value or write it to disk. A Bearer token is not accepted. `STEEL_API_KEY` is deprecated and is not enforced. Keep the credential in a header, not a URL. `STEEL_API_URL` defaults to `https://steel.kontextmind.com`. `kxm` 0.7.135 or newer is required.
   - Do not print credentials to the chat or save them to tracked files.

2. **Launch Remote Steel Session**:
   - Create a session with `POST {{STEEL_API_URL}}/v1/sessions` and timeout `{{TIMEOUT_MS}}`.
   - Capture `sessionId`, `websocketUrl`, and `sessionViewerUrl`.

3. **Verify Target Endpoint Connectivity**:
   - Connect Playwright via CDP with the headers from `formatCDPConnect()` (`Authorization: Basic`). Do not put the credential in the URL. `agent-browser --cdp` cannot send that header.
   - Navigate to `{{TARGET_BASE_URL}}` within `{{PERMISSION_LEVEL}}` constraints.
   - If `PERMISSION_LEVEL` is `INSPECT_ONLY`, do not click submit buttons or mutate forms.

4. **Prepare Task Environment**:
   - Ensure `{{ARTIFACT_DIR}}` exists for diagnostic outputs and trace recordings.
   - Report active session status and ready state.

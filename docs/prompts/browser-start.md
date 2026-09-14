# Task Template: Starting Browser Work in a KXM Project

## Purpose

Use this prompt to initialize a remote browser session on self-hosted Steel for a specific project task, verifying infrastructure connectivity, credentials, and attachment endpoints before executing automation.

## Canonical Skill References

- `kxm-browser-session`
- `kxm-browser-auth`

## Parameters & Placeholders

- **PROJECT_ID**: `{{PROJECT_ID}}` (e.g. `kxm`, `agentic-hub`, `southlake-technical`)
- **TASK_ID**: `{{TASK_ID}}` (e.g. `TASK-104-AUTH-VERIFY`)
- **TARGET_BASE_URL**: `{{TARGET_BASE_URL}}` (e.g. `https://staging.app.example.com`)
- **PERMISSION_LEVEL**: `{{PERMISSION_LEVEL}}` (Choose one: `INSPECT_ONLY` | `MUTATE_APPROVED_FORMS` | `FULL_ADMIN`)
- **CREDENTIAL_REF**: `{{CREDENTIAL_REF}}` (Proton Pass vault and item title, e.g. `Personal -> staging.example.com`)
- **ARTIFACT_DIR**: `{{ARTIFACT_DIR}}` (e.g. `.kxm/artifacts/browser/{{TASK_ID}}`)
- **TIMEOUT_MS**: `{{TIMEOUT_MS}}` (Default: `300000`)

---

## Instructions for Agent

1. **Verify Credential Reference**:
   - Query `pass-cli` for target credentials and `STEEL_API_KEY` without logging raw values.
   - Do not print credentials to the chat or save them to tracked files.

2. **Launch Remote Steel Session**:
   - Create a session on `https://steel.kontextmind.com/v1/sessions` with timeout `{{TIMEOUT_MS}}`.
   - Capture `sessionId`, `websocketUrl`, and `sessionViewerUrl`.

3. **Verify Target Endpoint Connectivity**:
   - Connect `agent-browser` or `Playwright` via CDP.
   - Navigate to `{{TARGET_BASE_URL}}` within `{{PERMISSION_LEVEL}}` constraints.
   - If `PERMISSION_LEVEL` is `INSPECT_ONLY`, do not click submit buttons or mutate forms.

4. **Prepare Task Environment**:
   - Ensure `{{ARTIFACT_DIR}}` exists for diagnostic outputs and trace recordings.
   - Report active session status and ready state.

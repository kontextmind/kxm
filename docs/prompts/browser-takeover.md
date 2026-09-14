# Task Template: Requesting Human Authentication and Resuming Afterward

## Purpose

Use this prompt to pause automation and request operator intervention for multi-factor authentication (MFA), OAuth consent, credential challenges, or CAPTCHAs, then safely resume automation after verified success.

## Canonical Skill References

- `kxm-browser-takeover`
- `kxm-browser-session`
- `kxm-browser-auth`

## Parameters & Placeholders

- **PROJECT_ID**: `{{PROJECT_ID}}`
- **TASK_ID**: `{{TASK_ID}}`
- **SESSION_ID**: `{{SESSION_ID}}`
- **REASON_FOR_TAKEOVER**: `{{REASON_FOR_TAKEOVER}}` (e.g. "SMS / TOTP MFA challenge detected on login form")
- **EXPECTED_POST_AUTH_URL**: `{{EXPECTED_POST_AUTH_URL}}` (e.g. `https://app.example.com/dashboard`)
- **EXPECTED_INDICATOR**: `{{EXPECTED_INDICATOR}}` (e.g. "Header user avatar or dashboard navigation visible")
- **TAKEOVER_URL**: `https://steel.kontextmind.com/ui?sessionId={{SESSION_ID}}`

---

## Instructions for Agent

1. **Halt Automated Actions Immediately**:
   - Stop issuing automated clicks, keystrokes, or page reloads.
   - Transition session state to `HUMAN_CONTROL`.

2. **Notify Operator**:
   - Emit the formatted takeover block in the terminal:

     ```text
     [HUMAN TAKEOVER REQUIRED]
     Task: {{TASK_ID}}
     Session ID: {{SESSION_ID}}
     Reason: {{REASON_FOR_TAKEOVER}}
     Takeover URL: {{TAKEOVER_URL}}

     Please complete the action in the browser UI, then type "auth complete" in this terminal.
     ```

3. **Wait for Human Confirmation**:
   - Wait indefinitely or up to task timeout. Do NOT auto-resume based solely on timer expiry.

4. **Verify Application State**:
   - Once human confirms completion, inspect active page URL and DOM.
   - Verify that current URL matches `{{EXPECTED_POST_AUTH_URL}}` or that `{{EXPECTED_INDICATOR}}` is present.
   - Refresh DOM tree observations and proceed with task execution under `AGENT_CONTROL`.

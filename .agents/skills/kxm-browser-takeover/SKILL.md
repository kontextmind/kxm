---
name: kxm-browser-takeover
description: Manage the human takeover handoff protocol for MFA, login, CAPTCHA, and sensitive consent in Steel browser sessions.
---

# KXM Human Takeover and Authentication Protocol

Use this skill when an automated browser session encounters a login gate, MFA prompt, CAPTCHA, payment authorization, or sensitive consent requirement that requires human intervention.

## Purpose & Scope

- Provide a secure, deterministic handoff between agent automation and human operator.
- Stop all automated actions immediately before handing control to the human.
- Provide an actionable session viewer link so the operator interacts with the **exact same** browser instance.
- Ensure the agent resumes only after explicit human confirmation and verified authentication state.

## Handoff Protocol

```text
AGENT_CONTROL
    │
    ▼ (login/MFA/consent detected)
AUTH_REQUIRED
    │
    ▼ (automation paused, takeover link emitted)
HUMAN_CONTROL
    │
    ▼ (operator performs auth in UI & confirms in terminal)
VERIFY_AUTHENTICATION
    │
    ▼ (app state verified, DOM observations refreshed)
AGENT_CONTROL
```

## Takeover Step-by-Step

### 1. Identify Need for Takeover

When a page requires human authentication:

- Pause all Playwright / agent-browser click, fill, or submit actions immediately.
- Transition session state from `AGENT_CONTROL` to `AUTH_REQUIRED`.

### 2. Emit Takeover Notification

Generate a clear notification containing the session URL and actionable instructions:

```text
================================================================================
[HUMAN TAKEOVER REQUIRED]
Session ID: <sessionId>
Reason: Multifactor Authentication (MFA) required on https://app.example.com/login
Takeover URL: https://steel.kontextmind.com/ui?sessionId=<sessionId>

Instructions for Operator:
1. Open the Takeover URL in your browser.
2. Complete the authentication, MFA challenge, or consent prompt.
3. Confirm in the terminal when finished: "auth complete" or signal resume.
================================================================================
```

### 3. Yield to Human Control

- Set state to `HUMAN_CONTROL`.
- The agent stops sending commands and waits for explicit operator confirmation.
- **Rule**: Do NOT auto-resume merely because a timeout elapsed.

### 4. Receive Completion Signal

Upon human completion signal (e.g. user input in Herdr or Pi terminal):

- Transition state to `VERIFY_AUTHENTICATION`.

### 5. Verify Authenticated State

Before resuming automation:

- Reconnect automation client (CDP) to the active tab.
- Verify expected application indicators (e.g., dashboard URL, user avatar, session cookie).
- Refresh DOM observations, element selectors, and page state.
- Transition state back to `AGENT_CONTROL`.

## Failure & Recovery Paths

- **Session Expired During Takeover**: Explain to the operator that the remote session timed out, release the old session, create a fresh session, and request re-authentication.
- **Authentication Incomplete**: If verification fails (e.g., still on `/login`), report the error to the operator and return to `HUMAN_CONTROL`.
- **Operator Abandons Session**: If the human cancels the task, release the Steel session immediately to avoid resource leakage.

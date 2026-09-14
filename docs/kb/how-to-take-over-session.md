---
schema: "kxm.doc.v1"
id: "KB-BROWSER-001"
type: "kb"
title: "How do I take over a browser session to log in?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-14"
authority: "instruction"
confidence: "verified"
summary: "Instructions for taking over an active Steel browser session during an authentication gate."
tags: ["browser", "takeover", "auth", "mfa"]
related: ["docs/browser-automation.md", "docs/kb/how-to-resume-after-mfa.md"]
---

# How do I take over a browser session to log in?

When an agent encounters a login screen, OAuth prompt, or security challenge, it triggers the `kxm-browser-takeover` protocol.

## Steps

1. **Copy the Takeover URL**:
   The agent will emit a message in the terminal with a link like:
   `https://steel.kontextmind.com/ui?sessionId=<SESSION_ID>`
2. **Open the Session Viewer**:
   Open that URL in your desktop browser. You will see the live screencast of the exact remote Chrome container the agent was operating.
3. **Interact and Authenticate**:
   Enter the username, password, or security key into the session, or use the devtools inspector (`https://steel.kontextmind.com/v1/devtools/inspector.html`) to trigger the submission.
4. **Signal Completion**:
   Return to your Herdr or Pi terminal session and notify the agent: `auth complete` or `proceed`.

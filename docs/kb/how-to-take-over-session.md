---
schema: "kxm.doc.v1"
id: "KB-BROWSER-001"
type: "kb"
title: "How do I take over a browser session to log in?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-23"
authority: "instruction"
confidence: "verified"
summary: "Take over an active Steel browser session at an authentication gate."
tags: ["browser", "takeover", "auth", "mfa"]
related: ["docs/guides/browser-automation.md", "docs/kb/how-to-resume-after-mfa.md"]
---

# How do I take over a browser session to log in?

When an agent reaches a login screen, an OAuth prompt or a security challenge,
it stops and asks you to take over, following the `kxm-browser-takeover` skill.

## Steps

1. **Copy the takeover URL.** The agent prints a session viewer link such as
   `<steel-ui-url>?sessionId=<session-id>`. The viewer URL is `STEEL_UI_URL`,
   or `<steel-api-url>/ui` when that is unset.
2. **Open the session viewer** in your desktop browser. It shows a live
   screencast of the remote browser the agent was driving.
3. **Sign in.** Enter the username, password or security key in the session.
   If clicks on the screencast do not register, use the DevTools inspector at
   `<steel-api-url>/v1/devtools/inspector.html`; see
   [Why can I view a session but not control it?](why-session-viewer-cannot-control.md).
4. **Signal completion.** Return to the agent's terminal session and tell it
   `auth complete` or `proceed`. It then verifies the sign-in before it resumes;
   see [How does an agent resume after MFA?](how-to-resume-after-mfa.md).

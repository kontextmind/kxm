---
schema: "kxm.doc.v1"
id: "KB-BROWSER-002"
type: "kb"
title: "How does an agent resume after MFA?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-14"
authority: "instruction"
confidence: "verified"
summary: "Details the verification and observation refresh sequence when resuming automation after MFA."
tags: ["browser", "mfa", "resume", "verification"]
related: ["docs/kb/how-to-take-over-session.md", "docs/browser-automation.md"]
---

# How does an agent resume after MFA?

Once the human completes the MFA challenge in the browser viewer, the agent must not immediately execute blind clicks. It follows this sequence:

1. **State Transition**: Moves from `HUMAN_CONTROL` to `VERIFY_AUTHENTICATION`.
2. **CDP Re-attachment**: Re-queries the active tab target from the remote Steel CDP endpoint.
3. **App State Verification**:
   - Inspects `page.url()` to confirm the browser navigated away from the MFA prompt to the intended destination (e.g. `/dashboard` or `/overview`).
   - Checks for authenticated elements (e.g. account menu, logout button, user profile avatar).
4. **Observation Refresh**: Runs a fresh `agent-browser snapshot` or queries fresh DOM locators before executing the next action.
5. **Restore Control**: Returns to `AGENT_CONTROL` and proceeds with the task.

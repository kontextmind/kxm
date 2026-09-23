---
schema: "kxm.doc.v1"
id: "KB-BROWSER-002"
type: "kb"
title: "How does an agent resume after MFA?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-23"
authority: "instruction"
confidence: "verified"
summary: "The verification and observation refresh an agent performs before resuming after MFA."
tags: ["browser", "mfa", "resume", "verification"]
related: ["docs/kb/how-to-take-over-session.md", "docs/guides/browser-automation.md"]
---

# How does an agent resume after MFA?

After you complete an MFA challenge in the session viewer, the agent does not
click blindly. It follows this sequence:

1. **State transition.** The session moves from `HUMAN_CONTROL` to
   `VERIFY_AUTHENTICATION`. The `SteelClient` keeps this state in memory for
   its own lifetime; a new client does not inherit it.
2. **CDP re-attachment.** The agent re-queries the active tab from the Steel
   CDP endpoint.
3. **Application state check.**
   - It confirms that `page.url()` left the MFA prompt for the intended page,
     for example `/dashboard`.
   - It looks for signed-in elements such as an account menu or a sign-out
     button.
4. **Observation refresh.** It takes a fresh `agent-browser snapshot`, or
   queries fresh DOM locators, before the next action.
5. **Control returns.** The session returns to `AGENT_CONTROL` and the task
   continues.

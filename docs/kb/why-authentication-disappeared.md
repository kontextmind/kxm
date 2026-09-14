---
schema: "kxm.doc.v1"
id: "KB-BROWSER-004"
type: "kb"
title: "Why did authentication disappear?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-14"
authority: "instruction"
confidence: "verified"
summary: "Diagnosing lost authentication state, session expiration, and ephemeral container recreation."
tags: ["browser", "authentication", "cookies", "troubleshooting"]
related: ["docs/browser-automation.md", "docs/kb/why-automation-opened-different-browser.md"]
---

# Why did authentication disappear?

If an agent was authenticated on a previous step or run and suddenly encounters a login screen again, the root causes are typically:

## Root Causes & Fixes

1. **Session Released or Expired**:
   - Steel sessions are ephemeral by default. Once a session reaches its timeout (e.g. 5–30 minutes) or is released via `POST /v1/sessions/:id/release`, all memory cookies and local storage are cleared.
   - **Fix**: To reuse state across tasks, save `storageState` via Playwright and reload it on the next session initialization.
2. **New Session Launched Instead of Attaching**:
   - If the agent created a brand-new session instead of passing the existing `sessionId`, it opened a clean Chrome profile.
   - **Fix**: Verify that the task passes `sessionId` to `getSession()` or uses the existing CDP endpoint.
3. **Domain / Subdomain Cookie Scoping**:
   - OAuth flows often set cookies on subdomains (e.g., `auth.example.com`) that do not automatically share with `app.example.com`.
   - **Fix**: Ensure cookies were issued for the primary domain or that SSO redirect completed fully before saving state.

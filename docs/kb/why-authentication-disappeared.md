---
schema: "kxm.doc.v1"
id: "KB-BROWSER-004"
type: "kb"
title: "Why did authentication disappear?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-23"
authority: "instruction"
confidence: "verified"
summary: "Diagnose lost sign-in state: session expiry, a new session instead of an attached one, and cookie scoping."
tags: ["browser", "authentication", "cookies", "troubleshooting"]
related: ["docs/guides/browser-automation.md", "docs/kb/why-automation-opened-different-browser.md"]
---

# Why did authentication disappear?

If an agent was signed in on an earlier step or run and now sees a login screen
again, one of these is usually the cause.

## Causes and fixes

1. **The session was released or expired.**
   - Steel sessions are ephemeral. When a session reaches its timeout (the KXM
     client defaults to five minutes) or is released through
     `POST /v1/sessions/<session-id>/release`, its cookies and local storage
     are gone.
   - **Fix:** to reuse sign-in state across tasks, save Playwright
     `storageState` and load it when you start the next session.
2. **A new session was launched instead of attaching to the existing one.**
   - A new session starts with a clean browser profile.
   - **Fix:** make sure the task passes the existing `sessionId` to
     `getSession()`, or connects to the existing CDP endpoint.
3. **Cookies were scoped to another domain.**
   - Sign-in flows often set cookies on a subdomain, such as
     `auth.example.com`, that `app.example.com` does not receive.
   - **Fix:** make sure the cookies were issued for the primary domain, or that
     the single sign-on redirect finished, before you save state.

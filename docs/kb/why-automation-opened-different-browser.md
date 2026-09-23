---
schema: "kxm.doc.v1"
id: "KB-BROWSER-005"
type: "kb"
title: "Why did automation open a different browser?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-23"
authority: "instruction"
confidence: "verified"
summary: "Prevent accidental local browser launches and make Playwright and agent-browser attach to remote Steel."
tags: ["browser", "cdp", "playwright", "agent-browser", "troubleshooting"]
related: ["docs/guides/browser-automation.md", "docs/kb/how-to-connect-playwright-to-steel.md"]
---

# Why did automation open a different browser?

You expected automation to run on your Steel deployment, but a local Chrome
window opened, or the agent's actions never appeared in the Steel session
viewer.

## Causes

1. **The script called `chromium.launch()` instead of
   `chromium.connectOverCDP()`.**
   - `chromium.launch()` starts a browser on the local machine.
   - **Fix:** in Playwright, connect with `chromium.connectOverCDP(cdpUrl)`.
2. **`agent-browser` ran without `--cdp`.**
   - `agent-browser open <url>` without `--cdp` starts a local headless
     browser.
   - **Fix:** always pass the session's CDP URL:
     `--cdp "wss://<steel-host>/v1/devtools?sessionId=<session-id>&apiKey=<steel-api-key>"`.
     Build it with `formatCDPEndpoint()`; see
     [How do I connect Playwright to the existing Steel session?](how-to-connect-playwright-to-steel.md).
3. **Environment variables were missing.**
   - A script that falls back to local execution when `STEEL_CDP_URL` is
     unset launches a local browser.
   - **Fix:** load `STEEL_CDP_URL`, or `STEEL_API_URL` and `STEEL_API_KEY`,
     from your secret manager before the run.

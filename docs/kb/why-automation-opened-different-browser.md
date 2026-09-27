---
schema: "kxm.doc.v1"
id: "KB-BROWSER-005"
type: "kb"
title: "Why did automation open a different browser?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-27"
authority: "instruction"
confidence: "verified"
summary: "Prevent accidental local browser launches and make Playwright and agent-browser attach to remote Steel."
tags: ["browser", "cdp", "playwright", "agent-browser", "troubleshooting"]
related: ["docs/guides/browser-automation.md", "docs/kb/how-to-connect-playwright-to-obscura.md", "docs/kb/how-to-connect-playwright-to-steel.md"]
---

# Why did automation open a different browser?

Playwright testing connects to Obscura at `http://127.0.0.1:9222` unless `KXM_BROWSER=steel`. A local Chrome window means the client launched a browser instead of attaching over CDP. The Obscura steps are in [How do I connect Playwright to Obscura?](how-to-connect-playwright-to-obscura.md).

You expected automation to run on Obscura, or on a Steel takeover session, but a local Chrome window opened, or the agent's actions never appeared in the session you were watching.

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
     Build the Obscura URL with `resolveObscuraCdpEndpoint()`, or the Steel URL with `formatCDPEndpoint()` when `KXM_BROWSER=steel`. See
     [How do I connect Playwright to Obscura?](how-to-connect-playwright-to-obscura.md)
     and
     [How do I connect Playwright to the existing Steel session?](how-to-connect-playwright-to-steel.md).
3. **The Playwright client had no CDP endpoint.**
   - A script that falls back to `chromium.launch()` when no CDP URL is set
     opens a local browser.
   - **Fix:** use `resolveObscuraCdpEndpoint()` (default
     `http://127.0.0.1:9222`). For a Steel takeover session, set
     `KXM_BROWSER=steel` and load `STEEL_API_URL` and `STEEL_API_KEY`.

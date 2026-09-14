---
schema: "kxm.doc.v1"
id: "KB-BROWSER-005"
type: "kb"
title: "Why did automation open a different browser?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-14"
authority: "instruction"
confidence: "verified"
summary: "Preventing accidental local browser launches and ensuring Playwright and agent-browser connect to remote Steel."
tags: ["browser", "cdp", "playwright", "agent-browser", "troubleshooting"]
related: ["docs/browser-automation.md", "docs/kb/how-to-connect-playwright-to-steel.md"]
---

# Why did automation open a different browser?

If you expected automation to run on DOKS Steel but saw a local Chrome window pop up or failed to see the agent's actions in the Steel session viewer:

## Root Causes

1. **Called `chromium.launch()` Instead of `chromium.connectOverCDP()`**:
   - `chromium.launch()` spawns a local browser process on the workstation.
   - **Fix**: In Playwright, always use `chromium.connectOverCDP(cdpUrl)`.
2. **Missing `--cdp` Flag in `agent-browser`**:
   - Running `agent-browser open <url>` without `--cdp` spawns a local headless browser.
   - **Fix**: Always pass `--cdp "wss://steel.kontextmind.com/v1/devtools?sessionId=<id>&apiKey=<key>"`.
3. **Missing Environment Variables**:
   - If `STEEL_CDP_URL` is undefined, scripts that fall back to local execution will launch a local browser.
   - **Fix**: Ensure `STEEL_CDP_URL` or `STEEL_API_KEY` is loaded from `pass-cli`.

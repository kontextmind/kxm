---
schema: "kxm.doc.v1"
id: "KB-BROWSER-006"
type: "kb"
title: "Why can I view a session but not control it?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-14"
authority: "instruction"
confidence: "verified"
summary: "Understanding self-hosted Steel OSS screencast viewer capabilities vs devtools inspector input modes."
tags: ["browser", "takeover", "steel", "ui"]
related: ["docs/browser-automation.md", "docs/kb/how-to-take-over-session.md"]
---

# Why can I view a session but not control it?

In self-hosted open-source Steel (`steel-dev/steel-browser`), the web UI at `/ui` provides a real-time screencast stream, event logs, and network tracking. Depending on browser canvas capture modes, direct clicks on the video canvas may not send synthetic mouse events.

## Resolution

1. **Use the Chrome DevTools Inspector**:
   Navigate to the devtools inspector page for the session:
   `https://steel.kontextmind.com/v1/devtools/inspector.html`
   or open the remote debugger on port 9223.
2. **Interact via the DOM Console**:
   The devtools inspector gives full interactive control over the DOM, console, network, and storage.
3. **Agent Automation Coexistence**:
   Ensure the agent is in `HUMAN_CONTROL` state so automation does not race or override your clicks.

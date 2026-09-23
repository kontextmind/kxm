---
schema: "kxm.doc.v1"
id: "KB-BROWSER-006"
type: "kb"
title: "Why can I view a session but not control it?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-23"
authority: "instruction"
confidence: "verified"
summary: "The self-hosted Steel screencast viewer versus the DevTools inspector for interactive control."
tags: ["browser", "takeover", "steel", "ui"]
related: ["docs/guides/browser-automation.md", "docs/kb/how-to-take-over-session.md"]
---

# Why can I view a session but not control it?

In self-hosted open-source Steel (`steel-dev/steel-browser`), the web UI at
`/ui` shows a live screencast, event logs and network activity. Depending on how
the canvas is captured, clicks on the video may not reach the browser.

## Resolution

1. **Use the Chrome DevTools inspector.** Open the inspector page of your Steel
   deployment, `<steel-api-url>/v1/devtools/inspector.html`, or the remote
   debugger port your deployment exposes.
2. **Interact through DevTools.** The inspector gives full control of the DOM,
   console, network and storage.
3. **Keep the agent out of the way.** Make sure the session is in
   `HUMAN_CONTROL`, so automation does not race your clicks.

---
schema: "kxm.doc.v1"
id: "KB-BROWSER-003"
type: "kb"
title: "How are credentials retrieved without exposing them to the model?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-14"
authority: "instruction"
confidence: "verified"
summary: "Explains safe pass-cli credential delivery and environment piping patterns that avoid LLM context leakage."
tags: ["browser", "credentials", "pass-cli", "security"]
related: ["docs/browser-automation.md", "docs/agent-skills.md"]
---

# How are credentials retrieved without exposing them to the model?

To protect passwords, MFA secrets, and API tokens from leaking into model reasoning traces, KXM enforces strict credential-reference boundaries:

## Mechanisms

1. **Authoritative Store**: All secrets reside in `pass-cli` (Proton Pass).
2. **In-Process Environment Piping**:
   - Automated test scripts use `pass-cli run -- npm test` or retrieve credentials directly into child process memory via standard environment variables.
   - The LLM prompt only receives credential references (e.g., `vault: "AI Provider Keys", item: "Steel Browser (KontextMind DOKS)"`), never raw secret values.
3. **Log Sanitization**:
   - The KXM browser client strips API keys and token parameters (`apiKey=[REDACTED]`, `steel_[REDACTED]`) before logging or emitting outputs.
4. **Human Handoff for High-Privilege Auth**:
   - For sensitive production accounts or MFA, the agent never touches the credential at all; it invokes `kxm-browser-takeover` and lets the human authenticate directly in the UI.

---
schema: "kxm.doc.v1"
id: "KB-BROWSER-003"
type: "kb"
title: "How are credentials retrieved without exposing them to the model?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-23"
authority: "instruction"
confidence: "verified"
summary: "How the Steel client resolves its API key and how browser work keeps secrets out of model context."
tags: ["browser", "credentials", "pass-cli", "security"]
related: ["docs/guides/browser-automation.md", "docs/guides/agent-skills.md"]
---

# How are credentials retrieved without exposing them to the model?

Browser automation keeps passwords, MFA secrets and API tokens out of model
prompts and reasoning traces. The model sees references to credentials, never
their values.

## How the Steel client finds its API key

`resolveSteelConfig()` resolves each setting in this order, and never writes a
secret to disk or to a log:

| Setting | Resolved from |
|---|---|
| API URL | An explicit override, then `STEEL_API_URL`, then a built-in default |
| API key | An explicit override, then `STEEL_API_KEY`, then a `pass-cli` lookup |
| Session viewer URL | An explicit override, then `STEEL_UI_URL`, then `<api-url>/ui` |

The built-in default URL and the `pass-cli` lookup point at the maintainers'
own Steel deployment and vault. Set `STEEL_API_URL` and `STEEL_API_KEY` for
yours, and set `USE_PASS_CLI=false` to turn the lookup off.

## Mechanisms

1. **One secret store.** Keep secrets in a secret manager, for example Proton
   Pass through `pass-cli`, and load them into the environment of the process
   that needs them:

   ```bash
   # Runs the tests with secrets injected for this process only.
   pass-cli run -- npm test
   ```

2. **References, not values.** A prompt receives a credential reference such
   as `vault: "<vault>", item: "<item>"`, never the secret itself.
3. **Log sanitization.** The KXM browser client redacts `apiKey=` query values,
   `steel_…` keys, and any field named like a key, secret, token, auth or
   password before it logs or returns output.
4. **Human handoff for high-privilege sign-in.** For production accounts or
   MFA, the agent does not touch the credential at all. It follows the
   `kxm-browser-takeover` skill and lets you sign in directly.

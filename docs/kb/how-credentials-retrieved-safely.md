---
schema: "kxm.doc.v1"
id: "KB-BROWSER-003"
type: "kb"
title: "How are credentials retrieved without exposing them to the model?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-27"
authority: "instruction"
confidence: "verified"
summary: "How the Steel client resolves Authentik Basic auth and how browser work keeps secrets out of model context."
tags: ["browser", "credentials", "1password", "security"]
related: ["docs/guides/browser-automation.md", "docs/guides/agent-skills.md"]
---

# How are credentials retrieved without exposing them to the model?

Browser automation keeps passwords, MFA secrets and API tokens out of model
prompts and reasoning traces. The model sees references to credentials, never
their values.

## How the Steel client finds its credential

`resolveSteelConfig()` resolves each setting in this order, and never writes a
secret to disk or to a log:

| Setting | Resolved from |
|---|---|
| API URL | An explicit override, then `STEEL_API_URL`, then `https://steel.kontextmind.com` |
| Authentik `Authorization` | `STEEL_AUTH_HEADER`, then `STEEL_AUTH_BASIC`, then `STEEL_AUTH_USER` and `STEEL_AUTH_TOKEN` |
| Legacy API key | Deprecated. An explicit override, then `STEEL_API_KEY`, then a leftover lookup, and only when no Authentik credential is set. Steel and Caddy do not enforce it |
| Session viewer URL | An explicit override, then `STEEL_UI_URL`, then `<api-url>/ui` |

The Steel server is behind Caddy and Authentik forward auth. The client sends
`Authorization: Basic` on every HTTP request and on the CDP WebSocket at
`/v1/devtools`. A Bearer token is refused. A credential in the URL is refused.
`STEEL_API_KEY` is deprecated. When an Authentik variable is set, that variable
overrides the key, and the key is not sent.

Read the `svc-steel` credential at runtime and do not write it to disk. The
1Password vault is `kontextmind`, the item is `Steel (svc-steel)`, and the
field is `basic_auth`:

```bash
export STEEL_AUTH_BASIC="$(op read 'op://kontextmind/Steel (svc-steel)/basic_auth')"
```

`kxm` 0.7.135 or newer is required. Sessions return `websocketUrl`
`wss://steel.kontextmind.com/`.

## Mechanisms

1. **One secret store.** Keep the Steel credential in 1Password and load it
   into the environment of the process that needs it, as the `op read` command
   above. Do not redirect the command into a file.

2. **References, not values.** A prompt receives a credential reference such
   as `op://kontextmind/Steel (svc-steel)/basic_auth`, never the secret itself.
3. **Log sanitization.** The KXM browser client redacts `apiKey=` query values,
   `Authorization` header values, `Basic` credentials, `steel_…` keys, and any
   field named like a key, secret, token, auth or password before it logs or
   returns output.
4. **Human handoff for high-privilege sign-in.** For production accounts or
   MFA, the agent does not touch the credential at all. It follows the
   `kxm-browser-takeover` skill and lets you sign in directly.

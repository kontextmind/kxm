---
name: kxm-browser-auth
description: Retrieve application credentials and manage authenticated browser profiles without secret exposure. Steel uses the svc-steel credential from 1Password via op read.
---

# KXM Browser Credentials & Authenticated Profiles

Use this skill to retrieve target application credentials and manage browser session state. The Steel `svc-steel` credential comes from 1Password and is read with `op read`. It is never written to disk.

## Purpose & Scope

- Read the Steel credential at runtime from 1Password.
- Prevent secrets from leaking into git repositories, logs, prompts, or model-visible tool outputs.
- Support safe storage and retrieval of session storage state and authenticated profiles.

## Credential Retrieval Guidelines

### 1. Steel credential: 1Password

`STEEL_API_KEY` is deprecated. Steel and Caddy do not enforce it. Authenticate as `svc-steel`. Precedence is `STEEL_AUTH_HEADER`, then `STEEL_AUTH_BASIC`, then `STEEL_AUTH_USER` and `STEEL_AUTH_TOKEN`. Those override `STEEL_API_KEY`. `STEEL_API_URL` defaults to `https://steel.kontextmind.com`. `kxm` 0.7.135 or newer is required.

```bash
# Vault kontextmind, item "Steel (svc-steel)", field basic_auth.
# Do not redirect this into a file.
export STEEL_AUTH_BASIC="$(op read 'op://kontextmind/Steel (svc-steel)/basic_auth')"
```

`STEEL_AUTH_USER` is `svc-steel` when you use the user and token pair. Send the value as `Authorization` on `/v1/devtools`. Never put it in the URL.

### 2. Secret Redaction Invariants

- **Never** write plain passwords, session tokens, or API keys into markdown docs, commit messages, or prompts.
- **Never** pass plain credentials as unredacted command line arguments in shared logs.
- Keep the `op read` result in the environment of the process that calls Steel.

### 3. Profile & Storage State Management

When an authenticated session state (cookies, local storage) needs to be preserved for subsequent test runs:

1. **Extract State**:
   Extract storage state from Playwright via `context.storageState({ path: 'state.json' })` or from Steel via `GET /v1/sessions/:id/context`.
2. **Encrypt / Store Privately**:
   Store sensitive storage state in git-ignored, private locations (e.g. `.kxm/state/browser/` or as an encrypted secret).
3. **Session Expiration**:
   Treat cookies as transient. When expired, trigger the `kxm-browser-takeover` flow instead of failing silently.
4. **Account & Profile Separation**:
   Maintain separate storage states per environment (e.g., `dev`, `staging`, `prod`) and per user role (e.g., `admin`, `viewer`). Never mix profiles across concurrent test runs.

---
name: kxm-browser-auth
description: Retrieve application credentials and manage authenticated browser profiles safely via pass-cli without secret exposure.
---

# KXM Browser Credentials & Authenticated Profiles

Use this skill to retrieve target application credentials and manage browser session state securely using `pass-cli` as the sole authoritative store.

## Purpose & Scope

- Enforce `pass-cli` as the single source of truth for credentials and API keys.
- Prevent secrets from leaking into git repositories, logs, prompts, or model-visible tool outputs.
- Support safe storage and retrieval of session storage state and authenticated profiles.

## Credential Retrieval Guidelines

### 1. Authoritative Tool: pass-cli

Always retrieve credentials and API keys directly from `pass-cli`:

```bash
# Retrieve target login password into an environment variable or piping mechanism
pass-cli item view --vault-name "<vault>" --item-title "<title>" --field password

# Retrieve Steel infrastructure API key
pass-cli item view --vault-name "AI Provider Keys" --item-title "Steel Browser (KontextMind DOKS)" --field STEEL_API_KEY
```

### 2. Secret Redaction Invariants

- **Never** write plain passwords, session tokens, or API keys into markdown docs, commit messages, or prompts.
- **Never** pass plain credentials as unredacted command line arguments in shared logs.
- Use environment variable injection (`pass-cli run`) or direct in-memory pipes.

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

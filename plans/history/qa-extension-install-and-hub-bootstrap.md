---
schema: "kxm.doc.v1"
id: "KB-HUB-002"
type: "kb"
title: "Q&A: Extension install → kxm CLI bootstrap + hub auto-connect"
project: "kxm"
status: "draft"
owner: "@operator"
created: "2026-09-17"
updated: "2026-09-18"
authority: "instruction"
confidence: "reviewed"
summary: "Extension load attempts a hub connection and can auto-start a local hub with generated keys, but it does not bootstrap a global kxm CLI and failure warnings are diagnostic rather than actionable."
tags: ["hub", "extension", "bootstrap", "cli"]
related: ["docs/operations.md", "docs/getting-started.md"]
---

# Q&A: Extension install → kxm CLI bootstrap + hub auto-connect

> Researched by `codex gpt-5.6-sol` (reviewer-cli, read-only) · 2026-09-17 · task_634d24e1225d · root review: pending

Desired behavior when a user runs `pi install npm:@kontextmind/kxm` and loads the extension:

1. the installer/load path checks for, installs, or updates the global `kxm` CLI;
2. on extension load it attempts to connect to a hub;
3. if no connection is configured, it starts a local hub with generated API keys and connects;
4. on failure it shows a friendly warning with brief start/configure instructions.

## 1. Does the installer/load path check for, install, or update the global `kxm` CLI?

Verdict: **MISSING**

The npm package exposes a `kxm` binary through `"bin": { "kxm": "./scripts/kxm.mjs" }`, and that launcher executes the package's bundled `plugins/kxm/dist/cli.js` (`package.json:53-55`, `scripts/kxm.mjs:6-14`). The same package tells Pi to load the TypeScript extension directly (`package.json:64-70`). However, `extension.ts` contains no CLI presence/version check and no install/update bootstrap. Its only CLI subprocess use is the `/kxm memory` handler, which tries `KXM_BIN || "kxm"` and then a repository-local script fallback (`plugins/kxm/src/extension.ts:944-956`). Update machinery exists, including a global npm install plan (`plugins/kxm/src/kxm-update.ts:215-237`), but it is reached through the explicit `kxm update --kxm` command (`plugins/kxm/src/cli.ts:446-460`). That command deliberately applies package updates only when the current install is classified as `npm-global`; Pi-managed installs are classified as `pi-git` and told to use `pi update` (`plugins/kxm/src/kxm-install-kind.ts:59-75`, `plugins/kxm/src/cli/system.ts:356-376`). Whether Pi itself creates a globally discoverable binary for an npm package is unknown from this repository; no repository code requests or verifies that outcome.

## 2. On extension load, does it attempt to connect to a hub?

Verdict: **PARTIAL**

On every Pi `session_start`, the extension stops any previous client, derives the project and agent identity, optionally runs hub auto-start, constructs a `HubClient`, and calls `client.start(receive)` (`plugins/kxm/src/extension.ts:657-730`). It reports a successful connection in Pi with an info notification and reports a failed connection with an error notification (`plugins/kxm/src/extension.ts:730-751`). The gap is configured hub binding: `ensureHubRunning()` reads the persisted binding, probes it, and returns `bound-healthy` when it is available (`plugins/kxm/src/hub-autostart.ts:130-136`), but `extension.ts` computes `serverUrl` only from `KXM_SERVER_URL` or the localhost default before auto-start and never replaces it with the binding URL or the returned URL (`plugins/kxm/src/extension.ts:679-692`, `plugins/kxm/src/extension.ts:718-725`). By contrast, the CLI's runtime resolution explicitly uses `KXM_SERVER_URL`, then the bound hub URL, then localhost (`plugins/kxm/src/cli/types.ts:238-252`). Therefore extension load attempts a connection, but a healthy persisted remote binding can be detected and then ignored unless `KXM_SERVER_URL` is also set.

## 3. If no connection is configured, does it start a local hub with generated API keys and connect to it?

Verdict: **EXISTS TODAY**

Hub auto-start defaults to `background` in the resolved configuration (`plugins/kxm/src/config.ts:111-132`), and unknown auto-start values also resolve to `background` (`plugins/kxm/src/hub-autostart.ts:60-65`). `ensureHubRunning()` first checks a bound hub, a live local PID claim, and the configured/default URL; if none is live, it resolves credentials, launches the packaged `scripts/kxm-hub.mjs` wrapper in the background, and waits for a hub claim (`plugins/kxm/src/hub-autostart.ts:126-167`, `:185-213`). Credential resolution prefers an environment token, then the persisted user-state token, otherwise generates a URL-safe admin token and persists it (`plugins/kxm/src/hub-env.ts:135-182`); the persisted file is written through a temporary file with mode `0600` (`hub-env.ts:86-98`). The generated/reused token is injected into the hub process (`hub-autostart.ts:169-180`) and then supplied to the extension's `HubClient`, after which `client.start()` connects (`extension.ts:688-729`). The generated credential is specifically one admin token; `projectTokens` may be loaded from configuration but are not generated here (`hub-env.ts:157-168`). Also, auto-start verifies the wrapper's PID claim rather than hub HTTP readiness, so a fast client connection can theoretically race server readiness; whether `HubClient.start()` retries that race is unknown without treating code outside the requested bootstrap path as evidence.

## 4. On failure, does it show a friendly warning with brief start/configure instructions?

Verdict: **PARTIAL**

Failures are surfaced in Pi's notification UI, but the messages are diagnostic rather than actionable. A structured auto-start failure produces `kxm hub auto-start failed: <reason> (log: <path>)`, thrown setup errors produce a similar warning, malformed persisted credentials produce another warning, and final connection failure produces `kxm connection failed: <error>` (`plugins/kxm/src/extension.ts:700-715`, `:749-752`). The extension already has a `/kxm hub` view that reports health and connection state (`plugins/kxm/src/extension.ts:348-362`, `:911-915`), and its general help mentions `kxm hub view` (`plugins/kxm/src/extension.ts:940-942`). None of the load-time failure messages tells the user to run `kxm hub start`, configure `KXM_SERVER_URL`, or persist a remote endpoint with `kxm hub bind <url>`. The current warning also assumes the `kxm` executable is available, which the extension does not verify.

## Gap list

1. **Global CLI bootstrap/preflight.** Add a bootstrap helper invoked before hub startup in the `session_start` handler, immediately before `loadKxmConfig()`/`ensureHubRunning()` at `plugins/kxm/src/extension.ts:688-692`. It should distinguish "the Pi package contains the CLI" from "a global `kxm` command is installed", probe `KXM_BIN`/PATH and version, and return a structured result. Automatic installation or updating should reuse narrowly factored primitives from `planKxmPackageUpdate()` rather than shell-form commands.
   **Risk:** this crosses the Pi-package/global-CLI ownership boundary. A Pi-installed extension is currently classified as `pi-git` and intentionally updated through `pi update`, while `kxm update --kxm` rejects non-global installs (`kxm-install-kind.ts:59-75`, `cli/system.ts:356-376`). Silently installing a second global copy could create version skew, PATH ambiguity, unexpected network writes, or privilege prompts. Fail closed on ambiguous ownership and do not overwrite an independently managed global installation. On Windows, executable lookup and npm invocation may require `kxm.cmd`/`npm.cmd`; PATH changes made by npm may not enter the already-running Pi process.

2. **One authoritative endpoint resolver for the extension.** Import and use `readHubBinding()` in `extension.ts`, or extract the CLI precedence into a shared resolver, then resolve the client URL as explicit `KXM_SERVER_URL` → valid persisted binding → localhost. Hook this before the current `serverUrl` assignment at `plugins/kxm/src/extension.ts:679`; alternatively, carry the `url` from `ensureHubRunning()`'s `bound-healthy`/`url-healthy` results into `HubClient`.
   **Risk:** malformed binding records already fail closed in `readHubBinding()` (`hub-binding.ts:78-107`). The extension should warn and avoid silently redirecting to localhost when an explicit or persisted remote configuration is malformed. It must also preserve the existing rule that URL credentials, query strings, and fragments are rejected (`hub-binding.ts:44-63`).

3. **Readiness-aware local startup/connect.** After `ensureHubRunning()` returns `started` or `claim-alive`, probe the selected URL until `/health` is ready within a bounded timeout, or add bounded retry behavior around `client.start()`. The natural hooks are the end of `ensureHubRunning()` at `hub-autostart.ts:185-213` or immediately before `client.start()` at `extension.ts:728-730`.
   **Risk:** retries must remain bounded and must not start a second hub merely because HTTP readiness lags the PID claim. Errors and log excerpts must continue through secret redaction; `hub-autostart.ts` currently redacts the log tail (`hub-autostart.ts:115-120`). Windows uses `detached: false` while hiding the child window (`hub-autostart.ts:177-180`), so lifecycle and shutdown behavior need Windows-specific verification.

4. **A shared actionable warning formatter.** Add a small formatter for auto-start, credential, and connection failures and call it from the existing catch/result branches at `plugins/kxm/src/extension.ts:700-715` and `:749-752`. It should account for CLI-preflight state so it never recommends an unavailable bare `kxm` command without also giving the Pi-package recovery path.
   **Risk:** do not include authentication tokens, environment dumps, or unredacted server responses. Instructions must distinguish local start from remote binding and must not silently weaken malformed-binding or credential failures by falling back to an unauthenticated hub. Windows commands should avoid Unix-only path or shell syntax.

5. **Coverage for the complete extension bootstrap sequence.** Extend the existing extension and hub-autostart tests around the actual `session_start` flow: global CLI missing/current/stale; healthy persisted binding; no binding leading to generated credentials and local startup; startup readiness race; malformed binding/credential files; and warning text. Tests must not perform real global npm installation or modify the developer's user state: inject executable probes, spawners, environment, fetch, and temporary state roots. Include Windows path casing, `.cmd` resolution, `LOCALAPPDATA`, and non-detached process behavior.

## Recommended UX for the friendly warning

Surface one `warning` notification through `ctx.ui.notify()` during Pi `session_start`, where the current auto-start warnings already appear. Keep the status/widget available through `/kxm hub`, but do not shut down the Pi session for an ordinary hub failure.

Recommended copy:

> KXM couldn't connect to a hub. Start a local hub with `kxm hub start`, or connect this machine to an existing hub with `kxm hub bind <url>` (you can also set `KXM_SERVER_URL`). Run `/kxm hub` to check status. Details: `<short redacted reason>`.

If the CLI preflight says no global command is available, replace the first instruction with:

> The KXM extension is loaded, but the global `kxm` CLI is unavailable. Install it with `npm install --global @kontextmind/kxm`, then run `kxm hub start`; or configure an existing hub with `KXM_SERVER_URL`.

If the package is Pi-managed and global installation is intentionally not automatic, say so explicitly:

> Update the Pi package with `pi update`; global CLI installation is separate.

The notification should remain brief, show the redacted log path when auto-start created one, and use Pi's existing warning surface at `plugins/kxm/src/extension.ts:700-705`. The final failed `client.start()` notification at `plugins/kxm/src/extension.ts:749-752` should use the same formatter so users receive one consistent recovery path rather than two unrelated errors.

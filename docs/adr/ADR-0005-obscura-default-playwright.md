---
schema: "kxm.doc.v1"
id: "ADR-0005"
type: "adr"
title: "Obscura is the default browser for Playwright"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-27"
updated: "2026-09-27"
authority: "decision"
confidence: "verified"
summary: "Playwright testing and verification connect to pinned Obscura v0.2.3 over CDP. Steel stays the browser for human takeover, MFA, and the live session viewer."
tags: ["architecture", "decision", "browser", "obscura", "playwright", "cdp"]
related: ["docs/adr/ADR-0002-browser-automation-steel-doks.md", "docs/guides/browser-automation.md", "docs/kb/how-to-connect-playwright-to-obscura.md"]
details:
  decision_drivers:
    - "Playwright tests must run without a Steel cluster or a Playwright-managed browser download"
    - "Local pages, including 127.0.0.1, must load in CI"
    - "Human takeover, MFA, and the live session viewer stay on Steel"
  supersedes: null
  superseded_by: null
---

# ADR-0005: Obscura is the default browser for Playwright

## Status

Accepted on 2026-09-27. This record does not supersede [ADR-0002](ADR-0002-browser-automation-steel-doks.md). Steel remains the browser for human takeover, MFA, and the live session viewer.

## Context

Playwright in this repository had no config, dependency, or CI job. Skills told agents to attach to a Steel session with `chromium.connectOverCDP(STEEL_CDP_URL)`. That makes every UI test depend on a remote Steel deployment, and it launches a local browser when the CDP URL is missing.

Obscura v0.2.3 is a headless Chromium build that speaks the Chrome DevTools Protocol on loopback. Playwright can attach with `chromium.connectOverCDP()`. It does not speak Playwright's own protocol (`chromium.connect`, `use.connectOptions`). Loading `127.0.0.1` requires `--allow-private-network`. Video recording is unsupported.

## Decision drivers

1. Playwright testing and verification need a default that runs on a developer machine and on `ubuntu-latest`.
2. A smoke test must assert a page served on `127.0.0.1`, so CI does not depend on the public internet.
3. Tests must not download Playwright's browser builds (`playwright install`).
4. Human takeover, MFA, and the live session viewer still need Steel's session API and viewer.

## Considered options

1. **Pinned Obscura over CDP, Steel only when `KXM_BROWSER=steel`.**
2. **Keep Steel as the Playwright default.**
3. **`playwright install` and `chromium.launch()` on the runner.**

### Option 1: pinned Obscura (chosen)

- Good, because the launcher downloads one pinned Apache-2.0 archive and the smoke test talks to loopback.
- Good, because `newContext()` still isolates pages, and screenshots work on the rendering build.
- Bad, because video recording and full `storageState` are unavailable.
- Bad, because Linux needs glibc 2.35 or newer, and a non-loopback bind needs `OBSCURA_CDP_TOKEN`.

### Option 2: Steel for every Playwright run (rejected)

- Good, because one CDP path covers tests and takeover.
- Bad, because tests then require a Steel deployment, an API key, and a network path that CI does not have.

### Option 3: Playwright's downloaded Chromium (rejected)

- Good, because `chromium.launch()` needs no second binary.
- Bad, because it is a second browser download, and it is the local browser the skills already tell agents to avoid.

## Decision

`resolveBrowserCdpEndpoint()` returns the Obscura CDP URL (`OBSCURA_CDP_URL`, or `http://127.0.0.1:${OBSCURA_PORT:-9222}`). `KXM_BROWSER=steel` returns the existing Steel session URL from `formatCDPEndpoint()`. Any other `KXM_BROWSER` value throws.

`scripts/obscura.mjs` downloads Obscura v0.2.3 for the current OS and architecture, checks the pinned sha256, and serves with `--allow-private-network`. `npm run e2e` ensures that server is ready and runs `playwright test`. The worker-scoped `browser` fixture connects with `chromium.connectOverCDP()`. `video` is `off`.

## Consequences

- Playwright tests and verification use Obscura unless the operator sets `KXM_BROWSER=steel`.
- Steel session create, release, takeover, and the session viewer are unchanged.
- CI for this smoke test is `.github/workflows/e2e.yml` on `ubuntu-latest`. It does not enable the paused CI, Nightly, or Real Pi smoke workflows.
- The `node --test` globs do not collect `test/e2e/`.

## Related

- [ADR-0002: Self-hosted Steel on DOKS](ADR-0002-browser-automation-steel-doks.md)
- [Browser automation](../guides/browser-automation.md)
- [How do I connect Playwright to Obscura?](../kb/how-to-connect-playwright-to-obscura.md)
- [Environment variables and limits](../reference/configuration.md#browser-automation)

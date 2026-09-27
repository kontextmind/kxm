---
schema: "kxm.doc.v1"
id: "KB-BROWSER-010"
type: "kb"
title: "How do I connect Playwright to Obscura?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-27"
updated: "2026-09-27"
authority: "instruction"
confidence: "verified"
summary: "Run Playwright against the pinned Obscura headless browser with chromium.connectOverCDP()."
tags: ["browser", "playwright", "cdp", "obscura", "testing"]
related: ["docs/guides/browser-automation.md", "docs/kb/how-to-connect-playwright-to-steel.md", "docs/adr/ADR-0005-obscura-default-playwright.md"]
---

# How do I connect Playwright to Obscura?

Obscura is the default browser for Playwright testing and verification. Steel remains for human takeover, MFA, and the live session viewer (`KXM_BROWSER=steel`).

Obscura is [h4ckf0r0day/obscura](https://github.com/h4ckf0r0day/obscura) v0.2.3 (Apache-2.0). It speaks the Chrome DevTools Protocol. Playwright's own transport (`chromium.connect`, `use.connectOptions`) does not work. Override the worker-scoped `browser` fixture and call `chromium.connectOverCDP()`.

## 1. Start Obscura

From the repository root:

```bash
node scripts/obscura.mjs --ensure
```

The launcher downloads the pinned v0.2.3 archive for this OS and architecture into `.kxm/bin/` (kept out of Git) and starts `obscura serve --port ${OBSCURA_PORT:-9222} --allow-private-network`. `obscura` and `obscura-worker` stay in that directory together. `--allow-private-network` is required: without it, `page.goto("http://127.0.0.1/...")` fails with `Access to private/internal IP address`.

Readiness is HTTP GET `http://127.0.0.1:${OBSCURA_PORT:-9222}/json/version`. The process needs glibc 2.35 or newer on Linux. `--stop` stops the pidfile process. With no flag, the server stays in the foreground.

Do not run `playwright install`. Set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` when you install npm dependencies so Playwright's postinstall does not download its own browsers.

## 2. Point Playwright at the CDP endpoint

`resolveObscuraCdpEndpoint()` returns `OBSCURA_CDP_URL`, or `http://127.0.0.1:${OBSCURA_PORT:-9222}` when that variable is unset. `ws://127.0.0.1:9222`, `ws://127.0.0.1:9222/devtools/browser`, and `http://127.0.0.1:9222` all connect. `resolveBrowserCdpEndpoint()` returns the same URL unless `KXM_BROWSER=steel`.

```typescript
import { test as base, chromium, type Browser } from "@playwright/test";
import { resolveObscuraCdpEndpoint } from "@kontextmind/kxm/runtime";

export const test = base.extend<{}, { browser: Browser }>({
  browser: [async ({}, use) => {
    const browser = await chromium.connectOverCDP(resolveObscuraCdpEndpoint());
    await use(browser);
    await browser.close();
  }, { scope: "worker" }],
});

export { expect } from "@playwright/test";
```

In `playwright.config.ts`, set `workers: 1`, `video: "off"`, and `trace: "retain-on-failure"`. Video recording is unsupported. `newContext()` isolation works. `storageState` is limited. The browser timezone defaults to `Europe/Berlin`; set `OBSCURA_TIMEZONE` on the Obscura process to override it. KXM does not read `OBSCURA_TIMEZONE`. Obscura ignores `HTTP_PROXY` and `HTTPS_PROXY`.

A bind that is not loopback needs `OBSCURA_CDP_TOKEN` (at least 32 bytes) sent as an `Authorization: Bearer` header. The launcher binds `127.0.0.1` and does not set that token.

## 3. Run the smoke test

`npm run e2e` ensures Obscura is ready, then runs `playwright test`. The repository smoke test serves a page on `127.0.0.1` and asserts that page. It does not need the public internet.

```bash
npm run e2e
```

The `node --test` suite does not collect `test/e2e/`.

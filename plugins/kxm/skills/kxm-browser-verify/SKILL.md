---
name: kxm-browser-verify
description: Reproduce UI bugs, collect diagnostic evidence, and create permanent Playwright regression tests. Obscura is the default browser. Steel is only for human takeover, MFA, and the live session viewer.
---

# KXM Playwright Reproduction and Verification

Use this skill to systematically reproduce UI issues, collect diagnostic evidence, create durable Playwright tests, verify failures before fixes, and confirm green assertions afterward.

Obscura is the default for every Playwright test and verification run. Steel remains for human takeover, MFA, and the live session viewer. Set `KXM_BROWSER=steel` only for that Steel path.

## Purpose & Scope

- Support the standard KXM verification loop:
  `Request -> Reproduce -> Collect Diagnostic Evidence -> Create Playwright Test -> Demonstrate Failure -> Implement Fix -> Demonstrate Success`.
- Connect Playwright through the worker-scoped `browser` fixture and `chromium.connectOverCDP()`. Obscura does not speak Playwright's own protocol (`chromium.connect`, `use.connectOptions`).
- Produce deterministic tests and sanitized evidence. Leave video recording off. Obscura does not support it.

## Test Lifecycle & Workflow

```text
1. REPRODUCE
   └─ Run the flow against Obscura (KXM_BROWSER=steel only when the bug is inside a Steel takeover session).

2. COLLECT DIAGNOSTIC EVIDENCE
   └─ Capture network logs, console errors, and a before-state screenshot.

3. WRITE PLAYWRIGHT TEST
   └─ Author a durable test with explicit assertions against semantic locators.

4. DEMONSTRATE FAILURE (RED)
   └─ Run the test against the unfixed application and confirm the failure matches the report.

5. IMPLEMENT FIX
   └─ Apply code modifications within repository scope.

6. DEMONSTRATE SUCCESS (GREEN)
   └─ Re-run the Playwright test and confirm the assertions pass.
```

## Connecting Playwright to Obscura

Start Obscura, then run Playwright. Do not run `playwright install`.

```bash
node scripts/obscura.mjs --ensure
npm run e2e
```

`npm run e2e` runs the launcher and then `playwright test`. The endpoint comes from `resolveObscuraCdpEndpoint()` (`OBSCURA_CDP_URL`, or `http://127.0.0.1:${OBSCURA_PORT:-9222}`).

Override the worker-scoped `browser` fixture:

```typescript
import { test as base, chromium, type Browser } from "@playwright/test";
import { resolveObscuraCdpEndpoint } from "@kontextmind/kxm/runtime";

export const test = base.extend<{}, { browser: Browser }>({
  browser: [async ({}, use) => {
    const browser = await chromium.connectOverCDP(resolveObscuraCdpEndpoint());
    await use(browser);
    await browser.close();
  }, { scope: "worker" }],
import { test, expect, chromium } from "@playwright/test";
import { formatCDPConnect, resolveSteelConfig } from "@kontextmind/kxm/runtime";

test("reproduce and verify UI issue", async () => {
  const sessionId = process.env.STEEL_SESSION_ID;
  if (!sessionId) {
    throw new Error("STEEL_SESSION_ID environment variable is required");
  }

  // Authorization: Basic on the CDP handshake. The URL has no credential.
  const { url, headers } = formatCDPConnect(
    { id: sessionId, websocketUrl: "" },
    resolveSteelConfig(),
  );
  const browser = await chromium.connectOverCDP(url, { headers });
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();

  await page.goto("https://app.example.com/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  // Exercise reproducible interaction
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByText("Changes saved successfully")).toBeVisible();

  // Disconnect client without destroying the remote container
  await browser.close();
});

export { expect } from "@playwright/test";
```

In `playwright.config.ts`, set `video: "off"` and `trace: "retain-on-failure"`. `newContext()` isolation works. `storageState` is limited. The browser timezone defaults to `Europe/Berlin` unless the Obscura process has `OBSCURA_TIMEZONE` set. Obscura ignores `HTTP_PROXY` and `HTTPS_PROXY`.

Local pages require the launcher flag `--allow-private-network` (the launcher always passes it). Without that flag, `page.goto("http://127.0.0.1:...")` fails with `Access to private/internal IP address`.

## Steel, only for takeover

When the case is human takeover, MFA, or the live session viewer, set `KXM_BROWSER=steel` and attach to the Steel session CDP URL from `resolveBrowserCdpEndpoint(session)`. That path is `formatCDPEndpoint()`. Closing the Playwright browser disconnects the client and does not release the Steel session.

## Artifact Retention & Sanitization

- Save test traces to `.kxm/artifacts/browser/trace-<runId>.zip`.
- Sanitize recorded traces and screenshots: mask password fields, authorization headers, and personal data.
- Keep permanent regression tests under `test/e2e/`. Scratch reproduction scripts stay out of that directory.

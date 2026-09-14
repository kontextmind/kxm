---
name: kxm-browser-verify
description: Reproduce UI bugs, collect diagnostic evidence, and create permanent Playwright regression tests connected to Steel.
---

# KXM Playwright Reproduction and Verification

Use this skill to systematically reproduce UI issues, collect diagnostic evidence, create durable Playwright tests, verify failures before fixes, and confirm green assertions afterward.

## Purpose & Scope

- Support the standard KXM verification loop:
  `Request -> Reproduce -> Collect Diagnostic Evidence -> Create Playwright Test -> Demonstrate Failure -> Implement Fix -> Demonstrate Success`.
- Connect Playwright tests to self-hosted Steel on DOKS via `chromium.connectOverCDP()`.
- Produce deterministic, reproducible test suites and sanitized evidence artifacts (traces, videos, screenshots).

## Test Lifecycle & Workflow

```text
1. REPRODUCE
   └─ Run exploratory flow or minimal script on Steel to confirm bug symptoms.

2. COLLECT DIAGNOSTIC EVIDENCE
   └─ Capture network logs, console errors, and before-state screenshot.

3. WRITE PLAYWRIGHT TEST
   └─ Author durable test with explicit assertions against semantic locators.

4. DEMONSTRATE FAILURE (RED)
   └─ Run test against unfixed application state; confirm failure matches bug report.

5. IMPLEMENT FIX
   └─ Apply code modifications within repository scope.

6. DEMONSTRATE SUCCESS (GREEN)
   └─ Re-run Playwright test; confirm all assertions pass cleanly.
```

## Connecting Playwright to Steel

```typescript
import { test, expect, chromium } from "@playwright/test";

test("reproduce and verify UI issue", async () => {
  const cdpUrl = process.env.STEEL_CDP_URL;
  if (!cdpUrl) {
    throw new Error("STEEL_CDP_URL environment variable is required");
  }

  // Connect directly to remote Steel session
  const browser = await chromium.connectOverCDP(cdpUrl);
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
```

## Artifact Retention & Sanitization

- Save test traces to `.kxm/artifacts/browser/trace-<runId>.zip`.
- Sanitize recorded traces and screenshots: ensure password fields, authorization headers, and personal data are masked.
- Distinguish temporary scratch reproduction scripts from permanent regression tests under `test/e2e/`.

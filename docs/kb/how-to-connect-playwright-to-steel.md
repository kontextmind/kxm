---
schema: "kxm.doc.v1"
id: "KB-BROWSER-007"
type: "kb"
title: "How do I connect Playwright to the existing Steel session?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-14"
authority: "instruction"
confidence: "verified"
summary: "Guide to attaching Playwright tests to an active remote Steel browser session using chromium.connectOverCDP()."
tags: ["browser", "playwright", "cdp", "steel", "testing"]
related: ["docs/browser-automation.md", "docs/kb/why-automation-opened-different-browser.md"]
---

# How do I connect Playwright to the existing Steel session?

To run Playwright tests against self-hosted Steel on DOKS instead of a local browser:

## 1. Retrieve the CDP Endpoint

Format the WebSocket CDP URL using the active session ID and API key:

```typescript
import { formatCDPEndpoint, resolveSteelConfig } from "@kontextmind/kxm/runtime";

const config = resolveSteelConfig();
const cdpUrl = formatCDPEndpoint({ id: sessionId, websocketUrl: "" }, config);
```

The resulting URL will look like:
`wss://steel.kontextmind.com/v1/devtools?sessionId=<SESSION_ID>&apiKey=<STEEL_API_KEY>`

## 2. Connect in Playwright

```typescript
import { test, expect, chromium } from "@playwright/test";

test("execute test on remote steel session", async () => {
  const browser = await chromium.connectOverCDP(process.env.STEEL_CDP_URL!);
  
  // Use existing context or create one
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();

  await page.goto("https://app.example.com");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // Disconnecting closes the Playwright CDP socket without terminating the remote container
  await browser.close();
});
```

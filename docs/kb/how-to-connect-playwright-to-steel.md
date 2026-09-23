---
schema: "kxm.doc.v1"
id: "KB-BROWSER-007"
type: "kb"
title: "How do I connect Playwright to the existing Steel session?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-23"
authority: "instruction"
confidence: "verified"
summary: "Attach Playwright to an active remote Steel browser session with chromium.connectOverCDP()."
tags: ["browser", "playwright", "cdp", "steel", "testing"]
related: ["docs/guides/browser-automation.md", "docs/kb/why-automation-opened-different-browser.md"]
---

# How do I connect Playwright to the existing Steel session?

Run Playwright against a remote Steel session instead of a local browser by
connecting over the Chrome DevTools Protocol (CDP).

## 1. Build the CDP endpoint

Build the WebSocket CDP URL from the active session ID. The configuration comes
from `STEEL_API_URL` and `STEEL_API_KEY`:

```typescript
import { formatCDPEndpoint, resolveSteelConfig } from "@kontextmind/kxm/runtime";

const config = resolveSteelConfig();
const cdpUrl = formatCDPEndpoint({ id: sessionId, websocketUrl: "" }, config);
```

The result has this shape. It carries the API key, so never log it:

```text
wss://<steel-host>/v1/devtools?sessionId=<session-id>&apiKey=<steel-api-key>
```

## 2. Connect in Playwright

```typescript
import { test, expect, chromium } from "@playwright/test";

test("execute test on remote steel session", async () => {
  const browser = await chromium.connectOverCDP(process.env.STEEL_CDP_URL!);

  // Use the existing context and page, or create them.
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();

  await page.goto("https://app.example.com");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // Closing drops the CDP socket; it does not end the remote session.
  await browser.close();
});
```

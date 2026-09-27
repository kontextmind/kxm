---
schema: "kxm.doc.v1"
id: "KB-BROWSER-007"
type: "kb"
title: "How do I connect Playwright to the existing Steel session?"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-14"
updated: "2026-09-27"
authority: "instruction"
confidence: "verified"
summary: "Attach Playwright to an active remote Steel browser session with chromium.connectOverCDP()."
tags: ["browser", "playwright", "cdp", "steel", "testing"]
related: ["docs/guides/browser-automation.md", "docs/kb/how-to-connect-playwright-to-obscura.md", "docs/kb/why-automation-opened-different-browser.md"]
---

# How do I connect Playwright to the existing Steel session?

Obscura is the default for Playwright testing and verification. Use this page when `KXM_BROWSER=steel` and you are attaching to a live Steel session for human takeover, MFA, or the session viewer. The default path is [How do I connect Playwright to Obscura?](how-to-connect-playwright-to-obscura.md).

Run Playwright against a remote Steel session instead of a local browser by
connecting over the Chrome DevTools Protocol (CDP). When `KXM_BROWSER=steel`,
`resolveBrowserCdpEndpoint(session)` returns the same URL as `formatCDPEndpoint()`.
The handshake needs the headers from `resolveBrowserCdpConnect(session)` or
`formatCDPConnect()`. `connectBrowserOverCdp()` passes those headers into
`chromium.connectOverCDP`.

## 1. Build the CDP endpoint

Build the WebSocket CDP URL from the active session ID, and take the headers
with it. Authentik forward auth accepts the app password only as
`Authorization: Basic` on the WebSocket handshake. The URL does not carry the
credential when `STEEL_AUTH_BASIC` or `STEEL_AUTH_USER` and `STEEL_AUTH_TOKEN`
are set:

```typescript
import { formatCDPConnect, resolveSteelConfig } from "@kontextmind/kxm/runtime";

const { url, headers } = formatCDPConnect(
  { id: sessionId, websocketUrl: "" },
  resolveSteelConfig(),
);
```

The URL has this shape. The session field `websocketUrl` is the origin
`wss://steel.kontextmind.com/` (it used to be `ws://steel-browser/`). The
connect path is `/v1/devtools`:

```text
wss://steel.kontextmind.com/v1/devtools?sessionId=<session-id>
```

`headers` is `{ Authorization: "Basic <base64>" }`. Pass that object to
Playwright. Do not log it. `STEEL_API_KEY` is deprecated and is not enforced
by Steel or Caddy. Do not put `apiKey` on the URL. `STEEL_AUTH_HEADER`, then
`STEEL_AUTH_BASIC`, then `STEEL_AUTH_USER` and `STEEL_AUTH_TOKEN`, override it.
`kxm` 0.7.135 or newer is required.

## 2. Connect in Playwright

```typescript
import { test, expect, chromium } from "@playwright/test";
import { formatCDPConnect, resolveSteelConfig } from "@kontextmind/kxm/runtime";

test("execute test on remote steel session", async () => {
  const { url, headers } = formatCDPConnect(
    { id: process.env.STEEL_SESSION_ID!, websocketUrl: "" },
    resolveSteelConfig(),
  );
  const browser = await chromium.connectOverCDP(url, { headers });

  // Use the existing context and page, or create them.
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();

  await page.goto("https://app.example.com");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // Closing drops the CDP socket; it does not end the remote session.
  await browser.close();
});
```

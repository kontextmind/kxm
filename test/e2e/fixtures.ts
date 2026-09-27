import { test as base, chromium, type Browser } from "@playwright/test";
import { connectBrowserOverCdp } from "../../plugins/kxm/src/browser.ts";

export const test = base.extend<{}, { browser: Browser }>({
  browser: [async ({}, use) => {
    const sessionId = process.env.STEEL_SESSION_ID?.trim();
    const session = sessionId ? { id: sessionId, websocketUrl: "" } : undefined;
    const browser = await connectBrowserOverCdp(
      (url, options) => chromium.connectOverCDP(url, options),
      session,
    );
    await use(browser);
    await browser.close();
  }, { scope: "worker" }],
});

export { expect } from "@playwright/test";

import { test as base, chromium, type Browser } from "@playwright/test";
import { resolveObscuraCdpEndpoint } from "../../plugins/kxm/src/browser.ts";

const CDP = resolveObscuraCdpEndpoint();

export const test = base.extend<{}, { browser: Browser }>({
  browser: [async ({}, use) => {
    const browser = await chromium.connectOverCDP(CDP);
    await use(browser);
    await browser.close();
  }, { scope: "worker" }],
});

export { expect } from "@playwright/test";

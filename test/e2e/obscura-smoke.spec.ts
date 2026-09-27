import { createServer, type Server } from "node:http";
import { expect, test } from "./fixtures.ts";

const PAGE = "<!doctype html><html><head><title>KXM Obscura smoke</title></head><body><h1>obscura-local-ok</h1></body></html>";

let server: Server;
let url = "";

test.beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("local smoke page did not bind a TCP port");
  }
  url = `http://127.0.0.1:${address.port}/`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("local page via obscura", async ({ page }) => {
  const response = await page.goto(url);
  expect(response?.ok()).toBe(true);
  await expect(page).toHaveTitle("KXM Obscura smoke");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("obscura-local-ok");
  expect(page.url().startsWith("http://127.0.0.1:")).toBe(true);
});

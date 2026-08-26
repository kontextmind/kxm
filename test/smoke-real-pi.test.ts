import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("real multi-Pi smoke skips unless explicitly enabled", async () => {
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, ["scripts/smoke-multi-pi.mjs"], {
      env: { ...process.env, PI_MESH_SMOKE: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("exit", (code) => resolve({ code, stdout }));
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /"skipped":true/);
  assert.doesNotMatch(result.stdout, /PI_MESH_AUTH_TOKEN|GITHUB_TOKEN|sk-/);
});

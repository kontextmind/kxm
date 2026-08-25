import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

function runWorker(environment: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/pi-mesh-worker.mjs"], {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("long-lived worker validates its stable identity", async () => {
  const result = await runWorker({ ...process.env, PI_MESH_AGENT_NAME: "", PI_MESH_PROJECT: "" });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /AGENT_NAME and PI_MESH_PROJECT are required/);
});

test("long-lived worker supervises Pi and honors the restart limit", async () => {
  const result = await runWorker({
    ...process.env,
    PI_MESH_AGENT_NAME: "coordinator",
    PI_MESH_PROJECT: "product",
    PI_MESH_PI_COMMAND: process.execPath,
    PI_MESH_WORKER_MAX_RESTARTS: "0",
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /"event":"worker_starting"/);
  assert.match(result.stdout, /"event":"worker_exited"/);
  assert.match(result.stdout, /"event":"worker_restart_limit_reached"/);
});

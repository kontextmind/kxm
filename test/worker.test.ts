import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-"));
  try {
    const result = await runWorker({
      ...process.env,
      PI_MESH_AGENT_NAME: "coordinator",
      PI_MESH_PROJECT: "product",
      PI_MESH_PI_COMMAND: process.execPath,
      PI_MESH_WORKER_MAX_RESTARTS: "0",
      PI_MESH_WORKDIR: workdir,
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /"event":"worker_starting"/);
    assert.match(result.stdout, /"event":"worker_exited"/);
    assert.match(result.stdout, /"event":"worker_restart_limit_reached"/);
    const structuredLog = join(workdir, ".kxm", "logs", "pi-mesh-worker-coordinator.jsonl");
    const agentLog = join(workdir, ".kxm", "logs", "pi-agent-coordinator.log");
    assert.equal(existsSync(structuredLog), true);
    assert.equal(existsSync(agentLog), true);
    assert.match(readFileSync(structuredLog, "utf8"), /"event":"worker_restart_limit_reached"/);
    assert.match(readFileSync(agentLog, "utf8"), /bad option|unknown option|not allowed/i);
    assert.equal(existsSync(join(workdir, ".kxm", "config")), true);
    assert.equal(existsSync(join(workdir, ".kxm", "assets")), true);
    assert.equal(existsSync(join(workdir, ".kxm", "state")), true);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker treats spawn failures as retryable nonzero exits", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-spawn-"));
  try {
    const result = await runWorker({
      ...process.env,
      PI_MESH_AGENT_NAME: "missing-pi",
      PI_MESH_PROJECT: "product",
      PI_MESH_PI_COMMAND: join(workdir, "does-not-exist"),
      PI_MESH_WORKER_MAX_RESTARTS: "0",
      PI_MESH_WORKDIR: workdir,
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /"event":"worker_process_error"/);
    assert.match(result.stdout, /"event":"worker_exited"/);
    assert.match(result.stdout, /"event":"worker_restart_limit_reached"/);
    const logPath = join(workdir, ".kxm", "logs", "pi-mesh-worker-missing-pi.jsonl");
    assert.match(readFileSync(logPath, "utf8"), /ENOENT/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

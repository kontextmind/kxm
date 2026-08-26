import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("hub wrapper uses an idempotent graceful stop and keeps workspace state under .kxm", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-server-"));
  const environment = { ...process.env };
  for (const key of [
    "PI_MESH_WORKSPACE_DIR",
    "PI_MESH_CONFIG_DIR",
    "PI_MESH_LOGS_DIR",
    "PI_MESH_ASSETS_DIR",
    "PI_MESH_STATE_DIR",
    "PI_MESH_DATA_PATH",
    "PI_MESH_LOG_PATH",
    "PI_MESH_WEBHOOK_WORKFLOWS",
    "PI_MESH_WEBHOOK_WORKFLOWS_FILE",
  ]) delete environment[key];
  Object.assign(environment, {
    PI_MESH_HOST: "127.0.0.1",
    PI_MESH_PORT: "0",
    PI_MESH_AUTH_TOKEN: "server-workspace-test-token",
  });
  const child = spawn(process.execPath, [resolve("scripts/pi-mesh-hub.mjs")], {
    cwd: workdir,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exit = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
  try {
    const url = await new Promise<string>((resolveUrl, reject) => {
      const timeout = setTimeout(() => reject(new Error(`hub did not start: ${stdout}\n${stderr}`)), 5_000);
      const inspect = () => {
        const match = stdout.match(/pi-mesh hub listening at (http:\/\/[^;]+);/);
        if (!match) return;
        clearTimeout(timeout);
        resolveUrl(match[1]!);
      };
      child.stdout.on("data", inspect);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`hub exited before startup with ${code}: ${stderr}`));
      });
    });
    assert.equal((await fetch(`${url}/ready`)).status, 200);
    const stateDir = join(workdir, ".kxm", "state");
    const pidPath = join(stateDir, "hub.pid");
    const recordText = readFileSync(pidPath, "utf8");
    const record = JSON.parse(recordText) as { startedAt: string };
    const duplicate = spawn(process.execPath, [resolve("scripts/pi-mesh-hub.mjs")], {
      cwd: workdir,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let duplicateError = "";
    duplicate.stderr.setEncoding("utf8").on("data", (chunk: string) => { duplicateError += chunk; });
    const duplicateCode = await new Promise<number | null>((resolveExit) => duplicate.once("exit", resolveExit));
    assert.notEqual(duplicateCode, 0);
    assert.match(duplicateError, /hub is already managed by PID/);
    assert.equal(readFileSync(pidPath, "utf8"), recordText);
    writeFileSync(join(stateDir, "hub.stop"), JSON.stringify({ startedAt: record.startedAt, requestedAt: new Date().toISOString() }));
    const exitCode = await exit;
    assert.equal(exitCode, 0);
    const root = join(workdir, ".kxm");
    assert.equal(existsSync(join(root, "config")), true);
    assert.equal(existsSync(join(root, "assets")), true);
    assert.equal(existsSync(join(root, "state", "mesh.db")), true);
    const logPath = join(root, "logs", "pi-mesh-hub.jsonl");
    assert.equal(existsSync(logPath), true);
    const logs = readFileSync(logPath, "utf8");
    assert.match(logs, /"event":"hub_started"/);
    assert.equal((logs.match(/"event":"hub_stopping"/g) ?? []).length, 1);
    assert.equal(stderr, "");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exit;
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("concurrent hub wrappers never replace an unverifiable stale PID claim", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-server-stale-"));
  const stateDir = join(workdir, ".kxm", "state");
  const pidPath = join(stateDir, "hub.pid");
  mkdirSync(stateDir, { recursive: true });
  const staleRecord = `${JSON.stringify({
    version: 1,
    pid: 2_147_483_647,
    role: "hub",
    startedAt: "2000-01-01T00:00:00.000Z",
    controlFile: "hub.stop",
  })}\n`;
  writeFileSync(pidPath, staleRecord);
  const environment = {
    ...process.env,
    PI_MESH_WORKDIR: workdir,
    PI_MESH_HOST: "127.0.0.1",
    PI_MESH_PORT: "0",
    PI_MESH_AUTH_TOKEN: "server-workspace-test-token",
  };
  try {
    const launch = () => new Promise<{ code: number | null; stderr: string }>((resolveExit) => {
      const child = spawn(process.execPath, [resolve("scripts/pi-mesh-hub.mjs")], {
        cwd: workdir,
        env: environment,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("exit", (code) => resolveExit({ code, stderr }));
    });
    const results = await Promise.all([launch(), launch()]);
    for (const result of results) {
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /PID claim is stale/);
    }
    assert.equal(readFileSync(pidPath, "utf8"), staleRecord);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

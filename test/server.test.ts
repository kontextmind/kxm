import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("hub server keeps workspace configuration, logs, assets, and state under .kxm", async () => {
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
  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--experimental-strip-types",
    resolve("plugins/pi-mesh-comms/src/server.ts"),
  ], {
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
    child.kill("SIGTERM");
    const exitCode = await exit;
    assert.equal(exitCode, process.platform === "win32" ? null : 0);
    const root = join(workdir, ".kxm");
    assert.equal(existsSync(join(root, "config")), true);
    assert.equal(existsSync(join(root, "assets")), true);
    assert.equal(existsSync(join(root, "state", "mesh.db")), true);
    const logPath = join(root, "logs", "pi-mesh-hub.jsonl");
    assert.equal(existsSync(logPath), true);
    const logs = readFileSync(logPath, "utf8");
    assert.match(logs, /"event":"hub_started"/);
    if (process.platform !== "win32") assert.match(logs, /"event":"hub_stopping"/);
    assert.equal(stderr, "");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exit;
    rmSync(workdir, { recursive: true, force: true });
  }
});

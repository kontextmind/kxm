#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../plugins/pi-mesh-comms/src/server.ts", import.meta.url));
const workdir = resolve(process.env.PI_MESH_WORKDIR?.trim() || process.cwd());
const workspaceDir = resolve(workdir, process.env.PI_MESH_WORKSPACE_DIR?.trim() || ".kxm");
const stateDir = resolve(workdir, process.env.PI_MESH_STATE_DIR?.trim() || join(workspaceDir, "state"));
mkdirSync(stateDir, { recursive: true });
const pidPath = join(stateDir, "hub.pid");
const startedAt = new Date().toISOString();
const controlFile = "hub.stop";
const controlPath = join(stateDir, controlFile);
rmSync(controlPath, { force: true });
writeFileSync(pidPath, `${JSON.stringify({ version: 1, pid: process.pid, role: "hub", startedAt, controlFile })}\n`, { encoding: "utf8", mode: 0o600 });
function cleanupPid() { try { const record = JSON.parse(readFileSync(pidPath, "utf8")); if (record.pid === process.pid) rmSync(pidPath, { force: true }); } catch { /* replaced */ } }
process.once("exit", cleanupPid);
const child = spawn(process.execPath, [
  "--disable-warning=ExperimentalWarning",
  "--experimental-strip-types",
  server,
  ...process.argv.slice(2),
], {
  stdio: ["inherit", "inherit", "inherit", "ipc"],
  env: process.env,
});
let stopping = false;

child.once("error", (error) => {
  process.stderr.write(`Failed to start pi-mesh hub: ${error.message}\n`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  process.exitCode = stopping ? 0 : (code ?? (signal ? 1 : 1));
});

function requestShutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (!child.connected) { child.kill("SIGTERM"); return; }
  child.send({ type: "shutdown", signal });
  const force = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32" && child.pid) spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    else child.kill("SIGKILL");
  }, 10_000);
  force.unref();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => requestShutdown(signal));
const controlTimer = setInterval(() => {
  try { const request = JSON.parse(readFileSync(controlPath, "utf8")); if (request.startedAt !== startedAt) return; rmSync(controlPath, { force: true }); requestShutdown("operator"); } catch { /* no request */ }
}, 250);
controlTimer.unref();

#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../plugins/kxm/dist/server.js", import.meta.url));
const workdir = resolve(process.env.KXM_WORKDIR?.trim() || process.cwd());
const workspaceDir = resolve(workdir, process.env.KXM_WORKSPACE_DIR?.trim() || ".kxm");
const stateDir = resolve(workdir, process.env.KXM_STATE_DIR?.trim() || join(workspaceDir, "state"));
mkdirSync(stateDir, { recursive: true });
const pidPath = join(stateDir, "hub.pid");
const startedAt = new Date().toISOString();
const controlFile = "hub.stop";
const controlPath = join(stateDir, controlFile);

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function claimPidFile() {
  const record = { version: 1, pid: process.pid, role: "hub", startedAt, controlFile };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync(pidPath, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
      closeSync(descriptor);
      descriptor = undefined;
      return;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error?.code !== "EEXIST") throw error;
      let existing;
      try {
        existing = JSON.parse(readFileSync(pidPath, "utf8"));
      } catch (existingError) {
        if (existingError?.code === "ENOENT") continue;
        throw new Error(
          `KXM hub PID claim is invalid at ${pidPath}; remove it only after verifying no hub process is running`,
          { cause: existingError },
        );
      }
      if (existing?.version === 1 && existing.role === "hub" && Number.isInteger(existing.pid) && processExists(existing.pid)) {
        throw new Error(`KXM hub is already managed by PID ${existing.pid}`);
      }
      throw new Error(
        `KXM hub PID claim is stale at ${pidPath}; remove it only after verifying no hub process is running`,
      );
    }
  }
  throw new Error("could not claim the KXM hub PID file");
}

claimPidFile();
rmSync(controlPath, { force: true });
function cleanupPid() { try { const record = JSON.parse(readFileSync(pidPath, "utf8")); if (record.pid === process.pid) rmSync(pidPath, { force: true }); } catch { /* replaced */ } }
process.once("exit", cleanupPid);
const child = spawn(process.execPath, [
  "--disable-warning=ExperimentalWarning",
  server,
  ...process.argv.slice(2),
], {
  stdio: ["inherit", "inherit", "inherit", "ipc"],
  env: process.env,
});
let stopping = false;

child.once("error", (error) => {
  process.stderr.write(`Failed to start KXM hub: ${error.message}\n`);
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

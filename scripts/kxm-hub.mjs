#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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

// --- Persistent hub credentials (kxm.hub-env.v1) -------------------------
// Precedence: KXM_AUTH_TOKEN/KXM_PROJECT_TOKENS env, then the persisted
// user-state file, then a generated admin token that is persisted so later
// restarts, workers, and dashboards reuse the same credential.
function resolveUserStateRoot() {
  const explicit = process.env.KXM_STATE_HOME?.trim();
  if (explicit) return resolve(explicit);
  const home = homedir();
  if (process.platform === "win32") return resolve(process.env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local"), "KXM");
  if (process.platform === "darwin") return resolve(home, "Library", "Application Support", "KXM");
  return resolve(process.env.XDG_STATE_HOME?.trim() || join(home, ".local", "state"), "kxm");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function parseHubEnvFile() {
  const file = join(resolveUserStateRoot(), "hub-env.json");
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { file, record: undefined };
    throw new Error(`KXM hub could not read the persisted hub env at ${file}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`KXM hub env file is malformed at ${file}; fix or remove it (it holds only KXM_AUTH_TOKEN/KXM_PROJECT_TOKENS values): ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.schema !== "kxm.hub-env.v1") {
    throw new Error(`KXM hub env file at ${file} does not use schema kxm.hub-env.v1`);
  }
  return { file, record: parsed };
}

function generateAdminToken() {
  return `kxm_admin_${randomBytes(24).toString("base64url")}`;
}

function persistHubEnv(file, record) {
  mkdirSync(resolve(file, ".."), { recursive: true });
  const temporary = join(resolve(file, ".."), `.hub-env-${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(record, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function parseProjectTokensEnv(raw) {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("KXM_PROJECT_TOKENS must be a JSON object of project names to tokens");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("KXM_PROJECT_TOKENS must be a JSON object of project names to tokens");
  }
  for (const [project, token] of Object.entries(parsed)) {
    if (!project.trim() || typeof token !== "string" || !token.trim()) {
      throw new Error("KXM_PROJECT_TOKENS must contain non-empty project names and token strings");
    }
  }
  return parsed;
}

/** Resolve credentials, persisting generated/env values into the user-state file. */
function resolveCredentials() {
  const { file, record } = parseHubEnvFile();
  const envToken = process.env.KXM_AUTH_TOKEN?.trim();
  const envProjectTokens = parseProjectTokensEnv(process.env.KXM_PROJECT_TOKENS);
  let authToken = envToken || record?.authToken;
  let authTokenSource = envToken ? "env" : record?.authToken ? "file" : "none";
  if (!authToken) {
    authToken = generateAdminToken();
    authTokenSource = "generated";
  }
  const projectTokens = envProjectTokens || record?.projectTokens;
  const projectTokensSource = envProjectTokens ? "env" : record?.projectTokens ? "file" : "none";
  const envChanged = (authTokenSource === "env" && record?.authToken !== authToken)
    || (projectTokensSource === "env" && JSON.stringify(record?.projectTokens ?? undefined) !== JSON.stringify(projectTokens ?? undefined));
  if (authTokenSource === "generated" || envChanged) {
    persistHubEnv(file, {
      schema: "kxm.hub-env.v1",
      createdAt: record?.createdAt || new Date().toISOString(),
      ...(authToken ? { authToken } : {}),
      ...(projectTokens ? { projectTokens } : {}),
    });
  }
  return { authToken, authTokenSource, projectTokens, projectTokensSource, file };
}

let credentials;
try {
  credentials = resolveCredentials();
} catch (error) {
  process.stderr.write(`kxm hub: ${error.message}\n`);
  process.exit(1);
}
const launchEnv = { ...process.env };
if (credentials.authToken) launchEnv.KXM_AUTH_TOKEN = credentials.authToken;
if (credentials.projectTokens) launchEnv.KXM_PROJECT_TOKENS = JSON.stringify(credentials.projectTokens);
if (credentials.authTokenSource !== "env") {
  process.stdout.write(`kxm hub: using ${credentials.authTokenSource === "generated" ? "newly generated" : "persisted"} KXM_AUTH_TOKEN from ${credentials.file}\n`);
}

function terminateTree(pid) {
  // Best-effort cleanup of an orphaned hub server whose wrapper died
  // without reclaiming (e.g. SIGKILL). The wrapper could not be stopped
  // gracefully in that state, so the server is asked to shut down first and
  // forced after a short grace period.
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    const wait = Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    if (wait !== "timed-out") return;
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
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
      // A well-formed claim whose wrapper is dead is safe to reclaim. Keep
      // malformed claims fail-closed because they may belong to another tool.
      if (existing?.version === 1 && existing.role === "hub" && Number.isInteger(existing.pid) && !processExists(existing.pid)) {
        // The wrapper is gone. An orphaned server child recorded by the dead
        // wrapper is cleaned up before reclaiming so a SIGKILLed wrapper does
        // not leave a port-holding server behind.
        if (Number.isInteger(existing.serverPid) && existing.serverPid !== existing.pid && processExists(existing.serverPid)) {
          process.stderr.write(`kxm hub: cleaning up orphaned hub server PID ${existing.serverPid} from a dead wrapper\n`);
          terminateTree(existing.serverPid);
        }
        rmSync(pidPath, { force: true });
        continue;
      }
      throw new Error(
        `KXM hub PID claim is stale at ${pidPath}; remove it only after verifying no hub process is running`,
      );
    }
  }
  throw new Error("could not claim the KXM hub PID file");
}

try {
  claimPidFile();
} catch (error) {
  process.stderr.write(`kxm hub: ${error.message}. Run kxm hub stop before starting another hub.\n`);
  process.exit(1);
}
rmSync(controlPath, { force: true });
function cleanupPid() { try { const record = JSON.parse(readFileSync(pidPath, "utf8")); if (record.pid === process.pid) rmSync(pidPath, { force: true }); } catch { /* replaced */ } }
process.once("exit", cleanupPid);
const child = spawn(process.execPath, [
  "--disable-warning=ExperimentalWarning",
  server,
  ...process.argv.slice(2),
], {
  stdio: ["inherit", "inherit", "inherit", "ipc"],
  env: launchEnv,
});
// Record the server child PID inside the claim so a later wrapper can clean
// up an orphaned server if this wrapper is killed without running cleanupPid.
if (child.pid) {
  try {
    writeFileSync(pidPath, `${JSON.stringify({ version: 1, pid: process.pid, serverPid: child.pid, role: "hub", startedAt, controlFile })}\n`, "utf8");
  } catch { /* claim already written; serverPid tracking is best-effort */ }
}
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

#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const name = process.env.PI_MESH_AGENT_NAME?.trim();
const project = process.env.PI_MESH_PROJECT?.trim();
if (!name || !project) {
  throw new Error("PI_MESH_AGENT_NAME and PI_MESH_PROJECT are required for a long-lived worker");
}

const command = process.env.PI_MESH_PI_COMMAND?.trim() || (process.platform === "win32" ? "pi.cmd" : "pi");
const workdir = resolve(process.env.PI_MESH_WORKDIR?.trim() || process.cwd());
const workspaceDir = resolve(workdir, process.env.PI_MESH_WORKSPACE_DIR?.trim() || ".kxm");
const configDir = resolve(workdir, process.env.PI_MESH_CONFIG_DIR?.trim() || join(workspaceDir, "config"));
const logsDir = resolve(workdir, process.env.PI_MESH_LOGS_DIR?.trim() || join(workspaceDir, "logs"));
const assetsDir = resolve(workdir, process.env.PI_MESH_ASSETS_DIR?.trim() || join(workspaceDir, "assets"));
const stateDir = resolve(workdir, process.env.PI_MESH_STATE_DIR?.trim() || join(workspaceDir, "state"));
const safeName = name.replace(/[^A-Za-z0-9_.-]/g, "_");
const logPath = resolve(workdir, process.env.PI_MESH_WORKER_LOG_PATH?.trim() || join(logsDir, `pi-mesh-worker-${safeName}.jsonl`));
const agentLogPath = resolve(workdir, process.env.PI_MESH_AGENT_LOG_PATH?.trim() || join(logsDir, `pi-agent-${safeName}.log`));
for (const directory of [configDir, logsDir, assetsDir, stateDir, dirname(logPath), dirname(agentLogPath)]) {
  mkdirSync(directory, { recursive: true });
}
const logStream = createWriteStream(logPath, { flags: "a", mode: 0o600 });
const agentLogStream = createWriteStream(agentLogPath, { flags: "a", mode: 0o600 });
const minBackoffMs = 1_000;
const maxBackoffMs = 30_000;
const maxRestartsRaw = process.env.PI_MESH_WORKER_MAX_RESTARTS?.trim();
const maxRestarts = maxRestartsRaw === undefined ? Number.POSITIVE_INFINITY : Number(maxRestartsRaw);
if ((!Number.isInteger(maxRestarts) && maxRestarts !== Number.POSITIVE_INFINITY) || maxRestarts < 0) {
  throw new Error("PI_MESH_WORKER_MAX_RESTARTS must be a non-negative integer");
}
let backoffMs = minBackoffMs;
let restartCount = 0;
let child;
let stopping = false;
let logsClosed = false;

function quoteWindowsCommandArgument(value, label) {
  if (/[\0\r\n"%!]/.test(value)) {
    throw new Error(`${label} contains characters that cannot be passed safely to a Windows command script`);
  }
  return `"${value}"`;
}

function log(event, details = {}) {
  const line = `${JSON.stringify({ timestamp: new Date().toISOString(), event, worker: name, project, ...details })}\n`;
  logStream.write(line);
  process.stdout.write(line);
}

function closeLogs() {
  if (logsClosed) return;
  logsClosed = true;
  logStream.end();
  agentLogStream.end();
}

function start() {
  const args = ["--mode", "rpc", "--name", name];
  if (process.env.PI_MESH_WORKER_CONTINUE !== "false") args.push("--continue");
  if (process.env.PI_MESH_WORKER_MODEL?.trim()) args.push("--model", process.env.PI_MESH_WORKER_MODEL.trim());
  const windowsCommandScript = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
  const launchCommand = windowsCommandScript ? process.env.ComSpec?.trim() || "cmd.exe" : command;
  const windowsCommandLine = windowsCommandScript
    ? `"${[command, ...args].map((value, index) => quoteWindowsCommandArgument(value, index === 0 ? "PI_MESH_PI_COMMAND" : "Pi argument")).join(" ")}"`
    : undefined;
  const launchArgs = windowsCommandLine ? ["/d", "/s", "/v:off", "/c", windowsCommandLine] : args;
  log("worker_starting", {
    command,
    launcher: launchCommand,
    workdir,
    workspaceDir,
    configDir,
    logsDir,
    assetsDir,
    stateDir,
    logPath,
    agentLogPath,
  });
  const startedAt = Date.now();
  let completed = false;
  const complete = (code, signal, error) => {
    if (completed) return;
    completed = true;
    child = undefined;
    if (error) log("worker_process_error", { message: error.message, code: error.code });
    log("worker_exited", { code, signal, ...(error ? { error: error.message } : {}), uptimeMs: Date.now() - startedAt });
    if (stopping) {
      closeLogs();
      return;
    }
    if (restartCount >= maxRestarts) {
      log("worker_restart_limit_reached", { restartCount });
      process.exitCode = code || 1;
      closeLogs();
      return;
    }
    restartCount += 1;
    if (Date.now() - startedAt > 60_000) backoffMs = minBackoffMs;
    const delay = backoffMs;
    backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
    log("worker_restart_scheduled", { delayMs: delay, restartCount });
    setTimeout(start, delay);
  };
  try {
    child = spawn(launchCommand, launchArgs, {
      cwd: workdir,
      env: {
        ...process.env,
        PI_MESH_WORKSPACE_DIR: workspaceDir,
        PI_MESH_CONFIG_DIR: configDir,
        PI_MESH_LOGS_DIR: logsDir,
        PI_MESH_ASSETS_DIR: assetsDir,
        PI_MESH_STATE_DIR: stateDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: windowsCommandScript,
    });
  } catch (error) {
    complete(null, null, error instanceof Error ? error : new Error(String(error)));
    return;
  }
  child.stdout.on("data", (chunk) => {
    agentLogStream.write(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    agentLogStream.write(chunk);
    process.stderr.write(chunk);
  });
  child.once("error", (error) => complete(null, null, error));
  child.once("exit", (code, signal) => complete(code, signal));
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log("worker_stopping", { signal });
  if (!child) {
    closeLogs();
    return;
  }
  child.kill("SIGTERM");
  const force = setTimeout(() => child?.kill("SIGKILL"), 10_000);
  force.unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
start();

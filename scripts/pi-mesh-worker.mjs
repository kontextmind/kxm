#!/usr/bin/env node
import { spawn } from "node:child_process";

const name = process.env.PI_MESH_AGENT_NAME?.trim();
const project = process.env.PI_MESH_PROJECT?.trim();
if (!name || !project) {
  throw new Error("PI_MESH_AGENT_NAME and PI_MESH_PROJECT are required for a long-lived worker");
}

const command = process.env.PI_MESH_PI_COMMAND?.trim() || (process.platform === "win32" ? "pi.cmd" : "pi");
const workdir = process.env.PI_MESH_WORKDIR?.trim() || process.cwd();
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

function log(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event, worker: name, project, ...details })}\n`);
}

function start() {
  const args = ["--mode", "rpc", "--name", name];
  if (process.env.PI_MESH_WORKER_CONTINUE !== "false") args.push("--continue");
  if (process.env.PI_MESH_WORKER_MODEL?.trim()) args.push("--model", process.env.PI_MESH_WORKER_MODEL.trim());
  log("worker_starting", { command, workdir });
  const startedAt = Date.now();
  child = spawn(command, args, {
    cwd: workdir,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.once("error", (error) => log("worker_process_error", { message: error.message }));
  child.once("exit", (code, signal) => {
    child = undefined;
    log("worker_exited", { code, signal, uptimeMs: Date.now() - startedAt });
    if (stopping) return;
    if (restartCount >= maxRestarts) {
      log("worker_restart_limit_reached", { restartCount });
      process.exitCode = code || 1;
      return;
    }
    restartCount += 1;
    if (Date.now() - startedAt > 60_000) backoffMs = minBackoffMs;
    const delay = backoffMs;
    backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
    log("worker_restart_scheduled", { delayMs: delay, restartCount });
    setTimeout(start, delay);
  });
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log("worker_stopping", { signal });
  if (!child) return;
  child.kill("SIGTERM");
  const force = setTimeout(() => child?.kill("SIGKILL"), 10_000);
  force.unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
start();

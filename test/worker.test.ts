import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const inheritedWorkspaceKeys = [
  "PI_MESH_WORKSPACE_DIR",
  "PI_MESH_CONFIG_DIR",
  "PI_MESH_LOGS_DIR",
  "PI_MESH_ASSETS_DIR",
  "PI_MESH_STATE_DIR",
  "PI_MESH_WORKER_LOG_PATH",
  "PI_MESH_AGENT_LOG_PATH",
  "PI_MESH_WORKER_CONTINUE",
] as const;

function isolatedWorkerEnv(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...environment };
  for (const key of inheritedWorkspaceKeys) {
    if (environment[key] === undefined || environment[key] === process.env[key]) delete env[key];
  }
  return env;
}

function runWorker(environment: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/pi-mesh-worker.mjs"], {
      cwd: process.cwd(),
      env: isolatedWorkerEnv(environment),
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

test("long-lived worker launches command scripts through ComSpec on Windows", {
  skip: process.platform !== "win32",
}, async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-cmd-"));
  const commandDirectory = join(workdir, "command scripts");
  const command = join(commandDirectory, "fake pi.cmd");
  const receivedArguments = join(workdir, "received-arguments.txt");
  try {
    mkdirSync(commandDirectory, { recursive: true });
    writeFileSync(command, `@echo off\r\necho %* > "${receivedArguments}"\r\nexit /b 7\r\n`, "utf8");
    const result = await runWorker({
      ...process.env,
      PI_MESH_AGENT_NAME: "windows coordinator &(safe)",
      PI_MESH_PROJECT: "product",
      PI_MESH_PI_COMMAND: command,
      PI_MESH_WORKER_MODEL: "vendor/model:latest",
      PI_MESH_WORKER_MAX_RESTARTS: "0",
      PI_MESH_WORKDIR: workdir,
    });
    assert.equal(result.code, 7, `${result.stderr}\n${result.stdout}`);
    assert.doesNotMatch(result.stdout, /worker_process_error/);
    assert.match(result.stdout, /"launcher":".*cmd\.exe"/i);
    assert.match(result.stdout, /"event":"worker_exited","worker":"windows coordinator &\(safe\)".*"code":7/);
    const args = readFileSync(receivedArguments, "utf8");
    assert.match(args, /"--name" "windows coordinator &\(safe\)"/);
    assert.match(args, /"--model" "vendor\/model:latest"/);
    const rejected = await runWorker({
      ...process.env,
      PI_MESH_AGENT_NAME: "unsafe%PATH%",
      PI_MESH_PROJECT: "product",
      PI_MESH_PI_COMMAND: command,
      PI_MESH_WORKER_MAX_RESTARTS: "0",
      PI_MESH_WORKDIR: workdir,
    });
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /cannot be passed safely to a Windows command script/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker falls back from an unresumable --continue start", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-fallback-"));
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
    assert.match(result.stdout, /"event":"worker_continue_fallback"/);
    const envelope = JSON.parse(readFileSync(join(workdir, ".kxm", "state", "worker-recovery-coordinator.json"), "utf8")) as {
      version: number;
      reason: string;
      agentName: string;
    };
    assert.equal(envelope.version, 1);
    assert.equal(envelope.reason, "unresumable_session");
    assert.equal(envelope.agentName, "coordinator");
    assert.doesNotMatch(JSON.stringify(envelope), /prompt|sk-|ghp_/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker drains SIGTERM before SIGKILL", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-drain-"));
  const hang = join(workdir, "hang.cjs");
  writeFileSync(hang, "setInterval(() => {}, 1000);\n");
  const command = process.platform === "win32" ? join(workdir, "hang.cmd") : join(workdir, "hang.sh");
  writeFileSync(
    command,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${hang}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${hang}" "$@"\n`,
  );
  try {
    const child = spawn(process.execPath, ["scripts/pi-mesh-worker.mjs"], {
      cwd: process.cwd(),
      env: isolatedWorkerEnv({
        PI_MESH_AGENT_NAME: "drainer",
        PI_MESH_PROJECT: "product",
        PI_MESH_PI_COMMAND: command,
        PI_MESH_WORKER_MAX_RESTARTS: "0",
        PI_MESH_WORKER_DRAIN_MS: "200",
        PI_MESH_WORKER_STOP_AFTER_MS: "150",
        PI_MESH_WORKDIR: workdir,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    await new Promise((resolve) => child.once("exit", resolve));
    assert.match(stdout, /"event":"worker_drain_wait"/);
    assert.match(stdout, /"event":"worker_stopping"/);
  } finally {
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      setTimeout(() => {
        try {
          rmSync(workdir, { recursive: true, force: true });
        } catch {
          // Windows may keep a short lock on a just-killed child directory.
        }
      }, 250).unref();
    }
  }
});

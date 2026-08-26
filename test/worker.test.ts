import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const stateDir = join(workdir, ".kxm", "state");
  const fixture = join(workdir, "unresumable.cjs");
  const failure = join(workdir, process.platform === "win32" ? "unresumable.cmd" : "unresumable.sh");
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "worker-context-coordinator.json"), JSON.stringify({
      version: 1,
      agentName: "coordinator",
      project: "product",
      runId: "run_durable",
      stageId: "implementation",
      pendingMessageIds: ["msg_pending"],
      artifactPointers: [".kxm/assets/implementation.md"],
    }));
    writeFileSync(fixture, "process.stderr.write('invalid_request_error: missing_tool_'); setTimeout(() => { process.stderr.write('result for tool_use id'); process.exit(9); }, 10);\n");
    writeFileSync(failure, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    if (process.platform !== "win32") chmodSync(failure, 0o700);
    const result = await runWorker({
      ...process.env,
      PI_MESH_AGENT_NAME: "coordinator",
      PI_MESH_PROJECT: "product",
      PI_MESH_PI_COMMAND: failure,
      PI_MESH_WORKER_MAX_RESTARTS: "0",
      PI_MESH_WORKDIR: workdir,
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /"event":"worker_continue_fallback"/);
    const envelope = JSON.parse(readFileSync(join(workdir, ".kxm", "state", "worker-recovery-coordinator.json"), "utf8")) as {
      version: number;
      reason: string;
      agentName: string;
      runId: string;
      stageId: string;
      pendingMessageIds: string[];
      artifactPointers: string[];
    };
    assert.equal(envelope.version, 1);
    assert.equal(envelope.reason, "unresumable_session");
    assert.equal(envelope.agentName, "coordinator");
    assert.equal(envelope.runId, "run_durable");
    assert.equal(envelope.stageId, "implementation");
    assert.deepEqual(envelope.pendingMessageIds, ["msg_pending"]);
    assert.deepEqual(envelope.artifactPointers, [".kxm/assets/implementation.md"]);
    assert.doesNotMatch(JSON.stringify(envelope), /prompt|sk-|ghp_/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker does not treat unrelated auth failures as unresumable sessions", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-auth-"));
  const fixture = join(workdir, "auth-failure.cjs");
  const command = join(workdir, process.platform === "win32" ? "auth-failure.cmd" : "auth-failure.sh");
  try {
    writeFileSync(fixture, "process.stderr.write('authentication failed: please login\\n'); process.exit(9);\n");
    writeFileSync(command, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    if (process.platform !== "win32") chmodSync(command, 0o700);
    const result = await runWorker({
      PI_MESH_AGENT_NAME: "coordinator",
      PI_MESH_PROJECT: "product",
      PI_MESH_PI_COMMAND: command,
      PI_MESH_WORKER_MAX_RESTARTS: "0",
      PI_MESH_WORKDIR: workdir,
    });
    assert.equal(result.code, 9);
    assert.doesNotMatch(result.stdout, /worker_continue_fallback/);
    assert.equal(existsSync(join(workdir, ".kxm", "state", "worker-recovery-coordinator.json")), false);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker ignores stale RPC responses and confirms abort during active mesh_await", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-drain-"));
  const rpc = join(workdir, "rpc.cjs");
  writeFileSync(rpc, [
    "let input = ''; let confirmed = false;",
    "process.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolName: 'mesh_await' }) + '\\n');",
    "process.stdout.write(JSON.stringify({ id: 'stale-abort', type: 'response', command: 'abort', success: true }) + '\\n');",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (value) => {",
    "  input += value; let newline;",
    "  while ((newline = input.indexOf('\\n')) >= 0) {",
    "    const line = input.slice(0, newline); input = input.slice(newline + 1);",
    "    const request = JSON.parse(line); if (request.type !== 'abort') continue;",
    "    process.stdout.write(JSON.stringify({ type: 'agent_event', event: 'await_still_active' }) + '\\n');",
    "    setTimeout(() => { confirmed = true; process.stdout.write('CURRENT_ABORT_CONFIRMED\\n'); process.stdout.write(JSON.stringify({ id: request.id, type: 'response', command: 'abort', success: true }) + '\\n'); }, 80);",
    "  }",
    "});",
    "process.stdin.on('end', () => process.exit(confirmed ? 0 : 7));",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  const command = process.platform === "win32" ? join(workdir, "rpc.cmd") : join(workdir, "rpc.sh");
  writeFileSync(
    command,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${rpc}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${rpc}" "$@"\n`,
  );
  if (process.platform !== "win32") chmodSync(command, 0o755);
  try {
    const child = spawn(process.execPath, ["scripts/pi-mesh-worker.mjs"], {
      cwd: process.cwd(),
      env: isolatedWorkerEnv({
        PI_MESH_AGENT_NAME: "drainer",
        PI_MESH_PROJECT: "product",
        PI_MESH_PI_COMMAND: command,
        PI_MESH_WORKER_MAX_RESTARTS: "0",
        PI_MESH_WORKER_CONTINUE: "false",
        PI_MESH_WORKER_DRAIN_MS: "1000",
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
    assert.match(stdout, /"event":"worker_abort_requested"/);
    assert.match(stdout, /"event":"worker_drain_confirmed"/);
    assert.match(stdout, /"toolName":"mesh_await"/);
    assert.ok(stdout.indexOf("CURRENT_ABORT_CONFIRMED") < stdout.indexOf('"event":"worker_drain_confirmed"'));
    assert.doesNotMatch(stdout, /"event":"worker_killed"/);
    assert.equal(existsSync(join(workdir, ".kxm", "state", "worker-drainer.pid")), false);
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

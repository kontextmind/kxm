import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { recoveryEnvelopePath, workerStateKey } from "../plugins/pi-mesh-comms/src/recovery.ts";

const inheritedWorkspaceKeys = [
  "PI_MESH_WORKSPACE_DIR",
  "PI_MESH_CONFIG_DIR",
  "PI_MESH_LOGS_DIR",
  "PI_MESH_ASSETS_DIR",
  "PI_MESH_STATE_DIR",
  "PI_MESH_WORKER_LOG_PATH",
  "PI_MESH_AGENT_LOG_PATH",
  "PI_MESH_WORKER_CONTINUE",
  "PI_MESH_WORKER_INITIAL_CONTINUE",
  "PI_MESH_WORKER_EXTENSION_PATHS",
  "PI_MESH_WORKER_SKILL_PATHS",
  "PI_MESH_WORKER_FALLBACK_MODELS",
  "PI_MESH_WORKER_PROVIDER_RETRY_MS",
  "PI_MESH_WORKER_TOOL_TIMEOUT_MS",
  "PI_MESH_WORKER_TOOLS",
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

function workerFile(workdir: string, project: string, name: string, kind: "structured-log" | "agent-log" | "pid" | "control" | "context" | "recovery"): string {
  const key = workerStateKey(project, name);
  if (kind === "structured-log") return join(workdir, ".kxm", "logs", `pi-mesh-worker-${key}.jsonl`);
  if (kind === "agent-log") return join(workdir, ".kxm", "logs", `pi-agent-${key}.log`);
  if (kind === "pid") return join(workdir, ".kxm", "state", `worker-${key}.pid`);
  if (kind === "control") return join(workdir, ".kxm", "state", `worker-${key}.stop`);
  if (kind === "context") return join(workdir, ".kxm", "state", `worker-context-${key}.json`);
  return recoveryEnvelopePath(join(workdir, ".kxm", "state"), name, project);
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
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
    assert.match(result.stdout, /"explicitExtensionCount":0/);
    assert.match(result.stdout, /"explicitSkillCount":0/);
    const defaultToolTimeout = Number(result.stdout.match(/"toolTimeoutMs":(\d+)/)?.[1]);
    assert.equal(defaultToolTimeout, 1_860_000);
    assert.ok(defaultToolTimeout > 1_800_000, "supervisor timeout must exceed the maximum local mesh wait");
    const structuredLog = workerFile(workdir, "product", "coordinator", "structured-log");
    const agentLog = workerFile(workdir, "product", "coordinator", "agent-log");
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

test("worker ownership rejects exact duplicates while isolating projects and sanitized-name collisions", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-identity-"));
  const fixture = join(workdir, "rpc.cjs");
  const command = join(workdir, process.platform === "win32" ? "rpc.cmd" : "rpc.sh");
  writeFileSync(fixture, [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (value) => { input += value; let newline; while ((newline = input.indexOf('\\n')) >= 0) { const line = input.slice(0, newline); input = input.slice(newline + 1); const request = JSON.parse(line); if (request.type === 'abort') process.stdout.write(JSON.stringify({ id: request.id, type: 'response', command: 'abort', success: true }) + '\\n'); } });",
    "process.stdin.on('end', () => process.exit(0));",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  writeFileSync(command, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${fixture}"\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fixture}"\n`);
  if (process.platform !== "win32") chmodSync(command, 0o700);
  const children: Array<ReturnType<typeof spawn>> = [];
  const launch = (project: string, name: string) => {
    const child = spawn(process.execPath, ["scripts/pi-mesh-worker.mjs"], {
      cwd: process.cwd(),
      env: isolatedWorkerEnv({
        PI_MESH_AGENT_NAME: name,
        PI_MESH_PROJECT: project,
        PI_MESH_PI_COMMAND: command,
        PI_MESH_WORKER_CONTINUE: "false",
        PI_MESH_WORKER_DRAIN_MS: "1000",
        PI_MESH_WORKER_MAX_RESTARTS: "0",
        PI_MESH_WORKDIR: workdir,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    return child;
  };
  try {
    const first = launch("project-a", "review/agent");
    await waitForFile(workerFile(workdir, "project-a", "review/agent", "pid"));

    const duplicate = launch("project-a", "review/agent");
    let duplicateError = "";
    duplicate.stderr!.setEncoding("utf8").on("data", (chunk: string) => { duplicateError += chunk; });
    const duplicateCode = await new Promise<number | null>((resolveExit) => duplicate.once("exit", resolveExit));
    assert.notEqual(duplicateCode, 0);
    assert.match(duplicateError, /already managed by PID/);

    const crossProject = launch("project-b", "review/agent");
    const sanitizedCollision = launch("project-a", "review?agent");
    await Promise.all([
      waitForFile(workerFile(workdir, "project-b", "review/agent", "pid")),
      waitForFile(workerFile(workdir, "project-a", "review?agent", "pid")),
    ]);
    assert.notEqual(workerStateKey("project-a", "review/agent"), workerStateKey("project-b", "review/agent"));
    assert.notEqual(workerStateKey("project-a", "review/agent"), workerStateKey("project-a", "review?agent"));

    const firstRecord = JSON.parse(readFileSync(workerFile(workdir, "project-a", "review/agent", "pid"), "utf8")) as { startedAt: string; generation: string };
    writeFileSync(workerFile(workdir, "project-a", "review/agent", "control"), JSON.stringify({
      startedAt: firstRecord.startedAt,
      generation: "wrong-generation",
    }));
    await new Promise((resolveWait) => setTimeout(resolveWait, 350));
    assert.equal(first.exitCode, null);
    assert.equal(existsSync(workerFile(workdir, "project-a", "review/agent", "pid")), true);

    for (const [project, name] of [["project-a", "review/agent"], ["project-b", "review/agent"], ["project-a", "review?agent"]] as const) {
      const record = JSON.parse(readFileSync(workerFile(workdir, project, name, "pid"), "utf8")) as { startedAt: string; generation: string };
      writeFileSync(workerFile(workdir, project, name, "control"), JSON.stringify({ startedAt: record.startedAt, generation: record.generation }));
    }
    await Promise.all([first, crossProject, sanitizedCollision].map((child) => child.exitCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()))));
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("worker refuses stale claims and never deletes a replacement generation during cleanup", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-generation-"));
  const stateDir = join(workdir, ".kxm", "state");
  mkdirSync(stateDir, { recursive: true });
  const stalePath = workerFile(workdir, "product", "stale-agent", "pid");
  const stale = `${JSON.stringify({ version: 1, pid: 2_147_483_647, role: "worker", startedAt: "2000-01-01T00:00:00.000Z" })}\n`;
  writeFileSync(stalePath, stale);
  try {
    const rejected = await runWorker({
      PI_MESH_AGENT_NAME: "stale-agent",
      PI_MESH_PROJECT: "product",
      PI_MESH_PI_COMMAND: process.execPath,
      PI_MESH_WORKDIR: workdir,
    });
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /PID claim is stale/);
    assert.equal(readFileSync(stalePath, "utf8"), stale);

    const fixture = join(workdir, "exit.cjs");
    const command = join(workdir, process.platform === "win32" ? "exit.cmd" : "exit.sh");
    writeFileSync(fixture, "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setInterval(() => {}, 1000);\n");
    writeFileSync(command, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}"\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fixture}"\n`);
    if (process.platform !== "win32") chmodSync(command, 0o700);
    const ownedPath = workerFile(workdir, "product", "owned-agent", "pid");
    const child = spawn(process.execPath, ["scripts/pi-mesh-worker.mjs"], {
      cwd: process.cwd(),
      env: isolatedWorkerEnv({
        PI_MESH_AGENT_NAME: "owned-agent",
        PI_MESH_PROJECT: "product",
        PI_MESH_PI_COMMAND: command,
        PI_MESH_WORKER_DRAIN_MS: "1000",
        PI_MESH_WORKDIR: workdir,
      }),
      stdio: "ignore",
    });
    await waitForFile(ownedPath);
    const original = JSON.parse(readFileSync(ownedPath, "utf8"));
    const replacement = { ...original, generation: "replacement-generation" };
    writeFileSync(ownedPath, `${JSON.stringify(replacement)}\n`);
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    child.kill("SIGTERM");
    await exited;
    assert.equal(readFileSync(ownedPath, "utf8"), `${JSON.stringify(replacement)}\n`);
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
    const logPath = workerFile(workdir, "product", "missing-pi", "structured-log");
    assert.match(readFileSync(logPath, "utf8"), /ENOENT/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker pins an explicit worktree extension and skill", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-explicit-"));
  const fixture = join(workdir, "capture-arguments.cjs");
  const receivedArguments = join(workdir, "received-arguments.json");
  const command = join(workdir, process.platform === "win32" ? "capture.cmd" : "capture.sh");
  const extensionPath = join("local package", "extension.ts");
  const providerExtensionPath = join("provider & (auth)", "extension.ts");
  const skillPath = join("local package", "skills", "mesh skill");
  try {
    mkdirSync(resolve(workdir, skillPath), { recursive: true });
    writeFileSync(resolve(workdir, skillPath, "SKILL.md"), "---\nname: mesh-skill\ndescription: Test fixture\n---\n");
    mkdirSync(resolve(workdir, extensionPath, ".."), { recursive: true });
    mkdirSync(resolve(workdir, providerExtensionPath, ".."), { recursive: true });
    writeFileSync(resolve(workdir, extensionPath), "export default function extension() {}\n");
    writeFileSync(resolve(workdir, providerExtensionPath), "export default function provider() {}\n");
    writeFileSync(fixture, [
      `require('node:fs').writeFileSync(${JSON.stringify(receivedArguments)}, JSON.stringify(process.argv.slice(2)));`,
      "process.exit(7);",
      "",
    ].join("\n"));
    writeFileSync(command, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    if (process.platform !== "win32") chmodSync(command, 0o700);
    const result = await runWorker({
      PI_MESH_AGENT_NAME: "coordinator",
      PI_MESH_PROJECT: "product",
      PI_MESH_PI_COMMAND: command,
      PI_MESH_WORKER_CONTINUE: "false",
      PI_MESH_WORKER_MODEL: "vendor/model:latest",
      PI_MESH_WORKER_TOOLS: "read,grep,read,mesh_fanout",
      PI_MESH_WORKER_EXTENSION_PATHS: [extensionPath, providerExtensionPath].join(delimiter),
      PI_MESH_WORKER_SKILL_PATHS: skillPath,
      PI_MESH_WORKER_MAX_RESTARTS: "0",
      PI_MESH_WORKDIR: workdir,
    });
    assert.equal(result.code, 7, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /"explicitExtensionCount":2/);
    assert.match(result.stdout, /"explicitSkillCount":1/);
    assert.deepEqual(JSON.parse(readFileSync(receivedArguments, "utf8")), [
      "--mode",
      "rpc",
      "--name",
      "coordinator",
      "--model",
      "vendor/model:latest",
      "--tools",
      "read,grep,mesh_fanout",
      "--no-extensions",
      "--extension",
      resolve(workdir, extensionPath),
      "--extension",
      resolve(workdir, providerExtensionPath),
      "--no-skills",
      "--skill",
      resolve(workdir, skillPath),
    ]);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker revalidates exact resources before every restart", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-revalidate-"));
  const skillPath = join(workdir, "reviewed-skill");
  const fixture = join(workdir, "remove-skill.cjs");
  const invocationCount = join(workdir, "invocation-count.txt");
  const command = join(workdir, process.platform === "win32" ? "remove-skill.cmd" : "remove-skill.sh");
  try {
    mkdirSync(skillPath);
    writeFileSync(join(skillPath, "SKILL.md"), "---\nname: reviewed-skill\ndescription: Test fixture\n---\n");
    writeFileSync(fixture, [
      "const fs = require('node:fs');",
      `const countFile = ${JSON.stringify(invocationCount)};`,
      "const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) + 1 : 1;",
      "fs.writeFileSync(countFile, String(count));",
      `if (count === 1) fs.rmSync(${JSON.stringify(skillPath)}, { recursive: true, force: true });`,
      "process.exit(7);",
      "",
    ].join("\n"));
    writeFileSync(command, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    if (process.platform !== "win32") chmodSync(command, 0o700);
    const result = await runWorker({
      PI_MESH_AGENT_NAME: "coordinator",
      PI_MESH_PROJECT: "product",
      PI_MESH_PI_COMMAND: command,
      PI_MESH_WORKER_CONTINUE: "false",
      PI_MESH_WORKER_SKILL_PATHS: skillPath,
      PI_MESH_WORKER_MAX_RESTARTS: "1",
      PI_MESH_WORKDIR: workdir,
    });
    assert.notEqual(result.code, 0);
    assert.equal(readFileSync(invocationCount, "utf8"), "1");
    assert.match(result.stdout, /"event":"worker_restart_scheduled"/);
    assert.match(result.stdout, /"event":"worker_resource_validation_failed"/);
    assert.match(result.stderr, /WORKER_SKILL_PATHS path does not exist/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker rotates to a configured fallback after a settled provider error", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-provider-fallback-"));
  const fixture = join(workdir, "provider-failure.cjs");
  const invocations = join(workdir, "models.jsonl");
  const command = join(workdir, process.platform === "win32" ? "provider-failure.cmd" : "provider-failure.sh");
  try {
    writeFileSync(fixture, [
      "const fs = require('node:fs');",
      `const output = ${JSON.stringify(invocations)};`,
      "const args = process.argv.slice(2);",
      "const model = args[args.indexOf('--model') + 1];",
      "fs.appendFileSync(output, JSON.stringify({ model, continued: args.includes('--continue') }) + '\\n');",
      "if (model !== 'vendor/primary') process.exit(7);",
      "const failure = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Quota reached. Secret provider body must not reach structured logs.' };",
      "process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [failure], willRetry: false }) + '\\n');",
      "process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
      "process.stdin.resume();",
      "process.stdin.on('end', () => process.exit(0));",
      "",
    ].join("\n"));
    writeFileSync(command, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    if (process.platform !== "win32") chmodSync(command, 0o700);
    const result = await runWorker({
      PI_MESH_AGENT_NAME: "coordinator",
      PI_MESH_PROJECT: "product",
      PI_MESH_PI_COMMAND: command,
      PI_MESH_WORKER_CONTINUE: "true",
      PI_MESH_WORKER_INITIAL_CONTINUE: "false",
      PI_MESH_WORKER_MODEL: "vendor/primary",
      PI_MESH_WORKER_FALLBACK_MODELS: "vendor/fallback,vendor/fallback",
      PI_MESH_WORKER_MAX_RESTARTS: "1",
      PI_MESH_WORKDIR: workdir,
    });
    assert.equal(result.code, 7, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /"event":"worker_provider_failure"/);
    assert.match(result.stdout, /"failureClass":"quota"/);
    assert.match(result.stdout, /"fallbackSelected":true/);
    assert.match(result.stdout, /"event":"worker_provider_restart_scheduled"/);
    assert.doesNotMatch(result.stdout, /Secret provider body/);
    assert.doesNotMatch(result.stderr, /Secret provider body/);
    const structuredLog = readFileSync(workerFile(workdir, "product", "coordinator", "structured-log"), "utf8");
    assert.doesNotMatch(structuredLog, /Secret provider body/);
    assert.match(readFileSync(workerFile(workdir, "product", "coordinator", "agent-log"), "utf8"), /Secret provider body/);
    assert.deepEqual(
      readFileSync(invocations, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
      [
        { model: "vendor/primary", continued: false },
        { model: "vendor/fallback", continued: true },
      ],
    );
    const envelope = JSON.parse(readFileSync(workerFile(workdir, "product", "coordinator", "recovery"), "utf8"));
    assert.equal(envelope.reason, "provider_error");
    assert.equal(envelope.failureClass, "quota");
    assert.doesNotMatch(JSON.stringify(envelope), /Secret provider body/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker waits for Pi retries to settle before rotating models", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-provider-retry-order-"));
  const fixture = join(workdir, "provider-retry-order.cjs");
  const command = join(workdir, process.platform === "win32" ? "provider-retry-order.cmd" : "provider-retry-order.sh");
  try {
    writeFileSync(fixture, [
      "const failure = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Quota reached. RETRY_ORDER_SECRET.' };",
      "const success = { role: 'assistant', content: [{ type: 'text', text: 'recovered' }], stopReason: 'stop' };",
      "process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [failure], willRetry: true }) + '\\n');",
      "process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [failure, success], willRetry: false }) + '\\n');",
      "process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
      "setTimeout(() => process.exit(7), 50);",
      "",
    ].join("\n"));
    writeFileSync(command, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    if (process.platform !== "win32") chmodSync(command, 0o700);
    const result = await runWorker({
      PI_MESH_AGENT_NAME: "coordinator",
      PI_MESH_PROJECT: "product",
      PI_MESH_PI_COMMAND: command,
      PI_MESH_WORKER_MODEL: "vendor/primary",
      PI_MESH_WORKER_FALLBACK_MODELS: "vendor/fallback",
      PI_MESH_WORKER_MAX_RESTARTS: "0",
      PI_MESH_WORKDIR: workdir,
    });
    assert.equal(result.code, 7, `${result.stderr}\n${result.stdout}`);
    assert.doesNotMatch(result.stdout, /worker_provider_failure|worker_provider_restart/);
    assert.doesNotMatch(result.stdout, /RETRY_ORDER_SECRET/);
    assert.match(readFileSync(workerFile(workdir, "product", "coordinator", "agent-log"), "utf8"), /RETRY_ORDER_SECRET/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker recovers the final provider failure from an oversized bounded frame", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-provider-large-frame-"));
  const fixture = join(workdir, "provider-large-frame.cjs");
  const command = join(workdir, process.platform === "win32" ? "provider-large-frame.cmd" : "provider-large-frame.sh");
  try {
    writeFileSync(fixture, [
      "const toolUse = { role: 'assistant', content: [{ type: 'toolCall', id: 'earlier-tool' }], stopReason: 'toolUse' };",
      "const stopped = { role: 'assistant', content: [{ type: 'text', text: 'earlier success' }], stopReason: 'stop' };",
      "const history = { role: 'user', content: 'LARGE_PROVIDER_HISTORY_' + 'x'.repeat(8_500_000) };",
      "const failure = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Quota reached. LARGE_PROVIDER_SECRET.' };",
      "process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [toolUse, stopped, history, failure], willRetry: false }) + '\\n');",
      "process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
      "process.stdin.resume();",
      "process.stdin.on('end', () => process.exit(0));",
      "",
    ].join("\n"));
    writeFileSync(command, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    if (process.platform !== "win32") chmodSync(command, 0o700);
    const result = await runWorker({
      PI_MESH_AGENT_NAME: "coordinator",
      PI_MESH_PROJECT: "product",
      PI_MESH_PI_COMMAND: command,
      PI_MESH_WORKER_MODEL: "vendor/primary",
      PI_MESH_WORKER_MAX_RESTARTS: "0",
      PI_MESH_WORKDIR: workdir,
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /"event":"worker_rpc_frame_oversized".*"storedPrefixChars":4194304.*"storedTailChars":65536.*"eventType":"agent_end".*"metadataRecovered":true/);
    assert.match(result.stdout, /"event":"worker_provider_failure"/);
    assert.match(result.stdout, /"failureClass":"quota"/);
    assert.doesNotMatch(result.stdout, /LARGE_PROVIDER_(?:HISTORY|SECRET)/);
    assert.doesNotMatch(result.stderr, /LARGE_PROVIDER_(?:HISTORY|SECRET)/);
    assert.match(readFileSync(workerFile(workdir, "product", "coordinator", "agent-log"), "utf8"), /LARGE_PROVIDER_SECRET/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker bounds and isolates an oversized malformed frame without a newline", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-malformed-frame-"));
  const fixture = join(workdir, "malformed-frame.cjs");
  const command = join(workdir, process.platform === "win32" ? "malformed-frame.cmd" : "malformed-frame.sh");
  try {
    writeFileSync(fixture, [
      "const frame = 'MALFORMED_RPC_SECRET_' + 'x'.repeat(8_500_000);",
      "process.stdout.end(frame);",
      "",
    ].join("\n"));
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
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /"event":"worker_rpc_frame_oversized".*"storedPrefixChars":4194304.*"storedTailChars":65536.*"eventType":"unknown".*"metadataRecovered":false/);
    assert.doesNotMatch(result.stdout, /MALFORMED_RPC_SECRET/);
    assert.doesNotMatch(result.stderr, /MALFORMED_RPC_SECRET/);
    const structuredLog = readFileSync(workerFile(workdir, "product", "coordinator", "structured-log"), "utf8");
    assert.doesNotMatch(structuredLog, /MALFORMED_RPC_SECRET/);
    assert.match(readFileSync(workerFile(workdir, "product", "coordinator", "agent-log"), "utf8"), /MALFORMED_RPC_SECRET/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker retries a settled unresumable continuation fresh without rotating models", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-settled-unresumable-"));
  const fixture = join(workdir, "settled-unresumable.cjs");
  const invocations = join(workdir, "invocations.jsonl");
  const command = join(workdir, process.platform === "win32" ? "settled-unresumable.cmd" : "settled-unresumable.sh");
  try {
    writeFileSync(fixture, [
      "const fs = require('node:fs');",
      `const output = ${JSON.stringify(invocations)};`,
      "const args = process.argv.slice(2);",
      "const model = args[args.indexOf('--model') + 1];",
      "const continued = args.includes('--continue');",
      "fs.appendFileSync(output, JSON.stringify({ model, continued }) + '\\n');",
      "if (!continued) process.exit(7);",
      "const failure = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'invalid_request_error: missing_tool_result for tool_use id' };",
      "process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [failure], willRetry: false }) + '\\n');",
      "process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
      "process.stdin.resume();",
      "process.stdin.on('end', () => process.exit(0));",
      "",
    ].join("\n"));
    writeFileSync(command, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    if (process.platform !== "win32") chmodSync(command, 0o700);
    const result = await runWorker({
      PI_MESH_AGENT_NAME: "coordinator",
      PI_MESH_PROJECT: "product",
      PI_MESH_PI_COMMAND: command,
      PI_MESH_WORKER_CONTINUE: "true",
      PI_MESH_WORKER_MODEL: "vendor/primary",
      PI_MESH_WORKER_FALLBACK_MODELS: "vendor/fallback",
      PI_MESH_WORKER_MAX_RESTARTS: "0",
      PI_MESH_WORKDIR: workdir,
    });
    assert.equal(result.code, 7, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /"event":"worker_continue_fallback".*"settledError":true/);
    assert.doesNotMatch(result.stdout, /worker_provider_failure|vendor\/fallback/);
    assert.deepEqual(
      readFileSync(invocations, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
      [
        { model: "vendor/primary", continued: true },
        { model: "vendor/primary", continued: false },
      ],
    );
    const envelope = JSON.parse(readFileSync(workerFile(workdir, "product", "coordinator", "recovery"), "utf8"));
    assert.equal(envelope.reason, "unresumable_session");
    assert.equal(envelope.freshSession, true);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker exhausts ordered fallbacks without cycling and uses the bounded provider delay", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-fallback-exhaustion-"));
  const fixture = join(workdir, "fallback-exhaustion.cjs");
  const invocations = join(workdir, "models.jsonl");
  const command = join(workdir, process.platform === "win32" ? "fallback-exhaustion.cmd" : "fallback-exhaustion.sh");
  try {
    writeFileSync(fixture, [
      "const fs = require('node:fs');",
      `const output = ${JSON.stringify(invocations)};`,
      "const args = process.argv.slice(2);",
      "const model = args[args.indexOf('--model') + 1];",
      "fs.appendFileSync(output, JSON.stringify({ model }) + '\\n');",
      "const failure = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'provider unavailable' };",
      "process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [failure], willRetry: false }) + '\\n');",
      "process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
      "process.stdin.resume();",
      "process.stdin.on('end', () => process.exit(0));",
      "",
    ].join("\n"));
    writeFileSync(command, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    if (process.platform !== "win32") chmodSync(command, 0o700);
    const result = await runWorker({
      PI_MESH_AGENT_NAME: "coordinator",
      PI_MESH_PROJECT: "product",
      PI_MESH_PI_COMMAND: command,
      PI_MESH_WORKER_MODEL: "vendor/primary",
      PI_MESH_WORKER_FALLBACK_MODELS: "vendor/fallback-one,vendor/fallback-two",
      PI_MESH_WORKER_PROVIDER_RETRY_MS: "1500",
      PI_MESH_WORKER_MAX_RESTARTS: "3",
      PI_MESH_WORKDIR: workdir,
    });
    assert.notEqual(result.code, 0);
    assert.deepEqual(
      readFileSync(invocations, "utf8").trim().split("\n").map((line) => JSON.parse(line).model),
      ["vendor/primary", "vendor/fallback-one", "vendor/fallback-two", "vendor/fallback-two"],
    );
    assert.match(result.stdout, /"event":"worker_provider_restart_scheduled".*"delayMs":1500.*"fallbackSelected":false/);
    assert.match(result.stdout, /"event":"worker_restart_limit_reached".*"reason":"provider_error"/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker restarts a timed-out tool and records only bounded metadata", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-tool-timeout-"));
  const fixture = join(workdir, "hung-tool.cjs");
  const command = join(workdir, process.platform === "win32" ? "hung-tool.cmd" : "hung-tool.sh");
  try {
    writeFileSync(fixture, [
      "process.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'tool-secret-sentinel', toolName: 'bash' }) + '\\n');",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    writeFileSync(command, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    if (process.platform !== "win32") chmodSync(command, 0o700);
    const result = await runWorker({
      PI_MESH_AGENT_NAME: "coordinator",
      PI_MESH_PROJECT: "product",
      PI_MESH_PI_COMMAND: command,
      PI_MESH_WORKER_CONTINUE: "true",
      PI_MESH_WORKER_MODEL: "vendor/primary",
      PI_MESH_WORKER_TOOL_TIMEOUT_MS: "1000",
      PI_MESH_WORKER_DRAIN_MS: "1000",
      PI_MESH_WORKER_MAX_RESTARTS: "0",
      PI_MESH_WORKDIR: workdir,
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /"event":"worker_tool_timeout"/);
    assert.match(result.stdout, /"failureClass":"timeout"/);
    assert.match(result.stdout, /"toolName":"bash"/);
    assert.match(result.stdout, /"event":"worker_tool_restart_killed"/);
    assert.match(result.stdout, /"event":"worker_restart_limit_reached"/);
    const structuredLog = readFileSync(workerFile(workdir, "product", "coordinator", "structured-log"), "utf8");
    assert.doesNotMatch(structuredLog, /tool-secret-sentinel/);
    const envelope = JSON.parse(readFileSync(workerFile(workdir, "product", "coordinator", "recovery"), "utf8"));
    assert.equal(envelope.reason, "tool_timeout");
    assert.equal(envelope.failureClass, "timeout");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker bounds an oversized tool frame and still cancels its watchdog", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-tool-complete-"));
  const fixture = join(workdir, "completed-tool.cjs");
  const command = join(workdir, process.platform === "win32" ? "completed-tool.cmd" : "completed-tool.sh");
  try {
    writeFileSync(fixture, [
      "process.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash' }) + '\\n');",
      "const result = { content: [{ type: 'text', text: 'LARGE_TOOL_RESULT_' + 'x'.repeat(5_100_000) }] };",
      "process.stdout.write(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'bash', result, isError: false }) + '\\n');",
      "setTimeout(() => process.exit(7), 1200);",
      "",
    ].join("\n"));
    writeFileSync(command, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    if (process.platform !== "win32") chmodSync(command, 0o700);
    const result = await runWorker({
      PI_MESH_AGENT_NAME: "coordinator",
      PI_MESH_PROJECT: "product",
      PI_MESH_PI_COMMAND: command,
      PI_MESH_WORKER_TOOL_TIMEOUT_MS: "1000",
      PI_MESH_WORKER_MAX_RESTARTS: "0",
      PI_MESH_WORKDIR: workdir,
    });
    assert.equal(result.code, 7);
    assert.doesNotMatch(result.stdout, /worker_tool_timeout|worker_tool_restart/);
    assert.match(result.stdout, /"event":"worker_rpc_frame_oversized".*"metadataRecovered":true/);
    assert.doesNotMatch(result.stdout, /LARGE_TOOL_RESULT/);
    assert.match(readFileSync(workerFile(workdir, "product", "coordinator", "agent-log"), "utf8"), /LARGE_TOOL_RESULT/);
    assert.equal(existsSync(workerFile(workdir, "product", "coordinator", "recovery")), false);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker rejects invalid explicit resource paths before supervision", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "pi-mesh-worker-invalid-resource-"));
  const extensionDirectory = join(workdir, "not-an-extension-file");
  try {
    mkdirSync(extensionDirectory);
    const missing = await runWorker({
      PI_MESH_AGENT_NAME: "coordinator",
      PI_MESH_PROJECT: "product",
      PI_MESH_WORKER_EXTENSION_PATHS: join(workdir, "missing.ts"),
      PI_MESH_WORKER_MAX_RESTARTS: "0",
      PI_MESH_WORKDIR: workdir,
    });
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /WORKER_EXTENSION_PATHS path does not exist/);
    assert.doesNotMatch(missing.stdout, /worker_starting/);

    const missingSkill = await runWorker({
      PI_MESH_AGENT_NAME: "coordinator",
      PI_MESH_PROJECT: "product",
      PI_MESH_WORKER_SKILL_PATHS: join(workdir, "missing-skill"),
      PI_MESH_WORKER_MAX_RESTARTS: "0",
      PI_MESH_WORKDIR: workdir,
    });
    assert.notEqual(missingSkill.code, 0);
    assert.match(missingSkill.stderr, /WORKER_SKILL_PATHS path does not exist/);
    assert.doesNotMatch(missingSkill.stdout, /worker_starting/);

    const wrongType = await runWorker({
      PI_MESH_AGENT_NAME: "coordinator",
      PI_MESH_PROJECT: "product",
      PI_MESH_WORKER_EXTENSION_PATHS: extensionDirectory,
      PI_MESH_WORKER_MAX_RESTARTS: "0",
      PI_MESH_WORKDIR: workdir,
    });
    assert.notEqual(wrongType.code, 0);
    assert.match(wrongType.stderr, /path must be an extension file/);
    assert.doesNotMatch(wrongType.stdout, /worker_starting/);
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
    const envelope = JSON.parse(readFileSync(workerFile(workdir, "product", "coordinator", "recovery"), "utf8")) as {
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
    assert.equal(existsSync(workerFile(workdir, "product", "coordinator", "recovery")), false);
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
    assert.doesNotMatch(stdout, /"toolName":"mesh_await"/);
    assert.doesNotMatch(stdout, /CURRENT_ABORT_CONFIRMED/);
    const agentLog = readFileSync(workerFile(workdir, "product", "drainer", "agent-log"), "utf8");
    assert.match(agentLog, /"toolName":"mesh_await"/);
    assert.match(agentLog, /CURRENT_ABORT_CONFIRMED/);
    assert.doesNotMatch(stdout, /"event":"worker_killed"/);
    assert.equal(existsSync(workerFile(workdir, "product", "drainer", "pid")), false);
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

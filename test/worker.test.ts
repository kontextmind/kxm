import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { recoveryEnvelopePath, workerStateKey } from "../plugins/kxm/src/recovery.ts";
import { createTestMesh, waitFor } from "./helpers.ts";

const inheritedWorkspaceKeys = [
  "KXM_WORKSPACE_DIR",
  "KXM_CONFIG_DIR",
  "KXM_LOGS_DIR",
  "KXM_ASSETS_DIR",
  "KXM_STATE_DIR",
  "KXM_WORKER_LOG_PATH",
  "KXM_AGENT_LOG_PATH",
  "KXM_WORKER_CONTINUE",
  "KXM_WORKER_INITIAL_CONTINUE",
  "KXM_WORKER_EXTENSION_PATHS",
  "KXM_WORKER_SKILL_PATHS",
  "KXM_WORKER_FALLBACK_MODELS",
  "KXM_WORKER_PROVIDER_RETRY_MS",
  "KXM_WORKER_TOOL_TIMEOUT_MS",
  "KXM_WORKER_TOOLS",
  "KXM_WORKER_SESSION_ISOLATION",
  "KXM_WORKER_CHILD_INCARCATION",
  "KXM_WORKER_MAX_RUN_SESSIONS",
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
    const child = spawn(process.execPath, ["scripts/kxm-worker.mjs"], {
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

function workerFile(workdir: string, project: string, name: string, kind: "structured-log" | "agent-log" | "pid" | "control" | "context" | "recovery" | "session-binding" | "session-request"): string {
  const key = workerStateKey(project, name);
  if (kind === "structured-log") return join(workdir, ".kxm", "logs", `kxm-worker-${key}.jsonl`);
  if (kind === "agent-log") return join(workdir, ".kxm", "logs", `pi-agent-${key}.log`);
  if (kind === "pid") return join(workdir, ".kxm", "state", `worker-${key}.pid`);
  if (kind === "control") return join(workdir, ".kxm", "state", `worker-${key}.stop`);
  if (kind === "context") return join(workdir, ".kxm", "state", `worker-context-${key}.json`);
  if (kind === "session-binding") return join(workdir, ".kxm", "state", `worker-session-binding-${key}.json`);
  if (kind === "session-request") return join(workdir, ".kxm", "state", `worker-session-request-${key}.json`);
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
  const result = await runWorker({ ...process.env, KXM_AGENT_NAME: "", KXM_PROJECT: "" });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /AGENT_NAME and KXM_PROJECT are required/);
});

test("long-lived worker supervises Pi and honors the restart limit", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-"));
  try {
    const result = await runWorker({
      ...process.env,
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: process.execPath,
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
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

test("workflow isolation serially swaps one child across bounded run-specific Pi sessions", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-session-route-"));
  const fixture = join(workdir, "route-session.cjs");
  const invocations = join(workdir, "invocations.jsonl");
  const command = join(workdir, process.platform === "win32" ? "route-session.cmd" : "route-session.sh");
  const runId = `run_${"a".repeat(32)}`;
  const secondRunId = `run_${"c".repeat(32)}`;
  const messageId = `msg_${"b".repeat(32)}`;
  const secondMessageId = `msg_${"d".repeat(32)}`;
  try {
    writeFileSync(fixture, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const output = ${JSON.stringify(invocations)};`,
      "const args = process.argv.slice(2);",
      "const scope = process.env.KXM_WORKER_SESSION_SCOPE;",
      "fs.appendFileSync(output, JSON.stringify({ scope, args, generation: process.env.KXM_WORKER_GENERATION, childIncarnation: Number(process.env.KXM_WORKER_CHILD_INCARCATION) }) + '\\n');",
      "function route(from, toRunId, messageId) {",
      `  const requestPath = path.join(process.env.KXM_STATE_DIR, 'worker-session-request-' + process.env.KXM_WORKER_IDENTITY_KEY + '.json');`,
      "  const request = { version: 1, agentName: 'coordinator', project: 'product', workerKey: process.env.KXM_WORKER_IDENTITY_KEY, generation: process.env.KXM_WORKER_GENERATION, childIncarnation: Number(process.env.KXM_WORKER_CHILD_INCARCATION), from, to: { kind: 'workflow', runId: toRunId }, sourceSessionId: '11111111-1111-4111-8111-111111111111', messageId, createdAt: new Date().toISOString() };",
      "  fs.writeFileSync(requestPath + '.tmp', JSON.stringify(request) + '\\n');",
      "  fs.renameSync(requestPath + '.tmp', requestPath);",
      "}",
      `if (scope === 'default') { const target = path.join(process.env.KXM_STATE_DIR, 'pi-sessions', process.env.KXM_WORKER_IDENTITY_KEY, 'runs', ${JSON.stringify(runId)}); fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'history.jsonl'), '{}\\n'); route({ kind: 'default' }, ${JSON.stringify(runId)}, ${JSON.stringify(messageId)}); process.exit(0); }`,
      `if (scope === ${JSON.stringify(`workflow:${runId}`)}) { route({ kind: 'workflow', runId: ${JSON.stringify(runId)} }, ${JSON.stringify(secondRunId)}, ${JSON.stringify(secondMessageId)}); process.exit(0); }`,
      "process.exit(7);",
      "",
    ].join("\n"));
    writeFileSync(command, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    if (process.platform !== "win32") chmodSync(command, 0o700);
    const result = await runWorker({
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: command,
      KXM_WORKER_SESSION_ISOLATION: "workflow",
      KXM_WORKER_MAX_RUN_SESSIONS: "1",
      KXM_WORKER_INITIAL_CONTINUE: "false",
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
    });
    assert.equal(result.code, 7, `${result.stderr}\n${result.stdout}`);
    const calls = readFileSync(invocations, "utf8").trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      scope: string;
      args: string[];
      generation: string;
      childIncarnation: number;
    }>;
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((call) => call.scope), ["default", `workflow:${runId}`, `workflow:${secondRunId}`]);
    assert.ok(calls.every((call) => call.generation === calls[0]!.generation));
    assert.deepEqual(calls.map((call) => call.childIncarnation), [1, 2, 3]);
    assert.ok(calls[0]!.args.includes("coordinator@default"));
    assert.ok(calls[1]!.args.includes("coordinator@aaaaaaaa"));
    assert.ok(calls[2]!.args.includes("coordinator@cccccccc"));
    assert.equal(calls[0]!.args.includes("--continue"), false);
    assert.equal(calls[1]!.args.includes("--continue"), true, "only the target binding with history should resume");
    assert.equal(calls[2]!.args.includes("--continue"), false);
    const firstSessionDir = calls[0]!.args[calls[0]!.args.indexOf("--session-dir") + 1]!;
    const firstRunSessionDir = calls[1]!.args[calls[1]!.args.indexOf("--session-dir") + 1]!;
    const secondRunSessionDir = calls[2]!.args[calls[2]!.args.indexOf("--session-dir") + 1]!;
    assert.match(firstSessionDir, /[\\/]default$/);
    assert.equal(firstRunSessionDir, join(workdir, ".kxm", "state", "pi-sessions", workerStateKey("product", "coordinator"), "runs", runId));
    assert.equal(secondRunSessionDir, join(workdir, ".kxm", "state", "pi-sessions", workerStateKey("product", "coordinator"), "runs", secondRunId));
    assert.equal(existsSync(firstSessionDir), true);
    assert.equal(existsSync(firstRunSessionDir), false, "least-recently-used run session should be evicted at the configured bound");
    assert.equal(existsSync(secondRunSessionDir), true);
    const manifest = JSON.parse(readFileSync(workerFile(workdir, "product", "coordinator", "session-binding"), "utf8"));
    assert.deepEqual(manifest.active, { kind: "workflow", runId: secondRunId });
    assert.equal(manifest.runs[runId], undefined);
    assert.ok(manifest.runs[secondRunId]);
    assert.equal(existsSync(workerFile(workdir, "product", "coordinator", "session-request")), false);
    assert.match(result.stdout, /"event":"worker_session_routed"/);
    assert.doesNotMatch(result.stdout, /worker_restart_scheduled/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("hub, extension, and supervisor complete the real pre-ack route and destination replay chain", async (context) => {
  const secret = "integrated-session-routing-secret";
  const mesh = await createTestMesh(context, {
    webhookWorkflows: [{
      id: "integrated-session-route",
      source: "generic",
      project: "integrated-project",
      target: "integrated-worker",
      secret,
      delivery: "followUp",
      promptTemplate: "Route {{task}}",
      stages: [{ id: "work", label: "Work", instructions: "Reply from the isolated scope", requiredEvidence: [], maxAttempts: 1 }],
    }],
  });
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-integrated-route-"));
  const fixture = join(workdir, "integrated-child.mjs");
  const invocations = join(workdir, "integrated-invocations.jsonl");
  const command = join(workdir, process.platform === "win32" ? "integrated-child.cmd" : "integrated-child.sh");
  const extensionUrl = pathToFileURL(resolve("plugins/kxm/src/extension.ts")).href;
  try {
    writeFileSync(fixture, [
      "import fs from 'node:fs';",
      `import piMeshExtension from ${JSON.stringify(extensionUrl)};`,
      `const invocations = ${JSON.stringify(invocations)};`,
      "const handlers = new Map();",
      "const emit = async (name, event = {}, ctx) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };",
      "let finishing = false;",
      "const api = {",
      "  on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },",
      "  registerTool() {}, registerCommand() {},",
      "  getSessionName() { return process.env.KXM_AGENT_NAME; },",
      "  sendMessage(message) {",
      "    if (message.customType !== 'pi-mesh-inbound' || finishing) return;",
      "    finishing = true;",
      "    queueMicrotask(async () => {",
      "      await emit('message_start', { message });",
      "      await emit('agent_end', { messages: [{ role: 'assistant', content: 'integrated isolated reply' }] });",
      "      await emit('agent_settled');",
      "      setTimeout(() => process.exit(7), 25);",
      "    });",
      "  },",
      "};",
      "piMeshExtension(api);",
      "const scope = process.env.KXM_WORKER_SESSION_SCOPE;",
      "const sessionId = scope === 'default' ? '44444444-4444-4444-8444-444444444444' : '55555555-5555-4555-8555-555555555555';",
      "const ui = { setStatus() {}, notify() {} };",
      "let shuttingDown = false;",
      "const ctx = { cwd: process.cwd(), model: { provider: 'test', id: 'integrated' }, sessionManager: { getSessionId: () => sessionId }, ui, async shutdown() { if (shuttingDown) return; shuttingDown = true; await emit('session_shutdown'); process.exit(0); } };",
      "await emit('session_start', {}, ctx);",
      "fs.appendFileSync(invocations, JSON.stringify({ scope, args: process.argv.slice(2) }) + '\\n');",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    writeFileSync(command, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" --disable-warning=ExperimentalWarning --experimental-strip-types "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" --disable-warning=ExperimentalWarning --experimental-strip-types "${fixture}" "$@"\n`);
    if (process.platform !== "win32") chmodSync(command, 0o700);
    const workerResult = runWorker({
      KXM_AGENT_NAME: "integrated-worker",
      KXM_AGENT_PURPOSE: "integrated route test",
      KXM_PROJECT: "integrated-project",
      KXM_SERVER_URL: mesh.address.url,
      KXM_AUTH_TOKEN: mesh.token,
      KXM_PI_COMMAND: command,
      KXM_WORKER_SESSION_ISOLATION: "workflow",
      KXM_WORKER_INITIAL_CONTINUE: "false",
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
    });
    await waitFor(() => [...mesh.hub.state.agents.values()].some((agent) => agent.name === "integrated-worker" && agent.online), 5_000);
    const body = JSON.stringify({ task: "this workflow" });
    const response = await fetch(`${mesh.address.url}/v1/webhooks/integrated-session-route`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mesh-delivery-id": "integrated-session-route-delivery",
        "x-hub-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body,
    });
    assert.equal(response.status, 202);
    const started = await response.json() as { run: { id: string; messageId: string } };
    const result = await workerResult;
    assert.equal(result.code, 7, `${result.stderr}\n${result.stdout}`);
    assert.equal(mesh.hub.state.messages.get(started.run.messageId)?.reply?.content, "integrated isolated reply");
    const calls = readFileSync(invocations, "utf8").trim().split("\n").map((line) => JSON.parse(line)) as Array<{ scope: string; args: string[] }>;
    assert.deepEqual(calls.map((call) => call.scope), ["default", `workflow:${started.run.id}`]);
    assert.match(result.stdout, /"event":"worker_session_routed"/);
    assert.equal(existsSync(workerFile(workdir, "integrated-project", "integrated-worker", "session-request")), false);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("workflow isolation rejects a current-generation route whose source is not active", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-invalid-route-"));
  const fixture = join(workdir, "invalid-route.cjs");
  const command = join(workdir, process.platform === "win32" ? "invalid-route.cmd" : "invalid-route.sh");
  const wrongRun = `run_${"e".repeat(32)}`;
  const targetRun = `run_${"f".repeat(32)}`;
  try {
    writeFileSync(fixture, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const requestPath = path.join(process.env.KXM_STATE_DIR, 'worker-session-request-' + process.env.KXM_WORKER_IDENTITY_KEY + '.json');",
      `const request = { version: 1, agentName: 'coordinator', project: 'product', workerKey: process.env.KXM_WORKER_IDENTITY_KEY, generation: process.env.KXM_WORKER_GENERATION, childIncarnation: Number(process.env.KXM_WORKER_CHILD_INCARCATION), from: { kind: 'workflow', runId: ${JSON.stringify(wrongRun)} }, to: { kind: 'workflow', runId: ${JSON.stringify(targetRun)} }, sourceSessionId: '11111111-1111-4111-8111-111111111111', messageId: 'msg_${"1".repeat(32)}', createdAt: new Date().toISOString() };`,
      "fs.writeFileSync(requestPath, JSON.stringify(request) + '\\n');",
      "process.exit(7);",
      "",
    ].join("\n"));
    writeFileSync(command, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    if (process.platform !== "win32") chmodSync(command, 0o700);
    const result = await runWorker({
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: command,
      KXM_WORKER_SESSION_ISOLATION: "workflow",
      KXM_WORKER_INITIAL_CONTINUE: "false",
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
    });
    assert.equal(result.code, 7, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /"event":"worker_session_request_rejected"/);
    assert.match(result.stdout, /source does not match the active binding/);
    const manifest = JSON.parse(readFileSync(workerFile(workdir, "product", "coordinator", "session-binding"), "utf8"));
    assert.deepEqual(manifest.active, { kind: "default" });
    assert.equal(manifest.runs[targetRun], undefined);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("workflow isolation quarantines corrupt bindings and safely recovers the stable default session", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-corrupt-session-"));
  const fixture = join(workdir, "exit.cjs");
  const command = join(workdir, process.platform === "win32" ? "exit.cmd" : "exit.sh");
  try {
    mkdirSync(join(workdir, ".kxm", "state"), { recursive: true });
    const retainedRunId = `run_${"9".repeat(32)}`;
    const retainedRunDir = join(workdir, ".kxm", "state", "pi-sessions", workerStateKey("product", "coordinator"), "runs", retainedRunId);
    mkdirSync(retainedRunDir, { recursive: true });
    writeFileSync(join(retainedRunDir, "history.jsonl"), "{}\n");
    const manifestPath = workerFile(workdir, "product", "coordinator", "session-binding");
    writeFileSync(manifestPath, "{ definitely not valid json");
    writeFileSync(fixture, "process.exit(7);\n");
    writeFileSync(command, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    if (process.platform !== "win32") chmodSync(command, 0o700);
    const result = await runWorker({
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: command,
      KXM_WORKER_SESSION_ISOLATION: "workflow",
      KXM_WORKER_INITIAL_CONTINUE: "false",
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
    });
    assert.equal(result.code, 7, `${result.stderr}\n${result.stdout}`);
    const stateFiles = readdirSync(join(workdir, ".kxm", "state"));
    assert.ok(stateFiles.some((name) => name.startsWith(`${manifestPath.split(/[\\/]/).at(-1)}.corrupt-`)));
    const recovered = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.deepEqual(recovered.active, { kind: "default" });
    assert.ok(recovered.runs[retainedRunId], "bounded canonical histories should be retained after manifest recovery");
    assert.equal(existsSync(retainedRunDir), true);
    assert.match(result.stdout, /"event":"worker_session_state_recovered"/);
    assert.match(result.stdout, /"event":"worker_session_orphans_adopted"/);
    assert.match(result.stdout, /"sessionScope":"default"/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("workflow isolation rejects linked session roots before Pi can write an aliased history", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-linked-session-"));
  const external = mkdtempSync(join(tmpdir(), "kxm-worker-linked-target-"));
  try {
    const root = join(workdir, ".kxm", "state", "pi-sessions", workerStateKey("product", "coordinator"));
    mkdirSync(join(root, ".."), { recursive: true });
    symlinkSync(external, root, process.platform === "win32" ? "junction" : "dir");
    const result = await runWorker({
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_WORKER_SESSION_ISOLATION: "workflow",
      KXM_WORKER_INITIAL_CONTINUE: "false",
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /session root is not a safe real directory|session root must be a real directory/);
    assert.deepEqual(readdirSync(external), []);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("worker ownership rejects exact duplicates while isolating projects and sanitized-name collisions", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-identity-"));
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
    const child = spawn(process.execPath, ["scripts/kxm-worker.mjs"], {
      cwd: process.cwd(),
      env: isolatedWorkerEnv({
        KXM_AGENT_NAME: name,
        KXM_PROJECT: project,
        KXM_PI_COMMAND: command,
        KXM_WORKER_CONTINUE: "false",
        KXM_WORKER_DRAIN_MS: "1000",
        KXM_WORKER_MAX_RESTARTS: "0",
        KXM_WORKDIR: workdir,
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
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-generation-"));
  const stateDir = join(workdir, ".kxm", "state");
  mkdirSync(stateDir, { recursive: true });
  const stalePath = workerFile(workdir, "product", "stale-agent", "pid");
  const stale = `${JSON.stringify({ version: 1, pid: 2_147_483_647, role: "worker", startedAt: "2000-01-01T00:00:00.000Z" })}\n`;
  writeFileSync(stalePath, stale);
  try {
    const rejected = await runWorker({
      KXM_AGENT_NAME: "stale-agent",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: process.execPath,
      KXM_WORKDIR: workdir,
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
    const child = spawn(process.execPath, ["scripts/kxm-worker.mjs"], {
      cwd: process.cwd(),
      env: isolatedWorkerEnv({
        KXM_AGENT_NAME: "owned-agent",
        KXM_PROJECT: "product",
        KXM_PI_COMMAND: command,
        KXM_WORKER_DRAIN_MS: "1000",
        KXM_WORKDIR: workdir,
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
    rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("long-lived worker treats spawn failures as retryable nonzero exits", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-spawn-"));
  try {
    const result = await runWorker({
      ...process.env,
      KXM_AGENT_NAME: "missing-pi",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: join(workdir, "does-not-exist"),
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
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
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-explicit-"));
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
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: command,
      KXM_WORKER_CONTINUE: "false",
      KXM_WORKER_MODEL: "vendor/model:latest",
      KXM_WORKER_TOOLS: "read,grep,read,kxm_fanout",
      KXM_WORKER_EXTENSION_PATHS: [extensionPath, providerExtensionPath].join(delimiter),
      KXM_WORKER_SKILL_PATHS: skillPath,
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
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
      "read,grep,kxm_fanout",
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
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-revalidate-"));
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
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: command,
      KXM_WORKER_CONTINUE: "false",
      KXM_WORKER_SKILL_PATHS: skillPath,
      KXM_WORKER_MAX_RESTARTS: "1",
      KXM_WORKDIR: workdir,
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
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-provider-fallback-"));
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
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: command,
      KXM_WORKER_CONTINUE: "true",
      KXM_WORKER_INITIAL_CONTINUE: "false",
      KXM_WORKER_MODEL: "vendor/primary",
      KXM_WORKER_FALLBACK_MODELS: "vendor/fallback,vendor/fallback",
      KXM_WORKER_MAX_RESTARTS: "1",
      KXM_WORKDIR: workdir,
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
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-provider-retry-order-"));
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
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: command,
      KXM_WORKER_MODEL: "vendor/primary",
      KXM_WORKER_FALLBACK_MODELS: "vendor/fallback",
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
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
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-provider-large-frame-"));
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
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: command,
      KXM_WORKER_MODEL: "vendor/primary",
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
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
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-malformed-frame-"));
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
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: command,
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
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
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-settled-unresumable-"));
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
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: command,
      KXM_WORKER_CONTINUE: "true",
      KXM_WORKER_MODEL: "vendor/primary",
      KXM_WORKER_FALLBACK_MODELS: "vendor/fallback",
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
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
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-fallback-exhaustion-"));
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
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: command,
      KXM_WORKER_MODEL: "vendor/primary",
      KXM_WORKER_FALLBACK_MODELS: "vendor/fallback-one,vendor/fallback-two",
      KXM_WORKER_PROVIDER_RETRY_MS: "1500",
      KXM_WORKER_MAX_RESTARTS: "3",
      KXM_WORKDIR: workdir,
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
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-tool-timeout-"));
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
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: command,
      KXM_WORKER_CONTINUE: "true",
      KXM_WORKER_MODEL: "vendor/primary",
      KXM_WORKER_TOOL_TIMEOUT_MS: "1000",
      KXM_WORKER_DRAIN_MS: "1000",
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
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
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-tool-complete-"));
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
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: command,
      KXM_WORKER_TOOL_TIMEOUT_MS: "1000",
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
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
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-invalid-resource-"));
  const extensionDirectory = join(workdir, "not-an-extension-file");
  try {
    mkdirSync(extensionDirectory);
    const missing = await runWorker({
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_WORKER_EXTENSION_PATHS: join(workdir, "missing.ts"),
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
    });
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /WORKER_EXTENSION_PATHS path does not exist/);
    assert.doesNotMatch(missing.stdout, /worker_starting/);

    const missingSkill = await runWorker({
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_WORKER_SKILL_PATHS: join(workdir, "missing-skill"),
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
    });
    assert.notEqual(missingSkill.code, 0);
    assert.match(missingSkill.stderr, /WORKER_SKILL_PATHS path does not exist/);
    assert.doesNotMatch(missingSkill.stdout, /worker_starting/);

    const wrongType = await runWorker({
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_WORKER_EXTENSION_PATHS: extensionDirectory,
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
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
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-cmd-"));
  const commandDirectory = join(workdir, "command scripts");
  const command = join(commandDirectory, "fake pi.cmd");
  const receivedArguments = join(workdir, "received-arguments.txt");
  try {
    mkdirSync(commandDirectory, { recursive: true });
    writeFileSync(command, `@echo off\r\necho %* > "${receivedArguments}"\r\nexit /b 7\r\n`, "utf8");
    const result = await runWorker({
      ...process.env,
      KXM_AGENT_NAME: "windows coordinator &(safe)",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: command,
      KXM_WORKER_MODEL: "vendor/model:latest",
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
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
      KXM_AGENT_NAME: "unsafe%PATH%",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: command,
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
    });
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /cannot be passed safely to a Windows command script/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker falls back from an unresumable --continue start", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-fallback-"));
  const stateDir = join(workdir, ".kxm", "state");
  const fixture = join(workdir, "unresumable.cjs");
  const failure = join(workdir, process.platform === "win32" ? "unresumable.cmd" : "unresumable.sh");
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "worker-context-coordinator.json"), JSON.stringify({
      version: 1,
      agentName: "coordinator",
      project: "product",
      runId: "run_77777777777777777777777777777777",
      stageId: "implementation",
      pendingMessageIds: ["msg_88888888888888888888888888888888"],
      artifactPointers: [".kxm/assets/implementation.md"],
    }));
    writeFileSync(fixture, "process.stderr.write('invalid_request_error: missing_tool_'); setTimeout(() => { process.stderr.write('result for tool_use id'); process.exit(9); }, 10);\n");
    writeFileSync(failure, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    if (process.platform !== "win32") chmodSync(failure, 0o700);
    const result = await runWorker({
      ...process.env,
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: failure,
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
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
    assert.equal(envelope.runId, "run_77777777777777777777777777777777");
    assert.equal(envelope.stageId, "implementation");
    assert.deepEqual(envelope.pendingMessageIds, ["msg_88888888888888888888888888888888"]);
    assert.deepEqual(envelope.artifactPointers, [".kxm/assets/implementation.md"]);
    assert.doesNotMatch(JSON.stringify(envelope), /prompt|sk-|ghp_/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker does not treat unrelated auth failures as unresumable sessions", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-auth-"));
  const fixture = join(workdir, "auth-failure.cjs");
  const command = join(workdir, process.platform === "win32" ? "auth-failure.cmd" : "auth-failure.sh");
  try {
    writeFileSync(fixture, "process.stderr.write('authentication failed: please login\\n'); process.exit(9);\n");
    writeFileSync(command, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    if (process.platform !== "win32") chmodSync(command, 0o700);
    const result = await runWorker({
      KXM_AGENT_NAME: "coordinator",
      KXM_PROJECT: "product",
      KXM_PI_COMMAND: command,
      KXM_WORKER_MAX_RESTARTS: "0",
      KXM_WORKDIR: workdir,
    });
    assert.equal(result.code, 9);
    assert.doesNotMatch(result.stdout, /worker_continue_fallback/);
    assert.equal(existsSync(workerFile(workdir, "product", "coordinator", "recovery")), false);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("long-lived worker ignores stale RPC responses and confirms abort during active kxm_await", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "kxm-worker-drain-"));
  const rpc = join(workdir, "rpc.cjs");
  writeFileSync(rpc, [
    "let input = ''; let confirmed = false;",
    "process.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolName: 'kxm_await' }) + '\\n');",
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
    const child = spawn(process.execPath, ["scripts/kxm-worker.mjs"], {
      cwd: process.cwd(),
      env: isolatedWorkerEnv({
        KXM_AGENT_NAME: "drainer",
        KXM_PROJECT: "product",
        KXM_PI_COMMAND: command,
        KXM_WORKER_MAX_RESTARTS: "0",
        KXM_WORKER_CONTINUE: "false",
        KXM_WORKER_DRAIN_MS: "1000",
        KXM_WORKER_STOP_AFTER_MS: "150",
        KXM_WORKDIR: workdir,
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
    assert.doesNotMatch(stdout, /"toolName":"kxm_await"/);
    assert.doesNotMatch(stdout, /CURRENT_ABORT_CONFIRMED/);
    const agentLog = readFileSync(workerFile(workdir, "product", "drainer", "agent-log"), "utf8");
    assert.match(agentLog, /"toolName":"kxm_await"/);
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

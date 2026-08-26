#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hubScript = join(root, "scripts", "pi-mesh-hub.mjs");
const workerScript = join(root, "scripts", "pi-mesh-worker.mjs");
const extensionPath = join(root, "plugins", "pi-mesh-comms", "src", "extension.ts");
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_CHARS = 32_768;

export function parseSmokeModels(value) {
  const models = [...new Set(String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
  if (models.some((model) => !/^[A-Za-z0-9._:/-]{1,160}$/.test(model))) {
    throw new Error("PI_MESH_SMOKE_MODELS contains an invalid model ID");
  }
  return models;
}

export function boundedSafeMessage(value, secrets = []) {
  let result = value instanceof Error ? value.message : String(value);
  for (const secret of secrets) {
    if (secret) result = result.replaceAll(secret, "[REDACTED]");
  }
  result = result.replace(/(?:sk|key|token|secret)[-_A-Za-z0-9]{12,}/gi, "[REDACTED]");
  return result.slice(0, 500);
}

export async function runSmokePhases(phases, cleanup) {
  const completed = [];
  try {
    const values = {};
    for (const [name, action] of phases) {
      values[name] = await action(values);
      completed.push(name);
    }
    return { values, completed };
  } finally {
    await cleanup();
  }
}

function writeOutcome(outcome) {
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
    timeout: options.timeout ?? 15_000,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function resolvePiCommand() {
  const configured = process.env.PI_MESH_SMOKE_PI_COMMAND?.trim();
  if (configured) return configured;
  const locator = runCommand(process.platform === "win32" ? "where.exe" : "which", ["pi"]);
  if (locator.status !== 0) return undefined;
  const candidates = String(locator.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return process.platform === "win32"
    ? candidates.find((candidate) => /\.cmd$/i.test(candidate)) ?? candidates[0]
    : candidates[0];
}

function modelAuthReady(piCommand, model) {
  const checked = runCommand(piCommand, ["auth", "check", "--model", model, "--json", "--no-refresh"]);
  if (checked.status !== 0) return false;
  try {
    return JSON.parse(String(checked.stdout)).status === "ready";
  } catch {
    return false;
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a local smoke port");
  await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  return address.port;
}

function captureProcess(child, label) {
  const state = { label, stdout: "", stderr: "", exit: undefined };
  child.stdout?.on("data", (chunk) => {
    state.stdout = `${state.stdout}${chunk}`.slice(-MAX_CAPTURE_CHARS);
  });
  child.stderr?.on("data", (chunk) => {
    state.stderr = `${state.stderr}${chunk}`.slice(-MAX_CAPTURE_CHARS);
  });
  child.once("exit", (code, signal) => {
    state.exit = { code, signal };
  });
  return state;
}

function spawnNode(script, env, label) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return { child, capture: captureProcess(child, label) };
}

async function waitFor(check, timeoutMs, label, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((accept) => setTimeout(accept, intervalMs));
  }
  throw new Error(`${label} timed out${lastError ? `: ${boundedSafeMessage(lastError)}` : ""}`);
}

async function api(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.authToken}`,
      ...(options.identity ? {
        "x-mesh-agent-id": options.identity.agent.id,
        "x-mesh-agent-key": options.identity.agentKey,
      } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body === undefined ? {} : { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`hub returned invalid JSON with HTTP ${response.status}`);
    }
  }
  if (!response.ok) throw new Error(`hub HTTP ${response.status}: ${body.code ?? "request_failed"}`);
  return body;
}

async function registerOperator(baseUrl, authToken, project) {
  return await api(baseUrl, "/v1/agents/register", {
    method: "POST",
    authToken,
    body: { name: "smoke-operator", purpose: "bounded smoke assertions", project },
  });
}

async function agents(baseUrl, authToken, operator) {
  const result = await api(baseUrl, "/v1/agents", { authToken, identity: operator });
  return result.agents;
}

export function buildSmokeRequest(target, content, idempotencyKey) {
  return { target, content, delivery: "followUp", idempotencyKey };
}

async function sendAndAwait(baseUrl, authToken, operator, target, content, timeoutMs, idempotencyKey) {
  const sent = await api(baseUrl, "/v1/messages", {
    method: "POST",
    authToken,
    identity: operator,
    body: buildSmokeRequest(target, content, idempotencyKey),
  });
  return await waitFor(async () => {
    const result = await api(baseUrl, `/v1/messages/${encodeURIComponent(sent.message.id)}`, {
      authToken,
      identity: operator,
    });
    if (["cancelled", "expired", "error"].includes(result.message.status)) {
      throw new Error(`peer request ended as ${result.message.status}`);
    }
    return result.message.status === "replied" && typeof result.message.reply?.content === "string"
      && result.message.reply.content.trim() ? result.message : undefined;
  }, timeoutMs, `reply from ${target}`, 500);
}

function createPiShim(tempRoot, piCommand) {
  if (process.platform === "win32") {
    const commandShim = join(tempRoot, "pi-smoke-shim.cmd");
    const quoteBatch = (value) => `"${String(value).replaceAll('"', '""')}"`;
    writeFileSync(commandShim, [
      "@echo off",
      `call ${quoteBatch(piCommand)} --extension ${quoteBatch(extensionPath)} --approve --no-context-files --no-skills --no-prompt-templates --no-themes %*`,
      "exit /b %errorlevel%",
      "",
    ].join("\r\n"), "utf8");
    return commandShim;
  }
  const shim = join(tempRoot, "pi-smoke-shim.mjs");
  writeFileSync(shim, [
    "#!/usr/bin/env node",
    'import { spawn } from "node:child_process";',
    `const command = ${JSON.stringify(piCommand)};`,
    `const prefix = ${JSON.stringify(["--extension", extensionPath, "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes"])};`,
    "const windowsScript = process.platform === 'win32' && /\\.(?:cmd|bat)$/i.test(command);",
    "const quote = (value) => `\"${String(value).replaceAll('\\\"', '\\\"\\\"')}\"`;",
    "const executable = windowsScript ? process.env.ComSpec || 'cmd.exe' : command;",
    "const args = [...prefix, ...process.argv.slice(2)];",
    "const launchArgs = windowsScript ? ['/d', '/s', '/v:off', '/c', `\"${[command, ...args].map(quote).join(' ')}\"`] : args;",
    "const child = spawn(executable, launchArgs, { stdio: 'inherit', windowsHide: true });",
    "child.once('error', (error) => { process.stderr.write(`${error.message}\\n`); process.exit(1); });",
    "child.once('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });",
    "for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));",
  ].join("\n"), { encoding: "utf8", mode: 0o700 });
  chmodSync(shim, 0o700);
  return shim;
}

function readPidRecord(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return Number.isInteger(value.pid) && typeof value.startedAt === "string" && typeof value.controlFile === "string"
      ? value : undefined;
  } catch {
    return undefined;
  }
}

function requestGracefulStop(stateDir, role, name) {
  const safeName = name?.replace(/[^A-Za-z0-9_.-]/g, "_");
  const pidPath = join(stateDir, role === "hub" ? "hub.pid" : `worker-${safeName}.pid`);
  const record = readPidRecord(pidPath);
  if (!record) return false;
  writeFileSync(join(stateDir, record.controlFile), `${JSON.stringify({ version: 1, startedAt: record.startedAt, requestedAt: new Date().toISOString() })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return true;
}

async function waitForExit(processRecord, timeoutMs) {
  if (processRecord.capture.exit) return;
  await Promise.race([
    new Promise((accept) => processRecord.child.once("exit", accept)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${processRecord.capture.label} did not stop gracefully`)), timeoutMs)),
  ]);
}

function forceTreeStop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

async function stopRecord(processRecord, stateDir, role, name) {
  if (!processRecord || processRecord.capture.exit) return;
  requestGracefulStop(stateDir, role, name);
  try {
    await waitForExit(processRecord, 20_000);
  } catch {
    forceTreeStop(processRecord.child);
    await waitForExit(processRecord, 5_000).catch(() => undefined);
  }
}

export async function runRealSmoke(options = {}) {
  const models = options.models ?? parseSmokeModels(process.env.PI_MESH_SMOKE_MODELS);
  if (models.length < 2) throw new Error("PI_MESH_SMOKE_MODELS must name at least two distinct models");
  const piCommand = options.piCommand ?? resolvePiCommand();
  if (!piCommand) return { ok: true, skipped: true, reason: "real Pi binary unavailable" };
  const probe = runCommand(piCommand, ["--version"]);
  if (probe.status !== 0) return { ok: true, skipped: true, reason: "real Pi binary unavailable" };
  const unavailableModels = models.filter((model) => !modelAuthReady(piCommand, model));
  if (unavailableModels.length > 0) {
    return { ok: true, skipped: true, reason: "model credentials unavailable", unavailableModels };
  }

  const timeoutMs = Number(process.env.PI_MESH_SMOKE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 600_000) {
    throw new Error("PI_MESH_SMOKE_TIMEOUT_MS must be an integer from 30000 to 600000");
  }
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-mesh-real-smoke-"));
  const workspaceDir = join(tempRoot, ".kxm");
  const stateDir = join(workspaceDir, "state");
  const logsDir = join(workspaceDir, "logs");
  const assetsDir = join(workspaceDir, "assets");
  for (const directory of [workspaceDir, stateDir, logsDir, assetsDir]) mkdirSync(directory, { recursive: true });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const project = `smoke-${randomUUID()}`;
  const authToken = randomBytes(32).toString("hex");
  const webhookSecret = randomBytes(32).toString("hex");
  const shim = createPiShim(tempRoot, piCommand);
  const workerNames = ["smoke-alpha", "smoke-beta"];
  const workflow = [{
    id: "real-pi-smoke",
    source: "generic",
    project,
    target: "smoke-operator",
    secretEnv: "PI_MESH_SMOKE_WEBHOOK_SECRET",
    event: "smoke.requested",
    delivery: "followUp",
    promptTemplate: "Run isolated smoke {{runId}}",
    stages: [{ id: "verify", label: "Verify", instructions: "Record the deterministic smoke result", requiredEvidence: ["real Pi evidence"], maxAttempts: 1 }],
  }];
  const commonEnv = {
    ...process.env,
    PI_MESH_HOST: "127.0.0.1",
    PI_MESH_PORT: String(port),
    PI_MESH_SERVER_URL: baseUrl,
    PI_MESH_AUTH_TOKEN: authToken,
    PI_MESH_PROJECT: project,
    PI_MESH_WORKDIR: tempRoot,
    PI_MESH_WORKSPACE_DIR: workspaceDir,
    PI_MESH_CONFIG_DIR: join(workspaceDir, "config"),
    PI_MESH_LOGS_DIR: logsDir,
    PI_MESH_ASSETS_DIR: assetsDir,
    PI_MESH_STATE_DIR: stateDir,
    PI_MESH_DATA_PATH: join(stateDir, "mesh.db"),
    PI_MESH_WEBHOOK_WORKFLOWS: JSON.stringify(workflow),
    PI_MESH_SMOKE_WEBHOOK_SECRET: webhookSecret,
  };
  const processes = { hub: undefined, workers: new Map() };
  let stage = "start";
  try {
    const startHub = () => {
      const record = spawnNode(hubScript, commonEnv, "hub");
      processes.hub = record;
      return record;
    };
    const startWorker = (index) => {
      const name = workerNames[index];
      const record = spawnNode(workerScript, {
        ...commonEnv,
        PI_MESH_AGENT_NAME: name,
        PI_MESH_AGENT_PURPOSE: "real Pi smoke peer",
        PI_MESH_WORKER_MODEL: models[index],
        PI_MESH_PI_COMMAND: shim,
        PI_MESH_WORKER_DRAIN_MS: "10000",
        PI_MESH_WORKER_MAX_RESTARTS: "2",
      }, name);
      processes.workers.set(name, record);
      return record;
    };
    await runSmokePhases([
      ["hub-ready", async () => {
        stage = "hub-ready";
        startHub();
        await waitFor(async () => {
          const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
          return response.ok;
        }, 20_000, "hub readiness");
        return registerOperator(baseUrl, authToken, project);
      }],
      ["discovery", async (values) => {
        stage = "discovery";
        const operator = values["hub-ready"];
        startWorker(0);
        startWorker(1);
        const discovered = await waitFor(async () => {
          const current = await agents(baseUrl, authToken, operator);
          return workerNames.every((name) => current.some((agent) => agent.name === name)) ? current : undefined;
        }, timeoutMs, "two real Pi workers");
        return { operator, originalIds: Object.fromEntries(workerNames.map((name) => [name, discovered.find((agent) => agent.name === name).id])) };
      }],
      ["request-reply", async (values) => {
        stage = "request-reply";
        const { operator } = values.discovery;
        return sendAndAwait(baseUrl, authToken, operator, workerNames[0], "This is a transport smoke check. Reply with a short acknowledgement and do not call tools.", timeoutMs, `single-${randomUUID()}`);
      }],
      ["fanout", async (values) => {
        stage = "fanout";
        const { operator } = values.discovery;
        const replies = await Promise.all(workerNames.map((name) => sendAndAwait(baseUrl, authToken, operator, name, "Independently confirm the transport smoke check in one short sentence. Do not call tools.", timeoutMs, `fanout-${name}-${randomUUID()}`)));
        if (replies.length !== 2) throw new Error("fanout did not return two replies");
        return replies;
      }],
      ["durable-restart-resume", async (values) => {
        stage = "durable-restart-resume";
        const { originalIds } = values.discovery;
        await stopRecord(processes.workers.get(workerNames[0]), stateDir, "worker", workerNames[0]);
        await stopRecord(processes.hub, stateDir, "hub");
        startHub();
        await waitFor(async () => {
          const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
          return response.ok;
        }, 20_000, "restarted hub readiness");
        const resumedOperator = await registerOperator(baseUrl, authToken, project);
        startWorker(0);
        const resumed = await waitFor(async () => {
          const current = await agents(baseUrl, authToken, resumedOperator);
          return workerNames.every((name) => current.some((agent) => agent.name === name)) ? current : undefined;
        }, timeoutMs, "worker resume");
        for (const name of workerNames) {
          if (resumed.find((agent) => agent.name === name).id !== originalIds[name]) throw new Error(`durable identity changed for ${name}`);
        }
        await sendAndAwait(baseUrl, authToken, resumedOperator, workerNames[0], "Confirm transport still works after the durable restart. Reply briefly and do not call tools.", timeoutMs, `post-restart-${randomUUID()}`);
        return resumedOperator;
      }],
      ["journal-checkpoint", async (values) => {
        stage = "workflow-journal-checkpoint";
        const resumedOperator = values["durable-restart-resume"];
        const payload = JSON.stringify({ event: "smoke.requested" });
        const started = await api(baseUrl, "/v1/webhooks/real-pi-smoke", {
          method: "POST",
          authToken,
          headers: { "x-mesh-event": "smoke.requested", "x-mesh-delivery-id": `smoke-${randomUUID()}`, "x-hub-signature": `sha256=${createHmac("sha256", webhookSecret).update(payload).digest("hex")}` },
          body: payload,
        });
        await api(baseUrl, `/v1/workflows/${encodeURIComponent(started.run.id)}/journal`, {
          method: "POST",
          authToken,
          identity: resumedOperator,
          body: { category: "lesson", area: "harness", severity: "info", summary: "Real Pi smoke transport completed", evidence: ["discovery", "request-reply", "fanout", "post-restart-request-reply"] },
        });
        const checkpoint = await api(baseUrl, `/v1/workflows/${encodeURIComponent(started.run.id)}/checkpoints`, {
          method: "POST",
          authToken,
          identity: resumedOperator,
          body: { stageId: "verify", status: "passed", summary: "All real Pi smoke assertions passed", evidence: { "real Pi evidence": "discovery, request/reply, fanout, and post-restart request/reply passed" } },
        });
        if (!checkpoint.completed) throw new Error("workflow checkpoint did not complete");
        const recorded = await api(baseUrl, `/v1/workflows/${encodeURIComponent(started.run.id)}`, { authToken, identity: resumedOperator });
        if (recorded.run.status !== "completed"
          || recorded.run.stages[0]?.status !== "passed"
          || !recorded.journal.some((entry) => entry.category === "lesson" && entry.area === "harness")) {
          throw new Error("workflow journal/checkpoint was not durable");
        }
      }],
    ], async () => {
      for (const [name, record] of processes.workers) await stopRecord(record, stateDir, "worker", name);
      await stopRecord(processes.hub, stateDir, "hub");
      for (const record of processes.workers.values()) forceTreeStop(record.child);
      forceTreeStop(processes.hub?.child);
      rmSync(tempRoot, { recursive: true, force: true });
    });
    return { ok: true, skipped: false, realPiWorkers: 2, assertions: ["discovery", "request-reply", "fanout", "durable-restart-resume", "post-restart-request-reply", "journal", "checkpoint"] };
  } catch (error) {
    throw new Error(`${stage}: ${boundedSafeMessage(error, [authToken, webhookSecret])}`);
  }
}

async function main() {
  const enabled = process.env.PI_MESH_SMOKE === "1" || process.argv.includes("--real-pi");
  if (!enabled) {
    writeOutcome({ ok: true, skipped: true, reason: "PI_MESH_SMOKE is not 1" });
    return;
  }
  try {
    writeOutcome(await runRealSmoke());
  } catch (error) {
    writeOutcome({ ok: false, skipped: false, error: boundedSafeMessage(error) });
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();

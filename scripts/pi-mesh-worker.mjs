#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, createWriteStream, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const name = process.env.PI_MESH_AGENT_NAME?.trim();
const project = process.env.PI_MESH_PROJECT?.trim();
if (!name || !project) {
  throw new Error("PI_MESH_AGENT_NAME and PI_MESH_PROJECT are required for a long-lived worker");
}

const command = process.env.PI_MESH_PI_COMMAND?.trim() || (process.platform === "win32" ? "pi.cmd" : "pi");
const workdir = resolve(process.env.PI_MESH_WORKDIR?.trim() || process.cwd());

function validateModelSelector(value, variable) {
  if (!value || value.length > 256 || /[\0\r\n,]/.test(value)) {
    throw new Error(`${variable} contains an invalid model selector`);
  }
  return value;
}

const primaryModel = process.env.PI_MESH_WORKER_MODEL?.trim();
const fallbackModelRaw = process.env.PI_MESH_WORKER_FALLBACK_MODELS?.trim();
if (fallbackModelRaw && !primaryModel) {
  throw new Error("PI_MESH_WORKER_FALLBACK_MODELS requires PI_MESH_WORKER_MODEL");
}
const fallbackModels = fallbackModelRaw
  ? fallbackModelRaw.split(",").map((value) => validateModelSelector(value.trim(), "PI_MESH_WORKER_FALLBACK_MODELS"))
  : [];
if (fallbackModels.length > 8) {
  throw new Error("PI_MESH_WORKER_FALLBACK_MODELS accepts at most eight comma-separated selectors");
}
const modelCandidates = [...new Set([
  ...(primaryModel ? [validateModelSelector(primaryModel, "PI_MESH_WORKER_MODEL")] : []),
  ...fallbackModels,
])];
let modelIndex = 0;

function resolveToolAllowlist() {
  const raw = process.env.PI_MESH_WORKER_TOOLS?.trim();
  if (!raw) return [];
  const tools = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  if (tools.length < 1 || tools.length > 64 || tools.some((value) => !/^[A-Za-z0-9_.-]{1,64}$/.test(value))) {
    throw new Error("PI_MESH_WORKER_TOOLS must contain one to 64 comma-separated tool names");
  }
  return tools;
}

const toolAllowlist = resolveToolAllowlist();

function resolveResourcePaths(variable, kind) {
  const raw = process.env[variable]?.trim();
  if (!raw) return [];
  const candidates = raw.split(delimiter).map((value) => value.trim()).filter(Boolean);
  if (candidates.length < 1 || candidates.length > 16) {
    throw new Error(`${variable} must contain between one and 16 paths separated by ${JSON.stringify(delimiter)}`);
  }
  const seen = new Set();
  const paths = [];
  for (const candidate of candidates) {
    const absolutePath = resolve(workdir, candidate);
    const identity = process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
    if (seen.has(identity)) continue;
    seen.add(identity);
    validateResourcePath(variable, kind, absolutePath);
    paths.push(absolutePath);
  }
  return paths;
}

function validateResourcePath(variable, kind, absolutePath) {
  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    throw new Error(`${variable} path does not exist: ${absolutePath}`);
  }
  const valid = kind === "extension" ? stats.isFile() : stats.isFile() || stats.isDirectory();
  if (!valid) {
    throw new Error(
      kind === "extension"
        ? `${variable} path must be an extension file: ${absolutePath}`
        : `${variable} path must be a skill file or directory: ${absolutePath}`,
    );
  }
}

const extensionPaths = resolveResourcePaths("PI_MESH_WORKER_EXTENSION_PATHS", "extension");
const skillPaths = resolveResourcePaths("PI_MESH_WORKER_SKILL_PATHS", "skill");
const workspaceDir = resolve(workdir, process.env.PI_MESH_WORKSPACE_DIR?.trim() || ".kxm");
const configDir = resolve(workdir, process.env.PI_MESH_CONFIG_DIR?.trim() || join(workspaceDir, "config"));
const logsDir = resolve(workdir, process.env.PI_MESH_LOGS_DIR?.trim() || join(workspaceDir, "logs"));
const assetsDir = resolve(workdir, process.env.PI_MESH_ASSETS_DIR?.trim() || join(workspaceDir, "assets"));
const stateDir = resolve(workdir, process.env.PI_MESH_STATE_DIR?.trim() || join(workspaceDir, "state"));
const safeName = name.replace(/[^A-Za-z0-9_.-]/g, "_");
const safeProject = project.replace(/[^A-Za-z0-9_.-]/g, "_");
const identityDigest = createHash("sha256")
  .update(JSON.stringify({ project, agentName: name }))
  .digest("hex")
  .slice(0, 24);
const workerKey = `${safeProject.slice(0, 24) || "project"}-${safeName.slice(0, 32) || "agent"}-${identityDigest}`;
const logPath = resolve(workdir, process.env.PI_MESH_WORKER_LOG_PATH?.trim() || join(logsDir, `pi-mesh-worker-${workerKey}.jsonl`));
const agentLogPath = resolve(workdir, process.env.PI_MESH_AGENT_LOG_PATH?.trim() || join(logsDir, `pi-agent-${workerKey}.log`));
for (const directory of [configDir, logsDir, assetsDir, stateDir, dirname(logPath), dirname(agentLogPath)]) {
  mkdirSync(directory, { recursive: true });
}
const minBackoffMs = 1_000;
const maxBackoffMs = 30_000;
const maxRestartsRaw = process.env.PI_MESH_WORKER_MAX_RESTARTS?.trim();
const maxRestarts = maxRestartsRaw === undefined ? Number.POSITIVE_INFINITY : Number(maxRestartsRaw);
if ((!Number.isInteger(maxRestarts) && maxRestarts !== Number.POSITIVE_INFINITY) || maxRestarts < 0) {
  throw new Error("PI_MESH_WORKER_MAX_RESTARTS must be a non-negative integer");
}
const continueEnabled = process.env.PI_MESH_WORKER_CONTINUE !== "false";
const initialContinue = process.env.PI_MESH_WORKER_INITIAL_CONTINUE === undefined
  ? continueEnabled
  : process.env.PI_MESH_WORKER_INITIAL_CONTINUE !== "false";
const drainTimeoutMs = Number(process.env.PI_MESH_WORKER_DRAIN_MS?.trim() || 15_000);
const providerRetryMs = Number(process.env.PI_MESH_WORKER_PROVIDER_RETRY_MS?.trim() || 60_000);
if (!Number.isInteger(providerRetryMs) || providerRetryMs < 1_000 || providerRetryMs > 3_600_000) {
  throw new Error("PI_MESH_WORKER_PROVIDER_RETRY_MS must be an integer between 1000 and 3600000");
}
// Mesh wait tools may legitimately run for 30 minutes. Keep a one-minute
// supervisor grace so their own bounded timeout can return durable handles.
const toolTimeoutMs = Number(process.env.PI_MESH_WORKER_TOOL_TIMEOUT_MS?.trim() || 1_860_000);
if (!Number.isInteger(toolTimeoutMs) || (toolTimeoutMs !== 0 && (toolTimeoutMs < 1_000 || toolTimeoutMs > 86_400_000))) {
  throw new Error("PI_MESH_WORKER_TOOL_TIMEOUT_MS must be 0 or an integer between 1000 and 86400000");
}
let backoffMs = minBackoffMs;
let restartCount = 0;
let child;
let stopping = false;
let logsClosed = false;
let continueThisStart = initialContinue;
let continueFallbackUsed = false;
let abortRequestId;
const pidPath = join(stateDir, `worker-${workerKey}.pid`);
const workerStartedAt = new Date().toISOString();
const workerGeneration = randomUUID();
const controlFile = `worker-${workerKey}.stop`;
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
  const record = {
    version: 1,
    pid: process.pid,
    role: "worker",
    agentName: name,
    project,
    workerKey,
    generation: workerGeneration,
    startedAt: workerStartedAt,
    controlFile,
  };
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
          `pi-mesh worker PID claim is invalid at ${pidPath}; remove it only after verifying no matching worker is running`,
          { cause: existingError },
        );
      }
      if (existing?.version === 1 && existing.role === "worker" && Number.isInteger(existing.pid) && processExists(existing.pid)) {
        throw new Error(`pi-mesh worker ${project}/${name} is already managed by PID ${existing.pid}`);
      }
      throw new Error(
        `pi-mesh worker PID claim is stale at ${pidPath}; remove it only after verifying no matching worker is running`,
      );
    }
  }
  throw new Error("could not claim the pi-mesh worker PID file");
}

function cleanupPid() {
  try {
    const record = JSON.parse(readFileSync(pidPath, "utf8"));
    if (record.pid === process.pid && record.generation === workerGeneration) rmSync(pidPath, { force: true });
  } catch {
    // The record may already be removed or replaced by a newer worker.
  }
}

claimPidFile();
process.once("exit", cleanupPid);
rmSync(controlPath, { force: true });
const logStream = createWriteStream(logPath, { flags: "a", mode: 0o600 });
const agentLogStream = createWriteStream(agentLogPath, { flags: "a", mode: 0o600 });

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

function writeRecoveryEnvelope(details) {
  let persistedContext = {};
  for (const contextPath of [
    join(stateDir, `worker-context-${workerKey}.json`),
    join(stateDir, `worker-context-${safeName}.json`),
  ]) {
    try {
      const candidate = JSON.parse(readFileSync(contextPath, "utf8"));
      if (candidate?.version === 1 && candidate.agentName === name && candidate.project === project) {
        persistedContext = {
          runId: typeof candidate.runId === "string" ? candidate.runId : null,
          stageId: typeof candidate.stageId === "string" ? candidate.stageId : null,
          pendingMessageIds: Array.isArray(candidate.pendingMessageIds)
            ? candidate.pendingMessageIds.filter((value) => typeof value === "string")
            : [],
          artifactPointers: Array.isArray(candidate.artifactPointers)
            ? candidate.artifactPointers.filter((value) => typeof value === "string")
            : [],
        };
        break;
      }
    } catch {
      // Try the legacy name-only context after the collision-safe path.
    }
  }
  const envelope = {
    version: 1,
    reason: details.reason,
    agentName: name,
    project,
    workerKey,
    generation: workerGeneration,
    previousContinue: continueEnabled,
    freshSession: details.freshSession === true,
    createdAt: new Date().toISOString(),
    runId: null,
    stageId: null,
    pendingMessageIds: [],
    artifactPointers: [],
    ...persistedContext,
    ...(details.signal ? { signal: details.signal } : {}),
    ...(details.failureClass ? { failureClass: details.failureClass } : {}),
  };
  writeFileSync(join(stateDir, `worker-recovery-${workerKey}.json`), `${JSON.stringify(envelope)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function start() {
  try {
    for (const extensionPath of extensionPaths) {
      validateResourcePath("PI_MESH_WORKER_EXTENSION_PATHS", "extension", extensionPath);
    }
    for (const skillPath of skillPaths) {
      validateResourcePath("PI_MESH_WORKER_SKILL_PATHS", "skill", skillPath);
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    log("worker_resource_validation_failed", { message: failure.message });
    process.stderr.write(`${failure.stack ?? failure.message}\n`);
    process.exitCode = 1;
    closeLogs();
    return;
  }
  const selectedModel = modelCandidates[modelIndex];
  const args = ["--mode", "rpc", "--name", name];
  if (continueThisStart) args.push("--continue");
  if (selectedModel) args.push("--model", selectedModel);
  if (toolAllowlist.length) args.push("--tools", toolAllowlist.join(","));
  if (extensionPaths.length) {
    args.push("--no-extensions");
    for (const extensionPath of extensionPaths) args.push("--extension", extensionPath);
  }
  if (skillPaths.length) {
    args.push("--no-skills");
    for (const skillPath of skillPaths) args.push("--skill", skillPath);
  }
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
    workerKey,
    toolTimeoutMs,
    ...(selectedModel ? { model: selectedModel, modelCandidate: modelIndex + 1, modelCandidateCount: modelCandidates.length } : {}),
    explicitToolCount: toolAllowlist.length,
    explicitExtensionCount: extensionPaths.length,
    explicitSkillCount: skillPaths.length,
  });
  const startedAt = Date.now();
  let continuationUnresumable = false;
  let providerErrorBuffer = "";
  const rpcDecoder = new StringDecoder("utf8");
  let rpcLineFragments = [];
  let rpcLineStoredChars = 0;
  let rpcLineChars = 0;
  let rpcLineOversized = false;
  let rpcLineTail = "";
  const maxRpcFrameChars = 4 * 1024 * 1024;
  const rpcMetadataWindowChars = 64 * 1024;
  let finalProviderFailure;
  let recoveryRestartRequested;
  let recoveryExitTimer;
  const toolTimers = new Map();
  const observeProviderOutput = (text) => {
    providerErrorBuffer = `${providerErrorBuffer}${text}`.slice(-8_192);
    if (/invalid_request_error|missing_tool_result|tool_use[\s\S]{0,256}tool_result/i.test(providerErrorBuffer)) {
      continuationUnresumable = true;
    }
  };
  let completed = false;
  const clearToolTimers = () => {
    for (const timer of toolTimers.values()) clearTimeout(timer);
    toolTimers.clear();
  };
  const complete = (code, signal, error) => {
    if (completed) return;
    completed = true;
    if (recoveryExitTimer) clearTimeout(recoveryExitTimer);
    clearToolTimers();
    child = undefined;
    if (error) log("worker_process_error", { message: error.message, code: error.code });
    const uptimeMs = Date.now() - startedAt;
    log("worker_exited", { code, signal, ...(error ? { error: error.message } : {}), uptimeMs });
    if (stopping) {
      closeLogs();
      process.exit(0);
      return;
    }
    if (recoveryRestartRequested) {
      if (recoveryRestartRequested.reason === "unresumable_session") {
        start();
        return;
      }
      if (restartCount >= maxRestarts) {
        log("worker_restart_limit_reached", { restartCount, reason: recoveryRestartRequested.reason });
        process.exitCode = code || 1;
        closeLogs();
        return;
      }
      restartCount += 1;
      const delay = recoveryRestartRequested.delayMs;
      log(recoveryRestartRequested.reason === "provider_error"
        ? "worker_provider_restart_scheduled"
        : "worker_tool_restart_scheduled", {
        delayMs: delay,
        restartCount,
        failureClass: recoveryRestartRequested.failureClass,
        fallbackSelected: recoveryRestartRequested.fallbackSelected,
        ...(recoveryRestartRequested.nextModel ? { nextModel: recoveryRestartRequested.nextModel } : {}),
      });
      setTimeout(start, delay);
      return;
    }
    if (continueThisStart && !continueFallbackUsed && continuationUnresumable && (code || 0) !== 0) {
      continueFallbackUsed = true;
      continueThisStart = false;
      writeRecoveryEnvelope({ reason: "unresumable_session", freshSession: true });
      log("worker_continue_fallback", { reason: "unresumable_session", uptimeMs });
      start();
      return;
    }
    if (uptimeMs > 60_000) {
      continueFallbackUsed = false;
    }
    if (restartCount >= maxRestarts) {
      log("worker_restart_limit_reached", { restartCount });
      process.exitCode = code || 1;
      closeLogs();
      return;
    }
    restartCount += 1;
    continueThisStart = continueEnabled;
    if (Date.now() - startedAt > 60_000) backoffMs = minBackoffMs;
    const delay = backoffMs;
    backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
    log("worker_restart_scheduled", { delayMs: delay, restartCount });
    setTimeout(start, delay);
  };

  function providerFailureClass(errorMessage) {
    return /\b(quota reached|quota exceeded|rate limit(?:ed)?|too many requests|resource exhausted|http 429)\b/i.test(errorMessage)
      ? "quota"
      : "provider_error";
  }

  function observeRpcEvent(response) {
    if (response?.type === "tool_execution_start" && toolTimeoutMs > 0) {
      const toolCallId = typeof response.toolCallId === "string" && response.toolCallId.length <= 256
        ? response.toolCallId
        : `unknown-${Date.now()}`;
      const toolName = typeof response.toolName === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(response.toolName)
        ? response.toolName
        : "unknown";
      const existing = toolTimers.get(toolCallId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        toolTimers.delete(toolCallId);
        requestRecoveryRestart({
          reason: "tool_timeout",
          failureClass: "timeout",
          rotateModel: false,
          toolName,
        });
      }, toolTimeoutMs);
      timer.unref();
      toolTimers.set(toolCallId, timer);
      return;
    }
    if (response?.type === "tool_execution_end") {
      const timer = toolTimers.get(response.toolCallId);
      if (timer) clearTimeout(timer);
      toolTimers.delete(response.toolCallId);
      return;
    }
    if (response?.type === "agent_end" && Array.isArray(response.messages)) {
      const assistant = [...response.messages].reverse().find((message) => message?.role === "assistant");
      if (assistant?.stopReason === "error") {
        finalProviderFailure = providerFailureClass(
          typeof assistant.errorMessage === "string" ? assistant.errorMessage : "provider error",
        );
      } else if (assistant) {
        finalProviderFailure = undefined;
      }
      return;
    }
    if (response?.type !== "agent_settled") return;
    if (continueThisStart && !continueFallbackUsed && continuationUnresumable) {
      requestRecoveryRestart({
        reason: "unresumable_session",
        failureClass: "unresumable_session",
        rotateModel: false,
      });
      return;
    }
    if (!finalProviderFailure) return;
    requestRecoveryRestart({
      reason: "provider_error",
      failureClass: finalProviderFailure,
      rotateModel: true,
    });
  }

  function requestRecoveryRestart({ reason, failureClass, rotateModel, toolName }) {
    if (stopping || completed || recoveryRestartRequested || !child) return;
    clearToolTimers();
    const unresumableFallback = reason === "unresumable_session";
    const fallbackSelected = Boolean(!unresumableFallback && rotateModel && modelIndex + 1 < modelCandidates.length);
    if (fallbackSelected) modelIndex += 1;
    const nextModel = modelCandidates[modelIndex];
    const delayMs = unresumableFallback ? 0 : reason === "tool_timeout" || fallbackSelected ? minBackoffMs : providerRetryMs;
    recoveryRestartRequested = { reason, failureClass, fallbackSelected, nextModel, delayMs };
    if (unresumableFallback) {
      continueThisStart = false;
      continueFallbackUsed = true;
      writeRecoveryEnvelope({ reason, freshSession: true });
      log("worker_continue_fallback", { reason, settledError: true, uptimeMs: Date.now() - startedAt });
    } else {
      continueThisStart = continueEnabled;
      continueFallbackUsed = false;
      writeRecoveryEnvelope({ reason, freshSession: !continueEnabled, failureClass });
      log(reason === "provider_error" ? "worker_provider_failure" : "worker_tool_timeout", {
        failureClass,
        fallbackSelected,
        ...(toolName ? { toolName } : {}),
        ...(selectedModel ? { failedModel: selectedModel } : {}),
        ...(nextModel ? { nextModel } : {}),
      });
    }
    try {
      child.stdin.end();
    } catch {
      // The bounded force timer below handles an already-broken stdin pipe.
    }
    const forceAfterMs = Math.min(Number.isFinite(drainTimeoutMs) ? drainTimeoutMs : 15_000, 5_000);
    const restartTarget = child;
    recoveryExitTimer = setTimeout(() => {
      if (!restartTarget || child !== restartTarget || restartTarget.exitCode !== null || restartTarget.signalCode !== null) return;
      log(reason === "provider_error"
        ? "worker_provider_restart_killed"
        : reason === "tool_timeout"
          ? "worker_tool_restart_killed"
          : "worker_continue_fallback_killed", {
        failureClass,
        signal: "SIGKILL",
      });
      if (process.platform === "win32" && restartTarget.pid) {
        spawnSync("taskkill.exe", ["/pid", String(restartTarget.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      } else {
        restartTarget.kill("SIGKILL");
      }
    }, forceAfterMs);
    recoveryExitTimer.unref();
  }

  function observeRpcLine(line) {
    const value = line.trim();
    if (!value) return;
    try {
      const response = JSON.parse(value);
      if (stopping && abortRequestId && response?.id === abortRequestId && response.type === "response" && response.command === "abort" && response.success === true) {
        abortRequestId = undefined;
        log("worker_drain_confirmed");
        child?.stdin.end();
      }
      if (!stopping) observeRpcEvent(response);
    } catch {
      // Pi RPC output is newline-delimited JSON; unrelated output remains only in the protected agent log.
    }
  }

  function decodedJsonString(value) {
    try {
      return JSON.parse(`"${value}"`);
    } catch {
      return undefined;
    }
  }

  function decodedJsonStringFields(value, field) {
    const matches = [];
    const pattern = new RegExp(`(?:^|[{,])\\s*"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "g");
    for (const match of value.matchAll(pattern)) {
      const decoded = decodedJsonString(match[1]);
      if (typeof decoded === "string") matches.push(decoded);
    }
    return matches;
  }

  function observeOversizedRpcLine(prefix, tail, frameChars) {
    const prefixWindow = prefix.slice(0, rpcMetadataWindowChars);
    const tailWindow = tail.slice(-rpcMetadataWindowChars);
    const decodedType = decodedJsonStringFields(prefixWindow, "type")[0];
    let metadataRecovered = false;
    if (decodedType === "tool_execution_start" || decodedType === "tool_execution_end") {
      const toolCallId = decodedJsonStringFields(prefixWindow, "toolCallId")[0];
      const toolName = decodedJsonStringFields(prefixWindow, "toolName")[0];
      observeRpcEvent({
        type: decodedType,
        ...(toolCallId ? { toolCallId } : {}),
        ...(toolName ? { toolName } : {}),
      });
      metadataRecovered = Boolean(toolCallId);
    } else if (decodedType === "agent_end") {
      const stopReasons = [
        ...decodedJsonStringFields(prefixWindow, "stopReason"),
        ...decodedJsonStringFields(tailWindow, "stopReason"),
      ];
      const errorMessages = [
        ...decodedJsonStringFields(prefixWindow, "errorMessage"),
        ...decodedJsonStringFields(tailWindow, "errorMessage"),
      ];
      const stopReason = stopReasons.at(-1);
      const errorMessage = errorMessages.at(-1);
      if (stopReason) {
        observeRpcEvent({
          type: "agent_end",
          messages: [{
            role: "assistant",
            stopReason,
            ...(errorMessage ? { errorMessage } : {}),
          }],
        });
        metadataRecovered = true;
      }
    } else if (decodedType === "agent_settled") {
      observeRpcEvent({ type: "agent_settled" });
      metadataRecovered = true;
    }
    log("worker_rpc_frame_oversized", {
      frameChars,
      storedPrefixChars: prefix.length,
      storedTailChars: tail.length,
      eventType: metadataRecovered ? decodedType : "unknown",
      metadataRecovered,
    });
  }

  function appendRpcLineFragment(fragment) {
    rpcLineChars += fragment.length;
    if (!rpcLineOversized) {
      const remaining = maxRpcFrameChars - rpcLineStoredChars;
      if (fragment.length <= remaining) {
        rpcLineFragments.push(fragment);
        rpcLineStoredChars += fragment.length;
        return;
      }
      if (remaining > 0) {
        rpcLineFragments.push(fragment.slice(0, remaining));
        rpcLineStoredChars += remaining;
      }
      rpcLineOversized = true;
      rpcLineTail = fragment.slice(remaining).slice(-rpcMetadataWindowChars);
      return;
    }
    rpcLineTail = `${rpcLineTail}${fragment}`.slice(-rpcMetadataWindowChars);
  }

  function finishRpcLine() {
    const prefix = rpcLineFragments.join("");
    if (rpcLineOversized) observeOversizedRpcLine(prefix, rpcLineTail, rpcLineChars);
    else observeRpcLine(prefix);
    rpcLineFragments = [];
    rpcLineStoredChars = 0;
    rpcLineChars = 0;
    rpcLineOversized = false;
    rpcLineTail = "";
  }

  function observeRpcText(text) {
    let offset = 0;
    let newline = text.indexOf("\n", offset);
    while (newline >= 0) {
      appendRpcLineFragment(text.slice(offset, newline));
      finishRpcLine();
      offset = newline + 1;
      newline = text.indexOf("\n", offset);
    }
    if (offset < text.length) appendRpcLineFragment(text.slice(offset));
  }
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
        PI_MESH_WORKER_IDENTITY_KEY: workerKey,
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
    const text = rpcDecoder.write(chunk);
    observeProviderOutput(text);
    observeRpcText(text);
  });
  child.stdout.on("end", () => {
    const trailing = rpcDecoder.end();
    if (trailing) observeRpcText(trailing);
    if (rpcLineChars > 0) finishRpcLine();
  });
  child.stderr.on("data", (chunk) => {
    agentLogStream.write(chunk);
    observeProviderOutput(chunk.toString("utf8"));
  });
  child.once("error", (error) => complete(null, null, error));
  // `close` follows stdio completion, so a final unterminated frame is observed
  // before recovery decisions and log streams are finalized.
  child.once("close", (code, signal) => complete(code, signal));
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  writeRecoveryEnvelope({ reason: "worker_signal", signal, freshSession: false });
  log("worker_stopping", { signal });
  if (!child) {
    closeLogs();
    process.exit(0);
    return;
  }
  log("worker_drain_wait", { timeoutMs: Number.isFinite(drainTimeoutMs) ? drainTimeoutMs : 15_000 });
  try {
    abortRequestId = `worker-abort-${process.pid}-${Date.now()}`;
    child.stdin.write(`${JSON.stringify({ id: abortRequestId, type: "abort" })}\n`);
    log("worker_abort_requested", { requestId: abortRequestId });
  } catch (error) {
    log("worker_abort_failed", { message: error instanceof Error ? error.message : String(error) });
  }
  const force = setTimeout(() => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    log("worker_killed", { signal: "SIGKILL" });
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  }, Number.isFinite(drainTimeoutMs) ? drainTimeoutMs : 15_000);
  force.unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
const controlTimer = setInterval(() => {
  try {
    const request = JSON.parse(readFileSync(controlPath, "utf8"));
    if (request.startedAt !== workerStartedAt || request.generation !== workerGeneration) return;
    rmSync(controlPath, { force: true });
    shutdown("operator");
  } catch {
    // No stop request is waiting.
  }
}, 250);
controlTimer.unref();
const stopAfterMs = Number(process.env.PI_MESH_WORKER_STOP_AFTER_MS?.trim() || 0);
if (Number.isInteger(stopAfterMs) && stopAfterMs > 0) {
  setTimeout(() => shutdown("timeout"), stopAfterMs).unref();
}
start();

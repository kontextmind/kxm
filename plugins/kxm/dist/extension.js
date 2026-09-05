// plugins/kxm/src/extension.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync4, renameSync as renameSync2, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { basename, dirname, join as join4 } from "node:path";
import { Type } from "typebox";

// plugins/kxm/src/client.ts
import { createHash } from "node:crypto";

// plugins/kxm/src/protocol.ts
var DEFAULT_MESSAGE_TTL_MS = 24 * 60 * 6e4;
var MAX_MESSAGE_TTL_MS = 7 * 24 * 60 * 6e4;
var DEFAULT_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 6e4;
var MAX_BODY_BYTES = 256 * 1024;
var MAX_CONTENT_CHARS = 32e3;

// plugins/kxm/src/workflow.ts
function canonicalWorkflowEvidenceKey(value) {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

// plugins/kxm/src/client.ts
var MeshWaitError = class extends Error {
  waitStatus;
  constructor(waitStatus, messageId) {
    super(waitStatus === "aborted" ? "await cancelled" : `timed out waiting for ${messageId}`);
    this.name = "MeshWaitError";
    this.waitStatus = waitStatus;
  }
};
function completedFanoutResult(target, message) {
  if (message.status === "queued" || message.status === "delivered") {
    throw new Error(`message ${message.id} is not complete`);
  }
  return {
    target,
    messageId: message.id,
    status: message.status,
    ...message.reply ? { reply: message.reply.content } : {},
    ...message.error ? { error: message.error } : {}
  };
}
function fanoutIdempotencyKey(prefix, target, correlationId, workflowContext) {
  const scope = JSON.stringify(workflowContext ? {
    prefix,
    correlationId: correlationId ?? null,
    target: target.toLowerCase(),
    workflowContext: {
      runId: workflowContext.runId,
      stageId: workflowContext.stageId,
      requirementKey: canonicalWorkflowEvidenceKey(workflowContext.requirementKey),
      attempt: workflowContext.attempt
    }
  } : {
    prefix,
    correlationId: correlationId ?? null,
    target: target.toLowerCase()
  });
  return `fanout:${createHash("sha256").update(scope).digest("hex")}`;
}
var HubHttpError = class extends Error {
  statusCode;
  code;
  requestId;
  extras;
  constructor(statusCode, message, code, requestId, extras) {
    super(message);
    this.name = "HubHttpError";
    this.statusCode = statusCode;
    if (code) this.code = code;
    if (requestId) this.requestId = requestId;
    if (extras) this.extras = extras;
  }
};
var HubClient = class {
  options;
  agent;
  agentKey;
  heartbeatTimer;
  eventsAbort;
  stopped = true;
  onEvent;
  registration;
  eventLoop;
  constructor(options) {
    this.options = { heartbeatMs: 1e4, reconnectMs: 1e3, requestTimeoutMs: 15e3, ...options };
  }
  async start(onEvent) {
    if (!this.stopped) throw new Error("hub client is already started");
    this.stopped = false;
    this.onEvent = onEvent;
    try {
      await this.register();
    } catch (error) {
      this.stopped = true;
      throw error;
    }
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.options.heartbeatMs);
    this.heartbeatTimer.unref();
    this.eventLoop = this.runEventLoop();
    return this.agent;
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.eventsAbort?.abort();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.eventLoop;
    if (this.agent) {
      try {
        await this.request(`/v1/agents/${encodeURIComponent(this.agent.id)}`, { method: "DELETE" });
      } catch {
      }
    }
    this.agent = void 0;
    this.agentKey = void 0;
    this.onEvent = void 0;
    this.eventLoop = void 0;
  }
  async listAgents() {
    const result2 = await this.request("/v1/agents");
    return result2.agents;
  }
  async send(options) {
    const result2 = await this.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify(options)
    });
    return result2.message;
  }
  async fanout(options) {
    const targets = [...new Set(options.targets.map((target) => target.trim().toLowerCase()).filter(Boolean))];
    if (targets.length < 1 || targets.length > 3) throw new Error("fanout requires between one and three unique targets");
    return await Promise.all(targets.map(async (target) => {
      let message;
      try {
        message = await this.send({
          target,
          content: options.content,
          delivery: "followUp",
          ...options.correlationId ? { correlationId: options.correlationId } : {},
          ...options.workflowContext ? { workflowContext: options.workflowContext } : {},
          ...options.idempotencyKeyPrefix ? {
            idempotencyKey: fanoutIdempotencyKey(
              options.idempotencyKeyPrefix,
              target,
              options.correlationId,
              options.workflowContext
            )
          } : {},
          ...options.ttlMs ? { ttlMs: options.ttlMs } : {}
        });
        const completed = await this.awaitResponse(
          message.id,
          options.timeoutMs ?? 30 * 6e4,
          options.signal
        );
        return completedFanoutResult(target, completed);
      } catch (error) {
        if (message && error instanceof MeshWaitError) {
          try {
            const current = await this.getMessage(message.id);
            if (current.status === "queued" || current.status === "delivered") {
              return {
                target,
                messageId: current.id,
                status: "pending",
                messageStatus: current.status,
                expiresAt: current.expiresAt,
                waitStatus: error.waitStatus
              };
            }
            return completedFanoutResult(target, current);
          } catch (finalError) {
            return {
              target,
              messageId: message.id,
              status: "error",
              error: finalError instanceof Error ? finalError.message : String(finalError)
            };
          }
        }
        return {
          target,
          ...message ? { messageId: message.id } : {},
          status: "error",
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }));
  }
  async getMessage(messageId) {
    const result2 = await this.request(`/v1/messages/${encodeURIComponent(messageId)}`);
    return result2.message;
  }
  async acknowledge(messageId) {
    const result2 = await this.request(
      `/v1/messages/${encodeURIComponent(messageId)}/ack`,
      { method: "POST", body: "{}" }
    );
    return result2.message;
  }
  async reply(messageId, content) {
    const result2 = await this.request(
      `/v1/messages/${encodeURIComponent(messageId)}/reply`,
      { method: "POST", body: JSON.stringify({ content }) }
    );
    return result2.message;
  }
  async cancel(messageId) {
    const result2 = await this.request(
      `/v1/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE" }
    );
    return result2.message;
  }
  async listWorkflows() {
    const result2 = await this.request("/v1/workflows");
    return result2.runs;
  }
  async getWorkflow(runId) {
    return await this.request(`/v1/workflows/${encodeURIComponent(runId)}`);
  }
  async checkpointWorkflow(runId, input) {
    return await this.request(`/v1/workflows/${encodeURIComponent(runId)}/checkpoints`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }
  async waitForWorkflowSignal(runId, input) {
    return await this.request(`/v1/workflows/${encodeURIComponent(runId)}/waits`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }
  async recordWorkflowEntry(runId, input) {
    const result2 = await this.request(
      `/v1/workflows/${encodeURIComponent(runId)}/journal`,
      { method: "POST", body: JSON.stringify(input) }
    );
    return result2.entry;
  }
  async improvementReport() {
    return await this.request("/v1/improvements");
  }
  // ----- Context operating-system API (v0.5, issue #34) -----
  async contextGet(input) {
    return await this.request("/v1/context/get", { method: "POST", body: JSON.stringify(input) });
  }
  async contextRecall(input) {
    return await this.request("/v1/context/recall", { method: "POST", body: JSON.stringify(input) });
  }
  async contextState(input) {
    return await this.request("/v1/context/state", { method: "POST", body: JSON.stringify(input) });
  }
  async contextStatePropose(input) {
    return await this.request("/v1/context/state/propose", { method: "POST", body: JSON.stringify(input) });
  }
  async contextStatePromote(input) {
    return await this.request("/v1/context/state/promote", { method: "POST", body: JSON.stringify(input) });
  }
  async contextEpisode(input) {
    return await this.request("/v1/context/episode", { method: "POST", body: JSON.stringify(input) });
  }
  async contextExplain(input) {
    return await this.request("/v1/context/explain", { method: "POST", body: JSON.stringify(input) });
  }
  async contextWikiCompile(input) {
    return await this.request("/v1/context/wiki/compile", { method: "POST", body: JSON.stringify(input) });
  }
  async awaitResponse(messageId, timeoutMs = 30 * 6e4, signal) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new MeshWaitError("aborted", messageId);
      const message = await this.getMessage(messageId);
      if (["replied", "cancelled", "expired", "error"].includes(message.status)) return message;
      await new Promise((resolve2, reject) => {
        const onAbort = () => {
          signal?.removeEventListener("abort", onAbort);
          clearTimeout(timer);
          reject(new MeshWaitError("aborted", messageId));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve2();
        }, Math.min(500, Math.max(1, deadline - Date.now())));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        timer.unref();
      });
    }
    throw new MeshWaitError("timed_out", messageId);
  }
  async heartbeat() {
    if (this.stopped || !this.agent) return;
    try {
      await this.request(`/v1/agents/${encodeURIComponent(this.agent.id)}/heartbeat`, {
        method: "POST",
        body: "{}"
      });
    } catch (error) {
      if (error instanceof HubHttpError && error.statusCode === 401) void this.recoverRegistration();
    }
  }
  async runEventLoop() {
    while (!this.stopped && this.agent) {
      this.eventsAbort = new AbortController();
      try {
        const response = await fetch(
          `${this.options.serverUrl.replace(/\/$/, "")}/v1/events?agentId=${encodeURIComponent(this.agent.id)}`,
          {
            headers: this.headers(),
            signal: this.eventsAbort.signal
          }
        );
        if (response.status === 401) {
          await response.body?.cancel();
          await this.recoverRegistration();
          continue;
        }
        if (!response.ok || !response.body) throw new Error(`event stream failed with HTTP ${response.status}`);
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          if (this.stopped) break;
          buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            const parsed = JSON.parse(data);
            if ("type" in parsed) await this.onEvent?.(parsed);
          }
        }
      } catch (error) {
        if (this.stopped || error instanceof Error && error.name === "AbortError") return;
      }
      if (!this.stopped) await new Promise((resolve2) => setTimeout(resolve2, this.options.reconnectMs));
    }
  }
  headers(includeIdentity = true) {
    const headers = { "content-type": "application/json" };
    if (this.options.authToken) headers.authorization = `Bearer ${this.options.authToken}`;
    if (includeIdentity && this.agent && this.agentKey) {
      headers["x-kxm-agent-id"] = this.agent.id;
      headers["x-kxm-agent-key"] = this.agentKey;
    }
    return headers;
  }
  async register() {
    if (this.registration) return this.registration;
    this.registration = (async () => {
      const registration = await this.request("/v1/agents/register", {
        method: "POST",
        body: JSON.stringify({
          name: this.options.name,
          purpose: this.options.purpose,
          project: this.options.project,
          model: this.options.model
        })
      }, false);
      this.agent = registration.agent;
      this.agentKey = registration.agentKey;
      return registration.agent;
    })();
    try {
      return await this.registration;
    } finally {
      this.registration = void 0;
    }
  }
  async recoverRegistration() {
    if (this.stopped) return;
    this.agent = void 0;
    this.agentKey = void 0;
    await this.register();
  }
  async request(path, init = {}, includeIdentity = true) {
    const requestTimeoutMs = this.options.requestTimeoutMs ?? 15e3;
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await fetch(`${this.options.serverUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        signal,
        headers: { ...this.headers(includeIdentity), ...init.headers ?? {} }
      });
    } catch (error) {
      if (timeoutSignal.aborted) throw new Error(`request timed out after ${requestTimeoutMs}ms`);
      throw error;
    }
    const text = await response.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`hub returned invalid JSON with HTTP ${response.status}`);
      }
    }
    if (!response.ok) {
      const extras = {};
      for (const key of ["operation", "nextAction", "assignedCoordinatorName"]) {
        if (typeof body[key] === "string") extras[key] = body[key];
      }
      throw new HubHttpError(
        response.status,
        String(body.error ?? `HTTP ${response.status}`),
        typeof body.code === "string" ? body.code : void 0,
        response.headers.get("x-request-id") ?? void 0,
        Object.keys(extras).length > 0 ? extras : void 0
      );
    }
    return body;
  }
};

// plugins/kxm/src/diagnostics.ts
var NEXT_ACTIONS = [
  "use_assigned_coordinator",
  "wait_then_checkpoint",
  "record_journal_as_coordinator",
  "reconnect_with_current_agent_key",
  "check_project_token",
  "export_retrospective",
  "post_signal",
  "restart_fresh_session",
  "switch_model_or_retry"
];
var CODE_TO_CLASS = {
  workflow_forbidden: "workflow_scope",
  invalid_agent_identity: "invalid_identity",
  invalid_auth: "invalid_auth",
  workflow_signal_mismatch: "signal_mismatch",
  workflow_not_waiting: "not_waiting",
  workflow_terminal: "not_waiting",
  workflow_not_running: "not_waiting",
  unresumable_session: "unresumable_session",
  provider_quota: "quota",
  provider_error: "provider_error"
};
function operationForTool(toolName) {
  switch (toolName) {
    case "kxm_workflow_get":
    case "kxm_workflow_list":
      return "get";
    case "kxm_workflow_wait":
      return "wait";
    case "kxm_workflow_checkpoint":
      return "checkpoint";
    case "kxm_workflow_record":
      return "journal";
    case "kxm_await":
      return "await";
    default:
      return "other";
  }
}
function areaForTool(toolName) {
  if (toolName?.startsWith("kxm_workflow_")) return "workflow";
  if (toolName?.startsWith("kxm_")) return "harness";
  return "implementation";
}
function nextActionForCode(code, operation) {
  if (code === "workflow_forbidden") return "use_assigned_coordinator";
  if (code === "invalid_agent_identity") return "reconnect_with_current_agent_key";
  if (code === "invalid_auth") return "check_project_token";
  if (code === "workflow_not_waiting" || code === "workflow_terminal" || code === "workflow_not_running") {
    return operation === "checkpoint" ? "wait_then_checkpoint" : "export_retrospective";
  }
  if (code === "workflow_signal_mismatch") return "post_signal";
  if (code === "unresumable_session") return "restart_fresh_session";
  if (code === "provider_quota" || code === "provider_error") return "switch_model_or_retry";
  return void 0;
}
function classFromTokens(text) {
  const value = text.toLowerCase();
  if (/\b(enoent|not recognized|command not found|is not recognized)\b/.test(value)) return "command_not_found";
  if (/\b(ts\d{3,4}|typecheck|type error)\b/.test(value)) return "typecheck_error";
  if (/\b(test failed|assertionerror|not equal)\b/.test(value)) return "test_failure";
  if (/\b(timed out|timeout|deadline)\b/.test(value)) return "timeout";
  if (/\b(aborted|cancelled|canceled|sigint|sigterm)\b/.test(value)) return "cancelled";
  if (/\b(econnrefused|enotfound|fetch failed|network)\b/.test(value)) return "network";
  if (/\b(invalid json|unexpected token|parse error)\b/.test(value)) return "parse_error";
  if (/\b(invalid_request_error|missing_tool_result|unresumable)\b/.test(value)) return "unresumable_session";
  if (/\b(quota reached|quota exceeded|rate limit(?:ed)?|too many requests|resource exhausted|http 429)\b/.test(value)) return "quota";
  if (/\b(not visible|only the assigned coordinator)\b/.test(value)) return "workflow_scope";
  return void 0;
}
function classifyFailure(input) {
  const tool = input.toolName?.trim() || "unknown";
  const operation = operationForTool(input.toolName);
  const fromCode = input.code ? CODE_TO_CLASS[input.code] : void 0;
  const fromTokens = input.message ? classFromTokens(input.message) : void 0;
  const diagnosticClass = fromCode ?? fromTokens ?? "unknown";
  const messageCoordinator = input.message?.match(/assignedCoordinator=([A-Za-z0-9_.-]{1,64})/)?.[1];
  const messageAction = input.message?.match(/nextAction=([a-z_]{1,64})/)?.[1];
  const parsedAction = NEXT_ACTIONS.includes(messageAction) ? messageAction : void 0;
  const nextAction = input.nextAction ?? parsedAction ?? nextActionForCode(input.code, operation);
  const assignedCoordinatorName = input.assignedCoordinatorName ?? messageCoordinator;
  return {
    class: diagnosticClass,
    tool,
    operation,
    ...input.statusCode !== void 0 ? { httpStatus: input.statusCode } : {},
    ...input.code ? { code: input.code } : {},
    ...assignedCoordinatorName ? { assignedCoordinatorName } : {},
    ...nextAction ? { nextAction } : {},
    ...input.exitCode !== void 0 ? { exitCode: input.exitCode } : {},
    ...input.durationMs !== void 0 ? { durationMs: input.durationMs } : {}
  };
}
function diagnosticEvidence(diagnostic, toolCallId) {
  return [
    `tool:${diagnostic.tool}`,
    ...toolCallId ? [`tool-call:${toolCallId}`] : [],
    `class:${diagnostic.class}`,
    `operation:${diagnostic.operation}`,
    ...diagnostic.code ? [`code:${diagnostic.code}`] : [],
    ...diagnostic.nextAction ? [`nextAction:${diagnostic.nextAction}`] : [],
    ...diagnostic.assignedCoordinatorName ? [`assignedCoordinator:${diagnostic.assignedCoordinatorName}`] : []
  ];
}
function diagnosticSummary(diagnostic) {
  const coordinator = diagnostic.assignedCoordinatorName ? `; assigned coordinator: ${diagnostic.assignedCoordinatorName}` : "";
  const next = diagnostic.nextAction ? `; next action: ${diagnostic.nextAction}` : "";
  return `Tool ${diagnostic.tool} failed: ${diagnostic.class}${coordinator}${next}`;
}

// plugins/kxm/src/recovery.ts
import { createHash as createHash2 } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
function workerStateKey(project, agentName) {
  const safeProject = project.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 24) || "project";
  const safeName = agentName.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 32) || "agent";
  const digest = createHash2("sha256").update(JSON.stringify({ project, agentName })).digest("hex").slice(0, 24);
  return `${safeProject}-${safeName}-${digest}`;
}
function legacyRecoveryEnvelopePath(stateDir, agentName) {
  const safeName = agentName.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(stateDir, `worker-recovery-${safeName}.json`);
}
function recoveryEnvelopePath(stateDir, agentName, project) {
  return project ? join(stateDir, `worker-recovery-${workerStateKey(project, agentName)}.json`) : legacyRecoveryEnvelopePath(stateDir, agentName);
}
var recoveryReasons = /* @__PURE__ */ new Set([
  "missing_tool_result",
  "unresumable_session",
  "provider_error",
  "tool_timeout",
  "worker_signal"
]);
var recoveryRunId = /^run_[a-f0-9]{32}$/;
var recoveryMessageId = /^msg_[a-f0-9]{32}$/;
function validBoundedStrings(value, maxItems, pattern) {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 2048 && !/[\0\r\n]/.test(item) && (!pattern || pattern.test(item)));
}
function parseRecoveryEnvelope(value, agentName, project) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("recovery envelope must be an object");
  const parsed = value;
  if (parsed.version !== 1 || !recoveryReasons.has(parsed.reason) || parsed.agentName !== agentName || typeof parsed.project !== "string" || parsed.project.length < 1 || parsed.project.length > 128 || project !== void 0 && parsed.project !== project || typeof parsed.previousContinue !== "boolean" || typeof parsed.freshSession !== "boolean" || typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt))) throw new Error("recovery envelope identity or schema is invalid");
  if (parsed.runId !== void 0 && parsed.runId !== null && !recoveryRunId.test(parsed.runId)) {
    throw new Error("recovery envelope run identity is invalid");
  }
  if (parsed.stageId !== void 0 && parsed.stageId !== null && (typeof parsed.stageId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(parsed.stageId))) {
    throw new Error("recovery envelope stage identity is invalid");
  }
  if (parsed.activeMessageIds !== void 0 && !validBoundedStrings(parsed.activeMessageIds, 3, recoveryMessageId)) {
    throw new Error("recovery envelope active messages are invalid");
  }
  if (parsed.pendingMessageIds !== void 0 && !validBoundedStrings(parsed.pendingMessageIds, 16, recoveryMessageId)) {
    throw new Error("recovery envelope pending messages are invalid");
  }
  if (parsed.artifactPointers !== void 0 && !validBoundedStrings(parsed.artifactPointers, 16)) {
    throw new Error("recovery envelope artifact pointers are invalid");
  }
  if (parsed.failureClass !== void 0 && parsed.failureClass !== "quota" && parsed.failureClass !== "provider_error" && parsed.failureClass !== "timeout") {
    throw new Error("recovery envelope failure class is invalid");
  }
  if (parsed.signal !== void 0 && (typeof parsed.signal !== "string" || parsed.signal.length > 64 || /[\0\r\n]/.test(parsed.signal))) {
    throw new Error("recovery envelope signal is invalid");
  }
  if (parsed.sessionBinding !== void 0) {
    const binding = parsed.sessionBinding;
    if (!binding || typeof binding !== "object" || binding.kind === "default" && Object.keys(binding).some((key) => key !== "kind") || binding.kind === "workflow" && !recoveryRunId.test(binding.runId) || binding.kind !== "default" && binding.kind !== "workflow") throw new Error("recovery envelope session binding is invalid");
  }
  return parsed;
}
function findWorkerRecoveryEnvelope(stateDir, agentName, project) {
  const candidates = project ? [
    { path: recoveryEnvelopePath(stateDir, agentName, project), quarantineInvalid: true },
    { path: legacyRecoveryEnvelopePath(stateDir, agentName), quarantineInvalid: false }
  ] : [{ path: legacyRecoveryEnvelopePath(stateDir, agentName), quarantineInvalid: false }];
  for (const candidate of candidates) {
    try {
      const stats = lstatSync(candidate.path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 128 * 1024) {
        throw new Error("recovery envelope is not a bounded regular file");
      }
      const envelope = parseRecoveryEnvelope(JSON.parse(readFileSync(candidate.path, "utf8")), agentName, project);
      return { envelope, path: candidate.path };
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (candidate.quarantineInvalid) {
        try {
          renameSync(candidate.path, `${candidate.path}.corrupt-${Date.now()}`);
        } catch {
        }
      }
    }
  }
  return void 0;
}
async function consumeWorkerRecoveryEnvelope(client, stateDir, agentName, project) {
  const found = findWorkerRecoveryEnvelope(stateDir, agentName, project);
  if (!found) return void 0;
  const { envelope, path } = found;
  let runId = envelope.runId ?? void 0;
  let stageId = envelope.stageId ?? void 0;
  let scopeMismatch = false;
  if (envelope.sessionBinding) {
    const boundRunId = envelope.sessionBinding.kind === "workflow" ? envelope.sessionBinding.runId : void 0;
    if (runId !== boundRunId) {
      scopeMismatch = true;
      runId = void 0;
      stageId = void 0;
    }
  }
  if (!runId) {
    rmSync(path, { force: true });
    return scopeMismatch ? { ...envelope, runId: null, stageId: null } : envelope;
  }
  const providerRecovery = envelope.reason === "provider_error";
  const diagnostic = classifyFailure({
    toolName: providerRecovery ? "provider" : envelope.reason === "tool_timeout" ? "tool" : "kxm_await",
    ...providerRecovery ? { code: envelope.failureClass === "quota" ? "provider_quota" : "provider_error" } : envelope.reason === "tool_timeout" ? {} : { code: "unresumable_session" },
    message: envelope.reason === "tool_timeout" ? "timed out" : envelope.reason
  });
  try {
    await client.recordWorkflowEntry(runId, {
      category: "error",
      area: "harness",
      severity: "error",
      summary: `Worker recovered with ${envelope.reason}`,
      evidence: [
        ...diagnosticEvidence(diagnostic),
        `recovery:v1`,
        `reason:${envelope.reason}`,
        ...envelope.sessionBinding?.kind === "workflow" ? [`session-scope:${envelope.sessionBinding.runId}`] : [],
        ...stageId ? [`stage:${stageId}`] : [],
        ...(envelope.pendingMessageIds ?? []).slice(0, 8).map((id) => `message:${id}`),
        ...(envelope.artifactPointers ?? []).slice(0, 16).map((pointer) => pointer.startsWith("artifact:") ? pointer : `artifact:${pointer}`)
      ]
    });
    rmSync(path, { force: true });
    return { ...envelope, runId, ...stageId ? { stageId } : {} };
  } catch (error) {
    if (error instanceof HubHttpError && error.statusCode === 403 && error.code === "workflow_forbidden") {
      rmSync(path, { force: true });
      return { ...envelope, runId, ...stageId ? { stageId } : {}, peerLocal: true };
    }
    return void 0;
  }
}

// plugins/kxm/src/session-work.ts
import { spawnSync } from "node:child_process";

// plugins/kxm/src/local-snapshot.ts
import { existsSync, readdirSync, readFileSync as readFileSync2 } from "node:fs";
import { join as join2, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function readJsonRows(database, sql) {
  const rows = database.prepare(sql).all();
  const out = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.record));
    } catch {
    }
  }
  return out;
}
var DONE_STAGE_STATUSES = /* @__PURE__ */ new Set(["passed", "failed", "warning"]);
function summarizeMeshRun(run) {
  const stages = (run.stages ?? []).map((stage) => ({
    id: stage.id,
    ...stage.label ? { label: stage.label } : {},
    status: stage.status,
    ...stage.attempts ? { attempts: stage.attempts } : {}
  }));
  const total = stages.length;
  const done = stages.filter((stage) => DONE_STAGE_STATUSES.has(stage.status)).length;
  return {
    id: run.id,
    status: run.status,
    definitionId: run.definitionId,
    project: run.project,
    ...run.currentStage ? { currentStage: run.currentStage } : {},
    ...run.targetAgentName ? { targetAgentName: run.targetAgentName } : {},
    ...run.updatedAt ? { updatedAt: run.updatedAt } : {},
    ...total > 0 ? { progress: { done, total }, stages } : {}
  };
}
function summarizeMeshPlan(entry) {
  if (entry.category && entry.category !== "plan") return void 0;
  const summary = entry.summary.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!summary) return void 0;
  return {
    id: entry.id,
    runId: entry.runId,
    summary,
    createdAt: entry.createdAt,
    ...entry.stageId ? { stageId: entry.stageId } : {},
    ...entry.severity ? { severity: entry.severity } : {}
  };
}
function readPlanMetadata(database) {
  try {
    const rows = database.prepare(`
      SELECT record FROM workflow_journal
      WHERE category = 'plan'
      ORDER BY rowid DESC
      LIMIT 16
    `).all();
    const plans = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.record);
        if (typeof parsed.id !== "string" || typeof parsed.runId !== "string" || typeof parsed.summary !== "string" || typeof parsed.createdAt !== "string") continue;
        const plan = summarizeMeshPlan({
          id: parsed.id,
          runId: parsed.runId,
          summary: parsed.summary,
          createdAt: parsed.createdAt,
          ...parsed.category ? { category: parsed.category } : {},
          ...parsed.stageId ? { stageId: parsed.stageId } : {},
          ...parsed.severity ? { severity: parsed.severity } : {}
        });
        if (plan) plans.push(plan);
      } catch {
      }
    }
    return plans;
  } catch {
    return [];
  }
}
function countRows(database, table, where = "") {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`).get();
  return Number(row?.count ?? 0);
}
function readOpenMessageMetadata(database) {
  const rows = database.prepare(`
    SELECT
      json_extract(record, '$.id') AS id,
      json_extract(record, '$.status') AS status,
      COALESCE(json_extract(record, '$.fromName'), json_extract(record, '$.from')) AS fromName,
      COALESCE(json_extract(record, '$.toName'), json_extract(record, '$.to')) AS toName,
      json_extract(record, '$.delivery') AS delivery,
      json_extract(record, '$.createdAt') AS createdAt,
      json_extract(record, '$.correlationId') AS correlationId
    FROM messages
    WHERE json_extract(record, '$.status') IN ('queued', 'delivered')
    ORDER BY json_extract(record, '$.createdAt') DESC
    LIMIT 16
  `).all();
  const messages = [];
  for (const row of rows) {
    if (typeof row.id !== "string" || row.status !== "queued" && row.status !== "delivered" || typeof row.fromName !== "string" || typeof row.toName !== "string" || row.delivery !== "steer" && row.delivery !== "followUp" && row.delivery !== "nextTurn" || typeof row.createdAt !== "string") continue;
    messages.push({
      id: row.id,
      status: row.status,
      fromName: row.fromName,
      toName: row.toName,
      delivery: row.delivery,
      createdAt: row.createdAt,
      ...typeof row.correlationId === "string" ? { correlationId: row.correlationId } : {}
    });
  }
  return messages;
}
function resolveKxmSnapshotPaths(cwd, env = process.env) {
  const stateDir = env.KXM_STATE_DIR?.trim() || join2(cwd, ".kxm", "state");
  const configured = env.KXM_DATA_PATH?.trim();
  const dataPath = configured ? resolve(cwd, configured) : join2(stateDir, "kxm.db");
  return { dataPath, stateDir };
}
function loadLocalMeshSnapshot(dataPath, stateDir) {
  let agents = [];
  let openMessages = [];
  let openMessageTotal = 0;
  let runs = [];
  let runTotal = 0;
  let plans = [];
  if (existsSync(dataPath)) {
    const database = new DatabaseSync(dataPath, { readOnly: true });
    try {
      agents = readJsonRows(database, "SELECT record FROM agents");
      openMessages = readOpenMessageMetadata(database);
      openMessageTotal = countRows(database, "messages", " WHERE json_extract(record, '$.status') IN ('queued', 'delivered')");
      runs = readJsonRows(database, "SELECT record FROM workflow_runs ORDER BY rowid DESC LIMIT 8");
      runTotal = countRows(database, "workflow_runs");
      plans = readPlanMetadata(database);
    } finally {
      database.close();
    }
  }
  const pids = [];
  if (existsSync(stateDir)) {
    for (const file of readdirSync(stateDir).filter((name) => name.endsWith(".pid"))) {
      try {
        const record = JSON.parse(readFileSync2(join2(stateDir, file), "utf8"));
        pids.push({
          file,
          ...record.role ? { role: record.role } : {},
          ...record.pid !== void 0 ? { pid: record.pid } : {},
          live: Number.isInteger(record.pid) && record.pid > 0 && processExists(record.pid)
        });
      } catch {
        pids.push({ file, live: false });
      }
    }
  }
  return {
    agents: agents.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
    openMessages,
    openMessageTotal,
    runs: runs.map((run) => summarizeMeshRun(run)),
    runTotal,
    plans,
    pids
  };
}

// plugins/kxm/src/kxm-update.ts
import { existsSync as existsSync2, readFileSync as readFileSync3, writeFileSync, mkdirSync } from "node:fs";
import { join as join3 } from "node:path";
var KXM_UPDATE_CACHE = "update-check.json";
var CACHE_TTL_MS = 6 * 60 * 60 * 1e3;
function readUpdateCache(stateDir, now = Date.now()) {
  const path = join3(stateDir, KXM_UPDATE_CACHE);
  if (!existsSync2(path)) return void 0;
  try {
    const row = JSON.parse(readFileSync3(path, "utf8"));
    if (typeof row.checkedAt !== "number" || !row.notice || now - row.checkedAt > CACHE_TTL_MS) return void 0;
    if (typeof row.notice.current !== "string" || typeof row.notice.available !== "boolean") return void 0;
    return row.notice;
  } catch {
    return void 0;
  }
}

// plugins/kxm/src/session-work.ts
var SESSION_BRIEF_SKIP_LABEL = "Skip \u2014 start a fresh session";
var MAX_SESSION_BRIEF_TASKS = 5;
var MAX_SESSION_BRIEF_PLANS = 5;
function hubPrefix(hub) {
  if (hub?.online === true) return "kxm hub:on";
  if (hub?.online === false) return "kxm hub:off";
  return "kxm";
}
function truncate(value, width) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}\u2026`;
}
function uniqueLabels(items) {
  const seen = /* @__PURE__ */ new Set();
  return items.map((item) => {
    let label = item.label;
    if (seen.has(label)) label = truncate(`${label} \xB7 ${item.id.slice(-6)}`, 72);
    seen.add(label);
    return label === item.label ? item : { ...item, label };
  });
}
function taskItem(run) {
  const stage = run.currentStage ?? "-";
  const progress = run.progress ? ` ${run.progress.done}/${run.progress.total}` : "";
  const detail = `${run.definitionId}/${stage}${progress}`.trim();
  const label = truncate(`Task  ${run.definitionId}  ${run.status}  ${stage}${progress}`, 72);
  const prompt = `Continue KXM task \`${run.definitionId}\` (run ${run.id}) at stage ${stage}${run.progress ? ` (${run.progress.done}/${run.progress.total})` : ""}. Load the run, then proceed without repeating completed work.`;
  return { kind: "task", id: run.id, runId: run.id, label, detail, prompt };
}
function planItem(plan) {
  const label = truncate(`Plan  ${plan.summary}`, 72);
  const prompt = `Continue from KXM plan: ${plan.summary} (run ${plan.runId}). Load that run and proceed.`;
  return { kind: "plan", id: plan.id, runId: plan.runId, label, detail: plan.summary, prompt };
}
function recentTasks(runs) {
  const active = runs.filter((run) => run.status === "running" || run.status === "waiting");
  const rest = runs.filter((run) => run.status !== "running" && run.status !== "waiting");
  return [...active, ...rest].slice(0, MAX_SESSION_BRIEF_TASKS);
}
function formatShipLine(ship) {
  if (!ship) return "ship verify \xB7 PR=CI";
  if (ship.dirty) return "ship dirty \xB7 commit after verify";
  if (ship.ahead > 0) return `ship ${ship.ahead} local \xB7 PR after CI`;
  return "ship clean \xB7 PR after CI";
}
function readGitShip(cwd) {
  try {
    const dirty = spawnSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8", windowsHide: true });
    if (dirty.status !== 0) return void 0;
    const ahead = spawnSync("git", ["-C", cwd, "rev-list", "--count", "@{u}..HEAD"], { encoding: "utf8", windowsHide: true });
    return {
      dirty: dirty.stdout.trim().length > 0,
      ahead: ahead.status === 0 ? Number.parseInt(ahead.stdout.trim(), 10) || 0 : 0
    };
  } catch {
    return void 0;
  }
}
function formatSessionStatusLine(stats, current, hub, ship, updateLatest) {
  const head = hubPrefix(hub);
  if (!current && stats.activeTasks === 0 && stats.planCount === 0 && stats.inbox === 0) {
    const idle = hub?.online === void 0 ? "kxm idle" : `${head} \xB7 idle`;
    const withShip = ship?.dirty ? `${idle} \xB7 dirty` : idle;
    return updateLatest ? `${withShip} \xB7 upd ${updateLatest}` : withShip;
  }
  const parts = [];
  if (current?.kind === "task") parts.push(`${head} ${current.detail}`);
  else if (current?.kind === "plan") parts.push(`${head} plan ${truncate(current.detail, 36)}`);
  else parts.push(head);
  parts.push(`${stats.activeTasks} task${stats.activeTasks === 1 ? "" : "s"}`);
  if (stats.waitingTasks > 0) parts.push(`${stats.waitingTasks} waiting`);
  parts.push(`${stats.planCount} plan${stats.planCount === 1 ? "" : "s"}`);
  if (stats.inbox > 0) parts.push(`inbox ${stats.inbox}`);
  if (ship?.dirty) parts.push("dirty");
  else if (ship && ship.ahead > 0) parts.push(`${ship.ahead} local`);
  if (updateLatest) parts.push(`upd ${updateLatest}`);
  const line = parts.join(" \xB7 ");
  return line.length <= 80 ? line : `${line.slice(0, 79)}\u2026`;
}
function formatSessionWidget(stats, current, hub, ship, updateLatest) {
  const hubMark = hub?.online === true ? "hub:on  " : hub?.online === false ? "hub:off  " : "";
  const lines = [
    `KXM  ${hubMark}${stats.activeTasks} tasks  ${stats.waitingTasks} waiting  ${stats.planCount} plans  inbox ${stats.inbox}`
  ];
  if (current) lines.push(`now  ${current.kind}  ${truncate(current.detail, 56)}`);
  else if (stats.latestPlan) lines.push(`plan ${truncate(stats.latestPlan, 60)}`);
  else lines.push("now  no selected work");
  lines.push(formatShipLine(ship));
  if (updateLatest) lines.push(`update  ${updateLatest} available \xB7 kxm update --kxm`);
  return lines;
}
function buildSessionBrief(snapshot, current, hub, ship, updateLatest) {
  const active = snapshot.runs.filter((run) => run.status === "running" || run.status === "waiting");
  const stats = {
    activeTasks: active.length,
    waitingTasks: snapshot.runs.filter((run) => run.status === "waiting").length,
    planCount: snapshot.plans.length,
    inbox: snapshot.openMessageTotal,
    runTotal: snapshot.runTotal,
    ...snapshot.plans[0]?.summary ? { latestPlan: snapshot.plans[0].summary } : {}
  };
  const tasks = uniqueLabels(recentTasks(snapshot.runs).map(taskItem));
  const plans = uniqueLabels(snapshot.plans.slice(0, MAX_SESSION_BRIEF_PLANS).map(planItem));
  return {
    stats,
    tasks,
    plans,
    statusLine: formatSessionStatusLine(stats, current, hub, ship, updateLatest),
    widgetLines: formatSessionWidget(stats, current, hub, ship, updateLatest)
  };
}
function sessionBriefChoices(brief) {
  return [SESSION_BRIEF_SKIP_LABEL, ...brief.tasks.map((item) => item.label), ...brief.plans.map((item) => item.label)];
}
function itemFromChoice(brief, choice) {
  if (!choice || choice === SESSION_BRIEF_SKIP_LABEL) return void 0;
  return [...brief.tasks, ...brief.plans].find((item) => item.label === choice);
}
function loadSessionBrief(cwd, env = process.env, current, hub) {
  const ship = readGitShip(cwd);
  try {
    const paths = resolveKxmSnapshotPaths(cwd, env);
    const cached = readUpdateCache(paths.stateDir);
    const updateLatest = cached?.available ? cached.latest : void 0;
    return buildSessionBrief(loadLocalMeshSnapshot(paths.dataPath, paths.stateDir), current, hub, ship, updateLatest);
  } catch {
    return buildSessionBrief({ runs: [], plans: [], openMessageTotal: 0, runTotal: 0 }, current, hub, ship);
  }
}
function sessionBriefPickerEnabled(input) {
  if (input.env?.KXM_SESSION_BRIEF?.trim() === "off") return false;
  if (input.mode !== "tui") return false;
  const reason = input.reason ?? "startup";
  return reason === "startup" || reason === "new" || reason === "fork";
}
var KXM_SLASH_SUBCOMMANDS = ["status", "hub", "help"];
function parseKxmSlashArgs(args) {
  const raw = String(args ?? "").trim().toLowerCase();
  if (raw === "" || raw === "brief") return "brief";
  if (raw === "status" || raw === "hub" || raw === "help") return raw;
  return "help";
}
function kxmSlashCompletions(prefix) {
  const p = prefix.trim().toLowerCase();
  return KXM_SLASH_SUBCOMMANDS.filter((name) => name.startsWith(p)).map((name) => ({ value: name, label: name }));
}

// plugins/kxm/src/extension.ts
var SETTLEMENT_RETRY_BASE_MS = 250;
var SETTLEMENT_RETRY_MAX_MS = 3e4;
function boundedPeerReply(reply) {
  if (reply.length <= MAX_CONTENT_CHARS) return reply;
  const suffix = `

[kxm: response truncated from ${reply.length} characters to fit the message limit; the full output may remain in the replying agent's local session or worker log]`;
  return reply.slice(0, MAX_CONTENT_CHARS - suffix.length) + suffix;
}
function isTerminalMessage(message) {
  return message.status === "replied" || message.status === "cancelled" || message.status === "expired" || message.status === "error";
}
function isTerminalMessageError(error) {
  return error instanceof HubHttpError && (error.statusCode === 409 || error.statusCode === 404 && error.code === "message_not_found");
}
var WORKFLOW_RUN_ID = /^run_[a-f0-9]{32}$/;
var PI_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function workflowRunIdForMessage(message) {
  if (message.workflowRunId !== void 0) {
    if (!WORKFLOW_RUN_ID.test(message.workflowRunId)) return void 0;
    if (message.workflowContext?.runId && message.workflowContext.runId !== message.workflowRunId) return void 0;
    return message.workflowRunId;
  }
  if (message.workflowContext?.runId && WORKFLOW_RUN_ID.test(message.workflowContext.runId)) {
    return message.workflowContext.runId;
  }
  if (message.correlationId && WORKFLOW_RUN_ID.test(message.correlationId) && message.from === `workflow:${message.correlationId}`) return message.correlationId;
  return void 0;
}
function bindingForMessage(message) {
  const runId = workflowRunIdForMessage(message);
  if (message.workflowRunId !== void 0 && !runId) {
    throw new Error("hub workflow affinity is malformed or conflicts with workflow context");
  }
  if (message.workflowContext?.runId && !WORKFLOW_RUN_ID.test(message.workflowContext.runId)) {
    throw new Error("hub workflow context contains a malformed run identity");
  }
  return runId ? { kind: "workflow", runId } : { kind: "default" };
}
function bindingFromEnvironment() {
  if (process.env.KXM_WORKER_SESSION_ISOLATION !== "workflow") return { kind: "default" };
  const scope = process.env.KXM_WORKER_SESSION_SCOPE?.trim();
  if (scope === "default") return { kind: "default" };
  if (scope?.startsWith("workflow:")) {
    const runId = scope.slice("workflow:".length);
    if (WORKFLOW_RUN_ID.test(runId)) return { kind: "workflow", runId };
  }
  throw new Error("KXM_WORKER_SESSION_SCOPE must be default or workflow:<canonical-run-id>");
}
function sameBinding(left, right) {
  return left.kind === right.kind && (left.kind === "default" || right.kind === "workflow" && left.runId === right.runId);
}
function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value
  };
}
function latestAssistantMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return messages[index];
  }
  return void 0;
}
function assistantText(messages) {
  const message = latestAssistantMessage(messages);
  if (!message) return void 0;
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return void 0;
  const text = message.content.map((item) => {
    const part = item;
    return part.type === "text" ? part.text ?? "" : "";
  }).join("").trim();
  return text || void 0;
}
function assistantFailure(messages) {
  const message = latestAssistantMessage(messages);
  if (!message || message.stopReason !== "error" && message.stopReason !== "aborted") return void 0;
  if (message.stopReason === "aborted") {
    return classifyFailure({
      toolName: "provider",
      message: "cancelled"
    });
  }
  const failureMessage = typeof message.errorMessage === "string" ? message.errorMessage : "provider error";
  const quota = /\b(quota reached|quota exceeded|rate limit(?:ed)?|too many requests|resource exhausted|http 429)\b/i.test(failureMessage);
  return classifyFailure({
    toolName: "provider",
    code: quota ? "provider_quota" : "provider_error",
    message: failureMessage
  });
}
function piMeshExtension(pi) {
  let client;
  let pending = [];
  let activatingInbound;
  let awaitingActivation;
  let activeInbound;
  let activationInProgress = false;
  let activationPromise;
  let activationRetryTimer;
  let activationRetryAttempt = 0;
  let activationStartTimer;
  let activationStartMessageId;
  let requestWorkerRestart;
  let activeReply;
  let settlementReply;
  let activeTurnSettled = false;
  let settlementInProgress = false;
  let settlementRetryAttempt = 0;
  let settlementRetryTimer;
  let activeFailure;
  let activeFailureRecorded = false;
  let shuttingDown = false;
  let notify;
  let stateDir = process.env.KXM_STATE_DIR ?? "";
  let agentName = process.env.KXM_AGENT_NAME ?? "";
  let projectName = process.env.KXM_PROJECT ?? "";
  let recoveryStageId;
  let recoveryArtifacts = [];
  let currentPiSessionId;
  let currentSessionBinding = { kind: "default" };
  function recoveryContextPath() {
    if (!stateDir || !agentName || !projectName) return void 0;
    return join4(stateDir, `worker-context-${workerStateKey(projectName, agentName)}.json`);
  }
  function sessionRouteRequestPath() {
    const workerKey = process.env.KXM_WORKER_IDENTITY_KEY?.trim();
    if (!stateDir || !workerKey) return void 0;
    return join4(stateDir, `worker-session-request-${workerKey}.json`);
  }
  function requestSessionRoute(message, target) {
    if (process.env.KXM_WORKER_SESSION_ISOLATION !== "workflow" || sameBinding(currentSessionBinding, target)) {
      return false;
    }
    const path = sessionRouteRequestPath();
    const workerKey = process.env.KXM_WORKER_IDENTITY_KEY?.trim();
    const generation = process.env.KXM_WORKER_GENERATION?.trim();
    const childIncarnation = Number(process.env.KXM_WORKER_CHILD_INCARCATION);
    if (!path || !workerKey || !generation || !Number.isInteger(childIncarnation) || childIncarnation < 1 || !currentPiSessionId || !PI_SESSION_ID.test(currentPiSessionId)) {
      throw new Error("supervised workflow session routing is missing a valid worker generation, child incarnation, or Pi session identity");
    }
    const request = {
      version: 1,
      agentName,
      project: projectName,
      workerKey,
      generation,
      childIncarnation,
      from: currentSessionBinding,
      to: target,
      sourceSessionId: currentPiSessionId,
      messageId: message.id,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    mkdirSync2(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync2(tmp, `${JSON.stringify(request)}
`, { encoding: "utf8", mode: 384 });
    renameSync2(tmp, path);
    return true;
  }
  function removeMatchingLegacyRecoveryContext() {
    if (!stateDir || !agentName || !projectName) return;
    const legacy = join4(stateDir, `worker-context-${agentName.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
    if (legacy === recoveryContextPath()) return;
    try {
      const candidate = JSON.parse(readFileSync4(legacy, "utf8"));
      if (candidate.version === 1 && candidate.agentName === agentName && candidate.project === projectName) {
        rmSync2(legacy, { force: true });
      }
    } catch {
    }
  }
  function persistRecoveryContext() {
    const path = recoveryContextPath();
    if (!path) return;
    const recoveryMessage = [activeInbound, awaitingActivation, activatingInbound].find((message) => message && workflowRunIdForMessage(message));
    const runId = recoveryMessage ? workflowRunIdForMessage(recoveryMessage) : void 0;
    const activeMessageIds = [activeInbound?.id, awaitingActivation?.id, activatingInbound?.id].filter((id) => Boolean(id)).slice(0, 3);
    const pendingMessageIds = [...activeMessageIds, ...pending.map((message) => message.id)].filter((id, index, values) => Boolean(id) && values.indexOf(id) === index).slice(0, 16);
    if (!runId && pendingMessageIds.length === 0) {
      rmSync2(path, { force: true });
      removeMatchingLegacyRecoveryContext();
      return;
    }
    mkdirSync2(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync2(tmp, `${JSON.stringify({ version: 1, agentName, project: projectName, runId: runId ?? null, stageId: recoveryStageId ?? null, activeMessageIds, pendingMessageIds, artifactPointers: recoveryArtifacts.slice(0, 16), updatedAt: (/* @__PURE__ */ new Date()).toISOString() })}
`, { encoding: "utf8", mode: 384 });
    renameSync2(tmp, path);
    removeMatchingLegacyRecoveryContext();
  }
  async function workflowCall(operation) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof HubHttpError)) throw error;
      const assigned = typeof error.extras?.assignedCoordinatorName === "string" ? ` assignedCoordinator=${error.extras.assignedCoordinatorName}` : "";
      const nextAction = typeof error.extras?.nextAction === "string" ? ` nextAction=${error.extras.nextAction}` : "";
      const operationName = typeof error.extras?.operation === "string" ? ` operation=${error.extras.operation}` : "";
      throw new Error(`${error.message} [code=${error.code ?? "http_error"}${operationName}${assigned}${nextAction}]`);
    }
  }
  function requireClient() {
    if (!client?.agent) throw new Error("kxm hub is not connected; check KXM_SERVER_URL and /kxm hub");
    return client;
  }
  let currentWork;
  async function applySessionChrome(ctx, event, offerPicker) {
    const cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
    const hub = process.env.KXM_SERVER_URL?.trim() ? { online: Boolean(client?.agent) } : void 0;
    const brief = loadSessionBrief(cwd, process.env, currentWork, hub);
    ctx.ui.setStatus?.("kxm", brief.statusLine);
    ctx.ui.setWidget?.("kxm-work", brief.widgetLines);
    if (!offerPicker || !sessionBriefPickerEnabled({
      env: process.env,
      ...ctx.mode ? { mode: ctx.mode } : {},
      ...event.reason ? { reason: event.reason } : {}
    })) return;
    if (brief.tasks.length === 0 && brief.plans.length === 0) return;
    if (typeof ctx.ui.select !== "function") return;
    const choice = await ctx.ui.select("Continue KXM work?", sessionBriefChoices(brief));
    const item = itemFromChoice(brief, choice);
    if (!item) return;
    currentWork = item;
    const selected = loadSessionBrief(cwd, process.env, item, hub);
    ctx.ui.setStatus?.("kxm", selected.statusLine);
    ctx.ui.setWidget?.("kxm-work", selected.widgetLines);
    ctx.ui.setEditorText?.(item.prompt);
  }
  async function showKxmHub(ctx) {
    const url = (process.env.KXM_SERVER_URL ?? "http://127.0.0.1:7331").replace(/\/$/, "");
    let health = "unreachable";
    try {
      const response = await fetch(`${url}/health`);
      health = response.ok ? "ok" : `http_${response.status}`;
    } catch {
      health = "unreachable";
    }
    if (!client?.agent) {
      ctx.ui.notify(`kxm hub view: health=${health}; no agent connected`, "warning");
      return;
    }
    const peers = await client.listAgents();
    ctx.ui.notify(`kxm hub view: health=${health}; ${client.agent.name}; ${peers.length} online agent(s)`, "info");
  }
  function clearActivationWatchdog(messageId) {
    if (messageId && activationStartMessageId !== messageId) return;
    if (activationStartTimer) clearTimeout(activationStartTimer);
    activationStartTimer = void 0;
    activationStartMessageId = void 0;
  }
  function startActivationWatchdog(messageId) {
    clearActivationWatchdog();
    if (!process.env.KXM_WORKER_IDENTITY_KEY) return;
    const configured = Number(process.env.KXM_WORKER_ACTIVATION_TIMEOUT_MS?.trim() || 6e4);
    const timeoutMs = Number.isInteger(configured) && configured >= 1e3 && configured <= 6e5 ? configured : 6e4;
    activationStartMessageId = messageId;
    activationStartTimer = setTimeout(() => {
      activationStartTimer = void 0;
      if (shuttingDown || activeInbound || awaitingActivation?.id !== messageId) return;
      notify?.(
        `kxm worker is stuck: delivered message ${messageId} did not start a model turn within ${timeoutMs}ms; requesting supervised restart`,
        "error"
      );
      persistRecoveryContext();
      requestWorkerRestart?.();
    }, timeoutMs);
    activationStartTimer.unref?.();
  }
  function enqueue(message, front = false) {
    if (front) {
      pending.unshift(message);
      return;
    }
    const priority = (delivery) => delivery === "steer" ? 0 : delivery === "followUp" ? 1 : 2;
    const messagePriority = priority(message.delivery);
    const firstLowerPriority = pending.findIndex((candidate) => priority(candidate.delivery) > messagePriority);
    if (firstLowerPriority < 0) pending.push(message);
    else pending.splice(firstLowerPriority, 0, message);
  }
  function requestActivation() {
    if (activationPromise || shuttingDown) return;
    const task = activateNext();
    activationPromise = task;
    void task.finally(() => {
      if (activationPromise === task) activationPromise = void 0;
      if (!shuttingDown && !activationRetryTimer && !activatingInbound && !awaitingActivation && !activeInbound && pending.length > 0) requestActivation();
    });
  }
  function scheduleActivationRetry(error) {
    if (shuttingDown || activationRetryTimer) return;
    const delayMs = Math.min(
      SETTLEMENT_RETRY_BASE_MS * 2 ** Math.min(activationRetryAttempt, 7),
      SETTLEMENT_RETRY_MAX_MS
    );
    activationRetryAttempt += 1;
    notify?.(
      `kxm could not activate the next hub message; it remains durable and activation will retry in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`,
      "error"
    );
    activationRetryTimer = setTimeout(() => {
      activationRetryTimer = void 0;
      requestActivation();
    }, delayMs);
    activationRetryTimer.unref?.();
  }
  async function activateNext() {
    if (shuttingDown || !client || activationInProgress || activationRetryTimer || activatingInbound || awaitingActivation || activeInbound) return;
    activationInProgress = true;
    try {
      let message = pending.shift();
      while (message && (isTerminalMessage(message) || Date.parse(message.expiresAt) <= Date.now())) {
        message = pending.shift();
      }
      if (!message) {
        persistRecoveryContext();
        return;
      }
      try {
        const targetBinding = bindingForMessage(message);
        if (requestSessionRoute(message, targetBinding)) {
          enqueue(message, true);
          persistRecoveryContext();
          shuttingDown = true;
          queueMicrotask(() => requestWorkerRestart?.());
          return;
        }
      } catch (error) {
        enqueue(message, true);
        persistRecoveryContext();
        scheduleActivationRetry(error);
        return;
      }
      activatingInbound = message;
      persistRecoveryContext();
      let acknowledged;
      try {
        acknowledged = await client.acknowledge(message.id);
      } catch (error) {
        if (isTerminalMessageError(error)) {
          activatingInbound = void 0;
          activationRetryAttempt = 0;
          persistRecoveryContext();
          return;
        }
        if (activatingInbound?.id === message.id) {
          activatingInbound = void 0;
          enqueue(message, true);
          persistRecoveryContext();
        }
        scheduleActivationRetry(error);
        return;
      }
      if (activatingInbound?.id !== message.id || shuttingDown) return;
      activationRetryAttempt = 0;
      activatingInbound = void 0;
      awaitingActivation = acknowledged;
      persistRecoveryContext();
      startActivationWatchdog(acknowledged.id);
      try {
        pi.sendMessage({
          customType: "kxm-inbound",
          content: [
            `Peer request from ${acknowledged.fromName} (message ${acknowledged.id}):`,
            "",
            acknowledged.content,
            "",
            "Respond directly to the peer request. Your settled final response will be returned automatically."
          ].join("\n"),
          display: true,
          details: { messageId: acknowledged.id, from: acknowledged.fromName }
        }, {
          // Pi's nextTurn mode deliberately waits for a future human prompt. An
          // autonomous worker has no such prompt, so its durable next item is
          // normalized to an immediately-triggered follow-up turn.
          triggerTurn: true,
          deliverAs: acknowledged.delivery === "nextTurn" ? "followUp" : acknowledged.delivery
        });
      } catch (error) {
        clearActivationWatchdog(acknowledged.id);
        awaitingActivation = void 0;
        enqueue(acknowledged, true);
        persistRecoveryContext();
        scheduleActivationRetry(error);
      }
    } finally {
      activationInProgress = false;
    }
  }
  async function receive(event) {
    if (shuttingDown) return;
    if (event.type === "message") {
      if (activeInbound?.id === event.message.id || awaitingActivation?.id === event.message.id || activatingInbound?.id === event.message.id) return;
      if (pending.some((message) => message.id === event.message.id)) {
        requestActivation();
        return;
      }
      if (isTerminalMessage(event.message) || Date.parse(event.message.expiresAt) <= Date.now()) return;
      if (shuttingDown) return;
      enqueue(event.message);
      persistRecoveryContext();
      requestActivation();
      return;
    }
    if (event.type !== "cancelled" && event.type !== "expired" && event.type !== "reply") return;
    const messageId = event.message.id;
    const pendingLength = pending.length;
    pending = pending.filter((message) => message.id !== messageId);
    let changed = pending.length !== pendingLength;
    if (activatingInbound?.id === messageId) {
      activatingInbound = void 0;
      changed = true;
    }
    if (awaitingActivation?.id === messageId) {
      clearActivationWatchdog(messageId);
      awaitingActivation = void 0;
      changed = true;
    }
    if (activeInbound?.id === messageId) {
      activeInbound = event.message;
      changed = true;
    }
    if (!changed) return;
    persistRecoveryContext();
    if (activeInbound?.id === messageId && activeTurnSettled && !settlementInProgress) {
      finishActiveInbound(messageId);
      return;
    }
    requestActivation();
  }
  function finishActiveInbound(messageId) {
    if (activeInbound?.id !== messageId) return;
    if (settlementRetryTimer) clearTimeout(settlementRetryTimer);
    settlementRetryTimer = void 0;
    settlementRetryAttempt = 0;
    clearActivationWatchdog(messageId);
    activeInbound = void 0;
    activeReply = void 0;
    settlementReply = void 0;
    activeTurnSettled = false;
    activeFailure = void 0;
    activeFailureRecorded = false;
    recoveryStageId = void 0;
    recoveryArtifacts = [];
    persistRecoveryContext();
    if (!shuttingDown) requestActivation();
  }
  function scheduleSettlementRetry(messageId, error) {
    if (shuttingDown || !client || activeInbound?.id !== messageId || settlementRetryTimer) return;
    const delayMs = Math.min(
      SETTLEMENT_RETRY_BASE_MS * 2 ** Math.min(settlementRetryAttempt, 7),
      SETTLEMENT_RETRY_MAX_MS
    );
    settlementRetryAttempt += 1;
    persistRecoveryContext();
    notify?.(
      `kxm could not return reply for ${messageId}; recovery state was retained and settlement will retry in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`,
      "error"
    );
    settlementRetryTimer = setTimeout(() => {
      settlementRetryTimer = void 0;
      void settleActiveInbound(messageId);
    }, delayMs);
    settlementRetryTimer.unref?.();
  }
  async function settleActiveInbound(messageId) {
    if (!activeInbound || activeInbound.id !== messageId || !client || settlementInProgress) return;
    settlementInProgress = true;
    const message = activeInbound;
    const activeClient = client;
    const reply = settlementReply ?? boundedPeerReply(activeReply ?? "The peer agent completed without a textual response.");
    try {
      let current;
      try {
        current = await activeClient.getMessage(message.id);
      } catch (error) {
        if (isTerminalMessageError(error)) {
          finishActiveInbound(message.id);
          return;
        }
        throw error;
      }
      if (isTerminalMessage(current)) {
        finishActiveInbound(message.id);
        return;
      }
      await activeClient.reply(message.id, reply);
      finishActiveInbound(message.id);
    } catch (error) {
      if (isTerminalMessageError(error)) {
        finishActiveInbound(message.id);
        return;
      }
      scheduleSettlementRetry(message.id, error);
    } finally {
      settlementInProgress = false;
    }
  }
  pi.on("session_start", async (event, ctx) => {
    shuttingDown = false;
    await client?.stop();
    client = void 0;
    try {
      currentSessionBinding = bindingFromEnvironment();
    } catch (error) {
      ctx.ui.setStatus("kxm", "kxm hub:off");
      ctx.ui.notify(`kxm session routing configuration failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      void ctx.shutdown();
      return;
    }
    currentPiSessionId = ctx.sessionManager?.getSessionId();
    const serverUrl = process.env.KXM_SERVER_URL ?? "http://127.0.0.1:7331";
    const project = process.env.KXM_PROJECT ?? basename(ctx.cwd);
    const name = process.env.KXM_AGENT_NAME ?? pi.getSessionName() ?? `pi-${process.pid}`;
    agentName = name;
    projectName = project;
    stateDir = process.env.KXM_STATE_DIR ?? stateDir;
    removeMatchingLegacyRecoveryContext();
    const purpose = process.env.KXM_AGENT_PURPOSE ?? "General-purpose coding agent";
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : void 0;
    client = new HubClient({
      serverUrl,
      name,
      purpose,
      project,
      ...process.env.KXM_AUTH_TOKEN ? { authToken: process.env.KXM_AUTH_TOKEN } : {},
      ...model ? { model } : {}
    });
    notify = (message, type) => ctx.ui.notify(message, type);
    requestWorkerRestart = () => {
      void ctx.shutdown();
    };
    try {
      const agent = await client.start(receive);
      ctx.ui.setStatus("kxm", `hub:${agent.name}`);
      ctx.ui.notify(`Connected to the KXM hub as ${agent.name}`, "info");
      const recovered = stateDir ? await consumeWorkerRecoveryEnvelope(client, stateDir, agent.name, project) : void 0;
      const recoveryReplayIds = recovered?.activeMessageIds ?? recovered?.pendingMessageIds ?? [];
      const replayCandidates = await Promise.all(recoveryReplayIds.slice(0, 16).map(async (messageId) => {
        try {
          const message = await client.getMessage(messageId);
          return message.status === "queued" || message.status === "delivered";
        } catch {
          return false;
        }
      }));
      const durableInboundWillReplay = replayCandidates.some(Boolean);
      const recoveryMatchesSession = process.env.KXM_WORKER_SESSION_ISOLATION !== "workflow" || currentSessionBinding.kind === "workflow" && recovered?.runId === currentSessionBinding.runId;
      if (recovered?.freshSession && recovered.runId && !recovered.peerLocal && recoveryMatchesSession && !durableInboundWillReplay) {
        pi.sendMessage({ customType: "kxm-recovery", content: [`Resume durable workflow run ${recovered.runId} after a fresh-session worker recovery.`, recovered.stageId ? `Last recorded stage: ${recovered.stageId}.` : "Resolve the current stage from kxm_workflow_get.", `Recovery reason: ${recovered.reason}.`, "Call kxm_workflow_get, inspect its journal and stage evidence, then continue the current stage without repeating completed work.", "Record the recovery decision and checkpoint only after the required evidence is satisfied."].join("\n"), display: true, details: { runId: recovered.runId, stageId: recovered.stageId, reason: recovered.reason } }, { triggerTurn: true, deliverAs: "followUp" });
        await applySessionChrome(ctx, event, false);
        return;
      }
    } catch (error) {
      client = void 0;
      ctx.ui.setStatus("kxm", "kxm hub:off");
      ctx.ui.notify(`kxm connection failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
    await applySessionChrome(ctx, event, true);
  });
  pi.on("message_start", (event) => {
    const message = event.message;
    if (message.customType !== "kxm-inbound" || !awaitingActivation) return;
    if (message.details?.messageId !== awaitingActivation.id) return;
    clearActivationWatchdog(awaitingActivation.id);
    activeInbound = awaitingActivation;
    awaitingActivation = void 0;
    activeReply = void 0;
    settlementReply = void 0;
    activeTurnSettled = false;
    activeFailure = void 0;
    activeFailureRecorded = false;
    settlementRetryAttempt = 0;
    recoveryStageId = void 0;
    recoveryArtifacts = [];
    persistRecoveryContext();
  });
  pi.on("agent_end", (event) => {
    if (!activeInbound || activeTurnSettled) return;
    const latest = latestAssistantMessage(event.messages);
    if (!latest) return;
    const failure = assistantFailure(event.messages);
    if (failure) {
      activeFailure = failure;
      activeFailureRecorded = false;
      activeReply = void 0;
      persistRecoveryContext();
      return;
    }
    activeFailure = void 0;
    activeFailureRecorded = false;
    activeReply = assistantText(event.messages) ?? activeReply;
  });
  pi.on("tool_result", async (event) => {
    const activeRunId = activeInbound ? workflowRunIdForMessage(activeInbound) : void 0;
    if (!activeRunId || !client) return;
    const resultEvent = event;
    const serializedDetails = JSON.stringify(resultEvent.details ?? {});
    const stageMatch = serializedDetails.match(/"(?:currentStage|stageId)"\s*:\s*"([A-Za-z0-9_.-]{1,64})"/);
    if (stageMatch?.[1]) recoveryStageId = stageMatch[1];
    recoveryArtifacts = [.../* @__PURE__ */ new Set([...recoveryArtifacts, ...serializedDetails.match(/(?:artifact:|\.kxm[\\/]assets[\\/])[A-Za-z0-9_./\\:-]{1,240}/g) ?? []])].slice(0, 16);
    persistRecoveryContext();
    if (!resultEvent.isError) return;
    const diagnostic = classifyFailure({
      ...resultEvent.toolName ? { toolName: resultEvent.toolName } : {},
      ...resultEvent.error ?? resultEvent.text ? { message: resultEvent.error ?? resultEvent.text } : {},
      ...resultEvent.code ? { code: resultEvent.code } : {},
      ...resultEvent.statusCode !== void 0 ? { statusCode: resultEvent.statusCode } : {}
    });
    try {
      await client.recordWorkflowEntry(activeRunId, {
        category: "error",
        area: areaForTool(resultEvent.toolName),
        severity: "error",
        summary: diagnosticSummary(diagnostic),
        evidence: diagnosticEvidence(diagnostic, resultEvent.toolCallId)
      });
    } catch {
    }
  });
  pi.on("agent_settled", async () => {
    if (!activeInbound || !client || settlementInProgress) return;
    if (activeFailure) {
      persistRecoveryContext();
      if (!activeFailureRecorded) {
        try {
          const activeRunId = workflowRunIdForMessage(activeInbound);
          if (activeRunId) {
            await client.recordWorkflowEntry(activeRunId, {
              category: "error",
              area: "harness",
              severity: "error",
              summary: diagnosticSummary(activeFailure),
              evidence: diagnosticEvidence(activeFailure)
            });
          }
          activeFailureRecorded = true;
        } catch {
        }
      }
      notify?.(
        `kxm retained ${activeInbound.id} after ${activeFailure.class}; switch the model or let the supervised worker recover it`,
        "error"
      );
      return;
    }
    if (!activeTurnSettled) {
      settlementReply = boundedPeerReply(
        activeReply ?? "The peer agent completed without a textual response."
      );
    }
    activeTurnSettled = true;
    await settleActiveInbound(activeInbound.id);
  });
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    clearActivationWatchdog();
    persistRecoveryContext();
    if (activationRetryTimer) clearTimeout(activationRetryTimer);
    activationRetryTimer = void 0;
    activationRetryAttempt = 0;
    await activationPromise?.catch(() => void 0);
    if (settlementRetryTimer) clearTimeout(settlementRetryTimer);
    settlementRetryTimer = void 0;
    await client?.stop();
    client = void 0;
    notify = void 0;
    requestWorkerRestart = void 0;
  });
  pi.registerTool({
    name: "kxm_list",
    label: "List hub peers",
    description: "List online peer agents in this project's hub pool, including their names and purposes.",
    parameters: Type.Object({}),
    async execute() {
      return result({ agents: await requireClient().listAgents() });
    }
  });
  pi.registerTool({
    name: "kxm_send",
    label: "Send peer request",
    description: "Send a focused request to a peer agent. Returns a message ID for kxm_get or kxm_await. For durable peer evidence, workflowContext is the hub-authorized provenance scope; correlation and idempotency are transport concerns and do not establish evidence provenance.",
    parameters: Type.Object({
      target: Type.String({ description: "Peer name or agent ID" }),
      content: Type.String({ description: "Focused request with the expected response or artifact" }),
      delivery: Type.Optional(Type.Union([
        Type.Literal("steer"),
        Type.Literal("followUp"),
        Type.Literal("nextTurn")
      ], { description: "followUp is the safe default; use steer only for active blockers" })),
      correlationId: Type.Optional(Type.String({ description: "Optional task grouping; the hub binds it to runId when workflowContext is supplied" })),
      idempotencyKey: Type.Optional(Type.String({ description: "Retry/deduplication key only; not a workflow security or evidence binding" })),
      workflowContext: Type.Optional(Type.Object({
        runId: Type.String({ description: "Active durable workflow run ID" }),
        stageId: Type.String({ description: "Active workflow stage ID" }),
        requirementKey: Type.String({ description: "Required evidence identity this peer reply may satisfy" }),
        attempt: Type.Integer({ minimum: 1, maximum: 20, description: "Current one-based stage attempt" })
      }, {
        additionalProperties: false,
        description: "Requested provenance scope; the hub authorizes and persists the canonical binding"
      })),
      ttlMs: Type.Optional(Type.Number({ minimum: 1e3, maximum: 6048e5 }))
    }),
    async execute(_toolCallId, params) {
      const message = await requireClient().send({
        target: params.target,
        content: params.content,
        ...params.delivery ? { delivery: params.delivery } : {},
        ...params.correlationId ? { correlationId: params.correlationId } : {},
        ...params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {},
        ...params.workflowContext ? { workflowContext: params.workflowContext } : {},
        ...params.ttlMs ? { ttlMs: params.ttlMs } : {}
      });
      return result({ messageId: message.id, status: message.status, target: message.toName });
    }
  });
  pi.registerTool({
    name: "kxm_get",
    label: "Get peer response",
    description: "Check a peer request without blocking. Returns its current status and optional reply.",
    parameters: Type.Object({ messageId: Type.String() }),
    async execute(_toolCallId, params) {
      return result(await requireClient().getMessage(params.messageId));
    }
  });
  pi.registerTool({
    name: "kxm_fanout",
    label: "Ask planning panel",
    description: "Send the same independent request to one through three peers and return replies for comparison and synthesis. A local timeout or prompt interruption returns a pending response with a durable messageId for kxm_get or an exact retry. For durable peer evidence, supply workflowContext; correlation and idempotency are transport concerns and do not establish evidence provenance.",
    parameters: Type.Object({
      targets: Type.Array(Type.String(), { minItems: 1, maxItems: 3 }),
      content: Type.String(),
      correlationId: Type.Optional(Type.String({ description: "Optional task grouping; the hub binds it to runId when workflowContext is supplied" })),
      idempotencyKeyPrefix: Type.Optional(Type.String({ description: "Stable retry/deduplication prefix only; not a workflow security or evidence binding" })),
      workflowContext: Type.Optional(Type.Object({
        runId: Type.String({ description: "Active durable workflow run ID" }),
        stageId: Type.String({ description: "Active workflow stage ID" }),
        requirementKey: Type.String({ description: "Required evidence identity these peer replies may satisfy" }),
        attempt: Type.Integer({ minimum: 1, maximum: 20, description: "Current one-based stage attempt" })
      }, {
        additionalProperties: false,
        description: "Requested provenance scope shared by each request; the hub authorizes and persists the canonical binding"
      })),
      ttlMs: Type.Optional(Type.Number({ minimum: 1e3, maximum: 6048e5 })),
      timeoutMs: Type.Optional(Type.Number({ minimum: 100, maximum: 18e5 }))
    }),
    async execute(_toolCallId, params, signal) {
      return result({ responses: await requireClient().fanout({
        targets: params.targets,
        content: params.content,
        ...params.correlationId ? { correlationId: params.correlationId } : {},
        ...params.idempotencyKeyPrefix ? { idempotencyKeyPrefix: params.idempotencyKeyPrefix } : {},
        ...params.workflowContext ? { workflowContext: params.workflowContext } : {},
        ...params.ttlMs ? { ttlMs: params.ttlMs } : {},
        ...params.timeoutMs ? { timeoutMs: params.timeoutMs } : {},
        ...signal ? { signal } : {}
      }) });
    }
  });
  pi.registerTool({
    name: "kxm_await",
    label: "Await peer response",
    description: "Wait for a peer request to receive a reply. Prefer kxm_get when useful work can continue meanwhile.",
    parameters: Type.Object({
      messageId: Type.String(),
      timeoutMs: Type.Optional(Type.Number({ minimum: 100, maximum: 18e5 }))
    }),
    async execute(_toolCallId, params, signal) {
      return result(await requireClient().awaitResponse(params.messageId, params.timeoutMs, signal));
    }
  });
  pi.registerTool({
    name: "kxm_cancel",
    label: "Cancel peer request",
    description: "Cancel a queued or delivered request that this agent sent.",
    parameters: Type.Object({ messageId: Type.String() }),
    async execute(_toolCallId, params) {
      return result(await requireClient().cancel(params.messageId));
    }
  });
  pi.registerTool({
    name: "kxm_workflow_list",
    label: "List workflow runs",
    description: "List durable webhook workflow runs assigned to this long-lived agent.",
    parameters: Type.Object({}),
    async execute() {
      return result({ runs: await workflowCall(() => requireClient().listWorkflows()) });
    }
  });
  pi.registerTool({
    name: "kxm_workflow_get",
    label: "Get workflow run",
    description: "Get a workflow's stages and journal of plans, decisions, contradictions, errors, and lessons.",
    parameters: Type.Object({ runId: Type.String() }),
    async execute(_toolCallId, params) {
      return result(await workflowCall(() => requireClient().getWorkflow(params.runId)));
    }
  });
  pi.registerTool({
    name: "kxm_workflow_checkpoint",
    label: "Checkpoint workflow stage",
    description: "Record a stage result with evidence keyed by the stage's required evidence identities. Cite peer-reply requirements through evidenceRefs so the hub can verify provenance and quorum; caller-authored evidence strings cannot satisfy those policies. Warnings and failures require another attempt until passed or exhausted.",
    parameters: Type.Object({
      runId: Type.String(),
      stageId: Type.String(),
      status: Type.Union([Type.Literal("passed"), Type.Literal("warning"), Type.Literal("failed")]),
      summary: Type.String(),
      evidence: Type.Optional(Type.Record(Type.String(), Type.String(), { maxProperties: 64 })),
      evidenceRefs: Type.Optional(Type.Record(
        Type.String(),
        Type.Object({
          messageIds: Type.Array(Type.String(), { minItems: 1, maxItems: 16 })
        }, { additionalProperties: false }),
        {
          maxProperties: 32,
          description: "Peer evidence references keyed by required evidence identity; the hub verifies messages and derives producer metadata"
        }
      ))
    }),
    async execute(_toolCallId, params) {
      return result(await workflowCall(() => requireClient().checkpointWorkflow(params.runId, {
        stageId: params.stageId,
        status: params.status,
        summary: params.summary,
        ...params.evidence ? { evidence: params.evidence } : {},
        ...params.evidenceRefs ? { evidenceRefs: params.evidenceRefs } : {}
      })));
    }
  });
  pi.registerTool({
    name: "kxm_workflow_wait",
    label: "Wait for workflow signal",
    description: "Pause the active workflow stage until a signed external callback reports its result. Supply caller-authored evidence by key and cite peer-reply requirements through evidenceRefs so the hub can verify provenance and quorum. Verified evidence is accumulated with callback evidence. The current agent turn may settle after this succeeds.",
    parameters: Type.Object({
      runId: Type.String(),
      stageId: Type.String(),
      signalKey: Type.String({ description: "Stable callback key, such as github-pr-42-checks" }),
      summary: Type.String({ description: "What is running externally and what result is expected" }),
      evidence: Type.Optional(Type.Record(Type.String(), Type.String(), { maxProperties: 64 })),
      evidenceRefs: Type.Optional(Type.Record(
        Type.String(),
        Type.Object({
          messageIds: Type.Array(Type.String(), { minItems: 1, maxItems: 16 })
        }, { additionalProperties: false }),
        {
          maxProperties: 32,
          description: "Peer evidence references keyed by required evidence identity; the hub verifies messages and derives producer metadata"
        }
      )),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1e3, maximum: 2592e6 }))
    }),
    async execute(_toolCallId, params) {
      return result(await workflowCall(() => requireClient().waitForWorkflowSignal(params.runId, {
        stageId: params.stageId,
        signalKey: params.signalKey,
        summary: params.summary,
        ...params.evidence ? { evidence: params.evidence } : {},
        ...params.evidenceRefs ? { evidenceRefs: params.evidenceRefs } : {},
        ...params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}
      })));
    }
  });
  pi.registerTool({
    name: "kxm_workflow_record",
    label: "Record workflow knowledge",
    description: "Capture a plan, decision, contradiction, error, or lesson as evidence for workflow improvement.",
    parameters: Type.Object({
      runId: Type.String(),
      category: Type.Union([
        Type.Literal("plan"),
        Type.Literal("decision"),
        Type.Literal("contradiction"),
        Type.Literal("error"),
        Type.Literal("lesson")
      ]),
      area: Type.Union([
        Type.Literal("harness"),
        Type.Literal("gates"),
        Type.Literal("implementation"),
        Type.Literal("workflow"),
        Type.Literal("documentation"),
        Type.Literal("security"),
        Type.Literal("other")
      ]),
      severity: Type.Optional(Type.Union([
        Type.Literal("info"),
        Type.Literal("warning"),
        Type.Literal("error")
      ])),
      summary: Type.String(),
      details: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
      relatedEntryIds: Type.Optional(Type.Array(Type.String(), { maxItems: 16 }))
    }),
    async execute(_toolCallId, params) {
      return result(await workflowCall(() => requireClient().recordWorkflowEntry(params.runId, {
        category: params.category,
        area: params.area,
        ...params.severity ? { severity: params.severity } : {},
        summary: params.summary,
        ...params.details ? { details: params.details } : {},
        ...params.evidence ? { evidence: params.evidence } : {},
        ...params.relatedEntryIds ? { relatedEntryIds: params.relatedEntryIds } : {}
      })));
    }
  });
  pi.registerTool({
    name: "kxm_improvement_report",
    label: "Review workflow improvements",
    description: "Summarize recorded errors, contradictions, and lessons by improvement area across this project.",
    parameters: Type.Object({}),
    async execute() {
      return result(await workflowCall(() => requireClient().improvementReport()));
    }
  });
  pi.registerTool({
    name: "kxm_context",
    label: "Assemble role-aware context packet",
    description: "Normal entry point for KXM context. Assembles a token-budgeted context packet for your role and task from durable journal evidence, temporal state, knowledge, episodes, and skills. Superseded and rejected records are excluded. Do not query memory providers directly; use KXM context tools.",
    parameters: Type.Object({
      role: Type.String({ description: "Your role for this task: repro, planner, critic, implementer, verifier, or a custom role" }),
      task: Type.String({ description: "What you are trying to accomplish" }),
      workflowRunId: Type.Optional(Type.String({ description: "Workflow run scope, when working a run" })),
      stageId: Type.Optional(Type.String({ description: "Workflow stage scope" })),
      budgetTokens: Type.Optional(Type.Integer({ description: "Token budget; defaults to the role policy" })),
      includeKinds: Type.Optional(Type.Array(Type.Union([
        Type.Literal("evidence"),
        Type.Literal("state"),
        Type.Literal("episode"),
        Type.Literal("knowledge"),
        Type.Literal("skill")
      ]), { description: "Restrict packet to these item kinds" }))
    }),
    async execute(_toolCallId, params) {
      const client2 = requireClient();
      return result(await workflowCall(() => client2.contextGet({
        project: client2.agent.project,
        role: params.role,
        task: params.task,
        ...params.workflowRunId ? { workflowRunId: params.workflowRunId } : {},
        ...params.stageId ? { stageId: params.stageId } : {},
        ...params.budgetTokens !== void 0 ? { budgetTokens: params.budgetTokens } : {},
        ...params.includeKinds ? { includeKinds: params.includeKinds } : {}
      })));
    }
  });
  pi.registerTool({
    name: "kxm_recall",
    label: "Recall durable context records",
    description: "Search durable context records for this project by query. Returns bounded metadata only; use kxm_context for role-aware packets.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Substring query against summaries and state keys" })),
      kinds: Type.Optional(Type.Array(Type.String(), { description: "Item kinds to include" })),
      limit: Type.Optional(Type.Integer({ description: "Maximum results (1-100)" }))
    }),
    async execute(_toolCallId, params) {
      const client2 = requireClient();
      return result(await workflowCall(() => client2.contextRecall({
        project: client2.agent.project,
        ...params.query ? { query: params.query } : {},
        ...params.kinds ? { kinds: params.kinds } : {},
        ...params.limit !== void 0 ? { limit: params.limit } : {}
      })));
    }
  });
  pi.registerTool({
    name: "kxm_state",
    label: "Query authoritative project state",
    description: "Current value for one temporal state key, optionally as of a historical timestamp. Superseded values never appear as current.",
    parameters: Type.Object({
      key: Type.String({ description: "State key" }),
      asOf: Type.Optional(Type.String({ description: "ISO-8601 timestamp for historical queries" }))
    }),
    async execute(_toolCallId, params) {
      const client2 = requireClient();
      return result(await workflowCall(() => client2.contextState({
        project: client2.agent.project,
        key: params.key,
        ...params.asOf ? { asOf: params.asOf } : {}
      })));
    }
  });
  pi.registerTool({
    name: "kxm_episode",
    label: "Recall episodic learning records",
    description: "Episodic learning from workflow journals: errors, lessons, observations, and experiments for this project, optionally scoped to one run.",
    parameters: Type.Object({
      workflowRunId: Type.Optional(Type.String({ description: "Limit to one workflow run" }))
    }),
    async execute(_toolCallId, params) {
      const client2 = requireClient();
      return result(await workflowCall(() => client2.contextEpisode({
        project: client2.agent.project,
        ...params.workflowRunId ? { workflowRunId: params.workflowRunId } : {}
      })));
    }
  });
  pi.registerTool({
    name: "kxm_promote",
    label: "Propose temporal state change",
    description: "Propose a change to one authoritative state key. Proposing changes nothing: promotion requires durable evidence and an authorized control-plane decision. Peers can claim evidence authority at most.",
    parameters: Type.Object({
      key: Type.String({ description: "State key to propose a change for" }),
      summary: Type.String({ description: "Proposed value and rationale" }),
      authority: Type.Union([
        Type.Literal("policy"),
        Type.Literal("instruction"),
        Type.Literal("evidence"),
        Type.Literal("hypothesis")
      ]),
      confidence: Type.Union([
        Type.Literal("verified"),
        Type.Literal("probable"),
        Type.Literal("uncertain")
      ]),
      evidenceRefs: Type.Array(Type.String(), { minItems: 1, maxItems: 32, description: "Durable references backing the proposal" })
    }),
    async execute(_toolCallId, params) {
      const client2 = requireClient();
      return result(await workflowCall(() => client2.contextStatePropose({
        project: client2.agent.project,
        key: params.key,
        summary: params.summary,
        authority: params.authority,
        confidence: params.confidence,
        evidenceRefs: params.evidenceRefs
      })));
    }
  });
  pi.registerCommand("kxm", {
    description: "Hub session brief, status line, and hub view",
    getArgumentCompletions: (prefix) => {
      const items = kxmSlashCompletions(prefix);
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const command = parseKxmSlashArgs(typeof args === "string" ? args : void 0);
      if (command === "hub") {
        await showKxmHub(ctx);
        return;
      }
      if (command === "help") {
        ctx.ui.notify("kxm: /kxm | /kxm status | /kxm hub | /kxm help. CLI: kxm session brief, kxm hub view", "info");
        return;
      }
      await applySessionChrome(ctx, { reason: "new" }, command === "brief");
    }
  });
}
export {
  bindingForMessage,
  piMeshExtension as default,
  workflowRunIdForMessage
};

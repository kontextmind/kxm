// plugins/kxm/src/extension.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { existsSync as existsSync5, mkdirSync as mkdirSync5, readFileSync as readFileSync7, renameSync as renameSync4, rmSync as rmSync3, writeFileSync as writeFileSync4 } from "node:fs";
import { basename, dirname as dirname2, join as join6 } from "node:path";

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
      await new Promise((resolve3, reject) => {
        const onAbort = () => {
          signal?.removeEventListener("abort", onAbort);
          clearTimeout(timer);
          reject(new MeshWaitError("aborted", messageId));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve3();
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
      if (!this.stopped) await new Promise((resolve3) => setTimeout(resolve3, this.options.reconnectMs));
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

// plugins/kxm/src/commands.ts
function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}
function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function optionalWorkflowContext(value) {
  if (value === void 0) return void 0;
  const context = asRecord(value);
  if (!Number.isInteger(context.attempt) || context.attempt < 1 || context.attempt > 20) {
    throw new Error("workflowContext.attempt must be an integer between 1 and 20");
  }
  return {
    runId: requiredString(context.runId, "workflowContext.runId"),
    stageId: requiredString(context.stageId, "workflowContext.stageId"),
    requirementKey: requiredString(context.requirementKey, "workflowContext.requirementKey"),
    attempt: context.attempt
  };
}
function optionalEvidenceRefs(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function isTerminalMessageError(error) {
  return error instanceof HubHttpError && (error.statusCode === 409 || error.statusCode === 404 && error.code === "message_not_found");
}
function isTerminalMessage(message) {
  return message.status === "replied" || message.status === "cancelled" || message.status === "expired" || message.status === "error";
}
async function reconcileInbox(client, inbox, notifiedInbox) {
  await Promise.all(
    [...inbox.keys()].map(async (messageId) => {
      try {
        const current = await client.getMessage(messageId);
        if (isTerminalMessage(current)) {
          inbox.delete(messageId);
          notifiedInbox?.delete(messageId);
        } else {
          inbox.set(messageId, current);
        }
      } catch (error) {
        if (isTerminalMessageError(error)) {
          inbox.delete(messageId);
          notifiedInbox?.delete(messageId);
          return;
        }
        throw error;
      }
    })
  );
}
function resolveProject(client, projectArg) {
  const proj = optionalString(projectArg) ?? client.agent?.project;
  if (!proj) {
    throw new Error('missing required parameter "project"');
  }
  return proj;
}
var AGENT_COMMANDS = [
  {
    name: "kxm_list",
    group: "peer",
    verb: "list",
    label: "List hub peers",
    description: "List online peer agents in this project's hub pool, including their names and purposes.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    async execute(client) {
      return { agents: await client.listAgents() };
    }
  },
  {
    name: "kxm_send",
    group: "peer",
    verb: "send",
    label: "Send peer request",
    description: "Send a focused request to a peer agent. Returns a message ID for kxm_get or kxm_await. For durable peer evidence, workflowContext is the hub-authorized provenance scope; correlation and idempotency are transport concerns and do not establish evidence provenance.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Peer name or agent ID" },
        content: { type: "string", description: "Focused request with the expected response or artifact" },
        delivery: {
          type: "string",
          enum: ["steer", "followUp", "nextTurn"],
          default: "followUp",
          description: "followUp is the safe default; use steer only for active blockers"
        },
        correlationId: {
          type: "string",
          description: "Optional task grouping; the hub binds it to runId when workflowContext is supplied"
        },
        idempotencyKey: {
          type: "string",
          description: "Retry/deduplication key only; not a workflow security or evidence binding"
        },
        workflowContext: {
          type: "object",
          description: "Requested provenance scope; the hub authorizes and persists the canonical binding",
          properties: {
            runId: { type: "string", description: "Active durable workflow run ID" },
            stageId: { type: "string", description: "Active workflow stage ID" },
            requirementKey: { type: "string", description: "Required evidence identity this peer reply may satisfy" },
            attempt: { type: "integer", minimum: 1, maximum: 20, description: "Current one-based stage attempt" }
          },
          required: ["runId", "stageId", "requirementKey", "attempt"],
          additionalProperties: false
        },
        ttlMs: { type: "number", minimum: 1e3, maximum: 6048e5, description: "Message TTL in milliseconds" }
      },
      required: ["target", "content"],
      additionalProperties: false
    },
    async execute(client, args) {
      const delivery = optionalString(args.delivery);
      const correlationId = optionalString(args.correlationId);
      const idempotencyKey = optionalString(args.idempotencyKey);
      const workflowContext = optionalWorkflowContext(args.workflowContext);
      const message = await client.send({
        target: requiredString(args.target, "target"),
        content: requiredString(args.content, "content"),
        ...delivery ? { delivery } : {},
        ...correlationId ? { correlationId } : {},
        ...idempotencyKey ? { idempotencyKey } : {},
        ...workflowContext ? { workflowContext } : {},
        ...typeof args.ttlMs === "number" ? { ttlMs: args.ttlMs } : {}
      });
      return { messageId: message.id, status: message.status, target: message.toName };
    }
  },
  {
    name: "kxm_get",
    group: "peer",
    verb: "get",
    label: "Get peer request",
    description: "Check the status and optional reply for a previously sent request.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID of the sent request" }
      },
      required: ["messageId"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.getMessage(requiredString(args.messageId, "messageId"));
    }
  },
  {
    name: "kxm_fanout",
    group: "peer",
    verb: "fanout",
    label: "Fanout peer requests",
    description: "Ask one through three peers independently and return replies for comparison and synthesis. A local timeout or request cancellation returns a pending response with a durable messageId for kxm_get or an exact retry.",
    parameters: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 3,
          description: "One through three target peer names or agent IDs"
        },
        content: { type: "string", description: "Task description sent to all targets" },
        correlationId: {
          type: "string",
          description: "Optional task grouping; the hub binds it to runId when workflowContext is supplied"
        },
        idempotencyKeyPrefix: {
          type: "string",
          description: "Stable retry/deduplication prefix only; not a workflow security or evidence binding"
        },
        workflowContext: {
          type: "object",
          description: "Requested provenance scope shared by each request",
          properties: {
            runId: { type: "string", description: "Active durable workflow run ID" },
            stageId: { type: "string", description: "Active workflow stage ID" },
            requirementKey: { type: "string", description: "Required evidence identity these peer replies may satisfy" },
            attempt: { type: "integer", minimum: 1, maximum: 20, description: "Current one-based stage attempt" }
          },
          required: ["runId", "stageId", "requirementKey", "attempt"],
          additionalProperties: false
        },
        ttlMs: { type: "number", minimum: 1e3, maximum: 6048e5, description: "Message TTL in milliseconds" },
        timeoutMs: { type: "number", minimum: 100, maximum: 18e5, description: "Client wait timeout in milliseconds" }
      },
      required: ["targets", "content"],
      additionalProperties: false
    },
    async execute(client, args, context) {
      const targets = Array.isArray(args.targets) ? args.targets.map((t) => requiredString(t, "target")) : [];
      return {
        responses: await client.fanout({
          targets,
          content: requiredString(args.content, "content"),
          ...optionalString(args.correlationId) ? { correlationId: optionalString(args.correlationId) } : {},
          ...optionalString(args.idempotencyKeyPrefix) ? { idempotencyKeyPrefix: optionalString(args.idempotencyKeyPrefix) } : {},
          ...optionalWorkflowContext(args.workflowContext) ? { workflowContext: optionalWorkflowContext(args.workflowContext) } : {},
          ...typeof args.ttlMs === "number" ? { ttlMs: args.ttlMs } : {},
          ...typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {},
          ...context?.signal ? { signal: context.signal } : {}
        })
      };
    }
  },
  {
    name: "kxm_await",
    group: "peer",
    verb: "await",
    label: "Await peer response",
    description: "Wait until a sent request receives a reply or reaches a terminal error. Capped at 60 seconds (60000ms); longer waits are workflow wait steps.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID of the sent request" },
        timeoutMs: {
          type: "number",
          minimum: 100,
          maximum: 6e4,
          default: 6e4,
          description: "Timeout in milliseconds (capped at 60 seconds)"
        }
      },
      required: ["messageId"],
      additionalProperties: false
    },
    async execute(client, args, context) {
      const timeoutMs = Math.min(
        typeof args.timeoutMs === "number" ? args.timeoutMs : 6e4,
        6e4
      );
      return await client.awaitResponse(
        requiredString(args.messageId, "messageId"),
        timeoutMs,
        context?.signal
      );
    }
  },
  {
    name: "kxm_cancel",
    group: "peer",
    verb: "cancel",
    label: "Cancel peer request",
    description: "Cancel a queued or delivered request sent by this agent.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID of the request to cancel" }
      },
      required: ["messageId"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.cancel(requiredString(args.messageId, "messageId"));
    }
  },
  {
    name: "kxm_inbox",
    group: "peer",
    verb: "inbox",
    label: "List inbound requests",
    description: "List inbound peer requests awaiting a reply.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    async execute(client, _args, context) {
      if (context?.inbox) {
        await reconcileInbox(client, context.inbox, context.notifiedInbox);
        return { messages: [...context.inbox.values()] };
      }
      return { messages: [] };
    }
  },
  {
    name: "kxm_reply",
    group: "peer",
    verb: "reply",
    label: "Reply to peer request",
    description: "Reply to an inbound peer request using its message ID.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID of the inbound request" },
        content: { type: "string", description: "Final response with evidence and remaining risks" }
      },
      required: ["messageId", "content"],
      additionalProperties: false
    },
    async execute(client, args, context) {
      const messageId = requiredString(args.messageId, "messageId");
      try {
        const message = await client.reply(messageId, requiredString(args.content, "content"));
        if (context?.inbox) {
          context.inbox.delete(messageId);
          context.notifiedInbox?.delete(messageId);
        }
        return { messageId, status: message.status, recipient: message.fromName };
      } catch (error) {
        if (context?.inbox && isTerminalMessageError(error)) {
          context.inbox.delete(messageId);
          context.notifiedInbox?.delete(messageId);
        }
        throw error;
      }
    }
  },
  {
    name: "kxm_workflow_list",
    group: "workflow",
    verb: "runs",
    label: "List workflow runs",
    description: "List durable webhook workflows assigned to this agent.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    async execute(client) {
      return { runs: await client.listWorkflows() };
    }
  },
  {
    name: "kxm_workflow_get",
    group: "workflow",
    verb: "run",
    label: "Get workflow run",
    description: "Get a workflow's stages and journal of plans, decisions, contradictions, errors, and lessons.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Workflow run ID" }
      },
      required: ["runId"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.getWorkflow(requiredString(args.runId, "runId"));
    }
  },
  {
    name: "kxm_workflow_checkpoint",
    group: "workflow",
    verb: "checkpoint",
    label: "Checkpoint workflow stage",
    description: "Record a stage result with evidence keyed by the stage's required evidence identities. Cite peer-reply requirements through evidenceRefs so the hub can verify provenance and quorum; caller-authored evidence strings cannot satisfy those policies. Warnings and failures require another attempt until passed or exhausted.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Active durable workflow run ID" },
        stageId: { type: "string", description: "Active stage ID" },
        status: { type: "string", enum: ["passed", "warning", "failed"], description: "Stage outcome" },
        summary: { type: "string", description: "Summary of changes, verification, and remaining risks" },
        evidence: {
          type: "object",
          additionalProperties: { type: "string" },
          maxProperties: 64,
          description: "Key-value evidence mapping required keys to proof strings"
        },
        evidenceRefs: {
          type: "object",
          description: "Peer evidence references keyed by required evidence identity",
          patternProperties: {
            "^(.*)$": {
              type: "object",
              properties: {
                messageIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 }
              },
              required: ["messageIds"],
              additionalProperties: false
            }
          },
          additionalProperties: {
            type: "object",
            properties: {
              messageIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 }
            },
            required: ["messageIds"],
            additionalProperties: false
          },
          maxProperties: 32
        }
      },
      required: ["runId", "stageId", "status", "summary"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.checkpointWorkflow(requiredString(args.runId, "runId"), {
        stageId: requiredString(args.stageId, "stageId"),
        status: requiredString(args.status, "status"),
        summary: requiredString(args.summary, "summary"),
        ...args.evidence && typeof args.evidence === "object" && !Array.isArray(args.evidence) ? { evidence: args.evidence } : {},
        ...optionalEvidenceRefs(args.evidenceRefs) ? { evidenceRefs: optionalEvidenceRefs(args.evidenceRefs) } : {}
      });
    }
  },
  {
    name: "kxm_workflow_record",
    group: "workflow",
    verb: "record",
    label: "Record workflow journal entry",
    description: "Record a plan, decision, contradiction, error, or lesson for continuous improvement.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Active durable workflow run ID" },
        category: {
          type: "string",
          enum: ["plan", "decision", "contradiction", "error", "lesson"],
          description: "Category of journal entry"
        },
        area: {
          type: "string",
          enum: ["harness", "gates", "implementation", "workflow", "documentation", "security", "other"],
          description: "System area"
        },
        severity: {
          type: "string",
          enum: ["info", "warning", "error"],
          default: "info",
          description: "Severity level"
        },
        summary: { type: "string", description: "Concise description of the observation or decision" },
        details: { type: "string", description: "Extended details, context, and reasoning" },
        evidence: {
          type: "array",
          items: { type: "string" },
          maxItems: 32,
          description: "Durable evidence strings or URIs"
        },
        relatedEntryIds: {
          type: "array",
          items: { type: "string" },
          maxItems: 16,
          description: "Related previous journal entry IDs"
        }
      },
      required: ["runId", "category", "area", "summary"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.recordWorkflowEntry(requiredString(args.runId, "runId"), {
        category: requiredString(args.category, "category"),
        area: requiredString(args.area, "area"),
        ...optionalString(args.severity) ? { severity: optionalString(args.severity) } : {},
        summary: requiredString(args.summary, "summary"),
        ...optionalString(args.details) ? { details: optionalString(args.details) } : {},
        ...Array.isArray(args.evidence) ? { evidence: args.evidence } : {},
        ...Array.isArray(args.relatedEntryIds) ? { relatedEntryIds: args.relatedEntryIds } : {}
      });
    }
  },
  {
    name: "kxm_workflow_wait",
    group: "workflow",
    verb: "wait",
    label: "Wait for workflow signal",
    description: "Pause the active stage until a signed external callback checkpoints it and resumes the coordinator. Cite peer-reply requirements through evidenceRefs so the hub can verify provenance and quorum; verified evidence is accumulated with callback evidence.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Active durable workflow run ID" },
        stageId: { type: "string", description: "Active stage ID" },
        signalKey: { type: "string", description: "Stable callback key, such as github-pr-42-checks" },
        summary: { type: "string", description: "What is running externally and what result is expected" },
        evidence: {
          type: "object",
          additionalProperties: { type: "string" },
          maxProperties: 64,
          description: "Evidence gathered before the wait"
        },
        evidenceRefs: {
          type: "object",
          description: "Peer evidence references verified before waiting",
          patternProperties: {
            "^(.*)$": {
              type: "object",
              properties: {
                messageIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 }
              },
              required: ["messageIds"],
              additionalProperties: false
            }
          },
          additionalProperties: {
            type: "object",
            properties: {
              messageIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 }
            },
            required: ["messageIds"],
            additionalProperties: false
          },
          maxProperties: 32
        },
        timeoutMs: {
          type: "number",
          minimum: 1e3,
          maximum: 2592e6,
          description: "Maximum wait duration in milliseconds"
        }
      },
      required: ["runId", "stageId", "signalKey", "summary"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.waitForWorkflowSignal(requiredString(args.runId, "runId"), {
        stageId: requiredString(args.stageId, "stageId"),
        signalKey: requiredString(args.signalKey, "signalKey"),
        summary: requiredString(args.summary, "summary"),
        ...args.evidence && typeof args.evidence === "object" && !Array.isArray(args.evidence) ? { evidence: args.evidence } : {},
        ...optionalEvidenceRefs(args.evidenceRefs) ? { evidenceRefs: optionalEvidenceRefs(args.evidenceRefs) } : {},
        ...typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}
      });
    }
  },
  {
    name: "kxm_improvement_report",
    group: "workflow",
    verb: "improve-report",
    label: "Summarize improvement report",
    description: "Summarize workflow errors, contradictions, and lessons by improvement area.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    async execute(client) {
      return await client.improvementReport();
    }
  },
  {
    name: "kxm_context",
    group: "context",
    verb: "get",
    label: "Get KXM context packet",
    description: "Normal entry point for KXM context. Assembles a token-budgeted role-aware context packet from durable journal evidence, temporal state, knowledge, episodes, and skills. Superseded and rejected records are excluded. Use KXM context tools instead of provider-specific memory APIs.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project scope (must be the client's project)" },
        role: {
          type: "string",
          description: "Requesting role: repro, planner, critic, implementer, verifier, or custom"
        },
        task: { type: "string", description: "What the role is trying to accomplish" },
        workflowRunId: { type: "string", description: "Workflow run scope" },
        stageId: { type: "string", description: "Workflow stage scope" },
        budgetTokens: { type: "integer", description: "Token budget; defaults to the role policy" },
        includeKinds: {
          type: "array",
          items: { type: "string", enum: ["evidence", "state", "episode", "knowledge", "skill"] },
          description: "Restrict packet to these item kinds"
        }
      },
      required: ["role", "task"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.contextGet({
        project: resolveProject(client, args.project),
        role: requiredString(args.role, "role"),
        task: requiredString(args.task, "task"),
        ...optionalString(args.workflowRunId) ? { workflowRunId: optionalString(args.workflowRunId) } : {},
        ...optionalString(args.stageId) ? { stageId: optionalString(args.stageId) } : {},
        ...typeof args.budgetTokens === "number" ? { budgetTokens: args.budgetTokens } : {},
        ...Array.isArray(args.includeKinds) ? { includeKinds: args.includeKinds } : {}
      });
    }
  },
  {
    name: "kxm_recall",
    group: "context",
    verb: "recall",
    label: "Recall context metadata",
    description: "Search durable context records for a project by query; returns bounded metadata only.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project identifier" },
        query: { type: "string", description: "Query string" },
        kinds: { type: "array", items: { type: "string" }, description: "Kinds filter" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum results" }
      },
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.contextRecall({
        project: resolveProject(client, args.project),
        ...optionalString(args.query) ? { query: optionalString(args.query) } : {},
        ...Array.isArray(args.kinds) ? { kinds: args.kinds } : {},
        ...typeof args.limit === "number" ? { limit: args.limit } : {}
      });
    }
  },
  {
    name: "kxm_state",
    group: "context",
    verb: "state",
    label: "Get temporal state",
    description: "Current value for one temporal state key, optionally as of a historical timestamp.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project identifier" },
        key: { type: "string", description: "State key" },
        asOf: { type: "string", description: "ISO-8601 timestamp for historical queries" }
      },
      required: ["key"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.contextState({
        project: resolveProject(client, args.project),
        key: requiredString(args.key, "key"),
        ...optionalString(args.asOf) ? { asOf: optionalString(args.asOf) } : {}
      });
    }
  },
  {
    name: "kxm_episode",
    group: "context",
    verb: "episode",
    label: "Get workflow episodes",
    description: "Episodic learning from workflow journals: errors, lessons, observations, experiments for a project.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project identifier" },
        workflowRunId: { type: "string", description: "Optional workflow run scope" }
      },
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.contextEpisode({
        project: resolveProject(client, args.project),
        ...optionalString(args.workflowRunId) ? { workflowRunId: optionalString(args.workflowRunId) } : {}
      });
    }
  },
  {
    name: "kxm_promote",
    group: "context",
    verb: "promote",
    label: "Propose state promotion",
    description: "Propose a change to one authoritative state key. Promotion requires durable evidence.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project identifier" },
        key: { type: "string", description: "State key to promote" },
        summary: { type: "string", description: "Promotion summary" },
        authority: {
          type: "string",
          enum: ["policy", "instruction", "evidence", "hypothesis"],
          description: "Authority class"
        },
        confidence: {
          type: "string",
          enum: ["verified", "probable", "uncertain"],
          description: "Confidence level"
        },
        evidenceRefs: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 32,
          description: "Evidence item references backing the promotion"
        }
      },
      required: ["key", "summary", "authority", "confidence", "evidenceRefs"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.contextStatePropose({
        project: resolveProject(client, args.project),
        key: requiredString(args.key, "key"),
        summary: requiredString(args.summary, "summary"),
        authority: requiredString(args.authority, "authority"),
        confidence: requiredString(args.confidence, "confidence"),
        evidenceRefs: Array.isArray(args.evidenceRefs) ? args.evidenceRefs : []
      });
    }
  }
];
var AGENT_COMMANDS_MAP = new Map(
  AGENT_COMMANDS.map((cmd) => [cmd.name, cmd])
);
function parseAttemptToken(token) {
  try {
    const raw = Buffer.from(token.trim(), "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.schema === "kxm.attempt-token.v1" && typeof parsed.runId === "string") {
      return parsed;
    }
  } catch {
    return void 0;
  }
  return void 0;
}
function parseSessionToken(token) {
  try {
    const raw = Buffer.from(token.trim(), "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.schema === "kxm.session-token.v1" && typeof parsed.sessionId === "string") {
      return parsed;
    }
  } catch {
    return void 0;
  }
  return void 0;
}
function matchToolPattern(pattern, toolName) {
  if (pattern === "*" || pattern === toolName) return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }
  return false;
}
function isToolAllowed(commandName, policy) {
  if (!policy) return true;
  const canonical = commandName.startsWith("kxm_") ? commandName : `kxm_${commandName}`;
  const bare = commandName.replace(/^kxm_/, "");
  const denyList = policy.deny ?? policy.deniedTools;
  if (Array.isArray(denyList)) {
    for (const d of denyList) {
      if (d === canonical || d === commandName || d === bare || matchToolPattern(d, canonical)) {
        return false;
      }
    }
  }
  const allowList = policy.allow ?? policy.allowedTools;
  if (Array.isArray(allowList) && allowList.length > 0) {
    const matched = allowList.some(
      (a) => a === canonical || a === commandName || a === bare || a === "*" || matchToolPattern(a, canonical)
    );
    if (!matched) return false;
  }
  if (policy.preset === "read-only") {
    const mutating = [
      "kxm_send",
      "kxm_reply",
      "kxm_cancel",
      "kxm_fanout",
      "kxm_workflow_checkpoint",
      "kxm_workflow_record",
      "kxm_workflow_wait",
      "kxm_promote"
    ];
    if (mutating.includes(canonical)) return false;
  }
  return true;
}
function enforceToolPolicy(commandName, env = process.env) {
  const attemptTokenRaw = env.KXM_ATTEMPT_TOKEN?.trim();
  if (attemptTokenRaw) {
    const attempt = parseAttemptToken(attemptTokenRaw);
    if (!attempt) {
      return { allowed: false, error: "attempt_token_invalid", detail: "KXM_ATTEMPT_TOKEN is malformed" };
    }
    if (!isToolAllowed(commandName, attempt.toolPolicy)) {
      return {
        allowed: false,
        error: "tool_policy_denied",
        detail: `command ${commandName} is denied by attempt tool policy`
      };
    }
    return { allowed: true };
  }
  const sessionTokenRaw = env.KXM_SESSION_TOKEN?.trim();
  if (sessionTokenRaw) {
    const session = parseSessionToken(sessionTokenRaw);
    if (!session) {
      return { allowed: false, error: "session_token_invalid", detail: "KXM_SESSION_TOKEN is malformed" };
    }
    if (!isToolAllowed(commandName, session.toolPolicy)) {
      return {
        allowed: false,
        error: "tool_policy_denied",
        detail: `command ${commandName} is denied by session tool policy`
      };
    }
    return { allowed: true };
  }
  return { allowed: true };
}

// plugins/kxm/src/nous-pi.ts
import { readFile } from "node:fs/promises";

// plugins/kxm/src/nous-provider.ts
import { createHash as createHash2 } from "node:crypto";

// plugins/kxm/src/redact.ts
var SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\bKXM_[A-Z0-9_]*(TOKEN|SECRET|KEY)[A-Z0-9_]*=\S+/gi,
  /\b(GITHUB_TOKEN|GH_TOKEN|KXM_AUTH_TOKEN|KXM_WORKFLOW_SIGNAL_SECRET)=\S+/gi,
  /\b[A-Fa-f0-9]{64}\b/g
];
function redactSecrets(value) {
  let result2 = value;
  for (const pattern of SECRET_PATTERNS) {
    result2 = result2.replace(pattern, "[redacted]");
  }
  return result2;
}

// plugins/kxm/src/nous-provider.ts
var NOUS_DIRECT_ID = "nous";
var NOUS_PROXY_ID = "nous-proxy";
var NOUS_DIRECT_BASE_URL = "https://inference-api.nousresearch.com/v1";
var NOUS_PROXY_DEFAULT_BASE_URL = "http://127.0.0.1:8645/v1";
var NOUS_PROXY_PLACEHOLDER_KEY = "kxm-nous-proxy";
var NOUS_CATALOG_SCHEMA = "kxm.nous-catalog.v1";
var NOUS_PRICE_UNITS = "usd_per_million_tokens";
var DEFAULT_DISCOVERY_TIMEOUT_MS = 5e3;
var NOUS_CATALOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1e3;
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "::1"]);
var PROVIDER_TOKENS = /* @__PURE__ */ new Set(["direct", "proxy"]);
var PER_TOKEN_TO_USD_PER_M = 1e6;
var PI_INPUT_ORDER = ["text", "image"];
function parseNousEnv(env = process.env) {
  const raw = env.KXM_NOUS_PROVIDERS?.trim() ?? "";
  const timeoutMs = parseTimeout(env.KXM_NOUS_DISCOVERY_TIMEOUT_MS);
  if (!raw) {
    return { status: "unset", providers: [], timeoutMs };
  }
  const tokens = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const unknownTokens = [...new Set(tokens.filter((token) => !PROVIDER_TOKENS.has(token)))];
  if (unknownTokens.length > 0) {
    return {
      status: "invalid",
      providers: [],
      unknownTokens,
      timeoutMs,
      error: `unknown KXM_NOUS_PROVIDERS token(s): ${unknownTokens.join(", ")}; expected direct and/or proxy`
    };
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      status: "invalid",
      providers: [],
      unknownTokens: [],
      timeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS,
      error: "KXM_NOUS_DISCOVERY_TIMEOUT_MS must be a positive finite number of milliseconds"
    };
  }
  const providers = [...new Set(tokens)];
  const catalogFile = env.KXM_NOUS_CATALOG_FILE?.trim();
  const proxyOverride = env.KXM_NOUS_PROXY_URL?.trim();
  return {
    status: "ready",
    providers,
    timeoutMs,
    proxyUrl: proxyOverride && proxyOverride.length > 0 ? proxyOverride : NOUS_PROXY_DEFAULT_BASE_URL,
    ...catalogFile ? { catalogFile } : {}
  };
}
function parseTimeout(raw) {
  if (raw === void 0 || raw.trim() === "") return DEFAULT_DISCOVERY_TIMEOUT_MS;
  const value = Number(raw);
  return value;
}
function isLoopbackUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(host);
}
function modelsUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}
function sanitizeNousText(value) {
  const stripped = value.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").replace(/\b(NOUS_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]");
  return redactSecrets(stripped).slice(0, 500);
}
function catalogCanonicalPayload(pin) {
  return canonicalJson({
    recordedAt: pin.recordedAt,
    source: pin.source,
    units: pin.units,
    models: pin.models
  });
}
function catalogHash(pin) {
  return `sha256:${createHash2("sha256").update(catalogCanonicalPayload(pin)).digest("hex")}`;
}
function parseCatalogPin(raw, nowMs = Date.now()) {
  if (!isRecord(raw)) return { ok: false, reason: "catalog is not an object" };
  if (raw.schema !== NOUS_CATALOG_SCHEMA) {
    return { ok: false, reason: `catalog schema must be ${NOUS_CATALOG_SCHEMA}` };
  }
  if (typeof raw.recordedAt !== "string" || Number.isNaN(Date.parse(raw.recordedAt))) {
    return { ok: false, reason: "catalog recordedAt must be an ISO-8601 timestamp" };
  }
  if (typeof raw.source !== "string" || raw.source.trim().length === 0) {
    return { ok: false, reason: "catalog source is required" };
  }
  if (raw.units !== NOUS_PRICE_UNITS) {
    return { ok: false, reason: `catalog units must be ${NOUS_PRICE_UNITS}` };
  }
  if (typeof raw.hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(raw.hash)) {
    return { ok: false, reason: "catalog hash must be sha256:<64 hex>" };
  }
  if (!isRecord(raw.models)) return { ok: false, reason: "catalog models must be an object" };
  const expected = catalogHash({
    recordedAt: raw.recordedAt,
    source: raw.source.trim(),
    units: NOUS_PRICE_UNITS,
    models: raw.models
  });
  if (raw.hash !== expected) {
    return { ok: false, reason: "catalog hash does not match recordedAt/source/units/models" };
  }
  const models = {};
  for (const [id, entry] of Object.entries(raw.models)) {
    const parsed = parsePinModel(id, entry);
    if (!parsed.ok) return parsed;
    models[id] = parsed.model;
  }
  const pin = {
    schema: NOUS_CATALOG_SCHEMA,
    recordedAt: raw.recordedAt,
    source: raw.source.trim(),
    units: NOUS_PRICE_UNITS,
    hash: raw.hash,
    models
  };
  const recordedAtMs = Date.parse(pin.recordedAt);
  if (recordedAtMs > nowMs + 6e4) {
    return { ok: false, reason: "catalog recordedAt is in the future" };
  }
  if (nowMs - recordedAtMs > NOUS_CATALOG_MAX_AGE_MS) {
    return { ok: false, reason: "catalog is stale (recordedAt older than 30 days)" };
  }
  return { ok: true, pin };
}
function parsePinModel(id, entry) {
  if (!id.trim()) return { ok: false, reason: "catalog model id is empty" };
  if (!isRecord(entry)) return { ok: false, reason: `catalog model ${id} is not an object` };
  const contextWindow = asPositiveInt(entry.contextWindow);
  const maxTokens = asPositiveInt(entry.maxTokens);
  if (contextWindow === void 0 || maxTokens === void 0) {
    return { ok: false, reason: `catalog model ${id} is missing positive contextWindow/maxTokens` };
  }
  if (entry.priceBasis !== "list" && entry.priceBasis !== "upper-bound") {
    return { ok: false, reason: `catalog model ${id} priceBasis must be list or upper-bound` };
  }
  if (entry.billing !== "metered" && entry.billing !== "subscription" && entry.billing !== "subscription_plus_usage") {
    return { ok: false, reason: `catalog model ${id} billing must be metered, subscription, or subscription_plus_usage` };
  }
  if (typeof entry.verified !== "boolean") {
    return { ok: false, reason: `catalog model ${id} verified must be a boolean` };
  }
  const rates = parseRates(entry.cost);
  if (!rates) return { ok: false, reason: `catalog model ${id} cost rates must be finite nonnegative numbers` };
  let cost = rates;
  let priceBasis = entry.priceBasis;
  if (entry.tiers !== void 0) {
    if (!Array.isArray(entry.tiers) || entry.tiers.length === 0) {
      return { ok: false, reason: `catalog model ${id} tiers must be a nonempty array when present` };
    }
    const tierRates = [rates];
    for (const tier of entry.tiers) {
      if (!isRecord(tier)) return { ok: false, reason: `catalog model ${id} has a malformed tier` };
      const parsedTier = parseRates(tier);
      if (!parsedTier) return { ok: false, reason: `catalog model ${id} tier rates must be finite nonnegative numbers` };
      if (asNonnegInt(tier.inputTokensAbove) === void 0) {
        return { ok: false, reason: `catalog model ${id} tier is missing inputTokensAbove` };
      }
      tierRates.push(parsedTier);
    }
    cost = upperBoundRates(tierRates);
    priceBasis = "upper-bound";
  }
  if (!entry.verified && hasZeroRate(cost)) {
    return { ok: false, reason: `catalog model ${id} has unverified zero rates` };
  }
  return {
    ok: true,
    model: {
      contextWindow,
      maxTokens,
      cost,
      priceBasis,
      billing: entry.billing,
      verified: entry.verified,
      ...typeof entry.name === "string" && entry.name.trim() ? { name: entry.name.trim() } : {}
    }
  };
}
function parseModelsResponse(raw) {
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    return { ok: false, error: "invalid", reason: "models response is not an object with a data array" };
  }
  const models = [];
  for (const item of raw.data) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) {
      return { ok: false, error: "invalid", reason: "models response contains an entry without an id" };
    }
    const model = { id: item.id.trim() };
    if (typeof item.name === "string" && item.name.trim()) model.name = item.name.trim();
    const topProvider = isRecord(item.top_provider) ? item.top_provider : void 0;
    const contextWindow = asPositiveInt(item.contextWindow ?? item.context_window ?? item.context_length);
    const maxTokens = asPositiveInt(
      item.maxTokens ?? item.max_tokens ?? item.max_output_tokens ?? topProvider?.max_completion_tokens
    );
    if (contextWindow !== void 0) model.contextWindow = contextWindow;
    if (maxTokens !== void 0) model.maxTokens = maxTokens;
    if (typeof item.units === "string") model.units = item.units;
    if (typeof item.verified === "boolean") model.verified = item.verified;
    const architecture = isRecord(item.architecture) ? item.architecture : void 0;
    if (architecture && "input_modalities" in architecture) {
      const input = parseInputModalities(architecture.input_modalities);
      if (!input) model.capabilityIssue = "unknown input modalities";
      else model.input = input;
    }
    const supported = parseSupportedParameters(item.supported_parameters);
    if (supported) {
      model.reasoning = supported.reasoning;
      model.tools = supported.tools;
    }
    if (isRecord(item.pricing)) {
      const live = parseLivePricing(item.pricing);
      if (!live) {
        model.pricingIssue = "malformed or incomplete live pricing; costly tiers are not dropped and zeros are not guessed";
      } else {
        model.cost = live.cost;
        model.units = NOUS_PRICE_UNITS;
        if (live.tiers.length > 0) model.tiers = live.tiers;
      }
    } else {
      const cost = isRecord(item.cost) ? parseRates(item.cost) : void 0;
      if (cost) model.cost = cost;
      if (Array.isArray(item.tiers)) {
        const tiers = [];
        for (const tier of item.tiers) {
          if (!isRecord(tier)) {
            model.pricingIssue = "malformed assumed-shape tier";
            break;
          }
          const rates = parseRates(tier);
          const above = asNonnegInt(tier.inputTokensAbove ?? tier.input_tokens_above);
          if (!rates || above === void 0) {
            model.pricingIssue = "incomplete assumed-shape tier";
            break;
          }
          tiers.push({ ...rates, inputTokensAbove: above });
        }
        if (!model.pricingIssue && tiers.length > 0) model.tiers = tiers;
        if (model.pricingIssue) {
          delete model.cost;
          delete model.tiers;
        }
      }
    }
    models.push(model);
  }
  return { ok: true, models };
}
async function fetchNousModels(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const headers = { Accept: "application/json" };
    if (options.authorization) headers.Authorization = `Bearer ${options.authorization}`;
    const response = await fetchImpl(options.url, { method: "GET", headers, signal: controller.signal });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: "auth", status: response.status, reason: `HTTP ${response.status}` };
    }
    if (!response.ok) {
      return { ok: false, error: "http", status: response.status, reason: `HTTP ${response.status}` };
    }
    let text;
    try {
      text = await response.text();
    } catch {
      return { ok: false, error: "invalid", reason: "models response is not JSON" };
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, error: "invalid", reason: "models response is not JSON" };
    }
    const parsed = parseModelsResponse(payload);
    if (!parsed.ok) return parsed;
    return {
      ...parsed,
      provenance: {
        source: options.url,
        fetchedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
        rawSha256: `sha256:${createHash2("sha256").update(text).digest("hex")}`
      }
    };
  } catch (error) {
    if (isAbortError(error)) {
      return { ok: false, error: "timeout", reason: `discovery timed out after ${options.timeoutMs}ms` };
    }
    if (isConnectionRefused(error)) {
      return { ok: false, error: "connection-refused", reason: "connection refused" };
    }
    return { ok: false, error: "http", reason: sanitizeNousText(error instanceof Error ? error.message : "discovery failed") };
  } finally {
    clearTimeout(timer);
  }
}
function buildModelConfigs(discovered, pin, route) {
  const registered = [];
  const skipped = [];
  const requiredBilling = route === "direct" ? ["metered"] : ["subscription", "subscription_plus_usage"];
  for (const item of discovered) {
    if (item.capabilityIssue) {
      skipped.push({ id: item.id, reason: `excluded: ${item.capabilityIssue}` });
      continue;
    }
    const fromPin = pin?.models[item.id];
    if (item.pricingIssue && !fromPin) {
      skipped.push({ id: item.id, reason: `unpriced, not registered: ${item.pricingIssue}` });
      continue;
    }
    const capacity = {
      contextWindow: fromPin?.contextWindow ?? item.contextWindow,
      maxTokens: fromPin?.maxTokens ?? item.maxTokens
    };
    if (capacity.contextWindow === void 0 || capacity.maxTokens === void 0) {
      skipped.push({ id: item.id, reason: "unpriced, not registered: missing contextWindow or maxTokens" });
      continue;
    }
    let cost;
    let priceBasis = "list";
    let verified = false;
    let tiers;
    if (fromPin) {
      cost = fromPin.cost;
      priceBasis = fromPin.priceBasis;
      verified = fromPin.verified;
    } else {
      const rateSources = [];
      if (item.cost) rateSources.push(item.cost);
      if (item.tiers && item.tiers.length > 0) rateSources.push(...item.tiers);
      if (rateSources.length === 0) {
        skipped.push({ id: item.id, reason: "unpriced, not registered: no numeric cost rates and no catalog pin" });
        continue;
      }
      if (item.units !== NOUS_PRICE_UNITS) {
        skipped.push({ id: item.id, reason: `unpriced, not registered: units must be ${NOUS_PRICE_UNITS}` });
        continue;
      }
      if (item.tiers && item.tiers.length > 0) {
        priceBasis = "upper-bound";
        cost = upperBoundRates(rateSources);
        tiers = item.tiers;
      } else {
        cost = item.cost;
      }
      verified = item.verified === true;
    }
    if (!cost) {
      skipped.push({ id: item.id, reason: "unpriced, not registered" });
      continue;
    }
    if (hasZeroRate(cost) && !verified) {
      skipped.push({ id: item.id, reason: "unpriced, not registered: unverified zero rates" });
      continue;
    }
    const billing = fromPin?.billing ?? (route === "direct" ? "metered" : "subscription");
    if (!requiredBilling.includes(billing)) {
      skipped.push({ id: item.id, reason: `excluded: billing ${billing} is not valid for ${route}` });
      continue;
    }
    const display = labeledModelName(fromPin?.name ?? item.name ?? item.id, route, priceBasis);
    registered.push({
      id: item.id,
      name: display,
      contextWindow: capacity.contextWindow,
      maxTokens: capacity.maxTokens,
      cost,
      priceBasis,
      billing,
      verified,
      ...item.input ? { input: item.input } : {},
      ...item.reasoning !== void 0 ? { reasoning: item.reasoning } : {},
      ...item.tools !== void 0 ? { tools: item.tools } : {},
      ...tiers ? { tiers } : {}
    });
  }
  return { registered, skipped };
}
function guidanceFor(input) {
  const messages = [];
  if (input.parsed.status === "invalid") {
    messages.push({ message: input.parsed.error, level: "error" });
    return messages;
  }
  if (input.parsed.status !== "ready") return messages;
  if (input.parsed.providers.includes("direct") && !input.directHasKey) {
    messages.push({
      message: "Nous direct API is opted in but NOUS_API_KEY is unset. Set NOUS_API_KEY. This slice does not use stored Pi /login credentials.",
      level: "info"
    });
  }
  if (input.proxyUrlInvalid) {
    messages.push({
      message: "KXM_NOUS_PROXY_URL must be a loopback http(s) URL (127.0.0.1, localhost, or ::1). Failing closed.",
      level: "error"
    });
  }
  if (input.proxyDiscovery?.ok === false && input.proxyDiscovery.error === "connection-refused") {
    messages.push({
      message: "Nous proxy is not reachable. Start it with `hermes proxy start` and check `hermes proxy status`. KXM does not install, spawn, or log in for you.",
      level: "info"
    });
  }
  if (input.proxyDiscovery?.ok === false && input.proxyDiscovery.error === "auth") {
    messages.push({
      message: "Nous proxy returned unauthorized. Log in with `hermes login --provider nous`. Newer docs also mention `hermes setup --portal` (not verified on this CLI).",
      level: "info"
    });
  }
  if (input.directDiscovery?.ok === false && input.directDiscovery.error === "timeout") {
    messages.push({ message: `Nous direct discovery ${input.directDiscovery.reason}.`, level: "info" });
  }
  if (input.proxyDiscovery?.ok === false && input.proxyDiscovery.error === "timeout") {
    messages.push({ message: `Nous proxy discovery ${input.proxyDiscovery.reason}.`, level: "info" });
  }
  if (input.catalogError) {
    messages.push({ message: `Nous catalog pin not used: ${input.catalogError}.`, level: "error" });
  }
  if (input.skipped && input.skipped.length > 0) {
    const preview = input.skipped.slice(0, 8).map((item) => `${item.id} (${item.reason})`).join("; ");
    messages.push({
      message: `Skipped ${input.skipped.length} Nous model(s) as unpriced or invalid: ${preview}.`,
      level: "info"
    });
  }
  return messages.map((item) => ({ ...item, message: sanitizeNousText(item.message) }));
}
function labeledModelName(base, route, priceBasis) {
  if (route === "proxy") {
    return priceBasis === "upper-bound" ? `${base} (subscription proxy, market ref; upper-bound)` : `${base} (subscription proxy, market ref)`;
  }
  return priceBasis === "upper-bound" ? `${base} (upper-bound market ref)` : base;
}
function parseLivePricing(pricing) {
  const cost = parseLiveRates(pricing);
  if (!cost) return void 0;
  if (!("overrides" in pricing) || pricing.overrides === void 0) {
    return { cost, tiers: [] };
  }
  if (!Array.isArray(pricing.overrides)) return void 0;
  const tiers = [];
  for (const override of pricing.overrides) {
    if (!isRecord(override)) return void 0;
    const rates = parseLiveRates(override);
    const above = asNonnegInt(override.min_prompt_tokens ?? override.minPromptTokens);
    if (!rates || above === void 0) return void 0;
    tiers.push({ ...rates, inputTokensAbove: above });
  }
  return { cost, tiers };
}
function parseLiveRates(value) {
  const input = perTokenToUsdPerM(value.prompt);
  const output = perTokenToUsdPerM(value.completion);
  const cacheRead = perTokenToUsdPerM(value.input_cache_read ?? value.inputCacheRead);
  const cacheWrite = perTokenToUsdPerM(value.input_cache_write ?? value.inputCacheWrite);
  if (input === void 0 || output === void 0 || cacheRead === void 0 || cacheWrite === void 0) return void 0;
  return { input, output, cacheRead, cacheWrite };
}
function perTokenToUsdPerM(value) {
  let perToken;
  if (typeof value === "number") perToken = value;
  else if (typeof value === "string" && value.trim() !== "") perToken = Number(value);
  if (perToken === void 0 || !Number.isFinite(perToken) || perToken < 0) return void 0;
  const usdPerM = Number((perToken * PER_TOKEN_TO_USD_PER_M).toFixed(8));
  if (!Number.isFinite(usdPerM) || usdPerM < 0) return void 0;
  return usdPerM;
}
function parseInputModalities(value) {
  if (!Array.isArray(value)) return void 0;
  const present = new Set(value.filter((item) => item === "text" || item === "image"));
  const mapped = PI_INPUT_ORDER.filter((item) => present.has(item));
  return mapped.length > 0 ? mapped : void 0;
}
function parseSupportedParameters(value) {
  if (!Array.isArray(value)) return void 0;
  const params = new Set(value.filter((item) => typeof item === "string"));
  return {
    reasoning: params.has("reasoning") || params.has("include_reasoning"),
    tools: params.has("tools") || params.has("tool_choice")
  };
}
function parseRates(value) {
  if (!isRecord(value)) return void 0;
  const input = asFiniteNonneg(value.input);
  const output = asFiniteNonneg(value.output);
  const cacheRead = asFiniteNonneg(value.cacheRead ?? value.cache_read ?? value.cache_input);
  const cacheWrite = asFiniteNonneg(value.cacheWrite ?? value.cache_write);
  if (input === void 0 || output === void 0 || cacheRead === void 0 || cacheWrite === void 0) return void 0;
  return { input, output, cacheRead, cacheWrite };
}
function upperBoundRates(list) {
  return {
    input: Math.max(...list.map((item) => item.input)),
    output: Math.max(...list.map((item) => item.output)),
    cacheRead: Math.max(...list.map((item) => item.cacheRead)),
    cacheWrite: Math.max(...list.map((item) => item.cacheWrite))
  };
}
function hasZeroRate(cost) {
  return cost.input === 0 || cost.output === 0 || cost.cacheRead === 0 || cost.cacheWrite === 0;
}
function asFiniteNonneg(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return void 0;
  return value;
}
function asPositiveInt(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return void 0;
  return value;
}
function asNonnegInt(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return void 0;
  return value;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function isAbortError(error) {
  if (!error || typeof error !== "object") return false;
  const name = error.name;
  return name === "AbortError" || name === "TimeoutError";
}
function isConnectionRefused(error) {
  const codes = [];
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = current.code;
    if (typeof code === "string") codes.push(code);
    const message = current.message;
    if (typeof message === "string" && /ECONNREFUSED/i.test(message)) return true;
    current = current.cause;
  }
  return codes.includes("ECONNREFUSED");
}

// plugins/kxm/src/nous-pi.ts
var emptySide = (id) => ({ id, registered: 0, skipped: 0 });
function emptyNousReport() {
  return {
    optedIn: false,
    direct: emptySide(NOUS_DIRECT_ID),
    proxy: emptySide(NOUS_PROXY_ID),
    guidance: [],
    registeredProviders: []
  };
}
function nousFactoryWork(pi, onReport, deps = {}) {
  const env = deps.env ?? process.env;
  const parsed = parseNousEnv(env);
  if (parsed.status === "unset") {
    onReport(emptyNousReport());
    return;
  }
  if (parsed.status === "invalid") {
    onReport({
      ...emptyNousReport(),
      optedIn: true,
      guidance: guidanceFor({ parsed })
    });
    return;
  }
  return registerNousProviders(pi, deps).then(onReport);
}
async function registerNousProviders(pi, deps = {}) {
  const env = deps.env ?? process.env;
  const parsed = parseNousEnv(env);
  if (parsed.status === "unset") return emptyNousReport();
  if (parsed.status === "invalid") {
    return { ...emptyNousReport(), optedIn: true, guidance: guidanceFor({ parsed }) };
  }
  const report = emptyNousReport();
  report.optedIn = true;
  let pin;
  let catalogError;
  if (parsed.catalogFile) {
    const loaded = await loadCatalog(parsed.catalogFile, deps);
    if (loaded.ok) pin = loaded.pin;
    else catalogError = loaded.reason;
  }
  const skipped = [];
  let directDiscovery;
  let proxyDiscovery;
  let proxyUrlInvalid = false;
  const directHasKey = hasDirectKey(env);
  if (parsed.providers.includes("direct")) {
    const result2 = await registerRoute({
      pi,
      route: "direct",
      env,
      parsed,
      pin,
      hasKey: directHasKey,
      ...deps.fetch ? { fetchImpl: deps.fetch } : {},
      ...deps.nowMs !== void 0 ? { nowMs: deps.nowMs } : {}
    });
    report.direct = result2.side;
    directDiscovery = result2.discovery;
    skipped.push(...result2.skipped);
    if (result2.registered) report.registeredProviders.push(NOUS_DIRECT_ID);
  }
  if (parsed.providers.includes("proxy")) {
    if (!isLoopbackUrl(parsed.proxyUrl)) {
      proxyUrlInvalid = true;
      report.proxy = {
        id: NOUS_PROXY_ID,
        registered: 0,
        skipped: 0,
        error: "non-loopback",
        reason: "proxy URL is not loopback http(s)"
      };
    } else {
      const result2 = await registerRoute({
        pi,
        route: "proxy",
        env,
        parsed,
        pin,
        hasKey: true,
        ...deps.fetch ? { fetchImpl: deps.fetch } : {},
        ...deps.nowMs !== void 0 ? { nowMs: deps.nowMs } : {}
      });
      report.proxy = result2.side;
      proxyDiscovery = result2.discovery;
      skipped.push(...result2.skipped);
      if (result2.registered) report.registeredProviders.push(NOUS_PROXY_ID);
    }
  }
  report.guidance = guidanceFor({
    parsed,
    directHasKey,
    proxyUrlInvalid,
    skipped,
    ...directDiscovery ? { directDiscovery } : {},
    ...proxyDiscovery ? { proxyDiscovery } : {},
    ...catalogError ? { catalogError } : {}
  });
  return report;
}
async function registerRoute(input) {
  const providerId = input.route === "direct" ? NOUS_DIRECT_ID : NOUS_PROXY_ID;
  const baseUrl = input.route === "direct" ? NOUS_DIRECT_BASE_URL : input.parsed.proxyUrl;
  const side = { id: providerId, registered: 0, skipped: 0 };
  if (input.route === "direct" && !input.hasKey) {
    registerLegacy(input.pi, providerId, baseUrl, "$NOUS_API_KEY", []);
    return { side, skipped: [], registered: true };
  }
  const authorization = input.route === "direct" ? input.env.NOUS_API_KEY : NOUS_PROXY_PLACEHOLDER_KEY;
  const discovery = await fetchNousModels({
    url: modelsUrl(baseUrl),
    timeoutMs: input.parsed.timeoutMs,
    ...authorization ? { authorization } : {},
    ...input.fetchImpl ? { fetchImpl: input.fetchImpl } : {},
    ...input.nowMs !== void 0 ? { nowMs: input.nowMs } : {}
  });
  if (!discovery.ok) {
    side.error = discovery.error;
    side.reason = discovery.reason;
    registerLegacy(input.pi, providerId, baseUrl, apiKeyRef(input.route), []);
    return { side, discovery, skipped: [], registered: true };
  }
  if (discovery.provenance) side.provenance = discovery.provenance;
  const built = buildModelConfigs(discovery.models, input.pin, input.route);
  side.registered = built.registered.length;
  side.skipped = built.skipped.length;
  registerLegacy(input.pi, providerId, baseUrl, apiKeyRef(input.route), built.registered);
  return { side, discovery, skipped: built.skipped, registered: true };
}
function apiKeyRef(route) {
  return route === "direct" ? "$NOUS_API_KEY" : NOUS_PROXY_PLACEHOLDER_KEY;
}
function registerLegacy(pi, id, baseUrl, apiKey, models) {
  if (typeof pi.registerProvider !== "function") {
    throw new Error("Pi registerProvider is unavailable");
  }
  pi.registerProvider(id, {
    name: id === NOUS_DIRECT_ID ? "Nous" : "Nous subscription proxy",
    baseUrl,
    apiKey,
    api: "openai-completions",
    authHeader: true,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning === true,
      input: model.input && model.input.length > 0 ? model.input : ["text"],
      // Upper-bound rates only: Pi cost.tiers uses strict > and can underquote.
      cost: {
        input: model.cost.input,
        output: model.cost.output,
        cacheRead: model.cost.cacheRead,
        cacheWrite: model.cost.cacheWrite
      },
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens
    }))
  });
}
function hasDirectKey(env) {
  const key = env.NOUS_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}
async function loadCatalog(path, deps) {
  try {
    const read = deps.readFile ?? ((filePath) => readFile(filePath, "utf8"));
    const text = await read(path);
    return parseCatalogPin(JSON.parse(text), deps.nowMs ?? Date.now());
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, reason: "catalog file is not valid JSON" };
    }
    return { ok: false, reason: sanitizeNousText(error instanceof Error ? error.message : "catalog file could not be read") };
  }
}

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
import { createHash as createHash3 } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
function workerStateKey(project, agentName) {
  const safeProject = project.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 24) || "project";
  const safeName = agentName.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 32) || "agent";
  const digest = createHash3("sha256").update(JSON.stringify({ project, agentName })).digest("hex").slice(0, 24);
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
import { randomUUID } from "node:crypto";
import { existsSync as existsSync4, mkdirSync as mkdirSync4, readFileSync as readFileSync6, renameSync as renameSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join5 } from "node:path";

// plugins/kxm/src/local-snapshot.ts
import { existsSync, readdirSync, readFileSync as readFileSync3 } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join as join2, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// plugins/kxm/src/telemetry.ts
import { appendFileSync, mkdirSync, readFileSync as readFileSync2 } from "node:fs";
function readRoutingRecords(path) {
  const records = [];
  try {
    const raw = readFileSync2(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        let routingObj;
        const recordedAt = typeof parsed.recordedAt === "string" ? parsed.recordedAt : typeof parsed.timestamp === "string" ? parsed.timestamp : (/* @__PURE__ */ new Date()).toISOString();
        if (parsed.schema === "kxm.routing-record.v2" || parsed.schema === "kxm.routing-record.v1") {
          routingObj = parsed;
        } else if (parsed.routing && typeof parsed.routing === "object") {
          routingObj = parsed.routing;
        } else if (parsed.envelope && typeof parsed.envelope === "object" && parsed.envelope.routing) {
          routingObj = parsed.envelope.routing;
        } else if (parsed.eventType === "routing.attempt.recorded" && parsed.payload && typeof parsed.payload === "object") {
          routingObj = parsed.payload.routing;
        }
        if (routingObj && typeof routingObj === "object") {
          const r = routingObj;
          if (r.schema === "kxm.routing-record.v2" || r.schema === "kxm.routing-record.v1") {
            records.push({ recordedAt, routing: r });
          }
        }
      } catch {
      }
    }
  } catch {
  }
  return records;
}

// plugins/kxm/src/local-snapshot.ts
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
function resolveVnextStateRoot(stateDir, options) {
  if (options?.vnextStateRoot && existsSync(options.vnextStateRoot)) {
    return resolve(options.vnextStateRoot);
  }
  if (existsSync(join2(stateDir, "runtime", "registry.db")) || existsSync(join2(stateDir, "runtime", "projects"))) {
    return stateDir;
  }
  const env = options?.env ?? process.env;
  const explicit = env.KXM_STATE_HOME?.trim() || env.KXM_USER_STATE_DIR?.trim() || env.KXM_STATE_ROOT?.trim();
  if (explicit && isAbsolute(explicit) && existsSync(resolve(explicit))) {
    return resolve(explicit);
  }
  let base;
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    base = localAppData && isAbsolute(localAppData) ? localAppData : join2(homedir(), "AppData", "Local");
    base = resolve(base, "KXM");
  } else if (process.platform === "darwin") {
    base = resolve(homedir(), "Library", "Application Support", "KXM");
  } else {
    const xdgState = env.XDG_STATE_HOME?.trim();
    base = xdgState && isAbsolute(xdgState) ? xdgState : join2(homedir(), ".local", "state");
    base = resolve(base, "kxm");
  }
  if (existsSync(base)) return base;
  return void 0;
}
function loadLocalMeshSnapshot(dataPath, stateDir, options) {
  let hasLegacy = false;
  let agents = [];
  let openMessages = [];
  let openMessageTotal = 0;
  let legacyRuns = [];
  let legacyRunTotal = 0;
  let plans = [];
  if (existsSync(dataPath)) {
    hasLegacy = true;
    const database = new DatabaseSync(dataPath, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      agents = readJsonRows(database, "SELECT record FROM agents");
      openMessages = readOpenMessageMetadata(database);
      openMessageTotal = countRows(database, "messages", " WHERE json_extract(record, '$.status') IN ('queued', 'delivered')");
      legacyRuns = readJsonRows(database, "SELECT record FROM workflow_runs ORDER BY rowid DESC LIMIT 8");
      legacyRunTotal = countRows(database, "workflow_runs");
      plans = readPlanMetadata(database);
    } finally {
      database.close();
    }
  }
  let hasVnext = false;
  const vnextRuns = [];
  let vnextRunTotal = 0;
  const vnextStateRoot = resolveVnextStateRoot(stateDir, options);
  if (vnextStateRoot) {
    const runtimeDir = join2(vnextStateRoot, "runtime");
    const registryDbPath = join2(runtimeDir, "registry.db");
    const projectsDir = join2(runtimeDir, "projects");
    const projectKeys = /* @__PURE__ */ new Set();
    if (existsSync(registryDbPath)) {
      hasVnext = true;
      try {
        const regDb = new DatabaseSync(registryDbPath, { readOnly: true });
        try {
          regDb.exec("PRAGMA busy_timeout = 5000");
          const pRows = regDb.prepare("SELECT project_key FROM projects").all();
          for (const row of pRows) {
            if (row.project_key) projectKeys.add(row.project_key);
          }
        } finally {
          regDb.close();
        }
      } catch {
      }
    }
    if (existsSync(projectsDir)) {
      try {
        for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            projectKeys.add(entry.name);
          }
        }
      } catch {
      }
    }
    for (const key of projectKeys) {
      const eventDbPath = join2(projectsDir, key, "run-events.db");
      if (existsSync(eventDbPath)) {
        hasVnext = true;
        try {
          const eventDb = new DatabaseSync(eventDbPath, { readOnly: true });
          try {
            eventDb.exec("PRAGMA busy_timeout = 5000");
            const runRows = eventDb.prepare(`
              SELECT run_id, project_id, workflow_id, status, created_at, updated_at
              FROM runs ORDER BY created_at DESC, run_id DESC LIMIT 8
            `).all();
            const countRow = eventDb.prepare("SELECT COUNT(*) AS total FROM runs").get();
            vnextRunTotal += Number(countRow?.total ?? runRows.length);
            for (const r of runRows) {
              vnextRuns.push({
                id: r.run_id,
                status: r.status,
                definitionId: r.workflow_id,
                project: r.project_id,
                updatedAt: r.updated_at || r.created_at
              });
            }
          } finally {
            eventDb.close();
          }
        } catch {
        }
      }
    }
  }
  const pids = [];
  if (existsSync(stateDir)) {
    for (const file of readdirSync(stateDir).filter((name) => name.endsWith(".pid"))) {
      try {
        const record = JSON.parse(readFileSync3(join2(stateDir, file), "utf8"));
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
  const combinedRuns = [
    ...legacyRuns.map((run) => summarizeMeshRun(run)),
    ...vnextRuns
  ];
  const seenIds = /* @__PURE__ */ new Set();
  const uniqueRuns = [];
  for (const run of combinedRuns) {
    if (!seenIds.has(run.id)) {
      seenIds.add(run.id);
      uniqueRuns.push(run);
    }
  }
  uniqueRuns.sort((a, b) => {
    const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return bt - at;
  });
  const runs = uniqueRuns.slice(0, 16);
  const runTotal = legacyRunTotal + vnextRunTotal;
  let source;
  if (hasLegacy && hasVnext) {
    source = "both";
  } else if (hasVnext) {
    source = "vnext";
  } else {
    source = "legacy";
  }
  const telemetryFile = join2(stateDir, "telemetry.jsonl");
  const spend = existsSync(telemetryFile) ? readRoutingRecords(telemetryFile) : [];
  return {
    source,
    agents: agents.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
    openMessages,
    openMessageTotal,
    runs,
    runTotal,
    plans,
    pids,
    spend
  };
}

// plugins/kxm/src/kxm-update.ts
import { existsSync as existsSync2, readFileSync as readFileSync4, writeFileSync, mkdirSync as mkdirSync2 } from "node:fs";
import { join as join3 } from "node:path";
var KXM_UPDATE_CACHE = "update-check.json";
var CACHE_TTL_MS = 6 * 60 * 60 * 1e3;
function readUpdateCache(stateDir, now = Date.now()) {
  const path = join3(stateDir, KXM_UPDATE_CACHE);
  if (!existsSync2(path)) return void 0;
  try {
    const row = JSON.parse(readFileSync4(path, "utf8"));
    if (typeof row.checkedAt !== "number" || !row.notice || now - row.checkedAt > CACHE_TTL_MS) return void 0;
    if (typeof row.notice.current !== "string" || typeof row.notice.available !== "boolean") return void 0;
    return row.notice;
  } catch {
    return void 0;
  }
}

// plugins/kxm/src/hub-binding.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync5, renameSync as renameSync2, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname, isAbsolute as isAbsolute2, join as join4, resolve as resolve2 } from "node:path";
var HUB_BINDING_SCHEMA = "kxm.hub-binding.v1";
var HUB_HEALTH_PROBE_MS = 300;
var HubBindingError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "HubBindingError";
  }
};
function resolveUserStateRoot(env) {
  const explicit = env.KXM_STATE_HOME?.trim();
  if (explicit) {
    if (!isAbsolute2(explicit)) throw new HubBindingError("local_state_root_not_absolute");
    return resolve2(explicit);
  }
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    const base2 = localAppData && isAbsolute2(localAppData) ? localAppData : join4(homedir2(), "AppData", "Local");
    return resolve2(base2, "KXM");
  }
  if (process.platform === "darwin") return resolve2(homedir2(), "Library", "Application Support", "KXM");
  const xdgState = env.XDG_STATE_HOME?.trim();
  const base = xdgState && isAbsolute2(xdgState) ? xdgState : join4(homedir2(), ".local", "state");
  return resolve2(base, "kxm");
}
function hubBindingFile(env = process.env) {
  return join4(resolveUserStateRoot(env), "hub-binding.json");
}
function validateHubUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HubBindingError("hub_url_invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" || raw.includes("?") || raw.includes("#")) {
    throw new HubBindingError("hub_url_invalid");
  }
  return parsed.href.replace(/\/$/, "");
}
function isIsoTimestamp(value) {
  if (Number.isNaN(Date.parse(value))) return false;
  return value === new Date(value).toISOString();
}
function isAbortError2(error) {
  return Boolean(
    error && typeof error === "object" && ("name" in error && error.name === "AbortError" || "code" in error && error.code === "ABORT_ERR")
  );
}
function readHubBinding(env = process.env) {
  const file = hubBindingFile(env);
  if (!existsSync3(file)) return void 0;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync5(file, "utf8"));
  } catch {
    throw new HubBindingError(`malformed hub binding at ${file}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HubBindingError(`malformed hub binding at ${file}`);
  }
  const row = parsed;
  const keys = Object.keys(row);
  if (keys.length !== 3 || row.schema !== HUB_BINDING_SCHEMA || typeof row.url !== "string" || typeof row.boundAt !== "string" || !isIsoTimestamp(row.boundAt)) {
    throw new HubBindingError(`malformed hub binding at ${file}`);
  }
  let url;
  try {
    url = validateHubUrl(row.url);
  } catch {
    throw new HubBindingError(`malformed hub binding at ${file}`);
  }
  return { schema: HUB_BINDING_SCHEMA, url, boundAt: row.boundAt };
}
async function probeHubHealth(url, fetchImpl, timeoutMs = HUB_HEALTH_PROBE_MS) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${url}/health`, { signal: controller.signal });
    if (!response.ok) return { health: "unknown", probeMs: Date.now() - started };
    let body;
    try {
      body = await response.json();
    } catch {
      return { health: "unknown", probeMs: Date.now() - started };
    }
    if (body && typeof body === "object" && body.ok === true) {
      return { health: "on", probeMs: Date.now() - started };
    }
    return { health: "unknown", probeMs: Date.now() - started };
  } catch (error) {
    return { health: isAbortError2(error) ? "unknown" : "off", probeMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// plugins/kxm/src/session-work.ts
var SESSION_BRIEF_SKIP_LABEL = "Skip \u2014 start a fresh session";
var MAX_SESSION_BRIEF_TASKS = 5;
var MAX_SESSION_BRIEF_PLANS = 5;
var SESSION_BRIEF_SCHEMA = "kxm.session-brief.v1";
var DEFAULT_SESSION_BRIEF_STALE_SECONDS = 5;
function hubPrefix(hub) {
  if (hub?.state === "on" || hub?.state === void 0 && hub?.online === true) return "kxm hub:on";
  if (hub?.state === "off" || hub?.state === void 0 && hub?.online === false) return "kxm hub:off";
  if (hub?.state === "unknown") return "kxm hub:unknown";
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
  const active = runs.filter(
    (run) => run.status === "running" || run.status === "waiting" || run.status === "created" || run.status === "preparing"
  );
  const rest = runs.filter(
    (run) => run.status !== "running" && run.status !== "waiting" && run.status !== "created" && run.status !== "preparing"
  );
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
    const isDirty = dirty.stdout.trim().length > 0;
    const upstream = spawnSync("git", ["-C", cwd, "rev-list", "--count", "@{u}..HEAD"], { encoding: "utf8", windowsHide: true });
    if (upstream.status === 0) {
      return {
        dirty: isDirty,
        ahead: Number.parseInt(upstream.stdout.trim(), 10) || 0
      };
    }
    for (const baseRef of ["origin/HEAD", "main", "origin/main", "master", "origin/master"]) {
      const mb = spawnSync("git", ["-C", cwd, "merge-base", baseRef, "HEAD"], { encoding: "utf8", windowsHide: true });
      if (mb.status === 0 && mb.stdout.trim()) {
        const count = spawnSync("git", ["-C", cwd, "rev-list", "--count", `${mb.stdout.trim()}..HEAD`], { encoding: "utf8", windowsHide: true });
        if (count.status === 0) {
          return {
            dirty: isDirty,
            ahead: Number.parseInt(count.stdout.trim(), 10) || 0
          };
        }
      }
    }
    return {
      dirty: isDirty,
      ahead: 0
    };
  } catch {
    return void 0;
  }
}
function formatSessionStatusLine(stats, current, hub, ship, updateLatest, cost) {
  const head = hubPrefix(hub);
  if (!current && stats.activeTasks === 0 && stats.planCount === 0 && stats.inbox === 0) {
    const idle = hub?.online === void 0 && hub?.state === void 0 ? "kxm idle" : `${head} \xB7 idle`;
    const withShip = ship?.dirty ? `${idle} \xB7 dirty` : ship && ship.ahead > 0 ? `${idle} \xB7 ${ship.ahead} local` : idle;
    const withCost = cost ? `${withShip} \xB7 ${cost}` : withShip;
    const finalLine = updateLatest ? `${withCost} \xB7 upd ${updateLatest}` : withCost;
    return finalLine.length <= 80 ? finalLine : `${finalLine.slice(0, 79)}\u2026`;
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
  if (cost) parts.push(cost);
  if (updateLatest) parts.push(`upd ${updateLatest}`);
  const line = parts.join(" \xB7 ");
  return line.length <= 80 ? line : `${line.slice(0, 79)}\u2026`;
}
function formatSessionWidget(stats, current, hub, ship, updateLatest, cost) {
  const hubMark = hub?.state === "on" || hub?.online === true ? "hub:on  " : hub?.state === "off" || hub?.online === false ? "hub:off  " : hub?.state === "unknown" ? "hub:unknown  " : "";
  const lines = [
    `KXM  ${hubMark}${stats.activeTasks} tasks  ${stats.waitingTasks} waiting  ${stats.planCount} plans  inbox ${stats.inbox}`
  ];
  if (current) lines.push(`now  ${current.kind}  ${truncate(current.detail, 56)}`);
  else if (stats.latestPlan) lines.push(`plan ${truncate(stats.latestPlan, 60)}`);
  else lines.push("now  no selected work");
  lines.push(formatShipLine(ship));
  if (cost) lines.push(`cost  ${cost}`);
  if (updateLatest) lines.push(`update  ${updateLatest} available \xB7 kxm update --kxm`);
  return lines;
}
function buildSessionBrief(snapshot, current, hub, ship, updateLatest, cost, sessionToken, source, staleSeconds = DEFAULT_SESSION_BRIEF_STALE_SECONDS) {
  const resolvedSource = source ?? snapshot.source ?? "legacy";
  const active = snapshot.runs.filter(
    (run) => run.status === "running" || run.status === "waiting" || run.status === "created" || run.status === "preparing"
  );
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
  const resolvedHub = hub ?? { state: "off", evidence: "unconfigured", online: false };
  const statusLine = formatSessionStatusLine(stats, current, resolvedHub, ship, updateLatest, cost);
  const widgetLines = formatSessionWidget(stats, current, resolvedHub, ship, updateLatest, cost);
  return {
    schema: SESSION_BRIEF_SCHEMA,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    staleSeconds,
    source: resolvedSource,
    hub: resolvedHub,
    stats,
    tasks,
    plans,
    statusLine,
    widgetLines,
    ...cost ? { cost } : {},
    ...sessionToken ? { sessionToken } : {}
  };
}
function readCachedSessionBrief(stateDir) {
  const file = join5(stateDir, "session-brief.json");
  try {
    if (!existsSync4(file)) return void 0;
    const raw = readFileSync6(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.schema === "kxm.session-brief.v1" && typeof parsed.generatedAt === "string") {
      const ageMs = Date.now() - Date.parse(parsed.generatedAt);
      const ttlMs = (parsed.staleSeconds ?? DEFAULT_SESSION_BRIEF_STALE_SECONDS) * 1e3;
      if (ageMs >= 0 && ageMs < ttlMs) {
        return parsed;
      }
    }
  } catch {
  }
  return void 0;
}
function writeCachedSessionBrief(stateDir, brief) {
  try {
    mkdirSync4(stateDir, { recursive: true, mode: 448 });
    const file = join5(stateDir, "session-brief.json");
    const tmp = `${file}.tmp.${randomUUID().slice(0, 8)}`;
    writeFileSync3(tmp, JSON.stringify(brief, null, 2), { encoding: "utf8", mode: 384 });
    renameSync3(tmp, file);
  } catch {
  }
}
function estimateSessionCost(stateDir) {
  try {
    const telemetryFile = join5(stateDir, "telemetry.jsonl");
    if (!existsSync4(telemetryFile)) return void 0;
    const records = readRoutingRecords(telemetryFile);
    if (records.length === 0) return void 0;
    let totalCost = 0;
    let hasMetered = false;
    let latestModel;
    let latestHarness;
    for (const { routing } of records) {
      const r = routing;
      const costBasis = r.costBasis ?? (typeof r.costUsd === "number" ? "metered" : "unmetered");
      if (costBasis === "metered" && typeof r.costUsd === "number") {
        totalCost += r.costUsd;
        hasMetered = true;
      }
      latestModel = r.effectiveModel ?? r.requestedModel ?? latestModel;
      latestHarness = r.harness ?? latestHarness;
    }
    if (!hasMetered) return "unknown";
    const route = latestHarness && latestModel ? `${latestHarness}/${latestModel}` : latestModel;
    return `$${totalCost.toFixed(2)} sess${route ? ` \xB7 ${route}` : ""}`;
  } catch {
    return void 0;
  }
}
async function resolveSessionHubStatus(url, fetchImpl = fetch, timeoutMs = 300) {
  if (!url || !url.trim()) {
    return { state: "off", evidence: "unconfigured", online: false };
  }
  try {
    const { health } = await probeHubHealth(url.trim(), fetchImpl, timeoutMs);
    if (health === "on") {
      return { state: "on", evidence: "probed", online: true, url: url.trim() };
    }
    if (health === "off") {
      return { state: "off", evidence: "probed", online: false, url: url.trim() };
    }
    return { state: "unknown", evidence: "timeout", online: false, url: url.trim() };
  } catch {
    return { state: "unknown", evidence: "timeout", online: false, url: url.trim() };
  }
}
function loadSessionBrief(cwd, env = process.env, current, hub, options = {}) {
  const paths = resolveKxmSnapshotPaths(cwd, env);
  if (!options.force) {
    const cached = readCachedSessionBrief(paths.stateDir);
    if (cached) {
      if (current || hub || options.cost) {
        const effectiveHub = hub ?? cached.hub;
        const effectiveCost = options.cost ?? cached.cost;
        const statusLine = formatSessionStatusLine(
          cached.stats,
          current,
          effectiveHub,
          options.ship,
          options.updateLatest,
          effectiveCost
        );
        const widgetLines = formatSessionWidget(
          cached.stats,
          current,
          effectiveHub,
          options.ship,
          options.updateLatest,
          effectiveCost
        );
        return {
          ...cached,
          hub: effectiveHub,
          ...effectiveCost ? { cost: effectiveCost } : {},
          statusLine,
          widgetLines
        };
      }
      return cached;
    }
  }
  const ship = options.ship ?? readGitShip(cwd);
  let brief;
  try {
    const cachedUpdate = readUpdateCache(paths.stateDir);
    const updateLatest = options.updateLatest ?? (cachedUpdate?.available ? cachedUpdate.latest : void 0);
    const cost = options.cost ?? estimateSessionCost(paths.stateDir);
    const snapshot = loadLocalMeshSnapshot(paths.dataPath, paths.stateDir, { env });
    brief = buildSessionBrief(
      snapshot,
      current,
      hub,
      ship,
      updateLatest,
      cost,
      options.sessionToken,
      snapshot.source
    );
  } catch {
    brief = buildSessionBrief(
      { runs: [], plans: [], openMessageTotal: 0, runTotal: 0 },
      current,
      hub,
      ship,
      options.updateLatest,
      options.cost,
      options.sessionToken
    );
  }
  writeCachedSessionBrief(paths.stateDir, brief);
  return brief;
}
async function loadSessionBriefAsync(cwd, env = process.env, current, hub, options = {}) {
  const paths = resolveKxmSnapshotPaths(cwd, env);
  if (!options.force) {
    const cached = readCachedSessionBrief(paths.stateDir);
    if (cached) {
      if (current || hub || options.cost) {
        const effectiveHub = hub ?? cached.hub;
        const effectiveCost = options.cost ?? cached.cost;
        const statusLine = formatSessionStatusLine(
          cached.stats,
          current,
          effectiveHub,
          options.ship,
          void 0,
          effectiveCost
        );
        const widgetLines = formatSessionWidget(
          cached.stats,
          current,
          effectiveHub,
          options.ship,
          void 0,
          effectiveCost
        );
        return {
          ...cached,
          hub: effectiveHub,
          ...effectiveCost ? { cost: effectiveCost } : {},
          statusLine,
          widgetLines
        };
      }
      return cached;
    }
  }
  let resolvedHub = hub;
  if (!resolvedHub) {
    const serverUrl = env.KXM_SERVER_URL?.trim() || readHubBinding(env)?.url;
    resolvedHub = await resolveSessionHubStatus(serverUrl, options.fetchImpl, 300);
  }
  return loadSessionBrief(cwd, env, current, resolvedHub, options);
}
function sessionBriefChoices(brief) {
  return [SESSION_BRIEF_SKIP_LABEL, ...brief.tasks.map((item) => item.label), ...brief.plans.map((item) => item.label)];
}
function itemFromChoice(brief, choice) {
  if (!choice || choice === SESSION_BRIEF_SKIP_LABEL) return void 0;
  return [...brief.tasks, ...brief.plans].find((item) => item.label === choice);
}
function sessionBriefPickerEnabled(input) {
  if (input.env?.KXM_SESSION_BRIEF?.trim() === "off") return false;
  if (input.mode !== "tui") return false;
  const reason = input.reason ?? "startup";
  return reason === "startup" || reason === "new" || reason === "fork";
}
var KXM_SLASH_SUBCOMMANDS = ["status", "hub", "memory", "help"];
function parseKxmSlashArgs(args) {
  const raw = String(args ?? "").trim().toLowerCase();
  if (raw === "" || raw === "brief") return "brief";
  if (raw === "status" || raw === "hub" || raw === "memory" || raw === "help") return raw;
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
function isTerminalMessage2(message) {
  return message.status === "replied" || message.status === "cancelled" || message.status === "expired" || message.status === "error";
}
function isTerminalMessageError2(error) {
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
  let nousReport;
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
    return join6(stateDir, `worker-context-${workerStateKey(projectName, agentName)}.json`);
  }
  function sessionRouteRequestPath() {
    const workerKey = process.env.KXM_WORKER_IDENTITY_KEY?.trim();
    if (!stateDir || !workerKey) return void 0;
    return join6(stateDir, `worker-session-request-${workerKey}.json`);
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
    mkdirSync5(dirname2(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync4(tmp, `${JSON.stringify(request)}
`, { encoding: "utf8", mode: 384 });
    renameSync4(tmp, path);
    return true;
  }
  function removeMatchingLegacyRecoveryContext() {
    if (!stateDir || !agentName || !projectName) return;
    const legacy = join6(stateDir, `worker-context-${agentName.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
    if (legacy === recoveryContextPath()) return;
    try {
      const candidate = JSON.parse(readFileSync7(legacy, "utf8"));
      if (candidate.version === 1 && candidate.agentName === agentName && candidate.project === projectName) {
        rmSync3(legacy, { force: true });
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
      rmSync3(path, { force: true });
      removeMatchingLegacyRecoveryContext();
      return;
    }
    mkdirSync5(dirname2(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync4(tmp, `${JSON.stringify({ version: 1, agentName, project: projectName, runId: runId ?? null, stageId: recoveryStageId ?? null, activeMessageIds, pendingMessageIds, artifactPointers: recoveryArtifacts.slice(0, 16), updatedAt: (/* @__PURE__ */ new Date()).toISOString() })}
`, { encoding: "utf8", mode: 384 });
    renameSync4(tmp, path);
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
    const hub = client?.agent ? { state: "on", evidence: "process", online: true } : void 0;
    const brief = await loadSessionBriefAsync(cwd, process.env, currentWork, hub);
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
    const selected = await loadSessionBriefAsync(cwd, process.env, item, hub);
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
      while (message && (isTerminalMessage2(message) || Date.parse(message.expiresAt) <= Date.now())) {
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
        if (isTerminalMessageError2(error)) {
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
      if (isTerminalMessage2(event.message) || Date.parse(event.message.expiresAt) <= Date.now()) return;
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
        if (isTerminalMessageError2(error)) {
          finishActiveInbound(message.id);
          return;
        }
        throw error;
      }
      if (isTerminalMessage2(current)) {
        finishActiveInbound(message.id);
        return;
      }
      await activeClient.reply(message.id, reply);
      finishActiveInbound(message.id);
    } catch (error) {
      if (isTerminalMessageError2(error)) {
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
    if (nousReport?.guidance.length) {
      for (const item of nousReport.guidance) {
        ctx.ui.notify(item.message, item.level);
      }
    }
    await client?.stop();
    client = void 0;
    try {
      currentSessionBinding = bindingFromEnvironment();
    } catch (error) {
      await applySessionChrome(ctx, event, false);
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
  pi.on("turn_end", async (_event, ctx) => {
    await applySessionChrome(ctx, { reason: "turn_end" }, false);
  });
  for (const cmd of AGENT_COMMANDS) {
    pi.registerTool({
      name: cmd.name,
      label: cmd.label,
      description: cmd.description,
      parameters: cmd.parameters,
      async execute(_toolCallId, params, signal) {
        const policy = enforceToolPolicy(cmd.name);
        if (!policy.allowed) {
          throw new Error(`tool_policy_denied: ${policy.detail ?? policy.error}`);
        }
        return result(
          await workflowCall(
            () => cmd.execute(requireClient(), params ?? {}, { signal })
          )
        );
      }
    });
  }
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
      if (command === "status") {
        const cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
        const hub = client?.agent ? { state: "on", evidence: "process", online: true } : void 0;
        const brief = await loadSessionBriefAsync(cwd, process.env, currentWork, hub);
        ctx.ui.setStatus?.("kxm", brief.statusLine);
        ctx.ui.setWidget?.("kxm-work", brief.widgetLines);
        ctx.ui.notify(brief.statusLine, "info");
        return;
      }
      if (command === "help") {
        ctx.ui.notify("kxm: /kxm | /kxm status | /kxm hub | /kxm memory | /kxm help. CLI: kxm session brief, kxm hub view, kxm memory brief", "info");
        return;
      }
      if (command === "memory") {
        const cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
        const kxmBin = process.env.KXM_BIN || "kxm";
        const res = spawnSync2(kxmBin, ["memory", "brief"], { cwd, encoding: "utf8", windowsHide: true });
        let memText = res.status === 0 && res.stdout ? res.stdout.trim() : "";
        if (!memText) {
          const script = join6(cwd, "scripts", "kxm.mjs");
          if (existsSync5(script)) {
            const scriptRes = spawnSync2(process.execPath, [script, "memory", "brief"], { cwd, encoding: "utf8", windowsHide: true });
            if (scriptRes.status === 0 && scriptRes.stdout) memText = scriptRes.stdout.trim();
          }
        }
        ctx.ui.notify(memText || "No active project memory facts.", "info");
        return;
      }
      await applySessionChrome(ctx, { reason: "new" }, command === "brief");
    }
  });
  return nousFactoryWork(pi, (report) => {
    nousReport = report;
  });
}
export {
  assistantFailure,
  bindingForMessage,
  piMeshExtension as default,
  workflowRunIdForMessage
};

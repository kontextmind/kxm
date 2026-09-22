// plugins/kxm/src/client.ts
import { createHash } from "node:crypto";
import { hostname } from "node:os";

// plugins/kxm/src/protocol.ts
var DEFAULT_MESSAGE_TTL_MS = 24 * 60 * 6e4;
var MAX_MESSAGE_TTL_MS = 7 * 24 * 60 * 6e4;
var DEFAULT_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 6e4;
var MAX_BODY_BYTES = 256 * 1024;
var MAX_AGENT_HOST_CHARS = 64;
var MAX_LEASE_TTL_MS = 10 * 6e4;
var DEFAULT_LEASE_TTL_MS = 5 * 6e4;

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
function defaultHostLabel() {
  try {
    return hostname().trim().slice(0, MAX_AGENT_HOST_CHARS) || void 0;
  } catch {
    return void 0;
  }
}
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
  /** Online peers of this client's project. `includeOffline` also returns
   * registered members whose lease the hub has already retired. */
  async listAgents(options = {}) {
    const path = options.includeOffline ? "/v1/agents?includeOffline=true" : "/v1/agents";
    const result = await this.request(path);
    return result.agents;
  }
  async send(options) {
    const result = await this.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify(options)
    });
    return result.message;
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
    const result = await this.request(`/v1/messages/${encodeURIComponent(messageId)}`);
    return result.message;
  }
  async acknowledge(messageId) {
    const result = await this.request(
      `/v1/messages/${encodeURIComponent(messageId)}/ack`,
      { method: "POST", body: "{}" }
    );
    return result.message;
  }
  async reply(messageId, content) {
    const result = await this.request(
      `/v1/messages/${encodeURIComponent(messageId)}/reply`,
      { method: "POST", body: JSON.stringify({ content }) }
    );
    return result.message;
  }
  async cancel(messageId) {
    const result = await this.request(
      `/v1/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE" }
    );
    return result.message;
  }
  // ----- Fenced leases over shared resources (P3) -----
  /**
   * Take or extend the lease over `resource` inside this client's project.
   *
   * The returned `fencingToken` is the whole point: hold it, present it on every
   * renewal, and present it again before committing anything shared. A hub that
   * has moved past it refuses, and the caller must stop rather than retry —
   * another holder owns the resource now. Rejects `HubHttpError` with code
   * `lease_held` when a live holder has it.
   */
  async acquireLease(resource, ttlMs) {
    return await this.request(`/v1/leases/${encodeURIComponent(resource)}/acquire`, {
      method: "POST",
      body: JSON.stringify(ttlMs === void 0 ? {} : { ttlMs })
    });
  }
  /** Extend a lease this client holds. The token never changes on renewal; a
   * `lease_superseded` or `lease_expired` refusal means it is gone. */
  async renewLease(resource, fencingToken, ttlMs) {
    return await this.request(`/v1/leases/${encodeURIComponent(resource)}/renew`, {
      method: "POST",
      body: JSON.stringify(ttlMs === void 0 ? { fencingToken } : { fencingToken, ttlMs })
    });
  }
  /** Give the resource back. */
  async releaseLease(resource, fencingToken) {
    return await this.request(`/v1/leases/${encodeURIComponent(resource)}/release`, {
      method: "POST",
      body: JSON.stringify({ fencingToken })
    });
  }
  async listWorkflows() {
    const result = await this.request("/v1/workflows");
    return result.runs;
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
    const result = await this.request(
      `/v1/workflows/${encodeURIComponent(runId)}/journal`,
      { method: "POST", body: JSON.stringify(input) }
    );
    return result.entry;
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
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          signal?.removeEventListener("abort", onAbort);
          clearTimeout(timer);
          reject(new MeshWaitError("aborted", messageId));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
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
        const response = await (this.options.fetchImpl ?? fetch)(
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
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, this.options.reconnectMs));
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
          model: this.options.model,
          host: this.options.host ?? defaultHostLabel()
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
      response = await (this.options.fetchImpl ?? fetch)(`${this.options.serverUrl.replace(/\/$/, "")}${path}`, {
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
      if (body.lease && typeof body.lease === "object") extras.lease = body.lease;
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
export {
  HubClient,
  HubHttpError
};

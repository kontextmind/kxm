import { createHash } from "node:crypto";
import type { AgentRecord, DeliveryMode, HubEvent, MessageRecord } from "./protocol.ts";
import type {
  ImprovementArea,
  ImprovementAreaReport,
  JournalCategory,
  WorkflowCheckpointStatus,
  WorkflowEvidenceInput,
  WorkflowJournalEntry,
  WorkflowRun,
} from "./workflow.ts";

export interface MeshClientOptions {
  serverUrl: string;
  authToken?: string;
  name: string;
  purpose: string;
  project: string;
  model?: string;
  heartbeatMs?: number;
  reconnectMs?: number;
  requestTimeoutMs?: number;
}

export interface SendOptions {
  target: string;
  content: string;
  delivery?: DeliveryMode;
  hops?: number;
  maxHops?: number;
  correlationId?: string;
  replyTo?: string;
  idempotencyKey?: string;
  ttlMs?: number;
}

export interface FanoutResult {
  target: string;
  messageId?: string;
  status: "replied" | "cancelled" | "expired" | "error";
  reply?: string;
  error?: string;
}

function fanoutIdempotencyKey(prefix: string, target: string, correlationId?: string): string {
  const scope = JSON.stringify({ prefix, correlationId: correlationId ?? null, target: target.toLowerCase() });
  return `fanout:${createHash("sha256").update(scope).digest("hex")}`;
}

export class MeshHttpError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly extras?: Record<string, unknown>;

  constructor(
    statusCode: number,
    message: string,
    code?: string,
    requestId?: string,
    extras?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MeshHttpError";
    this.statusCode = statusCode;
    if (code) this.code = code;
    if (requestId) this.requestId = requestId;
    if (extras) this.extras = extras;
  }
}

export class MeshClient {
  readonly options: MeshClientOptions;
  agent: AgentRecord | undefined;
  private agentKey: string | undefined;
  private heartbeatTimer?: NodeJS.Timeout;
  private eventsAbort?: AbortController;
  private stopped = true;
  private onEvent: ((event: HubEvent) => void | Promise<void>) | undefined;
  private registration: Promise<AgentRecord> | undefined;
  private eventLoop: Promise<void> | undefined;

  constructor(options: MeshClientOptions) {
    this.options = { heartbeatMs: 10_000, reconnectMs: 1_000, requestTimeoutMs: 15_000, ...options };
  }

  async start(onEvent: (event: HubEvent) => void | Promise<void>): Promise<AgentRecord> {
    if (!this.stopped) throw new Error("mesh client is already started");
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
    return this.agent!;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.eventsAbort?.abort();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.eventLoop;
    if (this.agent) {
      try {
        await this.request(`/v1/agents/${encodeURIComponent(this.agent.id)}`, { method: "DELETE" });
      } catch {
        // The hub may already be gone during process shutdown.
      }
    }
    this.agent = undefined;
    this.agentKey = undefined;
    this.onEvent = undefined;
    this.eventLoop = undefined;
  }

  async listAgents(): Promise<AgentRecord[]> {
    const result = await this.request<{ agents: AgentRecord[] }>("/v1/agents");
    return result.agents;
  }

  async send(options: SendOptions): Promise<MessageRecord> {
    const result = await this.request<{ message: MessageRecord }>("/v1/messages", {
      method: "POST",
      body: JSON.stringify(options),
    });
    return result.message;
  }

  async fanout(options: {
    targets: string[];
    content: string;
    correlationId?: string;
    idempotencyKeyPrefix?: string;
    ttlMs?: number;
    timeoutMs?: number;
  }): Promise<FanoutResult[]> {
    const targets = [...new Set(options.targets.map((target) => target.trim().toLowerCase()).filter(Boolean))];
    if (targets.length < 1 || targets.length > 3) throw new Error("fanout requires between one and three unique targets");
    return await Promise.all(targets.map(async (target): Promise<FanoutResult> => {
      try {
        const message = await this.send({
          target,
          content: options.content,
          delivery: "followUp",
          ...(options.correlationId ? { correlationId: options.correlationId } : {}),
          ...(options.idempotencyKeyPrefix ? {
            idempotencyKey: fanoutIdempotencyKey(
              options.idempotencyKeyPrefix,
              target,
              options.correlationId,
            ),
          } : {}),
          ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
        });
        const completed = await this.awaitResponse(message.id, options.timeoutMs ?? 30 * 60_000);
        return {
          target,
          messageId: completed.id,
          status: completed.status === "delivered" || completed.status === "queued" ? "error" : completed.status,
          ...(completed.reply ? { reply: completed.reply.content } : {}),
          ...(completed.error ? { error: completed.error } : {}),
        };
      } catch (error) {
        return { target, status: "error", error: error instanceof Error ? error.message : String(error) };
      }
    }));
  }

  async getMessage(messageId: string): Promise<MessageRecord> {
    const result = await this.request<{ message: MessageRecord }>(`/v1/messages/${encodeURIComponent(messageId)}`);
    return result.message;
  }

  async acknowledge(messageId: string): Promise<MessageRecord> {
    const result = await this.request<{ message: MessageRecord }>(
      `/v1/messages/${encodeURIComponent(messageId)}/ack`,
      { method: "POST", body: "{}" },
    );
    return result.message;
  }

  async reply(messageId: string, content: string): Promise<MessageRecord> {
    const result = await this.request<{ message: MessageRecord }>(
      `/v1/messages/${encodeURIComponent(messageId)}/reply`,
      { method: "POST", body: JSON.stringify({ content }) },
    );
    return result.message;
  }

  async cancel(messageId: string): Promise<MessageRecord> {
    const result = await this.request<{ message: MessageRecord }>(
      `/v1/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE" },
    );
    return result.message;
  }

  async listWorkflows(): Promise<WorkflowRun[]> {
    const result = await this.request<{ runs: WorkflowRun[] }>("/v1/workflows");
    return result.runs;
  }

  async getWorkflow(runId: string): Promise<{ run: WorkflowRun; journal: WorkflowJournalEntry[] }> {
    return await this.request(`/v1/workflows/${encodeURIComponent(runId)}`);
  }

  async checkpointWorkflow(
    runId: string,
    input: { stageId: string; status: WorkflowCheckpointStatus; summary: string; evidence?: WorkflowEvidenceInput },
  ): Promise<{ run: WorkflowRun; retry: boolean; completed: boolean; instruction: string }> {
    return await this.request(`/v1/workflows/${encodeURIComponent(runId)}/checkpoints`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async waitForWorkflowSignal(
    runId: string,
    input: {
      stageId: string;
      signalKey: string;
      summary: string;
      evidence?: WorkflowEvidenceInput;
      timeoutMs?: number;
    },
  ): Promise<{ run: WorkflowRun; instruction: string }> {
    return await this.request(`/v1/workflows/${encodeURIComponent(runId)}/waits`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async recordWorkflowEntry(
    runId: string,
    input: {
      category: JournalCategory;
      area: ImprovementArea;
      severity?: "info" | "warning" | "error";
      summary: string;
      details?: string;
      evidence?: string[];
      relatedEntryIds?: string[];
    },
  ): Promise<WorkflowJournalEntry> {
    const result = await this.request<{ entry: WorkflowJournalEntry }>(
      `/v1/workflows/${encodeURIComponent(runId)}/journal`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return result.entry;
  }

  async improvementReport(): Promise<{ reports: ImprovementAreaReport[]; entries: number }> {
    return await this.request("/v1/improvements");
  }

  async awaitResponse(messageId: string, timeoutMs = 30 * 60_000, signal?: AbortSignal): Promise<MessageRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("await cancelled");
      const message = await this.getMessage(messageId);
      if (["replied", "cancelled", "expired", "error"].includes(message.status)) return message;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("await cancelled"));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, 500);
        signal?.addEventListener("abort", onAbort, { once: true });
        timer.unref();
      });
    }
    throw new Error(`timed out waiting for ${messageId}`);
  }

  private async heartbeat(): Promise<void> {
    if (this.stopped || !this.agent) return;
    try {
      await this.request(`/v1/agents/${encodeURIComponent(this.agent.id)}/heartbeat`, {
        method: "POST",
        body: "{}",
      });
    } catch (error) {
      if (error instanceof MeshHttpError && error.statusCode === 401) void this.recoverRegistration();
    }
  }

  private async runEventLoop(): Promise<void> {
    while (!this.stopped && this.agent) {
      this.eventsAbort = new AbortController();
      try {
        const response = await fetch(
          `${this.options.serverUrl.replace(/\/$/, "")}/v1/events?agentId=${encodeURIComponent(this.agent.id)}`,
          {
            headers: this.headers(),
            signal: this.eventsAbort.signal,
          },
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
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            const parsed = JSON.parse(data) as HubEvent | { agent: AgentRecord };
            if ("type" in parsed) await this.onEvent?.(parsed);
          }
        }
      } catch (error) {
        if (this.stopped || (error instanceof Error && error.name === "AbortError")) return;
      }
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, this.options.reconnectMs));
    }
  }

  private headers(includeIdentity = true): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.authToken) headers.authorization = `Bearer ${this.options.authToken}`;
    if (includeIdentity && this.agent && this.agentKey) {
      headers["x-mesh-agent-id"] = this.agent.id;
      headers["x-mesh-agent-key"] = this.agentKey;
    }
    return headers;
  }

  private async register(): Promise<AgentRecord> {
    if (this.registration) return this.registration;
    this.registration = (async () => {
      const registration = await this.request<{ agent: AgentRecord; agentKey: string }>("/v1/agents/register", {
        method: "POST",
        body: JSON.stringify({
          name: this.options.name,
          purpose: this.options.purpose,
          project: this.options.project,
          model: this.options.model,
        }),
      }, false);
      this.agent = registration.agent;
      this.agentKey = registration.agentKey;
      return registration.agent;
    })();
    try {
      return await this.registration;
    } finally {
      this.registration = undefined;
    }
  }

  private async recoverRegistration(): Promise<void> {
    if (this.stopped) return;
    this.agent = undefined;
    this.agentKey = undefined;
    await this.register();
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}, includeIdentity = true): Promise<T> {
    const requestTimeoutMs = this.options.requestTimeoutMs ?? 15_000;
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await fetch(`${this.options.serverUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        signal,
        headers: { ...this.headers(includeIdentity), ...(init.headers ?? {}) },
      });
    } catch (error) {
      if (timeoutSignal.aborted) throw new Error(`request timed out after ${requestTimeoutMs}ms`);
      throw error;
    }
    const text = await response.text();
    let body: Record<string, unknown> = {};
    if (text) {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error(`hub returned invalid JSON with HTTP ${response.status}`);
      }
    }
    if (!response.ok) {
      const extras: Record<string, unknown> = {};
      for (const key of ["operation", "nextAction", "assignedCoordinatorName"]) {
        if (typeof body[key] === "string") extras[key] = body[key];
      }
      throw new MeshHttpError(
        response.status,
        String(body.error ?? `HTTP ${response.status}`),
        typeof body.code === "string" ? body.code : undefined,
        response.headers.get("x-request-id") ?? undefined,
        Object.keys(extras).length > 0 ? extras : undefined,
      );
    }
    return body as T;
  }
}

import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { MAX_AGENT_HOST_CHARS } from "./protocol.ts";
import type { AgentRecord, DeliveryMode, HubEvent, LeaseRecord, MessageRecord, WorkflowMessageContext } from "./protocol.ts";
import type { ContextAuthority, ContextConfidence, ContextItem, ContextItemAuditMetadata, ContextItemKind, ContextPacket } from "./context.ts";
import {
  canonicalWorkflowEvidenceKey,
  type ImprovementArea,
  type ImprovementAreaReport,
  type ImprovementSignal,
  type JournalCategory,
  type WorkflowCheckpointStatus,
  type WorkflowEvidenceInput,
  type WorkflowEvidenceReferenceInput,
  type WorkflowJournalEntry,
  type WorkflowRun,
} from "./workflow.ts";

/** Metadata-only audit of an assembled context packet. Never contains raw
 * item bodies. */
export interface ContextRequestAudit {
  request: { project: string; role: string; task: string; workflowRunId?: string; stageId?: string };
  selectedIds: string[];
  provenanceSummary: Record<string, number>;
  estimatedTokens: number;
  budgetTokens: number;
  candidateCount: number;
  excludedSuperseded: number;
  unresolvedGaps: string[];
  /** Numbers only: distinct task tokens, eligible candidates sharing a task
   * token, and each selected item's rounded relevance (index-aligned with
   * selectedIds). */
  relevance: { taskTokens: number; matchedCandidates: number; selected: number[] };
}

/** One recall result: bounded metadata plus the item's rounded relevance to
 * the query. Never includes the summary. */
export type ContextRecallItem = ContextItemAuditMetadata & { relevance: number };

export interface ContextExplanation {
  found: boolean;
  lineage: string[];
  evidenceRefs: string[];
  sources: { id: string; sourceType: string; sourceRef?: string }[];
}

export interface ContextWikiCompilation {
  audit: {
    project: string;
    pages: string[];
    stateItems: number;
    contextItems: number;
    contradictions: number;
    compiledAt: string;
  };
  pages: { path: string; content: string }[];
}

export interface HubClientOptions {
  serverUrl: string;
  authToken?: string;
  name: string;
  purpose: string;
  project: string;
  model?: string;
  /** Label for the box this client runs on, declared at registration.
   * Defaults to the machine hostname; the hub records it for readers and
   * never uses it to authorize anything. */
  host?: string;
  heartbeatMs?: number;
  reconnectMs?: number;
  requestTimeoutMs?: number;
  /** Injectable fetch for CLI/tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
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
  workflowContext?: Omit<WorkflowMessageContext, "schema">;
  ttlMs?: number;
  allowOffline?: boolean;
}

export interface FanoutResult {
  target: string;
  messageId?: string;
  status: "pending" | "replied" | "cancelled" | "expired" | "error";
  messageStatus?: "queued" | "delivered";
  expiresAt?: string;
  waitStatus?: "timed_out" | "aborted";
  reply?: string;
  error?: string;
}

class MeshWaitError extends Error {
  readonly waitStatus: "timed_out" | "aborted";

  constructor(waitStatus: "timed_out" | "aborted", messageId: string) {
    super(waitStatus === "aborted" ? "await cancelled" : `timed out waiting for ${messageId}`);
    this.name = "MeshWaitError";
    this.waitStatus = waitStatus;
  }
}

/** The box label a client declares when it registers. Bounded to the hub's
 * limit so a long hostname cannot turn registration into a 400, and dropped
 * entirely when the platform cannot report one. */
function defaultHostLabel(): string | undefined {
  try {
    return hostname().trim().slice(0, MAX_AGENT_HOST_CHARS) || undefined;
  } catch {
    return undefined;
  }
}

function completedFanoutResult(target: string, message: MessageRecord): FanoutResult {
  if (message.status === "queued" || message.status === "delivered") {
    throw new Error(`message ${message.id} is not complete`);
  }
  return {
    target,
    messageId: message.id,
    status: message.status,
    ...(message.reply ? { reply: message.reply.content } : {}),
    ...(message.error ? { error: message.error } : {}),
  };
}

function fanoutIdempotencyKey(
  prefix: string,
  target: string,
  correlationId?: string,
  workflowContext?: Omit<WorkflowMessageContext, "schema">,
): string {
  // Preserve the exact pre-0.4.3 hash input when no workflow provenance is
  // requested. A pending fanout created before upgrade must remain an exact
  // idempotent retry instead of dispatching duplicate work.
  const scope = JSON.stringify(workflowContext
    ? {
        prefix,
        correlationId: correlationId ?? null,
        target: target.toLowerCase(),
        workflowContext: {
          runId: workflowContext.runId,
          stageId: workflowContext.stageId,
          requirementKey: canonicalWorkflowEvidenceKey(workflowContext.requirementKey),
          attempt: workflowContext.attempt,
        },
      }
    : {
        prefix,
        correlationId: correlationId ?? null,
        target: target.toLowerCase(),
      });
  return `fanout:${createHash("sha256").update(scope).digest("hex")}`;
}

export class HubHttpError extends Error {
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
    this.name = "HubHttpError";
    this.statusCode = statusCode;
    if (code) this.code = code;
    if (requestId) this.requestId = requestId;
    if (extras) this.extras = extras;
  }
}

export class HubClient {
  readonly options: HubClientOptions;
  agent: AgentRecord | undefined;
  private agentKey: string | undefined;
  private heartbeatTimer?: NodeJS.Timeout;
  private eventsAbort?: AbortController;
  private stopped = true;
  private onEvent: ((event: HubEvent) => void | Promise<void>) | undefined;
  private registration: Promise<AgentRecord> | undefined;
  private eventLoop: Promise<void> | undefined;

  constructor(options: HubClientOptions) {
    this.options = { heartbeatMs: 10_000, reconnectMs: 1_000, requestTimeoutMs: 15_000, ...options };
  }

  async start(onEvent: (event: HubEvent) => void | Promise<void>): Promise<AgentRecord> {
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

  /** Online peers of this client's project. `includeOffline` also returns
   * registered members whose lease the hub has already retired. */
  async listAgents(options: { includeOffline?: boolean } = {}): Promise<AgentRecord[]> {
    const path = options.includeOffline ? "/v1/agents?includeOffline=true" : "/v1/agents";
    const result = await this.request<{ agents: AgentRecord[] }>(path);
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
    workflowContext?: Omit<WorkflowMessageContext, "schema">;
    ttlMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<FanoutResult[]> {
    const targets = [...new Set(options.targets.map((target) => target.trim().toLowerCase()).filter(Boolean))];
    if (targets.length < 1 || targets.length > 3) throw new Error("fanout requires between one and three unique targets");
    return await Promise.all(targets.map(async (target): Promise<FanoutResult> => {
      let message: MessageRecord | undefined;
      try {
        message = await this.send({
          target,
          content: options.content,
          delivery: "followUp",
          ...(options.correlationId ? { correlationId: options.correlationId } : {}),
          ...(options.workflowContext ? { workflowContext: options.workflowContext } : {}),
          ...(options.idempotencyKeyPrefix ? {
            idempotencyKey: fanoutIdempotencyKey(
              options.idempotencyKeyPrefix,
              target,
              options.correlationId,
              options.workflowContext,
            ),
          } : {}),
          ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
        });
        const completed = await this.awaitResponse(
          message.id,
          options.timeoutMs ?? 30 * 60_000,
          options.signal,
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
                waitStatus: error.waitStatus,
              };
            }
            return completedFanoutResult(target, current);
          } catch (finalError) {
            return {
              target,
              messageId: message.id,
              status: "error",
              error: finalError instanceof Error ? finalError.message : String(finalError),
            };
          }
        }
        return {
          target,
          ...(message ? { messageId: message.id } : {}),
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        };
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
  async acquireLease(resource: string, ttlMs?: number): Promise<{ lease: LeaseRecord; renewed: boolean }> {
    return await this.request(`/v1/leases/${encodeURIComponent(resource)}/acquire`, {
      method: "POST",
      body: JSON.stringify(ttlMs === undefined ? {} : { ttlMs }),
    });
  }

  /** Extend a lease this client holds. The token never changes on renewal; a
   * `lease_superseded` or `lease_expired` refusal means it is gone. */
  async renewLease(resource: string, fencingToken: number, ttlMs?: number): Promise<{ lease: LeaseRecord }> {
    return await this.request(`/v1/leases/${encodeURIComponent(resource)}/renew`, {
      method: "POST",
      body: JSON.stringify(ttlMs === undefined ? { fencingToken } : { fencingToken, ttlMs }),
    });
  }

  /** Give the resource back. */
  async releaseLease(resource: string, fencingToken: number): Promise<{ released: boolean; lease: LeaseRecord }> {
    return await this.request(`/v1/leases/${encodeURIComponent(resource)}/release`, {
      method: "POST",
      body: JSON.stringify({ fencingToken }),
    });
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
    input: {
      stageId: string;
      status: WorkflowCheckpointStatus;
      summary: string;
      evidence?: WorkflowEvidenceInput;
      evidenceRefs?: WorkflowEvidenceReferenceInput;
    },
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
      evidenceRefs?: WorkflowEvidenceReferenceInput;
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
      /** Required unless stageId names a stage that declares an area. */
      area?: ImprovementArea;
      severity?: "info" | "warning" | "error";
      summary: string;
      details?: string;
      evidence?: string[];
      relatedEntryIds?: string[];
      /** Stage the entry is recorded against; binds run/stage/attempt
       * provenance. The hub derives the attempt; callers never supply one. */
      stageId?: string;
    },
  ): Promise<WorkflowJournalEntry> {
    const result = await this.request<{ entry: WorkflowJournalEntry }>(
      `/v1/workflows/${encodeURIComponent(runId)}/journal`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return result.entry;
  }

  async improvementReport(): Promise<{ reports: ImprovementAreaReport[]; signals: ImprovementSignal[]; entries: number }> {
    return await this.request("/v1/improvements");
  }

  // ----- Context operating-system API (v0.5, issue #34) -----

  async contextGet(input: {
    project: string;
    role: string;
    task: string;
    workflowRunId?: string;
    stageId?: string;
    budgetTokens?: number;
    includeKinds?: ContextItemKind[];
  }): Promise<{ packet: ContextPacket; audit: ContextRequestAudit }> {
    return await this.request("/v1/context/get", { method: "POST", body: JSON.stringify(input) });
  }

  async contextRecall(input: {
    project: string;
    query?: string;
    kinds?: ContextItemKind[];
    limit?: number;
  }): Promise<{ items: ContextRecallItem[]; unresolvedGaps: string[] }> {
    return await this.request("/v1/context/recall", { method: "POST", body: JSON.stringify(input) });
  }

  async contextState(input: {
    project: string;
    key: string;
    asOf?: string;
  }): Promise<{ state: ContextItem | null; key: string }> {
    return await this.request("/v1/context/state", { method: "POST", body: JSON.stringify(input) });
  }

  async contextStatePropose(input: {
    project: string;
    key: string;
    summary: string;
    authority: ContextAuthority;
    confidence: ContextConfidence;
    evidenceRefs: string[];
  }): Promise<{ proposalId: string }> {
    return await this.request("/v1/context/state/propose", { method: "POST", body: JSON.stringify(input) });
  }

  async contextStatePromote(input: {
    project: string;
    proposalId: string;
    evidence: string[];
  }): Promise<{ state: ContextItem }> {
    return await this.request("/v1/context/state/promote", { method: "POST", body: JSON.stringify(input) });
  }

  async contextEpisode(input: {
    project: string;
    workflowRunId?: string;
  }): Promise<{ episodes: ContextItem[] }> {
    return await this.request("/v1/context/episode", { method: "POST", body: JSON.stringify(input) });
  }

  async contextExplain(input: {
    project: string;
    id: string;
  }): Promise<ContextExplanation> {
    return await this.request("/v1/context/explain", { method: "POST", body: JSON.stringify(input) });
  }

  async contextWikiCompile(input: { project: string }): Promise<ContextWikiCompilation> {
    return await this.request("/v1/context/wiki/compile", { method: "POST", body: JSON.stringify(input) });
  }

  async awaitResponse(messageId: string, timeoutMs = 30 * 60_000, signal?: AbortSignal): Promise<MessageRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new MeshWaitError("aborted", messageId);
      const message = await this.getMessage(messageId);
      if (["replied", "cancelled", "expired", "error"].includes(message.status)) return message;
      await new Promise<void>((resolve, reject) => {
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

  private async heartbeat(): Promise<void> {
    if (this.stopped || !this.agent) return;
    try {
      await this.request(`/v1/agents/${encodeURIComponent(this.agent.id)}/heartbeat`, {
        method: "POST",
        body: "{}",
      });
    } catch (error) {
      if (error instanceof HubHttpError && error.statusCode === 401) void this.recoverRegistration();
    }
  }

  private async runEventLoop(): Promise<void> {
    while (!this.stopped && this.agent) {
      this.eventsAbort = new AbortController();
      try {
        const response = await (this.options.fetchImpl ?? fetch)(
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
      headers["x-kxm-agent-id"] = this.agent.id;
      headers["x-kxm-agent-key"] = this.agentKey;
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
          host: this.options.host ?? defaultHostLabel(),
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
    return await hubJsonRequest<T>(this.options, path, init, this.headers(includeIdentity));
  }
}

/** One JSON request to the hub with a bounded timeout. A non-2xx answer
 * becomes a `HubHttpError` carrying the hub's code and next-action hints. */
async function hubJsonRequest<T>(
  options: { serverUrl: string; requestTimeoutMs?: number; fetchImpl?: typeof fetch },
  path: string,
  init: RequestInit,
  headers: Record<string, string>,
): Promise<T> {
    const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(`${options.serverUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        signal,
        headers: { ...headers, ...(init.headers ?? {}) },
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
      // A lease refusal carries the lease that won, so the loser can record who
      // holds the resource and at which token instead of guessing.
      if (body.lease && typeof body.lease === "object") extras.lease = body.lease;
      throw new HubHttpError(
        response.status,
        String(body.error ?? `HTTP ${response.status}`),
        typeof body.code === "string" ? body.code : undefined,
        response.headers.get("x-request-id") ?? undefined,
        Object.keys(extras).length > 0 ? extras : undefined,
      );
    }
    return body as T;
}

export interface RuntimeHubClientOptions {
  serverUrl: string;
  /** The hub project this Runtime reports into; its token is the admission. */
  project: string;
  authToken?: string;
  runtimeId: string;
  /** Box label; defaults to the hostname. Never used for authorization. */
  host?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RuntimePresenceView {
  runtimeId: string;
  host?: string;
  registeredAt: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
  presence: "online" | "expired";
}

export interface SyncPushResult {
  projectId?: string;
  runId?: string;
  sequence?: number;
  outcome: "accepted" | "duplicate" | "conflict" | "rejected";
  code?: string;
}

export interface SyncPushResponse {
  results: SyncPushResult[];
  cursors: Array<{ projectId: string; runId: string; cursor: number }>;
}

/**
 * The Runtime's machine client for one hub project (P5). It registers
 * presence and pushes derived sync events outbound; the hub never calls the
 * Runtime back. No agent identity, no message verbs.
 */
export class RuntimeHubClient {
  readonly options: RuntimeHubClientOptions;

  constructor(options: RuntimeHubClientOptions) {
    this.options = options;
  }

  async heartbeat(): Promise<RuntimePresenceView> {
    const result = await this.request<{ presence: RuntimePresenceView }>("/v1/runtime/presence", {
      project: this.options.project,
      runtimeId: this.options.runtimeId,
      host: this.options.host ?? defaultHostLabel(),
    });
    return result.presence;
  }

  /** Push already-derived `kxm.sync-event.v1` objects, in outbox order. */
  async pushSyncEvents(events: readonly unknown[]): Promise<SyncPushResponse> {
    return await this.request<SyncPushResponse>("/v1/sync/events", {
      project: this.options.project,
      runtimeId: this.options.runtimeId,
      events,
    });
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.authToken) headers.authorization = `Bearer ${this.options.authToken}`;
    return await hubJsonRequest<T>(this.options, path, { method: "POST", body: JSON.stringify(body) }, headers);
  }
}

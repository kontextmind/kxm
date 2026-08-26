import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import {
  DEFAULT_MAX_HOPS,
  DEFAULT_MESSAGE_RETENTION_MS,
  DEFAULT_MESSAGE_TTL_MS,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_STALE_AFTER_MS,
  MAX_BODY_BYTES,
  MAX_CONTENT_CHARS,
  MAX_MESSAGE_TTL_MS,
  MIN_MESSAGE_TTL_MS,
  MIN_MESSAGE_RETENTION_MS,
  ProtocolError,
  newId,
  nowIso,
  optionalString,
  parseBoundedInteger,
  parseDeliveryMode,
  requireString,
  type AgentRecord,
  type DeliveryMode,
  type HubEvent,
  type MessageRecord,
} from "./protocol.ts";
import { MeshStore, type StoredAgent } from "./store.ts";
import {
  checkpointRun,
  improvementReport,
  renderWorkflowPrompt,
  resumeWorkflowFromSignal,
  valueAtPath,
  waitForWorkflowSignal,
  type ImprovementArea,
  type JournalCategory,
  type WebhookWorkflowDefinition,
  type WorkflowCheckpointStatus,
  type WorkflowJournalEntry,
  type WorkflowRun,
  type WorkflowSignalReceipt,
} from "./workflow.ts";

export interface RateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
}

export interface MeshHubOptions {
  host?: string;
  port?: number;
  authToken?: string;
  projectTokens?: Record<string, string>;
  dataPath?: string;
  staleAfterMs?: number;
  messageTtlMs?: number;
  messageRetentionMs?: number;
  cleanupIntervalMs?: number;
  shutdownGraceMs?: number;
  rateLimit?: RateLimitOptions | false;
  webhookWorkflows?: WebhookWorkflowDefinition[];
  logger?: (entry: Record<string, unknown>) => void;
}

export interface MeshHub {
  readonly server: Server;
  readonly state: {
    agents: Map<string, StoredAgent>;
    messages: Map<string, MessageRecord>;
    workflowRuns: Map<string, WorkflowRun>;
    journal: Map<string, WorkflowJournalEntry>;
    persistent: boolean;
  };
  start(): Promise<{ host: string; port: number; url: string }>;
  close(): Promise<void>;
}

type SseClient = { response: ServerResponse; heartbeat: NodeJS.Timeout };
type RateBucket = { startedAt: number; count: number };

const DEFAULT_WORKFLOW_WAIT_TIMEOUT_MS = 24 * 60 * 60_000;
const MIN_WORKFLOW_WAIT_TIMEOUT_MS = 1_000;
const MAX_WORKFLOW_WAIT_TIMEOUT_MS = 30 * 24 * 60 * 60_000;

function isLoopback(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

function publicAgent(agent: StoredAgent): AgentRecord {
  const { key: _key, ...record } = agent;
  return record;
}

function safeTokenEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function text(response: ServerResponse, statusCode: number, body: string, contentType: string): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ProtocolError(415, "content-type must be application/json", "unsupported_media_type");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) {
      throw new ProtocolError(413, "request body is too large", "payload_too_large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJsonBody(buffer: Buffer): Record<string, unknown> {
  if (buffer.length === 0) return {};
  try {
    const value = JSON.parse(buffer.toString("utf8"));
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw new Error("body must be an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new ProtocolError(400, "request body must be valid JSON object", "invalid_json");
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return parseJsonBody(await readBody(request));
}

function sameIdempotentRequest(
  message: MessageRecord,
  target: string,
  content: string,
  delivery: DeliveryMode,
  correlationId: string | undefined,
  replyTo: string | undefined,
  hops: number,
  maxHops: number,
  ttlMs: number,
): boolean {
  return (message.to === target || message.toName.toLowerCase() === target.toLowerCase())
    && message.content === content
    && message.delivery === delivery
    && message.correlationId === correlationId
    && message.replyTo === replyTo
    && message.hops === hops
    && message.maxHops === maxHops
    && Date.parse(message.expiresAt) - Date.parse(message.createdAt) === ttlMs;
}

function boundedStringList(value: unknown, field: string, maxItems = 32): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new ProtocolError(400, `${field} must be an array with at most ${maxItems} items`);
  }
  return value.map((item, index) => requireString(item, `${field}[${index}]`, { max: 1_000 }));
}

function workflowSignalKey(value: unknown): string {
  const key = requireString(value, "signalKey", { max: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key)) {
    throw new ProtocolError(400, "signalKey may contain letters, numbers, dot, underscore, colon, and hyphen", "invalid_signal_key");
  }
  return key;
}

export function createMeshHub(options: MeshHubOptions = {}): MeshHub {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 7331;
  const authToken = options.authToken?.trim();
  const projectTokens = Object.fromEntries(
    Object.entries(options.projectTokens ?? {}).map(([project, token]) => [project, token.trim()]),
  );
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const defaultMessageTtlMs = options.messageTtlMs ?? DEFAULT_MESSAGE_TTL_MS;
  const messageRetentionMs = options.messageRetentionMs ?? DEFAULT_MESSAGE_RETENTION_MS;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? Math.max(250, Math.floor(staleAfterMs / 3));
  const shutdownGraceMs = options.shutdownGraceMs ?? 5_000;
  const rateLimit = options.rateLimit === false
    ? undefined
    : {
        windowMs: options.rateLimit?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
        maxRequests: options.rateLimit?.maxRequests ?? DEFAULT_RATE_LIMIT_MAX,
      };
  const webhookWorkflows = new Map((options.webhookWorkflows ?? []).map((workflow) => [workflow.id, workflow]));
  const logger = options.logger ?? (() => undefined);
  const store = new MeshStore(options.dataPath);
  const agents = store.agents;
  const messages = store.messages;
  const workflowRuns = store.workflowRuns;
  const journal = store.journal;
  const streams = new Map<string, Set<SseClient>>();
  const rateBuckets = new Map<string, RateBucket>();
  const counters = {
    requests: 0,
    errors: 0,
    registrations: 0,
    messagesSent: 0,
    messagesReplied: 0,
    messagesCancelled: 0,
    messagesExpired: 0,
    messagesPurged: 0,
    webhooksAccepted: 0,
    workflowCheckpoints: 0,
    workflowWaits: 0,
    workflowSignals: 0,
    workflowWaitTimeouts: 0,
    journalEntries: 0,
  };
  let cleanupTimer: NodeJS.Timeout | undefined;
  let closed = false;

  if (!isLoopback(host) && !authToken) {
    store.close();
    throw new Error("PI_MESH_AUTH_TOKEN is required when binding beyond localhost");
  }
  if (
    staleAfterMs < 100
    || defaultMessageTtlMs < MIN_MESSAGE_TTL_MS
    || messageRetentionMs < MIN_MESSAGE_RETENTION_MS
    || shutdownGraceMs < 0
  ) {
    store.close();
    throw new Error("stale and message TTL settings are below supported minimums");
  }
  if (rateLimit && (rateLimit.windowMs < 100 || rateLimit.maxRequests < 1)) {
    store.close();
    throw new Error("rate limit settings are invalid");
  }
  if (webhookWorkflows.size !== (options.webhookWorkflows ?? []).length) {
    store.close();
    throw new Error("webhook workflow IDs must be unique");
  }

  for (const agent of agents.values()) {
    agent.online = false;
    store.saveAgent(agent);
  }
  for (const message of messages.values()) {
    const legacy = message as MessageRecord & { expiresAt?: string };
    if (!legacy.expiresAt) {
      legacy.expiresAt = new Date(Date.parse(message.createdAt) + defaultMessageTtlMs).toISOString();
      store.saveMessage(message);
    }
  }

  function expectedProjectToken(project: string): string | undefined {
    return projectTokens[project] || authToken;
  }

  function requireProjectAuth(request: IncomingMessage, project: string): void {
    const expected = expectedProjectToken(project);
    if (!expected) return;
    if (!safeTokenEqual(bearerToken(request), expected)) {
      throw new ProtocolError(401, "invalid project authentication token", "invalid_auth");
    }
  }

  function requireAdminAuth(request: IncomingMessage): void {
    if (!authToken && isLoopback(host)) return;
    if (!authToken || !safeTokenEqual(bearerToken(request), authToken)) {
      throw new ProtocolError(401, "invalid administrative authentication token", "invalid_auth");
    }
  }

  function requireAgent(request: IncomingMessage, expectedId?: string): StoredAgent {
    const agentId = expectedId ?? String(request.headers["x-mesh-agent-id"] ?? "");
    const agentKey = String(request.headers["x-mesh-agent-key"] ?? "");
    const agent = agents.get(agentId);
    if (!agent || !agentKey || !safeTokenEqual(agentKey, agent.key)) {
      throw new ProtocolError(401, "invalid agent identity", "invalid_agent_identity");
    }
    const wasOffline = !agent.online;
    agent.lastSeenAt = nowIso();
    agent.online = true;
    store.saveAgent(agent);
    if (wasOffline) broadcastPresence(agent);
    return agent;
  }

  function checkRateLimit(request: IncomingMessage, response: ServerResponse): void {
    if (!rateLimit) return;
    const key = String(request.headers["x-mesh-agent-id"] ?? request.socket.remoteAddress ?? "unknown");
    const now = Date.now();
    const current = rateBuckets.get(key);
    const bucket = !current || now - current.startedAt >= rateLimit.windowMs
      ? { startedAt: now, count: 0 }
      : current;
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    const remaining = Math.max(0, rateLimit.maxRequests - bucket.count);
    response.setHeader("x-ratelimit-limit", String(rateLimit.maxRequests));
    response.setHeader("x-ratelimit-remaining", String(remaining));
    if (bucket.count > rateLimit.maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.startedAt + rateLimit.windowMs - now) / 1_000));
      response.setHeader("retry-after", String(retryAfterSeconds));
      throw new ProtocolError(429, "request rate limit exceeded", "rate_limited");
    }
  }

  function publish(agentId: string, event: HubEvent): boolean {
    const clients = streams.get(agentId);
    if (!clients || clients.size === 0) return false;
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.response.write(frame);
    return true;
  }

  function broadcastPresence(agent: StoredAgent): void {
    for (const candidate of agents.values()) {
      if (candidate.project === agent.project && candidate.id !== agent.id && candidate.online) {
        publish(candidate.id, { type: "presence", agent: publicAgent(agent) });
      }
    }
  }

  function findTarget(project: string, target: string): StoredAgent {
    const byId = agents.get(target);
    if (byId?.project === project && byId.online) return byId;
    const byName = [...agents.values()].find(
      (agent) => agent.project === project && agent.online && agent.name.toLowerCase() === target.toLowerCase(),
    );
    if (!byName) throw new ProtocolError(404, `online target not found: ${target}`, "target_not_found");
    return byName;
  }

  function findKnownTarget(project: string, target: string): StoredAgent {
    const byId = agents.get(target);
    if (byId?.project === project) return byId;
    const byName = [...agents.values()].find(
      (agent) => agent.project === project && agent.name.toLowerCase() === target.toLowerCase(),
    );
    if (!byName) {
      throw new ProtocolError(409, `workflow target has not registered: ${target}`, "workflow_target_unavailable");
    }
    return byName;
  }

  function webhookEvent(request: IncomingMessage, payload: Record<string, unknown>): string | undefined {
    const header = request.headers["x-github-event"];
    if (typeof header === "string" && header.trim()) return header.trim();
    const candidate = payload.webhookEvent ?? payload.event;
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
  }

  function verifyWebhookSignature(request: IncomingMessage, body: Buffer, secret: string): void {
    const signature = request.headers["x-hub-signature-256"] ?? request.headers["x-hub-signature"];
    if (typeof signature !== "string") {
      throw new ProtocolError(401, "webhook signature is required", "webhook_signature_missing");
    }
    const separator = signature.indexOf("=");
    const algorithm = separator > 0 ? signature.slice(0, separator).toLowerCase() : "";
    if (algorithm !== "sha256") {
      throw new ProtocolError(401, "webhook signature must use sha256", "webhook_signature_unsupported");
    }
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    if (!safeTokenEqual(signature, expected)) {
      throw new ProtocolError(401, "webhook signature is invalid", "webhook_signature_invalid");
    }
  }

  function workflowPrompt(
    definition: WebhookWorkflowDefinition,
    runId: string,
    payload: Record<string, unknown>,
  ): string {
    const rendered = renderWorkflowPrompt(definition.promptTemplate, payload);
    const stageList = definition.stages.map((stage, index) => [
      `${index + 1}. ${stage.label} (stageId: ${stage.id}, maxAttempts: ${stage.maxAttempts})`,
      `   ${stage.instructions}`,
      `   Required evidence: ${stage.requiredEvidence.join(", ") || "a concise, verifiable result"}`,
    ].join("\n")).join("\n");
    return [
      `Durable workflow run: ${runId}`,
      `Workflow: ${definition.id}`,
      "",
      rendered,
      "",
      "Execute these stages in order:",
      stageList,
      "",
      "At every stage, record material plans, decisions, contradictions, errors, and lessons with mesh_workflow_record.",
      "Keep repository-local configuration in .kxm/config, logs in .kxm/logs, and durable workflow artifacts in .kxm/assets; never commit runtime logs, state, or secrets.",
      "Complete each stage with mesh_workflow_checkpoint. A warning or failure must be corrected and checkpointed again until it passes or the attempt limit is reached.",
      "When an external system must finish asynchronously, call mesh_workflow_wait with a stable signal key; then settle the turn so a signed callback can resume this workflow.",
      "For multi-agent planning, delegate to the requested peers, compare their proposals, record contradictions, and synthesize the strongest evidence-backed plan.",
      "Do not claim the workflow is complete until the checkpoint response reports completed=true.",
    ].join("\n");
  }

  function createWorkflowResumeMessage(
    run: WorkflowRun,
    definition: WebhookWorkflowDefinition,
    deliveryId: string,
    signalKey: string,
    status: WorkflowCheckpointStatus,
    summary: string,
    evidence: string[],
    retry: boolean,
  ): MessageRecord {
    const createdAt = nowIso();
    const ttlMs = parseBoundedInteger(
      definition.ttlMs,
      "workflow.ttlMs",
      defaultMessageTtlMs,
      MIN_MESSAGE_TTL_MS,
      MAX_MESSAGE_TTL_MS,
    );
    const nextInstruction = retry
      ? `Correct the ${status} result, rerun the external check, then wait for a new signal or checkpoint the stage.`
      : `Continue with stage ${run.currentStage}.`;
    const content = requireString([
      `Resume durable workflow run: ${run.id}`,
      `Workflow: ${definition.id}`,
      `External signal: ${signalKey}`,
      `Result: ${status}`,
      `Summary: ${summary}`,
      `Evidence: ${evidence.join(", ") || "none supplied"}`,
      "",
      nextInstruction,
      "Review the run with mesh_workflow_get and keep recording material plans, decisions, contradictions, errors, and lessons.",
      "Do not claim the workflow is complete until the checkpoint response reports completed=true.",
    ].join("\n"), "workflow resume prompt", { max: MAX_CONTENT_CHARS });
    const message: MessageRecord = {
      id: newId("msg"),
      project: run.project,
      from: `workflow:${run.id}`,
      fromName: `signal:${definition.id}`,
      to: run.targetAgentId,
      toName: run.targetAgentName,
      content,
      delivery: definition.delivery,
      hops: 0,
      maxHops: DEFAULT_MAX_HOPS,
      correlationId: run.id,
      idempotencyKey: `${definition.id}:signal:${deliveryId}`,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
      status: "queued",
    };
    run.messageId = message.id;
    run.updatedAt = createdAt;
    return message;
  }

  function expireWorkflowWaits(): void {
    const timestamp = nowIso();
    const now = Date.parse(timestamp);
    for (const run of workflowRuns.values()) {
      if (run.status !== "waiting" || !run.waiting || Date.parse(run.waiting.expiresAt) > now) continue;
      const transition = structuredClone(run);
      const waiting = transition.waiting!;
      const stage = transition.stages.find((candidate) => candidate.id === waiting.stageId);
      if (stage) {
        stage.status = "failed";
        stage.summary = `Timed out waiting for external signal ${waiting.signalKey}`;
        stage.updatedAt = timestamp;
      }
      transition.status = "failed";
      delete transition.currentStage;
      delete transition.waiting;
      transition.updatedAt = timestamp;
      const entry: WorkflowJournalEntry = {
        id: newId("journal"),
        runId: transition.id,
        agentId: transition.targetAgentId,
        category: "error",
        area: stage?.area ?? "harness",
        severity: "error",
        summary: `External workflow signal timed out: ${waiting.signalKey}`,
        evidence: [`wait-created:${waiting.createdAt}`, `wait-expired:${waiting.expiresAt}`],
        relatedEntryIds: [],
        createdAt: timestamp,
      };
      const definition = webhookWorkflows.get(transition.definitionId);
      const ttlMs = parseBoundedInteger(
        definition?.ttlMs,
        "workflow.ttlMs",
        defaultMessageTtlMs,
        MIN_MESSAGE_TTL_MS,
        MAX_MESSAGE_TTL_MS,
      );
      const message: MessageRecord = {
        id: newId("msg"),
        project: transition.project,
        from: `workflow:${transition.id}`,
        fromName: `timeout:${transition.definitionId}`,
        to: transition.targetAgentId,
        toName: transition.targetAgentName,
        content: [
          `Durable workflow run ${transition.id} failed while waiting for external signal ${waiting.signalKey}.`,
          `Stage: ${waiting.stageId}`,
          `Expected: ${waiting.summary}`,
          `Deadline: ${waiting.expiresAt}`,
          "Review whether the external action completed, record any follow-up outside this terminal run, and escalate or start a new retry-safe workflow only when appropriate.",
        ].join("\n"),
        delivery: definition?.delivery ?? "followUp",
        hops: 0,
        maxHops: DEFAULT_MAX_HOPS,
        correlationId: transition.id,
        idempotencyKey: `${transition.definitionId}:timeout:${waiting.signalKey}:${waiting.expiresAt}`,
        createdAt: timestamp,
        expiresAt: new Date(Date.parse(timestamp) + ttlMs).toISOString(),
        status: "queued",
      };
      transition.messageId = message.id;
      store.saveWorkflowTransition(transition, message, entry);
      if (agents.get(transition.targetAgentId)?.online) {
        publish(transition.targetAgentId, { type: "message", message });
      }
      counters.workflowWaitTimeouts += 1;
      counters.journalEntries += 1;
      logger({
        event: "workflow_wait_timed_out",
        workflowRunId: transition.id,
        stageId: waiting.stageId,
        signalKey: waiting.signalKey,
        messageId: message.id,
      });
    }
  }

  function flushPending(agentId: string): void {
    expireMessages();
    for (const message of messages.values()) {
      if (message.to === agentId && message.status === "queued") {
        publish(agentId, { type: "message", message });
      }
    }
  }

  function expireMessages(): void {
    const now = Date.now();
    for (const message of messages.values()) {
      if ((message.status === "queued" || message.status === "delivered") && Date.parse(message.expiresAt) <= now) {
        message.status = "expired";
        message.error = "message expired before a reply was received";
        store.saveMessage(message);
        publish(message.from, { type: "expired", message });
        publish(message.to, { type: "expired", message });
        counters.messagesExpired += 1;
        logger({ event: "message_expired", messageId: message.id, project: message.project });
        const run = [...workflowRuns.values()].find(
          (candidate) => candidate.messageId === message.id && candidate.status === "running",
        );
        if (run) {
          run.status = "failed";
          delete run.currentStage;
          run.updatedAt = nowIso();
          store.saveWorkflowRun(run);
          const entry: WorkflowJournalEntry = {
            id: newId("journal"),
            runId: run.id,
            agentId: run.targetAgentId,
            category: "error",
            area: "harness",
            severity: "error",
            summary: "Workflow coordinator prompt expired before completion",
            evidence: [`message:${message.id}`],
            relatedEntryIds: [],
            createdAt: run.updatedAt,
          };
          store.saveJournalEntry(entry);
          counters.journalEntries += 1;
        }
      }
    }
  }

  function purgeTerminalMessages(): void {
    const cutoff = Date.now() - messageRetentionMs;
    for (const message of messages.values()) {
      const terminal = message.status === "replied"
        || message.status === "cancelled"
        || message.status === "expired"
        || message.status === "error";
      if (!terminal) continue;
      const terminalAt = message.repliedAt ?? message.cancelledAt ?? message.expiresAt ?? message.createdAt;
      if (Date.parse(terminalAt) > cutoff) continue;
      store.deleteMessage(message.id);
      counters.messagesPurged += 1;
      logger({ event: "message_purged", messageId: message.id, project: message.project });
    }
  }

  function metricsBody(): string {
    const onlineAgents = [...agents.values()].filter((agent) => agent.online).length;
    return [
      "# HELP pi_mesh_online_agents Current online agent count.",
      "# TYPE pi_mesh_online_agents gauge",
      `pi_mesh_online_agents ${onlineAgents}`,
      "# HELP pi_mesh_messages Current retained message count.",
      "# TYPE pi_mesh_messages gauge",
      `pi_mesh_messages ${messages.size}`,
      "# TYPE pi_mesh_requests_total counter",
      `pi_mesh_requests_total ${counters.requests}`,
      "# TYPE pi_mesh_errors_total counter",
      `pi_mesh_errors_total ${counters.errors}`,
      "# TYPE pi_mesh_registrations_total counter",
      `pi_mesh_registrations_total ${counters.registrations}`,
      "# TYPE pi_mesh_messages_sent_total counter",
      `pi_mesh_messages_sent_total ${counters.messagesSent}`,
      "# TYPE pi_mesh_messages_replied_total counter",
      `pi_mesh_messages_replied_total ${counters.messagesReplied}`,
      "# TYPE pi_mesh_messages_cancelled_total counter",
      `pi_mesh_messages_cancelled_total ${counters.messagesCancelled}`,
      "# TYPE pi_mesh_messages_expired_total counter",
      `pi_mesh_messages_expired_total ${counters.messagesExpired}`,
      "# TYPE pi_mesh_messages_purged_total counter",
      `pi_mesh_messages_purged_total ${counters.messagesPurged}`,
      "# TYPE pi_mesh_webhooks_accepted_total counter",
      `pi_mesh_webhooks_accepted_total ${counters.webhooksAccepted}`,
      "# TYPE pi_mesh_workflow_checkpoints_total counter",
      `pi_mesh_workflow_checkpoints_total ${counters.workflowCheckpoints}`,
      "# TYPE pi_mesh_workflow_waits_total counter",
      `pi_mesh_workflow_waits_total ${counters.workflowWaits}`,
      "# TYPE pi_mesh_workflow_signals_total counter",
      `pi_mesh_workflow_signals_total ${counters.workflowSignals}`,
      "# TYPE pi_mesh_workflow_wait_timeouts_total counter",
      `pi_mesh_workflow_wait_timeouts_total ${counters.workflowWaitTimeouts}`,
      "# TYPE pi_mesh_workflow_journal_entries_total counter",
      `pi_mesh_workflow_journal_entries_total ${counters.journalEntries}`,
      "",
    ].join("\n");
  }

  const server = createServer(async (request, response) => {
    const requestIdHeader = request.headers["x-request-id"];
    const requestId = typeof requestIdHeader === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(requestIdHeader)
      ? requestIdHeader
      : newId("req");
    response.setHeader("x-request-id", requestId);
    response.setHeader("referrer-policy", "no-referrer");
    counters.requests += 1;
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        json(response, 200, { ok: true, agents: [...agents.values()].filter((agent) => agent.online).length });
        return;
      }
      if (method === "GET" && url.pathname === "/ready") {
        const ready = store.healthy();
        json(response, ready ? 200 : 503, { ok: ready, storage: store.persistent ? "sqlite" : "memory" });
        return;
      }

      checkRateLimit(request, response);

      const signalMatch = url.pathname.match(/^\/v1\/webhooks\/([^/]+)\/runs\/([^/]+)\/signals\/([^/]+)$/);
      if (method === "POST" && signalMatch) {
        const definitionId = decodeURIComponent(signalMatch[1]!);
        const runId = decodeURIComponent(signalMatch[2]!);
        const signalKey = workflowSignalKey(decodeURIComponent(signalMatch[3]!));
        const definition = webhookWorkflows.get(definitionId);
        if (!definition) throw new ProtocolError(404, "webhook workflow not found", "webhook_not_found");
        const rawBody = await readBody(request);
        verifyWebhookSignature(request, rawBody, definition.signalSecret ?? definition.secret);
        const body = parseJsonBody(rawBody);
        const run = workflowRuns.get(runId);
        if (!run || run.definitionId !== definition.id) {
          throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        }
        const deliveryHeader = request.headers["x-atlassian-webhook-identifier"]
          ?? request.headers["x-github-delivery"]
          ?? request.headers["x-mesh-delivery-id"];
        const deliveryId = requireString(deliveryHeader, "webhook delivery identifier", { max: 128 });
        const payloadHash = createHash("sha256").update(rawBody).digest("hex");
        const existingReceipt = run.signalReceipts?.find((receipt) => receipt.deliveryId === deliveryId);
        if (existingReceipt) {
          if (existingReceipt.signalKey !== signalKey || existingReceipt.payloadHash !== payloadHash) {
            throw new ProtocolError(
              409,
              "webhook delivery identifier was already used for a different signal",
              "workflow_signal_delivery_conflict",
            );
          }
          json(response, 200, {
            duplicate: true,
            status: existingReceipt.status,
            stageId: existingReceipt.stageId,
            signalKey: existingReceipt.signalKey,
            receivedAt: existingReceipt.receivedAt,
            resumed: Boolean(existingReceipt.messageId),
          });
          return;
        }
        expireWorkflowWaits();
        const status = requireString(body.status, "status", { max: 16 }) as WorkflowCheckpointStatus;
        if (status !== "passed" && status !== "warning" && status !== "failed") {
          throw new ProtocolError(400, "status must be passed, warning, or failed", "invalid_checkpoint_status");
        }
        const summary = requireString(body.summary, "summary", { max: 4_000 });
        const evidence = boundedStringList(body.evidence, "evidence");
        const receivedAt = nowIso();
        const transition = structuredClone(workflowRuns.get(runId)!);
        const result = resumeWorkflowFromSignal(transition, signalKey, status, summary, evidence, receivedAt);
        const receipt: WorkflowSignalReceipt = {
          deliveryId,
          payloadHash,
          signalKey,
          stageId: result.stageId,
          status,
          receivedAt,
        };
        (transition.signalReceipts ??= []).push(receipt);
        let message: MessageRecord | undefined;
        let entry: WorkflowJournalEntry | undefined;
        if (status !== "passed") {
          const stage = transition.stages.find((candidate) => candidate.id === result.stageId)!;
          entry = {
            id: newId("journal"),
            runId: transition.id,
            agentId: transition.targetAgentId,
            category: "error",
            area: stage.area ?? "gates",
            severity: status === "failed" ? "error" : "warning",
            summary: `${stage.label}: ${summary}`,
            evidence,
            relatedEntryIds: [],
            createdAt: receivedAt,
          };
        }
        if (transition.status === "running") {
          message = createWorkflowResumeMessage(
            transition,
            definition,
            deliveryId,
            signalKey,
            status,
            summary,
            evidence,
            result.retry,
          );
          receipt.messageId = message.id;
        }
        store.saveWorkflowTransition(transition, message, entry);
        if (entry) counters.journalEntries += 1;
        if (message && agents.get(transition.targetAgentId)?.online) {
          publish(transition.targetAgentId, { type: "message", message });
        }
        counters.workflowSignals += 1;
        counters.workflowCheckpoints += 1;
        logger({
          event: "workflow_signal_received",
          workflowRunId: transition.id,
          deliveryId,
          signalKey,
          stageId: result.stageId,
          status,
          retry: result.retry,
          completed: result.completed,
          ...(message ? { messageId: message.id } : {}),
        });
        json(response, message ? 202 : 200, {
          duplicate: false,
          status,
          stageId: result.stageId,
          signalKey,
          retry: result.retry,
          completed: result.completed,
          resumed: Boolean(message),
        });
        return;
      }

      const webhookMatch = url.pathname.match(/^\/v1\/webhooks\/([^/]+)$/);
      if (method === "POST" && webhookMatch) {
        const definitionId = decodeURIComponent(webhookMatch[1]!);
        const definition = webhookWorkflows.get(definitionId);
        if (!definition) throw new ProtocolError(404, "webhook workflow not found", "webhook_not_found");
        const rawBody = await readBody(request);
        verifyWebhookSignature(request, rawBody, definition.secret);
        const payload = parseJsonBody(rawBody);
        const event = webhookEvent(request, payload);
        if (definition.event && event !== definition.event) {
          response.writeHead(204, { "cache-control": "no-store" }).end();
          return;
        }
        if (definition.filter && String(valueAtPath(payload, definition.filter.path) ?? "") !== definition.filter.equals) {
          response.writeHead(204, { "cache-control": "no-store" }).end();
          return;
        }
        const deliveryHeader = request.headers["x-atlassian-webhook-identifier"]
          ?? request.headers["x-github-delivery"]
          ?? request.headers["x-mesh-delivery-id"];
        const deliveryId = requireString(deliveryHeader, "webhook delivery identifier", { max: 128 });
        const existing = [...workflowRuns.values()].find(
          (run) => run.definitionId === definition.id && run.deliveryId === deliveryId,
        );
        if (existing) {
          json(response, 200, { run: existing, duplicate: true });
          return;
        }
        const target = findKnownTarget(definition.project, definition.target);
        const createdAt = nowIso();
        const runId = newId("run");
        const ttlMs = parseBoundedInteger(
          definition.ttlMs,
          "workflow.ttlMs",
          defaultMessageTtlMs,
          MIN_MESSAGE_TTL_MS,
          MAX_MESSAGE_TTL_MS,
        );
        const content = requireString(workflowPrompt(definition, runId, payload), "workflow prompt", {
          max: MAX_CONTENT_CHARS,
        });
        const message: MessageRecord = {
          id: newId("msg"),
          project: definition.project,
          from: `workflow:${runId}`,
          fromName: `webhook:${definition.id}`,
          to: target.id,
          toName: target.name,
          content,
          delivery: definition.delivery,
          hops: 0,
          maxHops: DEFAULT_MAX_HOPS,
          correlationId: runId,
          idempotencyKey: `${definition.id}:${deliveryId}`,
          createdAt,
          expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
          status: "queued",
        };
        const stages = definition.stages.map((stage, index) => ({
          ...stage,
          status: index === 0 ? "in_progress" as const : "pending" as const,
          attempts: 0,
          evidence: [],
          ...(index === 0 ? { updatedAt: createdAt } : {}),
        }));
        const run: WorkflowRun = {
          id: runId,
          definitionId: definition.id,
          source: definition.source,
          deliveryId,
          payloadHash: createHash("sha256").update(rawBody).digest("hex"),
          ...(event ? { event } : {}),
          project: definition.project,
          targetAgentId: target.id,
          targetAgentName: target.name,
          messageId: message.id,
          status: "running",
          currentStage: stages[0]!.id,
          stages,
          createdAt,
          updatedAt: createdAt,
        };
        store.saveMessage(message);
        store.saveWorkflowRun(run);
        if (target.online) publish(target.id, { type: "message", message });
        counters.webhooksAccepted += 1;
        logger({
          event: "webhook_workflow_started",
          workflowId: definition.id,
          workflowRunId: run.id,
          deliveryId,
          project: definition.project,
          target: target.id,
        });
        json(response, 202, { run, duplicate: false });
        return;
      }

      if (method === "GET" && url.pathname === "/metrics") {
        requireAdminAuth(request);
        text(response, 200, metricsBody(), "text/plain; version=0.0.4; charset=utf-8");
        return;
      }

      if (method === "GET" && url.pathname === "/v1/workflows") {
        expireWorkflowWaits();
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const runs = [...workflowRuns.values()].filter(
          (run) => run.project === agent.project && run.targetAgentId === agent.id,
        );
        json(response, 200, { runs });
        return;
      }

      const workflowMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)$/);
      if (method === "GET" && workflowMatch) {
        expireWorkflowWaits();
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const run = workflowRuns.get(decodeURIComponent(workflowMatch[1]!));
        if (!run) throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        if (run.project !== agent.project || run.targetAgentId !== agent.id) {
          throw new ProtocolError(403, "workflow run is not visible to this agent", "workflow_forbidden");
        }
        const entries = [...journal.values()].filter((entry) => entry.runId === run.id);
        json(response, 200, { run, journal: entries });
        return;
      }

      const waitMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/waits$/);
      if (method === "POST" && waitMatch) {
        expireWorkflowWaits();
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const run = workflowRuns.get(decodeURIComponent(waitMatch[1]!));
        if (!run) throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        if (run.project !== agent.project || run.targetAgentId !== agent.id) {
          throw new ProtocolError(403, "only the assigned coordinator can wait this workflow", "workflow_forbidden");
        }
        const body = await readJson(request);
        const stageId = requireString(body.stageId, "stageId", { max: 64 });
        const signalKey = workflowSignalKey(body.signalKey);
        const summary = requireString(body.summary, "summary", { max: 4_000 });
        const timeoutMs = parseBoundedInteger(
          body.timeoutMs,
          "timeoutMs",
          DEFAULT_WORKFLOW_WAIT_TIMEOUT_MS,
          MIN_WORKFLOW_WAIT_TIMEOUT_MS,
          MAX_WORKFLOW_WAIT_TIMEOUT_MS,
        );
        const createdAt = nowIso();
        waitForWorkflowSignal(
          run,
          stageId,
          signalKey,
          summary,
          createdAt,
          new Date(Date.parse(createdAt) + timeoutMs).toISOString(),
        );
        store.saveWorkflowRun(run);
        counters.workflowWaits += 1;
        logger({
          event: "workflow_wait_started",
          workflowRunId: run.id,
          stageId,
          signalKey,
          expiresAt: run.waiting?.expiresAt,
        });
        json(response, 202, {
          run,
          instruction: "The agent may now settle this turn. A signed external signal will checkpoint the stage and resume the coordinator when more work is required.",
        });
        return;
      }

      const checkpointMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/checkpoints$/);
      if (method === "POST" && checkpointMatch) {
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const run = workflowRuns.get(decodeURIComponent(checkpointMatch[1]!));
        if (!run) throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        if (run.project !== agent.project || run.targetAgentId !== agent.id) {
          throw new ProtocolError(403, "only the assigned coordinator can checkpoint this workflow", "workflow_forbidden");
        }
        const body = await readJson(request);
        const stageId = requireString(body.stageId, "stageId", { max: 64 });
        const status = requireString(body.status, "status", { max: 16 }) as WorkflowCheckpointStatus;
        if (status !== "passed" && status !== "warning" && status !== "failed") {
          throw new ProtocolError(400, "status must be passed, warning, or failed", "invalid_checkpoint_status");
        }
        const summary = requireString(body.summary, "summary", { max: 4_000 });
        const evidence = boundedStringList(body.evidence, "evidence");
        const result = checkpointRun(run, stageId, status, summary, evidence, nowIso());
        store.saveWorkflowRun(run);
        counters.workflowCheckpoints += 1;
        if (status !== "passed") {
          const stage = run.stages.find((candidate) => candidate.id === stageId)!;
          const entry: WorkflowJournalEntry = {
            id: newId("journal"),
            runId: run.id,
            agentId: agent.id,
            category: "error",
            area: stage.area ?? "workflow",
            severity: status === "failed" ? "error" : "warning",
            summary: `${stage.label}: ${summary}`,
            evidence,
            relatedEntryIds: [],
            createdAt: run.updatedAt,
          };
          store.saveJournalEntry(entry);
          counters.journalEntries += 1;
        }
        logger({
          event: "workflow_checkpoint",
          workflowRunId: run.id,
          stageId,
          status,
          attempt: run.stages.find((stage) => stage.id === stageId)?.attempts,
          retry: result.retry,
          completed: result.completed,
        });
        json(response, 200, {
          run,
          retry: result.retry,
          completed: result.completed,
          instruction: result.retry
            ? "Correct the warning or failure, record what changed, rerun the relevant checks, and checkpoint this stage again."
            : result.completed
              ? "Workflow checkpoints are complete. Return the final outcome with links and evidence."
              : `Continue with stage ${run.currentStage}.`,
        });
        return;
      }

      const journalMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/journal$/);
      if (method === "POST" && journalMatch) {
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const run = workflowRuns.get(decodeURIComponent(journalMatch[1]!));
        if (!run) throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        if (run.project !== agent.project || run.targetAgentId !== agent.id) {
          throw new ProtocolError(403, "only the assigned coordinator can journal this workflow", "workflow_forbidden");
        }
        const body = await readJson(request);
        const category = requireString(body.category, "category", { max: 24 }) as JournalCategory;
        if (!["plan", "decision", "contradiction", "error", "lesson"].includes(category)) {
          throw new ProtocolError(400, "invalid journal category", "invalid_journal_category");
        }
        const area = requireString(body.area, "area", { max: 24 }) as ImprovementArea;
        if (!["harness", "gates", "implementation", "workflow", "documentation", "security", "other"].includes(area)) {
          throw new ProtocolError(400, "invalid improvement area", "invalid_improvement_area");
        }
        const severity = requireString(body.severity ?? "info", "severity", { max: 16 });
        if (severity !== "info" && severity !== "warning" && severity !== "error") {
          throw new ProtocolError(400, "severity must be info, warning, or error", "invalid_journal_severity");
        }
        const relatedEntryIds = boundedStringList(body.relatedEntryIds, "relatedEntryIds", 16);
        if (relatedEntryIds.some((id) => journal.get(id)?.runId !== run.id)) {
          throw new ProtocolError(
            400,
            "relatedEntryIds must reference journal entries in the same workflow run",
            "invalid_journal_relation",
          );
        }
        const entry: WorkflowJournalEntry = {
          id: newId("journal"),
          runId: run.id,
          agentId: agent.id,
          category,
          area,
          severity,
          summary: requireString(body.summary, "summary", { max: 1_000 }),
          ...(body.details ? { details: requireString(body.details, "details", { max: 8_000 }) } : {}),
          evidence: boundedStringList(body.evidence, "evidence"),
          relatedEntryIds,
          createdAt: nowIso(),
        };
        store.saveJournalEntry(entry);
        counters.journalEntries += 1;
        logger({
          event: "workflow_journal_recorded",
          workflowRunId: run.id,
          journalEntryId: entry.id,
          category,
          area,
          severity,
        });
        json(response, 201, { entry });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/improvements") {
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const visibleRuns = new Set(
          [...workflowRuns.values()]
            .filter((run) => run.project === agent.project)
            .map((run) => run.id),
        );
        const entries = [...journal.values()].filter((entry) => visibleRuns.has(entry.runId));
        json(response, 200, { reports: improvementReport(entries), entries: entries.length });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/agents/register") {
        const body = await readJson(request);
        const name = requireString(body.name, "name", { max: 64 });
        const purpose = requireString(body.purpose ?? "General-purpose Pi agent", "purpose", { max: 256 });
        const project = requireString(body.project, "project", { max: 128 });
        requireProjectAuth(request, project);
        const model = optionalString(body.model, "model", 128);
        const existing = [...agents.values()].find(
          (agent) => agent.project === project && agent.name.toLowerCase() === name.toLowerCase(),
        );
        if (existing?.online) {
          throw new ProtocolError(409, `agent name already active in project: ${name}`, "duplicate_agent_name");
        }
        const timestamp = nowIso();
        const agent: StoredAgent = existing ?? {
          id: newId("agt"),
          key: newId("key"),
          name,
          purpose,
          project,
          connectedAt: timestamp,
          lastSeenAt: timestamp,
          online: true,
        };
        agent.key = newId("key");
        agent.name = name;
        agent.purpose = purpose;
        agent.project = project;
        agent.connectedAt = timestamp;
        agent.lastSeenAt = timestamp;
        agent.online = true;
        if (model) agent.model = model;
        else delete agent.model;
        store.saveAgent(agent);
        counters.registrations += 1;
        logger({ event: existing ? "agent_resumed" : "agent_registered", agentId: agent.id, name, project });
        broadcastPresence(agent);
        json(response, existing ? 200 : 201, { agent: publicAgent(agent), agentKey: agent.key, resumed: Boolean(existing) });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/agents") {
        const current = requireAgent(request);
        requireProjectAuth(request, current.project);
        const result = [...agents.values()]
          .filter((agent) => agent.project === current.project && agent.online)
          .map(publicAgent);
        json(response, 200, { agents: result });
        return;
      }

      const heartbeatMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/heartbeat$/);
      if (method === "POST" && heartbeatMatch) {
        const current = requireAgent(request, decodeURIComponent(heartbeatMatch[1]!));
        requireProjectAuth(request, current.project);
        await readJson(request);
        json(response, 200, { agent: publicAgent(current) });
        return;
      }

      const agentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
      if (method === "DELETE" && agentMatch) {
        const current = requireAgent(request, decodeURIComponent(agentMatch[1]!));
        requireProjectAuth(request, current.project);
        current.online = false;
        current.lastSeenAt = nowIso();
        store.saveAgent(current);
        broadcastPresence(current);
        logger({ event: "agent_unregistered", agentId: current.id, project: current.project });
        response.writeHead(204, { "cache-control": "no-store" }).end();
        return;
      }

      if (method === "GET" && url.pathname === "/v1/events") {
        const agentId = requireString(url.searchParams.get("agentId"), "agentId", { max: 80 });
        const current = requireAgent(request, agentId);
        requireProjectAuth(request, current.project);
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "x-content-type-options": "nosniff",
        });
        response.write(`event: ready\ndata: ${JSON.stringify({ agent: publicAgent(current) })}\n\n`);
        const client: SseClient = {
          response,
          heartbeat: setInterval(() => response.write(": heartbeat\n\n"), 15_000),
        };
        client.heartbeat.unref();
        const clients = streams.get(agentId) ?? new Set<SseClient>();
        clients.add(client);
        streams.set(agentId, clients);
        flushPending(agentId);
        request.on("close", () => {
          clearInterval(client.heartbeat);
          clients.delete(client);
          if (clients.size === 0) streams.delete(agentId);
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/messages") {
        const sender = requireAgent(request);
        requireProjectAuth(request, sender.project);
        const body = await readJson(request);
        const targetInput = requireString(body.target, "target", { max: 80 });
        const content = requireString(body.content, "content", { max: MAX_CONTENT_CHARS });
        const delivery = parseDeliveryMode(body.delivery);
        const correlationId = optionalString(body.correlationId, "correlationId", 128);
        const replyTo = optionalString(body.replyTo, "replyTo", 80);
        const hops = parseBoundedInteger(body.hops, "hops", 0, 0, 100);
        const maxHops = parseBoundedInteger(body.maxHops, "maxHops", DEFAULT_MAX_HOPS, 1, 20);
        if (hops >= maxHops) {
          throw new ProtocolError(400, `hop limit reached (${hops}/${maxHops})`, "hop_limit_reached");
        }
        const ttlMs = parseBoundedInteger(
          body.ttlMs,
          "ttlMs",
          defaultMessageTtlMs,
          MIN_MESSAGE_TTL_MS,
          MAX_MESSAGE_TTL_MS,
        );
        const idempotencyKey = optionalString(body.idempotencyKey, "idempotencyKey", 128);
        if (idempotencyKey) {
          const existing = [...messages.values()].find(
            (message) => message.from === sender.id && message.idempotencyKey === idempotencyKey,
          );
          if (existing) {
            if (!sameIdempotentRequest(
              existing,
              targetInput,
              content,
              delivery,
              correlationId,
              replyTo,
              hops,
              maxHops,
              ttlMs,
            )) {
              throw new ProtocolError(409, "idempotency key was already used for another request", "idempotency_conflict");
            }
            json(response, 200, { message: existing, idempotent: true });
            return;
          }
        }
        const target = findTarget(sender.project, targetInput);
        if (target.id === sender.id) {
          throw new ProtocolError(400, "cannot send a request to yourself", "self_target");
        }
        const createdAt = nowIso();
        const message: MessageRecord = {
          id: newId("msg"),
          project: sender.project,
          from: sender.id,
          fromName: sender.name,
          to: target.id,
          toName: target.name,
          content,
          delivery,
          hops,
          maxHops,
          ...(correlationId ? { correlationId } : {}),
          ...(replyTo ? { replyTo } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          createdAt,
          expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
          status: "queued",
        };
        store.saveMessage(message);
        publish(target.id, { type: "message", message });
        counters.messagesSent += 1;
        logger({ event: "message_sent", messageId: message.id, from: sender.id, to: target.id, hops });
        json(response, 202, { message, idempotent: false });
        return;
      }

      const ackMatch = url.pathname.match(/^\/v1\/messages\/([^/]+)\/ack$/);
      if (method === "POST" && ackMatch) {
        const receiver = requireAgent(request);
        requireProjectAuth(request, receiver.project);
        await readJson(request);
        expireMessages();
        expireWorkflowWaits();
        purgeTerminalMessages();
        const message = messages.get(decodeURIComponent(ackMatch[1]!));
        if (!message) throw new ProtocolError(404, "message not found", "message_not_found");
        if (message.to !== receiver.id) {
          throw new ProtocolError(403, "only the recipient can acknowledge this message", "message_forbidden");
        }
        if (message.status !== "queued" && message.status !== "delivered") {
          throw new ProtocolError(409, `cannot acknowledge a ${message.status} message`, "invalid_message_state");
        }
        if (message.status === "queued") {
          message.status = "delivered";
          message.deliveredAt = nowIso();
          store.saveMessage(message);
        }
        json(response, 200, { message });
        return;
      }

      const replyMatch = url.pathname.match(/^\/v1\/messages\/([^/]+)\/reply$/);
      if (method === "POST" && replyMatch) {
        const receiver = requireAgent(request);
        requireProjectAuth(request, receiver.project);
        const body = await readJson(request);
        expireMessages();
        const message = messages.get(decodeURIComponent(replyMatch[1]!));
        if (!message) throw new ProtocolError(404, "message not found", "message_not_found");
        if (message.to !== receiver.id) {
          throw new ProtocolError(403, "only the recipient can reply to this message", "message_forbidden");
        }
        if (message.status === "replied") {
          throw new ProtocolError(409, "message already has a reply", "duplicate_reply");
        }
        if (message.status === "cancelled" || message.status === "expired" || message.status === "error") {
          throw new ProtocolError(409, `cannot reply to a ${message.status} message`, "invalid_message_state");
        }
        message.reply = {
          content: requireString(body.content, "content", { max: MAX_CONTENT_CHARS }),
          createdAt: nowIso(),
        };
        message.repliedAt = message.reply.createdAt;
        message.status = "replied";
        store.saveMessage(message);
        const workflowRun = [...workflowRuns.values()].find((run) => run.messageId === message.id);
        if (workflowRun?.status === "running") {
          workflowRun.status = "failed";
          delete workflowRun.currentStage;
          workflowRun.updatedAt = message.repliedAt;
          store.saveWorkflowRun(workflowRun);
          const entry: WorkflowJournalEntry = {
            id: newId("journal"),
            runId: workflowRun.id,
            agentId: receiver.id,
            category: "error",
            area: "workflow",
            severity: "error",
            summary: "Coordinator settled before all required workflow checkpoints passed",
            evidence: [`message:${message.id}`],
            relatedEntryIds: [],
            createdAt: message.repliedAt,
          };
          store.saveJournalEntry(entry);
          counters.journalEntries += 1;
        }
        publish(message.from, { type: "reply", message });
        counters.messagesReplied += 1;
        logger({ event: "message_replied", messageId: message.id, from: receiver.id, to: message.from });
        json(response, 200, { message });
        return;
      }

      const messageMatch = url.pathname.match(/^\/v1\/messages\/([^/]+)$/);
      if (method === "DELETE" && messageMatch) {
        const current = requireAgent(request);
        requireProjectAuth(request, current.project);
        expireMessages();
        const message = messages.get(decodeURIComponent(messageMatch[1]!));
        if (!message) throw new ProtocolError(404, "message not found", "message_not_found");
        if (message.from !== current.id) {
          throw new ProtocolError(403, "only the sender can cancel this message", "message_forbidden");
        }
        if (message.status === "cancelled") {
          json(response, 200, { message });
          return;
        }
        if (message.status !== "queued" && message.status !== "delivered") {
          throw new ProtocolError(409, `cannot cancel a ${message.status} message`, "invalid_message_state");
        }
        message.status = "cancelled";
        message.cancelledAt = nowIso();
        message.error = "message cancelled by sender";
        store.saveMessage(message);
        publish(message.to, { type: "cancelled", message });
        counters.messagesCancelled += 1;
        logger({ event: "message_cancelled", messageId: message.id, from: current.id, to: message.to });
        json(response, 200, { message });
        return;
      }

      if (method === "GET" && messageMatch) {
        const current = requireAgent(request);
        requireProjectAuth(request, current.project);
        expireMessages();
        const message = messages.get(decodeURIComponent(messageMatch[1]!));
        if (!message) throw new ProtocolError(404, "message not found", "message_not_found");
        if (message.from !== current.id && message.to !== current.id) {
          throw new ProtocolError(403, "message is not visible to this agent", "message_forbidden");
        }
        json(response, 200, { message });
        return;
      }

      throw new ProtocolError(404, "route not found", "route_not_found");
    } catch (error) {
      const statusCode = error instanceof ProtocolError ? error.statusCode : 500;
      const code = error instanceof ProtocolError ? error.code : "internal_error";
      const internalMessage = error instanceof Error ? error.message : "unknown error";
      const publicMessage = statusCode >= 500 ? "internal server error" : internalMessage;
      counters.errors += 1;
      logger({ event: "request_error", requestId, statusCode, code, ...(statusCode >= 500 ? { message: internalMessage } : {}) });
      if (!response.headersSent) json(response, statusCode, { error: publicMessage, code, requestId });
      else response.end();
    }
  });

  return {
    server,
    state: { agents, messages, workflowRuns, journal, persistent: store.persistent },
    async start() {
      if (closed) throw new Error("hub is closed");
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      cleanupTimer = setInterval(() => {
        const cutoff = Date.now() - staleAfterMs;
        for (const agent of agents.values()) {
          if (agent.online && Date.parse(agent.lastSeenAt) < cutoff) {
            agent.online = false;
            store.saveAgent(agent);
            broadcastPresence(agent);
            logger({ event: "agent_stale", agentId: agent.id, project: agent.project });
          }
        }
        expireMessages();
        expireWorkflowWaits();
        purgeTerminalMessages();
        const rateCutoff = Date.now() - (rateLimit?.windowMs ?? 0);
        for (const [key, bucket] of rateBuckets) {
          if (bucket.startedAt < rateCutoff) rateBuckets.delete(key);
        }
      }, cleanupIntervalMs);
      cleanupTimer.unref();
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("hub did not expose a TCP address");
      return { host, port: address.port, url: `http://${host}:${address.port}` };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (cleanupTimer) clearInterval(cleanupTimer);
      const serverClosed = server.listening
        ? new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
        : Promise.resolve();
      const forceClose = setTimeout(() => server.closeAllConnections(), shutdownGraceMs);
      forceClose.unref();
      for (const clients of streams.values()) {
        for (const client of clients) {
          clearInterval(client.heartbeat);
          client.response.end();
        }
      }
      streams.clear();
      server.closeIdleConnections();
      try {
        await serverClosed;
      } finally {
        clearTimeout(forceClose);
      }
      store.close();
    },
  };
}

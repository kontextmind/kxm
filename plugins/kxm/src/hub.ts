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
  type WorkflowMessageContext,
} from "./protocol.ts";
import { workflowScopeExtras } from "./diagnostics.ts";
import { arbitrate, explainContextItem, journalEntryToContextItem, rolePolicy } from "./arbiter.ts";
import { contextItemAuditMetadata, CONTEXT_AUTHORITIES, CONTEXT_CONFIDENCES, type ContextAuthority, type ContextConfidence, type ContextItem } from "./context.ts";
import { NativeStateProvider } from "./state.ts";
import { compileKnowledgeWiki, lintKnowledgeWiki, type WikiSourcePool } from "./wiki.ts";
import { buildRetrospective, writeRetrospective } from "./retrospective.ts";
import { MeshStore, type StoredAgent } from "./store.ts";
import {
  canonicalWorkflowEvidenceKey,
  approveWorkflowDegradation,
  checkpointRun,
  improvementReport,
  applyJournalPromotion,
  journalEvidenceRequired,
  parseJournalCategory,
  renderWorkflowPrompt,
  resumeWorkflowFromSignal,
  valueAtPath,
  waitForWorkflowSignal,
  verifyWorkflowEvidenceReferences,
  workflowDefinitionHash,
  workflowEvidenceStrings,
  type ImprovementArea,
  type JournalCategory,
  type WebhookWorkflowDefinition,
  type WorkflowCheckpointStatus,
  type WorkflowEvidenceInput,
  type WorkflowEvidenceReferenceInput,
  type WorkflowJournalEntry,
  type WorkflowRun,
  type WorkflowSignalReceipt,
  type WorkflowStageState,
  type WorkflowVerifiedEvidence,
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
  assetsDir?: string;
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

type SseClient = { response: ServerResponse; heartbeat: NodeJS.Timeout; presenceOnly?: boolean };
type OpsSseClient = SseClient & { project: string };
type OpsTopic = "agents" | "messages" | "workflows";
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

function sameWorkflowMessageContext(
  left: WorkflowMessageContext | undefined,
  right: WorkflowMessageContext | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.schema === right.schema
    && left.runId === right.runId
    && left.stageId === right.stageId
    && left.requirementKey === right.requirementKey
    && left.attempt === right.attempt;
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
  workflowContext: WorkflowMessageContext | undefined,
): boolean {
  return (message.to === target || message.toName.toLowerCase() === target.toLowerCase())
    && message.content === content
    && message.delivery === delivery
    && message.correlationId === correlationId
    && message.replyTo === replyTo
    && message.hops === hops
    && message.maxHops === maxHops
    && sameWorkflowMessageContext(message.workflowContext, workflowContext)
    && Date.parse(message.expiresAt) - Date.parse(message.createdAt) === ttlMs;
}

function parseContextAuthority(value: unknown): ContextAuthority {
  if (typeof value !== "string" || !CONTEXT_AUTHORITIES.includes(value as ContextAuthority)) {
    throw new ProtocolError(400, "authority must be one of policy, instruction, evidence, hypothesis", "invalid_context_request");
  }
  return value as ContextAuthority;
}

function parseContextConfidence(value: unknown): ContextConfidence {
  if (typeof value !== "string" || !CONTEXT_CONFIDENCES.includes(value as ContextConfidence)) {
    throw new ProtocolError(400, "confidence must be one of verified, probable, uncertain", "invalid_context_request");
  }
  return value as ContextConfidence;
}

function boundedStringList(value: unknown, field: string, maxItems = 32): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new ProtocolError(400, `${field} must be an array with at most ${maxItems} items`);
  }
  return value.map((item, index) => requireString(item, `${field}[${index}]`, { max: 1_000 }));
}

function boundedWorkflowEvidence(value: unknown, field = "evidence", maxItems = 64): WorkflowEvidenceInput {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, `${field} must be an object keyed by required evidence identity`, "invalid_workflow_evidence");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxItems) {
    throw new ProtocolError(400, `${field} must contain at most ${maxItems} keyed items`, "invalid_workflow_evidence");
  }
  const evidence = new Map<string, string>();
  for (const [rawRequirement, rawEvidence] of entries) {
    const requirement = canonicalWorkflowEvidenceKey(
      requireString(rawRequirement, `${field} requirement`, { max: 128 }),
    );
    if (evidence.has(requirement)) {
      throw new ProtocolError(
        400,
        `${field} contains duplicate normalized requirement identity: ${requirement}`,
        "invalid_workflow_evidence",
      );
    }
    evidence.set(requirement, requireString(rawEvidence, `${field}.${requirement}`, { max: 1_000 }));
  }
  return Object.fromEntries(evidence);
}

function boundedWorkflowEvidenceReferences(
  value: unknown,
  field = "evidenceRefs",
  maxItems = 32,
): WorkflowEvidenceReferenceInput {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, `${field} must be an object keyed by required evidence identity`, "invalid_workflow_evidence_refs");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxItems) {
    throw new ProtocolError(400, `${field} must contain at most ${maxItems} requirements`, "invalid_workflow_evidence_refs");
  }
  const references = new Map<string, { messageIds: string[] }>();
  for (const [rawRequirement, rawReference] of entries) {
    const requirement = canonicalWorkflowEvidenceKey(
      requireString(rawRequirement, `${field} requirement`, { max: 128 }),
    );
    if (references.has(requirement)) {
      throw new ProtocolError(
        400,
        `${field} contains duplicate normalized requirement identity: ${requirement}`,
        "invalid_workflow_evidence_refs",
      );
    }
    if (!rawReference || typeof rawReference !== "object" || Array.isArray(rawReference)) {
      throw new ProtocolError(400, `${field}.${requirement} must be an object`, "invalid_workflow_evidence_refs");
    }
    const referenceObject = rawReference as Record<string, unknown>;
    if (Object.keys(referenceObject).some((key) => key !== "messageIds")) {
      throw new ProtocolError(
        400,
        `${field}.${requirement} may contain only messageIds; provenance is hub-derived`,
        "invalid_workflow_evidence_refs",
      );
    }
    const rawIds = referenceObject.messageIds;
    if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > 16) {
      throw new ProtocolError(
        400,
        `${field}.${requirement}.messageIds must contain between 1 and 16 IDs`,
        "invalid_workflow_evidence_refs",
      );
    }
    const messageIds = rawIds.map((candidate, index) =>
      requireString(candidate, `${field}.${requirement}.messageIds[${index}]`, { max: 80 }));
    if (new Set(messageIds).size !== messageIds.length) {
      throw new ProtocolError(400, `${field}.${requirement}.messageIds must be unique`, "invalid_workflow_evidence_refs");
    }
    references.set(requirement, { messageIds });
  }
  return Object.fromEntries(references);
}

function requestedWorkflowMessageContext(value: unknown): Omit<WorkflowMessageContext, "schema"> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "workflowContext must be an object", "invalid_workflow_context");
  }
  const context = value as Record<string, unknown>;
  if (Object.keys(context).some((key) => !["runId", "stageId", "requirementKey", "attempt"].includes(key))) {
    throw new ProtocolError(400, "workflowContext contains unsupported fields", "invalid_workflow_context");
  }
  if (context.attempt === undefined) {
    throw new ProtocolError(400, "workflowContext.attempt is required", "invalid_workflow_context");
  }
  return {
    runId: requireString(context.runId, "workflowContext.runId", { max: 80 }),
    stageId: requireString(context.stageId, "workflowContext.stageId", { max: 64 }),
    requirementKey: canonicalWorkflowEvidenceKey(
      requireString(context.requirementKey, "workflowContext.requirementKey", { max: 128 }),
    ),
    attempt: parseBoundedInteger(context.attempt, "workflowContext.attempt", 1, 1, 20),
  };
}

function validateWorkflowSignalContext(
  evidence: WorkflowEvidenceInput,
  runId: string,
  stageId: string,
  signalKey: string,
): void {
  const expectedContext: Record<string, string> = {
    "workflow.run": runId,
    "workflow.stage": stageId,
    "workflow.signal": signalKey,
  };
  for (const [contextKey, expectedValue] of Object.entries(expectedContext)) {
    const suppliedValue = evidence[contextKey];
    if (suppliedValue === undefined || suppliedValue === expectedValue) continue;
    throw new ProtocolError(
      409,
      `evidence ${contextKey} does not match the workflow signal route and active wait`,
      "workflow_signal_context_mismatch",
      { contextKey },
    );
  }
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
  const assetsDir = options.assetsDir;
  const store = new MeshStore(options.dataPath);
  const agents = store.agents;
  const messages = store.messages;
  function agentLogSide(id: string, fallbackName: string, side: "from" | "to") {
    const agent = agents.get(id);
    return {
      [side]: id,
      [`${side}Name`]: agent?.name ?? fallbackName,
      [`${side}Online`]: Boolean(agent?.online),
      ...(agent?.model ? { [`${side}Model`]: agent.model } : {}),
    };
  }
  function messageLog(message: MessageRecord, fromId: string, fromName: string, toId: string, toName: string) {
    return {
      project: message.project,
      status: message.status,
      delivery: message.delivery,
      ...agentLogSide(fromId, fromName, "from"),
      ...agentLogSide(toId, toName, "to"),
    };
  }
  const workflowRuns = store.workflowRuns;
  const journal = store.journal;
  const stateProvider = new NativeStateProvider(store);
  const streams = new Map<string, Set<SseClient>>();
  const opsStreams = new Set<OpsSseClient>();
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
    workflowDegradations: 0,
    journalEntries: 0,
    contextRequests: 0,
    attemptLatencySecondsTotal: 0,
    meteredCostUsdTotal: 0,
  };
  let cleanupTimer: NodeJS.Timeout | undefined;
  let closed = false;

  function exportTerminalRetrospective(run: WorkflowRun): void {
    if (!assetsDir || (run.status !== "completed" && run.status !== "failed")) return;
    try {
      const entries = [...journal.values()].filter((entry) => entry.runId === run.id);
      const files = writeRetrospective(`${assetsDir}${process.platform === "win32" ? "\\" : "/"}retrospectives`, buildRetrospective(run, entries, run.updatedAt));
      logger({ event: "workflow_retrospective_exported", workflowRunId: run.id, jsonPath: files.jsonPath, markdownPath: files.mdPath });
    } catch (error) {
      logger({ event: "workflow_retrospective_export_failed", workflowRunId: run.id, error: error instanceof Error ? error.message : "retrospective_export_failed" });
    }
  }

  if (!isLoopback(host) && !authToken) {
    store.close();
    throw new Error("KXM_AUTH_TOKEN is required when binding beyond localhost");
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
      throw new ProtocolError(401, "invalid project authentication token", "invalid_auth", {
        operation: "other",
        nextAction: "check_project_token",
      });
    }
  }

  /** Context callers authenticate either as a registered agent (project-
   * scoped to their own project) or with the administrative token (single
   * explicit project scope per request). Returns the validated project and
   * a stable caller identity for provenance. */
  function contextCallerProject(request: IncomingMessage, requested: unknown): { project: string; caller: string } {
    const project = requireString(requested, "project", { max: 200 });
    const agentHeader = request.headers["x-kxm-agent-id"];
    if (typeof agentHeader === "string" && agentHeader.trim()) {
      const agent = requireAgent(request);
      requireProjectAuth(request, agent.project);
      if (agent.project !== project) {
        throw new ProtocolError(403, "context requests are limited to the agent's project", "context_isolation_violation");
      }
      return { project, caller: agent.id };
    }
    requireAdminAuth(request);
    return { project, caller: "kxm-admin" };
  }

  function requireAdminAuth(request: IncomingMessage): void {
    if (!authToken && isLoopback(host)) return;
    if (!authToken || !safeTokenEqual(bearerToken(request), authToken)) {
      throw new ProtocolError(401, "invalid administrative authentication token", "invalid_auth", {
        operation: "other",
        nextAction: "check_project_token",
      });
    }
  }

  function requireConfiguredAdminAuth(request: IncomingMessage, purpose = "workflow degradation approval"): void {
    if (!authToken) {
      throw new ProtocolError(
        503,
        `KXM_AUTH_TOKEN must be configured for ${purpose}`,
        "admin_auth_not_configured",
      );
    }
    requireAdminAuth(request);
  }

  function requireAgent(request: IncomingMessage, expectedId?: string): StoredAgent {
    const agentId = expectedId ?? String(request.headers["x-kxm-agent-id"] ?? "");
    const agentKey = String(request.headers["x-kxm-agent-key"] ?? "");
    const agent = agents.get(agentId);
    if (!agent || !agentKey || !safeTokenEqual(agentKey, agent.key)) {
      throw new ProtocolError(401, "invalid agent identity", "invalid_agent_identity", {
        operation: "other",
        nextAction: "reconnect_with_current_agent_key",
      });
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
    const key = String(request.headers["x-kxm-agent-id"] ?? request.socket.remoteAddress ?? "unknown");
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
    let frame: string | undefined;
    let published = false;
    for (const client of clients) {
      if (client.presenceOnly && event.type !== "presence") continue;
      frame ??= `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      client.response.write(frame);
      published = true;
    }
    return published;
  }

  function publishOps(project: string, topic: OpsTopic): void {
    const frame = `event: ops\ndata: ${JSON.stringify({ type: "ops", project, topic, at: nowIso() })}\n\n`;
    for (const client of opsStreams) {
      if (client.project === project) client.response.write(frame);
    }
  }

  function opsSnapshot(project: string) {
    const projectAgents = [...agents.values()]
      .filter((agent) => agent.project === project)
      .map(publicAgent)
      .sort((left, right) => Number(right.online) - Number(left.online) || left.name.localeCompare(right.name));
    const open = [...messages.values()]
      .filter((message) => message.project === project && (message.status === "queued" || message.status === "delivered"))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    const projectRuns = [...workflowRuns.values()]
      .filter((run) => run.project === project)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return {
      project,
      fetchedAt: nowIso(),
      agents: projectAgents,
      openMessages: open.slice(0, 16).map((message) => ({
        id: message.id,
        status: message.status,
        fromName: message.fromName,
        toName: message.toName,
        delivery: message.delivery,
        createdAt: message.createdAt,
        ...(message.correlationId ? { correlationId: message.correlationId } : {}),
      })),
      openMessageTotal: open.length,
      runs: projectRuns.slice(0, 8).map((run) => {
        const stages = (run.stages ?? []).slice(0, 16).map((stage) => ({
          id: stage.id,
          label: stage.label,
          status: stage.status,
          ...(stage.attempts ? { attempts: stage.attempts } : {}),
        }));
        const done = stages.filter((stage) => stage.status === "passed" || stage.status === "failed" || stage.status === "warning").length;
        return {
          id: run.id,
          status: run.status,
          definitionId: run.definitionId,
          project: run.project,
          ...(run.currentStage ? { currentStage: run.currentStage } : {}),
          ...(run.targetAgentName ? { targetAgentName: run.targetAgentName } : {}),
          ...(run.updatedAt ? { updatedAt: run.updatedAt } : {}),
          ...(stages.length > 0 ? { progress: { done, total: stages.length }, stages } : {}),
        };
      }),
      runTotal: projectRuns.length,
      plans: [...journal.values()]
        .filter((entry) => entry.category === "plan" && projectRuns.some((run) => run.id === entry.runId))
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
        .slice(0, 16)
        .map((entry) => ({
          id: entry.id,
          runId: entry.runId,
          summary: entry.summary.replace(/\s+/g, " ").trim().slice(0, 120),
          createdAt: entry.createdAt,
          ...(entry.stageId ? { stageId: entry.stageId } : {}),
          ...(entry.severity ? { severity: entry.severity } : {}),
        })),
    };
  }

  function broadcastPresence(agent: StoredAgent): void {
    for (const candidate of agents.values()) {
      if (candidate.project === agent.project && candidate.id !== agent.id && candidate.online) {
        publish(candidate.id, { type: "presence", agent: publicAgent(agent) });
      }
    }
    publishOps(agent.project, "agents");
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

  function resolveStageEvidencePolicies(
    stage: WebhookWorkflowDefinition["stages"][number],
    project: string,
    coordinator: StoredAgent,
  ): WorkflowStageState["resolvedEvidencePolicies"] {
    if (!stage.evidencePolicies) return undefined;
    const resolved = new Map<string, NonNullable<WorkflowStageState["resolvedEvidencePolicies"]>[string]>();
    for (const [requirementKey, policy] of Object.entries(stage.evidencePolicies)) {
      const eligible = new Map<string, { id: string; name: string }>();
      for (const selector of policy.eligibleAgents) {
        const agent = findKnownTarget(project, selector);
        if (agent.id === coordinator.id) {
          throw new ProtocolError(
            409,
            `workflow evidence policy ${stage.id}/${requirementKey} cannot include the coordinator`,
            "workflow_evidence_policy_invalid",
          );
        }
        eligible.set(agent.id, { id: agent.id, name: agent.name });
      }
      if (eligible.size < policy.minProducers) {
        throw new ProtocolError(
          409,
          `workflow evidence policy ${stage.id}/${requirementKey} resolves to ${eligible.size} unique producers but requires ${policy.minProducers}`,
          "workflow_evidence_policy_unresolvable",
        );
      }
      resolved.set(requirementKey, {
        kind: "peer-reply",
        minProducers: policy.minProducers,
        eligibleProducers: [...eligible.values()],
        acceptedStatuses: ["replied"],
        ...(policy.degradation ? { degradation: { ...policy.degradation } } : {}),
      });
    }
    return Object.fromEntries(resolved);
  }

  function authorizeWorkflowMessageContext(
    sender: StoredAgent,
    targetInput: string,
    requested: Omit<WorkflowMessageContext, "schema">,
  ): WorkflowMessageContext {
    const run = workflowRuns.get(requested.runId);
    if (!run || run.project !== sender.project || run.targetAgentId !== sender.id) {
      throw new ProtocolError(403, "workflow context is not assigned to this coordinator", "workflow_context_forbidden");
    }
    const stage = run.stages.find((candidate) => candidate.id === requested.stageId);
    if (!stage || run.currentStage !== stage.id || run.status !== "running" || stage.status !== "in_progress") {
      throw new ProtocolError(409, "workflow context does not reference the active stage", "workflow_context_inactive");
    }
    const requirementKey = canonicalWorkflowEvidenceKey(requested.requirementKey);
    const policy = stage.resolvedEvidencePolicies?.[requirementKey];
    if (!policy) {
      throw new ProtocolError(
        400,
        `workflow requirement ${requirementKey} does not accept peer evidence`,
        "workflow_evidence_policy_missing",
      );
    }
    if (requested.attempt !== stage.attempts + 1) {
      throw new ProtocolError(
        409,
        `workflow context attempt ${requested.attempt} does not match active attempt ${stage.attempts + 1}`,
        "workflow_context_attempt_mismatch",
      );
    }
    const normalizedTarget = targetInput.toLowerCase();
    const eligible = policy.eligibleProducers.find(
      (producer) => producer.id === targetInput || producer.name.toLowerCase() === normalizedTarget,
    );
    if (!eligible) {
      throw new ProtocolError(
        403,
        `target ${targetInput} is not eligible for workflow evidence ${requirementKey}`,
        "workflow_evidence_producer_forbidden",
      );
    }
    return {
      schema: "pi-mesh.workflow-message-context.v1",
      runId: run.id,
      stageId: stage.id,
      requirementKey,
      attempt: requested.attempt,
    };
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
    const stageList = definition.stages.map((stage, index) => {
      const peerPolicies = Object.entries(stage.evidencePolicies ?? {}).map(([requirement, policy]) =>
        `   Peer evidence ${requirement}: ${policy.minProducers} unique replied producer(s) from ${policy.eligibleAgents.join(", ")}`);
      return [
        `${index + 1}. ${stage.label} (stageId: ${stage.id}, maxAttempts: ${stage.maxAttempts})`,
        `   ${stage.instructions}`,
        `   Required evidence keys: ${stage.requiredEvidence.join(", ") || "none"}`,
        ...peerPolicies,
      ].join("\n");
    }).join("\n");
    return [
      `Durable workflow run: ${runId}`,
      `Workflow: ${definition.id}`,
      "",
      rendered,
      "",
      "Execute these stages in order:",
      stageList,
      "",
      "At every stage, record material plans, decisions, contradictions, errors, and lessons with kxm_workflow_record.",
      "Keep repository-local configuration in .kxm/config, logs in .kxm/logs, and durable workflow artifacts in .kxm/assets; never commit runtime logs, state, or secrets.",
      "Complete each stage with kxm_workflow_checkpoint. Supply evidence as an object whose keys exactly match the stage's required evidence keys. Unrelated keys never satisfy a requirement. A warning or failure must be corrected and checkpointed again until it passes or the attempt limit is reached.",
      "For a peer-evidence requirement, send or fan out with workflowContext containing this run ID, the exact stage ID, requirement key, and current 1-based attempt. At checkpoint, cite only the returned message IDs under evidenceRefs; the hub derives producer and reply provenance.",
      "When an external system must finish asynchronously, call kxm_workflow_wait with a stable signal key and any already-verified keyed evidence. That evidence is accumulated with the signed callback before the stage can pass; then settle the turn.",
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
    evidence: WorkflowEvidenceInput,
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
      `Evidence: ${workflowEvidenceStrings(evidence).join(", ") || "none supplied"}`,
      "",
      nextInstruction,
      "Review the run with kxm_workflow_get and keep recording material plans, decisions, contradictions, errors, and lessons.",
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
      workflowRunId: run.id,
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
        workflowRunId: transition.id,
        idempotencyKey: `${transition.definitionId}:timeout:${waiting.signalKey}:${waiting.expiresAt}`,
        createdAt: timestamp,
        expiresAt: new Date(Date.parse(timestamp) + ttlMs).toISOString(),
        status: "queued",
      };
      transition.messageId = message.id;
      store.saveWorkflowTransition(transition, message, entry);
      publishOps(transition.project, "workflows");
      publishOps(transition.project, "messages");
      exportTerminalRetrospective(transition);
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
      if (message.to === agentId && (message.status === "queued" || message.status === "delivered")) {
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
        publishOps(message.project, "messages");
        publish(message.from, { type: "expired", message });
        publish(message.to, { type: "expired", message });
        counters.messagesExpired += 1;
        logger({ event: "message_expired", messageId: message.id, ...messageLog(message, message.from, message.fromName, message.to, message.toName) });
        const run = [...workflowRuns.values()].find(
          (candidate) => candidate.messageId === message.id && candidate.status === "running",
        );
        if (run) {
          run.status = "failed";
          delete run.currentStage;
          run.updatedAt = nowIso();
          store.saveWorkflowRun(run);
          publishOps(run.project, "workflows");
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
          exportTerminalRetrospective(run);
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
      publishOps(message.project, "messages");
      counters.messagesPurged += 1;
      logger({ event: "message_purged", messageId: message.id, ...messageLog(message, message.from, message.fromName, message.to, message.toName) });
    }
  }

  function metricsBody(): string {
    const onlineAgents = [...agents.values()].filter((agent) => agent.online).length;
    return [
      "# HELP kxm_online_agents Current online agent count.",
      "# TYPE kxm_online_agents gauge",
      `kxm_online_agents ${onlineAgents}`,
      "# HELP kxm_messages Current retained message count.",
      "# TYPE kxm_messages gauge",
      `kxm_messages ${messages.size}`,
      "# TYPE kxm_requests_total counter",
      `kxm_requests_total ${counters.requests}`,
      "# TYPE kxm_errors_total counter",
      `kxm_errors_total ${counters.errors}`,
      "# TYPE kxm_registrations_total counter",
      `kxm_registrations_total ${counters.registrations}`,
      "# TYPE kxm_messages_sent_total counter",
      `kxm_messages_sent_total ${counters.messagesSent}`,
      "# TYPE kxm_messages_replied_total counter",
      `kxm_messages_replied_total ${counters.messagesReplied}`,
      "# TYPE kxm_messages_cancelled_total counter",
      `kxm_messages_cancelled_total ${counters.messagesCancelled}`,
      "# TYPE kxm_messages_expired_total counter",
      `kxm_messages_expired_total ${counters.messagesExpired}`,
      "# TYPE kxm_messages_purged_total counter",
      `kxm_messages_purged_total ${counters.messagesPurged}`,
      "# TYPE kxm_webhooks_accepted_total counter",
      `kxm_webhooks_accepted_total ${counters.webhooksAccepted}`,
      "# TYPE kxm_workflow_checkpoints_total counter",
      `kxm_workflow_checkpoints_total ${counters.workflowCheckpoints}`,
      "# TYPE kxm_workflow_waits_total counter",
      `kxm_workflow_waits_total ${counters.workflowWaits}`,
      "# TYPE kxm_workflow_signals_total counter",
      `kxm_workflow_signals_total ${counters.workflowSignals}`,
      "# TYPE kxm_workflow_wait_timeouts_total counter",
      `kxm_workflow_wait_timeouts_total ${counters.workflowWaitTimeouts}`,
      "# TYPE kxm_workflow_degradations_total counter",
      `kxm_workflow_degradations_total ${counters.workflowDegradations}`,
      "# TYPE kxm_workflow_journal_entries_total counter",
      `kxm_workflow_journal_entries_total ${counters.journalEntries}`,
      "# TYPE kxm_context_requests_total counter",
      `kxm_context_requests_total ${counters.contextRequests}`,
      "# TYPE kxm_attempt_latency_seconds_total counter",
      `kxm_attempt_latency_seconds_total ${counters.attemptLatencySecondsTotal}`,
      "# TYPE kxm_metered_cost_usd_total counter",
      `kxm_metered_cost_usd_total ${counters.meteredCostUsdTotal}`,
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
          ?? request.headers["x-kxm-delivery-id"];
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
            degraded: existingReceipt.degraded === true,
            degradedRequirements: existingReceipt.degradedRequirements ?? [],
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
        const evidence = boundedWorkflowEvidence(body.evidence);
        const receivedAt = nowIso();
        const transition = structuredClone(workflowRuns.get(runId)!);
        if (transition.status === "waiting" && transition.waiting) {
          validateWorkflowSignalContext(
            evidence,
            runId,
            transition.waiting.stageId,
            signalKey,
          );
        }
        const result = resumeWorkflowFromSignal(transition, signalKey, status, summary, evidence, receivedAt);
        const receipt: WorkflowSignalReceipt = {
          deliveryId,
          payloadHash,
          signalKey,
          stageId: result.stageId,
          status,
          receivedAt,
        };
        if (result.degraded) {
          const degradedStage = transition.stages.find((candidate) => candidate.id === result.stageId)!;
          receipt.degraded = true;
          receipt.degradedRequirements = [...(degradedStage.degradedRequirements ?? [])];
        }
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
            evidence: workflowEvidenceStrings(evidence),
            relatedEntryIds: [],
            createdAt: receivedAt,
          };
        } else if (result.degraded) {
          const stage = transition.stages.find((candidate) => candidate.id === result.stageId)!;
          entry = {
            id: newId("journal"),
            runId: transition.id,
            agentId: transition.targetAgentId,
            category: "decision",
            area: stage.area ?? "security",
            severity: "warning",
            summary: `${stage.label} passed from a signed callback using a previously approved degraded peer quorum`,
            evidence: [
              "class:workflow_quorum_degradation_used",
              ...(stage.degradedRequirements ?? []).map((requirement) => `requirement:${requirement}`),
            ],
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
        publishOps(transition.project, "workflows");
        if (message) publishOps(transition.project, "messages");
        exportTerminalRetrospective(transition);
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
          degraded: result.degraded === true,
          degradedRequirements: receipt.degradedRequirements ?? [],
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
          ?? request.headers["x-kxm-delivery-id"];
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
          workflowRunId: runId,
          idempotencyKey: `${definition.id}:${deliveryId}`,
          createdAt,
          expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
          status: "queued",
        };
        const stages = definition.stages.map((stage, index) => {
          const resolvedEvidencePolicies = resolveStageEvidencePolicies(stage, definition.project, target);
          return {
            ...stage,
            ...(resolvedEvidencePolicies ? { resolvedEvidencePolicies } : {}),
            status: index === 0 ? "in_progress" as const : "pending" as const,
            attempts: 0,
            evidence: {},
            ...(index === 0 ? { startedAt: createdAt, updatedAt: createdAt } : {}),
          };
        });
        const run: WorkflowRun = {
          id: runId,
          definitionId: definition.id,
          source: definition.source,
          deliveryId,
          payloadHash: createHash("sha256").update(rawBody).digest("hex"),
          definitionHash: workflowDefinitionHash(definition),
          ...(event ? { event } : {}),
          project: definition.project,
          targetAgentId: target.id,
          targetAgentName: target.name,
          messageId: message.id,
          status: "running",
          currentStage: stages[0]!.id,
          stages,
          ...(definition.maxTransitions !== undefined ? { maxTransitions: definition.maxTransitions } : {}),
          ...(definition.reproOracle ? { reproOracle: definition.reproOracle } : {}),
          ...(definition.planHash ? { planHashConfig: definition.planHash } : {}),
          ...(definition.requirePlanHash ? { requirePlanHash: definition.requirePlanHash } : {}),
          createdAt,
          updatedAt: createdAt,
        };
        store.saveMessage(message);
        store.saveWorkflowRun(run);
        publishOps(run.project, "messages");
        publishOps(run.project, "workflows");
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

      if (method === "GET" && url.pathname === "/v1/ops/snapshot") {
        requireConfiguredAdminAuth(request, "operations metadata");
        const project = requireString(url.searchParams.get("project"), "project", { max: 128 });
        expireMessages();
        expireWorkflowWaits();
        purgeTerminalMessages();
        json(response, 200, opsSnapshot(project));
        return;
      }

      if (method === "GET" && url.pathname === "/v1/ops/events") {
        requireConfiguredAdminAuth(request, "operations metadata");
        const project = requireString(url.searchParams.get("project"), "project", { max: 128 });
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "x-content-type-options": "nosniff",
        });
        response.write(`event: ready\ndata: ${JSON.stringify({ type: "ops", project, topic: "agents", at: nowIso() })}\n\n`);
        const client: OpsSseClient = {
          project,
          response,
          heartbeat: setInterval(() => response.write(": heartbeat\n\n"), 15_000),
        };
        client.heartbeat.unref();
        opsStreams.add(client);
        request.on("close", () => {
          clearInterval(client.heartbeat);
          opsStreams.delete(client);
        });
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
          throw new ProtocolError(
            403,
            "workflow run is not visible to this agent",
            "workflow_forbidden",
            workflowScopeExtras("get", run.targetAgentName),
          );
        }
        const entries = [...journal.values()].filter((entry) => entry.runId === run.id);
        json(response, 200, { run, journal: entries });
        return;
      }

      const degradationMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/degradations$/);
      if (method === "POST" && degradationMatch) {
        requireConfiguredAdminAuth(request);
        const body = await readJson(request);
        // Resolve the mutable run only after the final await. Concurrent exact
        // retries then observe the first committed approval and remain
        // idempotent instead of cloning the same stale pre-approval state.
        const run = workflowRuns.get(decodeURIComponent(degradationMatch[1]!));
        if (!run) throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        const stageId = requireString(body.stageId, "stageId", { max: 64 });
        const requirementKey = canonicalWorkflowEvidenceKey(
          requireString(body.requirementKey, "requirementKey", { max: 128 }),
        );
        const reason = requireString(body.reason, "reason", { max: 1_000 });
        const timestamp = nowIso();
        const transition = structuredClone(run);
        const result = approveWorkflowDegradation(
          transition,
          stageId,
          requirementKey,
          reason,
          newId("approval"),
          timestamp,
        );
        if (result.created) {
          const stage = transition.stages.find((candidate) => candidate.id === stageId)!;
          const entry: WorkflowJournalEntry = {
            id: newId("journal"),
            runId: transition.id,
            agentId: "kxm-admin",
            category: "decision",
            area: stage.area ?? "security",
            severity: "warning",
            summary: `Approved degraded peer quorum for ${stageId}/${requirementKey} attempt ${result.approval.attempt}`,
            details: reason,
            evidence: [
              "class:workflow_quorum_degradation_approved",
              `approval:${result.approval.id}`,
              `policy-min:${result.approval.policyMinProducers}`,
              `approved-min:${result.approval.approvedMinProducers}`,
            ],
            relatedEntryIds: [],
            createdAt: timestamp,
          };
          store.saveWorkflowTransition(transition, undefined, entry);
          publishOps(transition.project, "workflows");
          counters.workflowDegradations += 1;
          counters.journalEntries += 1;
          logger({
            event: "workflow_degradation_approved",
            workflowRunId: transition.id,
            stageId,
            requirementKey,
            attempt: result.approval.attempt,
            approvalId: result.approval.id,
          });
        }
        json(response, result.created ? 201 : 200, {
          run: result.created ? transition : run,
          approval: result.approval,
          duplicate: !result.created,
        });
        return;
      }

      // ----- Context operating-system surface (v0.5, issue #34) -----

      /** Pool for one project: stored context items plus journal evidence
       * mapped to context items. Agents never see provider internals. */
      function projectContextPool(project: string, journalCategories?: JournalCategory[]): { pool: ContextItem[]; contradictionIds: string[] } {
        const pool = store.listContextItems(project);
        const categoryFilter = journalCategories ? new Set<string>(journalCategories) : undefined;
        const runIds = new Set(
          [...workflowRuns.values()].filter((run) => run.project === project).map((run) => run.id),
        );
        const contradictionIds: string[] = [];
        for (const entry of journal.values()) {
          if (!runIds.has(entry.runId)) continue;
          if (categoryFilter && !categoryFilter.has(entry.category)) continue;
          pool.push(journalEntryToContextItem(entry, project));
          if (entry.category === "contradiction") contradictionIds.push(`journal_${entry.id}`);
        }
        for (const contradiction of stateProvider.contradictions()) {
          if (contradiction.project !== project) continue;
          contradictionIds.push(...contradiction.competingCurrentIds, ...contradiction.competingProposalIds);
        }
        return { pool, contradictionIds };
      }

      /** Full source pool for wiki compilation: every journal-derived item
       * (unfiltered) plus the authoritative state layer. */
      function contextWikiPool(project: string, compiledAt: string): WikiSourcePool {
        const { pool, contradictionIds } = projectContextPool(project);
        const stateItems = store.listContextItems(project, ["state"]);
        const contradictions = stateProvider.contradictions().filter((entry) => entry.project === project);
        return {
          project,
          stateItems,
          contextItems: pool,
          contradictions,
          openContradictionItemIds: contradictionIds,
          compiledAt,
        };
      }

      const contextGetMatch = url.pathname.match(/^\/v1\/context\/get$/);
      if (method === "POST" && contextGetMatch) {
        const body = await readJson(request);
        const { project: callerProject, caller: callerId } = contextCallerProject(request, body.project);
        const policy = rolePolicy(typeof body.role === "string" ? body.role : "");
        const { pool, contradictionIds } = projectContextPool(callerProject, policy.journalCategories);
        const outcome = arbitrate(body, pool, { contradictionIds });
        counters.contextRequests += 1;
        logger({
          event: "context_packet_assembled",
          ...outcome.audit.request,
          selectedIds: outcome.audit.selectedIds,
          provenanceSummary: outcome.audit.provenanceSummary,
          estimatedTokens: outcome.audit.estimatedTokens,
          budgetTokens: outcome.audit.budgetTokens,
          candidateCount: outcome.audit.candidateCount,
          excludedSuperseded: outcome.audit.excludedSuperseded,
        });
        json(response, 200, { packet: outcome.packet, audit: outcome.audit });
        return;
      }

      const contextRecallMatch = url.pathname.match(/^\/v1\/context\/recall$/);
      if (method === "POST" && contextRecallMatch) {
        const body = await readJson(request);
        const { project: callerProject, caller: callerId } = contextCallerProject(request, body.project);
        const query = requireString(body.query ?? "", "query", { max: 500, allowEmpty: true }).toLowerCase();
        const kinds = Array.isArray(body.kinds)
          ? body.kinds.filter((kind: unknown): kind is string => typeof kind === "string")
          : undefined;
        const limit = parseBoundedInteger(body.limit, "limit", 25, 1, 100);
        const { pool } = projectContextPool(callerProject);
        const recalled = pool
          .filter((item) => item.status !== "superseded" && item.status !== "rejected")
          .filter((item) => kinds === undefined || kinds.includes(item.kind))
          .filter((item) => query === "" || item.summary.toLowerCase().includes(query) || (item.stateKey ?? "").toLowerCase().includes(query))
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(0, limit);
        counters.contextRequests += 1;
        logger({ event: "context_recall", project: callerProject, query, limit, results: recalled.length });
        json(response, 200, { items: recalled.map(contextItemAuditMetadata), unresolvedGaps: recalled.length === 0 ? ["no matching context records"] : [] });
        return;
      }

      const contextStateMatch = url.pathname.match(/^\/v1\/context\/state$/);
      if (method === "POST" && contextStateMatch) {
        const body = await readJson(request);
        const { project: callerProject, caller: callerId } = contextCallerProject(request, body.project);
        const key = requireString(body.key, "key", { max: 200 });
        const asOf = body.asOf === undefined || body.asOf === null ? undefined : requireString(body.asOf, "asOf", { max: 64 });
        const current = await stateProvider.get(callerProject, key, asOf);
        counters.contextRequests += 1;
        json(response, 200, { state: current, key });
        return;
      }

      const contextStateProposeMatch = url.pathname.match(/^\/v1\/context\/state\/propose$/);
      if (method === "POST" && contextStateProposeMatch) {
        const body = await readJson(request);
        const { project: callerProject, caller: callerId } = contextCallerProject(request, body.project);
        const proposalId = await stateProvider.propose({
          schema: "kxm.state-change-proposal.v1",
          project: callerProject,
          key: requireString(body.key, "key", { max: 200 }),
          summary: requireString(body.summary, "summary", { max: 4_000 }),
          authority: parseContextAuthority(body.authority),
          confidence: parseContextConfidence(body.confidence),
          evidenceRefs: boundedStringList(body.evidenceRefs, "evidenceRefs", 32),
          proposedBy: callerId,
        });
        counters.contextRequests += 1;
        publishOps(callerProject, "workflows");
        logger({ event: "context_state_proposed", project: callerProject, proposalId, proposedBy: callerId });
        json(response, 201, { proposalId });
        return;
      }

      const contextStatePromoteMatch = url.pathname.match(/^\/v1\/context\/state\/promote$/);
      if (method === "POST" && contextStatePromoteMatch) {
        // Agents may propose state but never silently promote it: promotion is
        // an authorized control-plane decision with durable evidence.
        requireAdminAuth(request);
        const body = await readJson(request);
        const proposalId = requireString(body.proposalId, "proposalId", { max: 128 });
        const project = requireString(body.project, "project", { max: 200 });
        const evidence = boundedStringList(body.evidence, "evidence", 32);
        const promoted = await stateProvider.promote(proposalId, evidence, "kxm-admin");
        counters.contextRequests += 1;
        publishOps(project, "workflows");
        logger({ event: "context_state_promoted", project, proposalId, promotedId: promoted.id, stateKey: promoted.stateKey });
        json(response, 200, { state: promoted });
        return;
      }

      const contextEpisodeMatch = url.pathname.match(/^\/v1\/context\/episode$/);
      if (method === "POST" && contextEpisodeMatch) {
        const body = await readJson(request);
        const { project: callerProject, caller: callerId } = contextCallerProject(request, body.project);
        const runId = body.workflowRunId === undefined || body.workflowRunId === null
          ? undefined
          : requireString(body.workflowRunId, "workflowRunId", { max: 128 });
        const runIds = new Set(
          [...workflowRuns.values()]
            .filter((run) => run.project === callerProject && (runId === undefined || run.id === runId))
            .map((run) => run.id),
        );
        const episodes = [...journal.values()]
          .filter((entry) => runIds.has(entry.runId))
          .filter((entry) => entry.category === "error" || entry.category === "lesson" || entry.category === "observation" || entry.category === "experiment")
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
          .map((entry) => journalEntryToContextItem(entry, callerProject))
          .slice(0, 50);
        counters.contextRequests += 1;
        json(response, 200, { episodes });
        return;
      }

      const contextExplainMatch = url.pathname.match(/^\/v1\/context\/explain$/);
      if (method === "POST" && contextExplainMatch) {
        const body = await readJson(request);
        const { project: callerProject, caller: callerId } = contextCallerProject(request, body.project);
        const id = requireString(body.id, "id", { max: 128 });
        const { pool } = projectContextPool(callerProject);
        const explanation = explainContextItem(id, pool);
        counters.contextRequests += 1;
        json(response, 200, {
          found: explanation.item !== undefined,
          lineage: explanation.lineage,
          evidenceRefs: explanation.evidenceRefs,
          sources: explanation.sources,
        });
        return;
      }

      const contextWikiCompileMatch = url.pathname.match(/^\/v1\/context\/wiki\/compile$/);
      if (method === "POST" && contextWikiCompileMatch) {
        const body = await readJson(request);
        const { project: callerProject } = contextCallerProject(request, body.project);
        const wikiPool = contextWikiPool(callerProject, nowIso());
        const wiki = compileKnowledgeWiki(wikiPool);
        counters.contextRequests += 1;
        logger({
          event: "context_wiki_compiled",
          project: callerProject,
          pages: wiki.audit.pages.length,
          contradictions: wiki.audit.contradictions,
        });
        json(response, 200, {
          audit: wiki.audit,
          lint: lintKnowledgeWiki(wiki.pages, wikiPool),
          pages: [...wiki.pages].sort(([left], [right]) => left.localeCompare(right)).map(([path, content]) => ({ path, content })),
        });
        return;
      }

      const journalPromotionMatch = url.pathname.match(/^\/v1\/journal\/([^/]+)\/promotion$/);
      if (method === "POST" && journalPromotionMatch) {
        // Governed promotion is a control-plane decision. Only hub admins
        // may decide it, and the deciding principal can never be the entry
        // author. Journal entries remain evidence: this endpoint changes a
        // learning lifecycle state, never gates, workflow policy, or
        // permissions.
        requireAdminAuth(request);
        const body = await readJson(request);
        const entryId = decodeURIComponent(journalPromotionMatch[1]!);
        const entry = journal.get(entryId);
        if (!entry) throw new ProtocolError(404, "journal entry not found", "journal_not_found");
        const to = requireString(body.to, "to", { max: 24 });
        if (to !== "approved" && to !== "rejected" && to !== "quarantined") {
          throw new ProtocolError(
            400,
            "journal promotion target must be approved, rejected, or quarantined",
            "invalid_journal_promotion",
          );
        }
        const evidenceRefs = boundedStringList(body.evidenceRefs, "evidenceRefs", 32);
        const updated = applyJournalPromotion(
          entry,
          {
            to,
            evidenceRefs,
            decidedBy: "kxm-admin",
            reason: requireString(body.reason, "reason", { max: 1_000 }),
          },
          nowIso(),
        );
        store.saveJournalEntry(updated);
        publishOps(entry.runId, "workflows");
        logger({
          event: "journal_promotion_recorded",
          journalEntryId: entry.id,
          workflowRunId: entry.runId,
          category: entry.category,
          to,
        });
        json(response, 200, { entry: updated });
        return;
      }

      const waitMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/waits$/);
      if (method === "POST" && waitMatch) {
        expireWorkflowWaits();
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const body = await readJson(request);
        // Do not retain a workflow object across body I/O; another request may
        // have advanced this run while the body was still arriving.
        const run = workflowRuns.get(decodeURIComponent(waitMatch[1]!));
        if (!run) throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        if (run.project !== agent.project || run.targetAgentId !== agent.id) {
          throw new ProtocolError(
            403,
            "only the assigned coordinator can wait this workflow",
            "workflow_forbidden",
            workflowScopeExtras("wait", run.targetAgentName),
          );
        }
        const stageId = requireString(body.stageId, "stageId", { max: 64 });
        const signalKey = workflowSignalKey(body.signalKey);
        const summary = requireString(body.summary, "summary", { max: 4_000 });
        const evidence = boundedWorkflowEvidence(body.evidence);
        const evidenceRefs = boundedWorkflowEvidenceReferences(body.evidenceRefs);
        const timeoutMs = parseBoundedInteger(
          body.timeoutMs,
          "timeoutMs",
          DEFAULT_WORKFLOW_WAIT_TIMEOUT_MS,
          MIN_WORKFLOW_WAIT_TIMEOUT_MS,
          MAX_WORKFLOW_WAIT_TIMEOUT_MS,
        );
        const createdAt = nowIso();
        const transition = structuredClone(run);
        const stage = transition.stages.find((candidate) => candidate.id === stageId);
        const verifiedEvidence: WorkflowVerifiedEvidence = stage && Object.keys(evidenceRefs).length
          ? verifyWorkflowEvidenceReferences(
              transition,
              stage,
              evidenceRefs,
              { getMessage: (messageId) => messages.get(messageId) },
              createdAt,
            )
          : {};
        waitForWorkflowSignal(
          transition,
          stageId,
          signalKey,
          summary,
          createdAt,
          new Date(Date.parse(createdAt) + timeoutMs).toISOString(),
          evidence,
          verifiedEvidence,
        );
        store.saveWorkflowTransition(transition);
        publishOps(transition.project, "workflows");
        counters.workflowWaits += 1;
        logger({
          event: "workflow_wait_started",
          workflowRunId: transition.id,
          stageId,
          signalKey,
          expiresAt: transition.waiting?.expiresAt,
        });
        json(response, 202, {
          run: transition,
          instruction: "The agent may now settle this turn. A signed external signal will checkpoint the stage and resume the coordinator when more work is required.",
        });
        return;
      }

      const checkpointMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/checkpoints$/);
      if (method === "POST" && checkpointMatch) {
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const body = await readJson(request);
        // Re-read authoritative state after body I/O so concurrent attempts
        // cannot checkpoint from the same stale run snapshot.
        const run = workflowRuns.get(decodeURIComponent(checkpointMatch[1]!));
        if (!run) throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        if (run.project !== agent.project || run.targetAgentId !== agent.id) {
          throw new ProtocolError(
            403,
            "only the assigned coordinator can checkpoint this workflow",
            "workflow_forbidden",
            workflowScopeExtras("checkpoint", run.targetAgentName),
          );
        }
        const stageId = requireString(body.stageId, "stageId", { max: 64 });
        const status = requireString(body.status, "status", { max: 16 }) as WorkflowCheckpointStatus;
        if (status !== "passed" && status !== "warning" && status !== "failed") {
          throw new ProtocolError(400, "status must be passed, warning, or failed", "invalid_checkpoint_status");
        }
        const summary = requireString(body.summary, "summary", { max: 4_000 });
        const evidence = boundedWorkflowEvidence(body.evidence);
        const evidenceRefs = boundedWorkflowEvidenceReferences(body.evidenceRefs);
        if (status !== "passed" && Object.keys(evidenceRefs).length) {
          throw new ProtocolError(
            400,
            "evidenceRefs are accepted only for a passing checkpoint or workflow wait",
            "invalid_workflow_evidence_refs",
          );
        }
        const timestamp = nowIso();
        const transition = structuredClone(run);
        const stage = transition.stages.find((candidate) => candidate.id === stageId);
        const verifiedEvidence: WorkflowVerifiedEvidence = stage && Object.keys(evidenceRefs).length
          ? verifyWorkflowEvidenceReferences(
              transition,
              stage,
              evidenceRefs,
              { getMessage: (messageId) => messages.get(messageId) },
              timestamp,
            )
          : {};
        const result = checkpointRun(
          transition,
          stageId,
          status,
          summary,
          evidence,
          timestamp,
          verifiedEvidence,
          typeof body.outcome === "string" && body.outcome.trim()
            ? requireString(body.outcome, "outcome", { max: 64 })
            : undefined,
        );
        const checkpointStage = transition.stages.find((candidate) => candidate.id === stageId)!;
        if (result.transition) {
          const transitionEntry: WorkflowJournalEntry = {
            id: newId("journal"),
            runId: transition.id,
            agentId: agent.id,
            category: "state-change",
            area: checkpointStage?.area ?? "workflow",
            severity: "info",
            summary: `typed transition ${result.transition.fromStage} -> ${result.transition.toStage} (${result.transition.outcome})`,
            evidence: result.transition.evidenceKeys.map((key) => `requirement:${key}`),
            relatedEntryIds: [],
            createdAt: timestamp,
          };
          store.saveWorkflowTransition(transition, undefined, transitionEntry);
          counters.journalEntries += 1;
        }
        if (result.exhausted) {
          const exhaustEntry: WorkflowJournalEntry = {
            id: newId("journal"),
            runId: transition.id,
            agentId: agent.id,
            category: "error",
            area: checkpointStage?.area ?? "workflow",
            severity: "error",
            summary: `transition budget exhausted at ${stageId} (outcome ${body.outcome ?? status}); run failed safely`,
            evidence: [`class:transition_budget_exhausted`, `stage:${stageId}`],
            relatedEntryIds: [],
            createdAt: timestamp,
          };
          store.saveWorkflowTransition(transition, undefined, exhaustEntry);
          counters.journalEntries += 1;
        }
        let entry: WorkflowJournalEntry | undefined;
        if (status !== "passed") {
          entry = {
            id: newId("journal"),
            runId: transition.id,
            agentId: agent.id,
            category: "error",
            area: checkpointStage.area ?? "workflow",
            severity: status === "failed" ? "error" : "warning",
            summary: `${checkpointStage.label}: ${summary}`,
            evidence: workflowEvidenceStrings(evidence),
            relatedEntryIds: [],
            createdAt: transition.updatedAt,
          };
        } else if (result.degraded) {
          entry = {
            id: newId("journal"),
            runId: transition.id,
            agentId: agent.id,
            category: "decision",
            area: checkpointStage.area ?? "security",
            severity: "warning",
            summary: `${checkpointStage.label} passed using an explicitly approved degraded peer quorum`,
            evidence: [
              "class:workflow_quorum_degradation_used",
              ...(checkpointStage.degradedRequirements ?? []).map((requirement) => `requirement:${requirement}`),
            ],
            relatedEntryIds: [],
            createdAt: transition.updatedAt,
          };
        }
        store.saveWorkflowTransition(transition, undefined, entry);
        publishOps(transition.project, "workflows");
        counters.workflowCheckpoints += 1;
        if (entry) counters.journalEntries += 1;
        exportTerminalRetrospective(transition);
        logger({
          event: "workflow_checkpoint",
          workflowRunId: transition.id,
          stageId,
          status,
          attempt: transition.stages.find((candidate) => candidate.id === stageId)?.attempts,
          retry: result.retry,
          completed: result.completed,
        });
        json(response, 200, {
          run: transition,
          retry: result.retry,
          completed: result.completed,
          instruction: result.retry
            ? "Correct the warning or failure, record what changed, rerun the relevant checks, and checkpoint this stage again."
            : result.completed
              ? "Workflow checkpoints are complete. Return the final outcome with links and evidence."
              : `Continue with stage ${transition.currentStage}.`,
        });
        return;
      }

      const journalMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/journal$/);
      if (method === "POST" && journalMatch) {
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const body = await readJson(request);
        const run = workflowRuns.get(decodeURIComponent(journalMatch[1]!));
        if (!run) throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        if (run.project !== agent.project || run.targetAgentId !== agent.id) {
          throw new ProtocolError(
            403,
            "only the assigned coordinator can journal this workflow",
            "workflow_forbidden",
            workflowScopeExtras("journal", run.targetAgentName),
          );
        }
        const category = parseJournalCategory(body.category);
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
        const evidence = boundedStringList(body.evidence, "evidence");
        if (journalEvidenceRequired(category) && evidence.length < 1) {
          throw new ProtocolError(
            400,
            `journal category ${category} requires at least one durable evidence reference`,
            "journal_evidence_required",
          );
        }
        let stageId: string | undefined;
        let attempt: number | undefined;
        if (body.stageId !== undefined && body.stageId !== null) {
          stageId = requireString(body.stageId, "stageId", { max: 128 });
          const stage = run.stages.find((candidate) => candidate.id === stageId);
          if (!stage) {
            throw new ProtocolError(400, `stageId ${stageId} is not part of this workflow run`, "invalid_journal_relation");
          }
          attempt = stage.attempts + 1;
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
          evidence,
          relatedEntryIds,
          createdAt: nowIso(),
          ...(stageId !== undefined ? { stageId } : {}),
          ...(attempt !== undefined ? { attempt } : {}),
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
        const presenceOnly = url.searchParams.get("presenceOnly") === "true";
        if (presenceOnly && current.model !== "kxm-tui") {
          throw new ProtocolError(403, "presence-only streams are reserved for metadata observers", "presence_stream_forbidden");
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "x-content-type-options": "nosniff",
          ...(presenceOnly ? { "x-kxm-events-mode": "presence" } : {}),
        });
        response.write(`event: ready\ndata: ${JSON.stringify({ agent: publicAgent(current) })}\n\n`);
        const client: SseClient = {
          response,
          heartbeat: setInterval(() => response.write(": heartbeat\n\n"), 15_000),
          ...(presenceOnly ? { presenceOnly: true } : {}),
        };
        client.heartbeat.unref();
        const clients = streams.get(agentId) ?? new Set<SseClient>();
        clients.add(client);
        streams.set(agentId, clients);
        if (!presenceOnly) flushPending(agentId);
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
        const requestedContext = requestedWorkflowMessageContext(body.workflowContext);
        const workflowContext = requestedContext
          ? authorizeWorkflowMessageContext(sender, targetInput, requestedContext)
          : undefined;
        const callerCorrelationId = optionalString(body.correlationId, "correlationId", 128);
        if (workflowContext && callerCorrelationId && callerCorrelationId !== workflowContext.runId) {
          throw new ProtocolError(
            409,
            "correlationId must match workflowContext.runId",
            "workflow_context_correlation_mismatch",
          );
        }
        const correlationId = workflowContext?.runId ?? callerCorrelationId;
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
              workflowContext,
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
          ...(workflowContext ? { workflowRunId: workflowContext.runId, workflowContext } : {}),
          createdAt,
          expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
          status: "queued",
        };
        store.saveMessage(message);
        publishOps(message.project, "messages");
        publish(target.id, { type: "message", message });
        counters.messagesSent += 1;
        logger({ event: "message_sent", messageId: message.id, hops, ...messageLog(message, sender.id, sender.name, target.id, target.name) });
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
          publishOps(message.project, "messages");
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
        publishOps(message.project, "messages");
        const workflowRun = [...workflowRuns.values()].find((run) => run.messageId === message.id);
        if (workflowRun?.status === "running") {
          workflowRun.status = "failed";
          delete workflowRun.currentStage;
          workflowRun.updatedAt = message.repliedAt;
          store.saveWorkflowRun(workflowRun);
          publishOps(workflowRun.project, "workflows");
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
          exportTerminalRetrospective(workflowRun);
        }
        publish(message.from, { type: "reply", message });
        counters.messagesReplied += 1;
        logger({ event: "message_replied", messageId: message.id, ...messageLog(message, receiver.id, receiver.name, message.from, message.fromName) });
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
        publishOps(message.project, "messages");
        publish(message.to, { type: "cancelled", message });
        counters.messagesCancelled += 1;
        logger({ event: "message_cancelled", messageId: message.id, ...messageLog(message, current.id, current.name, message.to, message.toName) });
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
      if (!response.headersSent) {
        json(response, statusCode, {
          error: publicMessage,
          code,
          requestId,
          ...(error instanceof ProtocolError && error.extras ? error.extras : {}),
        });
      }
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
      for (const client of opsStreams) {
        clearInterval(client.heartbeat);
        client.response.end();
      }
      opsStreams.clear();
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

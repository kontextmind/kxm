import { randomUUID } from "node:crypto";

export const DEFAULT_PORT = 7331;
export const DEFAULT_STALE_AFTER_MS = 30_000;
export const DEFAULT_MAX_HOPS = 5;
export const DEFAULT_MESSAGE_TTL_MS = 24 * 60 * 60_000;
export const MIN_MESSAGE_TTL_MS = 1_000;
export const MAX_MESSAGE_TTL_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const MIN_MESSAGE_RETENTION_MS = 1_000;
export const DEFAULT_RATE_LIMIT_MAX = 600;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_CONTENT_CHARS = 32_000;
export const MAX_AGENT_HOST_CHARS = 64;
export const MIN_LEASE_TTL_MS = 5_000;
export const MAX_LEASE_TTL_MS = 10 * 60_000;
export const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
export const MAX_LEASE_RESOURCE_CHARS = 200;

export type DeliveryMode = "steer" | "followUp" | "nextTurn";
export type MessageStatus = "queued" | "delivered" | "replied" | "cancelled" | "expired" | "error";
export type AgentPresence = "online" | "stale" | "offline";

/** The durable half of an agent: exactly the fields the hub persists in the
 * agents record JSON. Presence is never stored, so a restored database can
 * never claim an agent was alive. */
export interface AgentIdentity {
  id: string;
  name: string;
  purpose: string;
  project: string;
  model?: string;
  /** Client-declared label for the box this agent runs on. It exists so a
   * reader can tell two boxes apart; the hub never reads it for
   * authorization, project scope, or target resolution. */
  host?: string;
  connectedAt: string;
  lastSeenAt: string;
  online: boolean;
}

/** The public projection of an agent: durable identity plus presence derived
 * from the hub clock at read time. */
export interface AgentRecord extends AgentIdentity {
  /** `lastSeenAt + staleAfterMs`: the heartbeat lease the stale sweep enforces.
   * Absent when projected from the local store without the hub's clock or lease. */
  leaseExpiresAt?: string;
  /** Hub-clocked presence. Absent when the reader has no hub projection. */
  presence?: AgentPresence;
}

/** Presence is hub-clocked and never client-reported. An agent holds its lease
 * until `lastSeenAt + staleAfterMs`; between lease expiry and the sweep that
 * retires it, it reads `stale`; once retired it reads `offline`. An
 * unparseable `lastSeenAt` leaves the lease at the epoch, which reads as an
 * expired lease rather than as a live agent. */
export function agentPresenceView(
  agent: AgentIdentity,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
  now: number = Date.now(),
): { leaseExpiresAt: string; presence: AgentPresence } {
  const lastSeenMs = Date.parse(agent.lastSeenAt);
  const leaseExpiresAtMs = (Number.isFinite(lastSeenMs) ? lastSeenMs : 0) + staleAfterMs;
  const leaseExpiresAt = new Date(leaseExpiresAtMs).toISOString();
  if (!agent.online) return { leaseExpiresAt, presence: "offline" };
  return { leaseExpiresAt, presence: now < leaseExpiresAtMs ? "online" : "stale" };
}

/** Project a durable identity onto the wire shape readers consume. */
export function toAgentRecord(agent: AgentIdentity, staleAfterMs?: number, now?: number): AgentRecord {
  return { ...agent, ...agentPresenceView(agent, staleAfterMs, now) };
}

/** One hub-held fenced lease over a project-scoped resource.
 *
 * `resource` is what the store keys on: the caller's project prefixed onto the
 * name it asked for, so two projects naming the same branch never contend.
 * Expiry is the hub's clock, never the holder's, and `fencingToken` increments
 * only when a new holder takes over an expired lease — a renewal keeps its
 * token, so a writer that comes back after a takeover can be told its token
 * was superseded instead of being allowed to commit. */
export interface LeaseRecord {
  /** `${project}/${name}`. */
  resource: string;
  project: string;
  /** The resource as the caller named it, without the project prefix. */
  name: string;
  holderAgentId: string;
  holderAgentName: string;
  fencingToken: number;
  acquiredAt: string;
  expiresAt: string;
}

/** A Runtime's machine-client presence in one hub project (P5). Not an agent:
 * it holds no agent key, sends no messages, and is admitted by the project
 * token alone. `heartbeatAt` is the hub's clock. */
export interface RuntimePresenceRecord {
  runtimeId: string;
  project: string;
  host?: string;
  registeredAt: string;
  heartbeatAt: string;
}

/** One accepted sync event as the hub holds it (P5). `bytes` is the canonical
 * `kxm.sync-event.v1` text; `contentHash` is its sha256, the conflict test. */
export interface StoredSyncEvent {
  projectId: string;
  runId: string;
  sequence: number;
  hubProject: string;
  homeRuntimeId: string;
  eventType: string;
  contentHash: string;
  receivedAt: string;
  bytes: string;
}

export const MAX_SYNC_BATCH_EVENTS = 100;

export interface MessageReply {
  content: string;
  createdAt: string;
}

/** Hub-authorized scope for a peer request that may later be cited as
 * workflow evidence. Callers request this scope, but the hub validates it
 * against the active run and persists the canonical value. */
export interface WorkflowMessageContext {
  schema: "pi-mesh.workflow-message-context.v1";
  runId: string;
  stageId: string;
  requirementKey: string;
  attempt: number;
}

export type WorkflowCheckpointStatus = "passed" | "warning" | "failed";
export type JournalCategory =
  | "plan"
  | "decision"
  | "contradiction"
  | "error"
  | "lesson"
  | "observation"
  | "hypothesis"
  | "experiment"
  | "state-change"
  | "skill-candidate";
export type ImprovementArea = "harness" | "gates" | "implementation" | "workflow" | "documentation" | "security" | "other";
/** Every improvement area, in report order. The order also breaks ties when
 * a signal's modal area is ambiguous. */
export const IMPROVEMENT_AREAS: readonly ImprovementArea[] = [
  "harness",
  "gates",
  "implementation",
  "workflow",
  "documentation",
  "security",
  "other",
];

/** Evidence submitted for one checkpoint or external signal, keyed by a
 * requirement from WorkflowStageDefinition.requiredEvidence. */
export type WorkflowEvidenceInput = Record<string, string>;

/** Callers cite durable message IDs only. Producer identity and the evidence
 * snapshot are derived by the hub from the stored message. */
export interface WorkflowEvidenceReference {
  messageIds: string[];
}

export type WorkflowEvidenceReferenceInput = Record<string, WorkflowEvidenceReference>;

export interface MessageRecord {
  id: string;
  project: string;
  from: string;
  fromName: string;
  to: string;
  toName: string;
  content: string;
  delivery: DeliveryMode;
  hops: number;
  maxHops: number;
  correlationId?: string;
  replyTo?: string;
  idempotencyKey?: string;
  seq?: number;
  /** Hub-owned durable workflow affinity. Callers cannot establish this field
   * directly; the hub derives it from an authorized workflow context or an
   * internally-created workflow prompt. */
  workflowRunId?: string;
  workflowContext?: WorkflowMessageContext;
  createdAt: string;
  expiresAt: string;
  deliveredAt?: string;
  repliedAt?: string;
  cancelledAt?: string;
  status: MessageStatus;
  reply?: MessageReply;
  error?: string;
}

export type HubEvent =
  | { type: "message"; message: MessageRecord }
  | { type: "reply"; message: MessageRecord }
  | { type: "cancelled"; message: MessageRecord }
  | { type: "expired"; message: MessageRecord }
  | { type: "presence"; agent: AgentRecord };

export class ProtocolError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly extras?: Record<string, unknown>;

  constructor(statusCode: number, message: string, code = "protocol_error", extras?: Record<string, unknown>) {
    super(message);
    this.name = "ProtocolError";
    this.statusCode = statusCode;
    this.code = code;
    if (extras) this.extras = extras;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function requireString(
  value: unknown,
  field: string,
  options: { max?: number; allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") {
    throw new ProtocolError(400, `${field} must be a string`);
  }
  const result = value.trim();
  if (!options.allowEmpty && result.length === 0) {
    throw new ProtocolError(400, `${field} cannot be empty`);
  }
  if (options.max !== undefined && result.length > options.max) {
    throw new ProtocolError(400, `${field} exceeds ${options.max} characters`);
  }
  return result;
}

export function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireString(value, field, { max });
}

export function parseDeliveryMode(value: unknown): DeliveryMode {
  if (value === undefined) return "followUp";
  if (value === "steer" || value === "followUp" || value === "nextTurn") return value;
  throw new ProtocolError(400, "delivery must be steer, followUp, or nextTurn");
}

export function parseBoundedInteger(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ProtocolError(400, `${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

// ---------------------------------------------------------------------------
// Terminal Receipt Protocol (kxm.terminal-receipt.v1)
// ---------------------------------------------------------------------------

export const TERMINAL_RECEIPT_SCHEMA = "kxm.terminal-receipt.v1" as const;

export type TerminalReceiptStatus = "accepted" | "audit_escalation" | "rejected" | "error";

export interface TerminalReceiptFinding {
  rule: string;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface TerminalReceiptEvidence {
  verifiedFiles?: string[];
  gitHash?: string;
  testSummary?: { passed: number; failed: number; skipped: number };
  findings?: TerminalReceiptFinding[];
  [key: string]: unknown;
}

export interface TerminalReceiptMetrics {
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  [key: string]: unknown;
}

export interface TerminalReceipt {
  schema: typeof TERMINAL_RECEIPT_SCHEMA;
  status: TerminalReceiptStatus;
  seat: string;
  runId: string;
  stageId: string;
  timestamp: string;
  host: string;
  model: string;
  evidence?: TerminalReceiptEvidence;
  metrics?: TerminalReceiptMetrics;
  escalationReason?: string;
  ruling?: string;
}

const VALID_TERMINAL_STATUSES = new Set<TerminalReceiptStatus>(["accepted", "audit_escalation", "rejected", "error"]);

export function validateTerminalReceipt(value: unknown): TerminalReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "terminal receipt must be an object", "invalid_terminal_receipt");
  }

  const record = value as Record<string, unknown>;

  if (record.schema !== undefined && record.schema !== TERMINAL_RECEIPT_SCHEMA) {
    throw new ProtocolError(400, `terminal receipt schema must be ${TERMINAL_RECEIPT_SCHEMA}`, "invalid_terminal_receipt");
  }

  const status = record.status as TerminalReceiptStatus;
  if (!status || !VALID_TERMINAL_STATUSES.has(status)) {
    throw new ProtocolError(
      400,
      `terminal receipt status must be one of: ${Array.from(VALID_TERMINAL_STATUSES).join(", ")}`,
      "invalid_terminal_receipt",
    );
  }

  const seat = requireString(record.seat, "seat", { max: 64 });
  const runId = requireString(record.runId, "runId", { max: 128 });
  const stageId = requireString(record.stageId, "stageId", { max: 128 });
  const timestamp = requireString(record.timestamp, "timestamp", { max: 64 });
  const host = requireString(record.host, "host", { max: 64 });
  const model = requireString(record.model, "model", { max: 128 });

  let evidence: TerminalReceiptEvidence | undefined;
  if (record.evidence !== undefined) {
    if (!record.evidence || typeof record.evidence !== "object" || Array.isArray(record.evidence)) {
      throw new ProtocolError(400, "terminal receipt evidence must be an object", "invalid_terminal_receipt");
    }
    evidence = record.evidence as TerminalReceiptEvidence;
  }

  let metrics: TerminalReceiptMetrics | undefined;
  if (record.metrics !== undefined) {
    if (!record.metrics || typeof record.metrics !== "object" || Array.isArray(record.metrics)) {
      throw new ProtocolError(400, "terminal receipt metrics must be an object", "invalid_terminal_receipt");
    }
    metrics = record.metrics as TerminalReceiptMetrics;
  }

  const escalationReason = optionalString(record.escalationReason, "escalationReason", 1024);
  const ruling = optionalString(record.ruling, "ruling", 2048);

  return {
    schema: TERMINAL_RECEIPT_SCHEMA,
    status,
    seat,
    runId,
    stageId,
    timestamp,
    host,
    model,
    ...(evidence ? { evidence } : {}),
    ...(metrics ? { metrics } : {}),
    ...(escalationReason ? { escalationReason } : {}),
    ...(ruling ? { ruling } : {}),
  };
}


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

export type DeliveryMode = "steer" | "followUp" | "nextTurn";
export type MessageStatus = "queued" | "delivered" | "replied" | "cancelled" | "expired" | "error";

export interface AgentRecord {
  id: string;
  name: string;
  purpose: string;
  project: string;
  model?: string;
  connectedAt: string;
  lastSeenAt: string;
  online: boolean;
}

export interface MessageReply {
  content: string;
  createdAt: string;
}

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

  constructor(statusCode: number, message: string, code = "protocol_error") {
    super(message);
    this.name = "ProtocolError";
    this.statusCode = statusCode;
    this.code = code;
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

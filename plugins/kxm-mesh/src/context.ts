import { ProtocolError, newId, requireString } from "./protocol.ts";

/** Core KXM v0.5 context schemas. The context layer is additive to the v0.4
 * mesh/workflow plane: nothing here changes hub or workflow behavior until a
 * context surface explicitly consumes it. */

export const CONTEXT_ITEM_SCHEMA = "kxm.context-item.v1";
export const CONTEXT_REQUEST_SCHEMA = "kxm.context-request.v1";
export const CONTEXT_PACKET_SCHEMA = "kxm.context-packet.v1";

export const MAX_CONTEXT_SUMMARY_CHARS = 4_000;
export const MAX_CONTEXT_DETAILS_CHARS = 32_000;
export const MAX_CONTEXT_ID_REFS = 64;
export const MAX_CONTEXT_ITEMS = 256;
export const MIN_CONTEXT_BUDGET_TOKENS = 512;
export const MAX_CONTEXT_BUDGET_TOKENS = 200_000;
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 32_000;
export const MAX_CONTEXT_ROLE_CHARS = 64;
export const MAX_CONTEXT_TASK_CHARS = 2_000;

export type ContextItemKind = "evidence" | "state" | "episode" | "knowledge" | "skill";
export const CONTEXT_ITEM_KINDS: readonly ContextItemKind[] = ["evidence", "state", "episode", "knowledge", "skill"];

export type ContextSourceType =
  | "human"
  | "git"
  | "workflow"
  | "tool"
  | "peer"
  | "external"
  | "derived";
export const CONTEXT_SOURCE_TYPES: readonly ContextSourceType[] = [
  "human",
  "git",
  "workflow",
  "tool",
  "peer",
  "external",
  "derived",
];

/** Authority classes are ordered: content can only ever carry the authority of
 * its strongest *authorized* origin. Derived/summarized content must not
 * increase authority (enforced by `derivedAuthority` below and hardened by
 * issue #36 invariants). */
export type ContextAuthority = "policy" | "instruction" | "evidence" | "hypothesis";
export const CONTEXT_AUTHORITIES: readonly ContextAuthority[] = ["policy", "instruction", "evidence", "hypothesis"];

export type ContextConfidence = "verified" | "probable" | "uncertain";
export const CONTEXT_CONFIDENCES: readonly ContextConfidence[] = ["verified", "probable", "uncertain"];

export type ContextItemStatus = "current" | "superseded" | "proposed" | "rejected";

/** Immutable content origin. Once written, provenance fields never change for
 * the lifetime of an item ID; corrections mint a new item that supersedes it. */
export interface ContextProvenance {
  sourceType: ContextSourceType;
  sourceRef?: string;
  derivedFrom?: string[];
}

export interface ContextItem {
  id: string;
  kind: ContextItemKind;
  project: string;
  summary: string;
  provenance: ContextProvenance;
  authority: ContextAuthority;
  confidence: ContextConfidence;
  observedAt?: string;
  validFrom?: string;
  validUntil?: string;
  status?: ContextItemStatus;
  supersedes?: string[];
  evidenceRefs?: string[];
}

export type ContextRole =
  | "repro"
  | "planner"
  | "critic"
  | "implementer"
  | "verifier"
  | (string & {});
export const CONTEXT_ROLES: readonly string[] = ["repro", "planner", "critic", "implementer", "verifier"];

export interface ContextRequest {
  project: string;
  role: ContextRole;
  task: string;
  workflowRunId?: string;
  stageId?: string;
  budgetTokens?: number;
  includeKinds?: ContextItemKind[];
}

export interface ContextPacket {
  workingState: Record<string, unknown>;
  currentState: ContextItem[];
  knowledge: ContextItem[];
  episodes: ContextItem[];
  skills: ContextItem[];
  contradictions: ContextItem[];
  unresolvedGaps: string[];
  provenanceSummary: Record<string, number>;
  estimatedTokens: number;
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ProtocolError(400, `${field} must be one of ${allowed.join(", ")}`, "invalid_context_field");
  }
  return value as T;
}

function idRefs(value: unknown, field: string, required = false): string[] | undefined {
  if (value === undefined || value === null) return required ? [] : undefined;
  if (!Array.isArray(value)) {
    throw new ProtocolError(400, `${field} must be an array of identifiers`, "invalid_context_field");
  }
  if (value.length > MAX_CONTEXT_ID_REFS) {
    throw new ProtocolError(
      400,
      `${field} exceeds ${MAX_CONTEXT_ID_REFS} references`,
      "context_limits_exceeded",
    );
  }
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !candidate.trim()) {
      throw new ProtocolError(400, `${field} must contain non-empty identifiers`, "invalid_context_field");
    }
    const ref = candidate.trim();
    if (seen.has(ref)) {
      throw new ProtocolError(400, `${field} contains duplicate reference ${ref}`, "invalid_context_field");
    }
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

function optionalIsoTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ProtocolError(400, `${field} must be an ISO-8601 timestamp`, "invalid_context_field");
  }
  return value;
}

/** Parse and validate a context item from untrusted input. Fails closed on
 * unknown kinds, oversized content, malformed provenance, and incoherent
 * lifecycle fields. */
export function parseContextItem(value: unknown): ContextItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "context item must be an object", "invalid_context_item");
  }
  const input = value as Record<string, unknown>;
  const item: ContextItem = {
    id: requireString(input.id, "context item id", { max: 128 }),
    kind: oneOf(input.kind, "context item kind", CONTEXT_ITEM_KINDS),
    project: requireString(input.project, "context item project", { max: 200 }),
    summary: requireString(input.summary, "context item summary", { max: MAX_CONTEXT_SUMMARY_CHARS }),
    provenance: parseContextProvenance(input.provenance),
    authority: oneOf(input.authority, "context item authority", CONTEXT_AUTHORITIES),
    confidence: oneOf(input.confidence, "context item confidence", CONTEXT_CONFIDENCES),
  };
  const observedAt = optionalIsoTimestamp(input.observedAt, "context item observedAt");
  const validFrom = optionalIsoTimestamp(input.validFrom, "context item validFrom");
  const validUntil = optionalIsoTimestamp(input.validUntil, "context item validUntil");
  if (observedAt !== undefined) item.observedAt = observedAt;
  if (validFrom !== undefined) item.validFrom = validFrom;
  if (validUntil !== undefined) item.validUntil = validUntil;
  if (input.status !== undefined && input.status !== null) {
    item.status = oneOf(input.status, "context item status", ["current", "superseded", "proposed", "rejected"]);
  }
  const supersedes = idRefs(input.supersedes, "context item supersedes");
  if (supersedes !== undefined) {
    if (supersedes.includes(item.id)) {
      throw new ProtocolError(400, "context item cannot supersede itself", "invalid_context_item");
    }
    item.supersedes = supersedes;
  }
  const evidenceRefs = idRefs(input.evidenceRefs, "context item evidenceRefs");
  if (evidenceRefs !== undefined) item.evidenceRefs = evidenceRefs;
  return item;
}

export function parseContextProvenance(value: unknown): ContextProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "context provenance must be an object", "invalid_context_item");
  }
  const input = value as Record<string, unknown>;
  const provenance: ContextProvenance = {
    sourceType: oneOf(input.sourceType, "context provenance sourceType", CONTEXT_SOURCE_TYPES),
  };
  const sourceRef = input.sourceRef === undefined || input.sourceRef === null
    ? undefined
    : requireString(input.sourceRef, "context provenance sourceRef", { max: 512 });
  if (sourceRef !== undefined) provenance.sourceRef = sourceRef;
  const derivedFrom = idRefs(input.derivedFrom, "context provenance derivedFrom");
  if (derivedFrom !== undefined) provenance.derivedFrom = derivedFrom;
  return provenance;
}

/** Parse and validate a context request. Every request is project-scoped; the
 * arbiter (issue #34) never assembles packets across projects. */
export function parseContextRequest(value: unknown): ContextRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "context request must be an object", "invalid_context_request");
  }
  const input = value as Record<string, unknown>;
  const request: ContextRequest = {
    project: requireString(input.project, "context request project", { max: 200 }),
    role: requireString(input.role, "context request role", { max: MAX_CONTEXT_ROLE_CHARS }),
    task: requireString(input.task, "context request task", { max: MAX_CONTEXT_TASK_CHARS }),
  };
  const workflowRunId = input.workflowRunId === undefined || input.workflowRunId === null
    ? undefined
    : requireString(input.workflowRunId, "context request workflowRunId", { max: 128 });
  if (workflowRunId !== undefined) request.workflowRunId = workflowRunId;
  const stageId = input.stageId === undefined || input.stageId === null
    ? undefined
    : requireString(input.stageId, "context request stageId", { max: 128 });
  if (stageId !== undefined) request.stageId = stageId;
  if (input.budgetTokens !== undefined && input.budgetTokens !== null) {
    const budget = input.budgetTokens;
    if (!Number.isInteger(budget) || (budget as number) < MIN_CONTEXT_BUDGET_TOKENS || (budget as number) > MAX_CONTEXT_BUDGET_TOKENS) {
      throw new ProtocolError(
        400,
        `context request budgetTokens must be an integer between ${MIN_CONTEXT_BUDGET_TOKENS} and ${MAX_CONTEXT_BUDGET_TOKENS}`,
        "invalid_context_request",
      );
    }
    request.budgetTokens = budget as number;
  }
  if (input.includeKinds !== undefined && input.includeKinds !== null) {
    if (!Array.isArray(input.includeKinds) || input.includeKinds.length < 1 || input.includeKinds.length > CONTEXT_ITEM_KINDS.length) {
      throw new ProtocolError(
        400,
        "context request includeKinds must be a non-empty array of item kinds",
        "invalid_context_request",
      );
    }
    request.includeKinds = input.includeKinds.map((kind) => oneOf(kind, "context request includeKinds", CONTEXT_ITEM_KINDS));
  }
  return request;
}

/** Validate that a packet only contains items matching the request's project
 * and requested kinds. Cross-project content fails closed. */
export function validateContextPacketContents(request: ContextRequest, packet: ContextPacket): void {
  const items = [...packet.currentState, ...packet.knowledge, ...packet.episodes, ...packet.skills, ...packet.contradictions];
  if (items.length > MAX_CONTEXT_ITEMS) {
    throw new ProtocolError(400, `context packet exceeds ${MAX_CONTEXT_ITEMS} items`, "context_limits_exceeded");
  }
  const allowed = request.includeKinds ? new Set(request.includeKinds) : undefined;
  for (const item of items) {
    if (item.project !== request.project) {
      throw new ProtocolError(
        400,
        `context packet contains cross-project item ${item.id}`,
        "context_isolation_violation",
      );
    }
    if (allowed && !allowed.has(item.kind)) {
      throw new ProtocolError(
        400,
        `context packet contains item ${item.id} of unrequested kind ${item.kind}`,
        "context_isolation_violation",
      );
    }
  }
}

/** Deterministic, dependency-free token estimate. Roughly 4 characters per
 * token; used for budget enforcement, never for billing. */
export function estimateContextTokens(items: ContextItem[]): number {
  let characters = 0;
  for (const item of items) {
    characters += item.summary.length + item.id.length + item.kind.length;
    if (item.provenance.sourceRef) characters += item.provenance.sourceRef.length;
  }
  return Math.ceil(characters / 4);
}

/** Authority rank used to enforce the "never increase through derivation"
 * invariant. `policy` outranks everything; `hypothesis` outranks nothing. */
export function authorityRank(authority: ContextAuthority): number {
  switch (authority) {
    case "policy": return 3;
    case "instruction": return 2;
    case "evidence": return 1;
    case "hypothesis": return 0;
  }
}

/** Authority floor for derived content: a derived item may never carry more
 * authority than the strongest item it derives from. */
export function derivedAuthority(claimed: ContextAuthority, lineage: ContextItem[]): ContextAuthority {
  let floor = authorityRank("hypothesis");
  for (const ancestor of lineage) {
    floor = Math.max(floor, authorityRank(ancestor.authority));
  }
  const claimedRank = authorityRank(claimed);
  if (claimedRank > floor) return "evidence";
  return claimed;
}

/** Mint a new derived context item with provenance that cannot exceed its
 * lineage authority. */
export function deriveContextItem(
  base: Pick<ContextItem, "project" | "kind" | "summary">,
  claimed: ContextAuthority,
  lineage: ContextItem[],
  sourceRef?: string,
): ContextItem {
  const derivedFrom = lineage.map((ancestor) => ancestor.id);
  return {
    id: newId("ctx"),
    kind: base.kind,
    project: base.project,
    summary: base.summary,
    provenance: {
      sourceType: "derived",
      ...(sourceRef !== undefined ? { sourceRef } : {}),
      derivedFrom,
    },
    authority: derivedAuthority(claimed, lineage),
    confidence: "probable",
  };
}

/** Bounded, secret-free metadata describing an item for telemetry and audits.
 * Never includes summaries or raw content bodies. */
export interface ContextItemAuditMetadata {
  id: string;
  kind: ContextItemKind;
  authority: ContextAuthority;
  confidence: ContextConfidence;
  status?: ContextItemStatus;
  sourceType: ContextSourceType;
  derived: boolean;
}

export function contextItemAuditMetadata(item: ContextItem): ContextItemAuditMetadata {
  return {
    id: item.id,
    kind: item.kind,
    authority: item.authority,
    confidence: item.confidence,
    ...(item.status !== undefined ? { status: item.status } : {}),
    sourceType: item.provenance.sourceType,
    derived: item.provenance.sourceType === "derived" || (item.provenance.derivedFrom?.length ?? 0) > 0,
  };
}

/** Build the provenanceSummary bucket for a packet: counts by source type. */
export function provenanceSummaryOf(items: ContextItem[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const item of items) {
    summary[item.provenance.sourceType] = (summary[item.provenance.sourceType] ?? 0) + 1;
  }
  for (const key of Object.keys(summary).sort()) {
    // no-op: ensures deterministic key ordering for stable serialization
    if (summary[key] === 0) delete summary[key];
  }
  return summary;
}

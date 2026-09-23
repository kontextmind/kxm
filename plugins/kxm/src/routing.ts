import { createHash } from "node:crypto";
import { calculateModelCost, type PriceCatalog } from "./price-calc.ts";

/**
 * Model/harness routing telemetry (v0.5, issue #40).
 *
 * Optimization targets complete verified agent configurations, not model
 * names alone. Every run/stage can carry a metadata-only routing record:
 * the behaviorally relevant configuration tuple is content-addressed so two
 * runs are comparable without ever reading raw private context bodies.
 *
 * The behavioral hash covers: model route, role prompt/config hash, skill
 * versions/hashes, tool policy/version, retrieval/context policy, workflow
 * config hash, and verifier config. Everything else (tokens, cost, retries,
 * outcomes) is outcome telemetry, deliberately outside the hash.
 */

export const ROUTING_RECORD_SCHEMA = "kxm.routing-record.v1" as const;
export const ROUTING_RECORD_V2_SCHEMA = "kxm.routing-record.v2" as const;
export const BEHAVIORAL_HASH_VERSION = 1;

export type RoutingCostBasis = "metered" | "unmetered" | "unknown";
export type RoutingVerifierOutcome = "passed" | "warning" | "failed";
export type RoutingFinalOutcome = "accepted" | "blocked" | "failed" | "pending";

export interface RoutingRecordV2 {
  schema: typeof ROUTING_RECORD_V2_SCHEMA;
  recordedAt: string;
  project: string;
  runId: string;
  stepId: string;
  assignmentId: string;
  attemptId: string;
  harness: string;
  provider: string;
  requestedModel: string;
  effectiveModel: string;
  thinking?: string | undefined;
  agentRole?: string | undefined;
  behavioralSha256: string;
  contextTokens?: number | null | undefined;
  tokensIn?: number | null | undefined;
  tokensOut?: number | null | undefined;
  cacheReadTokens?: number | null | undefined;
  cacheWriteTokens?: number | null | undefined;
  latencyMs: number;
  costBasis: RoutingCostBasis;
  costUsd?: number | null | undefined;
  priceRef?: string | null | undefined;
  verifierOutcome?: RoutingVerifierOutcome | undefined;
  finalOutcome?: RoutingFinalOutcome | string | undefined;
  retries: number;
  transitions?: number | undefined;
  humanInterventions?: number | undefined;
  providerMetadata?: Record<string, string | number | boolean> | undefined;
}

export interface SkillVersionRef {
  id: string;
  contentSha256: string;
}

export interface BehavioralConfigInput {
  /** Requested model route (e.g. "pi/kimi-k3"), normalized. */
  requestedModel?: string | undefined;
  /** Effective model after fallback/rotation, normalized. */
  effectiveModel?: string | undefined;
  /** Reasoning effort identifier (e.g. "high"). */
  reasoningEffort?: string | undefined;
  /** Agent role (repro, planner, ...). */
  agentRole?: string | undefined;
  /** Role prompt/config content hash. */
  rolePromptSha256?: string | undefined;
  /** Selected skills with pinned content hashes. */
  skills?: SkillVersionRef[] | undefined;
  /** Context/retrieval policy version. */
  contextPolicyVersion?: string | undefined;
  /** Tool policy/schema version. */
  toolPolicyVersion?: string | undefined;
  /** Workflow definition hash. */
  workflowDefinitionSha256?: string | undefined;
  /** Verifier configuration hash. */
  verifierConfigSha256?: string | undefined;
}

export interface RoutingRecord {
  schema: typeof ROUTING_RECORD_SCHEMA;
  behavioralHashVersion: typeof BEHAVIORAL_HASH_VERSION;
  behavioralSha256: string;
  workflowRunId?: string;
  stageId?: string;
  attempt?: number;
  requestedModel?: string;
  effectiveModel?: string;
  reasoningEffort?: string;
  agentRole?: string;
  rolePromptSha256?: string;
  skills: SkillVersionRef[];
  contextPolicyVersion?: string;
  contextItemIds: string[];
  toolPolicyVersion?: string;
  workflowDefinitionSha256?: string;
  verifierConfigSha256?: string;
  retries: number;
  transitions: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  humanInterventions: number;
  verifierOutcome?: RoutingVerifierOutcome;
  finalOutcome?: RoutingFinalOutcome;
  /** Additive, normalized provider-specific metadata. Never raw bodies. */
  providerMetadata?: Record<string, string | number | boolean>;
}

export const MAX_CONTEXT_ITEM_IDS = 256;
export const MAX_SKILL_REFS = 32;
export const MAX_PROVIDER_METADATA_FIELDS = 32;

function normalizeModel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
  return normalized === "" ? undefined : normalized;
}

/** Content-addressed hash over the behaviorally relevant tuple. Stable for
 * identical configurations; different for any behavioral difference. */
export function behavioralConfigHash(input: BehavioralConfigInput): string {
  const canonical = {
    version: BEHAVIORAL_HASH_VERSION,
    requestedModel: normalizeModel(input.requestedModel) ?? null,
    effectiveModel: normalizeModel(input.effectiveModel) ?? null,
    reasoningEffort: input.reasoningEffort?.trim() ?? null,
    agentRole: input.agentRole ? input.agentRole.trim().toLowerCase().replace(/\s+/g, "-") : null,
    rolePromptSha256: input.rolePromptSha256?.trim() ?? null,
    skills: (input.skills ?? [])
      .map((skill) => ({ id: skill.id.trim(), sha: skill.contentSha256.trim() }))
      .sort((left, right) => left.id.localeCompare(right.id) || left.sha.localeCompare(right.sha)),
    contextPolicyVersion: input.contextPolicyVersion?.trim() ?? null,
    toolPolicyVersion: input.toolPolicyVersion?.trim() ?? null,
    workflowDefinitionSha256: input.workflowDefinitionSha256?.trim() ?? null,
    verifierConfigSha256: input.verifierConfigSha256?.trim() ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function boundedInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) {
    throw new Error(`${field} must be an integer between 0 and 1000000`);
  }
  return value as number;
}

function boundedString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max) {
    throw new Error(`${field} must be a string of at most ${max} characters`);
  }
  return value;
}

/** Parse and validate a routing record from untrusted input. Metadata only:
 * fail closed on unbounded fields, invalid identifiers, or negative costs. */
export function parseRoutingRecord(value: { schema: typeof ROUTING_RECORD_V2_SCHEMA } & Record<string, unknown>): RoutingRecordV2;
export function parseRoutingRecord(value: { schema: typeof ROUTING_RECORD_SCHEMA } & Record<string, unknown>): RoutingRecord;
export function parseRoutingRecord(value: unknown): RoutingRecord | RoutingRecordV2;
export function parseRoutingRecord(value: unknown): RoutingRecord | RoutingRecordV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("routing record must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.schema === ROUTING_RECORD_V2_SCHEMA) {
    return parseRoutingRecordV2(value);
  }
  if (input.schema !== ROUTING_RECORD_SCHEMA) {
    throw new Error(`routing record schema must be ${ROUTING_RECORD_SCHEMA} or ${ROUTING_RECORD_V2_SCHEMA}`);
  }
  const skills = input.skills === undefined || input.skills === null
    ? []
    : (() => {
      if (!Array.isArray(input.skills) || input.skills.length > MAX_SKILL_REFS) {
        throw new Error(`routing skills must be an array of at most ${MAX_SKILL_REFS} refs`);
      }
      return input.skills.map((skill) => {
        const ref = skill as Partial<SkillVersionRef>;
        if (typeof ref?.id !== "string" || !ref.id.trim() || ref.id.length > 200
          || typeof ref?.contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(ref.contentSha256)) {
          throw new Error("routing skill refs must carry an id and a sha256 content hash");
        }
        return { id: ref.id.trim(), contentSha256: ref.contentSha256 };
      });
    })();
  const contextItemIds = input.contextItemIds === undefined || input.contextItemIds === null
    ? []
    : (() => {
      if (!Array.isArray(input.contextItemIds) || input.contextItemIds.length > MAX_CONTEXT_ITEM_IDS) {
        throw new Error(`routing contextItemIds must be an array of at most ${MAX_CONTEXT_ITEM_IDS} ids`);
      }
      return input.contextItemIds.map((id) => {
        if (typeof id !== "string" || !id.trim() || id.length > 200) {
          throw new Error("routing contextItemIds must be bounded non-empty strings");
        }
        return id.trim();
      });
    })();
  const providerMetadata = input.providerMetadata === undefined || input.providerMetadata === null
    ? undefined
    : (() => {
      if (!input.providerMetadata || typeof input.providerMetadata !== "object" || Array.isArray(input.providerMetadata)) {
        throw new Error("routing providerMetadata must be an object");
      }
      const entries = Object.entries(input.providerMetadata as Record<string, unknown>);
      if (entries.length > MAX_PROVIDER_METADATA_FIELDS) {
        throw new Error(`routing providerMetadata may carry at most ${MAX_PROVIDER_METADATA_FIELDS} fields`);
      }
      const normalized: Record<string, string | number | boolean> = {};
      for (const [key, field] of entries) {
        if (typeof key !== "string" || key.length > 64 || /prompt|body|content|message/i.test(key)
          || (typeof field !== "string" && typeof field !== "number" && typeof field !== "boolean")) {
          throw new Error("routing providerMetadata values must be bounded strings, numbers, or booleans; raw bodies are rejected");
        }
        normalized[key] = typeof field === "string" ? field.slice(0, 200) : field;
      }
      return normalized;
    })();
  const verifierOutcome = input.verifierOutcome === undefined || input.verifierOutcome === null
    ? undefined
    : (() => {
      if (input.verifierOutcome !== "passed" && input.verifierOutcome !== "warning" && input.verifierOutcome !== "failed") {
        throw new Error("routing verifierOutcome must be passed, warning, or failed");
      }
      return input.verifierOutcome;
    })();
  const finalOutcome = input.finalOutcome === undefined || input.finalOutcome === null
    ? undefined
    : (() => {
      if (input.finalOutcome !== "accepted" && input.finalOutcome !== "blocked" && input.finalOutcome !== "failed" && input.finalOutcome !== "pending") {
        throw new Error("routing finalOutcome must be accepted, blocked, failed, or pending");
      }
      return input.finalOutcome;
    })();
  const costUsd = input.costUsd === undefined || input.costUsd === null
    ? undefined
    : (() => {
      if (typeof input.costUsd !== "number" || !Number.isFinite(input.costUsd) || input.costUsd < 0 || input.costUsd > 1_000_000) {
        throw new Error("routing costUsd must be a non-negative finite number");
      }
      return input.costUsd;
    })();

  const behavioralSha256 = boundedString(input.behavioralSha256, "behavioralSha256", 64) ?? "";
  if (!/^[a-f0-9]{64}$/.test(behavioralSha256)) {
    throw new Error("routing behavioralSha256 must be a sha256 hex digest");
  }
  const record: RoutingRecord = {
    schema: ROUTING_RECORD_SCHEMA,
    behavioralHashVersion: BEHAVIORAL_HASH_VERSION,
    behavioralSha256,
    skills,
    contextItemIds,
    retries: boundedInt(input.retries, "retries") ?? 0,
    transitions: boundedInt(input.transitions, "transitions") ?? 0,
    humanInterventions: boundedInt(input.humanInterventions, "humanInterventions") ?? 0,
  };
  const strings: Array<[keyof RoutingRecord, string | undefined]> = [
    ["workflowRunId", boundedString(input.workflowRunId, "workflowRunId", 128)],
    ["stageId", boundedString(input.stageId, "stageId", 128)],
    ["requestedModel", normalizeModel(boundedString(input.requestedModel, "requestedModel", 200))],
    ["effectiveModel", normalizeModel(boundedString(input.effectiveModel, "effectiveModel", 200))],
    ["reasoningEffort", boundedString(input.reasoningEffort, "reasoningEffort", 64)],
    ["agentRole", boundedString(input.agentRole, "agentRole", 64)],
    ["rolePromptSha256", boundedString(input.rolePromptSha256, "rolePromptSha256", 64)],
    ["contextPolicyVersion", boundedString(input.contextPolicyVersion, "contextPolicyVersion", 64)],
    ["toolPolicyVersion", boundedString(input.toolPolicyVersion, "toolPolicyVersion", 64)],
    ["workflowDefinitionSha256", boundedString(input.workflowDefinitionSha256, "workflowDefinitionSha256", 64)],
    ["verifierConfigSha256", boundedString(input.verifierConfigSha256, "verifierConfigSha256", 64)],
  ];
  for (const [key, value] of strings) {
    if (value !== undefined) (record as unknown as Record<string, unknown>)[key] = value;
  }
  for (const [key, value] of [["attempt", boundedInt(input.attempt, "attempt")], ["tokensIn", boundedInt(input.tokensIn, "tokensIn")], ["tokensOut", boundedInt(input.tokensOut, "tokensOut")], ["cacheReadTokens", boundedInt(input.cacheReadTokens, "cacheReadTokens")]] as const) {
    if (value !== undefined) (record as unknown as Record<string, unknown>)[key] = value;
  }
  if (costUsd !== undefined) record.costUsd = costUsd;
  if (verifierOutcome !== undefined) record.verifierOutcome = verifierOutcome;
  if (finalOutcome !== undefined) record.finalOutcome = finalOutcome;
  if (providerMetadata !== undefined) record.providerMetadata = providerMetadata;
  return record;
}

export function parseRoutingRecordV2(value: unknown): RoutingRecordV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("routing record v2 must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.schema !== ROUTING_RECORD_V2_SCHEMA) {
    throw new Error(`routing record v2 schema must be ${ROUTING_RECORD_V2_SCHEMA}`);
  }
  const costBasis = input.costBasis;
  if (costBasis !== "metered" && costBasis !== "unmetered" && costBasis !== "unknown") {
    throw new Error("routing record v2 costBasis must be metered, unmetered, or unknown");
  }
  let costUsd: number | null | undefined = undefined;
  if (costBasis === "metered") {
    if (typeof input.costUsd !== "number" || !Number.isFinite(input.costUsd) || input.costUsd < 0 || input.costUsd > 1_000_000) {
      throw new Error("routing record v2 costUsd must be a non-negative finite number when costBasis is metered");
    }
    costUsd = input.costUsd;
  } else if (input.costUsd !== undefined && input.costUsd !== null) {
    if (typeof input.costUsd !== "number" || !Number.isFinite(input.costUsd) || input.costUsd < 0) {
      throw new Error("routing record v2 costUsd must be a non-negative finite number when present");
    }
    costUsd = input.costUsd;
  } else {
    costUsd = null;
  }

  const rawHash = boundedString(input.behavioralSha256, "behavioralSha256", 72) ?? "";
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(rawHash)) {
    throw new Error("routing record v2 behavioralSha256 must be a sha256 hex digest");
  }
  const behavioralSha256 = rawHash.startsWith("sha256:") ? rawHash : `sha256:${rawHash}`;

  const latencyMs = input.latencyMs;
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || latencyMs < 0) {
    throw new Error("routing record v2 latencyMs must be a non-negative number");
  }

  const providerMetadata = input.providerMetadata === undefined || input.providerMetadata === null
    ? undefined
    : (() => {
      if (!input.providerMetadata || typeof input.providerMetadata !== "object" || Array.isArray(input.providerMetadata)) {
        throw new Error("routing providerMetadata must be an object");
      }
      const entries = Object.entries(input.providerMetadata as Record<string, unknown>);
      if (entries.length > MAX_PROVIDER_METADATA_FIELDS) {
        throw new Error(`routing providerMetadata may carry at most ${MAX_PROVIDER_METADATA_FIELDS} fields`);
      }
      const normalized: Record<string, string | number | boolean> = {};
      for (const [key, field] of entries) {
        if (typeof key !== "string" || key.length > 64 || /prompt|body|content|message/i.test(key)
          || (typeof field !== "string" && typeof field !== "number" && typeof field !== "boolean")) {
          throw new Error("routing providerMetadata values must be bounded strings, numbers, or booleans; raw bodies are rejected");
        }
        normalized[key] = typeof field === "string" ? field.slice(0, 200) : field;
      }
      return normalized;
    })();

  const record: RoutingRecordV2 = {
    schema: ROUTING_RECORD_V2_SCHEMA,
    recordedAt: boundedString(input.recordedAt, "recordedAt", 64) ?? new Date().toISOString(),
    project: boundedString(input.project, "project", 128) ?? "",
    runId: boundedString(input.runId, "runId", 128) ?? "",
    stepId: boundedString(input.stepId, "stepId", 128) ?? "",
    assignmentId: boundedString(input.assignmentId, "assignmentId", 128) ?? "",
    attemptId: boundedString(input.attemptId, "attemptId", 128) ?? "",
    harness: boundedString(input.harness, "harness", 64) ?? "",
    provider: boundedString(input.provider, "provider", 64) ?? "",
    requestedModel: normalizeModel(boundedString(input.requestedModel, "requestedModel", 200)) ?? "",
    effectiveModel: normalizeModel(boundedString(input.effectiveModel, "effectiveModel", 200)) ?? "",
    behavioralSha256,
    latencyMs,
    costBasis,
    costUsd,
    retries: boundedInt(input.retries, "retries") ?? 0,
  };

  if (input.thinking !== undefined && input.thinking !== null) {
    record.thinking = boundedString(input.thinking, "thinking", 64);
  }
  const rawRole = input.agentRole ?? (input as Record<string, unknown>).role;
  if (rawRole !== undefined && rawRole !== null) {
    record.agentRole = boundedString(rawRole, "agentRole", 64);
  }
  if (input.contextTokens !== undefined) {
    record.contextTokens = boundedInt(input.contextTokens, "contextTokens") ?? null;
  }
  if (input.tokensIn !== undefined) {
    record.tokensIn = boundedInt(input.tokensIn, "tokensIn") ?? null;
  }
  if (input.tokensOut !== undefined) {
    record.tokensOut = boundedInt(input.tokensOut, "tokensOut") ?? null;
  }
  if (input.cacheReadTokens !== undefined) {
    record.cacheReadTokens = boundedInt(input.cacheReadTokens, "cacheReadTokens") ?? null;
  }
  if (input.cacheWriteTokens !== undefined) {
    record.cacheWriteTokens = boundedInt(input.cacheWriteTokens, "cacheWriteTokens") ?? null;
  }
  if (input.priceRef !== undefined && input.priceRef !== null) {
    record.priceRef = boundedString(input.priceRef, "priceRef", 128);
  }
  if (input.verifierOutcome !== undefined && input.verifierOutcome !== null) {
    if (input.verifierOutcome !== "passed" && input.verifierOutcome !== "warning" && input.verifierOutcome !== "failed") {
      throw new Error("routing verifierOutcome must be passed, warning, or failed");
    }
    record.verifierOutcome = input.verifierOutcome;
  }
  if (input.finalOutcome !== undefined && input.finalOutcome !== null) {
    record.finalOutcome = typeof input.finalOutcome === "string" ? input.finalOutcome.slice(0, 64) : undefined;
  }
  if (input.transitions !== undefined) {
    record.transitions = boundedInt(input.transitions, "transitions");
  }
  if (input.humanInterventions !== undefined) {
    record.humanInterventions = boundedInt(input.humanInterventions, "humanInterventions");
  }
  if (providerMetadata !== undefined) {
    record.providerMetadata = providerMetadata;
  }

  return record;
}

export interface RoutingComparison {
  behavioralSha256: string;
  runs: number;
  verifiedCompletions: number;
  blocked: number;
  failed: number;
  reworkRate: number;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalHumanInterventions: number;
}

/** Aggregate comparable outcome metrics for one behavioral configuration.
 * Purely metadata-driven: no raw prompt or reply bodies are read. */
export function compareRoutingRecords(records: RoutingRecord[]): RoutingComparison {
  if (records.length === 0) {
    throw new Error("compareRoutingRecords requires at least one record");
  }
  const behavioralSha256 = records[0]!.behavioralSha256;
  for (const record of records) {
    if (record.behavioralSha256 !== behavioralSha256) {
      throw new Error("compareRoutingRecords requires records with identical behavioral hashes");
    }
  }
  const settled = records.filter((record) => record.finalOutcome !== undefined && record.finalOutcome !== "pending");
  const accepted = settled.filter((record) => record.finalOutcome === "accepted").length;
  const blocked = settled.filter((record) => record.finalOutcome === "blocked").length;
  const failed = settled.filter((record) => record.finalOutcome === "failed").length;
  const reworked = records.filter((record) => record.retries > 0 || record.transitions > 0).length;
  return {
    behavioralSha256,
    runs: records.length,
    verifiedCompletions: accepted,
    blocked,
    failed,
    reworkRate: records.length === 0 ? 0 : Math.round((reworked / records.length) * 100) / 100,
    totalCostUsd: Math.round(records.reduce((sum, record) => sum + (record.costUsd ?? 0), 0) * 10_000) / 10_000,
    totalTokensIn: records.reduce((sum, record) => sum + (record.tokensIn ?? 0), 0),
    totalTokensOut: records.reduce((sum, record) => sum + (record.tokensOut ?? 0), 0),
    totalHumanInterventions: records.reduce((sum, record) => sum + record.humanInterventions, 0),
  };
}

/** Group routing records by behavioral configuration for champion/challenger
 * comparisons. */
export function groupByBehavior(records: RoutingRecord[]): Map<string, RoutingRecord[]> {
  const groups = new Map<string, RoutingRecord[]>();
  for (const record of records) {
    const bucket = groups.get(record.behavioralSha256) ?? [];
    bucket.push(record);
    groups.set(record.behavioralSha256, bucket);
  }
  return groups;
}

export const ROUTING_REPORT_SCHEMA = "kxm.routing-report.v1" as const;

export function isQuotaExhausted(record: RoutingRecord | RoutingRecordV2): boolean {
  if ("providerMetadata" in record && record.providerMetadata) {
    const meta = record.providerMetadata;
    if (meta.failureClass === "quota" || meta.errorCode === "provider_quota" || meta.stopReason === "quota_exhausted" || meta.quotaExhausted === true || meta.quota_exhausted === true) {
      return true;
    }
    for (const [key, val] of Object.entries(meta)) {
      if (/quota/i.test(key) && val === true) return true;
      if (typeof val === "string" && /\b(quota reached|quota exceeded|rate limit(?:ed)?|too many requests|resource exhausted|http 429|quota_exhausted)\b/i.test(val)) {
        return true;
      }
    }
  }
  if (record.finalOutcome === "quota" || record.finalOutcome === "quota_exhausted") return true;
  return false;
}

function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = p * (sorted.length - 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return Math.round(sorted[base]! + rest * (sorted[base + 1]! - sorted[base]!));
  }
  return sorted[base]!;
}

export interface RoutingReportRow {
  harness: string;
  model: string;
  thinking: string;
  role: string;
  attempts: number;
  verifyPassRate: number;
  reworkRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  medianContextTokens: number | null;
  meteredCostUsd: number;
  costPerAcceptedUsd: number | null;
  unmeteredAttempts: number;
  unknownCostAttempts: number;
  quotaExhaustedAttempts: number;
  flagged: boolean;
  equivalentListCostUsd?: number | null | undefined;
}

export interface RoutingReport {
  schema: typeof ROUTING_REPORT_SCHEMA;
  generatedAt: string;
  totalAttempts: number;
  rows: RoutingReportRow[];
}

export interface GenerateRoutingReportOptions {
  catalog?: PriceCatalog | undefined;
  includeEquivalentListCost?: boolean | undefined;
  halfLifeDays?: number | undefined;
  now?: () => string;
}

/**
 * Calculates exponential decay weight for historical telemetry (Decision Q14).
 * Weight w = 2^(-delta_t / halfLifeDays).
 */
export function computeDecayedWeight(
  recordedAt: string | number,
  halfLifeDays: number = 14,
  now: number = Date.now(),
): number {
  const ts = typeof recordedAt === "number" ? recordedAt : Date.parse(recordedAt);
  if (!Number.isFinite(ts)) return 1.0;
  const deltaMs = Math.max(0, now - ts);
  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
  return Math.pow(2, -deltaMs / halfLifeMs);
}

export interface RouteCircuitStatus {
  status: "healthy" | "demoted" | "quarantined";
  consecutiveFailures: number;
  penaltyMultiplier: number;
  reason?: string | undefined;
}

/**
 * Evaluates route health against the circuit breaker policy (Decision Q13).
 * Detects failure streaks in the observation window and applies soft demotion or quarantine.
 */
export function evaluateCircuitBreaker(
  records: Array<RoutingRecord | RoutingRecordV2>,
  route: { harness: string; model: string },
  config?: {
    mode?: "soft_demotion" | "quarantine" | undefined;
    failureThreshold?: number | undefined;
    windowSeconds?: number | undefined;
    penaltyMultiplier?: number | undefined;
  },
  now: number = Date.now(),
): RouteCircuitStatus {
  const mode = config?.mode ?? "soft_demotion";
  const failureThreshold = config?.failureThreshold ?? 3;
  const windowSeconds = config?.windowSeconds ?? 3600;
  const penaltyMultiplier = config?.penaltyMultiplier ?? 5.0;
  const windowMs = windowSeconds * 1000;

  const matching = records.filter((r) => {
    const isV2 = r.schema === ROUTING_RECORD_V2_SCHEMA;
    const harness = isV2 ? (r as RoutingRecordV2).harness : (r.providerMetadata?.harness as string | undefined);
    const model = isV2
      ? ((r as RoutingRecordV2).effectiveModel || (r as RoutingRecordV2).requestedModel)
      : (r.effectiveModel || r.requestedModel);
    if (harness !== route.harness || model !== route.model) return false;

    const recAt = (r as any).recordedAt;
    const ts = typeof recAt === "string" ? Date.parse(recAt) : 0;
    return ts >= (now - windowMs);
  });

  matching.sort((a, b) => {
    const ta = typeof (a as any).recordedAt === "string" ? Date.parse((a as any).recordedAt) : 0;
    const tb = typeof (b as any).recordedAt === "string" ? Date.parse((b as any).recordedAt) : 0;
    return tb - ta;
  });

  let consecutiveFailures = 0;
  for (const r of matching) {
    const passed = r.verifierOutcome === "passed" || r.finalOutcome === "accepted" || r.finalOutcome === "completed";
    if (passed && (r.retries ?? 0) === 0) {
      break;
    }
    consecutiveFailures++;
  }

  if (consecutiveFailures >= failureThreshold) {
    if (mode === "quarantine") {
      return {
        status: "quarantined",
        consecutiveFailures,
        penaltyMultiplier,
        reason: `Route quarantined after ${consecutiveFailures} consecutive failures within ${windowSeconds}s`,
      };
    }
    return {
      status: "demoted",
      consecutiveFailures,
      penaltyMultiplier,
      reason: `Route demoted with ${penaltyMultiplier}x penalty after ${consecutiveFailures} consecutive failures`,
    };
  }

  return {
    status: "healthy",
    consecutiveFailures,
    penaltyMultiplier: 1.0,
  };
}

export function generateRoutingReport(
  records: Array<RoutingRecord | RoutingRecordV2>,
  options: GenerateRoutingReportOptions = {},
): RoutingReport {
  const generatedAt = options.now ? options.now() : new Date().toISOString();
  if (records.length === 0) {
    return {
      schema: ROUTING_REPORT_SCHEMA,
      generatedAt,
      totalAttempts: 0,
      rows: [],
    };
  }

  // Group by (harness, model, thinking, role)
  const groups = new Map<string, Array<RoutingRecord | RoutingRecordV2>>();
  for (const record of records) {
    const isV2 = record.schema === ROUTING_RECORD_V2_SCHEMA;
    const harness = (isV2 ? (record as RoutingRecordV2).harness : (record.providerMetadata?.harness as string | undefined)) || "unknown";
    const model = (isV2 ? ((record as RoutingRecordV2).effectiveModel || (record as RoutingRecordV2).requestedModel) : (record.effectiveModel || record.requestedModel)) || "unknown";
    const thinking = (isV2 ? (record as RoutingRecordV2).thinking : record.reasoningEffort) || "none";
    const role = (record as any).role || record.agentRole || "unknown";

    const key = `${harness}\0${model}\0${thinking}\0${role}`;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(record);
  }

  const rows: RoutingReportRow[] = [];

  for (const [key, groupRecords] of groups.entries()) {
    const [harness, model, thinking, role] = key.split("\0") as [string, string, string, string];
    const attempts = groupRecords.length;

    let verifyPassedCount = 0;
    let reworkCount = 0;
    let acceptedCount = 0;
    let meteredCostTotal = 0;
    let unmeteredAttempts = 0;
    let unknownCostAttempts = 0;
    let quotaExhaustedAttempts = 0;

    const latencies: number[] = [];
    const contextVals: number[] = [];

    for (const r of groupRecords) {
      const isV2 = r.schema === ROUTING_RECORD_V2_SCHEMA;
      const v2 = isV2 ? (r as RoutingRecordV2) : undefined;

      // Verification pass
      if (r.verifierOutcome === "passed" || (!r.verifierOutcome && r.finalOutcome === "accepted")) {
        verifyPassedCount++;
      }

      // Rework: back-edge re-entries only
      if ((r.transitions ?? 0) > 0) {
        reworkCount++;
      }

      // Accepted attempts
      if (r.finalOutcome === "accepted" || r.verifierOutcome === "passed") {
        acceptedCount++;
      }

      // Cost basis
      const costBasis = v2 ? v2.costBasis : (typeof r.costUsd === "number" ? "metered" : "unknown");
      if (costBasis === "metered") {
        if (typeof r.costUsd === "number" && Number.isFinite(r.costUsd)) {
          meteredCostTotal += r.costUsd;
        }
      } else if (costBasis === "unmetered") {
        unmeteredAttempts++;
      } else {
        unknownCostAttempts++;
      }

      // Quota exhausted
      if (isQuotaExhausted(r)) {
        quotaExhaustedAttempts++;
      }

      // Latencies
      const lat = v2 ? v2.latencyMs : (typeof r.providerMetadata?.latencyMs === "number" ? (r.providerMetadata.latencyMs as number) : undefined);
      if (typeof lat === "number" && Number.isFinite(lat) && lat >= 0) {
        latencies.push(lat);
      }

      // Context tokens
      const ctx = v2 ? (v2.contextTokens ?? v2.tokensIn) : (r.tokensIn);
      if (typeof ctx === "number" && Number.isFinite(ctx) && ctx >= 0) {
        contextVals.push(ctx);
      }
    }

    const verifyPassRate = attempts > 0 ? Math.round((verifyPassedCount / attempts) * 1000) / 1000 : 0;
    const reworkRate = attempts > 0 ? Math.round((reworkCount / attempts) * 1000) / 1000 : 0;

    latencies.sort((a, b) => a - b);
    const latencyP50Ms = computePercentile(latencies, 0.50);
    const latencyP95Ms = computePercentile(latencies, 0.95);

    contextVals.sort((a, b) => a - b);
    let medianContextTokens: number | null = null;
    if (contextVals.length > 0) {
      const mid = Math.floor(contextVals.length / 2);
      medianContextTokens = contextVals.length % 2 !== 0
        ? contextVals[mid]!
        : Math.round((contextVals[mid - 1]! + contextVals[mid]!) / 2);
    }

    const meteredCostUsd = Math.round(meteredCostTotal * 10_000) / 10_000;
    const costPerAcceptedUsd = acceptedCount > 0
      ? (meteredCostUsd > 0 || unmeteredAttempts > 0
          ? Math.round((meteredCostUsd / acceptedCount) * 10_000) / 10_000
          : (unknownCostAttempts === attempts ? null : 0))
      : null;

    const flagged = unknownCostAttempts > 0;

    let equivalentListCostUsd: number | null | undefined = undefined;
    if (options.includeEquivalentListCost && options.catalog) {
      let equivTotal = 0;
      let calculatedAll = true;
      for (const r of groupRecords) {
        const isV2 = r.schema === ROUTING_RECORD_V2_SCHEMA;
        const v2 = isV2 ? (r as RoutingRecordV2) : undefined;
        const costBasis = v2 ? v2.costBasis : (typeof r.costUsd === "number" ? "metered" : "unknown");
        if (costBasis === "metered" && typeof r.costUsd === "number") {
          equivTotal += r.costUsd;
        } else {
          const calc = calculateModelCost(options.catalog, {
            model,
            ...(v2?.provider ? { provider: v2.provider } : {}),
            tokensIn: r.tokensIn ?? null,
            tokensOut: r.tokensOut ?? null,
            cacheReadTokens: r.cacheReadTokens ?? null,
            cacheWriteTokens: v2?.cacheWriteTokens ?? null,
            contextTokens: v2?.contextTokens ?? null,
          });
          if (calc) {
            equivTotal += calc.costUsd;
          } else {
            calculatedAll = false;
          }
        }
      }
      equivalentListCostUsd = calculatedAll ? Math.round(equivTotal * 10_000) / 10_000 : null;
    }

    rows.push({
      harness,
      model,
      thinking,
      role,
      attempts,
      verifyPassRate,
      reworkRate,
      latencyP50Ms,
      latencyP95Ms,
      medianContextTokens,
      meteredCostUsd,
      costPerAcceptedUsd,
      unmeteredAttempts,
      unknownCostAttempts,
      quotaExhaustedAttempts,
      flagged,
      ...(options.includeEquivalentListCost ? { equivalentListCostUsd } : {}),
    });
  }

  // Sort quality then cost; unknown is never ranked cheapest
  rows.sort((a, b) => {
    // 1. Quality: higher verifyPassRate is better
    if (a.verifyPassRate !== b.verifyPassRate) {
      return b.verifyPassRate - a.verifyPassRate;
    }
    // Lower reworkRate is better
    if (a.reworkRate !== b.reworkRate) {
      return a.reworkRate - b.reworkRate;
    }

    // 2. Cost: unknown is never ranked cheapest. Any unknown-cost attempt makes the
    // route's cost a lower bound (unmetered or metered attempts beside it do not price it).
    const aCostUnknown = a.unknownCostAttempts > 0;
    const bCostUnknown = b.unknownCostAttempts > 0;
    if (aCostUnknown && !bCostUnknown) return 1;
    if (!aCostUnknown && bCostUnknown) return -1;

    if (a.costPerAcceptedUsd !== null && b.costPerAcceptedUsd !== null) {
      if (a.costPerAcceptedUsd !== b.costPerAcceptedUsd) {
        return a.costPerAcceptedUsd - b.costPerAcceptedUsd;
      }
    } else if (a.costPerAcceptedUsd !== null) {
      return -1;
    } else if (b.costPerAcceptedUsd !== null) {
      return 1;
    }

    if (a.meteredCostUsd !== b.meteredCostUsd) {
      return a.meteredCostUsd - b.meteredCostUsd;
    }

    // 3. Tiebreakers
    if (a.attempts !== b.attempts) {
      return b.attempts - a.attempts;
    }
    const cmpH = a.harness.localeCompare(b.harness);
    if (cmpH !== 0) return cmpH;
    const cmpM = a.model.localeCompare(b.model);
    if (cmpM !== 0) return cmpM;
    return a.role.localeCompare(b.role);
  });

  return {
    schema: ROUTING_REPORT_SCHEMA,
    generatedAt,
    totalAttempts: records.length,
    rows,
  };
}

export function formatRoutingReport(
  report: RoutingReport,
  options: { equivalentListCost?: boolean } = {},
): string {
  if (report.rows.length === 0) {
    return "no routing records to report";
  }

  const showListCost = Boolean(options.equivalentListCost);
  const headers = [
    "Harness".padEnd(10),
    "Model".padEnd(24),
    "Effort".padEnd(8),
    "Role".padEnd(14),
    "Att".padStart(4),
    "Pass%".padStart(7),
    "Rwk%".padStart(6),
    "p50(ms)".padStart(8),
    "p95(ms)".padStart(8),
    "CtxTok".padStart(8),
    "Metered($)".padStart(11),
    "$/Acc".padStart(9),
    "Unm".padStart(4),
    "Unk".padStart(5),
    "Quota".padStart(6),
    ...(showListCost ? ["ListEquiv($)".padStart(13)] : []),
  ].join(" ");

  const lines: string[] = [
    `Routing Telemetry Report (${report.totalAttempts} attempt(s) across ${report.rows.length} route(s), quality-first ranking)`,
    headers,
  ];

  for (const row of report.rows) {
    const passPct = `${(row.verifyPassRate * 100).toFixed(1)}%`;
    const rwkPct = `${(row.reworkRate * 100).toFixed(1)}%`;
    const p50 = `${row.latencyP50Ms}`;
    const p95 = `${row.latencyP95Ms}`;
    const ctx = row.medianContextTokens !== null ? `${row.medianContextTokens}` : "-";
    const metered = `$${row.meteredCostUsd.toFixed(4)}`;
    const perAcc = row.costPerAcceptedUsd !== null ? `$${row.costPerAcceptedUsd.toFixed(4)}` : "-";
    const unkText = `${row.unknownCostAttempts}${row.flagged ? "*" : ""}`;

    const cells = [
      row.harness.padEnd(10),
      (row.model.length > 24 ? `${row.model.slice(0, 21)}...` : row.model).padEnd(24),
      row.thinking.padEnd(8),
      (row.role.length > 14 ? `${row.role.slice(0, 11)}...` : row.role).padEnd(14),
      String(row.attempts).padStart(4),
      passPct.padStart(7),
      rwkPct.padStart(6),
      p50.padStart(8),
      p95.padStart(8),
      ctx.padStart(8),
      metered.padStart(11),
      perAcc.padStart(9),
      String(row.unmeteredAttempts).padStart(4),
      unkText.padStart(5),
      String(row.quotaExhaustedAttempts).padStart(6),
      ...(showListCost ? [(row.equivalentListCostUsd !== undefined && row.equivalentListCostUsd !== null ? `$${row.equivalentListCostUsd.toFixed(4)}` : "-").padStart(13)] : []),
    ];
    lines.push(cells.join(" "));
  }

  if (report.rows.some((r) => r.flagged)) {
    lines.push("* = unknown-cost attempts present (never ranked cheapest)");
  }

  return lines.join("\n");
}

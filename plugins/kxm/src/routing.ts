import { createHash } from "node:crypto";

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
  if (input.agentRole !== undefined && input.agentRole !== null) {
    record.agentRole = boundedString(input.agentRole, "agentRole", 64);
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

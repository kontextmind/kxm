// plugins/kxm/src/protocol.ts
import { randomUUID } from "node:crypto";
var DEFAULT_PORT = 7331;
var DEFAULT_STALE_AFTER_MS = 3e4;
var DEFAULT_MAX_HOPS = 5;
var DEFAULT_MESSAGE_TTL_MS = 24 * 60 * 6e4;
var MIN_MESSAGE_TTL_MS = 1e3;
var MAX_MESSAGE_TTL_MS = 7 * 24 * 60 * 6e4;
var DEFAULT_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 6e4;
var MIN_MESSAGE_RETENTION_MS = 1e3;
var DEFAULT_RATE_LIMIT_MAX = 600;
var DEFAULT_RATE_LIMIT_WINDOW_MS = 6e4;
var MAX_BODY_BYTES = 256 * 1024;
var MAX_CONTENT_CHARS = 32e3;
var MAX_AGENT_HOST_CHARS = 64;
var MIN_LEASE_TTL_MS = 5e3;
var MAX_LEASE_TTL_MS = 10 * 6e4;
var DEFAULT_LEASE_TTL_MS = 5 * 6e4;
var MAX_LEASE_RESOURCE_CHARS = 200;
function agentPresenceView(agent, staleAfterMs = DEFAULT_STALE_AFTER_MS, now = Date.now()) {
  const lastSeenMs = Date.parse(agent.lastSeenAt);
  const leaseExpiresAtMs = (Number.isFinite(lastSeenMs) ? lastSeenMs : 0) + staleAfterMs;
  const leaseExpiresAt = new Date(leaseExpiresAtMs).toISOString();
  if (!agent.online) return { leaseExpiresAt, presence: "offline" };
  return { leaseExpiresAt, presence: now < leaseExpiresAtMs ? "online" : "stale" };
}
function toAgentRecord(agent, staleAfterMs, now) {
  return { ...agent, ...agentPresenceView(agent, staleAfterMs, now) };
}
var MAX_SYNC_BATCH_EVENTS = 100;
var ProtocolError = class extends Error {
  statusCode;
  code;
  extras;
  constructor(statusCode, message, code = "protocol_error", extras) {
    super(message);
    this.name = "ProtocolError";
    this.statusCode = statusCode;
    this.code = code;
    if (extras) this.extras = extras;
  }
};
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
function requireString(value, field, options = {}) {
  if (typeof value !== "string") {
    throw new ProtocolError(400, `${field} must be a string`);
  }
  const result = value.trim();
  if (!options.allowEmpty && result.length === 0) {
    throw new ProtocolError(400, `${field} cannot be empty`);
  }
  if (options.max !== void 0 && result.length > options.max) {
    throw new ProtocolError(400, `${field} exceeds ${options.max} characters`);
  }
  return result;
}
function optionalString(value, field, max) {
  if (value === void 0 || value === null || value === "") return void 0;
  return requireString(value, field, { max });
}
function parseDeliveryMode(value) {
  if (value === void 0) return "followUp";
  if (value === "steer" || value === "followUp" || value === "nextTurn") return value;
  throw new ProtocolError(400, "delivery must be steer, followUp, or nextTurn");
}
function parseBoundedInteger(value, field, fallback, min, max) {
  if (value === void 0) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ProtocolError(400, `${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}
var TERMINAL_RECEIPT_SCHEMA = "kxm.terminal-receipt.v1";
var VALID_TERMINAL_STATUSES = /* @__PURE__ */ new Set(["accepted", "audit_escalation", "rejected", "error"]);
function validateTerminalReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "terminal receipt must be an object", "invalid_terminal_receipt");
  }
  const record = value;
  if (record.schema !== void 0 && record.schema !== TERMINAL_RECEIPT_SCHEMA) {
    throw new ProtocolError(400, `terminal receipt schema must be ${TERMINAL_RECEIPT_SCHEMA}`, "invalid_terminal_receipt");
  }
  const status = record.status;
  if (!status || !VALID_TERMINAL_STATUSES.has(status)) {
    throw new ProtocolError(
      400,
      `terminal receipt status must be one of: ${Array.from(VALID_TERMINAL_STATUSES).join(", ")}`,
      "invalid_terminal_receipt"
    );
  }
  const seat = requireString(record.seat, "seat", { max: 64 });
  const runId = requireString(record.runId, "runId", { max: 128 });
  const stageId = requireString(record.stageId, "stageId", { max: 128 });
  const timestamp = requireString(record.timestamp, "timestamp", { max: 64 });
  const host = requireString(record.host, "host", { max: 64 });
  const model = requireString(record.model, "model", { max: 128 });
  let evidence;
  if (record.evidence !== void 0) {
    if (!record.evidence || typeof record.evidence !== "object" || Array.isArray(record.evidence)) {
      throw new ProtocolError(400, "terminal receipt evidence must be an object", "invalid_terminal_receipt");
    }
    evidence = record.evidence;
  }
  let metrics;
  if (record.metrics !== void 0) {
    if (!record.metrics || typeof record.metrics !== "object" || Array.isArray(record.metrics)) {
      throw new ProtocolError(400, "terminal receipt metrics must be an object", "invalid_terminal_receipt");
    }
    metrics = record.metrics;
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
    ...evidence ? { evidence } : {},
    ...metrics ? { metrics } : {},
    ...escalationReason ? { escalationReason } : {},
    ...ruling ? { ruling } : {}
  };
}

// plugins/kxm/src/routing.ts
import { createHash } from "node:crypto";

// plugins/kxm/src/price-calc.ts
function findModelPrice(catalog, model, provider) {
  const normalizedModel = model.trim().toLowerCase();
  const normalizedProvider = provider?.trim().toLowerCase();
  for (const entry of catalog.models) {
    if (normalizedProvider && entry.provider.toLowerCase() !== normalizedProvider) continue;
    if (entry.id.toLowerCase() === normalizedModel || entry.model.toLowerCase() === normalizedModel) {
      return entry;
    }
    if (entry.aliases?.some((a) => a.toLowerCase() === normalizedModel)) {
      return entry;
    }
  }
  return void 0;
}
function calculateModelCost(catalog, params) {
  const row = findModelPrice(catalog, params.model, params.provider);
  if (!row || row.tiers.length === 0) return void 0;
  if (catalog.currency !== void 0 && catalog.currency !== "USD") return void 0;
  const validCount = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const tokensIn = params.tokensIn;
  const tokensOut = params.tokensOut;
  const cacheRead = params.cacheReadTokens;
  const cacheWrite = params.cacheWriteTokens;
  if (!validCount(tokensIn) || !validCount(tokensOut) || !validCount(cacheRead) || !validCount(cacheWrite)) return void 0;
  const context = params.contextTokens;
  if (context != null && !validCount(context)) return void 0;
  const selectedTier = context == null ? row.tiers.length === 1 && row.tiers[0].upToContextTokens == null ? row.tiers[0] : void 0 : row.tiers.find((tier) => tier.upToContextTokens == null || context <= tier.upToContextTokens);
  if (!selectedTier || cacheRead > 0 && selectedTier.cacheReadPerMillion == null || cacheWrite > 0 && selectedTier.cacheWritePerMillion == null) return void 0;
  const cost = tokensIn / 1e6 * selectedTier.inputPerMillion + tokensOut / 1e6 * selectedTier.outputPerMillion + cacheRead / 1e6 * (selectedTier.cacheReadPerMillion ?? 0) + cacheWrite / 1e6 * (selectedTier.cacheWritePerMillion ?? 0);
  if (!Number.isFinite(cost) || cost < 0) return void 0;
  const priceRef = `${catalog.date}#${row.id}`;
  return {
    costUsd: Math.round(cost * 1e6) / 1e6,
    priceRef
  };
}

// plugins/kxm/src/routing.ts
var ROUTING_RECORD_SCHEMA = "kxm.routing-record.v1";
var ROUTING_RECORD_V2_SCHEMA = "kxm.routing-record.v2";
var BEHAVIORAL_HASH_VERSION = 1;
var MAX_CONTEXT_ITEM_IDS = 256;
var MAX_SKILL_REFS = 32;
var MAX_PROVIDER_METADATA_FIELDS = 32;
function normalizeModel(value) {
  if (value === void 0) return void 0;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
  return normalized === "" ? void 0 : normalized;
}
function behavioralConfigHash(input) {
  const canonical = {
    version: BEHAVIORAL_HASH_VERSION,
    requestedModel: normalizeModel(input.requestedModel) ?? null,
    effectiveModel: normalizeModel(input.effectiveModel) ?? null,
    reasoningEffort: input.reasoningEffort?.trim() ?? null,
    agentRole: input.agentRole ? input.agentRole.trim().toLowerCase().replace(/\s+/g, "-") : null,
    rolePromptSha256: input.rolePromptSha256?.trim() ?? null,
    skills: (input.skills ?? []).map((skill) => ({ id: skill.id.trim(), sha: skill.contentSha256.trim() })).sort((left, right) => left.id.localeCompare(right.id) || left.sha.localeCompare(right.sha)),
    contextPolicyVersion: input.contextPolicyVersion?.trim() ?? null,
    toolPolicyVersion: input.toolPolicyVersion?.trim() ?? null,
    workflowDefinitionSha256: input.workflowDefinitionSha256?.trim() ?? null,
    verifierConfigSha256: input.verifierConfigSha256?.trim() ?? null
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}
function boundedInt(value, field) {
  if (value === void 0 || value === null) return void 0;
  if (!Number.isInteger(value) || value < 0 || value > 1e6) {
    throw new Error(`${field} must be an integer between 0 and 1000000`);
  }
  return value;
}
function boundedString(value, field, max) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string" || value.length > max) {
    throw new Error(`${field} must be a string of at most ${max} characters`);
  }
  return value;
}
function parseRoutingRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("routing record must be an object");
  }
  const input = value;
  if (input.schema === ROUTING_RECORD_V2_SCHEMA) {
    return parseRoutingRecordV2(value);
  }
  if (input.schema !== ROUTING_RECORD_SCHEMA) {
    throw new Error(`routing record schema must be ${ROUTING_RECORD_SCHEMA} or ${ROUTING_RECORD_V2_SCHEMA}`);
  }
  const skills = input.skills === void 0 || input.skills === null ? [] : (() => {
    if (!Array.isArray(input.skills) || input.skills.length > MAX_SKILL_REFS) {
      throw new Error(`routing skills must be an array of at most ${MAX_SKILL_REFS} refs`);
    }
    return input.skills.map((skill) => {
      const ref = skill;
      if (typeof ref?.id !== "string" || !ref.id.trim() || ref.id.length > 200 || typeof ref?.contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(ref.contentSha256)) {
        throw new Error("routing skill refs must carry an id and a sha256 content hash");
      }
      return { id: ref.id.trim(), contentSha256: ref.contentSha256 };
    });
  })();
  const contextItemIds = input.contextItemIds === void 0 || input.contextItemIds === null ? [] : (() => {
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
  const providerMetadata = input.providerMetadata === void 0 || input.providerMetadata === null ? void 0 : (() => {
    if (!input.providerMetadata || typeof input.providerMetadata !== "object" || Array.isArray(input.providerMetadata)) {
      throw new Error("routing providerMetadata must be an object");
    }
    const entries = Object.entries(input.providerMetadata);
    if (entries.length > MAX_PROVIDER_METADATA_FIELDS) {
      throw new Error(`routing providerMetadata may carry at most ${MAX_PROVIDER_METADATA_FIELDS} fields`);
    }
    const normalized = {};
    for (const [key, field] of entries) {
      if (typeof key !== "string" || key.length > 64 || /prompt|body|content|message/i.test(key) || typeof field !== "string" && typeof field !== "number" && typeof field !== "boolean") {
        throw new Error("routing providerMetadata values must be bounded strings, numbers, or booleans; raw bodies are rejected");
      }
      normalized[key] = typeof field === "string" ? field.slice(0, 200) : field;
    }
    return normalized;
  })();
  const verifierOutcome = input.verifierOutcome === void 0 || input.verifierOutcome === null ? void 0 : (() => {
    if (input.verifierOutcome !== "passed" && input.verifierOutcome !== "warning" && input.verifierOutcome !== "failed") {
      throw new Error("routing verifierOutcome must be passed, warning, or failed");
    }
    return input.verifierOutcome;
  })();
  const finalOutcome = input.finalOutcome === void 0 || input.finalOutcome === null ? void 0 : (() => {
    if (input.finalOutcome !== "accepted" && input.finalOutcome !== "blocked" && input.finalOutcome !== "failed" && input.finalOutcome !== "pending") {
      throw new Error("routing finalOutcome must be accepted, blocked, failed, or pending");
    }
    return input.finalOutcome;
  })();
  const costUsd = input.costUsd === void 0 || input.costUsd === null ? void 0 : (() => {
    if (typeof input.costUsd !== "number" || !Number.isFinite(input.costUsd) || input.costUsd < 0 || input.costUsd > 1e6) {
      throw new Error("routing costUsd must be a non-negative finite number");
    }
    return input.costUsd;
  })();
  const behavioralSha256 = boundedString(input.behavioralSha256, "behavioralSha256", 64) ?? "";
  if (!/^[a-f0-9]{64}$/.test(behavioralSha256)) {
    throw new Error("routing behavioralSha256 must be a sha256 hex digest");
  }
  const record = {
    schema: ROUTING_RECORD_SCHEMA,
    behavioralHashVersion: BEHAVIORAL_HASH_VERSION,
    behavioralSha256,
    skills,
    contextItemIds,
    retries: boundedInt(input.retries, "retries") ?? 0,
    transitions: boundedInt(input.transitions, "transitions") ?? 0,
    humanInterventions: boundedInt(input.humanInterventions, "humanInterventions") ?? 0
  };
  const strings = [
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
    ["verifierConfigSha256", boundedString(input.verifierConfigSha256, "verifierConfigSha256", 64)]
  ];
  for (const [key, value2] of strings) {
    if (value2 !== void 0) record[key] = value2;
  }
  for (const [key, value2] of [["attempt", boundedInt(input.attempt, "attempt")], ["tokensIn", boundedInt(input.tokensIn, "tokensIn")], ["tokensOut", boundedInt(input.tokensOut, "tokensOut")], ["cacheReadTokens", boundedInt(input.cacheReadTokens, "cacheReadTokens")]]) {
    if (value2 !== void 0) record[key] = value2;
  }
  if (costUsd !== void 0) record.costUsd = costUsd;
  if (verifierOutcome !== void 0) record.verifierOutcome = verifierOutcome;
  if (finalOutcome !== void 0) record.finalOutcome = finalOutcome;
  if (providerMetadata !== void 0) record.providerMetadata = providerMetadata;
  return record;
}
function parseRoutingRecordV2(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("routing record v2 must be an object");
  }
  const input = value;
  if (input.schema !== ROUTING_RECORD_V2_SCHEMA) {
    throw new Error(`routing record v2 schema must be ${ROUTING_RECORD_V2_SCHEMA}`);
  }
  const costBasis = input.costBasis;
  if (costBasis !== "metered" && costBasis !== "unmetered" && costBasis !== "unknown") {
    throw new Error("routing record v2 costBasis must be metered, unmetered, or unknown");
  }
  let costUsd = void 0;
  if (costBasis === "metered") {
    if (typeof input.costUsd !== "number" || !Number.isFinite(input.costUsd) || input.costUsd < 0 || input.costUsd > 1e6) {
      throw new Error("routing record v2 costUsd must be a non-negative finite number when costBasis is metered");
    }
    costUsd = input.costUsd;
  } else if (input.costUsd !== void 0 && input.costUsd !== null) {
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
  const providerMetadata = input.providerMetadata === void 0 || input.providerMetadata === null ? void 0 : (() => {
    if (!input.providerMetadata || typeof input.providerMetadata !== "object" || Array.isArray(input.providerMetadata)) {
      throw new Error("routing providerMetadata must be an object");
    }
    const entries = Object.entries(input.providerMetadata);
    if (entries.length > MAX_PROVIDER_METADATA_FIELDS) {
      throw new Error(`routing providerMetadata may carry at most ${MAX_PROVIDER_METADATA_FIELDS} fields`);
    }
    const normalized = {};
    for (const [key, field] of entries) {
      if (typeof key !== "string" || key.length > 64 || /prompt|body|content|message/i.test(key) || typeof field !== "string" && typeof field !== "number" && typeof field !== "boolean") {
        throw new Error("routing providerMetadata values must be bounded strings, numbers, or booleans; raw bodies are rejected");
      }
      normalized[key] = typeof field === "string" ? field.slice(0, 200) : field;
    }
    return normalized;
  })();
  const record = {
    schema: ROUTING_RECORD_V2_SCHEMA,
    recordedAt: boundedString(input.recordedAt, "recordedAt", 64) ?? (/* @__PURE__ */ new Date()).toISOString(),
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
    retries: boundedInt(input.retries, "retries") ?? 0
  };
  if (input.thinking !== void 0 && input.thinking !== null) {
    record.thinking = boundedString(input.thinking, "thinking", 64);
  }
  const rawRole = input.agentRole ?? input.role;
  if (rawRole !== void 0 && rawRole !== null) {
    record.agentRole = boundedString(rawRole, "agentRole", 64);
  }
  if (input.contextTokens !== void 0) {
    record.contextTokens = boundedInt(input.contextTokens, "contextTokens") ?? null;
  }
  if (input.tokensIn !== void 0) {
    record.tokensIn = boundedInt(input.tokensIn, "tokensIn") ?? null;
  }
  if (input.tokensOut !== void 0) {
    record.tokensOut = boundedInt(input.tokensOut, "tokensOut") ?? null;
  }
  if (input.cacheReadTokens !== void 0) {
    record.cacheReadTokens = boundedInt(input.cacheReadTokens, "cacheReadTokens") ?? null;
  }
  if (input.cacheWriteTokens !== void 0) {
    record.cacheWriteTokens = boundedInt(input.cacheWriteTokens, "cacheWriteTokens") ?? null;
  }
  if (input.priceRef !== void 0 && input.priceRef !== null) {
    record.priceRef = boundedString(input.priceRef, "priceRef", 128);
  }
  if (input.verifierOutcome !== void 0 && input.verifierOutcome !== null) {
    if (input.verifierOutcome !== "passed" && input.verifierOutcome !== "warning" && input.verifierOutcome !== "failed") {
      throw new Error("routing verifierOutcome must be passed, warning, or failed");
    }
    record.verifierOutcome = input.verifierOutcome;
  }
  if (input.finalOutcome !== void 0 && input.finalOutcome !== null) {
    record.finalOutcome = typeof input.finalOutcome === "string" ? input.finalOutcome.slice(0, 64) : void 0;
  }
  if (input.transitions !== void 0) {
    record.transitions = boundedInt(input.transitions, "transitions");
  }
  if (input.humanInterventions !== void 0) {
    record.humanInterventions = boundedInt(input.humanInterventions, "humanInterventions");
  }
  if (providerMetadata !== void 0) {
    record.providerMetadata = providerMetadata;
  }
  return record;
}
function compareRoutingRecords(records) {
  if (records.length === 0) {
    throw new Error("compareRoutingRecords requires at least one record");
  }
  const behavioralSha256 = records[0].behavioralSha256;
  for (const record of records) {
    if (record.behavioralSha256 !== behavioralSha256) {
      throw new Error("compareRoutingRecords requires records with identical behavioral hashes");
    }
  }
  const settled = records.filter((record) => record.finalOutcome !== void 0 && record.finalOutcome !== "pending");
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
    reworkRate: records.length === 0 ? 0 : Math.round(reworked / records.length * 100) / 100,
    totalCostUsd: Math.round(records.reduce((sum, record) => sum + (record.costUsd ?? 0), 0) * 1e4) / 1e4,
    totalTokensIn: records.reduce((sum, record) => sum + (record.tokensIn ?? 0), 0),
    totalTokensOut: records.reduce((sum, record) => sum + (record.tokensOut ?? 0), 0),
    totalHumanInterventions: records.reduce((sum, record) => sum + record.humanInterventions, 0)
  };
}
function groupByBehavior(records) {
  const groups = /* @__PURE__ */ new Map();
  for (const record of records) {
    const bucket = groups.get(record.behavioralSha256) ?? [];
    bucket.push(record);
    groups.set(record.behavioralSha256, bucket);
  }
  return groups;
}
var ROUTING_REPORT_SCHEMA = "kxm.routing-report.v1";
function isQuotaExhausted(record) {
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
function computePercentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = p * (sorted.length - 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== void 0) {
    return Math.round(sorted[base] + rest * (sorted[base + 1] - sorted[base]));
  }
  return sorted[base];
}
function computeDecayedWeight(recordedAt, halfLifeDays = 14, now = Date.now()) {
  const ts = typeof recordedAt === "number" ? recordedAt : Date.parse(recordedAt);
  if (!Number.isFinite(ts)) return 1;
  const deltaMs = Math.max(0, now - ts);
  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1e3;
  return Math.pow(2, -deltaMs / halfLifeMs);
}
function evaluateCircuitBreaker(records, route, config, now = Date.now()) {
  const mode = config?.mode ?? "soft_demotion";
  const failureThreshold = config?.failureThreshold ?? 3;
  const windowSeconds = config?.windowSeconds ?? 3600;
  const penaltyMultiplier = config?.penaltyMultiplier ?? 5;
  const windowMs = windowSeconds * 1e3;
  const matching = records.filter((r) => {
    const isV2 = r.schema === ROUTING_RECORD_V2_SCHEMA;
    const harness = isV2 ? r.harness : r.providerMetadata?.harness;
    const model = isV2 ? r.effectiveModel || r.requestedModel : r.effectiveModel || r.requestedModel;
    if (harness !== route.harness || model !== route.model) return false;
    const recAt = r.recordedAt;
    const ts = typeof recAt === "string" ? Date.parse(recAt) : 0;
    return ts >= now - windowMs;
  });
  matching.sort((a, b) => {
    const ta = typeof a.recordedAt === "string" ? Date.parse(a.recordedAt) : 0;
    const tb = typeof b.recordedAt === "string" ? Date.parse(b.recordedAt) : 0;
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
        reason: `Route quarantined after ${consecutiveFailures} consecutive failures within ${windowSeconds}s`
      };
    }
    return {
      status: "demoted",
      consecutiveFailures,
      penaltyMultiplier,
      reason: `Route demoted with ${penaltyMultiplier}x penalty after ${consecutiveFailures} consecutive failures`
    };
  }
  return {
    status: "healthy",
    consecutiveFailures,
    penaltyMultiplier: 1
  };
}
function generateRoutingReport(records, options = {}) {
  const generatedAt = options.now ? options.now() : (/* @__PURE__ */ new Date()).toISOString();
  if (records.length === 0) {
    return {
      schema: ROUTING_REPORT_SCHEMA,
      generatedAt,
      totalAttempts: 0,
      rows: []
    };
  }
  const groups = /* @__PURE__ */ new Map();
  for (const record of records) {
    const isV2 = record.schema === ROUTING_RECORD_V2_SCHEMA;
    const harness = (isV2 ? record.harness : record.providerMetadata?.harness) || "unknown";
    const model = (isV2 ? record.effectiveModel || record.requestedModel : record.effectiveModel || record.requestedModel) || "unknown";
    const thinking = (isV2 ? record.thinking : record.reasoningEffort) || "none";
    const role = record.role || record.agentRole || "unknown";
    const key = `${harness}\0${model}\0${thinking}\0${role}`;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(record);
  }
  const rows = [];
  for (const [key, groupRecords] of groups.entries()) {
    const [harness, model, thinking, role] = key.split("\0");
    const attempts = groupRecords.length;
    let verifyPassedCount = 0;
    let reworkCount = 0;
    let acceptedCount = 0;
    let meteredCostTotal = 0;
    let unmeteredAttempts = 0;
    let unknownCostAttempts = 0;
    let quotaExhaustedAttempts = 0;
    const latencies = [];
    const contextVals = [];
    for (const r of groupRecords) {
      const isV2 = r.schema === ROUTING_RECORD_V2_SCHEMA;
      const v2 = isV2 ? r : void 0;
      if (r.verifierOutcome === "passed" || !r.verifierOutcome && r.finalOutcome === "accepted") {
        verifyPassedCount++;
      }
      if ((r.transitions ?? 0) > 0) {
        reworkCount++;
      }
      if (r.finalOutcome === "accepted" || r.verifierOutcome === "passed") {
        acceptedCount++;
      }
      const costBasis = v2 ? v2.costBasis : typeof r.costUsd === "number" ? "metered" : "unknown";
      if (costBasis === "metered") {
        if (typeof r.costUsd === "number" && Number.isFinite(r.costUsd)) {
          meteredCostTotal += r.costUsd;
        }
      } else if (costBasis === "unmetered") {
        unmeteredAttempts++;
      } else {
        unknownCostAttempts++;
      }
      if (isQuotaExhausted(r)) {
        quotaExhaustedAttempts++;
      }
      const lat = v2 ? v2.latencyMs : typeof r.providerMetadata?.latencyMs === "number" ? r.providerMetadata.latencyMs : void 0;
      if (typeof lat === "number" && Number.isFinite(lat) && lat >= 0) {
        latencies.push(lat);
      }
      const ctx = v2 ? v2.contextTokens ?? v2.tokensIn : r.tokensIn;
      if (typeof ctx === "number" && Number.isFinite(ctx) && ctx >= 0) {
        contextVals.push(ctx);
      }
    }
    const verifyPassRate = attempts > 0 ? Math.round(verifyPassedCount / attempts * 1e3) / 1e3 : 0;
    const reworkRate = attempts > 0 ? Math.round(reworkCount / attempts * 1e3) / 1e3 : 0;
    latencies.sort((a, b) => a - b);
    const latencyP50Ms = computePercentile(latencies, 0.5);
    const latencyP95Ms = computePercentile(latencies, 0.95);
    contextVals.sort((a, b) => a - b);
    let medianContextTokens = null;
    if (contextVals.length > 0) {
      const mid = Math.floor(contextVals.length / 2);
      medianContextTokens = contextVals.length % 2 !== 0 ? contextVals[mid] : Math.round((contextVals[mid - 1] + contextVals[mid]) / 2);
    }
    const meteredCostUsd = Math.round(meteredCostTotal * 1e4) / 1e4;
    const costPerAcceptedUsd = acceptedCount > 0 ? meteredCostUsd > 0 || unmeteredAttempts > 0 ? Math.round(meteredCostUsd / acceptedCount * 1e4) / 1e4 : unknownCostAttempts === attempts ? null : 0 : null;
    const flagged = unknownCostAttempts > 0;
    let equivalentListCostUsd = void 0;
    if (options.includeEquivalentListCost && options.catalog) {
      let equivTotal = 0;
      let calculatedAll = true;
      for (const r of groupRecords) {
        const isV2 = r.schema === ROUTING_RECORD_V2_SCHEMA;
        const v2 = isV2 ? r : void 0;
        const costBasis = v2 ? v2.costBasis : typeof r.costUsd === "number" ? "metered" : "unknown";
        if (costBasis === "metered" && typeof r.costUsd === "number") {
          equivTotal += r.costUsd;
        } else {
          const calc = calculateModelCost(options.catalog, {
            model,
            ...v2?.provider ? { provider: v2.provider } : {},
            tokensIn: r.tokensIn ?? null,
            tokensOut: r.tokensOut ?? null,
            cacheReadTokens: r.cacheReadTokens ?? null,
            cacheWriteTokens: v2?.cacheWriteTokens ?? null,
            contextTokens: v2?.contextTokens ?? null
          });
          if (calc) {
            equivTotal += calc.costUsd;
          } else {
            calculatedAll = false;
          }
        }
      }
      equivalentListCostUsd = calculatedAll ? Math.round(equivTotal * 1e4) / 1e4 : null;
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
      ...options.includeEquivalentListCost ? { equivalentListCostUsd } : {}
    });
  }
  rows.sort((a, b) => {
    if (a.verifyPassRate !== b.verifyPassRate) {
      return b.verifyPassRate - a.verifyPassRate;
    }
    if (a.reworkRate !== b.reworkRate) {
      return a.reworkRate - b.reworkRate;
    }
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
    rows
  };
}
function formatRoutingReport(report, options = {}) {
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
    ...showListCost ? ["ListEquiv($)".padStart(13)] : []
  ].join(" ");
  const lines = [
    `Routing Telemetry Report (${report.totalAttempts} attempt(s) across ${report.rows.length} route(s), quality-first ranking)`,
    headers
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
      ...showListCost ? [(row.equivalentListCostUsd !== void 0 && row.equivalentListCostUsd !== null ? `$${row.equivalentListCostUsd.toFixed(4)}` : "-").padStart(13)] : []
    ];
    lines.push(cells.join(" "));
  }
  if (report.rows.some((r) => r.flagged)) {
    lines.push("* = unknown-cost attempts present (never ranked cheapest)");
  }
  return lines.join("\n");
}

// plugins/kxm/src/envelope.ts
var WORKER_SCHEMA = "kxm.worker.v1";
var WORKER_RESULT_SCHEMA = "kxm.worker-result.v1";
function agentWorker(input) {
  return {
    schema: WORKER_SCHEMA,
    kind: "agent",
    driver: "ai",
    name: input.name,
    ...input.project ? { project: input.project } : {},
    ...input.purpose ? { purpose: input.purpose } : {},
    ...input.model ? { model: input.model } : {},
    ...input.thinking ? { thinking: input.thinking } : {}
  };
}
function gateWorker(input) {
  return {
    schema: WORKER_SCHEMA,
    kind: "gate",
    driver: "code",
    name: input.name,
    ...input.project ? { project: input.project } : {},
    ...input.purpose ? { purpose: input.purpose } : {}
  };
}
function workerResult(worker, payload) {
  const { summary, outcome, createdAt, ...rest } = payload;
  if (outcome === "passed" && payload.ok === false) {
    throw new Error('workerResult outcome contradicts ok: "passed" requires ok: true');
  }
  if (outcome === "failed" && payload.ok === true) {
    throw new Error('workerResult outcome contradicts ok: "failed" requires ok: false');
  }
  if (rest.routing !== void 0) {
    parseRoutingRecord(rest.routing);
  }
  return {
    ...rest,
    schema: WORKER_RESULT_SCHEMA,
    worker,
    createdAt: createdAt ?? nowIso(),
    outcome: outcome ?? (payload.ok ? "passed" : "failed"),
    summary
  };
}

// plugins/kxm/src/redact.ts
var SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\bya29\.[A-Za-z0-9._~+/-]+=*/g,
  /\b1\/\/[A-Za-z0-9_-]+/g,
  /\b1\/[A-Za-z0-9_-]{20,}/g,
  /("?(?:access_token|refresh_token|id_token|sessionKey|session_key|claude_oauth_token|anthropicApiKey)"?\s*[:=]\s*")[^"]*(")/gi,
  /\bKXM_[A-Z0-9_]*(TOKEN|SECRET|KEY)[A-Z0-9_]*=\S+/gi,
  /\b(GITHUB_TOKEN|GH_TOKEN|KXM_AUTH_TOKEN|KXM_WORKFLOW_SIGNAL_SECRET|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_API_KEY)=\S+/gi,
  /\b[A-Fa-f0-9]{64}\b/g
];
function redactSecrets(value) {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[redacted]");
  }
  return result;
}
function looksLikeSecret(value) {
  return redactSecrets(value) !== value;
}
function redactStringList(values, maxItems = 32) {
  return values.slice(0, maxItems).map((value) => redactSecrets(value).slice(0, 500));
}

// plugins/kxm/src/commands.ts
import { createHash as createHash2, randomUUID as randomUUID2, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// plugins/kxm/src/client.ts
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

// plugins/kxm/src/commands.ts
function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}
function optionalString2(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function optionalWorkflowContext(value) {
  if (value === void 0) return void 0;
  const context = asRecord(value);
  if (!Number.isInteger(context.attempt) || context.attempt < 1 || context.attempt > 20) {
    throw new Error("workflowContext.attempt must be an integer between 1 and 20");
  }
  return {
    runId: requiredString(context.runId, "workflowContext.runId"),
    stageId: requiredString(context.stageId, "workflowContext.stageId"),
    requirementKey: requiredString(context.requirementKey, "workflowContext.requirementKey"),
    attempt: context.attempt
  };
}
function optionalEvidenceRefs(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function isTerminalMessageError(error) {
  return error instanceof HubHttpError && (error.statusCode === 409 || error.statusCode === 404 && error.code === "message_not_found");
}
function isTerminalMessage(message) {
  return message.status === "replied" || message.status === "cancelled" || message.status === "expired" || message.status === "error";
}
async function reconcileInbox(client, inbox, notifiedInbox) {
  await Promise.all(
    [...inbox.keys()].map(async (messageId) => {
      try {
        const current = await client.getMessage(messageId);
        if (isTerminalMessage(current)) {
          inbox.delete(messageId);
          notifiedInbox?.delete(messageId);
        } else {
          inbox.set(messageId, current);
        }
      } catch (error) {
        if (isTerminalMessageError(error)) {
          inbox.delete(messageId);
          notifiedInbox?.delete(messageId);
          return;
        }
        throw error;
      }
    })
  );
}
function resolveProject(client, projectArg) {
  const proj = optionalString2(projectArg) ?? client.agent?.project;
  if (!proj) {
    throw new Error('missing required parameter "project"');
  }
  return proj;
}
var AGENT_COMMANDS = [
  {
    name: "kxm_list",
    group: "peer",
    verb: "list",
    label: "List hub peers",
    description: "List peer agents in this project's hub pool with their names, purposes, host label, and hub-clocked presence (online, stale, offline). Registered offline peers are listed only when includeOffline is set.",
    parameters: {
      type: "object",
      properties: {
        includeOffline: {
          type: "boolean",
          description: "Also list registered peers whose hub lease has expired"
        }
      },
      additionalProperties: false
    },
    async execute(client, args) {
      return { agents: await client.listAgents({ includeOffline: args.includeOffline === true }) };
    }
  },
  {
    name: "kxm_send",
    group: "peer",
    verb: "send",
    label: "Send peer request",
    description: "Send a focused request to a peer agent. Returns a message ID for kxm_get or kxm_await. For durable peer evidence, workflowContext is the hub-authorized provenance scope; correlation and idempotency are transport concerns and do not establish evidence provenance.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Peer name or agent ID" },
        content: { type: "string", description: "Focused request with the expected response or artifact" },
        delivery: {
          type: "string",
          enum: ["steer", "followUp", "nextTurn"],
          default: "followUp",
          description: "followUp is the safe default; use steer only for active blockers"
        },
        correlationId: {
          type: "string",
          description: "Optional task grouping; the hub binds it to runId when workflowContext is supplied"
        },
        idempotencyKey: {
          type: "string",
          description: "Retry/deduplication key only; not a workflow security or evidence binding"
        },
        workflowContext: {
          type: "object",
          description: "Requested provenance scope; the hub authorizes and persists the canonical binding",
          properties: {
            runId: { type: "string", description: "Active durable workflow run ID" },
            stageId: { type: "string", description: "Active workflow stage ID" },
            requirementKey: { type: "string", description: "Required evidence identity this peer reply may satisfy" },
            attempt: { type: "integer", minimum: 1, maximum: 20, description: "Current one-based stage attempt" }
          },
          required: ["runId", "stageId", "requirementKey", "attempt"],
          additionalProperties: false
        },
        ttlMs: { type: "number", minimum: 1e3, maximum: 6048e5, description: "Message TTL in milliseconds" },
        allowOffline: {
          type: "boolean",
          default: false,
          description: "Queue the request if the target is a registered offline agent in this project"
        }
      },
      required: ["target", "content"],
      additionalProperties: false
    },
    async execute(client, args) {
      const delivery = optionalString2(args.delivery);
      const correlationId = optionalString2(args.correlationId);
      const idempotencyKey = optionalString2(args.idempotencyKey);
      const workflowContext = optionalWorkflowContext(args.workflowContext);
      const message = await client.send({
        target: requiredString(args.target, "target"),
        content: requiredString(args.content, "content"),
        ...delivery ? { delivery } : {},
        ...correlationId ? { correlationId } : {},
        ...idempotencyKey ? { idempotencyKey } : {},
        ...workflowContext ? { workflowContext } : {},
        ...typeof args.ttlMs === "number" ? { ttlMs: args.ttlMs } : {},
        ...args.allowOffline === true ? { allowOffline: true } : {}
      });
      return { messageId: message.id, status: message.status, target: message.toName };
    }
  },
  {
    name: "kxm_get",
    group: "peer",
    verb: "get",
    label: "Get peer request",
    description: "Check the status and optional reply for a previously sent request.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID of the sent request" }
      },
      required: ["messageId"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.getMessage(requiredString(args.messageId, "messageId"));
    }
  },
  {
    name: "kxm_fanout",
    group: "peer",
    verb: "fanout",
    label: "Fanout peer requests",
    description: "Ask one through three peers independently and return replies for comparison and synthesis. A local timeout or request cancellation returns a pending response with a durable messageId for kxm_get or an exact retry.",
    parameters: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 3,
          description: "One through three target peer names or agent IDs"
        },
        content: { type: "string", description: "Task description sent to all targets" },
        correlationId: {
          type: "string",
          description: "Optional task grouping; the hub binds it to runId when workflowContext is supplied"
        },
        idempotencyKeyPrefix: {
          type: "string",
          description: "Stable retry/deduplication prefix only; not a workflow security or evidence binding"
        },
        workflowContext: {
          type: "object",
          description: "Requested provenance scope shared by each request",
          properties: {
            runId: { type: "string", description: "Active durable workflow run ID" },
            stageId: { type: "string", description: "Active workflow stage ID" },
            requirementKey: { type: "string", description: "Required evidence identity these peer replies may satisfy" },
            attempt: { type: "integer", minimum: 1, maximum: 20, description: "Current one-based stage attempt" }
          },
          required: ["runId", "stageId", "requirementKey", "attempt"],
          additionalProperties: false
        },
        ttlMs: { type: "number", minimum: 1e3, maximum: 6048e5, description: "Message TTL in milliseconds" },
        timeoutMs: { type: "number", minimum: 100, maximum: 18e5, description: "Client wait timeout in milliseconds" }
      },
      required: ["targets", "content"],
      additionalProperties: false
    },
    async execute(client, args, context) {
      const targets = Array.isArray(args.targets) ? args.targets.map((t) => requiredString(t, "target")) : [];
      return {
        responses: await client.fanout({
          targets,
          content: requiredString(args.content, "content"),
          ...optionalString2(args.correlationId) ? { correlationId: optionalString2(args.correlationId) } : {},
          ...optionalString2(args.idempotencyKeyPrefix) ? { idempotencyKeyPrefix: optionalString2(args.idempotencyKeyPrefix) } : {},
          ...optionalWorkflowContext(args.workflowContext) ? { workflowContext: optionalWorkflowContext(args.workflowContext) } : {},
          ...typeof args.ttlMs === "number" ? { ttlMs: args.ttlMs } : {},
          ...typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {},
          ...context?.signal ? { signal: context.signal } : {}
        })
      };
    }
  },
  {
    name: "kxm_await",
    group: "peer",
    verb: "await",
    label: "Await peer response",
    description: "Wait until a sent request receives a reply or reaches a terminal error. Capped at 60 seconds (60000ms); longer waits are workflow wait steps.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID of the sent request" },
        timeoutMs: {
          type: "number",
          minimum: 100,
          maximum: 6e4,
          default: 6e4,
          description: "Timeout in milliseconds (capped at 60 seconds)"
        }
      },
      required: ["messageId"],
      additionalProperties: false
    },
    async execute(client, args, context) {
      const timeoutMs = Math.min(
        typeof args.timeoutMs === "number" ? args.timeoutMs : 6e4,
        6e4
      );
      return await client.awaitResponse(
        requiredString(args.messageId, "messageId"),
        timeoutMs,
        context?.signal
      );
    }
  },
  {
    name: "kxm_cancel",
    group: "peer",
    verb: "cancel",
    label: "Cancel peer request",
    description: "Cancel a queued or delivered request sent by this agent.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID of the request to cancel" }
      },
      required: ["messageId"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.cancel(requiredString(args.messageId, "messageId"));
    }
  },
  {
    name: "kxm_inbox",
    group: "peer",
    verb: "inbox",
    label: "List inbound requests",
    description: "List inbound peer requests awaiting a reply.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    async execute(client, _args, context) {
      if (context?.inbox) {
        await reconcileInbox(client, context.inbox, context.notifiedInbox);
        return { messages: [...context.inbox.values()] };
      }
      return { messages: [] };
    }
  },
  {
    name: "kxm_reply",
    group: "peer",
    verb: "reply",
    label: "Reply to peer request",
    description: "Reply to an inbound peer request using its message ID.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID of the inbound request" },
        content: { type: "string", description: "Final response with evidence and remaining risks" }
      },
      required: ["messageId", "content"],
      additionalProperties: false
    },
    async execute(client, args, context) {
      const messageId = requiredString(args.messageId, "messageId");
      try {
        const message = await client.reply(messageId, requiredString(args.content, "content"));
        if (context?.inbox) {
          context.inbox.delete(messageId);
          context.notifiedInbox?.delete(messageId);
        }
        return { messageId, status: message.status, recipient: message.fromName };
      } catch (error) {
        if (context?.inbox && isTerminalMessageError(error)) {
          context.inbox.delete(messageId);
          context.notifiedInbox?.delete(messageId);
        }
        throw error;
      }
    }
  },
  {
    name: "kxm_workflow_list",
    group: "workflow",
    verb: "runs",
    label: "List workflow runs",
    description: "List durable webhook workflows assigned to this agent.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    async execute(client) {
      return { runs: await client.listWorkflows() };
    }
  },
  {
    name: "kxm_workflow_get",
    group: "workflow",
    verb: "run",
    label: "Get workflow run",
    description: "Get a workflow's stages and journal of plans, decisions, contradictions, errors, and lessons.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Workflow run ID" }
      },
      required: ["runId"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.getWorkflow(requiredString(args.runId, "runId"));
    }
  },
  {
    name: "kxm_workflow_checkpoint",
    group: "workflow",
    verb: "checkpoint",
    label: "Checkpoint workflow stage",
    description: "Record a stage result with evidence keyed by the stage's required evidence identities. Cite peer-reply requirements through evidenceRefs so the hub can verify provenance and quorum; caller-authored evidence strings cannot satisfy those policies. Warnings and failures require another attempt until passed or exhausted.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Active durable workflow run ID" },
        stageId: { type: "string", description: "Active stage ID" },
        status: { type: "string", enum: ["passed", "warning", "failed"], description: "Stage outcome" },
        summary: { type: "string", description: "Summary of changes, verification, and remaining risks" },
        evidence: {
          type: "object",
          additionalProperties: { type: "string" },
          maxProperties: 64,
          description: "Key-value evidence mapping required keys to proof strings"
        },
        evidenceRefs: {
          type: "object",
          description: "Peer evidence references keyed by required evidence identity",
          patternProperties: {
            "^(.*)$": {
              type: "object",
              properties: {
                messageIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 }
              },
              required: ["messageIds"],
              additionalProperties: false
            }
          },
          additionalProperties: {
            type: "object",
            properties: {
              messageIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 }
            },
            required: ["messageIds"],
            additionalProperties: false
          },
          maxProperties: 32
        }
      },
      required: ["runId", "stageId", "status", "summary"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.checkpointWorkflow(requiredString(args.runId, "runId"), {
        stageId: requiredString(args.stageId, "stageId"),
        status: requiredString(args.status, "status"),
        summary: requiredString(args.summary, "summary"),
        ...args.evidence && typeof args.evidence === "object" && !Array.isArray(args.evidence) ? { evidence: args.evidence } : {},
        ...optionalEvidenceRefs(args.evidenceRefs) ? { evidenceRefs: optionalEvidenceRefs(args.evidenceRefs) } : {}
      });
    }
  },
  {
    name: "kxm_workflow_record",
    group: "workflow",
    verb: "record",
    label: "Record workflow journal entry",
    description: "Record a plan, decision, contradiction, error, or lesson for continuous improvement.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Active durable workflow run ID" },
        category: {
          type: "string",
          enum: ["plan", "decision", "contradiction", "error", "lesson"],
          description: "Category of journal entry"
        },
        area: {
          type: "string",
          enum: ["harness", "gates", "implementation", "workflow", "documentation", "security", "other"],
          description: "System area"
        },
        severity: {
          type: "string",
          enum: ["info", "warning", "error"],
          default: "info",
          description: "Severity level"
        },
        summary: { type: "string", description: "Concise description of the observation or decision" },
        details: { type: "string", description: "Extended details, context, and reasoning" },
        evidence: {
          type: "array",
          items: { type: "string" },
          maxItems: 32,
          description: "Durable evidence strings or URIs"
        },
        relatedEntryIds: {
          type: "array",
          items: { type: "string" },
          maxItems: 16,
          description: "Related previous journal entry IDs"
        }
      },
      required: ["runId", "category", "area", "summary"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.recordWorkflowEntry(requiredString(args.runId, "runId"), {
        category: requiredString(args.category, "category"),
        area: requiredString(args.area, "area"),
        ...optionalString2(args.severity) ? { severity: optionalString2(args.severity) } : {},
        summary: requiredString(args.summary, "summary"),
        ...optionalString2(args.details) ? { details: optionalString2(args.details) } : {},
        ...Array.isArray(args.evidence) ? { evidence: args.evidence } : {},
        ...Array.isArray(args.relatedEntryIds) ? { relatedEntryIds: args.relatedEntryIds } : {}
      });
    }
  },
  {
    name: "kxm_workflow_wait",
    group: "workflow",
    verb: "wait",
    label: "Wait for workflow signal",
    description: "Pause the active stage until a signed external callback checkpoints it and resumes the coordinator. Cite peer-reply requirements through evidenceRefs so the hub can verify provenance and quorum; verified evidence is accumulated with callback evidence.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Active durable workflow run ID" },
        stageId: { type: "string", description: "Active stage ID" },
        signalKey: { type: "string", description: "Stable callback key, such as github-pr-42-checks" },
        summary: { type: "string", description: "What is running externally and what result is expected" },
        evidence: {
          type: "object",
          additionalProperties: { type: "string" },
          maxProperties: 64,
          description: "Evidence gathered before the wait"
        },
        evidenceRefs: {
          type: "object",
          description: "Peer evidence references verified before waiting",
          patternProperties: {
            "^(.*)$": {
              type: "object",
              properties: {
                messageIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 }
              },
              required: ["messageIds"],
              additionalProperties: false
            }
          },
          additionalProperties: {
            type: "object",
            properties: {
              messageIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 }
            },
            required: ["messageIds"],
            additionalProperties: false
          },
          maxProperties: 32
        },
        timeoutMs: {
          type: "number",
          minimum: 1e3,
          maximum: 2592e6,
          description: "Maximum wait duration in milliseconds"
        }
      },
      required: ["runId", "stageId", "signalKey", "summary"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.waitForWorkflowSignal(requiredString(args.runId, "runId"), {
        stageId: requiredString(args.stageId, "stageId"),
        signalKey: requiredString(args.signalKey, "signalKey"),
        summary: requiredString(args.summary, "summary"),
        ...args.evidence && typeof args.evidence === "object" && !Array.isArray(args.evidence) ? { evidence: args.evidence } : {},
        ...optionalEvidenceRefs(args.evidenceRefs) ? { evidenceRefs: optionalEvidenceRefs(args.evidenceRefs) } : {},
        ...typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}
      });
    }
  },
  {
    name: "kxm_improvement_report",
    group: "workflow",
    verb: "improve-report",
    label: "Summarize improvement report",
    description: "Summarize workflow errors, contradictions, and lessons by improvement area.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    async execute(client) {
      return await client.improvementReport();
    }
  },
  {
    name: "kxm_context",
    group: "context",
    verb: "get",
    label: "Get KXM context packet",
    description: "Normal entry point for KXM context. Assembles a token-budgeted role-aware context packet from durable journal evidence, temporal state, knowledge, episodes, and skills. Superseded and rejected records are excluded. Use KXM context tools instead of provider-specific memory APIs.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project scope (must be the client's project)" },
        role: {
          type: "string",
          description: "Requesting role: repro, planner, critic, implementer, verifier, or custom"
        },
        task: { type: "string", description: "What the role is trying to accomplish" },
        workflowRunId: { type: "string", description: "Workflow run scope" },
        stageId: { type: "string", description: "Workflow stage scope" },
        budgetTokens: { type: "integer", description: "Token budget; defaults to the role policy" },
        includeKinds: {
          type: "array",
          items: { type: "string", enum: ["evidence", "state", "episode", "knowledge", "skill"] },
          description: "Restrict packet to these item kinds"
        }
      },
      required: ["role", "task"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.contextGet({
        project: resolveProject(client, args.project),
        role: requiredString(args.role, "role"),
        task: requiredString(args.task, "task"),
        ...optionalString2(args.workflowRunId) ? { workflowRunId: optionalString2(args.workflowRunId) } : {},
        ...optionalString2(args.stageId) ? { stageId: optionalString2(args.stageId) } : {},
        ...typeof args.budgetTokens === "number" ? { budgetTokens: args.budgetTokens } : {},
        ...Array.isArray(args.includeKinds) ? { includeKinds: args.includeKinds } : {}
      });
    }
  },
  {
    name: "kxm_recall",
    group: "context",
    verb: "recall",
    label: "Recall context metadata",
    description: "Search durable context records for a project by query; returns bounded metadata only.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project identifier" },
        query: { type: "string", description: "Query string" },
        kinds: { type: "array", items: { type: "string" }, description: "Kinds filter" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum results" }
      },
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.contextRecall({
        project: resolveProject(client, args.project),
        ...optionalString2(args.query) ? { query: optionalString2(args.query) } : {},
        ...Array.isArray(args.kinds) ? { kinds: args.kinds } : {},
        ...typeof args.limit === "number" ? { limit: args.limit } : {}
      });
    }
  },
  {
    name: "kxm_state",
    group: "context",
    verb: "state",
    label: "Get temporal state",
    description: "Current value for one temporal state key, optionally as of a historical timestamp.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project identifier" },
        key: { type: "string", description: "State key" },
        asOf: { type: "string", description: "ISO-8601 timestamp for historical queries" }
      },
      required: ["key"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.contextState({
        project: resolveProject(client, args.project),
        key: requiredString(args.key, "key"),
        ...optionalString2(args.asOf) ? { asOf: optionalString2(args.asOf) } : {}
      });
    }
  },
  {
    name: "kxm_episode",
    group: "context",
    verb: "episode",
    label: "Get workflow episodes",
    description: "Episodic learning from workflow journals: errors, lessons, observations, experiments for a project.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project identifier" },
        workflowRunId: { type: "string", description: "Optional workflow run scope" }
      },
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.contextEpisode({
        project: resolveProject(client, args.project),
        ...optionalString2(args.workflowRunId) ? { workflowRunId: optionalString2(args.workflowRunId) } : {}
      });
    }
  },
  {
    name: "kxm_promote",
    group: "context",
    verb: "promote",
    label: "Propose state promotion",
    description: "Propose a change to one authoritative state key. Promotion requires durable evidence.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project identifier" },
        key: { type: "string", description: "State key to promote" },
        summary: { type: "string", description: "Promotion summary" },
        authority: {
          type: "string",
          enum: ["policy", "instruction", "evidence", "hypothesis"],
          description: "Authority class"
        },
        confidence: {
          type: "string",
          enum: ["verified", "probable", "uncertain"],
          description: "Confidence level"
        },
        evidenceRefs: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 32,
          description: "Evidence item references backing the promotion"
        }
      },
      required: ["key", "summary", "authority", "confidence", "evidenceRefs"],
      additionalProperties: false
    },
    async execute(client, args) {
      return await client.contextStatePropose({
        project: resolveProject(client, args.project),
        key: requiredString(args.key, "key"),
        summary: requiredString(args.summary, "summary"),
        authority: requiredString(args.authority, "authority"),
        confidence: requiredString(args.confidence, "confidence"),
        evidenceRefs: Array.isArray(args.evidenceRefs) ? args.evidenceRefs : []
      });
    }
  }
];
var AGENT_COMMANDS_MAP = new Map(
  AGENT_COMMANDS.map((cmd) => [cmd.name, cmd])
);
function getMcpTools() {
  return AGENT_COMMANDS.map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    inputSchema: cmd.parameters
  }));
}
function getPiToolDefinitions() {
  return AGENT_COMMANDS.map((cmd) => ({
    name: cmd.name,
    label: cmd.label,
    description: cmd.description,
    parameters: cmd.parameters
  }));
}
function getCliAgentCommands() {
  return AGENT_COMMANDS;
}
function mintAttemptToken(input) {
  const toolPolicy = input.toolPolicy ?? (input.allowedTools || input.deniedTools || input.preset ? {
    ...input.preset ? { preset: input.preset } : {},
    ...input.allowedTools ? { allow: input.allowedTools, allowedTools: input.allowedTools } : {},
    ...input.deniedTools ? { deny: input.deniedTools, deniedTools: input.deniedTools } : {}
  } : void 0);
  const payload = {
    schema: "kxm.attempt-token.v1",
    runId: input.runId,
    stepId: input.stepId ?? input.stageId ?? "step-1",
    stepAttempt: input.stepAttempt ?? input.attempt ?? 1,
    stageId: input.stageId ?? input.stepId ?? "step-1",
    attempt: input.attempt ?? input.stepAttempt ?? 1,
    assignmentId: input.assignmentId ?? `assign-${randomUUID2()}`,
    attemptId: input.attemptId ?? `attempt-${randomUUID2()}`,
    agentId: input.agentId ?? "agent-worker",
    issuedAt: (/* @__PURE__ */ new Date()).toISOString(),
    ...toolPolicy ? { toolPolicy } : {}
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}
function parseAttemptToken(token) {
  try {
    const raw = Buffer.from(token.trim(), "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.schema === "kxm.attempt-token.v1" && typeof parsed.runId === "string") {
      return parsed;
    }
  } catch {
    return void 0;
  }
  return void 0;
}
function timingSafeStringCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const hashA = createHash2("sha256").update(a).digest();
  const hashB = createHash2("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}
function mintSessionToken(input) {
  const toolPolicy = input?.toolPolicy ?? (input?.allowedTools || input?.deniedTools || input?.preset ? {
    ...input?.preset ? { preset: input.preset } : {},
    ...input?.allowedTools ? { allow: input.allowedTools, allowedTools: input.allowedTools } : {},
    ...input?.deniedTools ? { deny: input.deniedTools, deniedTools: input.deniedTools } : {}
  } : void 0);
  const issuedAt = (/* @__PURE__ */ new Date()).toISOString();
  const defaultTtlMs = 24 * 60 * 60 * 1e3;
  const ttlMs = typeof input?.ttlMs === "number" && input.ttlMs > 0 ? input.ttlMs : defaultTtlMs;
  const expiresAt = input?.expiresAt ?? new Date(Date.now() + ttlMs).toISOString();
  const payload = {
    schema: "kxm.session-token.v1",
    sessionId: input?.sessionId ?? `session-${randomUUID2()}`,
    issuedAt,
    expiresAt,
    ...input?.agentName ? { agentName: input.agentName } : {},
    ...toolPolicy ? { toolPolicy } : {}
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}
function isSessionTokenExpired(payloadOrToken) {
  let payload;
  if (typeof payloadOrToken === "string") {
    try {
      const raw = Buffer.from(payloadOrToken.trim(), "base64url").toString("utf8");
      payload = JSON.parse(raw);
    } catch {
      return true;
    }
  } else {
    payload = payloadOrToken;
  }
  if (!payload || !payload.expiresAt) return false;
  const expiryTime = new Date(payload.expiresAt).getTime();
  if (Number.isNaN(expiryTime)) return true;
  return Date.now() >= expiryTime;
}
function parseSessionToken(token) {
  try {
    const raw = Buffer.from(token.trim(), "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.schema === "kxm.session-token.v1" && typeof parsed.sessionId === "string") {
      if (parsed.expiresAt) {
        const expiryTime = new Date(parsed.expiresAt).getTime();
        if (!Number.isNaN(expiryTime) && Date.now() >= expiryTime) {
          return void 0;
        }
      }
      return parsed;
    }
  } catch {
    return void 0;
  }
  return void 0;
}
function resolveUserConfigDirectory(overrideDir) {
  if (overrideDir) return resolve(overrideDir);
  return resolve(process.env.KXM_USER_CONFIG_DIR?.trim() || join(homedir(), ".config", "kxm"));
}
function sessionTokenPath(userConfigDir) {
  return join(resolveUserConfigDirectory(userConfigDir), "session.token");
}
function persistSessionTokenToDisk(token, options) {
  const filePath = sessionTokenPath(options?.userConfigDir);
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 448 });
  const mode = options?.mode ?? 384;
  writeFileSync(filePath, `${token.trim()}
`, { encoding: "utf8", mode });
  try {
    chmodSync(filePath, mode);
  } catch {
  }
  return filePath;
}
function readSessionTokenFromDisk(options) {
  const filePath = sessionTokenPath(options?.userConfigDir);
  if (!existsSync(filePath)) return void 0;
  try {
    const token = readFileSync(filePath, "utf8").trim();
    if (!token) return void 0;
    const payload = parseSessionToken(token);
    if (!payload) return void 0;
    return { token, payload };
  } catch {
    return void 0;
  }
}
function clearSessionTokenFromDisk(options) {
  const filePath = sessionTokenPath(options?.userConfigDir);
  if (!existsSync(filePath)) return false;
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}
function matchToolPattern(pattern, toolName) {
  if (pattern === "*" || pattern === toolName) return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }
  return false;
}
function isToolAllowed(commandName, policy) {
  if (!policy) return true;
  const canonical = commandName.startsWith("kxm_") ? commandName : `kxm_${commandName}`;
  const bare = commandName.replace(/^kxm_/, "");
  const denyList = policy.deny ?? policy.deniedTools;
  if (Array.isArray(denyList)) {
    for (const d of denyList) {
      if (d === canonical || d === commandName || d === bare || matchToolPattern(d, canonical)) {
        return false;
      }
    }
  }
  const allowList = policy.allow ?? policy.allowedTools;
  if (Array.isArray(allowList) && allowList.length > 0) {
    const matched = allowList.some(
      (a) => a === canonical || a === commandName || a === bare || a === "*" || matchToolPattern(a, canonical)
    );
    if (!matched) return false;
  }
  if (policy.preset === "read-only") {
    const mutating = [
      "kxm_send",
      "kxm_reply",
      "kxm_cancel",
      "kxm_fanout",
      "kxm_workflow_checkpoint",
      "kxm_workflow_record",
      "kxm_workflow_wait",
      "kxm_promote"
    ];
    if (mutating.includes(canonical)) return false;
  }
  return true;
}
function enforceToolPolicy(commandName, env = process.env, options) {
  const attemptTokenRaw = env.KXM_ATTEMPT_TOKEN?.trim();
  if (attemptTokenRaw) {
    const attempt = parseAttemptToken(attemptTokenRaw);
    if (!attempt) {
      return { allowed: false, error: "attempt_token_invalid", detail: "KXM_ATTEMPT_TOKEN is malformed" };
    }
    if (!isToolAllowed(commandName, attempt.toolPolicy)) {
      return {
        allowed: false,
        error: "tool_policy_denied",
        detail: `command ${commandName} is denied by attempt tool policy`
      };
    }
    if (commandName === "kxm_promote" || commandName === "promote") {
      const explicitAllow = attempt.toolPolicy?.allow ?? attempt.toolPolicy?.allowedTools;
      if (!Array.isArray(explicitAllow) || !explicitAllow.includes("kxm_promote") && !explicitAllow.includes("promote") && !explicitAllow.includes("*")) {
        return {
          allowed: false,
          error: "attempt_token_admin_denied",
          detail: "AttemptToken worker cannot perform operator state promotion without explicit policy grant"
        };
      }
    }
    if (options?.runId && attempt.runId && options.runId !== attempt.runId) {
      return {
        allowed: false,
        error: "attempt_token_scope_violation",
        detail: `attempt token runId ${attempt.runId} does not match request runId ${options.runId}`
      };
    }
    return { allowed: true };
  }
  const envSessionRaw = env.KXM_SESSION_TOKEN?.trim();
  if (envSessionRaw) {
    const session = parseSessionToken(envSessionRaw);
    if (!session) {
      return { allowed: false, error: "session_token_invalid", detail: "KXM_SESSION_TOKEN is malformed or expired" };
    }
    if (!isToolAllowed(commandName, session.toolPolicy)) {
      return {
        allowed: false,
        error: "tool_policy_denied",
        detail: `command ${commandName} is denied by session tool policy`
      };
    }
    return { allowed: true };
  }
  const tokenFile = sessionTokenPath(env.KXM_USER_CONFIG_DIR);
  if (existsSync(tokenFile)) {
    let tokenRaw;
    try {
      tokenRaw = readFileSync(tokenFile, "utf8").trim();
    } catch {
      return { allowed: false, error: "session_token_invalid", detail: "Session token file on disk could not be read" };
    }
    const session = tokenRaw ? parseSessionToken(tokenRaw) : void 0;
    if (!session) {
      return { allowed: false, error: "session_token_invalid", detail: "Session token on disk is malformed or expired" };
    }
    if (!isToolAllowed(commandName, session.toolPolicy)) {
      return {
        allowed: false,
        error: "tool_policy_denied",
        detail: `command ${commandName} is denied by session tool policy`
      };
    }
    return { allowed: true };
  }
  return { allowed: true };
}

// plugins/kxm/src/logger.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, renameSync, statSync, unlinkSync as unlinkSync2 } from "node:fs";
import { dirname as dirname2 } from "node:path";
var LOG_LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
var DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
var DEFAULT_LOG_MAX_FILES = 3;
var SENSITIVE_KEY_PATTERN = /(?:^|_)(?:token|secret|password|apiKey|api_key|authorization|bearer)(?:$|_)/i;
var ALLOWED_EXACT_KEYS = /* @__PURE__ */ new Set(["auth", "authType", "authMethod", "authArgs", "canUpdate", "status"]);
function redactLogValue(val, key) {
  if (val === null || val === void 0) return val;
  if (typeof val === "string") {
    if (key && SENSITIVE_KEY_PATTERN.test(key) && !ALLOWED_EXACT_KEYS.has(key)) {
      return "[redacted]";
    }
    return redactSecrets(val);
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => redactLogValue(item, key));
  }
  if (typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = redactLogValue(v, k);
    }
    return out;
  }
  return String(val);
}
function rotateLogFiles(filePath, maxFiles) {
  for (let i = maxFiles; i >= 1; i--) {
    const current = `${filePath}.${i}`;
    if (existsSync2(current)) {
      if (i >= maxFiles) {
        try {
          unlinkSync2(current);
        } catch {
        }
      } else {
        try {
          renameSync(current, `${filePath}.${i + 1}`);
        } catch {
        }
      }
    }
  }
  if (existsSync2(filePath)) {
    try {
      renameSync(filePath, `${filePath}.1`);
    } catch {
    }
  }
}
function createLogger(options) {
  const component = options.component;
  const filePath = options.path;
  const maxBytes = Math.max(100, options.maxBytes ?? DEFAULT_LOG_MAX_BYTES);
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_LOG_MAX_FILES);
  const configuredLevel = options.level ?? "info";
  const isDaemon = Boolean(options.daemon ?? (process.env.KXM_DAEMON === "1" || process.env.KXM_DAEMON === "true"));
  const shouldStdout = options.stdout ?? !isDaemon;
  const correlationDefaults = options.correlation ?? {};
  let currentSize = 0;
  if (filePath && existsSync2(filePath)) {
    try {
      currentSize = statSync(filePath).size;
    } catch {
      currentSize = 0;
    }
  }
  function emit(level, entryOrEvent, extra) {
    const minPriority = LOG_LEVEL_PRIORITY[configuredLevel] ?? LOG_LEVEL_PRIORITY.info;
    const currentPriority = LOG_LEVEL_PRIORITY[level] ?? LOG_LEVEL_PRIORITY.info;
    if (currentPriority < minPriority) return;
    let base;
    if (typeof entryOrEvent === "string") {
      base = { event: entryOrEvent, ...extra };
    } else {
      base = { ...entryOrEvent, ...extra };
    }
    const timestamp = typeof base.timestamp === "string" ? base.timestamp : (/* @__PURE__ */ new Date()).toISOString();
    delete base.timestamp;
    delete base.level;
    delete base.component;
    const payload = {
      timestamp,
      level,
      component,
      ...correlationDefaults,
      ...base
    };
    const sanitized = redactLogValue(payload);
    const line = `${JSON.stringify(sanitized)}
`;
    if (filePath) {
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (currentSize + lineBytes > maxBytes) {
        rotateLogFiles(filePath, maxFiles);
        currentSize = 0;
      }
      try {
        mkdirSync2(dirname2(filePath), { recursive: true });
        appendFileSync(filePath, line, { encoding: "utf8", mode: 384 });
        currentSize += lineBytes;
      } catch {
      }
    }
    if (shouldStdout) {
      process.stdout.write(line);
    }
  }
  const logFn = ((entryOrEvent, extra) => {
    let lvl = "info";
    if (typeof entryOrEvent === "object" && entryOrEvent !== null && typeof entryOrEvent.level === "string") {
      const candidate = entryOrEvent.level.toLowerCase();
      if (candidate === "debug" || candidate === "info" || candidate === "warn" || candidate === "error") {
        lvl = candidate;
      }
    }
    emit(lvl, entryOrEvent, extra);
  });
  logFn.info = (entryOrEvent, extra) => emit("info", entryOrEvent, extra);
  logFn.warn = (entryOrEvent, extra) => emit("warn", entryOrEvent, extra);
  logFn.error = (entryOrEvent, extra) => emit("error", entryOrEvent, extra);
  logFn.debug = (entryOrEvent, extra) => emit("debug", entryOrEvent, extra);
  logFn.child = (sub) => {
    return createLogger({
      ...options,
      component: sub.component ? `${component}.${sub.component}` : component,
      correlation: { ...correlationDefaults, ...sub.correlation }
    });
  };
  logFn.close = () => {
  };
  Object.defineProperty(logFn, "options", {
    value: Object.freeze({ ...options }),
    writable: false,
    enumerable: true
  });
  return logFn;
}
export {
  AGENT_COMMANDS,
  AGENT_COMMANDS_MAP,
  BEHAVIORAL_HASH_VERSION,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_LOG_MAX_FILES,
  DEFAULT_MAX_HOPS,
  DEFAULT_MESSAGE_RETENTION_MS,
  DEFAULT_MESSAGE_TTL_MS,
  DEFAULT_PORT,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_STALE_AFTER_MS,
  LOG_LEVEL_PRIORITY,
  MAX_AGENT_HOST_CHARS,
  MAX_BODY_BYTES,
  MAX_CONTENT_CHARS,
  MAX_CONTEXT_ITEM_IDS,
  MAX_LEASE_RESOURCE_CHARS,
  MAX_LEASE_TTL_MS,
  MAX_MESSAGE_TTL_MS,
  MAX_PROVIDER_METADATA_FIELDS,
  MAX_SKILL_REFS,
  MAX_SYNC_BATCH_EVENTS,
  MIN_LEASE_TTL_MS,
  MIN_MESSAGE_RETENTION_MS,
  MIN_MESSAGE_TTL_MS,
  ProtocolError,
  ROUTING_RECORD_SCHEMA,
  ROUTING_RECORD_V2_SCHEMA,
  ROUTING_REPORT_SCHEMA,
  TERMINAL_RECEIPT_SCHEMA,
  WORKER_RESULT_SCHEMA,
  WORKER_SCHEMA,
  agentPresenceView,
  agentWorker,
  behavioralConfigHash,
  clearSessionTokenFromDisk,
  compareRoutingRecords,
  computeDecayedWeight,
  createLogger,
  enforceToolPolicy,
  evaluateCircuitBreaker,
  formatRoutingReport,
  gateWorker,
  generateRoutingReport,
  getCliAgentCommands,
  getMcpTools,
  getPiToolDefinitions,
  groupByBehavior,
  isQuotaExhausted,
  isSessionTokenExpired,
  isToolAllowed,
  looksLikeSecret,
  mintAttemptToken,
  mintSessionToken,
  newId,
  nowIso,
  optionalString,
  parseAttemptToken,
  parseBoundedInteger,
  parseDeliveryMode,
  parseRoutingRecord,
  parseRoutingRecordV2,
  parseSessionToken,
  persistSessionTokenToDisk,
  readSessionTokenFromDisk,
  reconcileInbox,
  redactLogValue,
  redactSecrets,
  redactStringList,
  requireString,
  rotateLogFiles,
  sessionTokenPath,
  timingSafeStringCompare,
  toAgentRecord,
  validateTerminalReceipt,
  workerResult
};

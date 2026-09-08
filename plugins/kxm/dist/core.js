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

// plugins/kxm/src/routing.ts
import { createHash } from "node:crypto";
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
  if (input.agentRole !== void 0 && input.agentRole !== null) {
    record.agentRole = boundedString(input.agentRole, "agentRole", 64);
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
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\bKXM_[A-Z0-9_]*(TOKEN|SECRET|KEY)[A-Z0-9_]*=\S+/gi,
  /\b(GITHUB_TOKEN|GH_TOKEN|KXM_AUTH_TOKEN|KXM_WORKFLOW_SIGNAL_SECRET)=\S+/gi,
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
export {
  BEHAVIORAL_HASH_VERSION,
  DEFAULT_MAX_HOPS,
  DEFAULT_MESSAGE_RETENTION_MS,
  DEFAULT_MESSAGE_TTL_MS,
  DEFAULT_PORT,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_STALE_AFTER_MS,
  MAX_BODY_BYTES,
  MAX_CONTENT_CHARS,
  MAX_CONTEXT_ITEM_IDS,
  MAX_MESSAGE_TTL_MS,
  MAX_PROVIDER_METADATA_FIELDS,
  MAX_SKILL_REFS,
  MIN_MESSAGE_RETENTION_MS,
  MIN_MESSAGE_TTL_MS,
  ProtocolError,
  ROUTING_RECORD_SCHEMA,
  ROUTING_RECORD_V2_SCHEMA,
  WORKER_RESULT_SCHEMA,
  WORKER_SCHEMA,
  agentWorker,
  behavioralConfigHash,
  compareRoutingRecords,
  gateWorker,
  groupByBehavior,
  looksLikeSecret,
  newId,
  nowIso,
  optionalString,
  parseBoundedInteger,
  parseDeliveryMode,
  parseRoutingRecord,
  parseRoutingRecordV2,
  redactSecrets,
  redactStringList,
  requireString,
  workerResult
};

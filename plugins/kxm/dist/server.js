#!/usr/bin/env node

// plugins/kxm/src/hub.ts
import { createHash as createHash2, createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";

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

// plugins/kxm/src/diagnostics.ts
function workflowScopeExtras(operation, assignedCoordinatorName) {
  return {
    operation,
    assignedCoordinatorName,
    nextAction: "use_assigned_coordinator"
  };
}

// plugins/kxm/src/context.ts
var MAX_CONTEXT_SUMMARY_CHARS = 4e3;
var MAX_CONTEXT_ID_REFS = 64;
var MAX_CONTEXT_ITEMS = 256;
var MIN_CONTEXT_BUDGET_TOKENS = 512;
var MAX_CONTEXT_BUDGET_TOKENS = 2e5;
var DEFAULT_CONTEXT_BUDGET_TOKENS = 32e3;
var MAX_CONTEXT_ROLE_CHARS = 64;
var MAX_CONTEXT_TASK_CHARS = 2e3;
var AUTHORITY_GRANT_FLOOR = {
  human: "policy",
  workflow: "policy",
  git: "instruction",
  peer: "evidence",
  tool: "evidence",
  external: "evidence",
  derived: "evidence"
};
function authorityGrantFloor(sourceType) {
  return AUTHORITY_GRANT_FLOOR[sourceType];
}
var RESERVED_CONTROL_PLANE_FIELDS = /* @__PURE__ */ new Set([
  "permissions",
  "tools",
  "allow",
  "deny",
  "grants",
  "approval",
  "policy",
  "scopes",
  "credentials",
  "secrets",
  "token",
  "apiKey",
  "password"
]);
var CONTEXT_ITEM_KINDS = ["evidence", "state", "episode", "knowledge", "skill"];
var CONTEXT_SOURCE_TYPES = [
  "human",
  "git",
  "workflow",
  "tool",
  "peer",
  "external",
  "derived"
];
var CONTEXT_AUTHORITIES = ["policy", "instruction", "evidence", "hypothesis"];
var CONTEXT_CONFIDENCES = ["verified", "probable", "uncertain"];
function oneOf(value, field, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ProtocolError(400, `${field} must be one of ${allowed.join(", ")}`, "invalid_context_field");
  }
  return value;
}
function idRefs(value, field, required = false) {
  if (value === void 0 || value === null) return required ? [] : void 0;
  if (!Array.isArray(value)) {
    throw new ProtocolError(400, `${field} must be an array of identifiers`, "invalid_context_field");
  }
  if (value.length > MAX_CONTEXT_ID_REFS) {
    throw new ProtocolError(
      400,
      `${field} exceeds ${MAX_CONTEXT_ID_REFS} references`,
      "context_limits_exceeded"
    );
  }
  const seen = /* @__PURE__ */ new Set();
  const refs = [];
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
function optionalIsoTimestamp(value, field) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ProtocolError(400, `${field} must be an ISO-8601 timestamp`, "invalid_context_field");
  }
  return value;
}
function parseContextItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "context item must be an object", "invalid_context_item");
  }
  const input = value;
  for (const field of Object.keys(input)) {
    if (RESERVED_CONTROL_PLANE_FIELDS.has(field)) {
      throw new ProtocolError(
        403,
        `context items may not carry control-plane field "${field}"`,
        "context_authority_violation"
      );
    }
  }
  const item = {
    id: requireString(input.id, "context item id", { max: 128 }),
    kind: oneOf(input.kind, "context item kind", CONTEXT_ITEM_KINDS),
    project: requireString(input.project, "context item project", { max: 200 }),
    summary: requireString(input.summary, "context item summary", { max: MAX_CONTEXT_SUMMARY_CHARS }),
    provenance: parseContextProvenance(input.provenance),
    authority: oneOf(input.authority, "context item authority", CONTEXT_AUTHORITIES),
    confidence: oneOf(input.confidence, "context item confidence", CONTEXT_CONFIDENCES)
  };
  const observedAt = optionalIsoTimestamp(input.observedAt, "context item observedAt");
  const validFrom = optionalIsoTimestamp(input.validFrom, "context item validFrom");
  const validUntil = optionalIsoTimestamp(input.validUntil, "context item validUntil");
  if (observedAt !== void 0) item.observedAt = observedAt;
  if (validFrom !== void 0) item.validFrom = validFrom;
  if (validUntil !== void 0) item.validUntil = validUntil;
  if (input.status !== void 0 && input.status !== null) {
    item.status = oneOf(input.status, "context item status", ["current", "superseded", "proposed", "rejected"]);
  }
  const supersedes = idRefs(input.supersedes, "context item supersedes");
  if (supersedes !== void 0) {
    if (supersedes.includes(item.id)) {
      throw new ProtocolError(400, "context item cannot supersede itself", "invalid_context_item");
    }
    item.supersedes = supersedes;
  }
  const evidenceRefs = idRefs(input.evidenceRefs, "context item evidenceRefs");
  if (evidenceRefs !== void 0) item.evidenceRefs = evidenceRefs;
  const stateKey = input.stateKey === void 0 || input.stateKey === null ? void 0 : requireString(input.stateKey, "context item stateKey", { max: 200 });
  if (stateKey !== void 0) item.stateKey = stateKey;
  if (item.kind === "state" && item.stateKey === void 0) {
    throw new ProtocolError(400, "state items require a stateKey", "invalid_context_item");
  }
  if (item.kind === "state" && item.status === void 0) {
    throw new ProtocolError(400, "state items require an explicit lifecycle status", "invalid_context_item");
  }
  const grantFloor = authorityRank(authorityGrantFloor(item.provenance.sourceType));
  if (authorityRank(item.authority) > grantFloor) {
    throw new ProtocolError(
      403,
      `content of origin ${item.provenance.sourceType} cannot claim ${item.authority} authority`,
      "context_authority_violation"
    );
  }
  return item;
}
function parseContextProvenance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "context provenance must be an object", "invalid_context_item");
  }
  const input = value;
  const provenance = {
    sourceType: oneOf(input.sourceType, "context provenance sourceType", CONTEXT_SOURCE_TYPES)
  };
  const sourceRef = input.sourceRef === void 0 || input.sourceRef === null ? void 0 : requireString(input.sourceRef, "context provenance sourceRef", { max: 512 });
  if (sourceRef !== void 0) provenance.sourceRef = sourceRef;
  const derivedFrom = idRefs(input.derivedFrom, "context provenance derivedFrom");
  if (derivedFrom !== void 0) provenance.derivedFrom = derivedFrom;
  return provenance;
}
function parseContextRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "context request must be an object", "invalid_context_request");
  }
  const input = value;
  const request = {
    project: requireString(input.project, "context request project", { max: 200 }),
    role: requireString(input.role, "context request role", { max: MAX_CONTEXT_ROLE_CHARS }),
    task: requireString(input.task, "context request task", { max: MAX_CONTEXT_TASK_CHARS })
  };
  const workflowRunId = input.workflowRunId === void 0 || input.workflowRunId === null ? void 0 : requireString(input.workflowRunId, "context request workflowRunId", { max: 128 });
  if (workflowRunId !== void 0) request.workflowRunId = workflowRunId;
  const stageId = input.stageId === void 0 || input.stageId === null ? void 0 : requireString(input.stageId, "context request stageId", { max: 128 });
  if (stageId !== void 0) request.stageId = stageId;
  if (input.budgetTokens !== void 0 && input.budgetTokens !== null) {
    const budget = input.budgetTokens;
    if (!Number.isInteger(budget) || budget < MIN_CONTEXT_BUDGET_TOKENS || budget > MAX_CONTEXT_BUDGET_TOKENS) {
      throw new ProtocolError(
        400,
        `context request budgetTokens must be an integer between ${MIN_CONTEXT_BUDGET_TOKENS} and ${MAX_CONTEXT_BUDGET_TOKENS}`,
        "invalid_context_request"
      );
    }
    request.budgetTokens = budget;
  }
  if (input.includeKinds !== void 0 && input.includeKinds !== null) {
    if (!Array.isArray(input.includeKinds) || input.includeKinds.length < 1 || input.includeKinds.length > CONTEXT_ITEM_KINDS.length) {
      throw new ProtocolError(
        400,
        "context request includeKinds must be a non-empty array of item kinds",
        "invalid_context_request"
      );
    }
    request.includeKinds = input.includeKinds.map((kind) => oneOf(kind, "context request includeKinds", CONTEXT_ITEM_KINDS));
  }
  return request;
}
function validateContextPacketContents(request, packet) {
  const items = [...packet.currentState, ...packet.knowledge, ...packet.episodes, ...packet.skills, ...packet.contradictions];
  if (items.length > MAX_CONTEXT_ITEMS) {
    throw new ProtocolError(400, `context packet exceeds ${MAX_CONTEXT_ITEMS} items`, "context_limits_exceeded");
  }
  const allowed = request.includeKinds ? new Set(request.includeKinds) : void 0;
  for (const item of items) {
    if (item.project !== request.project) {
      throw new ProtocolError(
        400,
        `context packet contains cross-project item ${item.id}`,
        "context_isolation_violation"
      );
    }
    if (allowed && !allowed.has(item.kind)) {
      throw new ProtocolError(
        400,
        `context packet contains item ${item.id} of unrequested kind ${item.kind}`,
        "context_isolation_violation"
      );
    }
  }
}
function estimateContextTokens(items) {
  let characters = 0;
  for (const item of items) {
    characters += item.summary.length + item.id.length + item.kind.length;
    if (item.provenance.sourceRef) characters += item.provenance.sourceRef.length;
  }
  return Math.ceil(characters / 4);
}
function authorityRank(authority) {
  switch (authority) {
    case "policy":
      return 3;
    case "instruction":
      return 2;
    case "evidence":
      return 1;
    case "hypothesis":
      return 0;
  }
}
function contextItemAuditMetadata(item) {
  const metadata = {
    id: item.id,
    kind: item.kind,
    authority: item.authority,
    confidence: item.confidence,
    sourceType: item.provenance.sourceType,
    derived: item.provenance.sourceType === "derived" || (item.provenance.derivedFrom?.length ?? 0) > 0,
    lineageDepth: item.provenance.derivedFrom?.length ?? 0
  };
  if (item.status !== void 0) metadata.status = item.status;
  if (item.provenance.sourceRef !== void 0) metadata.sourceRef = item.provenance.sourceRef;
  return metadata;
}
function provenanceSummaryOf(items) {
  const summary = {};
  for (const item of items) {
    summary[item.provenance.sourceType] = (summary[item.provenance.sourceType] ?? 0) + 1;
  }
  for (const key of Object.keys(summary).sort()) {
    if (summary[key] === 0) delete summary[key];
  }
  return summary;
}

// plugins/kxm/src/arbiter.ts
var ROLE_POLICIES = [
  {
    role: "repro",
    label: "Reproduction specialist",
    kinds: ["episode", "knowledge"],
    journalCategories: ["error", "lesson", "observation", "contradiction"],
    budgetTokens: 8e3
  },
  {
    role: "planner",
    label: "Planner",
    kinds: ["state", "knowledge", "evidence"],
    journalCategories: ["plan", "decision", "contradiction", "observation", "hypothesis", "experiment"],
    budgetTokens: 16e3
  },
  {
    role: "critic",
    label: "Independent critic",
    kinds: ["knowledge", "evidence", "episode"],
    journalCategories: ["contradiction", "error", "lesson", "experiment"],
    budgetTokens: 12e3
  },
  {
    role: "implementer",
    label: "Implementer",
    kinds: ["knowledge", "state", "skill", "episode"],
    journalCategories: ["plan", "decision", "lesson", "state-change"],
    budgetTokens: 16e3
  },
  {
    role: "verifier",
    label: "Verifier",
    kinds: ["evidence", "knowledge", "episode"],
    journalCategories: ["plan", "error", "lesson", "contradiction"],
    budgetTokens: 8e3
  }
];
function rolePolicy(role) {
  return ROLE_POLICIES.find((policy) => policy.role === role) ?? {
    role,
    label: role,
    kinds: ["knowledge", "evidence"],
    journalCategories: ["lesson", "observation"],
    budgetTokens: DEFAULT_CONTEXT_BUDGET_TOKENS
  };
}
var CONFIDENCE_RANK = { verified: 3, probable: 2, uncertain: 1 };
var AUTHORITY_WEIGHT = { policy: 3, instruction: 2, evidence: 1, hypothesis: 0 };
function arbitrate(requestInput, pool, options = {}) {
  const request = parseContextRequest(requestInput);
  const policy = rolePolicy(request.role);
  const budget = request.budgetTokens ?? policy.budgetTokens;
  const contradictions = new Set(options.contradictionIds ?? []);
  const candidates = [];
  let excludedSuperseded = 0;
  for (const candidate of pool) {
    if (candidate.project !== request.project) {
      throw new ProtocolError(
        403,
        `context pool contains cross-project item ${candidate.id}`,
        "context_isolation_violation"
      );
    }
    if (candidate.status === "superseded" || candidate.status === "rejected") {
      excludedSuperseded += 1;
      continue;
    }
    candidates.push(candidate);
  }
  const kindRank = /* @__PURE__ */ new Map();
  const requestedKinds = request.includeKinds ?? policy.kinds;
  requestedKinds.forEach((kind, index) => kindRank.set(kind, index));
  const kindPreference = (item) => {
    const rank = kindRank.get(item.kind);
    return rank === void 0 ? requestedKinds.length : rank;
  };
  const ordered = [...candidates].sort(
    (left, right) => (contradictions.has(right.id) ? 1 : 0) - (contradictions.has(left.id) ? 1 : 0) || kindPreference(left) - kindPreference(right) || CONFIDENCE_RANK[right.confidence] - CONFIDENCE_RANK[left.confidence] || AUTHORITY_WEIGHT[right.authority] - AUTHORITY_WEIGHT[left.authority] || left.id.localeCompare(right.id)
  );
  const kindAllowed = (item) => (request.includeKinds ?? policy.kinds).includes(item.kind) || contradictions.has(item.id);
  const selected = [];
  const unresolvedGaps = [];
  for (const item of ordered) {
    if (selected.length >= MAX_CONTEXT_ITEMS) {
      unresolvedGaps.push("context item limit reached; refine the task or kinds");
      break;
    }
    if (!kindAllowed(item)) continue;
    const nextTokens = estimateContextTokens([...selected, item]);
    if (nextTokens > budget) {
      if (selected.length === 0) {
        unresolvedGaps.push(`budget of ${budget} tokens cannot fit any selected context`);
        break;
      }
      unresolvedGaps.push(`budget of ${budget} tokens reached; ${ordered.length - selected.length} candidates deferred`);
      break;
    }
    selected.push(item);
  }
  if (candidates.length === 0) {
    unresolvedGaps.push("no context records exist for this project yet");
  }
  const bySection = (kind) => selected.filter((item) => item.kind === kind && !contradictions.has(item.id));
  const packet = {
    workingState: options.workingState ?? {},
    currentState: bySection("state").filter((item) => item.status === "current" || item.status === void 0),
    knowledge: bySection("knowledge"),
    episodes: bySection("episode"),
    skills: bySection("skill"),
    contradictions: selected.filter((item) => contradictions.has(item.id)),
    unresolvedGaps,
    provenanceSummary: provenanceSummaryOf(selected),
    estimatedTokens: estimateContextTokens(selected)
  };
  validateContextPacketContents(request, packet);
  return {
    packet,
    audit: {
      request: {
        project: request.project,
        role: request.role,
        task: request.task,
        ...request.workflowRunId !== void 0 ? { workflowRunId: request.workflowRunId } : {},
        ...request.stageId !== void 0 ? { stageId: request.stageId } : {}
      },
      selectedIds: selected.map((item) => item.id),
      provenanceSummary: packet.provenanceSummary,
      estimatedTokens: packet.estimatedTokens,
      budgetTokens: budget,
      candidateCount: candidates.length,
      excludedSuperseded,
      unresolvedGaps
    }
  };
}
function journalEntryToContextItem(entry, project) {
  const kind = entry.category === "plan" || entry.category === "decision" || entry.category === "lesson" ? "knowledge" : entry.category === "skill-candidate" ? "skill" : "evidence";
  const item = {
    id: `journal_${entry.id}`,
    kind,
    project,
    summary: entry.summary,
    provenance: {
      sourceType: "workflow",
      sourceRef: `journal:${entry.id}`
    },
    authority: entry.category === "decision" || entry.category === "plan" ? "evidence" : "evidence",
    confidence: entry.severity === "error" ? "probable" : "probable",
    ...entry.stageId !== void 0 ? { observedAt: entry.createdAt } : {},
    evidenceRefs: entry.evidence.filter((ref) => ref.length > 0 && ref.length <= 200).slice(0, 16)
  };
  if (entry.stageId !== void 0) item.observedAt = entry.createdAt;
  if (kind === "skill") item.status = "proposed";
  return parseContextItem(item);
}
function explainContextItem(id, pool) {
  const byId = new Map(pool.map((item2) => [item2.id, item2]));
  const item = byId.get(id);
  if (!item) return { item: void 0, lineage: [], evidenceRefs: [], sources: [] };
  const lineage = [];
  const queue = [...item.provenance.derivedFrom ?? []];
  const seen = /* @__PURE__ */ new Set();
  while (queue.length > 0) {
    const ancestorId = queue.shift();
    if (seen.has(ancestorId)) continue;
    seen.add(ancestorId);
    lineage.push(ancestorId);
    const ancestor = byId.get(ancestorId);
    for (const older of ancestor?.provenance.derivedFrom ?? []) queue.push(older);
  }
  lineage.sort();
  const sources = [item, ...lineage.map((ancestorId) => byId.get(ancestorId))].filter((candidate) => candidate !== void 0).map((candidate) => ({
    id: candidate.id,
    sourceType: candidate.provenance.sourceType,
    ...candidate.provenance.sourceRef !== void 0 ? { sourceRef: candidate.provenance.sourceRef } : {}
  }));
  return {
    item,
    lineage,
    evidenceRefs: item.evidenceRefs ?? [],
    sources
  };
}

// plugins/kxm/src/state.ts
var MAX_STATE_EVIDENCE_REFS = 32;
function timestampMs(value) {
  if (value === void 0) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
function stateActiveAt(item, atMs) {
  if (item.kind !== "state") return false;
  if (item.status !== "current" && item.status !== "superseded") return false;
  const from = timestampMs(item.validFrom);
  const until = item.validUntil === void 0 ? Number.POSITIVE_INFINITY : timestampMs(item.validUntil);
  return from <= atMs && atMs < until;
}
function latestActive(items) {
  let best;
  for (const item of items) {
    if (best === void 0 || timestampMs(item.validFrom) > timestampMs(best.validFrom) || timestampMs(item.validFrom) === timestampMs(best.validFrom) && item.id > best.id) {
      best = item;
    }
  }
  return best;
}
function findSuperseder(items, id) {
  return items.find((item) => (item.supersedes ?? []).includes(id));
}
function detectStateContradictions(project, items, setValuedKeys = /* @__PURE__ */ new Set()) {
  const byKey = /* @__PURE__ */ new Map();
  for (const item of items) {
    if (item.kind !== "state" || item.project !== project) continue;
    const key = item.stateKey ?? "";
    const bucket = byKey.get(key) ?? [];
    bucket.push(item);
    byKey.set(key, bucket);
  }
  const contradictions = [];
  for (const [stateKey, bucket] of [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (setValuedKeys.has(stateKey)) continue;
    const competingCurrentIds = bucket.filter((item) => item.status === "current").map((item) => item.id).sort();
    const competingProposalIds = bucket.filter((item) => item.status === "proposed").map((item) => item.id).sort();
    if (competingCurrentIds.length > 1 || competingProposalIds.length > 1) {
      contradictions.push({ project, stateKey, competingCurrentIds, competingProposalIds });
    }
  }
  return contradictions;
}
function parseStateItem(value) {
  const item = parseContextItem(value);
  if (item.kind !== "state") {
    throw new ProtocolError(400, "state layer accepts only state items", "invalid_state_item");
  }
  return item;
}
var NativeStateProvider = class {
  name = "native-sqlite";
  store;
  now;
  setValuedKeys;
  constructor(store, options = {}) {
    this.store = store;
    this.now = options.now ?? nowIso;
    this.setValuedKeys = options.setValuedKeys ?? /* @__PURE__ */ new Set();
  }
  projectState(project) {
    return this.store.listContextItems(project, ["state"]);
  }
  itemsForKey(project, key) {
    return this.projectState(project).filter((item) => item.stateKey === key);
  }
  /** Current value for a key at a point in time. Superseded values never
   * appear as current: historical queries return the item that *was* current
   * at `asOf` via its validity window. Fails closed when a single-valued key
   * holds competing current items. */
  async get(project, key, asOf) {
    const scopedProject = requireNonEmpty(project, "project");
    const scopedKey = requireNonEmpty(key, "key");
    if (this.setValuedKeys.has(scopedKey)) {
      throw new ProtocolError(
        400,
        `state key ${scopedKey} is set-valued; use currentSet`,
        "state_key_set_valued"
      );
    }
    const atMs = asOf === void 0 ? Date.parse(this.now()) : requireIso(asOf, "asOf");
    const active = this.itemsForKey(scopedProject, scopedKey).filter((item) => stateActiveAt(item, atMs));
    const currents = active.filter((item) => item.status === "current");
    if (currents.length > 1) {
      throw new ProtocolError(
        409,
        `state key ${scopedKey} has competing current items; resolve the contradiction first`,
        "state_contradiction"
      );
    }
    const winner = currents.length === 1 ? currents[0] : latestActive(active);
    return winner ?? null;
  }
  /** All current items for a set-valued key. */
  async currentSet(project, key) {
    const scopedProject = requireNonEmpty(project, "project");
    const scopedKey = requireNonEmpty(key, "key");
    if (!this.setValuedKeys.has(scopedKey)) {
      throw new ProtocolError(400, `state key ${scopedKey} is single-valued`, "state_key_single_valued");
    }
    return this.itemsForKey(scopedProject, scopedKey).filter((item) => item.status === "current").sort((left, right) => left.id.localeCompare(right.id));
  }
  /** Record a proposal. Proposing changes nothing until an authorized,
   * evidence-bound promotion runs. Returns the durable proposal item ID. */
  async propose(change) {
    if (change?.schema !== "kxm.state-change-proposal.v1") {
      throw new ProtocolError(400, "invalid state change proposal schema", "invalid_state_proposal");
    }
    const project = requireNonEmpty(change.project, "proposal project");
    const key = requireNonEmpty(change.key, "proposal key");
    const evidenceRefs = boundedRefs(change.evidenceRefs, "proposal evidenceRefs");
    const proposal = parseStateItem({
      id: newId("ctx"),
      kind: "state",
      project,
      summary: change.summary,
      provenance: {
        sourceType: change.proposedBy.startsWith("agent_") ? "peer" : "human",
        sourceRef: `proposed-by:${change.proposedBy}`
      },
      authority: change.authority,
      confidence: change.confidence,
      stateKey: key,
      status: "proposed",
      validFrom: this.now(),
      evidenceRefs,
      ...change.supersedes ? { supersedes: boundedRefs(change.supersedes, "proposal supersedes") } : {}
    });
    this.store.saveContextItem(proposal);
    return proposal.id;
  }
  /** Promote a proposal to current with durable evidence. The promoter must
   * differ from the proposal author (agents may propose but never silently
   * promote). Superseded previous values get an explicit validity window so
   * historical queries stay deterministic. */
  async promote(proposalId, evidence, promotedBy) {
    const id = requireNonEmpty(proposalId, "proposalId");
    const promoter = requireNonEmpty(promotedBy, "promotedBy");
    const evidenceRefs = boundedRefs(evidence, "promotion evidence");
    const proposal = this.store.getContextItem(id);
    if (!proposal || proposal.kind !== "state") {
      throw new ProtocolError(404, `state proposal ${id} not found`, "state_proposal_not_found");
    }
    if (proposal.status !== "proposed") {
      throw new ProtocolError(
        400,
        `state proposal ${id} already reached lifecycle state ${proposal.status}`,
        "state_proposal_not_promotable"
      );
    }
    const proposedBy = proposal.provenance.sourceRef?.startsWith("proposed-by:") ? proposal.provenance.sourceRef.slice("proposed-by:".length) : void 0;
    if (proposedBy === promoter) {
      throw new ProtocolError(
        400,
        "the author of a state proposal cannot promote it",
        "state_promotion_invalid"
      );
    }
    const now = this.now();
    const key = proposal.stateKey ?? "";
    if (!key) {
      throw new ProtocolError(400, "state proposal has no stateKey", "state_promotion_invalid");
    }
    let supersededIds = [];
    if (!this.setValuedKeys.has(key)) {
      const atMs = Date.parse(now);
      const supersededItems = this.itemsForKey(proposal.project, key).filter((item) => item.status === "current" && stateActiveAt(item, atMs));
      supersededIds = supersededItems.map((item) => item.id);
      for (const item of supersededItems) {
        this.store.saveContextItem({
          ...item,
          status: "superseded",
          validUntil: now
        });
      }
    }
    const promoted = parseStateItem({
      ...proposal,
      id: newId("ctx"),
      status: "current",
      validFrom: now,
      validUntil: void 0,
      supersedes: [.../* @__PURE__ */ new Set([...proposal.supersedes ?? [], ...supersededIds])].sort(),
      evidenceRefs: [.../* @__PURE__ */ new Set([...proposal.evidenceRefs ?? [], ...evidenceRefs])].sort(),
      provenance: {
        ...proposal.provenance,
        sourceRef: `promoted-by:${promoter}`
      }
    });
    this.store.saveContextItem({ ...proposal, status: "rejected", validUntil: now });
    this.store.saveContextItem(promoted);
    return promoted;
  }
  /** Which item superseded `id`, if any. */
  async supersededBy(project, id) {
    const scopedProject = requireNonEmpty(project, "project");
    const superseder = findSuperseder(this.projectState(scopedProject), id);
    return superseder ?? null;
  }
  /** Audit trail for one key: proposals, promotions, and supersessions in
   * deterministic order. */
  stateHistory(project, key) {
    return this.itemsForKey(project, key).sort(
      (left, right) => timestampMs(left.validFrom) - timestampMs(right.validFrom) || left.id.localeCompare(right.id)
    );
  }
  contradictions() {
    const projects = [...new Set([...this.store.contextItems.values()].map((item) => item.project))];
    return projects.flatMap((project) => detectStateContradictions(project, this.projectState(project), this.setValuedKeys));
  }
};
function requireNonEmpty(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProtocolError(400, `${field} cannot be empty`, "invalid_state_request");
  }
  return value.trim();
}
function requireIso(value, field) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ProtocolError(400, `${field} must be an ISO-8601 timestamp`, "invalid_state_request");
  }
  return parsed;
}
function boundedRefs(value, field) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_STATE_EVIDENCE_REFS) {
    throw new ProtocolError(
      400,
      `${field} must contain between 1 and ${MAX_STATE_EVIDENCE_REFS} references`,
      "state_promotion_invalid"
    );
  }
  return value.map((ref) => requireNonEmpty(ref, `${field} entry`));
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
function redactStringList(values, maxItems = 32) {
  return values.slice(0, maxItems).map((value) => redactSecrets(value).slice(0, 500));
}

// plugins/kxm/src/wiki.ts
var WIKI_ROOT = ".kxm/knowledge/wiki";
var SECTION_BY_KIND = {
  knowledge: "architecture",
  decision: "decisions",
  episode: "incidents",
  skill: "patterns"
};
function wikiSectionFor(item) {
  if (SECTION_BY_KIND[item.kind]) return SECTION_BY_KIND[item.kind];
  if (item.provenance.sourceRef?.startsWith("journal:")) {
    return "incidents";
  }
  return "patterns";
}
function claimLine(item) {
  const refs = [`\`${item.id}\``];
  if (item.provenance.sourceRef) refs.push(`source: \`${item.provenance.sourceRef}\``);
  const lineage = item.provenance.derivedFrom ?? [];
  if (lineage.length > 0) refs.push(`derived from: ${lineage.map((id) => `\`${id}\``).join(", ")}`);
  const authority = item.authority === "policy" || item.authority === "instruction" ? ` (${item.authority})` : "";
  return `- ${redactSecrets(item.summary)}${authority} \u2014 ${refs.join(" \xB7 ")}`;
}
function page(title, heading, claims, footer) {
  const lines = [
    `# ${title}`,
    "",
    heading,
    "",
    ...claims.length > 0 ? claims.map(claimLine) : ["_No reviewed records yet._"],
    "",
    footer
  ];
  return `${lines.join("\n")}
`;
}
var GENERATED_FOOTER = "<!-- generated by kxm context wiki-compile; the wiki is a compiled view, not the authoritative database -->";
function compileKnowledgeWiki(pool) {
  const pages = /* @__PURE__ */ new Map();
  const live = pool.contextItems.filter(
    (item) => item.status !== "superseded" && item.status !== "rejected"
  );
  const superseded = pool.contextItems.filter((item) => item.status === "superseded");
  const sections = /* @__PURE__ */ new Map();
  for (const item of live) {
    const section = wikiSectionFor(item);
    const bucket = sections.get(section) ?? [];
    bucket.push(item);
    sections.set(section, bucket);
  }
  const indexLines = [
    `# ${pool.project} knowledge wiki`,
    "",
    "Compiled synthesis of durable journal evidence, temporal state, and governed records. Every claim links back to its evidence; open contradictions are listed, never silently resolved.",
    ""
  ];
  for (const section of [...sections.keys()].sort()) {
    const items = sections.get(section).sort((left, right) => left.id.localeCompare(right.id));
    const path = `${WIKI_ROOT}/${section}/${pool.project}.md`;
    pages.set(
      path,
      page(
        `${pool.project} \u2014 ${section}`,
        `Claims below are compiled from reviewed records. Each line links the record ID and source.`,
        items,
        GENERATED_FOOTER
      )
    );
    indexLines.push(`- [${section}](${section}/${pool.project}.md) \u2014 ${items.length} claim(s)`);
  }
  const currentState = pool.stateItems.filter((item) => item.status === "current");
  const supersededState = pool.stateItems.filter((item) => item.status === "superseded");
  const statePath = `${WIKI_ROOT}/architecture/${pool.project}-state.md`;
  const stateLines = [
    `# ${pool.project} \u2014 temporal state`,
    "",
    "Rendered from the authoritative state layer. Current values are live; superseded values are kept visible with their validity window and successor link.",
    "",
    "## Current",
    "",
    ...currentState.length > 0 ? currentState.sort((left, right) => (left.stateKey ?? "").localeCompare(right.stateKey ?? "")).map((item) => claimLine(item)) : ["_No current state records._"],
    "",
    "## Superseded",
    "",
    ...supersededState.length > 0 ? supersededState.sort((left, right) => (left.stateKey ?? "").localeCompare(right.stateKey ?? "")).map((item) => claimLine(item)) : ["_No superseded state records._"],
    "",
    GENERATED_FOOTER
  ];
  pages.set(statePath, `${stateLines.join("\n")}
`);
  indexLines.push(`- [temporal state](${pool.project}-state.md) \u2014 ${currentState.length} current, ${supersededState.length} superseded`);
  const decisions = live.filter((item) => item.kind === "knowledge" && item.provenance.sourceRef?.startsWith("journal:") === false);
  if (decisions.length > 0) {
    pages.set(
      `${WIKI_ROOT}/decisions/${pool.project}.md`,
      page(
        `${pool.project} \u2014 decisions`,
        "Decision records with their evidence links.",
        decisions.sort((left, right) => left.id.localeCompare(right.id)),
        GENERATED_FOOTER
      )
    );
    indexLines.push(`- [decisions (tracked records)](decisions/${pool.project}.md) \u2014 ${decisions.length}`);
  }
  const contradictionLines = [
    `# ${pool.project} \u2014 open contradictions`,
    "",
    "These remain unresolved by compilation. Resolution happens through evidence-backed state promotion or journal decisions, never through re-generating this page.",
    ""
  ];
  let contradictionCount = 0;
  for (const contradiction of [...pool.contradictions].sort((left, right) => left.stateKey.localeCompare(right.stateKey))) {
    contradictionCount += 1;
    contradictionLines.push(
      `## \`${contradiction.stateKey}\``,
      "",
      `- Competing current records: ${contradiction.competingCurrentIds.map((id) => `\`${id}\``).join(", ") || "none"}`,
      `- Competing proposals: ${contradiction.competingProposalIds.map((id) => `\`${id}\``).join(", ") || "none"}`,
      ""
    );
  }
  for (const id of [...pool.openContradictionItemIds].sort()) {
    contradictionCount += 1;
    contradictionLines.push(`- Unresolved journal contradiction: \`${id}\``);
  }
  if (contradictionCount === 0) contradictionLines.push("_No open contradictions._");
  contradictionLines.push("", GENERATED_FOOTER);
  pages.set(`${WIKI_ROOT}/contradictions/${pool.project}.md`, `${contradictionLines.join("\n")}
`);
  indexLines.push(`- [contradictions](contradictions/${pool.project}.md) \u2014 ${contradictionCount} open`);
  if (superseded.length > 0) {
    pages.set(
      `${WIKI_ROOT}/incidents/${pool.project}-history.md`,
      page(
        `${pool.project} \u2014 superseded knowledge history`,
        "Superseded records retained for learning. Never presented as current truth.",
        superseded.sort((left, right) => left.id.localeCompare(right.id)),
        GENERATED_FOOTER
      )
    );
    indexLines.push(`- [superseded history](incidents/${pool.project}-history.md) \u2014 ${superseded.length}`);
  }
  indexLines.push("", GENERATED_FOOTER);
  const index = `${indexLines.join("\n")}
`;
  pages.set(`${WIKI_ROOT}/index.md`, index);
  return {
    pages,
    index,
    audit: {
      project: pool.project,
      pages: [...pages.keys()].sort(),
      stateItems: pool.stateItems.length,
      contextItems: pool.contextItems.length,
      contradictions: contradictionCount,
      compiledAt: pool.compiledAt
    }
  };
}
function lintKnowledgeWiki(pages, pool) {
  const issues = [];
  const knownIds = /* @__PURE__ */ new Set([
    ...pool.stateItems.map((item) => item.id),
    ...pool.contextItems.map((item) => item.id)
  ]);
  const index = pages.get(`${WIKI_ROOT}/index.md`);
  for (const [path, content] of pages) {
    if (path.endsWith("index.md")) continue;
    for (const match of content.matchAll(/`((?:ctx|journal)_[A-Za-z0-9_]+)`/g)) {
      const id = match[1];
      if (!knownIds.has(id)) {
        issues.push({ severity: "error", rule: "broken_ref", path, message: `references unknown record ${id}` });
      }
    }
    if (index && !index.includes(path.split("/").pop())) {
      issues.push({ severity: "warning", rule: "orphan_page", path, message: "not linked from index.md" });
    }
    for (const item of pool.stateItems) {
      if (item.status !== "superseded" || !item.stateKey) continue;
      const claimPattern = new RegExp(`Current[\\s\\S]{0,400}\`${item.id}\``, "u");
      if (claimPattern.test(content)) {
        issues.push({
          severity: "error",
          rule: "stale_state_link",
          path,
          message: `renders superseded state item ${item.id} (key ${item.stateKey}) as current`
        });
      }
    }
  }
  const hasContradictions = pool.contradictions.length > 0 || pool.openContradictionItemIds.length > 0;
  if (hasContradictions && index && !index.includes("contradictions")) {
    issues.push({
      severity: "error",
      rule: "unresolved_contradiction",
      path: `${WIKI_ROOT}/index.md`,
      message: "open contradictions exist but the index does not surface them"
    });
  }
  return issues.sort((left, right) => left.path.localeCompare(right.path) || left.message.localeCompare(right.message));
}

// plugins/kxm/src/retrospective.ts
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// plugins/kxm/src/workflow.ts
import { createHash } from "node:crypto";
var JOURNAL_CATEGORIES = [
  "plan",
  "decision",
  "contradiction",
  "error",
  "lesson",
  "observation",
  "hypothesis",
  "experiment",
  "state-change",
  "skill-candidate"
];
var EVIDENCE_REQUIRED_JOURNAL_CATEGORIES = ["lesson", "skill-candidate"];
var PROMOTABLE_JOURNAL_CATEGORIES = ["skill-candidate", "hypothesis", "experiment"];
function parseJournalCategory(value) {
  if (typeof value !== "string" || !JOURNAL_CATEGORIES.includes(value)) {
    throw new ProtocolError(
      400,
      `invalid journal category: must be one of ${JOURNAL_CATEGORIES.join(", ")}`,
      "invalid_journal_category"
    );
  }
  return value;
}
function journalEvidenceRequired(category) {
  return EVIDENCE_REQUIRED_JOURNAL_CATEGORIES.includes(category);
}
var WORKFLOW_TERMINAL_TARGET = "$terminal";
function normalizeOutcomeValue(value, field) {
  if (typeof value === "string") return { target: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a stage ID, "$terminal", or a { target, maxTransitions } rule`);
  }
  const rule = value;
  if (typeof rule.target !== "string" || !rule.target.trim()) {
    throw new Error(`${field}.target must be a non-empty stage ID or "$terminal"`);
  }
  if (rule.maxTransitions !== void 0 && (!Number.isInteger(rule.maxTransitions) || rule.maxTransitions < 1 || rule.maxTransitions > 100)) {
    throw new Error(`${field}.maxTransitions must be an integer between 1 and 100`);
  }
  return { target: rule.target, ...rule.maxTransitions !== void 0 ? { maxTransitions: rule.maxTransitions } : {} };
}
function journalPromotionState(entry) {
  if (!PROMOTABLE_JOURNAL_CATEGORIES.includes(entry.category)) return void 0;
  const records = entry.promotion ?? [];
  return records.length === 0 ? "proposed" : records[records.length - 1]?.to;
}
function applyJournalPromotion(entry, decision, decidedAt) {
  if (!PROMOTABLE_JOURNAL_CATEGORIES.includes(entry.category)) {
    throw new ProtocolError(
      400,
      `journal entries of category ${entry.category} do not participate in promotion`,
      "journal_promotion_invalid"
    );
  }
  if (decision.decidedBy === entry.agentId) {
    throw new ProtocolError(
      400,
      "the author of a journal entry cannot decide its promotion",
      "journal_promotion_invalid"
    );
  }
  if (!Array.isArray(decision.evidenceRefs) || decision.evidenceRefs.length < 1 || decision.evidenceRefs.some((ref) => typeof ref !== "string" || !ref.trim())) {
    throw new ProtocolError(
      400,
      "journal promotion requires at least one durable evidence reference",
      "journal_promotion_invalid"
    );
  }
  const current = journalPromotionState(entry);
  if (current !== "proposed") {
    throw new ProtocolError(
      400,
      `journal entry promotion already reached terminal state ${current}`,
      "journal_promotion_invalid"
    );
  }
  const record = {
    schema: "kxm.journal-promotion.v1",
    from: "proposed",
    to: decision.to,
    evidenceRefs: decision.evidenceRefs.map((ref) => ref.trim()),
    decidedBy: decision.decidedBy,
    reason: decision.reason,
    decidedAt
  };
  return { ...entry, promotion: [...entry.promotion ?? [], record] };
}
function improvementReport(entries) {
  const areas = [
    "harness",
    "gates",
    "implementation",
    "workflow",
    "documentation",
    "security",
    "other"
  ];
  const severityWeight = { error: 3, warning: 2, info: 1 };
  return areas.map((area) => {
    const matching = entries.filter((entry) => entry.area === area);
    const priorities = [...matching].filter((entry) => entry.category === "error" || entry.category === "contradiction" || entry.category === "lesson" || entry.category === "skill-candidate").sort((left, right) => severityWeight[right.severity] - severityWeight[left.severity]).slice(0, 10);
    return {
      area,
      total: matching.length,
      errors: matching.filter((entry) => entry.category === "error").length,
      contradictions: matching.filter((entry) => entry.category === "contradiction").length,
      lessons: matching.filter((entry) => entry.category === "lesson").length,
      priorities
    };
  }).filter((report) => report.total > 0);
}
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}
function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return value.map((item) => item.trim());
}
function canonicalWorkflowEvidenceKey(value) {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}
function normalizeWorkflowEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized = /* @__PURE__ */ new Map();
  for (const [requirement, candidate] of Object.entries(value)) {
    const key = canonicalWorkflowEvidenceKey(requirement);
    if (!key) continue;
    const values = Array.isArray(candidate) ? candidate : [candidate];
    const safeValues = values.filter((item) => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
    if (safeValues.length > 0) {
      normalized.set(key, [.../* @__PURE__ */ new Set([...normalized.get(key) ?? [], ...safeValues])]);
    }
  }
  return Object.fromEntries(normalized);
}
function normalizeVerifiedWorkflowEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = /* @__PURE__ */ new Map();
  for (const [rawRequirement, rawSnapshots] of Object.entries(value)) {
    const requirement = canonicalWorkflowEvidenceKey(rawRequirement);
    if (!requirement || !Array.isArray(rawSnapshots)) continue;
    const snapshots = rawSnapshots.filter((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const snapshot = candidate;
      return snapshot.schema === "pi-mesh.verified-peer-evidence.v1" && typeof snapshot.messageId === "string" && typeof snapshot.producerId === "string" && typeof snapshot.producerName === "string" && snapshot.status === "replied" && typeof snapshot.requestSha256 === "string" && typeof snapshot.replySha256 === "string" && typeof snapshot.createdAt === "string" && typeof snapshot.replyCreatedAt === "string" && typeof snapshot.repliedAt === "string" && typeof snapshot.verifiedAt === "string" && snapshot.context?.schema === "pi-mesh.workflow-message-context.v1";
    });
    if (snapshots.length) result.set(requirement, snapshots);
  }
  return Object.fromEntries(result);
}
function mergeVerifiedWorkflowEvidence(current, incoming = {}) {
  const merged = new Map(Object.entries(normalizeVerifiedWorkflowEvidence(current)));
  for (const [rawRequirement, snapshots] of Object.entries(incoming)) {
    const requirement = canonicalWorkflowEvidenceKey(rawRequirement);
    if (!requirement) continue;
    const values = [...merged.get(requirement) ?? []];
    for (const snapshot of snapshots) {
      if (!values.some((candidate) => candidate.messageId === snapshot.messageId)) values.push(snapshot);
    }
    if (values.length) merged.set(requirement, values);
  }
  return Object.fromEntries(merged);
}
function mergeWorkflowEvidence(current, incoming = {}) {
  const merged = new Map(Object.entries(normalizeWorkflowEvidence(current)));
  const seen = /* @__PURE__ */ new Set();
  for (const [rawRequirement, rawValue] of Object.entries(incoming)) {
    const requirement = canonicalWorkflowEvidenceKey(rawRequirement);
    if (!requirement || typeof rawValue !== "string" || !rawValue.trim()) {
      throw new ProtocolError(400, "evidence must contain non-empty keyed string values", "invalid_workflow_evidence");
    }
    if (seen.has(requirement)) {
      throw new ProtocolError(
        400,
        `evidence contains duplicate normalized requirement identity: ${requirement}`,
        "invalid_workflow_evidence"
      );
    }
    seen.add(requirement);
    const value = rawValue.trim();
    const values = merged.get(requirement) ?? [];
    if (!values.includes(value)) values.push(value);
    merged.set(requirement, values);
  }
  return Object.fromEntries(merged);
}
function workflowEvidenceStrings(evidence) {
  return Object.entries(evidence).flatMap(([requirement, candidate]) => {
    const values = Array.isArray(candidate) ? candidate : [candidate];
    return values.map((value) => `${requirement}: ${value}`);
  });
}
function activeWorkflowAttempt(stage) {
  return stage.attempts + 1;
}
function validIsoTimestamp(value) {
  if (!value) return void 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function verifyWorkflowEvidenceReferences(run, stage, references, lookup, verifiedAt) {
  const expectedAttempt = activeWorkflowAttempt(stage);
  const result = /* @__PURE__ */ new Map();
  const seenRequirements = /* @__PURE__ */ new Set();
  const seenMessageIds = /* @__PURE__ */ new Set();
  for (const [rawRequirement, reference] of Object.entries(references)) {
    const requirementKey = canonicalWorkflowEvidenceKey(rawRequirement);
    if (!requirementKey || seenRequirements.has(requirementKey)) {
      throw new ProtocolError(
        400,
        `evidenceRefs contains duplicate or empty requirement identity: ${requirementKey || "(empty)"}`,
        "invalid_workflow_evidence_refs"
      );
    }
    seenRequirements.add(requirementKey);
    const policy = stage.resolvedEvidencePolicies?.[requirementKey];
    if (!policy) {
      throw new ProtocolError(
        400,
        `requirement ${requirementKey} does not declare a resolved peer evidence policy`,
        "workflow_evidence_policy_missing"
      );
    }
    if (!reference || !Array.isArray(reference.messageIds) || reference.messageIds.length < 1 || reference.messageIds.length > 16) {
      throw new ProtocolError(
        400,
        `evidenceRefs.${requirementKey}.messageIds must contain between 1 and 16 message IDs`,
        "invalid_workflow_evidence_refs"
      );
    }
    const eligibleProducerIds = new Set(policy.eligibleProducers.map((producer) => producer.id));
    const snapshots = [];
    for (const rawMessageId of reference.messageIds) {
      const messageId = typeof rawMessageId === "string" ? rawMessageId.trim() : "";
      if (!messageId || seenMessageIds.has(messageId)) {
        throw new ProtocolError(
          400,
          `evidenceRefs contains an empty or duplicate message ID: ${messageId || "(empty)"}`,
          "invalid_workflow_evidence_refs"
        );
      }
      seenMessageIds.add(messageId);
      const message = lookup.getMessage(messageId);
      if (!message) {
        throw new ProtocolError(400, `peer evidence message not found: ${messageId}`, "workflow_provenance_invalid");
      }
      const context = message.workflowContext;
      if (context?.schema !== "pi-mesh.workflow-message-context.v1" || context.runId !== run.id || context.stageId !== stage.id || context.requirementKey !== requirementKey || context.attempt !== expectedAttempt) {
        throw new ProtocolError(
          400,
          `peer evidence message ${messageId} is not bound to ${run.id}/${stage.id}/${requirementKey}/attempt-${expectedAttempt}`,
          "workflow_provenance_invalid"
        );
      }
      if (message.project !== run.project || message.from !== run.targetAgentId || message.to === run.targetAgentId) {
        throw new ProtocolError(
          400,
          `peer evidence message ${messageId} has an invalid project or direction`,
          "workflow_provenance_invalid"
        );
      }
      if (!eligibleProducerIds.has(message.to)) {
        throw new ProtocolError(
          400,
          `peer evidence producer ${message.toName} is not eligible for ${requirementKey}`,
          "workflow_provenance_invalid"
        );
      }
      if (message.correlationId !== run.id || message.status !== "replied" || !message.reply?.content.trim()) {
        throw new ProtocolError(
          400,
          `peer evidence message ${messageId} is not a replied message for run ${run.id}`,
          "workflow_provenance_invalid"
        );
      }
      const createdAt = validIsoTimestamp(message.createdAt);
      const deliveredAt = message.deliveredAt === void 0 ? void 0 : validIsoTimestamp(message.deliveredAt);
      const replyCreatedAt = validIsoTimestamp(message.reply.createdAt);
      const repliedAt = validIsoTimestamp(message.repliedAt);
      if (createdAt === void 0 || replyCreatedAt === void 0 || repliedAt === void 0 || message.deliveredAt !== void 0 && deliveredAt === void 0 || deliveredAt !== void 0 && (deliveredAt < createdAt || deliveredAt > repliedAt) || replyCreatedAt < createdAt || repliedAt < replyCreatedAt) {
        throw new ProtocolError(
          400,
          `peer evidence message ${messageId} has incoherent reply timestamps`,
          "workflow_provenance_invalid"
        );
      }
      snapshots.push({
        schema: "pi-mesh.verified-peer-evidence.v1",
        messageId: message.id,
        producerId: message.to,
        producerName: message.toName,
        context: { ...context },
        status: "replied",
        requestSha256: createHash("sha256").update(message.content, "utf8").digest("hex"),
        replySha256: createHash("sha256").update(message.reply.content, "utf8").digest("hex"),
        createdAt: message.createdAt,
        replyCreatedAt: message.reply.createdAt,
        repliedAt: message.repliedAt,
        verifiedAt
      });
    }
    result.set(requirementKey, snapshots);
  }
  return Object.fromEntries(result);
}
function peerEvidenceRequirementStatus(stage, requirementKey, runId, verifiedEvidence = normalizeVerifiedWorkflowEvidence(stage.verifiedEvidence)) {
  const canonicalKey = canonicalWorkflowEvidenceKey(requirementKey);
  const policy = stage.resolvedEvidencePolicies?.[canonicalKey];
  if (!policy) return void 0;
  const attempt = activeWorkflowAttempt(stage);
  const eligibleIds = new Set(policy.eligibleProducers.map((producer) => producer.id));
  const producers = /* @__PURE__ */ new Set();
  for (const snapshot of verifiedEvidence[canonicalKey] ?? []) {
    if (snapshot.schema === "pi-mesh.verified-peer-evidence.v1" && snapshot.status === "replied" && snapshot.context?.schema === "pi-mesh.workflow-message-context.v1" && snapshot.context.runId === runId && snapshot.context.stageId === stage.id && snapshot.context.requirementKey === canonicalKey && snapshot.context.attempt === attempt && eligibleIds.has(snapshot.producerId) && /^[a-f0-9]{64}$/.test(snapshot.requestSha256) && /^[a-f0-9]{64}$/.test(snapshot.replySha256) && validIsoTimestamp(snapshot.createdAt) !== void 0 && validIsoTimestamp(snapshot.replyCreatedAt) !== void 0 && validIsoTimestamp(snapshot.repliedAt) !== void 0 && validIsoTimestamp(snapshot.verifiedAt) !== void 0) producers.add(snapshot.producerId);
  }
  const approval = stage.degradationApprovals?.find(
    (candidate) => candidate.requirementKey === canonicalKey && candidate.attempt === attempt
  );
  const effectiveMinProducers = approval?.approvedMinProducers ?? policy.minProducers;
  return {
    requirementKey: canonicalKey,
    policyMinProducers: policy.minProducers,
    effectiveMinProducers,
    producers: [...producers],
    met: producers.size >= effectiveMinProducers,
    degraded: Boolean(approval && producers.size < policy.minProducers && producers.size >= effectiveMinProducers),
    ...approval ? { approval } : {}
  };
}
function requireCompleteEvidence(stage, evidence, verifiedEvidence, runId) {
  const missing = [];
  const peerStatuses = [];
  for (const rawRequirement of stage.requiredEvidence) {
    const requirement = canonicalWorkflowEvidenceKey(rawRequirement);
    const peerStatus = peerEvidenceRequirementStatus(stage, requirement, runId, verifiedEvidence);
    if (peerStatus) {
      peerStatuses.push(peerStatus);
      if (!peerStatus.met) missing.push(requirement);
    } else if (stage.evidencePolicies?.[requirement]) {
      throw new ProtocolError(
        409,
        `stage ${stage.id} evidence policy ${requirement} was not resolved when the run started`,
        "workflow_evidence_policy_unresolved"
      );
    } else if (!evidence[requirement]?.length) {
      missing.push(requirement);
    }
  }
  if (missing.length === 0) return peerStatuses;
  throw new ProtocolError(
    400,
    `stage ${stage.id} is missing required evidence: ${missing.join(", ")}`,
    "workflow_evidence_incomplete",
    {
      missingRequirements: missing,
      providedRequirements: Object.keys(evidence),
      peerRequirements: peerStatuses
    }
  );
}
function parseWorkflowEvidencePolicies(value, stageId, requiredEvidence, workflowId, targetName, warn) {
  if (value === void 0) return void 0;
  const rawPolicies = object(value, `stage ${stageId} evidencePolicies`);
  const policies = /* @__PURE__ */ new Map();
  for (const [rawRequirement, rawPolicy] of Object.entries(rawPolicies)) {
    const requirementKey = canonicalWorkflowEvidenceKey(
      requireString(rawRequirement, `stage ${stageId} evidencePolicies requirement`, { max: 128 })
    );
    if (!requiredEvidence.includes(requirementKey)) {
      throw new Error(`stage ${stageId} evidence policy ${requirementKey} must match requiredEvidence`);
    }
    if (policies.has(requirementKey)) {
      throw new Error(`stage ${stageId} evidencePolicies keys must be unique after normalization`);
    }
    const policy = object(rawPolicy, `stage ${stageId} evidencePolicies.${requirementKey}`);
    const supportedPolicyFields = /* @__PURE__ */ new Set([
      "kind",
      "minProducers",
      "eligibleAgents",
      "acceptedStatuses",
      "degradation"
    ]);
    const unsupportedPolicyFields = Object.keys(policy).filter((field) => !supportedPolicyFields.has(field));
    if (unsupportedPolicyFields.length) {
      throw new Error(
        `stage ${stageId} evidencePolicies.${requirementKey} contains unsupported fields: ${unsupportedPolicyFields.join(", ")}`
      );
    }
    if (policy.kind !== "peer-reply") {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.kind must be peer-reply`);
    }
    const minProducers = policy.minProducers;
    if (!Number.isInteger(minProducers) || minProducers < 1 || minProducers > 8) {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.minProducers must be an integer between 1 and 8`);
    }
    const eligibleAgents = stringArray(
      policy.eligibleAgents,
      `stage ${stageId} evidencePolicies.${requirementKey}.eligibleAgents`
    );
    if (eligibleAgents.length < 1 || eligibleAgents.length > 16) {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.eligibleAgents must contain between 1 and 16 selectors`);
    }
    const normalizedSelectors = eligibleAgents.map((selector) => selector.toLowerCase());
    if (new Set(normalizedSelectors).size !== normalizedSelectors.length) {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.eligibleAgents must be unique`);
    }
    if (normalizedSelectors.includes(targetName)) {
      throw new Error(
        `workflow ${workflowId} stage ${stageId} evidencePolicies.${requirementKey}.eligibleAgents must not include the workflow target ${targetName}: the target cannot produce peer evidence for its own run`
      );
    }
    if (minProducers > normalizedSelectors.length) {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.minProducers exceeds eligibleAgents`);
    }
    if (policy.acceptedStatuses !== void 0) {
      const statuses = stringArray(
        policy.acceptedStatuses,
        `stage ${stageId} evidencePolicies.${requirementKey}.acceptedStatuses`
      );
      if (statuses.length !== 1 || statuses[0] !== "replied") {
        throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.acceptedStatuses must be ["replied"]`);
      }
    }
    let degradation;
    if (policy.degradation !== void 0) {
      const rawDegradation = object(
        policy.degradation,
        `stage ${stageId} evidencePolicies.${requirementKey}.degradation`
      );
      const unsupportedDegradationFields = Object.keys(rawDegradation).filter((field) => field !== "minProducers");
      if (unsupportedDegradationFields.length) {
        throw new Error(
          `stage ${stageId} evidencePolicies.${requirementKey}.degradation contains unsupported fields: ${unsupportedDegradationFields.join(", ")}`
        );
      }
      const degradedMin = rawDegradation.minProducers;
      if (!Number.isInteger(degradedMin) || degradedMin < 1 || degradedMin >= minProducers) {
        throw new Error(
          `stage ${stageId} evidencePolicies.${requirementKey}.degradation.minProducers must be at least 1 and lower than minProducers`
        );
      }
      degradation = { minProducers: degradedMin };
      if (degradation.minProducers < 2) {
        warn(
          `workflow ${workflowId} stage ${stageId} evidence policy ${requirementKey}: degradation.minProducers is ${degradation.minProducers} (< 2); a single producer can satisfy the degraded peer-reply quorum`
        );
      }
    }
    policies.set(requirementKey, {
      kind: "peer-reply",
      minProducers,
      eligibleAgents,
      acceptedStatuses: ["replied"],
      ...degradation ? { degradation } : {}
    });
  }
  return policies.size ? Object.fromEntries(policies) : void 0;
}
function parseWorkflowDefinitions(raw, environment = process.env, onWarning) {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("KXM_WEBHOOK_WORKFLOWS must be a JSON array");
  const warn = (message) => {
    onWarning?.(message);
  };
  const ids = /* @__PURE__ */ new Set();
  return parsed.map((entry, definitionIndex) => {
    const value = object(entry, `workflow ${definitionIndex}`);
    const id = requireString(value.id, "workflow.id", { max: 64 });
    if (ids.has(id)) throw new Error(`duplicate workflow id: ${id}`);
    ids.add(id);
    const source = value.source ?? "generic";
    if (source !== "jira" && source !== "github" && source !== "generic") {
      throw new Error(`workflow ${id} source must be jira, github, or generic`);
    }
    const delivery = value.delivery ?? "followUp";
    if (delivery !== "steer" && delivery !== "followUp") {
      throw new Error(`workflow ${id} delivery must be steer or followUp`);
    }
    const secretEnv = value.secretEnv === void 0 ? void 0 : requireString(value.secretEnv, "workflow.secretEnv", { max: 128 });
    if (value.secret !== void 0 && secretEnv) {
      throw new Error(`workflow ${id} must configure only one of secret or secretEnv`);
    }
    const secret = requireString(secretEnv ? environment[secretEnv] : value.secret, "workflow.secret", { max: 512 });
    if (secret.length < 16) throw new Error(`workflow ${id} secret must contain at least 16 characters`);
    const signalSecretEnv = value.signalSecretEnv === void 0 ? void 0 : requireString(value.signalSecretEnv, "workflow.signalSecretEnv", { max: 128 });
    if (value.signalSecret !== void 0 && signalSecretEnv) {
      throw new Error(`workflow ${id} must configure only one of signalSecret or signalSecretEnv`);
    }
    const signalSecret = signalSecretEnv ? requireString(environment[signalSecretEnv], "workflow.signalSecret", { max: 512 }) : value.signalSecret === void 0 ? void 0 : requireString(value.signalSecret, "workflow.signalSecret", { max: 512 });
    if (signalSecret && signalSecret.length < 16) {
      throw new Error(`workflow ${id} signalSecret must contain at least 16 characters`);
    }
    const target = requireString(value.target, "workflow.target", { max: 80 });
    const targetName = target.toLowerCase();
    if (!Array.isArray(value.stages) || value.stages.length === 0 || value.stages.length > 32) {
      throw new Error(`workflow ${id} must define between 1 and 32 stages`);
    }
    const stageIds = /* @__PURE__ */ new Set();
    const stages = value.stages.map((stageEntry, stageIndex) => {
      const stage = object(stageEntry, `workflow ${id} stage ${stageIndex}`);
      const stageId = requireString(stage.id, "stage.id", { max: 64 });
      if (stageIds.has(stageId)) throw new Error(`duplicate stage id ${stageId} in workflow ${id}`);
      stageIds.add(stageId);
      const maxAttempts = stage.maxAttempts ?? 3;
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
        throw new Error(`stage ${stageId} maxAttempts must be an integer between 1 and 20`);
      }
      const area = stage.area ? requireString(stage.area, "stage.area", { max: 24 }) : void 0;
      if (area && !["harness", "gates", "implementation", "workflow", "documentation", "security", "other"].includes(area)) {
        throw new Error(`stage ${stageId} area is invalid`);
      }
      const requiredEvidence = stringArray(stage.requiredEvidence ?? [], "stage.requiredEvidence").map((requirement, requirementIndex) => canonicalWorkflowEvidenceKey(
        requireString(requirement, `stage.requiredEvidence[${requirementIndex}]`, { max: 128 })
      ));
      if (requiredEvidence.length > 32) throw new Error(`stage ${stageId} may require at most 32 evidence keys`);
      if (new Set(requiredEvidence).size !== requiredEvidence.length) {
        throw new Error(`stage ${stageId} requiredEvidence keys must be unique`);
      }
      const evidencePolicies = parseWorkflowEvidencePolicies(
        stage.evidencePolicies,
        stageId,
        requiredEvidence,
        id,
        targetName,
        warn
      );
      const on = parseOutcomeMap(stageId, stage.on);
      const stageMaxTransitions = stage.maxTransitions;
      if (stageMaxTransitions !== void 0 && (!Number.isInteger(stageMaxTransitions) || stageMaxTransitions < 1 || stageMaxTransitions > 100)) {
        throw new Error(`stage ${stageId} maxTransitions must be an integer between 1 and 100`);
      }
      return {
        id: stageId,
        label: requireString(stage.label ?? stageId, "stage.label", { max: 128 }),
        instructions: requireString(stage.instructions, "stage.instructions", { max: 4e3 }),
        requiredEvidence,
        maxAttempts,
        ...area ? { area } : {},
        ...evidencePolicies ? { evidencePolicies } : {},
        ...on ? { on } : {},
        ...stageMaxTransitions !== void 0 ? { maxTransitions: stageMaxTransitions } : {}
      };
    });
    const definitionMaxTransitions = value.maxTransitions;
    if (definitionMaxTransitions !== void 0) validateWorkflowTransitions({ id, stages, maxTransitions: definitionMaxTransitions });
    else validateWorkflowTransitions({ id, stages });
    const stageIdSet = new Set(stages.map((stage) => stage.id));
    const parseOracleConfig = (raw2, field) => {
      if (raw2 === void 0) return void 0;
      const candidate = object(raw2, `workflow ${id} ${field}`);
      const stageId = requireString(candidate.stageId, `workflow ${id} ${field}.stageId`, { max: 64 });
      if (!stageIdSet.has(stageId)) {
        throw new Error(`workflow ${id} ${field}.stageId references unknown stage ${stageId}`);
      }
      const evidenceKey = canonicalWorkflowEvidenceKey(requireString(candidate.evidenceKey, `workflow ${id} ${field}.evidenceKey`, { max: 128 }));
      return { stageId, evidenceKey };
    };
    const reproOracle = parseOracleConfig(value.reproOracle, "reproOracle");
    const planHash = parseOracleConfig(value.planHash, "planHash");
    let requirePlanHash;
    if (value.requirePlanHash !== void 0) {
      const required = stringArray(value.requirePlanHash, `workflow ${id} requirePlanHash`);
      for (const stageId of required) {
        if (!stageIdSet.has(stageId)) {
          throw new Error(`workflow ${id} requirePlanHash references unknown stage ${stageId}`);
        }
      }
      requirePlanHash = [...new Set(required)].sort();
    }
    let filter;
    if (value.filter !== void 0) {
      const candidate = object(value.filter, `workflow ${id} filter`);
      filter = {
        path: requireString(candidate.path, "filter.path", { max: 256 }),
        equals: requireString(candidate.equals, "filter.equals", { max: 512 })
      };
    }
    if (value.ttlMs !== void 0 && (!Number.isInteger(value.ttlMs) || value.ttlMs < MIN_MESSAGE_TTL_MS || value.ttlMs > MAX_MESSAGE_TTL_MS)) {
      throw new Error(`workflow ${id} ttlMs must be an integer between ${MIN_MESSAGE_TTL_MS} and ${MAX_MESSAGE_TTL_MS}`);
    }
    return {
      id,
      source,
      project: requireString(value.project, "workflow.project", { max: 128 }),
      target,
      secret,
      ...signalSecret ? { signalSecret } : {},
      ...value.event ? { event: requireString(value.event, "workflow.event", { max: 128 }) } : {},
      ...filter ? { filter } : {},
      delivery,
      ...value.ttlMs !== void 0 ? { ttlMs: value.ttlMs } : {},
      ...value.maxTransitions !== void 0 ? { maxTransitions: value.maxTransitions } : {},
      ...reproOracle ? { reproOracle } : {},
      ...planHash ? { planHash } : {},
      ...requirePlanHash ? { requirePlanHash } : {},
      promptTemplate: requireString(value.promptTemplate, "workflow.promptTemplate", { max: 2e4 }),
      stages
    };
  });
}
function validateWorkflowTransitions(definition) {
  const stageIndex = new Map(definition.stages.map((stage, index) => [stage.id, index]));
  let hasBackEdge = false;
  for (const stage of definition.stages) {
    if (!stage.on) continue;
    for (const [outcome, rawValue] of Object.entries(stage.on)) {
      if (!outcome.trim()) throw new Error(`stage ${stage.id} declares an empty outcome key`);
      const rule = normalizeOutcomeValue(rawValue, `stage ${stage.id} on.${outcome}`);
      if (rule.target === WORKFLOW_TERMINAL_TARGET) continue;
      const targetIndex = stageIndex.get(rule.target);
      if (targetIndex === void 0) {
        throw new Error(`stage ${stage.id} on.${outcome} targets unknown stage ${rule.target}`);
      }
      const sourceIndex = stageIndex.get(stage.id);
      if (targetIndex > sourceIndex + 1) {
        throw new Error(
          `stage ${stage.id} on.${outcome} skips intermediate stages by targeting ${rule.target}; forward transitions must target the next stage so approvals and gates cannot be bypassed`
        );
      }
      if (targetIndex <= sourceIndex) hasBackEdge = true;
    }
  }
  if (definition.maxTransitions !== void 0 && (!Number.isInteger(definition.maxTransitions) || definition.maxTransitions < 1 || definition.maxTransitions > 200)) {
    throw new Error(`workflow ${definition.id} maxTransitions must be an integer between 1 and 200`);
  }
  if (hasBackEdge && (definition.maxTransitions === void 0 || definition.maxTransitions < 1)) {
    throw new Error(`workflow ${definition.id} declares a back-edge but no maxTransitions budget; cycles without budgets are rejected`);
  }
}
function parseOutcomeMap(stageId, raw) {
  if (raw === void 0) return void 0;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`stage ${stageId} on must be an object`);
  }
  const map = {};
  for (const [outcome, value] of Object.entries(raw)) {
    map[outcome] = normalizeOutcomeValue(value, `stage ${stageId} on.${outcome}`);
  }
  return map;
}
function valueAtPath(payload, path) {
  let current = payload;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return void 0;
    current = current[part];
  }
  return current;
}
function renderWorkflowPrompt(template, payload) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, path) => {
    const value = valueAtPath(payload, path);
    if (value === void 0 || value === null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}
function canonicalizeForHash(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([, candidate]) => candidate !== void 0).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, candidate]) => [key, canonicalizeForHash(candidate)])
    );
  }
  return value;
}
function canonicalWorkflowDefinitionJson(definition) {
  const { secret: _secret, signalSecret: _signalSecret, ...publicDefinition } = definition;
  return JSON.stringify(canonicalizeForHash(publicDefinition));
}
function workflowDefinitionHash(definition) {
  return createHash("sha256").update(canonicalWorkflowDefinitionJson(definition), "utf8").digest("hex");
}
function resolveOutcomeRule(stage, outcomeKey) {
  const raw = stage.on?.[outcomeKey];
  return raw === void 0 ? void 0 : normalizeOutcomeValue(raw, `stage ${stage.id} on.${outcomeKey}`);
}
function transitionCounts(run, fromStage, outcome, target) {
  const records = run.transitions ?? [];
  return {
    total: records.length,
    fromStage: records.filter((record) => record.fromStage === fromStage).length,
    forEdge: records.filter((record) => record.fromStage === fromStage && record.outcome === outcome && record.toStage === target).length
  };
}
function recordTransition(run, fromStage, rule, outcome, attempt, evidenceKeys, timestamp) {
  const record = {
    id: newId("trans"),
    fromStage,
    toStage: rule.target,
    outcome,
    attempt,
    evidenceKeys,
    at: timestamp
  };
  run.transitions = [...run.transitions ?? [], record];
  return record;
}
function enterStage(run, stage, timestamp) {
  stage.status = "in_progress";
  stage.attempts = 0;
  stage.evidence = {};
  stage.verifiedEvidence = {};
  stage.startedAt = timestamp;
  stage.updatedAt = timestamp;
  delete stage.summary;
  run.currentStage = stage.id;
  run.updatedAt = timestamp;
}
function takeDeclaredTransition(run, stage, rule, outcome, summary, attempt, timestamp, evidenceKeys) {
  const definitionBudget = run.maxTransitions;
  const counts = transitionCounts(run, stage.id, outcome, rule.target);
  const edgeExhausted = rule.maxTransitions !== void 0 && counts.forEdge >= rule.maxTransitions;
  const stageExhausted = stage.maxTransitions !== void 0 && counts.fromStage >= stage.maxTransitions;
  const globalExhausted = definitionBudget !== void 0 && counts.total >= definitionBudget;
  if (edgeExhausted || stageExhausted || globalExhausted) {
    stage.completedAt = timestamp;
    run.status = "failed";
    delete run.currentStage;
    run.updatedAt = timestamp;
    return {
      retry: false,
      completed: false,
      run,
      exhausted: true
    };
  }
  const record = recordTransition(run, stage.id, rule, outcome, attempt, evidenceKeys.slice(0, 32), timestamp);
  if (rule.target === WORKFLOW_TERMINAL_TARGET) {
    stage.completedAt = timestamp;
    run.status = "completed";
    delete run.currentStage;
    run.completedAt = timestamp;
    run.updatedAt = timestamp;
    return { retry: false, completed: true, run, transition: record };
  }
  const target = run.stages.find((candidate) => candidate.id === rule.target);
  if (!target) {
    run.status = "failed";
    delete run.currentStage;
    return { retry: false, completed: false, run, exhausted: true };
  }
  stage.summary = summary;
  enterStage(run, target, timestamp);
  return { retry: false, completed: false, run, transition: record };
}
function evidenceValueSha256(evidence, key) {
  const values = evidence[canonicalWorkflowEvidenceKey(key)];
  if (!values || values.length === 0) return void 0;
  return createHash("sha256").update([...values].sort().join("\n"), "utf8").digest("hex");
}
function enforceOracles(run, stageId, evidence) {
  if (run.oracle) {
    const presented = evidenceValueSha256(evidence, run.oracle.evidenceKey);
    if (presented !== void 0 && presented !== run.oracle.sha256) {
      throw new ProtocolError(
        400,
        `evidence ${run.oracle.evidenceKey} does not match the immutable reproduction oracle captured at ${run.oracle.capturedAt}; the confirmed reproduction may not be weakened`,
        "weakened_reproduction"
      );
    }
  }
  if (run.requirePlanHash?.includes(stageId) && !run.planHash) {
    throw new ProtocolError(
      400,
      `stage ${stageId} requires an approved plan hash before it can checkpoint`,
      "plan_hash_required"
    );
  }
}
function captureOracles(run, stageId, evidence, timestamp) {
  if (run.reproOracle?.stageId === stageId) {
    const sha256 = evidenceValueSha256(evidence, run.reproOracle.evidenceKey);
    if (sha256 !== void 0) {
      run.oracle = { evidenceKey: run.reproOracle.evidenceKey, sha256, capturedAt: timestamp };
    }
  }
  if (run.planHashConfig?.stageId === stageId) {
    const sha256 = evidenceValueSha256(evidence, run.planHashConfig.evidenceKey);
    if (sha256 !== void 0) {
      run.planHash = { evidenceKey: run.planHashConfig.evidenceKey, sha256, capturedAt: timestamp };
    }
  }
}
function checkpointRun(run, stageId, status, summary, evidence, timestamp, verifiedEvidence = {}, outcome) {
  if (run.status !== "running") throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_terminal");
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new ProtocolError(404, `workflow stage not found: ${stageId}`, "workflow_stage_not_found");
  if (stage.id !== run.currentStage || stage.status !== "in_progress") {
    throw new ProtocolError(409, `stage ${stageId} is not currently active`, "workflow_stage_out_of_order");
  }
  const accumulatedEvidence = mergeWorkflowEvidence(stage.evidence, evidence);
  const accumulatedVerifiedEvidence = mergeVerifiedWorkflowEvidence(stage.verifiedEvidence, verifiedEvidence);
  enforceOracles(run, stageId, accumulatedEvidence);
  const peerStatuses = status === "passed" ? requireCompleteEvidence(stage, accumulatedEvidence, accumulatedVerifiedEvidence, run.id) : [];
  const degradedRequirements = peerStatuses.filter((peerStatus) => peerStatus.degraded);
  stage.attempts += 1;
  stage.summary = summary;
  if (status === "passed") {
    stage.evidence = accumulatedEvidence;
    if (Object.keys(accumulatedVerifiedEvidence).length) stage.verifiedEvidence = accumulatedVerifiedEvidence;
    captureOracles(run, stageId, accumulatedEvidence, timestamp);
    if (degradedRequirements.length) {
      stage.degraded = true;
      stage.degradedRequirements = degradedRequirements.map((peerStatus) => peerStatus.requirementKey);
    }
  }
  stage.updatedAt = timestamp;
  run.updatedAt = timestamp;
  if (status !== "passed") {
    stage.status = status;
    if (stage.attempts >= stage.maxAttempts) {
      stage.completedAt = timestamp;
      run.status = "failed";
      delete run.currentStage;
      return { retry: false, completed: false, run };
    }
    const outcomeKey = outcome ?? status;
    const rule = resolveOutcomeRule(stage, outcomeKey);
    if (rule && stage.attempts < stage.maxAttempts) {
      const result = takeDeclaredTransition(run, stage, rule, outcomeKey, summary, stage.attempts, timestamp, Object.keys(accumulatedEvidence));
      if (result.transition !== void 0 && !result.completed && rule.target !== stage.id) {
        stage.status = "pending";
      }
      return result;
    }
    stage.status = "in_progress";
    return { retry: true, completed: false, run };
  }
  stage.status = "passed";
  stage.completedAt = timestamp;
  const passedRule = resolveOutcomeRule(stage, outcome ?? "passed");
  if (passedRule) {
    return takeDeclaredTransition(run, stage, passedRule, outcome ?? "passed", summary, stage.attempts, timestamp, Object.keys(accumulatedEvidence));
  }
  const next = run.stages.find((candidate) => candidate.status === "pending");
  if (next) {
    next.status = "in_progress";
    next.startedAt = timestamp;
    next.updatedAt = timestamp;
    run.currentStage = next.id;
    return {
      retry: false,
      completed: false,
      run,
      ...degradedRequirements.length ? { degraded: true } : {}
    };
  }
  run.status = "completed";
  delete run.currentStage;
  run.completedAt = timestamp;
  return {
    retry: false,
    completed: true,
    run,
    ...degradedRequirements.length ? { degraded: true } : {}
  };
}
function waitForWorkflowSignal(run, stageId, signalKey, summary, timestamp, expiresAt, evidence = {}, verifiedEvidence = {}) {
  if (run.status !== "running") throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_not_running");
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new ProtocolError(404, `workflow stage not found: ${stageId}`, "workflow_stage_not_found");
  if (stage.id !== run.currentStage || stage.status !== "in_progress") {
    throw new ProtocolError(409, `stage ${stageId} is not currently active`, "workflow_stage_out_of_order");
  }
  if (Date.parse(expiresAt) <= Date.parse(timestamp)) {
    throw new ProtocolError(400, "workflow signal expiry must be in the future", "workflow_wait_invalid");
  }
  stage.evidence = mergeWorkflowEvidence(stage.evidence, evidence);
  const accumulatedVerifiedEvidence = mergeVerifiedWorkflowEvidence(stage.verifiedEvidence, verifiedEvidence);
  if (Object.keys(accumulatedVerifiedEvidence).length) stage.verifiedEvidence = accumulatedVerifiedEvidence;
  stage.status = "waiting";
  stage.updatedAt = timestamp;
  run.status = "waiting";
  run.waiting = { stageId, signalKey, summary, createdAt: timestamp, expiresAt };
  run.updatedAt = timestamp;
  return run;
}
function resumeWorkflowFromSignal(run, signalKey, status, summary, evidence, timestamp) {
  if (run.status !== "waiting" || !run.waiting) {
    throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_not_waiting");
  }
  if (run.waiting.signalKey !== signalKey) {
    throw new ProtocolError(409, `workflow is waiting for ${run.waiting.signalKey}`, "workflow_signal_mismatch");
  }
  const stageId = run.waiting.stageId;
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage || stage.id !== run.currentStage || stage.status !== "waiting") {
    throw new ProtocolError(409, "workflow wait state is inconsistent", "workflow_wait_inconsistent");
  }
  const accumulatedEvidence = mergeWorkflowEvidence(stage.evidence, evidence);
  if (status === "passed") {
    requireCompleteEvidence(
      stage,
      accumulatedEvidence,
      normalizeVerifiedWorkflowEvidence(stage.verifiedEvidence),
      run.id
    );
  }
  run.status = "running";
  stage.status = "in_progress";
  delete run.waiting;
  const result = checkpointRun(run, stageId, status, summary, evidence, timestamp);
  return { ...result, stageId };
}
function approveWorkflowDegradation(run, stageId, requirement, reason, approvalId, timestamp) {
  if (run.status !== "running" && run.status !== "waiting") {
    throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_terminal");
  }
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new ProtocolError(404, `workflow stage not found: ${stageId}`, "workflow_stage_not_found");
  if (stage.id !== run.currentStage || stage.status !== "in_progress" && stage.status !== "waiting") {
    throw new ProtocolError(409, `stage ${stageId} is not currently active`, "workflow_stage_out_of_order");
  }
  const requirementKey = canonicalWorkflowEvidenceKey(requirement);
  const policy = stage.resolvedEvidencePolicies?.[requirementKey];
  if (!policy?.degradation) {
    throw new ProtocolError(
      400,
      `requirement ${requirementKey} does not permit degraded quorum`,
      "workflow_degradation_forbidden"
    );
  }
  const attempt = activeWorkflowAttempt(stage);
  const existing = stage.degradationApprovals?.find(
    (candidate) => candidate.requirementKey === requirementKey && candidate.attempt === attempt
  );
  if (existing) {
    if (existing.reason !== reason.trim()) {
      throw new ProtocolError(
        409,
        `degradation was already approved for ${requirementKey} attempt ${attempt}`,
        "workflow_degradation_conflict"
      );
    }
    return { run, approval: existing, created: false };
  }
  const approval = {
    schema: "pi-mesh.workflow-degradation-approval.v1",
    id: approvalId,
    requirementKey,
    attempt,
    policyMinProducers: policy.minProducers,
    approvedMinProducers: policy.degradation.minProducers,
    approvedBy: "mesh-admin",
    reason: requireString(reason, "reason", { max: 1e3 }),
    approvedAt: timestamp
  };
  (stage.degradationApprovals ??= []).push(approval);
  stage.updatedAt = timestamp;
  run.updatedAt = timestamp;
  return { run, approval, created: true };
}

// plugins/kxm/src/retrospective.ts
var MAX_RETROSPECTIVE_ENTRIES = 500;
var SAFE_RUN_ID = /^run_[A-Za-z0-9_-]{1,120}$/;
function durationMs(startedAt, completedAt) {
  if (!startedAt || !completedAt) return void 0;
  const value = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : void 0;
}
function increment(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}
function classFromEvidence(evidence) {
  const match = evidence.find((item) => item.startsWith("class:"));
  return match?.slice("class:".length) || "unknown";
}
function buildEvidenceAudit(run) {
  const audit = [];
  for (const stage of run.stages) {
    const verifiedEvidence = normalizeVerifiedWorkflowEvidence(stage.verifiedEvidence);
    const degradedRequirements = new Set(
      (stage.degradedRequirements ?? []).map(canonicalWorkflowEvidenceKey)
    );
    const policies = Object.entries(stage.resolvedEvidencePolicies ?? {}).sort(([left], [right]) => left.localeCompare(right));
    for (const [rawRequirement, policy] of policies) {
      const requirementKey = canonicalWorkflowEvidenceKey(rawRequirement);
      const attempt = stage.status === "passed" || stage.status === "failed" ? Math.max(1, stage.attempts) : stage.attempts + 1;
      const verifiedMessages = [...verifiedEvidence[requirementKey] ?? []].filter((snapshot) => snapshot.context.runId === run.id && snapshot.context.stageId === stage.id && snapshot.context.requirementKey === requirementKey && snapshot.context.attempt === attempt).sort((left, right) => left.messageId.localeCompare(right.messageId)).map((snapshot) => ({
        schema: snapshot.schema,
        messageId: snapshot.messageId,
        producerId: snapshot.producerId,
        producerName: snapshot.producerName,
        context: {
          schema: snapshot.context.schema,
          runId: snapshot.context.runId,
          stageId: snapshot.context.stageId,
          requirementKey: snapshot.context.requirementKey,
          attempt: snapshot.context.attempt
        },
        status: snapshot.status,
        hashes: {
          requestSha256: snapshot.requestSha256,
          replySha256: snapshot.replySha256
        },
        timestamps: {
          createdAt: snapshot.createdAt,
          replyCreatedAt: snapshot.replyCreatedAt,
          repliedAt: snapshot.repliedAt,
          verifiedAt: snapshot.verifiedAt
        }
      }));
      const degradationApprovals = (stage.degradationApprovals ?? []).filter((approval) => approval.schema === "pi-mesh.workflow-degradation-approval.v1" && approval.requirementKey === requirementKey && approval.attempt === attempt).sort((left, right) => left.attempt - right.attempt || left.approvedAt.localeCompare(right.approvedAt) || left.id.localeCompare(right.id)).map((approval) => ({
        schema: approval.schema,
        id: approval.id,
        requirementKey: approval.requirementKey,
        attempt: approval.attempt,
        policyMinProducers: approval.policyMinProducers,
        approvedMinProducers: approval.approvedMinProducers,
        approvedBy: approval.approvedBy,
        reason: redactSecrets(approval.reason).replace(/\s+/gu, " ").trim(),
        approvedAt: approval.approvedAt
      }));
      const degraded = Boolean(stage.degraded && degradedRequirements.has(requirementKey));
      const appliedApproval = degradationApprovals.at(-1);
      audit.push({
        stageId: stage.id,
        requirementKey,
        attempt,
        policy: {
          kind: policy.kind,
          minProducers: policy.minProducers,
          effectiveMinProducers: appliedApproval?.approvedMinProducers ?? policy.minProducers,
          acceptedStatuses: ["replied"]
        },
        eligibleProducers: [...policy.eligibleProducers].sort((left, right) => left.id.localeCompare(right.id) || left.name.localeCompare(right.name)).map((producer) => ({ id: producer.id, name: producer.name })),
        verifiedProducerIds: [...new Set(verifiedMessages.map((snapshot) => snapshot.producerId))].sort(),
        verifiedMessages,
        degraded,
        degradationApprovals
      });
    }
  }
  return audit;
}
function buildRetrospective(run, journal, exportedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!SAFE_RUN_ID.test(run.id)) throw new Error("invalid retrospective run id");
  const entries = journal.filter((entry) => entry.runId === run.id).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).slice(-MAX_RETROSPECTIVE_ENTRIES).map((entry) => {
    const promotionState = journalPromotionState(entry);
    const exported = {
      id: entry.id,
      category: entry.category,
      area: entry.area,
      severity: entry.severity,
      summary: redactSecrets(entry.summary),
      evidence: redactStringList(entry.evidence),
      relatedEntryIds: entry.relatedEntryIds.slice(0, 16),
      createdAt: entry.createdAt
    };
    if (entry.stageId !== void 0) exported.stageId = entry.stageId;
    if (entry.attempt !== void 0) exported.attempt = entry.attempt;
    if (promotionState !== void 0) exported.promotionState = promotionState;
    return exported;
  });
  const byCategory = {};
  const byArea = {};
  const byClass = {};
  for (const entry of entries) {
    increment(byCategory, entry.category);
    increment(byArea, entry.area);
    increment(byClass, classFromEvidence(entry.evidence));
  }
  const recurringErrorClasses = Object.entries(byClass).map(([errorClass, count]) => ({ class: errorClass, count })).sort((left, right) => right.count - left.count || left.class.localeCompare(right.class));
  const resolvedContradictions = new Set(entries.filter((entry) => entry.category === "decision" || entry.category === "lesson").flatMap((entry) => entry.relatedEntryIds));
  const openContradictions = entries.filter((entry) => entry.category === "contradiction" && !resolvedContradictions.has(entry.id)).map((entry) => ({ id: entry.id, summary: entry.summary, area: entry.area }));
  const decisions = entries.filter((entry) => entry.category === "decision").map((entry) => ({ id: entry.id, summary: entry.summary, area: entry.area }));
  const proposedImprovements = entries.filter((entry) => entry.category === "lesson" || entry.category === "error").slice(0, 12).map((entry) => ({
    area: entry.area,
    summary: entry.summary,
    successMeasure: "reduce recurrence of this class in the next comparable run",
    status: "proposed"
  }));
  const evidenceAudit = buildEvidenceAudit(run);
  const degradedStageIds = run.stages.filter((stage) => stage.degraded).map((stage) => stage.id);
  return {
    schema: "pi-mesh.retrospective.v1",
    runId: run.id,
    definitionId: run.definitionId,
    status: run.status,
    exportedAt,
    reviewDecision: "proposed",
    stages: run.stages.map((stage) => {
      const elapsed = durationMs(stage.startedAt, stage.completedAt);
      return { id: stage.id, ...stage.area ? { area: stage.area } : {}, status: stage.status, attempts: stage.attempts, ...stage.startedAt ? { startedAt: stage.startedAt } : {}, ...stage.completedAt ? { completedAt: stage.completedAt } : {}, ...elapsed !== void 0 ? { durationMs: elapsed } : {}, ...stage.updatedAt ? { updatedAt: stage.updatedAt } : {}, ...stage.summary ? { summary: redactSecrets(stage.summary) } : {} };
    }),
    counts: { byCategory, byArea, byClass },
    openContradictions,
    decisions,
    recurringErrorClasses,
    entries,
    proposedImprovements,
    ...evidenceAudit.length ? { evidenceAudit } : {},
    ...degradedStageIds.length ? { degradedStageIds } : {}
  };
}
function renderRetrospectiveMarkdown(doc) {
  const stageRows = doc.stages.map((stage) => `| ${stage.id} | ${stage.area ?? ""} | ${stage.status} | ${stage.attempts} | ${stage.durationMs ?? ""} |`).join("\n");
  const contradictionRows = doc.openContradictions.map((entry) => `- ${entry.id} (${entry.area}): ${entry.summary}`).join("\n") || "- none";
  const decisionRows = doc.decisions.map((entry) => `- ${entry.id} (${entry.area}): ${entry.summary}`).join("\n") || "- none";
  const classRows = doc.recurringErrorClasses.map((entry) => `- ${entry.class}: ${entry.count}`).join("\n") || "- none";
  const entryRows = doc.entries.map((entry) => {
    const related = entry.relatedEntryIds.length > 0 ? `; related: ${entry.relatedEntryIds.join(", ")}` : "";
    const evidence = entry.evidence.length > 0 ? `; evidence: ${entry.evidence.join(", ")}` : "";
    return `- ${entry.id} [${entry.category}/${entry.area}/${entry.severity}]: ${entry.summary}${related}${evidence}`;
  }).join("\n") || "- none";
  const evidenceAuditRows = (doc.evidenceAudit ?? []).flatMap((audit) => {
    const producerNames = audit.eligibleProducers.map((producer) => `${producer.name} (${producer.id})`).join(", ") || "none";
    const verified = audit.verifiedMessages.length ? audit.verifiedMessages.map((snapshot) => `  - ${snapshot.messageId}: producer ${snapshot.producerName} (${snapshot.producerId}), attempt ${snapshot.context.attempt}, request ${snapshot.hashes.requestSha256}, reply ${snapshot.hashes.replySha256}, replied ${snapshot.timestamps.repliedAt}, verified ${snapshot.timestamps.verifiedAt}`) : ["  - no verified messages"];
    const approvals = audit.degradationApprovals.map((approval) => `  - approval ${approval.id}: attempt ${approval.attempt}, ${approval.policyMinProducers} -> ${approval.approvedMinProducers} producers, ${approval.approvedBy}, ${approval.approvedAt}; reason: ${approval.reason}`);
    return [
      `- ${audit.stageId} / ${audit.requirementKey} / attempt ${audit.attempt}: ${audit.verifiedProducerIds.length}/${audit.policy.effectiveMinProducers} verified producers; policy minimum ${audit.policy.minProducers}; degraded: ${audit.degraded}`,
      `  - eligible: ${producerNames}`,
      ...verified,
      ...approvals.length ? ["  - degradation approvals:", ...approvals] : []
    ];
  });
  return [
    `# Workflow retrospective ${doc.runId}`,
    "",
    `- Definition: ${doc.definitionId}`,
    `- Status: ${doc.status}`,
    `- Exported: ${doc.exportedAt}`,
    `- Review decision: ${doc.reviewDecision}`,
    "",
    "## Stages",
    "",
    "| id | area | status | attempts | duration ms |",
    "|---|---|---|---|---|",
    stageRows,
    "",
    "## Decisions",
    "",
    decisionRows,
    "",
    "## Open contradictions",
    "",
    contradictionRows,
    "",
    "## Recurring error classes",
    "",
    classRows,
    "",
    "## Bounded journal evidence",
    "",
    entryRows,
    "",
    ...doc.evidenceAudit?.length ? [
      "## Peer-evidence audit",
      "",
      "This section contains immutable provenance metadata and content hashes only; prompt and reply bodies are excluded.",
      "",
      ...evidenceAuditRows,
      ""
    ] : [],
    "## Proposed improvements",
    "",
    ...doc.proposedImprovements.map((item) => `- [${item.status}] (${item.area}) ${item.summary}`),
    "",
    "Proposed improvements are evidence, not policy. Do not apply them until an explicit review decision.",
    ""
  ].join("\n");
}
function writeRetrospective(outDir, doc) {
  if (!SAFE_RUN_ID.test(doc.runId)) throw new Error("invalid retrospective run id");
  mkdirSync(outDir, { recursive: true });
  const root = resolve(outDir);
  const jsonPath = resolve(root, `${doc.runId}.json`);
  const mdPath = resolve(root, `${doc.runId}.md`);
  const prefix = `${root}${process.platform === "win32" ? "\\" : "/"}`;
  if (!jsonPath.startsWith(prefix) || !mdPath.startsWith(prefix)) throw new Error("retrospective path escaped output directory");
  const jsonTmp = `${jsonPath}.tmp`;
  const mdTmp = `${mdPath}.tmp`;
  writeFileSync(jsonTmp, `${JSON.stringify(doc, null, 2)}
`, { encoding: "utf8", mode: 384 });
  writeFileSync(mdTmp, renderRetrospectiveMarkdown(doc), { encoding: "utf8", mode: 384 });
  renameSync(jsonTmp, jsonPath);
  renameSync(mdTmp, mdPath);
  return { jsonPath, mdPath };
}

// plugins/kxm/src/store.ts
import { mkdirSync as mkdirSync2 } from "node:fs";
import { dirname, resolve as resolve2 } from "node:path";
import { DatabaseSync } from "node:sqlite";
var MeshStore = class {
  agents = /* @__PURE__ */ new Map();
  messages = /* @__PURE__ */ new Map();
  workflowRuns = /* @__PURE__ */ new Map();
  journal = /* @__PURE__ */ new Map();
  contextItems = /* @__PURE__ */ new Map();
  path;
  database;
  constructor(path) {
    if (!path) return;
    this.path = path === ":memory:" ? path : resolve2(path);
    if (this.path !== ":memory:") mkdirSync2(dirname(this.path), { recursive: true });
    this.database = new DatabaseSync(this.path);
    this.database.exec("PRAGMA busy_timeout = 5000");
    const schemaRow = this.database.prepare("PRAGMA user_version").get();
    const schemaVersion = schemaRow?.user_version ?? 0;
    if (schemaVersion > 3) {
      this.database.close();
      throw new Error(`mesh database schema ${schemaVersion} is newer than this runtime supports`);
    }
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        record TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        record TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        record TEXT NOT NULL,
        UNIQUE(definition_id, delivery_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS workflow_journal (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        category TEXT NOT NULL,
        area TEXT NOT NULL,
        record TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS workflow_journal_run_id ON workflow_journal(run_id);
      CREATE TABLE IF NOT EXISTS context_items (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        kind TEXT NOT NULL,
        record TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS context_items_project ON context_items(project);
      PRAGMA user_version = 3;
    `);
    this.load();
  }
  get persistent() {
    return Boolean(this.database && this.path !== ":memory:");
  }
  saveAgent(agent) {
    this.agents.set(agent.id, agent);
    this.database?.prepare(`
      INSERT INTO agents (id, record) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record
    `).run(agent.id, JSON.stringify(agent));
  }
  saveMessage(message) {
    this.messages.set(message.id, message);
    this.database?.prepare(`
      INSERT INTO messages (id, record) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record
    `).run(message.id, JSON.stringify(message));
  }
  deleteMessage(messageId) {
    this.messages.delete(messageId);
    this.database?.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
  }
  saveWorkflowRun(run) {
    this.workflowRuns.set(run.id, run);
    this.database?.prepare(`
      INSERT INTO workflow_runs (id, definition_id, delivery_id, record) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record
    `).run(run.id, run.definitionId, run.deliveryId, JSON.stringify(run));
  }
  saveJournalEntry(entry) {
    this.journal.set(entry.id, entry);
    this.database?.prepare(`
      INSERT INTO workflow_journal (id, run_id, category, area, record) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record
    `).run(entry.id, entry.runId, entry.category, entry.area, JSON.stringify(entry));
  }
  /** Persist a context item. Items are immutable by convention: saving an
   * existing ID replaces the record, and lifecycle corrections must mint a
   * new item with a `supersedes` link rather than rewriting provenance. */
  saveContextItem(item) {
    this.contextItems.set(item.id, item);
    this.database?.prepare(`
      INSERT INTO context_items (id, project, kind, record) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record
    `).run(item.id, item.project, item.kind, JSON.stringify(item));
  }
  getContextItem(id, project) {
    const item = this.contextItems.get(id);
    if (!item) return void 0;
    if (project !== void 0 && item.project !== project) return void 0;
    return item;
  }
  /** Project-scoped listing. Never returns items from other projects; the
   * optional project filter fails closed to an empty result rather than
   * leaking cross-project context. */
  listContextItems(project, kinds) {
    const wanted = kinds ? new Set(kinds) : void 0;
    return [...this.contextItems.values()].filter((item) => item.project === project).filter((item) => wanted === void 0 || wanted.has(item.kind)).sort((left, right) => left.id.localeCompare(right.id));
  }
  saveWorkflowTransition(run, message, entry) {
    if (this.database) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        if (message) {
          this.database.prepare(`
            INSERT INTO messages (id, record) VALUES (?, ?)
            ON CONFLICT(id) DO UPDATE SET record = excluded.record
          `).run(message.id, JSON.stringify(message));
        }
        if (entry) {
          this.database.prepare(`
            INSERT INTO workflow_journal (id, run_id, category, area, record) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET record = excluded.record
          `).run(entry.id, entry.runId, entry.category, entry.area, JSON.stringify(entry));
        }
        this.database.prepare(`
          INSERT INTO workflow_runs (id, definition_id, delivery_id, record) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET record = excluded.record
        `).run(run.id, run.definitionId, run.deliveryId, JSON.stringify(run));
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    if (message) this.messages.set(message.id, message);
    if (entry) this.journal.set(entry.id, entry);
    this.workflowRuns.set(run.id, run);
  }
  healthy() {
    if (!this.database) return true;
    return this.database.prepare("SELECT 1 AS ok").get() !== void 0;
  }
  close() {
    this.database?.close();
  }
  load() {
    if (!this.database) return;
    const agentRows = this.database.prepare("SELECT record FROM agents").all();
    const messageRows = this.database.prepare("SELECT record FROM messages").all();
    const workflowRows = this.database.prepare("SELECT record FROM workflow_runs").all();
    const journalRows = this.database.prepare("SELECT record FROM workflow_journal").all();
    const contextRows = this.database.prepare("SELECT record FROM context_items").all();
    for (const row of agentRows) {
      const agent = JSON.parse(row.record);
      this.agents.set(agent.id, agent);
    }
    for (const row of messageRows) {
      const message = JSON.parse(row.record);
      this.messages.set(message.id, message);
    }
    for (const row of workflowRows) {
      const run = JSON.parse(row.record);
      this.workflowRuns.set(run.id, run);
    }
    for (const row of journalRows) {
      const entry = JSON.parse(row.record);
      this.journal.set(entry.id, entry);
    }
    for (const row of contextRows) {
      const item = JSON.parse(row.record);
      this.contextItems.set(item.id, item);
    }
  }
};

// plugins/kxm/src/hub.ts
var DEFAULT_WORKFLOW_WAIT_TIMEOUT_MS = 24 * 60 * 6e4;
var MIN_WORKFLOW_WAIT_TIMEOUT_MS = 1e3;
var MAX_WORKFLOW_WAIT_TIMEOUT_MS = 30 * 24 * 60 * 6e4;
function isLoopback(host2) {
  if (host2 === "localhost" || host2 === "::1") return true;
  return isIP(host2) === 4 && host2.startsWith("127.");
}
function publicAgent(agent) {
  const { key: _key, ...record } = agent;
  return record;
}
function safeTokenEqual(actual, expected) {
  if (!actual) return false;
  const actualHash = createHash2("sha256").update(actual).digest();
  const expectedHash = createHash2("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}
function bearerToken(request) {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : void 0;
}
function json(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}
function text(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}
async function readBody(request) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ProtocolError(415, "content-type must be application/json", "unsupported_media_type");
  }
  const chunks = [];
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
function parseJsonBody(buffer) {
  if (buffer.length === 0) return {};
  try {
    const value = JSON.parse(buffer.toString("utf8"));
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw new Error("body must be an object");
    }
    return value;
  } catch {
    throw new ProtocolError(400, "request body must be valid JSON object", "invalid_json");
  }
}
async function readJson(request) {
  return parseJsonBody(await readBody(request));
}
function sameWorkflowMessageContext(left, right) {
  if (!left || !right) return left === right;
  return left.schema === right.schema && left.runId === right.runId && left.stageId === right.stageId && left.requirementKey === right.requirementKey && left.attempt === right.attempt;
}
function sameIdempotentRequest(message, target, content, delivery, correlationId, replyTo, hops, maxHops, ttlMs, workflowContext) {
  return (message.to === target || message.toName.toLowerCase() === target.toLowerCase()) && message.content === content && message.delivery === delivery && message.correlationId === correlationId && message.replyTo === replyTo && message.hops === hops && message.maxHops === maxHops && sameWorkflowMessageContext(message.workflowContext, workflowContext) && Date.parse(message.expiresAt) - Date.parse(message.createdAt) === ttlMs;
}
function parseContextAuthority(value) {
  if (typeof value !== "string" || !CONTEXT_AUTHORITIES.includes(value)) {
    throw new ProtocolError(400, "authority must be one of policy, instruction, evidence, hypothesis", "invalid_context_request");
  }
  return value;
}
function parseContextConfidence(value) {
  if (typeof value !== "string" || !CONTEXT_CONFIDENCES.includes(value)) {
    throw new ProtocolError(400, "confidence must be one of verified, probable, uncertain", "invalid_context_request");
  }
  return value;
}
function boundedStringList(value, field, maxItems = 32) {
  if (value === void 0) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new ProtocolError(400, `${field} must be an array with at most ${maxItems} items`);
  }
  return value.map((item, index) => requireString(item, `${field}[${index}]`, { max: 1e3 }));
}
function boundedWorkflowEvidence(value, field = "evidence", maxItems = 64) {
  if (value === void 0) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, `${field} must be an object keyed by required evidence identity`, "invalid_workflow_evidence");
  }
  const entries = Object.entries(value);
  if (entries.length > maxItems) {
    throw new ProtocolError(400, `${field} must contain at most ${maxItems} keyed items`, "invalid_workflow_evidence");
  }
  const evidence = /* @__PURE__ */ new Map();
  for (const [rawRequirement, rawEvidence] of entries) {
    const requirement = canonicalWorkflowEvidenceKey(
      requireString(rawRequirement, `${field} requirement`, { max: 128 })
    );
    if (evidence.has(requirement)) {
      throw new ProtocolError(
        400,
        `${field} contains duplicate normalized requirement identity: ${requirement}`,
        "invalid_workflow_evidence"
      );
    }
    evidence.set(requirement, requireString(rawEvidence, `${field}.${requirement}`, { max: 1e3 }));
  }
  return Object.fromEntries(evidence);
}
function boundedWorkflowEvidenceReferences(value, field = "evidenceRefs", maxItems = 32) {
  if (value === void 0) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, `${field} must be an object keyed by required evidence identity`, "invalid_workflow_evidence_refs");
  }
  const entries = Object.entries(value);
  if (entries.length > maxItems) {
    throw new ProtocolError(400, `${field} must contain at most ${maxItems} requirements`, "invalid_workflow_evidence_refs");
  }
  const references = /* @__PURE__ */ new Map();
  for (const [rawRequirement, rawReference] of entries) {
    const requirement = canonicalWorkflowEvidenceKey(
      requireString(rawRequirement, `${field} requirement`, { max: 128 })
    );
    if (references.has(requirement)) {
      throw new ProtocolError(
        400,
        `${field} contains duplicate normalized requirement identity: ${requirement}`,
        "invalid_workflow_evidence_refs"
      );
    }
    if (!rawReference || typeof rawReference !== "object" || Array.isArray(rawReference)) {
      throw new ProtocolError(400, `${field}.${requirement} must be an object`, "invalid_workflow_evidence_refs");
    }
    const referenceObject = rawReference;
    if (Object.keys(referenceObject).some((key) => key !== "messageIds")) {
      throw new ProtocolError(
        400,
        `${field}.${requirement} may contain only messageIds; provenance is hub-derived`,
        "invalid_workflow_evidence_refs"
      );
    }
    const rawIds = referenceObject.messageIds;
    if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > 16) {
      throw new ProtocolError(
        400,
        `${field}.${requirement}.messageIds must contain between 1 and 16 IDs`,
        "invalid_workflow_evidence_refs"
      );
    }
    const messageIds = rawIds.map((candidate, index) => requireString(candidate, `${field}.${requirement}.messageIds[${index}]`, { max: 80 }));
    if (new Set(messageIds).size !== messageIds.length) {
      throw new ProtocolError(400, `${field}.${requirement}.messageIds must be unique`, "invalid_workflow_evidence_refs");
    }
    references.set(requirement, { messageIds });
  }
  return Object.fromEntries(references);
}
function requestedWorkflowMessageContext(value) {
  if (value === void 0) return void 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "workflowContext must be an object", "invalid_workflow_context");
  }
  const context = value;
  if (Object.keys(context).some((key) => !["runId", "stageId", "requirementKey", "attempt"].includes(key))) {
    throw new ProtocolError(400, "workflowContext contains unsupported fields", "invalid_workflow_context");
  }
  if (context.attempt === void 0) {
    throw new ProtocolError(400, "workflowContext.attempt is required", "invalid_workflow_context");
  }
  return {
    runId: requireString(context.runId, "workflowContext.runId", { max: 80 }),
    stageId: requireString(context.stageId, "workflowContext.stageId", { max: 64 }),
    requirementKey: canonicalWorkflowEvidenceKey(
      requireString(context.requirementKey, "workflowContext.requirementKey", { max: 128 })
    ),
    attempt: parseBoundedInteger(context.attempt, "workflowContext.attempt", 1, 1, 20)
  };
}
function validateWorkflowSignalContext(evidence, runId, stageId, signalKey) {
  const expectedContext = {
    "workflow.run": runId,
    "workflow.stage": stageId,
    "workflow.signal": signalKey
  };
  for (const [contextKey, expectedValue] of Object.entries(expectedContext)) {
    const suppliedValue = evidence[contextKey];
    if (suppliedValue === void 0 || suppliedValue === expectedValue) continue;
    throw new ProtocolError(
      409,
      `evidence ${contextKey} does not match the workflow signal route and active wait`,
      "workflow_signal_context_mismatch",
      { contextKey }
    );
  }
}
function workflowSignalKey(value) {
  const key = requireString(value, "signalKey", { max: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key)) {
    throw new ProtocolError(400, "signalKey may contain letters, numbers, dot, underscore, colon, and hyphen", "invalid_signal_key");
  }
  return key;
}
function createMeshHub(options = {}) {
  const host2 = options.host ?? "127.0.0.1";
  const port2 = options.port ?? 7331;
  const authToken2 = options.authToken?.trim();
  const projectTokens2 = Object.fromEntries(
    Object.entries(options.projectTokens ?? {}).map(([project, token]) => [project, token.trim()])
  );
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const defaultMessageTtlMs = options.messageTtlMs ?? DEFAULT_MESSAGE_TTL_MS;
  const messageRetentionMs2 = options.messageRetentionMs ?? DEFAULT_MESSAGE_RETENTION_MS;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? Math.max(250, Math.floor(staleAfterMs / 3));
  const shutdownGraceMs = options.shutdownGraceMs ?? 5e3;
  const rateLimit = options.rateLimit === false ? void 0 : {
    windowMs: options.rateLimit?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
    maxRequests: options.rateLimit?.maxRequests ?? DEFAULT_RATE_LIMIT_MAX
  };
  const webhookWorkflows2 = new Map((options.webhookWorkflows ?? []).map((workflow) => [workflow.id, workflow]));
  const logger = options.logger ?? (() => void 0);
  const assetsDir2 = options.assetsDir;
  const store = new MeshStore(options.dataPath);
  const agents = store.agents;
  const messages = store.messages;
  function agentLogSide(id, fallbackName, side) {
    const agent = agents.get(id);
    return {
      [side]: id,
      [`${side}Name`]: agent?.name ?? fallbackName,
      [`${side}Online`]: Boolean(agent?.online),
      ...agent?.model ? { [`${side}Model`]: agent.model } : {}
    };
  }
  function messageLog(message, fromId, fromName, toId, toName) {
    return {
      project: message.project,
      status: message.status,
      delivery: message.delivery,
      ...agentLogSide(fromId, fromName, "from"),
      ...agentLogSide(toId, toName, "to")
    };
  }
  const workflowRuns = store.workflowRuns;
  const journal = store.journal;
  const stateProvider = new NativeStateProvider(store);
  const streams = /* @__PURE__ */ new Map();
  const opsStreams = /* @__PURE__ */ new Set();
  const rateBuckets = /* @__PURE__ */ new Map();
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
    contextRequests: 0
  };
  let cleanupTimer;
  let closed = false;
  function exportTerminalRetrospective(run) {
    if (!assetsDir2 || run.status !== "completed" && run.status !== "failed") return;
    try {
      const entries = [...journal.values()].filter((entry) => entry.runId === run.id);
      const files = writeRetrospective(`${assetsDir2}${process.platform === "win32" ? "\\" : "/"}retrospectives`, buildRetrospective(run, entries, run.updatedAt));
      logger({ event: "workflow_retrospective_exported", workflowRunId: run.id, jsonPath: files.jsonPath, markdownPath: files.mdPath });
    } catch (error) {
      logger({ event: "workflow_retrospective_export_failed", workflowRunId: run.id, error: error instanceof Error ? error.message : "retrospective_export_failed" });
    }
  }
  if (!isLoopback(host2) && !authToken2) {
    store.close();
    throw new Error("KXM_AUTH_TOKEN is required when binding beyond localhost");
  }
  if (staleAfterMs < 100 || defaultMessageTtlMs < MIN_MESSAGE_TTL_MS || messageRetentionMs2 < MIN_MESSAGE_RETENTION_MS || shutdownGraceMs < 0) {
    store.close();
    throw new Error("stale and message TTL settings are below supported minimums");
  }
  if (rateLimit && (rateLimit.windowMs < 100 || rateLimit.maxRequests < 1)) {
    store.close();
    throw new Error("rate limit settings are invalid");
  }
  if (webhookWorkflows2.size !== (options.webhookWorkflows ?? []).length) {
    store.close();
    throw new Error("webhook workflow IDs must be unique");
  }
  for (const agent of agents.values()) {
    agent.online = false;
    store.saveAgent(agent);
  }
  for (const message of messages.values()) {
    const legacy = message;
    if (!legacy.expiresAt) {
      legacy.expiresAt = new Date(Date.parse(message.createdAt) + defaultMessageTtlMs).toISOString();
      store.saveMessage(message);
    }
  }
  function expectedProjectToken(project) {
    return projectTokens2[project] || authToken2;
  }
  function requireProjectAuth(request, project) {
    const expected = expectedProjectToken(project);
    if (!expected) return;
    if (!safeTokenEqual(bearerToken(request), expected)) {
      throw new ProtocolError(401, "invalid project authentication token", "invalid_auth", {
        operation: "other",
        nextAction: "check_project_token"
      });
    }
  }
  function contextCallerProject(request, requested) {
    const project = requireString(requested, "project", { max: 200 });
    const agentHeader = request.headers["x-mesh-agent-id"];
    if (typeof agentHeader === "string" && agentHeader.trim()) {
      const agent = requireAgent(request);
      requireProjectAuth(request, agent.project);
      if (agent.project !== project) {
        throw new ProtocolError(403, "context requests are limited to the agent's project", "context_isolation_violation");
      }
      return { project, caller: agent.id };
    }
    requireAdminAuth(request);
    return { project, caller: "mesh-admin" };
  }
  function requireAdminAuth(request) {
    if (!authToken2 && isLoopback(host2)) return;
    if (!authToken2 || !safeTokenEqual(bearerToken(request), authToken2)) {
      throw new ProtocolError(401, "invalid administrative authentication token", "invalid_auth", {
        operation: "other",
        nextAction: "check_project_token"
      });
    }
  }
  function requireConfiguredAdminAuth(request, purpose = "workflow degradation approval") {
    if (!authToken2) {
      throw new ProtocolError(
        503,
        `KXM_AUTH_TOKEN must be configured for ${purpose}`,
        "admin_auth_not_configured"
      );
    }
    requireAdminAuth(request);
  }
  function requireAgent(request, expectedId) {
    const agentId = expectedId ?? String(request.headers["x-mesh-agent-id"] ?? "");
    const agentKey = String(request.headers["x-mesh-agent-key"] ?? "");
    const agent = agents.get(agentId);
    if (!agent || !agentKey || !safeTokenEqual(agentKey, agent.key)) {
      throw new ProtocolError(401, "invalid agent identity", "invalid_agent_identity", {
        operation: "other",
        nextAction: "reconnect_with_current_agent_key"
      });
    }
    const wasOffline = !agent.online;
    agent.lastSeenAt = nowIso();
    agent.online = true;
    store.saveAgent(agent);
    if (wasOffline) broadcastPresence(agent);
    return agent;
  }
  function checkRateLimit(request, response) {
    if (!rateLimit) return;
    const key = String(request.headers["x-mesh-agent-id"] ?? request.socket.remoteAddress ?? "unknown");
    const now = Date.now();
    const current = rateBuckets.get(key);
    const bucket = !current || now - current.startedAt >= rateLimit.windowMs ? { startedAt: now, count: 0 } : current;
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    const remaining = Math.max(0, rateLimit.maxRequests - bucket.count);
    response.setHeader("x-ratelimit-limit", String(rateLimit.maxRequests));
    response.setHeader("x-ratelimit-remaining", String(remaining));
    if (bucket.count > rateLimit.maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.startedAt + rateLimit.windowMs - now) / 1e3));
      response.setHeader("retry-after", String(retryAfterSeconds));
      throw new ProtocolError(429, "request rate limit exceeded", "rate_limited");
    }
  }
  function publish(agentId, event) {
    const clients = streams.get(agentId);
    if (!clients || clients.size === 0) return false;
    let frame;
    let published = false;
    for (const client of clients) {
      if (client.presenceOnly && event.type !== "presence") continue;
      frame ??= `event: ${event.type}
data: ${JSON.stringify(event)}

`;
      client.response.write(frame);
      published = true;
    }
    return published;
  }
  function publishOps(project, topic) {
    const frame = `event: ops
data: ${JSON.stringify({ type: "ops", project, topic, at: nowIso() })}

`;
    for (const client of opsStreams) {
      if (client.project === project) client.response.write(frame);
    }
  }
  function opsSnapshot(project) {
    const projectAgents = [...agents.values()].filter((agent) => agent.project === project).map(publicAgent).sort((left, right) => Number(right.online) - Number(left.online) || left.name.localeCompare(right.name));
    const open = [...messages.values()].filter((message) => message.project === project && (message.status === "queued" || message.status === "delivered")).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    const projectRuns = [...workflowRuns.values()].filter((run) => run.project === project).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
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
        ...message.correlationId ? { correlationId: message.correlationId } : {}
      })),
      openMessageTotal: open.length,
      runs: projectRuns.slice(0, 8).map((run) => {
        const stages = (run.stages ?? []).slice(0, 16).map((stage) => ({
          id: stage.id,
          label: stage.label,
          status: stage.status,
          ...stage.attempts ? { attempts: stage.attempts } : {}
        }));
        const done = stages.filter((stage) => stage.status === "passed" || stage.status === "failed" || stage.status === "warning").length;
        return {
          id: run.id,
          status: run.status,
          definitionId: run.definitionId,
          project: run.project,
          ...run.currentStage ? { currentStage: run.currentStage } : {},
          ...run.targetAgentName ? { targetAgentName: run.targetAgentName } : {},
          ...run.updatedAt ? { updatedAt: run.updatedAt } : {},
          ...stages.length > 0 ? { progress: { done, total: stages.length }, stages } : {}
        };
      }),
      runTotal: projectRuns.length,
      plans: [...journal.values()].filter((entry) => entry.category === "plan" && projectRuns.some((run) => run.id === entry.runId)).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).slice(0, 16).map((entry) => ({
        id: entry.id,
        runId: entry.runId,
        summary: entry.summary.replace(/\s+/g, " ").trim().slice(0, 120),
        createdAt: entry.createdAt,
        ...entry.stageId ? { stageId: entry.stageId } : {},
        ...entry.severity ? { severity: entry.severity } : {}
      }))
    };
  }
  function broadcastPresence(agent) {
    for (const candidate of agents.values()) {
      if (candidate.project === agent.project && candidate.id !== agent.id && candidate.online) {
        publish(candidate.id, { type: "presence", agent: publicAgent(agent) });
      }
    }
    publishOps(agent.project, "agents");
  }
  function findTarget(project, target) {
    const byId = agents.get(target);
    if (byId?.project === project && byId.online) return byId;
    const byName = [...agents.values()].find(
      (agent) => agent.project === project && agent.online && agent.name.toLowerCase() === target.toLowerCase()
    );
    if (!byName) throw new ProtocolError(404, `online target not found: ${target}`, "target_not_found");
    return byName;
  }
  function findKnownTarget(project, target) {
    const byId = agents.get(target);
    if (byId?.project === project) return byId;
    const byName = [...agents.values()].find(
      (agent) => agent.project === project && agent.name.toLowerCase() === target.toLowerCase()
    );
    if (!byName) {
      throw new ProtocolError(409, `workflow target has not registered: ${target}`, "workflow_target_unavailable");
    }
    return byName;
  }
  function resolveStageEvidencePolicies(stage, project, coordinator) {
    if (!stage.evidencePolicies) return void 0;
    const resolved = /* @__PURE__ */ new Map();
    for (const [requirementKey, policy] of Object.entries(stage.evidencePolicies)) {
      const eligible = /* @__PURE__ */ new Map();
      for (const selector of policy.eligibleAgents) {
        const agent = findKnownTarget(project, selector);
        if (agent.id === coordinator.id) {
          throw new ProtocolError(
            409,
            `workflow evidence policy ${stage.id}/${requirementKey} cannot include the coordinator`,
            "workflow_evidence_policy_invalid"
          );
        }
        eligible.set(agent.id, { id: agent.id, name: agent.name });
      }
      if (eligible.size < policy.minProducers) {
        throw new ProtocolError(
          409,
          `workflow evidence policy ${stage.id}/${requirementKey} resolves to ${eligible.size} unique producers but requires ${policy.minProducers}`,
          "workflow_evidence_policy_unresolvable"
        );
      }
      resolved.set(requirementKey, {
        kind: "peer-reply",
        minProducers: policy.minProducers,
        eligibleProducers: [...eligible.values()],
        acceptedStatuses: ["replied"],
        ...policy.degradation ? { degradation: { ...policy.degradation } } : {}
      });
    }
    return Object.fromEntries(resolved);
  }
  function authorizeWorkflowMessageContext(sender, targetInput, requested) {
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
        "workflow_evidence_policy_missing"
      );
    }
    if (requested.attempt !== stage.attempts + 1) {
      throw new ProtocolError(
        409,
        `workflow context attempt ${requested.attempt} does not match active attempt ${stage.attempts + 1}`,
        "workflow_context_attempt_mismatch"
      );
    }
    const normalizedTarget = targetInput.toLowerCase();
    const eligible = policy.eligibleProducers.find(
      (producer) => producer.id === targetInput || producer.name.toLowerCase() === normalizedTarget
    );
    if (!eligible) {
      throw new ProtocolError(
        403,
        `target ${targetInput} is not eligible for workflow evidence ${requirementKey}`,
        "workflow_evidence_producer_forbidden"
      );
    }
    return {
      schema: "pi-mesh.workflow-message-context.v1",
      runId: run.id,
      stageId: stage.id,
      requirementKey,
      attempt: requested.attempt
    };
  }
  function webhookEvent(request, payload) {
    const header = request.headers["x-github-event"];
    if (typeof header === "string" && header.trim()) return header.trim();
    const candidate = payload.webhookEvent ?? payload.event;
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : void 0;
  }
  function verifyWebhookSignature(request, body, secret) {
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
  function workflowPrompt(definition, runId, payload) {
    const rendered = renderWorkflowPrompt(definition.promptTemplate, payload);
    const stageList = definition.stages.map((stage, index) => {
      const peerPolicies = Object.entries(stage.evidencePolicies ?? {}).map(([requirement, policy]) => `   Peer evidence ${requirement}: ${policy.minProducers} unique replied producer(s) from ${policy.eligibleAgents.join(", ")}`);
      return [
        `${index + 1}. ${stage.label} (stageId: ${stage.id}, maxAttempts: ${stage.maxAttempts})`,
        `   ${stage.instructions}`,
        `   Required evidence keys: ${stage.requiredEvidence.join(", ") || "none"}`,
        ...peerPolicies
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
      "Do not claim the workflow is complete until the checkpoint response reports completed=true."
    ].join("\n");
  }
  function createWorkflowResumeMessage(run, definition, deliveryId, signalKey, status, summary, evidence, retry) {
    const createdAt = nowIso();
    const ttlMs = parseBoundedInteger(
      definition.ttlMs,
      "workflow.ttlMs",
      defaultMessageTtlMs,
      MIN_MESSAGE_TTL_MS,
      MAX_MESSAGE_TTL_MS
    );
    const nextInstruction = retry ? `Correct the ${status} result, rerun the external check, then wait for a new signal or checkpoint the stage.` : `Continue with stage ${run.currentStage}.`;
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
      "Do not claim the workflow is complete until the checkpoint response reports completed=true."
    ].join("\n"), "workflow resume prompt", { max: MAX_CONTENT_CHARS });
    const message = {
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
      status: "queued"
    };
    run.messageId = message.id;
    run.updatedAt = createdAt;
    return message;
  }
  function expireWorkflowWaits() {
    const timestamp = nowIso();
    const now = Date.parse(timestamp);
    for (const run of workflowRuns.values()) {
      if (run.status !== "waiting" || !run.waiting || Date.parse(run.waiting.expiresAt) > now) continue;
      const transition = structuredClone(run);
      const waiting = transition.waiting;
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
      const entry = {
        id: newId("journal"),
        runId: transition.id,
        agentId: transition.targetAgentId,
        category: "error",
        area: stage?.area ?? "harness",
        severity: "error",
        summary: `External workflow signal timed out: ${waiting.signalKey}`,
        evidence: [`wait-created:${waiting.createdAt}`, `wait-expired:${waiting.expiresAt}`],
        relatedEntryIds: [],
        createdAt: timestamp
      };
      const definition = webhookWorkflows2.get(transition.definitionId);
      const ttlMs = parseBoundedInteger(
        definition?.ttlMs,
        "workflow.ttlMs",
        defaultMessageTtlMs,
        MIN_MESSAGE_TTL_MS,
        MAX_MESSAGE_TTL_MS
      );
      const message = {
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
          "Review whether the external action completed, record any follow-up outside this terminal run, and escalate or start a new retry-safe workflow only when appropriate."
        ].join("\n"),
        delivery: definition?.delivery ?? "followUp",
        hops: 0,
        maxHops: DEFAULT_MAX_HOPS,
        correlationId: transition.id,
        workflowRunId: transition.id,
        idempotencyKey: `${transition.definitionId}:timeout:${waiting.signalKey}:${waiting.expiresAt}`,
        createdAt: timestamp,
        expiresAt: new Date(Date.parse(timestamp) + ttlMs).toISOString(),
        status: "queued"
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
        messageId: message.id
      });
    }
  }
  function flushPending(agentId) {
    expireMessages();
    for (const message of messages.values()) {
      if (message.to === agentId && (message.status === "queued" || message.status === "delivered")) {
        publish(agentId, { type: "message", message });
      }
    }
  }
  function expireMessages() {
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
          (candidate) => candidate.messageId === message.id && candidate.status === "running"
        );
        if (run) {
          run.status = "failed";
          delete run.currentStage;
          run.updatedAt = nowIso();
          store.saveWorkflowRun(run);
          publishOps(run.project, "workflows");
          const entry = {
            id: newId("journal"),
            runId: run.id,
            agentId: run.targetAgentId,
            category: "error",
            area: "harness",
            severity: "error",
            summary: "Workflow coordinator prompt expired before completion",
            evidence: [`message:${message.id}`],
            relatedEntryIds: [],
            createdAt: run.updatedAt
          };
          store.saveJournalEntry(entry);
          counters.journalEntries += 1;
          exportTerminalRetrospective(run);
        }
      }
    }
  }
  function purgeTerminalMessages() {
    const cutoff = Date.now() - messageRetentionMs2;
    for (const message of messages.values()) {
      const terminal = message.status === "replied" || message.status === "cancelled" || message.status === "expired" || message.status === "error";
      if (!terminal) continue;
      const terminalAt = message.repliedAt ?? message.cancelledAt ?? message.expiresAt ?? message.createdAt;
      if (Date.parse(terminalAt) > cutoff) continue;
      store.deleteMessage(message.id);
      publishOps(message.project, "messages");
      counters.messagesPurged += 1;
      logger({ event: "message_purged", messageId: message.id, ...messageLog(message, message.from, message.fromName, message.to, message.toName) });
    }
  }
  function metricsBody() {
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
      "# TYPE pi_kxm_workflow_checkpoints_total counter",
      `pi_kxm_workflow_checkpoints_total ${counters.workflowCheckpoints}`,
      "# TYPE pi_kxm_workflow_waits_total counter",
      `pi_kxm_workflow_waits_total ${counters.workflowWaits}`,
      "# TYPE pi_mesh_workflow_signals_total counter",
      `pi_mesh_workflow_signals_total ${counters.workflowSignals}`,
      "# TYPE pi_kxm_workflow_wait_timeouts_total counter",
      `pi_kxm_workflow_wait_timeouts_total ${counters.workflowWaitTimeouts}`,
      "# TYPE pi_mesh_workflow_degradations_total counter",
      `pi_mesh_workflow_degradations_total ${counters.workflowDegradations}`,
      "# TYPE pi_mesh_workflow_journal_entries_total counter",
      `pi_mesh_workflow_journal_entries_total ${counters.journalEntries}`,
      ""
    ].join("\n");
  }
  const server = createServer(async (request, response) => {
    const requestIdHeader = request.headers["x-request-id"];
    const requestId = typeof requestIdHeader === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(requestIdHeader) ? requestIdHeader : newId("req");
    response.setHeader("x-request-id", requestId);
    response.setHeader("referrer-policy", "no-referrer");
    counters.requests += 1;
    try {
      let projectContextPool2 = function(project, journalCategories) {
        const pool = store.listContextItems(project);
        const categoryFilter = journalCategories ? new Set(journalCategories) : void 0;
        const runIds = new Set(
          [...workflowRuns.values()].filter((run) => run.project === project).map((run) => run.id)
        );
        const contradictionIds = [];
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
      }, contextWikiPool2 = function(project, compiledAt) {
        const { pool, contradictionIds } = projectContextPool2(project);
        const stateItems = store.listContextItems(project, ["state"]);
        const contradictions = stateProvider.contradictions().filter((entry) => entry.project === project);
        return {
          project,
          stateItems,
          contextItems: pool,
          contradictions,
          openContradictionItemIds: contradictionIds,
          compiledAt
        };
      };
      var projectContextPool = projectContextPool2, contextWikiPool = contextWikiPool2;
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
        const definitionId = decodeURIComponent(signalMatch[1]);
        const runId = decodeURIComponent(signalMatch[2]);
        const signalKey = workflowSignalKey(decodeURIComponent(signalMatch[3]));
        const definition = webhookWorkflows2.get(definitionId);
        if (!definition) throw new ProtocolError(404, "webhook workflow not found", "webhook_not_found");
        const rawBody = await readBody(request);
        verifyWebhookSignature(request, rawBody, definition.signalSecret ?? definition.secret);
        const body = parseJsonBody(rawBody);
        const run = workflowRuns.get(runId);
        if (!run || run.definitionId !== definition.id) {
          throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        }
        const deliveryHeader = request.headers["x-atlassian-webhook-identifier"] ?? request.headers["x-github-delivery"] ?? request.headers["x-mesh-delivery-id"];
        const deliveryId = requireString(deliveryHeader, "webhook delivery identifier", { max: 128 });
        const payloadHash = createHash2("sha256").update(rawBody).digest("hex");
        const existingReceipt = run.signalReceipts?.find((receipt2) => receipt2.deliveryId === deliveryId);
        if (existingReceipt) {
          if (existingReceipt.signalKey !== signalKey || existingReceipt.payloadHash !== payloadHash) {
            throw new ProtocolError(
              409,
              "webhook delivery identifier was already used for a different signal",
              "workflow_signal_delivery_conflict"
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
            resumed: Boolean(existingReceipt.messageId)
          });
          return;
        }
        expireWorkflowWaits();
        const status = requireString(body.status, "status", { max: 16 });
        if (status !== "passed" && status !== "warning" && status !== "failed") {
          throw new ProtocolError(400, "status must be passed, warning, or failed", "invalid_checkpoint_status");
        }
        const summary = requireString(body.summary, "summary", { max: 4e3 });
        const evidence = boundedWorkflowEvidence(body.evidence);
        const receivedAt = nowIso();
        const transition = structuredClone(workflowRuns.get(runId));
        if (transition.status === "waiting" && transition.waiting) {
          validateWorkflowSignalContext(
            evidence,
            runId,
            transition.waiting.stageId,
            signalKey
          );
        }
        const result = resumeWorkflowFromSignal(transition, signalKey, status, summary, evidence, receivedAt);
        const receipt = {
          deliveryId,
          payloadHash,
          signalKey,
          stageId: result.stageId,
          status,
          receivedAt
        };
        if (result.degraded) {
          const degradedStage = transition.stages.find((candidate) => candidate.id === result.stageId);
          receipt.degraded = true;
          receipt.degradedRequirements = [...degradedStage.degradedRequirements ?? []];
        }
        (transition.signalReceipts ??= []).push(receipt);
        let message;
        let entry;
        if (status !== "passed") {
          const stage = transition.stages.find((candidate) => candidate.id === result.stageId);
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
            createdAt: receivedAt
          };
        } else if (result.degraded) {
          const stage = transition.stages.find((candidate) => candidate.id === result.stageId);
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
              ...(stage.degradedRequirements ?? []).map((requirement) => `requirement:${requirement}`)
            ],
            relatedEntryIds: [],
            createdAt: receivedAt
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
            result.retry
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
          ...message ? { messageId: message.id } : {}
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
          resumed: Boolean(message)
        });
        return;
      }
      const webhookMatch = url.pathname.match(/^\/v1\/webhooks\/([^/]+)$/);
      if (method === "POST" && webhookMatch) {
        const definitionId = decodeURIComponent(webhookMatch[1]);
        const definition = webhookWorkflows2.get(definitionId);
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
        const deliveryHeader = request.headers["x-atlassian-webhook-identifier"] ?? request.headers["x-github-delivery"] ?? request.headers["x-mesh-delivery-id"];
        const deliveryId = requireString(deliveryHeader, "webhook delivery identifier", { max: 128 });
        const existing = [...workflowRuns.values()].find(
          (run2) => run2.definitionId === definition.id && run2.deliveryId === deliveryId
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
          MAX_MESSAGE_TTL_MS
        );
        const content = requireString(workflowPrompt(definition, runId, payload), "workflow prompt", {
          max: MAX_CONTENT_CHARS
        });
        const message = {
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
          status: "queued"
        };
        const stages = definition.stages.map((stage, index) => {
          const resolvedEvidencePolicies = resolveStageEvidencePolicies(stage, definition.project, target);
          return {
            ...stage,
            ...resolvedEvidencePolicies ? { resolvedEvidencePolicies } : {},
            status: index === 0 ? "in_progress" : "pending",
            attempts: 0,
            evidence: {},
            ...index === 0 ? { startedAt: createdAt, updatedAt: createdAt } : {}
          };
        });
        const run = {
          id: runId,
          definitionId: definition.id,
          source: definition.source,
          deliveryId,
          payloadHash: createHash2("sha256").update(rawBody).digest("hex"),
          definitionHash: workflowDefinitionHash(definition),
          ...event ? { event } : {},
          project: definition.project,
          targetAgentId: target.id,
          targetAgentName: target.name,
          messageId: message.id,
          status: "running",
          currentStage: stages[0].id,
          stages,
          ...definition.maxTransitions !== void 0 ? { maxTransitions: definition.maxTransitions } : {},
          ...definition.reproOracle ? { reproOracle: definition.reproOracle } : {},
          ...definition.planHash ? { planHashConfig: definition.planHash } : {},
          ...definition.requirePlanHash ? { requirePlanHash: definition.requirePlanHash } : {},
          createdAt,
          updatedAt: createdAt
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
          target: target.id
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
          "x-content-type-options": "nosniff"
        });
        response.write(`event: ready
data: ${JSON.stringify({ type: "ops", project, topic: "agents", at: nowIso() })}

`);
        const client = {
          project,
          response,
          heartbeat: setInterval(() => response.write(": heartbeat\n\n"), 15e3)
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
          (run) => run.project === agent.project && run.targetAgentId === agent.id
        );
        json(response, 200, { runs });
        return;
      }
      const workflowMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)$/);
      if (method === "GET" && workflowMatch) {
        expireWorkflowWaits();
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const run = workflowRuns.get(decodeURIComponent(workflowMatch[1]));
        if (!run) throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        if (run.project !== agent.project || run.targetAgentId !== agent.id) {
          throw new ProtocolError(
            403,
            "workflow run is not visible to this agent",
            "workflow_forbidden",
            workflowScopeExtras("get", run.targetAgentName)
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
        const run = workflowRuns.get(decodeURIComponent(degradationMatch[1]));
        if (!run) throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        const stageId = requireString(body.stageId, "stageId", { max: 64 });
        const requirementKey = canonicalWorkflowEvidenceKey(
          requireString(body.requirementKey, "requirementKey", { max: 128 })
        );
        const reason = requireString(body.reason, "reason", { max: 1e3 });
        const timestamp = nowIso();
        const transition = structuredClone(run);
        const result = approveWorkflowDegradation(
          transition,
          stageId,
          requirementKey,
          reason,
          newId("approval"),
          timestamp
        );
        if (result.created) {
          const stage = transition.stages.find((candidate) => candidate.id === stageId);
          const entry = {
            id: newId("journal"),
            runId: transition.id,
            agentId: "mesh-admin",
            category: "decision",
            area: stage.area ?? "security",
            severity: "warning",
            summary: `Approved degraded peer quorum for ${stageId}/${requirementKey} attempt ${result.approval.attempt}`,
            details: reason,
            evidence: [
              "class:workflow_quorum_degradation_approved",
              `approval:${result.approval.id}`,
              `policy-min:${result.approval.policyMinProducers}`,
              `approved-min:${result.approval.approvedMinProducers}`
            ],
            relatedEntryIds: [],
            createdAt: timestamp
          };
          store.saveWorkflowTransition(transition, void 0, entry);
          publishOps(transition.project, "workflows");
          counters.workflowDegradations += 1;
          counters.journalEntries += 1;
          logger({
            event: "workflow_degradation_approved",
            workflowRunId: transition.id,
            stageId,
            requirementKey,
            attempt: result.approval.attempt,
            approvalId: result.approval.id
          });
        }
        json(response, result.created ? 201 : 200, {
          run: result.created ? transition : run,
          approval: result.approval,
          duplicate: !result.created
        });
        return;
      }
      const contextGetMatch = url.pathname.match(/^\/v1\/context\/get$/);
      if (method === "POST" && contextGetMatch) {
        const body = await readJson(request);
        const { project: callerProject, caller: callerId } = contextCallerProject(request, body.project);
        const policy = rolePolicy(typeof body.role === "string" ? body.role : "");
        const { pool, contradictionIds } = projectContextPool2(callerProject, policy.journalCategories);
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
          excludedSuperseded: outcome.audit.excludedSuperseded
        });
        json(response, 200, { packet: outcome.packet, audit: outcome.audit });
        return;
      }
      const contextRecallMatch = url.pathname.match(/^\/v1\/context\/recall$/);
      if (method === "POST" && contextRecallMatch) {
        const body = await readJson(request);
        const { project: callerProject, caller: callerId } = contextCallerProject(request, body.project);
        const query = requireString(body.query ?? "", "query", { max: 500, allowEmpty: true }).toLowerCase();
        const kinds = Array.isArray(body.kinds) ? body.kinds.filter((kind) => typeof kind === "string") : void 0;
        const limit = parseBoundedInteger(body.limit, "limit", 25, 1, 100);
        const { pool } = projectContextPool2(callerProject);
        const recalled = pool.filter((item) => item.status !== "superseded" && item.status !== "rejected").filter((item) => kinds === void 0 || kinds.includes(item.kind)).filter((item) => query === "" || item.summary.toLowerCase().includes(query) || (item.stateKey ?? "").toLowerCase().includes(query)).sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit);
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
        const asOf = body.asOf === void 0 || body.asOf === null ? void 0 : requireString(body.asOf, "asOf", { max: 64 });
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
          summary: requireString(body.summary, "summary", { max: 4e3 }),
          authority: parseContextAuthority(body.authority),
          confidence: parseContextConfidence(body.confidence),
          evidenceRefs: boundedStringList(body.evidenceRefs, "evidenceRefs", 32),
          proposedBy: callerId
        });
        counters.contextRequests += 1;
        publishOps(callerProject, "workflows");
        logger({ event: "context_state_proposed", project: callerProject, proposalId, proposedBy: callerId });
        json(response, 201, { proposalId });
        return;
      }
      const contextStatePromoteMatch = url.pathname.match(/^\/v1\/context\/state\/promote$/);
      if (method === "POST" && contextStatePromoteMatch) {
        requireAdminAuth(request);
        const body = await readJson(request);
        const proposalId = requireString(body.proposalId, "proposalId", { max: 128 });
        const project = requireString(body.project, "project", { max: 200 });
        const evidence = boundedStringList(body.evidence, "evidence", 32);
        const promoted = await stateProvider.promote(proposalId, evidence, "mesh-admin");
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
        const runId = body.workflowRunId === void 0 || body.workflowRunId === null ? void 0 : requireString(body.workflowRunId, "workflowRunId", { max: 128 });
        const runIds = new Set(
          [...workflowRuns.values()].filter((run) => run.project === callerProject && (runId === void 0 || run.id === runId)).map((run) => run.id)
        );
        const episodes = [...journal.values()].filter((entry) => runIds.has(entry.runId)).filter((entry) => entry.category === "error" || entry.category === "lesson" || entry.category === "observation" || entry.category === "experiment").sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).map((entry) => journalEntryToContextItem(entry, callerProject)).slice(0, 50);
        counters.contextRequests += 1;
        json(response, 200, { episodes });
        return;
      }
      const contextExplainMatch = url.pathname.match(/^\/v1\/context\/explain$/);
      if (method === "POST" && contextExplainMatch) {
        const body = await readJson(request);
        const { project: callerProject, caller: callerId } = contextCallerProject(request, body.project);
        const id = requireString(body.id, "id", { max: 128 });
        const { pool } = projectContextPool2(callerProject);
        const explanation = explainContextItem(id, pool);
        counters.contextRequests += 1;
        json(response, 200, {
          found: explanation.item !== void 0,
          lineage: explanation.lineage,
          evidenceRefs: explanation.evidenceRefs,
          sources: explanation.sources
        });
        return;
      }
      const contextWikiCompileMatch = url.pathname.match(/^\/v1\/context\/wiki\/compile$/);
      if (method === "POST" && contextWikiCompileMatch) {
        const body = await readJson(request);
        const { project: callerProject } = contextCallerProject(request, body.project);
        const wikiPool = contextWikiPool2(callerProject, nowIso());
        const wiki = compileKnowledgeWiki(wikiPool);
        counters.contextRequests += 1;
        logger({
          event: "context_wiki_compiled",
          project: callerProject,
          pages: wiki.audit.pages.length,
          contradictions: wiki.audit.contradictions
        });
        json(response, 200, {
          audit: wiki.audit,
          lint: lintKnowledgeWiki(wiki.pages, wikiPool),
          pages: [...wiki.pages].sort(([left], [right]) => left.localeCompare(right)).map(([path, content]) => ({ path, content }))
        });
        return;
      }
      const journalPromotionMatch = url.pathname.match(/^\/v1\/journal\/([^/]+)\/promotion$/);
      if (method === "POST" && journalPromotionMatch) {
        requireAdminAuth(request);
        const body = await readJson(request);
        const entryId = decodeURIComponent(journalPromotionMatch[1]);
        const entry = journal.get(entryId);
        if (!entry) throw new ProtocolError(404, "journal entry not found", "journal_not_found");
        const to = requireString(body.to, "to", { max: 24 });
        if (to !== "approved" && to !== "rejected" && to !== "quarantined") {
          throw new ProtocolError(
            400,
            "journal promotion target must be approved, rejected, or quarantined",
            "invalid_journal_promotion"
          );
        }
        const evidenceRefs = boundedStringList(body.evidenceRefs, "evidenceRefs", 32);
        const updated = applyJournalPromotion(
          entry,
          {
            to,
            evidenceRefs,
            decidedBy: "mesh-admin",
            reason: requireString(body.reason, "reason", { max: 1e3 })
          },
          nowIso()
        );
        store.saveJournalEntry(updated);
        publishOps(entry.runId, "workflows");
        logger({
          event: "journal_promotion_recorded",
          journalEntryId: entry.id,
          workflowRunId: entry.runId,
          category: entry.category,
          to
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
        const run = workflowRuns.get(decodeURIComponent(waitMatch[1]));
        if (!run) throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        if (run.project !== agent.project || run.targetAgentId !== agent.id) {
          throw new ProtocolError(
            403,
            "only the assigned coordinator can wait this workflow",
            "workflow_forbidden",
            workflowScopeExtras("wait", run.targetAgentName)
          );
        }
        const stageId = requireString(body.stageId, "stageId", { max: 64 });
        const signalKey = workflowSignalKey(body.signalKey);
        const summary = requireString(body.summary, "summary", { max: 4e3 });
        const evidence = boundedWorkflowEvidence(body.evidence);
        const evidenceRefs = boundedWorkflowEvidenceReferences(body.evidenceRefs);
        const timeoutMs = parseBoundedInteger(
          body.timeoutMs,
          "timeoutMs",
          DEFAULT_WORKFLOW_WAIT_TIMEOUT_MS,
          MIN_WORKFLOW_WAIT_TIMEOUT_MS,
          MAX_WORKFLOW_WAIT_TIMEOUT_MS
        );
        const createdAt = nowIso();
        const transition = structuredClone(run);
        const stage = transition.stages.find((candidate) => candidate.id === stageId);
        const verifiedEvidence = stage && Object.keys(evidenceRefs).length ? verifyWorkflowEvidenceReferences(
          transition,
          stage,
          evidenceRefs,
          { getMessage: (messageId) => messages.get(messageId) },
          createdAt
        ) : {};
        waitForWorkflowSignal(
          transition,
          stageId,
          signalKey,
          summary,
          createdAt,
          new Date(Date.parse(createdAt) + timeoutMs).toISOString(),
          evidence,
          verifiedEvidence
        );
        store.saveWorkflowTransition(transition);
        publishOps(transition.project, "workflows");
        counters.workflowWaits += 1;
        logger({
          event: "workflow_wait_started",
          workflowRunId: transition.id,
          stageId,
          signalKey,
          expiresAt: transition.waiting?.expiresAt
        });
        json(response, 202, {
          run: transition,
          instruction: "The agent may now settle this turn. A signed external signal will checkpoint the stage and resume the coordinator when more work is required."
        });
        return;
      }
      const checkpointMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/checkpoints$/);
      if (method === "POST" && checkpointMatch) {
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const body = await readJson(request);
        const run = workflowRuns.get(decodeURIComponent(checkpointMatch[1]));
        if (!run) throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        if (run.project !== agent.project || run.targetAgentId !== agent.id) {
          throw new ProtocolError(
            403,
            "only the assigned coordinator can checkpoint this workflow",
            "workflow_forbidden",
            workflowScopeExtras("checkpoint", run.targetAgentName)
          );
        }
        const stageId = requireString(body.stageId, "stageId", { max: 64 });
        const status = requireString(body.status, "status", { max: 16 });
        if (status !== "passed" && status !== "warning" && status !== "failed") {
          throw new ProtocolError(400, "status must be passed, warning, or failed", "invalid_checkpoint_status");
        }
        const summary = requireString(body.summary, "summary", { max: 4e3 });
        const evidence = boundedWorkflowEvidence(body.evidence);
        const evidenceRefs = boundedWorkflowEvidenceReferences(body.evidenceRefs);
        if (status !== "passed" && Object.keys(evidenceRefs).length) {
          throw new ProtocolError(
            400,
            "evidenceRefs are accepted only for a passing checkpoint or workflow wait",
            "invalid_workflow_evidence_refs"
          );
        }
        const timestamp = nowIso();
        const transition = structuredClone(run);
        const stage = transition.stages.find((candidate) => candidate.id === stageId);
        const verifiedEvidence = stage && Object.keys(evidenceRefs).length ? verifyWorkflowEvidenceReferences(
          transition,
          stage,
          evidenceRefs,
          { getMessage: (messageId) => messages.get(messageId) },
          timestamp
        ) : {};
        const result = checkpointRun(
          transition,
          stageId,
          status,
          summary,
          evidence,
          timestamp,
          verifiedEvidence,
          typeof body.outcome === "string" && body.outcome.trim() ? requireString(body.outcome, "outcome", { max: 64 }) : void 0
        );
        const checkpointStage = transition.stages.find((candidate) => candidate.id === stageId);
        if (result.transition) {
          const transitionEntry = {
            id: newId("journal"),
            runId: transition.id,
            agentId: agent.id,
            category: "state-change",
            area: checkpointStage?.area ?? "workflow",
            severity: "info",
            summary: `typed transition ${result.transition.fromStage} -> ${result.transition.toStage} (${result.transition.outcome})`,
            evidence: result.transition.evidenceKeys.map((key) => `requirement:${key}`),
            relatedEntryIds: [],
            createdAt: timestamp
          };
          store.saveWorkflowTransition(transition, void 0, transitionEntry);
          counters.journalEntries += 1;
        }
        if (result.exhausted) {
          const exhaustEntry = {
            id: newId("journal"),
            runId: transition.id,
            agentId: agent.id,
            category: "error",
            area: checkpointStage?.area ?? "workflow",
            severity: "error",
            summary: `transition budget exhausted at ${stageId} (outcome ${body.outcome ?? status}); run failed safely`,
            evidence: [`class:transition_budget_exhausted`, `stage:${stageId}`],
            relatedEntryIds: [],
            createdAt: timestamp
          };
          store.saveWorkflowTransition(transition, void 0, exhaustEntry);
          counters.journalEntries += 1;
        }
        let entry;
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
            createdAt: transition.updatedAt
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
              ...(checkpointStage.degradedRequirements ?? []).map((requirement) => `requirement:${requirement}`)
            ],
            relatedEntryIds: [],
            createdAt: transition.updatedAt
          };
        }
        store.saveWorkflowTransition(transition, void 0, entry);
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
          completed: result.completed
        });
        json(response, 200, {
          run: transition,
          retry: result.retry,
          completed: result.completed,
          instruction: result.retry ? "Correct the warning or failure, record what changed, rerun the relevant checks, and checkpoint this stage again." : result.completed ? "Workflow checkpoints are complete. Return the final outcome with links and evidence." : `Continue with stage ${transition.currentStage}.`
        });
        return;
      }
      const journalMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/journal$/);
      if (method === "POST" && journalMatch) {
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const body = await readJson(request);
        const run = workflowRuns.get(decodeURIComponent(journalMatch[1]));
        if (!run) throw new ProtocolError(404, "workflow run not found", "workflow_not_found");
        if (run.project !== agent.project || run.targetAgentId !== agent.id) {
          throw new ProtocolError(
            403,
            "only the assigned coordinator can journal this workflow",
            "workflow_forbidden",
            workflowScopeExtras("journal", run.targetAgentName)
          );
        }
        const category = parseJournalCategory(body.category);
        const area = requireString(body.area, "area", { max: 24 });
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
            "invalid_journal_relation"
          );
        }
        const evidence = boundedStringList(body.evidence, "evidence");
        if (journalEvidenceRequired(category) && evidence.length < 1) {
          throw new ProtocolError(
            400,
            `journal category ${category} requires at least one durable evidence reference`,
            "journal_evidence_required"
          );
        }
        let stageId;
        let attempt;
        if (body.stageId !== void 0 && body.stageId !== null) {
          stageId = requireString(body.stageId, "stageId", { max: 128 });
          const stage = run.stages.find((candidate) => candidate.id === stageId);
          if (!stage) {
            throw new ProtocolError(400, `stageId ${stageId} is not part of this workflow run`, "invalid_journal_relation");
          }
          attempt = stage.attempts + 1;
        }
        const entry = {
          id: newId("journal"),
          runId: run.id,
          agentId: agent.id,
          category,
          area,
          severity,
          summary: requireString(body.summary, "summary", { max: 1e3 }),
          ...body.details ? { details: requireString(body.details, "details", { max: 8e3 }) } : {},
          evidence,
          relatedEntryIds,
          createdAt: nowIso(),
          ...stageId !== void 0 ? { stageId } : {},
          ...attempt !== void 0 ? { attempt } : {}
        };
        store.saveJournalEntry(entry);
        counters.journalEntries += 1;
        logger({
          event: "workflow_journal_recorded",
          workflowRunId: run.id,
          journalEntryId: entry.id,
          category,
          area,
          severity
        });
        json(response, 201, { entry });
        return;
      }
      if (method === "GET" && url.pathname === "/v1/improvements") {
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
        const visibleRuns = new Set(
          [...workflowRuns.values()].filter((run) => run.project === agent.project).map((run) => run.id)
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
          (agent2) => agent2.project === project && agent2.name.toLowerCase() === name.toLowerCase()
        );
        if (existing?.online) {
          throw new ProtocolError(409, `agent name already active in project: ${name}`, "duplicate_agent_name");
        }
        const timestamp = nowIso();
        const agent = existing ?? {
          id: newId("agt"),
          key: newId("key"),
          name,
          purpose,
          project,
          connectedAt: timestamp,
          lastSeenAt: timestamp,
          online: true
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
        const result = [...agents.values()].filter((agent) => agent.project === current.project && agent.online).map(publicAgent);
        json(response, 200, { agents: result });
        return;
      }
      const heartbeatMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/heartbeat$/);
      if (method === "POST" && heartbeatMatch) {
        const current = requireAgent(request, decodeURIComponent(heartbeatMatch[1]));
        requireProjectAuth(request, current.project);
        await readJson(request);
        json(response, 200, { agent: publicAgent(current) });
        return;
      }
      const agentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
      if (method === "DELETE" && agentMatch) {
        const current = requireAgent(request, decodeURIComponent(agentMatch[1]));
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
          ...presenceOnly ? { "x-mesh-events-mode": "presence" } : {}
        });
        response.write(`event: ready
data: ${JSON.stringify({ agent: publicAgent(current) })}

`);
        const client = {
          response,
          heartbeat: setInterval(() => response.write(": heartbeat\n\n"), 15e3),
          ...presenceOnly ? { presenceOnly: true } : {}
        };
        client.heartbeat.unref();
        const clients = streams.get(agentId) ?? /* @__PURE__ */ new Set();
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
        const workflowContext = requestedContext ? authorizeWorkflowMessageContext(sender, targetInput, requestedContext) : void 0;
        const callerCorrelationId = optionalString(body.correlationId, "correlationId", 128);
        if (workflowContext && callerCorrelationId && callerCorrelationId !== workflowContext.runId) {
          throw new ProtocolError(
            409,
            "correlationId must match workflowContext.runId",
            "workflow_context_correlation_mismatch"
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
          MAX_MESSAGE_TTL_MS
        );
        const idempotencyKey = optionalString(body.idempotencyKey, "idempotencyKey", 128);
        if (idempotencyKey) {
          const existing = [...messages.values()].find(
            (message2) => message2.from === sender.id && message2.idempotencyKey === idempotencyKey
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
              workflowContext
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
        const message = {
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
          ...correlationId ? { correlationId } : {},
          ...replyTo ? { replyTo } : {},
          ...idempotencyKey ? { idempotencyKey } : {},
          ...workflowContext ? { workflowRunId: workflowContext.runId, workflowContext } : {},
          createdAt,
          expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
          status: "queued"
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
        const message = messages.get(decodeURIComponent(ackMatch[1]));
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
        const message = messages.get(decodeURIComponent(replyMatch[1]));
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
          createdAt: nowIso()
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
          const entry = {
            id: newId("journal"),
            runId: workflowRun.id,
            agentId: receiver.id,
            category: "error",
            area: "workflow",
            severity: "error",
            summary: "Coordinator settled before all required workflow checkpoints passed",
            evidence: [`message:${message.id}`],
            relatedEntryIds: [],
            createdAt: message.repliedAt
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
        const message = messages.get(decodeURIComponent(messageMatch[1]));
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
        const message = messages.get(decodeURIComponent(messageMatch[1]));
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
      logger({ event: "request_error", requestId, statusCode, code, ...statusCode >= 500 ? { message: internalMessage } : {} });
      if (!response.headersSent) {
        json(response, statusCode, {
          error: publicMessage,
          code,
          requestId,
          ...error instanceof ProtocolError && error.extras ? error.extras : {}
        });
      } else response.end();
    }
  });
  return {
    server,
    state: { agents, messages, workflowRuns, journal, persistent: store.persistent },
    async start() {
      if (closed) throw new Error("hub is closed");
      await new Promise((resolve4, reject) => {
        server.once("error", reject);
        server.listen(port2, host2, () => {
          server.off("error", reject);
          resolve4();
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
      const address2 = server.address();
      if (!address2 || typeof address2 === "string") throw new Error("hub did not expose a TCP address");
      return { host: host2, port: address2.port, url: `http://${host2}:${address2.port}` };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (cleanupTimer) clearInterval(cleanupTimer);
      const serverClosed = server.listening ? new Promise((resolve4, reject) => server.close((error) => error ? reject(error) : resolve4())) : Promise.resolve();
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
    }
  };
}

// plugins/kxm/src/server.ts
import { createWriteStream, mkdirSync as mkdirSync3, readFileSync } from "node:fs";
import { dirname as dirname2, join, resolve as resolve3 } from "node:path";
var host = process.env.KXM_HOST ?? "127.0.0.1";
var port = Number.parseInt(process.env.KXM_PORT ?? String(DEFAULT_PORT), 10);
var authToken = process.env.KXM_AUTH_TOKEN;
var workspaceDir = resolve3(process.env.KXM_WORKSPACE_DIR?.trim() || ".kxm");
var configDir = resolve3(process.env.KXM_CONFIG_DIR?.trim() || join(workspaceDir, "config"));
var logsDir = resolve3(process.env.KXM_LOGS_DIR?.trim() || join(workspaceDir, "logs"));
var assetsDir = resolve3(process.env.KXM_ASSETS_DIR?.trim() || join(workspaceDir, "assets"));
var stateDir = resolve3(process.env.KXM_STATE_DIR?.trim() || join(workspaceDir, "state"));
var dataPathValue = process.env.KXM_DATA_PATH?.trim();
var dataPath = dataPathValue === ":memory:" ? dataPathValue : resolve3(dataPathValue || join(stateDir, "kxm.db"));
var logPath = resolve3(process.env.KXM_LOG_PATH?.trim() || join(logsDir, "kxm-hub.jsonl"));
var messageTtlMs = Number.parseInt(process.env.KXM_MESSAGE_TTL_MS ?? String(DEFAULT_MESSAGE_TTL_MS), 10);
var messageRetentionMs = Number.parseInt(
  process.env.KXM_MESSAGE_RETENTION_MS ?? String(DEFAULT_MESSAGE_RETENTION_MS),
  10
);
var rateLimitMax = Number.parseInt(process.env.KXM_RATE_LIMIT_MAX ?? String(DEFAULT_RATE_LIMIT_MAX), 10);
var rateLimitWindowMs = Number.parseInt(
  process.env.KXM_RATE_LIMIT_WINDOW_MS ?? String(DEFAULT_RATE_LIMIT_WINDOW_MS),
  10
);
for (const directory of [configDir, logsDir, assetsDir, stateDir, dirname2(logPath)]) {
  mkdirSync3(directory, { recursive: true });
}
var logStream = createWriteStream(logPath, { flags: "a", encoding: "utf8", mode: 384 });
function structuredLog(entry) {
  const line = `${JSON.stringify({ timestamp: (/* @__PURE__ */ new Date()).toISOString(), ...entry })}
`;
  logStream.write(line);
  process.stdout.write(line);
}
function projectTokens() {
  const raw = process.env.KXM_PROJECT_TOKENS?.trim();
  if (!raw) return void 0;
  const value = JSON.parse(raw);
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("KXM_PROJECT_TOKENS must be a JSON object of project names to tokens");
  }
  const entries = Object.entries(value);
  if (entries.some(([project, token]) => !project.trim() || typeof token !== "string" || !token.trim())) {
    throw new Error("KXM_PROJECT_TOKENS must contain non-empty project names and token strings");
  }
  return Object.fromEntries(entries);
}
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("KXM_PORT must be an integer between 0 and 65535");
}
if (![messageTtlMs, messageRetentionMs, rateLimitMax, rateLimitWindowMs].every(Number.isInteger)) {
  throw new Error("message TTL and rate limit settings must be integers");
}
var configuredProjectTokens = projectTokens();
var inlineWorkflows = process.env.KXM_WEBHOOK_WORKFLOWS?.trim();
var workflowFile = process.env.KXM_WEBHOOK_WORKFLOWS_FILE?.trim();
if (inlineWorkflows && workflowFile) {
  throw new Error("configure only one of KXM_WEBHOOK_WORKFLOWS or KXM_WEBHOOK_WORKFLOWS_FILE");
}
var webhookWorkflows = parseWorkflowDefinitions(
  workflowFile ? readFileSync(resolve3(workflowFile), "utf8") : inlineWorkflows
);
var hub = createMeshHub({
  host,
  port,
  dataPath,
  assetsDir,
  messageTtlMs,
  messageRetentionMs,
  rateLimit: { maxRequests: rateLimitMax, windowMs: rateLimitWindowMs },
  ...authToken ? { authToken } : {},
  ...configuredProjectTokens ? { projectTokens: configuredProjectTokens } : {},
  ...webhookWorkflows.length ? { webhookWorkflows } : {},
  logger: structuredLog
});
var address = await hub.start();
structuredLog({ event: "hub_started", url: address.url, workspaceDir, configDir, logsDir, assetsDir, stateDir, dataPath, logPath });
process.stdout.write(`kxm hub listening at ${address.url}; storage=${dataPath}
`);
var shutdownPromise;
function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    structuredLog({ event: "hub_stopping", signal });
    await hub.close();
    await new Promise((resolveLog) => logStream.end(resolveLog));
    process.exit(0);
  })();
  return shutdownPromise;
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("message", (message) => {
  if (message && typeof message === "object" && message.type === "shutdown") {
    const signal = message.signal;
    void shutdown(typeof signal === "string" ? signal : "parent");
  }
});

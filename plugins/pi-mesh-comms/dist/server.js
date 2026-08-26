#!/usr/bin/env node

// plugins/pi-mesh-comms/src/hub.ts
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";

// plugins/pi-mesh-comms/src/protocol.ts
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

// plugins/pi-mesh-comms/src/diagnostics.ts
function workflowScopeExtras(operation, assignedCoordinatorName) {
  return {
    operation,
    assignedCoordinatorName,
    nextAction: "use_assigned_coordinator"
  };
}

// plugins/pi-mesh-comms/src/retrospective.ts
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// plugins/pi-mesh-comms/src/redact.ts
var SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\bPI_MESH_[A-Z0-9_]*(TOKEN|SECRET|KEY)[A-Z0-9_]*=\S+/gi,
  /\b(GITHUB_TOKEN|GH_TOKEN|PI_MESH_AUTH_TOKEN|PI_MESH_WORKFLOW_SIGNAL_SECRET)=\S+/gi,
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

// plugins/pi-mesh-comms/src/retrospective.ts
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
function buildRetrospective(run, journal, exportedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!SAFE_RUN_ID.test(run.id)) throw new Error("invalid retrospective run id");
  const entries = journal.filter((entry) => entry.runId === run.id).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).slice(-MAX_RETROSPECTIVE_ENTRIES).map((entry) => ({
    id: entry.id,
    category: entry.category,
    area: entry.area,
    severity: entry.severity,
    summary: redactSecrets(entry.summary),
    evidence: redactStringList(entry.evidence),
    relatedEntryIds: entry.relatedEntryIds.slice(0, 16),
    createdAt: entry.createdAt
  }));
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
    proposedImprovements
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

// plugins/pi-mesh-comms/src/store.ts
import { mkdirSync as mkdirSync2 } from "node:fs";
import { dirname, resolve as resolve2 } from "node:path";
import { DatabaseSync } from "node:sqlite";
var MeshStore = class {
  agents = /* @__PURE__ */ new Map();
  messages = /* @__PURE__ */ new Map();
  workflowRuns = /* @__PURE__ */ new Map();
  journal = /* @__PURE__ */ new Map();
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
    if (schemaVersion > 2) {
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
      PRAGMA user_version = 2;
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
  }
};

// plugins/pi-mesh-comms/src/workflow.ts
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
    const priorities = [...matching].filter((entry) => entry.category === "error" || entry.category === "contradiction" || entry.category === "lesson").sort((left, right) => severityWeight[right.severity] - severityWeight[left.severity]).slice(0, 10);
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
function missingWorkflowEvidence(required, evidence) {
  return required.map(canonicalWorkflowEvidenceKey).filter((requirement) => !evidence[requirement]?.length);
}
function workflowEvidenceStrings(evidence) {
  return Object.entries(evidence).flatMap(([requirement, candidate]) => {
    const values = Array.isArray(candidate) ? candidate : [candidate];
    return values.map((value) => `${requirement}: ${value}`);
  });
}
function requireCompleteEvidence(stage, evidence) {
  const missing = missingWorkflowEvidence(stage.requiredEvidence, evidence);
  if (missing.length === 0) return;
  throw new ProtocolError(
    400,
    `stage ${stage.id} is missing required evidence: ${missing.join(", ")}`,
    "workflow_evidence_incomplete",
    { missingRequirements: missing, providedRequirements: Object.keys(evidence) }
  );
}
function parseWorkflowDefinitions(raw, environment = process.env) {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("PI_MESH_WEBHOOK_WORKFLOWS must be a JSON array");
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
      return {
        id: stageId,
        label: requireString(stage.label ?? stageId, "stage.label", { max: 128 }),
        instructions: requireString(stage.instructions, "stage.instructions", { max: 4e3 }),
        requiredEvidence,
        maxAttempts,
        ...area ? { area } : {}
      };
    });
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
      target: requireString(value.target, "workflow.target", { max: 80 }),
      secret,
      ...signalSecret ? { signalSecret } : {},
      ...value.event ? { event: requireString(value.event, "workflow.event", { max: 128 }) } : {},
      ...filter ? { filter } : {},
      delivery,
      ...value.ttlMs !== void 0 ? { ttlMs: value.ttlMs } : {},
      promptTemplate: requireString(value.promptTemplate, "workflow.promptTemplate", { max: 2e4 }),
      stages
    };
  });
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
function checkpointRun(run, stageId, status, summary, evidence, timestamp) {
  if (run.status !== "running") throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_terminal");
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new ProtocolError(404, `workflow stage not found: ${stageId}`, "workflow_stage_not_found");
  if (stage.id !== run.currentStage || stage.status !== "in_progress") {
    throw new ProtocolError(409, `stage ${stageId} is not currently active`, "workflow_stage_out_of_order");
  }
  const accumulatedEvidence = mergeWorkflowEvidence(stage.evidence, evidence);
  if (status === "passed") requireCompleteEvidence(stage, accumulatedEvidence);
  stage.attempts += 1;
  stage.summary = summary;
  if (status === "passed") stage.evidence = accumulatedEvidence;
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
    stage.status = "in_progress";
    return { retry: true, completed: false, run };
  }
  stage.status = "passed";
  stage.completedAt = timestamp;
  const next = run.stages.find((candidate) => candidate.status === "pending");
  if (next) {
    next.status = "in_progress";
    next.startedAt = timestamp;
    next.updatedAt = timestamp;
    run.currentStage = next.id;
    return { retry: false, completed: false, run };
  }
  run.status = "completed";
  delete run.currentStage;
  run.completedAt = timestamp;
  return { retry: false, completed: true, run };
}
function waitForWorkflowSignal(run, stageId, signalKey, summary, timestamp, expiresAt, evidence = {}) {
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
  if (status === "passed") requireCompleteEvidence(stage, accumulatedEvidence);
  run.status = "running";
  stage.status = "in_progress";
  delete run.waiting;
  const result = checkpointRun(run, stageId, status, summary, evidence, timestamp);
  return { ...result, stageId };
}

// plugins/pi-mesh-comms/src/hub.ts
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
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
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
function sameIdempotentRequest(message, target, content, delivery, correlationId, replyTo, hops, maxHops, ttlMs) {
  return (message.to === target || message.toName.toLowerCase() === target.toLowerCase()) && message.content === content && message.delivery === delivery && message.correlationId === correlationId && message.replyTo === replyTo && message.hops === hops && message.maxHops === maxHops && Date.parse(message.expiresAt) - Date.parse(message.createdAt) === ttlMs;
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
  const workflowRuns = store.workflowRuns;
  const journal = store.journal;
  const streams = /* @__PURE__ */ new Map();
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
    journalEntries: 0
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
    throw new Error("PI_MESH_AUTH_TOKEN is required when binding beyond localhost");
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
  function requireAdminAuth(request) {
    if (!authToken2 && isLoopback(host2)) return;
    if (!authToken2 || !safeTokenEqual(bearerToken(request), authToken2)) {
      throw new ProtocolError(401, "invalid administrative authentication token", "invalid_auth", {
        operation: "other",
        nextAction: "check_project_token"
      });
    }
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
    const frame = `event: ${event.type}
data: ${JSON.stringify(event)}

`;
    for (const client of clients) client.response.write(frame);
    return true;
  }
  function broadcastPresence(agent) {
    for (const candidate of agents.values()) {
      if (candidate.project === agent.project && candidate.id !== agent.id && candidate.online) {
        publish(candidate.id, { type: "presence", agent: publicAgent(agent) });
      }
    }
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
    const stageList = definition.stages.map((stage, index) => [
      `${index + 1}. ${stage.label} (stageId: ${stage.id}, maxAttempts: ${stage.maxAttempts})`,
      `   ${stage.instructions}`,
      `   Required evidence keys: ${stage.requiredEvidence.join(", ") || "none"}`
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
      "Complete each stage with mesh_workflow_checkpoint. Supply evidence as an object whose keys exactly match the stage's required evidence keys. Unrelated keys never satisfy a requirement. A warning or failure must be corrected and checkpointed again until it passes or the attempt limit is reached.",
      "When an external system must finish asynchronously, call mesh_workflow_wait with a stable signal key and any already-verified keyed evidence. That evidence is accumulated with the signed callback before the stage can pass; then settle the turn.",
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
      "Review the run with mesh_workflow_get and keep recording material plans, decisions, contradictions, errors, and lessons.",
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
        idempotencyKey: `${transition.definitionId}:timeout:${waiting.signalKey}:${waiting.expiresAt}`,
        createdAt: timestamp,
        expiresAt: new Date(Date.parse(timestamp) + ttlMs).toISOString(),
        status: "queued"
      };
      transition.messageId = message.id;
      store.saveWorkflowTransition(transition, message, entry);
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
      if (message.to === agentId && message.status === "queued") {
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
        publish(message.from, { type: "expired", message });
        publish(message.to, { type: "expired", message });
        counters.messagesExpired += 1;
        logger({ event: "message_expired", messageId: message.id, project: message.project });
        const run = [...workflowRuns.values()].find(
          (candidate) => candidate.messageId === message.id && candidate.status === "running"
        );
        if (run) {
          run.status = "failed";
          delete run.currentStage;
          run.updatedAt = nowIso();
          store.saveWorkflowRun(run);
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
      counters.messagesPurged += 1;
      logger({ event: "message_purged", messageId: message.id, project: message.project });
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
        const payloadHash = createHash("sha256").update(rawBody).digest("hex");
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
        const result = resumeWorkflowFromSignal(transition, signalKey, status, summary, evidence, receivedAt);
        const receipt = {
          deliveryId,
          payloadHash,
          signalKey,
          stageId: result.stageId,
          status,
          receivedAt
        };
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
          idempotencyKey: `${definition.id}:${deliveryId}`,
          createdAt,
          expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
          status: "queued"
        };
        const stages = definition.stages.map((stage, index) => ({
          ...stage,
          status: index === 0 ? "in_progress" : "pending",
          attempts: 0,
          evidence: {},
          ...index === 0 ? { startedAt: createdAt, updatedAt: createdAt } : {}
        }));
        const run = {
          id: runId,
          definitionId: definition.id,
          source: definition.source,
          deliveryId,
          payloadHash: createHash("sha256").update(rawBody).digest("hex"),
          ...event ? { event } : {},
          project: definition.project,
          targetAgentId: target.id,
          targetAgentName: target.name,
          messageId: message.id,
          status: "running",
          currentStage: stages[0].id,
          stages,
          createdAt,
          updatedAt: createdAt
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
      const waitMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/waits$/);
      if (method === "POST" && waitMatch) {
        expireWorkflowWaits();
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
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
        const body = await readJson(request);
        const stageId = requireString(body.stageId, "stageId", { max: 64 });
        const signalKey = workflowSignalKey(body.signalKey);
        const summary = requireString(body.summary, "summary", { max: 4e3 });
        const evidence = boundedWorkflowEvidence(body.evidence);
        const timeoutMs = parseBoundedInteger(
          body.timeoutMs,
          "timeoutMs",
          DEFAULT_WORKFLOW_WAIT_TIMEOUT_MS,
          MIN_WORKFLOW_WAIT_TIMEOUT_MS,
          MAX_WORKFLOW_WAIT_TIMEOUT_MS
        );
        const createdAt = nowIso();
        waitForWorkflowSignal(
          run,
          stageId,
          signalKey,
          summary,
          createdAt,
          new Date(Date.parse(createdAt) + timeoutMs).toISOString(),
          evidence
        );
        store.saveWorkflowRun(run);
        counters.workflowWaits += 1;
        logger({
          event: "workflow_wait_started",
          workflowRunId: run.id,
          stageId,
          signalKey,
          expiresAt: run.waiting?.expiresAt
        });
        json(response, 202, {
          run,
          instruction: "The agent may now settle this turn. A signed external signal will checkpoint the stage and resume the coordinator when more work is required."
        });
        return;
      }
      const checkpointMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/checkpoints$/);
      if (method === "POST" && checkpointMatch) {
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
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
        const body = await readJson(request);
        const stageId = requireString(body.stageId, "stageId", { max: 64 });
        const status = requireString(body.status, "status", { max: 16 });
        if (status !== "passed" && status !== "warning" && status !== "failed") {
          throw new ProtocolError(400, "status must be passed, warning, or failed", "invalid_checkpoint_status");
        }
        const summary = requireString(body.summary, "summary", { max: 4e3 });
        const evidence = boundedWorkflowEvidence(body.evidence);
        const result = checkpointRun(run, stageId, status, summary, evidence, nowIso());
        store.saveWorkflowRun(run);
        counters.workflowCheckpoints += 1;
        if (status !== "passed") {
          const stage = run.stages.find((candidate) => candidate.id === stageId);
          const entry = {
            id: newId("journal"),
            runId: run.id,
            agentId: agent.id,
            category: "error",
            area: stage.area ?? "workflow",
            severity: status === "failed" ? "error" : "warning",
            summary: `${stage.label}: ${summary}`,
            evidence: workflowEvidenceStrings(evidence),
            relatedEntryIds: [],
            createdAt: run.updatedAt
          };
          store.saveJournalEntry(entry);
          counters.journalEntries += 1;
        }
        exportTerminalRetrospective(run);
        logger({
          event: "workflow_checkpoint",
          workflowRunId: run.id,
          stageId,
          status,
          attempt: run.stages.find((stage) => stage.id === stageId)?.attempts,
          retry: result.retry,
          completed: result.completed
        });
        json(response, 200, {
          run,
          retry: result.retry,
          completed: result.completed,
          instruction: result.retry ? "Correct the warning or failure, record what changed, rerun the relevant checks, and checkpoint this stage again." : result.completed ? "Workflow checkpoints are complete. Return the final outcome with links and evidence." : `Continue with stage ${run.currentStage}.`
        });
        return;
      }
      const journalMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/journal$/);
      if (method === "POST" && journalMatch) {
        const agent = requireAgent(request);
        requireProjectAuth(request, agent.project);
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
        const body = await readJson(request);
        const category = requireString(body.category, "category", { max: 24 });
        if (!["plan", "decision", "contradiction", "error", "lesson"].includes(category)) {
          throw new ProtocolError(400, "invalid journal category", "invalid_journal_category");
        }
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
        const entry = {
          id: newId("journal"),
          runId: run.id,
          agentId: agent.id,
          category,
          area,
          severity,
          summary: requireString(body.summary, "summary", { max: 1e3 }),
          ...body.details ? { details: requireString(body.details, "details", { max: 8e3 }) } : {},
          evidence: boundedStringList(body.evidence, "evidence"),
          relatedEntryIds,
          createdAt: nowIso()
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
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "x-content-type-options": "nosniff"
        });
        response.write(`event: ready
data: ${JSON.stringify({ agent: publicAgent(current) })}

`);
        const client = {
          response,
          heartbeat: setInterval(() => response.write(": heartbeat\n\n"), 15e3)
        };
        client.heartbeat.unref();
        const clients = streams.get(agentId) ?? /* @__PURE__ */ new Set();
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
              ttlMs
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
          createdAt,
          expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
          status: "queued"
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
        const workflowRun = [...workflowRuns.values()].find((run) => run.messageId === message.id);
        if (workflowRun?.status === "running") {
          workflowRun.status = "failed";
          delete workflowRun.currentStage;
          workflowRun.updatedAt = message.repliedAt;
          store.saveWorkflowRun(workflowRun);
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
        logger({ event: "message_replied", messageId: message.id, from: receiver.id, to: message.from });
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

// plugins/pi-mesh-comms/src/server.ts
import { createWriteStream, mkdirSync as mkdirSync3, readFileSync } from "node:fs";
import { dirname as dirname2, join, resolve as resolve3 } from "node:path";
var host = process.env.PI_MESH_HOST ?? "127.0.0.1";
var port = Number.parseInt(process.env.PI_MESH_PORT ?? String(DEFAULT_PORT), 10);
var authToken = process.env.PI_MESH_AUTH_TOKEN;
var workspaceDir = resolve3(process.env.PI_MESH_WORKSPACE_DIR?.trim() || ".kxm");
var configDir = resolve3(process.env.PI_MESH_CONFIG_DIR?.trim() || join(workspaceDir, "config"));
var logsDir = resolve3(process.env.PI_MESH_LOGS_DIR?.trim() || join(workspaceDir, "logs"));
var assetsDir = resolve3(process.env.PI_MESH_ASSETS_DIR?.trim() || join(workspaceDir, "assets"));
var stateDir = resolve3(process.env.PI_MESH_STATE_DIR?.trim() || join(workspaceDir, "state"));
var dataPathValue = process.env.PI_MESH_DATA_PATH?.trim();
var dataPath = dataPathValue === ":memory:" ? dataPathValue : resolve3(dataPathValue || join(stateDir, "mesh.db"));
var logPath = resolve3(process.env.PI_MESH_LOG_PATH?.trim() || join(logsDir, "pi-mesh-hub.jsonl"));
var messageTtlMs = Number.parseInt(process.env.PI_MESH_MESSAGE_TTL_MS ?? String(DEFAULT_MESSAGE_TTL_MS), 10);
var messageRetentionMs = Number.parseInt(
  process.env.PI_MESH_MESSAGE_RETENTION_MS ?? String(DEFAULT_MESSAGE_RETENTION_MS),
  10
);
var rateLimitMax = Number.parseInt(process.env.PI_MESH_RATE_LIMIT_MAX ?? String(DEFAULT_RATE_LIMIT_MAX), 10);
var rateLimitWindowMs = Number.parseInt(
  process.env.PI_MESH_RATE_LIMIT_WINDOW_MS ?? String(DEFAULT_RATE_LIMIT_WINDOW_MS),
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
  const raw = process.env.PI_MESH_PROJECT_TOKENS?.trim();
  if (!raw) return void 0;
  const value = JSON.parse(raw);
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("PI_MESH_PROJECT_TOKENS must be a JSON object of project names to tokens");
  }
  const entries = Object.entries(value);
  if (entries.some(([project, token]) => !project.trim() || typeof token !== "string" || !token.trim())) {
    throw new Error("PI_MESH_PROJECT_TOKENS must contain non-empty project names and token strings");
  }
  return Object.fromEntries(entries);
}
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("PI_MESH_PORT must be an integer between 0 and 65535");
}
if (![messageTtlMs, messageRetentionMs, rateLimitMax, rateLimitWindowMs].every(Number.isInteger)) {
  throw new Error("message TTL and rate limit settings must be integers");
}
var configuredProjectTokens = projectTokens();
var inlineWorkflows = process.env.PI_MESH_WEBHOOK_WORKFLOWS?.trim();
var workflowFile = process.env.PI_MESH_WEBHOOK_WORKFLOWS_FILE?.trim();
if (inlineWorkflows && workflowFile) {
  throw new Error("configure only one of PI_MESH_WEBHOOK_WORKFLOWS or PI_MESH_WEBHOOK_WORKFLOWS_FILE");
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
process.stdout.write(`pi-mesh hub listening at ${address.url}; storage=${dataPath}
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

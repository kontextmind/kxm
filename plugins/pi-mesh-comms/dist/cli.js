#!/usr/bin/env node

// plugins/pi-mesh-comms/src/cli.ts
import { spawn } from "node:child_process";
import { createHmac as createHmac2, randomUUID as randomUUID2 } from "node:crypto";
import { cpSync, existsSync, mkdirSync as mkdirSync2, readFileSync, readdirSync, writeFileSync as writeFileSync2 } from "node:fs";
import { join, resolve as resolve2 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

// plugins/pi-mesh-comms/src/protocol.ts
var DEFAULT_MESSAGE_TTL_MS = 24 * 60 * 6e4;
var MIN_MESSAGE_TTL_MS = 1e3;
var MAX_MESSAGE_TTL_MS = 7 * 24 * 60 * 6e4;
var DEFAULT_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 6e4;
var MAX_BODY_BYTES = 256 * 1024;
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

// plugins/pi-mesh-comms/src/workflow.ts
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
function parseWorkflowEvidencePolicies(value, stageId, requiredEvidence) {
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
    if (minProducers > eligibleAgents.length) {
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
      const evidencePolicies = parseWorkflowEvidencePolicies(stage.evidencePolicies, stageId, requiredEvidence);
      return {
        id: stageId,
        label: requireString(stage.label ?? stageId, "stage.label", { max: 128 }),
        instructions: requireString(stage.instructions, "stage.instructions", { max: 4e3 }),
        requiredEvidence,
        maxAttempts,
        ...area ? { area } : {},
        ...evidencePolicies ? { evidencePolicies } : {}
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

// plugins/pi-mesh-comms/src/github-watch.ts
import { createHmac, randomUUID } from "node:crypto";

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

// plugins/pi-mesh-comms/src/github-watch.ts
async function fetchWithTimeout(fetchImpl, input, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
function requiredToken(token) {
  const value = token?.trim();
  return value || void 0;
}
var FAILED_CONCLUSIONS = /* @__PURE__ */ new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure"
]);
var SUCCESS_CONCLUSIONS = /* @__PURE__ */ new Set(["success"]);
var CHECK_RUNS_PER_PAGE = 100;
var MAX_CHECK_RUN_PAGES = 100;
function mapCheckConclusion(runs, required = []) {
  const names = required.length > 0 ? required : [...new Set(runs.map((run) => run.name))];
  const interesting = names.map((name) => runs.find((run) => run.name === name));
  const evidence = Object.fromEntries(interesting.slice(0, 32).map((run, index) => {
    const name = names[index] ?? "unknown";
    const conclusion = run?.conclusion ?? run?.status ?? "missing";
    const url = run?.html_url ? ` url:${run.html_url}` : "";
    const completed = run?.completed_at ? ` at:${run.completed_at}` : "";
    return [`github.check:${name}`, redactSecrets(`conclusion:${conclusion}${url}${completed}`).slice(0, 500)];
  }));
  if (names.length === 0 || interesting.some((run) => !run || run.status !== "completed")) {
    return { status: "pending", evidence };
  }
  if (interesting.some((run) => FAILED_CONCLUSIONS.has(run?.conclusion ?? ""))) {
    return { status: "failed", evidence };
  }
  if (interesting.every((run) => SUCCESS_CONCLUSIONS.has(run?.conclusion ?? ""))) {
    return { status: "passed", evidence };
  }
  return { status: "pending", evidence };
}
async function postWorkflowSignal(input) {
  const body = JSON.stringify({ status: input.status, summary: input.summary, evidence: input.evidence });
  const signature = `sha256=${createHmac("sha256", input.signalSecret).update(body).digest("hex")}`;
  const endpoint = [
    input.serverUrl.replace(/\/$/, ""),
    "v1/webhooks",
    encodeURIComponent(input.definitionId),
    "runs",
    encodeURIComponent(input.runId),
    "signals",
    encodeURIComponent(input.signalKey)
  ].join("/");
  const response = await fetchWithTimeout(input.fetchImpl ?? fetch, endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-mesh-delivery-id": input.deliveryId
    },
    body
  }, input.timeoutMs ?? 15e3);
  const text = await response.text();
  let duplicate = false;
  try {
    const parsed = JSON.parse(text);
    duplicate = parsed.duplicate === true;
  } catch {
  }
  if (!response.ok && response.status !== 200) {
    throw new Error(`signal_http_${response.status}`);
  }
  return { httpStatus: response.status, duplicate };
}
async function watchGithubChecks(input) {
  const token = requiredToken(input.token);
  if (!token) {
    return { exitCode: 1, posted: false, skipped: true, summary: "github_auth_unavailable", evidence: {} };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms) => new Promise((resolve3) => setTimeout(resolve3, ms)));
  const deadline = now() + input.timeoutMs;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "pi-mesh-github-watch"
  };
  const contextEvidence = {
    "workflow.run": input.runId,
    "workflow.stage": input.stageId,
    "workflow.signal": input.signalKey
  };
  const explicitDeliveryId = input.deliveryId?.trim();
  const deliveryGeneration = randomUUID();
  let deliveryId = explicitDeliveryId || `github-watch:${deliveryGeneration}:pr-${input.pr}`;
  const deliver = async (status, summary, evidence) => {
    const boundedEvidence = Object.fromEntries(Object.entries({ ...contextEvidence, ...evidence }).slice(0, 64));
    if (input.dryRun) return { exitCode: status === "failed" && summary === "github_watch_timeout" ? 4 : 0, posted: false, status, summary, evidence: boundedEvidence, deliveryId };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const posted = await postWorkflowSignal({ serverUrl: input.serverUrl, definitionId: input.definitionId, signalSecret: input.signalSecret, runId: input.runId, signalKey: input.signalKey, status, summary, evidence: boundedEvidence, deliveryId, timeoutMs: Math.min(15e3, Math.max(1e3, input.intervalMs)), fetchImpl });
        return { exitCode: status === "failed" && summary === "github_watch_timeout" ? 4 : 0, posted: true, duplicate: posted.duplicate, status, summary, evidence: boundedEvidence, deliveryId };
      } catch (error) {
        const message = error instanceof Error ? error.message : "signal_failed";
        if (/signal_http_(404|409)\b/.test(message)) return { exitCode: 1, posted: false, summary: "workflow_not_waiting", evidence: boundedEvidence, deliveryId };
        const transient = /signal_http_(429|5\d\d)\b/.test(message) || message === "signal_failed" || /abort|timeout|fetch/i.test(message);
        if (!transient || attempt === 3) return { exitCode: 1, posted: false, summary: "signal_failed", evidence: boundedEvidence, deliveryId };
        await sleep(Math.min(250 * 2 ** (attempt - 1), 1e3));
      }
    }
    return { exitCode: 1, posted: false, summary: "signal_failed", evidence: boundedEvidence, deliveryId };
  };
  const githubGet = async (url) => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const remaining = deadline - now();
      if (remaining <= 0) return void 0;
      try {
        const response = await fetchWithTimeout(fetchImpl, url, { headers }, Math.min(15e3, remaining));
        if (response.status !== 429 && response.status < 500) return response;
        if (attempt === 3) return response;
      } catch {
        if (attempt === 3 || now() >= deadline) return void 0;
      }
      await sleep(Math.min(250 * 2 ** (attempt - 1), Math.max(1, deadline - now())));
    }
    return void 0;
  };
  const prResponse = await githubGet(`https://api.github.com/repos/${input.repo}/pulls/${input.pr}`);
  if (!prResponse) return deliver("failed", "github_watch_timeout", {});
  if (!prResponse.ok) {
    return { exitCode: 1, posted: false, summary: "github_pr_unavailable", evidence: { "github.http": String(prResponse.status) } };
  }
  const pull = await prResponse.json();
  const headSha = pull.head?.sha;
  if (!headSha) {
    return { exitCode: 1, posted: false, summary: "github_head_unavailable", evidence: {} };
  }
  if (!explicitDeliveryId) deliveryId = `github-watch:${deliveryGeneration}:${headSha.slice(0, 40)}`;
  let lastEvidence = {};
  while (now() <= deadline) {
    const checkRuns = [];
    for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page += 1) {
      const checksUrl = new URL(`https://api.github.com/repos/${input.repo}/commits/${headSha}/check-runs`);
      checksUrl.searchParams.set("per_page", String(CHECK_RUNS_PER_PAGE));
      checksUrl.searchParams.set("page", String(page));
      const checksResponse = await githubGet(checksUrl.toString());
      if (!checksResponse) return deliver("failed", "github_watch_timeout", lastEvidence);
      if (!checksResponse.ok) {
        return { exitCode: 1, posted: false, summary: "github_checks_unavailable", evidence: { "github.http": String(checksResponse.status) } };
      }
      const payload = await checksResponse.json();
      const pageRuns = Array.isArray(payload.check_runs) ? payload.check_runs : [];
      checkRuns.push(...pageRuns);
      const totalCount = Number.isInteger(payload.total_count) && payload.total_count >= 0 ? payload.total_count : void 0;
      const complete = totalCount === void 0 ? pageRuns.length < CHECK_RUNS_PER_PAGE : checkRuns.length >= totalCount;
      if (complete) break;
      if (pageRuns.length === 0 || page === MAX_CHECK_RUN_PAGES) {
        return {
          exitCode: 1,
          posted: false,
          summary: "github_checks_unavailable",
          evidence: { "github.pagination": pageRuns.length === 0 ? "incomplete" : "limit_exceeded" }
        };
      }
    }
    const mapped = mapCheckConclusion(checkRuns, input.required ?? []);
    lastEvidence = mapped.evidence;
    if (mapped.status !== "pending") {
      const summary = mapped.status === "passed" ? "required GitHub checks passed" : "required GitHub checks failed";
      return deliver(mapped.status, summary, mapped.evidence);
    }
    if (now() + input.intervalMs > deadline) break;
    await sleep(input.intervalMs);
  }
  return deliver("failed", "github_watch_timeout", lastEvidence);
}

// plugins/pi-mesh-comms/src/retrospective.ts
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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

// plugins/pi-mesh-comms/src/cli.ts
var repoRoot = resolve2(fileURLToPath(new URL("../../../", import.meta.url)));
function spawnScript(scriptName, extraEnv = {}) {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [join(repoRoot, "scripts", scriptName)], {
      stdio: "inherit",
      env: { ...process.env, ...extraEnv }
    });
    child.once("error", () => resolveExit(1));
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
}
function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  let json = false;
  let dryRun = false;
  let workspace;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--workspace") workspace = argv[++index];
    else if (arg.startsWith("--") && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      flags[arg.slice(2)] = argv[++index];
    } else if (arg.startsWith("--")) {
      flags[arg.slice(2)] = true;
    } else {
      positionals.push(arg);
    }
  }
  return {
    json,
    dryRun,
    ...workspace ? { workspace } : {},
    command: positionals.join(" ").trim(),
    rest: positionals,
    flags
  };
}
function usage() {
  return [
    "Usage: pi-mesh [--json] [--dry-run] [--workspace <dir>] <command>",
    "Commands: init | validate | status | hub | worker --name <name> --project <project>",
    "          [--model <id>] [--fallback-models <id,...>] [--tools <name,...>] [--fresh-start] | stop",
    "          workflow list | workflow get <runId> | workflow start <definitionId> --payload <JSON|@file>",
    "          workflow degrade <runId> <stageId> --requirement <key> --reason <text>",
    "          signal | github watch | retrospective export <runId> | smoke"
  ].join("\n");
}
function parseEvidencePairs(values) {
  const evidence = /* @__PURE__ */ new Map();
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error("evidence must use <required-key>=<evidence> syntax");
    }
    const requirement = canonicalWorkflowEvidenceKey(value.slice(0, separator));
    const proof = value.slice(separator + 1).trim();
    if (!requirement || !proof) throw new Error("evidence must use <required-key>=<evidence> syntax");
    if (evidence.has(requirement)) throw new Error(`duplicate normalized evidence key: ${requirement}`);
    evidence.set(requirement, proof);
  }
  return Object.fromEntries(evidence);
}
function print(io, jsonMode, payload, text) {
  const safePayload = JSON.stringify(redactCliValue(payload));
  io.stdout(jsonMode ? `${safePayload}
` : `${redactSecrets(text)}
`);
}
function redactCliValue(value, field = "") {
  if (typeof value === "string") {
    if ((field === "requestSha256" || field === "replySha256") && /^[a-f0-9]{64}$/.test(value)) return value;
    return redactSecrets(value);
  }
  if (Array.isArray(value)) return value.map((candidate) => redactCliValue(candidate));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, candidate]) => [key, redactCliValue(candidate, key)])
    );
  }
  return value;
}
function workspaceDirs(cwd, workspaceFlag, env) {
  const workdir = resolve2(env.PI_MESH_WORKDIR?.trim() || cwd);
  const workspace = resolve2(workdir, workspaceFlag || env.PI_MESH_WORKSPACE_DIR?.trim() || ".kxm");
  const derive = workspaceFlag !== void 0;
  return {
    workdir,
    workspace,
    config: derive ? join(workspace, "config") : resolve2(workdir, env.PI_MESH_CONFIG_DIR?.trim() || join(workspace, "config")),
    logs: derive ? join(workspace, "logs") : resolve2(workdir, env.PI_MESH_LOGS_DIR?.trim() || join(workspace, "logs")),
    assets: derive ? join(workspace, "assets") : resolve2(workdir, env.PI_MESH_ASSETS_DIR?.trim() || join(workspace, "assets")),
    state: derive ? join(workspace, "state") : resolve2(workdir, env.PI_MESH_STATE_DIR?.trim() || join(workspace, "state"))
  };
}
function maskEnvName(name) {
  return /TOKEN|SECRET|KEY|PASSWORD/i.test(name);
}
function redactConfiguredValues(text, env) {
  let safe = text;
  for (const [name, value] of Object.entries(env)) {
    if (!maskEnvName(name) || !value || value.length < 4) continue;
    safe = safe.replaceAll(value, "[redacted]");
  }
  const trailingNewline = safe.endsWith("\n") ? "\n" : "";
  try {
    const parsed = JSON.parse(safe);
    return `${JSON.stringify(redactCliValue(parsed))}${trailingNewline}`;
  } catch {
  }
  return redactSecrets(safe);
}
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
async function hubGet(url, fetchImpl) {
  try {
    const response = await fetchImpl(url);
    const text = redactSecrets((await response.text()).slice(0, 8e3));
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
    }
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: "hub_unreachable" } };
  }
}
function localWorkflowSnapshot(dataPath, runId) {
  if (!existsSync(dataPath)) throw new Error("state_database_not_found");
  const database = new DatabaseSync(dataPath, { readOnly: true });
  try {
    const rows = runId ? database.prepare("SELECT record FROM workflow_runs WHERE id = ?").all(runId) : database.prepare("SELECT record FROM workflow_runs ORDER BY rowid DESC LIMIT 200").all();
    const runs = rows.map((row) => JSON.parse(row.record));
    const journal = runId ? database.prepare("SELECT record FROM workflow_journal WHERE run_id = ? ORDER BY rowid").all(runId).map((row) => JSON.parse(row.record)) : [];
    return { runs, journal };
  } finally {
    database.close();
  }
}
async function postWorkflowStart(input) {
  const payload = input.event && input.payload.event === void 0 ? { ...input.payload, event: input.event } : input.payload;
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac2("sha256", input.secret).update(body).digest("hex")}`;
  const response = await input.fetchImpl(`${input.serverUrl.replace(/\/$/, "")}/v1/webhooks/${encodeURIComponent(input.definitionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature, "x-mesh-delivery-id": input.deliveryId, ...input.event ? { "x-github-event": input.event } : {} },
    body
  });
  const responseText = (await response.text()).slice(0, 8e3);
  let parsed = {};
  try {
    parsed = JSON.parse(responseText);
  } catch {
  }
  if (!response.ok) throw new Error(`workflow_start_http_${response.status}`);
  return { status: response.status, ...parsed.run?.id ? { runId: parsed.run.id } : {}, duplicate: parsed.duplicate === true };
}
async function postWorkflowDegradation(input) {
  const response = await input.fetchImpl(
    `${input.serverUrl.replace(/\/$/, "")}/v1/workflows/${encodeURIComponent(input.runId)}/degradations`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.authToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        stageId: input.stageId,
        requirementKey: input.requirementKey,
        reason: input.reason
      })
    }
  );
  const text = (await response.text()).slice(0, 8e3);
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
  }
  if (!response.ok) throw new Error(`workflow_degradation_http_${response.status}`);
  return {
    status: response.status,
    duplicate: parsed.duplicate === true,
    ...parsed.approval?.id ? { approvalId: parsed.approval.id } : {}
  };
}
async function runCli(argv, env = process.env, io = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) }, cwd = process.cwd()) {
  const originalStdout = io.stdout;
  const originalStderr = io.stderr;
  io = { ...io, stdout: (text) => originalStdout(redactConfiguredValues(text, env)), stderr: (text) => originalStderr(redactConfiguredValues(text, env)) };
  const parsed = parseArgs(argv);
  const command = parsed.rest[0];
  if (!command || command === "help" || parsed.flags.help) {
    io.stdout(`${usage()}
`);
    return command ? 0 : 2;
  }
  const dirs = workspaceDirs(cwd, parsed.workspace, env);
  const serverUrl = env.PI_MESH_SERVER_URL?.trim() || "http://127.0.0.1:7331";
  const fetchImpl = io.fetchImpl ?? fetch;
  if (command === "init") {
    const created = [];
    for (const directory of [dirs.config, dirs.logs, dirs.assets, dirs.state, join(dirs.assets, "retrospectives")]) {
      if (parsed.dryRun) created.push(directory);
      else {
        mkdirSync2(directory, { recursive: true });
        created.push(directory);
      }
    }
    const templateConfig = join(repoRoot, ".kxm", "config");
    if (!parsed.dryRun && existsSync(templateConfig)) cpSync(templateConfig, dirs.config, { recursive: true, force: false, errorOnExist: false });
    print(io, parsed.json, { ok: true, command: "init", created, templates: existsSync(templateConfig) }, `initialized ${dirs.workspace}`);
    return 0;
  }
  if (command === "validate") {
    const file = String(parsed.flags.file || env.PI_MESH_WEBHOOK_WORKFLOWS_FILE || join(dirs.config, "workflows", "v04-dogfood.json"));
    if (!existsSync(file)) {
      print(io, parsed.json, { ok: false, command: "validate", error: "file_not_found" }, `workflow file not found: ${file}`);
      return 1;
    }
    try {
      const raw = readFileSync(file, "utf8");
      const definitions = parseWorkflowDefinitions(raw, env);
      const secretEnvs = definitions.map((definition) => ({
        id: definition.id,
        secretConfigured: Boolean(definition.secret),
        signalSecretConfigured: Boolean(definition.signalSecret)
      }));
      print(io, parsed.json, { ok: true, command: "validate", file, workflows: secretEnvs }, `validated ${definitions.length} workflow(s)`);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? redactSecrets(error.message) : "invalid_workflow";
      print(io, parsed.json, { ok: false, command: "validate", error: message }, message);
      return 1;
    }
  }
  if (command === "status") {
    const health = await hubGet(`${serverUrl}/health`, fetchImpl);
    const ready = await hubGet(`${serverUrl}/ready`, fetchImpl);
    const payload = { ok: health.ok && ready.ok, command: "status", health: health.body, ready: ready.body };
    print(io, parsed.json, payload, `hub health=${health.ok} ready=${ready.ok}`);
    return payload.ok ? 0 : 1;
  }
  if (command === "hub") {
    const extraEnv = { PI_MESH_WORKDIR: dirs.workdir, PI_MESH_WORKSPACE_DIR: dirs.workspace, PI_MESH_CONFIG_DIR: dirs.config, PI_MESH_LOGS_DIR: dirs.logs, PI_MESH_ASSETS_DIR: dirs.assets, PI_MESH_STATE_DIR: dirs.state };
    if (parsed.dryRun) {
      print(io, parsed.json, { ok: true, command: "hub", dryRun: true, workspace: dirs.workspace }, "would start hub");
      return 0;
    }
    return await (io.spawnHub ?? ((launchEnv) => spawnScript("pi-mesh-hub.mjs", launchEnv)))(extraEnv);
  }
  if (command === "worker") {
    const name = typeof parsed.flags.name === "string" ? parsed.flags.name.trim() : env.PI_MESH_AGENT_NAME?.trim();
    const project = typeof parsed.flags.project === "string" ? parsed.flags.project.trim() : env.PI_MESH_PROJECT?.trim();
    const model = typeof parsed.flags.model === "string" ? parsed.flags.model.trim() : env.PI_MESH_WORKER_MODEL?.trim();
    const fallbackModels = typeof parsed.flags["fallback-models"] === "string" ? parsed.flags["fallback-models"].trim() : env.PI_MESH_WORKER_FALLBACK_MODELS?.trim();
    const tools = typeof parsed.flags.tools === "string" ? parsed.flags.tools.trim() : env.PI_MESH_WORKER_TOOLS?.trim();
    const extraEnv = { PI_MESH_WORKDIR: dirs.workdir, PI_MESH_WORKSPACE_DIR: dirs.workspace, PI_MESH_CONFIG_DIR: dirs.config, PI_MESH_LOGS_DIR: dirs.logs, PI_MESH_ASSETS_DIR: dirs.assets, PI_MESH_STATE_DIR: dirs.state, ...name ? { PI_MESH_AGENT_NAME: name } : {}, ...project ? { PI_MESH_PROJECT: project } : {}, ...model ? { PI_MESH_WORKER_MODEL: model } : {}, ...fallbackModels ? { PI_MESH_WORKER_FALLBACK_MODELS: fallbackModels } : {}, ...tools ? { PI_MESH_WORKER_TOOLS: tools } : {}, ...parsed.flags["no-continue"] ? { PI_MESH_WORKER_CONTINUE: "false" } : {}, ...parsed.flags["fresh-start"] ? { PI_MESH_WORKER_INITIAL_CONTINUE: "false" } : {} };
    if (parsed.dryRun) {
      print(io, parsed.json, { ok: true, command: "worker", dryRun: true, workspace: dirs.workspace, name: name || "required", project: project || "required", model: model || "provider default", fallbackModels: fallbackModels || "none", tools: tools || "Pi defaults", continue: parsed.flags["no-continue"] ? false : true, freshStart: Boolean(parsed.flags["fresh-start"]) }, "would start worker");
      return 0;
    }
    if (!name || !project) {
      io.stderr("worker requires --name and --project (or PI_MESH_AGENT_NAME and PI_MESH_PROJECT)\n");
      return 2;
    }
    return await (io.spawnWorker ?? ((launchEnv) => spawnScript("pi-mesh-worker.mjs", launchEnv)))(extraEnv);
  }
  if (command === "stop") {
    const pids = existsSync(dirs.state) ? readdirSync(dirs.state).filter((name) => name.endsWith(".pid")) : [];
    if (parsed.dryRun) {
      print(io, parsed.json, { ok: true, command: "stop", dryRun: true, pidFiles: pids }, "would signal pid files");
      return 0;
    }
    if (pids.length === 0) {
      print(io, parsed.json, { ok: false, command: "stop", error: "no_pid_files" }, "no hub/worker pid files found");
      return 1;
    }
    const requested = [];
    const ignored = [];
    const records = /* @__PURE__ */ new Map();
    for (const file of pids) {
      try {
        const record = JSON.parse(readFileSync(join(dirs.state, file), "utf8"));
        const expectedControl = file === "hub.pid" ? "hub.stop" : file.startsWith("worker-") ? `${file.slice(0, -4)}.stop` : void 0;
        const expectedRole = file === "hub.pid" ? "hub" : file.startsWith("worker-") ? "worker" : void 0;
        if (record.version !== 1 || !Number.isInteger(record.pid) || record.pid <= 0 || !record.startedAt || !expectedControl || record.controlFile !== expectedControl || record.role !== expectedRole || !processExists(record.pid)) {
          ignored.push(file);
          continue;
        }
        writeFileSync2(join(dirs.state, record.controlFile), `${JSON.stringify({ startedAt: record.startedAt, ...record.generation ? { generation: record.generation } : {}, requestedAt: (/* @__PURE__ */ new Date()).toISOString() })}
`, { encoding: "utf8", mode: 384 });
        requested.push(file);
        records.set(file, { pid: record.pid, startedAt: record.startedAt, ...record.generation ? { generation: record.generation } : {} });
      } catch {
        ignored.push(file);
      }
    }
    if (requested.length === 0) {
      print(io, parsed.json, { ok: false, command: "stop", requested, ignored }, "no current managed processes found");
      return 1;
    }
    const waitMs = Math.min(3e4, Math.max(100, Number(parsed.flags["wait-ms"] || 5e3)));
    const deadline = Date.now() + waitMs;
    const stopped = /* @__PURE__ */ new Set();
    while (Date.now() <= deadline && stopped.size < requested.length) {
      for (const [file, record] of records) {
        try {
          const current = JSON.parse(readFileSync(join(dirs.state, file), "utf8"));
          if (current.pid !== record.pid || current.startedAt !== record.startedAt || current.generation !== record.generation || !processExists(record.pid)) stopped.add(file);
        } catch {
          stopped.add(file);
        }
      }
      if (stopped.size < requested.length) await (io.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))))(100);
    }
    const timedOut = requested.filter((file) => !stopped.has(file));
    const ok = timedOut.length === 0;
    print(io, parsed.json, { ok, command: "stop", requested, stopped: [...stopped], timedOut, ignored }, ok ? "managed processes stopped" : "stop request timed out");
    return ok ? 0 : 1;
  }
  if (command === "workflow") {
    const action = parsed.rest[1];
    if (action === "start") {
      const definitionId = parsed.rest[2] || env.PI_MESH_WORKFLOW_ID?.trim();
      const secret = env.PI_MESH_WORKFLOW_SECRET?.trim();
      const deliveryId = String(parsed.flags["delivery-id"] || `cli-${randomUUID2()}`);
      const event = typeof parsed.flags.event === "string" ? parsed.flags.event : void 0;
      const payloadFlag = typeof parsed.flags.payload === "string" ? parsed.flags.payload : "{}";
      if (!definitionId || !secret) {
        io.stderr("workflow start requires <definitionId> (or PI_MESH_WORKFLOW_ID) and PI_MESH_WORKFLOW_SECRET\n");
        return 2;
      }
      let payload;
      try {
        const raw = payloadFlag.startsWith("@") ? readFileSync(resolve2(cwd, payloadFlag.slice(1)), "utf8") : payloadFlag;
        const value = JSON.parse(raw);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
        payload = value;
      } catch {
        print(io, parsed.json, { ok: false, command: "workflow start", error: "invalid_payload" }, "workflow payload must be a JSON object or @file");
        return 2;
      }
      if (parsed.dryRun) {
        print(io, parsed.json, { ok: true, command: "workflow start", dryRun: true, definitionId, deliveryId, event }, "would POST a signed workflow webhook");
        return 0;
      }
      try {
        const response = await postWorkflowStart({ serverUrl, definitionId, secret, deliveryId, ...event ? { event } : {}, payload, fetchImpl });
        print(io, parsed.json, { ok: true, command: "workflow start", definitionId, deliveryId, ...response }, `started workflow ${response.runId ?? "accepted"}`);
        return 0;
      } catch {
        print(io, parsed.json, { ok: false, command: "workflow start", error: "workflow_start_failed" }, "signed workflow start failed");
        return 1;
      }
    }
    if (action === "degrade") {
      const runId = parsed.rest[2];
      const stageId = parsed.rest[3];
      const requirementKey = typeof parsed.flags.requirement === "string" ? parsed.flags.requirement.trim() : "";
      const reason = typeof parsed.flags.reason === "string" ? parsed.flags.reason.trim() : "";
      const adminToken = env.PI_MESH_AUTH_TOKEN?.trim();
      if (!runId || !stageId || !requirementKey || !reason || !adminToken) {
        io.stderr("workflow degrade requires <runId> <stageId>, --requirement, --reason, and PI_MESH_AUTH_TOKEN\n");
        return 2;
      }
      if (parsed.dryRun) {
        print(
          io,
          parsed.json,
          { ok: true, command: "workflow degrade", dryRun: true, runId, stageId, requirementKey },
          `would approve configured degraded quorum for ${runId}/${stageId}/${requirementKey}`
        );
        return 0;
      }
      try {
        const result = await postWorkflowDegradation({
          serverUrl,
          authToken: adminToken,
          runId,
          stageId,
          requirementKey,
          reason,
          fetchImpl
        });
        print(
          io,
          parsed.json,
          { ok: true, command: "workflow degrade", runId, stageId, requirementKey, ...result },
          result.duplicate ? "degraded quorum was already approved" : "approved configured degraded quorum"
        );
        return 0;
      } catch {
        print(
          io,
          parsed.json,
          { ok: false, command: "workflow degrade", error: "workflow_degradation_failed", runId, stageId, requirementKey },
          "workflow degradation approval failed"
        );
        return 1;
      }
    }
    if (action === "list" || action === "get") {
      const dataPath = resolve2(dirs.workdir, env.PI_MESH_DATA_PATH?.trim() || join(dirs.state, "mesh.db"));
      const requestedId = action === "get" ? parsed.rest[2] : void 0;
      if (action === "get" && !requestedId) {
        io.stderr("Usage: pi-mesh workflow get <runId>\n");
        return 2;
      }
      try {
        const snapshot = localWorkflowSnapshot(dataPath, requestedId);
        if (requestedId && snapshot.runs.length === 0) {
          print(io, parsed.json, { ok: false, command: "workflow get", error: "workflow_not_found" }, "workflow not found");
          return 1;
        }
        const value = action === "get" ? { ok: true, command: "workflow get", run: snapshot.runs[0], journal: snapshot.journal } : { ok: true, command: "workflow list", runs: snapshot.runs };
        print(io, parsed.json, value, action === "get" ? `workflow ${requestedId}` : `${snapshot.runs.length} workflow(s)`);
        return 0;
      } catch {
        print(io, parsed.json, { ok: false, command: `workflow ${action}`, error: "state_unavailable" }, "local workflow state is unavailable");
        return 1;
      }
    }
    io.stderr(`${usage()}
`);
    return 2;
  }
  if (command === "signal") {
    const [runId, signalKey, status, summary, ...evidenceArgs] = parsed.rest.slice(1);
    if (!runId || !signalKey || !status || !summary) {
      io.stderr("Usage: pi-mesh signal <runId> <signalKey> <passed|warning|failed> <summary> [<required-key>=<evidence> ...]\n");
      return 2;
    }
    if (status !== "passed" && status !== "warning" && status !== "failed") {
      io.stderr("status must be passed, warning, or failed\n");
      return 2;
    }
    let evidence;
    try {
      evidence = parseEvidencePairs(evidenceArgs);
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : "invalid evidence"}
`);
      return 2;
    }
    const definitionId = env.PI_MESH_WORKFLOW_ID?.trim();
    const signalSecret = env.PI_MESH_WORKFLOW_SIGNAL_SECRET?.trim();
    if (!definitionId || !signalSecret) {
      io.stderr("signal requires PI_MESH_WORKFLOW_ID and PI_MESH_WORKFLOW_SIGNAL_SECRET\n");
      return 2;
    }
    if (parsed.dryRun) {
      print(io, parsed.json, { ok: true, command: "signal", runId, signalKey, status, summary, evidence }, "would post signed signal");
      return 0;
    }
    const deliveryId = String(parsed.flags["delivery-id"] || `cli-signal:${randomUUID2()}`);
    try {
      const posted = await postWorkflowSignal({
        serverUrl,
        definitionId,
        signalSecret,
        runId,
        signalKey,
        status,
        summary,
        evidence,
        deliveryId,
        fetchImpl
      });
      print(io, parsed.json, { ok: true, command: "signal", duplicate: posted.duplicate, deliveryId }, "posted signed signal");
      return 0;
    } catch {
      print(io, parsed.json, { ok: false, command: "signal", error: "signal_failed", deliveryId }, "signed signal failed");
      return 1;
    }
  }
  if (command === "github") {
    if (parsed.rest[1] !== "watch") {
      io.stderr(`${usage()}
`);
      return 2;
    }
    const token = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
    const definitionId = env.PI_MESH_WORKFLOW_ID?.trim();
    const signalSecret = env.PI_MESH_WORKFLOW_SIGNAL_SECRET?.trim();
    const runId = String(parsed.flags["run-id"] || "");
    const stageId = String(parsed.flags["stage-id"] || "");
    const signalKey = String(parsed.flags["signal-key"] || "");
    const repo = String(parsed.flags.repo || "");
    const pr = Number(parsed.flags.pr);
    if (!definitionId || !signalSecret || !runId || !stageId || !signalKey || !repo || !Number.isInteger(pr)) {
      io.stderr("github watch requires PI_MESH_WORKFLOW_ID, PI_MESH_WORKFLOW_SIGNAL_SECRET, --run-id, --stage-id, --signal-key, --repo, --pr\n");
      return 2;
    }
    const result = await watchGithubChecks({
      serverUrl,
      definitionId,
      signalSecret,
      runId,
      stageId,
      signalKey,
      repo,
      pr,
      required: typeof parsed.flags.required === "string" ? [...new Set(String(parsed.flags.required).split(",").map((name) => name.trim()).filter(Boolean))] : [],
      timeoutMs: Number(parsed.flags["timeout-ms"] || 18e5),
      intervalMs: Number(parsed.flags["interval-ms"] || 15e3),
      ...typeof parsed.flags["delivery-id"] === "string" ? { deliveryId: parsed.flags["delivery-id"] } : {},
      ...token ? { token } : {},
      dryRun: parsed.dryRun,
      fetchImpl,
      ...io.now ? { now: io.now } : {},
      ...io.sleep ? { sleep: io.sleep } : {}
    });
    const payload = {
      ok: result.exitCode === 0,
      command: "github watch",
      posted: result.posted,
      status: result.status,
      summary: result.summary,
      evidence: result.evidence,
      deliveryId: result.deliveryId,
      skipped: result.skipped
    };
    if (JSON.stringify(payload).includes(token ?? "___never___") || Object.keys(env).some((key) => maskEnvName(key) && JSON.stringify(payload).includes(String(env[key])))) {
      print(io, parsed.json, { ok: false, command: "github watch", error: "redaction_failure" }, "refusing to print a payload that contains a secret");
      return 1;
    }
    print(io, parsed.json, payload, result.summary);
    return result.exitCode;
  }
  if (command === "retrospective") {
    if (parsed.rest[1] !== "export") {
      io.stderr(`${usage()}
`);
      return 2;
    }
    const runId = parsed.rest[2];
    if (!runId) {
      io.stderr("Usage: pi-mesh retrospective export <runId>\n");
      return 2;
    }
    const snapshotFlag = String(parsed.flags.input || "");
    const snapshotPath = snapshotFlag ? resolve2(cwd, snapshotFlag) : "";
    let snapshot;
    try {
      if (snapshotPath) {
        if (!existsSync(snapshotPath)) throw new Error("snapshot_missing");
        snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
      } else {
        const dataPath = resolve2(dirs.workdir, env.PI_MESH_DATA_PATH?.trim() || join(dirs.state, "mesh.db"));
        const local = localWorkflowSnapshot(dataPath, runId);
        if (!local.runs[0]) throw new Error("workflow_not_found");
        snapshot = { run: local.runs[0], journal: local.journal };
      }
      if (snapshot.run.id !== runId) throw new Error("run_id_mismatch");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "snapshot_invalid";
      print(io, parsed.json, { ok: false, command: "retrospective export", error: reason }, "retrospective source is invalid or unavailable");
      return 1;
    }
    const doc = buildRetrospective(snapshot.run, snapshot.journal);
    const outDir = resolve2(cwd, String(parsed.flags["out-dir"] || join(dirs.assets, "retrospectives")));
    const assetsRoot = resolve2(dirs.assets);
    const assetsPrefix = `${assetsRoot}${process.platform === "win32" ? "\\" : "/"}`;
    if (outDir !== assetsRoot && !outDir.startsWith(assetsPrefix)) {
      print(io, parsed.json, { ok: false, command: "retrospective export", error: "output_outside_workspace_assets" }, "retrospectives must stay under the workspace assets directory");
      return 2;
    }
    if (parsed.dryRun) {
      print(io, parsed.json, { ok: true, command: "retrospective export", dryRun: true, runId: doc.runId }, `would export ${doc.runId}`);
      return 0;
    }
    const written = writeRetrospective(outDir, doc);
    print(io, parsed.json, { ok: true, command: "retrospective export", ...written, reviewDecision: doc.reviewDecision }, `exported ${written.jsonPath}`);
    return 0;
  }
  if (command === "smoke") {
    if (env.PI_MESH_SMOKE !== "1" && !parsed.flags["real-pi"]) {
      print(io, parsed.json, { ok: true, skipped: true, reason: "PI_MESH_SMOKE is not 1" }, "smoke skipped");
      return 0;
    }
    return await spawnScript("smoke-multi-pi.mjs", { PI_MESH_SMOKE: "1", PI_MESH_WORKDIR: dirs.workdir, PI_MESH_WORKSPACE_DIR: dirs.workspace, PI_MESH_CONFIG_DIR: dirs.config, PI_MESH_LOGS_DIR: dirs.logs, PI_MESH_ASSETS_DIR: dirs.assets, PI_MESH_STATE_DIR: dirs.state });
  }
  io.stderr(`${usage()}
`);
  return 2;
}
if (process.argv[1] && resolve2(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}
export {
  parseArgs,
  runCli
};

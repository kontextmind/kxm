import { createHash } from "node:crypto";
import { vnextCanonicalJson, type JsonObject, type JsonValue } from "./vnext-config.ts";
import {
  VNEXT_COMPILED_WORKFLOW_SCHEMA,
  type VnextCompiledAssignments,
  type VnextCompiledEvidence,
  type VnextCompiledJoin,
  type VnextCompiledPlan,
  type VnextCompiledStep,
  type VnextCompiledTransition,
  type VnextRepositoryAccess,
} from "./vnext-engine-compile.ts";
import {
  VNEXT_ABSENT_MEMORY_REVISION,
  runtimeError,
  type VnextRunEventStore,
  type VnextRunRecord,
} from "./vnext-runtime-store.ts";

export const VNEXT_RUN_PLAN_SCHEMA = "kxm.run-plan.v1";
const SUPPORTED_KINDS = new Set(["agent", "moa", "gate", "approval", "wait"]);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const JOIN_STRATEGIES = new Set(["all", "all-settled", "quorum", "first-success"]);
const EVIDENCE_KINDS = new Set(["assignment-result", "gate", "receipt", "approval", "artifact"]);
const REPOSITORY_ACCESS = new Set(["none", "read", "write"]);
const DISTINCT_BY = new Set(["provider", "model", "profile"]);
const ENVELOPE_REQUIRED = ["schema", "runId", "projectId", "homeRuntimeId", "workflowId", "revisions", "projectLimits", "plan"] as const;
const REVISION_REQUIRED = ["config", "executorPolicy", "toolPolicy", "memory"] as const;
const PROJECT_LIMIT_REQUIRED = ["maxConcurrentRuns"] as const;
const PROJECT_LIMIT_OPTIONAL = ["maxRunDurationMs", "maxAgentTimeMs"] as const;
const PLAN_REQUIRED = ["schema", "workflowId", "coordinator", "limits", "transitionBudget", "hasBackEdges", "entryStepId", "order", "steps", "requirePlanHash"] as const;
const PLAN_OPTIONAL = ["sourcePath", "reproOracle", "planHash"] as const;
const LIMIT_OPTIONAL = ["maxTransitions", "maxRunDurationMs", "maxAgentTimeMs", "maxModelCost", "currency"] as const;
const STEP_REQUIRED = [
  "id",
  "index",
  "kind",
  "maxAttempts",
  "safeSpeculation",
  "repositories",
  "secrets",
  "requiredEvidence",
  "outcomes",
  "transitions",
  "requiresPlanHash",
  "assignments",
  "join",
] as const;
const STEP_OPTIONAL = ["description", "instructions", "timeoutMs", "tools", "model"] as const;
const ASSIGNMENT_REQUIRED = ["allowedAgents", "minimum", "target", "maximum", "maxParallel", "maxAttemptsPerAssignment", "distinctBy"] as const;
const ASSIGNMENT_OPTIONAL = ["maxWriteRepositories"] as const;
const JOIN_REQUIRED = ["strategy"] as const;
const JOIN_OPTIONAL = ["minimumPassed", "cancelRemaining"] as const;
const EVIDENCE_REQUIRED = ["key", "kind", "minimum", "reusableAcrossAttempts"] as const;
const EVIDENCE_OPTIONAL = ["producerPolicy"] as const;

export interface VnextRunPlanEnvelope {
  readonly schema: typeof VNEXT_RUN_PLAN_SCHEMA;
  readonly runId: string;
  readonly projectId: string;
  readonly homeRuntimeId: string;
  readonly workflowId: string;
  readonly revisions: {
    readonly config: string;
    readonly executorPolicy: string;
    readonly toolPolicy: string;
    readonly memory: string;
  };
  readonly projectLimits: {
    readonly maxConcurrentRuns: number;
    readonly maxRunDurationMs?: number;
    readonly maxAgentTimeMs?: number;
  };
  readonly plan: VnextCompiledPlan;
}

export function vnextSha256(input: string): string {
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

export function hashVnextRunPlanEnvelope(envelope: VnextRunPlanEnvelope): string {
  return vnextSha256(vnextCanonicalJson(envelope as unknown as JsonValue));
}

export function freezeVnextCompiledPlan(plan: VnextCompiledPlan): VnextCompiledPlan {
  const steps = Object.create(null) as Record<string, VnextCompiledStep>;
  for (const id of plan.order) {
    const step = plan.steps[id];
    if (!step) throw runtimeError("run_plan_corrupt", plan.workflowId, `compiled plan is missing step ${id}`);
    steps[id] = freezeStep(step);
  }
  return deepFreeze({
    ...plan,
    steps,
    order: [...plan.order],
    requirePlanHash: [...plan.requirePlanHash],
  });
}

function freezeStep(step: VnextCompiledStep): VnextCompiledStep {
  const transitions = Object.create(null) as Record<string, VnextCompiledTransition>;
  for (const outcome of step.outcomes) {
    const transition = step.transitions[outcome];
    if (!transition) throw runtimeError("run_plan_corrupt", step.id, `compiled plan is missing transition ${outcome}`);
    transitions[outcome] = { ...transition };
  }
  const repositories = Object.create(null) as Record<string, VnextRepositoryAccess>;
  for (const [id, access] of Object.entries(step.repositories)) repositories[id] = access;
  return deepFreeze({
    ...step,
    outcomes: [...step.outcomes],
    transitions,
    repositories,
    secrets: step.secrets.map((entry) => ({ ...entry })),
    requiredEvidence: step.requiredEvidence.map((entry) => ({ ...entry })),
    assignments: {
      ...step.assignments,
      allowedAgents: [...step.assignments.allowedAgents],
      distinctBy: [...step.assignments.distinctBy],
    },
    join: { ...step.join },
  });
}

export function parseVnextRunPlanEnvelope(raw: string, run: VnextRunRecord, expectedHash: string): VnextRunPlanEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw runtimeError("run_plan_corrupt", run.runId, "run plan envelope is not JSON");
  }
  const envelope = parseEnvelope(parsed, run);
  const hash = hashVnextRunPlanEnvelope(envelope);
  if (hash !== expectedHash) {
    throw runtimeError("run_plan_corrupt", run.runId, "run plan envelope hash does not match");
  }
  return envelope;
}

export function rehydrateVnextCompiledPlanFromStore(store: VnextRunEventStore, run: VnextRunRecord): VnextCompiledPlan {
  return loadPinnedEnvelope(store, run).plan;
}

export function loadVnextRunPlanEnvelope(store: VnextRunEventStore, run: VnextRunRecord): VnextRunPlanEnvelope {
  return loadPinnedEnvelope(store, run);
}

function loadPinnedEnvelope(store: VnextRunEventStore, run: VnextRunRecord): VnextRunPlanEnvelope {
  const row = store.runPlan(run.runId);
  if (!row) throw runtimeError("run_plan_missing", run.runId, "run has no pinned plan");
  const events = store.events(run.runId, 0, row.pinnedSequence);
  const pinEvent = events.find((event) => event.sequence === row.pinnedSequence);
  const eventHash = pinEvent?.payload.runPlanHash;
  if (typeof eventHash !== "string" || eventHash !== row.runPlanHash) {
    throw runtimeError("run_plan_corrupt", run.runId, "pinned runPlanHash does not match the plan row");
  }
  return parseVnextRunPlanEnvelope(row.envelope, run, row.runPlanHash);
}

export function absentMemoryRevision(): string {
  return VNEXT_ABSENT_MEMORY_REVISION;
}

function parseEnvelope(parsed: unknown, run: VnextRunRecord): VnextRunPlanEnvelope {
  const value = asObject(parsed, run.runId, "run plan envelope");
  assertExactKeys(value, ENVELOPE_REQUIRED, [], run.runId, "run plan envelope");
  if (value.schema !== VNEXT_RUN_PLAN_SCHEMA) {
    throw runtimeError("run_plan_corrupt", run.runId, "run plan envelope schema is not kxm.run-plan.v1");
  }
  const runId = asString(value.runId, run.runId, "runId");
  const projectId = asString(value.projectId, run.runId, "projectId");
  const homeRuntimeId = asString(value.homeRuntimeId, run.runId, "homeRuntimeId");
  const workflowId = asString(value.workflowId, run.runId, "workflowId");
  if (runId !== run.runId || projectId !== run.projectId || homeRuntimeId !== run.homeRuntimeId || workflowId !== run.workflowId) {
    throw runtimeError("run_plan_corrupt", run.runId, "run plan envelope identity does not match the run");
  }
  const revisionsValue = asObject(value.revisions, run.runId, "revisions");
  assertExactKeys(revisionsValue, REVISION_REQUIRED, [], run.runId, "revisions");
  const revisions = {
    config: asString(revisionsValue.config, run.runId, "revisions.config"),
    executorPolicy: asString(revisionsValue.executorPolicy, run.runId, "revisions.executorPolicy"),
    toolPolicy: asString(revisionsValue.toolPolicy, run.runId, "revisions.toolPolicy"),
    memory: asString(revisionsValue.memory, run.runId, "revisions.memory"),
  };
  if (
    revisions.config !== run.configRevision
    || revisions.executorPolicy !== run.executorPolicyRevision
    || revisions.toolPolicy !== run.toolPolicyRevision
    || revisions.memory !== run.memoryRevision
  ) {
    throw runtimeError("run_plan_corrupt", run.runId, "run plan envelope revisions do not match the run");
  }
  const limitsValue = asObject(value.projectLimits, run.runId, "projectLimits");
  assertExactKeys(limitsValue, PROJECT_LIMIT_REQUIRED, PROJECT_LIMIT_OPTIONAL, run.runId, "projectLimits");
  const projectLimits: VnextRunPlanEnvelope["projectLimits"] = {
    maxConcurrentRuns: asCount(limitsValue.maxConcurrentRuns, run.runId, "projectLimits.maxConcurrentRuns"),
    ...(limitsValue.maxRunDurationMs !== undefined ? { maxRunDurationMs: asDuration(limitsValue.maxRunDurationMs, run.runId, "projectLimits.maxRunDurationMs") } : {}),
    ...(limitsValue.maxAgentTimeMs !== undefined ? { maxAgentTimeMs: asDuration(limitsValue.maxAgentTimeMs, run.runId, "projectLimits.maxAgentTimeMs") } : {}),
  };
  return {
    schema: VNEXT_RUN_PLAN_SCHEMA,
    runId,
    projectId,
    homeRuntimeId,
    workflowId,
    revisions,
    projectLimits,
    plan: freezeVnextCompiledPlan(parseCompiledPlan(value.plan, run.runId)),
  };
}

function parseCompiledPlan(raw: unknown, runId: string): VnextCompiledPlan {
  const value = asObject(raw, runId, "compiled plan");
  assertExactKeys(value, PLAN_REQUIRED, PLAN_OPTIONAL, runId, "compiled plan");
  if (value.schema !== VNEXT_COMPILED_WORKFLOW_SCHEMA) {
    throw runtimeError("run_plan_corrupt", runId, "compiled plan schema is not kxm.compiled-workflow.v1");
  }
  const order = asStringArray(value.order, runId, "order");
  const stepsValue = asObject(value.steps, runId, "steps");
  const stepIds = Object.keys(stepsValue);
  if (!sameSet(stepIds, order)) {
    throw runtimeError("run_plan_corrupt", runId, "compiled plan step keys do not equal order");
  }
  const steps = Object.create(null) as Record<string, VnextCompiledStep>;
  for (const stepId of order) {
    steps[stepId] = parseStep(stepsValue[stepId], stepId, runId);
  }
  const entryStepId = asString(value.entryStepId, runId, "entryStepId");
  if (!steps[entryStepId] || !order.includes(entryStepId)) {
    throw runtimeError("run_plan_corrupt", runId, "entryStepId is not in compiled steps");
  }
  const limitsObject = asObject(value.limits, runId, "limits");
  assertExactKeys(limitsObject, [], LIMIT_OPTIONAL, runId, "limits");
  const limits: VnextCompiledPlan["limits"] = {
    ...(limitsObject.maxTransitions !== undefined ? { maxTransitions: asCount(limitsObject.maxTransitions, runId, "limits.maxTransitions") } : {}),
    ...(limitsObject.maxRunDurationMs !== undefined ? { maxRunDurationMs: asDuration(limitsObject.maxRunDurationMs, runId, "limits.maxRunDurationMs") } : {}),
    ...(limitsObject.maxAgentTimeMs !== undefined ? { maxAgentTimeMs: asDuration(limitsObject.maxAgentTimeMs, runId, "limits.maxAgentTimeMs") } : {}),
    ...(limitsObject.maxModelCost !== undefined ? { maxModelCost: asCost(limitsObject.maxModelCost, runId, "limits.maxModelCost") } : {}),
    ...(limitsObject.currency !== undefined ? { currency: asString(limitsObject.currency, runId, "limits.currency") } : {}),
  };
  const requirePlanHash = asStringArray(value.requirePlanHash, runId, "requirePlanHash");
  for (const stageId of requirePlanHash) {
    if (!steps[stageId]) throw runtimeError("run_plan_corrupt", runId, `requirePlanHash references unknown step ${stageId}`);
  }
  const plan: VnextCompiledPlan = {
    schema: VNEXT_COMPILED_WORKFLOW_SCHEMA,
    workflowId: asString(value.workflowId, runId, "workflowId"),
    ...(value.sourcePath !== undefined ? { sourcePath: asStringAllowEmpty(value.sourcePath, runId, "sourcePath") } : {}),
    coordinator: asString(value.coordinator, runId, "coordinator"),
    limits,
    transitionBudget: asCount(value.transitionBudget, runId, "transitionBudget"),
    hasBackEdges: asBoolean(value.hasBackEdges, runId, "hasBackEdges"),
    entryStepId,
    order,
    steps,
    ...(value.reproOracle !== undefined ? { reproOracle: parseOracle(value.reproOracle, steps, runId, "reproOracle") } : {}),
    ...(value.planHash !== undefined ? { planHash: parseOracle(value.planHash, steps, runId, "planHash") } : {}),
    requirePlanHash,
  };
  return plan;
}

function parseStep(raw: unknown, stepId: string, runId: string): VnextCompiledStep {
  const value = asObject(raw, runId, `step ${stepId}`);
  const kind = asString(value.kind, runId, `${stepId}.kind`);
  if (!SUPPORTED_KINDS.has(kind)) {
    throw runtimeError("run_plan_corrupt", runId, `step ${stepId} has unsupported kind ${kind}`);
  }
  const extraRequired = kind === "agent" || kind === "moa"
    ? ["agent"]
    : kind === "gate"
    ? ["gate", "expect"]
    : kind === "wait"
    ? ["signal"]
    : [];
  assertExactKeys(value, [...STEP_REQUIRED, ...extraRequired], STEP_OPTIONAL, runId, `step ${stepId}`);
  const id = asString(value.id, runId, `${stepId}.id`);
  if (id !== stepId) throw runtimeError("run_plan_corrupt", runId, `step ${stepId} id does not match its key`);
  const outcomes = asStringArray(value.outcomes, runId, `${stepId}.outcomes`);
  if (new Set(outcomes).size !== outcomes.length) {
    throw runtimeError("run_plan_corrupt", runId, `step ${stepId} outcomes are not unique`);
  }
  const sorted = [...outcomes].sort();
  if (outcomes.join("\0") !== sorted.join("\0")) {
    throw runtimeError("run_plan_corrupt", runId, `step ${stepId} outcomes are not sorted`);
  }
  const transitionsValue = asObject(value.transitions, runId, `${stepId}.transitions`);
  if (!sameSet(Object.keys(transitionsValue), outcomes)) {
    throw runtimeError("run_plan_corrupt", runId, `step ${stepId} transition keys do not equal outcomes`);
  }
  const transitions = Object.create(null) as Record<string, VnextCompiledTransition>;
  for (const outcome of outcomes) {
    transitions[outcome] = parseTransition(transitionsValue[outcome], stepId, outcome, runId);
  }
  const repositoriesValue = asObject(value.repositories, runId, `${stepId}.repositories`);
  const repositories = Object.create(null) as Record<string, VnextRepositoryAccess>;
  for (const [repositoryId, access] of Object.entries(repositoriesValue)) {
    if (typeof access !== "string" || !REPOSITORY_ACCESS.has(access)) {
      throw runtimeError("run_plan_corrupt", runId, `step ${stepId} repository ${repositoryId} has invalid access`);
    }
    repositories[repositoryId] = access as VnextRepositoryAccess;
  }
  const base = {
    id,
    index: asIndex(value.index, runId, `${stepId}.index`),
    ...(value.description !== undefined ? { description: asStringAllowEmpty(value.description, runId, `${stepId}.description`) } : {}),
    ...(value.instructions !== undefined ? { instructions: asStringAllowEmpty(value.instructions, runId, `${stepId}.instructions`) } : {}),
    maxAttempts: asCount(value.maxAttempts, runId, `${stepId}.maxAttempts`),
    ...(value.timeoutMs !== undefined ? { timeoutMs: asDuration(value.timeoutMs, runId, `${stepId}.timeoutMs`) } : {}),
    safeSpeculation: asBoolean(value.safeSpeculation, runId, `${stepId}.safeSpeculation`),
    repositories,
    ...(value.tools !== undefined ? { tools: asJsonObject(value.tools, runId, `${stepId}.tools`) } : {}),
    secrets: asObjectArray(value.secrets, runId, `${stepId}.secrets`).map((entry) => ({ ...entry })),
    ...(value.model !== undefined ? { model: cloneJson(value.model) } : {}),
    requiredEvidence: asUnknownArray(value.requiredEvidence, runId, `${stepId}.requiredEvidence`).map((entry, index) => (
      parseEvidence(entry, stepId, index, runId)
    )),
    outcomes,
    transitions,
    requiresPlanHash: asBoolean(value.requiresPlanHash, runId, `${stepId}.requiresPlanHash`),
    assignments: parseAssignments(value.assignments, stepId, runId),
    join: parseJoin(value.join, stepId, runId),
  };
  if (kind === "agent" || kind === "moa") {
    return { ...base, kind, agent: asString(value.agent, runId, `${stepId}.agent`) };
  }
  if (kind === "gate") {
    const expect = asString(value.expect, runId, `${stepId}.expect`);
    if (expect !== "pass" && expect !== "fail") {
      throw runtimeError("run_plan_corrupt", runId, `step ${stepId} expect is invalid`);
    }
    return { ...base, kind, gate: asString(value.gate, runId, `${stepId}.gate`), expect };
  }
  if (kind === "wait") {
    return { ...base, kind, signal: asString(value.signal, runId, `${stepId}.signal`) };
  }
  return { ...base, kind: "approval" };
}

function parseTransition(raw: unknown, stepId: string, outcome: string, runId: string): VnextCompiledTransition {
  const value = asObject(raw, runId, `${stepId}.${outcome}`);
  const to = asString(value.to, runId, `${stepId}.${outcome}.to`);
  const maxTransitions = value.maxTransitions !== undefined
    ? asCount(value.maxTransitions, runId, `${stepId}.${outcome}.maxTransitions`)
    : undefined;
  if (to === "step") {
    assertExactKeys(value, ["to", "target", "edge"], ["maxTransitions"], runId, `${stepId}.${outcome}`);
    const edge = asString(value.edge, runId, `${stepId}.${outcome}.edge`);
    if (edge !== "forward" && edge !== "back") {
      throw runtimeError("run_plan_corrupt", runId, `step ${stepId} transition ${outcome} edge is invalid`);
    }
    return {
      to: "step",
      target: asString(value.target, runId, `${stepId}.${outcome}.target`),
      edge,
      ...(maxTransitions !== undefined ? { maxTransitions } : {}),
    };
  }
  if (to === "terminal") {
    assertExactKeys(value, ["to", "terminalStatus"], ["maxTransitions"], runId, `${stepId}.${outcome}`);
    const terminalStatus = asString(value.terminalStatus, runId, `${stepId}.${outcome}.terminalStatus`);
    if (!TERMINAL.has(terminalStatus)) {
      throw runtimeError("run_plan_corrupt", runId, `step ${stepId} has an illegal terminal status`);
    }
    return {
      to: "terminal",
      terminalStatus: terminalStatus as "completed" | "failed" | "cancelled",
      ...(maxTransitions !== undefined ? { maxTransitions } : {}),
    };
  }
  throw runtimeError("run_plan_corrupt", runId, `step ${stepId} transition ${outcome} is not a discriminated transition`);
}

function parseAssignments(raw: unknown, stepId: string, runId: string): VnextCompiledAssignments {
  const value = asObject(raw, runId, `${stepId}.assignments`);
  assertExactKeys(value, ASSIGNMENT_REQUIRED, ASSIGNMENT_OPTIONAL, runId, `${stepId}.assignments`);
  const distinctBy = asStringArray(value.distinctBy, runId, `${stepId}.assignments.distinctBy`);
  if (distinctBy.some((entry) => !DISTINCT_BY.has(entry))) {
    throw runtimeError("run_plan_corrupt", runId, `step ${stepId} distinctBy is invalid`);
  }
  return {
    allowedAgents: asStringArray(value.allowedAgents, runId, `${stepId}.assignments.allowedAgents`),
    minimum: asCount(value.minimum, runId, `${stepId}.assignments.minimum`),
    target: asCount(value.target, runId, `${stepId}.assignments.target`),
    maximum: asCount(value.maximum, runId, `${stepId}.assignments.maximum`),
    maxParallel: asCount(value.maxParallel, runId, `${stepId}.assignments.maxParallel`),
    maxAttemptsPerAssignment: asCount(value.maxAttemptsPerAssignment, runId, `${stepId}.assignments.maxAttemptsPerAssignment`),
    ...(value.maxWriteRepositories !== undefined
      ? { maxWriteRepositories: asCount(value.maxWriteRepositories, runId, `${stepId}.assignments.maxWriteRepositories`) }
      : {}),
    distinctBy: distinctBy as Array<"provider" | "model" | "profile">,
  };
}

function parseJoin(raw: unknown, stepId: string, runId: string): VnextCompiledJoin {
  const value = asObject(raw, runId, `${stepId}.join`);
  assertExactKeys(value, JOIN_REQUIRED, JOIN_OPTIONAL, runId, `${stepId}.join`);
  const strategy = asString(value.strategy, runId, `${stepId}.join.strategy`);
  if (!JOIN_STRATEGIES.has(strategy)) {
    throw runtimeError("run_plan_corrupt", runId, `step ${stepId} join strategy is invalid`);
  }
  return {
    strategy: strategy as VnextCompiledJoin["strategy"],
    ...(value.minimumPassed !== undefined ? { minimumPassed: asCount(value.minimumPassed, runId, `${stepId}.join.minimumPassed`) } : {}),
    ...(value.cancelRemaining !== undefined ? { cancelRemaining: asBoolean(value.cancelRemaining, runId, `${stepId}.join.cancelRemaining`) } : {}),
  };
}

function parseEvidence(raw: unknown, stepId: string, index: number, runId: string): VnextCompiledEvidence {
  const value = asObject(raw, runId, `${stepId}.requiredEvidence[${index}]`);
  assertExactKeys(value, EVIDENCE_REQUIRED, EVIDENCE_OPTIONAL, runId, `${stepId}.requiredEvidence[${index}]`);
  const kind = asString(value.kind, runId, `${stepId}.requiredEvidence[${index}].kind`);
  if (!EVIDENCE_KINDS.has(kind)) {
    throw runtimeError("run_plan_corrupt", runId, `step ${stepId} evidence kind is invalid`);
  }
  return {
    key: asString(value.key, runId, `${stepId}.requiredEvidence[${index}].key`),
    kind: kind as VnextCompiledEvidence["kind"],
    minimum: asCount(value.minimum, runId, `${stepId}.requiredEvidence[${index}].minimum`),
    reusableAcrossAttempts: asBoolean(value.reusableAcrossAttempts, runId, `${stepId}.requiredEvidence[${index}].reusableAcrossAttempts`),
    ...(value.producerPolicy !== undefined ? { producerPolicy: parseProducerPolicy(value.producerPolicy, stepId, runId) } : {}),
  };
}

function parseProducerPolicy(raw: unknown, stepId: string, runId: string): NonNullable<VnextCompiledEvidence["producerPolicy"]> {
  const value = asObject(raw, runId, `${stepId}.producerPolicy`);
  assertExactKeys(value, ["minimumProducers", "eligibleAgents", "acceptedStatuses"], ["degradation"], runId, `${stepId}.producerPolicy`);
  const accepted = value.acceptedStatuses;
  if (!Array.isArray(accepted) || accepted.length !== 1 || accepted[0] !== "passed") {
    throw runtimeError("run_plan_corrupt", runId, `step ${stepId} producerPolicy.acceptedStatuses is invalid`);
  }
  let degradation: { minimumProducers: number } | undefined;
  if (value.degradation !== undefined) {
    const nested = asObject(value.degradation, runId, `${stepId}.producerPolicy.degradation`);
    assertExactKeys(nested, ["minimumProducers"], [], runId, `${stepId}.producerPolicy.degradation`);
    degradation = { minimumProducers: asCount(nested.minimumProducers, runId, `${stepId}.producerPolicy.degradation.minimumProducers`) };
  }
  return {
    minimumProducers: asCount(value.minimumProducers, runId, `${stepId}.producerPolicy.minimumProducers`),
    eligibleAgents: asStringArray(value.eligibleAgents, runId, `${stepId}.producerPolicy.eligibleAgents`),
    acceptedStatuses: ["passed"],
    ...(degradation ? { degradation } : {}),
  };
}

function parseOracle(
  raw: unknown,
  steps: Readonly<Record<string, VnextCompiledStep>>,
  runId: string,
  label: string,
): { stageId: string; evidenceKey: string } {
  const value = asObject(raw, runId, label);
  assertExactKeys(value, ["stageId", "evidenceKey"], [], runId, label);
  const stageId = asString(value.stageId, runId, `${label}.stageId`);
  const evidenceKey = asString(value.evidenceKey, runId, `${label}.evidenceKey`);
  const step = steps[stageId];
  if (!step) throw runtimeError("run_plan_corrupt", runId, `${label} references unknown stage ${stageId}`);
  if (!step.requiredEvidence.some((item) => item.key === evidenceKey)) {
    throw runtimeError("run_plan_corrupt", runId, `${label} references undeclared evidence ${evidenceKey}`);
  }
  return { stageId, evidenceKey };
}

function asObject(value: unknown, runId: string, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw runtimeError("run_plan_corrupt", runId, `${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  runId: string,
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!(key in value)) throw runtimeError("run_plan_corrupt", runId, `${label} is missing ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw runtimeError("run_plan_corrupt", runId, `${label} has unexpected key ${key}`);
  }
}

function asString(value: unknown, runId: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw runtimeError("run_plan_corrupt", runId, `${label} is not a non-empty string`);
  }
  return value;
}

function asStringAllowEmpty(value: unknown, runId: string, label: string): string {
  if (typeof value !== "string") throw runtimeError("run_plan_corrupt", runId, `${label} is not a string`);
  return value;
}

function asBoolean(value: unknown, runId: string, label: string): boolean {
  if (typeof value !== "boolean") throw runtimeError("run_plan_corrupt", runId, `${label} is not a boolean`);
  return value;
}

function asCount(value: unknown, runId: string, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw runtimeError("run_plan_corrupt", runId, `${label} is not a positive integer`);
  }
  return value;
}

function asDuration(value: unknown, runId: string, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw runtimeError("run_plan_corrupt", runId, `${label} is not a duration integer`);
  }
  return value;
}

function asCost(value: unknown, runId: string, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw runtimeError("run_plan_corrupt", runId, `${label} is not a positive cost`);
  }
  return value;
}

function asIndex(value: unknown, runId: string, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw runtimeError("run_plan_corrupt", runId, `${label} is not a non-negative integer`);
  }
  return value;
}

function asStringArray(value: unknown, runId: string, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw runtimeError("run_plan_corrupt", runId, `${label} is not a string array`);
  }
  return [...value];
}

function asUnknownArray(value: unknown, runId: string, label: string): unknown[] {
  if (!Array.isArray(value)) throw runtimeError("run_plan_corrupt", runId, `${label} is not an array`);
  return value;
}

function asObjectArray(value: unknown, runId: string, label: string): JsonObject[] {
  if (!Array.isArray(value)) throw runtimeError("run_plan_corrupt", runId, `${label} is not an array`);
  return value.map((entry, index) => asJsonObject(entry, runId, `${label}[${index}]`));
}

function asJsonObject(value: unknown, runId: string, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw runtimeError("run_plan_corrupt", runId, `${label} is not an object`);
  }
  return cloneJson(value) as JsonObject;
}

function cloneJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(right);
  return left.every((entry) => set.has(entry));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
  } else {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  }
  return Object.freeze(value);
}

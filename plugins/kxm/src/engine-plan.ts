import { createHash } from "node:crypto";
import { kxmCanonicalJson, kxmPortablePath, type JsonObject, type JsonValue } from "./project-config.ts";
import {
  KXM_COMPILED_WORKFLOW_SCHEMA,
  type KxmCompiledAssignments,
  type KxmCompiledEvidence,
  type KxmCompiledJoin,
  type KxmCompiledPlan,
  type KxmCompiledStep,
  type KxmCompiledTransition,
  type KxmRepositoryAccess,
} from "./engine-compile.ts";
import {
  KXM_ABSENT_MEMORY_REVISION,
  runtimeError,
  type KxmRunEventStore,
  type KxmRunRecord,
} from "./runtime-store.ts";

export const KXM_RUN_PLAN_SCHEMA = "kxm.run-plan.v2";
const SUPPORTED_KINDS = new Set(["agent", "moa", "gate", "approval", "wait"]);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const JOIN_STRATEGIES = new Set(["all", "all-settled", "quorum", "first-success"]);
const EVIDENCE_KINDS = new Set(["assignment-result", "gate", "receipt", "approval", "artifact"]);
const REPOSITORY_ACCESS = new Set(["none", "read", "write"]);
const DISTINCT_BY = new Set(["provider", "model", "profile"]);
const ENVELOPE_REQUIRED = ["schema", "runId", "projectId", "homeRuntimeId", "workflowId", "revisions", "projectLimits", "plan", "gates"] as const;
const GATES_REQUIRED = ["registry", "definitions", "controlRoot"] as const;
const REGISTRY_PIN_REQUIRED = ["schema", "hash"] as const;
const CONTROL_ROOT_REQUIRED = ["repositoryId", "projectKey"] as const;
const GATE_REGISTRY_SCHEMA = "kxm.gate-registry.v1";
const REVISION_REQUIRED = ["config", "executorPolicy", "toolPolicy", "memory"] as const;
const PROJECT_LIMIT_REQUIRED = ["maxConcurrentRuns"] as const;
const PROJECT_LIMIT_OPTIONAL = ["maxRunDurationMs", "maxAgentTimeMs", "agentStepTimeoutMs"] as const;
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

export type KxmGateDefinition =
  | { readonly kind: "command"; readonly argv: readonly string[]; readonly timeoutMs: number; readonly cwd?: "control" }
  | { readonly kind: "artifacts-exist"; readonly paths: readonly string[] }
  | { readonly kind: "reserved" };

export interface KxmPinnedGates {
  readonly registry: { readonly schema: typeof GATE_REGISTRY_SCHEMA; readonly hash: string } | null;
  readonly definitions: Readonly<Record<string, KxmGateDefinition>>;
  readonly controlRoot: { readonly repositoryId: "control"; readonly projectKey: string };
}

export interface KxmRunPlanEnvelope {
  readonly schema: typeof KXM_RUN_PLAN_SCHEMA;
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
    readonly agentStepTimeoutMs?: number;
  };
  readonly plan: KxmCompiledPlan;
  readonly gates: KxmPinnedGates;
}

export function kxmSha256(input: string): string {
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

/**
 * Stable identity of what one step asks of one agent. It is equal across runs
 * of the same compiled step and agent, and it excludes the run, assignment and
 * attempt ids, the run objective, repositories, model and the context packet,
 * so a repeated ask is recognisable whatever the run was asked to do.
 */
export function kxmStepAskSha256(plan: KxmCompiledPlan, stepId: string, agentId: string): string {
  const step = Object.hasOwn(plan.steps, stepId) ? plan.steps[stepId] : undefined;
  if (!step) throw runtimeError("run_plan_corrupt", plan.workflowId, `compiled plan is missing step ${stepId}`);
  return kxmSha256(kxmCanonicalJson({
    v: 1,
    workflowId: plan.workflowId,
    stepId,
    kind: step.kind,
    agentId,
    instructions: step.instructions ?? null,
    outcomes: [...step.outcomes],
    requiredEvidence: step.requiredEvidence.map((entry) => entry.key),
  }));
}

/**
 * The record-time verdict of one settled attempt. Only gate-negative results
 * are known when the attempt settles: a back edge is 'blocked', and a producer
 * error, an unknown outcome or a terminal failure is 'failed'. A forward edge
 * or a completed terminal is undecided here; acceptance is resolved later from
 * the event log, so this never returns 'accepted'.
 */
export function kxmAttemptFinalOutcome(
  step: Pick<KxmCompiledStep, "transitions">,
  settled: { readonly resultClass: string; readonly outcome?: string | undefined },
): "blocked" | "failed" | undefined {
  if (settled.resultClass !== "outcome") return "failed";
  const outcome = settled.outcome;
  const transition = outcome !== undefined && Object.hasOwn(step.transitions, outcome) ? step.transitions[outcome] : undefined;
  if (!transition) return "failed";
  if (transition.to === "terminal") return transition.terminalStatus === "completed" ? undefined : "failed";
  return transition.edge === "back" ? "blocked" : undefined;
}

export function hashKxmRunPlanEnvelope(envelope: KxmRunPlanEnvelope): string {
  return kxmSha256(kxmCanonicalJson(envelope as unknown as JsonValue));
}

export function freezeKxmCompiledPlan(plan: KxmCompiledPlan): KxmCompiledPlan {
  const steps = Object.create(null) as Record<string, KxmCompiledStep>;
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

function freezeStep(step: KxmCompiledStep): KxmCompiledStep {
  const transitions = Object.create(null) as Record<string, KxmCompiledTransition>;
  for (const outcome of step.outcomes) {
    const transition = step.transitions[outcome];
    if (!transition) throw runtimeError("run_plan_corrupt", step.id, `compiled plan is missing transition ${outcome}`);
    transitions[outcome] = { ...transition };
  }
  const repositories = Object.create(null) as Record<string, KxmRepositoryAccess>;
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

export function parseKxmRunPlanEnvelope(raw: string, run: KxmRunRecord, expectedHash: string): KxmRunPlanEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw runtimeError("run_plan_corrupt", run.runId, "run plan envelope is not JSON");
  }
  const envelope = parseEnvelope(parsed, run);
  const hash = hashKxmRunPlanEnvelope(envelope);
  if (hash !== expectedHash) {
    throw runtimeError("run_plan_corrupt", run.runId, "run plan envelope hash does not match");
  }
  return envelope;
}

export function rehydrateKxmCompiledPlanFromStore(store: KxmRunEventStore, run: KxmRunRecord): KxmCompiledPlan {
  return loadPinnedEnvelope(store, run).plan;
}

export function loadKxmRunPlanEnvelope(store: KxmRunEventStore, run: KxmRunRecord): KxmRunPlanEnvelope {
  return loadPinnedEnvelope(store, run);
}

function loadPinnedEnvelope(store: KxmRunEventStore, run: KxmRunRecord): KxmRunPlanEnvelope {
  const row = store.runPlan(run.runId);
  if (!row) throw runtimeError("run_plan_missing", run.runId, "run has no pinned plan");
  const events = store.events(run.runId, 0, row.pinnedSequence);
  const pinEvent = events.find((event) => event.sequence === row.pinnedSequence);
  const eventHash = pinEvent?.payload.runPlanHash;
  if (typeof eventHash !== "string" || eventHash !== row.runPlanHash) {
    throw runtimeError("run_plan_corrupt", run.runId, "pinned runPlanHash does not match the plan row");
  }
  return parseKxmRunPlanEnvelope(row.envelope, run, row.runPlanHash);
}

export function absentMemoryRevision(): string {
  return KXM_ABSENT_MEMORY_REVISION;
}

function parseEnvelope(parsed: unknown, run: KxmRunRecord): KxmRunPlanEnvelope {
  const value = asObject(parsed, run.runId, "run plan envelope");
  assertExactKeys(value, ENVELOPE_REQUIRED, [], run.runId, "run plan envelope");
  if (value.schema !== KXM_RUN_PLAN_SCHEMA) {
    throw runtimeError("run_plan_corrupt", run.runId, "schema is not kxm.run-plan.v2");
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
  const projectLimits: KxmRunPlanEnvelope["projectLimits"] = {
    maxConcurrentRuns: asCount(limitsValue.maxConcurrentRuns, run.runId, "projectLimits.maxConcurrentRuns"),
    ...(limitsValue.maxRunDurationMs !== undefined ? { maxRunDurationMs: asDuration(limitsValue.maxRunDurationMs, run.runId, "projectLimits.maxRunDurationMs") } : {}),
    ...(limitsValue.maxAgentTimeMs !== undefined ? { maxAgentTimeMs: asDuration(limitsValue.maxAgentTimeMs, run.runId, "projectLimits.maxAgentTimeMs") } : {}),
    ...(limitsValue.agentStepTimeoutMs !== undefined ? { agentStepTimeoutMs: asAgentStepTimeout(limitsValue.agentStepTimeoutMs, run.runId, "projectLimits.agentStepTimeoutMs") } : {}),
  };
  const plan = freezeKxmCompiledPlan(parseCompiledPlan(value.plan, run.runId));
  return {
    schema: KXM_RUN_PLAN_SCHEMA,
    runId,
    projectId,
    homeRuntimeId,
    workflowId,
    revisions,
    projectLimits,
    plan,
    gates: freezeGates(parseGates(value.gates, plan, run.runId)),
  };
}

function parseGates(raw: unknown, plan: KxmCompiledPlan, runId: string): KxmPinnedGates {
  const value = asObject(raw, runId, "gates");
  assertExactKeys(value, GATES_REQUIRED, [], runId, "gates");
  const referenced = new Set<string>();
  for (const stepId of plan.order) {
    const step = plan.steps[stepId];
    if (step?.kind === "gate") referenced.add(step.gate);
  }
  const registry = parseRegistryPin(value.registry, runId, referenced.size > 0);
  const controlRoot = parseControlRoot(value.controlRoot, runId);
  const definitionsValue = asObject(value.definitions, runId, "gates.definitions");
  const defined = Object.keys(definitionsValue);
  for (const stepId of plan.order) {
    const step = plan.steps[stepId];
    if (step?.kind !== "gate") continue;
    if (!(step.gate in definitionsValue)) {
      throw runtimeError("run_plan_corrupt", runId, `gate step ${stepId} has no pinned definition`);
    }
  }
  for (const gateId of defined) {
    if (!referenced.has(gateId)) {
      throw runtimeError("run_plan_corrupt", runId, `definition ${gateId} is not referenced`);
    }
  }
  const definitions = Object.create(null) as Record<string, KxmGateDefinition>;
  for (const gateId of defined) {
    definitions[gateId] = parseGateDefinition(definitionsValue[gateId], gateId, runId);
  }
  return { registry, definitions, controlRoot };
}

function parseRegistryPin(raw: unknown, runId: string, required: boolean): KxmPinnedGates["registry"] {
  if (raw === null) {
    if (required) throw runtimeError("run_plan_corrupt", runId, "gate steps require a non-null registry pin");
    return null;
  }
  const value = asObject(raw, runId, "gates.registry");
  assertExactKeys(value, REGISTRY_PIN_REQUIRED, [], runId, "gates.registry");
  if (value.schema !== GATE_REGISTRY_SCHEMA) {
    throw runtimeError("run_plan_corrupt", runId, "gates.registry.schema is not kxm.gate-registry.v1");
  }
  const hash = asString(value.hash, runId, "gates.registry.hash");
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) {
    throw runtimeError("run_plan_corrupt", runId, "gates.registry.hash is not a sha256 digest");
  }
  return { schema: GATE_REGISTRY_SCHEMA, hash };
}

function parseControlRoot(raw: unknown, runId: string): KxmPinnedGates["controlRoot"] {
  const value = asObject(raw, runId, "gates.controlRoot");
  assertExactKeys(value, CONTROL_ROOT_REQUIRED, [], runId, "gates.controlRoot");
  const repositoryId = asString(value.repositoryId, runId, "gates.controlRoot.repositoryId");
  if (repositoryId !== "control") {
    throw runtimeError("run_plan_corrupt", runId, "gates.controlRoot.repositoryId must be control");
  }
  return { repositoryId: "control", projectKey: asString(value.projectKey, runId, "gates.controlRoot.projectKey") };
}

export function parseGateDefinition(raw: unknown, gateId: string, runId: string): KxmGateDefinition {
  const value = asObject(raw, runId, `gates.definitions.${gateId}`);
  const kind = asString(value.kind, runId, `gates.definitions.${gateId}.kind`);
  if (kind === "command") {
    assertExactKeys(value, ["kind", "argv", "timeoutMs"], ["cwd"], runId, `gates.definitions.${gateId}`);
    const argv = asStringArray(value.argv, runId, `gates.definitions.${gateId}.argv`);
    if (argv.length < 1 || argv.length > 64) {
      throw runtimeError("run_plan_corrupt", runId, `gates.definitions.${gateId}.argv length is invalid`);
    }
    for (const [index, entry] of argv.entries()) {
      if (entry.length === 0 || entry.length > 4096 || entry.includes("\u0000")) {
        throw runtimeError("run_plan_corrupt", runId, `gates.definitions.${gateId}.argv[${index}] is invalid`);
      }
    }
    const executable = argv[0]!;
    if (executable === "." || executable === ".." || executable.includes("\\") || (!executable.startsWith("/") && executable.includes("/"))) {
      throw runtimeError("run_plan_corrupt", runId, `gates.definitions.${gateId} argv[0] must be a bare executable or absolute POSIX path`);
    }
    const timeoutMs = value.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw runtimeError("run_plan_corrupt", runId, `gates.definitions.${gateId}.timeoutMs is invalid`);
    }
    if (value.cwd !== undefined && value.cwd !== "control") {
      throw runtimeError("run_plan_corrupt", runId, `gates.definitions.${gateId}.cwd is invalid`);
    }
    return {
      kind: "command",
      argv,
      timeoutMs,
      ...(value.cwd === "control" ? { cwd: "control" as const } : {}),
    };
  }
  if (kind === "artifacts-exist") {
    assertExactKeys(value, ["kind", "paths"], [], runId, `gates.definitions.${gateId}`);
    const paths = asStringArray(value.paths, runId, `gates.definitions.${gateId}.paths`);
    if (paths.length < 1 || paths.length > 64) {
      throw runtimeError("run_plan_corrupt", runId, `gates.definitions.${gateId}.paths length is invalid`);
    }
    if (new Set(paths).size !== paths.length) {
      throw runtimeError("run_plan_corrupt", runId, `gates.definitions.${gateId}.paths are not unique`);
    }
    for (const path of paths) {
      if (path === "." || !kxmPortablePath(path) || path.startsWith("/") || path.includes("\\")) {
        throw runtimeError("run_plan_corrupt", runId, `gates.definitions.${gateId} path is not a portable relative path`);
      }
    }
    return { kind: "artifacts-exist", paths };
  }
  if (kind === "reserved") {
    assertExactKeys(value, ["kind"], [], runId, `gates.definitions.${gateId}`);
    return { kind: "reserved" };
  }
  throw runtimeError("run_plan_corrupt", runId, `gates.definitions.${gateId} kind is invalid`);
}

function freezeGates(gates: KxmPinnedGates): KxmPinnedGates {
  const definitions = Object.create(null) as Record<string, KxmGateDefinition>;
  for (const [id, definition] of Object.entries(gates.definitions)) {
    definitions[id] = deepFreeze({ ...definition, ...(definition.kind === "command" ? { argv: [...definition.argv] } : {}), ...(definition.kind === "artifacts-exist" ? { paths: [...definition.paths] } : {}) } as KxmGateDefinition);
  }
  return deepFreeze({
    registry: gates.registry ? { ...gates.registry } : null,
    definitions,
    controlRoot: { ...gates.controlRoot },
  });
}

function parseCompiledPlan(raw: unknown, runId: string): KxmCompiledPlan {
  const value = asObject(raw, runId, "compiled plan");
  assertExactKeys(value, PLAN_REQUIRED, PLAN_OPTIONAL, runId, "compiled plan");
  if (value.schema !== KXM_COMPILED_WORKFLOW_SCHEMA) {
    throw runtimeError("run_plan_corrupt", runId, "compiled plan schema is not kxm.compiled-workflow.v1");
  }
  const order = asStringArray(value.order, runId, "order");
  const stepsValue = asObject(value.steps, runId, "steps");
  const stepIds = Object.keys(stepsValue);
  if (!sameSet(stepIds, order)) {
    throw runtimeError("run_plan_corrupt", runId, "compiled plan step keys do not equal order");
  }
  const steps = Object.create(null) as Record<string, KxmCompiledStep>;
  for (const stepId of order) {
    steps[stepId] = parseStep(stepsValue[stepId], stepId, runId);
  }
  const entryStepId = asString(value.entryStepId, runId, "entryStepId");
  if (!steps[entryStepId] || !order.includes(entryStepId)) {
    throw runtimeError("run_plan_corrupt", runId, "entryStepId is not in compiled steps");
  }
  const limitsObject = asObject(value.limits, runId, "limits");
  assertExactKeys(limitsObject, [], LIMIT_OPTIONAL, runId, "limits");
  const limits: KxmCompiledPlan["limits"] = {
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
  const plan: KxmCompiledPlan = {
    schema: KXM_COMPILED_WORKFLOW_SCHEMA,
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

function parseStep(raw: unknown, stepId: string, runId: string): KxmCompiledStep {
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
  const transitions = Object.create(null) as Record<string, KxmCompiledTransition>;
  for (const outcome of outcomes) {
    transitions[outcome] = parseTransition(transitionsValue[outcome], stepId, outcome, runId);
  }
  const repositoriesValue = asObject(value.repositories, runId, `${stepId}.repositories`);
  const repositories = Object.create(null) as Record<string, KxmRepositoryAccess>;
  for (const [repositoryId, access] of Object.entries(repositoriesValue)) {
    if (typeof access !== "string" || !REPOSITORY_ACCESS.has(access)) {
      throw runtimeError("run_plan_corrupt", runId, `step ${stepId} repository ${repositoryId} has invalid access`);
    }
    repositories[repositoryId] = access as KxmRepositoryAccess;
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

function parseTransition(raw: unknown, stepId: string, outcome: string, runId: string): KxmCompiledTransition {
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

function parseAssignments(raw: unknown, stepId: string, runId: string): KxmCompiledAssignments {
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

function parseJoin(raw: unknown, stepId: string, runId: string): KxmCompiledJoin {
  const value = asObject(raw, runId, `${stepId}.join`);
  assertExactKeys(value, JOIN_REQUIRED, JOIN_OPTIONAL, runId, `${stepId}.join`);
  const strategy = asString(value.strategy, runId, `${stepId}.join.strategy`);
  if (!JOIN_STRATEGIES.has(strategy)) {
    throw runtimeError("run_plan_corrupt", runId, `step ${stepId} join strategy is invalid`);
  }
  return {
    strategy: strategy as KxmCompiledJoin["strategy"],
    ...(value.minimumPassed !== undefined ? { minimumPassed: asCount(value.minimumPassed, runId, `${stepId}.join.minimumPassed`) } : {}),
    ...(value.cancelRemaining !== undefined ? { cancelRemaining: asBoolean(value.cancelRemaining, runId, `${stepId}.join.cancelRemaining`) } : {}),
  };
}

function parseEvidence(raw: unknown, stepId: string, index: number, runId: string): KxmCompiledEvidence {
  const value = asObject(raw, runId, `${stepId}.requiredEvidence[${index}]`);
  assertExactKeys(value, EVIDENCE_REQUIRED, EVIDENCE_OPTIONAL, runId, `${stepId}.requiredEvidence[${index}]`);
  const kind = asString(value.kind, runId, `${stepId}.requiredEvidence[${index}].kind`);
  if (!EVIDENCE_KINDS.has(kind)) {
    throw runtimeError("run_plan_corrupt", runId, `step ${stepId} evidence kind is invalid`);
  }
  return {
    key: asString(value.key, runId, `${stepId}.requiredEvidence[${index}].key`),
    kind: kind as KxmCompiledEvidence["kind"],
    minimum: asCount(value.minimum, runId, `${stepId}.requiredEvidence[${index}].minimum`),
    reusableAcrossAttempts: asBoolean(value.reusableAcrossAttempts, runId, `${stepId}.requiredEvidence[${index}].reusableAcrossAttempts`),
    ...(value.producerPolicy !== undefined ? { producerPolicy: parseProducerPolicy(value.producerPolicy, stepId, runId) } : {}),
  };
}

function parseProducerPolicy(raw: unknown, stepId: string, runId: string): NonNullable<KxmCompiledEvidence["producerPolicy"]> {
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
  steps: Readonly<Record<string, KxmCompiledStep>>,
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

function asAgentStepTimeout(value: unknown, runId: string, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 60_000) {
    throw runtimeError("run_plan_corrupt", runId, `${label} is below 60000`);
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

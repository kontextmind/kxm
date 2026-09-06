import type { JsonObject, JsonValue } from "./vnext-config.ts";

export const VNEXT_COMPILED_WORKFLOW_SCHEMA = "kxm.compiled-workflow.v1";
export const VNEXT_RESERVED_STEP_KINDS = ["workflow"] as const;

const WORKFLOW_SCHEMA = "kxm.workflow.v1";
const STEP_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const SUPPORTED_STEP_KINDS = new Set(["agent", "moa", "gate", "approval", "wait"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const JOIN_STRATEGIES = new Set(["all", "all-settled", "quorum", "first-success"]);
const EVIDENCE_KINDS = new Set(["assignment-result", "gate", "receipt", "approval", "artifact"]);
const REPOSITORY_ACCESS = new Set(["none", "read", "write"]);
const DISTINCT_BY = new Set(["provider", "model", "profile"]);
const BANNED_RUNTIME_HINT = "not yet supported";

export type ReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly ReadonlyJsonValue[]
  | { readonly [key: string]: ReadonlyJsonValue };
export type ReadonlyJsonObject = { readonly [key: string]: ReadonlyJsonValue };

export type VnextTerminalStatus = "completed" | "failed" | "cancelled";
export type VnextCompiledStepKind = "agent" | "moa" | "gate" | "approval" | "wait";
export type VnextRepositoryAccess = "none" | "read" | "write";

export type VnextCompiledTransition =
  | { readonly to: "step"; readonly target: string; readonly edge: "forward" | "back"; readonly maxTransitions?: number }
  | { readonly to: "terminal"; readonly terminalStatus: VnextTerminalStatus; readonly maxTransitions?: number };

export interface VnextCompiledProducerPolicy {
  readonly minimumProducers: number;
  readonly eligibleAgents: readonly string[];
  readonly acceptedStatuses: readonly ["passed"];
  readonly degradation?: { readonly minimumProducers: number };
}

export interface VnextCompiledEvidence {
  readonly key: string;
  readonly kind: "assignment-result" | "gate" | "receipt" | "approval" | "artifact";
  readonly minimum: number;
  readonly reusableAcrossAttempts: boolean;
  readonly producerPolicy?: VnextCompiledProducerPolicy;
}

export interface VnextCompiledAssignments {
  readonly allowedAgents: readonly string[]; // declared, else [step.agent] when present, else []
  readonly minimum: number;
  readonly target: number;
  readonly maximum: number;
  readonly maxParallel: number;
  readonly maxAttemptsPerAssignment: number;
  readonly maxWriteRepositories?: number;
  readonly distinctBy: readonly ("provider" | "model" | "profile")[];
}

export interface VnextCompiledJoin {
  readonly strategy: "all" | "all-settled" | "quorum" | "first-success";
  readonly minimumPassed?: number;
  readonly cancelRemaining?: boolean;
}

interface VnextCompiledStepBase {
  readonly id: string;
  readonly index: number;
  readonly description?: string;
  readonly instructions?: string;
  readonly maxAttempts: number;
  readonly timeoutMs?: number;
  readonly safeSpeculation: boolean;
  readonly repositories: Readonly<Record<string, VnextRepositoryAccess>>;
  readonly tools?: ReadonlyJsonObject;
  readonly secrets: readonly ReadonlyJsonObject[];
  readonly model?: ReadonlyJsonValue;
  readonly requiredEvidence: readonly VnextCompiledEvidence[];
  readonly outcomes: readonly string[];
  readonly transitions: Readonly<Record<string, VnextCompiledTransition>>;
  readonly requiresPlanHash: boolean;
  readonly assignments: VnextCompiledAssignments;
  readonly join: VnextCompiledJoin;
}

export type VnextCompiledStep =
  | (VnextCompiledStepBase & { readonly kind: "agent" | "moa"; readonly agent: string })
  | (VnextCompiledStepBase & { readonly kind: "gate"; readonly gate: string; readonly expect: "pass" | "fail" })
  | (VnextCompiledStepBase & { readonly kind: "approval" })
  | (VnextCompiledStepBase & { readonly kind: "wait"; readonly signal: string });

export interface VnextCompiledPlan {
  readonly schema: typeof VNEXT_COMPILED_WORKFLOW_SCHEMA;
  readonly workflowId: string;
  readonly sourcePath?: string;
  readonly coordinator: string;
  readonly limits: {
    readonly maxTransitions?: number;
    readonly maxRunDurationMs?: number;
    readonly maxAgentTimeMs?: number;
    readonly maxModelCost?: number;
    readonly currency?: string;
  };
  readonly transitionBudget: number;
  readonly hasBackEdges: boolean;
  readonly entryStepId: string;
  readonly order: readonly string[];
  readonly steps: Readonly<Record<string, VnextCompiledStep>>;
  readonly reproOracle?: { readonly stageId: string; readonly evidenceKey: string };
  readonly planHash?: { readonly stageId: string; readonly evidenceKey: string };
  readonly requirePlanHash: readonly string[];
}

export interface VnextEngineCompileIssue {
  readonly code: string;
  readonly workflowId: string;
  readonly stepId?: string;
  readonly outcome?: string;
  readonly message: string;
}

export class VnextEngineCompileError extends Error {
  readonly issues: readonly VnextEngineCompileIssue[];

  constructor(issues: readonly VnextEngineCompileIssue[]) {
    const sorted = sortIssues(issues);
    super(sorted.map((issue) => `${issue.workflowId}: ${issue.code}: ${issue.message}`).join("\n"));
    this.name = "VnextEngineCompileError";
    this.issues = sorted;
  }
}

export interface VnextWorkflowCompileInput {
  readonly id: string;
  readonly value: JsonObject;
  readonly logicalPath?: string;
}

interface IssueSink {
  workflowId: string;
  issues: VnextEngineCompileIssue[];
}

export function compileVnextWorkflow(input: VnextWorkflowCompileInput): VnextCompiledPlan {
  const sink: IssueSink = { workflowId: input.id, issues: [] };
  const value = input.value;
  if (value.schema !== WORKFLOW_SCHEMA) {
    pushIssue(sink, { code: "workflow_schema_unsupported", message: "schema is not kxm.workflow.v1" });
  }

  const rawSteps = valuesOf(value, "steps").map(objectValue).filter((step): step is JsonObject => Boolean(step));
  if (rawSteps.length === 0) {
    pushIssue(sink, { code: "steps_empty", message: "workflow has no steps" });
  }

  const stepIndex = new Map<string, number>();
  for (const [index, step] of rawSteps.entries()) {
    const id = stringValue(step.id);
    if (!id || !isStepId(id)) {
      pushIssue(sink, { code: "step_id_invalid", message: "step id is invalid", ...(id ? { stepId: id } : {}) });
      continue;
    }
    if (stepIndex.has(id)) {
      pushIssue(sink, { code: "step_id_duplicate", stepId: id, message: `step ${id} is duplicated` });
      continue;
    }
    stepIndex.set(id, index);
  }

  const limitsObject = objectValue(value.limits);
  const limits = compileLimits(limitsObject, sink);
  const requirePlanHash = names(value.requirePlanHash);
  const compiledSteps: VnextCompiledStep[] = [];
  let hasBackEdges = false;

  for (const [index, step] of rawSteps.entries()) {
    const compiled = compileStep(step, index, stepIndex, requirePlanHash, sink);
    if (!compiled) continue;
    compiledSteps.push(compiled);
    if (Object.values(compiled.transitions).some((transition) => transition.to === "step" && transition.edge === "back")) {
      hasBackEdges = true;
    }
  }

  if (hasBackEdges && typeof limitsObject?.maxTransitions !== "number") {
    pushIssue(sink, { code: "workflow_cycle_unbounded", message: "workflow with back-edges requires limits.maxTransitions" });
  }

  const reproOracle = compileOracle("reproOracle", objectValue(value.reproOracle), compiledSteps, sink);
  const planHash = compileOracle("planHash", objectValue(value.planHash), compiledSteps, sink);
  for (const stageId of requirePlanHash) {
    if (!stepIndex.has(stageId)) {
      pushIssue(sink, { code: "plan_hash_stage_unknown", message: `requirePlanHash references unknown stage ${stageId}` });
    }
  }

  if (sink.issues.length > 0) throw new VnextEngineCompileError(sink.issues);

  const order = compiledSteps.map((step) => step.id);
  const steps = Object.create(null) as Record<string, VnextCompiledStep>;
  for (const step of compiledSteps) steps[step.id] = step;
  const entryStepId = order[0];
  if (!entryStepId) throw new VnextEngineCompileError(sink.issues);
  const coordinator = stringValue(value.coordinator) ?? "coordinator";
  const transitionBudget = limits.maxTransitions ?? order.length;
  const plan: VnextCompiledPlan = {
    schema: VNEXT_COMPILED_WORKFLOW_SCHEMA,
    workflowId: input.id,
    ...(input.logicalPath !== undefined ? { sourcePath: input.logicalPath } : {}),
    coordinator,
    limits,
    transitionBudget,
    hasBackEdges,
    entryStepId,
    order,
    steps,
    ...(reproOracle ? { reproOracle } : {}),
    ...(planHash ? { planHash } : {}),
    requirePlanHash: [...requirePlanHash],
  };
  return deepFreeze(plan);
}

function compileLimits(
  limits: JsonObject | undefined,
  sink: IssueSink,
): VnextCompiledPlan["limits"] {
  if (!limits) return {};
  const compiled: {
    maxTransitions?: number;
    maxRunDurationMs?: number;
    maxAgentTimeMs?: number;
    maxModelCost?: number;
    currency?: string;
  } = {};
  if (limits.maxTransitions !== undefined) {
    if (isCount(limits.maxTransitions)) compiled.maxTransitions = limits.maxTransitions;
    else pushIssue(sink, { code: "count_invalid", message: "limits.maxTransitions must be an integer >= 1" });
  }
  if (limits.maxRunDurationMs !== undefined) {
    if (isDuration(limits.maxRunDurationMs)) compiled.maxRunDurationMs = limits.maxRunDurationMs;
    else pushIssue(sink, { code: "duration_invalid", message: "limits.maxRunDurationMs must be an integer >= 0" });
  }
  if (limits.maxAgentTimeMs !== undefined) {
    if (isDuration(limits.maxAgentTimeMs)) compiled.maxAgentTimeMs = limits.maxAgentTimeMs;
    else pushIssue(sink, { code: "duration_invalid", message: "limits.maxAgentTimeMs must be an integer >= 0" });
  }
  if (limits.maxModelCost !== undefined) {
    if (isCost(limits.maxModelCost)) compiled.maxModelCost = limits.maxModelCost;
    else pushIssue(sink, { code: "cost_invalid", message: "limits.maxModelCost must be a finite number > 0" });
  }
  if (limits.currency !== undefined) {
    if (typeof limits.currency === "string") compiled.currency = limits.currency;
  }
  return compiled;
}

function compileStep(
  step: JsonObject,
  index: number,
  stepIndex: ReadonlyMap<string, number>,
  requirePlanHash: readonly string[],
  sink: IssueSink,
): VnextCompiledStep | undefined {
  const id = stringValue(step.id);
  if (!id || !isStepId(id) || stepIndex.get(id) !== index) return undefined;
  const kind = stringValue(step.kind);
  if (kind === "workflow") {
    pushIssue(sink, { code: "step_kind_reserved", stepId: id, message: `kind workflow is ${BANNED_RUNTIME_HINT}` });
    return undefined;
  }
  if (!kind || !SUPPORTED_STEP_KINDS.has(kind)) {
    pushIssue(sink, { code: "step_kind_unknown", stepId: id, message: `kind ${String(kind)} is unknown` });
    return undefined;
  }

  const agent = stringValue(step.agent);
  const gate = stringValue(step.gate);
  const signal = stringValue(step.signal);
  if ((kind === "agent" || kind === "moa") && !agent) {
    pushIssue(sink, { code: "step_agent_missing", stepId: id, message: `${id} is missing agent` });
  }
  if (kind === "gate" && !gate) {
    pushIssue(sink, { code: "step_gate_missing", stepId: id, message: `${id} is missing gate` });
  }
  if (kind === "wait" && !signal) {
    pushIssue(sink, { code: "step_signal_missing", stepId: id, message: `${id} is missing signal` });
  }

  const maxAttempts = compileCountField(step.maxAttempts, 1, `${id}.maxAttempts`, id, sink);
  const timeoutMs = compileOptionalDuration(step.timeoutMs, `${id}.timeoutMs`, id, sink);
  const assignments = compileAssignments(step, id, agent, sink);
  const join = compileJoin(step, id, sink);
  const requiredEvidence = compileEvidence(step, id, sink);
  const transitions = compileTransitions(step, id, index, stepIndex, sink);
  const outcomes = Object.keys(transitions).sort(compareCodeUnits);
  const orderedTransitions = Object.create(null) as Record<string, VnextCompiledTransition>;
  for (const outcome of outcomes) {
    const transition = transitions[outcome];
    if (transition) orderedTransitions[outcome] = transition;
  }

  const description = stringValue(step.description);
  const instructions = stringValue(step.instructions);
  const base: VnextCompiledStepBase = {
    id,
    index,
    ...(description !== undefined ? { description } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    maxAttempts,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    safeSpeculation: step.safeSpeculation === true,
    repositories: compileRepositories(step.repositories),
    ...(isJsonObject(step.tools) ? { tools: cloneJsonObject(step.tools) } : {}),
    secrets: compileSecrets(step.secrets),
    ...(step.model !== undefined ? { model: cloneJsonValue(step.model) } : {}),
    requiredEvidence,
    outcomes,
    transitions: orderedTransitions,
    requiresPlanHash: requirePlanHash.includes(id),
    assignments,
    join,
  };

  if (kind === "agent" || kind === "moa") {
    if (!agent) return undefined;
    return { ...base, kind, agent };
  }
  if (kind === "gate") {
    if (!gate) return undefined;
    return { ...base, kind, gate, expect: "pass" };
  }
  if (kind === "wait") {
    if (!signal) return undefined;
    return { ...base, kind, signal };
  }
  return { ...base, kind: "approval" };
}

function compileAssignments(
  step: JsonObject,
  stepId: string,
  primaryAgentId: string | undefined,
  sink: IssueSink,
): VnextCompiledAssignments {
  const assignment = objectValue(step.assignments);
  const declaredAgents = assignment ? names(assignment.allowedAgents) : [];
  const allowedAgents = declaredAgents.length > 0 ? declaredAgents : primaryAgentId ? [primaryAgentId] : [];
  // Mirrors validateWorkflow in vnext-config.ts (minimum 1, target = minimum, maximum = target, maxParallel = maximum) for every kind. Do not resolve kind-conditional defaults here; the loader is the ceiling authority. Phase 7 changes both together.
  const minimum = compileCountField(assignment?.minimum, 1, `${stepId}.assignments.minimum`, stepId, sink);
  const target = compileCountField(assignment?.target, minimum, `${stepId}.assignments.target`, stepId, sink);
  const maximum = compileCountField(assignment?.maximum, target, `${stepId}.assignments.maximum`, stepId, sink);
  const maxParallel = compileCountField(assignment?.maxParallel, maximum, `${stepId}.assignments.maxParallel`, stepId, sink);
  const maxAttemptsPerAssignment = compileCountField(
    assignment?.maxAttemptsPerAssignment,
    1,
    `${stepId}.assignments.maxAttemptsPerAssignment`,
    stepId,
    sink,
  );
  const maxWriteRepositories = compileOptionalCount(
    assignment?.maxWriteRepositories,
    `${stepId}.assignments.maxWriteRepositories`,
    stepId,
    sink,
  );
  const distinctBy = names(assignment?.distinctBy).filter((value): value is "provider" | "model" | "profile" => DISTINCT_BY.has(value));
  return {
    allowedAgents: [...allowedAgents],
    minimum,
    target,
    maximum,
    maxParallel,
    maxAttemptsPerAssignment,
    ...(maxWriteRepositories !== undefined ? { maxWriteRepositories } : {}),
    distinctBy,
  };
}

function compileJoin(step: JsonObject, stepId: string, sink: IssueSink): VnextCompiledJoin {
  const join = objectValue(step.join);
  if (!join) return { strategy: "all" };
  const declared = stringValue(join.strategy);
  const strategy = declared && JOIN_STRATEGIES.has(declared)
    ? declared as VnextCompiledJoin["strategy"]
    : "all";
  const minimumPassed = compileOptionalCount(join.minimumPassed, `${stepId}.join.minimumPassed`, stepId, sink);
  const compiled: VnextCompiledJoin = {
    strategy,
    ...(minimumPassed !== undefined ? { minimumPassed } : {}),
    ...(typeof join.cancelRemaining === "boolean" ? { cancelRemaining: join.cancelRemaining } : {}),
  };
  return compiled;
}

function compileEvidence(step: JsonObject, stepId: string, sink: IssueSink): VnextCompiledEvidence[] {
  const evidence: VnextCompiledEvidence[] = [];
  const seen = new Set<string>();
  for (const candidate of valuesOf(step, "requiredEvidence")) {
    const requirement = objectValue(candidate);
    if (!requirement) continue;
    const key = stringValue(requirement.key);
    if (!key) continue;
    if (seen.has(key)) {
      pushIssue(sink, { code: "evidence_key_duplicate", stepId, message: `${stepId} evidence key ${key} is duplicated` });
      continue;
    }
    seen.add(key);
    const kind = stringValue(requirement.kind);
    if (!kind || !EVIDENCE_KINDS.has(kind)) continue;
    const minimum = compileCountField(requirement.minimum, 1, `${stepId}.${key}.minimum`, stepId, sink);
    const producerPolicy = objectValue(requirement.producerPolicy);
    const compiled: VnextCompiledEvidence = {
      key,
      kind: kind as VnextCompiledEvidence["kind"],
      minimum,
      reusableAcrossAttempts: requirement.reusableAcrossAttempts === true,
      ...(producerPolicy ? { producerPolicy: compileProducerPolicy(producerPolicy, stepId, key, sink) } : {}),
    };
    evidence.push(compiled);
  }
  return evidence;
}

function compileProducerPolicy(
  policy: JsonObject,
  stepId: string,
  key: string,
  sink: IssueSink,
): VnextCompiledProducerPolicy {
  const minimumProducers = compileCountField(
    policy.minimumProducers,
    1,
    `${stepId}.${key}.producerPolicy.minimumProducers`,
    stepId,
    sink,
  );
  const degradation = objectValue(policy.degradation);
  const degradationMinimum = compileOptionalCount(
    degradation?.minimumProducers,
    `${stepId}.${key}.producerPolicy.degradation.minimumProducers`,
    stepId,
    sink,
  );
  return {
    minimumProducers,
    eligibleAgents: names(policy.eligibleAgents),
    acceptedStatuses: ["passed"],
    ...(degradationMinimum !== undefined ? { degradation: { minimumProducers: degradationMinimum } } : {}),
  };
}

function compileTransitions(
  step: JsonObject,
  stepId: string,
  index: number,
  stepIndex: ReadonlyMap<string, number>,
  sink: IssueSink,
): Record<string, VnextCompiledTransition> {
  const outcomes = objectValue(step.on);
  const compiled = Object.create(null) as Record<string, VnextCompiledTransition>;
  if (!outcomes || Object.keys(outcomes).length === 0) {
    pushIssue(sink, { code: "transitions_missing", stepId, message: `${stepId} has no declared transitions` });
    return compiled;
  }
  for (const [outcome, raw] of Object.entries(outcomes)) {
    const parsed = parseTransition(raw);
    const maxTransitions = compileOptionalCount(
      parsed.maxTransitions,
      `${stepId}.${outcome}.maxTransitions`,
      stepId,
      sink,
      outcome,
    );
    if (parsed.target === "$terminal") {
      const status = parsed.terminalStatus;
      if (status === undefined) {
        pushIssue(sink, {
          code: "transition_terminal_status_missing",
          stepId,
          outcome,
          message: `${stepId}.${outcome} terminal transition requires terminalStatus`,
        });
        continue;
      }
      if (!TERMINAL_STATUSES.has(status)) {
        pushIssue(sink, {
          code: "transition_terminal_status_invalid",
          stepId,
          outcome,
          message: `${stepId}.${outcome} terminalStatus is invalid`,
        });
        continue;
      }
      compiled[outcome] = {
        to: "terminal",
        terminalStatus: status as VnextTerminalStatus,
        ...(maxTransitions !== undefined ? { maxTransitions } : {}),
      };
      continue;
    }
    if (parsed.terminalStatus !== undefined) {
      pushIssue(sink, {
        code: "transition_terminal_status_unexpected",
        stepId,
        outcome,
        message: `${stepId}.${outcome} step target must not declare terminalStatus`,
      });
    }
    if (!parsed.target || !stepIndex.has(parsed.target)) {
      pushIssue(sink, {
        code: "transition_target_unknown",
        stepId,
        outcome,
        message: `${stepId}.${outcome} references unknown target ${String(parsed.target)}`,
      });
      continue;
    }
    const targetIndex = stepIndex.get(parsed.target)!;
    const back = targetIndex <= index;
    if (back && maxTransitions === undefined && parsed.maxTransitions === undefined) {
      pushIssue(sink, {
        code: "back_edge_unbounded",
        stepId,
        outcome,
        message: `${stepId}.${outcome} back-edge requires maxTransitions`,
      });
    }
    compiled[outcome] = {
      to: "step",
      target: parsed.target,
      edge: back ? "back" : "forward",
      ...(maxTransitions !== undefined ? { maxTransitions } : {}),
    };
  }
  return compiled;
}

function parseTransition(value: JsonValue): { target?: string; maxTransitions?: JsonValue; terminalStatus?: string } {
  if (typeof value === "string") return { target: value };
  const object = objectValue(value);
  if (!object) return {};
  const target = stringValue(object.target);
  const terminalStatus = stringValue(object.terminalStatus);
  return {
    ...(target ? { target } : {}),
    ...(object.maxTransitions !== undefined ? { maxTransitions: object.maxTransitions } : {}),
    ...(terminalStatus ? { terminalStatus } : {}),
  };
}

function compileOracle(
  field: "reproOracle" | "planHash",
  oracle: JsonObject | undefined,
  steps: readonly VnextCompiledStep[],
  sink: IssueSink,
): { stageId: string; evidenceKey: string } | undefined {
  if (!oracle) return undefined;
  const stageId = stringValue(oracle.stageId);
  const evidenceKey = stringValue(oracle.evidenceKey);
  const step = stageId === undefined ? undefined : steps.find((candidate) => candidate.id === stageId);
  if (!stageId || !step) {
    pushIssue(sink, { code: "oracle_stage_unknown", message: `${field} references unknown stage ${String(stageId)}` });
    return undefined;
  }
  if (!evidenceKey || !step.requiredEvidence.some((item) => item.key === evidenceKey)) {
    pushIssue(sink, {
      code: "oracle_evidence_unknown",
      message: `${field} references undeclared evidence ${String(evidenceKey)} in ${stageId}`,
    });
    return undefined;
  }
  return { stageId, evidenceKey };
}

function compileRepositories(value: JsonValue | undefined): Readonly<Record<string, VnextRepositoryAccess>> {
  const source = objectValue(value) ?? {};
  const repositories: Record<string, VnextRepositoryAccess> = {};
  for (const [id, access] of Object.entries(source)) {
    if (typeof access === "string" && REPOSITORY_ACCESS.has(access)) {
      repositories[id] = access as VnextRepositoryAccess;
    }
  }
  return repositories;
}

function compileSecrets(value: JsonValue | undefined): ReadonlyJsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.map(objectValue).filter((entry): entry is JsonObject => Boolean(entry)).map(cloneJsonObject);
}

function compileCountField(
  value: JsonValue | undefined,
  fallback: number,
  path: string,
  stepId: string,
  sink: IssueSink,
): number {
  if (value === undefined) return fallback;
  if (isCount(value)) return value;
  pushIssue(sink, { code: "count_invalid", stepId, message: `${path} must be an integer >= 1` });
  return fallback;
}

function compileOptionalCount(
  value: JsonValue | undefined,
  path: string,
  stepId: string,
  sink: IssueSink,
  outcome?: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (isCount(value)) return value;
  pushIssue(sink, {
    code: "count_invalid",
    stepId,
    ...(outcome ? { outcome } : {}),
    message: `${path} must be an integer >= 1`,
  });
  return undefined;
}

function compileOptionalDuration(
  value: JsonValue | undefined,
  path: string,
  stepId: string,
  sink: IssueSink,
): number | undefined {
  if (value === undefined) return undefined;
  if (isDuration(value)) return value;
  pushIssue(sink, { code: "duration_invalid", stepId, message: `${path} must be an integer >= 0` });
  return undefined;
}

function isCount(value: JsonValue): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isDuration(value: JsonValue): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isCost(value: JsonValue): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isStepId(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && STEP_ID_PATTERN.test(value);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function valuesOf(object: JsonObject, field: string): JsonValue[] {
  const value = object[field];
  return Array.isArray(value) ? value : [];
}

function names(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((candidate): candidate is string => typeof candidate === "string") : [];
}

function cloneJsonValue(value: JsonValue): ReadonlyJsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => cloneJsonValue(entry));
  return cloneJsonObject(isJsonObject(value) ? value : {});
}

function cloneJsonObject(value: JsonObject): ReadonlyJsonObject {
  const copy: { [key: string]: ReadonlyJsonValue } = {};
  for (const [key, child] of Object.entries(value)) copy[key] = cloneJsonValue(child);
  return copy;
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

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOptional(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return compareCodeUnits(left, right);
}

function sortIssues(issues: readonly VnextEngineCompileIssue[]): VnextEngineCompileIssue[] {
  return [...issues].sort((left, right) => {
    const byStep = compareOptional(left.stepId, right.stepId);
    if (byStep !== 0) return byStep;
    const byOutcome = compareOptional(left.outcome, right.outcome);
    if (byOutcome !== 0) return byOutcome;
    return compareCodeUnits(left.code, right.code);
  });
}

function pushIssue(sink: IssueSink, issue: Omit<VnextEngineCompileIssue, "workflowId">): void {
  sink.issues.push({ workflowId: sink.workflowId, ...issue });
}

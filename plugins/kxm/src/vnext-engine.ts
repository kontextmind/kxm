import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { compileVnextWorkflow, type VnextCompiledPlan, type VnextCompiledStep } from "./vnext-engine-compile.ts";
import { isTerminalRunStatus, type VnextRunState } from "./vnext-engine-fold.ts";
import {
  VNEXT_RUN_PLAN_SCHEMA,
  freezeVnextCompiledPlan,
  hashVnextRunPlanEnvelope,
  loadVnextRunPlanEnvelope,
  parseGateDefinition,
  rehydrateVnextCompiledPlanFromStore,
  type VnextPinnedGates,
  type VnextRunPlanEnvelope,
} from "./vnext-engine-plan.ts";
import { gateRegistryHash } from "./vnext-gate-hash.ts";
import {
  admitVnextRun,
  bindVnextSchedulerPolicy,
  enqueueVnextScheduledRun,
  registerVnextAttemptController,
  releaseVnextRun,
  unregisterVnextAttemptController,
  vnextAttemptController,
  vnextSchedulerPolicy,
} from "./vnext-runtime-owner.ts";
import {
  foldStoredVnextRun,
  persistVnextRunState,
  vnextEventBase,
  vnextIncrementMonotonicNs,
  vnextMonotonicNs,
  vnextPolicyRevisions,
  vnextProjectAdmissionLimits,
  type VnextRuntimeContext,
} from "./vnext-runtime.ts";
import {
  newVnextAssignmentId,
  newVnextAttemptId,
  newVnextEventId,
  projectRuntimeKey,
  runtimeError,
  type VnextAttemptCapabilityRow,
  type VnextRunEvent,
  type VnextRunRecord,
  type VnextRunStatus,
} from "./vnext-runtime-store.ts";
import { vnextCanonicalJson, type JsonValue, type VnextProjectBundle } from "./vnext-config.ts";

const trustedProducers = new WeakSet<object>();
const CAPABILITY_PREFIX = "kxm-attempt-capability\0";

export interface VnextProducerRequest {
  readonly runId: string;
  readonly stepId: string;
  readonly stepAttempt: number;
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly capability: string;
  readonly allowedOutcomes: readonly string[];
  readonly signal: AbortSignal;
}

export interface VnextProducerResult {
  readonly outcome: string;
}

export interface VnextProducer {
  readonly id: "driver-simulated";
  produce(request: VnextProducerRequest): Promise<VnextProducerResult>;
}

export interface VnextRunHandoff {
  readonly reason: "limit_unsupported" | "step_unsupported" | "attempt_unreconciled" | "cancel_pending_foreign";
  readonly field?: string;
  readonly stepId?: string;
  readonly attemptId?: string;
  readonly detail: string;
}

export interface VnextRunDriveResult {
  readonly state: VnextRunState;
  readonly handoff?: VnextRunHandoff;
}

export interface VnextAttemptCapabilityRecord extends VnextAttemptCapabilityRow {
  readonly runPlanHash: string;
  readonly toolPolicyRevision: string;
}

export function createVnextSimulatedProducer(
  script: (request: VnextProducerRequest) => Promise<VnextProducerResult> | VnextProducerResult,
): VnextProducer {
  const producer = Object.freeze({
    id: "driver-simulated" as const,
    produce(request: VnextProducerRequest): Promise<VnextProducerResult> {
      try {
        return Promise.resolve(script(request));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  });
  trustedProducers.add(producer);
  return producer;
}

function requireTrustedProducer(producer: VnextProducer): void {
  if (!trustedProducers.has(producer)) {
    throw runtimeError("engine_producer_untrusted", "producer", "producer is not a driver-simulated factory instance");
  }
}

function hashCapabilitySecret(secret: string): string {
  return `sha256:${createHash("sha256").update(`${CAPABILITY_PREFIX}${secret}`, "utf8").digest("hex")}`;
}

export function mintVnextCapabilitySecret(): { secret: string; hash: string } {
  const secret = `kxmcap_${randomBytes(32).toString("base64url")}`;
  return { secret, hash: hashCapabilitySecret(secret) };
}

function mintCapabilitySecret(): { secret: string; hash: string } {
  return mintVnextCapabilitySecret();
}

export function pinVnextCompiledPlan(
  context: VnextRuntimeContext,
  bundle: VnextProjectBundle,
  runId: string,
): { plan: VnextCompiledPlan; runPlanHash: string; idempotent: boolean; event?: VnextRunEvent } {
  return context.eventStore.transaction(() => {
    const run = requireRun(context, runId);
    if (run.projectId !== context.projectId || run.homeRuntimeId !== context.homeRuntimeId) {
      throw runtimeError("run_owner_mismatch", runId, "run is not owned by this runtime context");
    }
    if (String(bundle.project.value.id) !== run.projectId) {
      throw runtimeError("run_owner_mismatch", runId, "bundle project does not match the run");
    }
    const workflow = bundle.workflows.get(run.workflowId);
    if (!workflow) throw runtimeError("run_workflow_unknown", run.workflowId, `workflow ${run.workflowId} does not exist in this project`);
    const revisions = vnextPolicyRevisions(bundle);
    if (
      revisions.configRevision !== run.configRevision
      || revisions.executorPolicyRevision !== run.executorPolicyRevision
      || revisions.toolPolicyRevision !== run.toolPolicyRevision
      || revisions.memoryRevision !== run.memoryRevision
    ) {
      throw runtimeError("run_revision_drift", runId, "bundle revisions do not match the accepted run");
    }
    const compiled = freezeVnextCompiledPlan(compileVnextWorkflow({
      id: run.workflowId,
      value: workflow.value,
      ...(workflow.logicalPath !== undefined ? { logicalPath: workflow.logicalPath } : {}),
    }));
    const envelope: VnextRunPlanEnvelope = {
      schema: VNEXT_RUN_PLAN_SCHEMA,
      runId: run.runId,
      projectId: run.projectId,
      homeRuntimeId: run.homeRuntimeId,
      workflowId: run.workflowId,
      revisions: {
        config: run.configRevision,
        executorPolicy: run.executorPolicyRevision,
        toolPolicy: run.toolPolicyRevision,
        memory: run.memoryRevision,
      },
      projectLimits: vnextProjectAdmissionLimits(bundle),
      plan: compiled,
      gates: pinnedGatesForCompiledPlan(compiled, bundle, context.projectRoot),
    };
    const runPlanHash = hashVnextRunPlanEnvelope(envelope);
    const existing = context.eventStore.runPlan(runId);
    if (existing) {
      if (existing.runPlanHash !== runPlanHash) {
        throw runtimeError("run_plan_pinned", runId, "run already has a different pinned plan");
      }
      return { plan: compiled, runPlanHash, idempotent: true };
    }
    if (run.status !== "created") {
      throw runtimeError("run_plan_pinned", runId, "a plan can only be pinned from created");
    }
    const now = new Date().toISOString();
    const sequence = context.eventStore.nextSequence(runId);
    const event: VnextRunEvent = {
      ...vnextEventBase(context, run, now, vnextMonotonicNs()),
      eventId: newVnextEventId(),
      eventType: "run.status_changed",
      sequence,
      payload: { status: "preparing", runPlanHash },
    };
    context.eventStore.insertRunPlan({
      runId,
      runPlanHash,
      envelope: vnextCanonicalJson(envelope as unknown as JsonValue),
      pinnedSequence: sequence,
    });
    context.eventStore.appendEvent(event);
    const state = foldStoredVnextRun(context, run);
    persistVnextRunState(context, runId, state, sequence);
    context.eventStore.updateRunStatus(runId, "preparing", now);
    return { plan: compiled, runPlanHash, idempotent: false, event };
  });
}

export function rehydrateVnextCompiledPlan(context: VnextRuntimeContext, runId: string): VnextCompiledPlan {
  const run = requireRun(context, runId);
  return rehydrateVnextCompiledPlanFromStore(context.eventStore, run);
}

export function startVnextRun(context: VnextRuntimeContext, runId: string): VnextRunDriveResult {
  return context.eventStore.transaction(() => {
    const run = requireRun(context, runId);
    const envelope = loadVnextRunPlanEnvelope(context.eventStore, run);
    const unsupported = unsupportedLimit(envelope);
    const state = foldStoredVnextRun(context, run);
    if (unsupported) {
      return { state, handoff: unsupported };
    }
    if (state.status !== "preparing") {
      return { state };
    }
    const now = new Date().toISOString();
    const sequence = context.eventStore.nextSequence(runId);
    const event: VnextRunEvent = {
      ...vnextEventBase(context, run, now, vnextMonotonicNs()),
      eventId: newVnextEventId(),
      eventType: "run.status_changed",
      sequence,
      payload: { status: "running" },
    };
    context.eventStore.appendEvent(event);
    const next = foldStoredVnextRun(context, run);
    persistVnextRunState(context, runId, next, sequence);
    context.eventStore.updateRunStatus(runId, "running", now);
    return { state: next };
  });
}

export async function stepVnextRun(context: VnextRuntimeContext, runId: string, producer: VnextProducer): Promise<VnextRunDriveResult> {
  requireTrustedProducer(producer);
  return withAdmission(context, runId, () => stepLocked(context, runId, producer));
}

export async function driveVnextRun(context: VnextRuntimeContext, runId: string, producer: VnextProducer): Promise<VnextRunDriveResult> {
  requireTrustedProducer(producer);
  const run = requireRun(context, runId);
  if (run.status === "created") {
    throw runtimeError("run_plan_missing", runId, "drive requires a pinned plan");
  }
  return withAdmission(context, runId, () => driveAdmitted(context, runId, producer));
}

async function driveAdmitted(context: VnextRuntimeContext, runId: string, producer: VnextProducer): Promise<VnextRunDriveResult> {
  const run = requireRun(context, runId);
  if (run.status === "preparing") {
    const started = startVnextRun(context, runId);
    if (started.handoff || isTerminalRunStatus(started.state.status)) return started;
  }
  let latest: VnextRunDriveResult = { state: foldStoredVnextRun(context, requireRun(context, runId)) };
  while (latest.state.status === "running") {
    const before = context.eventStore.runState(runId)?.lastSequence;
    latest = await stepLocked(context, runId, producer);
    if (latest.handoff) return latest;
    if (latest.state.status === "running") {
      const after = context.eventStore.runState(runId)?.lastSequence;
      if (after === before) {
        throw runtimeError("run_events_illegal", runId, "drive made no progress");
      }
    }
  }
  return latest;
}

async function withAdmission<T>(context: VnextRuntimeContext, runId: string, fn: () => Promise<T>): Promise<T> {
  const token = admitPinnedRun(context, runId);
  try {
    return await fn();
  } finally {
    releaseVnextRun(context.eventStore.path, runId, token);
  }
}

function admitPinnedRun(context: VnextRuntimeContext, runId: string): string {
  const run = requireRun(context, runId);
  const envelope = loadVnextRunPlanEnvelope(context.eventStore, run);
  return admitVnextRun(
    context.eventStore.path,
    runId,
    envelope.revisions.config,
    envelope.projectLimits.maxConcurrentRuns,
  );
}

export class VnextRunScheduler {
  private readonly context: VnextRuntimeContext;
  private readonly configRevision: string;

  private constructor(context: VnextRuntimeContext, configRevision: string) {
    this.context = context;
    this.configRevision = configRevision;
  }

  static for(context: VnextRuntimeContext, bundle: VnextProjectBundle): VnextRunScheduler {
    if (String(bundle.project.value.id) !== context.projectId) {
      throw runtimeError("run_owner_mismatch", context.projectId, "scheduler bundle project does not match the runtime context");
    }
    const limits = vnextProjectAdmissionLimits(bundle);
    bindVnextSchedulerPolicy(context.eventStore.path, limits.maxConcurrentRuns, bundle.configRevision);
    return new VnextRunScheduler(context, bundle.configRevision);
  }

  enqueue(runId: string, producer: VnextProducer): Promise<VnextRunDriveResult> {
    requireTrustedProducer(producer);
    const policy = vnextSchedulerPolicy(this.context.eventStore.path);
    if (!policy || policy.configRevision !== this.configRevision) {
      return Promise.reject(runtimeError("scheduler_policy_conflict", runId, "scheduler handle does not match the active policy"));
    }
    try {
      const run = requireRun(this.context, runId);
      const envelope = loadVnextRunPlanEnvelope(this.context.eventStore, run);
      return enqueueVnextScheduledRun(
        this.context.eventStore.path,
        runId,
        envelope.revisions.config,
        envelope.projectLimits.maxConcurrentRuns,
        () => driveAdmitted(this.context, runId, producer),
      ) as Promise<VnextRunDriveResult>;
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

export function verifyVnextAttemptCapability(
  context: VnextRuntimeContext,
  presented: string,
  expected: { runId: string; attemptId: string },
): VnextAttemptCapabilityRecord {
  const presentedHash = hashCapabilitySecret(presented);
  const row = context.eventStore.capabilityByHash(presentedHash);
  const run = context.eventStore.run(expected.runId);
  const folded = run ? foldStoredVnextRun(context, run) : undefined;
  const hashBuf = Buffer.from(presentedHash);
  const storedBuf = Buffer.from(row?.capabilityHash ?? presentedHash);
  const hashMatch = hashBuf.length === storedBuf.length && timingSafeEqual(hashBuf, storedBuf);
  const ok = Boolean(
    hashMatch
    && row
    && row.state === "issued"
    && row.runId === expected.runId
    && row.attemptId === expected.attemptId
    && folded?.currentStep?.attemptId === expected.attemptId
    && folded.currentStep.attemptStatus === "executing"
    && folded.status === "running",
  );
  if (!ok) {
    throw runtimeError("capability_rejected", expected.attemptId, "attempt capability was rejected");
  }
  return {
    ...row!,
    runPlanHash: folded!.runPlanHash ?? "",
    toolPolicyRevision: run!.toolPolicyRevision,
  };
}

function invokeProducer(
  producer: VnextProducer,
  request: VnextProducerRequest,
): Promise<{ result?: VnextProducerResult; error: boolean }> {
  let pending: Promise<VnextProducerResult>;
  try {
    pending = Promise.resolve(producer.produce(request));
  } catch {
    return Promise.resolve({ error: true });
  }
  return pending.then(
    (result) => ({ result, error: false }),
    () => ({ error: true }),
  );
}

async function stepLocked(context: VnextRuntimeContext, runId: string, producer: VnextProducer): Promise<VnextRunDriveResult> {
  const prepared = context.eventStore.transaction(() => prepareDispatch(context, runId));
  if (prepared.kind === "return") {
    return prepared.handoff ? { state: prepared.state, handoff: prepared.handoff } : { state: prepared.state };
  }
  const dispatch = prepared.dispatch;
  registerVnextAttemptController(context.eventStore.path, runId, { attemptId: dispatch.attemptId, controller: dispatch.controller });
  try {
    try {
      context.eventStore.transaction(() => appendExecuting(context, dispatch));
    } catch (error) {
      dispatch.controller.abort();
      context.eventStore.transaction(() => hardStopUnrecorded(context, dispatch, "executing_unrecorded"));
      throw error;
    }
    const produced = await invokeProducer(producer, dispatch.request);
    return context.eventStore.transaction(() => settleAttempt(context, dispatch, produced.result, produced.error));
  } finally {
    unregisterVnextAttemptController(context.eventStore.path, runId, dispatch.attemptId);
  }
}

interface PreparedDispatch {
  run: VnextRunRecord;
  plan: VnextCompiledPlan;
  step: VnextCompiledStep;
  stepId: string;
  stepAttempt: number;
  assignmentId: string;
  attemptId: string;
  agentId: string;
  capabilityHash: string;
  request: VnextProducerRequest;
  controller: AbortController;
  state: VnextRunState;
}

function prepareDispatch(
  context: VnextRuntimeContext,
  runId: string,
): { kind: "dispatch"; dispatch: PreparedDispatch } | { kind: "return"; state: VnextRunState; handoff?: VnextRunHandoff } {
  const run = requireRun(context, runId);
  const plan = rehydrateVnextCompiledPlanFromStore(context.eventStore, run);
  const state = foldStoredVnextRun(context, run);
  if (state.status === "cancelling" && !vnextAttemptController(context.eventStore.path, runId)) {
    return {
      kind: "return",
      state,
      handoff: {
        reason: "cancel_pending_foreign",
        detail: "cancellation is pending in another process",
        ...(state.currentStep?.attemptId ? { attemptId: state.currentStep.attemptId } : {}),
      },
    };
  }
  const attemptStatus = state.currentStep?.attemptStatus;
  if (attemptStatus === "starting" || attemptStatus === "executing" || attemptStatus === "settling") {
    const attemptId = state.currentStep?.attemptId;
    return {
      kind: "return",
      state,
      handoff: {
        reason: "attempt_unreconciled",
        ...(attemptId !== undefined ? { attemptId } : {}),
        stepId: state.currentStep!.stepId,
        detail: "issued attempt is not held by this process",
      },
    };
  }
  if (state.status !== "running" || state.currentStep) {
    return { kind: "return", state };
  }
  const stepId = state.pendingStepId ?? plan.entryStepId;
  const step = plan.steps[stepId];
  if (!step) throw runtimeError("run_events_illegal", runId, `unknown pending step ${stepId}`);
  const unsupported = unsupportedStep(plan, step);
  if (unsupported) return { kind: "return", state, handoff: { ...unsupported, stepId } };
  const used = state.stepAttempts[stepId] ?? 0;
  if (used >= step.maxAttempts) {
    return { kind: "return", ...failBudget(context, run, plan, state, "budget_step_attempts", stepId) };
  }
  const agentId = step.kind === "agent" || step.kind === "moa" ? step.agent : "coordinator";
  const assignmentId = newVnextAssignmentId();
  const attemptId = newVnextAttemptId();
  const stepAttempt = used + 1;
  const minted = mintCapabilitySecret();
  const controller = new AbortController();
  const now = new Date().toISOString();
  let sequence = context.eventStore.nextSequence(runId);
  let mono = vnextMonotonicNs();
  const events: VnextRunEvent[] = [];
  const push = (eventType: string, payload: Record<string, unknown>): void => {
    events.push({
      ...vnextEventBase(context, run, now, mono),
      eventId: newVnextEventId(),
      eventType,
      sequence: sequence++,
      payload,
    });
    mono = vnextIncrementMonotonicNs(mono);
  };
  push("step.entered", { stepId, stepAttempt, status: "pending" });
  push("step.status_changed", { stepId, status: "preparing", previousStatus: "pending" });
  push("assignment.created", { assignmentId, stepId, stepAttempt, agentId, status: "created" });
  push("assignment.accepted", { assignmentId, status: "accepted" });
  push("attempt.created", { attemptId, assignmentId, status: "created" });
  push("assignment.dispatched", { assignmentId, capabilityHash: minted.hash, status: "dispatched" });
  push("attempt.status_changed", { attemptId, status: "starting" });
  push("step.status_changed", { stepId, status: "running", previousStatus: "preparing" });
  for (const event of events) context.eventStore.appendEvent(event);
  context.eventStore.insertCapability({
    attemptId,
    runId,
    assignmentId,
    stepId,
    stepAttempt,
    producerId: "driver-simulated",
    capabilityHash: minted.hash,
    state: "issued",
  });
  const next = foldStoredVnextRun(context, run);
  persistVnextRunState(context, runId, next, events[events.length - 1]!.sequence);
  const request: VnextProducerRequest = {
    runId,
    stepId,
    stepAttempt,
    assignmentId,
    attemptId,
    agentId,
    capability: minted.secret,
    allowedOutcomes: step.outcomes,
    signal: controller.signal,
  };
  return {
    kind: "dispatch",
    dispatch: {
      run,
      plan,
      step,
      stepId,
      stepAttempt,
      assignmentId,
      attemptId,
      agentId,
      capabilityHash: minted.hash,
      request,
      controller,
      state: next,
    },
  };
}

function appendExecuting(context: VnextRuntimeContext, dispatch: PreparedDispatch): void {
  const run = requireRun(context, dispatch.run.runId);
  const now = new Date().toISOString();
  let sequence = context.eventStore.nextSequence(dispatch.run.runId);
  let mono = vnextMonotonicNs();
  const events: VnextRunEvent[] = [
    {
      ...vnextEventBase(context, run, now, mono),
      eventId: newVnextEventId(),
      eventType: "assignment.executing",
      sequence: sequence++,
      payload: { assignmentId: dispatch.assignmentId, status: "executing" },
    },
    {
      ...vnextEventBase(context, run, now, vnextIncrementMonotonicNs(mono)),
      eventId: newVnextEventId(),
      eventType: "attempt.status_changed",
      sequence: sequence++,
      payload: { attemptId: dispatch.attemptId, status: "executing" },
    },
  ];
  for (const event of events) context.eventStore.appendEvent(event);
  const next = foldStoredVnextRun(context, run);
  persistVnextRunState(context, run.runId, next, events[events.length - 1]!.sequence);
}

function settleAttempt(
  context: VnextRuntimeContext,
  dispatch: PreparedDispatch,
  result: VnextProducerResult | undefined,
  produceError: boolean,
): VnextRunDriveResult {
  const run = requireRun(context, dispatch.run.runId);
  const state = foldStoredVnextRun(context, run);
  const capability = context.eventStore.capabilityByAttempt(dispatch.attemptId);
  if (state.currentStep?.attemptId !== dispatch.attemptId || !capability || (capability.state !== "issued" && capability.state !== "revoked")) {
    throw runtimeError("run_events_illegal", run.runId, "settle attempted for a non-current capability");
  }
  const cancelling = state.status === "cancelling" || capability.state === "revoked";
  const now = new Date().toISOString();
  let sequence = context.eventStore.nextSequence(run.runId);
  let mono = vnextMonotonicNs();
  const events: VnextRunEvent[] = [];
  const push = (eventType: string, payload: Record<string, unknown>): void => {
    events.push({
      ...vnextEventBase(context, run, now, mono),
      eventId: newVnextEventId(),
      eventType,
      sequence: sequence++,
      payload,
    });
    mono = vnextIncrementMonotonicNs(mono);
  };

  push("attempt.status_changed", { attemptId: dispatch.attemptId, status: "settling" });
  if (cancelling) {
    push("assignment.result_recorded", { assignmentId: dispatch.assignmentId, resultClass: "cancelled", status: "result_recorded" });
    push("attempt.status_changed", { attemptId: dispatch.attemptId, status: "terminal" });
    push("assignment.terminal", { assignmentId: dispatch.assignmentId, outcome: "cancelled", status: "terminal" });
    push("step.status_changed", { stepId: dispatch.stepId, status: "cancelled", previousStatus: "running" });
    push("run.status_changed", { status: "cancelled", reason: "operator_cancel" });
    context.eventStore.settleCapability(dispatch.attemptId, "settled");
    for (const event of events) context.eventStore.appendEvent(event);
    const next = foldStoredVnextRun(context, run);
    persistVnextRunState(context, run.runId, next, events[events.length - 1]!.sequence);
    context.eventStore.updateRunStatus(run.runId, "cancelled", now);
    return { state: next };
  }

  const outcome = !produceError && result && typeof result.outcome === "string" ? result.outcome : undefined;
  const known = outcome !== undefined && dispatch.step.outcomes.includes(outcome);
  if (!known) {
    push("assignment.result_recorded", { assignmentId: dispatch.assignmentId, resultClass: produceError ? "producer_rejected" : "outcome_unknown", status: "result_recorded" });
    push("attempt.status_changed", { attemptId: dispatch.attemptId, status: "terminal" });
    push("assignment.terminal", { assignmentId: dispatch.assignmentId, outcome: "failed", status: "terminal" });
    push("step.status_changed", { stepId: dispatch.stepId, status: "failed", previousStatus: "running" });
    push("run.status_changed", { status: "failed", reason: "outcome_unknown", stepId: dispatch.stepId });
    context.eventStore.settleCapability(dispatch.attemptId, "settled");
    for (const event of events) context.eventStore.appendEvent(event);
    const next = foldStoredVnextRun(context, run);
    persistVnextRunState(context, run.runId, next, events[events.length - 1]!.sequence);
    context.eventStore.updateRunStatus(run.runId, "failed", now);
    return { state: next };
  }

  const selected = dispatch.step.transitions[outcome]!;
  push("assignment.result_recorded", { assignmentId: dispatch.assignmentId, outcome, resultClass: "outcome", status: "result_recorded" });
  push("attempt.status_changed", { attemptId: dispatch.attemptId, status: "terminal" });
  push("assignment.terminal", { assignmentId: dispatch.assignmentId, outcome, status: "terminal" });
  push("step.outcome_recorded", { stepId: dispatch.stepId, stepAttempt: dispatch.stepAttempt, outcome });
  const stepStatus = outcome === "passed" ? "passed" : outcome === "cancelled" ? "cancelled" : "failed";
  push("step.status_changed", { stepId: dispatch.stepId, status: stepStatus, previousStatus: "running" });

  const budget = transitionBudgetFailure(dispatch.plan, state, dispatch.stepId, outcome);
  if (budget) {
    push("run.status_changed", { status: "failed", reason: budget, stepId: dispatch.stepId, outcome });
    context.eventStore.settleCapability(dispatch.attemptId, "settled");
    for (const event of events) context.eventStore.appendEvent(event);
    const next = foldStoredVnextRun(context, run);
    persistVnextRunState(context, run.runId, next, events[events.length - 1]!.sequence);
    context.eventStore.updateRunStatus(run.runId, "failed", now);
    return { state: next };
  }

  if (selected.to === "step") {
    push("step.transitioned", { fromStepId: dispatch.stepId, toStepId: selected.target, outcome });
  } else {
    push("step.transitioned", { fromStepId: dispatch.stepId, status: selected.terminalStatus, outcome });
    push("run.status_changed", { status: selected.terminalStatus });
  }
  context.eventStore.settleCapability(dispatch.attemptId, "settled");
  for (const event of events) context.eventStore.appendEvent(event);
  const next = foldStoredVnextRun(context, run);
  persistVnextRunState(context, run.runId, next, events[events.length - 1]!.sequence);
  context.eventStore.updateRunStatus(run.runId, next.status as VnextRunStatus, now);
  return { state: next };
}

function failBudget(
  context: VnextRuntimeContext,
  run: VnextRunRecord,
  plan: VnextCompiledPlan,
  state: VnextRunState,
  reason: string,
  stepId: string,
): { state: VnextRunState } {
  const now = new Date().toISOString();
  const sequence = context.eventStore.nextSequence(run.runId);
  const event: VnextRunEvent = {
    ...vnextEventBase(context, run, now, vnextMonotonicNs()),
    eventId: newVnextEventId(),
    eventType: "run.status_changed",
    sequence,
    payload: { status: "failed", reason, stepId },
  };
  context.eventStore.appendEvent(event);
  const next = foldStoredVnextRun(context, run);
  persistVnextRunState(context, run.runId, next, sequence);
  context.eventStore.updateRunStatus(run.runId, "failed", now);
  void state;
  return { state: next };
}

function hardStopUnrecorded(context: VnextRuntimeContext, dispatch: PreparedDispatch, reason: string): void {
  const run = requireRun(context, dispatch.run.runId);
  const now = new Date().toISOString();
  const sequence = context.eventStore.nextSequence(run.runId);
  const event: VnextRunEvent = {
    ...vnextEventBase(context, run, now, vnextMonotonicNs()),
    eventId: newVnextEventId(),
    eventType: "run.status_changed",
    sequence,
    payload: { status: "failed", reason, stepId: dispatch.stepId },
  };
  context.eventStore.appendEvent(event);
  context.eventStore.settleCapability(dispatch.attemptId, "revoked");
  const next = foldStoredVnextRun(context, run);
  persistVnextRunState(context, run.runId, next, sequence);
  context.eventStore.updateRunStatus(run.runId, "failed", now);
}

export function vnextTransitionBudgetFailure(plan: VnextCompiledPlan, state: VnextRunState, fromStepId: string, outcome: string): string | undefined {
  return transitionBudgetFailure(plan, state, fromStepId, outcome);
}

function transitionBudgetFailure(plan: VnextCompiledPlan, state: VnextRunState, fromStepId: string, outcome: string): string | undefined {
  const selected = plan.steps[fromStepId]?.transitions[outcome];
  if (!selected) return "outcome_unknown";
  const edgeKey = `${fromStepId}:${outcome}`;
  const edgeUsed = (state.edgeTransitions[edgeKey] ?? 0) + 1;
  if (selected.maxTransitions !== undefined && edgeUsed > selected.maxTransitions) return "budget_edge";
  if (state.transitionsUsed + 1 > plan.transitionBudget) return "budget_transitions";
  if (selected.to === "step") {
    const target = plan.steps[selected.target];
    const used = state.stepAttempts[selected.target] ?? 0;
    if (target && used >= target.maxAttempts) return "budget_step_attempts";
  }
  return undefined;
}

function unsupportedLimit(envelope: VnextRunPlanEnvelope): VnextRunHandoff | undefined {
  if (envelope.plan.limits.maxRunDurationMs !== undefined) {
    return { reason: "limit_unsupported", field: "limits.maxRunDurationMs", detail: "duration budget enforcement is not available in this slice" };
  }
  if (envelope.plan.limits.maxAgentTimeMs !== undefined) {
    return { reason: "limit_unsupported", field: "limits.maxAgentTimeMs", detail: "agent-time budget enforcement is not available in this slice" };
  }
  if (envelope.plan.limits.maxModelCost !== undefined) {
    return { reason: "limit_unsupported", field: "limits.maxModelCost", detail: "cost budget enforcement is not available in this slice" };
  }
  if (envelope.projectLimits.maxRunDurationMs !== undefined) {
    return { reason: "limit_unsupported", field: "project.limits.maxRunDurationMs", detail: "duration budget enforcement is not available in this slice" };
  }
  if (envelope.projectLimits.maxAgentTimeMs !== undefined) {
    return { reason: "limit_unsupported", field: "project.limits.maxAgentTimeMs", detail: "agent-time budget enforcement is not available in this slice" };
  }
  return undefined;
}

function unsupportedStep(plan: VnextCompiledPlan, step: VnextCompiledStep): Omit<VnextRunHandoff, "stepId"> | undefined {
  if (step.kind !== "agent") return { reason: "step_unsupported", field: "kind", detail: `step kind ${step.kind} is not executed in this slice` };
  if (step.assignments.maximum !== 1) return { reason: "step_unsupported", field: "assignments.maximum", detail: "only a single assignment is supported" };
  if (step.assignments.maxAttemptsPerAssignment !== 1) return { reason: "step_unsupported", field: "assignments.maxAttemptsPerAssignment", detail: "only one physical attempt is supported" };
  if (step.join.strategy !== "all") return { reason: "step_unsupported", field: "join.strategy", detail: "only join all is supported" };
  if (step.requiredEvidence.length > 0) return { reason: "step_unsupported", field: "requiredEvidence", detail: "evidence is not executed in this slice" };
  if (step.requiresPlanHash) return { reason: "step_unsupported", field: "requiresPlanHash", detail: "plan-hash evidence is not executed in this slice" };
  if (step.timeoutMs !== undefined) return { reason: "step_unsupported", field: "timeoutMs", detail: "timeouts are not executed in this slice" };
  if (step.safeSpeculation) return { reason: "step_unsupported", field: "safeSpeculation", detail: "speculation is not executed in this slice" };
  if (step.tools) return { reason: "step_unsupported", field: "tools", detail: "tools are not executed in this slice" };
  if (step.secrets.length > 0) return { reason: "step_unsupported", field: "secrets", detail: "secrets are not executed in this slice" };
  if (step.model !== undefined) return { reason: "step_unsupported", field: "model", detail: "models are not executed in this slice" };
  if (Object.values(step.repositories).some((access) => access !== "none")) {
    return { reason: "step_unsupported", field: "repositories", detail: "repository access other than none is not executed in this slice" };
  }
  if (plan.reproOracle?.stageId === step.id) return { reason: "step_unsupported", field: "reproOracle", detail: "repro oracle is not executed in this slice" };
  if (plan.planHash?.stageId === step.id) return { reason: "step_unsupported", field: "planHash", detail: "plan hash oracle is not executed in this slice" };
  return undefined;
}

function pinnedGatesForCompiledPlan(
  plan: VnextCompiledPlan,
  bundle: VnextProjectBundle,
  projectRoot: string,
): VnextPinnedGates {
  const referenced = new Set<string>();
  for (const step of Object.values(plan.steps)) {
    if (step.kind === "gate") referenced.add(step.gate);
  }
  const definitions = Object.create(null) as VnextPinnedGates["definitions"] extends Readonly<infer T> ? T : Record<string, never>;
  const registryValue = bundle.gateRegistry?.value;
  const gatesObject = registryValue && typeof registryValue.gates === "object" && registryValue.gates && !Array.isArray(registryValue.gates)
    ? registryValue.gates as Record<string, unknown>
    : {};
  for (const gateId of referenced) {
    (definitions as Record<string, unknown>)[gateId] = parseGateDefinition(gatesObject[gateId], gateId, plan.workflowId);
  }
  return {
    registry: referenced.size > 0 && bundle.gateRegistry
      ? { schema: "kxm.gate-registry.v1", hash: gateRegistryHash(bundle.gateRegistry.value) }
      : bundle.gateRegistry && referenced.size === 0
      ? { schema: "kxm.gate-registry.v1", hash: gateRegistryHash(bundle.gateRegistry.value) }
      : null,
    definitions: definitions as VnextPinnedGates["definitions"],
    controlRoot: { repositoryId: "control", projectKey: projectRuntimeKey(projectRoot) },
  };
}

function requireRun(context: VnextRuntimeContext, runId: string): VnextRunRecord {
  const run = context.eventStore.run(runId);
  if (!run) throw runtimeError("run_unknown", runId, "run does not exist in this event store");
  if (run.projectId !== context.projectId || run.homeRuntimeId !== context.homeRuntimeId) {
    throw runtimeError("run_owner_mismatch", runId, "run is not owned by this runtime context");
  }
  return run;
}

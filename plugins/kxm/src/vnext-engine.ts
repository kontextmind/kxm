import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { isRouteAdmitted, listRoleBindings } from "./routes.ts";
import {
  buildFormalContextPacket,
  buildHandoffManifest,
  formatContextPacketForPrompt,
  pruneContextPacket,
  type FormalContextPacketV2,
  type HandoffManifestV1,
} from "./context-packet.ts";
import { compileVnextWorkflow, type VnextCompiledPlan, type VnextCompiledStep } from "./vnext-engine-compile.ts";
import {
  effectiveRunDurationBudget,
  isTerminalRunStatus,
  vnextFoldPanelAttempt,
  vnextFoldPanelAttemptIds,
  vnextJoinAll,
  type VnextRunDurationBudget,
  type VnextRunState,
} from "./vnext-engine-fold.ts";
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
  armVnextGateHold,
  attachVnextDriveSession,
  bindVnextSchedulerPolicy,
  clearVnextDriveSession,
  dropVnextGateStopHook,
  enqueueVnextScheduledRun,
  finishVnextOwnedGate,
  markVnextGateHoldUnsettled,
  registerVnextAttemptController,
  releaseVnextRun,
  resolveVnextGateHold,
  unregisterVnextAttemptController,
  vnextAdmittedToken,
  vnextAttemptController,
  vnextAttemptControllers,
  vnextGateHold,
  vnextSchedulerPolicy,
  type VnextDriveSession,
} from "./vnext-runtime-owner.ts";
import {
  cancelVnextRun,
  foldStoredVnextRun,
  isVnextRuntimeContextClosed,
  persistVnextRunState,
  registerVnextRuntimeCloseHook,
  vnextEventBase,
  vnextIncrementMonotonicNs,
  vnextMonotonicNs,
  vnextPolicyRevisions,
  vnextProjectAdmissionLimits,
  type VnextMemoryRevisionOptions,
  type VnextRuntimeContext,
} from "./vnext-runtime.ts";
import {
  hashVnextDriveLog,
  newVnextAssignmentId,
  newVnextAttemptId,
  newVnextEventId,
  projectRuntimeKey,
  runtimeError,
  verifyVnextDriveReceipt,
  VNEXT_DRIVE_RECEIPT_SCHEMA,
  type VnextAttemptCapabilityRow,
  type VnextDriveReceipt,
  type VnextDriveReceiptBudget,
  type VnextDriveReceiptHandoff,
  type VnextGateAttemptRow,
  type VnextGateEvidenceRow,
  type VnextGateObservationRow,
  type VnextRunEvent,
  type VnextRunRecord,
  type VnextRunStatus,
} from "./vnext-runtime-store.ts";
import { VnextConfigError, vnextCanonicalJson, type JsonValue, type VnextProjectBundle } from "./vnext-config.ts";
import { evaluateArtifactsGate } from "./vnext-engine-artifacts.ts";
import { createCommandObserver } from "./vnext-engine-command.ts";
import {
  recordGateCancelObservedInTransaction,
  recordGateIntentInTransaction,
  recordGateNoStartInTransaction,
  recordGateSettlementInTransaction,
  recordGateSpawnedInTransaction,
  recordGateUncertainInTransaction,
  type VnextGateObservationInput,
} from "./vnext-engine-gate-records.ts";
import {
  ROUTING_RECORD_V2_SCHEMA,
  type RoutingRecordV2,
  parseRoutingRecordV2,
  behavioralConfigHash,
} from "./routing.ts";
import {
  assertCommandSeatbelt,
  DESTRUCTIVE_COMMAND_PATTERNS,
  isRtkBypassRequired,
  assertPinnedSshHostKeyPolicy,
  type RtkBypassContext,
} from "./safety-integrity.ts";

export {
  assertCommandSeatbelt,
  DESTRUCTIVE_COMMAND_PATTERNS,
  isRtkBypassRequired,
  assertPinnedSshHostKeyPolicy,
  type RtkBypassContext,
};

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
  readonly instanceNo?: number | undefined;
  readonly scopeEpoch?: number | undefined;
  readonly prompt?: string | undefined;
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly thinking?: string | undefined;
  readonly agentRole?: string | undefined;
  readonly harness?: string | undefined;
  readonly contextPacket?: FormalContextPacketV2 | undefined;
  readonly handoffManifest?: HandoffManifestV1 | undefined;
}

export interface VnextProducerResult {
  readonly outcome: string;
  /** Host cannot attest termination; retain the issued attempt, never replay or settle it. */
  readonly effectUncertain?: true;
  readonly costBasis?: "metered" | "unmetered" | "unknown";
  readonly costUsd?: number | null;
  readonly tokensIn?: number | null;
  readonly tokensOut?: number | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
  readonly contextTokens?: number | null;
  readonly latencyMs?: number;
  readonly harness?: string;
  readonly provider?: string;
  readonly requestedModel?: string;
  readonly effectiveModel?: string;
  readonly thinking?: string;
  readonly agentRole?: string;
  readonly behavioralSha256?: string;
  readonly priceRef?: string;
  readonly providerMetadata?: Record<string, string | number | boolean>;
}

export interface VnextProducer {
  readonly id: "driver-simulated" | "pi" | "oneshot";
  produce(request: VnextProducerRequest): Promise<VnextProducerResult>;
  close?(): Promise<void>;
}

export interface VnextRunHandoff {
  readonly reason: "limit_unsupported" | "step_unsupported" | "attempt_unreconciled" | "cancel_pending_foreign" | "gate_unsupported" | "gate_outcome_undeclared" | "gate_recovery_pending" | "attempt_unsettled" | "gate_uncertain_blocked";
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
    async produce(request: VnextProducerRequest): Promise<VnextProducerResult> {
      const start = Date.now();
      try {
        const raw = await script(request);
        const latencyMs = typeof raw.latencyMs === "number" ? raw.latencyMs : Math.max(0, Date.now() - start);
        return {
          costBasis: "unmetered",
          tokensIn: null,
          tokensOut: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          ...raw,
          latencyMs,
        };
      } catch (error) {
        return Promise.reject(error);
      }
    },
  });
  trustedProducers.add(producer);
  return producer;
}

export function registerTrustedProducer(producer: VnextProducer): void {
  trustedProducers.add(producer);
}

function requireTrustedProducer(producer: VnextProducer): void {
  if (!trustedProducers.has(producer)) {
    throw runtimeError("engine_producer_untrusted", "producer", "producer is not a trusted factory instance");
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
  options?: VnextMemoryRevisionOptions,
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
    const revisions = vnextPolicyRevisions(bundle, options);
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

export function startVnextRun(context: VnextRuntimeContext, runId: string, options: { allowLimits?: boolean } = {}): VnextRunDriveResult {
  return context.eventStore.transaction(() => {
    const run = requireRun(context, runId);
    const envelope = loadVnextRunPlanEnvelope(context.eventStore, run);
    const unsupported = options.allowLimits ? undefined : unsupportedLimit(envelope);
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
  return withAdmission(context, runId, (token) => stepLocked(context, runId, producer, token));
}

export async function driveVnextRun(
  context: VnextRuntimeContext,
  runId: string,
  producer: VnextProducer,
  options: { allowLimits?: boolean; liveMode?: boolean } = {},
): Promise<VnextRunDriveResult> {
  requireTrustedProducer(producer);
  const run = requireRun(context, runId);
  if (run.status === "created") {
    throw runtimeError("run_plan_missing", runId, "drive requires a pinned plan");
  }
  return withAdmission(context, runId, (token) => driveAdmitted(context, runId, producer, token, options));
}

async function driveAdmitted(
  context: VnextRuntimeContext,
  runId: string,
  producer: VnextProducer,
  token: string,
  options: { allowLimits?: boolean; liveMode?: boolean } = {},
): Promise<VnextRunDriveResult> {
  const run = requireRun(context, runId);
  if (run.status === "preparing") {
    const started = startVnextRun(context, runId, options);
    if (started.handoff || isTerminalRunStatus(started.state.status)) return started;
  }
  let latest: VnextRunDriveResult = { state: foldStoredVnextRun(context, requireRun(context, runId)) };
  while (latest.state.status === "running") {
    const overBudget = cancelRunDurationIfExceeded(context, runId);
    if (overBudget) return overBudget;
    const before = context.eventStore.runState(runId)?.lastSequence;
    latest = await stepLocked(context, runId, producer, token);
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

async function withAdmission<T>(context: VnextRuntimeContext, runId: string, fn: (token: string) => Promise<T>): Promise<T> {
  const token = admitPinnedRun(context, runId);
  try {
    return await fn(token);
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

export interface OpenVnextDriveSessionOptions {
  mode: "simulated" | "live";
  allowLimits?: boolean;
  liveMode?: boolean;
  createProducer: () => VnextProducer;
}

export interface VnextDriveSessionHandle {
  driveId: string;
  settled: Promise<VnextRunDriveResult>;
}

function newDriveId(runId: string, token: string, runtimeId: string, monotonicNs: string): string {
  return `drv_${createHash("sha256").update(`${runId}\0${token}\0${runtimeId}\0${monotonicNs}`, "utf8").digest("hex").slice(0, 24)}`;
}

export interface VnextDrivePollProjection {
  driveId: string;
  mode: "simulated" | "live";
  openedAt: string;
  receipt: VnextDriveReceipt | null;
  verified: boolean;
  divergence?: string;
}

export interface VnextDriveReceiptCloseInfo {
  kind: "terminal" | "handoff" | "unsettled";
  reason?: string;
  handoff?: VnextRunHandoff;
  error?: { class: string; component: string; retryable: boolean };
  producerId: string;
  producerClosed: boolean;
}

function driveErrorSummary(error: unknown): { class: string; component: string; retryable: boolean } {
  const raw = error instanceof VnextConfigError ? error.issues[0]?.code : undefined;
  const className = raw && /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(raw) ? raw : "drive-failure";
  return { class: className, component: "vnext-engine", retryable: false };
}

function receiptHandoff(handoff: VnextRunHandoff): VnextDriveReceiptHandoff {
  return {
    reason: handoff.reason,
    detail: handoff.detail,
    ...(handoff.field !== undefined ? { field: handoff.field } : {}),
    ...(handoff.stepId !== undefined ? { stepId: handoff.stepId } : {}),
  };
}

function appendDriveOpened(
  context: VnextRuntimeContext,
  runId: string,
  driveId: string,
  mode: "simulated" | "live",
): { sequence: number; occurredAt: string } {
  return context.eventStore.transaction(() => {
    const run = requireRun(context, runId);
    const now = new Date().toISOString();
    const sequence = context.eventStore.nextSequence(runId);
    const event: VnextRunEvent = {
      ...vnextEventBase(context, run, now, vnextMonotonicNs()),
      eventId: newVnextEventId(),
      eventType: "run.drive_opened",
      sequence,
      payload: { driveId, mode },
    };
    context.eventStore.appendEvent(event);
    const next = foldStoredVnextRun(context, run);
    persistVnextRunState(context, runId, next, sequence);
    return { sequence, occurredAt: now };
  });
}

export function recordDriveReceipt(
  context: VnextRuntimeContext,
  session: VnextDriveSession,
  closeInfo: VnextDriveReceiptCloseInfo,
): void {
  if (isVnextRuntimeContextClosed(context)) return;
  try {
    const run = context.eventStore.run(session.runId);
    if (!run) return;
    const state = foldStoredVnextRun(context, run);
    const events = context.eventStore.events(session.runId, 0, 1_000_000);
    if (events.length === 0) return;
    const opened = state.drive;
    const openedEvent = opened
      ? events.find((event) => event.sequence === opened.openedSequence && event.eventType === "run.drive_opened")
      : events.find((event) => event.eventType === "run.drive_opened" && event.payload.driveId === session.driveId);
    const last = events[events.length - 1]!;
    const openedSequence = opened?.openedSequence ?? openedEvent?.sequence;
    if (openedSequence === undefined) return;
    const closedAt = new Date().toISOString();
    const receipt: VnextDriveReceipt = {
      schema: VNEXT_DRIVE_RECEIPT_SCHEMA,
      driveId: session.driveId,
      runId: session.runId,
      projectId: run.projectId,
      homeRuntimeId: session.homeRuntimeId,
      mode: session.mode,
      openedAt: openedEvent?.occurredAt ?? session.openedAt,
      openedSequence,
      closedAt,
      lastSequence: last.sequence,
      logHash: hashVnextDriveLog(events.filter((event) => event.sequence >= 1 && event.sequence <= last.sequence)),
      settlement: {
        kind: closeInfo.kind,
        status: state.status,
        reason: closeInfo.reason ?? state.terminalReason ?? "",
        ...(closeInfo.kind === "handoff" && closeInfo.handoff ? { handoff: receiptHandoff(closeInfo.handoff) } : {}),
        ...(closeInfo.error !== undefined ? { error: closeInfo.error } : {}),
      },
      budget: driveReceiptBudget(context, run.runId, state, events, closedAt),
      producer: { id: closeInfo.producerId, closed: closeInfo.producerClosed },
    };
    context.eventStore.insertDriveReceipt(receipt);
  } catch {
    // The drive result governs; a missing receipt is visible on poll.
  }
}

export function vnextDrivePollProjection(
  context: VnextRuntimeContext,
  runId: string,
  state: VnextRunState,
): VnextDrivePollProjection | undefined {
  if (!state.drive) return undefined;
  const events = context.eventStore.events(runId, 0, 1_000_000);
  const openedEvent = events.find((event) => event.sequence === state.drive!.openedSequence);
  let receipt: VnextDriveReceipt | null = null;
  let unreadable = false;
  try {
    receipt = context.eventStore.driveReceipt(state.drive.driveId) ?? null;
  } catch {
    unreadable = true;
  }
  const projection: VnextDrivePollProjection = {
    driveId: state.drive.driveId,
    mode: state.drive.mode,
    openedAt: openedEvent?.occurredAt ?? "",
    receipt: unreadable ? null : receipt,
    verified: false,
  };
  if (unreadable) {
    projection.divergence = "receipt unreadable";
    return projection;
  }
  if (!receipt) {
    projection.divergence = "no receipt";
    return projection;
  }
  const checked = verifyVnextDriveReceipt(receipt, events, state.status, {
    runId,
    driveId: state.drive.driveId,
  });
  projection.verified = checked.verified;
  if (checked.divergence !== undefined) projection.divergence = checked.divergence;
  return projection;
}

function inflightAttemptId(state: VnextRunState): string | undefined {
  const leftover = unreconciledPanelAttemptId(state);
  if (leftover) return leftover;
  if (state.currentStep?.attemptId) {
    const located = vnextFoldPanelAttempt(state.currentStep, state.currentStep.attemptId);
    const status = located?.attempt.status;
    if (status === "starting" || status === "executing" || status === "settling") return state.currentStep.attemptId;
  }
  return undefined;
}

function recordExecutingUnrecordedFailure(context: VnextRuntimeContext, runId: string, attemptId: string, stepId: string): void {
  context.eventStore.transaction(() => {
    const run = requireRun(context, runId);
    const now = new Date().toISOString();
    const sequence = context.eventStore.nextSequence(runId);
    const event: VnextRunEvent = {
      ...vnextEventBase(context, run, now, vnextMonotonicNs()),
      eventId: newVnextEventId(),
      eventType: "run.status_changed",
      sequence,
      payload: { status: "failed", reason: "executing_unrecorded", stepId },
    };
    context.eventStore.appendEvent(event);
    context.eventStore.settleCapability(attemptId, "revoked");
    const next = foldStoredVnextRun(context, run);
    persistVnextRunState(context, runId, next, sequence);
    context.eventStore.updateRunStatus(runId, "failed", now);
  });
}

function recordBareDriveFailure(context: VnextRuntimeContext, runId: string): void {
  if (isVnextRuntimeContextClosed(context)) return;
  try {
    const run = context.eventStore.run(runId);
    if (!run) return;
    const state = foldStoredVnextRun(context, run);
    if (isTerminalRunStatus(state.status) || state.status === "cancelling") return;
    const inflight = inflightAttemptId(state);
    if (inflight) {
      const currentStep = state.currentStep;
      const located = vnextFoldPanelAttempt(currentStep, inflight);
      if (currentStep && currentStep.panel.order.length === 1 && located?.attempt.status === "starting") {
        const plan = rehydrateVnextCompiledPlanFromStore(context.eventStore, run);
        const step = plan.steps[currentStep.stepId];
        if (step?.kind === "gate") return;
        if (step && (step.kind === "agent" || step.kind === "moa") && step.assignments.maximum > 1) return;
        recordExecutingUnrecordedFailure(context, runId, inflight, currentStep.stepId);
      }
      return;
    }
    cancelVnextRun(context, runId, { reason: "drive_error" });
  } catch {
    // The original drive error governs; this is a best-effort bare-running brake.
  }
}

async function closeDriveProducer(producer: VnextProducer): Promise<void> {
  if (typeof producer.close !== "function") return;
  try {
    await producer.close();
  } catch {
    // Session ownership ends even if producer cleanup fails.
  }
}

export class VnextRunScheduler {
  private readonly context: VnextRuntimeContext;
  private readonly bundle: VnextProjectBundle;
  private readonly configRevision: string;

  private constructor(context: VnextRuntimeContext, bundle: VnextProjectBundle) {
    this.context = context;
    this.bundle = bundle;
    this.configRevision = bundle.configRevision;
  }

  static for(context: VnextRuntimeContext, bundle: VnextProjectBundle): VnextRunScheduler {
    if (String(bundle.project.value.id) !== context.projectId) {
      throw runtimeError("run_owner_mismatch", context.projectId, "scheduler bundle project does not match the runtime context");
    }
    const limits = vnextProjectAdmissionLimits(bundle);
    bindVnextSchedulerPolicy(context.eventStore.path, limits.maxConcurrentRuns, bundle.configRevision);
    return new VnextRunScheduler(context, bundle);
  }

  enqueue(
    runId: string,
    producer: VnextProducer,
    options: { allowLimits?: boolean; liveMode?: boolean } = {},
  ): Promise<VnextRunDriveResult> {
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
        (token) => driveAdmitted(this.context, runId, producer, token, options),
      ) as Promise<VnextRunDriveResult>;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  openDriveSession(runId: string, options: OpenVnextDriveSessionOptions): Promise<VnextDriveSessionHandle> {
    const policy = vnextSchedulerPolicy(this.context.eventStore.path);
    if (!policy || policy.configRevision !== this.configRevision) {
      return Promise.reject(runtimeError("scheduler_policy_conflict", runId, "scheduler handle does not match the active policy"));
    }
    try {
      const run = requireRun(this.context, runId);
      if (isTerminalRunStatus(run.status) || run.status === "cancelling") {
        return Promise.reject(runtimeError("run_busy", runId, `run ${runId} is already ${run.status}`));
      }
    } catch (error) {
      return Promise.reject(error);
    }

    const limits = vnextProjectAdmissionLimits(this.bundle);
    const driveOptions: { allowLimits?: boolean; liveMode?: boolean } = {
      liveMode: options.liveMode ?? options.mode === "live",
    };
    if (options.allowLimits !== undefined) driveOptions.allowLimits = options.allowLimits;
    let opened = false;
    const pending = {
      resolve: (_value: VnextRunDriveResult) => undefined as void,
      reject: (_error: unknown) => undefined as void,
    };
    const settled = new Promise<VnextRunDriveResult>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    void settled.then(undefined, () => undefined);

    return new Promise<VnextDriveSessionHandle>((resolveOpen, rejectOpen) => {
      const queued = enqueueVnextScheduledRun(
        this.context.eventStore.path,
        runId,
        this.configRevision,
        limits.maxConcurrentRuns,
        async (token) => {
          let producer: VnextProducer | undefined;
          try {
            producer = options.createProducer();
            requireTrustedProducer(producer);
            const current = requireRun(this.context, runId);
            if (current.status === "created") {
              pinVnextCompiledPlan(this.context, this.bundle, runId);
            }
            const started = startVnextRun(this.context, runId, driveOptions);
            if (started.handoff) {
              const error = runtimeError("run_handoff_required", runId, started.handoff.detail);
              Object.assign(error, { handoff: started.handoff });
              throw error;
            }
            const driveId = newDriveId(runId, token, this.context.homeRuntimeId, vnextMonotonicNs());
            const openedMeta = appendDriveOpened(this.context, runId, driveId, options.mode);
            const startedState = foldStoredVnextRun(this.context, requireRun(this.context, runId));
            const deadlineAt = driveDeadlineAt(this.context, runId, startedState);
            const session: VnextDriveSession = {
              driveId,
              runId,
              token,
              homeRuntimeId: this.context.homeRuntimeId,
              mode: options.mode,
              openedAt: openedMeta.occurredAt,
              producerId: producer.id,
              controller: new AbortController(),
              settled,
              ...(deadlineAt !== undefined ? { deadlineAt } : {}),
            };
            attachVnextDriveSession(this.context.eventStore.path, runId, token, session);
            opened = true;
            resolveOpen({ driveId, settled });
            try {
              const result = await driveAdmitted(this.context, runId, producer, token, driveOptions);
              const kind = result.handoff ? "handoff" : isTerminalRunStatus(result.state.status) ? "terminal" : "unsettled";
              recordDriveReceipt(this.context, session, {
                kind,
                ...(result.state.terminalReason !== undefined ? { reason: result.state.terminalReason } : result.handoff ? { reason: result.handoff.reason } : {}),
                ...(result.handoff ? { handoff: result.handoff } : {}),
                producerId: producer.id,
                producerClosed: false,
              });
              pending.resolve(result);
              return result;
            } catch (error) {
              recordBareDriveFailure(this.context, runId);
              let foldedStatus: string | undefined;
              try {
                foldedStatus = foldStoredVnextRun(this.context, requireRun(this.context, runId)).status;
              } catch {
                foldedStatus = undefined;
              }
              recordDriveReceipt(this.context, session, {
                kind: foldedStatus !== undefined && isTerminalRunStatus(foldedStatus as VnextRunStatus) ? "terminal" : "unsettled",
                error: driveErrorSummary(error),
                producerId: producer.id,
                producerClosed: false,
              });
              pending.reject(error);
              throw error;
            }
          } finally {
            if (producer) await closeDriveProducer(producer);
            clearVnextDriveSession(this.context.eventStore.path, runId, token);
          }
        },
      ) as Promise<VnextRunDriveResult>;
      void queued.then(undefined, (error) => {
        if (!opened) {
          rejectOpen(error);
        }
      });
    });
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
  const located = vnextFoldPanelAttempt(folded?.currentStep, expected.attemptId);
  const ok = Boolean(
    hashMatch
    && row
    && row.state === "issued"
    && row.runId === expected.runId
    && row.attemptId === expected.attemptId
    && (row.producerId === "driver-simulated" || row.producerId === "pi" || row.producerId === "oneshot")
    && folded
    && folded.status === "running"
    && folded.currentStep
    && folded.currentStep.stepId === row.stepId
    && folded.currentStep.stepAttempt === row.stepAttempt
    && located
    && located.assignmentId === row.assignmentId
    && located.attempt.status === "executing",
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
): Promise<{ result?: VnextProducerResult; error: boolean; errorCode?: string }> {
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

export interface VnextPreparedGateDispatch {
  readonly run: VnextRunRecord;
  readonly envelope: VnextRunPlanEnvelope;
  readonly stepId: string;
  readonly stepAttempt: number;
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly effectId: string;
  readonly controller: AbortController;
  readonly state: VnextRunState;
}

export interface VnextGateDispatchSeams {
  afterEvaluate?: ((prepared: VnextPreparedGateDispatch) => void) | undefined;
  afterObservationWrite?: ((prepared: VnextPreparedGateDispatch) => void) | undefined;
  afterUncertaintyWrite?: ((prepared: VnextPreparedGateDispatch) => void) | undefined;
  afterSettlementCommit?: ((prepared: VnextPreparedGateDispatch) => void) | undefined;
  afterSpawnRecord?: ((prepared: VnextPreparedGateDispatch) => void) | undefined;
  beforeCommandSpawn?: ((prepared: VnextPreparedGateDispatch) => void) | undefined;
  beforeCommandSettle?: ((prepared: VnextPreparedGateDispatch) => void) | undefined;
}

export const vnextGateDispatchSeams: VnextGateDispatchSeams = {};

async function stepLocked(context: VnextRuntimeContext, runId: string, producer: VnextProducer, token: string): Promise<VnextRunDriveResult> {
  const prepared = context.eventStore.transaction(() => prepareDispatch(context, runId, producer.id));
  if (prepared.kind === "return") {
    return prepared.handoff ? { state: prepared.state, handoff: prepared.handoff } : { state: prepared.state };
  }

  if (prepared.kind === "gate") {
    const step = prepared.envelope.plan.steps[prepared.stepId];
    if (!step || step.kind !== "gate") {
      throw runtimeError("run_events_illegal", prepared.run.runId, "prepared gate step is not a gate");
    }
    const definition = prepared.envelope.gates.definitions[step.gate];
    if (definition?.kind === "command") {
      return runPreparedCommandGate(context, prepared, definition, token);
    }
    if (!definition || definition.kind !== "artifacts-exist") {
      throw runtimeError("run_events_illegal", prepared.run.runId, "prepared gate is not artifacts-exist");
    }
    registerVnextAttemptController(context.eventStore.path, runId, { attemptId: prepared.attemptId, controller: prepared.controller });
    const clearBudget = armRunDurationBudgetTimer(context, runId);
    try {
      const observation = evaluateArtifactsGate(context, definition);
      vnextGateDispatchSeams.afterEvaluate?.(prepared);
      return context.eventStore.transaction(() => settlePreparedGate(context, prepared, observation));
    } finally {
      clearBudget();
      unregisterVnextAttemptController(context.eventStore.path, runId, prepared.attemptId);
    }
  }

  return drivePanel(context, prepared.panel, producer);
}

async function runPreparedCommandGate(
  context: VnextRuntimeContext,
  prepared: VnextPreparedGateDispatch,
  definition: { readonly kind: "command"; readonly argv: readonly string[]; readonly timeoutMs: number; readonly cwd?: "control" },
  token: string,
): Promise<VnextRunDriveResult> {
  assertCommandSeatbelt(definition.argv.join(" "));
  const storePath = context.eventStore.path;
  const observer = createCommandObserver({
    definition,
    cwd: context.projectRoot,
    signal: prepared.controller.signal,
    onSpawned: () => {
      if (isVnextRuntimeContextClosed(context)) return;
      try {
        context.eventStore.transaction(() => {
          recordGateSpawnedInTransaction(context, prepared.run, prepared.envelope, prepared.stepId);
          vnextGateDispatchSeams.afterSpawnRecord?.(prepared);
        });
      } catch (error) {
        // Mark the hold unsettled synchronously BEFORE the observer stop path
        // can take any fallible action (group signalling) on this attempt.
        try {
          markVnextGateHoldUnsettled(storePath, prepared.run.runId, token, prepared.attemptId);
        } catch {
          // The hold is already unsettled or released; the original failure governs.
        }
        throw error;
      }
    },
  });
  armVnextGateHold(storePath, prepared.run.runId, token, prepared.attemptId, () => observer.requestStop("cancel"));
  registerVnextAttemptController(storePath, prepared.run.runId, { attemptId: prepared.attemptId, controller: prepared.controller });
  const clearBudget = armRunDurationBudgetTimer(context, prepared.run.runId);
  const unhookClose = registerVnextRuntimeCloseHook(context, () => {
    try {
      markVnextGateHoldUnsettled(storePath, prepared.run.runId, token, prepared.attemptId);
    } catch {
      // Hold may already be unsettled.
    }
    dropVnextGateStopHook(storePath, prepared.run.runId, prepared.attemptId);
    observer.beginBoundedCleanup();
  });
  try {
    vnextGateDispatchSeams.beforeCommandSpawn?.(prepared);
    const outcome = await observer.run();
    dropVnextGateStopHook(storePath, prepared.run.runId, prepared.attemptId);
    if (isVnextRuntimeContextClosed(context)) {
      try {
        markVnextGateHoldUnsettled(storePath, prepared.run.runId, token, prepared.attemptId);
      } catch {
        // already unsettled
      }
      return closedCommandHandoff(context, prepared, outcome.kind === "uncertain" ? outcome.reason : "lost-close");
    }
    if (outcome.kind === "no-start") {
      return commitOwnedCommandSettlement(context, prepared, token, () => (
        recordGateNoStartInTransaction(context, prepared.run, prepared.envelope, prepared.stepId, outcome.observation)
      ), outcome.observation);
    }
    if (outcome.kind === "complete") {
      try {
        vnextGateDispatchSeams.beforeCommandSettle?.(prepared);
      } catch (error) {
        // Retain the unsettled hold and attempt a truthful recording-error
        // uncertainty only if no observation was committed.
        return recoverCommandRecordingFailure(context, prepared, token, outcome.observation, error);
      }
      if (isVnextRuntimeContextClosed(context)) {
        try {
          markVnextGateHoldUnsettled(storePath, prepared.run.runId, token, prepared.attemptId);
        } catch {
          // already unsettled
        }
        return closedCommandHandoff(context, prepared, "lost-close");
      }
      return commitOwnedCommandSettlement(context, prepared, token, () => settlePreparedGate(context, prepared, outcome.observation), outcome.observation);
    }
    return commitCommandUncertainty(context, prepared, token, outcome.reason, outcome.observation);
  } finally {
    unhookClose();
    clearBudget();
    unregisterVnextAttemptController(storePath, prepared.run.runId, prepared.attemptId);
  }
}

function closedCommandHandoff(
  context: VnextRuntimeContext,
  prepared: VnextPreparedGateDispatch,
  reason: string,
): VnextRunDriveResult {
  let state: VnextRunDriveResult["state"];
  try {
    state = foldStoredVnextRun(context, requireRun(context, prepared.run.runId));
  } catch {
    state = prepared.state;
  }
  return {
    state,
    handoff: {
      reason: "attempt_unsettled",
      stepId: prepared.stepId,
      attemptId: prepared.attemptId,
      detail: reason,
    },
  };
}

function commitOwnedCommandSettlement(
  context: VnextRuntimeContext,
  prepared: VnextPreparedGateDispatch,
  token: string,
  write: () => { state: VnextRunDriveResult["state"] },
  observation: VnextGateObservationInput,
): VnextRunDriveResult {
  let committed: { state: VnextRunDriveResult["state"] };
  try {
    committed = context.eventStore.transaction(() => write());
  } catch (error) {
    return recoverCommandRecordingFailure(context, prepared, token, observation, error);
  }
  try {
    vnextGateDispatchSeams.afterSettlementCommit?.(prepared);
  } catch (error) {
    return retainCommittedCommandProof(context, prepared, token, error);
  }
  try {
    finishVnextOwnedGate(context.eventStore.path, prepared.run.runId, token, prepared.attemptId);
  } catch (error) {
    return retainCommittedCommandProof(context, prepared, token, error);
  }
  return committed;
}

function retainCommittedCommandProof(
  context: VnextRuntimeContext,
  prepared: VnextPreparedGateDispatch,
  token: string,
  error: unknown,
): never {
  try {
    finishOwnedGateAfterCommittedTerminalProof(context, prepared, token);
  } catch {
    // Invalid identity or hold state inside finish stays fail-closed; do not force or retry a release.
  }
  throw error;
}

function finishOwnedGateAfterCommittedTerminalProof(
  context: VnextRuntimeContext,
  prepared: VnextPreparedGateDispatch,
  token: string,
): void {
  if (isVnextRuntimeContextClosed(context)) return;
  const run = context.eventStore.run(prepared.run.runId);
  if (!run || run.projectId !== context.projectId || run.homeRuntimeId !== context.homeRuntimeId) return;
  const row = context.eventStore.gateAttempt(prepared.attemptId);
  const preparedIdentity = {
    runId: prepared.run.runId,
    attemptId: prepared.attemptId,
    assignmentId: prepared.assignmentId,
    effectId: prepared.effectId,
    stepId: prepared.stepId,
  };
  if (!row || !gateRowIdentityMatches(row, preparedIdentity) || row.projectId !== context.projectId || row.homeRuntimeId !== context.homeRuntimeId) {
    return;
  }
  const observation = context.eventStore.gateObservationForAttempt(prepared.attemptId);
  const evidence = context.eventStore.gateEvidenceForAttempt(prepared.attemptId);
  const events = context.eventStore.events(prepared.run.runId, 0, 1_000_000);
  let state;
  try {
    state = foldStoredVnextRun(context, run);
  } catch {
    return;
  }
  const capability = context.eventStore.capabilityByAttempt(prepared.attemptId);
  if (
    !capability
    || capability.state !== "settled"
    || capability.runId !== prepared.run.runId
    || capability.attemptId !== prepared.attemptId
    || capability.assignmentId !== prepared.assignmentId
    || capability.stepId !== prepared.stepId
    || capability.stepAttempt !== prepared.stepAttempt
  ) {
    return;
  }
  const terminalProof = isEvaluatedSettledProof(row, observation, evidence)
    || isExcludedTerminalProof(state, row, observation, evidence, events);
  if (!terminalProof) return;
  const hold = vnextGateHold(context.eventStore.path, prepared.run.runId);
  const admittedToken = vnextAdmittedToken(context.eventStore.path, prepared.run.runId);
  if (
    !hold
    || hold.state !== "active"
    || hold.attemptId !== prepared.attemptId
    || hold.token !== token
    || admittedToken !== token
  ) {
    return;
  }
  finishVnextOwnedGate(context.eventStore.path, prepared.run.runId, token, prepared.attemptId);
}

function recoverCommandRecordingFailure(
  context: VnextRuntimeContext,
  prepared: VnextPreparedGateDispatch,
  token: string,
  observation: VnextGateObservationInput,
  error: unknown,
): VnextRunDriveResult {
  markVnextGateHoldUnsettled(context.eventStore.path, prepared.run.runId, token, prepared.attemptId);
  if (isVnextRuntimeContextClosed(context)) {
    throw error;
  }
  const existing = context.eventStore.gateObservationForAttempt(prepared.attemptId);
  if (existing) {
    throw runtimeError(
      "run_events_illegal",
      prepared.run.runId,
      `command observation recording failed after committed proof: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const folded = foldStoredVnextRun(context, requireRun(context, prepared.run.runId));
  if (folded.currentStep?.attemptId === prepared.attemptId && folded.currentStep.observationId) {
    throw runtimeError(
      "run_events_illegal",
      prepared.run.runId,
      "command observation recording failed after committed proof",
    );
  }
  const incomplete: VnextGateObservationInput = {
    ...observation,
    completeness: "incomplete",
    errorClass: observation.errorClass ?? "recording-error",
    stopCause: observation.stopCause === "none" ? "error" : observation.stopCause,
  };
  return commitCommandUncertainty(context, prepared, token, "recording-error", incomplete, error);
}

function commitCommandUncertainty(
  context: VnextRuntimeContext,
  prepared: VnextPreparedGateDispatch,
  token: string,
  reason: string,
  observation: VnextGateObservationInput,
  priorError?: unknown,
): VnextRunDriveResult {
  try {
    markVnextGateHoldUnsettled(context.eventStore.path, prepared.run.runId, token, prepared.attemptId);
  } catch {
    // already unsettled
  }
  if (isVnextRuntimeContextClosed(context)) {
    if (priorError) throw priorError;
    return closedCommandHandoff(context, prepared, reason);
  }
  const existing = context.eventStore.gateObservationForAttempt(prepared.attemptId);
  if (existing) {
    throw runtimeError(
      "run_events_illegal",
      prepared.run.runId,
      "command observation already committed; uncertainty cannot replace it",
    );
  }
  const incomplete: VnextGateObservationInput = { ...observation, completeness: "incomplete" };
  try {
    const written = context.eventStore.transaction(() => {
      const result = recordGateUncertainInTransaction(context, prepared.run, prepared.envelope, prepared.stepId, reason, incomplete);
      vnextGateDispatchSeams.afterUncertaintyWrite?.(prepared);
      return result;
    });
    return {
      state: written.state,
      handoff: {
        reason: "attempt_unsettled",
        stepId: prepared.stepId,
        attemptId: prepared.attemptId,
        detail: reason,
      },
    };
  } catch (error) {
    if (priorError) throw priorError;
    throw error;
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
  producerId: string;
  request: VnextProducerRequest;
  controller: AbortController;
  state: VnextRunState;
}

interface PreparedPanel {
  run: VnextRunRecord;
  plan: VnextCompiledPlan;
  step: VnextCompiledStep;
  stepId: string;
  stepAttempt: number;
  target: number;
  maxParallel: number;
  first: PreparedDispatch;
  state: VnextRunState;
}

export interface VnextPanelMemberHook {
  readonly attemptId: string;
  readonly assignmentId: string;
  readonly stepId: string;
  readonly stepAttempt: number;
}

export interface VnextPanelDispatchSeams {
  afterBirth?: ((member: VnextPanelMemberHook) => void) | undefined;
  beforeAppendExecuting?: ((member: VnextPanelMemberHook) => void) | undefined;
  failAppendExecuting?: ((member: VnextPanelMemberHook) => boolean) | undefined;
  beforeInvoke?: ((member: VnextPanelMemberHook) => void) | undefined;
  failSettleMember?: ((member: VnextPanelMemberHook) => boolean) | undefined;
  skipDispatch?: (() => boolean) | undefined;
}

export const vnextPanelDispatchSeams: VnextPanelDispatchSeams = {};

function unreconciledPanelAttemptId(state: VnextRunState): string | undefined {
  const current = state.currentStep;
  if (!current) return undefined;
  for (const assignmentId of current.panel.order) {
    const assignment = current.panel.assignments[assignmentId];
    if (!assignment) continue;
    for (const [attemptId, attempt] of Object.entries(assignment.attempts)) {
      if (attempt.status === "starting" || attempt.status === "executing" || attempt.status === "settling") {
        return attemptId;
      }
    }
  }
  return undefined;
}

function resolveProducerRoute(
  projectRoot: string,
  step: VnextCompiledStep,
  agentId: string,
): { provider: string; model: string; selector: string } | { error: Omit<VnextRunHandoff, "stepId"> } {
  let agentModel: string | undefined;
  const agentFile = join(projectRoot, ".kxm", "agents", `${agentId}.yaml`);
  if (existsSync(agentFile)) {
    try {
      const parsed = parse(readFileSync(agentFile, "utf8")) as Record<string, unknown>;
      if (typeof parsed?.model === "string") {
        agentModel = parsed.model;
      }
    } catch {
      // ignore
    }
  }

  let selector = typeof step.model === "string" ? step.model : agentModel;
  if (!selector) {
    if (agentId === "implementer") {
      selector = "xai/grok-4.6";
    }
  }
  if (!selector) {
    return {
      error: {
        reason: "step_unsupported",
        field: "model",
        detail: "producer_route_unsupported: agent or step has no model declared",
      },
    };
  }

  const slash = selector.indexOf("/");
  if (slash <= 0 || slash === selector.length - 1) {
    return {
      error: {
        reason: "step_unsupported",
        field: "model",
        detail: `producer_route_unsupported: invalid selector '${selector}'`,
      },
    };
  }

  if (!isRouteAdmitted(projectRoot, selector)) {
    return {
      error: {
        reason: "step_unsupported",
        field: "model",
        detail: `producer_route_unsupported: model '${selector}' is not admitted`,
      },
    };
  }

  const role = agentId === "implementer" ? "writer" : agentId;
  const roleBindings = listRoleBindings(projectRoot);
  const roster = roleBindings[role];
  if (roster && !roster.includes(selector)) {
    return {
      error: {
        reason: "step_unsupported",
        field: "model",
        detail: `producer_route_unsupported: model '${selector}' not in role '${role}' roster`,
      },
    };
  }

  const provider = selector.slice(0, slash);
  const model = selector.slice(slash + 1);
  return { provider, model, selector };
}

function prepareDispatch(
  context: VnextRuntimeContext,
  runId: string,
  producerId?: "driver-simulated" | "pi" | string,
): { kind: "panel"; panel: PreparedPanel } | { kind: "return"; state: VnextRunState; handoff?: VnextRunHandoff } | ({ kind: "gate" } & VnextPreparedGateDispatch) {
  const run = requireRun(context, runId);
  const plan = rehydrateVnextCompiledPlanFromStore(context.eventStore, run);
  const state = foldStoredVnextRun(context, run);
  if (vnextPanelDispatchSeams.skipDispatch?.()) {
    return { kind: "return", state };
  }
  if (state.status === "cancelling" && vnextAttemptControllers(context.eventStore.path, runId).length === 0) {
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
  const unreconciledAttemptId = unreconciledPanelAttemptId(state);
  if (unreconciledAttemptId) {
    const currentStepId = state.currentStep?.stepId;
    if (currentStepId === undefined) {
      throw runtimeError("run_events_illegal", runId, "unreconciled attempt is missing step identity");
    }
    return {
      kind: "return",
      state,
      handoff: {
        reason: "attempt_unreconciled",
        attemptId: unreconciledAttemptId,
        stepId: currentStepId,
        detail: "issued attempt is not held by this process",
      },
    };
  }
  if (state.status === "blocked_uncertain") {
    return {
      kind: "return",
      state,
      handoff: {
        reason: "gate_uncertain_blocked",
        ...(state.currentStep?.stepId ? { stepId: state.currentStep.stepId } : {}),
        ...(state.currentStep?.attemptId ? { attemptId: state.currentStep.attemptId } : {}),
        detail: "run is blocked_uncertain awaiting external signal or operator intervention",
      },
    };
  }
  if (state.status !== "running" || state.currentStep) {
    if (state.currentStep?.effectState === "blocked_uncertain") {
      return {
        kind: "return",
        state,
        handoff: {
          reason: "attempt_unsettled",
          stepId: state.currentStep.stepId,
          ...(state.currentStep.attemptId ? { attemptId: state.currentStep.attemptId } : {}),
          detail: "step effect is blocked_uncertain",
        },
      };
    }
    return { kind: "return", state };
  }
  const stepId = state.pendingStepId ?? plan.entryStepId;
  const step = plan.steps[stepId];
  if (!step) throw runtimeError("run_events_illegal", runId, `unknown pending step ${stepId}`);

  const allEvents = context.eventStore.events(runId, 0, 100000);
  let accumulatedMeteredCost = 0;
  let unmeteredOrUnknownAttempts = 0;
  for (const ev of allEvents) {
    if (ev.eventType === "routing.attempt.recorded") {
      const routing = (ev.payload as { routing?: RoutingRecordV2 })?.routing;
      if (routing?.costBasis === "metered" && typeof routing.costUsd === "number") {
        accumulatedMeteredCost += routing.costUsd;
      } else if (routing?.costBasis === "unmetered" || routing?.costBasis === "unknown") {
        unmeteredOrUnknownAttempts += 1;
      }
    }
  }

  if (plan.limits.maxModelCost !== undefined && accumulatedMeteredCost >= plan.limits.maxModelCost) {
    return { kind: "return", ...failBudget(context, run, plan, state, "budget_model_cost", stepId) };
  }

  const maxUnmeteredAttempts = 100;
  if (unmeteredOrUnknownAttempts >= maxUnmeteredAttempts) {
    return { kind: "return", ...failBudget(context, run, plan, state, "budget_unmetered_attempts", stepId) };
  }

  if (step.kind === "gate") {
    const envelope = loadVnextRunPlanEnvelope(context.eventStore, run);
    const unsupported = unsupportedGateStep(plan, step, envelope, context);
    if (unsupported) return { kind: "return", state, handoff: { ...unsupported, stepId } };
    const definition = envelope.gates.definitions[step.gate];
    if (definition?.kind === "command") {
      const preflightResult = gateRecoveryPreflight(context);
      const firstBlocking = preflightResult.blocking[0];
      if (firstBlocking) {
        return {
          kind: "return",
          state,
          handoff: {
            reason: "gate_recovery_pending",
            attemptId: firstBlocking.attemptId,
            detail: `${preflightResult.blocking.length} unfinished gate attempt(s) in project`,
          },
        };
      }
    }
    const result = recordGateIntentInTransaction(context, run, envelope, stepId);
    const current = result.state.currentStep;
    const attemptId = current?.attemptId;
    const assignmentId = current?.assignmentId;
    const effectId = current?.effectId;
    if (
      !current
      || current.stepId !== stepId
      || attemptId === undefined
      || assignmentId === undefined
      || effectId === undefined
    ) {
      throw runtimeError("run_events_illegal", runId, "gate intent did not bind exact attempt identity");
    }
    return {
      kind: "gate",
      run,
      envelope,
      stepId,
      stepAttempt: current.stepAttempt,
      assignmentId,
      attemptId,
      effectId,
      controller: new AbortController(),
      state: result.state,
    };
  }

  const unsupported = unsupportedStep(plan, step, producerId);
  if (unsupported) return { kind: "return", state, handoff: { ...unsupported, stepId } };

  let resolvedRoute: { provider: string; model: string; selector: string } | undefined;
  if (producerId !== "driver-simulated") {
    const allowed = step.assignments.allowedAgents;
    const agentId = (allowed && allowed.length > 0 && allowed[0])
      ? allowed[0]!
      : (step.kind === "agent" || step.kind === "moa" ? step.agent : "coordinator");
    const routeResult = resolveProducerRoute(context.projectRoot, step, agentId);
    if ("error" in routeResult) {
      return { kind: "return", state, handoff: { ...routeResult.error, stepId } };
    }
    resolvedRoute = routeResult;
  }

  const used = state.stepAttempts[stepId] ?? 0;
  if (used >= step.maxAttempts) {
    return { kind: "return", ...failBudget(context, run, plan, state, "budget_step_attempts", stepId) };
  }
  const stepAttempt = used + 1;
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
  for (const event of events) context.eventStore.appendEvent(event);
  const entered = foldStoredVnextRun(context, run);
  persistVnextRunState(context, runId, entered, events[events.length - 1]!.sequence);
  const first = birthMember(context, {
    run,
    plan,
    step,
    stepId,
    stepAttempt,
    enterRunning: true,
    producerId,
    resolvedRoute,
  });
  return {
    kind: "panel",
    panel: {
      run,
      plan,
      step,
      stepId,
      stepAttempt,
      target: step.assignments.target,
      maxParallel: step.assignments.maxParallel,
      first,
      state: first.state,
    },
  };
}

function panelInFlight(state: VnextRunState): number {
  const current = state.currentStep;
  if (!current) return 0;
  let count = 0;
  for (const assignmentId of current.panel.order) {
    const assignment = current.panel.assignments[assignmentId];
    if (!assignment) continue;
    for (const attempt of Object.values(assignment.attempts)) {
      if (attempt.status === "starting" || attempt.status === "executing" || attempt.status === "settling") count += 1;
    }
  }
  return count;
}

function panelFrozenState(state: VnextRunState): boolean {
  const current = state.currentStep;
  if (!current) return true;
  return current.outcome !== undefined
    || current.status === "passed"
    || current.status === "failed"
    || current.status === "cancelled";
}

function birthAllowed(state: VnextRunState, step: VnextCompiledStep): boolean {
  if (state.status !== "running" || state.cancelRequested || panelFrozenState(state)) return false;
  const born = state.currentStep?.panel.order.length ?? 0;
  if (born >= step.assignments.target) return false;
  if (panelInFlight(state) >= step.assignments.maxParallel) return false;
  return true;
}

function birthMember(
  context: VnextRuntimeContext,
  input: {
    run: VnextRunRecord;
    plan: VnextCompiledPlan;
    step: VnextCompiledStep;
    stepId: string;
    stepAttempt: number;
    enterRunning?: boolean | undefined;
    producerId?: ("driver-simulated" | "pi" | string) | undefined;
    resolvedRoute?: { provider: string; model: string; selector: string } | undefined;
  },
): PreparedDispatch {
  const run = requireRun(context, input.run.runId);
  const folded = foldStoredVnextRun(context, run);
  if (!birthAllowed(folded, input.step)) {
    throw runtimeError("run_events_illegal", run.runId, "member birth is not legal");
  }
  const promptText = context.eventStore.getRunPrompt(run.runId);
  if (promptText === undefined) {
    throw runtimeError("run_prompt_mismatch", run.runId, "prompt text missing from accepted run prompt store");
  }
  const promptHash = createHash("sha256").update(promptText, "utf8").digest("hex");
  const expectedHash = run.promptSha256.replace(/^sha256:/, "");
  if (promptHash !== expectedHash) {
    throw runtimeError("run_prompt_mismatch", run.runId, "prompt text does not match accepted promptSha256");
  }
  const born = folded.currentStep?.panel.order.length ?? 0;
  const allowed = input.step.assignments.allowedAgents;
  const agentId = (allowed && allowed.length > born && allowed[born])
    ? allowed[born]!
    : (input.step.kind === "agent" || input.step.kind === "moa" ? input.step.agent : "coordinator");
  let resolvedRoute = input.resolvedRoute;
  if (!resolvedRoute && input.producerId && input.producerId !== "driver-simulated") {
    const routeResult = resolveProducerRoute(context.projectRoot, input.step, agentId);
    if (!("error" in routeResult)) {
      resolvedRoute = routeResult;
    }
  }
  const assignmentId = newVnextAssignmentId();
  const attemptId = newVnextAttemptId();
  const minted = mintCapabilitySecret();
  const controller = new AbortController();
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
  push("assignment.created", { assignmentId, stepId: input.stepId, stepAttempt: input.stepAttempt, agentId, status: "created" });
  push("assignment.accepted", { assignmentId, status: "accepted" });
  push("attempt.created", { attemptId, assignmentId, status: "created" });
  push("assignment.dispatched", {
    assignmentId,
    capabilityHash: minted.hash,
    status: "dispatched",
    ...(resolvedRoute ? { model: { provider: resolvedRoute.provider, model: resolvedRoute.model } } : {}),
  });
  push("attempt.status_changed", { attemptId, status: "starting" });
  if (input.enterRunning) {
    push("step.status_changed", { stepId: input.stepId, status: "running", previousStatus: "preparing" });
  }
  for (const event of events) context.eventStore.appendEvent(event);
  context.eventStore.insertCapability({
    attemptId,
    runId: run.runId,
    assignmentId,
    stepId: input.stepId,
    stepAttempt: input.stepAttempt,
    producerId: input.producerId ?? "driver-simulated",
    capabilityHash: minted.hash,
    state: "issued",
  });
  const next = foldStoredVnextRun(context, run);
  persistVnextRunState(context, run.runId, next, events[events.length - 1]!.sequence);
  const rawContextPacket = buildFormalContextPacket({
    project: run.projectId,
    targetRole: agentId,
    task: {
      taskId: run.runId,
      stepId: input.stepId,
      stepAttempt: input.stepAttempt,
      objective: promptText,
      allowedOutcomes: [...input.step.outcomes],
      permissionCeiling: Object.values(input.step.repositories).some((access) => access === "write") ? "edit" : "read-only",
    },
    acceptanceCriteria: input.step.requiredEvidence.map((ev) => ({
      id: ev.key,
      description: `Provide ${ev.kind} evidence for ${ev.key}`,
      verificationKind: "witness",
      required: true,
    })),
    plan: {
      planHash: input.plan.planHash?.stageId ?? "default",
      activeStepIndex: input.step.index,
      totalSteps: input.plan.order.length,
      settledDecisions: [],
    },
  });
  const { packet: contextPacket } = pruneContextPacket(rawContextPacket);
  const generatedPrompt = formatContextPacketForPrompt(contextPacket);

  const member: PreparedDispatch = {
    run,
    plan: input.plan,
    step: input.step,
    stepId: input.stepId,
    stepAttempt: input.stepAttempt,
    assignmentId,
    attemptId,
    agentId,
    capabilityHash: minted.hash,
    producerId: input.producerId ?? "driver-simulated",
    request: {
      runId: run.runId,
      stepId: input.stepId,
      stepAttempt: input.stepAttempt,
      assignmentId,
      attemptId,
      agentId,
      instanceNo: born + 1,
      scopeEpoch: 1,
      capability: minted.secret,
      allowedOutcomes: input.step.outcomes,
      signal: controller.signal,
      prompt: input.step.instructions ? `${input.step.instructions}\n\n${generatedPrompt}` : generatedPrompt,
      thinking: input.stepAttempt <= 1 ? "low" : "medium",
      contextPacket,
      ...(resolvedRoute ? { provider: resolvedRoute.provider, model: resolvedRoute.model } : {}),
    },
    controller,
    state: next,
  };
  vnextPanelDispatchSeams.afterBirth?.(member);
  return member;
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

type MemberWork =
  | { attemptId: string; invoked: true; produced: { result?: VnextProducerResult; error: boolean } }
  | { attemptId: string; invoked: false; skipped: true }
  | { attemptId: string; invoked: false; appendFailed: true; error: unknown };

function singletonPanel(step: VnextCompiledStep): boolean {
  return step.assignments.maximum === 1 && step.assignments.target === 1;
}

function unreconciledHandoff(state: VnextRunState, stepId: string, attemptId?: string): VnextRunDriveResult {
  return {
    state,
    handoff: {
      reason: "attempt_unreconciled",
      stepId,
      ...(attemptId !== undefined ? { attemptId } : {}),
      detail: "issued attempt is not held by this process",
    },
  };
}

function capabilityHashBound(stored: string, minted: string): boolean {
  const left = Buffer.from(stored);
  const right = Buffer.from(minted);
  return left.length === right.length && timingSafeEqual(left, right);
}

function capabilityMatchesDispatch(
  capability: VnextAttemptCapabilityRow | undefined,
  member: PreparedDispatch,
  allowedStates: ReadonlyArray<VnextAttemptCapabilityRow["state"]>,
  expectedProducerId?: string,
): boolean {
  return Boolean(
    capability
    && capabilityHashBound(capability.capabilityHash, member.capabilityHash)
    && capability.runId === member.run.runId
    && capability.stepId === member.stepId
    && capability.stepAttempt === member.stepAttempt
    && capability.assignmentId === member.assignmentId
    && capability.attemptId === member.attemptId
    && capability.producerId === (expectedProducerId ?? member.producerId ?? "driver-simulated")
    && allowedStates.includes(capability.state),
  );
}

async function drivePanel(
  context: VnextRuntimeContext,
  panel: PreparedPanel,
  producer: VnextProducer,
): Promise<VnextRunDriveResult> {
  const runId = panel.run.runId;
  const owned = new Map<string, PreparedDispatch>();
  const pending = new Map<string, Promise<MemberWork>>();
  let stopBirths = false;
  let settlementFailed = false;

  const budgetClears = new Map<string, () => void>();
  const register = (member: PreparedDispatch): void => {
    registerVnextAttemptController(context.eventStore.path, runId, { attemptId: member.attemptId, controller: member.controller });
    budgetClears.set(member.attemptId, armRunDurationBudgetTimer(context, runId));
    owned.set(member.attemptId, member);
  };

  const abortOwned = (): void => {
    for (const member of owned.values()) member.controller.abort();
  };

  const launch = (member: PreparedDispatch): void => {
    register(member);
    const work = (async (): Promise<MemberWork> => {
      try {
        vnextPanelDispatchSeams.beforeAppendExecuting?.(member);
        const started = context.eventStore.transaction(() => {
          if (vnextPanelDispatchSeams.failAppendExecuting?.(member)) {
            throw runtimeError("run_events_illegal", runId, "appendExecuting failed");
          }
          const run = requireRun(context, runId);
          const state = foldStoredVnextRun(context, run);
          const capability = context.eventStore.capabilityByAttempt(member.attemptId);
          const located = vnextFoldPanelAttempt(state.currentStep, member.attemptId);
          if (
            state.cancelRequested
            || state.status === "cancelling"
            || !capabilityMatchesDispatch(capability, member, ["issued"], producer.id)
            || !located
            || located.assignmentId !== member.assignmentId
            || located.attempt.status !== "starting"
          ) {
            return false;
          }
          appendExecuting(context, member);
          return true;
        });
        if (!started) return { attemptId: member.attemptId, invoked: false, skipped: true };
        const executingBound = (): boolean => {
          const run = requireRun(context, runId);
          const state = foldStoredVnextRun(context, run);
          const capability = context.eventStore.capabilityByAttempt(member.attemptId);
          const located = vnextFoldPanelAttempt(state.currentStep, member.attemptId);
          if (
            state.cancelRequested
            || state.status === "cancelling"
            || !capabilityMatchesDispatch(capability, member, ["issued"], producer.id)
            || !located
            || located.assignmentId !== member.assignmentId
            || located.attempt.status !== "executing"
          ) {
            return false;
          }
          return true;
        };
        if (!executingBound()) return { attemptId: member.attemptId, invoked: false, skipped: true };
        vnextPanelDispatchSeams.beforeInvoke?.(member);
        if (!executingBound()) return { attemptId: member.attemptId, invoked: false, skipped: true };
        const produced = await invokeProducer(producer, member.request);
        return { attemptId: member.attemptId, invoked: true, produced };
      } catch (error) {
        member.controller.abort();
        return { attemptId: member.attemptId, invoked: false, appendFailed: true, error };
      }
    })();
    pending.set(member.attemptId, work);
  };

  const tryBirth = (): PreparedDispatch | undefined => {
    if (stopBirths) return undefined;
    return context.eventStore.transaction(() => {
      const run = requireRun(context, runId);
      const state = foldStoredVnextRun(context, run);
      if (!birthAllowed(state, panel.step)) return undefined;
      return birthMember(context, {
        run,
        plan: panel.plan,
        step: panel.step,
        stepId: panel.stepId,
        stepAttempt: panel.stepAttempt,
        producerId: producer.id,
      });
    });
  };

  const settleInvoked = (member: PreparedDispatch, produced: { result?: VnextProducerResult; error: boolean }): boolean => {
    if (produced.result?.effectUncertain) {
      settlementFailed = true;
      stopBirths = true;
      return false;
    }
    try {
      context.eventStore.transaction(() => {
        if (vnextPanelDispatchSeams.failSettleMember?.(member)) {
          throw runtimeError("run_events_illegal", runId, "member settlement write failed");
        }
        settleMember(context, member, produced.result, produced.error);
      });
      return true;
    } catch (err) {
      if (err instanceof Error && /costBasis/.test(err.message)) {
        throw err;
      }
      settlementFailed = true;
      stopBirths = true;
      return false;
    }
  };

  const drainPendingInvoked = async (): Promise<void> => {
    const rest = await Promise.allSettled([...pending.values()]);
    pending.clear();
    for (const result of rest) {
      if (result.status !== "fulfilled") continue;
      const item = result.value;
      const sibling = owned.get(item.attemptId);
      if (sibling && item.invoked) {
        settleInvoked(sibling, item.produced);
      }
    }
  };

  try {
    launch(panel.first);
    while (true) {
      while (!stopBirths && !settlementFailed) {
        try {
          const next = tryBirth();
          if (!next) break;
          launch(next);
        } catch {
          stopBirths = true;
          abortOwned();
          await drainPendingInvoked();
          const state = foldStoredVnextRun(context, requireRun(context, runId));
          return unreconciledHandoff(state, panel.stepId);
        }
      }
      if (pending.size === 0) break;
      const finished = await Promise.race(pending.values());
      pending.delete(finished.attemptId);
      const member = owned.get(finished.attemptId);
      if (!member) continue;
      if ("appendFailed" in finished && finished.appendFailed) {
        stopBirths = true;
        abortOwned();
        const rest = await Promise.all([...pending.values()]);
        pending.clear();
        if (singletonPanel(panel.step)) {
          context.eventStore.transaction(() => hardStopUnrecorded(context, member, "executing_unrecorded"));
          throw finished.error;
        }
        for (const item of rest) {
          const sibling = owned.get(item.attemptId);
          if (sibling && item.invoked) {
            settleInvoked(sibling, item.produced);
          }
        }
        const state = foldStoredVnextRun(context, requireRun(context, runId));
        return unreconciledHandoff(state, panel.stepId, member.attemptId);
      }
      if (!finished.invoked) {
        stopBirths = true;
        continue;
      }
      if (!settleInvoked(member, finished.produced)) {
        abortOwned();
        const rest = await Promise.all([...pending.values()]);
        pending.clear();
        for (const item of rest) {
          const sibling = owned.get(item.attemptId);
          if (sibling && item.invoked) {
            settleInvoked(sibling, item.produced);
          }
        }
        const state = foldStoredVnextRun(context, requireRun(context, runId));
        return unreconciledHandoff(state, panel.stepId, member.attemptId);
      }
    }

    const folded = foldStoredVnextRun(context, requireRun(context, runId));
    const leftover = unreconciledPanelAttemptId(folded);
    if (leftover || settlementFailed) {
      return unreconciledHandoff(folded, panel.stepId, leftover);
    }
    const born = folded.currentStep?.panel.order.length ?? 0;
    const allTerminal = Boolean(
      folded.currentStep
      && born > 0
      && folded.currentStep.panel.order.every((assignmentId) => folded.currentStep?.panel.assignments[assignmentId]?.status === "terminal")
      && vnextFoldPanelAttemptIds(folded.currentStep).every((attemptId) => vnextFoldPanelAttempt(folded.currentStep, attemptId)?.attempt.status === "terminal"),
    );
    if (!allTerminal) {
      return unreconciledHandoff(folded, panel.stepId, leftover);
    }
    if (born < panel.target && folded.status !== "cancelling" && !folded.cancelRequested) {
      return unreconciledHandoff(folded, panel.stepId);
    }
    try {
      return context.eventStore.transaction(() => joinPanel(context, panel));
    } catch {
      const state = foldStoredVnextRun(context, requireRun(context, runId));
      return unreconciledHandoff(state, panel.stepId);
    }
  } catch (error) {
    abortOwned();
    await drainPendingInvoked();
    throw error;
  } finally {
    for (const attemptId of owned.keys()) {
      budgetClears.get(attemptId)?.();
      unregisterVnextAttemptController(context.eventStore.path, runId, attemptId);
    }
  }
}

function producerRoutingRecord(context: VnextRuntimeContext, dispatch: PreparedDispatch, result: VnextProducerResult, now: string): RoutingRecordV2 {
  const run = requireRun(context, dispatch.run.runId);
  if (result.costBasis === undefined || result.costBasis === null) {
    throw runtimeError("settle_missing_cost_basis", run.runId, `attempt settlement rejected: missing required costBasis for attempt ${dispatch.attemptId}`);
  }
  if (result.costBasis !== "metered" && result.costBasis !== "unmetered" && result.costBasis !== "unknown") {
    throw runtimeError("settle_invalid_cost_basis", run.runId, `attempt settlement rejected: invalid costBasis ${String(result.costBasis)}`);
  }
  if (result.costBasis === "metered" && (typeof result.costUsd !== "number" || !Number.isFinite(result.costUsd) || result.costUsd < 0)) {
    throw runtimeError("settle_invalid_cost", run.runId, "attempt settlement rejected: metered costBasis requires non-negative finite costUsd");
  }
  const envelope = loadVnextRunPlanEnvelope(context.eventStore, run);
  const rawHash = result.behavioralSha256 ?? behavioralConfigHash({
    requestedModel: result.requestedModel ?? "simulated",
    effectiveModel: result.effectiveModel ?? result.requestedModel ?? "simulated",
    agentRole: dispatch.step.kind === "agent" || dispatch.step.kind === "moa" ? dispatch.step.agent : undefined,
    toolPolicyVersion: envelope.revisions.toolPolicy,
  });
  const record: Record<string, unknown> = {
    schema: ROUTING_RECORD_V2_SCHEMA, recordedAt: now,
    project: run.projectId, runId: run.runId, stepId: dispatch.stepId,
    assignmentId: dispatch.assignmentId, attemptId: dispatch.attemptId,
    harness: result.harness ?? (dispatch.producerId === "pi" ? "pi" : "driver-simulated"),
    provider: result.provider ?? "simulated", requestedModel: result.requestedModel ?? "simulated",
    effectiveModel: result.effectiveModel ?? result.requestedModel ?? "simulated",
    behavioralSha256: rawHash.startsWith("sha256:") ? rawHash : `sha256:${rawHash}`,
    latencyMs: typeof result.latencyMs === "number" ? result.latencyMs : 0,
    costBasis: result.costBasis, costUsd: result.costUsd ?? null,
    retries: Math.max(0, dispatch.stepAttempt - 1),
    thinking: result.thinking ?? dispatch.request.thinking,
  };
  for (const field of ["agentRole", "contextTokens", "tokensIn", "tokensOut", "cacheReadTokens", "cacheWriteTokens", "priceRef", "providerMetadata"] as const) {
    if (result[field] !== undefined) record[field] = result[field];
  }
  return parseRoutingRecordV2(record);
}

function settleMember(
  context: VnextRuntimeContext,
  dispatch: PreparedDispatch,
  result: VnextProducerResult | undefined,
  produceError: boolean,
): void {
  const run = requireRun(context, dispatch.run.runId);
  const state = foldStoredVnextRun(context, run);
  const capability = context.eventStore.capabilityByAttempt(dispatch.attemptId);
  const located = vnextFoldPanelAttempt(state.currentStep, dispatch.attemptId);
  if (
    !located
    || located.assignmentId !== dispatch.assignmentId
    || located.attempt.status !== "executing"
    || !capability
    || !capabilityMatchesDispatch(capability, dispatch, ["issued", "revoked"])
  ) {
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
    push("routing.attempt.recorded", { routing: producerRoutingRecord(context, dispatch,
      result ?? { outcome: "cancelled", costBasis: "unknown", costUsd: null }, now) });
    push("assignment.result_recorded", { assignmentId: dispatch.assignmentId, resultClass: "cancelled", status: "result_recorded" });
    push("attempt.status_changed", { attemptId: dispatch.attemptId, status: "terminal" });
    push("assignment.terminal", { assignmentId: dispatch.assignmentId, outcome: "cancelled", status: "terminal" });
  } else if (produceError) {
    const envelope = loadVnextRunPlanEnvelope(context.eventStore, run);
    const rawHash = result?.behavioralSha256 ?? behavioralConfigHash({
      requestedModel: result?.requestedModel ?? "simulated",
      effectiveModel: result?.effectiveModel ?? result?.requestedModel ?? "simulated",
      agentRole: dispatch.step.kind === "agent" || dispatch.step.kind === "moa" ? dispatch.step.agent : undefined,
      toolPolicyVersion: envelope.revisions.toolPolicy,
    });
    const behavioralSha256 = rawHash.startsWith("sha256:") ? rawHash : `sha256:${rawHash}`;

    const routingRecord: RoutingRecordV2 = {
      schema: ROUTING_RECORD_V2_SCHEMA,
      recordedAt: now,
      project: run.projectId,
      runId: run.runId,
      stepId: dispatch.stepId,
      assignmentId: dispatch.assignmentId,
      attemptId: dispatch.attemptId,
      harness: result?.harness ?? (dispatch.producerId === "pi" ? "pi" : "driver-simulated"),
      provider: result?.provider ?? "simulated",
      requestedModel: result?.requestedModel ?? "simulated",
      effectiveModel: result?.effectiveModel ?? result?.requestedModel ?? "simulated",
      behavioralSha256,
      latencyMs: typeof result?.latencyMs === "number" ? result.latencyMs : 0,
      costBasis: "unknown",
      costUsd: null,
      retries: Math.max(0, dispatch.stepAttempt - 1),
    };
    push("routing.attempt.recorded", { routing: parseRoutingRecordV2(routingRecord) });

    push("assignment.result_recorded", {
      assignmentId: dispatch.assignmentId,
      resultClass: "producer_rejected",
      status: "result_recorded",
    });
    push("attempt.status_changed", { attemptId: dispatch.attemptId, status: "terminal" });
    push("assignment.terminal", { assignmentId: dispatch.assignmentId, outcome: "failed", status: "terminal" });
  } else {
    if (!result) {
      throw runtimeError("settle_missing_cost_basis", run.runId, `attempt settlement rejected: missing required costBasis for attempt ${dispatch.attemptId}`);
    }
    push("routing.attempt.recorded", { routing: producerRoutingRecord(context, dispatch, result, now) });

    const outcome = typeof result.outcome === "string" ? result.outcome : undefined;
    const known = outcome !== undefined && dispatch.step.outcomes.includes(outcome);
    if (!known) {
      push("assignment.result_recorded", {
        assignmentId: dispatch.assignmentId,
        resultClass: "outcome_unknown",
        status: "result_recorded",
      });
      push("attempt.status_changed", { attemptId: dispatch.attemptId, status: "terminal" });
      push("assignment.terminal", { assignmentId: dispatch.assignmentId, outcome: "failed", status: "terminal" });
    } else {
      push("assignment.result_recorded", {
        assignmentId: dispatch.assignmentId,
        outcome,
        resultClass: "outcome",
        status: "result_recorded",
      });
      push("attempt.status_changed", { attemptId: dispatch.attemptId, status: "terminal" });
      push("assignment.terminal", { assignmentId: dispatch.assignmentId, outcome, status: "terminal" });
    }
  }
  context.eventStore.settleCapability(dispatch.attemptId, "settled");
  for (const event of events) context.eventStore.appendEvent(event);
  const next = foldStoredVnextRun(context, run);
  persistVnextRunState(context, run.runId, next, events[events.length - 1]!.sequence);
}

function joinPanel(context: VnextRuntimeContext, panel: PreparedPanel): VnextRunDriveResult {
  const run = requireRun(context, panel.run.runId);
  const state = foldStoredVnextRun(context, run);
  const current = state.currentStep;
  if (!current || current.stepId !== panel.stepId) {
    throw runtimeError("run_events_illegal", run.runId, "join attempted without the prepared step");
  }
  const joined = vnextJoinAll(panel.step, current.panel);
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

  const failRun = (reason: string): VnextRunDriveResult => {
    push("step.status_changed", { stepId: panel.stepId, status: "failed", previousStatus: "running" });
    push("run.status_changed", { status: "failed", reason, stepId: panel.stepId });
    for (const event of events) context.eventStore.appendEvent(event);
    const next = foldStoredVnextRun(context, run);
    persistVnextRunState(context, run.runId, next, events[events.length - 1]!.sequence);
    context.eventStore.updateRunStatus(run.runId, "failed", now);
    return { state: next };
  };

  const cancelRun = (): VnextRunDriveResult => {
    push("step.status_changed", { stepId: panel.stepId, status: "cancelled", previousStatus: "running" });
    push("run.status_changed", { status: "cancelled", reason: cancelReasonFromLog(context, run.runId) });
    for (const event of events) context.eventStore.appendEvent(event);
    const next = foldStoredVnextRun(context, run);
    persistVnextRunState(context, run.runId, next, events[events.length - 1]!.sequence);
    context.eventStore.updateRunStatus(run.runId, "cancelled", now);
    return { state: next };
  };

  const members: Array<{ resultClass: string | undefined; outcome: string | undefined }> = [];
  for (const assignmentId of current.panel.order) {
    const assignment = current.panel.assignments[assignmentId];
    const attemptId = assignment?.currentAttemptId;
    const attempt = attemptId ? assignment?.attempts[attemptId] : undefined;
    members.push({ resultClass: attempt?.resultClass, outcome: attempt?.outcome });
  }
  const rejected = members.some((member) => member.resultClass === "outcome_unknown" || member.resultClass === "producer_rejected");
  const declared = members.filter((member) => member.resultClass === "outcome");
  const declaredConflict = declared.length > 0 && declared.some((member) => member.outcome !== declared[0]?.outcome);

  if (state.cancelRequested || state.status === "cancelling") {
    if (rejected || declaredConflict) return failRun(rejected ? "outcome_unknown" : "join_conflict");
    return cancelRun();
  }
  if (joined.tag === "rejected") return failRun("outcome_unknown");
  if (joined.tag === "conflict") return failRun("join_conflict");
  if (joined.tag === "cancelled") {
    throw runtimeError("run_events_illegal", run.runId, "cancelled join requires cancellation authority");
  }
  if (joined.tag !== "outcome") {
    throw runtimeError("run_events_illegal", run.runId, "join attempted before the panel is joinable");
  }

  const outcome = joined.outcome;
  const selected = panel.step.transitions[outcome];
  if (!selected) return failRun("outcome_unknown");
  push("step.outcome_recorded", { stepId: panel.stepId, stepAttempt: panel.stepAttempt, outcome });
  const stepStatus = outcome === "passed" ? "passed" : outcome === "cancelled" ? "cancelled" : "failed";
  push("step.status_changed", { stepId: panel.stepId, status: stepStatus, previousStatus: "running" });
  const budget = transitionBudgetFailure(panel.plan, state, panel.stepId, outcome);
  if (budget) {
    push("run.status_changed", { status: "failed", reason: budget, stepId: panel.stepId, outcome });
    for (const event of events) context.eventStore.appendEvent(event);
    const next = foldStoredVnextRun(context, run);
    persistVnextRunState(context, run.runId, next, events[events.length - 1]!.sequence);
    context.eventStore.updateRunStatus(run.runId, "failed", now);
    return { state: next };
  }
  if (selected.to === "step") {
    push("step.transitioned", { fromStepId: panel.stepId, toStepId: selected.target, outcome });
  } else {
    push("step.transitioned", { fromStepId: panel.stepId, status: selected.terminalStatus, outcome });
    push("run.status_changed", { status: selected.terminalStatus });
  }
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

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function elapsedMsBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.trunc(to - from));
}

function declaredRunDurationBudget(context: VnextRuntimeContext, runId: string): VnextRunDurationBudget | undefined {
  const run = context.eventStore.run(runId);
  if (!run) return undefined;
  try {
    const envelope = loadVnextRunPlanEnvelope(context.eventStore, run);
    return effectiveRunDurationBudget(envelope.plan.limits, envelope.projectLimits);
  } catch {
    return undefined;
  }
}

function runDurationOverrunPayload(
  context: VnextRuntimeContext,
  runId: string,
  nowIso = new Date().toISOString(),
): { budgetMs: number; elapsedMs: number; source: VnextRunDurationBudget["source"] } | undefined {
  const declared = declaredRunDurationBudget(context, runId);
  if (!declared) return undefined;
  const run = context.eventStore.run(runId);
  if (!run) return undefined;
  const state = foldStoredVnextRun(context, run);
  if (!state.runningSince) return undefined;
  if (isTerminalRunStatus(state.status) || state.status === "cancelling") return undefined;
  const elapsedMs = elapsedMsBetween(state.runningSince, nowIso);
  if (elapsedMs < declared.budgetMs) return undefined;
  return { budgetMs: declared.budgetMs, elapsedMs, source: declared.source };
}

function cancelRunDurationIfExceeded(context: VnextRuntimeContext, runId: string): VnextRunDriveResult | undefined {
  if (isVnextRuntimeContextClosed(context)) return undefined;
  const payload = runDurationOverrunPayload(context, runId);
  if (!payload) return undefined;
  cancelVnextRun(context, runId, { reason: "budget_run_duration", budget: payload });
  return { state: foldStoredVnextRun(context, requireRun(context, runId)) };
}

function driveDeadlineAt(context: VnextRuntimeContext, runId: string, state: VnextRunState): string | undefined {
  const declared = declaredRunDurationBudget(context, runId);
  if (!declared || !state.runningSince) return undefined;
  const start = Date.parse(state.runningSince);
  if (!Number.isFinite(start)) return undefined;
  return new Date(start + declared.budgetMs).toISOString();
}

function driveReceiptBudget(
  context: VnextRuntimeContext,
  runId: string,
  state: VnextRunState,
  events: readonly VnextRunEvent[],
  closedAt: string,
): VnextDriveReceiptBudget | null {
  const declared = declaredRunDurationBudget(context, runId);
  if (!declared) return null;
  const elapsedMs = state.runningSince ? elapsedMsBetween(state.runningSince, closedAt) : 0;
  const overrun = events.some((event) => (
    event.eventType === "run.cancel_requested" && event.payload.reason === "budget_run_duration"
  ));
  return {
    budgetMs: declared.budgetMs,
    source: declared.source,
    elapsedMs,
    overrun,
  };
}

function cancelReasonFromLog(context: VnextRuntimeContext, runId: string): string {
  const events = context.eventStore.events(runId, 0, 1_000_000);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.eventType === "run.cancel_requested" && typeof event.payload.reason === "string") {
      return event.payload.reason;
    }
  }
  return "operator_cancel";
}

function armRunDurationBudgetTimer(context: VnextRuntimeContext, runId: string): () => void {
  const declared = declaredRunDurationBudget(context, runId);
  if (!declared) return () => undefined;
  const run = context.eventStore.run(runId);
  if (!run) return () => undefined;
  const state = foldStoredVnextRun(context, run);
  if (!state.runningSince) return () => undefined;
  const startMs = Date.parse(state.runningSince);
  if (!Number.isFinite(startMs)) return () => undefined;
  const deadlineMs = startMs + declared.budgetMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleared = false;
  const fire = (): void => {
    timer = undefined;
    if (cleared || isVnextRuntimeContextClosed(context)) return;
    const nowIso = new Date().toISOString();
    const elapsedMs = elapsedMsBetween(state.runningSince!, nowIso);
    if (elapsedMs < declared.budgetMs) {
      arm(declared.budgetMs - elapsedMs);
      return;
    }
    try {
      cancelVnextRun(context, runId, {
        reason: "budget_run_duration",
        budget: { budgetMs: declared.budgetMs, elapsedMs, source: declared.source },
      });
    } catch {
      // Already cancelling, terminal, or the store closed under us.
    }
  };
  const arm = (remaining: number): void => {
    if (cleared) return;
    const delay = Math.min(Math.max(0, remaining), MAX_TIMER_DELAY_MS);
    timer = setTimeout(fire, delay);
    timer.unref();
  };
  const unhook = registerVnextRuntimeCloseHook(context, () => {
    cleared = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  });
  arm(deadlineMs - Date.now());
  return () => {
    if (cleared) return;
    cleared = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    unhook();
  };
}

function unsupportedLimit(envelope: VnextRunPlanEnvelope): VnextRunHandoff | undefined {
  if (envelope.plan.limits.maxAgentTimeMs !== undefined) {
    return { reason: "limit_unsupported", field: "limits.maxAgentTimeMs", detail: "agent-time budget enforcement is not available in this slice" };
  }
  if (envelope.projectLimits.maxAgentTimeMs !== undefined) {
    return { reason: "limit_unsupported", field: "project.limits.maxAgentTimeMs", detail: "agent-time budget enforcement is not available in this slice" };
  }
  return undefined;
}

function unsupportedStep(
  plan: VnextCompiledPlan,
  step: VnextCompiledStep,
  producerId?: "driver-simulated" | "pi" | string,
): Omit<VnextRunHandoff, "stepId"> | undefined {
  if (step.kind === "gate") throw runtimeError("run_plan_corrupt", plan.workflowId, `unsupportedStep called on gate without envelope; use unsupportedGateStep instead`);
  if (step.kind !== "agent" && step.kind !== "moa" && step.kind !== "approval" && step.kind !== "wait") {
    return { reason: "step_unsupported", field: "kind", detail: `step kind ${step.kind} is not executed in this slice` };
  }
  if (step.assignments.maxAttemptsPerAssignment > 2) {
    return { reason: "step_unsupported", field: "assignments.maxAttemptsPerAssignment", detail: "only up to two physical attempts are supported in this slice" };
  }
  if (step.join.strategy !== "all" && step.join.strategy !== "all-settled") {
    return { reason: "step_unsupported", field: "join.strategy", detail: "only join all or all-settled is supported" };
  }
  if (step.join.strategy === "all" && step.join.minimumPassed !== undefined) {
    return { reason: "step_unsupported", field: "join.minimumPassed", detail: "minimumPassed requires join strategy all-settled" };
  }
  if (step.join.cancelRemaining) {
    return { reason: "step_unsupported", field: "join.cancelRemaining", detail: "cancelRemaining is not executed in this slice" };
  }
  if (step.assignments.distinctBy.some((d) => d !== "provider")) {
    return { reason: "step_unsupported", field: "assignments.distinctBy", detail: "only distinctBy provider is supported in this slice" };
  }
  if (step.assignments.maxWriteRepositories !== undefined && step.assignments.maxWriteRepositories > 1) {
    return { reason: "step_unsupported", field: "assignments.maxWriteRepositories", detail: "at most one write repository is supported in this slice" };
  }
  for (const evidence of step.requiredEvidence) {
    if (!evidence || !["artifact", "assignment-result", "gate", "approval", "receipt"].includes(evidence.kind)) {
      return { reason: "step_unsupported", field: "requiredEvidence", detail: `evidence kind '${evidence?.kind}' is not supported in this slice` };
    }
  }
  if (step.timeoutMs !== undefined && step.timeoutMs <= 0) {
    return { reason: "step_unsupported", field: "timeoutMs", detail: "timeoutMs must be positive" };
  }
  if (step.safeSpeculation) return { reason: "step_unsupported", field: "safeSpeculation", detail: "speculation is not executed in this slice" };
  if (step.tools) return { reason: "step_unsupported", field: "tools", detail: "tools are not executed in this slice" };
  if (step.secrets.length > 0) return { reason: "step_unsupported", field: "secrets", detail: "secrets are not executed in this slice" };
  for (const [repoId, access] of Object.entries(step.repositories)) {
    if (access !== "read" && access !== "write" && access !== "none") {
      return { reason: "step_unsupported", field: "repositories", detail: `invalid repository access '${access}' on ${repoId}` };
    }
  }
  if (producerId !== "driver-simulated" && Object.values(step.repositories).some((access) => access === "write")) {
    return {
      reason: "step_unsupported",
      field: "repositories",
      detail: "live write steps are unsupported until writer sandboxing witness passes",
    };
  }
  return undefined;
}

function unsupportedGateStep(plan: VnextCompiledPlan, step: VnextCompiledStep & { kind: "gate" }, envelope: VnextRunPlanEnvelope, context?: { projectRoot: string }): Omit<VnextRunHandoff, "stepId"> | undefined {
  if (!step.gate) return { reason: "step_unsupported", field: "gate", detail: "gate step is missing gate id" };
  if (envelope.gates.registry === null) {
    return { reason: "step_unsupported", field: "gate", detail: `step ${step.id} refers to a gate but registry is null` };
  }
  const definition = envelope.gates.definitions[step.gate];
  if (!definition) {
    return { reason: "step_unsupported", field: "gate", detail: `gate definition ${step.gate} not found in registry` };
  }
  if (definition.kind === "reserved") {
    return { reason: "gate_unsupported", field: "gate", detail: `gate ${step.gate} is reserved and cannot be executed` };
  }

  // Check assignments constraints
  if (step.assignments.allowedAgents && step.assignments.allowedAgents.length > 0) {
    return { reason: "step_unsupported", field: "assignments.allowedAgents", detail: "gate steps do not support allowedAgents" };
  }
  if (step.assignments.minimum !== 1 || step.assignments.target !== 1 || step.assignments.maximum !== 1) {
    return { reason: "step_unsupported", field: "assignments", detail: "gate steps require exactly 1 agent assignment" };
  }
  if (step.assignments.maxParallel !== 1) {
    return { reason: "step_unsupported", field: "assignments.maxParallel", detail: "gate steps require maxParallel of 1" };
  }
  if (step.assignments.maxAttemptsPerAssignment !== 1) {
    return { reason: "step_unsupported", field: "assignments.maxAttemptsPerAssignment", detail: "gate steps require maxAttemptsPerAssignment of 1" };
  }
  if (step.assignments.distinctBy && step.assignments.distinctBy.length > 0) {
    return { reason: "step_unsupported", field: "assignments.distinctBy", detail: "gate steps do not support distinctBy" };
  }
  if (step.assignments.maxWriteRepositories) {
    return { reason: "step_unsupported", field: "assignments.maxWriteRepositories", detail: "gate steps do not support maxWriteRepositories" };
  }

  // Check join constraints
  if (step.join.strategy !== "all") {
    return { reason: "step_unsupported", field: "join", detail: `gate steps require join strategy 'all', not '${step.join.strategy}'` };
  }
  if (step.join.minimumPassed !== undefined) {
    return { reason: "step_unsupported", field: "join", detail: "gate steps do not support minimumPassed" };
  }
  if (step.join.cancelRemaining) {
    return { reason: "step_unsupported", field: "join", detail: "gate steps do not support cancelRemaining" };
  }

  // Check required evidence constraints
  for (const evidence of step.requiredEvidence) {
    if (!evidence || !["gate", "artifact", "receipt", "assignment-result", "approval"].includes(evidence.kind)) {
      return { reason: "step_unsupported", field: "requiredEvidence", detail: `gate steps do not support evidence kind '${evidence?.kind}'` };
    }
  }

  // Check other constraints
  if (step.safeSpeculation) {
    return { reason: "step_unsupported", field: "safeSpeculation", detail: "gate steps do not support safeSpeculation" };
  }
  if (step.tools) {
    return { reason: "step_unsupported", field: "tools", detail: "gate steps do not support tools" };
  }
  if (step.secrets && step.secrets.length > 0) {
    return { reason: "step_unsupported", field: "secrets", detail: "gate steps do not support secrets" };
  }
  if (step.model) {
    return { reason: "step_unsupported", field: "model", detail: "gate steps do not support model" };
  }
  if (plan.reproOracle?.stageId === step.id) {
    return { reason: "step_unsupported", field: "reproOracle", detail: "gate steps cannot be repro oracle" };
  }
  if (plan.planHash?.stageId === step.id) {
    return { reason: "step_unsupported", field: "planHash", detail: "gate steps cannot be plan hash oracle" };
  }

  // Check timeout constraints
  if (step.timeoutMs !== undefined) {
    if (definition.kind === "artifacts-exist") {
      return { reason: "step_unsupported", field: "timeoutMs", detail: "artifacts-exist gates do not support timeoutMs" };
    }
    if (definition.kind === "command" && definition.timeoutMs !== undefined && step.timeoutMs < definition.timeoutMs) {
      return { reason: "step_unsupported", field: "timeoutMs", detail: "command step timeoutMs narrower than the registry timeout is refused" };
    }
  }

  // Check repositories constraints
  const repositories = step.repositories;
  if (!repositories || Object.keys(repositories).length === 0) {
    return { reason: "step_unsupported", field: "repositories", detail: "gate steps require repository declarations" };
  }

  if (definition.kind === "artifacts-exist") {
    const controlAccess = repositories.control;
    if (controlAccess !== "read" && controlAccess !== "write") {
      return { reason: "step_unsupported", field: "repositories", detail: "artifacts-exist gates require control repository access as read or write" };
    }
    for (const [repoId, access] of Object.entries(repositories)) {
      if (repoId !== "control" && access !== "none") {
        return { reason: "step_unsupported", field: "repositories", detail: "artifacts-exist gates require other repositories to have access 'none'" };
      }
    }
  } else if (definition.kind === "command") {
    for (const [repoId, access] of Object.entries(repositories)) {
      if (access !== "read" && access !== "write" && access !== "none") {
        return { reason: "step_unsupported", field: "repositories", detail: `invalid repository access '${access}' on ${repoId}` };
      }
    }
    const hasWrite = Object.values(repositories).some((access) => access === "write");
    if (!hasWrite) {
      return { reason: "step_unsupported", field: "repositories", detail: "command gates require at least one repository with write access" };
    }
  }

  // Check outcomes constraints
  const expectPass = step.expect === "pass";
  if (expectPass) {
    if (!step.outcomes.includes("passed")) {
      return { reason: "gate_outcome_undeclared", field: "outcomes", detail: "step expects pass but missing required outcome passed; spell it as 'passed'" };
    }
    if (!step.outcomes.includes("implementation-failure") && !step.outcomes.includes("failed")) {
      return { reason: "gate_outcome_undeclared", field: "outcomes", detail: "step expects pass but missing required failure outcome; declare implementation-failure or failed" };
    }
  } else {
    if (!step.outcomes.includes("repro-missing")) {
      return { reason: "gate_outcome_undeclared", field: "outcomes", detail: "step expects fail but missing required outcome repro-missing; spell it as 'repro-missing'" };
    }
    if (!step.outcomes.includes("implementation-failure") && !step.outcomes.includes("failed")) {
      return { reason: "gate_outcome_undeclared", field: "outcomes", detail: "step expects fail but missing required failure outcome; declare implementation-failure or failed" };
    }
  }

  // Check control root match
  if (context && projectRuntimeKey(context.projectRoot) !== envelope.gates.controlRoot.projectKey) {
    throw runtimeError("run_owner_mismatch", plan.workflowId, `gate control root does not match project`);
  }

  // Check expect constraint for artifacts-exist
  if (definition.kind === "artifacts-exist" && step.expect === "fail") {
    return { reason: "step_unsupported", field: "expect", detail: "artifacts-exist gates cannot expect fail" };
  }

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

export interface GateRecoveryPreflightResult {
  owned: number;
  blocking: Array<{ runId: string; attemptId: string }>;
}

export function gateRecoveryPreflight(context: VnextRuntimeContext): GateRecoveryPreflightResult {
  const attempts = context.eventStore.gateAttemptsForProject(context.projectId);
  const capabilities = context.eventStore.issuedOrRevokedCapabilities();
  const seenAttempts = new Set<string>();
  const blocking: Array<{ runId: string; attemptId: string }> = [];
  let owned = 0;

  for (const row of attempts) {
    seenAttempts.add(row.attemptId);
    const classified = classifyRecoverableGateAttempt(context, row, context.eventStore.capabilityByAttempt(row.attemptId));
    if (classified === "owned") owned += 1;
    else if (classified === "blocking") blocking.push({ runId: row.runId, attemptId: row.attemptId });
  }

  for (const capability of capabilities) {
    if (seenAttempts.has(capability.attemptId)) continue;
    const row = context.eventStore.gateAttempt(capability.attemptId);
    if (capability.producerId === "driver-simulated" || capability.producerId === "pi" || capability.producerId === "oneshot") {
      if (row) {
        throw runtimeError(
          "gate_recovery_corrupt",
          capability.attemptId,
          "gate recovery preflight: capability producer contradicts gate attempt",
        );
      }
      continue;
    }
    if (capability.producerId !== "kxm-gate") {
      throw runtimeError(
        "gate_recovery_corrupt",
        capability.attemptId,
        `gate recovery preflight: unknown capability producer ${capability.producerId}`,
      );
    }
    if (!row) {
      throw runtimeError("gate_recovery_corrupt", capability.attemptId, "gate recovery preflight: missing gate_attempts row");
    }
    const classified = classifyRecoverableGateAttempt(context, row, capability);
    if (classified === "owned") owned += 1;
    else if (classified === "blocking") blocking.push({ runId: row.runId, attemptId: row.attemptId });
  }

  return { owned, blocking };
}

function classifyRecoverableGateAttempt(
  context: VnextRuntimeContext,
  row: VnextGateAttemptRow,
  capability: VnextAttemptCapabilityRow | undefined,
): "excluded" | "owned" | "blocking" {
  if (row.producerId !== "kxm-gate") {
    throw runtimeError(
      "gate_recovery_corrupt",
      row.attemptId,
      "gate recovery preflight: capability producer contradicts gate attempt",
    );
  }
  if (capability && capability.producerId !== "kxm-gate") {
    throw runtimeError(
      "gate_recovery_corrupt",
      row.attemptId,
      "gate recovery preflight: capability producer contradicts gate attempt",
    );
  }
  if (
    capability
    && (
      row.runId !== capability.runId
      || row.assignmentId !== capability.assignmentId
      || row.stepId !== capability.stepId
      || row.stepAttempt !== capability.stepAttempt
      || row.attemptId !== capability.attemptId
    )
  ) {
    throw runtimeError("gate_recovery_corrupt", capability.attemptId, "gate recovery preflight: capability identity does not match gate attempt");
  }
  const run = context.eventStore.run(row.runId);
  if (!run) {
    throw runtimeError("gate_recovery_corrupt", row.runId, "gate recovery preflight: run does not exist");
  }
  if (run.projectId !== context.projectId || row.projectId !== context.projectId) {
    throw runtimeError("gate_recovery_corrupt", row.runId, "gate recovery preflight: run project mismatch");
  }
  let state;
  try {
    state = foldStoredVnextRun(context, run);
  } catch (error) {
    throw runtimeError(
      "gate_recovery_corrupt",
      row.runId,
      `gate recovery preflight: fold error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const observation = context.eventStore.gateObservationForAttempt(row.attemptId);
  const evidence = context.eventStore.gateEvidenceForAttempt(row.attemptId);
  const events = context.eventStore.events(row.runId, 0, 1_000_000);
  if (isExcludedTerminalProof(state, row, observation, evidence, events)) return "excluded";
  if (isEvaluatedSettledProof(row, observation, evidence)) {
    if (
      capability
      && (capability.state === "issued" || capability.state === "revoked")
      && state.currentStep?.attemptId === row.attemptId
      && state.currentStep.effectState === "settled"
    ) {
      throw runtimeError(
        "gate_recovery_corrupt",
        row.runId,
        "gate recovery preflight: capability remains issued or revoked after evaluated settlement",
      );
    }
    return "excluded";
  }
  if (
    !capability
    || capability.producerId !== "kxm-gate"
    || (capability.state !== "issued" && capability.state !== "revoked")
  ) {
    throw runtimeError(
      "gate_recovery_corrupt",
      row.attemptId,
      "gate recovery preflight: unfinished gate attempt is missing issued or revoked kxm-gate capability",
    );
  }
  const current = state.currentStep;
  const sameAttempt = current?.attemptId === row.attemptId
    && current.assignmentId === row.assignmentId
    && current.effectId === row.effectId
    && current.stepId === row.stepId;
  const controller = vnextAttemptController(context.eventStore.path, row.runId, row.attemptId);
  if (row.gateKind === "command") {
    const hold = vnextGateHold(context.eventStore.path, row.runId);
    const admittedToken = vnextAdmittedToken(context.eventStore.path, row.runId);
    if (hold && hold.attemptId !== row.attemptId) {
      throw runtimeError("gate_recovery_corrupt", row.attemptId, "gate recovery preflight: gate hold does not match the attempt");
    }
    if (hold && admittedToken !== undefined && hold.token !== admittedToken) {
      throw runtimeError("gate_recovery_corrupt", row.attemptId, "gate recovery preflight: gate hold token does not match admission");
    }
    if (hold?.state === "unsettled") return "blocking";
    const ownedCommand = run.homeRuntimeId === context.homeRuntimeId
      && sameAttempt
      && hold?.state === "active"
      && hold.attemptId === row.attemptId
      && hold.token === admittedToken
      && controller?.attemptId === row.attemptId
      && current?.effectState !== "blocked_uncertain";
    if (ownedCommand) return "owned";
    return "blocking";
  }
  const ownedHere = run.homeRuntimeId === context.homeRuntimeId
    && sameAttempt
    && controller?.attemptId === row.attemptId
    && current?.effectState !== "blocked_uncertain";
  if (ownedHere) return "owned";
  return "blocking";
}

function gateRowIdentityMatches(
  row: { attemptId: string; assignmentId: string; effectId: string; stepId: string; runId: string },
  other: { attemptId: string; assignmentId: string; effectId: string; stepId: string; runId: string },
): boolean {
  return other.attemptId === row.attemptId
    && other.assignmentId === row.assignmentId
    && other.effectId === row.effectId
    && other.stepId === row.stepId
    && other.runId === row.runId;
}

function isEvaluatedSettledProof(
  row: { attemptId: string; assignmentId: string; effectId: string; stepId: string; runId: string },
  observation: VnextGateObservationRow | undefined,
  evidence: VnextGateEvidenceRow | undefined,
): boolean {
  if (!evidence || !observation) return false;
  if (!gateRowIdentityMatches(row, observation) || !gateRowIdentityMatches(row, evidence)) return false;
  if (evidence.observationId !== observation.observationId) return false;
  return observation.completeness === "complete";
}

function proofOnlySettledEvent(
  events: readonly VnextRunEvent[],
  row: { attemptId: string; assignmentId: string; effectId: string; stepId: string; runId: string },
): VnextRunEvent | undefined {
  return events.find((event) => {
    if (event.eventType !== "effect.settled" || event.runId !== row.runId) return false;
    if (
      event.payload.attemptId !== row.attemptId
      || event.payload.assignmentId !== row.assignmentId
      || event.payload.effectId !== row.effectId
      || event.payload.stepId !== row.stepId
    ) {
      return false;
    }
    const refs = event.payload.evidenceRefs;
    return !Array.isArray(refs) || refs.length === 0;
  });
}

function isExcludedTerminalProof(
  state: VnextRunState,
  row: { attemptId: string; assignmentId: string; effectId: string; stepId: string; runId: string; stepAttempt?: number },
  observation: VnextGateObservationRow | undefined,
  evidence: VnextGateEvidenceRow | undefined,
  events: readonly VnextRunEvent[],
): boolean {
  if (evidence) return false;
  if (!observation) return false;
  if (!gateRowIdentityMatches(row, observation)) return false;
  if (observation.completeness === "incomplete") {
    if (state.status === "failed" || state.status === "cancelled") return true;
    const currentAttemptNumber = state.stepAttempts[row.stepId] ?? 0;
    if (row.stepAttempt !== undefined && currentAttemptNumber > row.stepAttempt) return true;
    if (state.pendingStepId !== undefined && (state.pendingStepId !== row.stepId || state.currentStep === undefined)) return true;
    return false;
  }
  if (observation.completeness !== "no-start" && observation.completeness !== "complete") return false;
  if (proofOnlySettledEvent(events, row)) {
    return observation.completeness === "no-start" || observation.completeness === "complete";
  }
  const current = state.currentStep;
  if (current) {
    if (
      current.attemptId !== row.attemptId
      || current.assignmentId !== row.assignmentId
      || current.effectId !== row.effectId
      || current.stepId !== row.stepId
      || current.effectState !== "settled-proof"
    ) {
      return false;
    }
    if (observation.completeness === "no-start" && current.observationCompleteness === "no-start") return true;
    return observation.completeness === "complete"
      && current.observationCompleteness === "complete"
      && current.status === "cancelled";
  }
  if (observation.completeness === "no-start" && (state.status === "failed" || state.status === "cancelled")) return true;
  return observation.completeness === "complete" && (state.status === "cancelled" || state.status === "failed");
}

function settlePreparedGate(
  context: VnextRuntimeContext,
  prepared: VnextPreparedGateDispatch,
  observation: VnextGateObservationInput,
) {
  const run = requireRun(context, prepared.run.runId);
  const folded = foldStoredVnextRun(context, run);
  const current = folded.currentStep;
  if (
    !current
    || current.stepId !== prepared.stepId
    || current.stepAttempt !== prepared.stepAttempt
    || current.assignmentId !== prepared.assignmentId
    || current.attemptId !== prepared.attemptId
    || current.effectId !== prepared.effectId
  ) {
    throw runtimeError("run_events_illegal", run.runId, "settlement identity does not match the prepared gate attempt");
  }
  const capability = context.eventStore.capabilityByAttempt(prepared.attemptId);
  if (
    !capability
    || capability.runId !== run.runId
    || capability.attemptId !== prepared.attemptId
    || capability.assignmentId !== prepared.assignmentId
    || capability.stepId !== prepared.stepId
    || capability.stepAttempt !== prepared.stepAttempt
    || capability.producerId !== "kxm-gate"
    || (capability.state !== "issued" && capability.state !== "revoked")
  ) {
    throw runtimeError("run_events_illegal", run.runId, "prepared gate capability is not the issued or revoked attempt");
  }
  const cancelled = folded.status === "cancelling" || capability.state === "revoked";
  if (observation.completeness !== "complete") {
    throw runtimeError("gate_row_invalid", run.runId, "gate settlement requires a complete observation");
  }
  const settled = cancelled
    ? recordGateCancelObservedInTransaction(context, run, prepared.envelope, prepared.stepId, observation)
    : recordGateSettlementInTransaction(context, run, prepared.envelope, prepared.stepId, observation);
  vnextGateDispatchSeams.afterObservationWrite?.(prepared);
  return settled;
}

function requireRun(context: VnextRuntimeContext, runId: string): VnextRunRecord {
  const run = context.eventStore.run(runId);
  if (!run) throw runtimeError("run_unknown", runId, "run does not exist in this event store");
  if (run.projectId !== context.projectId || run.homeRuntimeId !== context.homeRuntimeId) {
    throw runtimeError("run_owner_mismatch", runId, "run is not owned by this runtime context");
  }
  return run;
}

export interface VnextGateRecoveryRequest {
  action: "retry" | "fail" | "cancel" | "unblock";
  reason?: string;
  commandId?: string;
}

export function recoverVnextRun(
  context: VnextRuntimeContext,
  runId: string,
  request: VnextGateRecoveryRequest,
): { state: VnextRunState; unblocked: boolean } {
  return context.eventStore.transaction(() => {
    const run = requireRun(context, runId);
    let state = foldStoredVnextRun(context, run);

    if (state.status !== "blocked_uncertain" && state.status !== "cancelling" && state.currentStep?.effectState !== "blocked_uncertain") {
      throw runtimeError("run_events_illegal", runId, `run ${runId} is not in blocked_uncertain status`);
    }
    if (state.status === "cancelling" && state.currentStep?.effectState === "blocked_uncertain") {
      state = { ...state, status: "blocked_uncertain" };
    }

    const now = new Date().toISOString();
    let sequence = context.eventStore.nextSequence(runId);
    let mono = vnextMonotonicNs();
    const events: VnextRunEvent[] = [];
    const push = (eventType: string, payload: Record<string, unknown>): void => {
      events.push({
        ...vnextEventBase(context, run, now, mono, request.commandId),
        eventId: newVnextEventId(),
        eventType,
        sequence: sequence++,
        payload,
      });
      mono = vnextIncrementMonotonicNs(mono);
    };

    if (state.status === "running" && state.currentStep?.effectState === "blocked_uncertain") {
      push("run.status_changed", {
        status: "blocked_uncertain",
        previousStatus: "running",
        reason: request.reason ?? "uncertain gate effect",
      });
      for (const ev of events) context.eventStore.appendEvent(ev);
      events.length = 0;
      state = foldStoredVnextRun(context, run);
      context.eventStore.updateRunStatus(runId, "blocked_uncertain", now);
    }

    const attemptId = state.currentStep?.attemptId;
    if (attemptId) {
      resolveVnextGateHold(context.eventStore.path, runId, attemptId);
      unregisterVnextAttemptController(context.eventStore.path, runId, attemptId);
      const cap = context.eventStore.capabilityByAttempt(attemptId);
      if (cap && cap.state !== "settled") {
        context.eventStore.settleCapability(attemptId, "settled");
      }
    }

    if (request.action === "retry" || request.action === "unblock") {
      push("run.status_changed", {
        status: "running",
        previousStatus: "blocked_uncertain",
        reason: request.reason ?? "operator_retry",
      });
      for (const ev of events) context.eventStore.appendEvent(ev);
      const nextState = foldStoredVnextRun(context, run);
      persistVnextRunState(context, runId, nextState, events[events.length - 1]!.sequence);
      context.eventStore.updateRunStatus(runId, "running", now);
      return { state: nextState, unblocked: true };
    }

    if (request.action === "fail") {
      push("run.status_changed", {
        status: "failed",
        previousStatus: "blocked_uncertain",
        reason: request.reason ?? "operator_fail",
      });
      for (const ev of events) context.eventStore.appendEvent(ev);
      const nextState = foldStoredVnextRun(context, run);
      persistVnextRunState(context, runId, nextState, events[events.length - 1]!.sequence);
      context.eventStore.updateRunStatus(runId, "failed", now);
      return { state: nextState, unblocked: true };
    }

    if (request.action === "cancel") {
      push("run.cancel_requested", {
        actor: { kind: "runtime", id: context.homeRuntimeId },
        reason: request.reason ?? "operator_cancel",
      });
      push("run.status_changed", {
        status: "cancelling",
        previousStatus: "blocked_uncertain",
        reason: request.reason ?? "operator_cancel",
      });
      push("run.status_changed", {
        status: "cancelled",
        previousStatus: "cancelling",
        reason: request.reason ?? "operator_cancel",
      });
      for (const ev of events) context.eventStore.appendEvent(ev);
      const nextState = foldStoredVnextRun(context, run);
      persistVnextRunState(context, runId, nextState, events[events.length - 1]!.sequence);
      context.eventStore.updateRunStatus(runId, "cancelled", now);
      return { state: nextState, unblocked: true };
    }

    throw runtimeError("run_events_illegal", runId, `unsupported recovery action ${(request as { action: string }).action}`);
  });
}

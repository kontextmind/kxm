import { gateDefinitionHash } from "./gate-hash.ts";
import { mintKxmCapabilitySecret, kxmTransitionBudgetFailure } from "./engine.ts";
import type { KxmRunPlanEnvelope } from "./engine-plan.ts";
import { kxmCanonicalJson, type JsonValue } from "./project-config.ts";
import {
  foldStoredKxmRun,
  persistKxmRunState,
  kxmEventBase,
  kxmIncrementMonotonicNs,
  kxmMonotonicNs,
  type KxmRuntimeContext,
} from "./runtime-service.ts";
import {
  assertClosedGateObservation,
  computeGateEvidenceOutcome,
  gateRowContentHash,
  newKxmAssignmentId,
  newKxmAttemptId,
  newKxmEffectId,
  newKxmEventId,
  newKxmEvidenceId,
  newKxmObservationId,
  runtimeError,
  type KxmGateErrorClass,
  type KxmGateEvidenceOutcome,
  type KxmGateEvidenceRow,
  type KxmGateObservationRow,
  type KxmGateStopCause,
  type KxmRunEvent,
  type KxmRunRecord,
} from "./runtime-store.ts";

export interface KxmGateObservationInput {
  completeness: KxmGateObservationRow["completeness"];
  spawned: 0 | 1;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  exitObserved: 0 | 1;
  closeObserved: 0 | 1;
  stopCause: KxmGateStopCause;
  signalsAttempted: KxmGateObservationRow["signalsAttempted"];
  errorClass: KxmGateErrorClass | null;
  stdoutSha256: string | null;
  stdoutBytes: number | null;
  stdoutComplete: 0 | 1 | null;
  stderrSha256: string | null;
  stderrBytes: number | null;
  stderrComplete: 0 | 1 | null;
  checkedCount: number | null;
  failedCount: number | null;
  elapsedMs: number;
  startedAt: string;
  finishedAt: string | null;
}

export function recordGateIntent(context: KxmRuntimeContext, run: KxmRunRecord, envelope: KxmRunPlanEnvelope, stepId: string) {
  return context.eventStore.transaction(() => recordGateIntentInTransaction(context, run, envelope, stepId));
}

export function recordGateIntentInTransaction(context: KxmRuntimeContext, run: KxmRunRecord, envelope: KxmRunPlanEnvelope, stepId: string) {
  const step = requireGateStep(envelope, stepId, run.runId);
  const definition = envelope.gates.definitions[step.gate];
  if (!definition || definition.kind === "reserved") {
    throw runtimeError("gate_row_invalid", run.runId, "reserved gates cannot record intent in this slice");
  }
  const folded = foldStoredKxmRun(context, run);
  const used = folded.stepAttempts[stepId] ?? 0;
  const stepAttempt = used + 1;
  const assignmentId = newKxmAssignmentId();
  const attemptId = newKxmAttemptId();
  const effectId = newKxmEffectId();
  const minted = mintKxmCapabilitySecret();
  const now = new Date().toISOString();
  const seq = sequencer(context, run, now);
  seq.push("step.entered", { stepId, stepAttempt, status: "pending" });
  seq.push("step.status_changed", { stepId, status: "preparing", previousStatus: "pending" });
  seq.push("assignment.created", { assignmentId, stepId, stepAttempt, agentId: "coordinator", status: "created" });
  seq.push("assignment.accepted", { assignmentId, stepId, stepAttempt, attemptId, status: "accepted" });
  seq.push("attempt.created", { attemptId, assignmentId, stepId, stepAttempt, status: "created" });
  seq.push("assignment.dispatched", { assignmentId, stepId, stepAttempt, attemptId, capabilityHash: minted.hash, status: "dispatched" });
  seq.push("attempt.status_changed", { attemptId, assignmentId, stepId, stepAttempt, status: "starting" });
  seq.push("step.status_changed", { stepId, status: "running", previousStatus: "preparing" });
  const policyClass = definition.kind === "artifacts-exist" ? "read-only" : "unknown";
  const intent = seq.push("effect.intent_recorded", {
    effect: { id: effectId, policy: { class: policyClass, sharedMutable: false } },
    stepId,
    stepAttempt,
    assignmentId,
    attemptId,
  });
  for (const event of seq.events) context.eventStore.appendEvent(event);
  context.eventStore.insertCapability({
    attemptId,
    runId: run.runId,
    assignmentId,
    stepId,
    stepAttempt,
    producerId: "kxm-gate",
    capabilityHash: minted.hash,
    state: "issued",
  });
  const attemptRow = {
    attemptId,
    runId: run.runId,
    projectId: run.projectId,
    homeRuntimeId: run.homeRuntimeId,
    stepId,
    stepAttempt,
    assignmentId,
    effectId,
    gateId: step.gate,
    gateKind: definition.kind,
    expect: step.expect,
    gateDefinitionHash: gateDefinitionHash(step.gate, definition as unknown as JsonValue),
    registryHash: envelope.gates.registry!.hash,
    runPlanHash: envelope && folded.runPlanHash ? folded.runPlanHash : hashFromStore(context, run.runId),
    controlProjectKey: envelope.gates.controlRoot.projectKey,
    producerId: "kxm-gate" as const,
    intentEventId: intent.eventId,
    contentHash: "",
  };
  attemptRow.runPlanHash = context.eventStore.runPlan(run.runId)!.runPlanHash;
  const withHash = { ...attemptRow, contentHash: gateRowContentHash("gate_attempts", { ...attemptRow, contentHash: "" }) };
  context.eventStore.insertGateAttempt(withHash);
  return persist(context, run, now, seq.events.at(-1)!.sequence);
}

export function recordGateSpawned(context: KxmRuntimeContext, run: KxmRunRecord, envelope: KxmRunPlanEnvelope, stepId: string) {
  return context.eventStore.transaction(() => recordGateSpawnedInTransaction(context, run, envelope, stepId));
}

export function recordGateSpawnedInTransaction(context: KxmRuntimeContext, run: KxmRunRecord, envelope: KxmRunPlanEnvelope, stepId: string) {
  const ids = requireIntent(context, run, envelope, stepId);
  if (ids.gateKind !== "command") throw runtimeError("gate_row_invalid", run.runId, "effect.dispatched is command-only");
  const now = new Date().toISOString();
  const seq = sequencer(context, run, now);
  seq.push("assignment.executing", { assignmentId: ids.assignmentId, stepId, stepAttempt: ids.stepAttempt, attemptId: ids.attemptId, status: "executing" });
  seq.push("attempt.status_changed", { attemptId: ids.attemptId, assignmentId: ids.assignmentId, stepId, stepAttempt: ids.stepAttempt, status: "executing" });
  seq.push("effect.dispatched", {
    effect: { id: ids.effectId, policy: { class: "unknown", sharedMutable: false } },
    stepId,
    stepAttempt: ids.stepAttempt,
    assignmentId: ids.assignmentId,
    attemptId: ids.attemptId,
  });
  for (const event of seq.events) context.eventStore.appendEvent(event);
  return persist(context, run, now, seq.events.at(-1)!.sequence);
}

export function recordGateSettlement(
  context: KxmRuntimeContext,
  run: KxmRunRecord,
  envelope: KxmRunPlanEnvelope,
  stepId: string,
  observation: KxmGateObservationInput,
) {
  return context.eventStore.transaction(() => recordGateSettlementInTransaction(context, run, envelope, stepId, observation));
}

export function recordGateSettlementInTransaction(
  context: KxmRuntimeContext,
  run: KxmRunRecord,
  envelope: KxmRunPlanEnvelope,
  stepId: string,
  observation: KxmGateObservationInput,
) {
  const ids = requireIntent(context, run, envelope, stepId);
  assertClosedGateObservation(ids.gateKind, observation);
  const outcome = computeGateEvidenceOutcome(ids.gateKind, ids.expect, observation);
  const now = new Date().toISOString();
  const seq = sequencer(context, run, now);
  if (ids.gateKind === "artifacts-exist") {
    seq.push("assignment.executing", { assignmentId: ids.assignmentId, stepId, stepAttempt: ids.stepAttempt, attemptId: ids.attemptId, status: "executing" });
    seq.push("attempt.status_changed", { attemptId: ids.attemptId, assignmentId: ids.assignmentId, stepId, stepAttempt: ids.stepAttempt, status: "executing" });
    seq.push("effect.dispatched", {
      effect: { id: ids.effectId, policy: { class: "read-only", sharedMutable: false } },
      stepId,
      stepAttempt: ids.stepAttempt,
      assignmentId: ids.assignmentId,
      attemptId: ids.attemptId,
    });
  }
  seq.push("attempt.status_changed", { attemptId: ids.attemptId, assignmentId: ids.assignmentId, stepId, stepAttempt: ids.stepAttempt, status: "settling" });
  const observationId = newKxmObservationId();
  const observed = seq.push("effect.observed", {
    effect: { id: ids.effectId, policy: { class: ids.gateKind === "artifacts-exist" ? "read-only" : "unknown", sharedMutable: false } },
    stepId,
    stepAttempt: ids.stepAttempt,
    assignmentId: ids.assignmentId,
    attemptId: ids.attemptId,
    receipt: placeholderReceipt(observationId, ids.gateKind, now),
  });
  const observationRow = buildObservation(ids, observation, observationId, observed.eventId);
  patchReceipt(observed, observationRow);
  const evidenceId = newKxmEvidenceId();
  const evidenceDraft: KxmGateEvidenceRow = {
    evidenceId,
    attemptId: ids.attemptId,
    observationId,
    runId: run.runId,
    projectId: run.projectId,
    homeRuntimeId: run.homeRuntimeId,
    stepId,
    stepAttempt: ids.stepAttempt,
    assignmentId: ids.assignmentId,
    effectId: ids.effectId,
    evidenceKey: evidenceKeyFor(envelope, stepId),
    kind: "gate",
    expect: ids.expect,
    outcome,
    settledEventId: "evt_pending00000000000000000000000",
    contentHash: "",
  };
  const settled = seq.push("effect.settled", {
    effect: { id: ids.effectId, policy: { class: ids.gateKind === "artifacts-exist" ? "read-only" : "unknown", sharedMutable: false } },
    stepId,
    stepAttempt: ids.stepAttempt,
    assignmentId: ids.assignmentId,
    attemptId: ids.attemptId,
    outcome,
    evidenceRefs: [{ id: evidenceId, kind: "gate", hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", status: "settled" }],
  });
  evidenceDraft.settledEventId = settled.eventId;
  evidenceDraft.contentHash = gateRowContentHash("gate_evidence", { ...evidenceDraft, contentHash: "" });
  (settled.payload.evidenceRefs as Array<{ hash: string }>)[0]!.hash = evidenceDraft.contentHash;
  appendEvaluatedTail(seq, envelope, ids, stepId, outcome);
  for (const event of seq.events) context.eventStore.appendEvent(event);
  context.eventStore.insertGateObservation(observationRow);
  context.eventStore.insertGateEvidence(evidenceDraft);
  context.eventStore.settleCapability(ids.attemptId, "settled");
  return persist(context, run, now, seq.events.at(-1)!.sequence);
}

export function recordGateNoStart(
  context: KxmRuntimeContext,
  run: KxmRunRecord,
  envelope: KxmRunPlanEnvelope,
  stepId: string,
  observation: KxmGateObservationInput,
) {
  return context.eventStore.transaction(() => recordGateNoStartInTransaction(context, run, envelope, stepId, observation));
}

export function recordGateNoStartInTransaction(
  context: KxmRuntimeContext,
  run: KxmRunRecord,
  envelope: KxmRunPlanEnvelope,
  stepId: string,
  observation: KxmGateObservationInput,
) {
  const ids = requireIntent(context, run, envelope, stepId);
  assertClosedGateObservation(ids.gateKind, observation);
  if (observation.completeness !== "no-start") {
    throw runtimeError("gate_row_invalid", run.runId, "no-start proof requires spawned 0 and completeness no-start");
  }
  const cancelled = observation.stopCause === "cancel";
  const now = new Date().toISOString();
  const seq = sequencer(context, run, now);
  const cancelReason = cancelled ? ensureOperatorCancel(seq, ids.state, run, context) : undefined;
  const observationId = newKxmObservationId();
  const observed = seq.push("effect.observed", {
    effect: { id: ids.effectId, policy: { class: ids.gateKind === "artifacts-exist" ? "read-only" : "unknown", sharedMutable: false } },
    stepId,
    stepAttempt: ids.stepAttempt,
    assignmentId: ids.assignmentId,
    attemptId: ids.attemptId,
    receipt: placeholderReceipt(observationId, ids.gateKind, now),
  });
  const observationRow = buildObservation(ids, observation, observationId, observed.eventId);
  patchReceipt(observed, observationRow);
  seq.push("attempt.status_changed", { attemptId: ids.attemptId, assignmentId: ids.assignmentId, stepId, stepAttempt: ids.stepAttempt, status: "settling" });
  seq.push("effect.settled", {
    effect: { id: ids.effectId, policy: { class: ids.gateKind === "artifacts-exist" ? "read-only" : "unknown", sharedMutable: false } },
    stepId,
    stepAttempt: ids.stepAttempt,
    assignmentId: ids.assignmentId,
    attemptId: ids.attemptId,
    receipt: {
      provider: "kxm-gate",
      kind: ids.gateKind,
      id: observationId,
      hash: observationRow.contentHash,
      observedAt: now,
    },
  });
  if (cancelled) {
    seq.push("assignment.result_recorded", { assignmentId: ids.assignmentId, resultClass: "cancelled", status: "result_recorded" });
    seq.push("attempt.status_changed", { attemptId: ids.attemptId, status: "terminal" });
    seq.push("assignment.terminal", { assignmentId: ids.assignmentId, outcome: "cancelled", status: "terminal" });
    seq.push("step.status_changed", { stepId, status: "cancelled", previousStatus: "running" });
    seq.push("run.status_changed", { status: "cancelled", reason: cancelReason ?? "operator_cancel", stepId });
  } else {
    seq.push("assignment.result_recorded", { assignmentId: ids.assignmentId, resultClass: "producer_rejected", status: "result_recorded" });
    seq.push("attempt.status_changed", { attemptId: ids.attemptId, status: "terminal" });
    seq.push("assignment.terminal", { assignmentId: ids.assignmentId, outcome: "failed", status: "terminal" });
    seq.push("step.status_changed", { stepId, status: "failed", previousStatus: "running" });
    seq.push("run.status_changed", { status: "failed", reason: "gate_start_failed", stepId });
  }
  for (const event of seq.events) context.eventStore.appendEvent(event);
  context.eventStore.insertGateObservation(observationRow);
  context.eventStore.settleCapability(ids.attemptId, "settled");
  return persist(context, run, now, seq.events.at(-1)!.sequence);
}

export function recordGateUncertain(
  context: KxmRuntimeContext,
  run: KxmRunRecord,
  envelope: KxmRunPlanEnvelope,
  stepId: string,
  reason: string,
  observation: KxmGateObservationInput,
) {
  return context.eventStore.transaction(() => recordGateUncertainInTransaction(context, run, envelope, stepId, reason, observation));
}

export function recordGateUncertainInTransaction(
  context: KxmRuntimeContext,
  run: KxmRunRecord,
  envelope: KxmRunPlanEnvelope,
  stepId: string,
  reason: string,
  observation: KxmGateObservationInput,
) {
  const ids = requireIntent(context, run, envelope, stepId);
  if (observation.completeness !== "incomplete") {
    throw runtimeError("gate_row_invalid", run.runId, "uncertainty observation must be incomplete");
  }
  const effectState = ids.state.currentStep?.effectState;
  if (
    effectState === "observed-complete"
    || effectState === "observed-no-start"
    || effectState === "observed-unknown"
    || effectState === "settled"
    || effectState === "settled-proof"
  ) {
    throw runtimeError("run_events_illegal", run.runId, "blocked_uncertain after an observation is illegal");
  }
  if (context.eventStore.gateObservationForAttempt(ids.attemptId)) {
    throw runtimeError("run_events_illegal", run.runId, "a completed observation cannot be rewritten");
  }
  const now = new Date().toISOString();
  const seq = sequencer(context, run, now);
  const observationId = newKxmObservationId();
  const blocked = seq.push("effect.blocked_uncertain", {
    effect: { id: ids.effectId, policy: { class: ids.gateKind === "artifacts-exist" ? "read-only" : "unknown", sharedMutable: false } },
    stepId,
    stepAttempt: ids.stepAttempt,
    assignmentId: ids.assignmentId,
    attemptId: ids.attemptId,
    reason,
    receipt: placeholderReceipt(observationId, ids.gateKind, now),
  });
  const observationRow = buildObservation(ids, observation, observationId, blocked.eventId);
  patchReceipt(blocked, observationRow);
  for (const event of seq.events) context.eventStore.appendEvent(event);
  context.eventStore.insertGateObservation(observationRow);
  return persist(context, run, now, seq.events.at(-1)!.sequence);
}

export function recordGateCancelObserved(
  context: KxmRuntimeContext,
  run: KxmRunRecord,
  envelope: KxmRunPlanEnvelope,
  stepId: string,
  observation: KxmGateObservationInput,
) {
  return context.eventStore.transaction(() => recordGateCancelObservedInTransaction(context, run, envelope, stepId, observation));
}

export function recordGateCancelObservedInTransaction(
  context: KxmRuntimeContext,
  run: KxmRunRecord,
  envelope: KxmRunPlanEnvelope,
  stepId: string,
  observation: KxmGateObservationInput,
) {
  const ids = requireIntent(context, run, envelope, stepId);
  assertClosedGateObservation(ids.gateKind, observation);
  if (observation.completeness !== "complete") {
    throw runtimeError("gate_row_invalid", run.runId, "cancel-after-observation requires a complete observation");
  }
  if (ids.gateKind === "command" && ids.state.currentStep?.effectState !== "dispatched") {
    throw runtimeError("run_events_illegal", run.runId, "complete command observations require effect.dispatched");
  }
  const now = new Date().toISOString();
  const seq = sequencer(context, run, now);
  const cancelReason = ensureOperatorCancel(seq, ids.state, run, context);
  if (ids.gateKind === "artifacts-exist") {
    seq.push("assignment.executing", { assignmentId: ids.assignmentId, stepId, stepAttempt: ids.stepAttempt, attemptId: ids.attemptId, status: "executing" });
    seq.push("attempt.status_changed", { attemptId: ids.attemptId, assignmentId: ids.assignmentId, stepId, stepAttempt: ids.stepAttempt, status: "executing" });
    seq.push("effect.dispatched", {
      effect: { id: ids.effectId, policy: { class: "read-only", sharedMutable: false } },
      stepId,
      stepAttempt: ids.stepAttempt,
      assignmentId: ids.assignmentId,
      attemptId: ids.attemptId,
    });
  }
  seq.push("attempt.status_changed", { attemptId: ids.attemptId, assignmentId: ids.assignmentId, stepId, stepAttempt: ids.stepAttempt, status: "settling" });
  const observationId = newKxmObservationId();
  const policyClass = ids.gateKind === "artifacts-exist" ? "read-only" : "unknown";
  const observed = seq.push("effect.observed", {
    effect: { id: ids.effectId, policy: { class: policyClass, sharedMutable: false } },
    stepId,
    stepAttempt: ids.stepAttempt,
    assignmentId: ids.assignmentId,
    attemptId: ids.attemptId,
    receipt: placeholderReceipt(observationId, ids.gateKind, now),
  });
  const observationRow = buildObservation(ids, observation, observationId, observed.eventId);
  patchReceipt(observed, observationRow);
  seq.push("effect.settled", {
    effect: { id: ids.effectId, policy: { class: policyClass, sharedMutable: false } },
    stepId,
    stepAttempt: ids.stepAttempt,
    assignmentId: ids.assignmentId,
    attemptId: ids.attemptId,
    receipt: {
      provider: "kxm-gate",
      kind: ids.gateKind,
      id: observationId,
      hash: observationRow.contentHash,
      observedAt: now,
    },
  });
  seq.push("assignment.result_recorded", { assignmentId: ids.assignmentId, resultClass: "cancelled", status: "result_recorded" });
  seq.push("attempt.status_changed", { attemptId: ids.attemptId, status: "terminal" });
  seq.push("assignment.terminal", { assignmentId: ids.assignmentId, outcome: "cancelled", status: "terminal" });
  seq.push("step.status_changed", { stepId, status: "cancelled", previousStatus: "running" });
  seq.push("run.status_changed", { status: "cancelled", reason: cancelReason, stepId });
  for (const event of seq.events) context.eventStore.appendEvent(event);
  context.eventStore.insertGateObservation(observationRow);
  context.eventStore.settleCapability(ids.attemptId, "settled");
  return persist(context, run, now, seq.events.at(-1)!.sequence);
}

function appendEvaluatedTail(
  seq: ReturnType<typeof sequencer>,
  envelope: KxmRunPlanEnvelope,
  ids: ReturnType<typeof requireIntent>,
  stepId: string,
  outcome: KxmGateEvidenceOutcome,
) {
  const mapped = outcome === "passed" ? "passed" : outcome === "repro-missing" ? "failed" : "failed";
  seq.push("assignment.result_recorded", { assignmentId: ids.assignmentId, resultClass: "outcome", outcome, status: "result_recorded" });
  seq.push("attempt.status_changed", { attemptId: ids.attemptId, status: "terminal" });
  seq.push("assignment.terminal", { assignmentId: ids.assignmentId, outcome, status: "terminal" });
  seq.push("step.outcome_recorded", { stepId, stepAttempt: ids.stepAttempt, outcome });
  seq.push("step.status_changed", { stepId, status: mapped, previousStatus: "running" });
  const selected = envelope.plan.steps[stepId]!.transitions[outcome];
  if (!selected) {
    seq.push("run.status_changed", { status: "failed", reason: "outcome_unknown", stepId, outcome });
    return;
  }
  const budget = kxmTransitionBudgetFailure(envelope.plan, ids.state, stepId, outcome);
  if (budget) {
    seq.push("run.status_changed", { status: "failed", reason: budget, stepId, outcome });
    return;
  }
  if (selected.to === "step") {
    seq.push("step.transitioned", { fromStepId: stepId, toStepId: selected.target, outcome });
  } else {
    seq.push("step.transitioned", { fromStepId: stepId, status: selected.terminalStatus, outcome });
    seq.push("run.status_changed", { status: selected.terminalStatus });
  }
}

function evidenceKeyFor(envelope: KxmRunPlanEnvelope, stepId: string): string | null {
  const required = envelope.plan.steps[stepId]?.requiredEvidence.filter((item) => item.kind === "gate") ?? [];
  return required.length === 1 ? required[0]!.key : null;
}

function placeholderReceipt(observationId: string, kind: string, now: string) {
  return {
    provider: "kxm-gate",
    kind,
    id: observationId,
    hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    observedAt: now,
  };
}

function patchReceipt(event: KxmRunEvent, row: KxmGateObservationRow): void {
  const receipt = event.payload.receipt as { hash: string };
  receipt.hash = row.contentHash;
}

function buildObservation(
  ids: ReturnType<typeof requireIntent>,
  observation: KxmGateObservationInput,
  observationId: string,
  recordedEventId: string,
): KxmGateObservationRow {
  const row: KxmGateObservationRow = {
    observationId,
    attemptId: ids.attemptId,
    runId: ids.runId,
    projectId: ids.projectId,
    homeRuntimeId: ids.homeRuntimeId,
    stepId: ids.stepId,
    stepAttempt: ids.stepAttempt,
    assignmentId: ids.assignmentId,
    effectId: ids.effectId,
    ...observation,
    recordedEventId,
    contentHash: "",
  };
  return { ...row, contentHash: gateRowContentHash("gate_observations", { ...row, contentHash: "" }) };
}

function requireGateStep(envelope: KxmRunPlanEnvelope, stepId: string, runId: string) {
  const step = envelope.plan.steps[stepId];
  if (!step || step.kind !== "gate") throw runtimeError("run_events_illegal", runId, `step ${stepId} is not a gate`);
  return step;
}

function requireIntent(context: KxmRuntimeContext, run: KxmRunRecord, envelope: KxmRunPlanEnvelope, stepId: string) {
  const step = requireGateStep(envelope, stepId, run.runId);
  const folded = foldStoredKxmRun(context, run);
  const attemptId = folded.currentStep?.attemptId;
  if (!attemptId || folded.currentStep?.stepId !== stepId) {
    throw runtimeError("run_events_illegal", run.runId, "gate intent has not been recorded");
  }
  const row = context.eventStore.gateAttempt(attemptId);
  if (!row) throw runtimeError("gate_row_invalid", run.runId, "missing gate attempt");
  return {
    ...row,
    gateKind: row.gateKind,
    expect: step.expect,
    state: folded,
  };
}

function ensureOperatorCancel(
  seq: ReturnType<typeof sequencer>,
  state: ReturnType<typeof foldStoredKxmRun>,
  run: KxmRunRecord,
  context: KxmRuntimeContext,
): string {
  if (state.status === "cancelling") return cancelReasonFromLog(context, run.runId);
  if (state.status !== "running") {
    throw runtimeError("run_events_illegal", run.runId, "cancelled gate proof requires a running or cancelling run");
  }
  seq.push("run.cancel_requested", {
    actor: { kind: "runtime", id: run.homeRuntimeId },
    reason: "operator_cancel",
  });
  seq.push("run.status_changed", { status: "cancelling", reason: "operator_cancel" });
  return "operator_cancel";
}

function cancelReasonFromLog(context: KxmRuntimeContext, runId: string): string {
  const events = context.eventStore.events(runId, 0, 1_000_000);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.eventType === "run.cancel_requested" && typeof event.payload.reason === "string") {
      return event.payload.reason;
    }
  }
  return "operator_cancel";
}

function sequencer(context: KxmRuntimeContext, run: KxmRunRecord, now: string) {
  let sequence = context.eventStore.nextSequence(run.runId);
  let mono = kxmMonotonicNs();
  const events: KxmRunEvent[] = [];
  return {
    events,
    push(eventType: string, payload: Record<string, unknown>): KxmRunEvent {
      const event: KxmRunEvent = {
        ...kxmEventBase(context, run, now, mono),
        eventId: newKxmEventId(),
        eventType,
        sequence: sequence++,
        payload,
      };
      mono = kxmIncrementMonotonicNs(mono);
      events.push(event);
      return event;
    },
  };
}

function persist(context: KxmRuntimeContext, run: KxmRunRecord, now: string, lastSequence: number) {
  const next = foldStoredKxmRun(context, run);
  persistKxmRunState(context, run.runId, next, lastSequence);
  context.eventStore.updateRunStatus(run.runId, next.status, now);
  return { state: next, run: { ...run, status: next.status, updatedAt: now } };
}

function hashFromStore(context: KxmRuntimeContext, runId: string): string {
  return context.eventStore.runPlan(runId)!.runPlanHash;
}

void kxmCanonicalJson;

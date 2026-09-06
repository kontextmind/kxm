import type { VnextCompiledPlan, VnextCompiledStep, VnextCompiledTransition, VnextTerminalStatus } from "./vnext-engine-compile.ts";
import {
  runtimeError,
  type VnextRunEvent,
  type VnextRunRecord,
  type VnextRunStatus,
} from "./vnext-runtime-store.ts";

export const VNEXT_RUN_STATE_SCHEMA = "kxm.run-state.v1";

const RUN_STATUSES = new Set<VnextRunStatus>(["created", "preparing", "running", "waiting", "blocked_uncertain", "cancelling", "cancelled", "completed", "failed"]);
const TERMINAL_RUN = new Set<VnextRunStatus>(["cancelled", "completed", "failed"]);
const STEP_STATUSES = new Set(["pending", "preparing", "running", "passed", "failed", "cancelled"]);
const ASSIGNMENT_STATUSES = new Set(["created", "accepted", "dispatched", "executing", "result_recorded", "terminal"]);
const ATTEMPT_STATUSES = new Set(["created", "starting", "executing", "settling", "terminal"]);
const RESULT_CLASSES = new Set(["outcome", "outcome_unknown", "producer_rejected", "cancelled"]);
const SLICE_BLOCKED_RUN = new Set<VnextRunStatus>(["waiting", "blocked_uncertain"]);
const RUN_EDGES: Readonly<Record<string, ReadonlySet<VnextRunStatus>>> = {
  created: new Set(["preparing", "cancelled", "failed"]),
  preparing: new Set(["running", "cancelled", "failed"]),
  running: new Set(["cancelling", "cancelled", "completed", "failed"]),
  waiting: new Set(["running", "blocked_uncertain", "cancelling", "completed", "failed", "cancelled"]),
  blocked_uncertain: new Set(["running", "cancelling", "failed"]),
  cancelling: new Set(["cancelled", "failed"]),
  cancelled: new Set(),
  completed: new Set(),
  failed: new Set(),
};
const STEP_EDGES: Readonly<Record<string, ReadonlySet<string>>> = {
  pending: new Set(["preparing"]),
  preparing: new Set(["running"]),
  running: new Set(["passed", "failed", "cancelled"]),
};
const ASSIGNMENT_EDGES: Readonly<Record<string, ReadonlySet<string>>> = {
  created: new Set(["accepted"]),
  accepted: new Set(["dispatched"]),
  dispatched: new Set(["executing"]),
  executing: new Set(["result_recorded"]),
  result_recorded: new Set(["terminal"]),
};
const ATTEMPT_EDGES: Readonly<Record<string, ReadonlySet<string>>> = {
  created: new Set(["starting"]),
  starting: new Set(["executing"]),
  executing: new Set(["settling"]),
  settling: new Set(["terminal"]),
};

export interface VnextRunCurrentStep {
  readonly stepId: string;
  readonly stepAttempt: number;
  readonly status: string;
  readonly assignmentId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly assignmentStatus?: string | undefined;
  readonly attemptStatus?: string | undefined;
  readonly outcome?: string | undefined;
}

export interface VnextRunState {
  readonly schema: typeof VNEXT_RUN_STATE_SCHEMA;
  readonly runId: string;
  readonly status: VnextRunStatus;
  readonly runPlanHash?: string | undefined;
  readonly pendingStepId?: string | undefined;
  readonly currentStep?: VnextRunCurrentStep | undefined;
  readonly stepAttempts: Readonly<Record<string, number>>;
  readonly edgeTransitions: Readonly<Record<string, number>>;
  readonly transitionsUsed: number;
  readonly cancelRequested: boolean;
  readonly terminalReason?: string | undefined;
}

interface MutableState {
  schema: typeof VNEXT_RUN_STATE_SCHEMA;
  runId: string;
  status: VnextRunStatus;
  runPlanHash?: string | undefined;
  pendingStepId?: string | undefined;
  currentStep?: {
    stepId: string;
    stepAttempt: number;
    status: string;
    assignmentId?: string | undefined;
    attemptId?: string | undefined;
    assignmentStatus?: string | undefined;
    attemptStatus?: string | undefined;
    outcome?: string | undefined;
  } | undefined;
  stepAttempts: Record<string, number>;
  edgeTransitions: Record<string, number>;
  transitionsUsed: number;
  cancelRequested: boolean;
  terminalReason?: string | undefined;
  terminalEventSeen: boolean;
  lastOutcomeEvent?: { stepId: string; stepAttempt: number; outcome: string } | undefined;
  awaitingTransition: boolean;
  cancelCommandId?: string | undefined;
  recordedOutcome?: string | undefined;
  recordedResultClass?: string | undefined;
  lastTerminalTransition?: VnextTerminalStatus | undefined;
}

export function foldVnextRunState(
  run: VnextRunRecord,
  plan: VnextCompiledPlan | undefined,
  events: readonly VnextRunEvent[],
): VnextRunState {
  if (events.length === 0) {
    throw runtimeError("run_events_illegal", run.runId, "run has no events");
  }
  const state: MutableState = {
    schema: VNEXT_RUN_STATE_SCHEMA,
    runId: run.runId,
    status: "created",
    stepAttempts: Object.create(null) as Record<string, number>,
    edgeTransitions: Object.create(null) as Record<string, number>,
    transitionsUsed: 0,
    cancelRequested: false,
    terminalEventSeen: false,
    awaitingTransition: false,
  };

  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1) {
      throw runtimeError("run_events_illegal", run.runId, `event sequence is not contiguous at ${event.sequence}`);
    }
    assertEventIdentity(run, event);
    if (state.terminalEventSeen) {
      throw runtimeError("run_events_illegal", run.runId, "no events are allowed after a terminal run status");
    }
    if (index === 0 && event.eventType !== "run.created") {
      throw runtimeError("run_events_illegal", run.runId, "first event must be run.created");
    }
    if (state.lastTerminalTransition !== undefined) {
      if (event.eventType !== "run.status_changed" || event.payload.status !== state.lastTerminalTransition) {
        throw runtimeError("run_events_illegal", run.runId, "terminal transition must be followed by the matching run.status_changed");
      }
    }
    if (
      (event.eventType.startsWith("step.") || event.eventType.startsWith("assignment.") || event.eventType.startsWith("attempt."))
      && !plan
    ) {
      throw runtimeError("run_plan_missing", run.runId, "step events require a pinned run plan");
    }
    switch (event.eventType) {
      case "run.created":
        foldRunCreated(state, run, event, index);
        break;
      case "run.status_changed":
        foldRunStatus(state, plan, event);
        break;
      case "run.cancel_requested":
        foldCancelRequested(state, event);
        break;
      case "step.entered":
        foldStepEntered(state, plan!, event);
        break;
      case "step.status_changed":
        foldStepStatus(state, event);
        break;
      case "step.outcome_recorded":
        foldOutcome(state, plan!, event);
        break;
      case "step.transitioned":
        foldTransitioned(state, plan!, event);
        break;
      case "assignment.created":
        foldAssignmentCreated(state, event);
        break;
      case "assignment.accepted":
        foldAssignmentAdvance(state, plan!, event, "accepted");
        break;
      case "assignment.dispatched":
        foldAssignmentAdvance(state, plan!, event, "dispatched");
        break;
      case "assignment.executing":
        foldAssignmentAdvance(state, plan!, event, "executing");
        break;
      case "assignment.result_recorded":
        foldAssignmentAdvance(state, plan!, event, "result_recorded");
        break;
      case "assignment.terminal":
        foldAssignmentAdvance(state, plan!, event, "terminal");
        break;
      case "attempt.created":
        foldAttemptCreated(state, event);
        break;
      case "attempt.status_changed":
        foldAttemptStatus(state, event);
        break;
      default:
        throw runtimeError("run_events_illegal", run.runId, `event type ${event.eventType} is not legal in this engine slice`);
    }
  }

  if ((state.status === "preparing" || state.status === "running" || state.status === "cancelling") && !plan) {
    throw runtimeError("run_plan_missing", run.runId, `status ${state.status} requires a pinned run plan`);
  }
  return freezeState(state);
}

function assertEventIdentity(run: VnextRunRecord, event: VnextRunEvent): void {
  if (event.schema !== "kxm.run-event.v1") {
    throw runtimeError("run_events_illegal", run.runId, "event schema is not kxm.run-event.v1");
  }
  if (event.runId !== run.runId || event.projectId !== run.projectId || event.homeRuntimeId !== run.homeRuntimeId) {
    throw runtimeError("run_event_owner_mismatch", run.runId, "event identity does not match the run");
  }
  if (
    event.configRevision !== run.configRevision
    || event.memoryRevision !== run.memoryRevision
    || event.executorPolicyRevision !== run.executorPolicyRevision
    || event.toolPolicyRevision !== run.toolPolicyRevision
  ) {
    throw runtimeError("run_event_owner_mismatch", run.runId, "event revisions do not match the run");
  }
}

function foldRunCreated(state: MutableState, run: VnextRunRecord, event: VnextRunEvent, index: number): void {
  if (index !== 0 || event.sequence !== 1) {
    throw runtimeError("run_events_illegal", state.runId, "run.created is only legal at sequence 1");
  }
  if (event.payload.status !== "created") {
    throw runtimeError("run_events_illegal", state.runId, "run.created payload status must be created");
  }
  if (event.payload.workflowId !== run.workflowId) {
    throw runtimeError("run_events_illegal", state.runId, "run.created workflowId does not match the run");
  }
  state.status = "created";
}

function foldRunStatus(state: MutableState, plan: VnextCompiledPlan | undefined, event: VnextRunEvent): void {
  const next = event.payload.status;
  if (typeof next !== "string" || !RUN_STATUSES.has(next as VnextRunStatus)) {
    throw runtimeError("run_events_illegal", state.runId, `run.status_changed has invalid status ${String(next)}`);
  }
  const status = next as VnextRunStatus;
  if (SLICE_BLOCKED_RUN.has(status)) {
    throw runtimeError("run_events_illegal", state.runId, `event type ${event.eventType} is not legal in this engine slice`);
  }
  const allowed = RUN_EDGES[state.status];
  if (!allowed?.has(status)) {
    throw runtimeError("run_events_illegal", state.runId, `illegal run transition ${state.status} -> ${status}`);
  }
  if (status === "cancelling") {
    if (!state.cancelRequested) {
      throw runtimeError("run_events_illegal", state.runId, "cancelling requires run.cancel_requested");
    }
  }
  if (status === "preparing") {
    const hash = event.payload.runPlanHash;
    if (typeof hash !== "string") {
      throw runtimeError("run_events_illegal", state.runId, "preparing requires runPlanHash");
    }
    state.runPlanHash = hash;
  }
  if ((status === "running" || status === "cancelling") && !plan) {
    throw runtimeError("run_plan_missing", state.runId, `status ${status} requires a pinned run plan`);
  }
  if (TERMINAL_RUN.has(status)) {
    assertTerminalRunStatus(state, plan, status, event);
    if (typeof event.payload.reason === "string") state.terminalReason = event.payload.reason;
    state.terminalEventSeen = true;
    state.awaitingTransition = false;
    state.lastTerminalTransition = undefined;
    state.currentStep = undefined;
    state.pendingStepId = undefined;
  }
  state.status = status;
}

function assertTerminalRunStatus(
  state: MutableState,
  plan: VnextCompiledPlan | undefined,
  status: VnextRunStatus,
  event: VnextRunEvent,
): void {
  if (status === "completed") {
    if (state.lastTerminalTransition !== "completed") {
      throw runtimeError("run_events_illegal", state.runId, "completed requires a selected terminal transition");
    }
    return;
  }
  if (status === "cancelled") {
    if (state.lastTerminalTransition === "cancelled" && state.status === "running") return;
    if ((state.status === "created" || state.status === "preparing") && state.cancelRequested) return;
    if (state.status === "cancelling") {
      if (!state.currentStep) return;
      if (state.currentStep.status === "cancelled" && (!state.currentStep.attemptId || state.currentStep.attemptStatus === "terminal")) {
        return;
      }
    }
    throw runtimeError("run_events_illegal", state.runId, "cancelled requires a selected terminal or a settled operator cancel");
  }
  if (status === "failed") {
    if (state.lastTerminalTransition === "failed") return;
    if (isProvenFailure(state, plan)) return;
    if (event.payload.reason === "executing_unrecorded" && state.currentStep?.attemptStatus === "starting") return;
    throw runtimeError("run_events_illegal", state.runId, "failed requires a selected failed terminal or proven rejection/budget facts");
  }
}

function isProvenFailure(state: MutableState, plan: VnextCompiledPlan | undefined): boolean {
  const current = state.currentStep;
  if (current) {
    const stepTerminal = current.status === "passed" || current.status === "failed" || current.status === "cancelled";
    const settled = (!current.attemptId || current.attemptStatus === "terminal")
      && (!current.assignmentId || current.assignmentStatus === "terminal");
    if (stepTerminal && settled) {
      if (
        (state.recordedResultClass === "outcome_unknown" || state.recordedResultClass === "producer_rejected")
        && current.status === "failed"
      ) {
        return true;
      }
      if (plan && current.outcome) {
        const selected = plan.steps[current.stepId]?.transitions[current.outcome];
        if (selected) {
          const edgeKey = `${current.stepId}:${current.outcome}`;
          const edgeUsed = (state.edgeTransitions[edgeKey] ?? 0) + 1;
          if (selected.maxTransitions !== undefined && edgeUsed > selected.maxTransitions) return true;
          if (state.transitionsUsed + 1 > plan.transitionBudget) return true;
          if (selected.to === "step") {
            const used = state.stepAttempts[selected.target] ?? 0;
            const target = plan.steps[selected.target];
            if (target && used >= target.maxAttempts) return true;
          }
        }
      }
    }
    return false;
  }
  if (!plan) return false;
  const stepId = state.pendingStepId ?? plan.entryStepId;
  const step = plan.steps[stepId];
  const used = state.stepAttempts[stepId] ?? 0;
  return Boolean(step && used >= step.maxAttempts);
}

function foldCancelRequested(state: MutableState, event: VnextRunEvent): void {
  if (state.cancelRequested || TERMINAL_RUN.has(state.status)) {
    throw runtimeError("run_events_illegal", state.runId, "duplicate run.cancel_requested is not legal");
  }
  state.cancelRequested = true;
  if (event.commandId) state.cancelCommandId = event.commandId;
}

function requireRunning(state: MutableState, eventType: string): void {
  if (state.status !== "running" && !(state.status === "cancelling" && eventType !== "step.entered")) {
    throw runtimeError("run_events_illegal", state.runId, `${eventType} is not legal while the run is ${state.status}`);
  }
}

function foldStepEntered(state: MutableState, plan: VnextCompiledPlan, event: VnextRunEvent): void {
  if (state.status !== "running") {
    throw runtimeError("run_events_illegal", state.runId, "step.entered is only legal while running");
  }
  if (state.currentStep) {
    throw runtimeError("run_events_illegal", state.runId, "step.entered is illegal while a step is active");
  }
  const stepId = stringPayload(event, "stepId");
  const stepAttempt = integerPayload(event, "stepAttempt");
  const expected = state.pendingStepId ?? plan.entryStepId;
  if (stepId !== expected) {
    throw runtimeError("run_events_illegal", state.runId, `step.entered ${stepId} does not match pending ${expected}`);
  }
  const step = requireStep(plan, stepId, state.runId);
  const used = state.stepAttempts[stepId] ?? 0;
  if (used >= step.maxAttempts) {
    throw runtimeError("run_events_illegal", state.runId, `step ${stepId} exceeds maxAttempts`);
  }
  if (stepAttempt !== used + 1) {
    throw runtimeError("run_events_illegal", state.runId, `stepAttempt ${stepAttempt} is not the next attempt for ${stepId}`);
  }
  state.stepAttempts[stepId] = stepAttempt;
  state.pendingStepId = undefined;
  state.awaitingTransition = false;
  state.lastOutcomeEvent = undefined;
  state.recordedOutcome = undefined;
  state.recordedResultClass = undefined;
  state.currentStep = { stepId, stepAttempt, status: "pending" };
}

function foldStepStatus(state: MutableState, event: VnextRunEvent): void {
  requireActiveStep(state, "step.status_changed");
  const stepId = stringPayload(event, "stepId");
  const status = stringPayload(event, "status");
  if (stepId !== state.currentStep!.stepId) {
    throw runtimeError("run_events_illegal", state.runId, "step.status_changed does not match the active step");
  }
  if (!STEP_STATUSES.has(status)) {
    throw runtimeError("run_events_illegal", state.runId, `illegal step status ${status}`);
  }
  const allowed = STEP_EDGES[state.currentStep!.status];
  if (!allowed?.has(status)) {
    throw runtimeError("run_events_illegal", state.runId, `illegal step transition ${state.currentStep!.status} -> ${status}`);
  }
  if (status === "passed" || status === "failed" || status === "cancelled") {
    if (state.currentStep!.attemptId && state.currentStep!.attemptStatus !== "terminal") {
      throw runtimeError("run_events_illegal", state.runId, "terminal step status requires a terminal attempt");
    }
    if (status === "passed" && state.recordedOutcome !== "passed") {
      throw runtimeError("run_events_illegal", state.runId, "passed requires recordedOutcome passed");
    }
    if (state.lastOutcomeEvent) state.awaitingTransition = true;
  }
  state.currentStep = { ...state.currentStep!, status };
}

function foldOutcome(state: MutableState, plan: VnextCompiledPlan, event: VnextRunEvent): void {
  requireActiveStep(state, "step.outcome_recorded");
  const stepId = stringPayload(event, "stepId");
  const stepAttempt = integerPayload(event, "stepAttempt");
  const outcome = stringPayload(event, "outcome");
  const current = state.currentStep!;
  if (stepId !== current.stepId || stepAttempt !== current.stepAttempt) {
    throw runtimeError("run_events_illegal", state.runId, "step.outcome_recorded does not match the active attempt");
  }
  if (current.attemptStatus !== "terminal" || current.assignmentStatus !== "terminal") {
    throw runtimeError("run_events_illegal", state.runId, "step.outcome_recorded requires a terminal attempt and assignment");
  }
  if (current.outcome !== undefined) {
    throw runtimeError("run_events_illegal", state.runId, "step.outcome_recorded cannot overwrite a recorded outcome");
  }
  if (outcome !== state.recordedOutcome) {
    throw runtimeError("run_events_illegal", state.runId, "step.outcome_recorded does not match the recorded assignment outcome");
  }
  const step = requireStep(plan, stepId, state.runId);
  if (!step.outcomes.includes(outcome)) {
    throw runtimeError("run_events_illegal", state.runId, `outcome ${outcome} is not declared for ${stepId}`);
  }
  state.currentStep = { ...current, outcome };
  state.lastOutcomeEvent = { stepId, stepAttempt, outcome };
}

function foldTransitioned(state: MutableState, plan: VnextCompiledPlan, event: VnextRunEvent): void {
  requireActiveStep(state, "step.transitioned");
  const fromStepId = stringPayload(event, "fromStepId");
  const outcome = stringPayload(event, "outcome");
  const current = state.currentStep!;
  if (fromStepId !== current.stepId) {
    throw runtimeError("run_events_illegal", state.runId, "step.transitioned does not match the active step");
  }
  if (current.status !== "passed" && current.status !== "failed" && current.status !== "cancelled") {
    throw runtimeError("run_events_illegal", state.runId, "step.transitioned requires a settled step status");
  }
  if (!state.lastOutcomeEvent || state.lastOutcomeEvent.outcome !== outcome || state.lastOutcomeEvent.stepId !== fromStepId) {
    throw runtimeError("run_events_illegal", state.runId, "step.transitioned requires a prior matching step.outcome_recorded");
  }
  const step = requireStep(plan, fromStepId, state.runId);
  const selected = step.transitions[outcome];
  if (!selected) {
    throw runtimeError("run_events_illegal", state.runId, `no compiled transition for ${fromStepId}:${outcome}`);
  }
  assertTransitionPayload(state.runId, selected, event);
  const edgeKey = `${fromStepId}:${outcome}`;
  const edgeUsed = (state.edgeTransitions[edgeKey] ?? 0) + 1;
  if (selected.maxTransitions !== undefined && edgeUsed > selected.maxTransitions) {
    throw runtimeError("run_events_illegal", state.runId, `edge ${edgeKey} exceeds maxTransitions`);
  }
  const transitionsUsed = state.transitionsUsed + 1;
  if (transitionsUsed > plan.transitionBudget) {
    throw runtimeError("run_events_illegal", state.runId, "transitionBudget exceeded");
  }
  if (selected.to === "step") {
    const target = requireStep(plan, selected.target, state.runId);
    const targetUsed = state.stepAttempts[selected.target] ?? 0;
    if (targetUsed >= target.maxAttempts) {
      throw runtimeError("run_events_illegal", state.runId, `target step ${selected.target} has no remaining attempts`);
    }
    state.pendingStepId = selected.target;
  } else {
    state.lastTerminalTransition = selected.terminalStatus;
  }
  state.edgeTransitions[edgeKey] = edgeUsed;
  state.transitionsUsed = transitionsUsed;
  state.currentStep = undefined;
  state.awaitingTransition = false;
  state.lastOutcomeEvent = undefined;
}

function assertTransitionPayload(runId: string, selected: VnextCompiledTransition, event: VnextRunEvent): void {
  if (selected.to === "step") {
    if (event.payload.toStepId !== selected.target) {
      throw runtimeError("run_events_illegal", runId, "step.transitioned toStepId does not match the compiled target");
    }
    if (event.payload.status !== undefined) {
      throw runtimeError("run_events_illegal", runId, "step-target transition must not carry a terminal status");
    }
    return;
  }
  if (event.payload.toStepId !== undefined) {
    throw runtimeError("run_events_illegal", runId, "terminal step.transitioned must not set toStepId");
  }
  if (event.payload.status !== selected.terminalStatus) {
    throw runtimeError("run_events_illegal", runId, "terminal step.transitioned status does not match the compiled terminal");
  }
}

function foldAssignmentCreated(state: MutableState, event: VnextRunEvent): void {
  requireActiveStep(state, "assignment.created");
  const current = state.currentStep!;
  if (current.assignmentId) {
    throw runtimeError("run_events_illegal", state.runId, "assignment.created repeats an assignment");
  }
  const assignmentId = stringPayload(event, "assignmentId");
  const stepId = stringPayload(event, "stepId");
  const stepAttempt = integerPayload(event, "stepAttempt");
  if (stepId !== current.stepId || stepAttempt !== current.stepAttempt) {
    throw runtimeError("run_events_illegal", state.runId, "assignment.created does not match the active step attempt");
  }
  state.currentStep = { ...current, assignmentId, assignmentStatus: "created" };
}

function foldAssignmentAdvance(state: MutableState, plan: VnextCompiledPlan, event: VnextRunEvent, next: string): void {
  requireActiveStep(state, `assignment.${next}`);
  const current = state.currentStep!;
  if (!current.assignmentId || !current.assignmentStatus) {
    throw runtimeError("run_events_illegal", state.runId, `assignment ${next} has no active assignment`);
  }
  const assignmentId = stringPayload(event, "assignmentId");
  if (assignmentId !== current.assignmentId) {
    throw runtimeError("run_events_illegal", state.runId, "assignment event assignmentId does not match the active assignment");
  }
  if (!ASSIGNMENT_STATUSES.has(next)) {
    throw runtimeError("run_events_illegal", state.runId, `illegal assignment status ${next}`);
  }
  const allowed = ASSIGNMENT_EDGES[current.assignmentStatus];
  if (!allowed?.has(next)) {
    throw runtimeError("run_events_illegal", state.runId, `illegal assignment transition ${current.assignmentStatus} -> ${next}`);
  }
  if (next === "dispatched") {
    stringPayload(event, "capabilityHash");
  }
  if (next === "result_recorded") {
    const resultClass = stringPayload(event, "resultClass");
    if (!RESULT_CLASSES.has(resultClass)) {
      throw runtimeError("run_events_illegal", state.runId, `illegal resultClass ${resultClass}`);
    }
    if (resultClass === "outcome") {
      const outcome = stringPayload(event, "outcome");
      const step = requireStep(plan, current.stepId, state.runId);
      if (!step.outcomes.includes(outcome)) {
        throw runtimeError("run_events_illegal", state.runId, `outcome ${outcome} is not declared for ${current.stepId}`);
      }
      state.recordedOutcome = outcome;
    } else if (event.payload.outcome !== undefined) {
      throw runtimeError("run_events_illegal", state.runId, "non-outcome resultClass must not set outcome");
    } else {
      state.recordedOutcome = undefined;
    }
    state.recordedResultClass = resultClass;
  }
  if (next === "terminal") {
    const outcome = stringPayload(event, "outcome");
    const resultClass = state.recordedResultClass;
    if (resultClass === "outcome") {
      if (outcome !== state.recordedOutcome) {
        throw runtimeError("run_events_illegal", state.runId, "assignment.terminal outcome does not match result_recorded");
      }
    } else if (resultClass === "outcome_unknown" || resultClass === "producer_rejected") {
      if (outcome !== "failed") {
        throw runtimeError("run_events_illegal", state.runId, "rejected or unknown results must terminal as failed");
      }
    } else if (resultClass === "cancelled") {
      if (outcome !== "cancelled") {
        throw runtimeError("run_events_illegal", state.runId, "cancelled results must terminal as cancelled");
      }
    } else {
      throw runtimeError("run_events_illegal", state.runId, "assignment.terminal requires a prior result_recorded class");
    }
  }
  state.currentStep = { ...current, assignmentStatus: next };
}

function foldAttemptCreated(state: MutableState, event: VnextRunEvent): void {
  requireActiveStep(state, "attempt.created");
  const current = state.currentStep!;
  if (current.attemptId) {
    throw runtimeError("run_events_illegal", state.runId, "attempt.created repeats an attempt");
  }
  const attemptId = stringPayload(event, "attemptId");
  const assignmentId = stringPayload(event, "assignmentId");
  if (assignmentId !== current.assignmentId) {
    throw runtimeError("run_events_illegal", state.runId, "attempt.created assignmentId does not match");
  }
  state.currentStep = { ...current, attemptId, attemptStatus: "created" };
}

function foldAttemptStatus(state: MutableState, event: VnextRunEvent): void {
  requireActiveStep(state, "attempt.status_changed");
  const current = state.currentStep!;
  if (!current.attemptId || !current.attemptStatus) {
    throw runtimeError("run_events_illegal", state.runId, "attempt.status_changed has no active attempt");
  }
  const attemptId = stringPayload(event, "attemptId");
  const status = stringPayload(event, "status");
  if (attemptId !== current.attemptId) {
    throw runtimeError("run_events_illegal", state.runId, "attempt.status_changed does not match the active attempt");
  }
  if (!ATTEMPT_STATUSES.has(status)) {
    throw runtimeError("run_events_illegal", state.runId, `illegal attempt status ${status}`);
  }
  const allowed = ATTEMPT_EDGES[current.attemptStatus];
  if (!allowed?.has(status)) {
    throw runtimeError("run_events_illegal", state.runId, `illegal attempt transition ${current.attemptStatus} -> ${status}`);
  }
  state.currentStep = { ...current, attemptStatus: status };
}

function requireActiveStep(state: MutableState, eventType: string): void {
  requireRunning(state, eventType);
  if (!state.currentStep) {
    throw runtimeError("run_events_illegal", state.runId, `${eventType} requires an active step`);
  }
}

function requireStep(plan: VnextCompiledPlan, stepId: string, runId: string): VnextCompiledStep {
  const step = plan.steps[stepId];
  if (!step) throw runtimeError("run_events_illegal", runId, `unknown step ${stepId}`);
  return step;
}

function stringPayload(event: VnextRunEvent, field: string): string {
  const value = event.payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw runtimeError("run_events_illegal", event.runId, `${event.eventType} is missing ${field}`);
  }
  return value;
}

function integerPayload(event: VnextRunEvent, field: string): number {
  const value = event.payload[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw runtimeError("run_events_illegal", event.runId, `${event.eventType} is missing a valid ${field}`);
  }
  return value;
}

function freezeState(state: MutableState): VnextRunState {
  const frozen: VnextRunState = {
    schema: VNEXT_RUN_STATE_SCHEMA,
    runId: state.runId,
    status: state.status,
    ...(state.runPlanHash !== undefined ? { runPlanHash: state.runPlanHash } : {}),
    ...(state.pendingStepId !== undefined ? { pendingStepId: state.pendingStepId } : {}),
    ...(state.currentStep !== undefined ? { currentStep: Object.freeze({ ...omitUndefined(state.currentStep) }) } : {}),
    stepAttempts: Object.freeze({ ...state.stepAttempts }),
    edgeTransitions: Object.freeze({ ...state.edgeTransitions }),
    transitionsUsed: state.transitionsUsed,
    cancelRequested: state.cancelRequested,
    ...(state.terminalReason !== undefined ? { terminalReason: state.terminalReason } : {}),
  };
  return Object.freeze(frozen);
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  const copy = { ...value };
  for (const key of Object.keys(copy)) {
    if (copy[key] === undefined) delete copy[key];
  }
  return copy;
}

export function isTerminalRunStatus(status: VnextRunStatus): boolean {
  return TERMINAL_RUN.has(status);
}

export function isVnextTerminalStatus(value: string): value is VnextTerminalStatus {
  return value === "completed" || value === "failed" || value === "cancelled";
}

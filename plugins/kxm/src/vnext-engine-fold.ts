import type { VnextCompiledPlan, VnextCompiledStep, VnextCompiledTransition, VnextTerminalStatus } from "./vnext-engine-compile.ts";
import {
  runtimeError,
  type VnextRunEvent,
  type VnextRunRecord,
  type VnextRunStatus,
} from "./vnext-runtime-store.ts";

export const VNEXT_RUN_STATE_SCHEMA = "kxm.run-state.v2";
export const FOLD_PANEL_BOUND = 1;

const RUN_STATUSES = new Set<VnextRunStatus>(["created", "preparing", "running", "waiting", "blocked_uncertain", "cancelling", "cancelled", "completed", "failed"]);
const TERMINAL_RUN = new Set<VnextRunStatus>(["cancelled", "completed", "failed"]);
const STEP_STATUSES = new Set(["pending", "preparing", "running", "passed", "failed", "cancelled"]);
const ASSIGNMENT_STATUSES = new Set(["created", "accepted", "dispatched", "executing", "result_recorded", "terminal"]);
const ATTEMPT_STATUSES = new Set(["created", "starting", "executing", "settling", "terminal"]);
const RESULT_CLASSES = new Set(["outcome", "outcome_unknown", "producer_rejected", "cancelled"]);
const SLICE_BLOCKED_RUN = new Set<VnextRunStatus>(["waiting"]);
const RUN_EDGES: Readonly<Record<string, ReadonlySet<VnextRunStatus>>> = {
  created: new Set(["preparing", "cancelled", "failed"]),
  preparing: new Set(["running", "cancelled", "failed"]),
  running: new Set(["blocked_uncertain", "cancelling", "cancelled", "completed", "failed"]),
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

export type VnextRunEffectState =
  | "intent"
  | "dispatched"
  | "observed-complete"
  | "observed-no-start"
  | "observed-unknown"
  | "blocked_uncertain"
  | "settled"
  | "settled-proof";

export interface VnextFoldOptions {
  readonly observationLookup?: (
    attemptId: string,
    observationId: string,
  ) => { completeness: "complete" | "incomplete" | "no-start" } | undefined;
  readonly gateKind?: (stepId: string) => string | undefined;
}

export interface VnextFoldAttemptState {
  readonly status: string;
  readonly resultClass?: string | undefined;
  readonly outcome?: string | undefined;
}

export interface VnextFoldAssignmentState {
  readonly status: string;
  readonly currentAttemptId?: string | undefined;
  readonly attempts: Readonly<Record<string, VnextFoldAttemptState>>;
}

export interface VnextFoldPanel {
  readonly order: readonly string[];
  readonly assignments: Readonly<Record<string, VnextFoldAssignmentState>>;
}

export type VnextJoinAllResult =
  | { readonly tag: "unsatisfied" }
  | { readonly tag: "outcome"; readonly outcome: string }
  | { readonly tag: "conflict" }
  | { readonly tag: "rejected" }
  | { readonly tag: "cancelled" };

export interface VnextRunCurrentStep {
  readonly stepId: string;
  readonly stepAttempt: number;
  readonly status: string;
  readonly panel: VnextFoldPanel;
  readonly assignmentId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly assignmentStatus?: string | undefined;
  readonly attemptStatus?: string | undefined;
  readonly outcome?: string | undefined;
  readonly effectId?: string | undefined;
  readonly effectState?: VnextRunEffectState | undefined;
  readonly observationId?: string | undefined;
  readonly observationHash?: string | undefined;
  readonly observationCompleteness?: "complete" | "no-start" | "unknown" | undefined;
  readonly settledOutcome?: string | undefined;
  readonly evidenceRefs?: readonly { id: string; kind: string; hash: string; status: string }[] | undefined;
}

export interface VnextRunDriveBinding {
  readonly driveId: string;
  readonly mode: "simulated" | "live";
  readonly openedSequence: number;
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
  readonly failureReason?: string | undefined;
  readonly drive?: VnextRunDriveBinding | undefined;
}

interface MutableAttempt {
  status: string;
  resultClass?: string | undefined;
  outcome?: string | undefined;
}

interface MutableAssignment {
  status: string;
  currentAttemptId?: string | undefined;
  attempts: Record<string, MutableAttempt>;
}

interface MutablePanel {
  order: string[];
  assignments: Record<string, MutableAssignment>;
}

interface MutableCurrentStep {
  stepId: string;
  stepAttempt: number;
  status: string;
  panel: MutablePanel;
  outcome?: string | undefined;
  effectId?: string | undefined;
  effectState?: VnextRunEffectState | undefined;
  observationId?: string | undefined;
  observationHash?: string | undefined;
  observationCompleteness?: "complete" | "no-start" | "unknown" | undefined;
  settledOutcome?: string | undefined;
  evidenceRefs?: Array<{ id: string; kind: string; hash: string; status: string }> | undefined;
}

interface MutableState {
  schema: typeof VNEXT_RUN_STATE_SCHEMA;
  runId: string;
  status: VnextRunStatus;
  runPlanHash?: string | undefined;
  pendingStepId?: string | undefined;
  currentStep?: MutableCurrentStep | undefined;
  stepAttempts: Record<string, number>;
  edgeTransitions: Record<string, number>;
  transitionsUsed: number;
  cancelRequested: boolean;
  terminalReason?: string | undefined;
  terminalEventSeen: boolean;
  lastOutcomeEvent?: { stepId: string; stepAttempt: number; outcome: string } | undefined;
  awaitingTransition: boolean;
  cancelCommandId?: string | undefined;
  lastTerminalTransition?: VnextTerminalStatus | undefined;
  drive?: VnextRunDriveBinding | undefined;
}

function emptyPanel(): MutablePanel {
  return { order: [], assignments: Object.create(null) as Record<string, MutableAssignment> };
}

function panelAssignmentId(current: MutableCurrentStep): string | undefined {
  return current.panel.order[0];
}

function panelAssignment(current: MutableCurrentStep, assignmentId?: string): MutableAssignment | undefined {
  const id = assignmentId ?? panelAssignmentId(current);
  return id ? current.panel.assignments[id] : undefined;
}

function panelAttemptId(current: MutableCurrentStep): string | undefined {
  return panelAssignment(current)?.currentAttemptId;
}

function panelAttempt(current: MutableCurrentStep): MutableAttempt | undefined {
  const assignment = panelAssignment(current);
  const attemptId = assignment?.currentAttemptId;
  return attemptId ? assignment.attempts[attemptId] : undefined;
}

export function vnextFoldPanelAttempt(
  step: VnextRunCurrentStep | MutableCurrentStep | undefined,
  attemptId: string,
): { assignmentId: string; assignment: MutableAssignment | VnextFoldAssignmentState; attempt: MutableAttempt | VnextFoldAttemptState } | undefined {
  if (!step) return undefined;
  for (const assignmentId of step.panel.order) {
    const assignment = step.panel.assignments[assignmentId];
    const attempt = assignment?.attempts[attemptId];
    if (attempt) return { assignmentId, assignment, attempt };
  }
  return undefined;
}

function findPanelAttempt(
  panel: MutablePanel,
  attemptId: string,
): { assignmentId: string; assignment: MutableAssignment; attempt: MutableAttempt } | undefined {
  for (const assignmentId of panel.order) {
    const assignment = panel.assignments[assignmentId];
    const attempt = assignment?.attempts[attemptId];
    if (attempt && assignment) return { assignmentId, assignment, attempt };
  }
  return undefined;
}

function panelAssignmentBound(plan: VnextCompiledPlan | undefined, current: MutableCurrentStep): number {
  const step = plan?.steps[current.stepId];
  if (!step) return FOLD_PANEL_BOUND;
  if ((step.kind === "agent" || step.kind === "moa") && (step.join.strategy === "all" || step.join.strategy === "all-settled")) {
    return step.assignments.maximum;
  }
  return FOLD_PANEL_BOUND;
}

function panelAssignmentsTerminal(current: MutableCurrentStep): boolean {
  if (current.panel.order.length === 0) return false;
  for (const assignmentId of current.panel.order) {
    const assignment = current.panel.assignments[assignmentId];
    if (!assignment || assignment.status !== "terminal") return false;
  }
  return true;
}

function panelIssuedAttemptsTerminal(current: MutableCurrentStep): boolean {
  for (const assignmentId of current.panel.order) {
    const assignment = current.panel.assignments[assignmentId];
    if (!assignment) return false;
    for (const attempt of Object.values(assignment.attempts)) {
      if (attempt.status !== "terminal") return false;
    }
  }
  return true;
}

function panelInFlightCount(panel: MutablePanel): number {
  let count = 0;
  for (const assignmentId of panel.order) {
    const assignment = panel.assignments[assignmentId];
    if (!assignment) continue;
    for (const attempt of Object.values(assignment.attempts)) {
      if (attempt.status === "starting" || attempt.status === "executing" || attempt.status === "settling") count += 1;
    }
  }
  return count;
}

function panelFrozen(current: MutableCurrentStep): boolean {
  return current.outcome !== undefined
    || current.status === "passed"
    || current.status === "failed"
    || current.status === "cancelled";
}

function createdOnlySingletonCancel(state: MutableState, step: VnextCompiledStep, current: MutableCurrentStep, status: string): boolean {
  const assignmentId = current.panel.order[0];
  const assignment = assignmentId ? current.panel.assignments[assignmentId] : undefined;
  return status === "cancelled"
    && state.cancelRequested
    && current.panel.order.length === 1
    && current.panel.order.length >= step.assignments.minimum
    && assignment?.status === "created";
}

function authorizedCancelStep(state: MutableState, step: VnextCompiledStep, current: MutableCurrentStep, status: string): boolean {
  if (status !== "cancelled" || !state.cancelRequested) return false;
  if (createdOnlySingletonCancel(state, step, current, status)) return true;
  if (!panelIssuedAttemptsTerminal(current) || !panelAssignmentsTerminal(current)) return false;
  const members: Array<{ resultClass: string; outcome: string | undefined }> = [];
  for (const assignmentId of current.panel.order) {
    const assignment = current.panel.assignments[assignmentId];
    if (!assignment) return false;
    const issued = Object.values(assignment.attempts);
    if (issued.length === 0) return false;
    for (const attempt of issued) {
      if (attempt.status !== "terminal" || !attempt.resultClass) return false;
    }
    const currentAttempt = currentAttemptOf(assignment);
    if (!currentAttempt?.resultClass) return false;
    members.push({ resultClass: currentAttempt.resultClass, outcome: currentAttempt.outcome });
  }
  if (members.some((member) => member.resultClass === "outcome_unknown" || member.resultClass === "producer_rejected")) {
    return false;
  }
  const declared = members.filter((member) => member.resultClass === "outcome");
  if (declared.length > 0) {
    const outcome = declared[0]?.outcome;
    if (typeof outcome !== "string" || declared.some((member) => member.outcome !== outcome)) return false;
  }
  return members.every((member) => member.resultClass === "outcome" || member.resultClass === "cancelled");
}

function currentAttemptOf(assignment: {
  currentAttemptId?: string | undefined;
  attempts: { readonly [id: string]: { resultClass?: string | undefined; outcome?: string | undefined } | undefined };
}): { resultClass?: string | undefined; outcome?: string | undefined } | undefined {
  const attemptId = assignment.currentAttemptId;
  return attemptId ? assignment.attempts[attemptId] : undefined;
}

function expectedStatusForDeclaredOutcome(step: VnextCompiledStep, outcome: string): "passed" | "failed" | "cancelled" {
  // Classify by outcome name only, never terminal target
  if (outcome === "passed") return "passed";
  if (outcome === "cancelled") return "cancelled";
  return "failed";
}

export function vnextJoinAll(step: VnextCompiledStep, panel: VnextFoldPanel | MutablePanel): VnextJoinAllResult {
  if (panel.order.length < step.assignments.minimum) return { tag: "unsatisfied" };
  const members: Array<{ resultClass: string; outcome?: string | undefined }> = [];
  for (const assignmentId of panel.order) {
    const assignment = panel.assignments[assignmentId];
    if (!assignment || assignment.status !== "terminal") return { tag: "unsatisfied" };
    const issued = Object.values(assignment.attempts);
    if (issued.length === 0) return { tag: "unsatisfied" };
    for (const attempt of issued) {
      if (attempt.status !== "terminal" || !attempt.resultClass) return { tag: "unsatisfied" };
    }
    const current = currentAttemptOf(assignment);
    if (!current?.resultClass) return { tag: "unsatisfied" };
    members.push({ resultClass: current.resultClass, outcome: current.outcome });
  }
  if (members.some((member) => member.resultClass === "outcome_unknown" || member.resultClass === "producer_rejected")) {
    return { tag: "rejected" };
  }
  if (members.every((member) => member.resultClass === "cancelled")) return { tag: "cancelled" };
  if (step.join.strategy === "all-settled") {
    const passedCount = members.filter((m) => m.resultClass === "outcome" && m.outcome === "passed").length;
    const minPassed = step.join.minimumPassed ?? step.assignments.minimum;
    if (passedCount >= minPassed) {
      return { tag: "outcome", outcome: "passed" };
    }
    const nonPassedGroups = new Map<string, number>();
    for (const m of members) {
      if (m.resultClass === "outcome" && m.outcome && m.outcome !== "passed") {
        nonPassedGroups.set(m.outcome, (nonPassedGroups.get(m.outcome) ?? 0) + 1);
      }
    }
    for (const [outcome, count] of nonPassedGroups) {
      if (count >= minPassed) {
        return { tag: "outcome", outcome };
      }
    }
    return { tag: "outcome", outcome: "quorum-not-met" };
  }
  if (members.every((member) => member.resultClass === "outcome")) {
    const outcome = members[0]?.outcome;
    if (typeof outcome === "string" && members.every((member) => member.outcome === outcome)) {
      return { tag: "outcome", outcome };
    }
    return { tag: "conflict" };
  }
  return { tag: "conflict" };
}

function putAssignment(current: MutableCurrentStep, assignmentId: string, assignment: MutableAssignment): MutableCurrentStep {
  return {
    ...current,
    panel: {
      order: current.panel.order,
      assignments: { ...current.panel.assignments, [assignmentId]: assignment },
    },
  };
}

export function vnextFoldPanelAttemptIds(step: VnextRunCurrentStep | MutableCurrentStep | undefined): string[] {
  if (!step) return [];
  const ids: string[] = [];
  for (const assignmentId of step.panel.order) {
    const assignment = step.panel.assignments[assignmentId];
    if (!assignment) continue;
    for (const attemptId of Object.keys(assignment.attempts)) ids.push(attemptId);
  }
  return ids;
}

export function foldVnextRunState(
  run: VnextRunRecord,
  plan: VnextCompiledPlan | undefined,
  events: readonly VnextRunEvent[],
  options: VnextFoldOptions = {},
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
      (
        event.eventType.startsWith("step.")
        || event.eventType.startsWith("assignment.")
        || event.eventType.startsWith("attempt.")
        || event.eventType.startsWith("effect.")
      )
      && !plan
    ) {
      throw runtimeError("run_plan_missing", run.runId, "step events require a pinned run plan");
    }
    if (state.currentStep?.effectState === "blocked_uncertain") {
      const namesFrozen = event.payload.stepId === state.currentStep.stepId
        || event.payload.attemptId === panelAttemptId(state.currentStep)
        || event.payload.assignmentId === panelAssignmentId(state.currentStep)
        || (event.payload.effect !== undefined && typeof event.payload.effect === "object" && event.payload.effect !== null && "id" in event.payload.effect && (event.payload.effect as { id?: unknown }).id === state.currentStep.effectId);
      const blockedFamily = event.eventType.startsWith("step.")
        || event.eventType.startsWith("assignment.")
        || event.eventType.startsWith("attempt.")
        || event.eventType.startsWith("effect.");
      if (blockedFamily && namesFrozen) {
        throw runtimeError("run_events_illegal", run.runId, "blocked_uncertain freezes the gate attempt");
      }
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
      case "run.drive_opened":
        foldDriveOpened(state, event);
        break;
      case "step.entered":
        foldStepEntered(state, plan!, event);
        break;
      case "step.status_changed":
        foldStepStatus(state, plan, event);
        break;
      case "step.outcome_recorded":
        foldOutcome(state, plan!, event);
        break;
      case "step.transitioned":
        foldTransitioned(state, plan!, event);
        break;
      case "assignment.created":
        foldAssignmentCreated(state, plan, event);
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
        foldAttemptStatus(state, plan!, event);
        break;
      case "effect.intent_recorded":
        foldEffectIntent(state, plan!, event);
        break;
      case "effect.dispatched":
        foldEffectDispatched(state, plan!, event);
        break;
      case "effect.observed":
        foldEffectObserved(state, plan!, event, options);
        break;
      case "effect.settled":
        foldEffectSettled(state, plan!, event);
        break;
      case "effect.blocked_uncertain":
        foldEffectUncertain(state, plan!, event);
        break;
      case "routing.attempt.recorded":
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
  if (status === "blocked_uncertain") {
    if (state.currentStep?.effectState !== "blocked_uncertain") {
      throw runtimeError("run_events_illegal", state.runId, "blocked_uncertain requires an uncertain step effect");
    }
  }
  if (status === "running" && state.status === "blocked_uncertain") {
    if (state.currentStep) {
      state.pendingStepId = state.currentStep.stepId;
      state.currentStep = undefined;
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
      if (state.currentStep.status === "cancelled" && panelIssuedAttemptsTerminal(state.currentStep)) {
        return;
      }
      if (state.currentStep.effectState === "blocked_uncertain") {
        return;
      }
    }
    throw runtimeError("run_events_illegal", state.runId, "cancelled requires a selected terminal or a settled operator cancel");
  }
  if (status === "failed") {
    if (state.lastTerminalTransition === "failed") return;
    if (isProvenFailure(state, plan)) return;
    if (
      event.payload.reason === "budget_model_cost"
      || event.payload.reason === "budget_unmetered_attempts"
      || event.payload.reason === "budget_step_attempts"
    ) {
      return;
    }
    if (state.status === "blocked_uncertain" || state.currentStep?.effectState === "blocked_uncertain") return;
    const currentStep = state.currentStep;
    if (event.payload.reason === "executing_unrecorded" && currentStep && currentStep.panel.order.length === 1 && panelAttempt(currentStep)?.status === "starting") {
      const step = plan?.steps[currentStep.stepId];
      if (step?.kind === "gate") {
        throw runtimeError("run_events_illegal", state.runId, "executing_unrecorded is illegal on a gate step");
      }
      if (step && (step.kind === "agent" || step.kind === "moa") && step.assignments.maximum > 1) {
        throw runtimeError("run_events_illegal", state.runId, "executing_unrecorded is illegal on a multi-assignment panel");
      }
      return;
    }
    throw runtimeError("run_events_illegal", state.runId, "failed requires a selected failed terminal or proven rejection/budget facts");
  }
}

function isProvenFailure(state: MutableState, plan: VnextCompiledPlan | undefined): boolean {
  const current = state.currentStep;
  if (current) {
    const stepTerminal = current.status === "passed" || current.status === "failed" || current.status === "cancelled";
    const settled = panelIssuedAttemptsTerminal(current) && panelAssignmentsTerminal(current);
    if (stepTerminal && settled) {
      const step = plan?.steps[current.stepId];
      if (step && current.status === "failed") {
        const joined = vnextJoinAll(step, current.panel);
        if (joined.tag === "rejected" || joined.tag === "conflict") return true;
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

function foldDriveOpened(state: MutableState, event: VnextRunEvent): void {
  if (state.status !== "running" && state.status !== "blocked_uncertain") {
    throw runtimeError("run_events_illegal", state.runId, "run.drive_opened is only legal while running or blocked_uncertain");
  }
  const driveId = stringPayload(event, "driveId");
  const mode = stringPayload(event, "mode");
  if (mode !== "simulated" && mode !== "live") {
    throw runtimeError("run_events_illegal", state.runId, "run.drive_opened mode must be simulated or live");
  }
  state.drive = { driveId, mode, openedSequence: event.sequence };
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
  state.currentStep = { stepId, stepAttempt, status: "pending", panel: emptyPanel() };
}

function foldStepStatus(state: MutableState, plan: VnextCompiledPlan | undefined, event: VnextRunEvent): void {
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
    const current = state.currentStep!;
    if (!panelIssuedAttemptsTerminal(current)) {
      throw runtimeError("run_events_illegal", state.runId, "terminal step status requires a terminal attempt");
    }
    const step = plan ? requireStep(plan, current.stepId, state.runId) : undefined;
    if (step) {
      const joined = vnextJoinAll(step, current.panel);
      if (joined.tag === "outcome") {
        const expectedStatus = expectedStatusForDeclaredOutcome(step, joined.outcome);
        const selected = step.transitions[joined.outcome];
        const isCustomOutcomeCancelled = typeof joined.outcome === "string"
          && joined.outcome !== "passed"
          && joined.outcome !== "cancelled"
          && selected?.to === "terminal"
          && selected.terminalStatus === "cancelled"
          && status === "cancelled";
        if (status === "cancelled" && authorizedCancelStep(state, step, current, status)) {
          // Durable cancel may coexist with consistent declared outcomes.
        } else if (status === "passed" && state.cancelRequested && current.panel.order.length < step.assignments.target) {
          throw runtimeError("run_events_illegal", state.runId, "cancel before target refill cannot mint a passed step");
        } else if (status !== expectedStatus && !isCustomOutcomeCancelled) {
          if (expectedStatus === "passed") {
            throw runtimeError("run_events_illegal", state.runId, "passed outcome must lead to passed status");
          }
          if (expectedStatus === "cancelled") {
            throw runtimeError("run_events_illegal", state.runId, "cancelled outcome must lead to cancelled status");
          }
          throw runtimeError("run_events_illegal", state.runId, "non-passed declared outcome must lead to failed status");
        }
      } else if (joined.tag === "unsatisfied") {
        if (!authorizedCancelStep(state, step, current, status)) {
          throw runtimeError("run_events_illegal", state.runId, "terminal step status is not legal for this panel join");
        }
      } else if (joined.tag === "rejected" || joined.tag === "conflict") {
        if (status === "cancelled") {
          if (!authorizedCancelStep(state, step, current, status)) {
            throw runtimeError("run_events_illegal", state.runId, "rejected or conflict cannot cancel the step");
          }
        } else if (status !== "failed") {
          throw runtimeError("run_events_illegal", state.runId, "passed requires recordedOutcome passed");
        }
      } else if (joined.tag === "cancelled") {
        if (!state.cancelRequested) {
          throw runtimeError("run_events_illegal", state.runId, "cancelled join requires cancellation authority");
        }
        if (status !== "cancelled") {
          throw runtimeError("run_events_illegal", state.runId, "cancelled join must lead to cancelled status");
        }
      }
    } else if (status === "passed") {
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
  if (!panelIssuedAttemptsTerminal(current) || !panelAssignmentsTerminal(current)) {
    throw runtimeError("run_events_illegal", state.runId, "step.outcome_recorded requires a terminal attempt and assignment");
  }
  if (current.outcome !== undefined) {
    throw runtimeError("run_events_illegal", state.runId, "step.outcome_recorded cannot overwrite a recorded outcome");
  }
  const step = requireStep(plan, stepId, state.runId);
  const joined = vnextJoinAll(step, current.panel);
  if (joined.tag !== "outcome" || joined.outcome !== outcome) {
    throw runtimeError("run_events_illegal", state.runId, "step.outcome_recorded does not match the recorded assignment outcome");
  }
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
  if (!panelIssuedAttemptsTerminal(current) || !panelAssignmentsTerminal(current)) {
    throw runtimeError("run_events_illegal", state.runId, "step.transitioned requires every panel assignment and issued attempt to be terminal");
  }
  const step = requireStep(plan, fromStepId, state.runId);
  const joined = vnextJoinAll(step, current.panel);
  if (joined.tag !== "outcome" || joined.outcome !== outcome) {
    throw runtimeError("run_events_illegal", state.runId, "step.transitioned requires a matching joined declared outcome");
  }
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

function foldAssignmentCreated(state: MutableState, plan: VnextCompiledPlan | undefined, event: VnextRunEvent): void {
  requireActiveStep(state, "assignment.created");
  const current = state.currentStep!;
  if (state.status !== "running" || state.cancelRequested || panelFrozen(current)) {
    throw runtimeError("run_events_illegal", state.runId, "assignment.created is not legal after freeze or cancel intent");
  }
  if (current.panel.order.length >= panelAssignmentBound(plan, current)) {
    throw runtimeError("run_events_illegal", state.runId, "assignment.created repeats an assignment");
  }
  const assignmentId = stringPayload(event, "assignmentId");
  const stepId = stringPayload(event, "stepId");
  const stepAttempt = integerPayload(event, "stepAttempt");
  if (stepId !== current.stepId || stepAttempt !== current.stepAttempt) {
    throw runtimeError("run_events_illegal", state.runId, "assignment.created does not match the active step attempt");
  }
  if (current.panel.assignments[assignmentId]) {
    throw runtimeError("run_events_illegal", state.runId, "assignment.created repeats an assignment");
  }
  state.currentStep = {
    ...current,
    panel: {
      order: [...current.panel.order, assignmentId],
      assignments: {
        ...current.panel.assignments,
        [assignmentId]: { status: "created", attempts: Object.create(null) as Record<string, MutableAttempt> },
      },
    },
  };
}

function foldAssignmentAdvance(state: MutableState, plan: VnextCompiledPlan, event: VnextRunEvent, next: string): void {
  requireActiveStep(state, `assignment.${next}`);
  const current = state.currentStep!;
  if (current.panel.order.length === 0) {
    throw runtimeError("run_events_illegal", state.runId, `assignment ${next} has no active assignment`);
  }
  const assignmentId = stringPayload(event, "assignmentId");
  const assignment = current.panel.assignments[assignmentId];
  if (!assignment) {
    throw runtimeError("run_events_illegal", state.runId, "assignment event assignmentId does not match the active assignment");
  }
  if (!ASSIGNMENT_STATUSES.has(next)) {
    throw runtimeError("run_events_illegal", state.runId, `illegal assignment status ${next}`);
  }
  const step = requireStep(plan, current.stepId, state.runId);
  const allowed = ASSIGNMENT_EDGES[assignment.status];
  const noStartProof = step.kind === "gate"
    && assignment.status === "dispatched"
    && next === "result_recorded"
    && (current.effectState === "observed-no-start" || current.effectState === "settled-proof");
  if (!allowed?.has(next) && !noStartProof) {
    throw runtimeError("run_events_illegal", state.runId, `illegal assignment transition ${assignment.status} -> ${next}`);
  }
  if (next === "dispatched") {
    stringPayload(event, "capabilityHash");
  }
  if (next === "executing" && panelFrozen(current)) {
    throw runtimeError("run_events_illegal", state.runId, "assignment.executing is not legal after freeze");
  }
  if (next === "executing" && state.cancelRequested && step.kind !== "gate") {
    throw runtimeError("run_events_illegal", state.runId, "assignment.executing is not legal after cancel intent");
  }
  let nextAssignment: MutableAssignment = { ...assignment, status: next, attempts: { ...assignment.attempts } };
  if (next === "result_recorded") {
    const resultClass = stringPayload(event, "resultClass");
    if (!RESULT_CLASSES.has(resultClass)) {
      throw runtimeError("run_events_illegal", state.runId, `illegal resultClass ${resultClass}`);
    }
    const attemptId = assignment.currentAttemptId;
    const attempt = attemptId ? assignment.attempts[attemptId] : undefined;
    if (resultClass === "outcome") {
      const outcome = stringPayload(event, "outcome");
      if (!step.outcomes.includes(outcome)) {
        throw runtimeError("run_events_illegal", state.runId, `outcome ${outcome} is not declared for ${current.stepId}`);
      }
      if (step.kind === "gate") {
        if (current.effectState !== "settled") {
          throw runtimeError("run_events_illegal", state.runId, "gate outcome requires evaluated effect.settled");
        }
        if (outcome !== current.settledOutcome) {
          throw runtimeError("run_events_illegal", state.runId, "gate result outcome does not match settledOutcome");
        }
      }
      if (attemptId && attempt) {
        nextAssignment = {
          ...nextAssignment,
          attempts: { ...nextAssignment.attempts, [attemptId]: { ...attempt, resultClass, outcome } },
        };
      }
    } else if (event.payload.outcome !== undefined) {
      throw runtimeError("run_events_illegal", state.runId, "non-outcome resultClass must not set outcome");
    } else {
      if (step.kind === "gate") {
        if (resultClass === "outcome_unknown") {
          throw runtimeError("run_events_illegal", state.runId, "outcome_unknown is illegal on a gate step");
        }
        if (current.effectState !== "settled-proof") {
          throw runtimeError("run_events_illegal", state.runId, "gate producer_rejected or cancelled requires proof-only effect.settled");
        }
        if (resultClass === "producer_rejected" && current.observationCompleteness !== "no-start") {
          throw runtimeError("run_events_illegal", state.runId, "producer_rejected requires a no-start observation");
        }
      }
      if (attemptId && attempt) {
        nextAssignment = {
          ...nextAssignment,
          attempts: { ...nextAssignment.attempts, [attemptId]: { ...attempt, resultClass } },
        };
      }
    }
  }
  if (next === "terminal") {
    const outcome = stringPayload(event, "outcome");
    const ownerAttempt = currentAttemptOf(nextAssignment);
    const resultClass = ownerAttempt?.resultClass;
    if (resultClass === "outcome") {
      if (outcome !== ownerAttempt?.outcome) {
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
    const attemptId = nextAssignment.currentAttemptId;
    const attempt = attemptId ? nextAssignment.attempts[attemptId] : undefined;
    if (attemptId && attempt && attempt.outcome === undefined) {
      nextAssignment = {
        ...nextAssignment,
        attempts: { ...nextAssignment.attempts, [attemptId]: { ...attempt, outcome } },
      };
    }
  }
  state.currentStep = putAssignment(current, assignmentId, nextAssignment);
}

function foldAttemptCreated(state: MutableState, event: VnextRunEvent): void {
  requireActiveStep(state, "attempt.created");
  const current = state.currentStep!;
  if (state.status !== "running" || state.cancelRequested || panelFrozen(current)) {
    throw runtimeError("run_events_illegal", state.runId, "attempt.created is not legal after freeze or cancel intent");
  }
  const assignmentId = stringPayload(event, "assignmentId");
  const assignment = current.panel.assignments[assignmentId];
  if (!assignment) {
    throw runtimeError("run_events_illegal", state.runId, "attempt.created assignmentId does not match");
  }
  if (assignment.currentAttemptId || Object.keys(assignment.attempts).length >= FOLD_PANEL_BOUND) {
    throw runtimeError("run_events_illegal", state.runId, "attempt.created repeats an attempt");
  }
  const attemptId = stringPayload(event, "attemptId");
  if (findPanelAttempt(current.panel, attemptId)) {
    throw runtimeError("run_events_illegal", state.runId, "attempt.created repeats an attempt");
  }
  state.currentStep = putAssignment(current, assignmentId, {
    ...assignment,
    currentAttemptId: attemptId,
    attempts: { ...assignment.attempts, [attemptId]: { status: "created" } },
  });
}

function foldAttemptStatus(state: MutableState, plan: VnextCompiledPlan, event: VnextRunEvent): void {
  requireActiveStep(state, "attempt.status_changed");
  const current = state.currentStep!;
  if (vnextFoldPanelAttemptIds(current).length === 0) {
    throw runtimeError("run_events_illegal", state.runId, "attempt.status_changed has no active attempt");
  }
  const attemptId = stringPayload(event, "attemptId");
  const located = findPanelAttempt(current.panel, attemptId);
  if (!located) {
    throw runtimeError("run_events_illegal", state.runId, "attempt.status_changed does not match the active attempt");
  }
  const status = stringPayload(event, "status");
  if (!ATTEMPT_STATUSES.has(status)) {
    throw runtimeError("run_events_illegal", state.runId, `illegal attempt status ${status}`);
  }
  const allowed = ATTEMPT_EDGES[located.attempt.status];
  const step = requireStep(plan, current.stepId, state.runId);
  const noStartSettling = step.kind === "gate"
    && located.attempt.status === "starting"
    && status === "settling"
    && (current.effectState === "observed-no-start" || current.effectState === "settled-proof");
  if (!allowed?.has(status) && !noStartSettling) {
    throw runtimeError("run_events_illegal", state.runId, `illegal attempt transition ${located.attempt.status} -> ${status}`);
  }
  if (panelFrozen(current) && (status === "starting" || status === "executing")) {
    throw runtimeError("run_events_illegal", state.runId, "attempt start is not legal after freeze");
  }
  if (state.cancelRequested && status === "starting") {
    throw runtimeError("run_events_illegal", state.runId, "attempt start is not legal after cancel intent");
  }
  if (state.cancelRequested && status === "executing" && step.kind !== "gate") {
    throw runtimeError("run_events_illegal", state.runId, "attempt start is not legal after cancel intent");
  }
  if (status === "starting" && panelInFlightCount(current.panel) + 1 > step.assignments.maxParallel) {
    throw runtimeError("run_events_illegal", state.runId, "maxParallel exceeded");
  }
  state.currentStep = putAssignment(current, located.assignmentId, {
    ...located.assignment,
    attempts: { ...located.assignment.attempts, [attemptId]: { ...located.attempt, status } },
  });
}

function requireGateEffect(state: MutableState, plan: VnextCompiledPlan, event: VnextRunEvent): NonNullable<MutableState["currentStep"]> {
  requireActiveStep(state, event.eventType);
  const current = state.currentStep!;
  const step = requireStep(plan, current.stepId, state.runId);
  if (step.kind !== "gate") {
    throw runtimeError("run_events_illegal", state.runId, "agent steps reject effect events");
  }
  assertEffectIdentity(state, event, current);
  return current;
}

function assertEffectIdentity(state: MutableState, event: VnextRunEvent, current: NonNullable<MutableState["currentStep"]>): void {
  const effect = event.payload.effect;
  if (!effect || typeof effect !== "object" || Array.isArray(effect)) {
    throw runtimeError("run_events_illegal", state.runId, `${event.eventType} is missing effect`);
  }
  const effectId = (effect as { id?: unknown }).id;
  if (typeof effectId !== "string" || effectId.length === 0) {
    throw runtimeError("run_events_illegal", state.runId, `${event.eventType} is missing effect.id`);
  }
  const stepId = stringPayload(event, "stepId");
  const stepAttempt = integerPayload(event, "stepAttempt");
  const assignmentId = stringPayload(event, "assignmentId");
  const attemptId = stringPayload(event, "attemptId");
  if (stepId !== current.stepId || stepAttempt !== current.stepAttempt || assignmentId !== panelAssignmentId(current) || attemptId !== panelAttemptId(current)) {
    throw runtimeError("run_events_illegal", state.runId, `${event.eventType} identity does not match the active attempt`);
  }
  if (current.effectId && current.effectId !== effectId) {
    throw runtimeError("run_events_illegal", state.runId, `${event.eventType} effect.id does not match the active effect`);
  }
}

function foldEffectIntent(state: MutableState, plan: VnextCompiledPlan, event: VnextRunEvent): void {
  const current = requireGateEffect(state, plan, event);
  if (panelAttempt(current)?.status !== "starting" || current.effectState) {
    throw runtimeError("run_events_illegal", state.runId, "effect.intent_recorded requires a starting attempt with no effect");
  }
  const effectId = ((event.payload.effect as { id: string }).id);
  state.currentStep = { ...current, effectId, effectState: "intent" };
}

function foldEffectDispatched(state: MutableState, plan: VnextCompiledPlan, event: VnextRunEvent): void {
  const current = requireGateEffect(state, plan, event);
  if (current.effectState !== "intent") {
    throw runtimeError("run_events_illegal", state.runId, "effect.dispatched requires effect intent");
  }
  if (panelAssignment(current)?.status !== "executing" || panelAttempt(current)?.status !== "executing") {
    throw runtimeError("run_events_illegal", state.runId, "effect.dispatched requires executing assignment and attempt");
  }
  state.currentStep = { ...current, effectState: "dispatched" };
}

function foldEffectObserved(state: MutableState, plan: VnextCompiledPlan, event: VnextRunEvent, options: VnextFoldOptions): void {
  const current = requireGateEffect(state, plan, event);
  if (current.effectState === "observed-complete" || current.effectState === "observed-no-start" || current.effectState === "observed-unknown") {
    throw runtimeError("run_events_illegal", state.runId, "a completed observation cannot be rewritten");
  }
  if (current.effectState !== "intent" && current.effectState !== "dispatched") {
    throw runtimeError("run_events_illegal", state.runId, "effect.observed is not legal from this effect state");
  }
  const receipt = event.payload.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw runtimeError("run_events_illegal", state.runId, "effect.observed is missing receipt");
  }
  const receiptId = (receipt as { id?: unknown }).id;
  const receiptHash = (receipt as { hash?: unknown }).hash;
  const provider = (receipt as { provider?: unknown }).provider;
  const kind = (receipt as { kind?: unknown }).kind;
  if (typeof receiptId !== "string" || receiptId.length === 0) {
    throw runtimeError("run_events_illegal", state.runId, "effect.observed receipt.id is invalid");
  }
  if (provider !== "kxm-gate") {
    throw runtimeError("run_events_illegal", state.runId, "effect.observed receipt.provider must be kxm-gate");
  }
  const expectedKind = options.gateKind?.(current.stepId);
  if (expectedKind && kind !== expectedKind) {
    throw runtimeError("run_events_illegal", state.runId, "effect.observed receipt.kind does not match the pinned definition");
  }
  const looked = options.observationLookup?.(panelAttemptId(current)!, receiptId);
  let effectState: VnextRunEffectState = "observed-unknown";
  if (looked) {
    if (looked.completeness === "complete") {
      if (current.effectState === "intent" && expectedKind !== "artifacts-exist") {
        throw runtimeError("run_events_illegal", state.runId, "complete command observations require effect.dispatched");
      }
      effectState = "observed-complete";
    } else if (looked.completeness === "no-start") {
      if (current.effectState !== "intent") {
        throw runtimeError("run_events_illegal", state.runId, "no-start observations are only legal from intent");
      }
      effectState = "observed-no-start";
    } else {
      throw runtimeError("run_events_illegal", state.runId, "effect.observed cannot record an incomplete observation");
    }
  }
  state.currentStep = {
    ...current,
    effectState,
    observationId: receiptId,
    observationCompleteness: effectState === "observed-complete" ? "complete" : effectState === "observed-no-start" ? "no-start" : "unknown",
    ...(typeof receiptHash === "string" ? { observationHash: receiptHash } : {}),
  };
}

function foldEffectSettled(state: MutableState, plan: VnextCompiledPlan, event: VnextRunEvent): void {
  const current = requireGateEffect(state, plan, event);
  const hasOutcome = event.payload.outcome !== undefined;
  const hasEvidence = event.payload.evidenceRefs !== undefined;
  const receipt = event.payload.receipt;
  if (hasOutcome || hasEvidence) {
    if (current.effectState !== "observed-complete") {
      throw runtimeError("run_events_illegal", state.runId, "evaluated effect.settled requires observed-complete");
    }
    const outcome = stringPayload(event, "outcome");
    if (outcome !== "passed" && outcome !== "implementation-failure" && outcome !== "repro-missing") {
      throw runtimeError("run_events_illegal", state.runId, "evaluated effect.settled outcome is invalid");
    }
    const step = requireStep(plan, current.stepId, state.runId);
    if (!step.outcomes.includes(outcome)) {
      throw runtimeError("run_events_illegal", state.runId, `outcome ${outcome} is not declared for ${current.stepId}`);
    }
    const refs = event.payload.evidenceRefs;
    if (!Array.isArray(refs) || refs.length !== 1) {
      throw runtimeError("run_events_illegal", state.runId, "evaluated effect.settled requires exactly one evidenceRef");
    }
    const ref = refs[0] as { id?: unknown; kind?: unknown; hash?: unknown; status?: unknown };
    if (typeof ref.id !== "string" || ref.kind !== "gate" || typeof ref.hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(ref.hash) || ref.status !== "settled") {
      throw runtimeError("run_events_illegal", state.runId, "evaluated effect.settled evidenceRef is invalid");
    }
    state.currentStep = {
      ...current,
      effectState: "settled",
      settledOutcome: outcome,
      evidenceRefs: [{ id: ref.id, kind: "gate", hash: ref.hash, status: "settled" }],
    };
    return;
  }
  if (current.effectState !== "observed-complete" && current.effectState !== "observed-no-start") {
    throw runtimeError("run_events_illegal", state.runId, "proof-only effect.settled requires a prior observation");
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw runtimeError("run_events_illegal", state.runId, "proof-only effect.settled is missing observation receipt");
  }
  const receiptId = (receipt as { id?: unknown }).id;
  const receiptHash = (receipt as { hash?: unknown }).hash;
  if (receiptId !== current.observationId || (current.observationHash && receiptHash !== current.observationHash)) {
    throw runtimeError("run_events_illegal", state.runId, "proof-only effect.settled does not bind the prior observation");
  }
  state.currentStep = { ...current, effectState: "settled-proof" };
}

function foldEffectUncertain(state: MutableState, plan: VnextCompiledPlan, event: VnextRunEvent): void {
  const current = requireGateEffect(state, plan, event);
  if (current.effectState === "observed-complete" || current.effectState === "observed-no-start" || current.effectState === "observed-unknown") {
    throw runtimeError("run_events_illegal", state.runId, "blocked_uncertain after an observation is illegal");
  }
  if (current.effectState !== "intent" && current.effectState !== "dispatched") {
    throw runtimeError("run_events_illegal", state.runId, "effect.blocked_uncertain is not legal from this effect state");
  }
  const reason = stringPayload(event, "reason");
  const allowed = new Set(["timeout", "cancel", "stream-error", "stop-error", "lost-close", "signal-termination", "recording-error"]);
  if (!allowed.has(reason)) {
    throw runtimeError("run_events_illegal", state.runId, "effect.blocked_uncertain reason is invalid");
  }
  const receipt = event.payload.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw runtimeError("run_events_illegal", state.runId, "effect.blocked_uncertain is missing receipt");
  }
  const receiptId = (receipt as { id?: unknown }).id;
  if (typeof receiptId !== "string" || receiptId.length === 0) {
    throw runtimeError("run_events_illegal", state.runId, "effect.blocked_uncertain receipt.id is invalid");
  }
  state.currentStep = { ...current, effectState: "blocked_uncertain", observationId: receiptId };
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

function freezePanel(panel: MutablePanel): VnextFoldPanel {
  const assignments: Record<string, VnextFoldAssignmentState> = Object.create(null);
  for (const assignmentId of Object.keys(panel.assignments).sort()) {
    const assignment = panel.assignments[assignmentId]!;
    const attempts: Record<string, VnextFoldAttemptState> = Object.create(null);
    for (const attemptId of Object.keys(assignment.attempts).sort()) {
      attempts[attemptId] = Object.freeze(omitUndefined({ ...assignment.attempts[attemptId]! }));
    }
    assignments[assignmentId] = Object.freeze(omitUndefined({
      status: assignment.status,
      ...(assignment.currentAttemptId !== undefined ? { currentAttemptId: assignment.currentAttemptId } : {}),
      attempts: Object.freeze(attempts),
    }));
  }
  return Object.freeze({
    order: Object.freeze([...panel.order]),
    assignments: Object.freeze(assignments),
  });
}

function freezeCurrentStep(current: MutableCurrentStep): VnextRunCurrentStep {
  const panel = freezePanel(current.panel);
  const assignmentId = panel.order.length === 1 ? panel.order[0] : undefined;
  const assignment = assignmentId ? panel.assignments[assignmentId] : undefined;
  const attemptId = assignment?.currentAttemptId;
  const attempt = attemptId ? assignment?.attempts[attemptId] : undefined;
  return Object.freeze(omitUndefined({
    stepId: current.stepId,
    stepAttempt: current.stepAttempt,
    status: current.status,
    panel,
    ...(assignmentId !== undefined ? { assignmentId } : {}),
    ...(assignment ? { assignmentStatus: assignment.status } : {}),
    ...(attemptId !== undefined ? { attemptId } : {}),
    ...(attempt ? { attemptStatus: attempt.status } : {}),
    ...(current.outcome !== undefined ? { outcome: current.outcome } : {}),
    ...(current.effectId !== undefined ? { effectId: current.effectId } : {}),
    ...(current.effectState !== undefined ? { effectState: current.effectState } : {}),
    ...(current.observationId !== undefined ? { observationId: current.observationId } : {}),
    ...(current.observationHash !== undefined ? { observationHash: current.observationHash } : {}),
    ...(current.observationCompleteness !== undefined ? { observationCompleteness: current.observationCompleteness } : {}),
    ...(current.settledOutcome !== undefined ? { settledOutcome: current.settledOutcome } : {}),
    ...(current.evidenceRefs !== undefined ? { evidenceRefs: current.evidenceRefs } : {}),
  }));
}

function freezeState(state: MutableState): VnextRunState {
  const frozen: VnextRunState = {
    schema: VNEXT_RUN_STATE_SCHEMA,
    runId: state.runId,
    status: state.status,
    ...(state.runPlanHash !== undefined ? { runPlanHash: state.runPlanHash } : {}),
    ...(state.pendingStepId !== undefined ? { pendingStepId: state.pendingStepId } : {}),
    ...(state.currentStep !== undefined ? { currentStep: freezeCurrentStep(state.currentStep) } : {}),
    stepAttempts: Object.freeze({ ...state.stepAttempts }),
    edgeTransitions: Object.freeze({ ...state.edgeTransitions }),
    transitionsUsed: state.transitionsUsed,
    cancelRequested: state.cancelRequested,
    ...(state.terminalReason !== undefined ? { terminalReason: state.terminalReason } : {}),
    ...(state.terminalReason !== undefined && state.status === "failed" ? { failureReason: state.terminalReason } : {}),
    ...(state.drive !== undefined ? { drive: Object.freeze({ ...state.drive }) } : {}),
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

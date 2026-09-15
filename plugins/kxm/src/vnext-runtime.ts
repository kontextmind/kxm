import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextItem } from "./context.ts";
import {
  VnextConfigError,
  loadVnextProject,
  vnextCanonicalJson,
  type JsonObject,
  type JsonValue,
  type VnextConfigOptions,
  type VnextProjectBundle,
} from "./vnext-config.ts";
import { foldVnextRunState, isTerminalRunStatus, VNEXT_RUN_STATE_SCHEMA, vnextFoldPanelAttemptIds, type VnextRunState } from "./vnext-engine-fold.ts";
import { verifyVnextGateEvidence } from "./vnext-engine-evidence.ts";
import { loadVnextRunPlanEnvelope } from "./vnext-engine-plan.ts";
import {
  registerVnextRuntimeHandle,
  resolveVnextGateHold,
  unregisterVnextRuntimeHandle,
  vnextAttemptControllers,
} from "./vnext-runtime-owner.ts";
import {
  VNEXT_ABSENT_MEMORY_REVISION,
  VNEXT_RUN_EVENT_SCHEMA,
  VnextRunEventStore,
  VnextRuntimeRegistry,
  newVnextCommandId,
  newVnextEventId,
  newVnextRunId,
  runtimeError,
  vnextRuntimePaths,
  type VnextRunEvent,
  type VnextRunRecord,
  type VnextRunStatus,
} from "./vnext-runtime-store.ts";

/* ------------------------------------------------------------------ *
 * Policy revisions derived deterministically from the bundle
 * ------------------------------------------------------------------ */

export interface VnextPolicyRevisions {
  configRevision: string;
  memoryRevision: string;
  executorPolicyRevision: string;
  toolPolicyRevision: string;
}

export interface VnextMemoryRevisionOptions {
  promotedState?: readonly ContextItem[];
  memoryDir?: string;
  skillsDir?: string;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Of(input: string): string {
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

/** Executor policy: the union of executor identities referenced anywhere in the bundle. */
export function vnextExecutorPolicyRevision(bundle: VnextProjectBundle): string {
  const executors = new Set<string>();
  const defaultExecutor = bundle.project.value.defaultExecutor;
  if (typeof defaultExecutor === "string") executors.add(defaultExecutor);
  for (const agent of bundle.agents.values()) {
    const executor = agent.value.executor;
    if (typeof executor === "string") executors.add(executor);
  }
  return sha256Of(vnextCanonicalJson([...executors].sort() as JsonValue));
}

/** Tool policy: canonical agent/step tool ceilings across the bundle. */
export function vnextToolPolicyRevision(bundle: VnextProjectBundle): string {
  const policies: JsonObject[] = [];
  for (const agent of [...bundle.agents.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
    policies.push({ agent: agent.id ?? "unknown", tools: (objectValue(agent.value.tools) ?? null) as JsonValue });
  }
  for (const workflow of [...bundle.workflows.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
    const steps = Array.isArray(workflow.value.steps) ? workflow.value.steps : [];
    for (const step of steps) {
      const record = objectValue(step);
      if (record?.tools !== undefined) {
        policies.push({ workflow: workflow.id ?? "unknown", step: record.id ?? null, tools: (objectValue(record.tools) ?? null) as JsonValue });
      }
    }
  }
  return sha256Of(vnextCanonicalJson({ policies, gateRegistry: bundle.gateRegistry?.value ?? null }));
}

function collectMemoryFiles(dir: string, baseDir: string, ignoreSubdirs: Set<string> = new Set()): { relPath: string; fullPath: string }[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const results: { relPath: string; fullPath: string }[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignoreSubdirs.has(entry.name)) continue;
      results.push(...collectMemoryFiles(fullPath, baseDir, ignoreSubdirs));
    } else if (entry.isFile()) {
      const relPath = fullPath.slice(baseDir.length + 1).replace(/\\/g, "/");
      results.push({ relPath, fullPath });
    }
  }
  return results;
}

/**
 * Compute the memory revision pinned at run creation as the SHA-256 hash of the
 * Git-authored set (.kxm/memory, excluding candidates; .kxm/skills/promoted) plus
 * the promoted-state snapshot.
 */
export function computeVnextMemoryRevision(
  bundle: VnextProjectBundle,
  options: VnextMemoryRevisionOptions = {},
): string {
  const hash = createHash("sha256");

  // 1. Git-authored memory files (.kxm/memory), excluding candidates
  const memoryDir = options.memoryDir ?? join(bundle.projectRoot, ".kxm", "memory");
  const memoryFiles = collectMemoryFiles(memoryDir, memoryDir, new Set(["candidates"]))
    .sort((left, right) => compareCodeUnits(left.relPath, right.relPath));
  for (const file of memoryFiles) {
    hash.update(`memory:${file.relPath}\0`, "utf8");
    hash.update(readFileSync(file.fullPath));
    hash.update("\0", "utf8");
  }

  // 2. Promoted skills (.kxm/skills/promoted)
  const skillsDir = options.skillsDir ?? join(bundle.projectRoot, ".kxm", "skills");
  const promotedSkillsDir = join(skillsDir, "promoted");
  const skillFiles = collectMemoryFiles(promotedSkillsDir, promotedSkillsDir)
    .sort((left, right) => compareCodeUnits(left.relPath, right.relPath));
  for (const file of skillFiles) {
    hash.update(`skill:${file.relPath}\0`, "utf8");
    hash.update(readFileSync(file.fullPath));
    hash.update("\0", "utf8");
  }

  // 3. Promoted-state snapshot
  if (options.promotedState && options.promotedState.length > 0) {
    const currentItems = options.promotedState
      .filter((item) => !item.status || item.status === "current")
      .slice()
      .sort((left, right) => compareCodeUnits(left.id, right.id));
    for (const item of currentItems) {
      hash.update(`state:${item.id}\0`, "utf8");
      hash.update(vnextCanonicalJson(item as unknown as JsonValue), "utf8");
      hash.update("\0", "utf8");
    }
  }

  return `ctxrev_${hash.digest("hex")}`;
}

export function checkMemoryRevisionDrift(
  pinnedRevision: string,
  bundle: VnextProjectBundle,
  options?: VnextMemoryRevisionOptions,
): { drifted: boolean; currentRevision: string; pinnedRevision: string } {
  const currentRevision = computeVnextMemoryRevision(bundle, options);
  return {
    drifted: currentRevision !== pinnedRevision,
    currentRevision,
    pinnedRevision,
  };
}

export function vnextPolicyRevisions(
  bundle: VnextProjectBundle,
  options?: VnextMemoryRevisionOptions,
): VnextPolicyRevisions {
  return {
    configRevision: bundle.configRevision,
    memoryRevision: computeVnextMemoryRevision(bundle, options),
    executorPolicyRevision: vnextExecutorPolicyRevision(bundle),
    toolPolicyRevision: vnextToolPolicyRevision(bundle),
  };
}

export function vnextDeclaredRepositoryIds(bundle: VnextProjectBundle): string[] {
  return [...bundle.repositories.keys()].sort();
}

export function vnextDeclaredExecutorIds(bundle: VnextProjectBundle): string[] {
  return [...new Set([
    typeof bundle.project.value.defaultExecutor === "string" ? bundle.project.value.defaultExecutor : undefined,
    ...[...bundle.agents.values()].map((agent) => agent.value.executor).filter((value): value is string => typeof value === "string"),
  ].filter((value): value is string => value !== undefined))].sort();
}

export function vnextProjectAdmissionLimits(bundle: VnextProjectBundle): {
  maxConcurrentRuns: number;
  maxRunDurationMs?: number;
  maxAgentTimeMs?: number;
} {
  const limits = objectValue(bundle.project.value.limits);
  const maxConcurrentRuns = typeof limits?.maxConcurrentRuns === "number" && Number.isInteger(limits.maxConcurrentRuns) && limits.maxConcurrentRuns >= 1
    ? limits.maxConcurrentRuns
    : 1;
  return {
    maxConcurrentRuns,
    ...(typeof limits?.maxRunDurationMs === "number" ? { maxRunDurationMs: limits.maxRunDurationMs } : {}),
    ...(typeof limits?.maxAgentTimeMs === "number" ? { maxAgentTimeMs: limits.maxAgentTimeMs } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Run acceptance and lifecycle
 * ------------------------------------------------------------------ */

export interface VnextRunAcceptanceRequest {
  commandId?: string;
  workflowId: string;
  prompt: string;
}

export interface VnextRunAcceptance {
  accepted: boolean;
  idempotent: boolean;
  run: VnextRunRecord;
  event: VnextRunEvent;
}

export interface VnextRuntimeContext {
  registry: VnextRuntimeRegistry;
  projectRoot: string;
  projectId: string;
  homeRuntimeId: string;
  eventStore: VnextRunEventStore;
}

const closedRuntimeContexts = new WeakSet<VnextRuntimeContext>();
const runtimeCloseHooks = new WeakMap<VnextRuntimeContext, Set<() => void>>();

export function isVnextRuntimeContextClosed(context: VnextRuntimeContext): boolean {
  return closedRuntimeContexts.has(context);
}

export function registerVnextRuntimeCloseHook(context: VnextRuntimeContext, hook: () => void): () => void {
  if (closedRuntimeContexts.has(context)) {
    hook();
    return () => undefined;
  }
  let hooks = runtimeCloseHooks.get(context);
  if (!hooks) {
    hooks = new Set();
    runtimeCloseHooks.set(context, hooks);
  }
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

/**
 * Open (and register if needed) the runtime context for a project root.
 * homeRuntimeId is the accepting Runtime's identity: the supervisor passes its
 * active runtime id; direct callers must supply one explicitly. An existing
 * registration always wins and is revalidated immutably.
 */
export function openVnextRuntimeContext(
  projectRoot: string,
  options: VnextConfigOptions & { stateRoot?: string; now?: string; homeRuntimeId: string },
): VnextRuntimeContext {
  const paths = vnextRuntimePaths(options.stateRoot !== undefined ? { stateRoot: options.stateRoot } : {});
  const registry = new VnextRuntimeRegistry(paths.registryDb);
  try {
    const bundle = loadVnextProject(projectRoot, options);
    const projectId = String(bundle.project.value.id);
    const registration = registry.registerProject({
      projectId,
      projectRoot: bundle.projectRoot,
      homeRuntimeId: options.homeRuntimeId,
      configRevision: bundle.configRevision,
      now: options.now ?? new Date().toISOString(),
    });
    const eventStore = new VnextRunEventStore(join(paths.projectsDir, registration.projectKey, "run-events.db"));
    registerVnextRuntimeHandle(eventStore.path);
    return {
      registry,
      projectRoot: bundle.projectRoot,
      projectId: registration.projectId,
      homeRuntimeId: registration.homeRuntimeId,
      eventStore,
    };
  } catch (error) {
    registry.close();
    throw error;
  }
}

export function closeVnextRuntimeContext(context: VnextRuntimeContext): void {
  if (closedRuntimeContexts.has(context)) return;
  closedRuntimeContexts.add(context);
  const hooks = runtimeCloseHooks.get(context);
  runtimeCloseHooks.delete(context);
  if (hooks) {
    for (const hook of hooks) {
      try {
        hook();
      } catch {
        // Close must still close stores; observer cleanup is best-effort.
      }
    }
  }
  unregisterVnextRuntimeHandle(context.eventStore.path);
  context.eventStore.close();
  context.registry.close();
}

const RUNTIME_EPOCH_NS = process.hrtime.bigint();

/** Intra-process monotonic nanoseconds as a decimal string, ordered only by sequence. */
export function vnextMonotonicNs(): string {
  return (process.hrtime.bigint() - RUNTIME_EPOCH_NS).toString();
}

export function vnextIncrementMonotonicNs(value: string): string {
  return (BigInt(value) + 1n).toString();
}

export function vnextEventBase(context: VnextRuntimeContext, run: VnextRunRecord, now: string, monotonicNs: string, commandId?: string): Omit<VnextRunEvent, "eventId" | "eventType" | "sequence" | "payload"> {
  return {
    schema: VNEXT_RUN_EVENT_SCHEMA,
    projectId: context.projectId,
    runId: run.runId,
    homeRuntimeId: run.homeRuntimeId,
    occurredAt: now,
    recordedAt: now,
    monotonicNs,
    configRevision: run.configRevision,
    memoryRevision: run.memoryRevision,
    executorPolicyRevision: run.executorPolicyRevision,
    toolPolicyRevision: run.toolPolicyRevision,
    ...(commandId !== undefined ? { commandId } : {}),
  };
}

export interface VnextRunAcceptanceOptions {
  now?: string;
  monotonicNs?: string;
  memoryRevision?: string;
  promotedState?: readonly ContextItem[];
  memoryDir?: string;
  skillsDir?: string;
}

/** Accept a run idempotently: a repeated commandId returns the prior acceptance. */
export function acceptVnextRun(
  context: VnextRuntimeContext,
  bundle: VnextProjectBundle,
  request: VnextRunAcceptanceRequest,
  options: VnextRunAcceptanceOptions = {},
): VnextRunAcceptance {
  const commandId = request.commandId ?? newVnextCommandId();
  const now = options.now ?? new Date().toISOString();
  const monotonicNs = options.monotonicNs ?? vnextMonotonicNs();

  const workflow = bundle.workflows.get(request.workflowId);
  if (!workflow) {
    throw runtimeError("run_workflow_unknown", ".kxm/workflows", `workflow ${request.workflowId} does not exist in this project`);
  }
  const revisions = vnextPolicyRevisions(bundle, options);
  const memoryRevision = options.memoryRevision ?? revisions.memoryRevision;
  const promptSha256 = `sha256:${createHash("sha256").update(request.prompt, "utf8").digest("hex")}`;

  return context.eventStore.transaction(() => {
    const prior = context.eventStore.command(commandId);
    if (prior) {
      if (prior.kind !== "run.accept") {
        throw runtimeError("run_command_conflict", commandId, `command ${commandId} was already used for ${prior.kind}`);
      }
      const run = context.eventStore.run(prior.runId);
      if (!run) throw runtimeError("run_command_corrupt", commandId, "idempotent command references a missing run");
      if (run.workflowId !== request.workflowId || run.promptSha256 !== promptSha256) {
        throw runtimeError("run_command_conflict", commandId, "idempotent retry must repeat the same workflow and prompt");
      }
      const events = context.eventStore.events(run.runId, 0, 1);
      if (events.length === 0) throw runtimeError("run_command_corrupt", commandId, "idempotent command references a run with no creation event");
      return { accepted: true, idempotent: true, run, event: events[0]! };
    }

    const runId = newVnextRunId();
    const payload: Record<string, unknown> = {
      workflowId: request.workflowId,
      status: "created",
      promptHash: promptSha256,
      repositoryIds: vnextDeclaredRepositoryIds(bundle),
      executorIds: vnextDeclaredExecutorIds(bundle),
    };
    const event: VnextRunEvent = {
      schema: VNEXT_RUN_EVENT_SCHEMA,
      eventId: newVnextEventId(),
      eventType: "run.created",
      projectId: context.projectId,
      runId,
      homeRuntimeId: context.homeRuntimeId,
      sequence: 1,
      commandId,
      occurredAt: now,
      recordedAt: now,
      monotonicNs,
      configRevision: revisions.configRevision,
      memoryRevision,
      executorPolicyRevision: revisions.executorPolicyRevision,
      toolPolicyRevision: revisions.toolPolicyRevision,
      payload,
    };
    const run: VnextRunRecord = {
      runId,
      projectId: context.projectId,
      homeRuntimeId: context.homeRuntimeId,
      workflowId: request.workflowId,
      promptSha256,
      status: "created",
      configRevision: revisions.configRevision,
      memoryRevision,
      executorPolicyRevision: revisions.executorPolicyRevision,
      toolPolicyRevision: revisions.toolPolicyRevision,
      createdAt: now,
      updatedAt: now,
    };
    context.eventStore.insertRun(run);
    context.eventStore.appendEvent(event);
    context.eventStore.insertCommand({
      commandId,
      runId,
      kind: "run.accept",
      result: { runId, homeRuntimeId: context.homeRuntimeId, status: "created" },
      recordedAt: now,
    });
    context.eventStore.putRunPrompt(runId, request.prompt);
    return { accepted: true, idempotent: false, run, event };
  });
}

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

export function foldStoredVnextRun(context: VnextRuntimeContext, run: VnextRunRecord): VnextRunState {
  const events = context.eventStore.events(run.runId, 0, 1_000_000);
  const planRow = context.eventStore.runPlan(run.runId);
  if (!planRow && events.some((event) => event.eventType.startsWith("step.") || event.eventType.startsWith("effect.") || event.payload.status === "preparing" || event.payload.status === "running" || event.payload.status === "cancelling")) {
    throw runtimeError("run_plan_missing", run.runId, "run reached preparing or later without a pinned plan");
  }
  const envelope = planRow ? loadVnextRunPlanEnvelope(context.eventStore, run) : undefined;
  const state = foldVnextRunState(run, envelope?.plan, events, envelope
    ? {
      observationLookup: (attemptId, observationId) => {
        const row = context.eventStore.gateObservationForAttempt(attemptId);
        if (!row || row.observationId !== observationId) return undefined;
        return { completeness: row.completeness };
      },
      gateKind: (stepId) => {
        const step = envelope.plan.steps[stepId];
        if (!step || step.kind !== "gate") return undefined;
        return envelope.gates.definitions[step.gate]?.kind;
      },
    }
    : {});
  if (envelope) verifyVnextGateEvidence(context.eventStore, run, envelope, events, state);
  assertStoredProjection(context, run);
  return state;
}

function storedProjectionSchema(stateJson: string): string | undefined {
  try {
    const parsed = JSON.parse(stateJson) as { schema?: unknown };
    return typeof parsed.schema === "string" ? parsed.schema : undefined;
  } catch {
    return undefined;
  }
}

function assertStoredProjection(context: VnextRuntimeContext, run: VnextRunRecord): void {
  const stored = context.eventStore.runState(run.runId);
  if (!stored) return;
  const schema = storedProjectionSchema(stored.state);
  if (schema !== VNEXT_RUN_STATE_SCHEMA) {
    throw runtimeError("run_projection_divergent", run.runId, "stored run_state does not match the folded projection");
  }
}

/** Fold a stored run into its current status with evidence verification. */
export function readVnextRunStatus(context: VnextRuntimeContext, run: VnextRunRecord): VnextRunStatus {
  return foldStoredVnextRun(context, run).status;
}

function persistProjection(context: VnextRuntimeContext, run: VnextRunRecord, state: VnextRunState, now: string): VnextRunRecord {
  const canonical = vnextCanonicalJson(state as unknown as JsonValue);
  const stored = context.eventStore.runState(run.runId);
  if (stored && stored.state !== canonical) {
    throw runtimeError("run_projection_divergent", run.runId, "stored run_state does not match the folded projection");
  }
  if (!stored) {
    context.eventStore.upsertRunState({
      runId: run.runId,
      lastSequence: context.eventStore.nextSequence(run.runId) - 1,
      state: canonical,
    });
  }
  const updated = { ...run, status: state.status, updatedAt: now };
  if (run.status !== state.status) context.eventStore.updateRunStatus(run.runId, state.status, now);
  return updated;
}

/** Rebuild the stored run row from the event log; returns the projected record. */
export function rebuildVnextRunProjection(context: VnextRuntimeContext, runId: string): VnextRunRecord {
  const stored = context.eventStore.run(runId);
  if (!stored) throw runtimeError("run_unknown", runId, "run does not exist in this event store");
  const state = foldStoredVnextRun(context, stored);
  const events = context.eventStore.events(runId, 0, 1_000_000);
  if (events.length === 0) throw runtimeError("run_events_corrupt", runId, "run has no events");
  const last = events[events.length - 1]!;
  return persistProjection(context, stored, state, last.occurredAt);
}

export function persistVnextRunState(context: VnextRuntimeContext, runId: string, state: VnextRunState, lastSequence: number): void {
  const stored = context.eventStore.runState(runId);
  if (stored) {
    const schema = storedProjectionSchema(stored.state);
    if (schema !== VNEXT_RUN_STATE_SCHEMA) {
      throw runtimeError("run_projection_divergent", runId, "stored run_state does not match the folded projection");
    }
  }
  context.eventStore.upsertRunState({
    runId,
    lastSequence,
    state: vnextCanonicalJson(state as unknown as JsonValue),
  });
}

/* ------------------------------------------------------------------ *
 * Cancel
 * ------------------------------------------------------------------ */

export interface VnextRunCancelResult {
  run: VnextRunRecord;
  idempotent: boolean;
  events: VnextRunEvent[];
}

export function cancelVnextRun(
  context: VnextRuntimeContext,
  runId: string,
  options: { commandId?: string; now?: string; monotonicNs?: string; reason?: string } = {},
): VnextRunCancelResult {
  const commandId = options.commandId ?? newVnextCommandId();
  const now = options.now ?? new Date().toISOString();
  const monotonicNs = options.monotonicNs ?? vnextMonotonicNs();
  const abortControllers: AbortController[] = [];

  const result = context.eventStore.transaction(() => {
    const prior = context.eventStore.command(commandId);
    if (prior) {
      if (prior.kind !== "run.cancel" || prior.runId !== runId) {
        throw runtimeError("run_command_conflict", commandId, `command ${commandId} was already used for ${prior.kind}${prior.runId === runId ? "" : " on a different run"}`);
      }
      const run = context.eventStore.run(prior.runId);
      if (!run) throw runtimeError("run_command_corrupt", commandId, "idempotent command references a missing run");
      return { run, idempotent: true, events: [] as VnextRunEvent[] };
    }
    const run = context.eventStore.run(runId);
    if (!run) throw runtimeError("run_unknown", runId, "run does not exist in this event store");
    const folded = foldStoredVnextRun(context, run);
    if (isTerminalRunStatus(folded.status) || folded.status === "cancelling") {
      context.eventStore.insertCommand({
        commandId,
        runId,
        kind: "run.cancel",
        result: { runId, status: folded.status },
        recordedAt: now,
      });
      return { run: { ...run, status: folded.status }, idempotent: true, events: [] as VnextRunEvent[] };
    }

    const events: VnextRunEvent[] = [];
    let sequence = context.eventStore.nextSequence(runId);
    let nextMono = monotonicNs;
    const push = (eventType: string, payload: Record<string, unknown>): VnextRunEvent => {
      const event: VnextRunEvent = {
        ...vnextEventBase(context, run, now, nextMono, commandId),
        eventId: newVnextEventId(),
        eventType,
        sequence: sequence++,
        payload,
      };
      nextMono = vnextIncrementMonotonicNs(nextMono);
      events.push(event);
      return event;
    };

    const cancelReason = options.reason ?? "operator_cancel";
    const activeAttempt = Boolean(folded.currentStep?.attemptId) || vnextFoldPanelAttemptIds(folded.currentStep).length > 0;
    push("run.cancel_requested", {
      actor: { kind: "runtime", id: context.homeRuntimeId },
      reason: cancelReason,
    });

    let status: VnextRunStatus = "cancelled";
    if (folded.status === "running" && activeAttempt) {
      status = "cancelling";
      push("run.status_changed", { status: "cancelling", reason: cancelReason });
      const attemptIds = new Set(vnextFoldPanelAttemptIds(folded.currentStep));
      if (folded.currentStep?.attemptId) attemptIds.add(folded.currentStep.attemptId);
      for (const attemptId of attemptIds) {
        const capability = context.eventStore.capabilityByAttempt(attemptId);
        if (capability && capability.state === "issued") {
          context.eventStore.settleCapability(attemptId, "revoked");
        }
      }
      for (const owned of vnextAttemptControllers(context.eventStore.path, runId)) {
        abortControllers.push(owned.controller);
      }
    } else if (folded.status === "blocked_uncertain") {
      push("run.status_changed", { status: "cancelling", reason: cancelReason });
      const attemptId = folded.currentStep?.attemptId;
      if (attemptId) {
        const capability = context.eventStore.capabilityByAttempt(attemptId);
        if (capability && (capability.state === "issued" || capability.state === "revoked")) {
          context.eventStore.settleCapability(attemptId, "revoked");
        }
        resolveVnextGateHold(context.eventStore.path, runId, attemptId);
      }
      for (const owned of vnextAttemptControllers(context.eventStore.path, runId)) {
        abortControllers.push(owned.controller);
      }
      push("run.status_changed", { status: "cancelled", reason: cancelReason });
      status = "cancelled";
    } else if (folded.status === "running" && !activeAttempt) {
      push("run.status_changed", { status: "cancelling", reason: cancelReason });
      push("run.status_changed", { status: "cancelled", reason: cancelReason });
    } else {
      push("run.status_changed", { status: "cancelled", reason: cancelReason });
    }

    for (const event of events) context.eventStore.appendEvent(event);
    const nextState = foldStoredVnextRun(context, run);
    persistVnextRunState(context, runId, nextState, events[events.length - 1]!.sequence);
    context.eventStore.updateRunStatus(runId, status, now);
    context.eventStore.insertCommand({
      commandId,
      runId,
      kind: "run.cancel",
      result: { runId, status },
      recordedAt: now,
    });
    return { run: { ...run, status, updatedAt: now }, idempotent: false, events };
  });

  for (const controller of abortControllers) controller.abort();
  return result;
}

/* ------------------------------------------------------------------ *
 * Revision drift check
 * ------------------------------------------------------------------ */

/** Runs pin revisions at acceptance; drift is reported, never silently adopted. */
export function vnextRunRevisionDrift(run: VnextRunRecord, bundle: VnextProjectBundle): { configDrift: boolean; currentRevision: string; pinnedRevision: string } {
  return {
    configDrift: run.configRevision !== bundle.configRevision,
    currentRevision: bundle.configRevision,
    pinnedRevision: run.configRevision,
  };
}

export function assertVnextConfigError(error: unknown): asserts error is VnextConfigError {
  if (!(error instanceof VnextConfigError)) throw error;
}

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextItem } from "./context.ts";
import {
  KxmConfigError,
  loadKxmProject,
  kxmCanonicalJson,
  type JsonObject,
  type JsonValue,
  type KxmConfigOptions,
  type KxmProjectBundle,
} from "./project-config.ts";
import { foldKxmRunState, isTerminalRunStatus, KXM_RUN_STATE_SCHEMA, kxmFoldPanelAttemptIds, type KxmRunState } from "./engine-fold.ts";
import { verifyKxmGateEvidence } from "./engine-evidence.ts";
import { loadKxmRunPlanEnvelope } from "./engine-plan.ts";
import {
  registerKxmRuntimeHandle,
  resolveKxmGateHold,
  unregisterKxmRuntimeHandle,
  kxmAttemptControllers,
} from "./runtime-owner.ts";
import {
  KXM_ABSENT_MEMORY_REVISION,
  KXM_RUN_EVENT_SCHEMA,
  KxmRunEventStore,
  KxmRuntimeRegistry,
  newKxmCommandId,
  newKxmEventId,
  newKxmRunId,
  runtimeError,
  kxmRuntimePaths,
  type KxmRunEvent,
  type KxmRunRecord,
  type KxmRunStatus,
} from "./runtime-store.ts";

/* ------------------------------------------------------------------ *
 * Policy revisions derived deterministically from the bundle
 * ------------------------------------------------------------------ */

export interface KxmPolicyRevisions {
  configRevision: string;
  memoryRevision: string;
  executorPolicyRevision: string;
  toolPolicyRevision: string;
}

export interface KxmMemoryRevisionOptions {
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
export function kxmExecutorPolicyRevision(bundle: KxmProjectBundle): string {
  const executors = new Set<string>();
  const defaultExecutor = bundle.project.value.defaultExecutor;
  if (typeof defaultExecutor === "string") executors.add(defaultExecutor);
  for (const agent of bundle.agents.values()) {
    const executor = agent.value.executor;
    if (typeof executor === "string") executors.add(executor);
  }
  return sha256Of(kxmCanonicalJson([...executors].sort() as JsonValue));
}

/** Tool policy: canonical agent/step tool ceilings across the bundle. */
export function kxmToolPolicyRevision(bundle: KxmProjectBundle): string {
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
  return sha256Of(kxmCanonicalJson({ policies, gateRegistry: bundle.gateRegistry?.value ?? null }));
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
export function computeKxmMemoryRevision(
  bundle: KxmProjectBundle,
  options: KxmMemoryRevisionOptions = {},
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
      hash.update(kxmCanonicalJson(item as unknown as JsonValue), "utf8");
      hash.update("\0", "utf8");
    }
  }

  return `ctxrev_${hash.digest("hex")}`;
}

export function checkMemoryRevisionDrift(
  pinnedRevision: string,
  bundle: KxmProjectBundle,
  options?: KxmMemoryRevisionOptions,
): { drifted: boolean; currentRevision: string; pinnedRevision: string } {
  const currentRevision = computeKxmMemoryRevision(bundle, options);
  return {
    drifted: currentRevision !== pinnedRevision,
    currentRevision,
    pinnedRevision,
  };
}

export function kxmPolicyRevisions(
  bundle: KxmProjectBundle,
  options?: KxmMemoryRevisionOptions,
): KxmPolicyRevisions {
  return {
    configRevision: bundle.configRevision,
    memoryRevision: computeKxmMemoryRevision(bundle, options),
    executorPolicyRevision: kxmExecutorPolicyRevision(bundle),
    toolPolicyRevision: kxmToolPolicyRevision(bundle),
  };
}

export function kxmDeclaredRepositoryIds(bundle: KxmProjectBundle): string[] {
  return [...bundle.repositories.keys()].sort();
}

export function kxmDeclaredExecutorIds(bundle: KxmProjectBundle): string[] {
  return [...new Set([
    typeof bundle.project.value.defaultExecutor === "string" ? bundle.project.value.defaultExecutor : undefined,
    ...[...bundle.agents.values()].map((agent) => agent.value.executor).filter((value): value is string => typeof value === "string"),
  ].filter((value): value is string => value !== undefined))].sort();
}

export function kxmProjectAdmissionLimits(bundle: KxmProjectBundle): {
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

export interface KxmRunAcceptanceRequest {
  commandId?: string;
  workflowId: string;
  prompt: string;
}

export interface KxmRunAcceptance {
  accepted: boolean;
  idempotent: boolean;
  run: KxmRunRecord;
  event: KxmRunEvent;
}

export interface KxmRuntimeContext {
  registry: KxmRuntimeRegistry;
  projectRoot: string;
  projectId: string;
  homeRuntimeId: string;
  eventStore: KxmRunEventStore;
  /** Deterministic revision of the loaded project configuration (`sha256:...`). */
  readonly configRevision: string;
  /**
   * Optional clock for **run-duration budget accounting only**. Budgets are
   * measured from the log's `runningSince`; this answers "what time is it now"
   * at the far end of that subtraction so engine tests can exercise a budget
   * boundary without racing a loaded event loop.
   *
   * It is honoured only when `KXM_DETERMINISTIC_TEST_CLOCK=1` is set (see
   * `budgetNowIso` in `engine.ts`), it is never consulted for event timestamps,
   * and the Runtime supervisor does not pass one — so no production path can
   * freeze a budget by supplying a stale clock.
   */
  readonly budgetClock?: () => string;
}

const closedRuntimeContexts = new WeakSet<KxmRuntimeContext>();
const runtimeCloseHooks = new WeakMap<KxmRuntimeContext, Set<() => void>>();

export function isKxmRuntimeContextClosed(context: KxmRuntimeContext): boolean {
  return closedRuntimeContexts.has(context);
}

export function registerKxmRuntimeCloseHook(context: KxmRuntimeContext, hook: () => void): () => void {
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
export function openKxmRuntimeContext(
  projectRoot: string,
  options: KxmConfigOptions & {
    stateRoot?: string;
    now?: string;
    homeRuntimeId: string;
    budgetClock?: () => string;
  },
): KxmRuntimeContext {
  const paths = kxmRuntimePaths(options.stateRoot !== undefined ? { stateRoot: options.stateRoot } : {});
  const registry = new KxmRuntimeRegistry(paths.registryDb);
  try {
    const bundle = loadKxmProject(projectRoot, options);
    const projectId = String(bundle.project.value.id);
    const registration = registry.registerProject({
      projectId,
      projectRoot: bundle.projectRoot,
      homeRuntimeId: options.homeRuntimeId,
      configRevision: bundle.configRevision,
      now: options.now ?? new Date().toISOString(),
    });
    const eventStore = new KxmRunEventStore(join(paths.projectsDir, registration.projectKey, "run-events.db"));
    registerKxmRuntimeHandle(eventStore.path);
    return {
      registry,
      projectRoot: bundle.projectRoot,
      projectId: registration.projectId,
      homeRuntimeId: registration.homeRuntimeId,
      eventStore,
      configRevision: bundle.configRevision,
      ...(options.budgetClock ? { budgetClock: options.budgetClock } : {}),
    };
  } catch (error) {
    registry.close();
    throw error;
  }
}

export function closeKxmRuntimeContext(context: KxmRuntimeContext): void {
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
  unregisterKxmRuntimeHandle(context.eventStore.path);
  context.eventStore.close();
  context.registry.close();
}

const RUNTIME_EPOCH_NS = process.hrtime.bigint();

/** Intra-process monotonic nanoseconds as a decimal string, ordered only by sequence. */
export function kxmMonotonicNs(): string {
  return (process.hrtime.bigint() - RUNTIME_EPOCH_NS).toString();
}

export function kxmIncrementMonotonicNs(value: string): string {
  return (BigInt(value) + 1n).toString();
}

export function kxmEventBase(context: KxmRuntimeContext, run: KxmRunRecord, now: string, monotonicNs: string, commandId?: string): Omit<KxmRunEvent, "eventId" | "eventType" | "sequence" | "payload"> {
  return {
    schema: KXM_RUN_EVENT_SCHEMA,
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

export interface KxmRunAcceptanceOptions {
  now?: string;
  monotonicNs?: string;
  memoryRevision?: string;
  promotedState?: readonly ContextItem[];
  memoryDir?: string;
  skillsDir?: string;
}

/** Accept a run idempotently: a repeated commandId returns the prior acceptance. */
export function acceptKxmRun(
  context: KxmRuntimeContext,
  bundle: KxmProjectBundle,
  request: KxmRunAcceptanceRequest,
  options: KxmRunAcceptanceOptions = {},
): KxmRunAcceptance {
  const commandId = request.commandId ?? newKxmCommandId();
  const now = options.now ?? new Date().toISOString();
  const monotonicNs = options.monotonicNs ?? kxmMonotonicNs();

  const workflow = bundle.workflows.get(request.workflowId);
  if (!workflow) {
    throw runtimeError("run_workflow_unknown", ".kxm/workflows", `workflow ${request.workflowId} does not exist in this project`);
  }
  const revisions = kxmPolicyRevisions(bundle, options);
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

    const runId = newKxmRunId();
    const payload: Record<string, unknown> = {
      workflowId: request.workflowId,
      status: "created",
      promptHash: promptSha256,
      repositoryIds: kxmDeclaredRepositoryIds(bundle),
      executorIds: kxmDeclaredExecutorIds(bundle),
    };
    const event: KxmRunEvent = {
      schema: KXM_RUN_EVENT_SCHEMA,
      eventId: newKxmEventId(),
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
    const run: KxmRunRecord = {
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

export function foldStoredKxmRun(context: KxmRuntimeContext, run: KxmRunRecord): KxmRunState {
  const events = context.eventStore.events(run.runId, 0, 1_000_000);
  const planRow = context.eventStore.runPlan(run.runId);
  if (!planRow && events.some((event) => event.eventType.startsWith("step.") || event.eventType.startsWith("effect.") || event.payload.status === "preparing" || event.payload.status === "running" || event.payload.status === "cancelling")) {
    throw runtimeError("run_plan_missing", run.runId, "run reached preparing or later without a pinned plan");
  }
  const envelope = planRow ? loadKxmRunPlanEnvelope(context.eventStore, run) : undefined;
  const state = foldKxmRunState(run, envelope?.plan, events, envelope
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
      projectLimits: envelope.projectLimits,
    }
    : {});
  if (envelope) verifyKxmGateEvidence(context.eventStore, run, envelope, events, state);
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

function assertStoredProjection(context: KxmRuntimeContext, run: KxmRunRecord): void {
  const stored = context.eventStore.runState(run.runId);
  if (!stored) return;
  const schema = storedProjectionSchema(stored.state);
  if (schema !== KXM_RUN_STATE_SCHEMA) {
    throw runtimeError("run_projection_divergent", run.runId, "stored run_state does not match the folded projection");
  }
}

/** Fold a stored run into its current status with evidence verification. */
export function readKxmRunStatus(context: KxmRuntimeContext, run: KxmRunRecord): KxmRunStatus {
  return foldStoredKxmRun(context, run).status;
}

function persistProjection(context: KxmRuntimeContext, run: KxmRunRecord, state: KxmRunState, now: string): KxmRunRecord {
  const canonical = kxmCanonicalJson(state as unknown as JsonValue);
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
export function rebuildKxmRunProjection(context: KxmRuntimeContext, runId: string): KxmRunRecord {
  const stored = context.eventStore.run(runId);
  if (!stored) throw runtimeError("run_unknown", runId, "run does not exist in this event store");
  const state = foldStoredKxmRun(context, stored);
  const events = context.eventStore.events(runId, 0, 1_000_000);
  if (events.length === 0) throw runtimeError("run_events_corrupt", runId, "run has no events");
  const last = events[events.length - 1]!;
  return persistProjection(context, stored, state, last.occurredAt);
}

/** Read-only projection: folds the event log over the stored record without
 * persisting. GET paths must not write (no run_state upsert, no status
 * update, no run_projection_divergent throw) — the event log stays the sole
 * source of truth and the folded status is returned as-is. */
export function projectKxmRunReadOnly(context: KxmRuntimeContext, runId: string): KxmRunRecord {
  const stored = context.eventStore.run(runId);
  if (!stored) throw runtimeError("run_unknown", runId, "run does not exist in this event store");
  const state = foldStoredKxmRun(context, stored);
  const events = context.eventStore.events(runId, 0, 1_000_000);
  if (events.length === 0) throw runtimeError("run_events_corrupt", runId, "run has no events");
  const last = events[events.length - 1]!;
  return { ...stored, status: state.status, updatedAt: last.occurredAt };
}

export function persistKxmRunState(context: KxmRuntimeContext, runId: string, state: KxmRunState, lastSequence: number): void {
  const stored = context.eventStore.runState(runId);
  if (stored) {
    const schema = storedProjectionSchema(stored.state);
    if (schema !== KXM_RUN_STATE_SCHEMA) {
      throw runtimeError("run_projection_divergent", runId, "stored run_state does not match the folded projection");
    }
  }
  context.eventStore.upsertRunState({
    runId,
    lastSequence,
    state: kxmCanonicalJson(state as unknown as JsonValue),
  });
}

/* ------------------------------------------------------------------ *
 * Cancel
 * ------------------------------------------------------------------ */

export interface KxmRunCancelResult {
  run: KxmRunRecord;
  idempotent: boolean;
  events: KxmRunEvent[];
}

export function cancelKxmRun(
  context: KxmRuntimeContext,
  runId: string,
  options: {
    commandId?: string;
    now?: string;
    monotonicNs?: string;
    reason?: string;
    budget?: { budgetMs: number; elapsedMs: number; source: "workflow" | "project" | "both" };
  } = {},
): KxmRunCancelResult {
  const commandId = options.commandId ?? newKxmCommandId();
  const now = options.now ?? new Date().toISOString();
  const monotonicNs = options.monotonicNs ?? kxmMonotonicNs();
  const abortControllers: AbortController[] = [];

  const result = context.eventStore.transaction(() => {
    const prior = context.eventStore.command(commandId);
    if (prior) {
      if (prior.kind !== "run.cancel" || prior.runId !== runId) {
        throw runtimeError("run_command_conflict", commandId, `command ${commandId} was already used for ${prior.kind}${prior.runId === runId ? "" : " on a different run"}`);
      }
      const run = context.eventStore.run(prior.runId);
      if (!run) throw runtimeError("run_command_corrupt", commandId, "idempotent command references a missing run");
      return { run, idempotent: true, events: [] as KxmRunEvent[] };
    }
    const run = context.eventStore.run(runId);
    if (!run) throw runtimeError("run_unknown", runId, "run does not exist in this event store");
    const folded = foldStoredKxmRun(context, run);
    if (isTerminalRunStatus(folded.status) || folded.status === "cancelling") {
      context.eventStore.insertCommand({
        commandId,
        runId,
        kind: "run.cancel",
        result: { runId, status: folded.status },
        recordedAt: now,
      });
      return { run: { ...run, status: folded.status }, idempotent: true, events: [] as KxmRunEvent[] };
    }

    const events: KxmRunEvent[] = [];
    let sequence = context.eventStore.nextSequence(runId);
    let nextMono = monotonicNs;
    const push = (eventType: string, payload: Record<string, unknown>): KxmRunEvent => {
      const event: KxmRunEvent = {
        ...kxmEventBase(context, run, now, nextMono, commandId),
        eventId: newKxmEventId(),
        eventType,
        sequence: sequence++,
        payload,
      };
      nextMono = kxmIncrementMonotonicNs(nextMono);
      events.push(event);
      return event;
    };

    const cancelReason = options.reason ?? "operator_cancel";
    const activeAttempt = Boolean(folded.currentStep?.attemptId) || kxmFoldPanelAttemptIds(folded.currentStep).length > 0;
    const cancelPayload: Record<string, unknown> = {
      actor: { kind: "runtime", id: context.homeRuntimeId },
      reason: cancelReason,
    };
    if (cancelReason === "budget_run_duration") {
      if (!options.budget) {
        throw runtimeError("run_events_illegal", runId, "budget_run_duration requires a budget payload");
      }
      cancelPayload.budget = options.budget;
    }
    push("run.cancel_requested", cancelPayload);

    let status: KxmRunStatus = "cancelled";
    if (folded.status === "running" && activeAttempt) {
      status = "cancelling";
      push("run.status_changed", { status: "cancelling", reason: cancelReason });
      const attemptIds = new Set(kxmFoldPanelAttemptIds(folded.currentStep));
      if (folded.currentStep?.attemptId) attemptIds.add(folded.currentStep.attemptId);
      for (const attemptId of attemptIds) {
        const capability = context.eventStore.capabilityByAttempt(attemptId);
        if (capability && capability.state === "issued") {
          context.eventStore.settleCapability(attemptId, "revoked");
        }
      }
      for (const owned of kxmAttemptControllers(context.eventStore.path, runId)) {
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
        resolveKxmGateHold(context.eventStore.path, runId, attemptId);
      }
      for (const owned of kxmAttemptControllers(context.eventStore.path, runId)) {
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
    const nextState = foldStoredKxmRun(context, run);
    persistKxmRunState(context, runId, nextState, events[events.length - 1]!.sequence);
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
export function kxmRunRevisionDrift(run: KxmRunRecord, bundle: KxmProjectBundle): { configDrift: boolean; currentRevision: string; pinnedRevision: string } {
  return {
    configDrift: run.configRevision !== bundle.configRevision,
    currentRevision: bundle.configRevision,
    pinnedRevision: run.configRevision,
  };
}

export function assertKxmConfigError(error: unknown): asserts error is KxmConfigError {
  if (!(error instanceof KxmConfigError)) throw error;
}

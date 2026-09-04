import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  VnextConfigError,
  loadVnextProject,
  vnextCanonicalJson,
  type JsonObject,
  type JsonValue,
  type VnextConfigOptions,
  type VnextProjectBundle,
} from "./vnext-config.ts";
import {
  VnextRunEventStore,
  VnextRuntimeRegistry,
  newVnextCommandId,
  newVnextEventId,
  newVnextRunId,
  projectRuntimeKey,
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
  memoryRevision?: string;
  executorPolicyRevision: string;
  toolPolicyRevision: string;
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
  return sha256Of(vnextCanonicalJson(policies));
}

export function vnextPolicyRevisions(bundle: VnextProjectBundle): VnextPolicyRevisions {
  return {
    configRevision: bundle.configRevision,
    executorPolicyRevision: vnextExecutorPolicyRevision(bundle),
    toolPolicyRevision: vnextToolPolicyRevision(bundle),
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
  context.eventStore.close();
  context.registry.close();
}

const RUN_CREATED_REQUIRED = ["workflowId", "status", "repositories", "executors"];
const RUNTIME_EPOCH_NS = process.hrtime.bigint();

/** Millisecond-precision monotonic nanoseconds relative to process start (safe below 2^53). */
export function vnextMonotonicNs(): number {
  return Number(process.hrtime.bigint() - RUNTIME_EPOCH_NS);
}

function validateRunCreatedPayload(payload: Record<string, unknown>): void {
  for (const field of RUN_CREATED_REQUIRED) {
    if (payload[field] === undefined) {
      throw runtimeError("run_event_invalid", "run.created", `run.created payload is missing ${field}`);
    }
  }
}

/** Accept a run idempotently: a repeated commandId returns the prior acceptance. */
export function acceptVnextRun(
  context: VnextRuntimeContext,
  bundle: VnextProjectBundle,
  request: VnextRunAcceptanceRequest,
  options: { now?: string; monotonicNs?: number } = {},
): VnextRunAcceptance {
  const commandId = request.commandId ?? newVnextCommandId();
  const now = options.now ?? new Date().toISOString();
  const monotonicNs = options.monotonicNs ?? vnextMonotonicNs();

  const workflow = bundle.workflows.get(request.workflowId);
  if (!workflow) {
    throw runtimeError("run_workflow_unknown", ".kxm/workflows", `workflow ${request.workflowId} does not exist in this project`);
  }
  const revisions = vnextPolicyRevisions(bundle);
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
    const repositories = [...bundle.repositories.keys()].sort();
    const executors = [...new Set([
      typeof bundle.project.value.defaultExecutor === "string" ? bundle.project.value.defaultExecutor : undefined,
      ...[...bundle.agents.values()].map((agent) => agent.value.executor).filter((value): value is string => typeof value === "string"),
    ].filter((value): value is string => value !== undefined))].sort();
    const payload: Record<string, unknown> = {
      workflowId: request.workflowId,
      status: "created",
      repositories,
      executors,
      promptSha256,
    };
    validateRunCreatedPayload(payload);
    const event: VnextRunEvent = {
      eventId: newVnextEventId(),
      eventType: "run.created",
      projectId: context.projectId,
      runId,
      sequence: 1,
      commandId,
      occurredAt: now,
      recordedAt: now,
      monotonicNs,
      configRevision: revisions.configRevision,
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
    return { accepted: true, idempotent: false, run, event };
  });
}

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

const RUN_EVENT_TYPES = new Set([
  "run.created",
  "run.status_changed",
  "run.cancel_requested",
  "step.entered",
  "step.status_changed",
  "step.outcome_recorded",
  "step.transitioned",
  "assignment.created",
  "assignment.accepted",
  "assignment.dispatched",
  "assignment.executing",
  "assignment.reattaching",
  "assignment.retry_pending",
  "assignment.result_recorded",
  "assignment.terminal",
  "attempt.created",
  "attempt.status_changed",
  "attempt.connection_lost",
  "effect.intent_recorded",
  "effect.dispatched",
  "effect.observed",
  "effect.receipt_recorded",
  "effect.settled",
  "effect.blocked_uncertain",
  "effect.uncertainty_resolved",
]);

const RUN_STATUSES = new Set<VnextRunStatus>(["created", "preparing", "running", "waiting", "blocked_uncertain", "cancelling", "cancelled", "completed", "failed"]);
const TERMINAL_STATUSES = new Set<VnextRunStatus>(["completed", "failed", "cancelled"]);

/** Fold a run's event sequence into its current status (deterministic). */
export function projectVnextRunStatus(events: readonly VnextRunEvent[]): VnextRunStatus {
  let status: VnextRunStatus = "created";
  for (const event of events) {
    switch (event.eventType) {
      case "run.created":
        status = "created";
        break;
      case "run.status_changed": {
        const next = event.payload.status;
        if (typeof next !== "string" || !RUN_STATUSES.has(next as VnextRunStatus)) {
          throw runtimeError("run_events_corrupt", event.runId, `run.status_changed has invalid status ${String(next)}`);
        }
        status = next as VnextRunStatus;
        break;
      }
      case "run.cancel_requested":
        if (!TERMINAL_STATUSES.has(status)) status = "cancelling";
        break;
      default:
        // Later phases fold step/assignment/effect events into richer state.
        break;
    }
  }
  return status;
}

/** Rebuild the stored run row from the event log; returns the projected record. */
export function rebuildVnextRunProjection(store: VnextRunEventStore, runId: string): VnextRunRecord {
  const stored = store.run(runId);
  if (!stored) throw runtimeError("run_unknown", runId, "run does not exist in this event store");
  const events = store.events(runId, 0, 1_000_000);
  if (events.length === 0) throw runtimeError("run_events_corrupt", runId, "run has no events");
  const projected = projectVnextRunStatus(events);
  const last = events[events.length - 1]!;
  return {
    ...stored,
    status: projected,
    updatedAt: last.occurredAt,
  };
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
  options: { commandId?: string; now?: string; monotonicNs?: number } = {},
): VnextRunCancelResult {
  const commandId = options.commandId ?? newVnextCommandId();
  const now = options.now ?? new Date().toISOString();
  const monotonicNs = options.monotonicNs ?? vnextMonotonicNs();

  return context.eventStore.transaction(() => {
    const prior = context.eventStore.command(commandId);
    if (prior) {
      if (prior.kind !== "run.cancel" || prior.runId !== runId) {
        throw runtimeError("run_command_conflict", commandId, `command ${commandId} was already used for ${prior.kind}${prior.runId === runId ? "" : " on a different run"}`);
      }
      const run = context.eventStore.run(prior.runId);
      if (!run) throw runtimeError("run_command_corrupt", commandId, "idempotent command references a missing run");
      return { run, idempotent: true, events: [] };
    }
    const run = context.eventStore.run(runId);
    if (!run) throw runtimeError("run_unknown", runId, "run does not exist in this event store");
    if (TERMINAL_STATUSES.has(run.status)) {
      return { run, idempotent: true, events: [] };
    }

    const events: VnextRunEvent[] = [];
    const base = {
      projectId: context.projectId,
      runId,
      commandId,
      configRevision: run.configRevision,
      executorPolicyRevision: run.executorPolicyRevision,
      toolPolicyRevision: run.toolPolicyRevision,
    };
    let sequence = context.eventStore.nextSequence(runId);
    const cancelRequested: VnextRunEvent = {
      ...base,
      eventId: newVnextEventId(),
      eventType: "run.cancel_requested",
      sequence: sequence++,
      occurredAt: now,
      recordedAt: now,
      monotonicNs,
      payload: { requestedBy: "operator" },
    };
    events.push(cancelRequested);
    // Phase 2 has no child processes to drain: cancelling completes
    // immediately as a durable, ordered pair of events.
    const statusChanged: VnextRunEvent = {
      ...base,
      eventId: newVnextEventId(),
      eventType: "run.status_changed",
      sequence: sequence++,
      occurredAt: now,
      recordedAt: now,
      monotonicNs: monotonicNs + 1,
      payload: { status: "cancelled", reason: "operator_cancel" },
    };
    events.push(statusChanged);

    for (const event of events) context.eventStore.appendEvent(event);
    context.eventStore.updateRunStatus(runId, "cancelled", now);
    context.eventStore.insertCommand({
      commandId,
      runId,
      kind: "run.cancel",
      result: { runId, status: "cancelled" },
      recordedAt: now,
    });
    return { run: { ...run, status: "cancelled", updatedAt: now }, idempotent: false, events };
  });
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

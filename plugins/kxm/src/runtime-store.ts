import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "./sqlite.ts";
import { KxmConfigError, validateCoordinator, validateDriveReceipt, validateIntakeMessage, validateRunEvent, kxmCanonicalJson, type JsonValue, type KxmConfigIssue, type KxmConfigOptions } from "./project-config.ts";
import { kxmUserStateRoot } from "./bindings.ts";
import { deriveKxmSyncEvent, kxmSyncEventBytes, KxmSyncRedactor } from "./sync-transform.ts";

/* ------------------------------------------------------------------ *
 * Runtime registry (per-user, platform state root)
 * ------------------------------------------------------------------ */

export interface KxmRuntimePaths {
  stateRoot: string;
  runtimeDir: string;
  registryDb: string;
  projectsDir: string;
}

export function kxmRuntimePaths(options: { stateRoot?: string; env?: NodeJS.ProcessEnv; homeDir?: string } = {}): KxmRuntimePaths {
  const stateRoot = options.stateRoot
    ? resolve(options.stateRoot)
    : kxmUserStateRoot({ ...(options.env ? { env: options.env } : {}), ...(options.homeDir ? { homeDir: options.homeDir } : {}) });
  const runtimeDir = join(stateRoot, "runtime");
  return {
    stateRoot,
    runtimeDir,
    registryDb: join(runtimeDir, "registry.db"),
    projectsDir: join(runtimeDir, "projects"),
  };
}

function runtimeIssue(phase: KxmConfigIssue["phase"], code: string, file: string, message: string): KxmConfigIssue {
  return { phase, code, file, message };
}

export function runtimeError(code: string, file: string, message: string): KxmConfigError {
  return new KxmConfigError([runtimeIssue("semantic", code, file, message)]);
}

export function projectRuntimeKey(projectRoot: string): string {
  // Canonicalize through the filesystem like the repository binding store so
  // reaching a project through a link cannot mint a second key for it.
  let canonical: string;
  try {
    canonical = realpathSync.native(resolve(projectRoot));
  } catch {
    canonical = resolve(projectRoot);
  }
  const folded = process.platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical;
  return createHash("sha256").update(folded, "utf8").digest("hex").slice(0, 24);
}

function checkedParent(path: string, description: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = lstatSync(parent, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw runtimeError("runtime_path_invalid", description, `${description} parent must be a regular directory, not a link`);
  }
}

import {
  openDatabase,
  withDatabaseTransaction,
  type DatabaseSchemaSpec,
} from "./database.ts";

export type KxmDatabaseSchema = DatabaseSchemaSpec;
export { openDatabase };

/* ----------------------------- registry ---------------------------- */

export interface KxmSupervisorRecord {
  runtimeId: string;
  pid: number;
  port: number;
  tokenHash: string;
  startedAt: string;
  heartbeatAt: string;
  state: "starting" | "running" | "stopping" | "stopped";
}

export interface KxmProjectRegistration {
  projectId: string;
  projectRoot: string;
  projectKey: string;
  homeRuntimeId: string;
  configRevision?: string;
  registeredAt: string;
}

export const KXM_REGISTRY_SCHEMA_VERSION = 1;

const REGISTRY_TABLES = {
  supervisor: ["singleton_id", "runtime_id", "pid", "port", "token_hash", "started_at", "heartbeat_at", "state"],
  projects: ["project_id", "project_root", "project_key", "home_runtime_id", "config_revision", "registered_at"],
} as const;

const REGISTRY_SCHEMA = `
CREATE TABLE supervisor (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  runtime_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  port INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  state TEXT NOT NULL
) STRICT;
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  project_key TEXT NOT NULL UNIQUE,
  home_runtime_id TEXT NOT NULL,
  config_revision TEXT,
  registered_at TEXT NOT NULL
) STRICT;
`;

export class KxmRuntimeRegistry {
  readonly path: string;
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.path = resolve(path);
    this.database = openDatabase(this.path, "runtime registry", {
      schema: REGISTRY_SCHEMA,
      version: KXM_REGISTRY_SCHEMA_VERSION,
      tables: REGISTRY_TABLES,
    });
  }

  close(): void {
    this.database.close();
  }

  /** Atomically claim or refresh the supervisor singleton. Returns the record that now owns it. */
  claimSupervisor(record: { runtimeId: string; pid: number; port: number; tokenHash: string; now: string }): { claimed: boolean; record: KxmSupervisorRecord } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.readSupervisorRow();
      if (!existing) {
        this.database.prepare(`
          INSERT INTO supervisor (singleton_id, runtime_id, pid, port, token_hash, started_at, heartbeat_at, state)
          VALUES (1, ?, ?, ?, ?, ?, ?, 'running')
        `).run(record.runtimeId, record.pid, record.port, record.tokenHash, record.now, record.now);
        this.database.exec("COMMIT");
        return { claimed: true, record: this.supervisor()! };
      }
      if (existing.runtimeId === record.runtimeId && existing.pid === record.pid) {
        this.database.prepare("UPDATE supervisor SET heartbeat_at = ?, state = 'running' WHERE singleton_id = 1").run(record.now);
        this.database.exec("COMMIT");
        return { claimed: true, record: this.supervisor()! };
      }
      this.database.exec("ROLLBACK");
      return { claimed: false, record: existing };
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
  }

  /** Take over a dead supervisor's singleton, preserving its logical runtime identity and project home bindings. */
  takeoverSupervisor(record: { runtimeId: string; pid: number; port: number; tokenHash: string; now: string; observedDeadPid: number; observedHeartbeatAt: string }): KxmSupervisorRecord {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      // The logical runtime id is stable across process restarts: the new
      // process inherits it so immutable homeRuntimeId bindings stay valid.
      // The takeover applies only to the exact record we observed as dead.
      const existing = this.readSupervisorRow();
      const runtimeId = existing?.runtimeId ?? record.runtimeId;
      // True compare-and-swap: the takeover applies only if the observed dead
      // record (pid AND heartbeat) is unchanged. A refreshed incumbent wins.
      const updated = this.database.prepare(`
        UPDATE supervisor
        SET runtime_id = ?, pid = ?, port = ?, token_hash = ?, started_at = ?, heartbeat_at = ?, state = 'running'
        WHERE singleton_id = 1 AND pid = ? AND heartbeat_at = ?
      `).run(runtimeId, record.pid, record.port, record.tokenHash, record.now, record.now, record.observedDeadPid, record.observedHeartbeatAt);
      if (updated.changes !== 1) {
        this.database.exec("ROLLBACK");
        throw runtimeError("runtime_supervisor_conflict", "supervisor", "another process claimed the supervisor singleton first");
      }
      this.database.exec("COMMIT");
      return this.supervisor()!;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
  }

  markStopping(pid: number, now: string): void {
    // Only the owning process may mark the record; a losing takeover must
    // never clobber the winner's liveness.
    this.database.prepare("UPDATE supervisor SET state = 'stopping', heartbeat_at = ? WHERE singleton_id = 1 AND pid = ?").run(now, pid);
  }

  markStopped(pid: number, now: string): void {
    this.database.prepare("UPDATE supervisor SET state = 'stopped', heartbeat_at = ? WHERE singleton_id = 1 AND pid = ?").run(now, pid);
  }

  heartbeat(pid: number, now: string): number {
    const result = this.database.prepare("UPDATE supervisor SET heartbeat_at = ? WHERE singleton_id = 1 AND pid = ?").run(now, pid);
    return Number(result.changes);
  }

  private readSupervisorRow(): KxmSupervisorRecord | undefined {
    const row = this.database.prepare("SELECT runtime_id, pid, port, token_hash, started_at, heartbeat_at, state FROM supervisor WHERE singleton_id = 1").get() as
      | { runtime_id: string; pid: number; port: number; token_hash: string; started_at: string; heartbeat_at: string; state: KxmSupervisorRecord["state"] }
      | undefined;
    return row
      ? {
        runtimeId: row.runtime_id,
        pid: row.pid,
        port: row.port,
        tokenHash: row.token_hash,
        startedAt: row.started_at,
        heartbeatAt: row.heartbeat_at,
        state: row.state,
      }
      : undefined;
  }

  supervisor(): KxmSupervisorRecord | undefined {
    return this.readSupervisorRow();
  }

  /** Register or revalidate a project's home binding. Home Runtime is immutable. */
  /** All projects registered to this Runtime, for restart recovery: the
   * supervisor needs to reopen their contexts so pending outbox rows resume
   * syncing and presence keeps beating. */
  projectsForRuntime(homeRuntimeId: string): Array<{ projectRoot: string; projectId: string }> {
    const rows = this.database.prepare(
      "SELECT project_root, project_id FROM projects WHERE home_runtime_id = ? ORDER BY registered_at",
    ).all(homeRuntimeId) as Array<{ project_root: string; project_id: string }>;
    return rows.map((row) => ({ projectRoot: row.project_root, projectId: row.project_id }));
  }

  registerProject(registration: { projectId: string; projectRoot: string; homeRuntimeId: string; configRevision?: string; now: string }): KxmProjectRegistration {
    const projectRoot = resolve(registration.projectRoot);
    const projectKey = projectRuntimeKey(projectRoot);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const byId = this.database.prepare("SELECT project_id, project_root, project_key, home_runtime_id, config_revision, registered_at FROM projects WHERE project_id = ?").get(registration.projectId) as
        | { project_id: string; project_root: string; project_key: string; home_runtime_id: string; config_revision: string | null; registered_at: string }
        | undefined;
      const byKey = this.database.prepare("SELECT project_id, project_root, project_key, home_runtime_id, config_revision, registered_at FROM projects WHERE project_key = ?").get(projectKey) as
        | { project_id: string; project_root: string; project_key: string; home_runtime_id: string; config_revision: string | null; registered_at: string }
        | undefined;
      const existing = byId ?? byKey;
      if (existing) {
        const problems: string[] = [];
        if (byId && byId.project_key !== projectKey) problems.push(`project ${registration.projectId} is already bound to a different control root`);
        if (byKey && byKey.project_id !== registration.projectId) problems.push(`control root is already bound to a different project id ${byKey.project_id}`);
        if (existing.home_runtime_id !== registration.homeRuntimeId) problems.push(`project ${registration.projectId} home runtime is immutable and cannot be rebound`);
        if (problems.length > 0) {
          this.database.exec("ROLLBACK");
          throw runtimeError("project_home_conflict", ".kxm/project.yaml", problems.join("; "));
        }
        const result: KxmProjectRegistration = {
          projectId: existing.project_id,
          projectRoot: existing.project_root,
          projectKey: existing.project_key,
          homeRuntimeId: existing.home_runtime_id,
          ...(existing.config_revision !== null ? { configRevision: existing.config_revision } : {}),
          registeredAt: existing.registered_at,
        };
        this.database.exec("COMMIT");
        return result;
      }
      this.database.prepare(`
        INSERT INTO projects (project_id, project_root, project_key, home_runtime_id, config_revision, registered_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(registration.projectId, projectRoot, projectKey, registration.homeRuntimeId, registration.configRevision ?? null, registration.now);
      this.database.exec("COMMIT");
      return {
        projectId: registration.projectId,
        projectRoot,
        projectKey,
        homeRuntimeId: registration.homeRuntimeId,
        ...(registration.configRevision !== undefined ? { configRevision: registration.configRevision } : {}),
        registeredAt: registration.now,
      };
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
  }

  project(projectId: string): KxmProjectRegistration | undefined {
    const row = this.database.prepare("SELECT project_id, project_root, project_key, home_runtime_id, config_revision, registered_at FROM projects WHERE project_id = ?").get(projectId) as
      | { project_id: string; project_root: string; project_key: string; home_runtime_id: string; config_revision: string | null; registered_at: string }
      | undefined;
    return row
      ? {
        projectId: row.project_id,
        projectRoot: row.project_root,
        projectKey: row.project_key,
        homeRuntimeId: row.home_runtime_id,
        ...(row.config_revision !== null ? { configRevision: row.config_revision } : {}),
        registeredAt: row.registered_at,
      }
      : undefined;
  }

  projectByRoot(projectRoot: string): KxmProjectRegistration | undefined {
    const key = projectRuntimeKey(projectRoot);
    const row = this.database.prepare("SELECT project_id, project_root, project_key, home_runtime_id, config_revision, registered_at FROM projects WHERE project_key = ?").get(key) as
      | { project_id: string; project_root: string; project_key: string; home_runtime_id: string; config_revision: string | null; registered_at: string }
      | undefined;
    return row
      ? {
        projectId: row.project_id,
        projectRoot: row.project_root,
        projectKey: row.project_key,
        homeRuntimeId: row.home_runtime_id,
        ...(row.config_revision !== null ? { configRevision: row.config_revision } : {}),
        registeredAt: row.registered_at,
      }
      : undefined;
  }
}

/* --------------------------- event store --------------------------- */

export type KxmRunStatus = "created" | "preparing" | "running" | "waiting" | "blocked_uncertain" | "cancelling" | "cancelled" | "completed" | "failed";

export const KXM_RUN_EVENT_SCHEMA = "kxm.run-event.v1";
export const KXM_ABSENT_MEMORY_REVISION = "ctxrev_absent";

export interface KxmRunRecord {
  runId: string;
  projectId: string;
  homeRuntimeId: string;
  workflowId: string;
  promptSha256: string;
  status: KxmRunStatus;
  configRevision: string;
  memoryRevision: string;
  executorPolicyRevision: string;
  toolPolicyRevision: string;
  createdAt: string;
  updatedAt: string;
}

export interface KxmRunEvent {
  schema: typeof KXM_RUN_EVENT_SCHEMA;
  eventId: string;
  eventType: string;
  projectId: string;
  runId: string;
  homeRuntimeId: string;
  sequence: number;
  commandId?: string;
  occurredAt: string;
  recordedAt: string;
  monotonicNs: string;
  configRevision: string;
  memoryRevision: string;
  executorPolicyRevision: string;
  toolPolicyRevision: string;
  payload: Record<string, unknown>;
}

export interface KxmRunPlanRow {
  runId: string;
  runPlanHash: string;
  envelope: string;
  pinnedSequence: number;
}

export interface KxmRunStateRow {
  runId: string;
  lastSequence: number;
  state: string;
}

export interface KxmDriveReceiptHandoff {
  reason: string;
  field?: string;
  stepId?: string;
  detail: string;
}

export interface KxmDriveReceiptSettlement {
  kind: "terminal" | "handoff" | "unsettled";
  status: string;
  reason: string;
  handoff?: KxmDriveReceiptHandoff;
  error?: { class: string; component: string; retryable: boolean };
}

export interface KxmDriveReceipt {
  schema: typeof KXM_DRIVE_RECEIPT_SCHEMA;
  driveId: string;
  runId: string;
  projectId: string;
  homeRuntimeId: string;
  mode: "simulated" | "live";
  openedAt: string;
  openedSequence: number;
  closedAt: string;
  lastSequence: number;
  logHash: string;
  settlement: KxmDriveReceiptSettlement;
  budget: KxmDriveReceiptBudget | null;
  producer: { id: string; closed: boolean };
}

export type KxmDriveReceiptListItem =
  | KxmDriveReceipt
  | { readonly driveId: string; readonly divergence: string };

export interface KxmDriveReceiptBudget {
  budgetMs: number;
  source: "workflow" | "project" | "both";
  elapsedMs: number;
  overrun: boolean;
}

/** sha256 over `eventId:sequence` for events 1..lastSequence, in sequence order. */
export function hashKxmDriveLog(events: readonly { eventId: string; sequence: number }[]): string {
  const body = events.map((event) => `${event.eventId}:${event.sequence}`).join("\n");
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

export function verifyKxmDriveReceipt(
  receipt: KxmDriveReceipt,
  events: readonly KxmRunEvent[],
  foldedStatus: string,
  binding: { runId: string; driveId: string },
): { verified: boolean; divergence?: string } {
  const reasons: string[] = [];
  if (receipt.runId !== binding.runId) {
    reasons.push(`runId ${receipt.runId} != binding ${binding.runId}`);
  }
  if (receipt.driveId !== binding.driveId) {
    reasons.push(`driveId ${receipt.driveId} != binding ${binding.driveId}`);
  }
  const last = events[events.length - 1];
  const currentLast = last?.sequence ?? 0;
  if (receipt.lastSequence !== currentLast) {
    reasons.push(`lastSequence ${receipt.lastSequence} != log ${currentLast}`);
  }
  const prefix = events.filter((event) => event.sequence >= 1 && event.sequence <= receipt.lastSequence);
  if (hashKxmDriveLog(prefix) !== receipt.logHash) {
    reasons.push("logHash mismatch");
  }
  if (receipt.settlement.status !== foldedStatus) {
    reasons.push(`settlement.status ${receipt.settlement.status} != folded ${foldedStatus}`);
  }
  if (reasons.length === 0) return { verified: true };
  return { verified: false, divergence: reasons.join("; ") };
}

export interface KxmAttemptCapabilityRow {
  attemptId: string;
  runId: string;
  assignmentId: string;
  stepId: string;
  stepAttempt: number;
  producerId: string;
  capabilityHash: string;
  state: "issued" | "settled" | "revoked";
}

export type KxmGateKind = "command" | "artifacts-exist";
export type KxmGateExpect = "pass" | "fail";
export type KxmGateCompleteness = "complete" | "incomplete" | "no-start";
export type KxmGateStopCause = "none" | "timeout" | "cancel" | "error";
export type KxmGateSignalsAttempted = "none" | "term" | "term-kill";
export type KxmGateErrorClass = "validation" | "spawn-error" | "stream-error" | "stop-error" | "recording-error" | "lost-close";
export type KxmGateEvidenceOutcome = "passed" | "implementation-failure" | "repro-missing";

export interface KxmGateAttemptRow {
  attemptId: string;
  runId: string;
  projectId: string;
  homeRuntimeId: string;
  stepId: string;
  stepAttempt: number;
  assignmentId: string;
  effectId: string;
  gateId: string;
  gateKind: KxmGateKind;
  expect: KxmGateExpect;
  gateDefinitionHash: string;
  registryHash: string;
  runPlanHash: string;
  controlProjectKey: string;
  producerId: "kxm-gate";
  intentEventId: string;
  contentHash: string;
}

export interface KxmGateObservationRow {
  observationId: string;
  attemptId: string;
  runId: string;
  projectId: string;
  homeRuntimeId: string;
  stepId: string;
  stepAttempt: number;
  assignmentId: string;
  effectId: string;
  completeness: KxmGateCompleteness;
  spawned: 0 | 1;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  exitObserved: 0 | 1;
  closeObserved: 0 | 1;
  stopCause: KxmGateStopCause;
  signalsAttempted: KxmGateSignalsAttempted;
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
  recordedEventId: string;
  contentHash: string;
}

export interface KxmGateEvidenceRow {
  evidenceId: string;
  attemptId: string;
  observationId: string;
  runId: string;
  projectId: string;
  homeRuntimeId: string;
  stepId: string;
  stepAttempt: number;
  assignmentId: string;
  effectId: string;
  evidenceKey: string | null;
  kind: "gate";
  expect: KxmGateExpect;
  outcome: KxmGateEvidenceOutcome;
  settledEventId: string;
  contentHash: string;
}

export interface KxmGateRowCounts {
  attempts: number;
  observations: number;
  evidence: number;
}

export interface KxmCommandRecord {
  commandId: string;
  runId: string;
  kind: string;
  result: Record<string, unknown>;
  recordedAt: string;
}

export const KXM_EVENT_STORE_SCHEMA_VERSION = 6;
export const KXM_DRIVE_RECEIPT_SCHEMA = "kxm.drive-receipt.v1";
export const DRIVE_RECEIPT_MAX_BYTES = 8 * 1024;

const EVENT_STORE_TABLES = {
  runs: ["run_id", "project_id", "home_runtime_id", "workflow_id", "prompt_sha256", "status", "config_revision", "memory_revision", "executor_policy_revision", "tool_policy_revision", "created_at", "updated_at"],
  events: ["project_id", "run_id", "sequence", "event_id", "event_type", "command_id", "occurred_at", "recorded_at", "monotonic_ns", "config_revision", "memory_revision", "executor_policy_revision", "tool_policy_revision", "payload", "schema", "home_runtime_id"],
  commands: ["command_id", "run_id", "kind", "result", "recorded_at"],
  run_plans: ["run_id", "run_plan_hash", "envelope", "pinned_sequence"],
  run_state: ["run_id", "last_sequence", "state"],
  attempt_capabilities: ["attempt_id", "run_id", "assignment_id", "step_id", "step_attempt", "producer_id", "capability_hash", "state"],
  gate_attempts: [
    "attempt_id", "run_id", "project_id", "home_runtime_id", "step_id", "step_attempt", "assignment_id", "effect_id",
    "gate_id", "gate_kind", "expect", "gate_definition_hash", "registry_hash", "run_plan_hash", "control_project_key",
    "producer_id", "intent_event_id", "content_hash",
  ],
  gate_observations: [
    "observation_id", "attempt_id", "run_id", "project_id", "home_runtime_id", "step_id", "step_attempt", "assignment_id",
    "effect_id", "completeness", "spawned", "pid", "exit_code", "signal", "exit_observed", "close_observed", "stop_cause",
    "signals_attempted", "error_class", "stdout_sha256", "stdout_bytes", "stdout_complete", "stderr_sha256", "stderr_bytes",
    "stderr_complete", "checked_count", "failed_count", "elapsed_ms", "started_at", "finished_at", "recorded_event_id",
    "content_hash",
  ],
  gate_evidence: [
    "evidence_id", "attempt_id", "observation_id", "run_id", "project_id", "home_runtime_id", "step_id", "step_attempt",
    "assignment_id", "effect_id", "evidence_key", "kind", "expect", "outcome", "settled_event_id", "content_hash",
  ],
  drive_receipts: ["drive_id", "run_id", "project_id", "opened_sequence", "last_sequence", "closed_at", "schema", "receipt"],
  coordinators: [
    "coordinator_id", "project_id", "role", "channel", "ceiling_hash", "config_revision", "bound_at", "schema", "record",
  ],
  intake_messages: [
    "message_id", "project_id", "coordinator_id", "idempotency_key", "content_hash", "received_at", "dispatch_state",
    "schema", "record",
  ],
  project_controls: ["project_id", "paused", "reason", "updated_at", "actor", "schema", "record"],
  outbox: ["seq", "run_id", "sequence", "sync_event", "attempted_at", "acked_at"],
} as const;

/**
 * The authoritative table set of a run event store, sorted. Tests assert against
 * this instead of a hand-copied list, so adding a table cannot silently leave a
 * stale expectation behind.
 */
export const KXM_EVENT_STORE_TABLE_NAMES: string[] = Object.keys(EVENT_STORE_TABLES).sort();

const EVENT_STORE_SCHEMA = `
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  home_runtime_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  config_revision TEXT NOT NULL,
  memory_revision TEXT NOT NULL,
  executor_policy_revision TEXT NOT NULL,
  tool_policy_revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE events (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  command_id TEXT,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  monotonic_ns TEXT NOT NULL,
  config_revision TEXT NOT NULL,
  memory_revision TEXT NOT NULL,
  executor_policy_revision TEXT NOT NULL,
  tool_policy_revision TEXT NOT NULL,
  payload TEXT NOT NULL,
  schema TEXT NOT NULL,
  home_runtime_id TEXT NOT NULL,
  PRIMARY KEY (project_id, run_id, sequence)
) STRICT;
CREATE INDEX events_run ON events(run_id, sequence);
CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  result TEXT NOT NULL,
  recorded_at TEXT NOT NULL
) STRICT;
CREATE TABLE run_plans (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
  run_plan_hash TEXT NOT NULL,
  envelope TEXT NOT NULL,
  pinned_sequence INTEGER NOT NULL
) STRICT;
CREATE TABLE run_state (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
  last_sequence INTEGER NOT NULL,
  state TEXT NOT NULL
) STRICT;
CREATE TABLE attempt_capabilities (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  step_attempt INTEGER NOT NULL,
  producer_id TEXT NOT NULL,
  capability_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('issued','settled','revoked'))
) STRICT;
CREATE TABLE gate_attempts (
  attempt_id TEXT PRIMARY KEY REFERENCES attempt_capabilities(attempt_id),
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  project_id TEXT NOT NULL,
  home_runtime_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  step_attempt INTEGER NOT NULL,
  assignment_id TEXT NOT NULL,
  effect_id TEXT NOT NULL UNIQUE,
  gate_id TEXT NOT NULL,
  gate_kind TEXT NOT NULL CHECK (gate_kind IN ('command','artifacts-exist')),
  expect TEXT NOT NULL CHECK (expect IN ('pass','fail')),
  gate_definition_hash TEXT NOT NULL,
  registry_hash TEXT NOT NULL,
  run_plan_hash TEXT NOT NULL,
  control_project_key TEXT NOT NULL,
  producer_id TEXT NOT NULL CHECK (producer_id = 'kxm-gate'),
  intent_event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
  content_hash TEXT NOT NULL
) STRICT;
CREATE INDEX gate_attempts_run ON gate_attempts(run_id);
CREATE INDEX gate_attempts_project ON gate_attempts(project_id);
CREATE TABLE gate_observations (
  observation_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES gate_attempts(attempt_id),
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  project_id TEXT NOT NULL,
  home_runtime_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  step_attempt INTEGER NOT NULL,
  assignment_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  completeness TEXT NOT NULL CHECK (completeness IN ('complete','incomplete','no-start')),
  spawned INTEGER NOT NULL CHECK (spawned IN (0, 1)),
  pid INTEGER,
  exit_code INTEGER,
  signal TEXT,
  exit_observed INTEGER NOT NULL CHECK (exit_observed IN (0, 1)),
  close_observed INTEGER NOT NULL CHECK (close_observed IN (0, 1)),
  stop_cause TEXT NOT NULL CHECK (stop_cause IN ('none','timeout','cancel','error')),
  signals_attempted TEXT NOT NULL CHECK (signals_attempted IN ('none','term','term-kill')),
  error_class TEXT CHECK (error_class IN ('validation','spawn-error','stream-error','stop-error','recording-error','lost-close')),
  stdout_sha256 TEXT,
  stdout_bytes INTEGER,
  stdout_complete INTEGER CHECK (stdout_complete IN (0, 1)),
  stderr_sha256 TEXT,
  stderr_bytes INTEGER,
  stderr_complete INTEGER CHECK (stderr_complete IN (0, 1)),
  checked_count INTEGER,
  failed_count INTEGER,
  elapsed_ms INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  recorded_event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
  content_hash TEXT NOT NULL
) STRICT;
CREATE INDEX gate_observations_run ON gate_observations(run_id);
CREATE TABLE gate_evidence (
  evidence_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES gate_attempts(attempt_id),
  observation_id TEXT NOT NULL UNIQUE REFERENCES gate_observations(observation_id),
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  project_id TEXT NOT NULL,
  home_runtime_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  step_attempt INTEGER NOT NULL,
  assignment_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  evidence_key TEXT,
  kind TEXT NOT NULL CHECK (kind = 'gate'),
  expect TEXT NOT NULL CHECK (expect IN ('pass','fail')),
  outcome TEXT NOT NULL CHECK (outcome IN ('passed','implementation-failure','repro-missing')),
  settled_event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
  content_hash TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX gate_evidence_key ON gate_evidence(run_id, step_id, step_attempt, evidence_key) WHERE evidence_key IS NOT NULL;
CREATE INDEX gate_evidence_run ON gate_evidence(run_id);
CREATE TABLE drive_receipts (
  drive_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  opened_sequence INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL,
  closed_at TEXT NOT NULL,
  schema TEXT NOT NULL,
  receipt TEXT NOT NULL
) STRICT;
CREATE INDEX drive_receipts_run ON drive_receipts(run_id);
CREATE TABLE coordinators (
  coordinator_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  channel TEXT NOT NULL,
  ceiling_hash TEXT NOT NULL,
  config_revision TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  schema TEXT NOT NULL,
  record TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX coordinators_slot ON coordinators(project_id, role, channel);
CREATE TABLE intake_messages (
  message_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  coordinator_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  dispatch_state TEXT NOT NULL CHECK (dispatch_state IN ('ready','held_paused','admitted','refused')),
  schema TEXT NOT NULL,
  record TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX intake_idempotency ON intake_messages(project_id, coordinator_id, idempotency_key);
CREATE INDEX intake_dispatch ON intake_messages(project_id, dispatch_state, received_at, message_id);
CREATE TABLE project_controls (
  project_id TEXT PRIMARY KEY,
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  reason TEXT,
  updated_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  schema TEXT NOT NULL,
  record TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  sync_event TEXT NOT NULL,
  attempted_at TEXT,
  acked_at TEXT,
  UNIQUE (run_id, sequence)
) STRICT;
CREATE INDEX outbox_pending ON outbox(seq) WHERE acked_at IS NULL;
`;

/**
 * One outbox row: the already-derived `kxm.sync-event.v1` bytes plus retry
 * transport metadata. The local source payload is never kept here.
 */
export interface KxmOutboxRow {
  seq: number;
  runId: string;
  sequence: number;
  syncEvent: string;
  attemptedAt?: string;
  ackedAt?: string;
}

/** One persisted coordinator identity (`kxm.coordinator.v1`). */
export interface KxmCoordinatorRow {
  coordinatorId: string;
  projectId: string;
  role: string;
  channel: string;
  ceilingHash: string;
  configRevision: string;
  boundAt: string;
  record: string;
}

/** One persisted intake message (`kxm.intake-message.v1`). */
export interface KxmIntakeMessageRow {
  messageId: string;
  projectId: string;
  coordinatorId: string;
  idempotencyKey: string;
  contentHash: string;
  receivedAt: string;
  dispatchState: "ready" | "held_paused" | "admitted" | "refused";
  record: string;
}

/** The project's intake control: paused or running, with who said so. */
export interface KxmProjectControlRow {
  projectId: string;
  paused: boolean;
  reason?: string;
  updatedAt: string;
  actor: string;
  record: string;
}

export class KxmRunEventStore {
  readonly path: string;
  /** Secret values registered here are replaced in every sync object this
   * store derives. In memory only: they are never written anywhere. */
  readonly syncRedactor = new KxmSyncRedactor();
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.path = resolve(path);
    this.database = openDatabase(this.path, "run event store", {
      schema: EVENT_STORE_SCHEMA,
      version: KXM_EVENT_STORE_SCHEMA_VERSION,
      tables: EVENT_STORE_TABLES,
    });
  }

  close(): void {
    this.database.close();
  }

  /** Persist the accepted prompt outside the event log (hashed in events only). */
  putRunPrompt(runId: string, prompt: string): void {
    const all = this.readRunPrompts();
    all[runId] = prompt;
    this.writeRunPrompts(all);
  }

  getRunPrompt(runId: string): string | undefined {
    const value = this.readRunPrompts()[runId];
    return typeof value === "string" ? value : undefined;
  }

  private runPromptSidecarPath(): string {
    return `${this.path}.run-prompts.json`;
  }

  private readRunPrompts(): Record<string, string> {
    const sidecar = this.runPromptSidecarPath();
    if (!existsSync(sidecar)) return {};
    try {
      const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
    } catch {
      return {};
    }
  }

  private writeRunPrompts(all: Record<string, string>): void {
    writeFileSync(this.runPromptSidecarPath(), `${JSON.stringify(all)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  /** Run one immutable transaction, rolling back on any failure. */
  transaction<T>(work: () => T): T {
    return withDatabaseTransaction(this.database, work);
  }

  command(commandId: string): KxmCommandRecord | undefined {
    const row = this.database.prepare("SELECT command_id, run_id, kind, result, recorded_at FROM commands WHERE command_id = ?").get(commandId) as
      | { command_id: string; run_id: string; kind: string; result: string; recorded_at: string }
      | undefined;
    return row
      ? { commandId: row.command_id, runId: row.run_id, kind: row.kind, result: JSON.parse(row.result) as Record<string, unknown>, recordedAt: row.recorded_at }
      : undefined;
  }

  insertCommand(record: KxmCommandRecord): void {
    this.database.prepare("INSERT INTO commands (command_id, run_id, kind, result, recorded_at) VALUES (?, ?, ?, ?, ?)")
      .run(record.commandId, record.runId, record.kind, JSON.stringify(record.result), record.recordedAt);
  }

  insertRun(record: KxmRunRecord): void {
    this.database.prepare(`
      INSERT INTO runs (run_id, project_id, home_runtime_id, workflow_id, prompt_sha256, status, config_revision, memory_revision, executor_policy_revision, tool_policy_revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.runId,
      record.projectId,
      record.homeRuntimeId,
      record.workflowId,
      record.promptSha256,
      record.status,
      record.configRevision,
      record.memoryRevision,
      record.executorPolicyRevision,
      record.toolPolicyRevision,
      record.createdAt,
      record.updatedAt,
    );
  }

  updateRunStatus(runId: string, status: KxmRunStatus, updatedAt: string): void {
    this.database.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?").run(status, updatedAt, runId);
  }

  run(runId: string): KxmRunRecord | undefined {
    const row = this.database.prepare(`
      SELECT run_id, project_id, home_runtime_id, workflow_id, prompt_sha256, status, config_revision, memory_revision, executor_policy_revision, tool_policy_revision, created_at, updated_at
      FROM runs WHERE run_id = ?
    `).get(runId) as
      | {
        run_id: string;
        project_id: string;
        home_runtime_id: string;
        workflow_id: string;
        prompt_sha256: string;
        status: KxmRunStatus;
        config_revision: string;
        memory_revision: string;
        executor_policy_revision: string;
        tool_policy_revision: string;
        created_at: string;
        updated_at: string;
      }
      | undefined;
    return row ? runFromRow(row) : undefined;
  }

  /** All projects registered to this Runtime, for restart recovery: the
   * supervisor needs to reopen their contexts so pending outbox rows resume
   * syncing and presence keeps beating. */
  projectsForRuntime(homeRuntimeId: string): Array<{ projectRoot: string; projectId: string }> {
    const rows = this.database.prepare(
      "SELECT project_root, project_id FROM projects WHERE home_runtime_id = ? ORDER BY registered_at",
    ).all(homeRuntimeId) as Array<{ project_root: string; project_id: string }>;
    return rows.map((row) => ({ projectRoot: row.project_root, projectId: row.project_id }));
  }

  runsForProject(projectId: string, limit = 50): KxmRunRecord[] {
    const rows = this.database.prepare(`
      SELECT run_id, project_id, home_runtime_id, workflow_id, prompt_sha256, status, config_revision, memory_revision, executor_policy_revision, tool_policy_revision, created_at, updated_at
      FROM runs WHERE project_id = ? ORDER BY created_at DESC, run_id DESC LIMIT ?
    `).all(projectId, limit) as Array<Parameters<typeof runFromRow>[0]>;
    return rows.map(runFromRow);
  }

  nextSequence(runId: string): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM events WHERE run_id = ?").get(runId) as { max_sequence: number };
    return row.max_sequence + 1;
  }

  appendEvent(event: KxmRunEvent): void {
    validateRunEvent(event, "run-event");
    const run = this.run(event.runId);
    if (!run) throw runtimeError("run_unknown", event.runId, "run does not exist in this event store");
    if (event.homeRuntimeId !== run.homeRuntimeId || event.projectId !== run.projectId) {
      throw runtimeError("run_event_owner_mismatch", event.runId, "event homeRuntimeId or projectId does not match the run");
    }
    this.database.prepare(`
      INSERT INTO events (project_id, run_id, sequence, event_id, event_type, command_id, occurred_at, recorded_at, monotonic_ns, config_revision, memory_revision, executor_policy_revision, tool_policy_revision, payload, schema, home_runtime_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.projectId,
      event.runId,
      event.sequence,
      event.eventId,
      event.eventType,
      event.commandId ?? null,
      event.occurredAt,
      event.recordedAt,
      event.monotonicNs,
      event.configRevision,
      event.memoryRevision,
      event.executorPolicyRevision,
      event.toolPolicyRevision,
      JSON.stringify(event.payload),
      event.schema,
      event.homeRuntimeId,
    );
    // Allowlist before outbox: the row holds only the derived sync object, and
    // it commits (or rolls back) with the event in the caller's transaction.
    const syncEvent = deriveKxmSyncEvent(event, { redactor: this.syncRedactor });
    this.database.prepare("INSERT INTO outbox (run_id, sequence, sync_event) VALUES (?, ?, ?)")
      .run(event.runId, event.sequence, kxmSyncEventBytes(syncEvent));
  }

  /** Unacknowledged outbox rows after `afterSeq`, in outbox order, oldest first. */
  pendingOutbox(limit = 100, afterSeq = 0): KxmOutboxRow[] {
    const rows = this.database.prepare(`
      SELECT seq, run_id, sequence, sync_event, attempted_at, acked_at
      FROM outbox WHERE acked_at IS NULL AND seq > ? ORDER BY seq ASC LIMIT ?
    `).all(afterSeq, limit) as OutboxSqlRow[];
    return rows.map(outboxFromRow);
  }

  /** Every outbox row of one run, acknowledged or not, in sequence order. */
  outboxForRun(runId: string): KxmOutboxRow[] {
    const rows = this.database.prepare(`
      SELECT seq, run_id, sequence, sync_event, attempted_at, acked_at
      FROM outbox WHERE run_id = ? ORDER BY sequence ASC
    `).all(runId) as OutboxSqlRow[];
    return rows.map(outboxFromRow);
  }

  markOutboxAttempted(seqs: readonly number[], at: string): void {
    const statement = this.database.prepare("UPDATE outbox SET attempted_at = ? WHERE seq = ? AND acked_at IS NULL");
    this.transaction(() => {
      for (const seq of seqs) statement.run(at, seq);
    });
  }

  /** Advance the cursor: the hub holds these rows now. Returns rows newly acked. */
  ackOutbox(seqs: readonly number[], at: string): number {
    const statement = this.database.prepare("UPDATE outbox SET acked_at = ? WHERE seq = ? AND acked_at IS NULL");
    return this.transaction(() => {
      let changed = 0;
      for (const seq of seqs) changed += Number(statement.run(at, seq).changes);
      return changed;
    });
  }

  events(runId: string, afterSequence = 0, limit = 200): KxmRunEvent[] {
    const rows = this.database.prepare(`
      SELECT project_id, run_id, sequence, event_id, event_type, command_id, occurred_at, recorded_at, monotonic_ns, config_revision, memory_revision, executor_policy_revision, tool_policy_revision, payload, schema, home_runtime_id
      FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?
    `).all(runId, afterSequence, limit) as Array<{
      project_id: string;
      run_id: string;
      sequence: number;
      event_id: string;
      event_type: string;
      command_id: string | null;
      occurred_at: string;
      recorded_at: string;
      monotonic_ns: string;
      config_revision: string;
      memory_revision: string;
      executor_policy_revision: string;
      tool_policy_revision: string;
      payload: string;
      schema: typeof KXM_RUN_EVENT_SCHEMA;
      home_runtime_id: string;
    }>;
    return rows.map((row) => ({
      schema: row.schema,
      eventId: row.event_id,
      eventType: row.event_type,
      projectId: row.project_id,
      runId: row.run_id,
      homeRuntimeId: row.home_runtime_id,
      sequence: row.sequence,
      ...(row.command_id !== null ? { commandId: row.command_id } : {}),
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      monotonicNs: row.monotonic_ns,
      configRevision: row.config_revision,
      memoryRevision: row.memory_revision,
      executorPolicyRevision: row.executor_policy_revision,
      toolPolicyRevision: row.tool_policy_revision,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    }));
  }

  insertRunPlan(row: KxmRunPlanRow): void {
    this.database.prepare("INSERT INTO run_plans (run_id, run_plan_hash, envelope, pinned_sequence) VALUES (?, ?, ?, ?)")
      .run(row.runId, row.runPlanHash, row.envelope, row.pinnedSequence);
  }

  runPlan(runId: string): KxmRunPlanRow | undefined {
    const row = this.database.prepare("SELECT run_id, run_plan_hash, envelope, pinned_sequence FROM run_plans WHERE run_id = ?").get(runId) as
      | { run_id: string; run_plan_hash: string; envelope: string; pinned_sequence: number }
      | undefined;
    return row
      ? { runId: row.run_id, runPlanHash: row.run_plan_hash, envelope: row.envelope, pinnedSequence: row.pinned_sequence }
      : undefined;
  }

  runState(runId: string): KxmRunStateRow | undefined {
    const row = this.database.prepare("SELECT run_id, last_sequence, state FROM run_state WHERE run_id = ?").get(runId) as
      | { run_id: string; last_sequence: number; state: string }
      | undefined;
    return row ? { runId: row.run_id, lastSequence: row.last_sequence, state: row.state } : undefined;
  }

  upsertRunState(row: KxmRunStateRow): void {
    this.database.prepare(`
      INSERT INTO run_state (run_id, last_sequence, state) VALUES (?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET last_sequence = excluded.last_sequence, state = excluded.state
    `).run(row.runId, row.lastSequence, row.state);
  }

  insertDriveReceipt(receipt: KxmDriveReceipt): { inserted: boolean } {
    validateDriveReceipt(receipt, "drive-receipt");
    const canonical = kxmCanonicalJson(receipt as unknown as JsonValue);
    if (Buffer.byteLength(canonical, "utf8") > DRIVE_RECEIPT_MAX_BYTES) {
      throw runtimeError("drive_receipt_invalid", receipt.driveId, `drive receipt exceeds ${DRIVE_RECEIPT_MAX_BYTES} bytes`);
    }
    const result = this.database.prepare(`
      INSERT INTO drive_receipts (drive_id, run_id, project_id, opened_sequence, last_sequence, closed_at, schema, receipt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(drive_id) DO NOTHING
    `).run(
      receipt.driveId,
      receipt.runId,
      receipt.projectId,
      receipt.openedSequence,
      receipt.lastSequence,
      receipt.closedAt,
      receipt.schema,
      canonical,
    );
    return { inserted: Number(result.changes) === 1 };
  }

  driveReceipt(driveId: string): KxmDriveReceipt | undefined {
    const row = this.database.prepare("SELECT receipt FROM drive_receipts WHERE drive_id = ?").get(driveId) as
      | { receipt: string }
      | undefined;
    return row ? parseDriveReceipt(row.receipt) : undefined;
  }

  driveReceiptsForRun(runId: string, limit = 20): KxmDriveReceiptListItem[] {
    const rows = this.database.prepare(`
      SELECT drive_id, receipt FROM drive_receipts WHERE run_id = ? ORDER BY closed_at DESC, drive_id DESC LIMIT ?
    `).all(runId, limit) as Array<{ drive_id: string; receipt: string }>;
    return rows.map((row) => {
      try {
        return parseDriveReceipt(row.receipt);
      } catch {
        return { driveId: row.drive_id, divergence: "receipt unreadable" };
      }
    });
  }

  /** Insert a coordinator unless the (project, role, channel) slot is taken. */
  insertCoordinatorIfAbsent(row: KxmCoordinatorRow): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO coordinators
        (coordinator_id, project_id, role, channel, ceiling_hash, config_revision, bound_at, schema, record)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.coordinatorId,
      row.projectId,
      row.role,
      row.channel,
      row.ceilingHash,
      row.configRevision,
      row.boundAt,
      "kxm.coordinator.v1",
      row.record,
    );
    return Number(result.changes) === 1;
  }

  coordinatorById(coordinatorId: string): KxmCoordinatorRow | undefined {
    const row = this.database.prepare("SELECT * FROM coordinators WHERE coordinator_id = ?").get(coordinatorId) as
      | CoordinatorSqlRow
      | undefined;
    return row ? coordinatorFromRow(row) : undefined;
  }

  coordinatorInSlot(projectId: string, role: string, channel: string): KxmCoordinatorRow | undefined {
    const row = this.database.prepare(`
      SELECT * FROM coordinators WHERE project_id = ? AND role = ? AND channel = ?
    `).get(projectId, role, channel) as CoordinatorSqlRow | undefined;
    return row ? coordinatorFromRow(row) : undefined;
  }

  /**
   * Replace the coordinator holding a (project, role, channel) slot, guarded by
   * the identity that is currently there. A rebind therefore cannot clobber a
   * record that changed underneath it, and cannot leave two live identities for
   * one slot.
   */
  replaceCoordinatorInSlot(
    expectedCoordinatorId: string,
    row: KxmCoordinatorRow,
  ): boolean {
    const result = this.database.prepare(`
      UPDATE coordinators
      SET coordinator_id = ?, ceiling_hash = ?, config_revision = ?, bound_at = ?, schema = ?, record = ?
      WHERE project_id = ? AND role = ? AND channel = ? AND coordinator_id = ?
    `).run(
      row.coordinatorId,
      row.ceilingHash,
      row.configRevision,
      row.boundAt,
      "kxm.coordinator.v1",
      row.record,
      row.projectId,
      row.role,
      row.channel,
      expectedCoordinatorId,
    );
    return Number(result.changes) === 1;
  }

  /** Insert an intake message unless its idempotency slot is taken. */
  insertIntakeMessageIfAbsent(row: KxmIntakeMessageRow): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO intake_messages
        (message_id, project_id, coordinator_id, idempotency_key, content_hash, received_at, dispatch_state, schema, record)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.messageId,
      row.projectId,
      row.coordinatorId,
      row.idempotencyKey,
      row.contentHash,
      row.receivedAt,
      row.dispatchState,
      "kxm.intake-message.v1",
      row.record,
    );
    return Number(result.changes) === 1;
  }

  intakeMessage(messageId: string): KxmIntakeMessageRow | undefined {
    const row = this.database.prepare("SELECT * FROM intake_messages WHERE message_id = ?").get(messageId) as
      | IntakeSqlRow
      | undefined;
    return row ? intakeFromRow(row) : undefined;
  }

  intakeBySlot(projectId: string, coordinatorId: string, idempotencyKey: string): KxmIntakeMessageRow | undefined {
    const row = this.database.prepare(`
      SELECT * FROM intake_messages WHERE project_id = ? AND coordinator_id = ? AND idempotency_key = ?
    `).get(projectId, coordinatorId, idempotencyKey) as IntakeSqlRow | undefined;
    return row ? intakeFromRow(row) : undefined;
  }

  /**
   * Intake rows in the given dispatch states, in arrival order (replay-safe).
   *
   * `rowid` gives same-store arrival order, which is what queue priority needs
   * here. It is **not** a durable sequence: this repository backs stores up with
   * `VACUUM INTO`, and a vacuum may renumber implicit rowids. An explicit
   * immutable arrival sequence is tracked in the plan's schema-v6 follow-ups.
   */
  intakeInStates(projectId: string, states: readonly KxmIntakeMessageRow["dispatchState"][], limit = 100): KxmIntakeMessageRow[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT * FROM intake_messages
      WHERE project_id = ? AND dispatch_state IN (${placeholders})
      ORDER BY rowid ASC
      LIMIT ?
    `).all(projectId, ...states, limit) as unknown as IntakeSqlRow[];
    return rows.map(intakeFromRow);
  }

  /** Rewrite one intake row's dispatch state and record. Returns false when it raced away. */
  updateIntakeDispatch(
    messageId: string,
    expectState: KxmIntakeMessageRow["dispatchState"],
    next: { state: KxmIntakeMessageRow["dispatchState"]; record: string },
  ): boolean {
    const result = this.database.prepare(`
      UPDATE intake_messages SET dispatch_state = ?, record = ?, schema = ?
      WHERE message_id = ? AND dispatch_state = ?
    `).run(next.state, next.record, "kxm.intake-message.v1", messageId, expectState);
    return Number(result.changes) === 1;
  }

  projectControl(projectId: string): KxmProjectControlRow | undefined {
    const row = this.database.prepare("SELECT * FROM project_controls WHERE project_id = ?").get(projectId) as
      | ControlSqlRow
      | undefined;
    return row ? controlFromRow(row) : undefined;
  }

  putProjectControl(row: KxmProjectControlRow): void {
    this.database.prepare(`
      INSERT INTO project_controls (project_id, paused, reason, updated_at, actor, schema, record)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        paused = excluded.paused,
        reason = excluded.reason,
        updated_at = excluded.updated_at,
        actor = excluded.actor,
        schema = excluded.schema,
        record = excluded.record
    `).run(
      row.projectId,
      row.paused ? 1 : 0,
      row.reason ?? null,
      row.updatedAt,
      row.actor,
      "kxm.project-control.v1",
      row.record,
    );
  }

  insertCapability(row: KxmAttemptCapabilityRow): void {
    this.database.prepare(`
      INSERT INTO attempt_capabilities (attempt_id, run_id, assignment_id, step_id, step_attempt, producer_id, capability_hash, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.attemptId, row.runId, row.assignmentId, row.stepId, row.stepAttempt, row.producerId, row.capabilityHash, row.state);
  }

  capabilityByHash(capabilityHash: string): KxmAttemptCapabilityRow | undefined {
    return capabilityFromRow(this.database.prepare(`
      SELECT attempt_id, run_id, assignment_id, step_id, step_attempt, producer_id, capability_hash, state
      FROM attempt_capabilities WHERE capability_hash = ?
    `).get(capabilityHash) as CapabilitySqlRow | undefined);
  }

  capabilityByAttempt(attemptId: string): KxmAttemptCapabilityRow | undefined {
    return capabilityFromRow(this.database.prepare(`
      SELECT attempt_id, run_id, assignment_id, step_id, step_attempt, producer_id, capability_hash, state
      FROM attempt_capabilities WHERE attempt_id = ?
    `).get(attemptId) as CapabilitySqlRow | undefined);
  }

  settleCapability(attemptId: string, state: "settled" | "revoked"): void {
    const updated = this.database.prepare("UPDATE attempt_capabilities SET state = ? WHERE attempt_id = ?").run(state, attemptId);
    if (Number(updated.changes) !== 1) {
      throw runtimeError("capability_unknown", attemptId, "attempt capability does not exist");
    }
  }

  insertGateAttempt(row: KxmGateAttemptRow): void {
    assertGateAttemptRow(row);
    this.assertEventType(row.runId, row.intentEventId, ["effect.intent_recorded"]);
    const capability = this.capabilityByAttempt(row.attemptId);
    if (
      !capability
      || capability.runId !== row.runId
      || capability.assignmentId !== row.assignmentId
      || capability.stepId !== row.stepId
      || capability.stepAttempt !== row.stepAttempt
    ) {
      throw gateRowInvalid(row.attemptId, "gate attempt identity does not match attempt_capabilities");
    }
    this.database.prepare(`
      INSERT INTO gate_attempts (
        attempt_id, run_id, project_id, home_runtime_id, step_id, step_attempt, assignment_id, effect_id,
        gate_id, gate_kind, expect, gate_definition_hash, registry_hash, run_plan_hash, control_project_key,
        producer_id, intent_event_id, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.attemptId, row.runId, row.projectId, row.homeRuntimeId, row.stepId, row.stepAttempt, row.assignmentId, row.effectId,
      row.gateId, row.gateKind, row.expect, row.gateDefinitionHash, row.registryHash, row.runPlanHash, row.controlProjectKey,
      row.producerId, row.intentEventId, row.contentHash,
    );
  }

  insertGateObservation(row: KxmGateObservationRow): void {
    assertGateObservationRow(row);
    this.assertEventType(row.runId, row.recordedEventId, ["effect.observed", "effect.blocked_uncertain"]);
    const attempt = this.gateAttempt(row.attemptId);
    if (!attempt) throw gateRowInvalid(row.attemptId, "gate observation has no matching gate attempt");
    assertSharedIdentity(row, attempt, row.observationId);
    assertClosedGateObservation(attempt.gateKind, row, row.observationId);
    this.database.prepare(`
      INSERT INTO gate_observations (
        observation_id, attempt_id, run_id, project_id, home_runtime_id, step_id, step_attempt, assignment_id, effect_id,
        completeness, spawned, pid, exit_code, signal, exit_observed, close_observed, stop_cause, signals_attempted,
        error_class, stdout_sha256, stdout_bytes, stdout_complete, stderr_sha256, stderr_bytes, stderr_complete,
        checked_count, failed_count, elapsed_ms, started_at, finished_at, recorded_event_id, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.observationId, row.attemptId, row.runId, row.projectId, row.homeRuntimeId, row.stepId, row.stepAttempt,
      row.assignmentId, row.effectId, row.completeness, row.spawned, row.pid, row.exitCode, row.signal, row.exitObserved,
      row.closeObserved, row.stopCause, row.signalsAttempted, row.errorClass, row.stdoutSha256, row.stdoutBytes,
      row.stdoutComplete, row.stderrSha256, row.stderrBytes, row.stderrComplete, row.checkedCount, row.failedCount,
      row.elapsedMs, row.startedAt, row.finishedAt, row.recordedEventId, row.contentHash,
    );
  }

  insertGateEvidence(row: KxmGateEvidenceRow): void {
    assertGateEvidenceRow(row);
    this.assertEventType(row.runId, row.settledEventId, ["effect.settled"]);
    const attempt = this.gateAttempt(row.attemptId);
    if (!attempt) throw gateRowInvalid(row.attemptId, "gate evidence has no matching gate attempt");
    assertSharedIdentity(row, attempt, row.evidenceId);
    const observation = this.gateObservationForAttempt(row.attemptId);
    if (!observation || observation.observationId !== row.observationId) {
      throw gateRowInvalid(row.evidenceId, "gate evidence observation_id does not match the attempt observation");
    }
    this.database.prepare(`
      INSERT INTO gate_evidence (
        evidence_id, attempt_id, observation_id, run_id, project_id, home_runtime_id, step_id, step_attempt,
        assignment_id, effect_id, evidence_key, kind, expect, outcome, settled_event_id, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.evidenceId, row.attemptId, row.observationId, row.runId, row.projectId, row.homeRuntimeId, row.stepId,
      row.stepAttempt, row.assignmentId, row.effectId, row.evidenceKey, row.kind, row.expect, row.outcome,
      row.settledEventId, row.contentHash,
    );
  }

  gateAttempt(attemptId: string): KxmGateAttemptRow | undefined {
    const row = this.database.prepare(`
      SELECT attempt_id, run_id, project_id, home_runtime_id, step_id, step_attempt, assignment_id, effect_id,
        gate_id, gate_kind, expect, gate_definition_hash, registry_hash, run_plan_hash, control_project_key,
        producer_id, intent_event_id, content_hash
      FROM gate_attempts WHERE attempt_id = ?
    `).get(attemptId) as GateAttemptSql | undefined;
    return row ? gateAttemptFromSql(row) : undefined;
  }

  gateAttemptsForRun(runId: string): KxmGateAttemptRow[] {
    const rows = this.database.prepare(`
      SELECT attempt_id, run_id, project_id, home_runtime_id, step_id, step_attempt, assignment_id, effect_id,
        gate_id, gate_kind, expect, gate_definition_hash, registry_hash, run_plan_hash, control_project_key,
        producer_id, intent_event_id, content_hash
      FROM gate_attempts WHERE run_id = ? ORDER BY step_attempt ASC, attempt_id ASC
    `).all(runId) as GateAttemptSql[];
    return rows.map(gateAttemptFromSql);
  }

  gateAttemptsForProject(projectId: string): KxmGateAttemptRow[] {
    const rows = this.database.prepare(`
      SELECT attempt_id, run_id, project_id, home_runtime_id, step_id, step_attempt, assignment_id, effect_id,
        gate_id, gate_kind, expect, gate_definition_hash, registry_hash, run_plan_hash, control_project_key,
        producer_id, intent_event_id, content_hash
      FROM gate_attempts WHERE project_id = ? ORDER BY run_id ASC, step_attempt ASC, attempt_id ASC
    `).all(projectId) as GateAttemptSql[];
    return rows.map(gateAttemptFromSql);
  }

  issuedOrRevokedCapabilities(): KxmAttemptCapabilityRow[] {
    const rows = this.database.prepare(`
      SELECT attempt_id, run_id, assignment_id, step_id, step_attempt, producer_id, capability_hash, state
      FROM attempt_capabilities
      WHERE state IN ('issued','revoked')
      ORDER BY run_id ASC, step_attempt ASC, attempt_id ASC
    `).all() as CapabilitySqlRow[];
    const mapped: KxmAttemptCapabilityRow[] = [];
    for (const row of rows) {
      const capability = capabilityFromRow(row);
      if (!capability) {
        throw runtimeError("gate_recovery_corrupt", "attempt_capabilities", "issued or revoked capability row could not be read");
      }
      mapped.push(capability);
    }
    return mapped;
  }

  gateObservationForAttempt(attemptId: string): KxmGateObservationRow | undefined {
    const row = this.database.prepare(`
      SELECT observation_id, attempt_id, run_id, project_id, home_runtime_id, step_id, step_attempt, assignment_id,
        effect_id, completeness, spawned, pid, exit_code, signal, exit_observed, close_observed, stop_cause,
        signals_attempted, error_class, stdout_sha256, stdout_bytes, stdout_complete, stderr_sha256, stderr_bytes,
        stderr_complete, checked_count, failed_count, elapsed_ms, started_at, finished_at, recorded_event_id, content_hash
      FROM gate_observations WHERE attempt_id = ?
    `).get(attemptId) as GateObservationSql | undefined;
    return row ? gateObservationFromSql(row) : undefined;
  }

  gateObservationsForRun(runId: string): KxmGateObservationRow[] {
    const rows = this.database.prepare(`
      SELECT observation_id, attempt_id, run_id, project_id, home_runtime_id, step_id, step_attempt, assignment_id,
        effect_id, completeness, spawned, pid, exit_code, signal, exit_observed, close_observed, stop_cause,
        signals_attempted, error_class, stdout_sha256, stdout_bytes, stdout_complete, stderr_sha256, stderr_bytes,
        stderr_complete, checked_count, failed_count, elapsed_ms, started_at, finished_at, recorded_event_id, content_hash
      FROM gate_observations WHERE run_id = ? ORDER BY step_attempt ASC, observation_id ASC
    `).all(runId) as GateObservationSql[];
    return rows.map(gateObservationFromSql);
  }

  gateEvidenceForRun(runId: string): KxmGateEvidenceRow[] {
    const rows = this.database.prepare(`
      SELECT evidence_id, attempt_id, observation_id, run_id, project_id, home_runtime_id, step_id, step_attempt,
        assignment_id, effect_id, evidence_key, kind, expect, outcome, settled_event_id, content_hash
      FROM gate_evidence WHERE run_id = ? ORDER BY step_attempt ASC, evidence_id ASC
    `).all(runId) as GateEvidenceSql[];
    return rows.map(gateEvidenceFromSql);
  }

  gateEvidenceForAttempt(attemptId: string): KxmGateEvidenceRow | undefined {
    const row = this.database.prepare(`
      SELECT evidence_id, attempt_id, observation_id, run_id, project_id, home_runtime_id, step_id, step_attempt,
        assignment_id, effect_id, evidence_key, kind, expect, outcome, settled_event_id, content_hash
      FROM gate_evidence WHERE attempt_id = ?
    `).get(attemptId) as GateEvidenceSql | undefined;
    return row ? gateEvidenceFromSql(row) : undefined;
  }

  gateRowCounts(runId: string): KxmGateRowCounts {
    const attempts = this.database.prepare("SELECT COUNT(*) AS n FROM gate_attempts WHERE run_id = ?").get(runId) as { n: number };
    const observations = this.database.prepare("SELECT COUNT(*) AS n FROM gate_observations WHERE run_id = ?").get(runId) as { n: number };
    const evidence = this.database.prepare("SELECT COUNT(*) AS n FROM gate_evidence WHERE run_id = ?").get(runId) as { n: number };
    return { attempts: Number(attempts.n), observations: Number(observations.n), evidence: Number(evidence.n) };
  }

  private assertEventType(runId: string, eventId: string, allowed: readonly string[]): void {
    const row = this.database.prepare("SELECT run_id, event_type FROM events WHERE event_id = ?").get(eventId) as
      | { run_id: string; event_type: string }
      | undefined;
    if (!row || row.run_id !== runId || !allowed.includes(row.event_type)) {
      throw gateRowInvalid(eventId, `referenced event is not ${allowed.join("|")} for this run`);
    }
  }
}

interface CoordinatorSqlRow {
  coordinator_id: string;
  project_id: string;
  role: string;
  channel: string;
  ceiling_hash: string;
  config_revision: string;
  bound_at: string;
  schema: string;
  record: string;
}

interface IntakeSqlRow {
  message_id: string;
  project_id: string;
  coordinator_id: string;
  idempotency_key: string;
  content_hash: string;
  received_at: string;
  dispatch_state: KxmIntakeMessageRow["dispatchState"];
  schema: string;
  record: string;
}

interface ControlSqlRow {
  project_id: string;
  paused: number;
  reason: string | null;
  updated_at: string;
  actor: string;
  schema: string;
  record: string;
}

/**
 * Read a persisted coordinator. The record is revalidated against
 * `kxm.coordinator.v1` and cross-checked against its own columns, so a store
 * whose index and payload disagree fails closed instead of trusting either.
 */
function coordinatorFromRow(row: CoordinatorSqlRow): KxmCoordinatorRow {
  const parsed = JSON.parse(row.record) as {
    coordinatorId?: string; projectId?: string; role?: string; channel?: string;
    ceilingHash?: string; configRevision?: string; boundAt?: string;
  };
  if (row.schema !== "kxm.coordinator.v1") {
    throw runtimeError("coordinator_record_divergent", row.coordinator_id, `unexpected coordinator schema ${row.schema}`);
  }
  validateCoordinator(parsed, row.coordinator_id);
  if (
    parsed.coordinatorId !== row.coordinator_id
    || parsed.projectId !== row.project_id
    || parsed.role !== row.role
    || parsed.channel !== row.channel
    || parsed.ceilingHash !== row.ceiling_hash
    || parsed.configRevision !== row.config_revision
    || parsed.boundAt !== row.bound_at
  ) {
    throw runtimeError("coordinator_record_divergent", row.coordinator_id, "coordinator columns do not match the persisted record");
  }
  return {
    coordinatorId: row.coordinator_id,
    projectId: row.project_id,
    role: row.role,
    channel: row.channel,
    ceilingHash: row.ceiling_hash,
    configRevision: row.config_revision,
    boundAt: row.bound_at,
    record: row.record,
  };
}

function intakeFromRow(row: IntakeSqlRow): KxmIntakeMessageRow {
  const parsed = JSON.parse(row.record) as {
    messageId?: string; projectId?: string; coordinatorId?: string; idempotencyKey?: string;
    contentHash?: string; receivedAt?: string; dispatch?: { state?: string };
  };
  if (row.schema !== "kxm.intake-message.v1") {
    throw runtimeError("intake_record_divergent", row.message_id, `unexpected intake schema ${row.schema}`);
  }
  validateIntakeMessage(parsed, row.message_id);
  if (
    parsed.messageId !== row.message_id
    || parsed.projectId !== row.project_id
    || parsed.coordinatorId !== row.coordinator_id
    || parsed.idempotencyKey !== row.idempotency_key
    || parsed.contentHash !== row.content_hash
    || parsed.receivedAt !== row.received_at
    || parsed.dispatch?.state !== row.dispatch_state
  ) {
    throw runtimeError("intake_record_divergent", row.message_id, "intake columns do not match the persisted record");
  }
  return {
    messageId: row.message_id,
    projectId: row.project_id,
    coordinatorId: row.coordinator_id,
    idempotencyKey: row.idempotency_key,
    contentHash: row.content_hash,
    receivedAt: row.received_at,
    dispatchState: row.dispatch_state,
    record: row.record,
  };
}

/** The control record is its columns; a stored payload that disagrees is drift. */
function controlFromRow(row: ControlSqlRow): KxmProjectControlRow {
  const paused = row.paused === 1;
  const expected = kxmCanonicalJson({
    schema: "kxm.project-control.v1",
    projectId: row.project_id,
    paused,
    ...(row.reason !== null ? { reason: row.reason } : {}),
    updatedAt: row.updated_at,
    actor: row.actor,
  } as JsonValue);
  if (row.record !== expected) {
    throw runtimeError("project_control_divergent", row.project_id, "project control record does not match its columns");
  }
  return {
    projectId: row.project_id,
    paused,
    ...(row.reason !== null ? { reason: row.reason } : {}),
    updatedAt: row.updated_at,
    actor: row.actor,
    record: row.record,
  };
}

function parseDriveReceipt(raw: string): KxmDriveReceipt {
  const parsed = JSON.parse(raw) as unknown;
  validateDriveReceipt(parsed, "drive-receipt");
  return parsed as KxmDriveReceipt;
}

type OutboxSqlRow = {
  seq: number;
  run_id: string;
  sequence: number;
  sync_event: string;
  attempted_at: string | null;
  acked_at: string | null;
};

function outboxFromRow(row: OutboxSqlRow): KxmOutboxRow {
  return {
    seq: row.seq,
    runId: row.run_id,
    sequence: row.sequence,
    syncEvent: row.sync_event,
    ...(row.attempted_at !== null ? { attemptedAt: row.attempted_at } : {}),
    ...(row.acked_at !== null ? { ackedAt: row.acked_at } : {}),
  };
}

function runFromRow(row: {
  run_id: string;
  project_id: string;
  home_runtime_id: string;
  workflow_id: string;
  prompt_sha256: string;
  status: KxmRunStatus;
  config_revision: string;
  memory_revision: string;
  executor_policy_revision: string;
  tool_policy_revision: string;
  created_at: string;
  updated_at: string;
}): KxmRunRecord {
  if (typeof row.memory_revision !== "string" || row.memory_revision.length === 0) {
    throw runtimeError("runtime_schema_shape_invalid", row.run_id, "memory_revision is required");
  }
  return {
    runId: row.run_id,
    projectId: row.project_id,
    homeRuntimeId: row.home_runtime_id,
    workflowId: row.workflow_id,
    promptSha256: row.prompt_sha256,
    status: row.status,
    configRevision: row.config_revision,
    memoryRevision: row.memory_revision,
    executorPolicyRevision: row.executor_policy_revision,
    toolPolicyRevision: row.tool_policy_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Compute the immutable identity for a new run. */
export function newKxmRunId(): string {
  return `run_${randomUUID().replaceAll("-", "")}`;
}

export function newKxmEventId(): string {
  return `evt_${randomUUID().replaceAll("-", "")}`;
}

export function newKxmCommandId(): string {
  return `cmd_${randomUUID().replaceAll("-", "")}`;
}

export function newKxmAssignmentId(): string {
  return `asg_${randomUUID().replaceAll("-", "")}`;
}

export function newKxmAttemptId(): string {
  return `att_${randomUUID().replaceAll("-", "")}`;
}

export function newKxmEffectId(): string {
  return `eff_${randomUUID().replaceAll("-", "")}`;
}

export function newKxmObservationId(): string {
  return `obs_${randomUUID().replaceAll("-", "")}`;
}

export function newKxmEvidenceId(): string {
  return `gev_${randomUUID().replaceAll("-", "")}`;
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const OPAQUE = /^[a-z][a-z0-9]{1,15}_[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;
const FORBIDDEN_TEXT_KEYS = new Set(["stdout", "stderr", "error", "errorText", "stdoutText", "stderrText", "errorMessage", "message"]);
const GATE_ATTEMPT_KEYS = [
  "attemptId", "runId", "projectId", "homeRuntimeId", "stepId", "stepAttempt", "assignmentId", "effectId",
  "gateId", "gateKind", "expect", "gateDefinitionHash", "registryHash", "runPlanHash", "controlProjectKey",
  "producerId", "intentEventId", "contentHash",
] as const;
const GATE_OBSERVATION_KEYS = [
  "observationId", "attemptId", "runId", "projectId", "homeRuntimeId", "stepId", "stepAttempt", "assignmentId",
  "effectId", "completeness", "spawned", "pid", "exitCode", "signal", "exitObserved", "closeObserved", "stopCause",
  "signalsAttempted", "errorClass", "stdoutSha256", "stdoutBytes", "stdoutComplete", "stderrSha256", "stderrBytes",
  "stderrComplete", "checkedCount", "failedCount", "elapsedMs", "startedAt", "finishedAt", "recordedEventId", "contentHash",
] as const;
const GATE_EVIDENCE_KEYS = [
  "evidenceId", "attemptId", "observationId", "runId", "projectId", "homeRuntimeId", "stepId", "stepAttempt",
  "assignmentId", "effectId", "evidenceKey", "kind", "expect", "outcome", "settledEventId", "contentHash",
] as const;

export function gateRowContentHash(table: "gate_attempts" | "gate_observations" | "gate_evidence", row: object): string {
  const copy = { ...(row as Record<string, unknown>) };
  delete copy.contentHash;
  void table;
  return `sha256:${createHash("sha256").update(kxmCanonicalJson(copy as JsonValue), "utf8").digest("hex")}`;
}

export type KxmGateObservationFacts = Pick<
  KxmGateObservationRow,
  | "completeness"
  | "spawned"
  | "pid"
  | "exitCode"
  | "signal"
  | "exitObserved"
  | "closeObserved"
  | "stopCause"
  | "signalsAttempted"
  | "errorClass"
  | "stdoutSha256"
  | "stdoutBytes"
  | "stdoutComplete"
  | "stderrSha256"
  | "stderrBytes"
  | "stderrComplete"
  | "checkedCount"
  | "failedCount"
>;

export function assertClosedGateObservation(
  kind: KxmGateKind,
  row: KxmGateObservationFacts,
  id = "observation",
): void {
  if (row.completeness === "incomplete") return;
  if (row.completeness === "no-start") {
    const legitimateStartFailure = (row.errorClass === "validation" || row.errorClass === "spawn-error") && row.stopCause === "none";
    const requestedStop = row.stopCause === "cancel" && row.errorClass === null;
    if (
      row.spawned !== 0
      || row.pid !== null
      || row.exitCode !== null
      || row.signal !== null
      || row.exitObserved !== 0
      || row.closeObserved !== 0
      || row.signalsAttempted !== "none"
      || row.stdoutSha256 !== null
      || row.stdoutBytes !== null
      || row.stdoutComplete !== null
      || row.stderrSha256 !== null
      || row.stderrBytes !== null
      || row.stderrComplete !== null
      || row.checkedCount !== null
      || row.failedCount !== null
      || (!legitimateStartFailure && !requestedStop)
    ) {
      throw gateRowInvalid(id, "no-start observation forbids PID/exit/close/stream/check facts and requires a legitimate no-start cause");
    }
    return;
  }
  if (kind === "command") {
    if (
      row.spawned !== 1
      || typeof row.pid !== "number"
      || typeof row.exitCode !== "number"
      || row.signal !== null
      || row.exitObserved !== 1
      || row.closeObserved !== 1
      || row.stopCause !== "none"
      || row.signalsAttempted !== "none"
      || row.stdoutComplete !== 1
      || row.stderrComplete !== 1
      || typeof row.stdoutSha256 !== "string"
      || typeof row.stderrSha256 !== "string"
      || typeof row.stdoutBytes !== "number"
      || typeof row.stderrBytes !== "number"
      || row.checkedCount !== null
      || row.failedCount !== null
    ) {
      throw gateRowInvalid(id, "complete command observation requires spawn, numeric exit, no signal, exit/close, complete streams, and stopCause none");
    }
    return;
  }
  if (
    row.spawned !== 0
    || row.pid !== null
    || row.exitCode !== null
    || row.signal !== null
    || row.exitObserved !== 0
    || row.closeObserved !== 0
    || row.stopCause !== "none"
    || row.signalsAttempted !== "none"
    || row.stdoutSha256 !== null
    || row.stdoutBytes !== null
    || row.stdoutComplete !== null
    || row.stderrSha256 !== null
    || row.stderrBytes !== null
    || row.stderrComplete !== null
    || typeof row.checkedCount !== "number"
    || typeof row.failedCount !== "number"
    || row.checkedCount < 0
    || row.failedCount < 0
    || row.failedCount > row.checkedCount
  ) {
    throw gateRowInvalid(id, "complete artifacts observation requires consistent counts and no command facts");
  }
}

export function computeGateEvidenceOutcome(
  kind: KxmGateKind,
  expect: KxmGateExpect,
  observation: KxmGateObservationFacts,
): KxmGateEvidenceOutcome {
  assertClosedGateObservation(kind, observation);
  if (observation.completeness !== "complete") {
    throw gateRowInvalid("observation", "evaluated settlement requires a complete observation");
  }
  if (kind === "artifacts-exist") {
    if (expect === "fail") throw gateRowInvalid("artifacts-exist", "artifacts-exist cannot expect fail");
    return observation.failedCount === 0 ? "passed" : "implementation-failure";
  }
  if (expect === "pass") return observation.exitCode === 0 ? "passed" : "implementation-failure";
  return observation.exitCode === 0 ? "repro-missing" : "passed";
}

function gateRowInvalid(file: string, message: string): KxmConfigError {
  return runtimeError("gate_row_invalid", file, message);
}

function assertExactRowKeys(row: object, keys: readonly string[], id: string): void {
  const actual = Object.keys(row);
  if (actual.length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(row, key))) {
    throw gateRowInvalid(id, "gate row does not have the exact key set");
  }
  for (const key of actual) {
    if (FORBIDDEN_TEXT_KEYS.has(key)) throw gateRowInvalid(id, "gate row must not carry raw stdout/stderr/error text");
  }
}

function assertId(value: string, prefix: string, id: string, label: string): void {
  if (typeof value !== "string" || !value.startsWith(prefix) || !OPAQUE.test(value)) {
    throw gateRowInvalid(id, `${label} is not a valid ${prefix} opaque id`);
  }
}

function assertSha(value: string, id: string, label: string): void {
  if (typeof value !== "string" || !SHA256.test(value)) throw gateRowInvalid(id, `${label} is not a sha256 hash`);
}

function assertFlag(value: unknown, id: string, label: string): asserts value is 0 | 1 {
  if (value !== 0 && value !== 1) throw gateRowInvalid(id, `${label} must be 0 or 1`);
}

function assertNullInt(value: unknown, id: string, label: string): void {
  if (value !== null && (typeof value !== "number" || !Number.isInteger(value))) {
    throw gateRowInvalid(id, `${label} must be an integer or null`);
  }
}

function assertGateAttemptRow(row: KxmGateAttemptRow): void {
  assertExactRowKeys(row, GATE_ATTEMPT_KEYS, row.attemptId);
  assertId(row.attemptId, "att_", row.attemptId, "attemptId");
  assertId(row.effectId, "eff_", row.attemptId, "effectId");
  assertId(row.intentEventId, "evt_", row.attemptId, "intentEventId");
  assertSha(row.gateDefinitionHash, row.attemptId, "gateDefinitionHash");
  assertSha(row.registryHash, row.attemptId, "registryHash");
  assertSha(row.runPlanHash, row.attemptId, "runPlanHash");
  if (row.producerId !== "kxm-gate") throw gateRowInvalid(row.attemptId, "producerId must be kxm-gate");
  if (row.gateKind !== "command" && row.gateKind !== "artifacts-exist") {
    throw gateRowInvalid(row.attemptId, "gateKind is invalid");
  }
  if (row.expect !== "pass" && row.expect !== "fail") throw gateRowInvalid(row.attemptId, "expect is invalid");
  if (row.gateKind === "artifacts-exist" && row.expect === "fail") {
    throw gateRowInvalid(row.attemptId, "artifacts-exist cannot expect fail");
  }
  if (typeof row.controlProjectKey !== "string" || row.controlProjectKey.length === 0) {
    throw gateRowInvalid(row.attemptId, "controlProjectKey is required");
  }
  if (gateRowContentHash("gate_attempts", row) !== row.contentHash) {
    throw gateRowInvalid(row.attemptId, "contentHash does not match the canonical row");
  }
}

function assertGateObservationRow(row: KxmGateObservationRow): void {
  assertExactRowKeys(row, GATE_OBSERVATION_KEYS, row.observationId);
  assertId(row.observationId, "obs_", row.observationId, "observationId");
  assertId(row.attemptId, "att_", row.observationId, "attemptId");
  assertId(row.effectId, "eff_", row.observationId, "effectId");
  assertId(row.recordedEventId, "evt_", row.observationId, "recordedEventId");
  if (!["complete", "incomplete", "no-start"].includes(row.completeness)) {
    throw gateRowInvalid(row.observationId, "completeness is invalid");
  }
  assertFlag(row.spawned, row.observationId, "spawned");
  assertFlag(row.exitObserved, row.observationId, "exitObserved");
  assertFlag(row.closeObserved, row.observationId, "closeObserved");
  assertNullInt(row.pid, row.observationId, "pid");
  assertNullInt(row.exitCode, row.observationId, "exitCode");
  assertNullInt(row.stdoutBytes, row.observationId, "stdoutBytes");
  assertNullInt(row.stderrBytes, row.observationId, "stderrBytes");
  assertNullInt(row.checkedCount, row.observationId, "checkedCount");
  assertNullInt(row.failedCount, row.observationId, "failedCount");
  if (typeof row.elapsedMs !== "number" || !Number.isInteger(row.elapsedMs) || row.elapsedMs < 0) {
    throw gateRowInvalid(row.observationId, "elapsedMs is invalid");
  }
  if (row.stdoutSha256 !== null) assertSha(row.stdoutSha256, row.observationId, "stdoutSha256");
  if (row.stderrSha256 !== null) assertSha(row.stderrSha256, row.observationId, "stderrSha256");
  if (row.stdoutComplete !== null && row.stdoutComplete !== 0 && row.stdoutComplete !== 1) {
    throw gateRowInvalid(row.observationId, "stdoutComplete must be 0, 1, or null");
  }
  if (row.stderrComplete !== null && row.stderrComplete !== 0 && row.stderrComplete !== 1) {
    throw gateRowInvalid(row.observationId, "stderrComplete must be 0, 1, or null");
  }
  if (gateRowContentHash("gate_observations", row) !== row.contentHash) {
    throw gateRowInvalid(row.observationId, "contentHash does not match the canonical row");
  }
}

function assertGateEvidenceRow(row: KxmGateEvidenceRow): void {
  assertExactRowKeys(row, GATE_EVIDENCE_KEYS, row.evidenceId);
  assertId(row.evidenceId, "gev_", row.evidenceId, "evidenceId");
  assertId(row.attemptId, "att_", row.evidenceId, "attemptId");
  assertId(row.observationId, "obs_", row.evidenceId, "observationId");
  assertId(row.effectId, "eff_", row.evidenceId, "effectId");
  assertId(row.settledEventId, "evt_", row.evidenceId, "settledEventId");
  if (row.kind !== "gate") throw gateRowInvalid(row.evidenceId, "kind must be gate");
  if (!["passed", "implementation-failure", "repro-missing"].includes(row.outcome)) {
    throw gateRowInvalid(row.evidenceId, "outcome is invalid");
  }
  if (gateRowContentHash("gate_evidence", row) !== row.contentHash) {
    throw gateRowInvalid(row.evidenceId, "contentHash does not match the canonical row");
  }
}

function assertSharedIdentity(
  row: { runId: string; projectId: string; homeRuntimeId: string; stepId: string; stepAttempt: number; assignmentId: string; effectId: string },
  attempt: KxmGateAttemptRow,
  id: string,
): void {
  if (
    row.runId !== attempt.runId
    || row.projectId !== attempt.projectId
    || row.homeRuntimeId !== attempt.homeRuntimeId
    || row.stepId !== attempt.stepId
    || row.stepAttempt !== attempt.stepAttempt
    || row.assignmentId !== attempt.assignmentId
    || row.effectId !== attempt.effectId
  ) {
    throw gateRowInvalid(id, "row identity does not match the gate attempt");
  }
}

type GateAttemptSql = {
  attempt_id: string;
  run_id: string;
  project_id: string;
  home_runtime_id: string;
  step_id: string;
  step_attempt: number;
  assignment_id: string;
  effect_id: string;
  gate_id: string;
  gate_kind: KxmGateKind;
  expect: KxmGateExpect;
  gate_definition_hash: string;
  registry_hash: string;
  run_plan_hash: string;
  control_project_key: string;
  producer_id: "kxm-gate";
  intent_event_id: string;
  content_hash: string;
};

function gateAttemptFromSql(row: GateAttemptSql): KxmGateAttemptRow {
  return {
    attemptId: row.attempt_id,
    runId: row.run_id,
    projectId: row.project_id,
    homeRuntimeId: row.home_runtime_id,
    stepId: row.step_id,
    stepAttempt: row.step_attempt,
    assignmentId: row.assignment_id,
    effectId: row.effect_id,
    gateId: row.gate_id,
    gateKind: row.gate_kind,
    expect: row.expect,
    gateDefinitionHash: row.gate_definition_hash,
    registryHash: row.registry_hash,
    runPlanHash: row.run_plan_hash,
    controlProjectKey: row.control_project_key,
    producerId: row.producer_id,
    intentEventId: row.intent_event_id,
    contentHash: row.content_hash,
  };
}

type GateObservationSql = {
  observation_id: string;
  attempt_id: string;
  run_id: string;
  project_id: string;
  home_runtime_id: string;
  step_id: string;
  step_attempt: number;
  assignment_id: string;
  effect_id: string;
  completeness: KxmGateCompleteness;
  spawned: number;
  pid: number | null;
  exit_code: number | null;
  signal: string | null;
  exit_observed: number;
  close_observed: number;
  stop_cause: KxmGateStopCause;
  signals_attempted: KxmGateSignalsAttempted;
  error_class: KxmGateErrorClass | null;
  stdout_sha256: string | null;
  stdout_bytes: number | null;
  stdout_complete: number | null;
  stderr_sha256: string | null;
  stderr_bytes: number | null;
  stderr_complete: number | null;
  checked_count: number | null;
  failed_count: number | null;
  elapsed_ms: number;
  started_at: string;
  finished_at: string | null;
  recorded_event_id: string;
  content_hash: string;
};

function gateObservationFromSql(row: GateObservationSql): KxmGateObservationRow {
  return {
    observationId: row.observation_id,
    attemptId: row.attempt_id,
    runId: row.run_id,
    projectId: row.project_id,
    homeRuntimeId: row.home_runtime_id,
    stepId: row.step_id,
    stepAttempt: row.step_attempt,
    assignmentId: row.assignment_id,
    effectId: row.effect_id,
    completeness: row.completeness,
    spawned: row.spawned === 1 ? 1 : 0,
    pid: row.pid,
    exitCode: row.exit_code,
    signal: row.signal,
    exitObserved: row.exit_observed === 1 ? 1 : 0,
    closeObserved: row.close_observed === 1 ? 1 : 0,
    stopCause: row.stop_cause,
    signalsAttempted: row.signals_attempted,
    errorClass: row.error_class,
    stdoutSha256: row.stdout_sha256,
    stdoutBytes: row.stdout_bytes,
    stdoutComplete: row.stdout_complete === null ? null : row.stdout_complete === 1 ? 1 : 0,
    stderrSha256: row.stderr_sha256,
    stderrBytes: row.stderr_bytes,
    stderrComplete: row.stderr_complete === null ? null : row.stderr_complete === 1 ? 1 : 0,
    checkedCount: row.checked_count,
    failedCount: row.failed_count,
    elapsedMs: row.elapsed_ms,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    recordedEventId: row.recorded_event_id,
    contentHash: row.content_hash,
  };
}

type GateEvidenceSql = {
  evidence_id: string;
  attempt_id: string;
  observation_id: string;
  run_id: string;
  project_id: string;
  home_runtime_id: string;
  step_id: string;
  step_attempt: number;
  assignment_id: string;
  effect_id: string;
  evidence_key: string | null;
  kind: "gate";
  expect: KxmGateExpect;
  outcome: KxmGateEvidenceOutcome;
  settled_event_id: string;
  content_hash: string;
};

function gateEvidenceFromSql(row: GateEvidenceSql): KxmGateEvidenceRow {
  return {
    evidenceId: row.evidence_id,
    attemptId: row.attempt_id,
    observationId: row.observation_id,
    runId: row.run_id,
    projectId: row.project_id,
    homeRuntimeId: row.home_runtime_id,
    stepId: row.step_id,
    stepAttempt: row.step_attempt,
    assignmentId: row.assignment_id,
    effectId: row.effect_id,
    evidenceKey: row.evidence_key,
    kind: row.kind,
    expect: row.expect,
    outcome: row.outcome,
    settledEventId: row.settled_event_id,
    contentHash: row.content_hash,
  };
}

type CapabilitySqlRow = {
  attempt_id: string;
  run_id: string;
  assignment_id: string;
  step_id: string;
  step_attempt: number;
  producer_id: string;
  capability_hash: string;
  state: KxmAttemptCapabilityRow["state"];
};

function capabilityFromRow(row: CapabilitySqlRow | undefined): KxmAttemptCapabilityRow | undefined {
  return row
    ? {
      attemptId: row.attempt_id,
      runId: row.run_id,
      assignmentId: row.assignment_id,
      stepId: row.step_id,
      stepAttempt: row.step_attempt,
      producerId: row.producer_id,
      capabilityHash: row.capability_hash,
      state: row.state,
    }
    : undefined;
}

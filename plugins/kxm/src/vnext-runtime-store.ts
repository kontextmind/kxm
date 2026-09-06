import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { VnextConfigError, validateRunEvent, type VnextConfigIssue, type VnextConfigOptions } from "./vnext-config.ts";
import { vnextUserStateRoot } from "./vnext-bindings.ts";

/* ------------------------------------------------------------------ *
 * Runtime registry (per-user, platform state root)
 * ------------------------------------------------------------------ */

export interface VnextRuntimePaths {
  stateRoot: string;
  runtimeDir: string;
  registryDb: string;
  projectsDir: string;
}

export function vnextRuntimePaths(options: { stateRoot?: string; env?: NodeJS.ProcessEnv; homeDir?: string } = {}): VnextRuntimePaths {
  const stateRoot = options.stateRoot
    ? resolve(options.stateRoot)
    : vnextUserStateRoot({ ...(options.env ? { env: options.env } : {}), ...(options.homeDir ? { homeDir: options.homeDir } : {}) });
  const runtimeDir = join(stateRoot, "runtime");
  return {
    stateRoot,
    runtimeDir,
    registryDb: join(runtimeDir, "registry.db"),
    projectsDir: join(runtimeDir, "projects"),
  };
}

function runtimeIssue(phase: VnextConfigIssue["phase"], code: string, file: string, message: string): VnextConfigIssue {
  return { phase, code, file, message };
}

export function runtimeError(code: string, file: string, message: string): VnextConfigError {
  return new VnextConfigError([runtimeIssue("semantic", code, file, message)]);
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
  const stat = lstatSync(parent);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw runtimeError("runtime_path_invalid", description, `${description} parent must be a regular directory, not a link`);
  }
}

export interface VnextDatabaseSchema {
  schema: string;
  version: number;
  tables: Readonly<Record<string, readonly string[]>>;
}

function userTables(database: DatabaseSync): string[] {
  const rows = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function tableColumns(database: DatabaseSync, table: string): string[] {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name).sort();
}

function verifyExpectedTables(database: DatabaseSync, file: string, description: string, expected: Readonly<Record<string, readonly string[]>>): void {
  const present = new Set(userTables(database));
  for (const [table, columns] of Object.entries(expected)) {
    if (!present.has(table)) {
      throw runtimeError("runtime_schema_shape_invalid", file, `${description} is missing table ${table}`);
    }
    const actual = tableColumns(database, table);
    const missing = columns.filter((column) => !actual.includes(column));
    if (missing.length > 0) {
      throw runtimeError("runtime_schema_shape_invalid", file, `${description} table ${table} is missing columns ${missing.join(", ")}`);
    }
  }
}

function openDatabase(file: string, description: string, spec: VnextDatabaseSchema): DatabaseSync {
  checkedParent(file, description);
  if (existsSync(file)) {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw runtimeError("runtime_path_invalid", description, `${description} must be a regular file, not a link or directory`);
    }
  }
  for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
    if (existsSync(sidecar) && lstatSync(sidecar).isSymbolicLink()) {
      throw runtimeError("runtime_path_invalid", description, `${description} sidecar must not be a link`);
    }
  }
  const database = new DatabaseSync(file);
  let transaction = false;
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    // Inspect the schema only after serializing concurrent first-open callers.
    database.exec("BEGIN IMMEDIATE");
    transaction = true;
    const row = database.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    const version = row?.user_version ?? 0;
    if (version > spec.version) {
      throw runtimeError("runtime_schema_newer", file, `${description} schema version ${version} is newer than this runtime supports`);
    }
    if (version === 0) {
      const existing = userTables(database);
      if (existing.length > 0) {
        throw runtimeError("runtime_schema_shape_invalid", file, `${description} has tables at schema version 0`);
      }
      database.exec(spec.schema);
      database.exec(`PRAGMA user_version = ${spec.version}`);
    } else if (version < spec.version) {
      throw runtimeError(
        "runtime_schema_outdated",
        file,
        `${description} schema version ${version} is older than ${spec.version}; backup, restore, and migration remain E6`,
      );
    } else {
      verifyExpectedTables(database, file, description, spec.tables);
    }
    database.exec("COMMIT");
    transaction = false;
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec("PRAGMA foreign_keys = ON");
    return database;
  } catch (error) {
    if (transaction) {
      try { database.exec("ROLLBACK"); } catch { /* already rolled back */ }
    }
    database.close();
    throw error;
  }
}

/* ----------------------------- registry ---------------------------- */

export interface VnextSupervisorRecord {
  runtimeId: string;
  pid: number;
  port: number;
  tokenHash: string;
  startedAt: string;
  heartbeatAt: string;
  state: "starting" | "running" | "stopping" | "stopped";
}

export interface VnextProjectRegistration {
  projectId: string;
  projectRoot: string;
  projectKey: string;
  homeRuntimeId: string;
  configRevision?: string;
  registeredAt: string;
}

export const VNEXT_REGISTRY_SCHEMA_VERSION = 1;

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

export class VnextRuntimeRegistry {
  readonly path: string;
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.path = resolve(path);
    this.database = openDatabase(this.path, "runtime registry", {
      schema: REGISTRY_SCHEMA,
      version: VNEXT_REGISTRY_SCHEMA_VERSION,
      tables: REGISTRY_TABLES,
    });
  }

  close(): void {
    this.database.close();
  }

  /** Atomically claim or refresh the supervisor singleton. Returns the record that now owns it. */
  claimSupervisor(record: { runtimeId: string; pid: number; port: number; tokenHash: string; now: string }): { claimed: boolean; record: VnextSupervisorRecord } {
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
  takeoverSupervisor(record: { runtimeId: string; pid: number; port: number; tokenHash: string; now: string; observedDeadPid: number; observedHeartbeatAt: string }): VnextSupervisorRecord {
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

  private readSupervisorRow(): VnextSupervisorRecord | undefined {
    const row = this.database.prepare("SELECT runtime_id, pid, port, token_hash, started_at, heartbeat_at, state FROM supervisor WHERE singleton_id = 1").get() as
      | { runtime_id: string; pid: number; port: number; token_hash: string; started_at: string; heartbeat_at: string; state: VnextSupervisorRecord["state"] }
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

  supervisor(): VnextSupervisorRecord | undefined {
    return this.readSupervisorRow();
  }

  /** Register or revalidate a project's home binding. Home Runtime is immutable. */
  registerProject(registration: { projectId: string; projectRoot: string; homeRuntimeId: string; configRevision?: string; now: string }): VnextProjectRegistration {
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
        const result: VnextProjectRegistration = {
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

  project(projectId: string): VnextProjectRegistration | undefined {
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

  projectByRoot(projectRoot: string): VnextProjectRegistration | undefined {
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

export type VnextRunStatus = "created" | "preparing" | "running" | "waiting" | "blocked_uncertain" | "cancelling" | "cancelled" | "completed" | "failed";

export const VNEXT_RUN_EVENT_SCHEMA = "kxm.run-event.v1";
export const VNEXT_ABSENT_MEMORY_REVISION = "ctxrev_absent";

export interface VnextRunRecord {
  runId: string;
  projectId: string;
  homeRuntimeId: string;
  workflowId: string;
  promptSha256: string;
  status: VnextRunStatus;
  configRevision: string;
  memoryRevision: string;
  executorPolicyRevision: string;
  toolPolicyRevision: string;
  createdAt: string;
  updatedAt: string;
}

export interface VnextRunEvent {
  schema: typeof VNEXT_RUN_EVENT_SCHEMA;
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

export interface VnextRunPlanRow {
  runId: string;
  runPlanHash: string;
  envelope: string;
  pinnedSequence: number;
}

export interface VnextRunStateRow {
  runId: string;
  lastSequence: number;
  state: string;
}

export interface VnextAttemptCapabilityRow {
  attemptId: string;
  runId: string;
  assignmentId: string;
  stepId: string;
  stepAttempt: number;
  producerId: string;
  capabilityHash: string;
  state: "issued" | "settled" | "revoked";
}

export interface VnextCommandRecord {
  commandId: string;
  runId: string;
  kind: string;
  result: Record<string, unknown>;
  recordedAt: string;
}

export const VNEXT_EVENT_STORE_SCHEMA_VERSION = 2;

const EVENT_STORE_TABLES = {
  runs: ["run_id", "project_id", "home_runtime_id", "workflow_id", "prompt_sha256", "status", "config_revision", "memory_revision", "executor_policy_revision", "tool_policy_revision", "created_at", "updated_at"],
  events: ["project_id", "run_id", "sequence", "event_id", "event_type", "command_id", "occurred_at", "recorded_at", "monotonic_ns", "config_revision", "memory_revision", "executor_policy_revision", "tool_policy_revision", "payload", "schema", "home_runtime_id"],
  commands: ["command_id", "run_id", "kind", "result", "recorded_at"],
  run_plans: ["run_id", "run_plan_hash", "envelope", "pinned_sequence"],
  run_state: ["run_id", "last_sequence", "state"],
  attempt_capabilities: ["attempt_id", "run_id", "assignment_id", "step_id", "step_attempt", "producer_id", "capability_hash", "state"],
} as const;

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
`;

export class VnextRunEventStore {
  readonly path: string;
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.path = resolve(path);
    this.database = openDatabase(this.path, "run event store", {
      schema: EVENT_STORE_SCHEMA,
      version: VNEXT_EVENT_STORE_SCHEMA_VERSION,
      tables: EVENT_STORE_TABLES,
    });
  }

  close(): void {
    this.database.close();
  }

  /** Run one immutable transaction, rolling back on any failure. */
  transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
  }

  command(commandId: string): VnextCommandRecord | undefined {
    const row = this.database.prepare("SELECT command_id, run_id, kind, result, recorded_at FROM commands WHERE command_id = ?").get(commandId) as
      | { command_id: string; run_id: string; kind: string; result: string; recorded_at: string }
      | undefined;
    return row
      ? { commandId: row.command_id, runId: row.run_id, kind: row.kind, result: JSON.parse(row.result) as Record<string, unknown>, recordedAt: row.recorded_at }
      : undefined;
  }

  insertCommand(record: VnextCommandRecord): void {
    this.database.prepare("INSERT INTO commands (command_id, run_id, kind, result, recorded_at) VALUES (?, ?, ?, ?, ?)")
      .run(record.commandId, record.runId, record.kind, JSON.stringify(record.result), record.recordedAt);
  }

  insertRun(record: VnextRunRecord): void {
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

  updateRunStatus(runId: string, status: VnextRunStatus, updatedAt: string): void {
    this.database.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?").run(status, updatedAt, runId);
  }

  run(runId: string): VnextRunRecord | undefined {
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
        status: VnextRunStatus;
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

  runsForProject(projectId: string, limit = 50): VnextRunRecord[] {
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

  appendEvent(event: VnextRunEvent): void {
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
  }

  events(runId: string, afterSequence = 0, limit = 200): VnextRunEvent[] {
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
      schema: typeof VNEXT_RUN_EVENT_SCHEMA;
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

  insertRunPlan(row: VnextRunPlanRow): void {
    this.database.prepare("INSERT INTO run_plans (run_id, run_plan_hash, envelope, pinned_sequence) VALUES (?, ?, ?, ?)")
      .run(row.runId, row.runPlanHash, row.envelope, row.pinnedSequence);
  }

  runPlan(runId: string): VnextRunPlanRow | undefined {
    const row = this.database.prepare("SELECT run_id, run_plan_hash, envelope, pinned_sequence FROM run_plans WHERE run_id = ?").get(runId) as
      | { run_id: string; run_plan_hash: string; envelope: string; pinned_sequence: number }
      | undefined;
    return row
      ? { runId: row.run_id, runPlanHash: row.run_plan_hash, envelope: row.envelope, pinnedSequence: row.pinned_sequence }
      : undefined;
  }

  runState(runId: string): VnextRunStateRow | undefined {
    const row = this.database.prepare("SELECT run_id, last_sequence, state FROM run_state WHERE run_id = ?").get(runId) as
      | { run_id: string; last_sequence: number; state: string }
      | undefined;
    return row ? { runId: row.run_id, lastSequence: row.last_sequence, state: row.state } : undefined;
  }

  upsertRunState(row: VnextRunStateRow): void {
    this.database.prepare(`
      INSERT INTO run_state (run_id, last_sequence, state) VALUES (?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET last_sequence = excluded.last_sequence, state = excluded.state
    `).run(row.runId, row.lastSequence, row.state);
  }

  insertCapability(row: VnextAttemptCapabilityRow): void {
    this.database.prepare(`
      INSERT INTO attempt_capabilities (attempt_id, run_id, assignment_id, step_id, step_attempt, producer_id, capability_hash, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.attemptId, row.runId, row.assignmentId, row.stepId, row.stepAttempt, row.producerId, row.capabilityHash, row.state);
  }

  capabilityByHash(capabilityHash: string): VnextAttemptCapabilityRow | undefined {
    return capabilityFromRow(this.database.prepare(`
      SELECT attempt_id, run_id, assignment_id, step_id, step_attempt, producer_id, capability_hash, state
      FROM attempt_capabilities WHERE capability_hash = ?
    `).get(capabilityHash) as CapabilitySqlRow | undefined);
  }

  capabilityByAttempt(attemptId: string): VnextAttemptCapabilityRow | undefined {
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
}

function runFromRow(row: {
  run_id: string;
  project_id: string;
  home_runtime_id: string;
  workflow_id: string;
  prompt_sha256: string;
  status: VnextRunStatus;
  config_revision: string;
  memory_revision: string;
  executor_policy_revision: string;
  tool_policy_revision: string;
  created_at: string;
  updated_at: string;
}): VnextRunRecord {
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
export function newVnextRunId(): string {
  return `run_${randomUUID().replaceAll("-", "")}`;
}

export function newVnextEventId(): string {
  return `evt_${randomUUID().replaceAll("-", "")}`;
}

export function newVnextCommandId(): string {
  return `cmd_${randomUUID().replaceAll("-", "")}`;
}

export function newVnextAssignmentId(): string {
  return `asg_${randomUUID().replaceAll("-", "")}`;
}

export function newVnextAttemptId(): string {
  return `att_${randomUUID().replaceAll("-", "")}`;
}

type CapabilitySqlRow = {
  attempt_id: string;
  run_id: string;
  assignment_id: string;
  step_id: string;
  step_attempt: number;
  producer_id: string;
  capability_hash: string;
  state: VnextAttemptCapabilityRow["state"];
};

function capabilityFromRow(row: CapabilitySqlRow | undefined): VnextAttemptCapabilityRow | undefined {
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

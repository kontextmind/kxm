import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync, openReadOnlyDatabase } from "./sqlite.ts";
import type { AgentIdentity, AgentRecord, MessageRecord } from "./protocol.ts";
import type { WorkflowRun } from "./workflow.ts";
import { readRoutingRecords } from "./telemetry.ts";
import type { RoutingRecord, RoutingRecordV2 } from "./routing.ts";

export interface MeshTuiPidClaim {
  file: string;
  role?: string;
  pid?: number;
  live: boolean;
}

export interface MeshTuiRunStage {
  id: string;
  label?: string;
  status: string;
  attempts?: number;
}

export interface MeshTuiRun {
  id: string;
  status: string;
  definitionId: string;
  project: string;
  currentStage?: string;
  targetAgentName?: string;
  updatedAt?: string;
  progress?: { done: number; total: number };
  stages?: MeshTuiRunStage[];
}

export interface MeshTuiPlan {
  id: string;
  runId: string;
  summary: string;
  createdAt: string;
  stageId?: string;
  severity?: string;
}

export type MeshTuiOpenMessage = Pick<MessageRecord, "id" | "status" | "fromName" | "toName" | "delivery" | "createdAt" | "correlationId">;

export interface LocalMeshSnapshot {
  source?: "legacy" | "runtime" | "both" | undefined;
  agents: AgentRecord[];
  openMessages: MeshTuiOpenMessage[];
  openMessageTotal: number;
  runs: MeshTuiRun[];
  runTotal: number;
  plans: MeshTuiPlan[];
  pids: MeshTuiPidClaim[];
  spend?: Array<{ recordedAt: string; routing: RoutingRecord | RoutingRecordV2 }> | undefined;
}

/** Limits a snapshot to one project and one recipient.
 *
 * `hubProject` is the hub project key stored on legacy messages and runs.
 * `runtimeProjectId` is the `.kxm/project.yaml` id that keys Runtime runs;
 * without it the snapshot reads no Runtime runs. `recipientName` selects the
 * open messages addressed to this agent; without it no messages are read. A
 * scoped snapshot never reads journal plans. */
export interface LocalMeshSnapshotScope {
  hubProject: string;
  runtimeProjectId?: string | undefined;
  recipientName?: string | undefined;
}

export interface LocalMeshSnapshotOptions {
  env?: NodeJS.ProcessEnv;
  projectRoot?: string;
  kxmStateRoot?: string;
  /** SQLite busy timeout for every database this snapshot opens. Default 5000. */
  busyTimeoutMs?: number;
  scope?: LocalMeshSnapshotScope;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const RUNTIME_PROJECT_KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readJsonRows<T>(database: DatabaseSync, sql: string, params: string[] = []): T[] {
  const rows = database.prepare(sql).all(...params) as Array<{ record: string }>;
  const out: T[] = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.record) as T);
    } catch {
      // skip corrupt rows
    }
  }
  return out;
}

const DONE_STAGE_STATUSES = new Set(["passed", "failed", "warning"]);

export function summarizeMeshRun(run: Pick<WorkflowRun, "id" | "status" | "definitionId" | "project" | "currentStage" | "targetAgentName" | "updatedAt" | "stages">): MeshTuiRun {
  const stages = (run.stages ?? []).map((stage) => ({
    id: stage.id,
    ...(stage.label ? { label: stage.label } : {}),
    status: stage.status,
    ...(stage.attempts ? { attempts: stage.attempts } : {}),
  }));
  const total = stages.length;
  const done = stages.filter((stage) => DONE_STAGE_STATUSES.has(stage.status)).length;
  return {
    id: run.id,
    status: run.status,
    definitionId: run.definitionId,
    project: run.project,
    ...(run.currentStage ? { currentStage: run.currentStage } : {}),
    ...(run.targetAgentName ? { targetAgentName: run.targetAgentName } : {}),
    ...(run.updatedAt ? { updatedAt: run.updatedAt } : {}),
    ...(total > 0 ? { progress: { done, total }, stages } : {}),
  };
}

function summarizeMeshPlan(entry: { id: string; runId: string; category?: string; summary: string; createdAt: string; stageId?: string; severity?: string }): MeshTuiPlan | undefined {
  if (entry.category && entry.category !== "plan") return undefined;
  const summary = entry.summary.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!summary) return undefined;
  return {
    id: entry.id,
    runId: entry.runId,
    summary,
    createdAt: entry.createdAt,
    ...(entry.stageId ? { stageId: entry.stageId } : {}),
    ...(entry.severity ? { severity: entry.severity } : {}),
  };
}

function readPlanMetadata(database: DatabaseSync): MeshTuiPlan[] {
  try {
    const rows = database.prepare(`
      SELECT record FROM workflow_journal
      WHERE category = 'plan'
      ORDER BY rowid DESC
      LIMIT 16
    `).all() as Array<{ record: string }>;
    const plans: MeshTuiPlan[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.record) as {
          id?: string;
          runId?: string;
          category?: string;
          summary?: string;
          createdAt?: string;
          stageId?: string;
          severity?: string;
          details?: string;
        };
        if (typeof parsed.id !== "string" || typeof parsed.runId !== "string" || typeof parsed.summary !== "string" || typeof parsed.createdAt !== "string") continue;
        const plan = summarizeMeshPlan({
          id: parsed.id,
          runId: parsed.runId,
          summary: parsed.summary,
          createdAt: parsed.createdAt,
          ...(parsed.category ? { category: parsed.category } : {}),
          ...(parsed.stageId ? { stageId: parsed.stageId } : {}),
          ...(parsed.severity ? { severity: parsed.severity } : {}),
        });
        if (plan) plans.push(plan);
      } catch { /* skip malformed journal rows */ }
    }
    return plans;
  } catch {
    return [];
  }
}

function countRows(database: DatabaseSync, table: "messages" | "workflow_runs", where = "", params: string[] = []): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`).get(...params) as { count?: number | bigint } | undefined;
  return Number(row?.count ?? 0);
}

const OPEN_MESSAGE_WHERE = " WHERE json_extract(record, '$.status') IN ('queued', 'delivered')";
const SCOPED_MESSAGE_WHERE = `${OPEN_MESSAGE_WHERE}
      AND json_extract(record, '$.project') = ?
      AND COALESCE(json_extract(record, '$.toName'), json_extract(record, '$.to')) = ?`;

function readOpenMessageMetadata(database: DatabaseSync, where = OPEN_MESSAGE_WHERE, params: string[] = []): MeshTuiOpenMessage[] {
  const rows = database.prepare(`
    SELECT
      json_extract(record, '$.id') AS id,
      json_extract(record, '$.status') AS status,
      COALESCE(json_extract(record, '$.fromName'), json_extract(record, '$.from')) AS fromName,
      COALESCE(json_extract(record, '$.toName'), json_extract(record, '$.to')) AS toName,
      json_extract(record, '$.delivery') AS delivery,
      json_extract(record, '$.createdAt') AS createdAt,
      json_extract(record, '$.correlationId') AS correlationId
    FROM messages${where}
    ORDER BY json_extract(record, '$.createdAt') DESC
    LIMIT 16
  `).all(...params) as Array<Record<string, unknown>>;
  const messages: MeshTuiOpenMessage[] = [];
  for (const row of rows) {
    if (
      typeof row.id !== "string"
      || (row.status !== "queued" && row.status !== "delivered")
      || typeof row.fromName !== "string"
      || typeof row.toName !== "string"
      || (row.delivery !== "steer" && row.delivery !== "followUp" && row.delivery !== "nextTurn")
      || typeof row.createdAt !== "string"
    ) continue;
    messages.push({
      id: row.id,
      status: row.status,
      fromName: row.fromName,
      toName: row.toName,
      delivery: row.delivery,
      createdAt: row.createdAt,
      ...(typeof row.correlationId === "string" ? { correlationId: row.correlationId } : {}),
    });
  }
  return messages;
}

export function resolveKxmSnapshotPaths(cwd: string, env: NodeJS.ProcessEnv = process.env): { dataPath: string; stateDir: string } {
  const stateDir = env.KXM_STATE_DIR?.trim() || join(cwd, ".kxm", "state");
  const configured = env.KXM_DATA_PATH?.trim();
  const dataPath = configured ? resolve(cwd, configured) : join(stateDir, "kxm.db");
  return { dataPath, stateDir };
}

function resolveKxmStateRoot(
  stateDir: string,
  options?: { env?: NodeJS.ProcessEnv; kxmStateRoot?: string },
): string | undefined {
  if (options?.kxmStateRoot && existsSync(options.kxmStateRoot)) {
    return resolve(options.kxmStateRoot);
  }
  if (existsSync(join(stateDir, "runtime", "registry.db")) || existsSync(join(stateDir, "runtime", "projects"))) {
    return stateDir;
  }
  const env = options?.env ?? process.env;
  const explicit = env.KXM_STATE_HOME?.trim() || env.KXM_USER_STATE_DIR?.trim() || env.KXM_STATE_ROOT?.trim();
  if (explicit && isAbsolute(explicit) && existsSync(resolve(explicit))) {
    return resolve(explicit);
  }
  let base: string;
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    base = localAppData && isAbsolute(localAppData) ? localAppData : join(homedir(), "AppData", "Local");
    base = resolve(base, "KXM");
  } else if (process.platform === "darwin") {
    base = resolve(homedir(), "Library", "Application Support", "KXM");
  } else {
    const xdgState = env.XDG_STATE_HOME?.trim();
    base = xdgState && isAbsolute(xdgState) ? xdgState : join(homedir(), ".local", "state");
    base = resolve(base, "kxm");
  }
  if (existsSync(base)) return base;
  return undefined;
}

function readRuntimeRuns(eventDb: DatabaseSync, projectId: string | undefined): { runs: MeshTuiRun[]; total: number } {
  const where = projectId === undefined ? "" : " WHERE project_id = ?";
  const params = projectId === undefined ? [] : [projectId];
  const runRows = eventDb.prepare(`
    SELECT run_id, project_id, workflow_id, status, created_at, updated_at
    FROM runs${where} ORDER BY created_at DESC, run_id DESC LIMIT 8
  `).all(...params) as Array<{
    run_id: string;
    project_id: string;
    workflow_id: string;
    status: string;
    created_at: string;
    updated_at: string;
  }>;
  const countRow = eventDb.prepare(`SELECT COUNT(*) AS total FROM runs${where}`).get(...params) as { total: number } | undefined;
  return {
    total: Number(countRow?.total ?? runRows.length),
    runs: runRows.map((r) => ({
      id: r.run_id,
      status: r.status,
      definitionId: r.workflow_id,
      project: r.project_id,
      updatedAt: r.updated_at || r.created_at,
    })),
  };
}

export function loadLocalMeshSnapshot(
  dataPath: string,
  stateDir: string,
  options?: LocalMeshSnapshotOptions,
): LocalMeshSnapshot {
  const busyTimeoutMs = Math.max(0, Math.trunc(Number(options?.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)) || 0);
  const busyTimeout = `PRAGMA busy_timeout = ${busyTimeoutMs}`;
  const scope = options?.scope;
  let hasLegacy = false;
  let agents: AgentRecord[] = [];
  let openMessages: MeshTuiOpenMessage[] = [];
  let openMessageTotal = 0;
  let legacyRuns: WorkflowRun[] = [];
  let legacyRunTotal = 0;
  let plans: MeshTuiPlan[] = [];
  if (existsSync(dataPath)) {
    hasLegacy = true;
    const database = openReadOnlyDatabase(dataPath);
    try {
      database.exec(busyTimeout);
      // Stored rows carry identity only. Presence is derived here against the
      // default lease window, because the hub's configured `staleAfterMs` is
      // not in the file; a reachable hub's own records replace these.
      // Stored rows carry identity only. Presence is NOT computed here: the hub's
      // configured staleAfterMs and its clock are not in the file, so a reader-side
      // lease would mislabel agents against the hub's own projection. The stored
      // `online` boolean is the only durable truth; the hub's /v1/agents or the
      // ops snapshot is the authoritative presence source.
      agents = readJsonRows<AgentIdentity>(database, "SELECT record FROM agents");
      if (!scope) {
        openMessages = readOpenMessageMetadata(database);
        openMessageTotal = countRows(database, "messages", OPEN_MESSAGE_WHERE);
        legacyRuns = readJsonRows<WorkflowRun>(database, "SELECT record FROM workflow_runs ORDER BY rowid DESC LIMIT 8");
        legacyRunTotal = countRows(database, "workflow_runs");
        plans = readPlanMetadata(database);
      } else {
        // Scoped: this project's runs and this recipient's open messages only.
        // Plans stay empty: journal text belongs to other agents' runs.
        if (scope.recipientName) {
          const messageParams = [scope.hubProject, scope.recipientName];
          openMessages = readOpenMessageMetadata(database, SCOPED_MESSAGE_WHERE, messageParams);
          openMessageTotal = countRows(database, "messages", SCOPED_MESSAGE_WHERE, messageParams);
        }
        const runWhere = " WHERE json_extract(record, '$.project') = ?";
        legacyRuns = readJsonRows<WorkflowRun>(database, `SELECT record FROM workflow_runs${runWhere} ORDER BY rowid DESC LIMIT 8`, [scope.hubProject]);
        legacyRunTotal = countRows(database, "workflow_runs", runWhere, [scope.hubProject]);
      }
    } finally {
      database.close();
    }
  }

  // KXM discovery
  let hasKxm = false;
  const kxmRuns: MeshTuiRun[] = [];
  let kxmRunTotal = 0;
  // A scoped snapshot without a Runtime project id reads no Runtime runs.
  const kxmStateRoot = scope && !scope.runtimeProjectId ? undefined : resolveKxmStateRoot(stateDir, options);
  if (kxmStateRoot) {
    const runtimeDir = join(kxmStateRoot, "runtime");
    const registryDbPath = join(runtimeDir, "registry.db");
    const projectsDir = join(runtimeDir, "projects");

    const projectKeys = new Set<string>();

    if (existsSync(registryDbPath)) {
      hasKxm = true;
      try {
        const regDb = openReadOnlyDatabase(registryDbPath);
        try {
          regDb.exec(busyTimeout);
          const pRows = (scope
            ? regDb.prepare("SELECT project_key FROM projects WHERE project_id = ?").all(scope.runtimeProjectId)
            : regDb.prepare("SELECT project_key FROM projects").all()) as Array<{ project_key: string }>;
          for (const row of pRows) {
            if (row.project_key) projectKeys.add(row.project_key);
          }
        } finally {
          regDb.close();
        }
      } catch { /* registry error */ }
    }

    // Scoped: only the registry's key for this project, never every project
    // directory on the machine.
    if (!scope && existsSync(projectsDir)) {
      try {
        for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            projectKeys.add(entry.name);
          }
        }
      } catch { /* projectsDir unreadable */ }
    }

    for (const key of projectKeys) {
      if (scope && !RUNTIME_PROJECT_KEY.test(key)) continue;
      const eventDbPath = join(projectsDir, key, "run-events.db");
      if (existsSync(eventDbPath)) {
        hasKxm = true;
        try {
          const eventDb = openReadOnlyDatabase(eventDbPath);
          try {
            eventDb.exec(busyTimeout);
            const { runs, total } = readRuntimeRuns(eventDb, scope?.runtimeProjectId);
            kxmRunTotal += total;
            kxmRuns.push(...runs);
          } finally {
            eventDb.close();
          }
        } catch { /* eventDb unreadable */ }
      }
    }
  }

  const pids: MeshTuiPidClaim[] = [];
  if (existsSync(stateDir)) {
    for (const file of readdirSync(stateDir).filter((name) => name.endsWith(".pid"))) {
      try {
        const record = JSON.parse(readFileSync(join(stateDir, file), "utf8")) as { pid?: number; role?: string };
        pids.push({
          file,
          ...(record.role ? { role: record.role } : {}),
          ...(record.pid !== undefined ? { pid: record.pid } : {}),
          live: Number.isInteger(record.pid) && record.pid! > 0 && processExists(record.pid!),
        });
      } catch {
        pids.push({ file, live: false });
      }
    }
  }

  // Combine runs
  const combinedRuns = [
    ...legacyRuns.map((run) => summarizeMeshRun(run)),
    ...kxmRuns,
  ];
  const seenIds = new Set<string>();
  const uniqueRuns: MeshTuiRun[] = [];
  for (const run of combinedRuns) {
    if (!seenIds.has(run.id)) {
      seenIds.add(run.id);
      uniqueRuns.push(run);
    }
  }
  uniqueRuns.sort((a, b) => {
    const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return bt - at;
  });
  const runs = uniqueRuns.slice(0, 16);
  const runTotal = legacyRunTotal + kxmRunTotal;

  // Source determination
  let source: "legacy" | "runtime" | "both";
  if (hasLegacy && hasKxm) {
    source = "both";
  } else if (hasKxm) {
    source = "runtime";
  } else {
    source = "legacy";
  }

  // Spend from telemetry
  const telemetryFile = join(stateDir, "telemetry.jsonl");
  const spend = existsSync(telemetryFile) ? readRoutingRecords(telemetryFile) : [];

  return {
    source,
    agents: agents.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
    openMessages,
    openMessageTotal,
    runs,
    runTotal,
    plans,
    pids,
    spend,
  };
}

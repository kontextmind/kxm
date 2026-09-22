import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "./sqlite.ts";
import { toAgentRecord } from "./protocol.ts";
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readJsonRows<T>(database: DatabaseSync, sql: string): T[] {
  const rows = database.prepare(sql).all() as Array<{ record: string }>;
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

function countRows(database: DatabaseSync, table: "messages" | "workflow_runs", where = ""): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`).get() as { count?: number | bigint } | undefined;
  return Number(row?.count ?? 0);
}

function readOpenMessageMetadata(database: DatabaseSync): MeshTuiOpenMessage[] {
  const rows = database.prepare(`
    SELECT
      json_extract(record, '$.id') AS id,
      json_extract(record, '$.status') AS status,
      COALESCE(json_extract(record, '$.fromName'), json_extract(record, '$.from')) AS fromName,
      COALESCE(json_extract(record, '$.toName'), json_extract(record, '$.to')) AS toName,
      json_extract(record, '$.delivery') AS delivery,
      json_extract(record, '$.createdAt') AS createdAt,
      json_extract(record, '$.correlationId') AS correlationId
    FROM messages
    WHERE json_extract(record, '$.status') IN ('queued', 'delivered')
    ORDER BY json_extract(record, '$.createdAt') DESC
    LIMIT 16
  `).all() as Array<Record<string, unknown>>;
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

export function loadLocalMeshSnapshot(
  dataPath: string,
  stateDir: string,
  options?: { env?: NodeJS.ProcessEnv; projectRoot?: string; kxmStateRoot?: string },
): LocalMeshSnapshot {
  let hasLegacy = false;
  let agents: AgentRecord[] = [];
  let openMessages: MeshTuiOpenMessage[] = [];
  let openMessageTotal = 0;
  let legacyRuns: WorkflowRun[] = [];
  let legacyRunTotal = 0;
  let plans: MeshTuiPlan[] = [];
  if (existsSync(dataPath)) {
    hasLegacy = true;
    const database = new DatabaseSync(dataPath, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      // Stored rows carry identity only. Presence is derived here against the
      // default lease window, because the hub's configured `staleAfterMs` is
      // not in the file; a reachable hub's own records replace these.
      agents = readJsonRows<AgentIdentity>(database, "SELECT record FROM agents")
        .map((agent) => toAgentRecord(agent));
      openMessages = readOpenMessageMetadata(database);
      openMessageTotal = countRows(database, "messages", " WHERE json_extract(record, '$.status') IN ('queued', 'delivered')");
      legacyRuns = readJsonRows<WorkflowRun>(database, "SELECT record FROM workflow_runs ORDER BY rowid DESC LIMIT 8");
      legacyRunTotal = countRows(database, "workflow_runs");
      plans = readPlanMetadata(database);
    } finally {
      database.close();
    }
  }

  // KXM discovery
  let hasKxm = false;
  const kxmRuns: MeshTuiRun[] = [];
  let kxmRunTotal = 0;
  const kxmStateRoot = resolveKxmStateRoot(stateDir, options);
  if (kxmStateRoot) {
    const runtimeDir = join(kxmStateRoot, "runtime");
    const registryDbPath = join(runtimeDir, "registry.db");
    const projectsDir = join(runtimeDir, "projects");

    const projectKeys = new Set<string>();

    if (existsSync(registryDbPath)) {
      hasKxm = true;
      try {
        const regDb = new DatabaseSync(registryDbPath, { readOnly: true });
        try {
          regDb.exec("PRAGMA busy_timeout = 5000");
          const pRows = regDb.prepare("SELECT project_key FROM projects").all() as Array<{ project_key: string }>;
          for (const row of pRows) {
            if (row.project_key) projectKeys.add(row.project_key);
          }
        } finally {
          regDb.close();
        }
      } catch { /* registry error */ }
    }

    if (existsSync(projectsDir)) {
      try {
        for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            projectKeys.add(entry.name);
          }
        }
      } catch { /* projectsDir unreadable */ }
    }

    for (const key of projectKeys) {
      const eventDbPath = join(projectsDir, key, "run-events.db");
      if (existsSync(eventDbPath)) {
        hasKxm = true;
        try {
          const eventDb = new DatabaseSync(eventDbPath, { readOnly: true });
          try {
            eventDb.exec("PRAGMA busy_timeout = 5000");
            const runRows = eventDb.prepare(`
              SELECT run_id, project_id, workflow_id, status, created_at, updated_at
              FROM runs ORDER BY created_at DESC, run_id DESC LIMIT 8
            `).all() as Array<{
              run_id: string;
              project_id: string;
              workflow_id: string;
              status: string;
              created_at: string;
              updated_at: string;
            }>;
            const countRow = eventDb.prepare("SELECT COUNT(*) AS total FROM runs").get() as { total: number } | undefined;
            kxmRunTotal += Number(countRow?.total ?? runRows.length);
            for (const r of runRows) {
              kxmRuns.push({
                id: r.run_id,
                status: r.status,
                definitionId: r.workflow_id,
                project: r.project_id,
                updatedAt: r.updated_at || r.created_at,
              });
            }
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

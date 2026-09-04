import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentRecord, MessageRecord } from "./protocol.ts";
import type { WorkflowRun } from "./workflow.ts";

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
  agents: AgentRecord[];
  openMessages: MeshTuiOpenMessage[];
  openMessageTotal: number;
  runs: MeshTuiRun[];
  runTotal: number;
  plans: MeshTuiPlan[];
  pids: MeshTuiPidClaim[];
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

export function loadLocalMeshSnapshot(dataPath: string, stateDir: string): LocalMeshSnapshot {
  let agents: AgentRecord[] = [];
  let openMessages: MeshTuiOpenMessage[] = [];
  let openMessageTotal = 0;
  let runs: WorkflowRun[] = [];
  let runTotal = 0;
  let plans: MeshTuiPlan[] = [];
  if (existsSync(dataPath)) {
    const database = new DatabaseSync(dataPath, { readOnly: true });
    try {
      agents = readJsonRows<AgentRecord>(database, "SELECT record FROM agents");
      openMessages = readOpenMessageMetadata(database);
      openMessageTotal = countRows(database, "messages", " WHERE json_extract(record, '$.status') IN ('queued', 'delivered')");
      runs = readJsonRows<WorkflowRun>(database, "SELECT record FROM workflow_runs ORDER BY rowid DESC LIMIT 8");
      runTotal = countRows(database, "workflow_runs");
      plans = readPlanMetadata(database);
    } finally {
      database.close();
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
  return {
    agents: agents.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
    openMessages,
    openMessageTotal,
    runs: runs.map((run) => summarizeMeshRun(run)),
    runTotal,
    plans,
    pids,
  };
}

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "./sqlite.ts";
import { discoverKxmProjectRoot } from "./project-config.ts";
import { kxmRuntimePaths, projectRuntimeKey } from "./runtime-store.ts";
import { parseRoutingRecordV2, ROUTING_RECORD_V2_SCHEMA, type RoutingRecord, type RoutingRecordV2 } from "./routing.ts";
import { readRoutingRecords, telemetryPath } from "./telemetry.ts";

/**
 * Routing-record sources for `kxm improve` and `kxm routing report`.
 *
 * The project's Runtime event store is read read-only: one SELECT over the
 * events table, never the runs table, the run plans, or the prompts sidecar,
 * and never a write or a migration. Each settled attempt's outcome is resolved
 * in memory from the event log; nothing resolved here is stored.
 */

export interface RoutingSourceSummary {
  kind: "engine" | "telemetry" | "file";
  path: string;
  exists: boolean;
  /** Records this source contributed before cross-source de-duplication. */
  records: number;
  skippedInvalid?: number;
  excludedSimulated?: number;
  undecided?: number;
  duplicatesDropped?: number;
}

export interface EngineRoutingRead {
  records: RoutingRecordV2[];
  source: RoutingSourceSummary;
}

export interface LoadedRoutingSources {
  projectRoot?: string;
  records: Array<RoutingRecord | RoutingRecordV2>;
  sources: RoutingSourceSummary[];
}

const ENGINE_EVENTS_SQL = "SELECT run_id, sequence, event_type, payload FROM events"
  + " WHERE event_type IN ('routing.attempt.recorded','step.entered','run.status_changed')"
  + " ORDER BY run_id, sequence";

/** The simulated producer's harness label; its attempts measure nothing. */
const SIMULATED_HARNESS = "driver-simulated";

/** The project's Runtime event store, derived exactly as the Runtime derives it. */
export function kxmProjectRunEventsPath(projectRoot: string, env: NodeJS.ProcessEnv): string {
  return join(kxmRuntimePaths({ env }).projectsDir, projectRuntimeKey(projectRoot), "run-events.db");
}

interface RunLog {
  lastStatus?: string;
  /** Latest step.entered sequence per step. */
  lastEntered: Map<string, number>;
  routing: Array<{ sequence: number; payload: string }>;
}

function parsePayload(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read every Runtime-settled routing record from one project's event store.
 *
 * Outcomes resolve per record, first rule that applies: a record-time
 * 'blocked' or 'failed' stays; a later step.entered for the same step is
 * 'reworked'; a completed run is 'accepted'; a failed run is 'failed';
 * anything else (cancelled, still running) is left unset and counted
 * undecided. Simulated attempts are dropped and counted.
 */
export function readEngineRoutingRecords(path: string): EngineRoutingRead {
  const source: RoutingSourceSummary = {
    kind: "engine",
    path,
    exists: false,
    records: 0,
    skippedInvalid: 0,
    excludedSimulated: 0,
    undecided: 0,
    duplicatesDropped: 0,
  };
  if (!existsSync(path)) return { records: [], source };
  source.exists = true;

  let rows: Array<Record<string, unknown>>;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 5000");
    rows = database.prepare(ENGINE_EVENTS_SQL).all();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`improve_source_unreadable: ${path}: ${message}`, { cause: error });
  } finally {
    try {
      database?.close();
    } catch {
      // Closing a read-only handle has nothing to flush.
    }
  }

  const runs = new Map<string, RunLog>();
  for (const row of rows) {
    const runId = String(row.run_id);
    const sequence = Number(row.sequence);
    const eventType = String(row.event_type);
    const payload = typeof row.payload === "string" ? row.payload : "";
    let run = runs.get(runId);
    if (!run) {
      run = { lastEntered: new Map(), routing: [] };
      runs.set(runId, run);
    }
    if (eventType === "routing.attempt.recorded") {
      run.routing.push({ sequence, payload });
    } else if (eventType === "step.entered") {
      const stepId = parsePayload(payload)?.stepId;
      if (typeof stepId === "string") run.lastEntered.set(stepId, sequence);
    } else if (eventType === "run.status_changed") {
      const status = parsePayload(payload)?.status;
      if (typeof status === "string") run.lastStatus = status;
    }
  }

  let skippedInvalid = 0;
  let excludedSimulated = 0;
  let undecided = 0;
  const records: RoutingRecordV2[] = [];
  for (const run of runs.values()) {
    for (const entry of run.routing) {
      let record: RoutingRecordV2;
      try {
        record = parseRoutingRecordV2(parsePayload(entry.payload)?.routing);
      } catch {
        skippedInvalid += 1;
        continue;
      }
      if (record.harness === SIMULATED_HARNESS) {
        excludedSimulated += 1;
        continue;
      }
      const recorded = record.finalOutcome;
      if (recorded === "blocked" || recorded === "failed") {
        // A gate-negative verdict known at settle time stands.
      } else if ((run.lastEntered.get(record.stepId) ?? -1) > entry.sequence) {
        record.finalOutcome = "reworked";
      } else if (run.lastStatus === "completed") {
        record.finalOutcome = "accepted";
      } else if (run.lastStatus === "failed") {
        record.finalOutcome = "failed";
      } else {
        delete record.finalOutcome;
        undecided += 1;
      }
      records.push(record);
    }
  }
  return {
    records,
    source: { ...source, records: records.length, skippedInvalid, excludedSimulated, undecided },
  };
}

function readJsonlSource(kind: "telemetry" | "file", path: string): { records: Array<RoutingRecord | RoutingRecordV2>; source: RoutingSourceSummary } {
  const exists = existsSync(path);
  const records = exists ? readRoutingRecords(path).map((entry) => entry.routing) : [];
  return { records, source: { kind, path, exists, records: records.length, duplicatesDropped: 0 } };
}

function attemptKey(record: RoutingRecord | RoutingRecordV2): string | undefined {
  if (record.schema !== ROUTING_RECORD_V2_SCHEMA) return undefined;
  const attemptId = typeof record.attemptId === "string" ? record.attemptId.trim() : "";
  return attemptId.length > 0 ? attemptId : undefined;
}

/**
 * Load routing records for improvement and routing reports.
 *
 * With `file`, only that file is read. Otherwise the project's Runtime event
 * store (when cwd is inside a KXM project) comes first, then telemetry.jsonl.
 * v2 records are de-duplicated by attemptId: the first occurrence wins and the
 * later source counts the drop.
 */
export function loadRoutingSources(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  logsDir: string;
  file?: string | undefined;
}): LoadedRoutingSources {
  const projectRoot = discoverKxmProjectRoot(options.cwd);
  const reads: Array<{ records: Array<RoutingRecord | RoutingRecordV2>; source: RoutingSourceSummary }> = [];
  if (options.file !== undefined) {
    reads.push(readJsonlSource("file", resolve(options.cwd, options.file)));
  } else {
    if (projectRoot !== undefined) reads.push(readEngineRoutingRecords(kxmProjectRunEventsPath(projectRoot, options.env)));
    reads.push(readJsonlSource("telemetry", telemetryPath(options.logsDir)));
  }

  const seen = new Set<string>();
  const records: Array<RoutingRecord | RoutingRecordV2> = [];
  for (const read of reads) {
    let dropped = 0;
    for (const record of read.records) {
      const key = attemptKey(record);
      if (key !== undefined) {
        if (seen.has(key)) {
          dropped += 1;
          continue;
        }
        seen.add(key);
      }
      records.push(record);
    }
    read.source.duplicatesDropped = dropped;
  }

  return {
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    records,
    sources: reads.map((read) => read.source),
  };
}

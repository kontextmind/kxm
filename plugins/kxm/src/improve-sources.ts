import { existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, openReadOnlyDatabase } from "./sqlite.ts";
import { discoverKxmProjectRoot } from "./project-config.ts";
import { kxmRuntimePaths, projectRuntimeKey } from "./runtime-paths.ts";
import { parseRouteSwitchRecord, type RouteSwitchRecord } from "./route-switch.ts";
import { parseRoutingRecordV2, ROUTING_RECORD_V2_SCHEMA, type RoutingRecord, type RoutingRecordV2 } from "./routing.ts";
import { readRoutingRecords, telemetryPath } from "./telemetry.ts";

/**
 * Routing-record sources for `kxm improve` and `kxm routing report`.
 *
 * Each Runtime event store is read read-only: one SELECT over the events
 * table, never the runs table, the run plans, or the prompts sidecar, and
 * never a write or a migration. When the user-state registry is present and
 * this checkout is registered, the home store and every lane store for that
 * project id are read. The registry itself is opened read-only at schema
 * version 2: no constructor, migration, write lock, directory, or sidecar.
 * Each settled attempt's outcome is resolved in memory from the event log;
 * nothing resolved here is stored.
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
  routeSwitches: RouteSwitchRecord[];
}

export interface LoadedRoutingSources {
  projectRoot?: string;
  records: Array<RoutingRecord | RoutingRecordV2>;
  sources: RoutingSourceSummary[];
  routeSwitches: RouteSwitchRecord[];
}

const ENGINE_EVENTS_SQL = "SELECT run_id, sequence, event_type, payload FROM events"
  + " WHERE event_type IN ('routing.attempt.recorded','routing.route_switched','step.entered','run.status_changed')"
  + " ORDER BY run_id, sequence";

/** Home row first, then lanes by registration time and project key. One query. */
const REGISTRY_SIBLING_SQL = "SELECT sibling.project_key AS project_key, sibling.lane_of AS lane_of"
  + " FROM projects AS current"
  + " JOIN projects AS sibling ON sibling.project_id = current.project_id"
  + " WHERE current.project_key = ?"
  + " ORDER BY CASE WHEN sibling.lane_of IS NULL THEN 0 ELSE 1 END, sibling.registered_at, sibling.project_key";

const PROJECT_KEY = /^[0-9a-f]{24}$/;

/** The simulated producer's harness label; its attempts measure nothing. */
const SIMULATED_HARNESS = "driver-simulated";

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
  if (!existsSync(path)) return { records: [], source, routeSwitches: [] };
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
  const routeSwitches: RouteSwitchRecord[] = [];
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
    } else if (eventType === "routing.route_switched") {
      const parsed = parsePayload(payload);
      const record = parseRouteSwitchRecord(parsed, {
        attemptId: typeof parsed?.attemptId === "string" ? parsed.attemptId : undefined,
        stepId: typeof parsed?.stepId === "string" ? parsed.stepId : undefined,
        runId,
      });
      if (record) routeSwitches.push(record);
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
    routeSwitches,
    source: { ...source, records: records.length, skippedInvalid, excludedSimulated, undecided },
  };
}

function registryUnreadable(registryDb: string, detail: string): Error {
  return new Error(`improve_source_unreadable: ${registryDb}: ${detail}`);
}

/**
 * Event stores for this checkout.
 *
 * An absent registry, or a registry that has no row for this checkout's
 * project key, keeps the single store derived from the checkout path. A
 * present registry must be a regular schema-v2 database. Paths then come
 * from the stored keys and the Runtime projects directory, so a stale
 * checkout path in the registry cannot choose the store.
 */
function discoverProjectEventStores(projectRoot: string, env: NodeJS.ProcessEnv): string[] {
  const paths = kxmRuntimePaths({ env });
  const ownStore = join(paths.projectsDir, projectRuntimeKey(projectRoot), "run-events.db");
  const registryDb = paths.registryDb;
  const info = lstatSync(registryDb, { throwIfNoEntry: false });
  if (!info) return [ownStore];
  if (!info.isFile()) throw registryUnreadable(registryDb, "runtime registry must be a regular database file");
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = lstatSync(`${registryDb}${suffix}`, { throwIfNoEntry: false });
    if (sidecar?.isSymbolicLink()) throw registryUnreadable(registryDb, "runtime registry sidecar must not be a link");
  }

  let database: DatabaseSync | undefined;
  try {
    database = openReadOnlyDatabase(registryDb);
    database.exec("PRAGMA busy_timeout = 5000");
    const versionRow = database.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    const version = versionRow?.user_version ?? 0;
    if (version !== 2) throw registryUnreadable(registryDb, `registry schema version ${version}; this reader requires 2`);
    const rows = database.prepare(REGISTRY_SIBLING_SQL).all(projectRuntimeKey(projectRoot));
    if (rows.length === 0) return [ownStore];
    return eventStoresFromRegistryRows(registryDb, paths.projectsDir, rows);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("improve_source_unreadable:")) throw error;
    throw new Error(`improve_source_unreadable: ${registryDb}: ${message}`, { cause: error });
  } finally {
    try {
      database?.close();
    } catch {
      // Closing a read-only handle has nothing to flush.
    }
  }
}

function eventStoresFromRegistryRows(registryDb: string, projectsDir: string, rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const parsed: Array<{ projectKey: string; laneOf: string | null }> = [];
  for (const row of rows) {
    const projectKey = typeof row.project_key === "string" ? row.project_key : "";
    const laneRaw = row.lane_of;
    const laneOf = laneRaw === null || laneRaw === undefined ? null : typeof laneRaw === "string" ? laneRaw : "";
    if (!PROJECT_KEY.test(projectKey) || seen.has(projectKey) || (laneOf !== null && !PROJECT_KEY.test(laneOf))) {
      throw registryUnreadable(registryDb, "registry identity is corrupt");
    }
    seen.add(projectKey);
    parsed.push({ projectKey, laneOf });
  }
  const homes = parsed.filter((row) => row.laneOf === null);
  const homeKey = homes[0]?.projectKey;
  if (homes.length !== 1 || homeKey === undefined || parsed.some((row) => row.laneOf !== null && row.laneOf !== homeKey)) {
    throw registryUnreadable(registryDb, "registry identity is corrupt");
  }
  return parsed.map((row) => join(projectsDir, row.projectKey, "run-events.db"));
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
 * With `file`, only that file is read. Otherwise every discovered Runtime
 * event store (when cwd is inside a KXM project) comes first, then
 * telemetry.jsonl. v2 records are de-duplicated by attemptId: the first
 * occurrence wins and the later source counts the drop.
 */
export function loadRoutingSources(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  logsDir: string;
  file?: string | undefined;
}): LoadedRoutingSources {
  const projectRoot = discoverKxmProjectRoot(options.cwd);
  const reads: Array<{ records: Array<RoutingRecord | RoutingRecordV2>; source: RoutingSourceSummary; routeSwitches?: RouteSwitchRecord[] }> = [];
  if (options.file !== undefined) {
    reads.push(readJsonlSource("file", resolve(options.cwd, options.file)));
  } else {
    if (projectRoot !== undefined) {
      for (const path of discoverProjectEventStores(projectRoot, options.env)) {
        reads.push(readEngineRoutingRecords(path));
      }
    }
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
    routeSwitches: reads.flatMap((read) => read.routeSwitches ?? []),
  };
}

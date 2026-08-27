import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "./protocol.ts";
import { agentWorker, gateWorker, type Worker } from "./envelope.ts";

export const SESSION_SCHEMA = "kxm.session.v1" as const;

/**
 * Roster/mix configuration is invalid: unknown worker names, malformed roster
 * files, duplicate names, or kind/driver mismatches. Thrown fail-closed;
 * callers (the CLI) are expected to map this to a usage exit, never to
 * silently degrade into a default worker.
 */
export class SessionConfigError extends Error {
  readonly code = "session_config_invalid" as const;
  constructor(message: string) {
    super(message);
    this.name = "SessionConfigError";
  }
}

export interface SessionRecord {
  schema: typeof SESSION_SCHEMA;
  id: string;
  host: "local" | "mesh";
  mode: "mix" | "workflow";
  workflowId?: string;
  workers: Worker[];
  createdAt: string;
  assetDir: string;
}

export function workflowAssetDirs(assetsDir: string, workflowId: string): string[] {
  const root = join(assetsDir, "workflows", workflowId);
  return [root, join(root, "inputs"), join(root, "outputs"), join(root, "generated")];
}

export function sessionAssetDirs(assetsDir: string, sessionId: string): string[] {
  const root = join(assetsDir, "sessions", sessionId);
  return [root, join(root, "inputs"), join(root, "outputs")];
}

export function standardAssetDirs(assetsDir: string): string[] {
  return [
    join(assetsDir, "retrospectives"),
    join(assetsDir, "workflows"),
    join(assetsDir, "sessions"),
    join(assetsDir, "improvements"),
    join(assetsDir, "generated"),
  ];
}

export function rosterNames(configDir: string): string[] {
  return [...loadRosterMap(configDir).values()].map((row) => String(row.name));
}

export function loadNamedWorkers(configDir: string, names: string[], project?: string): Worker[] {
  const byName = loadRosterMap(configDir);
  return names.map((name) => {
    const trimmed = name.trim();
    const row = byName.get(trimmed.toLowerCase());
    if (!row) {
      // Fail closed: an unknown mix name is a configuration error, not a
      // reason to mint a code gate with that name.
      throw new SessionConfigError(
        `unknown worker name in session roster: ${trimmed} (not present in agents.json or gates.json)`,
      );
    }
    return workerFromRosterRow(trimmed, row, project);
  });
}

function workerFromRosterRow(name: string, row: Record<string, unknown>, project?: string): Worker {
  const kind = row.kind;
  const driver = row.driver;
  if (kind !== undefined && kind !== "agent" && kind !== "gate") {
    throw new SessionConfigError(`roster entry ${name} has invalid kind: ${JSON.stringify(kind)}`);
  }
  if (driver !== undefined && driver !== "ai" && driver !== "code") {
    throw new SessionConfigError(`roster entry ${name} has invalid driver: ${JSON.stringify(driver)}`);
  }
  if ((kind === "agent" && driver === "code") || (kind === "gate" && driver === "ai")) {
    throw new SessionConfigError(
      `roster entry ${name} has kind/driver mismatch: kind=${String(kind)} driver=${String(driver)}`,
    );
  }
  if (kind === "gate" || driver === "code") {
    return gateWorker({
      name,
      ...(project ? { project } : {}),
      ...(typeof row.purpose === "string" ? { purpose: row.purpose } : {}),
    });
  }
  return agentWorker({
    name,
    ...(project ? { project } : {}),
    ...(typeof row.purpose === "string" ? { purpose: row.purpose } : {}),
    ...(typeof row.model === "string" ? { model: row.model } : {}),
    ...(typeof row.thinking === "string" ? { thinking: row.thinking } : {}),
  });
}

function loadRosterMap(configDir: string): Map<string, Record<string, unknown>> {
  const byName = new Map<string, Record<string, unknown>>();
  for (const [file, key] of [["agents.json", "agents"], ["gates.json", "gates"]] as const) {
    const path = join(configDir, file);
    for (const row of loadRoster(path, key)) {
      const name = String(row.name).trim();
      const lowered = name.toLowerCase();
      if (byName.has(lowered)) {
        throw new SessionConfigError(`duplicate worker name ${name} across roster files (${file} and an earlier roster)`);
      }
      // Validate every configured row, not only names selected by one mix. A
      // partial selection must not make a malformed sibling roster entry safe.
      void workerFromRosterRow(name, row);
      byName.set(lowered, row);
    }
  }
  return byName;
}

function loadRoster(path: string, key: "agents" | "gates"): Array<Record<string, unknown>> {
  // A missing roster file means "no workers of this kind configured"; a
  // present-but-malformed file is a configuration error and must fail closed.
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SessionConfigError(
      `${key} roster at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SessionConfigError(`${key} roster at ${path} must be a JSON object`);
  }
  const list = (parsed as Record<string, unknown>)[key];
  if (!Array.isArray(list)) {
    throw new SessionConfigError(`${key} roster at ${path} must contain a "${key}" array`);
  }
  return list.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new SessionConfigError(`${key} roster entry ${index} at ${path} must be an object`);
    }
    const record = row as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name.trim()) {
      throw new SessionConfigError(`${key} roster entry ${index} at ${path} must have a non-empty name`);
    }
    return record;
  });
}

export function createSession(input: {
  id: string;
  host: "local" | "mesh";
  mode: "mix" | "workflow";
  workflowId?: string;
  workers: Worker[];
  assetsDir: string;
}): SessionRecord {
  const assetDir = input.mode === "workflow" && input.workflowId
    ? join("assets", "workflows", input.workflowId)
    : join("assets", "sessions", input.id);
  return {
    schema: SESSION_SCHEMA,
    id: input.id,
    host: input.host,
    mode: input.mode,
    workers: input.workers,
    createdAt: nowIso(),
    assetDir,
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
  };
}

export function writeSession(assetsDir: string, session: SessionRecord, dryRun = false): string {
  const dir = join(assetsDir, "sessions", session.id);
  const path = join(dir, "session.json");
  if (!dryRun) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8" });
  }
  return path;
}

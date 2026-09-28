import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kxmResourceIdentifier } from "./project-config.ts";

/** First shape of the roadmap supervisor record. An unknown schema is refused
 * and left on disk. A later shape migrates in this module the way the Runtime
 * registry copies schema 1 to 2; this file is not a hub database table. */
export const SUPERVISOR_SCHEMA = "kxm.supervisor.v1";

const TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/;
const MERGE_STATE_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const CI_TOKEN_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export interface SupervisorPullRequest {
  number: number;
  mergeState: string;
  seenAt: string;
}

export interface SupervisorCi {
  status: string;
  conclusion: string;
  seenAt: string;
}

export interface SupervisorLane {
  inFlight: boolean;
  pr?: SupervisorPullRequest;
  ci?: SupervisorCi;
  backoffUntil?: string;
}

export interface SupervisorState {
  schema: typeof SUPERVISOR_SCHEMA;
  updatedAt: string;
  lanes: Record<string, SupervisorLane>;
}

export interface SupervisorObservation {
  unit: string;
  inFlight: boolean;
  pr?: { number: number; mergeState: string };
  ci?: { status: string; conclusion: string };
  /** Set when the caller passed a backoff. Zero clears a stored timer. */
  backoffMs?: number;
}

export type SupervisorLoadError = "supervisor_unreadable" | "supervisor_schema_unsupported";

export function supervisorStatePath(stateDir: string): string {
  return join(stateDir, "supervisor.json");
}

export function emptySupervisorState(now: string): SupervisorState {
  return { schema: SUPERVISOR_SCHEMA, updatedAt: now, lanes: {} };
}

export function isSupervisorTimestamp(value: string): boolean {
  return TIMESTAMP_RE.test(value) && Number.isFinite(Date.parse(value));
}

export function resolveSupervisorNow(override: string | undefined, fallback: Date): string | "supervisor_clock_invalid" {
  if (override === undefined || override.trim() === "") return fallback.toISOString();
  const text = override.trim();
  return isSupervisorTimestamp(text) ? text : "supervisor_clock_invalid";
}

function isPullRequest(value: unknown): value is SupervisorPullRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "number" && key !== "mergeState" && key !== "seenAt")) return false;
  return Number.isInteger(record.number) && (record.number as number) > 0
    && typeof record.mergeState === "string" && MERGE_STATE_RE.test(record.mergeState)
    && typeof record.seenAt === "string" && isSupervisorTimestamp(record.seenAt);
}

function isCi(value: unknown): value is SupervisorCi {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "status" && key !== "conclusion" && key !== "seenAt")) return false;
  return typeof record.status === "string" && CI_TOKEN_RE.test(record.status)
    && typeof record.conclusion === "string" && CI_TOKEN_RE.test(record.conclusion)
    && typeof record.seenAt === "string" && isSupervisorTimestamp(record.seenAt);
}

function isLane(value: unknown): value is SupervisorLane {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "inFlight" && key !== "pr" && key !== "ci" && key !== "backoffUntil")) return false;
  if (typeof record.inFlight !== "boolean") return false;
  if (record.pr !== undefined && !isPullRequest(record.pr)) return false;
  if (record.ci !== undefined && !isCi(record.ci)) return false;
  if (record.backoffUntil !== undefined && (typeof record.backoffUntil !== "string" || !isSupervisorTimestamp(record.backoffUntil))) return false;
  return true;
}

function isState(value: unknown): value is SupervisorState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "schema" && key !== "updatedAt" && key !== "lanes")) return false;
  if (record.schema !== SUPERVISOR_SCHEMA) return false;
  if (typeof record.updatedAt !== "string" || !isSupervisorTimestamp(record.updatedAt)) return false;
  if (!record.lanes || typeof record.lanes !== "object" || Array.isArray(record.lanes)) return false;
  for (const [unit, lane] of Object.entries(record.lanes as Record<string, unknown>)) {
    if (!kxmResourceIdentifier(unit) || !isLane(lane)) return false;
  }
  return true;
}

/** Read `supervisor.json`. A missing file is empty state. A malformed file or
 * an unknown schema is refused and is not replaced. */
export function loadSupervisorState(stateDir: string, now: string): SupervisorState | SupervisorLoadError {
  const path = supervisorStatePath(stateDir);
  if (!existsSync(path)) return emptySupervisorState(now);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "supervisor_unreadable";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "supervisor_unreadable";
  const schema = (parsed as { schema?: unknown }).schema;
  if (schema !== SUPERVISOR_SCHEMA) return "supervisor_schema_unsupported";
  if (!isState(parsed)) return "supervisor_unreadable";
  return parsed;
}

export function saveSupervisorState(stateDir: string, state: SupervisorState): void {
  const lanes: Record<string, SupervisorLane> = {};
  for (const unit of Object.keys(state.lanes).sort()) {
    const lane = state.lanes[unit];
    if (!lane) continue;
    const next: SupervisorLane = { inFlight: lane.inFlight };
    if (lane.pr) next.pr = { number: lane.pr.number, mergeState: lane.pr.mergeState, seenAt: lane.pr.seenAt };
    if (lane.ci) next.ci = { status: lane.ci.status, conclusion: lane.ci.conclusion, seenAt: lane.ci.seenAt };
    if (lane.backoffUntil) next.backoffUntil = lane.backoffUntil;
    lanes[unit] = next;
  }
  const body = `${JSON.stringify({ schema: SUPERVISOR_SCHEMA, updatedAt: state.updatedAt, lanes }, null, 2)}\n`;
  mkdirSync(stateDir, { recursive: true });
  const path = supervisorStatePath(stateDir);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  try { chmodSync(path, 0o600); } catch { /* Windows may not expose POSIX modes. */ }
}

export function applyObservation(
  state: SupervisorState,
  observation: SupervisorObservation,
  now: string,
): SupervisorState | "lane_unit_invalid" | "supervisor_pr_invalid" | "supervisor_ci_invalid" | "supervisor_backoff_invalid" {
  if (!kxmResourceIdentifier(observation.unit)) return "lane_unit_invalid";
  if (!isSupervisorTimestamp(now)) return "supervisor_backoff_invalid";
  if (observation.pr) {
    if (!Number.isInteger(observation.pr.number) || observation.pr.number <= 0 || !MERGE_STATE_RE.test(observation.pr.mergeState)) {
      return "supervisor_pr_invalid";
    }
  }
  if (observation.ci) {
    if (!CI_TOKEN_RE.test(observation.ci.status) || !CI_TOKEN_RE.test(observation.ci.conclusion)) return "supervisor_ci_invalid";
  }
  if (observation.backoffMs !== undefined) {
    if (!Number.isInteger(observation.backoffMs) || observation.backoffMs < 0 || observation.backoffMs > MAX_BACKOFF_MS) {
      return "supervisor_backoff_invalid";
    }
  }
  const prior = state.lanes[observation.unit];
  const next: SupervisorLane = { inFlight: observation.inFlight };
  if (observation.pr) next.pr = { number: observation.pr.number, mergeState: observation.pr.mergeState, seenAt: now };
  else if (prior?.pr) next.pr = { ...prior.pr };
  if (observation.ci) next.ci = { status: observation.ci.status, conclusion: observation.ci.conclusion, seenAt: now };
  else if (prior?.ci) next.ci = { ...prior.ci };
  if (observation.backoffMs === undefined) {
    if (prior?.backoffUntil) next.backoffUntil = prior.backoffUntil;
  } else if (observation.backoffMs > 0) {
    next.backoffUntil = new Date(Date.parse(now) + observation.backoffMs).toISOString();
  }
  return {
    schema: SUPERVISOR_SCHEMA,
    updatedAt: now,
    lanes: { ...state.lanes, [observation.unit]: next },
  };
}

export interface SupervisorTick {
  state: SupervisorState;
  resumed: string[];
  waiting: string[];
}

/** Keep every lane. A backoff that has elapsed is cleared so the lane can be
 * acted on again. A backoff still in the future is left untouched. */
export function resumeTick(state: SupervisorState, now: string): SupervisorTick {
  const nowMs = Date.parse(now);
  const lanes: Record<string, SupervisorLane> = {};
  const resumed: string[] = [];
  const waiting: string[] = [];
  for (const unit of Object.keys(state.lanes).sort()) {
    const lane = state.lanes[unit];
    if (!lane) continue;
    const until = lane.backoffUntil === undefined ? undefined : Date.parse(lane.backoffUntil);
    const next: SupervisorLane = { inFlight: lane.inFlight };
    if (lane.pr) next.pr = { ...lane.pr };
    if (lane.ci) next.ci = { ...lane.ci };
    if (until !== undefined && until > nowMs && lane.backoffUntil !== undefined) {
      next.backoffUntil = lane.backoffUntil;
      waiting.push(unit);
    } else if (until !== undefined) {
      resumed.push(unit);
    }
    lanes[unit] = next;
  }
  return {
    state: { schema: SUPERVISOR_SCHEMA, updatedAt: now, lanes },
    resumed,
    waiting,
  };
}

export function formatTickLine(now: string, resumed: readonly string[], waiting: readonly string[]): string {
  const clock = now.slice(11, 16);
  if (resumed.length === 0 && waiting.length === 0) {
    return `[supervisor]: no change. No action. - (${clock})`;
  }
  const parts: string[] = [];
  if (resumed.length > 0) parts.push(`resumed ${resumed.join(", ")}`);
  if (waiting.length > 0) parts.push(`waiting ${waiting.join(", ")}`);
  const acted = resumed.length > 0 ? `Acted: resume ${resumed.join(", ")}` : "No action";
  return `[supervisor]: ${parts.join("; ")}. ${acted}. - (${clock})`;
}

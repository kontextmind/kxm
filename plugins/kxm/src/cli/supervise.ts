import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { discoverKxmProjectRoot } from "../project-config.ts";
import {
  applyObservation,
  formatTickLine,
  loadSupervisorState,
  resolveSupervisorNow,
  resumeTick,
  saveSupervisorState,
  type SupervisorState,
} from "../supervise-state.ts";
import { print, printPlan, type Runtime } from "./types.ts";

export interface SuperviseRecordOptions {
  lane: string;
  pr?: string;
  mergeState?: string;
  ciStatus?: string;
  ciConclusion?: string;
  backoffMs?: string;
  settled?: boolean;
}

function refuse(runtime: Runtime, error: string, text: string): number {
  print(runtime.io, runtime.json, { ok: false, command: "supervise", error }, text);
  return 1;
}

function requireProject(runtime: Runtime): number | undefined {
  if (!discoverKxmProjectRoot(runtime.cwd)) {
    return refuse(runtime, "project_required", "supervise requires a KXM project (run kxm init first)");
  }
  return undefined;
}

function nowOf(runtime: Runtime): string | number {
  const now = resolveSupervisorNow(runtime.env.KXM_SUPERVISE_NOW, new Date());
  if (now === "supervisor_clock_invalid") {
    return refuse(runtime, "supervisor_clock_invalid", "KXM_SUPERVISE_NOW must be an ISO-8601 UTC timestamp");
  }
  return now;
}

function loaded(runtime: Runtime, now: string): SupervisorState | number {
  const state = loadSupervisorState(runtime.dirs.state, now);
  if (state === "supervisor_unreadable") {
    return refuse(runtime, "supervisor_unreadable", "supervisor state is unreadable and was left unchanged");
  }
  if (state === "supervisor_schema_unsupported") {
    return refuse(runtime, "supervisor_schema_unsupported", "supervisor state schema is not kxm.supervisor.v1 and was left unchanged");
  }
  return state;
}

function laneText(state: SupervisorState): string {
  const units = Object.keys(state.lanes).sort();
  if (units.length === 0) return "supervisor: no lanes";
  const lines = [`supervisor: ${units.length} lane${units.length === 1 ? "" : "s"}`];
  for (const unit of units) {
    const lane = state.lanes[unit];
    if (!lane) continue;
    const flight = lane.inFlight ? "in-flight" : "settled";
    const pr = lane.pr ? ` pr ${lane.pr.number} ${lane.pr.mergeState}` : "";
    const ci = lane.ci ? ` ci ${lane.ci.status}/${lane.ci.conclusion}` : "";
    const backoff = lane.backoffUntil ? ` backoff ${lane.backoffUntil}` : "";
    lines.push(`${unit} ${flight}${pr}${ci}${backoff}`);
  }
  return lines.join("\n");
}

function show(runtime: Runtime, state: SupervisorState, extra: Record<string, unknown> = {}): number {
  print(runtime.io, runtime.json, { ok: true, command: "supervise", ...extra, state }, laneText(state));
  return 0;
}

export function cmdSuperviseStatus(runtime: Runtime): number {
  const missing = requireProject(runtime);
  if (missing !== undefined) return missing;
  const now = nowOf(runtime);
  if (typeof now === "number") return now;
  const state = loaded(runtime, now);
  if (typeof state === "number") return state;
  return show(runtime, state);
}

function appendTick(runtime: Runtime, line: string): void {
  mkdirSync(runtime.dirs.logs, { recursive: true });
  const path = join(runtime.dirs.logs, "supervisor.log");
  appendFileSync(path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows may not expose POSIX modes. */ }
}

export function cmdSuperviseTick(runtime: Runtime): number {
  const missing = requireProject(runtime);
  if (missing !== undefined) return missing;
  const now = nowOf(runtime);
  if (typeof now === "number") return now;
  const state = loaded(runtime, now);
  if (typeof state === "number") return state;
  const tick = resumeTick(state, now);
  const line = formatTickLine(now, tick.resumed, tick.waiting);
  if (runtime.dryRun) {
    printPlan(runtime, { command: "supervise", resumed: tick.resumed, waiting: tick.waiting, log: line, state: tick.state }, [
      { action: "write", target: join(runtime.dirs.state, "supervisor.json") },
      { action: "write", target: join(runtime.dirs.logs, "supervisor.log") },
    ], "resume lanes whose backoff has elapsed");
    return 0;
  }
  saveSupervisorState(runtime.dirs.state, tick.state);
  appendTick(runtime, line);
  return show(runtime, tick.state, { resumed: tick.resumed, waiting: tick.waiting, log: line });
}

function parseBackoff(value: string | undefined): number | undefined | "supervisor_backoff_invalid" {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) return "supervisor_backoff_invalid";
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return "supervisor_backoff_invalid";
  return parsed;
}

export function cmdSuperviseRecord(runtime: Runtime, options: SuperviseRecordOptions): number {
  const missing = requireProject(runtime);
  if (missing !== undefined) return missing;
  const now = nowOf(runtime);
  if (typeof now === "number") return now;
  const state = loaded(runtime, now);
  if (typeof state === "number") return state;
  const hasPr = options.pr !== undefined || options.mergeState !== undefined;
  if (hasPr && (options.pr === undefined || options.mergeState === undefined || !/^[0-9]+$/.test(options.pr))) {
    return refuse(runtime, "supervisor_pr_invalid", "record a pull request with both --pr and --merge-state");
  }
  const hasCi = options.ciStatus !== undefined || options.ciConclusion !== undefined;
  if (hasCi && (options.ciStatus === undefined || options.ciConclusion === undefined)) {
    return refuse(runtime, "supervisor_ci_invalid", "record CI with both --ci-status and --ci-conclusion");
  }
  const backoffMs = parseBackoff(options.backoffMs);
  if (backoffMs === "supervisor_backoff_invalid") {
    return refuse(runtime, "supervisor_backoff_invalid", "--backoff-ms must be a whole number of milliseconds from 0 through 86400000");
  }
  const next = applyObservation(state, {
    unit: options.lane,
    inFlight: options.settled !== true,
    ...(hasPr ? { pr: { number: Number(options.pr), mergeState: String(options.mergeState).trim().toUpperCase() } } : {}),
    ...(hasCi ? { ci: { status: String(options.ciStatus).trim().toLowerCase(), conclusion: String(options.ciConclusion).trim().toLowerCase() } } : {}),
    ...(backoffMs !== undefined ? { backoffMs } : {}),
  }, now);
  if (typeof next === "string") {
    const text = next === "lane_unit_invalid"
      ? `lane unit ${options.lane} must match the KXM identifier pattern`
      : next === "supervisor_pr_invalid"
        ? "pull request number and merge state are not valid"
        : next === "supervisor_ci_invalid"
          ? "CI status and conclusion are not valid"
          : "--backoff-ms must be a whole number of milliseconds from 0 through 86400000";
    return refuse(runtime, next, text);
  }
  if (runtime.dryRun) {
    printPlan(runtime, { command: "supervise", state: next }, [
      { action: "write", target: join(runtime.dirs.state, "supervisor.json") },
    ], `record lane ${options.lane}`);
    return 0;
  }
  saveSupervisorState(runtime.dirs.state, next);
  return show(runtime, next);
}

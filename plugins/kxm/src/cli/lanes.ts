import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { discoverKxmProjectRoot, kxmResourceIdentifier } from "../project-config.ts";
import { attachKxmSupervisor, ensureKxmSupervisor, kxmRuntimeRequest } from "../runtime-supervisor.ts";
import { print, printPlan, workspaceDirs, type Runtime } from "./types.ts";

/** One worktree lane recorded in the control checkout. The sha is the base,
 * not the ref: worktrees share refs, and a later fetch moves origin/main. */
export interface LaneRecord {
  path: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  createdAt: string;
  lastRunId?: string;
}

interface LaneFile {
  schema: "kxm.lanes.v1";
  lanes: Record<string, LaneRecord>;
}

export interface LaneView extends LaneRecord {
  unit: string;
  dirty: number | null;
  ahead: number | null;
  behind: number | null;
  exists: boolean;
}

const LANE_SCHEMA = "kxm.lanes.v1";
const SHA_RE = /^[a-f0-9]{40,64}$/;
const TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/;
const SETTLED_RUN = new Set(["completed", "failed", "cancelled"]);

function lanesFile(runtime: Runtime): string {
  return join(runtime.dirs.state, "lanes.json");
}

function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
}

function git(cwd: string, args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: gitEnv(),
    timeout: 30_000,
    windowsHide: true,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${result.error ? result.error.message : ""}`,
  };
}

function refuse(runtime: Runtime, command: string, error: string, text: string, extra: Record<string, unknown> = {}): number {
  print(runtime.io, runtime.json, { ok: false, command, error, ...extra }, text);
  return 1;
}

function isLaneRecord(value: unknown): value is LaneRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowed = new Set(["path", "branch", "baseRef", "baseSha", "createdAt", "lastRunId"]);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (typeof record.path !== "string" || record.path.length === 0) return false;
  if (typeof record.branch !== "string" || record.branch.length === 0) return false;
  if (typeof record.baseRef !== "string" || record.baseRef.length === 0) return false;
  if (typeof record.baseSha !== "string" || !SHA_RE.test(record.baseSha)) return false;
  if (typeof record.createdAt !== "string" || !TIMESTAMP_RE.test(record.createdAt)) return false;
  if (record.lastRunId !== undefined && (typeof record.lastRunId !== "string" || record.lastRunId.length === 0)) return false;
  return true;
}

function isLaneFile(value: unknown): value is LaneFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  if (Object.keys(file).some((key) => key !== "schema" && key !== "lanes")) return false;
  if (file.schema !== LANE_SCHEMA || !file.lanes || typeof file.lanes !== "object" || Array.isArray(file.lanes)) return false;
  for (const [unit, record] of Object.entries(file.lanes as Record<string, unknown>)) {
    if (!kxmResourceIdentifier(unit) || !isLaneRecord(record)) return false;
  }
  return true;
}

/** Read `<state>/lanes.json`. A missing file is an empty record. A malformed
 * file is refused; it is never replaced with an empty record. */
function loadLanes(runtime: Runtime, command: string): LaneFile | number {
  const file = lanesFile(runtime);
  if (!existsSync(file)) return { schema: LANE_SCHEMA, lanes: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isLaneFile(parsed)) return refuse(runtime, command, "lanes_unreadable", `lane record ${file} is malformed`);
    return parsed;
  } catch {
    return refuse(runtime, command, "lanes_unreadable", `lane record ${file} is unreadable`);
  }
}

function writeLanes(runtime: Runtime, file: LaneFile): void {
  const target = lanesFile(runtime);
  mkdirSync(runtime.dirs.state, { recursive: true });
  const lanes: Record<string, LaneRecord> = {};
  for (const unit of Object.keys(file.lanes).sort()) {
    const record = file.lanes[unit];
    if (!record) continue;
    lanes[unit] = {
      path: record.path,
      branch: record.branch,
      baseRef: record.baseRef,
      baseSha: record.baseSha,
      createdAt: record.createdAt,
      ...(record.lastRunId ? { lastRunId: record.lastRunId } : {}),
    };
  }
  writeFileSync(target, `${JSON.stringify({ schema: LANE_SCHEMA, lanes }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(target, 0o600); } catch { /* Windows may not expose POSIX modes. */ }
}

function controlRoot(runtime: Runtime, command: string): string | number {
  const root = discoverKxmProjectRoot(runtime.cwd);
  if (!root) return refuse(runtime, command, "project_required", `${command} requires a KXM project (run kxm init first)`);
  return root;
}

function refuseUnit(runtime: Runtime, command: string, unit: string): number | undefined {
  if (kxmResourceIdentifier(unit)) return undefined;
  return refuse(runtime, command, "lane_unit_invalid", `lane unit ${unit} must match the KXM identifier pattern`);
}

function laneWorktreePath(projectRoot: string, unit: string): string {
  return resolve(dirname(projectRoot), `${basename(projectRoot)}-${unit}`);
}

function branchExists(projectRoot: string, unit: string): boolean {
  return git(projectRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${unit}`]).status === 0;
}

function resolveBase(projectRoot: string, base: string): string | undefined {
  const result = git(projectRoot, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
  if (result.status !== 0) return undefined;
  const sha = result.stdout.trim();
  return SHA_RE.test(sha) ? sha : undefined;
}

/** The only `--lane` mechanism: discovery cwd and workspace dirs come from the lane path. */
export function withLaneCwd(runtime: Runtime, unit: string, command = "lane"): Runtime | number {
  const invalid = refuseUnit(runtime, command, unit);
  if (invalid !== undefined) return invalid;
  const loaded = loadLanes(runtime, command);
  if (typeof loaded === "number") return loaded;
  const lane = loaded.lanes[unit];
  if (!lane || !existsSync(lane.path)) {
    return refuse(runtime, command, "lane_missing", `lane ${unit} is not recorded or its worktree is absent`, { unit });
  }
  return {
    ...runtime,
    cwd: lane.path,
    dirs: workspaceDirs(lane.path, undefined, runtime.env),
  };
}

export function applyLane(runtime: Runtime, unit: string | undefined, command: string): Runtime | number {
  if (unit === undefined) return runtime;
  return withLaneCwd(runtime, unit, command);
}

/** `--lane` for `kxm runs`: same cwd swap as `withLaneCwd`, or the original runtime when unset. */
export function runtimeForLane(runtime: Runtime, unit: string | undefined): Runtime | number {
  return applyLane(runtime, unit, "lane");
}

interface StartedRun {
  code: number;
  runId?: string;
}

/** Shared path for `kxm run --brief --lane` and `kxm lane run`. */
async function startRecordedRun(
  runtime: Runtime,
  workflow: string | undefined,
  promptParts: string[],
  options: { brief?: string; lane?: string; command: string; allowDefaultWorkflow?: boolean; skipOpenCheck?: boolean },
): Promise<StartedRun> {
  let prompt: string | undefined;
  if (options.brief !== undefined) {
    if (promptParts.length > 0) {
      return { code: refuse(runtime, options.command, "brief_and_prompt", "pass either --brief or a prompt, not both", { brief: options.brief }) };
    }
    const brief = readRunBrief(runtime, options.brief, options.command);
    if (typeof brief === "number") return { code: brief };
    prompt = brief.text;
  }
  let active = runtime;
  if (options.lane !== undefined) {
    const scoped = withLaneCwd(runtime, options.lane, options.command);
    if (typeof scoped === "number") return { code: scoped };
    active = scoped;
    if (options.skipOpenCheck !== true) {
      const open = await refuseIfLaneRunOpen(runtime, options.lane, options.command);
      if (open !== undefined) return { code: open };
    }
  }
  const project = await import("./project.ts");
  const runIdOut: { runId?: string } = {};
  const code = await project.cmdKxmRun(active, workflow, prompt === undefined ? promptParts : [], false, {
    ...(options.brief !== undefined ? { brief: options.brief } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(options.allowDefaultWorkflow ? { allowDefaultWorkflow: true } : {}),
    runIdOut,
  });
  if (code !== 0 || !runIdOut.runId) return { code, ...(runIdOut.runId ? { runId: runIdOut.runId } : {}) };
  if (options.lane !== undefined) {
    const recorded = recordLaneRun(runtime, options.lane, runIdOut.runId, options.command);
    if (recorded !== undefined) return { code: recorded };
  }
  return { code: 0, runId: runIdOut.runId };
}

export async function cmdKxmRunCli(
  runtime: Runtime,
  workflow: string | undefined,
  promptParts: string[],
  options: { brief?: string; lane?: string } = {},
): Promise<number> {
  const started = await startRecordedRun(runtime, workflow, promptParts, { ...options, command: "run" });
  return started.code;
}

export function readRunBrief(runtime: Runtime, file: string, command: string): { text: string } | number {
  try {
    return { text: readFileSync(resolve(runtime.cwd, file), "utf8").trim() };
  } catch {
    return refuse(runtime, command, "brief_unreadable", `cannot read brief ${file}`, { brief: file });
  }
}

function porcelainCount(path: string): number | null {
  const result = git(path, ["status", "--porcelain"]);
  if (result.status !== 0) return null;
  return result.stdout.split("\n").filter((line) => line.length > 0).length;
}

/** Left count is commits on the base that HEAD lacks (behind). Right is the reverse (ahead). */
function aheadBehind(path: string, baseSha: string): { ahead: number | null; behind: number | null } {
  const result = git(path, ["rev-list", "--left-right", "--count", `${baseSha}...HEAD`]);
  const match = result.status === 0 ? result.stdout.trim().match(/^(\d+)\s+(\d+)$/) : null;
  if (!match) return { ahead: null, behind: null };
  return { behind: Number(match[1]), ahead: Number(match[2]) };
}

function laneView(unit: string, record: LaneRecord): LaneView {
  const exists = existsSync(record.path);
  const counts = exists ? aheadBehind(record.path, record.baseSha) : { ahead: null, behind: null };
  return {
    unit,
    path: record.path,
    branch: record.branch,
    baseRef: record.baseRef,
    baseSha: record.baseSha,
    createdAt: record.createdAt,
    ...(record.lastRunId ? { lastRunId: record.lastRunId } : {}),
    dirty: exists ? porcelainCount(record.path) : null,
    ahead: counts.ahead,
    behind: counts.behind,
    exists,
  };
}

function formatCount(value: number | null): string {
  return value === null ? "?" : String(value);
}

function formatLaneLine(view: LaneView): string {
  return [
    view.unit,
    view.path,
    `branch=${view.branch}`,
    `base=${view.baseSha}`,
    `dirty=${formatCount(view.dirty)}`,
    `ahead=${formatCount(view.ahead)}`,
    `behind=${formatCount(view.behind)}`,
    `exists=${view.exists}`,
  ].join(" ");
}

/** A running supervisor can answer. This never starts one. A test seam stands in for that process. */
async function projectedRunStatus(runtime: Runtime, projectRoot: string, runId: string, allowStart: boolean): Promise<string> {
  try {
    const project = await import("./project.ts");
    const request = project.kxmDriveCliSeams.runtimeRequest ?? kxmRuntimeRequest;
    // `lane status` never starts the supervisor. Run and drop may, except under --dry-run.
    const handle = !allowStart || runtime.dryRun
      ? await attachKxmSupervisor({ env: runtime.env })
      : await (project.kxmDriveCliSeams.ensureSupervisor ?? ensureKxmSupervisor)({ env: runtime.env });
    if (!handle) return "unknown";
    const result = await request(
      handle,
      "GET",
      `/v1/runs/${encodeURIComponent(runId)}?projectRoot=${encodeURIComponent(projectRoot)}`,
    );
    const run = result.run;
    if (!run || typeof run !== "object" || Array.isArray(run)) return "unknown";
    const status = (run as { status?: unknown }).status;
    return typeof status === "string" && status.length > 0 ? status : "unknown";
  } catch {
    return "unknown";
  }
}

function isSettled(status: string): boolean {
  return SETTLED_RUN.has(status);
}

export async function refuseIfLaneRunOpen(runtime: Runtime, unit: string, command: string): Promise<number | undefined> {
  const loaded = loadLanes(runtime, command);
  if (typeof loaded === "number") return loaded;
  const lane = loaded.lanes[unit];
  if (!lane?.lastRunId) return undefined;
  const runStatus = await projectedRunStatus(runtime, lane.path, lane.lastRunId, true);
  if (isSettled(runStatus)) return undefined;
  return refuse(
    runtime,
    command,
    "lane_run_open",
    `lane ${unit} run ${lane.lastRunId} is ${runStatus}`,
    { unit, runId: lane.lastRunId, runStatus },
  );
}

export function recordLaneRun(runtime: Runtime, unit: string, runId: string, command: string): number | undefined {
  const loaded = loadLanes(runtime, command);
  if (typeof loaded === "number") return loaded;
  const lane = loaded.lanes[unit];
  if (!lane) return refuse(runtime, command, "lane_missing", `lane ${unit} is not recorded or its worktree is absent`, { unit });
  lane.lastRunId = runId;
  try {
    writeLanes(runtime, loaded);
  } catch {
    return refuse(runtime, command, "lanes_unreadable", `lane record ${lanesFile(runtime)} could not be written`);
  }
  return undefined;
}

export async function cmdLaneCreate(runtime: Runtime, unit: string, options: { base?: string } = {}): Promise<number> {
  const command = "lane create";
  const invalid = refuseUnit(runtime, command, unit);
  if (invalid !== undefined) return invalid;
  const root = controlRoot(runtime, command);
  if (typeof root === "number") return root;
  const base = options.base?.trim() || "origin/main";
  const loaded = loadLanes(runtime, command);
  if (typeof loaded === "number") return loaded;
  const path = laneWorktreePath(root, unit);
  if (loaded.lanes[unit] || existsSync(path) || branchExists(root, unit)) {
    return refuse(runtime, command, "lane_exists", `lane ${unit} already exists`, { unit });
  }
  const baseSha = resolveBase(root, base);
  if (!baseSha) {
    return refuse(
      runtime,
      command,
      "lane_base_unresolved",
      `base ${base} does not resolve; git fetch origin`,
      { unit, base, hint: "git fetch origin" },
    );
  }
  if (runtime.dryRun) {
    printPlan(runtime, { command, unit, base, baseSha, path }, [
      { action: "write", target: path },
      { action: "write", target: lanesFile(runtime) },
    ], `create lane ${unit} at ${path} from ${baseSha}`);
    return 0;
  }
  const added = git(root, ["worktree", "add", "-b", unit, path, baseSha]);
  if (added.status !== 0) {
    return refuse(runtime, command, "lane_git_failed", `git worktree add failed: ${added.stderr.trim().slice(0, 300)}`, { unit });
  }
  // Same string `discoverKxmProjectRoot` will return when `--lane` swaps cwd.
  const recordedPath = discoverKxmProjectRoot(path) ?? path;
  if (!existsSync(join(recordedPath, ".kxm", "project.yaml"))) {
    git(root, ["worktree", "remove", "--force", path]);
    return refuse(runtime, command, "lane_not_project", `lane ${recordedPath} has no .kxm/project.yaml; the worktree was removed`, { unit, path: recordedPath });
  }
  const lane: LaneRecord = {
    path: recordedPath,
    branch: unit,
    baseRef: base,
    baseSha,
    createdAt: new Date().toISOString(),
  };
  loaded.lanes[unit] = lane;
  try {
    writeLanes(runtime, loaded);
  } catch {
    git(root, ["worktree", "remove", "--force", path]);
    return refuse(runtime, command, "lanes_unreadable", `lane record ${lanesFile(runtime)} could not be written`, { unit });
  }
  print(runtime.io, runtime.json, { ok: true, command, unit, lane }, formatLaneLine(laneView(unit, lane)));
  return 0;
}

export async function cmdLaneList(runtime: Runtime): Promise<number> {
  const command = "lane list";
  const loaded = loadLanes(runtime, command);
  if (typeof loaded === "number") return loaded;
  const lanes = Object.keys(loaded.lanes).sort().map((unit) => laneView(unit, loaded.lanes[unit]!));
  print(
    runtime.io,
    runtime.json,
    { ok: true, command, lanes },
    lanes.length === 0 ? "no lanes" : lanes.map((lane) => formatLaneLine(lane)).join("\n"),
  );
  return 0;
}

export async function cmdLaneStatus(runtime: Runtime, unit: string): Promise<number> {
  const command = "lane status";
  const invalid = refuseUnit(runtime, command, unit);
  if (invalid !== undefined) return invalid;
  const loaded = loadLanes(runtime, command);
  if (typeof loaded === "number") return loaded;
  const record = loaded.lanes[unit];
  if (!record) return refuse(runtime, command, "lane_missing", `lane ${unit} is not recorded`, { unit });
  const view = laneView(unit, record);
  const runStatus = record.lastRunId ? await projectedRunStatus(runtime, record.path, record.lastRunId, false) : "unknown";
  print(
    runtime.io,
    runtime.json,
    { ok: true, command, lane: { ...view, status: runStatus } },
    `${formatLaneLine(view)} status=${runStatus}`,
  );
  return 0;
}

export async function cmdLaneDrop(runtime: Runtime, unit: string, options: { force?: boolean } = {}): Promise<number> {
  const command = "lane drop";
  const invalid = refuseUnit(runtime, command, unit);
  if (invalid !== undefined) return invalid;
  const root = controlRoot(runtime, command);
  if (typeof root === "number") return root;
  const loaded = loadLanes(runtime, command);
  if (typeof loaded === "number") return loaded;
  const record = loaded.lanes[unit];
  if (!record) return refuse(runtime, command, "lane_missing", `lane ${unit} is not recorded`, { unit });
  const force = options.force === true;
  if (!force) {
    if (existsSync(record.path)) {
      const dirty = porcelainCount(record.path);
      if (dirty === null) {
        return refuse(runtime, command, "lane_git_failed", `lane ${unit} worktree status could not be read`, { unit });
      }
      if (dirty !== 0) {
        return refuse(runtime, command, "lane_dirty", `lane ${unit} has ${dirty} uncommitted change(s)`, { unit, dirty });
      }
    }
    const open = await refuseIfLaneRunOpen(runtime, unit, command);
    if (open !== undefined) return open;
  }
  if (runtime.dryRun) {
    printPlan(runtime, { command, unit, branchKept: record.branch }, [
      { action: "delete", target: record.path },
      { action: "write", target: lanesFile(runtime) },
    ], `drop lane ${unit}; branch ${record.branch} is not deleted`);
    return 0;
  }
  if (existsSync(record.path)) {
    const removed = git(root, ["worktree", "remove", ...(force ? ["--force"] : []), record.path]);
    if (removed.status !== 0) {
      return refuse(runtime, command, "lane_git_failed", `git worktree remove failed: ${removed.stderr.trim().slice(0, 300)}`, { unit });
    }
  }
  delete loaded.lanes[unit];
  try {
    writeLanes(runtime, loaded);
  } catch {
    return refuse(runtime, command, "lanes_unreadable", `lane record ${lanesFile(runtime)} could not be written`, { unit });
  }
  print(
    runtime.io,
    runtime.json,
    { ok: true, command, unit, branch: record.branch, branchDeleted: false },
    `dropped lane ${unit}; branch ${record.branch} was not deleted`,
  );
  return 0;
}

export async function cmdLaneRun(
  runtime: Runtime,
  unit: string,
  options: { brief?: string; workflow?: string; base?: string; wait?: boolean; timeoutMs?: string },
): Promise<number> {
  const command = "lane run";
  const invalid = refuseUnit(runtime, command, unit);
  if (invalid !== undefined) return invalid;
  if (!options.brief) return refuse(runtime, command, "brief_unreadable", "lane run requires --brief <file>");
  const brief = readRunBrief(runtime, options.brief, command);
  if (typeof brief === "number") return brief;
  const loaded = loadLanes(runtime, command);
  if (typeof loaded === "number") return loaded;
  const existed = Boolean(loaded.lanes[unit]);
  if (!existed) {
    const created = await cmdLaneCreate(runtime, unit, options.base !== undefined ? { base: options.base } : {});
    if (created !== 0) return created;
  }
  if (runtime.dryRun) {
    if (existed) {
      const open = await refuseIfLaneRunOpen(runtime, unit, command);
      if (open !== undefined) return open;
    }
    const root = controlRoot(runtime, command);
    const path = existed ? loaded.lanes[unit]!.path : (typeof root === "number" ? unit : laneWorktreePath(root, unit));
    printPlan(runtime, { command, unit, brief: options.brief }, [
      { action: "request", target: `POST /v1/runs projectRoot=${path}` },
      { action: "request", target: `POST /v1/runs/<new>/drive projectRoot=${path}` },
    ], `run lane ${unit} from ${options.brief} and drive it`);
    return 0;
  }
  const open = await refuseIfLaneRunOpen(runtime, unit, command);
  if (open !== undefined) return open;
  const outcome = await startRecordedRun(runtime, options.workflow, [], {
    brief: options.brief,
    lane: unit,
    command,
    allowDefaultWorkflow: true,
    skipOpenCheck: true,
  });
  if (outcome.code !== 0 || !outcome.runId) return outcome.code === 0 ? 1 : outcome.code;
  const scoped = withLaneCwd(runtime, unit, command);
  if (typeof scoped === "number") return scoped;
  const project = await import("./project.ts");
  return project.cmdKxmRunDrive(scoped, outcome.runId, false, {
    wait: options.wait === true,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

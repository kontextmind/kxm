import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadLocalMeshSnapshot,
  resolveKxmSnapshotPaths,
  type LocalMeshSnapshot,
  type MeshTuiPlan,
  type MeshTuiRun,
} from "./local-snapshot.ts";
import { readUpdateCache } from "./kxm-update.ts";
import { probeHubHealth, readHubBinding } from "./hub-binding.ts";
import { readRoutingRecords } from "./telemetry.ts";

export const SESSION_BRIEF_SKIP_LABEL = "Skip — start a fresh session";
export const MAX_SESSION_BRIEF_TASKS = 5;
export const MAX_SESSION_BRIEF_PLANS = 5;
export const SESSION_BRIEF_SCHEMA = "kxm.session-brief.v1" as const;
export const DEFAULT_SESSION_BRIEF_STALE_SECONDS = 5;

export interface SessionWorkItem {
  kind: "task" | "plan";
  id: string;
  runId: string;
  label: string;
  detail: string;
  prompt: string;
}

export interface SessionWorkStats {
  activeTasks: number;
  waitingTasks: number;
  planCount: number;
  inbox: number;
  runTotal: number;
  latestPlan?: string;
}

export interface SessionHubStatus {
  state: "on" | "off" | "unknown";
  evidence: "probed" | "bound" | "cached" | "unconfigured" | "process" | "timeout";
  online?: boolean;
  url?: string;
}

export interface SessionShipStatus {
  dirty: boolean;
  ahead: number;
}

export interface SessionBrief {
  schema: "kxm.session-brief.v1";
  generatedAt: string;
  staleSeconds: number;
  source: "legacy" | "vnext" | "both";
  hub: SessionHubStatus;
  stats: SessionWorkStats;
  tasks: SessionWorkItem[];
  plans: SessionWorkItem[];
  statusLine: string;
  widgetLines: string[];
  cost?: string;
  sessionToken?: string;
}

function hubPrefix(hub?: Partial<SessionHubStatus>): string {
  if (hub?.state === "on" || (hub?.state === undefined && hub?.online === true)) return "kxm hub:on";
  if (hub?.state === "off" || (hub?.state === undefined && hub?.online === false)) return "kxm hub:off";
  if (hub?.state === "unknown") return "kxm hub:unknown";
  return "kxm";
}

function truncate(value: string, width: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function uniqueLabels(items: SessionWorkItem[]): SessionWorkItem[] {
  const seen = new Set<string>();
  return items.map((item) => {
    let label = item.label;
    if (seen.has(label)) label = truncate(`${label} · ${item.id.slice(-6)}`, 72);
    seen.add(label);
    return label === item.label ? item : { ...item, label };
  });
}

function taskItem(run: MeshTuiRun): SessionWorkItem {
  const stage = run.currentStage ?? "-";
  const progress = run.progress ? ` ${run.progress.done}/${run.progress.total}` : "";
  const detail = `${run.definitionId}/${stage}${progress}`.trim();
  const label = truncate(`Task  ${run.definitionId}  ${run.status}  ${stage}${progress}`, 72);
  const prompt = `Continue KXM task \`${run.definitionId}\` (run ${run.id}) at stage ${stage}${run.progress ? ` (${run.progress.done}/${run.progress.total})` : ""}. Load the run, then proceed without repeating completed work.`;
  return { kind: "task", id: run.id, runId: run.id, label, detail, prompt };
}

function planItem(plan: MeshTuiPlan): SessionWorkItem {
  const label = truncate(`Plan  ${plan.summary}`, 72);
  const prompt = `Continue from KXM plan: ${plan.summary} (run ${plan.runId}). Load that run and proceed.`;
  return { kind: "plan", id: plan.id, runId: plan.runId, label, detail: plan.summary, prompt };
}

function recentTasks(runs: MeshTuiRun[]): MeshTuiRun[] {
  const active = runs.filter((run) => run.status === "running" || run.status === "waiting");
  const rest = runs.filter((run) => run.status !== "running" && run.status !== "waiting");
  return [...active, ...rest].slice(0, MAX_SESSION_BRIEF_TASKS);
}

export function formatShipLine(ship?: SessionShipStatus): string {
  if (!ship) return "ship verify · PR=CI";
  if (ship.dirty) return "ship dirty · commit after verify";
  if (ship.ahead > 0) return `ship ${ship.ahead} local · PR after CI`;
  return "ship clean · PR after CI";
}

export function readGitShip(cwd: string): SessionShipStatus | undefined {
  try {
    const dirty = spawnSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8", windowsHide: true });
    if (dirty.status !== 0) return undefined;
    const isDirty = dirty.stdout.trim().length > 0;

    // First try configured upstream
    const upstream = spawnSync("git", ["-C", cwd, "rev-list", "--count", "@{u}..HEAD"], { encoding: "utf8", windowsHide: true });
    if (upstream.status === 0) {
      return {
        dirty: isDirty,
        ahead: Number.parseInt(upstream.stdout.trim(), 10) || 0,
      };
    }

    // When no upstream, count against merge base of default branch
    for (const baseRef of ["origin/HEAD", "main", "origin/main", "master", "origin/master"]) {
      const mb = spawnSync("git", ["-C", cwd, "merge-base", baseRef, "HEAD"], { encoding: "utf8", windowsHide: true });
      if (mb.status === 0 && mb.stdout.trim()) {
        const count = spawnSync("git", ["-C", cwd, "rev-list", "--count", `${mb.stdout.trim()}..HEAD`], { encoding: "utf8", windowsHide: true });
        if (count.status === 0) {
          return {
            dirty: isDirty,
            ahead: Number.parseInt(count.stdout.trim(), 10) || 0,
          };
        }
      }
    }

    return {
      dirty: isDirty,
      ahead: 0,
    };
  } catch {
    return undefined;
  }
}

export function formatCostLine(input?: {
  sessionCostUsd?: number;
  runCostUsd?: number;
  harness?: string;
  model?: string;
}): string | undefined {
  if (!input) return undefined;
  if (input.sessionCostUsd === undefined && input.runCostUsd === undefined) return "unknown";
  const sess = input.sessionCostUsd !== undefined ? `$${input.sessionCostUsd.toFixed(2)} sess` : undefined;
  const run = input.runCostUsd !== undefined ? `$${input.runCostUsd.toFixed(2)} run` : undefined;
  const route = input.harness && input.model ? `${input.harness}/${input.model}` : (input.model ?? undefined);
  const parts = [sess, run, route].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "unknown";
}

export function renderStatusLine(
  statsOrBrief: SessionWorkStats | SessionBrief,
  current?: SessionWorkItem,
  hub?: Partial<SessionHubStatus>,
  ship?: SessionShipStatus,
  updateLatest?: string,
  cost?: string,
): string {
  if ("schema" in statsOrBrief && statsOrBrief.schema === "kxm.session-brief.v1") {
    const brief = statsOrBrief;
    if (!current && !hub && !ship && !updateLatest && !cost) {
      return brief.statusLine;
    }
    return formatSessionStatusLine(
      brief.stats,
      current,
      hub ?? brief.hub,
      ship,
      updateLatest,
      cost ?? brief.cost,
    );
  }
  return formatSessionStatusLine(statsOrBrief as SessionWorkStats, current, hub, ship, updateLatest, cost);
}

export function formatSessionStatusLine(
  stats: SessionWorkStats,
  current?: SessionWorkItem,
  hub?: Partial<SessionHubStatus>,
  ship?: SessionShipStatus,
  updateLatest?: string,
  cost?: string,
): string {
  const head = hubPrefix(hub);
  if (!current && stats.activeTasks === 0 && stats.planCount === 0 && stats.inbox === 0) {
    const idle = hub?.online === undefined && hub?.state === undefined ? "kxm idle" : `${head} · idle`;
    const withShip = ship?.dirty
      ? `${idle} · dirty`
      : (ship && ship.ahead > 0 ? `${idle} · ${ship.ahead} local` : idle);
    const withCost = cost ? `${withShip} · ${cost}` : withShip;
    const finalLine = updateLatest ? `${withCost} · upd ${updateLatest}` : withCost;
    return finalLine.length <= 80 ? finalLine : `${finalLine.slice(0, 79)}…`;
  }
  const parts: string[] = [];
  if (current?.kind === "task") parts.push(`${head} ${current.detail}`);
  else if (current?.kind === "plan") parts.push(`${head} plan ${truncate(current.detail, 36)}`);
  else parts.push(head);
  parts.push(`${stats.activeTasks} task${stats.activeTasks === 1 ? "" : "s"}`);
  if (stats.waitingTasks > 0) parts.push(`${stats.waitingTasks} waiting`);
  parts.push(`${stats.planCount} plan${stats.planCount === 1 ? "" : "s"}`);
  if (stats.inbox > 0) parts.push(`inbox ${stats.inbox}`);
  if (ship?.dirty) parts.push("dirty");
  else if (ship && ship.ahead > 0) parts.push(`${ship.ahead} local`);
  if (cost) parts.push(cost);
  if (updateLatest) parts.push(`upd ${updateLatest}`);
  const line = parts.join(" · ");
  return line.length <= 80 ? line : `${line.slice(0, 79)}…`;
}

export function formatSessionWidget(
  stats: SessionWorkStats,
  current?: SessionWorkItem,
  hub?: Partial<SessionHubStatus>,
  ship?: SessionShipStatus,
  updateLatest?: string,
  cost?: string,
): string[] {
  const hubMark = hub?.state === "on" || hub?.online === true
    ? "hub:on  "
    : (hub?.state === "off" || hub?.online === false
      ? "hub:off  "
      : (hub?.state === "unknown" ? "hub:unknown  " : ""));
  const lines = [
    `KXM  ${hubMark}${stats.activeTasks} tasks  ${stats.waitingTasks} waiting  ${stats.planCount} plans  inbox ${stats.inbox}`,
  ];
  if (current) lines.push(`now  ${current.kind}  ${truncate(current.detail, 56)}`);
  else if (stats.latestPlan) lines.push(`plan ${truncate(stats.latestPlan, 60)}`);
  else lines.push("now  no selected work");
  lines.push(formatShipLine(ship));
  if (cost) lines.push(`cost  ${cost}`);
  if (updateLatest) lines.push(`update  ${updateLatest} available · kxm update --kxm`);
  return lines;
}

export function buildSessionBrief(
  snapshot: Pick<LocalMeshSnapshot, "runs" | "plans" | "openMessageTotal" | "runTotal">,
  current?: SessionWorkItem,
  hub?: SessionHubStatus,
  ship?: SessionShipStatus,
  updateLatest?: string,
  cost?: string,
  sessionToken?: string,
  source: "legacy" | "vnext" | "both" = "legacy",
  staleSeconds = DEFAULT_SESSION_BRIEF_STALE_SECONDS,
): SessionBrief {
  const active = snapshot.runs.filter((run) => run.status === "running" || run.status === "waiting");
  const stats: SessionWorkStats = {
    activeTasks: active.length,
    waitingTasks: snapshot.runs.filter((run) => run.status === "waiting").length,
    planCount: snapshot.plans.length,
    inbox: snapshot.openMessageTotal,
    runTotal: snapshot.runTotal,
    ...(snapshot.plans[0]?.summary ? { latestPlan: snapshot.plans[0].summary } : {}),
  };
  const tasks = uniqueLabels(recentTasks(snapshot.runs).map(taskItem));
  const plans = uniqueLabels(snapshot.plans.slice(0, MAX_SESSION_BRIEF_PLANS).map(planItem));
  const resolvedHub: SessionHubStatus = hub ?? { state: "off", evidence: "unconfigured", online: false };
  const statusLine = formatSessionStatusLine(stats, current, resolvedHub, ship, updateLatest, cost);
  const widgetLines = formatSessionWidget(stats, current, resolvedHub, ship, updateLatest, cost);
  return {
    schema: SESSION_BRIEF_SCHEMA,
    generatedAt: new Date().toISOString(),
    staleSeconds,
    source,
    hub: resolvedHub,
    stats,
    tasks,
    plans,
    statusLine,
    widgetLines,
    ...(cost ? { cost } : {}),
    ...(sessionToken ? { sessionToken } : {}),
  };
}

export function readCachedSessionBrief(stateDir: string): SessionBrief | undefined {
  const file = join(stateDir, "session-brief.json");
  try {
    if (!existsSync(file)) return undefined;
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as SessionBrief;
    if (parsed && parsed.schema === "kxm.session-brief.v1" && typeof parsed.generatedAt === "string") {
      const ageMs = Date.now() - Date.parse(parsed.generatedAt);
      const ttlMs = (parsed.staleSeconds ?? DEFAULT_SESSION_BRIEF_STALE_SECONDS) * 1000;
      if (ageMs >= 0 && ageMs < ttlMs) {
        return parsed;
      }
    }
  } catch {
    /* cache miss or unreadable */
  }
  return undefined;
}

export function writeCachedSessionBrief(stateDir: string, brief: SessionBrief): void {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const file = join(stateDir, "session-brief.json");
    const tmp = `${file}.tmp.${randomUUID().slice(0, 8)}`;
    writeFileSync(tmp, JSON.stringify(brief, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    /* best effort */
  }
}

export function estimateSessionCost(stateDir: string): string | undefined {
  try {
    const telemetryFile = join(stateDir, "telemetry.jsonl");
    if (!existsSync(telemetryFile)) return undefined;
    const records = readRoutingRecords(telemetryFile);
    if (records.length === 0) return undefined;
    let totalCost = 0;
    let hasMetered = false;
    let latestModel: string | undefined;
    let latestHarness: string | undefined;
    for (const { routing } of records) {
      const r = routing as unknown as Record<string, unknown>;
      const costBasis = (r.costBasis as string | undefined) ?? (typeof r.costUsd === "number" ? "metered" : "unmetered");
      if (costBasis === "metered" && typeof r.costUsd === "number") {
        totalCost += r.costUsd;
        hasMetered = true;
      }
      latestModel = (r.effectiveModel as string | undefined) ?? (r.requestedModel as string | undefined) ?? latestModel;
      latestHarness = (r.harness as string | undefined) ?? latestHarness;
    }
    if (!hasMetered) return "unknown";
    const route = latestHarness && latestModel ? `${latestHarness}/${latestModel}` : latestModel;
    return `$${totalCost.toFixed(2)} sess${route ? ` · ${route}` : ""}`;
  } catch {
    return undefined;
  }
}

export async function resolveSessionHubStatus(
  url: string | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 300,
): Promise<SessionHubStatus> {
  if (!url || !url.trim()) {
    return { state: "off", evidence: "unconfigured", online: false };
  }
  try {
    const { health } = await probeHubHealth(url.trim(), fetchImpl, timeoutMs);
    if (health === "on") {
      return { state: "on", evidence: "probed", online: true, url: url.trim() };
    }
    if (health === "off") {
      return { state: "off", evidence: "probed", online: false, url: url.trim() };
    }
    return { state: "unknown", evidence: "timeout", online: false, url: url.trim() };
  } catch {
    return { state: "unknown", evidence: "timeout", online: false, url: url.trim() };
  }
}

export function loadSessionBrief(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  current?: SessionWorkItem,
  hub?: SessionHubStatus,
  options: {
    force?: boolean;
    updateLatest?: string;
    cost?: string;
    sessionToken?: string;
    ship?: SessionShipStatus;
  } = {},
): SessionBrief {
  const paths = resolveKxmSnapshotPaths(cwd, env);
  if (!options.force) {
    const cached = readCachedSessionBrief(paths.stateDir);
    if (cached) {
      if (current || hub || options.cost) {
        const effectiveHub = hub ?? cached.hub;
        const effectiveCost = options.cost ?? cached.cost;
        const statusLine = formatSessionStatusLine(
          cached.stats,
          current,
          effectiveHub,
          options.ship,
          options.updateLatest,
          effectiveCost,
        );
        const widgetLines = formatSessionWidget(
          cached.stats,
          current,
          effectiveHub,
          options.ship,
          options.updateLatest,
          effectiveCost,
        );
        return {
          ...cached,
          hub: effectiveHub,
          ...(effectiveCost ? { cost: effectiveCost } : {}),
          statusLine,
          widgetLines,
        };
      }
      return cached;
    }
  }

  const ship = options.ship ?? readGitShip(cwd);
  let brief: SessionBrief;
  try {
    const cachedUpdate = readUpdateCache(paths.stateDir);
    const updateLatest = options.updateLatest ?? (cachedUpdate?.available ? cachedUpdate.latest : undefined);
    const cost = options.cost ?? estimateSessionCost(paths.stateDir);
    brief = buildSessionBrief(
      loadLocalMeshSnapshot(paths.dataPath, paths.stateDir),
      current,
      hub,
      ship,
      updateLatest,
      cost,
      options.sessionToken,
    );
  } catch {
    brief = buildSessionBrief(
      { runs: [], plans: [], openMessageTotal: 0, runTotal: 0 },
      current,
      hub,
      ship,
      options.updateLatest,
      options.cost,
      options.sessionToken,
    );
  }

  writeCachedSessionBrief(paths.stateDir, brief);
  return brief;
}

export async function loadSessionBriefAsync(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  current?: SessionWorkItem,
  hub?: SessionHubStatus,
  options: {
    force?: boolean;
    fetchImpl?: typeof fetch;
    cost?: string;
    sessionToken?: string;
    ship?: SessionShipStatus;
  } = {},
): Promise<SessionBrief> {
  const paths = resolveKxmSnapshotPaths(cwd, env);
  if (!options.force) {
    const cached = readCachedSessionBrief(paths.stateDir);
    if (cached) {
      if (current || hub || options.cost) {
        const effectiveHub = hub ?? cached.hub;
        const effectiveCost = options.cost ?? cached.cost;
        const statusLine = formatSessionStatusLine(
          cached.stats,
          current,
          effectiveHub,
          options.ship,
          undefined,
          effectiveCost,
        );
        const widgetLines = formatSessionWidget(
          cached.stats,
          current,
          effectiveHub,
          options.ship,
          undefined,
          effectiveCost,
        );
        return {
          ...cached,
          hub: effectiveHub,
          ...(effectiveCost ? { cost: effectiveCost } : {}),
          statusLine,
          widgetLines,
        };
      }
      return cached;
    }
  }

  let resolvedHub = hub;
  if (!resolvedHub) {
    const serverUrl = env.KXM_SERVER_URL?.trim() || readHubBinding(env)?.url;
    resolvedHub = await resolveSessionHubStatus(serverUrl, options.fetchImpl, 300);
  }

  return loadSessionBrief(cwd, env, current, resolvedHub, options);
}

export function sessionBriefChoices(brief: SessionBrief): string[] {
  return [SESSION_BRIEF_SKIP_LABEL, ...brief.tasks.map((item) => item.label), ...brief.plans.map((item) => item.label)];
}

export function itemFromChoice(brief: SessionBrief, choice: string | undefined): SessionWorkItem | undefined {
  if (!choice || choice === SESSION_BRIEF_SKIP_LABEL) return undefined;
  return [...brief.tasks, ...brief.plans].find((item) => item.label === choice);
}

export function formatSessionBriefText(brief: SessionBrief): string {
  const lines = [brief.statusLine, ""];
  if (brief.tasks.length === 0 && brief.plans.length === 0) {
    lines.push("No recent tasks or plans.");
    return lines.join("\n");
  }
  if (brief.tasks.length > 0) {
    lines.push("Tasks");
    for (const task of brief.tasks) lines.push(`  ${task.label.replace(/^Task\s+/, "")}`);
  }
  if (brief.plans.length > 0) {
    lines.push("Plans");
    for (const plan of brief.plans) lines.push(`  ${plan.label.replace(/^Plan\s+/, "")}`);
  }
  lines.push("", "Reply with an item to continue, or start a fresh prompt. Pi TUI: /kxm");
  return lines.join("\n");
}

export function sessionBriefPickerEnabled(input: { env?: NodeJS.ProcessEnv; mode?: string; reason?: string }): boolean {
  if (input.env?.KXM_SESSION_BRIEF?.trim() === "off") return false;
  if (input.mode !== "tui") return false;
  const reason = input.reason ?? "startup";
  return reason === "startup" || reason === "new" || reason === "fork";
}

export const KXM_SLASH_SUBCOMMANDS = ["status", "hub", "help"] as const;
export type KxmSlashCommand = "brief" | typeof KXM_SLASH_SUBCOMMANDS[number];

export function parseKxmSlashArgs(args: string | undefined): KxmSlashCommand {
  const raw = String(args ?? "").trim().toLowerCase();
  if (raw === "" || raw === "brief") return "brief";
  if (raw === "status" || raw === "hub" || raw === "help") return raw;
  return "help";
}

export function kxmSlashCompletions(prefix: string): Array<{ value: string; label: string }> {
  const p = prefix.trim().toLowerCase();
  return KXM_SLASH_SUBCOMMANDS
    .filter((name) => name.startsWith(p))
    .map((name) => ({ value: name, label: name }));
}

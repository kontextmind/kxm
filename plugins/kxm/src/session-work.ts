import {
  loadLocalMeshSnapshot,
  resolveKxmSnapshotPaths,
  type LocalMeshSnapshot,
  type MeshTuiPlan,
  type MeshTuiRun,
} from "./local-snapshot.ts";

export const SESSION_BRIEF_SKIP_LABEL = "Skip — start a fresh session";
export const MAX_SESSION_BRIEF_TASKS = 5;
export const MAX_SESSION_BRIEF_PLANS = 5;

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
  online?: boolean;
}

export interface SessionBrief {
  stats: SessionWorkStats;
  tasks: SessionWorkItem[];
  plans: SessionWorkItem[];
  statusLine: string;
  widgetLines: string[];
}

function hubPrefix(hub?: SessionHubStatus): string {
  if (hub?.online === true) return "kxm hub:on";
  if (hub?.online === false) return "kxm hub:off";
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

export function formatSessionStatusLine(stats: SessionWorkStats, current?: SessionWorkItem, hub?: SessionHubStatus): string {
  const head = hubPrefix(hub);
  if (!current && stats.activeTasks === 0 && stats.planCount === 0 && stats.inbox === 0) {
    return hub?.online === undefined ? "kxm idle" : `${head} · idle`;
  }
  const parts: string[] = [];
  if (current?.kind === "task") parts.push(`${head} ${current.detail}`);
  else if (current?.kind === "plan") parts.push(`${head} plan ${truncate(current.detail, 36)}`);
  else parts.push(head);
  parts.push(`${stats.activeTasks} task${stats.activeTasks === 1 ? "" : "s"}`);
  if (stats.waitingTasks > 0) parts.push(`${stats.waitingTasks} waiting`);
  parts.push(`${stats.planCount} plan${stats.planCount === 1 ? "" : "s"}`);
  if (stats.inbox > 0) parts.push(`inbox ${stats.inbox}`);
  const line = parts.join(" · ");
  return line.length <= 80 ? line : `${line.slice(0, 79)}…`;
}

export function formatSessionWidget(stats: SessionWorkStats, current?: SessionWorkItem, hub?: SessionHubStatus): string[] {
  const hubMark = hub?.online === true ? "hub:on  " : hub?.online === false ? "hub:off  " : "";
  const lines = [
    `KXM  ${hubMark}${stats.activeTasks} tasks  ${stats.waitingTasks} waiting  ${stats.planCount} plans  inbox ${stats.inbox}`,
  ];
  if (current) lines.push(`now  ${current.kind}  ${truncate(current.detail, 56)}`);
  else if (stats.latestPlan) lines.push(`plan ${truncate(stats.latestPlan, 60)}`);
  else lines.push("now  no selected work");
  return lines;
}

export function buildSessionBrief(
  snapshot: Pick<LocalMeshSnapshot, "runs" | "plans" | "openMessageTotal" | "runTotal">,
  current?: SessionWorkItem,
  hub?: SessionHubStatus,
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
  return {
    stats,
    tasks,
    plans,
    statusLine: formatSessionStatusLine(stats, current, hub),
    widgetLines: formatSessionWidget(stats, current, hub),
  };
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

export function loadSessionBrief(cwd: string, env: NodeJS.ProcessEnv = process.env, current?: SessionWorkItem, hub?: SessionHubStatus): SessionBrief {
  try {
    const paths = resolveKxmSnapshotPaths(cwd, env);
    return buildSessionBrief(loadLocalMeshSnapshot(paths.dataPath, paths.stateDir), current, hub);
  } catch {
    return buildSessionBrief({ runs: [], plans: [], openMessageTotal: 0, runTotal: 0 }, current, hub);
  }
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

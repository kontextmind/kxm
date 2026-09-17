import {
  Box,
  Container,
  HStack,
  Key,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  stripTerminalSequences,
  Text,
  TruncatedText,
  TuiAltScreen,
  VStack,
  type Component,
  type Terminal,
  type TUI,
} from "@earendil-works/pi-tui";
import { mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentRecord } from "./protocol.ts";
import { createKxmTuiAnsiTheme, type KxmTuiTheme } from "@kontextmind/tui";
import { slugifyBranchPart } from "./external-effects.ts";
import {
  loadLocalMeshSnapshot,
  summarizeMeshRun,
  type LocalMeshSnapshot,
  type MeshTuiPidClaim,
  type MeshTuiPlan,
  type MeshTuiRun,
  type MeshTuiRunStage,
} from "./local-snapshot.ts";

export {
  loadLocalMeshSnapshot,
  summarizeMeshRun,
  type LocalMeshSnapshot,
  type MeshTuiPidClaim,
  type MeshTuiPlan,
  type MeshTuiRun,
  type MeshTuiRunStage,
};

export const MESH_TUI_PANELS = ["agents", "tasks", "workflows", "plans", "inbox", "procs", "spend"] as const;
export type MeshTuiPanel = typeof MESH_TUI_PANELS[number];

export const MESH_TUI_TAB_LABELS: Record<MeshTuiPanel, string> = {
  agents: "Agents",
  tasks: "Tasks",
  workflows: "Workflows",
  plans: "Plans",
  inbox: "Inbox",
  procs: "Procs",
  spend: "Spend",
};

export interface DashboardAction {
  action: "approve" | "reject" | "degrade" | "signal" | "cancel";
  at: string;
  targetId?: string | undefined;
}

export interface MeshTuiView {
  tab: MeshTuiPanel;
  selected: number;
  pane: "list" | "detail";
  help: boolean;
  statusMessage?: string | undefined;
  lastAction?: DashboardAction | undefined;
}

export function defaultMeshTuiView(screen?: MeshTuiPanel): MeshTuiView {
  return { tab: screen ?? "agents", selected: 0, pane: "list", help: false };
}

export function applyMeshTuiKey(view: MeshTuiView, key: string, itemCount = 0): MeshTuiView | "quit" {
  if (matchesKey(key, "q") || matchesKey(key, Key.ctrl("c"))) return "quit";
  if (matchesKey(key, Key.escape)) return view.help ? { ...view, help: false } : "quit";
  if (matchesKey(key, "h") || matchesKey(key, "?")) return { ...view, help: !view.help };
  const byNumber: Record<string, MeshTuiPanel> = {
    "1": "agents",
    "2": "tasks",
    "3": "workflows",
    "4": "plans",
    "5": "inbox",
    "6": "procs",
    "7": "spend",
  };
  const tab = byNumber[key];
  if (tab) return { tab, selected: 0, pane: "list", help: false };
  const index = MESH_TUI_PANELS.indexOf(view.tab);
  if (matchesKey(key, Key.tab) || matchesKey(key, "]")) {
    return { tab: MESH_TUI_PANELS[(index + 1) % MESH_TUI_PANELS.length]!, selected: 0, pane: "list", help: false };
  }
  if (matchesKey(key, Key.shift("tab")) || matchesKey(key, "[")) {
    return { tab: MESH_TUI_PANELS[(index - 1 + MESH_TUI_PANELS.length) % MESH_TUI_PANELS.length]!, selected: 0, pane: "list", help: false };
  }
  if (matchesKey(key, Key.left)) return { ...view, pane: "list", help: false };
  if (matchesKey(key, Key.right) || matchesKey(key, Key.enter) || matchesKey(key, Key.space)) {
    return { ...view, pane: "detail", help: false };
  }
  if (matchesKey(key, Key.up)) {
    return { ...view, selected: Math.max(0, view.selected - 1), pane: "list", help: false };
  }
  if (matchesKey(key, Key.down)) {
    return { ...view, selected: Math.min(Math.max(0, itemCount - 1), view.selected + 1), pane: "list", help: false };
  }
  if (matchesKey(key, "a")) {
    return {
      ...view,
      statusMessage: `[APPROVE] Queued approval for ${view.tab} item #${view.selected + 1}`,
      lastAction: { action: "approve", at: new Date().toISOString() },
    };
  }
  if (matchesKey(key, "r")) {
    return {
      ...view,
      statusMessage: `[REJECT] Marked ${view.tab} item #${view.selected + 1} for rework`,
      lastAction: { action: "reject", at: new Date().toISOString() },
    };
  }
  if (matchesKey(key, "d")) {
    return {
      ...view,
      statusMessage: `[DEGRADE] Degraded ${view.tab} item #${view.selected + 1} to operator`,
      lastAction: { action: "degrade", at: new Date().toISOString() },
    };
  }
  if (matchesKey(key, "s")) {
    return {
      ...view,
      statusMessage: `[SIGNAL] Signal dispatched for ${view.tab} item #${view.selected + 1}`,
      lastAction: { action: "signal", at: new Date().toISOString() },
    };
  }
  if (matchesKey(key, "c")) {
    return {
      ...view,
      statusMessage: `[CANCEL] Cancellation requested for ${view.tab} item #${view.selected + 1}`,
      lastAction: { action: "cancel", at: new Date().toISOString() },
    };
  }
  return view;
}

export interface DegradeWorktreeResult {
  ok: boolean;
  branchName: string;
  worktreePath: string;
  jumpCommand: string;
  copiedToClipboard: boolean;
  error?: string | undefined;
}

export function copyToClipboard(text: string): boolean {
  try {
    if (process.platform === "darwin") {
      const proc = spawnSync("pbcopy", { input: text, encoding: "utf8", windowsHide: true });
      return proc.status === 0;
    }
    if (process.platform === "win32") {
      const proc = spawnSync("clip", { input: text, encoding: "utf8", windowsHide: true });
      return proc.status === 0;
    }
    const wl = spawnSync("wl-copy", [text], { encoding: "utf8", windowsHide: true });
    if (wl.status === 0) return true;
    const xclip = spawnSync("xclip", ["-selection", "clipboard"], { input: text, encoding: "utf8", windowsHide: true });
    return xclip.status === 0;
  } catch {
    return false;
  }
}

/**
 * Automated Degrade Worktree Spawn (Decision Q1).
 * Spawns an isolated git worktree for human operator intervention on key 'd'.
 * Detaches the AI worker, copies directory path to clipboard, and prints jump command.
 */
export function spawnDegradeWorktree(
  repoRoot: string,
  runId: string,
  options?: {
    description?: string | undefined;
    execFn?: ((cmd: string, args: string[]) => { status: number; stdout: string; stderr: string }) | undefined;
    clipboardFn?: ((text: string) => boolean) | undefined;
  },
): DegradeWorktreeResult {
  const runner = options?.execFn ?? ((cmd: string, args: string[]) => {
    const res = spawnSync(cmd, args, {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
      ),
    });
    return {
      status: res.status ?? 1,
      stdout: res.stdout || "",
      stderr: res.stderr || "",
    };
  });

  const cleanRunId = runId.replace(/^run_/, "");
  const desc = options?.description ? slugifyBranchPart(options.description, 30) : "degrade";
  const branchName = `kxm/run-${cleanRunId}-${desc}`;
  const relativeWtPath = join(".kxm", "worktrees", `run-${cleanRunId}-${desc}`);
  const absoluteWtPath = resolve(repoRoot, relativeWtPath);
  const jumpCommand = `cd "${absoluteWtPath}"`;

  try {
    mkdirSync(dirname(absoluteWtPath), { recursive: true });

    const branchCheck = runner("git", ["rev-parse", "--verify", `refs/heads/${branchName}`]);
    let wtRes: { status: number; stdout: string; stderr: string };
    if (branchCheck.status === 0) {
      wtRes = runner("git", ["worktree", "add", absoluteWtPath, branchName]);
    } else {
      wtRes = runner("git", ["worktree", "add", "-b", branchName, absoluteWtPath]);
    }

    if (wtRes.status !== 0) {
      return {
        ok: false,
        branchName,
        worktreePath: absoluteWtPath,
        jumpCommand,
        copiedToClipboard: false,
        error: `failed_to_add_worktree: ${wtRes.stderr.trim() || wtRes.stdout.trim()}`,
      };
    }

    const clipFn = options?.clipboardFn ?? copyToClipboard;
    const copied = clipFn(absoluteWtPath);
    return {
      ok: true,
      branchName,
      worktreePath: absoluteWtPath,
      jumpCommand,
      copiedToClipboard: copied,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      branchName,
      worktreePath: absoluteWtPath,
      jumpCommand,
      copiedToClipboard: false,
      error: `degrade_worktree_spawn_error: ${(err as Error).message}`,
    };
  }
}

export interface MeshTuiSnapshot extends LocalMeshSnapshot {
  serverUrl: string;
  healthOk: boolean;
  readyOk: boolean;
  storage?: string;
  onlineCount: number;
  transport: "sse" | "snapshot";
  metadataMode?: "ops" | "legacy";
  error?: string;
  fetchedAt: string;
}

function age(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function pad(value: string, width: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= width) return text.padEnd(width);
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function progressBar(done: number, total: number, width = 10): string {
  if (total <= 0) return "-".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
  return "#".repeat(filled) + "-".repeat(width - filled);
}

function stageMark(status: string, theme: MeshTuiTheme): string {
  if (status === "passed") return theme.success("[x]");
  if (status === "failed") return theme.error("[F]");
  if (status === "warning") return theme.warning("[!]");
  if (status === "in_progress") return theme.warning("[~]");
  if (status === "waiting") return theme.dim("[.]");
  return theme.dim("[ ]");
}

/**
 * The dashboard palette lives in `tui/theme.ts` so a config surface and the
 * live screens cannot drift to different meanings for the same colour.
 */
type MeshTuiTheme = Pick<KxmTuiTheme, "accent" | "dim" | "error" | "success" | "warning" | "headerBg" | "panelBg">;

function meshTuiTheme(color: boolean): MeshTuiTheme {
  return createKxmTuiAnsiTheme(color);
}

function visibleAgents(snapshot: MeshTuiSnapshot): AgentRecord[] {
  return snapshot.agents.filter((agent) => agent.model !== "tui");
}

function panelMetric(snapshot: MeshTuiSnapshot, panel: MeshTuiPanel): string {
  if (panel === "agents") {
    const agents = visibleAgents(snapshot);
    return `${agents.filter((agent) => agent.online).length}/${agents.length}`;
  }
  if (panel === "tasks") {
    const active = snapshot.runs.filter((run) => run.status === "running" || run.status === "waiting");
    const total = active.reduce((sum, run) => sum + (run.progress?.total ?? 0), 0);
    const done = active.reduce((sum, run) => sum + (run.progress?.done ?? 0), 0);
    return total > 0 ? `${done}/${total}` : String(active.length);
  }
  if (panel === "workflows") return snapshot.runs.length === snapshot.runTotal ? String(snapshot.runTotal) : `${snapshot.runs.length}/${snapshot.runTotal}`;
  if (panel === "plans") return String(snapshot.plans.length);
  if (panel === "inbox") return snapshot.openMessages.length === snapshot.openMessageTotal ? String(snapshot.openMessageTotal) : `${snapshot.openMessages.length}/${snapshot.openMessageTotal}`;
  if (panel === "spend") {
    const spend = snapshot.spend ?? [];
    let totalCost = 0;
    let hasMetered = false;
    for (const item of spend) {
      const r = item.routing as unknown as Record<string, unknown>;
      const costBasis = (r.costBasis as string | undefined) ?? (typeof r.costUsd === "number" ? "metered" : "unmetered");
      if (costBasis === "metered" && typeof r.costUsd === "number") {
        totalCost += r.costUsd;
        hasMetered = true;
      }
    }
    return hasMetered ? `$${totalCost.toFixed(2)}` : String(spend.length);
  }
  return `${snapshot.pids.filter((claim) => claim.live).length}/${snapshot.pids.length}`;
}

function panelRows(snapshot: MeshTuiSnapshot, panel: MeshTuiPanel, theme: MeshTuiTheme): string[] {
  const now = Date.parse(snapshot.fetchedAt);
  if (panel === "agents") {
    const agents = visibleAgents(snapshot);
    return agents.length === 0 ? [] : [
      theme.dim(`${pad("name", 14)} ${pad("on", 3)} ${pad("model", 24)} ${pad("seen", 4)} purpose`),
      ...agents.map((agent) => (
        `${pad(agent.name, 14)} ${agent.online ? theme.success(pad("yes", 3)) : theme.dim(pad("no", 3))} ${pad(agent.model ?? "-", 24)} ${pad(age(agent.lastSeenAt, now), 4)} ${agent.purpose}`
      )),
    ];
  }
  if (panel === "tasks") {
    const active = snapshot.runs.filter((run) => run.status === "running" || run.status === "waiting");
    if (active.length === 0) return [];
    const rows: string[] = [];
    for (const run of active) {
      const progress = run.progress;
      const bar = progress ? progressBar(progress.done, progress.total) : "----------";
      const counts = progress ? `${progress.done}/${progress.total}` : "-";
      rows.push(`${pad(run.definitionId, 16)} ${pad(run.status, 9)} ${bar} ${pad(counts, 5)} ${run.currentStage ?? "-"}  ${run.id}`);
      for (const stage of run.stages ?? []) {
        const attempts = stage.attempts && stage.attempts > 1 ? `  attempt ${stage.attempts}` : "";
        rows.push(`  ${stageMark(stage.status, theme)} ${pad(stage.label ?? stage.id, 22)} ${stage.status}${attempts}`);
      }
    }
    return rows;
  }
  if (panel === "workflows") {
    return [
      ...(snapshot.runs.length === 0 ? [] : [theme.dim(`${pad("state", 10)} ${pad("workflow", 16)} ${pad("stage", 14)} ${pad("done", 5)} id`)]),
      ...snapshot.runs.map((run) => {
        const counts = run.progress ? `${run.progress.done}/${run.progress.total}` : "-";
        return `${pad(run.status, 10)} ${pad(run.definitionId, 16)} ${pad(run.currentStage ?? "-", 14)} ${pad(counts, 5)} ${run.id}`;
      }),
      ...(snapshot.runTotal > snapshot.runs.length ? [theme.dim(`… +${snapshot.runTotal - snapshot.runs.length} more`)] : []),
    ];
  }
  if (panel === "plans") {
    return snapshot.plans.length === 0 ? [] : [
      theme.dim(`${pad("age", 4)} ${pad("run", 12)} ${pad("stage", 14)} plan`),
      ...snapshot.plans.map((plan) => (
        `${pad(age(plan.createdAt, now), 4)} ${pad(plan.runId, 12)} ${pad(plan.stageId ?? "-", 14)} ${plan.summary}`
      )),
    ];
  }
  if (panel === "inbox") {
    return snapshot.openMessages.length === 0 ? [] : [
      theme.dim(`${pad("state", 9)} ${pad("from", 12)} ${pad("to", 12)} ${pad("mode", 8)} ${pad("age", 4)} id`),
      ...snapshot.openMessages.map((message) => (
        `${theme.warning(pad(message.status, 9))} ${pad(message.fromName, 12)} ${pad(message.toName, 12)} ${pad(message.delivery, 8)} ${pad(age(message.createdAt, now), 4)} ${message.id}`
      )),
      ...(snapshot.openMessageTotal > snapshot.openMessages.length ? [theme.dim(`… +${snapshot.openMessageTotal - snapshot.openMessages.length} more`)] : []),
    ];
  }
  if (panel === "spend") {
    const spend = snapshot.spend ?? [];
    if (spend.length === 0) return [];
    return [
      theme.dim(`${pad("age", 4)} ${pad("harness/model", 22)} ${pad("cost", 8)} ${pad("tokens", 14)} outcome`),
      ...spend.slice().reverse().map((entry) => {
        const r = entry.routing as unknown as Record<string, unknown>;
        const model = (r.effectiveModel as string | undefined) ?? (r.requestedModel as string | undefined) ?? "-";
        const harness = (r.harness as string | undefined) ?? "-";
        const route = `${harness}/${model}`;
        const cost = typeof r.costUsd === "number" ? `$${r.costUsd.toFixed(3)}` : ((r.costBasis as string) ?? "-");
        const tokensIn = typeof r.tokensIn === "number" ? r.tokensIn : 0;
        const tokensOut = typeof r.tokensOut === "number" ? r.tokensOut : 0;
        const tokens = `${tokensIn}+${tokensOut}`;
        const outcome = (r.verifierOutcome as string | undefined) ?? (r.finalOutcome as string | undefined) ?? "-";
        return `${pad(age(entry.recordedAt, now), 4)} ${pad(route, 22)} ${pad(cost, 8)} ${pad(tokens, 14)} ${outcome}`;
      }),
    ];
  }
  return snapshot.pids.map((claim) => `${claim.live ? theme.success("live") : theme.error("dead")}  ${pad(claim.role ?? "-", 8)} pid=${claim.pid ?? "-"}  ${claim.file}`);
}

function tabItemCount(snapshot: MeshTuiSnapshot, tab: MeshTuiPanel): number {
  if (tab === "agents") return visibleAgents(snapshot).length;
  if (tab === "tasks") return snapshot.runs.filter((run) => run.status === "running" || run.status === "waiting").length;
  if (tab === "workflows") return snapshot.runs.length;
  if (tab === "plans") return snapshot.plans.length;
  if (tab === "inbox") return snapshot.openMessages.length;
  if (tab === "spend") return snapshot.spend?.length ?? 0;
  return snapshot.pids.length;
}

function tabSplits(tab: MeshTuiPanel): boolean {
  return tab !== "procs";
}

function cursor(theme: MeshTuiTheme, selected: boolean, pane: "list" | "detail", activePane: "list" | "detail"): string {
  if (!selected) return "  ";
  return activePane === pane ? theme.accent("› ") : theme.dim("· ");
}

function listLines(snapshot: MeshTuiSnapshot, view: MeshTuiView, theme: MeshTuiTheme): string[] {
  const now = Date.parse(snapshot.fetchedAt);
  const mark = (index: number) => cursor(theme, index === view.selected, "list", view.pane);
  if (view.tab === "agents") {
    return visibleAgents(snapshot).map((agent, index) => (
      `${mark(index)}${pad(agent.name, 14)} ${agent.online ? theme.success(pad("yes", 3)) : theme.dim(pad("no", 3))} ${pad(agent.model ?? "-", 18)} ${pad(age(agent.lastSeenAt, now), 4)}`
    ));
  }
  if (view.tab === "tasks" || view.tab === "workflows") {
    const runs = view.tab === "tasks"
      ? snapshot.runs.filter((run) => run.status === "running" || run.status === "waiting")
      : snapshot.runs;
    return runs.map((run, index) => {
      const counts = run.progress ? `${run.progress.done}/${run.progress.total}` : "-";
      const bar = run.progress ? progressBar(run.progress.done, run.progress.total, 8) : "--------";
      return `${mark(index)}${pad(run.definitionId, 14)} ${pad(run.status, 8)} ${bar} ${pad(counts, 5)} ${run.id}`;
    });
  }
  if (view.tab === "plans") {
    return snapshot.plans.map((plan, index) => (
      `${mark(index)}${pad(age(plan.createdAt, now), 4)} ${pad(plan.stageId ?? "-", 12)} ${plan.summary}`
    ));
  }
  if (view.tab === "inbox") {
    return snapshot.openMessages.map((message, index) => (
      `${mark(index)}${pad(message.status, 9)} ${pad(message.fromName, 10)} → ${pad(message.toName, 10)} ${pad(age(message.createdAt, now), 4)}`
    ));
  }
  if (view.tab === "spend") {
    const spend = (snapshot.spend ?? []).slice().reverse();
    return spend.map((entry, index) => {
      const r = entry.routing as unknown as Record<string, unknown>;
      const model = (r.effectiveModel as string | undefined) ?? (r.requestedModel as string | undefined) ?? "-";
      const harness = (r.harness as string | undefined) ?? "-";
      const route = `${harness}/${model}`;
      const cost = typeof r.costUsd === "number" ? `$${r.costUsd.toFixed(3)}` : ((r.costBasis as string) ?? "-");
      const outcome = (r.verifierOutcome as string | undefined) ?? (r.finalOutcome as string | undefined) ?? "-";
      return `${mark(index)}${pad(age(entry.recordedAt, now), 4)} ${pad(route, 16)} ${pad(cost, 8)} ${outcome}`;
    });
  }
  return snapshot.pids.map((claim, index) => (
    `${mark(index)}${claim.live ? theme.success("live") : theme.error("dead")}  ${pad(claim.role ?? "-", 8)} pid=${claim.pid ?? "-"}`
  ));
}

function detailLines(snapshot: MeshTuiSnapshot, view: MeshTuiView, theme: MeshTuiTheme): string[] {
  const now = Date.parse(snapshot.fetchedAt);
  if (view.tab === "agents") {
    const agent = visibleAgents(snapshot)[view.selected];
    if (!agent) return [theme.dim("No agent selected")];
    const related = snapshot.openMessages.filter((message) => message.fromName === agent.name || message.toName === agent.name);
    return [
      theme.accent(agent.name),
      `${agent.online ? theme.success("online") : theme.dim("offline")}  ${agent.model ?? "-"}`,
      agent.purpose,
      `seen ${age(agent.lastSeenAt, now)} ago`,
      "",
      theme.dim("Open work"),
      ...(related.length === 0 ? [theme.dim("none")] : related.map((message) => `${message.status}  ${message.fromName} → ${message.toName}  ${age(message.createdAt, now)}`)),
    ];
  }
  if (view.tab === "tasks" || view.tab === "workflows") {
    const runs = view.tab === "tasks"
      ? snapshot.runs.filter((run) => run.status === "running" || run.status === "waiting")
      : snapshot.runs;
    const run = runs[view.selected];
    if (!run) return [theme.dim("No run selected")];
    const counts = run.progress ? `${run.progress.done}/${run.progress.total}` : "-";
    return [
      theme.accent(run.definitionId),
      `${run.status}  ${counts}  ${run.currentStage ?? "-"}`,
      run.id,
      run.targetAgentName ? `owner ${run.targetAgentName}` : "",
      "",
      ...(run.stages ?? []).map((stage) => {
        const attempts = stage.attempts && stage.attempts > 1 ? `  attempt ${stage.attempts}` : "";
        return `${stageMark(stage.status, theme)} ${pad(stage.label ?? stage.id, 22)} ${stage.status}${attempts}`;
      }),
    ].filter((line) => line !== "");
  }
  if (view.tab === "plans") {
    const plan = snapshot.plans[view.selected];
    if (!plan) return [theme.dim("No plan selected")];
    const run = snapshot.runs.find((candidate) => candidate.id === plan.runId);
    return [
      theme.accent("Plan"),
      plan.summary,
      `run ${plan.runId}`,
      plan.stageId ? `stage ${plan.stageId}` : "",
      `${plan.severity ?? "info"}  ${age(plan.createdAt, now)} ago`,
      "",
      ...(run?.stages ?? []).map((stage) => `${stageMark(stage.status, theme)} ${stage.label ?? stage.id}`),
    ].filter((line) => line !== "");
  }
  if (view.tab === "inbox") {
    const message = snapshot.openMessages[view.selected];
    if (!message) return [theme.dim("No message selected")];
    return [
      theme.accent(message.id),
      `${message.status}  ${message.delivery}`,
      `${message.fromName} → ${message.toName}`,
      age(message.createdAt, now),
      message.correlationId ? `corr ${message.correlationId}` : theme.dim("bodies never shown"),
    ];
  }
  if (view.tab === "spend") {
    const spend = (snapshot.spend ?? []).slice().reverse();
    const entry = spend[view.selected];
    if (!entry) return [theme.dim("No spend record selected")];
    const r = entry.routing as unknown as Record<string, unknown>;
    const model = (r.effectiveModel as string | undefined) ?? (r.requestedModel as string | undefined) ?? "-";
    const harness = (r.harness as string | undefined) ?? "-";
    const cost = typeof r.costUsd === "number" ? `$${r.costUsd.toFixed(4)}` : ((r.costBasis as string) ?? "-");
    const tokensIn = typeof r.tokensIn === "number" ? r.tokensIn : 0;
    const tokensOut = typeof r.tokensOut === "number" ? r.tokensOut : 0;
    const cacheRead = typeof r.cacheReadTokens === "number" ? r.cacheReadTokens : 0;
    const outcome = (r.verifierOutcome as string | undefined) ?? (r.finalOutcome as string | undefined) ?? "-";
    return [
      theme.accent(`${harness}/${model}`),
      `cost ${cost} (${(r.costBasis as string) ?? "unknown"})`,
      `tokens: in=${tokensIn} out=${tokensOut} cacheRead=${cacheRead}`,
      `outcome: ${outcome}`,
      `recorded ${age(entry.recordedAt, now)} ago (${entry.recordedAt})`,
      ...((r.runId || r.workflowRunId) ? [`run ${((r.runId ?? r.workflowRunId) as string)}`] : []),
      ...((r.stepId || r.stageId) ? [`stage ${((r.stepId ?? r.stageId) as string)}`] : []),
    ];
  }
  const claim = snapshot.pids[view.selected];
  if (!claim) return [theme.dim("No process selected")];
  return [
    claim.live ? theme.success("live") : theme.error("dead"),
    claim.role ?? "-",
    `pid ${claim.pid ?? "-"}`,
    claim.file,
  ];
}

function renderTabBar(snapshot: MeshTuiSnapshot, view: MeshTuiView, theme: MeshTuiTheme): string {
  return MESH_TUI_PANELS.map((panel, index) => {
    const label = `${index + 1} ${MESH_TUI_TAB_LABELS[panel]} ${panelMetric(snapshot, panel)}`;
    return view.tab === panel ? theme.accent(`[${label}]`) : theme.dim(` ${label} `);
  }).join(" ");
}

function dataPanel(title: string, metric: string, rows: string[], emptyText: string, theme: MeshTuiTheme): Component {
  const panel = new Box(1, 0, theme.panelBg);
  panel.addChild(new Text(`${theme.accent(`▌ ${title}`)}  ${theme.dim(metric)}`, 0, 0));
  const table = new Container();
  if (rows.length === 0) {
    table.addChild(new Text(theme.dim(emptyText), 0, 0));
  } else {
    for (const row of rows) table.addChild(new TruncatedText(row, 0, 0));
  }
  panel.addChild(table);
  return panel;
}

export class KxmDashboard implements Component {
  readonly root = new VStack([], { gap: 0 });
  private readonly listContent = new VStack([], { gap: 0 });
  private readonly listScroll = new ScrollView(this.listContent, { primary: true, overscroll: "contain", scrollbar: "auto" });
  private readonly detailContent = new VStack([], { gap: 0 });
  private readonly detailScroll = new ScrollView(this.detailContent, { primary: true, overscroll: "contain", scrollbar: "auto" });
  private snapshot: MeshTuiSnapshot;
  private view: MeshTuiView;
  private readonly color: boolean;
  private readonly requestRender: () => void;
  private readonly onQuit: () => void;
  private readonly getWidth: () => number;
  private readonly onAction?: ((action: DashboardAction, snapshot: MeshTuiSnapshot, view: MeshTuiView) => Promise<void> | void) | undefined;

  constructor(
    snapshot: MeshTuiSnapshot,
    view: MeshTuiView,
    color: boolean,
    requestRender: () => void,
    onQuit: () => void,
    getWidth: () => number = () => 120,
    onAction?: ((action: DashboardAction, snapshot: MeshTuiSnapshot, view: MeshTuiView) => Promise<void> | void) | undefined,
  ) {
    this.snapshot = snapshot;
    this.view = view;
    this.color = color;
    this.requestRender = requestRender;
    this.onQuit = onQuit;
    this.getWidth = getWidth;
    this.onAction = onAction;
    this.rebuild();
  }

  update(snapshot: MeshTuiSnapshot): void {
    this.snapshot = snapshot;
    this.rebuild();
    this.requestRender();
  }

  setStatusMessage(message: string): void {
    this.view = { ...this.view, statusMessage: message };
    this.rebuild();
    this.requestRender();
  }

  private activeScroll(): ScrollView {
    return this.view.pane === "detail" ? this.detailScroll : this.listScroll;
  }

  private fillPane(target: VStack, rows: string[], empty: string, theme: MeshTuiTheme): void {
    target.clear();
    if (rows.length === 0) target.addChild(new Text(theme.dim(empty), 0, 0));
    else for (const row of rows) target.addChild(new TruncatedText(row, 0, 0));
  }

  private rebuild(): void {
    const theme = meshTuiTheme(this.color);
    const title = new TruncatedText(theme.accent("kxm dash"), 0, 0);
    const hub = this.snapshot.healthOk ? theme.success("● hub ok") : theme.error("✗ hub down");
    const ready = this.snapshot.readyOk ? theme.success("● ready") : theme.error("✗ not ready");
    const agents = visibleAgents(this.snapshot);
    const online = agents.filter((agent) => agent.online).length;
    const transport = this.snapshot.transport === "snapshot"
      ? "snapshot"
      : this.snapshot.metadataMode === "ops"
        ? "live ops"
        : this.snapshot.metadataMode === "legacy"
          ? "presence/local"
          : "live";
    const updated = this.snapshot.fetchedAt.slice(11, 19);
    const status = new TruncatedText(
      `${hub}  ${ready}  ${transport}  ${online}/${agents.length} online  ${theme.dim(`updated ${updated} UTC · ${this.snapshot.serverUrl}`)}`,
      0,
      0,
    );
    const header = new Box(1, 0, theme.headerBg);
    header.addChild(new HStack([
      { component: title, basis: 16, shrink: 1, minSize: 10 },
      { component: status, grow: 1, shrink: 1, minSize: 20 },
    ], { gap: 2 }));

    const tabs = new Box(1, 0, theme.panelBg);
    tabs.addChild(new TruncatedText(renderTabBar(this.snapshot, this.view, theme), 0, 0));

    this.fillPane(this.listContent, listLines(this.snapshot, this.view, theme), "Nothing here yet", theme);
    this.fillPane(this.detailContent, detailLines(this.snapshot, this.view, theme), "Select an item", theme);

    const listTitle = this.view.pane === "list" ? theme.accent("list") : theme.dim("list");
    const detailTitle = this.view.pane === "detail" ? theme.accent("detail") : theme.dim("detail");
    const listPane = new Box(1, 0, theme.panelBg);
    listPane.addChild(new Text(listTitle, 0, 0));
    listPane.addChild(this.listScroll);
    const detailPane = new Box(1, 0, theme.panelBg);
    detailPane.addChild(new Text(detailTitle, 0, 0));
    detailPane.addChild(this.detailScroll);

    const split = tabSplits(this.view.tab);
    const body = this.view.help
      ? (() => {
        const help = new Box(1, 0, theme.panelBg);
        help.addChild(new Text(`${theme.accent("kxm dash")}\n1–7 or Tab/[ ] switch tabs · ←→ list/detail · ↑↓ select · PgUp/PgDn scroll · h help · q quit\nAccess Control Plane: [a] approve · [r] reject · [d] degrade · [s] signal · [c] cancel\nAgents, Tasks, Workflows, Plans, Inbox, Procs, Spend. Split pane on wide terminals. No message bodies.`, 0, 0));
        return help;
      })()
      : split
        ? new HStack([
          { component: listPane, basis: 44, shrink: 1, minSize: 28, visible: ({ width }) => width >= 76 || this.view.pane === "list" },
          { component: detailPane, grow: 1, shrink: 1, minSize: 28, visible: ({ width }) => width >= 76 || this.view.pane === "detail" },
        ], { gap: 1 })
        : listPane;

    const error = this.snapshot.error ? `  ${theme.error(`ERROR ${this.snapshot.error}`)}` : "";
    const feed = this.snapshot.metadataMode === "legacy" ? "presence + local" : "live";
    const actionNotice = this.view.statusMessage ? `  ${theme.accent(this.view.statusMessage)}` : "";
    const footer = new TruncatedText(
      `${theme.dim(`tab ${MESH_TUI_TAB_LABELS[this.view.tab]} · ${this.view.pane} · 1–7 tabs · h help · a/r/d/s/c · q quit · ${feed}`)}${actionNotice}${error}`,
      1,
      0,
    );

    this.root.clear();
    this.root.addChild(header, { basis: "auto", shrink: 0 });
    this.root.addChild(tabs, { basis: "auto", shrink: 0 });
    this.root.addChild(body, { basis: "auto", grow: 1, shrink: 1, minSize: 1 });
    this.root.addChild(footer, { basis: "auto", shrink: 0 });
  }

  handleInput(data: string): void {
    const viewport = this.activeScroll().viewportHeight;
    const page = viewport > 3 ? viewport - 2 : 10;
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
      this.activeScroll().scrollBy(-page);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
      this.activeScroll().scrollBy(page);
      this.requestRender();
      return;
    }
    const next = applyMeshTuiKey(this.view, data, tabItemCount(this.snapshot, this.view.tab));
    if (next === "quit") {
      this.onQuit();
      return;
    }
    if (next !== this.view) {
      this.view = next;
      if (next.lastAction && this.onAction) {
        void this.onAction(next.lastAction, this.snapshot, next);
      }
      this.rebuild();
      this.requestRender();
    }
  }

  invalidate(): void {
    this.root.invalidate();
  }

  render(width: number): string[] {
    return this.root.render(width);
  }
}

export function renderMeshTui(snapshot: MeshTuiSnapshot, view: MeshTuiView = defaultMeshTuiView(), width = 120): string {
  const dashboard = new KxmDashboard(snapshot, view, false, () => undefined, () => undefined);
  return `${dashboard.render(width).map(stripTerminalSequences).join("\n")}\n`;
}

async function readJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function waitForReconnect(signal: AbortSignal, milliseconds = 1_000): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    timer.unref();
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function runMeshTui(input: {
  serverUrl: string;
  dataPath: string;
  stateDir: string;
  project: string;
  authToken?: string;
  fetchImpl: typeof fetch;
  stdout: (text: string) => void;
  stdin?: NodeJS.ReadStream;
  isTty?: boolean;
  now?: () => Date;
  abort?: AbortSignal;
  terminal?: Terminal;
  reconnectMs?: number;
  screen?: MeshTuiPanel;
  env?: Record<string, string | undefined>;
}): Promise<number> {
  const base = input.serverUrl.replace(/\/$/, "");
  const headers = (identity?: { id: string; key: string }): Record<string, string> => ({
    "content-type": "application/json",
    ...(input.authToken ? { authorization: `Bearer ${input.authToken}` } : {}),
    ...(identity ? { "x-kxm-agent-id": identity.id, "x-kxm-agent-key": identity.key } : {}),
  });
  const tty = input.isTty ?? Boolean(input.stdin?.isTTY && process.stdout.isTTY);
  let identity: { id: string; key: string } | undefined;
  let useOpsStream = true;
  let interactive: { tui: TUI; dashboard: KxmDashboard } | undefined;
  const name = `tui-${process.pid}`;
  const view = defaultMeshTuiView(input.screen);

  const paint = (snapshot: MeshTuiSnapshot) => {
    if (interactive) {
      interactive.dashboard.update(snapshot);
      return;
    }
    input.stdout(renderMeshTui(snapshot, view));
  };

  const snapshotFromHub = async (transport: "sse" | "snapshot", extra?: Partial<MeshTuiSnapshot>): Promise<MeshTuiSnapshot> => {
    const fetchedAt = (input.now?.() ?? new Date()).toISOString();
    let healthOk = false;
    let readyOk = false;
    let storage: string | undefined;
    let onlineCount = 0;
    let error: string | undefined;
    try {
      const health = await input.fetchImpl(`${base}/health`);
      const body = await readJson<{ ok?: boolean; agents?: number }>(health);
      healthOk = health.ok && body.ok === true;
      onlineCount = Number.isInteger(body.agents) ? body.agents as number : 0;
    } catch {
      error = "hub_unreachable";
    }
    try {
      const ready = await input.fetchImpl(`${base}/ready`);
      const body = await readJson<{ ok?: boolean; storage?: string }>(ready);
      readyOk = ready.ok && body.ok === true;
      storage = body.storage;
    } catch {
      error = error ?? "hub_unreachable";
    }
    let local = loadLocalMeshSnapshot(input.dataPath, input.stateDir, { env: input.env ?? process.env });
    if (useOpsStream) {
      try {
        const ops = await input.fetchImpl(`${base}/v1/ops/snapshot?project=${encodeURIComponent(input.project)}`, {
          headers: headers(),
        });
        if (ops.ok) {
          const body = await readJson<{
            agents: AgentRecord[];
            openMessages: MeshTuiSnapshot["openMessages"];
            openMessageTotal: number;
            runs: MeshTuiSnapshot["runs"];
            runTotal: number;
            plans?: MeshTuiPlan[];
          }>(ops);
          local = {
            ...local,
            agents: body.agents,
            openMessages: body.openMessages,
            openMessageTotal: body.openMessageTotal,
            runs: body.runs,
            runTotal: body.runTotal,
            plans: body.plans ?? local.plans,
          };
        } else if (ops.status === 401 || ops.status === 403 || ops.status === 404 || ops.status === 503) {
          useOpsStream = false;
        } else {
          error = error ?? `ops_snapshot_http_${ops.status}`;
        }
      } catch {
        error = error ?? "ops_snapshot_unreachable";
      }
    }
    if (!useOpsStream && identity) {
      try {
        const listed = await input.fetchImpl(`${base}/v1/agents`, { headers: headers(identity) });
        if (listed.ok) {
          const body = await readJson<{ agents: AgentRecord[] }>(listed);
          const byId = new Map(local.agents.map((agent) => [agent.id, agent]));
          for (const agent of body.agents) byId.set(agent.id, agent);
          local = {
            ...local,
            agents: [...byId.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
          };
        }
      } catch {
        error = error ?? "agents_unreachable";
      }
    }
    return {
      serverUrl: input.serverUrl,
      healthOk,
      readyOk,
      ...(storage ? { storage } : {}),
      onlineCount,
      transport,
      metadataMode: useOpsStream ? "ops" : "legacy",
      fetchedAt,
      ...(error ? { error } : {}),
      ...local,
      ...extra,
    };
  };

  const registerObserver = async () => {
    if (identity) return;
    const registration = await input.fetchImpl(`${base}/v1/agents/register`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        name,
        purpose: "Read-only mesh observer TUI",
        project: input.project,
        model: "tui",
      }),
    });
    if (!registration.ok) throw new Error(`observer registration failed with HTTP ${registration.status}`);
    const registered = await readJson<{ agent: AgentRecord; agentKey: string }>(registration);
    identity = { id: registered.agent.id, key: registered.agentKey };
  };

  const unregister = async () => {
    if (!identity) return;
    const registeredIdentity = identity;
    identity = undefined;
    await input.fetchImpl(`${base}/v1/agents/${encodeURIComponent(registeredIdentity.id)}`, {
      method: "DELETE",
      headers: headers(registeredIdentity),
    }).catch(() => undefined);
  };

  try {
    let snapshot = await snapshotFromHub("sse");
    if (!useOpsStream) {
      try {
        await registerObserver();
      } catch (error) {
        const failed = await snapshotFromHub("snapshot", {
          error: error instanceof Error ? error.message : "observer registration failed",
        });
        paint(failed);
        return 1;
      }
      snapshot = await snapshotFromHub("sse");
    }
    if (!tty) {
      paint(snapshot);
      return snapshot.healthOk ? 0 : 1;
    }

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    input.abort?.addEventListener("abort", onAbort);
    if (input.abort?.aborted) abort.abort();

    const terminal = input.terminal ?? new ProcessTerminal();
    const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
    const onAction = async (action: DashboardAction, currentSnapshot: MeshTuiSnapshot, currentView: MeshTuiView) => {
      let targetId: string | undefined;
      if (currentView.tab === "workflows" || currentView.tab === "tasks") {
        const runs = currentView.tab === "tasks"
          ? currentSnapshot.runs.filter((r) => r.status === "running" || r.status === "waiting")
          : currentSnapshot.runs;
        targetId = runs[currentView.selected]?.id;
      } else if (currentView.tab === "inbox") {
        targetId = currentSnapshot.openMessages[currentView.selected]?.id;
      }
      if (!targetId) return;

      try {
        if (action.action === "cancel") {
          await input.fetchImpl(`${base}/v1/runs/${encodeURIComponent(targetId)}/cancel?project=${encodeURIComponent(input.project)}`, {
            method: "POST",
            headers: headers(),
            signal: abort.signal,
          });
        } else if (action.action === "approve" || action.action === "signal") {
          await input.fetchImpl(`${base}/v1/runs/${encodeURIComponent(targetId)}/signal?project=${encodeURIComponent(input.project)}`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({ signalKey: "operator-approval", status: "passed", summary: "Interactive operator approval from kxm dash" }),
            signal: abort.signal,
          });
        } else if (action.action === "reject") {
          await input.fetchImpl(`${base}/v1/runs/${encodeURIComponent(targetId)}/signal?project=${encodeURIComponent(input.project)}`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({ signalKey: "operator-approval", status: "failed", summary: "Rejected by operator in kxm dash" }),
            signal: abort.signal,
          });
        } else if (action.action === "degrade") {
          await input.fetchImpl(`${base}/v1/runs/${encodeURIComponent(targetId)}/signal?project=${encodeURIComponent(input.project)}`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({ signalKey: "operator-degrade", status: "degraded", summary: "Degraded to operator worktree from kxm dash" }),
            signal: abort.signal,
          });
          const repoRoot = process.cwd();
          const degradeRes = spawnDegradeWorktree(repoRoot, targetId, {
            description: "operator-degrade",
          });
          if (dashboard) {
            if (degradeRes.ok) {
              dashboard.setStatusMessage(
                `[DEGRADE] Worktree: ${degradeRes.worktreePath} (cd command copied to clipboard)`,
              );
            } else {
              dashboard.setStatusMessage(
                `[DEGRADE] Signal sent, worktree failed: ${degradeRes.error}`,
              );
            }
          }
        }
      } catch {
        // fail-soft on dashboard network errors during key press
      }
    };

    const dashboard = new KxmDashboard(
      snapshot,
      view,
      process.env.NO_COLOR === undefined,
      () => tui.requestRender(),
      () => abort.abort(),
      () => terminal.columns,
      onAction,
    );
    interactive = { tui, dashboard };
    tui.setLayoutRoot(dashboard.root);
    tui.setFocus(dashboard);
    tui.start();

    const applyPresence = (agent: AgentRecord) => {
      const byId = new Map(snapshot.agents.map((row) => [row.id, row]));
      byId.set(agent.id, agent);
      const { error: _staleError, ...healthySnapshot } = snapshot;
      snapshot = {
        ...healthySnapshot,
        transport: "sse",
        fetchedAt: (input.now?.() ?? new Date()).toISOString(),
        agents: [...byId.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
        onlineCount: [...byId.values()].filter((row) => row.online).length,
      };
    };

    try {
      while (!abort.signal.aborted) {
        let events: Response;
        try {
          if (!useOpsStream && !identity) throw new Error("legacy SSE requires an observer identity");
          const eventUrl = useOpsStream
            ? `${base}/v1/ops/events?project=${encodeURIComponent(input.project)}`
            : `${base}/v1/events?agentId=${encodeURIComponent(identity!.id)}&presenceOnly=true`;
          events = await input.fetchImpl(eventUrl, {
            headers: { ...headers(useOpsStream ? undefined : identity!), accept: "text/event-stream" },
            signal: abort.signal,
          });
        } catch (error) {
          if (abort.signal.aborted) break;
          snapshot = await snapshotFromHub("snapshot", { error: error instanceof Error ? `sse_${error.message}` : "sse_unreachable" });
          paint(snapshot);
          await waitForReconnect(abort.signal, input.reconnectMs);
          continue;
        }
        if (useOpsStream && (events.status === 401 || events.status === 403 || events.status === 404 || events.status === 503)) {
          useOpsStream = false;
          try {
            await registerObserver();
          } catch {
            snapshot = await snapshotFromHub("snapshot", {
              error: "live metadata access was lost and legacy observer registration failed",
            });
            paint(snapshot);
            break;
          }
          snapshot = await snapshotFromHub("snapshot", {
            error: "admin metadata stream unavailable; using legacy presence and local snapshots",
          });
          paint(snapshot);
          continue;
        }
        if (!useOpsStream && events.ok && events.headers.get("x-kxm-events-mode") !== "presence") {
          await events.body?.cancel();
          snapshot = await snapshotFromHub("snapshot", {
            error: "hub does not support metadata-only presence SSE; live fallback disabled",
          });
          paint(snapshot);
          break;
        }
        if (!events.ok || !events.body) {
          snapshot = await snapshotFromHub("snapshot", { error: `sse_http_${events.status}` });
          paint(snapshot);
          await waitForReconnect(abort.signal, input.reconnectMs);
          continue;
        }
        if (snapshot.error || snapshot.transport !== "sse") {
          const { error: _staleError, ...healthySnapshot } = snapshot;
          snapshot = {
            ...healthySnapshot,
            transport: "sse",
            fetchedAt: (input.now?.() ?? new Date()).toISOString(),
          };
          paint(snapshot);
        }
        const reader = events.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        while (!abort.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const parts = pending.split("\n\n");
          pending = parts.pop() ?? "";
          for (const part of parts) {
            if (part.startsWith(":")) continue;
            const lines = part.split("\n");
            const eventLine = lines.find((line) => line.startsWith("event:"));
            if (!useOpsStream && eventLine?.slice(6).trim() !== "presence") continue;
            const dataLine = lines.find((line) => line.startsWith("data:"));
            if (!dataLine) continue;
            let parsed: { type?: "ops" | "presence"; agent?: AgentRecord; project?: string; topic?: string; at?: string };
            try {
              parsed = JSON.parse(dataLine.slice(5).trim()) as typeof parsed;
            } catch {
              continue;
            }
            if ("type" in parsed && parsed.type === "ops") {
              snapshot = await snapshotFromHub("sse");
              paint(snapshot);
            } else if ("type" in parsed && parsed.type === "presence" && parsed.agent) {
              applyPresence(parsed.agent);
              const local = loadLocalMeshSnapshot(input.dataPath, input.stateDir, { env: input.env ?? process.env });
              snapshot = {
                ...snapshot,
                openMessages: local.openMessages,
                openMessageTotal: local.openMessageTotal,
                runs: local.runs,
                runTotal: local.runTotal,
                pids: local.pids,
                spend: local.spend,
                source: local.source,
              };
              paint(snapshot);
            }
          }
        }
        if (!abort.signal.aborted) {
          snapshot = await snapshotFromHub("snapshot", { error: "sse_reconnecting" });
          paint(snapshot);
          await waitForReconnect(abort.signal, input.reconnectMs);
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      input.abort?.removeEventListener("abort", onAbort);
      tui.stop();
      interactive = undefined;
    }
    return 0;
  } catch (error) {
    const failed = await snapshotFromHub("snapshot", {
      error: error instanceof Error ? error.message : "tui_failed",
    });
    paint(failed);
    return 1;
  } finally {
    await unregister();
  }
}

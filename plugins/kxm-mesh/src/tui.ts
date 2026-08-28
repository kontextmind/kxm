import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  Box,
  Container,
  HStack,
  Key,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  SettingsList,
  stripTerminalSequences,
  Text,
  TruncatedText,
  TuiAltScreen,
  VStack,
  type Component,
  type SettingItem,
  type SettingsListTheme,
  type Terminal,
  type TUI,
} from "@earendil-works/pi-tui";
import type { AgentRecord, MessageRecord } from "./protocol.ts";
import type { WorkflowRun } from "./workflow.ts";

export interface MeshTuiPidClaim {
  file: string;
  role?: string;
  pid?: number;
  live: boolean;
}

export const MESH_TUI_PANELS = ["agents", "messages", "runs", "pids"] as const;
export type MeshTuiPanel = typeof MESH_TUI_PANELS[number];

export interface MeshTuiView {
  focus: MeshTuiPanel;
  open: Record<MeshTuiPanel, boolean>;
  help: boolean;
}

export function defaultMeshTuiView(): MeshTuiView {
  return {
    focus: "agents",
    open: { agents: true, messages: true, runs: false, pids: false },
    help: false,
  };
}

export function applyMeshTuiKey(view: MeshTuiView, key: string): MeshTuiView | "quit" {
  if (matchesKey(key, "q") || matchesKey(key, Key.ctrl("c"))) return "quit";
  if (matchesKey(key, Key.escape)) return view.help ? { ...view, help: false } : "quit";
  if (matchesKey(key, "h") || matchesKey(key, "?")) return { ...view, help: !view.help };
  const byNumber: Record<string, MeshTuiPanel> = { "1": "agents", "2": "messages", "3": "runs", "4": "pids" };
  const panel = byNumber[key];
  if (panel) {
    return { ...view, focus: panel, help: false, open: { ...view.open, [panel]: true } };
  }
  if (matchesKey(key, Key.space) || matchesKey(key, Key.enter)) {
    return { ...view, help: false, open: { ...view.open, [view.focus]: !view.open[view.focus] } };
  }
  const index = MESH_TUI_PANELS.indexOf(view.focus);
  if (matchesKey(key, Key.up)) {
    return { ...view, help: false, focus: MESH_TUI_PANELS[(index - 1 + MESH_TUI_PANELS.length) % MESH_TUI_PANELS.length]! };
  }
  if (matchesKey(key, Key.down) || matchesKey(key, Key.tab)) {
    return { ...view, help: false, focus: MESH_TUI_PANELS[(index + 1) % MESH_TUI_PANELS.length]! };
  }
  return view;
}

export interface MeshTuiSnapshot {
  serverUrl: string;
  healthOk: boolean;
  readyOk: boolean;
  storage?: string;
  onlineCount: number;
  transport: "sse" | "snapshot";
  metadataMode?: "ops" | "legacy";
  agents: AgentRecord[];
  openMessages: Array<Pick<MessageRecord, "id" | "status" | "fromName" | "toName" | "delivery" | "createdAt" | "correlationId">>;
  openMessageTotal: number;
  runs: Array<Pick<WorkflowRun, "id" | "status" | "definitionId" | "project">>;
  runTotal: number;
  pids: MeshTuiPidClaim[];
  error?: string;
  fetchedAt: string;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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

function countRows(database: DatabaseSync, table: "messages" | "workflow_runs", where = ""): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`).get() as { count?: number | bigint } | undefined;
  return Number(row?.count ?? 0);
}

function readOpenMessageMetadata(database: DatabaseSync): MeshTuiSnapshot["openMessages"] {
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
  const messages: MeshTuiSnapshot["openMessages"] = [];
  for (const row of rows) {
    if (
      typeof row.id !== "string" ||
      (row.status !== "queued" && row.status !== "delivered") ||
      typeof row.fromName !== "string" ||
      typeof row.toName !== "string" ||
      (row.delivery !== "steer" && row.delivery !== "followUp" && row.delivery !== "nextTurn") ||
      typeof row.createdAt !== "string"
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

export function loadLocalMeshSnapshot(dataPath: string, stateDir: string): Pick<MeshTuiSnapshot, "agents" | "openMessages" | "openMessageTotal" | "runs" | "runTotal" | "pids"> {
  let agents: AgentRecord[] = [];
  let openMessages: MeshTuiSnapshot["openMessages"] = [];
  let openMessageTotal = 0;
  let runs: WorkflowRun[] = [];
  let runTotal = 0;
  if (existsSync(dataPath)) {
    const database = new DatabaseSync(dataPath, { readOnly: true });
    try {
      agents = readJsonRows<AgentRecord>(database, "SELECT record FROM agents");
      openMessages = readOpenMessageMetadata(database);
      openMessageTotal = countRows(database, "messages", " WHERE json_extract(record, '$.status') IN ('queued', 'delivered')");
      runs = readJsonRows<WorkflowRun>(database, "SELECT record FROM workflow_runs ORDER BY rowid DESC LIMIT 8");
      runTotal = countRows(database, "workflow_runs");
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
    runs: runs.map((run) => ({
      id: run.id,
      status: run.status,
      definitionId: run.definitionId,
      project: run.project,
    })),
    runTotal,
    pids,
  };
}

type MeshTuiStyle = (text: string) => string;

interface MeshTuiTheme {
  accent: MeshTuiStyle;
  dim: MeshTuiStyle;
  error: MeshTuiStyle;
  success: MeshTuiStyle;
  warning: MeshTuiStyle;
  headerBg: MeshTuiStyle;
  panelBg: MeshTuiStyle;
}

function meshTuiTheme(color: boolean): MeshTuiTheme {
  const ansi = (code: string): MeshTuiStyle => color ? (text) => `\u001b[${code}m${text}\u001b[0m` : (text) => text;
  return {
    accent: ansi("1;36"),
    dim: ansi("2"),
    error: ansi("1;31"),
    success: ansi("1;32"),
    warning: ansi("1;33"),
    headerBg: ansi("1;97;44"),
    panelBg: ansi("48;5;236"),
  };
}

function settingsTheme(theme: MeshTuiTheme): SettingsListTheme {
  return {
    label: (text, selected) => selected ? theme.accent(text) : text,
    value: (text, selected) => selected ? theme.warning(text) : theme.dim(text),
    description: theme.dim,
    cursor: theme.accent("› "),
    hint: theme.dim,
  };
}

function visibleAgents(snapshot: MeshTuiSnapshot): AgentRecord[] {
  return snapshot.agents.filter((agent) => agent.model !== "kxm-tui");
}

function panelMetric(snapshot: MeshTuiSnapshot, panel: MeshTuiPanel): string {
  if (panel === "agents") {
    const agents = visibleAgents(snapshot);
    return `${agents.filter((agent) => agent.online).length}/${agents.length}`;
  }
  if (panel === "messages") return snapshot.openMessages.length === snapshot.openMessageTotal ? String(snapshot.openMessageTotal) : `${snapshot.openMessages.length}/${snapshot.openMessageTotal}`;
  if (panel === "runs") return snapshot.runs.length === snapshot.runTotal ? String(snapshot.runTotal) : `${snapshot.runs.length}/${snapshot.runTotal}`;
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
  if (panel === "messages") {
    return snapshot.openMessages.length === 0 ? [] : [
      theme.dim(`${pad("state", 9)} ${pad("from", 12)} ${pad("to", 12)} ${pad("mode", 8)} ${pad("age", 4)} id`),
      ...snapshot.openMessages.map((message) => (
        `${theme.warning(pad(message.status, 9))} ${pad(message.fromName, 12)} ${pad(message.toName, 12)} ${pad(message.delivery, 8)} ${pad(age(message.createdAt, now), 4)} ${message.id}`
      )),
      ...(snapshot.openMessageTotal > snapshot.openMessages.length ? [theme.dim(`… +${snapshot.openMessageTotal - snapshot.openMessages.length} more`)] : []),
    ];
  }
  if (panel === "runs") {
    return [
      ...snapshot.runs.map((run) => `${pad(run.status, 10)} ${pad(run.definitionId, 20)} ${run.project}  ${run.id}`),
      ...(snapshot.runTotal > snapshot.runs.length ? [theme.dim(`… +${snapshot.runTotal - snapshot.runs.length} more`)] : []),
    ];
  }
  return snapshot.pids.map((claim) => `${claim.live ? theme.success("live") : theme.error("dead")}  ${pad(claim.role ?? "-", 8)} pid=${claim.pid ?? "-"}  ${claim.file}`);
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

export class MeshDashboard implements Component {
  readonly root = new VStack([], { gap: 1 });
  private readonly content = new VStack([], { gap: 1 });
  private readonly scrollView = new ScrollView(this.content, { primary: true, overscroll: "contain", scrollbar: "auto" });
  private settings!: SettingsList;
  private snapshot: MeshTuiSnapshot;
  private view: MeshTuiView;
  private readonly color: boolean;
  private readonly requestRender: () => void;
  private readonly onQuit: () => void;
  private readonly getWidth: () => number;

  constructor(
    snapshot: MeshTuiSnapshot,
    view: MeshTuiView,
    color: boolean,
    requestRender: () => void,
    onQuit: () => void,
    getWidth: () => number = () => 120,
  ) {
    this.snapshot = snapshot;
    this.view = view;
    this.color = color;
    this.requestRender = requestRender;
    this.onQuit = onQuit;
    this.getWidth = getWidth;
    this.rebuild();
  }

  update(snapshot: MeshTuiSnapshot): void {
    this.snapshot = snapshot;
    this.rebuild();
    this.requestRender();
  }

  private toggle(panel: MeshTuiPanel, visible?: boolean): void {
    this.view = {
      ...this.view,
      focus: panel,
      help: false,
      open: { ...this.view.open, [panel]: visible ?? !this.view.open[panel] },
    };
    this.rebuild();
    this.requestRender();
  }

  private rebuild(): void {
    const theme = meshTuiTheme(this.color);
    const title = new TruncatedText(theme.accent("KXM MESH"), 0, 0);
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

    const items: SettingItem[] = [
      { id: "agents", label: `Agents (${panelMetric(this.snapshot, "agents")})`, description: "Online / known; model state", currentValue: this.view.open.agents ? "show" : "hide", values: ["show", "hide"] },
      { id: "messages", label: `Messages (${panelMetric(this.snapshot, "messages")})`, description: "Metadata only — never bodies", currentValue: this.view.open.messages ? "show" : "hide", values: ["show", "hide"] },
      { id: "runs", label: `Runs (${panelMetric(this.snapshot, "runs")})`, description: "Durable workflow state", currentValue: this.view.open.runs ? "show" : "hide", values: ["show", "hide"] },
      { id: "pids", label: `PIDs (${panelMetric(this.snapshot, "pids")})`, description: "Live / claimed processes", currentValue: this.view.open.pids ? "show" : "hide", values: ["show", "hide"] },
    ];
    this.settings = new SettingsList(
      items,
      items.length + 2,
      settingsTheme(theme),
      (id, value) => this.toggle(id as MeshTuiPanel, value === "show"),
      this.onQuit,
    );
    this.settings.selectItem(this.view.focus);
    const sidebar = new Box(1, 0);
    sidebar.addChild(new Text(theme.accent("PANELS"), 0, 0));
    sidebar.addChild(this.settings);

    const content = this.content;
    content.clear();
    if (this.view.help) {
      const help = new Box(1, 0, theme.panelBg);
      help.addChild(new Text(`${theme.accent("HELP")}\n↑↓ select panels · enter/space toggle · 1–4 reveal · PgUp/PgDn or Ctrl-U/D scroll · h hide help · q quit\nOn narrow screens ↑↓ scrolls content. Esc closes help before quitting.\nAuthorized ops SSE keeps agent, message, and workflow metadata live. Message bodies are never loaded or rendered.`, 0, 0));
      content.addChild(help);
    }
    for (const panel of MESH_TUI_PANELS) {
      if (!this.view.open[panel]) continue;
      const title = panel === "pids" ? "Local processes" : panel[0]!.toUpperCase() + panel.slice(1);
      const emptyText = panel === "agents" ? "No mesh agents" : panel === "messages" ? "No open messages" : panel === "runs" ? "No workflow runs" : "No local pid claims";
      content.addChild(dataPanel(title, panelMetric(this.snapshot, panel), panelRows(this.snapshot, panel, theme), emptyText, theme));
    }
    if (!MESH_TUI_PANELS.some((panel) => this.view.open[panel])) {
      const empty = new Box(1, 1, theme.panelBg);
      empty.addChild(new Text(theme.dim("No panels visible. Choose one from the panel list or press 1–4."), 0, 0));
      content.addChild(empty);
    }
    const main = new HStack([
      { component: sidebar, basis: 28, shrink: 0, minSize: 28, visible: ({ width }) => width >= 76 },
      { component: this.scrollView, grow: 1, shrink: 1, minSize: 28 },
    ], { gap: 1 });
    const error = this.snapshot.error ? `  ${theme.error(`ERROR ${this.snapshot.error}`)}` : "";
    const feed = this.snapshot.metadataMode === "legacy" ? "presence + local snapshots" : "live metadata";
    const wideFooter = new TruncatedText(`${theme.dim(`↑↓ panels · enter/space toggle · PgUp/PgDn scroll · 1–4 reveal · h help · q quit · ${feed}`)}${error}`, 1, 0);
    const narrowFooter = new TruncatedText(`${theme.dim(`1–4 reveal · ↑↓ scroll · h help · q quit · ${feed}`)}${error}`, 1, 0);
    const compactPanels = new TruncatedText(
      MESH_TUI_PANELS.map((panel, index) => `${index + 1} ${panel}:${this.view.open[panel] ? "on" : "off"}`).join("  "),
      1,
      0,
    );

    this.root.clear();
    this.root.addChild(header, { basis: "auto", shrink: 0 });
    this.root.addChild(compactPanels, { basis: "auto", shrink: 0, visible: ({ width }) => width < 76 });
    this.root.addChild(main, { basis: "auto", grow: 1, shrink: 1, minSize: 1 });
    this.root.addChild(wideFooter, { basis: "auto", shrink: 0, visible: ({ width }) => width >= 76 });
    this.root.addChild(narrowFooter, { basis: "auto", shrink: 0, visible: ({ width }) => width < 76 });
  }

  handleInput(data: string): void {
    const viewport = this.scrollView.viewportHeight;
    const page = viewport > 3 ? viewport - 2 : 10;
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
      this.scrollView.scrollBy(-page);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
      this.scrollView.scrollBy(page);
      this.requestRender();
      return;
    }
    if (this.getWidth() < 76 && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) {
      this.scrollView.scrollBy(matchesKey(data, Key.up) ? -1 : 1);
      this.requestRender();
      return;
    }
    const next = applyMeshTuiKey(this.view, data);
    if (next === "quit") {
      this.onQuit();
      return;
    }
    if (next !== this.view) {
      this.view = next;
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
  const dashboard = new MeshDashboard(snapshot, view, false, () => undefined, () => undefined);
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
}): Promise<number> {
  const base = input.serverUrl.replace(/\/$/, "");
  const headers = (identity?: { id: string; key: string }): Record<string, string> => ({
    "content-type": "application/json",
    ...(input.authToken ? { authorization: `Bearer ${input.authToken}` } : {}),
    ...(identity ? { "x-mesh-agent-id": identity.id, "x-mesh-agent-key": identity.key } : {}),
  });
  const tty = input.isTty ?? Boolean(input.stdin?.isTTY && process.stdout.isTTY);
  let identity: { id: string; key: string } | undefined;
  let useOpsStream = true;
  let interactive: { tui: TUI; dashboard: MeshDashboard } | undefined;
  const name = `kxm-tui-${process.pid}`;
  const view = defaultMeshTuiView();

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
    let local = loadLocalMeshSnapshot(input.dataPath, input.stateDir);
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
          }>(ops);
          local = {
            ...local,
            agents: body.agents,
            openMessages: body.openMessages,
            openMessageTotal: body.openMessageTotal,
            runs: body.runs,
            runTotal: body.runTotal,
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
        model: "kxm-tui",
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
    const dashboard = new MeshDashboard(
      snapshot,
      view,
      process.env.NO_COLOR === undefined,
      () => tui.requestRender(),
      () => abort.abort(),
      () => terminal.columns,
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
        if (!useOpsStream && events.ok && events.headers.get("x-mesh-events-mode") !== "presence") {
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
              const local = loadLocalMeshSnapshot(input.dataPath, input.stateDir);
              snapshot = {
                ...snapshot,
                openMessages: local.openMessages,
                openMessageTotal: local.openMessageTotal,
                runs: local.runs,
                runTotal: local.runTotal,
                pids: local.pids,
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

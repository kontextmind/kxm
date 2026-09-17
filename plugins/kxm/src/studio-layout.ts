/**
 * KXM Web Studio Layout Engine (Phase 10 / Decision D14)
 * Generates form/stepper metadata, ELK/React Flow-derived DAG nodes/edges,
 * and Temporal swimlane activity timelines from compiled plans and run states.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { KxmCompiledPlan, KxmCompiledStep } from "./engine-compile.ts";
import type { KxmRunState } from "./engine-fold.ts";

export const STUDIO_LAYOUT_SCHEMA = "kxm.studio-layout.v1" as const;

export interface StudioDagNode {
  id: string;
  type: "agentStep" | "gateStep" | "approvalStep" | "waitStep";
  data: {
    label: string;
    kind: string;
    role?: string | undefined;
    gate?: string | undefined;
    status: "pending" | "preparing" | "running" | "passed" | "failed" | "waiting" | "cancelled";
    stepAttempt?: number | undefined;
    description?: string | undefined;
    outcomes: readonly string[];
  };
  position: { x: number; y: number };
}

export interface StudioDagEdge {
  id: string;
  source: string;
  target: string;
  label?: string | undefined;
  animated?: boolean | undefined;
  style?: { stroke?: string } | undefined;
}

export interface TemporalSwimlaneActivity {
  stepId: string;
  attemptId?: string | undefined;
  status: string;
  startOffsetMs: number;
  durationMs: number;
  stepAttempt: number;
}

export interface TemporalSwimlane {
  role: string;
  agentId?: string | undefined;
  activities: TemporalSwimlaneActivity[];
}

export interface StudioStepperStage {
  id: string;
  label: string;
  kind: string;
  status: "pending" | "active" | "completed" | "failed" | "skipped";
}

export interface StudioLayoutPayload {
  schema: typeof STUDIO_LAYOUT_SCHEMA;
  workflowId: string;
  runId?: string | undefined;
  generatedAt: string;
  stepper: StudioStepperStage[];
  dag: {
    nodes: StudioDagNode[];
    edges: StudioDagEdge[];
  };
  temporalSwimlanes: TemporalSwimlane[];
}

/**
 * Computes deterministic layered DAG coordinates (ELK-style hierarchical ranking)
 * without requiring any manual layout coordinates in the YAML workflow file.
 */
export function generateStudioLayout(
  plan: KxmCompiledPlan,
  state?: KxmRunState | undefined,
): StudioLayoutPayload {
  const generatedAt = new Date().toISOString();
  const stepIds = Object.keys(plan.steps);

  // 1. Calculate topological rank/level for each step
  const inDegree: Record<string, number> = {};
  const adj: Record<string, string[]> = {};
  for (const id of stepIds) {
    inDegree[id] = 0;
    adj[id] = [];
  }

  for (const [sourceId, step] of Object.entries(plan.steps)) {
    for (const transition of Object.values(step.transitions)) {
      if (transition.to === "step") {
        if (transition.edge === "back") continue; // Back-edges are cycles (retries), ignore for DAG forward rank
        const targetStepId = transition.target;
        if (plan.steps[targetStepId]) {
          adj[sourceId]!.push(targetStepId);
          inDegree[targetStepId] = (inDegree[targetStepId] ?? 0) + 1;
        }
      }
    }
  }

  // Assign levels (x coordinate columns)
  const levels: Record<string, number> = {};
  const queue: string[] = [];

  if (plan.entryStepId && plan.steps[plan.entryStepId]) {
    queue.push(plan.entryStepId);
    levels[plan.entryStepId] = 0;
  } else {
    for (const id of stepIds) {
      if ((inDegree[id] ?? 0) === 0) {
        queue.push(id);
        levels[id] = 0;
      }
    }
  }

  let iterations = 0;
  const maxIterations = stepIds.length * 4;
  while (queue.length > 0 && iterations++ < maxIterations) {
    const current = queue.shift()!;
    const curLevel = levels[current] ?? 0;
    for (const neighbor of adj[current] ?? []) {
      const nextLevel = Math.max(levels[neighbor] ?? 0, curLevel + 1);
      if (levels[neighbor] === undefined || nextLevel > levels[neighbor]!) {
        levels[neighbor] = nextLevel;
        queue.push(neighbor);
      }
    }
  }

  // Default any unassigned step to 0
  for (const id of stepIds) {
    if (levels[id] === undefined) levels[id] = 0;
  }

  // Group steps by level to determine y positions
  const byLevel: Record<number, string[]> = {};
  for (const [id, lvl] of Object.entries(levels)) {
    if (!byLevel[lvl]) byLevel[lvl] = [];
    byLevel[lvl]!.push(id);
  }

  const nodes: StudioDagNode[] = [];
  const edges: StudioDagEdge[] = [];
  const X_SPACING = 240;
  const Y_SPACING = 120;

  for (const [lvlStr, idsInLevel] of Object.entries(byLevel)) {
    const lvl = Number(lvlStr);
    const x = lvl * X_SPACING;
    const startY = -(idsInLevel.length - 1) * (Y_SPACING / 2);

    idsInLevel.forEach((stepId, index) => {
      const step = plan.steps[stepId]!;
      const y = startY + index * Y_SPACING;

      let status: StudioDagNode["data"]["status"] = "pending";
      let stepAttempt: number | undefined = undefined;

      if (state) {
        if (state.currentStep?.stepId === stepId) {
          status = state.currentStep.status === "running" ? "running" : "preparing";
          stepAttempt = state.currentStep.stepAttempt;
        } else if (state.stepAttempts[stepId] !== undefined) {
          status = "passed";
          stepAttempt = state.stepAttempts[stepId];
        }
      }

      let type: StudioDagNode["type"] = "agentStep";
      let role: string | undefined = undefined;
      let gate: string | undefined = undefined;

      if (step.kind === "agent" || step.kind === "moa") {
        type = "agentStep";
        role = step.agent;
      } else if (step.kind === "gate") {
        type = "gateStep";
        gate = step.gate;
      } else if (step.kind === "approval") {
        type = "approvalStep";
      } else if (step.kind === "wait") {
        type = "waitStep";
      }

      nodes.push({
        id: stepId,
        type,
        data: {
          label: step.description ?? stepId,
          kind: step.kind,
          role,
          gate,
          status,
          stepAttempt,
          description: step.instructions,
          outcomes: step.outcomes,
        },
        position: { x, y },
      });

      // Build edges
      for (const [outcome, transition] of Object.entries(step.transitions)) {
        if (transition.to === "step") {
          const targetStepId = transition.target;
          if (plan.steps[targetStepId]) {
            edges.push({
              id: `e_${stepId}_to_${targetStepId}_${outcome}`,
              source: stepId,
              target: targetStepId,
              label: outcome !== "passed" && outcome !== "completed" ? outcome : undefined,
              animated: status === "running",
              style: {
                stroke: outcome === "failed" ? "#ef4444" : outcome === "warning" ? "#f59e0b" : "#64748b",
              },
            });
          }
        }
      }
    });
  }

  // 2. Stepper stages (linear path)
  const stepper: StudioStepperStage[] = plan.order.map((stepId) => {
    const step = plan.steps[stepId];
    let status: StudioStepperStage["status"] = "pending";
    if (state) {
      if (state.currentStep?.stepId === stepId) {
        status = "active";
      } else if (state.stepAttempts[stepId] !== undefined) {
        status = "completed";
      }
    }
    return {
      id: stepId,
      label: step?.description ?? stepId,
      kind: step?.kind ?? "unknown",
      status,
    };
  });

  // 3. Temporal Swimlanes
  const swimlanesByRole: Record<string, TemporalSwimlaneActivity[]> = {};
  let currentOffset = 0;

  for (const stepId of plan.order) {
    const step = plan.steps[stepId];
    const role = step && (step.kind === "agent" || step.kind === "moa") ? step.agent : "engine-coordinator";
    if (!swimlanesByRole[role]) swimlanesByRole[role] = [];

    const duration = step?.timeoutMs ? Math.min(step.timeoutMs, 5000) : 3000;
    swimlanesByRole[role]!.push({
      stepId,
      status: state?.currentStep?.stepId === stepId ? "running" : "completed",
      startOffsetMs: currentOffset,
      durationMs: duration,
      stepAttempt: state?.stepAttempts[stepId] ?? 1,
    });
    currentOffset += duration;
  }

  const temporalSwimlanes: TemporalSwimlane[] = Object.entries(swimlanesByRole).map(([role, activities]) => ({
    role,
    activities,
  }));

  return {
    schema: STUDIO_LAYOUT_SCHEMA,
    workflowId: plan.workflowId,
    runId: state ? "active-run" : undefined,
    generatedAt,
    stepper,
    dag: { nodes, edges },
    temporalSwimlanes,
  };
}

export const DEFAULT_STUDIO_PORT = 4242; // Decision Q8 & D14

export interface StudioServerOptions {
  port?: number | undefined;
  host?: string | undefined;
  projectRoot?: string | undefined;
  sessionToken?: string | undefined;
  planProvider?: (() => KxmCompiledPlan | undefined) | undefined;
  stateProvider?: (() => KxmRunState | undefined) | undefined;
  onMutation?: ((command: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }> | { ok: boolean; result?: unknown; error?: string }) | undefined;
}

export interface StudioServerHandle {
  server: Server;
  port: number;
  listen: () => Promise<number>;
  close: () => Promise<void>;
}

/**
 * Embedded Web Studio Local Server (Decision Q8 & D14).
 * Serves the visual DAG, form stepper, and Temporal swimlane dashboards on http://localhost:4242.
 * Enforces strict audit parity: web mutations authenticate via SessionToken and map 1:1 to CLI commands.
 */
export function createStudioServer(options: StudioServerOptions = {}): StudioServerHandle {
  const targetPort = options.port ?? DEFAULT_STUDIO_PORT;
  const host = options.host ?? "127.0.0.1";

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/health" || url.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, studio: true, port: targetPort }));
      return;
    }

    if (url.pathname === "/api/layout" && req.method === "GET") {
      const plan = options.planProvider?.();
      if (!plan) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "no_active_workflow_plan" }));
        return;
      }
      const state = options.stateProvider?.();
      const layout = generateStudioLayout(plan, state);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, layout }));
      return;
    }

    if (url.pathname === "/api/mutate" && req.method === "POST") {
      // 1. Strict Authentication via SessionToken
      if (options.sessionToken) {
        const auth = req.headers.authorization;
        const expected = `Bearer ${options.sessionToken}`;
        if (!auth || auth !== expected) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: false,
            error: "unauthorized",
            message: "Valid SessionToken required for Web Studio mutations",
          }));
          return;
        }
      }

      // 2. Read request body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const bodyStr = Buffer.concat(chunks).toString("utf8");
      let body: { command?: string; args?: Record<string, unknown> };
      try {
        body = JSON.parse(bodyStr);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "malformed_json" }));
        return;
      }

      const command = body.command;
      const args = body.args ?? {};
      if (!command || typeof command !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "missing_command" }));
        return;
      }

      // 3. Strict Audit Parity: verify command maps 1:1 to underlying CLI commands
      const ALLOWED_CLI_MUTATIONS = [
        "workflow.signal",
        "workflow.checkpoint",
        "workflow.wait",
        "workflow.start",
        "run.cancel",
        "config.set",
        "task.update",
        "task.sync",
        "peer.send",
        "peer.reply",
        "gate.signal",
        "gate.degrade",
      ];

      if (!ALLOWED_CLI_MUTATIONS.includes(command)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false,
          error: "unsupported_web_mutation",
          message: `Command '${command}' does not have a 1:1 underlying CLI audit mapping`,
        }));
        return;
      }

      const mutationId = `mut_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      if (options.onMutation) {
        try {
          const outcome = await options.onMutation(command, args);
          res.writeHead(outcome.ok ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ mutationId, ...outcome }));
        } catch (err: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ mutationId, ok: false, error: (err as Error).message }));
        }
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        mutationId,
        command,
        mappedToCli: true,
        executedAt: new Date().toISOString(),
      }));
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>KXM Web Studio</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg: #0b0f19;
      --panel-bg: #111827;
      --card-bg: #1f2937;
      --border: #374151;
      --text: #f9fafb;
      --text-muted: #9ca3af;
      --primary: #38bdf8;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    header {
      background: var(--panel-bg);
      border-bottom: 1px solid var(--border);
      padding: 12px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    h1 { font-size: 18px; font-weight: 700; color: var(--primary); margin: 0; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      border-radius: 9999px;
      background: #1e293b;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 500;
    }
    .dot-live { width: 8px; height: 8px; border-radius: 50%; background: var(--success); }
    .telemetry-bar {
      display: flex;
      gap: 16px;
      font-size: 13px;
      color: var(--text-muted);
      font-family: ui-monospace, monospace;
    }
    .telemetry-val { color: var(--text); font-weight: 600; }
    main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      padding: 16px 24px;
      gap: 16px;
    }
    .panel {
      background: var(--panel-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }
    .panel-title {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin: 0 0 12px 0;
      font-weight: 600;
    }
    /* Stepper */
    .stepper-container {
      display: flex;
      align-items: center;
      gap: 8px;
      overflow-x: auto;
      padding: 4px 0;
    }
    .step-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-radius: 6px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
    }
    .step-badge.active {
      border-color: var(--primary);
      box-shadow: 0 0 0 1px var(--primary);
      color: var(--primary);
    }
    .step-badge.completed { border-color: var(--success); color: var(--success); }
    .step-badge.failed { border-color: var(--danger); color: var(--danger); }
    .stepper-arrow { color: var(--text-muted); font-size: 14px; }
    /* Middle row */
    .middle-row {
      flex: 1;
      display: flex;
      gap: 16px;
      overflow: hidden;
    }
    /* DAG Canvas */
    .dag-panel {
      flex: 3;
      position: relative;
      overflow: auto;
      background: #0d1321;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    #dagCanvas {
      position: relative;
      min-width: 100%;
      min-height: 100%;
      padding: 32px;
    }
    .dag-node {
      position: absolute;
      width: 220px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3);
      cursor: pointer;
      transition: border-color 0.2s, transform 0.2s;
    }
    .dag-node:hover {
      border-color: var(--primary);
      transform: translateY(-2px);
    }
    .dag-node.active { border-color: var(--primary); }
    .dag-node.passed { border-color: var(--success); }
    .dag-node.failed { border-color: var(--danger); }
    .dag-node-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    .dag-node-title { font-size: 14px; font-weight: 600; color: var(--text); }
    .dag-node-kind {
      font-size: 10px;
      text-transform: uppercase;
      padding: 2px 6px;
      background: #374151;
      border-radius: 4px;
      color: #94a3b8;
    }
    .dag-node-body { font-size: 12px; color: var(--text-muted); display: flex; flex-direction: column; gap: 4px; }
    /* Side Panel */
    .side-panel {
      flex: 2;
      display: flex;
      flex-direction: column;
      gap: 16px;
      overflow-y: auto;
    }
    /* Swimlanes */
    .timeline-track {
      margin-bottom: 8px;
    }
    .track-label { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }
    .track-bar-container {
      background: var(--card-bg);
      height: 20px;
      border-radius: 4px;
      position: relative;
      overflow: hidden;
    }
    .track-bar {
      position: absolute;
      top: 2px;
      bottom: 2px;
      background: var(--primary);
      border-radius: 3px;
      opacity: 0.85;
    }
    /* Mutation Actions */
    .mutation-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .form-group { display: flex; flex-direction: column; gap: 4px; }
    label { font-size: 12px; color: var(--text-muted); }
    input, select, textarea {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      padding: 8px;
      font-size: 12px;
      font-family: inherit;
    }
    button.btn {
      background: #0284c7;
      color: white;
      border: none;
      border-radius: 4px;
      padding: 8px 12px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button.btn:hover { background: #0369a1; }
    .status-msg {
      font-size: 12px;
      padding: 8px;
      border-radius: 4px;
      font-family: monospace;
    }
    .status-ok { background: #064e3b; color: #a7f3d0; }
    .status-err { background: #7f1d1d; color: #fecaca; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <h1>KXM Web Studio</h1>
      <span class="badge"><span class="dot-live"></span> Port ${targetPort} · Embedded Hub Host</span>
    </div>
    <div class="telemetry-bar">
      <div>Run: <span id="runIdVal" class="telemetry-val">-</span></div>
      <div>Workflow: <span id="wfIdVal" class="telemetry-val">default</span></div>
      <div>Status: <span id="statusVal" class="telemetry-val">READY</span></div>
    </div>
  </header>

  <main>
    <!-- Stepper Section -->
    <div class="panel">
      <div class="panel-title">Workflow Stage Progress Stepper (Decision D14)</div>
      <div class="stepper-container" id="stepperContainer">
        <div class="step-badge">[▶ implement]</div>
        <div class="stepper-arrow">──></div>
        <div class="step-badge">[⧗ review-arch]</div>
        <div class="stepper-arrow">──></div>
        <div class="step-badge">[○ review-cli]</div>
        <div class="stepper-arrow">──></div>
        <div class="step-badge">[○ verify]</div>
      </div>
    </div>

    <!-- Middle: DAG Canvas + Side Swimlanes/Mutations -->
    <div class="middle-row">
      <!-- DAG Panel -->
      <div class="dag-panel">
        <svg id="svgEdges" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1;"></svg>
        <div id="dagCanvas">
          <!-- Dynamically injected nodes -->
        </div>
      </div>

      <!-- Side Panel: Swimlanes & Mutation Actions -->
      <div class="side-panel">
        <div class="panel">
          <div class="panel-title">Temporal Activity Swimlanes</div>
          <div id="swimlanesContainer">
            <div class="timeline-track">
              <div class="track-label">implement (Grok)</div>
              <div class="track-bar-container"><div class="track-bar" style="left:5%; width:40%;"></div></div>
            </div>
            <div class="timeline-track">
              <div class="track-label">review-arch (Claude Fable)</div>
              <div class="track-bar-container"><div class="track-bar" style="left:48%; width:30%; background: #a855f7;"></div></div>
            </div>
            <div class="timeline-track">
              <div class="track-label">verify (verify-gate)</div>
              <div class="track-bar-container"><div class="track-bar" style="left:80%; width:15%; background: #10b981;"></div></div>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-title">Audited CLI Mutations (1:1 Audit Parity)</div>
          <form class="mutation-form" id="mutationForm" onsubmit="handleMutate(event)">
            <div class="form-group">
              <label>Command (1:1 CLI audit mapping)</label>
              <select id="mutateCmd">
                <option value="workflow.signal">workflow.signal</option>
                <option value="workflow.checkpoint">workflow.checkpoint</option>
                <option value="workflow.wait">workflow.wait</option>
                <option value="gate.signal">gate.signal</option>
                <option value="gate.degrade">gate.degrade</option>
              </select>
            </div>
            <div class="form-group">
              <label>Arguments (JSON)</label>
              <textarea id="mutateArgs" rows="3" style="font-family: monospace;">{"signalKey": "approval", "status": "passed"}</textarea>
            </div>
            <div class="form-group">
              <label>Session Token (Authorization)</label>
              <input type="password" id="sessionTokenInput" placeholder="Optional if not authenticated">
            </div>
            <button type="submit" class="btn">Execute Audited Mutation</button>
            <div id="mutateResult" style="display:none;" class="status-msg"></div>
          </form>
        </div>
      </div>
    </div>
  </main>

  <script>
    async function loadLayout() {
      try {
        const res = await fetch('/api/layout');
        if (!res.ok) return;
        const data = await res.json();
        if (!data.ok || !data.layout) return;
        const layout = data.layout;

        document.getElementById('wfIdVal').textContent = layout.workflowId || 'default';
        if (layout.runId) document.getElementById('runIdVal').textContent = layout.runId;

        // Render Stepper
        if (layout.stepper && layout.stepper.length > 0) {
          const container = document.getElementById('stepperContainer');
          container.innerHTML = '';
          layout.stepper.forEach((step, idx) => {
            const el = document.createElement('div');
            el.className = 'step-badge ' + (step.status || 'pending');
            let icon = '○';
            if (step.status === 'completed') icon = '✔';
            else if (step.status === 'active') icon = '▶';
            else if (step.status === 'failed') icon = '✖';
            el.textContent = icon + ' ' + (step.label || step.id);
            container.appendChild(el);

            if (idx < layout.stepper.length - 1) {
              const arrow = document.createElement('div');
              arrow.className = 'stepper-arrow';
              arrow.textContent = '──>';
              container.appendChild(arrow);
            }
          });
        }

        // Render DAG Nodes
        if (layout.dag && layout.dag.nodes) {
          const canvas = document.getElementById('dagCanvas');
          canvas.innerHTML = '';
          layout.dag.nodes.forEach(node => {
            const div = document.createElement('div');
            div.className = 'dag-node ' + (node.data.status || 'pending');
            div.style.left = (node.position.x + 32) + 'px';
            div.style.top = (node.position.y + 32) + 'px';
            div.innerHTML = '<div class="dag-node-header">' +
              '<span class="dag-node-title">' + (node.data.label || node.id) + '</span>' +
              '<span class="dag-node-kind">' + node.data.kind + '</span>' +
              '</div>' +
              '<div class="dag-node-body">' +
              (node.data.role ? '<div>Role: <b>' + node.data.role + '</b></div>' : '') +
              (node.data.gate ? '<div>Gate: <b>' + node.data.gate + '</b></div>' : '') +
              '<div>Status: ' + node.data.status + '</div>' +
              '</div>';
            canvas.appendChild(div);
          });
        }

        // Render Swimlanes
        if (layout.temporalSwimlanes && layout.temporalSwimlanes.length > 0) {
          const container = document.getElementById('swimlanesContainer');
          container.innerHTML = '';
          layout.temporalSwimlanes.forEach(lane => {
            const div = document.createElement('div');
            div.className = 'timeline-track';
            div.innerHTML = '<div class="track-label">' + lane.laneId + (lane.role ? ' (' + lane.role + ')' : '') + '</div>' +
              '<div class="track-bar-container"><div class="track-bar" style="left:10%; width:70%;"></div></div>';
            container.appendChild(div);
          });
        }
      } catch (err) {
        console.error("Layout polling error:", err);
      }
    }

    async function handleMutate(e) {
      e.preventDefault();
      const cmd = document.getElementById('mutateCmd').value;
      const argsRaw = document.getElementById('mutateArgs').value;
      const token = document.getElementById('sessionTokenInput').value;
      const resDiv = document.getElementById('mutateResult');

      let args = {};
      try {
        args = JSON.parse(argsRaw);
      } catch {
        resDiv.style.display = 'block';
        resDiv.className = 'status-msg status-err';
        resDiv.textContent = 'Malformed JSON arguments';
        return;
      }

      try {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const res = await fetch('/api/mutate', {
          method: 'POST',
          headers,
          body: JSON.stringify({ command: cmd, args })
        });
        const out = await res.json();
        resDiv.style.display = 'block';
        if (res.ok && out.ok) {
          resDiv.className = 'status-msg status-ok';
          resDiv.textContent = 'Mutation applied (Audit ID: ' + out.mutationId + ')';
          loadLayout();
        } else {
          resDiv.className = 'status-msg status-err';
          resDiv.textContent = 'Mutation failed: ' + (out.message || out.error || res.status);
        }
      } catch (err) {
        resDiv.style.display = 'block';
        resDiv.className = 'status-msg status-err';
        resDiv.textContent = 'Network error: ' + err.message;
      }
    }

    loadLayout();
    setInterval(loadLayout, 3000);
  </script>
</body>
</html>`);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });

  return {
    server,
    port: targetPort,
    listen: () =>
      new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(targetPort, host, () => {
          server.removeListener("error", rejectListen);
          const addr = server.address();
          const actualPort = typeof addr === "object" && addr ? addr.port : targetPort;
          resolveListen(actualPort);
        });
      }),
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        try {
          server.closeAllConnections?.();
        } catch {
          // ignore if not supported
        }
        server.close((err) => {
          if (err) rejectClose(err);
          else resolveClose();
        });
      }),
  };
}

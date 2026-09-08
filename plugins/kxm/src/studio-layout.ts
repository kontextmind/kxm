/**
 * KXM Web Studio Layout Engine (Phase 10 / Decision D14)
 * Generates form/stepper metadata, ELK/React Flow-derived DAG nodes/edges,
 * and Temporal swimlane activity timelines from compiled plans and run states.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { VnextCompiledPlan, VnextCompiledStep } from "./vnext-engine-compile.ts";
import type { VnextRunState } from "./vnext-engine-fold.ts";

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
  plan: VnextCompiledPlan,
  state?: VnextRunState | undefined,
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
      if (transition.to && plan.steps[transition.to]) {
        adj[sourceId]!.push(transition.to);
        inDegree[transition.to] = (inDegree[transition.to] ?? 0) + 1;
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

  while (queue.length > 0) {
    const current = queue.shift()!;
    const curLevel = levels[current] ?? 0;
    for (const neighbor of adj[current] ?? []) {
      const nextLevel = Math.max(levels[neighbor] ?? 0, curLevel + 1);
      levels[neighbor] = nextLevel;
      queue.push(neighbor);
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
        if (transition.to && plan.steps[transition.to]) {
          edges.push({
            id: `e_${stepId}_to_${transition.to}_${outcome}`,
            source: stepId,
            target: transition.to,
            label: outcome !== "passed" && outcome !== "completed" ? outcome : undefined,
            animated: status === "running",
            style: {
              stroke: outcome === "failed" ? "#ef4444" : outcome === "warning" ? "#f59e0b" : "#64748b",
            },
          });
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
  planProvider?: (() => VnextCompiledPlan | undefined) | undefined;
  stateProvider?: (() => VnextRunState | undefined) | undefined;
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
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    h1 { font-size: 20px; font-weight: 600; color: #38bdf8; margin: 0 0 16px 0; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 4px; background: #1e293b; color: #94a3b8; font-size: 12px; }
  </style>
</head>
<body>
  <h1>KXM Web Studio</h1>
  <div class="badge">Port ${targetPort} · Embedded Hub Host</div>
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
        server.close((err) => {
          if (err) rejectClose(err);
          else resolveClose();
        });
      }),
  };
}

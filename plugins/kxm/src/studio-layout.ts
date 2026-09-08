/**
 * KXM Web Studio Layout Engine (Phase 10 / Decision D14)
 * Generates form/stepper metadata, ELK/React Flow-derived DAG nodes/edges,
 * and Temporal swimlane activity timelines from compiled plans and run states.
 */

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

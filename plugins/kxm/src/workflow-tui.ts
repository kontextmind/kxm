/**
 * KXM Workflow TUI module for Pi Extension.
 * Renders active workflow run, stage progress stepper, assigned roles, and model/spend metrics.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "./sqlite.ts";
import { repoConfigDirectory } from "./config.ts";
import { readRoutingRecords, telemetryPath } from "./telemetry.ts";

export interface WorkflowProgressMetrics {
  totalSpendUsd?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  latencyMs?: number | undefined;
  harness?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  memoryRevision?: string | undefined;
  transitions?: number | undefined;
  maxTransitions?: number | undefined;
}

export interface WorkflowProgressState {
  runId?: string | undefined;
  workflowId: string;
  status: "idle" | "running" | "waiting" | "passed" | "failed" | "completed" | "cancelled";
  currentStage?: string | undefined;
  currentRole?: string | undefined;
  attempt?: number | undefined;
  maxAttempts?: number | undefined;
  stages: Array<{
    id: string;
    label?: string | undefined;
    kind?: "agent" | "gate" | "wait" | "approval" | undefined;
    status: "pending" | "running" | "passed" | "failed" | "waiting" | "cancelled";
    role?: string | undefined;
    attempts?: number | undefined;
  }>;
  metrics?: WorkflowProgressMetrics | undefined;
  updatedAt?: string | undefined;
}

/**
 * Load current active or latest workflow progress from SQLite state and telemetry.
 */
export function loadActiveWorkflowProgress(
  repoRoot = process.cwd(),
  targetRunId?: string,
): WorkflowProgressState | undefined {
  const dbPath = join(repoConfigDirectory(repoRoot), "state", "kxm.db");
  if (!existsSync(dbPath)) return undefined;

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    let row: { record: string } | undefined;
    if (targetRunId) {
      row = db.prepare("SELECT record FROM workflow_runs WHERE id = ?").get(targetRunId) as { record: string } | undefined;
    } else {
      row = db.prepare(
        "SELECT record FROM workflow_runs ORDER BY CASE json_extract(record, '$.status') WHEN 'running' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END, json_extract(record, '$.updatedAt') DESC LIMIT 1",
      ).get() as { record: string } | undefined;
    }

    if (!row) return undefined;

    const raw = JSON.parse(row.record) as Record<string, unknown>;
    const runId = (raw.id as string) || targetRunId;
    const workflowId = (raw.definitionId as string) || (raw.workflowId as string) || "workflow";
    const status = (raw.status as WorkflowProgressState["status"]) || "running";
    const currentStage = (raw.currentStage as string) || undefined;
    const updatedAt = (raw.updatedAt as string) || undefined;

    const stages: WorkflowProgressState["stages"] = [];
    const rawStages = Array.isArray(raw.stages) ? raw.stages : [];
    for (const s of rawStages) {
      if (s && typeof s === "object") {
        stages.push({
          id: String((s as Record<string, unknown>).id || ""),
          label: (s as Record<string, unknown>).label as string | undefined,
          kind: (s as Record<string, unknown>).kind as any,
          status: ((s as Record<string, unknown>).status as any) || "pending",
          role: (s as Record<string, unknown>).role as string | undefined,
          attempts: typeof (s as Record<string, unknown>).attempts === "number" ? ((s as Record<string, unknown>).attempts as number) : undefined,
        });
      }
    }

    let metrics: WorkflowProgressMetrics | undefined;
    try {
      const logsDir = join(repoConfigDirectory(repoRoot), "logs");
      const telemFile = telemetryPath(logsDir);
      if (existsSync(telemFile)) {
        const records = readRoutingRecords(telemFile);
        const routingRunId = (routing: (typeof records)[number]["routing"]): string | undefined =>
          "runId" in routing ? routing.runId : routing.workflowRunId;
        let matching = records.filter((r) => routingRunId(r.routing) === runId);
        if (matching.length === 0) {
          const rawLines = readFileSync(telemFile, "utf8").split(/\r?\n/);
          for (const line of rawLines) {
            if (!line.trim()) continue;
            try {
              const p = JSON.parse(line) as Record<string, unknown>;
              const rt = (p.routing || p) as any;
              if (rt && (routingRunId(rt) === runId || p.runId === runId)) {
                matching.push({ recordedAt: (p.timestamp as string) || new Date().toISOString(), routing: rt });
              }
            } catch {
              // ignore
            }
          }
        }
        if (matching.length > 0) {
          const latest = matching[matching.length - 1]!.routing;
          let totalSpend = 0;
          let totalIn = 0;
          let totalOut = 0;
          let totalCache = 0;
          let totalLatency = 0;
          for (const m of matching) {
            const rt = m.routing;
            if (typeof rt.costUsd === "number") totalSpend += rt.costUsd;
            if ("tokensIn" in rt && typeof rt.tokensIn === "number") totalIn += rt.tokensIn;
            else if ("tokens" in rt && rt.tokens && typeof (rt.tokens as { input?: unknown }).input === "number") totalIn += (rt.tokens as { input: number }).input;
            if ("tokensOut" in rt && typeof rt.tokensOut === "number") totalOut += rt.tokensOut;
            else if ("tokens" in rt && rt.tokens && typeof (rt.tokens as { output?: unknown }).output === "number") totalOut += (rt.tokens as { output: number }).output;
            if ("cacheReadTokens" in rt && typeof rt.cacheReadTokens === "number") totalCache += rt.cacheReadTokens;
            else if ("tokens" in rt && rt.tokens && typeof (rt.tokens as { cacheRead?: unknown }).cacheRead === "number") totalCache += (rt.tokens as { cacheRead: number }).cacheRead;
            if ("latencyMs" in rt && typeof rt.latencyMs === "number") totalLatency += rt.latencyMs;
          }
          const latestRecord = latest as unknown as Record<string, unknown>;
          const latestMetadata = latestRecord.providerMetadata && typeof latestRecord.providerMetadata === "object"
            ? latestRecord.providerMetadata as Record<string, unknown>
            : undefined;
          metrics = {
            totalSpendUsd: totalSpend,
            inputTokens: totalIn,
            outputTokens: totalOut,
            cacheReadTokens: totalCache,
            latencyMs: totalLatency,
            harness: typeof latestRecord.harness === "string" ? latestRecord.harness : (typeof latestMetadata?.harness === "string" ? latestMetadata.harness : undefined),
            model: typeof latestRecord.effectiveModel === "string" ? latestRecord.effectiveModel : (typeof latestRecord.model === "string" ? latestRecord.model : (typeof latestRecord.requestedModel === "string" ? latestRecord.requestedModel : undefined)),
            effort: typeof latestRecord.thinking === "string" ? latestRecord.thinking : (typeof latestRecord.reasoningEffort === "string" ? latestRecord.reasoningEffort : undefined),
          };
        }
      }
    } catch {
      // Telemetry optional
    }

    const activeStageObj = stages.find((s) => s.id === currentStage);
    const currentRole = activeStageObj?.role || (raw.targetAgentName as string) || undefined;
    const attempt = activeStageObj?.attempts || 1;

    return {
      runId,
      workflowId,
      status,
      currentStage,
      currentRole,
      attempt,
      stages,
      metrics,
      updatedAt,
    };
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Format stage progress indicator into a compact horizontal visual stepper.
 * e.g.: [✔ implement] ──> [▶ review-arch] ──> [⧗ review-cli] ──> [○ verify]
 */
export function formatStageStepper(stages: WorkflowProgressState["stages"], currentStage?: string): string {
  if (stages.length === 0) {
    return currentStage ? `[▶ ${currentStage}]` : "[idle]";
  }

  const parts = stages.map((s) => {
    let icon = "○"; // pending
    if (s.status === "passed") icon = "✔";
    else if (s.id === currentStage || s.status === "running") icon = "▶";
    else if (s.status === "waiting") icon = "⧗";
    else if (s.status === "failed") icon = "✖";
    else if (s.status === "cancelled") icon = "⊘";
    return `[${icon} ${s.id}]`;
  });

  return parts.join(" ──> ");
}

function formatTokenK(tokens?: number): string {
  if (tokens === undefined || tokens === null) return "0";
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return String(tokens);
}

/**
 * Render Pi Extension live widget lines (for `ctx.ui.setWidget("kxm-workflow", lines)`).
 */
export function renderWorkflowWidgetLines(state?: WorkflowProgressState): string[] {
  if (!state || !state.runId) {
    return [
      "┌─ KXM Workflow ──────────────────────────────────────────────────────────────┐",
      "│ No active workflow running. Use 'kxm workflow start <id>'                   │",
      "└─────────────────────────────────────────────────────────────────────────────┘",
    ];
  }

  const shortRun = state.runId ? state.runId.slice(0, 16) : "-";
  const header = `┌─ KXM Workflow: ${state.workflowId} (${shortRun}) ─`;
  const topBorder = header + "─".repeat(Math.max(2, 79 - header.length)) + "┐";

  const stepper = formatStageStepper(state.stages, state.currentStage);
  const statusStr = state.status.toUpperCase();
  const attemptStr = state.attempt ? ` (Attempt ${state.attempt})` : "";
  const roleStr = state.currentRole ? ` · Role: ${state.currentRole}` : "";

  const lines: string[] = [topBorder];
  lines.push(`│ Stage: ${stepper}`);
  lines.push(`│ Status: ${statusStr}${attemptStr}${roleStr}`);

  if (state.metrics) {
    const costStr = state.metrics.totalSpendUsd !== undefined ? `$${state.metrics.totalSpendUsd.toFixed(2)}` : "unmetered";
    const routeStr = state.metrics.model ? `${state.metrics.harness ?? "pi"}:${state.metrics.model}` : "harness";
    const effortStr = state.metrics.effort ? ` (${state.metrics.effort})` : "";
    const inTokens = formatTokenK(state.metrics.inputTokens);
    const outTokens = formatTokenK(state.metrics.outputTokens);
    const cacheTokens = formatTokenK(state.metrics.cacheReadTokens);
    lines.push(`│ Model: ${routeStr}${effortStr} · Spend: ${costStr}`);
    lines.push(`│ Tokens: In: ${inTokens} | Out: ${outTokens} | Cache: ${cacheTokens}`);
  }

  lines.push("└" + "─".repeat(78) + "┘");
  return lines;
}

/**
 * Render detailed full-width TUI banner / notification string.
 */
export function renderWorkflowTuiText(state?: WorkflowProgressState): string {
  return renderWorkflowWidgetLines(state).join("\n");
}

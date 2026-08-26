import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MeshClient } from "./client.ts";
import { classifyFailure, diagnosticEvidence } from "./diagnostics.ts";

export interface WorkerRecoveryEnvelope {
  version: 1;
  reason: "missing_tool_result" | "unresumable_session" | "worker_signal";
  agentName: string;
  project: string;
  previousContinue: boolean;
  freshSession: boolean;
  signal?: string;
  createdAt: string;
  runId?: string | null;
  stageId?: string | null;
  pendingMessageIds?: string[];
  artifactPointers?: string[];
}

export function recoveryEnvelopePath(stateDir: string, agentName: string): string {
  const safeName = agentName.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(stateDir, `worker-recovery-${safeName}.json`);
}

export function readWorkerRecoveryEnvelope(stateDir: string, agentName: string): WorkerRecoveryEnvelope | undefined {
  const path = recoveryEnvelopePath(stateDir, agentName);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as WorkerRecoveryEnvelope;
    if (parsed.version !== 1 || typeof parsed.reason !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function consumeWorkerRecoveryEnvelope(client: MeshClient, stateDir: string, agentName: string): Promise<WorkerRecoveryEnvelope | undefined> {
  const envelope = readWorkerRecoveryEnvelope(stateDir, agentName);
  if (!envelope) return undefined;
  const path = recoveryEnvelopePath(stateDir, agentName);
  let runId = envelope.runId ?? undefined;
  let stageId = envelope.stageId ?? undefined;
  if (!runId) {
    try {
      const runs = await client.listWorkflows();
      const active = runs.find((run) => run.status === "running" || run.status === "waiting")
        ?? runs.find((run) => run.status === "failed");
      runId = active?.id;
      stageId = active?.currentStage ?? active?.stages.find((stage) => stage.status !== "pending")?.id;
    } catch {
      // Assigned-run lookup is optional for the envelope.
    }
  }
  if (!runId) return undefined;
  const diagnostic = classifyFailure({
    toolName: "mesh_await",
    code: "unresumable_session",
    message: envelope.reason,
  });
  try {
    await client.recordWorkflowEntry(runId, {
      category: "error",
      area: "harness",
      severity: "error",
      summary: `Worker recovered with ${envelope.reason}`,
      evidence: [
        ...diagnosticEvidence(diagnostic),
        `recovery:v1`,
        `reason:${envelope.reason}`,
        ...(stageId ? [`stage:${stageId}`] : []),
        ...(envelope.pendingMessageIds ?? []).slice(0, 8).map((id) => `message:${id}`),
        ...(envelope.artifactPointers ?? []).slice(0, 16).map((pointer) => pointer.startsWith("artifact:") ? pointer : `artifact:${pointer}`),
      ],
    });
    rmSync(path, { force: true });
    return { ...envelope, runId, ...(stageId ? { stageId } : {}) };
  } catch {
    // Keep the envelope if journaling failed so the next session can retry.
    return undefined;
  }
}

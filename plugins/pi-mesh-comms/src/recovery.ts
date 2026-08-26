import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MeshClient } from "./client.ts";
import { classifyFailure, diagnosticEvidence } from "./diagnostics.ts";

export interface WorkerRecoveryEnvelope {
  version: 1;
  reason: "missing_tool_result" | "unresumable_session" | "provider_error" | "tool_timeout" | "worker_signal";
  agentName: string;
  project: string;
  workerKey?: string;
  generation?: string;
  previousContinue: boolean;
  freshSession: boolean;
  failureClass?: "quota" | "provider_error" | "timeout";
  signal?: string;
  createdAt: string;
  runId?: string | null;
  stageId?: string | null;
  pendingMessageIds?: string[];
  artifactPointers?: string[];
}

export function workerStateKey(project: string, agentName: string): string {
  const safeProject = project.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 24) || "project";
  const safeName = agentName.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 32) || "agent";
  const digest = createHash("sha256")
    .update(JSON.stringify({ project, agentName }))
    .digest("hex")
    .slice(0, 24);
  return `${safeProject}-${safeName}-${digest}`;
}

function legacyRecoveryEnvelopePath(stateDir: string, agentName: string): string {
  const safeName = agentName.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(stateDir, `worker-recovery-${safeName}.json`);
}

export function recoveryEnvelopePath(stateDir: string, agentName: string, project?: string): string {
  return project
    ? join(stateDir, `worker-recovery-${workerStateKey(project, agentName)}.json`)
    : legacyRecoveryEnvelopePath(stateDir, agentName);
}

function findWorkerRecoveryEnvelope(
  stateDir: string,
  agentName: string,
  project?: string,
): { envelope: WorkerRecoveryEnvelope; path: string } | undefined {
  const candidates = project
    ? [recoveryEnvelopePath(stateDir, agentName, project), legacyRecoveryEnvelopePath(stateDir, agentName)]
    : [legacyRecoveryEnvelopePath(stateDir, agentName)];
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as WorkerRecoveryEnvelope;
      if (parsed.version !== 1 || typeof parsed.reason !== "string") continue;
      if (project && (parsed.agentName !== agentName || parsed.project !== project)) continue;
      return { envelope: parsed, path };
    } catch {
      // Try the legacy path after the collision-safe path.
    }
  }
  return undefined;
}

export function readWorkerRecoveryEnvelope(stateDir: string, agentName: string, project?: string): WorkerRecoveryEnvelope | undefined {
  return findWorkerRecoveryEnvelope(stateDir, agentName, project)?.envelope;
}

export async function consumeWorkerRecoveryEnvelope(client: MeshClient, stateDir: string, agentName: string, project?: string): Promise<WorkerRecoveryEnvelope | undefined> {
  const found = findWorkerRecoveryEnvelope(stateDir, agentName, project);
  if (!found) return undefined;
  const { envelope, path } = found;
  const runId = envelope.runId ?? undefined;
  const stageId = envelope.stageId ?? undefined;
  if (!runId) {
    // Recovery provenance is exact: an unbound worker event must never be
    // attached to whichever workflow happens to be active in the project.
    rmSync(path, { force: true });
    return envelope;
  }
  const providerRecovery = envelope.reason === "provider_error";
  const diagnostic = classifyFailure({
    toolName: providerRecovery ? "provider" : envelope.reason === "tool_timeout" ? "tool" : "mesh_await",
    ...(providerRecovery
      ? { code: envelope.failureClass === "quota" ? "provider_quota" : "provider_error" }
      : envelope.reason === "tool_timeout" ? {} : { code: "unresumable_session" }),
    message: envelope.reason === "tool_timeout" ? "timed out" : envelope.reason,
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

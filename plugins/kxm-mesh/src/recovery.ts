import { createHash } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MeshHttpError, type MeshClient } from "./client.ts";
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
  sessionBinding?: { kind: "default" } | { kind: "workflow"; runId: string };
  failureClass?: "quota" | "provider_error" | "timeout";
  signal?: string;
  createdAt: string;
  runId?: string | null;
  stageId?: string | null;
  activeMessageIds?: string[];
  pendingMessageIds?: string[];
  artifactPointers?: string[];
  /** Runtime-only disposition; never written by the supervisor. */
  peerLocal?: boolean;
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

const recoveryReasons = new Set<WorkerRecoveryEnvelope["reason"]>([
  "missing_tool_result", "unresumable_session", "provider_error", "tool_timeout", "worker_signal",
]);
const recoveryRunId = /^run_[a-f0-9]{32}$/;
const recoveryMessageId = /^msg_[a-f0-9]{32}$/;

function validBoundedStrings(value: unknown, maxItems: number, pattern?: RegExp): value is string[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 2_048 && !/[\0\r\n]/.test(item) && (!pattern || pattern.test(item)));
}

function parseRecoveryEnvelope(value: unknown, agentName: string, project?: string): WorkerRecoveryEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("recovery envelope must be an object");
  const parsed = value as Partial<WorkerRecoveryEnvelope>;
  if (
    parsed.version !== 1
    || !recoveryReasons.has(parsed.reason as WorkerRecoveryEnvelope["reason"])
    || parsed.agentName !== agentName
    || typeof parsed.project !== "string"
    || parsed.project.length < 1
    || parsed.project.length > 128
    || (project !== undefined && parsed.project !== project)
    || typeof parsed.previousContinue !== "boolean"
    || typeof parsed.freshSession !== "boolean"
    || typeof parsed.createdAt !== "string"
    || !Number.isFinite(Date.parse(parsed.createdAt))
  ) throw new Error("recovery envelope identity or schema is invalid");
  if (parsed.runId !== undefined && parsed.runId !== null && !recoveryRunId.test(parsed.runId)) {
    throw new Error("recovery envelope run identity is invalid");
  }
  if (parsed.stageId !== undefined && parsed.stageId !== null && (typeof parsed.stageId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(parsed.stageId))) {
    throw new Error("recovery envelope stage identity is invalid");
  }
  if (parsed.activeMessageIds !== undefined && !validBoundedStrings(parsed.activeMessageIds, 3, recoveryMessageId)) {
    throw new Error("recovery envelope active messages are invalid");
  }
  if (parsed.pendingMessageIds !== undefined && !validBoundedStrings(parsed.pendingMessageIds, 16, recoveryMessageId)) {
    throw new Error("recovery envelope pending messages are invalid");
  }
  if (parsed.artifactPointers !== undefined && !validBoundedStrings(parsed.artifactPointers, 16)) {
    throw new Error("recovery envelope artifact pointers are invalid");
  }
  if (parsed.failureClass !== undefined && parsed.failureClass !== "quota" && parsed.failureClass !== "provider_error" && parsed.failureClass !== "timeout") {
    throw new Error("recovery envelope failure class is invalid");
  }
  if (parsed.signal !== undefined && (typeof parsed.signal !== "string" || parsed.signal.length > 64 || /[\0\r\n]/.test(parsed.signal))) {
    throw new Error("recovery envelope signal is invalid");
  }
  if (parsed.sessionBinding !== undefined) {
    const binding = parsed.sessionBinding;
    if (
      !binding
      || typeof binding !== "object"
      || (binding.kind === "default" && Object.keys(binding).some((key) => key !== "kind"))
      || (binding.kind === "workflow" && !recoveryRunId.test(binding.runId))
      || (binding.kind !== "default" && binding.kind !== "workflow")
    ) throw new Error("recovery envelope session binding is invalid");
  }
  return parsed as WorkerRecoveryEnvelope;
}

function findWorkerRecoveryEnvelope(
  stateDir: string,
  agentName: string,
  project?: string,
): { envelope: WorkerRecoveryEnvelope; path: string } | undefined {
  const candidates = project
    ? [
      { path: recoveryEnvelopePath(stateDir, agentName, project), quarantineInvalid: true },
      { path: legacyRecoveryEnvelopePath(stateDir, agentName), quarantineInvalid: false },
    ]
    : [{ path: legacyRecoveryEnvelopePath(stateDir, agentName), quarantineInvalid: false }];
  for (const candidate of candidates) {
    try {
      const stats = lstatSync(candidate.path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 128 * 1_024) {
        throw new Error("recovery envelope is not a bounded regular file");
      }
      const envelope = parseRecoveryEnvelope(JSON.parse(readFileSync(candidate.path, "utf8")), agentName, project);
      return { envelope, path: candidate.path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      if (candidate.quarantineInvalid) {
        try {
          renameSync(candidate.path, `${candidate.path}.corrupt-${Date.now()}`);
        } catch {
          // Failure to quarantine leaves the envelope untouched for an operator.
        }
      }
      // Try the legacy path after an absent or invalid collision-safe path.
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
  let runId = envelope.runId ?? undefined;
  let stageId = envelope.stageId ?? undefined;
  let scopeMismatch = false;
  if (envelope.sessionBinding) {
    const boundRunId = envelope.sessionBinding.kind === "workflow" ? envelope.sessionBinding.runId : undefined;
    if (runId !== boundRunId) {
      // Never attach recovery from a default or sibling Pi session to this run.
      scopeMismatch = true;
      runId = undefined;
      stageId = undefined;
    }
  }
  if (!runId) {
    // Recovery provenance is exact: an unbound worker event must never be
    // attached to whichever workflow happens to be active in the project.
    rmSync(path, { force: true });
    return scopeMismatch ? { ...envelope, runId: null, stageId: null } : envelope;
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
        ...(envelope.sessionBinding?.kind === "workflow" ? [`session-scope:${envelope.sessionBinding.runId}`] : []),
        ...(stageId ? [`stage:${stageId}`] : []),
        ...(envelope.pendingMessageIds ?? []).slice(0, 8).map((id) => `message:${id}`),
        ...(envelope.artifactPointers ?? []).slice(0, 16).map((pointer) => pointer.startsWith("artifact:") ? pointer : `artifact:${pointer}`),
      ],
    });
    rmSync(path, { force: true });
    return { ...envelope, runId, ...(stageId ? { stageId } : {}) };
  } catch (error) {
    if (error instanceof MeshHttpError && error.statusCode === 403 && error.code === "workflow_forbidden") {
      // Workflow-affine peers need the same local replay protection as the
      // coordinator, but only the assigned coordinator may mutate the journal.
      // Consume their local envelope instead of retrying an unauthorized write
      // forever; the hub's durable message remains the recovery authority.
      rmSync(path, { force: true });
      return { ...envelope, runId, ...(stageId ? { stageId } : {}), peerLocal: true };
    }
    // Keep the envelope if an authorized journal write failed transiently so
    // the next session can retry it.
    return undefined;
  }
}

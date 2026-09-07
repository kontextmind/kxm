import { join } from "node:path";
import { verifyArtifactExists } from "./artifacts-exist.ts";
import type { VnextRuntimeContext } from "./vnext-runtime.ts";

export interface VnextArtifactsObservation {
  completeness: "complete";
  spawned: 0;
  pid: null;
  exitCode: null;
  signal: null;
  exitObserved: 0;
  closeObserved: 0;
  stopCause: "none";
  signalsAttempted: "none";
  errorClass: null;
  stdoutSha256: null;
  stdoutBytes: null;
  stdoutComplete: null;
  stderrSha256: null;
  stderrBytes: null;
  stderrComplete: null;
  checkedCount: number;
  failedCount: number;
  elapsedMs: number;
  startedAt: string;
  finishedAt: string;
}

export interface VnextArtifactsGateSeams {
  afterPathChecked?: ((input: {
    path: string;
    index: number;
    checkedCount: number;
    failedCount: number;
  }) => void) | undefined;
}

export const vnextArtifactsGateSeams: VnextArtifactsGateSeams = {};

/**
 * Check every pinned path under control `.kxm/assets`. Normal helper failures
 * are complete failed facts. Exceptions after checks begin must propagate.
 */
export function evaluateArtifactsGate(
  context: VnextRuntimeContext,
  definition: { readonly kind: "artifacts-exist"; readonly paths: readonly string[] },
): VnextArtifactsObservation {
  const root = join(context.projectRoot, ".kxm", "assets");
  const startedAt = new Date().toISOString();
  const startTime = process.hrtime.bigint();
  let checkedCount = 0;
  let failedCount = 0;

  for (const [index, path] of definition.paths.entries()) {
    checkedCount += 1;
    const result = verifyArtifactExists(root, join(root, path));
    if (!result.ok) failedCount += 1;
    vnextArtifactsGateSeams.afterPathChecked?.({ path, index, checkedCount, failedCount });
  }

  const elapsedNs = process.hrtime.bigint() - startTime;
  const finishedAt = new Date().toISOString();
  return {
    completeness: "complete",
    spawned: 0,
    pid: null,
    exitCode: null,
    signal: null,
    exitObserved: 0,
    closeObserved: 0,
    stopCause: "none",
    signalsAttempted: "none",
    errorClass: null,
    stdoutSha256: null,
    stdoutBytes: null,
    stdoutComplete: null,
    stderrSha256: null,
    stderrBytes: null,
    stderrComplete: null,
    checkedCount,
    failedCount,
    elapsedMs: Math.max(0, Math.floor(Number(elapsedNs) / 1_000_000)),
    startedAt,
    finishedAt,
  };
}

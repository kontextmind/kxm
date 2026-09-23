import { spawnSync } from "node:child_process";
import type { KxmProducerResult } from "./engine.ts";

/**
 * Fingerprint of a checkout taken around a live producer spawn.
 * Porcelain alone misses a content edit that keeps the same status line, so the
 * witness also includes unstaged and staged diffs.
 */
export interface WorktreeWitness {
  readonly unwitnessed: boolean;
  readonly fingerprint: string;
}

function gitText(cwd: string, args: readonly string[]): string | undefined {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout ?? "";
}

export function captureWorktreeWitness(cwd: string): WorktreeWitness {
  const porcelain = gitText(cwd, ["status", "--porcelain=v1", "-uall"]);
  const diff = gitText(cwd, ["diff", "--no-ext-diff"]);
  const staged = gitText(cwd, ["diff", "--cached", "--no-ext-diff"]);
  if (porcelain === undefined || diff === undefined || staged === undefined) {
    return { unwitnessed: true, fingerprint: "" };
  }
  return { unwitnessed: false, fingerprint: `${porcelain}\0${diff}\0${staged}` };
}

export function worktreeChanged(before: WorktreeWitness, after: WorktreeWitness): boolean {
  if (before.unwitnessed || after.unwitnessed) return false;
  return before.fingerprint !== after.fingerprint;
}

/**
 * A live `passed` is an authoring success only when the step declared write
 * and the checkout fingerprint changed. A read-only step that mutates the tree
 * cannot stay `passed`. Metadata `authored` is set here, not trusted from the
 * producer.
 */
export function applyAuthoringWitness(
  result: KxmProducerResult,
  input: { writes: boolean; before: WorktreeWitness; after: WorktreeWitness },
): KxmProducerResult {
  const changed = worktreeChanged(input.before, input.after);
  const unwitnessed = input.before.unwitnessed || input.after.unwitnessed;
  const providerMetadata: Record<string, string | number | boolean> = { ...(result.providerMetadata ?? {}) };
  if (input.writes) {
    if (unwitnessed || !changed) {
      providerMetadata.authored = false;
      providerMetadata.authoringWitness = unwitnessed ? "unwitnessed" : "unchanged";
      if (result.outcome === "passed") return { ...result, outcome: "failed", providerMetadata };
    } else {
      providerMetadata.authored = true;
      providerMetadata.authoringWitness = "changed";
    }
  } else {
    providerMetadata.authored = false;
    if (!unwitnessed && changed) {
      providerMetadata.authoringWitness = "readonly_mutated";
      if (result.outcome === "passed") return { ...result, outcome: "failed", providerMetadata };
    } else {
      providerMetadata.authoringWitness = unwitnessed ? "unwitnessed" : "read-only";
    }
  }
  return { ...result, providerMetadata };
}

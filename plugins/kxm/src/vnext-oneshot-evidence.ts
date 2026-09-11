import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import type { VnextOneShotProcessResult } from "./vnext-oneshot-process.ts";

const TEXT_LIMIT = 4 * 1024 * 1024;
const RECORD_LIMIT = 16 * 1024 * 1024;
const digest = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** Private diagnostic evidence, never a peer reply or acceptance authority.
 * Retained until operator archival; no automatic deletion of failed attempts.
 * Each record is bounded; inability to reserve/write evidence fails closed.
 */
export async function beginOneShotEvidence(root: string, intent: {
  runId: string; stepId: string; attemptId: string; assignmentId: string;
  harness: string; provider: string; model: string; cwd: string;
  command: string; args: readonly string[]; input?: string | undefined;
}, sensitive: readonly string[]): Promise<{
  id: string;
  finish(result: VnextOneShotProcessResult, observation: unknown): Promise<string>;
}> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
    throw new Error("oneshot_evidence_root_not_private");
  }
  const id = `evd_${randomUUID().replaceAll("-", "")}`;
  const dir = join(root, id);
  await mkdir(dir, { mode: 0o700 });
  const secrets = [...new Set(sensitive.filter((value) => value.length >= 8))].sort((a, b) => b.length - a.length);
  const redact = (value: string): string => {
    let text = value;
    for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
    return text.replace(/(\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',;}]+/gi, "$1[REDACTED]");
  };
  const bounded = (value: string): { text: string; truncated: boolean; sha256: string } => {
    const bytes = Buffer.from(redact(value));
    return { text: bytes.subarray(0, TEXT_LIMIT).toString("utf8"), truncated: bytes.length > TEXT_LIMIT, sha256: digest(value) };
  };
  const write = async (name: string, value: unknown): Promise<string> => {
    const current = await lstat(dir);
    if (!current.isDirectory() || current.isSymbolicLink()
      || (process.platform !== "win32" && ((current.mode & 0o077) !== 0 || current.uid !== process.getuid?.()))) {
      throw new Error("oneshot_evidence_directory_changed");
    }
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > RECORD_LIMIT) throw new Error("oneshot_evidence_record_limit");
    const target = join(dir, name);
    const partial = `${target}.partial`;
    const file = await open(partial, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    await rename(partial, target);
    if (process.platform !== "win32") {
      const directory = await open(dir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return digest(bytes);
  };
  await write("intent.json", {
    schema: "kxm.oneshot-evidence.v1", id, recordedAt: new Date().toISOString(),
    runId: intent.runId, stepId: intent.stepId, attemptId: intent.attemptId, assignmentId: intent.assignmentId,
    harness: intent.harness, provider: intent.provider, requestedModel: intent.model,
    cwd: intent.cwd, command: intent.command,
    argv: bounded(JSON.stringify(intent.args)), stdin: intent.input === undefined ? null : bounded(intent.input),
    acceptance: false,
  });
  let finished = false;
  return {
    id,
    async finish(result, observation) {
      if (finished) throw new Error("oneshot_evidence_already_finished");
      finished = true;
      return write("result.json", {
        schema: "kxm.oneshot-evidence.v1", id, recordedAt: new Date().toISOString(),
        stdout: bounded(result.stdout), stderr: bounded(result.stderr),
        code: result.code, signal: result.signal ?? null, started: result.started ?? null,
        observedChildExit: result.observedChildExit ?? null, terminationRequested: result.terminationRequested ?? null,
        error: result.error ? bounded(result.error.message) : null,
        observation: bounded(JSON.stringify(observation)), acceptance: false,
      });
    },
  };
}

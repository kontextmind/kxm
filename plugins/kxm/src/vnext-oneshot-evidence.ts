import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import type { VnextOneShotProcessResult } from "./vnext-oneshot-process.ts";

export const ONESHOT_EVIDENCE_SCHEMA = "kxm.oneshot-evidence.v2" as const;
const RETIRED_ONESHOT_EVIDENCE_SCHEMAS = new Set(["kxm.oneshot-evidence.v1"]);

const TEXT_LIMIT = 4 * 1024 * 1024;
const ARGV_LIMIT = 64 * 1024;
const RECORD_LIMIT = 16 * 1024 * 1024;
const digest = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export interface OneShotEvidenceRecord {
  schema: typeof ONESHOT_EVIDENCE_SCHEMA;
  [key: string]: unknown;
}

/** Brake: retired and unknown persisted schema ids are never aliased or upgraded. */
export function parseOneShotEvidenceRecord(bytes: string): OneShotEvidenceRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes) as unknown;
  } catch {
    throw new Error("oneshot_evidence_record_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("oneshot_evidence_record_invalid");
  }
  const schema = (parsed as { schema?: unknown }).schema;
  if (typeof schema !== "string") throw new Error("oneshot_evidence_record_invalid");
  if (RETIRED_ONESHOT_EVIDENCE_SCHEMAS.has(schema)) throw new Error("oneshot_evidence_schema_retired");
  if (schema !== ONESHOT_EVIDENCE_SCHEMA) throw new Error("oneshot_evidence_schema_unknown");
  return parsed as OneShotEvidenceRecord;
}

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
    return text
      .replace(/(\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',;}]+/gi, "$1[REDACTED]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  };
  const bounded = (value: string, max = TEXT_LIMIT): { text: string; truncated: boolean; sha256: string } => {
    const bytes = Buffer.from(redact(value));
    return { text: bytes.subarray(0, max).toString("utf8"), truncated: bytes.length > max, sha256: digest(redact(value)) };
  };
  const write = async (name: string, value: unknown): Promise<string> => {
    const current = await lstat(dir);
    if (!current.isDirectory() || current.isSymbolicLink()
      || (process.platform !== "win32" && ((current.mode & 0o077) !== 0 || current.uid !== process.getuid?.()))) {
      throw new Error("oneshot_evidence_directory_changed");
    }
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > RECORD_LIMIT) throw new Error("oneshot_evidence_record_limit");
    parseOneShotEvidenceRecord(bytes);
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
    schema: ONESHOT_EVIDENCE_SCHEMA, id, recordedAt: new Date().toISOString(),
    runId: intent.runId, stepId: intent.stepId, attemptId: intent.attemptId, assignmentId: intent.assignmentId,
    harness: intent.harness, provider: intent.provider, requestedModel: intent.model,
    cwd: intent.cwd, command: redact(intent.command),
    argv: bounded(JSON.stringify(intent.args), ARGV_LIMIT), stdin: intent.input === undefined ? null : bounded(intent.input),
    env: null,
    acceptance: false,
  });
  let finished = false;
  return {
    id,
    async finish(result, observation) {
      if (finished) throw new Error("oneshot_evidence_already_finished");
      finished = true;
      return write("result.json", {
        schema: ONESHOT_EVIDENCE_SCHEMA, id, recordedAt: new Date().toISOString(),
        stdout: bounded(result.stdout), stderr: bounded(result.stderr),
        code: result.code, signal: result.signal ?? null, started: result.started ?? null,
        observedChildExit: result.observedChildExit ?? null, terminationRequested: result.terminationRequested ?? null,
        unverifiedDescendants: result.unverifiedDescendants ?? null,
        error: result.error ? bounded(result.error.message) : null,
        observation: bounded(JSON.stringify(observation)), acceptance: false,
      });
    },
  };
}

/**
 * KXM External Side-Effect Idempotency (Slice C)
 * Ensures deterministic branching, preflight CAS checks, and immutable receipts for external mutations.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const EXTERNAL_EFFECT_SCHEMA = "kxm.external-effect-receipt.v1" as const;

export type ExternalActionKind =
  | "git-branch"
  | "git-commit"
  | "git-push"
  | "pr-create"
  | "tracker-issue"
  | "webhook";

export type ExternalEffectStatus = "in-flight" | "committed" | "failed" | "aborted";

export interface ExternalEffectReceipt {
  schema: typeof EXTERNAL_EFFECT_SCHEMA;
  effectKey: string;
  runId: string;
  stepId: string;
  attemptId: string;
  actionKind: ExternalActionKind;
  targetRef: string;
  status: ExternalEffectStatus;
  payloadHash: string;
  receiptPayload: Record<string, unknown>;
  executedAt: string;
  completedAt?: string | undefined;
}

export interface RunBranchOptions {
  description?: string | undefined;
  workflowId?: string | undefined;
  issueKey?: string | undefined;
  format?: "prefix-run" | "run-suffix" | undefined;
}

export function slugifyBranchPart(text: string, maxLength: number = 40): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).replace(/-+$/, "");
}

export function deterministicRunBranch(
  runId: string,
  descriptionOrOptions?: string | RunBranchOptions,
): string {
  const cleanId = runId.replace(/^run_/, "");
  if (!descriptionOrOptions) {
    return `kxm/run-${cleanId}`;
  }

  const options: RunBranchOptions =
    typeof descriptionOrOptions === "string"
      ? { description: descriptionOrOptions }
      : descriptionOrOptions;

  const parts: string[] = [];
  if (options.workflowId) {
    const wf = slugifyBranchPart(options.workflowId, 25);
    if (wf) parts.push(wf);
  }
  if (options.issueKey) {
    const issue = slugifyBranchPart(options.issueKey, 20);
    if (issue && !parts.some((p) => p.includes(issue))) parts.push(issue);
  }
  if (options.description) {
    const desc = slugifyBranchPart(options.description, 35);
    if (desc && !parts.some((p) => p.includes(desc))) parts.push(desc);
  }

  const slug = parts.join("-").slice(0, 50).replace(/-+$/, "");
  if (!slug) {
    return `kxm/run-${cleanId}`;
  }

  if (options.format === "prefix-run") {
    return `kxm/${slug}-run-${cleanId}`;
  }
  return `kxm/run-${cleanId}-${slug}`;
}

export function computeEffectKey(
  runId: string,
  stepId: string,
  actionKind: ExternalActionKind,
  targetRef: string,
): string {
  const raw = `${runId}:${stepId}:${actionKind}:${targetRef}`;
  return `eff_${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

export class ExternalEffectsLedger {
  private db: DatabaseSync;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS external_effects (
        effect_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        target_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        receipt_payload TEXT NOT NULL,
        executed_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ext_effects_run ON external_effects(run_id);
    `);
  }

  /**
   * Preflight Check-And-Set (CAS):
   * Guarantees that an external mutation is only initiated if not already committed or currently in-flight.
   */
  claimEffect(input: {
    runId: string;
    stepId: string;
    attemptId: string;
    actionKind: ExternalActionKind;
    targetRef: string;
    payload?: Record<string, unknown> | undefined;
    timeoutMs?: number | undefined;
  }): { ok: true; effectKey: string } | { ok: false; error: string; existing?: ExternalEffectReceipt } {
    const effectKey = computeEffectKey(input.runId, input.stepId, input.actionKind, input.targetRef);
    const now = new Date().toISOString();
    const payloadStr = JSON.stringify(input.payload ?? {});
    const payloadHash = createHash("sha256").update(payloadStr).digest("hex");

    const existing = this.getReceipt(effectKey);
    if (existing) {
      if (existing.status === "committed") {
        return {
          ok: false,
          error: `effect_already_committed: ${input.actionKind} on ${input.targetRef} was already committed`,
          existing,
        };
      }
      if (existing.status === "in-flight") {
        const timeout = input.timeoutMs ?? 60000;
        const elapsed = Date.now() - Date.parse(existing.executedAt);
        if (elapsed < timeout) {
          return {
            ok: false,
            error: `effect_in_flight: ${input.actionKind} on ${input.targetRef} is currently executing`,
            existing,
          };
        }
        // If timed out, allow reclaim by updating status
      }
    }

    const stmt = this.db.prepare(`
      INSERT INTO external_effects (
        effect_key, run_id, step_id, attempt_id, action_kind, target_ref,
        status, payload_hash, receipt_payload, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(effect_key) DO UPDATE SET
        attempt_id = excluded.attempt_id,
        status = 'in-flight',
        executed_at = excluded.executed_at,
        payload_hash = excluded.payload_hash,
        receipt_payload = excluded.receipt_payload
    `);

    stmt.run(
      effectKey,
      input.runId,
      input.stepId,
      input.attemptId,
      input.actionKind,
      input.targetRef,
      "in-flight",
      payloadHash,
      payloadStr,
      now,
    );

    return { ok: true, effectKey };
  }

  commitEffect(
    effectKey: string,
    receiptPayload: Record<string, unknown>,
  ): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE external_effects
      SET status = 'committed', receipt_payload = ?, completed_at = ?
      WHERE effect_key = ?
    `);
    stmt.run(JSON.stringify(receiptPayload), now, effectKey);
  }

  abortEffect(effectKey: string, reason: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE external_effects
      SET status = 'aborted', receipt_payload = ?, completed_at = ?
      WHERE effect_key = ?
    `);
    stmt.run(JSON.stringify({ error: reason }), now, effectKey);
  }

  getReceipt(effectKey: string): ExternalEffectReceipt | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM external_effects WHERE effect_key = ?
    `);
    const row = stmt.get(effectKey) as {
      effect_key: string;
      run_id: string;
      step_id: string;
      attempt_id: string;
      action_kind: ExternalActionKind;
      target_ref: string;
      status: ExternalEffectStatus;
      payload_hash: string;
      receipt_payload: string;
      executed_at: string;
      completed_at: string | null;
    } | undefined;

    if (!row) return undefined;

    return {
      schema: EXTERNAL_EFFECT_SCHEMA,
      effectKey: row.effect_key,
      runId: row.run_id,
      stepId: row.step_id,
      attemptId: row.attempt_id,
      actionKind: row.action_kind,
      targetRef: row.target_ref,
      status: row.status,
      payloadHash: row.payload_hash,
      receiptPayload: JSON.parse(row.receipt_payload) as Record<string, unknown>,
      executedAt: row.executed_at,
      completedAt: row.completed_at ?? undefined,
    };
  }

  listRunEffects(runId: string): ExternalEffectReceipt[] {
    const stmt = this.db.prepare(`
      SELECT * FROM external_effects WHERE run_id = ? ORDER BY executed_at ASC
    `);
    const rows = stmt.all(runId) as Array<{
      effect_key: string;
      run_id: string;
      step_id: string;
      attempt_id: string;
      action_kind: ExternalActionKind;
      target_ref: string;
      status: ExternalEffectStatus;
      payload_hash: string;
      receipt_payload: string;
      executed_at: string;
      completed_at: string | null;
    }>;

    return rows.map((row) => ({
      schema: EXTERNAL_EFFECT_SCHEMA,
      effectKey: row.effect_key,
      runId: row.run_id,
      stepId: row.step_id,
      attemptId: row.attempt_id,
      actionKind: row.action_kind,
      targetRef: row.target_ref,
      status: row.status,
      payloadHash: row.payload_hash,
      receiptPayload: JSON.parse(row.receipt_payload) as Record<string, unknown>,
      executedAt: row.executed_at,
      completedAt: row.completed_at ?? undefined,
    }));
  }

  close(): void {
    this.db.close();
  }
}

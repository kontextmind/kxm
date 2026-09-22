/**
 * KXM External Side-Effect Idempotency (Slice C)
 * Ensures deterministic branching, preflight CAS checks, and immutable receipts for external mutations.
 */

import { DatabaseSync } from "./sqlite.ts";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
  lstatSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openDatabase } from "./database.ts";
import { spawnSync } from "node:child_process";

export const EXTERNAL_EFFECT_SCHEMA = "kxm.external-effect-receipt.v1" as const;

export const DEFAULT_LEASE_TIMEOUT_MS = 300_000; // 300s (5 minutes) per Decision Q6
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000; // 30s per Decision Q6

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
  lastHeartbeatAt?: string | undefined;
  completedAt?: string | undefined;
  /** The hub lease this effect executes under, for shared kinds only. The
   * ledger's own CAS is per run/step; this pair is what fences the effect
   * against a writer on another box. */
  leaseResource?: string | undefined;
  fencingToken?: number | undefined;
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

// v1 → v2 adds the hub lease identity a shared effect executes under. There is no
// migration lane here either: an older ledger file is refused at open, not reshaped.
const EXTERNAL_EFFECTS_SCHEMA_VERSION = 2;

const EXTERNAL_EFFECTS_DDL = `
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
  last_heartbeat_at TEXT,
  completed_at TEXT,
  lease_resource TEXT,
  fencing_token INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ext_effects_run ON external_effects(run_id);
`;

const EXTERNAL_EFFECTS_SHAPE = {
  external_effects: [
    "effect_key", "run_id", "step_id", "attempt_id", "action_kind", "target_ref",
    "status", "payload_hash", "receipt_payload", "executed_at", "last_heartbeat_at", "completed_at",
    "lease_resource", "fencing_token",
  ],
} as const;

interface EffectRow {
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
  last_heartbeat_at: string | null;
  completed_at: string | null;
  lease_resource: string | null;
  fencing_token: number | null;
}

function receiptFromRow(row: EffectRow): ExternalEffectReceipt {
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
    lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    leaseResource: row.lease_resource ?? undefined,
    fencingToken: row.fencing_token ?? undefined,
  };
}

export class ExternalEffectsLedger {
  private db: DatabaseSync;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    // Goes through the shared opener, not a bare `new DatabaseSync`: that is what gives this
    // store the same contract as every other one — path checks, WAL, the `user_version` gate
    // that refuses an older stamp outright, and the column-shape check that turns a missing
    // column into `runtime_schema_shape_invalid` here instead of a bare SQL error on first use.
    this.db = openDatabase(dbPath, "external effects ledger", {
      schema: EXTERNAL_EFFECTS_DDL,
      version: EXTERNAL_EFFECTS_SCHEMA_VERSION,
      tables: EXTERNAL_EFFECTS_SHAPE,
    });
  }

  /**
   * Preflight Check-And-Set (CAS):
   * Guarantees that an external mutation is only initiated if not already committed or currently in-flight.
   * Auto-reclaims stale leases after timeoutMs (default 300s per Decision Q6).
   */
  claimEffect(input: {
    runId: string;
    stepId: string;
    attemptId: string;
    actionKind: ExternalActionKind;
    targetRef: string;
    payload?: Record<string, unknown> | undefined;
    timeoutMs?: number | undefined;
    /** The hub lease this effect runs under. Shared kinds carry it; unique
     * namespaces (`git-branch`, `git-commit`) leave it unset. */
    leaseResource?: string | undefined;
    fencingToken?: number | undefined;
  }): { ok: true; effectKey: string } | { ok: false; error: string; existing?: ExternalEffectReceipt } {
    const effectKey = computeEffectKey(input.runId, input.stepId, input.actionKind, input.targetRef);
    const now = new Date().toISOString();
    const payloadStr = JSON.stringify(input.payload ?? {});
    const payloadHash = createHash("sha256").update(payloadStr).digest("hex");
    const timeout = input.timeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;

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
        const lastActivity = existing.lastHeartbeatAt ?? existing.executedAt;
        const elapsed = Date.now() - Date.parse(lastActivity);
        if (elapsed < timeout) {
          return {
            ok: false,
            error: `effect_in_flight: ${input.actionKind} on ${input.targetRef} is currently executing`,
            existing,
          };
        }
        // If timed out, allow reclaim by updating status and timestamps
      }
    }

    const stmt = this.db.prepare(`
      INSERT INTO external_effects (
        effect_key, run_id, step_id, attempt_id, action_kind, target_ref,
        status, payload_hash, receipt_payload, executed_at, last_heartbeat_at,
        lease_resource, fencing_token
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(effect_key) DO UPDATE SET
        attempt_id = excluded.attempt_id,
        status = 'in-flight',
        executed_at = excluded.executed_at,
        last_heartbeat_at = excluded.last_heartbeat_at,
        payload_hash = excluded.payload_hash,
        receipt_payload = excluded.receipt_payload,
        lease_resource = excluded.lease_resource,
        fencing_token = excluded.fencing_token
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
      now,
      input.leaseResource ?? null,
      input.fencingToken ?? null,
    );

    return { ok: true, effectKey };
  }

  /**
   * Refreshes the lease heartbeat for an in-flight effect (Decision Q6).
   * Workers invoke this periodically (default 30s) while performing side-effects.
   */
  heartbeatEffect(effectKey: string): { ok: true; lastHeartbeatAt: string } | { ok: false; error: string } {
    const existing = this.getReceipt(effectKey);
    if (!existing) {
      return { ok: false, error: `effect_not_found: effect ${effectKey} does not exist` };
    }
    if (existing.status !== "in-flight") {
      return {
        ok: false,
        error: `effect_not_in_flight: cannot heartbeat effect in status '${existing.status}'`,
      };
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE external_effects
      SET last_heartbeat_at = ?
      WHERE effect_key = ? AND status = 'in-flight'
    `);
    stmt.run(now, effectKey);
    return { ok: true, lastHeartbeatAt: now };
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
    const row = stmt.get(effectKey) as EffectRow | undefined;
    if (!row) return undefined;
    return receiptFromRow(row);
  }

  listRunEffects(runId: string): ExternalEffectReceipt[] {
    const stmt = this.db.prepare(`
      SELECT * FROM external_effects WHERE run_id = ? ORDER BY executed_at ASC
    `);
    const rows = stmt.all(runId) as unknown as EffectRow[];
    return rows.map(receiptFromRow);
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Shared effects under a fenced hub lease (P3)
// ---------------------------------------------------------------------------

/**
 * The lease surface a shared effect needs. Declared structurally so this module
 * stays a leaf: `HubClient` satisfies it as written, and a test can stand in a
 * stub without a hub.
 */
export interface EffectLeaseGateway {
  acquireLease(resource: string, ttlMs?: number): Promise<{ lease: EffectLease; renewed: boolean }>;
  renewLease(resource: string, fencingToken: number, ttlMs?: number): Promise<{ lease: EffectLease }>;
  releaseLease(resource: string, fencingToken: number): Promise<{ released: boolean }>;
}

export interface EffectLease {
  resource: string;
  fencingToken: number;
  expiresAt: string;
  holderAgentId?: string | undefined;
  holderAgentName?: string | undefined;
}

export type SharedEffectRefusalCode =
  /** No lease could be obtained: no gateway was bound, or the hub was unreachable. */
  | "effect_lease_unavailable"
  /** Another agent holds the resource right now. */
  | "effect_lease_held"
  /** The hub has moved past the token this effect holds. */
  | "effect_lease_superseded"
  | "effect_already_committed"
  | "effect_in_flight"
  | "effect_not_in_flight"
  | "effect_not_found";

/** The engine's attempt state for an effect whose outcome cannot be proven. */
export type EffectAttemptState = "blocked_uncertain";

export interface SharedEffectRefusal {
  ok: false;
  code: SharedEffectRefusalCode;
  error: string;
  /** Present when the effect may already have touched the outside world. The
   * attempt parks here and nothing retries it. */
  attemptState?: EffectAttemptState | undefined;
  existing?: ExternalEffectReceipt | undefined;
}

export interface SharedEffectClaim {
  ok: true;
  effectKey: string;
  leaseResource?: string | undefined;
  fencingToken?: number | undefined;
}

/** Kinds whose target is shared with every other box: two runs naming the same
 * `targetRef` mean the same real thing, so exactly one may execute. */
export const SHARED_EFFECT_KINDS: readonly ExternalActionKind[] = Object.freeze([
  "git-push",
  "pr-create",
  "tracker-issue",
  "webhook",
]);

/** Does `targetRef` name a branch this run owns? A run branch is a unique
 * namespace — `deterministicRunBranch` derives it from the run id in all three
 * of its formats — so pushing it contends with nobody. */
export function isRunBranchRef(runId: string, targetRef: string): boolean {
  const cleanId = runId.replace(/^run_/, "");
  if (!cleanId) return false;
  const branch = targetRef.replace(/^refs\/heads\//, "");
  if (!branch.startsWith("kxm/")) return false;
  return branch === `kxm/run-${cleanId}`
    || branch.startsWith(`kxm/run-${cleanId}-`)
    || branch.endsWith(`-run-${cleanId}`);
}

/**
 * Whether an effect must hold a hub lease before it executes.
 *
 * `git-branch` and `git-commit` write a namespace this run already owns, so
 * they stay lease-free. A `git-push` to this run's own branch is the same case;
 * a push to any other ref is shared and is fenced.
 */
export function effectRequiresHubLease(
  actionKind: ExternalActionKind,
  targetRef: string,
  runId: string,
): boolean {
  if (!SHARED_EFFECT_KINDS.includes(actionKind)) return false;
  if (actionKind === "git-push") return !isRunBranchRef(runId, targetRef);
  return true;
}

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A refusal the hub stated about the lease itself, as opposed to not reaching
 * the hub at all. Any of these means the token is gone for good. */
function isLeaseLost(code: string | undefined): boolean {
  return code === "lease_superseded" || code === "lease_expired" || code === "lease_not_found";
}

/**
 * Claim an external effect, taking its hub lease first when the kind is shared.
 *
 * The lease comes before the ledger row on purpose: the receipt records the
 * token it will have to present at commit, and a claim that cannot be fenced
 * never becomes a claim at all. A shared effect with an unreachable hub is
 * refused with `effect_lease_unavailable` and executes nothing — running it
 * unfenced is exactly the two-writer failure the lease exists to prevent.
 */
export async function claimSharedEffect(input: {
  ledger: ExternalEffectsLedger;
  lease?: EffectLeaseGateway | undefined;
  runId: string;
  stepId: string;
  attemptId: string;
  actionKind: ExternalActionKind;
  targetRef: string;
  payload?: Record<string, unknown> | undefined;
  timeoutMs?: number | undefined;
  /** Lease TTL. Defaults to the Q6 lease timeout so the existing heartbeat
   * interval renews it well inside its deadline. */
  leaseTtlMs?: number | undefined;
}): Promise<SharedEffectClaim | SharedEffectRefusal> {
  const needsLease = effectRequiresHubLease(input.actionKind, input.targetRef, input.runId);
  let lease: EffectLease | undefined;

  if (needsLease) {
    if (!input.lease) {
      return {
        ok: false,
        code: "effect_lease_unavailable",
        error: `effect_lease_unavailable: ${input.actionKind} on ${input.targetRef} is shared and no hub lease is bound`,
      };
    }
    try {
      const acquired = await input.lease.acquireLease(input.targetRef, input.leaseTtlMs ?? DEFAULT_LEASE_TIMEOUT_MS);
      lease = acquired.lease;
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === "lease_held") {
        return {
          ok: false,
          code: "effect_lease_held",
          error: `effect_lease_held: ${input.targetRef} is leased by another agent: ${errorText(error)}`,
        };
      }
      return {
        ok: false,
        code: "effect_lease_unavailable",
        error: `effect_lease_unavailable: could not reach the bound hub for ${input.targetRef}: ${errorText(error)}`,
      };
    }
  }

  const claimed = input.ledger.claimEffect({
    runId: input.runId,
    stepId: input.stepId,
    attemptId: input.attemptId,
    actionKind: input.actionKind,
    targetRef: input.targetRef,
    payload: input.payload,
    timeoutMs: input.timeoutMs,
    ...(lease ? { leaseResource: lease.resource, fencingToken: lease.fencingToken } : {}),
  });

  if (!claimed.ok) {
    // The ledger refused after the lease was taken, so give the resource back
    // rather than parking it until the TTL runs out.
    if (lease && input.lease) await releaseQuietly(input.lease, input.targetRef, lease.fencingToken);
    return {
      ok: false,
      code: claimed.error.startsWith("effect_already_committed") ? "effect_already_committed" : "effect_in_flight",
      error: claimed.error,
      existing: claimed.existing,
    };
  }

  return {
    ok: true,
    effectKey: claimed.effectKey,
    ...(lease ? { leaseResource: lease.resource, fencingToken: lease.fencingToken } : {}),
  };
}

/**
 * The Q6 heartbeat for a shared effect: renew the hub lease under the same
 * token, then refresh the ledger's own lease timestamp.
 *
 * A hub that has moved past the token parks the attempt — the effect may
 * already have touched the outside world, and the resource now belongs to
 * someone else.
 */
export async function heartbeatSharedEffect(input: {
  ledger: ExternalEffectsLedger;
  lease?: EffectLeaseGateway | undefined;
  effectKey: string;
  leaseTtlMs?: number | undefined;
}): Promise<{ ok: true; lastHeartbeatAt: string; leaseExpiresAt?: string } | SharedEffectRefusal> {
  const receipt = input.ledger.getReceipt(input.effectKey);
  if (!receipt) {
    return { ok: false, code: "effect_not_found", error: `effect_not_found: effect ${input.effectKey} does not exist` };
  }

  let leaseExpiresAt: string | undefined;
  if (receipt.leaseResource !== undefined && receipt.fencingToken !== undefined) {
    if (!input.lease) {
      return {
        ok: false,
        code: "effect_lease_unavailable",
        error: `effect_lease_unavailable: ${receipt.targetRef} holds a hub lease but no gateway is bound`,
      };
    }
    try {
      const renewed = await input.lease.renewLease(
        receipt.targetRef,
        receipt.fencingToken,
        input.leaseTtlMs ?? DEFAULT_LEASE_TIMEOUT_MS,
      );
      leaseExpiresAt = renewed.lease.expiresAt;
    } catch (error) {
      const code = errorCodeOf(error);
      if (isLeaseLost(code)) {
        return {
          ok: false,
          code: "effect_lease_superseded",
          error: `effect_lease_superseded: the hub no longer recognises token ${receipt.fencingToken} on ${receipt.targetRef}: ${errorText(error)}`,
          attemptState: "blocked_uncertain",
          existing: receipt,
        };
      }
      return {
        ok: false,
        code: "effect_lease_unavailable",
        error: `effect_lease_unavailable: could not renew the lease on ${receipt.targetRef}: ${errorText(error)}`,
        existing: receipt,
      };
    }
  }

  const beat = input.ledger.heartbeatEffect(input.effectKey);
  if (!beat.ok) {
    // The row exists — `getReceipt` just read it — so the only remaining refusal
    // is a status that no longer accepts a heartbeat.
    return { ok: false, code: "effect_not_in_flight", error: beat.error, existing: receipt };
  }
  return { ok: true, lastHeartbeatAt: beat.lastHeartbeatAt, ...(leaseExpiresAt ? { leaseExpiresAt } : {}) };
}

/**
 * Commit a shared effect, but only while the hub still recognises its token.
 *
 * The token is re-presented before the receipt is written. If the hub has
 * superseded it — or cannot be reached to say either way — the effect is left
 * `in-flight` and the attempt parks `blocked_uncertain`. Nothing retries: the
 * write may or may not have landed, and re-running it is how a second writer
 * lands the same change twice.
 */
export async function commitSharedEffect(input: {
  ledger: ExternalEffectsLedger;
  lease?: EffectLeaseGateway | undefined;
  effectKey: string;
  receiptPayload: Record<string, unknown>;
  leaseTtlMs?: number | undefined;
}): Promise<{ ok: true; receipt: ExternalEffectReceipt } | SharedEffectRefusal> {
  const receipt = input.ledger.getReceipt(input.effectKey);
  if (!receipt) {
    return { ok: false, code: "effect_not_found", error: `effect_not_found: effect ${input.effectKey} does not exist` };
  }

  const fenced = receipt.leaseResource !== undefined && receipt.fencingToken !== undefined;
  if (fenced) {
    if (!input.lease) {
      return {
        ok: false,
        code: "effect_lease_unavailable",
        error: `effect_lease_unavailable: ${receipt.targetRef} holds a hub lease but no gateway is bound`,
        attemptState: "blocked_uncertain",
        existing: receipt,
      };
    }
    try {
      await input.lease.renewLease(receipt.targetRef, receipt.fencingToken!, input.leaseTtlMs ?? DEFAULT_LEASE_TIMEOUT_MS);
    } catch (error) {
      const code = errorCodeOf(error);
      return {
        ok: false,
        code: isLeaseLost(code) ? "effect_lease_superseded" : "effect_lease_unavailable",
        error: isLeaseLost(code)
          ? `effect_lease_superseded: token ${receipt.fencingToken} on ${receipt.targetRef} was superseded before commit: ${errorText(error)}`
          : `effect_lease_unavailable: the lease on ${receipt.targetRef} could not be confirmed before commit: ${errorText(error)}`,
        attemptState: "blocked_uncertain",
        existing: input.ledger.getReceipt(input.effectKey),
      };
    }
  }

  input.ledger.commitEffect(input.effectKey, input.receiptPayload);
  if (fenced && input.lease) {
    await releaseQuietly(input.lease, receipt.targetRef, receipt.fencingToken!);
  }
  return { ok: true, receipt: input.ledger.getReceipt(input.effectKey)! };
}

/** Hand the resource back. `resource` is always the name the caller asked for,
 * never the hub's project-scoped form — the hub applies that prefix itself, and
 * passing it back would name a second resource. A failed release is not an
 * error the caller can act on: the lease falls to its deadline on the hub
 * clock. */
async function releaseQuietly(gateway: EffectLeaseGateway, resource: string, fencingToken: number): Promise<void> {
  try {
    await gateway.releaseLease(resource, fencingToken);
  } catch {
    // Deliberately swallowed: the TTL frees it.
  }
}

export interface WorktreeLock {
  lockPath: string;
  release: () => void;
}

/**
 * Resolves the lockfile location for concurrent git worktree modifications.
 * By default targets .git/kxm-worktree.lock, or if in a linked worktree, targets the main git directory.
 */
export function resolveWorktreeLockPath(repoRoot: string): string {
  const gitPath = join(repoRoot, ".git");
  if (existsSync(gitPath)) {
    try {
      const stat = lstatSync(gitPath);
      if (stat.isDirectory()) {
        return join(gitPath, "kxm-worktree.lock");
      }
      if (stat.isFile()) {
        const content = readFileSync(gitPath, "utf8").trim();
        const match = content.match(/^gitdir:\s*(.+)$/i);
        if (match && match[1]) {
          const resolvedGitDir = resolve(repoRoot, match[1]);
          return join(resolvedGitDir, "kxm-worktree.lock");
        }
      }
    } catch {
      // Fall back
    }
  }
  return join(repoRoot, ".kxm-worktree.lock");
}

/**
 * Acquires an exclusive file-based lock for worktree mutations.
 * Supports auto-breaking stale locks if the holding process has died or timed out.
 */
export function acquireWorktreeLock(
  repoRoot: string,
  options?: {
    timeoutMs?: number | undefined;
    staleTimeoutMs?: number | undefined;
    pollIntervalMs?: number | undefined;
  },
): { ok: true; lock: WorktreeLock } | { ok: false; error: string } {
  const lockPath = resolveWorktreeLockPath(repoRoot);
  const timeoutMs = options?.timeoutMs ?? 5_000;
  const staleTimeoutMs = options?.staleTimeoutMs ?? 30_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 50;
  const startTime = Date.now();

  mkdirSync(dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      const metadata = JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        repoRoot,
      });
      writeFileSync(fd, metadata, "utf8");
      closeSync(fd);

      return {
        ok: true,
        lock: {
          lockPath,
          release: () => {
            try {
              unlinkSync(lockPath);
            } catch {
              // Ignore if already unlinked
            }
          },
        },
      };
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") {
        return { ok: false, error: `lock_io_error: ${(err as Error).message}` };
      }

      // Existing lock found - check for staleness
      try {
        const content = readFileSync(lockPath, "utf8");
        const parsed = JSON.parse(content) as { pid?: number; acquiredAt?: string };
        let isStale = false;

        if (parsed.acquiredAt) {
          const age = Date.now() - Date.parse(parsed.acquiredAt);
          if (age > staleTimeoutMs) {
            isStale = true;
          }
        }

        if (parsed.pid && typeof parsed.pid === "number") {
          try {
            process.kill(parsed.pid, 0);
          } catch (e: unknown) {
            if ((e as { code?: string }).code === "ESRCH") {
              isStale = true; // Process dead
            }
          }
        }

        if (isStale) {
          try {
            unlinkSync(lockPath);
            continue; // Immediately retry lock
          } catch {
            // Already unlinked or contention
          }
        }
      } catch {
        // Corrupt lock file
        try {
          unlinkSync(lockPath);
          continue;
        } catch {
          // Ignore
        }
      }

      if (Date.now() - startTime >= timeoutMs) {
        return {
          ok: false,
          error: `lock_timeout: timed out after ${timeoutMs}ms waiting for worktree lock at ${lockPath}`,
        };
      }

      if (pollIntervalMs > 0) {
        const waitBuf = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(waitBuf, 0, 0, pollIntervalMs);
      }
    }
  }
}

/**
 * Runs a function inside an exclusive worktree lock.
 */
export async function withWorktreeLock<T>(
  repoRoot: string,
  fn: () => T | Promise<T>,
  options?: {
    timeoutMs?: number | undefined;
    staleTimeoutMs?: number | undefined;
    pollIntervalMs?: number | undefined;
  },
): Promise<T> {
  const res = acquireWorktreeLock(repoRoot, options);
  if (!res.ok) {
    throw new Error(`worktree_lock_failed: ${res.error}`);
  }
  try {
    return await fn();
  } finally {
    res.lock.release();
  }
}

export interface BranchCleanupOptions {
  removeWorktree?: boolean | undefined;
  deleteRemote?: boolean | undefined;
  remoteName?: string | undefined;
  execFn?: ((cmd: string, args: string[]) => { status: number; stdout: string; stderr: string }) | undefined;
}

export interface BranchCleanupResult {
  ok: boolean;
  branchName: string;
  deletedLocalBranch: boolean;
  deletedRemoteBranch: boolean;
  removedWorktreePath?: string | undefined;
  error?: string | undefined;
}

/**
 * Deterministic Branch Cleanup (Decision Q7).
 * Removes associated git worktrees and deletes the local (and optionally remote) run branch.
 */
export function cleanupMergedRunBranch(
  repoRoot: string,
  branchName: string,
  options?: BranchCleanupOptions,
): BranchCleanupResult {
  const runner = options?.execFn ?? ((cmd: string, args: string[]) => {
    const res = spawnSync(cmd, args, {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
      ),
    });
    return {
      status: res.status ?? 1,
      stdout: res.stdout || "",
      stderr: res.stderr || "",
    };
  });

  const shouldRemoveWorktree = options?.removeWorktree ?? true;
  let removedWorktreePath: string | undefined;
  let deletedLocalBranch = false;
  let deletedRemoteBranch = false;

  // 1. Remove worktree if one is attached to this branch
  if (shouldRemoveWorktree) {
    try {
      const wtList = runner("git", ["worktree", "list", "--porcelain"]);
      if (wtList.status === 0) {
        const blocks = wtList.stdout.split(/\n\n+/);
        for (const block of blocks) {
          const lines = block.trim().split("\n");
          let wtPath: string | undefined;
          let wtBranch: string | undefined;
          for (const line of lines) {
            if (line.startsWith("worktree ")) {
              wtPath = line.substring("worktree ".length).trim();
            } else if (line.startsWith("branch ")) {
              wtBranch = line.substring("branch ".length).trim();
            }
          }
          if (wtPath && wtBranch && (wtBranch === `refs/heads/${branchName}` || wtBranch === branchName)) {
            const rmRes = runner("git", ["worktree", "remove", "--force", wtPath]);
            if (rmRes.status === 0) {
              removedWorktreePath = wtPath;
            } else {
              return {
                ok: false,
                branchName,
                deletedLocalBranch: false,
                deletedRemoteBranch: false,
                error: `failed_to_remove_worktree: ${rmRes.stderr.trim() || rmRes.stdout.trim()}`,
              };
            }
          }
        }
      }
    } catch (err: unknown) {
      return {
        ok: false,
        branchName,
        deletedLocalBranch: false,
        deletedRemoteBranch: false,
        error: `worktree_inspection_failed: ${(err as Error).message}`,
      };
    }
  }

  // 2. Delete local branch if it exists
  const checkBranch = runner("git", ["rev-parse", "--verify", `refs/heads/${branchName}`]);
  if (checkBranch.status === 0) {
    const delRes = runner("git", ["branch", "-D", branchName]);
    if (delRes.status === 0) {
      deletedLocalBranch = true;
    } else {
      return {
        ok: false,
        branchName,
        deletedLocalBranch: false,
        deletedRemoteBranch: false,
        ...(removedWorktreePath ? { removedWorktreePath } : {}),
        error: `failed_to_delete_local_branch: ${delRes.stderr.trim() || delRes.stdout.trim()}`,
      };
    }
  }

  // 3. Delete remote branch if requested
  if (options?.deleteRemote) {
    const remote = options.remoteName || "origin";
    const remoteDelRes = runner("git", ["push", remote, "--delete", branchName]);
    if (remoteDelRes.status === 0) {
      deletedRemoteBranch = true;
    } else {
      return {
        ok: false,
        branchName,
        deletedLocalBranch,
        deletedRemoteBranch: false,
        ...(removedWorktreePath ? { removedWorktreePath } : {}),
        error: `failed_to_delete_remote_branch: ${remoteDelRes.stderr.trim() || remoteDelRes.stdout.trim()}`,
      };
    }
  }

  return {
    ok: true,
    branchName,
    deletedLocalBranch,
    deletedRemoteBranch,
    ...(removedWorktreePath ? { removedWorktreePath } : {}),
  };
}

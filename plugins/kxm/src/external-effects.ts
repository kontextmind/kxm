/**
 * KXM External Side-Effect Idempotency (Slice C)
 * Ensures deterministic branching, preflight CAS checks, and immutable receipts for external mutations.
 */

import { DatabaseSync } from "node:sqlite";
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
        last_heartbeat_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ext_effects_run ON external_effects(run_id);
    `);
    try {
      this.db.exec(`ALTER TABLE external_effects ADD COLUMN last_heartbeat_at TEXT;`);
    } catch {
      // Column already present in schema
    }
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
        status, payload_hash, receipt_payload, executed_at, last_heartbeat_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(effect_key) DO UPDATE SET
        attempt_id = excluded.attempt_id,
        status = 'in-flight',
        executed_at = excluded.executed_at,
        last_heartbeat_at = excluded.last_heartbeat_at,
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
      now,
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
      last_heartbeat_at: string | null;
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
      lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
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
      last_heartbeat_at: string | null;
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
      lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
    }));
  }

  close(): void {
    this.db.close();
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

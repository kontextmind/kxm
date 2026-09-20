import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "../../plugins/kxm/src/sqlite.ts";
import {
  ExternalEffectsLedger,
  deterministicRunBranch,
  computeEffectKey,
  EXTERNAL_EFFECT_SCHEMA,
  DEFAULT_LEASE_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  resolveWorktreeLockPath,
  acquireWorktreeLock,
  withWorktreeLock,
  cleanupMergedRunBranch,
} from "../../plugins/kxm/src/external-effects.ts";

test("deterministicRunBranch generates deterministic kxm/run-<id> branches", () => {
  assert.equal(deterministicRunBranch("run_12345678"), "kxm/run-12345678");
  assert.equal(deterministicRunBranch("998877"), "kxm/run-998877");
});

test("deterministicRunBranch generates human-readable descriptive branch names", () => {
  // String description
  assert.equal(
    deterministicRunBranch("run_12345678", "Fix memory arbiter & TUI!"),
    "kxm/run-12345678-fix-memory-arbiter-tui",
  );

  // Structured options with workflow and issue
  assert.equal(
    deterministicRunBranch("run_01928abc", {
      workflowId: "fix-issue-127",
      issueKey: "issue-127",
      description: "memory arbiter",
    }),
    "kxm/run-01928abc-fix-issue-127-memory-arbiter",
  );

  // prefix-run format
  assert.equal(
    deterministicRunBranch("run_01928abc", {
      workflowId: "fix-issue-127",
      description: "memory-arbiter",
      format: "prefix-run",
    }),
    "kxm/fix-issue-127-memory-arbiter-run-01928abc",
  );

  // Empty or punctuation-only strings fall back safely
  assert.equal(deterministicRunBranch("run_alpha", "---...---"), "kxm/run-alpha");
});

test("computeEffectKey creates deterministic sha256-derived effect key", () => {
  const key1 = computeEffectKey("run_1", "step_a", "git-branch", "kxm/run-1");
  const key2 = computeEffectKey("run_1", "step_a", "git-branch", "kxm/run-1");
  const key3 = computeEffectKey("run_1", "step_b", "git-branch", "kxm/run-1");

  assert.equal(key1, key2);
  assert.notEqual(key1, key3);
  assert.match(key1, /^eff_[a-f0-9]{16}$/);
});

test("ExternalEffectsLedger enforces preflight CAS and commit lifecycle", () => {
  const ledger = new ExternalEffectsLedger(":memory:");

  // 1. First claim succeeds
  const claim1 = ledger.claimEffect({
    runId: "run_alpha",
    stepId: "step_01",
    attemptId: "att_01",
    actionKind: "git-branch",
    targetRef: "kxm/run-alpha",
    payload: { branch: "kxm/run-alpha" },
  });
  assert.equal(claim1.ok, true);
  if (!claim1.ok) return;

  const effectKey = claim1.effectKey;
  const initialReceipt = ledger.getReceipt(effectKey);
  assert.ok(initialReceipt);
  assert.equal(initialReceipt?.schema, EXTERNAL_EFFECT_SCHEMA);
  assert.equal(initialReceipt?.status, "in-flight");
  assert.ok(initialReceipt?.lastHeartbeatAt);

  // 2. Second claim while in-flight is rejected
  const claim2 = ledger.claimEffect({
    runId: "run_alpha",
    stepId: "step_01",
    attemptId: "att_02",
    actionKind: "git-branch",
    targetRef: "kxm/run-alpha",
  });
  assert.equal(claim2.ok, false);
  if (claim2.ok) return;
  assert.match(claim2.error, /effect_in_flight/);

  // 3. Commit effect
  ledger.commitEffect(effectKey, { createdBranchSha: "abcdef123" });
  const committedReceipt = ledger.getReceipt(effectKey);
  assert.equal(committedReceipt?.status, "committed");
  assert.equal(committedReceipt?.receiptPayload["createdBranchSha"], "abcdef123");

  // 4. Claim after commit is rejected as already committed
  const claim3 = ledger.claimEffect({
    runId: "run_alpha",
    stepId: "step_01",
    attemptId: "att_03",
    actionKind: "git-branch",
    targetRef: "kxm/run-alpha",
  });
  assert.equal(claim3.ok, false);
  if (claim3.ok) return;
  assert.match(claim3.error, /effect_already_committed/);

  // 5. Query list of run effects
  const runEffects = ledger.listRunEffects("run_alpha");
  assert.equal(runEffects.length, 1);
  assert.equal(runEffects[0]?.status, "committed");

  ledger.close();
});

test("ExternalEffectsLedger lease heartbeats and stale reclaim recovery (Decision Q6)", async () => {
  assert.equal(DEFAULT_LEASE_TIMEOUT_MS, 300_000);
  assert.equal(DEFAULT_HEARTBEAT_INTERVAL_MS, 30_000);

  const ledger = new ExternalEffectsLedger(":memory:");

  // Claim with 100ms timeout
  const claim = ledger.claimEffect({
    runId: "run_crash_test",
    stepId: "step_pr",
    attemptId: "att_01",
    actionKind: "pr-create",
    targetRef: "pull/42",
    timeoutMs: 100,
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  const effectKey = claim.effectKey;
  const initial = ledger.getReceipt(effectKey);
  assert.ok(initial?.lastHeartbeatAt);

  // Heartbeat updates timestamp
  const hb1 = ledger.heartbeatEffect(effectKey);
  assert.equal(hb1.ok, true);
  const updated = ledger.getReceipt(effectKey);
  assert.ok(updated?.lastHeartbeatAt);

  // Heartbeat on non-existent effect fails
  const badHb = ledger.heartbeatEffect("eff_doesnotexist");
  assert.equal(badHb.ok, false);

  // Immediate claim within timeout should fail
  const immediateClaim = ledger.claimEffect({
    runId: "run_crash_test",
    stepId: "step_pr",
    attemptId: "att_02",
    actionKind: "pr-create",
    targetRef: "pull/42",
    timeoutMs: 100,
  });
  assert.equal(immediateClaim.ok, false);

  // Wait past 100ms timeout to simulate worker crash
  await new Promise((resolve) => setTimeout(resolve, 120));

  // Stale lease auto-reclaims
  const reclaim = ledger.claimEffect({
    runId: "run_crash_test",
    stepId: "step_pr",
    attemptId: "att_03",
    actionKind: "pr-create",
    targetRef: "pull/42",
    timeoutMs: 100,
  });
  assert.equal(reclaim.ok, true);

  const reclaimedReceipt = ledger.getReceipt(effectKey);
  assert.equal(reclaimedReceipt?.attemptId, "att_03");
  assert.equal(reclaimedReceipt?.status, "in-flight");

  ledger.close();
});

test("Worktree locking provides mutual exclusion and stale lock recovery", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "kxm-wt-lock-"));
  try {
    const lockPath = resolveWorktreeLockPath(tempDir);
    assert.match(lockPath, /kxm-worktree\.lock/);

    // 1. Acquire first lock
    const lock1 = acquireWorktreeLock(tempDir, { timeoutMs: 500 });
    assert.equal(lock1.ok, true);
    if (!lock1.ok) return;

    // 2. Second acquire fails fast due to contention
    const lock2 = acquireWorktreeLock(tempDir, { timeoutMs: 100, pollIntervalMs: 20 });
    assert.equal(lock2.ok, false);
    if (!lock2.ok) {
      assert.match(lock2.error, /lock_timeout/);
    }

    // 3. Release first lock
    lock1.lock.release();

    // 4. Now second acquire succeeds
    const lock3 = acquireWorktreeLock(tempDir, { timeoutMs: 500 });
    assert.equal(lock3.ok, true);
    if (lock3.ok) lock3.lock.release();

    // 5. Test withWorktreeLock helper
    const value = await withWorktreeLock(tempDir, async () => {
      return 42;
    });
    assert.equal(value, 42);

    // 6. Test stale lock recovery with dead PID
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999999, acquiredAt: new Date(Date.now() - 60_000).toISOString() }),
      "utf8",
    );
    const lockRecovered = acquireWorktreeLock(tempDir, { timeoutMs: 500 });
    assert.equal(lockRecovered.ok, true);
    if (lockRecovered.ok) lockRecovered.lock.release();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cleanupMergedRunBranch removes worktree, deletes branch and remote (Decision Q7)", () => {
  const executedCommands: Array<{ cmd: string; args: string[] }> = [];

  const mockRunner = (cmd: string, args: string[]) => {
    executedCommands.push({ cmd, args });
    if (cmd === "git" && args[0] === "worktree" && args[1] === "list") {
      return {
        status: 0,
        stdout: [
          "worktree /repo/root",
          "HEAD 111111",
          "branch refs/heads/main",
          "",
          "worktree /repo/.kxm/wt/run-01",
          "HEAD 222222",
          "branch refs/heads/kxm/run-01-fix",
          "",
        ].join("\n"),
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  const res = cleanupMergedRunBranch("/repo/root", "kxm/run-01-fix", {
    removeWorktree: true,
    deleteRemote: true,
    remoteName: "origin",
    execFn: mockRunner,
  });

  assert.equal(res.ok, true);
  assert.equal(res.deletedLocalBranch, true);
  assert.equal(res.deletedRemoteBranch, true);
  assert.equal(res.removedWorktreePath, "/repo/.kxm/wt/run-01");

  // Verify commands executed
  const worktreeRemove = executedCommands.find(
    (c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "remove",
  );
  assert.ok(worktreeRemove);
  assert.deepEqual(worktreeRemove?.args, ["worktree", "remove", "--force", "/repo/.kxm/wt/run-01"]);

  const branchDelete = executedCommands.find(
    (c) => c.cmd === "git" && c.args[0] === "branch" && c.args[1] === "-D",
  );
  assert.ok(branchDelete);
  assert.deepEqual(branchDelete?.args, ["branch", "-D", "kxm/run-01-fix"]);

  const remoteDelete = executedCommands.find(
    (c) => c.cmd === "git" && c.args[0] === "push" && c.args[2] === "--delete",
  );
  assert.ok(remoteDelete);
  assert.deepEqual(remoteDelete?.args, ["push", "origin", "--delete", "kxm/run-01-fix"]);
});

test("ExternalEffectsLedger abortEffect and heartbeat validation", () => {
  const ledger = new ExternalEffectsLedger(":memory:");
  const claim = ledger.claimEffect({
    runId: "run_abort",
    stepId: "step_01",
    attemptId: "att_01",
    actionKind: "git-branch",
    targetRef: "kxm/run-abort",
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  ledger.abortEffect(claim.effectKey, "operator_cancelled");
  const aborted = ledger.getReceipt(claim.effectKey);
  assert.equal(aborted?.status, "aborted");
  assert.equal(aborted?.receiptPayload["error"], "operator_cancelled");

  // Heartbeat on aborted effect fails
  const hbRes = ledger.heartbeatEffect(claim.effectKey);
  assert.equal(hbRes.ok, false);
  if (!hbRes.ok) {
    assert.match(hbRes.error, /effect_not_in_flight/);
  }
  ledger.close();
});

test("cleanupMergedRunBranch handles failure modes gracefully", () => {
  // 1. Worktree removal failure
  const failWtRemove = cleanupMergedRunBranch("/repo", "kxm/run-wt-fail", {
    removeWorktree: true,
    execFn: (cmd, args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return { status: 0, stdout: "worktree /tmp/wt\nbranch refs/heads/kxm/run-wt-fail\n\n", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        return { status: 1, stdout: "", stderr: "permission denied" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(failWtRemove.ok, false);
  assert.match(failWtRemove.error || "", /failed_to_remove_worktree/);

  // 2. Worktree inspection throws
  const throwWtInspect = cleanupMergedRunBranch("/repo", "kxm/run-throw", {
    removeWorktree: true,
    execFn: (cmd, args) => {
      if (args[0] === "worktree" && args[1] === "list") throw new Error("git binary not found");
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(throwWtInspect.ok, false);
  assert.match(throwWtInspect.error || "", /worktree_inspection_failed/);

  // 3. Local branch delete failure
  const failBranchDel = cleanupMergedRunBranch("/repo", "kxm/run-del-fail", {
    removeWorktree: false,
    execFn: (cmd, args) => {
      if (args[0] === "rev-parse") return { status: 0, stdout: "abc", stderr: "" };
      if (args[0] === "branch" && args[1] === "-D") return { status: 1, stdout: "", stderr: "branch is locked" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(failBranchDel.ok, false);
  assert.match(failBranchDel.error || "", /failed_to_delete_local_branch/);

  // 4. Remote branch delete failure
  const failRemoteDel = cleanupMergedRunBranch("/repo", "kxm/run-remote-fail", {
    removeWorktree: false,
    deleteRemote: true,
    execFn: (cmd, args) => {
      if (args[0] === "rev-parse") return { status: 1, stdout: "", stderr: "" };
      if (args[0] === "push" && args[2] === "--delete") return { status: 1, stdout: "", stderr: "remote rejected" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(failRemoteDel.ok, false);
  assert.match(failRemoteDel.error || "", /failed_to_delete_remote_branch/);
});

test("an external-effects file written by the pre-refusal build is refused, not reshaped", () => {
  // Reproduction of the review finding: the ledger used to open its file with a bare
  // `new DatabaseSync`, so an older external_effects table (no last_heartbeat_at) survived
  // construction and only blew up later inside claimEffect as a raw SQL error. Opening now
  // goes through the shared version/shape gate, so the stale file is rejected up front and
  // left untouched.
  const dir = mkdtempSync(join(tmpdir(), "kxm-effects-stale-"));
  try {
    const file = join(dir, "effects.db");
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE external_effects (
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
    `);
    legacy.close();

    assert.throws(
      () => new ExternalEffectsLedger(file),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /runtime_schema_shape_invalid/, `expected a shape refusal, got: ${message}`);
        return true;
      },
      "a stale ledger file must be refused at open time",
    );

    const inspection = new DatabaseSync(file);
    try {
      const version = inspection.prepare("PRAGMA user_version").get() as { user_version: number };
      assert.equal(version.user_version, 0, "refusal must not stamp the store it rejected");
      const columns = (inspection.prepare("PRAGMA table_info(external_effects)").all() as Array<{ name: string }>)
        .map((column) => column.name);
      assert.ok(
        !columns.includes("last_heartbeat_at"),
        "refusal must not add the column it used to migrate in place",
      );
      assert.equal(columns.length, 11, "the rejected store must keep its original shape");
    } finally {
      inspection.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

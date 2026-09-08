import { strict as assert } from "node:assert";
import test from "node:test";
import {
  ExternalEffectsLedger,
  deterministicRunBranch,
  computeEffectKey,
  EXTERNAL_EFFECT_SCHEMA,
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

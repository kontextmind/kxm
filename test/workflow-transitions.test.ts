import assert from "node:assert/strict";
import test from "node:test";
import {
  checkpointRun,
  parseWorkflowDefinitions,
  validateWorkflowTransitions,
  type WorkflowRun,
  type WebhookWorkflowDefinition,
} from "../plugins/kxm-mesh/src/workflow.ts";

function definition(raw: Record<string, unknown>): WebhookWorkflowDefinition {
  const environment = { SECRET: "secret-value-with-entropy-16" };
  const [workflow] = parseWorkflowDefinitions(JSON.stringify([{
    id: "transitions",
    source: "generic",
    project: "test-project",
    target: "coordinator",
    secretEnv: "SECRET",
    delivery: "followUp",
    promptTemplate: "Handle {{task}}",
    ...raw,
  }]), environment);
  return workflow!;
}

function run(definition_: WebhookWorkflowDefinition): WorkflowRun {
  const createdAt = "2026-01-01T00:00:00.000Z";
  return {
    id: "run_trans1",
    definitionId: definition_.id,
    source: definition_.source,
    deliveryId: "delivery_1",
    payloadHash: "hash",
    project: definition_.project,
    targetAgentId: "agent_coord",
    targetAgentName: "coord",
    messageId: "msg_1",
    status: "running",
    currentStage: definition_.stages[0]!.id,
    ...(definition_.maxTransitions !== undefined ? { maxTransitions: definition_.maxTransitions } : {}),
    stages: definition_.stages.map((stage, index) => ({
      ...stage,
      status: index === 0 ? "in_progress" as const : "pending" as const,
      attempts: 0,
      evidence: {},
      ...(index === 0 ? { startedAt: createdAt } : {}),
    })),
    createdAt,
    updatedAt: createdAt,
  };
}

test("v0.4 workflows without transition maps behave identically", () => {
  const workflow = definition({
    stages: [
      { id: "implement", label: "Implement", instructions: "Do work", requiredEvidence: ["diff"], maxAttempts: 2 },
      { id: "verify", label: "Verify", instructions: "Check work", requiredEvidence: [], maxAttempts: 1 },
    ],
  });
  assert.equal(workflow.maxTransitions, undefined);
  const testRun = run(workflow);
  // Forward progression untouched.
  const passed = checkpointRun(testRun, "implement", "passed", "done", { diff: "abc" }, "2026-01-01T00:01:00.000Z");
  assert.equal(passed.completed, false);
  assert.equal(passed.transition, undefined);
  assert.equal(testRun.currentStage, "verify");
  assert.equal(testRun.transitions, undefined);
});

test("definition validation rejects unknown targets, forward skips, and budgetless cycles", () => {
  // Unknown target.
  assert.throws(
    () => definition({
      maxTransitions: 4,
      stages: [
        { id: "a", label: "A", instructions: "x", on: { passed: "missing" } },
      ],
    }),
    /targets unknown stage missing/,
  );
  // Forward skip over an intermediate stage (bypass protection): plan tries
  // to jump straight to implement, bypassing the approval stage.
  assert.throws(
    () => definition({
      maxTransitions: 4,
      stages: [
        { id: "plan", label: "Plan", instructions: "x", on: { passed: "implement" } },
        { id: "approval", label: "Approval", instructions: "x" },
        { id: "implement", label: "Implement", instructions: "x" },
      ],
    }),
    /skips intermediate stages/,
  );
  // Back-edge without a global budget.
  assert.throws(
    () => definition({
      stages: [
        { id: "implement", label: "Implement", instructions: "x" },
        { id: "verify", label: "Verify", instructions: "x", on: { implementation_failure: "implement" } },
      ],
    }),
    /no maxTransitions budget/,
  );
  // Invalid per-edge budget.
  assert.throws(
    () => validateWorkflowTransitions({
      id: "w",
      stages: [{
        id: "a",
        label: "A",
        instructions: "x",
        requiredEvidence: [],
        maxAttempts: 3,
        on: { failed: { target: "a", maxTransitions: 0 } },
      }],
    }),
    /between 1 and 100/,
  );
  // A legal back-edge workflow loads.
  const legal = definition({
    maxTransitions: 12,
    stages: [
      { id: "plan", label: "Plan", instructions: "x" },
      { id: "implement", label: "Implement", instructions: "x" },
      { id: "verify", label: "Verify", instructions: "x", on: {
        passed: "delivery",
        implementation_failure: "implement",
        plan_invalidated: "plan",
        blocked: "$terminal",
      } },
      { id: "delivery", label: "Delivery", instructions: "x" },
    ],
  });
  assert.equal(legal.maxTransitions, 12);
  assert.deepEqual(legal.stages[2]?.on?.implementation_failure, { target: "implement" });
});

test("declared back-edges transition with durable journal records", () => {
  const workflow = definition({
    maxTransitions: 12,
    stages: [
      { id: "plan", label: "Plan", instructions: "x" },
      { id: "implement", label: "Implement", instructions: "x" },
      { id: "verify", label: "Verify", instructions: "x", on: {
        passed: "delivery",
        implementation_failure: "implement",
      } },
      { id: "delivery", label: "Delivery", instructions: "x" },
    ],
  });
  const testRun = run(workflow);
  checkpointRun(testRun, "plan", "passed", "planned", {}, "2026-01-01T00:01:00.000Z");
  checkpointRun(testRun, "implement", "passed", "implemented", { diff: "abc" }, "2026-01-01T00:02:00.000Z");
  const failed = checkpointRun(testRun, "verify", "failed", "tests broke", { result: "regression" }, "2026-01-01T00:03:00.000Z", {}, "implementation_failure");
  assert.equal(failed.transition?.toStage, "implement");
  assert.equal(failed.transition?.outcome, "implementation_failure");
  assert.equal(failed.transition?.attempt, 1);
  assert.deepEqual(failed.transition?.evidenceKeys, ["result"]);
  // Re-entry is attempt-bound: attempts and evidence reset.
  const implement = testRun.stages.find((stage) => stage.id === "implement")!;
  assert.equal(implement.attempts, 0);
  assert.deepEqual(Object.keys(implement.evidence), []);
  assert.equal(implement.status, "in_progress");
  assert.equal(testRun.currentStage, "implement");
  // The durable journal records the transition with source stage and attempt.
  assert.equal(testRun.transitions?.length, 1);
  assert.equal(testRun.transitions?.[0]?.fromStage, "verify");
});

test("transition budgets are enforced globally, per stage, and per edge", () => {
  const workflow = definition({
    maxTransitions: 3,
    stages: [
      { id: "a", label: "A", instructions: "x" },
      { id: "b", label: "B", instructions: "x", maxTransitions: 2, on: {
        failed: { target: "a", maxTransitions: 1 },
      } },
    ],
  });
  const testRun = run(workflow);
  // a passes forward to b (default edge, not a transition).
  checkpointRun(testRun, "a", "passed", "ok", {}, "2026-01-01T00:01:00.000Z");
  assert.equal(testRun.currentStage, "b");
  // Edge transition 1 of 1: b -> a.
  checkpointRun(testRun, "b", "failed", "nope", {}, "2026-01-01T00:02:00.000Z", {}, "failed");
  assert.equal(testRun.currentStage, "a");
  // Forward again, then exhaust the per-edge budget.
  checkpointRun(testRun, "a", "passed", "ok", {}, "2026-01-01T00:03:00.000Z");
  const exhaustedEdge = checkpointRun(testRun, "b", "failed", "nope again", {}, "2026-01-01T00:04:00.000Z", {}, "failed");
  assert.equal(exhaustedEdge.exhausted, true);
  assert.equal(testRun.status, "failed");
  assert.equal(testRun.currentStage, undefined);
  // The per-stage budget (2) and global budget (3) were not yet reached:
  // only one edge transition happened before exhaustion.
  assert.equal(testRun.transitions?.length, 1);
});

test("global budget exhaustion fails safely before a fourth transition", () => {
  const workflow = definition({
    maxTransitions: 2,
    stages: [
      { id: "a", label: "A", instructions: "x" },
      // maxAttempts is deliberately high so the global transition budget is
      // what fails the run, not attempt exhaustion.
      { id: "b", label: "B", instructions: "x", maxAttempts: 20, on: { failed: "a" } },
    ],
  });
  const testRun = run(workflow);
  checkpointRun(testRun, "a", "passed", "ok", {}, "2026-01-01T00:00:30.000Z");
  checkpointRun(testRun, "b", "failed", "f1", {}, "2026-01-01T00:01:00.000Z", {}, "failed");
  checkpointRun(testRun, "a", "passed", "ok", {}, "2026-01-01T00:02:00.000Z");
  checkpointRun(testRun, "b", "failed", "f2", {}, "2026-01-01T00:03:00.000Z", {}, "failed");
  checkpointRun(testRun, "a", "passed", "ok", {}, "2026-01-01T00:04:00.000Z");
  const third = checkpointRun(testRun, "b", "failed", "f3", {}, "2026-01-01T00:05:00.000Z", {}, "failed");
  assert.equal(third.exhausted, true);
  assert.equal(testRun.status, "failed");
  assert.equal(testRun.transitions?.length, 2);
});

test("$terminal completes the run safely", () => {
  const workflow = definition({
    maxTransitions: 4,
    stages: [
      { id: "work", label: "Work", instructions: "x", on: { blocked: "$terminal" } },
    ],
  });
  const testRun = run(workflow);
  const blocked = checkpointRun(testRun, "work", "failed", "cannot proceed", {}, "2026-01-01T00:01:00.000Z", {}, "blocked");
  assert.equal(blocked.completed, true);
  assert.equal(blocked.transition?.toStage, "$terminal");
  assert.equal(testRun.status, "completed");
  assert.equal(testRun.completedAt, "2026-01-01T00:01:00.000Z");
});

test("approvals and gates cannot be bypassed by forward transitions", () => {
  // Plan tries to declare passed -> implement, skipping the approval gate.
  assert.throws(
    () => definition({
      maxTransitions: 6,
      stages: [
        { id: "plan", label: "Plan", instructions: "x", on: { passed: "implement" } },
        { id: "approval", label: "Human approval", instructions: "x", requiredEvidence: ["signoff"] },
        { id: "implement", label: "Implement", instructions: "x" },
        { id: "delivery", label: "Delivery", instructions: "x" },
      ],
    }),
    /skips intermediate stages/,
  );
  // Re-entering the flow through a back-edge still passes through the gate:
  // implement -> plan is legal, but the forward path from plan must again
  // traverse approval before implement.
  const workflow = definition({
    maxTransitions: 6,
    stages: [
      { id: "plan", label: "Plan", instructions: "x" },
      { id: "approval", label: "Human approval", instructions: "x", requiredEvidence: ["signoff"] },
      { id: "implement", label: "Implement", instructions: "x", on: { plan_invalidated: "plan" } },
      { id: "delivery", label: "Delivery", instructions: "x" },
    ],
  });
  const testRun = run(workflow);
  checkpointRun(testRun, "plan", "passed", "planned", {}, "2026-01-01T00:01:00.000Z");
  // The approval gate still stands between plan and implement.
  checkpointRun(testRun, "approval", "passed", "approved", { signoff: "human-ok" }, "2026-01-01T00:02:00.000Z");
  const invalidated = checkpointRun(testRun, "implement", "failed", "plan was wrong", {}, "2026-01-01T00:03:00.000Z", {}, "plan_invalidated");
  assert.equal(invalidated.transition?.toStage, "plan");
  assert.equal(testRun.currentStage, "plan");
});

test("transitions survive restart through run persistence", async () => {
  const { MeshStore } = await import("../plugins/kxm-mesh/src/store.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "kxm-transitions-"));
  const path = join(directory, "mesh.db");
  try {
    const workflow = definition({
      maxTransitions: 4,
      stages: [
        { id: "a", label: "A", instructions: "x" },
        { id: "b", label: "B", instructions: "x", on: { failed: "a" } },
      ],
    });
    const first = new MeshStore(path);
    const testRun = run(workflow);
    checkpointRun(testRun, "a", "passed", "ok", {}, "2026-01-01T00:00:30.000Z");
    checkpointRun(testRun, "b", "failed", "f1", {}, "2026-01-01T00:01:00.000Z", {}, "failed");
    first.saveWorkflowRun(testRun);
    first.close();

    const second = new MeshStore(path);
    const restored = second.workflowRuns.get(testRun.id);
    assert.equal(restored?.transitions?.length, 1);
    assert.equal(restored.transitions?.[0]?.fromStage, "b");
    assert.equal(restored.maxTransitions, 4);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

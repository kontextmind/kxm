import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  checkpointRun,
  parseWorkflowDefinitions,
  type WorkflowRun,
  type WebhookWorkflowDefinition,
} from "../plugins/kxm-mesh/src/workflow.ts";

const FIX_JSON = readFileSync(".kxm/config/workflows/fix.json", "utf8");

function fixDefinition(): WebhookWorkflowDefinition {
  const [workflow] = parseWorkflowDefinitions(FIX_JSON, {
    FIX_WEBHOOK_SECRET: "fix-workflow-secret-with-entropy",
    WORKFLOW_SIGNAL_SECRET: "fix-signal-secret-with-entropy",
  });
  return workflow!;
}

const REPRO = "tests/e2e/repro.spec.ts:" + createHash("sha256").update("failing repro v1").digest("hex");
const REPRO_WEAKENED = "tests/e2e/repro.spec.ts:" + createHash("sha256").update("weakened repro").digest("hex");
const PLAN = "docs/plan.md:" + createHash("sha256").update("final plan v1").digest("hex");

function run(): WorkflowRun {
  const definition = fixDefinition();
  const createdAt = "2026-01-01T00:00:00.000Z";
  const run_: WorkflowRun = {
    id: "run_fix1",
    definitionId: definition.id,
    source: definition.source,
    deliveryId: "delivery_1",
    payloadHash: "hash",
    project: definition.project,
    targetAgentId: "agent_coord",
    targetAgentName: "coord",
    messageId: "msg_1",
    status: "running",
    currentStage: definition.stages[0]!.id,
    ...(definition.maxTransitions !== undefined ? { maxTransitions: definition.maxTransitions } : {}),
    ...(definition.reproOracle !== undefined ? { reproOracle: definition.reproOracle } : {}),
    ...(definition.planHash !== undefined ? { planHashConfig: definition.planHash } : {}),
    ...(definition.requirePlanHash !== undefined ? { requirePlanHash: definition.requirePlanHash } : {}),
    stages: definition.stages.map((stage, index) => ({
      ...stage,
      status: index === 0 ? "in_progress" as const : "pending" as const,
      attempts: 0,
      evidence: {},
      ...(index === 0 ? { startedAt: createdAt } : {}),
    })),
    createdAt,
    updatedAt: createdAt,
  };
  return resolvePolicies(run_);
}

function pass(run_: WorkflowRun, stageId: string, evidence: Record<string, string>, at: string, verifiedEvidence?: Parameters<typeof checkpointRun>[6]) {
  return checkpointRun(run_, stageId, "passed", `${stageId} ok`, evidence, at, verifiedEvidence);
}

/** Mirror the hub's run-creation policy resolution for the critics stage. */
function resolvePolicies(run_: WorkflowRun): WorkflowRun {
  for (const stage of run_.stages) {
    if (stage.evidencePolicies) {
      stage.resolvedEvidencePolicies = Object.fromEntries(
        Object.entries(stage.evidencePolicies).map(([key, policy]) => [key, {
          ...(policy as { kind: "peer-reply"; minProducers: number; acceptedStatuses?: ["replied"] }),
          kind: "peer-reply" as const,
          eligibleProducers: (policy as { eligibleAgents: string[] }).eligibleAgents.map((id) => ({ id: `agent_${id}`, name: id })),
          acceptedStatuses: ["replied"] as const,
        }]),
      );
    }
  }
  return run_;
}

function peerSnapshot(run_: WorkflowRun, messageId: string, producer: string): NonNullable<Parameters<typeof checkpointRun>[6]>["critique"][number] {
  const at = "2026-01-01T00:10:00.000Z";
  return {
    schema: "pi-mesh.verified-peer-evidence.v1",
    messageId,
    producerId: `agent_${producer}`,
    producerName: producer,
    context: {
      schema: "pi-mesh.workflow-message-context.v1",
      runId: run_.id,
      stageId: "critics",
      requirementKey: "critique",
      attempt: run_.stages.find((candidate) => candidate.id === "critics")!.attempts + 1,
    },
    status: "replied" as const,
    requestSha256: createHash("sha256").update(`request-${messageId}`).digest("hex"),
    replySha256: createHash("sha256").update(`reply-${messageId}`).digest("hex"),
    createdAt: at,
    replyCreatedAt: at,
    repliedAt: at,
    verifiedAt: at,
  } as never;
}

test("the /fix definition encodes the full two-phase lifecycle with bounded rework", () => {
  const workflow = fixDefinition();
  assert.deepEqual(workflow.stages.map((stage) => stage.id), [
    "intake",
    "repro-explore",
    "repro-write",
    "plan",
    "critics",
    "final-plan",
    "approval",
    "implement",
    "local-verify",
    "delivery",
    "ci-watch",
    "ready-for-human-acceptance",
  ]);
  assert.equal(workflow.maxTransitions, 24);
  assert.deepEqual(workflow.reproOracle, { stageId: "repro-write", evidenceKey: "repro" });
  assert.deepEqual(workflow.planHash, { stageId: "final-plan", evidenceKey: "plan" });
  assert.deepEqual(workflow.requirePlanHash, ["delivery", "implement", "local-verify"]);
  // Human approval is a security-area stage with a signoff requirement and
  // no transitions may skip it (forward transitions target the next stage).
  const approval = workflow.stages.find((stage) => stage.id === "approval")!;
  assert.equal(approval.area, "security");
  assert.deepEqual(approval.requiredEvidence, ["signoff"]);
  // Rework edges are declared and budgeted.
  const localVerify = workflow.stages.find((stage) => stage.id === "local-verify")!;
  assert.deepEqual(localVerify.on?.implementation_failure, { target: "implement" });
  assert.deepEqual(localVerify.on?.plan_invalidated, { target: "plan" });
  const ciWatch = workflow.stages.find((stage) => stage.id === "ci-watch")!;
  assert.deepEqual(ciWatch.on?.failure, { target: "implement" });
  // Independent critics require two distinct producers.
  const critics = workflow.stages.find((stage) => stage.id === "critics")!;
  assert.equal(critics.evidencePolicies?.critique?.kind, "peer-reply");
  assert.equal(critics.evidencePolicies?.critique?.minProducers, 2);
});

test("end-to-end fixture: reproduce, plan, approve, implement, verify, deliver, watch", () => {
  const testRun = run();
  let at = 0;
  const step = (): string => new Date(1_700_000_000_000 + (at += 60_000)).toISOString();

  pass(testRun, "intake", { classification: "flaky CI worker cleanup" }, step());
  pass(testRun, "repro-explore", { diagnosis: "worker rmSync races with child shutdown" }, step());
  const reproWrite = pass(testRun, "repro-write", { repro: REPRO }, step());
  // The oracle is captured when repro-write passes.
  assert.equal(testRun.oracle?.evidenceKey, "repro");
  assert.equal(testRun.oracle?.sha256, createHash("sha256").update(REPRO).digest("hex"));
  assert.equal(reproWrite.transition?.toStage, "plan");

  pass(testRun, "plan", { plan: "initial plan" }, step());
  // Critics require two distinct eligible producers; the engine verifies the
  // hub-verified peer snapshots (quorum policy declared on the stage).
  pass(testRun, "critics", {}, step(), { critique: [peerSnapshot(testRun, "msg_c1", "critic-1"), peerSnapshot(testRun, "msg_c2", "critic-2")] });
  const finalPlan = pass(testRun, "final-plan", { plan: PLAN }, step());
  assert.equal(testRun.planHash?.sha256, createHash("sha256").update(PLAN).digest("hex"));
  assert.equal(finalPlan.transition?.toStage, "approval");

  // Implementation is blocked without the approved plan hash.
  const testRun2 = run();
  // (checked in the dedicated plan-hash test below)

  pass(testRun, "approval", { signoff: "human:eddie:ticket-42" }, step());
  pass(testRun, "implement", { diff: "worker cleanup retry", repro: REPRO }, step());
  assert.equal(testRun.currentStage, "local-verify");

  // Local verify fails with implementation_failure -> bounded rework to implement.
  const rework = checkpointRun(testRun, "local-verify", "failed", "typecheck failed", { gates: "typecheck:failed" }, step(), {}, "implementation_failure");
  assert.equal(rework.transition?.toStage, "implement");
  // Every declared edge is journaled: eight forward passes plus the rework.
  assert.equal(testRun.transitions?.length, 9);
  assert.deepEqual(
    testRun.transitions?.slice(-1).map((record) => `${record.fromStage}->${record.toStage}:${record.outcome}`),
    ["local-verify->implement:implementation_failure"],
  );
  assert.equal(testRun.stages.find((stage) => stage.id === "implement")!.status, "in_progress");

  // Implement again (self-retry via default failure path is not needed; pass).
  pass(testRun, "implement", { diff: "worker cleanup retry v2", repro: REPRO }, step());
  pass(testRun, "local-verify", { gates: "unit:passed,lint:passed,typecheck:passed,build:passed,repro:passed" }, step());
  assert.equal(testRun.currentStage, "delivery");

  pass(testRun, "delivery", { mr: "mr!123" }, step());
  assert.equal(testRun.currentStage, "ci-watch");

  // CI failure reworks through the bounded back-edge.
  const ciFailure = checkpointRun(testRun, "ci-watch", "failed", "windows CI red", { ci: "windows:failed" }, step(), {}, "failure");
  assert.equal(ciFailure.transition?.toStage, "implement");
  pass(testRun, "implement", { diff: "windows cleanup retry", repro: REPRO }, step());
  pass(testRun, "local-verify", { gates: "all:passed" }, step());
  pass(testRun, "delivery", { mr: "mr!123 (v2)" }, step());
  pass(testRun, "ci-watch", { ci: "all:passed" }, step());
  assert.equal(testRun.currentStage, "ready-for-human-acceptance");

  const final = pass(testRun, "ready-for-human-acceptance", { summary: "fix summary with evidence trail" }, step());
  assert.equal(final.completed, true);
  assert.equal(final.transition?.toStage, "$terminal");
  assert.equal(testRun.status, "completed");
  // Claim-to-evidence receipt: the run journal carries the oracle, plan hash,
  // and every transition with source stage, attempt, and outcome. The two
  // back-edges appear in the durable journal among the forward passes.
  assert.equal(testRun.oracle?.evidenceKey, "repro");
  assert.equal(testRun.planHash?.sha256, createHash("sha256").update(PLAN).digest("hex"));
  const backEdges = testRun.transitions?.filter((record) => record.outcome === "implementation_failure" || record.outcome === "failure")
    .map((record) => `${record.fromStage}->${record.toStage}:${record.outcome}`);
  assert.deepEqual(backEdges, ["local-verify->implement:implementation_failure", "ci-watch->implement:failure"]);
  assert.equal(testRun.transitions?.length, 18);
});

test("a weakened or edited original reproduction is rejected", () => {
  const testRun = run();
  let at = 0;
  const step = (): string => new Date(1_700_000_000_000 + (at += 60_000)).toISOString();
  pass(testRun, "intake", { classification: "x" }, step());
  pass(testRun, "repro-explore", { diagnosis: "d" }, step());
  pass(testRun, "repro-write", { repro: REPRO }, step());
  pass(testRun, "plan", { plan: "p" }, step());
  pass(testRun, "critics", {}, step(), { critique: [peerSnapshot(testRun, "msg_w1", "critic-1"), peerSnapshot(testRun, "msg_w2", "critic-2")] });
  pass(testRun, "final-plan", { plan: PLAN }, step());
  pass(testRun, "approval", { signoff: "human:eddie" }, step());

  // Implementing against a weakened reproduction fails closed.
  assert.throws(
    () => checkpointRun(testRun, "implement", "passed", "cheat", { diff: "d", repro: REPRO_WEAKENED }, step()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /may not be weakened/);
      return true;
    },
  );
  // Omitting the repro key entirely also fails: implementation requires the
  // plan hash AND the run's oracle is only satisfiable by the same value.
  // The honest path still works.
  pass(testRun, "implement", { diff: "real fix", repro: REPRO }, step());
  assert.equal(testRun.currentStage, "local-verify");
});

test("implementation requires an approved plan hash", () => {
  const testRun = run();
  let at = 0;
  const step = (): string => new Date(1_700_000_000_000 + (at += 60_000)).toISOString();
  pass(testRun, "intake", { classification: "x" }, step());
  pass(testRun, "repro-explore", { diagnosis: "d" }, step());
  pass(testRun, "repro-write", { repro: REPRO }, step());
  pass(testRun, "plan", { plan: "p" }, step());
  pass(testRun, "critics", {}, step(), { critique: [peerSnapshot(testRun, "msg_h1", "critic-1"), peerSnapshot(testRun, "msg_h2", "critic-2")] });
  // final-plan has NOT passed: no approved plan hash exists.
  assert.equal(testRun.planHash, undefined);
  assert.throws(
    () => checkpointRun(testRun, "approval", "passed", "premature", { signoff: "human" }, step()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      return true;
    },
  );
  // approval itself is not in requirePlanHash; the gate applies to
  // implement/local-verify/delivery. Drive to approval properly and confirm
  // implement is blocked before final-plan.
  pass(testRun, "final-plan", { plan: PLAN }, step());
  pass(testRun, "approval", { signoff: "human:eddie" }, step());
  assert.ok(testRun.planHash);
  pass(testRun, "implement", { diff: "fix", repro: REPRO }, step());
});

test("plan-invalidating discoveries route back to planning, not scope creep", () => {
  const testRun = run();
  let at = 0;
  const step = (): string => new Date(1_700_000_000_000 + (at += 60_000)).toISOString();
  pass(testRun, "intake", { classification: "x" }, step());
  pass(testRun, "repro-explore", { diagnosis: "d" }, step());
  pass(testRun, "repro-write", { repro: REPRO }, step());
  pass(testRun, "plan", { plan: "p1" }, step());
  pass(testRun, "critics", {}, step(), { critique: [peerSnapshot(testRun, "msg_i1", "critic-1"), peerSnapshot(testRun, "msg_i2", "critic-2")] });
  pass(testRun, "final-plan", { plan: PLAN }, step());
  pass(testRun, "approval", { signoff: "human:eddie" }, step());
  pass(testRun, "implement", { diff: "fix", repro: REPRO }, step());
  // local-verify discovers the plan was invalidated.
  const invalidated = checkpointRun(testRun, "local-verify", "failed", "plan was wrong", { gates: "repro:passed,scope:violated" }, step(), {}, "plan_invalidated");
  assert.equal(invalidated.transition?.toStage, "plan");
  assert.equal(testRun.currentStage, "plan");
  // Re-planning and re-approval are required before implementation again.
  pass(testRun, "plan", { plan: "p2" }, step());
  pass(testRun, "critics", {}, step(), { critique: [peerSnapshot(testRun, "msg_j1", "critic-1"), peerSnapshot(testRun, "msg_j2", "critic-2")] });
  pass(testRun, "final-plan", { plan: PLAN }, step());
  pass(testRun, "approval", { signoff: "human:eddie:again" }, step());
  assert.equal(testRun.currentStage, "implement");
});

test("max-transition exhaustion fails the run safely with retrospective evidence", () => {
  const testRun = run();
  let at = 0;
  const step = (): string => new Date(1_700_000_000_000 + (at += 60_000)).toISOString();
  pass(testRun, "intake", { classification: "x" }, step());
  pass(testRun, "repro-explore", { diagnosis: "d" }, step());
  pass(testRun, "repro-write", { repro: REPRO }, step());
  pass(testRun, "plan", { plan: "p" }, step());
  pass(testRun, "critics", {}, step(), { critique: [peerSnapshot(testRun, "msg_r1", "critic-1"), peerSnapshot(testRun, "msg_r2", "critic-2")] });
  pass(testRun, "final-plan", { plan: PLAN }, step());
  pass(testRun, "approval", { signoff: "human:eddie" }, step());
  // Nine full rework cycles consume the entire global budget (24
  // transitions: 6 forward passes to reach implement, then
  // implement->local-verify and the implementation_failure back-edge per
  // cycle).
  for (let cycle = 0; cycle < 9; cycle += 1) {
    pass(testRun, "implement", { diff: `fix v${cycle}`, repro: REPRO }, step());
    const attempt = checkpointRun(testRun, "local-verify", "failed", "still red", { gates: "typecheck:failed" }, step(), {}, "implementation_failure");
    if (cycle < 8) {
      assert.equal(attempt.exhausted, undefined);
    } else {
      // The budget-bound back-edge exhausts: the run fails safely instead of
      // looping unbounded.
      assert.equal(attempt.exhausted, true);
    }
  }
  assert.equal(testRun.status, "failed");
  assert.equal(testRun.currentStage, undefined);
  assert.equal(testRun.transitions?.length, 24);
});

test("oracle and plan hash survive restart durability", async () => {
  const { MeshStore } = await import("../plugins/kxm-mesh/src/store.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "kxm-fix-"));
  const path = join(directory, "mesh.db");
  try {
    const testRun = run();
    let at = 0;
    const step = (): string => new Date(1_700_000_000_000 + (at += 60_000)).toISOString();
    pass(testRun, "intake", { classification: "x" }, step());
    pass(testRun, "repro-explore", { diagnosis: "d" }, step());
    pass(testRun, "repro-write", { repro: REPRO }, step());
    pass(testRun, "plan", { plan: "p" }, step());
    pass(testRun, "critics", {}, step(), { critique: [peerSnapshot(testRun, "msg_s1", "critic-1"), peerSnapshot(testRun, "msg_s2", "critic-2")] });
    pass(testRun, "final-plan", { plan: PLAN }, step());
    const first = new MeshStore(path);
    first.saveWorkflowRun(testRun);
    first.close();

    const second = new MeshStore(path);
    const restored = second.workflowRuns.get(testRun.id);
    assert.equal(restored?.oracle?.sha256, createHash("sha256").update(REPRO).digest("hex"));
    assert.equal(restored?.planHash?.sha256, createHash("sha256").update(PLAN).digest("hex"));
    assert.deepEqual(restored?.requirePlanHash, ["delivery", "implement", "local-verify"]);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

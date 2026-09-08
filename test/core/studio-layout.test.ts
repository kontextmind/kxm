import { strict as assert } from "node:assert";
import test from "node:test";
import { parse } from "yaml";
import { compileVnextWorkflow } from "../../plugins/kxm/src/vnext-engine-compile.ts";
import { generateStudioLayout, STUDIO_LAYOUT_SCHEMA } from "../../plugins/kxm/src/studio-layout.ts";

test("generateStudioLayout compiles plan into Decision D14 DAG, stepper, and Temporal swimlanes", () => {
  const yamlContent = `
schema: kxm.workflow.v1
description: Test workflow for studio layout
coordinator: coordinator
limits:
  maxTransitions: 8
steps:
  - id: plan
    kind: agent
    agent: planner
    maxAttempts: 2
    on:
      passed: implement
      failed:
        target: $terminal
        terminalStatus: failed
  - id: implement
    kind: agent
    agent: writer
    maxAttempts: 2
    on:
      passed: verify
      failed:
        target: $terminal
        terminalStatus: failed
  - id: verify
    kind: gate
    gate: verify-gate
    expect: pass
    maxAttempts: 1
    on:
      passed:
        target: $terminal
        terminalStatus: completed
      failed:
        target: implement
        maxTransitions: 2
`;

  const parsed = parse(yamlContent) as any;
  const plan = compileVnextWorkflow({ id: "test-workflow", value: parsed });
  const layout = generateStudioLayout(plan);

  assert.equal(layout.schema, STUDIO_LAYOUT_SCHEMA);
  assert.equal(layout.workflowId, "test-workflow");

  // Stepper
  assert.equal(layout.stepper.length, 3);
  assert.equal(layout.stepper[0]?.id, "plan");
  assert.equal(layout.stepper[1]?.id, "implement");
  assert.equal(layout.stepper[2]?.id, "verify");

  // DAG Nodes & Positioning
  assert.equal(layout.dag.nodes.length, 3);
  const planNode = layout.dag.nodes.find((n) => n.id === "plan");
  assert.ok(planNode);
  assert.equal(planNode?.type, "agentStep");
  assert.equal(planNode?.data.role, "planner");

  const verifyNode = layout.dag.nodes.find((n) => n.id === "verify");
  assert.ok(verifyNode);
  assert.equal(verifyNode?.type, "gateStep");
  assert.equal(verifyNode?.data.gate, "verify-gate");

  // Temporal Swimlanes
  assert.ok(layout.temporalSwimlanes.length >= 2);
  const plannerLane = layout.temporalSwimlanes.find((l) => l.role === "planner");
  assert.ok(plannerLane);
  assert.equal(plannerLane?.activities.length, 1);
  assert.equal(plannerLane?.activities[0]?.stepId, "plan");
});

test("generateStudioLayout supports approval, wait, moa steps and runtime state overlays", () => {
  const yamlContent = `
schema: kxm.workflow.v1
description: Test multi-kind workflow
coordinator: coordinator
limits:
  maxTransitions: 8
steps:
  - id: review
    kind: moa
    agent: critic
    maxAttempts: 1
    on:
      passed: gate-approve
      failed:
        target: $terminal
        terminalStatus: failed
  - id: gate-approve
    kind: approval
    maxAttempts: 1
    on:
      passed: pause-wait
      failed:
        target: $terminal
        terminalStatus: failed
  - id: pause-wait
    kind: wait
    signal: external-approval
    maxAttempts: 1
    on:
      passed:
        target: $terminal
        terminalStatus: completed
      failed:
        target: $terminal
        terminalStatus: failed
`;

  const parsed = parse(yamlContent) as any;
  const plan = compileVnextWorkflow({ id: "multi-kind", value: parsed });
  const mockState = {
    currentStep: { stepId: "gate-approve", status: "running" as const, stepAttempt: 1 },
    stepAttempts: { review: 1 },
  };
  const layout = generateStudioLayout(plan, mockState as any);

  assert.equal(layout.dag.nodes.length, 3);
  const approveNode = layout.dag.nodes.find((n) => n.id === "gate-approve");
  assert.equal(approveNode?.type, "approvalStep");
  assert.equal(approveNode?.data.status, "running");

  const waitNode = layout.dag.nodes.find((n) => n.id === "pause-wait");
  assert.equal(waitNode?.type, "waitStep");

  const reviewNode = layout.dag.nodes.find((n) => n.id === "review");
  assert.equal(reviewNode?.data.status, "passed");

  assert.equal(layout.stepper[0]?.status, "completed");
  assert.equal(layout.stepper[1]?.status, "active");
  assert.equal(layout.stepper[2]?.status, "pending");
});

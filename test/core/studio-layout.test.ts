import { strict as assert } from "node:assert";
import test from "node:test";
import { parse } from "yaml";
import { compileVnextWorkflow } from "../../plugins/kxm/src/vnext-engine-compile.ts";
import { generateStudioLayout, STUDIO_LAYOUT_SCHEMA, createStudioServer } from "../../plugins/kxm/src/studio-layout.ts";

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

test("createStudioServer serves health check and embedded dashboard", async () => {
  const serverHandle = createStudioServer({ port: 0 });
  const port = await serverHandle.listen();
  try {
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthRes.status, 200);
    const healthData = await healthRes.json() as any;
    assert.equal(healthData.ok, true);
    assert.equal(healthData.studio, true);

    const apiHealthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(apiHealthRes.status, 200);

    const indexRes = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(indexRes.status, 200);
    const html = await indexRes.text();
    assert.ok(html.includes("KXM Web Studio"));
  } finally {
    await serverHandle.close();
  }
});

test("createStudioServer serves /api/layout with active plan or 404 when absent", async () => {
  const yamlContent = `
schema: kxm.workflow.v1
description: Test workflow
coordinator: coordinator
limits:
  maxTransitions: 4
steps:
  - id: step-one
    kind: agent
    agent: writer
    maxAttempts: 1
    on:
      passed:
        target: $terminal
        terminalStatus: completed
      failed:
        target: $terminal
        terminalStatus: failed
`;
  const plan = compileVnextWorkflow({ id: "server-plan", value: parse(yamlContent) as any });

  // 1. Without plan
  const serverWithoutPlan = createStudioServer({ port: 0 });
  const port1 = await serverWithoutPlan.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port1}/api/layout`);
    assert.equal(res.status, 404);
    const data = await res.json() as any;
    assert.equal(data.error, "no_active_workflow_plan");
  } finally {
    await serverWithoutPlan.close();
  }

  // 2. With plan
  const serverWithPlan = createStudioServer({ port: 0, planProvider: () => plan });
  const port2 = await serverWithPlan.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port2}/api/layout`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.ok, true);
    assert.equal(data.layout.workflowId, "server-plan");
    assert.equal(data.layout.dag.nodes.length, 1);
  } finally {
    await serverWithPlan.close();
  }
});

test("createStudioServer enforces strict audit parity and SessionToken auth on /api/mutate", async () => {
  const token = "sec_test_token_12345";
  let interceptedMutation: { command: string; args: Record<string, unknown> } | undefined;

  const serverHandle = createStudioServer({
    port: 0,
    sessionToken: token,
    onMutation: (command, args) => {
      interceptedMutation = { command, args };
      return { ok: true, result: { customExecuted: true } };
    },
  });
  const port = await serverHandle.listen();

  try {
    // 1. Missing Authorization header -> 401
    const resNoAuth = await fetch(`http://127.0.0.1:${port}/api/mutate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "workflow.signal" }),
    });
    assert.equal(resNoAuth.status, 401);
    const errNoAuth = await resNoAuth.json() as any;
    assert.equal(errNoAuth.error, "unauthorized");

    // 2. Wrong Authorization header -> 401
    const resWrongAuth = await fetch(`http://127.0.0.1:${port}/api/mutate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid_secret",
      },
      body: JSON.stringify({ command: "workflow.signal" }),
    });
    assert.equal(resWrongAuth.status, 401);

    // 3. Malformed JSON -> 400
    const resMalformed = await fetch(`http://127.0.0.1:${port}/api/mutate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "{ not-json",
    });
    assert.equal(resMalformed.status, 400);
    const errMalformed = await resMalformed.json() as any;
    assert.equal(errMalformed.error, "malformed_json");

    // 4. Missing command -> 400
    const resMissingCmd = await fetch(`http://127.0.0.1:${port}/api/mutate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ args: { runId: "123" } }),
    });
    assert.equal(resMissingCmd.status, 400);
    const errMissingCmd = await resMissingCmd.json() as any;
    assert.equal(errMissingCmd.error, "missing_command");

    // 5. Unsupported mutation (no 1:1 CLI mapping) -> 400
    const resUnsupported = await fetch(`http://127.0.0.1:${port}/api/mutate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ command: "arbitrary.system.shell" }),
    });
    assert.equal(resUnsupported.status, 400);
    const errUnsupported = await resUnsupported.json() as any;
    assert.equal(errUnsupported.error, "unsupported_web_mutation");

    // 6. Valid mutation with 1:1 CLI audit mapping -> 200
    const resSuccess = await fetch(`http://127.0.0.1:${port}/api/mutate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        command: "workflow.signal",
        args: { runId: "run_abc", signalKey: "resume", status: "passed" },
      }),
    });
    assert.equal(resSuccess.status, 200);
    const successData = await resSuccess.json() as any;
    assert.equal(successData.ok, true);
    assert.ok(successData.mutationId.startsWith("mut_"));
    assert.equal(interceptedMutation?.command, "workflow.signal");
    assert.equal(interceptedMutation?.args.runId, "run_abc");
  } finally {
    await serverHandle.close();
  }
});

test("CLI studio serve supports dry-run flag", async () => {
  const { runCli } = await import("../../plugins/kxm/src/cli.ts");
  let stdoutData = "";
  let stderrData = "";
  const io = {
    stdout: (text: string) => { stdoutData += text; },
    stderr: (text: string) => { stderrData += text; },
  };

  const code = await runCli(["--json", "studio", "serve", "--dry-run"], {}, io);
  assert.equal(code, 0, `dry-run failed with stderr: ${stderrData}`);
  const parsed = JSON.parse(stdoutData);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "studio serve");
  assert.equal(parsed.dryRun, true);
});



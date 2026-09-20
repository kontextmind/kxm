import { strict as assert } from "node:assert";
import test from "node:test";
import { parse } from "yaml";
import { compileKxmWorkflow } from "../../plugins/kxm/src/engine-compile.ts";
import { generateStudioLayout, STUDIO_LAYOUT_SCHEMA, createStudioServer } from "../../plugins/kxm/src/studio-layout.ts";
import { assembleTenantStatus, formatTenantStatus } from "../../plugins/kxm/src/tenant-status.ts";
import { runtimeError } from "../../plugins/kxm/src/runtime-store.ts";

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
  const plan = compileKxmWorkflow({ id: "test-workflow", value: parsed });
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
  const plan = compileKxmWorkflow({ id: "multi-kind", value: parsed });
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
  const plan = compileKxmWorkflow({ id: "server-plan", value: parse(yamlContent) as any });

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

test("CLI studio serve launches server and handles error gracefully", async () => {
  const { runCli } = await import("../../plugins/kxm/src/cli.ts");

  // 1. Launch with KXM_STUDIO_ONCE
  let stdoutData = "";
  const io = {
    stdout: (text: string) => { stdoutData += text; },
    stderr: () => {},
  };
  const exitCode = await runCli(
    ["--json", "studio", "serve", "--port", "0"],
    { KXM_STUDIO_ONCE: "1" },
    io,
  );
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdoutData);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "studio serve");
  assert.ok(parsed.port > 0);

  // 2. Launch with invalid port triggers error and exits 1
  let stderrData = "";
  const errIo = {
    stdout: () => {},
    stderr: (text: string) => { stderrData += text; },
  };
  const errCode = await runCli(
    ["studio", "serve", "--port", "-1"],
    {},
    errIo,
  );
  assert.equal(errCode, 1);
  assert.ok(stderrData.includes("studio serve failed"));
});




test("portal reads distinguish hub metadata from Runtime run state and unavailable upstreams", async () => {
  // The property S2 exists for: a portal must never render the hub's record of a run as if
  // it were the run. Every value carries the authority that produced it, an unreadable
  // upstream is reported as unavailable with a stable reason instead of being filled from
  // the other source, and the cross-check refuses to claim agreement it cannot establish.
  const project = "prj_01JTENANTSTATUS000000000";
  const hubSnapshot = {
    project,
    fetchedAt: "2026-09-20T12:00:00.000Z",
    agents: [
      { id: "a1", name: "coordinator", online: true },
      { id: "a2", name: "implementer", online: false },
    ],
    openMessageTotal: 3,
    runTotal: 2,
    runs: [
      {
        id: "run_1", status: "completed", definitionId: "default", updatedAt: "2026-09-20T11:00:00.000Z",
        targetAgentName: "implementer",
        stages: [{ id: "plan", status: "passed", attempts: 2 }, { id: "review", status: "passed" }],
      },
      { id: "run_2", status: "running", definitionId: "default", currentStage: "review" },
    ],
    plans: [{ id: "p1", runId: "run_1", summary: "fix the gate", createdAt: "2026-09-20T10:00:00.000Z", severity: "info" }],
  };
  const runtimeRuns = [
    { runId: "run_1", status: "completed", homeRuntimeId: "rt_box", workflowId: "default", source: "runtime-authoritative" as const },
    { runId: "run_2", status: "failed", homeRuntimeId: "rt_box", workflowId: "default", source: "runtime-authoritative" as const },
  ];
  const okFetch: typeof fetch = (async (url: RequestInfo | URL) => {
    assert.match(String(url), /\/v1\/ops\/snapshot\?project=/, "the hub read must go to the existing ops snapshot route");
    return new Response(JSON.stringify(hubSnapshot), { status: 200 });
  }) as typeof fetch;
  const assemble = (overrides: Record<string, unknown>) => assembleTenantStatus({
    project,
    hubUrl: "http://127.0.0.1:7331",
    resolveAdminToken: () => "admin-token",
    fetchImpl: okFetch,
    runtime: { listRuns: async () => runtimeRuns },
    now: () => new Date("2026-09-20T12:00:01.000Z"),
    ...overrides,
  } as Parameters<typeof assembleTenantStatus>[0]);

  const both = await assemble({});
  assert.equal(both.schema, "kxm.tenant-status.v1");
  assert.equal(both.bindingScope, "loopback", "loopback binding is labelled so the portal can show it");
  assert.equal(both.degraded, false);
  assert.equal(both.hub.state, "ok");
  assert.deepEqual(both.hub.value?.agents.map((agent) => [agent.name, agent.online]), [["coordinator", true], ["implementer", false]]);
  const hubRuns = both.hub.value?.runs ?? [];
  assert.equal(hubRuns.length, 2);
  for (const run of hubRuns) assert.equal(run.source, "hub-projection", "hub runs are labelled as the hub's own record");
  assert.equal(hubRuns[0]?.targetAgentName, "implementer", "target agent survives into the view");
  assert.deepEqual(hubRuns[0]?.progress, { done: 2, total: 2 }, "stage progress is preserved for the portal card");
  assert.equal(hubRuns[0]?.stages?.[0]?.attempts, 2);
  assert.equal(both.hub.value?.plans[0]?.summary, "fix the gate", "plans survive into the view");
  assert.equal(both.runtime.state, "ok");
  for (const run of both.runtime.value?.runs ?? []) assert.equal(run.source, "runtime-authoritative", "runtime runs are labelled authoritative");
  assert.deepEqual(both.runComparison, {
    state: "compared",
    matched: 2,
    discrepancies: [{ runId: "run_2", hubStatus: "running", runtimeStatus: "failed" }],
  }, "only ids present in both populations are compared, and a disagreement is surfaced");

  const hubDown = await assemble({
    fetchImpl: (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch,
  });
  assert.equal(hubDown.hub.state, "unavailable");
  assert.equal(hubDown.hub.reason, "hub_unreachable");
  assert.equal(hubDown.hub.value, undefined, "an unreachable hub contributes no values at all");
  assert.equal(hubDown.runtime.state, "ok", "runtime state survives the hub being down");
  assert.equal(hubDown.degraded, true);
  assert.equal(hubDown.runComparison.state, "unavailable", "no cross-check is claimed from one source");

  const hubHanging = await assemble({
    hubTimeoutMs: 30,
    fetchImpl: ((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      // A fetch stub that ignores the signal would hang forever; honouring it is the point.
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("hub read aborted"), { name: "TimeoutError" }));
      });
    })) as unknown as typeof fetch,
  });
  assert.equal(hubHanging.hub.reason, "hub_timeout", "a hanging hub read ends at its deadline, not never");
  assert.equal(hubHanging.runtime.state, "ok", "the runtime read is not held hostage by the hub deadline");

  const hubGarbage = await assemble({
    fetchImpl: (async () => new Response("not json at all", { status: 200 })) as unknown as typeof fetch,
  });
  assert.equal(hubGarbage.hub.reason, "hub_response_invalid", "a 200 that is not JSON is not reachability");

  const hubEmpty = await assemble({
    fetchImpl: (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch,
  });
  assert.equal(hubEmpty.hub.reason, "hub_response_invalid", "a 200 with an unusable body must not become a healthy empty snapshot");
  assert.equal(hubEmpty.hub.value, undefined);

  const unauthorized = await assemble({
    fetchImpl: (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch,
  });
  assert.equal(unauthorized.hub.reason, "hub_unauthorized", "401 is a credential problem, not a reachability one");

  const badRecord = await assemble({
    resolveAdminToken: () => { throw new Error("malformed hub-env record"); },
  });
  assert.equal(badRecord.hub.reason, "hub_credential_unreadable", "a malformed record degrades the hub source only");
  assert.equal(badRecord.runtime.state, "ok", "the runtime read proceeds when the credential cannot even be resolved");

  const disjoint = await assemble({
    runtime: { listRuns: async () => [{ runId: "run_999", status: "running", homeRuntimeId: "rt_box", source: "runtime-authoritative" as const }] },
  });
  assert.deepEqual(disjoint.runComparison, { state: "unverified", reason: "run_identity_link_absent", matched: 0 },
    "no shared ids means the populations did not intersect — that is not agreement");

  // A row whose fold failed is the cache, not state: it must be labelled runtime-cached,
  // excluded from the authoritative comparison, and never allow "agree" to print over a
  // corrupt event log.
  const foldFailedOnly = await assemble({
    runtime: { listRuns: async () => [{ runId: "run_1", status: "completed", homeRuntimeId: "rt_box", projectionError: "run_events_corrupt", source: "runtime-cached" as const }] },
  });
  const cachedRun = foldFailedOnly.runtime.value?.runs[0];
  assert.equal(cachedRun?.source, "runtime-cached", "a failed fold labels the row as the cache");
  assert.deepEqual(foldFailedOnly.runComparison, { state: "unverified", reason: "runtime_fold_failed", matched: 0, unverifiedFoldRuns: 1 },
    "a shared id whose fold failed is unverified, not agreement");
  assert.equal(foldFailedOnly.degraded, false, "a cached row is still a read; degraded tracks source reachability");

  const mixedFold = await assemble({
    runtime: { listRuns: async () => [
      { runId: "run_1", status: "completed", homeRuntimeId: "rt_box", source: "runtime-authoritative" as const },
      { runId: "run_2", status: "failed", homeRuntimeId: "rt_box", projectionError: "run_events_corrupt", source: "runtime-cached" as const },
    ] },
  });
  assert.deepEqual(mixedFold.runComparison, { state: "compared", matched: 1, unverifiedFoldRuns: 1 },
    "clean folds compare; the failed one is counted as unverified, not as agreement");

  const bodyDeadline = await assemble({
    hubTimeoutMs: 30,
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw Object.assign(new Error("body abandoned"), { name: "TimeoutError" });
      },
    })) as unknown as typeof fetch,
  });
  assert.equal(bodyDeadline.hub.reason, "hub_timeout", "a deadline that expires mid-body is a timeout, not malformed content");

  const runtimeDown = await assemble({
    hubUrl: "http://10.0.0.5:7331",
    runtime: {
      listRuns: async () => {
        throw runtimeError("runtime_supervisor_not_running", "runtime", "no live runtime supervisor on this box");
      },
    },
  });
  assert.equal(runtimeDown.bindingScope, "remote", "a remote hub binding is labelled, because only loopback ships without a token");
  assert.equal(runtimeDown.runtime.state, "unavailable");
  assert.equal(runtimeDown.runtime.reason, "runtime_supervisor_not_running", "the reader's own reason code survives into the view");
  assert.equal(runtimeDown.hub.state, "ok", "hub metadata survives the runtime being down");
  assert.equal(runtimeDown.degraded, true);
  assert.match(formatTenantStatus(runtimeDown), /runtime unavailable \(runtime_supervisor_not_running\)/);
  assert.match(formatTenantStatus(runtimeDown), /agents online/);
  assert.match(formatTenantStatus(disjoint), /independent id spaces/, "the prose says what unverified means");
  assert.match(formatTenantStatus(foldFailedOnly), /1 cached \(fold failed, not state\)/, "the prose never calls a cached row authoritative");
  assert.match(formatTenantStatus(foldFailedOnly), /could not be verified \(runtime fold failed\)/, "the prose names the fold failure, not the id-space reason");
  const mixedDisagree = await assemble({
    runtime: { listRuns: async () => [
      { runId: "run_1", status: "failed", homeRuntimeId: "rt_box", source: "runtime-authoritative" as const },
      { runId: "run_2", status: "completed", homeRuntimeId: "rt_box", projectionError: "run_events_illegal", source: "runtime-cached" as const },
    ] },
  });
  assert.match(formatTenantStatus(mixedDisagree), /disagree \(1 unverified: fold failed\)/,
    "a disagreement line also carries the unverified folds it is standing next to");
});

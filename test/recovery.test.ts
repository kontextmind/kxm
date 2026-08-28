import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { consumeWorkerRecoveryEnvelope, recoveryEnvelopePath } from "../plugins/kxm-mesh/src/recovery.ts";
import { MeshHttpError, type MeshClient } from "../plugins/kxm-mesh/src/client.ts";

test("recovery envelope is journaled without prompt bodies and then deleted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mesh-recovery-"));
  const recorded: unknown[] = [];
  const fake = {
    recordWorkflowEntry: async (runId: string, input: unknown) => {
      recorded.push({ runId, input });
      return { id: "journal_rec" };
    },
  } as unknown as MeshClient;
  writeFileSync(recoveryEnvelopePath(directory, "coordinator"), JSON.stringify({
    version: 1,
    reason: "unresumable_session",
    agentName: "coordinator",
    project: "demo",
    previousContinue: true,
    freshSession: true,
    createdAt: "2026-08-26T00:00:00.000Z",
    runId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    stageId: "research",
    pendingMessageIds: ["msg_11111111111111111111111111111111"],
    artifactPointers: [".kxm/assets/reproduction.md"],
  }));
  const recovered = await consumeWorkerRecoveryEnvelope(fake, directory, "coordinator");
  assert.equal(recovered?.runId, "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(recovered?.stageId, "research");
  assert.equal(recovered?.freshSession, true);
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], {
    runId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    input: {
      category: "error",
      area: "harness",
      severity: "error",
      summary: "Worker recovered with unresumable_session",
      evidence: [
        "tool:mesh_await",
        "class:unresumable_session",
        "operation:await",
        "code:unresumable_session",
        "nextAction:restart_fresh_session",
        "recovery:v1",
        "reason:unresumable_session",
        "stage:research",
        "message:msg_11111111111111111111111111111111",
        "artifact:.kxm/assets/reproduction.md",
      ],
    },
  });
  assert.doesNotMatch(JSON.stringify(recorded), /prompt|sk-|ghp_/);
  await consumeWorkerRecoveryEnvelope(fake, directory, "coordinator");
  assert.equal(recorded.length, 1);

  writeFileSync(recoveryEnvelopePath(directory, "coordinator"), JSON.stringify({
    version: 1,
    reason: "provider_error",
    failureClass: "quota",
    agentName: "coordinator",
    project: "demo",
    previousContinue: true,
    freshSession: false,
    createdAt: "2026-08-26T00:00:00.000Z",
    runId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    stageId: "research",
    pendingMessageIds: ["msg_22222222222222222222222222222222"],
  }));
  await consumeWorkerRecoveryEnvelope(fake, directory, "coordinator");
  assert.match(JSON.stringify(recorded[1]), /Worker recovered with provider_error/);
  assert.match(JSON.stringify(recorded[1]), /class:quota/);
  assert.match(JSON.stringify(recorded[1]), /nextAction:switch_model_or_retry/);

  writeFileSync(recoveryEnvelopePath(directory, "coordinator"), JSON.stringify({
    version: 1,
    reason: "tool_timeout",
    failureClass: "timeout",
    agentName: "coordinator",
    project: "demo",
    previousContinue: true,
    freshSession: false,
    createdAt: "2026-08-26T00:00:00.000Z",
    runId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    stageId: "research",
    pendingMessageIds: ["msg_33333333333333333333333333333333"],
  }));
  await consumeWorkerRecoveryEnvelope(fake, directory, "coordinator");
  assert.match(JSON.stringify(recorded[2]), /Worker recovered with tool_timeout/);
  assert.match(JSON.stringify(recorded[2]), /class:timeout/);
  assert.doesNotMatch(JSON.stringify(recorded.slice(1)), /provider body|tool output/);

  writeFileSync(recoveryEnvelopePath(directory, "coordinator"), JSON.stringify({
    version: 1,
    reason: "worker_signal",
    agentName: "coordinator",
    project: "demo",
    previousContinue: true,
    freshSession: false,
    createdAt: "2026-08-26T00:00:00.000Z",
    runId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    stageId: "research",
  }));
  const failing = {
    recordWorkflowEntry: async () => {
      throw new Error("hub unavailable");
    },
  } as unknown as MeshClient;
  await consumeWorkerRecoveryEnvelope(failing, directory, "coordinator");
  assert.equal(existsSync(recoveryEnvelopePath(directory, "coordinator")), true);
  rmSync(directory, { recursive: true, force: true });
});

test("workflow-affine peers consume local recovery without unauthorized coordinator journaling", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mesh-peer-recovery-"));
  const path = recoveryEnvelopePath(directory, "reviewer", "demo");
  writeFileSync(path, JSON.stringify({
    version: 1,
    reason: "provider_error",
    agentName: "reviewer",
    project: "demo",
    previousContinue: true,
    freshSession: false,
    sessionBinding: { kind: "workflow", runId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    createdAt: "2026-08-26T00:00:00.000Z",
    runId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    stageId: "review",
    pendingMessageIds: ["msg_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
  }));
  let calls = 0;
  const peer = {
    recordWorkflowEntry: async () => {
      calls += 1;
      throw new MeshHttpError(403, "Only the assigned coordinator may record workflow entries", "workflow_forbidden");
    },
  } as unknown as MeshClient;
  const recovered = await consumeWorkerRecoveryEnvelope(peer, directory, "reviewer", "demo");
  assert.equal(calls, 1);
  assert.equal(recovered?.runId, "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(recovered?.peerLocal, true);
  assert.equal(existsSync(path), false);
  rmSync(directory, { recursive: true, force: true });
});

test("unbound recovery telemetry is consumed without guessing a workflow", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mesh-unbound-recovery-"));
  const path = recoveryEnvelopePath(directory, "coordinator");
  let workflowCalls = 0;
  const fake = {
    listWorkflows: async () => {
      workflowCalls += 1;
      return [{ id: "run_unrelated", status: "running" }];
    },
    recordWorkflowEntry: async () => {
      workflowCalls += 1;
      throw new Error("must not attach unbound telemetry");
    },
  } as unknown as MeshClient;
  writeFileSync(path, JSON.stringify({
    version: 1,
    reason: "worker_signal",
    agentName: "coordinator",
    project: "demo",
    previousContinue: true,
    freshSession: false,
    createdAt: "2026-08-26T00:00:00.000Z",
  }));

  const recovered = await consumeWorkerRecoveryEnvelope(fake, directory, "coordinator");
  assert.equal(recovered?.runId, undefined);
  assert.equal(workflowCalls, 0);
  assert.equal(existsSync(path), false);

  writeFileSync(path, JSON.stringify({
    version: 1,
    reason: "provider_error",
    agentName: "coordinator",
    project: "demo",
    previousContinue: true,
    freshSession: false,
    sessionBinding: { kind: "default" },
    createdAt: "2026-08-26T00:00:00.000Z",
    runId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    stageId: "review",
  }));
  const mismatched = await consumeWorkerRecoveryEnvelope(fake, directory, "coordinator");
  assert.equal(mismatched?.runId, null);
  assert.equal(workflowCalls, 0, "default-session recovery must not be attached to a queued workflow run");
  assert.equal(existsSync(path), false);
  rmSync(directory, { recursive: true, force: true });
});

test("invalid collision-safe recovery state is bounded and quarantined", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mesh-invalid-recovery-"));
  const path = recoveryEnvelopePath(directory, "coordinator", "demo");
  writeFileSync(path, "x".repeat(129 * 1_024));
  const recovered = await consumeWorkerRecoveryEnvelope({} as MeshClient, directory, "coordinator", "demo");
  assert.equal(recovered, undefined);
  assert.equal(existsSync(path), false);
  assert.ok(readdirSync(directory).some((name) => name.startsWith(`${path.split(/[\\/]/).at(-1)}.corrupt-`)));

  const base = {
    version: 1,
    reason: "provider_error",
    agentName: "coordinator",
    project: "demo",
    previousContinue: true,
    freshSession: false,
    createdAt: "2026-08-26T00:00:00.000Z",
  };
  const invalidFields = [
    { runId: "run_../escape" },
    { stageId: "bad/stage" },
    { activeMessageIds: ["msg_bad"] },
    { pendingMessageIds: ["msg_bad"] },
    { artifactPointers: ["bad\nartifact"] },
    { failureClass: "raw-provider-body" },
    { signal: "bad\nsignal" },
    { sessionBinding: { kind: "workflow", runId: "run_bad" } },
  ];
  for (const fields of invalidFields) {
    writeFileSync(path, JSON.stringify({ ...base, ...fields }));
    assert.equal(await consumeWorkerRecoveryEnvelope({} as MeshClient, directory, "coordinator", "demo"), undefined);
    assert.equal(existsSync(path), false);
  }
  rmSync(directory, { recursive: true, force: true });
});

test("recovery paths isolate exact project/name identities and migrate only matching legacy state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mesh-recovery-identity-"));
  const projectAPath = recoveryEnvelopePath(directory, "review/agent", "project-a");
  const projectBPath = recoveryEnvelopePath(directory, "review/agent", "project-b");
  const sanitizedCollisionPath = recoveryEnvelopePath(directory, "review?agent", "project-a");
  assert.notEqual(projectAPath, projectBPath);
  assert.notEqual(projectAPath, sanitizedCollisionPath);

  const legacyPath = recoveryEnvelopePath(directory, "review/agent");
  writeFileSync(legacyPath, JSON.stringify({
    version: 1,
    reason: "worker_signal",
    agentName: "review/agent",
    project: "project-a",
    previousContinue: true,
    freshSession: false,
    createdAt: "2026-08-26T00:00:00.000Z",
  }));
  const fake = {} as MeshClient;
  assert.equal(await consumeWorkerRecoveryEnvelope(fake, directory, "review/agent", "project-b"), undefined);
  assert.equal(existsSync(legacyPath), true);
  assert.equal((await consumeWorkerRecoveryEnvelope(fake, directory, "review/agent", "project-a"))?.project, "project-a");
  assert.equal(existsSync(legacyPath), false);
  rmSync(directory, { recursive: true, force: true });
});

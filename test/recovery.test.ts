import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { consumeWorkerRecoveryEnvelope, recoveryEnvelopePath } from "../plugins/pi-mesh-comms/src/recovery.ts";
import type { MeshClient } from "../plugins/pi-mesh-comms/src/client.ts";

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
    runId: "run_rec",
    stageId: "research",
    pendingMessageIds: ["msg_1"],
    artifactPointers: [".kxm/assets/reproduction.md"],
  }));
  const recovered = await consumeWorkerRecoveryEnvelope(fake, directory, "coordinator");
  assert.equal(recovered?.runId, "run_rec");
  assert.equal(recovered?.stageId, "research");
  assert.equal(recovered?.freshSession, true);
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], {
    runId: "run_rec",
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
        "message:msg_1",
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
    runId: "run_rec",
    stageId: "research",
    pendingMessageIds: ["msg_2"],
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
    runId: "run_rec",
    stageId: "research",
    pendingMessageIds: ["msg_3"],
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
    runId: "run_rec",
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

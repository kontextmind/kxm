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
    listWorkflows: async () => [{
      id: "run_rec",
      status: "failed",
      currentStage: "research",
      stages: [{ id: "research", status: "in_progress" }],
    }],
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
    pendingMessageIds: ["msg_1"],
  }));
  await consumeWorkerRecoveryEnvelope(fake, directory, "coordinator");
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
      ],
    },
  });
  assert.doesNotMatch(JSON.stringify(recorded), /prompt|sk-|ghp_/);
  await consumeWorkerRecoveryEnvelope(fake, directory, "coordinator");
  assert.equal(recorded.length, 1);
  writeFileSync(recoveryEnvelopePath(directory, "coordinator"), JSON.stringify({
    version: 1,
    reason: "worker_signal",
    agentName: "coordinator",
    project: "demo",
    previousContinue: true,
    freshSession: false,
    createdAt: "2026-08-26T00:00:00.000Z",
  }));
  const failing = {
    listWorkflows: async () => [{ id: "run_rec", status: "running", currentStage: "research", stages: [] }],
    recordWorkflowEntry: async () => {
      throw new Error("hub unavailable");
    },
  } as unknown as MeshClient;
  await consumeWorkerRecoveryEnvelope(failing, directory, "coordinator");
  assert.equal(existsSync(recoveryEnvelopePath(directory, "coordinator")), true);
  rmSync(directory, { recursive: true, force: true });
});

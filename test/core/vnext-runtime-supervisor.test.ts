import assert from "node:assert/strict";
import test from "node:test";
import { removeTempDir } from "../helpers.ts";
import { engineProject } from "../helpers/vnext-project.ts";
import {
  readVnextSupervisorToken,
  startVnextRuntimeSupervisor,
  vnextRuntimeRequest,
} from "../../plugins/kxm/src/vnext-runtime-supervisor.ts";
import { vnextRuntimePaths } from "../../plugins/kxm/src/vnext-runtime-store.ts";

test("supervisor /drive returns 202 with poll link and completes asynchronously", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-202-");
  let supervisor: Awaited<ReturnType<typeof startVnextRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startVnextRuntimeSupervisor({ stateRoot });
    const token = readVnextSupervisorToken(vnextRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };

    const acceptance = await vnextRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "one-step",
      prompt: "test async drive",
    });
    const runId = (acceptance.run as { runId: string }).runId;

    // Send drive request directly with fetch to inspect status 202
    const driveRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "simulated" }),
    });
    assert.equal(driveRes.status, 202);
    const driveBody = await driveRes.json() as Record<string, unknown>;
    assert.equal(driveBody.ok, true);
    assert.equal(driveBody.status, "accepted");
    assert.equal(driveBody.runId, runId);
    assert.equal(driveBody.poll, `/v1/runs/${runId}`);
    assert.equal(driveBody.mode, "simulated");

    // Poll until completed (timeout 10s)
    const startTime = Date.now();
    let currentStatus = "running";
    while (Date.now() - startTime < 10000) {
      const statusRes = await vnextRuntimeRequest(handle, "GET", `/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`);
      currentStatus = (statusRes.run as { status: string }).status;
      if (currentStatus === "completed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(currentStatus, "completed");
  } finally {
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("supervisor /drive rejects duplicate concurrent drive with 409", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-409-");
  let supervisor: Awaited<ReturnType<typeof startVnextRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startVnextRuntimeSupervisor({ stateRoot });
    const token = readVnextSupervisorToken(vnextRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };

    const acceptance = await vnextRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "one-step",
      prompt: "test concurrent drive",
    });
    const runId = (acceptance.run as { runId: string }).runId;

    // Send two concurrent drive requests
    const [resA, resB] = await Promise.all([
      fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ mode: "simulated" }),
      }),
      fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ mode: "simulated" }),
      }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [202, 409]);

    const errorRes = resA.status === 409 ? resA : resB;
    const errorBody = await errorRes.json() as Record<string, unknown>;
    assert.equal(errorBody.ok, false);
    assert.equal(errorBody.error, "run_busy");
  } finally {
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("supervisor graceful shutdown waits for active drive", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-stop-");
  let supervisor: Awaited<ReturnType<typeof startVnextRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startVnextRuntimeSupervisor({ stateRoot });
    const token = readVnextSupervisorToken(vnextRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };

    const acceptance = await vnextRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "one-step",
      prompt: "test shutdown wait",
    });
    const runId = (acceptance.run as { runId: string }).runId;

    const driveRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "simulated" }),
    });
    assert.equal(driveRes.status, 202);

    // Stop supervisor while drive is active
    await supervisor.stop();
    supervisor = undefined;

    // After shutdown, open context directly to verify run settled cleanly
    const { openVnextRuntimeContext, closeVnextRuntimeContext } = await import("../../plugins/kxm/src/vnext-runtime.ts");
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    try {
      const run = context.eventStore.run(runId);
      assert.notEqual(run?.status, "executing");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

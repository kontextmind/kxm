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
import { VnextRunScheduler, vnextPanelDispatchSeams } from "../../plugins/kxm/src/vnext-engine.ts";
import { vnextAdmittedToken } from "../../plugins/kxm/src/vnext-runtime-owner.ts";
import { closeVnextRuntimeContext, openVnextRuntimeContext } from "../../plugins/kxm/src/vnext-runtime.ts";

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
    assert.equal(typeof driveBody.driveId, "string");
    assert.match(String(driveBody.driveId), /^drv_[a-f0-9]{24}$/);
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

test("supervisor post-202 drive rejection is handled and cleanup still runs", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-reject-");
  let supervisor: Awaited<ReturnType<typeof startVnextRuntimeSupervisor>> | undefined;
  const originalOpen = VnextRunScheduler.prototype.openDriveSession;
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(String(reason));
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    VnextRunScheduler.prototype.openDriveSession = async function () {
      return {
        driveId: "drv_testunhandledrejection00",
        settled: new Promise((_, reject) => {
          setImmediate(() => {
            reject(new Error("run_events_illegal: drive made no progress"));
          });
        }),
      };
    };

    supervisor = await startVnextRuntimeSupervisor({ stateRoot });
    const token = readVnextSupervisorToken(vnextRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };

    const acceptance = await vnextRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "one-step",
      prompt: "test post-202 rejection",
    });
    const runId = (acceptance.run as { runId: string }).runId;

    const driveRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "simulated" }),
    });
    assert.equal(driveRes.status, 202);

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(unhandled.length, 0, `unhandledRejection: ${unhandled.join("; ")}`);

    const secondRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "simulated" }),
    });
    if (secondRes.status === 409) {
      const secondBody = await secondRes.json() as Record<string, unknown>;
      assert.notEqual(secondBody.message, `run ${runId} is already executing`);
    } else {
      assert.equal(secondRes.status, 202);
    }

    await supervisor.stop();
    supervisor = undefined;
    assert.equal(unhandled.length, 0, `unhandledRejection after stop: ${unhandled.join("; ")}`);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    VnextRunScheduler.prototype.openDriveSession = originalOpen;
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("supervisor synchronous scheduler throw is handled without unhandledRejection and returns 409", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-sync-throw-");
  let supervisor: Awaited<ReturnType<typeof startVnextRuntimeSupervisor>> | undefined;
  const originalFor = VnextRunScheduler.for;
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(String(reason));
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    VnextRunScheduler.for = () => {
      throw new Error("scheduler_policy_conflict: queued or admitted work still uses the previous scheduler policy");
    };

    supervisor = await startVnextRuntimeSupervisor({ stateRoot });
    const token = readVnextSupervisorToken(vnextRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };

    const acceptance = await vnextRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "one-step",
      prompt: "test synchronous scheduler throw",
    });
    const runId = (acceptance.run as { runId: string }).runId;

    const driveRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "simulated" }),
    });
    assert.equal(driveRes.status, 409);
    const driveBody = await driveRes.json() as Record<string, unknown>;
    assert.equal(driveBody.ok, false);
    assert.equal(driveBody.error, "run_busy");
    assert.equal(driveBody.message, `run ${runId} is already admitted or queued`);

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(unhandled.length, 0, `unhandledRejection: ${unhandled.join("; ")}`);

    VnextRunScheduler.for = originalFor;
    const secondRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "simulated" }),
    });
    assert.equal(secondRes.status, 202);
    assert.equal(unhandled.length, 0, `unhandledRejection after 409 cleanup: ${unhandled.join("; ")}`);

    await supervisor.stop();
    supervisor = undefined;
    assert.equal(unhandled.length, 0, `unhandledRejection after stop: ${unhandled.join("; ")}`);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    VnextRunScheduler.for = originalFor;
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

function resetSupervisorPanelSeams(): void {
  vnextPanelDispatchSeams.afterBirth = undefined;
  vnextPanelDispatchSeams.beforeAppendExecuting = undefined;
  vnextPanelDispatchSeams.failAppendExecuting = undefined;
  vnextPanelDispatchSeams.beforeInvoke = undefined;
  vnextPanelDispatchSeams.failSettleMember = undefined;
}

test("post-202 engine throw leaves failed or attempt_unreconciled, never bare running", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-throw-");
  let supervisor: Awaited<ReturnType<typeof startVnextRuntimeSupervisor>> | undefined;
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(String(reason));
  };
  process.on("unhandledRejection", onUnhandled);
  resetSupervisorPanelSeams();
  try {
    vnextPanelDispatchSeams.failAppendExecuting = () => true;
    supervisor = await startVnextRuntimeSupervisor({ stateRoot });
    const token = readVnextSupervisorToken(vnextRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await vnextRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "one-step",
      prompt: "post-202 engine throw",
    });
    const runId = (acceptance.run as { runId: string }).runId;
    const driveRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "simulated" }),
    });
    assert.equal(driveRes.status, 202);
    const startTime = Date.now();
    let status = "running";
    while (Date.now() - startTime < 5000) {
      const peek = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
      try {
        status = peek.eventStore.run(runId)?.status ?? "missing";
        if (status === "failed" || status === "cancelled" || status === "completed") break;
        if (status === "running" && !vnextAdmittedToken(peek.eventStore.path, runId)) break;
      } finally {
        closeVnextRuntimeContext(peek);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.notEqual(status, "running", "engine throw must not leave a bare running run");
    assert.ok(status === "failed" || status === "cancelling" || status === "cancelled", `status=${status}`);
    assert.equal(unhandled.length, 0, `unhandledRejection: ${unhandled.join("; ")}`);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    resetSupervisorPanelSeams();
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("shutdown with a slow simulated producer records cancel_requested runtime_shutdown within grace", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-shutdown-cancel-");
  let supervisor: Awaited<ReturnType<typeof startVnextRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startVnextRuntimeSupervisor({ stateRoot });
    const token = readVnextSupervisorToken(vnextRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await vnextRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "one-step",
      prompt: "shutdown cancel",
    });
    const runId = (acceptance.run as { runId: string }).runId;
    const driveRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "simulated", delayMs: 1500 }),
    });
    assert.equal(driveRes.status, 202);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 1000) {
      const peek = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
      try {
        if (peek.eventStore.run(runId)?.status === "running") break;
      } finally {
        closeVnextRuntimeContext(peek);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await supervisor.stop();
    supervisor = undefined;
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    try {
      const events = context.eventStore.events(runId, 0, 200);
      const cancel = events.find((event) => event.eventType === "run.cancel_requested");
      assert.equal(cancel?.payload.reason, "runtime_shutdown");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("abort-ignoring producer returns after grace with attempt unreconciled", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-grace-unrec-");
  let supervisor: Awaited<ReturnType<typeof startVnextRuntimeSupervisor>> | undefined;
  const previousGrace = process.env.KXM_RUNTIME_STOP_GRACE_MS;
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(String(reason));
  };
  process.on("unhandledRejection", onUnhandled);
  process.env.KXM_RUNTIME_STOP_GRACE_MS = "120";
  try {
    supervisor = await startVnextRuntimeSupervisor({ stateRoot });
    const token = readVnextSupervisorToken(vnextRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await vnextRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "one-step",
      prompt: "abort ignoring",
    });
    const runId = (acceptance.run as { runId: string }).runId;
    const driveRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "simulated", delayMs: 4000 }),
    });
    assert.equal(driveRes.status, 202);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 1000) {
      const peek = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
      try {
        if (peek.eventStore.run(runId)?.status === "running") break;
      } finally {
        closeVnextRuntimeContext(peek);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    const stopStarted = Date.now();
    await supervisor.stop();
    const stopMs = Date.now() - stopStarted;
    supervisor = undefined;
    assert.ok(stopMs < 1500, `stop waited ${stopMs}ms, expected grace expiry`);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    try {
      const run = context.eventStore.run(runId);
      assert.ok(run, "run must still exist");
      assert.notEqual(run?.status, "completed");
      assert.ok(run?.status === "cancelling" || run?.status === "running" || run?.status === "failed");
      const events = context.eventStore.events(runId, 0, 200);
      assert.equal(events.some((event) => event.eventType === "run.cancel_requested" && event.payload.reason === "runtime_shutdown"), true);
      const terminalAttempt = events.some((event) => event.eventType === "attempt.status_changed" && event.payload.status === "terminal");
      assert.equal(terminalAttempt, false, "grace expiry must not fabricate a terminal attempt");
    } finally {
      closeVnextRuntimeContext(context);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(unhandled.length, 0, `unhandledRejection: ${unhandled.join("; ")}`);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    if (previousGrace === undefined) delete process.env.KXM_RUNTIME_STOP_GRACE_MS;
    else process.env.KXM_RUNTIME_STOP_GRACE_MS = previousGrace;
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("socket destroyed before 202 leaves no admission or full admission, never started-unadmitted", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-disconnect-");
  let supervisor: Awaited<ReturnType<typeof startVnextRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startVnextRuntimeSupervisor({ stateRoot });
    const token = readVnextSupervisorToken(vnextRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await vnextRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "one-step",
      prompt: "pre-202 disconnect",
    });
    const runId = (acceptance.run as { runId: string }).runId;
    const ac = new AbortController();
    const pending = fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "simulated", delayMs: 300 }),
      signal: ac.signal,
    });
    ac.abort();
    await pending.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    try {
      const run = context.eventStore.run(runId);
      const admitted = vnextAdmittedToken(context.eventStore.path, runId);
      const status = run?.status ?? "missing";
      if (status === "preparing" || status === "running") {
        assert.ok(admitted, `started-unadmitted: status=${status} token=${String(admitted)}`);
      }
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

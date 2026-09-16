import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { removeTempDir } from "../helpers.ts";
import { engineProject } from "../helpers/vnext-project.ts";
import {
  DEFAULT_RUNTIME_STOP_GRACE_MS,
  MAX_RUNTIME_STOP_GRACE_MS,
  readVnextSupervisorToken,
  runtimeStopGraceMs,
  startVnextRuntimeSupervisor,
  vnextRuntimeRequest,
} from "../../plugins/kxm/src/vnext-runtime-supervisor.ts";
import { DatabaseSync } from "node:sqlite";
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
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(String(reason));
  };
  process.on("unhandledRejection", onUnhandled);
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
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(unhandled.length, 0, `unhandledRejection: ${unhandled.join("; ")}`);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
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
  vnextPanelDispatchSeams.skipDispatch = undefined;
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
    vnextPanelDispatchSeams.skipDispatch = () => true;
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
    let recorded = false;
    while (Date.now() - startTime < 5000) {
      const peek = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
      try {
        status = peek.eventStore.run(runId)?.status ?? "missing";
        const events = peek.eventStore.events(runId, 0, 200);
        recorded = events.some((event) =>
          event.eventType === "run.cancel_requested"
          || (event.eventType === "run.status_changed" && (event.payload.status === "failed" || event.payload.status === "cancelled"))
        );
        if (status !== "running") break;
      } finally {
        closeVnextRuntimeContext(peek);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.notEqual(status, "running", "engine throw must not leave a bare running run");
    assert.ok(status === "failed" || status === "cancelling" || status === "cancelled", `status=${status}`);
    assert.equal(recorded, true, "post-202 failure must record failed or cancel through a fold-accepted path");
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

test("budget cancel and shutdown cancel racing yield one cancel_requested", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-budget-race-");
  let supervisor: Awaited<ReturnType<typeof startVnextRuntimeSupervisor>> | undefined;
  try {
    writeFileSync(join(root, ".kxm", "workflows", "tiny-duration.yaml"), `schema: kxm.workflow.v1
coordinator: coordinator
limits:
  maxTransitions: 2
  maxRunDurationMs: 30
steps:
  - id: only
    kind: agent
    agent: implementer
    on:
      passed:
        target: $terminal
        terminalStatus: completed
      failed:
        target: $terminal
        terminalStatus: failed
`);
    supervisor = await startVnextRuntimeSupervisor({ stateRoot });
    const token = readVnextSupervisorToken(vnextRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await vnextRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "tiny-duration",
      prompt: "budget race",
    });
    const runId = (acceptance.run as { runId: string }).runId;
    const driveRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "simulated", delayMs: 2000 }),
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
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await supervisor.stop();
    supervisor = undefined;
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    try {
      const cancels = context.eventStore.events(runId, 0, 200).filter((event) => event.eventType === "run.cancel_requested");
      assert.equal(cancels.length, 1);
      assert.ok(cancels[0]!.payload.reason === "budget_run_duration" || cancels[0]!.payload.reason === "runtime_shutdown");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("supervisor /drive returns 409 for still-unsupported maxAgentTimeMs", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-agent-time-");
  let supervisor: Awaited<ReturnType<typeof startVnextRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startVnextRuntimeSupervisor({ stateRoot });
    const token = readVnextSupervisorToken(vnextRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await vnextRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "default",
      prompt: "unsupported agent time",
    });
    const runId = (acceptance.run as { runId: string }).runId;
    const driveRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "simulated" }),
    });
    assert.equal(driveRes.status, 409);
    const body = await driveRes.json() as { error?: string; handoff?: { reason?: string; field?: string } };
    assert.equal(body.error, "run_handoff_required");
    assert.equal(body.handoff?.reason, "limit_unsupported");
    assert.equal(body.handoff?.field, "limits.maxAgentTimeMs");
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
      const receipts = context.eventStore.driveReceiptsForRun(runId);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]!.settlement.kind, "unsettled");
      assert.equal(receipts[0]!.settlement.reason, "runtime_shutdown_grace_expired");
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

test("supervisor GET run returns a verified drive receipt after settle", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-receipt-get-");
  let supervisor: Awaited<ReturnType<typeof startVnextRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startVnextRuntimeSupervisor({ stateRoot });
    const token = readVnextSupervisorToken(vnextRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await vnextRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "one-step",
      prompt: "verified receipt",
    });
    const runId = (acceptance.run as { runId: string }).runId;
    const driveRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "simulated" }),
    });
    assert.equal(driveRes.status, 202);
    const driveBody = await driveRes.json() as { driveId: string };
    const startTime = Date.now();
    let payload: Record<string, unknown> | undefined;
    while (Date.now() - startTime < 10_000) {
      payload = await vnextRuntimeRequest(handle, "GET", `/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`);
      if ((payload.run as { status: string }).status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal((payload!.run as { status: string }).status, "completed");
    const drive = payload!.drive as {
      driveId: string;
      mode: string;
      openedAt: string;
      receipt: { driveId: string; logHash: string; settlement: { kind: string; status: string } };
      verified: boolean;
      divergence?: string;
    };
    assert.equal(drive.driveId, driveBody.driveId);
    assert.equal(drive.mode, "simulated");
    assert.ok(drive.receipt);
    assert.equal(drive.receipt.driveId, driveBody.driveId);
    assert.equal(drive.receipt.settlement.kind, "terminal");
    assert.equal(drive.receipt.settlement.status, "completed");
    assert.equal(drive.verified, true);
    assert.equal(drive.divergence, undefined);
  } finally {
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("supervisor GET reports verified false for a tampered logHash without 500", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-receipt-tamper-");
  let supervisor: Awaited<ReturnType<typeof startVnextRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startVnextRuntimeSupervisor({ stateRoot });
    const token = readVnextSupervisorToken(vnextRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await vnextRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "one-step",
      prompt: "tamper receipt",
    });
    const runId = (acceptance.run as { runId: string }).runId;
    const driveRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "simulated" }),
    });
    assert.equal(driveRes.status, 202);
    const startTime = Date.now();
    while (Date.now() - startTime < 10_000) {
      const statusRes = await vnextRuntimeRequest(handle, "GET", `/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`);
      if ((statusRes.run as { status: string }).status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const peek = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    let driveId: string;
    try {
      const receipts = peek.eventStore.driveReceiptsForRun(runId);
      assert.equal(receipts.length, 1);
      driveId = receipts[0]!.driveId;
      const db = new DatabaseSync(peek.eventStore.path);
      const row = db.prepare("SELECT receipt FROM drive_receipts WHERE drive_id = ?").get(driveId) as { receipt: string };
      const parsed = JSON.parse(row.receipt) as { logHash: string };
      parsed.logHash = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
      db.prepare("UPDATE drive_receipts SET receipt = ? WHERE drive_id = ?").run(JSON.stringify(parsed), driveId);
      db.close();
    } finally {
      closeVnextRuntimeContext(peek);
    }
    const tampered = await vnextRuntimeRequest(handle, "GET", `/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`);
    const drive = tampered.drive as { verified: boolean; divergence?: string; receipt: { logHash: string } };
    assert.equal(drive.verified, false);
    assert.match(String(drive.divergence), /logHash mismatch/);
    assert.equal(drive.receipt.logHash, "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  } finally {
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("supervisor GET reports receipt unreadable for a corrupt row without 500", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-receipt-corrupt-");
  let supervisor: Awaited<ReturnType<typeof startVnextRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startVnextRuntimeSupervisor({ stateRoot });
    const token = readVnextSupervisorToken(vnextRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await vnextRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "one-step",
      prompt: "corrupt receipt",
    });
    const runId = (acceptance.run as { runId: string }).runId;
    const driveRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "simulated" }),
    });
    assert.equal(driveRes.status, 202);
    const startTime = Date.now();
    while (Date.now() - startTime < 10_000) {
      const statusRes = await vnextRuntimeRequest(handle, "GET", `/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`);
      if ((statusRes.run as { status: string }).status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const peek = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    try {
      const receipts = peek.eventStore.driveReceiptsForRun(runId);
      assert.equal(receipts.length, 1);
      const driveId = receipts[0]!.driveId;
      const db = new DatabaseSync(peek.eventStore.path);
      db.prepare("UPDATE drive_receipts SET receipt = ? WHERE drive_id = ?").run("this is not json {", driveId);
      db.close();
    } finally {
      closeVnextRuntimeContext(peek);
    }
    const corruptRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(corruptRes.status, 200);
    const payload = await corruptRes.json() as {
      ok: boolean;
      drive: { verified: boolean; divergence?: string; receipt: unknown };
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.drive.verified, false);
    assert.equal(payload.drive.receipt, null);
    assert.equal(payload.drive.divergence, "receipt unreadable");
  } finally {
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("KXM_RUNTIME_STOP_GRACE_MS is bounded and fail-closed", () => {
  assert.equal(DEFAULT_RUNTIME_STOP_GRACE_MS, 30_000);
  assert.equal(MAX_RUNTIME_STOP_GRACE_MS, 600_000);

  assert.equal(runtimeStopGraceMs({}), DEFAULT_RUNTIME_STOP_GRACE_MS);
  assert.equal(runtimeStopGraceMs({ KXM_RUNTIME_STOP_GRACE_MS: undefined }), DEFAULT_RUNTIME_STOP_GRACE_MS);
  assert.equal(runtimeStopGraceMs({ KXM_RUNTIME_STOP_GRACE_MS: "" }), DEFAULT_RUNTIME_STOP_GRACE_MS);

  assert.equal(runtimeStopGraceMs({ KXM_RUNTIME_STOP_GRACE_MS: String(2 ** 31) }), DEFAULT_RUNTIME_STOP_GRACE_MS);
  assert.equal(runtimeStopGraceMs({ KXM_RUNTIME_STOP_GRACE_MS: String(7 * 24 * 60 * 60_000) }), DEFAULT_RUNTIME_STOP_GRACE_MS);
  assert.equal(runtimeStopGraceMs({ KXM_RUNTIME_STOP_GRACE_MS: "-1" }), DEFAULT_RUNTIME_STOP_GRACE_MS);
  assert.equal(runtimeStopGraceMs({ KXM_RUNTIME_STOP_GRACE_MS: "nope" }), DEFAULT_RUNTIME_STOP_GRACE_MS);

  assert.equal(runtimeStopGraceMs({ KXM_RUNTIME_STOP_GRACE_MS: "0" }), 0);
  assert.equal(runtimeStopGraceMs({ KXM_RUNTIME_STOP_GRACE_MS: "120" }), 120);
  assert.equal(runtimeStopGraceMs({ KXM_RUNTIME_STOP_GRACE_MS: String(MAX_RUNTIME_STOP_GRACE_MS) }), MAX_RUNTIME_STOP_GRACE_MS);
});

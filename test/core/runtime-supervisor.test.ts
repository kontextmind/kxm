import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { removeTempDir } from "../helpers.ts";
import { engineProject } from "../helpers/project.ts";
import {
  DEFAULT_RUNTIME_STOP_GRACE_MS,
  MAX_RUNTIME_STOP_GRACE_MS,
  readKxmSupervisorToken,
  runtimeStopGraceMs,
  startKxmRuntimeSupervisor,
  kxmRuntimeRequest,
} from "../../plugins/kxm/src/runtime-supervisor.ts";
import { DatabaseSync } from "node:sqlite";
import { kxmRuntimePaths, type KxmDriveReceipt } from "../../plugins/kxm/src/runtime-store.ts";
import { KxmRunScheduler, kxmPanelDispatchSeams } from "../../plugins/kxm/src/engine.ts";
import { kxmAdmittedToken } from "../../plugins/kxm/src/runtime-owner.ts";
import { closeKxmRuntimeContext, openKxmRuntimeContext } from "../../plugins/kxm/src/runtime-service.ts";
import { KxmConfigError } from "../../plugins/kxm/src/project-config.ts";

test("supervisor /drive returns 202 with poll link and completes asynchronously", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-202-");
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };

    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
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
      const statusRes = await kxmRuntimeRequest(handle, "GET", `/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`);
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
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(String(reason));
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };

    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
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
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  const originalOpen = KxmRunScheduler.prototype.openDriveSession;
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(String(reason));
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    KxmRunScheduler.prototype.openDriveSession = async function () {
      return {
        driveId: "drv_testunhandledrejection00",
        settled: new Promise((_, reject) => {
          setImmediate(() => {
            reject(new Error("run_events_illegal: drive made no progress"));
          });
        }),
      };
    };

    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };

    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
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
    KxmRunScheduler.prototype.openDriveSession = originalOpen;
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("supervisor synchronous scheduler throw is handled without unhandledRejection and returns 409", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-sync-throw-");
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  const originalFor = KxmRunScheduler.for;
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(String(reason));
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    KxmRunScheduler.for = () => {
      throw new Error("scheduler_policy_conflict: queued or admitted work still uses the previous scheduler policy");
    };

    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };

    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
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

    KxmRunScheduler.for = originalFor;
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
    KxmRunScheduler.for = originalFor;
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("supervisor graceful shutdown waits for active drive", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-stop-");
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };

    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
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
    const context = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    try {
      const run = context.eventStore.run(runId);
      assert.notEqual(run?.status, "executing");
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

function resetSupervisorPanelSeams(): void {
  kxmPanelDispatchSeams.afterBirth = undefined;
  kxmPanelDispatchSeams.beforeAppendExecuting = undefined;
  kxmPanelDispatchSeams.failAppendExecuting = undefined;
  kxmPanelDispatchSeams.beforeInvoke = undefined;
  kxmPanelDispatchSeams.failSettleMember = undefined;
  kxmPanelDispatchSeams.skipDispatch = undefined;
}

test("post-202 engine throw leaves failed or attempt_unreconciled, never bare running", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-throw-");
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(String(reason));
  };
  process.on("unhandledRejection", onUnhandled);
  resetSupervisorPanelSeams();
  try {
    kxmPanelDispatchSeams.skipDispatch = () => true;
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
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
      const peek = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
      try {
        status = peek.eventStore.run(runId)?.status ?? "missing";
        const events = peek.eventStore.events(runId, 0, 200);
        recorded = events.some((event) =>
          event.eventType === "run.cancel_requested"
          || (event.eventType === "run.status_changed" && (event.payload.status === "failed" || event.payload.status === "cancelled"))
        );
        if (status !== "running") break;
      } finally {
        closeKxmRuntimeContext(peek);
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
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
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
      const peek = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
      try {
        if (peek.eventStore.run(runId)?.status === "running") break;
      } finally {
        closeKxmRuntimeContext(peek);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await supervisor.stop();
    supervisor = undefined;
    const context = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    try {
      const events = context.eventStore.events(runId, 0, 200);
      const cancel = events.find((event) => event.eventType === "run.cancel_requested");
      assert.equal(cancel?.payload.reason, "runtime_shutdown");
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("budget cancel and shutdown cancel racing yield one cancel_requested", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-budget-race-");
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
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
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
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
      const peek = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
      try {
        if (peek.eventStore.run(runId)?.status === "running") break;
      } finally {
        closeKxmRuntimeContext(peek);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await supervisor.stop();
    supervisor = undefined;
    const context = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    try {
      const cancels = context.eventStore.events(runId, 0, 200).filter((event) => event.eventType === "run.cancel_requested");
      assert.equal(cancels.length, 1);
      assert.ok(cancels[0]!.payload.reason === "budget_run_duration" || cancels[0]!.payload.reason === "runtime_shutdown");
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("supervisor /drive returns 409 for still-unsupported maxAgentTimeMs", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-agent-time-");
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    writeFileSync(join(root, ".kxm", "workflows", "agent-time.yaml"), `schema: kxm.workflow.v1
coordinator: coordinator
limits:
  maxTransitions: 2
  maxAgentTimeMs: 1000
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
    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "agent-time",
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

test("runs drive surfaces handoff field and detail on run_handoff_required", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-handoff-text-");
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  const stub = createServer((_request, response) => {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "run_handoff_required", handoff: { reason: "r".repeat(300), field: "f".repeat(300), detail: "d".repeat(300) } }));
  });
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    // The `kxm init` template no longer declares an agent-time limit, so the
    // workflow that needs a handoff declares its own.
    writeFileSync(join(root, ".kxm", "workflows", "agent-time.yaml"), `schema: kxm.workflow.v1
coordinator: coordinator
limits:
  maxTransitions: 2
  maxAgentTimeMs: 1000
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
    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", { projectRoot: root, workflowId: "agent-time", prompt: "handoff text" });
    const runId = (acceptance.run as { runId: string }).runId;
    // The same request `kxm runs drive` makes; its refusal text is what the CLI prints.
    await assert.rejects(
      kxmRuntimeRequest(handle, "POST", `/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, { mode: "simulated" }),
      (error: unknown) => {
        assert(error instanceof KxmConfigError);
        assert.equal(error.issues[0]?.code, "run_handoff_required");
        assert.match(error.message, /runtime request failed with HTTP 409 \(handoff reason limit_unsupported; field limits\.maxAgentTimeMs; detail agent-time budget enforcement is not available in this slice\)$/);
        return true;
      },
    );

    await new Promise<void>((resolveListen) => stub.listen(0, "127.0.0.1", resolveListen));
    const port = (stub.address() as { port: number }).port;
    await assert.rejects(
      kxmRuntimeRequest({ runtimeId: "rtm_stub", port, token: "tok", started: false }, "POST", "/v1/runs/run_x/drive", { mode: "simulated" }),
      (error: unknown) => {
        assert(error instanceof KxmConfigError);
        assert.match(error.message, new RegExp(`\\(handoff reason r{200}; field f{200}; detail d{200}\\)$`), "each handoff part is capped at 200 characters");
        return true;
      },
    );
  } finally {
    stub.close();
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("abort-ignoring producer returns after grace with attempt unreconciled", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-grace-unrec-");
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  const previousGrace = process.env.KXM_RUNTIME_STOP_GRACE_MS;
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(String(reason));
  };
  process.on("unhandledRejection", onUnhandled);
  process.env.KXM_RUNTIME_STOP_GRACE_MS = "120";
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
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
      const peek = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
      try {
        if (peek.eventStore.run(runId)?.status === "running") break;
      } finally {
        closeKxmRuntimeContext(peek);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    const stopStarted = Date.now();
    await supervisor.stop();
    const stopMs = Date.now() - stopStarted;
    supervisor = undefined;
    assert.ok(stopMs < 1500, `stop waited ${stopMs}ms, expected grace expiry`);
    const context = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
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
      const shutdownReceipt = receipts[0];
      assert.ok(shutdownReceipt && "settlement" in shutdownReceipt);
      assert.equal(shutdownReceipt.settlement.kind, "unsettled");
      assert.equal(shutdownReceipt.settlement.reason, "runtime_shutdown_grace_expired");
    } finally {
      closeKxmRuntimeContext(context);
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
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
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
    const context = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    try {
      const run = context.eventStore.run(runId);
      const admitted = kxmAdmittedToken(context.eventStore.path, runId);
      const status = run?.status ?? "missing";
      if (status === "preparing" || status === "running") {
        assert.ok(admitted, `started-unadmitted: status=${status} token=${String(admitted)}`);
      }
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("supervisor GET run returns a verified drive receipt after settle", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-receipt-get-");
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    writeFileSync(join(root, ".kxm", "workflows", "one-step.yaml"), `schema: kxm.workflow.v1
description: Single agent step used for scheduler admission tests.
coordinator: coordinator
limits:
  maxTransitions: 2
  maxRunDurationMs: 60000
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
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
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
      payload = await kxmRuntimeRequest(handle, "GET", `/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`);
      if ((payload.run as { status: string }).status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal((payload!.run as { status: string }).status, "completed");
    const drive = payload!.drive as {
      driveId: string;
      mode: string;
      openedAt: string;
      receipt: {
        driveId: string;
        logHash: string;
        settlement: { kind: string; status: string };
        budget: { budgetMs: number; source: string; elapsedMs: number; overrun: boolean } | null;
      };
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
    assert.ok(drive.receipt.budget);
    assert.equal(drive.receipt.budget.budgetMs, 60_000);
    assert.equal(drive.receipt.budget.source, "workflow");
    assert.equal(typeof drive.receipt.budget.elapsedMs, "number");
    assert.ok(drive.receipt.budget.elapsedMs >= 0);
    assert.equal(drive.receipt.budget.overrun, false);
  } finally {
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("supervisor GET reports verified false for a tampered logHash without 500", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-receipt-tamper-");
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
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
      const statusRes = await kxmRuntimeRequest(handle, "GET", `/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`);
      if ((statusRes.run as { status: string }).status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const peek = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
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
      closeKxmRuntimeContext(peek);
    }
    const tampered = await kxmRuntimeRequest(handle, "GET", `/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`);
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
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
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
      const statusRes = await kxmRuntimeRequest(handle, "GET", `/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`);
      if ((statusRes.run as { status: string }).status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const peek = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    try {
      const receipts = peek.eventStore.driveReceiptsForRun(runId);
      assert.equal(receipts.length, 1);
      const driveId = receipts[0]!.driveId;
      const db = new DatabaseSync(peek.eventStore.path);
      db.prepare("UPDATE drive_receipts SET receipt = ? WHERE drive_id = ?").run("this is not json {", driveId);
      db.close();
    } finally {
      closeKxmRuntimeContext(peek);
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

test("supervisor GET /drive returns an open session summary then newest-first receipts capped at 20", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-get-list-");
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "one-step",
      prompt: "drive list",
    });
    const runId = (acceptance.run as { runId: string }).runId;
    const driveRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "simulated", delayMs: 1500 }),
    });
    assert.equal(driveRes.status, 202);
    const driveBody = await driveRes.json() as { driveId: string };
    const openRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(openRes.status, 200);
    const openPayload = await openRes.json() as {
      ok: boolean;
      session: Record<string, unknown> | null;
      receipts: unknown[];
    };
    assert.equal(openPayload.ok, true);
    assert.ok(openPayload.session);
    assert.equal(openPayload.session.driveId, driveBody.driveId);
    assert.equal(openPayload.session.mode, "simulated");
    assert.equal(typeof openPayload.session.openedAt, "string");
    assert.ok("deadlineAt" in openPayload.session);
    assert.equal("token" in openPayload.session, false);
    assert.equal("controller" in openPayload.session, false);
    assert.equal("settled" in openPayload.session, false);
    assert.equal("producerId" in openPayload.session, false);
    const startTime = Date.now();
    while (Date.now() - startTime < 10_000) {
      const statusRes = await kxmRuntimeRequest(handle, "GET", `/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`);
      if ((statusRes.run as { status: string }).status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const peek = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    try {
      const existing = peek.eventStore.driveReceiptsForRun(runId);
      assert.equal(existing.length, 1);
      const original = existing[0];
      assert.ok(original && "settlement" in original);
      const originMs = Date.parse(original.closedAt);
      for (let i = 0; i < 20; i += 1) {
        const clone: KxmDriveReceipt = {
          ...original,
          driveId: `drv_${String(i).padStart(24, "0")}`,
          closedAt: new Date(originMs - (20 - i) * 1000).toISOString(),
        };
        assert.equal(peek.eventStore.insertDriveReceipt(clone).inserted, true);
      }
    } finally {
      closeKxmRuntimeContext(peek);
    }
    const listed = await kxmRuntimeRequest(handle, "GET", `/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`);
    assert.equal(listed.session, null);
    const receipts = listed.receipts as Array<{ driveId: string }>;
    assert.equal(receipts.length, 20);
    assert.equal(receipts[0]?.driveId, driveBody.driveId);
    assert.equal(receipts.some((row) => row.driveId === `drv_${String(0).padStart(24, "0")}`), false);
    const unknown = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/run_missing00000000000000/drive?projectRoot=${encodeURIComponent(root)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(unknown.status, 404);
  } finally {
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("supervisor GET /drive reports receipt divergence for a corrupt row without 500", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-get-corrupt-");
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "one-step",
      prompt: "drive get corrupt",
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
      const statusRes = await kxmRuntimeRequest(handle, "GET", `/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`);
      if ((statusRes.run as { status: string }).status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const peek = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    let driveId: string;
    try {
      const receipts = peek.eventStore.driveReceiptsForRun(runId);
      assert.equal(receipts.length, 1);
      driveId = receipts[0]!.driveId;
      const db = new DatabaseSync(peek.eventStore.path);
      db.prepare("UPDATE drive_receipts SET receipt = ? WHERE drive_id = ?").run("this is not json {", driveId);
      db.close();
    } finally {
      closeKxmRuntimeContext(peek);
    }
    const corruptRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs/${runId}/drive?projectRoot=${encodeURIComponent(root)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(corruptRes.status, 200);
    const payload = await corruptRes.json() as {
      ok: boolean;
      receipts: Array<{ driveId: string; divergence?: string }>;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.receipts.length, 1);
    assert.equal(payload.receipts[0]?.driveId, driveId);
    assert.equal(payload.receipts[0]?.divergence, "receipt unreadable");
  } finally {
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("supervisor GET /v1/drives/:id returns verified receipts and never 500 on tamper or missing", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-drive-by-id-");
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const missing = await fetch(`http://127.0.0.1:${supervisor.port}/v1/drives/drv_missing0000000000000000?projectRoot=${encodeURIComponent(root)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(missing.status, 404);
    const missingBody = await missing.json() as { ok: boolean; error: string };
    assert.equal(missingBody.ok, false);
    assert.equal(missingBody.error, "drive_receipt_missing");
    const noRoot = await fetch(`http://127.0.0.1:${supervisor.port}/v1/drives/drv_missing0000000000000000`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(noRoot.status, 400);
    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "one-step",
      prompt: "drive by id",
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
    while (Date.now() - startTime < 10_000) {
      const statusRes = await kxmRuntimeRequest(handle, "GET", `/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`);
      if ((statusRes.run as { status: string }).status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const verified = await kxmRuntimeRequest(handle, "GET", `/v1/drives/${driveBody.driveId}?projectRoot=${encodeURIComponent(root)}`);
    assert.equal(verified.ok, true);
    assert.equal(verified.verified, true);
    assert.equal(verified.divergence, undefined);
    assert.equal((verified.receipt as { driveId: string }).driveId, driveBody.driveId);
    const peekReadOnly = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    try {
      const db = new DatabaseSync(peekReadOnly.eventStore.path);
      db.prepare("DELETE FROM run_state WHERE run_id = ?").run(runId);
      const runBefore = db.prepare("SELECT status, updated_at FROM runs WHERE run_id = ?").get(runId) as { status: string; updated_at: string };
      db.close();
      const afterDelete = await kxmRuntimeRequest(handle, "GET", `/v1/drives/${driveBody.driveId}?projectRoot=${encodeURIComponent(root)}`);
      assert.equal(afterDelete.ok, true);
      assert.equal(afterDelete.verified, true);
      const dbAfter = new DatabaseSync(peekReadOnly.eventStore.path);
      const stateAfter = dbAfter.prepare("SELECT run_id FROM run_state WHERE run_id = ?").get(runId);
      const runAfter = dbAfter.prepare("SELECT status, updated_at FROM runs WHERE run_id = ?").get(runId) as { status: string; updated_at: string };
      dbAfter.close();
      assert.equal(stateAfter, undefined, "GET /v1/drives must not persist run_state");
      assert.deepEqual(runAfter, runBefore, "GET /v1/drives must not update runs");
    } finally {
      closeKxmRuntimeContext(peekReadOnly);
    }
    const peek = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    try {
      const db = new DatabaseSync(peek.eventStore.path);
      const row = db.prepare("SELECT receipt FROM drive_receipts WHERE drive_id = ?").get(driveBody.driveId) as { receipt: string };
      const parsed = JSON.parse(row.receipt) as { logHash: string };
      parsed.logHash = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
      db.prepare("UPDATE drive_receipts SET receipt = ? WHERE drive_id = ?").run(JSON.stringify(parsed), driveBody.driveId);
      db.close();
    } finally {
      closeKxmRuntimeContext(peek);
    }
    const tampered = await kxmRuntimeRequest(handle, "GET", `/v1/drives/${driveBody.driveId}?projectRoot=${encodeURIComponent(root)}`);
    assert.equal(tampered.ok, true);
    assert.equal(tampered.verified, false);
    assert.match(String(tampered.divergence), /logHash mismatch/);
    const peekCorrupt = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    try {
      const db = new DatabaseSync(peekCorrupt.eventStore.path);
      db.prepare("UPDATE drive_receipts SET receipt = ? WHERE drive_id = ?").run("this is not json {", driveBody.driveId);
      db.close();
    } finally {
      closeKxmRuntimeContext(peekCorrupt);
    }
    const corruptRes = await fetch(`http://127.0.0.1:${supervisor.port}/v1/drives/${driveBody.driveId}?projectRoot=${encodeURIComponent(root)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(corruptRes.status, 200);
    const corrupt = await corruptRes.json() as { ok: boolean; receipt: unknown; verified: boolean; divergence?: string };
    assert.equal(corrupt.ok, true);
    assert.equal(corrupt.receipt, null);
    assert.equal(corrupt.verified, false);
    assert.equal(corrupt.divergence, "receipt unreadable");
  } finally {
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

test("supervisor GET run is read-only: no run_state persistence, no runs update, no divergence 400", async () => {
  const { root, stateRoot } = engineProject("kxm-supervisor-run-get-readonly-");
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "one-step",
      prompt: "read-only get",
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
      const statusRes = await kxmRuntimeRequest(handle, "GET", `/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`);
      if ((statusRes.run as { status: string }).status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Missing run_state: GET must return the folded truth without recreating
    // the projection row or touching the runs row.
    const peek = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    let runBefore: { status: string; updated_at: string };
    try {
      const db = new DatabaseSync(peek.eventStore.path);
      db.prepare("DELETE FROM run_state WHERE run_id = ?").run(runId);
      runBefore = db.prepare("SELECT status, updated_at FROM runs WHERE run_id = ?").get(runId) as { status: string; updated_at: string };
      db.close();
    } finally {
      closeKxmRuntimeContext(peek);
    }
    const afterDelete = await kxmRuntimeRequest(handle, "GET", `/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`);
    assert.equal(afterDelete.ok, true);
    assert.equal((afterDelete.run as { status: string }).status, "completed");
    const peekAfterDelete = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    try {
      const db = new DatabaseSync(peekAfterDelete.eventStore.path);
      const stateAfter = db.prepare("SELECT run_id FROM run_state WHERE run_id = ?").get(runId);
      const runAfter = db.prepare("SELECT status, updated_at FROM runs WHERE run_id = ?").get(runId) as { status: string; updated_at: string };
      db.close();
      assert.equal(stateAfter, undefined, "GET /v1/runs must not persist run_state");
      assert.deepEqual(runAfter, runBefore, "GET /v1/runs must not update runs");
    } finally {
      closeKxmRuntimeContext(peekAfterDelete);
    }

    // Divergent-content run_state (same schema): GET returns the folded truth
    // with 200 instead of a 400 run_projection_divergent, and writes nothing.
    const peekDivergent = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    try {
      const db = new DatabaseSync(peekDivergent.eventStore.path);
      db.prepare("INSERT INTO run_state (run_id, last_sequence, state) VALUES (?, ?, ?)").run(runId, 1, JSON.stringify({ schema: "kxm.run-state.v2", status: "created" }));
      db.close();
    } finally {
      closeKxmRuntimeContext(peekDivergent);
    }
    const divergent = await kxmRuntimeRequest(handle, "GET", `/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`);
    assert.equal(divergent.ok, true);
    assert.equal((divergent.run as { status: string }).status, "completed");
    const peekDivergentAfter = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: handle.runtimeId });
    try {
      const db = new DatabaseSync(peekDivergentAfter.eventStore.path);
      const divergentState = db.prepare("SELECT state FROM run_state WHERE run_id = ?").get(runId) as { state: string };
      db.close();
      assert.equal(divergentState.state, JSON.stringify({ schema: "kxm.run-state.v2", status: "created" }), "GET must not rewrite run_state");
    } finally {
      closeKxmRuntimeContext(peekDivergentAfter);
    }
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

test("project run listing folds each run; a stale cache row and a failed fold cannot pose as state", async () => {
  // Pins the two properties the portal read depends on: the listing is folded event-log
  // state (a tampered `runs` row must not surface), and a run whose fold refuses is
  // returned with `projectionError` instead of failing the listing or hiding the run.
  const { root, stateRoot } = engineProject("kxm-supervisor-listing-fold-", ["one-step.yaml"]);
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const projectId = "prj_01JENGINE00000000000000000";

    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "one-step",
      prompt: "listing fold witness",
    });
    const runId = (acceptance.run as { runId: string }).runId;

    const listOnce = async () => (await kxmRuntimeRequest(handle, "GET", `/v1/projects/${projectId}/runs?projectRoot=${encodeURIComponent(root)}`))
      .runs as Array<{ runId: string; status: string; projectionError?: string }>;

    const clean = await listOnce();
    const listed = clean.find((run) => run.runId === runId);
    assert.ok(listed, "the created run appears in the listing");
    assert.equal(listed.projectionError, undefined, "a healthy run folds without error");
    const foldedStatus = listed.status;

    // Stale cache: rewrite the stored row to a lie. A folded listing ignores it; a listing
    // of raw rows would print the lie.
    const paths = kxmRuntimePaths({ stateRoot });
    // The event store lives under a root-derived project key, not the project id; the
    // isolated state root holds exactly one project, so locate its store by directory.
    const projectDir = readdirSync(paths.projectsDir).find((entry) => existsSync(join(paths.projectsDir, entry, "run-events.db")));
    assert.ok(projectDir, "the isolated state root must hold the project's event store");
    const db = new DatabaseSync(join(paths.projectsDir, projectDir, "run-events.db"));
    try {
      db.prepare("UPDATE runs SET status = 'completed' WHERE run_id = ?").run(runId);
      const afterStale = await listOnce();
      const staleRow = afterStale.find((run) => run.runId === runId);
      assert.ok(staleRow);
      assert.notEqual(staleRow.status, "completed", "a tampered cached row must not surface as the run's state");
      assert.equal(staleRow.projectionError, undefined);

      // Failed fold: destroy the events so the fold refuses. The listing must return the
      // run — with the failure named — rather than 500 or silently drop it.
      db.prepare("DELETE FROM events WHERE run_id = ?").run(runId);
      const afterCorrupt = await listOnce();
      const corruptRow = afterCorrupt.find((run) => run.runId === runId);
      assert.ok(corruptRow, "a run that fails to fold stays visible");
      assert.equal(typeof corruptRow.projectionError, "string", "the failure is named on the row");
      assert.match(corruptRow.projectionError!, /^(run_|runtime_)/, "the failure carries a stable machine code");
      void foldedStatus;
    } finally {
      db.close();
    }
  } finally {
    if (supervisor) await supervisor.stop();
    removeTempDir(root, stateRoot);
  }
});

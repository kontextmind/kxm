import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeTempDir, waitFor } from "../helpers.ts";
import { committedProject } from "../helpers/project.ts";
import {
  KxmRunEventStore,
  KxmRuntimeRegistry,
  KXM_EVENT_STORE_SCHEMA_VERSION,
  KXM_REGISTRY_SCHEMA_VERSION,
  newKxmCommandId,
  projectRuntimeKey,
  kxmRuntimePaths,
} from "../../plugins/kxm/src/runtime-store.ts";
import {
  acceptKxmRun,
  cancelKxmRun,
  closeKxmRuntimeContext,
  openKxmRuntimeContext,
  readKxmRunStatus,
  rebuildKxmRunProjection,
  kxmPolicyRevisions,
  kxmRunRevisionDrift,
} from "../../plugins/kxm/src/runtime-service.ts";
import {
  ensureKxmSupervisor,
  readKxmSupervisorToken,
  startKxmRuntimeSupervisor,
  kxmRuntimeRequest,
  kxmSupervisorStatus,
  kxmSupervisorTokenFile,
} from "../../plugins/kxm/src/runtime-supervisor.ts";
import { loadKxmProject, KxmConfigError } from "../../plugins/kxm/src/project-config.ts";

function cleanup(...paths: string[]): void {
  removeTempDir(...paths);
}

for (const kind of ["registry", "events"] as const) {
  test(`concurrent first-open initializes the ${kind} database once`, { timeout: 25_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "kxm-runtime-first-open-"));
    const databasePath = join(directory, "state.db");
    const fixture = fileURLToPath(new URL("../fixtures/runtime/concurrent-first-open.ts", import.meta.url));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const children = ["one", "two"].map((participant) => {
      const child = spawn(process.execPath, [
        "--disable-warning=ExperimentalWarning", "--experimental-strip-types",
        fixture, kind, databasePath, directory, participant,
      ], { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", (error: Error) => { stderr += error.message; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 18_000);
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve) => {
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, stderr });
        });
      });
      return { child, closed };
    });
    try {
      await waitFor(() => ["one", "two"].every((id) => existsSync(join(directory, `arrived-${id}`))), 10_000);
      writeFileSync(join(directory, "release"), "go");
      for (const result of await Promise.all(children.map(({ closed }) => closed))) {
        assert.equal(result.code, 0, `concurrent opener failed (${result.signal}): ${result.stderr}`);
      }
      const database = new DatabaseSync(databasePath);
      try {
        const version = database.prepare("PRAGMA user_version").get() as { user_version: number };
        assert.equal(version.user_version, kind === "registry" ? KXM_REGISTRY_SCHEMA_VERSION : KXM_EVENT_STORE_SCHEMA_VERSION);
        const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
        assert.deepEqual(tables.map(({ name }) => name), kind === "registry"
          ? ["projects", "supervisor"]
          : ["attempt_capabilities", "commands", "drive_receipts", "events", "gate_attempts", "gate_evidence", "gate_observations", "run_plans", "run_state", "runs"]);
      } finally {
        database.close();
      }
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await Promise.all(children.map(({ closed }) => closed));
      cleanup(directory);
    }
  });
}

test("run acceptance is immutable, idempotent, and pins revisions", () => {
  const { root, stateRoot } = committedProject("kxm-runtime-accept-");
  try {
    const bundle = loadKxmProject(root);
    const revisions = kxmPolicyRevisions(bundle);
    assert.match(revisions.configRevision, /^sha256:[a-f0-9]{64}$/);
    assert.match(revisions.memoryRevision, /^ctxrev_[a-f0-9]{64}$/);
    assert.match(revisions.executorPolicyRevision, /^sha256:[a-f0-9]{64}$/);
    assert.match(revisions.toolPolicyRevision, /^sha256:[a-f0-9]{64}$/);

    const context = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: "rtm_01JTEST000000000000000000" });
    try {
      const commandId = newKxmCommandId();
      const first = acceptKxmRun(context, bundle, { commandId, workflowId: "default", prompt: "fix the bug" });
      assert.equal(first.idempotent, false);
      assert.match(first.run.runId, /^run_[a-f0-9]{32}$/);
      assert.equal(first.run.homeRuntimeId, context.homeRuntimeId);
      assert.equal(first.run.configRevision, bundle.configRevision);
      assert.equal(first.run.status, "created");
      assert.equal(first.event.sequence, 1);
      assert.equal(first.event.eventType, "run.created");
      const payload = first.event.payload as { promptHash: string; workflowId: string; repositoryIds: string[]; executorIds: string[] };
      assert.match(payload.promptHash, /^sha256:/);
      assert.equal(payload.workflowId, "default");
      assert.deepEqual(payload.repositoryIds, ["control"]);
      assert.equal(first.event.schema, "kxm.run-event.v1");
      assert.equal(first.event.memoryRevision, revisions.memoryRevision);
      assert.equal(first.run.memoryRevision, revisions.memoryRevision);
      assert(!JSON.stringify(first.event.payload).includes("fix the bug"), "prompt content is never stored");
      assert(!JSON.stringify(context.eventStore.events(first.run.runId, 0, 10)).includes("fix the bug"), "prompt content is never stored");

      const second = acceptKxmRun(context, bundle, { commandId, workflowId: "default", prompt: "fix the bug" });
      assert.equal(second.idempotent, true, "repeated commandId returns the prior acceptance");
      assert.equal(second.run.runId, first.run.runId);
      assert.equal(context.eventStore.events(first.run.runId, 0, 10).length, 1, "no duplicate semantic events");

      // Home runtime is immutable across contexts.
      const reopened = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: "rtm_01JTEST000000000000000000" });
      try {
        assert.equal(reopened.homeRuntimeId, context.homeRuntimeId);
      } finally {
        closeKxmRuntimeContext(reopened);
      }

      const drift = kxmRunRevisionDrift(first.run, bundle);
      assert.equal(drift.configDrift, false);
      assert.equal(drift.pinnedRevision, bundle.configRevision);
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    cleanup(root, stateRoot);
  }
});

test("event sequence integrity and projection rebuild equivalence", () => {
  const { root, stateRoot } = committedProject("kxm-runtime-projection-");
  try {
    const bundle = loadKxmProject(root);
    const context = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: "rtm_01JTEST000000000000000000" });
    try {
      const accepted = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "work" });
      const cancelled = cancelKxmRun(context, accepted.run.runId);
      assert.equal(cancelled.idempotent, false);
      assert.equal(cancelled.events.length, 2);
      assert.equal(cancelled.events[0]!.eventType, "run.cancel_requested");
      assert.equal(cancelled.events[0]!.sequence, 2);
      assert.equal(cancelled.events[1]!.eventType, "run.status_changed");
      assert.equal(cancelled.events[1]!.sequence, 3);
      assert.equal(cancelled.run.status, "cancelled");

      const events = context.eventStore.events(accepted.run.runId, 0, 100);
      assert.equal(events.length, 3);
      assert.equal(readKxmRunStatus(context, accepted.run), "cancelled");
      const rebuilt = rebuildKxmRunProjection(context, accepted.run.runId);
      assert.equal(rebuilt.status, "cancelled", "projection rebuild matches incremental state");
      assert.equal(rebuilt.runId, accepted.run.runId);

      // Terminal runs ignore further cancels (idempotent).
      const again = cancelKxmRun(context, accepted.run.runId);
      assert.equal(again.idempotent, true);
      assert.equal(context.eventStore.events(accepted.run.runId, 0, 100).length, 3, "terminal runs append nothing");

      // Idempotent cancel command returns prior result without appending.
      const commandId = newKxmCommandId();
      const run2 = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "second" });
      const cancelFirst = cancelKxmRun(context, run2.run.runId, { commandId });
      const cancelSecond = cancelKxmRun(context, run2.run.runId, { commandId });
      assert.equal(cancelSecond.idempotent, true);
      assert.equal(context.eventStore.events(run2.run.runId, 0, 100).length, 3);
      void cancelFirst;
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    cleanup(root, stateRoot);
  }
});

test("registry supervisor claim, takeover, and project home immutability", () => {
  const { root, stateRoot } = committedProject("kxm-runtime-registry-");
  try {
    const paths = kxmRuntimePaths({ stateRoot });
    assert.equal(paths.registryDb, join(stateRoot, "runtime", "registry.db"));
    assert.equal(projectRuntimeKey(root), projectRuntimeKey(root));
    const registry = new KxmRuntimeRegistry(paths.registryDb);
    try {
      const now = new Date().toISOString();
      const first = registry.claimSupervisor({ runtimeId: "rtm_one", pid: 111, port: 5001, tokenHash: "sha256:a", now });
      assert.equal(first.claimed, true);
      assert.equal(first.record.runtimeId, "rtm_one");
      const conflict = registry.claimSupervisor({ runtimeId: "rtm_two", pid: 222, port: 5002, tokenHash: "sha256:b", now });
      assert.equal(conflict.claimed, false, "a second supervisor cannot claim the singleton");
      assert.equal(conflict.record.runtimeId, "rtm_one");
      const taken = registry.takeoverSupervisor({ runtimeId: "rtm_two", pid: 222, port: 5002, tokenHash: "sha256:b", now, observedDeadPid: 111, observedHeartbeatAt: registry.supervisor()!.heartbeatAt });
      assert.equal(taken.runtimeId, "rtm_one", "takeover preserves the logical runtime identity across restarts");
      registry.heartbeat(222, now);
      assert.equal(registry.supervisor()!.state, "running");
      registry.markStopping(222, now);
      assert.equal(registry.supervisor()!.state, "stopping");
      registry.markStopped(222, now);
      assert.equal(registry.supervisor()!.state, "stopped");

      const bundle = loadKxmProject(root);
      const projectId = String(bundle.project.value.id);
      const registration = registry.registerProject({ projectId, projectRoot: root, homeRuntimeId: "rtm_one", now });
      assert.equal(registration.homeRuntimeId, "rtm_one");
      const rebound = registry.registerProject({ projectId, projectRoot: root, homeRuntimeId: "rtm_one", now });
      assert.equal(rebound.projectId, projectId, "re-registration with the same home is idempotent");
      assert.throws(
        () => registry.registerProject({ projectId, projectRoot: root, homeRuntimeId: "rtm_two", now }),
        /home runtime is immutable/,
      );
    } finally {
      registry.close();
    }
  } finally {
    cleanup(root, stateRoot);
  }
});

test("supervisor lifecycle: start, API, auth, runs, graceful stop", async () => {
  const { root, stateRoot } = committedProject("kxm-runtime-supervisor-");
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    assert(supervisor.port > 0);
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };

    const health = await fetch(`http://127.0.0.1:${supervisor.port}/healthz`);
    assert.equal(health.ok, true);

    // Unauthenticated requests are rejected.
    const unauthorized = await fetch(`http://127.0.0.1:${supervisor.port}/v1/projects/prj_x/runs?projectRoot=${encodeURIComponent(root)}`);
    assert.equal(unauthorized.status, 401);

    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "default",
      prompt: "offline work",
    });
    const run = acceptance.run as { runId: string; status: string };
    assert.equal(run.status, "created");

    const status = await kxmRuntimeRequest(handle, "GET", `/v1/runs/${run.runId}?projectRoot=${encodeURIComponent(root)}`);
    assert.equal((status.run as { status: string }).status, "created");

    const events = await kxmRuntimeRequest(handle, "GET", `/v1/runs/${run.runId}/events?projectRoot=${encodeURIComponent(root)}`);
    assert.equal((events.events as unknown[]).length, 1);

    const wait = await kxmRuntimeRequest(handle, "POST", `/v1/runs/${run.runId}/wait?projectRoot=${encodeURIComponent(root)}`, {
      stageId: "stage-1",
      signalKey: "sig-1",
    }) as { ok: boolean; waiting: boolean };
    assert.equal(wait.ok, true);
    assert.equal(wait.waiting, true);

    const signal = await kxmRuntimeRequest(handle, "POST", `/v1/runs/${run.runId}/signal?projectRoot=${encodeURIComponent(root)}`, {
      signalKey: "sig-1",
      status: "passed",
      summary: "signal complete",
    }) as { ok: boolean; unblocked: boolean };
    assert.equal(signal.ok, true);

    const cancel = await kxmRuntimeRequest(handle, "POST", `/v1/runs/${run.runId}/cancel?projectRoot=${encodeURIComponent(root)}`, {});
    assert.equal((cancel.run as { status: string }).status, "cancelled");

    // Dead dispatch endpoint is braked and returns 404
    await assert.rejects(
      () => kxmRuntimeRequest(handle, "POST", `/v1/runs/${run.runId}/dispatch?projectRoot=${encodeURIComponent(root)}`, {}),
      /not found|404/i,
    );

    const list = await kxmRuntimeRequest(handle, "GET", `/v1/projects/prj_01JRUNTIMETEST0000000000/runs?projectRoot=${encodeURIComponent(root)}`);
    assert.equal((list.runs as unknown[]).length, 1);

    const statusCheck = kxmSupervisorStatus(kxmRuntimePaths({ stateRoot }));
    assert.equal(statusCheck.running, true);
    assert.equal(statusCheck.runtimeId, supervisor.runtimeId);

    await supervisor.stop();
    supervisor = undefined;
    const stopped = kxmSupervisorStatus(kxmRuntimePaths({ stateRoot }));
    assert.equal(stopped.running, false);
  } finally {
    if (supervisor) await supervisor.stop();
    cleanup(root, stateRoot);
  }
});

test("takeover races and pid-guarded singleton updates", () => {
  const { stateRoot } = committedProject("kxm-runtime-race-");
  try {
    const paths = kxmRuntimePaths({ stateRoot });
    const registry = new KxmRuntimeRegistry(paths.registryDb);
    try {
      const now = new Date().toISOString();
      registry.claimSupervisor({ runtimeId: "rtm_one", pid: 111, port: 5001, tokenHash: "sha256:a", now });
      // Two takeovers race for the same dead pid: exactly one wins.
      const winner = registry.takeoverSupervisor({ runtimeId: "rtm_two", pid: 333, port: 5003, tokenHash: "sha256:c", now, observedDeadPid: 111, observedHeartbeatAt: registry.supervisor()!.heartbeatAt });
      assert.equal(winner.runtimeId, "rtm_one");
      assert.throws(
        () => registry.takeoverSupervisor({ runtimeId: "rtm_three", pid: 444, port: 5004, tokenHash: "sha256:d", now, observedDeadPid: 111, observedHeartbeatAt: registry.supervisor()!.heartbeatAt }),
        /another process claimed the supervisor singleton first/,
      );
      // A losing takeover's heartbeat/stop marks cannot clobber the winner.
      registry.heartbeat(111, now);
      registry.markStopping(111, now);
      registry.markStopped(111, now);
      const record = registry.supervisor()!;
      assert.equal(record.pid, 333, "winner's pid survives loser's updates");
      assert.equal(record.state, "running", "winner's state survives loser's stop marks");
      // The exact compare-and-swap defect class: same pid, but the incumbent
      // refreshed its heartbeat between observation and takeover.
      const later = new Date(Date.now() + 60_000).toISOString();
      registry.heartbeat(333, later);
      assert.throws(
        () => registry.takeoverSupervisor({ runtimeId: "rtm_four", pid: 555, port: 5005, tokenHash: "sha256:e", now, observedDeadPid: 333, observedHeartbeatAt: now }),
        /another process claimed the supervisor singleton first/,
        "a heartbeat-refreshing incumbent defeats the takeover compare-and-swap",
      );
      // The owner's own updates apply.
      registry.markStopping(333, now);
      assert.equal(registry.supervisor()!.state, "stopping");
    } finally {
      registry.close();
    }
  } finally {
    cleanup(stateRoot);
  }
});

test("newer schema versions fail closed; command conflicts and status validation", () => {
  const { root, stateRoot } = committedProject("kxm-runtime-schema-");
  try {
    const paths = kxmRuntimePaths({ stateRoot });
    const registry = new KxmRuntimeRegistry(paths.registryDb);
    registry.close();
    const bump = new DatabaseSync(paths.registryDb);
    bump.exec("PRAGMA user_version = 99");
    bump.close();
    assert.throws(() => new KxmRuntimeRegistry(paths.registryDb), /newer than this runtime supports/);
    const restore = new DatabaseSync(paths.registryDb);
    restore.exec("PRAGMA user_version = 1");
    restore.close();

    // Command conflicts: kind, runId, and request mismatches fail closed.
    const bundle = loadKxmProject(root);
    const context = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: "rtm_01JTEST000000000000000000" });
    try {
      const acceptCommand = newKxmCommandId();
      acceptKxmRun(context, bundle, { commandId: acceptCommand, workflowId: "default", prompt: "one" });
      assert.throws(
        () => acceptKxmRun(context, bundle, { commandId: acceptCommand, workflowId: "default", prompt: "different" }),
        /run_command_conflict/,
      );
      assert.throws(
        () => cancelKxmRun(context, "run_00000000000000000000000000000000", { commandId: acceptCommand }),
        /run_command_conflict/,
      );
      const run2 = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "two" });
      const cancelCommand = newKxmCommandId();
      cancelKxmRun(context, run2.run.runId, { commandId: cancelCommand });
      const third = cancelKxmRun(context, run2.run.runId, { commandId: cancelCommand });
      assert.equal(third.idempotent, true, "repeated cancel command is idempotent, not a conflict");
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    cleanup(root, stateRoot);
  }
});

test("supervisor API misuse: relative roots, oversized and non-object bodies, unknown paths", async () => {
  const { root, stateRoot } = committedProject("kxm-runtime-apimisuse-");
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;

    const relative = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ projectRoot: "relative/path", workflowId: "default", prompt: "x" }),
    });
    assert.equal(relative.status, 400);

    const arrayBody = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "[]",
    });
    assert.equal(arrayBody.status, 400);

    const oversized = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ projectRoot: root, workflowId: "default", prompt: "x".repeat(200_000) }),
    });
    assert.equal(oversized.status, 400);

    const unknownPath = await fetch(`http://127.0.0.1:${supervisor.port}/v1/nope`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(unknownPath.status, 404);

    const wrongMethod = await fetch(`http://127.0.0.1:${supervisor.port}/v1/runs`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(wrongMethod.status, 404);

    await supervisor.stop();
    supervisor = undefined;
  } finally {
    if (supervisor) await supervisor.stop();
    cleanup(root, stateRoot);
  }
});

test("token rotation: a pre-restart token cannot reach the restarted supervisor", async () => {
  const { stateRoot } = committedProject("kxm-runtime-rotation-");
  const paths = kxmRuntimePaths({ stateRoot });
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const oldToken = readKxmSupervisorToken(paths)!;
    const health = await fetch(`http://127.0.0.1:${supervisor.port}/healthz`);
    assert.equal(health.ok, true);
    await supervisor.stop();
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));

    const second = await startKxmRuntimeSupervisor({ stateRoot });
    try {
      const newToken = readKxmSupervisorToken(paths)!;
      assert.notEqual(newToken, oldToken, "restart rotates the token");
      const stale = await fetch(`http://127.0.0.1:${second.port}/v1/projects/prj_x/runs?projectRoot=${encodeURIComponent("C:\\")}`, {
        headers: { authorization: `Bearer ${oldToken}` },
      });
      assert.equal(stale.status, 401, "the pre-restart token is rejected after rotation");
      const fresh = await fetch(`http://127.0.0.1:${second.port}/v1/projects/prj_x/runs?projectRoot=${encodeURIComponent("C:\\")}`, {
        headers: { authorization: `Bearer ${newToken}` },
      });
      assert.notEqual(fresh.status, 401, "the rotated token authenticates");
    } finally {
      await second.stop();
    }
    supervisor = undefined;
  } finally {
    if (supervisor) await supervisor.stop();
    cleanup(stateRoot);
  }
});

test("post-takeover ensureKxmSupervisor reuses the live supervisor (healthz reports the inherited id)", async () => {
  const { stateRoot } = committedProject("kxm-runtime-posttakeover-");
  const paths = kxmRuntimePaths({ stateRoot });
  const script = join(process.cwd(), "scripts", "kxm-runtime-supervisor.mjs");
  const env = { ...process.env, KXM_STATE_HOME: stateRoot };
  const first = spawnChild(script, env);
  let second: ReturnType<typeof spawnChild> | undefined;
  try {
    await waitForSupervisor(paths);
    first.kill("SIGKILL");
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    second = spawnChild(script, env);
    await waitForSupervisor(paths);
    // The restarted supervisor must be reused by ensureKxmSupervisor via the
    // healthz proof (which now reports the inherited logical runtime id).
    const handle = await ensureKxmSupervisor({ stateRoot });
    assert.equal(handle.started, false, "the restarted supervisor is reused, not re-spawned");
    assert(handle.token.length >= 32);
  } finally {
    try { first.kill("SIGKILL"); } catch { /* already dead */ }
    if (second) second.kill("SIGKILL");
    await new Promise((resolveWait) => setTimeout(resolveWait, 600));
    cleanup(stateRoot);
  }
});

test("supervisor.error is cleared on start and a loser cannot overwrite the winner's token", async () => {
  const { stateRoot } = committedProject("kxm-runtime-errorfile-");
  const paths = kxmRuntimePaths({ stateRoot });
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(paths.runtimeDir, "supervisor.error"), "stale failure\n", "utf8");
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const winnerToken = readKxmSupervisorToken(paths)!;

    // A second in-process supervisor loses the claim: it must not overwrite
    // the winner's token file, and its conflict is not recorded as an error.
    const { lstatSync, readFileSync } = await import("node:fs");
    const mtimeBefore = lstatSync(kxmSupervisorTokenFile(paths)).mtimeMs;
    await assert.rejects(
      startKxmRuntimeSupervisor({ stateRoot }),
      /runtime supervisor is already managed/,
    );
    assert.equal(readKxmSupervisorToken(paths), winnerToken, "the loser's token never replaces the winner's");
    assert.equal(lstatSync(kxmSupervisorTokenFile(paths)).mtimeMs, mtimeBefore, "token file untouched by the loser");
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(join(paths.runtimeDir, "supervisor.error")), false, "a conflict is not recorded as a startup error");

    await supervisor.stop();
    supervisor = undefined;
  } finally {
    if (supervisor) await supervisor.stop();
    cleanup(stateRoot);
  }
});

test("a superseded supervisor exits when its heartbeat no longer owns the singleton", async () => {
  const { stateRoot } = committedProject("kxm-runtime-superseded-");
  const paths = kxmRuntimePaths({ stateRoot });
  const script = join(process.cwd(), "scripts", "kxm-runtime-supervisor.mjs");
  const env = { ...process.env, KXM_STATE_HOME: stateRoot };
  const child = spawnChild(script, env);
  try {
    const status = await waitForSupervisor(paths);
    const childPid = status.pid as number;
    // A competitor takes over the singleton; the child's next heartbeat
    // updates 0 rows and it must shut itself down instead of lingering.
    const registry = new KxmRuntimeRegistry(paths.registryDb);
    try {
      registry.takeoverSupervisor({
        runtimeId: "rtm_competitor",
        pid: 999_999_999,
        port: (status.port as number) + 1,
        tokenHash: "sha256:competitor",
        now: new Date().toISOString(),
        observedDeadPid: childPid, observedHeartbeatAt: (status as { heartbeatAt?: string }).heartbeatAt as string,
      });
    } finally {
      registry.close();
    }
    const deadline = Date.now() + 8_000;
    let exited = false;
    while (Date.now() < deadline) {
      if (!processAliveCheck(childPid)) { exited = true; break; }
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
    assert.equal(exited, true, "the superseded child exited on its own after losing the singleton");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    cleanup(stateRoot);
  }
});

function processAliveCheck(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("crash recovery: SIGKILL then restart yields identical projected state", async () => {
  const { root, stateRoot } = committedProject("kxm-runtime-recovery-");
  const paths = kxmRuntimePaths({ stateRoot });
  const script = join(process.cwd(), "scripts", "kxm-runtime-supervisor.mjs");
  const env = { ...process.env, KXM_STATE_HOME: stateRoot };
  let first: ChildProcess | undefined;
  let second: ChildProcess | undefined;
  try {
    // Start a real supervisor child process and create a run through it.
    first = spawnChild(script, env);
    const token = await waitForToken(paths);
    const firstStatus = await waitForSupervisor(paths);
    const firstHandle = { runtimeId: firstStatus.runtimeId as string, port: firstStatus.port as number, token, started: true };
    const acceptance = await kxmRuntimeRequest(firstHandle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "default",
      prompt: "durable",
    });
    const runId = (acceptance.run as { runId: string }).runId;

    // SIGKILL the supervisor: registry still claims the dead pid.
    first?.kill("SIGKILL");
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    const dead = kxmSupervisorStatus(paths);
    assert.equal(dead.running, false, "the killed supervisor reports dead");

    // A new supervisor takes over (same logical runtime id) and serves
    // identical projected state. The token rotated on restart; re-read it.
    second = spawnChild(script, env);
    const secondStatus = await waitForSupervisor(paths);
    const secondToken = await waitForToken(paths, token);
    assert.equal(secondStatus.runtimeId, firstStatus.runtimeId, "the logical runtime identity survives takeover");
    assert.notEqual(secondStatus.pid, firstStatus.pid, "the process is new");
    const secondHandle = { runtimeId: secondStatus.runtimeId as string, port: secondStatus.port as number, token: secondToken, started: true };
    const recovered = await kxmRuntimeRequest(secondHandle, "GET", `/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`);
    assert.equal((recovered.run as { runId: string }).runId, runId);
    assert.equal((recovered.run as { status: string }).status, "created");
    const events = await kxmRuntimeRequest(secondHandle, "GET", `/v1/runs/${runId}/events?projectRoot=${encodeURIComponent(root)}`);
    assert.equal((events.events as unknown[]).length, 1, "the creation event survived the crash");
  } finally {
    // TerminateProcess is asynchronous on Windows: wait for both children to
    // exit so their SQLite handles are released before the state dir goes.
    await Promise.all([killAndWait(first), killAndWait(second)]);
    cleanup(root, stateRoot);
  }
});

async function killAndWait(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => {
    const timer = setTimeout(resolveExit, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
    child.kill("SIGKILL");
  });
}

import { spawn, type ChildProcess } from "node:child_process";

function spawnChild(script: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: "ignore",
    env,
    windowsHide: true,
  });
  child.unref();
  return child;
}

/** The supervisor claims the registry before it publishes its token, so a
 * takeover briefly leaves the previous token on disk. Pass `previous` to
 * wait for the rotated one. */
async function waitForToken(paths: ReturnType<typeof kxmRuntimePaths>, previous?: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const token = readKxmSupervisorToken(paths);
    if (token && token !== previous) return token;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("supervisor token did not appear in time");
}

async function waitForSupervisor(paths: ReturnType<typeof kxmRuntimePaths>): Promise<{ runtimeId?: string; pid?: number; port?: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = kxmSupervisorStatus(paths);
    if (status.running && status.port) return status;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("supervisor did not become ready in time");
}

test("ensureKxmSupervisor auto-starts a detached supervisor and reuses it", async () => {
  const { stateRoot } = committedProject("kxm-runtime-autostart-");
  const paths = kxmRuntimePaths({ stateRoot });
  let handle: Awaited<ReturnType<typeof ensureKxmSupervisor>> | undefined;
  try {
    handle = await ensureKxmSupervisor({ stateRoot });
    assert(handle.port > 0);
    assert.equal(handle.started, true);
    const again = await ensureKxmSupervisor({ stateRoot });
    assert.equal(again.started, false, "the live supervisor is reused");
    assert.equal(again.port, handle.port);
    const status = kxmSupervisorStatus(paths);
    assert.equal(status.running, true);
    await kxmRuntimeRequest(handle, "POST", "/v1/shutdown", {});
    const deadline = Date.now() + 5_000;
    let stopped = kxmSupervisorStatus(paths);
    while (stopped.running && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      stopped = kxmSupervisorStatus(paths);
    }
    assert.equal(stopped.running, false, "supervisor stopped cleanly before cleanup");
  } finally {
    if (handle) {
      try { await kxmRuntimeRequest(handle, "POST", "/v1/shutdown", {}); } catch { /* already stopped */ }
      await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    }
    cleanup(stateRoot);
  }
});

test("runtime store rejects database file and sidecars that are symbolic links", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-runtime-symlink-"));
  try {
    const target = join(dir, "target.db");
    const linkDb = join(dir, "link.db");
    writeFileSync(target, "");
    try {
      symlinkSync(target, linkDb);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return; // Skip on Windows without symlink privileges
      throw error;
    }
    assert.throws(
      () => new KxmRuntimeRegistry(linkDb),
      (err: unknown) => err instanceof KxmConfigError && err.issues[0]?.code === "runtime_path_invalid" && err.message.includes("must be a regular file, not a link"),
    );

    for (const suffix of ["-wal", "-shm"]) {
      const realDb = join(dir, `real${suffix}.db`);
      const sidecar = `${realDb}${suffix}`;
      const sidecarTarget = join(dir, `target${suffix}`);
      writeFileSync(sidecarTarget, "");
      symlinkSync(sidecarTarget, sidecar);
      assert.throws(
        () => new KxmRuntimeRegistry(realDb),
        (err: unknown) => err instanceof KxmConfigError && err.issues[0]?.code === "runtime_path_invalid" && err.message.includes("sidecar must not be a link"),
      );
    }
  } finally {
    cleanup(dir);
  }
});

test("supervisor token reader rejects token file if it is a symbolic link", () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-supervisor-token-symlink-"));
  try {
    const paths = kxmRuntimePaths({ stateRoot: dir });
    const target = join(dir, "real-token");
    writeFileSync(target, "a".repeat(32));
    const tokenFile = kxmSupervisorTokenFile(paths);
    mkdirSync(dirname(tokenFile), { recursive: true });
    try {
      symlinkSync(target, tokenFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    assert.throws(
      () => readKxmSupervisorToken(paths),
      (err: unknown) => err instanceof KxmConfigError && err.issues[0]?.code === "runtime_path_invalid" && err.message.includes("supervisor token file must be a regular file, not a link"),
    );
  } finally {
    cleanup(dir);
  }
});

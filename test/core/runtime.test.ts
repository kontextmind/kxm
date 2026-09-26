import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeTempDir, waitFor } from "../helpers.ts";
import { makeGitRoot } from "../helpers/git-root.ts";
import { committedProject } from "../helpers/project.ts";
import { initializeKxmProject } from "../../plugins/kxm/src/init.ts";
import {
  KxmRunEventStore,
  KxmRuntimeRegistry,
  KXM_EVENT_STORE_SCHEMA_VERSION,
  KXM_EVENT_STORE_TABLE_NAMES,
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
  syncKxmOutbox,
} from "../../plugins/kxm/src/runtime-supervisor.ts";
import { loadKxmProject, KxmConfigError, syncEventSchemaErrors } from "../../plugins/kxm/src/project-config.ts";
import { createMeshHub } from "../../plugins/kxm/src/hub.ts";
import { HubHttpError, RuntimeHubClient } from "../../plugins/kxm/src/client.ts";
import { deriveKxmSyncEvent, KXM_DEFAULT_SYNC_POLICY_REVISION, type KxmSyncEvent } from "../../plugins/kxm/src/sync-transform.ts";

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
        // `sqlite_sequence` is SQLite's own bookkeeping for the outbox AUTOINCREMENT, not a store table.
        const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
        assert.deepEqual(tables.map(({ name }) => name), kind === "registry"
          ? ["projects", "supervisor"]
          : [...KXM_EVENT_STORE_TABLE_NAMES]);
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

import { spawn, spawnSync, type ChildProcess } from "node:child_process";

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

test("outbox rows are sync-safe and the hub accepts each project-run-sequence exactly once", async () => {
  const { root, stateRoot } = committedProject("kxm-runtime-outbox-");
  const secret = "s3cr3t-registered-value-7781";
  const entries: Array<Record<string, unknown>> = [];
  let clock = Date.now();
  const authToken = "outbox-test-admin-token";
  const hub = createMeshHub({ port: 0, authToken, rateLimit: false, now: () => clock, logger: (entry) => entries.push(entry) });
  try {
    // An event store one schema back is refused, never reshaped.
    const outdated = join(stateRoot, "v5-events.db");
    const prior = new DatabaseSync(outdated);
    prior.exec("PRAGMA user_version = 5");
    prior.close();
    assert.throws(
      () => new KxmRunEventStore(outdated),
      new RegExp(`runtime_schema_outdated[\\s\\S]*is schema version 5; this build requires ${KXM_EVENT_STORE_SCHEMA_VERSION}`),
    );
    assert.equal(KXM_EVENT_STORE_SCHEMA_VERSION, 7);
    assert(KXM_EVENT_STORE_TABLE_NAMES.includes("outbox"));

    const bundle = loadKxmProject(root);
    const context = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: "rtm_01JTEST000000000000000000" });
    try {
      context.eventStore.syncRedactor.register(secret);
      const accepted = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "private prompt body do-not-sync" });
      const runId = accepted.run.runId;
      cancelKxmRun(context, runId, { reason: `operator stop ${secret} at /Users/operator/.ssh/id_ed25519 token=abc123` });

      // Every committed event has exactly one outbox row, and the row is the
      // derived sync object — never the local event.
      const events = context.eventStore.events(runId, 0, 100);
      const rows = context.eventStore.outboxForRun(runId);
      assert.equal(rows.length, events.length);
      assert.equal(rows.length, 3);
      for (const [index, row] of rows.entries()) {
        const local = events[index]!;
        const sync = JSON.parse(row.syncEvent) as KxmSyncEvent;
        assert.equal(syncEventSchemaErrors(sync), undefined, `row ${row.sequence} must validate kxm.sync-event.v1`);
        assert.equal(sync.schema, "kxm.sync-event.v1");
        assert.equal(sync.sourceEventId, local.eventId);
        assert.equal(sync.sequence, local.sequence);
        assert.equal(sync.homeRuntimeId, context.homeRuntimeId);
        assert.equal(sync.syncPolicyRevision, KXM_DEFAULT_SYNC_POLICY_REVISION, "the transform records its policy revision");
        assert.equal(row.ackedAt, undefined);
        assert.doesNotMatch(row.syncEvent, /private prompt body/);
        assert.doesNotMatch(row.syncEvent, new RegExp(secret));
        assert.doesNotMatch(row.syncEvent, /\/Users\/operator|id_ed25519|abc123/);
        assert.equal("monotonicNs" in sync, false, "host clock internals stay local");
      }
      const created = JSON.parse(rows[0]!.syncEvent) as KxmSyncEvent;
      assert.deepEqual(
        created.redaction.fieldsOmitted.filter((field) => ["executorIds", "executors", "repositoryIds", "repositories"].includes(field)).sort(),
        Object.keys(events[0]!.payload).filter((field) => ["executorIds", "executors", "repositoryIds", "repositories"].includes(field)).sort(),
        "fields outside the allowlist are named, never carried",
      );
      const cancelSync = JSON.parse(rows[1]!.syncEvent) as KxmSyncEvent;
      assert.match(String(cancelSync.payload.reason), /\[redacted\]/);
      assert(cancelSync.redaction.valuesReplaced >= 3, "registered value, credential shape and path are all counted");

      // A prompt, a receipt URL or any unknown key never survives the transform.
      const crafted = deriveKxmSyncEvent({
        ...events[0]!,
        payload: {
          ...events[0]!.payload,
          prompt: "full private prompt",
          receipt: { provider: "github", kind: "pull-request", id: "41", url: "https://user:tok@example.test/pull/41" },
        },
      });
      assert.equal(syncEventSchemaErrors(crafted), undefined);
      assert(crafted.redaction.fieldsOmitted.includes("prompt"));
      assert(crafted.redaction.fieldsOmitted.includes("receipt.url"));
      assert.doesNotMatch(JSON.stringify(crafted), /full private prompt|user:tok/);

      const { url } = await hub.start();
      const client = new RuntimeHubClient({ serverUrl: url, project: "runtime-test", authToken, runtimeId: context.homeRuntimeId, host: "box-b" });
      const presence = await client.heartbeat();
      assert.equal(presence.presence, "online");
      assert.equal(presence.host, "box-b");

      const pushed = await syncKxmOutbox(context.eventStore, client);
      assert.deepEqual(pushed, { pushed: 3, acked: 3, refused: 0, refusals: [], unconfirmed: 0, blocked: false });
      assert.deepEqual(context.eventStore.pendingOutbox(), [], "acknowledged rows advance the cursor");
      assert(context.eventStore.outboxForRun(runId).every((row) => row.ackedAt !== undefined));

      // Replaying the same bytes is idempotent.
      const replay = await client.pushSyncEvents(rows.map((row) => JSON.parse(row.syncEvent) as unknown));
      assert.deepEqual(replay.results.map((result) => result.outcome), ["duplicate", "duplicate", "duplicate"]);
      assert.deepEqual(replay.cursors, [{ projectId: created.projectId, runId, cursor: 3 }]);
      assert.equal(entries.some((entry) => entry.event === "security_alert"), false, "an exact replay is not an alert");

      // Different bytes under a used sequence are refused and alerted.
      const altered = JSON.parse(rows[1]!.syncEvent) as KxmSyncEvent;
      altered.payload.reason = "rewritten after the fact";
      const conflict = await client.pushSyncEvents([altered]);
      assert.deepEqual(conflict.results, [{ projectId: altered.projectId, runId, sequence: 2, outcome: "conflict", code: "sync_sequence_reused" }]);
      const alert = entries.find((entry) => entry.event === "security_alert" && entry.alert === "sync_sequence_conflict");
      assert(alert, "conflicting reuse raises a security alert");
      assert.equal(alert.sequence, 2);

      // A schema escape field is rejected before it is stored.
      const escaped = { ...(JSON.parse(rows[2]!.syncEvent) as KxmSyncEvent), sequence: 9 };
      (escaped.payload as Record<string, unknown>).rawLogs = ["secret output"];
      const invalid = await client.pushSyncEvents([escaped]);
      assert.equal(invalid.results[0]!.outcome, "rejected");
      assert.equal(invalid.results[0]!.code, "sync_event_invalid");

      // Another Runtime cannot push this run's events.
      const impostor = new RuntimeHubClient({ serverUrl: url, project: "runtime-test", authToken, runtimeId: "rtm_01JIMPOSTOR0000000000000" });
      const mismatch = await impostor.pushSyncEvents([JSON.parse(rows[0]!.syncEvent) as unknown]);
      assert.equal(mismatch.results[0]!.code, "sync_runtime_mismatch");

      // A gap stays pending: sequence 5 is held, the cursor stays at 3.
      const ahead = { ...(JSON.parse(rows[2]!.syncEvent) as KxmSyncEvent), sequence: 5, sourceEventId: "evt_0000000000000000000000000000ahead" };
      const gap = await client.pushSyncEvents([ahead]);
      assert.equal(gap.results[0]!.outcome, "accepted");
      assert.deepEqual(gap.cursors, [{ projectId: created.projectId, runId, cursor: 3 }]);

      const snapshot = async (): Promise<Record<string, unknown>> => {
        const response = await fetch(`${url}/v1/ops/snapshot?project=runtime-test`, { headers: { authorization: `Bearer ${authToken}` } });
        assert.equal(response.status, 200);
        return await response.json() as Record<string, unknown>;
      };
      const live = await snapshot();
      const homes = live.homeRuntimes as Array<Record<string, unknown>>;
      assert.equal(homes.length, 1);
      assert.equal(homes[0]!.runtimeId, context.homeRuntimeId);
      assert.equal(homes[0]!.host, "box-b");
      assert.equal(homes[0]!.presence, "online");
      assert.equal(homes[0]!.orphaned, false);
      const [run] = homes[0]!.runs as Array<Record<string, unknown>>;
      assert.equal(run!.runId, runId);
      assert.equal(run!.status, "cancelled", "the projection reads the gapless prefix only");
      assert.equal(run!.lastSequence, 3);
      assert.equal(run!.pendingGap, true);
      assert.equal(run!.orphaned, false);
      assert.deepEqual(
        Object.keys(run!).filter((key) => !["projectId", "runId", "workflowId", "displayTitle", "status", "lastSequence", "pendingGap", "updatedAt", "orphaned"].includes(key)),
        [],
        "the snapshot shows bounded fields only",
      );
      assert.doesNotMatch(JSON.stringify(live), new RegExp(`${secret}|private prompt body`));

      // The presence lease lapses on the hub's clock: the run is orphaned in the
      // view, and nothing about it moves.
      clock += 31_000;
      const lapsed = await snapshot();
      const lapsedHome = (lapsed.homeRuntimes as Array<Record<string, unknown>>)[0]!;
      assert.equal(lapsedHome.presence, "expired");
      assert.equal(lapsedHome.orphaned, true);
      const [orphan] = lapsedHome.runs as Array<Record<string, unknown>>;
      assert.equal(orphan!.orphaned, true);
      assert.equal(orphan!.lastSequence, 3);
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    await hub.close();
    cleanup(root, stateRoot);
  }
});

test("a hub that durably refuses a row takes it out of the pending queue and says why", async () => {
  const { root, stateRoot } = committedProject("kxm-runtime-refusal-");
  const alerts: Array<Record<string, unknown>> = [];
  const authToken = "refusal-test-token";
  const hub = createMeshHub({ port: 0, authToken, rateLimit: false, logger: (entry) => alerts.push(entry as unknown as Record<string, unknown>) });
  const bundle = loadKxmProject(root);
  const context = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: "rtm_01JREFUSE00000000000000" });
  try {
    const { url } = await hub.start();
    const accept = (prompt: string): string => {
      const runId = acceptKxmRun(context, bundle, { workflowId: "default", prompt }).run.runId;
      cancelKxmRun(context, runId, { reason: prompt });
      return runId;
    };

    // The identity mistake this gate remembers: a push sent under a label the
    // project does not use. The hub takes the claim, and every later push of
    // that project id is refused by the pin — which is why the label on the wire
    // has to be the one the sync events carry.
    const mislabeledRun = accept("run claimed under the wrong label");
    const mislabeled = new RuntimeHubClient({ serverUrl: url, project: "@kontextmind/kxm", authToken, runtimeId: context.homeRuntimeId });
    const claimed = await syncKxmOutbox(context.eventStore, mislabeled);
    assert.equal(claimed.acked, context.eventStore.outboxForRun(mislabeledRun).length);
    assert.equal(context.eventStore.pendingOutbox().length, 0, "a claimed run acks normally");

    // A second, never-seen run now syncs under the identity the Runtime really
    // uses, and the hub refuses every one of its rows: re-sending cannot help.
    const refusedRun = accept("run the hub will not take");
    const correct = new RuntimeHubClient({ serverUrl: url, project: context.projectId, authToken, runtimeId: context.homeRuntimeId });
    const rows = context.eventStore.outboxForRun(refusedRun).length;
    const pass = await syncKxmOutbox(context.eventStore, correct);
    assert.equal(pass.blocked, false, "a refusal is an answer, not a transport failure");
    assert.equal(pass.pushed, rows);
    assert.equal(pass.acked, 0);
    assert.equal(pass.refused, rows);
    assert.deepEqual(pass.refusals.map((refusal) => refusal.code), Array(rows).fill("sync_project_mismatch"));
    assert.deepEqual(pass.refusals.map((refusal) => refusal.runId), Array(rows).fill(refusedRun));

    // Pending drains; the refused rows are still there, labelled with the hub's
    // own reason. This is the difference between "stuck" and "waiting for an
    // operator", and it is what the status surface reads.
    assert.deepEqual(context.eventStore.pendingOutbox(), [], "a refused row is not waiting for a retry");
    const held = context.eventStore.outboxForRun(refusedRun);
    assert.equal(held.length, rows);
    assert(held.every((row) => row.refusedCode === "sync_project_mismatch" && row.refusedAt !== undefined && row.ackedAt === undefined));
    assert.deepEqual(context.eventStore.outboxStatus(), {
      pending: 0,
      acked: rows,
      refused: rows,
      lastAttemptAt: held[0]!.attemptedAt,
      refusals: [{ code: "sync_project_mismatch", count: rows }],
    });

    // The alert-storm gate: the next pass has nothing to send, so the hub is not
    // asked again and raises nothing new. Before this, the same 23 rows were
    // re-pushed every ten seconds forever and every pass was a security alert.
    const alertsSoFar = alerts.filter((entry) => entry.event === "security_alert").length;
    assert(alertsSoFar > 0, "the hub did raise the refusals");
    const quiet = await syncKxmOutbox(context.eventStore, correct);
    assert.deepEqual(quiet, { pushed: 0, acked: 0, refused: 0, refusals: [], unconfirmed: 0, blocked: false });
    assert.equal(alerts.filter((entry) => entry.event === "security_alert").length, alertsSoFar, "a refused row is not re-pushed");

    // An operator who has corrected the hub-side claim can put the rows back.
    assert.equal(context.eventStore.retryRefusedOutbox(), rows);
    assert.equal(context.eventStore.pendingOutbox().length, rows);
    assert(context.eventStore.outboxForRun(refusedRun).every((row) => row.refusedCode === undefined && row.attemptCount === 0),
      "a revived row starts with a fresh attempt budget");
  } finally {
    await hub.close();
    closeKxmRuntimeContext(context);
    cleanup(root, stateRoot);
  }
});

test("one row the hub cannot carry is refused on its own instead of parking the queue behind it", async () => {
  const { root, stateRoot } = committedProject("kxm-runtime-oversize-");
  const bundle = loadKxmProject(root);
  const context = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: "rtm_01JOVERSIZE00000000000" });
  try {
    const runId = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "oversize probe" }).run.runId;
    cancelKxmRun(context, runId, { reason: "done" });
    const rows = context.eventStore.outboxForRun(runId);
    assert.equal(rows.length, 3);

    let calls = 0;
    const alwaysTooBig: typeof stub.pushSyncEvents = async (events) => {
      calls += 1;
      if (events.length > 1) throw new HubHttpError(413, "a sync batch holds at most 1 events", "sync_batch_too_large");
      const event = events[0] as KxmSyncEvent;
      if (event.sequence === 2) throw new HubHttpError(413, "request body is too large", "payload_too_large");
      return {
        results: [{ projectId: event.projectId, runId: event.runId, sequence: event.sequence, outcome: "accepted" as const }],
        cursors: [],
      };
    };
    const stub = { pushSyncEvents: alwaysTooBig } as unknown as RuntimeHubClient;

    const pass = await syncKxmOutbox(context.eventStore, stub, { batchSize: 8 });
    assert.equal(pass.blocked, false, "an oversized row is an answer, not a dead hub");
    assert.equal(pass.acked, 2, "the rows behind it go through");
    assert.deepEqual(pass.refusals, [{ runId, sequence: 2, code: "sync_row_too_large" }]);
    assert.deepEqual(context.eventStore.pendingOutbox().map((row) => row.sequence), [], "the queue drains past the row that cannot be carried");
    assert(calls >= 4, "the batch was isolated row by row");
  } finally {
    closeKxmRuntimeContext(context);
    cleanup(root, stateRoot);
  }
});

test("the supervisor sync tick pushes under the identity its own sync events carry", async () => {
  const { root, stateRoot } = committedProject("kxm-runtime-tick-");
  const authToken = "tick-test-token";
  const hub = createMeshHub({ port: 0, authToken, rateLimit: false });
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    const { url } = await hub.start();
    supervisor = await startKxmRuntimeSupervisor({
      stateRoot,
      env: { KXM_SERVER_URL: url, KXM_AUTH_TOKEN: authToken, KXM_RUNTIME_SYNC_INTERVAL_MS: "250" },
    });
    const handle = {
      runtimeId: supervisor.runtimeId,
      port: supervisor.port,
      token: readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!,
      started: true,
    };
    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "default",
      prompt: "driven by the tick",
    });
    const runId = (acceptance.run as { runId: string }).runId;

    type SyncStatus = { state: string; outbox: { pending: number; acked: number; refused: number }; hubUrl?: string; lastError?: string };
    const syncStatus = async (): Promise<SyncStatus[]> => {
      const response = await kxmRuntimeRequest(handle, "GET", "/v1/sync/status");
      return response.projects as unknown as SyncStatus[];
    };
    await waitFor(async () => ((await syncStatus())[0]?.outbox.acked ?? 0) > 0, 10_000);
    const [status] = await syncStatus();
    assert(status, "the tick reports on the project it synced");
    assert.equal(status.state, "ok");
    assert.equal(status.outbox.pending, 0);
    assert.equal(status.outbox.refused, 0);
    assert.equal(status.hubUrl, url);

    // The join the ops snapshot depends on: presence and run facts have to land
    // under one project label, which is the id in project.yaml. A second label on
    // the wire splits them and pins the project id against every later push.
    const snapshot = await fetch(`${url}/v1/ops/snapshot?project=${encodeURIComponent("prj_01JRUNTIMETEST0000000000")}`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    assert.equal(snapshot.status, 200, "the hub holds this Runtime's runs under its own project id");
    const view = await snapshot.json() as { homeRuntimes: Array<Record<string, unknown>> };
    const home = view.homeRuntimes.find((entry) => entry.runtimeId === supervisor!.runtimeId);
    assert(home, "the home Runtime is listed");
    assert.equal(home.orphaned, false, "its presence lease is live under the same label");
    assert((home.runs as Array<Record<string, unknown>>).some((run) => run.runId === runId));

    const logged = readFileSync(join(kxmRuntimePaths({ stateRoot }).runtimeDir, "logs", "kxm-runtime.jsonl"), "utf8");
    assert.match(logged, /"event":"runtime_sync_state"/);
    assert.match(logged, /"state":"ok"/);
  } finally {
    if (supervisor) await supervisor.stop();
    await hub.close();
    cleanup(root, stateRoot);
  }
});

test("a project whose store the build refuses is reported as unreadable, never as empty", async () => {
  const { root, stateRoot } = committedProject("kxm-runtime-refused-store-");
  const paths = kxmRuntimePaths({ stateRoot });
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot, env: { KXM_RUNTIME_SYNC_INTERVAL_MS: "250" } });
    const handle = {
      runtimeId: supervisor.runtimeId,
      port: supervisor.port,
      token: readKxmSupervisorToken(paths)!,
      started: true,
    };
    await kxmRuntimeRequest(handle, "POST", "/v1/runs", { projectRoot: root, workflowId: "default", prompt: "opens the store" });
    // Match on the project id, never on a temp path: the supervisor canonicalises
    // roots through realpath, so a string comparison against a raw mkdtemp path
    // vacuously misses on macOS (/var -> /private/var) and the assertions below
    // would then prove nothing.
    type SyncEntry = { projectId: string; state: string; storeReadable?: boolean; lastError?: string; outbox: { pending: number; acked: number; refused: number } };
    const syncEntriesFor = async (target: typeof handle): Promise<SyncEntry[]> => {
      const response = await kxmRuntimeRequest(target, "GET", "/v1/sync/status");
      return response.projects as unknown as SyncEntry[];
    };
    await waitFor(async () => (await syncEntriesFor(handle)).some((entry) => entry.projectId === "prj_01JRUNTIMETEST0000000000"), 10_000);
    await supervisor.stop();
    supervisor = undefined;

    // Roll the store back one schema, exactly what a bumped build meets on an
    // upgraded box: the rows are there and unreachable, not gone.
    const storePath = join(paths.projectsDir, projectRuntimeKey(realpathSync(root)), "run-events.db");
    const stamped = new DatabaseSync(storePath);
    stamped.exec("PRAGMA user_version = 6");
    stamped.close();

    supervisor = await startKxmRuntimeSupervisor({ stateRoot, env: { KXM_RUNTIME_SYNC_INTERVAL_MS: "250" } });
    const restarted = { runtimeId: supervisor.runtimeId, port: supervisor.port, token: readKxmSupervisorToken(paths)!, started: true };
    const refusedEntry = async (): Promise<SyncEntry | undefined> =>
      (await syncEntriesFor(restarted)).find((entry) => entry.projectId === "prj_01JRUNTIMETEST0000000000");
    await waitFor(async () => (await refusedEntry())?.storeReadable === false, 10_000);
    const refused = await refusedEntry();
    assert(refused, "the refused project is listed, not skipped");
    assert.equal(refused.state, "blocked");
    assert.equal(refused.storeReadable, false, "an unreadable store is never reported as an empty one");
    assert.match(refused.lastError ?? "", /runtime_schema_outdated/, "the status carries the brake that fired");
    // Zeroed counts must be labelled unreadable, or "pending 0" reads as drained.
    assert.equal(refused.outbox.pending, 0);
    assert.equal(refused.outbox.acked, 0);

    const logged = readFileSync(join(paths.runtimeDir, "logs", "kxm-runtime.jsonl"), "utf8");
    assert.match(logged, /"event":"runtime_sync_context_unavailable"/);
    assert.match(logged, /runtime_schema_outdated/, "the log names the reason, not just the failure");
    // Retried every tick, stated once: a repeated refusal must not become noise.
    const refusals = logged.split('"runtime_sync_context_unavailable"').length - 1;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_200));
    const after = readFileSync(join(paths.runtimeDir, "logs", "kxm-runtime.jsonl"), "utf8");
    assert.equal(after.split('"runtime_sync_context_unavailable"').length - 1, refusals,
      "the same refusal is logged once, not once per tick");
  } finally {
    if (supervisor) await supervisor.stop();
    cleanup(root, stateRoot);
  }
});

test("a hub this Runtime cannot reach is reported by the sync status, not swallowed", async () => {
  const { root, stateRoot } = committedProject("kxm-runtime-blocked-");
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startKxmRuntimeSupervisor({
      stateRoot,
      // A port nothing listens on: the honest version of "supervisor runs clean".
      env: { KXM_SERVER_URL: "http://127.0.0.1:1", KXM_AUTH_TOKEN: "blocked-test-token", KXM_RUNTIME_SYNC_INTERVAL_MS: "250" },
    });
    const handle = {
      runtimeId: supervisor.runtimeId,
      port: supervisor.port,
      token: readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!,
      started: true,
    };
    const acceptance = await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "default",
      prompt: "no hub to talk to",
    });
    const runId = (acceptance.run as { runId: string }).runId;

    type SyncStatus = { state: string; lastError?: string; nextAttemptAt?: string; consecutiveFailures?: number; outbox: { pending: number } };
    await waitFor(async () => (await kxmRuntimeRequest(handle, "GET", "/v1/sync/status")).projects !== undefined, 10_000);
    let status: SyncStatus | undefined;
    await waitFor(async () => {
      status = ((await kxmRuntimeRequest(handle, "GET", "/v1/sync/status")).projects as unknown as SyncStatus[])[0];
      return status?.state === "blocked";
    }, 10_000);
    const blocked = status as SyncStatus;
    assert(blocked.lastError, "the failure carries a reason an operator can read");
    assert(blocked.outbox.pending > 0, "the rows are still held locally — a dead hub loses nothing");
    assert((blocked.consecutiveFailures ?? 0) >= 1);
    assert(blocked.nextAttemptAt !== undefined && Date.parse(blocked.nextAttemptAt) > Date.now() - 1000, "the tick backs off instead of hammering");

    // Nothing pending silently: the stalled state is in the supervisor's log too.
    await waitFor(() => {
      const logged = readFileSync(join(kxmRuntimePaths({ stateRoot }).runtimeDir, "logs", "kxm-runtime.jsonl"), "utf8");
      return /"event":"runtime_sync_stalled"/.test(logged) && logged.includes(runId) === false && /"state":"blocked"/.test(logged);
    }, 5_000);

    // The revive endpoint is reachable and honest about an empty refusal set.
    const retried = await kxmRuntimeRequest(handle, "POST", "/v1/sync/retry", { projectRoot: root });
    assert.equal(retried.retried, 0);
  } finally {
    if (supervisor) await supervisor.stop();
    cleanup(root, stateRoot);
  }
});

function writeRegistrySchemaV1(
  dbPath: string,
  row: { projectId: string; projectRoot: string; projectKey: string; homeRuntimeId: string; registeredAt: string },
): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE supervisor (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      runtime_id TEXT NOT NULL,
      pid INTEGER NOT NULL,
      port INTEGER NOT NULL,
      token_hash TEXT NOT NULL,
      started_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      state TEXT NOT NULL
    ) STRICT;
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      project_root TEXT NOT NULL,
      project_key TEXT NOT NULL UNIQUE,
      home_runtime_id TEXT NOT NULL,
      config_revision TEXT,
      registered_at TEXT NOT NULL
    ) STRICT;
  `);
  database.exec("PRAGMA user_version = 1");
  database.prepare(
    "INSERT INTO projects (project_id, project_root, project_key, home_runtime_id, config_revision, registered_at) VALUES (?, ?, ?, ?, NULL, ?)",
  ).run(row.projectId, row.projectRoot, row.projectKey, row.homeRuntimeId, row.registeredAt);
  database.close();
}

test("a worktree of a registered repository is admitted as a lane and a schema 1 row is kept", () => {
  const { root, stateRoot } = committedProject("kxm-runtime-lane-");
  const worktree = join(dirname(root), `${basename(root)}-lane`);
  const registeredAt = "2026-09-01T00:00:00.000Z";
  try {
    const paths = kxmRuntimePaths({ stateRoot });
    const projectId = String(loadKxmProject(root).project.value.id);
    writeRegistrySchemaV1(paths.registryDb, {
      projectId,
      projectRoot: resolve(root),
      projectKey: projectRuntimeKey(root),
      homeRuntimeId: "rtm_one",
      registeredAt,
    });
    const registry = new KxmRuntimeRegistry(paths.registryDb);
    try {
      const home = registry.projectByRoot(root);
      assert.ok(home);
      assert.equal(home.projectId, projectId);
      assert.equal(home.projectRoot, resolve(root));
      assert.equal(home.projectKey, projectRuntimeKey(root));
      assert.equal(home.homeRuntimeId, "rtm_one");
      assert.equal(home.registeredAt, registeredAt);
      assert.equal(home.laneOf, undefined, "a schema 1 row stays the home row");
      const version = new DatabaseSync(paths.registryDb, { readOnly: true });
      try {
        const stamp = version.prepare("PRAGMA user_version").get() as { user_version: number };
        assert.equal(stamp.user_version, KXM_REGISTRY_SCHEMA_VERSION);
      } finally {
        version.close();
      }

      const added = spawnSync("git", ["-C", root, "worktree", "add", "-b", "lane-b", worktree, "HEAD"], { encoding: "utf8", windowsHide: true });
      assert.equal(added.status, 0, added.stderr);
      const now = "2026-09-26T00:00:00.000Z";
      const lane = registry.registerProject({ projectId, projectRoot: worktree, homeRuntimeId: "rtm_one", now });
      assert.equal(lane.projectId, projectId);
      assert.equal(lane.homeRuntimeId, "rtm_one");
      assert.notEqual(lane.projectKey, home.projectKey);
      assert.equal(lane.laneOf, home.projectKey);
      assert.equal(registry.project(projectId)?.projectRoot, resolve(root));
      assert.equal(registry.projectByRoot(worktree)?.projectKey, lane.projectKey);
      const again = registry.registerProject({ projectId, projectRoot: worktree, homeRuntimeId: "rtm_one", now: "2026-09-27T00:00:00.000Z" });
      assert.equal(again.registeredAt, now, "re-registering the lane root is idempotent");
    } finally {
      registry.close();
    }
  } finally {
    spawnSync("git", ["-C", root, "worktree", "remove", "--force", worktree], { encoding: "utf8", windowsHide: true });
    cleanup(root, stateRoot, worktree);
  }
});

test("a foreign clone with the same project id is refused while its directory exists", () => {
  const { root, stateRoot } = committedProject("kxm-runtime-foreign-");
  const foreign = mkdtempSync(join(tmpdir(), "kxm-runtime-foreign-clone-"));
  try {
    const projectId = String(loadKxmProject(root).project.value.id);
    makeGitRoot(foreign);
    initializeKxmProject(foreign, { projectId, projectName: "Foreign" });
    const registry = new KxmRuntimeRegistry(kxmRuntimePaths({ stateRoot }).registryDb);
    try {
      const now = "2026-09-26T00:00:00.000Z";
      registry.registerProject({ projectId, projectRoot: root, homeRuntimeId: "rtm_one", now });
      assert.throws(
        () => registry.registerProject({ projectId, projectRoot: foreign, homeRuntimeId: "rtm_one", now }),
        (error: unknown) => {
          assert.ok(error instanceof KxmConfigError);
          assert.equal(error.issues[0]?.code, "project_home_conflict");
          return true;
        },
      );
      assert.equal(registry.projectByRoot(root)?.projectRoot, resolve(root));
      assert.equal(registry.projectByRoot(foreign), undefined);
    } finally {
      registry.close();
    }
  } finally {
    cleanup(root, stateRoot, foreign);
  }
});

test("unregister refuses runtime_project_busy while a run is unsettled", async () => {
  const { root, stateRoot } = committedProject("kxm-runtime-busy-");
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    await kxmRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "default",
      prompt: "still open",
    });
    const refused = await fetch(`http://127.0.0.1:${supervisor.port}/v1/projects/unregister`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ projectRoot: root }),
    });
    assert.equal(refused.status, 409);
    const body = await refused.json() as { error?: string };
    assert.equal(body.error, "runtime_project_busy");
    const still = new KxmRuntimeRegistry(kxmRuntimePaths({ stateRoot }).registryDb);
    try {
      assert.ok(still.projectByRoot(root));
    } finally {
      still.close();
    }
    const forced = await kxmRuntimeRequest(handle, "POST", "/v1/projects/unregister", { projectRoot: root, force: true });
    assert.equal(forced.unregistered, true);
    const after = new KxmRuntimeRegistry(kxmRuntimePaths({ stateRoot }).registryDb);
    try {
      assert.equal(after.projectByRoot(root), undefined);
    } finally {
      after.close();
    }
  } finally {
    if (supervisor) await supervisor.stop();
    cleanup(root, stateRoot);
  }
});

test("unregister refuses runtime_project_has_lanes while the home root still has a lane", async () => {
  const { root, stateRoot } = committedProject("kxm-runtime-homelanes-");
  const worktree = join(dirname(root), `${basename(root)}-lane`);
  let supervisor: Awaited<ReturnType<typeof startKxmRuntimeSupervisor>> | undefined;
  try {
    const added = spawnSync("git", ["-C", root, "worktree", "add", "-b", "lane-b", worktree, "HEAD"], { encoding: "utf8", windowsHide: true });
    assert.equal(added.status, 0, added.stderr);
    const projectId = String(loadKxmProject(root).project.value.id);
    const registry = new KxmRuntimeRegistry(kxmRuntimePaths({ stateRoot }).registryDb);
    const now = "2026-09-26T00:00:00.000Z";
    registry.registerProject({ projectId, projectRoot: root, homeRuntimeId: "rtm_fixed", now });
    registry.registerProject({ projectId, projectRoot: worktree, homeRuntimeId: "rtm_fixed", now });
    assert.ok(registry.homeLaneCount(root) > 0);
    registry.close();
    supervisor = await startKxmRuntimeSupervisor({ stateRoot });
    const token = readKxmSupervisorToken(kxmRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };
    const refused = await fetch(`http://127.0.0.1:${supervisor.port}/v1/projects/unregister`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ projectRoot: resolve(root) }),
    });
    assert.equal(refused.status, 409);
    const body = await refused.json() as { error?: string };
    assert.equal(body.error, "runtime_project_has_lanes");
    const still = new KxmRuntimeRegistry(kxmRuntimePaths({ stateRoot }).registryDb);
    try {
      assert.ok(still.projectByRoot(root));
      assert.ok(still.projectByRoot(worktree)?.laneOf);
    } finally {
      still.close();
    }
    const forced = await kxmRuntimeRequest(handle, "POST", "/v1/projects/unregister", { projectRoot: resolve(root), force: true });
    assert.equal(forced.unregistered, true);
    const after = new KxmRuntimeRegistry(kxmRuntimePaths({ stateRoot }).registryDb);
    try {
      assert.equal(after.projectByRoot(root), undefined);
      assert.equal(after.projectByRoot(worktree)?.laneOf, undefined);
    } finally {
      after.close();
    }
  } finally {
    if (supervisor) await supervisor.stop();
    spawnSync("git", ["-C", root, "worktree", "remove", "--force", worktree], { encoding: "utf8", windowsHide: true });
    cleanup(root, stateRoot, worktree);
  }
});

test("a registered root whose directory is gone is replaced and logs one event", () => {
  const { root, stateRoot } = committedProject("kxm-runtime-dead-");
  const replacement = mkdtempSync(join(tmpdir(), "kxm-runtime-dead-next-"));
  try {
    const projectId = String(loadKxmProject(root).project.value.id);
    const registry = new KxmRuntimeRegistry(kxmRuntimePaths({ stateRoot }).registryDb);
    try {
      const now = "2026-09-26T00:00:00.000Z";
      const original = registry.registerProject({ projectId, projectRoot: root, homeRuntimeId: "rtm_one", now });
      rmSync(root, { recursive: true, force: true });
      const events: Array<Record<string, unknown>> = [];
      const replaced = registry.registerProject({
        projectId,
        projectRoot: replacement,
        homeRuntimeId: "rtm_one",
        now: "2026-09-26T01:00:00.000Z",
        logger: (entry) => events.push(entry),
      });
      assert.equal(events.length, 1);
      assert.equal(events[0]?.event, "project_registration_replaced");
      assert.equal(events[0]?.replacedRoot, original.projectRoot);
      assert.deepEqual(
        { replacedHomeRuntimeId: events[0]?.replacedHomeRuntimeId, replacedProjectKey: events[0]?.replacedProjectKey },
        { replacedHomeRuntimeId: original.homeRuntimeId, replacedProjectKey: original.projectKey },
      );
      assert.equal(replaced.projectRoot, resolve(replacement));
      assert.equal(replaced.laneOf, undefined);
      assert.equal(registry.projectByRoot(root), undefined);
      assert.equal(registry.project(projectId)?.projectRoot, resolve(replacement));
    } finally {
      registry.close();
    }
  } finally {
    cleanup(root, stateRoot, replacement);
  }
});

test("a primary checkout takes the home row from a lane that registered first", () => {
  const { root, stateRoot } = committedProject("kxm-runtime-promote-");
  const worktree = join(dirname(root), `${basename(root)}-lane`);
  try {
    const added = spawnSync("git", ["-C", root, "worktree", "add", "-b", "lane-b", worktree, "HEAD"], { encoding: "utf8", windowsHide: true });
    assert.equal(added.status, 0, added.stderr);
    const projectId = String(loadKxmProject(root).project.value.id);
    const registry = new KxmRuntimeRegistry(kxmRuntimePaths({ stateRoot }).registryDb);
    try {
      const now = "2026-09-26T00:00:00.000Z";
      const events: Array<Record<string, unknown>> = [];
      const laneFirst = registry.registerProject({
        projectId,
        projectRoot: worktree,
        homeRuntimeId: "rtm_one",
        now,
        logger: (entry) => events.push(entry),
      });
      assert.equal(laneFirst.laneOf, undefined);
      const primary = registry.registerProject({
        projectId,
        projectRoot: root,
        homeRuntimeId: "rtm_one",
        now: "2026-09-26T01:00:00.000Z",
        logger: (entry) => events.push(entry),
      });
      assert.equal(events.length, 1);
      assert.equal(events[0]?.event, "project_home_promoted");
      assert.equal(primary.laneOf, undefined);
      assert.equal(primary.homeRuntimeId, "rtm_one");
      assert.equal(registry.project(projectId)?.projectRoot, resolve(root));
      assert.equal(registry.projectByRoot(worktree)?.laneOf, primary.projectKey);
      assert.equal(registry.unregisterProject(worktree), true);
      assert.equal(registry.projectByRoot(worktree), undefined);
      assert.equal(registry.project(projectId)?.projectRoot, resolve(root));
    } finally {
      registry.close();
    }
  } finally {
    spawnSync("git", ["-C", root, "worktree", "remove", "--force", worktree], { encoding: "utf8", windowsHide: true });
    cleanup(root, stateRoot, worktree);
  }
});

test("a dead row whose home runtime differs is refused and left in place", () => {
  const { root, stateRoot } = committedProject("kxm-runtime-dead-home-");
  const replacement = mkdtempSync(join(tmpdir(), "kxm-runtime-dead-home-next-"));
  try {
    const projectId = String(loadKxmProject(root).project.value.id);
    const registry = new KxmRuntimeRegistry(kxmRuntimePaths({ stateRoot }).registryDb);
    try {
      const now = "2026-09-26T00:00:00.000Z";
      const original = registry.registerProject({ projectId, projectRoot: root, homeRuntimeId: "rtm_one", now });
      rmSync(root, { recursive: true, force: true });
      assert.throws(
        () => registry.registerProject({
          projectId,
          projectRoot: replacement,
          homeRuntimeId: "rtm_two",
          now: "2026-09-26T01:00:00.000Z",
        }),
        (error: unknown) => {
          assert.ok(error instanceof KxmConfigError);
          assert.equal(error.issues[0]?.code, "project_home_conflict");
          return true;
        },
      );
      const left = registry.project(projectId);
      assert.equal(left?.projectKey, original.projectKey);
      assert.equal(left?.homeRuntimeId, "rtm_one");
      assert.equal(left?.projectRoot, original.projectRoot);
      assert.equal(registry.projectByRoot(replacement), undefined);
    } finally {
      registry.close();
    }
  } finally {
    cleanup(root, stateRoot, replacement);
  }
});

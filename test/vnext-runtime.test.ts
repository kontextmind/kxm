import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  VnextRunEventStore,
  VnextRuntimeRegistry,
  newVnextCommandId,
  projectRuntimeKey,
  vnextRuntimePaths,
} from "../plugins/kxm/src/vnext-runtime-store.ts";
import {
  acceptVnextRun,
  cancelVnextRun,
  closeVnextRuntimeContext,
  openVnextRuntimeContext,
  projectVnextRunStatus,
  rebuildVnextRunProjection,
  vnextPolicyRevisions,
  vnextRunRevisionDrift,
} from "../plugins/kxm/src/vnext-runtime.ts";
import {
  ensureVnextSupervisor,
  readVnextSupervisorToken,
  startVnextRuntimeSupervisor,
  vnextRuntimeRequest,
  vnextSupervisorStatus,
  vnextSupervisorTokenFile,
} from "../plugins/kxm/src/vnext-runtime-supervisor.ts";
import { loadVnextProject } from "../plugins/kxm/src/vnext-config.ts";
import { initializeVnextProject } from "../plugins/kxm/src/vnext-init.ts";

function makeGitRoot(root: string): void {
  const initialized = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", root], { encoding: "utf8", windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
}

function committedProject(prefix: string): { root: string; stateRoot: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const stateRoot = mkdtempSync(join(tmpdir(), `${prefix}state-`));
  makeGitRoot(root);
  initializeVnextProject(root, { projectId: "prj_01JRUNTIMETEST0000000000", projectName: "Runtime Test" });
  spawnSync("git", ["-C", root, "add", "-A"], { windowsHide: true });
  const commit = spawnSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"], { windowsHide: true });
  assert.equal(commit.status, 0, commit.stderr as unknown as string);
  return { root, stateRoot };
}

function cleanup(...paths: string[]): void {
  // A SIGKILLed runtime can still hold its SQLite handles for a moment on
  // Windows; rmSync retries so teardown does not fail the test with EPERM.
  for (const path of paths) rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

test("run acceptance is immutable, idempotent, and pins revisions", () => {
  const { root, stateRoot } = committedProject("kxm-runtime-accept-");
  try {
    const bundle = loadVnextProject(root);
    const revisions = vnextPolicyRevisions(bundle);
    assert.match(revisions.configRevision, /^sha256:[a-f0-9]{64}$/);
    assert.match(revisions.executorPolicyRevision, /^sha256:[a-f0-9]{64}$/);
    assert.match(revisions.toolPolicyRevision, /^sha256:[a-f0-9]{64}$/);

    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: "rtm_test" });
    try {
      const commandId = newVnextCommandId();
      const first = acceptVnextRun(context, bundle, { commandId, workflowId: "default", prompt: "fix the bug" });
      assert.equal(first.idempotent, false);
      assert.match(first.run.runId, /^run_[a-f0-9]{32}$/);
      assert.equal(first.run.homeRuntimeId, context.homeRuntimeId);
      assert.equal(first.run.configRevision, bundle.configRevision);
      assert.equal(first.run.status, "created");
      assert.equal(first.event.sequence, 1);
      assert.equal(first.event.eventType, "run.created");
      const payload = first.event.payload as { promptSha256: string; workflowId: string; repositories: string[]; executors: string[] };
      assert.match(payload.promptSha256, /^sha256:/);
      assert.equal(payload.workflowId, "default");
      assert.deepEqual(payload.repositories, ["control"]);
      assert(!JSON.stringify(first.event.payload).includes("fix the bug"), "prompt content is never stored");

      const second = acceptVnextRun(context, bundle, { commandId, workflowId: "default", prompt: "fix the bug" });
      assert.equal(second.idempotent, true, "repeated commandId returns the prior acceptance");
      assert.equal(second.run.runId, first.run.runId);
      assert.equal(context.eventStore.events(first.run.runId, 0, 10).length, 1, "no duplicate semantic events");

      // Home runtime is immutable across contexts.
      const reopened = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: "rtm_test" });
      try {
        assert.equal(reopened.homeRuntimeId, context.homeRuntimeId);
      } finally {
        closeVnextRuntimeContext(reopened);
      }

      const drift = vnextRunRevisionDrift(first.run, bundle);
      assert.equal(drift.configDrift, false);
      assert.equal(drift.pinnedRevision, bundle.configRevision);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    cleanup(root, stateRoot);
  }
});

test("event sequence integrity and projection rebuild equivalence", () => {
  const { root, stateRoot } = committedProject("kxm-runtime-projection-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: "rtm_test" });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "default", prompt: "work" });
      const cancelled = cancelVnextRun(context, accepted.run.runId);
      assert.equal(cancelled.idempotent, false);
      assert.equal(cancelled.events.length, 2);
      assert.equal(cancelled.events[0]!.eventType, "run.cancel_requested");
      assert.equal(cancelled.events[0]!.sequence, 2);
      assert.equal(cancelled.events[1]!.eventType, "run.status_changed");
      assert.equal(cancelled.events[1]!.sequence, 3);
      assert.equal(cancelled.run.status, "cancelled");

      const events = context.eventStore.events(accepted.run.runId, 0, 100);
      assert.equal(events.length, 3);
      assert.equal(projectVnextRunStatus(events), "cancelled");
      const rebuilt = rebuildVnextRunProjection(context.eventStore, accepted.run.runId);
      assert.equal(rebuilt.status, "cancelled", "projection rebuild matches incremental state");
      assert.equal(rebuilt.runId, accepted.run.runId);

      // Terminal runs ignore further cancels (idempotent).
      const again = cancelVnextRun(context, accepted.run.runId);
      assert.equal(again.idempotent, true);
      assert.equal(context.eventStore.events(accepted.run.runId, 0, 100).length, 3, "terminal runs append nothing");

      // Idempotent cancel command returns prior result without appending.
      const commandId = newVnextCommandId();
      const run2 = acceptVnextRun(context, bundle, { workflowId: "default", prompt: "second" });
      const cancelFirst = cancelVnextRun(context, run2.run.runId, { commandId });
      const cancelSecond = cancelVnextRun(context, run2.run.runId, { commandId });
      assert.equal(cancelSecond.idempotent, true);
      assert.equal(context.eventStore.events(run2.run.runId, 0, 100).length, 3);
      void cancelFirst;
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    cleanup(root, stateRoot);
  }
});

test("registry supervisor claim, takeover, and project home immutability", () => {
  const { root, stateRoot } = committedProject("kxm-runtime-registry-");
  try {
    const paths = vnextRuntimePaths({ stateRoot });
    assert.equal(paths.registryDb, join(stateRoot, "runtime", "registry.db"));
    assert.equal(projectRuntimeKey(root), projectRuntimeKey(root));
    const registry = new VnextRuntimeRegistry(paths.registryDb);
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

      const bundle = loadVnextProject(root);
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
  let supervisor: Awaited<ReturnType<typeof startVnextRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startVnextRuntimeSupervisor({ stateRoot });
    assert(supervisor.port > 0);
    const token = readVnextSupervisorToken(vnextRuntimePaths({ stateRoot }))!;
    const handle = { runtimeId: supervisor.runtimeId, port: supervisor.port, token, started: true };

    const health = await fetch(`http://127.0.0.1:${supervisor.port}/healthz`);
    assert.equal(health.ok, true);

    // Unauthenticated requests are rejected.
    const unauthorized = await fetch(`http://127.0.0.1:${supervisor.port}/v1/projects/prj_x/runs?projectRoot=${encodeURIComponent(root)}`);
    assert.equal(unauthorized.status, 401);

    const acceptance = await vnextRuntimeRequest(handle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "default",
      prompt: "offline work",
    });
    const run = acceptance.run as { runId: string; status: string };
    assert.equal(run.status, "created");

    const status = await vnextRuntimeRequest(handle, "GET", `/v1/runs/${run.runId}?projectRoot=${encodeURIComponent(root)}`);
    assert.equal((status.run as { status: string }).status, "created");

    const events = await vnextRuntimeRequest(handle, "GET", `/v1/runs/${run.runId}/events?projectRoot=${encodeURIComponent(root)}`);
    assert.equal((events.events as unknown[]).length, 1);

    const cancel = await vnextRuntimeRequest(handle, "POST", `/v1/runs/${run.runId}/cancel?projectRoot=${encodeURIComponent(root)}`, {});
    assert.equal((cancel.run as { status: string }).status, "cancelled");

    const list = await vnextRuntimeRequest(handle, "GET", `/v1/projects/prj_01JRUNTIMETEST0000000000/runs?projectRoot=${encodeURIComponent(root)}`);
    assert.equal((list.runs as unknown[]).length, 1);

    const statusCheck = vnextSupervisorStatus(vnextRuntimePaths({ stateRoot }));
    assert.equal(statusCheck.running, true);
    assert.equal(statusCheck.runtimeId, supervisor.runtimeId);

    await supervisor.stop();
    supervisor = undefined;
    const stopped = vnextSupervisorStatus(vnextRuntimePaths({ stateRoot }));
    assert.equal(stopped.running, false);
  } finally {
    if (supervisor) await supervisor.stop();
    cleanup(root, stateRoot);
  }
});

test("takeover races and pid-guarded singleton updates", () => {
  const { stateRoot } = committedProject("kxm-runtime-race-");
  try {
    const paths = vnextRuntimePaths({ stateRoot });
    const registry = new VnextRuntimeRegistry(paths.registryDb);
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
    const paths = vnextRuntimePaths({ stateRoot });
    const registry = new VnextRuntimeRegistry(paths.registryDb);
    registry.close();
    const bump = new DatabaseSync(paths.registryDb);
    bump.exec("PRAGMA user_version = 99");
    bump.close();
    assert.throws(() => new VnextRuntimeRegistry(paths.registryDb), /newer than this runtime supports/);
    const restore = new DatabaseSync(paths.registryDb);
    restore.exec("PRAGMA user_version = 1");
    restore.close();

    // Command conflicts: kind, runId, and request mismatches fail closed.
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: "rtm_test" });
    try {
      const acceptCommand = newVnextCommandId();
      acceptVnextRun(context, bundle, { commandId: acceptCommand, workflowId: "default", prompt: "one" });
      assert.throws(
        () => acceptVnextRun(context, bundle, { commandId: acceptCommand, workflowId: "default", prompt: "different" }),
        /run_command_conflict/,
      );
      assert.throws(
        () => cancelVnextRun(context, "run_00000000000000000000000000000000", { commandId: acceptCommand }),
        /run_command_conflict/,
      );
      const run2 = acceptVnextRun(context, bundle, { workflowId: "default", prompt: "two" });
      const cancelCommand = newVnextCommandId();
      cancelVnextRun(context, run2.run.runId, { commandId: cancelCommand });
      const third = cancelVnextRun(context, run2.run.runId, { commandId: cancelCommand });
      assert.equal(third.idempotent, true, "repeated cancel command is idempotent, not a conflict");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    cleanup(root, stateRoot);
  }
});

test("supervisor API misuse: relative roots, oversized and non-object bodies, unknown paths", async () => {
  const { root, stateRoot } = committedProject("kxm-runtime-apimisuse-");
  let supervisor: Awaited<ReturnType<typeof startVnextRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startVnextRuntimeSupervisor({ stateRoot });
    const token = readVnextSupervisorToken(vnextRuntimePaths({ stateRoot }))!;

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
  const paths = vnextRuntimePaths({ stateRoot });
  let supervisor: Awaited<ReturnType<typeof startVnextRuntimeSupervisor>> | undefined;
  try {
    supervisor = await startVnextRuntimeSupervisor({ stateRoot });
    const oldToken = readVnextSupervisorToken(paths)!;
    const health = await fetch(`http://127.0.0.1:${supervisor.port}/healthz`);
    assert.equal(health.ok, true);
    await supervisor.stop();
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));

    const second = await startVnextRuntimeSupervisor({ stateRoot });
    try {
      const newToken = readVnextSupervisorToken(paths)!;
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

test("post-takeover ensureVnextSupervisor reuses the live supervisor (healthz reports the inherited id)", async () => {
  const { stateRoot } = committedProject("kxm-runtime-posttakeover-");
  const paths = vnextRuntimePaths({ stateRoot });
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
    // The restarted supervisor must be reused by ensureVnextSupervisor via the
    // healthz proof (which now reports the inherited logical runtime id).
    const handle = await ensureVnextSupervisor({ stateRoot });
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
  const paths = vnextRuntimePaths({ stateRoot });
  let supervisor: Awaited<ReturnType<typeof startVnextRuntimeSupervisor>> | undefined;
  try {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(paths.runtimeDir, "supervisor.error"), "stale failure\n", "utf8");
    supervisor = await startVnextRuntimeSupervisor({ stateRoot });
    const winnerToken = readVnextSupervisorToken(paths)!;

    // A second in-process supervisor loses the claim: it must not overwrite
    // the winner's token file, and its conflict is not recorded as an error.
    const { lstatSync, readFileSync } = await import("node:fs");
    const mtimeBefore = lstatSync(vnextSupervisorTokenFile(paths)).mtimeMs;
    await assert.rejects(
      startVnextRuntimeSupervisor({ stateRoot }),
      /runtime supervisor is already managed/,
    );
    assert.equal(readVnextSupervisorToken(paths), winnerToken, "the loser's token never replaces the winner's");
    assert.equal(lstatSync(vnextSupervisorTokenFile(paths)).mtimeMs, mtimeBefore, "token file untouched by the loser");
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
  const paths = vnextRuntimePaths({ stateRoot });
  const script = join(process.cwd(), "scripts", "kxm-runtime-supervisor.mjs");
  const env = { ...process.env, KXM_STATE_HOME: stateRoot };
  const child = spawnChild(script, env);
  try {
    const status = await waitForSupervisor(paths);
    const childPid = status.pid as number;
    // A competitor takes over the singleton; the child's next heartbeat
    // updates 0 rows and it must shut itself down instead of lingering.
    const registry = new VnextRuntimeRegistry(paths.registryDb);
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
  const paths = vnextRuntimePaths({ stateRoot });
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
    const acceptance = await vnextRuntimeRequest(firstHandle, "POST", "/v1/runs", {
      projectRoot: root,
      workflowId: "default",
      prompt: "durable",
    });
    const runId = (acceptance.run as { runId: string }).runId;

    // SIGKILL the supervisor: registry still claims the dead pid.
    first?.kill("SIGKILL");
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    const dead = vnextSupervisorStatus(paths);
    assert.equal(dead.running, false, "the killed supervisor reports dead");

    // A new supervisor takes over (same logical runtime id) and serves
    // identical projected state. The token rotated on restart; re-read it.
    second = spawnChild(script, env);
    const secondStatus = await waitForSupervisor(paths);
    const secondToken = await waitForToken(paths);
    assert.equal(secondStatus.runtimeId, firstStatus.runtimeId, "the logical runtime identity survives takeover");
    assert.notEqual(secondStatus.pid, firstStatus.pid, "the process is new");
    const secondHandle = { runtimeId: secondStatus.runtimeId as string, port: secondStatus.port as number, token: secondToken, started: true };
    const recovered = await vnextRuntimeRequest(secondHandle, "GET", `/v1/runs/${runId}?projectRoot=${encodeURIComponent(root)}`);
    assert.equal((recovered.run as { runId: string }).runId, runId);
    assert.equal((recovered.run as { status: string }).status, "created");
    const events = await vnextRuntimeRequest(secondHandle, "GET", `/v1/runs/${runId}/events?projectRoot=${encodeURIComponent(root)}`);
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

async function waitForToken(paths: ReturnType<typeof vnextRuntimePaths>): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const token = readVnextSupervisorToken(paths);
    if (token) return token;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("supervisor token did not appear in time");
}

async function waitForSupervisor(paths: ReturnType<typeof vnextRuntimePaths>): Promise<{ runtimeId?: string; pid?: number; port?: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = vnextSupervisorStatus(paths);
    if (status.running && status.port) return status;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("supervisor did not become ready in time");
}

test("ensureVnextSupervisor auto-starts a detached supervisor and reuses it", async () => {
  const { stateRoot } = committedProject("kxm-runtime-autostart-");
  const paths = vnextRuntimePaths({ stateRoot });
  let handle: Awaited<ReturnType<typeof ensureVnextSupervisor>> | undefined;
  try {
    handle = await ensureVnextSupervisor({ stateRoot });
    assert(handle.port > 0);
    assert.equal(handle.started, true);
    const again = await ensureVnextSupervisor({ stateRoot });
    assert.equal(again.started, false, "the live supervisor is reused");
    assert.equal(again.port, handle.port);
    const status = vnextSupervisorStatus(paths);
    assert.equal(status.running, true);
    await vnextRuntimeRequest(handle, "POST", "/v1/shutdown", {});
    const deadline = Date.now() + 5_000;
    let stopped = vnextSupervisorStatus(paths);
    while (stopped.running && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      stopped = vnextSupervisorStatus(paths);
    }
    assert.equal(stopped.running, false, "supervisor stopped cleanly before cleanup");
  } finally {
    if (handle) {
      try { await vnextRuntimeRequest(handle, "POST", "/v1/shutdown", {}); } catch { /* already stopped */ }
      await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    }
    cleanup(stateRoot);
  }
});

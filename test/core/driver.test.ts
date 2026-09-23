import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTestMesh } from "../helpers.ts";
import { makeGitRoot } from "../helpers/git-root.ts";
import { RuntimeHubClient, type HubHttpError } from "../../plugins/kxm/src/client.ts";
import {
  ExternalEffectsLedger,
  claimSharedEffect,
  commitSharedEffect,
  computeEffectKey,
} from "../../plugins/kxm/src/external-effects.ts";
import { loadKxmProject, syncEventSchemaErrors } from "../../plugins/kxm/src/project-config.ts";
import { syncKxmOutbox } from "../../plugins/kxm/src/runtime-supervisor.ts";
import type { KxmSyncEvent } from "../../plugins/kxm/src/sync-transform.ts";
import {
  createKxmSimulatedProducer,
  driveKxmRun,
  gateRecoveryPreflight,
  pinKxmCompiledPlan,
  recoverKxmRun,
  stepKxmRun,
  type KxmProducerRequest,
  type KxmProducerResult,
} from "../../plugins/kxm/src/engine.ts";
import {
  acceptKxmRun,
  closeKxmRuntimeContext,
  foldStoredKxmRun,
  openKxmRuntimeContext,
  type KxmRuntimeContext,
} from "../../plugins/kxm/src/runtime-service.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOME = "rtm_01JDRIVER0000000000000000";
const NODE = process.execPath;

interface DriverEnv {
  root: string;
  stateRoot: string;
  gateScriptPath: string;
  setGateExit: (exitCode: number) => void;
  setGateKill: () => void;
  cleanup: () => void;
}

function setupDriverEnv(prefix = "kxm-driver-"): DriverEnv {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const stateRoot = mkdtempSync(join(tmpdir(), `${prefix}state-`));
  cpSync(join(repoRoot, "examples/project"), root, { recursive: true });

  makeGitRoot(root);
  makeGitRoot(join(root, "repositories", "api"));
  makeGitRoot(join(root, "repositories", "web"));

  const gateScriptPath = join(root, "gate-script.cjs");
  writeFileSync(gateScriptPath, "process.exit(0);\n");

  writeFileSync(
    join(root, ".kxm", "gates.yaml"),
    `schema: kxm.gate-registry.v1
gates:
  test:
    kind: command
    argv: [${JSON.stringify(NODE)}, ${JSON.stringify(gateScriptPath)}]
    timeoutMs: 3600000
  scm-delivery:
    kind: command
    argv: [${JSON.stringify(NODE)}, ${JSON.stringify(gateScriptPath)}]
    timeoutMs: 1800000
`,
  );

  spawnSync("git", ["-C", root, "add", "-A"], { windowsHide: true });
  spawnSync(
    "git",
    ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"],
    { windowsHide: true },
  );

  return {
    root,
    stateRoot,
    gateScriptPath,
    setGateExit(code: number) {
      writeFileSync(gateScriptPath, `process.exit(${code});\n`);
    },
    setGateKill() {
      writeFileSync(gateScriptPath, 'process.kill(process.pid, "SIGKILL");\n');
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    },
  };
}

test("Phase 3 Driver: default.yaml normal completion (plan -> implement -> verify -> ready -> completed)", async () => {
  const env = setupDriverEnv("kxm-driver-default-normal-");
  try {
    const bundle = loadKxmProject(env.root);
    const context = openKxmRuntimeContext(env.root, { stateRoot: env.stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "default run" });
      pinKxmCompiledPlan(context, bundle, accepted.run.runId);

      const visitedSteps: string[] = [];
      const producer = createKxmSimulatedProducer(async (req) => {
        visitedSteps.push(req.stepId);
        return { outcome: "passed" };
      });

      const result = await driveKxmRun(context, accepted.run.runId, producer, { allowLimits: true });
      assert.equal(result.state.status, "completed");
      assert.equal(result.handoff, undefined);

      // Verify execution path: plan, implement, verify (gate), ready
      assert.deepEqual(visitedSteps, ["plan", "implement", "ready"]);

      const events = context.eventStore.events(accepted.run.runId, 0, 10_000);
      const stepEnteredEvents = events.filter((e) => e.eventType === "step.entered");
      assert.deepEqual(
        stepEnteredEvents.map((e) => e.payload.stepId),
        ["plan", "implement", "verify", "ready"],
      );
      assert.equal(events.some((e) => e.eventType === "effect.settled" && e.payload.outcome === "passed"), true);
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    env.cleanup();
  }
});

test("Phase 3 Driver: default.yaml implementation-failure rework loop (verify -> implement -> verify -> ready -> completed)", async () => {
  const env = setupDriverEnv("kxm-driver-default-rework-");
  try {
    let gateAttempts = 0;
    // On first gate attempt, exit with 1 (implementation-failure). On subsequent, exit with 0.
    writeFileSync(
      env.gateScriptPath,
      `const fs = require('fs');
const countFile = ${JSON.stringify(join(env.root, "gate-count.txt"))};
let count = 0;
if (fs.existsSync(countFile)) count = parseInt(fs.readFileSync(countFile, 'utf8'), 10);
fs.writeFileSync(countFile, String(count + 1));
process.exit(count === 0 ? 1 : 0);
`,
    );

    const bundle = loadKxmProject(env.root);
    const context = openKxmRuntimeContext(env.root, { stateRoot: env.stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "default rework" });
      pinKxmCompiledPlan(context, bundle, accepted.run.runId);

      const visitedSteps: Array<{ stepId: string; stepAttempt: number }> = [];
      const producer = createKxmSimulatedProducer(async (req) => {
        visitedSteps.push({ stepId: req.stepId, stepAttempt: req.stepAttempt });
        return { outcome: "passed" };
      });

      const result = await driveKxmRun(context, accepted.run.runId, producer, { allowLimits: true });
      assert.equal(result.state.status, "completed");

      // Verify implement ran twice: stepAttempt 1 and stepAttempt 2
      assert.deepEqual(visitedSteps, [
        { stepId: "plan", stepAttempt: 1 },
        { stepId: "implement", stepAttempt: 1 },
        { stepId: "implement", stepAttempt: 2 },
        { stepId: "ready", stepAttempt: 1 },
      ]);

      const events = context.eventStore.events(accepted.run.runId, 0, 10_000);
      const stepEnteredEvents = events.filter((e) => e.eventType === "step.entered");
      assert.deepEqual(
        stepEnteredEvents.map((e) => ({ stepId: e.payload.stepId, stepAttempt: e.payload.stepAttempt })),
        [
          { stepId: "plan", stepAttempt: 1 },
          { stepId: "implement", stepAttempt: 1 },
          { stepId: "verify", stepAttempt: 1 },
          { stepId: "implement", stepAttempt: 2 },
          { stepId: "verify", stepAttempt: 2 },
          { stepId: "ready", stepAttempt: 1 },
        ],
      );

      // Verify edge transition verify:implementation-failure was recorded
      assert.equal(result.state.edgeTransitions["verify:implementation-failure"], 1);
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    env.cleanup();
  }
});

test("Phase 3 Driver: default.yaml command gate uncertainty and recovery via retry to completion", async () => {
  const env = setupDriverEnv("kxm-driver-default-uncertain-retry-");
  try {
    env.setGateKill();

    const bundle = loadKxmProject(env.root);
    const context = openKxmRuntimeContext(env.root, { stateRoot: env.stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "default uncertain" });
      pinKxmCompiledPlan(context, bundle, accepted.run.runId);

      const producer = createKxmSimulatedProducer(async () => ({ outcome: "passed" }));

      // Run until uncertain gate blocks
      const blocked = await driveKxmRun(context, accepted.run.runId, producer, { allowLimits: true });
      assert.equal(blocked.handoff?.reason, "attempt_unsettled");
      assert.equal(blocked.state.currentStep?.effectState, "blocked_uncertain");

      // Preflight in project should detect the blocking attempt
      const preflight = gateRecoveryPreflight(context);
      assert.equal(preflight.blocking.length, 1);
      assert.equal(preflight.blocking[0]?.runId, accepted.run.runId);

      // Recover the run with action "retry"
      const recovered = recoverKxmRun(context, accepted.run.runId, { action: "retry", reason: "operator retry" });
      assert.equal(recovered.unblocked, true);
      assert.equal(recovered.state.status, "running");
      assert.equal(recovered.state.pendingStepId, "verify");
      assert.equal(recovered.state.currentStep, undefined);

      // Preflight after retry unblocking should no longer be blocked by the superseded attempt
      const preflightAfter = gateRecoveryPreflight(context);
      assert.equal(preflightAfter.blocking.length, 0);

      // Now set gate to pass
      env.setGateExit(0);

      // Drive to completion
      const completed = await driveKxmRun(context, accepted.run.runId, producer, { allowLimits: true });
      assert.equal(completed.state.status, "completed");

      const events = context.eventStore.events(accepted.run.runId, 0, 10_000);
      assert.equal(events.some((e) => e.eventType === "run.status_changed" && e.payload.status === "blocked_uncertain"), true);
      assert.equal(events.some((e) => e.eventType === "run.status_changed" && e.payload.status === "running" && e.payload.previousStatus === "blocked_uncertain"), true);
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    env.cleanup();
  }
});

test("Phase 3 Driver: default.yaml command gate uncertainty and terminal recovery (fail and cancel)", async () => {
  const env = setupDriverEnv("kxm-driver-default-terminal-recovery-");
  try {
    env.setGateKill();

    const bundle = loadKxmProject(env.root);
    const context = openKxmRuntimeContext(env.root, { stateRoot: env.stateRoot, homeRuntimeId: HOME });
    try {
      const producer = createKxmSimulatedProducer(async () => ({ outcome: "passed" }));

      // 1. Terminal recovery via "fail"
      const failRun = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "fail run" });
      pinKxmCompiledPlan(context, bundle, failRun.run.runId);
      const blockedFail = await driveKxmRun(context, failRun.run.runId, producer, { allowLimits: true });
      assert.equal(blockedFail.handoff?.reason, "attempt_unsettled");
      assert.equal(blockedFail.state.currentStep?.effectState, "blocked_uncertain");

      const failedRecovery = recoverKxmRun(context, failRun.run.runId, { action: "fail", reason: "operator aborted" });
      assert.equal(failedRecovery.unblocked, true);
      assert.equal(failedRecovery.state.status, "failed");

      // Verify the failed run's attempt is now excluded from preflight
      assert.equal(gateRecoveryPreflight(context).blocking.length, 0);

      // 2. Terminal recovery via "cancel"
      const cancelRun = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "cancel run" });
      pinKxmCompiledPlan(context, bundle, cancelRun.run.runId);
      const blockedCancel = await driveKxmRun(context, cancelRun.run.runId, producer, { allowLimits: true });
      assert.equal(blockedCancel.handoff?.reason, "attempt_unsettled");
      assert.equal(blockedCancel.state.currentStep?.effectState, "blocked_uncertain");

      const cancelRecovery = recoverKxmRun(context, cancelRun.run.runId, { action: "cancel", reason: "operator cancelled" });
      assert.equal(cancelRecovery.unblocked, true);
      assert.equal(cancelRecovery.state.status, "cancelled");

      // Verify both terminated runs remain excluded
      assert.equal(gateRecoveryPreflight(context).blocking.length, 0);
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    env.cleanup();
  }
});

test("Phase 3 Driver: fix.yaml full drive (approval, two-producer join, rework loops on critics and approval)", async () => {
  const env = setupDriverEnv("kxm-driver-fix-full-");
  try {
    env.setGateExit(0);

    const bundle = loadKxmProject(env.root);
    const context = openKxmRuntimeContext(env.root, { stateRoot: env.stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptKxmRun(context, bundle, { workflowId: "fix", prompt: "fix run" });
      pinKxmCompiledPlan(context, bundle, accepted.run.runId);

      let criticsVisit = 0;
      let approvalVisit = 0;
      const stepInvocations: Array<{ stepId: string; stepAttempt: number; agentId: string }> = [];

      const producer = createKxmSimulatedProducer(async (req) => {
        stepInvocations.push({
          stepId: req.stepId,
          stepAttempt: req.stepAttempt,
          agentId: req.agentId,
        });

        if (req.stepId === "critics") {
          criticsVisit += 1;
          // First visit to critics (3 members): 2 return plan_invalidated, 1 returns passed.
          // all-settled join evaluates plan_invalidated since count 2 >= minimumPassed 2.
          if (criticsVisit <= 3) {
            if (req.agentId === "critic-1" || req.agentId === "critic-2") {
              return { outcome: "plan_invalidated" };
            }
            return { outcome: "passed" };
          }
          // Subsequent visits: all pass
          return { outcome: "passed" };
        }

        if (req.stepId === "approval") {
          approvalVisit += 1;
          // First visit to approval: reject (rework back-edge to plan)
          if (approvalVisit === 1) {
            return { outcome: "rejected" };
          }
          // Second visit: pass
          return { outcome: "passed" };
        }

        return { outcome: "passed" };
      });

      const result = await driveKxmRun(context, accepted.run.runId, producer, { allowLimits: true });
      assert.equal(result.state.status, "completed");
      assert.equal(result.handoff, undefined);

      // Verify edge transitions:
      // critics:plan_invalidated taken once
      assert.equal(result.state.edgeTransitions["critics:plan_invalidated"], 1);
      // approval:rejected taken once
      assert.equal(result.state.edgeTransitions["approval:rejected"], 1);

      // Verify step attempts:
      // plan had 3 attempts (initial + rework from critics + rework from approval)
      assert.equal(result.state.stepAttempts["plan"], 3);
      // critics had 3 attempts
      assert.equal(result.state.stepAttempts["critics"], 3);
      // final-plan had 2 attempts
      assert.equal(result.state.stepAttempts["final-plan"], 2);
      // approval had 2 attempts
      assert.equal(result.state.stepAttempts["approval"], 2);
      // implement had 1 attempt
      assert.equal(result.state.stepAttempts["implement"], 1);
      // local-verify had 1 attempt
      assert.equal(result.state.stepAttempts["local-verify"], 1);
      // delivery had 1 attempt
      assert.equal(result.state.stepAttempts["delivery"], 1);
      // ci-watch had 1 attempt
      assert.equal(result.state.stepAttempts["ci-watch"], 1);
      // ready-for-human-acceptance had 1 attempt
      assert.equal(result.state.stepAttempts["ready-for-human-acceptance"], 1);

      // Verify MOA panel births:
      // repro-review had 3 members birthed (critic-1, critic-2, critic-3)
      const reproReviewInvocations = stepInvocations.filter((i) => i.stepId === "repro-review");
      assert.equal(reproReviewInvocations.length, 3);
      assert.deepEqual(reproReviewInvocations.map((i) => i.agentId).sort(), ["critic-1", "critic-2", "critic-3"]);

      // Verify no illegal transitions occurred in event store
      const events = context.eventStore.events(accepted.run.runId, 0, 100_000);
      const statusChanges = events.filter((e) => e.eventType === "run.status_changed");
      assert.deepEqual(
        statusChanges.map((e) => e.payload.status),
        ["preparing", "running", "completed"],
      );
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    env.cleanup();
  }
});

test("Phase 3 Driver: Caller-authored and untrusted producers are rejected", async () => {
  const env = setupDriverEnv("kxm-driver-untrusted-");
  try {
    const bundle = loadKxmProject(env.root);
    const context = openKxmRuntimeContext(env.root, { stateRoot: env.stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptKxmRun(context, bundle, { workflowId: "default", prompt: "untrusted" });
      pinKxmCompiledPlan(context, bundle, accepted.run.runId);

      const fakeProducer = {
        id: "driver-simulated" as const,
        async produce() {
          return { outcome: "passed" };
        },
      };

      await assert.rejects(
        () => driveKxmRun(context, accepted.run.runId, fakeProducer, { allowLimits: true }),
        /engine_producer_untrusted/,
      );
    } finally {
      closeKxmRuntimeContext(context);
    }
  } finally {
    env.cleanup();
  }
});

test("two runtimes synchronize independent offline runs and a conflicting shared push is refused without the lease", async (t) => {
  const homeA = "rtm_01JDRIVERA000000000000000";
  const homeB = "rtm_01JDRIVERB000000000000000";
  const envA = setupDriverEnv("kxm-driver-gate-a-");
  const envB = setupDriverEnv("kxm-driver-gate-b-");
  const contextA = openKxmRuntimeContext(envA.root, { stateRoot: envA.stateRoot, homeRuntimeId: homeA });
  const contextB = openKxmRuntimeContext(envB.root, { stateRoot: envB.stateRoot, homeRuntimeId: homeB });
  t.after(() => {
    closeKxmRuntimeContext(contextA);
    closeKxmRuntimeContext(contextB);
    envA.cleanup();
    envB.cleanup();
  });

  // 1. Offline: no hub exists yet. Each Runtime drives its own run to completion
  //    and the outbox simply accumulates.
  const producer = createKxmSimulatedProducer(async () => ({ outcome: "passed" }));
  const offlineRun = async (context: KxmRuntimeContext, root: string, prompt: string): Promise<string> => {
    const bundle = loadKxmProject(root);
    const accepted = acceptKxmRun(context, bundle, { workflowId: "default", prompt });
    pinKxmCompiledPlan(context, bundle, accepted.run.runId);
    const result = await driveKxmRun(context, accepted.run.runId, producer, { allowLimits: true });
    assert.equal(result.state.status, "completed");
    return accepted.run.runId;
  };
  const runA = await offlineRun(contextA, envA.root, "box A offline run");
  const runB = await offlineRun(contextB, envB.root, "box B offline run");
  assert.notEqual(runA, runB);

  for (const [context, runId] of [[contextA, runA], [contextB, runB]] as const) {
    const events = context.eventStore.events(runId, 0, 10_000);
    const rows = context.eventStore.outboxForRun(runId);
    assert.equal(rows.length, events.length, "every committed event has one outbox row");
    assert.deepEqual(context.eventStore.pendingOutbox(10_000).map((row) => row.sequence), events.map((event) => event.sequence));
    for (const row of rows) {
      const sync = JSON.parse(row.syncEvent) as KxmSyncEvent;
      assert.equal(syncEventSchemaErrors(sync), undefined, `${runId} row ${row.sequence} must validate kxm.sync-event.v1`);
      assert.equal(sync.homeRuntimeId, context.homeRuntimeId);
      assert.equal(row.ackedAt, undefined, "nothing is acknowledged while offline");
    }
  }

  // 2. Reconnect: one hub, whose clock the test owns so the lease TTL below is
  //    moved rather than slept through.
  let hubClockMs = Date.now();
  const mesh = await createTestMesh(t, { now: () => hubClockMs });
  const project = "test-project";
  const runtimeA = new RuntimeHubClient({ serverUrl: mesh.address.url, project, authToken: mesh.token, runtimeId: homeA, host: "box-a" });
  const runtimeB = new RuntimeHubClient({ serverUrl: mesh.address.url, project, authToken: mesh.token, runtimeId: homeB, host: "box-b" });
  assert.equal((await runtimeA.heartbeat()).presence, "online");
  assert.equal((await runtimeB.heartbeat()).presence, "online");

  const cursors = new Map<string, number>();
  for (const [context, client, runId] of [[contextA, runtimeA, runA], [contextB, runtimeB, runB]] as const) {
    const total = context.eventStore.outboxForRun(runId).length;
    const pushed = await syncKxmOutbox(context.eventStore, client);
    assert.deepEqual(pushed, { pushed: total, acked: total, conflicts: 0, rejected: 0 });
    assert.deepEqual(context.eventStore.pendingOutbox(), [], "acknowledged rows advance the cursor");
    cursors.set(runId, total);
  }

  // 3. The hub's snapshot shows each run under its own home Runtime.
  const response = await fetch(`${mesh.address.url}/v1/ops/snapshot?project=${project}`, {
    headers: { authorization: `Bearer ${mesh.token}` },
  });
  assert.equal(response.status, 200);
  const snapshot = await response.json() as { homeRuntimes: Array<Record<string, unknown>> };
  const homes = new Map(snapshot.homeRuntimes.map((home) => [home.runtimeId as string, home]));
  assert.equal(homes.size, 2);
  for (const [home, host, runId] of [[homeA, "box-a", runA], [homeB, "box-b", runB]] as const) {
    const view = homes.get(home);
    assert(view, `${home} is listed`);
    assert.equal(view.host, host);
    assert.equal(view.presence, "online");
    assert.equal(view.orphaned, false);
    const runs = view.runs as Array<Record<string, unknown>>;
    assert.deepEqual(runs.map((run) => run.runId), [runId], "a run appears only under its home Runtime");
    assert.equal(runs[0]!.status, "completed");
    assert.equal(runs[0]!.lastSequence, cursors.get(runId));
    assert.equal(runs[0]!.pendingGap, false);
  }

  // 4. Both boxes now attempt the same shared push. Their ledgers are separate,
  //    so the hub lease is the only thing between them.
  const agentA = mesh.makeClient("gate-box-a");
  const agentB = mesh.makeClient("gate-box-b");
  await agentA.start(() => undefined);
  await agentB.start(() => undefined);
  const ledgerA = new ExternalEffectsLedger(":memory:");
  const ledgerB = new ExternalEffectsLedger(":memory:");
  t.after(() => {
    ledgerA.close();
    ledgerB.close();
  });
  const targetRef = "refs/heads/main";
  const shared = { stepId: "delivery", actionKind: "git-push", targetRef, leaseTtlMs: 5_000 } as const;

  const claimA = await claimSharedEffect({ ledger: ledgerA, lease: agentA, runId: runA, attemptId: "att_gate_a1", ...shared });
  if (!claimA.ok) throw new Error(`box A should have taken the lease: ${claimA.error}`);
  assert.equal(claimA.fencingToken, 1);
  assert.equal(claimA.leaseResource, `${project}/${targetRef}`);

  // 5. Without the lease, box B is refused before it claims or executes anything.
  const refused = await claimSharedEffect({ ledger: ledgerB, lease: agentB, runId: runB, attemptId: "att_gate_b1", ...shared });
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.code, "effect_lease_held");
  assert.equal(ledgerB.getReceipt(computeEffectKey(runB, "delivery", "git-push", targetRef)), undefined);

  // Box A stalls past its TTL on the hub clock; box B takes over, which is the
  // only thing that moves the fencing token.
  hubClockMs += 6_000;
  const takeover = await claimSharedEffect({ ledger: ledgerB, lease: agentB, runId: runB, attemptId: "att_gate_b2", ...shared });
  if (!takeover.ok) throw new Error(`the TTL should have freed the resource: ${takeover.error}`);
  assert.equal(takeover.fencingToken, 2);

  // 6. Box A's late commit carries a superseded token: refused, the effect stays
  //    in-flight, and the attempt parks uncertain.
  const lateCommit = await commitSharedEffect({ ledger: ledgerA, lease: agentA, effectKey: claimA.effectKey, receiptPayload: { pushedSha: "deadbeef" } });
  assert.equal(lateCommit.ok, false);
  assert.equal(!lateCommit.ok && lateCommit.code, "effect_lease_superseded");
  assert.equal(!lateCommit.ok && lateCommit.attemptState, "blocked_uncertain");
  const parked = ledgerA.getReceipt(claimA.effectKey)!;
  assert.equal(parked.status, "in-flight");
  assert.equal(parked.completedAt, undefined);
  assert.equal(parked.fencingToken, 1, "nothing re-acquired on the loser's behalf");
  assert.deepEqual(parked.receiptPayload, {});

  // Nothing retries: the resource stays with box B under token 2.
  const stillHeld = await agentA.acquireLease(targetRef, 5_000).then(
    () => undefined,
    (error: unknown) => error as HubHttpError,
  );
  assert.equal(stillHeld?.statusCode, 409);
  assert.equal(stillHeld?.code, "lease_held");

  // Exactly one push lands, under the token the hub actually holds.
  const winner = await commitSharedEffect({ ledger: ledgerB, lease: agentB, effectKey: takeover.effectKey, receiptPayload: { pushedSha: "cafebabe" } });
  if (!winner.ok) throw new Error(`the lease holder should commit: ${winner.error}`);
  assert.equal(winner.receipt.status, "committed");
  assert.equal(winner.receipt.runId, runB);
  assert.equal(winner.receipt.fencingToken, 2);
  assert.equal(ledgerA.getReceipt(claimA.effectKey)?.status, "in-flight", "the loser never commits");
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeGitRoot } from "../helpers/git-root.ts";
import { loadKxmProject } from "../../plugins/kxm/src/project-config.ts";
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

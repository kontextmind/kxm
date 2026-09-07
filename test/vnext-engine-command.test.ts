import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { removeTempDir } from "./helpers.ts";
import { engineProject } from "./helpers/vnext-project.ts";
import { loadVnextProject, vnextCanonicalJson } from "../plugins/kxm/src/vnext-config.ts";
import { recordGateIntent } from "../plugins/kxm/src/vnext-engine-gate-records.ts";
import { loadVnextRunPlanEnvelope } from "../plugins/kxm/src/vnext-engine-plan.ts";
import { computeVnextPermissionDiff } from "../plugins/kxm/src/vnext-permission.ts";
import { vnextCommandGateSeams } from "../plugins/kxm/src/vnext-engine-command.ts";
import {
  VnextRunScheduler,
  createVnextSimulatedProducer,
  driveVnextRun,
  gateRecoveryPreflight,
  pinVnextCompiledPlan,
  startVnextRun,
  stepVnextRun,
  vnextGateDispatchSeams,
} from "../plugins/kxm/src/vnext-engine.ts";
import { vnextToolPolicyRevision } from "../plugins/kxm/src/vnext-runtime.ts";
import {
  finishVnextOwnedGate,
  markVnextGateHoldUnsettled,
  registerVnextAttemptController,
  unregisterVnextAttemptController,
  vnextActiveScheduledRuns,
  vnextAdmittedToken,
  vnextGateHold,
  vnextQueuedScheduledRuns,
} from "../plugins/kxm/src/vnext-runtime-owner.ts";
import {
  acceptVnextRun,
  cancelVnextRun,
  closeVnextRuntimeContext,
  foldStoredVnextRun,
  openVnextRuntimeContext,
  type VnextRuntimeContext,
} from "../plugins/kxm/src/vnext-runtime.ts";

const HOME = "rtm_01JENGINE00000000000000000";
const NODE = process.execPath;
const WORKFLOWS = [
  "gate-command.yaml",
  "gate-command-ready.yaml",
  "gate-command-expect-fail.yaml",
  "gate-command-timeout-narrow.yaml",
  "gate-command-timeout-equal.yaml",
  "artifacts-gate.yaml",
  "artifacts-ready.yaml",
  "unsupported-gate.yaml",
];

function producer() {
  return createVnextSimulatedProducer(async () => ({ outcome: "passed" }));
}

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function writeGates(root: string, testGate: {
  argv: readonly string[];
  timeoutMs?: number;
  cwd?: "control";
}): void {
  const timeoutMs = testGate.timeoutMs ?? 3_600_000;
  const cwd = testGate.cwd === "control" ? "\n    cwd: control" : "";
  writeFileSync(join(root, ".kxm", "gates.yaml"), `schema: kxm.gate-registry.v1
gates:
  test:
    kind: command
    argv: ${JSON.stringify(testGate.argv)}
    timeoutMs: ${timeoutMs}${cwd}
  artifacts:
    kind: artifacts-exist
    paths: [dist/index.js]
`);
}

function emptyScript(exitCode = 0): string[] {
  return [NODE, "-e", `process.exit(${exitCode})`];
}

async function waitForPath(path: string, timeoutMs = 2000): Promise<void> {
  const start = process.hrtime.bigint();
  while (!existsSync(path)) {
    if (process.hrtime.bigint() - start > BigInt(timeoutMs) * 1_000_000n) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function killPid(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // gone
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // gone
  }
}

function resetSeams(): void {
  vnextCommandGateSeams.timing = undefined;
  vnextCommandGateSeams.beforeSpawn = undefined;
  vnextCommandGateSeams.afterSpawned = undefined;
  vnextCommandGateSeams.afterStopRequested = undefined;
  vnextCommandGateSeams.afterChildClose = undefined;
  vnextGateDispatchSeams.afterEvaluate = undefined;
  vnextGateDispatchSeams.afterObservationWrite = undefined;
  vnextGateDispatchSeams.afterUncertaintyWrite = undefined;
  vnextGateDispatchSeams.afterSettlementCommit = undefined;
  vnextGateDispatchSeams.afterSpawnRecord = undefined;
  vnextGateDispatchSeams.beforeCommandSpawn = undefined;
  vnextGateDispatchSeams.beforeCommandSettle = undefined;
}

function writeConcurrentRunLimit(root: string, maxConcurrentRuns: number): void {
  const path = join(root, ".kxm", "project.yaml");
  const current = readFileSync(path, "utf8");
  if (current.includes("maxConcurrentRuns:")) {
    writeFileSync(path, current.replace(/maxConcurrentRuns:\s*\d+/, `maxConcurrentRuns: ${maxConcurrentRuns}`));
    return;
  }
  writeFileSync(path, current.replace(
    "defaultHarness: pi\n",
    `defaultHarness: pi\nlimits:\n  maxConcurrentRuns: ${maxConcurrentRuns}\n`,
  ));
}

async function withS4(
  gate: { argv: readonly string[]; timeoutMs?: number; cwd?: "control"; maxConcurrentRuns?: number },
  fn: (args: {
    root: string;
    context: VnextRuntimeContext;
    bundle: ReturnType<typeof loadVnextProject>;
  }) => Promise<void> | void,
): Promise<void> {
  const { root, stateRoot } = engineProject("kxm-s4-", WORKFLOWS);
  try {
    writeGates(root, gate);
    if (gate.maxConcurrentRuns !== undefined) writeConcurrentRunLimit(root, gate.maxConcurrentRuns);
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      await fn({ root, context, bundle });
    } finally {
      closeVnextRuntimeContext(context);
      resetSeams();
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
}

function acceptReady(
  context: VnextRuntimeContext,
  bundle: ReturnType<typeof loadVnextProject>,
  workflowId: string,
  prompt: string,
) {
  const accepted = acceptVnextRun(context, bundle, { workflowId, prompt });
  pinVnextCompiledPlan(context, bundle, accepted.run.runId);
  startVnextRun(context, accepted.run.runId);
  return accepted.run;
}

function observation(context: VnextRuntimeContext, runId: string) {
  const attempt = context.eventStore.gateAttemptsForRun(runId)[0]!;
  return { attempt, row: context.eventStore.gateObservationForAttempt(attempt.attemptId) };
}

function assertNoRawText(row: object): void {
  for (const key of Object.keys(row)) {
    assert.equal(["stdout", "stderr", "error", "errorText", "stdoutText", "stderrText", "errorMessage", "message"].includes(key), false);
  }
}

test("S4 admission hold is armed during spawn and released after evaluated settlement", async () => {
  await withS4({ argv: emptyScript(0) }, async ({ context, bundle }) => {
    const run = acceptReady(context, bundle, "gate-command-ready", "hold-step");
    let seen = 0;
    let busyCheck: Promise<void> | undefined;
    vnextCommandGateSeams.afterSpawned = () => {
      seen = vnextActiveScheduledRuns(context.eventStore.path);
      const hold = vnextGateHold(context.eventStore.path, run.runId);
      assert.equal(hold?.state, "active");
      assert.equal(hold?.attemptId, context.eventStore.gateAttemptsForRun(run.runId)[0]!.attemptId);
      busyCheck = assert.rejects(() => stepVnextRun(context, run.runId, producer()), /run_busy/);
    };
    const result = await stepVnextRun(context, run.runId, producer());
    assert.equal(result.state.status, "completed");
    await busyCheck;
    assert.equal(seen, 1);
    assert.equal(vnextActiveScheduledRuns(context.eventStore.path), 0);
    assert.equal(vnextGateHold(context.eventStore.path, run.runId), undefined);
  });

  await withS4({ argv: emptyScript(0) }, async ({ context, bundle }) => {
    const run = acceptReady(context, bundle, "gate-command-ready", "hold-drive");
    const driven = await driveVnextRun(context, run.runId, producer());
    assert.equal(driven.state.status, "completed");
    assert.equal(vnextActiveScheduledRuns(context.eventStore.path), 0);
  });

  await withS4({ argv: emptyScript(0) }, async ({ context, bundle }) => {
    const scheduled = acceptVnextRun(context, bundle, { workflowId: "gate-command-ready", prompt: "hold-sched" });
    pinVnextCompiledPlan(context, bundle, scheduled.run.runId);
    const scheduler = VnextRunScheduler.for(context, bundle);
    let seen = 0;
    vnextCommandGateSeams.afterSpawned = () => {
      seen = vnextActiveScheduledRuns(context.eventStore.path);
    };
    const result = await scheduler.enqueue(scheduled.run.runId, producer());
    await Promise.resolve();
    assert.equal(result.state.status, "completed");
    assert.equal(seen, 1);
    assert.equal(vnextActiveScheduledRuns(context.eventStore.path), 0);
  });
});

test("S4 evaluated command outcomes hash streams and never pass after a stop request", async () => {
  const payload = Buffer.alloc(70_000, 0x61);
  await withS4({ argv: [NODE, "-e", "process.stdout.write(Buffer.alloc(70000, 0x61), () => { process.stderr.write('x', () => { process.exitCode = 3; }); });"] }, async ({ context, bundle }) => {
    const run = acceptReady(context, bundle, "gate-command-ready", "bytes");
    const result = await driveVnextRun(context, run.runId, producer());
    assert.equal(result.state.status, "failed");
    const { row } = observation(context, run.runId);
    assert.equal(row?.completeness, "complete");
    assert.equal(typeof row?.pid, "number");
    assert.equal(row?.signal, null);
    assert.equal(row?.stopCause, "none");
    assert.equal(row?.signalsAttempted, "none");
    assert.equal(row?.stdoutBytes, 70_000);
    assert.equal(row?.stdoutComplete, 1);
    assert.equal(row?.stderrBytes, 1);
    assert.equal(row?.stderrComplete, 1);
    assert.equal(row?.stdoutSha256, sha256(payload));
    assert.equal(row?.stderrSha256, sha256("x"));
    assert.equal(context.eventStore.gateEvidenceForAttempt(row!.attemptId)?.outcome, "implementation-failure");
    const events = context.eventStore.events(run.runId, 0, 10_000);
    const dispatchedAt = events.find((event) => event.eventType === "effect.dispatched")!.sequence;
    const settling = events.find((event) => event.eventType === "attempt.status_changed" && event.payload.status === "settling")!.sequence;
    assert.ok(dispatchedAt < settling);
    assertNoRawText(row!);
  });

  await withS4({ argv: emptyScript(3) }, async ({ context, bundle }) => {
    const run = acceptReady(context, bundle, "gate-command-expect-fail", "fail-pass");
    const result = await driveVnextRun(context, run.runId, producer());
    assert.equal(result.state.status, "completed");
    const { row } = observation(context, run.runId);
    assert.equal(context.eventStore.gateEvidenceForAttempt(row!.attemptId)?.outcome, "passed");
  });

  await withS4({ argv: emptyScript(0) }, async ({ context, bundle }) => {
    const run = acceptReady(context, bundle, "gate-command-expect-fail", "repro");
    const result = await driveVnextRun(context, run.runId, producer());
    assert.equal(result.state.status, "failed");
    const { row } = observation(context, run.runId);
    assert.equal(context.eventStore.gateEvidenceForAttempt(row!.attemptId)?.outcome, "repro-missing");
  });

  await withS4({ argv: emptyScript(0), cwd: "control" }, async ({ root, context, bundle }) => {
    const run = acceptReady(context, bundle, "gate-command-ready", "cwd");
    const result = await driveVnextRun(context, run.runId, producer());
    assert.equal(result.state.status, "completed");
    assert.equal(result.state.status === "completed", true);
    void root;
  });
});

test("S4 no-start covers missing executable, validation, and cancel after intent before spawn", async () => {
  await withS4({ argv: ["/no/such/kxm-s4-command"] }, async ({ context, bundle }) => {
    const run = acceptReady(context, bundle, "gate-command-ready", "missing");
    const result = await driveVnextRun(context, run.runId, producer());
    assert.equal(result.state.status, "failed");
    assert.equal(result.state.status === "failed", true);
    const { row } = observation(context, run.runId);
    assert.equal(row?.completeness, "no-start");
    assert.equal(row?.errorClass, "spawn-error");
    assert.equal(row?.stopCause, "none");
    assert.equal(context.eventStore.gateEvidenceForAttempt(row!.attemptId), undefined);
    assert.equal(vnextGateHold(context.eventStore.path, run.runId), undefined);
    assert.equal(vnextActiveScheduledRuns(context.eventStore.path), 0);
    assert.equal(context.eventStore.events(run.runId, 0, 50).some((event) => event.eventType === "effect.dispatched"), false);
  });

  await withS4({ argv: emptyScript(0) }, async ({ context, bundle }) => {
    vnextCommandGateSeams.beforeSpawn = () => {
      throw new Error("validation seam");
    };
    const run = acceptReady(context, bundle, "gate-command-ready", "validation");
    const result = await driveVnextRun(context, run.runId, producer());
    assert.equal(result.state.status, "failed");
    const { row } = observation(context, run.runId);
    assert.equal(row?.completeness, "no-start");
    assert.equal(row?.errorClass, "validation");
  });

  await withS4({ argv: emptyScript(0) }, async ({ context, bundle }) => {
    const run = acceptReady(context, bundle, "gate-command-ready", "cancel-before-spawn");
    vnextGateDispatchSeams.beforeCommandSpawn = () => {
      cancelVnextRun(context, run.runId);
    };
    const result = await stepVnextRun(context, run.runId, producer());
    assert.equal(result.state.status, "cancelled");
    const { row } = observation(context, run.runId);
    assert.equal(row?.completeness, "no-start");
    assert.equal(row?.stopCause, "cancel");
    assert.equal(row?.errorClass, null);
    assert.equal(context.eventStore.events(run.runId, 0, 50).some((event) => event.eventType === "effect.dispatched"), false);
    assert.equal(vnextGateHold(context.eventStore.path, run.runId), undefined);
  });
});

test("S4 timeout, term-kill, and exit-0-during-grace stay uncertain", { timeout: 15_000 }, async () => {
  vnextCommandGateSeams.timing = { termGraceMs: 120, finalWaitMs: 120, lingerMs: 120 };
  const sleeper = [NODE, "-e", "setInterval(() => {}, 1e9)"];
  await withS4({ argv: sleeper, timeoutMs: 200 }, async ({ context, bundle }) => {
    vnextCommandGateSeams.timing = { termGraceMs: 120, finalWaitMs: 120, lingerMs: 120 };
    const run = acceptReady(context, bundle, "gate-command-ready", "timeout");
    const result = await stepVnextRun(context, run.runId, producer());
    assert.equal(result.handoff?.reason, "attempt_unsettled");
    assert.equal(result.handoff?.detail, "timeout");
    assert.equal(result.state.status, "running");
    const { attempt, row } = observation(context, run.runId);
    assert.equal(row?.completeness, "incomplete");
    assert.equal(row?.stopCause, "timeout");
    assert.ok(row?.signalsAttempted === "term" || row?.signalsAttempted === "term-kill");
    assert.equal(context.eventStore.gateEvidenceForAttempt(attempt.attemptId), undefined);
    assert.equal(context.eventStore.capabilityByAttempt(attempt.attemptId)?.state, "issued");
    assert.equal(vnextGateHold(context.eventStore.path, run.runId)?.state, "unsettled");
    assert.equal(vnextActiveScheduledRuns(context.eventStore.path), 1);
  });

  const ignoreTerm = [NODE, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e9)"];
  await withS4({ argv: ignoreTerm, timeoutMs: 200 }, async ({ context, bundle }) => {
    vnextCommandGateSeams.timing = { termGraceMs: 80, finalWaitMs: 120, lingerMs: 80 };
    const run = acceptReady(context, bundle, "gate-command-ready", "kill");
    const result = await stepVnextRun(context, run.runId, producer());
    assert.equal(result.handoff?.detail, "timeout");
    const { row } = observation(context, run.runId);
    assert.equal(row?.signalsAttempted, "term-kill");
  });

  await withS4({
    argv: [NODE, "-e", "process.on('SIGTERM', () => process.exit(0)); require('fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1e9);"],
    timeoutMs: 400,
  }, async ({ root, context, bundle }) => {
    vnextCommandGateSeams.timing = { termGraceMs: 400, finalWaitMs: 120, lingerMs: 120 };
    const ready = join(root, "term-ready");
    writeGates(root, {
      argv: [NODE, "-e", "process.on('SIGTERM', () => process.exit(0)); require('fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1e9);", ready],
      timeoutMs: 400,
    });
    const bundle2 = loadVnextProject(root);
    const run = acceptReady(context, bundle2, "gate-command-ready", "exit0-grace");
    const pending = stepVnextRun(context, run.runId, producer());
    await waitForPath(ready);
    const result = await pending;
    assert.equal(result.handoff?.reason, "attempt_unsettled");
    assert.equal(result.handoff?.detail, "timeout");
    const { row } = observation(context, run.runId);
    assert.equal(row?.completeness, "incomplete");
    assert.equal(row?.exitCode, 0);
    assert.equal(row?.signal, null);
    assert.equal(context.eventStore.gateEvidenceForAttempt(row!.attemptId), undefined);
    void bundle;
  });
});

test("S4 external SIGTERM is signal-termination and never evaluated pass", async () => {
  await withS4({ argv: [NODE, "-e", "setImmediate(() => process.kill(process.pid, 'SIGTERM'))"] }, async ({ context, bundle }) => {
    const run = acceptReady(context, bundle, "gate-command-expect-fail", "self-term");
    const result = await stepVnextRun(context, run.runId, producer());
    assert.equal(result.handoff?.reason, "attempt_unsettled");
    assert.equal(result.handoff?.detail, "signal-termination");
    const { row } = observation(context, run.runId);
    assert.equal(row?.completeness, "incomplete");
    assert.equal(row?.signal, "SIGTERM");
    assert.equal(row?.exitCode, null);
    assert.equal(context.eventStore.gateEvidenceForAttempt(row!.attemptId), undefined);
  });
});

test("S4 delayed close still records a complete observation", async () => {
  await withS4({ argv: [NODE, "-e", "setTimeout(() => process.exit(0), 50)"] }, async ({ context, bundle }) => {
    const run = acceptReady(context, bundle, "gate-command-ready", "delayed-close");
    const result = await driveVnextRun(context, run.runId, producer());
    assert.equal(result.state.status, "completed");
    const { row } = observation(context, run.runId);
    assert.equal(row?.closeObserved, 1);
    assert.equal(row?.completeness, "complete");
  });
});

test("S4 same-group descendant is stopped with the group; detached grandchild is not assumed killed", { timeout: 15_000 }, async () => {
  const childPidPath = "child.pid";
  await withS4({
    argv: [NODE, "-e", `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1e9)", process.argv[1]], { stdio: ["ignore", "inherit", "inherit"], detached: false });
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1e9);
`],
    timeoutMs: 250,
  }, async ({ root, context, bundle }) => {
    vnextCommandGateSeams.timing = { termGraceMs: 120, finalWaitMs: 200, lingerMs: 120 };
    const descendant = join(root, childPidPath);
    const parent = join(root, "parent.pid");
    writeGates(root, {
      argv: [NODE, "-e", `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1e9)", process.argv[1]], { stdio: ["ignore", "inherit", "inherit"], detached: false });
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1e9);
`, descendant, parent],
      timeoutMs: 250,
    });
    const bundle2 = loadVnextProject(root);
    const run = acceptReady(context, bundle2, "gate-command-ready", "same-group");
    const result = await stepVnextRun(context, run.runId, producer());
    assert.equal(result.handoff?.reason, "attempt_unsettled");
    await waitForPath(descendant, 500).catch(() => undefined);
    if (existsSync(descendant)) {
      const pid = Number(await import("node:fs").then((fs) => fs.readFileSync(descendant, "utf8")));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (alive) killPid(pid);
      assert.equal(alive, false, "same-group descendant must not survive group stop");
    }
    void bundle;
  });

  await withS4({ argv: emptyScript(0), timeoutMs: 3_600_000 }, async ({ root, context, bundle }) => {
    vnextCommandGateSeams.timing = { termGraceMs: 80, finalWaitMs: 80, lingerMs: 80 };
    const grandchildPid = join(root, "grandchild.pid");
    writeGates(root, {
      argv: [NODE, "-e", `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: ["ignore", "inherit", "inherit"], detached: true });
writeFileSync(process.argv[1], String(child.pid));
child.unref();
process.exit(0);
`, grandchildPid],
    });
    const bundle2 = loadVnextProject(root);
    const run = acceptReady(context, bundle2, "gate-command-ready", "detached-grandchild");
    const result = await stepVnextRun(context, run.runId, producer());
    assert.equal(result.handoff?.reason, "attempt_unsettled");
    assert.equal(result.handoff?.detail, "lost-close");
    const { row } = observation(context, run.runId);
    assert.equal(row?.completeness, "incomplete");
    assert.equal(row?.exitCode, 0);
    assert.equal(row?.closeObserved, 0);
    assert.equal(row?.stdoutComplete, 0);
    await waitForPath(grandchildPid);
    const pid = Number((await import("node:fs")).readFileSync(grandchildPid, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    assert.equal(alive, true, "detached grandchild is a separate group and is not assumed killed");
    killPid(pid);
    void bundle;
  });
});

test("S4 recording failures distinguish rollback from committed proof", async () => {
  await withS4({ argv: [NODE, "-e", "setInterval(() => {}, 1e9)"], timeoutMs: 200 }, async ({ context, bundle }) => {
    vnextCommandGateSeams.timing = { termGraceMs: 80, finalWaitMs: 80, lingerMs: 80 };
    const run = acceptReady(context, bundle, "gate-command-ready", "spawn-record-rollback");
    let holdAtStop: string | undefined;
    vnextGateDispatchSeams.afterSpawnRecord = () => {
      throw new Error("spawn record rolled back");
    };
    vnextCommandGateSeams.afterStopRequested = () => {
      holdAtStop = vnextGateHold(context.eventStore.path, run.runId)?.state;
    };
    const result = await stepVnextRun(context, run.runId, producer());
    assert.equal(result.handoff?.reason, "attempt_unsettled");
    assert.equal(result.handoff?.detail, "recording-error");
    assert.equal(holdAtStop, "unsettled");
    const { row } = observation(context, run.runId);
    assert.equal(row?.completeness, "incomplete");
    assert.equal(row?.errorClass, "recording-error");
    assert.equal(context.eventStore.events(run.runId, 0, 10_000).some((event) => event.eventType === "effect.dispatched"), false);
    assert.equal(vnextGateHold(context.eventStore.path, run.runId)?.state, "unsettled");
  });

  await withS4({ argv: [NODE, "-e", "setInterval(() => {}, 1e9)"], timeoutMs: 200, maxConcurrentRuns: 2 }, async ({ context, bundle }) => {
    vnextCommandGateSeams.timing = { termGraceMs: 80, finalWaitMs: 80, lingerMs: 80 };
    vnextGateDispatchSeams.afterUncertaintyWrite = () => {
      throw new Error("uncertainty rolled back");
    };
    const run = acceptReady(context, bundle, "gate-command-ready", "uncertain-fail");
    await assert.rejects(() => stepVnextRun(context, run.runId, producer()), /uncertainty rolled back/);
    assert.equal(context.eventStore.gateRowCounts(run.runId).observations, 0);
    const attempt = context.eventStore.gateAttemptsForRun(run.runId)[0]!;
    assert.equal(foldStoredVnextRun(context, context.eventStore.run(run.runId)!).currentStep?.effectState, "dispatched");
    assert.equal(context.eventStore.capabilityByAttempt(attempt.attemptId)?.state, "issued");
    assert.equal(vnextGateHold(context.eventStore.path, run.runId)?.state, "unsettled");
    await assert.rejects(() => stepVnextRun(context, run.runId, producer()), /run_busy/);
    const blocked = await stepVnextRun(
      context,
      acceptReady(context, bundle, "gate-command-ready", "blocked-after-fail").runId,
      producer(),
    );
    assert.equal(blocked.handoff?.reason, "gate_recovery_pending");
    assert.equal(vnextGateHold(context.eventStore.path, run.runId)?.state, "unsettled");
  });

  await withS4({ argv: emptyScript(0) }, async ({ context, bundle }) => {
    vnextGateDispatchSeams.afterObservationWrite = () => {
      throw new Error("settlement rolled back");
    };
    const run = acceptReady(context, bundle, "gate-command-ready", "settle-rollback");
    const result = await stepVnextRun(context, run.runId, producer());
    assert.equal(result.handoff?.reason, "attempt_unsettled");
    assert.equal(result.handoff?.detail, "recording-error");
    const { row } = observation(context, run.runId);
    assert.equal(row?.completeness, "incomplete");
    assert.equal(row?.errorClass, "recording-error");
    assert.equal(typeof row?.pid, "number");
    assert.equal(row?.exitObserved, 1);
    assert.equal(context.eventStore.gateEvidenceForAttempt(row!.attemptId), undefined);
    assert.equal(vnextGateHold(context.eventStore.path, run.runId)?.state, "unsettled");
  });

  await withS4({ argv: emptyScript(0) }, async ({ context, bundle }) => {
    vnextGateDispatchSeams.beforeCommandSettle = () => {
      throw new Error("settle hook failed before write");
    };
    const run = acceptReady(context, bundle, "gate-command-ready", "settle-hook-fail");
    const result = await stepVnextRun(context, run.runId, producer());
    assert.equal(result.handoff?.reason, "attempt_unsettled");
    assert.equal(result.handoff?.detail, "recording-error");
    const { row } = observation(context, run.runId);
    assert.equal(row?.completeness, "incomplete");
    assert.equal(row?.errorClass, "recording-error");
    assert.equal(row?.exitCode, 0);
    assert.equal(row?.signal, null);
    assert.equal(row?.closeObserved, 1);
    assert.equal(context.eventStore.gateEvidenceForAttempt(row!.attemptId), undefined);
    assert.equal(vnextGateHold(context.eventStore.path, run.runId)?.state, "unsettled");
  });

  await withS4({ argv: emptyScript(0), maxConcurrentRuns: 1 }, async ({ context, bundle }) => {
    vnextGateDispatchSeams.afterSettlementCommit = () => {
      throw new Error("committed proof then failed");
    };
    const run = acceptReady(context, bundle, "gate-command-ready", "committed-proof");
    await assert.rejects(() => stepVnextRun(context, run.runId, producer()), /committed proof then failed/);
    const { row } = observation(context, run.runId);
    const evidence = context.eventStore.gateEvidenceForAttempt(row!.attemptId);
    assert.equal(row?.completeness, "complete");
    assert.equal(context.eventStore.gateRowCounts(run.runId).observations, 1);
    assert.equal(context.eventStore.gateRowCounts(run.runId).evidence, 1);
    assert.equal(evidence?.outcome, "passed");
    assert.equal(evidence?.observationId, row?.observationId);
    assert.equal(context.eventStore.capabilityByAttempt(row!.attemptId)?.state, "settled");
    assert.equal(vnextGateHold(context.eventStore.path, run.runId), undefined);
    assert.equal(vnextActiveScheduledRuns(context.eventStore.path), 0);
    vnextGateDispatchSeams.afterSettlementCommit = undefined;
    const snapshot = {
      observationId: row!.observationId,
      contentHash: row!.contentHash,
      completeness: row!.completeness,
      evidenceId: evidence!.evidenceId,
      evidenceHash: evidence!.contentHash,
      events: context.eventStore.events(run.runId, 0, 10_000).length,
    };
    const next = acceptReady(context, bundle, "gate-command-ready", "after-committed-proof");
    const admitted = await stepVnextRun(context, next.runId, producer());
    assert.equal(admitted.state.status, "completed");
    const again = observation(context, run.runId);
    const evidenceAgain = context.eventStore.gateEvidenceForAttempt(again.row!.attemptId);
    assert.equal(again.row?.observationId, snapshot.observationId);
    assert.equal(again.row?.contentHash, snapshot.contentHash);
    assert.equal(again.row?.completeness, snapshot.completeness);
    assert.equal(evidenceAgain?.evidenceId, snapshot.evidenceId);
    assert.equal(evidenceAgain?.contentHash, snapshot.evidenceHash);
    assert.equal(context.eventStore.gateRowCounts(run.runId).observations, 1);
    assert.equal(context.eventStore.events(run.runId, 0, 10_000).length, snapshot.events);
  });
});

test("S4 committed-proof active hold finishes for proof-only settlement and wakes the scheduler queue", async () => {
  await withS4({ argv: ["/no/such/kxm-s4-command"], maxConcurrentRuns: 1 }, async ({ context, bundle }) => {
    vnextGateDispatchSeams.afterSettlementCommit = () => {
      throw new Error("committed proof then failed");
    };
    const run = acceptReady(context, bundle, "gate-command-ready", "no-start-proof");
    await assert.rejects(() => stepVnextRun(context, run.runId, producer()), /committed proof then failed/);
    const { row } = observation(context, run.runId);
    assert.equal(row?.completeness, "no-start");
    assert.equal(context.eventStore.gateEvidenceForAttempt(row!.attemptId), undefined);
    assert.equal(context.eventStore.gateRowCounts(run.runId).observations, 1);
    assert.equal(context.eventStore.capabilityByAttempt(row!.attemptId)?.state, "settled");
    assert.equal(vnextGateHold(context.eventStore.path, run.runId), undefined);
    assert.equal(vnextActiveScheduledRuns(context.eventStore.path), 0);
    vnextGateDispatchSeams.afterSettlementCommit = undefined;
    const next = acceptReady(context, bundle, "gate-command-ready", "after-no-start-proof");
    const admitted = await stepVnextRun(context, next.runId, producer());
    assert.equal(admitted.state.status, "failed");
    assert.equal(vnextGateHold(context.eventStore.path, next.runId), undefined);
    assert.equal(context.eventStore.gateRowCounts(run.runId).observations, 1);
  });

  await withS4({ argv: emptyScript(0), maxConcurrentRuns: 1 }, async ({ context, bundle }) => {
    const run = acceptReady(context, bundle, "gate-command-ready", "cancel-proof");
    vnextGateDispatchSeams.afterSettlementCommit = () => {
      throw new Error("committed proof then failed");
    };
    vnextGateDispatchSeams.beforeCommandSettle = () => {
      cancelVnextRun(context, run.runId);
    };
    await assert.rejects(() => stepVnextRun(context, run.runId, producer()), /committed proof then failed/);
    const { attempt, row } = observation(context, run.runId);
    assert.equal(row?.completeness, "complete");
    assert.equal(context.eventStore.gateEvidenceForAttempt(attempt.attemptId), undefined);
    assert.equal(context.eventStore.capabilityByAttempt(attempt.attemptId)?.state, "settled");
    assert.equal(vnextGateHold(context.eventStore.path, run.runId), undefined);
    assert.equal(vnextActiveScheduledRuns(context.eventStore.path), 0);
  });

  await withS4({ argv: emptyScript(0), maxConcurrentRuns: 1 }, async ({ context, bundle }) => {
    let injected = 0;
    let queued: Promise<Awaited<ReturnType<VnextRunScheduler["enqueue"]>>> | undefined;
    const first = acceptVnextRun(context, bundle, { workflowId: "gate-command-ready", prompt: "queue-first" });
    const second = acceptVnextRun(context, bundle, { workflowId: "gate-command-ready", prompt: "queue-second" });
    pinVnextCompiledPlan(context, bundle, first.run.runId);
    pinVnextCompiledPlan(context, bundle, second.run.runId);
    const scheduler = VnextRunScheduler.for(context, bundle);
    vnextGateDispatchSeams.afterSettlementCommit = () => {
      injected += 1;
      if (injected === 1) {
        queued = scheduler.enqueue(second.run.runId, producer());
        assert.equal(vnextQueuedScheduledRuns(context.eventStore.path), 1);
        throw new Error("committed proof then failed");
      }
    };
    await assert.rejects(() => scheduler.enqueue(first.run.runId, producer()), /committed proof then failed/);
    assert.ok(queued);
    const woken = await queued;
    await Promise.resolve();
    assert.equal(woken.state.status, "completed");
    assert.equal(injected, 2);
    assert.equal(vnextGateHold(context.eventStore.path, first.run.runId), undefined);
    assert.equal(vnextActiveScheduledRuns(context.eventStore.path), 0);
    assert.equal(context.eventStore.gateRowCounts(first.run.runId).observations, 1);
  });
});

test("S4 post-commit hold stays when unsettled, mismatched, or unverifiable", async () => {
  await withS4({ argv: emptyScript(0), maxConcurrentRuns: 1 }, async ({ context, bundle }) => {
    const run = acceptReady(context, bundle, "gate-command-ready", "unsettled-after-commit");
    vnextGateDispatchSeams.afterSettlementCommit = () => {
      const hold = vnextGateHold(context.eventStore.path, run.runId);
      const token = vnextAdmittedToken(context.eventStore.path, run.runId);
      assert.equal(hold?.state, "active");
      markVnextGateHoldUnsettled(context.eventStore.path, run.runId, token!, hold!.attemptId);
      throw new Error("committed proof then failed");
    };
    await assert.rejects(() => stepVnextRun(context, run.runId, producer()), /committed proof then failed/);
    const { row } = observation(context, run.runId);
    assert.equal(row?.completeness, "complete");
    assert.equal(context.eventStore.gateRowCounts(run.runId).observations, 1);
    assert.equal(vnextGateHold(context.eventStore.path, run.runId)?.state, "unsettled");
    assert.equal(vnextActiveScheduledRuns(context.eventStore.path), 1);
    const next = acceptReady(context, bundle, "gate-command-ready", "blocked-unsettled-after-commit");
    await assert.rejects(() => stepVnextRun(context, next.runId, producer()), /run_admission_exceeded/);
  });

  await withS4({ argv: emptyScript(0), maxConcurrentRuns: 1 }, async ({ context, bundle }) => {
    const run = acceptReady(context, bundle, "gate-command-ready", "mismatch-finish");
    vnextCommandGateSeams.afterSpawned = () => {
      const hold = vnextGateHold(context.eventStore.path, run.runId);
      assert.equal(hold?.state, "active");
      assert.throws(
        () => finishVnextOwnedGate(context.eventStore.path, run.runId, "mismatched-token", hold!.attemptId),
        /owned gate finish requires the exact admitted token/,
      );
      assert.throws(
        () => finishVnextOwnedGate(context.eventStore.path, run.runId, hold!.token, "mismatched-attempt"),
        /owned gate finish does not match the armed attempt/,
      );
      assert.equal(vnextGateHold(context.eventStore.path, run.runId)?.state, "active");
    };
    const result = await stepVnextRun(context, run.runId, producer());
    assert.equal(result.state.status, "completed");
    assert.equal(vnextGateHold(context.eventStore.path, run.runId), undefined);
  });

  await withS4({ argv: emptyScript(0), maxConcurrentRuns: 1 }, async ({ context, bundle }) => {
    vnextGateDispatchSeams.afterSettlementCommit = () => {
      closeVnextRuntimeContext(context);
      throw new Error("committed proof then failed");
    };
    const run = acceptReady(context, bundle, "gate-command-ready", "closed-after-commit");
    await assert.rejects(() => stepVnextRun(context, run.runId, producer()), /committed proof then failed/);
    assert.equal(vnextGateHold(context.eventStore.path, run.runId)?.state, "unsettled");
    assert.equal(vnextActiveScheduledRuns(context.eventStore.path), 1);
  });
});

test("S4 context close during execution suppresses late writes and does not stop another context", { timeout: 15_000 }, async () => {
  const sleeper = [NODE, "-e", "setInterval(() => {}, 1e9)"];
  const { root, stateRoot } = engineProject("kxm-s4-close-", WORKFLOWS);
  try {
    writeGates(root, { argv: sleeper, timeoutMs: 3_600_000 });
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    const run = acceptReady(context, bundle, "gate-command-ready", "close-live");
    const before = context.eventStore.events(run.runId, 0, 10_000).length;
    let spawned = false;
    vnextCommandGateSeams.timing = { termGraceMs: 80, finalWaitMs: 80, lingerMs: 80 };
    vnextCommandGateSeams.afterSpawned = () => {
      spawned = true;
      closeVnextRuntimeContext(context);
    };
    const result = await stepVnextRun(context, run.runId, producer());
    assert.equal(spawned, true);
    assert.equal(result.handoff?.reason, "attempt_unsettled");
    const reopened = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const events = reopened.eventStore.events(run.runId, 0, 10_000);
      assert.equal(events.length >= before, true);
      assert.equal(reopened.eventStore.gateRowCounts(run.runId).observations, 0);
      const folded = foldStoredVnextRun(reopened, reopened.eventStore.run(run.runId)!);
      assert.ok(folded.currentStep?.effectState === "intent" || folded.currentStep?.effectState === "dispatched");
      assert.equal(vnextGateHold(reopened.eventStore.path, run.runId)?.state, "unsettled");
    } finally {
      closeVnextRuntimeContext(reopened);
    }
  } finally {
    resetSeams();
    removeTempDir(root, stateRoot);
  }

  await withS4({ argv: emptyScript(0) }, async ({ context, bundle }) => {
    const other = acceptReady(context, bundle, "gate-command-ready", "other-context");
    const result = await driveVnextRun(context, other.runId, producer());
    assert.equal(result.state.status, "completed");
  });
});

test("S4 cancel after spawn is uncertain; complete observation with revoke is proof-only", async () => {
  await withS4({ argv: [NODE, "-e", "setInterval(() => {}, 1e9)"], timeoutMs: 3_600_000 }, async ({ context, bundle }) => {
    vnextCommandGateSeams.timing = { termGraceMs: 80, finalWaitMs: 80, lingerMs: 80 };
    const run = acceptReady(context, bundle, "gate-command-ready", "cancel-after");
    vnextCommandGateSeams.afterSpawned = () => {
      cancelVnextRun(context, run.runId);
    };
    const result = await stepVnextRun(context, run.runId, producer());
    assert.equal(result.handoff?.reason, "attempt_unsettled");
    assert.equal(result.handoff?.detail, "cancel");
    assert.equal(result.state.status, "cancelling");
    const { attempt, row } = observation(context, run.runId);
    assert.equal(row?.completeness, "incomplete");
    assert.equal(row?.stopCause, "cancel");
    assert.equal(context.eventStore.capabilityByAttempt(attempt.attemptId)?.state, "revoked");
  });

  await withS4({ argv: emptyScript(0) }, async ({ context, bundle }) => {
    const run = acceptReady(context, bundle, "gate-command-ready", "proof-only");
    vnextGateDispatchSeams.beforeCommandSettle = () => {
      cancelVnextRun(context, run.runId);
    };
    const result = await stepVnextRun(context, run.runId, producer());
    assert.equal(result.state.status, "cancelled");
    const { attempt, row } = observation(context, run.runId);
    assert.equal(row?.completeness, "complete");
    assert.equal(context.eventStore.gateEvidenceForAttempt(attempt.attemptId), undefined);
    assert.equal(context.eventStore.capabilityByAttempt(attempt.attemptId)?.state, "settled");
  });
});

test("S4 restart brake: in-process busy, durable recovery pending, controller without hold is not owned", async () => {
  await withS4({ argv: [NODE, "-e", "setInterval(() => {}, 1e9)"], timeoutMs: 200 }, async ({ context, bundle }) => {
    vnextCommandGateSeams.timing = { termGraceMs: 80, finalWaitMs: 80, lingerMs: 80 };
    const run = acceptReady(context, bundle, "gate-command-ready", "unsettled");
    const result = await stepVnextRun(context, run.runId, producer());
    assert.equal(result.handoff?.reason, "attempt_unsettled");
    await assert.rejects(() => stepVnextRun(context, run.runId, producer()), /run_busy/);
    const next = acceptReady(context, bundle, "gate-command-ready", "next");
    await assert.rejects(() => stepVnextRun(context, next.runId, producer()), /run_admission_exceeded/);
    assert.equal(vnextGateHold(context.eventStore.path, run.runId)?.state, "unsettled");
  });

  await withS4({ argv: [NODE, "-e", "setInterval(() => {}, 1e9)"], timeoutMs: 200, maxConcurrentRuns: 2 }, async ({ context, bundle }) => {
    vnextCommandGateSeams.timing = { termGraceMs: 80, finalWaitMs: 80, lingerMs: 80 };
    const run = acceptReady(context, bundle, "gate-command-ready", "unsettled-spare");
    const result = await stepVnextRun(context, run.runId, producer());
    assert.equal(result.handoff?.reason, "attempt_unsettled");
    assert.equal(vnextGateHold(context.eventStore.path, run.runId)?.state, "unsettled");
    const next = acceptReady(context, bundle, "gate-command-ready", "next-spare");
    const blocked = await stepVnextRun(context, next.runId, producer());
    assert.equal(blocked.handoff?.reason, "gate_recovery_pending");
    assert.equal(vnextGateHold(context.eventStore.path, run.runId)?.state, "unsettled");
  });

  await withS4({ argv: emptyScript(0) }, async ({ context, bundle }) => {
    const run = acceptReady(context, bundle, "gate-command-ready", "controller-no-hold");
    const envelope = loadVnextRunPlanEnvelope(context.eventStore, run);
    recordGateIntent(context, run, envelope, "check");
    const attempt = context.eventStore.gateAttemptsForRun(run.runId)[0]!;
    registerVnextAttemptController(context.eventStore.path, run.runId, {
      attemptId: attempt.attemptId,
      controller: new AbortController(),
    });
    try {
      const preflight = gateRecoveryPreflight(context);
      assert.equal(preflight.owned, 0);
      assert.equal(preflight.blocking.some((item) => item.attemptId === attempt.attemptId), true);
      const next = acceptReady(context, bundle, "gate-command-ready", "blocked-no-hold");
      const blocked = await stepVnextRun(context, next.runId, producer());
      assert.equal(blocked.handoff?.reason, "gate_recovery_pending");
    } finally {
      unregisterVnextAttemptController(context.eventStore.path, run.runId, attempt.attemptId);
    }
  });
});

test("S4 declarations refuse before intent; equal timeout proceeds; timeout-only still narrows permission", async () => {
  await withS4({ argv: emptyScript(0) }, async ({ context, bundle }) => {
    const undeclared = acceptReady(context, bundle, "gate-command.yaml".replace(".yaml", ""), "no-repos");
    void undeclared;
  });

  await withS4({ argv: emptyScript(0) }, async ({ context, bundle }) => {
    const noRepos = acceptReady(context, bundle, "gate-command", "no-repos");
    const refused = await stepVnextRun(context, noRepos.runId, producer());
    assert.equal(refused.handoff?.reason, "step_unsupported");
    assert.equal(refused.handoff?.field, "repositories");
    assert.equal(context.eventStore.events(noRepos.runId, 0, 50).some((event) => event.eventType === "step.entered"), false);
    assert.equal(context.eventStore.gateRowCounts(noRepos.runId).attempts, 0);

    const narrow = acceptReady(context, bundle, "gate-command-timeout-narrow", "narrow");
    const narrowResult = await stepVnextRun(context, narrow.runId, producer());
    assert.equal(narrowResult.handoff?.reason, "step_unsupported");
    assert.equal(narrowResult.handoff?.field, "timeoutMs");
    assert.equal(context.eventStore.gateRowCounts(narrow.runId).attempts, 0);

    const equal = acceptReady(context, bundle, "gate-command-timeout-equal", "equal");
    const equalResult = await stepVnextRun(context, equal.runId, producer());
    assert.equal(equalResult.state.status, "completed");

    const artifactsTimeout = acceptReady(context, bundle, "artifacts-gate", "artifacts-timeout");
    void artifactsTimeout;
  });

  const { root, stateRoot } = engineProject("kxm-s4-perm-", WORKFLOWS);
  try {
    writeGates(root, { argv: ["npm", "test"], timeoutMs: 3_600_000 });
    const base = loadVnextProject(root);
    writeGates(root, { argv: ["npm", "test"], timeoutMs: 1000 });
    const narrowed = loadVnextProject(root);
    const diff = computeVnextPermissionDiff(base, narrowed);
    assert.equal(diff.expansions.length, 0);
    assert.equal(diff.narrowings.length, 1);
    assert.notEqual(base.configRevision, narrowed.configRevision);
    assert.notEqual(vnextToolPolicyRevision(base), vnextToolPolicyRevision(narrowed));
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("S4 complete rows carry no raw stdout/stderr text keys", async () => {
  await withS4({ argv: emptyScript(0) }, async ({ context, bundle }) => {
    const run = acceptReady(context, bundle, "gate-command-ready", "keys");
    await driveVnextRun(context, run.runId, producer());
    const { row } = observation(context, run.runId);
    assertNoRawText(row!);
    assert.equal(vnextCanonicalJson(row as never).includes("hello"), false);
  });
});

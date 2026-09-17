import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { removeTempDir } from "../helpers.ts";
import { engineProject } from "../helpers/project.ts";
import { loadKxmProject, validateRunEvent } from "../../plugins/kxm/src/project-config.ts";
import { kxmCanonicalJson } from "../../plugins/kxm/src/project-config.ts";
import { kxmArtifactsGateSeams } from "../../plugins/kxm/src/engine-artifacts.ts";
import {
  recordGateCancelObserved,
  recordGateIntent,
  recordGateNoStart,
  recordGateUncertain,
  type KxmGateObservationInput,
} from "../../plugins/kxm/src/engine-gate-records.ts";
import { loadKxmRunPlanEnvelope } from "../../plugins/kxm/src/engine-plan.ts";
import {
  KxmRunScheduler,
  createKxmSimulatedProducer,
  driveKxmRun,
  gateRecoveryPreflight,
  pinKxmCompiledPlan,
  startKxmRun,
  stepKxmRun,
  kxmGateDispatchSeams,
} from "../../plugins/kxm/src/engine.ts";
import {
  registerKxmAttemptController,
  unregisterKxmAttemptController,
  kxmActiveScheduledRuns,
} from "../../plugins/kxm/src/runtime-owner.ts";
import {
  gateRowContentHash,
  newKxmAssignmentId,
  newKxmAttemptId,
  type KxmRunRecord,
} from "../../plugins/kxm/src/runtime-store.ts";
import {
  acceptKxmRun,
  closeKxmRuntimeContext,
  foldStoredKxmRun,
  openKxmRuntimeContext,
  type KxmRuntimeContext,
} from "../../plugins/kxm/src/runtime-service.ts";

const HOME = "rtm_01JENGINE00000000000000000";
const WORKFLOWS = [
  "agent-only.yaml",
  "unsupported-gate.yaml",
  "one-step.yaml",
  "gate-command.yaml",
  "artifacts-gate.yaml",
  "artifacts-ready.yaml",
  "artifacts-multi.yaml",
  "gate-command-ready.yaml",
];

function s3Project(prefix: string) {
  const created = engineProject(prefix, WORKFLOWS);
  writeFileSync(join(created.root, ".kxm", "gates.yaml"), `schema: kxm.gate-registry.v1
gates:
  test:
    kind: command
    argv: [npm, test]
    timeoutMs: 3600000
  artifacts:
    kind: artifacts-exist
    paths: [dist/index.js]
  artifacts-multi:
    kind: artifacts-exist
    paths: [keep/a.txt, keep/b.txt]
`);
  return created;
}

function producer() {
  return createKxmSimulatedProducer(async () => ({ outcome: "passed" }));
}

function writeAsset(root: string, relative: string, body = "ok\n"): void {
  const full = join(root, ".kxm", "assets", relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function sql(path: string, work: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path);
  try {
    work(db);
  } finally {
    db.close();
  }
}

function noStartProof(): KxmGateObservationInput {
  const now = new Date().toISOString();
  return {
    completeness: "no-start",
    spawned: 0,
    pid: null,
    exitCode: null,
    signal: null,
    exitObserved: 0,
    closeObserved: 0,
    stopCause: "none",
    signalsAttempted: "none",
    errorClass: "validation",
    stdoutSha256: null,
    stdoutBytes: null,
    stdoutComplete: null,
    stderrSha256: null,
    stderrBytes: null,
    stderrComplete: null,
    checkedCount: null,
    failedCount: null,
    elapsedMs: 1,
    startedAt: now,
    finishedAt: now,
  };
}

function artifactsComplete(): KxmGateObservationInput {
  const now = new Date().toISOString();
  return {
    completeness: "complete",
    spawned: 0,
    pid: null,
    exitCode: null,
    signal: null,
    exitObserved: 0,
    closeObserved: 0,
    stopCause: "none",
    signalsAttempted: "none",
    errorClass: null,
    stdoutSha256: null,
    stdoutBytes: null,
    stdoutComplete: null,
    stderrSha256: null,
    stderrBytes: null,
    stderrComplete: null,
    checkedCount: 1,
    failedCount: 0,
    elapsedMs: 3,
    startedAt: now,
    finishedAt: now,
  };
}

function incompleteProof(): KxmGateObservationInput {
  const now = new Date().toISOString();
  return {
    completeness: "incomplete",
    spawned: 1,
    pid: 9,
    exitCode: null,
    signal: "SIGTERM",
    exitObserved: 0,
    closeObserved: 0,
    stopCause: "error",
    signalsAttempted: "term",
    errorClass: "stop-error",
    stdoutSha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    stdoutBytes: 1,
    stdoutComplete: 0,
    stderrSha256: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    stderrBytes: 0,
    stderrComplete: 0,
    checkedCount: null,
    failedCount: null,
    elapsedMs: 50,
    startedAt: now,
    finishedAt: null,
  };
}

async function withS3(
  fn: (args: {
    root: string;
    context: KxmRuntimeContext;
    bundle: ReturnType<typeof loadKxmProject>;
  }) => Promise<void> | void,
): Promise<void> {
  const { root, stateRoot } = s3Project("kxm-s3-");
  try {
    const bundle = loadKxmProject(root);
    const context = openKxmRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      await fn({ root, context, bundle });
    } finally {
      closeKxmRuntimeContext(context);
      kxmArtifactsGateSeams.afterPathChecked = undefined;
      kxmGateDispatchSeams.afterEvaluate = undefined;
      kxmGateDispatchSeams.afterObservationWrite = undefined;
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
}

function acceptReady(
  context: KxmRuntimeContext,
  bundle: ReturnType<typeof loadKxmProject>,
  workflowId: string,
  prompt: string,
) {
  const accepted = acceptKxmRun(context, bundle, { workflowId, prompt });
  pinKxmCompiledPlan(context, bundle, accepted.run.runId);
  startKxmRun(context, accepted.run.runId);
  return accepted.run;
}

test("S3 artifacts pass, fail, multi-path, missing root, and containment", async () => {
  await withS3(async ({ root, context, bundle }) => {
    writeAsset(root, "dist/index.js");
    const passed = acceptReady(context, bundle, "artifacts-ready", "pass");
    const driven = await driveKxmRun(context, passed.runId, producer());
    assert.equal(driven.state.status, "completed");
    const passObs = context.eventStore.gateObservationForAttempt(context.eventStore.gateAttemptsForRun(passed.runId)[0]!.attemptId)!;
    assert.equal(passObs.completeness, "complete");
    assert.equal(passObs.checkedCount, 1);
    assert.equal(passObs.failedCount, 0);
    assert.equal(passObs.spawned, 0);
    assert.ok(passObs.startedAt <= passObs.finishedAt!);
    assert.ok(typeof passObs.elapsedMs === "number" && passObs.elapsedMs >= 0);

    rmSync(join(root, ".kxm", "assets", "dist", "index.js"));
    const failed = acceptReady(context, bundle, "artifacts-ready", "fail");
    const missing = await driveKxmRun(context, failed.runId, producer());
    assert.equal(missing.state.status, "failed");
    const failObs = context.eventStore.gateObservationForAttempt(context.eventStore.gateAttemptsForRun(failed.runId)[0]!.attemptId)!;
    assert.equal(failObs.checkedCount, 1);
    assert.equal(failObs.failedCount, 1);

    writeAsset(root, "keep/a.txt");
    const mixed = acceptReady(context, bundle, "artifacts-multi", "mixed");
    const mixedResult = await driveKxmRun(context, mixed.runId, producer());
    assert.equal(mixedResult.state.status, "failed");
    const mixedObs = context.eventStore.gateObservationForAttempt(context.eventStore.gateAttemptsForRun(mixed.runId)[0]!.attemptId)!;
    assert.equal(mixedObs.checkedCount, 2);
    assert.equal(mixedObs.failedCount, 1);

    writeAsset(root, "keep/b.txt");
    const both = acceptReady(context, bundle, "artifacts-multi", "both");
    const bothResult = await driveKxmRun(context, both.runId, producer());
    assert.equal(bothResult.state.status, "completed");

    const outside = join(tmpdir(), "kxm-s3-outside.txt");
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, join(root, ".kxm", "assets", "keep", "escape"));
    writeFileSync(join(root, ".kxm", "gates.yaml"), `schema: kxm.gate-registry.v1
gates:
  test:
    kind: command
    argv: [npm, test]
    timeoutMs: 3600000
  artifacts:
    kind: artifacts-exist
    paths: [dist/index.js]
  artifacts-multi:
    kind: artifacts-exist
    paths: [keep/a.txt, keep/escape]
`);
    const drifted = loadKxmProject(root);
    const leak = acceptKxmRun(context, drifted, { workflowId: "artifacts-multi", prompt: "escape" });
    pinKxmCompiledPlan(context, drifted, leak.run.runId);
    startKxmRun(context, leak.run.runId);
    const leaked = await driveKxmRun(context, leak.run.runId, producer());
    assert.equal(leaked.state.status, "failed");
    const leakObs = context.eventStore.gateObservationForAttempt(context.eventStore.gateAttemptsForRun(leak.run.runId)[0]!.attemptId)!;
    assert.equal(leakObs.checkedCount, 2);
    assert.equal(leakObs.failedCount, 1);
  });

  await withS3(async ({ context, bundle }) => {
    const run = acceptReady(context, bundle, "artifacts-ready", "no-root");
    const result = await driveKxmRun(context, run.runId, producer());
    assert.equal(result.state.status, "failed");
    const observation = context.eventStore.gateObservationForAttempt(context.eventStore.gateAttemptsForRun(run.runId)[0]!.attemptId)!;
    assert.equal(observation.completeness, "complete");
    assert.equal(observation.checkedCount, 1);
    assert.equal(observation.failedCount, 1);
  });
});

test("S3 artifacts dispatch writes exact rows, events, and replay bytes", async () => {
  await withS3(async ({ root, context, bundle }) => {
    writeAsset(root, "dist/index.js");
    const run = acceptReady(context, bundle, "artifacts-ready", "replay");
    const driven = await driveKxmRun(context, run.runId, producer());
    const events = context.eventStore.events(run.runId, 0, 10_000);
    for (const event of events) validateRunEvent(event, "run-event");
    assert.equal(events.some((event) => event.eventType === "effect.intent_recorded"), true);
    assert.equal(events.some((event) => event.eventType === "effect.dispatched"), true);
    assert.equal(events.some((event) => event.eventType === "effect.observed"), true);
    assert.equal(events.some((event) => event.eventType === "effect.settled"), true);
    const counts = context.eventStore.gateRowCounts(run.runId);
    assert.deepEqual(counts, { attempts: 1, observations: 1, evidence: 1 });
    const attempt = context.eventStore.gateAttemptsForRun(run.runId)[0]!;
    assert.equal(attempt.producerId, "kxm-gate");
    assert.equal(attempt.gateKind, "artifacts-exist");
    const observation = context.eventStore.gateObservationForAttempt(attempt.attemptId)!;
    assert.equal(gateRowContentHash("gate_observations", observation), observation.contentHash);
    const stored = context.eventStore.runState(run.runId)!.state;
    assert.equal(kxmCanonicalJson(foldStoredKxmRun(context, context.eventStore.run(run.runId)!) as never), stored);
    assert.equal(driven.state.status, "completed");
  });
});

test("S3 drive, step, and scheduler share a single admission token", async () => {
  await withS3(async ({ root, context, bundle }) => {
    writeAsset(root, "dist/index.js");
    const stepped = acceptReady(context, bundle, "artifacts-ready", "step");
    const stepResult = await stepKxmRun(context, stepped.runId, producer());
    assert.equal(stepResult.state.status, "completed");
    assert.equal(kxmActiveScheduledRuns(context.eventStore.path), 0);

    const scheduled = acceptKxmRun(context, bundle, { workflowId: "artifacts-ready", prompt: "sched" });
    pinKxmCompiledPlan(context, bundle, scheduled.run.runId);
    const scheduler = KxmRunScheduler.for(context, bundle);
    let seen = 0;
    kxmGateDispatchSeams.afterEvaluate = () => {
      seen = kxmActiveScheduledRuns(context.eventStore.path);
    };
    const result = await scheduler.enqueue(scheduled.run.runId, producer());
    await Promise.resolve();
    assert.equal(result.state.status, "completed");
    assert.equal(seen, 1);
    assert.equal(kxmActiveScheduledRuns(context.eventStore.path), 0);
  });
});

test("S3 declaration refusals happen before intent", async () => {
  await withS3(async ({ context, bundle }) => {
    const undeclared = acceptReady(context, bundle, "artifacts-gate", "no-repos");
    const blocked = await stepKxmRun(context, undeclared.runId, producer());
    assert.equal(blocked.handoff?.reason, "step_unsupported");
    assert.equal(blocked.handoff?.field, "repositories");
    assert.equal(context.eventStore.events(undeclared.runId, 0, 50).some((event) => event.eventType === "step.entered"), false);
    assert.equal(context.eventStore.gateRowCounts(undeclared.runId).attempts, 0);

    const outcomes = acceptReady(context, bundle, "unsupported-gate", "outcomes");
    const undeclaredOutcomes = await stepKxmRun(context, outcomes.runId, producer());
    assert.equal(undeclaredOutcomes.handoff?.reason, "step_unsupported");
    assert.equal(context.eventStore.events(outcomes.runId, 0, 50).some((event) => event.eventType === "step.entered"), false);
  });
});

test("S3 recovery scan inspects more than 50 issued histories without a row limit", async () => {
  await withS3(async ({ context, bundle }) => {
    const intents: KxmRunRecord[] = [];
    for (let index = 0; index < 51; index += 1) {
      const run = acceptReady(context, bundle, "artifacts-gate", `hist-${index}`);
      const envelope = loadKxmRunPlanEnvelope(context.eventStore, run);
      recordGateIntent(context, run, envelope, "check");
      intents.push(run);
    }
    assert.equal(context.eventStore.issuedOrRevokedCapabilities().filter((row) => row.producerId === "kxm-gate").length, 51);
    const command = acceptReady(context, bundle, "gate-command-ready", "blocked-by-histories");
    const blocked = await stepKxmRun(context, command.runId, producer());
    assert.equal(blocked.handoff?.reason, "gate_recovery_pending");
    assert.equal(blocked.handoff?.detail, "51 unfinished gate attempt(s) in project");
    const preflight = gateRecoveryPreflight(context);
    assert.equal(preflight.blocking.length, 51);
    assert.equal(preflight.owned, 0);
    assert.equal(intents.length, 51);
  });
});

test("S3 orphan capability, missing row, pin and identity corruption fail closed", async () => {
  await withS3(async ({ context, bundle }) => {
    const orphanRun = acceptReady(context, bundle, "artifacts-gate", "orphan");
    context.eventStore.insertCapability({
      attemptId: newKxmAttemptId(),
      runId: orphanRun.runId,
      assignmentId: newKxmAssignmentId(),
      stepId: "check",
      stepAttempt: 1,
      producerId: "kxm-gate",
      capabilityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      state: "issued",
    });
    assert.throws(() => gateRecoveryPreflight(context), /gate_recovery_corrupt[\s\S]*missing gate_attempts row/);
  });

  await withS3(async ({ context, bundle }) => {
    context.eventStore.insertCapability({
      attemptId: newKxmAttemptId(),
      runId: acceptReady(context, bundle, "artifacts-gate", "unknown-producer").runId,
      assignmentId: newKxmAssignmentId(),
      stepId: "check",
      stepAttempt: 1,
      producerId: "unknown-producer",
      capabilityHash: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      state: "issued",
    });
    assert.throws(() => gateRecoveryPreflight(context), /gate_recovery_corrupt[\s\S]*unknown capability producer/);
  });

  await withS3(async ({ context, bundle }) => {
    const pinRun = acceptReady(context, bundle, "artifacts-gate", "pin");
    const pinEnvelope = loadKxmRunPlanEnvelope(context.eventStore, pinRun);
    recordGateIntent(context, pinRun, pinEnvelope, "check");
    sql(context.eventStore.path, (db) => {
      const row = db.prepare("SELECT attempt_id FROM gate_attempts WHERE run_id = ?").get(pinRun.runId) as { attempt_id: string };
      const mapped = context.eventStore.gateAttempt(row.attempt_id)!;
      mapped.runPlanHash = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
      mapped.contentHash = gateRowContentHash("gate_attempts", { ...mapped, contentHash: "" });
      db.prepare("UPDATE gate_attempts SET run_plan_hash = ?, content_hash = ? WHERE attempt_id = ?").run(
        mapped.runPlanHash,
        mapped.contentHash,
        mapped.attemptId,
      );
    });
    assert.throws(() => gateRecoveryPreflight(context), /gate_recovery_corrupt[\s\S]*fold error/);
  });

  await withS3(async ({ context, bundle }) => {
    const idRun = acceptReady(context, bundle, "artifacts-gate", "identity");
    const idEnvelope = loadKxmRunPlanEnvelope(context.eventStore, idRun);
    recordGateIntent(context, idRun, idEnvelope, "check");
    sql(context.eventStore.path, (db) => {
      db.prepare("UPDATE attempt_capabilities SET assignment_id = ? WHERE run_id = ?").run(
        newKxmAssignmentId(),
        idRun.runId,
      );
    });
    assert.throws(() => gateRecoveryPreflight(context), /gate_recovery_corrupt[\s\S]*identity does not match/);
  });
});

test("S3 unfinished gate recovery cannot be hidden by simulated producer or settled capability state", async () => {
  await withS3(async ({ context, bundle }) => {
    const run = acceptReady(context, bundle, "artifacts-gate", "hide-producer");
    const envelope = loadKxmRunPlanEnvelope(context.eventStore, run);
    recordGateIntent(context, run, envelope, "check");
    sql(context.eventStore.path, (db) => {
      db.prepare("UPDATE attempt_capabilities SET producer_id = 'driver-simulated' WHERE run_id = ?").run(run.runId);
    });
    assert.throws(() => gateRecoveryPreflight(context), /gate_recovery_corrupt[\s\S]*producer contradicts gate attempt/);
    const command = acceptReady(context, bundle, "gate-command-ready", "after-producer-hide");
    await assert.rejects(
      () => stepKxmRun(context, command.runId, producer()),
      /gate_recovery_corrupt[\s\S]*producer contradicts gate attempt/,
    );
  });

  await withS3(async ({ context, bundle }) => {
    const run = acceptReady(context, bundle, "artifacts-gate", "hide-settled");
    const envelope = loadKxmRunPlanEnvelope(context.eventStore, run);
    recordGateIntent(context, run, envelope, "check");
    sql(context.eventStore.path, (db) => {
      db.prepare("UPDATE attempt_capabilities SET state = 'settled' WHERE run_id = ?").run(run.runId);
    });
    assert.throws(
      () => gateRecoveryPreflight(context),
      /gate_recovery_corrupt[\s\S]*missing issued or revoked kxm-gate capability/,
    );
    const command = acceptReady(context, bundle, "gate-command-ready", "after-settled-hide");
    await assert.rejects(
      () => stepKxmRun(context, command.runId, producer()),
      /gate_recovery_corrupt[\s\S]*missing issued or revoked kxm-gate capability/,
    );
  });
});

test("S3 legitimate settled gate history is excluded from recovery without false blocks", async () => {
  await withS3(async ({ root, context, bundle }) => {
    writeAsset(root, "dist/index.js");
    const settledRun = acceptReady(context, bundle, "artifacts-ready", "settled-history");
    const driven = await driveKxmRun(context, settledRun.runId, producer());
    assert.equal(driven.state.status, "completed");
    const afterSettled = gateRecoveryPreflight(context);
    assert.equal(afterSettled.blocking.length, 0);
    assert.equal(afterSettled.owned, 0);
    writeFileSync(join(root, ".kxm", "gates.yaml"), `schema: kxm.gate-registry.v1
gates:
  test:
    kind: command
    argv: ${JSON.stringify([process.execPath, "-e", "process.exit(0)"])}
    timeoutMs: 3600000
  artifacts:
    kind: artifacts-exist
    paths: [dist/index.js]
  artifacts-multi:
    kind: artifacts-exist
    paths: [keep/a.txt, keep/b.txt]
`);
    const commandBundle = loadKxmProject(root);
    const command = acceptReady(context, commandBundle, "gate-command-ready", "after-settled-history");
    const allowed = await stepKxmRun(context, command.runId, producer());
    assert.notEqual(allowed.handoff?.reason, "gate_recovery_pending");
    assert.equal(allowed.state.status, "completed");
    assert.equal(context.eventStore.gateAttemptsForRun(command.runId).length, 1);

    const unownedRun = acceptReady(context, bundle, "artifacts-gate", "unfinished-after-settled");
    const unownedEnvelope = loadKxmRunPlanEnvelope(context.eventStore, unownedRun);
    recordGateIntent(context, unownedRun, unownedEnvelope, "check");
    const mixed = gateRecoveryPreflight(context);
    assert.equal(mixed.blocking.length, 1);
    assert.equal(mixed.blocking[0]?.runId, unownedRun.runId);
    assert.equal(mixed.owned, 0);
  });
});

test("S3 terminal no-start and cancelled proof are validated before exclusion", async () => {
  await withS3(async ({ context, bundle }) => {
    const noStartRun = acceptReady(context, bundle, "artifacts-gate", "no-start");
    const noStartEnvelope = loadKxmRunPlanEnvelope(context.eventStore, noStartRun);
    recordGateIntent(context, noStartRun, noStartEnvelope, "check");
    recordGateNoStart(context, noStartRun, noStartEnvelope, "check", noStartProof());
    sql(context.eventStore.path, (db) => {
      db.prepare("UPDATE attempt_capabilities SET state = 'issued' WHERE run_id = ?").run(noStartRun.runId);
    });
    const afterNoStart = gateRecoveryPreflight(context);
    assert.equal(afterNoStart.blocking.some((item) => item.runId === noStartRun.runId), false);

    const cancelRun = acceptReady(context, bundle, "artifacts-gate", "cancel-proof");
    const cancelEnvelope = loadKxmRunPlanEnvelope(context.eventStore, cancelRun);
    recordGateIntent(context, cancelRun, cancelEnvelope, "check");
    recordGateCancelObserved(context, cancelRun, cancelEnvelope, "check", artifactsComplete());
    sql(context.eventStore.path, (db) => {
      db.prepare("UPDATE attempt_capabilities SET state = 'revoked' WHERE run_id = ?").run(cancelRun.runId);
    });
    const afterCancel = gateRecoveryPreflight(context);
    assert.equal(afterCancel.blocking.some((item) => item.runId === cancelRun.runId), false);

    const broken = acceptReady(context, bundle, "artifacts-gate", "broken-proof");
    const brokenEnvelope = loadKxmRunPlanEnvelope(context.eventStore, broken);
    recordGateIntent(context, broken, brokenEnvelope, "check");
    recordGateNoStart(context, broken, brokenEnvelope, "check", noStartProof());
    sql(context.eventStore.path, (db) => {
      const observation = db.prepare("SELECT observation_id FROM gate_observations WHERE run_id = ?").get(broken.runId) as { observation_id: string };
      db.prepare("DELETE FROM gate_observations WHERE observation_id = ?").run(observation.observation_id);
      db.prepare("UPDATE attempt_capabilities SET state = 'issued' WHERE run_id = ?").run(broken.runId);
    });
    assert.throws(() => gateRecoveryPreflight(context), /gate_recovery_corrupt/);
  });
});

test("S3 owned exact controller is ordinary concurrency; unowned and uncertain block", async () => {
  await withS3(async ({ context, bundle }) => {
    const ownedRun = acceptReady(context, bundle, "artifacts-gate", "owned");
    const ownedEnvelope = loadKxmRunPlanEnvelope(context.eventStore, ownedRun);
    recordGateIntent(context, ownedRun, ownedEnvelope, "check");
    const ownedAttempt = context.eventStore.gateAttemptsForRun(ownedRun.runId)[0]!;
    registerKxmAttemptController(context.eventStore.path, ownedRun.runId, {
      attemptId: "atm_01JMISMATCH0000000000000",
      controller: new AbortController(),
    });
    try {
      const mismatched = gateRecoveryPreflight(context);
      assert.equal(mismatched.owned, 0);
      assert.equal(mismatched.blocking.some((item) => item.attemptId === ownedAttempt.attemptId), true);
    } finally {
      unregisterKxmAttemptController(context.eventStore.path, ownedRun.runId, "atm_01JMISMATCH0000000000000");
    }
    registerKxmAttemptController(context.eventStore.path, ownedRun.runId, {
      attemptId: ownedAttempt.attemptId,
      controller: new AbortController(),
    });
    try {
      const owned = gateRecoveryPreflight(context);
      assert.equal(owned.owned, 1);
      assert.equal(owned.blocking.length, 0);
    } finally {
      unregisterKxmAttemptController(context.eventStore.path, ownedRun.runId, ownedAttempt.attemptId);
    }

    const unownedRun = acceptReady(context, bundle, "artifacts-gate", "unowned");
    const unownedEnvelope = loadKxmRunPlanEnvelope(context.eventStore, unownedRun);
    recordGateIntent(context, unownedRun, unownedEnvelope, "check");
    const unowned = gateRecoveryPreflight(context);
    assert.equal(unowned.blocking.some((item) => item.runId === unownedRun.runId), true);
    const blocked = await stepKxmRun(context, acceptReady(context, bundle, "gate-command-ready", "while-unowned").runId, producer());
    assert.equal(blocked.handoff?.reason, "gate_recovery_pending");

    const uncertainRun = acceptReady(context, bundle, "gate-command", "uncertain");
    const uncertainEnvelope = loadKxmRunPlanEnvelope(context.eventStore, uncertainRun);
    recordGateIntent(context, uncertainRun, uncertainEnvelope, "check");
    recordGateUncertain(context, uncertainRun, uncertainEnvelope, "check", "timeout", incompleteProof());
    const uncertainAttempt = context.eventStore.gateAttemptsForRun(uncertainRun.runId)[0]!;
    registerKxmAttemptController(context.eventStore.path, uncertainRun.runId, {
      attemptId: uncertainAttempt.attemptId,
      controller: new AbortController(),
    });
    try {
      const uncertain = gateRecoveryPreflight(context);
      assert.equal(uncertain.blocking.some((item) => item.runId === uncertainRun.runId), true);
      assert.equal(uncertain.owned, 0);
    } finally {
      unregisterKxmAttemptController(context.eventStore.path, uncertainRun.runId, uncertainAttempt.attemptId);
    }
  });
});

test("S3 partial-check throw retains T1 and does not manufacture no-start", async () => {
  await withS3(async ({ root, context, bundle }) => {
    writeAsset(root, "keep/a.txt");
    writeAsset(root, "keep/b.txt");
    const run = acceptReady(context, bundle, "artifacts-multi", "throw");
    kxmArtifactsGateSeams.afterPathChecked = (input) => {
      if (input.index === 0) throw new Error("deterministic-partial-check");
    };
    await assert.rejects(() => driveKxmRun(context, run.runId, producer()), /deterministic-partial-check/);
    assert.equal(context.eventStore.gateRowCounts(run.runId).attempts, 1);
    assert.equal(context.eventStore.gateRowCounts(run.runId).observations, 0);
    assert.equal(context.eventStore.gateRowCounts(run.runId).evidence, 0);
    const folded = foldStoredKxmRun(context, context.eventStore.run(run.runId)!);
    assert.equal(folded.currentStep?.effectState, "intent");
    assert.equal(context.eventStore.capabilityByAttempt(folded.currentStep?.attemptId ?? "")?.state, "issued");
  });
});

test("S3 cross-process cancel seam settles complete proof-only; settlement write rollback retains T1", async () => {
  await withS3(async ({ root, context, bundle }) => {
    writeAsset(root, "dist/index.js");
    const cancelRun = acceptReady(context, bundle, "artifacts-ready", "cancel-seam");
    kxmGateDispatchSeams.afterEvaluate = (prepared) => {
      context.eventStore.settleCapability(prepared.attemptId, "revoked");
    };
    const cancelled = await driveKxmRun(context, cancelRun.runId, producer());
    assert.equal(cancelled.state.status, "cancelled");
    const cancelAttempt = context.eventStore.gateAttemptsForRun(cancelRun.runId)[0]!;
    const observation = context.eventStore.gateObservationForAttempt(cancelAttempt.attemptId)!;
    assert.equal(observation.completeness, "complete");
    assert.equal(observation.checkedCount, 1);
    assert.equal(observation.failedCount, 0);
    assert.equal(context.eventStore.gateEvidenceForAttempt(cancelAttempt.attemptId), undefined);
    const settled = context.eventStore.events(cancelRun.runId, 0, 200).find((event) => event.eventType === "effect.settled")!;
    assert.equal(settled.payload.outcome, undefined);

    const rollbackRun = acceptReady(context, bundle, "artifacts-ready", "rollback");
    kxmGateDispatchSeams.afterEvaluate = undefined;
    kxmGateDispatchSeams.afterObservationWrite = () => {
      throw new Error("deterministic-settlement-rollback");
    };
    await assert.rejects(() => driveKxmRun(context, rollbackRun.runId, producer()), /deterministic-settlement-rollback/);
    assert.equal(context.eventStore.gateRowCounts(rollbackRun.runId).attempts, 1);
    assert.equal(context.eventStore.gateRowCounts(rollbackRun.runId).observations, 0);
    assert.equal(context.eventStore.gateRowCounts(rollbackRun.runId).evidence, 0);
    const rolled = foldStoredKxmRun(context, context.eventStore.run(rollbackRun.runId)!);
    assert.equal(rolled.currentStep?.effectState, "intent");
    assert.equal(rolled.status, "running");
  });
});

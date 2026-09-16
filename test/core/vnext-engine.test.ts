import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { removeTempDir } from "../helpers.ts";
import { engineProject } from "../helpers/vnext-project.ts";
import { loadVnextProject, parseRestrictedYaml, validateRunEvent } from "../../plugins/kxm/src/vnext-config.ts";
import { compileVnextWorkflow } from "../../plugins/kxm/src/vnext-engine-compile.ts";
import { setModelState, updateProducer } from "../../plugins/kxm/src/producers.ts";
import { FOLD_PANEL_BOUND, foldVnextRunState, vnextJoinAll } from "../../plugins/kxm/src/vnext-engine-fold.ts";
import {
  hashVnextRunPlanEnvelope,
  loadVnextRunPlanEnvelope,
  parseVnextRunPlanEnvelope,
} from "../../plugins/kxm/src/vnext-engine-plan.ts";
import {
  VnextRunScheduler,
  createVnextSimulatedProducer,
  driveVnextRun,
  pinVnextCompiledPlan,
  registerTrustedProducer,
  rehydrateVnextCompiledPlan,
  startVnextRun,
  stepVnextRun,
  verifyVnextAttemptCapability,
  vnextPanelDispatchSeams,
} from "../../plugins/kxm/src/vnext-engine.ts";
import {
  admitVnextRun,
  bindVnextSchedulerPolicy,
  enqueueVnextScheduledRun,
  registerVnextAttemptController,
  releaseVnextRun,
  unregisterVnextAttemptController,
  vnextActiveScheduledRuns,
  vnextAttemptController,
  vnextAttemptControllers,
  vnextDriveSession,
  vnextQueuedScheduledRuns,
} from "../../plugins/kxm/src/vnext-runtime-owner.ts";
import {
  DRIVE_RECEIPT_MAX_BYTES,
  VNEXT_DRIVE_RECEIPT_SCHEMA,
  VNEXT_EVENT_STORE_SCHEMA_VERSION,
  VNEXT_REGISTRY_SCHEMA_VERSION,
  VnextRunEventStore,
  VnextRuntimeRegistry,
  hashVnextDriveLog,
  newVnextEventId,
  verifyVnextDriveReceipt,
  vnextRuntimePaths,
  type VnextDriveReceipt,
  type VnextRunEvent,
  type VnextRunRecord,
} from "../../plugins/kxm/src/vnext-runtime-store.ts";
import {
  acceptVnextRun,
  cancelVnextRun,
  closeVnextRuntimeContext,
  foldStoredVnextRun,
  openVnextRuntimeContext,
  readVnextRunStatus,
  rebuildVnextRunProjection,
} from "../../plugins/kxm/src/vnext-runtime.ts";
import { vnextCanonicalJson as canonicalJson, type JsonObject, type JsonValue } from "../../plugins/kxm/src/vnext-config.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureDir = resolve(repoRoot, "test/fixtures/vnext-engine");
const HOME = "rtm_01JENGINE00000000000000000";

function scanForCapability(value: unknown, path: string, hits: string[]): void {
  if (typeof value === "string") {
    if (value.includes("kxmcap_")) hits.push(path);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForCapability(entry, `${path}[${index}]`, hits));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) scanForCapability(child, `${path}.${key}`, hits);
}

function outcomes(list: string[]) {
  let index = 0;
  return createVnextSimulatedProducer(async () => {
    const outcome = list[index];
    index += 1;
    assert.ok(outcome, "script ran out of outcomes");
    return { outcome };
  });
}

test("agent-only end to end advances, folds, and matches run_state bytes", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-e2e-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "agent-only", prompt: "rework" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const driven = await driveVnextRun(context, accepted.run.runId, outcomes(["passed", "failed", "passed", "passed", "passed"]));
      assert.equal(driven.state.status, "completed");
      assert.equal(driven.state.schema, "kxm.run-state.v2");
      assert.equal(driven.state.stepAttempts.a, 2);
      assert.equal(driven.state.stepAttempts.b, 2);
      assert.equal(driven.state.stepAttempts.c, 1);
      assert.equal(driven.state.transitionsUsed, 5);
      assert.equal(driven.state.edgeTransitions["b:failed"], 1);
      const events = context.eventStore.events(accepted.run.runId, 0, 10_000);
      for (const event of events) validateRunEvent(event, "run-event");
      const statuses = events.filter((event) => event.eventType === "run.status_changed").map((event) => event.payload.status);
      assert.deepEqual(statuses, ["preparing", "running", "completed"]);
      const stored = context.eventStore.runState(accepted.run.runId);
      assert.ok(stored);
      assert.equal(stored.state, canonicalJson(driven.state as unknown as JsonValue));
      const folded = foldVnextRunState(context.eventStore.run(accepted.run.runId)!, rehydrateVnextCompiledPlan(context, accepted.run.runId), events);
      assert.equal(canonicalJson(folded as unknown as JsonValue), stored.state);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("replay rebuilds, recreates missing run_state, and fails closed without a plan", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-replay-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const created = acceptVnextRun(context, bundle, { workflowId: "agent-only", prompt: "created-only" });
      const createdRebuild = rebuildVnextRunProjection(context, created.run.runId);
      assert.equal(createdRebuild.status, "created");
      assert.equal(context.eventStore.runPlan(created.run.runId), undefined);

      const cancelled = acceptVnextRun(context, bundle, { workflowId: "agent-only", prompt: "cancel-before-pin" });
      cancelVnextRun(context, cancelled.run.runId);
      assert.equal(rebuildVnextRunProjection(context, cancelled.run.runId).status, "cancelled");
      assert.equal(context.eventStore.runPlan(cancelled.run.runId), undefined);

      const accepted = acceptVnextRun(context, bundle, { workflowId: "agent-only", prompt: "replay" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const driven = await driveVnextRun(context, accepted.run.runId, outcomes(["passed", "failed", "passed", "passed", "passed"]));
      closeVnextRuntimeContext(context);
      const reopened = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
      try {
        const rebuilt = rebuildVnextRunProjection(reopened, accepted.run.runId);
        assert.equal(rebuilt.status, "completed");
        const before = reopened.eventStore.runState(accepted.run.runId)!.state;
        const db = new DatabaseSync(reopened.eventStore.path);
        db.exec(`DELETE FROM run_state WHERE run_id = '${accepted.run.runId}'`);
        db.close();
        const recreated = rebuildVnextRunProjection(reopened, accepted.run.runId);
        assert.equal(recreated.status, "completed");
        assert.equal(reopened.eventStore.runState(accepted.run.runId)!.state, before);
        dbCloseAndDropPlan(reopened.eventStore.path, accepted.run.runId);
        assert.throws(() => rebuildVnextRunProjection(reopened, accepted.run.runId), /run_plan_missing/);
        void driven;
      } finally {
        closeVnextRuntimeContext(reopened);
      }
    } catch (error) {
      try { closeVnextRuntimeContext(context); } catch { /* already closed */ }
      throw error;
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

function dbCloseAndDropPlan(path: string, runId: string): void {
  const db = new DatabaseSync(path);
  db.exec(`DELETE FROM run_plans WHERE run_id = '${runId}'`);
  db.close();
}

test("same-policy pins differ only by runId; re-pin is idempotent; revision drift fails closed", () => {
  const { root, stateRoot } = engineProject("kxm-engine-pin-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const first = acceptVnextRun(context, bundle, { workflowId: "agent-only", prompt: "one" });
      const second = acceptVnextRun(context, bundle, { workflowId: "agent-only", prompt: "two" });
      const pin1 = pinVnextCompiledPlan(context, bundle, first.run.runId);
      const pin2 = pinVnextCompiledPlan(context, bundle, second.run.runId);
      assert.equal(pin1.idempotent, false);
      assert.notEqual(pin1.runPlanHash, pin2.runPlanHash);
      const envelope1 = JSON.parse(context.eventStore.runPlan(first.run.runId)!.envelope) as { plan: unknown; runId: string };
      const envelope2 = JSON.parse(context.eventStore.runPlan(second.run.runId)!.envelope) as { plan: unknown; runId: string };
      assert.equal(canonicalJson(envelope1.plan as JsonValue), canonicalJson(envelope2.plan as JsonValue));
      const again = pinVnextCompiledPlan(context, bundle, first.run.runId);
      assert.equal(again.idempotent, true);
      assert.equal(context.eventStore.events(first.run.runId, 0, 20).filter((event) => event.payload.runPlanHash).length, 1);
      writeFileSync(
        join(root, ".kxm", "agents", "implementer.yaml"),
        readFileSync(join(root, ".kxm", "agents", "implementer.yaml"), "utf8").replace("Implement the approved change", "Implement the drifted change"),
      );
      const drifted = loadVnextProject(root);
      assert.notEqual(drifted.configRevision, bundle.configRevision);
      assert.throws(() => pinVnextCompiledPlan(context, drifted, first.run.runId), /run_revision_drift/);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("tampered envelopes fail rehydrate", () => {
  const { root, stateRoot } = engineProject("kxm-engine-tamper-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "agent-only", prompt: "tamper" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const db = new DatabaseSync(context.eventStore.path);
      const row = db.prepare("SELECT envelope FROM run_plans WHERE run_id = ?").get(accepted.run.runId) as { envelope: string };
      const parsed = JSON.parse(row.envelope) as { projectLimits: { maxConcurrentRuns: number }; runId: string };
      parsed.projectLimits.maxConcurrentRuns = 99;
      db.prepare("UPDATE run_plans SET envelope = ? WHERE run_id = ?").run(JSON.stringify(parsed), accepted.run.runId);
      db.close();
      assert.throws(() => rehydrateVnextCompiledPlan(context, accepted.run.runId), /run_plan_corrupt/);
      const other = acceptVnextRun(context, bundle, { workflowId: "agent-only", prompt: "other" });
      pinVnextCompiledPlan(context, bundle, other.run.runId);
      const copy = new DatabaseSync(context.eventStore.path);
      const donor = copy.prepare("SELECT envelope FROM run_plans WHERE run_id = ?").get(other.run.runId) as { envelope: string };
      copy.prepare("UPDATE run_plans SET envelope = ? WHERE run_id = ?").run(donor.envelope, accepted.run.runId);
      copy.close();
      assert.throws(() => rehydrateVnextCompiledPlan(context, accepted.run.runId), /run_plan_corrupt/);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("unknown outcomes and producer rejection fail without outcome_recorded", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-unknown-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "agent-only", prompt: "unknown" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const driven = await driveVnextRun(context, accepted.run.runId, outcomes(["not-a-declared-outcome"]));
      assert.equal(driven.state.status, "failed");
      assert.equal(driven.state.terminalReason, "outcome_unknown");
      const events = context.eventStore.events(accepted.run.runId, 0, 200);
      assert.equal(events.some((event) => event.eventType === "step.outcome_recorded"), false);
      const rejected = acceptVnextRun(context, bundle, { workflowId: "agent-only", prompt: "reject" });
      pinVnextCompiledPlan(context, bundle, rejected.run.runId);
      const failed = await driveVnextRun(context, rejected.run.runId, createVnextSimulatedProducer(async () => {
        throw new Error("producer exploded");
      }));
      assert.equal(failed.state.status, "failed");
      assert.equal(context.eventStore.events(rejected.run.runId, 0, 200).some((event) => event.eventType === "step.outcome_recorded"), false);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("transition and step budgets fail closed without rollback", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-budget-");
  try {
    writeFileSync(join(root, ".kxm", "workflows", "edge-once.yaml"), `schema: kxm.workflow.v1
coordinator: coordinator
limits:
  maxTransitions: 8
steps:
  - id: a
    kind: agent
    agent: implementer
    maxAttempts: 3
    on:
      passed: b
      failed:
        target: a
        maxTransitions: 1
  - id: b
    kind: agent
    agent: implementer
    on:
      passed:
        target: $terminal
        terminalStatus: completed
`);
    writeFileSync(join(root, ".kxm", "workflows", "tiny-budget.yaml"), `schema: kxm.workflow.v1
coordinator: coordinator
limits:
  maxTransitions: 1
steps:
  - id: a
    kind: agent
    agent: implementer
    on:
      passed: b
  - id: b
    kind: agent
    agent: implementer
    on:
      passed:
        target: $terminal
        terminalStatus: completed
`);
    writeFileSync(join(root, ".kxm", "workflows", "one-attempt.yaml"), `schema: kxm.workflow.v1
coordinator: coordinator
limits:
  maxTransitions: 8
steps:
  - id: a
    kind: agent
    agent: implementer
    maxAttempts: 1
    on:
      passed: b
      failed:
        target: a
        maxTransitions: 2
  - id: b
    kind: agent
    agent: implementer
    on:
      passed:
        target: $terminal
        terminalStatus: completed
`);
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const edge = acceptVnextRun(context, bundle, { workflowId: "edge-once", prompt: "edge" });
      pinVnextCompiledPlan(context, bundle, edge.run.runId);
      const edgeResult = await driveVnextRun(context, edge.run.runId, outcomes(["failed", "failed"]));
      assert.equal(edgeResult.state.status, "failed");
      assert.equal(edgeResult.state.terminalReason, "budget_edge");
      assert.ok(context.eventStore.events(edge.run.runId, 0, 200).some((event) => event.eventType === "step.outcome_recorded"));

      const tiny = acceptVnextRun(context, bundle, { workflowId: "tiny-budget", prompt: "tiny" });
      pinVnextCompiledPlan(context, bundle, tiny.run.runId);
      const tinyResult = await driveVnextRun(context, tiny.run.runId, outcomes(["passed", "passed"]));
      assert.equal(tinyResult.state.status, "failed");
      assert.equal(tinyResult.state.terminalReason, "budget_transitions");

      const attempts = acceptVnextRun(context, bundle, { workflowId: "one-attempt", prompt: "attempts" });
      pinVnextCompiledPlan(context, bundle, attempts.run.runId);
      const attemptResult = await driveVnextRun(context, attempts.run.runId, outcomes(["failed"]));
      assert.equal(attemptResult.state.status, "failed");
      assert.equal(attemptResult.state.terminalReason, "budget_step_attempts");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("untrusted producers are rejected and factory objects are frozen", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-trust-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "trust" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      startVnextRun(context, accepted.run.runId);
      const fake = { id: "driver-simulated" as const, produce: async () => ({ outcome: "passed" }) };
      await assert.rejects(() => stepVnextRun(context, accepted.run.runId, fake), /engine_producer_untrusted/);
      const producer = createVnextSimulatedProducer(async () => ({ outcome: "passed" }));
      assert.throws(() => {
        (producer as { produce: unknown }).produce = async () => ({ outcome: "failed" });
      }, TypeError);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("trusted driver custom-done reaches compiled completed independently of step status", async () => {
  await assertCustomDoneTerminal("completed");
});

test("trusted driver custom-done reaches compiled cancelled independently of step status", async () => {
  await assertCustomDoneTerminal("cancelled");
});

async function assertCustomDoneTerminal(terminal: "completed" | "cancelled"): Promise<void> {
  const { root, stateRoot } = engineProject("kxm-engine-custom-terminal-");
  try {
    writeFileSync(join(root, ".kxm", "workflows", "custom-done.yaml"), `schema: kxm.workflow.v1
coordinator: coordinator
steps:
  - id: only
    kind: agent
    agent: implementer
    on:
      passed: { target: $terminal, terminalStatus: completed }
      custom-done: { target: $terminal, terminalStatus: ${terminal} }
`);
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "custom-done", prompt: `custom-done-${terminal}` });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const driven = await driveVnextRun(
        context,
        accepted.run.runId,
        createVnextSimulatedProducer(() => ({ outcome: "custom-done" })),
      );
      assert.equal(driven.state.status, terminal);
      assert.equal(driven.state.edgeTransitions["only:custom-done"], 1);
      const events = context.eventStore.events(accepted.run.runId, 0, 10_000);
      for (const event of events) validateRunEvent(event, "run-event");
      const outcomeRecorded = events.find((event) => event.eventType === "step.outcome_recorded");
      assert.equal(outcomeRecorded?.payload.outcome, "custom-done");
      const terminalStep = events.find((event) =>
        event.eventType === "step.status_changed"
        && (event.payload.status === "passed" || event.payload.status === "failed" || event.payload.status === "cancelled")
      );
      assert.equal(terminalStep?.payload.status, "failed");
      const stored = context.eventStore.runState(accepted.run.runId);
      assert.ok(stored);
      const folded = foldVnextRunState(
        context.eventStore.run(accepted.run.runId)!,
        rehydrateVnextCompiledPlan(context, accepted.run.runId),
        events,
      );
      assert.equal(folded.status, terminal);
      assert.equal(canonicalJson(folded as unknown as JsonValue), stored.state);
      assert.equal(rebuildVnextRunProjection(context, accepted.run.runId).status, terminal);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
}

test("duplicate settlement is busy; capabilities bind to the current issued attempt", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-cap-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "cap" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      startVnextRun(context, accepted.run.runId);
      let secret = "";
      let attemptId = "";
      const producer = createVnextSimulatedProducer(async (request) => {
        secret = request.capability;
        attemptId = request.attemptId;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { outcome: "passed" };
      });
      const first = stepVnextRun(context, accepted.run.runId, producer);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await assert.rejects(() => stepVnextRun(context, accepted.run.runId, producer), /run_busy/);
      await first;
      const events = context.eventStore.events(accepted.run.runId, 0, 200).filter((event) => event.eventType === "attempt.created");
      assert.equal(events.length, 1);
      assert.throws(() => verifyVnextAttemptCapability(context, secret, { runId: accepted.run.runId, attemptId }), /capability_rejected/);

      const loop = acceptVnextRun(context, bundle, { workflowId: "agent-only", prompt: "stale" });
      pinVnextCompiledPlan(context, bundle, loop.run.runId);
      startVnextRun(context, loop.run.runId);
      const secrets: string[] = [];
      const attempts: string[] = [];
      const looping = createVnextSimulatedProducer(async (request) => {
        secrets.push(request.capability);
        attempts.push(request.attemptId);
        return { outcome: secrets.length === 1 ? "failed" : "passed" };
      });
      await stepVnextRun(context, loop.run.runId, looping);
      await stepVnextRun(context, loop.run.runId, looping);
      assert.throws(
        () => verifyVnextAttemptCapability(context, secrets[0]!, { runId: loop.run.runId, attemptId: attempts[1]! }),
        /capability_rejected/,
      );
      const other = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "cross" });
      assert.throws(
        () => verifyVnextAttemptCapability(context, secrets[1]!, { runId: other.run.runId, attemptId: attempts[1]! }),
        /capability_rejected/,
      );
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("capability secrets never appear in durable records or drive results", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-hygiene-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "hygiene" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const driven = await driveVnextRun(context, accepted.run.runId, createVnextSimulatedProducer(async (request) => {
        const extra = { outcome: "passed", summary: request.capability };
        if (request.capability.startsWith("kxmcap_")) return extra;
        throw new Error(request.capability);
      }));
      const hits: string[] = [];
      scanForCapability(context.eventStore.events(accepted.run.runId, 0, 200), "events", hits);
      scanForCapability(context.eventStore.run(accepted.run.runId), "run", hits);
      scanForCapability(context.eventStore.runState(accepted.run.runId), "state", hits);
      scanForCapability(driven, "drive", hits);
      assert.deepEqual(hits, []);
      const rejected = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "throw" });
      pinVnextCompiledPlan(context, bundle, rejected.run.runId);
      const asyncRejected = await driveVnextRun(context, rejected.run.runId, createVnextSimulatedProducer(async (request) => {
        throw new Error(`leaked ${request.capability}`);
      }));
      assert.equal(asyncRejected.state.status, "failed");
      const asyncRecorded = context.eventStore.events(rejected.run.runId, 0, 200).find((event) => event.eventType === "assignment.result_recorded");
      assert.equal(asyncRecorded?.payload.resultClass, "producer_rejected");
      const rejectedHits: string[] = [];
      scanForCapability(context.eventStore.events(rejected.run.runId, 0, 200), "rejected-events", rejectedHits);
      scanForCapability(asyncRejected, "rejected-drive", rejectedHits);
      assert.equal(rejectedHits.length, 0);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("synchronous producer throw settles as producer_rejected without leaking the capability", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-sync-throw-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "sync-throw" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      let caught: unknown;
      let driven: Awaited<ReturnType<typeof driveVnextRun>> | undefined;
      try {
        driven = await driveVnextRun(context, accepted.run.runId, createVnextSimulatedProducer((request) => {
          throw new Error(`leaked ${request.capability}`);
        }));
      } catch (error) {
        caught = error;
      }
      assert.equal(caught, undefined, `raw producer error escaped: ${String(caught)}`);
      assert.ok(driven);
      assert.equal(driven.state.status, "failed");
      const recorded = context.eventStore.events(accepted.run.runId, 0, 200).find((event) => event.eventType === "assignment.result_recorded");
      assert.equal(recorded?.payload.resultClass, "producer_rejected");
      const hits: string[] = [];
      scanForCapability(context.eventStore.events(accepted.run.runId, 0, 200), "events", hits);
      scanForCapability(context.eventStore.run(accepted.run.runId), "run", hits);
      scanForCapability(context.eventStore.runState(accepted.run.runId), "state", hits);
      scanForCapability(driven, "drive", hits);
      scanForCapability(caught, "caught", hits);
      assert.deepEqual(hits, []);
      assert.equal(vnextAttemptControllers(context.eventStore.path, accepted.run.runId).length, 0);
      const again = await driveVnextRun(context, accepted.run.runId, outcomes(["passed"]));
      assert.equal(again.state.status, "failed");
      assert.equal(again.state.terminalReason, driven.state.terminalReason);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("attempt capability is usable in the same turn it is issued", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-cap-now-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "same-turn" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      let secret = "";
      let attemptId = "";
      const driven = await driveVnextRun(context, accepted.run.runId, createVnextSimulatedProducer((request) => {
        secret = request.capability;
        attemptId = request.attemptId;
        verifyVnextAttemptCapability(context, request.capability, { runId: request.runId, attemptId: request.attemptId });
        return { outcome: "passed" };
      }));
      assert.equal(driven.state.status, "completed");
      assert.match(secret, /^kxmcap_/);
      assert.throws(
        () => verifyVnextAttemptCapability(context, secret, { runId: accepted.run.runId, attemptId }),
        /capability_rejected/,
      );
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("cancellation is cooperative, waits for settlement, and is visible across handles", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-cancel-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    const other = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "coop" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const cooperative = createVnextSimulatedProducer(async (request) => {
        await new Promise((_, reject) => {
          if (request.signal.aborted) reject(new Error("aborted"));
          request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
        return { outcome: "passed" };
      });
      const drive = driveVnextRun(context, accepted.run.runId, cooperative);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const cancel = cancelVnextRun(other, accepted.run.runId);
      assert.equal(cancel.run.status, "cancelling");
      const done = await drive;
      assert.equal(done.state.status, "cancelled");
      assert.equal(context.eventStore.events(accepted.run.runId, 0, 200).filter((event) => event.eventType === "run.cancel_requested").length, 1);
      const again = cancelVnextRun(context, accepted.run.runId, { commandId: "cmd_01JCANCELREPEAT00000000000" });
      assert.equal(again.idempotent, true);
      assert.equal(context.eventStore.events(accepted.run.runId, 0, 200).filter((event) => event.eventType === "run.cancel_requested").length, 1);

      let resume: (value: { outcome: string }) => void = () => undefined;
      let signal: AbortSignal | undefined;
      const deferred = new Promise<{ outcome: string }>((resolve) => {
        resume = resolve;
      });
      const ignoring = createVnextSimulatedProducer(async (request) => {
        signal = request.signal;
        return { ...(await deferred), tokensIn: 42, tokensOut: 6, providerMetadata: { providerReportedCostUsd: 0.05 } };
      });
      const hanging = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "ignore" });
      pinVnextCompiledPlan(context, bundle, hanging.run.runId);
      const hangingDrive = driveVnextRun(context, hanging.run.runId, ignoring);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const pending = cancelVnextRun(context, hanging.run.runId);
      assert.equal(pending.run.status, "cancelling");
      assert.equal(signal?.aborted, true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(context.eventStore.run(hanging.run.runId)?.status, "cancelling");
      resume({ outcome: "passed" });
      const settled = await hangingDrive;
      assert.equal(settled.state.status, "cancelled");
      const costs = context.eventStore.events(hanging.run.runId, 0, 200).filter((event) => event.eventType === "routing.attempt.recorded");
      assert.equal(costs.length, 1, "cancellation must not erase an invoked producer's usage");
      const routing = costs[0]!.payload.routing as JsonObject;
      assert.equal(routing.tokensIn, 42);
      assert.equal(routing.tokensOut, 6);
      assert.equal((routing.providerMetadata as JsonObject).providerReportedCostUsd, 0.05);
    } finally {
      closeVnextRuntimeContext(other);
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("handoffs: duration limits, unsupported steps, unreconciled attempts, and resume between steps", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-handoff-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const def = acceptVnextRun(context, bundle, { workflowId: "default", prompt: "default" });
      pinVnextCompiledPlan(context, bundle, def.run.runId);
      const limited = startVnextRun(context, def.run.runId);
      assert.equal(limited.handoff?.reason, "limit_unsupported");
      assert.equal(limited.handoff?.field, "limits.maxAgentTimeMs");
      assert.equal(limited.state.status, "preparing");
      assert.equal(context.eventStore.events(def.run.runId, 0, 20).some((event) => event.payload.status === "running"), false);

      writeDurationWorkflow(root, "duration-only", "  maxTransitions: 2\n  maxRunDurationMs: 1000");
      const durationBundle = loadVnextProject(root);
      const durationRun = acceptVnextRun(context, durationBundle, { workflowId: "duration-only", prompt: "duration" });
      pinVnextCompiledPlan(context, durationBundle, durationRun.run.runId);
      const startedDuration = startVnextRun(context, durationRun.run.runId);
      assert.equal(startedDuration.handoff, undefined);
      assert.equal(startedDuration.state.status, "running");
      assert.ok(startedDuration.state.runningSince);

      const gated = acceptVnextRun(context, bundle, { workflowId: "unsupported-gate", prompt: "gate" });
      pinVnextCompiledPlan(context, bundle, gated.run.runId);
      startVnextRun(context, gated.run.runId);
      const blocked = await stepVnextRun(context, gated.run.runId, outcomes(["passed"]));
      assert.equal(blocked.handoff?.reason, "step_unsupported");
      assert.equal(blocked.state.status, "running");
      assert.equal(context.eventStore.events(gated.run.runId, 0, 50).some((event) => event.eventType === "step.entered"), false);

      const mid = acceptVnextRun(context, bundle, { workflowId: "agent-only", prompt: "mid" });
      pinVnextCompiledPlan(context, bundle, mid.run.runId);
      startVnextRun(context, mid.run.runId);
      await stepVnextRun(context, mid.run.runId, outcomes(["passed"]));
      const between = foldVnextRunState(
        context.eventStore.run(mid.run.runId)!,
        rehydrateVnextCompiledPlan(context, mid.run.runId),
        context.eventStore.events(mid.run.runId, 0, 200),
      );
      assert.equal(between.status, "running");
      assert.equal(between.pendingStepId, "b");
      assert.equal(between.currentStep, undefined);
      closeVnextRuntimeContext(context);
      const reopened = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
      try {
        const continued = await driveVnextRun(reopened, mid.run.runId, outcomes(["passed", "passed"]));
        assert.equal(continued.state.status, "completed");
      } finally {
        closeVnextRuntimeContext(reopened);
      }
    } catch (error) {
      try { closeVnextRuntimeContext(context); } catch { /* closed */ }
      throw error;
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("run-duration budget cancels a slow attempt without fabricating a passed outcome", { timeout: 15_000 }, async () => {
  const { root, stateRoot } = engineProject("kxm-engine-run-duration-slow-");
  try {
    writeDurationWorkflow(root, "tiny-duration", "  maxTransitions: 2\n  maxRunDurationMs: 25");
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const slow = acceptVnextRun(context, bundle, { workflowId: "tiny-duration", prompt: "slow" });
      pinVnextCompiledPlan(context, bundle, slow.run.runId);
      const slowDrive = await driveVnextRun(context, slow.run.runId, delayUntilAbort(400));
      assert.equal(slowDrive.state.status, "cancelled");
      assert.equal(slowDrive.state.terminalReason, "budget_run_duration");
      const slowEvents = context.eventStore.events(slow.run.runId, 0, 400);
      const slowCancel = slowEvents.find((event) => event.eventType === "run.cancel_requested");
      assert.equal(slowCancel?.payload.reason, "budget_run_duration");
      const slowBudget = slowCancel?.payload.budget as { budgetMs: number; elapsedMs: number; source: string };
      assert.equal(slowBudget.budgetMs, 25);
      assert.equal(slowBudget.source, "workflow");
      assert.ok(slowBudget.elapsedMs >= 25);
      assert.equal(
        slowEvents.some((event) => event.eventType === "assignment.result_recorded" && event.payload.resultClass === "outcome"),
        false,
        "budget overrun must not fabricate a passed/failed terminal attempt",
      );
      const receiptRun = acceptVnextRun(context, bundle, { workflowId: "tiny-duration", prompt: "slow-receipt" });
      const session = await VnextRunScheduler.for(context, bundle).openDriveSession(receiptRun.run.runId, {
        mode: "simulated",
        createProducer: () => delayUntilAbort(400),
      });
      const settled = await session.settled;
      assert.equal(settled.state.status, "cancelled");
      const receipt = context.eventStore.driveReceipt(session.driveId);
      assert.ok(receipt?.budget);
      assert.equal(receipt!.budget!.overrun, true);
      assert.equal(receipt!.budget!.source, "workflow");
      assert.equal(receipt!.budget!.budgetMs, 25);
      assert.ok(receipt!.budget!.elapsedMs >= 25);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("run-duration budget cancels at a step boundary and on resume before any new step", { timeout: 15_000 }, async () => {
  const { root, stateRoot } = engineProject("kxm-engine-run-duration-resume-");
  try {
    writeDurationWorkflow(root, "tiny-duration", "  maxTransitions: 4\n  maxRunDurationMs: 25");
    writeTwoStepDurationWorkflow(root, "two-step-duration", 25);
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const boundary = acceptVnextRun(context, bundle, { workflowId: "two-step-duration", prompt: "boundary" });
      pinVnextCompiledPlan(context, bundle, boundary.run.runId);
      startVnextRun(context, boundary.run.runId);
      const first = await stepVnextRun(context, boundary.run.runId, outcomes(["passed"]));
      assert.equal(first.state.status, "running");
      assert.equal(first.state.pendingStepId, "b");
      assert.equal(first.state.currentStep, undefined);
      const enteredBefore = context.eventStore.events(boundary.run.runId, 0, 400)
        .filter((event) => event.eventType === "step.entered").length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const afterBoundary = await driveVnextRun(context, boundary.run.runId, outcomes(["passed"]));
      assert.equal(afterBoundary.state.status, "cancelled");
      assert.equal(afterBoundary.state.terminalReason, "budget_run_duration");
      const boundaryEvents = context.eventStore.events(boundary.run.runId, 0, 400);
      assert.equal(boundaryEvents.filter((event) => event.eventType === "step.entered").length, enteredBefore);
      const cancelSeq = boundaryEvents.find((event) => event.eventType === "run.cancel_requested")?.sequence ?? 0;
      assert.equal(
        boundaryEvents.some((event) => event.eventType === "attempt.status_changed" && event.payload.status === "terminal" && event.sequence > cancelSeq),
        false,
        "step-boundary overrun must not fabricate a terminal attempt",
      );

      const resume = acceptVnextRun(context, bundle, { workflowId: "tiny-duration", prompt: "resume" });
      pinVnextCompiledPlan(context, bundle, resume.run.runId);
      startVnextRun(context, resume.run.runId);
      closeVnextRuntimeContext(context);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const reopened = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
      try {
        const resumed = await driveVnextRun(reopened, resume.run.runId, outcomes(["passed"]));
        assert.equal(resumed.state.status, "cancelled");
        assert.equal(resumed.state.terminalReason, "budget_run_duration");
        assert.equal(reopened.eventStore.events(resume.run.runId, 0, 200).some((event) => event.eventType === "step.entered"), false);
      } finally {
        closeVnextRuntimeContext(reopened);
      }
    } catch (error) {
      try { closeVnextRuntimeContext(context); } catch { /* closed after resume */ }
      throw error;
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("run-duration budget chooses min of project and workflow and fills receipt overrun false", { timeout: 15_000 }, async () => {
  const { root, stateRoot } = engineProject("kxm-engine-run-duration-source-");
  try {
    writeDurationWorkflow(root, "workflow-only", "  maxTransitions: 2\n  maxRunDurationMs: 25");
    writeDurationWorkflow(root, "project-only", "  maxTransitions: 2");
    writeDurationWorkflow(root, "both-budget", "  maxTransitions: 2\n  maxRunDurationMs: 80");
    writeDurationWorkflow(root, "completes-inside", "  maxTransitions: 2\n  maxRunDurationMs: 5000");
    writeFileSync(join(root, ".kxm", "project.yaml"), readFileSync(join(root, ".kxm", "project.yaml"), "utf8").replace(
      "defaultHarness: pi\n",
      "defaultHarness: pi\nlimits:\n  maxRunDurationMs: 40\n",
    ));
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const workflow = acceptVnextRun(context, bundle, { workflowId: "workflow-only", prompt: "workflow" });
      pinVnextCompiledPlan(context, bundle, workflow.run.runId);
      const workflowDrive = await driveVnextRun(context, workflow.run.runId, delayUntilAbort(400));
      assert.equal(workflowDrive.state.status, "cancelled");
      const workflowBudget = context.eventStore.events(workflow.run.runId, 0, 200).find((event) => event.eventType === "run.cancel_requested")?.payload.budget as { budgetMs: number; source: string };
      assert.equal(workflowBudget.source, "both");
      assert.equal(workflowBudget.budgetMs, 25);

      const project = acceptVnextRun(context, bundle, { workflowId: "project-only", prompt: "project" });
      pinVnextCompiledPlan(context, bundle, project.run.runId);
      const projectDrive = await driveVnextRun(context, project.run.runId, delayUntilAbort(400));
      assert.equal(projectDrive.state.status, "cancelled");
      const projectBudget = context.eventStore.events(project.run.runId, 0, 200).find((event) => event.eventType === "run.cancel_requested")?.payload.budget as { budgetMs: number; source: string };
      assert.equal(projectBudget.source, "project");
      assert.equal(projectBudget.budgetMs, 40);

      const both = acceptVnextRun(context, bundle, { workflowId: "both-budget", prompt: "both" });
      pinVnextCompiledPlan(context, bundle, both.run.runId);
      const bothDrive = await driveVnextRun(context, both.run.runId, delayUntilAbort(400));
      assert.equal(bothDrive.state.status, "cancelled");
      const bothBudget = context.eventStore.events(both.run.runId, 0, 200).find((event) => event.eventType === "run.cancel_requested")?.payload.budget as { budgetMs: number; source: string };
      assert.equal(bothBudget.source, "both");
      assert.equal(bothBudget.budgetMs, 40);

      const inside = acceptVnextRun(context, bundle, { workflowId: "completes-inside", prompt: "inside" });
      const session = await VnextRunScheduler.for(context, bundle).openDriveSession(inside.run.runId, {
        mode: "simulated",
        createProducer: () => outcomes(["passed"]),
      });
      const insideResult = await session.settled;
      assert.equal(insideResult.state.status, "completed");
      const insideReceipt = context.eventStore.driveReceipt(session.driveId);
      assert.ok(insideReceipt?.budget);
      assert.equal(insideReceipt!.budget!.overrun, false);
      assert.equal(insideReceipt!.budget!.source, "both");
      assert.equal(insideReceipt!.budget!.budgetMs, 40);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("scheduler admits concurrently, conflicts on queued policy replacement, and isolates projects", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-sched-");
  const other = engineProject("kxm-engine-sched-b-", undefined, "prj_01JENGINE11111111111111111");
  try {
    writeFileSync(join(root, ".kxm", "project.yaml"), readFileSync(join(root, ".kxm", "project.yaml"), "utf8").replace(
      "defaultHarness: pi\n",
      "defaultHarness: pi\nlimits:\n  maxConcurrentRuns: 2\n",
    ));
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    const second = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const scheduler = VnextRunScheduler.for(context, bundle);
      let current = 0;
      let max = 0;
      const slow = createVnextSimulatedProducer(async () => {
        current += 1;
        max = Math.max(max, current);
        await new Promise((resolve) => setTimeout(resolve, 40));
        current -= 1;
        return { outcome: "passed" };
      });
      const runs = ["one", "two", "three", "four"].map((prompt) => acceptVnextRun(context, bundle, { workflowId: "one-step", prompt }));
      for (const run of runs) pinVnextCompiledPlan(context, bundle, run.run.runId);
      const finished = await Promise.all(runs.map((run) => scheduler.enqueue(run.run.runId, slow)));
      assert.equal(finished.every((result) => result.state.status === "completed"), true);
      assert.ok(max <= 2, `concurrent producers ${max}`);

      let resume: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const blocking = createVnextSimulatedProducer(async () => {
        await gate;
        return { outcome: "passed" };
      });
      const blockedRun = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "block" });
      pinVnextCompiledPlan(context, bundle, blockedRun.run.runId);
      const pending = scheduler.enqueue(blockedRun.run.runId, blocking);
      const queuedRun = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "queued-old-policy" });
      pinVnextCompiledPlan(context, bundle, queuedRun.run.runId);
      const queuedPending = scheduler.enqueue(queuedRun.run.runId, blocking);
      await new Promise((resolve) => setTimeout(resolve, 20));
      writeFileSync(
        join(root, ".kxm", "agents", "coordinator.yaml"),
        readFileSync(join(root, ".kxm", "agents", "coordinator.yaml"), "utf8").replace("Coordinate the pinned workflow", "Coordinate the drifted workflow"),
      );
      const drifted = loadVnextProject(root);
      assert.notEqual(drifted.configRevision, bundle.configRevision);
      const third = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
      try {
        assert.ok(vnextActiveScheduledRuns(context.eventStore.path) + vnextQueuedScheduledRuns(context.eventStore.path) > 0);
        assert.throws(() => VnextRunScheduler.for(third, drifted), /scheduler_policy_conflict/);
      } finally {
        closeVnextRuntimeContext(third);
      }
      resume();
      await Promise.all([pending, queuedPending]);

      const idle = VnextRunScheduler.for(context, bundle);
      writeFileSync(
        join(root, ".kxm", "agents", "coordinator.yaml"),
        readFileSync(join(root, ".kxm", "agents", "coordinator.yaml"), "utf8").replace("Coordinate the drifted workflow", "Coordinate the rebound workflow"),
      );
      const rebound = loadVnextProject(root);
      assert.notEqual(rebound.configRevision, bundle.configRevision);
      const reboundSched = VnextRunScheduler.for(context, rebound);
      const staleRun = acceptVnextRun(context, rebound, { workflowId: "one-step", prompt: "stale-handle" });
      pinVnextCompiledPlan(context, rebound, staleRun.run.runId);
      const stale = idle.enqueue(staleRun.run.runId, outcomes(["passed"]));
      const staleOutcome = await Promise.race([
        stale.then(
          () => "settled",
          (error: unknown) => (String(error).includes("scheduler_policy_conflict") ? "conflict" : `other:${String(error)}`),
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 50)),
      ]);
      assert.equal(staleOutcome, "conflict");
      const reboundDone = await reboundSched.enqueue(staleRun.run.runId, outcomes(["passed"]));
      assert.equal(reboundDone.state.status, "completed");

      const otherBundle = loadVnextProject(other.root);
      const otherContext = openVnextRuntimeContext(other.root, { stateRoot: other.stateRoot, homeRuntimeId: HOME });
      try {
        const otherSched = VnextRunScheduler.for(otherContext, otherBundle);
        assert.throws(() => VnextRunScheduler.for(context, otherBundle), /run_owner_mismatch/);
        const isolated = acceptVnextRun(otherContext, otherBundle, { workflowId: "one-step", prompt: "iso" });
        pinVnextCompiledPlan(otherContext, otherBundle, isolated.run.runId);
        const done = await otherSched.enqueue(isolated.run.runId, outcomes(["passed"]));
        assert.equal(done.state.status, "completed");
      } finally {
        closeVnextRuntimeContext(otherContext);
      }
      void second;
    } finally {
      closeVnextRuntimeContext(second);
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot, other.root, other.stateRoot);
  }
});

function userVersion(path: string): number {
  const db = new DatabaseSync(path);
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  db.close();
  return row.user_version;
}

function holdProducer(): { producer: ReturnType<typeof createVnextSimulatedProducer>; release: () => void; started: Promise<void> } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const producer = createVnextSimulatedProducer(async () => {
    markStarted();
    await gate;
    return { outcome: "passed" };
  });
  return { producer, release, started };
}

test("direct drive release wakes queued scheduler work without a third enqueue", { timeout: 15_000 }, async () => {
  const { root, stateRoot } = engineProject("kxm-engine-mixed-wake-");
  const heldA = holdProducer();
  const heldB = holdProducer();
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const scheduler = VnextRunScheduler.for(context, bundle);
      const runA = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "direct-a" });
      const runB = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "queued-b" });
      pinVnextCompiledPlan(context, bundle, runA.run.runId);
      pinVnextCompiledPlan(context, bundle, runB.run.runId);
      const driveA = driveVnextRun(context, runA.run.runId, heldA.producer);
      await heldA.started;
      assert.equal(vnextActiveScheduledRuns(context.eventStore.path), 1);
      const queuedB = scheduler.enqueue(runB.run.runId, heldB.producer);
      assert.equal(vnextQueuedScheduledRuns(context.eventStore.path), 1);
      assert.equal(vnextActiveScheduledRuns(context.eventStore.path), 1);
      let bStartedEarly = false;
      void heldB.started.then(() => {
        bStartedEarly = true;
      });
      const early = await Promise.race([
        heldB.started.then(() => "started"),
        Promise.resolve("held"),
      ]);
      assert.equal(early, "held");
      assert.equal(bStartedEarly, false);
      const stepBusy = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "step-busy" });
      pinVnextCompiledPlan(context, bundle, stepBusy.run.runId);
      await assert.rejects(
        () => stepVnextRun(context, stepBusy.run.runId, outcomes(["passed"])),
        /run_admission_exceeded/,
      );
      heldA.release();
      const bWake = await Promise.race([
        heldB.started.then(() => "started" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 200)),
      ]);
      assert.equal(bWake, "started");
      assert.equal(bStartedEarly, true);
      heldB.release();
      const [aResult, bResult] = await Promise.all([driveA, queuedB]);
      assert.equal(aResult.state.status, "completed");
      assert.equal(bResult.state.status, "completed");
      assert.equal(vnextActiveScheduledRuns(context.eventStore.path), 0);
      assert.equal(vnextQueuedScheduledRuns(context.eventStore.path), 0);
      const stepped = await driveVnextRun(context, stepBusy.run.runId, outcomes(["passed"]));
      assert.equal(stepped.state.status, "completed");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    heldA.release();
    heldB.release();
    removeTempDir(root, stateRoot);
  }
});

test("openDriveSession admits before pin, returns driveId, and closes the producer", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-drive-session-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "session" });
      const scheduler = VnextRunScheduler.for(context, bundle);
      let closed = false;
      let sawAdmissionBeforePin = false;
      let release: () => void = () => undefined;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const inner = createVnextSimulatedProducer(async () => {
        await hold;
        return { outcome: "passed" };
      });
      const producer = {
        id: inner.id,
        produce: (request: Parameters<typeof inner.produce>[0]) => inner.produce(request),
        close: async () => {
          closed = true;
        },
      };
      registerTrustedProducer(producer);
      const session = await scheduler.openDriveSession(accepted.run.runId, {
        mode: "simulated",
        createProducer: () => {
          sawAdmissionBeforePin = vnextActiveScheduledRuns(context.eventStore.path) > 0;
          assert.equal(context.eventStore.run(accepted.run.runId)?.status, "created");
          return producer;
        },
      });
      assert.match(session.driveId, /^drv_[a-f0-9]{24}$/);
      assert.equal(sawAdmissionBeforePin, true);
      const during = vnextDriveSession(context.eventStore.path, accepted.run.runId);
      assert.equal(during?.driveId, session.driveId);
      release();
      const result = await session.settled;
      assert.equal(result.state.status, "completed");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(closed, true);
      assert.equal(vnextDriveSession(context.eventStore.path, accepted.run.runId), undefined);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("openDriveSession records run.drive_opened and a verified terminal receipt before settled", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-drive-receipt-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "receipt" });
      const scheduler = VnextRunScheduler.for(context, bundle);
      const session = await scheduler.openDriveSession(accepted.run.runId, {
        mode: "simulated",
        createProducer: () => createVnextSimulatedProducer(() => ({ outcome: "passed" })),
      });
      const result = await session.settled;
      assert.equal(result.state.status, "completed");
      const receiptAtSettle = context.eventStore.driveReceipt(session.driveId);
      assert.ok(receiptAtSettle, "receipt must exist before settled resolves");
      const events = context.eventStore.events(accepted.run.runId, 0, 1_000);
      const opened = events.find((event) => event.eventType === "run.drive_opened");
      assert.ok(opened, "run.drive_opened must be present");
      assert.equal(opened!.payload.driveId, session.driveId);
      assert.equal(opened!.payload.mode, "simulated");
      const folded = foldStoredVnextRun(context, context.eventStore.run(accepted.run.runId)!);
      assert.equal(folded.drive?.driveId, session.driveId);
      assert.equal(folded.drive?.mode, "simulated");
      assert.equal(folded.drive?.openedSequence, opened!.sequence);
      assert.equal(receiptAtSettle!.schema, VNEXT_DRIVE_RECEIPT_SCHEMA);
      assert.equal(receiptAtSettle!.settlement.kind, "terminal");
      assert.equal(receiptAtSettle!.settlement.status, "completed");
      assert.equal(receiptAtSettle!.budget, null);
      assert.equal(receiptAtSettle!.lastSequence, events[events.length - 1]!.sequence);
      assert.equal(receiptAtSettle!.logHash, hashVnextDriveLog(events));
      assert.equal(receiptAtSettle!.producer.id, "driver-simulated");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("openDriveSession handoff records receipt kind handoff while running", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-drive-handoff-receipt-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "unsupported-gate", prompt: "handoff-receipt" });
      const scheduler = VnextRunScheduler.for(context, bundle);
      const session = await scheduler.openDriveSession(accepted.run.runId, {
        mode: "simulated",
        createProducer: () => createVnextSimulatedProducer(() => ({ outcome: "passed" })),
      });
      const result = await session.settled;
      assert.equal(result.handoff?.reason, "step_unsupported");
      assert.equal(result.state.status, "running");
      const receipt = context.eventStore.driveReceipt(session.driveId);
      assert.ok(receipt);
      assert.equal(receipt!.settlement.kind, "handoff");
      assert.equal(receipt!.settlement.status, "running");
      assert.equal(receipt!.settlement.handoff?.reason, "step_unsupported");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("producer throw records the brake status in the drive receipt", { timeout: 15_000 }, async () => {
  const { root, stateRoot } = engineProject("kxm-engine-drive-receipt-throw-");
  resetPanelSeams();
  try {
    vnextPanelDispatchSeams.skipDispatch = () => true;
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "receipt-throw" });
      const scheduler = VnextRunScheduler.for(context, bundle);
      const session = await scheduler.openDriveSession(accepted.run.runId, {
        mode: "simulated",
        createProducer: () => createVnextSimulatedProducer(() => ({ outcome: "passed" })),
      });
      await assert.rejects(() => session.settled, /drive made no progress/);
      const receipt = context.eventStore.driveReceipt(session.driveId);
      assert.ok(receipt);
      const run = context.eventStore.run(accepted.run.runId)!;
      assert.equal(receipt!.settlement.status, run.status);
      assert.ok(receipt!.settlement.kind === "terminal" || receipt!.settlement.kind === "unsettled");
      assert.ok(receipt!.settlement.error, "producer throw records an error summary");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    resetPanelSeams();
    removeTempDir(root, stateRoot);
  }
});

test("insertDriveReceipt is insert-once and rejects oversized receipts without touching the log", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-drive-receipt-store-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "receipt-store" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      startVnextRun(context, accepted.run.runId);
      const run = context.eventStore.run(accepted.run.runId)!;
      const events = context.eventStore.events(accepted.run.runId, 0, 100);
      const before = events.length;
      const base: VnextDriveReceipt = {
        schema: VNEXT_DRIVE_RECEIPT_SCHEMA,
        driveId: "drv_0123456789abcdef01234567",
        runId: run.runId,
        projectId: run.projectId,
        homeRuntimeId: run.homeRuntimeId,
        mode: "simulated",
        openedAt: run.createdAt,
        openedSequence: 1,
        closedAt: run.updatedAt,
        lastSequence: events[events.length - 1]!.sequence,
        logHash: hashVnextDriveLog(events),
        settlement: { kind: "terminal", status: "running", reason: "first" },
        budget: null,
        producer: { id: "driver-simulated", closed: false },
      };
      assert.equal(context.eventStore.insertDriveReceipt(base).inserted, true);
      assert.equal(context.eventStore.insertDriveReceipt({ ...base, settlement: { ...base.settlement, reason: "second" } }).inserted, false);
      assert.equal(context.eventStore.driveReceipt(base.driveId)?.settlement.reason, "first");
      const matched = verifyVnextDriveReceipt(base, events, "running", { runId: run.runId, driveId: base.driveId });
      assert.equal(matched.verified, true);
      const swapped = verifyVnextDriveReceipt(base, events, "running", { runId: "run_swapped", driveId: "drv_swapped0000000000000000" });
      assert.equal(swapped.verified, false);
      assert.match(String(swapped.divergence), /runId/);
      assert.match(String(swapped.divergence), /driveId/);
      const oversized: VnextDriveReceipt = {
        ...base,
        driveId: "drv_89abcdef0123456789abcdef",
        settlement: {
          kind: "handoff",
          status: "running",
          reason: "r".repeat(4000),
          handoff: { reason: "step_unsupported", detail: "d".repeat(4000) },
        },
      };
      assert.ok(Buffer.byteLength(canonicalJson(oversized as unknown as JsonValue), "utf8") > DRIVE_RECEIPT_MAX_BYTES);
      assert.throws(() => context.eventStore.insertDriveReceipt(oversized), /drive_receipt_invalid/);
      assert.equal(context.eventStore.events(accepted.run.runId, 0, 100).length, before);
      assert.equal(context.eventStore.driveReceipt(oversized.driveId), undefined);
      assert.throws(
        () => context.eventStore.insertDriveReceipt({ ...base, driveId: "drv_fedcba9876543210fedcba98", schema: "kxm.drive-receipt.v0" as typeof VNEXT_DRIVE_RECEIPT_SCHEMA }),
        /drive_receipt_invalid/,
      );
      assert.equal(context.eventStore.events(accepted.run.runId, 0, 100).length, before);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("pre-B2 event stores migrate additively and old projections stay canonical", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-drive-receipt-replay-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    let storePath: string;
    let runId: string;
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "pre-b2" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const driven = await driveVnextRun(context, accepted.run.runId, outcomes(["passed"]));
      assert.equal(driven.state.status, "completed");
      assert.equal(driven.state.drive, undefined);
      runId = accepted.run.runId;
      storePath = context.eventStore.path;
      const stored = context.eventStore.runState(runId)!;
      closeVnextRuntimeContext(context);
      const db = new DatabaseSync(storePath);
      db.exec("DROP TABLE IF EXISTS drive_receipts");
      db.exec("PRAGMA user_version = 3");
      db.close();
      assert.equal(userVersion(storePath), 3);
      const reopened = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
      try {
        assert.equal(userVersion(storePath), VNEXT_EVENT_STORE_SCHEMA_VERSION);
        const folded = foldStoredVnextRun(reopened, reopened.eventStore.run(runId)!);
        assert.equal(folded.status, "completed");
        assert.equal(folded.drive, undefined);
        assert.equal(reopened.eventStore.runState(runId)!.state, stored.state);
        rebuildVnextRunProjection(reopened, runId);
        assert.equal(reopened.eventStore.runState(runId)!.state, stored.state);
      } finally {
        closeVnextRuntimeContext(reopened);
      }
    } catch (error) {
      try { closeVnextRuntimeContext(context); } catch { /* closed */ }
      throw error;
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("openDriveSession pre-open failures do not reject settled without a consumer", { timeout: 15_000 }, async () => {
  const { root, stateRoot } = engineProject("kxm-engine-drive-preopen-");
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(String(reason));
  };
  process.on("unhandledRejection", onUnhandled);
  const flush = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  try {
    writeFileSync(join(root, ".kxm", "workflows", "limited.yaml"), `schema: kxm.workflow.v1
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
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const scheduler = VnextRunScheduler.for(context, bundle);
      const held = holdProducer();
      const busyRun = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "busy" });
      const first = await scheduler.openDriveSession(busyRun.run.runId, {
        mode: "simulated",
        createProducer: () => held.producer,
      });
      await assert.rejects(
        () => scheduler.openDriveSession(busyRun.run.runId, {
          mode: "simulated",
          createProducer: () => createVnextSimulatedProducer(() => ({ outcome: "passed" })),
        }),
        /run_busy/,
      );
      await flush();
      assert.equal(unhandled.length, 0, `run_busy unhandledRejection: ${unhandled.join("; ")}`);
      held.release();
      await first.settled;

      const pinRun = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "pin-fail" });
      await assert.rejects(
        () => scheduler.openDriveSession(pinRun.run.runId, {
          mode: "simulated",
          createProducer: () => {
            throw new Error("createProducer failed before pin");
          },
        }),
        /createProducer failed before pin/,
      );
      await flush();
      assert.equal(unhandled.length, 0, `pin-failure unhandledRejection: ${unhandled.join("; ")}`);

      const handoffRun = acceptVnextRun(context, bundle, { workflowId: "limited", prompt: "handoff" });
      await assert.rejects(
        () => scheduler.openDriveSession(handoffRun.run.runId, {
          mode: "simulated",
          createProducer: () => createVnextSimulatedProducer(() => ({ outcome: "passed" })),
        }),
        /run_handoff_required/,
      );
      await flush();
      assert.equal(unhandled.length, 0, `handoff-throw unhandledRejection: ${unhandled.join("; ")}`);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    removeTempDir(root, stateRoot);
  }
});

test("post-open no-progress throw records failed or cancelled, never bare running", { timeout: 15_000 }, async () => {
  const { root, stateRoot } = engineProject("kxm-engine-drive-noprogress-");
  resetPanelSeams();
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(String(reason));
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    vnextPanelDispatchSeams.skipDispatch = () => true;
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "no-progress" });
      const scheduler = VnextRunScheduler.for(context, bundle);
      const session = await scheduler.openDriveSession(accepted.run.runId, {
        mode: "simulated",
        createProducer: () => createVnextSimulatedProducer(() => ({ outcome: "passed" })),
      });
      await assert.rejects(() => session.settled, /drive made no progress/);
      const run = context.eventStore.run(accepted.run.runId);
      assert.notEqual(run?.status, "running", "no-progress must not leave a bare running run");
      assert.ok(run?.status === "failed" || run?.status === "cancelled" || run?.status === "cancelling", `status=${run?.status}`);
      const events = context.eventStore.events(accepted.run.runId, 0, 200);
      assert.equal(
        events.some((event) =>
          event.eventType === "run.cancel_requested"
          || (event.eventType === "run.status_changed" && (event.payload.status === "failed" || event.payload.status === "cancelled"))
        ),
        true,
        "failure must be recorded through a fold-accepted path",
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(unhandled.length, 0, `unhandledRejection: ${unhandled.join("; ")}`);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    resetPanelSeams();
    removeTempDir(root, stateRoot);
  }
});

test("same-revision bound mutation is rejected while work is admitted or queued", async () => {
  const storePath = join(tmpdir(), `kxm-owner-bind-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const revision = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  bindVnextSchedulerPolicy(storePath, 1, revision);
  bindVnextSchedulerPolicy(storePath, 1, revision);
  const token = admitVnextRun(storePath, "run_admitted", revision, 1);
  assert.throws(() => bindVnextSchedulerPolicy(storePath, 3, revision), /scheduler_policy_conflict/);
  bindVnextSchedulerPolicy(storePath, 1, revision);
  releaseVnextRun(storePath, "run_admitted", "not-the-token");
  assert.equal(vnextActiveScheduledRuns(storePath), 1);
  assert.throws(() => bindVnextSchedulerPolicy(storePath, 3, revision), /scheduler_policy_conflict/);
  releaseVnextRun(storePath, "run_admitted", token);
  assert.equal(vnextActiveScheduledRuns(storePath), 0);
  let startQueued: () => void = () => undefined;
  const queuedHold = new Promise<void>((resolve) => {
    startQueued = resolve;
  });
  let queuedStarted = false;
  const queued = enqueueVnextScheduledRun(storePath, "run_queued", revision, 1, async () => {
    queuedStarted = true;
    await queuedHold;
  });
  await Promise.resolve();
  assert.equal(vnextActiveScheduledRuns(storePath), 1);
  assert.throws(() => bindVnextSchedulerPolicy(storePath, 3, revision), /scheduler_policy_conflict/);
  bindVnextSchedulerPolicy(storePath, 1, revision);
  startQueued();
  await queued;
  assert.equal(queuedStarted, true);
  await Promise.resolve();
  assert.equal(vnextActiveScheduledRuns(storePath), 0);
  bindVnextSchedulerPolicy(storePath, 3, revision);
});

test("admission bound 2 rejects duplicates, direct bypass, and a fourth run until a slot opens", { timeout: 15_000 }, async () => {
  const { root, stateRoot } = engineProject("kxm-engine-admit-");
  try {
    writeFileSync(join(root, ".kxm", "project.yaml"), readFileSync(join(root, ".kxm", "project.yaml"), "utf8").replace(
      "defaultHarness: pi\n",
      "defaultHarness: pi\nlimits:\n  maxConcurrentRuns: 2\n",
    ));
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const scheduler = VnextRunScheduler.for(context, bundle);
      const held = [holdProducer(), holdProducer(), holdProducer(), holdProducer()];
      const runs = ["a", "b", "c", "d"].map((prompt) => acceptVnextRun(context, bundle, { workflowId: "one-step", prompt }));
      for (const run of runs) pinVnextCompiledPlan(context, bundle, run.run.runId);
      const first = scheduler.enqueue(runs[0]!.run.runId, held[0]!.producer);
      const second = scheduler.enqueue(runs[1]!.run.runId, held[1]!.producer);
      await Promise.all([held[0]!.started, held[1]!.started]);
      assert.equal(vnextActiveScheduledRuns(context.eventStore.path), 2);
      const duplicate = scheduler.enqueue(runs[0]!.run.runId, held[0]!.producer);
      const duplicateOutcome = await Promise.race([
        duplicate.then(
          () => "settled",
          (error: unknown) => (String(error).includes("run_busy") ? "busy" : `other:${String(error)}`),
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 50)),
      ]);
      assert.equal(duplicateOutcome, "busy");
      const third = scheduler.enqueue(runs[2]!.run.runId, held[2]!.producer);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(vnextQueuedScheduledRuns(context.eventStore.path), 1);
      const bypass = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "bypass" });
      pinVnextCompiledPlan(context, bundle, bypass.run.runId);
      await assert.rejects(() => driveVnextRun(context, bypass.run.runId, outcomes(["passed"])), /run_admission_exceeded/);
      const fourth = scheduler.enqueue(runs[3]!.run.runId, held[3]!.producer);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(held[2]!.started instanceof Promise, true);
      let thirdStarted = false;
      void held[2]!.started.then(() => {
        thirdStarted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(thirdStarted, false);
      held[0]!.release();
      await first;
      await held[2]!.started;
      assert.equal(thirdStarted, true);
      assert.equal(vnextActiveScheduledRuns(context.eventStore.path), 2);
      held[1]!.release();
      held[2]!.release();
      held[3]!.release();
      await Promise.all([second, third, fourth]);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("restart after a real child-process executing commit is unreconciled", { timeout: 20_000 }, async () => {
  const { root, stateRoot } = engineProject("kxm-engine-restart-");
  const fixture = resolve(repoRoot, "test/fixtures/vnext-engine/commit-executing-then-exit.ts");
  let childPid: number | undefined;
  try {
    const bundle = loadVnextProject(root);
    const setup = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    let runId: string;
    try {
      const accepted = acceptVnextRun(setup, bundle, { workflowId: "one-step", prompt: "restart" });
      pinVnextCompiledPlan(setup, bundle, accepted.run.runId);
      runId = accepted.run.runId;
    } finally {
      closeVnextRuntimeContext(setup);
    }
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        fixture,
        JSON.stringify({ projectRoot: root, stateRoot, homeRuntimeId: HOME, runId }),
      ],
      { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    childPid = child.pid;
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 12_000);
    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
      child.once("close", (code, signal) => resolveClose({ code, signal }));
    });
    clearTimeout(timer);
    assert.equal(timedOut, false, `child still running\n${stdout}\n${stderr}`);
    assert.equal(closed.signal, null, `child signaled ${closed.signal}\n${stdout}\n${stderr}`);
    assert.equal(closed.code, 0, `child exit ${closed.code}\n${stdout}\n${stderr}`);
    assert.match(stdout, /executing/);
    assert.equal(processAlive(childPid), false, `residual process ${childPid}`);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const before = context.eventStore.events(runId, 0, 1_000);
      assert.equal(before.some((event) => event.eventType === "attempt.status_changed" && event.payload.status === "executing"), true);
      const orphan = await stepVnextRun(context, runId, outcomes(["passed"]));
      assert.equal(orphan.handoff?.reason, "attempt_unreconciled");
      const again = await stepVnextRun(context, runId, outcomes(["passed"]));
      assert.equal(again.handoff?.reason, "attempt_unreconciled");
      assert.equal(context.eventStore.events(runId, 0, 1_000).length, before.length);
      const pending = cancelVnextRun(context, runId);
      assert.equal(pending.run.status, "cancelling");
      const foreign = await stepVnextRun(context, runId, outcomes(["passed"]));
      assert.equal(foreign.handoff?.reason, "cancel_pending_foreign");
      const stored = context.eventStore.runState(runId)!;
      const rebuilt = rebuildVnextRunProjection(context, runId);
      assert.equal(context.eventStore.runState(runId)!.state, stored.state);
      assert.equal(rebuilt.status, "cancelling");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    if (childPid !== undefined && processAlive(childPid)) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    removeTempDir(root, stateRoot);
  }
});

function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("store brakes: registry v1 stays valid; event store v4; v1/v2/v99/shape fail closed", () => {
  const { root, stateRoot } = engineProject("kxm-engine-store-");
  try {
    const paths = vnextRuntimePaths({ stateRoot });
    const registry = new VnextRuntimeRegistry(paths.registryDb);
    assert.equal(userVersion(paths.registryDb), VNEXT_REGISTRY_SCHEMA_VERSION);
    registry.close();
    const registryAgain = new VnextRuntimeRegistry(paths.registryDb);
    registryAgain.close();

    const storePath = join(stateRoot, "fresh-events.db");
    const store = new VnextRunEventStore(storePath);
    assert.equal(userVersion(storePath), VNEXT_EVENT_STORE_SCHEMA_VERSION);
    store.close();

    const v1 = join(stateRoot, "v1-events.db");
    const old = new DatabaseSync(v1);
    old.exec(`
      CREATE TABLE runs (run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, home_runtime_id TEXT NOT NULL, workflow_id TEXT NOT NULL, prompt_sha256 TEXT NOT NULL, status TEXT NOT NULL, config_revision TEXT NOT NULL, memory_revision TEXT, executor_policy_revision TEXT NOT NULL, tool_policy_revision TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      CREATE TABLE events (project_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL, command_id TEXT, occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, monotonic_ns INTEGER NOT NULL, config_revision TEXT NOT NULL, memory_revision TEXT, executor_policy_revision TEXT NOT NULL, tool_policy_revision TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (project_id, run_id, sequence)) STRICT;
      CREATE TABLE commands (command_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, result TEXT NOT NULL, recorded_at TEXT NOT NULL) STRICT;
      PRAGMA user_version = 1;
    `);
    old.close();
    assert.throws(() => new VnextRunEventStore(v1), /runtime_schema_outdated[\s\S]*older than 4[\s\S]*E6/);

    const v2 = join(stateRoot, "v2-events.db");
    const prior = new DatabaseSync(v2);
    prior.exec("PRAGMA user_version = 2");
    prior.close();
    assert.throws(() => new VnextRunEventStore(v2), /runtime_schema_outdated[\s\S]*older than 4[\s\S]*no migration lane/);

    const newer = join(stateRoot, "v99-events.db");
    const bump = new DatabaseSync(newer);
    bump.exec("PRAGMA user_version = 99");
    bump.close();
    assert.throws(() => new VnextRunEventStore(newer), /runtime_schema_newer/);

    const stray = join(stateRoot, "v0-stray.db");
    const strayDb = new DatabaseSync(stray);
    strayDb.exec("CREATE TABLE leftover (id TEXT PRIMARY KEY) STRICT");
    strayDb.close();
    assert.throws(() => new VnextRunEventStore(stray), /runtime_schema_shape_invalid/);

    const dropped = join(stateRoot, "v2-dropped.db");
    const good = new VnextRunEventStore(dropped);
    good.close();
    const drop = new DatabaseSync(dropped);
    drop.exec("DROP TABLE run_plans");
    drop.close();
    assert.throws(() => new VnextRunEventStore(dropped), /runtime_schema_shape_invalid/);
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("illegal folds fail closed", () => {
  const run: VnextRunRecord = {
    runId: "run_01JILLEGAL00000000000000000",
    projectId: "prj_01JENGINE00000000000000000",
    homeRuntimeId: HOME,
    workflowId: "agent-only",
    promptSha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    status: "created",
    configRevision: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    memoryRevision: "ctxrev_absent",
    executorPolicyRevision: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    toolPolicyRevision: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
  const created = event(run, 1, "run.created", { workflowId: "agent-only", status: "created", promptHash: run.promptSha256, repositoryIds: [], executorIds: [] });
  assert.equal(foldVnextRunState(run, undefined, [created]).status, "created");
  assert.throws(() => foldVnextRunState(run, undefined, [created, event(run, 2, "run.created", created.payload)]), /run_events_illegal/);
  const completed = [
    created,
    event(run, 2, "run.status_changed", { status: "cancelled", reason: "operator_cancel" }),
    event(run, 3, "run.status_changed", { status: "running" }),
  ];
  assert.throws(() => foldVnextRunState(run, undefined, completed), /run_events_illegal/);
  assert.throws(() => foldVnextRunState(run, undefined, [created, event(run, 2, "step.entered", { stepId: "a", stepAttempt: 1, status: "pending" })]), /run_plan_missing|run_events_illegal/);
  const skip = [
    created,
    event(run, 2, "run.cancel_requested", { actor: { kind: "runtime", id: HOME }, reason: "operator_cancel" }),
    event(run, 4, "run.status_changed", { status: "cancelled", reason: "operator_cancel" }),
  ];
  assert.throws(() => foldVnextRunState(run, undefined, skip), /run_events_illegal/);
  const foreign = event({ ...run, homeRuntimeId: "rtm_01JOTHER00000000000000000" }, 1, "run.created", created.payload);
  assert.throws(() => foldVnextRunState(run, undefined, [foreign]), /run_event_owner_mismatch/);
  const plan = compileVnextWorkflow({
    id: "agent-only",
    value: parseRestrictedYaml(readFileSync(join(fixtureDir, "agent-only.yaml"), "utf8"), "agent-only.yaml"),
  });
  const oneStep = compileVnextWorkflow({
    id: "one-step",
    value: parseRestrictedYaml(readFileSync(join(fixtureDir, "one-step.yaml"), "utf8"), "one-step.yaml"),
  });
  const durationPlan = compileVnextWorkflow({
    id: "duration",
    value: parseRestrictedYaml(`schema: kxm.workflow.v1
coordinator: coordinator
limits:
  maxTransitions: 2
  maxRunDurationMs: 100
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
`, "duration.yaml"),
  });
  const durationRun = { ...run, workflowId: "duration" };
  const durationRunning = [
    event(durationRun, 1, "run.created", { workflowId: "duration", status: "created", promptHash: durationRun.promptSha256, repositoryIds: [], executorIds: [] }),
    event(durationRun, 2, "run.status_changed", { status: "preparing", runPlanHash: PLAN_HASH }),
    event(durationRun, 3, "run.status_changed", { status: "running" }),
  ];
  assert.throws(
    () => foldVnextRunState(durationRun, durationPlan, [
      ...durationRunning,
      event(durationRun, 4, "run.cancel_requested", {
        actor: { kind: "runtime", id: HOME },
        reason: "budget_run_duration",
        budget: { budgetMs: 100, elapsedMs: 50, source: "workflow" },
      }),
    ]),
    /run_events_illegal/,
  );
  assert.throws(
    () => foldVnextRunState(durationRun, durationPlan, [
      ...durationRunning,
      event(durationRun, 4, "run.cancel_requested", {
        actor: { kind: "runtime", id: HOME },
        reason: "budget_run_duration",
        budget: { budgetMs: 50, elapsedMs: 100, source: "workflow" },
      }),
    ]),
    /run_events_illegal/,
  );
  assert.throws(
    () => foldVnextRunState(durationRun, durationPlan, [
      ...durationRunning,
      event(durationRun, 4, "run.cancel_requested", {
        actor: { kind: "runtime", id: HOME },
        reason: "budget_run_duration",
        budget: { budgetMs: 100, elapsedMs: 100, source: "project" },
      }),
    ]),
    /run_events_illegal/,
  );
  const legalBudgetCancel = foldVnextRunState(durationRun, durationPlan, [
    ...durationRunning,
    event(durationRun, 4, "run.cancel_requested", {
      actor: { kind: "runtime", id: HOME },
      reason: "budget_run_duration",
      budget: { budgetMs: 100, elapsedMs: 100, source: "workflow" },
    }),
    event(durationRun, 5, "run.status_changed", { status: "cancelling", reason: "budget_run_duration" }),
    event(durationRun, 6, "run.status_changed", { status: "cancelled", reason: "budget_run_duration" }),
  ]);
  assert.equal(legalBudgetCancel.status, "cancelled");
  assert.equal(legalBudgetCancel.terminalReason, "budget_run_duration");
  assert.ok(legalBudgetCancel.runningSince);
  const oneStepRun = { ...run, workflowId: "one-step" };
  const running = [
    created,
    event(run, 2, "run.status_changed", { status: "preparing", runPlanHash: PLAN_HASH }),
    event(run, 3, "run.status_changed", { status: "running" }),
    event(run, 4, "step.entered", { stepId: "a", stepAttempt: 1, status: "pending" }),
    event(run, 5, "step.status_changed", { stepId: "a", status: "preparing", previousStatus: "pending" }),
    event(run, 6, "assignment.created", { assignmentId: ASG, stepId: "a", stepAttempt: 1, status: "created" }),
    event(run, 7, "assignment.executing", { assignmentId: ASG, status: "executing" }),
  ];
  assert.throws(() => foldVnextRunState(run, plan, running), /run_events_illegal/);

  assert.equal(foldVnextRunState(run, plan, foldPrefix(run, plan, "running")).status, "running");
  const runningEvents = foldPrefix(run, plan, "running");
  const driveOpened = foldVnextRunState(run, plan, [
    ...runningEvents,
    event(run, runningEvents.length + 1, "run.drive_opened", { driveId: "drv_0123456789abcdef01234567", mode: "simulated" }),
  ]);
  assert.equal(driveOpened.drive?.driveId, "drv_0123456789abcdef01234567");
  const completedEvents = foldPrefix(oneStepRun, oneStep, "completed");
  assert.throws(
    () => foldVnextRunState(oneStepRun, oneStep, [
      ...completedEvents,
      event(oneStepRun, completedEvents.length + 1, "run.drive_opened", { driveId: "drv_0123456789abcdef01234567", mode: "simulated" }),
    ]),
    /run_events_illegal/,
  );
  const executingState = foldVnextRunState(run, plan, foldPrefix(run, plan, "executing"));
  assert.equal(executingState.schema, "kxm.run-state.v2");
  assert.equal(FOLD_PANEL_BOUND, 1);
  assert.deepEqual(executingState.currentStep?.panel.order, [ASG]);
  assert.equal(executingState.currentStep?.assignmentId, ASG);
  assert.equal(executingState.currentStep?.attemptId, ATM);
  assert.equal(executingState.currentStep?.assignmentStatus, "executing");
  assert.equal(executingState.currentStep?.attemptStatus, "executing");
  assert.equal(executingState.currentStep?.panel.assignments[ASG]?.currentAttemptId, ATM);
  assert.equal(executingState.currentStep?.panel.assignments[ASG]?.attempts[ATM]?.status, "executing");
  const starting = foldPrefix(run, plan, "executing").slice(0, 10);
  assert.equal(foldVnextRunState(run, plan, starting).currentStep?.attemptStatus, "starting");
  assert.equal(
    foldVnextRunState(run, plan, [
      ...starting,
      event(run, starting.length + 1, "run.status_changed", { status: "failed", reason: "executing_unrecorded" }),
    ]).status,
    "failed",
  );
  const executingUnrecorded = foldPrefix(run, plan, "executing");
  assert.throws(
    () => foldVnextRunState(run, plan, [
      ...executingUnrecorded,
      event(run, executingUnrecorded.length + 1, "run.status_changed", { status: "failed", reason: "executing_unrecorded" }),
    ]),
    /run_events_illegal/,
  );
  const cancelledSelected = compileVnextWorkflow({
    id: "cancel-terminal",
    value: {
      schema: "kxm.workflow.v1",
      coordinator: "coordinator",
      steps: [{
        id: "only",
        kind: "agent",
        agent: "implementer",
        on: {
          aborted: { target: "$terminal", terminalStatus: "cancelled" },
          passed: { target: "$terminal", terminalStatus: "completed" },
        },
      }],
    },
  });
  const cancelRun = { ...run, workflowId: "cancel-terminal" };
  const selectedCancel = foldPrefix(cancelRun, cancelledSelected, "completed").map((item) => {
    if (item.eventType === "assignment.result_recorded") {
      return event(cancelRun, item.sequence, item.eventType, { assignmentId: ASG, resultClass: "outcome", outcome: "aborted", status: "result_recorded" });
    }
    if (item.eventType === "assignment.terminal") {
      return event(cancelRun, item.sequence, item.eventType, { assignmentId: ASG, outcome: "aborted", status: "terminal" });
    }
    if (item.eventType === "step.outcome_recorded") {
      return event(cancelRun, item.sequence, item.eventType, { stepId: "only", stepAttempt: 1, outcome: "aborted" });
    }
    if (item.eventType === "step.status_changed" && item.payload.status === "passed") {
      return event(cancelRun, item.sequence, item.eventType, { stepId: "only", status: "cancelled", previousStatus: "running" });
    }
    if (item.eventType === "step.transitioned") {
      return event(cancelRun, item.sequence, item.eventType, { fromStepId: "only", status: "cancelled", outcome: "aborted" });
    }
    if (item.eventType === "run.status_changed" && item.payload.status === "completed") {
      return event(cancelRun, item.sequence, item.eventType, { status: "cancelled" });
    }
    return item.eventType === "run.created"
      ? event(cancelRun, 1, "run.created", { workflowId: "cancel-terminal", status: "created", promptHash: cancelRun.promptSha256, repositoryIds: [], executorIds: [] })
      : item;
  });
  assert.equal(foldVnextRunState(cancelRun, cancelledSelected, selectedCancel).status, "cancelled");

  const illegal = (history: VnextRunEvent[], compiled = plan, record = run) => {
    assert.throws(() => foldVnextRunState(record, compiled, history), /run_events_illegal/);
  };
  illegal([event(run, 1, "run.status_changed", { status: "preparing", runPlanHash: PLAN_HASH })]);
  illegal([
    created,
    event(run, 2, "run.status_changed", { status: "preparing", runPlanHash: PLAN_HASH }),
    event(run, 3, "run.status_changed", { status: "running" }),
    event(run, 4, "run.status_changed", { status: "completed" }),
  ]);
  const executing = foldPrefix(run, plan, "executing");
  illegal([
    ...executing,
    event(run, executing.length + 1, "run.status_changed", { status: "completed" }),
  ]);
  const accepted = foldPrefix(run, plan, "running").concat([
    event(run, 7, "assignment.accepted", { assignmentId: "asg_01JFOREIGN000000000000000", status: "accepted" }),
  ]);
  // running prefix already created the assignment at seq 6; replace with a foreign accepted id
  illegal([
    ...foldPrefix(run, plan, "running").slice(0, 6),
    event(run, 7, "assignment.accepted", { assignmentId: "asg_01JFOREIGN000000000000000", status: "accepted" }),
  ]);
  void accepted;
  const outcomeOnce = foldPrefix(run, plan, "outcome");
  illegal([
    ...outcomeOnce,
    event(run, outcomeOnce.length + 1, "step.outcome_recorded", { stepId: "a", stepAttempt: 1, outcome: "passed" }),
  ]);
  const runningStep = foldPrefix(run, plan, "executing");
  illegal([
    ...runningStep,
    event(run, runningStep.length + 1, "attempt.status_changed", { attemptId: ATM, status: "settling" }),
    event(run, runningStep.length + 2, "assignment.result_recorded", { assignmentId: ASG, resultClass: "outcome", outcome: "passed", status: "result_recorded" }),
    event(run, runningStep.length + 3, "attempt.status_changed", { attemptId: ATM, status: "terminal" }),
    event(run, runningStep.length + 4, "assignment.terminal", { assignmentId: ASG, outcome: "passed", status: "terminal" }),
    event(run, runningStep.length + 5, "step.outcome_recorded", { stepId: "a", stepAttempt: 1, outcome: "passed" }),
    event(run, runningStep.length + 6, "step.transitioned", { fromStepId: "a", toStepId: "b", outcome: "passed" }),
  ]);
  const result = foldPrefix(run, plan, "result");
  illegal([
    ...result,
    event(run, result.length + 1, "attempt.status_changed", { attemptId: ATM, status: "terminal" }),
    event(run, result.length + 2, "assignment.terminal", { assignmentId: ASG, outcome: "failed", status: "terminal" }),
  ]);
  illegal([
    created,
    event(run, 2, "run.status_changed", { status: "preparing", runPlanHash: PLAN_HASH }),
    event(run, 3, "run.status_changed", { status: "running" }),
    event(run, 4, "run.status_changed", { status: "cancelled" }),
  ]);
  illegal([
    ...executing,
    event(run, executing.length + 1, "run.cancel_requested", { actor: { kind: "runtime", id: HOME }, reason: "operator_cancel" }),
    event(run, executing.length + 2, "run.status_changed", { status: "cancelling", reason: "operator_cancel" }),
    event(run, executing.length + 3, "run.status_changed", { status: "cancelled", reason: "operator_cancel" }),
  ]);
  illegal([
    created,
    event(run, 2, "run.status_changed", { status: "preparing", runPlanHash: PLAN_HASH }),
    event(run, 3, "run.status_changed", { status: "running" }),
    event(run, 4, "run.status_changed", { status: "waiting" }),
  ]);
  illegal([
    created,
    event(run, 2, "run.status_changed", { status: "cancelled", reason: "operator_cancel" }),
  ]);
  illegal([
    created,
    event(run, 2, "run.status_changed", { status: "preparing", runPlanHash: PLAN_HASH }),
    event(run, 3, "run.status_changed", { status: "cancelled", reason: "operator_cancel" }),
  ]);
  const operatorCreated = [
    created,
    event(run, 2, "run.cancel_requested", { actor: { kind: "runtime", id: HOME }, reason: "operator_cancel" }),
    event(run, 3, "run.status_changed", { status: "cancelled", reason: "operator_cancel" }),
  ];
  const cancelledCreated = foldVnextRunState(run, undefined, operatorCreated);
  assert.equal(cancelledCreated.status, "cancelled");
  assert.equal(cancelledCreated.cancelRequested, true);
  assert.equal(foldVnextRunState(oneStepRun, oneStep, foldPrefix(oneStepRun, oneStep, "completed")).status, "completed");
  const afterAssignment = foldPrefix(run, plan, "executing").slice(0, 6);
  illegal([
    ...afterAssignment,
    event(run, afterAssignment.length + 1, "assignment.created", { assignmentId: "asg_01JSECOND0000000000000000", stepId: "a", stepAttempt: 1, status: "created" }),
  ]);
  const afterAttempt = foldPrefix(run, plan, "executing").slice(0, 8);
  illegal([
    ...afterAttempt,
    event(run, afterAttempt.length + 1, "attempt.created", { attemptId: "atm_01JSECOND00000000000000", assignmentId: ASG, status: "created" }),
  ]);
  illegal([
    ...foldPrefix(run, plan, "executing"),
    event(run, foldPrefix(run, plan, "executing").length + 1, "attempt.status_changed", { attemptId: "atm_01JUNKNOWN0000000000000", status: "settling" }),
  ]);
});

test("U2a-1 join-all panel fold owns per-assignment results", () => {
  const run: VnextRunRecord = {
    runId: "run_01JPANEL000000000000000000",
    projectId: "prj_01JENGINE00000000000000000",
    homeRuntimeId: HOME,
    workflowId: "panel",
    promptSha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    status: "created",
    configRevision: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    memoryRevision: "ctxrev_absent",
    executorPolicyRevision: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    toolPolicyRevision: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
  const illegal = (history: VnextRunEvent[], compiled: ReturnType<typeof compileVnextWorkflow>, record = run) => {
    assert.throws(() => foldVnextRunState(record, compiled, history), /run_events_illegal/);
  };

  const panel = compilePanelPlan({ maximum: 2, maxParallel: 2 });
  const afterFirst = panelPrefix(run, panel, [{ id: ASG, attempt: ATM }], "created");
  const twoCreated = [
    ...afterFirst,
    event(run, afterFirst.length + 1, "assignment.created", {
      assignmentId: ASG2, stepId: "only", stepAttempt: 1, agentId: "implementer", status: "created",
    }),
  ];
  assert.deepEqual(foldVnextRunState(run, panel, twoCreated).currentStep?.panel.order, [ASG, ASG2]);

  const boundOne = compilePanelPlan({ maximum: 1, maxParallel: 1 });
  illegal([
    ...panelPrefix(run, boundOne, [{ id: ASG, attempt: ATM }], "created"),
    event(run, 7, "assignment.created", {
      assignmentId: ASG2, stepId: "only", stepAttempt: 1, agentId: "implementer", status: "created",
    }),
  ], boundOne);

  const gate = compilePanelPlan({ kind: "gate", maximum: 2, maxParallel: 2 });
  illegal([
    ...panelPrefix(run, gate, [{ id: ASG, attempt: ATM }], "created"),
    event(run, 7, "assignment.created", {
      assignmentId: ASG2, stepId: "only", stepAttempt: 1, agentId: "implementer", status: "created",
    }),
  ], gate);

  const quorum = compilePanelPlan({ maximum: 2, maxParallel: 2, joinStrategy: "quorum" });
  illegal([
    ...panelPrefix(run, quorum, [{ id: ASG, attempt: ATM }], "created"),
    event(run, 7, "assignment.created", {
      assignmentId: ASG2, stepId: "only", stepAttempt: 1, agentId: "implementer", status: "created",
    }),
  ], quorum);

  const approval = compilePanelPlan({ kind: "approval", maximum: 2, maxParallel: 2 });
  illegal([
    ...panelPrefix(run, approval, [{ id: ASG, attempt: ATM }], "created"),
    event(run, 7, "assignment.created", {
      assignmentId: ASG2, stepId: "only", stepAttempt: 1, agentId: "implementer", status: "created",
    }),
  ], approval);

  const twoStarting = panelPrefix(run, panel, [
    { id: ASG, attempt: ATM },
    { id: ASG2, attempt: ATM2 },
  ], "starting");
  illegal([
    ...twoStarting,
    event(run, twoStarting.length + 1, "attempt.status_changed", { attemptId: ATM, status: "settling" }),
  ], panel);

  const mixedAThenB = panelMembers(run, panel, [
    { id: ASG, attempt: ATM, resultClass: "outcome", outcome: "passed", terminalOutcome: "passed" },
    { id: ASG2, attempt: ATM2, resultClass: "outcome", outcome: "failed", terminalOutcome: "failed" },
  ]);
  assert.equal(foldVnextRunState(run, panel, mixedAThenB.terminal).currentStep?.panel.assignments[ASG]?.attempts[ATM]?.outcome, "passed");
  assert.equal(foldVnextRunState(run, panel, mixedAThenB.terminal).currentStep?.panel.assignments[ASG2]?.attempts[ATM2]?.outcome, "failed");
  illegal([...mixedAThenB.beforeFirstTerminal, event(run, mixedAThenB.beforeFirstTerminal.length + 1, "assignment.terminal", { assignmentId: ASG, outcome: "failed", status: "terminal" })], panel);

  const mixedBThenA = panelMembers(run, panel, [
    { id: ASG2, attempt: ATM2, resultClass: "outcome", outcome: "failed", terminalOutcome: "failed" },
    { id: ASG, attempt: ATM, resultClass: "outcome", outcome: "passed", terminalOutcome: "passed" },
  ]);
  illegal([...mixedBThenA.beforeFirstTerminal, event(run, mixedBThenA.beforeFirstTerminal.length + 1, "assignment.terminal", { assignmentId: ASG2, outcome: "passed", status: "terminal" })], panel);

  const bothPassed = panelMembers(run, panel, [
    { id: ASG, attempt: ATM, resultClass: "outcome", outcome: "passed", terminalOutcome: "passed" },
    { id: ASG2, attempt: ATM2, resultClass: "outcome", outcome: "passed", terminalOutcome: "passed" },
  ]);
  const passedOutcome = [
    ...bothPassed.terminal,
    event(run, bothPassed.terminal.length + 1, "step.outcome_recorded", { stepId: "only", stepAttempt: 1, outcome: "passed" }),
  ];
  assert.equal(foldVnextRunState(run, panel, passedOutcome).currentStep?.outcome, "passed");
  const passedStep = [
    ...passedOutcome,
    event(run, passedOutcome.length + 1, "step.status_changed", { stepId: "only", status: "passed", previousStatus: "running" }),
  ];
  assert.equal(foldVnextRunState(run, panel, passedStep).currentStep?.status, "passed");
  illegal([...passedOutcome, event(run, passedOutcome.length + 1, "step.outcome_recorded", { stepId: "only", stepAttempt: 1, outcome: "passed" })], panel);

  illegal([...mixedAThenB.terminal, event(run, mixedAThenB.terminal.length + 1, "step.outcome_recorded", { stepId: "only", stepAttempt: 1, outcome: "passed" })], panel);
  const conflictFailed = [
    ...mixedAThenB.terminal,
    event(run, mixedAThenB.terminal.length + 1, "step.status_changed", { stepId: "only", status: "failed", previousStatus: "running" }),
  ];
  assert.equal(foldVnextRunState(run, panel, conflictFailed).currentStep?.status, "failed");
  illegal([
    ...conflictFailed,
    event(run, conflictFailed.length + 1, "step.transitioned", { fromStepId: "only", status: "failed", outcome: "failed" }),
  ], panel);
  assert.equal(foldVnextRunState(run, panel, [
    ...conflictFailed,
    event(run, conflictFailed.length + 1, "run.status_changed", { status: "failed", reason: "join_conflict" }),
  ]).status, "failed");

  const custom = compilePanelPlan({
    maximum: 2,
    maxParallel: 2,
    outcomes: {
      passed: { target: "$terminal", terminalStatus: "completed" },
      failed: { target: "$terminal", terminalStatus: "failed" },
      "needs-work": { target: "$terminal", terminalStatus: "failed" },
    },
  });
  const customMembers = panelMembers(run, custom, [
    { id: ASG, attempt: ATM, resultClass: "outcome", outcome: "needs-work", terminalOutcome: "needs-work" },
    { id: ASG2, attempt: ATM2, resultClass: "outcome", outcome: "needs-work", terminalOutcome: "needs-work" },
  ]);
  const customOutcome = [
    ...customMembers.terminal,
    event(run, customMembers.terminal.length + 1, "step.outcome_recorded", { stepId: "only", stepAttempt: 1, outcome: "needs-work" }),
  ];
  assert.equal(foldVnextRunState(run, custom, customOutcome).currentStep?.outcome, "needs-work");
  illegal([...customOutcome, event(run, customOutcome.length + 1, "step.status_changed", { stepId: "only", status: "passed", previousStatus: "running" })], custom);

  const unknownMix = panelMembers(run, panel, [
    { id: ASG, attempt: ATM, resultClass: "outcome", outcome: "passed", terminalOutcome: "passed" },
    { id: ASG2, attempt: ATM2, resultClass: "outcome_unknown", terminalOutcome: "failed" },
  ]);
  illegal([...unknownMix.terminal, event(run, unknownMix.terminal.length + 1, "step.outcome_recorded", { stepId: "only", stepAttempt: 1, outcome: "passed" })], panel);
  illegal([...unknownMix.terminal, event(run, unknownMix.terminal.length + 1, "step.outcome_recorded", { stepId: "only", stepAttempt: 1, outcome: "failed" })], panel);
  const unknownFailed = [
    ...unknownMix.terminal,
    event(run, unknownMix.terminal.length + 1, "step.status_changed", { stepId: "only", status: "failed", previousStatus: "running" }),
  ];
  assert.equal(foldVnextRunState(run, panel, unknownFailed).currentStep?.status, "failed");
  illegal([
    ...unknownFailed,
    event(run, unknownFailed.length + 1, "step.transitioned", { fromStepId: "only", status: "failed", outcome: "failed" }),
  ], panel);
  assert.equal(foldVnextRunState(run, panel, [
    ...unknownFailed,
    event(run, unknownFailed.length + 1, "run.status_changed", { status: "failed", reason: "outcome_unknown" }),
  ]).status, "failed");

  const rejectedCancel = panelMembers(run, panel, [
    { id: ASG, attempt: ATM, resultClass: "producer_rejected", terminalOutcome: "failed" },
    { id: ASG2, attempt: ATM2, resultClass: "cancelled", terminalOutcome: "cancelled" },
  ]);
  illegal([...rejectedCancel.terminal, event(run, rejectedCancel.terminal.length + 1, "step.status_changed", { stepId: "only", status: "cancelled", previousStatus: "running" })], panel);
  const rejectedFailed = [
    ...rejectedCancel.terminal,
    event(run, rejectedCancel.terminal.length + 1, "step.status_changed", { stepId: "only", status: "failed", previousStatus: "running" }),
  ];
  assert.equal(foldVnextRunState(run, panel, rejectedFailed).currentStep?.status, "failed");
  illegal([
    ...rejectedFailed,
    event(run, rejectedFailed.length + 1, "step.transitioned", { fromStepId: "only", status: "failed", outcome: "failed" }),
  ], panel);

  const allCancelled = panelMembers(run, panel, [
    { id: ASG, attempt: ATM, resultClass: "cancelled", terminalOutcome: "cancelled" },
    { id: ASG2, attempt: ATM2, resultClass: "cancelled", terminalOutcome: "cancelled" },
  ], { cancelRequested: true });
  illegal([...allCancelled.terminal, event(run, allCancelled.terminal.length + 1, "step.status_changed", { stepId: "only", status: "passed", previousStatus: "running" })], panel);
  const cancelledStep = [
    ...allCancelled.terminal,
    event(run, allCancelled.terminal.length + 1, "step.status_changed", { stepId: "only", status: "cancelled", previousStatus: "running" }),
  ];
  assert.equal(foldVnextRunState(run, panel, cancelledStep).currentStep?.status, "cancelled");

  const minTwo = compilePanelPlan({ minimum: 2, maximum: 2, maxParallel: 2 });
  const oneOfTwo = panelMembers(run, minTwo, [
    { id: ASG, attempt: ATM, resultClass: "outcome", outcome: "passed", terminalOutcome: "passed" },
  ]);
  illegal([...oneOfTwo.terminal, event(run, oneOfTwo.terminal.length + 1, "step.status_changed", { stepId: "only", status: "passed", previousStatus: "running" })], minTwo);
  illegal([...oneOfTwo.terminal, event(run, oneOfTwo.terminal.length + 1, "step.status_changed", { stepId: "only", status: "failed", previousStatus: "running" })], minTwo);
  illegal([...oneOfTwo.terminal, event(run, oneOfTwo.terminal.length + 1, "step.status_changed", { stepId: "only", status: "cancelled", previousStatus: "running" })], minTwo);

  const { events: drainEvents, push: drainPush } = panelPush(run);
  panelBootstrap(drainPush, run, true);
  drainPush("assignment.created", { assignmentId: ASG, stepId: "only", stepAttempt: 1, agentId: "implementer", status: "created" });
  drainPush("assignment.created", { assignmentId: ASG2, stepId: "only", stepAttempt: 1, agentId: "implementer", status: "created" });
  drainPush("run.cancel_requested", { actor: { kind: "runtime", id: HOME }, reason: "operator_cancel" });
  illegal([...drainEvents, event(run, drainEvents.length + 1, "step.outcome_recorded", { stepId: "only", stepAttempt: 1, outcome: "passed" })], panel);
  illegal([
    ...drainEvents,
    event(run, drainEvents.length + 1, "step.status_changed", { stepId: "only", status: "cancelled", previousStatus: "running" }),
  ], panel);

  const statusMatrix = compilePanelPlan({
    maximum: 2,
    maxParallel: 2,
    outcomes: {
      passed: { target: "$terminal", terminalStatus: "completed" },
      failed: { target: "$terminal", terminalStatus: "failed" },
      "needs-work": { target: "$terminal", terminalStatus: "failed" },
      cancelled: { target: "$terminal", terminalStatus: "cancelled" },
    },
  });
  const expectedJoinStatus = (outcome: string) => outcome === "passed" ? "passed" : outcome === "cancelled" ? "cancelled" : "failed";
  for (const outcome of ["passed", "needs-work", "cancelled"] as const) {
    const replay = panelMembers(run, statusMatrix, [
      { id: ASG, attempt: ATM, resultClass: "outcome", outcome, terminalOutcome: outcome },
      { id: ASG2, attempt: ATM2, resultClass: "outcome", outcome, terminalOutcome: outcome },
    ]);
    for (const status of ["passed", "failed", "cancelled"] as const) {
      const history = [
        ...replay.terminal,
        event(run, replay.terminal.length + 1, "step.status_changed", { stepId: "only", status, previousStatus: "running" }),
      ];
      if (status === expectedJoinStatus(outcome)) {
        assert.equal(foldVnextRunState(run, statusMatrix, history).currentStep?.status, status);
      } else {
        illegal(history, statusMatrix);
      }
    }
  }

  const terminalThenCreated = panelMembers(run, panel, [
    { id: ASG, attempt: ATM, resultClass: "outcome", outcome: "passed", terminalOutcome: "passed" },
  ]);
  const mixedOwners = [
    ...terminalThenCreated.terminal,
    event(run, terminalThenCreated.terminal.length + 1, "assignment.created", {
      assignmentId: ASG2, stepId: "only", stepAttempt: 1, agentId: "implementer", status: "created",
    }),
  ];
  illegal([...mixedOwners, event(run, mixedOwners.length + 1, "step.status_changed", { stepId: "only", status: "passed", previousStatus: "running" })], panel);
  illegal([...mixedOwners, event(run, mixedOwners.length + 1, "step.status_changed", { stepId: "only", status: "failed", previousStatus: "running" })], panel);
  illegal([...mixedOwners, event(run, mixedOwners.length + 1, "step.status_changed", { stepId: "only", status: "cancelled", previousStatus: "running" })], panel);

  const { events: undersizedCreatedEvents, push: undersizedCreatedPush } = panelPush(run);
  panelBootstrap(undersizedCreatedPush, run, true);
  undersizedCreatedPush("assignment.created", { assignmentId: ASG, stepId: "only", stepAttempt: 1, agentId: "implementer", status: "created" });
  undersizedCreatedPush("run.cancel_requested", { actor: { kind: "runtime", id: HOME }, reason: "operator_cancel" });
  illegal([...undersizedCreatedEvents, event(run, undersizedCreatedEvents.length + 1, "step.status_changed", { stepId: "only", status: "passed", previousStatus: "running" })], minTwo);
  illegal([...undersizedCreatedEvents, event(run, undersizedCreatedEvents.length + 1, "step.status_changed", { stepId: "only", status: "failed", previousStatus: "running" })], minTwo);
  illegal([...undersizedCreatedEvents, event(run, undersizedCreatedEvents.length + 1, "step.status_changed", { stepId: "only", status: "cancelled", previousStatus: "running" })], minTwo);

  const serial = compilePanelPlan({ maximum: 3, maxParallel: 1 });
  const firstStarting = panelPrefix(run, serial, [{ id: ASG, attempt: ATM }], "starting");
  const secondCreated = [
    ...firstStarting,
    event(run, firstStarting.length + 1, "assignment.created", {
      assignmentId: ASG2, stepId: "only", stepAttempt: 1, agentId: "implementer", status: "created",
    }),
    event(run, firstStarting.length + 2, "assignment.accepted", { assignmentId: ASG2, status: "accepted" }),
    event(run, firstStarting.length + 3, "attempt.created", { attemptId: ATM2, assignmentId: ASG2, status: "created" }),
    event(run, firstStarting.length + 4, "assignment.dispatched", { assignmentId: ASG2, capabilityHash: PLAN_HASH, status: "dispatched" }),
  ];
  illegal([...secondCreated, event(run, secondCreated.length + 1, "attempt.status_changed", { attemptId: ATM2, status: "starting" })], serial);
  const firstSettled = panelMembers(run, serial, [
    { id: ASG, attempt: ATM, resultClass: "outcome", outcome: "passed", terminalOutcome: "passed" },
  ]);
  const admitAfter = [
    ...firstSettled.terminal,
    event(run, firstSettled.terminal.length + 1, "assignment.created", {
      assignmentId: ASG2, stepId: "only", stepAttempt: 1, agentId: "implementer", status: "created",
    }),
    event(run, firstSettled.terminal.length + 2, "assignment.accepted", { assignmentId: ASG2, status: "accepted" }),
    event(run, firstSettled.terminal.length + 3, "attempt.created", { attemptId: ATM2, assignmentId: ASG2, status: "created" }),
    event(run, firstSettled.terminal.length + 4, "assignment.dispatched", { assignmentId: ASG2, capabilityHash: PLAN_HASH, status: "dispatched" }),
    event(run, firstSettled.terminal.length + 5, "attempt.status_changed", { attemptId: ATM2, status: "starting" }),
  ];
  assert.equal(foldVnextRunState(run, serial, admitAfter).currentStep?.panel.assignments[ASG2]?.attempts[ATM2]?.status, "starting");

  const third = compilePanelPlan({ maximum: 2, maxParallel: 2 });
  const twoAssignments = panelPrefix(run, third, [
    { id: ASG, attempt: ATM },
    { id: ASG2, attempt: ATM2 },
  ], "created-both");
  illegal([
    ...twoAssignments,
    event(run, twoAssignments.length + 1, "assignment.created", {
      assignmentId: "asg_01JASSIGN30000000000000000", stepId: "only", stepAttempt: 1, agentId: "implementer", status: "created",
    }),
  ], third);

  const secondAttempt = panelPrefix(run, panel, [{ id: ASG, attempt: ATM }], "created");
  const afterAttempt = [
    ...secondAttempt,
    event(run, secondAttempt.length + 1, "assignment.accepted", { assignmentId: ASG, status: "accepted" }),
    event(run, secondAttempt.length + 2, "attempt.created", { attemptId: ATM, assignmentId: ASG, status: "created" }),
  ];
  illegal([...afterAttempt, event(run, afterAttempt.length + 1, "attempt.created", { attemptId: ATM2, assignmentId: ASG, status: "created" })], panel);

  const startThenCancel = panelPrefix(run, panel, [{ id: ASG, attempt: ATM }], "starting");
  const withCancel = [
    ...startThenCancel,
    event(run, startThenCancel.length + 1, "run.cancel_requested", { actor: { kind: "runtime", id: HOME }, reason: "operator_cancel" }),
  ];
  illegal([...withCancel, event(run, withCancel.length + 1, "attempt.status_changed", { attemptId: ATM, status: "settling" })], panel);
  const gateStarting = panelPrefix(run, gate, [{ id: ASG, attempt: ATM }], "starting");
  illegal([...gateStarting, event(run, gateStarting.length + 1, "attempt.status_changed", { attemptId: ATM, status: "settling" })], gate);

  const singletonPlan = compileVnextWorkflow({
    id: "agent-only",
    value: parseRestrictedYaml(readFileSync(join(fixtureDir, "agent-only.yaml"), "utf8"), "agent-only.yaml"),
  });
  const singletonRun = { ...run, workflowId: "agent-only" };
  const executing = foldPrefix(singletonRun, singletonPlan, "executing");
  const executingState = foldVnextRunState(singletonRun, singletonPlan, executing);
  assert.equal(executingState.schema, "kxm.run-state.v2");
  assert.equal(executingState.currentStep?.assignmentId, ASG);
  assert.equal(executingState.currentStep?.attemptId, ATM);
  assert.equal(FOLD_PANEL_BOUND, 1);

  illegal([
    ...passedStep,
    event(run, passedStep.length + 1, "assignment.created", {
      assignmentId: ASG3, stepId: "only", stepAttempt: 1, agentId: "implementer", status: "created",
    }),
  ], panel);
  illegal([
    ...passedOutcome,
    event(run, passedOutcome.length + 1, "attempt.created", { attemptId: ATM3, assignmentId: ASG, status: "created" }),
  ], panel);
  illegal([
    ...passedOutcome,
    event(run, passedOutcome.length + 1, "attempt.status_changed", { attemptId: ATM, status: "starting" }),
  ], panel);
  for (const lateState of ["created", "executing"] as const) {
    const lateEvents = [...passedStep];
    const latePush = (type: string, payload: Record<string, unknown>) => {
      lateEvents.push(event(run, lateEvents.length + 1, type, payload));
    };
    latePush("assignment.created", { assignmentId: ASG3, stepId: "only", stepAttempt: 1, agentId: "implementer", status: "created" });
    if (lateState === "executing") {
      latePush("assignment.accepted", { assignmentId: ASG3, status: "accepted" });
      latePush("attempt.created", { attemptId: ATM3, assignmentId: ASG3, status: "created" });
      latePush("assignment.dispatched", { assignmentId: ASG3, capabilityHash: PLAN_HASH, status: "dispatched" });
      latePush("attempt.status_changed", { attemptId: ATM3, status: "starting" });
      latePush("assignment.executing", { assignmentId: ASG3, status: "executing" });
      latePush("attempt.status_changed", { attemptId: ATM3, status: "executing" });
    }
    illegal(lateEvents, panel);
    illegal([
      ...lateEvents,
      event(run, lateEvents.length + 1, "step.transitioned", { fromStepId: "only", status: "completed", outcome: "passed" }),
    ], panel);
  }
  illegal([
    ...bothPassed.beforeFirstTerminal,
    event(run, bothPassed.beforeFirstTerminal.length + 1, "step.transitioned", { fromStepId: "only", status: "completed", outcome: "passed" }),
  ], panel);

  const cancellingBirth = panelPrefix(run, panel, [{ id: ASG, attempt: ATM }], "starting");
  const cancelThenBirth = [
    ...cancellingBirth,
    event(run, cancellingBirth.length + 1, "run.cancel_requested", { actor: { kind: "runtime", id: HOME }, reason: "operator_cancel" }),
    event(run, cancellingBirth.length + 2, "run.status_changed", { status: "cancelling", reason: "operator_cancel" }),
    event(run, cancellingBirth.length + 3, "assignment.created", {
      assignmentId: ASG2, stepId: "only", stepAttempt: 1, agentId: "implementer", status: "created",
    }),
  ];
  illegal(cancelThenBirth, panel);
  const cancelIntentThenBirth = [
    ...cancellingBirth,
    event(run, cancellingBirth.length + 1, "run.cancel_requested", { actor: { kind: "runtime", id: HOME }, reason: "operator_cancel" }),
    event(run, cancellingBirth.length + 2, "assignment.created", {
      assignmentId: ASG2, stepId: "only", stepAttempt: 1, agentId: "implementer", status: "created",
    }),
  ];
  illegal(cancelIntentThenBirth, panel);
  const cancelIntentThenStart = [
    ...panelPrefix(run, panel, [{ id: ASG, attempt: ATM }], "created"),
    event(run, 7, "run.cancel_requested", { actor: { kind: "runtime", id: HOME }, reason: "operator_cancel" }),
    event(run, 8, "assignment.accepted", { assignmentId: ASG, status: "accepted" }),
    event(run, 9, "attempt.created", { attemptId: ATM, assignmentId: ASG, status: "created" }),
    event(run, 10, "assignment.dispatched", { assignmentId: ASG, capabilityHash: PLAN_HASH, status: "dispatched" }),
    event(run, 11, "attempt.status_changed", { attemptId: ATM, status: "starting" }),
  ];
  illegal(cancelIntentThenStart, panel);

  const maxTwo = compilePanelPlan({ maximum: 2, maxParallel: 2 });
  const twoStartingPanel = panelPrefix(run, maxTwo, [
    { id: ASG, attempt: ATM },
    { id: ASG2, attempt: ATM2 },
  ], "starting");
  illegal([
    ...twoStartingPanel,
    event(run, twoStartingPanel.length + 1, "run.status_changed", { status: "failed", reason: "executing_unrecorded" }),
  ], maxTwo);
  const panelOneStarting = panelPrefix(run, maxTwo, [{ id: ASG, attempt: ATM }], "starting");
  illegal([
    ...panelOneStarting,
    event(run, panelOneStarting.length + 1, "run.status_changed", { status: "failed", reason: "executing_unrecorded" }),
  ], maxTwo);

  const passedCancelled = panelMembers(run, panel, [
    { id: ASG, attempt: ATM, resultClass: "outcome", outcome: "passed", terminalOutcome: "passed" },
    { id: ASG2, attempt: ATM2, resultClass: "cancelled", terminalOutcome: "cancelled" },
  ], { cancelRequested: true });
  const mixedCancelStep = [
    ...passedCancelled.terminal,
    event(run, passedCancelled.terminal.length + 1, "step.status_changed", { stepId: "only", status: "cancelled", previousStatus: "running" }),
  ];
  assert.equal(foldVnextRunState(run, panel, mixedCancelStep).currentStep?.status, "cancelled");
  illegal([
    ...passedCancelled.terminal,
    event(run, passedCancelled.terminal.length + 1, "step.status_changed", { stepId: "only", status: "passed", previousStatus: "running" }),
  ], panel);

  const conflictCancel = panelMembers(run, panel, [
    { id: ASG, attempt: ATM, resultClass: "outcome", outcome: "passed", terminalOutcome: "passed" },
    { id: ASG2, attempt: ATM2, resultClass: "outcome", outcome: "failed", terminalOutcome: "failed" },
  ], { cancelRequested: true });
  illegal([
    ...conflictCancel.terminal,
    event(run, conflictCancel.terminal.length + 1, "step.status_changed", { stepId: "only", status: "cancelled", previousStatus: "running" }),
  ], panel);
  assert.equal(foldVnextRunState(run, panel, [
    ...conflictCancel.terminal,
    event(run, conflictCancel.terminal.length + 1, "step.status_changed", { stepId: "only", status: "failed", previousStatus: "running" }),
  ]).currentStep?.status, "failed");

  const refillPlan = compilePanelPlan({ minimum: 1, target: 3, maximum: 3, maxParallel: 2 });
  const twoPassed = panelMembers(run, refillPlan, [
    { id: ASG, attempt: ATM, resultClass: "outcome", outcome: "passed", terminalOutcome: "passed" },
    { id: ASG2, attempt: ATM2, resultClass: "outcome", outcome: "passed", terminalOutcome: "passed" },
  ], { cancelRequested: true });
  illegal([
    ...twoPassed.terminal,
    event(run, twoPassed.terminal.length + 1, "step.status_changed", { stepId: "only", status: "passed", previousStatus: "running" }),
  ], refillPlan);
  assert.equal(foldVnextRunState(run, refillPlan, [
    ...twoPassed.terminal,
    event(run, twoPassed.terminal.length + 1, "step.status_changed", { stepId: "only", status: "cancelled", previousStatus: "running" }),
  ]).currentStep?.status, "cancelled");

  const joinOnce = vnextJoinAll(panel.steps.only!, foldVnextRunState(run, panel, bothPassed.terminal).currentStep!.panel);
  const joinTwice = vnextJoinAll(panel.steps.only!, foldVnextRunState(run, panel, bothPassed.terminal).currentStep!.panel);
  assert.deepEqual(joinOnce, joinTwice);
  assert.deepEqual(joinOnce, { tag: "outcome", outcome: "passed" });
  const frozenPanel = foldVnextRunState(run, panel, bothPassed.terminal).currentStep!.panel;
  const before = JSON.stringify(frozenPanel);
  vnextJoinAll(panel.steps.only!, frozenPanel);
  assert.equal(JSON.stringify(frozenPanel), before);
});

test("owner map is exact per attempt, refuses duplicates, and cancel aborts one run", async () => {
  const storePath = join(tmpdir(), `kxm-owner-${process.pid}-${Date.now()}`);
  const runA = "run_01JOWNERA00000000000000000";
  const runB = "run_01JOWNERB00000000000000000";
  const first = { attemptId: "atm_01JOWNER1A0000000000000", controller: new AbortController() };
  const sibling = { attemptId: "atm_01JOWNER1B0000000000000", controller: new AbortController() };
  const other = { attemptId: "atm_01JOWNER2A0000000000000", controller: new AbortController() };
  registerVnextAttemptController(storePath, runA, first);
  registerVnextAttemptController(storePath, runA, sibling);
  registerVnextAttemptController(storePath, runB, other);
  assert.equal(vnextAttemptController(storePath, runA, first.attemptId)?.attemptId, first.attemptId);
  assert.equal(vnextAttemptControllers(storePath, runA).length, 2);
  assert.throws(
    () => registerVnextAttemptController(storePath, runA, { attemptId: first.attemptId, controller: new AbortController() }),
    /attempt_controller_duplicate/,
  );
  unregisterVnextAttemptController(storePath, runA, first.attemptId);
  assert.equal(vnextAttemptController(storePath, runA, first.attemptId), undefined);
  assert.equal(vnextAttemptController(storePath, runA, sibling.attemptId)?.attemptId, sibling.attemptId);
  assert.equal(vnextAttemptController(storePath, runB, other.attemptId)?.attemptId, other.attemptId);
  unregisterVnextAttemptController(storePath, runA, sibling.attemptId);
  unregisterVnextAttemptController(storePath, runB, other.attemptId);
  assert.equal(vnextAttemptControllers(storePath, runA).length, 0);

  const { root, stateRoot } = engineProject("kxm-engine-owner-cancel-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const hanging = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "owner-cancel" });
      pinVnextCompiledPlan(context, bundle, hanging.run.runId);
      let resume: (value: { outcome: string }) => void = () => undefined;
      const deferred = new Promise<{ outcome: string }>((resolve) => {
        resume = resolve;
      });
      const extra = new AbortController();
      const survivor = new AbortController();
      const drive = driveVnextRun(context, hanging.run.runId, createVnextSimulatedProducer(async () => deferred));
      const started = Date.now();
      while (vnextAttemptControllers(context.eventStore.path, hanging.run.runId).length === 0) {
        if (Date.now() - started > 2000) throw new Error("attempt controller was not registered");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      registerVnextAttemptController(context.eventStore.path, hanging.run.runId, {
        attemptId: "atm_01JEXTRA0000000000000000",
        controller: extra,
      });
      registerVnextAttemptController(context.eventStore.path, "run_01JSURVIVE000000000000000", {
        attemptId: "atm_01JSURVIVE0000000000000",
        controller: survivor,
      });
      const pending = cancelVnextRun(context, hanging.run.runId);
      assert.equal(pending.run.status, "cancelling");
      assert.equal(extra.signal.aborted, true);
      assert.equal(survivor.signal.aborted, false);
      resume({ outcome: "passed" });
      const settled = await drive;
      assert.equal(settled.state.status, "cancelled");
      unregisterVnextAttemptController(context.eventStore.path, hanging.run.runId, "atm_01JEXTRA0000000000000000");
      unregisterVnextAttemptController(context.eventStore.path, "run_01JSURVIVE000000000000000", "atm_01JSURVIVE0000000000000");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

function writeDurationWorkflow(root: string, name: string, limitsBlock: string): void {
  writeFileSync(join(root, ".kxm", "workflows", `${name}.yaml`), `schema: kxm.workflow.v1
coordinator: coordinator
limits:
${limitsBlock}
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
}

function writeTwoStepDurationWorkflow(root: string, name: string, maxRunDurationMs: number): void {
  writeFileSync(join(root, ".kxm", "workflows", `${name}.yaml`), `schema: kxm.workflow.v1
coordinator: coordinator
limits:
  maxTransitions: 4
  maxRunDurationMs: ${maxRunDurationMs}
steps:
  - id: a
    kind: agent
    agent: implementer
    on:
      passed: b
      failed:
        target: $terminal
        terminalStatus: failed
  - id: b
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
}

function delayUntilAbort(ms: number) {
  return createVnextSimulatedProducer(async (request) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      };
      if (request.signal.aborted) {
        onAbort();
        return;
      }
      request.signal.addEventListener("abort", onAbort, { once: true });
    });
    return { outcome: "passed" };
  });
}

function writePanelWorkflow(
  root: string,
  name: string,
  spec: {
    kind?: "agent" | "moa";
    minimum?: number;
    target?: number;
    maximum?: number;
    maxParallel?: number;
    extraJoin?: string;
    extraAssignments?: string;
    outcomes?: string;
    allowedAgents?: string;
  } = {},
): void {
  const kind = spec.kind ?? "agent";
  const maximum = spec.maximum ?? 2;
  const target = spec.target ?? maximum;
  const maxParallel = spec.maxParallel ?? maximum;
  const minimum = spec.minimum ?? 1;
  const outcomes = spec.outcomes ?? `      passed: { target: $terminal, terminalStatus: completed }
      failed: { target: $terminal, terminalStatus: failed }`;
  writeFileSync(join(root, ".kxm", "workflows", `${name}.yaml`), `schema: kxm.workflow.v1
coordinator: coordinator
steps:
  - id: only
    kind: ${kind}
    agent: implementer
    assignments:
      ${spec.allowedAgents ?? "allowedAgents: [implementer, coordinator]"}
      minimum: ${minimum}
      target: ${target}
      maximum: ${maximum}
      maxParallel: ${maxParallel}
      ${spec.extraAssignments ?? ""}
    join:
      strategy: all
      ${spec.extraJoin ?? ""}
    on:
${outcomes}
`);
}

function resetPanelSeams(): void {
  vnextPanelDispatchSeams.afterBirth = undefined;
  vnextPanelDispatchSeams.beforeAppendExecuting = undefined;
  vnextPanelDispatchSeams.failAppendExecuting = undefined;
  vnextPanelDispatchSeams.beforeInvoke = undefined;
  vnextPanelDispatchSeams.failSettleMember = undefined;
  vnextPanelDispatchSeams.skipDispatch = undefined;
}

test("U2a-2 panel target 2 maxParallel 2 settles both members then joins once", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-u2a2-p1-");
  try {
    writePanelWorkflow(root, "panel-two");
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "panel-two", prompt: "p1" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const seen: string[] = [];
      const driven = await driveVnextRun(context, accepted.run.runId, createVnextSimulatedProducer((request) => {
        seen.push(request.attemptId);
        verifyVnextAttemptCapability(context, request.capability, { runId: request.runId, attemptId: request.attemptId });
        return { outcome: "passed" };
      }));
      assert.equal(driven.state.status, "completed");
      assert.equal(seen.length, 2);
      const events = context.eventStore.events(accepted.run.runId, 0, 10_000);
      assert.equal(events.filter((event) => event.eventType === "assignment.created").length, 2);
      assert.equal(events.filter((event) => event.eventType === "step.outcome_recorded").length, 1);
      assert.equal(events.filter((event) => event.eventType === "step.transitioned").length, 1);
      assert.equal(vnextAttemptControllers(context.eventStore.path, accepted.run.runId).length, 0);
      const caps = events.filter((event) => event.eventType === "attempt.created").map((event) => String(event.payload.attemptId));
      for (const attemptId of caps) {
        assert.equal(context.eventStore.capabilityByAttempt(attemptId)?.state, "settled");
      }
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("U2a-2 maxParallel 1 births second member only after first settlement commit", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-u2a2-p2-");
  try {
    writePanelWorkflow(root, "panel-serial", { maximum: 2, maxParallel: 1 });
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "panel-serial", prompt: "p2" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const driven = await driveVnextRun(context, accepted.run.runId, outcomes(["passed", "passed"]));
      assert.equal(driven.state.status, "completed");
      const events = context.eventStore.events(accepted.run.runId, 0, 10_000);
      const created = events.filter((event) => event.eventType === "assignment.created");
      const terminals = events.filter((event) => event.eventType === "assignment.terminal");
      assert.equal(created.length, 2);
      assert.equal(terminals.length, 2);
      assert.ok(terminals[0]!.sequence < created[1]!.sequence);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("U2a-2 target 2 within maximum 3 births exactly target members", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-u2a2-p3-");
  try {
    writePanelWorkflow(root, "panel-target", { target: 2, maximum: 3, maxParallel: 2 });
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "panel-target", prompt: "p3" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const driven = await driveVnextRun(context, accepted.run.runId, outcomes(["passed", "passed"]));
      assert.equal(driven.state.status, "completed");
      assert.equal(context.eventStore.events(accepted.run.runId, 0, 10_000).filter((event) => event.eventType === "assignment.created").length, 2);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("U2a-2 custom-done panel reaches compiled cancelled terminal with step failed", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-u2a2-p4-");
  try {
    writePanelWorkflow(root, "panel-custom", {
      outcomes: `      passed: { target: $terminal, terminalStatus: completed }
      custom-done: { target: $terminal, terminalStatus: cancelled }`,
    });
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "panel-custom", prompt: "p4" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const driven = await driveVnextRun(context, accepted.run.runId, createVnextSimulatedProducer(() => ({ outcome: "custom-done" })));
      assert.equal(driven.state.status, "cancelled");
      const events = context.eventStore.events(accepted.run.runId, 0, 10_000);
      assert.equal(events.find((event) => event.eventType === "step.outcome_recorded")?.payload.outcome, "custom-done");
      const terminalStep = events.find((event) =>
        event.eventType === "step.status_changed"
        && (event.payload.status === "passed" || event.payload.status === "failed" || event.payload.status === "cancelled")
      );
      assert.equal(terminalStep?.payload.status, "failed");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("U2a-2 member outcome conflict joins failed after both members settle", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-u2a2-p5-");
  try {
    writePanelWorkflow(root, "panel-conflict");
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "panel-conflict", prompt: "p5" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const driven = await driveVnextRun(context, accepted.run.runId, outcomes(["passed", "failed"]));
      assert.equal(driven.state.status, "failed");
      assert.equal(driven.state.terminalReason, "join_conflict");
      const events = context.eventStore.events(accepted.run.runId, 0, 10_000);
      assert.equal(events.filter((event) => event.eventType === "assignment.terminal").length, 2);
      assert.equal(events.filter((event) => event.eventType === "step.outcome_recorded").length, 0);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("U2a-2 producer_rejected member joins rejected only after sibling drains", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-u2a2-p6-");
  try {
    writePanelWorkflow(root, "panel-reject");
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "panel-reject", prompt: "p6" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      let releaseSibling: (value: { outcome: string }) => void = () => undefined;
      const sibling = new Promise<{ outcome: string }>((resolve) => {
        releaseSibling = resolve;
      });
      let first = true;
      let rejectedFirst = false;
      const drivenP = driveVnextRun(context, accepted.run.runId, createVnextSimulatedProducer(async () => {
        if (first) {
          first = false;
          rejectedFirst = true;
          throw new Error("producer boom");
        }
        return sibling;
      }));
      while (!rejectedFirst) await Promise.resolve();
      assert.equal(context.eventStore.run(accepted.run.runId)?.status, "running");
      releaseSibling({ outcome: "passed" });
      const driven = await drivenP;
      assert.equal(driven.state.status, "failed");
      assert.equal(driven.state.terminalReason, "outcome_unknown");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("U2a-2 cancel from another handle drains issued members and never births the unissued third", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-u2a2-p7-");
  const otherRoot = { root, stateRoot };
  try {
    writePanelWorkflow(root, "panel-cancel", { target: 3, maximum: 3, maxParallel: 2 });
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    const other = openVnextRuntimeContext(otherRoot.root, { stateRoot: otherRoot.stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "panel-cancel", prompt: "p7" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      let started = 0;
      let bothStarted: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        bothStarted = resolve;
      });
      const drive = driveVnextRun(context, accepted.run.runId, createVnextSimulatedProducer(async (request) => {
        started += 1;
        if (started === 2) bothStarted();
        await new Promise((_, reject) => {
          if (request.signal.aborted) reject(new Error("aborted"));
          request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
        return { outcome: "passed" };
      }));
      await ready;
      const cancel = cancelVnextRun(other, accepted.run.runId);
      assert.equal(cancel.run.status, "cancelling");
      const done = await drive;
      assert.equal(done.state.status, "cancelled");
      const events = context.eventStore.events(accepted.run.runId, 0, 10_000);
      const created = events.filter((event) => event.eventType === "assignment.created");
      assert.equal(created.length, 2);
      const cancellingAt = events.find((event) => event.eventType === "run.status_changed" && event.payload.status === "cancelling")?.sequence;
      assert.ok(cancellingAt);
      assert.equal(created.every((event) => event.sequence < cancellingAt), true);
    } finally {
      closeVnextRuntimeContext(other);
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("U2a-2 cancel with one passed member and one executing ends cancelled not failed", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-u2a2-p8-");
  try {
    writePanelWorkflow(root, "panel-mixed-cancel", { maxParallel: 1, maximum: 2 });
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "panel-mixed-cancel", prompt: "p8" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      let second = false;
      let secondStarted: (request: { signal: AbortSignal }) => void = () => undefined;
      const ready = new Promise<{ signal: AbortSignal }>((resolve) => {
        secondStarted = resolve;
      });
      const drive = driveVnextRun(context, accepted.run.runId, createVnextSimulatedProducer(async (request) => {
        if (!second) {
          second = true;
          return { outcome: "passed" };
        }
        secondStarted(request);
        await new Promise((_, reject) => {
          if (request.signal.aborted) reject(new Error("aborted"));
          request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
        return { outcome: "failed" };
      }));
      const hanging = await ready;
      assert.equal(hanging.signal.aborted, false);
      const cancel = cancelVnextRun(context, accepted.run.runId);
      assert.equal(cancel.run.status, "cancelling");
      const done = await drive;
      assert.equal(done.state.status, "cancelled");
      assert.notEqual(done.state.status, "failed");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("U2a-2 capability verify accepts each executing member and rejects a settled sibling", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-u2a2-p9-");
  try {
    writePanelWorkflow(root, "panel-cap", { maxParallel: 1, maximum: 2 });
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "panel-cap", prompt: "p9" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const secrets: Array<{ secret: string; attemptId: string; assignmentId: string }> = [];
      const driven = await driveVnextRun(context, accepted.run.runId, createVnextSimulatedProducer((request) => {
        secrets.push({ secret: request.capability, attemptId: request.attemptId, assignmentId: request.assignmentId });
        verifyVnextAttemptCapability(context, request.capability, { runId: request.runId, attemptId: request.attemptId });
        if (secrets.length === 2) {
          assert.throws(
            () => verifyVnextAttemptCapability(context, secrets[0]!.secret, { runId: request.runId, attemptId: secrets[0]!.attemptId }),
            /capability_rejected/,
          );
          assert.throws(
            () => verifyVnextAttemptCapability(context, request.capability, { runId: request.runId, attemptId: secrets[0]!.attemptId }),
            /capability_rejected/,
          );
          assert.throws(
            () => verifyVnextAttemptCapability(context, request.capability, { runId: "run_01JWRONG00000000000000000", attemptId: request.attemptId }),
            /capability_rejected/,
          );
        }
        return { outcome: "passed" };
      }));
      assert.equal(driven.state.status, "completed");
      assert.equal(secrets.length, 2);
      assert.throws(
        () => verifyVnextAttemptCapability(context, secrets[1]!.secret, { runId: accepted.run.runId, attemptId: secrets[1]!.attemptId }),
        /capability_rejected/,
      );
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("U2a-2 moa join-all step dispatches like agent", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-u2a2-p10-");
  try {
    writePanelWorkflow(root, "panel-moa", { kind: "moa" });
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "panel-moa", prompt: "p10" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const driven = await driveVnextRun(context, accepted.run.runId, outcomes(["passed", "passed"]));
      assert.equal(driven.state.status, "completed");
      assert.equal(context.eventStore.events(accepted.run.runId, 0, 10_000).filter((event) => event.eventType === "assignment.created").length, 2);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("U2a-2 engine hands off cancelRemaining, minimumPassed, maxAttemptsPerAssignment 3 as step_unsupported", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-u2a2-n8-");
  try {
    const cases = [
      { name: "panel-minpass", extraJoin: "minimumPassed: 1", field: "join.minimumPassed" },
      { name: "panel-cancel-rem", extraJoin: "cancelRemaining: true", field: "join.cancelRemaining" },
      { name: "panel-retry", extraAssignments: "maxAttemptsPerAssignment: 3", field: "assignments.maxAttemptsPerAssignment" },
    ];
    const bundleBase = loadVnextProject(root);
    void bundleBase;
    for (const item of cases) {
      writePanelWorkflow(root, item.name, {
        ...(item.extraJoin !== undefined ? { extraJoin: item.extraJoin } : {}),
        ...(item.extraAssignments !== undefined ? { extraAssignments: item.extraAssignments } : {}),
        maximum: 1,
        maxParallel: 1,
        allowedAgents: "allowedAgents: [implementer]",
      });
      const bundle = loadVnextProject(root);
      const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
      try {
        const accepted = acceptVnextRun(context, bundle, { workflowId: item.name, prompt: item.name });
        pinVnextCompiledPlan(context, bundle, accepted.run.runId);
        startVnextRun(context, accepted.run.runId);
        const blocked = await stepVnextRun(context, accepted.run.runId, outcomes(["passed"]));
        assert.equal(blocked.handoff?.reason, "step_unsupported");
        assert.equal(blocked.handoff?.field, item.field);
        assert.equal(blocked.state.status, "running");
      } finally {
        closeVnextRuntimeContext(context);
      }
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("U2a-2 appendExecuting failure with active sibling drains and does not mint executing_unrecorded", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-u2a2-n9-");
  try {
    writePanelWorkflow(root, "panel-append-fail");
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    resetPanelSeams();
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "panel-append-fail", prompt: "n9" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      let born = 0;
      vnextPanelDispatchSeams.afterBirth = () => {
        born += 1;
      };
      vnextPanelDispatchSeams.failAppendExecuting = () => born >= 2;
      const driven = await driveVnextRun(context, accepted.run.runId, createVnextSimulatedProducer(async (request) => {
        await new Promise((_, reject) => {
          if (request.signal.aborted) reject(new Error("aborted"));
          request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
        return { outcome: "passed" };
      }));
      assert.equal(driven.handoff?.reason, "attempt_unreconciled");
      assert.notEqual(driven.state.status, "failed");
      assert.notEqual(driven.state.status, "completed");
      const events = context.eventStore.events(accepted.run.runId, 0, 10_000);
      assert.equal(events.some((event) => event.payload.reason === "executing_unrecorded"), false);
      assert.equal(vnextAttemptControllers(context.eventStore.path, accepted.run.runId).length, 0);
      const starting = driven.state.currentStep?.panel.order
        .map((id) => driven.state.currentStep?.panel.assignments[id])
        .some((assignment) => Object.values(assignment?.attempts ?? {}).some((attempt) => attempt.status === "starting"));
      assert.equal(starting, true);
    } finally {
      resetPanelSeams();
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

for (const cancelling of [false, true]) {
test(`unobserved producer termination retains its capability and drains siblings (cancel=${cancelling})`, async () => {
  const { root, stateRoot } = engineProject("kxm-unobserved-exit-");
  try {
    writePanelWorkflow(root, "unobserved-exit");
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "unobserved-exit", prompt: "termination witness" });
      const runId = accepted.run.runId;
      pinVnextCompiledPlan(context, bundle, runId);
      const seen: string[] = [];
      let bothReady!: () => void;
      const ready = new Promise<void>((resolve) => { bothReady = resolve; });
      const producer = createVnextSimulatedProducer(async (request) => {
        const index = seen.length;
        seen.push(request.attemptId);
        if (seen.length === 2) bothReady();
        await ready;
        if (index === 0) {
          if (cancelling) cancelVnextRun(context, runId);
          return { outcome: "failed", effectUncertain: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { outcome: "passed" };
      });
      const driven = await driveVnextRun(context, runId, producer);
      assert.equal(driven.handoff?.reason, "attempt_unreconciled");
      assert.equal(driven.state.status, cancelling ? "cancelling" : "running");
      assert.equal(context.eventStore.capabilityByAttempt(seen[0]!)?.state, cancelling ? "revoked" : "issued");
      assert.equal(context.eventStore.capabilityByAttempt(seen[1]!)?.state, "settled");
      const events = context.eventStore.events(runId, 0, 1000);
      const terminals = events.filter((event) => event.eventType === "assignment.terminal");
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0]!.payload.outcome, cancelling ? "cancelled" : "passed");
      assert.equal(events.filter((event) => event.eventType === "step.outcome_recorded").length, 0);
      await driveVnextRun(context, runId, producer);
      assert.equal(seen.length, 2, "uncertain work must not be replayed");
      assert.equal(vnextAttemptControllers(context.eventStore.path, runId).length, 0);
    } finally { closeVnextRuntimeContext(context); }
  } finally { removeTempDir(root, stateRoot); }
});
}

test("U2a-2 settlement write failure with active sibling retains uncertainty", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-u2a2-settle-fail-");
  try {
    writePanelWorkflow(root, "panel-settle-fail");
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    resetPanelSeams();
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "panel-settle-fail", prompt: "settle-fail" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      let settles = 0;
      vnextPanelDispatchSeams.failSettleMember = () => {
        settles += 1;
        return settles === 1;
      };
      const driven = await driveVnextRun(context, accepted.run.runId, outcomes(["passed", "passed"]));
      assert.equal(driven.handoff?.reason, "attempt_unreconciled");
      assert.notEqual(driven.state.status, "completed");
      assert.notEqual(driven.state.status, "failed");
      assert.equal(vnextAttemptControllers(context.eventStore.path, accepted.run.runId).length, 0);
    } finally {
      resetPanelSeams();
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("U2a-2 prepareDispatch reports attempt_unreconciled for any executing panel member", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-u2a2-n10-");
  try {
    writePanelWorkflow(root, "panel-unrec");
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    resetPanelSeams();
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "panel-unrec", prompt: "n10" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      let born = 0;
      vnextPanelDispatchSeams.afterBirth = () => {
        born += 1;
      };
      vnextPanelDispatchSeams.failAppendExecuting = () => born >= 2;
      const first = await driveVnextRun(context, accepted.run.runId, createVnextSimulatedProducer(async (request) => {
        await new Promise((_, reject) => {
          if (request.signal.aborted) reject(new Error("aborted"));
          request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
        return { outcome: "passed" };
      }));
      assert.equal(first.handoff?.reason, "attempt_unreconciled");
      const again = await stepVnextRun(context, accepted.run.runId, outcomes(["passed"]));
      assert.equal(again.handoff?.reason, "attempt_unreconciled");
      assert.ok(again.handoff?.attemptId);
      assert.equal(again.state.status === "completed" || again.state.status === "failed", false);
    } finally {
      resetPanelSeams();
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("U2a-2 cancelled between executing record and invoke must not call producer", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-u2a2-cancel-invoke-");
  try {
    writePanelWorkflow(root, "panel-cancel-invoke", { maximum: 2, target: 2, maxParallel: 1 });
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    resetPanelSeams();
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "panel-cancel-invoke", prompt: "cancel-invoke" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      let calls = 0;
      vnextPanelDispatchSeams.beforeInvoke = () => {
        cancelVnextRun(context, accepted.run.runId);
      };
      const driven = await driveVnextRun(context, accepted.run.runId, createVnextSimulatedProducer(() => {
        calls += 1;
        return { outcome: "passed" };
      }));
      assert.equal(calls, 0, "revoked work must never be invoked");
      assert.equal(driven.handoff?.reason, "attempt_unreconciled");
    } finally {
      resetPanelSeams();
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("U2a-2 birth exception must drain active sibling before releasing owner", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-u2a2-birth-exception-");
  let release = (): void => undefined;
  try {
    writePanelWorkflow(root, "panel-birth-error", { maximum: 2, target: 2, maxParallel: 2 });
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    resetPanelSeams();
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "panel-birth-error", prompt: "birth-error" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      let born = 0;
      vnextPanelDispatchSeams.afterBirth = () => {
        born += 1;
        if (born === 2) throw new Error("root second birth failure");
      };
      let finished = false;
      let callbackFinished = false;
      const deferred = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = driveVnextRun(context, accepted.run.runId, createVnextSimulatedProducer(async () => {
        await deferred;
        callbackFinished = true;
        return { outcome: "passed" };
      })).then((value) => {
        finished = true;
        return { value };
      }, (error) => {
        finished = true;
        return { error: String(error) };
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const early = {
        finished,
        callbackFinished,
        owners: vnextAttemptControllers(context.eventStore.path, accepted.run.runId).length,
      };
      release();
      await pending;
      assert.equal(early.finished, false, "drive must not finish while its callback remains active");
      assert.equal(early.owners, 1, "active callback must retain its controller");
    } finally {
      release();
      resetPanelSeams();
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("U2a-2 cleanup must match pending result by attempt after earlier settlement", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-u2a2-pending-identity-");
  try {
    writePanelWorkflow(root, "panel-pending-identity", { maximum: 3, target: 3, maxParallel: 2 });
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    resetPanelSeams();
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "panel-pending-identity", prompt: "pending-identity" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      let born = 0;
      vnextPanelDispatchSeams.afterBirth = () => {
        born += 1;
        if (born === 3) throw new Error("root third birth failure");
      };
      let calls = 0;
      const done = await driveVnextRun(context, accepted.run.runId, createVnextSimulatedProducer(async (request) => {
        calls += 1;
        if (calls === 1) return { outcome: "passed" };
        await new Promise<void>((_, reject) => {
          if (request.signal.aborted) reject(new Error("aborted"));
          else request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return { outcome: "passed" };
      }));
      const attempts = done.state.currentStep?.panel.order.flatMap((assignmentId) =>
        Object.entries(done.state.currentStep!.panel.assignments[assignmentId]!.attempts).map(([id, attempt]) => ({
          id,
          status: attempt.status,
        }))
      ) ?? [];
      assert.equal(calls, 2);
      assert.equal(attempts.every((attempt) => attempt.status === "terminal"), true, "every drained invoked sibling must be truthfully settled by its own identity");
    } finally {
      resetPanelSeams();
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("U2a-2 capability hash replacement before invoke must reject dispatch", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-u2a2-capability-hash-");
  try {
    writePanelWorkflow(root, "panel-capability-hash", { maximum: 2, target: 2, maxParallel: 1 });
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    resetPanelSeams();
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "panel-capability-hash", prompt: "capability-hash" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      vnextPanelDispatchSeams.beforeInvoke = (member) => {
        const db = new DatabaseSync(context.eventStore.path);
        try {
          db.prepare("UPDATE attempt_capabilities SET capability_hash = ? WHERE attempt_id = ?").run("a".repeat(64), member.attemptId);
        } finally {
          db.close();
        }
      };
      let calls = 0;
      const done = await driveVnextRun(context, accepted.run.runId, createVnextSimulatedProducer(() => {
        calls += 1;
        return { outcome: "passed" };
      }));
      assert.equal(calls, 0, "dispatch must reject a capability hash different from the minted owner capability");
      assert.equal(done.handoff?.reason, "attempt_unreconciled");
    } finally {
      resetPanelSeams();
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("stale v1 run_state fails closed on read, drive, and cancel without rewrite", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-v1-proj-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "v1-proj" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const driven = await driveVnextRun(context, accepted.run.runId, outcomes(["passed"]));
      assert.equal(driven.state.status, "completed");
      assert.equal(driven.state.schema, "kxm.run-state.v2");
      const stored = context.eventStore.runState(accepted.run.runId)!;
      const v1 = stored.state.replaceAll("kxm.run-state.v2", "kxm.run-state.v1");
      assert.notEqual(v1, stored.state);
      const db = new DatabaseSync(context.eventStore.path);
      db.prepare("UPDATE run_state SET state = ? WHERE run_id = ?").run(v1, accepted.run.runId);
      db.close();
      assert.equal(context.eventStore.runState(accepted.run.runId)!.state, v1);
      const run = context.eventStore.run(accepted.run.runId)!;
      assert.throws(() => readVnextRunStatus(context, run), /run_projection_divergent/);
      assert.equal(context.eventStore.runState(accepted.run.runId)!.state, v1);
      await assert.rejects(() => driveVnextRun(context, accepted.run.runId, outcomes(["passed"])), /run_projection_divergent/);
      assert.equal(context.eventStore.runState(accepted.run.runId)!.state, v1);
      assert.throws(() => cancelVnextRun(context, accepted.run.runId), /run_projection_divergent/);
      assert.equal(context.eventStore.runState(accepted.run.runId)!.state, v1);
      assert.throws(() => rebuildVnextRunProjection(context, accepted.run.runId), /run_projection_divergent/);
      assert.equal(context.eventStore.runState(accepted.run.runId)!.state, v1);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("objective propagation: producer context packet receives accepted run prompt with sha256 integrity check", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-prompt-prop-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const prompt = "Implement cryptographic hash integrity for objective propagation";
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      let capturedObjective: string | undefined;
      const producer = createVnextSimulatedProducer(async (request) => {
        capturedObjective = request.contextPacket?.task.objective;
        return { outcome: "passed" };
      });
      const driven = await driveVnextRun(context, accepted.run.runId, producer);
      assert.equal(driven.state.status, "completed");
      assert.equal(capturedObjective, prompt);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("objective propagation: birth fails closed if stored prompt is tampered or missing", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-prompt-tamper-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const prompt = "Original prompt";
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);

      context.eventStore.putRunPrompt(accepted.run.runId, "Tampered prompt");

      const producer = createVnextSimulatedProducer(async () => ({ outcome: "passed" }));
      await assert.rejects(
        () => driveVnextRun(context, accepted.run.runId, producer),
        /run_prompt_mismatch/,
      );
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("permission ceiling: steps without write repository receive read-only ceiling", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-perm-ro-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "Test read-only ceiling" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      let capturedCeiling: string | undefined;
      const producer = createVnextSimulatedProducer(async (request) => {
        capturedCeiling = request.contextPacket?.task.permissionCeiling;
        return { outcome: "passed" };
      });
      const driven = await driveVnextRun(context, accepted.run.runId, producer);
      assert.equal(driven.state.status, "completed");
      assert.equal(capturedCeiling, "read-only");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("permission ceiling: write step with simulated producer receives edit ceiling", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-perm-wr-sim-");
  try {
    writeFileSync(join(root, ".kxm", "workflows", "write-step.yaml"), `schema: kxm.workflow.v1
description: Write step workflow
coordinator: coordinator
limits:
  maxTransitions: 2
steps:
  - id: write-step
    kind: agent
    agent: implementer
    repositories:
      control: write
    on:
      passed:
        target: $terminal
        terminalStatus: completed
      failed:
        target: $terminal
        terminalStatus: failed
`);
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "write-step", prompt: "Test write step" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      let capturedCeiling: string | undefined;
      const producer = createVnextSimulatedProducer(async (request) => {
        capturedCeiling = request.contextPacket?.task.permissionCeiling;
        return { outcome: "passed" };
      });
      const driven = await driveVnextRun(context, accepted.run.runId, producer);
      assert.equal(driven.state.status, "completed");
      assert.equal(capturedCeiling, "edit");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("permission ceiling: live write step fails closed with step_unsupported handoff before birth", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-perm-wr-live-");
  try {
    writeFileSync(join(root, ".kxm", "workflows", "write-step.yaml"), `schema: kxm.workflow.v1
description: Write step workflow
coordinator: coordinator
limits:
  maxTransitions: 2
steps:
  - id: write-step
    kind: agent
    agent: implementer
    repositories:
      control: write
    on:
      passed:
        target: $terminal
        terminalStatus: completed
      failed:
        target: $terminal
        terminalStatus: failed
`);
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "write-step", prompt: "Test live write" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);

      const liveProducer = {
        id: "oneshot" as const,
        async produce() {
          return {
            outcome: "passed" as const,
            costBasis: "unmetered" as const,
            tokensIn: null,
            tokensOut: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            latencyMs: 10,
          };
        },
      };
      registerTrustedProducer(liveProducer as never);

      const result = await driveVnextRun(context, accepted.run.runId, liveProducer as never);
      assert.equal(result.handoff?.reason, "step_unsupported");
      assert.equal(result.handoff?.field, "repositories");
      assert.equal(result.handoff?.stepId, "write-step");

      // Verify zero assignment.created events
      const events = context.eventStore.events(accepted.run.runId, 0, 100);
      const assignmentCreated = events.filter((e) => e.eventType === "assignment.created");
      assert.equal(assignmentCreated.length, 0);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("admission: agent without model returns handoff before birth", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-adm-no-model-");
  try {
    writeFileSync(join(root, ".kxm", "agents", "no-model-agent.yaml"), `schema: kxm.agent.v1
purpose: Test agent without model
harness: grok
tools:
  preset: read-only
defaultRepositoryAccess: none
network: provider-only
resultSchema: kxm.assignment-result.v1
`);
    writeFileSync(join(root, ".kxm", "workflows", "no-model-flow.yaml"), `schema: kxm.workflow.v1
description: Test flow
coordinator: coordinator
limits:
  maxTransitions: 2
steps:
  - id: step1
    kind: agent
    agent: no-model-agent
    on:
      passed:
        target: $terminal
        terminalStatus: completed
      failed:
        target: $terminal
        terminalStatus: failed
`);
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "no-model-flow", prompt: "Test no model" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);

      const liveProducer = {
        id: "oneshot" as const,
        async produce() {
          return { outcome: "passed" as const, costBasis: "unmetered" as const, latencyMs: 10 };
        },
      };
      registerTrustedProducer(liveProducer as never);

      const result = await driveVnextRun(context, accepted.run.runId, liveProducer as never);
      assert.equal(result.handoff?.reason, "step_unsupported");
      assert.equal(result.handoff?.field, "model");

      const events = context.eventStore.events(accepted.run.runId, 0, 100);
      assert.equal(events.filter((e) => e.eventType === "assignment.created").length, 0);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("admission: demoted selector returns handoff before birth", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-adm-demoted-");
  try {
    // implementer has model xai/grok-4.6 in engineProject; explicitly demote it
    updateProducer(root, "xai/grok-4.6", "demoted");

    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "Test demoted" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);

      const liveProducer = {
        id: "oneshot" as const,
        async produce() {
          return { outcome: "passed" as const, costBasis: "unmetered" as const, latencyMs: 10 };
        },
      };
      registerTrustedProducer(liveProducer as never);

      const result = await driveVnextRun(context, accepted.run.runId, liveProducer as never);
      assert.equal(result.handoff?.reason, "step_unsupported");
      assert.equal(result.handoff?.field, "model");

      const events = context.eventStore.events(accepted.run.runId, 0, 100);
      assert.equal(events.filter((e) => e.eventType === "assignment.created").length, 0);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("admission: role roster excludes model returns handoff before birth", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-adm-roster-");
  try {
    // Promote and enable model in producer policy
    setModelState(root, "xai/grok-4.6", "enabled");
    updateProducer(root, "xai/grok-4.6", "promoted");
    // But write writer role roster without xai/grok-4.6
    mkdirSync(join(root, ".kxm", "roles"), { recursive: true });
    writeFileSync(join(root, ".kxm", "roles", "writer.yaml"), `schema: kxm.role.v1
id: writer
roster:
  - model: other-provider/other-model
    enabled: true
`);

    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "Test roster exclusion" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);

      const liveProducer = {
        id: "oneshot" as const,
        async produce() {
          return { outcome: "passed" as const, costBasis: "unmetered" as const, latencyMs: 10 };
        },
      };
      registerTrustedProducer(liveProducer as never);

      const result = await driveVnextRun(context, accepted.run.runId, liveProducer as never);
      assert.equal(result.handoff?.reason, "step_unsupported");
      assert.equal(result.handoff?.field, "model");

      const events = context.eventStore.events(accepted.run.runId, 0, 100);
      assert.equal(events.filter((e) => e.eventType === "assignment.created").length, 0);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("admission: admitted route records producerId oneshot in capability row", async () => {
  const { root, stateRoot } = engineProject("kxm-engine-adm-cap-oneshot-");
  try {
    // Ensure xai/grok-4.6 is enabled, promoted, and in writer roster
    setModelState(root, "xai/grok-4.6", "enabled", "writer");
    updateProducer(root, "xai/grok-4.6", "promoted");

    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "one-step", prompt: "Test capability oneshot" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);

      const liveProducer = {
        id: "oneshot" as const,
        async produce() {
          return { outcome: "passed" as const, costBasis: "unmetered" as const, latencyMs: 10 };
        },
      };
      registerTrustedProducer(liveProducer as never);

      const result = await driveVnextRun(context, accepted.run.runId, liveProducer as never);
      assert.equal(result.state.status, "completed");

      const db = new DatabaseSync(context.eventStore.path);
      const row = db.prepare("SELECT producer_id FROM attempt_capabilities WHERE run_id = ?").get(accepted.run.runId) as { producer_id: string } | undefined;
      db.close();

      assert.equal(row?.producer_id, "oneshot");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("full-shape rehydration rejects malformed envelopes with matching hashes", () => {
  const { root, stateRoot } = engineProject("kxm-engine-shape-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "agent-only", prompt: "shape" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const run = context.eventStore.run(accepted.run.runId)!;
      const row = context.eventStore.runPlan(accepted.run.runId)!;
      const base = JSON.parse(row.envelope) as Record<string, unknown>;
      const rejectShape = (mutate: (value: Record<string, unknown>) => void, label: string) => {
        const candidate = structuredClone(base);
        mutate(candidate);
        const hash = hashVnextRunPlanEnvelope(candidate as never);
        try {
          parseVnextRunPlanEnvelope(JSON.stringify(candidate), run, hash);
          assert.fail(`${label} was accepted`);
        } catch (error) {
          assert.equal(error instanceof TypeError, false, `${label} threw TypeError`);
          assert.match(String(error), /run_plan_corrupt/);
        }
      };
      rejectShape((value) => {
        delete value.revisions;
      }, "revisions removed");
      rejectShape((value) => {
        const plan = value.plan as Record<string, unknown>;
        delete plan.steps;
      }, "steps removed");
      rejectShape((value) => {
        const plan = value.plan as { steps: Record<string, Record<string, unknown>> };
        delete plan.steps.a!.assignments;
      }, "assignments missing");
      rejectShape((value) => {
        const plan = value.plan as { steps: Record<string, { transitions: Record<string, unknown> }> };
        plan.steps.a!.transitions.extra = { to: "terminal", terminalStatus: "failed" };
      }, "extra transition key");
      const plan = rehydrateVnextCompiledPlan(context, accepted.run.runId);
      assert.equal(Object.getPrototypeOf(plan.steps.a!.transitions), null);
      assert.equal(Object.getPrototypeOf(plan.steps.a!.repositories), null);
      const db = new DatabaseSync(context.eventStore.path);
      const pin = db.prepare("SELECT payload FROM events WHERE run_id = ? AND sequence = ?").get(accepted.run.runId, row.pinnedSequence) as { payload: string };
      const payload = JSON.parse(pin.payload) as { runPlanHash: string };
      payload.runPlanHash = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
      db.prepare("UPDATE events SET payload = ? WHERE run_id = ? AND sequence = ?").run(JSON.stringify(payload), accepted.run.runId, row.pinnedSequence);
      db.close();
      assert.throws(() => loadVnextRunPlanEnvelope(context.eventStore, run), /run_plan_corrupt/);
      assert.throws(() => rehydrateVnextCompiledPlan(context, accepted.run.runId), /run_plan_corrupt/);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

const PLAN_HASH = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ASG = "asg_01JASSIGN00000000000000000";
const ATM = "atm_01JATTEMPT00000000000000";
const ASG2 = "asg_01JASSIGN20000000000000000";
const ATM2 = "atm_01JATTEMPT2000000000000";
const ASG3 = "asg_01JASSIGN30000000000000000";
const ATM3 = "atm_01JATTEMPT3000000000000";

function event(run: VnextRunRecord, sequence: number, eventType: string, payload: Record<string, unknown>): VnextRunEvent {
  return {
    schema: "kxm.run-event.v1",
    eventId: newVnextEventId(),
    eventType,
    projectId: run.projectId,
    runId: run.runId,
    homeRuntimeId: run.homeRuntimeId,
    sequence,
    occurredAt: run.createdAt,
    recordedAt: run.createdAt,
    monotonicNs: String(sequence),
    configRevision: run.configRevision,
    memoryRevision: run.memoryRevision,
    executorPolicyRevision: run.executorPolicyRevision,
    toolPolicyRevision: run.toolPolicyRevision,
    payload,
  };
}

function foldPrefix(
  run: VnextRunRecord,
  plan: ReturnType<typeof compileVnextWorkflow>,
  stage:
    | "created"
    | "preparing"
    | "running"
    | "executing"
    | "result"
    | "terminal"
    | "outcome"
    | "passed"
    | "transitioned"
    | "completed",
): VnextRunEvent[] {
  const stepId = plan.entryStepId;
  const created = event(run, 1, "run.created", {
    workflowId: run.workflowId,
    status: "created",
    promptHash: run.promptSha256,
    repositoryIds: [],
    executorIds: [],
  });
  if (stage === "created") return [created];
  const events: VnextRunEvent[] = [
    created,
    event(run, 2, "run.status_changed", { status: "preparing", runPlanHash: PLAN_HASH }),
  ];
  if (stage === "preparing") return events;
  events.push(event(run, 3, "run.status_changed", { status: "running" }));
  if (stage === "running") return events;
  events.push(event(run, 4, "step.entered", { stepId, stepAttempt: 1, status: "pending" }));
  events.push(event(run, 5, "step.status_changed", { stepId, status: "preparing", previousStatus: "pending" }));
  events.push(event(run, 6, "assignment.created", { assignmentId: ASG, stepId, stepAttempt: 1, agentId: "implementer", status: "created" }));
  events.push(event(run, 7, "assignment.accepted", { assignmentId: ASG, status: "accepted" }));
  events.push(event(run, 8, "attempt.created", { attemptId: ATM, assignmentId: ASG, status: "created" }));
  events.push(event(run, 9, "assignment.dispatched", { assignmentId: ASG, capabilityHash: PLAN_HASH, status: "dispatched" }));
  events.push(event(run, 10, "attempt.status_changed", { attemptId: ATM, status: "starting" }));
  events.push(event(run, 11, "step.status_changed", { stepId, status: "running", previousStatus: "preparing" }));
  events.push(event(run, 12, "assignment.executing", { assignmentId: ASG, status: "executing" }));
  events.push(event(run, 13, "attempt.status_changed", { attemptId: ATM, status: "executing" }));
  if (stage === "executing") return events;
  events.push(event(run, 14, "attempt.status_changed", { attemptId: ATM, status: "settling" }));
  events.push(event(run, 15, "assignment.result_recorded", {
    assignmentId: ASG,
    resultClass: "outcome",
    outcome: "passed",
    status: "result_recorded",
  }));
  if (stage === "result") return events;
  events.push(event(run, 16, "attempt.status_changed", { attemptId: ATM, status: "terminal" }));
  events.push(event(run, 17, "assignment.terminal", { assignmentId: ASG, outcome: "passed", status: "terminal" }));
  if (stage === "terminal") return events;
  events.push(event(run, 18, "step.outcome_recorded", { stepId, stepAttempt: 1, outcome: "passed" }));
  if (stage === "outcome") return events;
  events.push(event(run, 19, "step.status_changed", { stepId, status: "passed", previousStatus: "running" }));
  if (stage === "passed") return events;
  const selected = plan.steps[stepId]?.transitions.passed;
  if (!selected) return events;
  if (selected.to === "step") {
    events.push(event(run, 20, "step.transitioned", { fromStepId: stepId, toStepId: selected.target, outcome: "passed" }));
    return events;
  }
  events.push(event(run, 20, "step.transitioned", { fromStepId: stepId, status: selected.terminalStatus, outcome: "passed" }));
  if (stage === "transitioned") return events;
  events.push(event(run, 21, "run.status_changed", { status: selected.terminalStatus }));
  return events;
}

function compilePanelPlan(spec: {
  kind?: "agent" | "moa" | "gate" | "approval" | "wait";
  minimum?: number;
  target?: number;
  maximum?: number;
  maxParallel?: number;
  joinStrategy?: "all" | "all-settled" | "quorum" | "first-success";
  outcomes?: Record<string, { target: "$terminal"; terminalStatus: "completed" | "failed" | "cancelled" }>;
}): ReturnType<typeof compileVnextWorkflow> {
  const kind = spec.kind ?? "agent";
  const maximum = spec.maximum ?? 2;
  const target = spec.target ?? maximum;
  const step: JsonObject = {
    id: "only",
    kind,
    assignments: {
      minimum: spec.minimum ?? 1,
      target,
      maximum,
      maxParallel: spec.maxParallel ?? maximum,
    },
    join: { strategy: spec.joinStrategy ?? "all" },
    on: spec.outcomes ?? {
      passed: { target: "$terminal", terminalStatus: "completed" },
      failed: { target: "$terminal", terminalStatus: "failed" },
    },
  };
  if (kind === "agent" || kind === "moa") step.agent = "implementer";
  if (kind === "gate") step.gate = "local-verify";
  if (kind === "wait") step.signal = "continue";
  return compileVnextWorkflow({
    id: "panel",
    value: { schema: "kxm.workflow.v1", coordinator: "coordinator", steps: [step] },
  });
}

interface PanelMemberSpec {
  id: string;
  attempt: string;
  resultClass?: string;
  outcome?: string;
  terminalOutcome?: string;
}

function panelPush(run: VnextRunRecord): { events: VnextRunEvent[]; push: (type: string, payload: Record<string, unknown>) => void } {
  const events: VnextRunEvent[] = [];
  const push = (type: string, payload: Record<string, unknown>) => {
    events.push(event(run, events.length + 1, type, payload));
  };
  return { events, push };
}

function panelBootstrap(push: (type: string, payload: Record<string, unknown>) => void, run: VnextRunRecord, running = false): void {
  push("run.created", {
    workflowId: run.workflowId,
    status: "created",
    promptHash: run.promptSha256,
    repositoryIds: [],
    executorIds: [],
  });
  push("run.status_changed", { status: "preparing", runPlanHash: PLAN_HASH });
  push("run.status_changed", { status: "running" });
  push("step.entered", { stepId: "only", stepAttempt: 1, status: "pending" });
  push("step.status_changed", { stepId: "only", status: "preparing", previousStatus: "pending" });
  if (running) push("step.status_changed", { stepId: "only", status: "running", previousStatus: "preparing" });
}

function panelAdvanceMember(
  push: (type: string, payload: Record<string, unknown>) => void,
  member: PanelMemberSpec,
  through: "created" | "starting" | "executing" | "result" | "attempt-terminal" | "terminal",
): void {
  push("assignment.created", { assignmentId: member.id, stepId: "only", stepAttempt: 1, agentId: "implementer", status: "created" });
  if (through === "created") return;
  push("assignment.accepted", { assignmentId: member.id, status: "accepted" });
  push("attempt.created", { attemptId: member.attempt, assignmentId: member.id, status: "created" });
  push("assignment.dispatched", { assignmentId: member.id, capabilityHash: PLAN_HASH, status: "dispatched" });
  push("attempt.status_changed", { attemptId: member.attempt, status: "starting" });
  if (through === "starting") return;
  push("assignment.executing", { assignmentId: member.id, status: "executing" });
  push("attempt.status_changed", { attemptId: member.attempt, status: "executing" });
  if (through === "executing") return;
  push("attempt.status_changed", { attemptId: member.attempt, status: "settling" });
  const recorded: Record<string, unknown> = { assignmentId: member.id, resultClass: member.resultClass ?? "outcome", status: "result_recorded" };
  if (member.outcome !== undefined) recorded.outcome = member.outcome;
  push("assignment.result_recorded", recorded);
  if (through === "result") return;
  push("attempt.status_changed", { attemptId: member.attempt, status: "terminal" });
  if (through === "attempt-terminal") return;
  push("assignment.terminal", { assignmentId: member.id, outcome: member.terminalOutcome ?? member.outcome ?? "failed", status: "terminal" });
}

function panelPrefix(
  run: VnextRunRecord,
  _plan: ReturnType<typeof compileVnextWorkflow>,
  members: PanelMemberSpec[],
  stage: "created" | "created-both" | "starting",
): VnextRunEvent[] {
  const { events, push } = panelPush(run);
  panelBootstrap(push, run, false);
  if (stage === "created") {
    panelAdvanceMember(push, members[0]!, "created");
    return events;
  }
  if (stage === "created-both") {
    for (const member of members) panelAdvanceMember(push, member, "created");
    return events;
  }
  let stepRunning = false;
  for (const member of members) {
    panelAdvanceMember(push, member, "starting");
    if (!stepRunning) {
      push("step.status_changed", { stepId: "only", status: "running", previousStatus: "preparing" });
      stepRunning = true;
    }
  }
  return events;
}

function panelMembers(
  run: VnextRunRecord,
  _plan: ReturnType<typeof compileVnextWorkflow>,
  members: PanelMemberSpec[],
  options: { cancelRequested?: boolean } = {},
): { terminal: VnextRunEvent[]; beforeFirstTerminal: VnextRunEvent[] } {
  const { events, push } = panelPush(run);
  panelBootstrap(push, run, false);
  let stepRunning = false;
  for (const member of members) {
    panelAdvanceMember(push, member, "starting");
    if (!stepRunning) {
      push("step.status_changed", { stepId: "only", status: "running", previousStatus: "preparing" });
      stepRunning = true;
    }
  }
  for (const member of members) {
    push("assignment.executing", { assignmentId: member.id, status: "executing" });
    push("attempt.status_changed", { attemptId: member.attempt, status: "executing" });
  }
  if (options.cancelRequested) {
    push("run.cancel_requested", { actor: { kind: "runtime", id: HOME }, reason: "operator_cancel" });
  }
  for (const member of members) {
    push("attempt.status_changed", { attemptId: member.attempt, status: "settling" });
    const recorded: Record<string, unknown> = { assignmentId: member.id, resultClass: member.resultClass ?? "outcome", status: "result_recorded" };
    if (member.outcome !== undefined) recorded.outcome = member.outcome;
    push("assignment.result_recorded", recorded);
    push("attempt.status_changed", { attemptId: member.attempt, status: "terminal" });
  }
  const beforeFirstTerminal = [...events];
  for (const member of members) {
    push("assignment.terminal", { assignmentId: member.id, outcome: member.terminalOutcome ?? member.outcome ?? "failed", status: "terminal" });
  }
  return { terminal: events, beforeFirstTerminal };
}

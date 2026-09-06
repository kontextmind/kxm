import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { removeTempDir } from "./helpers.ts";
import { loadVnextProject, parseRestrictedYaml, validateRunEvent } from "../plugins/kxm/src/vnext-config.ts";
import { compileVnextWorkflow } from "../plugins/kxm/src/vnext-engine-compile.ts";
import { initializeVnextProject } from "../plugins/kxm/src/vnext-init.ts";
import { foldVnextRunState } from "../plugins/kxm/src/vnext-engine-fold.ts";
import {
  hashVnextRunPlanEnvelope,
  loadVnextRunPlanEnvelope,
  parseVnextRunPlanEnvelope,
} from "../plugins/kxm/src/vnext-engine-plan.ts";
import {
  VnextRunScheduler,
  createVnextSimulatedProducer,
  driveVnextRun,
  pinVnextCompiledPlan,
  rehydrateVnextCompiledPlan,
  startVnextRun,
  stepVnextRun,
  verifyVnextAttemptCapability,
} from "../plugins/kxm/src/vnext-engine.ts";
import {
  admitVnextRun,
  bindVnextSchedulerPolicy,
  enqueueVnextScheduledRun,
  releaseVnextRun,
  vnextActiveScheduledRuns,
  vnextAttemptController,
  vnextQueuedScheduledRuns,
} from "../plugins/kxm/src/vnext-runtime-owner.ts";
import {
  VNEXT_EVENT_STORE_SCHEMA_VERSION,
  VNEXT_REGISTRY_SCHEMA_VERSION,
  VnextRunEventStore,
  VnextRuntimeRegistry,
  newVnextEventId,
  vnextRuntimePaths,
  type VnextRunEvent,
  type VnextRunRecord,
} from "../plugins/kxm/src/vnext-runtime-store.ts";
import {
  acceptVnextRun,
  cancelVnextRun,
  closeVnextRuntimeContext,
  openVnextRuntimeContext,
  rebuildVnextRunProjection,
} from "../plugins/kxm/src/vnext-runtime.ts";
import { vnextCanonicalJson as canonicalJson, type JsonValue } from "../plugins/kxm/src/vnext-config.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = resolve(repoRoot, "test/fixtures/vnext-engine");
const HOME = "rtm_01JENGINE00000000000000000";

function makeGitRoot(root: string): void {
  const initialized = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", root], { encoding: "utf8", windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
}

function engineProject(
  prefix: string,
  workflows: string[] = ["agent-only.yaml", "unsupported-gate.yaml", "one-step.yaml"],
  projectId = "prj_01JENGINE00000000000000000",
): { root: string; stateRoot: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const stateRoot = mkdtempSync(join(tmpdir(), `${prefix}state-`));
  makeGitRoot(root);
  initializeVnextProject(root, { projectId, projectName: "Engine Test" });
  for (const file of workflows) {
    cpSync(join(fixtureDir, file), join(root, ".kxm", "workflows", file));
  }
  spawnSync("git", ["-C", root, "add", "-A"], { windowsHide: true });
  const commit = spawnSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"], { windowsHide: true });
  assert.equal(commit.status, 0, commit.stderr as unknown as string);
  return { root, stateRoot };
}

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
      assert.equal(vnextAttemptController(context.eventStore.path, accepted.run.runId), undefined);
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
        return deferred;
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
      assert.equal(limited.handoff?.field, "limits.maxRunDurationMs");
      assert.equal(limited.state.status, "preparing");
      assert.equal(context.eventStore.events(def.run.runId, 0, 20).some((event) => event.payload.status === "running"), false);

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

test("store brakes: registry v1 stays valid; event store v2; v1/v99/shape fail closed", () => {
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
    assert.throws(() => new VnextRunEventStore(v1), /runtime_schema_outdated[\s\S]*E6/);

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
  assert.equal(foldVnextRunState(run, plan, foldPrefix(run, plan, "executing")).currentStep?.attemptStatus, "executing");
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

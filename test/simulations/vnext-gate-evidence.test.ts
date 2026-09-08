import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { removeTempDir } from "../helpers.ts";
import { engineProject } from "../helpers/vnext-project.ts";
import { loadVnextProject, validateRunEvent, type JsonValue } from "../../plugins/kxm/src/vnext-config.ts";
import { vnextCanonicalJson } from "../../plugins/kxm/src/vnext-config.ts";
import { createVnextSimulatedProducer, driveVnextRun, pinVnextCompiledPlan, startVnextRun } from "../../plugins/kxm/src/vnext-engine.ts";
import {
  recordGateCancelObserved,
  recordGateIntent,
  recordGateNoStart,
  recordGateSettlement,
  recordGateSpawned,
  recordGateUncertain,
  type VnextGateObservationInput,
} from "../../plugins/kxm/src/vnext-engine-gate-records.ts";
import {
  hashVnextRunPlanEnvelope,
  loadVnextRunPlanEnvelope,
  parseVnextRunPlanEnvelope,
  type VnextRunPlanEnvelope,
} from "../../plugins/kxm/src/vnext-engine-plan.ts";
import { gateDefinitionHash, gateRegistryHash } from "../../plugins/kxm/src/vnext-gate-hash.ts";
import {
  VNEXT_EVENT_STORE_SCHEMA_VERSION,
  VnextRunEventStore,
  gateRowContentHash,
  newVnextEventId,
  type VnextGateAttemptRow,
  type VnextGateObservationRow,
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
  vnextEventBase,
  vnextMonotonicNs,
  vnextPolicyRevisions,
  type VnextRuntimeContext,
} from "../../plugins/kxm/src/vnext-runtime.ts";

const HOME = "rtm_01JENGINE00000000000000000";
const WORKFLOWS = [
  "agent-only.yaml",
  "unsupported-gate.yaml",
  "one-step.yaml",
  "gate-command.yaml",
  "gate-fail.yaml",
  "artifacts-gate.yaml",
  "gate-retry.yaml",
  "gate-budget-edge.yaml",
  "gate-budget-transitions.yaml",
];

function gateProject(prefix: string) {
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
`);
  return created;
}

function streamHash(tag: string): string {
  const hex = Buffer.from(tag).toString("hex").padEnd(64, "a").slice(0, 64);
  return `sha256:${hex}`;
}

function commandComplete(exitCode: number): VnextGateObservationInput {
  const now = new Date().toISOString();
  return {
    completeness: "complete",
    spawned: 1,
    pid: 4242,
    exitCode,
    signal: null,
    exitObserved: 1,
    closeObserved: 1,
    stopCause: "none",
    signalsAttempted: "none",
    errorClass: null,
    stdoutSha256: streamHash("out"),
    stdoutBytes: 4,
    stdoutComplete: 1,
    stderrSha256: streamHash("err"),
    stderrBytes: 0,
    stderrComplete: 1,
    checkedCount: null,
    failedCount: null,
    elapsedMs: 12,
    startedAt: now,
    finishedAt: now,
  };
}

function artifactsComplete(failedCount: number): VnextGateObservationInput {
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
    failedCount,
    elapsedMs: 3,
    startedAt: now,
    finishedAt: now,
  };
}

function noStartProof(stopCause: "none" | "cancel", errorClass: VnextGateObservationInput["errorClass"]): VnextGateObservationInput {
  const now = new Date().toISOString();
  return {
    completeness: "no-start",
    spawned: 0,
    pid: null,
    exitCode: null,
    signal: null,
    exitObserved: 0,
    closeObserved: 0,
    stopCause,
    signalsAttempted: "none",
    errorClass,
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

function incompleteProof(stopCause: VnextGateObservationInput["stopCause"]): VnextGateObservationInput {
  const now = new Date().toISOString();
  return {
    completeness: "incomplete",
    spawned: 1,
    pid: 9,
    exitCode: null,
    signal: "SIGTERM",
    exitObserved: 0,
    closeObserved: 0,
    stopCause,
    signalsAttempted: "term",
    errorClass: "stop-error",
    stdoutSha256: streamHash("part"),
    stdoutBytes: 1,
    stdoutComplete: 0,
    stderrSha256: streamHash("part"),
    stderrBytes: 0,
    stderrComplete: 0,
    checkedCount: null,
    failedCount: null,
    elapsedMs: 50,
    startedAt: now,
    finishedAt: null,
  };
}

function sql(path: string, work: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path);
  try {
    work(db);
  } finally {
    db.close();
  }
}

function observationFromSql(row: Record<string, unknown>): VnextGateObservationRow {
  return {
    observationId: row.observation_id as string,
    attemptId: row.attempt_id as string,
    runId: row.run_id as string,
    projectId: row.project_id as string,
    homeRuntimeId: row.home_runtime_id as string,
    stepId: row.step_id as string,
    stepAttempt: row.step_attempt as number,
    assignmentId: row.assignment_id as string,
    effectId: row.effect_id as string,
    completeness: row.completeness as VnextGateObservationRow["completeness"],
    spawned: row.spawned === 1 ? 1 : 0,
    pid: row.pid as number | null,
    exitCode: row.exit_code as number | null,
    signal: row.signal as string | null,
    exitObserved: row.exit_observed === 1 ? 1 : 0,
    closeObserved: row.close_observed === 1 ? 1 : 0,
    stopCause: row.stop_cause as VnextGateObservationRow["stopCause"],
    signalsAttempted: row.signals_attempted as VnextGateObservationRow["signalsAttempted"],
    errorClass: row.error_class as VnextGateObservationRow["errorClass"],
    stdoutSha256: row.stdout_sha256 as string | null,
    stdoutBytes: row.stdout_bytes as number | null,
    stdoutComplete: row.stdout_complete === null ? null : row.stdout_complete === 1 ? 1 : 0,
    stderrSha256: row.stderr_sha256 as string | null,
    stderrBytes: row.stderr_bytes as number | null,
    stderrComplete: row.stderr_complete === null ? null : row.stderr_complete === 1 ? 1 : 0,
    checkedCount: row.checked_count as number | null,
    failedCount: row.failed_count as number | null,
    elapsedMs: row.elapsed_ms as number,
    startedAt: row.started_at as string,
    finishedAt: row.finished_at as string | null,
    recordedEventId: row.recorded_event_id as string,
    contentHash: "",
  };
}

function rewriteObservation(path: string, mutate: (row: VnextGateObservationRow) => void): void {
  sql(path, (db) => {
    const raw = db.prepare("SELECT * FROM gate_observations").get() as Record<string, unknown>;
    const mapped = observationFromSql(raw);
    mutate(mapped);
    mapped.contentHash = gateRowContentHash("gate_observations", { ...mapped, contentHash: "" });
    db.prepare(`
      UPDATE gate_observations SET
        completeness = ?, spawned = ?, pid = ?, exit_code = ?, signal = ?,
        exit_observed = ?, close_observed = ?, stop_cause = ?, signals_attempted = ?,
        error_class = ?, stdout_sha256 = ?, stdout_bytes = ?, stdout_complete = ?,
        stderr_sha256 = ?, stderr_bytes = ?, stderr_complete = ?,
        checked_count = ?, failed_count = ?, content_hash = ?
      WHERE observation_id = ?
    `).run(
      mapped.completeness, mapped.spawned, mapped.pid, mapped.exitCode, mapped.signal,
      mapped.exitObserved, mapped.closeObserved, mapped.stopCause, mapped.signalsAttempted,
      mapped.errorClass, mapped.stdoutSha256, mapped.stdoutBytes, mapped.stdoutComplete,
      mapped.stderrSha256, mapped.stderrBytes, mapped.stderrComplete,
      mapped.checkedCount, mapped.failedCount, mapped.contentHash, mapped.observationId,
    );
    const events = db.prepare("SELECT event_id, payload FROM events WHERE event_type IN ('effect.observed', 'effect.blocked_uncertain', 'effect.settled')").all() as Array<{ event_id: string; payload: string }>;
    for (const event of events) {
      const payload = JSON.parse(event.payload) as { receipt?: { id?: string; hash?: string } };
      if (payload.receipt?.id === mapped.observationId) {
        payload.receipt.hash = mapped.contentHash;
        db.prepare("UPDATE events SET payload = ? WHERE event_id = ?").run(JSON.stringify(payload), event.event_id);
      }
    }
  });
}

function issues(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertCode(error: unknown, code: string): void {
  assert.match(issues(error), new RegExp(code));
}

async function assertReadsFail(context: VnextRuntimeContext, run: VnextRunRecord, code: string): Promise<void> {
  const matches = (error: unknown) => {
    assertCode(error, code);
    return true;
  };
  assert.throws(() => readVnextRunStatus(context, run), matches);
  assert.throws(() => cancelVnextRun(context, run.runId), matches);
  assert.throws(() => rebuildVnextRunProjection(context, run.runId), matches);
  await assert.rejects(
    () => driveVnextRun(context, run.runId, createVnextSimulatedProducer(async () => ({ outcome: "passed" }))),
    matches,
  );
}

function scanSecrets(events: readonly VnextRunEvent[]): string[] {
  const hits: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (value.includes("kxmcap_") || value.includes("stdout text") || value.includes("stderr dump")) hits.push(path);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) walk(child, `${path}.${key}`);
  };
  for (const event of events) walk(event.payload, event.eventType);
  return hits;
}

async function withRun(
  workflowId: string,
  prompt: string,
  fn: (args: {
    context: VnextRuntimeContext;
    bundle: ReturnType<typeof loadVnextProject>;
    run: VnextRunRecord;
    envelope: VnextRunPlanEnvelope;
  }) => Promise<void> | void,
): Promise<void> {
  const { root, stateRoot } = gateProject(`kxm-gate-${prompt}-`);
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId, prompt });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      startVnextRun(context, accepted.run.runId);
      const run = context.eventStore.run(accepted.run.runId)!;
      const envelope = loadVnextRunPlanEnvelope(context.eventStore, run);
      await fn({ context, bundle, run, envelope });
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
}

function appendRaw(context: VnextRuntimeContext, run: VnextRunRecord, eventType: string, payload: Record<string, unknown>): VnextRunEvent {
  const now = new Date().toISOString();
  const event: VnextRunEvent = {
    ...vnextEventBase(context, run, now, vnextMonotonicNs()),
    eventId: newVnextEventId(),
    eventType,
    sequence: context.eventStore.nextSequence(run.runId),
    payload,
  };
  context.eventStore.appendEvent(event);
  return event;
}

test("G1 store brake refuses v2 files and missing gate tables", () => {
  const directory = mkdtempSync(join(tmpdir(), "kxm-gate-store-brake-"));
  try {
    const outdated = join(directory, "v2.db");
    const db = new DatabaseSync(outdated);
    db.exec("PRAGMA user_version = 2");
    db.close();
    assert.throws(() => new VnextRunEventStore(outdated), /runtime_schema_outdated[\s\S]*older than 3[\s\S]*no migration lane/);

    const shaped = join(directory, "v3.db");
    const store = new VnextRunEventStore(shaped);
    assert.equal(VNEXT_EVENT_STORE_SCHEMA_VERSION, 3);
    store.close();
    sql(shaped, (database) => database.exec("DROP TABLE gate_attempts"));
    assert.throws(() => new VnextRunEventStore(shaped), /runtime_schema_shape_invalid[\s\S]*gate_attempts/);
  } finally {
    removeTempDir(directory);
  }
});

test("G2 envelope v2 pin and corrupt parse cases", () => {
  const { root, stateRoot } = gateProject("kxm-gate-envelope-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "gate-command", prompt: "pin" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const run = context.eventStore.run(accepted.run.runId)!;
      const envelope = loadVnextRunPlanEnvelope(context.eventStore, run);
      assert.equal(envelope.schema, "kxm.run-plan.v2");
      assert.ok(envelope.gates.registry);
      assert.equal(envelope.gates.registry.hash, gateRegistryHash(bundle.gateRegistry!.value));
      assert.deepEqual(Object.keys(envelope.gates.definitions), ["test"]);
      assert.equal(
        envelope.gates.definitions.test && "timeoutMs" in envelope.gates.definitions.test
          ? envelope.gates.definitions.test.timeoutMs
          : 0,
        3_600_000,
      );

      const agent = acceptVnextRun(context, bundle, { workflowId: "agent-only", prompt: "nongate" });
      pinVnextCompiledPlan(context, bundle, agent.run.runId);
      const agentEnvelope = loadVnextRunPlanEnvelope(context.eventStore, context.eventStore.run(agent.run.runId)!);
      assert.equal(Object.keys(agentEnvelope.gates.definitions).length, 0);

      const raw = context.eventStore.runPlan(run.runId)!.envelope;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const corrupt = (mutate: (value: Record<string, unknown>) => void, pattern: RegExp) => {
        const copy = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
        mutate(copy);
        assert.throws(() => parseVnextRunPlanEnvelope(JSON.stringify(copy), run, "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), pattern);
      };
      corrupt((value) => {
        const gates = value.gates as { definitions: Record<string, unknown> };
        delete gates.definitions.test;
      }, /gate step check has no pinned definition/);
      corrupt((value) => {
        const gates = value.gates as { definitions: Record<string, unknown> };
        gates.definitions.extra = { kind: "reserved" };
      }, /definition extra is not referenced/);
      corrupt((value) => {
        (value.gates as Record<string, unknown>).unexpected = true;
      }, /run_plan_corrupt/);
      corrupt((value) => {
        const gates = value.gates as { definitions: { test: { timeoutMs: number } } };
        gates.definitions.test.timeoutMs = 0;
      }, /timeoutMs is invalid/);
      corrupt((value) => {
        const gates = value.gates as { definitions: { test: { timeoutMs: number } } };
        gates.definitions.test.timeoutMs = 2_147_483_648;
      }, /timeoutMs is invalid/);
      corrupt((value) => {
        value.schema = "kxm.run-plan.v1";
      }, /schema is not kxm.run-plan.v2/);
      corrupt((value) => {
        (value.gates as { registry: unknown }).registry = null;
      }, /gate steps require a non-null registry pin/);
      corrupt((value) => {
        const gates = value.gates as { controlRoot: { repositoryId: string } };
        gates.controlRoot.repositoryId = "project";
      }, /repositoryId must be control/);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("G3 legal command and artifact roundtrips through production builders", async () => {
  await withRun("gate-command", "pass", ({ context, run, envelope, bundle }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    const first = recordGateSettlement(context, run, envelope, "check", commandComplete(0));
    assert.equal(first.state.status, "completed");
    const counts = context.eventStore.gateRowCounts(run.runId);
    assert.deepEqual(counts, { attempts: 1, observations: 1, evidence: 1 });
    const observation = context.eventStore.gateObservationForAttempt(first.state.currentStep?.attemptId ?? context.eventStore.gateAttemptsForRun(run.runId)[0]!.attemptId);
    const evidence = context.eventStore.gateEvidenceForRun(run.runId)[0]!;
    assert.equal(observation && gateRowContentHash("gate_observations", observation), observation?.contentHash);
    assert.equal(gateRowContentHash("gate_evidence", evidence), evidence.contentHash);
    assert.equal(evidence.outcome, "passed");
    const events = context.eventStore.events(run.runId, 0, 10_000);
    for (const event of events) validateRunEvent(event, "run-event");
    assert.deepEqual(scanSecrets(events), []);
    assert.equal(context.eventStore.capabilityByAttempt(evidence.attemptId)?.state, "settled");
    assert.equal(context.eventStore.runState(run.runId)!.state, vnextCanonicalJson(first.state as unknown as JsonValue));
    assert.equal(envelope.gates.registry?.hash, gateRegistryHash(bundle.gateRegistry!.value));
    assert.equal(
      context.eventStore.gateAttemptsForRun(run.runId)[0]!.gateDefinitionHash,
      gateDefinitionHash("test", envelope.gates.definitions.test as unknown as JsonValue),
    );
  });

  await withRun("gate-fail", "expect-fail", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    const settled = recordGateSettlement(context, run, envelope, "check", commandComplete(7));
    assert.equal(settled.state.status, "completed");
    assert.equal(context.eventStore.gateEvidenceForRun(run.runId)[0]!.outcome, "passed");
  });

  await withRun("artifacts-gate", "artifacts-pass", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    const settled = recordGateSettlement(context, run, envelope, "check", artifactsComplete(0));
    assert.equal(settled.state.status, "completed");
    assert.equal(context.eventStore.events(run.runId, 0, 200).some((event) => event.eventType === "effect.dispatched"), true);
    assert.equal(context.eventStore.gateEvidenceForRun(run.runId)[0]!.outcome, "passed");
  });

  await withRun("artifacts-gate", "artifacts-fail", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    const settled = recordGateSettlement(context, run, envelope, "check", artifactsComplete(1));
    assert.equal(settled.state.status, "failed");
    assert.equal(context.eventStore.gateEvidenceForRun(run.runId)[0]!.outcome, "implementation-failure");
  });
});

test("G3 reopen keeps run_state bytes and hashes", async () => {
  const { root, stateRoot } = gateProject("kxm-gate-reopen-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    let runId = "";
    let bytes = "";
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "gate-command", prompt: "reopen" });
      runId = accepted.run.runId;
      pinVnextCompiledPlan(context, bundle, runId);
      startVnextRun(context, runId);
      const run = context.eventStore.run(runId)!;
      const envelope = loadVnextRunPlanEnvelope(context.eventStore, run);
      recordGateIntent(context, run, envelope, "check");
      recordGateSpawned(context, run, envelope, "check");
      recordGateSettlement(context, run, envelope, "check", commandComplete(0));
      bytes = context.eventStore.runState(runId)!.state;
    } finally {
      closeVnextRuntimeContext(context);
    }
    const reopened = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const run = reopened.eventStore.run(runId)!;
      assert.equal(readVnextRunStatus(reopened, run), "completed");
      assert.equal(reopened.eventStore.runState(runId)!.state, bytes);
      const observation = reopened.eventStore.gateObservationForAttempt(reopened.eventStore.gateAttemptsForRun(runId)[0]!.attemptId)!;
      assert.equal(gateRowContentHash("gate_observations", observation), observation.contentHash);
    } finally {
      closeVnextRuntimeContext(reopened);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("G4 row validation refuses extra keys, hashes, identity, and artifacts expect-fail", async () => {
  await withRun("gate-command", "row-invalid", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    const attempt = context.eventStore.gateAttemptsForRun(run.runId)[0]!;
    const before = context.eventStore.gateRowCounts(run.runId);
    const eventCount = context.eventStore.events(run.runId, 0, 10_000).length;
    const expectInvalid = (work: () => void) => {
      assert.throws(work, /gate_row_invalid/);
      assert.deepEqual(context.eventStore.gateRowCounts(run.runId), before);
      assert.equal(context.eventStore.events(run.runId, 0, 10_000).length, eventCount);
    };
    expectInvalid(() => context.eventStore.insertGateAttempt({ ...attempt, extra: 1 } as VnextGateAttemptRow & { extra: number }));
    const missing = { ...attempt } as Record<string, unknown>;
    delete missing.contentHash;
    expectInvalid(() => context.eventStore.insertGateAttempt(missing as unknown as VnextGateAttemptRow));
    expectInvalid(() => context.eventStore.insertGateAttempt({ ...attempt, attemptId: "nope_notopaque" }));
    expectInvalid(() => context.eventStore.insertGateAttempt({
      ...attempt,
      contentHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }));
    const observation: VnextGateObservationRow = {
      observationId: "obs_cccccccccccccccccccccccccccccccc",
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      projectId: attempt.projectId,
      homeRuntimeId: attempt.homeRuntimeId,
      stepId: attempt.stepId,
      stepAttempt: attempt.stepAttempt,
      assignmentId: attempt.assignmentId,
      effectId: attempt.effectId,
      ...noStartProof("none", "spawn-error"),
      recordedEventId: attempt.intentEventId,
      contentHash: "",
    };
    const hashed = { ...observation, contentHash: gateRowContentHash("gate_observations", { ...observation, contentHash: "" }) };
    expectInvalid(() => context.eventStore.insertGateObservation(hashed));
    expectInvalid(() => context.eventStore.insertGateObservation({ ...hashed, stepId: "other", recordedEventId: attempt.intentEventId }));
    expectInvalid(() => context.eventStore.insertGateAttempt({ ...attempt, gateKind: "artifacts-exist", expect: "fail" }));
    expectInvalid(() => context.eventStore.insertGateObservation({ ...hashed, stdout: "secret dump" } as VnextGateObservationRow & { stdout: string }));
  });
});

test("G5 injected failures roll back events and rows", async () => {
  await withRun("gate-command", "rollback", ({ context, run, envelope }) => {
    const store = context.eventStore;
    const originalAttempt = store.insertGateAttempt.bind(store);
    store.insertGateAttempt = () => {
      throw new Error("inject-attempt");
    };
    assert.throws(() => recordGateIntent(context, run, envelope, "check"), /inject-attempt/);
    assert.deepEqual(store.gateRowCounts(run.runId), { attempts: 0, observations: 0, evidence: 0 });
    assert.equal(store.events(run.runId, 0, 200).some((event) => event.eventType === "effect.intent_recorded"), false);
    foldStoredVnextRun(context, run);
    store.insertGateAttempt = originalAttempt;

    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    const afterSpawn = store.events(run.runId, 0, 200).length;
    const originalObservation = store.insertGateObservation.bind(store);
    store.insertGateObservation = () => {
      throw new Error("inject-observation");
    };
    assert.throws(() => recordGateSettlement(context, run, envelope, "check", commandComplete(0)), /inject-observation/);
    assert.equal(store.events(run.runId, 0, 200).length, afterSpawn);
    assert.equal(store.gateRowCounts(run.runId).observations, 0);
    store.insertGateObservation = originalObservation;

    const originalState = store.upsertRunState.bind(store);
    store.upsertRunState = () => {
      throw new Error("inject-persist");
    };
    assert.throws(() => recordGateSettlement(context, run, envelope, "check", commandComplete(0)), /inject-persist/);
    assert.equal(store.events(run.runId, 0, 200).length, afterSpawn);
    assert.deepEqual(store.gateRowCounts(run.runId), { attempts: 1, observations: 0, evidence: 0 });
    store.upsertRunState = originalState;
    foldStoredVnextRun(context, run);
  });
});

test("G6 on-disk corruption fails every production read", async () => {
  const cases: Array<{ name: string; code: string; mutate: (path: string, runId: string) => void }> = [
    {
      name: "delete-one-evidence",
      code: "gate_evidence_missing",
      mutate: (path, runId) => sql(path, (db) => db.prepare("DELETE FROM gate_evidence WHERE run_id = ?").run(runId)),
    },
    {
      name: "flip-outcome",
      code: "gate_evidence_hash_mismatch",
      mutate: (path) => sql(path, (db) => db.exec("UPDATE gate_evidence SET outcome = 'repro-missing'")),
    },
    {
      name: "flip-hash",
      code: "gate_evidence_hash_mismatch",
      mutate: (path) => sql(path, (db) => db.exec("UPDATE gate_evidence SET content_hash = 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'")),
    },
    {
      name: "receipt-hash",
      code: "gate_evidence_hash_mismatch",
      mutate: (path) => sql(path, (db) => {
        const row = db.prepare("SELECT event_id, payload FROM events WHERE event_type = 'effect.observed'").get() as { event_id: string; payload: string };
        const payload = JSON.parse(row.payload) as { receipt: { hash: string } };
        payload.receipt.hash = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        db.prepare("UPDATE events SET payload = ? WHERE event_id = ?").run(JSON.stringify(payload), row.event_id);
      }),
    },
    {
      name: "incomplete-under-observed",
      code: "run_events_illegal",
      mutate: (path) => sql(path, (db) => {
        db.exec("UPDATE gate_observations SET completeness = 'incomplete'");
        const row = db.prepare("SELECT * FROM gate_observations").get() as Record<string, unknown>;
        const mapped = observationFromSql(row);
        mapped.completeness = "incomplete";
        mapped.contentHash = gateRowContentHash("gate_observations", { ...mapped, contentHash: "" });
        db.prepare("UPDATE gate_observations SET completeness = 'incomplete', content_hash = ?").run(mapped.contentHash);
      }),
    },
  ];
  for (const item of cases) {
    await withRun("gate-command", item.name, async ({ context, run, envelope }) => {
      recordGateIntent(context, run, envelope, "check");
      recordGateSpawned(context, run, envelope, "check");
      recordGateSettlement(context, run, envelope, "check", commandComplete(0));
      item.mutate(context.eventStore.path, run.runId);
      await assertReadsFail(context, context.eventStore.run(run.runId)!, item.code);
    });
  }

  await withRun("gate-command", "orphan-row", async ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    const attempt = context.eventStore.gateAttemptsForRun(run.runId)[0]!;
    sql(context.eventStore.path, (db) => {
      db.prepare(`
        INSERT INTO gate_observations (
          observation_id, attempt_id, run_id, project_id, home_runtime_id, step_id, step_attempt, assignment_id, effect_id,
          completeness, spawned, pid, exit_code, signal, exit_observed, close_observed, stop_cause, signals_attempted,
          error_class, stdout_sha256, stdout_bytes, stdout_complete, stderr_sha256, stderr_bytes, stderr_complete,
          checked_count, failed_count, elapsed_ms, started_at, finished_at, recorded_event_id, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'incomplete', 0, NULL, NULL, NULL, 0, 0, 'none', 'none', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, NULL, ?, ?)
      `).run(
        "obs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        attempt.attemptId,
        attempt.runId,
        attempt.projectId,
        attempt.homeRuntimeId,
        attempt.stepId,
        attempt.stepAttempt,
        attempt.assignmentId,
        attempt.effectId,
        new Date().toISOString(),
        attempt.intentEventId,
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      );
    });
    await assertReadsFail(context, context.eventStore.run(run.runId)!, "gate_evidence_orphan");
  });

  const { root, stateRoot } = gateProject("kxm-gate-repoint-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const first = acceptVnextRun(context, bundle, { workflowId: "gate-command", prompt: "one" });
      pinVnextCompiledPlan(context, bundle, first.run.runId);
      startVnextRun(context, first.run.runId);
      const run1 = context.eventStore.run(first.run.runId)!;
      const envelope1 = loadVnextRunPlanEnvelope(context.eventStore, run1);
      recordGateIntent(context, run1, envelope1, "check");
      recordGateSpawned(context, run1, envelope1, "check");
      recordGateSettlement(context, run1, envelope1, "check", commandComplete(0));

      const second = acceptVnextRun(context, bundle, { workflowId: "gate-command", prompt: "two" });
      pinVnextCompiledPlan(context, bundle, second.run.runId);
      startVnextRun(context, second.run.runId);
      const run2 = context.eventStore.run(second.run.runId)!;
      const envelope2 = loadVnextRunPlanEnvelope(context.eventStore, run2);
      recordGateIntent(context, run2, envelope2, "check");
      const attempt2 = context.eventStore.gateAttemptsForRun(run2.runId)[0]!;
      sql(context.eventStore.path, (db) => {
        db.prepare("UPDATE gate_evidence SET attempt_id = ? WHERE run_id = ?").run(attempt2.attemptId, run1.runId);
      });
      await assertReadsFail(context, context.eventStore.run(run1.runId)!, "gate_evidence");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("G7 stale attempt evidence cannot satisfy a retry", async () => {
  await withRun("gate-retry", "retry", async ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    recordGateSettlement(context, run, envelope, "check", commandComplete(1));
    assert.equal(readVnextRunStatus(context, context.eventStore.run(run.runId)!), "running");
    const first = context.eventStore.gateAttemptsForRun(run.runId)[0]!;
    recordGateIntent(context, context.eventStore.run(run.runId)!, envelope, "check");
    const second = context.eventStore.gateAttemptsForRun(run.runId)[1]!;
    assert.notEqual(first.attemptId, second.attemptId);
    sql(context.eventStore.path, (db) => {
      db.prepare("UPDATE gate_attempts SET gate_definition_hash = ? WHERE attempt_id = ?").run(
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        second.attemptId,
      );
    });
    await assertReadsFail(context, context.eventStore.run(run.runId)!, "gate_attempt_pin_mismatch");
  });
});

test("G7 second failed retry settles as budget_step_attempts with one evidence row per attempt", async () => {
  await withRun("gate-retry", "retry-budget", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    const first = recordGateSettlement(context, run, envelope, "check", commandComplete(1));
    assert.equal(first.state.status, "running");
    recordGateIntent(context, context.eventStore.run(run.runId)!, envelope, "check");
    recordGateSpawned(context, context.eventStore.run(run.runId)!, envelope, "check");
    const second = recordGateSettlement(context, context.eventStore.run(run.runId)!, envelope, "check", commandComplete(1));
    assert.equal(second.state.status, "failed");
    assert.equal(second.state.terminalReason, "budget_step_attempts");
    const evidence = context.eventStore.gateEvidenceForRun(run.runId);
    assert.equal(evidence.length, 2);
    assert.equal(context.eventStore.gateRowCounts(run.runId).observations, 2);
    assert.ok(evidence.every((row) => row.outcome === "implementation-failure"));
    const failed = context.eventStore.events(run.runId, 0, 400).find((event) => (
      event.eventType === "run.status_changed" && event.payload.status === "failed"
    ));
    assert.equal(failed?.payload.reason, "budget_step_attempts");
  });
});

test("G7 edge and transition exhaustion settle without dropping observations", async () => {
  await withRun("gate-budget-edge", "edge-budget", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    recordGateSettlement(context, run, envelope, "check", commandComplete(1));
    recordGateIntent(context, context.eventStore.run(run.runId)!, envelope, "check");
    recordGateSpawned(context, context.eventStore.run(run.runId)!, envelope, "check");
    const settled = recordGateSettlement(context, context.eventStore.run(run.runId)!, envelope, "check", commandComplete(1));
    assert.equal(settled.state.status, "failed");
    assert.equal(settled.state.terminalReason, "budget_edge");
    assert.equal(context.eventStore.gateRowCounts(run.runId).evidence, 2);
  });

  await withRun("gate-budget-transitions", "transition-budget", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    recordGateSettlement(context, run, envelope, "check", commandComplete(1));
    recordGateIntent(context, context.eventStore.run(run.runId)!, envelope, "check");
    recordGateSpawned(context, context.eventStore.run(run.runId)!, envelope, "check");
    const settled = recordGateSettlement(context, context.eventStore.run(run.runId)!, envelope, "check", commandComplete(1));
    assert.equal(settled.state.status, "failed");
    assert.equal(settled.state.terminalReason, "budget_transitions");
    assert.equal(context.eventStore.gateRowCounts(run.runId).observations, 2);
  });
});

test("G7 copied attempt-1 evidence cannot satisfy attempt 2", async () => {
  await withRun("gate-retry", "copied-evidence", async ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    recordGateSettlement(context, run, envelope, "check", commandComplete(1));
    recordGateIntent(context, context.eventStore.run(run.runId)!, envelope, "check");
    const first = context.eventStore.gateAttemptsForRun(run.runId)[0]!;
    const second = context.eventStore.gateAttemptsForRun(run.runId)[1]!;
    const sourceObservation = context.eventStore.gateObservationForAttempt(first.attemptId)!;
    const sourceEvidence = context.eventStore.gateEvidenceForAttempt(first.attemptId)!;
    const copiedObservation: VnextGateObservationRow = {
      ...sourceObservation,
      observationId: "obs_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      attemptId: second.attemptId,
      stepAttempt: second.stepAttempt,
      assignmentId: second.assignmentId,
      effectId: second.effectId,
      recordedEventId: second.intentEventId,
      contentHash: "",
    };
    copiedObservation.contentHash = gateRowContentHash("gate_observations", { ...copiedObservation, contentHash: "" });
    sql(context.eventStore.path, (db) => {
      db.prepare(`
        INSERT INTO gate_observations (
          observation_id, attempt_id, run_id, project_id, home_runtime_id, step_id, step_attempt, assignment_id, effect_id,
          completeness, spawned, pid, exit_code, signal, exit_observed, close_observed, stop_cause, signals_attempted,
          error_class, stdout_sha256, stdout_bytes, stdout_complete, stderr_sha256, stderr_bytes, stderr_complete,
          checked_count, failed_count, elapsed_ms, started_at, finished_at, recorded_event_id, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        copiedObservation.observationId, copiedObservation.attemptId, copiedObservation.runId, copiedObservation.projectId,
        copiedObservation.homeRuntimeId, copiedObservation.stepId, copiedObservation.stepAttempt, copiedObservation.assignmentId,
        copiedObservation.effectId, copiedObservation.completeness, copiedObservation.spawned, copiedObservation.pid,
        copiedObservation.exitCode, copiedObservation.signal, copiedObservation.exitObserved, copiedObservation.closeObserved,
        copiedObservation.stopCause, copiedObservation.signalsAttempted, copiedObservation.errorClass,
        copiedObservation.stdoutSha256, copiedObservation.stdoutBytes, copiedObservation.stdoutComplete,
        copiedObservation.stderrSha256, copiedObservation.stderrBytes, copiedObservation.stderrComplete,
        copiedObservation.checkedCount, copiedObservation.failedCount, copiedObservation.elapsedMs,
        copiedObservation.startedAt, copiedObservation.finishedAt, copiedObservation.recordedEventId, copiedObservation.contentHash,
      );
      const copiedEvidence = {
        ...sourceEvidence,
        evidenceId: "gev_cccccccccccccccccccccccccccccccc",
        attemptId: second.attemptId,
        observationId: copiedObservation.observationId,
        stepAttempt: second.stepAttempt,
        assignmentId: second.assignmentId,
        effectId: second.effectId,
        settledEventId: second.intentEventId,
        contentHash: "",
      };
      copiedEvidence.contentHash = gateRowContentHash("gate_evidence", { ...copiedEvidence, contentHash: "" });
      db.prepare(`
        INSERT INTO gate_evidence (
          evidence_id, attempt_id, observation_id, run_id, project_id, home_runtime_id, step_id, step_attempt,
          assignment_id, effect_id, evidence_key, kind, expect, outcome, settled_event_id, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        copiedEvidence.evidenceId, copiedEvidence.attemptId, copiedEvidence.observationId, copiedEvidence.runId,
        copiedEvidence.projectId, copiedEvidence.homeRuntimeId, copiedEvidence.stepId, copiedEvidence.stepAttempt,
        copiedEvidence.assignmentId, copiedEvidence.effectId, copiedEvidence.evidenceKey, copiedEvidence.kind,
        copiedEvidence.expect, copiedEvidence.outcome, copiedEvidence.settledEventId, copiedEvidence.contentHash,
      );
    });
    await assertReadsFail(context, context.eventStore.run(run.runId)!, "gate_evidence");
  });
});

test("G8 uncertainty freeze, no-start proof, and refusal after complete observation", async () => {
  await withRun("gate-command", "uncertain-intent", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    const blocked = recordGateUncertain(context, run, envelope, "check", "timeout", incompleteProof("timeout"));
    assert.equal(blocked.state.status, "running");
    assert.equal(blocked.state.currentStep?.effectState, "blocked_uncertain");
    assert.equal(context.eventStore.gateRowCounts(run.runId).evidence, 0);
    const cancelled = cancelVnextRun(context, run.runId);
    assert.equal(cancelled.run.status, "cancelling");
    const attempt = context.eventStore.gateAttemptsForRun(run.runId)[0]!;
    appendRaw(context, context.eventStore.run(run.runId)!, "effect.settled", {
      effect: { id: attempt.effectId, policy: { class: "unknown", sharedMutable: false } },
      stepId: "check",
      stepAttempt: 1,
      assignmentId: attempt.assignmentId,
      attemptId: attempt.attemptId,
      outcome: "passed",
      evidenceRefs: [{ id: "gev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", kind: "gate", hash: streamHash("ev"), status: "settled" }],
    });
    assert.throws(() => foldStoredVnextRun(context, context.eventStore.run(run.runId)!), /blocked_uncertain|run_events_illegal/);
  });

  await withRun("gate-command", "uncertain-dispatch", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    recordGateUncertain(context, run, envelope, "check", "stream-error", incompleteProof("error"));
    assert.equal(readVnextRunStatus(context, context.eventStore.run(run.runId)!), "running");
    assert.equal(context.eventStore.gateRowCounts(run.runId).evidence, 0);
  });

  await withRun("gate-command", "uncertain-after-complete", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    recordGateSettlement(context, run, envelope, "check", commandComplete(0));
    assert.throws(
      () => recordGateUncertain(context, context.eventStore.run(run.runId)!, envelope, "check", "timeout", incompleteProof("timeout")),
      /run_events_illegal|gate intent has not been recorded/,
    );
  });

  await withRun("gate-command", "blocked-after-observed", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    const attempt = context.eventStore.gateAttemptsForRun(run.runId)[0]!;
    const observationId = "obs_dddddddddddddddddddddddddddddddd";
    const now = new Date().toISOString();
    const observed = appendRaw(context, context.eventStore.run(run.runId)!, "effect.observed", {
      effect: { id: attempt.effectId, policy: { class: "unknown", sharedMutable: false } },
      stepId: "check",
      stepAttempt: 1,
      assignmentId: attempt.assignmentId,
      attemptId: attempt.attemptId,
      receipt: { provider: "kxm-gate", kind: "command", id: observationId, hash: streamHash("tmp"), observedAt: now },
    });
    const observation: VnextGateObservationRow = {
      observationId,
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      projectId: attempt.projectId,
      homeRuntimeId: attempt.homeRuntimeId,
      stepId: attempt.stepId,
      stepAttempt: attempt.stepAttempt,
      assignmentId: attempt.assignmentId,
      effectId: attempt.effectId,
      ...commandComplete(0),
      recordedEventId: observed.eventId,
      contentHash: "",
    };
    const hashed = { ...observation, contentHash: gateRowContentHash("gate_observations", { ...observation, contentHash: "" }) };
    (observed.payload.receipt as { hash: string }).hash = hashed.contentHash;
    sql(context.eventStore.path, (db) => {
      db.prepare("UPDATE events SET payload = ? WHERE event_id = ?").run(JSON.stringify(observed.payload), observed.eventId);
    });
    context.eventStore.insertGateObservation(hashed);
    foldStoredVnextRun(context, context.eventStore.run(run.runId)!);
    assert.throws(
      () => recordGateUncertain(context, context.eventStore.run(run.runId)!, envelope, "check", "cancel", incompleteProof("cancel")),
      /blocked_uncertain after an observation is illegal/,
    );
  });

  await withRun("gate-command", "no-start", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    const settled = recordGateNoStart(context, run, envelope, "check", noStartProof("none", "spawn-error"));
    assert.equal(settled.state.status, "failed");
    assert.equal(settled.state.terminalReason, "gate_start_failed");
    const events = context.eventStore.events(run.runId, 0, 200);
    assert.equal(events.some((event) => event.eventType === "assignment.executing"), false);
    const settledEvent = events.find((event) => event.eventType === "effect.settled")!;
    assert.equal(settledEvent.payload.outcome, undefined);
    assert.equal(settledEvent.payload.evidenceRefs, undefined);
    const observation = context.eventStore.gateObservationForAttempt(context.eventStore.gateAttemptsForRun(run.runId)[0]!.attemptId)!;
    assert.equal((settledEvent.payload.receipt as { id: string }).id, observation.observationId);
    assert.equal((settledEvent.payload.receipt as { hash: string }).hash, observation.contentHash);
    assert.equal(context.eventStore.gateRowCounts(run.runId).evidence, 0);
    assert.equal(context.eventStore.capabilityByAttempt(observation.attemptId)?.state, "settled");
    assert.throws(
      () => recordGateSettlement(context, context.eventStore.run(run.runId)!, envelope, "check", commandComplete(1)),
      /gate intent has not been recorded|run_events_illegal/,
    );
  });

  await withRun("gate-command", "cancel-before-spawn", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    const settled = recordGateNoStart(context, run, envelope, "check", noStartProof("cancel", null));
    assert.equal(settled.state.status, "cancelled");
    assert.equal(context.eventStore.events(run.runId, 0, 200).some((event) => event.eventType === "assignment.executing"), false);
    assert.equal(context.eventStore.gateRowCounts(run.runId).evidence, 0);
  });

  await withRun("gate-command", "cancel-after-complete", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    const settled = recordGateCancelObserved(context, run, envelope, "check", commandComplete(0));
    assert.equal(settled.state.status, "cancelled");
    const settledEvent = context.eventStore.events(run.runId, 0, 200).find((event) => event.eventType === "effect.settled")!;
    assert.equal(settledEvent.payload.outcome, undefined);
    assert.equal(settledEvent.payload.evidenceRefs, undefined);
    assert.equal(context.eventStore.gateRowCounts(run.runId).evidence, 0);
  });

  await withRun("gate-command", "timeout-cannot-settle", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    const timedOut = { ...commandComplete(1), stopCause: "timeout" as const, signal: "SIGKILL", exitCode: null };
    assert.throws(() => recordGateSettlement(context, run, envelope, "check", timedOut), /gate_row_invalid/);
  });

  await withRun("gate-command", "fake-proof", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    const attempt = context.eventStore.gateAttemptsForRun(run.runId)[0]!;
    appendRaw(context, context.eventStore.run(run.runId)!, "effect.settled", {
      effect: { id: attempt.effectId, policy: { class: "unknown", sharedMutable: false } },
      stepId: "check",
      stepAttempt: 1,
      assignmentId: attempt.assignmentId,
      attemptId: attempt.attemptId,
      receipt: { provider: "kxm-gate", kind: "command", id: "obs_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", hash: streamHash("nope"), observedAt: new Date().toISOString() },
    });
    assert.throws(() => readVnextRunStatus(context, context.eventStore.run(run.runId)!), /run_events_illegal|gate_observation_missing/);
  });

  await withRun("gate-command", "executing-unrecorded", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    appendRaw(context, context.eventStore.run(run.runId)!, "run.status_changed", { status: "failed", reason: "executing_unrecorded", stepId: "check" });
    assert.throws(() => readVnextRunStatus(context, context.eventStore.run(run.runId)!), /executing_unrecorded is illegal on a gate step/);
  });
});

test("G8 proof-only settlement cannot count as evaluated success", async () => {
  await withRun("gate-fail", "proof-not-expect-fail", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateNoStart(context, run, envelope, "check", noStartProof("none", "validation"));
    assert.equal(context.eventStore.gateRowCounts(run.runId).evidence, 0);
    assert.equal(readVnextRunStatus(context, context.eventStore.run(run.runId)!), "failed");
    const settled = context.eventStore.events(run.runId, 0, 200).find((event) => event.eventType === "effect.settled")!;
    assert.notEqual(settled.payload.outcome, "passed");
    assert.equal(Array.isArray(settled.payload.evidenceRefs), false);
  });
});

test("G8 cancel and no-start builders refuse contradictory facts", async () => {
  await withRun("gate-command", "cancel-timeout", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    assert.throws(
      () => recordGateCancelObserved(context, run, envelope, "check", { ...commandComplete(0), stopCause: "timeout" }),
      /gate_row_invalid/,
    );
  });
  await withRun("gate-command", "cancel-signal", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    assert.throws(
      () => recordGateCancelObserved(context, run, envelope, "check", { ...commandComplete(0), signal: "SIGTERM" }),
      /gate_row_invalid/,
    );
  });
  await withRun("gate-command", "cancel-missing-close", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    assert.throws(
      () => recordGateCancelObserved(context, run, envelope, "check", { ...commandComplete(0), closeObserved: 0 }),
      /gate_row_invalid/,
    );
  });
  await withRun("gate-command", "cancel-missing-exit", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    assert.throws(
      () => recordGateCancelObserved(context, run, envelope, "check", { ...commandComplete(0), exitObserved: 0, exitCode: null }),
      /gate_row_invalid/,
    );
  });
  await withRun("gate-command", "cancel-incomplete-stream", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    assert.throws(
      () => recordGateCancelObserved(context, run, envelope, "check", { ...commandComplete(0), stdoutComplete: 0 }),
      /gate_row_invalid/,
    );
  });
  await withRun("gate-command", "nostart-pid", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    assert.throws(
      () => recordGateNoStart(context, run, envelope, "check", { ...noStartProof("none", "spawn-error"), pid: 13 }),
      /gate_row_invalid/,
    );
  });
  await withRun("gate-command", "nostart-exit", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    assert.throws(
      () => recordGateNoStart(context, run, envelope, "check", { ...noStartProof("none", "spawn-error"), exitCode: 1, exitObserved: 1 }),
      /gate_row_invalid/,
    );
  });
  await withRun("gate-command", "nostart-timeout", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    assert.throws(
      () => recordGateNoStart(context, run, envelope, "check", { ...noStartProof("none", "spawn-error"), stopCause: "timeout" }),
      /gate_row_invalid/,
    );
  });
  await withRun("gate-command", "nostart-signal", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    assert.throws(
      () => recordGateNoStart(context, run, envelope, "check", { ...noStartProof("none", "spawn-error"), signal: "SIGKILL" }),
      /gate_row_invalid/,
    );
  });
  await withRun("gate-command", "nostart-stream", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    assert.throws(
      () => recordGateNoStart(context, run, envelope, "check", {
        ...noStartProof("none", "spawn-error"),
        stdoutSha256: streamHash("leak"),
        stdoutBytes: 4,
        stdoutComplete: 1,
      }),
      /gate_row_invalid/,
    );
  });
});

test("G8 rehashed on-disk contradictions fail replay independently of insertion", async () => {
  const cases: Array<{ name: string; setup: "complete" | "no-start"; mutate: (row: VnextGateObservationRow) => void }> = [
    { name: "replay-timeout", setup: "complete", mutate: (row) => { row.stopCause = "timeout"; } },
    { name: "replay-signal", setup: "complete", mutate: (row) => { row.signal = "SIGTERM"; } },
    { name: "replay-missing-close", setup: "complete", mutate: (row) => { row.closeObserved = 0; } },
    { name: "replay-nostart-pid", setup: "no-start", mutate: (row) => { row.pid = 9; } },
    { name: "replay-nostart-timeout", setup: "no-start", mutate: (row) => { row.stopCause = "timeout"; } },
  ];
  for (const item of cases) {
    await withRun("gate-command", item.name, async ({ context, run, envelope }) => {
      recordGateIntent(context, run, envelope, "check");
      if (item.setup === "complete") {
        recordGateSpawned(context, run, envelope, "check");
        recordGateSettlement(context, run, envelope, "check", commandComplete(0));
      } else {
        recordGateNoStart(context, run, envelope, "check", noStartProof("none", "spawn-error"));
      }
      rewriteObservation(context.eventStore.path, item.mutate);
      await assertReadsFail(context, context.eventStore.run(run.runId)!, "gate_row_invalid");
    });
  }
});

test("G8 proof-only wrong hash, outcome-after-proof, and orphan evidence fail closed", async () => {
  await withRun("gate-command", "wrong-hash-proof", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateNoStart(context, run, envelope, "check", noStartProof("none", "spawn-error"));
    sql(context.eventStore.path, (db) => {
      const row = db.prepare("SELECT event_id, payload FROM events WHERE event_type = 'effect.settled'").get() as { event_id: string; payload: string };
      const payload = JSON.parse(row.payload) as { receipt: { hash: string } };
      payload.receipt.hash = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
      db.prepare("UPDATE events SET payload = ? WHERE event_id = ?").run(JSON.stringify(payload), row.event_id);
    });
    assert.throws(() => readVnextRunStatus(context, context.eventStore.run(run.runId)!), /run_events_illegal|gate_observation_missing/);
  });

  await withRun("gate-command", "outcome-after-proof", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    const attempt = context.eventStore.gateAttemptsForRun(run.runId)[0]!;
    const observationId = "obs_ffffffffffffffffffffffffffffffff";
    const now = new Date().toISOString();
    const observed = appendRaw(context, context.eventStore.run(run.runId)!, "effect.observed", {
      effect: { id: attempt.effectId, policy: { class: "unknown", sharedMutable: false } },
      stepId: "check",
      stepAttempt: 1,
      assignmentId: attempt.assignmentId,
      attemptId: attempt.attemptId,
      receipt: { provider: "kxm-gate", kind: "command", id: observationId, hash: streamHash("tmp"), observedAt: now },
    });
    const observation: VnextGateObservationRow = {
      observationId,
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      projectId: attempt.projectId,
      homeRuntimeId: attempt.homeRuntimeId,
      stepId: attempt.stepId,
      stepAttempt: attempt.stepAttempt,
      assignmentId: attempt.assignmentId,
      effectId: attempt.effectId,
      ...noStartProof("none", "spawn-error"),
      recordedEventId: observed.eventId,
      contentHash: "",
    };
    const hashed = { ...observation, contentHash: gateRowContentHash("gate_observations", { ...observation, contentHash: "" }) };
    (observed.payload.receipt as { hash: string }).hash = hashed.contentHash;
    sql(context.eventStore.path, (db) => {
      db.prepare("UPDATE events SET payload = ? WHERE event_id = ?").run(JSON.stringify(observed.payload), observed.eventId);
    });
    context.eventStore.insertGateObservation(hashed);
    appendRaw(context, context.eventStore.run(run.runId)!, "effect.settled", {
      effect: { id: attempt.effectId, policy: { class: "unknown", sharedMutable: false } },
      stepId: "check",
      stepAttempt: 1,
      assignmentId: attempt.assignmentId,
      attemptId: attempt.attemptId,
      receipt: { provider: "kxm-gate", kind: "command", id: observationId, hash: hashed.contentHash, observedAt: now },
    });
    appendRaw(context, context.eventStore.run(run.runId)!, "assignment.result_recorded", {
      assignmentId: attempt.assignmentId,
      resultClass: "outcome",
      outcome: "passed",
      status: "result_recorded",
    });
    assert.throws(() => readVnextRunStatus(context, context.eventStore.run(run.runId)!), /gate outcome requires evaluated effect.settled|run_events_illegal/);
  });

  await withRun("gate-command", "orphan-evidence-nonssettled", async ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    const attempt = context.eventStore.gateAttemptsForRun(run.runId)[0]!;
    const observationId = "obs_11111111111111111111111111111111";
    const now = new Date().toISOString();
    const observed = appendRaw(context, context.eventStore.run(run.runId)!, "effect.observed", {
      effect: { id: attempt.effectId, policy: { class: "unknown", sharedMutable: false } },
      stepId: "check",
      stepAttempt: 1,
      assignmentId: attempt.assignmentId,
      attemptId: attempt.attemptId,
      receipt: { provider: "kxm-gate", kind: "command", id: observationId, hash: streamHash("tmp"), observedAt: now },
    });
    const observation: VnextGateObservationRow = {
      observationId,
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      projectId: attempt.projectId,
      homeRuntimeId: attempt.homeRuntimeId,
      stepId: attempt.stepId,
      stepAttempt: attempt.stepAttempt,
      assignmentId: attempt.assignmentId,
      effectId: attempt.effectId,
      ...commandComplete(0),
      recordedEventId: observed.eventId,
      contentHash: "",
    };
    const hashed = { ...observation, contentHash: gateRowContentHash("gate_observations", { ...observation, contentHash: "" }) };
    (observed.payload.receipt as { hash: string }).hash = hashed.contentHash;
    sql(context.eventStore.path, (db) => {
      db.prepare("UPDATE events SET payload = ? WHERE event_id = ?").run(JSON.stringify(observed.payload), observed.eventId);
    });
    context.eventStore.insertGateObservation(hashed);
    sql(context.eventStore.path, (db) => {
      const evidence = {
        evidenceId: "gev_22222222222222222222222222222222",
        attemptId: attempt.attemptId,
        observationId,
        runId: attempt.runId,
        projectId: attempt.projectId,
        homeRuntimeId: attempt.homeRuntimeId,
        stepId: attempt.stepId,
        stepAttempt: attempt.stepAttempt,
        assignmentId: attempt.assignmentId,
        effectId: attempt.effectId,
        evidenceKey: null as string | null,
        kind: "gate" as const,
        expect: attempt.expect,
        outcome: "passed" as const,
        settledEventId: observed.eventId,
        contentHash: "",
      };
      evidence.contentHash = gateRowContentHash("gate_evidence", { ...evidence, contentHash: "" });
      db.prepare(`
        INSERT INTO gate_evidence (
          evidence_id, attempt_id, observation_id, run_id, project_id, home_runtime_id, step_id, step_attempt,
          assignment_id, effect_id, evidence_key, kind, expect, outcome, settled_event_id, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        evidence.evidenceId, evidence.attemptId, evidence.observationId, evidence.runId, evidence.projectId,
        evidence.homeRuntimeId, evidence.stepId, evidence.stepAttempt, evidence.assignmentId, evidence.effectId,
        evidence.evidenceKey, evidence.kind, evidence.expect, evidence.outcome, evidence.settledEventId, evidence.contentHash,
      );
    });
    await assertReadsFail(context, context.eventStore.run(run.runId)!, "gate_evidence");
  });
});

test("G8 artifacts cancel uses read-only policy and complete facts", async () => {
  await withRun("artifacts-gate", "artifacts-cancel", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    const settled = recordGateCancelObserved(context, run, envelope, "check", artifactsComplete(0));
    assert.equal(settled.state.status, "cancelled");
    const observed = context.eventStore.events(run.runId, 0, 200).find((event) => event.eventType === "effect.observed")!;
    assert.equal((observed.payload.effect as { policy: { class: string } }).policy.class, "read-only");
    const settledEvent = context.eventStore.events(run.runId, 0, 200).find((event) => event.eventType === "effect.settled")!;
    assert.equal((settledEvent.payload.effect as { policy: { class: string } }).policy.class, "read-only");
    assert.equal(settledEvent.payload.outcome, undefined);
  });
});

test("G6 observation owned by this run with a foreign attempt is visible", async () => {
  const { root, stateRoot } = gateProject("kxm-gate-foreign-obs-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const first = acceptVnextRun(context, bundle, { workflowId: "gate-command", prompt: "owner" });
      pinVnextCompiledPlan(context, bundle, first.run.runId);
      startVnextRun(context, first.run.runId);
      const run1 = context.eventStore.run(first.run.runId)!;
      const envelope1 = loadVnextRunPlanEnvelope(context.eventStore, run1);
      recordGateIntent(context, run1, envelope1, "check");
      recordGateSpawned(context, run1, envelope1, "check");
      recordGateSettlement(context, run1, envelope1, "check", commandComplete(0));

      const second = acceptVnextRun(context, bundle, { workflowId: "gate-command", prompt: "other" });
      pinVnextCompiledPlan(context, bundle, second.run.runId);
      startVnextRun(context, second.run.runId);
      const run2 = context.eventStore.run(second.run.runId)!;
      const envelope2 = loadVnextRunPlanEnvelope(context.eventStore, run2);
      recordGateIntent(context, run2, envelope2, "check");
      sql(context.eventStore.path, (db) => {
        db.prepare("UPDATE gate_observations SET run_id = ? WHERE run_id = ?").run(run2.runId, run1.runId);
      });
      await assertReadsFail(context, context.eventStore.run(run2.runId)!, "gate_evidence_orphan");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("G6 rehashed outcome tampering is detected from the observation", async () => {
  await withRun("gate-command", "rehashed-outcome", async ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    recordGateSettlement(context, run, envelope, "check", commandComplete(0));
    sql(context.eventStore.path, (db) => {
      const row = db.prepare("SELECT * FROM gate_evidence").get() as Record<string, unknown>;
      const mapped = {
        evidenceId: row.evidence_id as string,
        attemptId: row.attempt_id as string,
        observationId: row.observation_id as string,
        runId: row.run_id as string,
        projectId: row.project_id as string,
        homeRuntimeId: row.home_runtime_id as string,
        stepId: row.step_id as string,
        stepAttempt: row.step_attempt as number,
        assignmentId: row.assignment_id as string,
        effectId: row.effect_id as string,
        evidenceKey: row.evidence_key as string | null,
        kind: "gate" as const,
        expect: row.expect as "pass" | "fail",
        outcome: "implementation-failure" as const,
        settledEventId: row.settled_event_id as string,
        contentHash: "",
      };
      mapped.contentHash = gateRowContentHash("gate_evidence", { ...mapped, contentHash: "" });
      db.prepare("UPDATE gate_evidence SET outcome = ?, content_hash = ?").run(mapped.outcome, mapped.contentHash);
      const events = db.prepare("SELECT event_id, event_type, payload FROM events WHERE run_id = ?").all(run.runId) as Array<{ event_id: string; event_type: string; payload: string }>;
      for (const event of events) {
        const payload = JSON.parse(event.payload) as Record<string, unknown>;
        if (event.event_type === "effect.settled") {
          payload.outcome = "implementation-failure";
          const refs = payload.evidenceRefs as Array<{ hash: string }>;
          refs[0]!.hash = mapped.contentHash;
        }
        if (event.event_type === "assignment.result_recorded" || event.event_type === "assignment.terminal" || event.event_type === "step.outcome_recorded" || event.event_type === "step.transitioned") {
          if (payload.outcome === "passed") payload.outcome = "implementation-failure";
        }
        if (event.event_type === "step.transitioned" && payload.status === "completed") payload.status = "failed";
        if (event.event_type === "step.status_changed" && payload.status === "passed") payload.status = "failed";
        if (event.event_type === "run.status_changed" && payload.status === "completed") {
          payload.status = "failed";
          payload.reason = "implementation-failure";
        }
        db.prepare("UPDATE events SET payload = ? WHERE event_id = ?").run(JSON.stringify(payload), event.event_id);
      }
    });
    await assertReadsFail(context, context.eventStore.run(run.runId)!, "gate_evidence_hash_mismatch");
  });
});

test("G9 pin drift and coordinated rewrite trust boundary", async () => {
  await withRun("gate-command", "envelope-only", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    sql(context.eventStore.path, (db) => {
      const row = db.prepare("SELECT envelope FROM run_plans WHERE run_id = ?").get(run.runId) as { envelope: string };
      const parsed = JSON.parse(row.envelope) as { gates: { controlRoot: { projectKey: string } } };
      parsed.gates.controlRoot.projectKey = "mutated";
      db.prepare("UPDATE run_plans SET envelope = ? WHERE run_id = ?").run(JSON.stringify(parsed), run.runId);
    });
    assert.throws(() => loadVnextRunPlanEnvelope(context.eventStore, context.eventStore.run(run.runId)!), /run_plan_corrupt/);
  });

  await withRun("gate-command", "pin-and-envelope", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    sql(context.eventStore.path, (db) => {
      const row = db.prepare("SELECT envelope, pinned_sequence FROM run_plans WHERE run_id = ?").get(run.runId) as { envelope: string; pinned_sequence: number };
      const parsed = JSON.parse(row.envelope) as VnextRunPlanEnvelope;
      const mutated = {
        ...parsed,
        gates: { ...parsed.gates, controlRoot: { ...parsed.gates.controlRoot, projectKey: "drifted-key" } },
      };
      const hash = hashVnextRunPlanEnvelope(mutated);
      db.prepare("UPDATE run_plans SET envelope = ?, run_plan_hash = ? WHERE run_id = ?").run(vnextCanonicalJson(mutated as unknown as JsonValue), hash, run.runId);
      const pin = db.prepare("SELECT event_id, payload FROM events WHERE sequence = ? AND run_id = ?").get(row.pinned_sequence, run.runId) as { event_id: string; payload: string };
      const payload = JSON.parse(pin.payload) as { runPlanHash: string };
      payload.runPlanHash = hash;
      db.prepare("UPDATE events SET payload = ? WHERE event_id = ?").run(JSON.stringify(payload), pin.event_id);
    });
    assert.throws(() => foldStoredVnextRun(context, context.eventStore.run(run.runId)!), /gate_attempt_pin_mismatch/);
  });

  await withRun("gate-command", "coordinated-rewrite", ({ context, run, envelope }) => {
    recordGateIntent(context, run, envelope, "check");
    recordGateSpawned(context, run, envelope, "check");
    recordGateSettlement(context, run, envelope, "check", commandComplete(0));
    sql(context.eventStore.path, (db) => {
      const row = db.prepare("SELECT envelope, pinned_sequence FROM run_plans WHERE run_id = ?").get(run.runId) as { envelope: string; pinned_sequence: number };
      const parsed = JSON.parse(row.envelope) as VnextRunPlanEnvelope;
      const mutated = {
        ...parsed,
        gates: { ...parsed.gates, controlRoot: { ...parsed.gates.controlRoot, projectKey: "rewritten-together" } },
      };
      const hash = hashVnextRunPlanEnvelope(mutated);
      db.prepare("UPDATE run_plans SET envelope = ?, run_plan_hash = ? WHERE run_id = ?").run(vnextCanonicalJson(mutated as unknown as JsonValue), hash, run.runId);
      const pin = db.prepare("SELECT event_id, payload FROM events WHERE sequence = ? AND run_id = ?").get(row.pinned_sequence, run.runId) as { event_id: string; payload: string };
      const payload = JSON.parse(pin.payload) as { runPlanHash: string };
      payload.runPlanHash = hash;
      db.prepare("UPDATE events SET payload = ? WHERE event_id = ?").run(JSON.stringify(payload), pin.event_id);
      const attempt = db.prepare("SELECT * FROM gate_attempts WHERE run_id = ?").get(run.runId) as Record<string, unknown>;
      const tsAttempt: VnextGateAttemptRow = {
        attemptId: attempt.attempt_id as string,
        runId: attempt.run_id as string,
        projectId: attempt.project_id as string,
        homeRuntimeId: attempt.home_runtime_id as string,
        stepId: attempt.step_id as string,
        stepAttempt: attempt.step_attempt as number,
        assignmentId: attempt.assignment_id as string,
        effectId: attempt.effect_id as string,
        gateId: attempt.gate_id as string,
        gateKind: attempt.gate_kind as VnextGateAttemptRow["gateKind"],
        expect: attempt.expect as VnextGateAttemptRow["expect"],
        gateDefinitionHash: attempt.gate_definition_hash as string,
        registryHash: attempt.registry_hash as string,
        runPlanHash: hash,
        controlProjectKey: "rewritten-together",
        producerId: "kxm-gate",
        intentEventId: attempt.intent_event_id as string,
        contentHash: "",
      };
      tsAttempt.contentHash = gateRowContentHash("gate_attempts", { ...tsAttempt, contentHash: "" });
      db.prepare("UPDATE gate_attempts SET control_project_key = ?, run_plan_hash = ?, content_hash = ? WHERE attempt_id = ?").run(
        tsAttempt.controlProjectKey,
        tsAttempt.runPlanHash,
        tsAttempt.contentHash,
        tsAttempt.attemptId,
      );
    });
    assert.equal(readVnextRunStatus(context, context.eventStore.run(run.runId)!), "completed");
  });

  const { root, stateRoot } = gateProject("kxm-gate-revision-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "gate-command", prompt: "timeout-edit" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      const before = loadVnextRunPlanEnvelope(context.eventStore, context.eventStore.run(accepted.run.runId)!);
      writeFileSync(join(root, ".kxm", "gates.yaml"), `schema: kxm.gate-registry.v1
gates:
  test:
    kind: command
    argv: [npm, test]
    timeoutMs: 1000
  artifacts:
    kind: artifacts-exist
    paths: [dist/index.js]
`);
      const drifted = loadVnextProject(root);
      const beforeRev = vnextPolicyRevisions(bundle);
      const afterRev = vnextPolicyRevisions(drifted);
      assert.notEqual(drifted.configRevision, bundle.configRevision);
      assert.notEqual(afterRev.toolPolicyRevision, beforeRev.toolPolicyRevision);
      const driftedDef = (drifted.gateRegistry!.value.gates as { test: JsonValue }).test;
      assert.notEqual(
        gateDefinitionHash("test", driftedDef),
        gateDefinitionHash("test", before.gates.definitions.test as unknown as JsonValue),
      );
      assert.throws(() => pinVnextCompiledPlan(context, drifted, accepted.run.runId), /run_revision_drift/);
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

test("G10 agent-only regressions still fold through the single production path", async () => {
  const { root, stateRoot } = engineProject("kxm-gate-agent-regression-");
  try {
    const bundle = loadVnextProject(root);
    const context = openVnextRuntimeContext(root, { stateRoot, homeRuntimeId: HOME });
    try {
      const accepted = acceptVnextRun(context, bundle, { workflowId: "agent-only", prompt: "agent" });
      pinVnextCompiledPlan(context, bundle, accepted.run.runId);
      let index = 0;
      const outcomes = ["passed", "failed", "passed", "passed", "passed"];
      const driven = await driveVnextRun(context, accepted.run.runId, createVnextSimulatedProducer(async () => {
        const outcome = outcomes[index];
        index += 1;
        assert.ok(outcome);
        return { outcome };
      }));
      assert.equal(driven.state.status, "completed");
      assert.equal(context.eventStore.gateRowCounts(accepted.run.runId).attempts, 0);
      const stored = context.eventStore.runState(accepted.run.runId)!.state;
      assert.equal(vnextCanonicalJson(foldStoredVnextRun(context, context.eventStore.run(accepted.run.runId)!) as unknown as JsonValue), stored);
      const gated = acceptVnextRun(context, bundle, { workflowId: "unsupported-gate", prompt: "still-refused" });
      pinVnextCompiledPlan(context, bundle, gated.run.runId);
      startVnextRun(context, gated.run.runId);
      const blocked = await driveVnextRun(context, gated.run.runId, createVnextSimulatedProducer(async () => ({ outcome: "passed" })));
      assert.equal(blocked.handoff?.reason, "step_unsupported");
    } finally {
      closeVnextRuntimeContext(context);
    }
  } finally {
    removeTempDir(root, stateRoot);
  }
});

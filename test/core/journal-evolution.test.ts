import assert from "node:assert/strict";
import test from "node:test";
import {
  EVIDENCE_REQUIRED_JOURNAL_CATEGORIES,
  JOURNAL_CATEGORIES,
  JOURNAL_PROMOTION_STATES,
  PROMOTABLE_JOURNAL_CATEGORIES,
  applyJournalPromotion,
  improvementReport,
  journalEvidenceRequired,
  journalPromotionState,
  parseJournalCategory,
  type JournalCategory,
  type WorkflowJournalEntry,
} from "../../plugins/kxm/src/workflow.ts";
import { buildRetrospective } from "../../plugins/kxm/src/retrospective.ts";

function entry(overrides: Record<string, unknown> = {}): WorkflowJournalEntry {
  return {
    id: "journal_1",
    runId: "run_1",
    agentId: "agent_implementer",
    category: "plan",
    area: "implementation",
    severity: "info",
    summary: "stage summary",
    evidence: [],
    relatedEntryIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as WorkflowJournalEntry;
}

test("journal categories extend v0.4 with the five v0.5 learning types", () => {
  assert.deepEqual(JOURNAL_CATEGORIES, [
    "plan",
    "decision",
    "contradiction",
    "error",
    "lesson",
    "observation",
    "hypothesis",
    "experiment",
    "state-change",
    "skill-candidate",
  ]);
  assert.equal(parseJournalCategory("observation"), "observation");
  assert.equal(parseJournalCategory("skill-candidate"), "skill-candidate");
  assert.equal(parseJournalCategory("plan"), "plan");
  assert.throws(() => parseJournalCategory("vibe"), /invalid journal category/);
  assert.throws(() => parseJournalCategory(42), /invalid journal category/);
  // Legacy v0.4 records must remain readable: their categories all parse.
  for (const legacy of ["plan", "decision", "contradiction", "error", "lesson"] as const) {
    assert.equal(journalEvidenceRequired(legacy), legacy === "lesson");
  }
});

test("lessons and skill candidates require durable evidence", () => {
  assert.deepEqual(EVIDENCE_REQUIRED_JOURNAL_CATEGORIES, ["lesson", "skill-candidate"]);
  assert.equal(journalEvidenceRequired("lesson"), true);
  assert.equal(journalEvidenceRequired("skill-candidate"), true);
  assert.equal(journalEvidenceRequired("observation"), false);
  assert.equal(journalEvidenceRequired("state-change"), false);
});

test("governed promotion lifecycle is monotonic and self-decision-proof", () => {
  const candidate = entry({
    id: "journal_skill1",
    category: "skill-candidate",
    agentId: "agent_author",
    evidence: ["receipt:run_1/verify", "receipt:run_2/verify"],
  });
  assert.equal(journalPromotionState(candidate), "proposed");

  // Self-promotion fails closed.
  assert.throws(
    () => applyJournalPromotion(candidate, { to: "approved", evidenceRefs: ["ev"], decidedBy: "agent_author", reason: "trust me" }, "2026-01-02T00:00:00.000Z"),
    /cannot decide its promotion/,
  );

  const approved = applyJournalPromotion(
    candidate,
    { to: "approved", evidenceRefs: ["eval:static-review", "eval:sandbox"], decidedBy: "kxm-admin", reason: "passed protected eval" },
    "2026-01-02T00:00:00.000Z",
  );
  assert.equal(journalPromotionState(approved), "approved");
  assert.deepEqual(approved.promotion?.[0]?.from, "proposed");
  assert.deepEqual(approved.promotion?.[0]?.evidenceRefs, ["eval:static-review", "eval:sandbox"]);

  // Terminal states never re-open, in any direction.
  for (const to of ["approved", "rejected", "quarantined"] as const) {
    assert.throws(
      () => applyJournalPromotion(approved, { to, evidenceRefs: ["ev"], decidedBy: "kxm-admin", reason: "again" }, "2026-01-03T00:00:00.000Z"),
      /terminal state/,
    );
  }

  // Rejected hypotheses and failed experiments stay queryable, not flattened.
  const rejectedHypothesis = applyJournalPromotion(
    entry({ id: "journal_hyp1", category: "hypothesis", agentId: "agent_critic" }),
    { to: "rejected", evidenceRefs: ["experiment:run_1/counterexample"], decidedBy: "kxm-admin", reason: "counterexample observed" },
    "2026-01-02T00:00:00.000Z",
  );
  assert.equal(journalPromotionState(rejectedHypothesis), "rejected");
  assert.equal(rejectedHypothesis.promotion?.length, 1);

  // Evidence is mandatory for every promotion decision.
  assert.throws(
    () => applyJournalPromotion(candidate, { to: "approved", evidenceRefs: [], decidedBy: "kxm-admin", reason: "no evidence" }, "2026-01-02T00:00:00.000Z"),
    /at least one durable evidence reference/,
  );

  // Only promotable categories participate.
  const observation = entry({ category: "observation" });
  assert.equal(journalPromotionState(observation), undefined);
  assert.throws(
    () => applyJournalPromotion(observation, { to: "approved", evidenceRefs: ["ev"], decidedBy: "kxm-admin", reason: "why" }, "2026-01-02T00:00:00.000Z"),
    /do not participate in promotion/,
  );
  assert.deepEqual(PROMOTABLE_JOURNAL_CATEGORIES, ["skill-candidate", "hypothesis", "experiment"]);
  assert.deepEqual(JOURNAL_PROMOTION_STATES, ["proposed", "approved", "rejected", "quarantined"]);
});

test("v0.4 journal entries remain fully readable and backward compatible", () => {
  const legacy = entry({
    id: "journal_legacy",
    category: "lesson",
    evidence: ["class:flaky_gate"],
  });
  // No stageId/attempt/promotion fields: everything reads as before.
  assert.equal(legacy.stageId, undefined);
  assert.equal(journalPromotionState(legacy), undefined);
  const reports = improvementReport([legacy]);
  assert.equal(reports[0]?.lessons, 1);

  const stageBound = entry({
    category: "experiment",
    stageId: "repro-write",
    attempt: 2,
  });
  assert.equal(journalPromotionState(stageBound), "proposed");
});

test("retrospective exports new categories with promotion state and no raw bodies", () => {
  const run = {
    id: "run_retro1",
    definitionId: "def1",
    source: "github" as const,
    deliveryId: "delivery_1",
    payloadHash: "hash",
    project: "kxm",
    targetAgentId: "agent_coord",
    targetAgentName: "coord",
    messageId: "msg_1",
    status: "completed" as const,
    stages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
  };
  const candidate = entry({
    id: "journal_retro_skill",
    runId: run.id,
    category: "skill-candidate",
    summary: "repro pattern for flaky Playwright suites",
    evidence: ["receipt:run_retro1"],
  });
  const promoted = applyJournalPromotion(
    candidate,
    { to: "quarantined", evidenceRefs: ["eval:safety"], decidedBy: "kxm-admin", reason: "safety eval failed" },
    "2026-01-02T00:00:00.000Z",
  );
  const built = buildRetrospective(run, [legacyEntry(run.id), candidate, { ...promoted, id: "journal_retro_skill_promoted" }]);
  const skillEntry = built.entries.find((item) => item.id === "journal_retro_skill_promoted");
  assert.equal(skillEntry?.promotionState, "quarantined");
  assert.equal(skillEntry?.category, "skill-candidate");
  // v0.4-shaped entries (lesson) export without promotion state.
  const legacyExport = built.entries.find((item) => item.id === "journal_retro_legacy");
  assert.equal(legacyExport?.promotionState, undefined);
  assert.equal(built.counts.byCategory["lesson"], 1);
  assert.equal(built.counts.byCategory["skill-candidate"], 2);
  // Improvement report surfaces skill candidates as priorities.
  const report = improvementReport([candidate, promoted]);
  assert.equal(report[0]?.priorities.length, 2);
});

function legacyEntry(runId: string): WorkflowJournalEntry {
  return entry({
    id: "journal_retro_legacy",
    runId,
    category: "lesson",
    area: "gates",
    severity: "warning",
    summary: "flaky retry gate needs backoff",
    evidence: ["class:flaky_gate"],
  });
}

test("hub enforces journal evidence, new categories, and governed promotion", async (context) => {
  const { createTestMesh } = await import("../helpers.ts");
  const { createHmac } = await import("node:crypto");
  const secret = "journal-hub-secret-with-entropy";
  const mesh = await createTestMesh(context, {
    webhookWorkflows: [{
      id: "journal-hub",
      source: "generic",
      project: "test-project",
      target: "coordinator",
      secret,
      delivery: "followUp",
      promptTemplate: "Handle {{task}}",
      stages: [{ id: "gate", label: "Gate", instructions: "Run gate", requiredEvidence: ["result"], maxAttempts: 2 }],
    }],
  });
  const coordinator = mesh.makeClient("coordinator");
  await coordinator.start(async (event) => {
    if (event.type === "message") await coordinator.acknowledge(event.message.id);
  });
  const payload = JSON.stringify({ task: "journal-hub" });
  const trigger = await fetch(`${mesh.address.url}/v1/webhooks/journal-hub`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kxm-delivery-id": "journal-hub-1",
      "x-hub-signature": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
    },
    body: payload,
  });
  const acceptedBody = await trigger.json() as { run: { id: string } };
  const runId = acceptedBody.run.id;

  // New categories are accepted with stage/attempt provenance.
  const observation = await coordinator.recordWorkflowEntry(runId, {
    category: "observation",
    area: "implementation",
    summary: "flaky gate passes on retry",
    stageId: "gate",
  });
  assert.equal(observation.category, "observation");
  assert.equal(observation.stageId, "gate");
  assert.equal(observation.attempt, 1);

  // Skill candidates require evidence at the hub boundary.
  await assert.rejects(
    () => coordinator.recordWorkflowEntry(runId, {
      category: "skill-candidate",
      area: "gates",
      summary: "add flaky-gate retry skill",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /requires at least one durable evidence reference/);
      return true;
    },
  );
  const candidate = await coordinator.recordWorkflowEntry(runId, {
    category: "skill-candidate",
    area: "gates",
    summary: "add flaky-gate retry skill",
    evidence: ["receipt:journal-hub-1/verify"],
  });
  assert.equal(candidate.category, "skill-candidate");

  // Promotion is admin-only: a caller without the administrative token is rejected.
  const forbidden = await fetch(`${mesh.address.url}/v1/journal/${candidate.id}/promotion`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
    body: JSON.stringify({ to: "approved", evidenceRefs: ["eval:1"], reason: "self-approval" }),
  });
  assert.equal(forbidden.status, 401);

  // Mesh admin promotes with durable evidence.
  const promotion = await fetch(`${mesh.address.url}/v1/journal/${candidate.id}/promotion`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${mesh.token}` },
    body: JSON.stringify({ to: "approved", evidenceRefs: ["eval:static-review", "eval:sandbox"], reason: "protected eval passed" }),
  });
  assert.equal(promotion.status, 200);
  const promoted = await promotion.json() as { entry: { promotion: { to: string }[] } };
  assert.equal(promoted.entry.promotion?.[0]?.to, "approved");

  // The promotion decision is idempotent-rejected: terminal states stick.
  const second = await fetch(`${mesh.address.url}/v1/journal/${candidate.id}/promotion`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${mesh.token}` },
    body: JSON.stringify({ to: "rejected", evidenceRefs: ["eval:1"], reason: "changed mind" }),
  });
  assert.equal(second.status, 400);
  assert.equal(((await second.json() as { code: string }).code), "journal_promotion_invalid");
});

test("kxm_workflow_record binds stage provenance and the stage's area end to end, and hub-authored entries carry it too", async (context) => {
  const { createTestMesh } = await import("../helpers.ts");
  const { createHmac } = await import("node:crypto");
  const { AGENT_COMMANDS_MAP } = await import("../../plugins/kxm/src/commands.ts");
  const { HubHttpError } = await import("../../plugins/kxm/src/client.ts");
  const { IMPROVEMENT_AREAS } = await import("../../plugins/kxm/src/protocol.ts");

  // The tool schema is shared by MCP, Pi and the CLI.
  const tool = AGENT_COMMANDS_MAP.get("kxm_workflow_record")!;
  assert.deepEqual(tool.parameters.properties.category?.enum, [...JOURNAL_CATEGORIES]);
  assert.deepEqual(tool.parameters.properties.area?.enum, [...IMPROVEMENT_AREAS]);
  assert.ok(!(tool.parameters.required ?? []).includes("area"));
  assert.ok(tool.parameters.properties.stageId);

  const secret = "journal-stage-secret-with-entropy";
  const mesh = await createTestMesh(context, {
    webhookWorkflows: [{
      id: "journal-stage",
      source: "generic",
      project: "test-project",
      target: "coordinator",
      secret,
      delivery: "followUp",
      promptTemplate: "Handle {{task}}",
      stages: [{ id: "gate", label: "Gate", instructions: "Run gate", area: "gates", requiredEvidence: ["result"], maxAttempts: 3 }],
    }],
  });
  const coordinator = mesh.makeClient("coordinator");
  await coordinator.start(async (event) => {
    if (event.type === "message") await coordinator.acknowledge(event.message.id);
  });
  const payload = JSON.stringify({ task: "journal-stage" });
  const trigger = await fetch(`${mesh.address.url}/v1/webhooks/journal-stage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kxm-delivery-id": "journal-stage-1",
      "x-hub-signature": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
    },
    body: payload,
  });
  const runId = (await trigger.json() as { run: { id: string } }).run.id;

  // Through the tool's own execute, a stage-bound entry with no area takes
  // the stage's declared area, and the hub derives the active attempt.
  const observation = await tool.execute(coordinator, {
    runId,
    category: "observation",
    summary: "obs",
    stageId: "gate",
  }) as WorkflowJournalEntry;
  assert.equal(observation.category, "observation");
  assert.equal(observation.area, "gates");
  assert.equal(observation.stageId, "gate");
  assert.equal(observation.attempt, 1);

  // The hub-authored error entry for a warning checkpoint carries the stage
  // and the attempt that checkpoint consumed.
  await coordinator.checkpointWorkflow(runId, { stageId: "gate", status: "warning", summary: "gate flaked" });
  const hubError = (await coordinator.getWorkflow(runId)).journal.find((entry) => entry.category === "error");
  assert.equal(hubError?.stageId, "gate");
  assert.equal(hubError?.attempt, 1);
  assert.equal(hubError?.area, "gates");

  // A finished stage binds the last attempt it consumed (2), not attempts+1 (3).
  const passed = await coordinator.checkpointWorkflow(runId, {
    stageId: "gate",
    status: "passed",
    summary: "gate passed",
    evidence: { result: "ok" },
  });
  assert.equal(passed.completed, true);
  const lesson = await tool.execute(coordinator, {
    runId,
    category: "lesson",
    summary: "retry the gate once before failing it",
    evidence: ["receipt:journal-stage-1/gate"],
    stageId: "gate",
  }) as WorkflowJournalEntry;
  assert.equal(lesson.stageId, "gate");
  assert.equal(lesson.attempt, 2);
  assert.equal(lesson.area, "gates");

  // Neither an area nor a stage to take one from.
  await assert.rejects(
    () => tool.execute(coordinator, { runId, category: "observation", summary: "unbound" }),
    (error: unknown) => {
      assert.ok(error instanceof HubHttpError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "invalid_improvement_area");
      return true;
    },
  );
});

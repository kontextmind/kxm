import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildRetrospective, renderRetrospectiveMarkdown, writeRetrospective } from "../plugins/kxm/src/retrospective.ts";
import type { WorkflowJournalEntry, WorkflowRun } from "../plugins/kxm/src/workflow.ts";

function sample(runStatus: WorkflowRun["status"] = "failed"): { run: WorkflowRun; journal: WorkflowJournalEntry[] } {
  const run: WorkflowRun = {
    id: "run_fixture",
    definitionId: "kxm-v04",
    source: "generic",
    deliveryId: "d1",
    payloadHash: "abc",
    project: "demo",
    targetAgentId: "agt_1",
    targetAgentName: "coordinator",
    messageId: "msg_1",
    status: runStatus,
    stages: [{
      id: "research",
      label: "Research",
      instructions: "research",
      requiredEvidence: ["a"],
      maxAttempts: 3,
      area: "workflow",
      status: "in_progress",
      attempts: 0,
      evidence: [],
    }],
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
  const journal: WorkflowJournalEntry[] = [
    {
      id: "journal_1",
      runId: run.id,
      agentId: "agt_1",
      category: "decision",
      area: "implementation",
      severity: "info",
      summary: "Use command-first CLI",
      evidence: ["class:unknown"],
      relatedEntryIds: [],
      createdAt: "2026-08-26T00:00:01.000Z",
    },
    {
      id: "journal_2",
      runId: run.id,
      agentId: "agt_1",
      category: "contradiction",
      area: "workflow",
      severity: "warning",
      summary: "Peers mapped issues differently",
      evidence: ["class:unknown"],
      relatedEntryIds: [],
      createdAt: "2026-08-26T00:00:02.000Z",
    },
    {
      id: "journal_3",
      runId: run.id,
      agentId: "agt_1",
      category: "error",
      area: "harness",
      severity: "error",
      summary: "Tool bash failed: command_not_found token=sk-abcdefghijkl",
      evidence: ["class:command_not_found", "tool:bash"],
      relatedEntryIds: [],
      createdAt: "2026-08-26T00:00:03.000Z",
    },
  ];
  return { run, journal };
}

test("retrospective export is deterministic, redacted, and review-gated", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mesh-retro-"));
  try {
    const { run, journal } = sample();
    const first = buildRetrospective(run, journal, "2026-08-26T00:00:00.000Z");
    const second = buildRetrospective(run, journal, "2026-08-26T00:00:00.000Z");
    assert.deepEqual(first, second);
    assert.equal(first.reviewDecision, "proposed");
    assert.equal(first.openContradictions.length, 1);
    assert.ok(first.recurringErrorClasses.some((entry) => entry.class === "command_not_found" && entry.count === 1));
    assert.doesNotMatch(JSON.stringify(first), /sk-abcdefghijkl/);
    const markdown = renderRetrospectiveMarkdown(first);
    assert.match(markdown, /Review decision: proposed/);
    assert.match(markdown, /not policy/);
    const written = writeRetrospective(directory, first);
    assert.equal(JSON.parse(readFileSync(written.jsonPath, "utf8")).runId, "run_fixture");
    assert.match(readFileSync(written.mdPath, "utf8"), /run_fixture/);
    writeRetrospective(directory, first);
    assert.equal(JSON.parse(readFileSync(written.jsonPath, "utf8")).schema, "pi-mesh.retrospective.v1");
    assert.equal(first.evidenceAudit, undefined);
    assert.equal(first.degradedStageIds, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retrospective adds metadata-only peer provenance and explicit degradation audit", () => {
  const { run, journal } = sample("completed");
  const stage = run.stages[0]!;
  stage.status = "passed";
  stage.attempts = 1;
  stage.degraded = true;
  stage.degradedRequirements = ["Peer Review"];
  stage.resolvedEvidencePolicies = {
    "peer review": {
      kind: "peer-reply",
      minProducers: 2,
      eligibleProducers: [
        { id: "agt_peer_b", name: "reviewer-b" },
        { id: "agt_peer_a", name: "reviewer-a" },
      ],
      acceptedStatuses: ["replied"],
      degradation: { minProducers: 1 },
    },
  };
  stage.verifiedEvidence = {
    "peer review": [{
      schema: "pi-mesh.verified-peer-evidence.v1",
      messageId: "msg_peer_a",
      producerId: "agt_peer_a",
      producerName: "reviewer-a",
      context: {
        schema: "pi-mesh.workflow-message-context.v1",
        runId: run.id,
        stageId: stage.id,
        requirementKey: "peer review",
        attempt: 1,
      },
      status: "replied",
      requestSha256: "a".repeat(64),
      replySha256: "b".repeat(64),
      createdAt: "2026-08-26T00:00:01.000Z",
      replyCreatedAt: "2026-08-26T00:00:02.000Z",
      repliedAt: "2026-08-26T00:00:03.000Z",
      verifiedAt: "2026-08-26T00:00:04.000Z",
      // Deliberately simulate an unexpected persisted field. The export must
      // allowlist metadata instead of spreading source objects.
      ...({ promptBody: "never export me", replyBody: "never export me either" } as object),
    }],
  };
  stage.degradationApprovals = [{
    schema: "pi-mesh.workflow-degradation-approval.v1",
    id: "deg_1",
    requirementKey: "peer review",
    attempt: 1,
    policyMinProducers: 2,
    approvedMinProducers: 1,
    approvedBy: "kxm-admin",
    reason: "Provider outage\n## forged heading token=sk-abcdefghijkl",
    approvedAt: "2026-08-26T00:00:00.500Z",
  }];

  const retrospective = buildRetrospective(run, journal, "2026-08-26T00:01:00.000Z");
  assert.equal(retrospective.schema, "pi-mesh.retrospective.v1");
  assert.deepEqual(retrospective.degradedStageIds, ["research"]);
  assert.equal(retrospective.evidenceAudit?.length, 1);
  const audit = retrospective.evidenceAudit![0]!;
  assert.equal(audit.requirementKey, "peer review");
  assert.equal(audit.attempt, 1);
  assert.equal(audit.policy.minProducers, 2);
  assert.equal(audit.policy.effectiveMinProducers, 1);
  assert.deepEqual(audit.eligibleProducers.map((producer) => producer.id), ["agt_peer_a", "agt_peer_b"]);
  assert.deepEqual(audit.verifiedProducerIds, ["agt_peer_a"]);
  assert.equal(audit.verifiedMessages[0]!.context.attempt, 1);
  assert.equal(audit.verifiedMessages[0]!.hashes.replySha256, "b".repeat(64));
  assert.equal(audit.degraded, true);
  assert.equal(audit.degradationApprovals[0]!.approvedBy, "kxm-admin");
  assert.doesNotMatch(audit.degradationApprovals[0]!.reason, /\n|sk-abcdefghijkl/);

  const serialized = JSON.stringify(retrospective);
  assert.doesNotMatch(serialized, /never export me/);
  assert.doesNotMatch(serialized, /sk-abcdefghijkl/);
  assert.doesNotMatch(serialized, /promptBody|replyBody/);
  const markdown = renderRetrospectiveMarkdown(retrospective);
  assert.match(markdown, /Peer-evidence audit/);
  assert.match(markdown, /immutable provenance metadata and content hashes only/);
  assert.match(markdown, /2 -> 1 producers/);
  assert.doesNotMatch(markdown, /sk-abcdefghijkl|never export me|\n## forged heading/);
});

test("retrospective quorum summary excludes verified producers from earlier attempts", () => {
  const { run, journal } = sample("completed");
  const stage = run.stages[0]!;
  stage.status = "passed";
  stage.attempts = 2;
  stage.resolvedEvidencePolicies = {
    review: {
      kind: "peer-reply",
      minProducers: 2,
      eligibleProducers: [
        { id: "agt_a", name: "reviewer-a" },
        { id: "agt_b", name: "reviewer-b" },
        { id: "agt_c", name: "reviewer-c" },
      ],
      acceptedStatuses: ["replied"],
    },
  };
  const snapshot = (messageId: string, producerId: string, attempt: number) => ({
    schema: "pi-mesh.verified-peer-evidence.v1" as const,
    messageId,
    producerId,
    producerName: `reviewer-${producerId.slice(-1)}`,
    context: {
      schema: "pi-mesh.workflow-message-context.v1" as const,
      runId: run.id,
      stageId: stage.id,
      requirementKey: "review",
      attempt,
    },
    status: "replied" as const,
    requestSha256: "a".repeat(64),
    replySha256: "b".repeat(64),
    createdAt: "2026-08-26T00:00:01.000Z",
    replyCreatedAt: "2026-08-26T00:00:02.000Z",
    repliedAt: "2026-08-26T00:00:03.000Z",
    verifiedAt: "2026-08-26T00:00:04.000Z",
  });
  stage.verifiedEvidence = {
    review: [
      snapshot("msg_attempt_1_a", "agt_a", 1),
      snapshot("msg_attempt_2_b", "agt_b", 2),
      snapshot("msg_attempt_2_c", "agt_c", 2),
    ],
  };

  const audit = buildRetrospective(run, journal, "2026-08-26T00:01:00.000Z").evidenceAudit![0]!;
  assert.equal(audit.attempt, 2);
  assert.deepEqual(audit.verifiedProducerIds, ["agt_b", "agt_c"]);
  assert.deepEqual(audit.verifiedMessages.map((message) => message.messageId), [
    "msg_attempt_2_b",
    "msg_attempt_2_c",
  ]);
  assert.ok(!audit.verifiedProducerIds.includes("agt_a"));
  assert.ok(!audit.verifiedMessages.some((message) => message.messageId === "msg_attempt_1_a"));
});

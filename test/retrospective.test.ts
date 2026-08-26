import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildRetrospective, renderRetrospectiveMarkdown, writeRetrospective } from "../plugins/pi-mesh-comms/src/retrospective.ts";
import type { WorkflowJournalEntry, WorkflowRun } from "../plugins/pi-mesh-comms/src/workflow.ts";

function sample(runStatus: WorkflowRun["status"] = "failed"): { run: WorkflowRun; journal: WorkflowJournalEntry[] } {
  const run: WorkflowRun = {
    id: "run_fixture",
    definitionId: "pi-extensions-v04",
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
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

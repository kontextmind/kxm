import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { MeshStore } from "../plugins/pi-mesh-comms/src/store.ts";
import type { WorkflowJournalEntry, WorkflowRun } from "../plugins/pi-mesh-comms/src/workflow.ts";

test("store supports memory mode and health checks", () => {
  const store = new MeshStore();
  assert.equal(store.persistent, false);
  assert.equal(store.healthy(), true);
  store.deleteMessage("missing");
  store.close();
});

test("store rejects databases created by a newer schema", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mesh-schema-"));
  const path = join(directory, "mesh.db");
  try {
    const database = new Database(path);
    database.pragma("user_version = 3");
    database.close();
    assert.throws(() => new MeshStore(path), /newer than this runtime supports/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("store persists workflow checkpoints and learning journal entries", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mesh-workflow-store-"));
  const path = join(directory, "mesh.db");
  const run: WorkflowRun = {
    id: "run-1",
    definitionId: "jira",
    source: "jira",
    deliveryId: "delivery-1",
    payloadHash: "hash",
    project: "product",
    targetAgentId: "agent-1",
    targetAgentName: "coordinator",
    messageId: "message-1",
    status: "running",
    currentStage: "plan",
    stages: [{ id: "plan", label: "Plan", instructions: "Plan", requiredEvidence: [], maxAttempts: 3, status: "in_progress", attempts: 0, evidence: [] }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const entry: WorkflowJournalEntry = {
    id: "entry-1",
    runId: run.id,
    agentId: "agent-1",
    category: "decision",
    area: "workflow",
    severity: "info",
    summary: "Use three planning agents",
    evidence: ["plan:a", "plan:b", "plan:c"],
    relatedEntryIds: [],
    createdAt: "2026-01-01T00:01:00.000Z",
  };
  try {
    const first = new MeshStore(path);
    first.saveWorkflowRun(run);
    first.saveJournalEntry(entry);
    first.close();
    const second = new MeshStore(path);
    assert.deepEqual(second.workflowRuns.get(run.id), run);
    assert.deepEqual(second.journal.get(entry.id), entry);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

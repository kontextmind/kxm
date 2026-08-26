import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MeshStore } from "../plugins/pi-mesh-comms/src/store.ts";
import type { MessageRecord } from "../plugins/pi-mesh-comms/src/protocol.ts";
import type { WorkflowJournalEntry, WorkflowRun } from "../plugins/pi-mesh-comms/src/workflow.ts";

test("store supports memory mode and health checks", () => {
  const store = new MeshStore();
  assert.equal(store.persistent, false);
  assert.equal(store.healthy(), true);
  store.deleteMessage("missing");
  store.close();
});

test("store preserves the five-second SQLite busy timeout", () => {
  const store = new MeshStore(":memory:");
  const database = (store as unknown as { database: DatabaseSync }).database;
  const row = database.prepare("PRAGMA busy_timeout").get() as { timeout: number };
  assert.equal(row.timeout, 5_000);
  store.close();
});

test("store rejects databases created by a newer schema", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mesh-schema-"));
  const path = join(directory, "mesh.db");
  try {
    const database = new DatabaseSync(path);
    database.exec("PRAGMA user_version = 3");
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

test("workflow transitions commit run, message, and journal atomically and roll back on failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mesh-transition-store-"));
  const path = join(directory, "mesh.db");
  const run: WorkflowRun = {
    id: "run-atomic",
    definitionId: "workflow",
    source: "generic",
    deliveryId: "delivery-atomic",
    payloadHash: "hash",
    project: "product",
    targetAgentId: "agent",
    targetAgentName: "coordinator",
    messageId: "message-original",
    status: "failed",
    stages: [{ id: "gate", label: "Gate", instructions: "Wait", requiredEvidence: [], maxAttempts: 1, status: "failed", attempts: 0, evidence: [] }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
  };
  const message: MessageRecord = {
    id: "message-transition",
    project: "product",
    from: "workflow:run-atomic",
    fromName: "timeout:workflow",
    to: "agent",
    toName: "coordinator",
    content: "Timed out",
    delivery: "followUp",
    hops: 0,
    maxHops: 5,
    correlationId: run.id,
    idempotencyKey: "workflow:timeout",
    createdAt: "2026-01-01T00:01:00.000Z",
    expiresAt: "2026-01-02T00:01:00.000Z",
    status: "queued",
  };
  const entry: WorkflowJournalEntry = {
    id: "journal-transition",
    runId: run.id,
    agentId: "agent",
    category: "error",
    area: "harness",
    severity: "error",
    summary: "Timed out",
    evidence: [],
    relatedEntryIds: [],
    createdAt: "2026-01-01T00:01:00.000Z",
  };
  try {
    const first = new MeshStore(path);
    first.saveWorkflowTransition(run, message, entry);
    first.close();
    const second = new MeshStore(path);
    assert.deepEqual(second.workflowRuns.get(run.id), run);
    assert.deepEqual(second.messages.get(message.id), message);
    assert.deepEqual(second.journal.get(entry.id), entry);
    const conflictingRun = { ...run, id: "run-conflict", messageId: "message-rollback" };
    const rollbackMessage = { ...message, id: "message-rollback", correlationId: conflictingRun.id };
    const rollbackEntry = { ...entry, id: "journal-rollback", runId: conflictingRun.id };
    assert.throws(
      () => second.saveWorkflowTransition(conflictingRun, rollbackMessage, rollbackEntry),
      /UNIQUE constraint failed/,
    );
    assert.equal(second.messages.has(rollbackMessage.id), false);
    assert.equal(second.journal.has(rollbackEntry.id), false);
    assert.equal(second.workflowRuns.has(conflictingRun.id), false);
    second.close();
    const third = new MeshStore(path);
    assert.equal(third.messages.has(rollbackMessage.id), false);
    assert.equal(third.journal.has(rollbackEntry.id), false);
    assert.equal(third.workflowRuns.has(conflictingRun.id), false);
    third.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

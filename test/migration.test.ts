import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { MeshStore } from "../plugins/kxm-mesh/src/store.ts";
import { NativeStateProvider } from "../plugins/kxm-mesh/src/state.ts";
import type { ContextItem } from "../plugins/kxm-mesh/src/context.ts";

/** A hand-built v0.4-shaped database: schema version 2, the four legacy
 * tables, and one row each. Opening it with the current runtime must upgrade
 * in place without losing data. */
function createV04Database(path: string): void {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA user_version = 2;
    CREATE TABLE agents (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
    CREATE TABLE messages (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, definition_id TEXT NOT NULL, delivery_id TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(definition_id, delivery_id)) STRICT;
    CREATE TABLE workflow_journal (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, category TEXT NOT NULL, area TEXT NOT NULL, record TEXT NOT NULL) STRICT;
  `);
  const agent = {
    id: "agent_legacy", key: "key_legacy", name: "legacy-agent", purpose: "v0.4 agent",
    project: "legacy-project", connectedAt: "2025-06-01T00:00:00.000Z", lastSeenAt: "2025-06-01T00:00:00.000Z", online: false,
  };
  const message = {
    id: "msg_legacy", project: "legacy-project", from: "agent_legacy", fromName: "legacy-agent",
    to: "agent_other", toName: "other", content: "legacy work item", delivery: "followUp",
    hops: 0, maxHops: 5, createdAt: "2025-06-01T00:00:01.000Z", expiresAt: "2025-06-02T00:00:01.000Z", status: "queued",
  };
  const run = {
    id: "run_legacy", definitionId: "def_legacy", source: "generic", deliveryId: "delivery_legacy",
    payloadHash: "hash", project: "legacy-project", targetAgentId: "agent_legacy", targetAgentName: "legacy-agent",
    messageId: "msg_legacy", status: "completed", stages: [],
    createdAt: "2025-06-01T00:00:02.000Z", updatedAt: "2025-06-01T00:00:03.000Z",
  };
  const journal = {
    id: "journal_legacy", runId: "run_legacy", agentId: "agent_legacy", category: "lesson",
    area: "gates", severity: "warning", summary: "v0.4 lesson",
    evidence: ["class:legacy"], relatedEntryIds: [], createdAt: "2025-06-01T00:00:04.000Z",
  };
  database.prepare("INSERT INTO agents (id, record) VALUES (?, ?)").run(agent.id, JSON.stringify(agent));
  database.prepare("INSERT INTO messages (id, record) VALUES (?, ?)").run(message.id, JSON.stringify(message));
  database.prepare("INSERT INTO workflow_runs (id, definition_id, delivery_id, record) VALUES (?, ?, ?, ?)").run(run.id, run.definitionId, run.deliveryId, JSON.stringify(run));
  database.prepare("INSERT INTO workflow_journal (id, run_id, category, area, record) VALUES (?, ?, ?, ?, ?)").run(journal.id, journal.runId, journal.category, journal.area, JSON.stringify(journal));
  database.close();
}

test("v0.4 databases upgrade in place to the v0.5 context schema", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kxm-migration-"));
  const path = join(directory, "mesh.db");
  try {
    createV04Database(path);
    const store = new MeshStore(path);
    // Legacy records survive the upgrade untouched.
    assert.equal(store.agents.has("agent_legacy"), true);
    assert.equal(store.messages.has("msg_legacy"), true);
    const run = store.workflowRuns.get("run_legacy");
    assert.equal(run?.status, "completed");
    const legacyJournal = store.journal.get("journal_legacy");
    assert.equal(legacyJournal?.category, "lesson");
    // The context/state tables exist and are usable after the upgrade.
    const upgraded = (store as unknown as { database: DatabaseSync }).database
      .prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(upgraded.user_version, 3);

    // New v0.5 features work against the upgraded store.
    const provider = new NativeStateProvider(store, { now: () => "2026-01-01T00:00:00.000Z" });
    const proposalId = await provider.propose({
      schema: "kxm.state-change-proposal.v1",
      project: "legacy-project",
      key: "ci.pipeline",
      summary: "upgraded store supports v0.5 state",
      authority: "evidence",
      confidence: "verified",
      evidenceRefs: ["migration:test"],
      proposedBy: "migration-fixture",
    });
    const promoted: ContextItem = await provider.promote(proposalId, ["migration:evidence"], "mesh-admin");
    assert.equal(promoted.status, "current");
    assert.equal(store.getContextItem(promoted.id)?.project, "legacy-project");
    // And a v0.4 lesson still reads as a v0.4 lesson (no promotion lifecycle).
    assert.equal(legacyJournal.promotion, undefined);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pre-v0.5 journals keep v0.4 categories readable and extensible", () => {
  const store = new MeshStore(":memory:");
  const entry = {
    id: "journal_v04", runId: "run_x", agentId: "agent_x", category: "plan",
    area: "workflow", severity: "info", summary: "v0.4 plan",
    evidence: [], relatedEntryIds: [], createdAt: "2025-06-01T00:00:00.000Z",
  };
  store.saveJournalEntry(entry as never);
  const loaded = store.journal.get("journal_v04");
  assert.equal(loaded?.category, "plan");
  assert.equal(loaded?.stageId, undefined);
  assert.equal(loaded?.promotion, undefined);
  store.close();
});


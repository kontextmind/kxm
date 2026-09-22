import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { HUB_STORE_SCHEMA_VERSION, HUB_STORE_TABLES, MeshStore } from "../../plugins/kxm/src/store.ts";
import type { ContextItem } from "../../plugins/kxm/src/context.ts";
import type { MessageRecord } from "../../plugins/kxm/src/protocol.ts";
import type { WorkflowJournalEntry, WorkflowRun } from "../../plugins/kxm/src/workflow.ts";

function makeTestMessage(id: string, overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id,
    project: "proj-1",
    from: "s1",
    fromName: "s1",
    to: "agt-1",
    toName: "agt-1",
    content: "c",
    delivery: "followUp",
    hops: 0,
    maxHops: 5,
    status: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

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
  const path = join(directory, "kxm.db");
  try {
    const database = new DatabaseSync(path);
    database.exec(`PRAGMA user_version = ${HUB_STORE_SCHEMA_VERSION + 1}`);
    database.close();
    assert.throws(() => new MeshStore(path), /newer than this runtime supports/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("store persists workflow checkpoints and learning journal entries", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mesh-workflow-store-"));
  const path = join(directory, "kxm.db");
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

test("verified peer evidence survives restart and source-message retention without a schema bump", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mesh-provenance-store-"));
  const path = join(directory, "kxm.db");
  let first: MeshStore | undefined;
  let second: MeshStore | undefined;
  let third: MeshStore | undefined;
  const context = {
    schema: "pi-mesh.workflow-message-context.v1" as const,
    runId: "run-provenance",
    stageId: "review",
    requirementKey: "peer review",
    attempt: 1,
  };
  const sourceMessage: MessageRecord = {
    id: "message-peer-review",
    project: "product",
    from: "agent-coordinator",
    fromName: "coordinator",
    to: "agent-peer",
    toName: "peer",
    content: "Review the implementation",
    delivery: "followUp",
    hops: 0,
    maxHops: 5,
    correlationId: "run-provenance",
    workflowContext: context,
    createdAt: "2026-01-01T00:00:00.000Z",
    deliveredAt: "2026-01-01T00:00:01.000Z",
    repliedAt: "2026-01-01T00:00:03.000Z",
    expiresAt: "2026-01-02T00:00:00.000Z",
    status: "replied",
    reply: { content: "Approved", createdAt: "2026-01-01T00:00:02.000Z" },
  };
  const run: WorkflowRun = {
    id: "run-provenance",
    definitionId: "provenance",
    source: "generic",
    deliveryId: "delivery-provenance",
    payloadHash: "hash",
    project: "product",
    targetAgentId: "agent-coordinator",
    targetAgentName: "coordinator",
    messageId: "workflow-prompt",
    status: "completed",
    stages: [{
      id: "review",
      label: "Review",
      instructions: "Obtain peer review",
      requiredEvidence: ["peer review"],
      maxAttempts: 1,
      status: "passed",
      attempts: 1,
      evidence: {},
      resolvedEvidencePolicies: {
        "peer review": {
          kind: "peer-reply",
          minProducers: 1,
          eligibleProducers: [{ id: "agent-peer", name: "peer" }],
          acceptedStatuses: ["replied"],
        },
      },
      verifiedEvidence: {
        "peer review": [{
          schema: "pi-mesh.verified-peer-evidence.v1",
          messageId: sourceMessage.id,
          producerId: "agent-peer",
          producerName: "peer",
          context,
          status: "replied",
          requestSha256: "a".repeat(64),
          replySha256: "b".repeat(64),
          createdAt: sourceMessage.createdAt,
          replyCreatedAt: sourceMessage.reply!.createdAt,
          repliedAt: sourceMessage.repliedAt!,
          verifiedAt: "2026-01-01T00:00:04.000Z",
        }],
      },
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:04.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
    }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:04.000Z",
    completedAt: "2026-01-01T00:00:04.000Z",
  };
  try {
    first = new MeshStore(path);
    const firstDatabase = (first as unknown as { database: DatabaseSync }).database;
    const firstVersion = firstDatabase.prepare("PRAGMA user_version").get() as { user_version: number };
    // Pinned to the build's own version, not a literal: what this test guards is
    // that peer provenance rides in existing record JSON and bumps nothing.
    assert.equal(firstVersion.user_version, HUB_STORE_SCHEMA_VERSION);
    first.saveMessage(sourceMessage);
    first.saveWorkflowRun(run);
    first.close();
    first = undefined;

    second = new MeshStore(path);
    assert.equal(second.messages.has(sourceMessage.id), true);
    assert.equal(
      second.workflowRuns.get(run.id)?.stages[0]?.verifiedEvidence?.["peer review"]?.[0]?.messageId,
      sourceMessage.id,
    );
    second.deleteMessage(sourceMessage.id);
    second.close();
    second = undefined;

    third = new MeshStore(path);
    const thirdDatabase = (third as unknown as { database: DatabaseSync }).database;
    const thirdVersion = thirdDatabase.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(thirdVersion.user_version, HUB_STORE_SCHEMA_VERSION);
    assert.equal(third.messages.has(sourceMessage.id), false);
    assert.equal(
      third.workflowRuns.get(run.id)?.stages[0]?.verifiedEvidence?.["peer review"]?.[0]?.replySha256,
      "b".repeat(64),
    );
    third.close();
    third = undefined;
  } finally {
    for (const store of [first, second, third]) {
      try {
        store?.close();
      } catch {
        // The store may already be closed after the assertion under test.
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workflow transitions commit run, message, and journal atomically and roll back on failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mesh-transition-store-"));
  const path = join(directory, "kxm.db");
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

test("store queries open and expiring messages on demand in SQLite and memory", () => {
  const storeMem = new MeshStore();
  storeMem.saveMessage(makeTestMessage("m-open-1", { status: "queued", idempotencyKey: "k1" }));
  storeMem.saveMessage(makeTestMessage("m-open-2", { status: "delivered", expiresAt: "2026-01-01T00:00:30.000Z" }));
  storeMem.saveMessage(makeTestMessage("m-closed", { status: "replied" }));
  assert.equal(storeMem.getOpenMessages("proj-1").length, 2);
  assert.equal(storeMem.getExpiringMessages(Date.parse("2026-01-01T00:00:40.000Z")).length, 1);
  assert.equal(storeMem.findMessageByIdempotency("s1", "k1")?.id, "m-open-1");
  assert.equal(storeMem.findMessageByIdempotency("s1", "missing"), undefined);
  storeMem.close();

  const dir = mkdtempSync(join(tmpdir(), "pi-mesh-store-queries-"));
  const path = join(dir, "kxm.db");
  try {
    const storeDb = new MeshStore(path);
    storeDb.saveMessage(makeTestMessage("m-open-1", { status: "queued", idempotencyKey: "k1" }));
    storeDb.saveMessage(makeTestMessage("m-open-2", { status: "delivered", expiresAt: "2026-01-01T00:00:30.000Z" }));
    storeDb.saveMessage(makeTestMessage("m-closed", { status: "replied" }));

    assert.equal(storeDb.getOpenMessages("proj-1").length, 2);
    assert.equal(storeDb.getOpenMessages("proj-other").length, 0);
    assert.equal(storeDb.getExpiringMessages(Date.parse("2026-01-01T00:00:40.000Z")).length, 1);
    assert.equal(storeDb.findMessageByIdempotency("s1", "k1")?.id, "m-open-1");
    assert.equal(storeDb.findMessageByIdempotency("s1", "missing"), undefined);

    // MessageMap iterations
    assert.ok([...storeDb.messages.entries()].length >= 3);
    let forEachCount = 0;
    storeDb.messages.forEach(() => { forEachCount += 1; });
    assert.ok(forEachCount >= 3);
    assert.equal(storeDb.hasMessage("m-open-1"), true);
    assert.equal(storeDb.hasMessage("m-missing"), false);

    storeDb.messages.clear();
    assert.equal(storeDb.messages.cachedSize, 0);
    assert.equal(storeDb.countMessages(), 3);
    storeDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store sweeps retention and deletes runs, journal entries, and context items in SQLite", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mesh-store-retention-"));
  const path = join(dir, "kxm.db");
  try {
    const store = new MeshStore(path);
    const run: WorkflowRun = {
      id: "run-terminal-1",
      definitionId: "d1",
      source: "generic",
      deliveryId: "del-1",
      payloadHash: "hash",
      project: "p1",
      targetAgentId: "agt-1",
      targetAgentName: "agt",
      messageId: "m-1",
      status: "completed",
      stages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    store.saveWorkflowRun(run);
    store.saveJournalEntry({
      id: "j-run-1",
      runId: "run-terminal-1",
      agentId: "agt-1",
      category: "decision",
      area: "implementation",
      severity: "info",
      summary: "test",
      evidence: [],
      relatedEntryIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    store.saveJournalEntry({
      id: "j-orphan-1",
      runId: "run-nonexistent",
      agentId: "agt-1",
      category: "error",
      area: "implementation",
      severity: "warning",
      summary: "orphan",
      evidence: [],
      relatedEntryIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const supersededItem: ContextItem = {
      id: "ctx-superseded-1",
      project: "p1",
      kind: "state",
      summary: "superseded",
      provenance: { sourceType: "tool" },
      authority: "instruction",
      confidence: "probable",
      status: "superseded",
      observedAt: "2026-01-01T00:00:00.000Z",
      validUntil: "2026-01-01T00:00:00.000Z",
    };
    store.saveContextItem(supersededItem);

    const now = Date.parse("2026-01-10T00:00:00.000Z");
    const swept = store.sweepRetention(86_400_000, 86_400_000, now);
    assert.ok(swept.purgedRuns.includes("run-terminal-1"));
    assert.ok(swept.purgedJournal.includes("j-run-1"));
    assert.ok(swept.purgedJournal.includes("j-orphan-1"));
    assert.ok(swept.purgedContextItems.includes("ctx-superseded-1"));

    // Direct delete methods
    store.saveWorkflowRun({ ...run, id: "run-manual-del", deliveryId: "del-manual" });
    store.deleteWorkflowRun("run-manual-del");
    assert.equal(store.workflowRuns.has("run-manual-del"), false);

    store.saveJournalEntry({
      id: "j-manual-del",
      runId: "run-terminal-1",
      agentId: "agt-1",
      category: "decision",
      area: "implementation",
      severity: "info",
      summary: "test",
      evidence: [],
      relatedEntryIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    store.deleteJournalEntry("j-manual-del");
    assert.equal(store.journal.has("j-manual-del"), false);

    const manualDeleteItem: ContextItem = {
      id: "ctx-manual-del",
      project: "p1",
      kind: "state",
      summary: "active",
      provenance: { sourceType: "tool" },
      authority: "instruction",
      confidence: "probable",
      status: "current",
      observedAt: "2026-01-01T00:00:00.000Z",
    };
    store.saveContextItem(manualDeleteItem);
    store.deleteContextItem("ctx-manual-del");
    assert.equal(store.contextItems.has("ctx-manual-del"), false);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the hub store pins the leases table and refuses the v3 file that predates it", () => {
  assert.equal(HUB_STORE_SCHEMA_VERSION, 4);
  assert.deepEqual(
    [...HUB_STORE_TABLES["leases"]!],
    ["resource", "holder_agent_id", "fencing_token", "expires_at", "record"],
  );

  // A v3 file is the shape this build no longer carries: it has every other hub
  // table and no `leases`. There is no migration lane, so it is refused outright
  // rather than reshaped underneath a running hub.
  const directory = mkdtempSync(join(tmpdir(), "kxm-hub-v3-"));
  const path = join(directory, "kxm.db");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE agents (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
      CREATE TABLE messages (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
      CREATE TABLE consumer_cursors (agent_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL) STRICT;
      CREATE TABLE agent_sequences (agent_id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL) STRICT;
      CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, definition_id TEXT NOT NULL, delivery_id TEXT NOT NULL, record TEXT NOT NULL) STRICT;
      CREATE TABLE workflow_journal (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, category TEXT NOT NULL, area TEXT NOT NULL, record TEXT NOT NULL) STRICT;
      CREATE TABLE context_items (id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, record TEXT NOT NULL) STRICT;
      PRAGMA user_version = 3;
    `);
    legacy.close();

    assert.throws(() => new MeshStore(path), /runtime_schema_outdated/);

    const inspection = new DatabaseSync(path);
    try {
      const version = inspection.prepare("PRAGMA user_version").get() as { user_version: number };
      assert.equal(version.user_version, 3, "a refusal must leave the rejected file at its own version");
      const tables = (inspection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((row) => row.name);
      assert.equal(tables.includes("leases"), false, "a refusal must not create the table it refused over");
    } finally {
      inspection.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lease CAS is one writer, and the token increments only on takeover", () => {
  const directory = mkdtempSync(join(tmpdir(), "kxm-hub-leases-"));
  const path = join(directory, "kxm.db");
  const started = Date.parse("2026-01-01T00:00:00.000Z");
  try {
    const store = new MeshStore(path);
    const base = {
      resource: "product/refs/heads/main",
      project: "product",
      name: "refs/heads/main",
      ttlMs: 60_000,
    };

    const first = store.acquireLease({ ...base, holderAgentId: "agt-a", holderAgentName: "a", nowMs: started });
    assert.equal(first.ok, true);
    assert.equal(first.ok && first.lease.fencingToken, 1);
    assert.equal(first.ok && first.renewed, false);

    // A live lease refuses the rival outright and names who holds it.
    const rival = store.acquireLease({ ...base, holderAgentId: "agt-b", holderAgentName: "b", nowMs: started + 1_000 });
    assert.equal(rival.ok, false);
    assert.equal(!rival.ok && rival.reason, "held");
    assert.equal(!rival.ok && rival.lease?.holderAgentId, "agt-a");

    // The holder renewing keeps its token; only the deadline moves.
    const renewed = store.renewLease({
      resource: base.resource,
      holderAgentId: "agt-a",
      fencingToken: 1,
      ttlMs: 60_000,
      nowMs: started + 2_000,
    });
    assert.equal(renewed.ok, true);
    assert.equal(renewed.ok && renewed.lease.fencingToken, 1);
    assert.equal(renewed.ok && renewed.lease.expiresAt, new Date(started + 62_000).toISOString());

    // Past the deadline the rival takes over, and that is the only thing that
    // moves the token.
    const takeover = store.acquireLease({ ...base, holderAgentId: "agt-b", holderAgentName: "b", nowMs: started + 62_001 });
    assert.equal(takeover.ok, true);
    assert.equal(takeover.ok && takeover.lease.fencingToken, 2);
    assert.equal(takeover.ok && takeover.lease.holderAgentId, "agt-b");

    // The old holder's token is now superseded, for renewal and for release.
    const stale = store.renewLease({
      resource: base.resource,
      holderAgentId: "agt-a",
      fencingToken: 1,
      ttlMs: 60_000,
      nowMs: started + 62_002,
    });
    assert.equal(stale.ok, false);
    assert.equal(!stale.ok && stale.reason, "superseded");
    assert.equal(!stale.ok && stale.lease?.fencingToken, 2);

    const staleRelease = store.releaseLease({ resource: base.resource, holderAgentId: "agt-a", fencingToken: 1 });
    assert.equal(staleRelease.ok, false);
    assert.equal(!staleRelease.ok && staleRelease.reason, "superseded");

    // An expired lease is not renewable even by its own holder: re-acquiring is
    // a takeover, and takeovers are the only thing that may resurrect it.
    const lapsed = store.renewLease({
      resource: base.resource,
      holderAgentId: "agt-b",
      fencingToken: 2,
      ttlMs: 60_000,
      nowMs: started + 200_000,
    });
    assert.equal(lapsed.ok, false);
    assert.equal(!lapsed.ok && lapsed.reason, "expired");

    assert.deepEqual(store.listLeases("product").map((lease) => lease.fencingToken), [2]);
    assert.deepEqual(store.listLeases("other-project"), []);

    // Leases survive restart: the token a takeover must beat is durable.
    store.close();
    const reopened = new MeshStore(path);
    assert.equal(reopened.getLease(base.resource)?.fencingToken, 2);

    const released = reopened.releaseLease({ resource: base.resource, holderAgentId: "agt-b", fencingToken: 2 });
    assert.equal(released.ok, true);
    assert.equal(reopened.getLease(base.resource), undefined);
    assert.equal(
      reopened.releaseLease({ resource: base.resource, holderAgentId: "agt-b", fencingToken: 2 }).ok,
      false,
    );
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the retention sweep reaps only leases whose deadline is older than the window", () => {
  const store = new MeshStore(":memory:");
  const started = Date.parse("2026-01-01T00:00:00.000Z");
  store.acquireLease({
    resource: "product/deploy",
    project: "product",
    name: "deploy",
    holderAgentId: "agt-a",
    holderAgentName: "a",
    ttlMs: 60_000,
    nowMs: started,
  });

  // Expired, but still inside the window: the row stays, because its token is
  // what the next takeover has to increment past.
  const justExpired = store.sweepRetention(60_000, 7 * 86_400_000, started + 120_000);
  assert.deepEqual(justExpired.purgedLeases, []);
  assert.equal(store.getLease("product/deploy")?.fencingToken, 1);

  const longExpired = store.sweepRetention(60_000, 7 * 86_400_000, started + 8 * 86_400_000);
  assert.deepEqual(longExpired.purgedLeases.map((lease) => lease.resource), ["product/deploy"]);
  assert.equal(store.getLease("product/deploy"), undefined);
  store.close();
});

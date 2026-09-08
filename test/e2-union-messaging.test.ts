import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { HubClient } from "../plugins/kxm/src/client.ts";
import { createMeshHub } from "../plugins/kxm/src/hub.ts";
import { loadLocalMeshSnapshot } from "../plugins/kxm/src/local-snapshot.ts";
import { buildSessionBrief } from "../plugins/kxm/src/session-work.ts";
import { MeshStore } from "../plugins/kxm/src/store.ts";
import { applyMeshTuiKey, defaultMeshTuiView, renderMeshTui, type MeshTuiSnapshot } from "../plugins/kxm/src/tui.ts";

test("Gate 1: union reader merges legacy and vNext runs, brief reflects source and counts", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-e2-gate1-"));
  const legacyDbPath = join(root, "kxm.db");
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });

  // 1. Setup legacy kxm.db with 2 runs
  const legacyDb = new DatabaseSync(legacyDbPath);
  try {
    legacyDb.exec(`
      CREATE TABLE agents (record TEXT NOT NULL);
      CREATE TABLE messages (record TEXT NOT NULL);
      CREATE TABLE workflow_runs (record TEXT NOT NULL);
    `);
    const insertRun = legacyDb.prepare("INSERT INTO workflow_runs(record) VALUES (?)");
    insertRun.run(JSON.stringify({
      id: "run_legacy_1",
      definitionId: "legacy-flow",
      status: "passed",
      project: "test-proj",
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    }));
    insertRun.run(JSON.stringify({
      id: "run_legacy_2",
      definitionId: "legacy-flow",
      status: "running",
      project: "test-proj",
      createdAt: "2026-09-01T11:00:00.000Z",
      updatedAt: "2026-09-01T11:00:00.000Z",
    }));
  } finally {
    legacyDb.close();
  }

  // 2. Setup vNext registry and project run-events.db
  const vnextRoot = join(root, "vnext");
  const runtimeDir = join(vnextRoot, "runtime");
  const projectsDir = join(runtimeDir, "projects");
  const testProjDir = join(projectsDir, "test-proj");
  mkdirSync(testProjDir, { recursive: true });

  const registryDb = new DatabaseSync(join(runtimeDir, "registry.db"));
  try {
    registryDb.exec("CREATE TABLE projects (project_key TEXT PRIMARY KEY);");
    registryDb.prepare("INSERT INTO projects (project_key) VALUES (?)").run("test-proj");
  } finally {
    registryDb.close();
  }

  const runEventsDb = new DatabaseSync(join(testProjDir, "run-events.db"));
  try {
    runEventsDb.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        project_id TEXT,
        workflow_id TEXT,
        status TEXT,
        created_at TEXT,
        updated_at TEXT
      );
    `);
    runEventsDb.prepare(`
      INSERT INTO runs (run_id, project_id, workflow_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("run_vnext_1", "test-proj", "vnext-flow", "running", "2026-09-01T12:00:00.000Z", "2026-09-01T12:00:00.000Z");
  } finally {
    runEventsDb.close();
  }

  try {
    // Snapshot with both legacy and vNext
    const snapshotBoth = loadLocalMeshSnapshot(legacyDbPath, stateDir, { vnextStateRoot: vnextRoot });
    assert.equal(snapshotBoth.source, "both");
    assert.equal(snapshotBoth.runTotal, 3);
    assert.equal(snapshotBoth.runs.length, 3);
    assert.ok(snapshotBoth.runs.some((r) => r.id === "run_legacy_1"));
    assert.ok(snapshotBoth.runs.some((r) => r.id === "run_vnext_1"));

    // Brief reflects source both and correct total
    const briefBoth = buildSessionBrief(snapshotBoth);
    assert.equal(briefBoth.source, "both");
    assert.equal(briefBoth.stats.runTotal, 3);
    assert.equal(briefBoth.stats.activeTasks, 2); // 1 legacy running + 1 vnext running

    // Snapshot with only vNext (no legacy kxm.db)
    const snapshotVnextOnly = loadLocalMeshSnapshot(join(root, "nonexistent.db"), stateDir, { vnextStateRoot: vnextRoot });
    assert.equal(snapshotVnextOnly.source, "vnext");
    assert.equal(snapshotVnextOnly.runTotal, 1);
    assert.equal(snapshotVnextOnly.runs[0]?.id, "run_vnext_1");

    const briefVnextOnly = buildSessionBrief(snapshotVnextOnly);
    assert.equal(briefVnextOnly.source, "vnext");
    assert.equal(briefVnextOnly.stats.runTotal, 1);

    // Snapshot with only legacy (no vNext root)
    const snapshotLegacyOnly = loadLocalMeshSnapshot(legacyDbPath, stateDir, { vnextStateRoot: join(root, "empty-vnext") });
    assert.equal(snapshotLegacyOnly.source, "legacy");
    assert.equal(snapshotLegacyOnly.runTotal, 2);

    const briefLegacyOnly = buildSessionBrief(snapshotLegacyOnly);
    assert.equal(briefLegacyOnly.source, "legacy");
    assert.equal(briefLegacyOnly.stats.runTotal, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Gate 2: a reconnect after five messages redelivers only unacked ones", async () => {
  const token = "e2-gate2-token";
  const hub = createMeshHub({ port: 0, authToken: token, shutdownGraceMs: 50 });
  const address = await hub.start();

  const makeClient = (name: string) => new HubClient({
    serverUrl: address.url,
    authToken: token,
    name,
    purpose: `${name} role`,
    project: "test-project",
    heartbeatMs: 100,
    reconnectMs: 20,
    requestTimeoutMs: 1_000,
  });

  const sender = makeClient("sender-agent");
  const receiver = makeClient("receiver-agent");
  await sender.start(() => undefined);

  try {
    const receivedFirstBatch: string[] = [];
    await receiver.start(async (event) => {
      if (event.type === "message") {
        receivedFirstBatch.push(event.message.id);
      }
    });

    // Send 5 messages from sender to receiver
    const m1 = await sender.send({ target: "receiver-agent", content: "msg 1" });
    const m2 = await sender.send({ target: "receiver-agent", content: "msg 2" });
    const m3 = await sender.send({ target: "receiver-agent", content: "msg 3" });
    const m4 = await sender.send({ target: "receiver-agent", content: "msg 4" });
    const m5 = await sender.send({ target: "receiver-agent", content: "msg 5" });

    // Wait for receiver to receive all 5 messages
    const startWait = Date.now();
    while (receivedFirstBatch.length < 5 && Date.now() - startWait < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(receivedFirstBatch.length, 5);

    // Receiver acknowledges only the first 2 messages (m1 and m2)
    await receiver.acknowledge(m1.id);
    await receiver.acknowledge(m2.id);

    // Receiver disconnects
    await receiver.stop();

    // Reconnect receiver with a new client instance
    const resumedReceiver = makeClient("receiver-agent");
    const replayedMessages: string[] = [];
    await resumedReceiver.start(async (event) => {
      if (event.type === "message") {
        replayedMessages.push(event.message.id);
      }
    });

    // Wait for redelivery flush on reconnect
    const reconnectWait = Date.now();
    while (replayedMessages.length < 3 && Date.now() - reconnectWait < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // Crucial Gate 2 assertions:
    // Only the unacked ones (m3, m4, m5) are redelivered, NOT m1 or m2!
    assert.deepEqual(replayedMessages.sort(), [m3.id, m4.id, m5.id].sort());
    assert.ok(!replayedMessages.includes(m1.id), "m1 was acked and must not be redelivered");
    assert.ok(!replayedMessages.includes(m2.id), "m2 was acked and must not be redelivered");

    await resumedReceiver.stop();
  } finally {
    await sender.stop();
    await hub.close();
  }
});

test("Gate 3: the hub boots without loading the message table", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-e2-gate3-"));
  const dbPath = join(root, "kxm.db");

  // Populate SQLite database with 10 messages
  const setupStore = new MeshStore(dbPath);
  const messageIds: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const id = `msg_e2_gate3_${i}`;
    messageIds.push(id);
    setupStore.saveMessage({
      id,
      from: "sender",
      fromName: "sender",
      to: "receiver",
      toName: "receiver",
      content: `content ${i}`,
      delivery: "followUp",
      status: "queued",
      hops: 0,
      maxHops: 5,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      project: "test-project",
      idempotencyKey: `idem_gate3_${i}`,
      seq: i,
    });
  }
  setupStore.close();

  // Boot a new MeshStore against the existing database
  const bootStore = new MeshStore(dbPath);
  try {
    // Verified invariant: in-memory cachedSize is 0 at boot!
    assert.equal(bootStore.messages.cachedSize, 0, "message table must not be loaded into memory at boot");

    // But total count is available on-demand via database count
    assert.equal(bootStore.messages.size, 10);

    // Still 0 loaded into memory after count
    assert.equal(bootStore.messages.cachedSize, 0);

    // Query on-demand loads only the requested item
    const fetched = bootStore.messages.get(messageIds[0]!);
    assert.equal(fetched?.id, messageIds[0]!);
    assert.equal(bootStore.messages.cachedSize, 1, "only requested message is loaded into memory cache");

    // Idempotency lookup uses index without loading all rows into cache
    const byIdem = bootStore.findMessageByIdempotency("sender", "idem_gate3_5");
    assert.equal(byIdem?.id, messageIds[4]!);
    assert.equal(bootStore.messages.cachedSize, 2);

    // Now boot a full createMeshHub against this dbPath
    const token = "gate3-token";
    const hub = createMeshHub({ port: 0, authToken: token, dataPath: dbPath });
    try {
      const hubMessages = hub.state.messages as unknown as { cachedSize: number; size: number };
      assert.equal(hubMessages.cachedSize, 0, "hub boot does not load messages table into memory");
      assert.equal(hubMessages.size, 10);
    } finally {
      await hub.close();
    }
  } finally {
    bootStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Spend tab in TUI: renders spend routing records and handles key 7 navigation", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-e2-spend-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });

  // Write sample routing records to telemetry.jsonl
  const telemetryFile = join(stateDir, "telemetry.jsonl");
  const r1 = {
    schema: "kxm.routing-record.v2",
    recordedAt: "2026-09-08T04:00:00.000Z",
    project: "test-proj",
    runId: "run_spend_1",
    stepId: "impl",
    assignmentId: "asg_1",
    attemptId: "att_1",
    harness: "grok",
    provider: "xai",
    requestedModel: "grok-4.6",
    effectiveModel: "grok-4.6",
    behavioralSha256: "sha256_mock",
    tokensIn: 1200,
    tokensOut: 450,
    cacheReadTokens: 100,
    latencyMs: 1500,
    costBasis: "metered",
    costUsd: 0.0425,
    verifierOutcome: "passed",
    finalOutcome: "accepted",
    retries: 0,
  };
  const r2 = {
    schema: "kxm.routing-record.v2",
    recordedAt: "2026-09-08T04:10:00.000Z",
    project: "test-proj",
    runId: "run_spend_2",
    stepId: "review",
    assignmentId: "asg_2",
    attemptId: "att_2",
    harness: "claude",
    provider: "anthropic",
    requestedModel: "fable",
    effectiveModel: "fable",
    behavioralSha256: "sha256_mock_2",
    tokensIn: 800,
    tokensOut: 200,
    cacheReadTokens: 0,
    latencyMs: 850,
    costBasis: "metered",
    costUsd: 0.0150,
    verifierOutcome: "passed",
    finalOutcome: "accepted",
    retries: 0,
  };
  writeFileSync(telemetryFile, `${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n`, "utf8");

  try {
    const snapshot = loadLocalMeshSnapshot(join(root, "missing.db"), stateDir);
    assert.equal(snapshot.spend?.length, 2);

    const tuiSnapshot: MeshTuiSnapshot = {
      ...snapshot,
      serverUrl: "http://127.0.0.1:4000",
      healthOk: true,
      readyOk: true,
      onlineCount: 0,
      transport: "snapshot",
      fetchedAt: "2026-09-08T04:15:00.000Z",
    };

    // Key 7 navigation switches to spend tab
    const initialView = defaultMeshTuiView();
    assert.equal(initialView.tab, "agents");

    const spendView = applyMeshTuiKey(initialView, "7");
    assert.notEqual(spendView, "quit");
    if (spendView !== "quit") {
      assert.equal(spendView.tab, "spend");

      // Render spend panel
      const rendered = renderMeshTui(tuiSnapshot, spendView, 120);
      assert.match(rendered, /Spend/);
      assert.match(rendered, /grok\/grok-4\.6/);
      assert.match(rendered, /claude\/fable/);
      assert.match(rendered, /\$0\.06/); // Formatted with toFixed(2): 0.0425 + 0.015 = 0.0575 -> $0.06
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

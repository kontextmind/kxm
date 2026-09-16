import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runCli, type CliIo } from "../../plugins/kxm/src/cli.ts";
import {
  openDatabase,
  withDatabaseTransaction,
  checkpointWal,
  checkIntegrity,
  createBackup,
  restoreBackup,
  backupDatabaseFile,
  restoreDatabaseFile,
  discoverProjectStores,
  type DatabaseSchemaSpec,
} from "../../plugins/kxm/src/database.ts";
import {
  MeshStore,
  HUB_STORE_SCHEMA_VERSION,
  HUB_STORE_SCHEMA_SPEC,
  type StoredAgent,
} from "../../plugins/kxm/src/store.ts";
import {
  VnextRuntimeRegistry,
  VnextRunEventStore,
  VNEXT_REGISTRY_SCHEMA_VERSION,
  VNEXT_EVENT_STORE_SCHEMA_VERSION,
} from "../../plugins/kxm/src/vnext-runtime-store.ts";
import { Ajv2020 } from "ajv/dist/2020.js";

function setupTestEnv() {
  const dir = mkdtempSync(join(tmpdir(), "kxm-e6-test-"));
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeStoredAgent(id: string, overrides: Partial<StoredAgent> = {}): StoredAgent {
  return {
    id,
    key: "key123",
    name: id,
    purpose: "testing",
    project: "proj_test",
    connectedAt: "2026-09-08T12:00:00.000Z",
    lastSeenAt: "2026-09-08T12:00:00.000Z",
    online: true,
    ...overrides,
  };
}

test("openDatabase initializes schema, enables WAL, and enforces PRAGMAs", () => {
  const env = setupTestEnv();
  try {
    const dbPath = join(env.dir, "test.db");
    const spec: DatabaseSchemaSpec = {
      schema: "CREATE TABLE items (id TEXT PRIMARY KEY, val TEXT) STRICT;",
      version: 1,
      tables: { items: ["id", "val"] },
    };
    const db = openDatabase(dbPath, "test db", spec);
    try {
      const jMode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      assert.equal(jMode.journal_mode, "wal");
      const timeout = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
      assert.equal(timeout.timeout, 5000);
      const sync = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
      assert.equal(sync.synchronous, 1); // 1 = NORMAL
      const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
      assert.equal(version.user_version, 1);
    } finally {
      db.close();
    }
  } finally {
    env.cleanup();
  }
});

test("withDatabaseTransaction enforces nesting guard and handles rollback", () => {
  const env = setupTestEnv();
  try {
    const dbPath = join(env.dir, "test.db");
    const spec: DatabaseSchemaSpec = {
      schema: "CREATE TABLE t (x INTEGER) STRICT;",
      version: 1,
    };
    const db = openDatabase(dbPath, "test db", spec);
    try {
      // 1. Success commit
      withDatabaseTransaction(db, () => {
        db.prepare("INSERT INTO t VALUES (1)").run();
      });
      const rows = db.prepare("SELECT * FROM t").all() as Array<{ x: number }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.x, 1);

      // 2. Nesting guard prevents nested transactions
      assert.throws(
        () => {
          withDatabaseTransaction(db, () => {
            withDatabaseTransaction(db, () => {
              db.prepare("INSERT INTO t VALUES (2)").run();
            });
          });
        },
        /nested transactions are not allowed/,
      );

      // 3. Rollback on failure
      assert.throws(() => {
        withDatabaseTransaction(db, () => {
          db.prepare("INSERT INTO t VALUES (3)").run();
          throw new Error("simulated failure");
        });
      }, /simulated failure/);

      const rowsAfter = db.prepare("SELECT * FROM t").all() as Array<{ x: number }>;
      assert.equal(rowsAfter.length, 1); // 3 was rolled back, 2 was never inserted
    } finally {
      db.close();
    }
  } finally {
    env.cleanup();
  }
});

test("a v2-stamped fixture migrates to v3 with data preserved, never relabelled without migration", () => {
  const env = setupTestEnv();
  try {
    const dbPath = join(env.dir, "kxm-v2.db");
    // Create a authentic v2 database fixture
    const seedDb = new DatabaseSync(dbPath);
    seedDb.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE agents (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
      CREATE TABLE messages (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        record TEXT NOT NULL,
        UNIQUE(definition_id, delivery_id)
      ) STRICT;
      CREATE TABLE workflow_journal (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        category TEXT NOT NULL,
        area TEXT NOT NULL,
        record TEXT NOT NULL
      ) STRICT;
      CREATE INDEX workflow_journal_run_id ON workflow_journal(run_id);
      PRAGMA user_version = 2;
    `);
    // Seed v2 data
    seedDb.prepare("INSERT INTO agents (id, record) VALUES (?, ?)").run(
      "agent_alpha",
      JSON.stringify({ id: "agent_alpha", key: "k1", name: "Alpha", role: "worker" }),
    );
    seedDb.prepare("INSERT INTO messages (id, record) VALUES (?, ?)").run(
      "msg_1",
      JSON.stringify({ id: "msg_1", from: "agent_alpha", to: "agent_beta", content: "hello", seq: 1 }),
    );
    seedDb.close();

    // Verify initial v2 state
    const checkDb = new DatabaseSync(dbPath);
    const initialVersion = (checkDb.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    assert.equal(initialVersion, 2);
    checkDb.close();

    // 1. Opening with a spec that has NO migration lane must refuse and NOT relabel!
    const noMigrationSpec: DatabaseSchemaSpec = {
      schema: "CREATE TABLE dummy (id TEXT);",
      version: 3,
    };
    assert.throws(
      () => openDatabase(dbPath, "test db", noMigrationSpec),
      /schema version 2 is older than 3/,
    );
    // Verify it was NEVER relabelled
    const checkUnmodified = new DatabaseSync(dbPath);
    const versionStillTwo = (checkUnmodified.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    assert.equal(versionStillTwo, 2, "user_version must remain 2 after refusal, never relabelled");
    checkUnmodified.close();

    // 2. Opening with MeshStore stepwise-migrates from v2 to v3!
    const store = new MeshStore(dbPath);
    try {
      assert.equal(store.persistent, true);
      // Existing v2 data is intact
      const agent = store.agents.get("agent_alpha");
      assert.ok(agent);
      assert.equal(agent.name, "Alpha");
      const msg = store.messages.get("msg_1");
      assert.ok(msg);
      assert.equal(msg.content, "hello");

      // New v3 tables exist and can be written to
      store.saveContextItem({
        id: "ctx_1",
        project: "test_proj",
        kind: "knowledge",
        observedAt: "2026-09-08T12:00:00.000Z",
        summary: "Context item after migration",
        provenance: { sourceType: "tool", sourceRef: "ref_1" },
        authority: "instruction",
        confidence: "verified",
        status: "current",
      });
      const ctx = store.getContextItem("ctx_1", "test_proj");
      assert.ok(ctx);
      assert.equal(ctx.summary, "Context item after migration");
    } finally {
      store.close();
    }

    // 3. Verify user_version is now stamped to 3
    const finalDb = new DatabaseSync(dbPath);
    const finalVersion = (finalDb.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    assert.equal(finalVersion, 3);
    finalDb.close();
  } finally {
    env.cleanup();
  }
});

test("openDatabase and restore refuse newer unknown schema versions", () => {
  const env = setupTestEnv();
  try {
    const dbPath = join(env.dir, "newer.db");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 99;");
    db.close();

    // openDatabase refuses newer
    assert.throws(
      () => openDatabase(dbPath, "test db", { schema: "", version: 3 }),
      /schema version 99 is newer than this runtime supports/,
    );

    // restoreDatabaseFile refuses newer
    assert.throws(
      () => restoreDatabaseFile(dbPath, join(env.dir, "restored.db"), "test-store", undefined, 3),
      /schema version 99 is newer than supported maximum 3/,
    );
  } finally {
    env.cleanup();
  }
});

test("kxm backup and restore round-trip preserves all stores and data with manifest verification", () => {
  const env = setupTestEnv();
  try {
    const projectRoot = env.dir;
    const stateDir = join(projectRoot, ".kxm", "state");
    const runtimeDir = join(projectRoot, ".kxm", "runtime");
    const eventsDir = join(runtimeDir, "events");
    const backupDir = join(projectRoot, ".kxm", "backups", "test-backup");

    // 1. Seed hub store
    const hubStorePath = join(stateDir, "kxm.db");
    const hubStore = new MeshStore(hubStorePath);
    hubStore.saveAgent(makeStoredAgent("agt_test", { name: "Test Agent" }));
    hubStore.saveMessage({
      id: "msg_test",
      project: "proj_test",
      from: "agt_test",
      fromName: "Test Agent",
      to: "agt_peer",
      toName: "Peer",
      content: "Backup test content",
      delivery: "followUp",
      hops: 0,
      maxHops: 5,
      status: "queued",
      createdAt: "2026-09-08T12:00:00.000Z",
      expiresAt: "2026-09-09T12:00:00.000Z",
    });
    hubStore.saveContextItem({
      id: "ctx_test",
      project: "proj_test",
      kind: "evidence",
      observedAt: "2026-09-08T12:00:00.000Z",
      summary: "Backup test fact",
      provenance: { sourceType: "tool", sourceRef: "ref" },
      authority: "evidence",
      confidence: "verified",
      status: "current",
    });
    hubStore.close();

    // 2. Seed runtime registry
    const registryPath = join(runtimeDir, "registry.db");
    const registry = new VnextRuntimeRegistry(registryPath);
    registry.claimSupervisor({
      runtimeId: "rt_test_1",
      pid: process.pid,
      port: 4567,
      tokenHash: "hash123",
      now: "2026-09-08T12:00:00.000Z",
    });
    registry.registerProject({
      projectId: "prj_001",
      projectRoot,
      homeRuntimeId: "rt_test_1",
      now: "2026-09-08T12:00:00.000Z",
    });
    registry.close();

    // 3. Seed event store
    const eventStorePath = join(eventsDir, "key_001.db");
    const eventStore = new VnextRunEventStore(eventStorePath);
    eventStore.transaction(() => {
      eventStore.insertRun({
        runId: "run_test_01",
        projectId: "prj_001",
        homeRuntimeId: "rt_test_1",
        workflowId: "wf_test",
        promptSha256: "abc",
        status: "created",
        configRevision: "rev1",
        memoryRevision: "ctxrev_001",
        executorPolicyRevision: "exec1",
        toolPolicyRevision: "tool1",
        createdAt: "2026-09-08T12:00:00.000Z",
        updatedAt: "2026-09-08T12:00:00.000Z",
      });
    });
    eventStore.close();

    // 4. Run createBackup
    const { manifest, outDir } = createBackup({
      projectRoot,
      outDir: backupDir,
    });

    assert.equal(outDir, backupDir);
    assert.equal(manifest.schema, "kxm.backup-manifest.v1");
    assert.equal(manifest.stores.length, 3);
    assert.ok(manifest.stores.some((s) => s.storeId === "hub-store" && s.schemaVersion === 3));
    assert.ok(manifest.stores.some((s) => s.storeId === "registry" && s.schemaVersion === 1));
    assert.ok(manifest.stores.some((s) => s.storeId === "events:key_001" && s.schemaVersion === VNEXT_EVENT_STORE_SCHEMA_VERSION));

    // Validate manifest against schema
    const schemaFile = JSON.parse(readFileSync("schemas/vnext/backup-manifest.schema.json", "utf8"));
    const commonSchema = JSON.parse(readFileSync("schemas/vnext/common.schema.json", "utf8"));
    const ajv = new Ajv2020({ allErrors: true });
    ajv.addSchema(commonSchema);
    const validate = ajv.compile(schemaFile);
    assert.equal(validate(manifest), true, JSON.stringify(validate.errors));

    // 5. Delete or corrupt original databases
    rmSync(hubStorePath, { force: true });
    rmSync(registryPath, { force: true });
    rmSync(eventStorePath, { force: true });

    assert.equal(existsSync(hubStorePath), false);
    assert.equal(existsSync(registryPath), false);
    assert.equal(existsSync(eventStorePath), false);

    // 6. Run restoreBackup
    const restoreResult = restoreBackup(backupDir, { projectRoot });
    assert.equal(restoreResult.restoredStores.length, 3);

    // 7. Verify all stores and data were restored completely!
    assert.equal(existsSync(hubStorePath), true);
    assert.equal(existsSync(registryPath), true);
    assert.equal(existsSync(eventStorePath), true);

    // Verify hub store
    const restoredHub = new MeshStore(hubStorePath);
    assert.equal(restoredHub.agents.get("agt_test")?.name, "Test Agent");
    assert.equal(restoredHub.messages.get("msg_test")?.content, "Backup test content");
    assert.equal(restoredHub.getContextItem("ctx_test", "proj_test")?.summary, "Backup test fact");
    restoredHub.close();

    // Verify registry
    const restoredReg = new VnextRuntimeRegistry(registryPath);
    assert.equal(restoredReg.supervisor()?.runtimeId, "rt_test_1");
    assert.equal(restoredReg.project("prj_001")?.projectId, "prj_001");
    restoredReg.close();

    // Verify event store
    const restoredEvents = new VnextRunEventStore(eventStorePath);
    const run = restoredEvents.run("run_test_01");
    assert.ok(run);
    assert.equal(run.projectId, "prj_001");
    assert.equal(run.status, "created");
    restoredEvents.close();
  } finally {
    env.cleanup();
  }
});

test("restoreBackup refuses tampered backup file when sha256 digest mismatches", () => {
  const env = setupTestEnv();
  try {
    const projectRoot = env.dir;
    const stateDir = join(projectRoot, ".kxm", "state");
    const backupDir = join(projectRoot, ".kxm", "backups", "tampered-backup");

    const hubStorePath = join(stateDir, "kxm.db");
    const hubStore = new MeshStore(hubStorePath);
    hubStore.saveAgent(makeStoredAgent("a1", { name: "A" }));
    hubStore.close();

    createBackup({ projectRoot, outDir: backupDir });

    // Tamper with backed-up database
    const backupDbFile = join(backupDir, "kxm.db");
    writeFileSync(backupDbFile, "corrupted content", "utf8");

    // Attempting restore must fail closed on digest mismatch
    assert.throws(
      () => restoreBackup(backupDir, { projectRoot }),
      /restore_manifest_digest_mismatch/,
    );
  } finally {
    env.cleanup();
  }
});

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
    read: () => ({ stdout, stderr }),
  };
}

test("kxm backup and kxm restore CLI commands succeed end-to-end and handle errors", async () => {
  const env = setupTestEnv();
  try {
    const projectRoot = env.dir;
    const stateDir = join(projectRoot, ".kxm", "state");
    const hubStorePath = join(stateDir, "kxm.db");
    const hubStore = new MeshStore(hubStorePath);
    hubStore.saveAgent(makeStoredAgent("cli_agt", { name: "CLI Agent" }));
    hubStore.close();

    // 1. Run in-process runCli(["backup", "--json"])
    const backupJsonIo = capture();
    const backupCode = await runCli(["backup", "--json"], {}, backupJsonIo, projectRoot);
    assert.equal(backupCode, 0, backupJsonIo.read().stderr);
    const backupJson = JSON.parse(backupJsonIo.read().stdout);
    assert.equal(backupJson.ok, true);
    assert.equal(backupJson.command, "backup");
    assert.ok(backupJson.outDir);
    assert.equal(backupJson.manifest.stores.length, 1);

    // 2. Run text-mode backup with --out
    const customBackupDir = join(projectRoot, "custom-backup");
    const backupTextIo = capture();
    const backupTextCode = await runCli(["backup", "--out", customBackupDir], {}, backupTextIo, projectRoot);
    assert.equal(backupTextCode, 0, backupTextIo.read().stderr);
    assert.match(backupTextIo.read().stdout, /Created SQLite backup with 1 store\(s\):/);

    // Wipe store
    rmSync(hubStorePath, { force: true });
    assert.equal(existsSync(hubStorePath), false);

    // 3. Run in-process runCli(["restore", backupJson.outDir, "--json"])
    const restoreJsonIo = capture();
    const restoreCode = await runCli(["restore", backupJson.outDir, "--json"], {}, restoreJsonIo, projectRoot);
    assert.equal(restoreCode, 0, restoreJsonIo.read().stderr);
    const restoreJson = JSON.parse(restoreJsonIo.read().stdout);
    assert.equal(restoreJson.ok, true);
    assert.equal(restoreJson.command, "restore");
    assert.equal(restoreJson.restoredStores.length, 1);

    // Verify restored data
    const verifiedStore = new MeshStore(hubStorePath);
    assert.equal(verifiedStore.agents.get("cli_agt")?.name, "CLI Agent");
    verifiedStore.close();

    // 4. Run text-mode restore
    const restoreTextIo = capture();
    const restoreTextCode = await runCli(["restore", join(customBackupDir, "manifest.json")], {}, restoreTextIo, projectRoot);
    assert.equal(restoreTextCode, 0, restoreTextIo.read().stderr);
    assert.match(restoreTextIo.read().stdout, /Restored 1 SQLite store\(s\) from/);

    // 5. Error case: backup with no stores fails with exit code 1
    const emptyDir = mkdtempSync(join(tmpdir(), "kxm-e6-empty-"));
    try {
      const errBackupIo = capture();
      const errCode = await runCli(["backup"], {}, errBackupIo, emptyDir);
      assert.equal(errCode, 1);
      assert.match(errBackupIo.read().stderr, /backup failed/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }

    // 6. Error case: restore non-existent manifest fails with exit code 1
    const errRestoreIo = capture();
    const errRestoreCode = await runCli(["restore", "nonexistent-manifest.json"], {}, errRestoreIo, projectRoot);
    assert.equal(errRestoreCode, 1);
    assert.match(errRestoreIo.read().stderr, /restore failed/);
  } finally {
    env.cleanup();
  }
});

test("openDatabase and restoreDatabaseFile fail closed on invalid shapes, newer schemas, and mismatches", () => {
  const env = setupTestEnv();
  try {
    const dir = env.dir;

    // 1. Database path is a directory
    const dirAsDb = join(dir, "is_a_dir");
    mkdirSync(dirAsDb);
    assert.throws(
      () => openDatabase(dirAsDb, "dir db", { schema: "", version: 1 }),
      /must be a regular file, not a link or directory/,
    );

    // 2. Schema version newer than runtime supports
    const newerDbPath = join(dir, "newer.db");
    const newerDb = new DatabaseSync(newerDbPath);
    newerDb.exec("PRAGMA user_version = 99;");
    newerDb.close();
    assert.throws(
      () => openDatabase(newerDbPath, "newer db", { schema: "", version: 1 }),
      /schema version 99 is newer than this runtime supports/,
    );

    // 3. Schema version 0 but has tables
    const shapeDbPath = join(dir, "v0_with_tables.db");
    const shapeDb = new DatabaseSync(shapeDbPath);
    shapeDb.exec("CREATE TABLE extra (x INT);");
    shapeDb.close();
    assert.throws(
      () => openDatabase(shapeDbPath, "v0 db", { schema: "", version: 1 }),
      /has tables at schema version 0/,
    );

    // 4. Outdated version without migration step
    const outdatedDbPath = join(dir, "outdated.db");
    const outDb = new DatabaseSync(outdatedDbPath);
    outDb.exec("PRAGMA user_version = 1;");
    outDb.close();
    assert.throws(
      () => openDatabase(outdatedDbPath, "outdated db", { schema: "", version: 3, migrations: [] }),
      /schema version 1 is older than 3; no migration lane/,
    );

    // 5. Missing columns in expected tables
    const missingColDbPath = join(dir, "missing_col.db");
    assert.throws(
      () => openDatabase(missingColDbPath, "missing col db", {
        schema: "CREATE TABLE t (a TEXT);",
        version: 1,
        tables: { t: ["a", "b"] },
      }),
      /table t is missing columns b/,
    );

    // 6. restoreDatabaseFile schema newer than maxSupported
    const maxDbPath = join(dir, "max_ver.db");
    const maxDb = new DatabaseSync(maxDbPath);
    maxDb.exec("PRAGMA user_version = 5;");
    maxDb.close();
    const destDbPath = join(dir, "dest.db");
    assert.throws(
      () => restoreDatabaseFile(maxDbPath, destDbPath, "test_store", undefined, 3),
      /schema version 5 is newer than supported maximum 3/,
    );

    // 7. restoreDatabaseFile schema mismatch with manifest
    assert.throws(
      () => restoreDatabaseFile(maxDbPath, destDbPath, "test_store", 2, 10),
      /schema version 5 does not match manifest version 2/,
    );

    // 8. restoreBackup invalid manifest JSON
    const invalidManifestFile = join(dir, "invalid-manifest.json");
    writeFileSync(invalidManifestFile, "NOT JSON", "utf8");
    assert.throws(
      () => restoreBackup(invalidManifestFile),
      /failed to parse backup manifest/,
    );

    // 9. restoreBackup schema document invalid
    writeFileSync(invalidManifestFile, JSON.stringify({ schema: "wrong" }), "utf8");
    assert.throws(
      () => restoreBackup(invalidManifestFile),
      /manifest is not a valid kxm\.backup-manifest\.v1 document/,
    );

    // 10. restoreBackup missing backup file
    writeFileSync(
      invalidManifestFile,
      JSON.stringify({
        schema: "kxm.backup-manifest.v1",
        backupId: "bk_1",
        createdAt: new Date().toISOString(),
        stores: [{ storeId: "s1", sourcePath: "/tmp/s1.db", backupFile: "missing.db", schemaVersion: 1, sha256: "abc", bytes: 10, integrity: "ok" }],
      }),
      "utf8",
    );
    assert.throws(
      () => restoreBackup(invalidManifestFile),
      /backup file missing\.db missing/,
    );
  } finally {
    env.cleanup();
  }
});


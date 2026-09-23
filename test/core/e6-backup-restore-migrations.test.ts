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
  planRestore,
  restoreBackup,
  backupDatabaseFile,
  restoreDatabaseFile,
  discoverProjectStores,
  kxmBackupCeiling,
  KXM_BACKUP_CEILINGS,
  type DatabaseSchemaSpec,
} from "../../plugins/kxm/src/database.ts";
import {
  MeshStore,
  HUB_STORE_SCHEMA_VERSION,
  HUB_STORE_SCHEMA_SPEC,
  type StoredAgent,
} from "../../plugins/kxm/src/store.ts";
import {
  KxmRuntimeRegistry,
  KxmRunEventStore,
  KXM_REGISTRY_SCHEMA_VERSION,
  KXM_EVENT_STORE_SCHEMA_VERSION,
  kxmProjectRunEventsPath,
  kxmRuntimePaths,
  projectRuntimeKey,
} from "../../plugins/kxm/src/runtime-store.ts";
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

test("an older stamped database is refused rather than upgraded in place", () => {
  // Single-operator tool: no migration lanes and no dual-shape queries. An older file is
  // re-initialised, and the error says so instead of quietly stamping it forward — a
  // version bump without the schema underneath would fail later in some query that
  // assumes columns that are not there.
  const dir = mkdtempSync(join(tmpdir(), "kxm-e6-outdated-"));
  try {
    const dbPath = join(dir, "legacy.db");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec("PRAGMA user_version = 2;");
    legacy.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;");
    legacy.close();

    assert.throws(
      () => openDatabase(dbPath, "legacy db", { schema: "CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;", version: 3 }),
      /is schema version 2; this build requires 3/,
    );
    // Refusal must not mutate the file: no silent relabelling.
    const after = new DatabaseSync(dbPath);
    try {
      assert.equal(Number((after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), 2);
    } finally {
      after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    const registry = new KxmRuntimeRegistry(registryPath);
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
    const eventStore = new KxmRunEventStore(eventStorePath);
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
      env: { KXM_STATE_HOME: join(projectRoot, "empty-user-state") },
    });

    assert.equal(outDir, backupDir);
    assert.equal(manifest.schema, "kxm.backup-manifest.v1");
    assert.equal(manifest.stores.length, 3);
    assert.equal(manifest.complete, true);
    assert.ok(manifest.stores.some((s) => s.storeId === "hub-store" && s.schemaVersion === HUB_STORE_SCHEMA_VERSION));
    assert.ok(manifest.stores.some((s) => s.storeId === "registry" && s.schemaVersion === 1));
    assert.ok(manifest.stores.some((s) => s.storeId === "events:key_001" && s.schemaVersion === KXM_EVENT_STORE_SCHEMA_VERSION));

    // Validate manifest against schema
    const schemaFile = JSON.parse(readFileSync("schemas/backup-manifest.schema.json", "utf8"));
    const commonSchema = JSON.parse(readFileSync("schemas/common.schema.json", "utf8"));
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
    const restoredReg = new KxmRuntimeRegistry(registryPath);
    assert.equal(restoredReg.supervisor()?.runtimeId, "rt_test_1");
    assert.equal(restoredReg.project("prj_001")?.projectId, "prj_001");
    restoredReg.close();

    // Verify event store
    const restoredEvents = new KxmRunEventStore(eventStorePath);
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

    createBackup({ projectRoot, outDir: backupDir, env: { KXM_STATE_HOME: join(projectRoot, "empty-user-state") } });

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
    const isolated = { KXM_STATE_HOME: join(projectRoot, "empty-user-state") };
    const backupCode = await runCli(["backup", "--json"], isolated, backupJsonIo, projectRoot);
    assert.equal(backupCode, 0, backupJsonIo.read().stderr);
    const backupJson = JSON.parse(backupJsonIo.read().stdout);
    assert.equal(backupJson.ok, true);
    assert.equal(backupJson.command, "backup");
    assert.ok(backupJson.outDir);
    assert.equal(backupJson.manifest.stores.length, 1);

    // 2. Run text-mode backup with --out
    const customBackupDir = join(projectRoot, "custom-backup");
    const backupTextIo = capture();
    const backupTextCode = await runCli(["backup", "--out", customBackupDir], isolated, backupTextIo, projectRoot);
    assert.equal(backupTextCode, 0, backupTextIo.read().stderr);
    assert.match(backupTextIo.read().stdout, /Created SQLite backup with 1 store\(s\) \(project scope\):/);

    // Wipe store
    rmSync(hubStorePath, { force: true });
    assert.equal(existsSync(hubStorePath), false);

    // 3. Run in-process runCli(["restore", backupJson.outDir, "--json"])
    const restoreJsonIo = capture();
    const restoreCode = await runCli(["restore", backupJson.outDir, "--json"], isolated, restoreJsonIo, projectRoot);
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
    const restoreTextCode = await runCli(["restore", join(customBackupDir, "manifest.json")], isolated, restoreTextIo, projectRoot);
    assert.equal(restoreTextCode, 0, restoreTextIo.read().stderr);
    assert.match(restoreTextIo.read().stdout, /Restored 1 SQLite store\(s\) from/);

    // 5. Error case: backup with no stores fails with exit code 1
    const emptyDir = mkdtempSync(join(tmpdir(), "kxm-e6-empty-"));
    try {
      const errBackupIo = capture();
      const errCode = await runCli(["backup"], { KXM_STATE_HOME: emptyDir }, errBackupIo, emptyDir);
      assert.equal(errCode, 1);
      assert.match(errBackupIo.read().stderr, /backup failed/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }

    // 6. Error case: restore non-existent manifest fails with exit code 1
    const errRestoreIo = capture();
    const errRestoreCode = await runCli(["restore", "nonexistent-manifest.json"], isolated, errRestoreIo, projectRoot);
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
      () => openDatabase(outdatedDbPath, "outdated db", { schema: "", version: 3 }),
      /is schema version 1; this build requires 3/,
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


test("restore ceilings track every store's own schema version", () => {
  // A ceiling left behind when a store's schema is bumped refuses that store's
  // own fresh backup — the failure is silent until an operator reaches for a
  // restore. Both backup discovery and restore read this one table, so pinning
  // it here pins both paths; the old arrangement kept two copies and one drifted.
  assert.equal(KXM_BACKUP_CEILINGS["hub-store"], HUB_STORE_SCHEMA_VERSION);
  assert.equal(KXM_BACKUP_CEILINGS.registry, KXM_REGISTRY_SCHEMA_VERSION);
  assert.equal(KXM_BACKUP_CEILINGS.events, KXM_EVENT_STORE_SCHEMA_VERSION);

  // Per-project event stores are named `events:<key>`, and each one carries the
  // outbox — including rows a hub refused. They share the one events ceiling.
    assert.equal(kxmBackupCeiling("events:6d41c43d522ab74d11f95432"), KXM_EVENT_STORE_SCHEMA_VERSION);
    assert.equal(kxmBackupCeiling("runtime-registry"), KXM_REGISTRY_SCHEMA_VERSION);
  assert.equal(kxmBackupCeiling("binding-store"), 1);
  // An id this build does not know keeps the ceiling restore has always defaulted to.
  assert.equal(kxmBackupCeiling("something-new"), KXM_BACKUP_CEILINGS["hub-store"]);

  // Discovery must hand out the same numbers restore will enforce, or the
  // manifest and the restore disagree about the same file.
  const env = setupTestEnv();
  try {
    const projectRoot = env.dir;
    const eventsDir = join(projectRoot, ".kxm", "runtime", "events");
    mkdirSync(join(projectRoot, ".kxm", "state"), { recursive: true });
    mkdirSync(eventsDir, { recursive: true });
    new MeshStore(join(projectRoot, ".kxm", "state", "kxm.db")).close();
    new KxmRuntimeRegistry(join(projectRoot, ".kxm", "runtime", "registry.db")).close();
    new KxmRunEventStore(join(eventsDir, "key_001.db")).close();
    const discovered = discoverProjectStores(projectRoot, { env: { KXM_STATE_HOME: join(projectRoot, "empty-user-state") } });
    assert.equal(discovered.find((store) => store.storeId === "hub-store")?.maxSupportedVersion, HUB_STORE_SCHEMA_VERSION);
    assert.equal(discovered.find((store) => store.storeId === "registry")?.maxSupportedVersion, KXM_REGISTRY_SCHEMA_VERSION);
    for (const store of discovered.filter((candidate) => candidate.storeId.startsWith("events:"))) {
      assert.equal(store.maxSupportedVersion, KXM_EVENT_STORE_SCHEMA_VERSION, `${store.storeId} ceiling`);
    }
    assert.ok(discovered.length > 0, "the fixture exposes at least one store");
  } finally {
    env.cleanup();
  }
});

test("an all-projects backup discovers user-state runtime stores and refuses a partial manifest", () => {
  const env = setupTestEnv();
  const stateHome = join(env.dir, "user-state");
  try {
    const projectRoot = env.dir;
    mkdirSync(join(projectRoot, ".kxm", "state"), { recursive: true });
    new MeshStore(join(projectRoot, ".kxm", "state", "kxm.db")).close();
    const registryPath = join(stateHome, "runtime", "registry.db");
    mkdirSync(join(stateHome, "runtime"), { recursive: true });
    new KxmRuntimeRegistry(registryPath).close();
    const eventPath = join(stateHome, "runtime", "projects", "projkey", "run-events.db");
    mkdirSync(join(stateHome, "runtime", "projects", "projkey"), { recursive: true });
    new KxmRunEventStore(eventPath).close();
    writeFileSync(`${eventPath}.run-prompts.json`, "{\"prompts\":[]}\n");
    const { manifest } = createBackup({
      projectRoot,
      outDir: join(projectRoot, "backup-user"),
      env: { KXM_STATE_HOME: stateHome },
      allProjects: true,
    });
    assert.equal(manifest.complete, true);
    assert.equal(manifest.scope, "all-projects");
    assert.ok(manifest.stores.some((store) => store.storeId === "registry" && store.sourcePath === registryPath));
    assert.ok(manifest.stores.some((store) => store.storeId === "events:projkey"));
    assert.ok(manifest.files?.some((file) => file.id === "events:projkey:run-prompts"));

    const junkHome = join(env.dir, "junk-state");
    mkdirSync(join(junkHome, "runtime"), { recursive: true });
    writeFileSync(join(junkHome, "runtime", "registry.db"), "not a database");
    const partial = createBackup({
      projectRoot,
      outDir: join(projectRoot, "backup-partial"),
      env: { KXM_STATE_HOME: junkHome },
      allProjects: true,
    });
    assert.equal(partial.manifest.complete, false);
    assert.ok(partial.manifest.omitted?.includes("registry"));
    assert.throws(() => restoreBackup(partial.outDir, { projectRoot }), /restore_incomplete/);
  } finally {
    env.cleanup();
  }
});

const SEEDED_AT = "2026-09-23T12:00:00.000Z";

function seedRun(path: string, runId: string, projectId: string): void {
  const store = new KxmRunEventStore(path);
  try {
    store.transaction(() => {
      store.insertRun({
        runId,
        projectId,
        homeRuntimeId: "rt_scope",
        workflowId: "wf_test",
        promptSha256: "abc",
        status: "created",
        configRevision: "rev1",
        memoryRevision: "ctxrev_001",
        executorPolicyRevision: "exec1",
        toolPolicyRevision: "tool1",
        createdAt: SEEDED_AT,
        updatedAt: SEEDED_AT,
      });
    });
  } finally {
    store.close();
  }
}

function hasRun(path: string, runId: string): boolean {
  const store = new KxmRunEventStore(path);
  try {
    return store.run(runId) !== undefined;
  } finally {
    store.close();
  }
}

/** Two checkouts sharing one user state root, each with a Runtime event store and
 * prompt sidecar, both registered in the shared registry. Project A has a hub store. */
function seedTwoProjects(dir: string) {
  const env = { KXM_STATE_HOME: join(dir, "state") };
  const projectA = join(dir, "project-a");
  const projectB = join(dir, "project-b");
  mkdirSync(join(projectA, ".kxm", "state"), { recursive: true });
  mkdirSync(projectB, { recursive: true });
  const hub = new MeshStore(join(projectA, ".kxm", "state", "kxm.db"));
  hub.saveAgent(makeStoredAgent("agt_a", { name: "A" }));
  hub.close();
  const registryDb = kxmRuntimePaths({ env }).registryDb;
  const registry = new KxmRuntimeRegistry(registryDb);
  registry.registerProject({ projectId: "prj_a", projectRoot: projectA, homeRuntimeId: "rt_scope", now: SEEDED_AT });
  registry.registerProject({ projectId: "prj_b", projectRoot: projectB, homeRuntimeId: "rt_scope", now: SEEDED_AT });
  registry.close();
  const eventsA = kxmProjectRunEventsPath(projectA, env);
  const eventsB = kxmProjectRunEventsPath(projectB, env);
  seedRun(eventsA, "run_a_before", "prj_a");
  seedRun(eventsB, "run_b_before", "prj_b");
  writeFileSync(`${eventsA}.run-prompts.json`, "{\"a\":\"before\"}\n");
  writeFileSync(`${eventsB}.run-prompts.json`, "{\"b\":\"before\"}\n");
  return { env, projectA, projectB, eventsA, eventsB, registryDb, hubStorePath: join(projectA, ".kxm", "state", "kxm.db") };
}

test("a project backup holds only its own Runtime event store, and its restore leaves other projects alone", () => {
  const env = setupTestEnv();
  try {
    const { env: stateEnv, projectA, eventsA, eventsB, registryDb, hubStorePath } = seedTwoProjects(env.dir);
    const outDir = join(env.dir, "backup-a");
    const { manifest } = createBackup({ projectRoot: projectA, outDir, env: stateEnv });

    assert.equal(manifest.complete, true);
    assert.equal(manifest.scope, "project");
    assert.equal(manifest.runtimeProjectKey, projectRuntimeKey(projectA));
    assert.deepEqual(manifest.stores.map((store) => store.storeId).sort(), [`events:${projectRuntimeKey(projectA)}`, "hub-store"]);
    assert.deepEqual(manifest.files?.map((file) => file.sourcePath), [`${eventsA}.run-prompts.json`]);
    const copied = [...manifest.stores.map((store) => store.sourcePath), ...(manifest.files ?? []).map((file) => file.sourcePath)];
    assert.equal(copied.includes(registryDb), false, "the shared registry is not in a project backup");
    assert.equal(copied.some((path) => path.startsWith(eventsB)), false, "another project's event store is not in a project backup");

    const schemaFile = JSON.parse(readFileSync("schemas/backup-manifest.schema.json", "utf8"));
    const ajv = new Ajv2020({ allErrors: true });
    ajv.addSchema(JSON.parse(readFileSync("schemas/common.schema.json", "utf8")));
    const validate = ajv.compile(schemaFile);
    assert.equal(validate(manifest), true, JSON.stringify(validate.errors));

    // Every project moves on after the backup, and a third registers.
    seedRun(eventsA, "run_a_after", "prj_a");
    seedRun(eventsB, "run_b_after", "prj_b");
    writeFileSync(`${eventsB}.run-prompts.json`, "{\"b\":\"after\"}\n");
    const registry = new KxmRuntimeRegistry(registryDb);
    registry.registerProject({ projectId: "prj_c", projectRoot: join(env.dir, "project-c"), homeRuntimeId: "rt_scope", now: SEEDED_AT });
    registry.close();

    const result = restoreBackup(outDir, { projectRoot: projectA, env: stateEnv });
    assert.deepEqual(result.restoredStores.map((store) => store.sourcePath).sort(), [eventsA, hubStorePath].sort());
    assert.equal(hasRun(eventsA, "run_a_before"), true);
    assert.equal(hasRun(eventsA, "run_a_after"), false, "project A rolled back");
    assert.equal(readFileSync(`${eventsA}.run-prompts.json`, "utf8"), "{\"a\":\"before\"}\n");
    assert.equal(hasRun(eventsB, "run_b_after"), true, "project B kept its later run");
    assert.equal(readFileSync(`${eventsB}.run-prompts.json`, "utf8"), "{\"b\":\"after\"}\n");
    const after = new KxmRuntimeRegistry(registryDb);
    assert.equal(after.project("prj_c")?.projectId, "prj_c", "the registry was not rolled back");
    after.close();

    // The event store goes where the Runtime looks for this checkout, so a moved user
    // state root receives it rather than the path the backup recorded.
    const movedEnv = { KXM_STATE_HOME: join(env.dir, "state-moved") };
    restoreBackup(outDir, { projectRoot: projectA, env: movedEnv });
    const movedEvents = kxmProjectRunEventsPath(projectA, movedEnv);
    assert.equal(hasRun(movedEvents, "run_a_before"), true);
    assert.equal(readFileSync(`${movedEvents}.run-prompts.json`, "utf8"), "{\"a\":\"before\"}\n");
  } finally {
    env.cleanup();
  }
});

test("an --all-projects backup holds every project and the registry, and only --all-projects restores it", async () => {
  const env = setupTestEnv();
  try {
    const { env: stateEnv, projectA, eventsA, eventsB, registryDb } = seedTwoProjects(env.dir);
    const outDir = join(env.dir, "backup-all");
    const backupIo = capture();
    assert.equal(await runCli(["backup", "--all-projects", "--out", outDir, "--json"], stateEnv, backupIo, projectA), 0, backupIo.read().stderr);
    const { manifest } = JSON.parse(backupIo.read().stdout) as { manifest: { scope: string; stores: Array<{ storeId: string; sourcePath: string }>; files: Array<{ sourcePath: string }> } };
    assert.equal(manifest.scope, "all-projects");
    assert.ok(manifest.stores.some((store) => store.storeId === "registry" && store.sourcePath === registryDb));
    assert.ok(manifest.stores.some((store) => store.sourcePath === eventsA));
    assert.ok(manifest.stores.some((store) => store.sourcePath === eventsB));
    assert.equal(manifest.files.length, 2);

    seedRun(eventsB, "run_b_after", "prj_b");

    const refusedIo = capture();
    assert.equal(await runCli(["restore", outDir, "--json"], stateEnv, refusedIo, projectA), 1);
    const refused = JSON.parse(refusedIo.read().stderr) as { error: string; issues: Array<{ code: string }> };
    assert.equal(refused.error, "restore_failed");
    assert.equal(refused.issues[0]?.code, "restore_requires_all_projects");
    assert.equal(hasRun(eventsB, "run_b_after"), true, "a refused restore writes nothing");

    // A manifest written before scopes records the same stores as bare absolute paths;
    // they are still machine-wide and still need the flag.
    const manifestPath = join(outDir, "manifest.json");
    const legacy = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    delete legacy.scope;
    delete legacy.stateRoot;
    delete legacy.runtimeProjectKey;
    writeFileSync(manifestPath, JSON.stringify(legacy, null, 2));
    assert.throws(() => planRestore(outDir, { projectRoot: projectA, env: stateEnv }), /restore_requires_all_projects/);

    const restoreIo = capture();
    assert.equal(await runCli(["restore", outDir, "--all-projects", "--json"], stateEnv, restoreIo, projectA), 0, restoreIo.read().stderr);
    assert.equal(hasRun(eventsB, "run_b_after"), false, "--all-projects rolls every project back");
    assert.equal(hasRun(eventsB, "run_b_before"), true);
  } finally {
    env.cleanup();
  }
});

test("kxm restore refuses while the Runtime supervisor is running, before any write and under --dry-run", async () => {
  const env = setupTestEnv();
  try {
    const { env: stateEnv, projectA, eventsA, registryDb } = seedTwoProjects(env.dir);
    const outDir = join(env.dir, "backup-live");
    createBackup({ projectRoot: projectA, outDir, env: stateEnv });
    seedRun(eventsA, "run_a_after", "prj_a");

    // A live supervisor as `kxm runtime status` judges one: running, a fresh heartbeat,
    // and a pid that exists (this test process).
    const registry = new KxmRuntimeRegistry(registryDb);
    registry.claimSupervisor({ runtimeId: "rt_scope", pid: process.pid, port: 4567, tokenHash: "hash", now: new Date().toISOString() });
    registry.close();
    const registryBefore = readFileSync(registryDb);

    for (const argv of [["restore", outDir, "--json"], ["restore", outDir, "--dry-run", "--json"]]) {
      const io = capture();
      assert.equal(await runCli(argv, stateEnv, io, projectA), 1, argv.join(" "));
      const payload = JSON.parse(io.read().stderr) as { error: string; issues: Array<{ code: string }> };
      assert.equal(payload.error, "restore_failed", argv.join(" "));
      assert.equal(payload.issues[0]?.code, "restore_runtime_running", argv.join(" "));
    }
    assert.equal(hasRun(eventsA, "run_a_after"), true, "nothing was restored");
    assert.deepEqual(readFileSync(registryDb), registryBefore, "the liveness check does not write the registry");
    assert.equal(existsSync(`${registryDb}-wal`), false);
    assert.equal(existsSync(`${registryDb}-shm`), false);

    // A registry too broken to read cannot prove the supervisor is down.
    const registryAside = `${registryDb}.aside`;
    writeFileSync(registryAside, registryBefore);
    writeFileSync(registryDb, "not a database");
    const unverifiedIo = capture();
    assert.equal(await runCli(["restore", outDir, "--json"], stateEnv, unverifiedIo, projectA), 1);
    assert.equal((JSON.parse(unverifiedIo.read().stderr) as { issues: Array<{ code: string }> }).issues[0]?.code, "restore_runtime_unverified");
    assert.equal(hasRun(eventsA, "run_a_after"), true, "nothing was restored");
    writeFileSync(registryDb, readFileSync(registryAside));

    const stopped = new KxmRuntimeRegistry(registryDb);
    stopped.markStopped(process.pid, new Date().toISOString());
    stopped.close();
    const io = capture();
    assert.equal(await runCli(["restore", outDir, "--json"], stateEnv, io, projectA), 0, io.read().stderr);
    assert.equal(hasRun(eventsA, "run_a_after"), false);
  } finally {
    env.cleanup();
  }
});

test("kxm restore refuses while a hub holds the hub store it would overwrite", async () => {
  const env = setupTestEnv();
  try {
    const { env: stateEnv, projectA, hubStorePath } = seedTwoProjects(env.dir);
    const outDir = join(env.dir, "backup-hub");
    createBackup({ projectRoot: projectA, outDir, env: stateEnv });
    const hub = new MeshStore(hubStorePath);
    hub.saveAgent(makeStoredAgent("agt_after", { name: "After" }));
    hub.close();
    const claim = join(projectA, ".kxm", "state", "hub.pid");
    writeFileSync(claim, JSON.stringify({ version: 1, role: "hub", pid: process.pid }));

    const refusedIo = capture();
    assert.equal(await runCli(["restore", outDir, "--dry-run", "--json"], stateEnv, refusedIo, projectA), 1);
    assert.equal((JSON.parse(refusedIo.read().stderr) as { issues: Array<{ code: string }> }).issues[0]?.code, "restore_hub_running");
    const stillLive = new MeshStore(hubStorePath);
    assert.equal(stillLive.agents.get("agt_after")?.name, "After");
    stillLive.close();

    rmSync(claim);
    const io = capture();
    assert.equal(await runCli(["restore", outDir, "--json"], stateEnv, io, projectA), 0, io.read().stderr);
    const restored = new MeshStore(hubStorePath);
    assert.equal(restored.agents.has("agt_after"), false);
    restored.close();
  } finally {
    env.cleanup();
  }
});

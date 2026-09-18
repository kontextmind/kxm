import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "./sqlite.ts";
import { KxmConfigError, type KxmConfigIssue } from "./project-config.ts";

export interface DatabaseMigrationStep {
  fromVersion: number;
  toVersion: number;
  migrate: (database: DatabaseSync) => void;
}

export interface DatabaseSchemaSpec {
  schema: string;
  version: number;
  tables?: Readonly<Record<string, readonly string[]>>;
  migrations?: readonly DatabaseMigrationStep[];
  timeoutMs?: number;
}

export interface BackupStoreRecord {
  storeId: string;
  sourcePath: string;
  backupFile: string;
  schemaVersion: number;
  sha256: string;
  bytes: number;
  integrity: "ok";
}

export interface BackupManifest {
  schema: "kxm.backup-manifest.v1";
  backupId: string;
  createdAt: string;
  projectRoot?: string;
  stores: BackupStoreRecord[];
  manifestSha256?: string;
}

export interface RestoreStoreRecord {
  storeId: string;
  sourcePath: string;
  backupFile: string;
  schemaVersion: number;
  integrity: "ok";
}

export interface RestoreResult {
  manifestPath: string;
  backupId: string;
  restoredStores: RestoreStoreRecord[];
}

export function databaseError(code: string, file: string, message: string): KxmConfigError {
  const issue: KxmConfigIssue = { phase: "semantic", code, file, message };
  return new KxmConfigError([issue]);
}

export function checkedParent(path: string, description: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = lstatSync(parent, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw databaseError("runtime_path_invalid", description, `${description} parent must be a regular directory, not a link`);
  }
}

export function userTables(database: DatabaseSync): string[] {
  const rows = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = \x27table\x27 AND name NOT LIKE \x27sqlite_%\x27 ORDER BY name",
  ).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export function tableColumns(database: DatabaseSync, table: string): string[] {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name).sort();
}

export function verifyExpectedTables(
  database: DatabaseSync,
  file: string,
  description: string,
  expected: Readonly<Record<string, readonly string[]>>,
): void {
  const present = new Set(userTables(database));
  for (const [table, columns] of Object.entries(expected)) {
    if (!present.has(table)) {
      throw databaseError("runtime_schema_shape_invalid", file, `${description} is missing table ${table}`);
    }
    const actual = tableColumns(database, table);
    const missing = columns.filter((column) => !actual.includes(column));
    if (missing.length > 0) {
      throw databaseError("runtime_schema_shape_invalid", file, `${description} table ${table} is missing columns ${missing.join(", ")}`);
    }
  }
}

export function ensureWalJournalMode(database: DatabaseSync, file: string, description: string, timeoutMs = 5000): void {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      const current = database.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
      if (current?.journal_mode === "wal") {
        return;
      }
      const updated = database.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | undefined;
      if (updated?.journal_mode === "wal") {
        return;
      }
    } catch (error) {
      const sqliteError = error as { code?: string; errcode?: number };
      if (sqliteError.code === "ERR_SQLITE_ERROR" && sqliteError.errcode === 5 && Date.now() < deadline) {
        Atomics.wait(sleeper, 0, 0, 10);
        continue;
      }
      throw error;
    }
    if (Date.now() >= deadline) {
      throw databaseError("runtime_timeout", file, `${description} timed out enabling WAL journal mode`);
    }
    Atomics.wait(sleeper, 0, 0, 10);
  }
}

export function openDatabase(file: string, description: string, spec: DatabaseSchemaSpec): DatabaseSync {
  const isMemory = file === ":memory:";
  if (!isMemory) {
    checkedParent(file, description);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw databaseError("runtime_path_invalid", description, `${description} must be a regular file, not a link or directory`);
      }
    }
    for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
      const info = lstatSync(sidecar, { throwIfNoEntry: false });
      if (info?.isSymbolicLink()) {
        throw databaseError("runtime_path_invalid", description, `${description} sidecar must not be a link`);
      }
    }
  }

  const database = new DatabaseSync(file);
  let transaction = false;
  try {
    database.exec(`PRAGMA busy_timeout = ${spec.timeoutMs ?? 5000}`);
    if (!isMemory) {
      ensureWalJournalMode(database, file, description, spec.timeoutMs);
    }
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec("PRAGMA foreign_keys = ON");

    database.exec("BEGIN IMMEDIATE");
    transaction = true;
    const row = database.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    const version = row?.user_version ?? 0;

    if (version > spec.version) {
      throw databaseError("runtime_schema_newer", file, `${description} schema version ${version} is newer than this runtime supports`);
    }

    if (version === 0) {
      const existing = userTables(database);
      if (existing.length > 0) {
        throw databaseError("runtime_schema_shape_invalid", file, `${description} has tables at schema version 0`);
      }
      database.exec(spec.schema);
      database.exec(`PRAGMA user_version = ${spec.version}`);
    } else if (version < spec.version) {
      let currentVersion = version;
      while (currentVersion < spec.version) {
        const step = spec.migrations?.find((m) => m.fromVersion === currentVersion);
        if (!step) {
          throw databaseError(
            "runtime_schema_outdated",
            file,
            `${description} schema version ${version} is older than ${spec.version}; no migration lane, backup and restore remain E6`,
          );
        }
        step.migrate(database);
        currentVersion = step.toVersion;
        database.exec(`PRAGMA user_version = ${currentVersion}`);
      }
    }

    if (spec.tables) {
      verifyExpectedTables(database, file, description, spec.tables);
    }

    database.exec("COMMIT");
    transaction = false;
    return database;
  } catch (error) {
    if (transaction) {
      try { database.exec("ROLLBACK"); } catch { /* already rolled back */ }
    }
    database.close();
    throw error;
  }
}

const activeTransactions = new WeakSet<DatabaseSync>();

export function withDatabaseTransaction<T>(
  database: DatabaseSync,
  work: () => T,
  mode: "IMMEDIATE" | "DEFERRED" | "EXCLUSIVE" = "IMMEDIATE",
): T {
  if (activeTransactions.has(database)) {
    throw databaseError("runtime_transaction_nested", "transaction", "nested transactions are not allowed");
  }
  activeTransactions.add(database);
  database.exec(`BEGIN ${mode}`);
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* ignore rollback error if connection dead */ }
    throw error;
  } finally {
    activeTransactions.delete(database);
  }
}

export function checkpointWal(
  database: DatabaseSync,
  mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "TRUNCATE",
): { busy: number; log: number; checkpointed: number } {
  const row = database.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as {
    busy?: number;
    log?: number;
    checkpointed?: number;
  } | undefined;
  return {
    busy: row?.busy ?? 0,
    log: row?.log ?? 0,
    checkpointed: row?.checkpointed ?? 0,
  };
}

export function checkIntegrity(database: DatabaseSync): boolean {
  const rows = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check?: string }>;
  return rows.length === 1 && rows[0]?.integrity_check === "ok";
}

export function fileSha256(filePath: string): string {
  const bytes = readFileSync(filePath);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function backupDatabaseFile(sourcePath: string, targetPath: string, storeId: string): BackupStoreRecord {
  const resolvedSource = resolve(sourcePath);
  const resolvedTarget = resolve(targetPath);

  const sourceStat = lstatSync(resolvedSource, { throwIfNoEntry: false });
  if (!sourceStat || !sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw databaseError("runtime_path_invalid", resolvedSource, `source database ${resolvedSource} must be a regular file, not a link or directory`);
  }

  checkedParent(resolvedTarget, "backup target");

  if (existsSync(resolvedTarget)) {
    unlinkSync(resolvedTarget);
  }

  const sourceDb = new DatabaseSync(resolvedSource);
  let schemaVersion = 0;
  try {
    sourceDb.exec("PRAGMA busy_timeout = 5000");
    checkpointWal(sourceDb, "TRUNCATE");
    if (!checkIntegrity(sourceDb)) {
      throw databaseError("database_corrupted", resolvedSource, `database ${resolvedSource} failed integrity check`);
    }
    const versionRow = sourceDb.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    schemaVersion = versionRow?.user_version ?? 0;

    const escapedTarget = resolvedTarget.replace(/\x27/g, "\x27\x27");
    sourceDb.exec(`VACUUM INTO \x27${escapedTarget}\x27`);
  } finally {
    sourceDb.close();
  }

  const targetDb = new DatabaseSync(resolvedTarget);
  try {
    targetDb.exec("PRAGMA busy_timeout = 5000");
    if (!checkIntegrity(targetDb)) {
      throw databaseError("database_corrupted", resolvedTarget, `backup database ${resolvedTarget} failed integrity check`);
    }
  } finally {
    targetDb.close();
  }

  try { chmodSync(resolvedTarget, 0o600); } catch { /* Windows */ }

  const sha256 = fileSha256(resolvedTarget);
  const bytes = lstatSync(resolvedTarget).size;

  return {
    storeId,
    sourcePath: resolvedSource,
    backupFile: basename(resolvedTarget),
    schemaVersion,
    sha256,
    bytes,
    integrity: "ok",
  };
}

export function restoreDatabaseFile(
  backupPath: string,
  targetPath: string,
  storeId: string,
  expectedSchemaVersion?: number,
  maxSupportedVersion?: number,
): RestoreStoreRecord {
  const resolvedBackup = resolve(backupPath);
  const resolvedTarget = resolve(targetPath);

  const backupStat = lstatSync(resolvedBackup, { throwIfNoEntry: false });
  if (!backupStat || !backupStat.isFile() || backupStat.isSymbolicLink()) {
    throw databaseError("runtime_path_invalid", resolvedBackup, `backup database ${resolvedBackup} must be a regular file, not a link or directory`);
  }

  const backupDb = new DatabaseSync(resolvedBackup);
  let schemaVersion = 0;
  try {
    backupDb.exec("PRAGMA busy_timeout = 5000");
    if (!checkIntegrity(backupDb)) {
      throw databaseError("database_corrupted", resolvedBackup, `backup database ${resolvedBackup} failed integrity check`);
    }
    const versionRow = backupDb.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    schemaVersion = versionRow?.user_version ?? 0;

    if (maxSupportedVersion !== undefined && schemaVersion > maxSupportedVersion) {
      throw databaseError(
        "runtime_schema_newer",
        resolvedBackup,
        `backup store ${storeId} schema version ${schemaVersion} is newer than supported maximum ${maxSupportedVersion}`,
      );
    }
    if (expectedSchemaVersion !== undefined && schemaVersion !== expectedSchemaVersion) {
      throw databaseError(
        "runtime_schema_mismatch",
        resolvedBackup,
        `backup store ${storeId} schema version ${schemaVersion} does not match manifest version ${expectedSchemaVersion}`,
      );
    }
  } finally {
    backupDb.close();
  }

  checkedParent(resolvedTarget, "restore target");

  for (const file of [resolvedTarget, `${resolvedTarget}-wal`, `${resolvedTarget}-shm`]) {
    if (existsSync(file)) {
      try { unlinkSync(file); } catch { /* ignore */ }
    }
  }

  copyFileSync(resolvedBackup, resolvedTarget);
  try { chmodSync(resolvedTarget, 0o600); } catch { /* Windows */ }

  const targetDb = new DatabaseSync(resolvedTarget);
  try {
    targetDb.exec("PRAGMA busy_timeout = 5000");
    if (!checkIntegrity(targetDb)) {
      throw databaseError("database_corrupted", resolvedTarget, `restored database ${resolvedTarget} failed integrity check`);
    }
  } finally {
    targetDb.close();
  }

  return {
    storeId,
    sourcePath: resolvedTarget,
    backupFile: basename(resolvedBackup),
    schemaVersion,
    integrity: "ok",
  };
}

export function discoverProjectStores(projectRoot: string, options: { hubDataPath?: string } = {}): Array<{ storeId: string; sourcePath: string; maxSupportedVersion: number }> {
  const root = resolve(projectRoot);
  const stores: Array<{ storeId: string; sourcePath: string; maxSupportedVersion: number }> = [];

  const hubPath = options.hubDataPath ? resolve(options.hubDataPath) : join(root, ".kxm", "state", "kxm.db");
  if (existsSync(hubPath)) {
    stores.push({ storeId: "hub-store", sourcePath: hubPath, maxSupportedVersion: 3 });
  }

  const registryPath = join(root, ".kxm", "runtime", "registry.db");
  if (existsSync(registryPath)) {
    stores.push({ storeId: "registry", sourcePath: registryPath, maxSupportedVersion: 1 });
  }

  const bindingsPath = join(root, ".kxm", "runtime", "bindings.db");
  if (existsSync(bindingsPath)) {
    stores.push({ storeId: "binding-store", sourcePath: bindingsPath, maxSupportedVersion: 1 });
  }

  const eventsDir = join(root, ".kxm", "runtime", "events");
  if (existsSync(eventsDir)) {
    const entries = readdirSync(eventsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".db")) {
        const key = entry.name.replace(/\.db$/, "");
        stores.push({
          storeId: `events:${key}`,
          sourcePath: join(eventsDir, entry.name),
          maxSupportedVersion: 4,
        });
      }
    }
  }

  return stores;
}

export function createBackup(options: {
  projectRoot?: string;
  outDir?: string;
  hubDataPath?: string;
} = {}): { manifest: BackupManifest; outDir: string } {
  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : process.cwd();
  const stores = discoverProjectStores(projectRoot, {
    ...(options.hubDataPath !== undefined ? { hubDataPath: options.hubDataPath } : {}),
  });

  if (stores.length === 0) {
    throw databaseError("backup_no_stores", projectRoot, "no existing SQLite stores found to backup");
  }

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const backupId = `bk_${randomBytes(8).toString("hex")}`;
  const outDir = options.outDir ? resolve(options.outDir) : join(projectRoot, ".kxm", "backups", `backup-${timestamp}`);

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
  }

  const backedUpStores: BackupStoreRecord[] = [];
  const usedFilenames = new Set<string>();

  for (const store of stores) {
    let filename = basename(store.sourcePath);
    if (usedFilenames.has(filename)) {
      const sanitizedId = store.storeId.replace(/[^a-zA-Z0-9_.-]/g, "_");
      filename = `${sanitizedId}-${filename}`;
    }
    usedFilenames.add(filename);

    const targetFile = join(outDir, filename);
    const record = backupDatabaseFile(store.sourcePath, targetFile, store.storeId);
    backedUpStores.push(record);
  }

  const manifest: BackupManifest = {
    schema: "kxm.backup-manifest.v1",
    backupId,
    createdAt: now.toISOString(),
    projectRoot,
    stores: backedUpStores,
  };

  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  const manifestSha256 = `sha256:${createHash("sha256").update(manifestJson, "utf8").digest("hex")}`;
  manifest.manifestSha256 = manifestSha256;

  const finalJson = JSON.stringify(manifest, null, 2) + "\n";
  const manifestPath = join(outDir, "manifest.json");
  writeFileSync(manifestPath, finalJson, "utf8");

  return { manifest, outDir };
}

export function restoreBackup(
  manifestPathOrDir: string,
  options: { projectRoot?: string } = {},
): RestoreResult {
  let manifestPath = resolve(manifestPathOrDir);
  const stat = lstatSync(manifestPath, { throwIfNoEntry: false });
  if (!stat) {
    throw databaseError("runtime_path_invalid", manifestPath, `manifest path ${manifestPath} does not exist`);
  }
  if (stat.isDirectory()) {
    manifestPath = join(manifestPath, "manifest.json");
  }

  if (!existsSync(manifestPath)) {
    throw databaseError("runtime_path_invalid", manifestPath, `backup manifest ${manifestPath} not found`);
  }

  const manifestDir = dirname(manifestPath);
  const rawText = readFileSync(manifestPath, "utf8");
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(rawText) as BackupManifest;
  } catch (error) {
    throw databaseError("restore_manifest_invalid", manifestPath, `failed to parse backup manifest: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (manifest.schema !== "kxm.backup-manifest.v1" || !Array.isArray(manifest.stores) || manifest.stores.length === 0) {
    throw databaseError("restore_manifest_invalid", manifestPath, "manifest is not a valid kxm.backup-manifest.v1 document");
  }

  const restoredStores: RestoreStoreRecord[] = [];

  for (const store of manifest.stores) {
    const backupFilePath = join(manifestDir, store.backupFile);
    if (!existsSync(backupFilePath)) {
      throw databaseError("restore_file_missing", backupFilePath, `backup file ${store.backupFile} missing from ${manifestDir}`);
    }

    const actualSha256 = fileSha256(backupFilePath);
    if (actualSha256 !== store.sha256) {
      throw databaseError(
        "restore_manifest_digest_mismatch",
        backupFilePath,
        `backup file ${store.backupFile} sha256 ${actualSha256} does not match manifest hash ${store.sha256}`,
      );
    }

    let maxSupported = 3;
    if (store.storeId === "registry" || store.storeId === "binding-store") {
      maxSupported = 1;
    } else if (store.storeId.startsWith("events:")) {
      // Must track KXM_EVENT_STORE_SCHEMA_VERSION in runtime-store.ts. The pin is
      // the e6 backup/restore round-trip test: bump one without the other and it
      // refuses its own fresh backup.
      maxSupported = 5;
    }

    let targetPath = store.sourcePath;
    if (options.projectRoot && manifest.projectRoot && targetPath.startsWith(manifest.projectRoot)) {
      const rel = targetPath.slice(manifest.projectRoot.length).replace(/^[\\/]+/, "");
      targetPath = join(resolve(options.projectRoot), rel);
    }

    const result = restoreDatabaseFile(
      backupFilePath,
      targetPath,
      store.storeId,
      store.schemaVersion,
      maxSupported,
    );
    restoredStores.push(result);
  }

  return {
    manifestPath,
    backupId: manifest.backupId,
    restoredStores,
  };
}

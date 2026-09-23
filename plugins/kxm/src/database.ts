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

export interface DatabaseSchemaSpec {
  schema: string;
  version: number;
  tables?: Readonly<Record<string, readonly string[]>>;
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
      // No migration lanes. This is a single-operator tool: an older database is
      // re-initialised, not upgraded in place, and the code never carries two schema
      // shapes at once. Silently accepting an older file would mean every query has to
      // work against shapes it no longer tests.
      throw databaseError(
        "runtime_schema_outdated",
        file,
        `${description} is schema version ${version}; this build requires ${spec.version}. Delete the state file to start fresh and let its owning process recreate it (\`kxm hub start\` for hub state, the Runtime for registry/event stores); \`kxm init\` is project-only and rebuilds no database — upgrading old state in place is deliberately unsupported`,
      );
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

/**
 * How long a connection refuses to retry a `BEGIN` that lost the write race.
 *
 * SQLite's busy timeout is per connection, so a `BEGIN` against a locked
 * database waits the full timeout before failing. Callers that recover from a
 * lost write open several transactions in a row; without this window each of
 * them pays the timeout, and a suite run showed that turning one 4-second test
 * into 17 minutes. The old code got that speed by accident — it left the
 * connection permanently marked as in-transaction after a failed `BEGIN`, which
 * is the defect fixed below — so the backoff replaces the fast-fail without
 * re-introducing the poison.
 *
 * Two limits, both deliberate:
 * - It is a **throttle, not a queue**. A caller whose lock cleared 1 ms later is
 *   still refused for the rest of the window; the refusal is explicit
 *   (`runtime_transaction_busy`, message says `retry deferred`) and bounded by
 *   this constant. A retry after the window may pay the busy timeout again.
 * - It is **per connection object, in this process**. It is not a cross-process
 *   backoff and does not leak to another connection to the same file.
 */
export const TRANSACTION_BUSY_BACKOFF_MS = 1_000;

/**
 * Monotonic elapsed time, deliberately not `Date.now()`.
 *
 * A wall-clock step backwards would otherwise keep a long-gone write lock
 * refusing transactions until real time caught up, and a step forward would end
 * the throttle early. `hrtime.bigint()` is relative to an arbitrary past origin
 * and never moves backwards, so the window is bounded by
 * {@link TRANSACTION_BUSY_BACKOFF_MS} no matter what the system clock does.
 *
 * Injectable: production callers never pass it, and a test drives it directly so
 * the window is stepped rather than raced or slept through.
 */
export type MonotonicClock = () => number;

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * Pending throttle per connection, **keyed by the clock that armed it**.
 *
 * The nesting is the fix, not tidiness. A deadline is a number from *some* clock,
 * and the injectable `clock` exists only so a test can step the window; comparing
 * a deadline armed by one clock against a reading taken from another is how an
 * injected "one hour from now" throttles a production caller that never passed a
 * clock at all — and how that same caller could clear a deadline it never armed.
 * Each clock domain therefore gets its own deadline and can only read, expire or
 * replace its own. The inner map is **weak in the clock**: it keeps no otherwise
 * unreachable clock function alive, so an attempt that builds a fresh closure per
 * call leaves nothing behind once that closure is collected. A clock that *is*
 * retained keeps its entry until it expires or is replaced — collection is neither
 * immediate nor size-bounded, and no committed test measures any of this, because no
 * production caller passes a clock.
 */
const transactionThrottles = new WeakMap<DatabaseSync, WeakMap<MonotonicClock, number>>();

/**
 * A clock reading this helper can reason about.
 *
 * Scope, stated as measured rather than as a slogan. The clock is read at **two call
 * sites**: checking an existing deadline on a non-`DEFERRED` attempt, and arming after a
 * contended `BEGIN` failure. Reads per call, each reproduced by an assertion in
 * `test/core/intake.test.ts`: clean success with no pending entry 0; successful
 * `DEFERRED`, pending entry present or not, 0; fresh contention 1; refusal inside a window
 * 1; an expired deadline followed by renewed contention 2 in that call; a permanent
 * `BEGIN` failure with no pending entry 0; a nested-transaction rejection 0.
 *
 * Which means it is wrong in both directions to say either "every `BEGIN` validates the
 * clock" or "the *only* transaction that skips it is a clean uncontended success" — the
 * second was mine, twice, and the second correction to it was still a slogan. The tests
 * count; the prose only points at them. Production cannot reach the guard at all, because
 * the default is `hrtime`; it exists so the injectable seam cannot become a silent
 * bypass.
 */
function finiteNow(clock: MonotonicClock, label: string): number {
  const now = clock();
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw databaseError(
      "runtime_transaction_clock_invalid",
      "transaction",
      `${label} must return a finite monotonic number; got ${String(now)}`,
    );
  }
  return now;
}

/**
 * Is this `BEGIN` failure contention for the write lock, as opposed to a
 * programming or environment error?
 *
 * Only contention may be retried, and only contention earns the throttle window.
 * Anything else — "cannot start a transaction within a transaction", a closed
 * connection, a miscompiled statement — must surface unchanged, or a permanent
 * bug looks like a transient one and the caller retries forever.
 *
 * SQLite's **numeric result code decides** where one exists, because it is stable
 * across versions while message text is not: the primary code is `code & 0xff`, so
 * extended forms land on their primaries — `SQLITE_BUSY_RECOVERY` (261) and
 * `SQLITE_BUSY_SNAPSHOT` (517) on `SQLITE_BUSY` (5), `SQLITE_LOCKED_SHAREDCACHE`
 * (262) on `SQLITE_LOCKED` (6). `SQLITE_PROTOCOL` (15) is included deliberately:
 * SQLite raises it when repeated attempts to start a transaction under WAL exhaust
 * the retry count, which is a lock-acquisition retry condition, not a broken
 * database.
 *
 * Where both runtimes expose one, **the number wins over the text**: Node spells it
 * `errcode`, `bun:sqlite` spells it `errno` (verified on Bun 1.3.14, where a shared-
 * cache `BEGIN` arrives as `errno: 262`, `code: "SQLITE_LOCKED_SHAREDCACHE"`,
 * message "database schema is locked: shared"). A symbolic `code`/`name` of the form
 * `SQLITE_BUSY*`/`SQLITE_LOCKED*`/`SQLITE_PROTOCOL*` is accepted next, and bare
 * message matching is the last resort — applied only when neither exists, so a
 * wrapper that merely quotes "database is locked" alongside a permanent code is not
 * mistaken for contention.
 *
 * Deliberately **not** contention: `SQLITE_FULL` / "database or disk is full",
 * "unable to open database file", and WAL shared-memory I/O failures. Those stay
 * broken until something outside this connection changes.
 */
/** Node: `errcode`. Bun: `errno`. Both spell the extended code as a number. */
const CONTENTION_PRIMARY_CODES: readonly number[] = [5, 6, 15];
/** `bun:sqlite` puts the symbolic name in `code`; Node puts its own kind there. */
const CONTENTION_SYMBOLIC_NAMES = /^SQLITE_(?:BUSY|LOCKED|PROTOCOL)(?:_[A-Z0-9]+)?$/;
/** Any SQLite result name. If one is present it decides, so text cannot argue. */
const SQLITE_RESULT_NAMES = /^SQLITE_[A-Z][A-Z0-9_]*$/;
const CONTENTION_MESSAGES =
  /^(?:database is locked|database table is locked|locking protocol|SQLITE_BUSY|SQLITE_LOCKED|SQLITE_PROTOCOL)(?:$|[\s.:])/i;

export function isTransactionContention(error: unknown): boolean {
  const carrier = error as { errcode?: unknown; errCode?: unknown; errno?: unknown; code?: unknown; name?: unknown }
    | undefined;
  // A numeric code wins first, then a symbolic result name, and both win **over the
  // message**: `errno` is what `bun:sqlite` exposes for the extended result code while
  // its `code` field holds the symbolic name, and Node spells the number `errcode`.
  // All three properties are read; what the list orders is which **integer value
  // decides** — a present `errcode` outranks `errCode`, which outranks `errno`, and a
  // later number is never consulted. Text is consulted only when the error carries
  // neither a number nor a SQLite result name, so no wrapper quoting an older
  // "database is locked" can outvote a code on either runtime.
  for (const value of [carrier?.errcode, carrier?.errCode, carrier?.errno]) {
    if (typeof value === "number" && Number.isInteger(value)) return CONTENTION_PRIMARY_CODES.includes(value & 0xff);
  }
  for (const value of [carrier?.code, carrier?.name]) {
    // A result **name** is as authoritative as a number, and in both directions:
    // `SQLITE_FULL` wearing a "database is locked" message is not contention. Node
    // spells its own error kind `ERR_SQLITE_ERROR`, which is deliberately not a
    // SQLite result name and so never reaches a verdict here.
    if (typeof value === "string" && SQLITE_RESULT_NAMES.test(value)) {
      return CONTENTION_SYMBOLIC_NAMES.test(value);
    }
  }
  return CONTENTION_MESSAGES.test(error instanceof Error ? error.message : String(error));
}

export function withDatabaseTransaction<T>(
  database: DatabaseSync,
  work: () => T,
  mode: "IMMEDIATE" | "DEFERRED" | "EXCLUSIVE" = "IMMEDIATE",
  clock: MonotonicClock = monotonicNowMs,
): T {
  if (activeTransactions.has(database)) {
    throw databaseError("runtime_transaction_nested", "transaction", "nested transactions are not allowed");
  }
  // A DEFERRED BEGIN takes no write lock, so it is exempt from the *check*: refusing
  // it would deny legitimate work over a contention it did not ask for. Exempt from
  // the check only — shared-cache schema locks can still make a deferred `BEGIN`
  // fail, and that failure arms a deadline like any other, because the next attempt
  // would stall the same way.
  if (mode !== "DEFERRED") {
    const deadlines = transactionThrottles.get(database);
    const until = deadlines?.get(clock);
    if (until !== undefined) {
      const remaining = until - finiteNow(clock, "the transaction clock");
      if (remaining > 0) {
        throw databaseError(
          "runtime_transaction_busy",
          "transaction",
          `a previous BEGIN was blocked on this database; retry deferred ${String(remaining)}ms`,
        );
      }
      deadlines?.delete(clock);
    }
  }
  // Claim the marker only once BEGIN has succeeded. If BEGIN throws — another
  // writer held the database past the busy timeout — a connection that never
  // entered a transaction must not be left permanently marked as inside one,
  // which would fail every later transaction on it with a misleading
  // "nested" error. `finally` cannot cover this: it only runs after the try.
  try {
    database.exec(`BEGIN ${mode}`);
  } catch (error) {
    if (!isTransactionContention(error)) throw error;
    const now = finiteNow(clock, "the transaction clock");
    let deadlines = transactionThrottles.get(database);
    if (deadlines === undefined) {
      deadlines = new WeakMap<MonotonicClock, number>();
      transactionThrottles.set(database, deadlines);
    }
    deadlines.set(clock, now + TRANSACTION_BUSY_BACKOFF_MS);
    throw databaseError(
      "runtime_transaction_busy",
      "transaction",
      `BEGIN ${mode} blocked by another transaction: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  activeTransactions.add(database);
  // A successful write-mode BEGIN means this connection is holding the slot, so any
  // earlier contention is over. A DEFERRED success proves nothing about the write
  // lock and must not clear a throttle that another caller's contention armed.
  if (mode !== "DEFERRED") transactionThrottles.get(database)?.delete(clock);
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    // A failed ROLLBACK usually means the connection is gone. Clearing the marker
    // is bookkeeping, not proof: it does **not** show SQLite exited the
    // transaction, and nothing here invalidates a handle whose rollback failed.
    // Pre-existing, named rather than papered over — the caller receives the
    // original error.
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

/**
 * Per-store restore ceilings, held in **one** table read by both backup discovery
 * and restore. Two copies of these numbers drifted once already: a schema bump
 * raised the restore ceiling and left the discovery ceiling behind, and nothing
 * caught it because nothing read the stale copy.
 *
 * Each value MUST track the version its store declares — `HUB_STORE_SCHEMA_VERSION`
 * in `store.ts`, `KXM_REGISTRY_SCHEMA_VERSION` and `KXM_EVENT_STORE_SCHEMA_VERSION`
 * in `runtime-store.ts`. Those modules import this one, so the constants cannot be
 * named here; the gate is the named test
 * `restore ceilings track every store's own schema version` in
 * `test/core/e6-backup-restore-migrations.test.ts`, which is what the deleted
 * "must track" comments were only pretending to be.
 */
export const KXM_BACKUP_CEILINGS = {
  "hub-store": 5,
  registry: 1,
  "binding-store": 1,
  events: 7,
} as const;

export function kxmBackupCeiling(storeId: string): number {
  if (storeId.startsWith("events:")) return KXM_BACKUP_CEILINGS.events;
  // An id this build does not know keeps the ceiling restore has always defaulted to.
  return KXM_BACKUP_CEILINGS[storeId as keyof typeof KXM_BACKUP_CEILINGS] ?? KXM_BACKUP_CEILINGS["hub-store"];
}

export function discoverProjectStores(projectRoot: string, options: { hubDataPath?: string } = {}): Array<{ storeId: string; sourcePath: string; maxSupportedVersion: number }> {
  const root = resolve(projectRoot);
  const stores: Array<{ storeId: string; sourcePath: string; maxSupportedVersion: number }> = [];

  const hubPath = options.hubDataPath ? resolve(options.hubDataPath) : join(root, ".kxm", "state", "kxm.db");
  if (existsSync(hubPath)) {
    stores.push({ storeId: "hub-store", sourcePath: hubPath, maxSupportedVersion: kxmBackupCeiling("hub-store") });
  }

  const registryPath = join(root, ".kxm", "runtime", "registry.db");
  if (existsSync(registryPath)) {
    stores.push({ storeId: "registry", sourcePath: registryPath, maxSupportedVersion: kxmBackupCeiling("registry") });
  }

  const bindingsPath = join(root, ".kxm", "runtime", "bindings.db");
  if (existsSync(bindingsPath)) {
    stores.push({ storeId: "binding-store", sourcePath: bindingsPath, maxSupportedVersion: kxmBackupCeiling("binding-store") });
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
          maxSupportedVersion: kxmBackupCeiling(`events:${key}`),
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

    const maxSupported = kxmBackupCeiling(store.storeId);

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

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import {
  VnextConfigError,
  VnextSchemaRegistry,
  parseRestrictedYaml,
  type JsonObject,
  type VnextConfigIssue,
} from "./vnext-config.ts";

const MAX_BINDING_RECORD_BYTES = 256 * 1024;
const BINDING_LABEL = "Runtime-local repository bindings";

export interface VnextLocalBindingRecord {
  schema: "kxm.local-repository-bindings.v1";
  projectId: string;
  projectRoot: string;
  repositories: Readonly<Record<string, string>>;
}

export interface LoadedVnextLocalBindings extends VnextLocalBindingRecord {
  file: string;
}

export interface VnextLocalBindingPathOptions {
  stateRoot?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export interface VnextLocalBindingStoreOptions extends VnextLocalBindingPathOptions {
  schemasDir?: string;
}

export interface VnextLocalBindingWriteResult {
  file: string;
  written: boolean;
  record: VnextLocalBindingRecord;
}

export interface VnextLocalBindingLock {
  readonly projectRoot: string;
  readonly file: string;
}

const activeLocks = new WeakSet<VnextLocalBindingLock>();

function bindingIssue(phase: VnextConfigIssue["phase"], code: string, message: string): VnextConfigIssue {
  return { phase, code, file: BINDING_LABEL, message };
}

function bindingError(phase: VnextConfigIssue["phase"], code: string, message: string): never {
  throw new VnextConfigError([bindingIssue(phase, code, message)]);
}

function canonicalHostPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function sameHostPath(left: string, right: string, platform = process.platform): boolean {
  const first = canonicalHostPath(left);
  const second = canonicalHostPath(right);
  return platform === "win32"
    ? first.toLocaleLowerCase("en-US") === second.toLocaleLowerCase("en-US")
    : first === second;
}

/** Resolve the per-user state root without consulting any legacy KXM_* workspace override. */
export function vnextUserStateRoot(options: VnextLocalBindingPathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const explicit = options.stateRoot ?? env.KXM_STATE_HOME?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) bindingError("path", "local_state_root_not_absolute", "KXM_STATE_HOME must be an absolute host-local path");
    return resolve(explicit);
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    const base = localAppData && isAbsolute(localAppData) ? localAppData : join(home, "AppData", "Local");
    return resolve(base, "KXM");
  }
  if (platform === "darwin") return resolve(home, "Library", "Application Support", "KXM");
  const xdgState = env.XDG_STATE_HOME?.trim();
  const base = xdgState && isAbsolute(xdgState) ? xdgState : join(home, ".local", "state");
  return resolve(base, "kxm");
}

function projectBindingKey(projectRoot: string, platform = process.platform): string {
  const canonical = canonicalHostPath(projectRoot);
  const keyInput = platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical;
  return createHash("sha256").update(keyInput, "utf8").digest("hex");
}

export function vnextLocalBindingFile(projectRoot: string, options: VnextLocalBindingPathOptions = {}): string {
  const stateRoot = vnextUserStateRoot(options);
  return join(stateRoot, "projects", projectBindingKey(projectRoot, options.platform), "repository-bindings.json");
}

function checkedDirectory(path: string, description: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    bindingError("path", "local_binding_directory_invalid", `${description} must be a regular directory, not a link or file`);
  }
  return true;
}

function existingBindingDirectory(file: string, stateRoot: string): boolean {
  const projects = join(stateRoot, "projects");
  const project = dirname(file);
  if (!checkedDirectory(stateRoot, "local state root")) return false;
  if (!checkedDirectory(projects, "local projects directory")) return false;
  return checkedDirectory(project, "local project binding directory");
}

function asRecord(value: JsonObject, file: string, projectRoot: string, schemasDir?: string): LoadedVnextLocalBindings {
  const registry = new VnextSchemaRegistry(schemasDir);
  const issues = registry.validateLocalBindings(value, BINDING_LABEL);
  if (issues.length > 0) throw new VnextConfigError(issues);
  const recordRoot = String(value.projectRoot);
  if (!sameHostPath(recordRoot, projectRoot)) {
    bindingError("semantic", "local_binding_project_root_mismatch", "binding record belongs to a different control worktree");
  }
  const repositories = Object.fromEntries(Object.entries(value.repositories as Record<string, string>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  return {
    schema: "kxm.local-repository-bindings.v1",
    projectId: String(value.projectId),
    projectRoot: recordRoot,
    repositories,
    file,
  };
}

/** Read one exact, bounded Runtime-local binding record. Missing state is not an error. */
export function readVnextLocalBindings(
  projectRoot: string,
  options: VnextLocalBindingStoreOptions = {},
): LoadedVnextLocalBindings | undefined {
  const root = resolve(projectRoot);
  const stateRoot = vnextUserStateRoot(options);
  const file = vnextLocalBindingFile(root, options);
  if (!existingBindingDirectory(file, stateRoot) || !existsSync(file)) return undefined;
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    bindingError("path", "local_binding_file_invalid", "binding record must be a regular file, not a link or directory");
  }
  if (stat.size > MAX_BINDING_RECORD_BYTES) {
    bindingError("parse", "local_binding_file_too_large", `binding record exceeds ${MAX_BINDING_RECORD_BYTES} bytes`);
  }
  const parsed = parseRestrictedYaml(readFileSync(file), BINDING_LABEL);
  return asRecord(parsed, file, root, options.schemasDir);
}

function normalizedRecord(
  projectRoot: string,
  projectId: string,
  repositories: Readonly<Record<string, string>>,
  schemasDir?: string,
): VnextLocalBindingRecord {
  const normalizedRepositories = Object.fromEntries(Object.entries(repositories)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([repositoryId, path]) => {
      if (!isAbsolute(path)) bindingError("path", "repository_binding_not_absolute", `host-local binding for ${repositoryId} must be absolute`);
      return [repositoryId, canonicalHostPath(path)];
    }));
  const value: JsonObject = {
    schema: "kxm.local-repository-bindings.v1",
    projectId,
    projectRoot: canonicalHostPath(projectRoot),
    repositories: normalizedRepositories,
  };
  const issues = new VnextSchemaRegistry(schemasDir).validateLocalBindings(value, BINDING_LABEL);
  if (issues.length > 0) throw new VnextConfigError(issues);
  return value as unknown as VnextLocalBindingRecord;
}

function recordsEqual(left: VnextLocalBindingRecord, right: VnextLocalBindingRecord): boolean {
  if (left.projectId !== right.projectId || !sameHostPath(left.projectRoot, right.projectRoot)) return false;
  const leftEntries = Object.entries(left.repositories);
  const rightEntries = Object.entries(right.repositories);
  return leftEntries.length === rightEntries.length && leftEntries.every(([id, path], index) => {
    const other = rightEntries[index];
    return other?.[0] === id && sameHostPath(path, other[1]);
  });
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function createDirectoryIfMissing(path: string): void {
  if (existsSync(path)) return;
  try {
    mkdirSync(path, { mode: 0o700 });
    syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function ensureDurableDirectory(path: string, description: string): void {
  const missing: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) bindingError("path", "local_binding_directory_invalid", `${description} has no existing filesystem ancestor`);
    current = parent;
  }
  checkedDirectory(current, `${description} ancestor`);
  for (const directory of missing.reverse()) {
    mkdirSync(directory, { mode: 0o700 });
    checkedDirectory(directory, description);
    syncDirectory(dirname(directory));
  }
}

function ensureBindingDirectory(file: string, stateRoot: string): void {
  ensureDurableDirectory(stateRoot, "local state root");
  checkedDirectory(stateRoot, "local state root");
  syncDirectory(stateRoot);
  const projects = join(stateRoot, "projects");
  createDirectoryIfMissing(projects);
  checkedDirectory(projects, "local projects directory");
  const project = dirname(file);
  createDirectoryIfMissing(project);
  checkedDirectory(project, "local project binding directory");
}

function assertNoLinkedDirectoryComponents(path: string, description: string): void {
  const absolute = resolve(path);
  const filesystemRoot = parse(absolute).root;
  let current = filesystemRoot;
  const remainder = relative(filesystemRoot, absolute);
  for (const segment of remainder.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      bindingError("path", "project_operation_lock_parent_invalid", `${description} contains a linked or non-directory component`);
    }
  }
}

function projectOperationLockFile(projectRoot: string): string {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLocaleUpperCase("en-US").startsWith("GIT_")) delete env[key];
  }
  const result = spawnSync("git", ["-C", projectRoot, "rev-parse", "--absolute-git-dir"], {
    encoding: "utf8",
    env,
    timeout: 5000,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error || !result.stdout.trim()) {
    bindingError("discovery", "project_operation_lock_unavailable", "cannot resolve the authoritative Git metadata path for project locking");
  }
  const gitDirectory = resolve(result.stdout.trim());
  assertNoLinkedDirectoryComponents(gitDirectory, "authoritative Git metadata path");
  const gitStat = lstatSync(gitDirectory);
  if (gitStat.isSymbolicLink() || !gitStat.isDirectory()) {
    bindingError("path", "project_operation_lock_parent_invalid", "authoritative Git metadata must resolve to a regular directory");
  }
  const lockDirectory = join(gitDirectory, "kxm");
  if (existsSync(lockDirectory)) {
    const stat = lstatSync(lockDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      bindingError("path", "project_operation_lock_parent_invalid", "Git-local KXM lock directory must be regular, not a link or file");
    }
  } else {
    mkdirSync(lockDirectory, { mode: 0o700 });
    syncDirectory(gitDirectory);
  }
  return join(lockDirectory, "project-operation-lock.sqlite");
}

/** Serialize one project mutation with a process-death-released SQLite write lock. */
export function withVnextLocalBindingLock<T>(
  projectRoot: string,
  options: VnextLocalBindingStoreOptions,
  callback: (lock: VnextLocalBindingLock) => T,
): T {
  const root = resolve(projectRoot);
  const file = projectOperationLockFile(root);
  if (existsSync(file)) {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      bindingError("path", "local_binding_lock_invalid", "project-operation lock must be a regular file, not a link or directory");
    }
  }
  const database = new DatabaseSync(file);
  try { chmodSync(file, 0o600); } catch { /* Windows and restrictive filesystems may ignore POSIX modes. */ }
  try {
    try {
      database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    } catch (error) {
      if (/busy|locked/i.test(error instanceof Error ? error.message : String(error))) {
        bindingError("semantic", "local_binding_lock_busy", "another project initialization or binding update is active");
      }
      throw error;
    }
    const lock: VnextLocalBindingLock = Object.freeze({ projectRoot: canonicalHostPath(root), file });
    activeLocks.add(lock);
    try {
      return callback(lock);
    } finally {
      activeLocks.delete(lock);
      database.exec("ROLLBACK");
    }
  } finally {
    database.close();
  }
}

export function planVnextLocalBindings(
  projectRoot: string,
  projectId: string,
  repositories: Readonly<Record<string, string>>,
  options: VnextLocalBindingStoreOptions = {},
): VnextLocalBindingWriteResult {
  const root = resolve(projectRoot);
  const file = vnextLocalBindingFile(root, options);
  const record = normalizedRecord(root, projectId, repositories, options.schemasDir);
  const existing = readVnextLocalBindings(root, options);
  if (existing?.projectId !== undefined && existing.projectId !== projectId) {
    bindingError("semantic", "local_binding_project_id_mismatch", "binding record belongs to a different project identity");
  }
  return { file, written: !existing || !recordsEqual(existing, record), record };
}

/** Atomically persist validated host paths outside the Git-tracked project. */
export function writeVnextLocalBindings(
  projectRoot: string,
  projectId: string,
  repositories: Readonly<Record<string, string>>,
  options: VnextLocalBindingStoreOptions = {},
  lock?: VnextLocalBindingLock,
): VnextLocalBindingWriteResult {
  const root = resolve(projectRoot);
  if (!lock) {
    return withVnextLocalBindingLock(root, options, (acquired) => writeVnextLocalBindings(root, projectId, repositories, options, acquired));
  }
  if (!activeLocks.has(lock) || !sameHostPath(lock.projectRoot, root)) {
    bindingError("semantic", "local_binding_lock_invalid", "binding update does not hold the active project lock");
  }
  const planned = planVnextLocalBindings(root, projectId, repositories, options);
  const { file, record } = planned;
  if (!planned.written) return planned;
  ensureBindingDirectory(file, vnextUserStateRoot(options));
  const temporary = join(dirname(file), `.repository-bindings-${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    syncDirectory(dirname(file));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
  const verified = readVnextLocalBindings(root, options);
  if (!verified || !recordsEqual(verified, record)) {
    bindingError("semantic", "local_binding_install_verification_failed", "installed binding record does not match the validated input");
  }
  return { file, written: true, record };
}

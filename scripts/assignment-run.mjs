#!/usr/bin/env node
// Dev assignment helper. M3a is exported pure validation only: no CLI command,
// output-directory creation, ID reservation, dispatch record, worktree mutation,
// provider spawn, live auth, or any write under .git, task_dir, or cwd.
// Atomic identity consumption is M3b.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import nodePath from "node:path";
import {
  EFFORT,
  REQUEST_SCHEMA,
  preflightRequest,
} from "./harness-run.mjs";

const resolvePath = nodePath.resolve;
const { join, basename } = nodePath;

export const ASSIGNMENT_SCHEMA = "kxm.assignment.v1";
export const PLAN_POINTER_SCHEMA = "kxm.plan-pointer.v1";
export const PLAN_POINTER_FILENAME = "plan-current.json";
export const COMPLETION_SCHEMA = "kxm.assignment-completion.v1";
export const VERIFY_WITNESS_ID = "verify";
export const WITNESS_IDS = Object.freeze(["verify", "validate-ci"]);
export const ASSIGNMENT_KINDS = Object.freeze([
  "plan",
  "implement",
  "repair",
  "review-arch",
  "review-cli",
]);
export const KIND_ROLES = Object.freeze({
  plan: "planner",
  implement: "writer",
  repair: "writer",
  "review-arch": "reviewer-arch",
  "review-cli": "reviewer-cli",
});
export const REVIEW_KINDS = Object.freeze(["review-arch", "review-cli"]);
export const WRITER_KINDS = Object.freeze(["implement", "repair"]);
export const CLEAN_BASE_KINDS = Object.freeze(["plan", "implement", "repair"]);

const ASSIGNMENT_KEYS = Object.freeze([
  "schema",
  "task_id",
  "assignment_id",
  "rework_of",
  "kind",
  "harness",
  "model",
  "effort",
  "permission",
  "cwd",
  "task_dir",
  "base",
  "plan_ref",
  "inputs",
  "contract",
  "output_dir",
  "timeout_ms",
  "max_turns",
]);
const OPTIONAL_ASSIGNMENT_KEYS = Object.freeze(["rework_of", "timeout_ms", "max_turns"]);
const BASE_KINDS = Object.freeze(["clean", "staged"]);
const PLAN_REF_KINDS = Object.freeze(["current", "bootstrap"]);
const POINTER_KEYS = Object.freeze([
  "schema",
  "task_id",
  "generation",
  "plan_path",
  "plan_sha256",
  "base_commit",
  "settled_decisions",
  "updated_at",
  "supersedes",
]);
const SUPERSEDES_KEYS = Object.freeze([
  "generation",
  "plan_path",
  "plan_sha256",
  "base_commit",
  "updated_at",
]);
const COMPLETION_LINK_KEYS = Object.freeze(["schema", "assignment_id", "task_id"]);
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STAGED_INDEX_STATES = new Set(["M", "A", "D", "T"]);
const UNMERGED_XY = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function failClosed(message, stage = "preflight") {
  const error = new Error(message);
  error.failClosed = true;
  error.stage = stage;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function closedObject(value, keys, label, optional = []) {
  if (!isPlainObject(value)) {
    throw failClosed(`${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw failClosed(`unknown ${label} field(s) ${unknown.join(", ")}`);
  }
  for (const key of keys) {
    if (value[key] === undefined && !optional.includes(key)) {
      throw failClosed(`${label}.${key} is required`);
    }
  }
  return value;
}

function requireNonemptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw failClosed(`${label} is required as a nonempty string`);
  }
  return value;
}

function requireIdentity(value, label) {
  const id = requireNonemptyString(value, label);
  if (!IDENTITY.test(id)) {
    throw failClosed(`${label} must be a stable identity token`);
  }
  return id;
}

function requireHex(value, label, pattern) {
  const hex = requireNonemptyString(value, label);
  if (!pattern.test(hex)) {
    throw failClosed(`${label} must be a lowercase hex digest`);
  }
  return hex;
}

function requireStringArray(value, label) {
  if (!Array.isArray(value)) {
    throw failClosed(`${label} must be an array of strings`);
  }
  if (value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw failClosed(`${label} entries must be nonempty strings`);
  }
  return value;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitArgv(cwd, args) {
  return ["--no-optional-locks", "-C", cwd, ...args];
}

function runGit(cwd, args, spawnSyncImpl, { trim = true } = {}) {
  const argv = gitArgv(cwd, args);
  const result = spawnSyncImpl("git", argv, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    throw failClosed(`git ${args[0]} failed: ${result.error.message}`);
  }
  const stdout = String(result.stdout ?? "");
  return { result, stdout: trim ? stdout.trim() : stdout, argv };
}

function git(cwd, args, spawnSyncImpl) {
  const { result, stdout } = runGit(cwd, args, spawnSyncImpl);
  if (result.status !== 0) {
    const detail = String(result.stderr ?? result.stdout ?? "").trim() || `exit ${result.status}`;
    throw failClosed(`git ${args[0]} failed: ${detail}`);
  }
  return stdout;
}

function gitStatusZ(cwd, spawnSyncImpl) {
  const { result, stdout } = runGit(
    cwd,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
    spawnSyncImpl,
    { trim: false },
  );
  if (result.status !== 0) {
    const detail = String(result.stderr ?? result.stdout ?? "").trim() || `exit ${result.status}`;
    throw failClosed(`git status failed: ${detail}`);
  }
  return parsePorcelainZ(stdout);
}

function parsePorcelainZ(stdout) {
  if (stdout.length === 0) return [];
  const chunks = stdout.split("\0");
  if (chunks[chunks.length - 1] === "") chunks.pop();
  const records = [];
  for (const record of chunks) {
    if (record.length < 3 || record[2] !== " ") {
      throw failClosed("git status produced a malformed NUL record");
    }
    records.push({ x: record[0], y: record[1], path: record.slice(3) });
  }
  return records;
}

function gitDiffIndex(cwd, tree, spawnSyncImpl) {
  const { result } = runGit(cwd, ["diff-index", "--cached", "--quiet", tree], spawnSyncImpl);
  if (result.error) {
    throw failClosed(`git diff-index failed: ${result.error.message}`);
  }
  if (result.status === 0) return "equal";
  if (result.status === 1) return "differ";
  const detail = String(result.stderr ?? result.stdout ?? "").trim() || `exit ${result.status}`;
  throw failClosed(`git diff-index failed: ${detail}`);
}

function samePath(left, right, realpathImpl) {
  const resolveExisting = (target) => {
    try {
      return realpathImpl(target);
    } catch {
      return resolvePath(target);
    }
  };
  return resolveExisting(left) === resolveExisting(right);
}

function readRegularFile(path, readImpl, existsImpl, statImpl) {
  if (!existsImpl(path)) {
    throw failClosed(`missing path ${path}`);
  }
  let stat;
  try {
    stat = statImpl(path);
  } catch {
    throw failClosed(`unreadable path ${path}`);
  }
  if (!stat.isFile()) {
    throw failClosed(`${path} is not a regular file`);
  }
  try {
    return readImpl(path);
  } catch {
    throw failClosed(`unreadable path ${path}`);
  }
}

function recordXy(record) {
  return `${record.x}${record.y}`;
}

function isUnmergedRecord(record) {
  return UNMERGED_XY.has(recordXy(record)) || record.x === "U" || record.y === "U";
}

function inspectWorktree(cwd, spawnSyncImpl, realpathImpl) {
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"], spawnSyncImpl);
  if (inside !== "true") {
    throw failClosed(`cwd is not a git worktree: ${cwd}`);
  }
  const toplevel = git(cwd, ["rev-parse", "--show-toplevel"], spawnSyncImpl);
  if (!samePath(toplevel, cwd, realpathImpl)) {
    throw failClosed("cwd must be the git worktree root");
  }
  const head = git(cwd, ["rev-parse", "HEAD"], spawnSyncImpl);
  const headTree = git(cwd, ["rev-parse", "HEAD^{tree}"], spawnSyncImpl);
  const statusRecords = gitStatusZ(cwd, spawnSyncImpl);
  const clean = statusRecords.every((record) => record.y === " ");
  return { head, headTree, statusRecords, clean };
}

function refuseDirtyStatus(records) {
  if (records.some(isUnmergedRecord)) {
    throw failClosed("index has unmerged paths");
  }
  throw failClosed("worktree has unstaged tracked edits or unignored untracked files");
}

function parseJsonFile(path, bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw failClosed(`${label} is malformed JSON: ${path}`);
  }
}

function validatePointer(pointer) {
  closedObject(pointer, POINTER_KEYS, "plan pointer");
  if (pointer.schema !== PLAN_POINTER_SCHEMA) {
    throw failClosed(`plan pointer schema must be ${PLAN_POINTER_SCHEMA}, got ${pointer.schema ?? "none"}`);
  }
  requireIdentity(pointer.task_id, "plan pointer.task_id");
  if (!Number.isInteger(pointer.generation) || pointer.generation < 1) {
    throw failClosed("plan pointer.generation must be a positive integer");
  }
  requireNonemptyString(pointer.plan_path, "plan pointer.plan_path");
  requireHex(pointer.plan_sha256, "plan pointer.plan_sha256", HEX64);
  requireHex(pointer.base_commit, "plan pointer.base_commit", HEX40);
  requireStringArray(pointer.settled_decisions, "plan pointer.settled_decisions");
  requireNonemptyString(pointer.updated_at, "plan pointer.updated_at");
  if (!Array.isArray(pointer.supersedes)) {
    throw failClosed("plan pointer.supersedes must be an array");
  }
  for (const [index, entry] of pointer.supersedes.entries()) {
    closedObject(entry, SUPERSEDES_KEYS, `plan pointer.supersedes[${index}]`);
    if (!Number.isInteger(entry.generation) || entry.generation < 1) {
      throw failClosed(`plan pointer.supersedes[${index}].generation must be a positive integer`);
    }
    requireNonemptyString(entry.plan_path, `plan pointer.supersedes[${index}].plan_path`);
    requireHex(entry.plan_sha256, `plan pointer.supersedes[${index}].plan_sha256`, HEX64);
    requireHex(entry.base_commit, `plan pointer.supersedes[${index}].base_commit`, HEX40);
    requireNonemptyString(entry.updated_at, `plan pointer.supersedes[${index}].updated_at`);
  }
  return pointer;
}

function pointerPathFor(taskDir) {
  return join(taskDir, PLAN_POINTER_FILENAME);
}

function assignmentRecordDir(taskDir, assignmentId) {
  return join(taskDir, assignmentId);
}

function validateTaskDir(taskDirValue, taskId, existsImpl, statImpl, realpathImpl) {
  const taskDir = requireNonemptyString(taskDirValue, "task_dir");
  if (!nodePath.isAbsolute(taskDir)) {
    throw failClosed("task_dir must be an absolute path");
  }
  if (!existsImpl(taskDir)) {
    throw failClosed(`task_dir does not exist: ${taskDir}`);
  }
  let stat;
  try {
    stat = statImpl(taskDir);
  } catch {
    throw failClosed(`task_dir is not a directory: ${taskDir}`);
  }
  if (!stat.isDirectory()) {
    throw failClosed(`task_dir is not a directory: ${taskDir}`);
  }
  if (basename(taskDir) !== taskId) {
    throw failClosed("task_dir final segment must equal task_id");
  }
  try {
    return realpathImpl(taskDir);
  } catch {
    throw failClosed(`task_dir is not a directory: ${taskDir}`);
  }
}

function validateCurrentPlanRef(planRef, taskDir, taskId, deps) {
  closedObject(planRef, ["kind", "path", "sha256"], "plan_ref");
  const planPath = resolvePath(taskDir, requireNonemptyString(planRef.path, "plan_ref.path"));
  const claimed = requireHex(planRef.sha256, "plan_ref.sha256", HEX64);
  const pointerPath = pointerPathFor(taskDir);
  const pointerBytes = readRegularFile(pointerPath, deps.readFileSync, deps.existsSync, deps.statSync);
  const pointer = validatePointer(parseJsonFile(pointerPath, pointerBytes, "plan pointer"));
  if (pointer.task_id !== taskId) {
    throw failClosed("current plan pointer task_id does not match assignment task_id");
  }
  const pointerPlanPath = resolvePath(taskDir, pointer.plan_path);
  if (!samePath(pointerPlanPath, planPath, deps.realpathSync)) {
    throw failClosed("current plan_ref.path does not match plan-current.json plan_path");
  }
  if (pointer.plan_sha256 !== claimed) {
    throw failClosed("plan_ref.sha256 does not match the current plan pointer");
  }
  const planBytes = readRegularFile(planPath, deps.readFileSync, deps.existsSync, deps.statSync);
  const actual = sha256Bytes(planBytes);
  if (actual !== claimed) {
    throw failClosed("plan file content does not match plan_ref.sha256");
  }
  return Object.freeze({
    kind: "current",
    path: planPath,
    sha256: claimed,
    pointer_path: pointerPath,
    generation: pointer.generation,
  });
}

function validateBootstrapPlanRef(planRef, taskDir, kind, deps) {
  closedObject(planRef, ["kind", "reason"], "plan_ref");
  if (!["plan", "review-arch", "review-cli"].includes(kind)) {
    throw failClosed("bootstrap plan_ref is only allowed for plan or review when no pointer exists");
  }
  requireNonemptyString(planRef.reason, "plan_ref.reason");
  const pointerPath = pointerPathFor(taskDir);
  try {
    deps.lstatSync(pointerPath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return Object.freeze({
        kind: "bootstrap",
        reason: planRef.reason,
      });
    }
    const code = error && error.code ? error.code : "unknown";
    throw failClosed(`bootstrap plan_ref cannot inspect ${PLAN_POINTER_FILENAME}: ${code}`);
  }
  throw failClosed("bootstrap plan_ref is invalid because a current plan pointer already exists");
}

function validateBase(base, kind, gitState, spawnSyncImpl, cwd) {
  closedObject(base, ["kind", "commit", "index_tree"], "base", ["index_tree"]);
  if (!BASE_KINDS.includes(base.kind)) {
    throw failClosed(`unknown base.kind ${base.kind}`);
  }
  const commit = requireHex(base.commit, "base.commit", HEX40);
  if (gitState.head !== commit) {
    throw failClosed("base.commit does not match HEAD");
  }
  if (base.kind === "clean") {
    if (base.index_tree !== undefined) {
      throw failClosed("clean base does not accept index_tree");
    }
    if (gitState.statusRecords.length > 0) {
      refuseDirtyStatus(gitState.statusRecords);
    }
    if (gitDiffIndex(cwd, gitState.headTree, spawnSyncImpl) !== "equal") {
      throw failClosed("clean baseline requires the index tree to equal HEAD");
    }
    return {
      base: Object.freeze({ kind: "clean", commit }),
      indexTree: gitState.headTree,
    };
  }
  if (!REVIEW_KINDS.includes(kind)) {
    throw failClosed("only reviews may target a staged index");
  }
  const indexTree = requireHex(base.index_tree, "base.index_tree", HEX40);
  for (const record of gitState.statusRecords) {
    if (isUnmergedRecord(record) || record.y !== " " || !STAGED_INDEX_STATES.has(record.x)) {
      refuseDirtyStatus(gitState.statusRecords);
    }
  }
  const objectType = git(cwd, ["cat-file", "-t", indexTree], spawnSyncImpl);
  if (objectType !== "tree") {
    throw failClosed(`base.index_tree must name a tree object, got ${objectType}`);
  }
  if (gitDiffIndex(cwd, indexTree, spawnSyncImpl) !== "equal") {
    throw failClosed("base.index_tree does not match the current index");
  }
  return {
    base: Object.freeze({ kind: "staged", commit, index_tree: indexTree }),
    indexTree,
  };
}

function validateContract(contract, kind) {
  closedObject(contract, ["boundary", "deliverables", "witness", "deferred"], "contract");
  const boundary = requireNonemptyString(contract.boundary, "contract.boundary");
  const deliverables = requireStringArray(contract.deliverables, "contract.deliverables");
  const deferred = requireStringArray(contract.deferred, "contract.deferred");
  closedObject(contract.witness, ["id"], "contract.witness");
  const witnessId = requireNonemptyString(contract.witness.id, "contract.witness.id");
  if (!WITNESS_IDS.includes(witnessId)) {
    throw failClosed(`unknown contract.witness.id ${witnessId}; expected ${WITNESS_IDS.join(" or ")}`);
  }
  if (WRITER_KINDS.includes(kind)) {
    if (deliverables.length < 1) {
      throw failClosed("implement and repair require at least one deliverable");
    }
    if (witnessId !== VERIFY_WITNESS_ID) {
      throw failClosed("implement and repair require the fixed verify witness");
    }
  }
  return Object.freeze({
    boundary,
    deliverables: Object.freeze([...deliverables]),
    witness: Object.freeze({ id: witnessId }),
    deferred: Object.freeze([...deferred]),
  });
}

function validateInputs(inputs, cwd, deps) {
  if (!Array.isArray(inputs)) {
    throw failClosed("inputs must be an array");
  }
  const resolved = [];
  for (const [index, item] of inputs.entries()) {
    closedObject(item, ["path", "sha256"], `inputs[${index}]`);
    const path = resolvePath(cwd, requireNonemptyString(item.path, `inputs[${index}].path`));
    const claimed = requireHex(item.sha256, `inputs[${index}].sha256`, HEX64);
    const bytes = readRegularFile(path, deps.readFileSync, deps.existsSync, deps.statSync);
    const actual = sha256Bytes(bytes);
    if (actual !== claimed) {
      throw failClosed(`inputs[${index}] content does not match sha256`);
    }
    resolved.push(Object.freeze({ path, sha256: claimed }));
  }
  return Object.freeze(resolved);
}

function validateRework(reworkOf, taskDir, taskId, assignmentId, deps) {
  if (reworkOf === undefined) return undefined;
  const priorId = requireIdentity(reworkOf, "rework_of");
  if (priorId === assignmentId) {
    throw failClosed("rework_of cannot reference the same assignment_id");
  }
  const completionPath = join(assignmentRecordDir(taskDir, priorId), "completion.json");
  if (!deps.existsSync(completionPath)) {
    throw failClosed(`rework_of ${priorId} does not point at an existing completion`);
  }
  const bytes = readRegularFile(completionPath, deps.readFileSync, deps.existsSync, deps.statSync);
  const completion = parseJsonFile(completionPath, bytes, "rework completion");
  if (!isPlainObject(completion)) {
    throw failClosed("rework completion is malformed");
  }
  for (const key of COMPLETION_LINK_KEYS) {
    if (completion[key] === undefined) {
      throw failClosed(`rework completion missing ${key}`);
    }
  }
  if (completion.schema !== COMPLETION_SCHEMA) {
    throw failClosed(`rework completion schema must be ${COMPLETION_SCHEMA}`);
  }
  if (completion.assignment_id !== priorId) {
    throw failClosed("rework completion assignment_id does not match rework_of");
  }
  if (completion.task_id !== taskId) {
    throw failClosed("rework completion task_id does not match assignment task_id");
  }
  return priorId;
}

function validateRoute(manifest) {
  const role = KIND_ROLES[manifest.kind];
  if (!role) {
    throw failClosed(`unknown kind ${manifest.kind}`);
  }
  const effort = requireNonemptyString(manifest.effort, "effort");
  if (!EFFORT.includes(effort)) {
    throw failClosed(`unknown effort ${effort}; expected one of ${EFFORT.join(", ")}`);
  }
  const request = {
    schema: REQUEST_SCHEMA,
    harness: manifest.harness,
    role,
    model: manifest.model,
    permission: manifest.permission,
    effort,
    prompt_file: ASSIGNMENT_SCHEMA,
  };
  if (manifest.timeout_ms !== undefined) request.timeout_ms = manifest.timeout_ms;
  if (manifest.max_turns !== undefined) request.max_turns = manifest.max_turns;
  const route = preflightRequest(request);
  if (!route.efforts.includes(effort)) {
    throw failClosed(`${manifest.harness} does not accept effort ${effort}; allowed: ${route.efforts.join(", ")}`);
  }
  return { role, route, effort };
}

export function validateAssignmentManifest(manifest, deps = {}) {
  const spawnSyncImpl = deps.spawnSync ?? spawnSync;
  const exists = deps.existsSync ?? existsSync;
  const read = deps.readFileSync ?? readFileSync;
  const realpathImpl = deps.realpathSync ?? realpathSync;
  const lstatImpl = deps.lstatSync ?? lstatSync;
  const statImpl = deps.statSync ?? statSync;
  const io = {
    existsSync: exists,
    readFileSync: read,
    realpathSync: realpathImpl,
    lstatSync: lstatImpl,
    statSync: statImpl,
  };

  closedObject(manifest, ASSIGNMENT_KEYS, "assignment", OPTIONAL_ASSIGNMENT_KEYS);
  if (manifest.schema !== ASSIGNMENT_SCHEMA) {
    throw failClosed(`assignment schema must be ${ASSIGNMENT_SCHEMA}, got ${manifest.schema ?? "none"}`);
  }
  const taskId = requireIdentity(manifest.task_id, "task_id");
  const assignmentId = requireIdentity(manifest.assignment_id, "assignment_id");
  if (!ASSIGNMENT_KINDS.includes(manifest.kind)) {
    throw failClosed(`unknown kind ${manifest.kind}; expected ${ASSIGNMENT_KINDS.join(", ")}`);
  }
  const cwd = resolvePath(requireNonemptyString(manifest.cwd, "cwd"));
  if (!exists(cwd)) {
    throw failClosed(`cwd does not exist: ${cwd}`);
  }
  const taskDir = validateTaskDir(manifest.task_dir, taskId, exists, statImpl, realpathImpl);
  const { role, effort } = validateRoute(manifest);
  const gitState = inspectWorktree(cwd, spawnSyncImpl, realpathImpl);
  const proven = validateBase(manifest.base, manifest.kind, gitState, spawnSyncImpl, cwd);
  if (!isPlainObject(manifest.plan_ref) || !PLAN_REF_KINDS.includes(manifest.plan_ref.kind)) {
    throw failClosed(`plan_ref.kind must be ${PLAN_REF_KINDS.join(" or ")}`);
  }
  const planRef = manifest.plan_ref.kind === "current"
    ? validateCurrentPlanRef(manifest.plan_ref, taskDir, taskId, io)
    : validateBootstrapPlanRef(manifest.plan_ref, taskDir, manifest.kind, io);
  const inputs = validateInputs(manifest.inputs, cwd, io);
  const contract = validateContract(manifest.contract, manifest.kind);
  const outputDir = resolvePath(taskDir, requireNonemptyString(manifest.output_dir, "output_dir"));
  const identityDir = assignmentRecordDir(taskDir, assignmentId);
  if (exists(identityDir)) {
    throw failClosed(`assignment_id ${assignmentId} is already present`);
  }
  if (exists(outputDir)) {
    throw failClosed(`output_dir already exists: ${outputDir}`);
  }
  const reworkOf = validateRework(manifest.rework_of, taskDir, taskId, assignmentId, io);

  const validated = {
    schema: ASSIGNMENT_SCHEMA,
    task_id: taskId,
    assignment_id: assignmentId,
    kind: manifest.kind,
    role,
    harness: manifest.harness,
    model: manifest.model,
    effort,
    permission: manifest.permission,
    cwd,
    task_dir: taskDir,
    base: proven.base,
    plan_ref: planRef,
    inputs,
    contract,
    output_dir: outputDir,
    git: Object.freeze({
      head: gitState.head,
      index_tree: proven.indexTree,
      clean: gitState.clean,
    }),
  };
  if (reworkOf !== undefined) validated.rework_of = reworkOf;
  if (manifest.timeout_ms !== undefined) validated.timeout_ms = manifest.timeout_ms;
  if (manifest.max_turns !== undefined) validated.max_turns = manifest.max_turns;
  return Object.freeze(validated);
}

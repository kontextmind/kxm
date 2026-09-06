#!/usr/bin/env node
// Dev assignment helper. M3a is exported pure validation: no spawn, identity
// consumption, dispatch, or .git writes. M3b adds role templates, exclusive
// identity/output consume, one-shot v2 harness dispatch, immutable completion,
// and one pending telemetry append. Not a product assignment layer.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import {
  BEHAVIORAL_HASH_VERSION,
  ROUTING_RECORD_SCHEMA,
  agentWorker,
  behavioralConfigHash,
  nowIso,
  parseRoutingRecord,
  workerResult,
} from "../plugins/kxm/dist/core.js";
import {
  CONTEXT_OCCUPANCY_UNKNOWN,
  COST_BASIS,
  EFFORT,
  ERROR_CODES,
  MODEL_CLAIM_STATUSES,
  REQUEST_SCHEMA,
  RESULT_SCHEMA,
  REVIEW_VERDICTS,
  TOKEN_BASIS,
  TRANSPORT_STAGES,
  TRANSPORT_STATUSES,
  CLAIM_SOURCES,
  preflightRequest,
  runHarness,
} from "./harness-run.mjs";

const resolvePath = nodePath.resolve;
const { join, basename, dirname, relative } = nodePath;

export const ASSIGNMENT_SCHEMA = "kxm.assignment.v1";
export const PLAN_POINTER_SCHEMA = "kxm.plan-pointer.v1";
export const PLAN_POINTER_FILENAME = "plan-current.json";
export const COMPLETION_SCHEMA = "kxm.assignment-completion.v1";
export const REFUSAL_SCHEMA = "kxm.assignment-refusal.v1";
export const RUNNER_CODES = Object.freeze([
  "manifest_invalid",
  "route_invalid",
  "base_invalid",
  "plan_ref_invalid",
  "inputs_invalid",
  "contract_invalid",
  "rework_invalid",
  "output_dir_unsafe",
  "output_dir_exists",
  "identity_taken",
  "output_dir_taken",
  "mkdir_failed",
  "prompt_render_failed",
  "record_write_failed",
  "snapshot_failed",
  "sidecar_failed",
  "routing_record_failed",
  "telemetry_failed",
  "unknown",
]);
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
export const ASSIGNMENT_DISPATCH_SCHEMA = "kxm.assignment-dispatch.v1";
export const TELEMETRY_SCHEMA = "kxm.telemetry.v1";
export const RECORDING_RESOLUTION_SCHEMA = "kxm.assignment-recording-resolution.v1";
export const READ_MECHANISMS = Object.freeze({
  claude: "Use only the Read, Glob, and Grep tools. Do not use the shell.",
  codex: "You run in a read-only sandbox. Read-only shell inspection with cat, sed, rg, and git is allowed. Do not write files, update the index, or commit.",
  grok: "Use repository tools. Do not use subagents or web search. The candidate cwd is an instruction, not an OS sandbox claim.",
  pi: "Use only the read, grep, find, and ls tools. This helper is not a long-lived native worker.",
});

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

function failClosed(message, code = "unknown") {
  const error = new Error(message);
  error.failClosed = true;
  error.runnerCode = RUNNER_CODES.includes(code) ? code : "unknown";
  return error;
}

function lstatOrNull(path, lstatImpl) {
  try {
    return lstatImpl(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw failClosed(`cannot lstat path: ${error?.code ?? "unknown"}`, "unknown");
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function closedObject(value, keys, label, optional = [], code = "manifest_invalid") {
  if (!isPlainObject(value)) {
    throw failClosed(`${label} must be an object`, code);
  }
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw failClosed(`unknown ${label} field(s) ${unknown.join(", ")}`, code);
  }
  for (const key of keys) {
    if (value[key] === undefined && !optional.includes(key)) {
      throw failClosed(`${label}.${key} is required`, code);
    }
  }
  return value;
}

function requireNonemptyString(value, label, code = "manifest_invalid") {
  if (typeof value !== "string" || value.trim() === "") {
    throw failClosed(`${label} is required as a nonempty string`, code);
  }
  return value;
}

function requireIdentity(value, label, code = "manifest_invalid") {
  const id = requireNonemptyString(value, label, code);
  if (!IDENTITY.test(id)) {
    throw failClosed(`${label} must be a stable identity token`, code);
  }
  return id;
}

function requireHex(value, label, pattern, code = "manifest_invalid") {
  const hex = requireNonemptyString(value, label, code);
  if (!pattern.test(hex)) {
    throw failClosed(`${label} must be a lowercase hex digest`, code);
  }
  return hex;
}

function requireStringArray(value, label, code = "manifest_invalid") {
  if (!Array.isArray(value)) {
    throw failClosed(`${label} must be an array of strings`, code);
  }
  if (value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw failClosed(`${label} entries must be nonempty strings`, code);
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
    throw failClosed(`git ${args[0]} failed: ${result.error.message}`, "base_invalid");
  }
  const stdout = String(result.stdout ?? "");
  return { result, stdout: trim ? stdout.trim() : stdout, argv };
}

function git(cwd, args, spawnSyncImpl) {
  const { result, stdout } = runGit(cwd, args, spawnSyncImpl);
  if (result.status !== 0) {
    const detail = String(result.stderr ?? result.stdout ?? "").trim() || `exit ${result.status}`;
    throw failClosed(`git ${args[0]} failed: ${detail}`, "base_invalid");
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
    throw failClosed(`git status failed: ${detail}`, "base_invalid");
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
      throw failClosed("git status produced a malformed NUL record", "base_invalid");
    }
    records.push({ x: record[0], y: record[1], path: record.slice(3) });
  }
  return records;
}

function gitDiffIndex(cwd, tree, spawnSyncImpl) {
  const { result } = runGit(cwd, ["diff-index", "--cached", "--quiet", tree], spawnSyncImpl);
  if (result.error) {
    throw failClosed(`git diff-index failed: ${result.error.message}`, "base_invalid");
  }
  if (result.status === 0) return "equal";
  if (result.status === 1) return "differ";
  const detail = String(result.stderr ?? result.stdout ?? "").trim() || `exit ${result.status}`;
  throw failClosed(`git diff-index failed: ${detail}`, "base_invalid");
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

function deepestExistingAncestor(target, lstatImpl) {
  let current = resolvePath(target);
  for (;;) {
    if (lstatOrNull(current, lstatImpl)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function realpathOrUnknown(path, realpathImpl) {
  try {
    return realpathImpl(path);
  } catch (error) {
    throw failClosed(`cannot realpath existing ancestor: ${error?.code ?? "unknown"}`, "unknown");
  }
}

function comparablePath(target, realpathImpl, lstatImpl) {
  const resolved = resolvePath(target);
  let ancestor = deepestExistingAncestor(resolved, lstatImpl);
  let realAncestor;
  try {
    realAncestor = realpathImpl(ancestor);
  } catch (error) {
    // A dangling final entry is known to exist via lstat. Compare through the
    // parent so existence can still be output_dir_exists. Parent lstat/realpath
    // uncertainty stays unknown.
    if (ancestor !== resolved) {
      throw failClosed(`cannot realpath existing ancestor: ${error?.code ?? "unknown"}`, "unknown");
    }
    const parent = dirname(resolved);
    if (parent === resolved) {
      throw failClosed(`cannot realpath existing ancestor: ${error?.code ?? "unknown"}`, "unknown");
    }
    ancestor = deepestExistingAncestor(parent, lstatImpl);
    realAncestor = realpathOrUnknown(ancestor, realpathImpl);
  }
  if (resolved === ancestor) return realAncestor;
  return resolvePath(realAncestor, relative(ancestor, resolved));
}

function isStrictAncestor(ancestor, path) {
  const rel = relative(ancestor, path);
  if (rel === "" || nodePath.isAbsolute(rel)) return false;
  const parts = rel.split(nodePath.sep);
  return parts.length > 0 && parts.every((part) => part !== "..");
}

function isSameOrDescendant(root, path) {
  return path === root || isStrictAncestor(root, path);
}

function validateOutputDir(outputDir, taskDir, recordDir, cwd, lstatImpl, realpathImpl) {
  const out = comparablePath(outputDir, realpathImpl, lstatImpl);
  const task = comparablePath(taskDir, realpathImpl, lstatImpl);
  const record = comparablePath(recordDir, realpathImpl, lstatImpl);
  const gitDir = comparablePath(join(cwd, ".git"), realpathImpl, lstatImpl);
  if (out === task || isStrictAncestor(out, task)) {
    throw failClosed(`output_dir is unsafe: protected namespace ${outputDir}`, "output_dir_unsafe");
  }
  if (isStrictAncestor(task, out) && out !== record && !isStrictAncestor(record, out)) {
    throw failClosed(`output_dir is unsafe: protected namespace ${outputDir}`, "output_dir_unsafe");
  }
  if (isSameOrDescendant(gitDir, out)) {
    throw failClosed(`output_dir is unsafe: protected namespace ${outputDir}`, "output_dir_unsafe");
  }
  if (lstatOrNull(outputDir, lstatImpl)) {
    throw failClosed(`output_dir already exists: ${outputDir}`, "output_dir_exists");
  }
  return { out, record };
}

function readRegularFile(path, readImpl, existsImpl, statImpl, code = "manifest_invalid") {
  if (!existsImpl(path)) {
    throw failClosed(`missing path ${path}`, code);
  }
  let stat;
  try {
    stat = statImpl(path);
  } catch {
    throw failClosed(`unreadable path ${path}`, code);
  }
  if (!stat.isFile()) {
    throw failClosed(`${path} is not a regular file`, code);
  }
  try {
    return readImpl(path);
  } catch {
    throw failClosed(`unreadable path ${path}`, code);
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
    throw failClosed(`cwd is not a git worktree: ${cwd}`, "base_invalid");
  }
  const toplevel = git(cwd, ["rev-parse", "--show-toplevel"], spawnSyncImpl);
  if (!samePath(toplevel, cwd, realpathImpl)) {
    throw failClosed("cwd must be the git worktree root", "base_invalid");
  }
  const head = git(cwd, ["rev-parse", "HEAD"], spawnSyncImpl);
  const headTree = git(cwd, ["rev-parse", "HEAD^{tree}"], spawnSyncImpl);
  const statusRecords = gitStatusZ(cwd, spawnSyncImpl);
  const clean = statusRecords.every((record) => record.y === " ");
  return { head, headTree, statusRecords, clean };
}

function refuseDirtyStatus(records) {
  if (records.some(isUnmergedRecord)) {
    throw failClosed("index has unmerged paths", "base_invalid");
  }
  throw failClosed("worktree has unstaged tracked edits or unignored untracked files", "base_invalid");
}

function parseJsonFile(path, bytes, label, code = "manifest_invalid") {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw failClosed(`${label} is malformed JSON: ${path}`, code);
  }
}

function validatePointer(pointer) {
  closedObject(pointer, POINTER_KEYS, "plan pointer", [], "plan_ref_invalid");
  if (pointer.schema !== PLAN_POINTER_SCHEMA) {
    throw failClosed(`plan pointer schema must be ${PLAN_POINTER_SCHEMA}, got ${pointer.schema ?? "none"}`, "plan_ref_invalid");
  }
  requireIdentity(pointer.task_id, "plan pointer.task_id", "plan_ref_invalid");
  if (!Number.isInteger(pointer.generation) || pointer.generation < 1) {
    throw failClosed("plan pointer.generation must be a positive integer", "plan_ref_invalid");
  }
  requireNonemptyString(pointer.plan_path, "plan pointer.plan_path", "plan_ref_invalid");
  requireHex(pointer.plan_sha256, "plan pointer.plan_sha256", HEX64, "plan_ref_invalid");
  requireHex(pointer.base_commit, "plan pointer.base_commit", HEX40, "plan_ref_invalid");
  requireStringArray(pointer.settled_decisions, "plan pointer.settled_decisions", "plan_ref_invalid");
  requireNonemptyString(pointer.updated_at, "plan pointer.updated_at", "plan_ref_invalid");
  if (!Array.isArray(pointer.supersedes)) {
    throw failClosed("plan pointer.supersedes must be an array", "plan_ref_invalid");
  }
  for (const [index, entry] of pointer.supersedes.entries()) {
    closedObject(entry, SUPERSEDES_KEYS, `plan pointer.supersedes[${index}]`, [], "plan_ref_invalid");
    if (!Number.isInteger(entry.generation) || entry.generation < 1) {
      throw failClosed(`plan pointer.supersedes[${index}].generation must be a positive integer`, "plan_ref_invalid");
    }
    requireNonemptyString(entry.plan_path, `plan pointer.supersedes[${index}].plan_path`, "plan_ref_invalid");
    requireHex(entry.plan_sha256, `plan pointer.supersedes[${index}].plan_sha256`, HEX64, "plan_ref_invalid");
    requireHex(entry.base_commit, `plan pointer.supersedes[${index}].base_commit`, HEX40, "plan_ref_invalid");
    requireNonemptyString(entry.updated_at, `plan pointer.supersedes[${index}].updated_at`, "plan_ref_invalid");
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
    throw failClosed("task_dir must be an absolute path", "manifest_invalid");
  }
  if (!existsImpl(taskDir)) {
    throw failClosed(`task_dir does not exist: ${taskDir}`, "manifest_invalid");
  }
  let stat;
  try {
    stat = statImpl(taskDir);
  } catch {
    throw failClosed(`task_dir is not a directory: ${taskDir}`, "manifest_invalid");
  }
  if (!stat.isDirectory()) {
    throw failClosed(`task_dir is not a directory: ${taskDir}`, "manifest_invalid");
  }
  if (basename(taskDir) !== taskId) {
    throw failClosed("task_dir final segment must equal task_id", "manifest_invalid");
  }
  try {
    return realpathImpl(taskDir);
  } catch {
    throw failClosed(`task_dir is not a directory: ${taskDir}`, "manifest_invalid");
  }
}

function validateCurrentPlanRef(planRef, taskDir, taskId, deps) {
  closedObject(planRef, ["kind", "path", "sha256"], "plan_ref", [], "plan_ref_invalid");
  const planPath = resolvePath(taskDir, requireNonemptyString(planRef.path, "plan_ref.path", "plan_ref_invalid"));
  const claimed = requireHex(planRef.sha256, "plan_ref.sha256", HEX64, "plan_ref_invalid");
  const pointerPath = pointerPathFor(taskDir);
  const pointerBytes = readRegularFile(pointerPath, deps.readFileSync, deps.existsSync, deps.statSync, "plan_ref_invalid");
  const pointer = validatePointer(parseJsonFile(pointerPath, pointerBytes, "plan pointer", "plan_ref_invalid"));
  if (pointer.task_id !== taskId) {
    throw failClosed("current plan pointer task_id does not match assignment task_id", "plan_ref_invalid");
  }
  const pointerPlanPath = resolvePath(taskDir, pointer.plan_path);
  if (!samePath(pointerPlanPath, planPath, deps.realpathSync)) {
    throw failClosed("current plan_ref.path does not match plan-current.json plan_path", "plan_ref_invalid");
  }
  if (pointer.plan_sha256 !== claimed) {
    throw failClosed("plan_ref.sha256 does not match the current plan pointer", "plan_ref_invalid");
  }
  const planBytes = readRegularFile(planPath, deps.readFileSync, deps.existsSync, deps.statSync, "plan_ref_invalid");
  const actual = sha256Bytes(planBytes);
  if (actual !== claimed) {
    throw failClosed("plan file content does not match plan_ref.sha256", "plan_ref_invalid");
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
  closedObject(planRef, ["kind", "reason"], "plan_ref", [], "plan_ref_invalid");
  if (!["plan", "review-arch", "review-cli"].includes(kind)) {
    throw failClosed("bootstrap plan_ref is only allowed for plan or review when no pointer exists", "plan_ref_invalid");
  }
  requireNonemptyString(planRef.reason, "plan_ref.reason", "plan_ref_invalid");
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
    throw failClosed(`bootstrap plan_ref cannot inspect ${PLAN_POINTER_FILENAME}: ${code}`, "plan_ref_invalid");
  }
  throw failClosed("bootstrap plan_ref is invalid because a current plan pointer already exists", "plan_ref_invalid");
}

function validateBase(base, kind, gitState, spawnSyncImpl, cwd) {
  closedObject(base, ["kind", "commit", "index_tree"], "base", ["index_tree"], "base_invalid");
  if (!BASE_KINDS.includes(base.kind)) {
    throw failClosed(`unknown base.kind ${base.kind}`, "base_invalid");
  }
  const commit = requireHex(base.commit, "base.commit", HEX40, "base_invalid");
  if (gitState.head !== commit) {
    throw failClosed("base.commit does not match HEAD", "base_invalid");
  }
  if (base.kind === "clean") {
    if (base.index_tree !== undefined) {
      throw failClosed("clean base does not accept index_tree", "base_invalid");
    }
    if (gitState.statusRecords.length > 0) {
      refuseDirtyStatus(gitState.statusRecords);
    }
    if (gitDiffIndex(cwd, gitState.headTree, spawnSyncImpl) !== "equal") {
      throw failClosed("clean baseline requires the index tree to equal HEAD", "base_invalid");
    }
    return {
      base: Object.freeze({ kind: "clean", commit }),
      indexTree: gitState.headTree,
    };
  }
  if (!REVIEW_KINDS.includes(kind)) {
    throw failClosed("only reviews may target a staged index", "base_invalid");
  }
  const indexTree = requireHex(base.index_tree, "base.index_tree", HEX40, "base_invalid");
  for (const record of gitState.statusRecords) {
    if (isUnmergedRecord(record) || record.y !== " " || !STAGED_INDEX_STATES.has(record.x)) {
      refuseDirtyStatus(gitState.statusRecords);
    }
  }
  const objectType = git(cwd, ["cat-file", "-t", indexTree], spawnSyncImpl);
  if (objectType !== "tree") {
    throw failClosed(`base.index_tree must name a tree object, got ${objectType}`, "base_invalid");
  }
  if (gitDiffIndex(cwd, indexTree, spawnSyncImpl) !== "equal") {
    throw failClosed("base.index_tree does not match the current index", "base_invalid");
  }
  return {
    base: Object.freeze({ kind: "staged", commit, index_tree: indexTree }),
    indexTree,
  };
}

function validateContract(contract, kind) {
  closedObject(contract, ["boundary", "deliverables", "witness", "deferred"], "contract", [], "contract_invalid");
  const boundary = requireNonemptyString(contract.boundary, "contract.boundary", "contract_invalid");
  const deliverables = requireStringArray(contract.deliverables, "contract.deliverables", "contract_invalid");
  const deferred = requireStringArray(contract.deferred, "contract.deferred", "contract_invalid");
  closedObject(contract.witness, ["id"], "contract.witness", [], "contract_invalid");
  const witnessId = requireNonemptyString(contract.witness.id, "contract.witness.id", "contract_invalid");
  if (!WITNESS_IDS.includes(witnessId)) {
    throw failClosed(`unknown contract.witness.id ${witnessId}; expected ${WITNESS_IDS.join(" or ")}`, "contract_invalid");
  }
  if (WRITER_KINDS.includes(kind)) {
    if (deliverables.length < 1) {
      throw failClosed("implement and repair require at least one deliverable", "contract_invalid");
    }
    if (witnessId !== VERIFY_WITNESS_ID) {
      throw failClosed("implement and repair require the fixed verify witness", "contract_invalid");
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
    throw failClosed("inputs must be an array", "inputs_invalid");
  }
  const resolved = [];
  for (const [index, item] of inputs.entries()) {
    closedObject(item, ["path", "sha256"], `inputs[${index}]`, [], "inputs_invalid");
    const path = resolvePath(cwd, requireNonemptyString(item.path, `inputs[${index}].path`, "inputs_invalid"));
    const claimed = requireHex(item.sha256, `inputs[${index}].sha256`, HEX64, "inputs_invalid");
    const bytes = readRegularFile(path, deps.readFileSync, deps.existsSync, deps.statSync, "inputs_invalid");
    const actual = sha256Bytes(bytes);
    if (actual !== claimed) {
      throw failClosed(`inputs[${index}] content does not match sha256`, "inputs_invalid");
    }
    resolved.push(Object.freeze({ path, sha256: claimed }));
  }
  return Object.freeze(resolved);
}

function validateRework(reworkOf, taskDir, taskId, assignmentId, deps) {
  if (reworkOf === undefined) return undefined;
  const priorId = requireIdentity(reworkOf, "rework_of", "rework_invalid");
  if (priorId === assignmentId) {
    throw failClosed("rework_of cannot reference the same assignment_id", "rework_invalid");
  }
  const completionPath = join(assignmentRecordDir(taskDir, priorId), "completion.json");
  if (!deps.existsSync(completionPath)) {
    throw failClosed(`rework_of ${priorId} does not point at an existing completion`, "rework_invalid");
  }
  const bytes = readRegularFile(completionPath, deps.readFileSync, deps.existsSync, deps.statSync, "rework_invalid");
  const completion = parseJsonFile(completionPath, bytes, "rework completion", "rework_invalid");
  if (!isPlainObject(completion)) {
    throw failClosed("rework completion is malformed", "rework_invalid");
  }
  for (const key of COMPLETION_LINK_KEYS) {
    if (completion[key] === undefined) {
      throw failClosed(`rework completion missing ${key}`, "rework_invalid");
    }
  }
  if (completion.schema !== COMPLETION_SCHEMA) {
    throw failClosed(`rework completion schema must be ${COMPLETION_SCHEMA}`, "rework_invalid");
  }
  if (completion.assignment_id !== priorId) {
    throw failClosed("rework completion assignment_id does not match rework_of", "rework_invalid");
  }
  if (completion.task_id !== taskId) {
    throw failClosed("rework completion task_id does not match assignment task_id", "rework_invalid");
  }
  return priorId;
}

function validateRoute(manifest) {
  const role = KIND_ROLES[manifest.kind];
  if (!role) {
    throw failClosed(`unknown kind ${manifest.kind}`, "route_invalid");
  }
  const effort = requireNonemptyString(manifest.effort, "effort", "route_invalid");
  if (!EFFORT.includes(effort)) {
    throw failClosed(`unknown effort ${effort}; expected one of ${EFFORT.join(", ")}`, "route_invalid");
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
  let route;
  try {
    route = preflightRequest(request);
  } catch (error) {
    throw failClosed(error?.message ?? "invalid route", "route_invalid");
  }
  if (!route.efforts.includes(effort)) {
    throw failClosed(`${manifest.harness} does not accept effort ${effort}; allowed: ${route.efforts.join(", ")}`, "route_invalid");
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
    throw failClosed(`assignment schema must be ${ASSIGNMENT_SCHEMA}, got ${manifest.schema ?? "none"}`, "manifest_invalid");
  }
  const taskId = requireIdentity(manifest.task_id, "task_id");
  const assignmentId = requireIdentity(manifest.assignment_id, "assignment_id");
  if (!ASSIGNMENT_KINDS.includes(manifest.kind)) {
    throw failClosed(`unknown kind ${manifest.kind}; expected ${ASSIGNMENT_KINDS.join(", ")}`, "route_invalid");
  }
  const cwd = resolvePath(requireNonemptyString(manifest.cwd, "cwd", "base_invalid"));
  if (!exists(cwd)) {
    throw failClosed(`cwd does not exist: ${cwd}`, "base_invalid");
  }
  const taskDir = validateTaskDir(manifest.task_dir, taskId, exists, statImpl, realpathImpl);
  const { role, effort } = validateRoute(manifest);
  const gitState = inspectWorktree(cwd, spawnSyncImpl, realpathImpl);
  const proven = validateBase(manifest.base, manifest.kind, gitState, spawnSyncImpl, cwd);
  if (!isPlainObject(manifest.plan_ref) || !PLAN_REF_KINDS.includes(manifest.plan_ref.kind)) {
    throw failClosed(`plan_ref.kind must be ${PLAN_REF_KINDS.join(" or ")}`, "plan_ref_invalid");
  }
  const planRef = manifest.plan_ref.kind === "current"
    ? validateCurrentPlanRef(manifest.plan_ref, taskDir, taskId, io)
    : validateBootstrapPlanRef(manifest.plan_ref, taskDir, manifest.kind, io);
  const inputs = validateInputs(manifest.inputs, cwd, io);
  const contract = validateContract(manifest.contract, manifest.kind);
  const requestedOutputDir = resolvePath(taskDir, requireNonemptyString(manifest.output_dir, "output_dir"));
  const identityDir = assignmentRecordDir(taskDir, assignmentId);
  if (lstatOrNull(identityDir, lstatImpl)) {
    throw failClosed(`assignment_id ${assignmentId} is already present`, "identity_taken");
  }
  const compared = validateOutputDir(requestedOutputDir, taskDir, identityDir, cwd, lstatImpl, realpathImpl);
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
    record_dir: compared.record,
    requested_output_dir: requestedOutputDir,
    base: proven.base,
    plan_ref: planRef,
    inputs,
    contract,
    output_dir: compared.out,
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

const COMPLETION_KEYS = Object.freeze([
  "schema",
  "task_id",
  "assignment_id",
  "rework_of",
  "kind",
  "role",
  "manifest",
  "prompt",
  "plan",
  "route",
  "binding",
  "invocation",
  "candidate",
  "recording",
  "transport",
  "usage",
  "model_claim",
  "sidecars",
  "verification",
  "critic",
  "attribution",
]);
const REFUSAL_KEYS = Object.freeze([
  "schema",
  "task_id",
  "assignment_id",
  "kind",
  "recordedAt",
  "manifest",
  "binding",
  "stage",
  "code",
  "provider_calls",
  "sidecars",
]);
const REFUSAL_STAGES = Object.freeze(["validation", "ownership", "prepare"]);
const MODEL_CLAIM_OVERRIDE_KEYS = Object.freeze([
  "verification",
  "cost",
  "costUsd",
  "cost_usd",
  "acceptance",
  "critic",
  "role",
  "usage",
  "transport",
]);
function ioDeps(deps = {}) {
  return {
    spawnSync: deps.spawnSync ?? spawnSync,
    existsSync: deps.existsSync ?? existsSync,
    readFileSync: deps.readFileSync ?? readFileSync,
    realpathSync: deps.realpathSync ?? realpathSync,
    lstatSync: deps.lstatSync ?? lstatSync,
    statSync: deps.statSync ?? statSync,
    mkdirSync: deps.mkdirSync ?? mkdirSync,
    writeFileSync: deps.writeFileSync ?? writeFileSync,
    chmodSync: deps.chmodSync ?? chmodSync,
    manifestBytes: deps.manifestBytes,
    now: deps.now,
  };
}

function writePrivate(path, body, deps, flag = "wx") {
  const write = deps.writeFileSync ?? writeFileSync;
  const chmod = deps.chmodSync ?? chmodSync;
  const options = Buffer.isBuffer(body)
    ? { mode: 0o600, flag }
    : { encoding: "utf8", mode: 0o600, flag };
  write(path, body, options);
  try {
    chmod(path, 0o600);
  } catch {
    // Windows cannot honor POSIX 0600; the create mode still ran.
  }
}

function originalManifestBytes(manifest, deps) {
  if (deps.manifestBytes) {
    return Buffer.isBuffer(deps.manifestBytes) ? deps.manifestBytes : Buffer.from(deps.manifestBytes);
  }
  return Buffer.from(JSON.stringify(manifest));
}

function runnerErrorsPath(recordDir) {
  return join(recordDir, "runner-errors.jsonl");
}

function appendRunnerError(recordDir, event, deps) {
  const path = runnerErrorsPath(recordDir);
  const line = `${JSON.stringify({
    at: new Date((deps.now ?? Date.now)()).toISOString(),
    step: event.step,
    code: event.code,
    message: String(event.message ?? ""),
  })}\n`;
  try {
    writePrivate(path, line, deps, "wx");
  } catch (error) {
    if (error && error.code === "EEXIST") {
      const write = deps.writeFileSync ?? writeFileSync;
      write(path, line, { encoding: "utf8", flag: "a", mode: 0o600 });
    } else {
      throw failClosed(`cannot write runner diagnostics: ${error?.message ?? error}`, "record_write_failed");
    }
  }
  try {
    (deps.chmodSync ?? chmodSync)(path, 0o600);
  } catch {
    // Best-effort mode on platforms that ignore POSIX 0600.
  }
  const size = (deps.statSync ?? statSync)(path).size;
  return sidecarRef(path, size);
}

function sidecarRef(path, bytes) {
  return Object.freeze({ path, bytes });
}

function bytesOf(body) {
  return Buffer.byteLength(typeof body === "string" ? body : Buffer.from(body), "utf8");
}

const COUNT_DESCRIPTION = "Nonnegative integer. The runner caps public counts at 1000; JSON Schema minimum/maximum keywords are omitted because cross-provider keyword support is unproven.";

function closedSchemaObject(properties) {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

export function assignmentOutputSchema(kind) {
  if (REVIEW_KINDS.includes(kind)) {
    return closedSchemaObject({
      verdict: { type: "string", enum: [...REVIEW_VERDICTS] },
      summary: { type: "string" },
      findings: { type: "array", items: { type: "string" } },
    });
  }
  return closedSchemaObject({
    status: { type: "string", enum: [...MODEL_CLAIM_STATUSES] },
    completedCount: { type: "integer", description: COUNT_DESCRIPTION },
    deferredCount: { type: "integer", description: COUNT_DESCRIPTION },
    artifactCount: { type: "integer", description: COUNT_DESCRIPTION },
    summary: { type: "string" },
    deferredItems: { type: "array", items: { type: "string" } },
  });
}

function planBody(validated, deps) {
  if (validated.plan_ref.kind !== "current") {
    return `No current plan pointer. Bootstrap reason: ${validated.plan_ref.reason}`;
  }
  const bytes = readRegularFile(
    validated.plan_ref.path,
    deps.readFileSync ?? readFileSync,
    deps.existsSync ?? existsSync,
    deps.statSync ?? statSync,
  );
  return bytes.toString("utf8");
}

export function renderAssignmentPrompt(validated, deps = {}) {
  const mechanism = READ_MECHANISMS[validated.harness];
  if (!mechanism) {
    throw failClosed(`no read mechanism for harness ${validated.harness}`, "route_invalid");
  }
  const review = REVIEW_KINDS.includes(validated.kind);
  const planText = planBody(validated, deps);
  const inputs = validated.inputs.map((item) => `- ${item.path} (${item.sha256})`).join("\n") || "- none";
  const deliverables = validated.contract.deliverables.map((item) => `- ${item}`).join("\n") || "- none";
  const deferred = validated.contract.deferred.map((item) => `- ${item}`).join("\n") || "- none";
  const rework = validated.rework_of ? `Rework of existing completion \`${validated.rework_of}\`.\n` : "";
  const verdictRule = review
    ? "Review completion JSON requires a top-level `verdict` of exactly PASS or BLOCK. Never infer a verdict from prose."
    : "Do not supply a review verdict. Writer/planner completion JSON uses status/completedCount/deferredCount/artifactCount only.";
  return [
    `# KXM assignment ${validated.assignment_id}`,
    "",
    `Task \`${validated.task_id}\`. Assignment \`${validated.assignment_id}\`. Kind \`${validated.kind}\`. Role \`${validated.role}\`.`,
    rework,
    "## Candidate identity",
    "",
    `- cwd: ${validated.cwd}`,
    `- task_dir: ${validated.task_dir}`,
    `- HEAD: ${validated.git.head}`,
    `- index_tree: ${validated.git.index_tree}`,
    `- clean: ${validated.git.clean}`,
    `- base: ${validated.base.kind}${validated.base.kind === "staged" ? ` ${validated.base.index_tree}` : ` ${validated.base.commit}`}`,
    "",
    "## Current plan",
    "",
    validated.plan_ref.kind === "current"
      ? `Pointer ${validated.plan_ref.pointer_path} generation ${validated.plan_ref.generation} sha256 ${validated.plan_ref.sha256}. Exact current plan follows.`
      : `Bootstrap: ${validated.plan_ref.reason}`,
    "",
    "```markdown",
    planText.replace(/```/g, "``\\`"),
    "```",
    "",
    "## Inputs",
    "",
    inputs,
    "",
    "## Contract",
    "",
    `Boundary: ${validated.contract.boundary}`,
    "",
    "Deliverables:",
    deliverables,
    "",
    `Witness id: ${validated.contract.witness.id}.`,
    WRITER_KINDS.includes(validated.kind)
      ? "Run `npm run verify` before completing and report its exit code. Root re-runs the same fixed witness after you exit."
      : "Root runs the witness separately; do not run it.",
    "",
    "Deferred:",
    deferred,
    "",
    "## Read mechanism",
    "",
    mechanism,
    "",
    "## Completion requirements",
    "",
    verdictRule,
    "Return JSON matching the supplied output schema. Transport completion is not acceptance or verification.",
    "Do not set verification, critic, acceptance, role, usage, or cost fields; those are recorded from facts.",
    "",
  ].join("\n");
}

function reserveIdentity(recordDir, assignmentId, manifestBytes, deps) {
  const mkdir = deps.mkdirSync ?? mkdirSync;
  try {
    mkdir(recordDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw failClosed(`assignment_id ${assignmentId} is already present`, "identity_taken");
    }
    throw failClosed(`cannot create assignment identity: ${error?.message ?? error}`, "mkdir_failed");
  }
  const manifestPath = join(recordDir, "manifest.json");
  try {
    writePrivate(manifestPath, manifestBytes, deps, "wx");
  } catch (error) {
    if (error && error.runnerCode) throw error;
    throw failClosed(`cannot write identity manifest: ${error?.message ?? error}`, "record_write_failed");
  }
  return recordDir;
}

function reserveOutputDir(validated, deps) {
  if (validated.output_dir === validated.record_dir) return;
  const mkdir = deps.mkdirSync ?? mkdirSync;
  try {
    mkdir(dirname(validated.output_dir), { recursive: true, mode: 0o700 });
  } catch (error) {
    throw failClosed(`cannot create output_dir parent: ${error?.message ?? error}`, "mkdir_failed");
  }
  try {
    mkdir(validated.output_dir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw failClosed(`output_dir already exists: ${validated.output_dir}`, "output_dir_taken");
    }
    throw failClosed(`cannot create output_dir: ${error?.message ?? error}`, "mkdir_failed");
  }
}

function consumeOwnership(validated, manifest, deps) {
  reserveIdentity(
    validated.record_dir,
    validated.assignment_id,
    originalManifestBytes(manifest, deps),
    deps,
  );
  reserveOutputDir(validated, deps);
  return validated.record_dir;
}

function snapshotCandidate(cwd, spawnSyncImpl, realpathImpl) {
  try {
    const gitState = inspectWorktree(cwd, spawnSyncImpl, realpathImpl);
    const indexTree = git(cwd, ["write-tree"], spawnSyncImpl);
    const clean = gitState.statusRecords.every((record) => record.y === " " && !isUnmergedRecord(record));
    return Object.freeze({
      status: "recorded",
      head: gitState.head,
      index_tree: indexTree,
      clean,
    });
  } catch {
    return Object.freeze({ status: "unknown", code: "snapshot_failed" });
  }
}

function closedTransport(result, fallback) {
  if (!result || result.schema !== RESULT_SCHEMA) {
    return Object.freeze({
      status: "failed",
      stage: "run",
      ok: false,
      errorCode: "normalization_failed",
    });
  }
  const status = TRANSPORT_STATUSES.includes(result.status) ? result.status : fallback.status;
  const stage = TRANSPORT_STAGES.includes(result.stage) ? result.stage : fallback.stage;
  let errorCode;
  if (typeof result.errorCode === "string") {
    errorCode = ERROR_CODES.includes(result.errorCode) ? result.errorCode : "unrecognized";
  }
  const transport = {
    status,
    stage,
    ok: result.ok === true && status === "completed",
  };
  if (typeof result?.startedAt === "string") transport.startedAt = result.startedAt;
  if (typeof result?.finishedAt === "string") transport.finishedAt = result.finishedAt;
  if (Number.isFinite(result?.latencyMs) && result.latencyMs >= 0) transport.latencyMs = result.latencyMs;
  if (Number.isInteger(result?.exitCode) || result?.exitCode === null) transport.exitCode = result.exitCode;
  if (typeof result?.timedOut === "boolean") transport.timedOut = result.timedOut;
  if (typeof result?.observedChildExit === "boolean") transport.observedChildExit = result.observedChildExit;
  if (typeof result?.signal === "string") transport.signal = result.signal;
  if (result?.killRequest && typeof result.killRequest === "object") {
    transport.killRequest = {
      signal: result.killRequest.signal,
      escalated: result.killRequest.escalated === true,
    };
  }
  if (errorCode) transport.errorCode = errorCode;
  if (typeof result?.command === "string") transport.command = result.command;
  if (typeof result?.effectiveModel === "string") transport.effectiveModel = result.effectiveModel;
  return Object.freeze(transport);
}

function closedUsage(result) {
  const usage = {
    tokenBasis: TOKEN_BASIS,
    contextOccupancy: CONTEXT_OCCUPANCY_UNKNOWN,
  };
  const costBasis = COST_BASIS.includes(result?.costBasis) ? result.costBasis : "unknown";
  usage.costBasis = costBasis;
  const metadata = result?.providerMetadata && typeof result.providerMetadata === "object"
    ? result.providerMetadata
    : {};
  for (const key of ["tokensIn", "tokensOut", "cacheReadTokens", "cacheCreationTokens", "reasoningTokens"]) {
    const value = result?.[key] ?? metadata[key];
    if (Number.isInteger(value) && value >= 0) usage[key] = value;
  }
  for (const key of ["costUsd", "providerReportedCostUsd"]) {
    const value = result?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage[key] = value;
  }
  if (result?.usagePartial === true) usage.usagePartial = true;
  return Object.freeze(usage);
}

function boundedModelClaim(result, kind) {
  const raw = result?.modelClaim;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const review = REVIEW_KINDS.includes(kind);
  const claim = {};
  if (typeof raw.status === "string") {
    claim.status = MODEL_CLAIM_STATUSES.includes(raw.status) ? raw.status : "unrecognized";
  }
  for (const key of ["completedCount", "deferredCount", "artifactCount", "unrecognizedCount", "bytes"]) {
    if (Number.isInteger(raw[key]) && raw[key] >= 0) claim[key] = raw[key];
  }
  if (review && REVIEW_VERDICTS.includes(raw.verdict)) claim.verdict = raw.verdict;
  if (typeof raw.path === "string") claim.path = raw.path;
  if (CLAIM_SOURCES.includes(raw.claimSource)) claim.claimSource = raw.claimSource;
  let unrecognized = claim.unrecognizedCount ?? 0;
  for (const key of Object.keys(raw)) {
    if (MODEL_CLAIM_OVERRIDE_KEYS.includes(key)) unrecognized += 1;
  }
  claim.unrecognizedCount = unrecognized;
  return Object.freeze(claim);
}

function deriveCritic(validated, candidate, modelClaim, transport) {
  if (!REVIEW_KINDS.includes(validated.kind)) {
    return Object.freeze({ kind: "none", reason: "not-review" });
  }
  if (!(transport?.status === "completed" && transport?.ok === true)) {
    return Object.freeze({ kind: "none", reason: "transport-not-completed" });
  }
  if (!candidate || candidate.status !== "recorded") {
    return Object.freeze({ kind: "none", reason: "candidate-unknown" });
  }
  const reviewedTree = validated.git.index_tree;
  const unchanged = candidate.head === validated.git.head
    && candidate.index_tree === reviewedTree
    && candidate.clean === validated.git.clean;
  if (!unchanged) return Object.freeze({ kind: "none", reason: "candidate-changed" });
  if (!modelClaim || !REVIEW_VERDICTS.includes(modelClaim.verdict)) {
    return Object.freeze({ kind: "none", reason: "no-verdict" });
  }
  return Object.freeze({
    kind: "review",
    verdict: modelClaim.verdict,
    judged_tree: reviewedTree,
    role: validated.role,
  });
}

function thrownHarnessResult(error, validated) {
  const explicit = error?.stage;
  const stage = explicit === "preflight" || explicit === "auth" ? explicit : "run";
  const errorCode = stage === "auth"
    ? "auth_failed"
    : stage === "preflight"
      ? "preflight_failed"
      : "unrecognized";
  return {
    schema: RESULT_SCHEMA,
    ok: false,
    status: "failed",
    stage,
    errorCode,
    harness: validated.harness,
    role: validated.role,
    requestedModel: validated.model,
    command: validated.harness,
    costBasis: "unknown",
    tokenBasis: TOKEN_BASIS,
    contextOccupancy: CONTEXT_OCCUPANCY_UNKNOWN,
  };
}

function routingInt(value) {
  if (!Number.isInteger(value) || value < 0) return undefined;
  if (value > 1_000_000) return undefined;
  return value;
}

function buildRoutingRecord(validated, promptSha, usage, transport, effectiveModel) {
  const planSha = validated.plan_ref?.kind === "current" ? validated.plan_ref.sha256 : undefined;
  const requestedModel = `${validated.harness}/${validated.model}`;
  const behavioral = {
    requestedModel,
    effectiveModel: effectiveModel ?? requestedModel,
    reasoningEffort: validated.effort,
    agentRole: validated.role,
    rolePromptSha256: promptSha,
    skills: [],
  };
  if (planSha) behavioral.workflowDefinitionSha256 = planSha;
  const providerMetadata = {
    harness: validated.harness,
    transportStatus: transport.status,
    costBasis: usage.costBasis,
    tokenBasis: usage.tokenBasis ?? TOKEN_BASIS,
    contextOccupancy: usage.contextOccupancy ?? CONTEXT_OCCUPANCY_UNKNOWN,
  };
  if (Number.isFinite(transport?.latencyMs) && transport.latencyMs >= 0) {
    providerMetadata.latencyMs = transport.latencyMs;
  }
  if (usage.usagePartial === true) providerMetadata.usagePartial = true;
  if (validated.rework_of) providerMetadata.rework_of = validated.rework_of;
  const record = {
    schema: ROUTING_RECORD_SCHEMA,
    behavioralHashVersion: BEHAVIORAL_HASH_VERSION,
    behavioralSha256: behavioralConfigHash(behavioral),
    workflowRunId: validated.assignment_id,
    stageId: validated.kind,
    attempt: 1,
    requestedModel,
    effectiveModel: behavioral.effectiveModel,
    reasoningEffort: validated.effort,
    agentRole: validated.role,
    rolePromptSha256: promptSha,
    skills: [],
    retries: validated.rework_of ? 1 : 0,
    transitions: 0,
    humanInterventions: 0,
    finalOutcome: "pending",
    providerMetadata,
  };
  if (planSha) record.workflowDefinitionSha256 = planSha;
  for (const key of ["tokensIn", "tokensOut", "cacheReadTokens"]) {
    const value = usage[key];
    if (!Number.isInteger(value) || value < 0) continue;
    const capped = routingInt(value);
    if (capped !== undefined) record[key] = capped;
    else providerMetadata[key] = value;
  }
  for (const key of ["cacheCreationTokens", "reasoningTokens"]) {
    const value = usage[key];
    if (Number.isInteger(value) && value >= 0) providerMetadata[key] = value;
  }
  if (usage.costBasis === "provider-reported") {
    const cost = typeof usage.costUsd === "number" ? usage.costUsd : usage.providerReportedCostUsd;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) record.costUsd = cost;
  } else if (usage.costBasis === "unmetered") {
    const estimate = typeof usage.providerReportedCostUsd === "number"
      ? usage.providerReportedCostUsd
      : usage.costUsd;
    if (typeof estimate === "number" && Number.isFinite(estimate) && estimate >= 0) {
      providerMetadata.unmeteredEstimateUsd = estimate;
    }
  } else if (usage.costBasis === "list") {
    const estimate = typeof usage.costUsd === "number" ? usage.costUsd : usage.providerReportedCostUsd;
    if (typeof estimate === "number" && Number.isFinite(estimate) && estimate >= 0) {
      providerMetadata.listEstimateUsd = estimate;
    }
  }
  return parseRoutingRecord(record);
}

function routingRecordFromCompletion(completion) {
  return buildRoutingRecord(
    {
      assignment_id: completion.assignment_id,
      kind: completion.kind,
      harness: completion.route.harness,
      model: completion.route.model,
      effort: completion.route.effort,
      role: completion.route.role,
      plan_ref: completion.plan,
      rework_of: completion.rework_of,
    },
    completion.prompt.sha256,
    completion.usage,
    completion.transport,
    completion.transport?.effectiveModel,
  );
}

function withoutRegeneratedTimestamps(value) {
  if (Array.isArray(value)) return value.map(withoutRegeneratedTimestamps);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "recordedAt" || key === "createdAt" || key === "resolvedAt") continue;
    out[key] = withoutRegeneratedTimestamps(value[key]);
  }
  return out;
}

function sameStableFacts(left, right) {
  return JSON.stringify(withoutRegeneratedTimestamps(left)) === JSON.stringify(withoutRegeneratedTimestamps(right));
}

function sameInvokedPath(left, right) {
  try {
    if (realpathSync(left) === realpathSync(right)) return true;
  } catch {
    // Fall through to inode identity when a parent alias cannot be resolved.
  }
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

export function assignmentTelemetryPath(outputDir) {
  return join(outputDir, "telemetry.jsonl");
}

function expectedTelemetryEvent(completion, routing) {
  const parsed = parseRoutingRecord(routing);
  const ok = completion.transport?.ok === true;
  return {
    schema: TELEMETRY_SCHEMA,
    recordedAt: nowIso(),
    host: "local",
    target: "cli",
    envelope: workerResult(
      agentWorker({
        name: `assignment:${completion.assignment_id}`,
        purpose: "dev assignment runner",
        model: completion.route.model,
        thinking: completion.route.effort,
      }),
      {
        command: "assignment-run",
        ok,
        outcome: "running",
        summary: `assignment ${completion.assignment_id} transport ${completion.transport.status}`,
        createdAt: nowIso(),
        routing: parsed,
      },
    ),
  };
}

function readExistingTelemetryEvents(path, deps) {
  const read = deps.readFileSync ?? readFileSync;
  let raw;
  try {
    raw = read(path, "utf8");
  } catch (error) {
    throw failClosed(`cannot read assignment telemetry: ${error?.message ?? error}`, "telemetry_failed");
  }
  const lines = String(raw).split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      throw failClosed("existing telemetry is malformed", "telemetry_failed");
    }
  });
}

function assertTelemetryMatchesCompletion(path, expected, deps) {
  const events = readExistingTelemetryEvents(path, deps);
  if (events.length !== 1) {
    throw failClosed("telemetry.jsonl must contain exactly one bound event", "telemetry_failed");
  }
  const event = events[0];
  if (!isPlainObject(event) || event.schema !== TELEMETRY_SCHEMA) {
    throw failClosed("existing telemetry is not a bound assignment event", "telemetry_failed");
  }
  if (!sameStableFacts(event, expected)) {
    throw failClosed("existing telemetry does not match this assignment completion", "telemetry_failed");
  }
}

export function appendAssignmentTelemetry(completion, outputDir, deps = {}) {
  const path = assignmentTelemetryPath(outputDir);
  const exists = deps.existsSync ?? existsSync;
  const routing = completion.routingRecord ?? routingRecordFromCompletion(completion);
  const expected = expectedTelemetryEvent(completion, routing);
  if (exists(path)) {
    assertTelemetryMatchesCompletion(path, expected, deps);
    return false;
  }
  const line = `${JSON.stringify(expected)}\n`;
  try {
    writePrivate(path, line, deps, "wx");
    return true;
  } catch (error) {
    if (error && error.code === "EEXIST") {
      assertTelemetryMatchesCompletion(path, expected, deps);
      return false;
    }
    throw failClosed(`cannot append assignment telemetry: ${error?.message ?? error}`, "telemetry_failed");
  }
}

function writeCompletionExclusive(path, completion, deps) {
  const publicCompletion = pickPublicCompletion(completion);
  const body = `${JSON.stringify(publicCompletion, undefined, 2)}\n`;
  try {
    writePrivate(path, body, deps, "wx");
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw failClosed(`completion already exists: ${path}`, "record_write_failed");
    }
    throw failClosed(`cannot write completion: ${error?.message ?? error}`, "record_write_failed");
  }
  return publicCompletion;
}

function pickPublicCompletion(completion) {
  const picked = {};
  for (const key of COMPLETION_KEYS) {
    if (completion[key] !== undefined) picked[key] = completion[key];
  }
  return picked;
}

function closeSidecars(entries) {
  const sidecars = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!value) continue;
    const path = value.path;
    const bytes = value.bytes;
    if (typeof path !== "string" || !Number.isInteger(bytes) || bytes < 0) continue;
    sidecars[key] = Object.freeze({ path, bytes });
  }
  return Object.freeze(sidecars);
}

function recordedCandidate(candidate) {
  if (candidate && candidate.status === "recorded") return candidate;
  if (candidate && candidate.status === "unknown") return candidate;
  if (candidate && typeof candidate.head === "string") {
    return Object.freeze({
      status: "recorded",
      head: candidate.head,
      index_tree: candidate.index_tree,
      clean: candidate.clean === true,
    });
  }
  return Object.freeze({ status: "unknown", code: "snapshot_failed" });
}

function buildCompletion(validated, hashes, candidate, harnessResult, sidecars, extras = {}) {
  const observed = recordedCandidate(candidate);
  const transport = closedTransport(harnessResult, {
    status: "failed",
    stage: "run",
    errorCode: "unrecognized",
  });
  const usage = closedUsage(harnessResult);
  const modelClaim = boundedModelClaim(harnessResult, validated.kind);
  const critic = deriveCritic(validated, observed, modelClaim, transport);
  const route = Object.freeze({
    harness: validated.harness,
    model: validated.model,
    effort: validated.effort,
    permission: validated.permission,
    role: validated.role,
  });
  const plan = validated.plan_ref.kind === "current"
    ? Object.freeze({
      kind: "current",
      path: validated.plan_ref.path,
      sha256: validated.plan_ref.sha256,
      pointer_path: validated.plan_ref.pointer_path,
      generation: validated.plan_ref.generation,
    })
    : Object.freeze({ kind: "bootstrap", reason: validated.plan_ref.reason });
  const completion = {
    schema: COMPLETION_SCHEMA,
    task_id: validated.task_id,
    assignment_id: validated.assignment_id,
    kind: validated.kind,
    role: validated.role,
    manifest: Object.freeze({ sha256: hashes.manifestSha }),
    prompt: Object.freeze({ sha256: hashes.promptSha }),
    plan,
    route,
    binding: Object.freeze({
      task_dir: validated.task_dir,
      cwd: validated.cwd,
      record_dir: validated.record_dir,
      output_dir: validated.output_dir,
    }),
    invocation: extras.invocation === "thrown" ? "thrown" : "returned",
    candidate: observed,
    recording: extras.recording ?? Object.freeze({ status: "ok" }),
    transport,
    usage,
    sidecars: closeSidecars(sidecars),
    verification: Object.freeze({ status: "not-run" }),
    critic,
    attribution: Object.freeze({ status: "unclassified" }),
  };
  if (validated.rework_of) completion.rework_of = validated.rework_of;
  if (modelClaim) completion.model_claim = modelClaim;
  if (extras.routingRecord) completion.routingRecord = extras.routingRecord;
  return completion;
}

function harnessRequest(validated, promptPath, schemaPath) {
  const request = {
    schema: REQUEST_SCHEMA,
    harness: validated.harness,
    role: validated.role,
    model: validated.model,
    permission: validated.permission,
    effort: validated.effort,
    prompt_file: promptPath,
    output_schema: schemaPath,
    cwd: validated.cwd,
    output_dir: validated.output_dir,
  };
  if (validated.timeout_ms !== undefined) request.timeout_ms = validated.timeout_ms;
  if (validated.max_turns !== undefined) request.max_turns = validated.max_turns;
  return request;
}

function digestManifest(manifest, deps) {
  return sha256Bytes(originalManifestBytes(manifest, deps));
}

function identifyAssignment(manifest, io) {
  if (!isPlainObject(manifest)) return null;
  if (manifest.schema !== ASSIGNMENT_SCHEMA) return null;
  if (typeof manifest.task_id !== "string" || !IDENTITY.test(manifest.task_id)) return null;
  if (typeof manifest.assignment_id !== "string" || !IDENTITY.test(manifest.assignment_id)) return null;
  if (typeof manifest.task_dir !== "string" || !nodePath.isAbsolute(manifest.task_dir)) return null;
  try {
    const taskDir = validateTaskDir(
      manifest.task_dir,
      manifest.task_id,
      io.existsSync,
      io.statSync,
      io.realpathSync,
    );
    const recordDir = assignmentRecordDir(taskDir, manifest.assignment_id);
    const outputDir = typeof manifest.output_dir === "string" && manifest.output_dir.trim() !== ""
      ? resolvePath(taskDir, manifest.output_dir)
      : undefined;
    return Object.freeze({
      task_id: manifest.task_id,
      assignment_id: manifest.assignment_id,
      task_dir: taskDir,
      record_dir: recordDir,
      output_dir: outputDir,
      kind: typeof manifest.kind === "string" ? manifest.kind : undefined,
    });
  } catch {
    return null;
  }
}

function refusalIdentity(validated) {
  return {
    task_id: validated.task_id,
    assignment_id: validated.assignment_id,
    task_dir: validated.task_dir,
    record_dir: validated.record_dir,
    output_dir: validated.requested_output_dir ?? validated.output_dir,
    kind: validated.kind,
  };
}

function pickPublicRefusal(refusal) {
  const picked = {};
  for (const key of REFUSAL_KEYS) {
    if (refusal[key] !== undefined) picked[key] = refusal[key];
  }
  return picked;
}

function writeRefusal(identity, manifest, stage, code, error, deps) {
  const io = ioDeps(deps);
  const recordDir = identity.record_dir;
  const runnerCode = RUNNER_CODES.includes(code) ? code : "unknown";
  const runnerErrors = appendRunnerError(recordDir, {
    step: stage,
    code: runnerCode,
    message: error?.message ?? runnerCode,
  }, { ...io, now: deps.now });
  const bytes = originalManifestBytes(manifest, deps);
  const refusal = {
    schema: REFUSAL_SCHEMA,
    task_id: identity.task_id,
    assignment_id: identity.assignment_id,
    recordedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    manifest: Object.freeze({
      path: join(recordDir, "manifest.json"),
      sha256: sha256Bytes(bytes),
    }),
    binding: Object.freeze({
      task_dir: identity.task_dir,
      record_dir: recordDir,
      output_dir: identity.output_dir ?? recordDir,
    }),
    stage: REFUSAL_STAGES.includes(stage) ? stage : "validation",
    code: runnerCode,
    provider_calls: 0,
    sidecars: Object.freeze({
      runner_errors: runnerErrors,
    }),
  };
  if (ASSIGNMENT_KINDS.includes(identity.kind)) refusal.kind = identity.kind;
  writePrivate(
    join(recordDir, "refusal.json"),
    `${JSON.stringify(pickPublicRefusal(refusal), undefined, 2)}\n`,
    io,
    "wx",
  );
  return refusal;
}

const RECORDING_STEP_CODES = Object.freeze({
  candidate_snapshot: "snapshot_failed",
  sidecars: "sidecar_failed",
  routing_record: "routing_record_failed",
  telemetry: "telemetry_failed",
});

function firstRecordingFailure(steps) {
  for (const step of ["candidate_snapshot", "sidecars", "routing_record", "telemetry"]) {
    if (steps[step] === "failed") {
      return { status: "failed", steps: Object.freeze({ ...steps }), code: RECORDING_STEP_CODES[step] };
    }
  }
  return Object.freeze({ status: "ok" });
}

function trySidecarStat(path, bytes, io, recordDir, steps, now) {
  if (typeof path !== "string") return undefined;
  try {
    if (Number.isInteger(bytes) && bytes >= 0) return sidecarRef(path, bytes);
    if (!io.existsSync(path)) return undefined;
    return sidecarRef(path, io.statSync(path).size);
  } catch (error) {
    steps.sidecars = "failed";
    try {
      appendRunnerError(recordDir, {
        step: "sidecars",
        code: "sidecar_failed",
        message: error?.message ?? "sidecar stat failed",
      }, { ...io, now });
    } catch {
      // Diagnostics are best-effort; recording still records sidecar_failed.
    }
    return undefined;
  }
}

async function dispatchOwnedAssignment(validated, manifest, deps, ledger) {
  const io = ioDeps(deps);
  const recordDir = validated.record_dir;
  const promptPath = join(recordDir, "prompt.md");
  const schemaPath = join(recordDir, "output-schema.json");
  const preDispatchPath = join(recordDir, "pre-dispatch.json");
  const completionPath = join(recordDir, "completion.json");
  let promptText;
  try {
    promptText = renderAssignmentPrompt(validated, io);
  } catch (error) {
    throw failClosed(error?.message ?? "prompt render failed", "prompt_render_failed");
  }
  const schemaText = `${JSON.stringify(assignmentOutputSchema(validated.kind), undefined, 2)}\n`;
  try {
    writePrivate(promptPath, promptText, io, "wx");
    writePrivate(schemaPath, schemaText, io, "wx");
  } catch (error) {
    throw failClosed(error?.message ?? "cannot write prompt records", "record_write_failed");
  }
  const promptSha = sha256Bytes(Buffer.from(promptText));
  const manifestSha = digestManifest(manifest, deps);
  const planSha = validated.plan_ref.kind === "current" ? validated.plan_ref.sha256 : undefined;
  const preDispatch = {
    schema: ASSIGNMENT_DISPATCH_SCHEMA,
    task_id: validated.task_id,
    assignment_id: validated.assignment_id,
    timestamp: new Date((deps.now ?? Date.now)()).toISOString(),
    command: validated.harness,
    pid: null,
    manifest_sha256: manifestSha,
    prompt_sha256: promptSha,
    ...(planSha ? { plan_sha256: planSha } : {}),
  };
  try {
    writePrivate(preDispatchPath, `${JSON.stringify(preDispatch)}\n`, io, "wx");
  } catch (error) {
    throw failClosed(error?.message ?? "cannot write pre-dispatch", "record_write_failed");
  }

  const run = deps.runHarness ?? runHarness;
  ledger.invoked = true;
  try {
    ledger.result = await run(harnessRequest(validated, promptPath, schemaPath), deps);
    ledger.invocation = "returned";
  } catch (error) {
    ledger.invocation = "thrown";
    ledger.result = thrownHarnessResult(error, validated);
    try {
      appendRunnerError(recordDir, {
        step: error?.stage === "preflight" || error?.stage === "auth" ? error.stage : "run",
        code: ledger.result.errorCode,
        message: error?.message ?? "native harness failed",
      }, { ...io, now: deps.now });
    } catch {
      // Diagnostics are best-effort after invocation; completion still records the throw.
    }
  }

  const steps = {
    candidate_snapshot: "ok",
    sidecars: "ok",
    routing_record: "ok",
    telemetry: "ok",
  };
  const candidate = snapshotCandidate(validated.cwd, io.spawnSync, io.realpathSync);
  if (candidate.status === "unknown") {
    steps.candidate_snapshot = "failed";
    try {
      appendRunnerError(recordDir, {
        step: "candidate_snapshot",
        code: "snapshot_failed",
        message: "candidate snapshot failed",
      }, { ...io, now: deps.now });
    } catch {
      // Private diagnostics must not replace observed transport facts.
    }
  }

  const hashes = { manifestSha, promptSha };
  const sidecars = {
    pre_dispatch: sidecarRef(preDispatchPath, bytesOf(`${JSON.stringify(preDispatch)}\n`)),
    prompt: sidecarRef(promptPath, bytesOf(promptText)),
    output_schema: sidecarRef(schemaPath, bytesOf(schemaText)),
  };
  const harnessResult = ledger.result;
  const dispatchCandidates = [
    harnessResult?.dispatchPath,
    join(validated.output_dir, "dispatch.json"),
  ];
  for (const path of dispatchCandidates) {
    const ref = trySidecarStat(path, undefined, io, recordDir, steps, deps.now);
    if (ref) {
      sidecars.harness_dispatch = ref;
      break;
    }
  }
  const answer = trySidecarStat(harnessResult?.answerPath, harnessResult?.answerBytes, io, recordDir, steps, deps.now);
  if (answer) sidecars.answer = answer;
  const stderr = trySidecarStat(harnessResult?.stderrPath, harnessResult?.stderrBytes, io, recordDir, steps, deps.now);
  if (stderr) sidecars.stderr = stderr;
  const helperError = trySidecarStat(harnessResult?.errorPath, harnessResult?.errorBytes, io, recordDir, steps, deps.now);
  if (helperError) sidecars.error = helperError;
  const claimRef = trySidecarStat(
    harnessResult?.modelClaim?.path,
    harnessResult?.modelClaim?.bytes,
    io,
    recordDir,
    steps,
    deps.now,
  );
  if (claimRef) sidecars.model_claim = claimRef;
  const errorsPath = runnerErrorsPath(recordDir);
  const runnerErrors = trySidecarStat(errorsPath, undefined, io, recordDir, steps, deps.now);
  if (runnerErrors) sidecars.runner_errors = runnerErrors;

  return recordInvocationCompletion(
    validated,
    hashes,
    candidate,
    harnessResult,
    sidecars,
    steps,
    ledger.invocation,
    io,
    deps.now,
    completionPath,
  );
}

function writeRoutingRecordExclusive(path, routingRecord, io) {
  const body = `${JSON.stringify(routingRecord)}\n`;
  try {
    writePrivate(path, body, io, "wx");
    return body;
  } catch (error) {
    if (error && error.code === "EEXIST") {
      const existing = parseJsonFile(
        path,
        readRegularFile(path, io.readFileSync, io.existsSync, io.statSync, "routing_record_failed"),
        "routing record",
        "routing_record_failed",
      );
      const parsed = parseRoutingRecord(existing);
      if (!sameStableFacts(parsed, routingRecord)) {
        throw failClosed("existing routing record does not match this assignment completion", "routing_record_failed");
      }
      return `${JSON.stringify(existing)}\n`;
    }
    throw failClosed(`cannot write routing record: ${error?.message ?? error}`, "routing_record_failed");
  }
}

function recordInvocationCompletion(
  validated,
  hashes,
  candidate,
  harnessResult,
  sidecars,
  steps,
  invocation,
  io,
  now,
  completionPath,
) {
  const recordDir = validated.record_dir;
  const transport = closedTransport(harnessResult, {
    status: "failed",
    stage: "run",
    errorCode: "unrecognized",
  });
  const usage = closedUsage(harnessResult);
  let routingRecord;
  try {
    routingRecord = buildRoutingRecord(
      validated,
      hashes.promptSha,
      usage,
      transport,
      harnessResult?.effectiveModel,
    );
    const routingPath = join(recordDir, "routing-record.json");
    const routingBody = writeRoutingRecordExclusive(routingPath, routingRecord, io);
    sidecars.routing = sidecarRef(routingPath, bytesOf(routingBody));
  } catch (error) {
    steps.routing_record = "failed";
    steps.telemetry = "skipped";
    routingRecord = undefined;
    try {
      appendRunnerError(recordDir, {
        step: "routing_record",
        code: "routing_record_failed",
        message: error?.message ?? "routing record failed",
      }, { ...io, now });
    } catch {
      // Bookkeeping failure is recorded in completion.recording.
    }
  }
  const completion = buildCompletion(validated, hashes, candidate, harnessResult, sidecars, {
    invocation,
    routingRecord,
  });
  completion.sidecars = closeSidecars(sidecars);
  if (steps.routing_record === "ok") {
    try {
      appendAssignmentTelemetry(completion, recordDir, io);
    } catch (error) {
      steps.telemetry = "failed";
      try {
        appendRunnerError(recordDir, {
          step: "telemetry",
          code: "telemetry_failed",
          message: error?.message ?? "telemetry append failed",
        }, { ...io, now });
      } catch {
        // Immutable completion still records telemetry_failed.
      }
    }
  }
  const errorsAfter = trySidecarStat(runnerErrorsPath(recordDir), undefined, io, recordDir, steps, now);
  if (errorsAfter) {
    sidecars.runner_errors = errorsAfter;
    completion.sidecars = closeSidecars(sidecars);
  }
  completion.recording = firstRecordingFailure(steps);
  return Object.freeze(writeCompletionExclusive(completionPath, completion, io));
}

export async function runAssignment(manifest, deps = {}) {
  const io = ioDeps(deps);
  const identity = identifyAssignment(manifest, io);
  let validated;
  try {
    validated = validateAssignmentManifest(manifest, deps);
  } catch (error) {
    const code = RUNNER_CODES.includes(error?.runnerCode) ? error.runnerCode : "unknown";
    if (!identity || code === "identity_taken") throw error;
    try {
      reserveIdentity(
        identity.record_dir,
        identity.assignment_id,
        originalManifestBytes(manifest, deps),
        io,
      );
    } catch (reserveError) {
      if (reserveError?.runnerCode === "identity_taken") throw reserveError;
      throw error;
    }
    writeRefusal(identity, manifest, "validation", code, error, deps);
    throw error;
  }
  try {
    consumeOwnership(validated, manifest, io);
  } catch (error) {
    const code = RUNNER_CODES.includes(error?.runnerCode) ? error.runnerCode : "unknown";
    if (code === "identity_taken") throw error;
    if (lstatOrNull(validated.record_dir, io.lstatSync)) {
      writeRefusal(refusalIdentity(validated), manifest, "ownership", code, error, deps);
    }
    throw error;
  }
  const ledger = { invoked: false, invocation: undefined, result: undefined };
  try {
    return await dispatchOwnedAssignment(validated, manifest, deps, ledger);
  } catch (error) {
    const ioCatch = ioDeps(deps);
    const completionPath = join(validated.record_dir, "completion.json");
    if (ioCatch.existsSync(completionPath)) throw error;
    if (!ledger.invoked) {
      const code = RUNNER_CODES.includes(error?.runnerCode) ? error.runnerCode : "unknown";
      writeRefusal(refusalIdentity(validated), manifest, "prepare", code, error, deps);
      throw error;
    }
    const candidate = snapshotCandidate(validated.cwd, ioCatch.spawnSync, ioCatch.realpathSync);
    const promptPath = join(validated.record_dir, "prompt.md");
    const promptSha = ioCatch.existsSync(promptPath)
      ? sha256Bytes(ioCatch.readFileSync(promptPath))
      : sha256Bytes(Buffer.from(""));
    const harnessResult = ledger.invocation === "returned"
      ? ledger.result
      : (ledger.result ?? thrownHarnessResult(error, validated));
    const steps = {
      candidate_snapshot: candidate.status === "recorded" ? "ok" : "failed",
      sidecars: "ok",
      routing_record: "ok",
      telemetry: "ok",
    };
    const sidecars = {};
    const dispatchCandidates = [
      harnessResult?.dispatchPath,
      join(validated.output_dir, "dispatch.json"),
    ];
    for (const path of dispatchCandidates) {
      const ref = trySidecarStat(path, undefined, ioCatch, validated.record_dir, steps, deps.now);
      if (ref) {
        sidecars.harness_dispatch = ref;
        break;
      }
    }
    const answer = trySidecarStat(harnessResult?.answerPath, harnessResult?.answerBytes, ioCatch, validated.record_dir, steps, deps.now);
    if (answer) sidecars.answer = answer;
    const stderr = trySidecarStat(harnessResult?.stderrPath, harnessResult?.stderrBytes, ioCatch, validated.record_dir, steps, deps.now);
    if (stderr) sidecars.stderr = stderr;
    const helperError = trySidecarStat(harnessResult?.errorPath, harnessResult?.errorBytes, ioCatch, validated.record_dir, steps, deps.now);
    if (helperError) sidecars.error = helperError;
    return recordInvocationCompletion(
      validated,
      { manifestSha: digestManifest(manifest, deps), promptSha },
      candidate,
      harnessResult,
      sidecars,
      steps,
      ledger.invocation === "returned" ? "returned" : "thrown",
      ioCatch,
      deps.now,
      completionPath,
    );
  }
}

function expectedRecordingResolution(completion, bytes, steps) {
  return {
    schema: RECORDING_RESOLUTION_SCHEMA,
    assignment_id: completion.assignment_id,
    task_id: completion.task_id,
    completion_sha256: sha256Bytes(bytes),
    steps,
  };
}

function readExistingResolution(path, io, code = "record_write_failed") {
  return parseJsonFile(
    path,
    readRegularFile(path, io.readFileSync, io.existsSync, io.statSync, code),
    "recording resolution",
    code,
  );
}

function assertResolutionMatches(existing, expected) {
  if (!isPlainObject(existing) || existing.schema !== RECORDING_RESOLUTION_SCHEMA) {
    throw failClosed("existing recording resolution is not bound to this completion", "record_write_failed");
  }
  if (!sameStableFacts(existing, expected)) {
    throw failClosed("existing recording resolution does not match this completion", "record_write_failed");
  }
}

function writeRecordingResolved(recordDir, completion, bytes, steps, io) {
  const path = join(recordDir, "recording-resolved.json");
  const expected = expectedRecordingResolution(completion, bytes, steps);
  if (io.existsSync(path)) {
    assertResolutionMatches(readExistingResolution(path, io), expected);
    return false;
  }
  const body = `${JSON.stringify({
    ...expected,
    resolvedAt: new Date((io.now ?? Date.now)()).toISOString(),
  }, undefined, 2)}\n`;
  try {
    writePrivate(path, body, io, "wx");
    return true;
  } catch (error) {
    if (error && error.code === "EEXIST") {
      assertResolutionMatches(readExistingResolution(path, io), expected);
      return false;
    }
    throw failClosed(`cannot write recording resolution: ${error?.message ?? error}`, "record_write_failed");
  }
}

function originalRecordingSteps(completion) {
  if (completion.recording?.status === "ok") {
    return {
      candidate_snapshot: "ok",
      sidecars: "ok",
      routing_record: "ok",
      telemetry: "ok",
    };
  }
  const steps = completion.recording?.steps;
  return {
    candidate_snapshot: steps?.candidate_snapshot
      ?? (completion.candidate?.status === "recorded" ? "ok" : "failed"),
    sidecars: steps?.sidecars ?? "failed",
    routing_record: steps?.routing_record ?? "failed",
    telemetry: steps?.telemetry ?? "skipped",
  };
}

function recoverSidecarStep(original) {
  // Observe recovers routing/telemetry only. Surviving recorded refs do not
  // prove an omitted failed sidecar (for example a missing answer ref) is ok.
  return original;
}

function existingRoutingBytes(path, io) {
  return readRegularFile(path, io.readFileSync, io.existsSync, io.statSync, "routing_record_failed");
}

export async function observeAssignment(outputDir, deps = {}) {
  const io = ioDeps(deps);
  const completionPath = join(outputDir, "completion.json");
  const bytes = readRegularFile(completionPath, io.readFileSync, io.existsSync, io.statSync);
  const completion = parseJsonFile(completionPath, bytes, "assignment completion");
  if (!isPlainObject(completion) || completion.schema !== COMPLETION_SCHEMA) {
    throw failClosed(`assignment completion schema must be ${COMPLETION_SCHEMA}`, "record_write_failed");
  }
  if (completion.binding?.record_dir && !samePath(completion.binding.record_dir, outputDir, io.realpathSync)) {
    throw failClosed("completion is not bound to this record directory", "record_write_failed");
  }
  const steps = originalRecordingSteps(completion);
  if (completion.candidate?.status !== "recorded" && steps.candidate_snapshot === "ok") {
    steps.candidate_snapshot = "failed";
  }
  steps.sidecars = recoverSidecarStep(steps.sidecars);

  const routingPath = join(outputDir, "routing-record.json");
  let routingRecord;
  let expectedRouting;
  try {
    expectedRouting = routingRecordFromCompletion(completion);
  } catch (error) {
    if (io.existsSync(routingPath)) {
      existingRoutingBytes(routingPath, io);
      throw failClosed("existing routing record cannot be validated against this completion", "routing_record_failed");
    }
    steps.routing_record = "failed";
    steps.telemetry = "skipped";
    writeRecordingResolved(outputDir, completion, bytes, steps, io);
    throw failClosed(error?.message ?? "cannot rebuild routing record", "routing_record_failed");
  }
  if (io.existsSync(routingPath)) {
    const existing = parseJsonFile(
      routingPath,
      existingRoutingBytes(routingPath, io),
      "routing record",
      "routing_record_failed",
    );
    let parsed;
    try {
      parsed = parseRoutingRecord(existing);
    } catch {
      throw failClosed("existing routing record is not a bound assignment record", "routing_record_failed");
    }
    if (parsed.workflowRunId !== completion.assignment_id) {
      throw failClosed("existing routing record is bound to a foreign assignment", "routing_record_failed");
    }
    if (!sameStableFacts(parsed, expectedRouting)) {
      throw failClosed("existing routing record does not match this assignment completion", "routing_record_failed");
    }
    routingRecord = parsed;
    steps.routing_record = "ok";
  } else {
    try {
      writeRoutingRecordExclusive(routingPath, expectedRouting, io);
      routingRecord = expectedRouting;
      steps.routing_record = "ok";
    } catch (error) {
      steps.routing_record = "failed";
      steps.telemetry = "skipped";
      throw failClosed(error?.message ?? "cannot rebuild routing record", "routing_record_failed");
    }
  }
  let appended = false;
  if (steps.routing_record === "ok") {
    appended = appendAssignmentTelemetry({ ...completion, routingRecord }, outputDir, io);
    steps.telemetry = "ok";
  }
  writeRecordingResolved(outputDir, completion, bytes, steps, io);
  return appended;
}

const CLI_USAGE = "usage: assignment-run.mjs run --manifest <absolute-path> | observe --record-dir <absolute-path>";

export async function main(argv = process.argv, io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }) {
  const args = argv.slice(2).filter((arg) => arg !== "--");
  if (args.includes("--task-dir")) {
    throw failClosed("run --manifest does not accept --task-dir; task_dir comes from the manifest", "manifest_invalid");
  }
  if (args[0] === "observe") {
    if (args[1] !== "--record-dir" || typeof args[2] !== "string" || args.length !== 3) {
      throw failClosed(CLI_USAGE, "manifest_invalid");
    }
    const recordDir = args[2];
    if (!nodePath.isAbsolute(recordDir)) {
      throw failClosed("--record-dir must be an absolute path", "manifest_invalid");
    }
    try {
      await observeAssignment(recordDir);
      const resolutionPath = join(recordDir, "recording-resolved.json");
      const resolution = parseJsonFile(
        resolutionPath,
        readRegularFile(resolutionPath, readFileSync, existsSync, statSync),
        "recording resolution",
      );
      io.stdout.write(`${JSON.stringify(resolution, undefined, 2)}\n`);
      const unresolved = Object.values(resolution.steps ?? {}).some((step) => step === "failed");
      process.exitCode = unresolved ? 1 : 0;
      return resolution;
    } catch (error) {
      const code = error?.runnerCode && RUNNER_CODES.includes(error.runnerCode)
        ? error.runnerCode
        : "unknown";
      io.stderr.write(`${code}: ${error.message}\n`);
      process.exitCode = 1;
      throw error;
    }
  }
  if (args[0] !== "run" || args[1] !== "--manifest" || typeof args[2] !== "string" || args.length !== 3) {
    throw failClosed(CLI_USAGE, "manifest_invalid");
  }
  const manifestPath = args[2];
  if (!nodePath.isAbsolute(manifestPath)) {
    throw failClosed("--manifest must be an absolute path", "manifest_invalid");
  }
  const bytes = readFileSync(manifestPath);
  const manifest = parseJsonFile(manifestPath, bytes, "assignment manifest");
  try {
    const completion = await runAssignment(manifest, { manifestBytes: bytes });
    io.stdout.write(`${JSON.stringify(completion, undefined, 2)}\n`);
    process.exitCode = completion.transport?.ok === true && completion.recording?.status === "ok" ? 0 : 1;
    return completion;
  } catch (error) {
    const code = error?.runnerCode && RUNNER_CODES.includes(error.runnerCode)
      ? error.runnerCode
      : "unknown";
    io.stderr.write(`${code}: ${error.message}\n`);
    process.exitCode = 1;
    throw error;
  }
}

function invokedAsMain() {
  const self = fileURLToPath(import.meta.url);
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return sameInvokedPath(argv1, self);
}

if (invokedAsMain()) {
  main().catch((error) => {
    if (error?.failClosed && process.exitCode === 1) return;
    const code = error?.runnerCode && RUNNER_CODES.includes(error.runnerCode)
      ? error.runnerCode
      : "unknown";
    process.stderr.write(`${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

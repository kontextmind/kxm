#!/usr/bin/env node
// Dev assignment helper. M3a is exported pure validation: no spawn, identity
// consumption, dispatch, or .git writes. M3b adds role templates, exclusive
// identity/output consume, one-shot v2 harness dispatch, immutable completion,
// and one pending telemetry append. M4a adds fixed verify/validate-ci
// witness execution, stored-manifest identity/plan/recording binding,
// and candidate-bound private receipts. M4b W1 adds exact-commit developer
// acceptance from the latest passed verify receipt and designated critics.
// Not a product assignment layer.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
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
  "completion_missing",
  "completion_invalid",
  "witness_binding_invalid",
  "plan_mismatch",
  "recording_unresolved",
  "dirty_baseline",
  "gate_failed",
  "candidate_changed",
  "commit_missing",
  "commit_tree_mismatch",
  "witness_missing",
  "witness_stale",
  "witness_failed",
  "critic_invalid",
  "critic_tree_mismatch",
  "critic_block",
  "accepted_exists",
  "record_outside_task",
  "unknown",
]);
export const VERIFY_WITNESS_ID = "verify";
export const VALIDATE_CI_WITNESS_ID = "validate-ci";
export const WITNESS_IDS = Object.freeze(["verify", "validate-ci"]);
export const FIXED_GATES = Object.freeze({
  verify: Object.freeze(["npm", "run", "verify"]),
  "validate-ci": Object.freeze(["npm", "run", "validate:ci"]),
});
export const WITNESS_SCHEMA = "kxm.assignment-witness.v1";
export const WITNESS_LATEST_SCHEMA = "kxm.assignment-witness-latest.v1";
export const WITNESS_RESULTS = Object.freeze(["passed", "failed", "refused"]);
export const WITNESS_CODES = Object.freeze([
  "completion_missing",
  "completion_invalid",
  "witness_binding_invalid",
  "plan_mismatch",
  "recording_unresolved",
  "dirty_baseline",
  "snapshot_failed",
  "gate_failed",
  "candidate_changed",
  "record_write_failed",
  "unknown",
]);
export const ACCEPTED_SCHEMA = "kxm.task-accepted.v1";
export const ACCEPTED_FILENAME = "accepted.json";
export const ACCEPTED_NOTE = "developer record; not human approval, hub peer evidence, CI success, or merged/released status";
export const REQUIRED_ACCEPT_CRITICS = Object.freeze({
  "review-arch": Object.freeze({ harness: "claude", model: "fable", role: "reviewer-arch" }),
  "review-cli": Object.freeze({ harness: "codex", model: "gpt-5.6-sol", role: "reviewer-cli" }),
});
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

function comparableOutputBinding(outputDir, taskDir, recordDir, cwd, lstatImpl, realpathImpl) {
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
  return { out, record };
}

function validateOutputDir(outputDir, taskDir, recordDir, cwd, lstatImpl, realpathImpl) {
  const compared = comparableOutputBinding(outputDir, taskDir, recordDir, cwd, lstatImpl, realpathImpl);
  if (lstatOrNull(outputDir, lstatImpl)) {
    throw failClosed(`output_dir already exists: ${outputDir}`, "output_dir_exists");
  }
  return compared;
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
    readdirSync: deps.readdirSync ?? readdirSync,
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

const CLI_USAGE = "usage: assignment-run.mjs run --manifest <absolute-path> | observe --record-dir <absolute-path> | witness --record-dir <absolute-path> | accept --task-dir <absolute-path> --commit <commit> --record-dir <absolute-path> --critic <absolute-path> --critic <absolute-path> [--observed-pr <id>] [--observed-ci <id>]";

const WITNESS_RECEIPT_KEYS = Object.freeze([
  "schema",
  "receipt_id",
  "task_id",
  "assignment_id",
  "kind",
  "recordedAt",
  "manifest",
  "completion",
  "plan",
  "binding",
  "candidate",
  "gates",
  "result",
  "code",
  "startedAt",
  "finishedAt",
  "durationMs",
]);
const WITNESS_LATEST_KEYS = Object.freeze([
  "schema",
  "task_id",
  "assignment_id",
  "receipt_id",
  "path",
  "sha256",
  "recordedAt",
  "result",
]);
const WITNESS_DIRNAME = "witness";
const WITNESS_HISTORY_DIRNAME = "history";
const WITNESS_LATEST_FILENAME = "latest.json";

function witnessCode(code) {
  return WITNESS_CODES.includes(code) ? code : "unknown";
}

function isWitnessDirty(records) {
  return records.some((record) => isUnmergedRecord(record) || record.y !== " ");
}

function snapshotWitnessCandidate(cwd, spawnSyncImpl, realpathImpl) {
  try {
    const gitState = inspectWorktree(cwd, spawnSyncImpl, realpathImpl);
    const { result, stdout } = runGit(cwd, ["write-tree"], spawnSyncImpl);
    if (result.status !== 0) {
      return Object.freeze({ status: "unknown", code: "snapshot_failed" });
    }
    const indexTree = stdout.trim();
    if (!HEX40.test(indexTree)) {
      return Object.freeze({ status: "unknown", code: "snapshot_failed" });
    }
    return Object.freeze({
      status: "recorded",
      head: gitState.head,
      index_tree: indexTree,
      clean: !isWitnessDirty(gitState.statusRecords),
    });
  } catch {
    return Object.freeze({ status: "unknown", code: "snapshot_failed" });
  }
}

function recordedSnapshot(snapshot) {
  if (snapshot?.status === "recorded") {
    return Object.freeze({
      head: snapshot.head,
      index_tree: snapshot.index_tree,
      clean: snapshot.clean === true,
    });
  }
  return Object.freeze({ status: "unknown", code: snapshot?.code === "snapshot_failed" ? "snapshot_failed" : "unknown" });
}

function witnessDir(recordDir) {
  return join(recordDir, WITNESS_DIRNAME);
}

function witnessHistoryDir(recordDir) {
  return join(witnessDir(recordDir), WITNESS_HISTORY_DIRNAME);
}

function witnessLatestPath(recordDir) {
  return join(witnessDir(recordDir), WITNESS_LATEST_FILENAME);
}

function nextWitnessReceiptId(historyDir, now, existsImpl) {
  const iso = new Date(now()).toISOString().replace(/[-:.]/g, "");
  let id = `w-${iso}`;
  let n = 2;
  while (existsImpl(join(historyDir, `${id}.json`))) {
    id = `w-${iso}-${n}`;
    n += 1;
  }
  return id;
}

function loadWitnessCompletion(recordDir, io) {
  const completionPath = join(recordDir, "completion.json");
  if (!io.existsSync(completionPath)) {
    throw failClosed(`missing assignment completion: ${completionPath}`, "completion_missing");
  }
  const bytes = readRegularFile(completionPath, io.readFileSync, io.existsSync, io.statSync, "completion_invalid");
  const completion = parseJsonFile(completionPath, bytes, "assignment completion", "completion_invalid");
  if (!isPlainObject(completion) || completion.schema !== COMPLETION_SCHEMA) {
    throw failClosed(`assignment completion schema must be ${COMPLETION_SCHEMA}`, "completion_invalid");
  }
  if (completion.binding?.record_dir && !samePath(completion.binding.record_dir, recordDir, io.realpathSync)) {
    throw failClosed("completion is not bound to this record directory", "witness_binding_invalid");
  }
  return { completion, bytes, path: completionPath };
}

function loadStoredManifest(recordDir, completion, io) {
  const path = join(recordDir, "manifest.json");
  const bytes = readRegularFile(path, io.readFileSync, io.existsSync, io.statSync, "witness_binding_invalid");
  const sha = sha256Bytes(bytes);
  if (typeof completion.manifest?.sha256 !== "string" || sha !== completion.manifest.sha256) {
    throw failClosed("stored manifest digest does not match completion.manifest.sha256", "witness_binding_invalid");
  }
  const manifest = parseJsonFile(path, bytes, "stored assignment manifest", "witness_binding_invalid");
  return { manifest, path, sha256: sha };
}

function bindWitnessIdentityFromCompletion(completion, recordDir, io) {
  const taskId = requireIdentity(completion.task_id, "completion.task_id", "witness_binding_invalid");
  const assignmentId = requireIdentity(completion.assignment_id, "completion.assignment_id", "witness_binding_invalid");
  const binding = closedObject(
    completion.binding,
    ["task_dir", "cwd", "record_dir", "output_dir"],
    "completion.binding",
    [],
    "witness_binding_invalid",
  );
  const taskDir = validateTaskDir(binding.task_dir, taskId, io.existsSync, io.statSync, io.realpathSync);
  if (!samePath(binding.record_dir, recordDir, io.realpathSync)) {
    throw failClosed("completion.binding.record_dir does not match --record-dir", "witness_binding_invalid");
  }
  const cwd = resolvePath(requireNonemptyString(binding.cwd, "completion.binding.cwd", "witness_binding_invalid"));
  if (!io.existsSync(cwd)) {
    throw failClosed(`cwd does not exist: ${cwd}`, "witness_binding_invalid");
  }
  return Object.freeze({
    task_id: taskId,
    assignment_id: assignmentId,
    kind: typeof completion.kind === "string" ? completion.kind : undefined,
    task_dir: taskDir,
    cwd,
    record_dir: comparablePath(recordDir, io.realpathSync, io.lstatSync),
    output_dir: resolvePath(binding.output_dir),
  });
}

function validateStoredManifestBinding(manifest, recordDir, io) {
  closedObject(manifest, ASSIGNMENT_KEYS, "stored assignment manifest", OPTIONAL_ASSIGNMENT_KEYS, "witness_binding_invalid");
  if (manifest.schema !== ASSIGNMENT_SCHEMA) {
    throw failClosed(`stored assignment schema must be ${ASSIGNMENT_SCHEMA}`, "witness_binding_invalid");
  }
  const taskId = requireIdentity(manifest.task_id, "stored task_id", "witness_binding_invalid");
  const assignmentId = requireIdentity(manifest.assignment_id, "stored assignment_id", "witness_binding_invalid");
  if (!ASSIGNMENT_KINDS.includes(manifest.kind)) {
    throw failClosed(`unknown stored kind ${manifest.kind}`, "witness_binding_invalid");
  }
  const cwd = resolvePath(requireNonemptyString(manifest.cwd, "stored cwd", "witness_binding_invalid"));
  if (!io.existsSync(cwd)) {
    throw failClosed(`stored cwd does not exist: ${cwd}`, "witness_binding_invalid");
  }
  const taskDir = validateTaskDir(manifest.task_dir, taskId, io.existsSync, io.statSync, io.realpathSync);
  const { role, effort } = validateRoute(manifest);
  const contract = validateContract(manifest.contract, manifest.kind);
  const requestedOutputDir = resolvePath(taskDir, requireNonemptyString(manifest.output_dir, "stored output_dir", "witness_binding_invalid"));
  const identityDir = assignmentRecordDir(taskDir, assignmentId);
  if (!samePath(identityDir, recordDir, io.realpathSync)) {
    throw failClosed("canonical record path must be task_dir/assignment_id", "witness_binding_invalid");
  }
  const compared = comparableOutputBinding(
    requestedOutputDir,
    taskDir,
    identityDir,
    cwd,
    io.lstatSync,
    io.realpathSync,
  );
  if (!isPlainObject(manifest.plan_ref) || !PLAN_REF_KINDS.includes(manifest.plan_ref.kind)) {
    throw failClosed(`stored plan_ref.kind must be ${PLAN_REF_KINDS.join(" or ")}`, "plan_mismatch");
  }
  const planRef = manifest.plan_ref.kind === "current"
    ? validateCurrentPlanRef(manifest.plan_ref, taskDir, taskId, io)
    : validateBootstrapPlanRef(manifest.plan_ref, taskDir, manifest.kind, io);
  const storedBase = closedObject(
    manifest.base,
    ["kind", "commit", "index_tree"],
    "stored base",
    ["index_tree"],
    "witness_binding_invalid",
  );
  if (!BASE_KINDS.includes(storedBase.kind)) {
    throw failClosed(`unknown stored base.kind ${storedBase.kind}`, "witness_binding_invalid");
  }
  const baseCommit = requireHex(storedBase.commit, "stored base.commit", HEX40, "witness_binding_invalid");
  const base = storedBase.kind === "staged"
    ? Object.freeze({
      kind: "staged",
      commit: baseCommit,
      index_tree: requireHex(storedBase.index_tree, "stored base.index_tree", HEX40, "witness_binding_invalid"),
    })
    : Object.freeze({ kind: "clean", commit: baseCommit });
  const reworkOf = manifest.rework_of === undefined
    ? undefined
    : requireIdentity(manifest.rework_of, "stored rework_of", "witness_binding_invalid");
  return Object.freeze({
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
    record_dir: comparablePath(recordDir, io.realpathSync, io.lstatSync),
    output_dir: compared.out,
    plan_ref: planRef,
    contract,
    base,
    ...(reworkOf ? { rework_of: reworkOf } : {}),
  });
}

function assertCompletionMatchesStored(completion, stored, io) {
  if (completion.task_id !== stored.task_id) {
    throw failClosed("completion.task_id does not match stored manifest", "witness_binding_invalid");
  }
  if (completion.assignment_id !== stored.assignment_id) {
    throw failClosed("completion.assignment_id does not match stored manifest", "witness_binding_invalid");
  }
  if (completion.kind !== stored.kind) {
    throw failClosed("completion.kind does not match stored manifest", "witness_binding_invalid");
  }
  const route = closedObject(
    completion.route,
    ["harness", "model", "effort", "permission", "role"],
    "completion.route",
    [],
    "witness_binding_invalid",
  );
  if (
    route.harness !== stored.harness
    || route.model !== stored.model
    || route.effort !== stored.effort
    || route.permission !== stored.permission
    || route.role !== stored.role
  ) {
    throw failClosed("completion.route does not match stored manifest", "witness_binding_invalid");
  }
  const binding = closedObject(
    completion.binding,
    ["task_dir", "cwd", "record_dir", "output_dir"],
    "completion.binding",
    [],
    "witness_binding_invalid",
  );
  if (!samePath(binding.task_dir, stored.task_dir, io.realpathSync)) {
    throw failClosed("completion.binding.task_dir does not match stored manifest", "witness_binding_invalid");
  }
  if (!samePath(binding.cwd, stored.cwd, io.realpathSync)) {
    throw failClosed("completion.binding.cwd does not match stored manifest", "witness_binding_invalid");
  }
  if (!samePath(binding.record_dir, stored.record_dir, io.realpathSync)) {
    throw failClosed("completion.binding.record_dir does not match stored manifest", "witness_binding_invalid");
  }
  if (!samePath(binding.output_dir, stored.output_dir, io.realpathSync)) {
    throw failClosed("completion.binding.output_dir does not match stored manifest", "witness_binding_invalid");
  }
  if ((completion.rework_of ?? undefined) !== (stored.rework_of ?? undefined)) {
    throw failClosed("completion.rework_of does not match stored manifest", "witness_binding_invalid");
  }
}

function bindWitnessPlan(completion, stored, io) {
  const storedPlan = stored.plan_ref;
  const plan = completion.plan;
  if (storedPlan.kind === "current") {
    if (plan?.kind === "bootstrap") {
      throw failClosed("stored current manifest forbids bootstrap completion", "plan_mismatch");
    }
    if (plan?.kind !== "current") {
      throw failClosed("completion.plan.kind must be current", "plan_mismatch");
    }
    const claimed = requireHex(plan.sha256, "completion.plan.sha256", HEX64, "plan_mismatch");
    if (claimed !== storedPlan.sha256) {
      throw failClosed("completion.plan.sha256 does not match stored current plan", "plan_mismatch");
    }
    if (!samePath(plan.path, storedPlan.path, io.realpathSync)) {
      throw failClosed("completion.plan.path does not match stored current plan", "plan_mismatch");
    }
    return storedPlan;
  }
  if (plan?.kind !== "bootstrap") {
    throw failClosed("bootstrap stored manifest requires bootstrap completion.plan", "plan_mismatch");
  }
  requireNonemptyString(plan.reason, "completion.plan.reason", "plan_mismatch");
  return storedPlan;
}

function recordingBookkeepingReady(steps) {
  return steps?.routing_record === "ok" && steps?.telemetry === "ok";
}

function assertWitnessRecordingReady(completion, bytes, recordDir, io) {
  const recording = completion.recording;
  if (!isPlainObject(recording)) {
    throw failClosed("completion.recording is required", "recording_unresolved");
  }
  if (recording.status === "ok") return;
  if (recording.status !== "failed") {
    throw failClosed("completion.recording.status must be ok or failed", "recording_unresolved");
  }
  const original = originalRecordingSteps(completion);
  if (recordingBookkeepingReady(original)) return;
  const resolutionPath = join(recordDir, "recording-resolved.json");
  if (!io.existsSync(resolutionPath)) {
    throw failClosed("unresolved routing or telemetry recording must be recovered before witness", "recording_unresolved");
  }
  const resolution = readExistingResolution(resolutionPath, io, "recording_unresolved");
  closedObject(
    resolution,
    ["schema", "assignment_id", "task_id", "resolvedAt", "completion_sha256", "steps"],
    "recording resolution",
    ["resolvedAt"],
    "recording_unresolved",
  );
  if (resolution.schema !== RECORDING_RESOLUTION_SCHEMA) {
    throw failClosed("recording resolution schema is invalid", "recording_unresolved");
  }
  if (resolution.assignment_id !== completion.assignment_id || resolution.task_id !== completion.task_id) {
    throw failClosed("recording resolution is not bound to this assignment", "recording_unresolved");
  }
  const expectedSteps = {
    candidate_snapshot: original.candidate_snapshot,
    sidecars: recoverSidecarStep(original.sidecars),
    routing_record: "ok",
    telemetry: "ok",
  };
  try {
    assertResolutionMatches(resolution, expectedRecordingResolution(completion, bytes, expectedSteps));
  } catch (error) {
    throw failClosed(error?.message ?? "recording resolution does not match this completion", "recording_unresolved");
  }
  if (!recordingBookkeepingReady(resolution.steps)) {
    throw failClosed("recording resolution did not recover routing and telemetry", "recording_unresolved");
  }
}

function witnessBindingCode(error) {
  const code = error?.runnerCode;
  if (code === "plan_ref_invalid" || code === "plan_mismatch") return "plan_mismatch";
  if (code === "recording_unresolved") return "recording_unresolved";
  if (WITNESS_CODES.includes(code)) return code;
  return "witness_binding_invalid";
}

function fallbackWitnessPlan(completion) {
  if (completion.plan?.kind === "bootstrap") {
    return Object.freeze({ kind: "bootstrap", reason: completion.plan.reason });
  }
  return Object.freeze({ kind: "current", sha256: completion.plan?.sha256 });
}

function writeEarlyWitnessRefusal(recordDir, io, identity, stored, loaded, plan, code, startedAt, startedMs, now) {
  const receiptId = nextWitnessReceiptId(witnessHistoryDir(recordDir), now, io.existsSync);
  const finishedAt = new Date(now()).toISOString();
  return writeWitnessReceipt(recordDir, {
    schema: WITNESS_SCHEMA,
    receipt_id: receiptId,
    task_id: identity.task_id,
    assignment_id: identity.assignment_id,
    kind: identity.kind,
    recordedAt: finishedAt,
    manifest: Object.freeze({ path: stored.path, sha256: stored.sha256 }),
    completion: Object.freeze({ path: loaded.path, sha256: sha256Bytes(loaded.bytes) }),
    plan: plan ?? fallbackWitnessPlan(loaded.completion),
    binding: Object.freeze({
      task_dir: identity.task_dir,
      cwd: identity.cwd,
      record_dir: identity.record_dir,
    }),
    candidate: Object.freeze({}),
    gates: [],
    result: "refused",
    code,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.now() - startedMs),
  }, {}, io);
}

function contractedWitnessId(manifest) {
  const id = manifest?.contract?.witness?.id;
  if (!WITNESS_IDS.includes(id)) {
    throw failClosed("stored contract.witness.id is not a fixed gate", "witness_binding_invalid");
  }
  if (WRITER_KINDS.includes(manifest.kind) && id !== VERIFY_WITNESS_ID) {
    throw failClosed("implement and repair require the fixed verify witness", "witness_binding_invalid");
  }
  return id;
}

function gatesForWitnessId(witnessId) {
  return Object.freeze(WITNESS_IDS.filter((id) => id === witnessId).map((id) => ({
    id,
    argv: [...FIXED_GATES[id]],
  })));
}

function runFixedGate(gate, cwd, spawnSyncImpl, env) {
  const argv = [...FIXED_GATES[gate.id]];
  const started = Date.now();
  const result = spawnSyncImpl(argv[0], argv.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  const durationMs = Math.max(0, Date.now() - started);
  return {
    id: gate.id,
    argv,
    shell: false,
    cwd,
    exitCode: Number.isInteger(result?.status) ? result.status : result?.status === null ? null : null,
    signal: typeof result?.signal === "string" ? result.signal : null,
    timedOut: false,
    durationMs,
    stdout: String(result?.stdout ?? ""),
    stderr: String(result?.stderr ?? ""),
    spawnError: result?.error ? String(result.error.code ?? result.error.message ?? "spawn_failed") : undefined,
  };
}

function gateSucceeded(gate) {
  return gate.exitCode === 0 && gate.signal == null && !gate.spawnError;
}

function ensureWitnessDirs(recordDir, io) {
  const root = witnessDir(recordDir);
  const history = witnessHistoryDir(recordDir);
  try {
    if (!io.existsSync(root)) io.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!io.existsSync(history)) io.mkdirSync(history, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw failClosed(`cannot create witness directories: ${error?.message ?? error}`, "record_write_failed");
  }
  return { root, history };
}

function pickPublicWitness(receipt) {
  const picked = {};
  for (const key of WITNESS_RECEIPT_KEYS) {
    if (receipt[key] !== undefined) picked[key] = receipt[key];
  }
  return picked;
}

function writeWitnessLatest(recordDir, receipt, receiptPath, receiptSha, io) {
  const latest = {
    schema: WITNESS_LATEST_SCHEMA,
    task_id: receipt.task_id,
    assignment_id: receipt.assignment_id,
    receipt_id: receipt.receipt_id,
    path: receiptPath,
    sha256: receiptSha,
    recordedAt: receipt.recordedAt,
    result: receipt.result,
  };
  const body = `${JSON.stringify(latest, undefined, 2)}\n`;
  const path = witnessLatestPath(recordDir);
  writePrivate(path, body, io, "w");
  return sidecarRef(path, bytesOf(body));
}

function writeWitnessReceipt(recordDir, receipt, logs, io) {
  const dirs = ensureWitnessDirs(recordDir, io);
  const receiptId = receipt.receipt_id;
  const artifactDir = join(dirs.history, receiptId);
  try {
    io.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw failClosed(`cannot create witness receipt directory: ${error?.message ?? error}`, "record_write_failed");
  }
  const publicGates = [];
  for (const gate of receipt.gates) {
    const logName = `${gate.id}.log`;
    const logPath = join(artifactDir, logName);
    const logBody = logs[gate.id] ?? "";
    writePrivate(logPath, logBody, io, "wx");
    publicGates.push(Object.freeze({
      id: gate.id,
      argv: Object.freeze([...gate.argv]),
      shell: false,
      cwd: gate.cwd,
      exitCode: gate.exitCode,
      signal: gate.signal,
      timedOut: gate.timedOut === true,
      durationMs: gate.durationMs,
      log: sidecarRef(logPath, bytesOf(logBody)),
    }));
  }
  const publicReceipt = pickPublicWitness({
    ...receipt,
    gates: Object.freeze(publicGates),
  });
  const receiptPath = join(dirs.history, `${receiptId}.json`);
  const body = `${JSON.stringify(publicReceipt, undefined, 2)}\n`;
  writePrivate(receiptPath, body, io, "wx");
  const sha = sha256Bytes(Buffer.from(body));
  writeWitnessLatest(recordDir, publicReceipt, receiptPath, sha, io);
  return Object.freeze({ ...publicReceipt, path: receiptPath, sha256: sha });
}

function isRecordedWitnessSnapshot(snapshot) {
  return Boolean(
    snapshot
    && snapshot.status !== "unknown"
    && typeof snapshot.head === "string"
    && HEX40.test(snapshot.head)
    && typeof snapshot.index_tree === "string"
    && HEX40.test(snapshot.index_tree),
  );
}

function classifyWitnessResult({ before, after, gates, ranGates }) {
  if (!ranGates) {
    if (!isRecordedWitnessSnapshot(before)) return { result: "refused", code: "snapshot_failed" };
    if (before.clean !== true) return { result: "refused", code: "dirty_baseline" };
    return { result: "refused", code: "unknown" };
  }
  const gateFail = gates.some((gate) => !gateSucceeded(gate));
  if (!isRecordedWitnessSnapshot(after)) {
    return { result: "failed", code: gateFail ? "gate_failed" : "snapshot_failed" };
  }
  const unchanged = before.head === after.head
    && before.index_tree === after.index_tree
    && before.clean === true
    && after.clean === true;
  if (gateFail) return { result: "failed", code: "gate_failed" };
  if (!unchanged) return { result: "failed", code: "candidate_changed" };
  return { result: "passed" };
}

export async function witnessAssignment(recordDirValue, deps = {}) {
  const io = ioDeps(deps);
  const startedMs = Date.now();
  const startedAt = new Date((deps.now ?? Date.now)()).toISOString();
  if (typeof recordDirValue !== "string" || !nodePath.isAbsolute(recordDirValue)) {
    throw failClosed("--record-dir must be an absolute path", "manifest_invalid");
  }
  if (!io.existsSync(recordDirValue)) {
    throw failClosed(`record directory does not exist: ${recordDirValue}`, "completion_missing");
  }
  const recordDir = comparablePath(recordDirValue, io.realpathSync, io.lstatSync);
  const loaded = loadWitnessCompletion(recordDir, io);
  const completion = loaded.completion;
  const stored = loadStoredManifest(recordDir, completion, io);
  const now = deps.now ?? Date.now;
  let identity;
  let plan;
  try {
    identity = validateStoredManifestBinding(stored.manifest, recordDir, io);
    assertCompletionMatchesStored(completion, identity, io);
    plan = bindWitnessPlan(completion, identity, io);
    assertWitnessRecordingReady(completion, loaded.bytes, recordDir, io);
  } catch (error) {
    if (!identity) {
      try {
        identity = bindWitnessIdentityFromCompletion(completion, recordDir, io);
      } catch {
        identity = Object.freeze({
          task_id: typeof stored.manifest.task_id === "string" ? stored.manifest.task_id : completion.task_id,
          assignment_id: typeof stored.manifest.assignment_id === "string" ? stored.manifest.assignment_id : completion.assignment_id,
          kind: typeof stored.manifest.kind === "string" ? stored.manifest.kind : completion.kind,
          task_dir: resolvePath(stored.manifest.task_dir ?? completion.binding?.task_dir ?? recordDir),
          cwd: resolvePath(stored.manifest.cwd ?? completion.binding?.cwd ?? recordDir),
          record_dir: recordDir,
        });
      }
    }
    return writeEarlyWitnessRefusal(
      recordDir,
      io,
      identity,
      stored,
      loaded,
      plan,
      witnessBindingCode(error),
      startedAt,
      startedMs,
      now,
    );
  }

  let witnessId;
  try {
    witnessId = contractedWitnessId(stored.manifest);
  } catch (error) {
    return writeEarlyWitnessRefusal(
      recordDir,
      io,
      identity,
      stored,
      loaded,
      plan,
      witnessCode(error?.runnerCode),
      startedAt,
      startedMs,
      now,
    );
  }

  const before = snapshotWitnessCandidate(identity.cwd, io.spawnSync, io.realpathSync);
  const candidate = { before: recordedSnapshot(before) };
  const dirtyOrUnknown = before.status !== "recorded" || before.clean !== true;
  const logs = {};
  let gates = [];
  let ranGates = false;
  if (!dirtyOrUnknown) {
    ranGates = true;
    const env = deps.env ?? process.env;
    gates = gatesForWitnessId(witnessId).map((gate) => {
      const executed = runFixedGate(gate, identity.cwd, io.spawnSync, env);
      logs[executed.id] = [
        `argv=${JSON.stringify(executed.argv)}`,
        `shell=false`,
        `cwd=${executed.cwd}`,
        `exitCode=${executed.exitCode}`,
        `signal=${executed.signal ?? ""}`,
        executed.spawnError ? `spawnError=${executed.spawnError}` : "",
        executed.stdout ? `stdout:\n${executed.stdout}` : "",
        executed.stderr ? `stderr:\n${executed.stderr}` : "",
      ].filter((line) => line !== "").join("\n");
      return executed;
    });
    candidate.after = recordedSnapshot(snapshotWitnessCandidate(identity.cwd, io.spawnSync, io.realpathSync));
  }

  const classified = classifyWitnessResult({
    before,
    after: candidate.after,
    gates,
    ranGates,
  });
  const receiptId = nextWitnessReceiptId(witnessHistoryDir(recordDir), deps.now ?? Date.now, io.existsSync);
  const finishedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const receipt = {
    schema: WITNESS_SCHEMA,
    receipt_id: receiptId,
    task_id: identity.task_id,
    assignment_id: identity.assignment_id,
    kind: identity.kind,
    recordedAt: finishedAt,
    manifest: Object.freeze({ path: stored.path, sha256: stored.sha256 }),
    completion: Object.freeze({ path: loaded.path, sha256: sha256Bytes(loaded.bytes) }),
    plan,
    binding: Object.freeze({
      task_dir: identity.task_dir,
      cwd: identity.cwd,
      record_dir: identity.record_dir,
    }),
    candidate: Object.freeze(candidate),
    gates,
    result: classified.result,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.now() - startedMs),
  };
  if (classified.code) receipt.code = classified.code;
  return writeWitnessReceipt(recordDir, receipt, logs, io);
}

const ACCEPT_SINGLETONS = Object.freeze([
  "--task-dir",
  "--commit",
  "--record-dir",
  "--observed-pr",
  "--observed-ci",
]);
const ACCEPTED_KEYS = Object.freeze([
  "schema",
  "task_id",
  "commit",
  "tree",
  "writer",
  "plan",
  "critics",
  "acceptedAt",
  "observed",
  "note",
]);
const ACCEPTED_WRITER_KEYS = Object.freeze([
  "assignment_id",
  "record_dir",
  "kind",
  "completion",
  "manifest",
  "receipt",
]);
const ACCEPTED_CRITIC_KEYS = Object.freeze([
  "kind",
  "role",
  "harness",
  "model",
  "assignment_id",
  "record_dir",
  "completion",
  "verdict",
  "judged_tree",
]);
const ACCEPTED_LINK_KEYS = Object.freeze(["path", "sha256"]);
const ACCEPTED_RECEIPT_KEYS = Object.freeze(["id", "path", "sha256"]);
const OBSERVED_ID_KEYS = Object.freeze(["id", "validated"]);
const TASK_DIR_SKIP_NAMES = Object.freeze([
  PLAN_POINTER_FILENAME,
  ACCEPTED_FILENAME,
  "runner-errors.jsonl",
  "plan-history",
]);

function parseAcceptCli(args) {
  if (args[0] !== "accept") {
    throw failClosed(CLI_USAGE, "manifest_invalid");
  }
  const rest = args.slice(1);
  const seen = new Set();
  const critics = [];
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (typeof flag !== "string" || !flag.startsWith("--")) {
      throw failClosed(CLI_USAGE, "manifest_invalid");
    }
    if (flag !== "--critic" && !ACCEPT_SINGLETONS.includes(flag)) {
      throw failClosed(`unknown accept option ${flag}`, "manifest_invalid");
    }
    const value = rest[index + 1];
    if (typeof value !== "string" || value.length === 0) {
      throw failClosed(`missing value for ${flag}`, "manifest_invalid");
    }
    index += 1;
    if (flag === "--critic") {
      critics.push(value);
      continue;
    }
    if (seen.has(flag)) {
      throw failClosed(`duplicate option ${flag}`, "manifest_invalid");
    }
    seen.add(flag);
    values[flag] = value;
  }
  if (values["--task-dir"] === undefined || values["--commit"] === undefined || values["--record-dir"] === undefined) {
    throw failClosed(CLI_USAGE, "manifest_invalid");
  }
  if (critics.length !== 2) {
    throw failClosed("accept requires exactly two --critic record directories", "manifest_invalid");
  }
  return Object.freeze({
    taskDir: values["--task-dir"],
    commit: values["--commit"],
    recordDir: values["--record-dir"],
    critics: Object.freeze([...critics]),
    observedPr: values["--observed-pr"],
    observedCi: values["--observed-ci"],
  });
}

function requireAbsoluteExistingDir(value, label, code, io) {
  const path = requireNonemptyString(value, label, code);
  if (!nodePath.isAbsolute(path)) {
    throw failClosed(`${label} must be an absolute path`, code);
  }
  if (!io.existsSync(path)) {
    throw failClosed(`${label} does not exist: ${path}`, code);
  }
  let stat;
  try {
    stat = io.statSync(path);
  } catch {
    throw failClosed(`${label} is not a directory: ${path}`, code);
  }
  if (!stat.isDirectory()) {
    throw failClosed(`${label} is not a directory: ${path}`, code);
  }
  return comparablePath(path, io.realpathSync, io.lstatSync);
}

function assertCanonicalRecordDir(taskDir, recordDirValue, label, io) {
  const path = requireNonemptyString(recordDirValue, label, "manifest_invalid");
  if (!nodePath.isAbsolute(path)) {
    throw failClosed(`${label} must be an absolute path`, "manifest_invalid");
  }
  if (!io.existsSync(path)) {
    throw failClosed(`${label} does not exist: ${path}`, "completion_missing");
  }
  let stat;
  try {
    stat = io.lstatSync(path);
  } catch {
    throw failClosed(`${label} is not a directory: ${path}`, "record_outside_task");
  }
  if (!stat.isDirectory()) {
    throw failClosed(`${label} is not a directory: ${path}`, "record_outside_task");
  }
  const recordDir = comparablePath(path, io.realpathSync, io.lstatSync);
  if (dirname(recordDir) !== taskDir) {
    throw failClosed(`${label} must be a canonical direct child of task_dir`, "record_outside_task");
  }
  const assignmentId = basename(recordDir);
  if (!IDENTITY.test(assignmentId)) {
    throw failClosed(`${label} directory name must be a stable identity token`, "record_outside_task");
  }
  return recordDir;
}

function loadStructurallyBoundAssignment(recordDir, expectedTaskDir, io) {
  const loaded = loadWitnessCompletion(recordDir, io);
  const stored = loadStoredManifest(recordDir, loaded.completion, io);
  let identity;
  try {
    identity = validateStoredManifestBinding(stored.manifest, recordDir, io);
    if (!samePath(identity.task_dir, expectedTaskDir, io.realpathSync)) {
      throw failClosed("stored assignment task_dir does not match --task-dir", "witness_binding_invalid");
    }
    assertCompletionMatchesStored(loaded.completion, identity, io);
    const plan = bindWitnessPlan(loaded.completion, identity, io);
    return { loaded, stored, identity, plan, completion: loaded.completion };
  } catch (error) {
    if (error?.runnerCode === "plan_ref_invalid") {
      throw failClosed(error.message, "plan_mismatch");
    }
    throw error;
  }
}

function loadBoundAssignment(recordDir, expectedTaskDir, io) {
  const bound = loadStructurallyBoundAssignment(recordDir, expectedTaskDir, io);
  assertWitnessRecordingReady(bound.completion, bound.loaded.bytes, recordDir, io);
  return bound;
}

function listHistoryReceiptIds(recordDir, io) {
  const historyDir = witnessHistoryDir(recordDir);
  if (!io.existsSync(historyDir)) return [];
  let names;
  try {
    names = io.readdirSync(historyDir);
  } catch (error) {
    throw failClosed(`cannot read witness history: ${error?.message ?? error}`, "witness_missing");
  }
  const ids = [];
  for (const name of names) {
    const entry = typeof name === "string" ? name : name?.name;
    if (typeof entry !== "string" || !entry.endsWith(".json")) continue;
    ids.push(entry.slice(0, -5));
  }
  return ids;
}

function loadLatestPassedWitness(recordDir, identity, stored, io) {
  const latestPath = witnessLatestPath(recordDir);
  if (!io.existsSync(latestPath)) {
    throw failClosed("missing latest witness pointer", "witness_missing");
  }
  const latestBytes = readRegularFile(latestPath, io.readFileSync, io.existsSync, io.statSync, "witness_missing");
  const latest = parseJsonFile(latestPath, latestBytes, "latest witness pointer", "witness_stale");
  closedObject(latest, WITNESS_LATEST_KEYS, "latest witness pointer", [], "witness_stale");
  if (latest.schema !== WITNESS_LATEST_SCHEMA) {
    throw failClosed(`latest witness schema must be ${WITNESS_LATEST_SCHEMA}`, "witness_stale");
  }
  if (latest.task_id !== identity.task_id || latest.assignment_id !== identity.assignment_id) {
    throw failClosed("latest witness pointer is not bound to this assignment", "witness_stale");
  }
  const receiptPath = requireNonemptyString(latest.path, "latest.path", "witness_stale");
  if (!nodePath.isAbsolute(receiptPath)) {
    throw failClosed("latest witness path must be absolute", "witness_stale");
  }
  const historyDir = comparablePath(witnessHistoryDir(recordDir), io.realpathSync, io.lstatSync);
  const receiptDir = comparablePath(dirname(receiptPath), io.realpathSync, io.lstatSync);
  if (receiptDir !== historyDir) {
    throw failClosed("latest witness receipt is not in this assignment history", "witness_stale");
  }
  const receiptBytes = readRegularFile(receiptPath, io.readFileSync, io.existsSync, io.statSync, "witness_missing");
  const actualSha = sha256Bytes(receiptBytes);
  if (actualSha !== requireHex(latest.sha256, "latest.sha256", HEX64, "witness_stale")) {
    throw failClosed("latest witness receipt digest does not match", "witness_stale");
  }
  const receipt = parseJsonFile(receiptPath, receiptBytes, "witness receipt", "witness_stale");
  if (!isPlainObject(receipt) || receipt.schema !== WITNESS_SCHEMA) {
    throw failClosed(`witness receipt schema must be ${WITNESS_SCHEMA}`, "witness_stale");
  }
  if (receipt.receipt_id !== latest.receipt_id) {
    throw failClosed("latest witness pointer does not match receipt_id", "witness_stale");
  }
  for (const id of listHistoryReceiptIds(recordDir, io)) {
    if (id > latest.receipt_id) {
      throw failClosed("latest witness pointer is stale", "witness_stale");
    }
  }
  if (receipt.result !== "passed") {
    throw failClosed("latest witness receipt is not passed", "witness_failed");
  }
  if (receipt.task_id !== identity.task_id || receipt.assignment_id !== identity.assignment_id) {
    throw failClosed("witness receipt identity does not match stored assignment", "witness_binding_invalid");
  }
  if (receipt.kind !== identity.kind) {
    throw failClosed("witness receipt kind does not match stored assignment", "witness_binding_invalid");
  }
  if (typeof receipt.manifest?.sha256 !== "string" || receipt.manifest.sha256 !== stored.sha256) {
    throw failClosed("witness receipt manifest digest does not match stored manifest", "witness_binding_invalid");
  }
  return { latest, receipt, path: receiptPath, sha256: actualSha };
}

function assertReceiptMatchesWriter(receipt, identity, stored, loaded, plan, io) {
  if (typeof receipt.manifest?.sha256 !== "string" || receipt.manifest.sha256 !== stored.sha256) {
    throw failClosed("witness receipt manifest digest does not match stored manifest", "witness_binding_invalid");
  }
  if (typeof receipt.completion?.sha256 !== "string" || receipt.completion.sha256 !== sha256Bytes(loaded.bytes)) {
    throw failClosed("witness receipt completion digest does not match", "witness_binding_invalid");
  }
  if (!samePath(receipt.binding?.task_dir, identity.task_dir, io.realpathSync)) {
    throw failClosed("witness receipt task_dir does not match stored assignment", "witness_binding_invalid");
  }
  if (!samePath(receipt.binding?.cwd, identity.cwd, io.realpathSync)) {
    throw failClosed("witness receipt cwd does not match stored assignment", "witness_binding_invalid");
  }
  if (!samePath(receipt.binding?.record_dir, identity.record_dir, io.realpathSync)) {
    throw failClosed("witness receipt record_dir does not match stored assignment", "witness_binding_invalid");
  }
  if (plan.kind === "current") {
    if (receipt.plan?.kind !== "current") {
      throw failClosed("witness receipt plan is not current", "plan_mismatch");
    }
    if (receipt.plan.sha256 !== plan.sha256) {
      throw failClosed("witness receipt plan hash does not match current plan", "plan_mismatch");
    }
  }
  if (!Array.isArray(receipt.gates) || receipt.gates.length < 1) {
    throw failClosed("passed witness receipt is missing the contracted verify gate", "witness_failed");
  }
  const verify = receipt.gates.find((gate) => gate.id === VERIFY_WITNESS_ID);
  if (!verify) {
    throw failClosed("passed witness receipt is missing the contracted verify gate", "witness_failed");
  }
  if (!Array.isArray(verify.argv) || verify.argv.length !== 3
    || verify.argv[0] !== "npm" || verify.argv[1] !== "run" || verify.argv[2] !== "verify") {
    throw failClosed("witness verify argv is not the fixed gate", "witness_failed");
  }
  if (verify.shell !== false) {
    throw failClosed("witness gates must execute shell:false", "witness_failed");
  }
  for (const gate of receipt.gates) {
    if (!samePath(gate.cwd, identity.cwd, io.realpathSync)) {
      throw failClosed("witness gate cwd does not match stored assignment cwd", "witness_binding_invalid");
    }
    if (gate.exitCode !== 0 || gate.signal != null || gate.timedOut === true) {
      throw failClosed("witness gate exits are not all successful", "witness_failed");
    }
  }
  const before = receipt.candidate?.before;
  const after = receipt.candidate?.after;
  if (!isRecordedWitnessSnapshot(before) || !isRecordedWitnessSnapshot(after)) {
    throw failClosed("passed witness receipt is missing recorded snapshots", "witness_failed");
  }
  if (before.clean !== true || after.clean !== true
    || before.head !== after.head
    || before.index_tree !== after.index_tree) {
    throw failClosed("witness before/after snapshots are not identical and clean", "witness_failed");
  }
  return before.index_tree;
}

function assertCurrentPlanAgreement(identity, completion, receipt, io) {
  if (identity.plan_ref.kind !== "current") {
    throw failClosed("acceptance requires a current plan pointer", "plan_mismatch");
  }
  const pointerPath = pointerPathFor(identity.task_dir);
  const pointerBytes = readRegularFile(pointerPath, io.readFileSync, io.existsSync, io.statSync, "plan_mismatch");
  const pointer = validatePointer(parseJsonFile(pointerPath, pointerBytes, "plan pointer", "plan_mismatch"));
  if (pointer.task_id !== identity.task_id) {
    throw failClosed("current plan pointer task_id does not match assignment", "plan_mismatch");
  }
  const planPath = resolvePath(identity.task_dir, pointer.plan_path);
  if (!samePath(planPath, identity.plan_ref.path, io.realpathSync)) {
    throw failClosed("current plan path does not match stored plan_ref", "plan_mismatch");
  }
  const planBytes = readRegularFile(planPath, io.readFileSync, io.existsSync, io.statSync, "plan_mismatch");
  const actual = sha256Bytes(planBytes);
  if (pointer.plan_sha256 !== actual || identity.plan_ref.sha256 !== actual) {
    throw failClosed("current plan pointer hash does not match plan file digest", "plan_mismatch");
  }
  if (completion.plan?.kind !== "current" || completion.plan.sha256 !== actual) {
    throw failClosed("completion plan hash does not match current plan", "plan_mismatch");
  }
  if (receipt.plan?.kind !== "current" || receipt.plan.sha256 !== actual) {
    throw failClosed("witness receipt plan hash does not match current plan", "plan_mismatch");
  }
  if (pointer.generation !== identity.plan_ref.generation) {
    throw failClosed("current plan generation does not match stored plan_ref", "plan_mismatch");
  }
  return Object.freeze({
    kind: "current",
    path: identity.plan_ref.path,
    sha256: actual,
    pointer_path: pointerPath,
    generation: pointer.generation,
  });
}

function proveAcceptedCommit(cwd, commitValue, spawnSyncImpl) {
  const commit = requireNonemptyString(commitValue, "--commit", "commit_missing");
  const typeRun = runGit(cwd, ["cat-file", "-t", commit], spawnSyncImpl);
  if (typeRun.result.status !== 0 || typeRun.stdout.trim() !== "commit") {
    throw failClosed(`--commit is not an existing commit object`, "commit_missing");
  }
  const resolvedRun = runGit(cwd, ["rev-parse", commit], spawnSyncImpl);
  const resolved = resolvedRun.stdout.trim();
  if (resolvedRun.result.status !== 0 || !HEX40.test(resolved)) {
    throw failClosed(`--commit is not an existing commit object`, "commit_missing");
  }
  const treeRun = runGit(cwd, ["rev-parse", `${commit}^{tree}`], spawnSyncImpl);
  const tree = treeRun.stdout.trim();
  if (treeRun.result.status !== 0 || !HEX40.test(tree)) {
    throw failClosed(`cannot derive tree for commit ${commit}`, "commit_missing");
  }
  return Object.freeze({ commit: resolved, tree });
}

function observedId(value, label) {
  if (value === undefined) return undefined;
  const id = requireNonemptyString(value, label, "manifest_invalid");
  return Object.freeze({ id, validated: false });
}

function closedObserved(pr, ci) {
  const observed = {};
  if (pr) observed.pr = pr;
  if (ci) observed.ci = ci;
  if (observed.pr) closedObject(observed.pr, OBSERVED_ID_KEYS, "observed.pr", [], "manifest_invalid");
  if (observed.ci) closedObject(observed.ci, OBSERVED_ID_KEYS, "observed.ci", [], "manifest_invalid");
  return Object.freeze(observed);
}

function assertEligibleWriter(bound) {
  if (!WRITER_KINDS.includes(bound.identity.kind)) {
    throw failClosed("acceptance writer must be implement or repair", "witness_binding_invalid");
  }
  const transport = bound.completion.transport;
  if (!(transport?.status === "completed" && transport?.ok === true)) {
    throw failClosed("writer transport is not completed/ok", "witness_binding_invalid");
  }
}

function requiredCriticSpec(kind) {
  const spec = REQUIRED_ACCEPT_CRITICS[kind];
  if (!spec) {
    throw failClosed(`unsupported critic kind ${kind}`, "critic_invalid");
  }
  return spec;
}

function declaredReviewedTree(identity, spawnSyncImpl) {
  const base = identity.base;
  if (!base || !HEX40.test(base.commit)) {
    throw failClosed("stored critic base.commit is missing", "critic_invalid");
  }
  if (base.kind === "staged") {
    return requireHex(base.index_tree, "stored base.index_tree", HEX40, "critic_tree_mismatch");
  }
  const treeRun = runGit(identity.cwd, ["rev-parse", `${base.commit}^{tree}`], spawnSyncImpl);
  const tree = treeRun.stdout.trim();
  if (treeRun.result.status !== 0 || !HEX40.test(tree)) {
    throw failClosed("cannot derive stored critic baseline tree", "critic_tree_mismatch");
  }
  return tree;
}

function assertEligibleCritic(bound, acceptedTree, io, writer) {
  const kind = bound.identity.kind;
  const spec = requiredCriticSpec(kind);
  if (bound.identity.harness !== spec.harness || bound.identity.model !== spec.model || bound.identity.role !== spec.role) {
    throw failClosed(`critic ${kind} must use ${spec.harness}/${spec.model}`, "critic_invalid");
  }
  if (!samePath(bound.identity.task_dir, writer.identity.task_dir, io.realpathSync)) {
    throw failClosed("critic task_dir does not match writer task_dir", "critic_invalid");
  }
  const transport = bound.completion.transport;
  if (!(transport?.status === "completed" && transport?.ok === true)) {
    throw failClosed("critic transport is not completed/ok", "critic_invalid");
  }
  const candidate = bound.completion.candidate;
  if (!candidate || candidate.status !== "recorded") {
    throw failClosed("critic candidate is unknown", "critic_invalid");
  }
  if (candidate.clean !== true) {
    throw failClosed("critic candidate is not a clean recorded snapshot", "critic_invalid");
  }
  if (candidate.head !== bound.identity.base.commit) {
    throw failClosed("critic candidate head does not match stored manifest base.commit", "critic_tree_mismatch");
  }
  const reviewedTree = declaredReviewedTree(bound.identity, io.spawnSync);
  if (candidate.index_tree !== reviewedTree) {
    throw failClosed("critic candidate tree does not match stored reviewed baseline", "critic_tree_mismatch");
  }
  if (candidate.index_tree !== acceptedTree) {
    throw failClosed("critic candidate tree does not match accepted tree", "critic_tree_mismatch");
  }
  const critic = bound.completion.critic;
  if (!isPlainObject(critic) || critic.kind !== "review") {
    throw failClosed("model_claim PASS is not a critic", "critic_invalid");
  }
  if (!REVIEW_VERDICTS.includes(critic.verdict)) {
    throw failClosed("critic has no validated verdict", "critic_invalid");
  }
  if (critic.verdict === "BLOCK") {
    throw failClosed("critic verdict is BLOCK", "critic_block");
  }
  if (critic.verdict !== "PASS") {
    throw failClosed("critic verdict is not PASS", "critic_invalid");
  }
  if (critic.judged_tree !== acceptedTree) {
    throw failClosed("critic judged_tree does not match accepted tree", "critic_tree_mismatch");
  }
  if (critic.role !== spec.role) {
    throw failClosed("critic role does not match designated review role", "critic_invalid");
  }
  return Object.freeze({
    kind,
    role: spec.role,
    harness: spec.harness,
    model: spec.model,
    assignment_id: bound.identity.assignment_id,
    record_dir: bound.identity.record_dir,
    completion: Object.freeze({
      path: bound.loaded.path,
      sha256: sha256Bytes(bound.loaded.bytes),
    }),
    verdict: "PASS",
    judged_tree: acceptedTree,
  });
}

function listDirectAssignmentDirs(taskDir, io) {
  let names;
  try {
    names = io.readdirSync(taskDir);
  } catch (error) {
    throw failClosed(`cannot read task_dir: ${error?.message ?? error}`, "unknown");
  }
  const dirs = [];
  for (const name of names) {
    const entry = typeof name === "string" ? name : name?.name;
    if (typeof entry !== "string" || TASK_DIR_SKIP_NAMES.includes(entry)) continue;
    if (!IDENTITY.test(entry)) continue;
    const path = join(taskDir, entry);
    const stat = lstatOrNull(path, io.lstatSync);
    if (!stat || !stat.isDirectory()) continue;
    dirs.push({ assignment_id: entry, path: comparablePath(path, io.realpathSync, io.lstatSync) });
  }
  return dirs;
}

function tryLoadOwnedReview(recordDir, expectedTaskDir, expectedTaskId, io) {
  try {
    // A bookkeeping failure cannot erase a structurally bound BLOCK review.
    const bound = loadStructurallyBoundAssignment(recordDir, expectedTaskDir, io);
    if (bound.identity.task_id !== expectedTaskId) return null;
    if (bound.identity.assignment_id !== basename(recordDir)) return null;
    if (!REVIEW_KINDS.includes(bound.identity.kind)) return null;
    return bound;
  } catch {
    return null;
  }
}

function reworkAncestorIds(assignmentId, byId) {
  const seen = new Set();
  let current = assignmentId;
  while (current && !seen.has(current)) {
    seen.add(current);
    current = byId.get(current)?.identity?.rework_of;
  }
  return seen;
}

function assertNoUnresolvedBlock(taskDir, critics, acceptedTree, expectedTaskId, io) {
  const dirs = listDirectAssignmentDirs(taskDir, io);
  const reviews = [];
  for (const dir of dirs) {
    const bound = tryLoadOwnedReview(dir.path, taskDir, expectedTaskId, io);
    if (!bound) continue;
    reviews.push(bound);
  }
  const byId = new Map(reviews.map((item) => [item.identity.assignment_id, item]));
  for (const kind of Object.keys(REQUIRED_ACCEPT_CRITICS)) {
    const supplied = critics.find((item) => item.kind === kind);
    if (!supplied) {
      throw failClosed(`missing designated ${kind} critic`, "critic_invalid");
    }
    const ancestors = reworkAncestorIds(supplied.assignment_id, byId);
    for (const review of reviews) {
      if (review.identity.kind !== kind) continue;
      const critic = review.completion.critic;
      if (!isPlainObject(critic) || critic.kind !== "review" || critic.verdict !== "BLOCK") continue;
      if (critic.judged_tree !== acceptedTree) continue;
      if (ancestors.has(review.identity.assignment_id) && review.identity.assignment_id !== supplied.assignment_id) {
        continue;
      }
      throw failClosed("unresolved critic BLOCK remains for the accepted tree", "critic_block");
    }
  }
}

function writeAcceptedRecord(taskDir, record, io) {
  const path = join(taskDir, ACCEPTED_FILENAME);
  if (lstatOrNull(path, io.lstatSync)) {
    throw failClosed("accepted.json already exists", "accepted_exists");
  }
  const body = `${JSON.stringify(record, undefined, 2)}\n`;
  try {
    writePrivate(path, body, io, "wx");
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw failClosed("accepted.json already exists", "accepted_exists");
    }
    throw failClosed(`cannot write accepted.json: ${error?.message ?? error}`, "record_write_failed");
  }
  return Object.freeze({ ...record, path, sha256: sha256Bytes(Buffer.from(body)) });
}

function logAcceptError(taskDir, error, io) {
  if (!taskDir) return;
  const code = RUNNER_CODES.includes(error?.runnerCode) ? error.runnerCode : "unknown";
  try {
    appendRunnerError(taskDir, {
      step: "accept",
      code,
      message: error?.message ?? "accept failed",
    }, io);
  } catch {
    // Public refusal already carries the bounded code.
  }
}

export async function acceptAssignment(request, deps = {}) {
  const io = ioDeps(deps);
  let taskDir = null;
  try {
    const taskDirValue = request?.taskDir ?? request?.task_dir;
    const commitValue = request?.commit;
    const writerRecordValue = request?.recordDir ?? request?.record_dir;
    const criticValues = request?.critics;
    if (!Array.isArray(criticValues) || criticValues.length !== 2) {
      throw failClosed("accept requires exactly two --critic record directories", "manifest_invalid");
    }
    taskDir = requireAbsoluteExistingDir(taskDirValue, "--task-dir", "manifest_invalid", io);
    const writerDir = assertCanonicalRecordDir(taskDir, writerRecordValue, "--record-dir", io);
    const criticDirs = criticValues.map((value, index) => (
      assertCanonicalRecordDir(taskDir, value, `--critic[${index}]`, io)
    ));
    if (new Set([writerDir, ...criticDirs]).size !== 3) {
      throw failClosed("writer and critic record directories must be distinct", "critic_invalid");
    }
    const writer = loadBoundAssignment(writerDir, taskDir, io);
    assertEligibleWriter(writer);
    const witness = loadLatestPassedWitness(
      writerDir,
      writer.identity,
      writer.stored,
      io,
    );
    const witnessedTree = assertReceiptMatchesWriter(
      witness.receipt,
      writer.identity,
      writer.stored,
      writer.loaded,
      writer.plan,
      io,
    );
    const plan = assertCurrentPlanAgreement(writer.identity, writer.completion, witness.receipt, io);
    const proven = proveAcceptedCommit(writer.identity.cwd, commitValue, io.spawnSync);
    if (proven.tree !== witnessedTree) {
      throw failClosed("commit tree does not equal the latest passed witness index_tree", "commit_tree_mismatch");
    }
    const criticEvidence = criticDirs.map((dir) => {
      const bound = loadBoundAssignment(dir, taskDir, io);
      return assertEligibleCritic(bound, proven.tree, io, writer);
    });
    const kinds = criticEvidence.map((item) => item.kind);
    if (new Set(kinds).size !== 2) {
      throw failClosed("critics must be distinct review-arch and review-cli roles", "critic_invalid");
    }
    for (const kind of Object.keys(REQUIRED_ACCEPT_CRITICS)) {
      if (!kinds.includes(kind)) {
        throw failClosed(`missing designated ${kind} critic`, "critic_invalid");
      }
    }
    assertNoUnresolvedBlock(taskDir, criticEvidence, proven.tree, writer.identity.task_id, io);
    const observed = closedObserved(
      observedId(request.observedPr ?? request.observed_pr, "--observed-pr"),
      observedId(request.observedCi ?? request.observed_ci, "--observed-ci"),
    );
    const acceptedAt = new Date((deps.now ?? Date.now)()).toISOString();
    const writerEvidence = Object.freeze({
      assignment_id: writer.identity.assignment_id,
      record_dir: writer.identity.record_dir,
      kind: writer.identity.kind,
      completion: Object.freeze({
        path: writer.loaded.path,
        sha256: sha256Bytes(writer.loaded.bytes),
      }),
      manifest: Object.freeze({
        path: writer.stored.path,
        sha256: writer.stored.sha256,
      }),
      receipt: Object.freeze({
        id: witness.receipt.receipt_id,
        path: witness.path,
        sha256: witness.sha256,
      }),
    });
    closedObject(writerEvidence, ACCEPTED_WRITER_KEYS, "accepted.writer", [], "unknown");
    for (const critic of criticEvidence) {
      closedObject(critic, ACCEPTED_CRITIC_KEYS, "accepted.critic", [], "unknown");
      closedObject(critic.completion, ACCEPTED_LINK_KEYS, "accepted.critic.completion", [], "unknown");
    }
    closedObject(writerEvidence.completion, ACCEPTED_LINK_KEYS, "accepted.writer.completion", [], "unknown");
    closedObject(writerEvidence.manifest, ACCEPTED_LINK_KEYS, "accepted.writer.manifest", [], "unknown");
    closedObject(writerEvidence.receipt, ACCEPTED_RECEIPT_KEYS, "accepted.writer.receipt", [], "unknown");
    const record = Object.freeze({
      schema: ACCEPTED_SCHEMA,
      task_id: writer.identity.task_id,
      commit: proven.commit,
      tree: proven.tree,
      writer: writerEvidence,
      plan,
      critics: Object.freeze(criticEvidence),
      acceptedAt,
      observed,
      note: ACCEPTED_NOTE,
    });
    closedObject(record, ACCEPTED_KEYS, "accepted", [], "unknown");
    return writeAcceptedRecord(taskDir, record, io);
  } catch (error) {
    logAcceptError(taskDir, error, io);
    throw error;
  }
}

export async function main(argv = process.argv, io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }) {
  const args = argv.slice(2).filter((arg) => arg !== "--");
  if (args[0] === "accept") {
    try {
      const parsed = parseAcceptCli(args);
      const accepted = await acceptAssignment({
        taskDir: parsed.taskDir,
        commit: parsed.commit,
        recordDir: parsed.recordDir,
        critics: parsed.critics,
        observedPr: parsed.observedPr,
        observedCi: parsed.observedCi,
      }, {
        spawnSync: io.spawnSync ?? spawnSync,
        env: io.env,
        now: io.now,
      });
      io.stdout.write(`${JSON.stringify(accepted, undefined, 2)}\n`);
      process.exitCode = 0;
      return accepted;
    } catch (error) {
      const code = error?.runnerCode && RUNNER_CODES.includes(error.runnerCode)
        ? error.runnerCode
        : "unknown";
      io.stderr.write(`${code}: ${error.message}\n`);
      process.exitCode = 1;
      throw error;
    }
  }
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
  if (args[0] === "witness") {
    if (args[1] !== "--record-dir" || typeof args[2] !== "string" || args.length !== 3) {
      throw failClosed(CLI_USAGE, "manifest_invalid");
    }
    const recordDir = args[2];
    if (!nodePath.isAbsolute(recordDir)) {
      throw failClosed("--record-dir must be an absolute path", "manifest_invalid");
    }
    try {
      const receipt = await witnessAssignment(recordDir, {
        spawnSync: io.spawnSync ?? spawnSync,
        env: io.env,
        now: io.now,
      });
      io.stdout.write(`${JSON.stringify(receipt, undefined, 2)}\n`);
      process.exitCode = receipt.result === "passed" ? 0 : 1;
      return receipt;
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

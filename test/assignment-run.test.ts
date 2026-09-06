import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import test from "node:test";
import {
  ASSIGNMENT_SCHEMA,
  COMPLETION_SCHEMA,
  PLAN_POINTER_FILENAME,
  PLAN_POINTER_SCHEMA,
  validateAssignmentManifest,
} from "../scripts/assignment-run.mjs";
import { makeGitRoot } from "./helpers/git-root.ts";

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitDirPath(root: string): string {
  const marker = join(root, ".git");
  const st = lstatSync(marker);
  if (st.isDirectory()) return marker;
  const text = readFileSync(marker, "utf8");
  const match = /^gitdir:\s*(.*)\s*$/m.exec(text);
  assert.ok(match, "expected gitdir pointer");
  return join(root, match[1]!.trim());
}

function snapshotTree(dir: string): Map<string, { size: number; sha: string }> {
  const files = new Map<string, { size: number; sha: string }>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        const buf = readFileSync(full);
        files.set(relative(dir, full), { size: buf.length, sha: sha256(buf) });
      }
    }
  };
  walk(dir);
  return files;
}

function worktreeSnapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(relative(root, full), sha256(readFileSync(full)));
    }
  };
  walk(root);
  return files;
}

function gitSnapshot(root: string): {
  files: Map<string, { size: number; sha: string }>;
  lock: boolean;
  objects: string[];
} {
  const gitDir = gitDirPath(root);
  const files = snapshotTree(gitDir);
  const objects = [...files.keys()].filter((path) => path.startsWith("objects/") && !path.includes("/pack/") && path !== "objects/info/packs").sort();
  return {
    files,
    lock: existsSync(join(gitDir, "index.lock")),
    objects,
  };
}

function recordingSpawnSync() {
  const calls: Array<[string, string[]]> = [];
  const impl = ((command: string, args?: readonly string[], options?: object) => {
    calls.push([command, [...(args ?? [])]]);
    if (command !== "git") {
      throw new Error(`unexpected provider command ${command}`);
    }
    return spawnSync(command, args, options);
  }) as typeof spawnSync;
  return { calls, spawnSync: impl };
}

function assertAllowedGitArgv(calls: Array<[string, string[]]>, cwd: string): void {
  const allowed = new Set(["rev-parse", "status", "cat-file", "diff-index"]);
  for (const [command, args] of calls) {
    assert.equal(command, "git");
    assert.equal(args[0], "--no-optional-locks");
    assert.equal(args[1], "-C");
    assert.equal(args[2], cwd);
    assert.equal(allowed.has(args[3]!), true, `unexpected git subcommand ${args[3]}`);
    assert.equal(args.includes("write-tree"), false);
    assert.equal(args.includes("update-index"), false);
    assert.equal(args.includes("diff"), false);
  }
}

function initRepo(): { root: string; commit: string } {
  const root = mkdtempSync(join(tmpdir(), "kxm-asg-"));
  makeGitRoot(root);
  writeFileSync(join(root, "README.md"), "repo\n");
  writeFileSync(join(root, ".gitignore"), ".kxm/logs/\n*.log\n");
  git(root, ["add", "README.md", ".gitignore"]);
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"]);
  return { root, commit: git(root, ["rev-parse", "HEAD"]) };
}

function initTask(taskId = "task-a"): string {
  const parent = mkdtempSync(join(tmpdir(), "kxm-task-"));
  const taskDir = join(parent, taskId);
  mkdirSync(taskDir);
  return taskDir;
}

function cleanup(root: string, taskDir: string, extra: string[] = []): void {
  rmSync(root, { recursive: true, force: true });
  rmSync(dirname(taskDir), { recursive: true, force: true });
  for (const path of extra) rmSync(path, { recursive: true, force: true });
}

function writePlan(
  taskDir: string,
  taskId: string,
  body = "# plan\n",
  commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
): { planPath: string; sha: string; pointerPath: string } {
  const planPath = join(taskDir, "plan-current.md");
  writeFileSync(planPath, body);
  const sha = sha256(body);
  const pointerPath = join(taskDir, PLAN_POINTER_FILENAME);
  writeFileSync(pointerPath, `${JSON.stringify({
    schema: PLAN_POINTER_SCHEMA,
    task_id: taskId,
    generation: 1,
    plan_path: "plan-current.md",
    plan_sha256: sha,
    base_commit: commit,
    settled_decisions: ["start"],
    updated_at: "2026-09-06T00:00:00.000Z",
    supersedes: [],
  }, null, 2)}\n`);
  return { planPath, sha, pointerPath };
}

function writeInput(root: string, name = "input.md", body = "brief\n"): { path: string; sha: string } {
  const dir = join(root, ".kxm", "logs", "inputs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  return { path, sha: sha256(body) };
}

function writerManifest(
  root: string,
  commit: string,
  taskDir: string,
  overrides: Record<string, unknown> = {},
) {
  const taskId = "task-a";
  const assignmentId = "asg-writer-1";
  const { sha } = writePlan(taskDir, taskId, "# plan\n", commit);
  const input = writeInput(root);
  return {
    schema: ASSIGNMENT_SCHEMA,
    task_id: taskId,
    assignment_id: assignmentId,
    kind: "implement",
    harness: "grok",
    model: "grok-4.6",
    effort: "high",
    permission: "edit",
    cwd: root,
    task_dir: taskDir,
    base: { kind: "clean", commit },
    plan_ref: { kind: "current", path: "plan-current.md", sha256: sha },
    inputs: [{ path: input.path, sha256: input.sha }],
    contract: {
      boundary: "Add assignment validation only.",
      deliverables: ["scripts/assignment-run.mjs"],
      witness: { id: "verify" },
      deferred: ["templates"],
    },
    output_dir: assignmentId,
    ...overrides,
  };
}

function reviewerManifest(
  root: string,
  commit: string,
  indexTree: string,
  taskDir: string,
  overrides: Record<string, unknown> = {},
) {
  const taskId = "task-a";
  const assignmentId = "asg-review-1";
  const { sha } = writePlan(taskDir, taskId, "# plan\n", commit);
  return {
    schema: ASSIGNMENT_SCHEMA,
    task_id: taskId,
    assignment_id: assignmentId,
    kind: "review-arch",
    harness: "claude",
    model: "fable",
    effort: "high",
    permission: "read-only",
    cwd: root,
    task_dir: taskDir,
    base: { kind: "staged", commit, index_tree: indexTree },
    plan_ref: { kind: "current", path: "plan-current.md", sha256: sha },
    inputs: [],
    contract: {
      boundary: "Review the staged candidate.",
      deliverables: [],
      witness: { id: "verify" },
      deferred: [],
    },
    output_dir: assignmentId,
    ...overrides,
  };
}

function planManifest(root: string, commit: string, taskDir: string, overrides: Record<string, unknown> = {}) {
  return {
    schema: ASSIGNMENT_SCHEMA,
    task_id: "task-a",
    assignment_id: "asg-plan-1",
    kind: "plan",
    harness: "claude",
    model: "fable",
    effort: "high",
    permission: "read-only",
    cwd: root,
    task_dir: taskDir,
    base: { kind: "clean", commit },
    plan_ref: { kind: "bootstrap", reason: "no current pointer" },
    inputs: [],
    contract: {
      boundary: "Draft the first plan.",
      deliverables: [],
      witness: { id: "verify" },
      deferred: [],
    },
    output_dir: "asg-plan-1",
    ...overrides,
  };
}

function assertUnchanged(
  root: string,
  beforeWorktree: Map<string, string>,
  beforeGit: ReturnType<typeof gitSnapshot>,
  extraMissing: string[] = [],
) {
  const afterWorktree = worktreeSnapshot(root);
  assert.deepEqual([...afterWorktree.entries()], [...beforeWorktree.entries()]);
  const afterGit = gitSnapshot(root);
  assert.equal(afterGit.lock, false);
  assert.equal(beforeGit.lock, false);
  assert.deepEqual([...afterGit.files.entries()], [...beforeGit.files.entries()]);
  assert.deepEqual(afterGit.objects, beforeGit.objects);
  for (const path of extraMissing) {
    assert.equal(existsSync(path), false);
  }
}

test("clean writer accepts with ignored task logs and does not spawn or mutate", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    mkdirSync(join(root, ".kxm", "logs", "task-a"), { recursive: true });
    writeFileSync(join(root, ".kxm", "logs", "task-a", "noise.log"), "ignored\n");
    writeFileSync(join(root, "scratch.log"), "also ignored\n");
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    const { calls, spawnSync: spawn } = recordingSpawnSync();
    const validated = validateAssignmentManifest(manifest, { spawnSync: spawn });
    assert.equal(validated.kind, "implement");
    assert.equal(validated.role, "writer");
    assert.equal(validated.task_dir, realpathSync(taskDir));
    assert.equal(validated.git.head, commit);
    assert.equal(validated.git.clean, true);
    assert.equal(validated.git.index_tree, git(root, ["rev-parse", "HEAD^{tree}"]));
    assert.equal(validated.plan_ref.kind, "current");
    if (validated.plan_ref.kind === "current") {
      assert.equal(validated.plan_ref.pointer_path, join(realpathSync(taskDir), PLAN_POINTER_FILENAME));
    }
    assert.equal(existsSync(validated.output_dir), false);
    assert.equal(existsSync(join(taskDir, "asg-writer-1")), false);
    assertAllowedGitArgv(calls, root);
    assert.equal(calls.some(([, args]) => args[3] === "cat-file"), false);
    assertUnchanged(root, beforeWorktree, beforeGit, [validated.output_dir]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("staged reviewer accepts a matching index with no unstaged changes", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    writeFileSync(join(root, "README.md"), "repo\nstaged\n");
    git(root, ["add", "README.md"]);
    const indexTree = git(root, ["write-tree"]);
    const manifest = reviewerManifest(root, commit, indexTree, taskDir);
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    const { calls, spawnSync: spawn } = recordingSpawnSync();
    const validated = validateAssignmentManifest(manifest, { spawnSync: spawn });
    assert.equal(validated.kind, "review-arch");
    assert.equal(validated.base.kind, "staged");
    assert.equal(validated.git.index_tree, indexTree);
    assert.equal(validated.git.clean, true);
    assert.notEqual(indexTree, git(root, ["rev-parse", "HEAD^{tree}"]));
    assert.equal(existsSync(validated.output_dir), false);
    assertAllowedGitArgv(calls, root);
    assert.equal(calls.some(([, args]) => args.slice(3).join(" ") === `cat-file -t ${indexTree}`), true);
    assertUnchanged(root, beforeWorktree, beforeGit, [validated.output_dir]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("dirty writer with unstaged tracked edits refuses without spawn or mutation", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    writeFileSync(join(root, "README.md"), "dirty\n");
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    const { calls, spawnSync: spawn } = recordingSpawnSync();
    assert.throws(
      () => validateAssignmentManifest(manifest, { spawnSync: spawn }),
      /unstaged tracked edits|unignored untracked/,
    );
    assertAllowedGitArgv(calls, root);
    assert.equal(calls.some(([command, args]) => command !== "git" || args.includes("grok")), false);
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-writer-1")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("writer clean base refuses when the index differs from HEAD", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    writeFileSync(join(root, "README.md"), "repo\nindex\n");
    git(root, ["add", "README.md"]);
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    const { spawnSync: spawn } = recordingSpawnSync();
    assert.throws(
      () => validateAssignmentManifest(manifest, { spawnSync: spawn }),
      /unstaged tracked edits|unignored untracked|index tree to equal HEAD/,
    );
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-writer-1")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("writer refuses when base.commit is not HEAD", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const other = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    assert.notEqual(commit, other);
    const manifest = writerManifest(root, other, taskDir);
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    assert.throws(() => validateAssignmentManifest(manifest), /does not match HEAD/);
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-writer-1")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("input hash mismatch refuses before any provider command", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const inputs = manifest.inputs as Array<{ path: string; sha256: string }>;
    writeFileSync(inputs[0]!.path, "corrupted\n");
    const { calls, spawnSync: spawn } = recordingSpawnSync();
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    assert.throws(
      () => validateAssignmentManifest(manifest, { spawnSync: spawn }),
      /inputs\[0\] content does not match sha256/,
    );
    assert.equal(calls.every(([command]) => command === "git"), true);
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-writer-1")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("plan file corruption against the claimed hash refuses", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    writeFileSync(join(taskDir, "plan-current.md"), "# corrupted plan\n");
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    assert.throws(() => validateAssignmentManifest(manifest), /plan file content does not match/);
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-writer-1")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("obsolete plan pointer hash refuses even if the file matches plan_ref", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const planRef = manifest.plan_ref as { path: string; sha256: string };
    const pointerPath = join(taskDir, PLAN_POINTER_FILENAME);
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as Record<string, unknown>;
    pointer.plan_sha256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    writeFileSync(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    assert.throws(() => validateAssignmentManifest(manifest), /does not match the current plan pointer/);
    assert.equal(planRef.sha256, sha256(readFileSync(join(taskDir, "plan-current.md"))));
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-writer-1")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("implement bootstrap plan_ref is refused", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir, {
      plan_ref: { kind: "bootstrap", reason: "first plan" },
    });
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    assert.throws(() => validateAssignmentManifest(manifest), /bootstrap plan_ref is only allowed/);
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-writer-1")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("plan bootstrap is refused when a current pointer already exists", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    writePlan(taskDir, "task-a", "# plan\n", commit);
    const manifest = planManifest(root, commit, taskDir);
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    assert.throws(() => validateAssignmentManifest(manifest), /pointer already exists/);
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-plan-1")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("plan bootstrap accepts when no pointer exists and creates no output dir", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = planManifest(root, commit, taskDir);
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    const validated = validateAssignmentManifest(manifest);
    assert.equal(validated.plan_ref.kind, "bootstrap");
    assert.equal(existsSync(join(taskDir, "asg-plan-1")), false);
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-plan-1")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("duplicate assignment identity refuses a still-fresh output path", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const outputDir = join(taskDir, "fresh-output");
    const identityDir = join(taskDir, "asg-writer-1");
    const manifest = writerManifest(root, commit, taskDir, { output_dir: "fresh-output" });
    mkdirSync(identityDir, { recursive: true });
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    assert.throws(() => validateAssignmentManifest(manifest), /assignment_id asg-writer-1 is already present/);
    assert.equal(existsSync(outputDir), false);
    assertUnchanged(root, beforeWorktree, beforeGit, [outputDir]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("duplicate output_dir refuses without creating or spawning", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const outputDir = join(taskDir, "already-out");
    mkdirSync(outputDir);
    const manifest = writerManifest(root, commit, taskDir, { output_dir: "already-out" });
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    const { calls, spawnSync: spawn } = recordingSpawnSync();
    assert.throws(
      () => validateAssignmentManifest(manifest, { spawnSync: spawn }),
      /output_dir already exists/,
    );
    assert.equal(statSync(outputDir).isDirectory(), true);
    assert.equal(readdirSync(outputDir).length, 0);
    assert.equal(calls.every(([command]) => command === "git"), true);
    assertUnchanged(root, beforeWorktree, beforeGit);
  } finally {
    cleanup(root, taskDir);
  }
});

test("broken rework_of with a missing completion refuses", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir, { rework_of: "asg-prior-1" });
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    assert.throws(() => validateAssignmentManifest(manifest), /does not point at an existing completion/);
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-writer-1")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("rework_of with a malformed completion schema refuses", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const priorDir = join(taskDir, "asg-prior-1");
    mkdirSync(priorDir, { recursive: true });
    writeFileSync(join(priorDir, "completion.json"), `${JSON.stringify({
      schema: "kxm.assignment-completion.v0",
      assignment_id: "asg-prior-1",
      task_id: "task-a",
    })}\n`);
    const manifest = writerManifest(root, commit, taskDir, { rework_of: "asg-prior-1" });
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    assert.throws(() => validateAssignmentManifest(manifest), /rework completion schema/);
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-writer-1")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("rework_of accepts an existing same-task completion without consuming identity", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const priorDir = join(taskDir, "asg-prior-1");
    mkdirSync(priorDir, { recursive: true });
    writeFileSync(join(priorDir, "completion.json"), `${JSON.stringify({
      schema: COMPLETION_SCHEMA,
      assignment_id: "asg-prior-1",
      task_id: "task-a",
    })}\n`);
    const manifest = writerManifest(root, commit, taskDir, { rework_of: "asg-prior-1" });
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    const validated = validateAssignmentManifest(manifest);
    assert.equal(validated.rework_of, "asg-prior-1");
    assert.equal(existsSync(validated.output_dir), false);
    assertUnchanged(root, beforeWorktree, beforeGit, [validated.output_dir]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("unknown nested contract field is refused", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    (manifest.contract as Record<string, unknown>).scope = "extra";
    assert.throws(() => validateAssignmentManifest(manifest), /unknown contract field/);
  } finally {
    cleanup(root, taskDir);
  }
});

test("unknown nested base field is refused", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    (manifest.base as Record<string, unknown>).tree = commit;
    assert.throws(() => validateAssignmentManifest(manifest), /unknown base field/);
  } finally {
    cleanup(root, taskDir);
  }
});

test("unknown top-level assignment field is refused", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir, { prompt_file: "nope.md" });
    assert.throws(() => validateAssignmentManifest(manifest), /unknown assignment field/);
  } finally {
    cleanup(root, taskDir);
  }
});

test("missing explicit effort is refused", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    delete (manifest as { effort?: string }).effort;
    assert.throws(() => validateAssignmentManifest(manifest), /effort is required/);
  } finally {
    cleanup(root, taskDir);
  }
});

test("unsupported native pair is refused with zero provider invocation", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir, { harness: "claude", model: "fable", permission: "read-only" });
    const { calls, spawnSync: spawn } = recordingSpawnSync();
    assert.throws(
      () => validateAssignmentManifest(manifest, { spawnSync: spawn }),
      /does not accept role writer/,
    );
    assert.equal(calls.length, 0);
  } finally {
    cleanup(root, taskDir);
  }
});

test("writer without deliverables is refused", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    (manifest.contract as { deliverables: string[] }).deliverables = [];
    assert.throws(() => validateAssignmentManifest(manifest), /at least one deliverable/);
  } finally {
    cleanup(root, taskDir);
  }
});

test("writer with a non-verify witness is refused", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    (manifest.contract as { witness: { id: string } }).witness.id = "validate-ci";
    assert.throws(() => validateAssignmentManifest(manifest), /fixed verify witness/);
  } finally {
    cleanup(root, taskDir);
  }
});

test("reviewer staged base refuses leftover unstaged worktree edits", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    writeFileSync(join(root, "README.md"), "repo\nstaged\n");
    git(root, ["add", "README.md"]);
    const indexTree = git(root, ["write-tree"]);
    writeFileSync(join(root, "README.md"), "repo\nstaged\nand unstaged\n");
    const manifest = reviewerManifest(root, commit, indexTree, taskDir);
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    assert.throws(() => validateAssignmentManifest(manifest), /unstaged tracked edits|unignored untracked/);
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-review-1")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("current plan pointer task identity mismatch is refused", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask("other-task");
  try {
    writePlan(taskDir, "task-a", "# plan\n", commit);
    const input = writeInput(root);
    const manifest = {
      schema: ASSIGNMENT_SCHEMA,
      task_id: "other-task",
      assignment_id: "asg-writer-1",
      kind: "implement",
      harness: "grok",
      model: "grok-4.6",
      effort: "high",
      permission: "edit",
      cwd: root,
      task_dir: taskDir,
      base: { kind: "clean", commit },
      plan_ref: { kind: "current", path: "plan-current.md", sha256: sha256("# plan\n") },
      inputs: [{ path: input.path, sha256: input.sha }],
      contract: {
        boundary: "Add assignment validation only.",
        deliverables: ["scripts/assignment-run.mjs"],
        witness: { id: "verify" },
        deferred: ["templates"],
      },
      output_dir: "asg-writer-1",
    };
    assert.throws(() => validateAssignmentManifest(manifest), /task_id does not match/);
  } finally {
    cleanup(root, taskDir);
  }
});

test("codex max_turns is an unsupported option", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    writeFileSync(join(root, "README.md"), "repo\nstaged\n");
    git(root, ["add", "README.md"]);
    const indexTree = git(root, ["write-tree"]);
    const manifest = reviewerManifest(root, commit, indexTree, taskDir, {
      kind: "review-cli",
      harness: "codex",
      model: "gpt-5.6-sol",
      effort: "low",
      max_turns: 3,
    });
    const { calls, spawnSync: spawn } = recordingSpawnSync();
    assert.throws(
      () => validateAssignmentManifest(manifest, { spawnSync: spawn }),
      /does not accept max_turns/,
    );
    assert.equal(calls.length, 0);
  } finally {
    cleanup(root, taskDir);
  }
});

test("grok xhigh effort is refused rather than clamped", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir, { effort: "xhigh" });
    assert.throws(() => validateAssignmentManifest(manifest), /does not accept effort xhigh/);
  } finally {
    cleanup(root, taskDir);
  }
});

test("unminted staged index refused against HEAD tree creates no objects", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    writeFileSync(join(root, "extra.md"), "staged but unminted\n");
    git(root, ["add", "extra.md"]);
    const headTree = git(root, ["rev-parse", "HEAD^{tree}"]);
    const manifest = reviewerManifest(root, commit, headTree, taskDir);
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    const { calls, spawnSync: spawn } = recordingSpawnSync();
    assert.throws(
      () => validateAssignmentManifest(manifest, { spawnSync: spawn }),
      /does not match the current index/,
    );
    assertAllowedGitArgv(calls, root);
    assert.equal(calls.some(([, args]) => args.includes("write-tree")), false);
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-review-1")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("missing claimed index_tree object refuses without minting", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    writeFileSync(join(root, "README.md"), "repo\nstaged\n");
    git(root, ["add", "README.md"]);
    const missing = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const manifest = reviewerManifest(root, commit, missing, taskDir);
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    assert.throws(() => validateAssignmentManifest(manifest), /git cat-file failed|not a valid object/);
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-review-1")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("claimed index_tree that is a commit refuses", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    writeFileSync(join(root, "README.md"), "repo\nstaged\n");
    git(root, ["add", "README.md"]);
    const manifest = reviewerManifest(root, commit, commit, taskDir);
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    assert.throws(() => validateAssignmentManifest(manifest), /must name a tree object/);
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-review-1")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("mtime-only touch of unchanged content accepts without refreshing the index", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const readme = join(root, "README.md");
    const st = statSync(readme);
    utimesSync(readme, st.atime, new Date(st.mtime.getTime() + 10_000));
    const manifest = writerManifest(root, commit, taskDir);
    const indexPath = join(root, ".git", "index");
    const indexBefore = readFileSync(indexPath);
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    const { calls, spawnSync: spawn } = recordingSpawnSync();
    const validated = validateAssignmentManifest(manifest, { spawnSync: spawn });
    assert.equal(validated.git.clean, true);
    assert.deepEqual(readFileSync(indexPath), indexBefore);
    assert.equal(calls.some(([, args]) => args.includes("update-index")), false);
    assertUnchanged(root, beforeWorktree, beforeGit, [validated.output_dir]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("unmerged index refuses", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    writeFileSync(join(root, "README.md"), "side-a\n");
    git(root, ["add", "README.md"]);
    git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "a"]);
    git(root, ["checkout", "-b", "other"]);
    writeFileSync(join(root, "README.md"), "side-b\n");
    git(root, ["add", "README.md"]);
    git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "b"]);
    git(root, ["checkout", "main"]);
    writeFileSync(join(root, "README.md"), "side-c\n");
    git(root, ["add", "README.md"]);
    git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "c"]);
    const merge = spawnSync("git", ["-C", root, "merge", "--no-commit", "--no-ff", "other"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.notEqual(merge.status, 0);
    const head = git(root, ["rev-parse", "HEAD"]);
    const manifest = writerManifest(root, head, taskDir);
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    assert.throws(() => validateAssignmentManifest(manifest), /unmerged/);
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-writer-1")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("whitespace-only untracked filename is an unignored untracked change", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const spaces = join(root, "   ");
    writeFileSync(spaces, "spaces-only name\n");
    const manifest = writerManifest(root, commit, taskDir);
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    assert.throws(() => validateAssignmentManifest(manifest), /unignored untracked|unstaged tracked edits/);
    assert.equal(existsSync(spaces), true);
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-writer-1")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("whitespace-only modified tracked filename refuses", () => {
  const { root } = initRepo();
  const taskDir = initTask();
  try {
    writeFileSync(join(root, "   "), "named-spaces\n");
    git(root, ["add", "--", "   "]);
    git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "spaces"]);
    const commit = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(join(root, "   "), "named-spaces changed\n");
    const manifest = writerManifest(root, commit, taskDir);
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    assert.throws(() => validateAssignmentManifest(manifest), /unstaged tracked edits|unignored untracked/);
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-writer-1")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("exact git argv for accepted clean and staged paths", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const writer = writerManifest(root, commit, taskDir);
    const { calls: cleanCalls, spawnSync: cleanSpawn } = recordingSpawnSync();
    validateAssignmentManifest(writer, { spawnSync: cleanSpawn });
    assertAllowedGitArgv(cleanCalls, root);
    assert.deepEqual(
      cleanCalls.map(([, args]) => args.slice(3)),
      [
        ["rev-parse", "--is-inside-work-tree"],
        ["rev-parse", "--show-toplevel"],
        ["rev-parse", "HEAD"],
        ["rev-parse", "HEAD^{tree}"],
        ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
        ["diff-index", "--cached", "--quiet", git(root, ["rev-parse", "HEAD^{tree}"])],
      ],
    );

    writeFileSync(join(root, "README.md"), "repo\nstaged\n");
    git(root, ["add", "README.md"]);
    const indexTree = git(root, ["write-tree"]);
    const reviewDir = initTask();
    try {
      const reviewer = reviewerManifest(root, commit, indexTree, reviewDir, { assignment_id: "asg-review-argv" });
      const { calls: stagedCalls, spawnSync: stagedSpawn } = recordingSpawnSync();
      validateAssignmentManifest(reviewer, { spawnSync: stagedSpawn });
      assertAllowedGitArgv(stagedCalls, root);
      assert.deepEqual(
        stagedCalls.map(([, args]) => args.slice(3)),
        [
          ["rev-parse", "--is-inside-work-tree"],
          ["rev-parse", "--show-toplevel"],
          ["rev-parse", "HEAD"],
          ["rev-parse", "HEAD^{tree}"],
          ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
          ["cat-file", "-t", indexTree],
          ["diff-index", "--cached", "--quiet", indexTree],
        ],
      );
    } finally {
      rmSync(dirname(reviewDir), { recursive: true, force: true });
    }
  } finally {
    cleanup(root, taskDir);
  }
});

test("external task_dir with a separate cwd accepts current pointer under task_dir", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    const validated = validateAssignmentManifest(manifest);
    assert.equal(validated.cwd, root);
    assert.equal(validated.task_dir, realpathSync(taskDir));
    assert.notEqual(validated.task_dir, validated.cwd);
    if (validated.plan_ref.kind === "current") {
      assert.equal(validated.plan_ref.pointer_path, join(realpathSync(taskDir), PLAN_POINTER_FILENAME));
      assert.equal(validated.plan_ref.path, join(realpathSync(taskDir), "plan-current.md"));
    }
    assert.equal(validated.output_dir, join(realpathSync(taskDir), "asg-writer-1"));
    assertUnchanged(root, beforeWorktree, beforeGit, [validated.output_dir]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("adjacent plan pointer cannot override a bound task_dir pointer", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  const adjacentDir = mkdtempSync(join(tmpdir(), "kxm-adj-"));
  try {
    const adjacentPlan = join(adjacentDir, "plan-current.md");
    const body = "# adjacent\n";
    writeFileSync(adjacentPlan, body);
    writeFileSync(join(adjacentDir, PLAN_POINTER_FILENAME), `${JSON.stringify({
      schema: PLAN_POINTER_SCHEMA,
      task_id: "task-a",
      generation: 1,
      plan_path: adjacentPlan,
      plan_sha256: sha256(body),
      base_commit: commit,
      settled_decisions: ["adjacent"],
      updated_at: "2026-09-06T00:00:00.000Z",
      supersedes: [],
    }, null, 2)}\n`);
    const input = writeInput(root);
    const currentWithoutPointer = {
      schema: ASSIGNMENT_SCHEMA,
      task_id: "task-a",
      assignment_id: "asg-writer-adj",
      kind: "implement",
      harness: "grok",
      model: "grok-4.6",
      effort: "high",
      permission: "edit",
      cwd: root,
      task_dir: taskDir,
      base: { kind: "clean", commit },
      plan_ref: { kind: "current", path: adjacentPlan, sha256: sha256(body) },
      inputs: [{ path: input.path, sha256: input.sha }],
      contract: {
        boundary: "Add assignment validation only.",
        deliverables: ["scripts/assignment-run.mjs"],
        witness: { id: "verify" },
        deferred: ["templates"],
      },
      output_dir: "asg-writer-adj",
    };
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    assert.throws(() => validateAssignmentManifest(currentWithoutPointer), /missing path/);
    const bootstrap = planManifest(root, commit, taskDir, {
      assignment_id: "asg-plan-adj",
      output_dir: "asg-plan-adj",
    });
    const validated = validateAssignmentManifest(bootstrap);
    assert.equal(validated.plan_ref.kind, "bootstrap");
    assertUnchanged(root, beforeWorktree, beforeGit, [validated.output_dir, join(taskDir, "asg-writer-adj")]);
  } finally {
    cleanup(root, taskDir, [adjacentDir]);
  }
});

test("bootstrap refuses valid, malformed, directory, dangling-symlink, and EACCES pointers", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    writePlan(taskDir, "task-a", "# plan\n", commit);
    assert.throws(() => validateAssignmentManifest(planManifest(root, commit, taskDir)), /pointer already exists/);

    writeFileSync(join(taskDir, PLAN_POINTER_FILENAME), "{not-json");
    assert.throws(() => validateAssignmentManifest(planManifest(root, commit, taskDir, { assignment_id: "asg-plan-malformed", output_dir: "asg-plan-malformed" })), /pointer already exists/);

    rmSync(join(taskDir, PLAN_POINTER_FILENAME));
    mkdirSync(join(taskDir, PLAN_POINTER_FILENAME));
    assert.throws(() => validateAssignmentManifest(planManifest(root, commit, taskDir, { assignment_id: "asg-plan-dir", output_dir: "asg-plan-dir" })), /pointer already exists/);
    rmSync(join(taskDir, PLAN_POINTER_FILENAME), { recursive: true, force: true });

    symlinkSync(join(taskDir, "missing-target"), join(taskDir, PLAN_POINTER_FILENAME));
    assert.throws(() => validateAssignmentManifest(planManifest(root, commit, taskDir, { assignment_id: "asg-plan-link", output_dir: "asg-plan-link" })), /pointer already exists/);
    rmSync(join(taskDir, PLAN_POINTER_FILENAME));

    const { lstatSync: realLstat } = { lstatSync };
    const blocked = ((path: string) => {
      if (basename(path) === PLAN_POINTER_FILENAME) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return realLstat(path);
    }) as typeof lstatSync;
    const beforeWorktree = worktreeSnapshot(root);
    const beforeGit = gitSnapshot(root);
    assert.throws(
      () => validateAssignmentManifest(planManifest(root, commit, taskDir, { assignment_id: "asg-plan-eacces", output_dir: "asg-plan-eacces" }), { lstatSync: blocked }),
      /cannot inspect plan-current.json: EACCES/,
    );
    assertUnchanged(root, beforeWorktree, beforeGit, [join(taskDir, "asg-plan-eacces")]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("cwd-conventional pointer and identity are not authority", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const conventional = join(root, ".kxm", "logs", "task-a");
    mkdirSync(conventional, { recursive: true });
    writeFileSync(join(conventional, PLAN_POINTER_FILENAME), `${JSON.stringify({
      schema: PLAN_POINTER_SCHEMA,
      task_id: "task-a",
      generation: 9,
      plan_path: "plan-current.md",
      plan_sha256: sha256("# other\n"),
      base_commit: commit,
      settled_decisions: ["cwd"],
      updated_at: "2026-09-06T00:00:00.000Z",
      supersedes: [],
    }, null, 2)}\n`);
    mkdirSync(join(conventional, "asg-writer-1"));
    const bootstrap = planManifest(root, commit, taskDir);
    const validated = validateAssignmentManifest(bootstrap);
    assert.equal(validated.plan_ref.kind, "bootstrap");

    const writer = writerManifest(root, commit, taskDir);
    const accepted = validateAssignmentManifest(writer);
    assert.equal(accepted.assignment_id, "asg-writer-1");
    assert.equal(existsSync(join(taskDir, "asg-writer-1")), false);
  } finally {
    cleanup(root, taskDir);
  }
});

test("missing relative nonexistent file and wrong-basename task_dir refuse distinctly", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const base = writerManifest(root, commit, taskDir);
    const missing = { ...base };
    delete (missing as { task_dir?: string }).task_dir;
    assert.throws(() => validateAssignmentManifest(missing), /assignment.task_dir is required/);

    assert.throws(
      () => validateAssignmentManifest({ ...base, task_dir: "task-a" }),
      /task_dir must be an absolute path/,
    );

    assert.throws(
      () => validateAssignmentManifest({ ...base, task_dir: join(tmpdir(), "kxm-missing-task-a") }),
      /task_dir does not exist/,
    );

    const filePath = join(dirname(taskDir), "task-a-file");
    writeFileSync(filePath, "not a directory\n");
    assert.throws(
      () => validateAssignmentManifest({ ...base, task_dir: filePath }),
      /task_dir is not a directory/,
    );

    const wrong = mkdtempSync(join(tmpdir(), "kxm-wrong-"));
    assert.throws(
      () => validateAssignmentManifest({ ...base, task_dir: wrong }),
      /task_dir final segment must equal task_id/,
    );
    rmSync(wrong, { recursive: true, force: true });
    rmSync(filePath, { force: true });
  } finally {
    cleanup(root, taskDir);
  }
});

test("identity under cwd is ignored while task_dir identity and rework bind", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    mkdirSync(join(root, ".kxm", "logs", "task-a", "asg-writer-1"), { recursive: true });
    const accepted = validateAssignmentManifest(writerManifest(root, commit, taskDir));
    assert.equal(accepted.assignment_id, "asg-writer-1");

    mkdirSync(join(root, ".kxm", "logs", "task-a", "asg-prior-1"), { recursive: true });
    writeFileSync(join(root, ".kxm", "logs", "task-a", "asg-prior-1", "completion.json"), `${JSON.stringify({
      schema: COMPLETION_SCHEMA,
      assignment_id: "asg-prior-1",
      task_id: "task-a",
    })}\n`);
    assert.throws(
      () => validateAssignmentManifest(writerManifest(root, commit, taskDir, {
        assignment_id: "asg-writer-2",
        output_dir: "asg-writer-2",
        rework_of: "asg-prior-1",
      })),
      /does not point at an existing completion/,
    );

    mkdirSync(join(taskDir, "asg-prior-1"));
    writeFileSync(join(taskDir, "asg-prior-1", "completion.json"), `${JSON.stringify({
      schema: COMPLETION_SCHEMA,
      assignment_id: "asg-prior-1",
      task_id: "task-a",
    })}\n`);
    const rework = validateAssignmentManifest(writerManifest(root, commit, taskDir, {
      assignment_id: "asg-writer-2",
      output_dir: "asg-writer-2",
      rework_of: "asg-prior-1",
    }));
    assert.equal(rework.rework_of, "asg-prior-1");
    assert.equal(rework.output_dir, join(realpathSync(taskDir), "asg-writer-2"));
  } finally {
    cleanup(root, taskDir);
  }
});

test("relative output_dir resolves under task_dir and may equal the identity dir", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const validated = validateAssignmentManifest(writerManifest(root, commit, taskDir, { output_dir: "asg-writer-1" }));
    assert.equal(validated.output_dir, join(realpathSync(taskDir), "asg-writer-1"));
    mkdirSync(join(taskDir, "already"));
    assert.throws(
      () => validateAssignmentManifest(writerManifest(root, commit, taskDir, {
        assignment_id: "asg-writer-3",
        output_dir: "already",
      })),
      /output_dir already exists/,
    );
  } finally {
    cleanup(root, taskDir);
  }
});

test("shared task_dir across worktrees keeps duplicate and rework identity", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  const wt2 = join(tmpdir(), `kxm-wt-${process.pid}-${Date.now()}`);
  try {
    git(root, ["worktree", "add", "--detach", wt2]);
    writeFileSync(join(wt2, ".gitignore"), ".kxm/logs/\n*.log\n");
    const first = validateAssignmentManifest(writerManifest(root, commit, taskDir, {
      assignment_id: "asg-wt-1",
      output_dir: "asg-wt-1",
    }));
    assert.equal(first.cwd, root);
    mkdirSync(join(taskDir, "asg-wt-1"));
    const second = validateAssignmentManifest(writerManifest(wt2, commit, taskDir, {
      assignment_id: "asg-wt-2",
      output_dir: "asg-wt-2",
    }));
    assert.equal(second.cwd, wt2);
    assert.equal(second.task_dir, first.task_dir);
    assert.throws(
      () => validateAssignmentManifest(writerManifest(wt2, commit, taskDir, {
        assignment_id: "asg-wt-1",
        output_dir: "asg-wt-dup",
      })),
      /assignment_id asg-wt-1 is already present/,
    );
    writeFileSync(join(taskDir, "asg-wt-1", "completion.json"), `${JSON.stringify({
      schema: COMPLETION_SCHEMA,
      assignment_id: "asg-wt-1",
      task_id: "task-a",
    })}\n`);
    const rework = validateAssignmentManifest(writerManifest(wt2, commit, taskDir, {
      assignment_id: "asg-wt-3",
      output_dir: "asg-wt-3",
      rework_of: "asg-wt-1",
    }));
    assert.equal(rework.rework_of, "asg-wt-1");
  } finally {
    spawnSync("git", ["-C", root, "worktree", "remove", "--force", wt2], { encoding: "utf8", windowsHide: true });
    cleanup(root, taskDir, [wt2]);
  }
});

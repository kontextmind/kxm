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
import { basename, dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import {
  ASSIGNMENT_DISPATCH_SCHEMA,
  ASSIGNMENT_SCHEMA,
  COMPLETION_SCHEMA,
  PLAN_POINTER_FILENAME,
  PLAN_POINTER_SCHEMA,
  READ_MECHANISMS,
  RECORDING_RESOLUTION_SCHEMA,
  REFUSAL_SCHEMA,
  appendAssignmentTelemetry,
  assignmentOutputSchema,
  assignmentTelemetryPath,
  main as assignmentMain,
  observeAssignment,
  renderAssignmentPrompt,
  runAssignment,
  validateAssignmentManifest,
} from "../../scripts/assignment-run.mjs";
import {
  claudeAuth,
  codexAuth,
  fakeChild,
  grokAuth,
} from "../helpers/harness-fake.ts";
import { makeGitRoot } from "../helpers/git-root.ts";
import { readRoutingRecords, readTelemetry } from "../../plugins/kxm/src/telemetry.ts";

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
    const outputDir = join(dirname(taskDir), "out", "a1-run");
    const identityDir = join(taskDir, "asg-writer-1");
    const manifest = writerManifest(root, commit, taskDir, { output_dir: outputDir });
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
    const outputDir = join(dirname(taskDir), "out", "already-out");
    mkdirSync(dirname(outputDir), { recursive: true });
    mkdirSync(outputDir);
    const manifest = writerManifest(root, commit, taskDir, { output_dir: outputDir });
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
    const merge = spawnSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "merge", "--no-commit", "--no-ff", "other"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.notEqual(merge.status, 0, `${merge.stdout}${merge.stderr}`);
    assert.match(`${merge.stdout}${merge.stderr}`, /CONFLICT/);
    assert.doesNotMatch(merge.stderr, /Please tell me who you are|unable to auto-detect|useConfigOnly/);
    const head = git(root, ["rev-parse", "HEAD"]);
    // Prove the unmerged index actually exists before exercising the validator
    assert.match(git(root, ['ls-files', '-u']), /README\.md/);
    assert.equal(git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).length, 40);
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
      const reviewer = reviewerManifest(root, commit, indexTree, reviewDir, {
        assignment_id: "asg-review-argv",
        output_dir: "asg-review-argv",
      });
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
    assert.equal(validated.record_dir, validated.output_dir);
    const sibling = join(dirname(taskDir), "out", "already");
    mkdirSync(dirname(sibling), { recursive: true });
    mkdirSync(sibling);
    assert.throws(
      () => validateAssignmentManifest(writerManifest(root, commit, taskDir, {
        assignment_id: "asg-writer-3",
        output_dir: sibling,
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

const HEX64_RE = /^[a-f0-9]{64}$/;

function grokAnswer(claim: unknown, extra: Record<string, unknown> = {}) {
  return `${JSON.stringify({
    result: JSON.stringify(claim),
    sessionId: "g1",
    stop_reason: "end_turn",
    total_cost_usd: 0.12,
    usage: { input_tokens: 11, output_tokens: 5 },
    modelUsage: { "grok-4.6": { inputTokens: 11, outputTokens: 5, costUSD: 0.12 } },
    ...extra,
  })}\n`;
}

function claudeAnswer(claim: unknown, extra: Record<string, unknown> = {}) {
  return `${JSON.stringify({
    result: JSON.stringify(claim),
    is_error: false,
    session_id: "sess-fable",
    stop_reason: "end_turn",
    total_cost_usd: 1.5,
    usage: { input_tokens: 8, output_tokens: 4 },
    modelUsage: { fable: { inputTokens: 8, outputTokens: 4, costUSD: 1.5 } },
    ...extra,
  })}\n`;
}

function dispatchDeps(harness: string, assignment: { stdout?: string; stderr?: string; exitCode?: number | null }, auth: () => object, extras: {
  onSpawn?: (cwd: string) => void;
  onAuth?: (outputDir: string) => void;
  outputDir?: string;
} = {}) {
  const spawns: Array<{ command: string; argv: string[]; cwd?: string }> = [];
  const authCalls: Array<{ command: string; argv: string[] }> = [];
  const deps = {
    platform: process.platform,
    env: { PATH: "/tmp/kxm-harness-bin" },
    observedAt: "2026-09-05",
    now: () => 1_000,
    existsSync: (path: string) => existsSync(path) || String(path).includes(harness),
    spawnSync: ((command: string, args?: readonly string[], options?: object) => {
      if (command === "git") return spawnSync(command, args, options);
      authCalls.push({ command, argv: [...(args ?? [])] });
      extras.onAuth?.(extras.outputDir ?? "");
      return auth();
    }) as typeof spawnSync,
    spawn: (command: string, argv: string[], options: { cwd?: string }) => {
      const cwd = options.cwd;
      spawns.push(cwd === undefined ? { command, argv } : { command, argv, cwd });
      extras.onSpawn?.(cwd ?? "");
      return fakeChild(assignment);
    },
  };
  return { deps, spawns, authCalls };
}

test("dispatch writes pre-dispatch before native transport and refuses a duplicate race", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const outputDir = join(taskDir, "asg-writer-1");
    let sawPreDispatchAtAuth = false;
    let sawPreDispatchAtSpawn = false;
    const { deps, spawns, authCalls } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done", completedCount: 1 }) }, grokAuth, {
      outputDir,
      onAuth: () => {
        const raw = readFileSync(join(outputDir, "pre-dispatch.json"), "utf8");
        const pre = JSON.parse(raw) as { schema: string; prompt_sha256: string; manifest_sha256: string; plan_sha256?: string };
        assert.equal(pre.schema, ASSIGNMENT_DISPATCH_SCHEMA);
        assert.match(pre.prompt_sha256, HEX64_RE);
        assert.match(pre.manifest_sha256, HEX64_RE);
        assert.match(pre.plan_sha256 ?? "", HEX64_RE);
        sawPreDispatchAtAuth = true;
      },
      onSpawn: () => {
        assert.equal(existsSync(join(outputDir, "pre-dispatch.json")), true);
        sawPreDispatchAtSpawn = true;
      },
    });
    const first = await runAssignment(manifest, deps);
    assert.equal(sawPreDispatchAtAuth, true);
    assert.equal(sawPreDispatchAtSpawn, true);
    assert.equal(authCalls.length > 0, true);
    assert.equal(spawns.length, 1);
    assert.equal(first.transport.status, "completed");
    assert.equal(first.verification.status, "not-run");
    assert.equal(first.critic.kind, "none");
    assert.equal(first.attribution.status, "unclassified");
    assert.equal(Object.hasOwn(first, "acceptance"), false);
    const original = readFileSync(join(outputDir, "completion.json"));
    const { deps: secondDeps, spawns: secondSpawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    await assert.rejects(() => runAssignment(manifest, secondDeps), /already present/);
    assert.equal(secondSpawns.length, 0);
    assert.deepEqual(readFileSync(join(outputDir, "completion.json")), original);
  } finally {
    cleanup(root, taskDir);
  }
});

test("native auth failure records stage auth with unknown usage and does not spawn a model", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, () => ({
      status: 0,
      stdout: "Available models:\n",
      stderr: "",
      error: undefined,
    }));
    const completion = await runAssignment(manifest, deps);
    assert.equal(spawns.length, 0);
    assert.equal(completion.transport.status, "failed");
    assert.equal(completion.transport.stage, "auth");
    assert.equal(completion.transport.errorCode, "auth_failed");
    assert.equal(completion.transport.ok, false);
    assert.equal(completion.usage.costBasis, "unknown");
    assert.equal(completion.usage.contextOccupancy, "unknown");
    assert.equal(completion.usage.tokenBasis, "cumulative");
    assert.equal(completion.usage.tokensIn, undefined);
    assert.equal(completion.usage.costUsd, undefined);
    assert.equal(completion.verification.status, "not-run");
    assert.equal(Object.hasOwn(completion, "acceptance"), false);
    assert.equal(completion.transport.errorCode, "auth_failed");
    assert.equal(existsSync(join(taskDir, "asg-writer-1", "pre-dispatch.json")), true);
    assert.equal(existsSync(join(taskDir, "asg-writer-1", "completion.json")), true);
  } finally {
    cleanup(root, taskDir);
  }
});

test("generated prompts bind actual read mechanisms and native permission flags", async () => {
  const { root, commit } = initRepo();
  const writerDir = initTask();
  const reviewDir = initTask();
  try {
    const writer = writerManifest(root, commit, writerDir);
    const { deps: grokDeps, spawns: grokSpawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    const grokCompletion = await runAssignment(writer, grokDeps);
    const grokPromptPath = grokCompletion.sidecars.prompt?.path;
    assert.equal(typeof grokPromptPath, "string");
    const grokPrompt = readFileSync(grokPromptPath!, "utf8");
    assert.match(grokPrompt, /Use repository tools/);
    assert.match(grokPrompt, /not an OS sandbox claim/);
    assert.equal(grokPrompt.includes(READ_MECHANISMS.grok as string), true);
    assert.match(grokPrompt, /run `npm run verify` before completing/i);
    assert.match(grokPrompt, /Root re-runs the same fixed witness after you exit/);
    const grokArgv = grokSpawns[0]?.argv ?? [];
    assert.equal(grokArgv.includes("--no-subagents"), true);
    assert.equal(grokArgv.includes("--disable-web-search"), true);
    assert.equal(grokArgv.includes("--always-approve"), true);

    writeFileSync(join(root, "README.md"), "repo\nstaged\n");
    git(root, ["add", "README.md"]);
    const indexTree = git(root, ["write-tree"]);
    const reviewer = reviewerManifest(root, commit, indexTree, reviewDir);
    const { deps: claudeDeps, spawns: claudeSpawns } = dispatchDeps(
      "claude",
      { stdout: claudeAnswer({ verdict: "PASS", status: "done" }) },
      claudeAuth,
    );
    const reviewCompletion = await runAssignment(reviewer, claudeDeps);
    const reviewPromptPath = reviewCompletion.sidecars.prompt?.path;
    assert.equal(typeof reviewPromptPath, "string");
    const reviewPrompt = readFileSync(reviewPromptPath!, "utf8");
    assert.equal(reviewPrompt.includes(READ_MECHANISMS.claude as string), true);
    assert.match(reviewPrompt, /Do not use the shell/);
    assert.match(reviewPrompt, /top-level `verdict` of exactly PASS or BLOCK/);
    assert.match(reviewPrompt, /Root runs the witness separately; do not run it/);
    assert.equal(reviewPrompt.includes("npm run verify"), false);
    const claudeArgv = claudeSpawns[0]?.argv ?? [];
    assert.equal(claudeArgv.includes("--tools"), true);
    assert.equal(claudeArgv.includes("Read,Glob,Grep"), true);
    const schemaPath = reviewCompletion.sidecars.output_schema?.path;
    assert.equal(typeof schemaPath, "string");
    const schema = JSON.parse(readFileSync(schemaPath!, "utf8")) as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: { verdict?: { enum?: string[] } };
    };
    assert.deepEqual(schema.required?.slice().sort(), ["findings", "summary", "verdict"]);
    assert.deepEqual(schema.properties?.verdict?.enum, ["PASS", "BLOCK"]);
    assert.equal(schema.additionalProperties, false);

    const cliDir = initTask();
    try {
      const cliReview = reviewerManifest(root, commit, indexTree, cliDir, {
        assignment_id: "asg-review-cli",
        kind: "review-cli",
        harness: "codex",
        model: "gpt-5.6-sol",
        effort: "low",
        output_dir: "asg-review-cli",
      });
      const { deps: codexDeps, spawns: codexSpawns } = dispatchDeps(
        "codex",
        { stdout: claudeAnswer({ verdict: "BLOCK", status: "done" }) },
        codexAuth,
      );
      const cliCompletion = await runAssignment(cliReview, codexDeps);
      const cliPromptPath = cliCompletion.sidecars.prompt?.path;
      assert.equal(typeof cliPromptPath, "string");
      const cliPrompt = readFileSync(cliPromptPath!, "utf8");
      assert.equal(cliPrompt.includes(READ_MECHANISMS.codex as string), true);
      assert.match(cliPrompt, /cat, sed, rg, and git/);
      assert.match(cliPrompt, /Do not write files/);
      const codexArgv = codexSpawns[0]?.argv ?? [];
      assert.equal(codexArgv.includes("--sandbox"), true);
      assert.equal(codexArgv.includes("read-only"), true);
      assert.equal(codexArgv.includes("--ignore-user-config"), true);
    } finally {
      rmSync(dirname(cliDir), { recursive: true, force: true });
    }
  } finally {
    cleanup(root, writerDir, [dirname(reviewDir)]);
  }
});

test("unchanged staged review binds PASS to the reviewed tree", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    writeFileSync(join(root, "README.md"), "repo\nstaged\n");
    git(root, ["add", "README.md"]);
    const indexTree = git(root, ["write-tree"]);
    const manifest = reviewerManifest(root, commit, indexTree, taskDir);
    const { deps } = dispatchDeps("claude", { stdout: claudeAnswer({ verdict: "PASS", status: "done" }) }, claudeAuth);
    const completion = await runAssignment(manifest, deps);
    assert.equal(completion.candidate.status, "recorded");
    assert.equal(completion.invocation, "returned");
    assert.equal(completion.recording.status, "ok");
    if (completion.candidate.status === "recorded") {
      assert.equal(completion.candidate.index_tree, indexTree);
      assert.equal(completion.candidate.head, commit);
      assert.equal(completion.candidate.clean, true);
    }
    assert.equal(completion.critic.kind, "review");
    if (completion.critic.kind === "review") {
      assert.equal(completion.critic.verdict, "PASS");
      assert.equal(completion.critic.judged_tree, indexTree);
      assert.equal(completion.critic.role, "reviewer-arch");
    }
    assert.equal(completion.verification.status, "not-run");
    assert.equal(completion.transport.status, "completed");
  } finally {
    cleanup(root, taskDir);
  }
});

test("malformed or absent review verdict cannot certify", async () => {
  const { root, commit } = initRepo();
  const malformedDir = initTask();
  const absentDir = initTask();
  try {
    writeFileSync(join(root, "README.md"), "repo\nstaged\n");
    git(root, ["add", "README.md"]);
    const indexTree = git(root, ["write-tree"]);
    const malformed = reviewerManifest(root, commit, indexTree, malformedDir, {
      assignment_id: "asg-review-malformed",
      output_dir: "asg-review-malformed",
    });
    const { deps: malformedDeps } = dispatchDeps(
      "claude",
      { stdout: claudeAnswer({ verdict: "looks good", status: "done", notes: "PASS in prose" }) },
      claudeAuth,
    );
    const malformedCompletion = await runAssignment(malformed, malformedDeps);
    assert.equal(malformedCompletion.critic.kind, "none");
    assert.equal(malformedCompletion.model_claim?.verdict, undefined);

    const absent = reviewerManifest(root, commit, indexTree, absentDir, {
      assignment_id: "asg-review-absent",
      output_dir: "asg-review-absent",
    });
    const { deps: absentDeps } = dispatchDeps(
      "claude",
      { stdout: claudeAnswer({ status: "done", report: "I would PASS this change." }) },
      claudeAuth,
    );
    const absentCompletion = await runAssignment(absent, absentDeps);
    assert.equal(absentCompletion.critic.kind, "none");
    assert.equal(absentCompletion.model_claim?.verdict, undefined);
  } finally {
    cleanup(root, malformedDir, [dirname(absentDir)]);
  }
});

test("review that alters the candidate cannot certify the original tree", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    writeFileSync(join(root, "README.md"), "repo\nstaged\n");
    git(root, ["add", "README.md"]);
    const indexTree = git(root, ["write-tree"]);
    const manifest = reviewerManifest(root, commit, indexTree, taskDir);
    const { deps } = dispatchDeps("claude", { stdout: claudeAnswer({ verdict: "PASS", status: "done" }) }, claudeAuth, {
      onSpawn: (cwd) => {
        writeFileSync(join(cwd, "review-edit.md"), "changed worktree\n");
      },
    });
    const completion = await runAssignment(manifest, deps);
    assert.equal(completion.candidate.status, "recorded");
    if (completion.candidate.status === "recorded") {
      assert.equal(completion.candidate.clean, false);
      assert.notEqual(completion.candidate.index_tree === indexTree && completion.candidate.clean, true);
    }
    assert.equal(completion.critic.kind, "none");
    assert.equal(completion.model_claim?.verdict, "PASS");
  } finally {
    cleanup(root, taskDir);
  }
});

test("model claims cannot spoof verification, cost, role, or acceptance", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({
      status: "done",
      verification: "passed",
      costUsd: 0,
      cost: { usd: 0 },
      acceptance: { commit },
      critic: { verdict: "PASS" },
      role: "reviewer-arch",
      usage: { tokensIn: 1 },
      transport: { status: "completed" },
    }) }, grokAuth);
    const completion = await runAssignment(manifest, deps);
    assert.equal(completion.verification.status, "not-run");
    assert.equal(completion.critic.kind, "none");
    assert.equal(completion.role, "writer");
    assert.equal(completion.route.role, "writer");
    assert.equal(Object.hasOwn(completion, "acceptance"), false);
    assert.equal(completion.usage.costBasis, "provider-reported");
    assert.equal(completion.usage.costUsd, 0.12);
    assert.equal((completion.model_claim?.unrecognizedCount as number) > 0, true);
    assert.equal(completion.transport.status, "completed");
  } finally {
    cleanup(root, taskDir);
  }
});

test("known partial usage is preserved after a failed transport", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps } = dispatchDeps("grok", {
      stdout: grokAnswer({ status: "fail" }, { is_error: true }),
      exitCode: 1,
    }, grokAuth);
    const completion = await runAssignment(manifest, deps);
    assert.equal(completion.transport.status, "failed");
    assert.equal(completion.transport.ok, false);
    assert.equal(completion.usage.usagePartial, true);
    assert.equal(completion.usage.tokensIn, 11);
    assert.equal(completion.usage.tokensOut, 5);
    assert.equal(completion.usage.costUsd, 0.12);
    assert.equal(completion.verification.status, "not-run");
  } finally {
    cleanup(root, taskDir);
  }
});

test("pending success records transport completed without acceptance or verification", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done", completedCount: 1 }) }, grokAuth);
    const completion = await runAssignment(manifest, deps);
    assert.equal(completion.transport.status, "completed");
    assert.equal(completion.transport.ok, true);
    assert.equal(completion.verification.status, "not-run");
    assert.equal(Object.hasOwn(completion, "acceptance"), false);
    assert.equal(completion.attribution.status, "unclassified");
    const events = readTelemetry(assignmentTelemetryPath(join(taskDir, "asg-writer-1")));
    assert.equal(events.length, 1);
    const routing = readRoutingRecords(assignmentTelemetryPath(join(taskDir, "asg-writer-1")));
    assert.equal(routing.length, 1);
    assert.equal(routing[0]?.routing.finalOutcome, "pending");
    assert.equal(routing[0]?.routing.retries, 0);
    assert.equal(routing[0]?.routing.verifierOutcome, undefined);
  } finally {
    cleanup(root, taskDir);
  }
});

test("repeated observation appends telemetry only once", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    const completion = await runAssignment(manifest, deps);
    const outputDir = join(taskDir, "asg-writer-1");
    const path = assignmentTelemetryPath(outputDir);
    assert.equal(readTelemetry(path).length, 1);
    assert.equal(await observeAssignment(outputDir), false);
    assert.equal(appendAssignmentTelemetry({ ...completion, routingRecord: JSON.parse(readFileSync(join(outputDir, "routing-record.json"), "utf8")) }, outputDir), false);
    assert.equal(readTelemetry(path).length, 1);
    assert.equal(readRoutingRecords(path).length, 1);
  } finally {
    cleanup(root, taskDir);
  }
});

test("CLI requires absolute --manifest and rejects --task-dir", async () => {
  await assert.rejects(
    () => assignmentMain(["node", "assignment-run.mjs", "run", "--manifest", "/tmp/x.json", "--task-dir", "/tmp/task"]),
    /does not accept --task-dir/,
  );
  await assert.rejects(
    () => assignmentMain(["node", "assignment-run.mjs", "run", "--manifest", "relative.json"]),
    /absolute path/,
  );
});

function names(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function publicText(value: unknown): string {
  return JSON.stringify(value);
}

test("sibling custom output with absent parent keeps canonical records", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const assignmentId = "a1";
    const outputDir = join(dirname(taskDir), "out", "a1-run");
    const recordDir = join(taskDir, assignmentId);
    const manifest = writerManifest(root, commit, taskDir, {
      assignment_id: assignmentId,
      output_dir: outputDir,
    });
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done", completedCount: 1 }) }, grokAuth);
    const completion = await runAssignment(manifest, deps);
    assert.equal(spawns.length, 1);
    assert.equal(completion.binding.record_dir, realpathSync(recordDir));
    assert.equal(completion.binding.output_dir, realpathSync(outputDir));
    assert.equal(completion.binding.task_dir, realpathSync(taskDir));
    assert.equal(completion.binding.cwd, root);
    assert.equal(completion.invocation, "returned");
    assert.equal(completion.recording.status, "ok");
    assert.equal(completion.candidate.status, "recorded");
    assert.equal(existsSync(join(recordDir, "completion.json")), true);
    assert.equal(existsSync(join(recordDir, "manifest.json")), true);
    assert.equal(existsSync(join(recordDir, "prompt.md")), true);
    assert.equal(existsSync(join(recordDir, "pre-dispatch.json")), true);
    assert.equal(existsSync(join(outputDir, "completion.json")), false);
    assert.equal(existsSync(join(outputDir, "prompt.md")), false);
    assert.equal(names(outputDir).every((name) => [
      "dispatch.json",
      "answer.txt",
      "stderr.log",
      "model-claim.json",
      "error.txt",
    ].includes(name)), true);
    const rework = writerManifest(root, commit, taskDir, {
      assignment_id: "a2",
      output_dir: join(dirname(taskDir), "out", "a2-run"),
      rework_of: assignmentId,
    });
    const validated = validateAssignmentManifest(rework);
    assert.equal(validated.rework_of, assignmentId);
    assert.notEqual(validated.output_dir, outputDir);
  } finally {
    cleanup(root, taskDir);
  }
});

test("nested output_dir below record_dir at depth two is created", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const assignmentId = "asg-writer-1";
    const recordDir = join(taskDir, assignmentId);
    const outputDir = join(recordDir, "nested", "deep");
    const manifest = writerManifest(root, commit, taskDir, { output_dir: outputDir });
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    const completion = await runAssignment(manifest, deps);
    assert.equal(completion.binding.record_dir, realpathSync(recordDir));
    assert.equal(completion.binding.output_dir, realpathSync(outputDir));
    assert.equal(existsSync(join(recordDir, "completion.json")), true);
    assert.equal(existsSync(outputDir), true);
    assert.equal(existsSync(join(outputDir, "completion.json")), false);
    assert.equal(existsSync(join(recordDir, "nested", "deep")), true);
  } finally {
    cleanup(root, taskDir);
  }
});

test("rival directory at the final output path after validation is not adopted", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const assignmentId = "a1";
    const outputDir = join(dirname(taskDir), "out", "a1-run");
    const recordDir = join(taskDir, assignmentId);
    const manifest = writerManifest(root, commit, taskDir, {
      assignment_id: assignmentId,
      output_dir: outputDir,
    });
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    const canonicalOut = validateAssignmentManifest(manifest).output_dir;
    const realMkdir = mkdirSync;
    (deps as { mkdirSync?: typeof mkdirSync }).mkdirSync = ((path: string, opts?: { recursive?: boolean; mode?: number }) => {
      if (path === canonicalOut && opts?.recursive === false) {
        realMkdir(canonicalOut, { recursive: true });
        writeFileSync(join(canonicalOut, "prompt.md"), "OTHER_OWNER\n");
      }
      return realMkdir(path, opts);
    }) as typeof mkdirSync;
    await assert.rejects(
      () => runAssignment(manifest, deps),
      (error: unknown) => {
        assert.equal((error as { runnerCode?: string }).runnerCode, "output_dir_taken");
        return true;
      },
    );
    assert.equal(spawns.length, 0);
    const refusal = JSON.parse(readFileSync(join(recordDir, "refusal.json"), "utf8")) as {
      schema: string;
      stage: string;
      code: string;
      provider_calls: number;
    };
    assert.equal(refusal.schema, REFUSAL_SCHEMA);
    assert.equal(refusal.stage, "ownership");
    assert.equal(refusal.code, "output_dir_taken");
    assert.equal(refusal.provider_calls, 0);
    assert.equal(readFileSync(join(canonicalOut, "prompt.md"), "utf8"), "OTHER_OWNER\n");
    assert.equal(existsSync(join(recordDir, "completion.json")), false);
    assert.equal(existsSync(join(recordDir, "telemetry.jsonl")), false);
    assert.throws(
      () => validateAssignmentManifest(writerManifest(root, commit, taskDir, {
        assignment_id: "a2",
        output_dir: join(dirname(taskDir), "out", "a2-run"),
        rework_of: assignmentId,
      })),
      /does not point at an existing completion/,
    );
  } finally {
    cleanup(root, taskDir);
  }
});

test("rival symlink at the final output path after validation is not adopted", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const assignmentId = "a1-link";
    const outputDir = join(dirname(taskDir), "out", "a1-run");
    const recordDir = join(taskDir, assignmentId);
    const rival = join(dirname(taskDir), "out", "rival-target");
    const manifest = writerManifest(root, commit, taskDir, {
      assignment_id: assignmentId,
      output_dir: outputDir,
    });
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    const canonicalOut = validateAssignmentManifest(manifest).output_dir;
    const realMkdir = mkdirSync;
    (deps as { mkdirSync?: typeof mkdirSync }).mkdirSync = ((path: string, opts?: { recursive?: boolean; mode?: number }) => {
      if (path === canonicalOut && opts?.recursive === false) {
        realMkdir(rival, { recursive: true });
        writeFileSync(join(rival, "prompt.md"), "OTHER_OWNER\n");
        symlinkSync(rival, canonicalOut);
      }
      return realMkdir(path, opts);
    }) as typeof mkdirSync;
    await assert.rejects(
      () => runAssignment(manifest, deps),
      (error: unknown) => {
        assert.equal((error as { runnerCode?: string }).runnerCode, "output_dir_taken");
        return true;
      },
    );
    assert.equal(spawns.length, 0);
    const refusal = JSON.parse(readFileSync(join(recordDir, "refusal.json"), "utf8")) as { code: string; stage: string };
    assert.equal(refusal.stage, "ownership");
    assert.equal(refusal.code, "output_dir_taken");
    assert.equal(lstatSync(canonicalOut).isSymbolicLink(), true);
    assert.equal(readFileSync(join(rival, "prompt.md"), "utf8"), "OTHER_OWNER\n");
  } finally {
    cleanup(root, taskDir);
  }
});

test("rival creating only the parent of custom output still succeeds", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const outputDir = join(dirname(taskDir), "out", "a1-run");
    mkdirSync(dirname(outputDir), { recursive: true });
    const manifest = writerManifest(root, commit, taskDir, {
      assignment_id: "a1-parent",
      output_dir: outputDir,
    });
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    const completion = await runAssignment(manifest, deps);
    assert.equal(spawns.length, 1);
    assert.equal(completion.transport.status, "completed");
    assert.equal(completion.binding.output_dir, realpathSync(outputDir));
    assert.equal(existsSync(join(taskDir, "a1-parent", "completion.json")), true);
  } finally {
    cleanup(root, taskDir);
  }
});

test("parent alias of own fresh record is the canonical output identity", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const parent = dirname(taskDir);
    const alias = join(parent, "alias");
    symlinkSync(parent, alias);
    const assignmentId = "a1-own-alias";
    const requested = join(alias, basename(taskDir), assignmentId);
    const canonical = join(realpathSync(taskDir), assignmentId);
    const manifestBytes = Buffer.from(JSON.stringify(writerManifest(root, commit, taskDir, {
      assignment_id: assignmentId,
      output_dir: requested,
    })));
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as ReturnType<typeof writerManifest>;
    const validated = validateAssignmentManifest(manifest);
    assert.equal(validated.output_dir, canonical);
    assert.equal(validated.record_dir, canonical);
    assert.equal(validated.requested_output_dir, resolve(requested));
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done", completedCount: 1 }) }, grokAuth);
    const completion = await runAssignment(manifest, { ...deps, manifestBytes });
    assert.equal(spawns.length, 1);
    assert.equal(completion.binding.output_dir, canonical);
    assert.equal(completion.binding.record_dir, canonical);
    assert.equal(completion.manifest.sha256, sha256(manifestBytes));
    assert.deepEqual(readFileSync(join(canonical, "manifest.json")), manifestBytes);
    assert.equal(existsSync(join(canonical, "completion.json")), true);
    assert.equal(existsSync(join(canonical, "dispatch.json")), true);
    assert.equal(lstatSync(alias).isSymbolicLink(), true);
  } finally {
    cleanup(root, taskDir);
  }
});

test("parent alias of external fresh output uses the canonical harness path", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const parent = dirname(taskDir);
    const alias = join(parent, "alias");
    symlinkSync(parent, alias);
    const assignmentId = "a1-ext-alias";
    const requested = join(alias, "out", "a1-run");
    const canonical = join(realpathSync(parent), "out", "a1-run");
    const recordDir = join(realpathSync(taskDir), assignmentId);
    const manifestBytes = Buffer.from(JSON.stringify(writerManifest(root, commit, taskDir, {
      assignment_id: assignmentId,
      output_dir: requested,
    })));
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as ReturnType<typeof writerManifest>;
    const validated = validateAssignmentManifest(manifest);
    assert.equal(validated.output_dir, canonical);
    assert.equal(validated.record_dir, recordDir);
    assert.notEqual(validated.output_dir, validated.record_dir);
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done", completedCount: 1 }) }, grokAuth);
    const completion = await runAssignment(manifest, { ...deps, manifestBytes });
    assert.equal(spawns.length, 1);
    assert.equal(completion.binding.output_dir, realpathSync(canonical));
    assert.equal(completion.binding.record_dir, recordDir);
    assert.equal(completion.manifest.sha256, sha256(manifestBytes));
    assert.deepEqual(readFileSync(join(recordDir, "manifest.json")), manifestBytes);
    assert.equal(existsSync(join(recordDir, "completion.json")), true);
    assert.equal(existsSync(join(canonical, "dispatch.json")), true);
    assert.equal(existsSync(join(recordDir, "dispatch.json")), false);
  } finally {
    cleanup(root, taskDir);
  }
});

test("existing and racing final symlink at parent-alias output still refuses", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const parent = dirname(taskDir);
    const alias = join(parent, "alias");
    symlinkSync(parent, alias);
    const existingId = "a1-exist-link";
    const existingRequested = join(alias, "out", "exist-run");
    mkdirSync(join(parent, "out"), { recursive: true });
    symlinkSync(join(parent, "out"), existingRequested);
    const existingManifest = writerManifest(root, commit, taskDir, {
      assignment_id: existingId,
      output_dir: existingRequested,
    });
    const existingDeps = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    await assert.rejects(
      () => runAssignment(existingManifest, existingDeps.deps),
      (error: unknown) => {
        assert.equal((error as { runnerCode?: string }).runnerCode, "output_dir_exists");
        return true;
      },
    );
    assert.equal(existingDeps.spawns.length, 0);
    const existingRefusal = JSON.parse(readFileSync(join(taskDir, existingId, "refusal.json"), "utf8")) as {
      stage: string;
      code: string;
      binding: { output_dir: string };
    };
    assert.equal(existingRefusal.stage, "validation");
    assert.equal(existingRefusal.code, "output_dir_exists");
    assert.equal(existingRefusal.binding.output_dir, resolve(existingRequested));
    assert.equal(lstatSync(existingRequested).isSymbolicLink(), true);

    const raceId = "a1-race-link";
    const raceRequested = join(alias, "out", "race-run");
    const raceCanonical = join(realpathSync(parent), "out", "race-run");
    const rival = join(parent, "out", "rival-target");
    const raceManifest = writerManifest(root, commit, taskDir, {
      assignment_id: raceId,
      output_dir: raceRequested,
    });
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    const realMkdir = mkdirSync;
    (deps as { mkdirSync?: typeof mkdirSync }).mkdirSync = ((path: string, opts?: { recursive?: boolean; mode?: number }) => {
      if (path === raceCanonical && opts?.recursive === false) {
        realMkdir(rival, { recursive: true });
        writeFileSync(join(rival, "prompt.md"), "OTHER_OWNER\n");
        symlinkSync(rival, raceCanonical);
      }
      return realMkdir(path, opts);
    }) as typeof mkdirSync;
    await assert.rejects(
      () => runAssignment(raceManifest, deps),
      (error: unknown) => {
        assert.equal((error as { runnerCode?: string }).runnerCode, "output_dir_taken");
        return true;
      },
    );
    assert.equal(spawns.length, 0);
    const refusal = JSON.parse(readFileSync(join(taskDir, raceId, "refusal.json"), "utf8")) as {
      stage: string;
      code: string;
      binding: { output_dir: string };
    };
    assert.equal(refusal.stage, "ownership");
    assert.equal(refusal.code, "output_dir_taken");
    assert.equal(refusal.binding.output_dir, resolve(raceRequested));
    assert.equal(lstatSync(raceCanonical).isSymbolicLink(), true);
    assert.equal(readFileSync(join(rival, "prompt.md"), "utf8"), "OTHER_OWNER\n");
  } finally {
    cleanup(root, taskDir);
  }
});

test("unsafe reserved namespace and .git output_dir write refusal only under the record dir", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const cases: Array<{ id: string; output: string }> = [
      { id: "unsafe-eq", output: taskDir },
      { id: "unsafe-parent", output: dirname(taskDir) },
      { id: "unsafe-other", output: join(taskDir, "asg-other") },
      { id: "unsafe-hist", output: join(taskDir, "plan-history", "x") },
      { id: "unsafe-git", output: join(root, ".git", "x") },
    ];
    for (const item of cases) {
      const manifest = writerManifest(root, commit, taskDir, {
        assignment_id: item.id,
        output_dir: item.output,
      });
      const beforeGit = gitSnapshot(root);
      const beforeTask = snapshotTree(taskDir);
      const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
      await assert.rejects(
        () => runAssignment(manifest, deps),
        (error: unknown) => {
          assert.equal((error as { runnerCode?: string }).runnerCode, "output_dir_unsafe");
          return true;
        },
      );
      assert.equal(spawns.length, 0);
      const recordDir = join(taskDir, item.id);
      const refusal = JSON.parse(readFileSync(join(recordDir, "refusal.json"), "utf8")) as {
        stage: string;
        code: string;
        provider_calls: number;
      };
      assert.equal(refusal.stage, "validation");
      assert.equal(refusal.code, "output_dir_unsafe");
      assert.equal(refusal.provider_calls, 0);
      if (item.id !== "unsafe-eq" && item.id !== "unsafe-parent") {
        assert.equal(existsSync(item.output), false);
      }
      assert.equal(existsSync(join(taskDir, "plan-history")), false);
      assert.equal(existsSync(join(root, ".git", "x")), false);
      const afterGit = gitSnapshot(root);
      assert.deepEqual([...afterGit.files.entries()], [...beforeGit.files.entries()]);
      const afterTask = snapshotTree(taskDir);
      for (const rel of afterTask.keys()) {
        if (rel === `${item.id}/manifest.json` || rel === `${item.id}/refusal.json` || rel === `${item.id}/runner-errors.jsonl`) {
          continue;
        }
        assert.equal(beforeTask.has(rel) || rel.startsWith(`${item.id}/`), true);
      }
    }
  } finally {
    cleanup(root, taskDir);
  }
});

test("existing final output path writes refusal and does not spawn", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const outputDir = join(dirname(taskDir), "out", "exists");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, "keep.txt"), "keep\n");
    const assignmentId = "asg-exists";
    const manifest = writerManifest(root, commit, taskDir, {
      assignment_id: assignmentId,
      output_dir: outputDir,
    });
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    await assert.rejects(
      () => runAssignment(manifest, deps),
      (error: unknown) => {
        assert.equal((error as { runnerCode?: string }).runnerCode, "output_dir_exists");
        return true;
      },
    );
    assert.equal(spawns.length, 0);
    const refusal = JSON.parse(readFileSync(join(taskDir, assignmentId, "refusal.json"), "utf8")) as {
      stage: string;
      code: string;
    };
    assert.equal(refusal.stage, "validation");
    assert.equal(refusal.code, "output_dir_exists");
    assert.equal(readFileSync(join(outputDir, "keep.txt"), "utf8"), "keep\n");
  } finally {
    cleanup(root, taskDir);
  }
});

test("pre-existing record_dir refuses with no write", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const recordDir = join(taskDir, "asg-writer-1");
    mkdirSync(recordDir);
    writeFileSync(join(recordDir, "keep.json"), "{\"keep\":true}\n");
    const beforeGit = gitSnapshot(root);
    const beforeTask = snapshotTree(taskDir);
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    await assert.rejects(() => runAssignment(manifest, deps), /already present/);
    assert.equal(spawns.length, 0);
    assert.deepEqual([...snapshotTree(taskDir).entries()], [...beforeTask.entries()]);
    assert.deepEqual([...gitSnapshot(root).files.entries()], [...beforeGit.files.entries()]);
    assert.equal(readFileSync(join(recordDir, "keep.json"), "utf8"), "{\"keep\":true}\n");
    assert.equal(existsSync(join(recordDir, "refusal.json")), false);
  } finally {
    cleanup(root, taskDir);
  }
});

test("identifiable invalid writes refusal with zero provider calls and private diagnostics", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const sentinel = "SENTINEL_RAW_LEAK_TEST";
    const assignmentId = "asg-invalid";
    const manifest = writerManifest(root, commit, taskDir, {
      assignment_id: assignmentId,
      effort: sentinel,
    });
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    await assert.rejects(() => runAssignment(manifest, deps), /unknown effort|does not accept effort/);
    assert.equal(spawns.length, 0);
    const recordDir = join(taskDir, assignmentId);
    const refusal = JSON.parse(readFileSync(join(recordDir, "refusal.json"), "utf8")) as Record<string, unknown>;
    assert.equal(refusal.schema, REFUSAL_SCHEMA);
    assert.equal(refusal.stage, "validation");
    assert.equal(refusal.provider_calls, 0);
    assert.equal(existsSync(join(recordDir, "telemetry.jsonl")), false);
    assert.equal(existsSync(join(recordDir, "completion.json")), false);
    assert.equal(publicText(refusal).includes(sentinel), false);
    const errorsPath = join(recordDir, "runner-errors.jsonl");
    assert.equal(existsSync(errorsPath), true);
    assert.equal(modeOf(errorsPath), 0o600);
    assert.equal(readFileSync(errorsPath, "utf8").includes(sentinel), true);
    assert.equal(existsSync(join(recordDir, "error.txt")), false);
  } finally {
    cleanup(root, taskDir);
  }
});

test("unidentifiable manifest writes nothing under task_dir", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    writePlan(taskDir, "task-a", "# plan\n", commit);
    const before = snapshotTree(taskDir);
    const manifest = {
      schema: "kxm.assignment.v0",
      task_id: "task-a",
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
      inputs: [],
      contract: {
        boundary: "x",
        deliverables: ["scripts/assignment-run.mjs"],
        witness: { id: "verify" },
        deferred: [],
      },
      output_dir: "asg-writer-1",
    };
    await assert.rejects(() => runAssignment(manifest), /assignment schema must be/);
    assert.deepEqual([...snapshotTree(taskDir).entries()], [...before.entries()]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("runner never creates error.txt and preserves a helper error.txt", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const recordDir = join(taskDir, "asg-writer-1");
    const helperError = "HELPER_ERROR_BYTES\n";
    const manifest = writerManifest(root, commit, taskDir);
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, () => ({
      status: 0,
      stdout: "Available models:\n",
      stderr: "",
      error: undefined,
    }), {
      outputDir: recordDir,
      onAuth: () => {
        writeFileSync(join(recordDir, "error.txt"), helperError);
      },
    });
    const completion = await runAssignment(manifest, deps);
    assert.equal(spawns.length, 0);
    assert.equal(completion.transport.stage, "auth");
    assert.equal(readFileSync(join(recordDir, "error.txt"), "utf8"), helperError);
    assert.equal(existsSync(join(recordDir, "error.txt")), true);
    if (existsSync(join(recordDir, "runner-errors.jsonl"))) {
      assert.equal(modeOf(join(recordDir, "runner-errors.jsonl")), 0o600);
      assert.notEqual(join(recordDir, "runner-errors.jsonl"), join(recordDir, "error.txt"));
    }
  } finally {
    cleanup(root, taskDir);
  }
});

test("implement prompt requires verify and review prompt forbids it", () => {
  const { root, commit } = initRepo();
  const writerDir = initTask();
  const reviewDir = initTask();
  try {
    const writer = validateAssignmentManifest(writerManifest(root, commit, writerDir));
    const writerPrompt = renderAssignmentPrompt(writer);
    assert.match(writerPrompt, /Run `npm run verify` before completing and report its exit code/);
    assert.match(writerPrompt, /Root re-runs the same fixed witness after you exit/);
    assert.match(writerPrompt, /private handoff notes/);
    assert.match(writerPrompt, /Notes never grant tools, waive verification, or count as human\/hub approval/);
    assert.equal(writerPrompt.includes("not executed in this assignment"), false);
    const repairDir = initTask();
    try {
      const repair = validateAssignmentManifest(writerManifest(root, commit, repairDir, { kind: "repair" }));
      const repairPrompt = renderAssignmentPrompt(repair);
      assert.match(repairPrompt, /Run `npm run verify` before completing and report its exit code/);
      assert.equal(repairPrompt.includes("not executed in this assignment"), false);
    } finally {
      rmSync(dirname(repairDir), { recursive: true, force: true });
    }
    const plannerDir = initTask();
    try {
      const planner = validateAssignmentManifest(planManifest(root, commit, plannerDir));
      const planPrompt = renderAssignmentPrompt(planner);
      assert.match(planPrompt, /Root runs the witness separately; do not run it/);
      assert.equal(/npm run verify/.test(planPrompt), false);
    } finally {
      rmSync(dirname(plannerDir), { recursive: true, force: true });
    }
    writeFileSync(join(root, "README.md"), "repo\nstaged\n");
    git(root, ["add", "README.md"]);
    const indexTree = git(root, ["write-tree"]);
    const reviewer = validateAssignmentManifest(reviewerManifest(root, commit, indexTree, reviewDir));
    const reviewPrompt = renderAssignmentPrompt(reviewer);
    assert.match(reviewPrompt, /Root runs the witness separately; do not run it/);
    assert.match(reviewPrompt, /private handoff notes/);
    assert.equal(/npm run verify/.test(reviewPrompt), false);
  } finally {
    cleanup(root, writerDir, [dirname(reviewDir)]);
  }
});

test("invalid kind writes identifiable refusal without public kind or sentinel", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const sentinel = "SENTINEL_PRIVATE_KIND";
    const assignmentId = "asg-kind";
    const manifest = writerManifest(root, commit, taskDir, {
      assignment_id: assignmentId,
      kind: sentinel,
    });
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    await assert.rejects(
      () => runAssignment(manifest, deps),
      (error: unknown) => {
        assert.equal((error as { runnerCode?: string }).runnerCode, "route_invalid");
        return true;
      },
    );
    assert.equal(spawns.length, 0);
    const recordDir = join(taskDir, assignmentId);
    const refusal = JSON.parse(readFileSync(join(recordDir, "refusal.json"), "utf8")) as Record<string, unknown>;
    assert.equal(refusal.schema, REFUSAL_SCHEMA);
    assert.equal(refusal.stage, "validation");
    assert.equal(refusal.code, "route_invalid");
    assert.equal(refusal.provider_calls, 0);
    assert.equal(Object.hasOwn(refusal, "kind"), false);
    assert.equal(JSON.stringify(refusal).includes(sentinel), false);
    const stored = JSON.parse(readFileSync(join(recordDir, "manifest.json"), "utf8")) as { kind: string };
    assert.equal(stored.kind, sentinel);
    assert.equal(readFileSync(join(recordDir, "runner-errors.jsonl"), "utf8").includes(sentinel), true);
  } finally {
    cleanup(root, taskDir);
  }
});

test("kind already present is route_invalid and still consumes identity", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const assignmentId = "asg-already-kind";
    const manifest = writerManifest(root, commit, taskDir, {
      assignment_id: assignmentId,
      kind: "already present",
    });
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    await assert.rejects(
      () => runAssignment(manifest, deps),
      (error: unknown) => {
        assert.equal((error as { runnerCode?: string }).runnerCode, "route_invalid");
        return true;
      },
    );
    assert.equal(spawns.length, 0);
    const refusal = JSON.parse(readFileSync(join(taskDir, assignmentId, "refusal.json"), "utf8")) as {
      stage: string;
      code: string;
      kind?: string;
    };
    assert.equal(refusal.stage, "validation");
    assert.equal(refusal.code, "route_invalid");
    assert.equal(Object.hasOwn(refusal, "kind"), false);
  } finally {
    cleanup(root, taskDir);
  }
});

test("dot-prefixed foreign task descendant is unsafe; owned descendant runs", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const foreign = writerManifest(root, commit, taskDir, {
      assignment_id: "asg-dot-foreign",
      output_dir: "..foreign/native",
    });
    const foreignDeps = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    await assert.rejects(
      () => runAssignment(foreign, foreignDeps.deps),
      (error: unknown) => {
        assert.equal((error as { runnerCode?: string }).runnerCode, "output_dir_unsafe");
        return true;
      },
    );
    assert.equal(foreignDeps.spawns.length, 0);
    const foreignRefusal = JSON.parse(
      readFileSync(join(taskDir, "asg-dot-foreign", "refusal.json"), "utf8"),
    ) as { code: string; stage: string };
    assert.equal(foreignRefusal.code, "output_dir_unsafe");
    assert.equal(foreignRefusal.stage, "validation");
    assert.equal(existsSync(join(taskDir, "..foreign")), false);

    const owned = writerManifest(root, commit, taskDir, {
      assignment_id: "asg-dot-owned",
      output_dir: "asg-dot-owned/..owned/native",
    });
    const ownedDeps = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    const completion = await runAssignment(owned, ownedDeps.deps);
    assert.equal(ownedDeps.spawns.length, 1);
    assert.equal(completion.schema, COMPLETION_SCHEMA);
    assert.equal(existsSync(join(taskDir, "asg-dot-owned", "..owned", "native")), true);
    assert.equal(existsSync(join(taskDir, "asg-dot-owned", "completion.json")), true);
  } finally {
    cleanup(root, taskDir);
  }
});

test("lstat EACCES is not treated as missing output", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir, {
      assignment_id: "asg-lstat",
      output_dir: "asg-lstat",
    });
    const output = resolve(taskDir, "asg-lstat");
    assert.throws(
      () => validateAssignmentManifest(manifest, {
        lstatSync: ((path: string) => {
          if (basename(String(path)) === "asg-lstat") {
            const error = new Error("PRIVATE_PERMISSION_DETAIL") as NodeJS.ErrnoException;
            error.code = "EACCES";
            throw error;
          }
          return lstatSync(path);
        }) as typeof lstatSync,
      }),
      (error: unknown) => {
        assert.equal((error as { runnerCode?: string }).runnerCode, "unknown");
        assert.equal(String((error as Error).message).includes("PRIVATE_PERMISSION_DETAIL"), false);
        return true;
      },
    );
    assert.equal(existsSync(join(taskDir, "asg-lstat")), false);
  } finally {
    cleanup(root, taskDir);
  }
});

test("realpath failure of deepest existing ancestor fails closed", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const parent = join(dirname(taskDir), "opaque-parent");
    mkdirSync(parent);
    const manifest = writerManifest(root, commit, taskDir, {
      assignment_id: "asg-realpath",
      output_dir: join(parent, "native"),
    });
    assert.throws(
      () => validateAssignmentManifest(manifest, {
        realpathSync: ((path: string) => {
          if (String(path) === parent) {
            const error = new Error("PRIVATE_REALPATH_DETAIL") as NodeJS.ErrnoException;
            error.code = "EACCES";
            throw error;
          }
          return realpathSync(path);
        }) as typeof realpathSync,
      }),
      (error: unknown) => {
        assert.equal((error as { runnerCode?: string }).runnerCode, "unknown");
        assert.equal(String((error as Error).message).includes("PRIVATE_REALPATH_DETAIL"), false);
        return true;
      },
    );
    assert.equal(existsSync(join(parent, "native")), false);
  } finally {
    cleanup(root, taskDir);
  }
});

test("dangling final output symlink is output_dir_exists not unknown", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const outputDir = join(dirname(taskDir), "native-link");
    symlinkSync(join(dirname(taskDir), "missing-target"), outputDir);
    const manifest = writerManifest(root, commit, taskDir, {
      assignment_id: "asg-dangling",
      output_dir: outputDir,
    });
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    await assert.rejects(
      () => runAssignment(manifest, deps),
      (error: unknown) => {
        assert.equal((error as { runnerCode?: string }).runnerCode, "output_dir_exists");
        return true;
      },
    );
    assert.equal(spawns.length, 0);
    const refusal = JSON.parse(readFileSync(join(taskDir, "asg-dangling", "refusal.json"), "utf8")) as {
      stage: string;
      code: string;
    };
    assert.equal(refusal.stage, "validation");
    assert.equal(refusal.code, "output_dir_exists");
    assert.equal(lstatSync(outputDir).isSymbolicLink(), true);
  } finally {
    cleanup(root, taskDir);
  }
});

test("returned native facts survive snapshot failure and keep untracked output", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps, spawns } = dispatchDeps("grok", {
      stdout: grokAnswer({ status: "done" }, {
        usage: { input_tokens: 20, output_tokens: 10 },
        total_cost_usd: 0.25,
        modelUsage: { "grok-4.6": { inputTokens: 20, outputTokens: 10, costUSD: 0.25 } },
      }),
    }, grokAuth, {
      onSpawn: (cwd) => {
        writeFileSync(join(cwd, "native-output.txt"), "native output\n");
      },
    });
    const innerSpawn = deps.spawnSync;
    deps.spawnSync = ((command: string, args?: readonly string[], options?: object) => {
      if (command === "git" && (args ?? []).includes("write-tree")) {
        return { status: 128, stdout: "", stderr: "PRIVATE_SNAPSHOT_ERROR", error: undefined };
      }
      return innerSpawn(command, args, options);
    }) as typeof spawnSync;
    const completion = await runAssignment(manifest, deps);
    assert.equal(spawns.length, 1);
    assert.equal(completion.invocation, "returned");
    assert.equal(completion.transport.status, "completed");
    assert.equal(completion.transport.ok, true);
    assert.equal(Object.hasOwn(completion.transport, "errorCode"), false);
    assert.equal(completion.candidate.status, "unknown");
    if (completion.candidate.status === "unknown") {
      assert.equal(completion.candidate.code, "snapshot_failed");
    }
    assert.equal(completion.recording.status, "failed");
    if (completion.recording.status === "failed") {
      assert.equal(completion.recording.steps.candidate_snapshot, "failed");
    }
    assert.equal(completion.usage.tokensIn, 20);
    assert.equal(completion.usage.tokensOut, 10);
    assert.equal(completion.usage.providerReportedCostUsd, 0.25);
    assert.equal(existsSync(join(root, "native-output.txt")), true);
    assert.equal(JSON.stringify(completion).includes("PRIVATE_SNAPSHOT_ERROR"), false);
  } finally {
    cleanup(root, taskDir);
  }
});

test("failed native PASS is a model claim never eligible critic evidence", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    writeFileSync(join(root, "README.md"), "repo\nstaged\n");
    git(root, ["add", "README.md"]);
    const indexTree = git(root, ["write-tree"]);
    const manifest = reviewerManifest(root, commit, indexTree, taskDir);
    const { deps } = dispatchDeps(
      "claude",
      { stdout: claudeAnswer({ verdict: "PASS", status: "done" }), exitCode: 1 },
      claudeAuth,
    );
    const completion = await runAssignment(manifest, deps);
    assert.equal(completion.transport.status, "failed");
    assert.equal(completion.model_claim?.verdict, "PASS");
    assert.equal(completion.critic.kind, "none");
    if (completion.critic.kind === "none") {
      assert.equal(completion.critic.reason, "transport-not-completed");
    }
  } finally {
    cleanup(root, taskDir);
  }
});

test("subscription estimate and over-cap cache stay out of routing costUsd", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    writeFileSync(join(root, "README.md"), "repo\nstaged\n");
    git(root, ["add", "README.md"]);
    const indexTree = git(root, ["write-tree"]);
    const manifest = reviewerManifest(root, commit, indexTree, taskDir);
    const { deps } = dispatchDeps("claude", {
      stdout: claudeAnswer({ verdict: "PASS", status: "done" }, {
        usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 2_000_001 },
        total_cost_usd: 0.25,
        modelUsage: {},
      }),
    }, claudeAuth);
    const completion = await runAssignment(manifest, deps);
    assert.equal(completion.usage.costBasis, "unmetered");
    const routing = JSON.parse(readFileSync(join(taskDir, "asg-review-1", "routing-record.json"), "utf8")) as {
      costUsd?: number;
      providerMetadata?: { unmeteredEstimateUsd?: number; cacheReadTokens?: number };
    };
    assert.equal(Object.hasOwn(routing, "costUsd"), false);
    assert.equal(routing.providerMetadata?.unmeteredEstimateUsd, 0.25);
    assert.equal(routing.providerMetadata?.cacheReadTokens, 2_000_001);
  } finally {
    cleanup(root, taskDir);
  }
});

test("documented Claude structured_output binds a tree-bound critic verdict", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    writeFileSync(join(root, "README.md"), "repo\nstaged\n");
    git(root, ["add", "README.md"]);
    const indexTree = git(root, ["write-tree"]);
    const manifest = reviewerManifest(root, commit, indexTree, taskDir);
    const { deps } = dispatchDeps("claude", {
      stdout: claudeAnswer({ status: "done" }, {
        result: "",
        structured_output: { verdict: "PASS", summary: "PRIVATE_REPORT_SENTINEL", findings: [] },
      }),
    }, claudeAuth);
    const completion = await runAssignment(manifest, deps);
    assert.equal(completion.transport.status, "completed");
    assert.equal(completion.model_claim?.verdict, "PASS");
    assert.equal(completion.model_claim?.claimSource, "structured_output");
    assert.equal(completion.critic.kind, "review");
    if (completion.critic.kind === "review") {
      assert.equal(completion.critic.verdict, "PASS");
      assert.equal(completion.critic.judged_tree, indexTree);
    }
    if (completion.candidate.status === "recorded") {
      assert.equal(completion.critic.kind === "review" && completion.critic.judged_tree === completion.candidate.index_tree, true);
    }
    assert.equal(JSON.stringify(completion).includes("PRIVATE_REPORT_SENTINEL"), false);
  } finally {
    cleanup(root, taskDir);
  }
});

test("telemetry failure recovers without model rerun or completion rewrite", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    const realWrite = writeFileSync;
    (deps as { writeFileSync?: typeof writeFileSync }).writeFileSync = ((
      path: string | Buffer | URL,
      body: string | Buffer,
      opts?: object,
    ) => {
      if (basename(String(path)) === "telemetry.jsonl") {
        const error = new Error("PRIVATE_TELEMETRY_ERROR") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return realWrite(path, body, opts);
    }) as typeof writeFileSync;
    const completion = await runAssignment(manifest, deps);
    const recordDir = join(taskDir, "asg-writer-1");
    assert.equal(completion.transport.status, "completed");
    assert.equal(completion.recording.status, "failed");
    if (completion.recording.status === "failed") {
      assert.equal(completion.recording.steps.telemetry, "failed");
    }
    assert.equal(existsSync(join(recordDir, "telemetry.jsonl")), false);
    const completionPath = join(recordDir, "completion.json");
    const bytes = readFileSync(completionPath);
    await observeAssignment(recordDir);
    assert.deepEqual(readFileSync(completionPath), bytes);
    const lines = () => readFileSync(join(recordDir, "telemetry.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines().length, 1);
    const resolution = JSON.parse(readFileSync(join(recordDir, "recording-resolved.json"), "utf8")) as {
      schema: string;
      completion_sha256: string;
    };
    assert.equal(resolution.schema, RECORDING_RESOLUTION_SCHEMA);
    assert.equal(resolution.completion_sha256, sha256(bytes));
    await observeAssignment(recordDir);
    assert.equal(lines().length, 1);
    assert.deepEqual(readFileSync(completionPath), bytes);
    assert.equal(spawns.length, 1);
  } finally {
    cleanup(root, taskDir);
  }
});

test("pre-invocation prepare failure remains an undispatched refusal", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    const realWrite = writeFileSync;
    (deps as { writeFileSync?: typeof writeFileSync }).writeFileSync = ((
      path: string | Buffer | URL,
      body: string | Buffer,
      opts?: object,
    ) => {
      if (basename(String(path)) === "output-schema.json") {
        const error = new Error("PRIVATE_PREPARE_ERROR") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return realWrite(path, body, opts);
    }) as typeof writeFileSync;
    await assert.rejects(() => runAssignment(manifest, deps));
    assert.equal(spawns.length, 0);
    assert.equal(existsSync(join(taskDir, "asg-writer-1", "completion.json")), false);
    const refusal = JSON.parse(readFileSync(join(taskDir, "asg-writer-1", "refusal.json"), "utf8")) as {
      stage: string;
      code: string;
      provider_calls: number;
    };
    assert.equal(refusal.stage, "prepare");
    assert.equal(refusal.provider_calls, 0);
    assert.equal(existsSync(join(taskDir, "asg-writer-1", "telemetry.jsonl")), false);
  } finally {
    cleanup(root, taskDir);
  }
});

test("unstaged helper throw is failed run with unknown usage and dispatch sidecar", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    (deps as { runHarness?: (request: { output_dir: string }) => Promise<unknown> }).runHarness = async (request) => {
      writeFileSync(join(request.output_dir, "dispatch.json"), `${JSON.stringify({ command: "grok", pid: 1 })}\n`);
      throw new Error("PRIVATE_UNSTAGED_THROW");
    };
    const completion = await runAssignment(manifest, deps);
    assert.equal(spawns.length, 0);
    assert.equal(completion.invocation, "thrown");
    assert.equal(completion.transport.status, "failed");
    assert.equal(completion.transport.stage, "run");
    assert.equal(completion.transport.errorCode, "unrecognized");
    assert.equal(completion.usage.costBasis, "unknown");
    assert.equal(completion.sidecars.harness_dispatch?.path.endsWith("dispatch.json"), true);
    assert.equal(JSON.stringify(completion).includes("PRIVATE_UNSTAGED_THROW"), false);
  } finally {
    cleanup(root, taskDir);
  }
});

test("malicious structured fields and private prose cannot override metadata", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    writeFileSync(join(root, "README.md"), "repo\nstaged\n");
    git(root, ["add", "README.md"]);
    const indexTree = git(root, ["write-tree"]);
    const manifest = reviewerManifest(root, commit, indexTree, taskDir);
    const claim = {
      verdict: "PASS",
      summary: "PRIVATE_REPORT_SENTINEL",
      findings: ["PRIVATE_FINDING_SENTINEL"],
      verification: { status: "passed" },
      cost: 0,
      critic: "PASS",
      role: "implementer",
      usage: { tokensIn: 999 },
      transport: { ok: true },
    };
    const { deps } = dispatchDeps("claude", {
      stdout: claudeAnswer({ status: "done" }, { result: "", structured_output: claim }),
    }, claudeAuth);
    const completion = await runAssignment(manifest, deps);
    assert.equal(completion.verification.status, "not-run");
    assert.equal(completion.route.role, "reviewer-arch");
    assert.equal(completion.usage.tokensIn, 8);
    assert.equal((completion.model_claim?.unrecognizedCount as number) >= 6, true);
    assert.equal(JSON.stringify(completion).includes("PRIVATE_REPORT_SENTINEL"), false);
    assert.equal(JSON.stringify(completion).includes("PRIVATE_FINDING_SENTINEL"), false);
    assert.equal(completion.model_claim?.summary, undefined);
    assert.equal(completion.model_claim?.findings, undefined);
  } finally {
    cleanup(root, taskDir);
  }
});

test("generated schemas close every object, require every field, and match snapshots", () => {
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.type === "object" || record.properties) {
      assert.equal(record.additionalProperties, false);
      assert.deepEqual(
        [...(record.required as string[])].sort(),
        Object.keys(record.properties as object).sort(),
      );
    }
    assert.equal("minimum" in record, false);
    assert.equal("maximum" in record, false);
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  for (const kind of ["plan", "implement", "repair", "review-arch", "review-cli"] as const) {
    const schema = assignmentOutputSchema(kind);
    visit(schema);
    const fixture = JSON.parse(readFileSync(join("test/fixtures/assignment", `output-schema-${kind}.json`), "utf8"));
    assert.deepEqual(schema, fixture);
  }
  const observation = JSON.parse(
    readFileSync(join("test/fixtures/assignment/m3b-codex-schema-observation.json"), "utf8"),
  ) as { liveRejectionObserved: boolean; evidenceLimit: string };
  assert.equal(observation.liveRejectionObserved, false);
  assert.match(observation.evidenceLimit, /not a captured native rejection/);
});

function fakeV2Result(extra: Record<string, unknown> = {}) {
  return {
    schema: "kxm.harness-result.v2",
    ok: true,
    status: "completed",
    stage: "run",
    exitCode: 0,
    observedChildExit: true,
    command: "grok",
    effectiveModel: "grok-4.6",
    startedAt: "2026-09-06T05:00:00.000Z",
    finishedAt: "2026-09-06T05:00:00.012Z",
    latencyMs: 12,
    costBasis: "provider-reported",
    costUsd: 0.25,
    providerReportedCostUsd: 0.25,
    tokensIn: 20,
    tokensOut: 10,
    tokenBasis: "cumulative",
    contextOccupancy: "unknown",
    ...extra,
  };
}

test("routing normalization failure keeps completion and known native facts", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    (deps as { runHarness?: () => Promise<unknown> }).runHarness = async () => fakeV2Result({
      effectiveModel: "x".repeat(201),
    });
    const completion = await runAssignment(manifest, deps);
    const recordDir = join(taskDir, "asg-writer-1");
    assert.equal(spawns.length, 0);
    assert.equal(completion.invocation, "returned");
    assert.equal(completion.transport.status, "completed");
    assert.equal(completion.transport.effectiveModel, "x".repeat(201));
    assert.equal(completion.usage.tokensIn, 20);
    assert.equal(completion.usage.costUsd, 0.25);
    assert.equal(completion.recording.status, "failed");
    if (completion.recording.status === "failed") {
      assert.equal(completion.recording.steps.routing_record, "failed");
      assert.equal(completion.recording.steps.telemetry, "skipped");
    }
    assert.equal(existsSync(join(recordDir, "completion.json")), true);
    assert.equal(existsSync(join(recordDir, "telemetry.jsonl")), false);
    assert.equal(JSON.stringify(completion).includes("PRIVATE_"), false);
  } finally {
    cleanup(root, taskDir);
  }
});

test("malformed telemetry cannot resolve bookkeeping and is left untouched", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    const realWrite = writeFileSync;
    (deps as { writeFileSync?: typeof writeFileSync }).writeFileSync = ((
      path: string | Buffer | URL,
      body: string | Buffer,
      opts?: object,
    ) => {
      if (basename(String(path)) === "telemetry.jsonl") {
        const error = new Error("PRIVATE_TELEMETRY_ERROR") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return realWrite(path, body, opts);
    }) as typeof writeFileSync;
    await runAssignment(manifest, deps);
    const recordDir = join(taskDir, "asg-writer-1");
    const telemetryPath = join(recordDir, "telemetry.jsonl");
    writeFileSync(telemetryPath, "{}\n");
    await assert.rejects(() => observeAssignment(recordDir));
    assert.equal(readFileSync(telemetryPath, "utf8"), "{}\n");
    assert.equal(existsSync(join(recordDir, "recording-resolved.json")), false);
  } finally {
    cleanup(root, taskDir);
  }
});

test("foreign routing record cannot resolve this assignment", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    const realWrite = writeFileSync;
    (deps as { writeFileSync?: typeof writeFileSync }).writeFileSync = ((
      path: string | Buffer | URL,
      body: string | Buffer,
      opts?: object,
    ) => {
      if (basename(String(path)) === "telemetry.jsonl") {
        const error = new Error("PRIVATE_TELEMETRY_ERROR") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return realWrite(path, body, opts);
    }) as typeof writeFileSync;
    await runAssignment(manifest, deps);
    const recordDir = join(taskDir, "asg-writer-1");
    const routingPath = join(recordDir, "routing-record.json");
    const routing = JSON.parse(readFileSync(routingPath, "utf8")) as { workflowRunId: string };
    routing.workflowRunId = "foreign-assignment";
    const bytes = `${JSON.stringify(routing)}\n`;
    writeFileSync(routingPath, bytes);
    await assert.rejects(() => observeAssignment(recordDir));
    assert.equal(readFileSync(routingPath, "utf8"), bytes);
    assert.equal(existsSync(join(recordDir, "recording-resolved.json")), false);
  } finally {
    cleanup(root, taskDir);
  }
});

test("observe does not recover an omitted failed answer sidecar from surviving refs", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    const recordDir = join(taskDir, "asg-writer-1");
    const answerPath = join(recordDir, "native-answer.txt");
    const failingStat = ((path: string) => {
      if (String(path) === answerPath) {
        const error = new Error("PRIVATE_ANSWER_STAT_ERROR") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return statSync(path);
    }) as typeof statSync;
    (deps as { statSync?: typeof statSync }).statSync = failingStat;
    (deps as { runHarness?: typeof import("../../scripts/harness-run.mjs").runHarness }).runHarness = (async () => {
      writeFileSync(join(recordDir, "dispatch.json"), "{}\n");
      writeFileSync(answerPath, "private answer");
      return {
        schema: "kxm.harness-result.v2",
        ok: true,
        status: "completed",
        stage: "run",
        exitCode: 0,
        observedChildExit: true,
        command: "grok",
        effectiveModel: "grok-4.6",
        startedAt: "2026-09-06T05:00:00.000Z",
        finishedAt: "2026-09-06T05:00:00.012Z",
        latencyMs: 12,
        costBasis: "provider-reported",
        costUsd: 0.12,
        providerReportedCostUsd: 0.12,
        tokensIn: 11,
        tokensOut: 5,
        answerPath,
      };
    }) as typeof import("../../scripts/harness-run.mjs").runHarness;
    const completion = await runAssignment(manifest, deps);
    assert.equal(completion.recording.status, "failed");
    if (completion.recording.status === "failed") {
      assert.equal(completion.recording.steps.sidecars, "failed");
    }
    assert.equal(completion.sidecars.answer, undefined);
    assert.equal(completion.sidecars.harness_dispatch?.path.endsWith("dispatch.json"), true);
    const completionPath = join(recordDir, "completion.json");
    const before = readFileSync(completionPath);
    try {
      await observeAssignment(recordDir, { statSync: failingStat });
    } catch {
      // Routing recovery may still succeed; sidecar must remain failed.
    }
    assert.deepEqual(readFileSync(completionPath), before);
    const resolutionPath = join(recordDir, "recording-resolved.json");
    assert.equal(existsSync(resolutionPath), true);
    const resolution = JSON.parse(readFileSync(resolutionPath, "utf8")) as { steps: { sidecars: string } };
    assert.equal(resolution.steps.sidecars, "failed");
    const sink = { write() {} };
    await assignmentMain(["node", "assignment-run.mjs", "observe", "--record-dir", recordDir], {
      stdin: process.stdin,
      stdout: sink as unknown as NodeJS.WriteStream,
      stderr: sink as unknown as NodeJS.WriteStream,
    });
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
    assert.equal(JSON.stringify(completion).includes("PRIVATE_ANSWER_STAT_ERROR"), false);
  } finally {
    cleanup(root, taskDir);
  }
});

test("observe does not invent recovery of a persistent sidecar failure", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    const failingStat = ((path: string) => {
      if (basename(String(path)) === "dispatch.json") {
        const error = new Error("PRIVATE_PERSISTENT_STAT_ERROR") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return statSync(path);
    }) as typeof statSync;
    (deps as { statSync?: typeof statSync }).statSync = failingStat;
    const completion = await runAssignment(manifest, deps);
    assert.equal(completion.recording.status, "failed");
    if (completion.recording.status === "failed") {
      assert.equal(completion.recording.steps.sidecars, "failed");
    }
    const recordDir = join(taskDir, "asg-writer-1");
    try {
      await observeAssignment(recordDir, { statSync: failingStat });
    } catch {
      // Resolution may be withheld when observation cannot recover the sidecar.
    }
    const resolutionPath = join(recordDir, "recording-resolved.json");
    if (existsSync(resolutionPath)) {
      const resolution = JSON.parse(readFileSync(resolutionPath, "utf8")) as { steps: { sidecars: string } };
      assert.notEqual(resolution.steps.sidecars, "ok");
    }
    assert.equal(JSON.stringify(completion).includes("PRIVATE_PERSISTENT_STAT_ERROR"), false);
  } finally {
    cleanup(root, taskDir);
  }
});

test("existing resolution for another completion is rejected without overwrite", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    const realWrite = writeFileSync;
    (deps as { writeFileSync?: typeof writeFileSync }).writeFileSync = ((
      path: string | Buffer | URL,
      body: string | Buffer,
      opts?: object,
    ) => {
      if (basename(String(path)) === "telemetry.jsonl") {
        const error = new Error("PRIVATE_TELEMETRY_ERROR") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return realWrite(path, body, opts);
    }) as typeof writeFileSync;
    await runAssignment(manifest, deps);
    const recordDir = join(taskDir, "asg-writer-1");
    const resolutionPath = join(recordDir, "recording-resolved.json");
    const bytes = `${JSON.stringify({
      schema: RECORDING_RESOLUTION_SCHEMA,
      task_id: "task-a",
      assignment_id: "asg-writer-1",
      resolvedAt: new Date().toISOString(),
      completion_sha256: "0".repeat(64),
      steps: { candidate_snapshot: "ok", sidecars: "ok", routing_record: "ok", telemetry: "ok" },
    })}\n`;
    writeFileSync(resolutionPath, bytes);
    await assert.rejects(() => observeAssignment(recordDir));
    assert.equal(readFileSync(resolutionPath, "utf8"), bytes);
  } finally {
    cleanup(root, taskDir);
  }
});

test("repair telemetry retains rework, latency, and known partial usage", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const first = writerManifest(root, commit, taskDir);
    const firstDeps = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    await runAssignment(first, firstDeps.deps);
    const repair = writerManifest(root, commit, taskDir, {
      assignment_id: "asg-writer-2",
      output_dir: "asg-writer-2",
      kind: "repair",
      rework_of: "asg-writer-1",
    });
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    (deps as { runHarness?: () => Promise<unknown> }).runHarness = async () => fakeV2Result({
      usagePartial: true,
    });
    const completion = await runAssignment(repair, deps);
    assert.equal(completion.rework_of, "asg-writer-1");
    const routing = JSON.parse(readFileSync(join(taskDir, "asg-writer-2", "routing-record.json"), "utf8")) as {
      retries: number;
      providerMetadata: {
        latencyMs?: number;
        usagePartial?: boolean;
        tokenBasis?: string;
        contextOccupancy?: string;
        rework_of?: string;
      };
    };
    assert.equal(routing.retries, 1);
    assert.equal(routing.providerMetadata.latencyMs, 12);
    assert.equal(routing.providerMetadata.usagePartial, true);
    assert.equal(routing.providerMetadata.tokenBasis, "cumulative");
    assert.equal(routing.providerMetadata.contextOccupancy, "unknown");
    assert.equal(routing.providerMetadata.rework_of, "asg-writer-1");
    const bytes = readFileSync(join(taskDir, "asg-writer-2", "routing-record.json"));
    await observeAssignment(join(taskDir, "asg-writer-2"));
    assert.deepEqual(readFileSync(join(taskDir, "asg-writer-2", "routing-record.json")), bytes);
  } finally {
    cleanup(root, taskDir);
  }
});

test("matching telemetry and resolution remain idempotent", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    const completion = await runAssignment(manifest, deps);
    const recordDir = join(taskDir, "asg-writer-1");
    const telemetryPath = assignmentTelemetryPath(recordDir);
    const telemetryBytes = readFileSync(telemetryPath);
    assert.equal(await observeAssignment(recordDir), false);
    assert.deepEqual(readFileSync(telemetryPath), telemetryBytes);
    const resolutionPath = join(recordDir, "recording-resolved.json");
    const resolutionBytes = readFileSync(resolutionPath);
    assert.equal(await observeAssignment(recordDir), false);
    assert.deepEqual(readFileSync(resolutionPath), resolutionBytes);
    assert.equal(appendAssignmentTelemetry({
      ...completion,
      routingRecord: JSON.parse(readFileSync(join(recordDir, "routing-record.json"), "utf8")),
    }, recordDir), false);
    assert.deepEqual(readFileSync(telemetryPath), telemetryBytes);
  } finally {
    cleanup(root, taskDir);
  }
});

test("conflicting telemetry is rejected without overwrite", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    await runAssignment(manifest, deps);
    const recordDir = join(taskDir, "asg-writer-1");
    const telemetryPath = assignmentTelemetryPath(recordDir);
    const foreign = `${JSON.stringify({
      schema: "kxm.telemetry.v1",
      recordedAt: "2026-09-06T00:00:00.000Z",
      host: "local",
      target: "cli",
      envelope: { schema: "kxm.worker-result.v1", command: "foreign", ok: true, outcome: "running", summary: "no", createdAt: "2026-09-06T00:00:00.000Z" },
    })}\n`;
    writeFileSync(telemetryPath, foreign);
    await assert.rejects(() => observeAssignment(recordDir));
    assert.equal(readFileSync(telemetryPath, "utf8"), foreign);
    assert.equal(existsSync(join(recordDir, "recording-resolved.json")), false);
  } finally {
    cleanup(root, taskDir);
  }
});

test("observe CLI recovers telemetry through --record-dir without native spawn", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps, spawns } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth);
    const realWrite = writeFileSync;
    (deps as { writeFileSync?: typeof writeFileSync }).writeFileSync = ((
      path: string | Buffer | URL,
      body: string | Buffer,
      opts?: object,
    ) => {
      if (basename(String(path)) === "telemetry.jsonl") {
        const error = new Error("PRIVATE_TELEMETRY_ERROR") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return realWrite(path, body, opts);
    }) as typeof writeFileSync;
    await runAssignment(manifest, deps);
    const recordDir = realpathSync(join(taskDir, "asg-writer-1"));
    const nativeSpawns = spawns.length;
    const proc = spawnSync(process.execPath, [
      realpathSync(resolve("scripts/assignment-run.mjs")),
      "observe",
      "--record-dir",
      recordDir,
    ], { encoding: "utf8" });
    assert.equal(proc.status, 0, proc.stderr);
    assert.equal(existsSync(join(recordDir, "recording-resolved.json")), true);
    assert.equal(readFileSync(join(recordDir, "telemetry.jsonl"), "utf8").trim().split("\n").length, 1);
    assert.equal(spawns.length, nativeSpawns);
  } finally {
    cleanup(root, taskDir);
  }
});

test("CLI invoked through a parent alias executes validation", () => {
  const aliasRoot = mkdtempSync(join(tmpdir(), "kxm-parent-alias-"));
  const alias = join(aliasRoot, "scripts");
  try {
    symlinkSync(
      resolve("scripts"),
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const proc = spawnSync(process.execPath, [
      join(alias, "assignment-run.mjs"),
      "invalid-command",
    ], { encoding: "utf8" });
    assert.notEqual(proc.status, 0);
    assert.match(proc.stderr, /usage:/);
  } finally {
    rmSync(aliasRoot, { recursive: true, force: true });
  }
});

test("Qwen relief remains a bound writer assignment with fixed witness and honest Pi prompt", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir, { harness: "pi", model: "openrouter/qwen/qwen3-coder-plus", kind: "repair", effort: "medium" });
    const validated = validateAssignmentManifest(manifest);
    assert.equal(validated.role, "writer");
    assert.equal(validated.kind, "repair");
    assert.equal(validated.contract.witness.id, "verify");
    assert.equal(validated.git.head, commit);
    const prompt = renderAssignmentPrompt(validated);
    assert.match(prompt, /OpenRouter model through Pi/);
    assert.match(prompt, /Root re-runs the same fixed witness/);
    assert.doesNotMatch(prompt, /Use only the read, grep, find, and ls tools/);
    assert.throws(() => validateAssignmentManifest({ ...manifest, model: "openrouter/x-ai/grok-4.6" }), /pi writer/);
  } finally { cleanup(root, taskDir); }
});

test("unadmitted roster route or permission mismatch fails closed on manifest validation", () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const unadmittedWriter = writerManifest(root, commit, taskDir, {
      harness: "agy",
      model: "gemini-3.7-flash-high",
    });
    assert.throws(
      () => validateAssignmentManifest(unadmittedWriter),
      (error: unknown) => {
        assert.equal((error as { runnerCode?: string }).runnerCode, "route_invalid");
        assert.match((error as Error).message, /not admitted in lineup for writer/);
        return true;
      },
    );

    const readOnlyLineupPolicy = {
      schema: "kxm.roster-policy.v1",
      routes: {
        "grok-readonly": {
          harness: "grok",
          model: "grok-4.6",
          vendor: "xai",
          roles: ["writer"],
          permissions: ["read-only"],
          status: "admitted",
          efforts: ["low", "medium", "high"],
        },
      },
      lineup: {
        writer: ["grok-readonly"],
        planner: [],
        "reviewer-arch": [],
        "reviewer-cli": [],
      },
    };
    assert.throws(
      () => validateAssignmentManifest(writerManifest(root, commit, taskDir), { rosterPolicy: readOnlyLineupPolicy }),
      (error: unknown) => {
        assert.equal((error as { runnerCode?: string }).runnerCode, "route_invalid");
        assert.match((error as Error).message, /does not permit edit/);
        return true;
      },
    );

    const customPolicy = {
      schema: "kxm.roster-policy.v1",
      routes: {
        "custom-writer": {
          harness: "grok",
          model: "grok-4.6",
          vendor: "xai",
          roles: ["writer"],
          permissions: ["edit"],
          status: "admitted",
          efforts: ["low", "medium", "high"],
        },
      },
      lineup: {
        writer: ["custom-writer"],
        planner: [],
        "reviewer-arch": [],
        "reviewer-cli": [],
      },
    };
    const validManifest = writerManifest(root, commit, taskDir);
    const validated = validateAssignmentManifest(validManifest, { rosterPolicy: customPolicy });
    assert.equal(validated.role, "writer");

    const emptyLineupPolicy = {
      ...customPolicy,
      lineup: { ...customPolicy.lineup, writer: [] },
    };
    assert.throws(
      () => validateAssignmentManifest(validManifest, { rosterPolicy: emptyLineupPolicy }),
      (error: unknown) => {
        assert.equal((error as { runnerCode?: string }).runnerCode, "route_invalid");
        assert.match((error as Error).message, /no admitted lineup for role writer/);
        return true;
      },
    );
  } finally {
    cleanup(root, taskDir);
  }
});


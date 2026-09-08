import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  ASSIGNMENT_SCHEMA,
  COMPLETION_SCHEMA,
  FIXED_GATES,
  PLAN_POINTER_FILENAME,
  PLAN_POINTER_SCHEMA,
  VALIDATE_CI_WITNESS_ID,
  VERIFY_WITNESS_ID,
  WITNESS_LATEST_SCHEMA,
  WITNESS_SCHEMA,
  main as assignmentMain,
  observeAssignment,
  runAssignment,
  witnessAssignment,
} from "../../scripts/assignment-run.mjs";
import {
  claudeAuth,
  fakeChild,
  grokAuth,
} from "../helpers/harness-fake.ts";
import { makeGitRoot } from "../helpers/git-root.ts";

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function initRepo(): { root: string; commit: string } {
  const root = mkdtempSync(join(tmpdir(), "kxm-wit-"));
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

function cleanup(root: string, taskDir: string): void {
  rmSync(root, { recursive: true, force: true });
  rmSync(dirname(taskDir), { recursive: true, force: true });
}

function writePlan(
  taskDir: string,
  taskId: string,
  body = "# plan\n",
  commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
): { sha: string } {
  const planPath = join(taskDir, "plan-current.md");
  writeFileSync(planPath, body);
  const sha = sha256(body);
  writeFileSync(join(taskDir, PLAN_POINTER_FILENAME), `${JSON.stringify({
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
  return { sha };
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
    inputs: [],
    contract: {
      boundary: "Add assignment witness only.",
      deliverables: ["scripts/assignment-run.mjs"],
      witness: { id: VERIFY_WITNESS_ID },
      deferred: ["acceptance"],
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
  const { sha } = writePlan(taskDir, taskId, "# plan\n", commit);
  return {
    schema: ASSIGNMENT_SCHEMA,
    task_id: taskId,
    assignment_id: "asg-review-1",
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
      witness: { id: VALIDATE_CI_WITNESS_ID },
      deferred: [],
    },
    output_dir: "asg-review-1",
    ...overrides,
  };
}

function grokAnswer(claim: unknown) {
  return `${JSON.stringify({
    result: JSON.stringify(claim),
    sessionId: "g1",
    stop_reason: "end_turn",
    total_cost_usd: 0.12,
    usage: { input_tokens: 11, output_tokens: 5 },
    modelUsage: { "grok-4.6": { inputTokens: 11, outputTokens: 5, costUSD: 0.12 } },
  })}\n`;
}

function claudeAnswer(claim: unknown) {
  return `${JSON.stringify({
    result: JSON.stringify(claim),
    is_error: false,
    session_id: "sess-fable",
    stop_reason: "end_turn",
    total_cost_usd: 1.5,
    usage: { input_tokens: 8, output_tokens: 4 },
    modelUsage: { fable: { inputTokens: 8, outputTokens: 4, costUSD: 1.5 } },
  })}\n`;
}

function dispatchDeps(
  harness: string,
  assignment: { stdout?: string; stderr?: string; exitCode?: number | null },
  auth: () => object,
  extras: { onSpawn?: (cwd: string) => void } = {},
) {
  const spawns: Array<{ command: string; argv: string[]; cwd?: string }> = [];
  const deps = {
    platform: process.platform,
    env: { PATH: "/tmp/kxm-harness-bin" },
    observedAt: "2026-09-05",
    now: () => 1_000,
    existsSync: (path: string) => existsSync(path) || String(path).includes(harness),
    spawnSync: ((command: string, args?: readonly string[], options?: object) => {
      if (command === "git") return spawnSync(command, args, options);
      return auth();
    }) as typeof spawnSync,
    spawn: (command: string, argv: string[], options: { cwd?: string }) => {
      const cwd = options.cwd;
      spawns.push(cwd === undefined ? { command, argv } : { command, argv, cwd });
      extras.onSpawn?.(cwd ?? "");
      return fakeChild(assignment);
    },
  };
  return { deps, spawns };
}

function stageDist(cwd: string, body = "export {}\n"): string {
  mkdirSync(join(cwd, "dist"), { recursive: true });
  writeFileSync(join(cwd, "dist", "index.js"), body);
  git(cwd, ["add", "dist/index.js"]);
  return git(cwd, ["write-tree"]);
}

type NpmResult = {
  status?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  error?: NodeJS.ErrnoException;
};

function witnessTransport(npm: (command: string, args: string[], options: { cwd?: string; shell?: boolean }) => NpmResult = () => ({ status: 0, stdout: "ok\n" })) {
  const npmCalls: Array<{ command: string; args: string[]; cwd?: string; shell?: boolean }> = [];
  const gitCalls: string[][] = [];
  const spawn = ((command: string, args?: readonly string[], options?: { cwd?: string; shell?: boolean }) => {
    if (command === "git") {
      gitCalls.push([...(args ?? [])]);
      return spawnSync(command, args, options);
    }
    const argv = [...(args ?? [])];
    const call: { command: string; args: string[]; cwd?: string; shell?: boolean } = {
      command,
      args: argv,
      shell: options?.shell === true,
    };
    if (options?.cwd !== undefined) call.cwd = options.cwd;
    npmCalls.push(call);
    const result = npm(command, argv, options ?? {});
    return {
      status: result.status === undefined ? 0 : result.status,
      signal: result.signal ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error,
    };
  }) as typeof spawnSync;
  return { spawnSync: spawn, npmCalls, gitCalls };
}

function recordDirFor(taskDir: string, assignmentId = "asg-writer-1"): string {
  return realpathSync(join(taskDir, assignmentId));
}

function completionBytes(recordDir: string): Buffer {
  return readFileSync(join(recordDir, "completion.json"));
}

function mutateCompletion(recordDir: string, mutate: (value: Record<string, unknown>) => void): void {
  const path = join(recordDir, "completion.json");
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(value);
  writeFileSync(path, JSON.stringify(value));
}

function failTelemetryWrite(deps: Record<string, unknown>): void {
  const realWrite = writeFileSync;
  deps.writeFileSync = ((
    path: string | Buffer | URL,
    body: string | NodeJS.ArrayBufferView,
    opts?: object,
  ) => {
    if (basename(String(path)) === "telemetry.jsonl") {
      const error = new Error("PRIVATE_TELEMETRY_ERROR") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    return realWrite(path, body, opts);
  }) as typeof writeFileSync;
}

function latestPointer(recordDir: string): {
  schema: string;
  receipt_id: string;
  path: string;
  sha256: string;
  result: string;
} {
  return JSON.parse(readFileSync(join(recordDir, "witness", "latest.json"), "utf8")) as {
    schema: string;
    receipt_id: string;
    path: string;
    sha256: string;
    result: string;
  };
}

test("FIXED_GATES are literal npm argv without a shell", () => {
  assert.deepEqual([...FIXED_GATES.verify], ["npm", "run", "verify"]);
  assert.deepEqual([...FIXED_GATES["validate-ci"]], ["npm", "run", "validate:ci"]);
  assert.equal(VERIFY_WITNESS_ID, "verify");
  assert.equal(VALIDATE_CI_WITNESS_ID, "validate-ci");
});

test("fake writer dispatch to completion to staged-witness lifecycle passes without re-running writer admission", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps, spawns } = dispatchDeps("grok", {
      stdout: grokAnswer({
        status: "done",
        completedCount: 1,
        deferredCount: 0,
        artifactCount: 1,
        verification: { status: "passed" },
        cost: 0,
        critic: { verdict: "PASS" },
      }),
    }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    const completion = await runAssignment(manifest, deps);
    assert.equal(spawns.length, 1);
    assert.equal(completion.schema, COMPLETION_SCHEMA);
    assert.equal(completion.verification.status, "not-run");
    assert.equal(completion.candidate.status, "recorded");
    if (completion.candidate.status === "recorded") {
      assert.equal(completion.candidate.clean, true);
      assert.notEqual(completion.candidate.index_tree, git(root, ["rev-parse", "HEAD^{tree}"]));
    }
    const recordDir = recordDirFor(taskDir);
    const beforeCompletion = completionBytes(recordDir);
    const transport = witnessTransport();
    const receipt = await witnessAssignment(recordDir, { spawnSync: transport.spawnSync });
    assert.equal(receipt.schema, WITNESS_SCHEMA);
    assert.equal(receipt.result, "passed");
    assert.equal(Object.hasOwn(receipt, "code"), false);
    assert.equal(transport.npmCalls.length, 1);
    assert.equal(transport.npmCalls[0]?.command, "npm");
    assert.deepEqual(transport.npmCalls[0]?.args, ["run", "verify"]);
    assert.equal(transport.npmCalls[0]?.shell, false);
    assert.equal(transport.npmCalls[0]?.cwd, root);
    assert.equal(receipt.gates.length, 1);
    assert.deepEqual([...receipt.gates[0]!.argv], ["npm", "run", "verify"]);
    assert.equal(receipt.gates[0]!.shell, false);
    assert.equal(receipt.gates[0]!.exitCode, 0);
    assert.equal(receipt.candidate.before && "index_tree" in receipt.candidate.before, true);
    assert.equal(receipt.candidate.after && "index_tree" in receipt.candidate.after, true);
    if (receipt.candidate.before && "index_tree" in receipt.candidate.before && receipt.candidate.after && "index_tree" in receipt.candidate.after) {
      assert.equal(receipt.candidate.before.head, commit);
      assert.equal(receipt.candidate.after.head, commit);
      assert.equal(receipt.candidate.before.index_tree, receipt.candidate.after.index_tree);
      assert.equal(receipt.candidate.before.clean, true);
      assert.equal(receipt.candidate.after.clean, true);
      if (completion.candidate.status === "recorded") {
        assert.equal(receipt.candidate.before.index_tree, completion.candidate.index_tree);
      }
    }
    assert.equal(receipt.manifest.sha256, completion.manifest.sha256);
    assert.equal(receipt.plan.kind, "current");
    if (receipt.plan.kind === "current") {
      assert.equal(receipt.plan.sha256, completion.plan.kind === "current" ? completion.plan.sha256 : undefined);
    }
    assert.deepEqual(completionBytes(recordDir), beforeCompletion);
    const frozen = JSON.parse(beforeCompletion.toString("utf8")) as { verification: { status: string }; candidate: { status: string } };
    assert.equal(frozen.verification.status, "not-run");
    assert.equal(gitCallsForbidAdmission(transport.gitCalls), true);
    const latest = latestPointer(recordDir);
    assert.equal(latest.schema, WITNESS_LATEST_SCHEMA);
    assert.equal(latest.receipt_id, receipt.receipt_id);
    assert.equal(latest.result, "passed");
    assert.equal(sha256(readFileSync(latest.path)), latest.sha256);
    assert.equal(existsSync(receipt.gates[0]!.log.path), true);
  } finally {
    cleanup(root, taskDir);
  }
});

function gitCallsForbidAdmission(calls: string[][]): boolean {
  const allowed = new Set(["rev-parse", "status", "write-tree"]);
  for (const args of calls) {
    assert.equal(args[0], "--no-optional-locks");
    assert.equal(args[1], "-C");
    assert.equal(allowed.has(args[3]!), true, `unexpected git subcommand ${args[3]}`);
    assert.equal(args.includes("update-index"), false);
    assert.equal(args.includes("cat-file"), false);
    assert.equal(args.includes("diff-index"), false);
  }
  return true;
}

test("dirty unstaged baseline refuses with zero gate execution", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    await runAssignment(writerManifest(root, commit, taskDir), deps);
    writeFileSync(join(root, "dirty.txt"), "unstaged\n");
    const recordDir = recordDirFor(taskDir);
    const before = completionBytes(recordDir);
    const transport = witnessTransport();
    const receipt = await witnessAssignment(recordDir, { spawnSync: transport.spawnSync });
    assert.equal(receipt.result, "refused");
    assert.equal(receipt.code, "dirty_baseline");
    assert.equal(receipt.gates.length, 0);
    assert.equal(transport.npmCalls.length, 0);
    assert.equal(receipt.candidate.after, undefined);
    assert.deepEqual(completionBytes(recordDir), before);
  } finally {
    cleanup(root, taskDir);
  }
});

test("ignored log writes during a gate do not dirty the candidate", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    await runAssignment(writerManifest(root, commit, taskDir), deps);
    const recordDir = recordDirFor(taskDir);
    const transport = witnessTransport((_command, _args, options) => {
      mkdirSync(join(options.cwd ?? root, ".kxm", "logs"), { recursive: true });
      writeFileSync(join(options.cwd ?? root, ".kxm", "logs", "noise.log"), "ignored\n");
      writeFileSync(join(options.cwd ?? root, "scratch.log"), "also ignored\n");
      return { status: 0, stdout: "ok\n" };
    });
    const receipt = await witnessAssignment(recordDir, { spawnSync: transport.spawnSync });
    assert.equal(receipt.result, "passed");
    assert.equal(transport.npmCalls.length, 1);
    if (receipt.candidate.after && "clean" in receipt.candidate.after) {
      assert.equal(receipt.candidate.after.clean, true);
    }
  } finally {
    cleanup(root, taskDir);
  }
});

test("index change during a passing gate fails candidate_changed", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    await runAssignment(writerManifest(root, commit, taskDir), deps);
    const recordDir = recordDirFor(taskDir);
    const transport = witnessTransport((_command, _args, options) => {
      writeFileSync(join(options.cwd ?? root, "extra.js"), "extra\n");
      git(options.cwd ?? root, ["add", "extra.js"]);
      return { status: 0, stdout: "ok\n" };
    });
    const receipt = await witnessAssignment(recordDir, { spawnSync: transport.spawnSync });
    assert.equal(receipt.result, "failed");
    assert.equal(receipt.code, "candidate_changed");
    assert.equal(receipt.gates[0]?.exitCode, 0);
    assert.equal(transport.npmCalls.length, 1);
    if (receipt.candidate.before && "index_tree" in receipt.candidate.before && receipt.candidate.after && "index_tree" in receipt.candidate.after) {
      assert.notEqual(receipt.candidate.before.index_tree, receipt.candidate.after.index_tree);
    }
  } finally {
    cleanup(root, taskDir);
  }
});

test("HEAD change during a passing gate fails candidate_changed", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    await runAssignment(writerManifest(root, commit, taskDir), deps);
    const recordDir = recordDirFor(taskDir);
    const transport = witnessTransport((_command, _args, options) => {
      const cwd = options.cwd ?? root;
      git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "during-gate"]);
      return { status: 0, stdout: "ok\n" };
    });
    const receipt = await witnessAssignment(recordDir, { spawnSync: transport.spawnSync });
    assert.equal(receipt.result, "failed");
    assert.equal(receipt.code, "candidate_changed");
    assert.equal(receipt.gates[0]?.exitCode, 0);
    if (receipt.candidate.after && "head" in receipt.candidate.after) {
      assert.notEqual(receipt.candidate.after.head, commit);
    }
  } finally {
    cleanup(root, taskDir);
  }
});

test("unstaged worktree edit during a passing gate fails candidate_changed", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    await runAssignment(writerManifest(root, commit, taskDir), deps);
    const recordDir = recordDirFor(taskDir);
    const transport = witnessTransport((_command, _args, options) => {
      writeFileSync(join(options.cwd ?? root, "README.md"), "repo\nedited\n");
      return { status: 0, stdout: "ok\n" };
    });
    const receipt = await witnessAssignment(recordDir, { spawnSync: transport.spawnSync });
    assert.equal(receipt.result, "failed");
    assert.equal(receipt.code, "candidate_changed");
    if (receipt.candidate.after && "clean" in receipt.candidate.after) {
      assert.equal(receipt.candidate.after.clean, false);
    }
  } finally {
    cleanup(root, taskDir);
  }
});

test("nonzero gate exit is recorded and artifacts are retained", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    await runAssignment(writerManifest(root, commit, taskDir), deps);
    const recordDir = recordDirFor(taskDir);
    const before = completionBytes(recordDir);
    const transport = witnessTransport(() => ({ status: 1, stdout: "failed\n", stderr: "PRIVATE_GATE_STDERR\n" }));
    const receipt = await witnessAssignment(recordDir, { spawnSync: transport.spawnSync });
    assert.equal(receipt.result, "failed");
    assert.equal(receipt.code, "gate_failed");
    assert.equal(receipt.gates[0]?.exitCode, 1);
    assert.equal(JSON.stringify(receipt).includes("PRIVATE_GATE_STDERR"), false);
    const log = readFileSync(receipt.gates[0]!.log.path, "utf8");
    assert.equal(log.includes("PRIVATE_GATE_STDERR"), true);
    assert.deepEqual(completionBytes(recordDir), before);
  } finally {
    cleanup(root, taskDir);
  }
});

test("signal and spawn errors are recorded honestly", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    await runAssignment(writerManifest(root, commit, taskDir), deps);
    const recordDir = recordDirFor(taskDir);
    const signalTransport = witnessTransport(() => ({ status: null, signal: "SIGTERM" }));
    const signalReceipt = await witnessAssignment(recordDir, { spawnSync: signalTransport.spawnSync });
    assert.equal(signalReceipt.result, "failed");
    assert.equal(signalReceipt.code, "gate_failed");
    assert.equal(signalReceipt.gates[0]?.exitCode, null);
    assert.equal(signalReceipt.gates[0]?.signal, "SIGTERM");

    const spawnTransport = witnessTransport(() => {
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      return { status: null, error };
    });
    const spawnReceipt = await witnessAssignment(recordDir, { spawnSync: spawnTransport.spawnSync });
    assert.equal(spawnReceipt.result, "failed");
    assert.equal(spawnReceipt.code, "gate_failed");
    assert.equal(spawnReceipt.gates[0]?.exitCode, null);
    assert.equal(JSON.stringify(spawnReceipt).includes("not found"), false);
    const log = readFileSync(spawnReceipt.gates[0]!.log.path, "utf8");
    assert.equal(log.includes("ENOENT"), true);
    assert.notEqual(spawnReceipt.receipt_id, signalReceipt.receipt_id);
    const latest = latestPointer(recordDir);
    assert.equal(latest.receipt_id, spawnReceipt.receipt_id);
    assert.equal(existsSync(join(recordDir, "witness", "history", `${signalReceipt.receipt_id}.json`)), true);
  } finally {
    cleanup(root, taskDir);
  }
});

test("repeat witness retains history and updates latest", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    await runAssignment(writerManifest(root, commit, taskDir), deps);
    const recordDir = recordDirFor(taskDir);
    const first = await witnessAssignment(recordDir, { spawnSync: witnessTransport().spawnSync });
    const second = await witnessAssignment(recordDir, { spawnSync: witnessTransport().spawnSync });
    assert.equal(first.result, "passed");
    assert.equal(second.result, "passed");
    assert.notEqual(first.receipt_id, second.receipt_id);
    const history = readdirSync(join(recordDir, "witness", "history")).filter((name) => name.endsWith(".json")).sort();
    assert.equal(history.length, 2);
    assert.equal(latestPointer(recordDir).receipt_id, second.receipt_id);
    assert.equal(existsSync(join(recordDir, "witness", "history", `${first.receipt_id}.json`)), true);
  } finally {
    cleanup(root, taskDir);
  }
});

test("missing completion refuses without a receipt", async () => {
  const taskDir = initTask();
  const empty = join(taskDir, "missing-id");
  mkdirSync(empty);
  try {
    await assert.rejects(
      () => witnessAssignment(empty, { spawnSync: witnessTransport().spawnSync }),
      (error: unknown) => {
        assert.equal((error as { runnerCode?: string }).runnerCode, "completion_missing");
        return true;
      },
    );
    assert.equal(existsSync(join(empty, "witness")), false);
  } finally {
    rmSync(dirname(taskDir), { recursive: true, force: true });
  }
});

test("invalid completion refuses without treating model text as a pass", async () => {
  const taskDir = initTask();
  const recordDir = join(taskDir, "asg-bad");
  mkdirSync(recordDir);
  writeFileSync(join(recordDir, "completion.json"), "{\"schema\":\"nope\"}\n");
  try {
    await assert.rejects(
      () => witnessAssignment(recordDir, { spawnSync: witnessTransport().spawnSync }),
      (error: unknown) => {
        assert.equal((error as { runnerCode?: string }).runnerCode, "completion_invalid");
        return true;
      },
    );
  } finally {
    rmSync(dirname(taskDir), { recursive: true, force: true });
  }
});

test("mismatched completion assignment_id refuses before any npm execution", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    await runAssignment(writerManifest(root, commit, taskDir), deps);
    const recordDir = recordDirFor(taskDir);
    mutateCompletion(recordDir, (value) => {
      value.assignment_id = "different-assignment";
    });
    const transport = witnessTransport();
    const receipt = await witnessAssignment(recordDir, { spawnSync: transport.spawnSync });
    assert.equal(receipt.result, "refused");
    assert.equal(receipt.code, "witness_binding_invalid");
    assert.equal(receipt.assignment_id, "asg-writer-1");
    assert.equal(receipt.gates.length, 0);
    assert.equal(transport.npmCalls.length, 0);
  } finally {
    cleanup(root, taskDir);
  }
});

test("mismatched completion cwd refuses before verifying another repository", async () => {
  const { root, commit } = initRepo();
  const other = initRepo();
  const taskDir = initTask();
  try {
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    await runAssignment(writerManifest(root, commit, taskDir), deps);
    const recordDir = recordDirFor(taskDir);
    mutateCompletion(recordDir, (value) => {
      const binding = value.binding as Record<string, unknown>;
      binding.cwd = other.root;
    });
    const transport = witnessTransport();
    const receipt = await witnessAssignment(recordDir, { spawnSync: transport.spawnSync });
    assert.equal(receipt.result, "refused");
    assert.equal(receipt.code, "witness_binding_invalid");
    assert.equal(receipt.gates.length, 0);
    assert.equal(transport.npmCalls.length, 0);
    assert.equal(transport.npmCalls.every((call) => call.cwd !== other.root), true);
  } finally {
    cleanup(root, taskDir);
    rmSync(other.root, { recursive: true, force: true });
  }
});

test("parent-aliased completion cwd still matches the stored manifest", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    await runAssignment(writerManifest(root, commit, taskDir), deps);
    const recordDir = recordDirFor(taskDir);
    mutateCompletion(recordDir, (value) => {
      const binding = value.binding as Record<string, unknown>;
      binding.cwd = realpathSync(root);
    });
    const transport = witnessTransport();
    const receipt = await witnessAssignment(recordDir, { spawnSync: transport.spawnSync });
    assert.equal(receipt.result, "passed");
    assert.equal(transport.npmCalls.length, 1);
    assert.equal(transport.npmCalls[0]?.cwd, root);
  } finally {
    cleanup(root, taskDir);
  }
});

test("completion cannot replace a stored current plan with bootstrap", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    await runAssignment(writerManifest(root, commit, taskDir), deps);
    const recordDir = recordDirFor(taskDir);
    mutateCompletion(recordDir, (value) => {
      value.plan = { kind: "bootstrap", reason: "forged bypass" };
    });
    const transport = witnessTransport();
    const receipt = await witnessAssignment(recordDir, { spawnSync: transport.spawnSync });
    assert.equal(receipt.result, "refused");
    assert.equal(receipt.code, "plan_mismatch");
    assert.equal(receipt.gates.length, 0);
    assert.equal(transport.npmCalls.length, 0);
  } finally {
    cleanup(root, taskDir);
  }
});

test("unresolved telemetry refuses before any npm execution", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    failTelemetryWrite(deps);
    const completion = await runAssignment(writerManifest(root, commit, taskDir), deps);
    assert.equal(completion.recording.status, "failed");
    if (completion.recording.status === "failed") {
      assert.equal(completion.recording.steps.telemetry, "failed");
    }
    const recordDir = recordDirFor(taskDir);
    const transport = witnessTransport();
    const receipt = await witnessAssignment(recordDir, { spawnSync: transport.spawnSync });
    assert.equal(receipt.result, "refused");
    assert.equal(receipt.code, "recording_unresolved");
    assert.equal(receipt.gates.length, 0);
    assert.equal(transport.npmCalls.length, 0);
  } finally {
    cleanup(root, taskDir);
  }
});

test("recovered telemetry permits witness without rewriting completion", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    failTelemetryWrite(deps);
    await runAssignment(writerManifest(root, commit, taskDir), deps);
    const recordDir = recordDirFor(taskDir);
    const before = completionBytes(recordDir);
    await observeAssignment(recordDir);
    const transport = witnessTransport();
    const receipt = await witnessAssignment(recordDir, { spawnSync: transport.spawnSync });
    assert.equal(receipt.result, "passed");
    assert.equal(transport.npmCalls.length, 1);
    assert.deepEqual(completionBytes(recordDir), before);
  } finally {
    cleanup(root, taskDir);
  }
});

test("stale recording resolution cannot authorize witness", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    failTelemetryWrite(deps);
    await runAssignment(writerManifest(root, commit, taskDir), deps);
    const recordDir = recordDirFor(taskDir);
    await observeAssignment(recordDir);
    const resolutionPath = join(recordDir, "recording-resolved.json");
    const resolution = JSON.parse(readFileSync(resolutionPath, "utf8")) as Record<string, unknown>;
    resolution.completion_sha256 = "0".repeat(64);
    writeFileSync(resolutionPath, JSON.stringify(resolution));
    const transport = witnessTransport();
    const receipt = await witnessAssignment(recordDir, { spawnSync: transport.spawnSync });
    assert.equal(receipt.result, "refused");
    assert.equal(receipt.code, "recording_unresolved");
    assert.equal(receipt.gates.length, 0);
    assert.equal(transport.npmCalls.length, 0);
  } finally {
    cleanup(root, taskDir);
  }
});

test("originally admitted bootstrap review still witnesses", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    writeFileSync(join(root, "README.md"), "repo\nstaged\n");
    git(root, ["add", "README.md"]);
    const indexTree = git(root, ["write-tree"]);
    const { deps } = dispatchDeps("claude", { stdout: claudeAnswer({ verdict: "PASS", summary: "ok", findings: [] }) }, claudeAuth);
    await runAssignment({
      schema: ASSIGNMENT_SCHEMA,
      task_id: "task-a",
      assignment_id: "asg-review-1",
      kind: "review-arch",
      harness: "claude",
      model: "fable",
      effort: "high",
      permission: "read-only",
      cwd: root,
      task_dir: taskDir,
      base: { kind: "staged", commit, index_tree: indexTree },
      plan_ref: { kind: "bootstrap", reason: "no current pointer" },
      inputs: [],
      contract: {
        boundary: "Review the staged candidate.",
        deliverables: [],
        witness: { id: VALIDATE_CI_WITNESS_ID },
        deferred: [],
      },
      output_dir: "asg-review-1",
    }, deps);
    const recordDir = recordDirFor(taskDir, "asg-review-1");
    const transport = witnessTransport();
    const receipt = await witnessAssignment(recordDir, { spawnSync: transport.spawnSync });
    assert.equal(receipt.result, "passed");
    assert.equal(receipt.plan.kind, "bootstrap");
    assert.deepEqual(transport.npmCalls.map((call) => [call.command, ...call.args]), [["npm", "run", "validate:ci"]]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("current plan binding mismatch refuses with zero gates", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    await runAssignment(writerManifest(root, commit, taskDir), deps);
    writeFileSync(join(taskDir, "plan-current.md"), "# mutated plan\n");
    const recordDir = recordDirFor(taskDir);
    const transport = witnessTransport();
    const receipt = await witnessAssignment(recordDir, { spawnSync: transport.spawnSync });
    assert.equal(receipt.result, "refused");
    assert.equal(receipt.code, "plan_mismatch");
    assert.equal(receipt.gates.length, 0);
    assert.equal(transport.npmCalls.length, 0);
  } finally {
    cleanup(root, taskDir);
  }
});

test("unknown completion candidate stays unknown while witness snapshots independently", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const manifest = writerManifest(root, commit, taskDir);
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
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
    assert.equal(completion.candidate.status, "unknown");
    const recordDir = recordDirFor(taskDir);
    const dirtyTransport = witnessTransport();
    const dirty = await witnessAssignment(recordDir, { spawnSync: dirtyTransport.spawnSync });
    assert.equal(dirty.result, "refused");
    assert.equal(dirty.code, "dirty_baseline");
    assert.equal(dirtyTransport.npmCalls.length, 0);
    git(root, ["add", "native-output.txt"]);
    const passTransport = witnessTransport();
    const receipt = await witnessAssignment(recordDir, { spawnSync: passTransport.spawnSync });
    assert.equal(receipt.result, "passed");
    assert.equal(passTransport.npmCalls.length, 1);
    const frozen = JSON.parse(completionBytes(recordDir).toString("utf8")) as {
      candidate: { status: string; code?: string };
      verification: { status: string };
    };
    assert.equal(frozen.candidate.status, "unknown");
    assert.equal(frozen.candidate.code, "snapshot_failed");
    assert.equal(frozen.verification.status, "not-run");
    if (receipt.candidate.before && "index_tree" in receipt.candidate.before) {
      assert.equal(receipt.candidate.before.clean, true);
    }
  } finally {
    cleanup(root, taskDir);
  }
});

test("validate-ci gate uses the fixed argv and preserves gate order", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    writeFileSync(join(root, "README.md"), "repo\nstaged\n");
    git(root, ["add", "README.md"]);
    const indexTree = git(root, ["write-tree"]);
    const { deps } = dispatchDeps("claude", { stdout: claudeAnswer({ verdict: "PASS", summary: "ok", findings: [] }) }, claudeAuth);
    await runAssignment(reviewerManifest(root, commit, indexTree, taskDir), deps);
    const recordDir = recordDirFor(taskDir, "asg-review-1");
    const transport = witnessTransport();
    const receipt = await witnessAssignment(recordDir, { spawnSync: transport.spawnSync });
    assert.equal(receipt.result, "passed");
    assert.deepEqual(transport.npmCalls.map((call) => [call.command, ...call.args]), [["npm", "run", "validate:ci"]]);
    assert.equal(transport.npmCalls[0]?.shell, false);
    assert.deepEqual([...receipt.gates[0]!.argv], ["npm", "run", "validate:ci"]);
  } finally {
    cleanup(root, taskDir);
  }
});

test("witness CLI requires an absolute record dir and prints the receipt", async () => {
  const { root, commit } = initRepo();
  const taskDir = initTask();
  try {
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    await runAssignment(writerManifest(root, commit, taskDir), deps);
    await assert.rejects(
      () => assignmentMain(["node", "assignment-run.mjs", "witness", "--record-dir", "relative"]),
      /absolute path/,
    );
    const recordDir = recordDirFor(taskDir);
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    const transport = witnessTransport();
    const receipt = await assignmentMain(["node", "assignment-run.mjs", "witness", "--record-dir", recordDir], {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      spawnSync: transport.spawnSync,
    });
    assert.equal((receipt as { result?: string }).result, "passed");
    assert.equal(process.exitCode, 0);
    const printed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { schema: string; result: string };
    assert.equal(printed.schema, WITNESS_SCHEMA);
    assert.equal(printed.result, "passed");
  } finally {
    process.exitCode = 0;
    cleanup(root, taskDir);
  }
});

test("relative record-dir and missing completion stay fail-closed on the CLI", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  await assert.rejects(
    () => assignmentMain(["node", "assignment-run.mjs", "witness"], { stdin: new PassThrough(), stdout, stderr }),
    /usage:/,
  );
});

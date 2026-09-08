import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  ACCEPTED_NOTE,
  ACCEPTED_SCHEMA,
  ASSIGNMENT_SCHEMA,
  COMPLETION_SCHEMA,
  PLAN_POINTER_FILENAME,
  PLAN_POINTER_SCHEMA,
  REQUIRED_ACCEPT_CRITICS,
  RUNNER_CODES,
  VERIFY_WITNESS_ID,
  acceptAssignment,
  main as assignmentMain,
  observeAssignment,
  resolveRequiredCritics,
  runAssignment,
  witnessAssignment,
  writeCurrentPlan,
} from "../scripts/assignment-run.mjs";
import {
  claudeAuth,
  codexAuth,
  fakeChild,
  grokAuth,
} from "./helpers/harness-fake.ts";
import { makeGitRoot } from "./helpers/git-root.ts";

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function initRepo(): { root: string; commit: string } {
  const root = mkdtempSync(join(tmpdir(), "kxm-acc-"));
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
  generation = 1,
): { sha: string; path: string } {
  const planPath = join(taskDir, "plan-current.md");
  writeFileSync(planPath, body);
  const sha = sha256(body);
  writeFileSync(join(taskDir, PLAN_POINTER_FILENAME), `${JSON.stringify({
    schema: PLAN_POINTER_SCHEMA,
    task_id: taskId,
    generation,
    plan_path: "plan-current.md",
    plan_sha256: sha,
    base_commit: commit,
    settled_decisions: ["start"],
    updated_at: "2026-09-06T00:00:00.000Z",
    supersedes: [],
  }, null, 2)}\n`);
  return { sha, path: planPath };
}

function writerManifest(
  root: string,
  commit: string,
  taskDir: string,
  overrides: Record<string, unknown> = {},
) {
  const taskId = "task-a";
  const assignmentId = typeof overrides.assignment_id === "string" ? overrides.assignment_id : "asg-writer-1";
  const planRef = overrides.plan_ref as { kind?: string; path?: string; sha256?: string } | undefined;
  const { sha } = planRef
    ? { sha: typeof planRef.sha256 === "string" ? planRef.sha256 : "" }
    : writePlan(taskDir, taskId, "# plan\n", commit);
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
    plan_ref: planRef ?? { kind: "current", path: "plan-current.md", sha256: sha },
    inputs: [],
    contract: {
      boundary: "Add assignment accept only.",
      deliverables: ["scripts/assignment-run.mjs"],
      witness: { id: VERIFY_WITNESS_ID },
      deferred: ["attribution"],
    },
    output_dir: assignmentId,
    ...overrides,
  };
}

function reviewerManifest(
  root: string,
  commit: string,
  taskDir: string,
  overrides: Record<string, unknown> = {},
) {
  const taskId = "task-a";
  const assignmentId = typeof overrides.assignment_id === "string" ? overrides.assignment_id : "asg-arch-1";
  const planRef = overrides.plan_ref as { kind?: string; path?: string; sha256?: string } | undefined;
  const { sha } = planRef
    ? { sha: typeof planRef.sha256 === "string" ? planRef.sha256 : "" }
    : writePlan(taskDir, taskId, "# plan\n", commit);
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
    base: { kind: "clean", commit },
    plan_ref: planRef ?? { kind: "current", path: "plan-current.md", sha256: sha },
    inputs: [],
    contract: {
      boundary: "Review the accepted tree.",
      deliverables: [],
      witness: { id: "validate-ci" },
      deferred: [],
    },
    output_dir: assignmentId,
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

function reviewAnswer(claim: unknown) {
  return `${JSON.stringify({
    result: JSON.stringify(claim),
    is_error: false,
    session_id: "sess-review",
    stop_reason: "end_turn",
    total_cost_usd: 1.5,
    usage: { input_tokens: 8, output_tokens: 4 },
  })}\n`;
}

function codexAnswer(claim: unknown) {
  return [
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(claim) },
    }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 8, output_tokens: 4 } }),
  ].join("\n");
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

function witnessTransport(npm: () => NpmResult = () => ({ status: 0, stdout: "ok\n" })) {
  const npmCalls: Array<{ command: string; args: string[] }> = [];
  const spawn = ((command: string, args?: readonly string[], options?: object) => {
    if (command === "git") return spawnSync(command, args, options);
    npmCalls.push({ command, args: [...(args ?? [])] });
    const result = npm();
    return {
      status: result.status === undefined ? 0 : result.status,
      signal: result.signal ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error,
    };
  }) as typeof spawnSync;
  return { spawnSync: spawn, npmCalls };
}

function acceptTransport() {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn = ((command: string, args?: readonly string[], options?: object) => {
    calls.push({ command, args: [...(args ?? [])] });
    if (command === "npm") {
      const error = new Error("npm must not spawn during accept") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      return { status: null, signal: null, stdout: "", stderr: "", error };
    }
    return spawnSync(command, args, options);
  }) as typeof spawnSync;
  return { spawnSync: spawn, calls };
}

function recordDirFor(taskDir: string, assignmentId: string): string {
  return realpathSync(join(taskDir, assignmentId));
}

function mutateJson(path: string, mutate: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(value);
  writeFileSync(path, JSON.stringify(value));
}

function mutateCompletion(recordDir: string, mutate: (value: Record<string, unknown>) => void): void {
  mutateJson(join(recordDir, "completion.json"), mutate);
}

function latestPointer(recordDir: string): {
  receipt_id: string;
  path: string;
  sha256: string;
  result: string;
} {
  return JSON.parse(readFileSync(join(recordDir, "witness", "latest.json"), "utf8")) as {
    receipt_id: string;
    path: string;
    sha256: string;
    result: string;
  };
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

async function runWriter(
  root: string,
  commit: string,
  taskDir: string,
  assignmentId = "asg-writer-1",
  extras: Record<string, unknown> = {},
) {
  const { deps, spawns } = dispatchDeps("grok", {
    stdout: grokAnswer({
      status: "done",
      completedCount: 1,
      deferredCount: 0,
      artifactCount: 1,
    }),
  }, grokAuth, {
    onSpawn: (cwd) => {
      stageDist(cwd);
    },
  });
  const completion = await runAssignment(writerManifest(root, commit, taskDir, {
    assignment_id: assignmentId,
    output_dir: assignmentId,
    ...extras,
  }), deps);
  assert.equal(spawns.length, 1);
  assert.equal(completion.schema, COMPLETION_SCHEMA);
  return recordDirFor(taskDir, assignmentId);
}

async function runWitness(recordDir: string, npm?: () => NpmResult) {
  const transport = witnessTransport(npm);
  const receipt = await witnessAssignment(recordDir, { spawnSync: transport.spawnSync });
  return { receipt, npmCalls: transport.npmCalls };
}

function commitIndex(root: string): { commit: string; tree: string } {
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "writer"]);
  return {
    commit: git(root, ["rev-parse", "HEAD"]),
    tree: git(root, ["rev-parse", "HEAD^{tree}"]),
  };
}

async function runReview(
  root: string,
  commit: string,
  taskDir: string,
  kind: "review-arch" | "review-cli",
  assignmentId: string,
  extras: Record<string, unknown> = {},
  claim: Record<string, unknown> = { verdict: "PASS", summary: "ok", findings: [] },
) {
  const harness = kind === "review-arch" ? "claude" : "codex";
  const model = kind === "review-arch" ? "fable" : "gpt-5.6-sol";
  const auth = kind === "review-arch" ? claudeAuth : codexAuth;
  const stdout = kind === "review-arch" ? reviewAnswer(claim) : codexAnswer(claim);
  const { deps } = dispatchDeps(harness, { stdout }, auth);
  await runAssignment(reviewerManifest(root, commit, taskDir, {
    assignment_id: assignmentId,
    kind,
    harness,
    model,
    effort: kind === "review-cli" ? "low" : "high",
    output_dir: assignmentId,
    ...extras,
  }), deps);
  return recordDirFor(taskDir, assignmentId);
}

async function prepareAcceptedWorld() {
  const { root, commit: baseCommit } = initRepo();
  const taskDir = initTask();
  const writerDir = await runWriter(root, baseCommit, taskDir);
  const { receipt } = await runWitness(writerDir);
  assert.equal(receipt.result, "passed");
  const { commit, tree } = commitIndex(root);
  assert.equal(tree, receipt.candidate.after && "index_tree" in receipt.candidate.after
    ? receipt.candidate.after.index_tree
    : "");
  const archDir = await runReview(root, commit, taskDir, "review-arch", "asg-arch-1");
  const cliDir = await runReview(root, commit, taskDir, "review-cli", "asg-cli-1");
  return { root, taskDir, writerDir, archDir, cliDir, commit, tree, receipt };
}

function rejectCode(code: string) {
  return (error: unknown) => {
    assert.equal((error as { runnerCode?: string }).runnerCode, code);
    return true;
  };
}

test("REQUIRED_ACCEPT_CRITICS are the designated Fable and Sol routes", () => {
  assert.deepEqual(REQUIRED_ACCEPT_CRITICS["review-arch"], {
    harness: "claude",
    model: "fable",
    role: "reviewer-arch",
  });
  assert.deepEqual(REQUIRED_ACCEPT_CRITICS["review-cli"], {
    harness: "codex",
    model: "gpt-5.6-sol",
    role: "reviewer-cli",
  });
  assert.equal(RUNNER_CODES.includes("commit_missing"), true);
  assert.equal(RUNNER_CODES.includes("critic_block"), true);
  assert.equal(RUNNER_CODES.includes("accepted_exists"), true);
});

test("fake writer completion staged-witness real commit and bound critics accept", async () => {
  const world = await prepareAcceptedWorld();
  try {
    const transport = acceptTransport();
    const accepted = await acceptAssignment({
      taskDir: world.taskDir,
      commit: world.commit,
      recordDir: world.writerDir,
      critics: [world.archDir, world.cliDir],
      observedPr: "128",
      observedCi: "34006194862",
    }, { spawnSync: transport.spawnSync });
    assert.equal(accepted.schema, ACCEPTED_SCHEMA);
    assert.equal(accepted.task_id, "task-a");
    assert.equal(accepted.commit, world.commit);
    assert.equal(accepted.tree, world.tree);
    assert.equal(accepted.writer.kind, "implement");
    assert.equal(accepted.writer.receipt.id, world.receipt.receipt_id);
    assert.equal(accepted.writer.receipt.sha256, sha256(readFileSync(world.receipt.path!)));
    assert.equal(accepted.plan.kind, "current");
    assert.equal(accepted.critics.length, 2);
    const kinds = accepted.critics.map((item) => item.kind).sort();
    assert.deepEqual(kinds, ["review-arch", "review-cli"]);
    for (const critic of accepted.critics) {
      assert.equal(critic.verdict, "PASS");
      assert.equal(critic.judged_tree, world.tree);
    }
    assert.deepEqual(accepted.observed, {
      pr: { id: "128", validated: false },
      ci: { id: "34006194862", validated: false },
    });
    assert.equal(accepted.note, ACCEPTED_NOTE);
    const acceptedPath = join(world.taskDir, "accepted.json");
    assert.equal(existsSync(acceptedPath), true);
    assert.equal(modeOf(acceptedPath), 0o600);
    assert.equal(transport.calls.some((call) => call.command === "npm"), false);
    assert.equal(transport.calls.every((call) => call.command === "git"), true);
    assert.equal(transport.calls.some((call) => call.args.includes("write-tree")), false);
    assert.equal(transport.calls.some((call) => call.args.includes("cat-file")), true);
    const publicText = JSON.stringify(accepted);
    assert.equal(publicText.includes("human approval"), true);
    assert.equal(JSON.parse(readFileSync(acceptedPath, "utf8")).observed.pr.validated, false);
  } finally {
    cleanup(world.root, world.taskDir);
  }
});

test("accept CLI requires literal argv and rejects run --task-dir", async () => {
  const world = await prepareAcceptedWorld();
  try {
    await assert.rejects(
      () => assignmentMain(["node", "assignment-run.mjs", "run", "--manifest", "/tmp/x.json", "--task-dir", world.taskDir]),
      /does not accept --task-dir/,
    );
    await assert.rejects(
      () => assignmentMain(["node", "assignment-run.mjs", "accept", "--task-dir", world.taskDir, "--task-dir", world.taskDir, "--commit", world.commit, "--record-dir", world.writerDir, "--critic", world.archDir, "--critic", world.cliDir]),
      /duplicate option/,
    );
    await assert.rejects(
      () => assignmentMain(["node", "assignment-run.mjs", "accept", "--task-dir", world.taskDir, "--commit", world.commit, "--record-dir", world.writerDir, "--critic", world.archDir, "--unknown", "x"]),
      /unknown accept option/,
    );
    await assert.rejects(
      () => assignmentMain(["node", "assignment-run.mjs", "accept", "--task-dir", "relative", "--commit", world.commit, "--record-dir", world.writerDir, "--critic", world.archDir, "--critic", world.cliDir]),
      /absolute path/,
    );
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    const transport = acceptTransport();
    const accepted = await assignmentMain([
      "node",
      "assignment-run.mjs",
      "accept",
      "--task-dir",
      world.taskDir,
      "--commit",
      world.commit,
      "--record-dir",
      world.writerDir,
      "--critic",
      world.archDir,
      "--critic",
      world.cliDir,
    ], {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      spawnSync: transport.spawnSync,
    });
    assert.equal((accepted as { schema?: string }).schema, ACCEPTED_SCHEMA);
    assert.equal(process.exitCode, 0);
    const printed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { schema: string; tree: string };
    assert.equal(printed.schema, ACCEPTED_SCHEMA);
    assert.equal(printed.tree, world.tree);
  } finally {
    process.exitCode = 0;
    cleanup(world.root, world.taskDir);
  }
});

test("nonexistent commit and other commit tree refuse without npm", async () => {
  const world = await prepareAcceptedWorld();
  try {
    const missing = acceptTransport();
    await assert.rejects(
      () => acceptAssignment({
        taskDir: world.taskDir,
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        recordDir: world.writerDir,
        critics: [world.archDir, world.cliDir],
      }, { spawnSync: missing.spawnSync }),
      rejectCode("commit_missing"),
    );
    assert.equal(missing.calls.some((call) => call.command === "npm"), false);
    const other = acceptTransport();
    const base = git(world.root, ["rev-parse", "HEAD~1"]);
    await assert.rejects(
      () => acceptAssignment({
        taskDir: world.taskDir,
        commit: base,
        recordDir: world.writerDir,
        critics: [world.archDir, world.cliDir],
      }, { spawnSync: other.spawnSync }),
      rejectCode("commit_tree_mismatch"),
    );
    assert.equal(existsSync(join(world.taskDir, "accepted.json")), false);
  } finally {
    cleanup(world.root, world.taskDir);
  }
});

test("absent failed stale and changed-hash witness refuse", async () => {
  const { root, commit: baseCommit } = initRepo();
  const taskDir = initTask();
  try {
    const writerDir = await runWriter(root, baseCommit, taskDir);
    mkdirSync(join(taskDir, "asg-dummy-arch"));
    mkdirSync(join(taskDir, "asg-dummy-cli"));
    await assert.rejects(
      () => acceptAssignment({
        taskDir,
        commit: baseCommit,
        recordDir: writerDir,
        critics: [join(taskDir, "asg-dummy-arch"), join(taskDir, "asg-dummy-cli")],
      }),
      rejectCode("witness_missing"),
    );
    const failed = await runWitness(writerDir, () => ({ status: 1, stdout: "nope\n" }));
    assert.equal(failed.receipt.result, "failed");
    const { commit, tree } = commitIndex(root);
    const archDir = await runReview(root, commit, taskDir, "review-arch", "asg-arch-1");
    const cliDir = await runReview(root, commit, taskDir, "review-cli", "asg-cli-1");
    await assert.rejects(
      () => acceptAssignment({
        taskDir,
        commit,
        recordDir: writerDir,
        critics: [archDir, cliDir],
      }),
      rejectCode("witness_failed"),
    );
    const passed = await runWitness(writerDir);
    assert.equal(passed.receipt.result, "passed");
    assert.equal(
      passed.receipt.candidate.after && "index_tree" in passed.receipt.candidate.after
        ? passed.receipt.candidate.after.index_tree
        : "",
      tree,
    );
    const first = latestPointer(writerDir);
    const second = await runWitness(writerDir);
    assert.notEqual(second.receipt.receipt_id, first.receipt_id);
    writeFileSync(join(writerDir, "witness", "latest.json"), `${JSON.stringify({
      schema: "kxm.assignment-witness-latest.v1",
      task_id: "task-a",
      assignment_id: "asg-writer-1",
      receipt_id: first.receipt_id,
      path: first.path,
      sha256: first.sha256,
      recordedAt: "2026-09-06T00:00:00.000Z",
      result: "passed",
    }, null, 2)}\n`);
    await assert.rejects(
      () => acceptAssignment({
        taskDir,
        commit,
        recordDir: writerDir,
        critics: [archDir, cliDir],
      }),
      rejectCode("witness_stale"),
    );
    writeFileSync(join(writerDir, "witness", "latest.json"), `${JSON.stringify({
      schema: "kxm.assignment-witness-latest.v1",
      task_id: "task-a",
      assignment_id: "asg-writer-1",
      receipt_id: second.receipt.receipt_id,
      path: second.receipt.path,
      sha256: "0".repeat(64),
      recordedAt: second.receipt.recordedAt,
      result: "passed",
    }, null, 2)}\n`);
    await assert.rejects(
      () => acceptAssignment({
        taskDir,
        commit,
        recordDir: writerDir,
        critics: [archDir, cliDir],
      }),
      rejectCode("witness_stale"),
    );
  } finally {
    cleanup(root, taskDir);
  }
});

test("mismatched current plan refuses", async () => {
  const world = await prepareAcceptedWorld();
  try {
    writeFileSync(join(world.taskDir, "plan-current.md"), "# plan\nchanged\n");
    await assert.rejects(
      () => acceptAssignment({
        taskDir: world.taskDir,
        commit: world.commit,
        recordDir: world.writerDir,
        critics: [world.archDir, world.cliDir],
      }),
      rejectCode("plan_mismatch"),
    );
  } finally {
    cleanup(world.root, world.taskDir);
  }
});

test("wrong critic route duplicate role and writer critic refuse", async () => {
  const world = await prepareAcceptedWorld();
  try {
    mutateCompletion(world.archDir, (value) => {
      const route = value.route as Record<string, unknown>;
      route.harness = "codex";
      route.model = "gpt-5.6-sol";
      route.role = "reviewer-cli";
    });
    await assert.rejects(
      () => acceptAssignment({
        taskDir: world.taskDir,
        commit: world.commit,
        recordDir: world.writerDir,
        critics: [world.archDir, world.cliDir],
      }),
      rejectCode("witness_binding_invalid"),
    );
    await assert.rejects(
      () => acceptAssignment({
        taskDir: world.taskDir,
        commit: world.commit,
        recordDir: world.writerDir,
        critics: [world.archDir, world.archDir],
      }),
      rejectCode("critic_invalid"),
    );
    await assert.rejects(
      () => acceptAssignment({
        taskDir: world.taskDir,
        commit: world.commit,
        recordDir: world.writerDir,
        critics: [world.writerDir, world.cliDir],
      }),
      rejectCode("critic_invalid"),
    );
  } finally {
    cleanup(world.root, world.taskDir);
  }
});

test("forged model_claim PASS is not a critic", async () => {
  const world = await prepareAcceptedWorld();
  try {
    mutateCompletion(world.archDir, (value) => {
      value.critic = { kind: "none", reason: "no-verdict" };
      value.model_claim = { verdict: "PASS", unrecognizedCount: 0 };
    });
    await assert.rejects(
      () => acceptAssignment({
        taskDir: world.taskDir,
        commit: world.commit,
        recordDir: world.writerDir,
        critics: [world.archDir, world.cliDir],
      }),
      rejectCode("critic_invalid"),
    );
  } finally {
    cleanup(world.root, world.taskDir);
  }
});

test("failed transport no verdict BLOCK unknown candidate and other judged_tree refuse", async () => {
  const world = await prepareAcceptedWorld();
  try {
    mutateCompletion(world.cliDir, (value) => {
      value.transport = { ...(value.transport as object), status: "failed", ok: false };
    });
    await assert.rejects(
      () => acceptAssignment({
        taskDir: world.taskDir,
        commit: world.commit,
        recordDir: world.writerDir,
        critics: [world.archDir, world.cliDir],
      }),
      rejectCode("critic_invalid"),
    );
  } finally {
    cleanup(world.root, world.taskDir);
  }
});

test("no-verdict unknown candidate other tree and BLOCK refuse", async () => {
  async function withMutatedCli(
    mutate: (value: Record<string, unknown>) => void,
    code: string,
  ) {
    const world = await prepareAcceptedWorld();
    try {
      mutateCompletion(world.cliDir, mutate);
      await assert.rejects(
        () => acceptAssignment({
          taskDir: world.taskDir,
          commit: world.commit,
          recordDir: world.writerDir,
          critics: [world.archDir, world.cliDir],
        }),
        rejectCode(code),
      );
    } finally {
      cleanup(world.root, world.taskDir);
    }
  }
  await withMutatedCli((value) => {
    value.critic = { kind: "none", reason: "no-verdict" };
  }, "critic_invalid");
  await withMutatedCli((value) => {
    value.candidate = { status: "unknown", code: "snapshot_failed" };
    value.critic = { kind: "none", reason: "candidate-unknown" };
  }, "critic_invalid");
  await withMutatedCli((value) => {
    const critic = value.critic as Record<string, unknown>;
    critic.judged_tree = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  }, "critic_tree_mismatch");
  await withMutatedCli((value) => {
    const critic = value.critic as Record<string, unknown>;
    critic.verdict = "BLOCK";
  }, "critic_block");
});

test("unresolved BLOCK is not bypassed by a cherry-picked PASS; rework supersedes", async () => {
  const { root, commit: baseCommit } = initRepo();
  const taskDir = initTask();
  try {
    const writerDir = await runWriter(root, baseCommit, taskDir);
    const { receipt } = await runWitness(writerDir);
    assert.equal(receipt.result, "passed");
    const { commit, tree } = commitIndex(root);
    const blockDir = await runReview(root, commit, taskDir, "review-arch", "asg-arch-block", {}, {
      verdict: "BLOCK",
      summary: "PRIVATE_BLOCK_PROSE",
      findings: ["no"],
    });
    const archDir = await runReview(root, commit, taskDir, "review-arch", "asg-arch-1");
    const cliDir = await runReview(root, commit, taskDir, "review-cli", "asg-cli-1");
    await assert.rejects(
      () => acceptAssignment({
        taskDir,
        commit,
        recordDir: writerDir,
        critics: [archDir, cliDir],
      }),
      rejectCode("critic_block"),
    );
    const errors = readFileSync(join(taskDir, "runner-errors.jsonl"), "utf8");
    assert.match(errors, /critic_block/);
    assert.equal(errors.includes("PRIVATE_BLOCK_PROSE"), false);
    const reworkDir = await runReview(root, commit, taskDir, "review-arch", "asg-arch-rework", {
      rework_of: "asg-arch-block",
    });
    const accepted = await acceptAssignment({
      taskDir,
      commit,
      recordDir: writerDir,
      critics: [reworkDir, cliDir],
    });
    assert.equal(accepted.tree, tree);
    assert.equal(accepted.critics.find((item) => item.kind === "review-arch")?.assignment_id, "asg-arch-rework");
  } finally {
    cleanup(root, taskDir);
  }
});

test("invalid invocation advertises every implemented command and flag", async () => {
  await assert.rejects(
    () => assignmentMain(["node", "assignment-run.mjs", "not-a-command"]),
    (error: unknown) => {
      const message = String((error as Error).message);
      assert.match(message, /^usage: assignment-run\.mjs /);
      for (const token of [
        "run --manifest <absolute-path>",
        "observe --record-dir <absolute-path>",
        "witness --record-dir <absolute-path>",
        "accept --task-dir <absolute-path> --commit <commit> --record-dir <absolute-path> --critic <absolute-path> --critic <absolute-path> [--observed-pr <id>] [--observed-ci <id>]",
        "attribute --task-dir <absolute-path> --record-dir <absolute-path> --class <orchestration|model|environment|unclassified> --explanation-file <absolute-path>",
        "observe-cost --task-dir <absolute-path> --input <absolute-path>",
        "plan-current --task-dir <absolute-path> --plan <absolute-path> --sha256 <hex64> --base-commit <commit> --expected-generation <n>",
        "change-report --task-dir <absolute-path>",
      ]) {
        assert.equal(message.includes(token), true, token);
      }
      return true;
    },
  );
});

test("same-tree BLOCK survives plan-current advance and same-role rework can clear it", async () => {
  const { root, commit: baseCommit } = initRepo();
  const taskDir = initTask();
  try {
    const writerDir = await runWriter(root, baseCommit, taskDir);
    const { receipt } = await runWitness(writerDir);
    assert.equal(receipt.result, "passed");
    const { commit, tree } = commitIndex(root);
    await runReview(root, commit, taskDir, "review-arch", "asg-arch-block", {}, {
      verdict: "BLOCK",
      summary: "stale-plan-block",
      findings: ["no"],
    });
    const nextBody = "# plan generation 2\n";
    const nextPath = join(taskDir, "plan-gen-2.md");
    writeFileSync(nextPath, nextBody);
    const nextSha = sha256(nextBody);
    writeCurrentPlan({
      taskDir,
      plan: nextPath,
      sha256: nextSha,
      baseCommit: commit,
      expectedGeneration: 1,
    });
    const planRef = { kind: "current" as const, path: nextPath, sha256: nextSha };
    const nextWriter = await runWriter(root, commit, taskDir, "asg-writer-2", { plan_ref: planRef });
    const nextWitness = await runWitness(nextWriter);
    assert.equal(nextWitness.receipt.result, "passed");
    const archPass = await runReview(root, commit, taskDir, "review-arch", "asg-arch-pass", { plan_ref: planRef });
    const cliPass = await runReview(root, commit, taskDir, "review-cli", "asg-cli-pass", { plan_ref: planRef });
    await assert.rejects(
      () => acceptAssignment({
        taskDir,
        commit,
        recordDir: nextWriter,
        critics: [archPass, cliPass],
      }),
      rejectCode("critic_block"),
    );
    const reworkDir = await runReview(root, commit, taskDir, "review-arch", "asg-arch-rework", {
      plan_ref: planRef,
      rework_of: "asg-arch-block",
    });
    const accepted = await acceptAssignment({
      taskDir,
      commit,
      recordDir: nextWriter,
      critics: [reworkDir, cliPass],
    });
    assert.equal(accepted.tree, tree);
  } finally {
    cleanup(root, taskDir);
  }
});

test("same-tree BLOCK from a removed review worktree still refuses accept", async () => {
  const { root, commit: baseCommit } = initRepo();
  const taskDir = initTask();
  const reviewWt = join(dirname(root), `kxm-review-${basename(root)}`);
  try {
    const writerDir = await runWriter(root, baseCommit, taskDir);
    const { receipt } = await runWitness(writerDir);
    assert.equal(receipt.result, "passed");
    const { commit, tree } = commitIndex(root);
    git(root, ["worktree", "add", "--detach", reviewWt, commit]);
    await runReview(reviewWt, commit, taskDir, "review-arch", "asg-arch-other-wt", {}, {
      verdict: "BLOCK",
      summary: "other-worktree-block",
      findings: ["no"],
    });
    rmSync(reviewWt, { recursive: true, force: true });
    git(root, ["worktree", "prune"]);
    const archDir = await runReview(root, commit, taskDir, "review-arch", "asg-arch-1");
    const cliDir = await runReview(root, commit, taskDir, "review-cli", "asg-cli-1");
    await assert.rejects(
      () => acceptAssignment({
        taskDir,
        commit,
        recordDir: writerDir,
        critics: [archDir, cliDir],
      }),
      rejectCode("critic_block"),
    );
    assert.equal(tree.length, 40);
  } finally {
    rmSync(reviewWt, { recursive: true, force: true });
    cleanup(root, taskDir);
  }
});

for (const verdict of ["BLOCK", "PASS"] as const) {
  test(`${verdict} review with failed telemetry retains its verdict through recovery`, async () => {
    const world = await prepareAcceptedWorld();
    try {
      const assignmentId = "asg-arch-recording";
      const { deps } = dispatchDeps("claude", {
        stdout: reviewAnswer({ verdict, summary: "review", findings: [] }),
      }, claudeAuth);
      const completion = await runAssignment(reviewerManifest(world.root, world.commit, world.taskDir, {
        assignment_id: assignmentId,
        output_dir: assignmentId,
      }), {
        ...deps,
        writeFileSync: ((path, body, options) => {
          if (basename(String(path)) === "telemetry.jsonl") {
            const error = new Error("injected telemetry failure") as NodeJS.ErrnoException;
            error.code = "EACCES";
            throw error;
          }
          writeFileSync(path, body, options);
        }) as typeof writeFileSync,
      });
      assert.equal(completion.recording.status, "failed");
      assert.deepEqual(completion.critic, { kind: "review", verdict, judged_tree: world.tree, role: "reviewer-arch" });
      const reviewDir = recordDirFor(world.taskDir, assignmentId);
      const completionPath = join(reviewDir, "completion.json");
      const original = readFileSync(completionPath);
      const accept = (archDir: string) => acceptAssignment({
        taskDir: world.taskDir,
        commit: world.commit,
        recordDir: world.writerDir,
        critics: [archDir, world.cliDir],
      });
      await assert.rejects(
        () => accept(verdict === "BLOCK" ? world.archDir : reviewDir),
        rejectCode(verdict === "BLOCK" ? "critic_block" : "recording_unresolved"),
      );
      assert.equal(await observeAssignment(reviewDir), true);
      assert.deepEqual(readFileSync(completionPath), original);
      if (verdict === "BLOCK") {
        await assert.rejects(() => accept(world.archDir), rejectCode("critic_block"));
        const reworkDir = await runReview(world.root, world.commit, world.taskDir,
          "review-arch", "asg-arch-recording-rework", { rework_of: assignmentId });
        assert.equal((await accept(reworkDir)).tree, world.tree);
      } else {
        assert.equal((await accept(reviewDir)).tree, world.tree);
      }
      assert.deepEqual(readFileSync(completionPath), original);
    } finally {
      cleanup(world.root, world.taskDir);
    }
  });
}

test("record dirs outside task_dir or nested fixtures refuse", async () => {
  const world = await prepareAcceptedWorld();
  const other = initTask("other-task");
  try {
    mkdirSync(join(world.taskDir, "nested"));
    const nested = join(world.taskDir, "nested", "asg-nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "completion.json"), "{}\n");
    await assert.rejects(
      () => acceptAssignment({
        taskDir: world.taskDir,
        commit: world.commit,
        recordDir: nested,
        critics: [world.archDir, world.cliDir],
      }),
      rejectCode("record_outside_task"),
    );
    await assert.rejects(
      () => acceptAssignment({
        taskDir: world.taskDir,
        commit: world.commit,
        recordDir: world.writerDir,
        critics: [other, world.cliDir],
      }),
      rejectCode("record_outside_task"),
    );
  } finally {
    cleanup(world.root, world.taskDir);
    rmSync(dirname(other), { recursive: true, force: true });
  }
});

test("existing accepted.json refuses overwrite", async () => {
  const world = await prepareAcceptedWorld();
  try {
    await acceptAssignment({
      taskDir: world.taskDir,
      commit: world.commit,
      recordDir: world.writerDir,
      critics: [world.archDir, world.cliDir],
    });
    await assert.rejects(
      () => acceptAssignment({
        taskDir: world.taskDir,
        commit: world.commit,
        recordDir: world.writerDir,
        critics: [world.archDir, world.cliDir],
      }),
      rejectCode("accepted_exists"),
    );
  } finally {
    cleanup(world.root, world.taskDir);
  }
});

test("unresolved writer bookkeeping refuses before commit proof", async () => {
  const { root, commit: baseCommit } = initRepo();
  const taskDir = initTask();
  try {
    const { deps } = dispatchDeps("grok", { stdout: grokAnswer({ status: "done" }) }, grokAuth, {
      onSpawn: (cwd) => {
        stageDist(cwd);
      },
    });
    const realWrite = writeFileSync;
    (deps as Record<string, unknown>).writeFileSync = ((
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
    await runAssignment(writerManifest(root, baseCommit, taskDir), deps);
    const writerDir = recordDirFor(taskDir, "asg-writer-1");
    mkdirSync(join(taskDir, "asg-arch-1"));
    mkdirSync(join(taskDir, "asg-cli-1"));
    await assert.rejects(
      () => acceptAssignment({
        taskDir,
        commit: baseCommit,
        recordDir: writerDir,
        critics: [join(taskDir, "asg-arch-1"), join(taskDir, "asg-cli-1")],
      }),
      rejectCode("recording_unresolved"),
    );
  } finally {
    cleanup(root, taskDir);
  }
});

test("recorded but unclean critic candidate cannot authorize acceptance", async () => {
  const world = await prepareAcceptedWorld();
  try {
    mutateCompletion(world.archDir, (value) => {
      const candidate = value.candidate as Record<string, unknown>;
      candidate.clean = false;
    });
    await assert.rejects(
      () => acceptAssignment({
        taskDir: world.taskDir,
        commit: world.commit,
        recordDir: world.writerDir,
        critics: [world.archDir, world.cliDir],
      }),
      rejectCode("critic_invalid"),
    );
  } finally {
    cleanup(world.root, world.taskDir);
  }
});

test("critic snapshot head must match stored manifest base.commit", async () => {
  const world = await prepareAcceptedWorld();
  try {
    mutateCompletion(world.archDir, (value) => {
      const candidate = value.candidate as Record<string, unknown>;
      candidate.head = "0".repeat(40);
    });
    await assert.rejects(
      () => acceptAssignment({
        taskDir: world.taskDir,
        commit: world.commit,
        recordDir: world.writerDir,
        critics: [world.archDir, world.cliDir],
      }),
      rejectCode("critic_tree_mismatch"),
    );
  } finally {
    cleanup(world.root, world.taskDir);
  }
});

test("gate executed in another cwd cannot borrow writer binding", async () => {
  const world = await prepareAcceptedWorld();
  try {
    const latest = latestPointer(world.writerDir);
    mutateJson(latest.path, (value) => {
      const gates = value.gates as Array<Record<string, unknown>>;
      const gate = gates[0];
      assert.ok(gate);
      gate.cwd = dirname(world.taskDir);
    });
    const bytes = readFileSync(latest.path);
    mutateJson(join(world.writerDir, "witness", "latest.json"), (value) => {
      value.sha256 = sha256(bytes);
    });
    await assert.rejects(
      () => acceptAssignment({
        taskDir: world.taskDir,
        commit: world.commit,
        recordDir: world.writerDir,
        critics: [world.archDir, world.cliDir],
      }),
      rejectCode("witness_binding_invalid"),
    );
  } finally {
    cleanup(world.root, world.taskDir);
  }
});

test("forged completion-only rework_of cannot resolve a BLOCK", async () => {
  const { root, commit: baseCommit } = initRepo();
  const taskDir = initTask();
  try {
    const writerDir = await runWriter(root, baseCommit, taskDir);
    const { receipt } = await runWitness(writerDir);
    assert.equal(receipt.result, "passed");
    const { commit } = commitIndex(root);
    await runReview(root, commit, taskDir, "review-arch", "asg-arch-block", {}, {
      verdict: "BLOCK",
      summary: "no",
      findings: ["no"],
    });
    const archDir = await runReview(root, commit, taskDir, "review-arch", "asg-arch-unlinked");
    const cliDir = await runReview(root, commit, taskDir, "review-cli", "asg-cli-1");
    mutateCompletion(archDir, (value) => {
      value.rework_of = "asg-arch-block";
    });
    await assert.rejects(
      () => acceptAssignment({
        taskDir,
        commit,
        recordDir: writerDir,
        critics: [archDir, cliDir],
      }),
      rejectCode("witness_binding_invalid"),
    );
  } finally {
    cleanup(root, taskDir);
  }
});

test("same task and tree reviewed in a separate worktree remains eligible", async () => {
  const world = await prepareAcceptedWorld();
  const other = join(world.root, "..", "review-wt");
  try {
    git(world.root, ["worktree", "add", "--detach", other, world.commit]);
    const archDir = await runReview(other, world.commit, world.taskDir, "review-arch", "asg-arch-wt");
    const accepted = await acceptAssignment({
      taskDir: world.taskDir,
      commit: world.commit,
      recordDir: world.writerDir,
      critics: [archDir, world.cliDir],
    });
    assert.equal(accepted.schema, ACCEPTED_SCHEMA);
    assert.equal(accepted.tree, world.tree);
  } finally {
    spawnSync("git", ["-C", world.root, "worktree", "remove", "--force", other], { encoding: "utf8" });
    cleanup(world.root, world.taskDir);
  }
});

test("foreign task completion with local record path is excluded from BLOCK resolution", async () => {
  const world = await prepareAcceptedWorld();
  try {
    const foreign = join(world.taskDir, "foreign-copy");
    mkdirSync(foreign);
    const completion = JSON.parse(readFileSync(join(world.archDir, "completion.json"), "utf8")) as Record<string, unknown>;
    completion.task_id = "different-task";
    completion.assignment_id = "foreign-copy";
    const binding = completion.binding as Record<string, unknown>;
    binding.record_dir = foreign;
    const critic = completion.critic as Record<string, unknown>;
    critic.verdict = "BLOCK";
    writeFileSync(join(foreign, "completion.json"), `${JSON.stringify(completion, null, 2)}\n`);
    const accepted = await acceptAssignment({
      taskDir: world.taskDir,
      commit: world.commit,
      recordDir: world.writerDir,
      critics: [world.archDir, world.cliDir],
    });
    assert.equal(accepted.schema, ACCEPTED_SCHEMA);
  } finally {
    cleanup(world.root, world.taskDir);
  }
});

test("resolveRequiredCritics resolves policy required_critics or falls back to defaults", () => {
  const fallback = resolveRequiredCritics(null);
  assert.equal(fallback["review-arch"]?.harness, "claude");
  assert.equal(fallback["review-cli"]?.harness, "codex");

  const policy = {
    schema: "kxm.roster-policy.v1",
    routes: {
      "arch-route": {
        harness: "claude",
        model: "fable",
        vendor: "anthropic",
        roles: ["reviewer-arch"],
        status: "admitted",
      },
      "cli-route": {
        harness: "codex",
        model: "gpt-5.6-sol",
        vendor: "openai",
        roles: ["reviewer-cli"],
        status: "admitted",
      },
    },
    required_critics: {
      "review-arch": "arch-route",
      "review-cli": "cli-route",
    },
  };
  const resolved = resolveRequiredCritics(policy);
  assert.equal(resolved["review-arch"]?.route_id, "arch-route");
  assert.equal(resolved["review-arch"]?.vendor, "anthropic");
  assert.equal(resolved["review-cli"]?.route_id, "cli-route");
  assert.equal(resolved["review-cli"]?.vendor, "openai");
});

test("writer unadmitted in roster policy lineup refuses acceptance", async () => {
  const world = await prepareAcceptedWorld();
  try {
    const customPolicy = {
      schema: "kxm.roster-policy.v1",
      routes: {
        "qwen-writer": {
          harness: "pi",
          model: "openrouter/qwen/qwen3-coder-plus",
          vendor: "alibaba",
          roles: ["writer"],
          permissions: ["edit"],
          status: "admitted",
        },
        "arch-route": {
          harness: "claude",
          model: "fable",
          vendor: "anthropic",
          roles: ["reviewer-arch"],
          permissions: ["read-only"],
          status: "admitted",
        },
        "cli-route": {
          harness: "codex",
          model: "gpt-5.6-sol",
          vendor: "openai",
          roles: ["reviewer-cli"],
          permissions: ["read-only"],
          status: "admitted",
        },
      },
      lineup: {
        writer: ["qwen-writer"],
        planner: [],
        "reviewer-arch": ["arch-route"],
        "reviewer-cli": ["cli-route"],
      },
      required_critics: {
        "review-arch": "arch-route",
        "review-cli": "cli-route",
      },
    };
    await assert.rejects(
      () => acceptAssignment({
        taskDir: world.taskDir,
        commit: world.commit,
        recordDir: world.writerDir,
        critics: [world.archDir, world.cliDir],
      }, { rosterPolicy: customPolicy }),
      rejectCode("route_invalid"),
    );
  } finally {
    cleanup(world.root, world.taskDir);
  }
});

test("vendor collision between writer and critics refuses acceptance", async () => {
  const world = await prepareAcceptedWorld();
  try {
    const collidingPolicy = {
      schema: "kxm.roster-policy.v1",
      routes: {
        "grok-writer": {
          harness: "grok",
          model: "grok-4.6",
          vendor: "xai",
          roles: ["writer"],
          permissions: ["edit"],
          status: "admitted",
        },
        "colliding-arch": {
          harness: "claude",
          model: "fable",
          vendor: "xai",
          roles: ["reviewer-arch"],
          permissions: ["read-only"],
          status: "admitted",
        },
        "cli-route": {
          harness: "codex",
          model: "gpt-5.6-sol",
          vendor: "openai",
          roles: ["reviewer-cli"],
          permissions: ["read-only"],
          status: "admitted",
        },
      },
      lineup: {
        writer: ["grok-writer"],
        planner: [],
        "reviewer-arch": ["colliding-arch"],
        "reviewer-cli": ["cli-route"],
      },
      required_critics: {
        "review-arch": "colliding-arch",
        "review-cli": "cli-route",
      },
    };
    await assert.rejects(
      () => acceptAssignment({
        taskDir: world.taskDir,
        commit: world.commit,
        recordDir: world.writerDir,
        critics: [world.archDir, world.cliDir],
      }, { rosterPolicy: collidingPolicy }),
      rejectCode("critic_invalid"),
    );
  } finally {
    cleanup(world.root, world.taskDir);
  }
});

test("vendor collision between critics refuses acceptance", async () => {
  const world = await prepareAcceptedWorld();
  try {
    const collidingCriticsPolicy = {
      schema: "kxm.roster-policy.v1",
      routes: {
        "grok-writer": {
          harness: "grok",
          model: "grok-4.6",
          vendor: "xai",
          roles: ["writer"],
          permissions: ["edit"],
          status: "admitted",
        },
        "arch-route": {
          harness: "claude",
          model: "fable",
          vendor: "anthropic",
          roles: ["reviewer-arch"],
          permissions: ["read-only"],
          status: "admitted",
        },
        "cli-route": {
          harness: "codex",
          model: "gpt-5.6-sol",
          vendor: "anthropic",
          roles: ["reviewer-cli"],
          permissions: ["read-only"],
          status: "admitted",
        },
      },
      lineup: {
        writer: ["grok-writer"],
        planner: [],
        "reviewer-arch": ["arch-route"],
        "reviewer-cli": ["cli-route"],
      },
      required_critics: {
        "review-arch": "arch-route",
        "review-cli": "cli-route",
      },
    };
    await assert.rejects(
      () => acceptAssignment({
        taskDir: world.taskDir,
        commit: world.commit,
        recordDir: world.writerDir,
        critics: [world.archDir, world.cliDir],
      }, { rosterPolicy: collidingCriticsPolicy }),
      rejectCode("critic_invalid"),
    );
  } finally {
    cleanup(world.root, world.taskDir);
  }
});


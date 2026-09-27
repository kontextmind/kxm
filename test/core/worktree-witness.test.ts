import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KxmProducerResult } from "../../plugins/kxm/src/engine.ts";
import { applyAuthoringWitness, captureWorktreeWitness } from "../../plugins/kxm/src/worktree-witness.ts";
import { makeGitRoot } from "../helpers/git-root.ts";

const passed: KxmProducerResult = {
  outcome: "passed",
  costBasis: "unmetered",
  providerMetadata: { authored: true },
};

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

function commitFile(cwd: string, name: string, contents: string, message: string): void {
  writeFileSync(join(cwd, name), contents);
  git(cwd, ["add", "--", name]);
  git(cwd, [
    "-c", "user.name=Test",
    "-c", "user.email=test@example.test",
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null",
    "commit", "--quiet", "-m", message,
  ]);
}

function withRepo(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "kxm-witness-"));
  try {
    makeGitRoot(root);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a commit between snapshots counts as authored and a passed write stays passed", () => {
  withRepo((root) => {
    commitFile(root, "base.txt", "base\n", "base");
    const before = captureWorktreeWitness(root);
    commitFile(root, "work.txt", "done\n", "work");
    const after = captureWorktreeWitness(root);
    assert.equal(git(root, ["status", "--porcelain=v1", "-uall"]), "");
    assert.equal(git(root, ["diff", "--no-ext-diff"]), "");
    assert.equal(git(root, ["diff", "--cached", "--no-ext-diff"]), "");
    assert.notEqual(before.fingerprint, after.fingerprint);
    const result = applyAuthoringWitness(passed, { writes: true, before, after });
    assert.equal(result.outcome, "passed");
    assert.equal(result.providerMetadata?.authored, true);
    assert.equal(result.providerMetadata?.authoringWitness, "changed");
  });
});

test("an identical HEAD and a clean tree stays unchanged and fails a passed write", () => {
  withRepo((root) => {
    commitFile(root, "base.txt", "base\n", "base");
    const before = captureWorktreeWitness(root);
    const after = captureWorktreeWitness(root);
    assert.equal(before.unwitnessed, false);
    assert.equal(before.fingerprint, after.fingerprint);
    const result = applyAuthoringWitness(passed, { writes: true, before, after });
    assert.equal(result.outcome, "failed");
    assert.equal(result.providerMetadata?.authored, false);
    assert.equal(result.providerMetadata?.authoringWitness, "unchanged");
  });
});

test("a read-only step over a committed change reports readonly_mutated and fails", () => {
  withRepo((root) => {
    commitFile(root, "base.txt", "base\n", "base");
    const before = captureWorktreeWitness(root);
    commitFile(root, "work.txt", "done\n", "work");
    const after = captureWorktreeWitness(root);
    const result = applyAuthoringWitness(passed, { writes: false, before, after });
    assert.equal(result.outcome, "failed");
    assert.equal(result.providerMetadata?.authored, false);
    assert.equal(result.providerMetadata?.authoringWitness, "readonly_mutated");
  });
});

test("a git failure stays unwitnessed and keeps the current authoring outcomes", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-witness-nogit-"));
  try {
    const before = captureWorktreeWitness(root);
    const after = captureWorktreeWitness(root);
    assert.equal(before.unwitnessed, true);
    assert.equal(before.fingerprint, "");
    assert.equal(after.unwitnessed, true);
    const write = applyAuthoringWitness(passed, { writes: true, before, after });
    assert.equal(write.outcome, "failed");
    assert.equal(write.providerMetadata?.authored, false);
    assert.equal(write.providerMetadata?.authoringWitness, "unwitnessed");
    const read = applyAuthoringWitness(passed, { writes: false, before, after });
    assert.equal(read.outcome, "passed");
    assert.equal(read.providerMetadata?.authored, false);
    assert.equal(read.providerMetadata?.authoringWitness, "unwitnessed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rev-parse failure in a repository that has commits is unwitnessed", () => {
  withRepo((root) => {
    commitFile(root, "base.txt", "base\n", "base");
    git(root, ["symbolic-ref", "HEAD", "refs/heads/missing"]);
    const witness = captureWorktreeWitness(root);
    assert.equal(witness.unwitnessed, true);
    assert.equal(witness.fingerprint, "");
  });
});

test("a repository with no commits still witnesses a working tree edit", () => {
  withRepo((root) => {
    const before = captureWorktreeWitness(root);
    assert.equal(before.unwitnessed, false);
    assert.equal(before.fingerprint, "\0\0\0");
    writeFileSync(join(root, "work.txt"), "done\n");
    const after = captureWorktreeWitness(root);
    assert.equal(after.unwitnessed, false);
    assert.notEqual(before.fingerprint, after.fingerprint);
    const result = applyAuthoringWitness(passed, { writes: true, before, after });
    assert.equal(result.outcome, "passed");
    assert.equal(result.providerMetadata?.authored, true);
    assert.equal(result.providerMetadata?.authoringWitness, "changed");
  });
});

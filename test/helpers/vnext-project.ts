import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeVnextProject } from "../../plugins/kxm/src/vnext-init.ts";
import { makeGitRoot } from "./git-root.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const engineFixtureDir = resolve(repoRoot, "test/fixtures/vnext-engine");

export function committedVnextProject(
  prefix: string,
  options: {
    projectId: string;
    projectName: string;
    workflows?: string[];
  },
): { root: string; stateRoot: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const stateRoot = mkdtempSync(join(tmpdir(), `${prefix}state-`));
  makeGitRoot(root);
  initializeVnextProject(root, { projectId: options.projectId, projectName: options.projectName });
  for (const file of options.workflows ?? []) {
    cpSync(join(engineFixtureDir, file), join(root, ".kxm", "workflows", file));
  }
  spawnSync("git", ["-C", root, "add", "-A"], { windowsHide: true });
  const commit = spawnSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"], { windowsHide: true });
  assert.equal(commit.status, 0, commit.stderr as unknown as string);
  return { root, stateRoot };
}

export function engineProject(
  prefix: string,
  workflows: string[] = ["agent-only.yaml", "unsupported-gate.yaml", "one-step.yaml"],
  projectId = "prj_01JENGINE00000000000000000",
): { root: string; stateRoot: string } {
  return committedVnextProject(prefix, {
    projectId,
    projectName: "Engine Test",
    workflows,
  });
}

export function committedProject(prefix: string): { root: string; stateRoot: string } {
  return committedVnextProject(prefix, {
    projectId: "prj_01JRUNTIMETEST0000000000",
    projectName: "Runtime Test",
  });
}

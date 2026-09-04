import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const checker = resolve("scripts/check-generated.mjs");
const artifacts = [
  "plugins/kxm/dist/cli.js",
  "plugins/kxm/dist/server.js",
  "plugins/kxm/dist/mcp-server.js",
  "plugins/kxm/dist/vnext-runtime-supervisor.js",
];

function run(cwd: string, command: string, args: string[]) {
  return spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
}

function git(cwd: string, args: string[]): void {
  const result = run(cwd, "git", args);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-mesh-generated-check-"));
  git(root, ["init", "--quiet"]);
  for (const [index, path] of artifacts.entries()) {
    const fullPath = join(root, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, `artifact-${index}\n`, "utf8");
  }
  git(root, ["add", "--", ...artifacts]);
  git(root, [
    "-c",
    "user.name=Generated Artifact Test",
    "-c",
    "user.email=generated-artifact-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "baseline",
  ]);
  return root;
}

test("generated artifact check requires every bundle to exist and be tracked and unchanged", () => {
  const roots: string[] = [];
  try {
    const clean = repository();
    roots.push(clean);
    const accepted = run(clean, process.execPath, [checker]);
    assert.equal(accepted.status, 0, `${accepted.stderr}\n${accepted.stdout}`);
    assert.match(accepted.stdout, /tracked and current \(4\)/);

    const missing = repository();
    roots.push(missing);
    unlinkSync(join(missing, artifacts[1]!));
    const missingResult = run(missing, process.execPath, [checker]);
    assert.equal(missingResult.status, 1);
    assert.match(missingResult.stderr, /generated artifacts are missing: .*dist\/server\.js/);

    const untracked = repository();
    roots.push(untracked);
    git(untracked, ["rm", "--quiet", "--cached", "--", artifacts[0]!]);
    const untrackedResult = run(untracked, process.execPath, [checker]);
    assert.equal(untrackedResult.status, 1);
    assert.match(untrackedResult.stderr, /generated artifacts are not tracked by git: .*dist\/cli\.js/);

    const changed = repository();
    roots.push(changed);
    writeFileSync(join(changed, artifacts[2]!), "changed-after-build\n", "utf8");
    const changedResult = run(changed, process.execPath, [checker]);
    assert.equal(changedResult.status, 1);
    assert.match(changedResult.stderr, /generated artifacts changed after build:[\s\S]*dist\/mcp-server\.js/);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

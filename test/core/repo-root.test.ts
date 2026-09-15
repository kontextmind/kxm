import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { findKxmRepoRoot } from "../../plugins/kxm/src/repo-root.ts";

function fixtureWithMarker(depthFromRoot: number): { root: string; moduleUrl: string } {
  const root = mkdtempSync(join(tmpdir(), "kxm-repo-root-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "kxm-hub.mjs"), "#!/usr/bin/env node\n", "utf8");
  let dir = root;
  for (let i = 0; i < depthFromRoot; i += 1) dir = join(dir, `nested${i}`);
  mkdirSync(dir, { recursive: true });
  return { root, moduleUrl: pathToFileURL(join(dir, "module.js")).href };
}

test("findKxmRepoRoot locates the root from a source-tree nesting (deep)", () => {
  const { root, moduleUrl } = fixtureWithMarker(4);
  try {
    assert.equal(findKxmRepoRoot(moduleUrl), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findKxmRepoRoot locates the root from the flat dist bundle layout (shallow)", () => {
  const { root, moduleUrl } = fixtureWithMarker(1);
  try {
    assert.equal(findKxmRepoRoot(moduleUrl), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findKxmRepoRoot resolves the real checkout from src and dist", () => {
  const checkoutRoot = join(process.cwd());
  const fromSrc = pathToFileURL(join(checkoutRoot, "plugins", "kxm", "src", "cli", "types.ts")).href;
  const fromDist = pathToFileURL(join(checkoutRoot, "plugins", "kxm", "dist", "cli.js")).href;
  assert.equal(findKxmRepoRoot(fromSrc), checkoutRoot);
  assert.equal(findKxmRepoRoot(fromDist), checkoutRoot);
});

test("findKxmRepoRoot throws a clear error when no root marker exists", () => {
  const orphan = mkdtempSync(join(tmpdir(), "kxm-repo-root-none-"));
  try {
    const moduleUrl = pathToFileURL(join(orphan, "module.js")).href;
    assert.throws(() => findKxmRepoRoot(moduleUrl), /cannot locate the KXM repo root/);
  } finally {
    rmSync(orphan, { recursive: true, force: true });
  }
});

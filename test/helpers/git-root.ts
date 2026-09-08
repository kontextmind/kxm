import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

export function makeGitRoot(root: string): void {
  const initialized = spawnSync(
    "git",
    ["-c", "init.defaultBranch=main", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "init", "--quiet", root],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(initialized.status, 0, initialized.stderr);
}

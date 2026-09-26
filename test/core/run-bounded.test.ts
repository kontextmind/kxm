import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/run-bounded.mjs", import.meta.url));

test("a timeout kills the grandchild sleeping in the child process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kxm-run-bounded-"));
  const pidFile = join(dir, "grandchild.pid");
  const childSource = `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const grandchild = spawn("sleep", ["60"], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
    setInterval(() => {}, 1000);
  `;
  try {
    const child = spawn(process.execPath, [
      script,
      "1000",
      process.execPath,
      "--input-type=module",
      "-e",
      childSource,
    ], { stdio: ["ignore", "inherit", "inherit"] });
    const code = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", resolveExit);
    });
    assert.equal(code, 124);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 0);
    const started = Date.now();
    let gone = false;
    while (Date.now() - started < 5_000) {
      try {
        process.kill(pid, 0);
      } catch {
        gone = true;
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    assert.equal(gone, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

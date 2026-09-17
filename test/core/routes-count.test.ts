import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli as runCliImplementation, type CliIo } from "../../plugins/kxm/src/cli.ts";

async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo, cwd: string): Promise<number> {
  return await runCliImplementation(argv, env, io, cwd);
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (line: string) => { stdout += `${line}\n`; },
      stderr: (line: string) => { stderr += `${line}\n`; },
    } as CliIo,
    read: () => ({ stdout, stderr }),
  };
}

test("routes count reports admitted and disabled totals", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-routes-count-"));
  try {
    mkdirSync(join(root, ".kxm"), { recursive: true });
    writeFileSync(
      join(root, ".kxm", "routes.yaml"),
      "schema: kxm.routes.v2\nupdatedAt: '2026-09-16T00:00:00.000Z'\nadmitted:\n  - anthropic/fable\n  - xai/grok-4.6\n  - openai/gpt-5.6-sol\ndisabled:\n  - openrouter/test-disabled\n",
      "utf8",
    );
    const io = capture();
    const code = await runCli(["routes", "count", "--json"], { KXM_STATE_HOME: join(root, ".kxm", "state") }, io, root);
    assert.equal(code, 0, io.read().stderr);
    const payload = JSON.parse(io.read().stdout.trim().split("\n").filter((l) => l.startsWith("{"))[0]!) as {
      ok: boolean; command: string; admitted: number; disabled: number;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.command, "routes count");
    assert.equal(payload.admitted, 3);
    assert.equal(payload.disabled, 1);
    assert.match(io.read().stdout, /3 admitted \/ 1 disabled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

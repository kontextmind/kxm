import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArgs, runCli } from "../plugins/pi-mesh-comms/src/cli.ts";

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
    read: () => ({ stdout, stderr }),
  };
}

test("parseArgs captures global flags", () => {
  const parsed = parseArgs(["--json", "--dry-run", "--workspace", ".kxm", "init"]);
  assert.equal(parsed.json, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.workspace, ".kxm");
  assert.equal(parsed.rest[0], "init");
});

test("init and validate work in an isolated workspace", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-mesh-cli-"));
  try {
    const io = capture();
    const isolated = join(cwd, "ws");
    const initCode = await runCli(["--json", "--workspace", isolated, "init"], {
      PI_MESH_CONFIG_DIR: join(cwd, "should-not-use"),
    }, io, cwd);
    assert.equal(initCode, 0);
    assert.match(io.read().stdout, /"command":"init"/);
    assert.equal(existsSync(join(isolated, "config")), true);
    assert.equal(existsSync(join(cwd, "should-not-use")), false);
    const env = {
      PI_MESH_V04_WORKFLOW_SECRET: "0123456789abcdef",
      PI_MESH_V04_SIGNAL_SECRET: "0123456789abcdef",
    };
    const file = join(process.cwd(), ".kxm/config/workflows/v04-dogfood.json");
    const validate = capture();
    const code = await runCli(["--json", "validate", "--file", file], env, validate, cwd);
    assert.equal(code, 0, validate.read().stdout);
    assert.match(validate.read().stdout, /"ok":true/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("hub and worker dry-run do not spawn, and live hub uses the injected spawner", async () => {
  const dry = capture();
  assert.equal(await runCli(["--json", "--dry-run", "hub"], {}, dry), 0);
  assert.match(dry.read().stdout, /"dryRun":true/);
  const live = capture();
  let spawned = false;
  const code = await runCli(["--json", "hub"], {}, {
    ...live,
    spawnHub: () => {
      spawned = true;
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.equal(spawned, true);
});

test("stop, signal, status, and help cover the remaining command contract", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-mesh-cli-more-"));
  try {
    const help = capture();
    assert.equal(await runCli(["help"], {}, help, cwd), 0);
    const unknown = capture();
    assert.equal(await runCli(["nope"], {}, unknown, cwd), 2);
    const missing = capture();
    assert.equal(await runCli(["--json", "validate", "--file", join(cwd, "missing.json")], {}, missing, cwd), 1);
    const stopDry = capture();
    assert.equal(await runCli(["--json", "--dry-run", "stop"], {}, stopDry, cwd), 0);
    writeFileSync(join(cwd, "hub.pid"), "1\n");
    mkdirSync(join(cwd, "state"), { recursive: true });
    writeFileSync(join(cwd, "state", "hub.pid"), "1\n");
    const stop = capture();
    assert.equal(await runCli(["--json", "--workspace", cwd, "stop"], {}, stop, cwd), 0);
    const status = capture();
    assert.equal(await runCli(["--json", "status"], {}, {
      ...status,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }, cwd), 0);
    const signalDry = capture();
    assert.equal(await runCli(
      ["--json", "--dry-run", "signal", "run_1", "key", "passed", "ok"],
      { PI_MESH_WORKFLOW_ID: "wf", PI_MESH_WORKFLOW_SIGNAL_SECRET: "signal-secret-16chars" },
      signalDry,
      cwd,
    ), 0);
    const signalLive = capture();
    assert.equal(await runCli(
      ["--json", "signal", "run_1", "key", "passed", "ok"],
      { PI_MESH_WORKFLOW_ID: "wf", PI_MESH_WORKFLOW_SIGNAL_SECRET: "signal-secret-16chars" },
      {
        ...signalLive,
        fetchImpl: async () => new Response(JSON.stringify({ duplicate: false }), { status: 202 }),
      },
      cwd,
    ), 0);
    const list = capture();
    assert.equal(await runCli(["--json", "workflow", "list"], {}, list, cwd), 3);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("live workflow start is rejected and smoke skips without opt-in", async () => {
  const start = capture();
  assert.equal(await runCli(["--json", "workflow", "start"], {}, start), 2);
  assert.match(start.read().stdout, /live_start_rejected/);
  const smoke = capture();
  assert.equal(await runCli(["--json", "smoke"], {}, smoke), 0);
  assert.match(smoke.read().stdout, /"skipped":true/);
});

test("github watch dry-run does not leak tokens", async () => {
  const io = capture();
  const code = await runCli(
    ["--json", "--dry-run", "github", "watch", "--run-id", "run_1", "--signal-key", "k", "--repo", "acme/app", "--pr", "1"],
    {
      PI_MESH_WORKFLOW_ID: "wf",
      PI_MESH_WORKFLOW_SIGNAL_SECRET: "signal-secret-16chars",
      GITHUB_TOKEN: "ghs_should_not_appear",
    },
    {
      ...io,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/pulls/1")) return new Response(JSON.stringify({ head: { sha: "abc" } }), { status: 200 });
        return new Response(JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }), { status: 200 });
      },
    },
  );
  assert.equal(code, 0);
  assert.doesNotMatch(io.read().stdout, /ghs_should_not_appear/);
  assert.doesNotMatch(io.read().stdout, /signal-secret-16chars/);
});

test("retrospective export writes proposed artifacts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-mesh-cli-export-"));
  try {
    const snapshot = {
      run: {
        id: "run_cli",
        definitionId: "demo",
        source: "generic",
        deliveryId: "d",
        payloadHash: "h",
        project: "p",
        targetAgentId: "a",
        targetAgentName: "coordinator",
        messageId: "m",
        status: "failed",
        stages: [{
          id: "research",
          label: "Research",
          instructions: "x",
          requiredEvidence: ["a"],
          maxAttempts: 1,
          status: "in_progress",
          attempts: 0,
          evidence: [],
        }],
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
      },
      journal: [],
    };
    const input = join(cwd, "snapshot.json");
    writeFileSync(input, JSON.stringify(snapshot));
    const io = capture();
    const code = await runCli(["--json", "retrospective", "export", "run_cli", "--input", input, "--out-dir", join(cwd, "out")], {}, io, cwd);
    assert.equal(code, 0, io.read().stdout);
    assert.match(io.read().stdout, /"reviewDecision":"proposed"/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

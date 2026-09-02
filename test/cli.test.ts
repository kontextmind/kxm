import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runCli as runCliImplementation, type CliIo } from "../plugins/kxm-mesh/src/cli.ts";

async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo, cwd = process.cwd()): Promise<number> {
  const isolatedLogs = mkdtempSync(join(tmpdir(), "kxm-cli-telemetry-"));
  try {
    return await runCliImplementation(argv, { PI_MESH_LOGS_DIR: isolatedLogs, ...env }, io, cwd);
  } finally {
    rmSync(isolatedLogs, { recursive: true, force: true });
  }
}

function makeGitRoot(root: string): void {
  const initialized = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", root], { encoding: "utf8", windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
}

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

test("kxm routes agent, session, workflow, and gate tooling", async () => {
  const help = capture();
  assert.equal(await runCli(["help"], {}, help), 0);
  assert.match(help.read().stdout, /Usage: kxm/);
  assert.match(help.read().stdout, /\bagent\b/);
  assert.match(help.read().stdout, /\bsession\b/);
  assert.match(help.read().stdout, /\bworkflow\b/);
  assert.match(help.read().stdout, /\bgate\b/);
  const agentHelp = capture();
  assert.equal(await runCli(["agent", "help"], {}, agentHelp), 0);
  assert.match(agentHelp.read().stdout, /Usage: kxm agent/);
  const sessionHelp = capture();
  assert.equal(await runCli(["session", "help"], {}, sessionHelp), 0);
  assert.match(sessionHelp.read().stdout, /Usage: kxm session/);
  const unknownTool = capture();
  assert.equal(await runCli(["nope"], {}, unknownTool), 2);
  const unknownCommand = capture();
  assert.equal(await runCli(["agent", "nope"], {}, unknownCommand), 2);
});

test("agent and gate CLI results share the worker envelope", async () => {
  const agentIo = capture();
  assert.equal(await runCli([
    "agent", "--json", "--dry-run", "worker", "--name", "coordinator", "--project", "demo",
  ], {}, agentIo), 0);
  const agent = JSON.parse(agentIo.read().stdout) as {
    schema: string;
    worker: { schema: string; kind: string; driver: string; name: string };
    command: string;
    outcome: string;
  };
  assert.equal(agent.schema, "kxm.worker-result.v1");
  assert.equal(agent.worker.schema, "kxm.worker.v1");
  assert.equal(agent.worker.kind, "agent");
  assert.equal(agent.worker.driver, "ai");
  assert.equal(agent.command, "worker");
  assert.equal(agent.outcome, "passed");

  const gateIo = capture();
  assert.equal(await runCli([
    "gate", "--json", "validate", "--file", join(tmpdir(), "kxm-missing-workflow.json"),
  ], {}, gateIo), 1);
  const gate = JSON.parse(gateIo.read().stdout) as {
    schema: string;
    worker: { schema: string; kind: string; driver: string; name: string };
    command: string;
    outcome: string;
  };
  assert.equal(gate.schema, "kxm.worker-result.v1");
  assert.equal(gate.worker.schema, "kxm.worker.v1");
  assert.equal(gate.worker.kind, "gate");
  assert.equal(gate.worker.driver, "code");
  assert.equal(gate.command, "validate");
  assert.equal(gate.outcome, "failed");
});

test("vNext init creates and revalidates project configuration without legacy environment overrides", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-vnext-cli-init-"));
  const dryCwd = mkdtempSync(join(tmpdir(), "kxm-vnext-cli-dry-"));
  const legacyCwd = mkdtempSync(join(tmpdir(), "kxm-vnext-cli-legacy-"));
  try {
    makeGitRoot(cwd);
    makeGitRoot(dryCwd);
    const unsupportedWorkspace = capture();
    assert.equal(await runCli(["--workspace", join(cwd, "wrong"), "init", "--json"], {}, unsupportedWorkspace, cwd), 2);
    assert.match(unsupportedWorkspace.read().stdout, /"error":"workspace_option_unsupported"/);
    assert.equal(existsSync(join(cwd, ".kxm")), false);

    const createdIo = capture();
    assert.equal(await runCli([
      "init", "--json", "--name", "CLI Project", "--project-id", "prj_01JCLIPROJECT0000000000000",
    ], {
      PI_MESH_WORKDIR: join(cwd, "must-not-use"),
      PI_MESH_CONFIG_DIR: join(cwd, "also-must-not-use"),
    }, createdIo, cwd), 0);
    const created = JSON.parse(createdIo.read().stdout) as { action: string; mode: string; configRevision: string; files: string[] };
    assert.equal(created.action, "created");
    assert.equal(created.mode, "ready");
    assert.match(created.configRevision, /^sha256:[a-f0-9]{64}$/);
    assert.equal(created.files.length, 5);
    assert.equal(existsSync(join(cwd, ".kxm", "project.yaml")), true);
    assert.equal(existsSync(join(cwd, "must-not-use")), false);

    const repeatedIo = capture();
    assert.equal(await runCli(["init", "--json"], {}, repeatedIo, cwd), 0);
    const repeated = JSON.parse(repeatedIo.read().stdout) as { action: string; configRevision: string };
    assert.equal(repeated.action, "validated");
    assert.equal(repeated.configRevision, created.configRevision);

    const dryIo = capture();
    assert.equal(await runCli(["init", "--json", "--dry-run"], {}, dryIo, dryCwd), 0);
    assert.match(dryIo.read().stdout, /"action":"planned"/);
    assert.equal(existsSync(join(dryCwd, ".kxm")), false);
    const invalidIo = capture();
    assert.equal(await runCli(["init", "--json", "--dry-run", "--project-id", "not-a-project-id"], {}, invalidIo, dryCwd), 1);
    assert.match(invalidIo.read().stdout, /"error":"vnext_initialization_failed"/);
    assert.equal(existsSync(join(dryCwd, ".kxm")), false);

    const noGitIo = capture();
    assert.equal(await runCli(["init", "--json", "--dry-run"], {}, noGitIo, legacyCwd), 1);
    assert.match(noGitIo.read().stdout, /git_root_required/);

    makeGitRoot(legacyCwd);
    mkdirSync(join(legacyCwd, ".kxm", "config"), { recursive: true });
    writeFileSync(join(legacyCwd, ".kxm", "config", "agents.json"), "[]\n");
    const invalidMigrationIo = capture();
    assert.equal(await runCli(["init", "--json", "--dry-run", "--project-id", "invalid"], {}, invalidMigrationIo, legacyCwd), 1);
    assert.match(invalidMigrationIo.read().stdout, /project_id_invalid/);
    const legacyIo = capture();
    assert.equal(await runCli(["init", "--json"], {}, legacyIo, legacyCwd), 1);
    assert.match(legacyIo.read().stdout, /"mode":"migrate"/);
    assert.match(legacyIo.read().stdout, /\.kxm\/config\/agents\.json/);
    assert.match(legacyIo.read().stdout, /"plannedOnly":true/);
  } finally {
    for (const root of [cwd, dryCwd, legacyCwd]) rmSync(root, { recursive: true, force: true });
  }
});

test("init and validate work in an isolated workspace", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-mesh-cli-"));
  try {
    const io = capture();
    const isolated = join(cwd, "ws");
    const initCode = await runCli(["mesh", "--json", "--workspace", isolated, "init"], {
      PI_MESH_CONFIG_DIR: join(cwd, "should-not-use"),
    }, io, cwd);
    assert.equal(initCode, 0);
    assert.match(io.read().stdout, /"command":"init"/);
    assert.equal(existsSync(join(isolated, "config")), true);
    assert.equal(existsSync(join(cwd, "should-not-use")), false);
    assert.equal(existsSync(join(isolated, "config", "agents.json")), false, "consumer init must not copy the package dogfood roster");

    writeFileSync(join(isolated, "config", "agents.json"), JSON.stringify({
      schema: "kxm.agents.v1",
      agents: [{ name: "planner", kind: "agent", driver: "ai", purpose: "plans" }],
    }));
    writeFileSync(join(isolated, "config", "gates.json"), JSON.stringify({
      schema: "kxm.gates.v1",
      gates: [{ name: "validate", kind: "gate", driver: "code", purpose: "validates" }],
    }));
    const sessionIo = capture();
    assert.equal(await runCli([
      "session", "--json", "--workspace", isolated, "start", "--id", "review-1", "--mix", "planner,validate",
    ], {}, sessionIo, cwd), 0);
    assert.match(sessionIo.read().stdout, /"schema":"kxm.session.v1"/);
    assert.equal(existsSync(join(isolated, "assets", "sessions", "review-1", "session.json")), true);

    const env = {
      PI_MESH_V04_WORKFLOW_SECRET: "0123456789abcdef",
      PI_MESH_V04_SIGNAL_SECRET: "0123456789abcdef",
    };
    const file = join(process.cwd(), ".kxm/config/workflows/v04-dogfood.json");
    const validate = capture();
    const code = await runCli(["gate", "--json", "validate", "--file", file], env, validate, cwd);
    assert.equal(code, 0, validate.read().stdout);
    assert.match(validate.read().stdout, /"ok":true/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("gate validate mirrors the hub workflow source XOR", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-validate-source-"));
  try {
    const file = join(process.cwd(), ".kxm/config/workflows/v04-dogfood.json");
    const inline = readFileSync(file, "utf8");
    const secrets = {
      PI_MESH_V04_WORKFLOW_SECRET: "0123456789abcdef",
      PI_MESH_V04_SIGNAL_SECRET: "0123456789abcdef",
    };

    const missing = capture();
    assert.equal(await runCli(["gate", "--json", "validate"], {
      ...secrets,
      PI_MESH_WEBHOOK_WORKFLOWS: "",
      PI_MESH_WEBHOOK_WORKFLOWS_FILE: "",
    }, missing, cwd), 2);
    assert.match(missing.read().stdout, /workflow_source_required/);

    const ambiguous = capture();
    assert.equal(await runCli(["gate", "--json", "validate"], {
      ...secrets,
      PI_MESH_WEBHOOK_WORKFLOWS: inline,
      PI_MESH_WEBHOOK_WORKFLOWS_FILE: file,
    }, ambiguous, cwd), 2);
    assert.match(ambiguous.read().stdout, /ambiguous_workflow_source/);

    const inlineOnly = capture();
    assert.equal(await runCli(["gate", "--json", "validate"], {
      ...secrets,
      PI_MESH_WEBHOOK_WORKFLOWS: inline,
      PI_MESH_WEBHOOK_WORKFLOWS_FILE: "",
    }, inlineOnly, cwd), 0, inlineOnly.read().stdout);
    assert.match(inlineOnly.read().stdout, /"source":"inline"/);
    assert.doesNotMatch(inlineOnly.read().stdout, /0123456789abcdef/);

    const configuredFile = capture();
    assert.equal(await runCli(["gate", "--json", "validate"], {
      ...secrets,
      PI_MESH_WEBHOOK_WORKFLOWS: "",
      PI_MESH_WEBHOOK_WORKFLOWS_FILE: file,
    }, configuredFile, cwd), 0, configuredFile.read().stdout);
    assert.match(configuredFile.read().stdout, /"source":"file"/);

    const explicitWins = capture();
    assert.equal(await runCli(["gate", "--json", "validate", "--file", file], {
      ...secrets,
      PI_MESH_WEBHOOK_WORKFLOWS: "not-json",
      PI_MESH_WEBHOOK_WORKFLOWS_FILE: join(cwd, "also-ignored.json"),
    }, explicitWins, cwd), 0, explicitWins.read().stdout);
    assert.match(explicitWins.read().stdout, /"source":"file"/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("hub and worker dry-run do not spawn, and live hub uses the injected spawner", async () => {
  const dry = capture();
  assert.equal(await runCli(["mesh", "--json", "--dry-run", "hub"], {}, dry), 0);
  assert.match(dry.read().stdout, /"dryRun":true/);
  const live = capture();
  let spawned = false;
  const code = await runCli(["mesh", "--json", "hub"], {}, {
    ...live,
    spawnHub: () => {
      spawned = true;
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.equal(spawned, true);

  const worker = capture();
  let workerEnv: NodeJS.ProcessEnv | undefined;
  assert.equal(await runCli([
    "agent",
    "--json",
    "worker",
    "--name",
    "coordinator",
    "--project",
    "product",
    "--model",
    "vendor/primary",
    "--fallback-models",
    "vendor/secondary,vendor/tertiary",
    "--fresh-start",
    "--tools",
    "read,grep,mesh_fanout",
    "--session-isolation",
    "workflow",
  ], {}, {
    ...worker,
    spawnWorker: (environment) => {
      workerEnv = environment;
      return 0;
    },
  }), 0);
  assert.equal(workerEnv?.PI_MESH_WORKER_MODEL, "vendor/primary");
  assert.equal(workerEnv?.PI_MESH_WORKER_FALLBACK_MODELS, "vendor/secondary,vendor/tertiary");
  assert.equal(workerEnv?.PI_MESH_WORKER_INITIAL_CONTINUE, "false");
  assert.equal(workerEnv?.PI_MESH_WORKER_TOOLS, "read,grep,mesh_fanout");
  assert.equal(workerEnv?.PI_MESH_WORKER_SESSION_ISOLATION, "workflow");

  let compatibilityEnv: NodeJS.ProcessEnv | undefined;
  assert.equal(await runCli([
    "agent", "worker", "--name", "legacy", "--project", "product",
  ], { PI_MESH_WORKER_SESSION_ISOLATION: "off" }, {
    ...capture(),
    spawnWorker: (environment) => {
      compatibilityEnv = environment;
      return 0;
    },
  }), 0);
  assert.equal(compatibilityEnv?.PI_MESH_WORKER_SESSION_ISOLATION, "off");

  let defaultEnv: NodeJS.ProcessEnv | undefined;
  assert.equal(await runCli([
    "agent", "worker", "--name", "default-mode", "--project", "product",
  ], {}, {
    ...capture(),
    spawnWorker: (environment) => {
      defaultEnv = environment;
      return 0;
    },
  }), 0);
  assert.equal(defaultEnv?.PI_MESH_WORKER_SESSION_ISOLATION, "off");

  const invalidIsolation = capture();
  assert.equal(await runCli([
    "agent", "worker", "--name", "coordinator", "--project", "product", "--session-isolation", "shared",
  ], {}, invalidIsolation), 2);
  assert.match(invalidIsolation.read().stderr, /must be workflow or off/);
});

test("mesh tui defaults to the current project instead of a vendor-specific project", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "generic-product-"));
  const requested: string[] = [];
  try {
    const io = capture();
    assert.equal(await runCli(["mesh", "tui"], {}, {
      ...io,
      fetchImpl: async (input) => {
        const url = String(input);
        requested.push(url);
        if (url.endsWith("/health")) return new Response(JSON.stringify({ ok: true, agents: 0 }));
        if (url.endsWith("/ready")) return new Response(JSON.stringify({ ok: true, storage: "sqlite" }));
        if (url.includes("/v1/ops/snapshot")) return new Response(JSON.stringify({
          project: cwd.split(/[\\/]/).at(-1),
          fetchedAt: "2026-08-28T00:00:00.000Z",
          agents: [], openMessages: [], openMessageTotal: 0, runs: [], runTotal: 0,
        }));
        throw new Error(`unexpected URL ${url}`);
      },
    }, cwd), 0);
    assert.ok(requested.some((url) => url.includes(`project=${encodeURIComponent(cwd.split(/[\\/]/).at(-1)!)}`)));
    assert.ok(requested.every((url) => !url.includes("project=payk12")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stop, signal, status, and help cover the remaining command contract", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-mesh-cli-more-"));
  try {
    const help = capture();
    assert.equal(await runCli(["help"], {}, help, cwd), 0);
    const unknown = capture();
    assert.equal(await runCli(["nope"], {}, unknown, cwd), 2);
    const missing = capture();
    assert.equal(await runCli(["gate", "--json", "validate", "--file", join(cwd, "missing.json")], {}, missing, cwd), 1);
    const stopDry = capture();
    assert.equal(await runCli(["mesh", "--json", "--dry-run", "stop"], {}, stopDry, cwd), 0);
    const improve = capture();
    assert.equal(await runCli(["improve", "--json", "--workspace", cwd, "--target", "project"], {}, improve, cwd), 0);
    const improveResult = JSON.parse(improve.read().stdout) as { command: string; path: string; events: number };
    assert.equal(improveResult.command, "improve");
    assert.equal(improveResult.events, 0);
    assert.equal(existsSync(improveResult.path), true);
    mkdirSync(join(cwd, "state"), { recursive: true });
    const startedAt = "2026-08-26T00:00:00.000Z";
    const pidPath = join(cwd, "state", "hub.pid");
    writeFileSync(pidPath, JSON.stringify({ version: 1, pid: process.pid, role: "hub", startedAt, controlFile: "hub.stop" }));
    writeFileSync(join(cwd, "state", "worker-recovery-demo.json"), JSON.stringify({
      version: 1,
      reason: "provider_error",
      agentName: "coordinator",
      project: "product",
      createdAt: startedAt,
      previousContinue: true,
      freshSession: false,
    }));
    const sessionStatus = capture();
    assert.equal(await runCli(["session", "--json", "--workspace", cwd, "status"], {}, sessionStatus, cwd), 0);
    assert.match(sessionStatus.read().stdout, /"command":"session status"/);
    assert.match(sessionStatus.read().stdout, /hub.pid/);
    assert.match(sessionStatus.read().stdout, /provider_error/);
    const sessionStopDry = capture();
    assert.equal(await runCli(["session", "--json", "--dry-run", "--workspace", cwd, "stop"], {}, sessionStopDry, cwd), 0);
    assert.match(sessionStopDry.read().stdout, /"dryRun":true/);
    const stop = capture();
    assert.equal(await runCli(["mesh", "--json", "--workspace", cwd, "stop"], {}, {
      ...stop,
      sleep: async () => { rmSync(pidPath, { force: true }); },
    }, cwd), 0);
    assert.match(stop.read().stdout, /"stopped":\["hub.pid"\]/);
    const status = capture();
    assert.equal(await runCli(["mesh", "--json", "status"], {}, {
      ...status,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }, cwd), 0);
    const signalDry = capture();
    assert.equal(await runCli(
      ["gate", "--json", "--dry-run", "signal", "run_1", "key", "passed", "ok"],
      { PI_MESH_WORKFLOW_ID: "wf", PI_MESH_WORKFLOW_SIGNAL_SECRET: "signal-secret-16chars" },
      signalDry,
      cwd,
    ), 0);
    const signalLive = capture();
    let signalBody = "";
    const signalDeliveryIds: string[] = [];
    assert.equal(await runCli(
      ["gate", "--json", "signal", "run_1", "key", "passed", "ok", " Local   Review =artifact.md", "GitHub.Check:CI=https://ci.example/1"],
      { PI_MESH_WORKFLOW_ID: "wf", PI_MESH_WORKFLOW_SIGNAL_SECRET: "signal-secret-16chars" },
      {
        ...signalLive,
        fetchImpl: async (_input, init) => {
          signalBody = String(init?.body ?? "");
          signalDeliveryIds.push(new Headers(init?.headers).get("x-mesh-delivery-id") ?? "");
          return new Response(JSON.stringify({ duplicate: false }), { status: 202 });
        },
      },
      cwd,
    ), 0);
    assert.deepEqual(JSON.parse(signalBody).evidence, {
      "local review": "artifact.md",
      "github.check:ci": "https://ci.example/1",
    });
    assert.equal(await runCli(
      ["gate", "--json", "signal", "run_1", "key", "failed", "retry required"],
      { PI_MESH_WORKFLOW_ID: "wf", PI_MESH_WORKFLOW_SIGNAL_SECRET: "signal-secret-16chars" },
      {
        ...capture(),
        fetchImpl: async (_input, init) => {
          signalDeliveryIds.push(new Headers(init?.headers).get("x-mesh-delivery-id") ?? "");
          return new Response(JSON.stringify({ duplicate: false }), { status: 202 });
        },
      },
      cwd,
    ), 0);
    assert.equal(new Set(signalDeliveryIds).size, 2);
    assert.ok(signalDeliveryIds.every((deliveryId) => /^cli-signal:[0-9a-f-]{36}$/.test(deliveryId)));
    const list = capture();
    assert.equal(await runCli(["workflow", "--json", "list"], {}, list, cwd), 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("live workflow start is signed and smoke skips without opt-in", async () => {
  const start = capture();
  let signature = "";
  assert.equal(await runCli(["workflow", "--json", "start", "wf", "--payload", "{\"task\":\"TASK-1\"}", "--delivery-id", "cli-1"], {
    PI_MESH_WORKFLOW_SECRET: "workflow-secret-16chars",
  }, {
    ...start,
    fetchImpl: async (_input, init) => {
      signature = new Headers(init?.headers).get("x-hub-signature-256") ?? "";
      return new Response(JSON.stringify({ run: { id: "run_cli" }, duplicate: false }), { status: 202 });
    },
  }), 0);
  assert.match(start.read().stdout, /"runId":"run_cli"/);
  assert.match(signature, /^sha256=[a-f0-9]{64}$/);
  const smoke = capture();
  assert.equal(await runCli(["mesh", "--json", "smoke"], {}, smoke), 0);
  assert.match(smoke.read().stdout, /"skipped":true/);
});

test("release workflow retries reuse one explicit delivery identifier", () => {
  const launcher = readFileSync(resolve(".kxm/assets/run-provenance-workflow.ps1"), "utf8");
  assert.match(launcher, /\$startDeliveryId\s*=\s*"provenance-release-\$\(\[Guid\]::NewGuid\(\)\.ToString\('N'\)\)"/);
  assert.match(launcher, /workflow start provenance-review[\s\S]*?--delivery-id \$startDeliveryId/);
  assert.equal((launcher.match(/--delivery-id \$startDeliveryId/g) ?? []).length, 1);

  const definitions = JSON.parse(readFileSync(resolve("examples/provenance-workflow.json"), "utf8")) as Array<{
    stages: Array<{ id: string; instructions: string }>;
  }>;
  const review = definitions[0]?.stages.find((stage) => stage.id === "review");
  assert.ok(review);
  assert.match(review.instructions, /timeoutMs to 120000/);
  assert.match(review.instructions, /provenance-review:<runId>:review:<attempt>/);
  assert.match(review.instructions, /Treat every returned messageId as the durable handle/);
  assert.match(review.instructions, /mesh_get to verify each stored message has the exact run, stage, requirement, and attempt binding/);
  assert.match(review.instructions, /mesh_await with that messageId and timeoutMs 120000/);
  assert.match(review.instructions, /repeat the exact fanout parameters/);
  assert.match(launcher, /toolTimeoutMs = 180000/);
  assert.match(launcher, /fanoutTimeoutMs = 120000/);
});

test("workflow degradation approval is an explicit admin command", async () => {
  const io = capture();
  let requestedUrl = "";
  let authorization = "";
  let body = "";
  const code = await runCli([
    "gate",
    "--json",
    "degrade",
    "run_1",
    "review",
    "--requirement",
    "Independent Review",
    "--reason",
    "one configured peer is unavailable",
  ], {
    PI_MESH_AUTH_TOKEN: "admin-secret-token",
    PI_MESH_SERVER_URL: "http://127.0.0.1:7331",
  }, {
    ...io,
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({
        duplicate: false,
        approval: { id: "approval_1" },
      }), { status: 201 });
    },
  });
  assert.equal(code, 0, io.read().stdout);
  assert.match(requestedUrl, /\/v1\/workflows\/run_1\/degradations$/);
  assert.equal(authorization, "Bearer admin-secret-token");
  assert.deepEqual(JSON.parse(body), {
    stageId: "review",
    requirementKey: "Independent Review",
    reason: "one configured peer is unavailable",
  });
  assert.match(io.read().stdout, /"approvalId":"approval_1"/);
  assert.doesNotMatch(io.read().stdout, /admin-secret-token/);
});

test("github watch dry-run does not leak tokens", async () => {
  const io = capture();
  const code = await runCli(
    ["gate", "--json", "--dry-run", "github", "watch", "--run-id", "run_1", "--stage-id", "review", "--signal-key", "k", "--repo", "acme/app", "--pr", "1"],
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
    const workspace = join(cwd, ".kxm");
    const code = await runCli(["workflow", "--json", "--workspace", workspace, "export", "run_cli", "--input", input, "--out-dir", join(workspace, "assets", "retrospectives")], {}, io, cwd);
    assert.equal(code, 0, io.read().stdout);
    assert.match(io.read().stdout, /"reviewDecision":"proposed"/);
    const outside = capture();
    assert.equal(await runCli(["workflow", "--json", "--workspace", workspace, "export", "run_cli", "--input", input, "--out-dir", join(cwd, "outside")], {}, outside, cwd), 2);
    assert.match(outside.read().stdout, /output_outside_workspace_assets/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow list/get use local SQLite state and redact configured secret values", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-mesh-cli-state-"));
  const stateDir = join(cwd, ".kxm", "state");
  const dataPath = join(stateDir, "mesh.db");
  try {
    mkdirSync(stateDir, { recursive: true });
    const database = new DatabaseSync(dataPath);
    database.exec("CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, record TEXT NOT NULL); CREATE TABLE workflow_journal (run_id TEXT NOT NULL, record TEXT NOT NULL);");
    const requestSha256 = "a".repeat(64);
    const replySha256 = "b".repeat(64);
    database.prepare("INSERT INTO workflow_runs (id, record) VALUES (?, ?)").run("run_local", JSON.stringify({
      id: "run_local",
      status: "running",
      summary: "exact-secret-value",
      untrustedDigest: "c".repeat(64),
      stages: [{
        verifiedEvidence: {
          review: [{ requestSha256, replySha256 }],
        },
      }],
    }));
    database.prepare("INSERT INTO workflow_journal (run_id, record) VALUES (?, ?)").run("run_local", JSON.stringify({ id: "journal_1", runId: "run_local", summary: "safe evidence" }));
    database.close();
    const env = { PI_MESH_DATA_PATH: dataPath, PI_MESH_TEST_SECRET: "exact-secret-value" };
    const list = capture();
    assert.equal(await runCli(["workflow", "--json", "list"], env, list, cwd), 0);
    assert.match(list.read().stdout, /run_local/);
    assert.doesNotMatch(list.read().stdout, /exact-secret-value/);
    assert.match(list.read().stdout, /\[redacted\]/);
    const get = capture();
    assert.equal(await runCli(["workflow", "--json", "get", "run_local"], env, get, cwd), 0);
    assert.match(get.read().stdout, /journal_1/);
    assert.match(get.read().stdout, new RegExp(requestSha256));
    assert.match(get.read().stdout, new RegExp(replySha256));
    assert.doesNotMatch(get.read().stdout, /c{64}/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("invalid and unavailable operator commands fail safely with stable exit codes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-mesh-cli-errors-"));
  try {
    assert.equal(await runCli([], {}, capture(), cwd), 2);
    assert.equal(await runCli(["gate", "--json", "validate", "--file", join(cwd, "missing.json")], {}, capture(), cwd), 1);
    const invalidWorkflow = join(cwd, "invalid-workflow.json");
    writeFileSync(invalidWorkflow, "{");
    assert.equal(await runCli(["gate", "--json", "validate", "--file", invalidWorkflow], {}, capture(), cwd), 1);
    assert.equal(await runCli(["agent", "--json", "worker"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["mesh", "--json", "stop"], {}, capture(), cwd), 1);
    assert.equal(await runCli(["workflow", "--json", "get"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["gate", "--json", "degrade", "run_1", "review"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["workflow", "--json", "start", "wf", "--payload", "[]"], { PI_MESH_WORKFLOW_SECRET: "workflow-secret-16chars" }, capture(), cwd), 2);
    assert.equal(await runCli(["workflow", "--json", "--dry-run", "start", "wf", "--payload", "{}"], { PI_MESH_WORKFLOW_SECRET: "workflow-secret-16chars" }, capture(), cwd), 0);
    assert.equal(await runCli(["gate", "--json", "signal"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["gate", "--json", "signal", "run_1", "key", "invalid", "summary"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["gate", "--json", "signal", "run_1", "key", "passed", "summary"], {}, capture(), cwd), 2);
    assert.equal(await runCli(
      ["gate", "--json", "signal", "run_1", "key", "passed", "summary", "Review=one", " review =two"],
      { PI_MESH_WORKFLOW_ID: "wf", PI_MESH_WORKFLOW_SIGNAL_SECRET: "signal-secret-16chars" },
      capture(),
      cwd,
    ), 2);
    assert.equal(await runCli(["gate", "--json", "github", "nope"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["gate", "--json", "github", "watch"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["workflow", "--json", "nope"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["workflow", "--json", "export"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["workflow", "--json", "export", "run_missing", "--input", join(cwd, "missing.json")], {}, capture(), cwd), 1);
    assert.equal(await runCli(["mesh", "--json", "not-a-command"], {}, capture(), cwd), 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

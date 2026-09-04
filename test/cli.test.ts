import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runCli as runCliImplementation, type CliIo } from "../plugins/kxm/src/cli.ts";
import { vnextLocalBindingFile } from "../plugins/kxm/src/vnext-bindings.ts";
import { initializeVnextProject } from "../plugins/kxm/src/vnext-init.ts";
import { stringify } from "yaml";

async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo, cwd = process.cwd()): Promise<number> {
  const isolatedLogs = mkdtempSync(join(tmpdir(), "kxm-cli-telemetry-"));
  try {
    return await runCliImplementation(argv, { KXM_LOGS_DIR: isolatedLogs, ...env }, io, cwd);
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
  assert.match(sessionHelp.read().stdout, /brief/);
  const initHelp = capture();
  await runCli(["init", "--help"], {}, initHelp);
  assert.match(`${initHelp.read().stdout}${initHelp.read().stderr}`, /--hub/);
  const sshHub = capture();
  assert.equal(await runCli(["init", "--json", "--hub", "ssh"], {}, sshHub), 2);
  assert.match(sshHub.read().stderr, /hub_ssh_unsupported/);
  assert.doesNotMatch(sshHub.read().stderr, /[Mm]esh/);

  const unknownTool = capture();
  assert.equal(await runCli(["nope"], {}, unknownTool), 2);
  const unknownCommand = capture();
  assert.equal(await runCli(["agent", "nope"], {}, unknownCommand), 2);
});

test("kxm mesh is an unknown command", async () => {
  const io = capture();
  assert.equal(await runCli(["mesh"], {}, io), 2);
});

test("kxm --version prints the package version", async () => {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string };
  const io = capture();
  await runCli(["--version"], {}, io);
  assert.equal(io.read().stdout.trim(), pkg.version);
  assert.equal(io.read().stderr, "");
});

test("error payloads carry a schema and land on stderr in JSON and text modes", async () => {
  const json = capture();
  assert.equal(await runCli(["run", "--json"], {}, json), 2);
  assert.equal(json.read().stdout, "");
  const payload = JSON.parse(json.read().stderr) as { schema: string; ok: boolean; command: string; error: string };
  assert.equal(payload.schema, "kxm.cli-result.v1");
  assert.equal(payload.ok, false);
  assert.equal(payload.command, "run");
  assert.equal(payload.error, "workflow_required");

  const text = capture();
  assert.equal(await runCli(["run"], {}, text), 2);
  assert.equal(text.read().stdout, "");
  assert.match(text.read().stderr, /usage: kxm run <workflow>/);

  const ok = capture();
  assert.equal(await runCli(["harness", "list", "--json"], {}, ok), 0);
  assert.equal(ok.read().stderr, "");
  assert.equal((JSON.parse(ok.read().stdout) as { schema: string }).schema, "kxm.cli-result.v1");
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
  const gate = JSON.parse(gateIo.read().stderr) as {
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

test("init --hub new is opt-in and does not mention Mesh", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-cli-init-hub-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-cli-init-hub-state-"));
  try {
    makeGitRoot(cwd);
    const io = capture();
    assert.equal(await runCli([
      "init", "--json", "--hub", "new", "--name", "Hub Project", "--project-id", "prj_01JHUBPROJECT0000000000000",
    ], { KXM_STATE_HOME: stateRoot }, io, cwd), 0);
    const payload = JSON.parse(io.read().stdout) as { action: string; hub?: { mode?: string } };
    assert.equal(payload.action, "created");
    assert.equal(payload.hub?.mode, "new");
    assert.match(io.read().stdout, /kxm hub start/);
    assert.doesNotMatch(io.read().stdout, /[Mm]esh/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("vNext init creates and revalidates project configuration without legacy environment overrides", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-vnext-cli-init-"));
  const dryCwd = mkdtempSync(join(tmpdir(), "kxm-vnext-cli-dry-"));
  const legacyCwd = mkdtempSync(join(tmpdir(), "kxm-vnext-cli-legacy-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-cli-init-state-"));
  const stateEnv = { KXM_STATE_HOME: stateRoot };
  try {
    makeGitRoot(cwd);
    makeGitRoot(dryCwd);
    const unsupportedWorkspace = capture();
    assert.equal(await runCli(["--workspace", join(cwd, "wrong"), "init", "--json"], {}, unsupportedWorkspace, cwd), 2);
    assert.match(unsupportedWorkspace.read().stderr, /"error":"workspace_option_unsupported"/);
    assert.equal(existsSync(join(cwd, ".kxm")), false);

    const createdIo = capture();
    assert.equal(await runCli([
      "init", "--json", "--name", "CLI Project", "--project-id", "prj_01JCLIPROJECT0000000000000",
    ], {
      ...stateEnv,
      KXM_WORKDIR: join(cwd, "must-not-use"),
      KXM_CONFIG_DIR: join(cwd, "also-must-not-use"),
    }, createdIo, cwd), 0);
    const created = JSON.parse(createdIo.read().stdout) as { action: string; mode: string; configRevision: string; files: string[] };
    assert.equal(created.action, "created");
    assert.equal(created.mode, "ready");
    assert.match(created.configRevision, /^sha256:[a-f0-9]{64}$/);
    assert.equal(created.files.length, 6);
    assert.equal(existsSync(join(cwd, ".kxm", "project.yaml")), true);
    assert.equal(existsSync(join(cwd, "must-not-use")), false);

    const repeatedIo = capture();
    assert.equal(await runCli(["init", "--json"], stateEnv, repeatedIo, cwd), 0);
    const repeated = JSON.parse(repeatedIo.read().stdout) as { action: string; configRevision: string };
    assert.equal(repeated.action, "validated");
    assert.equal(repeated.configRevision, created.configRevision);

    const dryIo = capture();
    assert.equal(await runCli(["init", "--json", "--dry-run"], stateEnv, dryIo, dryCwd), 0);
    assert.match(dryIo.read().stdout, /"action":"planned"/);
    assert.equal(existsSync(join(dryCwd, ".kxm")), false);
    const invalidIo = capture();
    assert.equal(await runCli(["init", "--json", "--dry-run", "--project-id", "not-a-project-id"], stateEnv, invalidIo, dryCwd), 1);
    assert.match(invalidIo.read().stderr, /"error":"vnext_initialization_failed"/);
    assert.equal(existsSync(join(dryCwd, ".kxm")), false);

    const noGitIo = capture();
    assert.equal(await runCli(["init", "--json", "--dry-run"], stateEnv, noGitIo, legacyCwd), 1);
    assert.match(noGitIo.read().stderr, /git_root_required/);

    makeGitRoot(legacyCwd);
    mkdirSync(join(legacyCwd, ".kxm", "config"), { recursive: true });
    writeFileSync(join(legacyCwd, ".kxm", "config", "agents.json"), "[]\n");
    const invalidMigrationIo = capture();
    assert.equal(await runCli(["init", "--json", "--dry-run", "--project-id", "invalid"], stateEnv, invalidMigrationIo, legacyCwd), 1);
    assert.match(invalidMigrationIo.read().stderr, /project_id_invalid/);
    const legacyIo = capture();
    assert.equal(await runCli(["init", "--json"], stateEnv, legacyIo, legacyCwd), 1);
    assert.match(legacyIo.read().stderr, /"mode":"migrate"/);
    assert.match(legacyIo.read().stderr, /\.kxm\/config\/agents\.json/);
    assert.match(legacyIo.read().stderr, /"plannedOnly":true/);
  } finally {
    for (const root of [cwd, dryCwd, legacyCwd, stateRoot]) rmSync(root, { recursive: true, force: true });
  }
});

test("vNext init CLI resumes a pinned interrupted create", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-vnext-cli-resume-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-cli-resume-state-"));
  try {
    makeGitRoot(cwd);
    assert.throws(
      () => initializeVnextProject(cwd, {
        projectId: "prj_01JCLIRESUME0000000000000",
        projectName: "CLI Resume",
        localStateRoot: stateRoot,
        testFaultAt: "prepared",
      }),
      /injected init fault/,
    );
    const output = capture();
    assert.equal(await runCli(["init", "--json"], { KXM_STATE_HOME: stateRoot }, output, cwd), 0);
    const resumed = JSON.parse(output.read().stdout) as { action: string; transactionKind: string; plannedOnly: boolean };
    assert.equal(resumed.action, "resumed");
    assert.equal(resumed.transactionKind, "create");
    assert.equal(resumed.plannedOnly, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("vNext init joins with repeated CLI member bindings stored outside Git", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-vnext-cli-join-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-cli-state-"));
  try {
    cpSync(resolve("examples/vnext"), cwd, { recursive: true });
    makeGitRoot(cwd);
    makeGitRoot(join(cwd, "repositories", "api"));
    makeGitRoot(join(cwd, "repositories", "web"));
    const projectFile = join(cwd, ".kxm", "project.yaml");
    const project = readFileSync(projectFile, "utf8").replace("    pathHint: repositories/api\n", "");
    writeFileSync(projectFile, project);
    const api = join(cwd, "repositories", "api");
    const env = { KXM_STATE_HOME: stateRoot };

    const malformed = capture();
    assert.equal(await runCli(["init", "--json", "--repository", "api"], env, malformed, cwd), 1);
    assert.match(malformed.read().stderr, /repository_binding_argument_invalid/);
    const duplicate = capture();
    assert.equal(await runCli([
      "init", "--json", "--repository", `api=${api}`, "--repository", `api=${api}`,
    ], env, duplicate, cwd), 1);
    assert.match(duplicate.read().stderr, /repository_binding_argument_duplicate/);

    const joinedIo = capture();
    assert.equal(await runCli(["init", "--json", "--repository", `api=${api}`], env, joinedIo, cwd), 0);
    const joined = JSON.parse(joinedIo.read().stdout) as {
      action: string;
      localBindingFile: string;
      bindingsChanged: boolean;
    };
    assert.equal(joined.action, "joined");
    assert.equal(joined.bindingsChanged, true);
    assert.match(joined.localBindingFile, /repository-bindings\.json$/);
    assert.equal(existsSync(vnextLocalBindingFile(cwd, { stateRoot })), true);
    assert.equal(readFileSync(projectFile, "utf8"), project, "join must not rewrite Git configuration");

    const repeatedIo = capture();
    assert.equal(await runCli(["init", "--json"], env, repeatedIo, cwd), 0);
    const repeated = JSON.parse(repeatedIo.read().stdout) as { action: string; localBindingFile: string };
    assert.equal(repeated.action, "validated");
    assert.equal(repeated.localBindingFile, joined.localBindingFile);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("kxm migrate plans, applies with reviewed decisions, and verifies the receipt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-migrate-cli-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-migrate-cli-state-"));
  const env = { KXM_STATE_HOME: stateRoot };
  try {
    makeGitRoot(cwd);
    mkdirSync(join(cwd, ".kxm", "config", "workflows"), { recursive: true });
    writeFileSync(join(cwd, ".kxm", "config", "agents.json"), JSON.stringify({
      schema: "kxm.agents.v1",
      agents: [{ name: "writer", kind: "agent", driver: "ai", model: "xai/grok-4.6", purpose: "Writes" }],
    }), "utf8");
    writeFileSync(join(cwd, ".kxm", "config", "workflows", "fix.json"), JSON.stringify([{
      id: "fix",
      target: "writer",
      secretEnv: "FIX_SECRET",
      maxTransitions: 6,
      stages: [{
        id: "plan",
        instructions: "Plan the fix.",
        requiredEvidence: ["plan"],
        on: { passed: "implement", blocked: "$terminal" },
      }, {
        id: "implement",
        instructions: "Implement the plan.",
        requiredEvidence: ["diff"],
        on: { passed: "$terminal", failed: "implement", blocked: "$terminal" },
      }],
    }]), "utf8");

    const workspace = capture();
    assert.equal(await runCli(["--workspace", cwd, "migrate", "plan", "--json"], env, workspace, cwd), 2);

    const plannedIo = capture();
    assert.equal(await runCli(["migrate", "plan", "--json"], env, plannedIo, cwd), 1);
    const planned = JSON.parse(plannedIo.read().stderr) as {
      ok: boolean;
      plannedOnly: boolean;
      plan: { canApply: boolean; ambiguities: Array<{ key: string; allowedValues: Array<string | number> }>; sourceDigest: string; projectId: string; projectName: string };
    };
    assert.equal(planned.ok, false);
    assert.equal(planned.plannedOnly, true);
    assert.equal(planned.plan.canApply, false);
    const keys = planned.plan.ambiguities.map((ambiguity) => ambiguity.key);
    assert(keys.some((key) => key.startsWith("secret:fix-") && key.endsWith(":secretEnv")));
    assert(keys.some((key) => key.startsWith("terminal:fix-") && key.endsWith(":blocked")));
    assert(keys.some((key) => key.startsWith("backedge:fix-") && key.endsWith(":failed")));
    assert.equal(existsSync(join(cwd, ".kxm", "project.yaml")), false, "plan performs no writes");

    const blockedIo = capture();
    assert.equal(await runCli(["migrate", "apply", "--json"], env, blockedIo, cwd), 1);
    const blocked = JSON.parse(blockedIo.read().stderr) as { action: string; plannedOnly: boolean };
    assert.equal(blocked.action, "planned");
    assert.equal(blocked.plannedOnly, true);
    assert.equal(existsSync(join(cwd, ".kxm", "project.yaml")), false);

    const resolutions: Record<string, string | number> = {};
    for (const ambiguity of planned.plan.ambiguities) {
      const first = ambiguity.allowedValues[0]!;
      resolutions[ambiguity.key] = first;
    }
    const decisionsPath = join(cwd, "decisions.yaml");
    writeFileSync(decisionsPath, stringify({
      schema: "kxm.migration-decision.v1",
      projectId: planned.plan.projectId,
      projectName: planned.plan.projectName,
      sourceDigest: planned.plan.sourceDigest,
      resolutions,
    }), "utf8");

    const dryIo = capture();
    assert.equal(await runCli(["migrate", "apply", "--json", "--dry-run", "--decisions", decisionsPath], env, dryIo, cwd), 0);
    assert.match(dryIo.read().stdout, /"action":"planned"/);
    assert.equal(existsSync(join(cwd, ".kxm", "project.yaml")), false, "apply --dry-run performs no writes");

    const blockedDryIo = capture();
    assert.equal(await runCli(["migrate", "apply", "--json", "--dry-run"], env, blockedDryIo, cwd), 1);
    const blockedDry = JSON.parse(blockedDryIo.read().stderr) as { ok: boolean; action: string };
    assert.equal(blockedDry.ok, false, "dry run with unresolved ambiguities must not report success");
    assert.equal(blockedDry.action, "planned");
    assert.equal(existsSync(join(cwd, ".kxm", "project.yaml")), false);

    const appliedIo = capture();
    assert.equal(await runCli(["migrate", "apply", "--json", "--decisions", decisionsPath], env, appliedIo, cwd), 0);
    const applied = JSON.parse(appliedIo.read().stdout) as { action: string; configRevision: string; receiptPath: string; files: string[] };
    assert.equal(applied.action, "applied");
    assert.equal(applied.receiptPath, ".kxm/migration-receipt.yaml");
    assert(applied.files.includes(".kxm/workflows/fix.yaml"));

    const verifiedIo = capture();
    assert.equal(await runCli(["migrate", "verify", "--json"], env, verifiedIo, cwd), 0);
    const verified = JSON.parse(verifiedIo.read().stdout) as { ok: boolean; configRevision: string };
    assert.equal(verified.ok, true);
    assert.equal(verified.configRevision, applied.configRevision);

    const initIo = capture();
    assert.equal(await runCli(["init", "--json"], env, initIo, cwd), 0);
    assert.match(initIo.read().stdout, /"action":"validated"/, "migrated project initializes as ready");

    writeFileSync(join(cwd, ".kxm", "config", "agents.json"), "{}\n", "utf8");
    const driftIo = capture();
    assert.equal(await runCli(["migrate", "verify", "--json"], env, driftIo, cwd), 1);
    assert.match(driftIo.read().stderr, /migration_source_changed/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("kxm run creates, lists, shows, and cancels a run offline with an auto-started supervisor", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-run-cli-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-run-cli-state-"));
  const env = { KXM_STATE_HOME: stateRoot };
  try {
    makeGitRoot(cwd);
    initializeVnextProject(cwd, { projectId: "prj_01JRUNCLI000000000000000", projectName: "Run CLI" });
    spawnSync("git", ["-C", cwd, "add", "-A"], { windowsHide: true });
    spawnSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"], { windowsHide: true });

    const dryIo = capture();
    assert.equal(await runCli(["run", "default", "--json", "--dry-run", "fix it"], env, dryIo, cwd), 0);
    assert.match(dryIo.read().stdout, /"dryRun":true/);

    const noWorkflowIo = capture();
    assert.equal(await runCli(["run", "missing", "--json"], env, noWorkflowIo, cwd), 1);
    assert.match(noWorkflowIo.read().stderr, /run_workflow_unknown/);

    const runIo = capture();
    assert.equal(await runCli(["run", "default", "--json", "fix the flaky gate"], env, runIo, cwd), 0);
    const created = JSON.parse(runIo.read().stdout) as {
      run: { runId: string; status: string; homeRuntimeId: string; configRevision: string };
      idempotent: boolean;
      supervisor: { runtimeId: string; port: number; started: boolean };
    };
    assert.equal(created.run.status, "created");
    assert.equal(created.supervisor.started, true);
    assert(!runIo.read().stdout.includes("flaky gate"), "prompt content never appears in output");

    const listIo = capture();
    assert.equal(await runCli(["runs", "list", "--json"], env, listIo, cwd), 0);
    const list = JSON.parse(listIo.read().stdout) as { runs: Array<{ runId: string; status: string }> };
    assert.equal(list.runs.length, 1);
    assert.equal(list.runs[0]!.runId, created.run.runId);

    const statusIo = capture();
    assert.equal(await runCli(["runs", "status", created.run.runId, "--json"], env, statusIo, cwd), 0);
    const status = JSON.parse(statusIo.read().stdout) as { run: { status: string; updatedAt: string } };
    assert.equal(status.run.status, "created");

    const cancelDryIo = capture();
    assert.equal(await runCli(["runs", "cancel", created.run.runId, "--json", "--dry-run"], env, cancelDryIo, cwd), 0);
    const stillCreatedIo = capture();
    assert.equal(await runCli(["runs", "status", created.run.runId, "--json"], env, stillCreatedIo, cwd), 0);
    assert.equal((JSON.parse(stillCreatedIo.read().stdout) as { run: { status: string } }).run.status, "created", "dry-run cancel writes nothing");

    const cancelIo = capture();
    assert.equal(await runCli(["runs", "cancel", created.run.runId, "--json"], env, cancelIo, cwd), 0);
    const cancelled = JSON.parse(cancelIo.read().stdout) as { run: { status: string }; idempotent: boolean };
    assert.equal(cancelled.run.status, "cancelled");
    assert.equal(cancelled.idempotent, false);

    const againIo = capture();
    assert.equal(await runCli(["runs", "cancel", created.run.runId, "--json"], env, againIo, cwd), 0);
    assert.equal((JSON.parse(againIo.read().stdout) as { idempotent: boolean }).idempotent, true, "repeated cancel on a terminal run is idempotent");

    const runtimeStatusIo = capture();
    assert.equal(await runCli(["runtime", "status", "--json"], env, runtimeStatusIo, cwd), 0);
    assert.match(runtimeStatusIo.read().stdout, /"running":true/);

    const stopIo = capture();
    assert.equal(await runCli(["runtime", "stop", "--json"], env, stopIo, cwd), 0);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    const stoppedIo = capture();
    assert.equal(await runCli(["runtime", "status", "--json"], env, stoppedIo, cwd), 1);
  } finally {
    try { await runCli(["runtime", "stop", "--json"], env, capture(), cwd); } catch { /* best effort */ }
    await waitForSupervisorExit(env);
    rmWithRetry(cwd);
    rmWithRetry(stateRoot);
  }
});

test("kxm run and runtime commands cover workspace, project, and dry-run branches", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-run-cli-branches-"));
  const noProject = mkdtempSync(join(tmpdir(), "kxm-run-cli-noproject-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-run-cli-branches-state-"));
  const env = { KXM_STATE_HOME: stateRoot };
  try {
    makeGitRoot(noProject);
    const workspaceIo = capture();
    assert.equal(await runCli(["--workspace", cwd, "run", "default", "--json"], env, workspaceIo, cwd), 2);
    assert.match(workspaceIo.read().stderr, /workspace_option_unsupported/);

    for (const [args, command] of [
      [["run", "default", "--json"], "run"],
      [["runs", "status", "run_x", "--json"], "run status"],
      [["runs", "cancel", "run_x", "--json"], "run cancel"],
      [["runs", "list", "--json"], "run list"],
    ] as const) {
      const io = capture();
      assert.equal(await runCli([...args], env, io, noProject), 1, command);
      assert.match(io.read().stderr, /project_required/, command);
    }

    makeGitRoot(cwd);
    initializeVnextProject(cwd, { projectId: "prj_01JRUNBRANCH000000000000", projectName: "Run Branches" });
    spawnSync("git", ["-C", cwd, "add", "-A"], { windowsHide: true });
    spawnSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"], { windowsHide: true });

    const startDryIo = capture();
    assert.equal(await runCli(["runtime", "start", "--json", "--dry-run"], env, startDryIo, cwd), 0);
    assert.match(startDryIo.read().stdout, /"dryRun":true/);

    const stopDryIo = capture();
    assert.equal(await runCli(["runtime", "stop", "--json", "--dry-run"], env, stopDryIo, cwd), 0);

    const stoppedStatusIo = capture();
    assert.equal(await runCli(["runtime", "status", "--json"], env, stoppedStatusIo, cwd), 1);

    const stopNotRunningIo = capture();
    assert.equal(await runCli(["runtime", "stop", "--json"], env, stopNotRunningIo, cwd), 0);
    assert.match(stopNotRunningIo.read().stdout, /"stopped":false/);

    // Exercise the VnextConfigError catch branches on each run command.
    const missingRunIo = capture();
    assert.equal(await runCli(["runs", "cancel", "run_00000000000000000000000000000000", "--json"], env, missingRunIo, cwd), 1);
    assert.match(missingRunIo.read().stderr, /run_unknown|run_cancel_failed/);

    const missingStatusIo = capture();
    assert.equal(await runCli(["runs", "status", "run_00000000000000000000000000000000", "--json"], env, missingStatusIo, cwd), 1);
    assert.match(missingStatusIo.read().stderr, /run_unknown|run_status_failed/);

    const projectFile = join(cwd, ".kxm", "project.yaml");
    const projectYaml = readFileSync(projectFile, "utf8");
    writeFileSync(projectFile, "schema: kxm.project.v1\n", "utf8");
    const brokenRunIo = capture();
    assert.equal(await runCli(["run", "default", "--json"], env, brokenRunIo, cwd), 1);
    assert.match(brokenRunIo.read().stderr, /run_failed|schema_/);
    const brokenListIo = capture();
    assert.equal(await runCli(["runs", "list", "--json"], env, brokenListIo, cwd), 1);
    assert.match(brokenListIo.read().stderr, /run_list_failed|schema_/);
    writeFileSync(projectFile, projectYaml, "utf8");
  } finally {
    try { await runCli(["runtime", "stop", "--json"], env, capture(), cwd); } catch { /* best effort */ }
    await waitForSupervisorExit(env);
    rmWithRetry(cwd);
    rmWithRetry(noProject);
    rmWithRetry(stateRoot);
  }
});

import { vnextSupervisorStatus } from "../plugins/kxm/src/vnext-runtime-supervisor.ts";
import { vnextRuntimePaths } from "../plugins/kxm/src/vnext-runtime-store.ts";

async function waitForSupervisorExit(env: NodeJS.ProcessEnv): Promise<void> {
  const paths = vnextRuntimePaths({ env });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = vnextSupervisorStatus(paths);
    const pid = status.pid;
    const pidAlive = pid !== undefined && (() => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    })();
    if (!status.running && !pidAlive) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
}

function rmWithRetry(path: string): void {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 9) throw error;
      const deadline = Date.now() + 400;
      while (Date.now() < deadline) { /* busy-wait briefly */ }
    }
  }
}

test("kxm trust diff and check classify expansions against HEAD", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-trust-cli-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-trust-cli-state-"));
  const env = { KXM_STATE_HOME: stateRoot };
  try {
    makeGitRoot(cwd);
    initializeVnextProject(cwd, { projectId: "prj_01JTRUSTCLI00000000000000", projectName: "Trust CLI" });
    spawnSync("git", ["-C", cwd, "add", "-A"], { windowsHide: true });
    const commit = spawnSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "init"], { windowsHide: true });
    assert.equal(commit.status, 0, commit.stderr as unknown as string);

    const workspaceIo = capture();
    assert.equal(await runCli(["--workspace", cwd, "trust", "check", "--json"], env, workspaceIo, cwd), 2);

    const cleanIo = capture();
    assert.equal(await runCli(["trust", "check", "--json"], env, cleanIo, cwd), 0);
    const clean = JSON.parse(cleanIo.read().stdout) as { ok: boolean; requiresReview: boolean; expansions: number };
    assert.equal(clean.ok, true);
    assert.equal(clean.requiresReview, false);
    assert.equal(clean.expansions, 0);

    const cleanDiffIo = capture();
    assert.equal(await runCli(["trust", "diff", "--json"], env, cleanDiffIo, cwd), 0);
    assert.equal((JSON.parse(cleanDiffIo.read().stdout) as { changes: unknown[] }).changes.length, 0);

    const agentFile = join(cwd, ".kxm", "agents", "coordinator.yaml");
    writeFileSync(agentFile, readFileSync(agentFile, "utf8").replace("network: provider-only", "network: host"), "utf8");
    const expandedIo = capture();
    assert.equal(await runCli(["trust", "check", "--json"], env, expandedIo, cwd), 1);
    const expanded = JSON.parse(expandedIo.read().stderr) as {
      ok: boolean;
      requiresReview: boolean;
      changes: Array<{ field: string; direction: string; resource: string }>;
    };
    assert.equal(expanded.ok, false);
    assert.equal(expanded.requiresReview, true);
    assert(expanded.changes.some((change) => change.field === "network" && change.direction === "expansion" && change.resource === ".kxm/agents/coordinator.yaml"));

    const expandedTextIo = capture();
    assert.equal(await runCli(["trust", "check"], env, expandedTextIo, cwd), 1);
    assert.match(expandedTextIo.read().stderr, /EXPANSION/);
    assert.match(expandedTextIo.read().stderr, /trust check failed/);

    const invalidBaseIo = capture();
    assert.equal(await runCli(["trust", "check", "--json", "--base", "nope; rm -rf /"], env, invalidBaseIo, cwd), 1);
    assert.match(invalidBaseIo.read().stderr, /git_revision_invalid/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("kxm migrate covers error paths and text output modes", async () => {
  const emptyCwd = mkdtempSync(join(tmpdir(), "kxm-migrate-cli-empty-"));
  const cwd = mkdtempSync(join(tmpdir(), "kxm-migrate-cli-text-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-migrate-cli-text-state-"));
  const env = { KXM_STATE_HOME: stateRoot };
  try {
    makeGitRoot(emptyCwd);
    const noSourcesIo = capture();
    assert.equal(await runCli(["migrate", "plan", "--json"], env, noSourcesIo, emptyCwd), 1);
    const noSources = JSON.parse(noSourcesIo.read().stderr) as { error: string; issues: Array<{ code: string }> };
    assert.equal(noSources.error, "migration_plan_failed");
    assert(noSources.issues.some((issue) => issue.code === "legacy_sources_missing"));

    const noReceiptIo = capture();
    assert.equal(await runCli(["migrate", "verify", "--json"], env, noReceiptIo, emptyCwd), 1);
    const noReceipt = JSON.parse(noReceiptIo.read().stderr) as { ok: boolean; issues: Array<{ code: string }> };
    assert.equal(noReceipt.ok, false);
    assert(noReceipt.issues.some((issue) => issue.code === "migration_receipt_missing"));

    makeGitRoot(cwd);
    mkdirSync(join(cwd, ".kxm", "config", "workflows"), { recursive: true });
    writeFileSync(join(cwd, ".kxm", "config", "agents.json"), JSON.stringify({
      schema: "kxm.agents.v1",
      agents: [{ name: "writer", kind: "agent", driver: "ai", purpose: "Writes" }],
    }), "utf8");
    writeFileSync(join(cwd, ".kxm", "config", "workflows", "fix.json"), JSON.stringify([{
      id: "fix",
      target: "writer",
      secretEnv: "FIX_SECRET",
      maxTransitions: 6,
      stages: [{
        id: "plan",
        instructions: "Plan the fix.",
        on: { passed: "implement", blocked: "$terminal" },
      }, {
        id: "implement",
        instructions: "Implement the plan.",
        on: { passed: "$terminal", failed: "implement", blocked: "$terminal" },
      }],
    }]), "utf8");

    // Text mode: blocked plan lists the required decisions.
    const textPlanIo = capture();
    assert.equal(await runCli(["migrate", "plan"], env, textPlanIo, cwd), 1);
    assert.match(textPlanIo.read().stderr, /migration plan requires \d+ reviewed decision/);
    assert.match(textPlanIo.read().stderr, /secret:fix-/);

    // Text mode: blocked apply without decisions.
    const textBlockedIo = capture();
    assert.equal(await runCli(["migrate", "apply"], env, textBlockedIo, cwd), 1);
    assert.match(textBlockedIo.read().stderr, /migration blocked by \d+ unresolved decision/);

    // Missing decisions file is a stable error.
    const missingDecisionsIo = capture();
    assert.equal(await runCli(["migrate", "apply", "--json", "--decisions", join(cwd, "nope.yaml")], env, missingDecisionsIo, cwd), 1);
    const missingDecisions = JSON.parse(missingDecisionsIo.read().stderr) as { error: string; issues: Array<{ code: string }> };
    assert.equal(missingDecisions.error, "migration_apply_failed");
    assert(missingDecisions.issues.some((issue) => issue.code === "decisions_missing"));

    // Resolve everything, then exercise the text-mode canApply plan, apply,
    // already-migrated, and verify-success paths.
    const jsonPlanIo = capture();
    assert.equal(await runCli(["migrate", "plan", "--json"], env, jsonPlanIo, cwd), 1);
    const jsonPlan = JSON.parse(jsonPlanIo.read().stderr) as {
      plan: { projectId: string; projectName: string; sourceDigest: string; ambiguities: Array<{ key: string; allowedValues: Array<string | number> }> };
    };
    const resolutions: Record<string, string | number> = {};
    for (const ambiguity of jsonPlan.plan.ambiguities) resolutions[ambiguity.key] = ambiguity.allowedValues[0]!;
    const decisionsPath = join(cwd, "decisions.yaml");
    writeFileSync(decisionsPath, stringify({
      schema: "kxm.migration-decision.v1",
      projectId: jsonPlan.plan.projectId,
      projectName: jsonPlan.plan.projectName,
      sourceDigest: jsonPlan.plan.sourceDigest,
      resolutions,
    }), "utf8");

    const canApplyTextIo = capture();
    assert.equal(await runCli(["migrate", "plan"], env, canApplyTextIo, cwd), 1, "without decisions the plan still needs approvals");

    const workspaceApplyIo = capture();
    assert.equal(await runCli(["--workspace", cwd, "migrate", "apply", "--json"], env, workspaceApplyIo, cwd), 2);
    const workspaceVerifyIo = capture();
    assert.equal(await runCli(["--workspace", cwd, "migrate", "verify", "--json"], env, workspaceVerifyIo, cwd), 2);

    const applyTextIo = capture();
    assert.equal(await runCli(["migrate", "apply", "--decisions", decisionsPath], env, applyTextIo, cwd), 0);
    assert.match(applyTextIo.read().stdout, /migration applied: \d+ resources installed/);

    const alreadyTextIo = capture();
    assert.equal(await runCli(["migrate", "apply"], env, alreadyTextIo, cwd), 0);
    assert.match(alreadyTextIo.read().stdout, /migration receipt already exists; nothing to apply/);

    const verifyTextIo = capture();
    assert.equal(await runCli(["migrate", "verify"], env, verifyTextIo, cwd), 0);
    assert.match(verifyTextIo.read().stdout, /migration receipt verified/);

    // Verify failure in text mode lists issues.
    writeFileSync(join(cwd, ".kxm", "workflows", "fix.yaml"), `${readFileSync(join(cwd, ".kxm", "workflows", "fix.yaml"), "utf8")}# drift\n`, "utf8");
    const verifyFailTextIo = capture();
    assert.equal(await runCli(["migrate", "verify"], env, verifyFailTextIo, cwd), 1);
    assert.match(verifyFailTextIo.read().stderr, /migration verification failed/);
  } finally {
    rmSync(emptyCwd, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("init and validate work in an isolated workspace", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-mesh-cli-"));
  try {
    const isolated = join(cwd, "ws");
    mkdirSync(join(isolated, "config"), { recursive: true });
    mkdirSync(join(isolated, "assets"), { recursive: true });
    mkdirSync(join(isolated, "state"), { recursive: true });
    assert.equal(existsSync(join(isolated, "config", "agents.json")), false, "consumer workspace must not copy the package dogfood roster");

    writeFileSync(join(isolated, "config", "agents.json"), JSON.stringify({
      schema: "kxm.agents.v1",
      agents: [{ name: "planner", kind: "agent", driver: "ai", purpose: "plans" }],
    }));
    writeFileSync(join(isolated, "config", "gates.json"), JSON.stringify({
      schema: "kxm.gates.v1",
      gates: [{ name: "validate", kind: "gate", driver: "code", purpose: "validates" }],
    }));
    mkdirSync(join(isolated, "state"), { recursive: true });
    const database = new DatabaseSync(join(isolated, "state", "kxm.db"));
    try {
      database.exec("CREATE TABLE agents (record TEXT NOT NULL); CREATE TABLE messages (record TEXT NOT NULL); CREATE TABLE workflow_runs (record TEXT NOT NULL); CREATE TABLE workflow_journal (category TEXT, record TEXT NOT NULL);");
      database.prepare("INSERT INTO workflow_runs(record) VALUES (?)").run(JSON.stringify({
        id: "run_brief1",
        status: "running",
        definitionId: "default",
        project: "demo",
        currentStage: "implement",
        stages: [
          { id: "plan", status: "passed" },
          { id: "implement", status: "in_progress" },
        ],
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      }));
      database.prepare("INSERT INTO workflow_journal(category, record) VALUES (?, ?)").run("plan", JSON.stringify({
        id: "plan_brief1",
        runId: "run_brief1",
        category: "plan",
        summary: "Hub local session brief",
        createdAt: "2026-09-01T00:00:00.000Z",
      }));
      database.prepare("INSERT INTO messages(record) VALUES (?)").run(JSON.stringify({
        id: "msg_brief",
        status: "delivered",
        from: "agt_1",
        fromName: "sender",
        to: "agt_2",
        toName: "recipient",
        delivery: "followUp",
        content: "SECRET BODY MUST NOT LOAD",
        createdAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-09-02T00:00:00.000Z",
        hops: 0,
        maxHops: 5,
      }));
    } finally {
      database.close();
    }
    const briefIo = capture();
    assert.equal(await runCli(["session", "--json", "--workspace", isolated, "brief"], {}, briefIo, cwd), 0);
    const briefOut = briefIo.read().stdout;
    assert.match(briefOut, /"command":"session brief"/);
    assert.match(briefOut, /run_brief1/);
    assert.match(briefOut, /Hub local session brief/);
    assert.doesNotMatch(briefOut, /SECRET BODY MUST NOT LOAD/);
    const briefStatus = capture();
    assert.equal(await runCli(["session", "--json", "--workspace", isolated, "brief", "--status"], {}, briefStatus, cwd), 0);
    assert.match(briefStatus.read().stdout, /statusLine/);

    const sessionIo = capture();
    assert.equal(await runCli([
      "session", "--json", "--workspace", isolated, "start", "--id", "review-1", "--mix", "planner,validate",
    ], {}, sessionIo, cwd), 0);
    assert.match(sessionIo.read().stdout, /"schema":"kxm.session.v1"/);
    assert.equal(existsSync(join(isolated, "assets", "sessions", "review-1", "session.json")), true);

    const env = {
      KXM_V04_WORKFLOW_SECRET: "0123456789abcdef",
      KXM_V04_SIGNAL_SECRET: "0123456789abcdef",
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
      KXM_V04_WORKFLOW_SECRET: "0123456789abcdef",
      KXM_V04_SIGNAL_SECRET: "0123456789abcdef",
    };

    const missing = capture();
    assert.equal(await runCli(["gate", "--json", "validate"], {
      ...secrets,
      KXM_WEBHOOK_WORKFLOWS: "",
      KXM_WEBHOOK_WORKFLOWS_FILE: "",
    }, missing, cwd), 2);
    assert.match(missing.read().stderr, /workflow_source_required/);

    const ambiguous = capture();
    assert.equal(await runCli(["gate", "--json", "validate"], {
      ...secrets,
      KXM_WEBHOOK_WORKFLOWS: inline,
      KXM_WEBHOOK_WORKFLOWS_FILE: file,
    }, ambiguous, cwd), 2);
    assert.match(ambiguous.read().stderr, /ambiguous_workflow_source/);

    const inlineOnly = capture();
    assert.equal(await runCli(["gate", "--json", "validate"], {
      ...secrets,
      KXM_WEBHOOK_WORKFLOWS: inline,
      KXM_WEBHOOK_WORKFLOWS_FILE: "",
    }, inlineOnly, cwd), 0, inlineOnly.read().stdout);
    assert.match(inlineOnly.read().stdout, /"source":"inline"/);
    assert.doesNotMatch(inlineOnly.read().stdout, /0123456789abcdef/);

    const configuredFile = capture();
    assert.equal(await runCli(["gate", "--json", "validate"], {
      ...secrets,
      KXM_WEBHOOK_WORKFLOWS: "",
      KXM_WEBHOOK_WORKFLOWS_FILE: file,
    }, configuredFile, cwd), 0, configuredFile.read().stdout);
    assert.match(configuredFile.read().stdout, /"source":"file"/);

    const explicitWins = capture();
    assert.equal(await runCli(["gate", "--json", "validate", "--file", file], {
      ...secrets,
      KXM_WEBHOOK_WORKFLOWS: "not-json",
      KXM_WEBHOOK_WORKFLOWS_FILE: join(cwd, "also-ignored.json"),
    }, explicitWins, cwd), 0, explicitWins.read().stdout);
    assert.match(explicitWins.read().stdout, /"source":"file"/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("hub and worker dry-run do not spawn, and live hub uses the injected spawner", async () => {
  const dry = capture();
  assert.equal(await runCli(["hub", "--json", "--dry-run", "start"], {}, dry), 0);
  assert.match(dry.read().stdout, /"dryRun":true/);
  const live = capture();
  let spawned = false;
  const code = await runCli(["hub", "--json", "start"], {}, {
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
    "read,grep,kxm_fanout",
    "--session-isolation",
    "workflow",
  ], {}, {
    ...worker,
    spawnWorker: (environment) => {
      workerEnv = environment;
      return 0;
    },
  }), 0);
  assert.equal(workerEnv?.KXM_WORKER_MODEL, "vendor/primary");
  assert.equal(workerEnv?.KXM_WORKER_FALLBACK_MODELS, "vendor/secondary,vendor/tertiary");
  assert.equal(workerEnv?.KXM_WORKER_INITIAL_CONTINUE, "false");
  assert.equal(workerEnv?.KXM_WORKER_TOOLS, "read,grep,kxm_fanout");
  assert.equal(workerEnv?.KXM_WORKER_SESSION_ISOLATION, "workflow");

  let compatibilityEnv: NodeJS.ProcessEnv | undefined;
  assert.equal(await runCli([
    "agent", "worker", "--name", "legacy", "--project", "product",
  ], { KXM_WORKER_SESSION_ISOLATION: "off" }, {
    ...capture(),
    spawnWorker: (environment) => {
      compatibilityEnv = environment;
      return 0;
    },
  }), 0);
  assert.equal(compatibilityEnv?.KXM_WORKER_SESSION_ISOLATION, "off");

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
  assert.equal(defaultEnv?.KXM_WORKER_SESSION_ISOLATION, "off");

  const invalidIsolation = capture();
  assert.equal(await runCli([
    "agent", "worker", "--name", "coordinator", "--project", "product", "--session-isolation", "shared",
  ], {}, invalidIsolation), 2);
  assert.match(invalidIsolation.read().stderr, /must be workflow or off/);
});

test("kxm dash defaults to the current project instead of a vendor-specific project", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "generic-product-"));
  const requested: string[] = [];
  try {
    const io = capture();
    assert.equal(await runCli(["dash"], {}, {
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
    assert.equal(await runCli(["hub", "--json", "--dry-run", "stop"], {}, stopDry, cwd), 0);
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
    assert.equal(await runCli(["hub", "--json", "--workspace", cwd, "stop"], {}, {
      ...stop,
      sleep: async () => { rmSync(pidPath, { force: true }); },
    }, cwd), 0);
    assert.match(stop.read().stdout, /"stopped":\["hub.pid"\]/);
    const status = capture();
    assert.equal(await runCli(["hub", "--json", "view"], {}, {
      ...status,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }, cwd), 0);
    const signalDry = capture();
    assert.equal(await runCli(
      ["gate", "--json", "--dry-run", "signal", "run_1", "key", "passed", "ok"],
      { KXM_WORKFLOW_ID: "wf", KXM_WORKFLOW_SIGNAL_SECRET: "signal-secret-16chars" },
      signalDry,
      cwd,
    ), 0);
    const signalLive = capture();
    let signalBody = "";
    const signalDeliveryIds: string[] = [];
    assert.equal(await runCli(
      ["gate", "--json", "signal", "run_1", "key", "passed", "ok", " Local   Review =artifact.md", "GitHub.Check:CI=https://ci.example/1"],
      { KXM_WORKFLOW_ID: "wf", KXM_WORKFLOW_SIGNAL_SECRET: "signal-secret-16chars" },
      {
        ...signalLive,
        fetchImpl: async (_input, init) => {
          signalBody = String(init?.body ?? "");
          signalDeliveryIds.push(new Headers(init?.headers).get("x-kxm-delivery-id") ?? "");
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
      { KXM_WORKFLOW_ID: "wf", KXM_WORKFLOW_SIGNAL_SECRET: "signal-secret-16chars" },
      {
        ...capture(),
        fetchImpl: async (_input, init) => {
          signalDeliveryIds.push(new Headers(init?.headers).get("x-kxm-delivery-id") ?? "");
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
    KXM_WORKFLOW_SECRET: "workflow-secret-16chars",
  }, {
    ...start,
    fetchImpl: async (_input, init) => {
      signature = new Headers(init?.headers).get("x-hub-signature-256") ?? "";
      return new Response(JSON.stringify({ run: { id: "run_cli" }, duplicate: false }), { status: 202 });
    },
  }), 0);
  assert.match(start.read().stdout, /"runId":"run_cli"/);
  assert.match(signature, /^sha256=[a-f0-9]{64}$/);
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
  assert.match(review.instructions, /kxm_get to verify each stored message has the exact run, stage, requirement, and attempt binding/);
  assert.match(review.instructions, /kxm_await with that messageId and timeoutMs 120000/);
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
    KXM_AUTH_TOKEN: "admin-secret-token",
    KXM_SERVER_URL: "http://127.0.0.1:7331",
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
      KXM_WORKFLOW_ID: "wf",
      KXM_WORKFLOW_SIGNAL_SECRET: "signal-secret-16chars",
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
    assert.match(outside.read().stderr, /output_outside_workspace_assets/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow list/get use local SQLite state and redact configured secret values", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-mesh-cli-state-"));
  const stateDir = join(cwd, ".kxm", "state");
  const dataPath = join(stateDir, "kxm.db");
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
    const env = { KXM_DATA_PATH: dataPath, KXM_TEST_SECRET: "exact-secret-value" };
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
    assert.equal(await runCli(["hub", "--json", "stop"], {}, capture(), cwd), 1);
    assert.equal(await runCli(["workflow", "--json", "get"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["gate", "--json", "degrade", "run_1", "review"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["workflow", "--json", "start", "wf", "--payload", "[]"], { KXM_WORKFLOW_SECRET: "workflow-secret-16chars" }, capture(), cwd), 2);
    assert.equal(await runCli(["workflow", "--json", "--dry-run", "start", "wf", "--payload", "{}"], { KXM_WORKFLOW_SECRET: "workflow-secret-16chars" }, capture(), cwd), 0);
    assert.equal(await runCli(["gate", "--json", "signal"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["gate", "--json", "signal", "run_1", "key", "invalid", "summary"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["gate", "--json", "signal", "run_1", "key", "passed", "summary"], {}, capture(), cwd), 2);
    assert.equal(await runCli(
      ["gate", "--json", "signal", "run_1", "key", "passed", "summary", "Review=one", " review =two"],
      { KXM_WORKFLOW_ID: "wf", KXM_WORKFLOW_SIGNAL_SECRET: "signal-secret-16chars" },
      capture(),
      cwd,
    ), 2);
    assert.equal(await runCli(["gate", "--json", "github", "nope"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["gate", "--json", "github", "watch"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["workflow", "--json", "nope"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["workflow", "--json", "export"], {}, capture(), cwd), 2);
    assert.equal(await runCli(["workflow", "--json", "export", "run_missing", "--input", join(cwd, "missing.json")], {}, capture(), cwd), 1);
    assert.equal(await runCli(["mesh"], {}, capture(), cwd), 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function makeGitRoot(root: string): void {
  const initialized = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", root], { encoding: "utf8", windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
}

function runNpm(args: string[], cwd: string) {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "npm_execpath is required for the packed-consumer smoke");
  return spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
}

function runOperatorBin(command: string, args: string[], cwd: string) {
  if (process.platform !== "win32") {
    return spawnSync(command, args, { cwd, encoding: "utf8" });
  }
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const commandLine = `"${[command, ...args].map(quote).join(" ")}"`;
  return spawnSync(process.env.ComSpec?.trim() || "cmd.exe", [
    "/d",
    "/s",
    "/v:off",
    "/c",
    commandLine,
  ], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
}

test("packed npm artifact runs the operator CLI and hub outside the repository", { timeout: 480_000 }, async () => {
  const repository = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "pi-mesh-package-install-"));
  const packDirectory = join(root, "pack");
  const consumer = join(root, "consumer");
  const globalPrefix = join(root, "global-prefix");
  const runtime = join(root, "runtime");
  mkdirSync(packDirectory);
  mkdirSync(consumer);
  mkdirSync(globalPrefix);
  mkdirSync(runtime);

  let hub: ReturnType<typeof spawn> | undefined;
  let hubExit: Promise<number | null> | undefined;
  try {
    const packed = runNpm(["pack", "--json", "--pack-destination", packDirectory], repository);
    assert.equal(packed.status, 0, `${packed.stderr}\n${packed.stdout}`);
    const artifacts = JSON.parse(packed.stdout) as Array<{ filename: string }>;
    assert.equal(artifacts.length, 1);
    const filename = artifacts[0]?.filename;
    assert.ok(filename);
    const tarball = join(packDirectory, filename);
    assert.equal(existsSync(tarball), true);

    writeFileSync(join(consumer, "package.json"), `${JSON.stringify({ private: true })}\n`, "utf8");
    const installed = runNpm([
      "install",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      tarball,
    ], consumer);
    assert.equal(installed.status, 0, `${installed.stderr}\n${installed.stdout}`);

    const packageRoot = join(consumer, "node_modules", "@kontextmind", "kxm");
    const cli = spawnSync(process.execPath, [join(packageRoot, "scripts", "kxm.mjs"), "hub", "help"], {
      cwd: consumer,
      encoding: "utf8",
    });
    assert.equal(cli.status, 0, `${cli.stderr}\n${cli.stdout}`);
    assert.match(cli.stdout, /Usage: kxm hub/);
    assert.doesNotMatch(cli.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);

    const installedBin = runNpm(["exec", "--offline", "--", "kxm", "hub", "help"], consumer);
    assert.equal(installedBin.status, 0, `${installedBin.stderr}\n${installedBin.stdout}`);
    assert.match(installedBin.stdout, /Usage: kxm hub/);

    const unknownMesh = spawnSync(process.execPath, [join(packageRoot, "scripts", "kxm.mjs"), "mesh"], {
      cwd: consumer,
      encoding: "utf8",
    });
    assert.equal(unknownMesh.status, 2, `${unknownMesh.stderr}\n${unknownMesh.stdout}`);

    const vnextProject = join(consumer, "vnext-project");
    const packedState = join(consumer, "kxm-state");
    mkdirSync(vnextProject);
    makeGitRoot(vnextProject);
    const vnextInit = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "kxm.mjs"),
      "init",
      "--json",
      "--name",
      "Packed Project",
      "--project-id",
      "prj_01JPACKEDPROJECT00000000000",
    ], { cwd: vnextProject, encoding: "utf8", env: { ...process.env, KXM_STATE_HOME: packedState } });
    assert.equal(vnextInit.status, 0, `${vnextInit.stderr}\n${vnextInit.stdout}`);
    const vnextPayload = JSON.parse(vnextInit.stdout) as { action: string; configRevision: string };
    assert.equal(vnextPayload.action, "created");
    assert.match(vnextPayload.configRevision, /^sha256:[a-f0-9]{64}$/);
    const packedProjectFile = join(vnextProject, ".kxm", "project.yaml");
    assert.equal(existsSync(packedProjectFile), true);
    assert.equal(existsSync(join(vnextProject, ".kxm", "template-provenance.yaml")), true);
    assert.equal(existsSync(join(packageRoot, "schemas", "vnext", "project.schema.json")), true);
    assert.equal(existsSync(join(packageRoot, "schemas", "vnext", "template-provenance.schema.json")), true);
    assert.equal(existsSync(join(packageRoot, "schemas", "vnext", "init-operation.schema.json")), true);
    assert.equal(existsSync(join(packageRoot, "schemas", "vnext", "migration-plan.schema.json")), true);
    assert.equal(existsSync(join(packageRoot, "schemas", "vnext", "migration-decision.schema.json")), true);
    assert.equal(existsSync(join(packageRoot, "schemas", "vnext", "migration-receipt.schema.json")), true);

    const unsupportedWorkspace = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "kxm.mjs"), "--workspace", join(vnextProject, "wrong"), "init", "--json",
    ], { cwd: vnextProject, encoding: "utf8" });
    assert.equal(unsupportedWorkspace.status, 2, `${unsupportedWorkspace.stderr}\n${unsupportedWorkspace.stdout}`);
    assert.match(unsupportedWorkspace.stderr, /workspace_option_unsupported/);

    const packedProjectYaml = readFileSync(packedProjectFile, "utf8");
    writeFileSync(packedProjectFile, packedProjectYaml.replace("pathHint: .", "pathHint: COM¹"));
    const invalidPortablePath = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "kxm.mjs"), "init", "--json",
    ], { cwd: vnextProject, encoding: "utf8" });
    assert.equal(invalidPortablePath.status, 1, `${invalidPortablePath.stderr}\n${invalidPortablePath.stdout}`);
    assert.match(invalidPortablePath.stderr, /schema_pattern/);
    writeFileSync(packedProjectFile, packedProjectYaml);

    const invalidDryRun = join(consumer, "invalid-vnext-project");
    mkdirSync(invalidDryRun);
    makeGitRoot(invalidDryRun);
    const invalidProvisioning = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "kxm.mjs"), "init", "--json", "--dry-run", "--project-id", "invalid",
    ], { cwd: invalidDryRun, encoding: "utf8" });
    assert.equal(invalidProvisioning.status, 1, `${invalidProvisioning.stderr}\n${invalidProvisioning.stdout}`);
    assert.match(invalidProvisioning.stderr, /project_id_invalid/);

    const packedMember = join(consumer, "packed-api");
    mkdirSync(packedMember);
    makeGitRoot(packedMember);
    mkdirSync(join(packedMember, ".kxm", "repo"), { recursive: true });
    writeFileSync(join(packedMember, ".kxm", "repo", "repo.yaml"), [
      "schema: kxm.repository.v1",
      "projectId: prj_01JPACKEDPROJECT00000000000",
      "repositoryId: api",
      "defaultAccess: write",
      "",
    ].join("\n"));
    const joinProjectYaml = packedProjectYaml.replace(
      "    pathHint: .\n",
      "    pathHint: .\n  - id: api\n    role: member\n    required: true\n",
    );
    writeFileSync(packedProjectFile, joinProjectYaml);
    const joinEnvironment = { ...process.env, KXM_STATE_HOME: packedState };
    const packedJoin = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "kxm.mjs"), "init", "--json", "--repository", `api=${packedMember}`,
    ], { cwd: vnextProject, encoding: "utf8", env: joinEnvironment });
    assert.equal(packedJoin.status, 0, `${packedJoin.stderr}\n${packedJoin.stdout}`);
    const packedJoinPayload = JSON.parse(packedJoin.stdout) as { action: string; localBindingFile: string };
    assert.equal(packedJoinPayload.action, "joined");
    assert.match(packedJoinPayload.localBindingFile, /repository-bindings\.json$/);
    const packedProjectStateDirs = readdirSync(join(packedState, "projects"));
    assert.equal(packedProjectStateDirs.length, 1);
    assert.equal(existsSync(join(packedState, "projects", packedProjectStateDirs[0]!, "repository-bindings.json")), true);
    assert.equal(readFileSync(packedProjectFile, "utf8"), joinProjectYaml);
    const packedJoinRepeated = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "kxm.mjs"), "init", "--json",
    ], { cwd: vnextProject, encoding: "utf8", env: joinEnvironment });
    assert.equal(packedJoinRepeated.status, 0, `${packedJoinRepeated.stderr}\n${packedJoinRepeated.stdout}`);
    assert.match(packedJoinRepeated.stdout, /"action":"validated"/);

    // Packed consumer: legacy JSON migration plan/apply/verify round trip.
    const legacyConsumer = join(consumer, "legacy-project");
    mkdirSync(join(legacyConsumer, ".kxm", "config", "workflows"), { recursive: true });
    makeGitRoot(legacyConsumer);
    writeFileSync(join(legacyConsumer, ".kxm", "config", "agents.json"), JSON.stringify({
      schema: "kxm.agents.v1",
      agents: [{ name: "writer", kind: "agent", driver: "ai", purpose: "Writes" }],
    }));
    writeFileSync(join(legacyConsumer, ".kxm", "config", "workflows", "fix.json"), JSON.stringify([{
      id: "fix",
      target: "writer",
      maxTransitions: 4,
      stages: [{
        id: "plan",
        instructions: "Plan the fix.",
        on: { passed: "$terminal", blocked: "$terminal" },
      }],
    }]));
    const migratePlan = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "kxm.mjs"), "migrate", "plan", "--json",
    ], { cwd: legacyConsumer, encoding: "utf8", env: joinEnvironment });
    assert.equal(migratePlan.status, 1, `${migratePlan.stderr}\n${migratePlan.stdout}`);
    const migratePlanPayload = JSON.parse(migratePlan.stderr) as {
      plan: { canApply: boolean; projectId: string; projectName: string; sourceDigest: string; ambiguities: Array<{ key: string; allowedValues: Array<string | number> }> };
    };
    assert.equal(migratePlanPayload.plan.canApply, false);
    const packedResolutions: Record<string, string | number> = {};
    for (const ambiguity of migratePlanPayload.plan.ambiguities) packedResolutions[ambiguity.key] = ambiguity.allowedValues[0]!;
    const packedDecisions = join(legacyConsumer, "decisions.yaml");
    writeFileSync(packedDecisions, [
      "schema: kxm.migration-decision.v1",
      `projectId: ${migratePlanPayload.plan.projectId}`,
      `projectName: ${migratePlanPayload.plan.projectName}`,
      `sourceDigest: ${migratePlanPayload.plan.sourceDigest}`,
      "resolutions:",
      ...Object.entries(packedResolutions).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`),
      "",
    ].join("\n"));
    const migrateApply = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "kxm.mjs"), "migrate", "apply", "--json", "--decisions", packedDecisions,
    ], { cwd: legacyConsumer, encoding: "utf8", env: joinEnvironment });
    assert.equal(migrateApply.status, 0, `${migrateApply.stderr}\n${migrateApply.stdout}`);
    assert.match(migrateApply.stdout, /"action":"applied"/);
    assert.equal(existsSync(join(legacyConsumer, ".kxm", "migration-receipt.yaml")), true);
    const migrateVerify = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "kxm.mjs"), "migrate", "verify", "--json",
    ], { cwd: legacyConsumer, encoding: "utf8", env: joinEnvironment });
    assert.equal(migrateVerify.status, 0, `${migrateVerify.stderr}\n${migrateVerify.stdout}`);
    assert.match(migrateVerify.stdout, /"ok":true/);

    // Packed consumer: trust diff/check against HEAD on the migrated project.
    // Commit the migrated tree first so HEAD is a loadable vNext base, then
    // expand a permission and observe the check fail until committed.
    spawnSync("git", ["-C", legacyConsumer, "add", "-A"], { windowsHide: true });
    const migratedCommit = spawnSync("git", ["-C", legacyConsumer, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "migrated"], { windowsHide: true });
    assert.equal(migratedCommit.status, 0, migratedCommit.stderr as unknown as string);
    const trustClean = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "kxm.mjs"), "trust", "check", "--json",
    ], { cwd: legacyConsumer, encoding: "utf8", env: joinEnvironment });
    assert.equal(trustClean.status, 0, `${trustClean.stderr}\n${trustClean.stdout}`);
    assert.match(trustClean.stdout, /"requiresReview":false/);
    const trustAgentFile = join(legacyConsumer, ".kxm", "agents", "writer.yaml");
    writeFileSync(trustAgentFile, readFileSync(trustAgentFile, "utf8").replace("network: provider-only", "network: host"), "utf8");
    const trustExpanded = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "kxm.mjs"), "trust", "check", "--json",
    ], { cwd: legacyConsumer, encoding: "utf8", env: joinEnvironment });
    assert.equal(trustExpanded.status, 1, `${trustExpanded.stderr}\n${trustExpanded.stdout}`);
    assert.match(trustExpanded.stderr, /"requiresReview":true/);
    spawnSync("git", ["-C", legacyConsumer, "add", "-A"], { windowsHide: true });
    const trustCommit = spawnSync("git", ["-C", legacyConsumer, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "grant host network"], { windowsHide: true });
    assert.equal(trustCommit.status, 0, trustCommit.stderr as unknown as string);
    const trustCommitted = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "kxm.mjs"), "trust", "check", "--json",
    ], { cwd: legacyConsumer, encoding: "utf8", env: joinEnvironment });
    assert.equal(trustCommitted.status, 0, `${trustCommitted.stderr}\n${trustCommitted.stdout}`);
    assert.match(trustCommitted.stdout, /"requiresReview":false/);
    assert.equal(existsSync(join(packageRoot, "schemas", "vnext", "permission-diff.schema.json")), true);

    // Packed consumer: vNext run lifecycle with an auto-started supervisor.
    const packedRun = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "kxm.mjs"), "run", "fix", "--json", "smoke the runtime",
    ], { cwd: legacyConsumer, encoding: "utf8", env: joinEnvironment, timeout: 120_000 });
    assert.equal(packedRun.status, 0, `${packedRun.stderr}\n${packedRun.stdout}`);
    const packedRunPayload = JSON.parse(packedRun.stdout) as { run: { runId: string; status: string }; supervisor: { started: boolean } };
    assert.equal(packedRunPayload.run.status, "created");
    assert.equal(packedRunPayload.supervisor.started, true);
    assert(!packedRun.stdout.includes("smoke the runtime"), "prompt content never appears in output");
    const packedRunsList = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "kxm.mjs"), "runs", "list", "--json",
    ], { cwd: legacyConsumer, encoding: "utf8", env: joinEnvironment, timeout: 60_000 });
    assert.equal(packedRunsList.status, 0, `${packedRunsList.stderr}\n${packedRunsList.stdout}`);
    assert.match(packedRunsList.stdout, new RegExp(packedRunPayload.run.runId));
    const packedCancel = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "kxm.mjs"), "runs", "cancel", packedRunPayload.run.runId, "--json",
    ], { cwd: legacyConsumer, encoding: "utf8", env: joinEnvironment, timeout: 60_000 });
    assert.equal(packedCancel.status, 0, `${packedCancel.stderr}\n${packedCancel.stdout}`);
    assert.match(packedCancel.stdout, /"status":"cancelled"/);
    const packedStop = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "kxm.mjs"), "runtime", "stop", "--json",
    ], { cwd: legacyConsumer, encoding: "utf8", env: joinEnvironment, timeout: 60_000 });
    assert.equal(packedStop.status, 0, `${packedStop.stderr}\n${packedStop.stdout}`);
    assert.equal(existsSync(join(packageRoot, "plugins", "kxm", "dist", "vnext-runtime-supervisor.js")), true);

    const globalInstall = runNpm([
      "install",
      "--global",
      "--omit=peer",
      "--no-audit",
      "--no-fund",
      "--prefix",
      globalPrefix,
      tarball,
    ], consumer);
    assert.equal(globalInstall.status, 0, `${globalInstall.stderr}\n${globalInstall.stdout}`);
    const operatorBin = process.platform === "win32"
      ? join(globalPrefix, "kxm.cmd")
      : join(globalPrefix, "bin", "kxm");
    assert.equal(existsSync(operatorBin), true);
    const globalCli = runOperatorBin(operatorBin, ["hub", "help"], consumer);
    assert.equal(globalCli.status, 0, `${globalCli.stderr}\n${globalCli.stdout}`);
    assert.match(globalCli.stdout, /Usage: kxm hub/);

    const environment = { ...process.env };
    for (const key of [
      "KXM_WORKSPACE_DIR",
      "KXM_CONFIG_DIR",
      "KXM_LOGS_DIR",
      "KXM_ASSETS_DIR",
      "KXM_STATE_DIR",
      "KXM_DATA_PATH",
      "KXM_LOG_PATH",
      "KXM_WEBHOOK_WORKFLOWS",
      "KXM_WEBHOOK_WORKFLOWS_FILE",
    ]) delete environment[key];
    Object.assign(environment, {
      KXM_HOST: "127.0.0.1",
      KXM_PORT: "0",
      KXM_AUTH_TOKEN: "packed-consumer-test-token",
    });
    hub = spawn(process.execPath, [join(packageRoot, "scripts", "kxm-hub.mjs")], {
      cwd: runtime,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    hub.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    hub.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    hubExit = new Promise((resolveExit) => hub!.once("exit", resolveExit));
    const url = await new Promise<string>((resolveUrl, reject) => {
      const timeout = setTimeout(() => reject(new Error(`packed hub did not start: ${stdout}\n${stderr}`)), 10_000);
      const inspect = () => {
        const match = stdout.match(/kxm hub listening at (http:\/\/[^;]+);/);
        if (!match) return;
        clearTimeout(timeout);
        resolveUrl(match[1]!);
      };
      hub!.stdout!.on("data", inspect);
      hub!.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`packed hub exited before startup with ${code}: ${stderr}`));
      });
    });
    assert.equal((await fetch(`${url}/ready`)).status, 200);
    const stateDirectory = join(runtime, ".kxm", "state");
    const record = JSON.parse(readFileSync(join(stateDirectory, "hub.pid"), "utf8")) as { startedAt: string };
    writeFileSync(join(stateDirectory, "hub.stop"), JSON.stringify({
      startedAt: record.startedAt,
      requestedAt: new Date().toISOString(),
    }));
    assert.equal(await hubExit, 0);
    assert.equal(stderr, "");
    assert.match(readFileSync(join(runtime, ".kxm", "logs", "kxm-hub.jsonl"), "utf8"), /"event":"hub_stopping"/);
  } finally {
    if (hub?.exitCode === null) hub.kill("SIGKILL");
    if (hubExit) await hubExit;
    rmSync(root, { recursive: true, force: true });
  }
});

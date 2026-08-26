import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

test("packed npm artifact runs the operator CLI and hub outside the repository", { timeout: 240_000 }, async () => {
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

    const packageRoot = join(consumer, "node_modules", "@kontextmind", "pi-extensions");
    const cli = spawnSync(process.execPath, [join(packageRoot, "scripts", "pi-mesh.mjs"), "help"], {
      cwd: consumer,
      encoding: "utf8",
    });
    assert.equal(cli.status, 0, `${cli.stderr}\n${cli.stdout}`);
    assert.match(cli.stdout, /Usage: pi-mesh/);
    assert.doesNotMatch(cli.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);

    const installedBin = runNpm(["exec", "--offline", "--", "pi-mesh", "help"], consumer);
    assert.equal(installedBin.status, 0, `${installedBin.stderr}\n${installedBin.stdout}`);
    assert.match(installedBin.stdout, /Usage: pi-mesh/);

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
      ? join(globalPrefix, "pi-mesh.cmd")
      : join(globalPrefix, "bin", "pi-mesh");
    assert.equal(existsSync(operatorBin), true);
    const globalCli = runOperatorBin(operatorBin, ["help"], consumer);
    assert.equal(globalCli.status, 0, `${globalCli.stderr}\n${globalCli.stdout}`);
    assert.match(globalCli.stdout, /Usage: pi-mesh/);

    const dryRun = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "pi-mesh.mjs"),
      "--dry-run",
      "--json",
      "init",
    ], { cwd: consumer, encoding: "utf8" });
    assert.equal(dryRun.status, 0, `${dryRun.stderr}\n${dryRun.stdout}`);
    const dryRunPayload = JSON.parse(dryRun.stdout) as {
      ok: boolean;
      command: string;
      created: string[];
      templates: boolean;
    };
    assert.deepEqual(dryRunPayload, {
      ok: true,
      command: "init",
      created: [
        join(consumer, ".kxm", "config"),
        join(consumer, ".kxm", "logs"),
        join(consumer, ".kxm", "assets"),
        join(consumer, ".kxm", "state"),
        join(consumer, ".kxm", "assets", "retrospectives"),
      ],
      templates: true,
    });

    const environment = { ...process.env };
    for (const key of [
      "PI_MESH_WORKSPACE_DIR",
      "PI_MESH_CONFIG_DIR",
      "PI_MESH_LOGS_DIR",
      "PI_MESH_ASSETS_DIR",
      "PI_MESH_STATE_DIR",
      "PI_MESH_DATA_PATH",
      "PI_MESH_LOG_PATH",
      "PI_MESH_WEBHOOK_WORKFLOWS",
      "PI_MESH_WEBHOOK_WORKFLOWS_FILE",
    ]) delete environment[key];
    Object.assign(environment, {
      PI_MESH_HOST: "127.0.0.1",
      PI_MESH_PORT: "0",
      PI_MESH_AUTH_TOKEN: "packed-consumer-test-token",
    });
    hub = spawn(process.execPath, [join(packageRoot, "scripts", "pi-mesh-hub.mjs")], {
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
        const match = stdout.match(/pi-mesh hub listening at (http:\/\/[^;]+);/);
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
    assert.match(readFileSync(join(runtime, ".kxm", "logs", "pi-mesh-hub.jsonl"), "utf8"), /"event":"hub_stopping"/);
  } finally {
    if (hub?.exitCode === null) hub.kill("SIGKILL");
    if (hubExit) await hubExit;
    rmSync(root, { recursive: true, force: true });
  }
});

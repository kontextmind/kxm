import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli as runCliImplementation, type CliIo, type CliSpawnResult } from "../../plugins/kxm/src/cli.ts";
import { noticeFromVersions, writeUpdateCache } from "../../plugins/kxm/src/kxm-update.ts";
import type { InstallProbe } from "../../plugins/kxm/src/kxm-install-kind.ts";

const currentVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
const DEFAULT_DIGEST = "a".repeat(64);
const TARBALL_BODY = "not a tarball\n";

async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo, cwd: string): Promise<number> {
  const isolatedLogs = mkdtempSync(join(tmpdir(), "kxm-update-cli-logs-"));
  try {
    return await runCliImplementation(argv, { KXM_LOGS_DIR: isolatedLogs, KXM_STATE_HOME: isolatedLogs, ...env }, io, cwd);
  } finally {
    rmSync(isolatedLogs, { recursive: true, force: true });
  }
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

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "kxm-update-cli-"));
  mkdirSync(join(root, ".kxm"), { recursive: true });
  return root;
}

function writeProjectUpdateYaml(root: string, body: string): void {
  mkdirSync(join(root, ".kxm"), { recursive: true });
  writeFileSync(join(root, ".kxm", "update.yaml"), body);
}

function writeUserUpdateYaml(stateHome: string, body: string): void {
  mkdirSync(stateHome, { recursive: true });
  writeFileSync(join(stateHome, "update.yaml"), body);
}

function fakeNpmGlobal(): {
  root: string;
  pkgRoot: string;
  npmRoot: string;
  probe: Partial<InstallProbe>;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "kxm-npm-global-"));
  const pkgRoot = join(root, "node_modules", "@kontextmind", "kxm");
  mkdirSync(join(pkgRoot, "plugins", "kxm", "dist"), { recursive: true });
  writeFileSync(join(pkgRoot, "package.json"), `${JSON.stringify({ name: "@kontextmind/kxm", version: "0.0.1" })}\n`);
  return {
    root,
    pkgRoot,
    npmRoot: join(root, "node_modules"),
    probe: {
      moduleDir: join(pkgRoot, "plugins", "kxm", "dist"),
      repoRoot: pkgRoot,
      homeDir: root,
      platform: process.platform,
      env: {},
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function npmGlobalSpawn(
  npmRoot: string,
  handlers: {
    gh?: (args: readonly string[]) => CliSpawnResult;
    npmInstall?: (args: readonly string[]) => CliSpawnResult;
  } = {},
): { spawnSync: NonNullable<CliIo["spawnSync"]>; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === "npm" && args[0] === "root" && args[1] === "-g") {
        return { status: 0, stdout: `${npmRoot}\n`, stderr: "" };
      }
      if (command === "gh") return handlers.gh?.(args) ?? { status: 0, stdout: "", stderr: "" };
      if (command === "npm" && args.includes("install")) {
        return handlers.npmInstall?.(args) ?? { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: `unexpected spawn ${command}` };
    },
  };
}

function withGlobal(io: ReturnType<typeof capture>, fake: ReturnType<typeof fakeNpmGlobal>, extra: Partial<CliIo> = {}): CliIo {
  return {
    ...io,
    installProbe: fake.probe,
    spawnSync: npmGlobalSpawn(fake.npmRoot).spawnSync,
    ...extra,
  };
}

function releaseFetch(tag = "v99.0.0", sha256: string | null = DEFAULT_DIGEST): NonNullable<CliIo["fetchImpl"]> {
  const version = tag.replace(/^v/, "");
  const assets = sha256 === null
    ? [{ name: `kxm-${version}.tgz` }]
    : [{ name: `kxm-${version}.tgz`, digest: `sha256:${sha256}` }];
  return async (input) => {
    const url = String(input);
    if (url.includes("api.github.com/repos/kontextmind/kxm/releases/latest")) {
      return new Response(JSON.stringify({ tag_name: tag, assets }), { status: 200 });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

function githubFetch(tag = "v99.0.0", status = 200): NonNullable<CliIo["fetchImpl"]> {
  const version = tag.replace(/^v/, "");
  return async (input) => {
    const url = String(input);
    if (url.includes("api.github.com/repos/kontextmind/kxm/releases/latest")) {
      return new Response(JSON.stringify({
        tag_name: tag,
        assets: [{ name: `kxm-${version}.tgz`, digest: `sha256:${DEFAULT_DIGEST}` }],
      }), { status });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

function npmFetch(version = "99.0.0", status = 200): NonNullable<CliIo["fetchImpl"]> {
  return async (input) => {
    const url = String(input);
    if (url.includes("registry.npmjs.org/@kontextmind/kxm/latest")) {
      return new Response(JSON.stringify({ version }), { status });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

function existsUpdateCache(dir: string): boolean {
  try {
    readFileSync(join(dir, "update-check.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

function existsProjectUpdateCache(cwd: string): boolean {
  try {
    readFileSync(join(cwd, ".kxm", "state", "update-check.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

function writeGhTarball(args: readonly string[], body = TARBALL_BODY): CliSpawnResult {
  const dir = args[args.indexOf("--dir") + 1];
  const pattern = args[args.indexOf("--pattern") + 1] ?? "kxm-99.0.0.tgz";
  if (!dir) return { status: 1, stdout: "", stderr: "missing --dir" };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, pattern), body);
  return { status: 0, stdout: "", stderr: "" };
}

test("update --check reports a newer GitHub release", async () => {
  const cwd = tempProject();
  const fake = fakeNpmGlobal();
  const stateHome = mkdtempSync(join(tmpdir(), "kxm-update-check-state-"));
  try {
    const io = capture();
    assert.equal(await runCli(["update", "--json", "--check"], { KXM_STATE_HOME: stateHome }, withGlobal(io, fake, { fetchImpl: githubFetch("v99.0.0") }), cwd), 0);
    const payload = JSON.parse(io.read().stdout) as {
      command: string;
      available: boolean;
      current: string;
      latest: string;
      source: string;
    };
    assert.equal(payload.command, "update check");
    assert.equal(payload.current, currentVersion);
    assert.equal(payload.latest, "99.0.0");
    assert.equal(payload.available, true);
    assert.equal(payload.source, "github");
    assert.match(io.read().stdout, /kxm update --kxm/);
    assert.equal(existsUpdateCache(stateHome), true);
    assert.equal(existsProjectUpdateCache(cwd), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
    fake.cleanup();
  }
});

test("update --check stays quiet when already current or the check fails", async () => {
  const cwd = tempProject();
  const fake = fakeNpmGlobal();
  try {
    const current = capture();
    assert.equal(await runCli(["update", "--json", "--check"], {}, withGlobal(current, fake, {
      fetchImpl: githubFetch(`v${currentVersion}`),
    }), cwd), 0);
    const currentPayload = JSON.parse(current.read().stdout) as { available: boolean; message: string };
    assert.equal(currentPayload.available, false);
    assert.equal(currentPayload.message, `kxm ${currentVersion}`);

    const failed = capture();
    assert.equal(await runCli(["update", "--json", "--check"], {}, withGlobal(failed, fake, {
      fetchImpl: githubFetch("v99.0.0", 503),
    }), cwd), 0);
    assert.match(failed.read().stdout, /kxm update check unavailable \(github_http_503\)/);

    const nonSemver = capture();
    assert.equal(await runCli(["update", "--json", "--check"], {}, withGlobal(nonSemver, fake, {
      fetchImpl: githubFetch("not-a-version"),
    }), cwd), 0);
    assert.match(nonSemver.read().stdout, /kxm update check unavailable/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    fake.cleanup();
  }
});

test("update --check uses npm when update.yaml selects it", async () => {
  const cwd = tempProject();
  const fake = fakeNpmGlobal();
  const stateHome = mkdtempSync(join(tmpdir(), "kxm-update-state-"));
  try {
    writeUserUpdateYaml(stateHome, "schema: kxm.update.v1\nauto: false\nsource: npm\n");
    const io = capture();
    assert.equal(await runCli(["update", "--json", "--check"], { KXM_STATE_HOME: stateHome }, withGlobal(io, fake, { fetchImpl: npmFetch("99.1.0") }), cwd), 0);
    const payload = JSON.parse(io.read().stdout) as { source: string; latest: string; available: boolean };
    assert.equal(payload.source, "npm");
    assert.equal(payload.latest, "99.1.0");
    assert.equal(payload.available, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
    fake.cleanup();
  }
});

test("update rejects conflicting flags and invalid update.yaml", async () => {
  const cwd = tempProject();
  const fake = fakeNpmGlobal();
  const stateHome = mkdtempSync(join(tmpdir(), "kxm-update-state-"));
  try {
    const checkKxm = capture();
    assert.equal(await runCli(["update", "--json", "--check", "--kxm"], {}, withGlobal(checkKxm, fake, { fetchImpl: githubFetch() }), cwd), 2);
    assert.match(checkKxm.read().stderr, /scope_conflict/);

    const twoScopes = capture();
    assert.equal(await runCli(["update", "--json", "--self", "--models"], {}, withGlobal(twoScopes, fake, { fetchImpl: githubFetch() }), cwd), 2);
    assert.match(twoScopes.read().stderr, /scope_conflict/);

    writeUserUpdateYaml(stateHome, "schema: kxm.update.v1\nauto: maybe\n");
    const invalid = capture();
    assert.equal(await runCli(["update", "--json", "--check"], { KXM_STATE_HOME: stateHome }, withGlobal(invalid, fake, { fetchImpl: githubFetch() }), cwd), 2);
    assert.match(invalid.read().stderr, /kxm_update_config_invalid/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
    fake.cleanup();
  }
});

test("update --kxm dry-run plans a GitHub tarball install and skips harnesses", async () => {
  const cwd = tempProject();
  const fake = fakeNpmGlobal();
  try {
    const io = capture();
    assert.equal(await runCli(["update", "--json", "--dry-run", "--kxm"], {}, withGlobal(io, fake, { fetchImpl: githubFetch("v99.0.0") }), cwd), 0);
    const payload = JSON.parse(io.read().stdout) as {
      command: string;
      dryRun: boolean;
      notice: { available: boolean; latest: string };
      kxm: { ok: boolean; detail: string };
      steps?: unknown;
      installKind: string;
    };
    assert.equal(payload.command, "update");
    assert.equal(payload.dryRun, true);
    assert.equal(payload.notice.available, true);
    assert.equal(payload.kxm.ok, true);
    assert.equal(payload.installKind, "npm-global");
    assert.match(payload.kxm.detail, /gh release download v99\.0\.0/);
    assert.match(payload.kxm.detail, /kxm-99\.0\.0\.tgz/);
    assert.equal(payload.steps, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    fake.cleanup();
  }
});

test("update --kxm dry-run is a no-op when no package update is available", async () => {
  const cwd = tempProject();
  const fake = fakeNpmGlobal();
  try {
    const io = capture();
    assert.equal(await runCli(["update", "--json", "--dry-run", "--kxm"], {}, withGlobal(io, fake, {
      fetchImpl: githubFetch(`v${currentVersion}`),
    }), cwd), 0);
    const payload = JSON.parse(io.read().stdout) as { kxm?: unknown; notice: { available: boolean; message: string } };
    assert.equal(payload.notice.available, false);
    assert.equal(payload.kxm, undefined);
    assert.equal(payload.notice.message, `kxm ${currentVersion}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    fake.cleanup();
  }
});

test("update dry-run with auto applies kxm then still plans harness updates", async () => {
  const cwd = tempProject();
  const fake = fakeNpmGlobal();
  const stateHome = mkdtempSync(join(tmpdir(), "kxm-update-state-"));
  try {
    writeUserUpdateYaml(stateHome, "schema: kxm.update.v1\nauto: true\nsource: github\n");
    const io = capture();
    assert.equal(await runCli(["update", "--json", "--dry-run"], { KXM_STATE_HOME: stateHome }, withGlobal(io, fake, { fetchImpl: githubFetch("v99.0.0") }), cwd), 0);
    const payload = JSON.parse(io.read().stdout) as {
      notice: { auto: boolean; available: boolean };
      kxm: { ok: boolean; detail: string };
      steps: unknown[];
      scope: string;
    };
    assert.equal(payload.notice.auto, true);
    assert.equal(payload.notice.available, true);
    assert.match(payload.kxm.detail, /gh release download/);
    assert.equal(payload.scope, "all");
    assert.ok(Array.isArray(payload.steps));
    assert.match(io.read().stdout, /kxm update --kxm \(auto\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
    fake.cleanup();
  }
});

test("update dry-run unknown harness is fail-closed", async () => {
  const cwd = tempProject();
  const fake = fakeNpmGlobal();
  try {
    const io = capture();
    assert.equal(await runCli(["update", "--json", "--dry-run", "not-a-harness"], {}, withGlobal(io, fake, {
      fetchImpl: githubFetch(`v${currentVersion}`),
    }), cwd), 2);
    const payload = JSON.parse(io.read().stderr) as { ok: boolean; steps: Array<{ detail?: string }> };
    assert.equal(payload.ok, false);
    assert.ok(payload.steps.some((step) => step.detail === "unknown_harness"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    fake.cleanup();
  }
});

test("update --kxm dry-run plans npm install when source is npm", async () => {
  const cwd = tempProject();
  const fake = fakeNpmGlobal();
  const stateHome = mkdtempSync(join(tmpdir(), "kxm-update-state-"));
  try {
    writeUserUpdateYaml(stateHome, "schema: kxm.update.v1\nauto: false\nsource: npm\n");
    const io = capture();
    assert.equal(await runCli(["update", "--json", "--dry-run", "--kxm"], { KXM_STATE_HOME: stateHome }, withGlobal(io, fake, { fetchImpl: npmFetch("99.0.0") }), cwd), 0);
    const payload = JSON.parse(io.read().stdout) as { kxm: { detail: string }; notice: { source: string } };
    assert.equal(payload.notice.source, "npm");
    assert.match(payload.kxm.detail, /@kontextmind\/kxm@99\.0\.0/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
    fake.cleanup();
  }
});

test("update --kxm refuses a tarball whose sha256 does not match the release digest", async () => {
  const cwd = tempProject();
  const fake = fakeNpmGlobal();
  try {
    let releaseDir = "";
    const mismatch = npmGlobalSpawn(fake.npmRoot, {
      gh: (args) => {
        releaseDir = String(args[args.indexOf("--dir") + 1] ?? "");
        return writeGhTarball(args);
      },
      npmInstall: () => {
        assert.fail("npm install must not run after a digest mismatch");
      },
    });
    const mismatchIo = capture();
    assert.equal(await runCli(["update", "--json", "--kxm"], {}, withGlobal(mismatchIo, fake, {
      fetchImpl: releaseFetch("v99.0.0", "0".repeat(64)),
      spawnSync: mismatch.spawnSync,
    }), cwd), 1);
    const mismatchPayload = JSON.parse(mismatchIo.read().stderr) as { ok: boolean; error?: string; kxm?: { ok: boolean } };
    assert.equal(mismatchPayload.ok, false);
    assert.equal(mismatchPayload.error, "release_digest_mismatch");
    assert.equal(mismatchPayload.kxm?.ok, false);
    assert.equal(releaseDir.length > 0, true);
    assert.equal(existsSync(releaseDir), false);

    const missing = npmGlobalSpawn(fake.npmRoot, {
      gh: () => {
        assert.fail("gh must not run when the release digest is missing");
      },
    });
    const missingIo = capture();
    assert.equal(await runCli(["update", "--json", "--kxm"], {}, withGlobal(missingIo, fake, {
      fetchImpl: releaseFetch("v99.0.0", null),
      spawnSync: missing.spawnSync,
    }), cwd), 1);
    const missingPayload = JSON.parse(missingIo.read().stderr) as { ok: boolean; error?: string };
    assert.equal(missingPayload.ok, false);
    assert.equal(missingPayload.error, "release_digest_missing");
    assert.equal(missing.calls.some((call) => call.command === "gh"), false);

    const digest = createHash("sha256").update(TARBALL_BODY).digest("hex");
    const match = npmGlobalSpawn(fake.npmRoot, {
      gh: (args) => writeGhTarball(args),
    });
    const matchIo = capture();
    assert.equal(await runCli(["update", "--json", "--kxm"], {}, withGlobal(matchIo, fake, {
      fetchImpl: releaseFetch("v99.0.0", digest),
      spawnSync: match.spawnSync,
    }), cwd), 0);
    const installCalls = match.calls.filter((call) => call.command === "npm" && call.args.includes("install"));
    assert.equal(installCalls.length, 1);
    assert.ok(installCalls[0]?.args.some((arg) => arg.endsWith("kxm-99.0.0.tgz")));

    const failedInstall = npmGlobalSpawn(fake.npmRoot, {
      gh: (args) => writeGhTarball(args),
      npmInstall: () => ({ status: 1, stdout: "", stderr: "npm install failed" }),
    });
    const failedIo = capture();
    assert.equal(await runCli(["update", "--json", "--kxm"], {}, withGlobal(failedIo, fake, {
      fetchImpl: releaseFetch("v99.0.0", digest),
      spawnSync: failedInstall.spawnSync,
    }), cwd), 1);
    const failedPayload = JSON.parse(failedIo.read().stderr) as { ok: boolean; kxm?: { ok: boolean; detail: string } };
    assert.equal(failedPayload.ok, false);
    assert.equal(failedPayload.kxm?.ok, false);
    assert.ok((failedPayload.kxm?.detail ?? "").length > 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    fake.cleanup();
  }
});

test("update --kxm fails closed when kxm is not an npm global install", async () => {
  const cwd = tempProject();
  const home = mkdtempSync(join(tmpdir(), "kxm-kind-cli-"));
  try {
    const piRoot = join(home, ".pi", "agent", "git", "github.com", "kontextmind", "kxm");
    mkdirSync(join(piRoot, ".git"), { recursive: true });
    writeFileSync(join(piRoot, "package.json"), `${JSON.stringify({ name: "@kontextmind/kxm", version: "0.0.1" })}\n`);
    const piIo = capture();
    const piSpawn = npmGlobalSpawn(join(home, "node_modules"));
    assert.equal(await runCli(["update", "--json", "--kxm"], {}, {
      ...piIo,
      fetchImpl: releaseFetch(),
      installProbe: {
        moduleDir: join(piRoot, "plugins", "kxm", "dist"),
        repoRoot: piRoot,
        homeDir: home,
        platform: process.platform,
        env: {},
      },
      spawnSync: piSpawn.spawnSync,
    }, cwd), 2);
    const piPayload = JSON.parse(piIo.read().stderr) as { error: string; instruction: string };
    assert.equal(piPayload.error, "install_kind_pi-git");
    assert.match(piPayload.instruction, /pi update/);
    assert.equal(piSpawn.calls.length, 0);

    const marketDir = join(home, ".claude", "plugins", "cache", "kxm", "kxm", "0.0.1", "dist");
    mkdirSync(marketDir, { recursive: true });
    const marketIo = capture();
    assert.equal(await runCli(["update", "--json", "--kxm"], {}, {
      ...marketIo,
      fetchImpl: releaseFetch(),
      installProbe: {
        moduleDir: marketDir,
        repoRoot: join(home, ".claude", "plugins", "cache", "kxm", "kxm"),
        homeDir: home,
        platform: process.platform,
        env: {},
      },
    }, cwd), 2);
    const marketPayload = JSON.parse(marketIo.read().stderr) as { error: string; instruction: string };
    assert.equal(marketPayload.error, "install_kind_claude-marketplace");
    assert.match(marketPayload.instruction, /claude plugin update kxm@kxm/);

    const fake = fakeNpmGlobal();
    try {
      const localIo = capture();
      const localSpawn = npmGlobalSpawn(join(home, "other-global", "node_modules"));
      assert.equal(await runCli(["update", "--json", "--kxm"], {}, withGlobal(localIo, fake, {
        fetchImpl: releaseFetch(),
        spawnSync: localSpawn.spawnSync,
      }), cwd), 2);
      const localPayload = JSON.parse(localIo.read().stderr) as { error: string };
      assert.equal(localPayload.error, "install_kind_npm-local");
    } finally {
      fake.cleanup();
    }

    const unknownRoot = mkdtempSync(join(home, "plain-"));
    writeFileSync(join(unknownRoot, "package.json"), `${JSON.stringify({ name: "@kontextmind/kxm", version: "0.0.1" })}\n`);
    const unknownIo = capture();
    assert.equal(await runCli(["update", "--json", "--kxm"], {}, {
      ...unknownIo,
      fetchImpl: releaseFetch(),
      installProbe: {
        moduleDir: join(unknownRoot, "dist"),
        repoRoot: unknownRoot,
        homeDir: home,
        platform: process.platform,
        env: {},
      },
    }, cwd), 2);
    const unknownPayload = JSON.parse(unknownIo.read().stderr) as { error: string };
    assert.equal(unknownPayload.error, "install_kind_unknown");

    const sourceCwd = tempProject();
    const sourceRoot = mkdtempSync(join(tmpdir(), "kxm-source-root-"));
    try {
      mkdirSync(join(sourceRoot, ".git"));
      writeFileSync(join(sourceRoot, "package.json"), `${JSON.stringify({ name: "@kontextmind/kxm", version: "0.0.1" })}\n`);
      const sourceProbe = {
        moduleDir: join(sourceRoot, "plugins", "kxm", "dist"),
        repoRoot: sourceRoot,
        homeDir: home,
        platform: process.platform,
        env: {},
      };
      const sourceCheck = capture();
      let sourceFetch = 0;
      assert.equal(await runCli(["update", "--json", "--check"], {}, {
        ...sourceCheck,
        installProbe: sourceProbe,
        fetchImpl: async () => {
          sourceFetch += 1;
          throw new Error("source check must not fetch");
        },
      }, sourceCwd), 0);
      assert.equal(sourceFetch, 0);
      const sourcePayload = JSON.parse(sourceCheck.read().stdout) as { installKind: string; message: string };
      assert.equal(sourcePayload.installKind, "source");
      assert.match(sourcePayload.message, /running from source/);
      assert.equal(existsProjectUpdateCache(sourceCwd), false);

      const availableNotice = noticeFromVersions(currentVersion, "99.0.0", {
        schema: "kxm.update.v1",
        auto: false,
        source: "github",
      });
      writeUpdateCache(join(sourceCwd, ".kxm", "state"), availableNotice);
      const hubIo = capture();
      assert.equal(await runCli(["hub", "start"], {}, {
        ...hubIo,
        installProbe: sourceProbe,
        spawnHub: () => 0,
        fetchImpl: async () => {
          throw new Error("source hub start must not fetch");
        },
      }, sourceCwd), 0);
      assert.equal(hubIo.read().stderr, "");
    } finally {
      rmSync(sourceCwd, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("update --kxm refuses unsupported kinds when current or the release check fails", async () => {
  const cwd = tempProject();
  const home = mkdtempSync(join(tmpdir(), "kxm-kind-current-"));
  try {
    const piRoot = join(home, ".pi", "agent", "git", "github.com", "kontextmind", "kxm");
    mkdirSync(join(piRoot, ".git"), { recursive: true });
    writeFileSync(join(piRoot, "package.json"), `${JSON.stringify({ name: "@kontextmind/kxm", version: "0.0.1" })}\n`);
    const piIo = capture();
    const piSpawn = npmGlobalSpawn(join(home, "node_modules"));
    assert.equal(await runCli(["update", "--json", "--kxm"], {}, {
      ...piIo,
      fetchImpl: releaseFetch(`v${currentVersion}`),
      installProbe: {
        moduleDir: join(piRoot, "plugins", "kxm", "dist"),
        repoRoot: piRoot,
        homeDir: home,
        platform: process.platform,
        env: {},
      },
      spawnSync: piSpawn.spawnSync,
    }, cwd), 2);
    const piPayload = JSON.parse(piIo.read().stderr) as { error: string; notice?: { available: boolean } };
    assert.equal(piPayload.error, "install_kind_pi-git");
    assert.equal(piPayload.notice?.available, false);
    assert.equal(piSpawn.calls.some((call) => call.command === "gh"), false);
    assert.equal(piSpawn.calls.some((call) => call.command === "npm" && call.args.includes("install")), false);

    const unknownRoot = mkdtempSync(join(home, "plain-"));
    writeFileSync(join(unknownRoot, "package.json"), `${JSON.stringify({ name: "@kontextmind/kxm", version: "0.0.1" })}\n`);
    const unknownCurrent = capture();
    const unknownCurrentSpawn = npmGlobalSpawn(join(home, "node_modules"));
    assert.equal(await runCli(["update", "--json", "--kxm"], {}, {
      ...unknownCurrent,
      fetchImpl: releaseFetch(`v${currentVersion}`),
      installProbe: {
        moduleDir: join(unknownRoot, "dist"),
        repoRoot: unknownRoot,
        homeDir: home,
        platform: process.platform,
        env: {},
      },
      spawnSync: unknownCurrentSpawn.spawnSync,
    }, cwd), 2);
    const unknownCurrentPayload = JSON.parse(unknownCurrent.read().stderr) as { error: string };
    assert.equal(unknownCurrentPayload.error, "install_kind_unknown");
    assert.equal(unknownCurrentSpawn.calls.some((call) => call.command === "gh"), false);
    assert.equal(unknownCurrentSpawn.calls.some((call) => call.command === "npm" && call.args.includes("install")), false);

    const unknownOffline = capture();
    const unknownOfflineSpawn = npmGlobalSpawn(join(home, "node_modules"));
    assert.equal(await runCli(["update", "--json", "--kxm"], {}, {
      ...unknownOffline,
      fetchImpl: async () => {
        throw new Error("network down");
      },
      installProbe: {
        moduleDir: join(unknownRoot, "dist"),
        repoRoot: unknownRoot,
        homeDir: home,
        platform: process.platform,
        env: {},
      },
      spawnSync: unknownOfflineSpawn.spawnSync,
    }, cwd), 2);
    const unknownOfflinePayload = JSON.parse(unknownOffline.read().stderr) as {
      error: string;
      notice?: { available: boolean; message: string };
    };
    assert.equal(unknownOfflinePayload.error, "install_kind_unknown");
    assert.equal(unknownOfflinePayload.notice?.available, false);
    assert.match(unknownOfflinePayload.notice?.message ?? "", /unreachable/);
    assert.equal(unknownOfflineSpawn.calls.some((call) => call.command === "gh"), false);
    assert.equal(unknownOfflineSpawn.calls.some((call) => call.command === "npm" && call.args.includes("install")), false);

    const fakeLocal = fakeNpmGlobal();
    try {
      const checkIo = capture();
      const checkSpawn = npmGlobalSpawn(join(home, "other-global", "node_modules"));
      assert.equal(await runCli(["update", "--json", "--check"], {}, withGlobal(checkIo, fakeLocal, {
        fetchImpl: releaseFetch(`v${currentVersion}`),
        spawnSync: checkSpawn.spawnSync,
      }), cwd), 0);
      const checkPayload = JSON.parse(checkIo.read().stdout) as { installKind: string };
      assert.equal(checkPayload.installKind, "npm-package");
      assert.notEqual(checkPayload.installKind, "npm-global");
      assert.equal(checkSpawn.calls.length, 0);
    } finally {
      fakeLocal.cleanup();
    }

    const fakeGlobal = fakeNpmGlobal();
    try {
      const eligible = npmGlobalSpawn(fakeGlobal.npmRoot);
      const eligibleIo = capture();
      assert.equal(await runCli(["update", "--json", "--kxm"], {}, withGlobal(eligibleIo, fakeGlobal, {
        fetchImpl: releaseFetch(`v${currentVersion}`),
        spawnSync: eligible.spawnSync,
      }), cwd), 0);
      const eligiblePayload = JSON.parse(eligibleIo.read().stdout) as { kxm?: unknown; installKind: string };
      assert.equal(eligiblePayload.kxm, undefined);
      assert.equal(eligiblePayload.installKind, "npm-global");
      assert.equal(eligible.calls.some((call) => call.command === "npm" && call.args.includes("install")), false);
    } finally {
      fakeGlobal.cleanup();
    }

    const marketDir = join(home, ".claude", "plugins", "cache", "kxm", "kxm", "0.0.1", "dist");
    mkdirSync(marketDir, { recursive: true });
    const stateHome = mkdtempSync(join(tmpdir(), "kxm-auto-quiet-"));
    try {
      writeUserUpdateYaml(stateHome, "schema: kxm.update.v1\nauto: true\nsource: github\n");
      const autoIo = capture();
      assert.equal(await runCli(["update", "--json", "--dry-run"], { KXM_STATE_HOME: stateHome }, {
        ...autoIo,
        fetchImpl: releaseFetch(`v${currentVersion}`),
        installProbe: {
          moduleDir: marketDir,
          repoRoot: join(home, ".claude", "plugins", "cache", "kxm", "kxm"),
          homeDir: home,
          platform: process.platform,
          env: {},
        },
      }, cwd), 0);
      const autoPayload = JSON.parse(autoIo.read().stdout) as {
        notice: { auto: boolean; available: boolean };
        kxm?: unknown;
        steps?: unknown[];
        scope?: string;
        installKind: string;
      };
      assert.equal(autoPayload.notice.auto, true);
      assert.equal(autoPayload.notice.available, false);
      assert.equal(autoPayload.kxm, undefined);
      assert.equal(autoPayload.installKind, "claude-marketplace");
      assert.equal(autoPayload.scope, "all");
      assert.ok(Array.isArray(autoPayload.steps));
      assert.equal(/kxm: /.test(autoIo.read().stderr), false);
    } finally {
      rmSync(stateHome, { recursive: true, force: true });
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("update ignores auto in the working directory update.yaml", async () => {
  const cwd = tempProject();
  const fake = fakeNpmGlobal();
  const stateHome = mkdtempSync(join(tmpdir(), "kxm-update-state-"));
  try {
    writeProjectUpdateYaml(cwd, "schema: kxm.update.v1\nauto: true\nsource: github\n");
    const ignored = capture();
    assert.equal(await runCli(["update", "--json", "--dry-run"], { KXM_STATE_HOME: stateHome }, withGlobal(ignored, fake, {
      fetchImpl: releaseFetch(),
    }), cwd), 0);
    const ignoredPayload = JSON.parse(ignored.read().stdout) as { notice: { auto: boolean }; kxm?: unknown };
    assert.equal(ignoredPayload.notice.auto, false);
    assert.equal(ignoredPayload.kxm, undefined);
    assert.match(ignored.read().stderr, /ignoring \.kxm\/update\.yaml/);

    writeUserUpdateYaml(stateHome, "schema: kxm.update.v1\nauto: true\nsource: github\n");
    const honored = capture();
    assert.equal(await runCli(["update", "--json", "--dry-run"], { KXM_STATE_HOME: stateHome }, withGlobal(honored, fake, {
      fetchImpl: releaseFetch(),
    }), cwd), 0);
    const honoredPayload = JSON.parse(honored.read().stdout) as { notice: { auto: boolean }; kxm?: { detail: string } };
    assert.equal(honoredPayload.notice.auto, true);
    assert.match(honoredPayload.kxm?.detail ?? "", /gh release download/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
    fake.cleanup();
  }
});

test("harness list, runtime dry-run, and dash screens cover adjacent CLI branches", async () => {
  const cwd = tempProject();
  const stateHome = mkdtempSync(join(tmpdir(), "kxm-update-cli-state-"));
  const fake = fakeNpmGlobal();
  try {
    const harness = capture();
    assert.equal(await runCli(["harness", "--json", "list"], {}, { ...harness, fetchImpl: githubFetch() }, cwd), 0);
    assert.match(harness.read().stdout, /"command":"harness list"/);

    const self = capture();
    assert.equal(await runCli(["update", "--json", "--dry-run", "--self"], {}, withGlobal(self, fake, { fetchImpl: githubFetch(`v${currentVersion}`) }), cwd), 0);
    assert.match(self.read().stdout, /"scope":"self"/);

    const runtimeEnv = { KXM_STATE_HOME: stateHome };
    const runtimeStart = capture();
    assert.equal(await runCli(["runtime", "--json", "--dry-run", "start"], runtimeEnv, runtimeStart, cwd), 0);
    assert.match(runtimeStart.read().stdout, /"command":"runtime start"/);

    const runtimeStatus = capture();
    assert.equal(await runCli(["runtime", "--json", "status"], runtimeEnv, runtimeStatus, cwd), 1);
    assert.match(runtimeStatus.read().stdout, /"running":false/);

    const runtimeStop = capture();
    assert.equal(await runCli(["runtime", "--json", "stop"], runtimeEnv, runtimeStop, cwd), 0);
    assert.match(runtimeStop.read().stdout, /"stopped":false/);

    const dashUnknown = capture();
    assert.equal(await runCli(["dash", "--json", "--screen", "nope"], {}, dashUnknown, cwd), 2);
    assert.match(dashUnknown.read().stderr, /unknown_screen/);

    const dashJson = capture();
    assert.equal(await runCli(["dash", "--json"], {}, {
      ...dashJson,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }, cwd), 2);
    assert.match(dashJson.read().stderr, /does not support --json/);

    const skills = capture();
    assert.equal(await runCli([
      "skills", "--json", "--dry-run", "create",
      "--file", join(cwd, "missing.md"),
      "--name", "demo",
      "--created-by", "tester",
      "--harness", "pi",
      "--models", "xai/grok-4.6",
    ], {}, skills, cwd), 0);
    assert.match(skills.read().stdout, /"dryRun":true/);

    const skillsFail = capture();
    assert.equal(await runCli([
      "skills", "create",
      "--file", join(cwd, "missing.md"),
      "--name", "demo",
      "--created-by", "tester",
      "--harness", "pi",
      "--models", "xai/grok-4.6",
    ], {}, skillsFail, cwd), 1);
    assert.match(skillsFail.read().stderr, /skills create failed/);

    const view = capture();
    assert.equal(await runCli(["hub", "--json", "view"], {}, {
      ...view,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    }, cwd), 1);
    assert.match(view.read().stderr, /hub_unreachable/);

    const sessionBoth = capture();
    assert.equal(await runCli(["session", "start", "--workflow", "wf", "--mix", "coordinator"], {}, sessionBoth, cwd), 2);
    assert.match(sessionBoth.read().stderr, /not both/);
    const sessionNone = capture();
    assert.equal(await runCli(["session", "start"], {}, sessionNone, cwd), 2);
    assert.match(sessionNone.read().stderr, /requires --workflow/);

    const skillsState = capture();
    assert.equal(await runCli(["skills", "--json", "list", "--state", "nope"], {}, skillsState, cwd), 1);
    assert.match(skillsState.read().stderr, /skills list failed|invalid skill state/);

    const skillsEval = capture();
    assert.equal(await runCli([
      "skills", "evaluate", "skill_missing",
      "--kind", "static-review",
      "--evaluator", "v1",
    ], {}, skillsEval, cwd), 1);
    assert.match(skillsEval.read().stderr, /skills evaluate failed/);

    const skillsPromote = capture();
    assert.equal(await runCli([
      "skills", "promote", "skill_missing",
      "--decided-by", "reviewer",
      "--evidence", "ev-1",
    ], {}, skillsPromote, cwd), 1);
    assert.match(skillsPromote.read().stderr, /skills promote failed/);

    const skillsReject = capture();
    assert.equal(await runCli([
      "skills", "reject", "skill_missing",
      "--decided-by", "reviewer",
    ], {}, skillsReject, cwd), 1);
    assert.match(skillsReject.read().stderr, /skills reject failed/);

    const skillsVerify = capture();
    assert.equal(await runCli(["skills", "verify", "skill_missing"], {}, skillsVerify, cwd), 1);
    assert.match(skillsVerify.read().stderr, /skills verify failed/);

    const routing = capture();
    assert.equal(await runCli(["routing", "--json", "report"], {}, routing, cwd), 0);
    assert.match(routing.read().stdout, /"configurations":\[\]/);

    const wfMissing = capture();
    assert.equal(await runCli(["workflow", "start"], {}, wfMissing, cwd), 2);
    assert.match(wfMissing.read().stderr, /requires <definitionId>/);

    const wfPayload = capture();
    assert.equal(await runCli([
      "workflow", "--json", "start", "wf",
      "--payload", "[1]",
    ], { KXM_WORKFLOW_SECRET: "workflow-secret-16chars" }, wfPayload, cwd), 2);
    assert.match(wfPayload.read().stderr, /invalid_payload/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
    fake.cleanup();
  }
});

test("hub start prints an available update notice", async () => {
  const cwd = tempProject();
  const fake = fakeNpmGlobal();
  try {
    const io = capture();
    let spawned = 0;
    assert.equal(await runCli(["hub", "start"], {}, withGlobal(io, fake, {
      fetchImpl: githubFetch("v99.0.0"),
      spawnHub: () => {
        spawned += 1;
        return 0;
      },
    }), cwd), 0);
    assert.equal(spawned, 1);
    assert.match(io.read().stderr, /99\.0\.0 available/);

    const current = capture();
    assert.equal(await runCli(["hub", "start"], {}, withGlobal(current, fake, {
      fetchImpl: githubFetch(`v${currentVersion}`),
      spawnHub: () => 0,
    }), cwd), 0);
    assert.doesNotMatch(current.read().stderr, /available/);

    const dry = capture();
    let dryFetch = 0;
    assert.equal(await runCli(["hub", "--dry-run", "--json", "start"], {}, {
      ...dry,
      fetchImpl: async () => {
        dryFetch += 1;
        throw new Error("dry-run must not check updates");
      },
    }, cwd), 0);
    assert.equal(dryFetch, 0);
    assert.match(dry.read().stdout, /"dryRun":true/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    fake.cleanup();
  }
});

test("hub start warns on malformed update.yaml and still spawns", async () => {
  const cwd = tempProject();
  const fake = fakeNpmGlobal();
  const stateHome = mkdtempSync(join(tmpdir(), "kxm-update-state-"));
  try {
    writeUserUpdateYaml(stateHome, "schema: no\nauto: false\n");
    const io = capture();
    let spawned = 0;
    assert.equal(await runCli(["hub", "start"], { KXM_STATE_HOME: stateHome }, withGlobal(io, fake, {
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
      spawnHub: () => {
        spawned += 1;
        return 0;
      },
    }), cwd), 0);
    assert.equal(spawned, 1);
    const yamlPath = join(stateHome, "update.yaml");
    assert.match(io.read().stderr, /kxm: update\.yaml schema must be kxm\.update\.v1; update check skipped; fix or remove /);
    assert.ok(io.read().stderr.includes(yamlPath));
    assert.equal(existsUpdateCache(stateHome), false);
    assert.equal(existsProjectUpdateCache(cwd), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
    fake.cleanup();
  }
});

test("hub start prints the cached notice before spawning and refreshes in the background", async () => {
  const cwd = tempProject();
  const fake = fakeNpmGlobal();
  const stateHome = mkdtempSync(join(tmpdir(), "kxm-update-cache-home-"));
  try {
    const availableNotice = noticeFromVersions(currentVersion, "99.0.0", {
      schema: "kxm.update.v1",
      auto: false,
      source: "github",
    });
    writeUpdateCache(stateHome, availableNotice);
    const io = capture();
    let spawnedAt = 0;
    let fetchResolvedAt = 0;
    assert.equal(await runCli(["hub", "start"], { KXM_STATE_HOME: stateHome }, withGlobal(io, fake, {
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        fetchResolvedAt = Date.now();
        return new Response(JSON.stringify({ tag_name: "v99.0.0" }), { status: 200 });
      },
      spawnHub: () => {
        spawnedAt = Date.now();
        return 0;
      },
    }), cwd), 0);
    assert.ok(spawnedAt > 0 && fetchResolvedAt > 0);
    assert.ok(spawnedAt < fetchResolvedAt);
    assert.equal(io.read().stderr, `${availableNotice.message}\n`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
    fake.cleanup();
  }
});

test("hub start ignores a project-local update cache", async () => {
  const cwd = tempProject();
  const fake = fakeNpmGlobal();
  const stateHome = mkdtempSync(join(tmpdir(), "kxm-update-ignore-project-"));
  try {
    const availableNotice = noticeFromVersions(currentVersion, "99.0.0", {
      schema: "kxm.update.v1",
      auto: false,
      source: "github",
    });
    writeUpdateCache(join(cwd, ".kxm", "state"), availableNotice);
    const io = capture();
    let spawnedAt = 0;
    let fetchResolvedAt = 0;
    assert.equal(await runCli(["hub", "start"], { KXM_STATE_HOME: stateHome }, withGlobal(io, fake, {
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        fetchResolvedAt = Date.now();
        return new Response(JSON.stringify({ tag_name: `v${currentVersion}` }), { status: 200 });
      },
      spawnHub: () => {
        spawnedAt = Date.now();
        return 0;
      },
    }), cwd), 0);
    assert.ok(spawnedAt > 0 && fetchResolvedAt > 0);
    assert.ok(spawnedAt < fetchResolvedAt);
    assert.doesNotMatch(io.read().stderr, /99\.0\.0 available/);
    assert.equal(readFileSync(join(cwd, ".kxm", "state", "update-check.json"), "utf8").includes("99.0.0"), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
    fake.cleanup();
  }
});

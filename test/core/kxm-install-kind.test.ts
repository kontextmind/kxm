import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  classifyInstallRoot,
  resolveInstallKind,
  type InstallProbe,
} from "../../plugins/kxm/src/kxm-install-kind.ts";
import { installProbeFrom } from "../../plugins/kxm/src/cli/hub.ts";
import { tryFindKxmRepoRoot } from "../../plugins/kxm/src/repo-root.ts";

function writeKxmPackage(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "@kontextmind/kxm", version: "0.0.1" })}\n`);
}

function probeAt(root: string, overrides: Partial<InstallProbe> = {}): InstallProbe {
  return {
    moduleDir: join(root, "plugins", "kxm", "src"),
    repoRoot: root,
    homeDir: join(root, "home"),
    platform: process.platform,
    env: {},
    ...overrides,
  };
}

test("classifyInstallRoot matches each install kind from a real temp tree", () => {
  const home = mkdtempSync(join(tmpdir(), "kxm-kind-"));
  try {
    const piRoot = join(home, ".pi", "agent", "git", "github.com", "kontextmind", "kxm");
    writeKxmPackage(piRoot);
    mkdirSync(join(piRoot, ".git"), { recursive: true });
    const pi = classifyInstallRoot(probeAt(piRoot, { homeDir: home, moduleDir: join(piRoot, "dist") }));
    assert.equal(pi.kind, "pi-git");
    assert.match(pi.instruction, /pi update/);

    const marketDir = join(home, ".claude", "plugins", "cache", "kxm", "kxm", "0.0.1", "dist");
    mkdirSync(marketDir, { recursive: true });
    const market = classifyInstallRoot(probeAt(join(home, "elsewhere"), {
      homeDir: home,
      moduleDir: marketDir,
    }));
    assert.equal(market.kind, "claude-marketplace");
    assert.match(market.instruction, /claude plugin update kxm@kxm/);

    const sourceRoot = join(home, "src", "kxm");
    writeKxmPackage(sourceRoot);
    mkdirSync(join(sourceRoot, ".git"), { recursive: true });
    const source = classifyInstallRoot(probeAt(sourceRoot, { homeDir: home }));
    assert.equal(source.kind, "source");
    assert.match(source.instruction, /git pull/);

    const worktreeRoot = join(home, "src", "kxm-worktree");
    writeKxmPackage(worktreeRoot);
    writeFileSync(join(worktreeRoot, ".git"), "gitdir: /tmp/kxm.git\n");
    const worktree = classifyInstallRoot(probeAt(worktreeRoot, { homeDir: home }));
    assert.equal(worktree.kind, "source");

    const npmRoot = join(home, "node_modules", "@kontextmind", "kxm");
    writeKxmPackage(npmRoot);
    const npmPkg = classifyInstallRoot(probeAt(npmRoot, { homeDir: home, moduleDir: join(npmRoot, "plugins", "kxm", "dist") }));
    assert.equal(npmPkg.kind, "npm-package");

    const unknownRoot = join(home, "odd-copy");
    writeKxmPackage(unknownRoot);
    const unknown = classifyInstallRoot(probeAt(unknownRoot, { homeDir: home }));
    assert.equal(unknown.kind, "unknown");
    assert.match(unknown.instruction, /cannot tell how it was installed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("win32 path comparison is case-insensitive via the platform input", () => {
  const report = classifyInstallRoot({
    moduleDir: "C:\\Users\\Test\\AppData\\Roaming\\npm\\node_modules\\@kontextmind\\kxm\\plugins\\kxm\\dist",
    repoRoot: "C:\\Users\\Test\\.pi\\agent\\git\\github.com\\kontextmind\\kxm",
    homeDir: "c:\\users\\test",
    platform: "win32",
    env: {},
  });
  assert.equal(report.kind, "pi-git");

  const mixed = classifyInstallRoot({
    moduleDir: "C:/Users/Test/AppData/Roaming/npm/node_modules/@kontextmind/kxm/plugins/kxm/dist",
    repoRoot: "C:\\Users\\Test\\.pi\\agent\\git\\github.com\\kontextmind\\kxm",
    homeDir: "c:/users/test",
    platform: "win32",
    env: {},
  });
  assert.equal(mixed.kind, "pi-git");

  const sibling = classifyInstallRoot({
    moduleDir: "C:\\Users\\Testing\\AppData\\Roaming\\npm\\node_modules\\@kontextmind\\kxm\\plugins\\kxm\\dist",
    repoRoot: "C:\\Users\\Testing\\.pi\\agent\\git\\github.com\\kontextmind\\kxm",
    homeDir: "c:\\users\\test",
    platform: "win32",
    env: {},
  });
  assert.equal(sibling.kind, "unknown");
});

test("resolveInstallKind refines npm-package and fails closed when spawn is empty", () => {
  const home = mkdtempSync(join(tmpdir(), "kxm-kind-resolve-"));
  try {
    const npmRoot = join(home, "node_modules", "@kontextmind", "kxm");
    writeKxmPackage(npmRoot);
    const probe = probeAt(npmRoot, { homeDir: home, moduleDir: join(npmRoot, "plugins", "kxm", "dist") });
    const global = resolveInstallKind(probe, () => join(home, "node_modules"));
    assert.equal(global.kind, "npm-global");
    const local = resolveInstallKind(probe, () => join(home, "other", "node_modules"));
    assert.equal(local.kind, "npm-local");
    const missing = resolveInstallKind(probe, () => undefined);
    assert.equal(missing.kind, "unknown");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install classification follows the running module, not the caller's working directory", () => {
  const decoy = mkdtempSync(join(tmpdir(), "kxm-decoy-install-"));
  const previousCwd = process.cwd();
  try {
    // A directory that looks exactly like a source install from the old probe's
    // point of view: our package name plus a .git.
    writeKxmPackage(decoy);
    mkdirSync(join(decoy, ".git"), { recursive: true });
    assert.equal(classifyInstallRoot(probeAt(decoy)).kind, "source", "the decoy really does look like a source install");

    process.chdir(decoy);
    const probe = installProbeFrom({ io: {}, env: {} } as never);
    assert.notEqual(probe.repoRoot, resolve(decoy), "cwd is not how kxm was installed");
    assert.equal(classifyInstallRoot(probe).root, probe.repoRoot, "the report names the root it classified");
    // In a test run the loaded module is this checkout, so the honest answer is
    // the repo root — and it must be the repo root, not whatever directory the
    // operator happened to type `kxm update` in.
    assert.equal(tryFindKxmRepoRoot(pathToFileURL(join(probe.moduleDir, "x.ts")).href), probe.repoRoot
      ?? tryFindKxmRepoRoot(), "the probe root is the module's own install root");

    // The injection seam still wins, so tests and adapters can classify a layout
    // that is not the one under test.
    const injected = installProbeFrom({ io: { installProbe: { repoRoot: decoy } }, env: {} } as never);
    assert.equal(injected.repoRoot, resolve(decoy));
  } finally {
    process.chdir(previousCwd);
    rmSync(decoy, { recursive: true, force: true });
  }
});

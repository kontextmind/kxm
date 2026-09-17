import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { removeTempDir } from "../helpers.ts";
// @ts-expect-error The bumper is a workflow script with no declaration artifact.
import { applyVersionBump } from "../../scripts/kxm-bump-version.mjs";
// @ts-expect-error The scanner is a workflow script with no declaration artifact.
import { workspaceManifestPaths } from "../../scripts/package-surfaces.mjs";

const CURRENT = "0.7.1";
const NEXT = "0.7.2";

interface Versioned {
  version?: string;
}
interface Manifest extends Versioned {
  name?: string;
}
interface LockPackage extends Versioned {
  name?: string;
}
interface LockFile extends Versioned {
  lockfileVersion?: number;
  packages?: Record<string, LockPackage>;
}
interface Marketplace extends Versioned {
  plugins?: Array<{ name?: string; version?: string }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * A fixture repo with the shape the release job sees: the tracked JSON surfaces,
 * the MCP source constant, and one workspace package whose version is carried by
 * both its own manifest and a `package-lock.json` key. A third-party dependency
 * deliberately shares the product's version string so a search-and-replace bump
 * cannot pass unnoticed.
 */
function versionFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "kxm-version-surfaces-"));
  const write = (rel: string, value: unknown) => {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };

  write("package.json", { name: "@kontextmind/kxm", version: CURRENT });
  write("plugins/kxm/package.json", { name: "@kontextmind/kxm-plugin", version: CURRENT });
  write("plugins/kxm/.claude-plugin/plugin.json", { name: "kxm", version: CURRENT });
  write(".claude-plugin/marketplace.json", { plugins: [{ name: "kxm", version: CURRENT }] });
  write("plugins/kxm/src/mcp-server.ts", `const VERSION = "${CURRENT}";\nexport { VERSION };\n`);
  write("packages/core/tui/package.json", { name: "@kontextmind/tui", version: CURRENT });
  write("package-lock.json", {
    name: "@kontextmind/kxm",
    version: CURRENT,
    lockfileVersion: 3,
    packages: {
      "": { name: "@kontextmind/kxm", version: CURRENT },
      "packages/core/tui": { name: "@kontextmind/tui", version: CURRENT },
      // Same version string as the product, different artifact. Must survive.
      "node_modules/left-pad": { name: "left-pad", version: CURRENT },
    },
  });
  return root;
}

test("version bump writes every workspace package manifest, not just the root", () => {
  const root = versionFixture();
  try {
    assert.deepEqual(applyVersionBump(root, NEXT), { oldVersion: CURRENT, newVersion: NEXT });

    assert.equal(readJson<Manifest>(join(root, "package.json")).version, NEXT);
    assert.equal(readJson<Manifest>(join(root, "plugins/kxm/package.json")).version, NEXT);
    assert.equal(readJson<Manifest>(join(root, "plugins/kxm/.claude-plugin/plugin.json")).version, NEXT);
    const marketplace = readJson<Marketplace>(join(root, ".claude-plugin/marketplace.json"));
    assert.equal(marketplace.plugins?.[0]?.version, NEXT);
    assert.match(readFileSync(join(root, "plugins/kxm/src/mcp-server.ts"), "utf8"), new RegExp(`const VERSION = "${NEXT}"`));

    // The surface that broke the 0.7.41 and 0.7.42 release jobs.
    assert.equal(readJson<Manifest>(join(root, "packages/core/tui/package.json")).version, NEXT);
  } finally {
    removeTempDir(root);
  }
});

test("version bump patches the lockfile by key and never rewrites a third-party version", () => {
  const root = versionFixture();
  try {
    applyVersionBump(root, NEXT);
    const lock = readJson<LockFile>(join(root, "package-lock.json"));

    assert.equal(lock.version, NEXT);
    assert.equal(lock.packages?.[""]?.version, NEXT);
    assert.equal(lock.packages?.["packages/core/tui"]?.version, NEXT);
    // An unrelated dependency that happens to share our version string is
    // untouched: a global string replace would have turned it into a phantom
    // artifact and poisoned `npm ci`.
    assert.equal(lock.packages?.["node_modules/left-pad"]?.version, CURRENT);
  } finally {
    removeTempDir(root);
  }
});

test("version bump fails loudly when a workspace package has no lock entry", () => {
  const root = versionFixture();
  try {
    const lockPath = join(root, "package-lock.json");
    const lock = readJson<LockFile>(lockPath);
    if (lock.packages) delete lock.packages["packages/core/tui"];
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");

    assert.throws(() => applyVersionBump(root, NEXT), /no entry for workspace package packages\/core\/tui/);
  } finally {
    removeTempDir(root);
  }
});

test("the package scan finds tiered and flat packages and skips non-packages", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-package-scan-"));
  try {
    mkdirSync(join(root, "packages/flat"), { recursive: true });
    mkdirSync(join(root, "packages/tier/nested"), { recursive: true });
    mkdirSync(join(root, "packages/tier/nested/node_modules/dep"), { recursive: true });
    mkdirSync(join(root, "packages/empty-dir"), { recursive: true });
    // Deeper than the supported two levels: not a package location.
    mkdirSync(join(root, "packages/tier/nested/deeper/yet"), { recursive: true });
    writeFileSync(join(root, "packages/flat/package.json"), "{}", "utf8");
    writeFileSync(join(root, "packages/tier/nested/package.json"), "{}", "utf8");
    writeFileSync(join(root, "packages/tier/nested/node_modules/dep/package.json"), "{}", "utf8");
    writeFileSync(join(root, "packages/tier/nested/deeper/yet/package.json"), "{}", "utf8");

    assert.deepEqual(workspaceManifestPaths(root), ["packages/flat", "packages/tier/nested"]);
  } finally {
    removeTempDir(root);
  }
});

test("the real repository carries one version across every scanned surface", () => {
  const root = process.cwd();
  const rootVersion = readJson<Manifest>(join(root, "package.json")).version;
  const paths = workspaceManifestPaths(root) as string[];

  assert.ok(paths.length > 0, "at least one workspace package must exist for this to mean anything");
  const lock = readJson<LockFile>(join(root, "package-lock.json"));
  for (const rel of paths) {
    assert.equal(readJson<Manifest>(join(root, rel, "package.json")).version, rootVersion, `${rel} must share the repository version`);
    assert.equal(lock.packages?.[rel]?.version, rootVersion, `${rel} must have a matching lock entry at the repository version`);
  }
});

#!/usr/bin/env node

/**
 * Bump the package version across all tracked surfaces.
 *
 * Usage:
 *   node scripts/kxm-bump-version.mjs <new-version>       # explicit version
 *   node scripts/kxm-bump-version.mjs patch               # bump patch
 *   node scripts/kxm-bump-version.mjs minor               # bump minor
 *   node scripts/kxm-bump-version.mjs major               # bump major
 *
 * Surfaces updated (must stay in sync with scripts/check-versions.mjs — both
 * take their package list from scripts/package-surfaces.mjs):
 *   1. package.json                          .version
 *   2. package-lock.json                     .version + .packages[""].version
 *      + .packages[<workspace path>].version
 *   3. plugins/kxm/package.json              .version
 *   4. plugins/kxm/.claude-plugin/plugin.json .version
 *   5. .claude-plugin/marketplace.json       .plugins[name=kxm].version
 *   6. plugins/kxm/src/mcp-server.ts         const VERSION = "..."
 *   7. plugins/kxm/dist/mcp-server.js        const VERSION = "..." (rebuilt)
 *   8. each workspace manifest scanned under packages/ —
 *      packages/<name>/package.json and packages/<tier>/<name>/package.json
 *
 * The lockfile is patched by key, never by searching for the old version string:
 * a third-party dependency that happens to carry the same version as the
 * product must not be rewritten into a phantom artifact.
 *
 * After running this script, run `npm run build` to rebuild dist bundles.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceManifestPaths } from "./package-surfaces.mjs";

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseSemver(version) {
  const match = SEMVER_RE.exec(version);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
    build: match[5],
  };
}

export function bumpVersion(current, kind) {
  const parsed = parseSemver(current);
  if (!parsed) throw new Error(`invalid current version: ${current}`);
  switch (kind) {
    case "major":
      return `${parsed.major + 1}.0.0`;
    case "minor":
      return `${parsed.major}.${parsed.minor + 1}.0`;
    case "patch":
      return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
    default:
      throw new Error(`unknown bump kind: ${kind} (use major, minor, or patch)`);
  }
}

/** Replace a version string in a JSON file using targeted string patching. */
function patchJsonVersion(filePath, oldVersion, newVersion) {
  const raw = readFileSync(filePath, "utf8");
  const escaped = oldVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`("version"\\s*:\\s*)"${escaped}"`, "g");
  const patched = raw.replace(pattern, `$1"${newVersion}"`);
  if (patched === raw) {
    throw new Error(`no version field found to patch in ${filePath}`);
  }
  writeFileSync(filePath, patched, "utf8");
}

/** Replace a version string in a TypeScript/JavaScript source file. */
function patchSourceVersion(filePath, newVersion) {
  const raw = readFileSync(filePath, "utf8");
  const patched = raw.replace(
    /const VERSION = "[^"]+"/,
    `const VERSION = "${newVersion}"`,
  );
  if (patched === raw) {
    throw new Error(`no VERSION constant found in ${filePath}`);
  }
  writeFileSync(filePath, patched, "utf8");
}

/**
 * Patch the lockfile structurally: the root entry and each workspace package
 * entry, by key. Everything else — including an unrelated dependency whose
 * version string equals ours — is left byte-for-byte alone.
 */
function patchLockVersions(root, newVersion) {
  const file = resolve(root, "package-lock.json");
  const raw = readFileSync(file, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`package-lock.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const touched = [];
  if (typeof data.version === "string") {
    data.version = newVersion;
    touched.push("version");
  }
  if (data.packages?.[""]) {
    data.packages[""].version = newVersion;
    touched.push('packages[""]');
  }
  for (const rel of workspaceManifestPaths(root)) {
    const entry = data.packages?.[rel];
    if (!entry) {
      throw new Error(`package-lock.json has no entry for workspace package ${rel}; run npm install to resync the lock`);
    }
    entry.version = newVersion;
    touched.push(`packages[${rel}]`);
  }
  if (touched.length === 0) throw new Error("no version fields found to patch in package-lock.json");
  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  writeFileSync(file, `${JSON.stringify(data, null, 2)}${trailingNewline}`, "utf8");
  return touched;
}

export function applyVersionBump(root, newVersion) {
  if (!parseSemver(newVersion)) {
    throw new Error(`invalid semver: ${newVersion}`);
  }

  // Read current version
  const pkgPath = resolve(root, "package.json");
  const oldVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version;

  // JSON manifests (targeted patch preserves formatting). Workspace packages are
  // scanned, not hard-coded: a new package must not be releasable-then-forgotten.
  const jsonFiles = [
    "package.json",
    "plugins/kxm/package.json",
    "plugins/kxm/.claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ...workspaceManifestPaths(root).map((rel) => `${rel}/package.json`),
  ];
  for (const rel of jsonFiles) {
    patchJsonVersion(resolve(root, rel), oldVersion, newVersion);
  }

  // Lockfile by key, after the manifests so a missing workspace entry fails loudly.
  patchLockVersions(root, newVersion);

  // TypeScript source
  patchSourceVersion(resolve(root, "plugins/kxm/src/mcp-server.ts"), newVersion);

  // Generated dist (update in place if it exists; check:generated rebuilds anyway)
  const distPath = resolve(root, "plugins/kxm/dist/mcp-server.js");
  try {
    patchSourceVersion(distPath, newVersion);
  } catch {
    // dist may not exist yet; will be rebuilt by npm run build
  }

  return { oldVersion, newVersion };
}

export function main(argv = process.argv.slice(2), root = process.cwd()) {
  const arg = argv[0];
  if (!arg) {
    process.stderr.write("usage: node scripts/kxm-bump-version.mjs <version|patch|minor|major>\n");
    return 1;
  }

  const pkgPath = resolve(root, "package.json");
  const currentVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version;

  let newVersion;
  if (SEMVER_RE.test(arg)) {
    newVersion = arg;
  } else {
    newVersion = bumpVersion(currentVersion, arg);
  }

  if (newVersion === currentVersion) {
    process.stdout.write(`version unchanged: ${currentVersion}\n`);
    return 0;
  }

  const result = applyVersionBump(root, newVersion);
  process.stdout.write(`bumped ${result.oldVersion} -> ${result.newVersion}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

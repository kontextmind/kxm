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
 * Surfaces updated (must stay in sync with scripts/check-versions.mjs):
 *   1. package.json                          .version
 *   2. package-lock.json                     .version + .packages[""].version
 *   3. plugins/kxm/package.json              .version
 *   4. plugins/kxm/.claude-plugin/plugin.json .version
 *   5. .claude-plugin/marketplace.json       .plugins[name=kxm].version
 *   6. plugins/kxm/src/mcp-server.ts         const VERSION = "..."
 *   7. plugins/kxm/dist/mcp-server.js        const VERSION = "..." (rebuilt)
 *
 * After running this script, run `npm run build` to rebuild dist bundles.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export function applyVersionBump(root, newVersion) {
  if (!parseSemver(newVersion)) {
    throw new Error(`invalid semver: ${newVersion}`);
  }

  // Read current version
  const pkgPath = resolve(root, "package.json");
  const oldVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version;

  // JSON surfaces (targeted patch preserves formatting)
  const jsonFiles = [
    "package.json",
    "package-lock.json",
    "plugins/kxm/package.json",
    "plugins/kxm/.claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
  ];
  for (const rel of jsonFiles) {
    patchJsonVersion(resolve(root, rel), oldVersion, newVersion);
  }

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

/**
 * The single source of truth for "which directories are KXM packages".
 *
 * `scripts/check-versions.mjs` (the gate) and `scripts/kxm-bump-version.mjs`
 * (the release writer) must agree exactly, or a release bumps some surfaces and
 * not others: the 0.7.41 release job failed because a workspace manifest existed
 * for the checker but not for the bumper. Both now import this scan.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Every package directory under `packages/`, one or two levels deep
 * (`packages/<name>`, `packages/<tier>/<name>`), as POSIX-style paths relative
 * to `root` — the same shape `package-lock.json` uses for its `packages` keys.
 *
 * A directory that itself carries a `package.json` is a package and is not
 * descended into further.
 */
export function workspaceManifestPaths(root) {
  const found = [];
  const packagesDir = resolve(root, "packages");
  const scan = (absoluteDir, relativeDir, depth) => {
    if (depth > 2 || !existsSync(absoluteDir)) return;
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const abs = join(absoluteDir, entry.name);
      const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (existsSync(join(abs, "package.json"))) {
        found.push(rel);
        continue;
      }
      scan(abs, rel, depth + 1);
    }
  };
  scan(packagesDir, "packages", 1);
  return found.sort();
}

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Files that only exist at the KXM repo/package root. */
const ROOT_MARKERS = ["scripts/kxm-hub.mjs", "scripts/kxm.mjs"] as const;
const MAX_WALK_DEPTH = 10;

/**
 * Locate the KXM repo/package root by walking up from `fromUrl` until a
 * directory contains a root marker. Fixed-depth `../..` resolution breaks
 * because the same module runs from both the source tree
 * (`plugins/kxm/src/...`) and the flat bundled `plugins/kxm/dist/...`
 * layout; marker discovery is correct in both, and in npm-installed
 * layouts, which also ship `scripts/`.
 */
/**
 * The repo/package root this module was loaded from, or `undefined` when the
 * layout is not recognisable. For callers that must degrade to "cannot tell how
 * it was installed" instead of throwing — install classification, mostly.
 */
export function tryFindKxmRepoRoot(fromUrl: string = import.meta.url): string | undefined {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    if (ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function findKxmRepoRoot(fromUrl: string = import.meta.url): string {
  const found = tryFindKxmRepoRoot(fromUrl);
  if (found !== undefined) return found;
  throw new Error(
    `kxm: cannot locate the KXM repo root from ${fileURLToPath(fromUrl)} ` +
      `(walked ${MAX_WALK_DEPTH} levels looking for ${ROOT_MARKERS[0]})`,
  );
}

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { kxmUserStateRoot } from "./bindings.ts";

/* ------------------------------------------------------------------ *
 * Where the Runtime keeps its stores under the user state root.
 *
 * A leaf module on purpose: backup and restore (`database.ts`) must find a
 * project's event store exactly as the Runtime does, and `runtime-store.ts`
 * imports `database.ts`, so the derivation cannot live there without a cycle.
 * ------------------------------------------------------------------ */

export interface KxmRuntimePaths {
  stateRoot: string;
  runtimeDir: string;
  registryDb: string;
  projectsDir: string;
}

export function kxmRuntimePaths(options: { stateRoot?: string; env?: NodeJS.ProcessEnv; homeDir?: string } = {}): KxmRuntimePaths {
  const stateRoot = options.stateRoot
    ? resolve(options.stateRoot)
    : kxmUserStateRoot({ ...(options.env ? { env: options.env } : {}), ...(options.homeDir ? { homeDir: options.homeDir } : {}) });
  const runtimeDir = join(stateRoot, "runtime");
  return {
    stateRoot,
    runtimeDir,
    registryDb: join(runtimeDir, "registry.db"),
    projectsDir: join(runtimeDir, "projects"),
  };
}

export function projectRuntimeKey(projectRoot: string): string {
  // Canonicalize through the filesystem like the repository binding store so
  // reaching a project through a link cannot mint a second key for it.
  let canonical: string;
  try {
    canonical = realpathSync.native(resolve(projectRoot));
  } catch {
    canonical = resolve(projectRoot);
  }
  const folded = process.platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical;
  return createHash("sha256").update(folded, "utf8").digest("hex").slice(0, 24);
}

/** The project's Runtime event store, derived exactly as the Runtime derives it. */
export function kxmProjectRunEventsPath(projectRoot: string, env: NodeJS.ProcessEnv): string {
  return join(kxmRuntimePaths({ env }).projectsDir, projectRuntimeKey(projectRoot), "run-events.db");
}

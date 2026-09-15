import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** Default project identity for a workspace.
 *
 * Precedence: `KXM_PROJECT` environment, then the workspace `package.json`
 * `name`, then the workspace directory name. The package.json read is
 * best-effort and never walks upward: a missing, malformed, or name-less
 * file falls through to the directory name. */
export function defaultProjectName(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.KXM_PROJECT?.trim();
  if (fromEnv) return fromEnv;
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name?: unknown };
    if (typeof pkg.name === "string" && pkg.name.trim().length > 0) return pkg.name.trim();
  } catch {
    // No readable package.json: fall through to the directory name.
  }
  return basename(cwd);
}

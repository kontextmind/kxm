import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

/** Default project identity for a workspace.
 *
 * Precedence: an explicit flag, then `KXM_PROJECT`, then the `id` in the
 * nearest `.kxm/project.yaml` walking upward from `cwd`, then the workspace
 * `package.json` `name` (that read never walks upward), then the directory
 * name. A missing, malformed, or id-less project file falls through. A missing,
 * malformed, or name-less package.json falls through to the directory name. */
export function defaultProjectName(cwd: string, env: NodeJS.ProcessEnv = process.env, explicit?: string): string {
  const fromExplicit = explicit?.trim();
  if (fromExplicit) return fromExplicit;
  const fromEnv = env.KXM_PROJECT?.trim();
  if (fromEnv) return fromEnv;
  const fromProject = readProjectYamlId(cwd);
  if (fromProject) return fromProject;
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name?: unknown };
    if (typeof pkg.name === "string" && pkg.name.trim().length > 0) return pkg.name.trim();
  } catch {
    // No readable package.json: fall through to the directory name.
  }
  return basename(cwd);
}

function readProjectYamlId(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const file = join(dir, ".kxm", "project.yaml");
    if (existsSync(file)) {
      try {
        const doc = parseYaml(readFileSync(file, "utf8")) as { id?: unknown } | null;
        if (doc && typeof doc === "object" && !Array.isArray(doc) && typeof doc.id === "string" && doc.id.trim()) {
          return doc.id.trim();
        }
      } catch {
        // Malformed YAML falls through to package.json of the original directory.
      }
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

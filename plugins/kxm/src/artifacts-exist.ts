import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type ArtifactExistenceFailure =
  | "artifact_outside_workspace_assets"
  | "artifact_missing"
  | "artifact_not_file"
  | "artifact_empty"
  | "artifact_unreadable";

export type ArtifactExistenceResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; error: ArtifactExistenceFailure; path: string };

function staysUnder(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

/**
 * Verify one non-empty regular file beneath the configured workspace assets
 * directory. Both lexical and real paths are checked so a missing outside path
 * and a symlink/junction escape fail closed.
 */
export function verifyArtifactExists(rootInput: string, pathInput: string): ArtifactExistenceResult {
  const lexicalRoot = resolve(rootInput);
  const lexicalPath = resolve(pathInput);
  if (!staysUnder(lexicalRoot, lexicalPath)) {
    return { ok: false, error: "artifact_outside_workspace_assets", path: lexicalPath };
  }

  let realRoot: string;
  let realPath: string;
  try {
    realRoot = realpathSync(lexicalRoot);
  } catch {
    return { ok: false, error: "artifact_unreadable", path: lexicalPath };
  }
  try {
    realPath = realpathSync(lexicalPath);
  } catch {
    return { ok: false, error: "artifact_missing", path: lexicalPath };
  }
  if (!staysUnder(realRoot, realPath)) {
    return { ok: false, error: "artifact_outside_workspace_assets", path: lexicalPath };
  }

  try {
    // lstat keeps an explicit link check at the final component. Parent
    // junction/symlink escapes are covered by the real-path containment above.
    const link = lstatSync(lexicalPath);
    if (link.isSymbolicLink()) {
      return { ok: false, error: "artifact_outside_workspace_assets", path: lexicalPath };
    }
    const artifact = statSync(realPath);
    if (!artifact.isFile()) return { ok: false, error: "artifact_not_file", path: lexicalPath };
    if (artifact.size < 1) return { ok: false, error: "artifact_empty", path: lexicalPath };
    return { ok: true, path: realPath, bytes: artifact.size };
  } catch {
    return { ok: false, error: "artifact_unreadable", path: lexicalPath };
  }
}

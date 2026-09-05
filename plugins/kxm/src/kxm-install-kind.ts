import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalHostPath, sameHostPath } from "./vnext-bindings.ts";

export interface InstallProbe {
  moduleDir: string;
  repoRoot: string;
  homeDir: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

export type InstallKind = "npm-global" | "npm-local" | "pi-git" | "claude-marketplace" | "source" | "unknown";
export type ClassifiedInstallKind = InstallKind | "npm-package";

export interface InstallKindReport {
  kind: ClassifiedInstallKind;
  root: string;
  instruction: string;
}

function packageIsKxm(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown };
    return pkg.name === "@kontextmind/kxm";
  } catch {
    return false;
  }
}

function pathSegments(path: string): string[] {
  return canonicalHostPath(path).split(/[/\\]+/).filter((part) => part.length > 0);
}

function isUnder(child: string, parent: string, platform: NodeJS.Platform): boolean {
  if (sameHostPath(child, parent, platform)) return true;
  const childParts = pathSegments(child);
  const parentParts = pathSegments(parent);
  if (parentParts.length === 0 || childParts.length < parentParts.length) return false;
  return parentParts.every((part, i) => segmentEq(part, childParts[i]!, platform));
}

function lastSegments(path: string): string[] {
  return pathSegments(path).slice(-3);
}

function segmentEq(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function isNpmPackageLayout(repoRoot: string, platform: NodeJS.Platform): boolean {
  const last = lastSegments(repoRoot);
  const expected = ["node_modules", "@kontextmind", "kxm"];
  return last.length === 3 && last.every((part, i) => segmentEq(part, expected[i]!, platform));
}

export function installKindInstruction(kind: ClassifiedInstallKind, root: string): string {
  switch (kind) {
    case "pi-git":
      return `kxm is installed by Pi at ${root}; update it with: pi update`;
    case "claude-marketplace":
      return `kxm is a Claude Code marketplace plugin at ${root}; update it with: claude plugin update kxm@kxm`;
    case "source":
      return `kxm is running from source at ${root}; update it with git pull there, not kxm update --kxm`;
    case "npm-local":
      return `kxm is installed as a project dependency at ${root}; update it with: npm install @kontextmind/kxm@latest in that project`;
    case "npm-global":
      return `kxm is an npm global install at ${root}`;
    case "npm-package":
      return `kxm is an npm package at ${root}`;
    default:
      return `kxm cannot tell how it was installed (${root}); update it the way it was installed, or reinstall with: npm install --global @kontextmind/kxm`;
  }
}

function report(kind: ClassifiedInstallKind, root: string): InstallKindReport {
  return { kind, root, instruction: installKindInstruction(kind, root) };
}

export function classifyInstallRoot(probe: InstallProbe): InstallKindReport {
  const piGitRoot = join(probe.homeDir, ".pi", "agent", "git");
  if (isUnder(probe.repoRoot, piGitRoot, probe.platform)) return report("pi-git", probe.repoRoot);

  const claudeHome = probe.env.CLAUDE_CONFIG_DIR?.trim() || join(probe.homeDir, ".claude");
  const pluginsRoot = join(claudeHome, "plugins");
  if (isUnder(probe.moduleDir, pluginsRoot, probe.platform)) return report("claude-marketplace", probe.moduleDir);

  const hasGit = existsSync(join(probe.repoRoot, ".git"));
  if (hasGit && packageIsKxm(probe.repoRoot)) return report("source", probe.repoRoot);

  if (isNpmPackageLayout(probe.repoRoot, probe.platform) && packageIsKxm(probe.repoRoot) && !hasGit) {
    return report("npm-package", probe.repoRoot);
  }

  return report("unknown", probe.repoRoot);
}

export function resolveInstallKind(
  probe: InstallProbe,
  npmGlobalRoot: () => string | undefined,
): InstallKindReport {
  const classified = classifyInstallRoot(probe);
  if (classified.kind !== "npm-package") return classified;
  const globalRoot = npmGlobalRoot();
  if (typeof globalRoot !== "string" || globalRoot.trim() === "") {
    return report("unknown", classified.root);
  }
  const expected = dirname(dirname(classified.root));
  if (sameHostPath(globalRoot.trim(), expected, probe.platform)) return report("npm-global", classified.root);
  return report("npm-local", classified.root);
}

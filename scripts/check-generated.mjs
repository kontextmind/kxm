#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const GENERATED_ARTIFACTS = [
  "plugins/pi-mesh-comms/dist/cli.js",
  "plugins/pi-mesh-comms/dist/server.js",
  "plugins/pi-mesh-comms/dist/mcp-server.js",
];

function runGit(repository, args, allowFailure = false) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw new Error(`could not run git: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

export function checkGeneratedArtifacts(repository = process.cwd()) {
  const requestedRoot = resolve(repository);
  const topLevel = runGit(requestedRoot, ["rev-parse", "--show-toplevel"]).stdout.trim();
  const root = resolve(topLevel);
  const missing = GENERATED_ARTIFACTS.filter((path) => !existsSync(resolve(root, path)));
  if (missing.length > 0) {
    throw new Error(`generated artifacts are missing: ${missing.join(", ")}`);
  }

  const untracked = GENERATED_ARTIFACTS.filter((path) => runGit(
    root,
    ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", path],
    true,
  ).status !== 0);
  if (untracked.length > 0) {
    throw new Error(`generated artifacts are not tracked by git: ${untracked.join(", ")}`);
  }

  const status = runGit(root, [
    "--literal-pathspecs",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...GENERATED_ARTIFACTS,
  ]).stdout.trim();
  if (status) {
    throw new Error(`generated artifacts changed after build:\n${status}`);
  }
  return { root, artifacts: [...GENERATED_ARTIFACTS] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkGeneratedArtifacts();
    process.stdout.write(`generated artifacts are tracked and current (${result.artifacts.length})\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "generated artifact check failed"}\n`);
    process.exitCode = 1;
  }
}

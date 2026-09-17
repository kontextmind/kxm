#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listSkillMirrorArtifacts, loadSkillSuiteManifest } from "./emit-codex-artifacts.mjs";

export const STATIC_GENERATED_ARTIFACTS = Object.freeze([
  "plugins/kxm/dist/cli.js",
  "plugins/kxm/dist/server.js",
  "plugins/kxm/dist/mcp-server.js",
  "plugins/kxm/dist/runtime-supervisor.js",
  "plugins/kxm/dist/core.js",
  "plugins/kxm/dist/runtime.js",
  "plugins/kxm/dist/client.js",
  "plugins/kxm/dist/extension.js",
  "packages/core/tui/dist/index.js",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
]);

/**
 * Compute the generated artifact list from the committed suite manifest.
 * The manifest is required; missing or invalid manifests fail closed.
 *
 * @param {string} [repository]
 * @returns {string[]}
 */
export function computeGeneratedArtifacts(repository = process.cwd()) {
  const root = resolve(repository);
  loadSkillSuiteManifest(root);
  return Object.freeze([
    ...STATIC_GENERATED_ARTIFACTS,
    ...listSkillMirrorArtifacts(root),
  ]);
}

/**
 * Synchronous snapshot for the current repository. Tests that need a
 * fixture-specific list should call computeGeneratedArtifacts(root).
 *
 * @type {readonly string[]}
 */
export const GENERATED_ARTIFACTS = computeGeneratedArtifacts();

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
  const artifacts = computeGeneratedArtifacts(root);

  const missing = artifacts.filter((path) => !existsSync(resolve(root, path)));
  if (missing.length > 0) {
    throw new Error(`generated artifacts are missing: ${missing.join(", ")}`);
  }

  const untracked = artifacts.filter((path) => runGit(
    root,
    ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", path],
    true,
  ).status !== 0);
  if (untracked.length > 0) {
    throw new Error(`generated artifacts are not tracked by git: ${untracked.join(", ")}`);
  }

  const status = runGit(root, [
    "--literal-pathspecs",
    "diff",
    "--name-only",
    "--",
    ...artifacts,
  ]).stdout.trim();
  if (status) {
    throw new Error(`generated artifacts changed after build:\n${status}`);
  }
  return { root, artifacts: [...artifacts] };
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

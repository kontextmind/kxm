#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
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
  "plugins/kxm/dist/claude-hook.js",
  "packages/core/tui/dist/index.js",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
]);

/**
 * Packages whose installed version differs from `package-lock.json`.
 *
 * The generated bundles embed dependency **bytes and paths**, so a
 * `node_modules` that has drifted from the lock produces artifacts that pass
 * this check locally and fail in CI — which installs from the lock on every
 * leg. That asymmetry is worse than a broken build: it lets a machine ship a
 * bundle nobody else can reproduce. Refuse before the build, naming the
 * packages, instead of reporting a diff the developer cannot act on.
 *
 * @param {string} [repository]
 * @returns {string[]}
 */
export function findLockfileDrift(repository = process.cwd()) {
  const root = resolve(repository);
  if (!existsSync(resolve(root, "node_modules"))) return [];
  const lockPath = resolve(root, "package-lock.json");
  if (!existsSync(lockPath)) return [];
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return ["package-lock.json is unreadable"];
  }
  const packages = lock?.packages;
  if (!packages || typeof packages !== "object") return [];
  const drifted = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (!key.startsWith("node_modules/")) continue; // the root importer and workspaces
    if (entry?.link) continue; // a symlinked workspace, not an installed version
    const name = key.split("node_modules/").pop();
    const manifest = resolve(root, key, "package.json");
    if (!existsSync(manifest)) {
      if (!entry.optional) drifted.push(`${name}@${entry.version} is not installed`);
      continue;
    }
    let installed;
    try {
      installed = JSON.parse(readFileSync(manifest, "utf8")).version;
    } catch {
      installed = undefined;
    }
    if (installed !== entry.version) {
      drifted.push(`${name}: lock ${entry.version}, installed ${installed ?? "unreadable"}`);
    }
  }
  return drifted;
}

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

  const drifted = findLockfileDrift(root);
  if (drifted.length > 0) {
    const shown = drifted.slice(0, 8).map((line) => `  ${line}`).join("\n");
    throw new Error(
      `node_modules does not match package-lock.json (${drifted.length} package(s)); `
      + "the generated bundles embed dependency bytes, so CI — which runs npm ci — will rebuild them differently.\n"
      + `${shown}${drifted.length > 8 ? "\n  …" : ""}\nRun: npm ci`,
    );
  }

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

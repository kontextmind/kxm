#!/usr/bin/env node

// Classify a pull request or push into the CI lanes.
//
// Docs and plan markdown skip the code jobs. The aggregate `required` job
// still runs, so a skipped matrix does not leave the status check blank.
// Platform-sensitive paths add the Windows unit shards on pull requests.
// Pushes to main and workflow_dispatch keep the full OS x Node validate matrix.

import { readFileSync } from "node:fs";

const DOCS_RULES = [
  (file) => file.endsWith(".md"),
  (file) => file.startsWith("docs/"),
  (file) => file.startsWith(".kxm/assets/"),
  (file) => file === "LICENSE",
  (file) => file.startsWith(".github/ISSUE_TEMPLATE/"),
  (file) => file === ".github/pull_request_template.md",
  (file) => file === ".github/dependabot.yml",
];

// Filename tokens for path, process, shell, and spawn behavior, plus the
// dependency and workflow files that change how those paths run.
const PLATFORM_NAME = /(path|paths|process|shell|spawn|worker|supervisor|repo-root|ssh-remote)/i;

// This test starts the real runtime supervisor and deletes its state root.
// The Windows lock after shutdown does not show up on Linux.
const PLATFORM_EXACT = new Set([
  "test/core/studio-layout.test.ts",
]);

export function isDocsPath(file) {
  return DOCS_RULES.some((rule) => rule(file));
}

export function isPlatformPath(file) {
  if (/(^|\/)package\.json$/.test(file)) return true;
  if (/(^|\/)package-lock\.json$/.test(file)) return true;
  if (file.startsWith(".github/workflows/")) return true;
  if (file.startsWith("scripts/")) return true;
  if (PLATFORM_EXACT.has(file)) return true;
  const base = file.split("/").pop() ?? file;
  return PLATFORM_NAME.test(base);
}

export function unboundedClassification() {
  return { code: true, platform: false, runValidate: true };
}

export function classifyPaths(paths, event) {
  const files = paths.map((file) => file.trim()).filter(Boolean);
  const code = files.some((file) => !isDocsPath(file));
  const platform = files.some((file) => isPlatformPath(file));
  const runValidate = event !== "pull_request" && code;
  return { code, platform, runValidate };
}

function emit(result) {
  process.stdout.write(`code=${result.code}\n`);
  process.stdout.write(`platform=${result.platform}\n`);
  process.stdout.write(`run_validate=${result.runValidate}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("ci-classify.mjs")) {
  const event = process.argv[2] ?? "";
  if (event !== "pull_request" && event !== "push" && event !== "workflow_dispatch" && event !== "unbounded") {
    process.stderr.write("usage: ci-classify.mjs <pull_request|push|workflow_dispatch|unbounded>\n");
    process.exit(2);
  }
  if (event === "unbounded") {
    emit(unboundedClassification());
  } else {
    const stdin = readFileSync(0, "utf8");
    emit(classifyPaths(stdin.split(/\r?\n/), event));
  }
}

#!/usr/bin/env node

// Unit lanes for CI.
//
// Measured on Node 24 (4 cores), one file at a time: engine.test.ts 174s,
// permission.test.ts 74s, runtime.test.ts 53s. Those files run their tests
// sequentially, and running them in one process pool stretched the rest of
// the suite to 268s. engine.test.ts is split by test name across two jobs.
// permission and runtime run one file at a time in a serial job so they do
// not steal cores from each other.
//
// package-install.test.ts is serial as well. On the Windows light lane for
// PRs #361, #362, and #363 it took 171s (67s on Linux) and was the file that
// finished immediately before that lane stopped reporting tests. The job
// then sat until the 20-minute cancel. npm pack/install stays off the light
// pool. The other light files are round-robin split into two shards so a
// Windows job is not one 120-file process.
//
// Dynamic `test(\`...\${...}\`)` names stay together as one pattern so a
// loop is not dropped. Run via `npm run test:ci-shard` so npm_execpath is
// set for the packed-install test: `engine <index> <total>`, `serial`,
// `light`, or `light-<index>` (two shards).

import { spawn, spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SHARD_TOTAL = 2;
export const LIGHT_SHARD_TOTAL = 2;
export const ENGINE_FILE = "test/core/engine.test.ts";
// Solo Node 24 timings: permission 74s, runtime 53s. package-install is 171s
// on Windows CI and 67s on Linux. One file at a time.
export const SERIAL_FILES = [
  "test/core/permission.test.ts",
  "test/core/runtime.test.ts",
  "test/core/package-install.test.ts",
];
const LIGHT_CONCURRENCY = 4;

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

// Node's glob returns backslashes on Windows. Lane membership compares posix paths.
export function toPosixPath(file) {
  return file.replaceAll("\\", "/");
}

export function normalizeUnitFiles(files) {
  return files.map((file) => toPosixPath(file)).sort();
}

export function planUnitFiles(files) {
  const normalized = normalizeUnitFiles(files);
  if (!normalized.includes(ENGINE_FILE)) throw new Error(`${ENGINE_FILE} is missing`);
  for (const file of SERIAL_FILES) {
    if (!normalized.includes(file)) throw new Error(`${file} is missing`);
  }
  const reserved = new Set([ENGINE_FILE, ...SERIAL_FILES]);
  const light = normalized.filter((file) => !reserved.has(file));
  return { files: normalized, serial: [...SERIAL_FILES], light };
}

export function listUnitFiles(root) {
  return normalizeUnitFiles([
    ...globSync("test/core/*.test.ts", { cwd: root }),
    ...globSync("packages/core/*/tests/unit/*.test.ts", { cwd: root }),
  ]);
}

export function extractTestPatterns(source) {
  const patterns = [];
  const seen = new Set();
  const re = /^[ \t]*test\(\s*(["'`])([\s\S]*?)\1/gm;
  for (const match of source.matchAll(re)) {
    const raw = match[2];
    let sourcePattern;
    let dynamic = false;
    let name;
    if (raw.includes("${")) {
      dynamic = true;
      const marked = raw.replace(/\$\{[^}]*\}/g, "\0");
      sourcePattern = `^${escapeRegExp(marked).replaceAll("\0", ".*?")}$`;
    } else {
      name = raw.replace(/\\(["'`\\])/g, "$1");
      sourcePattern = `^${escapeRegExp(name)}$`;
    }
    if (seen.has(sourcePattern)) continue;
    seen.add(sourcePattern);
    patterns.push({ dynamic, name, source: sourcePattern });
  }
  return patterns;
}

function conflicts(patterns) {
  const exact = patterns.filter((pattern) => !pattern.dynamic);
  const dynamic = patterns.filter((pattern) => pattern.dynamic);
  const hits = [];
  for (const pattern of dynamic) {
    const regex = new RegExp(pattern.source);
    for (const item of exact) {
      if (regex.test(item.name)) hits.push(`${item.name} matches ${pattern.source}`);
    }
  }
  return hits;
}

function enginePatterns(root) {
  const patterns = extractTestPatterns(readFileSync(join(root, ENGINE_FILE), "utf8"));
  if (patterns.length === 0) throw new Error(`${ENGINE_FILE} has no recognizable test() names`);
  const overlapped = conflicts(patterns);
  if (overlapped.length > 0) {
    throw new Error(`${ENGINE_FILE} dynamic test names also match exact tests:\n${overlapped.join("\n")}`);
  }
  return patterns;
}

export function planEngineShard(root, index, total = SHARD_TOTAL) {
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || index > total) {
    throw new Error(`shard ${index}/${total} is outside 1..${total}`);
  }
  const patterns = enginePatterns(root).filter((_, patternIndex) => patternIndex % total === index - 1);
  if (patterns.length === 0) throw new Error(`engine shard ${index}/${total} assigned no tests`);
  return { file: ENGINE_FILE, patterns };
}

export function planSerial(root) {
  return planUnitFiles(listUnitFiles(root)).serial;
}

export function planLight(root) {
  const { light } = planUnitFiles(listUnitFiles(root));
  if (light.length === 0) throw new Error("light lane has no unit files");
  return light;
}

export function planLightShard(root, index, total = LIGHT_SHARD_TOTAL) {
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || index > total) {
    throw new Error(`light shard ${index}/${total} is outside 1..${total}`);
  }
  const shard = planLight(root).filter((_, fileIndex) => fileIndex % total === index - 1);
  if (shard.length === 0) throw new Error(`light shard ${index}/${total} assigned no unit files`);
  return shard;
}

export function coverageOfShards(root, total = SHARD_TOTAL) {
  const heavy = new Map();
  for (let index = 1; index <= total; index += 1) {
    const plan = planEngineShard(root, index, total);
    for (const pattern of plan.patterns) heavy.set(pattern.source, (heavy.get(pattern.source) ?? 0) + 1);
  }
  const lanes = planUnitFiles(listUnitFiles(root));
  if (lanes.light.length === 0) throw new Error("light lane has no unit files");
  return { files: lanes.files, serial: lanes.serial, light: lanes.light, heavy };
}

function runNode(args, label, children) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        // Git Credential Manager on windows-latest can wait on a prompt
        // until the job is cancelled. Refuse that wait for every lane.
        GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT || "0",
        GCM_INTERACTIVE: process.env.GCM_INTERACTIVE || "Never",
      },
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    const flush = (buffer, stream, chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      const rest = lines.pop() ?? "";
      for (const line of lines) stream.write(`[${label}] ${line}\n`);
      return rest;
    };
    child.stdout.on("data", (chunk) => { stdout = flush(stdout, process.stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = flush(stderr, process.stderr, chunk); });
    child.on("close", (code) => {
      children.delete(child);
      if (stdout) process.stdout.write(`[${label}] ${stdout}\n`);
      if (stderr) process.stderr.write(`[${label}] ${stderr}\n`);
      resolve(code ?? 1);
    });
    child.on("error", (error) => {
      children.delete(child);
      process.stderr.write(`[${label}] ${error.message}\n`);
      resolve(1);
    });
  });
}

function testArgs(concurrency, files, patterns) {
  const args = [
    "--disable-warning=ExperimentalWarning",
    "--experimental-strip-types",
    "--test",
    "--test-force-exit",
    `--test-concurrency=${concurrency}`,
  ];
  for (const pattern of patterns ?? []) args.push("--test-name-pattern", pattern.source);
  args.push(...files);
  return args;
}

async function runPool(tasks, limit) {
  const pending = [...tasks];
  const children = new Set();
  let failed = false;
  const workers = Array.from({ length: Math.min(limit, pending.length) }, async () => {
    while (pending.length > 0 && !failed) {
      const task = pending.shift();
      const code = await task(children);
      if (code !== 0) {
        failed = true;
        for (const child of children) child.kill("SIGTERM");
      }
    }
  });
  await Promise.all(workers);
  return failed ? 1 : 0;
}

function npmBuild() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    process.stderr.write("npm_execpath is required; run via npm run test:ci-shard\n");
    return 1;
  }
  const result = spawnSync(process.execPath, [npmCli, "run", "build"], {
    stdio: "inherit",
    env: process.env,
  });
  return result.status ?? 1;
}

async function main() {
  const mode = process.argv[2];
  const root = process.cwd();
  const built = npmBuild();
  if (built !== 0) process.exit(built);
  if (mode === "serial") {
    const files = planSerial(root);
    process.exit(await runPool([
      (children) => runNode(testArgs(1, files), "serial", children),
    ], 1));
  }
  const lightShard = /^light-(\d+)$/.exec(mode);
  if (mode === "light" || lightShard) {
    const files = lightShard
      ? planLightShard(root, Number(lightShard[1]), LIGHT_SHARD_TOTAL)
      : planLight(root);
    const label = lightShard ? mode : "light";
    process.exit(await runPool([
      (children) => runNode(testArgs(LIGHT_CONCURRENCY, files), label, children),
    ], 1));
  }
  if (mode === "engine") {
    const index = Number(process.argv[3]);
    const total = Number(process.argv[4] ?? SHARD_TOTAL);
    const plan = planEngineShard(root, index, total);
    process.exit(await runPool([
      (children) => runNode(testArgs(1, [plan.file], plan.patterns), "engine", children),
    ], 1));
  }
  process.stderr.write("usage: ci-unit-shard.mjs <serial|light|light-<index>|engine> [index total]\n");
  process.exit(2);
}

if (process.argv[1] && process.argv[1].endsWith("ci-unit-shard.mjs")) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

import { spawn } from "node:child_process";
import { join } from "node:path";
import { discoverKxmProjectRoot } from "../project-config.ts";
import { findKxmRepoRoot } from "../repo-root.ts";
import { print, type Runtime } from "./types.ts";

export interface LandOptions {
  pr?: string;
  stage?: string;
  bodyFile?: string;
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name.toUpperCase().startsWith("GIT_")) continue;
    env[name] = value;
  }
  return env;
}

function refuse(runtime: Runtime, error: string, text: string): number {
  print(runtime.io, runtime.json, { ok: false, command: "land", error }, text);
  return 1;
}

/** Spawn scripts/pr-land.mjs and stream its JSON lines. The exit code is the script's. */
export function cmdLand(runtime: Runtime, options: LandOptions = {}): Promise<number> {
  const root = discoverKxmProjectRoot(runtime.cwd);
  if (!root) {
    return Promise.resolve(refuse(runtime, "project_required", "land requires a KXM project (run kxm init first)"));
  }
  const script = join(findKxmRepoRoot(import.meta.url), "scripts", "pr-land.mjs");
  const args = [script];
  if (options.pr) args.push("--pr", options.pr);
  if (options.stage) args.push("--stage", options.stage);
  if (options.bodyFile) args.push("--body-file", options.bodyFile);
  if (runtime.json) args.push("--json");
  if (runtime.dryRun) args.push("--dry-run");
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, args, { cwd: root, env: childEnv(), windowsHide: true });
    child.stdout.on("data", (chunk: Buffer) => runtime.io.stdout(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => runtime.io.stderr(chunk.toString("utf8")));
    child.once("error", () => resolveExit(1));
    child.once("close", (code) => resolveExit(code ?? 1));
  });
}

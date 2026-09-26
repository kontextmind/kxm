import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { discoverKxmProjectRoot } from "../project-config.ts";
import { print, type Runtime } from "./types.ts";

const GENERATOR = "plans/kxm-roadmap/update-dashboard.mjs";
const SERVER = "ops/docs-site/serve.py";

function requireProject(runtime: Runtime, command: string): string | number {
  const root = discoverKxmProjectRoot(runtime.cwd);
  if (!root) {
    print(
      runtime.io,
      runtime.json,
      { ok: false, command, error: "project_required" },
      `kxm ${command} requires a KXM project (run kxm init first)`,
    );
    return 1;
  }
  return root;
}

function requireFile(runtime: Runtime, command: string, root: string, relative: string, error: string): string | number {
  const file = join(root, relative);
  if (existsSync(file)) return file;
  print(
    runtime.io,
    runtime.json,
    { ok: false, command, error, path: relative },
    `kxm ${command} requires ${relative}`,
  );
  return 1;
}

function printCommand(runtime: Runtime, command: string, line: string): number {
  print(
    runtime.io,
    runtime.json,
    { ok: true, command, dryRun: true, detail: line },
    line,
  );
  return 0;
}

function runInherited(command: string, args: readonly string[], cwd: string): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(command, [...args], { cwd, stdio: "inherit" });
    child.once("error", () => resolveExit(1));
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
}

/** Regenerate the docs site from the roadmap state. */
export async function cmdDocsBuild(runtime: Runtime): Promise<number> {
  const command = "docs build";
  const root = requireProject(runtime, command);
  if (typeof root === "number") return root;
  const file = requireFile(runtime, command, root, GENERATOR, "docs_generator_missing");
  if (typeof file === "number") return file;
  const line = `node ${GENERATOR}`;
  if (runtime.dryRun) return printCommand(runtime, command, line);
  return runInherited(process.execPath, [file], root);
}

/** Serve the built site. `--port` is passed through when set. */
export async function cmdDocsServe(runtime: Runtime, options: { port?: string } = {}): Promise<number> {
  const command = "docs serve";
  const root = requireProject(runtime, command);
  if (typeof root === "number") return root;
  const file = requireFile(runtime, command, root, SERVER, "docs_server_missing");
  if (typeof file === "number") return file;
  const args = [file];
  if (options.port !== undefined && options.port !== "") args.push("--port", options.port);
  const line = ["python3", SERVER, ...args.slice(1)].join(" ");
  if (runtime.dryRun) return printCommand(runtime, command, line);
  return runInherited("python3", args, root);
}

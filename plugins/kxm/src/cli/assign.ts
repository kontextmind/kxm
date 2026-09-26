import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { discoverKxmProjectRoot } from "../project-config.ts";
import { CLI_RESULT_SCHEMA, print, type Runtime } from "./types.ts";

export interface AssignSpawnOptions {
  cwd: string;
  stdio: "inherit";
  env: NodeJS.ProcessEnv;
}

export interface AssignSpawnResult {
  status: number | null;
  error?: Error;
}

/** Test seam. Production leaves `spawn` unset and uses `spawnSync`. */
export const kxmAssignCliSeams: {
  spawn?: (command: string, args: readonly string[], options: AssignSpawnOptions) => AssignSpawnResult;
} = {};

export type AssignVerb =
  | "run"
  | "witness"
  | "plan-current"
  | "attribute"
  | "observe-cost"
  | "accept"
  | "change-report";

export interface AssignArgs {
  manifest?: string;
  recordDir?: string;
  taskDir?: string;
  plan?: string;
  sha256?: string;
  baseCommit?: string;
  expectedGeneration?: string;
  classification?: string;
  explanationFile?: string;
  input?: string;
  commit?: string;
  critics?: readonly string[];
  observedPr?: string;
  observedCi?: string;
}

const RUNNER_REL = "scripts/assignment-run.mjs";

function refuse(runtime: Runtime, command: string, error: string, text: string): number {
  print(runtime.io, runtime.json, { ok: false, command, error }, text);
  return 1;
}

function flag(value: string | undefined): string {
  if (value === undefined) throw new Error("assign invocation missing a parsed flag");
  return value;
}

/** Argv after `node scripts/assignment-run.mjs`, in the recipe's flag order.
 * The runner's usage text documents no `--json` flag. `accept` prints JSON
 * and takes none, so the global `--json` flag stays on this command. */
function runnerArgv(subcommand: AssignVerb, args: AssignArgs): string[] {
  switch (subcommand) {
    case "run":
      return ["run", "--manifest", flag(args.manifest)];
    case "witness":
      return ["witness", "--record-dir", flag(args.recordDir)];
    case "plan-current":
      return [
        "plan-current",
        "--task-dir", flag(args.taskDir),
        "--plan", flag(args.plan),
        "--sha256", flag(args.sha256),
        "--base-commit", flag(args.baseCommit),
        "--expected-generation", flag(args.expectedGeneration),
      ];
    case "attribute":
      return [
        "attribute",
        "--task-dir", flag(args.taskDir),
        "--record-dir", flag(args.recordDir),
        "--class", flag(args.classification),
        "--explanation-file", flag(args.explanationFile),
      ];
    case "observe-cost":
      return ["observe-cost", "--task-dir", flag(args.taskDir), "--input", flag(args.input)];
    case "accept": {
      const argv = [
        "accept",
        "--task-dir", flag(args.taskDir),
        "--commit", flag(args.commit),
        "--record-dir", flag(args.recordDir),
      ];
      for (const critic of args.critics ?? []) argv.push("--critic", critic);
      if (args.observedPr !== undefined) argv.push("--observed-pr", args.observedPr);
      if (args.observedCi !== undefined) argv.push("--observed-ci", args.observedCi);
      return argv;
    }
    case "change-report":
      return ["change-report", "--task-dir", flag(args.taskDir)];
    default: {
      const unreachable: never = subcommand;
      throw new Error(`unknown assign verb ${String(unreachable)}`);
    }
  }
}

export async function cmdAssign(runtime: Runtime, subcommand: AssignVerb, args: AssignArgs): Promise<number> {
  const command = `assign ${subcommand}`;
  const root = discoverKxmProjectRoot(runtime.cwd);
  if (!root) return refuse(runtime, command, "project_required", `${command} requires a KXM project (run kxm init first)`);
  if (!existsSync(join(root, "scripts", "assignment-run.mjs"))) {
    return refuse(runtime, command, "assign_runner_missing", `${command} requires scripts/assignment-run.mjs in the project root`);
  }
  const argv = ["node", RUNNER_REL, ...runnerArgv(subcommand, args)];
  if (runtime.dryRun) {
    // print() redacts every 64-hex string. plan-current passes a plan sha256
    // through unchanged, so the dry-run argv is written directly.
    const payload = { schema: CLI_RESULT_SCHEMA, ok: true, command, dryRun: true, argv };
    runtime.io.stdout(runtime.json ? `${JSON.stringify(payload)}\n` : `${argv.join(" ")}\n`);
    return 0;
  }
  // Never load a `.env` from the working directory. The justfile keeps
  // `set dotenv-load` off for the same reason: a gitignored `.env` could set
  // `NODE_OPTIONS`, and that value runs before the runner validates identity,
  // tree, or roster. Pass the process environment through unchanged.
  const spawn = kxmAssignCliSeams.spawn ?? ((commandName: string, commandArgs: readonly string[], options: AssignSpawnOptions): AssignSpawnResult => {
    const result = spawnSync(commandName, commandArgs, {
      cwd: options.cwd,
      stdio: options.stdio,
      env: options.env,
      windowsHide: true,
    });
    return { status: result.status, ...(result.error ? { error: result.error } : {}) };
  });
  const result = spawn("node", argv.slice(1), { cwd: root, stdio: "inherit", env: runtime.env });
  if (result.status === null) {
    const detail = result.error?.message ?? "the assignment runner could not be started";
    return refuse(runtime, command, "assign_spawn_failed", detail);
  }
  return result.status;
}

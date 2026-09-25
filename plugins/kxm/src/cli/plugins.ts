import { spawnSync } from "node:child_process";
import { findKxmRepoRoot } from "../repo-root.ts";
import { probeHarnesses } from "../harness.ts";
import { print, type Runtime } from "./types.ts";

export type PluginHarnessId = "pi" | "omp" | "claude";

export const PLUGIN_SUPPORTED_HARNESSES: readonly PluginHarnessId[] = Object.freeze(["pi", "omp", "claude"]);

export interface PluginInstallOptions {
  all?: boolean | undefined;
  claude?: boolean | undefined;
  omp?: boolean | undefined;
  pi?: boolean | undefined;
}

export interface PluginInstallHarnessResult {
  harness: string;
  status: "passed" | "failed" | "would" | "skipped";
  command?: string | undefined;
  args?: readonly string[] | undefined;
  detail?: string | undefined;
  error?: string | undefined;
}

export async function cmdPluginInstall(
  runtime: Runtime,
  options: PluginInstallOptions,
): Promise<number> {
  const repoRoot = findKxmRepoRoot(import.meta.url);
  const env = runtime.env.PATH ? runtime.env : { ...process.env, ...runtime.env };
  const inventory = probeHarnesses({ env });

  const isExplicit = Boolean(options.claude || options.omp || options.pi);
  const requestedHarnesses: PluginHarnessId[] = [];
  if (options.pi) requestedHarnesses.push("pi");
  if (options.omp) requestedHarnesses.push("omp");
  if (options.claude) requestedHarnesses.push("claude");

  const targetHarnesses: readonly PluginHarnessId[] = isExplicit
    ? requestedHarnesses
    : PLUGIN_SUPPORTED_HARNESSES;

  const results: PluginInstallHarnessResult[] = [];

  for (const harnessId of targetHarnesses) {
    const status = inventory.harnesses.find((h) => h.id === harnessId);
    const detected = Boolean(status?.detected && status?.command);

    if (!detected) {
      if (isExplicit) {
        results.push({
          harness: harnessId,
          status: "failed",
          error: "harness_not_detected",
          detail: `${harnessId} harness is not installed or not found on PATH`,
        });
      }
      continue;
    }

    const command = status!.command!;

    if (harnessId === "pi") {
      const args = ["install", repoRoot, "-a"];
      if (runtime.dryRun) {
        results.push({
          harness: "pi",
          status: "would",
          command,
          args,
          detail: `would install kxm plugin into pi: ${command} ${args.join(" ")}`,
        });
      } else {
        const run = runtime.io.spawnSync
          ? runtime.io.spawnSync(command, args)
          : spawnSync(command, args, { encoding: "utf8", windowsHide: true, env: runtime.env });
        if (run.error || (run.status !== 0 && run.status !== null)) {
          results.push({
            harness: "pi",
            status: "failed",
            command,
            args,
            error: run.error?.message || "install_failed",
            detail: (run.stderr || run.stdout || "pi install exited with error").trim(),
          });
        } else {
          results.push({
            harness: "pi",
            status: "passed",
            command,
            args,
            detail: "installed kxm plugin into pi",
          });
        }
      }
    } else if (harnessId === "omp") {
      const args = ["plugin", "install", repoRoot];
      if (runtime.dryRun) {
        results.push({
          harness: "omp",
          status: "would",
          command,
          args,
          detail: `would install kxm plugin into omp: ${command} ${args.join(" ")}`,
        });
      } else {
        const run = runtime.io.spawnSync
          ? runtime.io.spawnSync(command, args)
          : spawnSync(command, args, { encoding: "utf8", windowsHide: true, env: runtime.env });
        if (run.error || (run.status !== 0 && run.status !== null)) {
          results.push({
            harness: "omp",
            status: "failed",
            command,
            args,
            error: run.error?.message || "install_failed",
            detail: (run.stderr || run.stdout || "omp plugin install exited with error").trim(),
          });
        } else {
          results.push({
            harness: "omp",
            status: "passed",
            command,
            args,
            detail: "installed kxm plugin into omp",
          });
        }
      }
    } else if (harnessId === "claude") {
      const marketplaceArgs = ["plugin", "marketplace", "add", repoRoot];
      const installArgs = ["plugin", "install", "kxm", "-y"];
      if (runtime.dryRun) {
        results.push({
          harness: "claude",
          status: "would",
          command,
          args: installArgs,
          detail: `would add marketplace and install kxm plugin into claude: ${command} ${installArgs.join(" ")}`,
        });
      } else {
        if (runtime.io.spawnSync) {
          runtime.io.spawnSync(command, marketplaceArgs);
        } else {
          spawnSync(command, marketplaceArgs, { encoding: "utf8", windowsHide: true, env: runtime.env });
        }
        const run = runtime.io.spawnSync
          ? runtime.io.spawnSync(command, installArgs)
          : spawnSync(command, installArgs, { encoding: "utf8", windowsHide: true, env: runtime.env });
        if (run.error || (run.status !== 0 && run.status !== null)) {
          results.push({
            harness: "claude",
            status: "failed",
            command,
            args: installArgs,
            error: run.error?.message || "install_failed",
            detail: (run.stderr || run.stdout || "claude plugin install exited with error").trim(),
          });
        } else {
          results.push({
            harness: "claude",
            status: "passed",
            command,
            args: installArgs,
            detail: "installed kxm plugin into claude",
          });
        }
      }
    }
  }

  if (results.length === 0) {
    const errorMsg = "no supported harnesses (pi, omp, claude) detected on PATH";
    print(
      runtime.io,
      runtime.json,
      { ok: false, command: "plugin install", error: "no_harnesses_detected", results: [] },
      errorMsg,
    );
    return 1;
  }

  const ok = results.every((r) => r.status === "passed" || r.status === "would");
  const summary = results
    .map((r) => `${r.harness}: ${r.status}${r.detail ? ` (${r.detail})` : ""}`)
    .join("\n");

  print(
    runtime.io,
    runtime.json,
    {
      ok,
      command: "plugin install",
      ...(runtime.dryRun ? { dryRun: true } : {}),
      results,
    },
    summary,
  );

  return ok ? 0 : 1;
}

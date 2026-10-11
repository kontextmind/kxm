import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { findKxmRepoRoot } from "../repo-root.ts";
import { probeHarnesses } from "../harness.ts";
import { print, type CliSpawnResult, type Runtime } from "./types.ts";

export type PluginHarnessId = "pi" | "omp" | "claude";

export const PLUGIN_SUPPORTED_HARNESSES: readonly PluginHarnessId[] = Object.freeze(["pi", "omp", "claude"]);

export interface PluginInstallOptions {
  all?: boolean | undefined;
  claude?: boolean | undefined;
  omp?: boolean | undefined;
  pi?: boolean | undefined;
  statusBand?: boolean | undefined;
}

export interface PluginInstallHarnessResult {
  harness: string;
  status: "passed" | "failed" | "would" | "skipped";
  command?: string | undefined;
  args?: readonly string[] | undefined;
  detail?: string | undefined;
  error?: string | undefined;
}

const OMP_STATUS_SETTINGS = [
  { key: "statusLine.leftSegments", configKey: "leftSegments", value: ["model", "mode", "git", "pr", "subagents"] },
  { key: "statusLine.rightSegments", configKey: "rightSegments", value: ["usage", "cost", "context_pct"] },
  { key: "statusLine.preset", configKey: "preset", value: "custom" },
] as const;

function spawnHarness(runtime: Runtime, command: string, args: readonly string[]): CliSpawnResult {
  return runtime.io.spawnSync
    ? runtime.io.spawnSync(command, args)
    : spawnSync(command, args, { encoding: "utf8", windowsHide: true, env: runtime.env });
}

function spawnFailed(run: CliSpawnResult): boolean {
  return Boolean(run.error) || run.status !== 0;
}

function spawnFailureDetail(run: CliSpawnResult, fallback: string): string {
  return (run.stderr || run.stdout || run.error?.message || fallback).trim();
}

interface OmpStatusBandFailure {
  args: readonly string[];
  run: CliSpawnResult;
  rollbackAttempted: boolean;
  rollbackFailed: boolean;
}

interface OmpGlobalSettingSnapshot {
  present: boolean;
  value?: unknown;
}

function ompConfigValueArg(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function readOmpGlobalStatusSettings(
  runtime: Runtime,
  command: string,
): { previous: Record<string, OmpGlobalSettingSnapshot> } | OmpStatusBandFailure {
  const args = ["config", "path"];
  const run = spawnHarness(runtime, command, args);
  if (spawnFailed(run)) return { args, run, rollbackAttempted: false, rollbackFailed: false };

  const agentDir = run.stdout.trim();
  if (!agentDir || !isAbsolute(agentDir) || !existsSync(agentDir)) {
    return {
      args,
      run: { status: 1, stdout: run.stdout, stderr: "omp config path did not return an existing absolute directory" },
      rollbackAttempted: false,
      rollbackFailed: false,
    };
  }

  const configPath = ["config.yml", "config.yaml"].map((name) => join(agentDir, name)).find(existsSync);
  let document: unknown = {};
  try {
    if (configPath) document = parseYaml(readFileSync(configPath, "utf8"));
  } catch {
    return {
      args,
      run: { status: 1, stdout: run.stdout, stderr: `could not read OMP global config at ${configPath}` },
      rollbackAttempted: false,
      rollbackFailed: false,
    };
  }

  const root = document && typeof document === "object" && !Array.isArray(document) ? document : {};
  const rawStatusLine = "statusLine" in root ? root.statusLine : undefined;
  const statusLine = rawStatusLine && typeof rawStatusLine === "object" && !Array.isArray(rawStatusLine)
    ? rawStatusLine
    : {};
  const previous: Record<string, OmpGlobalSettingSnapshot> = {};
  for (const setting of OMP_STATUS_SETTINGS) {
    const value = statusLine[setting.configKey as keyof typeof statusLine];
    previous[setting.key] = Object.hasOwn(statusLine, setting.configKey) && value !== null && value !== undefined
      ? { present: true, value }
      : { present: false };
  }
  return { previous };
}

function rollbackOmpStatusBand(
  runtime: Runtime,
  command: string,
  settings: readonly (typeof OMP_STATUS_SETTINGS)[number][],
  previous: Readonly<Record<string, OmpGlobalSettingSnapshot>>,
): boolean {
  let failed = false;
  for (const setting of [...settings].reverse()) {
    const snapshot = previous[setting.key];
    const args = snapshot?.present
      ? ["config", "set", setting.key, ompConfigValueArg(snapshot.value), "--json"]
      : ["config", "reset", setting.key, "--json"];
    if (spawnFailed(spawnHarness(runtime, command, args))) failed = true;
  }
  return failed;
}

function configureOmpStatusBand(runtime: Runtime, command: string): OmpStatusBandFailure | undefined {
  const snapshot = readOmpGlobalStatusSettings(runtime, command);
  if ("run" in snapshot) return snapshot;

  const written: (typeof OMP_STATUS_SETTINGS)[number][] = [];
  for (const setting of OMP_STATUS_SETTINGS) {
    const args = ["config", "set", setting.key, ompConfigValueArg(setting.value), "--json"];
    written.push(setting);
    const run = spawnHarness(runtime, command, args);
    if (spawnFailed(run)) {
      return {
        args,
        run,
        rollbackAttempted: true,
        rollbackFailed: rollbackOmpStatusBand(runtime, command, written, snapshot.previous),
      };
    }
  }

  for (const setting of OMP_STATUS_SETTINGS) {
    const args = ["config", "get", setting.key, "--json"];
    const run = spawnHarness(runtime, command, args);
    let actual: unknown;
    try {
      const parsed: unknown = JSON.parse(run.stdout);
      actual = parsed && typeof parsed === "object" && "value" in parsed ? parsed.value : undefined;
    } catch {
      actual = undefined;
    }
    if (spawnFailed(run) || JSON.stringify(actual) !== JSON.stringify(setting.value)) {
      const mismatch = spawnFailed(run)
        ? run
        : { status: 1, stdout: run.stdout, stderr: `effective ${setting.key} is shadowed or did not persist` };
      return {
        args,
        run: mismatch,
        rollbackAttempted: true,
        rollbackFailed: rollbackOmpStatusBand(runtime, command, written, snapshot.previous),
      };
    }
  }
  return undefined;
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

  if (options.statusBand && isExplicit && !options.omp) {
    const detail = "--status-band requires OMP to be among the selected harnesses";
    print(
      runtime.io,
      runtime.json,
      { ok: false, command: "plugin install", error: "omp_status_band_requires_omp", results: [] },
      detail,
    );
    return 1;
  }

  const results: PluginInstallHarnessResult[] = [];

  for (const harnessId of targetHarnesses) {
    const status = inventory.harnesses.find((h) => h.id === harnessId);
    const detected = Boolean(status?.detected && status?.command);

    if (!detected) {
      if (isExplicit || (options.statusBand && harnessId === "omp")) {
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
        const run = spawnHarness(runtime, command, args);
        if (spawnFailed(run)) {
          results.push({
            harness: "pi",
            status: "failed",
            command,
            args,
            error: run.error?.message || "install_failed",
            detail: spawnFailureDetail(run, "pi install exited with error"),
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
          detail: options.statusBand
            ? `would install kxm plugin into omp and configure the focused subscription status band: ${command} ${args.join(" ")}`
            : `would install kxm plugin into omp: ${command} ${args.join(" ")}`,
        });
      } else {
        const run = spawnHarness(runtime, command, args);
        if (spawnFailed(run)) {
          results.push({
            harness: "omp",
            status: "failed",
            command,
            args,
            error: run.error?.message || "install_failed",
            detail: spawnFailureDetail(run, "omp plugin install exited with error"),
          });
        } else {
          const configFailure = options.statusBand ? configureOmpStatusBand(runtime, command) : undefined;
          if (configFailure) {
            results.push({
              harness: "omp",
              status: "failed",
              command,
              args: configFailure.args,
              error: "status_band_config_failed",
              detail: `installed kxm plugin into omp, but ${configFailure.args.slice(0, 3).join(" ")} failed: ${spawnFailureDetail(configFailure.run, "omp status band configuration exited with error")}${configFailure.rollbackAttempted ? (configFailure.rollbackFailed ? "; previous settings could not be fully restored" : "; previous settings restored") : ""}`,
            });
          } else {
            results.push({
              harness: "omp",
              status: "passed",
              command,
              args,
              detail: options.statusBand
                ? "installed kxm plugin into omp and configured the focused subscription status band; restart omp"
                : "installed kxm plugin into omp",
            });
          }
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
        const run = spawnHarness(runtime, command, installArgs);
        if (spawnFailed(run)) {
          results.push({
            harness: "claude",
            status: "failed",
            command,
            args: installArgs,
            error: run.error?.message || "install_failed",
            detail: spawnFailureDetail(run, "claude install exited with error"),
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

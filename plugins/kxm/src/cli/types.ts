import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { findKxmRepoRoot } from "../repo-root.ts";
import type { Command } from "commander";
import { redactSecrets } from "../redact.ts";
import { appendTelemetry, inferImprovementTarget, makeTelemetryEvent, telemetryPath } from "../telemetry.ts";
import { gateWorker, workerResult, type Worker, type WorkerOutcome } from "../envelope.ts";
import { canonicalWorkflowEvidenceKey, type WorkflowEvidenceInput } from "../workflow.ts";
import {
  HubBindingError,
  hubBindingFile,
  readHubBinding,
} from "../hub-binding.ts";
import type { InstallProbe } from "../kxm-install-kind.ts";

export interface CliSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  spawnHub?: (extraEnv: NodeJS.ProcessEnv) => number | Promise<number>;
  spawnWorker?: (extraEnv: NodeJS.ProcessEnv) => number | Promise<number>;
  installProbe?: Partial<InstallProbe>;
  spawnSync?: (command: string, args: readonly string[]) => CliSpawnResult;
}

export interface CliContext {
  env: NodeJS.ProcessEnv;
  io: CliIo;
  cwd: string;
}

export interface GlobalOpts {
  json?: boolean;
  dryRun?: boolean;
  workspace?: string;
}

export interface WorkspaceDirs {
  workdir: string;
  workspace: string;
  config: string;
  logs: string;
  assets: string;
  state: string;
}

export interface Runtime extends CliContext, Required<Pick<GlobalOpts, "json" | "dryRun">> {
  workspaceFlag?: string;
  dirs: WorkspaceDirs;
  serverUrl: string;
  boundHubUrl?: string;
  fetchImpl: typeof fetch;
}

export function spawnScript(scriptName: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [join(findKxmRepoRoot(import.meta.url), "scripts", scriptName)], {
      stdio: "inherit",
      env: { ...process.env, ...extraEnv },
    });
    child.once("error", () => resolveExit(1));
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
}

export function parseEvidencePairs(values: string[]): WorkflowEvidenceInput {
  const evidence = new Map<string, string>();
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error("evidence must use <required-key>=<evidence> syntax");
    }
    const requirement = canonicalWorkflowEvidenceKey(value.slice(0, separator));
    const proof = value.slice(separator + 1).trim();
    if (!requirement || !proof) throw new Error("evidence must use <required-key>=<evidence> syntax");
    if (evidence.has(requirement)) throw new Error(`duplicate normalized evidence key: ${requirement}`);
    evidence.set(requirement, proof);
  }
  return Object.fromEntries(evidence);
}

export const CLI_RESULT_SCHEMA = "kxm.cli-result.v1";

/** Every CLI payload carries a schema tag; payloads that already declare one
 * (worker envelopes) keep theirs. `ok:false` goes to stderr in both modes so
 * agents can split results from errors without parsing. */
export function print(io: CliIo, jsonMode: boolean, payload: object, text: string): void {
  const tagged = { schema: CLI_RESULT_SCHEMA, ...payload } as Record<string, unknown>;
  const safePayload = JSON.stringify(redactCliValue(tagged));
  const line = jsonMode ? `${safePayload}\n` : `${redactSecrets(text)}\n`;
  if (tagged.ok === false) io.stderr(line);
  else io.stdout(line);
}

/** One change a command would have made had `--dry-run` not been given. */
export interface PlannedChange {
  action: "write" | "delete" | "move" | "request" | "ssh";
  target: string;
}

/** The `--dry-run` answer of a mutating command: the envelope the real run
 * prints, marked `dryRun: true`, plus every write, request, or remote step it
 * would have taken. Nothing is written by the caller before or after this. */
export function printPlan(
  runtime: Runtime,
  payload: Record<string, unknown> & { command: string },
  planned: readonly PlannedChange[],
  text: string,
): void {
  print(runtime.io, runtime.json, { ok: true, ...payload, dryRun: true, planned }, [
    `dry run: ${text}`,
    ...(planned.length === 0 ? ["  no changes"] : planned.map((change) => `  would ${change.action} ${change.target}`)),
  ].join("\n"));
}

export const DRY_RUN_UNSUPPORTED = "dry_run_unsupported";

/** For a command that cannot say what it would do without doing some of it:
 * refuse under `--dry-run` instead of executing. */
export function refuseDryRun(io: CliIo, jsonMode: boolean, command: string, reason: string): number {
  print(io, jsonMode, { ok: false, command, dryRun: true, error: DRY_RUN_UNSUPPORTED, detail: reason }, `kxm ${command} --dry-run refused: ${reason}`);
  return 2;
}

export function printWorker(
  runtime: Runtime,
  worker: Worker,
  payload: Record<string, unknown> & { command: string; ok: boolean },
  text: string,
  outcome?: WorkerOutcome,
): void {
  const sessionId = runtime.env.KXM_SESSION_ID?.trim();
  const envelope = workerResult(worker, {
    ...payload,
    summary: text,
    ...(outcome ? { outcome } : {}),
    ...(sessionId ? { sessionId } : {}),
  });
  if (!runtime.dryRun) {
    try {
      const safeEnvelope = redactCliValue(envelope) as typeof envelope;
      appendTelemetry(telemetryPath(runtime.dirs.logs), makeTelemetryEvent({
        envelope: safeEnvelope,
        ...(sessionId ? { sessionId } : {}),
        host: hostMode(runtime),
        target: inferImprovementTarget({
          ...(worker.project ? { project: worker.project } : {}),
          env: runtime.env,
        }),
      }));
    } catch {
      // Telemetry must never fail the operator command.
    }
  }
  print(runtime.io, runtime.json, envelope, text);
}

export function hostMode(runtime: Runtime): "local" | "hub" {
  try {
    const hostname = new URL(runtime.serverUrl).hostname;
    if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") return "local";
  } catch {
    // Default local when the hub URL is not a URL.
  }
  return "hub";
}

export function gateOf(runtime: Runtime, name: string): ReturnType<typeof gateWorker> {
  const project = runtime.env.KXM_PROJECT?.trim();
  return gateWorker({ name, ...(project ? { project } : {}) });
}

export function redactCliValue(value: unknown, field = ""): unknown {
  if (typeof value === "string") {
    // These fields are public audit digests, not credentials. Preserve
    // them only by exact field name and shape; every other 64-hex value keeps
    // the conservative generic redaction behavior.
    if (
      (field === "requestSha256"
        || field === "replySha256"
        || field === "behavioralSha256"
        || field === "workflowDefinitionSha256"
        || field === "verifierConfigSha256"
        || field === "rolePromptSha256"
        || field === "contentSha256"
        || field === "configRevision"
        || field === "baseSha256"
        || field === "localSha256"
        || field === "targetSha256"
        || field === "sourceTemplateRevision"
        || field === "targetTemplateRevision"
        || field === "sourceDigest"
        || field === "decisionDigest"
        || field === "receiptSha256"
        || field === "sha256"
        || field === "valueSha256"
        || field === "baseRevision"
        || field === "candidateRevision"
        || field === "baseValueSha256"
        || field === "candidateValueSha256")
      && /^(?:sha256:)?[a-f0-9]{64}$/.test(value)
    ) return value;
    return redactSecrets(value);
  }
  if (Array.isArray(value)) return value.map((candidate) => redactCliValue(candidate));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, candidate]) => [key, redactCliValue(candidate, key)]),
    );
  }
  return value;
}

export function workspaceDirs(cwd: string, workspaceFlag: string | undefined, env: NodeJS.ProcessEnv): WorkspaceDirs {
  const workdir = resolve(env.KXM_WORKDIR?.trim() || cwd);
  const workspace = resolve(workdir, workspaceFlag || env.KXM_WORKSPACE_DIR?.trim() || ".kxm");
  const derive = workspaceFlag !== undefined;
  return {
    workdir,
    workspace,
    config: derive ? join(workspace, "config") : resolve(workdir, env.KXM_CONFIG_DIR?.trim() || join(workspace, "config")),
    logs: derive ? join(workspace, "logs") : resolve(workdir, env.KXM_LOGS_DIR?.trim() || join(workspace, "logs")),
    assets: derive ? join(workspace, "assets") : resolve(workdir, env.KXM_ASSETS_DIR?.trim() || join(workspace, "assets")),
    state: derive ? join(workspace, "state") : resolve(workdir, env.KXM_STATE_DIR?.trim() || join(workspace, "state")),
  };
}

export function maskEnvName(name: string): boolean {
  return /TOKEN|SECRET|KEY|PASSWORD/i.test(name);
}

export function redactConfiguredValues(text: string, env: NodeJS.ProcessEnv): string {
  let safe = text;
  for (const [name, value] of Object.entries(env)) {
    if (!maskEnvName(name) || !value || value.length < 4) continue;
    safe = safe.replaceAll(value, "[redacted]");
  }
  const trailingNewline = safe.endsWith("\n") ? "\n" : "";
  try {
    const parsed = JSON.parse(safe) as unknown;
    return `${JSON.stringify(redactCliValue(parsed))}${trailingNewline}`;
  } catch {
    // Human-readable output and diagnostics keep conservative generic
    // redaction, including opaque 64-hex values.
  }
  return redactSecrets(safe);
}

export function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function runtimeFrom(ctx: CliContext, command: Command): Runtime {
  const opts = command.optsWithGlobals() as GlobalOpts;
  const envServerUrl = ctx.env.KXM_SERVER_URL?.trim();
  let boundHubUrl: string | undefined;
  try {
    boundHubUrl = readHubBinding(ctx.env)?.url;
  } catch (error) {
    if (error instanceof HubBindingError) {
      ctx.io.stderr(`kxm: ignoring malformed hub binding at ${hubBindingFile(ctx.env)}; run kxm hub bind <url> again\n`);
    } else {
      throw error;
    }
  }
  return {
    ...ctx,
    json: Boolean(opts.json),
    dryRun: Boolean(opts.dryRun),
    ...(opts.workspace === undefined ? {} : { workspaceFlag: opts.workspace }),
    dirs: workspaceDirs(ctx.cwd, opts.workspace, ctx.env),
    serverUrl: envServerUrl || boundHubUrl || "http://127.0.0.1:7331",
    ...(boundHubUrl ? { boundHubUrl } : {}),
    fetchImpl: ctx.io.fetchImpl ?? fetch,
  };
}

export function workspaceEnv(runtime: Runtime): NodeJS.ProcessEnv {
  return {
    KXM_WORKDIR: runtime.dirs.workdir,
    KXM_WORKSPACE_DIR: runtime.dirs.workspace,
    KXM_CONFIG_DIR: runtime.dirs.config,
    KXM_LOGS_DIR: runtime.dirs.logs,
    KXM_ASSETS_DIR: runtime.dirs.assets,
    KXM_STATE_DIR: runtime.dirs.state,
    KXM_SERVER_URL: runtime.serverUrl,
  };
}

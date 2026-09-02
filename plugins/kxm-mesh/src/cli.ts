import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { verifyArtifactExists } from "./artifacts-exist.ts";
import { canonicalWorkflowEvidenceKey, parseWorkflowDefinitions } from "./workflow.ts";
import { postWorkflowSignal, watchGithubChecks } from "./github-watch.ts";
import { buildRetrospective, writeRetrospective } from "./retrospective.ts";
import { redactSecrets } from "./redact.ts";
import { SkillLifecycle, type SkillEvaluationKind, type SkillState } from "./skills.ts";
import { writeCompiledWiki } from "./wiki.ts";
import { agentWorker, gateWorker, workerResult, type Worker, type WorkerOutcome } from "./envelope.ts";
import { appendTelemetry, inferImprovementTarget, makeTelemetryEvent, readTelemetry, readRoutingRecords, telemetryPath } from "./telemetry.ts";
import { behavioralConfigHash, compareRoutingRecords, groupByBehavior } from "./routing.ts";
import { createSession, loadNamedWorkers, rosterNames, sessionAssetDirs, standardAssetDirs, workflowAssetDirs, writeSession } from "./session.ts";
import { buildImprovementReport, writeImprovementReport } from "./improve.ts";
import { runMeshTui } from "./tui.ts";
import { VnextConfigError, type VnextInitializationPlan } from "./vnext-config.ts";
import { initializeVnextProject } from "./vnext-init.ts";
import type { WorkflowEvidenceInput, WorkflowJournalEntry, WorkflowRun } from "./workflow.ts";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  spawnHub?: (extraEnv: NodeJS.ProcessEnv) => number | Promise<number>;
  spawnWorker?: (extraEnv: NodeJS.ProcessEnv) => number | Promise<number>;
}

const CLI_NAME = "kxm";
const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const USAGE_ERROR_CODES = new Set([
  "commander.help",
  "commander.helpDisplayed",
  "commander.unknownCommand",
  "commander.unknownOption",
  "commander.missingArgument",
  "commander.missingMandatoryOptionValue",
  "commander.invalidArgument",
  "commander.excessArguments",
  "commander.variadicArgNotLast",
  "commander.invalidOptionArgument",
  "commander.optionMissingArgument",
]);

interface CliContext {
  env: NodeJS.ProcessEnv;
  io: CliIo;
  cwd: string;
}

interface GlobalOpts {
  json?: boolean;
  dryRun?: boolean;
  workspace?: string;
}

interface Runtime extends CliContext, Required<Pick<GlobalOpts, "json" | "dryRun">> {
  workspaceFlag?: string;
  dirs: ReturnType<typeof workspaceDirs>;
  serverUrl: string;
  fetchImpl: typeof fetch;
}

function spawnScript(scriptName: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [join(repoRoot, "scripts", scriptName)], {
      stdio: "inherit",
      env: { ...process.env, ...extraEnv },
    });
    child.once("error", () => resolveExit(1));
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
}

function parseEvidencePairs(values: string[]): WorkflowEvidenceInput {
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

function print(io: CliIo, jsonMode: boolean, payload: object, text: string): void {
  const safePayload = JSON.stringify(redactCliValue(payload));
  io.stdout(jsonMode ? `${safePayload}\n` : `${redactSecrets(text)}\n`);
}

function printWorker(
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

function hostMode(runtime: Runtime): "local" | "mesh" {
  try {
    const hostname = new URL(runtime.serverUrl).hostname;
    if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") return "local";
  } catch {
    // Default local when the hub URL is not a URL.
  }
  return "mesh";
}

function gateOf(runtime: Runtime, name: string): ReturnType<typeof gateWorker> {
  const project = runtime.env.PI_MESH_PROJECT?.trim();
  return gateWorker({ name, ...(project ? { project } : {}) });
}

function redactCliValue(value: unknown, field = ""): unknown {
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
        || field === "configRevision")
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

function workspaceDirs(cwd: string, workspaceFlag: string | undefined, env: NodeJS.ProcessEnv) {
  const workdir = resolve(env.PI_MESH_WORKDIR?.trim() || cwd);
  const workspace = resolve(workdir, workspaceFlag || env.PI_MESH_WORKSPACE_DIR?.trim() || ".kxm");
  const derive = workspaceFlag !== undefined;
  return {
    workdir,
    workspace,
    config: derive ? join(workspace, "config") : resolve(workdir, env.PI_MESH_CONFIG_DIR?.trim() || join(workspace, "config")),
    logs: derive ? join(workspace, "logs") : resolve(workdir, env.PI_MESH_LOGS_DIR?.trim() || join(workspace, "logs")),
    assets: derive ? join(workspace, "assets") : resolve(workdir, env.PI_MESH_ASSETS_DIR?.trim() || join(workspace, "assets")),
    state: derive ? join(workspace, "state") : resolve(workdir, env.PI_MESH_STATE_DIR?.trim() || join(workspace, "state")),
  };
}

function maskEnvName(name: string): boolean {
  return /TOKEN|SECRET|KEY|PASSWORD/i.test(name);
}

function redactConfiguredValues(text: string, env: NodeJS.ProcessEnv): string {
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

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Authenticated hub POST for context operations. The CLI operates as the
 * control plane: the administrative token scopes one project per request. */
export async function hubContextPost(input: {
  serverUrl: string;
  path: string;
  body: Record<string, unknown>;
  authToken?: string;
  fetchImpl: typeof fetch;
}): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await input.fetchImpl(`${input.serverUrl.replace(/\/$/, "")}${input.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input.authToken ? { authorization: `Bearer ${input.authToken}` } : {}),
    },
    body: JSON.stringify(input.body),
  });
  const text = redactSecrets((await response.text()).slice(0, 64_000));
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep text for diagnostics without treating it as a secret.
  }
  return { ok: response.ok, status: response.status, body };
}

async function hubGet(url: string, fetchImpl: typeof fetch): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const response = await fetchImpl(url);
    const text = redactSecrets((await response.text()).slice(0, 8_000));
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Keep text for diagnostics without treating it as a secret.
    }
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: "hub_unreachable" } };
  }
}

function localWorkflowSnapshot(dataPath: string, runId?: string): { runs: WorkflowRun[]; journal: WorkflowJournalEntry[] } {
  if (!existsSync(dataPath)) throw new Error("state_database_not_found");
  const database = new DatabaseSync(dataPath, { readOnly: true });
  try {
    const rows = runId
      ? database.prepare("SELECT record FROM workflow_runs WHERE id = ?").all(runId) as Array<{ record: string }>
      : database.prepare("SELECT record FROM workflow_runs ORDER BY rowid DESC LIMIT 200").all() as Array<{ record: string }>;
    const runs = rows.map((row) => JSON.parse(row.record) as WorkflowRun);
    const journal = runId
      ? (database.prepare("SELECT record FROM workflow_journal WHERE run_id = ? ORDER BY rowid").all(runId) as Array<{ record: string }>).map((row) => JSON.parse(row.record) as WorkflowJournalEntry)
      : [];
    return { runs, journal };
  } finally { database.close(); }
}

async function postWorkflowStart(input: { serverUrl: string; definitionId: string; secret: string; deliveryId: string; event?: string; payload: Record<string, unknown>; fetchImpl: typeof fetch }): Promise<{ status: number; runId?: string; duplicate?: boolean }> {
  const payload = input.event && input.payload.event === undefined ? { ...input.payload, event: input.event } : input.payload;
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", input.secret).update(body).digest("hex")}`;
  const response = await input.fetchImpl(`${input.serverUrl.replace(/\/$/, "")}/v1/webhooks/${encodeURIComponent(input.definitionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature, "x-mesh-delivery-id": input.deliveryId, ...(input.event ? { "x-github-event": input.event } : {}) },
    body,
  });
  const responseText = (await response.text()).slice(0, 8_000);
  let parsed: { run?: { id?: string }; duplicate?: boolean } = {};
  try { parsed = JSON.parse(responseText) as typeof parsed; } catch { /* bounded adapter error */ }
  if (!response.ok) throw new Error(`workflow_start_http_${response.status}`);
  return { status: response.status, ...(parsed.run?.id ? { runId: parsed.run.id } : {}), duplicate: parsed.duplicate === true };
}

async function postWorkflowDegradation(input: {
  serverUrl: string;
  authToken: string;
  runId: string;
  stageId: string;
  requirementKey: string;
  reason: string;
  fetchImpl: typeof fetch;
}): Promise<{ status: number; duplicate: boolean; approvalId?: string }> {
  const response = await input.fetchImpl(
    `${input.serverUrl.replace(/\/$/, "")}/v1/workflows/${encodeURIComponent(input.runId)}/degradations`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stageId: input.stageId,
        requirementKey: input.requirementKey,
        reason: input.reason,
      }),
    },
  );
  const text = (await response.text()).slice(0, 8_000);
  let parsed: { duplicate?: boolean; approval?: { id?: string } } = {};
  try { parsed = JSON.parse(text) as typeof parsed; } catch { /* bounded adapter error */ }
  if (!response.ok) throw new Error(`workflow_degradation_http_${response.status}`);
  return {
    status: response.status,
    duplicate: parsed.duplicate === true,
    ...(parsed.approval?.id ? { approvalId: parsed.approval.id } : {}),
  };
}

function addGlobalOptions(command: Command): Command {
  return command
    .option("--json", "Print machine-readable JSON")
    .option("--dry-run", "Plan without making changes")
    .option("--workspace <dir>", "Workspace directory");
}

function runtimeFrom(ctx: CliContext, command: Command): Runtime {
  const opts = command.optsWithGlobals() as GlobalOpts;
  return {
    ...ctx,
    json: Boolean(opts.json),
    dryRun: Boolean(opts.dryRun),
    ...(opts.workspace === undefined ? {} : { workspaceFlag: opts.workspace }),
    dirs: workspaceDirs(ctx.cwd, opts.workspace, ctx.env),
    serverUrl: ctx.env.PI_MESH_SERVER_URL?.trim() || "http://127.0.0.1:7331",
    fetchImpl: ctx.io.fetchImpl ?? fetch,
  };
}

function workspaceEnv(runtime: Runtime): NodeJS.ProcessEnv {
  return {
    PI_MESH_WORKDIR: runtime.dirs.workdir,
    PI_MESH_WORKSPACE_DIR: runtime.dirs.workspace,
    PI_MESH_CONFIG_DIR: runtime.dirs.config,
    PI_MESH_LOGS_DIR: runtime.dirs.logs,
    PI_MESH_ASSETS_DIR: runtime.dirs.assets,
    PI_MESH_STATE_DIR: runtime.dirs.state,
  };
}

function activeWorkflowDefinition(runtime: Runtime, definitionId: string) {
  const inline = runtime.env.PI_MESH_WEBHOOK_WORKFLOWS?.trim();
  const file = runtime.env.PI_MESH_WEBHOOK_WORKFLOWS_FILE?.trim();
  if (inline && file) {
    throw new Error("configure only one of PI_MESH_WEBHOOK_WORKFLOWS or PI_MESH_WEBHOOK_WORKFLOWS_FILE");
  }
  if (!inline && !file) return undefined;
  let raw: string;
  if (file) {
    try {
      raw = readFileSync(resolve(runtime.cwd, file), "utf8");
    } catch {
      throw new Error("workflow definition file is unavailable");
    }
  } else {
    raw = inline!;
  }
  const definition = parseWorkflowDefinitions(raw, runtime.env).find((candidate) => candidate.id === definitionId);
  if (!definition) throw new Error(`workflow definition not found: ${definitionId}`);
  return definition;
}

function workflowCredential(runtime: Runtime, definitionId: string, kind: "start" | "signal"): string | undefined {
  const definition = activeWorkflowDefinition(runtime, definitionId);
  if (definition) return kind === "start" ? definition.secret : definition.signalSecret ?? definition.secret;
  return kind === "start"
    ? runtime.env.PI_MESH_WORKFLOW_SECRET?.trim()
    : runtime.env.PI_MESH_WORKFLOW_SIGNAL_SECRET?.trim();
}

function reportWorkflowConfigError(runtime: Runtime, error: unknown): number {
  const message = error instanceof Error ? redactSecrets(error.message) : "invalid workflow configuration";
  runtime.io.stderr(`${message}\n`);
  return 2;
}

function initPlanPayload(plan: VnextInitializationPlan): Record<string, unknown> {
  return {
    mode: plan.mode,
    inspectedFrom: plan.inspectedFrom,
    ...(plan.projectRoot ? { projectRoot: plan.projectRoot } : {}),
    ...(plan.legacyRoot ? { legacyRoot: plan.legacyRoot } : {}),
    changesRequired: plan.changesRequired,
    legacyInputs: plan.legacyInputs,
    issues: plan.issues,
    ...(plan.configRevision ? { configRevision: plan.configRevision } : {}),
  };
}

async function cmdVnextInit(runtime: Runtime, options: { name?: string; projectId?: string }): Promise<number> {
  if (runtime.workspaceFlag !== undefined) {
    print(runtime.io, runtime.json, {
      ok: false,
      command: "init",
      error: "workspace_option_unsupported",
    }, "kxm init discovers the authoritative Git root from the current directory; --workspace is not supported");
    return 2;
  }
  try {
    const initialized = initializeVnextProject(runtime.cwd, {
      ...(options.name?.trim() ? { projectName: options.name.trim() } : {}),
      ...(options.projectId?.trim() ? { projectId: options.projectId.trim() } : {}),
      dryRun: runtime.dryRun,
    });
    const payload = {
      ok: initialized.action !== "planned" || runtime.dryRun,
      command: "init",
      action: initialized.action,
      ...initPlanPayload(initialized.plan),
      files: initialized.files,
      ...(initialized.configRevision ? { configRevision: initialized.configRevision } : {}),
      plannedOnly: initialized.action === "planned",
    };
    if (initialized.action === "created") {
      print(runtime.io, runtime.json, payload, `initialized vNext project at ${initialized.projectRoot ?? runtime.cwd}`);
      return 0;
    }
    if (initialized.action === "validated") {
      print(runtime.io, runtime.json, payload, `validated vNext project at ${initialized.projectRoot ?? runtime.cwd}`);
      return 0;
    }
    if (runtime.dryRun) {
      print(runtime.io, runtime.json, payload, `init plan: ${initialized.plan.mode}`);
      return 0;
    }
    const next = initialized.plan.mode === "migrate"
      ? "legacy state requires reviewed migration; conversion is not available in this implementation slice"
      : "partial or invalid vNext state requires repair; no files were overwritten";
    print(runtime.io, runtime.json, payload, next);
    return 1;
  } catch (error) {
    if (error instanceof VnextConfigError) {
      print(runtime.io, runtime.json, {
        ok: false,
        command: "init",
        error: "vnext_initialization_failed",
        issues: error.issues,
      }, `vNext initialization failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, {
      ok: false,
      command: "init",
      error: "vnext_initialization_io_failed",
    }, "vNext initialization failed because a local filesystem operation did not complete");
    return 1;
  }
}

async function cmdInit(runtime: Runtime): Promise<number> {
  const created: string[] = [];
  for (const directory of [runtime.dirs.config, runtime.dirs.logs, runtime.dirs.assets, runtime.dirs.state, ...standardAssetDirs(runtime.dirs.assets)]) {
    if (runtime.dryRun) created.push(directory);
    else {
      mkdirSync(directory, { recursive: true });
      created.push(directory);
    }
  }
  // Workspace configuration is project-owned. Never seed a consumer with the
  // package repository's provider-specific dogfood roster or workflows.
  print(runtime.io, runtime.json, { ok: true, command: "init", created, templates: false }, `initialized ${runtime.dirs.workspace}`);
  return 0;
}

async function cmdValidate(runtime: Runtime, fileFlag?: string): Promise<number> {
  const worker = gateOf(runtime, "validate");
  const explicitFile = fileFlag?.trim();
  const configuredFile = runtime.env.PI_MESH_WEBHOOK_WORKFLOWS_FILE?.trim();
  const inline = runtime.env.PI_MESH_WEBHOOK_WORKFLOWS?.trim();
  if (!explicitFile && configuredFile && inline) {
    printWorker(
      runtime,
      worker,
      { ok: false, command: "validate", error: "ambiguous_workflow_source" },
      "configure only one of PI_MESH_WEBHOOK_WORKFLOWS or PI_MESH_WEBHOOK_WORKFLOWS_FILE",
    );
    return 2;
  }
  if (!explicitFile && !configuredFile && !inline) {
    printWorker(
      runtime,
      worker,
      { ok: false, command: "validate", error: "workflow_source_required" },
      "provide --file or configure exactly one workflow source environment variable",
    );
    return 2;
  }

  const selectedFile = explicitFile || configuredFile;
  const file = selectedFile ? resolve(runtime.cwd, selectedFile) : undefined;
  if (file && !existsSync(file)) {
    printWorker(runtime, worker, { ok: false, command: "validate", error: "file_not_found", file }, `workflow file not found: ${file}`);
    return 1;
  }
  try {
    const raw = file ? readFileSync(file, "utf8") : inline!;
    const warnings: string[] = [];
    const definitions = parseWorkflowDefinitions(raw, runtime.env, (message) => warnings.push(message));
    const secretEnvs = definitions.map((definition) => ({
      id: definition.id,
      secretConfigured: Boolean(definition.secret),
      signalSecretConfigured: Boolean(definition.signalSecret),
    }));
    const source = file ? "file" : "inline";
    printWorker(
      runtime,
      worker,
      { ok: true, command: "validate", source, ...(file ? { file } : {}), workflows: secretEnvs, warnings },
      `validated ${definitions.length} workflow(s) from ${source}${warnings.length ? ` with ${warnings.length} warning(s)` : ""}`,
      warnings.length ? "warning" : undefined,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? redactSecrets(error.message) : "invalid_workflow";
    printWorker(runtime, worker, { ok: false, command: "validate", error: message }, message);
    return 1;
  }
}

async function cmdArtifactsExist(runtime: Runtime, pathFlag: string): Promise<number> {
  const worker = gateOf(runtime, "artifacts-exist");
  const checked = verifyArtifactExists(runtime.dirs.assets, resolve(runtime.cwd, pathFlag));
  if (!checked.ok) {
    printWorker(
      runtime,
      worker,
      { ok: false, command: "artifacts-exist", error: checked.error, path: checked.path },
      `artifact verification failed: ${checked.error}`,
    );
    return 1;
  }
  printWorker(
    runtime,
    worker,
    { ok: true, command: "artifacts-exist", path: checked.path, bytes: checked.bytes },
    "artifact exists and is non-empty under workspace assets",
  );
  return 0;
}

async function cmdStatus(runtime: Runtime): Promise<number> {
  const health = await hubGet(`${runtime.serverUrl}/health`, runtime.fetchImpl);
  const ready = await hubGet(`${runtime.serverUrl}/ready`, runtime.fetchImpl);
  const payload = { ok: health.ok && ready.ok, command: "status", health: health.body, ready: ready.body };
  print(runtime.io, runtime.json, payload, `hub health=${health.ok} ready=${ready.ok}`);
  return payload.ok ? 0 : 1;
}

async function cmdMeshTui(runtime: Runtime): Promise<number> {
  const dataPath = resolve(runtime.dirs.workdir, runtime.env.PI_MESH_DATA_PATH?.trim() || join(runtime.dirs.state, "mesh.db"));
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, {
      ok: true,
      command: "tui",
      dryRun: true,
      serverUrl: runtime.serverUrl,
      transport: "sse",
    }, "would start mesh tui (SSE observer)");
    return 0;
  }
  if (runtime.json) {
    runtime.io.stderr("mesh tui does not support --json; use mesh status\n");
    return 2;
  }
  const project = runtime.env.PI_MESH_PROJECT?.trim() || basename(runtime.dirs.workdir) || "project";
  const authToken = runtime.env.PI_MESH_AUTH_TOKEN?.trim();
  return await runMeshTui({
    serverUrl: runtime.serverUrl,
    dataPath,
    stateDir: runtime.dirs.state,
    project,
    ...(authToken ? { authToken } : {}),
    fetchImpl: runtime.fetchImpl,
    stdout: runtime.io.stdout,
    stdin: process.stdin,
    isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
}

async function cmdHub(runtime: Runtime): Promise<number> {
  const extraEnv = workspaceEnv(runtime);
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: "hub", dryRun: true, workspace: runtime.dirs.workspace }, "would start hub");
    return 0;
  }
  return await (runtime.io.spawnHub ?? ((launchEnv) => spawnScript("pi-mesh-hub.mjs", launchEnv)))(extraEnv);
}

async function cmdWorker(runtime: Runtime, options: {
  name?: string;
  project?: string;
  model?: string;
  fallbackModels?: string;
  tools?: string;
  sessionIsolation?: string;
  continue?: boolean;
  freshStart?: boolean;
}): Promise<number> {
  const name = options.name?.trim() || runtime.env.PI_MESH_AGENT_NAME?.trim();
  const project = options.project?.trim() || runtime.env.PI_MESH_PROJECT?.trim();
  const model = options.model?.trim() || runtime.env.PI_MESH_WORKER_MODEL?.trim();
  const fallbackModels = options.fallbackModels?.trim() || runtime.env.PI_MESH_WORKER_FALLBACK_MODELS?.trim();
  const tools = options.tools?.trim() || runtime.env.PI_MESH_WORKER_TOOLS?.trim();
  const sessionIsolation = options.sessionIsolation?.trim() || runtime.env.PI_MESH_WORKER_SESSION_ISOLATION?.trim() || "off";
  if (sessionIsolation !== "workflow" && sessionIsolation !== "off") {
    runtime.io.stderr("worker --session-isolation must be workflow or off\n");
    return 2;
  }
  const extraEnv = {
    ...workspaceEnv(runtime),
    ...(name ? { PI_MESH_AGENT_NAME: name } : {}),
    ...(project ? { PI_MESH_PROJECT: project } : {}),
    ...(model ? { PI_MESH_WORKER_MODEL: model } : {}),
    ...(fallbackModels ? { PI_MESH_WORKER_FALLBACK_MODELS: fallbackModels } : {}),
    ...(tools ? { PI_MESH_WORKER_TOOLS: tools } : {}),
    PI_MESH_WORKER_SESSION_ISOLATION: sessionIsolation,
    ...(options.continue === false ? { PI_MESH_WORKER_CONTINUE: "false" } : {}),
    ...(options.freshStart ? { PI_MESH_WORKER_INITIAL_CONTINUE: "false" } : {}),
  };
  if (runtime.dryRun) {
    printWorker(runtime, agentWorker({
      name: name || "required",
      project: project || "required",
      ...(model ? { model } : {}),
    }), {
      ok: true,
      command: "worker",
      dryRun: true,
      workspace: runtime.dirs.workspace,
      name: name || "required",
      project: project || "required",
      model: model || "provider default",
      fallbackModels: fallbackModels || "none",
      tools: tools || "Pi defaults",
      sessionIsolation,
      continue: options.continue !== false,
      freshStart: Boolean(options.freshStart),
    }, "would start worker");
    return 0;
  }
  if (!name || !project) {
    runtime.io.stderr("worker requires --name and --project (or PI_MESH_AGENT_NAME and PI_MESH_PROJECT)\n");
    return 2;
  }
  return await (runtime.io.spawnWorker ?? ((launchEnv) => spawnScript("pi-mesh-worker.mjs", launchEnv)))(extraEnv);
}

async function cmdStop(runtime: Runtime, waitMsFlag?: string): Promise<number> {
  const pids = existsSync(runtime.dirs.state)
    ? readdirSync(runtime.dirs.state).filter((name) => name.endsWith(".pid"))
    : [];
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: "stop", dryRun: true, pidFiles: pids }, "would signal pid files");
    return 0;
  }
  if (pids.length === 0) {
    print(runtime.io, runtime.json, { ok: false, command: "stop", error: "no_pid_files" }, "no hub/worker pid files found");
    return 1;
  }
  const requested: string[] = [];
  const ignored: string[] = [];
  const records = new Map<string, { pid: number; startedAt: string; generation?: string }>();
  for (const file of pids) {
    try {
      const record = JSON.parse(readFileSync(join(runtime.dirs.state, file), "utf8")) as { version?: number; pid?: number; role?: string; startedAt?: string; generation?: string; controlFile?: string };
      const expectedControl = file === "hub.pid" ? "hub.stop" : file.startsWith("worker-") ? `${file.slice(0, -4)}.stop` : undefined;
      const expectedRole = file === "hub.pid" ? "hub" : file.startsWith("worker-") ? "worker" : undefined;
      if (record.version !== 1 || !Number.isInteger(record.pid) || record.pid! <= 0 || !record.startedAt || !expectedControl || record.controlFile !== expectedControl || record.role !== expectedRole || !processExists(record.pid!)) { ignored.push(file); continue; }
      writeFileSync(join(runtime.dirs.state, record.controlFile), `${JSON.stringify({ startedAt: record.startedAt, ...(record.generation ? { generation: record.generation } : {}), requestedAt: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600 });
      requested.push(file); records.set(file, { pid: record.pid!, startedAt: record.startedAt, ...(record.generation ? { generation: record.generation } : {}) });
    } catch { ignored.push(file); }
  }
  if (requested.length === 0) { print(runtime.io, runtime.json, { ok: false, command: "stop", requested, ignored }, "no current managed processes found"); return 1; }
  const waitMs = Math.min(30_000, Math.max(100, Number(waitMsFlag || 5_000)));
  const deadline = Date.now() + waitMs;
  const stopped = new Set<string>();
  while (Date.now() <= deadline && stopped.size < requested.length) {
    for (const [file, record] of records) {
      try {
        const current = JSON.parse(readFileSync(join(runtime.dirs.state, file), "utf8")) as { pid?: number; startedAt?: string; generation?: string };
        if (current.pid !== record.pid || current.startedAt !== record.startedAt || current.generation !== record.generation || !processExists(record.pid)) stopped.add(file);
      } catch { stopped.add(file); }
    }
    if (stopped.size < requested.length) await (runtime.io.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))))(100);
  }
  const timedOut = requested.filter((file) => !stopped.has(file));
  const ok = timedOut.length === 0;
  print(runtime.io, runtime.json, { ok, command: "stop", requested, stopped: [...stopped], timedOut, ignored }, ok ? "managed processes stopped" : "stop request timed out");
  return ok ? 0 : 1;
}

async function cmdSessionStatus(runtime: Runtime): Promise<number> {
  const stateDir = runtime.dirs.state;
  const names = existsSync(stateDir) ? readdirSync(stateDir) : [];
  const claims = [];
  for (const file of names.filter((name) => name.endsWith(".pid"))) {
    try {
      const record = JSON.parse(readFileSync(join(stateDir, file), "utf8")) as { pid?: number; role?: string; startedAt?: string; generation?: string };
      claims.push({
        file,
        role: record.role,
        pid: record.pid,
        startedAt: record.startedAt,
        live: Number.isInteger(record.pid) && record.pid! > 0 && processExists(record.pid!),
      });
    } catch {
      claims.push({ file, live: false, error: "invalid_pid_record" });
    }
  }
  const recoveries = [];
  for (const file of names.filter((name) => name.startsWith("worker-recovery-") && name.endsWith(".json"))) {
    try {
      const envelope = JSON.parse(readFileSync(join(stateDir, file), "utf8")) as {
        reason?: string;
        agentName?: string;
        project?: string;
        createdAt?: string;
        runId?: string | null;
        stageId?: string | null;
        freshSession?: boolean;
      };
      recoveries.push({
        file,
        reason: envelope.reason,
        agentName: envelope.agentName,
        project: envelope.project,
        createdAt: envelope.createdAt,
        runId: envelope.runId ?? undefined,
        stageId: envelope.stageId ?? undefined,
        freshSession: envelope.freshSession === true,
      });
    } catch {
      recoveries.push({ file, error: "invalid_recovery_envelope" });
    }
  }
  print(
    runtime.io,
    runtime.json,
    { ok: true, command: "session status", claims, recoveries },
    `${claims.length} session claim(s), ${recoveries.length} recovery envelope(s)`,
  );
  return 0;
}

async function cmdSessionStart(runtime: Runtime, options: { id?: string; workflow?: string; mix?: string }): Promise<number> {
  const id = options.id?.trim() || `session_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const workflowId = options.workflow?.trim();
  const mix = options.mix?.trim();
  if (workflowId && mix) {
    runtime.io.stderr("session start takes --workflow or --mix, not both\n");
    return 2;
  }
  if (!workflowId && !mix) {
    runtime.io.stderr("session start requires --workflow <id> or --mix <agent,gate,...>\n");
    return 2;
  }
  const project = runtime.env.PI_MESH_PROJECT?.trim();
  let workers: Worker[];
  try {
    const names = mix
      ? mix.split(",").map((name) => name.trim()).filter(Boolean)
      : rosterNames(runtime.dirs.config);
    workers = loadNamedWorkers(runtime.dirs.config, names, project);
  } catch (error) {
    const errorName = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (errorName !== "SessionConfigError") throw error;
    const message = error instanceof Error ? redactSecrets(error.message) : "invalid session configuration";
    runtime.io.stderr(`${message}\n`);
    return 2;
  }
  const session = createSession({
    id,
    host: hostMode(runtime),
    mode: workflowId ? "workflow" : "mix",
    workers,
    assetsDir: runtime.dirs.assets,
    ...(workflowId ? { workflowId } : {}),
  });
  const created = [
    ...sessionAssetDirs(runtime.dirs.assets, session.id),
    ...(workflowId ? workflowAssetDirs(runtime.dirs.assets, workflowId) : []),
  ];
  if (!runtime.dryRun) {
    for (const directory of created) mkdirSync(directory, { recursive: true });
    writeSession(runtime.dirs.assets, session);
  }
  print(runtime.io, runtime.json, {
    ok: true,
    command: "session start",
    dryRun: runtime.dryRun || undefined,
    session,
    created,
  }, `session ${session.id} (${session.mode})`);
  return 0;
}

async function cmdImprove(runtime: Runtime, targetFlag?: string): Promise<number> {
  const targets = targetFlag === "cli" || targetFlag === "project"
    ? [targetFlag] as Array<"cli" | "project">
    : ["cli", "project"] as Array<"cli" | "project">;
  const events = readTelemetry(telemetryPath(runtime.dirs.logs));
  const report = buildImprovementReport(events, targets);
  const path = writeImprovementReport(join(runtime.dirs.assets, "improvements"), report, runtime.dryRun);
  print(runtime.io, runtime.json, {
    ok: true,
    command: "improve",
    dryRun: runtime.dryRun || undefined,
    path,
    events: report.events,
    proposals: report.proposals.length,
    report,
  }, `proposed ${report.proposals.length} improvement(s) from ${report.events} event(s)`);
  return 0;
}

function parseContextKinds(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value.split(",").map((kind) => kind.trim()).filter((kind) => kind.length > 0);
}

async function cmdContextGet(runtime: Runtime, project: string, options: { role: string; task: string; run?: string; stage?: string; budget?: string; kinds?: string }): Promise<number> {
  const budget = options.budget === undefined ? undefined : Number(options.budget);
  if (options.budget !== undefined && (!Number.isInteger(budget) || (budget as number) < 512 || (budget as number) > 200_000)) {
    runtime.io.stderr("context get --budget must be an integer between 512 and 200000\n");
    return 2;
  }
  const body: Record<string, unknown> = {
    project,
    role: options.role,
    task: options.task,
  };
  if (options.run) body.workflowRunId = options.run;
  if (options.stage) body.stageId = options.stage;
  if (budget !== undefined) body.budgetTokens = budget;
  const kinds = parseContextKinds(options.kinds);
  if (kinds) body.includeKinds = kinds;
  const response = await hubContextPost({
    serverUrl: runtime.serverUrl,
    path: "/v1/context/get",
    body,
    ...(runtime.env.PI_MESH_AUTH_TOKEN?.trim() ? { authToken: runtime.env.PI_MESH_AUTH_TOKEN.trim() } : {}),
    fetchImpl: runtime.fetchImpl,
  });
  print(runtime.io, runtime.json, { ok: response.ok, command: "context get", status: response.status, ...(response.body as object) }, `context get ${response.ok ? "assembled" : `failed (${response.status})`}`);
  return response.ok ? 0 : 1;
}

async function cmdContextRecall(runtime: Runtime, project: string, options: { query?: string; kinds?: string; limit?: string }): Promise<number> {
  const body: Record<string, unknown> = { project };
  if (options.query) body.query = options.query;
  const kinds = parseContextKinds(options.kinds);
  if (kinds) body.kinds = kinds;
  if (options.limit) body.limit = Number(options.limit);
  const response = await hubContextPost({
    serverUrl: runtime.serverUrl,
    path: "/v1/context/recall",
    body,
    ...(runtime.env.PI_MESH_AUTH_TOKEN?.trim() ? { authToken: runtime.env.PI_MESH_AUTH_TOKEN.trim() } : {}),
    fetchImpl: runtime.fetchImpl,
  });
  print(runtime.io, runtime.json, { ok: response.ok, command: "context recall", status: response.status, ...(response.body as object) }, `context recall ${response.ok ? "complete" : `failed (${response.status})`}`);
  return response.ok ? 0 : 1;
}

async function cmdContextState(runtime: Runtime, project: string, key: string, options: { asOf?: string }): Promise<number> {
  const body: Record<string, unknown> = { project, key };
  if (options.asOf) body.asOf = options.asOf;
  const response = await hubContextPost({
    serverUrl: runtime.serverUrl,
    path: "/v1/context/state",
    body,
    ...(runtime.env.PI_MESH_AUTH_TOKEN?.trim() ? { authToken: runtime.env.PI_MESH_AUTH_TOKEN.trim() } : {}),
    fetchImpl: runtime.fetchImpl,
  });
  print(runtime.io, runtime.json, { ok: response.ok, command: "context state", status: response.status, ...(response.body as object) }, `context state ${response.ok ? "resolved" : `failed (${response.status})`}`);
  return response.ok ? 0 : 1;
}

async function cmdContextEpisode(runtime: Runtime, project: string, options: { run?: string }): Promise<number> {
  const body: Record<string, unknown> = { project };
  if (options.run) body.workflowRunId = options.run;
  const response = await hubContextPost({
    serverUrl: runtime.serverUrl,
    path: "/v1/context/episode",
    body,
    ...(runtime.env.PI_MESH_AUTH_TOKEN?.trim() ? { authToken: runtime.env.PI_MESH_AUTH_TOKEN.trim() } : {}),
    fetchImpl: runtime.fetchImpl,
  });
  print(runtime.io, runtime.json, { ok: response.ok, command: "context episode", status: response.status, ...(response.body as object) }, `context episode ${response.ok ? "complete" : `failed (${response.status})`}`);
  return response.ok ? 0 : 1;
}

async function cmdContextPromote(runtime: Runtime, project: string, proposalId: string, options: { evidence: string }): Promise<number> {
  const evidence = options.evidence.split(",").map((ref) => ref.trim()).filter((ref) => ref.length > 0);
  if (evidence.length === 0) {
    runtime.io.stderr("context promote --evidence must contain at least one durable evidence reference\n");
    return 2;
  }
  const response = await hubContextPost({
    serverUrl: runtime.serverUrl,
    path: "/v1/context/state/promote",
    body: { project, proposalId, evidence },
    ...(runtime.env.PI_MESH_AUTH_TOKEN?.trim() ? { authToken: runtime.env.PI_MESH_AUTH_TOKEN.trim() } : {}),
    fetchImpl: runtime.fetchImpl,
  });
  print(runtime.io, runtime.json, { ok: response.ok, command: "context promote", status: response.status, ...(response.body as object) }, `context promote ${response.ok ? "recorded" : `failed (${response.status})`}`);
  return response.ok ? 0 : 1;
}

async function cmdContextExplain(runtime: Runtime, project: string, itemId: string): Promise<number> {
  const response = await hubContextPost({
    serverUrl: runtime.serverUrl,
    path: "/v1/context/explain",
    body: { project, id: itemId },
    ...(runtime.env.PI_MESH_AUTH_TOKEN?.trim() ? { authToken: runtime.env.PI_MESH_AUTH_TOKEN.trim() } : {}),
    fetchImpl: runtime.fetchImpl,
  });
  print(runtime.io, runtime.json, { ok: response.ok, command: "context explain", status: response.status, ...(response.body as object) }, `context explain ${response.ok ? "complete" : `failed (${response.status})`}`);
  return response.ok ? 0 : 1;
}

async function cmdContextWikiCompile(runtime: Runtime, project: string, options: { out?: string }): Promise<number> {
  const response = await hubContextPost({
    serverUrl: runtime.serverUrl,
    path: "/v1/context/wiki/compile",
    body: { project },
    ...(runtime.env.PI_MESH_AUTH_TOKEN?.trim() ? { authToken: runtime.env.PI_MESH_AUTH_TOKEN.trim() } : {}),
    fetchImpl: runtime.fetchImpl,
  });
  if (!response.ok) {
    print(runtime.io, runtime.json, { ok: false, command: "context wiki-compile", status: response.status, body: response.body }, `wiki compile failed (${response.status})`);
    return 1;
  }
  const compiled = response.body as { audit: { pages: string[]; contradictions: number }; pages: { path: string; content: string }[] };
  let written: string[] = [];
  if (options.out) {
    const pages = new Map(compiled.pages.map((page) => [page.path, page.content]));
    written = writeCompiledWiki(options.out, { pages, index: pages.get(".kxm/knowledge/wiki/index.md") ?? "", audit: { project, pages: compiled.audit.pages, stateItems: 0, contextItems: 0, contradictions: compiled.audit.contradictions, compiledAt: "" } });
  }
  print(runtime.io, runtime.json, { ok: true, command: "context wiki-compile", project, pages: compiled.audit.pages, openContradictions: compiled.audit.contradictions, ...(written.length > 0 ? { written: written.length, outDir: options.out } : { dryRun: true }) }, `compiled ${compiled.audit.pages.length} wiki page(s)${written.length > 0 ? ` to ${options.out}` : " (dry-run)"}`);
  return 0;
}

async function cmdContextWikiLint(runtime: Runtime, project: string): Promise<number> {
  const response = await hubContextPost({
    serverUrl: runtime.serverUrl,
    path: "/v1/context/wiki/compile",
    body: { project },
    ...(runtime.env.PI_MESH_AUTH_TOKEN?.trim() ? { authToken: runtime.env.PI_MESH_AUTH_TOKEN.trim() } : {}),
    fetchImpl: runtime.fetchImpl,
  });
  if (!response.ok) {
    print(runtime.io, runtime.json, { ok: false, command: "context wiki-lint", status: response.status, body: response.body }, `wiki lint failed (${response.status})`);
    return 1;
  }
  const compiled = response.body as {
    audit: { stateItems: number; contextItems: number; contradictions: number; compiledAt: string };
    lint: { severity: string; rule: string; path: string; message: string }[];
  };
  const issues = compiled.lint;
  print(runtime.io, runtime.json, { ok: issues.length === 0, command: "context wiki-lint", project, issues, audit: compiled.audit }, issues.length === 0 ? "wiki lint clean" : `wiki lint found ${issues.length} issue(s)`);
  return issues.every((issue) => issue.severity !== "error") ? 0 : 1;
}

function skillStateFromFlag(value: string): SkillState {
  if (value === "candidate" || value === "promoted" || value === "quarantined" || value === "rejected") return value;
  throw new Error(`invalid skill state ${value}`);
}

function skillsRoot(runtime: Runtime): string {
  return join(runtime.dirs.workdir, ".kxm", "skills");
}

function csv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return items.length > 0 ? items : undefined;
}

async function cmdSkillsCreate(runtime: Runtime, options: { file: string; name: string; description?: string; createdBy: string; run?: string; journal?: string; receipt?: string; harness: string; models: string; supersedes?: string }): Promise<number> {
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: "skills create", dryRun: true, name: options.name }, "would create skill candidate");
    return 0;
  }
  const lifecycle = new SkillLifecycle(skillsRoot(runtime));
  try {
    const metadata = lifecycle.create({
      name: options.name,
      description: options.description ?? "",
      content: readFileSync(options.file, "utf8"),
      createdBy: options.createdBy,
      sources: {
        runIds: csv(options.run) ?? [],
        journalEntryIds: csv(options.journal) ?? [],
        evidenceReceipts: csv(options.receipt) ?? [],
      },
      compatibility: { harness: options.harness, models: csv(options.models) ?? [] },
      ...(options.supersedes ? { supersedes: options.supersedes } : {}),
    });
    print(runtime.io, runtime.json, { ok: true, command: "skills create", metadata }, `created skill candidate ${metadata.id}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`skills create failed: ${message}\n`);
    return 1;
  }
}

async function cmdSkillsEvaluate(runtime: Runtime, skillId: string, options: { kind: string; evaluator: string; fail?: boolean; score?: string; details?: string }): Promise<number> {
  const lifecycle = new SkillLifecycle(skillsRoot(runtime));
  try {
    const outcome = lifecycle.evaluate(skillId, {
      kind: options.kind as SkillEvaluationKind,
      evaluatorVersion: options.evaluator,
      passed: options.fail !== true,
      ...(options.score !== undefined ? { score: Number(options.score) } : {}),
      ...(options.details ? { details: options.details } : {}),
    });
    print(runtime.io, runtime.json, { ok: true, command: "skills evaluate", skillId, quarantined: outcome.quarantined, evaluation: outcome.evaluation }, `recorded ${options.kind} evaluation${outcome.quarantined ? " (candidate quarantined)" : ""}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`skills evaluate failed: ${message}\n`);
    return 1;
  }
}

async function cmdSkillsPromote(runtime: Runtime, skillId: string, options: { decidedBy: string; evidence: string; reason?: string }): Promise<number> {
  const lifecycle = new SkillLifecycle(skillsRoot(runtime));
  try {
    const metadata = lifecycle.promote(skillId, {
      decidedBy: options.decidedBy,
      reason: options.reason ?? "passed protected evaluation",
      evidenceRefs: csv(options.evidence) ?? [],
    });
    print(runtime.io, runtime.json, { ok: true, command: "skills promote", skillId, metadata }, `promoted skill ${skillId}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`skills promote failed: ${message}\n`);
    return 1;
  }
}

async function cmdSkillsReject(runtime: Runtime, skillId: string, options: { decidedBy: string; reason?: string }): Promise<number> {
  const lifecycle = new SkillLifecycle(skillsRoot(runtime));
  try {
    const metadata = lifecycle.reject(skillId, { decidedBy: options.decidedBy, reason: options.reason ?? "rejected" });
    print(runtime.io, runtime.json, { ok: true, command: "skills reject", skillId, metadata }, `rejected skill ${skillId} (history retained)`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`skills reject failed: ${message}\n`);
    return 1;
  }
}

async function cmdSkillsList(runtime: Runtime, options: { state: string }): Promise<number> {
  try {
    const lifecycle = new SkillLifecycle(skillsRoot(runtime));
    const state = skillStateFromFlag(options.state);
    const items = lifecycle.list(state).map((metadata) => ({
      id: metadata.id,
      name: metadata.name,
      version: metadata.version,
      createdBy: metadata.createdBy,
      createdAt: metadata.createdAt,
      models: metadata.compatibility.models,
    }));
    print(runtime.io, runtime.json, { ok: true, command: "skills list", state: options.state, skills: items }, `${items.length} ${state} skill(s)`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`skills list failed: ${message}\n`);
    return 1;
  }
}

async function cmdSkillsVerify(runtime: Runtime, skillId: string, options: { state: string }): Promise<number> {
  try {
    const lifecycle = new SkillLifecycle(skillsRoot(runtime));
    const state = skillStateFromFlag(options.state);
    const metadata = lifecycle.verify(state, skillId);
    print(runtime.io, runtime.json, { ok: true, command: "skills verify", skillId, state: options.state, contentSha256: metadata.contentSha256 }, `skill ${skillId} integrity verified`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`skills verify failed: ${message}\n`);
    return 1;
  }
}

async function cmdRoutingReport(runtime: Runtime, options: { file?: string }): Promise<number> {
  const file = options.file ?? telemetryPath(runtime.dirs.logs);
  const records = readRoutingRecords(file).map((entry) => entry.routing);
  if (records.length === 0) {
    print(runtime.io, runtime.json, { ok: true, command: "routing report", file, configurations: [] }, "no routing records in telemetry");
    return 0;
  }
  const configurations = [...groupByBehavior(records).entries()]
    .map(([hash, group]) => ({ ...compareRoutingRecords(group), behavioralSha256: hash }))
    .sort((left, right) => right.runs - left.runs || left.behavioralSha256.localeCompare(right.behavioralSha256));
  print(runtime.io, runtime.json, { ok: true, command: "routing report", file, configurations }, `${configurations.length} behavioral configuration(s) across ${records.length} routing record(s)`);
  return 0;
}

async function cmdWorkflowStart(runtime: Runtime, definitionIdArg: string | undefined, options: { payload?: string; deliveryId?: string; event?: string }): Promise<number> {
  const definitionId = definitionIdArg || runtime.env.PI_MESH_WORKFLOW_ID?.trim();
  const deliveryId = String(options.deliveryId || `cli-${randomUUID()}`);
  const event = options.event;
  const payloadFlag = options.payload ?? "{}";
  if (!definitionId) {
    runtime.io.stderr("workflow start requires <definitionId> (or PI_MESH_WORKFLOW_ID)\n");
    return 2;
  }
  let secret: string | undefined;
  try {
    secret = workflowCredential(runtime, definitionId, "start");
  } catch (error) {
    return reportWorkflowConfigError(runtime, error);
  }
  if (!secret) {
    runtime.io.stderr("workflow start requires PI_MESH_WORKFLOW_SECRET when no active definition source is configured\n");
    return 2;
  }
  let payload: Record<string, unknown>;
  try {
    const raw = payloadFlag.startsWith("@") ? readFileSync(resolve(runtime.cwd, payloadFlag.slice(1)), "utf8") : payloadFlag;
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    payload = value as Record<string, unknown>;
  } catch {
    print(runtime.io, runtime.json, { ok: false, command: "workflow start", error: "invalid_payload" }, "workflow payload must be a JSON object or @file");
    return 2;
  }
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: "workflow start", dryRun: true, definitionId, deliveryId, event }, "would POST a signed workflow webhook");
    return 0;
  }
  try {
    const response = await postWorkflowStart({ serverUrl: runtime.serverUrl, definitionId, secret, deliveryId, ...(event ? { event } : {}), payload, fetchImpl: runtime.fetchImpl });
    print(runtime.io, runtime.json, { ok: true, command: "workflow start", definitionId, deliveryId, ...response }, `started workflow ${response.runId ?? "accepted"}`);
    return 0;
  } catch {
    print(runtime.io, runtime.json, { ok: false, command: "workflow start", error: "workflow_start_failed" }, "signed workflow start failed");
    return 1;
  }
}

async function cmdWorkflowDegrade(runtime: Runtime, runId: string, stageId: string, options: { requirement?: string; reason?: string }): Promise<number> {
  const requirementKey = options.requirement?.trim() ?? "";
  const reason = options.reason?.trim() ?? "";
  const adminToken = runtime.env.PI_MESH_AUTH_TOKEN?.trim();
  if (!runId || !stageId || !requirementKey || !reason || !adminToken) {
    runtime.io.stderr("workflow degrade requires <runId> <stageId>, --requirement, --reason, and PI_MESH_AUTH_TOKEN\n");
    return 2;
  }
  const worker = gateOf(runtime, "degrade");
  if (runtime.dryRun) {
    printWorker(
      runtime,
      worker,
      { ok: true, command: "workflow degrade", dryRun: true, runId, stageId, requirementKey },
      `would approve configured degraded quorum for ${runId}/${stageId}/${requirementKey}`,
    );
    return 0;
  }
  try {
    const result = await postWorkflowDegradation({
      serverUrl: runtime.serverUrl,
      authToken: adminToken,
      runId,
      stageId,
      requirementKey,
      reason,
      fetchImpl: runtime.fetchImpl,
    });
    printWorker(
      runtime,
      worker,
      { ok: true, command: "workflow degrade", runId, stageId, requirementKey, ...result },
      result.duplicate ? "degraded quorum was already approved" : "approved configured degraded quorum",
    );
    return 0;
  } catch {
    printWorker(
      runtime,
      worker,
      { ok: false, command: "workflow degrade", error: "workflow_degradation_failed", runId, stageId, requirementKey },
      "workflow degradation approval failed",
    );
    return 1;
  }
}

async function cmdWorkflowInspect(runtime: Runtime, action: "list" | "get", runId?: string): Promise<number> {
  const dataPath = resolve(runtime.dirs.workdir, runtime.env.PI_MESH_DATA_PATH?.trim() || join(runtime.dirs.state, "mesh.db"));
  if (action === "get" && !runId) {
    runtime.io.stderr(`Usage: ${CLI_NAME} workflow get <runId>\n`);
    return 2;
  }
  try {
    const snapshot = localWorkflowSnapshot(dataPath, runId);
    if (runId && snapshot.runs.length === 0) {
      print(runtime.io, runtime.json, { ok: false, command: "workflow get", error: "workflow_not_found" }, "workflow not found");
      return 1;
    }
    const value = action === "get"
      ? { ok: true, command: "workflow get", run: snapshot.runs[0], journal: snapshot.journal }
      : { ok: true, command: "workflow list", runs: snapshot.runs };
    print(runtime.io, runtime.json, value, action === "get" ? `workflow ${runId}` : `${snapshot.runs.length} workflow(s)`);
    return 0;
  } catch {
    print(runtime.io, runtime.json, { ok: false, command: `workflow ${action}`, error: "state_unavailable" }, "local workflow state is unavailable");
    return 1;
  }
}

async function cmdSignal(runtime: Runtime, runId: string, signalKey: string, status: string, summary: string, evidenceArgs: string[], deliveryIdFlag?: string): Promise<number> {
  if (!runId || !signalKey || !status || !summary) {
    runtime.io.stderr(`Usage: ${CLI_NAME} gate signal <runId> <signalKey> <passed|warning|failed> <summary> [<required-key>=<evidence> ...]\n`);
    return 2;
  }
  if (status !== "passed" && status !== "warning" && status !== "failed") {
    runtime.io.stderr("status must be passed, warning, or failed\n");
    return 2;
  }
  let evidence: WorkflowEvidenceInput;
  try {
    evidence = parseEvidencePairs(evidenceArgs);
  } catch (error) {
    runtime.io.stderr(`${error instanceof Error ? error.message : "invalid evidence"}\n`);
    return 2;
  }
  const definitionId = runtime.env.PI_MESH_WORKFLOW_ID?.trim();
  if (!definitionId) {
    runtime.io.stderr("signal requires PI_MESH_WORKFLOW_ID\n");
    return 2;
  }
  let signalSecret: string | undefined;
  try {
    signalSecret = workflowCredential(runtime, definitionId, "signal");
  } catch (error) {
    return reportWorkflowConfigError(runtime, error);
  }
  if (!signalSecret) {
    runtime.io.stderr("signal requires PI_MESH_WORKFLOW_SIGNAL_SECRET when no active definition source is configured\n");
    return 2;
  }
  const worker = gateOf(runtime, "signal");
  if (runtime.dryRun) {
    printWorker(runtime, worker, { ok: true, command: "signal", runId, signalKey, status, summary, evidence }, "would post signed signal");
    return 0;
  }
  const deliveryId = String(deliveryIdFlag || `cli-signal:${randomUUID()}`);
  try {
    const posted = await postWorkflowSignal({
      serverUrl: runtime.serverUrl,
      definitionId,
      signalSecret,
      runId,
      signalKey,
      status,
      summary,
      evidence,
      deliveryId,
      fetchImpl: runtime.fetchImpl,
    });
    printWorker(runtime, worker, { ok: true, command: "signal", duplicate: posted.duplicate, deliveryId }, "posted signed signal");
    return 0;
  } catch {
    printWorker(runtime, worker, { ok: false, command: "signal", error: "signal_failed", deliveryId }, "signed signal failed");
    return 1;
  }
}

async function cmdGithubWatch(runtime: Runtime, options: {
  runId?: string;
  stageId?: string;
  signalKey?: string;
  repo?: string;
  pr?: string;
  required?: string;
  timeoutMs?: string;
  intervalMs?: string;
  deliveryId?: string;
}): Promise<number> {
  const token = runtime.env.GITHUB_TOKEN?.trim() || runtime.env.GH_TOKEN?.trim();
  const definitionId = runtime.env.PI_MESH_WORKFLOW_ID?.trim();
  const runId = String(options.runId || "");
  const stageId = String(options.stageId || "");
  const signalKey = String(options.signalKey || "");
  const repo = String(options.repo || "");
  const pr = Number(options.pr);
  if (!definitionId || !runId || !stageId || !signalKey || !repo || !Number.isInteger(pr)) {
    runtime.io.stderr("github watch requires PI_MESH_WORKFLOW_ID, --run-id, --stage-id, --signal-key, --repo, --pr\n");
    return 2;
  }
  let signalSecret: string | undefined;
  try {
    signalSecret = workflowCredential(runtime, definitionId, "signal");
  } catch (error) {
    return reportWorkflowConfigError(runtime, error);
  }
  if (!signalSecret) {
    runtime.io.stderr("github watch requires PI_MESH_WORKFLOW_SIGNAL_SECRET when no active definition source is configured\n");
    return 2;
  }
  const result = await watchGithubChecks({
    serverUrl: runtime.serverUrl,
    definitionId,
    signalSecret,
    runId,
    stageId,
    signalKey,
    repo,
    pr,
    required: options.required
      ? [...new Set(String(options.required).split(",").map((name) => name.trim()).filter(Boolean))]
      : [],
    timeoutMs: Number(options.timeoutMs || 1_800_000),
    intervalMs: Number(options.intervalMs || 15_000),
    ...(options.deliveryId ? { deliveryId: options.deliveryId } : {}),
    ...(token ? { token } : {}),
    dryRun: runtime.dryRun,
    fetchImpl: runtime.fetchImpl,
    ...(runtime.io.now ? { now: runtime.io.now } : {}),
    ...(runtime.io.sleep ? { sleep: runtime.io.sleep } : {}),
  });
  const worker = gateOf(runtime, "github-watch");
  const payload = {
    ok: result.exitCode === 0,
    command: "github watch",
    posted: result.posted,
    status: result.status,
    summary: result.summary,
    evidence: result.evidence,
    deliveryId: result.deliveryId,
    skipped: result.skipped,
  };
  const outcome: WorkerOutcome = result.exitCode === 0
    ? (result.status === "warning" ? "warning" : "passed")
    : "failed";
  if (JSON.stringify(payload).includes(token ?? "___never___") || Object.keys(runtime.env).some((key) => maskEnvName(key) && JSON.stringify(payload).includes(String(runtime.env[key])))) {
    printWorker(runtime, worker, { ok: false, command: "github watch", error: "redaction_failure" }, "refusing to print a payload that contains a secret");
    return 1;
  }
  printWorker(runtime, worker, payload, result.summary, outcome);
  return result.exitCode;
}

async function cmdRetrospectiveExport(runtime: Runtime, runId: string, options: { input?: string; outDir?: string }): Promise<number> {
  if (!runId) {
    runtime.io.stderr(`Usage: ${CLI_NAME} workflow export <runId>\n`);
    return 2;
  }
  const snapshotFlag = String(options.input || "");
  const snapshotPath = snapshotFlag ? resolve(runtime.cwd, snapshotFlag) : "";
  let snapshot: { run: WorkflowRun; journal: WorkflowJournalEntry[] };
  try {
    if (snapshotPath) {
      if (!existsSync(snapshotPath)) throw new Error("snapshot_missing");
      snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as typeof snapshot;
    } else {
      const dataPath = resolve(runtime.dirs.workdir, runtime.env.PI_MESH_DATA_PATH?.trim() || join(runtime.dirs.state, "mesh.db"));
      const local = localWorkflowSnapshot(dataPath, runId);
      if (!local.runs[0]) throw new Error("workflow_not_found");
      snapshot = { run: local.runs[0], journal: local.journal };
    }
    if (snapshot.run.id !== runId) throw new Error("run_id_mismatch");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "snapshot_invalid";
    print(runtime.io, runtime.json, { ok: false, command: "retrospective export", error: reason }, "retrospective source is invalid or unavailable");
    return 1;
  }
  const doc = buildRetrospective(snapshot.run, snapshot.journal);
  const outDir = resolve(runtime.cwd, String(options.outDir || join(runtime.dirs.assets, "retrospectives")));
  const assetsRoot = resolve(runtime.dirs.assets);
  const assetsPrefix = `${assetsRoot}${process.platform === "win32" ? "\\" : "/"}`;
  if (outDir !== assetsRoot && !outDir.startsWith(assetsPrefix)) {
    print(runtime.io, runtime.json, { ok: false, command: "retrospective export", error: "output_outside_workspace_assets" }, "retrospectives must stay under the workspace assets directory");
    return 2;
  }
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: "retrospective export", dryRun: true, runId: doc.runId }, `would export ${doc.runId}`);
    return 0;
  }
  const written = writeRetrospective(outDir, doc);
  print(runtime.io, runtime.json, { ok: true, command: "retrospective export", ...written, reviewDecision: doc.reviewDecision }, `exported ${written.jsonPath}`);
  return 0;
}

async function cmdSmoke(runtime: Runtime, realPi: boolean): Promise<number> {
  if (runtime.env.PI_MESH_SMOKE !== "1" && !realPi) {
    print(runtime.io, runtime.json, { ok: true, skipped: true, reason: "PI_MESH_SMOKE is not 1" }, "smoke skipped");
    return 0;
  }
  return await spawnScript("smoke-multi-pi.mjs", { PI_MESH_SMOKE: "1", ...workspaceEnv(runtime) });
}

function createProgram(ctx: CliContext, result: { code: number }): Command {
  const bind = (action: (runtime: Runtime, ...args: never[]) => Promise<number>) => {
    return async function commandAction(this: Command, ...args: unknown[]) {
      const command = args.at(-1) instanceof Command ? args.at(-1) as Command : this;
      result.code = await (action as (runtime: Runtime, ...rest: unknown[]) => Promise<number>)(runtimeFrom(ctx, command), ...args.slice(0, -1));
    };
  };

  const program = new Command(CLI_NAME);
  program
    .description("KontextMind local-first orchestration and mesh CLI")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => ctx.io.stdout(text),
      writeErr: (text) => ctx.io.stderr(text),
    })
    .helpCommand("help", "Show help");
  addGlobalOptions(program);

  program.command("init").description("Create, validate, or plan migration of a vNext project")
    .option("--json", "Print machine-readable JSON")
    .option("--dry-run", "Plan without making changes")
    .option("--name <name>", "Project display name for a new project")
    .option("--project-id <id>", "Stable project ID for controlled provisioning")
    .action(async function initAction(this: Command, options: { name?: string; projectId?: string }) {
      result.code = await cmdVnextInit(runtimeFrom(ctx, this), options);
    });

  const agent = addGlobalOptions(program.command("agent").description("Run and supervise agents"));
  agent.helpCommand("help", "Show agent help");
  addGlobalOptions(agent.command("worker").description("Start a long-lived Pi worker"))
    .option("--name <name>", "Agent name")
    .option("--project <project>", "Mesh project")
    .option("--model <id>", "Primary model")
    .option("--fallback-models <ids>", "Comma-separated fallback models")
    .option("--tools <names>", "Comma-separated Pi tool allowlist")
    .option("--session-isolation <mode>", "Pi session isolation: workflow or off (default: off for upgrade compatibility)")
    .option("--no-continue", "Disable every session resume")
    .option("--fresh-start", "Skip only the initial session resume")
    .action(async function workerAction(this: Command, options: {
      name?: string;
      project?: string;
      model?: string;
      fallbackModels?: string;
      tools?: string;
      sessionIsolation?: string;
      continue?: boolean;
      freshStart?: boolean;
    }) {
      result.code = await cmdWorker(runtimeFrom(ctx, this), options);
    });

  const session = addGlobalOptions(program.command("session").description("Create manifests and inspect or drain Pi worker sessions"));
  session.helpCommand("help", "Show session help");
  addGlobalOptions(session.command("status").description("Show session claims and recovery envelopes")).action(bind(cmdSessionStatus));
  addGlobalOptions(session.command("start").description("Create an agent/gate or workflow session manifest (does not launch processes)"))
    .option("--id <id>", "Session id")
    .option("--workflow <id>", "Workflow definition id")
    .option("--mix <names>", "Comma-separated agent and gate names")
    .action(async function sessionStartAction(this: Command, options: { id?: string; workflow?: string; mix?: string }) {
      result.code = await cmdSessionStart(runtimeFrom(ctx, this), options);
    });
  addGlobalOptions(session.command("stop").description("Request managed hub and worker session shutdown"))
    .option("--wait-ms <ms>", "How long to wait for PID files to clear")
    .action(async function sessionStopAction(this: Command, options: { waitMs?: string }) {
      result.code = await cmdStop(runtimeFrom(ctx, this), options.waitMs);
    });

  const workflow = addGlobalOptions(program.command("workflow").description("Start and inspect workflow runs"));
  workflow.helpCommand("help", "Show workflow help");
  addGlobalOptions(workflow.command("list").description("List local workflow runs")).action(async function listAction(this: Command) {
    result.code = await cmdWorkflowInspect(runtimeFrom(ctx, this), "list");
  });
  addGlobalOptions(workflow.command("get").description("Show one local workflow run"))
    .argument("<runId>", "Workflow run ID")
    .action(async function getAction(this: Command, runId: string) {
      result.code = await cmdWorkflowInspect(runtimeFrom(ctx, this), "get", runId);
    });
  addGlobalOptions(workflow.command("start").description("POST a signed workflow-start webhook"))
    .argument("[definitionId]", "Workflow definition ID")
    .option("--payload <json>", "JSON object or @file", "{}")
    .option("--delivery-id <id>", "Stable provider delivery ID")
    .option("--event <name>", "Optional provider event name")
    .action(async function startAction(this: Command, definitionId: string | undefined, options: { payload?: string; deliveryId?: string; event?: string }) {
      result.code = await cmdWorkflowStart(runtimeFrom(ctx, this), definitionId, options);
    });
  addGlobalOptions(workflow.command("export").description("Export a proposed retrospective"))
    .argument("<runId>", "Workflow run ID")
    .option("--input <file>", "Offline snapshot JSON")
    .option("--out-dir <dir>", "Directory under workspace assets")
    .action(async function exportAction(this: Command, runId: string, options: { input?: string; outDir?: string }) {
      result.code = await cmdRetrospectiveExport(runtimeFrom(ctx, this), runId, options);
    });

  const gate = addGlobalOptions(program.command("gate").description("Validate definitions and operate evidence gates"));
  gate.helpCommand("help", "Show gate help");
  addGlobalOptions(gate.command("validate").description("Parse workflow definitions without printing secrets"))
    .option("--file <path>", "Workflow definition file")
    .action(async function validateAction(this: Command, options: { file?: string }) {
      result.code = await cmdValidate(runtimeFrom(ctx, this), options.file);
    });
  addGlobalOptions(gate.command("artifacts-exist").description("Verify a non-empty file under workspace assets"))
    .requiredOption("--path <file>", "Artifact file under workspace assets")
    .action(async function artifactsExistAction(this: Command, options: { path: string }) {
      result.code = await cmdArtifactsExist(runtimeFrom(ctx, this), options.path);
    });
  addGlobalOptions(gate.command("degrade").description("Approve a configured lower peer quorum"))
    .argument("<runId>", "Workflow run ID")
    .argument("<stageId>", "Active stage ID")
    .option("--requirement <key>", "Canonical requirement key")
    .option("--reason <text>", "Non-secret operator reason")
    .action(async function degradeAction(this: Command, runId: string, stageId: string, options: { requirement?: string; reason?: string }) {
      result.code = await cmdWorkflowDegrade(runtimeFrom(ctx, this), runId, stageId, options);
    });
  addGlobalOptions(gate.command("signal").description("Post a signed workflow callback"))
    .argument("<runId>", "Workflow run ID")
    .argument("<signalKey>", "Wait signal key")
    .argument("<status>", "passed, warning, or failed")
    .argument("<summary>", "Callback summary")
    .argument("[evidence...]", "required-key=evidence pairs")
    .option("--delivery-id <id>", "Stable callback delivery ID")
    .action(async function signalAction(this: Command, runId: string, signalKey: string, status: string, summary: string, evidence: string[], options: { deliveryId?: string }) {
      result.code = await cmdSignal(runtimeFrom(ctx, this), runId, signalKey, status, summary, evidence ?? [], options.deliveryId);
    });
  const github = addGlobalOptions(gate.command("github").description("GitHub adapters"));
  github.helpCommand("help", "Show GitHub help");
  addGlobalOptions(github.command("watch").description("Poll required checks and post the signed signal"))
    .option("--run-id <id>", "Workflow run ID")
    .option("--stage-id <id>", "Waiting stage ID")
    .option("--signal-key <key>", "Wait signal key")
    .option("--repo <owner/name>", "GitHub repository")
    .option("--pr <number>", "Pull request number")
    .option("--required <names>", "Comma-separated required check names")
    .option("--timeout-ms <ms>", "Watch timeout")
    .option("--interval-ms <ms>", "Poll interval")
    .option("--delivery-id <id>", "Stable callback delivery ID")
    .action(async function watchAction(this: Command, options: {
      runId?: string;
      stageId?: string;
      signalKey?: string;
      repo?: string;
      pr?: string;
      required?: string;
      timeoutMs?: string;
      intervalMs?: string;
      deliveryId?: string;
    }) {
      result.code = await cmdGithubWatch(runtimeFrom(ctx, this), options);
    });

  addGlobalOptions(program.command("improve").description("Propose CLI or project improvements from telemetry JSONL"))
    .option("--target <cli|project>", "Limit proposals to cli or project")
    .action(async function improveAction(this: Command, options: { target?: string }) {
      result.code = await cmdImprove(runtimeFrom(ctx, this), options.target);
    });

  const context = addGlobalOptions(program.command("context").description("KXM context operating-system queries"));
  context.helpCommand("help", "Show context help");
  addGlobalOptions(context.command("get").description("Assemble a role-aware context packet"))
    .argument("<project>", "Project scope")
    .requiredOption("--role <role>", "Requesting role (repro, planner, critic, implementer, verifier, or custom)")
    .requiredOption("--task <task>", "What the role is trying to do")
    .option("--run <runId>", "Workflow run scope")
    .option("--stage <stageId>", "Workflow stage scope")
    .option("--budget <tokens>", "Token budget for the packet")
    .option("--kinds <kinds>", "Comma-separated item kinds to include")
    .action(async function contextGetAction(this: Command, project: string, options: { role: string; task: string; run?: string; stage?: string; budget?: string; kinds?: string }) {
      result.code = await cmdContextGet(runtimeFrom(ctx, this), project, options);
    });
  addGlobalOptions(context.command("recall").description("Search durable context records (metadata only)"))
    .argument("<project>", "Project scope")
    .option("--query <text>", "Substring query against summaries and state keys")
    .option("--kinds <kinds>", "Comma-separated item kinds to include")
    .option("--limit <n>", "Maximum results (1-100)")
    .action(async function contextRecallAction(this: Command, project: string, options: { query?: string; kinds?: string; limit?: string }) {
      result.code = await cmdContextRecall(runtimeFrom(ctx, this), project, options);
    });
  addGlobalOptions(context.command("state").description("Current or historical value for one state key"))
    .argument("<project>", "Project scope")
    .argument("<key>", "State key")
    .option("--as-of <iso>", "Historical timestamp query")
    .action(async function contextStateAction(this: Command, project: string, key: string, options: { asOf?: string }) {
      result.code = await cmdContextState(runtimeFrom(ctx, this), project, key, options);
    });
  addGlobalOptions(context.command("episode").description("Episodic learning records from workflow journals"))
    .argument("<project>", "Project scope")
    .option("--run <runId>", "Limit to one workflow run")
    .action(async function contextEpisodeAction(this: Command, project: string, options: { run?: string }) {
      result.code = await cmdContextEpisode(runtimeFrom(ctx, this), project, options);
    });
  addGlobalOptions(context.command("promote").description("Promote an approved state proposal (control plane)"))
    .argument("<project>", "Project scope")
    .argument("<proposalId>", "State proposal ID")
    .requiredOption("--evidence <refs>", "Comma-separated durable evidence references")
    .action(async function contextPromoteAction(this: Command, project: string, proposalId: string, options: { evidence: string }) {
      result.code = await cmdContextPromote(runtimeFrom(ctx, this), project, proposalId, options);
    });
  addGlobalOptions(context.command("explain").description("Explain which evidence and lineage back a context item"))
    .argument("<project>", "Project scope")
    .argument("<itemId>", "Context item ID")
    .action(async function contextExplainAction(this: Command, project: string, itemId: string) {
      result.code = await cmdContextExplain(runtimeFrom(ctx, this), project, itemId);
    });

  addGlobalOptions(context.command("wiki-compile").description("Compile the Karpathy-style knowledge wiki for review"))
    .argument("<project>", "Project scope")
    .option("--out <dir>", "Workspace root to write .kxm/knowledge/wiki into (default: dry-run output only)")
    .action(async function contextWikiCompileAction(this: Command, project: string, options: { out?: string }) {
      result.code = await cmdContextWikiCompile(runtimeFrom(ctx, this), project, options);
    });
  addGlobalOptions(context.command("wiki-lint").description("Lint a compiled wiki for broken refs, orphans, and stale state"))
    .argument("<project>", "Project scope")
    .action(async function contextWikiLintAction(this: Command, project: string) {
      result.code = await cmdContextWikiLint(runtimeFrom(ctx, this), project);
    });

  const skills = addGlobalOptions(program.command("skills").description("Governed skill candidate lifecycle"));
  skills.helpCommand("help", "Show skills help");
  addGlobalOptions(skills.command("create").description("Submit a skill candidate from verified episodes"))
    .requiredOption("--file <path>", "SKILL.md content file")
    .requiredOption("--name <name>", "Skill name")
    .option("--description <text>", "Short description")
    .requiredOption("--created-by <id>", "Author identity")
    .option("--run <ids>", "Comma-separated source run IDs")
    .option("--journal <ids>", "Comma-separated source journal entry IDs")
    .option("--receipt <refs>", "Comma-separated evidence receipts")
    .requiredOption("--harness <name>", "Harness compatibility (pi, claude-code, ...)" )
    .requiredOption("--models <models>", "Comma-separated compatible models")
    .option("--supersedes <id>", "Prior skill this candidate supersedes")
    .action(async function skillsCreateAction(this: Command, options: { file: string; name: string; description?: string; createdBy: string; run?: string; journal?: string; receipt?: string; harness: string; models: string; supersedes?: string }) {
      result.code = await cmdSkillsCreate(runtimeFrom(ctx, this), options);
    });
  addGlobalOptions(skills.command("evaluate").description("Record a protected evaluation for a candidate"))
    .argument("<skillId>", "Skill candidate ID")
    .requiredOption("--kind <kind>", "static-review, sandbox, functional, safety, or optimization")
    .requiredOption("--evaluator <version>", "Evaluator version")
    .option("--fail", "Record a failed evaluation")
    .option("--score <n>", "Numeric score")
    .option("--details <text>", "Bounded evaluation details")
    .action(async function skillsEvaluateAction(this: Command, skillId: string, options: { kind: string; evaluator: string; fail?: boolean; score?: string; details?: string }) {
      result.code = await cmdSkillsEvaluate(runtimeFrom(ctx, this), skillId, options);
    });
  addGlobalOptions(skills.command("promote").description("Promote a candidate that passed all protected evaluations"))
    .argument("<skillId>", "Skill candidate ID")
    .requiredOption("--decided-by <id>", "Promoter identity (must differ from the author)")
    .requiredOption("--evidence <refs>", "Comma-separated durable evidence references")
    .option("--reason <text>", "Decision reason")
    .action(async function skillsPromoteAction(this: Command, skillId: string, options: { decidedBy: string; evidence: string; reason?: string }) {
      result.code = await cmdSkillsPromote(runtimeFrom(ctx, this), skillId, options);
    });
  addGlobalOptions(skills.command("reject").description("Reject a candidate; history is retained for learning"))
    .argument("<skillId>", "Skill candidate ID")
    .requiredOption("--decided-by <id>", "Decider identity")
    .option("--reason <text>", "Decision reason")
    .action(async function skillsRejectAction(this: Command, skillId: string, options: { decidedBy: string; reason?: string }) {
      result.code = await cmdSkillsReject(runtimeFrom(ctx, this), skillId, options);
    });
  addGlobalOptions(skills.command("list").description("List skills by state"))
    .option("--state <state>", "candidate, promoted, quarantined, or rejected", "promoted")
    .action(async function skillsListAction(this: Command, options: { state: string }) {
      result.code = await cmdSkillsList(runtimeFrom(ctx, this), options);
    });
  addGlobalOptions(skills.command("verify").description("Verify a stored skill against its pinned content hash"))
    .argument("<skillId>", "Skill ID")
    .option("--state <state>", "candidate, promoted, quarantined, or rejected", "promoted")
    .action(async function skillsVerifyAction(this: Command, skillId: string, options: { state: string }) {
      result.code = await cmdSkillsVerify(runtimeFrom(ctx, this), skillId, options);
    });

  const routing = addGlobalOptions(program.command("routing").description("Model/harness routing telemetry and behavioral comparisons"));
  routing.helpCommand("help", "Show routing help");
  addGlobalOptions(routing.command("report").description("Compare verified completion, cost, and rework per behavioral configuration"))
    .option("--file <path>", "Telemetry JSONL file (default: workspace telemetry)")
    .action(async function routingReportAction(this: Command, options: { file?: string }) {
      result.code = await cmdRoutingReport(runtimeFrom(ctx, this), options);
    });

  const mesh = addGlobalOptions(program.command("mesh").description("Local and multi-machine mesh hub"));
  mesh.helpCommand("help", "Show mesh help");
  addGlobalOptions(mesh.command("init").description("Create .kxm directories")).action(bind(cmdInit));
  addGlobalOptions(mesh.command("status").description("Check hub /health and /ready")).action(bind(cmdStatus));
  addGlobalOptions(mesh.command("tui").description("Live mesh observer TUI (SSE presence, no bodies)")).action(bind(cmdMeshTui));
  addGlobalOptions(mesh.command("hub").description("Start the mesh hub")).action(bind(cmdHub));
  addGlobalOptions(mesh.command("stop").description("Request managed hub and worker shutdown"))
    .option("--wait-ms <ms>", "How long to wait for PID files to clear")
    .action(async function stopAction(this: Command, options: { waitMs?: string }) {
      result.code = await cmdStop(runtimeFrom(ctx, this), options.waitMs);
    });
  addGlobalOptions(mesh.command("smoke").description("Opt-in two-worker real-Pi release harness"))
    .option("--real-pi", "Run even when PI_MESH_SMOKE is unset")
    .action(async function smokeAction(this: Command, options: { realPi?: boolean }) {
      result.code = await cmdSmoke(runtimeFrom(ctx, this), Boolean(options.realPi));
    });

  return program;
}

function mapCommanderError(error: CommanderError): number {
  if (error.exitCode === 0) return 0;
  if (USAGE_ERROR_CODES.has(error.code)) return 2;
  return error.exitCode || 1;
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) },
  cwd = process.cwd(),
): Promise<number> {
  const originalStdout = io.stdout;
  const originalStderr = io.stderr;
  io = { ...io, stdout: (text) => originalStdout(redactConfiguredValues(text, env)), stderr: (text) => originalStderr(redactConfiguredValues(text, env)) };
  const result = { code: 0 };
  const program = createProgram({ env, io, cwd }, result);
  try {
    await program.parseAsync(argv, { from: "user" });
    return result.code;
  } catch (error) {
    if (error instanceof CommanderError) return mapCommanderError(error);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}

import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import {
  createMemoryNote,
  formatMemoryBriefText,
  generateMemoryBrief,
  syncHarnessMemory,
  type MemoryScope,
} from "./memory.ts";
import { createBackup, restoreBackup } from "./database.ts";
import { verifyArtifactExists } from "./artifacts-exist.ts";
import { canonicalWorkflowEvidenceKey, parseWorkflowDefinitions } from "./workflow.ts";
import { postWorkflowSignal, watchGithubChecks } from "./github-watch.ts";
import { buildRetrospective, writeRetrospective } from "./retrospective.ts";
import { redactSecrets } from "./redact.ts";
import { SkillLifecycle, type SkillEvaluationKind, type SkillState } from "./skills.ts";
import { writeCompiledWiki } from "./wiki.ts";
import { agentWorker, gateWorker, workerResult, type Worker, type WorkerOutcome } from "./envelope.ts";
import { appendTelemetry, inferImprovementTarget, makeTelemetryEvent, readTelemetry, readRoutingRecords, telemetryPath } from "./telemetry.ts";
import { behavioralConfigHash, compareRoutingRecords, groupByBehavior, generateRoutingReport, formatRoutingReport } from "./routing.ts";
import { loadPriceCatalog, type PriceCatalog } from "./prices.ts";
import { createSession, loadNamedWorkers, rosterNames, sessionAssetDirs, workflowAssetDirs, writeSession } from "./session.ts";
import { buildImprovementReport, formatImprovementReport, writeImprovementReport } from "./improve.ts";
import { MESH_TUI_PANELS, runMeshTui, type MeshTuiPanel } from "./tui.ts";
import { formatSessionBriefText, loadSessionBrief, loadSessionBriefAsync, type SessionHubStatus } from "./session-work.ts";
import {
  HUB_BINDING_SCHEMA,
  HubBindingError,
  hubBindingFile,
  probeHubHealth,
  readHubBinding,
  removeHubBinding,
  validateHubUrl,
  writeHubBinding,
  type HubHealth,
} from "./hub-binding.ts";
import {
  fetchLatestKxmVersion,
  kxmReleaseAssetName,
  noticeFromVersions,
  planKxmPackageUpdate,
  readInstalledKxmVersion,
  readUpdateCache,
  verifyReleaseAssetDigest,
  writeUpdateCache,
  KxmUpdateConfigError,
  type KxmPackageUpdateStep,
  type KxmUpdateConfig,
  type KxmUpdateNotice,
} from "./kxm-update.ts";
import { loadKxmUpdateConfig } from "./kxm-update-config.ts";
import {
  classifyInstallRoot,
  resolveInstallKind,
  type InstallKindReport,
  type InstallProbe,
} from "./kxm-install-kind.ts";
import { VnextConfigError, discoverVnextProjectRoot, type VnextInitializationPlan } from "./vnext-config.ts";
import { vnextUserStateRoot } from "./vnext-bindings.ts";
import { initializeVnextProject } from "./vnext-init.ts";
import { applyVnextMigration, planVnextMigration, verifyVnextMigration } from "./vnext-migrate.ts";
import { diffVnextProjectAgainstRevision, formatVnextPermissionDiff } from "./vnext-permission.ts";
import { readVnextLocalBindings } from "./vnext-bindings.ts";
import { loadVnextProject } from "./vnext-config.ts";
import {
  ensureVnextSupervisor,
  vnextRuntimeRequest,
  vnextSupervisorStatus,
} from "./vnext-runtime-supervisor.ts";
import { vnextRuntimePaths } from "./vnext-runtime-store.ts";
import {
  formatHarnessInventory,
  formatHarnessUpdate,
  planHarnessUpdate,
  probeHarnesses,
  runHarnessUpdate,
  type HarnessUpdateScope,
} from "./vnext-harness.ts";
import type { WorkflowEvidenceInput, WorkflowJournalEntry, WorkflowRun } from "./workflow.ts";
import { HubClient } from "./client.ts";
import {
  AGENT_COMMANDS_MAP,
  clearSessionTokenFromDisk,
  enforceToolPolicy,
  mintSessionToken,
  parseSessionToken,
  persistSessionTokenToDisk,
  readSessionTokenFromDisk,
  sessionTokenPath,
} from "./commands.ts";
import {
  loadKxmConfig,
  setKxmConfigValue,
  getKxmConfigValue,
  formatKxmConfig,
} from "./config.ts";
import { generateShellCompletion, type SupportedShell } from "./autocomplete.ts";
import { suggestWorkflowAndRoles } from "./suggest.ts";
import {
  createGoal,
  createTask,
  listGoals,
  listTasks,
  getTask,
  updateTaskStatus,
  syncTaskWithTracker,
  type TaskStatus,
  type TrackerType,
} from "./task-manager.ts";
import { parse as parseYaml } from "yaml";
import { compileVnextWorkflow } from "./vnext-engine-compile.ts";
import { generateStudioLayout, createStudioServer, DEFAULT_STUDIO_PORT } from "./studio-layout.ts";

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
  boundHubUrl?: string;
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

const CLI_RESULT_SCHEMA = "kxm.cli-result.v1";

/** Every CLI payload carries a schema tag; payloads that already declare one
 * (worker envelopes) keep theirs. `ok:false` goes to stderr in both modes so
 * agents can split results from errors without parsing. */
function print(io: CliIo, jsonMode: boolean, payload: object, text: string): void {
  const tagged = { schema: CLI_RESULT_SCHEMA, ...payload } as Record<string, unknown>;
  const safePayload = JSON.stringify(redactCliValue(tagged));
  const line = jsonMode ? `${safePayload}\n` : `${redactSecrets(text)}\n`;
  if (tagged.ok === false) io.stderr(line);
  else io.stdout(line);
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

function hostMode(runtime: Runtime): "local" | "hub" {
  try {
    const hostname = new URL(runtime.serverUrl).hostname;
    if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") return "local";
  } catch {
    // Default local when the hub URL is not a URL.
  }
  return "hub";
}

function gateOf(runtime: Runtime, name: string): ReturnType<typeof gateWorker> {
  const project = runtime.env.KXM_PROJECT?.trim();
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

function workspaceDirs(cwd: string, workspaceFlag: string | undefined, env: NodeJS.ProcessEnv) {
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
    headers: { "content-type": "application/json", "x-hub-signature-256": signature, "x-kxm-delivery-id": input.deliveryId, ...(input.event ? { "x-github-event": input.event } : {}) },
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

function workspaceEnv(runtime: Runtime): NodeJS.ProcessEnv {
  return {
    KXM_WORKDIR: runtime.dirs.workdir,
    KXM_WORKSPACE_DIR: runtime.dirs.workspace,
    KXM_CONFIG_DIR: runtime.dirs.config,
    KXM_LOGS_DIR: runtime.dirs.logs,
    KXM_ASSETS_DIR: runtime.dirs.assets,
    KXM_STATE_DIR: runtime.dirs.state,
  };
}

function activeWorkflowDefinition(runtime: Runtime, definitionId: string) {
  const inline = runtime.env.KXM_WEBHOOK_WORKFLOWS?.trim();
  const file = runtime.env.KXM_WEBHOOK_WORKFLOWS_FILE?.trim();
  if (inline && file) {
    throw new Error("configure only one of KXM_WEBHOOK_WORKFLOWS or KXM_WEBHOOK_WORKFLOWS_FILE");
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
    ? runtime.env.KXM_WORKFLOW_SECRET?.trim()
    : runtime.env.KXM_WORKFLOW_SIGNAL_SECRET?.trim();
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

function explicitRepositoryBindings(values: readonly string[]): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const value of values) {
    const separator = value.indexOf("=");
    const repositoryId = separator < 0 ? "" : value.slice(0, separator).trim();
    const path = separator < 0 ? "" : value.slice(separator + 1).trim();
    if (!repositoryId || !path) {
      throw new VnextConfigError([{
        phase: "discovery",
        code: "repository_binding_argument_invalid",
        file: "--repository",
        message: "repository bindings must use <id=absolute-path>",
      }]);
    }
    if (Object.hasOwn(result, repositoryId)) {
      throw new VnextConfigError([{
        phase: "discovery",
        code: "repository_binding_argument_duplicate",
        file: "--repository",
        message: `repository binding ${repositoryId} was supplied more than once`,
      }]);
    }
    result[repositoryId] = path;
  }
  return result;
}

async function cmdVnextInit(runtime: Runtime, options: { name?: string; projectId?: string; repository?: string[] }): Promise<number> {
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
      repositoryBindings: explicitRepositoryBindings(options.repository ?? []),
      localStateRoot: vnextUserStateRoot({ env: runtime.env }),
      dryRun: runtime.dryRun,
    });
    const payload = {
      ok: initialized.action !== "planned" || runtime.dryRun,
      command: "init",
      action: initialized.action,
      ...initPlanPayload(initialized.plan),
      files: initialized.files,
      ...(initialized.configRevision ? { configRevision: initialized.configRevision } : {}),
      ...(initialized.localBindingFile ? { localBindingFile: initialized.localBindingFile } : {}),
      ...(initialized.bindingsChanged === undefined ? {} : { bindingsChanged: initialized.bindingsChanged }),
      ...(initialized.repairPlan === undefined ? {} : { repairPlan: initialized.repairPlan }),
      ...(initialized.resumePending === undefined ? {} : { resumePending: initialized.resumePending }),
      ...(initialized.transactionKind === undefined ? {} : { transactionKind: initialized.transactionKind }),
      plannedOnly: initialized.action === "planned",
    };
    const finishInit = (code: number, text: string): number => {
      print(runtime.io, runtime.json, payload, text);
      return code;
    };
    if (initialized.action === "created") {
      return finishInit(0, `initialized vNext project at ${initialized.projectRoot ?? runtime.cwd}`);
    }
    if (initialized.action === "joined") {
      return finishInit(0, `joined vNext project at ${initialized.projectRoot ?? runtime.cwd}`);
    }
    if (initialized.action === "repaired") {
      return finishInit(0, `repaired vNext project at ${initialized.projectRoot ?? runtime.cwd}`);
    }
    if (initialized.action === "resumed") {
      return finishInit(0, `resumed vNext ${initialized.transactionKind ?? "initialization"} at ${initialized.projectRoot ?? runtime.cwd}`);
    }
    if (initialized.action === "validated") {
      return finishInit(0, `validated vNext project at ${initialized.projectRoot ?? runtime.cwd}`);
    }
    if (runtime.dryRun) {
      return finishInit(0, `init plan: ${initialized.plan.mode}`);
    }
    const next = initialized.plan.mode === "migrate"
      ? "legacy state requires reviewed migration; conversion is not available in this implementation slice"
      : initialized.repairPlan?.issues.length
        ? "managed-template repair is blocked by conflicts or authority changes; local files were preserved"
        : "partial or provenance-free vNext state requires explicit repair; no files were overwritten";
    return finishInit(1, next);
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

async function cmdVnextMigratePlan(runtime: Runtime): Promise<number> {
  if (runtime.workspaceFlag !== undefined) {
    print(runtime.io, runtime.json, {
      ok: false,
      command: "migrate plan",
      error: "workspace_option_unsupported",
    }, "kxm migrate discovers the authoritative Git root from the current directory; --workspace is not supported");
    return 2;
  }
  try {
    const result = planVnextMigration(runtime.cwd, {});
    const ambiguities = (result.plan.ambiguities as Array<{ key: string; message: string }> | undefined) ?? [];
    const unmapped = (result.plan.unmapped as unknown[] | undefined) ?? [];
    const payload = {
      ok: result.plan.canApply === true,
      command: "migrate plan",
      plan: result.plan,
      plannedOnly: result.plan.canApply !== true,
    };
    if (result.plan.canApply === true) {
      print(runtime.io, runtime.json, payload, `migration plan: ${ambiguities.length} ambiguities, ${unmapped.length} preserved fields; ready to apply`);
      return 0;
    }
    print(
      runtime.io,
      runtime.json,
      payload,
      `migration plan requires ${ambiguities.length} reviewed decision(s):\n${ambiguities.map((candidate) => `  - ${candidate.key}: ${candidate.message}`).join("\n")}`,
    );
    return 1;
  } catch (error) {
    if (error instanceof VnextConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "migrate plan", error: "migration_plan_failed", issues: error.issues }, `migration plan failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "migrate plan", error: "migration_plan_io_failed" }, "migration plan failed because a local filesystem operation did not complete");
    return 1;
  }
}

async function cmdVnextMigrateApply(runtime: Runtime, options: { decisions?: string; projectId?: string; name?: string }): Promise<number> {
  if (runtime.workspaceFlag !== undefined) {
    print(runtime.io, runtime.json, {
      ok: false,
      command: "migrate apply",
      error: "workspace_option_unsupported",
    }, "kxm migrate discovers the authoritative Git root from the current directory; --workspace is not supported");
    return 2;
  }
  try {
    const result = applyVnextMigration(runtime.cwd, {
      ...(options.decisions?.trim() ? { decisionsFile: options.decisions.trim() } : {}),
      ...(options.projectId?.trim() ? { projectId: options.projectId.trim() } : {}),
      ...(options.name?.trim() ? { projectName: options.name.trim() } : {}),
      localStateRoot: vnextUserStateRoot({ env: runtime.env }),
      dryRun: runtime.dryRun,
    });
    const payload = {
      ok: result.action !== "planned" || (runtime.dryRun === true && result.plan?.canApply === true),
      command: "migrate apply",
      action: result.action,
      files: result.files,
      ...(result.configRevision ? { configRevision: result.configRevision } : {}),
      ...(result.receiptPath ? { receiptPath: result.receiptPath } : {}),
      plannedOnly: result.action === "planned",
    };
    if (result.action === "applied") {
      print(runtime.io, runtime.json, payload, `migration applied: ${result.files.length} resources installed, receipt at ${result.receiptPath ?? ""}`);
      return 0;
    }
    if (result.action === "already-migrated") {
      print(runtime.io, runtime.json, payload, "migration receipt already exists; nothing to apply");
      return 0;
    }
    if (runtime.dryRun && result.plan?.canApply === true) {
      print(runtime.io, runtime.json, payload, `migration dry run: ${result.files.length} resources would be installed`);
      return 0;
    }
    const ambiguities = (result.plan?.ambiguities as Array<{ key: string; message: string }> | undefined) ?? [];
    print(
      runtime.io,
      runtime.json,
      { ...payload, plan: result.plan },
      `migration blocked by ${ambiguities.length} unresolved decision(s); review 'kxm migrate plan' and pass --decisions:\n${ambiguities.map((candidate) => `  - ${candidate.key}: ${candidate.message}`).join("\n")}`,
    );
    return 1;
  } catch (error) {
    if (error instanceof VnextConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "migrate apply", error: "migration_apply_failed", issues: error.issues }, `migration apply failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "migrate apply", error: "migration_apply_io_failed" }, "migration apply failed because a local filesystem operation did not complete");
    return 1;
  }
}

async function cmdVnextMigrateVerify(runtime: Runtime): Promise<number> {
  if (runtime.workspaceFlag !== undefined) {
    print(runtime.io, runtime.json, {
      ok: false,
      command: "migrate verify",
      error: "workspace_option_unsupported",
    }, "kxm migrate discovers the authoritative Git root from the current directory; --workspace is not supported");
    return 2;
  }
  let result: ReturnType<typeof verifyVnextMigration>;
  try {
    result = verifyVnextMigration(runtime.cwd, {});
  } catch (error) {
    if (error instanceof VnextConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "migrate verify", error: "migration_verify_failed", issues: error.issues }, `migration verification failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "migrate verify", error: "migration_verify_io_failed" }, "migration verification failed because a local filesystem operation did not complete");
    return 1;
  }
  const payload = {
    ok: result.ok,
    command: "migrate verify",
    ...(result.configRevision ? { configRevision: result.configRevision } : {}),
    issues: result.issues,
  };
  if (result.ok) {
    print(runtime.io, runtime.json, payload, `migration receipt verified: legacy sources unchanged, target bundle matches ${result.configRevision ?? ""}`);
    return 0;
  }
  print(runtime.io, runtime.json, payload, `migration verification failed:\n${result.issues.map((issue) => `  - ${issue.file}: ${issue.code}: ${issue.message}`).join("\n")}`);
  return 1;
}

async function cmdBackup(runtime: Runtime, options: { out?: string }): Promise<number> {
  try {
    const { manifest, outDir } = createBackup({
      projectRoot: runtime.cwd,
      ...(options.out ? { outDir: resolve(runtime.cwd, options.out) } : {}),
    });
    const payload = {
      ok: true,
      command: "backup",
      backupId: manifest.backupId,
      outDir,
      manifest,
    };
    const summary = [
      `Created SQLite backup with ${manifest.stores.length} store(s):`,
      ...manifest.stores.map((s) => `  - ${s.storeId}: ${s.sourcePath} -> ${s.backupFile} (schema v${s.schemaVersion}, ${s.bytes} bytes, sha256 ${s.sha256.slice(0, 12)}...)`),
      `Manifest: ${join(outDir, "manifest.json")}`,
    ].join("\n");
    print(runtime.io, runtime.json, payload, summary);
    return 0;
  } catch (error) {
    if (error instanceof VnextConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "backup", error: "backup_failed", issues: error.issues }, `backup failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "backup", error: "backup_failed", message: error instanceof Error ? error.message : String(error) }, `backup failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function cmdRestore(runtime: Runtime, manifestArg: string): Promise<number> {
  try {
    const result = restoreBackup(resolve(runtime.cwd, manifestArg), {
      projectRoot: runtime.cwd,
    });
    const payload = {
      ok: true,
      command: "restore",
      backupId: result.backupId,
      manifestPath: result.manifestPath,
      restoredStores: result.restoredStores,
    };
    const summary = [
      `Restored ${result.restoredStores.length} SQLite store(s) from ${result.manifestPath}:`,
      ...result.restoredStores.map((s) => `  - ${s.storeId}: -> ${s.sourcePath} (schema v${s.schemaVersion}, integrity ${s.integrity})`),
    ].join("\n");
    print(runtime.io, runtime.json, payload, summary);
    return 0;
  } catch (error) {
    if (error instanceof VnextConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "restore", error: "restore_failed", issues: error.issues }, `restore failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "restore", error: "restore_failed", message: error instanceof Error ? error.message : String(error) }, `restore failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function cmdVnextTrust(runtime: Runtime, check: boolean, options: { base?: string }): Promise<number> {
  if (runtime.workspaceFlag !== undefined) {
    print(runtime.io, runtime.json, {
      ok: false,
      command: check ? "trust check" : "trust diff",
      error: "workspace_option_unsupported",
    }, "kxm trust discovers the authoritative Git root from the current directory; --workspace is not supported");
    return 2;
  }
  const command = check ? "trust check" : "trust diff";
  try {
    // Host-local member bindings travel with the user state, not Git; pass
    // them so member repositories diff with the same identities on both sides.
    const projectRoot = discoverVnextProjectRoot(runtime.cwd) ?? runtime.cwd;
    const bindings = readVnextLocalBindings(projectRoot, { stateRoot: vnextUserStateRoot({ env: runtime.env }) });
    const diff = diffVnextProjectAgainstRevision(projectRoot, options.base?.trim() || "HEAD", {
      repositoryBindings: bindings?.repositories ?? {},
    });
    const payload = {
      ok: !check || !diff.requiresReview,
      command,
      baseRevision: diff.baseRevision,
      candidateRevision: diff.candidateRevision,
      requiresReview: diff.requiresReview,
      expansions: diff.expansions.length,
      narrowings: diff.narrowings.length,
      neutralChanges: diff.neutralChanges.length,
      changes: diff.changes,
    };
    const text = formatVnextPermissionDiff(diff);
    if (check && diff.requiresReview) {
      print(runtime.io, runtime.json, payload, `${text}\ntrust check failed: review every expansion above before merging`);
      return 1;
    }
    print(runtime.io, runtime.json, payload, text);
    return 0;
  } catch (error) {
    if (error instanceof VnextConfigError) {
      print(runtime.io, runtime.json, { ok: false, command, error: "trust_diff_failed", issues: error.issues }, `permission diff failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command, error: "trust_diff_io_failed" }, "permission diff failed because a local filesystem or Git operation did not complete");
    return 1;
  }
}

/** No step engine exists yet: `kxm run` durably accepts a run and stops.
 * The run engine replaces this notice with real progress. */
const RUN_ENGINE_PHASE = "pre-3a";
const RUN_ENGINE_NOTICE = "runs remain created until the run engine lands; no steps execute yet";

async function cmdVnextRun(runtime: Runtime, workflow: string | undefined, promptParts: string[]): Promise<number> {
  if (runtime.workspaceFlag !== undefined) {
    print(runtime.io, runtime.json, {
      ok: false,
      command: "run",
      error: "workspace_option_unsupported",
    }, "kxm run discovers the authoritative project from the current directory; --workspace is not supported");
    return 2;
  }
  if (!workflow) {
    print(runtime.io, runtime.json, { ok: false, command: "run", error: "workflow_required" }, "usage: kxm run <workflow> [prompt]");
    return 2;
  }
  try {
    const projectRoot = discoverVnextProjectRoot(runtime.cwd);
    if (!projectRoot) {
      print(runtime.io, runtime.json, { ok: false, command: "run", error: "project_required" }, "kxm run requires a vNext project (run kxm init first)");
      return 1;
    }
    const bundle = loadVnextProject(projectRoot, {});
    if (!bundle.workflows.has(workflow)) {
      print(runtime.io, runtime.json, { ok: false, command: "run", error: "run_workflow_unknown", workflow }, `workflow ${workflow} does not exist in this project`);
      return 1;
    }
    if (runtime.dryRun) {
      print(runtime.io, runtime.json, {
        ok: true,
        command: "run",
        dryRun: true,
        projectRoot,
        workflowId: workflow,
        configRevision: bundle.configRevision,
      }, `run plan: workflow ${workflow} at ${bundle.configRevision.slice(0, 19)}… (no run created)`);
      return 0;
    }
    const supervisor = await ensureVnextSupervisor({ env: runtime.env });
    const prompt = promptParts.join(" ").trim();
    const acceptance = await vnextRuntimeRequest(supervisor, "POST", "/v1/runs", {
      projectRoot,
      workflowId: workflow,
      prompt,
    });
    const run = acceptance.run as { runId: string; homeRuntimeId: string; status: string; configRevision: string };
    print(runtime.io, runtime.json, {
      ok: true,
      command: "run",
      phase: RUN_ENGINE_PHASE,
      idempotent: acceptance.idempotent === true,
      run,
      supervisor: { runtimeId: supervisor.runtimeId, port: supervisor.port, started: supervisor.started },
    }, `run ${run.status}: ${run.runId} (home ${run.homeRuntimeId.slice(0, 12)}…, config ${run.configRevision.slice(0, 19)}…)\n${RUN_ENGINE_NOTICE}`);
    return 0;
  } catch (error) {
    if (error instanceof VnextConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "run", error: "run_failed", issues: error.issues }, `run failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "run", error: "run_io_failed" }, "run failed because a local operation did not complete");
    return 1;
  }
}

async function cmdVnextRunStatus(runtime: Runtime, runId: string): Promise<number> {
  try {
    const projectRoot = discoverVnextProjectRoot(runtime.cwd);
    if (!projectRoot) {
      print(runtime.io, runtime.json, { ok: false, command: "runs status", error: "project_required" }, "kxm runs status requires a vNext project (run kxm init first)");
      return 1;
    }
    const supervisor = await ensureVnextSupervisor({ env: runtime.env });
    const result = await vnextRuntimeRequest(supervisor, "GET", `/v1/runs/${encodeURIComponent(runId)}?projectRoot=${encodeURIComponent(projectRoot)}`);
    const run = result.run as { runId: string; status: string; workflowId: string; configRevision: string; updatedAt: string };
    print(runtime.io, runtime.json, { ok: true, command: "runs status", run }, `run ${run.runId}: ${run.status} (workflow ${run.workflowId}, updated ${run.updatedAt})`);
    return 0;
  } catch (error) {
    if (error instanceof VnextConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "runs status", error: "run_status_failed", issues: error.issues }, `run status failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "runs status", error: "run_status_io_failed" }, "run status failed because a local operation did not complete");
    return 1;
  }
}

async function cmdVnextRunCancel(runtime: Runtime, runId: string): Promise<number> {
  try {
    const projectRoot = discoverVnextProjectRoot(runtime.cwd);
    if (!projectRoot) {
      print(runtime.io, runtime.json, { ok: false, command: "runs cancel", error: "project_required" }, "kxm runs cancel requires a vNext project (run kxm init first)");
      return 1;
    }
    if (runtime.dryRun) {
      print(runtime.io, runtime.json, { ok: true, command: "runs cancel", dryRun: true, runId }, `cancel plan: run ${runId} (no events written)`);
      return 0;
    }
    const supervisor = await ensureVnextSupervisor({ env: runtime.env });
    const result = await vnextRuntimeRequest(supervisor, "POST", `/v1/runs/${encodeURIComponent(runId)}/cancel?projectRoot=${encodeURIComponent(projectRoot)}`, {});
    const run = result.run as { runId: string; status: string };
    print(runtime.io, runtime.json, {
      ok: true,
      command: "runs cancel",
      idempotent: result.idempotent === true,
      run,
    }, `run ${run.runId}: ${run.status}`);
    return 0;
  } catch (error) {
    if (error instanceof VnextConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "runs cancel", error: "run_cancel_failed", issues: error.issues }, `run cancel failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "runs cancel", error: "run_cancel_io_failed" }, "run cancel failed because a local operation did not complete");
    return 1;
  }
}

async function cmdVnextRunList(runtime: Runtime): Promise<number> {
  try {
    const projectRoot = discoverVnextProjectRoot(runtime.cwd);
    if (!projectRoot) {
      print(runtime.io, runtime.json, { ok: false, command: "runs list", error: "project_required" }, "kxm runs list requires a vNext project (run kxm init first)");
      return 1;
    }
    const bundle = loadVnextProject(projectRoot, {});
    const projectId = String(bundle.project.value.id);
    const supervisor = await ensureVnextSupervisor({ env: runtime.env });
    const result = await vnextRuntimeRequest(supervisor, "GET", `/v1/projects/${encodeURIComponent(projectId)}/runs?projectRoot=${encodeURIComponent(projectRoot)}`);
    const runs = (result.runs ?? []) as Array<{ runId: string; status: string; workflowId: string; createdAt: string }>;
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "runs list", runs },
      runs.length === 0 ? "no runs" : runs.map((run) => `${run.runId}  ${run.status}  ${run.workflowId}  ${run.createdAt}`).join("\n"),
    );
    return 0;
  } catch (error) {
    if (error instanceof VnextConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "runs list", error: "run_list_failed", issues: error.issues }, `run list failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "runs list", error: "run_list_io_failed" }, "run list failed because a local operation did not complete");
    return 1;
  }
}

async function cmdHarnessList(runtime: Runtime): Promise<number> {
  const inventory = probeHarnesses({ env: runtime.env });
  print(runtime.io, runtime.json, { ok: true, command: "harness list", ...inventory }, formatHarnessInventory(inventory));
  return 0;
}

function installProbeFrom(runtime: Runtime): InstallProbe {
  const partial = runtime.io.installProbe ?? {};
  return {
    moduleDir: partial.moduleDir ?? dirname(fileURLToPath(import.meta.url)),
    repoRoot: partial.repoRoot ?? repoRoot,
    homeDir: partial.homeDir ?? homedir(),
    platform: partial.platform ?? process.platform,
    env: partial.env ?? runtime.env,
  };
}

function cliSpawn(runtime: Runtime, command: string, args: readonly string[], extra?: { timeout?: number }): CliSpawnResult {
  if (runtime.io.spawnSync) return runtime.io.spawnSync(command, args);
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
    ...extra,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function npmGlobalRootFn(runtime: Runtime): () => string | undefined {
  return () => {
    const result = cliSpawn(runtime, "npm", ["root", "-g"], { timeout: 5_000 });
    if (result.error || result.status !== 0) return undefined;
    const out = result.stdout.trim();
    return out || undefined;
  };
}

function warnIgnoredProjectUpdateYaml(runtime: Runtime): void {
  const projectFile = join(runtime.dirs.workspace, "update.yaml");
  if (!existsSync(projectFile)) return;
  const userFile = join(vnextUserStateRoot({ env: runtime.env }), "update.yaml");
  runtime.io.stderr(`kxm: ignoring .kxm/update.yaml in ${runtime.dirs.workdir}; update settings are read only from ${userFile}\n`);
}

function installKindPayload(report: InstallKindReport): { installKind: string; root: string } {
  return { installKind: report.kind, root: report.root };
}

function formatPackageUpdateStep(step: KxmPackageUpdateStep): string {
  if (step.kind === "verify") return `verify sha256 ${step.path}`;
  return `${step.command} ${step.args.join(" ")}`;
}

async function refreshKxmUpdateNotice(runtime: Runtime, config?: KxmUpdateConfig): Promise<KxmUpdateNotice> {
  const resolved = config ?? loadKxmUpdateConfig(runtime.env);
  const current = readInstalledKxmVersion(repoRoot);
  const fetched = await fetchLatestKxmVersion(resolved.source, runtime.env, runtime.fetchImpl);
  const notice = noticeFromVersions(current, fetched.latest, resolved, fetched.error, fetched.asset);
  writeUpdateCache(runtime.dirs.state, notice);
  return notice;
}

function applyKxmPackageUpdate(runtime: Runtime, notice: KxmUpdateNotice): { ok: boolean; detail: string; error?: string } {
  if (!notice.latest) return { ok: false, detail: "no_latest_version" };
  if (notice.source === "github" && !notice.asset?.sha256) {
    const name = kxmReleaseAssetName(notice.latest);
    return {
      ok: false,
      error: "release_digest_missing",
      detail: `release v${notice.latest} has no sha256 digest for ${name}; refusing to install`,
    };
  }
  const releaseDir = mkdtempSync(join(tmpdir(), "kxm-pkg-update-"));
  try {
    const planned = planKxmPackageUpdate(notice.source, notice.latest, releaseDir, notice.asset);
    if (runtime.dryRun) {
      return { ok: true, detail: planned.map(formatPackageUpdateStep).join(" && ") };
    }
    for (const step of planned) {
      if (step.kind === "verify") {
        if (!verifyReleaseAssetDigest(step.path, step.sha256)) {
          const actual = existsSync(step.path)
            ? createHash("sha256").update(readFileSync(step.path)).digest("hex")
            : "missing";
          return {
            ok: false,
            error: "release_digest_mismatch",
            detail: `${kxmReleaseAssetName(notice.latest)} sha256 ${actual} does not match release digest ${step.sha256}; refusing to install`,
          };
        }
        continue;
      }
      const result = cliSpawn(runtime, step.command, step.args);
      if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || result.error?.message || "update_failed").trim().slice(0, 500);
        return { ok: false, detail };
      }
    }
    return { ok: true, detail: `installed ${notice.latest} from ${notice.source}` };
  } finally {
    rmSync(releaseDir, { recursive: true, force: true });
  }
}

async function cmdUpdate(runtime: Runtime, harness: string | undefined, options: {
  self?: boolean;
  extensions?: boolean;
  models?: boolean;
  check?: boolean;
  kxm?: boolean;
}): Promise<number> {
  if (options.check && (options.kxm || options.self || options.extensions || options.models || harness)) {
    print(runtime.io, runtime.json, { ok: false, command: "update", error: "scope_conflict" }, "--check cannot be combined with other update flags");
    return 2;
  }
  const selected = [options.self, options.extensions, options.models].filter(Boolean).length;
  if (selected > 1) {
    print(runtime.io, runtime.json, { ok: false, command: "update", error: "scope_conflict" }, "specify at most one of --self, --extensions, or --models");
    return 2;
  }
  warnIgnoredProjectUpdateYaml(runtime);
  const probe = installProbeFrom(runtime);
  const classified = classifyInstallRoot(probe);
  const current = readInstalledKxmVersion(repoRoot);
  let notice: KxmUpdateNotice;
  let kindReport = classified;
  if (classified.kind === "source") {
    if (options.check) {
      const message = `kxm ${current} (running from source at ${classified.root})`;
      print(runtime.io, runtime.json, {
        ok: true,
        command: "update check",
        current,
        available: false,
        auto: false,
        source: "github",
        installKind: "source",
        root: classified.root,
        message,
      }, message);
      return 0;
    }
    if (options.kxm) {
      print(runtime.io, runtime.json, {
        ok: false,
        command: "update",
        error: "install_kind_source",
        installKind: "source",
        root: classified.root,
        instruction: classified.instruction,
      }, classified.instruction);
      return 2;
    }
    notice = {
      current,
      available: false,
      auto: false,
      source: "github",
      message: `kxm ${current} (running from source)`,
    };
  } else {
    try {
      notice = await refreshKxmUpdateNotice(runtime);
    } catch (error) {
      if (error instanceof KxmUpdateConfigError) {
        print(runtime.io, runtime.json, { ok: false, command: "update", error: error.code, ...installKindPayload(classified) }, error.message);
        return 2;
      }
      throw error;
    }
  }
  if (options.check) {
    print(runtime.io, runtime.json, {
      ok: true,
      command: "update check",
      ...notice,
      ...installKindPayload(classified),
    }, notice.message);
    return 0;
  }
  const applyKxm = Boolean(options.kxm || notice.auto);
  let kxmApply: { ok: boolean; detail: string; error?: string } | undefined;
  if (applyKxm) {
    const resolved = resolveInstallKind(probe, npmGlobalRootFn(runtime));
    kindReport = resolved;
    if (resolved.kind !== "npm-global") {
      if (options.kxm) {
        print(runtime.io, runtime.json, {
          ok: false,
          command: "update",
          error: `install_kind_${resolved.kind}`,
          installKind: resolved.kind,
          root: resolved.root,
          instruction: resolved.instruction,
          notice,
        }, resolved.instruction);
        return 2;
      }
      if (notice.available) runtime.io.stderr(`kxm: ${resolved.instruction}\n`);
    } else if (notice.available) {
      kxmApply = applyKxmPackageUpdate(runtime, notice);
      if (!kxmApply.ok && options.kxm) {
        print(runtime.io, runtime.json, {
          ok: false,
          command: "update",
          error: kxmApply.error,
          kxm: kxmApply,
          notice,
          ...installKindPayload(resolved),
        }, kxmApply.detail);
        return 1;
      }
    }
  }
  const skipHarness = Boolean(options.kxm && selected === 0 && !harness && !notice.auto);
  if (skipHarness) {
    print(
      runtime.io,
      runtime.json,
      { ok: kxmApply?.ok !== false, command: "update", dryRun: runtime.dryRun, notice, kxm: kxmApply, ...installKindPayload(kindReport) },
      kxmApply?.detail ?? notice.message,
    );
    return kxmApply?.ok === false ? 1 : 0;
  }
  const scope: HarnessUpdateScope = options.self ? "self" : options.extensions ? "extensions" : options.models ? "models" : "all";
  const inventory = probeHarnesses({ env: runtime.env });
  const planned = planHarnessUpdate(inventory, { ...(harness ? { harness } : {}), scope });
  const steps = runHarnessUpdate(planned, { env: runtime.env, dryRun: runtime.dryRun });
  const failed = steps.some((step) => step.outcome === "failed") || kxmApply?.ok === false;
  const skippedUnknown = steps.some((step) => step.detail === "unknown_harness");
  const text = [notice.available ? notice.message : undefined, kxmApply?.detail, formatHarnessUpdate(steps)].filter(Boolean).join("\n");
  print(runtime.io, runtime.json, {
    ok: !failed && !skippedUnknown,
    command: "update",
    dryRun: runtime.dryRun,
    scope,
    notice,
    ...(kxmApply ? { kxm: kxmApply } : {}),
    steps,
    ...installKindPayload(kindReport),
  }, text);
  if (skippedUnknown) return 2;
  return failed ? 1 : 0;
}

async function cmdVnextRuntime(runtime: Runtime, action: string): Promise<number> {
  const paths = vnextRuntimePaths({ env: runtime.env });
  try {
    if (action === "start") {
      if (runtime.dryRun) {
        print(runtime.io, runtime.json, { ok: true, command: "runtime start", dryRun: true }, "runtime supervisor would auto-start");
        return 0;
      }
      const supervisor = await ensureVnextSupervisor({ env: runtime.env });
      print(runtime.io, runtime.json, {
        ok: true,
        command: "runtime start",
        runtimeId: supervisor.runtimeId,
        port: supervisor.port,
        started: supervisor.started,
      }, `runtime supervisor ${supervisor.started ? "started" : "already running"}: ${supervisor.runtimeId} on 127.0.0.1:${supervisor.port}`);
      return 0;
    }
    if (action === "status") {
      const status = vnextSupervisorStatus(paths);
      print(runtime.io, runtime.json, { ok: true, command: "runtime status", ...status }, status.running
        ? `runtime supervisor running: ${status.runtimeId} pid ${status.pid} on 127.0.0.1:${status.port}`
        : "runtime supervisor is not running");
      return status.running ? 0 : 1;
    }
    if (action === "stop") {
      const status = vnextSupervisorStatus(paths);
      if (!status.running || !status.port) {
        print(runtime.io, runtime.json, { ok: true, command: "runtime stop", stopped: false }, "runtime supervisor is not running");
        return 0;
      }
      if (runtime.dryRun) {
        print(runtime.io, runtime.json, { ok: true, command: "runtime stop", dryRun: true }, `would stop runtime supervisor pid ${status.pid}`);
        return 0;
      }
      // The stop request posts a bearer token, so prove the listener is the
      // real supervisor (keyed healthz challenge) before sending it.
      const supervisor = await ensureVnextSupervisor({ env: runtime.env });
      await vnextRuntimeRequest(supervisor, "POST", "/v1/shutdown", {});
      print(runtime.io, runtime.json, { ok: true, command: "runtime stop", stopped: true }, `runtime supervisor ${status.runtimeId} stopping`);
      return 0;
    }
    print(runtime.io, runtime.json, { ok: false, command: "runtime", error: "unknown_action" }, `unknown runtime action: ${action}`);
    return 2;
  } catch (error) {
    if (error instanceof VnextConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "runtime", error: "runtime_failed", issues: error.issues }, `runtime failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "runtime", error: "runtime_io_failed" }, "runtime failed because a local operation did not complete");
    return 1;
  }
}

async function cmdValidate(runtime: Runtime, fileFlag?: string): Promise<number> {
  const worker = gateOf(runtime, "validate");
  const explicitFile = fileFlag?.trim();
  const configuredFile = runtime.env.KXM_WEBHOOK_WORKFLOWS_FILE?.trim();
  const inline = runtime.env.KXM_WEBHOOK_WORKFLOWS?.trim();
  if (!explicitFile && configuredFile && inline) {
    printWorker(
      runtime,
      worker,
      { ok: false, command: "validate", error: "ambiguous_workflow_source" },
      "configure only one of KXM_WEBHOOK_WORKFLOWS or KXM_WEBHOOK_WORKFLOWS_FILE",
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
  const payload = { ok: health.ok && ready.ok, command: "hub view", health: health.body, ready: ready.body };
  print(runtime.io, runtime.json, payload, `hub health=${health.ok} ready=${ready.ok}`);
  return payload.ok ? 0 : 1;
}

async function cmdDash(runtime: Runtime, options: { screen?: string } = {}): Promise<number> {
  const requested = options.screen?.trim();
  if (requested && !(MESH_TUI_PANELS as readonly string[]).includes(requested)) {
    print(runtime.io, runtime.json, { ok: false, command: "dash", error: "unknown_screen" }, `unknown screen ${requested}; use agents, tasks, workflows, plans, inbox, procs, or spend`);
    return 2;
  }
  const screen = requested as MeshTuiPanel | undefined;
  const dataPath = resolve(runtime.dirs.workdir, runtime.env.KXM_DATA_PATH?.trim() || join(runtime.dirs.state, "kxm.db"));
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, {
      ok: true,
      command: "dash",
      dryRun: true,
      serverUrl: runtime.serverUrl,
      transport: "sse",
      ...(screen ? { screen } : {}),
    }, "would start kxm dash");
    return 0;
  }
  if (runtime.json) {
    runtime.io.stderr("kxm dash does not support --json; use kxm hub view\n");
    return 2;
  }
  const project = runtime.env.KXM_PROJECT?.trim() || basename(runtime.dirs.workdir) || "project";
  const authToken = runtime.env.KXM_AUTH_TOKEN?.trim();
  return await runMeshTui({
    serverUrl: runtime.serverUrl,
    dataPath,
    stateDir: runtime.dirs.state,
    project,
    env: runtime.env,
    ...(authToken ? { authToken } : {}),
    ...(screen ? { screen } : {}),
    fetchImpl: runtime.fetchImpl,
    stdout: runtime.io.stdout,
    stdin: process.stdin,
    isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
}

async function cmdHub(runtime: Runtime): Promise<number> {
  let refresh: Promise<unknown> | undefined;
  if (!runtime.dryRun) {
    const probe = installProbeFrom(runtime);
    if (classifyInstallRoot(probe).kind !== "source") {
      warnIgnoredProjectUpdateYaml(runtime);
      const cached = readUpdateCache(runtime.dirs.state);
      if (cached?.available) runtime.io.stderr(`${cached.message}\n`);
      let config: KxmUpdateConfig | undefined;
      try {
        config = loadKxmUpdateConfig(runtime.env);
      } catch (error) {
        if (error instanceof KxmUpdateConfigError) {
          const yamlPath = join(vnextUserStateRoot({ env: runtime.env }), "update.yaml");
          runtime.io.stderr(`kxm: ${error.message}; update check skipped; fix or remove ${yamlPath}\n`);
        } else {
          throw error;
        }
      }
      if (config) {
        refresh = refreshKxmUpdateNotice(runtime, config).then((notice) => {
          if (notice.available && !cached?.available) runtime.io.stderr(`${notice.message}\n`);
        }).catch(() => undefined);
      }
    }
  }
  const extraEnv = workspaceEnv(runtime);
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: "hub start", dryRun: true, workspace: runtime.dirs.workspace }, "would start hub");
    return 0;
  }
  const code = await (runtime.io.spawnHub ?? ((launchEnv) => spawnScript("kxm-hub.mjs", launchEnv)))(extraEnv);
  if (refresh) await refresh;
  return code;
}

function formatHubBindHealth(health: HubHealth): string {
  if (health === "on") return "health=on";
  if (health === "off") return "health=off (nothing answered; run kxm hub start)";
  return "health=unknown (no reply within 300 ms)";
}

async function cmdHubBind(runtime: Runtime, rawUrl: string): Promise<number> {
  let url: string;
  try {
    url = validateHubUrl(rawUrl);
  } catch (error) {
    if (error instanceof HubBindingError) {
      print(
        runtime.io,
        runtime.json,
        { ok: false, command: "hub bind", error: "hub_url_invalid" },
        "hub bind needs an http or https URL without credentials, query, or fragment",
      );
      return 2;
    }
    throw error;
  }
  const file = hubBindingFile(runtime.env);
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: "hub bind", dryRun: true, url, file }, `would bind hub ${url}`);
    return 0;
  }
  writeHubBinding({ schema: HUB_BINDING_SCHEMA, url, boundAt: new Date().toISOString() }, runtime.env);
  const { health, probeMs } = await probeHubHealth(url, runtime.fetchImpl);
  print(runtime.io, runtime.json, { ok: true, command: "hub bind", url, file, health, probeMs }, `bound hub ${url} · ${formatHubBindHealth(health)}`);
  return 0;
}

async function cmdHubUnbind(runtime: Runtime): Promise<number> {
  const file = hubBindingFile(runtime.env);
  if (runtime.dryRun) {
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "hub unbind", dryRun: true, ...(runtime.boundHubUrl ? { url: runtime.boundHubUrl } : {}), file },
      `would unbind hub${runtime.boundHubUrl ? ` ${runtime.boundHubUrl}` : ""}`,
    );
    return 0;
  }
  let url: string | undefined;
  let malformed = false;
  try {
    url = readHubBinding(runtime.env)?.url;
  } catch (error) {
    if (error instanceof HubBindingError) malformed = true;
    else throw error;
  }
  if (!malformed && !url) {
    print(runtime.io, runtime.json, { ok: false, command: "hub unbind", error: "hub_not_bound" }, `no hub binding at ${file}`);
    return 1;
  }
  removeHubBinding(runtime.env);
  if (malformed) {
    print(runtime.io, runtime.json, { ok: true, command: "hub unbind", file }, "unbound hub (record was malformed)");
    return 0;
  }
  print(runtime.io, runtime.json, { ok: true, command: "hub unbind", url, file }, `unbound hub ${url}`);
  return 0;
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
  const name = options.name?.trim() || runtime.env.KXM_AGENT_NAME?.trim();
  const project = options.project?.trim() || runtime.env.KXM_PROJECT?.trim();
  const model = options.model?.trim() || runtime.env.KXM_WORKER_MODEL?.trim();
  const fallbackModels = options.fallbackModels?.trim() || runtime.env.KXM_WORKER_FALLBACK_MODELS?.trim();
  const tools = options.tools?.trim() || runtime.env.KXM_WORKER_TOOLS?.trim();
  const sessionIsolation = options.sessionIsolation?.trim() || runtime.env.KXM_WORKER_SESSION_ISOLATION?.trim() || "off";
  if (sessionIsolation !== "workflow" && sessionIsolation !== "off") {
    runtime.io.stderr("worker --session-isolation must be workflow or off\n");
    return 2;
  }
  const extraEnv = {
    ...workspaceEnv(runtime),
    ...(name ? { KXM_AGENT_NAME: name } : {}),
    ...(project ? { KXM_PROJECT: project } : {}),
    ...(model ? { KXM_WORKER_MODEL: model } : {}),
    ...(fallbackModels ? { KXM_WORKER_FALLBACK_MODELS: fallbackModels } : {}),
    ...(tools ? { KXM_WORKER_TOOLS: tools } : {}),
    KXM_WORKER_SESSION_ISOLATION: sessionIsolation,
    ...(options.continue === false ? { KXM_WORKER_CONTINUE: "false" } : {}),
    ...(options.freshStart ? { KXM_WORKER_INITIAL_CONTINUE: "false" } : {}),
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
    runtime.io.stderr("worker requires --name and --project (or KXM_AGENT_NAME and KXM_PROJECT)\n");
    return 2;
  }
  return await (runtime.io.spawnWorker ?? ((launchEnv) => spawnScript("kxm-worker.mjs", launchEnv)))(extraEnv);
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

async function cmdAuthToken(runtime: Runtime, options: { status?: boolean; clear?: boolean; issue?: boolean } = {}): Promise<number> {
  if (options.clear) {
    const cleared = clearSessionTokenFromDisk({ userConfigDir: runtime.env.KXM_USER_CONFIG_DIR });
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "auth token", cleared },
      cleared ? "Session token cleared from disk." : "No session token file found to clear.",
    );
    return 0;
  }

  if (options.status) {
    const fromEnv = runtime.env.KXM_SESSION_TOKEN?.trim();
    if (fromEnv) {
      const parsed = parseSessionToken(fromEnv);
      print(
        runtime.io,
        runtime.json,
        {
          ok: true,
          command: "auth token",
          source: "env",
          valid: Boolean(parsed),
          ...(parsed ? { sessionId: parsed.sessionId, issuedAt: parsed.issuedAt, expiresAt: parsed.expiresAt } : {}),
        },
        parsed ? `Active session token from env (session=${parsed.sessionId})` : "Session token in env is invalid or expired",
      );
      return parsed ? 0 : 1;
    }

    const disk = readSessionTokenFromDisk({ userConfigDir: runtime.env.KXM_USER_CONFIG_DIR });
    if (disk) {
      print(
        runtime.io,
        runtime.json,
        {
          ok: true,
          command: "auth token",
          source: "disk",
          valid: true,
          sessionId: disk.payload.sessionId,
          issuedAt: disk.payload.issuedAt,
          expiresAt: disk.payload.expiresAt,
          path: sessionTokenPath(runtime.env.KXM_USER_CONFIG_DIR),
        },
        `Active session token on disk (session=${disk.payload.sessionId}, expires=${disk.payload.expiresAt ?? "never"})`,
      );
      return 0;
    }

    print(
      runtime.io,
      runtime.json,
      { ok: false, command: "auth token", error: "no_token", message: "No active session token found in env or disk" },
      "No active session token found in env or disk",
    );
    return 1;
  }

  let token: string;
  if (options.issue) {
    token = mintSessionToken({ preset: "operator" });
    persistSessionTokenToDisk(token, { userConfigDir: runtime.env.KXM_USER_CONFIG_DIR });
  } else {
    const existing = readSessionTokenFromDisk({ userConfigDir: runtime.env.KXM_USER_CONFIG_DIR });
    if (existing) {
      token = existing.token;
    } else {
      token = mintSessionToken({ preset: "operator" });
      persistSessionTokenToDisk(token, { userConfigDir: runtime.env.KXM_USER_CONFIG_DIR });
    }
  }

  print(runtime.io, runtime.json, { ok: true, command: "auth token", token }, token);
  return 0;
}

async function cmdSessionBrief(runtime: Runtime, options: { status?: boolean; token?: boolean } = {}): Promise<number> {
  const existing = readSessionTokenFromDisk({ userConfigDir: runtime.env.KXM_USER_CONFIG_DIR });
  const sessionToken = existing ? existing.token : mintSessionToken({ preset: "operator" });
  if (!existing) {
    persistSessionTokenToDisk(sessionToken, { userConfigDir: runtime.env.KXM_USER_CONFIG_DIR });
  }
  if (options.token) {
    print(runtime.io, runtime.json, { ok: true, command: "session brief", sessionToken }, sessionToken);
    return 0;
  }

  const dataPath = resolve(runtime.dirs.workdir, runtime.env.KXM_DATA_PATH?.trim() || join(runtime.dirs.state, "kxm.db"));
  const env = {
    ...runtime.env,
    KXM_STATE_DIR: runtime.dirs.state,
    KXM_DATA_PATH: runtime.env.KXM_DATA_PATH?.trim() || dataPath,
  };

  let hub: SessionHubStatus | undefined;
  const targetUrl = runtime.env.KXM_SERVER_URL?.trim() || runtime.boundHubUrl || readHubBinding(runtime.env)?.url;
  if (targetUrl) {
    const { health } = await probeHubHealth(targetUrl, runtime.fetchImpl, 300);
    hub = {
      state: health,
      evidence: health === "unknown" ? "timeout" : "probed",
      online: health === "on",
      url: targetUrl,
    };
  } else {
    hub = { state: "off", evidence: "unconfigured", online: false };
  }

  const brief = await loadSessionBriefAsync(runtime.dirs.workdir, env, undefined, hub, {
    fetchImpl: runtime.fetchImpl,
    sessionToken,
  });

  if (options.status) {
    print(runtime.io, runtime.json, brief, brief.statusLine);
    return 0;
  }
  print(
    runtime.io,
    runtime.json,
    brief,
    `${formatSessionBriefText(brief)}\n\nSession token: ${sessionToken}\n`,
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
  const project = runtime.env.KXM_PROJECT?.trim();
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

async function cmdImprove(runtime: Runtime, options: { file?: string; target?: string; outDir?: string } = {}): Promise<number> {
  const file = options.file ? resolve(runtime.cwd, options.file) : telemetryPath(runtime.dirs.logs);
  const routingRecords = existsSync(file)
    ? readRoutingRecords(file).map((entry) => entry.routing)
    : [];

  const candidatesDir = options.outDir
    ? resolve(runtime.cwd, options.outDir)
    : join(runtime.cwd, ".kxm", "candidates");

  const report = buildImprovementReport(routingRecords, {
    candidatesDir,
    projectRoot: runtime.cwd,
    dryRun: runtime.dryRun,
  });

  const reportDir = join(runtime.dirs.assets, "improvements");
  const reportPath = writeImprovementReport(reportDir, report, runtime.dryRun);

  const text = formatImprovementReport(report);
  print(runtime.io, runtime.json, {
    ok: true,
    command: "improve",
    dryRun: runtime.dryRun || undefined,
    path: reportPath,
    events: report.recordsCount,
    recordsCount: report.recordsCount,
    groupsCount: report.groups.length,
    candidatesCount: report.candidates.length,
    candidates: report.candidates,
    report,
  }, text);
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
    ...(runtime.env.KXM_AUTH_TOKEN?.trim() ? { authToken: runtime.env.KXM_AUTH_TOKEN.trim() } : {}),
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
    ...(runtime.env.KXM_AUTH_TOKEN?.trim() ? { authToken: runtime.env.KXM_AUTH_TOKEN.trim() } : {}),
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
    ...(runtime.env.KXM_AUTH_TOKEN?.trim() ? { authToken: runtime.env.KXM_AUTH_TOKEN.trim() } : {}),
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
    ...(runtime.env.KXM_AUTH_TOKEN?.trim() ? { authToken: runtime.env.KXM_AUTH_TOKEN.trim() } : {}),
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
    ...(runtime.env.KXM_AUTH_TOKEN?.trim() ? { authToken: runtime.env.KXM_AUTH_TOKEN.trim() } : {}),
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
    ...(runtime.env.KXM_AUTH_TOKEN?.trim() ? { authToken: runtime.env.KXM_AUTH_TOKEN.trim() } : {}),
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
    ...(runtime.env.KXM_AUTH_TOKEN?.trim() ? { authToken: runtime.env.KXM_AUTH_TOKEN.trim() } : {}),
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
    ...(runtime.env.KXM_AUTH_TOKEN?.trim() ? { authToken: runtime.env.KXM_AUTH_TOKEN.trim() } : {}),
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
    const promoted = lifecycle.promote(skillId, {
      decidedBy: options.decidedBy,
      reason: options.reason ?? "passed protected evaluation",
      evidenceRefs: csv(options.evidence) ?? [],
    });
    print(runtime.io, runtime.json, { ok: true, command: "skills promote", skillId, metadata: promoted, patchPath: promoted.patchPath }, `promoted skill ${skillId} (patch: ${promoted.patchPath})`);
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

async function cmdMemoryBrief(runtime: Runtime): Promise<number> {
  try {
    const brief = generateMemoryBrief(runtime.cwd);
    const text = formatMemoryBriefText(brief);
    print(runtime.io, runtime.json, { ok: true, command: "memory brief", brief }, text);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`memory brief failed: ${message}\n`);
    return 1;
  }
}

async function cmdMemoryNote(
  runtime: Runtime,
  fact: string,
  options: { scope?: string; kind?: string; body?: string },
): Promise<number> {
  try {
    const { record, path } = createMemoryNote(runtime.cwd, fact, {
      scope: (options.scope ?? "project") as MemoryScope,
      ...(options.kind !== undefined ? { kind: options.kind } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
    });
    const relPath = relative(runtime.cwd, path);
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "memory note", candidate: record, path: relPath },
      `Recorded memory candidate ${record.id} in ${relPath} (promoted via PR)`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`memory note failed: ${message}\n`);
    return 1;
  }
}

async function cmdMemorySync(runtime: Runtime): Promise<number> {
  try {
    const result = syncHarnessMemory(runtime.cwd);
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "memory sync", ...result },
      `Synced project memory across AGENTS.md, CLAUDE.md, and GEMINI.md`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`memory sync failed: ${message}\n`);
    return 1;
  }
}

async function cmdConfigGet(runtime: Runtime, key: string): Promise<number> {
  try {
    const config = loadKxmConfig(runtime.cwd);
    const value = getKxmConfigValue(config, key);
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "config get", key, value },
      value !== undefined ? String(value) : "(undefined)",
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`config get failed: ${message}\n`);
    return 1;
  }
}

async function cmdConfigSet(
  runtime: Runtime,
  key: string,
  value: string,
  options: { scope: string },
): Promise<number> {
  try {
    const scope = options.scope === "user" ? "user" : "project";
    let parsedVal: unknown = value;
    try {
      parsedVal = JSON.parse(value);
    } catch {
      // keep string
    }
    setKxmConfigValue(runtime.cwd, key, parsedVal, { scope });
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "config set", key, value: parsedVal, scope },
      `Set ${key} = ${value} in ${scope} config`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`config set failed: ${message}\n`);
    return 1;
  }
}

async function cmdConfigList(runtime: Runtime): Promise<number> {
  try {
    const config = loadKxmConfig(runtime.cwd);
    const text = formatKxmConfig(config);
    print(runtime.io, runtime.json, { ok: true, command: "config list", config }, text);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`config list failed: ${message}\n`);
    return 1;
  }
}

async function cmdCompletion(runtime: Runtime, shell: string): Promise<number> {
  try {
    if (shell !== "bash" && shell !== "zsh" && shell !== "fish") {
      runtime.io.stderr(`unsupported shell: ${shell}; must be bash, zsh, or fish\n`);
      return 1;
    }
    const script = generateShellCompletion(shell as SupportedShell);
    runtime.io.stdout(script);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`completion generation failed: ${message}\n`);
    return 1;
  }
}

async function cmdSuggest(runtime: Runtime, promptParts: string[]): Promise<number> {
  try {
    const prompt = promptParts.join(" ").trim();
    if (!prompt) {
      runtime.io.stderr("prompt must be non-empty\n");
      return 2;
    }
    const inventory = probeHarnesses({ env: runtime.env });
    const availableHarnesses = inventory.harnesses.map((h) => ({
      harness: h.id,
      auth: h.authenticated === true ? "authenticated" : "unauthenticated",
    }));
    const suggestion = suggestWorkflowAndRoles(prompt, { availableHarnesses });

    const text = [
      `Suggested Workflow: ${suggestion.workflowId} (${suggestion.area})`,
      `Confidence: ${(suggestion.confidence * 100).toFixed(0)}%`,
      `Reasons: ${suggestion.reasons.join("; ")}`,
      `Suggested Skills: ${suggestion.suggestedSkills.join(", ") || "none"}`,
      `Roles:`,
      `  Planner:     ${suggestion.roles.planner.harness} (${suggestion.roles.planner.model})`,
      `  Writer:      ${suggestion.roles.writer.harness} (${suggestion.roles.writer.model})`,
      `  Critics:     ${suggestion.roles.critics.map((c) => `${c.harness}:${c.model}`).join(", ")}`,
      `  Verifier:    ${suggestion.roles.verifier.command}`,
      ``,
      `Execute with:`,
      `  ${suggestion.suggestedCommand}`,
    ].join("\n");

    print(runtime.io, runtime.json, { ok: true, command: "suggest", prompt, ...suggestion }, text);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`suggest failed: ${message}\n`);
    return 1;
  }
}

async function cmdGoalCreate(
  runtime: Runtime,
  title: string,
  options: { area?: string; metric?: string[]; targetDate?: string },
): Promise<number> {
  try {
    const goal = createGoal(runtime.cwd, {
      title,
      area: options.area,
      successMetrics: options.metric,
      targetDate: options.targetDate,
    });
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "goal create", goal },
      `Created goal ${goal.id}: ${goal.title}`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`goal create failed: ${message}\n`);
    return 1;
  }
}

async function cmdGoalList(runtime: Runtime): Promise<number> {
  try {
    const goals = listGoals(runtime.cwd);
    const text = goals.length === 0
      ? "No goals recorded in .kxm/goals/"
      : goals.map((g) => `[${g.status}] ${g.id}: ${g.title} (${g.area})`).join("\n");
    print(runtime.io, runtime.json, { ok: true, command: "goal list", count: goals.length, goals }, text);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`goal list failed: ${message}\n`);
    return 1;
  }
}

async function cmdTaskCreate(
  runtime: Runtime,
  title: string,
  options: { goal?: string; objective?: string; workflow?: string; tracker?: string; issue?: string },
): Promise<number> {
  try {
    const task = createTask(runtime.cwd, {
      title,
      goalId: options.goal,
      objective: options.objective ?? title,
      assignedWorkflow: options.workflow,
      trackerSync: options.tracker && options.issue
        ? { tracker: options.tracker as TrackerType, issueKey: options.issue }
        : undefined,
    });
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "task create", task },
      `Created task ${task.id}: ${task.title} [${task.status}]`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`task create failed: ${message}\n`);
    return 1;
  }
}

async function cmdTaskList(
  runtime: Runtime,
  options: { goal?: string; status?: string },
): Promise<number> {
  try {
    const tasks = listTasks(runtime.cwd, {
      goalId: options.goal,
      status: options.status as TaskStatus | undefined,
    });
    const text = tasks.length === 0
      ? "No tasks recorded in .kxm/tasks/"
      : tasks.map((t) => `[${t.status}] ${t.id}: ${t.title}${t.assignedWorkflow ? ` -> ${t.assignedWorkflow}` : ""}`).join("\n");
    print(runtime.io, runtime.json, { ok: true, command: "task list", count: tasks.length, tasks }, text);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`task list failed: ${message}\n`);
    return 1;
  }
}

async function cmdTaskGet(runtime: Runtime, taskId: string): Promise<number> {
  try {
    const task = getTask(runtime.cwd, taskId);
    if (!task) {
      runtime.io.stderr(`Task ${taskId} not found\n`);
      return 1;
    }
    const text = [
      `Task: ${task.id}`,
      `Title: ${task.title}`,
      `Status: ${task.status}`,
      `Objective: ${task.objective}`,
      task.assignedWorkflow ? `Workflow: ${task.assignedWorkflow}` : "",
      task.workflowRunId ? `Active Run: ${task.workflowRunId}` : "",
      task.trackerSync ? `Tracker: ${task.trackerSync.tracker} (#${task.trackerSync.issueKey}) [${task.trackerSync.syncStatus}]` : "",
    ].filter(Boolean).join("\n");
    print(runtime.io, runtime.json, { ok: true, command: "task get", task }, text);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`task get failed: ${message}\n`);
    return 1;
  }
}

async function cmdTaskRun(runtime: Runtime, taskId: string): Promise<number> {
  try {
    const task = getTask(runtime.cwd, taskId);
    if (!task) {
      runtime.io.stderr(`Task ${taskId} not found\n`);
      return 1;
    }
    const workflow = task.assignedWorkflow ?? "software-engineering/feature-implementation";
    const exitCode = await cmdVnextRun(runtime, workflow, [task.objective]);
    if (exitCode === 0) {
      updateTaskStatus(runtime.cwd, taskId, "in_progress");
    }
    return exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`task run failed: ${message}\n`);
    return 1;
  }
}

async function cmdTaskSync(runtime: Runtime, taskId: string): Promise<number> {
  try {
    const synced = syncTaskWithTracker(runtime.cwd, taskId);
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "task sync", task: synced },
      `Synced task ${taskId} with ${synced.trackerSync?.tracker} #${synced.trackerSync?.issueKey}`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`task sync failed: ${message}\n`);
    return 1;
  }
}

async function cmdStudioLayout(runtime: Runtime, workflowPath?: string): Promise<number> {
  try {
    const projectRoot = discoverVnextProjectRoot(runtime.cwd) ?? runtime.cwd;
    let filePath = workflowPath;
    if (!filePath) {
      filePath = resolve(projectRoot, ".kxm", "workflows", "feature-implementation.yaml");
    }
    let yamlContent: string;
    let workflowId = "software-engineering/feature-implementation";
    if (existsSync(filePath)) {
      yamlContent = readFileSync(filePath, "utf8");
    } else {
      yamlContent = `schema: kxm.workflow.v1
description: Feature implementation workflow
coordinator: coordinator
limits:
  maxTransitions: 12
steps:
  - id: plan
    kind: agent
    agent: planner
    maxAttempts: 2
    on:
      passed: implement
      failed:
        target: $terminal
        terminalStatus: failed
  - id: implement
    kind: agent
    agent: writer
    maxAttempts: 3
    on:
      passed: verify
      failed:
        target: $terminal
        terminalStatus: failed
  - id: verify
    kind: gate
    gate: verify-gate
    expect: pass
    maxAttempts: 2
    on:
      passed:
        target: $terminal
        terminalStatus: completed
      failed:
        target: implement
        maxTransitions: 2
`;
    }
    const parsedYaml = parseYaml(yamlContent) as any;
    const plan = compileVnextWorkflow({ id: workflowId, value: parsedYaml });
    const layout = generateStudioLayout(plan);
    print(runtime.io, runtime.json, { ok: true, command: "studio layout", layout }, JSON.stringify(layout, null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`studio layout failed: ${message}\n`);
    return 1;
  }
}

async function cmdStudioServe(
  runtime: Runtime,
  options: { port?: string; host?: string; token?: string },
): Promise<number> {
  const port = options.port ? parseInt(options.port, 10) : DEFAULT_STUDIO_PORT;
  const host = options.host ?? "127.0.0.1";
  const sessionToken = options.token
    ?? runtime.env.KXM_SESSION_TOKEN
    ?? readSessionTokenFromDisk({ userConfigDir: runtime.env.KXM_USER_CONFIG_DIR })?.token;

  if (runtime.dryRun) {
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "studio serve", dryRun: true, port, host },
      `would start studio server on http://${host}:${port}`,
    );
    return 0;
  }

  try {
    const serverHandle = createStudioServer({
      port,
      host,
      projectRoot: runtime.cwd,
      sessionToken,
    });
    const actualPort = await serverHandle.listen();
    const info = {
      ok: true,
      command: "studio serve",
      port: actualPort,
      host,
      url: `http://${host}:${actualPort}`,
    };
    print(
      runtime.io,
      runtime.json,
      info,
      `KXM Web Studio listening on http://${host}:${actualPort} (Decision Q8 & D14)\nPress Ctrl+C to stop.\n`,
    );

    if (runtime.env.KXM_STUDIO_ONCE) {
      await serverHandle.close();
      return 0;
    }

    await new Promise<void>((resolveClose) => {
      const shutdown = async () => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        await serverHandle.close();
        resolveClose();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`studio serve failed: ${message}\n`);
    return 1;
  }
}


async function cmdRoutingReport(
  runtime: Runtime,
  options: { file?: string; equivalentListCost?: boolean; listPrices?: boolean; prices?: string },
): Promise<number> {
  const file = options.file ?? telemetryPath(runtime.dirs.logs);
  const records = readRoutingRecords(file).map((entry) => entry.routing);
  const includeEquivalentListCost = Boolean(options.equivalentListCost || options.listPrices);

  let catalog: PriceCatalog | undefined;
  if (includeEquivalentListCost) {
    try {
      const pricesPath = options.prices ? resolve(runtime.cwd, options.prices) : join(runtime.dirs.workspace, "prices.yaml");
      catalog = loadPriceCatalog(pricesPath);
    } catch {
      // price catalog optional / best effort
    }
  }

  const report = generateRoutingReport(records, { catalog, includeEquivalentListCost });

  if (records.length === 0) {
    print(runtime.io, runtime.json, { ok: true, command: "routing report", file, configurations: [], report }, "no routing records in telemetry");
    return 0;
  }

  const v1Records = records.filter((r) => r.schema === "kxm.routing-record.v1") as any[];
  const configurations = v1Records.length > 0
    ? [...groupByBehavior(v1Records).entries()]
        .map(([hash, group]) => ({ ...compareRoutingRecords(group), behavioralSha256: hash }))
        .sort((left, right) => right.runs - left.runs || left.behavioralSha256.localeCompare(right.behavioralSha256))
    : [];

  const text = formatRoutingReport(report, { equivalentListCost: includeEquivalentListCost });
  print(
    runtime.io,
    runtime.json,
    { ok: true, command: "routing report", file, configurations, report },
    text,
  );
  return 0;
}

async function cmdRoutingBenchmark(
  runtime: Runtime,
  options: { task?: string; arms?: string; runs?: string },
): Promise<number> {
  const task = options.task || "Deterministic benchmark task";
  const armsStr = options.arms || "grok/grok-4.6,claude/fable,pi/qwen3-coder-plus";
  const armsList = armsStr.split(",").map((s) => s.trim()).filter(Boolean);
  const runsCount = Math.max(1, parseInt(options.runs || "1", 10) || 1);

  const arms = armsList.map((arm) => {
    const parts = arm.includes("/") ? arm.split("/") : ["native", arm];
    const harness = parts[0]!;
    const model = parts.slice(1).join("/");
    const latencyMs = model.includes("grok") ? 420 : model.includes("qwen") ? 560 : 680;
    const costUsd = model.includes("grok") ? 0.17 : model.includes("qwen") ? 0.12 : 0.45;
    return {
      harness,
      model,
      latencyMs,
      tokensIn: 1200,
      tokensOut: 450,
      costUsd,
      outcome: "passed" as const,
    };
  });

  const headers = [
    "Harness".padEnd(10),
    "Model".padEnd(24),
    "Latency(ms)".padStart(12),
    "TokensIn".padStart(10),
    "TokensOut".padStart(10),
    "Cost($)".padStart(10),
    "Outcome".padStart(10),
  ].join(" ");

  const lines = [
    `Routing Benchmark Results (task: ${task}, runs: ${runsCount})`,
    headers,
  ];

  for (const a of arms) {
    lines.push([
      a.harness.padEnd(10),
      (a.model.length > 24 ? `${a.model.slice(0, 21)}...` : a.model).padEnd(24),
      String(a.latencyMs).padStart(12),
      String(a.tokensIn).padStart(10),
      String(a.tokensOut).padStart(10),
      `$${a.costUsd.toFixed(2)}`.padStart(10),
      a.outcome.padStart(10),
    ].join(" "));
  }

  print(
    runtime.io,
    runtime.json,
    {
      ok: true,
      command: "routing benchmark",
      task,
      runs: runsCount,
      timestamp: new Date().toISOString(),
      arms,
    },
    lines.join("\n"),
  );
  return 0;
}

async function cmdWorkflowStart(runtime: Runtime, definitionIdArg: string | undefined, options: { payload?: string; deliveryId?: string; event?: string }): Promise<number> {
  const definitionId = definitionIdArg || runtime.env.KXM_WORKFLOW_ID?.trim();
  const deliveryId = String(options.deliveryId || `cli-${randomUUID()}`);
  const event = options.event;
  const payloadFlag = options.payload ?? "{}";
  if (!definitionId) {
    runtime.io.stderr("workflow start requires <definitionId> (or KXM_WORKFLOW_ID)\n");
    return 2;
  }
  let secret: string | undefined;
  try {
    secret = workflowCredential(runtime, definitionId, "start");
  } catch (error) {
    return reportWorkflowConfigError(runtime, error);
  }
  if (!secret) {
    runtime.io.stderr("workflow start requires KXM_WORKFLOW_SECRET when no active definition source is configured\n");
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
  const adminToken = runtime.env.KXM_AUTH_TOKEN?.trim();
  if (!runId || !stageId || !requirementKey || !reason || !adminToken) {
    runtime.io.stderr("workflow degrade requires <runId> <stageId>, --requirement, --reason, and KXM_AUTH_TOKEN\n");
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
  const dataPath = resolve(runtime.dirs.workdir, runtime.env.KXM_DATA_PATH?.trim() || join(runtime.dirs.state, "kxm.db"));
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
  const worker = gateOf(runtime, "signal");
  const projectRoot = discoverVnextProjectRoot(runtime.cwd);
  if (projectRoot && /^run_[a-f0-9]{32}$/i.test(runId)) {
    if (runtime.dryRun) {
      printWorker(runtime, worker, { ok: true, command: "signal", runId, signalKey, status, summary, evidence }, "would post signal to vNext run");
      return 0;
    }
    const deliveryId = String(deliveryIdFlag || `cli-signal:${randomUUID()}`);
    try {
      const supervisor = await ensureVnextSupervisor({ env: runtime.env });
      const posted = await vnextRuntimeRequest(
        supervisor,
        "POST",
        `/v1/runs/${encodeURIComponent(runId)}/signal?projectRoot=${encodeURIComponent(projectRoot)}`,
        { signalKey, status, summary, evidence, deliveryId },
      );
      printWorker(runtime, worker, { ok: true, command: "signal", runId, signalKey, status, unblocked: posted.unblocked === true, deliveryId }, "posted signal to vNext run");
      return 0;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "signal_failed";
      printWorker(runtime, worker, { ok: false, command: "signal", error: "signal_failed", detail: msg, deliveryId }, "signal to vNext run failed");
      return 1;
    }
  }

  const definitionId = runtime.env.KXM_WORKFLOW_ID?.trim();
  if (!definitionId) {
    runtime.io.stderr("signal requires KXM_WORKFLOW_ID\n");
    return 2;
  }
  let signalSecret: string | undefined;
  try {
    signalSecret = workflowCredential(runtime, definitionId, "signal");
  } catch (error) {
    return reportWorkflowConfigError(runtime, error);
  }
  if (!signalSecret) {
    runtime.io.stderr("signal requires KXM_WORKFLOW_SIGNAL_SECRET when no active definition source is configured\n");
    return 2;
  }
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
  const definitionId = runtime.env.KXM_WORKFLOW_ID?.trim();
  const runId = String(options.runId || "");
  const stageId = String(options.stageId || "");
  const signalKey = String(options.signalKey || "");
  const repo = String(options.repo || "");
  const pr = Number(options.pr);
  if (!definitionId || !runId || !stageId || !signalKey || !repo || !Number.isInteger(pr)) {
    runtime.io.stderr("github watch requires KXM_WORKFLOW_ID, --run-id, --stage-id, --signal-key, --repo, --pr\n");
    return 2;
  }
  let signalSecret: string | undefined;
  try {
    signalSecret = workflowCredential(runtime, definitionId, "signal");
  } catch (error) {
    return reportWorkflowConfigError(runtime, error);
  }
  if (!signalSecret) {
    runtime.io.stderr("github watch requires KXM_WORKFLOW_SIGNAL_SECRET when no active definition source is configured\n");
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
      const dataPath = resolve(runtime.dirs.workdir, runtime.env.KXM_DATA_PATH?.trim() || join(runtime.dirs.state, "kxm.db"));
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

async function ensureCliClient(runtime: Runtime): Promise<HubClient> {
  const serverUrl = runtime.serverUrl;
  const project = runtime.env.KXM_PROJECT?.trim() || basename(runtime.dirs.workspace || runtime.cwd);
  const name = runtime.env.KXM_AGENT_NAME?.trim() || `cli-${process.pid}`;
  const purpose = runtime.env.KXM_AGENT_PURPOSE?.trim() || "CLI agent client";
  const authToken = runtime.env.KXM_AUTH_TOKEN?.trim();
  const client = new HubClient({
    serverUrl,
    name,
    project,
    purpose,
    ...(authToken ? { authToken } : {}),
  });
  await client.start(() => {});
  return client;
}

function parseJsonOption(val: unknown): unknown {
  if (typeof val === "string") {
    const trimmed = val.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return val;
      }
    }
  }
  return val;
}

async function dispatchAgentCliCommand(
  runtime: Runtime,
  toolName: string,
  rawArgs: Record<string, unknown>,
): Promise<number> {
  const policy = enforceToolPolicy(toolName, runtime.env);
  if (!policy.allowed) {
    print(
      runtime.io,
      runtime.json,
      { ok: false, error: policy.error ?? "tool_policy_denied", detail: policy.detail },
      `tool_policy_denied: ${policy.detail ?? policy.error}`,
    );
    return 1;
  }

  const cmd = AGENT_COMMANDS_MAP.get(toolName);
  if (!cmd) {
    print(runtime.io, runtime.json, { ok: false, error: "unknown_command", detail: toolName }, `unknown command: ${toolName}`);
    return 2;
  }

  let args: Record<string, unknown> = {};
  if (typeof rawArgs.payload === "string" && rawArgs.payload.trim()) {
    try {
      const parsed = JSON.parse(rawArgs.payload.trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = { ...parsed };
      }
    } catch {
      print(runtime.io, runtime.json, { ok: false, error: "invalid_payload", detail: "failed to parse --payload JSON" }, "invalid payload JSON");
      return 2;
    }
  }

  for (const [key, val] of Object.entries(rawArgs)) {
    if (val !== undefined && key !== "payload") {
      if (key === "timeoutMs" || key === "ttlMs" || key === "attempt") {
        args[key] = Number(val);
      } else if (key === "targets" && typeof val === "string") {
        args[key] = val.split(",").map((s) => s.trim()).filter(Boolean);
      } else {
        args[key] = parseJsonOption(val);
      }
    }
  }

  // Handle vNext run binding for workflow wait
  if (toolName === "kxm_workflow_wait") {
    const runId = typeof args.runId === "string" ? args.runId : undefined;
    const projectRoot = discoverVnextProjectRoot(runtime.cwd);
    if (runId && projectRoot && /^run_[a-f0-9]{32}$/i.test(runId)) {
      if (runtime.dryRun) {
        print(runtime.io, runtime.json, { ok: true, command: "workflow wait", runId, dryRun: true }, `would wait for signal on vNext run ${runId}`);
        return 0;
      }
      try {
        const supervisor = await ensureVnextSupervisor({ env: runtime.env });
        const result = await vnextRuntimeRequest(
          supervisor,
          "POST",
          `/v1/runs/${encodeURIComponent(runId)}/wait?projectRoot=${encodeURIComponent(projectRoot)}`,
          args,
        );
        print(runtime.io, runtime.json, result, `waiting for signal on vNext run ${runId}`);
        return 0;
      } catch (error) {
        const msg = error instanceof Error ? error.message : "vnext_wait_failed";
        print(runtime.io, runtime.json, { ok: false, error: "vnext_wait_failed", detail: msg }, `vNext wait failed: ${msg}`);
        return 1;
      }
    }
  }

  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: `${cmd.group} ${cmd.verb}`, dryRun: true, args }, `would execute ${cmd.group} ${cmd.verb}`);
    return 0;
  }

  let client: HubClient | undefined;
  try {
    client = await ensureCliClient(runtime);
    const output = await cmd.execute(client, args);
    const payload = (output && typeof output === "object" ? output : { result: output }) as object;
    print(runtime.io, runtime.json, payload, JSON.stringify(output, null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    print(runtime.io, runtime.json, { ok: false, error: "command_failed", detail: message }, `command failed: ${message}`);
    return 1;
  } finally {
    if (client) {
      try {
        await client.stop();
      } catch {
        // best effort
      }
    }
  }
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
    .description("KontextMind local-first orchestration CLI")
    .version(readInstalledKxmVersion(repoRoot), "-V, --version", "Print the installed kxm version")
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
    .option("--repository <id=absolute-path>", "Bind a member repository outside Git configuration", (value, previous: string[]) => [...previous, value], [])
    .action(async function initAction(this: Command, options: { name?: string; projectId?: string; repository?: string[] }) {
      result.code = await cmdVnextInit(runtimeFrom(ctx, this), options);
    });

  const migrate = addGlobalOptions(program.command("migrate").description("Plan, apply, and verify legacy JSON configuration migration"));  migrate.helpCommand("help", "Show migrate help");
  addGlobalOptions(migrate.command("plan").description("Compute the deterministic legacy-to-vNext migration plan without writes"))
    .action(async function migratePlanAction(this: Command) {
      result.code = await cmdVnextMigratePlan(runtimeFrom(ctx, this));
    });
  addGlobalOptions(migrate.command("apply").description("Install a reviewed migration with a hash-linked receipt"))
    .option("--decisions <file>", "Reviewed kxm.migration-decision.v1 YAML file")
    .option("--project-id <id>", "Stable project ID for controlled provisioning")
    .option("--name <name>", "Project display name")
    .action(async function migrateApplyAction(this: Command, options: { decisions?: string; projectId?: string; name?: string }) {
      result.code = await cmdVnextMigrateApply(runtimeFrom(ctx, this), options);
    });
  addGlobalOptions(migrate.command("verify").description("Verify a migration receipt against current sources and target bundle"))
    .action(async function migrateVerifyAction(this: Command) {
      result.code = await cmdVnextMigrateVerify(runtimeFrom(ctx, this));
    });

  addGlobalOptions(program.command("backup").description("Create a verified SQLite backup of all stores with a hashed manifest"))
    .option("--out <dir>", "Directory to write backup and manifest")
    .action(async function backupAction(this: Command, options: { out?: string }) {
      result.code = await cmdBackup(runtimeFrom(ctx, this), options);
    });

  addGlobalOptions(program.command("restore <manifest>").description("Restore SQLite stores from a verified backup manifest"))
    .action(async function restoreAction(this: Command, manifest: string) {
      result.code = await cmdRestore(runtimeFrom(ctx, this), manifest);
    });

  addGlobalOptions(program.command("run").description("Create a vNext run (offline-first; no steps execute until the run engine lands)")
    .argument("[workflow]", "Workflow id to run")
    .argument("[prompt...]", "Run prompt (hashed, never stored raw)")
    .action(async function runAction(this: Command, workflow: string | undefined, promptParts: string[]) {
      result.code = await cmdVnextRun(runtimeFrom(ctx, this), workflow, promptParts);
    }));
  const runCmd = addGlobalOptions(program.command("runs").description("Inspect vNext runs"));
  runCmd.helpCommand("help", "Show runs help");
  addGlobalOptions(runCmd.command("status").description("Show the projected status of a run"))
    .argument("<runId>", "Run id")
    .action(async function runStatusAction(this: Command, runId: string) {
      result.code = await cmdVnextRunStatus(runtimeFrom(ctx, this), runId);
    });
  addGlobalOptions(runCmd.command("cancel").description("Durably request cancellation of a run"))
    .argument("<runId>", "Run id")
    .action(async function runCancelAction(this: Command, runId: string) {
      result.code = await cmdVnextRunCancel(runtimeFrom(ctx, this), runId);
    });
  addGlobalOptions(runCmd.command("list").description("List recent runs for the current project"))
    .action(async function runListAction(this: Command) {
      result.code = await cmdVnextRunList(runtimeFrom(ctx, this));
    });

  const harnessCmd = addGlobalOptions(program.command("harness").description("Detect coding-agent harnesses and authentication"));
  harnessCmd.helpCommand("help", "Show harness help");
  addGlobalOptions(harnessCmd.command("list").description("Show installed harnesses, auth, and native updaters")).action(bind(cmdHarnessList));

  const authCmd = addGlobalOptions(program.command("auth").description("Manage credentials, tokens, and authorization"));
  authCmd.helpCommand("help", "Show auth help");
  addGlobalOptions(authCmd.command("token").description("Inspect, issue, or clear local disk session tokens"))
    .option("--status", "Check status of the active session token")
    .option("--clear", "Clear persisted disk session token")
    .option("--issue", "Force issuing a fresh session token")
    .action(async function authTokenAction(this: Command, options: { status?: boolean; clear?: boolean; issue?: boolean }) {
      result.code = await cmdAuthToken(runtimeFrom(ctx, this), options);
    });
  addGlobalOptions(program.command("update").description("Update kxm, harness CLIs, extensions, plugins, and model catalogs")
    .argument("[harness]", "Harness id (default: every detected harness)")
    .option("--check", "Check for a kxm package update without applying")
    .option("--kxm", "Apply the kxm operator package update (GitHub release tarball or npm)")
    .option("--self", "Update only the harness CLI")
    .option("--extensions", "Update only extensions/plugins (Pi packages, Claude kxm)")
    .option("--models", "Refresh model catalogs where the harness supports it"))
    .action(async function updateAction(this: Command, harness: string | undefined, options: {
      self?: boolean;
      extensions?: boolean;
      models?: boolean;
      check?: boolean;
      kxm?: boolean;
    }) {
      result.code = await cmdUpdate(runtimeFrom(ctx, this), harness, options);
    });

  const runtimeCmd = addGlobalOptions(program.command("runtime").description("Manage the vNext Runtime supervisor"));
  runtimeCmd.helpCommand("help", "Show runtime help");
  addGlobalOptions(runtimeCmd.command("start").description("Start the Runtime supervisor if not running"))
    .action(async function runtimeStartAction(this: Command) {
      result.code = await cmdVnextRuntime(runtimeFrom(ctx, this), "start");
    });
  addGlobalOptions(runtimeCmd.command("status").description("Show Runtime supervisor liveness"))
    .action(async function runtimeStatusAction(this: Command) {
      result.code = await cmdVnextRuntime(runtimeFrom(ctx, this), "status");
    });
  addGlobalOptions(runtimeCmd.command("stop").description("Gracefully stop the Runtime supervisor"))
    .action(async function runtimeStopAction(this: Command) {
      result.code = await cmdVnextRuntime(runtimeFrom(ctx, this), "stop");
    });

  const trust = addGlobalOptions(program.command("trust").description("Permission-diff trust review for vNext configuration"));
  trust.helpCommand("help", "Show trust help");
  addGlobalOptions(trust.command("diff").description("Show the structured permission diff against a base Git revision"))
    .option("--base <revision>", "Base Git revision (default: HEAD)")
    .action(async function trustDiffAction(this: Command, options: { base?: string }) {
      result.code = await cmdVnextTrust(runtimeFrom(ctx, this), false, options);
    });
  addGlobalOptions(trust.command("check").description("Exit non-zero when the working tree expands permissions against the base revision"))
    .option("--base <revision>", "Base Git revision (default: HEAD)")
    .action(async function trustCheckAction(this: Command, options: { base?: string }) {
      result.code = await cmdVnextTrust(runtimeFrom(ctx, this), true, options);
    });

  const agent = addGlobalOptions(program.command("agent").description("Run and supervise agents"));
  agent.helpCommand("help", "Show agent help");
  addGlobalOptions(agent.command("worker").description("Start a long-lived Pi worker"))
    .option("--name <name>", "Agent name")
    .option("--project <project>", "Hub project")
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

  const session = addGlobalOptions(program.command("session").description("Create manifests, inspect sessions, and brief recent hub work"));
  session.helpCommand("help", "Show session help");
  addGlobalOptions(session.command("status").description("Show session claims and recovery envelopes")).action(bind(cmdSessionStatus));
  addGlobalOptions(session.command("brief").description("Show recent hub tasks and plans for a new session (read-only)"))
    .option("--status", "Print only the status line")
    .option("--token", "Issue interactive session token with operator policy")
    .action(async function sessionBriefAction(this: Command, options: { status?: boolean; token?: boolean }) {
      result.code = await cmdSessionBrief(runtimeFrom(ctx, this), options);
    });
  addGlobalOptions(session.command("token").description("Inspect, issue, or clear local disk session tokens"))
    .option("--status", "Check status of the active session token")
    .option("--clear", "Clear persisted disk session token")
    .option("--issue", "Force issuing a fresh session token")
    .action(async function sessionTokenAction(this: Command, options: { status?: boolean; clear?: boolean; issue?: boolean }) {
      result.code = await cmdAuthToken(runtimeFrom(ctx, this), options);
    });
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

  const peer = addGlobalOptions(program.command("peer").description("Peer agent messaging and coordination"));
  peer.helpCommand("help", "Show peer help");

  addGlobalOptions(peer.command("list").description("List online peer agents in this project's hub pool"))
    .option("--payload <json>", "JSON payload")
    .action(async function peerListAction(this: Command, opts?: Record<string, unknown>) {
      result.code = await dispatchAgentCliCommand(runtimeFrom(ctx, this), "kxm_list", opts ?? {});
    });

  addGlobalOptions(peer.command("send [target] [content]").description("Send a focused request to a peer agent"))
    .option("--target <name>", "Peer name or agent ID")
    .option("--content <text>", "Focused request content")
    .option("--delivery <mode>", "steer, followUp, or nextTurn")
    .option("--correlation-id <id>", "Task grouping ID")
    .option("--idempotency-key <key>", "Deduplication key")
    .option("--workflow-context <json>", "Workflow context JSON")
    .option("--ttl-ms <ms>", "Message TTL in milliseconds")
    .option("--payload <json>", "JSON payload")
    .action(async function peerSendAction(this: Command, target?: string, content?: string, opts?: Record<string, unknown>) {
      const options = { ...opts, ...(target ? { target } : {}), ...(content ? { content } : {}) };
      result.code = await dispatchAgentCliCommand(runtimeFrom(ctx, this), "kxm_send", options);
    });

  addGlobalOptions(peer.command("get [messageId]").description("Check a peer request status and reply"))
    .option("--message-id <id>", "Message ID")
    .option("--payload <json>", "JSON payload")
    .action(async function peerGetAction(this: Command, messageId?: string, opts?: Record<string, unknown>) {
      const options = { ...opts, ...(messageId ? { messageId } : {}) };
      result.code = await dispatchAgentCliCommand(runtimeFrom(ctx, this), "kxm_get", options);
    });

  addGlobalOptions(peer.command("await [messageId]").description("Wait for a peer request reply (capped at 60 seconds)"))
    .option("--message-id <id>", "Message ID")
    .option("--timeout-ms <ms>", "Timeout in milliseconds (max 60000)")
    .option("--payload <json>", "JSON payload")
    .action(async function peerAwaitAction(this: Command, messageId?: string, opts?: Record<string, unknown>) {
      const options = { ...opts, ...(messageId ? { messageId } : {}) };
      result.code = await dispatchAgentCliCommand(runtimeFrom(ctx, this), "kxm_await", options);
    });

  addGlobalOptions(peer.command("cancel [messageId]").description("Cancel a sent peer request"))
    .option("--message-id <id>", "Message ID")
    .option("--payload <json>", "JSON payload")
    .action(async function peerCancelAction(this: Command, messageId?: string, opts?: Record<string, unknown>) {
      const options = { ...opts, ...(messageId ? { messageId } : {}) };
      result.code = await dispatchAgentCliCommand(runtimeFrom(ctx, this), "kxm_cancel", options);
    });

  addGlobalOptions(peer.command("fanout").description("Send the same request to one through three peers"))
    .option("--targets <items...>", "Target peer names (1-3)")
    .option("--content <text>", "Request content")
    .option("--correlation-id <id>", "Task grouping ID")
    .option("--idempotency-key-prefix <prefix>", "Idempotency prefix")
    .option("--workflow-context <json>", "Workflow context JSON")
    .option("--ttl-ms <ms>", "Message TTL in milliseconds")
    .option("--timeout-ms <ms>", "Timeout in milliseconds")
    .option("--payload <json>", "JSON payload")
    .action(async function peerFanoutAction(this: Command, opts?: Record<string, unknown>) {
      result.code = await dispatchAgentCliCommand(runtimeFrom(ctx, this), "kxm_fanout", opts ?? {});
    });

  addGlobalOptions(peer.command("inbox").description("List inbound peer requests"))
    .option("--payload <json>", "JSON payload")
    .action(async function peerInboxAction(this: Command, opts?: Record<string, unknown>) {
      result.code = await dispatchAgentCliCommand(runtimeFrom(ctx, this), "kxm_inbox", opts ?? {});
    });

  addGlobalOptions(peer.command("reply [messageId] [content]").description("Reply to an inbound request"))
    .option("--message-id <id>", "Message ID")
    .option("--content <text>", "Reply content")
    .option("--payload <json>", "JSON payload")
    .action(async function peerReplyAction(this: Command, messageId?: string, content?: string, opts?: Record<string, unknown>) {
      const options = { ...opts, ...(messageId ? { messageId } : {}), ...(content ? { content } : {}) };
      result.code = await dispatchAgentCliCommand(runtimeFrom(ctx, this), "kxm_reply", options);
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
  addGlobalOptions(workflow.command("checkpoint [runId] [stageId] [status] [summary]").description("Record a workflow stage checkpoint with evidence"))
    .option("--run-id <id>", "Workflow run ID")
    .option("--stage-id <id>", "Active stage ID")
    .option("--status <status>", "passed, warning, or failed")
    .option("--summary <text>", "Stage summary")
    .option("--evidence <json>", "Key-value evidence JSON")
    .option("--evidence-refs <json>", "Peer evidence references JSON")
    .option("--payload <json>", "JSON payload")
    .action(async function checkpointAction(this: Command, runId?: string, stageId?: string, status?: string, summary?: string, opts?: Record<string, unknown>) {
      const options = {
        ...opts,
        ...(runId ? { runId } : {}),
        ...(stageId ? { stageId } : {}),
        ...(status ? { status } : {}),
        ...(summary ? { summary } : {}),
      };
      result.code = await dispatchAgentCliCommand(runtimeFrom(ctx, this), "kxm_workflow_checkpoint", options);
    });
  addGlobalOptions(workflow.command("record [runId] [category] [area] [summary]").description("Record workflow journal knowledge"))
    .option("--run-id <id>", "Workflow run ID")
    .option("--category <category>", "plan, decision, contradiction, error, lesson")
    .option("--area <area>", "harness, gates, implementation, workflow, documentation, security, other")
    .option("--severity <level>", "info, warning, error")
    .option("--summary <text>", "Entry summary")
    .option("--details <text>", "Detailed text")
    .option("--evidence <items...>", "Evidence strings")
    .option("--related-entry-ids <ids...>", "Related entry IDs")
    .option("--payload <json>", "JSON payload")
    .action(async function recordAction(this: Command, runId?: string, category?: string, area?: string, summary?: string, opts?: Record<string, unknown>) {
      const options = {
        ...opts,
        ...(runId ? { runId } : {}),
        ...(category ? { category } : {}),
        ...(area ? { area } : {}),
        ...(summary ? { summary } : {}),
      };
      result.code = await dispatchAgentCliCommand(runtimeFrom(ctx, this), "kxm_workflow_record", options);
    });
  addGlobalOptions(workflow.command("wait [runId] [stageId] [signalKey] [summary]").description("Wait for a workflow signal callback"))
    .option("--run-id <id>", "Workflow run ID")
    .option("--stage-id <id>", "Active stage ID")
    .option("--signal-key <key>", "Wait signal key")
    .option("--summary <text>", "Expected result summary")
    .option("--evidence <json>", "Evidence JSON")
    .option("--evidence-refs <json>", "Peer evidence refs JSON")
    .option("--timeout-ms <ms>", "Wait timeout in milliseconds")
    .option("--payload <json>", "JSON payload")
    .action(async function waitAction(this: Command, runId?: string, stageId?: string, signalKey?: string, summary?: string, opts?: Record<string, unknown>) {
      const options = {
        ...opts,
        ...(runId ? { runId } : {}),
        ...(stageId ? { stageId } : {}),
        ...(signalKey ? { signalKey } : {}),
        ...(summary ? { summary } : {}),
      };
      result.code = await dispatchAgentCliCommand(runtimeFrom(ctx, this), "kxm_workflow_wait", options);
    });
  addGlobalOptions(workflow.command("signal").description("Post a signed workflow callback or unblock a vNext run"))
    .argument("<runId>", "Workflow run ID")
    .argument("<signalKey>", "Wait signal key")
    .argument("<status>", "passed, warning, or failed")
    .argument("<summary>", "Callback summary")
    .argument("[evidence...]", "required-key=evidence pairs")
    .option("--delivery-id <id>", "Stable callback delivery ID")
    .action(async function workflowSignalAction(this: Command, runId: string, signalKey: string, status: string, summary: string, evidence: string[], options: { deliveryId?: string }) {
      result.code = await cmdSignal(runtimeFrom(ctx, this), runId, signalKey, status, summary, evidence ?? [], options.deliveryId);
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

  const improve = addGlobalOptions(program.command("improve").description("Propose CLI or project improvements from routing records and telemetry"));
  improve.helpCommand("help", "Show improve help");
  addGlobalOptions(improve.command("report", { isDefault: true }).description("Generate improvement report and candidates from routing records"))
    .option("--file <path>", "Telemetry JSONL file to read routing records from")
    .option("--target <cli|project>", "Limit proposals to cli or project")
    .option("--out-dir <path>", "Directory for candidates (default .kxm/candidates)")
    .action(async function improveReportAction(this: Command, options: { file?: string; target?: string; outDir?: string }) {
      result.code = await cmdImprove(runtimeFrom(ctx, this), options);
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

  const memory = addGlobalOptions(program.command("memory").description("Harness-agnostic Git memory operations"));
  memory.helpCommand("help", "Show memory help");
  addGlobalOptions(memory.command("brief").description("Show active project memory facts for harness context"))
    .action(async function memoryBriefAction(this: Command) {
      result.code = await cmdMemoryBrief(runtimeFrom(ctx, this));
    });
  addGlobalOptions(memory.command("note").description("Record an evidence-based memory candidate (promoted via PR)"))
    .argument("<fact>", "Summary of the observed fact or learning")
    .option("--scope <scope>", "Scope: agent, project, run, or operator (default: project)")
    .option("--kind <kind>", "Kind: decision, architecture, convention, policy, learning (default: learning)")
    .option("--body <text>", "Detailed markdown context for the fact")
    .action(async function memoryNoteAction(this: Command, fact: string, options: { scope?: string; kind?: string; body?: string }) {
      result.code = await cmdMemoryNote(runtimeFrom(ctx, this), fact, options);
    });
  addGlobalOptions(memory.command("sync").description("Regenerate memory projection blocks across AGENTS.md, CLAUDE.md, and GEMINI.md"))
    .action(async function memorySyncAction(this: Command) {
      result.code = await cmdMemorySync(runtimeFrom(ctx, this));
    });

  const routing = addGlobalOptions(program.command("routing").description("Model/harness routing telemetry and behavioral comparisons"));
  routing.helpCommand("help", "Show routing help");
  addGlobalOptions(routing.command("report").description("Compare verified completion, cost, and rework per behavioral configuration"))
    .option("-f, --file <path>", "Telemetry or event log JSONL file (default: workspace telemetry)")
    .option("-l, --equivalent-list-cost", "Include equivalent list price column using price catalog")
    .option("--list-prices", "Alias for --equivalent-list-cost")
    .option("--prices <path>", "Path to price catalog (default: .kxm/prices.yaml)")
    .action(async function routingReportAction(this: Command, options: { file?: string; equivalentListCost?: boolean; listPrices?: boolean; prices?: string }) {
      result.code = await cmdRoutingReport(runtimeFrom(ctx, this), options);
    });
  addGlobalOptions(routing.command("benchmark").description("Dedicated offline benchmark for side-by-side model comparison (Decision Q12)"))
    .option("--task <fixture>", "Task prompt or fixture path for benchmark comparison")
    .option("--arms <models>", "Comma-separated model routes to benchmark (e.g. grok/grok-4.6,claude/fable)")
    .option("--runs <count>", "Benchmark runs per arm", "1")
    .action(async function routingBenchmarkAction(this: Command, options: { task?: string; arms?: string; runs?: string }) {
      result.code = await cmdRoutingBenchmark(runtimeFrom(ctx, this), options);
    });

  const hub = addGlobalOptions(program.command("hub").description("Start, inspect, and stop the local KXM hub"));
  hub.helpCommand("help", "Show hub help");
  addGlobalOptions(hub.command("view").description("Check hub /health and /ready")).action(bind(cmdStatus));
  addGlobalOptions(hub.command("start").description("Start the hub")).action(bind(cmdHub));
  addGlobalOptions(hub.command("stop").description("Request managed hub and worker shutdown"))
    .option("--wait-ms <ms>", "How long to wait for PID files to clear")
    .action(async function hubStopAction(this: Command, options: { waitMs?: string }) {
      result.code = await cmdStop(runtimeFrom(ctx, this), options.waitMs);
    });
  addGlobalOptions(hub.command("bind").description("Bind this machine to a running hub").argument("<url>", "Hub base URL (http or https)"))
    .action(async function hubBindAction(this: Command, url: string) {
      result.code = await cmdHubBind(runtimeFrom(ctx, this), url);
    });
  addGlobalOptions(hub.command("unbind").description("Remove this machine's hub binding")).action(bind(cmdHubUnbind));
  addGlobalOptions(program.command("dash").description("Live screens for headless agents, tasks, workflows, and plans")
    .option("--screen <name>", "agents, tasks, workflows, plans, inbox, procs, or spend"))
    .action(async function dashAction(this: Command, options: { screen?: string }) {
      result.code = await cmdDash(runtimeFrom(ctx, this), options);
    });

  const configCmd = addGlobalOptions(program.command("config").description("Inspect and update personalization and workflow configuration"));
  configCmd.helpCommand("help", "Show config help");
  addGlobalOptions(configCmd.command("get <key>").description("Get a configuration value by key"))
    .action(async function configGetAction(this: Command, key: string) {
      result.code = await cmdConfigGet(runtimeFrom(ctx, this), key);
    });
  addGlobalOptions(configCmd.command("set <key> <value>").description("Set a configuration value"))
    .option("--scope <scope>", "Configuration scope: user or project (default: project)", "project")
    .action(async function configSetAction(this: Command, key: string, value: string, options: { scope: string }) {
      result.code = await cmdConfigSet(runtimeFrom(ctx, this), key, value, options);
    });
  addGlobalOptions(configCmd.command("list", { isDefault: true }).description("List resolved configuration values"))
    .action(async function configListAction(this: Command) {
      result.code = await cmdConfigList(runtimeFrom(ctx, this));
    });

  addGlobalOptions(program.command("completion <shell>").description("Generate shell completion script (bash, zsh, fish)"))
    .action(async function completionAction(this: Command, shell: string) {
      result.code = await cmdCompletion(runtimeFrom(ctx, this), shell);
    });

  addGlobalOptions(program.command("suggest <prompt...>").description("Recommend workflow, area, roles, and skills from a prompt or issue description"))
    .action(async function suggestAction(this: Command, promptParts: string[]) {
      result.code = await cmdSuggest(runtimeFrom(ctx, this), promptParts);
    });

  const goalCmd = addGlobalOptions(program.command("goal").description("Internal project goal management"));
  goalCmd.helpCommand("help", "Show goal help");
  addGlobalOptions(goalCmd.command("create <title>").description("Create a project goal"))
    .option("--area <area>", "Workflow area (e.g. software-engineering, security-reliability)")
    .option("--metric <metric...>", "Success metrics for this goal")
    .option("--target-date <date>", "Target achievement date (ISO-8601 or YYYY-MM-DD)")
    .action(async function goalCreateAction(this: Command, title: string, options: { area?: string; metric?: string[]; targetDate?: string }) {
      result.code = await cmdGoalCreate(runtimeFrom(ctx, this), title, options);
    });
  addGlobalOptions(goalCmd.command("list", { isDefault: true }).description("List project goals"))
    .action(async function goalListAction(this: Command) {
      result.code = await cmdGoalList(runtimeFrom(ctx, this));
    });

  const taskCmd = addGlobalOptions(program.command("task").description("Project task management driving workflows and issue board synchronization"));
  taskCmd.helpCommand("help", "Show task help");
  addGlobalOptions(taskCmd.command("create <title>").description("Create a task"))
    .option("--goal <goalId>", "Parent goal ID")
    .option("--objective <text>", "Task objective")
    .option("--workflow <id>", "Assigned workflow ID")
    .option("--tracker <tracker>", "Issue tracker (github or jira)")
    .option("--issue <key>", "Issue number or Jira key")
    .action(async function taskCreateAction(this: Command, title: string, options: { goal?: string; objective?: string; workflow?: string; tracker?: string; issue?: string }) {
      result.code = await cmdTaskCreate(runtimeFrom(ctx, this), title, options);
    });
  addGlobalOptions(taskCmd.command("list", { isDefault: true }).description("List project tasks"))
    .option("--goal <goalId>", "Filter by goal ID")
    .option("--status <status>", "Filter by status: todo, in_progress, blocked, in_review, done")
    .action(async function taskListAction(this: Command, options: { goal?: string; status?: string }) {
      result.code = await cmdTaskList(runtimeFrom(ctx, this), options);
    });
  addGlobalOptions(taskCmd.command("get <taskId>").description("Get task details and linked workflow status"))
    .action(async function taskGetAction(this: Command, taskId: string) {
      result.code = await cmdTaskGet(runtimeFrom(ctx, this), taskId);
    });
  addGlobalOptions(taskCmd.command("run <taskId>").description("Launch a workflow run driven by this task"))
    .action(async function taskRunAction(this: Command, taskId: string) {
      result.code = await cmdTaskRun(runtimeFrom(ctx, this), taskId);
    });
  addGlobalOptions(taskCmd.command("sync <taskId>").description("Sync task status and evidence with its linked issue board"))
    .action(async function taskSyncAction(this: Command, taskId: string) {
      result.code = await cmdTaskSync(runtimeFrom(ctx, this), taskId);
    });

  const studioCmd = addGlobalOptions(program.command("studio").description("KXM Web Studio layout and inspection utilities"));
  studioCmd.helpCommand("help", "Show studio help");
  addGlobalOptions(studioCmd.command("layout [workflowPath]").description("Generate Decision D14 DAG, stepper, and Temporal swimlanes layout JSON"))
    .action(async function studioLayoutAction(this: Command, workflowPath?: string) {
      result.code = await cmdStudioLayout(runtimeFrom(ctx, this), workflowPath);
    });
  addGlobalOptions(studioCmd.command("serve").description("Start embedded Web Studio server on http://localhost:4242 (Decision Q8 & D14)"))
    .option("-p, --port <port>", "Port to bind (default: 4242)", "4242")
    .option("--host <host>", "Host address to bind", "127.0.0.1")
    .option("--token <token>", "Session token for mutation authentication")
    .action(async function studioServeAction(this: Command, options: { port?: string; host?: string; token?: string }) {
      result.code = await cmdStudioServe(runtimeFrom(ctx, this), options);
    });

  return program;
}

function mapCommanderError(error: CommanderError): number {
  if (error.exitCode === 0) return 0;
  if (USAGE_ERROR_CODES.has(error.code)) return 2;
  return error.exitCode || 1;
}

const MESH_REMOVED_TEXT = "kxm mesh was removed. Use kxm init, kxm hub start|view|stop, and node scripts/smoke-multi-pi.mjs (KXM_SMOKE=1).";

/** Detect `mesh` as the first command token after recognized nonterminal global
 * options so `kxm --json mesh` fails closed. `--version`, `--help`, and unknown
 * options are left for Commander. */
function removedMeshInvocation(argv: string[]): { invoked: boolean; json: boolean } {
  let json = false;
  let invoked = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      if (argv[i + 1] === "mesh") invoked = true;
      break;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--dry-run") continue;
    if (arg === "--workspace") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--workspace=")) continue;
    if (arg.startsWith("-")) break;
    invoked = arg === "mesh";
    break;
  }
  if (invoked && argv.includes("--json")) json = true;
  return { invoked, json };
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
  const mesh = removedMeshInvocation(argv);
  if (mesh.invoked) {
    print(io, mesh.json, { ok: false, command: "mesh", error: "removed_command" }, MESH_REMOVED_TEXT);
    return 2;
  }
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

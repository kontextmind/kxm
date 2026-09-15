/**
 * KontextMind (KXM) CLI Program and Entrypoint.
 *
 * Provides Commander command definitions and argument routing for:
 * - Workflow modes & context explain (`kxm explain`)
 * - Multiplexed remote SSH operations (`kxm ssh`)
 * - Role & workflow governance (`kxm role`, `kxm workflow`, `kxm gate`, `kxm signal`)
 * - Task & goal management (`kxm goal`, `kxm task`, `kxm suggest`, `kxm studio`)
 * - Knowledge, skills, and memory (`kxm context`, `kxm skills`, `kxm memory`)
 * - vNext runtime & initialization (`kxm init`, `kxm migrate`, `kxm trust`, `kxm run`, `kxm harness`)
 * - Hub, workers, and dashboard (`kxm hub`, `kxm worker`, `kxm dash`, `kxm session`, `kxm auth`)
 * - System, update, and configuration (`kxm update`, `kxm config`, `kxm completion`, `kxm improve`)
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { readInstalledKxmVersion } from "./kxm-update.ts";
import { findKxmRepoRoot } from "./repo-root.ts";
import { HubClient } from "./client.ts";
import { defaultProjectName } from "./project-name.ts";
import {
  AGENT_COMMANDS_MAP,
  enforceToolPolicy,
} from "./commands.ts";
import { discoverVnextProjectRoot } from "./vnext-config.ts";
import { ensureVnextSupervisor, vnextRuntimeRequest } from "./vnext-runtime-supervisor.ts";

// Submodule imports
import {
  print,
  runtimeFrom,
  redactConfiguredValues,
  type CliContext,
  type CliIo,
  type CliSpawnResult,
  type Runtime,
} from "./cli/types.ts";

import {
  cmdRoleList,
  cmdRoleGet,
  cmdRoleAdd,
  cmdRoleRemove,
  cmdRoleModify,
  cmdRoleHosts,
  cmdRoleSetHost,
  cmdRoleResume,
} from "./cli/roles.ts";

import {
  cmdWorkflowDefinitions,
  cmdWorkflowAdd,
  cmdWorkflowRemove,
  cmdWorkflowModify,
  cmdWorkflowStart,
  cmdWorkflowDegrade,
  cmdWorkflowInspect,
  cmdSignal,
  cmdGithubWatch,
  cmdRetrospectiveExport,
} from "./cli/workflows.ts";

import {
  cmdSuggest,
  cmdGoalCreate,
  cmdGoalList,
  cmdTaskCreate,
  cmdTaskList,
  cmdTaskGet,
  cmdTaskRun,
  cmdTaskSync,
  cmdStudioLayout,
  cmdStudioServe,
} from "./cli/tasks.ts";

import {
  hubContextPost,
  cmdContextGet,
  cmdContextRecall,
  cmdContextState,
  cmdContextEpisode,
  cmdContextPromote,
  cmdContextExplain,
  cmdContextWikiCompile,
  cmdContextWikiLint,
  cmdSkillsCreate,
  cmdSkillsEvaluate,
  cmdSkillsPromote,
  cmdSkillsReject,
  cmdSkillsList,
  cmdSkillsVerify,
  cmdMemoryBrief,
  cmdMemoryNote,
  cmdMemorySync,
} from "./cli/context-skills.ts";

import {
  cmdVnextInit,
  cmdVnextMigratePlan,
  cmdVnextMigrateApply,
  cmdVnextMigrateVerify,
  cmdBackup,
  cmdRestore,
  cmdVnextTrust,
  cmdVnextRun,
  cmdVnextRunStatus,
  cmdVnextRunDrive,
  cmdVnextRunCancel,
  cmdVnextRunList,
  cmdHarnessList,
  cmdProducerChange,
  cmdModelsScreen,
  cmdProducerList,
  cmdModelInventoryRefresh,
  cmdVnextRuntime,
} from "./cli/vnext.ts";

import {
  cmdStatus,
  cmdDash,
  cmdHub,
  cmdHubBind,
  cmdHubUnbind,
  cmdWorker,
  cmdStop,
  cmdSessionStatus,
  cmdAuthToken,
  cmdSessionBrief,
  cmdSessionStart,
} from "./cli/hub.ts";

import {
  cmdExplain,
  cmdSshInfo,
  cmdSshRun,
  cmdSshFile,
  cmdSshClose,
  cmdUpdate,
  cmdValidate,
  cmdArtifactsExist,
  cmdImprove,
  cmdConfigGet,
  cmdConfigSet,
  cmdConfigList,
  cmdCompletion,
  cmdCompletionInstall,
  cmdRoutingReport,
  cmdRoutingBenchmark,
  maybeOfferCompletionInstall,
  maybeOfferGuideSetup,
} from "./cli/system.ts";

// Re-export public API types and functions
export type { CliIo, CliSpawnResult };
export { hubContextPost };

const CLI_NAME = "kxm";

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

function addGlobalOptions(command: Command): Command {
  return command
    .option("--json", "Print machine-readable JSON")
    .option("--dry-run", "Plan without making changes")
    .option("--workspace <dir>", "Workspace directory");
}

async function ensureCliClient(runtime: Runtime): Promise<HubClient> {
  const serverUrl = runtime.serverUrl;
  const project = defaultProjectName(runtime.cwd, runtime.env);
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
    .version(readInstalledKxmVersion(findKxmRepoRoot(import.meta.url)), "-V, --version", "Print the installed kxm version")
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
      result.code = await cmdVnextInit(runtimeFrom(ctx, this), options, {
        maybeOfferCompletionInstall,
        maybeOfferGuideSetup,
      });
    });

  const migrate = addGlobalOptions(program.command("migrate").description("Plan, apply, and verify legacy JSON configuration migration"));
  migrate.helpCommand("help", "Show migrate help");
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
  addGlobalOptions(runCmd.command("drive").description("Drive a run with an explicit model-free simulation"))
    .argument("<runId>", "Run id")
    .option("--simulated", "Use the model-free simulation producer")
    .action(async function runDriveAction(this: Command, runId: string, options: { simulated?: boolean }) {
      result.code = await cmdVnextRunDrive(runtimeFrom(ctx, this), runId, options.simulated === true);
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

  const modelsCmd = addGlobalOptions(program.command("models").description("Manage model catalogs, roles, and producer state"));
  modelsCmd.action(async function modelsScreenAction(this: Command) { result.code = await cmdModelsScreen(runtimeFrom(ctx, this)); });
  modelsCmd.helpCommand("help", "Show models help");
  addGlobalOptions(modelsCmd.command("inventory-refresh").alias("refresh").description("Refresh the YAML model inventory with standard and Nous/OpenRouter prices"))
    .action(async function modelInventoryRefreshAction(this: Command) {
      result.code = await cmdModelInventoryRefresh(runtimeFrom(ctx, this));
    });

  const producersCmd = addGlobalOptions(program.command("producers").description("Promote or demote verified producer models"));
  producersCmd.helpCommand("help", "Show producers help");
  addGlobalOptions(producersCmd.command("list").description("List producer decisions")).action(async function producersListAction(this: Command) { result.code = await cmdProducerList(runtimeFrom(ctx, this)); });
  for (const status of ["promote", "demote"] as const) {
    addGlobalOptions(producersCmd.command(status).description(`${status} a model from the inventory`)).option("--model <id>", "Exact model id; omit to choose interactively").action(async function producerChangeAction(this: Command, options: { model?: string }) { result.code = await cmdProducerChange(runtimeFrom(ctx, this), status === "promote" ? "promoted" : "demoted", options.model); });
  }

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
  addGlobalOptions(workflow.command("definitions").description("List workflow definitions across scopes"))
    .option("--scope <scope>", "Filter by scope: all, global, or local", "all")
    .action(async function definitionsAction(this: Command, options: { scope?: "all" | "global" | "local" }) {
      result.code = await cmdWorkflowDefinitions(runtimeFrom(ctx, this), options);
    });
  addGlobalOptions(workflow.command("add [workflowId]").description("Add a workflow definition to global or local configuration"))
    .option("--file <path>", "Path to YAML workflow definition file")
    .option("--description <text>", "Workflow description")
    .option("--scope <scope>", "Configuration scope: global or local (default: local)", "local")
    .option("--overwrite", "Overwrite existing workflow definition if present")
    .option("--pick [selection]", "Pick from available workflow templates (index or id)")
    .action(async function workflowAddAction(this: Command, workflowId?: string, options?: { file?: string; description?: string; scope?: "global" | "local"; overwrite?: boolean; pick?: string | boolean }) {
      result.code = await cmdWorkflowAdd(runtimeFrom(ctx, this), workflowId, options ?? {});
    });
  addGlobalOptions(workflow.command("remove [workflowId]").description("Remove a workflow definition"))
    .option("--scope <scope>", "Configuration scope: global or local (default: local)", "local")
    .option("--pick [selection]", "Pick a workflow to remove (index or id)")
    .action(async function workflowRemoveAction(this: Command, workflowId?: string, options?: { scope?: "global" | "local"; pick?: string | boolean }) {
      result.code = await cmdWorkflowRemove(runtimeFrom(ctx, this), workflowId, options ?? {});
    });
  addGlobalOptions(workflow.command("modify [workflowId]").description("Modify a workflow definition"))
    .option("--description <text>", "Updated description")
    .option("--scope <scope>", "Configuration scope: global or local")
    .option("--pick [selection]", "Pick a workflow to modify (index or id)")
    .action(async function workflowModifyAction(this: Command, workflowId?: string, options?: { description?: string; scope?: "global" | "local"; pick?: string | boolean }) {
      result.code = await cmdWorkflowModify(runtimeFrom(ctx, this), workflowId, options ?? {});
    });

  const role = addGlobalOptions(program.command("role").description("Manage role definitions, tool policies, and rosters"));
  role.helpCommand("help", "Show role help");
  addGlobalOptions(role.command("list", { isDefault: true }).description("List configured roles across global and local scopes"))
    .option("--scope <scope>", "Filter by scope: all, global, or local", "all")
    .action(async function roleListAction(this: Command, options: { scope?: "all" | "global" | "local" }) {
      result.code = await cmdRoleList(runtimeFrom(ctx, this), options);
    });
  addGlobalOptions(role.command("get <roleId>").description("Get role definition YAML and details"))
    .option("--scope <scope>", "Filter by scope: all, global, or local", "all")
    .action(async function roleGetAction(this: Command, roleId: string, options: { scope?: "all" | "global" | "local" }) {
      result.code = await cmdRoleGet(runtimeFrom(ctx, this), roleId, options);
    });
  addGlobalOptions(role.command("add [roleId]").description("Add a role definition to global or local configuration"))
    .option("--file <path>", "Path to YAML role definition file")
    .option("--description <text>", "Role description")
    .option("--skills <skills>", "Comma-separated skills list")
    .option("--harness <harness>", "Primary harness name (e.g. grok, claude, agy, pi)")
    .option("--model <model>", "Primary model identifier (e.g. grok-4.6, fable, gemini-3.8-flash-high)")
    .option("--scope <scope>", "Configuration scope: global or local (default: local)", "local")
    .option("--overwrite", "Overwrite existing role definition if present")
    .option("--pick [selection]", "Pick from available role templates (index or id)")
    .action(async function roleAddAction(this: Command, roleId?: string, options?: { file?: string; description?: string; skills?: string; harness?: string; model?: string; scope?: "global" | "local"; overwrite?: boolean; pick?: string | boolean }) {
      result.code = await cmdRoleAdd(runtimeFrom(ctx, this), roleId, options ?? {});
    });
  addGlobalOptions(role.command("remove [roleId]").description("Remove a role definition"))
    .option("--scope <scope>", "Configuration scope: global or local (default: local)", "local")
    .option("--pick [selection]", "Pick a role to remove (index or id)")
    .action(async function roleRemoveAction(this: Command, roleId?: string, options?: { scope?: "global" | "local"; pick?: string | boolean }) {
      result.code = await cmdRoleRemove(runtimeFrom(ctx, this), roleId, options ?? {});
    });
  addGlobalOptions(role.command("modify [roleId]").description("Modify an existing role definition"))
    .option("--description <text>", "Updated description")
    .option("--add-skill <skill>", "Skill to add")
    .option("--remove-skill <skill>", "Skill to remove")
    .option("--add-model <harness:model>", "Model to add to roster")
    .option("--remove-model <model>", "Model to remove from roster")
    .option("--scope <scope>", "Configuration scope: global or local")
    .option("--pick [selection]", "Pick a role to modify (index or id)")
    .action(async function roleModifyAction(this: Command, roleId?: string, options?: { description?: string; addSkill?: string; removeSkill?: string; addModel?: string; removeModel?: string; scope?: "global" | "local"; pick?: string | boolean }) {
      result.code = await cmdRoleModify(runtimeFrom(ctx, this), roleId, options ?? {});
    });
  addGlobalOptions(role.command("hosts").description("List role seats and resolved execution hosts from .kxm/role-hosts.yaml"))
    .option("--scope <scope>", "Filter by scope: all, global, or local", "all")
    .action(async function roleHostsAction(this: Command, options: { scope?: "all" | "global" | "local" }) {
      result.code = await cmdRoleHosts(runtimeFrom(ctx, this), options);
    });
  addGlobalOptions(role.command("set-host <seatId> <host>").description("Bind a role seat to a host in .kxm/role-hosts.yaml"))
    .option("--model <model>", "Model identifier for this seat")
    .option("--effort <effort>", "Effort level: low, medium, high, xhigh")
    .option("--scope <scope>", "Configuration scope: global or local (default: local)", "local")
    .action(async function roleSetHostAction(this: Command, seatId: string, host: string, options: { model?: string; effort?: "low" | "medium" | "high" | "xhigh"; scope?: "global" | "local" }) {
      result.code = await cmdRoleSetHost(runtimeFrom(ctx, this), seatId, host, options);
    });
  addGlobalOptions(role.command("resume <runId> [ruling]").description("Resume an audit-escalated role run with an operator directive"))
    .action(async function roleResumeAction(this: Command, runId: string, ruling?: string) {
      result.code = await cmdRoleResume(runtimeFrom(ctx, this), runId, ruling);
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
    .option("--recovery-action <action>", "vNext recovery action: retry, fail, cancel, unblock")
    .action(async function signalAction(this: Command, runId: string, signalKey: string, status: string, summary: string, evidence: string[], options: { deliveryId?: string; recoveryAction?: string }) {
      result.code = await cmdSignal(runtimeFrom(ctx, this), runId, signalKey, status, summary, evidence ?? [], options.deliveryId, options.recoveryAction);
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

  addGlobalOptions(
    program
      .command("explain")
      .description("Pre-flight context footprint and token cost inspection for workflow modes")
      .option("--mode <name>", "Major mode (coder, planner, auditor, browser)", "coder")
      .option("--domains <list>", "Comma-separated domain modules (git, k8s, database, browser)")
      .option("--model <id>", "Target model identifier (e.g. grok/grok-4.6, claude/fable)")
  ).action(async function explainAction(this: Command, options: { mode?: string; domains?: string; model?: string }) {
    result.code = await cmdExplain(runtimeFrom(ctx, this), options);
  });

  const sshCmd = addGlobalOptions(program.command("ssh").description("Multiplexed remote SSH execution and worker orchestration"));
  sshCmd.helpCommand("help", "Show ssh help");
  addGlobalOptions(sshCmd.command("info [host]").description("Discover SSH host aliases and parameters safely without opening sockets"))
    .action(async function sshInfoAction(this: Command, host?: string) {
      result.code = await cmdSshInfo(runtimeFrom(ctx, this), host);
    });
  addGlobalOptions(sshCmd.command("run <host> <command...>").description("Execute a command on a remote SSH host via multiplexed ControlMaster socket"))
    .option("--sudo", "Execute remote command with sudo privileges")
    .action(async function sshRunAction(this: Command, host: string, commandParts: string[], options: { sudo?: boolean }) {
      result.code = await cmdSshRun(runtimeFrom(ctx, this), host, commandParts, options);
    });
  addGlobalOptions(sshCmd.command("file <host> <path>").description("Read or write remote files over SSH"))
    .option("--content <text>", "Content to write to remote file")
    .option("--read", "Read remote file content")
    .option("--append", "Append content to remote file")
    .option("--sudo", "Use sudo privileges on remote file")
    .action(async function sshFileAction(this: Command, host: string, filePath: string, options: { content?: string; read?: boolean; append?: boolean; sudo?: boolean }) {
      result.code = await cmdSshFile(runtimeFrom(ctx, this), host, filePath, options);
    });
  addGlobalOptions(sshCmd.command("close <host>").description("Close active ControlMaster socket for an SSH host"))
    .action(async function sshCloseAction(this: Command, host: string) {
      result.code = await cmdSshClose(runtimeFrom(ctx, this), host);
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

  const completionCmd = addGlobalOptions(program.command("completion [shell]").description("Generate shell completion script, or install it into the current shell")).action(async function completionAction(this: Command, shell?: string) {
    if (shell && shell !== "install") {
      result.code = await cmdCompletion(runtimeFrom(ctx, this), shell);
      return;
    }
    if (shell === "install") {
      result.code = await cmdCompletionInstall(runtimeFrom(ctx, this), this.opts<{ shell?: string; path?: boolean }>());
      return;
    }
    ctx.io.stderr("usage: kxm completion <bash|zsh|fish> | kxm completion install [--shell <shell>] [--no-path]\n");
    result.code = 2;
  });
  completionCmd.helpCommand("help", "Show completion help");
  addGlobalOptions(completionCmd.command("install").description("Install tab completion for the detected or given shell and ensure kxm is on PATH"))
    .option("--shell <shell>", "Shell to install for (bash, zsh, fish; default: detect from $SHELL)")
    .option("--no-path", "Only install completion; do not add a PATH entry")
    .action(async function completionInstallAction(this: Command, options: { shell?: string; path?: boolean }) {
      result.code = await cmdCompletionInstall(runtimeFrom(ctx, this), options);
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

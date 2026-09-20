import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createBackup, restoreBackup } from "../database.ts";
import { refreshModelInventory } from "../model-inventory.ts";
import { listInventoryModels, listRoleBindings, loadRoutePolicy, setRouteState, updateRouteState } from "../routes.ts";
import {
  KxmConfigError,
  discoverKxmProjectRoot,
  type KxmInitializationPlan,
} from "../project-config.ts";
import { initializeKxmProject } from "../init.ts";
import { diffKxmProjectAgainstRevision, formatKxmPermissionDiff } from "../permission.ts";
import { readKxmLocalBindings, kxmUserStateRoot } from "../bindings.ts";
import { loadKxmProject } from "../project-config.ts";
import {
  ensureKxmSupervisor,
  kxmRuntimeRequest,
  kxmSupervisorStatus,
} from "../runtime-supervisor.ts";
import { kxmRuntimePaths } from "../runtime-store.ts";
import {
  formatHarnessInventory,
  probeHarnessesAsync,
} from "../harness.ts";
import {
  fetchLatestKxmVersion,
  kxmReleaseAssetName,
  noticeFromVersions,
  planKxmPackageUpdate,
  readInstalledKxmVersion,
  verifyReleaseAssetDigest,
  writeUpdateCache,
  type KxmPackageUpdateStep,
  type KxmUpdateConfig,
  type KxmUpdateNotice,
} from "../kxm-update.ts";
import { loadKxmUpdateConfig } from "../kxm-update-config.ts";
import type { InstallKindReport, InstallProbe } from "../kxm-install-kind.ts";
import { print, type CliIo, type CliSpawnResult, type Runtime } from "./types.ts";

export const kxmDriveCliSeams: {
  ensureSupervisor?: typeof ensureKxmSupervisor;
  runtimeRequest?: typeof kxmRuntimeRequest;
} = {};

export function initPlanPayload(plan: KxmInitializationPlan): Record<string, unknown> {
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

export function explicitRepositoryBindings(values: readonly string[]): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const value of values) {
    const separator = value.indexOf("=");
    const repositoryId = separator < 0 ? "" : value.slice(0, separator).trim();
    const path = separator < 0 ? "" : value.slice(separator + 1).trim();
    if (!repositoryId || !path) {
      throw new KxmConfigError([{
        phase: "discovery",
        code: "repository_binding_argument_invalid",
        file: "--repository",
        message: "repository bindings must use <id=absolute-path>",
      }]);
    }
    if (Object.hasOwn(result, repositoryId)) {
      throw new KxmConfigError([{
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

export async function cmdKxmInit(
  runtime: Runtime,
  options: { name?: string | undefined; projectId?: string | undefined; repository?: string[] | undefined },
  postHooks?: {
    maybeOfferCompletionInstall?: (runtime: Runtime) => Promise<void>;
    maybeOfferGuideSetup?: (runtime: Runtime) => Promise<void>;
  },
): Promise<number> {
  if (runtime.workspaceFlag !== undefined) {
    print(runtime.io, runtime.json, {
      ok: false,
      command: "init",
      error: "workspace_option_unsupported",
    }, "kxm init discovers the authoritative Git root from the current directory; --workspace is not supported");
    return 2;
  }
  try {
    const initialized = initializeKxmProject(runtime.cwd, {
      ...(options.name?.trim() ? { projectName: options.name.trim() } : {}),
      ...(options.projectId?.trim() ? { projectId: options.projectId.trim() } : {}),
      repositoryBindings: explicitRepositoryBindings(options.repository ?? []),
      localStateRoot: kxmUserStateRoot({ env: runtime.env }),
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
      if (postHooks?.maybeOfferCompletionInstall) await postHooks.maybeOfferCompletionInstall(runtime);
      if (postHooks?.maybeOfferGuideSetup) await postHooks.maybeOfferGuideSetup(runtime);
      return finishInit(0, `initialized KXM project at ${initialized.projectRoot ?? runtime.cwd}`);
    }
    if (initialized.action === "joined") {
      if (postHooks?.maybeOfferCompletionInstall) await postHooks.maybeOfferCompletionInstall(runtime);
      if (postHooks?.maybeOfferGuideSetup) await postHooks.maybeOfferGuideSetup(runtime);
      return finishInit(0, `joined KXM project at ${initialized.projectRoot ?? runtime.cwd}`);
    }
    if (initialized.action === "repaired") {
      return finishInit(0, `repaired KXM project at ${initialized.projectRoot ?? runtime.cwd}`);
    }
    if (initialized.action === "resumed") {
      return finishInit(0, `resumed KXM ${initialized.transactionKind ?? "initialization"} at ${initialized.projectRoot ?? runtime.cwd}`);
    }
    if (initialized.action === "validated") {
      return finishInit(0, `validated KXM project at ${initialized.projectRoot ?? runtime.cwd}`);
    }
    if (runtime.dryRun) {
      return finishInit(0, `init plan: ${initialized.plan.mode}`);
    }
    const next = initialized.plan.mode === "legacy"
      ? "legacy state is not migrated by this build: initialise a fresh project directory and copy the YAML definitions you want to keep"
      : initialized.repairPlan?.issues.length
        ? "managed-template repair is blocked by conflicts or authority changes; local files were preserved"
        : "partial or provenance-free KXM state requires explicit repair; no files were overwritten";
    return finishInit(1, next);
  } catch (error) {
    if (error instanceof KxmConfigError) {
      print(runtime.io, runtime.json, {
        ok: false,
        command: "init",
        error: "initialization_failed",
        issues: error.issues,
      }, `KXM initialization failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, {
      ok: false,
      command: "init",
      error: "initialization_io_failed",
    }, "KXM initialization failed because a local filesystem operation did not complete");
    return 1;
  }
}

export async function cmdBackup(runtime: Runtime, options: { out?: string | undefined }): Promise<number> {
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
    if (error instanceof KxmConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "backup", error: "backup_failed", issues: error.issues }, `backup failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "backup", error: "backup_failed", message: error instanceof Error ? error.message : String(error) }, `backup failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function cmdRestore(runtime: Runtime, manifestArg: string): Promise<number> {
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
    if (error instanceof KxmConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "restore", error: "restore_failed", issues: error.issues }, `restore failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "restore", error: "restore_failed", message: error instanceof Error ? error.message : String(error) }, `restore failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function cmdKxmTrust(runtime: Runtime, check: boolean, options: { base?: string | undefined }): Promise<number> {
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
    const projectRoot = discoverKxmProjectRoot(runtime.cwd) ?? runtime.cwd;
    const bindings = readKxmLocalBindings(projectRoot, { stateRoot: kxmUserStateRoot({ env: runtime.env }) });
    const diff = diffKxmProjectAgainstRevision(projectRoot, options.base?.trim() || "HEAD", {
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
    const text = formatKxmPermissionDiff(diff);
    if (check && diff.requiresReview) {
      print(runtime.io, runtime.json, payload, `${text}\ntrust check failed: review every expansion above before merging`);
      return 1;
    }
    print(runtime.io, runtime.json, payload, text);
    return 0;
  } catch (error) {
    if (error instanceof KxmConfigError) {
      print(runtime.io, runtime.json, { ok: false, command, error: "trust_diff_failed", issues: error.issues }, `permission diff failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command, error: "trust_diff_io_failed" }, "permission diff failed because a local filesystem or Git operation did not complete");
    return 1;
  }
}

export const RUN_ENGINE_PHASE = "pre-3a";
export const RUN_ENGINE_NOTICE = "runs remain created until the run engine lands; no steps execute yet";

export async function cmdKxmRun(runtime: Runtime, workflow: string | undefined, promptParts: string[]): Promise<number> {
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
    const projectRoot = discoverKxmProjectRoot(runtime.cwd);
    if (!projectRoot) {
      print(runtime.io, runtime.json, { ok: false, command: "run", error: "project_required" }, "kxm run requires a KXM project (run kxm init first)");
      return 1;
    }
    const bundle = loadKxmProject(projectRoot, {});
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
    const supervisor = await ensureKxmSupervisor({ env: runtime.env });
    const prompt = promptParts.join(" ").trim();
    const acceptance = await kxmRuntimeRequest(supervisor, "POST", "/v1/runs", {
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
    if (error instanceof KxmConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "run", error: "run_failed", issues: error.issues }, `run failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "run", error: "run_io_failed" }, "run failed because a local operation did not complete");
    return 1;
  }
}

interface KxmStatusDrive {
  driveId?: string;
  mode?: string;
  openedAt?: string;
  receipt?: {
    settlement?: { kind?: string; status?: string; reason?: string };
  } | null;
  verified?: boolean;
  divergence?: string;
}

function formatCancelledStatus(reason: string): string {
  return reason.length > 0 ? `cancelled (${reason})` : "cancelled";
}

function formatDriveStatusLine(runStatus: string, drive: KxmStatusDrive | undefined): string | undefined {
  if (!drive || typeof drive.driveId !== "string" || drive.driveId.length === 0) return undefined;
  const receipt = drive.receipt ?? null;
  if (receipt === null) {
    if (runStatus === "running" || runStatus === "blocked_uncertain") {
      return `drive ${drive.driveId}: open`;
    }
    return `drive ${drive.driveId}: no receipt (orphaned)`;
  }
  const kind = receipt.settlement?.kind;
  const reason = typeof receipt.settlement?.reason === "string" ? receipt.settlement.reason : "";
  if (kind === "unsettled") {
    return `drive ${drive.driveId}: unsettled ${reason}`.trimEnd();
  }
  if (kind === "handoff") {
    return drive.verified === true
      ? `drive ${drive.driveId}: handoff (receipt verified)`
      : `drive ${drive.driveId}: handoff`;
  }
  if (receipt.settlement?.status === "cancelled") {
    const label = formatCancelledStatus(reason);
    return drive.verified === true
      ? `drive ${drive.driveId}: ${label} (receipt verified)`
      : `drive ${drive.driveId}: ${label}`;
  }
  if (drive.verified === true) {
    return `drive ${drive.driveId}: completed (receipt verified)`;
  }
  return `drive ${drive.driveId}: completed`;
}

function formatRunStatusLine(
  run: { runId: string; status: string; workflowId: string; updatedAt: string },
  drive: KxmStatusDrive | undefined,
): string {
  const reason = typeof drive?.receipt?.settlement?.reason === "string" ? drive.receipt.settlement.reason : "";
  const statusLabel = run.status === "cancelled" ? formatCancelledStatus(reason) : run.status;
  return `run ${run.runId}: ${statusLabel} (workflow ${run.workflowId}, updated ${run.updatedAt})`;
}

export async function cmdKxmRunStatus(runtime: Runtime, runId: string): Promise<number> {
  try {
    const projectRoot = discoverKxmProjectRoot(runtime.cwd);
    if (!projectRoot) {
      print(runtime.io, runtime.json, { ok: false, command: "runs status", error: "project_required" }, "kxm runs status requires a KXM project (run kxm init first)");
      return 1;
    }
    const supervisor = await (kxmDriveCliSeams.ensureSupervisor ?? ensureKxmSupervisor)({ env: runtime.env });
    const result = await (kxmDriveCliSeams.runtimeRequest ?? kxmRuntimeRequest)(supervisor, "GET", `/v1/runs/${encodeURIComponent(runId)}?projectRoot=${encodeURIComponent(projectRoot)}`);
    const run = result.run as { runId: string; status: string; workflowId: string; configRevision: string; updatedAt: string };
    const drive = result.drive as KxmStatusDrive | undefined;
    const driveLine = formatDriveStatusLine(run.status, drive);
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "runs status", run, ...(drive !== undefined ? { drive } : {}) },
      `${formatRunStatusLine(run, drive)}${driveLine ? `\n${driveLine}` : ""}`,
    );
    return 0;
  } catch (error) {
    if (error instanceof KxmConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "runs status", error: "run_status_failed", issues: error.issues }, `run status failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "runs status", error: "run_status_io_failed" }, "run status failed because a local operation did not complete");
    return 1;
  }
}

const DEFAULT_DRIVE_WAIT_MS = 60_000;
const MAX_DRIVE_WAIT_MS = 600_000;

function parseDriveWaitTimeoutMs(raw: number | string | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_DRIVE_WAIT_MS;
  const value = typeof raw === "number" ? raw : Number(typeof raw === "string" ? raw.trim() : raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_DRIVE_WAIT_MS) return undefined;
  return value;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function driveWaitCompleted(drive: KxmStatusDrive | undefined): boolean {
  return drive?.verified === true
    && drive.receipt?.settlement?.kind === "terminal"
    && drive.receipt.settlement.status === "completed";
}

export async function cmdKxmRunDrive(
  runtime: Runtime,
  runId: string,
  simulated: boolean,
  options: { wait?: boolean; timeoutMs?: number | string } = {},
): Promise<number> {
  try {
    const projectRoot = discoverKxmProjectRoot(runtime.cwd);
    if (!projectRoot) {
      print(runtime.io, runtime.json, { ok: false, command: "runs drive", error: "project_required" }, "kxm runs drive requires a KXM project (run kxm init first)");
      return 1;
    }
    const mode = simulated ? "simulated" : "live";
    if (runtime.dryRun) {
      print(runtime.io, runtime.json, { ok: true, command: "runs drive", dryRun: true, runId, mode }, `drive plan: run ${runId} in ${mode} mode (no events written)`);
      return 0;
    }
    const timeoutMs = options.wait === true ? parseDriveWaitTimeoutMs(options.timeoutMs) : DEFAULT_DRIVE_WAIT_MS;
    if (options.wait === true && timeoutMs === undefined) {
      print(
        runtime.io,
        runtime.json,
        { ok: false, command: "runs drive", error: "run_drive_timeout_invalid" },
        `run drive --wait --timeout-ms must be an integer between 1 and ${MAX_DRIVE_WAIT_MS}`,
      );
      return 1;
    }
    const supervisor = await (kxmDriveCliSeams.ensureSupervisor ?? ensureKxmSupervisor)({ env: runtime.env });
    const request = kxmDriveCliSeams.runtimeRequest ?? kxmRuntimeRequest;
    const result = await request(supervisor, "POST", `/v1/runs/${encodeURIComponent(runId)}/drive?projectRoot=${encodeURIComponent(projectRoot)}`, { mode });
    const driveId = result.driveId;
    const poll = result.poll;
    const status = result.status;
    if (typeof driveId !== "string" || driveId.length === 0 || typeof poll !== "string" || poll.length === 0 || status !== "accepted") {
      print(runtime.io, runtime.json, { ok: false, command: "runs drive", error: "run_drive_io_failed" }, "run drive failed because a local operation did not complete");
      return 1;
    }

    if (options.wait !== true) {
      print(
        runtime.io,
        runtime.json,
        { ok: true, command: "runs drive", runId, driveId, poll, mode, status },
        `drive ${driveId}: accepted (poll ${poll})`,
      );
      return 0;
    }

    const deadline = Date.now() + timeoutMs!;
    let interval = 25;
    while (true) {
      const stateResult = await request(supervisor, "GET", `/v1/runs/${encodeURIComponent(runId)}?projectRoot=${encodeURIComponent(projectRoot)}`);
      const drive = stateResult.drive as KxmStatusDrive | undefined;
      if (drive?.receipt) {
        print(
          runtime.io,
          runtime.json,
          { ok: driveWaitCompleted(drive), command: "runs drive", receipt: drive.receipt, verified: drive.verified === true },
          JSON.stringify(drive.receipt, null, 2),
        );
        return driveWaitCompleted(drive) ? 0 : 1;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleepMs(Math.min(interval, remaining));
      interval = Math.min(Math.floor(interval * 1.5), 250);
    }

    print(runtime.io, runtime.json, { ok: false, command: "runs drive", error: "timeout" }, "drive wait timed out");
    return 1;
  } catch (error) {
    if (error instanceof KxmConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "runs drive", error: "run_drive_failed", issues: error.issues }, `run drive failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "runs drive", error: "run_drive_io_failed" }, "run drive failed because a local operation did not complete");
    return 1;
  }
}

export async function cmdKxmRunCancel(runtime: Runtime, runId: string): Promise<number> {
  try {
    const projectRoot = discoverKxmProjectRoot(runtime.cwd);
    if (!projectRoot) {
      print(runtime.io, runtime.json, { ok: false, command: "runs cancel", error: "project_required" }, "kxm runs cancel requires a KXM project (run kxm init first)");
      return 1;
    }
    if (runtime.dryRun) {
      print(runtime.io, runtime.json, { ok: true, command: "runs cancel", dryRun: true, runId }, `cancel plan: run ${runId} (no events written)`);
      return 0;
    }
    const supervisor = await ensureKxmSupervisor({ env: runtime.env });
    const result = await kxmRuntimeRequest(supervisor, "POST", `/v1/runs/${encodeURIComponent(runId)}/cancel?projectRoot=${encodeURIComponent(projectRoot)}`, {});
    const run = result.run as { runId: string; status: string };
    print(runtime.io, runtime.json, {
      ok: true,
      command: "runs cancel",
      idempotent: result.idempotent === true,
      run,
    }, `run ${run.runId}: ${run.status}`);
    return 0;
  } catch (error) {
    if (error instanceof KxmConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "runs cancel", error: "run_cancel_failed", issues: error.issues }, `run cancel failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "runs cancel", error: "run_cancel_io_failed" }, "run cancel failed because a local operation did not complete");
    return 1;
  }
}

export async function cmdKxmRunList(runtime: Runtime): Promise<number> {
  try {
    const projectRoot = discoverKxmProjectRoot(runtime.cwd);
    if (!projectRoot) {
      print(runtime.io, runtime.json, { ok: false, command: "runs list", error: "project_required" }, "kxm runs list requires a KXM project (run kxm init first)");
      return 1;
    }
    const bundle = loadKxmProject(projectRoot, {});
    const projectId = String(bundle.project.value.id);
    const supervisor = await ensureKxmSupervisor({ env: runtime.env });
    const result = await kxmRuntimeRequest(supervisor, "GET", `/v1/projects/${encodeURIComponent(projectId)}/runs?projectRoot=${encodeURIComponent(projectRoot)}`);
    const runs = (result.runs ?? []) as Array<{ runId: string; status: string; workflowId: string; createdAt: string }>;
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "runs list", runs },
      runs.length === 0 ? "no runs" : runs.map((run) => `${run.runId}  ${run.status}  ${run.workflowId}  ${run.createdAt}`).join("\n"),
    );
    return 0;
  } catch (error) {
    if (error instanceof KxmConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "runs list", error: "run_list_failed", issues: error.issues }, `run list failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "runs list", error: "run_list_io_failed" }, "run list failed because a local operation did not complete");
    return 1;
  }
}

export async function cmdHarnessList(runtime: Runtime): Promise<number> {
  const inventory = await probeHarnessesAsync({ env: runtime.env });
  print(runtime.io, runtime.json, { ok: true, command: "harness list", ...inventory }, formatHarnessInventory(inventory));
  return 0;
}

export async function selectInventoryModel(runtime: Runtime, requested?: string | undefined): Promise<string | undefined> {
  const models = listInventoryModels(runtime.dirs.workdir);
  if (requested) return models.find((model) => model.toLowerCase() === requested.toLowerCase());
  if (runtime.json || !process.stdin.isTTY || models.length === 0) return undefined;
  runtime.io.stdout(models.slice(0, 100).map((model, index) => `${index + 1}. ${model}`).join("\n") + "\nSelect model number: ");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => rl.once("line", resolve));
  rl.close();
  const index = Number.parseInt(answer.trim(), 10) - 1;
  return Number.isInteger(index) && index >= 0 && index < models.length ? models[index] : undefined;
}

export async function cmdRouteChange(runtime: Runtime, status: "admitted" | "disabled", requested?: string | undefined): Promise<number> {
  const model = await selectInventoryModel(runtime, requested);
  if (!model) { print(runtime.io, runtime.json, { ok: false, command: `routes ${status}`, error: "model_selection_required" }, "select a model from the refreshed inventory"); return 2; }
  if (runtime.dryRun) { print(runtime.io, runtime.json, { ok: true, command: `routes ${status}`, model, dryRun: true }, `would ${status === "admitted" ? "admit" : "disable"} ${model}`); return 0; }
  const policy = updateRouteState(runtime.dirs.workdir, model, status);
  print(runtime.io, runtime.json, { ok: true, command: `routes ${status}`, model, policy }, `${status} ${model}`);
  return 0;
}

export async function cmdModelsScreen(runtime: Runtime): Promise<number> {
  const models = listInventoryModels(runtime.dirs.workdir);
  if (runtime.json || !process.stdin.isTTY) { print(runtime.io, runtime.json, { ok: false, command: "models", error: "interactive_tty_required" }, "kxm models requires an interactive terminal"); return 2; }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));
  try {
    while (true) {
      const policy = loadRoutePolicy(runtime.dirs.workdir);
      const roleBindings = listRoleBindings(runtime.dirs.workdir);
      runtime.io.stdout(models.map((m, i) => `${i + 1}. ${m} [${policy.admitted.includes(m) ? "admitted" : policy.disabled.includes(m) ? "disabled" : "unset"}] roles:${Object.entries(roleBindings).filter(([, xs]) => xs.includes(m)).map(([r]) => r).join(",") || "-"}`).join("\n") + "\n");
      const command = (await ask("[a]dmit [d]isable [r]ole-add [x]ole-remove [q]uit: ")).trim().toLowerCase();
      if (command === "q" || command === "quit") return 0;
      const index = Number.parseInt((await ask("model number: ")).trim(), 10) - 1;
      if (!Number.isInteger(index) || !models[index]) continue;
      const model = models[index];
      if (command === "a" || command === "d") setRouteState(runtime.dirs.workdir, model, command === "a" ? "admitted" : "disabled");
      else if (command === "r" || command === "x") setRouteState(runtime.dirs.workdir, model, "admitted", (await ask("role: ")).trim(), command === "x");
    }
  } finally { rl.close(); }
}

export async function cmdRouteList(runtime: Runtime): Promise<number> {
  const policy = loadRoutePolicy(runtime.dirs.workdir);
  print(runtime.io, runtime.json, { ok: true, command: "routes list", policy }, [...policy.admitted.map((x) => `admitted ${x}`), ...policy.disabled.map((x) => `disabled ${x}`)].join("\n") || "no route decisions");
  return 0;
}

export async function cmdRouteCount(runtime: Runtime): Promise<number> {
  const policy = loadRoutePolicy(runtime.dirs.workdir);
  const summary = `${policy.admitted.length} admitted / ${policy.disabled.length} disabled`;
  print(runtime.io, runtime.json, { ok: true, command: "routes count", admitted: policy.admitted.length, disabled: policy.disabled.length, summary }, summary);
  return 0;
}

export async function cmdModelInventoryRefresh(runtime: Runtime): Promise<number> {
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: "models inventory refresh", dryRun: true }, "would refresh .kxm/models/inventory.yaml");
    return 0;
  }
  const inventory = await refreshModelInventory({ outputRoot: runtime.dirs.workdir, env: runtime.env });
  const failed = Object.values(inventory.sources).some((source) => !source.ok);
  print(runtime.io, runtime.json, { ok: !failed, command: "models inventory refresh", output: ".kxm/models/inventory.yaml", ...inventory }, `wrote ${inventory.models.length} models to .kxm/models/inventory.yaml`);
  return failed ? 1 : 0;
}

export async function cmdKxmRuntime(runtime: Runtime, action: string): Promise<number> {
  const paths = kxmRuntimePaths({ env: runtime.env });
  try {
    if (action === "start") {
      if (runtime.dryRun) {
        print(runtime.io, runtime.json, { ok: true, command: "runtime start", dryRun: true }, "runtime supervisor would auto-start");
        return 0;
      }
      const supervisor = await ensureKxmSupervisor({ env: runtime.env });
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
      const status = kxmSupervisorStatus(paths);
      print(runtime.io, runtime.json, { ok: true, command: "runtime status", ...status }, status.running
        ? `runtime supervisor running: ${status.runtimeId} pid ${status.pid} on 127.0.0.1:${status.port}`
        : "runtime supervisor is not running");
      return status.running ? 0 : 1;
    }
    if (action === "stop") {
      const status = kxmSupervisorStatus(paths);
      if (!status.running || !status.port) {
        print(runtime.io, runtime.json, { ok: true, command: "runtime stop", stopped: false }, "runtime supervisor is not running");
        return 0;
      }
      if (runtime.dryRun) {
        print(runtime.io, runtime.json, { ok: true, command: "runtime stop", dryRun: true }, `would stop runtime supervisor pid ${status.pid}`);
        return 0;
      }
      const supervisor = await ensureKxmSupervisor({ env: runtime.env });
      await kxmRuntimeRequest(supervisor, "POST", "/v1/shutdown", {});
      print(runtime.io, runtime.json, { ok: true, command: "runtime stop", stopped: true }, `runtime supervisor ${status.runtimeId} stopping`);
      return 0;
    }
    print(runtime.io, runtime.json, { ok: false, command: "runtime", error: "unknown_action" }, `unknown runtime action: ${action}`);
    return 2;
  } catch (error) {
    if (error instanceof KxmConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "runtime", error: "runtime_failed", issues: error.issues }, `runtime failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "runtime", error: "runtime_io_failed" }, "runtime failed because a local operation did not complete");
    return 1;
  }
}

export async function cmdKxmRunReceipt(runtime: Runtime, runId: string, options: { all?: boolean } = {}): Promise<number> {
  try {
    const projectRoot = discoverKxmProjectRoot(runtime.cwd);
    if (!projectRoot) {
      print(runtime.io, runtime.json, { ok: false, command: "runs receipt", error: "project_required" }, "kxm runs receipt requires a KXM project (run kxm init first)");
      return 1;
    }
    const supervisor = await (kxmDriveCliSeams.ensureSupervisor ?? ensureKxmSupervisor)({ env: runtime.env });
    const result = await (kxmDriveCliSeams.runtimeRequest ?? kxmRuntimeRequest)(
      supervisor,
      "GET",
      `/v1/runs/${encodeURIComponent(runId)}/drive?projectRoot=${encodeURIComponent(projectRoot)}`,
    );
    if (!Array.isArray(result.receipts)) {
      print(runtime.io, runtime.json, { ok: false, command: "runs receipt", error: "run_receipt_io_failed" }, "run receipt failed because a local operation did not complete");
      return 1;
    }
    const receipts = result.receipts as unknown[];
    if (receipts.length === 0) {
      print(runtime.io, runtime.json, { ok: false, command: "runs receipt", error: "no_receipts" }, `run ${runId} has no drive receipts`);
      return 1;
    }
    if (options.all === true) {
      print(runtime.io, runtime.json, { ok: true, command: "runs receipt", receipts }, JSON.stringify(receipts, null, 2));
      return 0;
    }
    const latest = receipts[0];
    const settlement = latest && typeof latest === "object" && "settlement" in latest
      ? (latest as { settlement: unknown }).settlement
      : latest;
    print(runtime.io, runtime.json, { ok: true, command: "runs receipt", receipt: latest }, JSON.stringify(settlement, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof KxmConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "runs receipt", error: "run_receipt_failed", issues: error.issues }, `run receipt failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "runs receipt", error: "run_receipt_io_failed" }, "run receipt failed because a local operation did not complete");
    return 1;
  }
}

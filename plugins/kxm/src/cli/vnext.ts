import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createBackup, restoreBackup } from "../database.ts";
import { refreshModelInventory } from "../model-inventory.ts";
import { listInventoryModels, listRoleBindings, loadProducerPolicy, setModelState, updateProducer } from "../producers.ts";
import {
  VnextConfigError,
  discoverVnextProjectRoot,
  type VnextInitializationPlan,
} from "../vnext-config.ts";
import { initializeVnextProject } from "../vnext-init.ts";
import { applyVnextMigration, planVnextMigration, verifyVnextMigration } from "../vnext-migrate.ts";
import { diffVnextProjectAgainstRevision, formatVnextPermissionDiff } from "../vnext-permission.ts";
import { readVnextLocalBindings, vnextUserStateRoot } from "../vnext-bindings.ts";
import { loadVnextProject } from "../vnext-config.ts";
import {
  ensureVnextSupervisor,
  vnextRuntimeRequest,
  vnextSupervisorStatus,
} from "../vnext-runtime-supervisor.ts";
import { vnextRuntimePaths } from "../vnext-runtime-store.ts";
import {
  formatHarnessInventory,
  probeHarnessesAsync,
} from "../vnext-harness.ts";
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

const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

export function initPlanPayload(plan: VnextInitializationPlan): Record<string, unknown> {
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

export async function cmdVnextInit(
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
      if (postHooks?.maybeOfferCompletionInstall) await postHooks.maybeOfferCompletionInstall(runtime);
      if (postHooks?.maybeOfferGuideSetup) await postHooks.maybeOfferGuideSetup(runtime);
      return finishInit(0, `initialized vNext project at ${initialized.projectRoot ?? runtime.cwd}`);
    }
    if (initialized.action === "joined") {
      if (postHooks?.maybeOfferCompletionInstall) await postHooks.maybeOfferCompletionInstall(runtime);
      if (postHooks?.maybeOfferGuideSetup) await postHooks.maybeOfferGuideSetup(runtime);
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

export async function cmdVnextMigratePlan(runtime: Runtime): Promise<number> {
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

export async function cmdVnextMigrateApply(runtime: Runtime, options: { decisions?: string | undefined; projectId?: string | undefined; name?: string | undefined }): Promise<number> {
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

export async function cmdVnextMigrateVerify(runtime: Runtime): Promise<number> {
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
    if (error instanceof VnextConfigError) {
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
    if (error instanceof VnextConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "restore", error: "restore_failed", issues: error.issues }, `restore failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "restore", error: "restore_failed", message: error instanceof Error ? error.message : String(error) }, `restore failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function cmdVnextTrust(runtime: Runtime, check: boolean, options: { base?: string | undefined }): Promise<number> {
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

export const RUN_ENGINE_PHASE = "pre-3a";
export const RUN_ENGINE_NOTICE = "runs remain created until the run engine lands; no steps execute yet";

export async function cmdVnextRun(runtime: Runtime, workflow: string | undefined, promptParts: string[]): Promise<number> {
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

export async function cmdVnextRunStatus(runtime: Runtime, runId: string): Promise<number> {
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

export async function cmdVnextRunDrive(runtime: Runtime, runId: string, simulated: boolean): Promise<number> {
  try {
    const projectRoot = discoverVnextProjectRoot(runtime.cwd);
    if (!projectRoot) {
      print(runtime.io, runtime.json, { ok: false, command: "runs drive", error: "project_required" }, "kxm runs drive requires a vNext project (run kxm init first)");
      return 1;
    }
    const mode = simulated ? "simulated" : "live";
    if (runtime.dryRun) {
      print(runtime.io, runtime.json, { ok: true, command: "runs drive", dryRun: true, runId, mode }, `drive plan: run ${runId} in ${mode} mode (no events written)`);
      return 0;
    }
    const supervisor = await ensureVnextSupervisor({ env: runtime.env });
    const result = await vnextRuntimeRequest(supervisor, "POST", `/v1/runs/${encodeURIComponent(runId)}/drive?projectRoot=${encodeURIComponent(projectRoot)}`, { mode });
    const driveId = typeof result.driveId === "string" ? result.driveId : "";
    const poll = typeof result.poll === "string" ? result.poll : `/v1/runs/${runId}`;
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "runs drive", runId, driveId, poll, mode, status: result.status },
      `drive ${driveId || runId}: accepted (poll ${poll})`,
    );
    return 0;
  } catch (error) {
    if (error instanceof VnextConfigError) {
      print(runtime.io, runtime.json, { ok: false, command: "runs drive", error: "run_drive_failed", issues: error.issues }, `run drive failed: ${error.message}`);
      return 1;
    }
    print(runtime.io, runtime.json, { ok: false, command: "runs drive", error: "run_drive_io_failed" }, "run drive failed because a local operation did not complete");
    return 1;
  }
}

export async function cmdVnextRunCancel(runtime: Runtime, runId: string): Promise<number> {
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

export async function cmdVnextRunList(runtime: Runtime): Promise<number> {
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

export async function cmdHarnessList(runtime: Runtime): Promise<number> {
  const inventory = await probeHarnessesAsync({ env: runtime.env });
  print(runtime.io, runtime.json, { ok: true, command: "harness list", ...inventory }, formatHarnessInventory(inventory));
  return 0;
}

export async function selectProducerModel(runtime: Runtime, requested?: string | undefined): Promise<string | undefined> {
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

export async function cmdProducerChange(runtime: Runtime, status: "promoted" | "demoted", requested?: string | undefined): Promise<number> {
  const model = await selectProducerModel(runtime, requested);
  if (!model) { print(runtime.io, runtime.json, { ok: false, command: `producers ${status}`, error: "model_selection_required" }, "select a model from the refreshed inventory"); return 2; }
  if (runtime.dryRun) { print(runtime.io, runtime.json, { ok: true, command: `producers ${status}`, model, dryRun: true }, `would ${status} ${model}`); return 0; }
  const policy = updateProducer(runtime.dirs.workdir, model, status);
  print(runtime.io, runtime.json, { ok: true, command: `producers ${status}`, model, policy }, `${status} ${model}`);
  return 0;
}

export async function cmdModelsScreen(runtime: Runtime): Promise<number> {
  const models = listInventoryModels(runtime.dirs.workdir);
  if (runtime.json || !process.stdin.isTTY) { print(runtime.io, runtime.json, { ok: false, command: "models", error: "interactive_tty_required" }, "kxm models requires an interactive terminal"); return 2; }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));
  try {
    while (true) {
      const policy = loadProducerPolicy(runtime.dirs.workdir);
      const roleBindings = listRoleBindings(runtime.dirs.workdir);
      runtime.io.stdout(models.map((m, i) => `${i + 1}. ${m} [${policy.enabled.includes(m) ? "enabled" : policy.disabled.includes(m) ? "disabled" : "unset"}] [${policy.promoted.includes(m) ? "producer" : policy.demoted.includes(m) ? "demoted" : "not producer"}] roles:${Object.entries(roleBindings).filter(([, xs]) => xs.includes(m)).map(([r]) => r).join(",") || "-"}`).join("\n") + "\n");
      const command = (await ask("[e]nable [d]isable [p]romote [x]demote [a]dd-role [r]emove-role [q]uit: ")).trim().toLowerCase();
      if (command === "q" || command === "quit") return 0;
      const index = Number.parseInt((await ask("model number: ")).trim(), 10) - 1;
      if (!Number.isInteger(index) || !models[index]) continue;
      const model = models[index];
      if (command === "p" || command === "x") updateProducer(runtime.dirs.workdir, model, command === "p" ? "promoted" : "demoted");
      else if (command === "e" || command === "d") setModelState(runtime.dirs.workdir, model, command === "e" ? "enabled" : "disabled");
      else if (command === "a" || command === "r") setModelState(runtime.dirs.workdir, model, "enabled", (await ask("role: ")).trim(), command === "r");
    }
  } finally { rl.close(); }
}

export async function cmdProducerList(runtime: Runtime): Promise<number> {
  const policy = loadProducerPolicy(runtime.dirs.workdir);
  print(runtime.io, runtime.json, { ok: true, command: "producers list", policy }, [...policy.promoted.map((x) => `promoted ${x}`), ...policy.demoted.map((x) => `demoted ${x}`)].join("\n") || "no producer decisions");
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

export async function cmdVnextRuntime(runtime: Runtime, action: string): Promise<number> {
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

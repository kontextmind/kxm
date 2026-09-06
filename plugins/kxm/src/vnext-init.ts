import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  VnextConfigError,
  discoverGitRoot,
  loadVnextProject,
  assertNoRegisteredGates,
  planVnextInitialization,
  type JsonObject,
  type VnextConfigIssue,
  type VnextConfigOptions,
  type VnextInitializationPlan,
} from "./vnext-config.ts";
import {
  planVnextLocalBindings,
  readVnextLocalBindings,
  withVnextLocalBindingLock,
  writeVnextLocalBindings,
  type VnextLocalBindingLock,
  type VnextLocalBindingStoreOptions,
} from "./vnext-bindings.ts";
import {
  commitVnextInitTransaction,
  hasVnextInitTransaction,
  inspectVnextInitTransaction,
  planVnextTemplateRepair,
  prepareAndApplyVnextCreate,
  prepareAndApplyVnextRepair,
  resumeVnextInitTransaction,
  type VnextRepairRuntimeOptions,
  type VnextTemplateRepairPlan,
} from "./vnext-repair.ts";
import {
  CURRENT_VNEXT_TEMPLATE_VARIANT,
  renderVnextTemplate,
  type VnextTemplateVariant,
} from "./vnext-template.ts";

export interface VnextInitOptions extends VnextConfigOptions {
  projectId?: string;
  projectName?: string;
  dryRun?: boolean;
  localStateRoot?: string;
  /** Test/future-template injection; the CLI always uses the current built-in variant. */
  templateVariant?: VnextTemplateVariant;
  /** Fault injection used by crash-recovery tests. */
  testFaultAt?: "prepared" | "first-resource" | "provenance" | "verified";
}

export interface VnextInitResult {
  action: "planned" | "created" | "joined" | "repaired" | "resumed" | "validated";
  plan: VnextInitializationPlan;
  projectRoot?: string;
  configRevision?: string;
  localBindingFile?: string;
  bindingsChanged?: boolean;
  repairPlan?: VnextTemplateRepairPlan;
  resumePending?: boolean;
  transactionKind?: "create" | "repair";
  files: readonly string[];
}

const PROJECT_ID = /^prj_[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;

function initIssue(code: string, file: string, message: string): VnextConfigIssue {
  return { phase: "discovery", code, file, message };
}

function normalizedProjectName(root: string, requested?: string): string {
  const name = (requested ?? basename(root) ?? "KXM Project").trim();
  if (name.length < 1 || name.length > 120 || /[\u0000\r\n]/.test(name)) {
    throw new VnextConfigError([initIssue("project_name_invalid", ".kxm/project.yaml", "project name must contain 1-120 characters on one line")]);
  }
  return name;
}

function generatedProjectId(requested?: string): string {
  const id = requested?.trim() || `prj_${randomUUID().replaceAll("-", "")}`;
  if (!PROJECT_ID.test(id) || id.length > 144) {
    throw new VnextConfigError([initIssue("project_id_invalid", ".kxm/project.yaml", "project ID must satisfy the kxm.project.v1 opaque ID grammar and use the prj_ prefix")]);
  }
  return id;
}

function configOptions(options: VnextInitOptions, repositoryBindings: Readonly<Record<string, string>>): VnextConfigOptions {
  assertNoRegisteredGates(options);
  return {
    ...(options.schemasDir === undefined ? {} : { schemasDir: options.schemasDir }),
    repositoryBindings,
    ...(options.registeredExecutors === undefined ? {} : { registeredExecutors: options.registeredExecutors }),
    ...(options.registeredToolPresets === undefined ? {} : { registeredToolPresets: options.registeredToolPresets }),
  };
}

function repairOptions(
  options: VnextInitOptions,
  repositoryBindings: Readonly<Record<string, string>>,
): VnextRepairRuntimeOptions {
  return {
    ...configOptions(options, repositoryBindings),
    templateVariant: options.templateVariant ?? CURRENT_VNEXT_TEMPLATE_VARIANT,
    ...(options.testFaultAt === undefined ? {} : { testFaultAt: options.testFaultAt }),
  };
}

function bindingStoreOptions(options: VnextInitOptions): VnextLocalBindingStoreOptions {
  return {
    ...(options.localStateRoot === undefined ? {} : { stateRoot: options.localStateRoot }),
    ...(options.schemasDir === undefined ? {} : { schemasDir: options.schemasDir }),
  };
}

function memberRepositoryIds(project: JsonObject): Set<string> {  const repositories = Array.isArray(project.repositories) ? project.repositories : [];
  return new Set(repositories.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const record = candidate as JsonObject;
    return record.role === "member" && typeof record.id === "string" ? [record.id] : [];
  }));
}

function completedPlan(projectRoot: string, options: VnextConfigOptions): VnextInitializationPlan {
  return planVnextInitialization(projectRoot, options);
}

function finalizeBindingUpdate(
  bundle: ReturnType<typeof loadVnextProject>,
  persisted: ReturnType<typeof readVnextLocalBindings>,
  allBindings: Readonly<Record<string, string>>,
  explicitBindings: Readonly<Record<string, string>>,
  storeOptions: VnextLocalBindingStoreOptions,
  mutationLock: VnextLocalBindingLock | undefined,
  dryRun: boolean,
): { localBindingFile?: string; bindingsChanged?: boolean } {
  const memberIds = validateBindingIdentities(bundle, persisted, explicitBindings);
  if (Object.keys(explicitBindings).length === 0) {
    return persisted ? { localBindingFile: persisted.file } : {};
  }
  const memberBindings = Object.fromEntries(Object.entries(allBindings)
    .filter(([repositoryId]) => memberIds.has(repositoryId)));
  const projectId = String(bundle.project.value.id);
  const bindingPlan = planVnextLocalBindings(bundle.projectRoot, projectId, memberBindings, storeOptions);
  if (dryRun) return { localBindingFile: bindingPlan.file, bindingsChanged: bindingPlan.written };
  if (bindingPlan.written && !mutationLock) throw new Error("project mutation lock is required to persist repository bindings");
  const result = bindingPlan.written
    ? writeVnextLocalBindings(bundle.projectRoot, projectId, memberBindings, storeOptions, mutationLock)
    : bindingPlan;
  return { localBindingFile: result.file, bindingsChanged: result.written };
}

function plannedRepairResult(
  plan: VnextInitializationPlan,
  projectRoot: string,
  repairPlan?: VnextTemplateRepairPlan,
): VnextInitResult {
  return {
    action: "planned",
    plan,
    projectRoot,
    ...(repairPlan === undefined ? {} : { repairPlan }),
    files: [],
  };
}

function validateBindingIdentities(
  bundle: ReturnType<typeof loadVnextProject>,
  persisted: ReturnType<typeof readVnextLocalBindings>,
  explicit: Readonly<Record<string, string>>,
): Set<string> {
  const projectId = String(bundle.project.value.id);
  if (persisted && persisted.projectId !== projectId) {
    throw new VnextConfigError([initIssue("local_binding_project_id_mismatch", "Runtime-local repository bindings", "binding record belongs to a different project identity")]);
  }
  const memberIds = memberRepositoryIds(bundle.project.value);
  for (const repositoryId of Object.keys(persisted?.repositories ?? {})) {
    if (!memberIds.has(repositoryId)) {
      throw new VnextConfigError([initIssue("local_binding_repository_invalid", "Runtime-local repository bindings", `persisted binding ${repositoryId} is not a member repository`)]);
    }
  }
  for (const repositoryId of Object.keys(explicit)) {
    if (!memberIds.has(repositoryId)) {
      throw new VnextConfigError([initIssue("local_binding_repository_invalid", "Runtime-local repository bindings", `explicit binding ${repositoryId} is not a member repository`)]);
    }
  }
  return memberIds;
}

/**
 * Unified initialization: create, resume a pinned operation, apply a
 * provenance-backed conflict-free template repair, join with local member
 * bindings, or return a non-mutating migration/conflict plan.
 */
function initializeVnextProjectAtGitRoot(
  start: string,
  gitRoot: string,
  options: VnextInitOptions,
  mutationLock?: VnextLocalBindingLock,
): VnextInitResult {
  const storeOptions = bindingStoreOptions(options);
  const persisted = existsSync(join(gitRoot, ".kxm", "project.yaml"))
    ? readVnextLocalBindings(gitRoot, storeOptions)
    : undefined;
  const repositoryBindings = Object.fromEntries([
    ...Object.entries(persisted?.repositories ?? {}),
    ...Object.entries(options.repositoryBindings ?? {}),
  ]);
  const loaderOptions = configOptions(options, repositoryBindings);
  const transactionOptions = repairOptions(options, repositoryBindings);

  if (hasVnextInitTransaction(gitRoot)) {
    const operation = inspectVnextInitTransaction(gitRoot, options.schemasDir);
    const plan = planVnextInitialization(start, loaderOptions);
    if (!operation) {
      if (options.dryRun) return { action: "planned", plan, projectRoot: gitRoot, resumePending: true, files: [] };
      if (!mutationLock) throw new Error("project mutation lock is required to clean an empty transaction");
      resumeVnextInitTransaction(gitRoot, transactionOptions);
    } else if (options.dryRun) {
      return {
        action: "planned",
        plan,
        projectRoot: gitRoot,
        resumePending: true,
        transactionKind: operation.kind,
        files: operation.files.map((file) => file.path),
      };
    } else {
      if (!mutationLock) throw new Error("project mutation lock is required to resume initialization");
      if (options.projectId !== undefined && options.projectId !== operation.projectId) {
        throw new VnextConfigError([initIssue("resume_project_id_mismatch", "--project-id", "requested project ID differs from the pinned initialization transaction")]);
      }
      if (options.projectName !== undefined && options.projectName !== operation.projectName) {
        throw new VnextConfigError([initIssue("resume_project_name_mismatch", "--name", "requested project name differs from the pinned initialization transaction")]);
      }
      if (operation.kind === "repair" && Object.keys(options.repositoryBindings ?? {}).length > 0) {
        const currentBundle = loadVnextProject(gitRoot, loaderOptions);
        finalizeBindingUpdate(
          currentBundle,
          persisted,
          repositoryBindings,
          options.repositoryBindings ?? {},
          storeOptions,
          mutationLock,
          false,
        );
      }
      const result = resumeVnextInitTransaction(gitRoot, transactionOptions);
      if (!result) throw new Error("initialization transaction disappeared while holding the project lock");
      const bindingResult = finalizeBindingUpdate(
        result.bundle,
        persisted,
        repositoryBindings,
        options.repositoryBindings ?? {},
        storeOptions,
        mutationLock,
        false,
      );
      commitVnextInitTransaction(gitRoot, options.schemasDir);
      return {
        action: "resumed",
        plan: completedPlan(gitRoot, loaderOptions),
        projectRoot: gitRoot,
        configRevision: result.bundle.configRevision,
        transactionKind: result.kind,
        ...bindingResult,
        files: result.files,
      };
    }
  }

  const plan = planVnextInitialization(start, loaderOptions);
  if (plan.mode === "migrate") {
    return { action: "planned", plan, ...(plan.projectRoot ? { projectRoot: plan.projectRoot } : {}), files: [] };
  }

  if (plan.mode === "repair") {
    const projectRoot = plan.projectRoot ?? gitRoot;
    let templateRepair: VnextTemplateRepairPlan | undefined;
    try {
      templateRepair = planVnextTemplateRepair(projectRoot, transactionOptions);
    } catch (error) {
      if (!(error instanceof VnextConfigError)) throw error;
      return plannedRepairResult({ ...plan, issues: [...plan.issues, ...error.issues] }, projectRoot);
    }
    if (!templateRepair?.canApply) return plannedRepairResult(plan, projectRoot, templateRepair);
    if (options.dryRun) return plannedRepairResult(plan, projectRoot, templateRepair);
    if (Object.keys(options.repositoryBindings ?? {}).length > 0) {
      const blockedRepair: VnextTemplateRepairPlan = {
        ...templateRepair,
        canApply: false,
        issues: [...templateRepair.issues, initIssue(
          "repair_binding_requires_ready_project",
          "--repository",
          "a first-time binding update cannot be combined with repair of an invalid project; establish a valid project or existing binding first",
        )],
      };
      return plannedRepairResult(plan, projectRoot, blockedRepair);
    }
    if (!mutationLock) throw new Error("project mutation lock is required to apply template repair");
    const repaired = prepareAndApplyVnextRepair(templateRepair, transactionOptions);
    const bindingResult = finalizeBindingUpdate(
      repaired.bundle,
      persisted,
      repositoryBindings,
      options.repositoryBindings ?? {},
      storeOptions,
      mutationLock,
      false,
    );
    commitVnextInitTransaction(projectRoot, options.schemasDir);
    return {
      action: "repaired",
      plan: completedPlan(projectRoot, loaderOptions),
      projectRoot,
      configRevision: repaired.bundle.configRevision,
      repairPlan: templateRepair,
      ...bindingResult,
      files: repaired.files,
    };
  }

  if (plan.mode === "ready") {
    const projectRoot = plan.projectRoot ?? gitRoot;
    const bundle = loadVnextProject(projectRoot, loaderOptions);
    const templateRepair = planVnextTemplateRepair(projectRoot, transactionOptions);
    if (templateRepair?.changesRequired) {
      if (!templateRepair.canApply || options.dryRun) return plannedRepairResult(plan, projectRoot, templateRepair);
      if (!mutationLock) throw new Error("project mutation lock is required to apply template repair");
      const bindingResult = finalizeBindingUpdate(
        bundle,
        persisted,
        repositoryBindings,
        options.repositoryBindings ?? {},
        storeOptions,
        mutationLock,
        false,
      );
      const repaired = prepareAndApplyVnextRepair(templateRepair, transactionOptions);
      finalizeBindingUpdate(
        repaired.bundle,
        persisted,
        repositoryBindings,
        options.repositoryBindings ?? {},
        storeOptions,
        mutationLock,
        false,
      );
      commitVnextInitTransaction(projectRoot, options.schemasDir);
      return {
        action: "repaired",
        plan: completedPlan(projectRoot, loaderOptions),
        projectRoot,
        configRevision: repaired.bundle.configRevision,
        repairPlan: templateRepair,
        ...bindingResult,
        files: repaired.files,
      };
    }

    const bindingResult = finalizeBindingUpdate(
      bundle,
      persisted,
      repositoryBindings,
      options.repositoryBindings ?? {},
      storeOptions,
      mutationLock,
      options.dryRun === true,
    );
    if (options.dryRun) {
      return {
        action: "planned",
        plan,
        projectRoot,
        configRevision: bundle.configRevision,
        ...bindingResult,
        files: [],
      };
    }
    return {
      action: bindingResult.bindingsChanged ? "joined" : "validated",
      plan,
      projectRoot,
      configRevision: bundle.configRevision,
      ...bindingResult,
      files: [],
    };
  }

  if (plan.projectRoot !== gitRoot) {
    throw new VnextConfigError([initIssue("git_root_required", ".", "kxm init must run inside the authoritative Git worktree")]);
  }
  const projectId = generatedProjectId(options.projectId);
  const projectName = normalizedProjectName(gitRoot, options.projectName);
  const rendered = renderVnextTemplate(projectId, projectName, options.templateVariant ?? CURRENT_VNEXT_TEMPLATE_VARIANT);
  const files = [...rendered.files.keys()];
  if (options.dryRun) return { action: "planned", plan, projectRoot: gitRoot, files };
  if (!mutationLock) throw new Error("project mutation lock is required to create configuration");
  if (existsSync(join(gitRoot, ".kxm"))) {
    throw new VnextConfigError([initIssue("workspace_changed", ".kxm", "workspace changed after planning; existing .kxm state was not overwritten")]);
  }
  const created = prepareAndApplyVnextCreate(gitRoot, rendered, transactionOptions);
  commitVnextInitTransaction(gitRoot, options.schemasDir);
  return {
    action: "created",
    plan: completedPlan(gitRoot, loaderOptions),
    projectRoot: gitRoot,
    configRevision: created.bundle.configRevision,
    files: created.files,
  };
}

export function initializeVnextProject(start = process.cwd(), options: VnextInitOptions = {}): VnextInitResult {
  assertNoRegisteredGates(options);
  const gitRoot = discoverGitRoot(start);
  if (!gitRoot) {
    throw new VnextConfigError([initIssue("git_root_required", ".", "kxm init must run inside the authoritative Git worktree")]);
  }
  if (options.projectId !== undefined) generatedProjectId(options.projectId);
  if (options.projectName !== undefined) normalizedProjectName(gitRoot, options.projectName);
  if (options.dryRun) return initializeVnextProjectAtGitRoot(start, gitRoot, options);

  const preflight = initializeVnextProjectAtGitRoot(start, gitRoot, { ...options, dryRun: true });
  const mutationRequired = preflight.resumePending === true
    || preflight.plan.mode === "create"
    || (preflight.repairPlan?.canApply === true
      && !(preflight.plan.mode === "repair" && Object.keys(options.repositoryBindings ?? {}).length > 0))
    || (Object.keys(options.repositoryBindings ?? {}).length > 0 && preflight.plan.mode === "ready");
  if (!mutationRequired) return initializeVnextProjectAtGitRoot(start, gitRoot, options);
  const storeOptions = bindingStoreOptions(options);
  return withVnextLocalBindingLock(gitRoot, storeOptions, (lock) => initializeVnextProjectAtGitRoot(start, gitRoot, options, lock));
}

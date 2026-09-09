import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  VnextConfigError,
  VnextSchemaRegistry,
  loadVnextProject,
  assertNoRegisteredGates,
  inspectVnextCreateDestination,
  parseRestrictedYaml,
  type JsonObject,
  type VnextConfigIssue,
  type VnextConfigOptions,
  type VnextProjectBundle,
} from "./vnext-config.ts";
import {
  CURRENT_VNEXT_TEMPLATE_VARIANT,
  VNEXT_TEMPLATE_ID,
  VNEXT_TEMPLATE_PROVENANCE_PATH,
  renderVnextTemplate,
  resolveVnextTemplateBaseline,
  SUPPORTED_VNEXT_TEMPLATE_VARIANTS,
  vnextContentSha256,
  type VnextRenderedTemplate,
  type VnextTemplateProvenance,
  type VnextTemplateVariant,
} from "./vnext-template.ts";
import { computeVnextResourcePermissionDiff } from "./vnext-permission.ts";
import type { VnextResourceKind } from "./vnext-config.ts";

/** Map a managed template path to its resource kind for permission diffing. */
function resourceKindForTemplatePath(path: string): VnextResourceKind {
  if (path === ".kxm/project.yaml") return "project";
  if (path === ".kxm/gates.yaml") return "gate-registry";
  if (path.endsWith("repo.yaml")) return "repository";
  if (path.startsWith(".kxm/agents/")) return "agent";
  if (path.startsWith(".kxm/models/")) return "model";
  if (path.startsWith(".kxm/workflows/")) return "workflow";
  return "environment";
}
const TRANSACTION_NAME = ".kxm-init-transaction";
const OPERATION_FILE = "operation.json";
const MAX_MANAGED_FILES = 128;
const MAX_MANAGED_FILE_BYTES = 256 * 1024;
const MAX_MANAGED_TOTAL_BYTES = 8 * 1024 * 1024;
const PORTABLE_PATH = /^(?:\.|(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*[. ](?:\/|$))[^/\\\u0000-\u001F]+(?:\/[^/\\\u0000-\u001F]+)*)$/;

export type VnextTemplateClassification = "unchanged" | "user-only" | "template-only" | "converged" | "conflict";

export interface VnextTemplateChange {
  path: string;
  classification: VnextTemplateClassification;
  baseSha256?: string;
  localSha256?: string;
  targetSha256?: string;
  action: "none" | "create" | "replace";
  policyReviewRequired: boolean;
  reason?: string;
}

export interface VnextTemplateRepairPlan {
  projectRoot: string;
  projectId: string;
  projectName: string;
  sourceTemplateRevision: string;
  targetTemplateRevision: string;
  changesRequired: boolean;
  canApply: boolean;
  changes: readonly VnextTemplateChange[];
  issues: readonly VnextConfigIssue[];
}

interface VnextInitOperationFile {
  path: string;
  observedSha256: string | null;
  targetSha256: string;
  classification: "template-only" | "converged";
  action: "create" | "replace" | "none";
}

interface VnextInitOperation {
  schema: "kxm.init-operation.v1";
  operationId: string;
  kind: "create" | "repair";
  phase: "preparing" | "prepared" | "applying" | "verified";
  projectRoot: string;
  projectId: string;
  projectName: string;
  templateId: typeof VNEXT_TEMPLATE_ID;
  sourceTemplateRevision: string | null;
  targetTemplateRevision: string;
  planSha256: string;
  files: readonly VnextInitOperationFile[];
}

export interface VnextOperationResult {
  kind: "create" | "repair";
  resumed: boolean;
  bundle: VnextProjectBundle;
  files: readonly string[];
}

export interface VnextRepairRuntimeOptions {
  schemasDir?: string;
  repositoryBindings?: Readonly<Record<string, string>>;
  registeredExecutors?: Iterable<string>;
  registeredToolPresets?: Iterable<string>;
  templateVariant?: VnextTemplateVariant;
  testFaultAt?: "prepared" | "first-resource" | "provenance" | "verified";
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function repairIssue(code: string, file: string, message: string, phase: VnextConfigIssue["phase"] = "semantic"): VnextConfigIssue {
  return { phase, code, file, message };
}

function fail(code: string, file: string, message: string, phase: VnextConfigIssue["phase"] = "semantic"): never {
  throw new VnextConfigError([repairIssue(code, file, message, phase)]);
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeDurableNew(file: string, bytes: string | Uint8Array, mode: number): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "wx", mode);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try { chmodSync(file, mode); } catch { /* Windows may not expose POSIX mode changes. */ }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  syncDirectory(dirname(file));
}

function writeDurable(file: string, bytes: string | Uint8Array, mode: number): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "w", mode);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try { chmodSync(file, mode); } catch { /* Windows may not expose POSIX mode changes. */ }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  syncDirectory(dirname(file));
}

function sameHostPath(left: string, right: string): boolean {
  const first = resolve(left);
  const second = resolve(right);
  return process.platform === "win32"
    ? first.toLocaleLowerCase("en-US") === second.toLocaleLowerCase("en-US")
    : first === second;
}

function transactionRoot(projectRoot: string): string {
  return join(resolve(projectRoot), TRANSACTION_NAME);
}

export function vnextInitTransactionPath(projectRoot: string): string {
  return transactionRoot(projectRoot);
}

function operationFile(projectRoot: string): string {
  return join(transactionRoot(projectRoot), OPERATION_FILE);
}

function targetFile(projectRoot: string, portablePath: string): string {
  return join(transactionRoot(projectRoot), "targets", ...portablePath.split("/"));
}

function shadowRoot(projectRoot: string): string {
  return join(transactionRoot(projectRoot), "shadow");
}

function backupFile(projectRoot: string, portablePath: string): string {
  return join(transactionRoot(projectRoot), "backups", ...portablePath.split("/"));
}

function portableManagedPath(path: string): boolean {
  return path.startsWith(".kxm/")
    && path !== VNEXT_TEMPLATE_PROVENANCE_PATH
    && path.length <= 1024
    && !path.includes("\\")
    && !isAbsolute(path)
    && PORTABLE_PATH.test(path)
    && !/[<>:"|?*]/.test(path);
}

function readRegularBounded(file: string, label: string): Buffer {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) fail("repair_file_invalid", label, "managed file must be a regular file, not a link or directory", "path");
  if (stat.size > MAX_MANAGED_FILE_BYTES) fail("repair_file_too_large", label, `managed file exceeds ${MAX_MANAGED_FILE_BYTES} bytes`, "parse");
  return readFileSync(file);
}

function readOptionalManaged(projectRoot: string, path: string): Buffer | undefined {
  const file = join(projectRoot, ...path.split("/"));
  if (!existsSync(file)) return undefined;
  let parent = dirname(file);
  const boundary = resolve(projectRoot);
  while (parent !== boundary) {
    const stat = lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("repair_parent_invalid", path, "managed file parents must be regular directories", "path");
    parent = dirname(parent);
  }
  return readRegularBounded(file, path);
}

function readProjectAndProvenance(projectRoot: string, schemasDir?: string): { project: JsonObject; provenance: VnextTemplateProvenance; provenanceBytes: Buffer } | undefined {
  const projectFile = join(projectRoot, ".kxm", "project.yaml");
  const provenanceFile = join(projectRoot, ...VNEXT_TEMPLATE_PROVENANCE_PATH.split("/"));
  if (!existsSync(projectFile) || !existsSync(provenanceFile)) return undefined;
  const projectBytes = readOptionalManaged(projectRoot, ".kxm/project.yaml");
  const provenanceBytes = readOptionalManaged(projectRoot, VNEXT_TEMPLATE_PROVENANCE_PATH);
  if (!projectBytes || !provenanceBytes) return undefined;
  const project = parseRestrictedYaml(projectBytes, ".kxm/project.yaml");
  const provenanceValue = parseRestrictedYaml(provenanceBytes, VNEXT_TEMPLATE_PROVENANCE_PATH);
  const registry = new VnextSchemaRegistry(schemasDir);
  const issues = [
    ...registry.validate("project", project, ".kxm/project.yaml"),
    ...registry.validateTemplateProvenance(provenanceValue, VNEXT_TEMPLATE_PROVENANCE_PATH),
  ];
  if (issues.length > 0) throw new VnextConfigError(issues);
  const provenance = resolveVnextTemplateBaseline(provenanceValue);
  if (!provenance) fail("template_provenance_revision_invalid", VNEXT_TEMPLATE_PROVENANCE_PATH, "template provenance does not exactly match a supported built-in baseline");
  if (project.id !== provenance.inputs.projectId) {
    fail("template_provenance_project_mismatch", VNEXT_TEMPLATE_PROVENANCE_PATH, "template provenance belongs to a different project identity");
  }
  const seen = new Set<string>();
  let prior = "";
  let totalBytes = 0;
  for (const record of provenance.files) {
    if (!portableManagedPath(record.path)) fail("template_provenance_path_invalid", VNEXT_TEMPLATE_PROVENANCE_PATH, `managed path ${record.path} is invalid`, "path");
    const folded = record.path.toLocaleLowerCase("en-US");
    if (seen.has(folded)) fail("template_provenance_path_collision", VNEXT_TEMPLATE_PROVENANCE_PATH, `managed path ${record.path} collides after case folding`, "path");
    if (prior && compareCodeUnits(prior, record.path) >= 0) fail("template_provenance_order_invalid", VNEXT_TEMPLATE_PROVENANCE_PATH, "managed files are not in strict code-unit order");
    totalBytes += record.bytes;
    seen.add(folded);
    prior = record.path;
  }
  if (provenance.files.length > MAX_MANAGED_FILES || totalBytes > MAX_MANAGED_TOTAL_BYTES) {
    fail("template_provenance_bounds_exceeded", VNEXT_TEMPLATE_PROVENANCE_PATH, "managed template manifest exceeds bounded file or byte limits", "parse");
  }
  return { project, provenance, provenanceBytes };
}

/** Classify exact whole-file B/L/T states without writing or inferring a missing baseline. */
export function planVnextTemplateRepair(
  projectRoot: string,
  options: VnextRepairRuntimeOptions = {},
): VnextTemplateRepairPlan | undefined {
  assertNoRegisteredGates(options);
  const root = resolve(projectRoot);
  const source = readProjectAndProvenance(root, options.schemasDir);
  if (!source) return undefined;
  const target = renderVnextTemplate(
    source.provenance.inputs.projectId,
    source.provenance.inputs.projectName,
    options.templateVariant ?? CURRENT_VNEXT_TEMPLATE_VARIANT,
  );
  const baseByPath = new Map(source.provenance.files.map((record) => [record.path, record]));
  const targetByPath = new Map(target.provenance.files.map((record) => [record.path, record]));
  const paths = [...new Set([...baseByPath.keys(), ...targetByPath.keys()])].sort(compareCodeUnits);
  const sourceRenderer = SUPPORTED_VNEXT_TEMPLATE_VARIANTS
    .map((variant) => renderVnextTemplate(source.provenance.inputs.projectId, source.provenance.inputs.projectName, variant))
    .find((candidate) => candidate.templateRevision === source.provenance.templateRevision);
  const expectedProvenance = sourceRenderer?.files.get(VNEXT_TEMPLATE_PROVENANCE_PATH);
  const issues: VnextConfigIssue[] = [];
  if (!expectedProvenance || vnextContentSha256(source.provenanceBytes) !== vnextContentSha256(expectedProvenance)) {
    issues.push(repairIssue(
      "template_provenance_user_modified",
      VNEXT_TEMPLATE_PROVENANCE_PATH,
      "template provenance formatting or bytes differ from the supported baseline and require review",
    ));
  }
  const changes = paths.map((path): VnextTemplateChange => {
    const base = baseByPath.get(path);
    const targetRecord = targetByPath.get(path);
    const local = readOptionalManaged(root, path);
    const localSha256 = local && vnextContentSha256(local);
    const baseSha256 = base?.sha256;
    if (base && localSha256 === base.sha256 && local?.byteLength !== base.bytes) {
      fail("template_provenance_bytes_invalid", VNEXT_TEMPLATE_PROVENANCE_PATH, `recorded byte count for ${path} does not match its baseline content`);
    }
    const targetSha256 = targetRecord?.sha256;
    if (baseSha256 === localSha256 && localSha256 === targetSha256) {
      return {
        path,
        classification: "unchanged",
        ...(baseSha256 ? { baseSha256 } : {}),
        ...(localSha256 ? { localSha256 } : {}),
        ...(targetSha256 ? { targetSha256 } : {}),
        action: "none",
        policyReviewRequired: false,
      };
    }
    if (localSha256 !== undefined && localSha256 === targetSha256) {
      return { path, classification: "converged", ...(baseSha256 ? { baseSha256 } : {}), localSha256, targetSha256, action: "none", policyReviewRequired: false };
    }
    if (localSha256 === baseSha256 && targetRecord) {
      const authorityChanged = base?.authoritySha256 !== targetRecord.authoritySha256;
      if (authorityChanged || !base) {
        const baseValue = base ? sourceRenderer?.values.get(path) : undefined;
        const targetValue = target.values.get(path);
        const detail = baseValue && targetValue
          ? computeVnextResourcePermissionDiff(resourceKindForTemplatePath(path), path, baseValue, targetValue)
              .map((change) => `${change.path} ${change.field} ${change.direction}`)
              .join("; ")
          : "";
        issues.push(repairIssue(
          "template_policy_review_required",
          path,
          `template change alters or introduces an authority-bearing resource and requires reviewed permission-diff trust${detail ? `: ${detail}` : ""}`,
        ));
        return {
          path,
          classification: "conflict",
          ...(baseSha256 ? { baseSha256 } : {}),
          ...(localSha256 ? { localSha256 } : {}),
          ...(targetSha256 ? { targetSha256 } : {}),
          action: "none",
          policyReviewRequired: true,
          reason: "authority projection changed",
        };
      }
      return {
        path,
        classification: "template-only",
        baseSha256: baseSha256 as string,
        ...(localSha256 ? { localSha256 } : {}),
        targetSha256: targetSha256 as string,
        action: localSha256 === undefined ? "create" : "replace",
        policyReviewRequired: false,
      };
    }
    if (targetSha256 === baseSha256) {
      return {
        path,
        classification: "user-only",
        ...(baseSha256 ? { baseSha256 } : {}),
        ...(localSha256 ? { localSha256 } : {}),
        ...(targetSha256 ? { targetSha256 } : {}),
        action: "none",
        policyReviewRequired: false,
      };
    }
    issues.push(repairIssue("template_repair_conflict", path, "both the user and template changed this managed file; local bytes were preserved"));
    return {
      path,
      classification: "conflict",
      ...(baseSha256 ? { baseSha256 } : {}),
      ...(localSha256 ? { localSha256 } : {}),
      ...(targetSha256 ? { targetSha256 } : {}),
      action: "none",
      policyReviewRequired: false,
      reason: targetRecord ? "user and template changes overlap" : "template deletion requires explicit review",
    };
  });
  const changesRequired = source.provenance.templateRevision !== target.templateRevision;
  return {
    projectRoot: root,
    projectId: source.provenance.inputs.projectId,
    projectName: source.provenance.inputs.projectName,
    sourceTemplateRevision: source.provenance.templateRevision,
    targetTemplateRevision: target.templateRevision,
    changesRequired,
    canApply: changesRequired && issues.length === 0,
    changes,
    issues,
  };
}

function operationPlanSha(operation: Omit<VnextInitOperation, "planSha256" | "phase">): string {
  return vnextContentSha256(JSON.stringify({
    kind: operation.kind,
    projectRoot: operation.projectRoot,
    projectId: operation.projectId,
    projectName: operation.projectName,
    templateId: operation.templateId,
    sourceTemplateRevision: operation.sourceTemplateRevision,
    targetTemplateRevision: operation.targetTemplateRevision,
    files: operation.files,
  }));
}

function writeOperation(projectRoot: string, operation: VnextInitOperation): void {
  const root = transactionRoot(projectRoot);
  const file = operationFile(projectRoot);
  const temporary = join(root, `.operation-${operation.operationId}-${randomUUID()}.tmp`);
  try {
    writeDurableNew(temporary, Buffer.from(`${JSON.stringify(operation, null, 2)}\n`, "utf8"), 0o600);
    renameSync(temporary, file);
    syncDirectory(root);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function updatePhase(projectRoot: string, operation: VnextInitOperation, phase: VnextInitOperation["phase"]): VnextInitOperation {
  const updated = { ...operation, phase };
  writeOperation(projectRoot, updated);
  return updated;
}

function readOperation(projectRoot: string, schemasDir?: string): VnextInitOperation | undefined {
  const root = transactionRoot(projectRoot);
  if (!existsSync(root)) return undefined;
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("init_transaction_invalid", TRANSACTION_NAME, "initialization transaction must be a regular directory", "path");
  const file = operationFile(projectRoot);
  if (!existsSync(file)) {
    const entries = readdirSync(root, { withFileTypes: true });
    const recoverable = entries.every((entry) => entry.isFile() && /^\.operation-op_[a-f0-9]{32}-[a-f0-9-]{36}\.tmp$/.test(entry.name));
    if (recoverable) return undefined;
    fail("init_transaction_record_missing", TRANSACTION_NAME, "initialization transaction without an operation record contains unrecognized state");
  }
  const value = parseRestrictedYaml(readRegularBounded(file, `${TRANSACTION_NAME}/${OPERATION_FILE}`), `${TRANSACTION_NAME}/${OPERATION_FILE}`);
  const registry = new VnextSchemaRegistry(schemasDir);
  const issues = registry.validateInitOperation(value, `${TRANSACTION_NAME}/${OPERATION_FILE}`);
  if (issues.length > 0) throw new VnextConfigError(issues);
  const operation = value as unknown as VnextInitOperation;
  if (!sameHostPath(operation.projectRoot, projectRoot)) fail("init_transaction_project_mismatch", TRANSACTION_NAME, "operation belongs to a different project root");
  const expectedPlanSha = operationPlanSha(operation);
  if (operation.planSha256 !== expectedPlanSha) fail("init_transaction_plan_hash_invalid", TRANSACTION_NAME, "operation plan hash does not match its immutable intent");
  let prior = "";
  const seen = new Set<string>();
  for (const entry of operation.files) {
    if (!entry.path.startsWith(".kxm/") || !PORTABLE_PATH.test(entry.path)) fail("init_transaction_path_invalid", TRANSACTION_NAME, `operation path ${entry.path} is invalid`, "path");
    const folded = entry.path.toLocaleLowerCase("en-US");
    if (seen.has(folded) || (prior && compareCodeUnits(prior, entry.path) >= 0)) fail("init_transaction_order_invalid", TRANSACTION_NAME, "operation paths must be unique and use strict code-unit order", "path");
    seen.add(folded);
    prior = entry.path;
  }
  if (!isAbsolute(operation.projectRoot)) fail("init_transaction_project_root_invalid", TRANSACTION_NAME, "operation project root must be absolute", "path");
  validateOperationIntent(projectRoot, operation);
  return operation;
}

export function hasVnextInitTransaction(projectRoot: string): boolean {
  return existsSync(transactionRoot(projectRoot));
}

function readTarget(projectRoot: string, path: string): Buffer | undefined {
  return readOptionalManaged(join(transactionRoot(projectRoot), "targets"), path);
}

function writeTarget(projectRoot: string, path: string, bytes: Buffer): void {
  if (bytes.byteLength > MAX_MANAGED_FILE_BYTES) fail("template_target_too_large", path, `target exceeds ${MAX_MANAGED_FILE_BYTES} bytes`);
  const file = targetFile(projectRoot, path);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeDurableNew(file, bytes, 0o600);
}

function writeAndVerifyBackups(projectRoot: string, operation: VnextInitOperation): void {
  if (operation.kind !== "repair") return;
  for (const entry of operation.files) {
    if (entry.observedSha256 === null) continue;
    const current = readOptionalManaged(projectRoot, entry.path);
    if (!current || vnextContentSha256(current) !== entry.observedSha256) {
      fail("repair_preimage_changed", entry.path, "destination changed before transaction preparation; local bytes were preserved");
    }
    const file = backupFile(projectRoot, entry.path);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeDurableNew(file, current, 0o600);
  }
}

function writeKnownBackups(projectRoot: string, operation: VnextInitOperation): void {
  if (operation.kind !== "repair" || !operation.sourceTemplateRevision) return;
  const source = rendererForRevision(operation, operation.sourceTemplateRevision);
  if (!source) fail("init_transaction_source_unknown", TRANSACTION_NAME, "operation source is not a supported built-in template");
  for (const entry of operation.files) {
    if (entry.observedSha256 === null) continue;
    const bytes = source.files.get(entry.path);
    if (!bytes || vnextContentSha256(bytes) !== entry.observedSha256) {
      fail("init_transaction_backup_source_invalid", entry.path, "supported source template cannot reproduce the pinned preimage");
    }
    const file = backupFile(projectRoot, entry.path);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeDurableNew(file, bytes, 0o600);
  }
}

function verifyBackups(projectRoot: string, operation: VnextInitOperation): void {
  if (operation.kind !== "repair") return;
  for (const entry of operation.files) {
    if (entry.observedSha256 === null) continue;
    const bytes = readOptionalManaged(join(transactionRoot(projectRoot), "backups"), entry.path);
    if (!bytes || vnextContentSha256(bytes) !== entry.observedSha256) {
      fail("init_transaction_backup_invalid", entry.path, "pinned preimage backup is missing or corrupt");
    }
  }
}

function verifyTargetArtifacts(projectRoot: string, operation: VnextInitOperation): void {
  let total = 0;
  for (const entry of operation.files) {
    const bytes = readTarget(projectRoot, entry.path);
    if (!bytes) fail("init_transaction_target_missing", entry.path, "pinned target artifact is missing");
    total += bytes.byteLength;
    if (vnextContentSha256(bytes) !== entry.targetSha256) fail("init_transaction_target_mismatch", entry.path, "pinned target artifact hash does not match the operation");
  }
  if (operation.files.length > MAX_MANAGED_FILES || total > MAX_MANAGED_TOTAL_BYTES) fail("init_transaction_bounds_exceeded", TRANSACTION_NAME, "operation exceeds bounded file or byte limits", "parse");
}

function loaderOptions(options: VnextRepairRuntimeOptions): VnextConfigOptions {
  assertNoRegisteredGates(options);
  return {
    ...(options.schemasDir === undefined ? {} : { schemasDir: options.schemasDir }),
    ...(options.repositoryBindings === undefined ? {} : { repositoryBindings: options.repositoryBindings }),
    ...(options.registeredExecutors === undefined ? {} : { registeredExecutors: options.registeredExecutors }),
    ...(options.registeredToolPresets === undefined ? {} : { registeredToolPresets: options.registeredToolPresets }),
  };
}

function sourceConfigFiles(projectRoot: string): string[] {
  const fixed = [
    ".kxm/project.yaml",
    ".kxm/gates.yaml",
    VNEXT_TEMPLATE_PROVENANCE_PATH,
    ".kxm/project/env.yaml",
    ".kxm/repo/repo.yaml",
    ".kxm/repo/env.yaml",
  ];
  const files = fixed.filter((path) => existsSync(join(projectRoot, ...path.split("/"))));
  for (const directory of ["agents", "models", "workflows"]) {
    const absolute = join(projectRoot, ".kxm", directory);
    if (!existsSync(absolute)) continue;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("repair_directory_invalid", `.kxm/${directory}`, "configuration directory must be regular", "path");
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) fail("repair_nested_directory", `.kxm/${directory}/${entry.name}`, "nested configuration directories are not repairable", "path");
      const lower = entry.name.toLocaleLowerCase("en-US");
      if (lower.endsWith(".yaml") || lower.endsWith(".yml")) files.push(`.kxm/${directory}/${entry.name}`);
    }
  }
  const ordered = [...new Set(files)].sort(compareCodeUnits);
  if (ordered.length > MAX_MANAGED_FILES) fail("repair_snapshot_too_many_files", ".kxm", `configuration snapshot exceeds ${MAX_MANAGED_FILES} files`, "parse");
  return ordered;
}

function absoluteMemberBindings(projectRoot: string, project: JsonObject, explicit: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
  const bindings: Record<string, string> = { ...explicit };
  const repositories = Array.isArray(project.repositories) ? project.repositories : [];
  for (const candidate of repositories) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const repository = candidate as JsonObject;
    if (repository.role !== "member" || typeof repository.id !== "string" || Object.hasOwn(bindings, repository.id)) continue;
    if (typeof repository.pathHint === "string") {
      const candidate = resolve(projectRoot, ...repository.pathHint.split("/"));
      if (existsSync(candidate)) bindings[repository.id] = candidate;
    }
  }
  return bindings;
}

function prepareShadow(projectRoot: string, operation: VnextInitOperation, options: VnextRepairRuntimeOptions): void {
  const shadow = shadowRoot(projectRoot);
  mkdirSync(shadow, { recursive: true, mode: 0o700 });
  let total = 0;
  if (operation.kind === "repair") {
    for (const path of sourceConfigFiles(projectRoot)) {
      const bytes = readOptionalManaged(projectRoot, path);
      if (!bytes) fail("repair_snapshot_file_missing", path, "configuration changed during shadow preparation");
      total += bytes.byteLength;
      const source = join(projectRoot, ...path.split("/"));
      const destination = join(shadow, ...path.split("/"));
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeDurableNew(destination, bytes, lstatSync(source).mode & 0o777);
      if (total > MAX_MANAGED_TOTAL_BYTES) fail("repair_snapshot_too_large", ".kxm", `configuration snapshot exceeds ${MAX_MANAGED_TOTAL_BYTES} bytes`, "parse");
    }
  }
  for (const entry of operation.files) {
    const bytes = readTarget(projectRoot, entry.path);
    if (!bytes) fail("init_transaction_target_missing", entry.path, "pinned target artifact is missing");
    const destination = join(shadow, ...entry.path.split("/"));
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const mode = existsSync(destination) ? lstatSync(destination).mode & 0o777 : 0o644;
    writeDurable(destination, bytes, mode);
  }
  const project = parseRestrictedYaml(readFileSync(join(shadow, ".kxm", "project.yaml")), ".kxm/project.yaml");
  const bound = absoluteMemberBindings(projectRoot, project, options.repositoryBindings);
  loadVnextProject(shadow, { ...loaderOptions(options), repositoryBindings: bound });
  const provenance = readProjectAndProvenance(shadow, options.schemasDir)?.provenance;
  if (!provenance || provenance.templateRevision !== operation.targetTemplateRevision) {
    fail("repair_shadow_provenance_invalid", VNEXT_TEMPLATE_PROVENANCE_PATH, "prospective template provenance does not match the pinned target");
  }
}

function createOperation(
  projectRoot: string,
  kind: "create" | "repair",
  rendered: VnextRenderedTemplate,
  files: readonly VnextInitOperationFile[],
  sourceTemplateRevision: string | null,
): VnextInitOperation {
  const root = resolve(projectRoot);
  const operationWithoutHash = {
    schema: "kxm.init-operation.v1" as const,
    operationId: `op_${randomUUID().replaceAll("-", "")}`,
    kind,
    projectRoot: root,
    projectId: rendered.projectId,
    projectName: rendered.projectName,
    templateId: VNEXT_TEMPLATE_ID as typeof VNEXT_TEMPLATE_ID,
    sourceTemplateRevision,
    targetTemplateRevision: rendered.templateRevision,
    files: [...files].sort((left, right) => compareCodeUnits(left.path, right.path)),
  };
  return {
    ...operationWithoutHash,
    phase: "preparing",
    planSha256: operationPlanSha(operationWithoutHash),
  };
}

function validateOperationRecord(operation: VnextInitOperation, schemasDir?: string): void {
  const label = `${TRANSACTION_NAME}/${OPERATION_FILE}`;
  const value = parseRestrictedYaml(Buffer.from(JSON.stringify(operation), "utf8"), label);
  const issues = new VnextSchemaRegistry(schemasDir).validateInitOperation(value, label);
  if (issues.length > 0) throw new VnextConfigError(issues);
}

function prepareOperation(
  projectRoot: string,
  operation: VnextInitOperation,
  rendered: VnextRenderedTemplate,
  options: VnextRepairRuntimeOptions,
): VnextInitOperation {
  const transaction = transactionRoot(projectRoot);
  validateOperationRecord(operation, options.schemasDir);
  validateOperationIntent(projectRoot, operation);
  if (existsSync(transaction)) fail("init_transaction_exists", TRANSACTION_NAME, "an initialization transaction already exists and must be resumed");
  mkdirSync(transaction, { mode: 0o700 });
  syncDirectory(projectRoot);
  writeOperation(projectRoot, operation);
  try {
    for (const entry of operation.files) {
      const bytes = rendered.files.get(entry.path);
      if (!bytes || vnextContentSha256(bytes) !== entry.targetSha256) fail("template_target_unavailable", entry.path, "renderer cannot reproduce the pinned target bytes");
      writeTarget(projectRoot, entry.path, bytes);
    }
    writeAndVerifyBackups(projectRoot, operation);
    verifyTargetArtifacts(projectRoot, operation);
    verifyBackups(projectRoot, operation);
    prepareShadow(projectRoot, operation, options);
    syncTreeDirectories(transaction);
    return updatePhase(projectRoot, operation, "prepared");
  } catch (error) {
    rmSync(transaction, { recursive: true, force: true });
    throw error;
  }
}

function ensureDestinationParents(projectRoot: string, path: string): void {
  const boundary = resolve(projectRoot);
  const segments = path.split("/").slice(0, -1);
  let current = boundary;
  for (const segment of segments) {
    current = join(current, segment);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("repair_destination_parent_invalid", path, "destination parent must be a regular directory", "path");
  }
}

function destinationSha(projectRoot: string, path: string): string | undefined {
  const file = join(projectRoot, ...path.split("/"));
  if (!existsSync(file)) return undefined;
  return vnextContentSha256(readRegularBounded(file, path));
}

function requireConditionalLinkSupport(directory: string, operationId: string, path: string): void {
  const nonce = randomUUID();
  const source = join(directory, `.kxm-repair-${operationId}-${nonce}.link-source`);
  const target = join(directory, `.kxm-repair-${operationId}-${nonce}.link-target`);
  try {
    writeDurableNew(source, Buffer.from("kxm-link-probe\n", "utf8"), 0o600);
    try { linkSync(source, target); }
    catch { fail("repair_hard_link_unsupported", path, "filesystem does not support the conditional hard-link install required for safe repair"); }
  } finally {
    rmSync(target, { force: true });
    rmSync(source, { force: true });
    syncDirectory(directory);
  }
}

function atomicInstallTarget(projectRoot: string, operation: VnextInitOperation, entry: VnextInitOperationFile): void {
  const destination = join(projectRoot, ...entry.path.split("/"));
  ensureDestinationParents(projectRoot, entry.path);
  const directory = dirname(destination);
  const temporaryPrefix = `.kxm-repair-${operation.operationId}-`;
  const pathKey = vnextContentSha256(entry.path).slice("sha256:".length, "sha256:".length + 16);
  const displaced = join(directory, `${temporaryPrefix}${pathKey}.preimage`);
  if (existsSync(displaced)) {
    const stat = lstatSync(displaced);
    if (stat.isSymbolicLink() || !stat.isFile()) fail("repair_preimage_temporary_invalid", entry.path, "stale displaced preimage is not a regular file", "path");
    if (entry.observedSha256 === null || vnextContentSha256(readFileSync(displaced)) !== entry.observedSha256) {
      fail("repair_preimage_temporary_mismatch", entry.path, "stale displaced preimage does not match the pinned operation");
    }
    if (!existsSync(destination)) {
      try { linkSync(displaced, destination); }
      catch { fail("repair_preimage_restore_blocked", entry.path, "could not conditionally restore a displaced preimage"); }
      syncDirectory(directory);
    }
    rmSync(displaced, { force: true });
    syncDirectory(directory);
  }

  for (const candidate of readdirSync(directory, { withFileTypes: true })) {
    const owned = candidate.name.startsWith(temporaryPrefix)
      && (candidate.name.endsWith(".tmp") || candidate.name.endsWith(".link-source") || candidate.name.endsWith(".link-target"));
    if (!owned) continue;
    if (!candidate.isFile()) fail("repair_temporary_invalid", entry.path, "stale operation temporary is not a regular file", "path");
    rmSync(join(directory, candidate.name), { force: true });
  }
  const current = destinationSha(projectRoot, entry.path);
  if (current === entry.targetSha256) return;
  if (current !== (entry.observedSha256 ?? undefined)) {
    fail("repair_preimage_changed", entry.path, "destination changed after planning; pinned target was not installed");
  }
  requireConditionalLinkSupport(directory, operation.operationId, entry.path);
  const bytes = readTarget(projectRoot, entry.path);
  if (!bytes) fail("init_transaction_target_missing", entry.path, "pinned target artifact is missing");
  const temporary = join(directory, `${temporaryPrefix}${randomUUID()}.tmp`);
  const mode = existsSync(destination) ? lstatSync(destination).mode & 0o777 : 0o644;
  try {
    writeDurableNew(temporary, bytes, mode);
    if (entry.observedSha256 !== null) {
      renameSync(destination, displaced);
      syncDirectory(directory);
      if (vnextContentSha256(readFileSync(displaced)) !== entry.observedSha256) {
        if (!existsSync(destination)) {
          try { linkSync(displaced, destination); }
          catch { fail("repair_preimage_restore_blocked", entry.path, "changed destination was displaced but could not be conditionally restored; its bytes remain in the operation preimage file"); }
          syncDirectory(directory);
          rmSync(displaced, { force: true });
          syncDirectory(directory);
        }
        fail("repair_preimage_changed", entry.path, "destination changed at replacement time; concurrent bytes were preserved at the destination or in the operation preimage file");
      }
    }
    try {
      linkSync(temporary, destination);
    } catch {
      if (!existsSync(destination) && existsSync(displaced)) {
        try { linkSync(displaced, destination); }
        catch { fail("repair_preimage_restore_blocked", entry.path, "target install failed and the displaced preimage could not be conditionally restored"); }
        syncDirectory(directory);
      }
      rmSync(displaced, { force: true });
      syncDirectory(directory);
      fail("repair_destination_recreated", entry.path, "destination was recreated concurrently or conditional install is unsupported; pinned target was not installed");
    }
    syncDirectory(directory);
    rmSync(temporary, { force: true });
    rmSync(displaced, { force: true });
    syncDirectory(directory);
  } finally {
    rmSync(temporary, { force: true });
  }
  if (destinationSha(projectRoot, entry.path) !== entry.targetSha256) fail("repair_install_verification_failed", entry.path, "installed target hash does not match the pinned operation");
}

function failIncompatibleCreateDestination(inspection: ReturnType<typeof inspectVnextCreateDestination>): never {
  const path = inspection.path ?? ".kxm";
  if (inspection.reason === "linked" || inspection.reason === "linked-runtime-root") {
    fail("create_resume_link", path, "create destination must not contain links", "path");
  }
  fail("create_resume_conflict", path, "existing project configuration does not match the pinned create operation");
}

function installedCreateMatches(projectRoot: string, operation: VnextInitOperation): boolean {
  const inspection = inspectVnextCreateDestination(projectRoot, operation.files.map((entry) => entry.path));
  if (inspection.kind === "incompatible") failIncompatibleCreateDestination(inspection);
  if (inspection.kind === "absent") return false;
  return operation.files.every((entry) => destinationSha(projectRoot, entry.path) === entry.targetSha256);
}

function applyCreateMerge(
  projectRoot: string,
  operation: VnextInitOperation,
  options: VnextRepairRuntimeOptions,
): void {
  const inspection = inspectVnextCreateDestination(projectRoot, operation.files.map((entry) => entry.path));
  if (inspection.kind === "incompatible") failIncompatibleCreateDestination(inspection);
  if (installedCreateMatches(projectRoot, operation)) return;
  const projectEntry = operation.files.find((entry) => entry.path === ".kxm/project.yaml");
  const resources = operation.files.filter((entry) => entry.path !== ".kxm/project.yaml");
  let installed = 0;
  for (const entry of resources) {
    atomicInstallTarget(projectRoot, operation, entry);
    installed += 1;
    if (installed === 1 && options.testFaultAt === "first-resource") throw new Error("injected init fault after first resource");
  }
  if (projectEntry) atomicInstallTarget(projectRoot, operation, projectEntry);
  if (!installedCreateMatches(projectRoot, operation)) {
    fail("create_resume_conflict", ".kxm", "existing project configuration does not match the pinned create operation");
  }
}

function syncTreeDirectories(root: string): void {
  if (!existsSync(root)) return;
  const directories: string[] = [];
  const visit = (directory: string): void => {
    directories.push(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(directory, entry.name));
    }
  };
  visit(root);
  for (const directory of directories.reverse()) syncDirectory(directory);
}

function rebuildCreateShadow(projectRoot: string, operation: VnextInitOperation, options: VnextRepairRuntimeOptions): void {
  const shadow = shadowRoot(projectRoot);
  rmSync(shadow, { recursive: true, force: true });
  prepareShadow(projectRoot, operation, options);
  const stat = lstatSync(shadow);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !installedCreateMatches(shadow, operation)) {
    fail("create_shadow_invalid", TRANSACTION_NAME, "reconstructed create shadow does not exactly match pinned target files", "path");
  }
  syncTreeDirectories(join(shadow, ".kxm"));
}

function applyOperation(
  projectRoot: string,
  original: VnextInitOperation,
  options: VnextRepairRuntimeOptions,
  resumed: boolean,
): VnextOperationResult {
  assertNoRegisteredGates(options);
  let operation = original;
  const effectiveOptions = options;
  verifyTargetArtifacts(projectRoot, operation);
  verifyBackups(projectRoot, operation);
  operation = updatePhase(projectRoot, operation, "applying");
  if (operation.kind === "create") {
    const destination = join(projectRoot, ".kxm");
    let destinationStat: ReturnType<typeof lstatSync> | undefined;
    try { destinationStat = lstatSync(destination); } catch { destinationStat = undefined; }
    if (!destinationStat) {
      rebuildCreateShadow(projectRoot, operation, effectiveOptions);
      renameSync(join(shadowRoot(projectRoot), ".kxm"), destination);
      syncDirectory(projectRoot);
    } else {
      applyCreateMerge(projectRoot, operation, effectiveOptions);
    }
  } else {
    const resources = operation.files.filter((entry) => entry.path !== VNEXT_TEMPLATE_PROVENANCE_PATH && entry.action !== "none");
    let installed = 0;
    for (const entry of resources) {
      atomicInstallTarget(projectRoot, operation, entry);
      installed += 1;
      if (installed === 1 && options.testFaultAt === "first-resource") throw new Error("injected init fault after first resource");
    }
    loadVnextProject(projectRoot, loaderOptions(effectiveOptions));
    const provenance = operation.files.find((entry) => entry.path === VNEXT_TEMPLATE_PROVENANCE_PATH);
    if (!provenance) fail("repair_provenance_target_missing", TRANSACTION_NAME, "repair operation has no final provenance target");
    atomicInstallTarget(projectRoot, operation, provenance);
    if (options.testFaultAt === "provenance") throw new Error("injected init fault after provenance");
  }
  const bundle = loadVnextProject(projectRoot, loaderOptions(effectiveOptions));
  const source = readProjectAndProvenance(projectRoot, effectiveOptions.schemasDir);
  if (!source || source.provenance.templateRevision !== operation.targetTemplateRevision) {
    fail("init_operation_verification_failed", VNEXT_TEMPLATE_PROVENANCE_PATH, "installed provenance does not match the pinned transaction");
  }
  operation = updatePhase(projectRoot, operation, "verified");
  if (options.testFaultAt === "verified") throw new Error("injected init fault after verification");
  const files = operation.files.map((entry) => entry.path);
  syncTreeDirectories(join(projectRoot, ".kxm"));
  return { kind: operation.kind, resumed, bundle, files };
}

export function prepareAndApplyVnextCreate(
  projectRoot: string,
  rendered: VnextRenderedTemplate,
  options: VnextRepairRuntimeOptions = {},
): VnextOperationResult {
  assertNoRegisteredGates(options);
  const files = [...rendered.files.entries()].map(([path, bytes]): VnextInitOperationFile => ({
    path,
    observedSha256: null,
    targetSha256: vnextContentSha256(bytes),
    classification: "template-only",
    action: "create",
  }));
  const operation = createOperation(projectRoot, "create", rendered, files, null);
  const prepared = prepareOperation(projectRoot, operation, rendered, options);
  if (options.testFaultAt === "prepared") throw new Error("injected init fault after prepare");
  return applyOperation(projectRoot, prepared, options, false);
}

export function prepareAndApplyVnextRepair(
  plan: VnextTemplateRepairPlan,
  options: VnextRepairRuntimeOptions = {},
): VnextOperationResult {
  assertNoRegisteredGates(options);
  if (!plan.canApply) fail("template_repair_not_applicable", ".kxm", "template repair has conflicts, policy changes, or no safe template-only update");
  const rendered = renderVnextTemplate(plan.projectId, plan.projectName, options.templateVariant ?? CURRENT_VNEXT_TEMPLATE_VARIANT);
  if (rendered.templateRevision !== plan.targetTemplateRevision) fail("template_repair_target_changed", ".kxm", "template target changed after planning");
  const actionable = plan.changes.filter((change) => change.classification === "template-only");
  const provenanceBytes = rendered.files.get(VNEXT_TEMPLATE_PROVENANCE_PATH);
  if (!provenanceBytes) fail("template_provenance_target_missing", VNEXT_TEMPLATE_PROVENANCE_PATH, "renderer did not produce provenance");
  const sourceProvenance = readOptionalManaged(plan.projectRoot, VNEXT_TEMPLATE_PROVENANCE_PATH);
  if (!sourceProvenance) fail("template_provenance_missing", VNEXT_TEMPLATE_PROVENANCE_PATH, "repair requires recorded provenance");
  const files: VnextInitOperationFile[] = actionable.map((change) => ({
    path: change.path,
    observedSha256: change.localSha256 ?? null,
    targetSha256: change.targetSha256 as string,
    classification: "template-only",
    action: change.action,
  }));
  files.push({
    path: VNEXT_TEMPLATE_PROVENANCE_PATH,
    observedSha256: vnextContentSha256(sourceProvenance),
    targetSha256: vnextContentSha256(provenanceBytes),
    classification: "template-only",
    action: "replace",
  });
  const operation = createOperation(plan.projectRoot, "repair", rendered, files, plan.sourceTemplateRevision);
  const prepared = prepareOperation(plan.projectRoot, operation, rendered, options);
  if (options.testFaultAt === "prepared") throw new Error("injected init fault after prepare");
  return applyOperation(plan.projectRoot, prepared, options, false);
}

function rendererForRevision(operation: VnextInitOperation, revision: string): VnextRenderedTemplate | undefined {
  for (const variant of SUPPORTED_VNEXT_TEMPLATE_VARIANTS) {
    const rendered = renderVnextTemplate(operation.projectId, operation.projectName, variant);
    if (rendered.templateRevision === revision) return rendered;
  }
  return undefined;
}

function rendererForOperation(operation: VnextInitOperation): VnextRenderedTemplate | undefined {
  return rendererForRevision(operation, operation.targetTemplateRevision);
}

/** Re-derive every executable operation field from immutable built-in templates. */
function validateOperationIntent(projectRoot: string, operation: VnextInitOperation): void {
  const target = rendererForOperation(operation);
  if (!target) fail("init_transaction_target_unknown", TRANSACTION_NAME, "operation target is not a supported built-in template");
  const entries = new Map(operation.files.map((entry) => [entry.path, entry]));
  if (operation.kind === "create") {
    if (operation.sourceTemplateRevision !== null) {
      fail("init_transaction_create_invalid", TRANSACTION_NAME, "create operation has a source revision");
    }
    if (entries.size !== target.files.size) fail("init_transaction_create_files_invalid", TRANSACTION_NAME, "create operation does not contain the exact built-in target file set");
    for (const [path, bytes] of target.files) {
      const entry = entries.get(path);
      if (!entry
        || entry.observedSha256 !== null
        || entry.targetSha256 !== vnextContentSha256(bytes)
        || entry.classification !== "template-only"
        || entry.action !== "create") {
        fail("init_transaction_create_file_invalid", path, "create operation file does not match its built-in target");
      }
    }
    return;
  }

  if (!operation.sourceTemplateRevision || operation.sourceTemplateRevision === operation.targetTemplateRevision) {
    fail("init_transaction_repair_revision_invalid", TRANSACTION_NAME, "repair operation requires distinct supported source and target revisions");
  }
  const source = rendererForRevision(operation, operation.sourceTemplateRevision);
  if (!source) fail("init_transaction_source_unknown", TRANSACTION_NAME, "operation source is not a supported built-in template");
  const sourceRecords = new Map(source.provenance.files.map((record) => [record.path, record]));
  const targetRecords = new Map(target.provenance.files.map((record) => [record.path, record]));
  if (sourceRecords.size !== targetRecords.size
    || [...sourceRecords.keys()].some((path) => !targetRecords.has(path))) {
    fail("init_transaction_template_shape_changed", TRANSACTION_NAME, "automatic repair cannot add or delete managed template paths");
  }
  const safeChangedPaths: string[] = [];
  for (const [path, base] of sourceRecords) {
    const next = targetRecords.get(path) as typeof base;
    if (base.authoritySha256 !== next.authoritySha256) {
      fail("init_transaction_authority_change", path, "automatic repair operation changes an authority projection");
    }
    if (base.sha256 !== next.sha256) safeChangedPaths.push(path);
  }
  const provenanceEntry = entries.get(VNEXT_TEMPLATE_PROVENANCE_PATH);
  const sourceProvenanceBytes = source.files.get(VNEXT_TEMPLATE_PROVENANCE_PATH) as Buffer;
  const targetProvenanceBytes = target.files.get(VNEXT_TEMPLATE_PROVENANCE_PATH) as Buffer;
  if (!provenanceEntry
    || provenanceEntry.observedSha256 !== vnextContentSha256(sourceProvenanceBytes)
    || provenanceEntry.targetSha256 !== vnextContentSha256(targetProvenanceBytes)
    || provenanceEntry.classification !== "template-only"
    || provenanceEntry.action !== "replace") {
    fail("init_transaction_provenance_intent_invalid", VNEXT_TEMPLATE_PROVENANCE_PATH, "repair provenance action does not match supported source and target templates");
  }
  for (const [path, entry] of entries) {
    if (path === VNEXT_TEMPLATE_PROVENANCE_PATH) continue;
    const base = sourceRecords.get(path);
    const next = targetRecords.get(path);
    if (!base || !next || base.sha256 === next.sha256
      || entry.observedSha256 !== base.sha256
      || entry.targetSha256 !== next.sha256
      || entry.classification !== "template-only"
      || entry.action !== "replace") {
      fail("init_transaction_repair_file_invalid", path, "repair operation file is not a safe built-in template-only replacement");
    }
  }
  for (const path of safeChangedPaths) {
    if (!entries.has(path) && destinationSha(projectRoot, path) !== targetRecords.get(path)?.sha256) {
      fail("init_transaction_repair_file_missing", path, "repair operation omitted a changed file that has not converged to the target");
    }
  }
}

function finishPreparingOperation(
  projectRoot: string,
  operation: VnextInitOperation,
  options: VnextRepairRuntimeOptions,
): VnextInitOperation {
  const rendered = rendererForOperation(operation);
  if (!rendered) fail("init_transaction_renderer_unavailable", TRANSACTION_NAME, "this binary cannot reproduce the pinned pre-application target");
  for (const directory of ["targets", "backups", "shadow"]) {
    rmSync(join(transactionRoot(projectRoot), directory), { recursive: true, force: true });
  }
  for (const entry of operation.files) {
    const bytes = rendered.files.get(entry.path);
    if (!bytes || vnextContentSha256(bytes) !== entry.targetSha256) fail("template_target_unavailable", entry.path, "renderer cannot reproduce the pinned target bytes");
    writeTarget(projectRoot, entry.path, bytes);
  }
  writeKnownBackups(projectRoot, operation);
  verifyTargetArtifacts(projectRoot, operation);
  verifyBackups(projectRoot, operation);
  prepareShadow(projectRoot, operation, options);
  syncTreeDirectories(transactionRoot(projectRoot));
  return updatePhase(projectRoot, operation, "prepared");
}

/** Resume only a validated fixed transaction; filesystem truth wins over its phase hint. */
export function resumeVnextInitTransaction(
  projectRoot: string,
  options: VnextRepairRuntimeOptions = {},
): VnextOperationResult | undefined {
  assertNoRegisteredGates(options);
  let operation = readOperation(projectRoot, options.schemasDir);
  if (!operation) {
    const root = transactionRoot(projectRoot);
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
      syncDirectory(projectRoot);
    }
    return undefined;
  }
  if (operation.phase === "preparing") operation = finishPreparingOperation(projectRoot, operation, options);
  verifyTargetArtifacts(projectRoot, operation);
  return applyOperation(projectRoot, operation, options, true);
}

/** Remove a verified transaction only after associated local binding intent is durable. */
export function commitVnextInitTransaction(projectRoot: string, schemasDir?: string): void {
  const operation = readOperation(projectRoot, schemasDir);
  if (!operation || operation.phase !== "verified") {
    fail("init_transaction_not_verified", TRANSACTION_NAME, "initialization transaction cannot commit before installed state is verified");
  }
  const transaction = transactionRoot(projectRoot);
  const retired = join(projectRoot, `${TRANSACTION_NAME}-cleanup-${operation.operationId}-${randomUUID()}`);
  renameSync(transaction, retired);
  syncDirectory(projectRoot);
  rmSync(retired, { recursive: true, force: true });
  syncDirectory(projectRoot);
}

/** Validate a pending transaction for dry-run reporting without writing or cleanup. */
export function inspectVnextInitTransaction(projectRoot: string, schemasDir?: string): VnextInitOperation | undefined {
  const operation = readOperation(projectRoot, schemasDir);
  if (operation && operation.phase !== "preparing") {
    verifyTargetArtifacts(projectRoot, operation);
    verifyBackups(projectRoot, operation);
  }
  return operation;
}

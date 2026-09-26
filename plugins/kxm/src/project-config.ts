import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import {
  RestrictedYamlError,
  KXM_YAML_LIMITS,
  parseRestrictedYaml as parseRestrictedYamlShared,
  type KxmYamlLimits,
} from "./restricted-yaml.mjs";
import { pathToFileURL } from "node:url";
import { validatePolicyDraft } from "./policy-draft.mjs";
import { resolveKxmTemplateBaseline } from "./template.ts";
import { findKxmRepoRoot } from "./repo-root.ts";
import { BUILTIN_HARNESS_IDS, DEFAULT_HARNESS, validateHarnessModelPair } from "./harness.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type { KxmYamlLimits };
export { KXM_YAML_LIMITS };

export type KxmValidationPhase = "discovery" | "parse" | "schema" | "path" | "reference" | "semantic";

export interface KxmConfigIssue {
  phase: KxmValidationPhase;
  code: string;
  file: string;
  message: string;
}

export class KxmConfigError extends Error {
  readonly issues: readonly KxmConfigIssue[];

  constructor(issues: readonly KxmConfigIssue[]) {
    const sorted = sortIssues(issues);
    super(sorted.map((issue) => `${issue.file}: ${issue.code}: ${issue.message}`).join("\n"));
    this.name = "KxmConfigError";
    this.issues = sorted;
  }
}

export type KxmResourceKind = "project" | "repository" | "agent" | "model" | "role" | "environment" | "workflow" | "gate-registry";

export interface KxmResource {
  kind: KxmResourceKind;
  id?: string;
  file: string;
  logicalPath: string;
  value: JsonObject;
}

export interface KxmProjectBundle {
  projectRoot: string;
  project: KxmResource;
  repositories: ReadonlyMap<string, KxmResource>;
  agents: ReadonlyMap<string, KxmResource>;
  models: ReadonlyMap<string, KxmResource>;
  roles: ReadonlyMap<string, KxmResource>;
  workflows: ReadonlyMap<string, KxmResource>;
  environments: readonly KxmResource[];
  gateRegistry?: KxmResource;
  templateProvenance?: JsonObject;
  resources: readonly KxmResource[];
  configRevision: string;
}

export interface KxmConfigOptions {
  schemasDir?: string;
  repositoryBindings?: Readonly<Record<string, string>>;
  registeredExecutors?: Iterable<string>;
  registeredToolPresets?: Iterable<string>;
  registeredHarnesses?: Iterable<string>;
}

export type KxmInitializationMode = "create" | "legacy" | "repair" | "ready";

export interface KxmInitializationPlan {
  mode: KxmInitializationMode;
  inspectedFrom: string;
  projectRoot?: string;
  legacyRoot?: string;
  changesRequired: boolean;
  issues: readonly KxmConfigIssue[];
  legacyInputs: readonly string[];
  configRevision?: string;
}

function defaultKxmSchemaDir(): string {
  return join(findKxmRepoRoot(import.meta.url), "schemas");
}
const DEFAULT_SCHEMA_DIR = defaultKxmSchemaDir();
const RESOURCE_SCHEMA: Readonly<Record<KxmResourceKind, { identity: string; file: string }>> = Object.freeze({
  project: { identity: "kxm.project.v1", file: "project.schema.json" },
  repository: { identity: "kxm.repository.v1", file: "repository.schema.json" },
  agent: { identity: "kxm.agent.v1", file: "agent.schema.json" },
  model: { identity: "kxm.model.v2", file: "model.schema.json" },
  role: { identity: "kxm.role.v2", file: "role.schema.json" },
  environment: { identity: "kxm.environment.v1", file: "environment.schema.json" },
  workflow: { identity: "kxm.workflow.v1", file: "workflow.schema.json" },
  "gate-registry": { identity: "kxm.gate-registry.v1", file: "gate-registry.schema.json" },
});
const IDENTIFIER = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$)$/i;
const BUILTIN_EXECUTORS = ["local", "ssh", "exe-dev"];
const BUILTIN_TOOL_PRESETS = ["coordinator", "read-only", "workspace-writer", "tests-writer"];
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortIssues(issues: readonly KxmConfigIssue[]): KxmConfigIssue[] {
  return [...issues].sort((left, right) => compareCodeUnits(left.file, right.file)
    || compareCodeUnits(left.phase, right.phase)
    || compareCodeUnits(left.code, right.code)
    || compareCodeUnits(left.message, right.message));
}

function issue(phase: KxmValidationPhase, code: string, file: string, message: string): KxmConfigIssue {
  return { phase, code, file, message };
}

function fail(phase: KxmValidationPhase, code: string, file: string, message: string): never {
  throw new KxmConfigError([issue(phase, code, file, message)]);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse the restricted, JSON-compatible YAML profile used by all KXM configuration. */
export function parseRestrictedYaml(
  input: string | Uint8Array,
  label = "<yaml>",
  limits: Readonly<KxmYamlLimits> = KXM_YAML_LIMITS,
): JsonObject {
  try {
    return parseRestrictedYamlShared(input, label, limits);
  } catch (error) {
    if (error instanceof RestrictedYamlError) throw new KxmConfigError(error.issues);
    throw error;
  }
}

function readJsonObject(file: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

export class KxmSchemaRegistry {
  readonly schemasDir: string;
  readonly ajv: Ajv2020;
  readonly validators = new Map<KxmResourceKind, ValidateFunction>();
  readonly localBindingsValidator: ValidateFunction;
  readonly templateProvenanceValidator: ValidateFunction;
  readonly initOperationValidator: ValidateFunction;
  readonly permissionDiffValidator: ValidateFunction;
  readonly runEventValidator: ValidateFunction;
  readonly driveReceiptValidator: ValidateFunction;
  readonly coordinatorValidator: ValidateFunction;
  readonly intakeMessageValidator: ValidateFunction;
  readonly syncEventValidator: ValidateFunction;

  constructor(schemasDir = DEFAULT_SCHEMA_DIR) {
    this.schemasDir = resolve(schemasDir);
    this.ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    const common = readJsonObject(join(this.schemasDir, "common.schema.json"));
    this.ajv.addSchema(common);
    for (const definition of Object.values(RESOURCE_SCHEMA)) {
      this.ajv.addSchema(readJsonObject(join(this.schemasDir, definition.file)));
    }
    const localBindingsFile = "local-repository-bindings.schema.json";
    const templateProvenanceFile = "template-provenance.schema.json";
    const initOperationFile = "init-operation.schema.json";
    const permissionDiffFile = "permission-diff.schema.json";
    const runEventFile = "run-event.schema.json";
    const driveReceiptFile = "drive-receipt.schema.json";
    const coordinatorFile = "coordinator.schema.json";
    const intakeMessageFile = "intake-message.schema.json";
    const syncEventFile = "sync-event.schema.json";
    this.ajv.addSchema(readJsonObject(join(this.schemasDir, localBindingsFile)));
    this.ajv.addSchema(readJsonObject(join(this.schemasDir, templateProvenanceFile)));
    this.ajv.addSchema(readJsonObject(join(this.schemasDir, initOperationFile)));
    this.ajv.addSchema(readJsonObject(join(this.schemasDir, permissionDiffFile)));
    this.ajv.addSchema(readJsonObject(join(this.schemasDir, runEventFile)));
    this.ajv.addSchema(readJsonObject(join(this.schemasDir, driveReceiptFile)));
    this.ajv.addSchema(readJsonObject(join(this.schemasDir, coordinatorFile)));
    this.ajv.addSchema(readJsonObject(join(this.schemasDir, intakeMessageFile)));
    this.ajv.addSchema(readJsonObject(join(this.schemasDir, syncEventFile)));
    for (const [kind, definition] of Object.entries(RESOURCE_SCHEMA) as [KxmResourceKind, { identity: string; file: string }][]) {
      const validator = this.ajv.getSchema(`https://schemas.kxm.dev/${definition.file}`);
      if (!validator) throw new Error(`schema did not compile: ${definition.file}`);
      this.validators.set(kind, validator);
    }
    const localBindingsValidator = this.ajv.getSchema(`https://schemas.kxm.dev/${localBindingsFile}`);
    const templateProvenanceValidator = this.ajv.getSchema(`https://schemas.kxm.dev/${templateProvenanceFile}`);
    const initOperationValidator = this.ajv.getSchema(`https://schemas.kxm.dev/${initOperationFile}`);
    const permissionDiffValidator = this.ajv.getSchema(`https://schemas.kxm.dev/${permissionDiffFile}`);
    const runEventValidator = this.ajv.getSchema(`https://schemas.kxm.dev/${runEventFile}`);
    const driveReceiptValidator = this.ajv.getSchema(`https://schemas.kxm.dev/${driveReceiptFile}`);
    const coordinatorValidator = this.ajv.getSchema(`https://schemas.kxm.dev/${coordinatorFile}`);
    const intakeMessageValidator = this.ajv.getSchema(`https://schemas.kxm.dev/${intakeMessageFile}`);
    const syncEventValidator = this.ajv.getSchema(`https://schemas.kxm.dev/${syncEventFile}`);
    if (!localBindingsValidator) throw new Error(`schema did not compile: ${localBindingsFile}`);
    if (!templateProvenanceValidator) throw new Error(`schema did not compile: ${templateProvenanceFile}`);
    if (!initOperationValidator) throw new Error(`schema did not compile: ${initOperationFile}`);
    if (!permissionDiffValidator) throw new Error(`schema did not compile: ${permissionDiffFile}`);
    if (!runEventValidator) throw new Error(`schema did not compile: ${runEventFile}`);
    if (!driveReceiptValidator) throw new Error(`schema did not compile: ${driveReceiptFile}`);
    if (!coordinatorValidator) throw new Error(`schema did not compile: ${coordinatorFile}`);
    if (!intakeMessageValidator) throw new Error(`schema did not compile: ${intakeMessageFile}`);
    if (!syncEventValidator) throw new Error(`schema did not compile: ${syncEventFile}`);
    this.localBindingsValidator = localBindingsValidator;
    this.templateProvenanceValidator = templateProvenanceValidator;
    this.initOperationValidator = initOperationValidator;
    this.permissionDiffValidator = permissionDiffValidator;
    this.runEventValidator = runEventValidator;
    this.driveReceiptValidator = driveReceiptValidator;
    this.coordinatorValidator = coordinatorValidator;
    this.intakeMessageValidator = intakeMessageValidator;
    this.syncEventValidator = syncEventValidator;
  }

  validate(kind: KxmResourceKind, value: JsonObject, file: string): KxmConfigIssue[] {
    const definition = RESOURCE_SCHEMA[kind];
    if (value.schema !== definition.identity) {
      return [issue("schema", "schema_identity_mismatch", file, `expected ${definition.identity}, received ${String(value.schema)}`)];
    }
    const validator = this.validators.get(kind);
    if (!validator) throw new Error(`missing KXM validator for ${kind}`);
    if (validator(value)) return [];
    return (validator.errors ?? []).map((error) => schemaIssue(file, error));
  }

  validateLocalBindings(value: JsonObject, file: string): KxmConfigIssue[] {
    return this.validateAuxiliary(value, file, "kxm.local-repository-bindings.v1", this.localBindingsValidator);
  }

  validateTemplateProvenance(value: JsonObject, file: string): KxmConfigIssue[] {
    return this.validateAuxiliary(value, file, "kxm.template-provenance.v1", this.templateProvenanceValidator);
  }

  validateInitOperation(value: JsonObject, file: string): KxmConfigIssue[] {
    return this.validateAuxiliary(value, file, "kxm.init-operation.v1", this.initOperationValidator);
  }

  validatePermissionDiff(value: JsonObject, file: string): KxmConfigIssue[] {
    return this.validateAuxiliary(value, file, "kxm.permission-diff.v1", this.permissionDiffValidator);
  }

  validateDriveReceipt(value: JsonObject, file: string): KxmConfigIssue[] {
    return this.validateAuxiliary(value, file, "kxm.drive-receipt.v1", this.driveReceiptValidator);
  }

  private validateAuxiliary(value: JsonObject, file: string, identity: string, validator: ValidateFunction): KxmConfigIssue[] {
    if (value.schema !== identity) {
      return [issue("schema", "schema_identity_mismatch", file, `expected ${identity}, received ${String(value.schema)}`)];
    }
    if (validator(value)) return [];
    return (validator.errors ?? []).map((error) => schemaIssue(file, error));
  }
}

let cachedRunEventRegistry: KxmSchemaRegistry | undefined;

/** Validate a local run event against `kxm.run-event.v1`. Throws `run_event_invalid`. */
export function validateRunEvent(value: unknown, file: string): void {
  const registry = (cachedRunEventRegistry ??= new KxmSchemaRegistry());
  if (!registry.runEventValidator(value)) {
    throw new KxmConfigError([issue(
      "schema",
      "run_event_invalid",
      file,
      registry.ajv.errorsText(registry.runEventValidator.errors, { separator: "; " }),
    )]);
  }
}

/** Check a derived sync object against `kxm.sync-event.v1`. Returns the
 * schema errors instead of throwing so the transform can fall back to a
 * degraded object and the hub can refuse one event without failing a batch. */
export function syncEventSchemaErrors(value: unknown): string | undefined {
  const registry = (cachedRunEventRegistry ??= new KxmSchemaRegistry());
  if (registry.syncEventValidator(value)) return undefined;
  return registry.ajv.errorsText(registry.syncEventValidator.errors, { separator: "; " });
}

/** Validate a drive receipt against `kxm.drive-receipt.v1`. Throws `drive_receipt_invalid`. */
export function validateDriveReceipt(value: unknown, file: string): void {
  const registry = (cachedRunEventRegistry ??= new KxmSchemaRegistry());
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as JsonObject).schema !== "kxm.drive-receipt.v1") {
    throw new KxmConfigError([issue(
      "schema",
      "drive_receipt_invalid",
      file,
      "expected kxm.drive-receipt.v1",
    )]);
  }
  if (!registry.driveReceiptValidator(value)) {
    throw new KxmConfigError([issue(
      "schema",
      "drive_receipt_invalid",
      file,
      registry.ajv.errorsText(registry.driveReceiptValidator.errors, { separator: "; " }),
    )]);
  }
}

/** Validate a coordinator identity against `kxm.coordinator.v1`. Throws `coordinator_invalid`. */
export function validateCoordinator(value: unknown, file: string): void {
  const registry = (cachedRunEventRegistry ??= new KxmSchemaRegistry());
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as JsonObject).schema !== "kxm.coordinator.v1") {
    throw new KxmConfigError([issue("schema", "coordinator_invalid", file, "expected kxm.coordinator.v1")]);
  }
  if (!registry.coordinatorValidator(value)) {
    throw new KxmConfigError([issue(
      "schema",
      "coordinator_invalid",
      file,
      registry.ajv.errorsText(registry.coordinatorValidator.errors, { separator: "; " }),
    )]);
  }
}

/** Validate an intake message against `kxm.intake-message.v1`. Throws `intake_message_invalid`. */
export function validateIntakeMessage(value: unknown, file: string): void {
  const registry = (cachedRunEventRegistry ??= new KxmSchemaRegistry());
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as JsonObject).schema !== "kxm.intake-message.v1") {
    throw new KxmConfigError([issue("schema", "intake_message_invalid", file, "expected kxm.intake-message.v1")]);
  }
  if (!registry.intakeMessageValidator(value)) {
    throw new KxmConfigError([issue(
      "schema",
      "intake_message_invalid",
      file,
      registry.ajv.errorsText(registry.intakeMessageValidator.errors, { separator: "; " }),
    )]);
  }
}

function schemaIssue(file: string, error: ErrorObject): KxmConfigIssue {
  const location = error.instancePath || "/";
  const suffix = error.params && "additionalProperty" in error.params
    ? ` (${String(error.params.additionalProperty)})`
    : "";
  return issue("schema", `schema_${error.keyword}`, file, `${location} ${error.message ?? "is invalid"}${suffix}`);
}

function canonicalHostPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sameHostPath(left: string, right: string): boolean {
  const resolvedLeft = canonicalHostPath(left);
  const resolvedRight = canonicalHostPath(right);
  return process.platform === "win32"
    ? resolvedLeft.toLocaleLowerCase("en-US") === resolvedRight.toLocaleLowerCase("en-US")
    : resolvedLeft === resolvedRight;
}

function containedHostPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function portableBindingIssue(root: string, pathHint: string, repositoryId: string): KxmConfigIssue | undefined {
  let current = root;
  for (const segment of pathHint === "." ? [] : pathHint.split("/")) {
    current = join(current, segment);
    if (!existsSync(current)) break;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      return issue("path", "repository_binding_path_link", ".kxm/project.yaml", `portable pathHint for ${repositoryId} traverses a symbolic link or junction`);
    }
  }
  const binding = resolve(root, ...pathHint.split("/"));
  if (existsSync(binding)) {
    const realRoot = canonicalHostPath(root);
    const realBinding = canonicalHostPath(binding);
    if (!containedHostPath(realRoot, realBinding)) {
      return issue("path", "repository_binding_outside_project", ".kxm/project.yaml", `portable pathHint for ${repositoryId} resolves outside the authoritative project root`);
    }
  }
  return undefined;
}

/** The portable relative-path rule every project-owned pathHint must satisfy. */
export function kxmPortablePath(path: string): boolean {
  return portablePath(path);
}

function portablePath(path: string): boolean {
  if (path === ".") return true;
  if (path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path) || /[<>:"|?*\u0000-\u001F]/.test(path)) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0
    && segment !== "."
    && segment !== ".."
    && !WINDOWS_RESERVED.test((segment.split(".")[0] ?? segment).replace(/[ .]+$/g, ""))
    && !segment.endsWith(".")
    && !segment.endsWith(" ")
    && !segment.includes(":"));
}

/** The identifier rule every path-derived resource identity must satisfy. */
export function kxmResourceIdentifier(id: string): boolean {
  return id.length <= 64 && IDENTIFIER.test(id) && !WINDOWS_RESERVED.test(id);
}

function resourceIdentifier(id: string): boolean {
  return kxmResourceIdentifier(id);
}

function displayPath(root: string, file: string): string {
  const candidate = relative(root, file).replaceAll("\\", "/");
  return candidate && !candidate.startsWith("../") ? candidate : file.replaceAll("\\", "/");
}

function readResource(
  registry: KxmSchemaRegistry,
  root: string,
  file: string,
  logicalPath: string,
  kind: KxmResourceKind,
  id?: string,
  containmentRoot = root,
): KxmResource {
  const label = displayPath(root, file);
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    fail("discovery", "resource_missing", label, "resource does not exist");
  }
  if (stat.isSymbolicLink()) fail("path", "resource_symlink", label, "configuration resources must not be symbolic links");
  const boundary = resolve(containmentRoot);
  let parent = dirname(file);
  while (parent !== boundary) {
    if (parent === dirname(parent)) fail("path", "resource_outside_project", label, "resource escapes the project root");
    let parentStat;
    try { parentStat = lstatSync(parent); }
    catch { fail("discovery", "resource_parent_missing", label, "resource parent does not exist"); }
    if (parentStat.isSymbolicLink()) fail("path", "resource_parent_symlink", label, "configuration resource parents must not be symbolic links");
    parent = dirname(parent);
  }
  if (!stat.isFile()) fail("path", "resource_not_file", label, "configuration resource must be a regular file");
  return { kind, ...(id === undefined ? {} : { id }), file, logicalPath, value: resourceValue(registry, readFileSync(file), label, kind) };
}

function resourceValue(registry: KxmSchemaRegistry, input: string | Uint8Array, label: string, kind: KxmResourceKind): JsonObject {
  const value = parseRestrictedYaml(input, label);
  const issues = registry.validate(kind, value, label);
  if (issues.length > 0) throw new KxmConfigError(issues);
  return value;
}

function readTemplateProvenance(registry: KxmSchemaRegistry, root: string): JsonObject | undefined {
  const file = join(root, ".kxm", "template-provenance.yaml");
  if (!existsSync(file)) return undefined;
  const label = ".kxm/template-provenance.yaml";
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail("path", "resource_not_file", label, "template provenance must be a regular file, not a link or directory");
  }
  const configRoot = join(root, ".kxm");
  let parent = dirname(file);
  while (parent !== root) {
    const parentStat = lstatSync(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      fail("path", "resource_parent_symlink", label, "template provenance parents must be regular directories");
    }
    if (parent === configRoot) break;
    parent = dirname(parent);
  }
  const value = parseRestrictedYaml(readFileSync(file), label);
  const issues = registry.validateTemplateProvenance(value, label);
  if (issues.length > 0) throw new KxmConfigError(issues);
  if (!resolveKxmTemplateBaseline(value)) {
    fail("semantic", "template_provenance_revision_invalid", label, "template provenance does not exactly match a supported built-in baseline");
  }
  const files = Array.isArray(value.files) ? value.files : [];
  const seen = new Set<string>();
  let prior = "";
  let managedBytes = 0;
  for (const candidate of files) {
    const record = objectValue(candidate);
    const path = record && stringValue(record.path);
    if (!path) continue;
    managedBytes += typeof record.bytes === "number" ? record.bytes : 0;
    const folded = path.toLocaleLowerCase("en-US");
    if (!path.startsWith(".kxm/") || path === label || !portablePath(path)) {
      fail("path", "template_provenance_path_invalid", label, `managed path ${path} is not a portable project-configuration path`);
    }
    if (seen.has(folded)) fail("path", "template_provenance_path_collision", label, `managed path ${path} collides after case folding`);
    if (prior && compareCodeUnits(prior, path) >= 0) fail("semantic", "template_provenance_order_invalid", label, "managed file entries must use strict code-unit order");
    seen.add(folded);
    prior = path;
  }
  if (managedBytes > 8 * 1024 * 1024) {
    fail("parse", "template_provenance_bounds_exceeded", label, "managed template manifest exceeds 8388608 bytes");
  }
  return value;
}

function listNamedResources(
  registry: KxmSchemaRegistry,
  root: string,
  directory: string,
  logicalDirectory: string,
  kind: "agent" | "model" | "role" | "workflow",
  replacedId?: string,
): Map<string, KxmResource> {
  const resources = new Map<string, KxmResource>();
  if (!existsSync(directory)) return resources;
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("path", "resource_directory_invalid", displayPath(root, directory), "resource directory must be a regular directory");
  }
  const issues: KxmConfigIssue[] = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareCodeUnits(left.name, right.name));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      issues.push(issue("path", "nested_resource_directory", displayPath(root, join(directory, entry.name)), "nested resource directories are not allowed"));
      continue;
    }
    if (!entry.name.toLowerCase().endsWith(".yaml") && !entry.name.toLowerCase().endsWith(".yml")) continue;
    if (!entry.isFile() || extname(entry.name) !== ".yaml") {
      issues.push(issue("path", "resource_filename_invalid", displayPath(root, join(directory, entry.name)), "resource must be a regular file with the exact .yaml extension"));
      continue;
    }
    const id = basename(entry.name, ".yaml");
    if (kind === "model" && id === "inventory") continue;
    if (id === replacedId) continue;
    if (!resourceIdentifier(id)) {
      issues.push(issue("path", "resource_id_invalid", displayPath(root, join(directory, entry.name)), `filename-derived identity ${id} is invalid or platform-reserved`));
      continue;
    }
    const collision = [...resources.keys()].find((candidate) => candidate.toLocaleLowerCase("en-US") === id.toLocaleLowerCase("en-US"));
    if (collision) {
      issues.push(issue("path", "resource_id_collision", displayPath(root, join(directory, entry.name)), `${id} case-folds to existing ${collision}`));
      continue;
    }
    try {
      const resource = readResource(registry, root, join(directory, entry.name), `${logicalDirectory}/${id}.yaml`, kind, id);
      resources.set(id, resource);
    } catch (error) {
      if (error instanceof KxmConfigError) issues.push(...error.issues);
      else throw error;
    }
  }
  if (issues.length > 0) throw new KxmConfigError(issues);
  return resources;
}

function valuesOf(object: JsonObject, field: string): JsonValue[] {
  const value = object[field];
  return Array.isArray(value) ? value : [];
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return value !== undefined && isJsonObject(value) ? value : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function names(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((candidate): candidate is string => typeof candidate === "string") : [];
}

function mapResource(resource: KxmResource, map: Map<string, KxmResource>, issues: KxmConfigIssue[]): void {
  const id = resource.id;
  if (!id) return;
  const collision = [...map.keys()].find((candidate) => candidate.toLocaleLowerCase("en-US") === id.toLocaleLowerCase("en-US"));
  if (collision) {
    issues.push(issue("path", "resource_id_collision", resource.logicalPath, `${id} case-folds to existing ${collision}`));
    return;
  }
  map.set(id, resource);
}

function validatePortablePaths(resource: KxmResource, issues: KxmConfigIssue[]): void {
  const candidates: { path: string; label: string }[] = [];
  if (resource.kind === "project") {
    for (const candidate of valuesOf(resource.value, "repositories")) {
      const entry = objectValue(candidate);
      const pathHint = entry && stringValue(entry.pathHint);
      if (pathHint) candidates.push({ path: pathHint, label: "repositories[].pathHint" });
    }
  }
  if (resource.kind === "environment") {
    const path = objectValue(resource.value.path);
    if (path) {
      for (const field of ["prepend", "append"] as const) {
        for (const candidate of names(path[field])) candidates.push({ path: candidate, label: `path.${field}[]` });
      }
    }
  }
  for (const candidate of candidates) {
    if (!portablePath(candidate.path)) {
      issues.push(issue("path", "portable_path_invalid", resource.logicalPath, `${candidate.label} is not a normalized forward-slash relative path: ${candidate.path}`));
    }
  }
}

function selectorCandidates(
  selectorValue: JsonValue | undefined,
  models: ReadonlyMap<string, KxmResource>,
  file: string,
  label: string,
  issues: KxmConfigIssue[],
): KxmResource[] {
  const selector = objectValue(selectorValue);
  if (!selector) return [];
  const profile = stringValue(selector.profile);
  if (profile) {
    const model = models.get(profile);
    if (!model) issues.push(issue("reference", "model_profile_unknown", file, `${label} references unknown model profile ${profile}`));
    return model ? [model] : [];
  }
  const tag = stringValue(selector.tag);
  if (!tag) return [];
  const capabilities = new Set(names(selector.capabilities));
  const candidates = [...models.values()].filter((model) => names(model.value.tags).includes(tag)
    && [...capabilities].every((capability) => names(model.value.capabilities).includes(capability)));
  if (candidates.length === 0) issues.push(issue("reference", "model_tag_unresolved", file, `${label} selector tag ${tag} has no matching profile`));
  return candidates;
}

interface ModelCandidate {
  key: string;
  profile?: string;
  provider?: string;
  model?: string;
}

function modelCandidates(selectorValue: JsonValue | undefined, models: ReadonlyMap<string, KxmResource>): ModelCandidate[] {
  const selector = objectValue(selectorValue);
  if (!selector) return [];
  const profile = stringValue(selector.profile);
  if (profile) {
    const resource = models.get(profile);
    if (!resource) return [];
    return [{
      key: `profile:${profile}`,
      profile,
      ...(stringValue(resource.value.provider) || stringValue(resource.value.vendor) ? { provider: (stringValue(resource.value.provider) ?? stringValue(resource.value.vendor))! } : {}),
      ...(stringValue(resource.value.model) ? { model: stringValue(resource.value.model)! } : {}),
    }];
  }
  const tag = stringValue(selector.tag);
  if (tag) {
    const capabilities = new Set(names(selector.capabilities));
    return [...models.values()]
      .filter((resource) => names(resource.value.tags).includes(tag)
        && [...capabilities].every((capability) => names(resource.value.capabilities).includes(capability)))
      .map((resource) => ({
        key: `profile:${resource.id ?? "unknown"}`,
        ...(resource.id ? { profile: resource.id } : {}),
        ...(stringValue(resource.value.provider) || stringValue(resource.value.vendor) ? { provider: (stringValue(resource.value.provider) ?? stringValue(resource.value.vendor))! } : {}),
        ...(stringValue(resource.value.model) ? { model: stringValue(resource.value.model)! } : {}),
      }));
  }
  const provider = stringValue(selector.provider);
  const model = stringValue(selector.model);
  return provider && model ? [{ key: `direct:${provider}/${model}`, provider, model }] : [];
}

function compatibleModel(left: ModelCandidate, right: ModelCandidate): boolean {
  if (left.profile && right.profile) return left.profile === right.profile;
  return left.provider === right.provider && left.model === right.model;
}

function diversityCandidates(
  stepSelector: JsonValue | undefined,
  allowedAgents: readonly string[],
  agents: ReadonlyMap<string, KxmResource>,
  models: ReadonlyMap<string, KxmResource>,
): ModelCandidate[] {
  const stepCandidates = modelCandidates(stepSelector, models);
  const resolved: ModelCandidate[] = [];
  for (const agentId of allowedAgents) {
    const agentSelector = agents.get(agentId)?.value.model;
    const agentCandidates = modelCandidates(agentSelector, models);
    if (stepSelector === undefined) resolved.push(...agentCandidates);
    else if (agentSelector === undefined) resolved.push(...stepCandidates);
    else resolved.push(...stepCandidates.filter((candidate) => agentCandidates.some((allowed) => compatibleModel(candidate, allowed))));
  }
  if (allowedAgents.length === 0) resolved.push(...stepCandidates);
  return [...new Map(resolved.map((candidate) => [candidate.key, candidate])).values()];
}

function validateEnvironment(resource: KxmResource, issues: KxmConfigIssue[]): void {
  const values = objectValue(resource.value.values) ?? {};
  const secretNames = new Set<string>();
  for (const candidate of valuesOf(resource.value, "secrets")) {
    const secret = objectValue(candidate);
    const name = secret && stringValue(secret.name);
    if (!name) continue;
    if (secretNames.has(name)) issues.push(issue("semantic", "secret_name_duplicate", resource.logicalPath, `secret environment name ${name} is duplicated`));
    secretNames.add(name);
    if (Object.hasOwn(values, name)) issues.push(issue("semantic", "environment_name_conflict", resource.logicalPath, `${name} appears in both values and secrets`));
  }
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string" && SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      issues.push(issue("semantic", "probable_secret_value", resource.logicalPath, `${name} resembles a credential and must be represented by secrets[].ref`));
    }
  }
}

function accessRank(value: JsonValue | undefined): number {
  return value === "write" ? 2 : value === "read" ? 1 : 0;
}

function validateToolScope(agent: KxmResource, step: JsonObject, file: string, stepId: string, issues: KxmConfigIssue[]): void {
  const requested = objectValue(step.tools);
  if (!requested) return;
  const ceiling = objectValue(agent.value.tools);
  if (!ceiling) {
    issues.push(issue("semantic", "tool_scope_expansion", file, `${stepId} requests tools but agent ${agent.id ?? "unknown"} declares no tool ceiling`));
    return;
  }
  const requestedPreset = stringValue(requested.preset);
  const ceilingPreset = stringValue(ceiling.preset);
  if (requestedPreset !== ceilingPreset) {
    issues.push(issue("semantic", "tool_scope_expansion", file, `${stepId} tool preset ${String(requestedPreset)} does not preserve agent ${agent.id ?? "unknown"} preset ${String(ceilingPreset)}`));
  }
  const allowed = new Set(names(ceiling.allow));
  const denied = new Set(names(ceiling.deny));
  for (const tool of names(requested.allow)) {
    if (!allowed.has(tool) || denied.has(tool)) issues.push(issue("semantic", "tool_scope_expansion", file, `${stepId} requests tool ${tool} beyond agent ${agent.id ?? "unknown"} explicit allowlist`));
  }
  const requestedDenied = new Set(names(requested.deny));
  for (const tool of denied) {
    if (!requestedDenied.has(tool)) issues.push(issue("semantic", "tool_scope_expansion", file, `${stepId} drops agent ${agent.id ?? "unknown"} denial for ${tool}`));
  }
}

function validateToolPolicy(resource: KxmResource, policy: JsonObject | undefined, label: string, issues: KxmConfigIssue[]): void {
  if (!policy) return;
  const allowed = new Set(names(policy.allow));
  for (const tool of names(policy.deny)) {
    if (allowed.has(tool)) issues.push(issue("semantic", "tool_policy_contradiction", resource.logicalPath, `${label} both allows and denies ${tool}`));
  }
}

/** Validate an in-memory resource set with the same semantic rules as a loaded project. */
export function validateKxmResources(
  resources: ReadonlyMap<string, { kind: KxmResourceKind; id?: string; value: JsonObject }>,
  options: KxmConfigOptions = {},
): KxmConfigIssue[] {
  const make = (logicalPath: string, kind: KxmResourceKind, id: string | undefined, value: JsonObject): KxmResource => ({
    kind,
    ...(id === undefined ? {} : { id }),
    file: logicalPath,
    logicalPath,
    value,
  });
  assertNoRegisteredGates(options);
  let gateRegistry: KxmResource | undefined;
  let project: KxmResource | undefined;
  const repositories = new Map<string, KxmResource>();
  const agents = new Map<string, KxmResource>();
  const models = new Map<string, KxmResource>();
  const workflows = new Map<string, KxmResource>();
  const environments: KxmResource[] = [];
  for (const [logicalPath, resource] of resources) {
    const made = make(logicalPath, resource.kind, resource.id, resource.value);
    if (resource.kind === "project") project = made;
    else if (resource.kind === "repository" && resource.id) repositories.set(resource.id, made);
    else if (resource.kind === "agent" && resource.id) agents.set(resource.id, made);
    else if (resource.kind === "model" && resource.id) models.set(resource.id, made);
    else if (resource.kind === "workflow" && resource.id) workflows.set(resource.id, made);
    else if (resource.kind === "environment") environments.push(made);
    else if (resource.kind === "gate-registry") gateRegistry = made;
  }
  if (!project) return [issue("discovery", "project_definition_missing", ".kxm/project.yaml", "resource set has no project definition")];
  return validateBundle(project, repositories, agents, models, workflows, environments, options, gateRegistry);
}

function validateAgentScope(
  agent: KxmResource,
  step: JsonObject,
  repositories: ReadonlySet<string>,
  file: string,
  stepId: string,
  issues: KxmConfigIssue[],
): void {
  validateToolScope(agent, step, file, stepId, issues);
  const agentRepositories = objectValue(agent.value.repositories) ?? {};
  const defaultAccess = agent.value.defaultRepositoryAccess;
  for (const [repositoryId, requested] of Object.entries(objectValue(step.repositories) ?? {})) {
    if (!repositories.has(repositoryId)) continue;
    const ceiling = agentRepositories[repositoryId] ?? defaultAccess ?? "none";
    if (accessRank(requested) > accessRank(ceiling)) {
      issues.push(issue("semantic", "repository_scope_expansion", file, `${stepId} requests ${String(requested)} access to ${repositoryId} beyond agent ${agent.id ?? "unknown"} ceiling ${String(ceiling)}`));
    }
  }
  const grants = new Set(valuesOf(agent.value, "secrets").map((candidate) => objectValue(candidate)).filter((candidate): candidate is JsonObject => Boolean(candidate)).map((candidate) => stringValue(candidate.ref)).filter((candidate): candidate is string => Boolean(candidate)));
  for (const candidate of valuesOf(step, "secrets")) {
    const reference = stringValue(objectValue(candidate)?.ref);
    if (reference && !grants.has(reference)) {
      issues.push(issue("semantic", "secret_scope_expansion", file, `${stepId} requests secret ${reference} beyond agent ${agent.id ?? "unknown"} ceiling`));
    }
  }
}

/** The outcomes a gate step settles on, by `expect` (computeGateEvidenceOutcome
 * in runtime-store.ts): nothing else ever reaches a gate step's `on` map. */
const GATE_STEP_OUTCOMES = {
  pass: ["passed", "implementation-failure"],
  fail: ["passed", "repro-missing"],
} as const satisfies Record<"pass" | "fail", readonly string[]>;

/** A gate step that routes on an outcome it never produces (such as `failed`)
 * instead of one it does can never settle: the Runtime records the produced
 * outcome, finds no transition for it, and leaves the attempt unsettled. An
 * extra dead key next to every produced outcome still settles, and the built-in
 * template has always declared `failed` beside `implementation-failure`, so only
 * the combination is refused. Misspellings are gate_outcome_renamed's. */
function gateOutcomeImpossible(step: JsonObject, stepId: string, file: string): KxmConfigIssue | undefined {
  const expect = step.expect === "fail" ? "fail" : "pass";
  const produced: readonly string[] = GATE_STEP_OUTCOMES[expect];
  const declared = Object.keys(objectValue(step.on) ?? {});
  const impossible = declared.filter((outcome) => !produced.includes(outcome) && outcome !== "implementation_failure" && outcome !== "repro_missing");
  const missing = produced.filter((outcome) => !declared.includes(outcome));
  if (impossible.length === 0 || missing.length === 0) return undefined;
  return issue("semantic", "gate_outcome_impossible", file, `${stepId} declares ${impossible.join(", ")}, which a gate step with expect ${expect} never produces; it settles on ${produced.join(" or ")}, so declare ${missing.join(" and ")}`);
}

function transition(value: JsonValue): { target?: string; maxTransitions?: number; terminalStatus?: string } {
  if (typeof value === "string") return { target: value };
  const object = objectValue(value);
  const target = stringValue(object?.target);
  const terminalStatus = stringValue(object?.terminalStatus);
  return {
    ...(target === undefined ? {} : { target }),
    ...(typeof object?.maxTransitions === "number" ? { maxTransitions: object.maxTransitions } : {}),
    ...(terminalStatus === undefined ? {} : { terminalStatus }),
  };
}

function validateWorkflow(
  workflow: KxmResource,
  agents: ReadonlyMap<string, KxmResource>,
  models: ReadonlyMap<string, KxmResource>,
  repositories: ReadonlySet<string>,
  gates: ReadonlySet<string> | undefined,
  issues: KxmConfigIssue[],
): void {
  const file = workflow.logicalPath;
  const coordinator = stringValue(workflow.value.coordinator) ?? "coordinator";
  if (!agents.has(coordinator)) issues.push(issue("reference", "coordinator_unknown", file, `coordinator ${coordinator} does not exist`));
  const steps = valuesOf(workflow.value, "steps").map((candidate) => objectValue(candidate)).filter((candidate): candidate is JsonObject => Boolean(candidate));
  const stepIndex = new Map<string, number>();
  for (const [index, step] of steps.entries()) {
    const id = stringValue(step.id);
    if (!id) continue;
    if (stepIndex.has(id)) issues.push(issue("semantic", "step_id_duplicate", file, `step ${id} is duplicated`));
    else stepIndex.set(id, index);
  }

  for (const field of ["reproOracle", "planHash"] as const) {
    const oracle = objectValue(workflow.value[field]);
    if (!oracle) continue;
    const stageId = stringValue(oracle.stageId);
    const evidenceKey = stringValue(oracle.evidenceKey);
    const index = stageId === undefined ? undefined : stepIndex.get(stageId);
    if (index === undefined) {
      issues.push(issue("reference", "oracle_stage_unknown", file, `${field} references unknown stage ${String(stageId)}`));
      continue;
    }
    const evidence = new Set(valuesOf(steps[index] ?? {}, "requiredEvidence").map((candidate) => stringValue(objectValue(candidate)?.key)).filter((candidate): candidate is string => Boolean(candidate)));
    if (!evidenceKey || !evidence.has(evidenceKey)) issues.push(issue("reference", "oracle_evidence_unknown", file, `${field} references undeclared evidence ${String(evidenceKey)} in ${stageId}`));
  }
  const planStages = new Set(names(workflow.value.requirePlanHash));
  if (planStages.size > 0 && !objectValue(workflow.value.planHash)) issues.push(issue("semantic", "plan_hash_missing", file, "requirePlanHash requires planHash"));
  for (const stageId of planStages) {
    if (!stepIndex.has(stageId)) issues.push(issue("reference", "plan_hash_stage_unknown", file, `requirePlanHash references unknown stage ${stageId}`));
  }

  const adjacency = steps.map(() => new Set<number>());
  const terminalReachable = new Set<number>();
  const completedTerminalSources = new Set<number>();
  let hasBackEdge = false;
  for (const [index, step] of steps.entries()) {
    const stepId = stringValue(step.id) ?? `step-${index}`;
    const kind = stringValue(step.kind);
    validateToolPolicy(workflow, objectValue(step.tools), `${stepId}.tools`, issues);
    const primaryAgentId = stringValue(step.agent);
    if ((kind === "agent" || kind === "moa") && primaryAgentId && !agents.has(primaryAgentId)) {
      issues.push(issue("reference", "agent_unknown", file, `${stepId} references unknown agent ${primaryAgentId}`));
    }
    const gate = stringValue(step.gate);
    if (kind === "gate" && gate) {
      if (!gates) issues.push(issue("reference", "gate_registry_missing", file, `${stepId} requires .kxm/gates.yaml`));
      else if (!gates.has(gate)) issues.push(issue("reference", "gate_unknown", file, `${stepId} references unregistered gate ${gate}`));
    }
    if (step.expect !== undefined && (kind !== "gate" || !["pass", "fail"].includes(String(step.expect)))) {
      issues.push(issue("semantic", "gate_expect_invalid", file, `${stepId} expect is gate-only pass or fail`));
    }
    if (kind === "gate" && Object.keys(objectValue(step.on) ?? {}).some((outcome) => outcome === "implementation_failure" || outcome === "repro_missing")) {
      issues.push(issue("semantic", "gate_outcome_renamed", file, `${stepId} must use implementation-failure and repro-missing`));
    }
    const impossibleOutcome = kind === "gate" ? gateOutcomeImpossible(step, stepId, file) : undefined;
    if (impossibleOutcome) issues.push(impossibleOutcome);
    for (const repositoryId of Object.keys(objectValue(step.repositories) ?? {})) {
      if (!repositories.has(repositoryId)) issues.push(issue("reference", "repository_unknown", file, `${stepId} references unknown repository ${repositoryId}`));
    }
    selectorCandidates(step.model, models, file, `${stepId}.model`, issues);

    const assignment = objectValue(step.assignments);
    const declaredAgents = assignment ? names(assignment.allowedAgents) : [];
    const allowedAgents = declaredAgents.length > 0 ? declaredAgents : primaryAgentId ? [primaryAgentId] : [];
    for (const agentId of allowedAgents) {
      const agent = agents.get(agentId);
      if (!agent) issues.push(issue("reference", "assignment_agent_unknown", file, `${stepId} allows unknown agent ${agentId}`));
      else {
        validateAgentScope(agent, step, repositories, file, stepId, issues);
        if (step.model !== undefined && agent.value.model !== undefined) {
          const requestedModels = modelCandidates(step.model, models);
          const ceilingModels = modelCandidates(agent.value.model, models);
          const effectiveModels = requestedModels.filter((requested) => ceilingModels.some((ceiling) => compatibleModel(requested, ceiling)));
          // A workflow selector is always intersected with the selected
          // agent's model ceiling; it never replaces that ceiling. Reject an
          // empty intersection now so dispatch cannot fall back to the raw,
          // broader selector later.
          if (requestedModels.length > 0 && effectiveModels.length === 0) {
            issues.push(issue("semantic", "model_selector_incompatible", file, `${stepId} model selector has no candidate within agent ${agentId} ceiling`));
          }
        }
      }
    }
    if (primaryAgentId && allowedAgents.length > 0 && !allowedAgents.includes(primaryAgentId)) {
      issues.push(issue("semantic", "primary_agent_ineligible", file, `${stepId} primary agent ${primaryAgentId} is not in allowedAgents`));
    }

    const minimum = numberValue(assignment?.minimum, 1);
    const target = numberValue(assignment?.target, minimum);
    const maximum = numberValue(assignment?.maximum, target);
    const maxParallel = numberValue(assignment?.maxParallel, maximum);
    if (!(minimum <= target && target <= maximum)) issues.push(issue("semantic", "assignment_bounds_invalid", file, `${stepId} must satisfy minimum <= target <= maximum`));
    if (maxParallel > maximum) issues.push(issue("semantic", "assignment_parallelism_invalid", file, `${stepId} maxParallel exceeds maximum`));
    if (assignment && allowedAgents.length > 0 && maximum > allowedAgents.length && kind === "moa") {
      issues.push(issue("semantic", "assignment_pool_too_small", file, `${stepId} maximum ${maximum} exceeds ${allowedAgents.length} eligible agents`));
    }
    const maxWriteRepositories = assignment && typeof assignment.maxWriteRepositories === "number" ? assignment.maxWriteRepositories : undefined;
    if (maxWriteRepositories !== undefined) {
      const writable = Object.values(objectValue(step.repositories) ?? {}).filter((access) => access === "write").length;
      if (maxWriteRepositories > writable) issues.push(issue("semantic", "write_repository_bound_invalid", file, `${stepId} maxWriteRepositories exceeds writable repository scope`));
    }

    const join = objectValue(step.join);
    const minimumPassed = join && typeof join.minimumPassed === "number" ? join.minimumPassed : undefined;
    if (minimumPassed !== undefined && minimumPassed > maximum) issues.push(issue("semantic", "join_impossible", file, `${stepId} minimumPassed exceeds assignment maximum`));

    const distinctBy = names(assignment?.distinctBy);
    if (distinctBy.length > 0) {
      const candidates = diversityCandidates(step.model, allowedAgents, agents, models);
      for (const dimension of distinctBy) {
        const distinct = new Set(candidates.map((candidate) => candidate[dimension as "profile" | "provider" | "model"]).filter((value): value is string => Boolean(value)));
        if (distinct.size < target) issues.push(issue("semantic", "model_diversity_impossible", file, `${stepId} requires ${target} distinct ${dimension} values but resolves ${distinct.size}`));
      }
    }

    const evidenceKeys = new Set<string>();
    for (const candidate of valuesOf(step, "requiredEvidence")) {
      const requirement = objectValue(candidate);
      if (!requirement) continue;
      const key = stringValue(requirement.key);
      if (key) {
        if (evidenceKeys.has(key)) issues.push(issue("semantic", "evidence_key_duplicate", file, `${stepId} evidence key ${key} is duplicated`));
        evidenceKeys.add(key);
      }
      const policy = objectValue(requirement.producerPolicy);
      if (!policy) continue;
      const eligible = names(policy.eligibleAgents);
      const producerMinimum = numberValue(policy.minimumProducers, 1);
      if (producerMinimum > target || producerMinimum > eligible.length) issues.push(issue("semantic", "producer_minimum_impossible", file, `${stepId}.${String(key)} producer minimum exceeds its eligible or target pool`));
      for (const agentId of eligible) {
        if (!agents.has(agentId)) issues.push(issue("reference", "producer_agent_unknown", file, `${stepId}.${String(key)} references unknown producer ${agentId}`));
        if (allowedAgents.length > 0 && !allowedAgents.includes(agentId)) issues.push(issue("semantic", "producer_agent_ineligible", file, `${stepId}.${String(key)} producer ${agentId} is outside allowedAgents`));
      }
      const degradation = objectValue(policy.degradation);
      if (degradation && numberValue(degradation.minimumProducers, 1) >= producerMinimum) issues.push(issue("semantic", "producer_degradation_invalid", file, `${stepId}.${String(key)} degradation must lower minimumProducers`));
    }

    const writes = Object.values(objectValue(step.repositories) ?? {}).some((access) => access === "write");
    const planHashStage = stringValue(objectValue(workflow.value.planHash)?.stageId);
    const planHashIndex = planHashStage === undefined ? undefined : stepIndex.get(planHashStage);
    if (writes && planHashIndex !== undefined && index > planHashIndex && !planStages.has(stepId)) {
      issues.push(issue("semantic", "mutation_missing_plan_hash", file, `${stepId} mutates after the approved-plan stage but is absent from requirePlanHash`));
    }

    const outcomes = objectValue(step.on) ?? {};
    if (Object.keys(outcomes).length === 0) issues.push(issue("semantic", "step_transitions_missing", file, `${stepId} has no declared transitions`));
    for (const [outcome, rawTransition] of Object.entries(outcomes)) {
      const parsed = transition(rawTransition);
      if (parsed.target === "$terminal") {
        terminalReachable.add(index);
        if (parsed.terminalStatus === "completed") completedTerminalSources.add(index);
        continue;
      }
      const targetIndex = parsed.target === undefined ? undefined : stepIndex.get(parsed.target);
      if (targetIndex === undefined) {
        issues.push(issue("reference", "transition_target_unknown", file, `${stepId}.${outcome} references unknown target ${String(parsed.target)}`));
        continue;
      }
      adjacency[index]?.add(targetIndex);
      if (targetIndex <= index) {
        hasBackEdge = true;
        if (parsed.maxTransitions === undefined) issues.push(issue("semantic", "back_edge_unbounded", file, `${stepId}.${outcome} back-edge requires maxTransitions`));
      }
    }
  }

  if (hasBackEdge && typeof objectValue(workflow.value.limits)?.maxTransitions !== "number") {
    issues.push(issue("semantic", "workflow_cycle_unbounded", file, "workflow with back-edges requires limits.maxTransitions"));
  }

  const readyIndex = stepIndex.get("ready");
  const verifyIndex = stepIndex.get("verify");
  if (readyIndex !== undefined && verifyIndex !== undefined) {
    const verifyTargets = adjacency[verifyIndex] ?? new Set();
    if (!verifyTargets.has(readyIndex)) {
      issues.push(issue("semantic", "verify_must_precede_ready", file, "verify must transition to ready"));
    }
    for (const [srcIndex, targets] of adjacency.entries()) {
      if (targets.has(readyIndex) && srcIndex !== verifyIndex) {
        issues.push(issue("semantic", "verify_must_precede_ready", file, `step ${String(steps[srcIndex]?.id)} transitions to ready bypassing verify`));
      }
    }
  }
  if (steps.length > 0) {
    const reachable = new Set<number>([0]);
    const queue = [0];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      for (const target of adjacency[current] ?? []) if (!reachable.has(target)) { reachable.add(target); queue.push(target); }
    }
    for (const [index, step] of steps.entries()) if (!reachable.has(index)) issues.push(issue("semantic", "step_unreachable", file, `step ${String(step.id)} is unreachable from the first step`));

    for (const [requiredIndex, requiredStep] of steps.entries()) {
      if (requiredStep.kind !== "gate" && requiredStep.kind !== "approval") continue;
      const reachableWithoutRequired = new Set<number>();
      const queueWithoutRequired = requiredIndex === 0 ? [] : [0];
      if (requiredIndex !== 0) reachableWithoutRequired.add(0);
      while (queueWithoutRequired.length > 0) {
        const current = queueWithoutRequired.shift();
        if (current === undefined) break;
        for (const target of adjacency[current] ?? []) {
          if (target === requiredIndex || reachableWithoutRequired.has(target)) continue;
          reachableWithoutRequired.add(target);
          queueWithoutRequired.push(target);
        }
      }
      if ([...completedTerminalSources].some((source) => source !== requiredIndex && reachableWithoutRequired.has(source))) {
        issues.push(issue("semantic", "required_step_bypass", file, `a completed path can bypass required ${String(requiredStep.id)}`));
      }
    }

    const canTerminate = new Set(terminalReachable);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [index, targets] of adjacency.entries()) {
        if (!canTerminate.has(index) && [...targets].some((target) => canTerminate.has(target))) { canTerminate.add(index); changed = true; }
      }
    }
    for (const index of reachable) if (!canTerminate.has(index)) issues.push(issue("semantic", "step_cannot_terminate", file, `step ${String(steps[index]?.id)} has no path to a terminal transition`));
  }
}

function validateModelReferences(models: ReadonlyMap<string, KxmResource>, issues: KxmConfigIssue[]): void {
  for (const model of models.values()) {
    for (const [index, fallback] of valuesOf(model.value, "fallbacks").entries()) {
      selectorCandidates(fallback, models, model.logicalPath, `fallbacks[${index}]`, issues);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string, path: string[]): void => {
    if (visiting.has(id)) {
      issues.push(issue("semantic", "model_fallback_cycle", models.get(id)?.logicalPath ?? ".kxm/models", `fallback profile cycle: ${[...path, id].join(" -> ")}`));
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const model = models.get(id);
    if (model) {
      for (const fallback of valuesOf(model.value, "fallbacks")) {
        const profile = stringValue(objectValue(fallback)?.profile);
        if (profile && models.has(profile)) walk(profile, [...path, id]);
      }
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of models.keys()) walk(id, []);
}

function validateBundle(
  project: KxmResource,
  repositories: ReadonlyMap<string, KxmResource>,
  agents: ReadonlyMap<string, KxmResource>,
  models: ReadonlyMap<string, KxmResource>,
  workflows: ReadonlyMap<string, KxmResource>,
  environments: readonly KxmResource[],
  options: KxmConfigOptions,
  gateRegistry?: KxmResource,
  projectRoot?: string,
): KxmConfigIssue[] {
  const issues: KxmConfigIssue[] = [];
  const entries = valuesOf(project.value, "repositories").map((candidate) => objectValue(candidate)).filter((candidate): candidate is JsonObject => Boolean(candidate));
  const repositoryIds = new Set<string>();
  const foldedRepositories = new Map<string, string>();
  let controls = 0;
  for (const entry of entries) {
    const id = stringValue(entry.id);
    if (!id) continue;
    const folded = id.toLocaleLowerCase("en-US");
    const previous = foldedRepositories.get(folded);
    if (previous) issues.push(issue("path", "repository_id_collision", project.logicalPath, `${id} case-folds to existing ${previous}`));
    else foldedRepositories.set(folded, id);
    repositoryIds.add(id);
    if (entry.role === "control") controls += 1;
  }
  if (controls !== 1) issues.push(issue("semantic", "control_repository_count", project.logicalPath, `expected exactly one control repository, received ${controls}`));
  for (const repository of repositories.values()) {
    if (repository.value.projectId !== project.value.id) issues.push(issue("reference", "repository_project_mismatch", repository.logicalPath, "projectId does not match the authoritative project"));
    const id = stringValue(repository.value.repositoryId);
    if (!id || !repositoryIds.has(id)) issues.push(issue("reference", "repository_definition_unknown", repository.logicalPath, `repositoryId ${String(id)} is not bound by project.yaml`));
    if (repository.id !== id) issues.push(issue("reference", "repository_binding_identity_mismatch", repository.logicalPath, `binding ${String(repository.id)} declares repositoryId ${String(id)}`));
  }
  for (const resource of [project, ...environments]) validatePortablePaths(resource, issues);
  for (const environment of environments) validateEnvironment(environment, issues);

  const executors = new Set(options.registeredExecutors ?? BUILTIN_EXECUTORS);
  const gates = gateRegistry ? new Set(Object.keys(objectValue(gateRegistry.value.gates) ?? {})) : undefined;
  for (const [id, value] of Object.entries(objectValue(gateRegistry?.value.gates) ?? {})) {
    const definition = objectValue(value);
    const executable = Array.isArray(definition?.argv) ? definition.argv[0] : undefined;
    if (definition?.kind === "command" && typeof executable === "string" &&
        (executable === "." || executable === ".." || executable.includes("\\") || (!executable.startsWith("/") && executable.includes("/")))) {
      issues.push(issue("semantic", "gate_executable_invalid", ".kxm/gates.yaml", `${id} argv[0] must be a bare executable or absolute POSIX path`));
    }
  }
  const presets = new Set(options.registeredToolPresets ?? BUILTIN_TOOL_PRESETS);
  const harnesses = new Set(options.registeredHarnesses ?? BUILTIN_HARNESS_IDS);
  const defaultExecutor = stringValue(project.value.defaultExecutor);
  if (defaultExecutor && !executors.has(defaultExecutor)) issues.push(issue("reference", "executor_unknown", project.logicalPath, `defaultExecutor ${defaultExecutor} is not registered`));
  const defaultHarness = stringValue(project.value.defaultHarness) ?? DEFAULT_HARNESS;
  if (!harnesses.has(defaultHarness)) issues.push(issue("reference", "harness_unknown", project.logicalPath, `defaultHarness ${defaultHarness} is not registered`));

  for (const agent of agents.values()) {
    validateToolPolicy(agent, objectValue(agent.value.tools), "tools", issues);
    const executor = stringValue(agent.value.executor);
    if (executor && !executors.has(executor)) issues.push(issue("reference", "executor_unknown", agent.logicalPath, `executor ${executor} is not registered`));
    const harness = stringValue(agent.value.harness) ?? defaultHarness;
    if (!harnesses.has(harness)) issues.push(issue("reference", "harness_unknown", agent.logicalPath, `harness ${harness} is not registered`));
    const preset = stringValue(objectValue(agent.value.tools)?.preset);
    if (preset && !presets.has(preset)) issues.push(issue("reference", "tool_preset_unknown", agent.logicalPath, `tool preset ${preset} is not registered`));
    for (const repositoryId of Object.keys(objectValue(agent.value.repositories) ?? {})) {
      if (!repositoryIds.has(repositoryId)) issues.push(issue("reference", "repository_unknown", agent.logicalPath, `references unknown repository ${repositoryId}`));
    }
    const candidates = selectorCandidates(agent.value.model, models, agent.logicalPath, "model", issues);
    const declaredHarness = stringValue(agent.value.harness);
    if (declaredHarness && harnesses.has(declaredHarness)) {
      for (const candidate of candidates) {
        const candidateProvider = stringValue(candidate.value.provider);
        const candidateModel = stringValue(candidate.value.model);
        const validation = validateHarnessModelPair(declaredHarness, { provider: candidateProvider, model: candidateModel });
        if (!validation.valid) {
          issues.push(issue("semantic", validation.issue ?? "harness_unhosted_model", agent.logicalPath, validation.message ?? `harness ${declaredHarness} cannot host model ${candidateModel ?? candidate.logicalPath}`));
        }
      }
    }
  }
  validateModelReferences(models, issues);

  const defaultWorkflow = stringValue(project.value.defaultWorkflow) ?? "default";
  if (!workflows.has(defaultWorkflow)) issues.push(issue("reference", "default_workflow_unknown", project.logicalPath, `default workflow ${defaultWorkflow} does not exist`));
  for (const workflow of workflows.values()) validateWorkflow(workflow, agents, models, repositoryIds, gates, issues);

  // Developer policy is the role files under .kxm/roles/ (with the model
  // files they name). scripts/harness-run.mjs only supplies ceilings.
  if (projectRoot && existsSync(join(projectRoot, ".kxm", "roles"))) {
    issues.push(...developerRolePolicyIssues(projectRoot));
  }

  return sortIssues(issues);
}

function developerCeilings(): {
  ok: true;
  ROUTES: Record<string, { provider: string; permissions: readonly string[]; models?: readonly string[]; roles?: readonly string[]; efforts?: readonly string[] }>;
  NATIVE_PI_BRAKE_PROVIDERS: string[];
  PI_ALLOWED_PROVIDERS: string[];
  PI_NATIVE_VENDOR_PROVIDERS: Record<string, string>;
} | { ok: false; detail: string } {
  const script = join(findKxmRepoRoot(import.meta.url), "scripts", "harness-run.mjs");
  let loaded;
  try {
    loaded = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(pathToFileURL(script).href)}); process.stdout.write(JSON.stringify({ROUTES:m.ROUTES,NATIVE_PI_BRAKE_PROVIDERS:m.NATIVE_PI_BRAKE_PROVIDERS,PI_ALLOWED_PROVIDERS:m.PI_ALLOWED_PROVIDERS,PI_NATIVE_VENDOR_PROVIDERS:m.PI_NATIVE_VENDOR_PROVIDERS}))`], {
      encoding: "utf8",
      timeout: 15000,
    });
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  if (loaded.error) {
    const code = (loaded.error as NodeJS.ErrnoException).code;
    const detail = code === "ETIMEDOUT" || loaded.signal ? `timed out after 15s (${loaded.error.message})` : loaded.error.message;
    return { ok: false, detail };
  }
  if (loaded.status !== 0 || !loaded.stdout) {
    const stderr = (loaded.stderr ?? "").trim();
    return { ok: false, detail: stderr || `scripts/harness-run.mjs exited ${loaded.status}` };
  }
  try {
    return { ok: true, ...JSON.parse(loaded.stdout) as { ROUTES: Record<string, { provider: string; permissions: readonly string[]; models?: readonly string[]; roles?: readonly string[]; efforts?: readonly string[] }>; NATIVE_PI_BRAKE_PROVIDERS: string[]; PI_ALLOWED_PROVIDERS: string[]; PI_NATIVE_VENDOR_PROVIDERS: Record<string, string> } };
  } catch (error) {
    return { ok: false, detail: `ceilings JSON parse failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function developerRolePolicyIssues(projectRoot: string): KxmConfigIssue[] {
  // Product checkouts also have .kxm/roles/ for dispatch. The ceiling check
  // is this package's developer policy, so it runs when the loaded project
  // is that package.
  if (resolve(projectRoot) !== findKxmRepoRoot(import.meta.url)) return [];
  const rolesDir = join(projectRoot, ".kxm", "roles");
  const modelsDir = join(projectRoot, ".kxm", "models");
  const roles: Record<string, JsonObject> = {};
  const models: Record<string, JsonObject> = {};
  const evidence: Record<string, string> = {};
  const parseIssues: KxmConfigIssue[] = [];
  const readMap = (dir: string, into: Record<string, JsonObject>, skipInventory: boolean) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".yaml")) continue;
      const id = basename(name, ".yaml");
      if (skipInventory && id === "inventory") continue;
      try {
        const value = parseRestrictedYaml(readFileSync(join(dir, name), "utf8"), `${dir}/${name}`);
        into[id] = value;
      } catch (error) {
        if (error instanceof KxmConfigError) {
          parseIssues.push(...error.issues);
          continue;
        }
      }
    }
  };
  readMap(rolesDir, roles, false);
  readMap(modelsDir, models, true);
  for (const model of Object.values(models)) {
    const origin = objectValue(model.origin);
    const source = origin ? stringValue(origin.source) : undefined;
    if (!source || evidence[source] !== undefined) continue;
    const evidenceFile = isAbsolute(source) ? source : join(projectRoot, source);
    if (existsSync(evidenceFile)) evidence[source] = readFileSync(evidenceFile, "utf8");
  }
  const ceilings = developerCeilings();
  if (!ceilings.ok) {
    return [...parseIssues, issue("semantic", "developer_ceilings_unavailable", ".kxm/models", `developer ceilings could not be loaded: ${ceilings.detail}`)];
  }
  const result = validatePolicyDraft({ models, roles, evidence }, {
    ceilings: ceilings.ROUTES,
    nativePiBrakeProviders: ceilings.NATIVE_PI_BRAKE_PROVIDERS,
    piAllowedProviders: ceilings.PI_ALLOWED_PROVIDERS,
    piNativeVendorProviders: ceilings.PI_NATIVE_VENDOR_PROVIDERS,
    vendorAliases: { "x-ai": "xai", moonshotai: "moonshot", "google-ai": "google", qwen: "alibaba" },
  });
  if (result.ok) return parseIssues;
  return [...parseIssues, ...result.issues.map((entry) => issue(entry.phase, entry.code, entry.file, entry.message))];
}

export function kxmCanonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((candidate) => kxmCanonicalJson(candidate)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${kxmCanonicalJson(value[key] as JsonValue)}`).join(",")}}`;
}

function canonicalize(value: JsonValue): string {
  return kxmCanonicalJson(value);
}

function bundleRevision(resources: readonly KxmResource[]): string {
  const hash = createHash("sha256");
  for (const resource of [...resources].sort((left, right) => compareCodeUnits(left.logicalPath, right.logicalPath))) {
    hash.update(resource.logicalPath, "utf8");
    hash.update("\0", "utf8");
    hash.update(canonicalize(resource.value), "utf8");
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
}

/** Ask Git for the authoritative nearest worktree root with Git overrides removed. */
export function discoverGitRoot(start = process.cwd()): string | undefined {
  let current = resolve(start);
  if (existsSync(current) && !lstatSync(current).isDirectory()) current = dirname(current);
  const result = spawnSync("git", ["-C", current, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    env: gitEnvironment(),
    timeout: 5000,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error || !result.stdout.trim()) return undefined;
  const root = resolve(result.stdout.trim());
  return existsSync(root) && lstatSync(root).isDirectory() ? root : undefined;
}

/** Find the authoritative KXM project only at the nearest Git worktree root. */
export function discoverKxmProjectRoot(start = process.cwd()): string | undefined {
  const gitRoot = discoverGitRoot(start);
  return gitRoot && existsSync(join(gitRoot, ".kxm", "project.yaml")) ? gitRoot : undefined;
}

/** The former caller-supplied gate allowlist cannot substitute for reviewed YAML. */
export function assertNoRegisteredGates(options: object): void {
  if ("registeredGates" in options) {
    throw new KxmConfigError([issue("semantic", "registered_gates_removed", ".kxm/gates.yaml", "registeredGates was removed; declare gates in .kxm/gates.yaml")]);
  }
}

/** Load and semantically validate one complete, path-derived KXM configuration bundle. */
export function loadKxmProject(projectRoot: string, options: KxmConfigOptions = {}): KxmProjectBundle {
  return loadProjectBundle(projectRoot, options);
}

/**
 * What `loadKxmProject` would refuse once `.kxm/workflows/<workflowId>.yaml` held
 * `document`, found without writing it: the same parser, schema and bundle rules,
 * with `document` standing in for any file of that name.
 */
export function kxmWorkflowWriteIssues(
  projectRoot: string,
  workflowId: string,
  document: string,
  options: KxmConfigOptions = {},
): readonly KxmConfigIssue[] {
  return candidateIssues(projectRoot, options, { kind: "workflow", id: workflowId, document });
}

/**
 * What `loadKxmProject` would refuse once `.kxm/roles/<roleId>.yaml` held `document`,
 * found without writing it. The loader reads only the writer role, so for any other
 * id this is the project's load as it stands.
 */
export function kxmRoleWriteIssues(
  projectRoot: string,
  roleId: string,
  document: string,
  options: KxmConfigOptions = {},
): readonly KxmConfigIssue[] {
  return candidateIssues(projectRoot, options, { kind: "role", id: roleId, document });
}

interface WriteCandidate {
  kind: "workflow" | "role";
  id: string;
  document: string;
}

function candidateIssues(projectRoot: string, options: KxmConfigOptions, candidate: WriteCandidate): readonly KxmConfigIssue[] {
  try {
    loadProjectBundle(projectRoot, options, candidate);
    return [];
  } catch (error) {
    if (error instanceof KxmConfigError) return error.issues;
    throw error;
  }
}

function loadProjectBundle(
  projectRoot: string,
  options: KxmConfigOptions,
  candidate?: WriteCandidate,
): KxmProjectBundle {
  const workflowCandidate = candidate?.kind === "workflow" ? candidate : undefined;
  // A case-insensitive filesystem serves `Writer.yaml` to the loader's `writer.yaml` lookup.
  const writerRole = candidate?.kind === "role" && candidate.id.toLocaleLowerCase("en-US") === "writer" ? candidate.document : undefined;
  assertNoRegisteredGates(options);
  const root = resolve(projectRoot);
  const legacyPresent = legacyConfigFilesAt(root);
  if (legacyPresent.length > 0) {
    // Nothing can unlock this any more. The migration path was deleted under the
    // single-operator decision, so a tree still holding legacy JSON fails closed here
    // rather than being loadable on proof of a past conversion.
    throw new KxmConfigError(legacyPresent.map((file) => issue(
      "semantic",
      "legacy_state_unsupported",
      file,
      "legacy JSON configuration is present and this build does not migrate it: delete these files once their YAML replacements exist in .kxm/, or initialise a fresh project",
    )));
  }
  const registry = new KxmSchemaRegistry(options.schemasDir);
  const project = readResource(registry, root, join(root, ".kxm", "project.yaml"), ".kxm/project.yaml", "project");
  const earlyIssues: KxmConfigIssue[] = [];
  validatePortablePaths(project, earlyIssues);
  const templateProvenance = readTemplateProvenance(registry, root);
  if (templateProvenance && templateProvenance.inputs && typeof templateProvenance.inputs === "object" && !Array.isArray(templateProvenance.inputs)) {
    const provenanceProjectId = stringValue((templateProvenance.inputs as JsonObject).projectId);
    if (provenanceProjectId !== stringValue(project.value.id)) {
      earlyIssues.push(issue("semantic", "template_provenance_project_mismatch", ".kxm/template-provenance.yaml", "template provenance belongs to a different project identity"));
    }
  }
  const declaredRepositoryIds = new Set(valuesOf(project.value, "repositories")
    .map((candidate) => stringValue(objectValue(candidate)?.id))
    .filter((candidate): candidate is string => candidate !== undefined));
  for (const repositoryId of Object.keys(options.repositoryBindings ?? {}).sort(compareCodeUnits)) {
    if (!resourceIdentifier(repositoryId)) {
      earlyIssues.push(issue("path", "repository_binding_id_invalid", ".kxm/project.yaml", `host-local binding identity ${repositoryId} is invalid`));
    } else if (!declaredRepositoryIds.has(repositoryId)) {
      earlyIssues.push(issue("reference", "repository_binding_unknown", ".kxm/project.yaml", `host-local binding references unknown repository ${repositoryId}`));
    }
  }
  if (earlyIssues.length > 0) throw new KxmConfigError(earlyIssues);

  const agents = listNamedResources(registry, root, join(root, ".kxm", "agents"), ".kxm/agents", "agent");
  const models = listNamedResources(registry, root, join(root, ".kxm", "models"), ".kxm/models", "model");
  const roles = listNamedResources(registry, root, join(root, ".kxm", "roles"), ".kxm/roles", "role", writerRole === undefined ? undefined : "writer");
  if (writerRole !== undefined) {
    const logicalPath = ".kxm/roles/writer.yaml";
    roles.set("writer", { kind: "role", id: "writer", file: join(root, logicalPath), logicalPath, value: resourceValue(registry, writerRole, logicalPath, "role") });
  }
  const workflows = listNamedResources(registry, root, join(root, ".kxm", "workflows"), ".kxm/workflows", "workflow", workflowCandidate?.id);
  if (workflowCandidate) {
    const { id, document } = workflowCandidate;
    const logicalPath = `.kxm/workflows/${id}.yaml`;
    if (!resourceIdentifier(id)) fail("path", "resource_id_invalid", logicalPath, `filename-derived identity ${id} is invalid or platform-reserved`);
    const collision = [...workflows.keys()].find((candidate) => candidate.toLocaleLowerCase("en-US") === id.toLocaleLowerCase("en-US"));
    if (collision) fail("path", "resource_id_collision", logicalPath, `${id} case-folds to existing ${collision}`);
    workflows.set(id, { kind: "workflow", id, file: join(root, logicalPath), logicalPath, value: resourceValue(registry, document, logicalPath, "workflow") });
  }
  const gatePath = join(root, ".kxm", "gates.yaml");
  const gateRegistry = existsSync(gatePath) ? readResource(registry, root, gatePath, ".kxm/gates.yaml", "gate-registry") : undefined;
  const environments: KxmResource[] = [];
  const repositories = new Map<string, KxmResource>();
  const loadIssues: KxmConfigIssue[] = [];

  const projectEnvironment = join(root, ".kxm", "project", "env.yaml");
  if (existsSync(projectEnvironment)) {
    try { environments.push(readResource(registry, root, projectEnvironment, ".kxm/project/env.yaml", "environment")); }
    catch (error) { if (error instanceof KxmConfigError) loadIssues.push(...error.issues); else throw error; }
  }

  const seenBindings = new Map<string, string>();
  for (const candidate of valuesOf(project.value, "repositories")) {
    const entry = objectValue(candidate);
    const repositoryId = entry && stringValue(entry.id);
    const pathHint = entry && stringValue(entry.pathHint);
    const role = entry && stringValue(entry.role);
    const required = entry?.required !== false;
    if (!repositoryId) continue;

    const hasLocalBinding = Object.hasOwn(options.repositoryBindings ?? {}, repositoryId);
    const localBinding = options.repositoryBindings?.[repositoryId];
    if (hasLocalBinding && (!localBinding || !isAbsolute(localBinding))) {
      loadIssues.push(issue("path", "repository_binding_not_absolute", ".kxm/project.yaml", `host-local binding for ${repositoryId} must be absolute`));
      continue;
    }
    if (role === "control" && localBinding && !sameHostPath(localBinding, root)) {
      loadIssues.push(issue("path", "control_repository_binding_invalid", ".kxm/project.yaml", `control repository ${repositoryId} must bind to the authoritative project root`));
      continue;
    }
    if (role === "control" && pathHint !== undefined && pathHint !== ".") {
      loadIssues.push(issue("path", "control_repository_path_invalid", ".kxm/project.yaml", `control repository ${repositoryId} must use pathHint .`));
      continue;
    }
    if (!hasLocalBinding && role !== "control" && pathHint && portablePath(pathHint)) {
      const pathIssue = portableBindingIssue(root, pathHint, repositoryId);
      if (pathIssue) {
        loadIssues.push(pathIssue);
        continue;
      }
    }
    const binding = hasLocalBinding && localBinding
      ? resolve(localBinding)
      : role === "control"
        ? root
        : pathHint && portablePath(pathHint)
          ? resolve(root, ...pathHint.split("/"))
          : undefined;
    if (!binding) {
      if (required) loadIssues.push(issue("discovery", "repository_binding_missing", ".kxm/project.yaml", `required repository ${repositoryId} has no portable pathHint or host-local binding`));
      continue;
    }
    if (!existsSync(binding)) {
      if (required || hasLocalBinding) loadIssues.push(issue("discovery", "repository_binding_unavailable", ".kxm/project.yaml", `${hasLocalBinding ? "explicit" : "required"} repository binding ${repositoryId} is unavailable`));
      continue;
    }
    const bindingStat = lstatSync(binding);
    if (bindingStat.isSymbolicLink() || !bindingStat.isDirectory()) {
      loadIssues.push(issue("path", "repository_binding_invalid", ".kxm/project.yaml", `repository binding ${repositoryId} must be a regular directory`));
      continue;
    }
    if (role === "member") {
      const repositoryGitRoot = discoverGitRoot(binding);
      if (!repositoryGitRoot || !sameHostPath(repositoryGitRoot, binding)) {
        loadIssues.push(issue("discovery", "repository_git_root_invalid", ".kxm/project.yaml", `member repository ${repositoryId} must bind to its authoritative Git worktree root`));
        continue;
      }
    }
    // A member worktree is authoritative for its own repo.yaml/env.yaml, so the legacy
    // refusal has to cover it too — checking only the control root let a member full of
    // legacy JSON load normally. Throws before a single byte of that member is read.
    const memberLegacy = binding === root ? [] : legacyConfigFilesAt(binding);
    if (memberLegacy.length > 0) {
      throw new KxmConfigError(memberLegacy.map((file) => issue(
        "semantic",
        "legacy_state_unsupported",
        `${repositoryId}/${file}`,
        `repository ${repositoryId} holds legacy JSON configuration and this build does not migrate it: delete those files once their YAML replacements exist, or bind a clean worktree`,
      )));
    }
    const foldedBinding = canonicalHostPath(binding).toLocaleLowerCase("en-US");
    const priorBinding = seenBindings.get(foldedBinding);
    if (priorBinding && priorBinding !== repositoryId) {
      loadIssues.push(issue("path", "repository_binding_collision", ".kxm/project.yaml", `${repositoryId} and ${priorBinding} use the same repository binding`));
      continue;
    }
    seenBindings.set(foldedBinding, repositoryId);
    const repositoryFile = join(binding, ".kxm", "repo", "repo.yaml");
    let definitionValidated = false;
    if (existsSync(repositoryFile)) {
      try {
        const resource = readResource(registry, root, repositoryFile, `.kxm/repositories/${repositoryId}/repo.yaml`, "repository", repositoryId, binding);
        if (resource.value.repositoryId !== repositoryId) {
          loadIssues.push(issue("reference", "repository_binding_identity_mismatch", resource.logicalPath, `binding ${repositoryId} declares repositoryId ${String(resource.value.repositoryId)}`));
        } else {
          mapResource(resource, repositories, loadIssues);
          definitionValidated = repositories.get(repositoryId) === resource;
        }
      } catch (error) {
        if (error instanceof KxmConfigError) loadIssues.push(...error.issues);
        else throw error;
      }
    } else if (required || hasLocalBinding) {
      loadIssues.push(issue("discovery", "repository_definition_missing", `.kxm/repositories/${repositoryId}/repo.yaml`, `${hasLocalBinding ? "explicit" : "required"} repository ${repositoryId} has no repo.yaml`));
    }
    const environmentFile = join(binding, ".kxm", "repo", "env.yaml");
    if (existsSync(environmentFile)) {
      if (!definitionValidated) {
        loadIssues.push(issue("reference", "repository_environment_without_definition", `.kxm/repositories/${repositoryId}/env.yaml`, `repository ${repositoryId} environment requires a validated matching repo.yaml`));
      } else {
        try { environments.push(readResource(registry, root, environmentFile, `.kxm/repositories/${repositoryId}/env.yaml`, "environment", undefined, binding)); }
        catch (error) { if (error instanceof KxmConfigError) loadIssues.push(...error.issues); else throw error; }
      }
    }
  }
  if (loadIssues.length > 0) throw new KxmConfigError(loadIssues);

  const issues = validateBundle(project, repositories, agents, models, workflows, environments, options, gateRegistry, root);
  if (issues.length > 0) throw new KxmConfigError(issues);
  const resources = [project, ...repositories.values(), ...agents.values(), ...models.values(), ...roles.values(), ...workflows.values(), ...environments, ...(gateRegistry ? [gateRegistry] : [])]
    .sort((left, right) => compareCodeUnits(left.logicalPath, right.logicalPath));
  return {
    projectRoot: root,
    project,
    repositories,
    agents,
    models,
    roles,
    workflows,
    environments,
    ...(gateRegistry ? { gateRegistry } : {}),
    ...(templateProvenance === undefined ? {} : { templateProvenance }),
    resources,
    configRevision: bundleRevision(resources),
  };
}



function legacyInputsAt(root: string): string[] {
  const candidates = [
    ".kxm/config/agents.json",
    ".kxm/config/gates.json",
    ".kxm/config/workflows",
    ".kxm/state/kxm.db",
  ];
  return candidates.filter((candidate) => existsSync(join(root, ...candidate.split("/"))));
}

const LEGACY_CONFIG_FILES = [".kxm/config/agents.json", ".kxm/config/gates.json"] as const;

/** Individual legacy configuration files (not directories, not runtime state) that a migration receipt must cover. */
export function legacyConfigFilesAt(root: string): string[] {
  const files: string[] = [];
  // Never traverse linked parent components for authoritative legacy bytes;
  // surface the linked path itself so readers reject it fail-closed.
  for (const component of [".kxm", ".kxm/config"] as const) {
    const absolute = join(root, ...component.split("/"));
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) return [component];
  }
  for (const candidate of LEGACY_CONFIG_FILES) {
    if (existsSync(join(root, ...candidate.split("/")))) files.push(candidate);
  }
  const workflowsDir = join(root, ".kxm", "config", "workflows");
  if (existsSync(workflowsDir)) {
    const stat = lstatSync(workflowsDir);
    if (stat.isSymbolicLink()) {
      // Never traverse a link for authoritative legacy bytes; surface the
      // linked directory itself so readers reject it fail-closed.
      files.push(".kxm/config/workflows");
      return files;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(workflowsDir, { withFileTypes: true })
        .filter((candidate) => (candidate.isFile() || candidate.isSymbolicLink()) && candidate.name.endsWith(".json"))
        .sort((left, right) => compareCodeUnits(left.name, right.name))) {
        // Linked workflow files are listed so readers reject them fail-closed
        // (legacy_source_invalid) instead of silently omitting them.
        files.push(`.kxm/config/workflows/${entry.name}`);
      }
    }
  }
  return files;
}





function discoverLegacyRoot(start: string): { root: string; inputs: string[] } | undefined {
  let initial = resolve(start);
  if (existsSync(initial) && !lstatSync(initial).isDirectory()) initial = dirname(initial);
  // Never cross the nearest Git worktree boundary and accidentally select a
  // parent project or host-level ~/.kxm state.
  const candidate = discoverGitRoot(initial) ?? initial;
  const inputs = legacyInputsAt(candidate);
  return inputs.length > 0 ? { root: candidate, inputs } : undefined;
}

/**
 * Classify init without changing files. Applying create/repair is a separate, explicit
 * operation; a legacy-only tree is **reported and never written** — this build carries no
 * migration path, so init says what to do instead of doing it.
 */
export function planKxmInitialization(start = process.cwd(), options: KxmConfigOptions = {}): KxmInitializationPlan {
  const inspectedFrom = resolve(start);
  const projectRoot = discoverKxmProjectRoot(inspectedFrom);
  if (projectRoot) {
    try {
      const bundle = loadKxmProject(projectRoot, options);
      return { mode: "ready", inspectedFrom, projectRoot, changesRequired: false, issues: [], legacyInputs: [], configRevision: bundle.configRevision };
    } catch (error) {
      if (!(error instanceof KxmConfigError)) throw error;
      const legacyIssues = error.issues.filter((candidate) => candidate.code === "legacy_state_unsupported");
      const legacyInputs = legacyInputsAt(projectRoot);
      if (legacyInputs.length > 0 || legacyIssues.length > 0) {
        // Terminal for **any** legacy input, including one that lives in a bound member
        // worktree. Classifying a member's legacy JSON as `repair` let init take the
        // mutation lock and resume an interrupted create/repair journal, installing
        // resources into a tree the loader had just refused.
        return {
          mode: "legacy",
          inspectedFrom,
          projectRoot,
          legacyRoot: projectRoot,
          changesRequired: true,
          issues: [...error.issues, ...(legacyInputs.length > 0
            ? [issue("discovery", "legacy_state_unsupported", ".kxm", "legacy configuration is present and this build does not migrate it: initialise a fresh project directory and carry over the YAML definitions you want to keep")]
            : [])],
          legacyInputs: [...new Set([...legacyInputs, ...legacyIssues.map((candidate) => candidate.file)])],
        };
      }
      return { mode: "repair", inspectedFrom, projectRoot, changesRequired: true, issues: error.issues, legacyInputs: [] };
    }
  }
  const legacy = discoverLegacyRoot(inspectedFrom);
  if (legacy) {
    return {
      mode: "legacy",
      inspectedFrom,
      legacyRoot: legacy.root,
      changesRequired: true,
      issues: [issue("discovery", "legacy_state_unsupported", legacy.root, "legacy KXM/Mesh configuration discovered; this build does not migrate it — initialise a fresh project directory and copy the YAML definitions you want to keep")],
      legacyInputs: legacy.inputs,
    };
  }
  const gitRoot = discoverGitRoot(inspectedFrom);
  const candidateRoot = gitRoot ?? inspectedFrom;
  if (existsSync(join(candidateRoot, ".kxm"))) {
    return {
      mode: "repair",
      inspectedFrom,
      projectRoot: candidateRoot,
      changesRequired: true,
      issues: [issue("discovery", "project_definition_missing", ".kxm/project.yaml", "partial .kxm state has no authoritative project.yaml")],
      legacyInputs: [],
    };
  }
  return { mode: "create", inspectedFrom, projectRoot: candidateRoot, changesRequired: true, issues: [], legacyInputs: [] };
}

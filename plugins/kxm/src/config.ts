import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { redactSecrets } from "./redact.ts";

export const KXM_CONFIG_SCHEMA = "kxm.config.v1" as const;

export interface KxmUserConfig {
  name?: string;
  email?: string;
  preferredHarness?: string;
  preferredModel?: string;
  preferredCritics?: string[];
  theme?: "dark" | "light" | "minimal";
  tokenBudget?: number;
}

export interface KxmProjectDefaults {
  project?: string;
  workflow?: string;
  harness?: string;
  model?: string;
}

export interface KxmDashConfig {
  defaultScreen?: "agents" | "tasks" | "workflows" | "plans" | "inbox" | "procs" | "spend";
  refreshIntervalMs?: number;
  autoOpen?: boolean;
}

export interface KxmSyncTrackerConfig {
  defaultTracker?: "github" | "jira" | "none";
  github?: {
    owner?: string;
    repo?: string;
    syncLabels?: boolean;
    autoComment?: boolean;
  };
  jira?: {
    host?: string;
    projectKey?: string;
    issueType?: string;
    autoTransition?: boolean;
  };
}

export type KxmHubAutoStart = "off" | "background";

export type KxmHubMode = "local" | "cloud";

/** A secret reference. `op` is an `op://` reference resolved with `op read` at
 * use time. `env` is an environment variable name. Neither field holds a token. */
export interface HubKeyRef {
  op?: string;
  env?: string;
}

/** One hub endpoint. `project` is the id presented to that hub. `key` is a
 * reference, never a literal token. */
export interface HubEndpointConfig {
  url?: string;
  project?: string;
  key?: HubKeyRef;
}

export interface KxmHubConfig {
  /** Pi extension hub startup: `background` starts a detached hub when no
   * healthy bound hub or live local claim exists; `off` never starts one. */
  autoStart: KxmHubAutoStart;
  /** Which endpoint is in effect. Unset means local unless a cloud binding says otherwise. */
  mode?: KxmHubMode;
  local?: HubEndpointConfig;
  cloud?: HubEndpointConfig;
  /** Hub-process project id to key reference. Resolved in memory; never persisted. */
  projects?: Record<string, HubKeyRef>;
}

/** A hub config value is a token, or a key reference that is not an `op://` ref or an env var name. */
export class KxmHubConfigError extends Error {
  readonly code = "hub_config_invalid";

  constructor(message: string) {
    super(message);
    this.name = "KxmHubConfigError";
  }
}

const HUB_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HUB_OP_REF = /^op:\/\/\S+\/\S+\/\S+$/;
const LITERAL_SECRET_KEY = /^(token|secret|password|authToken|auth_token|apiKey|api_key|api_token|bearer|credential|access_token)$/i;

export function isHubKeyEnvName(value: string): boolean {
  return HUB_ENV_NAME.test(value);
}

export function isHubOpReference(value: string): boolean {
  return HUB_OP_REF.test(value);
}

export type ImprovementPromotionPolicy = "manual_pr" | "critic_quorum" | "auto_threshold";

const IMPROVEMENT_PROMOTION_POLICIES: readonly ImprovementPromotionPolicy[] = ["manual_pr", "critic_quorum", "auto_threshold"];

/** Normalized on load: every field is present and in range. */
export interface KxmImprovementConfig {
  promotionPolicy: ImprovementPromotionPolicy;
  telemetryHalfLifeDays: number;
  autoThreshold: {
    minRuns: number;
    minPassRate: number;
    minCostSavings: number;
  };
}

export interface KxmShadowExecutionConfig {
  enabled: boolean;
  sampleRate: number; // e.g. 0.05 for 5%
  candidateModels?: string[] | undefined;
}

export type CircuitBreakerMode = "soft_demotion" | "quarantine";

export interface KxmCircuitBreakerConfig {
  mode?: CircuitBreakerMode | undefined;
  failureThreshold?: number | undefined;
  windowSeconds?: number | undefined;
  cooldownSeconds?: number | undefined;
  penaltyMultiplier?: number | undefined;
}

export interface KxmRoutingConfig {
  shadowExecution: KxmShadowExecutionConfig;
  circuitBreaker?: KxmCircuitBreakerConfig | undefined;
}

export interface KxmTelemetryConfig {
  federated: boolean;
  anonymize: boolean;
  userTelemetryDir?: string | undefined;
}

export interface KxmResolvedConfig {
  schema: typeof KXM_CONFIG_SCHEMA;
  user: KxmUserConfig;
  defaults: KxmProjectDefaults;
  dash: KxmDashConfig;
  sync: KxmSyncTrackerConfig;
  hub: KxmHubConfig;
  improvement: KxmImprovementConfig;
  routing: KxmRoutingConfig;
  telemetry: KxmTelemetryConfig;
  loadedFrom: {
    userConfigPath?: string | undefined;
    repoConfigPath?: string | undefined;
  };
}

export const DEFAULT_KXM_CONFIG: Omit<KxmResolvedConfig, "loadedFrom"> = {
  schema: KXM_CONFIG_SCHEMA,
  user: {
    theme: "dark",
    preferredCritics: ["reviewer-arch", "reviewer-cli"],
    tokenBudget: 16000,
  },
  defaults: {
    workflow: "software-engineering/feature-implementation",
    harness: "pi",
  },
  dash: {
    defaultScreen: "agents",
    refreshIntervalMs: 1000,
    autoOpen: false,
  },
  sync: {
    defaultTracker: "none",
  },
  hub: {
    autoStart: "background",
  },
  improvement: {
    promotionPolicy: "manual_pr",
    telemetryHalfLifeDays: 14,
    autoThreshold: {
      minRuns: 10,
      minPassRate: 0.95,
      minCostSavings: 0.50,
    },
  },
  routing: {
    shadowExecution: {
      enabled: false,
      sampleRate: 0.05,
      candidateModels: [],
    },
    circuitBreaker: {
      mode: "soft_demotion",
      failureThreshold: 3,
      windowSeconds: 3600,
      cooldownSeconds: 1800,
      penaltyMultiplier: 5.0,
    },
  },
  telemetry: {
    federated: true,
    anonymize: true,
  },
};

export function userConfigDirectory(overrideDir?: string): string {
  if (overrideDir) return resolve(overrideDir);
  return resolve(process.env.KXM_USER_CONFIG_DIR?.trim() || join(homedir(), ".config", "kxm"));
}

export function userTelemetryDirectory(overrideDir?: string): string {
  if (overrideDir) return resolve(overrideDir);
  return resolve(process.env.KXM_USER_TELEMETRY_DIR?.trim() || join(homedir(), ".config", "kxm", "telemetry"));
}

export function repoConfigDirectory(repoRoot: string): string {
  return resolve(repoRoot, ".kxm");
}

function deepMerge<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  const result = { ...target } as Record<string, unknown>;
  for (const [key, val] of Object.entries(source)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const existing = (result[key] && typeof result[key] === "object" && !Array.isArray(result[key]))
        ? (result[key] as Record<string, unknown>)
        : {};
      result[key] = deepMerge(existing, val as Record<string, unknown>);
    } else if (val !== undefined) {
      result[key] = val;
    }
  }
  return result as T;
}

function literalSecretMessage(path: string): string {
  return `refusing literal hub token at ${path}: store an op:// reference (key.op) or an environment variable name (key.env), never the token`;
}

function rejectLiteralHubSecrets(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectLiteralHubSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (typeof child === "string" && (key === "key" || LITERAL_SECRET_KEY.test(key))) {
      throw new KxmHubConfigError(literalSecretMessage(childPath));
    }
    if (child && typeof child === "object") rejectLiteralHubSecrets(child, childPath);
  }
}

function parseKeyRef(raw: unknown, path: string): HubKeyRef | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") throw new KxmHubConfigError(literalSecretMessage(path));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new KxmHubConfigError(`${path} must be a key reference with op and/or env, never a token`);
  }
  const row = raw as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (key !== "op" && key !== "env") {
      throw new KxmHubConfigError(literalSecretMessage(`${path}.${key}`));
    }
  }
  const ref: HubKeyRef = {};
  if (row.op !== undefined) {
    if (typeof row.op !== "string" || !isHubOpReference(row.op)) {
      throw new KxmHubConfigError(`${path}.op must be an op://vault/item/field reference, not a token`);
    }
    ref.op = row.op;
  }
  if (row.env !== undefined) {
    if (typeof row.env !== "string" || !isHubKeyEnvName(row.env)) {
      throw new KxmHubConfigError(`${path}.env must be an environment variable name, not a token`);
    }
    ref.env = row.env;
  }
  if (!ref.op && !ref.env) throw new KxmHubConfigError(`${path} needs key.op, key.env, or both`);
  return ref;
}

function parseEndpoint(raw: unknown, path: string): HubEndpointConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new KxmHubConfigError(`${path} must be an object with url, project, and key`);
  }
  const row = raw as Record<string, unknown>;
  const endpoint: HubEndpointConfig = {};
  if (row.url !== undefined) {
    if (typeof row.url !== "string" || !isHubUrl(row.url)) {
      throw new KxmHubConfigError(`${path}.url must be an http or https URL without credentials, query, or fragment`);
    }
    endpoint.url = row.url.replace(/\/$/, "");
  }
  if (row.project !== undefined) {
    if (typeof row.project !== "string" || !isHubProjectId(row.project)) {
      throw new KxmHubConfigError(`${path}.project must be a single-line project id, not a token`);
    }
    endpoint.project = row.project.trim();
  }
  const key = parseKeyRef(row.key, `${path}.key`);
  if (key) endpoint.key = key;
  for (const name of Object.keys(row)) {
    if (name !== "url" && name !== "project" && name !== "key") {
      if (typeof row[name] === "string") throw new KxmHubConfigError(literalSecretMessage(`${path}.${name}`));
      throw new KxmHubConfigError(`${path}.${name} is not a hub endpoint field`);
    }
  }
  return endpoint;
}

function isHubUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === ""
      && !raw.includes("?")
      && !raw.includes("#");
  } catch {
    return false;
  }
}

function isHubProjectId(raw: string): boolean {
  const value = raw.trim();
  return value.length > 0 && value.length <= 200 && !/[\s\r\n]/.test(value);
}

function parseProjectMap(raw: unknown): Record<string, HubKeyRef> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new KxmHubConfigError("hub.projects must be a map of project id to key reference, never a token");
  }
  const projects: Record<string, HubKeyRef> = {};
  for (const [project, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isHubProjectId(project)) {
      throw new KxmHubConfigError(`hub.projects key ${JSON.stringify(project)} must be a project id, not a token`);
    }
    const ref = parseKeyRef(value, `hub.projects.${project}`);
    if (!ref) throw new KxmHubConfigError(`hub.projects.${project} needs an op:// reference or an environment variable name`);
    projects[project.trim()] = ref;
  }
  return projects;
}

/** Unknown `hub.autoStart` values fail closed to the default so a config typo
 * never silently changes hub startup behavior. Literal tokens under `hub` are
 * refused. Key references stay unresolved. */
function normalizeHubConfig(raw: unknown): KxmHubConfig {
  const autoStart = (raw as { autoStart?: unknown } | undefined)?.autoStart;
  const hub: KxmHubConfig = {
    autoStart: autoStart === "off" || autoStart === "background" ? autoStart : DEFAULT_KXM_CONFIG.hub.autoStart,
  };
  if (raw === undefined) return hub;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new KxmHubConfigError("hub must be an object");
  }
  rejectLiteralHubSecrets(raw, "hub");
  const row = raw as Record<string, unknown>;
  if (row.mode !== undefined) {
    if (row.mode !== "local" && row.mode !== "cloud") {
      throw new KxmHubConfigError("hub.mode must be local or cloud");
    }
    hub.mode = row.mode;
  }
  const local = parseEndpoint(row.local, "hub.local");
  const cloud = parseEndpoint(row.cloud, "hub.cloud");
  const projects = parseProjectMap(row.projects);
  if (local) hub.local = local;
  if (cloud) hub.cloud = cloud;
  if (projects && Object.keys(projects).length > 0) hub.projects = projects;
  return hub;
}

/** Directory that holds this checkout's `.kxm/` config: the nearest
 * `project.yaml` or `config.yaml`, otherwise `start`. */
export function findConfigRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".kxm", "project.yaml")) || existsSync(join(dir, ".kxm", "config.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/** User config directory for this env. A partial env (tests, a command env
 * that is not the process env) does not read `~/.config/kxm`. */
export function userConfigDirForEnv(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.KXM_USER_CONFIG_DIR?.trim();
  if (explicit) return explicit;
  if (env === process.env) return undefined;
  return join(tmpdir(), "kxm-no-user-config");
}

export function loadHubSettings(start: string, env: NodeJS.ProcessEnv = process.env): KxmHubConfig {
  const userConfigDir = userConfigDirForEnv(env);
  return loadKxmConfig(findConfigRoot(start), userConfigDir === undefined ? {} : { userConfigDir }).hub;
}

function recordOf(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `improvement.*` values fail closed to the defaults field by field, so a typo
 * never turns review readiness into something else. None of these values can
 * authorize a promotion; they only shape the readiness `kxm improve` reports. */
function normalizeImprovementConfig(raw: unknown): KxmImprovementConfig {
  const value = recordOf(raw);
  const threshold = recordOf(value.autoThreshold);
  const policy = value.promotionPolicy;
  const halfLife = finiteNumber(value.telemetryHalfLifeDays);
  const minRuns = finiteNumber(threshold.minRuns);
  const minPassRate = finiteNumber(threshold.minPassRate);
  const minCostSavings = finiteNumber(threshold.minCostSavings);
  return {
    promotionPolicy: IMPROVEMENT_PROMOTION_POLICIES.includes(policy as ImprovementPromotionPolicy)
      ? policy as ImprovementPromotionPolicy
      : "manual_pr",
    telemetryHalfLifeDays: halfLife !== undefined && halfLife > 0 && halfLife <= 3650 ? halfLife : 14,
    autoThreshold: {
      minRuns: minRuns !== undefined && Number.isInteger(minRuns) && minRuns >= 1 && minRuns <= 1_000_000 ? minRuns : 10,
      minPassRate: minPassRate !== undefined && minPassRate >= 0 && minPassRate <= 1 ? minPassRate : 0.95,
      minCostSavings: minCostSavings !== undefined && minCostSavings >= 0 ? minCostSavings : 0.5,
    },
  };
}

export function loadKxmConfig(
  repoRoot = process.cwd(),
  options: { userConfigDir?: string } = {},
): KxmResolvedConfig {
  const userDir = userConfigDirectory(options.userConfigDir);
  const userConfigFile = join(userDir, "config.yaml");

  const repoDir = repoConfigDirectory(repoRoot);
  const repoConfigFile = join(repoDir, "config.yaml");

  let userRaw: Record<string, unknown> = {};
  let userLoadedPath: string | undefined;
  if (existsSync(userConfigFile)) {
    try {
      const text = readFileSync(userConfigFile, "utf8");
      userRaw = (parse(text) as Record<string, unknown>) ?? {};
      userLoadedPath = userConfigFile;
    } catch (error) {
      throw new Error(`invalid user config YAML at ${userConfigFile}`, { cause: error });
    }
  }

  let repoRaw: Record<string, unknown> = {};
  let repoLoadedPath: string | undefined;
  if (existsSync(repoConfigFile)) {
    try {
      const text = readFileSync(repoConfigFile, "utf8");
      repoRaw = (parse(text) as Record<string, unknown>) ?? {};
      repoLoadedPath = repoConfigFile;
    } catch (error) {
      throw new Error(`invalid project config YAML at ${repoConfigFile}`, { cause: error });
    }
  }

  // Base -> User -> Repo
  const baseCopy = JSON.parse(JSON.stringify(DEFAULT_KXM_CONFIG)) as typeof DEFAULT_KXM_CONFIG;
  const mergedUser = deepMerge(baseCopy as unknown as Record<string, unknown>, userRaw);
  const mergedAll = deepMerge(mergedUser, repoRaw);

  return {
    schema: KXM_CONFIG_SCHEMA,
    user: (mergedAll.user as KxmUserConfig) ?? {},
    defaults: (mergedAll.defaults as KxmProjectDefaults) ?? {},
    dash: (mergedAll.dash as KxmDashConfig) ?? {},
    sync: (mergedAll.sync as KxmSyncTrackerConfig) ?? {},
    hub: normalizeHubConfig(mergedAll.hub),
    improvement: normalizeImprovementConfig(mergedAll.improvement),
    routing: (mergedAll.routing as KxmRoutingConfig) ?? DEFAULT_KXM_CONFIG.routing,
    telemetry: (mergedAll.telemetry as KxmTelemetryConfig) ?? DEFAULT_KXM_CONFIG.telemetry,
    loadedFrom: {
      userConfigPath: userLoadedPath,
      repoConfigPath: repoLoadedPath,
    },
  };
}

export function getKxmConfigValue(config: KxmResolvedConfig, keyPath: string): unknown {
  const parts = keyPath.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Resolve the file a scope writes, shared by set and delete. */
export function kxmConfigFileForScope(
  repoRoot: string,
  scope: "user" | "project",
  userConfigDir?: string,
): string {
  return scope === "user"
    ? join(userConfigDirectory(userConfigDir), "config.yaml")
    : join(repoConfigDirectory(repoRoot), "config.yaml");
}

function configKeyParts(keyPath: string): string[] {
  const parts = keyPath.split(".");
  if (parts.some((part) => !part || part === "__proto__" || part === "prototype" || part === "constructor")) {
    throw new Error("invalid config key path");
  }
  return parts;
}

function readConfigFile(targetFile: string): Record<string, unknown> {
  let existing: Record<string, unknown> = {};
  if (existsSync(targetFile)) {
    try {
      existing = (parse(readFileSync(targetFile, "utf8")) as Record<string, unknown>) ?? {};
    } catch {
      // A malformed file is repaired by the next write, the same way the
      // existing set path behaves: refuse nothing here or `set` would regress.
      existing = {};
    }
  }
  return existing;
}

function writeConfigFile(targetFile: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(targetFile), { recursive: true });
  writeFileSync(targetFile, stringify(value).trim() + "\n", "utf8");
}

export function setKxmConfigValue(
  repoRoot: string,
  keyPath: string,
  value: unknown,
  options: { scope?: "user" | "project"; userConfigDir?: string; dryRun?: boolean } = {},
): { file: string } {
  const targetFile = kxmConfigFileForScope(repoRoot, options.scope ?? "project", options.userConfigDir);
  const existing = readConfigFile(targetFile);
  const parts = configKeyParts(keyPath);
  let cursor = existing;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (!cursor[p] || typeof cursor[p] !== "object") {
      cursor[p] = {};
    }
    cursor = cursor[p] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
  if (parts[0] === "hub") normalizeHubConfig(existing.hub);
  if (!options.dryRun) writeConfigFile(targetFile, existing);
  return { file: targetFile };
}

/** Record the non-secret parts of a hub bind: mode, URL, project id, and key
 * reference. The resolved token is never written. */
export function writeHubEndpoint(
  start: string,
  endpoint: { mode: KxmHubMode; url: string; project: string; key?: HubKeyRef },
): { file: string } {
  if (!isHubUrl(endpoint.url)) {
    throw new KxmHubConfigError("hub url must be an http or https URL without credentials, query, or fragment");
  }
  if (!isHubProjectId(endpoint.project)) {
    throw new KxmHubConfigError("hub project id must be a single-line project id, not a token");
  }
  if (endpoint.key) parseKeyRef(endpoint.key, `hub.${endpoint.mode}.key`);
  const root = findConfigRoot(start);
  const file = join(root, ".kxm", "config.yaml");
  const existing = readConfigFile(file);
  const hub = recordOf(existing.hub);
  const current = recordOf(hub[endpoint.mode]);
  current.url = endpoint.url.replace(/\/$/, "");
  current.project = endpoint.project.trim();
  if (endpoint.key && (endpoint.key.op || endpoint.key.env)) {
    const key = recordOf(current.key);
    if (endpoint.key.op) key.op = endpoint.key.op;
    if (endpoint.key.env) key.env = endpoint.key.env;
    current.key = key;
  }
  hub[endpoint.mode] = current;
  hub.mode = endpoint.mode;
  existing.hub = hub;
  normalizeHubConfig(hub);
  writeConfigFile(file, existing);
  return { file };
}

/**
 * Remove a key so the next scope, then the built-in default, applies.
 *
 * Writing `null` is not the same thing: `defaults.harness: null` reads back as a
 * set value. "Inherit" has to delete, and empty parents are pruned so an unset
 * does not leave a skeleton behind.
 */
export function deleteKxmConfigValue(
  repoRoot: string,
  keyPath: string,
  options: { scope?: "user" | "project"; userConfigDir?: string } = {},
): boolean {
  const targetFile = kxmConfigFileForScope(repoRoot, options.scope ?? "project", options.userConfigDir);
  if (!existsSync(targetFile)) return false;
  const existing = readConfigFile(targetFile);
  const parts = configKeyParts(keyPath);
  const parents: Record<string, unknown>[] = [existing];
  let cursor = existing;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) return false;
    cursor = next as Record<string, unknown>;
    parents.push(cursor);
  }
  const leaf = parts[parts.length - 1]!;
  if (!Object.prototype.hasOwnProperty.call(cursor, leaf)) return false;
  delete cursor[leaf];
  for (let i = parents.length - 1; i > 0; i -= 1) {
    if (Object.keys(parents[i]!).length > 0) break;
    delete parents[i - 1]![parts[i - 1]!];
  }
  writeConfigFile(targetFile, existing);
  return true;
}

export function formatKxmConfig(config: KxmResolvedConfig): string {
  const display = {
    schema: config.schema,
    user: config.user,
    defaults: config.defaults,
    dash: config.dash,
    sync: config.sync,
    loadedFrom: config.loadedFrom,
  };
  return stringify(display).trim();
}

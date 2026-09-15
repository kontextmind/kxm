import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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

export interface KxmHubConfig {
  /** Pi extension hub startup: `background` starts a detached hub when no
   * healthy bound hub or live local claim exists; `off` never starts one. */
  autoStart: KxmHubAutoStart;
}

export type ImprovementPromotionPolicy = "manual_pr" | "critic_quorum" | "auto_threshold";

export interface KxmImprovementConfig {
  promotionPolicy: ImprovementPromotionPolicy;
  telemetryHalfLifeDays?: number | undefined;
  autoThreshold?: {
    minRuns?: number | undefined;
    minPassRate?: number | undefined;
    minCostSavings?: number | undefined;
  } | undefined;
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

/** Unknown `hub.autoStart` values fail closed to the default so a config typo
 * never silently changes hub startup behavior. */
function normalizeHubConfig(raw: unknown): KxmHubConfig {
  const autoStart = (raw as { autoStart?: unknown } | undefined)?.autoStart;
  return { autoStart: autoStart === "off" || autoStart === "background" ? autoStart : DEFAULT_KXM_CONFIG.hub.autoStart };
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
    improvement: (mergedAll.improvement as KxmImprovementConfig) ?? DEFAULT_KXM_CONFIG.improvement,
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

export function setKxmConfigValue(
  repoRoot: string,
  keyPath: string,
  value: unknown,
  options: { scope?: "user" | "project"; userConfigDir?: string } = {},
): void {
  const scope = options.scope ?? "project";
  const targetFile = scope === "user"
    ? join(userConfigDirectory(options.userConfigDir), "config.yaml")
    : join(repoConfigDirectory(repoRoot), "config.yaml");

  mkdirSync(dirname(targetFile), { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(targetFile)) {
    try {
      existing = (parse(readFileSync(targetFile, "utf8")) as Record<string, unknown>) ?? {};
    } catch {
      existing = {};
    }
  }

  const parts = keyPath.split(".");
  if (parts.some((part) => !part || part === "__proto__" || part === "prototype" || part === "constructor")) {
    throw new Error("invalid config key path");
  }
  let cursor = existing;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (!cursor[p] || typeof cursor[p] !== "object") {
      cursor[p] = {};
    }
    cursor = cursor[p] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;

  writeFileSync(targetFile, stringify(existing).trim() + "\n", "utf8");
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

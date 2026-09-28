import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type HubEndpointConfig,
  type HubKeyRef,
  type KxmHubMode,
  isHubOpReference,
  loadHubSettings,
} from "./config.ts";
import {
  CloudTokenError,
  type HubBindingRecord,
  type HubBindingScope,
  HubBindingError,
  hubBindingScope,
  readHubBinding,
  splitTokenCommand,
  validateHubUrl,
} from "./hub-binding.ts";

/** Where the project id presented to the hub came from. */
export type ProjectIdentitySource = "flag" | "env" | "config" | "project.yaml" | "package.json" | "directory";

export interface ProjectIdentity {
  project: string;
  source: ProjectIdentitySource;
  /** Safe to print. Names the file or variable, never a secret. */
  sourceLabel: string;
}

export type OpReader = (reference: string, env: NodeJS.ProcessEnv) => string;

export interface ResolvedKey {
  value: string;
  /** `env:<name>` or `op:<op://...>`. Never the token. */
  source: string;
}

export interface HubConnection {
  mode: KxmHubMode;
  modeSource: "config" | "binding" | "default";
  url: string;
  urlSource: "env" | "config" | "binding" | "default";
  scope: HubBindingScope;
  endpoint?: HubEndpointConfig;
  binding?: HubBindingRecord;
  /** Source that would supply the key. Never the key. */
  keySource: string;
}

const OP_TIMEOUT_MS = 15_000;
const OP_MAX_BUFFER = 4096;

function normalizeUrl(raw: string): string | undefined {
  try {
    return validateHubUrl(raw);
  } catch {
    return undefined;
  }
}

function projectYamlId(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const file = join(dir, ".kxm", "project.yaml");
    if (existsSync(file)) {
      try {
        const doc = parseYaml(readFileSync(file, "utf8")) as { id?: unknown } | null;
        if (doc && typeof doc === "object" && !Array.isArray(doc) && typeof doc.id === "string" && doc.id.trim()) {
          return doc.id.trim();
        }
      } catch {
        // Malformed YAML falls through to package.json of the original directory.
      }
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function packageName(cwd: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name?: unknown };
    if (typeof pkg.name === "string" && pkg.name.trim().length > 0) return pkg.name.trim();
  } catch {
    // No readable package.json: fall through to the directory name.
  }
  return undefined;
}

function activeBinding(env: NodeJS.ProcessEnv): HubBindingRecord | undefined {
  try {
    return readHubBinding(env);
  } catch (error) {
    if (error instanceof HubBindingError) return undefined;
    throw error;
  }
}

function endpointFor(mode: KxmHubMode, settings: ReturnType<typeof loadHubSettings>): HubEndpointConfig | undefined {
  return mode === "cloud" ? settings.cloud : settings.local;
}

/**
 * Project id presented to the hub.
 *
 * Order: flag, then `KXM_PROJECT`, then the active mode's `project` in
 * `.kxm/config.yaml`, then the `id` in the nearest `.kxm/project.yaml`, then
 * the workspace `package.json` name, then the directory name.
 */
export function resolveProjectIdentity(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  explicit?: string,
): ProjectIdentity {
  const fromExplicit = explicit?.trim();
  if (fromExplicit) return { project: fromExplicit, source: "flag", sourceLabel: "--project" };
  const fromEnv = env.KXM_PROJECT?.trim();
  if (fromEnv) return { project: fromEnv, source: "env", sourceLabel: "KXM_PROJECT" };
  const settings = loadHubSettings(cwd, env);
  const mode = settings.mode ?? (activeBinding(env)?.cloud ? "cloud" : "local");
  const fromConfig = endpointFor(mode, settings)?.project?.trim();
  if (fromConfig) {
    return { project: fromConfig, source: "config", sourceLabel: `.kxm/config.yaml hub.${mode}.project` };
  }
  const fromProject = projectYamlId(cwd);
  if (fromProject) return { project: fromProject, source: "project.yaml", sourceLabel: ".kxm/project.yaml id" };
  const fromPackage = packageName(cwd);
  if (fromPackage) return { project: fromPackage, source: "package.json", sourceLabel: "package.json name" };
  return { project: basename(cwd), source: "directory", sourceLabel: "directory name" };
}

/** Same order as {@link resolveProjectIdentity}. One function, string form. */
export function defaultProjectName(cwd: string, env: NodeJS.ProcessEnv = process.env, explicit?: string): string {
  return resolveProjectIdentity(cwd, env, explicit).project;
}

export function opReferenceFromTokenCommand(command: string): string | undefined {
  try {
    const args = splitTokenCommand(command);
    if (args[0] === "op" && args[1] === "read" && args[2] && isHubOpReference(args[2])) return args[2];
  } catch {
    return undefined;
  }
  return undefined;
}

function defaultOpRead(reference: string, env: NodeJS.ProcessEnv): string {
  if (!isHubOpReference(reference)) {
    throw new CloudTokenError("cloud_token_command_invalid", `refusing to resolve ${reference}; an op:// reference is required`);
  }
  const result = spawnSync("op", ["read", reference], {
    encoding: "utf8",
    shell: false,
    timeout: OP_TIMEOUT_MS,
    maxBuffer: OP_MAX_BUFFER,
    env,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new CloudTokenError(
      "cloud_token_command_failed",
      `op read failed for ${reference}; the token was not saved`,
    );
  }
  const line = (result.stdout ?? "").trim();
  if (!line || line.split(/\r?\n/).length !== 1) {
    throw new CloudTokenError(
      "cloud_token_command_failed",
      `op read did not print a single token for ${reference}; the token was not saved`,
    );
  }
  return line;
}

/**
 * Resolve a key reference. A non-empty env var wins; otherwise `op read` runs.
 * The value is returned to the caller and never written.
 */
export function resolveKeyReference(
  ref: HubKeyRef | undefined,
  env: NodeJS.ProcessEnv,
  opRead: OpReader = defaultOpRead,
): ResolvedKey | undefined {
  if (!ref) return undefined;
  if (ref.env) {
    const value = env[ref.env]?.trim();
    if (value) return { value, source: `env:${ref.env}` };
  }
  if (ref.op) {
    const value = opRead(ref.op, env).trim();
    if (!value || value.split(/\r?\n/).length !== 1) {
      throw new CloudTokenError("cloud_token_command_failed", `op read did not print a single token for ${ref.op}`);
    }
    return { value, source: `op:${ref.op}` };
  }
  return undefined;
}

function keySourceFor(input: {
  mode: KxmHubMode;
  env: NodeJS.ProcessEnv;
  endpoint?: HubEndpointConfig;
  binding?: HubBindingRecord;
  project: string;
  hasSavedProjectToken?: (project: string) => boolean;
}): string {
  const ref = input.endpoint?.key;
  if (input.mode === "local" && input.env.KXM_AUTH_TOKEN?.trim()) return "env:KXM_AUTH_TOKEN";
  if (ref?.env && input.env[ref.env]?.trim()) return `env:${ref.env}`;
  if (ref?.op) return `op:${ref.op}`;
  if (ref?.env) return `env:${ref.env}`;
  if (input.mode === "cloud") {
    if (input.binding?.tokenEnv) return `env:${input.binding.tokenEnv}`;
    if (input.binding?.tokenCommand) {
      const op = opReferenceFromTokenCommand(input.binding.tokenCommand);
      return op ? `op:${op}` : "command";
    }
    return "missing";
  }
  if (input.hasSavedProjectToken?.(input.project)) return "hub-env";
  return "missing";
}

/**
 * Mode, URL, and key source for this checkout. The key source names an env var
 * or an `op://` reference. It is never the token.
 */
export function describeHubConnection(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  hooks: { hasSavedProjectToken?: (project: string) => boolean; explicitProject?: string } = {},
): HubConnection & ProjectIdentity {
  const settings = loadHubSettings(cwd, env);
  const binding = activeBinding(env);
  const mode: KxmHubMode = settings.mode ?? (binding?.cloud ? "cloud" : "local");
  const modeSource: HubConnection["modeSource"] = settings.mode ? "config" : binding?.cloud ? "binding" : "default";
  const endpoint = endpointFor(mode, settings);
  const fromEnv = env.KXM_SERVER_URL?.trim();
  const fromConfig = endpoint?.url?.trim();
  const fromBinding = binding?.url;
  let url = "http://127.0.0.1:7331";
  let urlSource: HubConnection["urlSource"] = "default";
  if (fromEnv) {
    url = fromEnv.replace(/\/$/, "");
    urlSource = "env";
  } else if (fromConfig) {
    url = fromConfig.replace(/\/$/, "");
    urlSource = "config";
  } else if (fromBinding) {
    url = fromBinding;
    urlSource = "binding";
  }
  const identity = resolveProjectIdentity(cwd, env, hooks.explicitProject);
  const configuredCloudUrl = settings.cloud?.url ?? (binding?.cloud ? binding.url : undefined);
  let scope: HubBindingScope;
  if (mode === "cloud") {
    const override = fromEnv ? normalizeUrl(fromEnv) : undefined;
    const named = configuredCloudUrl ? normalizeUrl(configuredCloudUrl) : undefined;
    scope = override && named && override !== named ? hubBindingScope(url) : "remote";
  } else {
    scope = hubBindingScope(url);
  }
  return {
    ...identity,
    mode,
    modeSource,
    url,
    urlSource,
    scope,
    ...(endpoint ? { endpoint } : {}),
    ...(binding ? { binding } : {}),
    keySource: keySourceFor({
      mode,
      env,
      ...(endpoint ? { endpoint } : {}),
      ...(binding ? { binding } : {}),
      project: identity.project,
      ...(hooks.hasSavedProjectToken ? { hasSavedProjectToken: hooks.hasSavedProjectToken } : {}),
    }),
  };
}

export function projectTokenMissingMessage(identity: ProjectIdentity): string {
  return [
    `kxm has no project token for project ${identity.project} (from ${identity.sourceLabel}).`,
    `Ask the user to set this project's token. Set KXM_AUTH_TOKEN, or set hub.local.project or hub.cloud.project in .kxm/config.yaml to the project key the hub already knows, or add a key reference under hub.projects.${identity.project} (key.op is an op:// reference, key.env is an environment variable name, never the token) and restart the hub.`,
    "KXM_PROJECT or --project overrides the id for one command.",
    "An agent never uses the hub admin token.",
  ].join(" ");
}

export interface HubProjectTokenSelection {
  tokens: Record<string, string> | undefined;
  source: "env" | "config" | "file" | "none";
}

/** `KXM_PROJECT_TOKENS` replaces config, which replaces the saved file map. */
export function selectHubProjectTokenMap(input: {
  explicit: Record<string, string> | undefined;
  configured: Record<string, string> | undefined;
  file: Record<string, string> | undefined;
}): HubProjectTokenSelection {
  if (input.explicit) return { tokens: input.explicit, source: "env" };
  if (input.configured && Object.keys(input.configured).length > 0) return { tokens: input.configured, source: "config" };
  if (input.file && Object.keys(input.file).length > 0) return { tokens: input.file, source: "file" };
  return { tokens: undefined, source: "none" };
}

/**
 * Resolve `hub.projects` key references. Returns undefined when the map is
 * absent. Does not write the resolved tokens.
 */
export function resolveConfiguredHubProjectTokens(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  opRead: OpReader = defaultOpRead,
): Record<string, string> | undefined {
  const projects = loadHubSettings(cwd, env).projects;
  if (!projects || Object.keys(projects).length === 0) return undefined;
  const tokens: Record<string, string> = {};
  for (const [project, ref] of Object.entries(projects)) {
    const resolved = resolveKeyReference(ref, env, opRead);
    if (!resolved?.value) {
      throw new CloudTokenError(
        "cloud_token_missing",
        `hub.projects.${project} did not resolve; set ${ref.env ?? "the named variable"} or fix the op:// reference. The token was not saved`,
      );
    }
    tokens[project] = resolved.value;
  }
  return tokens;
}

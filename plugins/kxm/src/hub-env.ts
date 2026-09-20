import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const HUB_ENV_SCHEMA = "kxm.hub-env.v1" as const;

export interface HubEnvRecord {
  schema: typeof HUB_ENV_SCHEMA;
  /** ISO-8601 creation time of the persisted record. */
  createdAt: string;
  authToken?: string | undefined;
  projectTokens?: Record<string, string> | undefined;
}

export class HubEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubEnvError";
  }
}

function resolveUserStateRoot(env: NodeJS.ProcessEnv): string {
  const explicit = env.KXM_STATE_HOME?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) throw new HubEnvError("local_state_root_not_absolute");
    return resolve(explicit);
  }
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    const base = localAppData && isAbsolute(localAppData) ? localAppData : join(homedir(), "AppData", "Local");
    return resolve(base, "KXM");
  }
  if (process.platform === "darwin") return resolve(homedir(), "Library", "Application Support", "KXM");
  const xdgState = env.XDG_STATE_HOME?.trim();
  const base = xdgState && isAbsolute(xdgState) ? xdgState : join(homedir(), ".local", "state");
  return resolve(base, "kxm");
}

export function hubEnvFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveUserStateRoot(env), "hub-env.json");
}

export function generateHubAuthToken(): string {
  return `kxm_admin_${randomBytes(24).toString("base64url")}`;
}

export function readHubEnvRecord(env: NodeJS.ProcessEnv = process.env): HubEnvRecord | undefined {
  const file = hubEnvFile(env);
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new HubEnvError(`hub env file is malformed at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HubEnvError(`hub env file is malformed at ${file}: expected a JSON object`);
  }
  const record = parsed as Partial<HubEnvRecord>;
  if (record.schema !== HUB_ENV_SCHEMA) {
    throw new HubEnvError(`hub env file at ${file} has unsupported schema ${String(record.schema)}`);
  }
  if (record.authToken !== undefined && (typeof record.authToken !== "string" || record.authToken.trim().length === 0)) {
    throw new HubEnvError(`hub env file at ${file} has an invalid authToken`);
  }
  if (record.projectTokens !== undefined) {
    const tokens = record.projectTokens;
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
      throw new HubEnvError(`hub env file at ${file} has invalid projectTokens`);
    }
    for (const [project, token] of Object.entries(tokens)) {
      if (!project.trim() || typeof token !== "string" || !token.trim()) {
        throw new HubEnvError(`hub env file at ${file} has an empty project name or token`);
      }
    }
  }
  return {
    schema: HUB_ENV_SCHEMA,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    ...(record.authToken !== undefined ? { authToken: record.authToken } : {}),
    ...(record.projectTokens !== undefined ? { projectTokens: record.projectTokens } : {}),
  };
}

export function writeHubEnvRecord(record: HubEnvRecord, env: NodeJS.ProcessEnv = process.env): string {
  const file = hubEnvFile(env);
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.hub-env-${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(record, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return file;
}

export interface ResolveHubCredentialsOptions {
  env?: NodeJS.ProcessEnv | undefined;
  /** Injectable token generator for tests. */
  generateToken?: () => string | undefined;
  /** When false, never create or update the persisted file. */
  persist?: boolean | undefined;
  now?: () => string | undefined;
}

export interface ResolvedHubCredentials {
  authToken: string | undefined;
  projectTokens: Record<string, string> | undefined;
  /** Where each value came from; `generated` values were persisted when allowed. */
  authTokenSource: "env" | "file" | "generated" | "none";
  projectTokensSource: "env" | "file" | "generated" | "none";
  envFile: string | undefined;
  written: boolean;
}

function parseProjectTokens(raw: string | undefined): Record<string, string> | undefined | "invalid" {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return "invalid";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "invalid";
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([project, token]) => !project.trim() || typeof token !== "string" || !token.trim())) return "invalid";
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Resolve hub credentials with persistence across restarts.
 *
 * Precedence: explicit environment variable, then the persisted user-state
 * file, then (for the admin token only) a freshly generated token that is
 * persisted so later restarts and workers reuse the same credential. */
export function resolveHubCredentials(options: ResolveHubCredentialsOptions = {}): ResolvedHubCredentials {
  const env = options.env ?? process.env;
  const persist = options.persist !== false;
  const existing = readHubEnvRecord(env);
  const envFile = hubEnvFile(env);

  const envAuthToken = env.KXM_AUTH_TOKEN?.trim();
  const envProjectTokens = parseProjectTokens(env.KXM_PROJECT_TOKENS);
  if (envProjectTokens === "invalid") {
    throw new HubEnvError("KXM_PROJECT_TOKENS must be a JSON object of project names to tokens");
  }

  let authTokenSource: ResolvedHubCredentials["authTokenSource"] = "none";
  let authToken = envAuthToken || existing?.authToken;
  if (envAuthToken) authTokenSource = "env";
  else if (authToken) authTokenSource = "file";

  if (!authToken) {
    const generated = options.generateToken?.() ?? generateHubAuthToken();
    if (generated) {
      authToken = generated;
      authTokenSource = "generated";
    }
  }

  let projectTokensSource: ResolvedHubCredentials["projectTokensSource"] = "none";
  let projectTokens = envProjectTokens ?? existing?.projectTokens;
  if (envProjectTokens) projectTokensSource = "env";
  else if (projectTokens) projectTokensSource = "file";

  const needsPersist = persist
    && (authTokenSource === "generated"
      || (authTokenSource === "env" && existing?.authToken !== authToken)
      || (projectTokensSource === "env" && JSON.stringify(existing?.projectTokens ?? undefined) !== JSON.stringify(projectTokens ?? undefined)));

  if (needsPersist) {
    const record: HubEnvRecord = {
      schema: HUB_ENV_SCHEMA,
      createdAt: existing?.createdAt || (options.now?.() ?? new Date().toISOString()),
      ...(authToken ? { authToken } : {}),
      ...(projectTokens ? { projectTokens } : {}),
    };
    writeHubEnvRecord(record, env);
  }

  return {
    authToken,
    projectTokens,
    authTokenSource,
    projectTokensSource,
    envFile: needsPersist || existing ? envFile : undefined,
    written: needsPersist === true,
  };
}

/** Read-only token for one-shot hub clients (CLI, MCP server, dashboards).
 *
 * Precedence: explicit KXM_AUTH_TOKEN, then the persisted project token for
 * the resolved project, then the persisted admin token. Never generates or
 * writes; a malformed persisted record fails closed with HubEnvError. This
 * matches the credential precedence `kxm hub start` announces, so a hub
 * started fresh (generated token persisted) accepts authenticated client
 * commands without the operator exporting the token. */
/**
 * Can this machine authenticate to a hub at all, the way one-shot clients resolve it:
 * explicit `KXM_AUTH_TOKEN`, else the persisted record's admin token, else any persisted
 * project token. Read-only — it never generates or writes, so a refusal can tell the
 * operator to configure something rather than having silently configured it for them.
 */
export function hasClientHubCredential(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.KXM_AUTH_TOKEN?.trim()) return true;
  const record = readHubEnvRecord(env);
  if (record?.authToken?.trim()) return true;
  return Object.values(record?.projectTokens ?? {}).some((token) => typeof token === "string" && token.trim().length > 0);
}

export function resolveClientHubAuthToken(env: NodeJS.ProcessEnv, project: string): string | undefined {
  const envToken = env.KXM_AUTH_TOKEN?.trim();
  if (envToken) return envToken;
  const record = readHubEnvRecord(env);
  return record?.projectTokens?.[project]?.trim() || record?.authToken?.trim() || undefined;
}

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

/** Read-only token for one-shot operator hub clients (CLI, runtime supervisor, dashboards).
 *
 * Precedence: explicit KXM_AUTH_TOKEN, then the persisted project token for
 * the resolved project, then the persisted admin token. Never generates or
 * writes; a malformed persisted record fails closed with HubEnvError. This
 * matches the credential precedence `kxm hub start` announces, so a hub
 * started fresh (generated token persisted) accepts authenticated client
 * commands without the operator exporting the token. */
/**
 * Can this machine authenticate to a hub at all, following the same precedence one-shot
 * clients use: explicit `KXM_AUTH_TOKEN`, else the persisted record's admin token, else a
 * persisted **project** token. Read-only on purpose — a refusal has to tell the operator
 * to configure something, not reveal that the tool quietly configured it for them.
 *
 * Pass `project` when the caller knows which project will authenticate. A record holding
 * only another project's token cannot authorise this one, and a guard that counts it as a
 * credential stores a binding that will fail exactly like the one it prevented.
 */
export function hasClientHubCredential(env: NodeJS.ProcessEnv = process.env, project?: string): boolean {
  if (env.KXM_AUTH_TOKEN?.trim()) return true;
  let record: HubEnvRecord | undefined;
  try {
    record = readHubEnvRecord(env);
  } catch (error) {
    // A malformed or invalid record is a configuration failure, not "no credential".
    // Letting it surface as an uncaught throw would print neither JSON nor prose.
    throw new HubEnvError(
      `${error instanceof Error ? error.message : String(error)}; refusing to guess a credential — repair or remove ${hubEnvFile(env)}`,
    );
  }
  if (record?.authToken?.trim()) return true;
  const tokens = record?.projectTokens ?? {};
  if (project !== undefined) return typeof tokens[project] === "string" && tokens[project].trim().length > 0;
  return Object.values(tokens).some((token) => typeof token === "string" && token.trim().length > 0);
}

export function resolveClientHubAuthToken(env: NodeJS.ProcessEnv, project: string): string | undefined {
  const envToken = env.KXM_AUTH_TOKEN?.trim();
  if (envToken) return envToken;
  const record = readHubEnvRecord(env);
  return record?.projectTokens?.[project]?.trim() || record?.authToken?.trim() || undefined;
}

/**
 * Token an agent session (the Claude MCP server, the Pi extension, the `kxm peer` and
 * `kxm workflow` agent commands) registers with: explicit `KXM_AUTH_TOKEN`,
 * else the persisted project token for `project`, else nothing. It never returns the
 * persisted admin token. The hub accepts the admin token for any project missing from its
 * project-token map, so an agent falling back to it would join a project nobody issued it a
 * token for. Operator tools keep `resolveClientHubAuthToken`. Throws HubEnvError on a
 * malformed persisted record, same as `resolveClientHubAuthToken`.
 */
export function resolveAgentHubAuthToken(env: NodeJS.ProcessEnv, project: string): string | undefined {
  const envToken = env.KXM_AUTH_TOKEN?.trim();
  if (envToken) return envToken;
  const tokens = readHubEnvRecord(env)?.projectTokens;
  if (!tokens || !Object.hasOwn(tokens, project)) return undefined;
  return tokens[project]?.trim() || undefined;
}

/**
 * Refusal for an agent session that has neither `KXM_AUTH_TOKEN` nor a saved project
 * token for its project. The fix is the operator's, so the message names it.
 */
export class AgentProjectTokenMissingError extends Error {
  readonly code = "project_token_missing";
  readonly project: string;

  constructor(project: string) {
    super(
      `kxm has no project token for project ${project} on this machine. Set KXM_AUTH_TOKEN to that project's token, or add ${project} to the hub KXM_PROJECT_TOKENS (list every existing project too, because that variable replaces the saved map). An agent never uses the hub admin token.`,
    );
    this.name = "AgentProjectTokenMissingError";
    this.project = project;
  }
}

/**
 * Admin-scoped hub reads (`/v1/ops/snapshot`, …) are rejected with 401 by a project token,
 * so this variant resolves the admin credential only: explicit `KXM_AUTH_TOKEN`, else the
 * persisted record's admin token. It never falls back to a project token the route would
 * refuse — handing the portal a 401 dressed as "configured" is worse than handing it none.
 * Throws on a malformed persisted record, same as `resolveClientHubAuthToken`.
 */
export function resolveClientAdminAuthToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const envToken = env.KXM_AUTH_TOKEN?.trim();
  if (envToken) return envToken;
  return readHubEnvRecord(env)?.authToken?.trim() || undefined;
}

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const HUB_BINDING_SCHEMA = "kxm.hub-binding.v1" as const;
export const HUB_HEALTH_PROBE_MS = 300;

export type HubHealth = "on" | "off" | "unknown";

/**
 * Where a bound hub sits relative to this machine — a trust question, not a cosmetic one.
 * A loopback URL never puts a bearer on a network; a remote URL means the operator chose
 * to. `kxm hub bind` therefore refuses a remote URL it cannot authenticate, mirroring the
 * rule the hub applies to its own listener ("KXM_AUTH_TOKEN is required when binding
 * beyond localhost").
 */
export type HubBindingScope = "loopback" | "remote";

export interface HubBindingRecord {
  schema: typeof HUB_BINDING_SCHEMA;
  url: string;
  boundAt: string;
  /** A forwarded or otherwise remote hub. Loopback in the URL does not make this local. */
  cloud?: true;
  /** Environment variable that holds the hub token. The token itself is never stored. */
  tokenEnv?: string;
  /** Program plus arguments that print the hub token. Not a shell pipeline, and not the token. */
  tokenCommand?: string;
}

export type CloudTokenErrorCode = "cloud_token_missing" | "cloud_token_command_failed" | "cloud_token_command_invalid";

/** The cloud binding named a token source and that source did not produce a token. */
export class CloudTokenError extends Error {
  readonly code: CloudTokenErrorCode;

  constructor(code: CloudTokenErrorCode, message: string) {
    super(message);
    this.name = "CloudTokenError";
    this.code = code;
  }
}

const TOKEN_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const TOKEN_COMMAND_TIMEOUT_MS = 15_000;
const TOKEN_COMMAND_MAX_BUFFER = 4096;

export class HubBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubBindingError";
  }
}

function resolveUserStateRoot(env: NodeJS.ProcessEnv): string {
  const explicit = env.KXM_STATE_HOME?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) throw new HubBindingError("local_state_root_not_absolute");
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

export function hubBindingFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveUserStateRoot(env), "hub-binding.json");
}

export function validateHubUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HubBindingError("hub_url_invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || raw.includes("?")
    || raw.includes("#")
  ) {
    throw new HubBindingError("hub_url_invalid");
  }
  return parsed.href.replace(/\/$/, "");
}

/** A cloud binding's token command is a program and arguments, never a shell. */
export function splitTokenCommand(raw: string): string[] {
  if (/[|&;<>$`\n\r]/.test(raw)) {
    throw new CloudTokenError(
      "cloud_token_command_invalid",
      "token command must be a program and arguments, not a shell pipeline",
    );
  }
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote) {
    throw new CloudTokenError("cloud_token_command_invalid", "token command has an unclosed quote");
  }
  if (current.length > 0) args.push(current);
  if (args.length === 0) {
    throw new CloudTokenError("cloud_token_command_invalid", "token command is empty");
  }
  return args;
}

export function isCloudTokenEnvName(value: string): boolean {
  return TOKEN_ENV_NAME.test(value);
}

/**
 * Where this command should say the hub sits. A cloud binding is remote even when its
 * URL is a loopback forward, but only for the URL the binding names. `KXM_SERVER_URL`
 * pointing somewhere else keeps that URL's own scope.
 */
export function effectiveHubBindingScope(url: string, env: NodeJS.ProcessEnv = process.env): HubBindingScope {
  try {
    const binding = readHubBinding(env);
    if (binding?.cloud) {
      try {
        if (validateHubUrl(url) === binding.url) return "remote";
      } catch {
        // An unparsable override is not the cloud binding.
      }
    }
  } catch (error) {
    if (!(error instanceof HubBindingError)) throw error;
  }
  return hubBindingScope(url);
}

/** Hub URL for a session: explicit env, else the binding, else the local default. */
export function resolveHubServerUrl(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.KXM_SERVER_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  try {
    const binding = readHubBinding(env);
    if (binding?.url) return binding.url;
  } catch (error) {
    if (!(error instanceof HubBindingError)) throw error;
  }
  return "http://127.0.0.1:7331";
}

/**
 * Resolve the token a cloud binding names. Never reads hub-env and never uses
 * `KXM_AUTH_TOKEN` unless `tokenEnv` is that name. `tokenEnv` wins when it is non-empty;
 * otherwise the command runs. The command is not cached.
 */
export function resolveCloudHubToken(binding: HubBindingRecord, env: NodeJS.ProcessEnv = process.env): string {
  if (!binding.cloud) {
    throw new CloudTokenError("cloud_token_missing", "cloud hub token is missing; the local hub-env token was not used");
  }
  if (binding.tokenEnv) {
    const value = env[binding.tokenEnv]?.trim();
    if (value) return value;
  }
  if (binding.tokenCommand) return runTokenCommand(binding.tokenCommand, env);
  const source = binding.tokenEnv ? `${binding.tokenEnv} is unset or empty` : "no token source is configured";
  throw new CloudTokenError(
    "cloud_token_missing",
    `cloud hub token is missing: ${source}; the local hub-env token was not used`,
  );
}

function runTokenCommand(command: string, env: NodeJS.ProcessEnv): string {
  const argv = splitTokenCommand(command);
  const [program, ...args] = argv;
  const result = spawnSync(program!, args, {
    encoding: "utf8",
    shell: false,
    timeout: TOKEN_COMMAND_TIMEOUT_MS,
    maxBuffer: TOKEN_COMMAND_MAX_BUFFER,
    env,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new CloudTokenError(
      "cloud_token_command_failed",
      "token command failed; the local hub-env token was not used",
    );
  }
  const stdout = result.stdout ?? "";
  if (stdout.trim().length === 0 || stdout.trim() !== stdout.trim().split(/\r?\n/)[0]) {
    throw new CloudTokenError(
      "cloud_token_command_failed",
      "token command did not print a single token; the local hub-env token was not used",
    );
  }
  return stdout.trim();
}

/** Loopback literals only; `0.0.0.0`, a LAN address or a hostname are all remote. */
export function hubBindingScope(url: string): HubBindingScope {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "remote";
  }
  if (host === "localhost" || host === "::1" || host === "[::1]" || host.endsWith(".localhost")) return "loopback";
  const v4 = /^127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(host);
  return v4 && [v4[1], v4[2], v4[3]].every((part) => Number(part) <= 255) ? "loopback" : "remote";
}

function isIsoTimestamp(value: string): boolean {
  if (Number.isNaN(Date.parse(value))) return false;
  return value === new Date(value).toISOString();
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (("name" in error && error.name === "AbortError") || ("code" in error && error.code === "ABORT_ERR")),
  );
}

export function readHubBinding(env: NodeJS.ProcessEnv = process.env): HubBindingRecord | undefined {
  const file = hubBindingFile(env);
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new HubBindingError(`malformed hub binding at ${file}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HubBindingError(`malformed hub binding at ${file}`);
  }
  const row = parsed as Record<string, unknown>;
  const keys = Object.keys(row);
  const allowed = new Set(["schema", "url", "boundAt", "cloud", "tokenEnv", "tokenCommand"]);
  const cloudish = keys.some((key) => key === "cloud" || key === "tokenEnv" || key === "tokenCommand");
  if (
    keys.some((key) => !allowed.has(key))
    || (!cloudish && keys.length !== 3)
    || row.schema !== HUB_BINDING_SCHEMA
    || typeof row.url !== "string"
    || typeof row.boundAt !== "string"
    || !isIsoTimestamp(row.boundAt)
  ) {
    throw new HubBindingError(`malformed hub binding at ${file}`);
  }
  let url: string;
  try {
    url = validateHubUrl(row.url);
  } catch {
    throw new HubBindingError(`malformed hub binding at ${file}`);
  }
  if (!cloudish) return { schema: HUB_BINDING_SCHEMA, url, boundAt: row.boundAt };
  if (row.cloud !== true) throw new HubBindingError(`malformed hub binding at ${file}`);
  let tokenEnv: string | undefined;
  let tokenCommand: string | undefined;
  if (row.tokenEnv !== undefined) {
    if (typeof row.tokenEnv !== "string" || !isCloudTokenEnvName(row.tokenEnv)) {
      throw new HubBindingError(`malformed hub binding at ${file}`);
    }
    tokenEnv = row.tokenEnv;
  }
  if (row.tokenCommand !== undefined) {
    if (typeof row.tokenCommand !== "string") throw new HubBindingError(`malformed hub binding at ${file}`);
    try {
      splitTokenCommand(row.tokenCommand);
    } catch {
      throw new HubBindingError(`malformed hub binding at ${file}`);
    }
    tokenCommand = row.tokenCommand;
  }
  if (!tokenEnv && !tokenCommand) throw new HubBindingError(`malformed hub binding at ${file}`);
  return {
    schema: HUB_BINDING_SCHEMA,
    url,
    boundAt: row.boundAt,
    cloud: true,
    ...(tokenEnv ? { tokenEnv } : {}),
    ...(tokenCommand ? { tokenCommand } : {}),
  };
}

export function writeHubBinding(record: HubBindingRecord, env: NodeJS.ProcessEnv = process.env): string {
  const file = hubBindingFile(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(file), `.hub-binding-${process.pid}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return file;
}

export function removeHubBinding(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = hubBindingFile(env);
  try {
    rmSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function probeHubHealth(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs = HUB_HEALTH_PROBE_MS,
): Promise<{ health: HubHealth; probeMs: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${url}/health`, { signal: controller.signal });
    if (!response.ok) return { health: "unknown", probeMs: Date.now() - started };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { health: "unknown", probeMs: Date.now() - started };
    }
    if (body && typeof body === "object" && (body as { ok?: unknown }).ok === true) {
      return { health: "on", probeMs: Date.now() - started };
    }
    return { health: "unknown", probeMs: Date.now() - started };
  } catch (error) {
    return { health: isAbortError(error) ? "unknown" : "off", probeMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

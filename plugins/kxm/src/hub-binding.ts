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

/**
 * Cloud token source for a machine-wide bind. Kept out of `hub-binding.json`
 * so a 0.7.159 reader, which accepts only `schema`, `url`, and `boundAt`,
 * does not throw and stop syncing.
 */
export function hubBindingCloudFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveUserStateRoot(env), "hub-binding.cloud.json");
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

const LEGACY_BINDING_KEYS = ["schema", "url", "boundAt"] as const;
const BINDING_KEYS = new Set<string>([...LEGACY_BINDING_KEYS, "cloud", "tokenEnv", "tokenCommand"]);

export interface HubBindingLoad {
  record?: HubBindingRecord;
  /**
   * Set when this build ignores the file and continues against the local hub.
   * A newer schema, or a cloud record an older process cannot read, must not
   * throw into the Runtime sync loop.
   */
  warning?: string;
}

function bindingFallbackWarning(file: string, reason: string): string {
  return `hub binding at ${file} ${reason}; falling back to the local hub. Restart the Runtime supervisor, the hub, and workers after upgrading and before a cloud bind.`;
}

function writeBindingJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(file), `.${file.endsWith("cloud.json") ? "hub-binding-cloud" : "hub-binding"}-${process.pid}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function parseBindingObject(file: string): Record<string, unknown> | HubBindingError {
  if (!existsSync(file)) return new HubBindingError(`missing hub binding at ${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return new HubBindingError(`malformed hub binding at ${file}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return new HubBindingError(`malformed hub binding at ${file}`);
  }
  return parsed as Record<string, unknown>;
}

function cloudRecordFromRow(file: string, row: Record<string, unknown>, url: string, boundAt: string): HubBindingRecord | undefined {
  if (row.cloud !== true) return undefined;
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
    boundAt,
    cloud: true,
    ...(tokenEnv ? { tokenEnv } : {}),
    ...(tokenCommand ? { tokenCommand } : {}),
  };
}

/**
 * The reader shipped in 0.7.159. It accepts only `schema`, `url`, and
 * `boundAt`. Extra keys throw `malformed hub binding`, which stopped sync.
 * New cloud binds keep this file in that shape, or omit it, so this reader
 * falls through to the local hub instead of throwing.
 */
export function readLegacyV1HubBinding(env: NodeJS.ProcessEnv = process.env): HubBindingRecord | undefined {
  const file = hubBindingFile(env);
  if (!existsSync(file)) return undefined;
  const parsed = parseBindingObject(file);
  if (parsed instanceof HubBindingError) throw parsed;
  const keys = Object.keys(parsed);
  if (
    keys.length !== 3
    || keys.some((key) => !LEGACY_BINDING_KEYS.includes(key as typeof LEGACY_BINDING_KEYS[number]))
    || parsed.schema !== HUB_BINDING_SCHEMA
    || typeof parsed.url !== "string"
    || typeof parsed.boundAt !== "string"
    || !isIsoTimestamp(parsed.boundAt)
  ) {
    throw new HubBindingError(`malformed hub binding at ${file}`);
  }
  let url: string;
  try {
    url = validateHubUrl(parsed.url);
  } catch {
    throw new HubBindingError(`malformed hub binding at ${file}`);
  }
  return { schema: HUB_BINDING_SCHEMA, url, boundAt: parsed.boundAt };
}

function interpretBindingFile(file: string): HubBindingLoad & { legacyCloud?: boolean } {
  if (!existsSync(file)) return {};
  const parsed = parseBindingObject(file);
  if (parsed instanceof HubBindingError) throw parsed;
  const keys = Object.keys(parsed);
  const unknown = keys.filter((key) => !BINDING_KEYS.has(key));
  if (parsed.schema !== HUB_BINDING_SCHEMA || unknown.length > 0) {
    return { warning: bindingFallbackWarning(file, `is newer than this build understands (${String(parsed.schema)})`) };
  }
  if (typeof parsed.url !== "string" || typeof parsed.boundAt !== "string" || !isIsoTimestamp(parsed.boundAt)) {
    throw new HubBindingError(`malformed hub binding at ${file}`);
  }
  let url: string;
  try {
    url = validateHubUrl(parsed.url);
  } catch {
    throw new HubBindingError(`malformed hub binding at ${file}`);
  }
  const cloudish = keys.some((key) => key === "cloud" || key === "tokenEnv" || key === "tokenCommand");
  if (!cloudish) {
    if (keys.length !== 3) throw new HubBindingError(`malformed hub binding at ${file}`);
    return { record: { schema: HUB_BINDING_SCHEMA, url, boundAt: parsed.boundAt } };
  }
  const record = cloudRecordFromRow(file, parsed, url, parsed.boundAt);
  if (!record) throw new HubBindingError(`malformed hub binding at ${file}`);
  return { record, legacyCloud: true };
}

/**
 * Cloud metadata wins over a local `hub-binding.json`. A legacy cloud record
 * that still lives in `hub-binding.json` is moved aside so a 0.7.159 process
 * no longer throws on the next read.
 */
export function loadHubBinding(env: NodeJS.ProcessEnv = process.env): HubBindingLoad {
  const cloudFile = hubBindingCloudFile(env);
  const cloud = interpretBindingFile(cloudFile);
  if (cloud.warning && !cloud.record) {
    const local = existsSync(hubBindingFile(env)) ? interpretBindingFile(hubBindingFile(env)) : {};
    if (local.record && !local.record.cloud) return { record: local.record, warning: cloud.warning };
    return { warning: cloud.warning };
  }
  if (cloud.record?.cloud) return { record: cloud.record, ...(cloud.warning ? { warning: cloud.warning } : {}) };
  const main = interpretBindingFile(hubBindingFile(env));
  if (main.legacyCloud && main.record) {
    writeBindingJson(cloudFile, main.record);
    rmSync(hubBindingFile(env), { force: true });
    return {
      record: main.record,
      warning: bindingFallbackWarning(
        hubBindingFile(env),
        "stored a cloud bind in the pre-0.7.160 file",
      ),
    };
  }
  return { ...(main.record ? { record: main.record } : {}), ...(main.warning ? { warning: main.warning } : {}) };
}

export function readHubBinding(env: NodeJS.ProcessEnv = process.env): HubBindingRecord | undefined {
  return loadHubBinding(env).record;
}

export function writeHubBinding(record: HubBindingRecord, env: NodeJS.ProcessEnv = process.env): string {
  if (record.cloud) {
    const file = hubBindingCloudFile(env);
    writeBindingJson(file, record);
    // A 0.7.159 reader throws on extra keys and stops sync. Leave a local
    // three-key file alone so that reader keeps the local hub. Drop a file
    // that points at this cloud URL, or that already carries cloud keys.
    const main = hubBindingFile(env);
    if (existsSync(main)) {
      try {
        const legacy = readLegacyV1HubBinding(env);
        if (!legacy || legacy.url === record.url) rmSync(main, { force: true });
      } catch (error) {
        if (!(error instanceof HubBindingError)) throw error;
        rmSync(main, { force: true });
      }
    }
    return file;
  }
  rmSync(hubBindingCloudFile(env), { force: true });
  const file = hubBindingFile(env);
  writeBindingJson(file, {
    schema: HUB_BINDING_SCHEMA,
    url: record.url,
    boundAt: record.boundAt,
  });
  return file;
}

export function removeHubBinding(env: NodeJS.ProcessEnv = process.env): boolean {
  const files = [hubBindingFile(env), hubBindingCloudFile(env)];
  let removed = false;
  for (const file of files) {
    try {
      rmSync(file);
      removed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}

export type HubProbeKind = "hub" | "auth_proxy" | "redirect" | "not_hub" | "unreachable" | "timeout";

export interface HubProbe {
  health: HubHealth;
  probeMs: number;
  kind: HubProbeKind;
  detail: string;
  status: number;
}

export interface HubEndpointVerdict {
  ok: boolean;
  status: number;
  kind: HubProbeKind;
  detail: string;
  /** Hub JSON when the body matches. Never the raw HTML of a login page. */
  body: unknown;
}

function contentTypeBase(header: string | null): string {
  return (header ?? "").split(";")[0]!.trim().toLowerCase();
}

function looksLikeHtml(contentType: string, body: string): boolean {
  if (contentType === "text/html" || contentType === "application/xhtml+xml") return true;
  const sample = body.slice(0, 800).trim().toLowerCase();
  return sample.startsWith("<!doctype html")
    || sample.startsWith("<html")
    || (sample.includes("<form") && (sample.includes("login") || sample.includes("authentik") || sample.includes("password")));
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** `/health` is `{ ok: true, agents: <number> }`. `/ready` adds `storage`. */
export function hubEndpointShape(role: "health" | "ready", body: Record<string, unknown>): boolean {
  if (role === "health") return body.ok === true && typeof body.agents === "number";
  return body.ok === true && (body.storage === "sqlite" || body.storage === "memory");
}

/**
 * A kxm hub answers JSON with the documented shape and `application/json`.
 * An auth proxy's 30x or HTML login page is not that, even on HTTP 200.
 */
export function classifyHubResponse(input: {
  role: "health" | "ready";
  status: number;
  contentType: string | null;
  bodyText: string;
}): HubEndpointVerdict {
  const contentType = contentTypeBase(input.contentType);
  if (input.status >= 300 && input.status < 400) {
    return {
      ok: false,
      status: input.status,
      kind: "redirect",
      detail: `HTTP ${input.status} redirect; this looks like an auth proxy or a redirect, not a kxm hub`,
      body: { error: "auth_proxy", detail: `HTTP ${input.status} redirect` },
    };
  }
  if (looksLikeHtml(contentType, input.bodyText)) {
    return {
      ok: false,
      status: input.status,
      kind: "auth_proxy",
      detail: `HTTP ${input.status} returned an HTML login page${contentType ? ` (${contentType})` : ""}; this looks like an auth proxy, not a kxm hub`,
      body: { error: "auth_proxy", detail: "HTML login page" },
    };
  }
  const jsonType = contentType === "application/json" || contentType === "text/plain" || contentType === "";
  const body = jsonType ? jsonObject(input.bodyText) : undefined;
  if (body && hubEndpointShape(input.role, body) && input.status >= 200 && input.status < 300) {
    if (contentType !== "" && contentType !== "application/json" && contentType !== "text/plain") {
      return {
        ok: false,
        status: input.status,
        kind: "not_hub",
        detail: `HTTP ${input.status} content-type ${contentType} is not application/json`,
        body: { error: "not_hub", detail: contentType },
      };
    }
    return { ok: true, status: input.status, kind: "hub", detail: "kxm hub", body };
  }
  const typeNote = contentType && contentType !== "application/json" ? ` content-type ${contentType}` : "";
  return {
    ok: false,
    status: input.status,
    kind: "not_hub",
    detail: `HTTP ${input.status}${typeNote} is not a kxm hub ${input.role} response`,
    body: { error: "not_hub", detail: `HTTP ${input.status}${typeNote}` },
  };
}

export async function readHubEndpoint(
  url: string,
  role: "health" | "ready",
  fetchImpl: typeof fetch,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<HubEndpointVerdict> {
  try {
    const response = await fetchImpl(`${url}/${role}`, {
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      redirect: "manual",
    });
    const bodyText = await response.text();
    return classifyHubResponse({
      role,
      status: response.status,
      contentType: response.headers.get("content-type"),
      bodyText,
    });
  } catch (error) {
    if (isAbortError(error)) {
      return { ok: false, status: 0, kind: "timeout", detail: "no reply within the probe budget", body: { error: "hub_unreachable" } };
    }
    return { ok: false, status: 0, kind: "unreachable", detail: "nothing answered", body: { error: "hub_unreachable" } };
  }
}

export async function probeHubHealth(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs = HUB_HEALTH_PROBE_MS,
): Promise<HubProbe> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const verdict = await readHubEndpoint(url, "health", fetchImpl, { signal: controller.signal });
    const health: HubHealth = verdict.kind === "hub" ? "on" : verdict.kind === "unreachable" ? "off" : "unknown";
    return { health, probeMs: Date.now() - started, kind: verdict.kind, detail: verdict.detail, status: verdict.status };
  } finally {
    clearTimeout(timer);
  }
}

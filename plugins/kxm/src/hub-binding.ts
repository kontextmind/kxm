import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { vnextUserStateRoot } from "./vnext-bindings.ts";

export const HUB_BINDING_SCHEMA = "kxm.hub-binding.v1" as const;
export const HUB_HEALTH_PROBE_MS = 300;

export type HubHealth = "on" | "off" | "unknown";

export interface HubBindingRecord {
  schema: typeof HUB_BINDING_SCHEMA;
  url: string;
  boundAt: string;
}

export class HubBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubBindingError";
  }
}

export function hubBindingFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(vnextUserStateRoot({ env }), "hub-binding.json");
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
  if (
    keys.length !== 3
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
  return { schema: HUB_BINDING_SCHEMA, url, boundAt: row.boundAt };
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

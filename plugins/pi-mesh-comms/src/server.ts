import { createMeshHub } from "./hub.ts";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_MESSAGE_RETENTION_MS,
  DEFAULT_MESSAGE_TTL_MS,
  DEFAULT_PORT,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
} from "./protocol.ts";
import { parseWorkflowDefinitions } from "./workflow.ts";

const host = process.env.PI_MESH_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PI_MESH_PORT ?? String(DEFAULT_PORT), 10);
const authToken = process.env.PI_MESH_AUTH_TOKEN;
const workspaceDir = resolve(process.env.PI_MESH_WORKSPACE_DIR?.trim() || ".kxm");
const configDir = resolve(process.env.PI_MESH_CONFIG_DIR?.trim() || join(workspaceDir, "config"));
const logsDir = resolve(process.env.PI_MESH_LOGS_DIR?.trim() || join(workspaceDir, "logs"));
const assetsDir = resolve(process.env.PI_MESH_ASSETS_DIR?.trim() || join(workspaceDir, "assets"));
const stateDir = resolve(process.env.PI_MESH_STATE_DIR?.trim() || join(workspaceDir, "state"));
const dataPathValue = process.env.PI_MESH_DATA_PATH?.trim();
const dataPath = dataPathValue === ":memory:" ? dataPathValue : resolve(dataPathValue || join(stateDir, "mesh.db"));
const logPath = resolve(process.env.PI_MESH_LOG_PATH?.trim() || join(logsDir, "pi-mesh-hub.jsonl"));
const messageTtlMs = Number.parseInt(process.env.PI_MESH_MESSAGE_TTL_MS ?? String(DEFAULT_MESSAGE_TTL_MS), 10);
const messageRetentionMs = Number.parseInt(
  process.env.PI_MESH_MESSAGE_RETENTION_MS ?? String(DEFAULT_MESSAGE_RETENTION_MS),
  10,
);
const rateLimitMax = Number.parseInt(process.env.PI_MESH_RATE_LIMIT_MAX ?? String(DEFAULT_RATE_LIMIT_MAX), 10);
const rateLimitWindowMs = Number.parseInt(
  process.env.PI_MESH_RATE_LIMIT_WINDOW_MS ?? String(DEFAULT_RATE_LIMIT_WINDOW_MS),
  10,
);

for (const directory of [configDir, logsDir, assetsDir, stateDir, dirname(logPath)]) {
  mkdirSync(directory, { recursive: true });
}
const logStream = createWriteStream(logPath, { flags: "a", encoding: "utf8", mode: 0o600 });

function structuredLog(entry: Record<string, unknown>): void {
  const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`;
  logStream.write(line);
  process.stdout.write(line);
}

function projectTokens(): Record<string, string> | undefined {
  const raw = process.env.PI_MESH_PROJECT_TOKENS?.trim();
  if (!raw) return undefined;
  const value = JSON.parse(raw) as unknown;
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("PI_MESH_PROJECT_TOKENS must be a JSON object of project names to tokens");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([project, token]) => !project.trim() || typeof token !== "string" || !token.trim())) {
    throw new Error("PI_MESH_PROJECT_TOKENS must contain non-empty project names and token strings");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("PI_MESH_PORT must be an integer between 0 and 65535");
}
if (![messageTtlMs, messageRetentionMs, rateLimitMax, rateLimitWindowMs].every(Number.isInteger)) {
  throw new Error("message TTL and rate limit settings must be integers");
}

const configuredProjectTokens = projectTokens();
const inlineWorkflows = process.env.PI_MESH_WEBHOOK_WORKFLOWS?.trim();
const workflowFile = process.env.PI_MESH_WEBHOOK_WORKFLOWS_FILE?.trim();
if (inlineWorkflows && workflowFile) {
  throw new Error("configure only one of PI_MESH_WEBHOOK_WORKFLOWS or PI_MESH_WEBHOOK_WORKFLOWS_FILE");
}
const webhookWorkflows = parseWorkflowDefinitions(
  workflowFile ? readFileSync(resolve(workflowFile), "utf8") : inlineWorkflows,
);

const hub = createMeshHub({
  host,
  port,
  dataPath,
  assetsDir,
  messageTtlMs,
  messageRetentionMs,
  rateLimit: { maxRequests: rateLimitMax, windowMs: rateLimitWindowMs },
  ...(authToken ? { authToken } : {}),
  ...(configuredProjectTokens ? { projectTokens: configuredProjectTokens } : {}),
  ...(webhookWorkflows.length ? { webhookWorkflows } : {}),
  logger: structuredLog,
});

const address = await hub.start();
structuredLog({ event: "hub_started", url: address.url, workspaceDir, configDir, logsDir, assetsDir, stateDir, dataPath, logPath });
process.stdout.write(`pi-mesh hub listening at ${address.url}; storage=${dataPath}\n`);

let shutdownPromise: Promise<void> | undefined;
function shutdown(signal: string): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    structuredLog({ event: "hub_stopping", signal });
    await hub.close();
    await new Promise<void>((resolveLog) => logStream.end(resolveLog));
    process.exit(0);
  })();
  return shutdownPromise;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("message", (message: unknown) => {
  if (message && typeof message === "object" && (message as { type?: string }).type === "shutdown") {
    const signal = (message as { signal?: unknown }).signal;
    void shutdown(typeof signal === "string" ? signal : "parent");
  }
});

import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, isAbsolute, join } from "node:path";
import { findKxmRepoRoot } from "./repo-root.ts";
import { loadKxmProject, KxmConfigError, type KxmConfigOptions } from "./project-config.ts";
import {
  KxmRuntimeRegistry,
  projectRuntimeKey,
  runtimeError,
  verifyKxmDriveReceipt,
  kxmRuntimePaths,
  type KxmRunEventStore,
  type KxmRuntimePaths,
} from "./runtime-store.ts";
import {
  acceptKxmRun,
  cancelKxmRun,
  closeKxmRuntimeContext,
  foldStoredKxmRun,
  openKxmRuntimeContext,
  projectKxmRunReadOnly,
  type KxmRuntimeContext,
} from "./runtime-service.ts";
import { createKxmOneShotProducer } from "./oneshot-producer.ts";
import { isRouteAdmitted } from "./routes.ts";
import { KxmRunScheduler, createKxmSimulatedProducer, recordDriveReceipt, recoverKxmRun, kxmDrivePollProjection } from "./engine.ts";
import { kxmDriveSession, kxmOpenDriveSessions } from "./runtime-owner.ts";
import { RuntimeHubClient } from "./client.ts";
import { readHubBinding } from "./hub-binding.ts";
import { resolveClientHubAuthToken } from "./hub-env.ts";
import { defaultProjectName } from "./project-name.ts";

/* ------------------------------------------------------------------ *
 * Token management
 * ------------------------------------------------------------------ */

export function kxmSupervisorTokenFile(paths: KxmRuntimePaths): string {
  return join(paths.runtimeDir, "supervisor.token");
}

/** Atomically publish the supervisor token (temp file + rename). */
function publishKxmSupervisorToken(paths: KxmRuntimePaths, token: string): void {
  const file = kxmSupervisorTokenFile(paths);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(temp, 0o600); } catch { /* Windows may ignore modes */ }
  renameSync(temp, file);
  try { chmodSync(file, 0o600); } catch { /* Windows may ignore modes */ }
}

export function hashKxmSupervisorToken(token: string): string {
  return `sha256:${createHash("sha256").update(`kxm-runtime-supervisor\0${token}`, "utf8").digest("hex")}`;
}

export function readKxmSupervisorToken(paths: KxmRuntimePaths): string | undefined {
  const file = kxmSupervisorTokenFile(paths);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw runtimeError("runtime_path_invalid", file, "supervisor token file must be a regular file, not a link");
  }
  const token = readFileSync(file, "utf8").trim();
  return token.length >= 32 ? token : undefined;
}

/* ------------------------------------------------------------------ *
 * Supervisor process state + liveness
 * ------------------------------------------------------------------ */

export interface KxmSupervisorStatus {
  running: boolean;
  runtimeId?: string;
  pid?: number;
  port?: number;
  state?: string;
  heartbeatAt?: string;
  startedAt?: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const HEARTBEAT_STALE_MS = 15_000;
const SUPERVISOR_ERROR_MAX_AGE_MS = 30_000;

function supervisorErrorFile(paths: KxmRuntimePaths): string {
  return join(paths.runtimeDir, "supervisor.error");
}

function clearSupervisorError(paths: KxmRuntimePaths): void {
  const file = supervisorErrorFile(paths);
  if (existsSync(file)) rmSync(file, { force: true });
}

function recordSupervisorError(paths: KxmRuntimePaths, message: string): void {
  try {
    mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
    writeFileSync(supervisorErrorFile(paths), `${message}\n`, { encoding: "utf8", mode: 0o600 });
  } catch { /* best effort */ }
}

function readRecentSupervisorError(paths: KxmRuntimePaths): string | undefined {
  const file = supervisorErrorFile(paths);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs > SUPERVISOR_ERROR_MAX_AGE_MS) return undefined;
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return undefined;
  }
}

export function kxmSupervisorStatus(paths: KxmRuntimePaths): KxmSupervisorStatus {
  if (!existsSync(paths.registryDb)) return { running: false };
  const registry = new KxmRuntimeRegistry(paths.registryDb);
  try {
    const record = registry.supervisor();
    if (!record) return { running: false };
    // Pid-only liveness is not enough: after a crash the pid may be reused by
    // an unrelated process. A stale heartbeat is authoritative.
    const heartbeatAgeMs = Date.now() - Date.parse(record.heartbeatAt);
    const fresh = Number.isFinite(heartbeatAgeMs) && heartbeatAgeMs < HEARTBEAT_STALE_MS;
    const alive = record.state === "running" && fresh && processAlive(record.pid);
    return {
      running: alive,
      runtimeId: record.runtimeId,
      pid: record.pid,
      port: record.port,
      state: alive ? record.state : "dead",
      heartbeatAt: record.heartbeatAt,
      startedAt: record.startedAt,
    };
  } finally {
    registry.close();
  }
}

async function probeSupervisorWithRetry(port: number, expectedRuntimeId: string, token: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await probeSupervisor(port, expectedRuntimeId, token)) return true;
    if (attempt < 2) await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return false;
}

async function probeSupervisor(port: number, expectedRuntimeId: string, token: string, timeoutMs = 750): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const nonce = randomBytes(16).toString("hex");
    const response = await fetch(`http://127.0.0.1:${port}/healthz?nonce=${nonce}`, { signal: controller.signal });
    if (!response.ok) return false;
    const payload = await response.json() as { runtimeId?: string; tokenProof?: string };
    // The server must prove it knows the current token: an impostor that
    // merely binds the stale port cannot answer the keyed challenge.
    const expectedProof = hashKxmTokenProof(token, nonce);
    return payload.runtimeId === expectedRuntimeId && payload.tokenProof === expectedProof;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function hashKxmTokenProof(token: string, nonce: string): string {
  return createHmac("sha256", token).update(`kxm-runtime-token-proof\0${nonce}`, "utf8").digest("hex");
}

export interface KxmSupervisorHandle {
  runtimeId: string;
  port: number;
  token: string;
  started: boolean;
}

/**
 * Attach to a live supervisor, or return `undefined`. Never starts one.
 *
 * `ensureKxmSupervisor` is for operators: an absent supervisor is a problem to fix, so it
 * spawns. A poller — the portal tenant read, a status screen — has the opposite contract:
 * polling must not conjure a daemon, and "nothing is running" is an answer to report, not
 * a condition to repair. Returns `undefined` for every not-running shape: no claim, a
 * supervisor registered but dead, a missing token file, or a probe that fails the
 * token-proof challenge.
 */
export async function attachKxmSupervisor(
  options: { stateRoot?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<KxmSupervisorHandle | undefined> {
  const paths = kxmRuntimePaths(options.stateRoot !== undefined ? { stateRoot: options.stateRoot } : { ...(options.env ? { env: options.env } : {}) });
  const status = kxmSupervisorStatus(paths);
  if (!status.running || !status.port || !status.runtimeId) return undefined;
  const token = readKxmSupervisorToken(paths);
  if (!token) return undefined;
  if (!(await probeSupervisor(status.port, status.runtimeId, token))) return undefined;
  return { runtimeId: status.runtimeId, port: status.port, token, started: false };
}

/** Ensure a supervisor is running: reuse a live one, otherwise auto-start. */
export async function ensureKxmSupervisor(
  options: { stateRoot?: string; env?: NodeJS.ProcessEnv; spawnImpl?: (scriptPath: string, env: NodeJS.ProcessEnv) => number } = {},
): Promise<KxmSupervisorHandle> {
  const paths = kxmRuntimePaths(options.stateRoot !== undefined ? { stateRoot: options.stateRoot } : { ...(options.env ? { env: options.env } : {}) });
  const status = kxmSupervisorStatus(paths);
  if (status.running && status.port) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = readKxmSupervisorToken(paths);
      if (token && (await probeSupervisorWithRetry(status.port, status.runtimeId as string, token))) {
        return { runtimeId: status.runtimeId as string, port: status.port, token, started: false };
      }
      // The token may be mid-publish in the claim/rename window; retry shortly.
      if (attempt < 2) await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
    // A live, fresh supervisor that cannot be probed is not spawnable:
    // spawning a competitor guarantees a conflict and locks out the state root.
    throw runtimeError("runtime_supervisor_unreachable", paths.registryDb, `runtime supervisor pid ${status.pid} is registered as running but cannot be probed`);
  }

  // Auto-start: claim the singleton, spawn detached, wait for readiness.
  clearSupervisorError(paths);
  const scriptPath = join(findKxmRepoRoot(import.meta.url), "scripts", "kxm-runtime-supervisor.mjs");
  const spawnImpl = options.spawnImpl ?? ((script: string, env: NodeJS.ProcessEnv): number => {
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: "ignore",
      env,
      windowsHide: true,
    });
    child.unref();
    if (child.pid === undefined) throw runtimeError("runtime_supervisor_spawn_failed", script, "could not spawn the runtime supervisor");
    return child.pid;
  });
  const pid = spawnImpl(scriptPath, {
    ...process.env,
    KXM_STATE_HOME: paths.stateRoot,
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const next = kxmSupervisorStatus(paths);
    if (next.running && next.port) {
      const token = readKxmSupervisorToken(paths);
      if (token && (await probeSupervisor(next.port, next.runtimeId as string, token))) {
        // Entry status had no live supervisor: this call caused a start
        // (ours or a concurrent winner's), which the probe just confirmed.
        return { runtimeId: next.runtimeId as string, port: next.port, token, started: true };
      }
    }
    const errorDetail = readRecentSupervisorError(paths);
    if (errorDetail) {
      throw runtimeError("runtime_supervisor_start_failed", scriptPath, `runtime supervisor failed at startup: ${errorDetail}`);
    }
  }
  throw runtimeError("runtime_supervisor_start_failed", scriptPath, `runtime supervisor (pid ${pid}) did not become ready in time`);
}

/* ------------------------------------------------------------------ *
 * Supervisor server (runs inside the supervisor process)
 * ------------------------------------------------------------------ */

interface JsonBody {
  [key: string]: unknown;
}

async function readJsonBody(request: IncomingMessage, limit = 64 * 1024): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > limit) {
      // Drain the remaining body so the client sees the 400 response instead
      // of a reset connection.
      tooLarge = true;
      continue;
    }
    if (!tooLarge) chunks.push(buffer);
  }
  if (tooLarge) throw runtimeError("runtime_request_too_large", request.url ?? "<request>", "request body exceeds the limit");
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw runtimeError("runtime_request_invalid", request.url ?? "<request>", "request body must be a JSON object");
    }
    return parsed as JsonBody;
  } catch (error) {
    if (error instanceof KxmConfigError) throw error;
    throw runtimeError("runtime_request_invalid", request.url ?? "<request>", "request body is not valid JSON");
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

export const DEFAULT_RUNTIME_STOP_GRACE_MS = 30_000;
/** Documented upper bound: 10 minutes, well under Node's 2^31-1 ms timer range. */
export const MAX_RUNTIME_STOP_GRACE_MS = 600_000;

export function runtimeStopGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KXM_RUNTIME_STOP_GRACE_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RUNTIME_STOP_GRACE_MS;
  const parsed = Number(raw.trim());
  if (
    !Number.isFinite(parsed)
    || !Number.isInteger(parsed)
    || parsed < 0
    || parsed > MAX_RUNTIME_STOP_GRACE_MS
  ) {
    process.stderr.write(
      `KXM_RUNTIME_STOP_GRACE_MS must be an integer between 0 and ${MAX_RUNTIME_STOP_GRACE_MS} ms (10 minutes); using default ${DEFAULT_RUNTIME_STOP_GRACE_MS}\n`,
    );
    return DEFAULT_RUNTIME_STOP_GRACE_MS;
  }
  return parsed;
}

async function waitForDriveSessions(settled: Promise<unknown>[], graceMs: number): Promise<void> {
  if (settled.length === 0) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(settled),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, graceMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function driveSessionStillPending(settled: Promise<unknown>): Promise<boolean> {
  let pending = true;
  void settled.then(
    () => { pending = false; },
    () => { pending = false; },
  );
  await Promise.resolve();
  return pending;
}

/* ------------------------------------------------------------------ *
 * Runtime → hub sync (P5): outbound only
 * ------------------------------------------------------------------ */

export const DEFAULT_RUNTIME_SYNC_INTERVAL_MS = 10_000;
const MIN_RUNTIME_SYNC_INTERVAL_MS = 250;
const MAX_RUNTIME_SYNC_INTERVAL_MS = 60_000;
const OUTBOX_PUSH_BATCH = 32;

/** How often the supervisor heartbeats and pushes its outbox. Keep it well
 * under the hub's presence lease (30 s by default). */
export function runtimeSyncIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KXM_RUNTIME_SYNC_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_RUNTIME_SYNC_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_RUNTIME_SYNC_INTERVAL_MS;
  return Math.min(MAX_RUNTIME_SYNC_INTERVAL_MS, Math.max(MIN_RUNTIME_SYNC_INTERVAL_MS, parsed));
}

export interface KxmOutboxSyncResult {
  pushed: number;
  acked: number;
  conflicts: number;
  rejected: number;
}

/**
 * Push every pending outbox row to the bound hub in outbox order and advance
 * the cursor on each acknowledgement. Accepted and duplicate rows are acked;
 * a conflict or rejection stays pending (the hub has raised the alert) and is
 * skipped for the rest of this pass. A transport failure leaves every row
 * pending for a safe retry.
 */
export async function syncKxmOutbox(
  eventStore: KxmRunEventStore,
  client: RuntimeHubClient,
  options: { now?: () => string; batchSize?: number } = {},
): Promise<KxmOutboxSyncResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const batchSize = options.batchSize ?? OUTBOX_PUSH_BATCH;
  const result: KxmOutboxSyncResult = { pushed: 0, acked: 0, conflicts: 0, rejected: 0 };
  let afterSeq = 0;
  for (;;) {
    const rows = eventStore.pendingOutbox(batchSize, afterSeq);
    if (rows.length === 0) return result;
    // Batch by serialized byte size, not just count: the hub rejects requests
    // over its body ceiling (HTTP 413), and retrying the same oversized batch
    // would permanently block the queue. Trim to the byte budget and leave the
    // rest for the next iteration.
    const MAX_BATCH_BYTES = 200_000; // hub ceiling is 256 KiB; leave headroom
    let byteBudget = MAX_BATCH_BYTES;
    let sendCount = 0;
    for (const row of rows) {
      const rowBytes = Buffer.byteLength(row.syncEvent, "utf8") + 64; // JSON overhead
      if (sendCount > 0 && byteBudget - rowBytes < 0) break;
      byteBudget -= rowBytes;
      sendCount += 1;
    }
    const batch = rows.slice(0, sendCount);
    if (batch.length === 0) batch.push(rows[0]!); // one oversized row: send alone, hub will 413
    afterSeq = batch[batch.length - 1]!.seq;
    eventStore.markOutboxAttempted(batch.map((row) => row.seq), now());
    const response = await client.pushSyncEvents(batch.map((row) => JSON.parse(row.syncEvent) as unknown));
    result.pushed += batch.length;
    const outcomes = new Map(response.results.map((entry) => [`${entry.runId}\u0000${entry.sequence}`, entry.outcome]));
    const acked: number[] = [];
    for (const row of batch) {
      const outcome = outcomes.get(`${row.runId}\u0000${row.sequence}`);
      if (outcome === "accepted" || outcome === "duplicate") acked.push(row.seq);
      else if (outcome === "conflict") result.conflicts += 1;
      else result.rejected += 1;
    }
    result.acked += eventStore.ackOutbox(acked, now());
  }
}

/** Where this Runtime reports one project, or nothing when no hub is bound. */
function runtimeHubClientFor(context: KxmRuntimeContext, env: NodeJS.ProcessEnv): RuntimeHubClient | undefined {
  const serverUrl = env.KXM_SERVER_URL?.trim() || readHubBinding(env)?.url;
  if (!serverUrl) return undefined;
  // Use the context's actual projectId — the same identity sync events carry — so the
  // ops snapshot can join runs to their home Runtime. defaultProjectName() resolves to
  // the npm package name (e.g. "@kontextmind/kxm"), which never matches project.yaml's
  // prj_* id, leaving presence orphaned from the runs it owns.
  const project = context.projectId;
  const authToken = resolveClientHubAuthToken(env, project);
  return new RuntimeHubClient({
    serverUrl,
    project,
    runtimeId: context.homeRuntimeId,
    ...(authToken ? { authToken } : {}),
  });
}

export interface KxmRuntimeSupervisor {
  server: Server;
  port: number;
  runtimeId: string;
  stop: () => Promise<void>;
}

export async function startKxmRuntimeSupervisor(
  options: { stateRoot?: string; port?: number; now?: () => string } = {},
): Promise<KxmRuntimeSupervisor> {
  const now = options.now ?? (() => new Date().toISOString());
  const paths = kxmRuntimePaths(options.stateRoot !== undefined ? { stateRoot: options.stateRoot } : {});
  try {
    return await startKxmRuntimeSupervisorInner(paths, options.port, now);
  } catch (error) {
    // Startup failures are recorded so auto-start clients see the real cause
    // instead of a bare timeout. Conflict is not an error: the winner is
    // probed and reused instead.
    if (!(error instanceof KxmConfigError && error.issues.some((issue) => issue.code === "runtime_supervisor_conflict"))) {
      recordSupervisorError(paths, (error as Error).message);
    }
    throw error;
  }
}

async function startKxmRuntimeSupervisorInner(
  paths: KxmRuntimePaths,
  requestedPortOption: number | undefined,
  now: () => string,
): Promise<KxmRuntimeSupervisor> {
  mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.projectsDir, { recursive: true, mode: 0o700 });
  // The token is generated in memory and written only after the supervisor
  // singleton is owned: a losing supervisor can never overwrite a winner's
  // token and lock every client out.
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashKxmSupervisorToken(token);
  const registry = new KxmRuntimeRegistry(paths.registryDb);

  const runtimeId = `rtm_${createHash("sha256").update(`${paths.stateRoot}\0${process.pid}\0${now()}\0${randomBytes(16).toString("hex")}`, "utf8").digest("hex").slice(0, 24)}`;
  const requestedPort = requestedPortOption ?? 0;
  let activeRuntimeId = runtimeId;

  const contexts = new Map<string, KxmRuntimeContext>();
  const registerSyncCredentials = (context: KxmRuntimeContext): void => {
    // Register credentials on the store's redactor at context creation —
    // BEFORE any event can be appended — so the very first outbox row is
    // already scrubbed. Registering on the sync tick leaves a window where
    // appended events retain credentials.
    const hubToken = resolveClientHubAuthToken(process.env, context.projectId);
    if (hubToken) context.eventStore.syncRedactor.register(hubToken);
    for (const key of Object.keys(process.env)) {
      if ((key.startsWith("KXM_") && (key.endsWith("_TOKEN") || key.endsWith("_KEY"))) || key.endsWith("_API_KEY") || key.endsWith("_SECRET")) {
        const value = process.env[key]?.trim();
        if (value) context.eventStore.syncRedactor.register(value);
      }
    }
  };

  const contextFor = (projectRoot: string): KxmRuntimeContext => {
    if (!isAbsolute(projectRoot)) {
      throw runtimeError("runtime_request_invalid", "projectRoot", "projectRoot must be an absolute path");
    }
    const key = projectRuntimeKey(projectRoot);
    const existing = contexts.get(key);
    if (existing) return existing;
    const context = openKxmRuntimeContext(projectRoot, { homeRuntimeId: activeRuntimeId, stateRoot: paths.stateRoot });
    registerSyncCredentials(context);
    contexts.set(key, context);
    return context;
  };

  const requireAuth = (request: IncomingMessage): void => {
    const header = request.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const presentedHash = presented.length > 0 ? Buffer.from(hashKxmSupervisorToken(presented), "utf8") : Buffer.alloc(0);
    const expectedHash = Buffer.from(tokenHash, "utf8");
    if (presentedHash.length !== expectedHash.length || !timingSafeEqual(presentedHash, expectedHash)) {
      throw runtimeError("runtime_auth_failed", request.url ?? "<request>", "missing or invalid supervisor token");
    }
  };

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method === "GET" && url.pathname === "/healthz") {
          const nonce = url.searchParams.get("nonce") ?? "";
          sendJson(response, 200, {
            ok: true,
            runtimeId: activeRuntimeId,
            state: "running",
            // Proof of token knowledge: an impostor that merely binds the
            // stale port cannot answer the keyed challenge.
            tokenProof: nonce.length > 0 ? hashKxmTokenProof(token, nonce) : undefined,
          });
          return;
        }
        requireAuth(request);

        if (request.method === "POST" && url.pathname === "/v1/shutdown") {
          sendJson(response, 200, { ok: true, stopping: true });
          setImmediate(() => { void stop(); });
          return;
        }

        if (request.method === "POST" && url.pathname === "/v1/runs") {
          const body = await readJsonBody(request);
          const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot : "";
          const workflowId = typeof body.workflowId === "string" ? body.workflowId : "";
          const prompt = typeof body.prompt === "string" ? body.prompt : "";
          if (!projectRoot || !workflowId) {
            sendJson(response, 400, { ok: false, error: "runtime_request_invalid", message: "projectRoot and workflowId are required" });
            return;
          }
          const context = contextFor(projectRoot);
          const bundle = loadKxmProject(projectRoot, {});
          const acceptance = acceptKxmRun(context, bundle, {
            ...(typeof body.commandId === "string" && body.commandId.length > 0 ? { commandId: body.commandId } : {}),
            workflowId,
            prompt,
          });
          sendJson(response, 200, {
            ok: true,
            idempotent: acceptance.idempotent,
            run: acceptance.run,
            event: acceptance.event,
          });
          return;
        }

        const runMatch = /^\/v1\/runs\/([A-Za-z0-9_-]+)(?:\/(events|cancel|signal|wait|drive))?$/.exec(url.pathname);
        if (runMatch) {
          const runId = runMatch[1] as string;
          const sub = runMatch[2];
          const projectRoot = url.searchParams.get("projectRoot") ?? "";
          if (!projectRoot) {
            sendJson(response, 400, { ok: false, error: "runtime_request_invalid", message: "projectRoot query parameter is required" });
            return;
          }
          const context = contextFor(projectRoot);
          const bundle = loadKxmProject(projectRoot, {});
          if (request.method === "GET" && !sub) {
            const projected = projectKxmRunReadOnly(context, runId);
            const folded = foldStoredKxmRun(context, projected);
            const drive = kxmDrivePollProjection(context, runId, folded);
            sendJson(response, 200, { ok: true, run: projected, ...(drive !== undefined ? { drive } : {}) });
            return;
          }
          if (request.method === "POST" && sub === "drive") {
            const body = await readJsonBody(request);
            if (body.mode !== "simulated" && body.mode !== "live") {
              sendJson(response, 400, { ok: false, error: "runtime_request_invalid", message: "drive mode must be simulated or live" });
              return;
            }
            const run = context.eventStore.run(runId);
            if (!run) throw runtimeError("run_unknown", runId, "run not found");

            const delayMs = typeof body.delayMs === "number" && body.delayMs > 0 ? body.delayMs : 0;
            const createProducer = () => body.mode === "live"
              ? createKxmOneShotProducer({
                  projectRoot,
                  defaultHarness: String(bundle.project.value.defaultHarness ?? "pi"),
                  resolveHarness: (agentId) => {
                    const agent = bundle.agents.get(agentId);
                    return typeof agent?.value.harness === "string" ? agent.value.harness : undefined;
                  },
                  resolveModel: (agentId) => {
                    const agent = bundle.agents.get(agentId);
                    const model = agent?.value.model;
                    if (!model || typeof model !== "object" || Array.isArray(model)) return undefined;
                    const value = model as Record<string, unknown>;
                    const provider = typeof value.provider === "string" ? value.provider : undefined;
                    const modelName = typeof value.model === "string" ? value.model : undefined;
                    if (!provider || !modelName || !isRouteAdmitted(projectRoot, `${provider}/${modelName}`)) {
                      throw new Error("producer_route_not_admitted");
                    }
                    return { provider, model: modelName };
                  },
                })
              : createKxmSimulatedProducer(async () => {
                  if (delayMs > 0) {
                    await new Promise((r) => setTimeout(r, delayMs));
                  }
                  return { outcome: "passed" };
                });

            let session: Awaited<ReturnType<KxmRunScheduler["openDriveSession"]>> | undefined;
            let earlyError: unknown;
            try {
              const scheduler = KxmRunScheduler.for(context, bundle);
              const opening = scheduler.openDriveSession(runId, {
                mode: body.mode,
                allowLimits: false,
                liveMode: body.mode === "live",
                createProducer,
              });
              opening.catch((err) => { earlyError = err; });
              session = await opening;
            } catch (err) {
              earlyError = err;
            }

            if (earlyError) {
              const errStr = String(earlyError);
              if (errStr.includes("run_handoff_required")) {
                const handoff = (earlyError as { handoff?: unknown }).handoff;
                sendJson(response, 409, { ok: false, error: "run_handoff_required", ...(handoff !== undefined ? { handoff } : {}) });
                return;
              }
              if (errStr.includes("run_busy") || errStr.includes("scheduler_policy_conflict")) {
                sendJson(response, 409, { ok: false, error: "run_busy", message: `run ${runId} is already admitted or queued` });
                return;
              }
              throw earlyError;
            }

            void session!.settled.catch(() => {
              // Post-202 drive failures stay on the session; keep the request 202.
            });

            if (response.writableEnded) return;
            sendJson(response, 202, {
              ok: true,
              status: "accepted",
              runId,
              driveId: session!.driveId,
              poll: `/v1/runs/${runId}`,
              mode: body.mode,
            });
            return;
          }

          if (request.method === "GET" && sub === "events") {
            const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
            const events = context.eventStore.events(runId, Number.isFinite(after) && after >= 0 ? after : 0, 500);
            sendJson(response, 200, { ok: true, events });
            return;
          }

          if (request.method === "GET" && sub === "drive") {
            const run = context.eventStore.run(runId);
            if (!run) throw runtimeError("run_unknown", runId, "run not found");

            const activeSession = kxmDriveSession(context.eventStore.path, runId);
            const session = activeSession
              ? {
                  driveId: activeSession.driveId,
                  mode: activeSession.mode,
                  openedAt: activeSession.openedAt,
                  deadlineAt: activeSession.deadlineAt ?? null,
                }
              : null;
            const receipts = context.eventStore.driveReceiptsForRun(runId, 20);
            sendJson(response, 200, { ok: true, session, receipts });
            return;
          }
          if (request.method === "POST" && sub === "cancel") {
            const body = await readJsonBody(request);
            const result = cancelKxmRun(context, runId, {
              ...(typeof body.commandId === "string" && body.commandId.length > 0 ? { commandId: body.commandId } : {}),
            });
            sendJson(response, 200, { ok: true, idempotent: result.idempotent, run: result.run, events: result.events });
            return;
          }
          if (request.method === "POST" && sub === "signal") {
            const body = await readJsonBody(request);
            const run = context.eventStore.run(runId);
            if (!run) throw runtimeError("run_unknown", runId, "run not found");
            const state = foldStoredKxmRun(context, run);
            let unblocked = false;
            if (state.status === "blocked_uncertain" || state.status === "cancelling" || state.currentStep?.effectState === "blocked_uncertain") {
              const action = body.action === "cancel" || body.action === "fail" || body.action === "retry" || body.action === "unblock" ? body.action : "unblock";
              const rec = recoverKxmRun(context, runId, {
                action,
                reason: typeof body.summary === "string" ? body.summary : `signal_${body.signalKey ?? "callback"}`,
              });
              unblocked = rec.unblocked;
            }
            sendJson(response, 200, { ok: true, runId, signalKey: body.signalKey, status: body.status, unblocked });
            return;
          }
          if (request.method === "POST" && sub === "wait") {
            const body = await readJsonBody(request);
            const run = context.eventStore.run(runId);
            if (!run) throw runtimeError("run_unknown", runId, "run not found");
            sendJson(response, 200, { ok: true, runId, stageId: body.stageId, signalKey: body.signalKey, waiting: true });
            return;
          }
        }

        const driveMatch = /^\/v1\/drives\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
        if (request.method === "GET" && driveMatch) {
          const driveId = driveMatch[1] as string;
          const projectRoot = url.searchParams.get("projectRoot") ?? "";
          if (!projectRoot) {
            sendJson(response, 400, { ok: false, error: "runtime_request_invalid", message: "projectRoot query parameter is required" });
            return;
          }
          const context = contextFor(projectRoot);

          let receipt;
          try {
            receipt = context.eventStore.driveReceipt(driveId);
          } catch {
            sendJson(response, 200, { ok: true, receipt: null, verified: false, divergence: "receipt unreadable" });
            return;
          }

          if (!receipt) {
            sendJson(response, 404, { ok: false, error: "drive_receipt_missing", message: "receipt not found" });
            return;
          }

          const runId = receipt.runId;
          const stored = context.eventStore.run(runId);
          if (!stored) {
            sendJson(response, 200, { ok: true, receipt, verified: false, divergence: "run missing" });
            return;
          }
          const state = foldStoredKxmRun(context, stored);
          const events = context.eventStore.events(runId, 0, 1_000_000);
          const checked = verifyKxmDriveReceipt(receipt, events, state.status, { runId, driveId });
          sendJson(response, 200, {
            ok: true,
            receipt,
            verified: checked.verified,
            ...(checked.divergence !== undefined ? { divergence: checked.divergence } : {}),
          });
          return;
        }

        const projectRunsMatch = /^\/v1\/projects\/(prj_[A-Za-z0-9_-]+)\/runs$/.exec(url.pathname);
        if (request.method === "GET" && projectRunsMatch) {
          const projectRoot = url.searchParams.get("projectRoot") ?? "";
          if (!projectRoot) {
            sendJson(response, 400, { ok: false, error: "runtime_request_invalid", message: "projectRoot query parameter is required" });
            return;
          }
          const context = contextFor(projectRoot);
          const requestedProjectId = projectRunsMatch[1] as string;
          if (requestedProjectId !== context.projectId) {
            sendJson(response, 400, { ok: false, error: "runtime_request_invalid", message: `project ${requestedProjectId} is not the bound project ${context.projectId}` });
            return;
          }
          // The stored `runs` row is a cache, not the state: per-run reads fold the event
          // log (`projectKxmRunReadOnly`) precisely because the row can be stale. A listing
          // that returned raw rows would let every consumer — including the portal's
          // tenant read — present cached status as authoritative. Folding replays each
          // run's events; workflows are transition-bounded, so this stays cheap at the
          // 50-run cap. A run that refuses to fold is returned with its cached row plus
          // `projectionError`, so one corrupt run cannot make the listing lie by omission.
          const runs = context.eventStore.runsForProject(requestedProjectId, 50).map((stored) => {
            try {
              return projectKxmRunReadOnly(context, stored.runId);
            } catch (error) {
              return {
                ...stored,
                projectionError: error instanceof KxmConfigError
                  ? (error.issues[0]?.code ?? "runtime_projection_failed")
                  : "runtime_projection_failed",
              };
            }
          });
          sendJson(response, 200, { ok: true, runs });
          return;
        }

        sendJson(response, 404, { ok: false, error: "runtime_not_found" });
      } catch (error) {
        if (error instanceof KxmConfigError) {
          const code = error.issues[0]?.code ?? "runtime_error";
          const status = code === "runtime_auth_failed" ? 401 : code === "run_unknown" ? 404 : 400;
          sendJson(response, status, { ok: false, error: code, issues: error.issues });
          return;
        }
        sendJson(response, 500, { ok: false, error: "runtime_internal" });
      }
    })();
  });

  const port = await new Promise<number>((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(requestedPort, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        rejectPort(new Error("runtime supervisor did not bind"));
        return;
      }
      resolvePort(address.port);
    });
  });

  // Claim or take over the supervisor singleton.
  const claim = registry.claimSupervisor({ runtimeId, pid: process.pid, port, tokenHash, now: now() });
  if (!claim.claimed) {
    const existing = claim.record;
    // Only a genuinely live supervisor (running, fresh heartbeat, live pid)
    // conflicts. A cleanly stopped or stale supervisor may be replaced.
    const heartbeatAgeMs = Date.now() - Date.parse(existing.heartbeatAt);
    const fresh = Number.isFinite(heartbeatAgeMs) && heartbeatAgeMs < HEARTBEAT_STALE_MS;
    if (existing.state === "running" && fresh && processAlive(existing.pid)) {
      registry.close();
      server.close();
      throw runtimeError("runtime_supervisor_conflict", paths.registryDb, `runtime supervisor is already managed by PID ${existing.pid}`);
    }
    try {
      const takeover = registry.takeoverSupervisor({ runtimeId, pid: process.pid, port, tokenHash, now: now(), observedDeadPid: existing.pid, observedHeartbeatAt: existing.heartbeatAt });
      activeRuntimeId = takeover.runtimeId;
    } catch (error) {
      registry.close();
      server.close();
      throw error;
    }
  }

  // Ownership is established: publish the token atomically so concurrent
  // readers never see a truncated file, and clear any stale startup error.
  try {
    publishKxmSupervisorToken(paths, token);
    clearSupervisorError(paths);
  } catch (error) {
    registry.close();
    server.close();
    throw error;
  }

  const heartbeat = setInterval(() => {
    try {
      const changes = registry.heartbeat(process.pid, now());
      if (changes === 0 && !stopping) {
        // The singleton was taken over by another process: this supervisor is
        // superseded and must not linger as an unreachable zombie.
        void stop().finally(() => process.exit(0));
      }
    } catch { /* registry closed during shutdown */ }
  }, 1000);
  heartbeat.unref();

  // Outbound only: the supervisor pulls nothing and exposes nothing to the hub.
  // A tick that finds no bound hub, no credential or an unreachable hub does
  // nothing; outbox rows stay pending and local execution never waits on it.
  //
  // Restart recovery: contexts are only populated on demand (a project request
  // opens one), so a restarted supervisor would see an empty map and silently
  // stop syncing every registered project's pending outbox rows. Reopen the
  // projects this Runtime owns before the first tick.
  for (const reg of registry.projectsForRuntime(activeRuntimeId)) {
    try {
      contextFor(reg.projectRoot);
    } catch {
      // A project whose checkout has moved or been deleted stays skipped; its
      // outbox rows remain pending and its presence expires, which is visible
      // in the ops snapshot as orphaned.
    }
  }

  let syncing = false;
  const syncTimer = setInterval(() => {
    if (syncing || stopping) return;
    syncing = true;
    void (async () => {
      for (const context of [...contexts.values()]) {

        try {
          const client = runtimeHubClientFor(context, process.env);
          if (!client) continue;
          await client.heartbeat();
          await syncKxmOutbox(context.eventStore, client, { now });
        } catch {
          // Retry on the next tick.
        }
      }
    })().finally(() => { syncing = false; });
  }, runtimeSyncIntervalMs());
  syncTimer.unref();

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    clearInterval(syncTimer);
    try { registry.markStopping(process.pid, now()); } catch { /* best effort */ }
    const openSessions = [...contexts.values()].flatMap((context) => (
      kxmOpenDriveSessions(context.eventStore.path).map((session) => ({ context, session }))
    ));
    for (const { context, session } of openSessions) {
      try {
        cancelKxmRun(context, session.runId, { reason: "runtime_shutdown" });
      } catch {
        // Terminal or already cancelling runs still release on session settle.
      }
      try {
        session.controller.abort();
      } catch {
        // Session abort is best-effort after cancel is recorded.
      }
    }
    await waitForDriveSessions(openSessions.map(({ session }) => session.settled), runtimeStopGraceMs());
    for (const { context, session } of openSessions) {
      if (!(await driveSessionStillPending(session.settled))) continue;
      recordDriveReceipt(context, session, {
        kind: "unsettled",
        reason: "runtime_shutdown_grace_expired",
        producerId: session.producerId,
        producerClosed: false,
      });
    }
    for (const context of contexts.values()) closeKxmRuntimeContext(context);
    contexts.clear();
    const closed = new Promise<void>((resolveStop) => server.close(() => resolveStop()));
    server.closeIdleConnections?.();
    await closed;
    try { registry.markStopped(process.pid, now()); } catch { /* best effort */ }
    registry.close();
  };

  process.once("SIGINT", () => { void stop().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void stop().finally(() => process.exit(0)); });

  return { server, port, runtimeId: activeRuntimeId, stop };
}

/* ------------------------------------------------------------------ *
 * Thin client used by the CLI
 * ------------------------------------------------------------------ */

export async function kxmRuntimeRequest(
  handle: KxmSupervisorHandle,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${handle.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof payload.error === "string" ? payload.error : "runtime_request_failed";
    const message = typeof payload.message === "string" ? payload.message : `runtime request failed with HTTP ${response.status}`;
    throw runtimeError(code, path, message);
  }
  return payload;
}

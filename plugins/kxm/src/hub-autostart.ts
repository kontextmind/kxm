import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { probeHubHealth, readHubBinding } from "./hub-binding.ts";
import { resolveHubCredentials } from "./hub-env.ts";
import { findKxmRepoRoot } from "./repo-root.ts";
import { redactSecrets } from "./redact.ts";

/** Background hub auto-start for harness extensions (Pi TUI, one-shot CLIs).
 *
 * On extension load: reuse a healthy bound hub, then a live local `hub.pid`
 * claim, and only then spawn the detached `kxm-hub.mjs` wrapper. Credentials
 * are resolved before launch, so a first run generates the admin token and
 * persists it (`0600`) under the user state root, exactly as
 * `kxm hub start` does. The single-hub-per-user invariants (exclusive PID
 * claim, reclaimed dead wrappers) come from the wrapper itself. */

export const HUB_AUTOSTART_LOG_NAME = "hub-autostart.log";
const CLAIM_POLL_MS = 50;
const DEFAULT_CLAIM_TIMEOUT_MS = 3000;

export type HubAutoStartMode = "off" | "background";

export type EnsureHubResult =
  | { status: "disabled" }
  | { status: "bound-healthy"; url: string }
  | { status: "url-healthy"; url: string }
  | { status: "claim-alive"; pid: number }
  | { status: "started"; pid: number; logPath: string; authToken: string | undefined; authTokenSource: string }
  | { status: "failed"; reason: string; logPath: string };

export interface HubSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["ignore", number, number];
  detached: boolean;
  windowsHide: boolean;
}

export interface HubSpawned {
  pid?: number | undefined;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export type HubSpawner = (command: string, args: readonly string[], options: HubSpawnOptions) => HubSpawned;

export interface EnsureHubOptions {
  config: { hub?: { autoStart?: unknown } } | undefined;
  cwd: string;
  env?: NodeJS.ProcessEnv | undefined;
  fetchImpl?: typeof fetch | undefined;
  spawner?: HubSpawner | undefined;
  processExists?: ((pid: number) => boolean) | undefined;
  scriptPath?: string | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  claimTimeoutMs?: number | undefined;
}

/** Resolve the configured auto-start mode; unknown values fail closed to the
 * default so a typo never silently disables (or re-enables) hub startup. */
export function hubAutoStartMode(config: { hub?: { autoStart?: unknown } } | undefined): HubAutoStartMode {
  const raw = config?.hub?.autoStart;
  return raw === "off" || raw === "background" ? raw : "background";
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface HubClaimSnapshot {
  pid: number;
  serverPid: number | undefined;
}

/** Read the workspace hub PID claim. A missing or malformed claim is not
 * live; the wrapper fails closed on malformed claims when it starts, so the
 * extension must not try to clean claims up itself. */
export function readLiveHubClaim(stateDir: string, processExists: (pid: number) => boolean = defaultProcessExists): HubClaimSnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(stateDir, "hub.pid"), "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as { version?: unknown; role?: unknown; pid?: unknown; serverPid?: unknown };
  if (record.version !== 1 || record.role !== "hub" || !Number.isInteger(record.pid)) return undefined;
  const pid = record.pid as number;
  if (pid <= 0 || !processExists(pid)) return undefined;
  return {
    pid,
    ...(Number.isInteger(record.serverPid) && (record.serverPid as number) > 0 ? { serverPid: record.serverPid as number } : { serverPid: undefined }),
  };
}

/** The hub wrapper script at the KXM repo/package root. The extension and
 * the CLI both resolve the same path so auto-start launches the identical
 * supervision wrapper as `kxm hub start`. */
export function defaultHubWrapperScriptPath(moduleUrl: string = import.meta.url): string {
  return join(findKxmRepoRoot(moduleUrl), "scripts", "kxm-hub.mjs");
}

function defaultHubSpawner(command: string, args: readonly string[], options: HubSpawnOptions): HubSpawned {
  const child = spawn(command, [...args], options);
  child.unref();
  return child;
}

function logTail(logPath: string, maxChars = 2000): string {
  try {
    return redactSecrets(readFileSync(logPath, "utf8").trim().slice(-maxChars));
  } catch {
    return "";
  }
}

/** Ensure a hub is available, starting a detached one only when no healthy
 * bound hub and no live local claim exists. Never throws for ordinary
 * failures; structured results let callers notify without blocking load. */
export async function ensureHubRunning(options: EnsureHubOptions): Promise<EnsureHubResult> {
  const env = options.env ?? process.env;
  if (hubAutoStartMode(options.config) !== "background") return { status: "disabled" };

  // 1. A bound hub that answers health is authoritative — reuse it.
  const binding = readHubBinding(env);
  const fetchImpl = options.fetchImpl ?? fetch;
  if (binding) {
    const { health } = await probeHubHealth(binding.url, fetchImpl);
    if (health === "on") return { status: "bound-healthy", url: binding.url };
  }

  // 2. A live local claim means a hub (started any way) already owns this
  //    workspace state — do not start a second one.
  const workdir = resolve(env.KXM_WORKDIR?.trim() || options.cwd);
  const workspaceDir = resolve(workdir, env.KXM_WORKSPACE_DIR?.trim() || ".kxm");
  const stateDir = resolve(workdir, env.KXM_STATE_DIR?.trim() || join(workspaceDir, "state"));
  const logsDir = resolve(workdir, env.KXM_LOGS_DIR?.trim() || join(workspaceDir, "logs"));
  const processExists = options.processExists ?? defaultProcessExists;
  const live = readLiveHubClaim(stateDir, processExists);
  if (live) return { status: "claim-alive", pid: live.pid };

  // 3. A hub already serving the configured URL (for example one launched
  //    directly by a harness, without a claim or binding) is reused too: the
  //    client will connect there regardless, so spawning a duplicate would
  //    only fail to bind the same port.
  const serverUrl = (env.KXM_SERVER_URL?.trim() || "http://127.0.0.1:7331").replace(/\/+$/, "");
  if (serverUrl !== binding?.url) {
    const { health } = await probeHubHealth(serverUrl, fetchImpl);
    if (health === "on") return { status: "url-healthy", url: serverUrl };
  }

  // 4. Resolve credentials before launch so the key exists by the time the
  //    wrapper starts: env wins, then the persisted user-state file, then a
  //    generated token persisted with 0600 for later restarts and workers.
  const credentials = resolveHubCredentials({ env });
  const logPath = join(logsDir, HUB_AUTOSTART_LOG_NAME);
  mkdirSync(logsDir, { recursive: true });
  const logFd = openSync(logPath, "a");
  let child: HubSpawned;
  try {
    child = (options.spawner ?? defaultHubSpawner)(process.execPath, [options.scriptPath ?? defaultHubWrapperScriptPath()], {
      cwd: workdir,
      env: {
        ...env,
        KXM_WORKDIR: workdir,
        KXM_WORKSPACE_DIR: workspaceDir,
        KXM_STATE_DIR: stateDir,
        KXM_LOGS_DIR: logsDir,
        ...(credentials.authToken ? { KXM_AUTH_TOKEN: credentials.authToken } : {}),
      },
      stdio: ["ignore", logFd, logFd],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } finally {
    closeSync(logFd);
  }

  // 4. Verify the wrapper claimed the hub. A simultaneous loader may have won
  //    the exclusive claim first; that is a live hub, not a failure.
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const now = options.now ?? Date.now;
  const timeoutMs = options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
  let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.once("exit", (code, signal) => {
    earlyExit = { code, signal };
  });
  const deadline = now() + timeoutMs;
  for (;;) {
    if (earlyExit) {
      // A simultaneous loader may have won the exclusive claim first; that
      // is a live hub, not a failure.
      const raced = readLiveHubClaim(stateDir, processExists);
      if (raced) return { status: "claim-alive", pid: raced.pid };
      const detail = logTail(logPath);
      const reason = `hub wrapper exited before claiming the hub (code ${earlyExit.code ?? "null"}${earlyExit.signal ? `, signal ${earlyExit.signal}` : ""})${detail ? `: ${detail}` : ""}`;
      return { status: "failed", reason, logPath };
    }
    const claimed = readLiveHubClaim(stateDir, processExists);
    if (claimed) return { status: "started", pid: claimed.pid, logPath, authToken: credentials.authToken, authTokenSource: credentials.authTokenSource };
    if (now() >= deadline) {
      return child.pid
        ? { status: "started", pid: child.pid, logPath, authToken: credentials.authToken, authTokenSource: credentials.authTokenSource }
        : { status: "failed", reason: `hub wrapper did not claim the hub within ${timeoutMs} ms`, logPath };
    }
    await sleep(CLAIM_POLL_MS);
  }
}

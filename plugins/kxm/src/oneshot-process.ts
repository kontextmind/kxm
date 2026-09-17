import { spawn } from "node:child_process";

export interface KxmOneShotProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: NodeJS.Signals | null | undefined;
  observedChildExit?: boolean | undefined;
  started?: boolean | undefined;
  /** Stop was requested; direct-child reaping cannot attest escaped descendants. */
  terminationRequested?: boolean | undefined;
  /**
   * Direct-child close/reap is not descendant death. Unobserved process-group
   * members stay unverified: never success, never a forged descendant failure.
   */
  unverifiedDescendants?: boolean | undefined;
  error?: Error | undefined;
}

export interface KxmOneShotSpawnOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  input?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Only allowlisted Windows `.cmd` probes may set this; never a user string. */
  shell?: boolean | undefined;
}
export type KxmOneShotSpawn = (command: string, args: readonly string[], options: KxmOneShotSpawnOptions) => Promise<KxmOneShotProcessResult>;

const OUTPUT_LIMIT = 8 * 1024 * 1024;
const KILL_GRACE_MS = 250;
const DRAIN_GRACE_MS = 500;
const REAP_GRACE_MS = 1000;

/**
 * POSIX process-group tree kill with fallback to direct child kill.
 * Ensures orphaned subshells, test workers, and background daemons are pruned on cancellation/timeout.
 */
export function killProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals = "SIGKILL"): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to direct child kill if process group is unavailable
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Direct kill error if child already exited
  }
}

/** Bound both execution and pipe drain. Observing exit is not proof of descendant death. */
export function defaultSpawn(command: string, args: readonly string[], options: KxmOneShotSpawnOptions): Promise<KxmOneShotProcessResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({ stdout: "", stderr: "", code: null, started: false, observedChildExit: false, error: new Error("process_aborted") });
  }
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputChunks = 0;
    let code: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let observedChildExit = false;
    let finished = false;
    let stopping = false;
    let closed = false;
    let killSent = false;
    let error: Error | undefined;
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;
    const finish = (): void => {
      if (finished) return;
      // Direct-child close must not cancel SIGTERM → SIGKILL. Refuse to settle
      // until the group kill has been sent, then reap on the existing timers.
      if (stopping && !killSent) return;
      finished = true;
      for (const timer of [wallTimer, killTimer, drainTimer, reapTimer]) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
      const started = Boolean(child?.pid);
      if (started && !observedChildExit) error ??= new Error("process_exit_unobserved");
      const unverifiedDescendants = stopping || (started && !observedChildExit);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
        signal,
        started,
        observedChildExit,
        terminationRequested: stopping,
        ...(unverifiedDescendants ? { unverifiedDescendants: true } : {}),
        ...(error ? { error } : {}),
      });
    };
    const kill = (requested: NodeJS.Signals): void => {
      killProcessTree(child, requested);
    };
    const stop = (reason: string): void => {
      if (finished) return;
      error ??= new Error(reason);
      if (stopping) return;
      stopping = true;
      clearTimeout(wallTimer);
      kill("SIGTERM");
      killTimer = setTimeout(() => {
        kill("SIGKILL");
        killSent = true;
        if (closed) { finish(); return; }
        reapTimer = setTimeout(() => {
          if (!observedChildExit) error ??= new Error("process_exit_unobserved");
          finish();
        }, REAP_GRACE_MS);
      }, KILL_GRACE_MS);
    };
    const onAbort = (): void => stop("process_aborted");
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: options.shell === true,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error("process_spawn_failed");
      finish();
      return;
    }
    const collect = (target: Buffer[], chunk: Buffer | string): void => {
      if (finished) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, OUTPUT_LIMIT - outputBytes);
      if (remaining && outputChunks < 16384) {
        const kept = bytes.subarray(0, remaining);
        target.push(kept);
        outputBytes += kept.length;
        outputChunks++;
      }
      if (bytes.length > remaining || outputChunks >= 16384) stop("process_output_limit");
    };
    child.stdout!.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr!.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdin!.on("error", () => stop("process_stdin_error"));
    child.stdout!.on("error", () => stop("process_stdio_error"));
    child.stderr!.on("error", () => stop("process_stdio_error"));
    child.on("error", (cause) => {
      error ??= cause;
      if (!child.pid) finish();
      else stop("process_error");
    });
    child.on("exit", (exitCode, exitSignal) => {
      if (finished) return;
      observedChildExit = true;
      code = exitCode;
      signal = exitSignal;
      clearTimeout(wallTimer);
      drainTimer = setTimeout(() => stop("process_stdio_unclosed"), DRAIN_GRACE_MS);
    });
    child.on("close", (exitCode, exitSignal) => {
      if (finished) return;
      closed = true;
      code = exitCode;
      signal = exitSignal;
      // The leader can exit and close its pipes while a descendant ignores TERM.
      // finish() no-ops until SIGKILL when escalation is in flight.
      finish();
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (!stopping) wallTimer = setTimeout(() => stop("process_timeout"), timeoutMs > 0 && Number.isFinite(timeoutMs) ? timeoutMs : 120_000);
    try { child.stdin!.end(options.input); }
    catch { stop("process_stdin_error"); }
  });
}

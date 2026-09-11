import { spawn } from "node:child_process";

export interface VnextOneShotProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: NodeJS.Signals | null | undefined;
  observedChildExit?: boolean | undefined;
  started?: boolean | undefined;
  /** Stop was requested; direct-child reaping cannot attest escaped descendants. */
  terminationRequested?: boolean | undefined;
  error?: Error | undefined;
}

export interface VnextOneShotSpawnOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  input?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}
export type VnextOneShotSpawn = (command: string, args: readonly string[], options: VnextOneShotSpawnOptions) => Promise<VnextOneShotProcessResult>;

const OUTPUT_LIMIT = 8 * 1024 * 1024;
const KILL_GRACE_MS = 250;
const DRAIN_GRACE_MS = 500;
const REAP_GRACE_MS = 1000;

/** Bound both execution and pipe drain. Observing exit is not proof of descendant death. */
export function defaultSpawn(command: string, args: readonly string[], options: VnextOneShotSpawnOptions): Promise<VnextOneShotProcessResult> {
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
      finished = true;
      for (const timer of [wallTimer, killTimer, drainTimer, reapTimer]) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
      const started = Boolean(child?.pid);
      if (started && !observedChildExit) error ??= new Error("process_exit_unobserved");
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code, signal, started, observedChildExit, terminationRequested: stopping, ...(error ? { error } : {}) });
    };
    const kill = (requested: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, requested);
        else child.kill(requested);
      } catch { /* Reaping, not kill() success, establishes direct-child exit. */ }
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
        shell: false,
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
      // Never cancel the pending group escalation just because close arrived.
      if (!stopping || killSent) finish();
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (!stopping) wallTimer = setTimeout(() => stop("process_timeout"), timeoutMs > 0 && Number.isFinite(timeoutMs) ? timeoutMs : 120_000);
    try { child.stdin!.end(options.input); }
    catch { stop("process_stdin_error"); }
  });
}

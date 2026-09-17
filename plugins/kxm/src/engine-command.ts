import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type { KxmGateObservationInput } from "./engine-gate-records.ts";
import type { KxmGateErrorClass, KxmGateStopCause } from "./runtime-store.ts";
import { runtimeError } from "./runtime-store.ts";
import { assertCommandSeatbelt } from "./safety-integrity.ts";

const MAX_DIRECT_TIMER_MS = 2_147_483_647;
export const COMMAND_TERM_GRACE_MS = 2000;
export const COMMAND_FINAL_WAIT_MS = 2000;
export const COMMAND_LINGER_MS = 2000;

export interface KxmCommandDefinition {
  readonly kind: "command";
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly cwd?: "control";
}

export interface KxmCommandGateSeams {
  timing?: { termGraceMs?: number; finalWaitMs?: number; lingerMs?: number } | undefined;
  beforeSpawn?: ((definition: KxmCommandDefinition) => void) | undefined;
  afterSpawned?: ((pid: number) => void) | undefined;
  afterStopRequested?: ((cause: KxmGateStopCause) => void) | undefined;
  afterChildClose?: (() => void) | undefined;
}

export const kxmCommandGateSeams: KxmCommandGateSeams = {};

export type KxmCommandOutcome =
  | { kind: "no-start"; observation: KxmGateObservationInput }
  | { kind: "complete"; observation: KxmGateObservationInput }
  | { kind: "uncertain"; reason: string; observation: KxmGateObservationInput };

/**
 * Post-spawn ChildProcess `error` is an uncertain stopCause `error`.
 * The fold reason enum has no post-spawn spawn-error member, so the closed
 * classification keeps errorClass `stream-error` rather than adding a store enum.
 */
export const POST_SPAWN_CHILD_ERROR_CLASS: KxmGateErrorClass = "stream-error";

export interface KxmCommandObserver {
  requestStop(cause: KxmGateStopCause, errorClass?: KxmGateErrorClass): void;
  beginBoundedCleanup(): void;
  run(): Promise<KxmCommandOutcome>;
}

export function createCommandObserver(input: {
  definition: KxmCommandDefinition;
  cwd: string;
  signal: AbortSignal;
  onSpawned: (pid: number) => void;
}): KxmCommandObserver {
  return new CommandObserver(input);
}

class StreamDigest {
  private readonly hash = createHash("sha256");
  bytes = 0;
  complete: 0 | 1 = 0;
  digest(): string {
    return `sha256:${this.hash.copy().digest("hex")}`;
  }
  write(chunk: Buffer): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
  }
  end(): void {
    this.complete = 1;
  }
}

class CommandObserver implements KxmCommandObserver {
  private readonly definition: KxmCommandDefinition;
  private readonly cwd: string;
  private readonly signal: AbortSignal;
  private readonly onSpawned: (pid: number) => void;
  private readonly termGraceMs: number;
  private readonly finalWaitMs: number;
  private readonly lingerMs: number;
  private child: ChildProcess | undefined;
  private observedPid: number | undefined;
  private canSignal = true;
  private handedOff = false;
  private cleanupStarted = false;
  private spawnSeen = 0 as 0 | 1;
  private exitObserved = 0 as 0 | 1;
  private closeObserved = 0 as 0 | 1;
  private exitCode: number | null = null;
  private signalName: string | null = null;
  private stopCause: KxmGateStopCause = "none";
  private signalsAttempted: "none" | "term" | "term-kill" = "none";
  private errorClass: KxmGateErrorClass | null = null;
  private startedAt: string;
  private finishedAt: string | null = null;
  private readonly startedMono = process.hrtime.bigint();
  private readonly stdout = new StreamDigest();
  private readonly stderr = new StreamDigest();
  private timeoutTimer: NodeJS.Timeout | undefined;
  private termTimer: NodeJS.Timeout | undefined;
  private finalTimer: NodeJS.Timeout | undefined;
  private lingerTimer: NodeJS.Timeout | undefined;
  private resolveOutcome: ((outcome: KxmCommandOutcome) => void) | undefined;
  private readonly abortListener: () => void;

  constructor(input: {
    definition: KxmCommandDefinition;
    cwd: string;
    signal: AbortSignal;
    onSpawned: (pid: number) => void;
  }) {
    this.definition = input.definition;
    this.cwd = input.cwd;
    this.signal = input.signal;
    this.onSpawned = input.onSpawned;
    const timing = kxmCommandGateSeams.timing;
    this.termGraceMs = clampTimer(timing?.termGraceMs ?? COMMAND_TERM_GRACE_MS);
    this.finalWaitMs = clampTimer(timing?.finalWaitMs ?? COMMAND_FINAL_WAIT_MS);
    this.lingerMs = clampTimer(timing?.lingerMs ?? COMMAND_LINGER_MS);
    this.startedAt = new Date().toISOString();
    this.abortListener = () => this.requestStop("cancel");
  }

  requestStop(cause: KxmGateStopCause, errorClass?: KxmGateErrorClass): void {
    if (cause === "none") return;
    if (this.stopCause === "none") {
      this.stopCause = cause;
      if (errorClass && this.errorClass === null) this.errorClass = errorClass;
      kxmCommandGateSeams.afterStopRequested?.(cause);
      this.clearTimer("linger");
      this.beginSignalSequence();
      return;
    }
    if (errorClass && this.errorClass === null) this.errorClass = errorClass;
  }

  beginBoundedCleanup(): void {
    this.cleanupStarted = true;
    this.requestStop("error", "lost-close");
  }

  run(): Promise<KxmCommandOutcome> {
    return new Promise((resolve) => {
      this.resolveOutcome = resolve;
      try {
        this.start();
      } catch (error) {
        if (this.child !== undefined || this.spawnSeen === 1 || this.observedPid !== undefined) {
          // A child may already exist; never fabricate no-start after spawn.
          this.requestStop("error", "stop-error");
          return;
        }
        this.finishNoStart("validation", error);
      }
    });
  }

  private start(): void {
    if (this.signal.aborted || this.cleanupStarted) {
      this.finishNoStart(this.signal.aborted ? "cancel" : "lost-close");
      return;
    }
    try {
      kxmCommandGateSeams.beforeSpawn?.(this.definition);
    } catch {
      this.finishNoStart("validation");
      return;
    }
    if (this.signal.aborted || this.cleanupStarted) {
      this.finishNoStart(this.signal.aborted ? "cancel" : "lost-close");
      return;
    }
    if (
      !Number.isInteger(this.definition.timeoutMs)
      || this.definition.timeoutMs < 1
      || this.definition.timeoutMs > MAX_DIRECT_TIMER_MS
    ) {
      throw runtimeError("run_events_illegal", "command", "command timeoutMs exceeds the direct timer bound");
    }
    assertCommandSeatbelt(this.definition.argv.join(" "));
    this.startedAt = new Date().toISOString();
    let child: ChildProcess;
    try {
      child = spawn(this.definition.argv[0]!, this.definition.argv.slice(1), {
        cwd: this.cwd,
        env: process.env,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      this.finishNoStart("validation");
      return;
    }
    this.child = child;
    // child.pid is set synchronously on successful spawn; observe it now so an
    // early stop/cleanup before the async "spawn" event can never be classified
    // as no-start while a live child exists.
    this.observePid(child.pid);
    this.armTimeout();
    this.signal.addEventListener("abort", this.abortListener);
    this.attachChild(child);
  }

  private attachChild(child: ChildProcess): void {
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.handedOff) return;
      try {
        this.stdout.write(chunk);
      } catch {
        this.requestStop("error", "stream-error");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (this.handedOff) return;
      try {
        this.stderr.write(chunk);
      } catch {
        this.requestStop("error", "stream-error");
      }
    });
    child.stdout?.on("end", () => {
      if (this.handedOff) return;
      try {
        this.stdout.end();
      } catch {
        this.requestStop("error", "stream-error");
      }
    });
    child.stderr?.on("end", () => {
      if (this.handedOff) return;
      try {
        this.stderr.end();
      } catch {
        this.requestStop("error", "stream-error");
      }
    });
    child.stdout?.on("error", () => this.requestStop("error", "stream-error"));
    child.stderr?.on("error", () => this.requestStop("error", "stream-error"));
    child.once("spawn", () => {
      this.spawnSeen = 1;
      this.observePid(child.pid);
      if (this.observedPid !== undefined) {
        this.notifySpawned();
      } else {
        this.requestStop("error", POST_SPAWN_CHILD_ERROR_CLASS);
      }
    });
    child.once("error", () => {
      if (this.spawnSeen === 0 && child.pid == null && this.observedPid === undefined) {
        this.finishNoStart("spawn-error");
        return;
      }
      if (this.spawnSeen === 0) {
        this.spawnSeen = 1;
        this.observePid(child.pid);
        this.notifySpawned();
      }
      this.requestStop("error", POST_SPAWN_CHILD_ERROR_CLASS);
    });
    child.once("exit", (code, signal) => {
      this.exitObserved = 1;
      this.exitCode = code;
      this.signalName = signal;
      if (this.closeObserved === 1) {
        this.handoff();
        return;
      }
      this.armLinger();
    });
    child.once("close", () => {
      this.closeObserved = 1;
      this.finishedAt = new Date().toISOString();
      this.canSignal = false;
      this.clearTimer("term");
      this.clearTimer("final");
      this.clearTimer("linger");
      this.clearTimer("timeout");
      child.stdout?.destroy();
      child.stderr?.destroy();
      dropKxmCommandStopCapability(this);
      try {
        kxmCommandGateSeams.afterChildClose?.();
      } catch {
        // test seam
      }
      this.handoff();
    });
  }

  private notifiedSpawned = false;

  private observePid(pid: number | undefined): void {
    if (this.observedPid === undefined && typeof pid === "number" && pid > 0) {
      this.observedPid = pid;
    }
  }

  private notifySpawned(): void {
    if (this.notifiedSpawned || this.observedPid === undefined) return;
    this.notifiedSpawned = true;
    try {
      this.onSpawned(this.observedPid);
    } catch {
      this.requestStop("error", "recording-error");
    }
    try {
      kxmCommandGateSeams.afterSpawned?.(this.observedPid);
    } catch {
      this.requestStop("error", "recording-error");
    }
  }

  private armTimeout(): void {
    this.timeoutTimer = schedule(this.definition.timeoutMs, () => {
      this.requestStop("timeout");
    });
  }

  private armLinger(): void {
    if (this.stopCause !== "none") return;
    if (this.lingerTimer || this.closeObserved === 1) return;
    this.lingerTimer = schedule(this.lingerMs, () => {
      this.requestStop("error", "lost-close");
    });
  }

  private beginSignalSequence(): void {
    if (this.closeObserved === 1 || this.handedOff) {
      this.handoff();
      return;
    }
    const pid = this.observedPid;
    if (!this.canSignal || pid === undefined) {
      this.armFinal();
      return;
    }
    this.signalGroup(pid, "SIGTERM", "term");
    this.termTimer = schedule(this.termGraceMs, () => {
      if (this.closeObserved === 1 || this.handedOff) return;
      if (!this.canSignal || this.observedPid === undefined) {
        this.armFinal();
        return;
      }
      this.signalGroup(this.observedPid, "SIGKILL", "term-kill");
      this.armFinal();
    });
  }

  private signalGroup(pid: number, signal: NodeJS.Signals, attempted: "term" | "term-kill"): void {
    if (!this.canSignal || this.closeObserved === 1 || pid <= 0) return;
    try {
      process.kill(-pid, signal);
      this.signalsAttempted = attempted;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        this.canSignal = false;
        return;
      }
      if (this.errorClass === null) this.errorClass = "stop-error";
    }
  }

  private armFinal(): void {
    if (this.finalTimer) return;
    this.finalTimer = schedule(this.finalWaitMs, () => {
      this.canSignal = false;
      this.handoff();
    });
  }

  private finishNoStart(kind: "validation" | "spawn-error" | "cancel" | "lost-close", _error?: unknown): void {
    if (this.handedOff) return;
    if (kind === "lost-close" && this.spawnSeen === 1) {
      this.requestStop("error", "lost-close");
      return;
    }
    const now = new Date().toISOString();
    const cancel = kind === "cancel";
    this.handoffWith({
      kind: "no-start",
      observation: this.baseObservation({
        completeness: "no-start",
        spawned: 0,
        pid: null,
        exitCode: null,
        signal: null,
        exitObserved: 0,
        closeObserved: 0,
        stopCause: cancel ? "cancel" : "none",
        signalsAttempted: "none",
        errorClass: cancel ? null : kind === "spawn-error" ? "spawn-error" : "validation",
        stdoutSha256: null,
        stdoutBytes: null,
        stdoutComplete: null,
        stderrSha256: null,
        stderrBytes: null,
        stderrComplete: null,
        finishedAt: now,
      }),
    });
  }

  private handoff(): void {
    if (this.handedOff) return;
    if (this.spawnSeen === 0 && this.observedPid === undefined) {
      if (this.stopCause === "cancel" || this.signal.aborted) {
        this.finishNoStart("cancel");
        return;
      }
      if (this.errorClass === "spawn-error") {
        this.finishNoStart("spawn-error");
        return;
      }
      this.finishNoStart("validation");
      return;
    }
    const observation = this.snapshot();
    if (isCompleteNormal(observation)) {
      this.handoffWith({ kind: "complete", observation });
      return;
    }
    this.handoffWith({
      kind: "uncertain",
      reason: this.uncertaintyReason(observation),
      observation: { ...observation, completeness: "incomplete" },
    });
  }

  private uncertaintyReason(observation: KxmGateObservationInput): string {
    // Requested primary cause is independent of the later observed exit signal.
    // Signal-termination is only for an externally signalled exit with no earlier request.
    if (this.stopCause === "timeout") return "timeout";
    if (this.stopCause === "cancel") return "cancel";
    if (this.errorClass === "recording-error") return "recording-error";
    if (this.errorClass === "lost-close" || (this.exitObserved === 1 && this.closeObserved === 0)) return "lost-close";
    if (this.errorClass === "stop-error") return "stop-error";
    if (this.errorClass === "stream-error") return "stream-error";
    if (this.stopCause === "error") return "stream-error";
    if (observation.signal !== null) return "signal-termination";
    return "stop-error";
  }

  private snapshot(): KxmGateObservationInput {
    return this.baseObservation({
      completeness: "complete",
      spawned: this.spawnSeen,
      pid: this.observedPid ?? null,
      exitCode: this.signalName !== null ? null : this.exitCode,
      signal: this.signalName,
      exitObserved: this.exitObserved,
      closeObserved: this.closeObserved,
      stopCause: this.stopCause,
      signalsAttempted: this.signalsAttempted,
      errorClass: this.errorClass,
      stdoutSha256: this.stdout.digest(),
      stdoutBytes: this.stdout.bytes,
      stdoutComplete: this.stdout.complete,
      stderrSha256: this.stderr.digest(),
      stderrBytes: this.stderr.bytes,
      stderrComplete: this.stderr.complete,
      finishedAt: this.finishedAt,
    });
  }

  private baseObservation(
    facts: Omit<KxmGateObservationInput, "checkedCount" | "failedCount" | "elapsedMs" | "startedAt"> & {
      elapsedMs?: number;
      startedAt?: string;
    },
  ): KxmGateObservationInput {
    const elapsedNs = process.hrtime.bigint() - this.startedMono;
    return {
      ...facts,
      checkedCount: null,
      failedCount: null,
      elapsedMs: facts.elapsedMs ?? Math.max(0, Math.floor(Number(elapsedNs) / 1_000_000)),
      startedAt: facts.startedAt ?? this.startedAt,
    };
  }

  private handoffWith(outcome: KxmCommandOutcome): void {
    if (this.handedOff) return;
    this.handedOff = true;
    this.canSignal = false;
    this.signal.removeEventListener("abort", this.abortListener);
    this.clearTimer("timeout");
    this.clearTimer("term");
    this.clearTimer("final");
    this.clearTimer("linger");
    this.child?.unref();
    dropKxmCommandStopCapability(this);
    this.resolveOutcome?.(outcome);
  }

  private clearTimer(name: "timeout" | "term" | "final" | "linger"): void {
    const current = this[`${name}Timer`];
    if (current) clearTimeout(current);
    this[`${name}Timer`] = undefined;
  }
}

function dropKxmCommandStopCapability(observer: CommandObserver): void {
  observer.requestStop = () => undefined;
}

function isCompleteNormal(observation: KxmGateObservationInput): boolean {
  return observation.completeness === "complete"
    && observation.spawned === 1
    && typeof observation.pid === "number"
    && typeof observation.exitCode === "number"
    && observation.signal === null
    && observation.exitObserved === 1
    && observation.closeObserved === 1
    && observation.stopCause === "none"
    && observation.signalsAttempted === "none"
    && observation.errorClass === null
    && observation.stdoutComplete === 1
    && observation.stderrComplete === 1
    && typeof observation.stdoutSha256 === "string"
    && typeof observation.stderrSha256 === "string";
}

function clampTimer(ms: number): number {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_DIRECT_TIMER_MS) {
    throw runtimeError("run_events_illegal", "command", "command timer is outside the direct timer bound");
  }
  return ms;
}

function schedule(ms: number, fn: () => void): NodeJS.Timeout {
  return setTimeout(fn, clampTimer(ms));
}

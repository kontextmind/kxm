import { randomUUID } from "node:crypto";
import { runtimeError } from "./vnext-runtime-store.ts";

export interface VnextOwnedAttempt {
  attemptId: string;
  controller: AbortController;
}

export interface VnextGateHoldView {
  attemptId: string;
  token: string;
  state: "active" | "unsettled";
}

interface GateHold {
  attemptId: string;
  token: string;
  state: "active" | "unsettled";
  stop?: () => void;
}

export interface VnextDriveSession {
  driveId: string;
  runId: string;
  token: string;
  homeRuntimeId: string;
  mode: "simulated" | "live";
  openedAt: string;
  controller: AbortController;
  settled: Promise<unknown>;
}

interface AdmissionRecord {
  token: string;
  configRevision: string;
  gateHold?: GateHold;
  driveSession?: VnextDriveSession;
}

interface QueueItem {
  runId: string;
  configRevision: string;
  bound: number;
  start: (token: string) => Promise<unknown>;
  fail: (error: unknown) => void;
}

interface OwnerPolicy {
  bound: number;
  configRevision: string;
}

interface OwnerRecord {
  handles: number;
  scheduler?: OwnerPolicy;
  implicit?: OwnerPolicy;
  admitted: Map<string, AdmissionRecord>;
  queue: QueueItem[];
  attempts: Map<string, Map<string, VnextOwnedAttempt>>;
}

const owners = new Map<string, OwnerRecord>();

function record(storePath: string): OwnerRecord {
  const existing = owners.get(storePath);
  if (existing) return existing;
  const created: OwnerRecord = {
    handles: 0,
    admitted: new Map(),
    queue: [],
    attempts: new Map(),
  };
  owners.set(storePath, created);
  return created;
}

function maybeDelete(storePath: string, owner: OwnerRecord): void {
  if (owner.handles === 0 && owner.admitted.size === 0 && owner.queue.length === 0 && owner.attempts.size === 0) {
    owners.delete(storePath);
  }
}

function activePolicy(owner: OwnerRecord): OwnerPolicy | undefined {
  return owner.scheduler ?? owner.implicit;
}

function clearImplicitIfIdle(owner: OwnerRecord): void {
  if (owner.admitted.size === 0 && owner.queue.length === 0) {
    delete owner.implicit;
  }
}

export function registerVnextRuntimeHandle(storePath: string): void {
  record(storePath).handles += 1;
}

export function unregisterVnextRuntimeHandle(storePath: string): void {
  const owner = owners.get(storePath);
  if (!owner) return;
  owner.handles = Math.max(0, owner.handles - 1);
  maybeDelete(storePath, owner);
}

export function vnextRuntimeHandleCount(storePath: string): number {
  return owners.get(storePath)?.handles ?? 0;
}

export function registerVnextAttemptController(storePath: string, runId: string, attempt: VnextOwnedAttempt): void {
  const owner = record(storePath);
  let runAttempts = owner.attempts.get(runId);
  if (!runAttempts) {
    runAttempts = new Map();
    owner.attempts.set(runId, runAttempts);
  }
  if (runAttempts.has(attempt.attemptId)) {
    throw runtimeError("attempt_controller_duplicate", attempt.attemptId, `attempt ${attempt.attemptId} is already registered`);
  }
  runAttempts.set(attempt.attemptId, attempt);
}

export function vnextAttemptController(storePath: string, runId: string, attemptId: string): VnextOwnedAttempt | undefined {
  return owners.get(storePath)?.attempts.get(runId)?.get(attemptId);
}

export function vnextAttemptControllers(storePath: string, runId: string): VnextOwnedAttempt[] {
  const runAttempts = owners.get(storePath)?.attempts.get(runId);
  if (!runAttempts) return [];
  return [...runAttempts.values()];
}

export function unregisterVnextAttemptController(storePath: string, runId: string, attemptId: string): void {
  const owner = owners.get(storePath);
  if (!owner) return;
  const runAttempts = owner.attempts.get(runId);
  if (!runAttempts) return;
  if (!runAttempts.has(attemptId)) return;
  runAttempts.delete(attemptId);
  if (runAttempts.size === 0) owner.attempts.delete(runId);
  maybeDelete(storePath, owner);
}

export function bindVnextSchedulerPolicy(storePath: string, bound: number, configRevision: string): void {
  const owner = record(storePath);
  const current = activePolicy(owner);
  if (current && (current.configRevision !== configRevision || current.bound !== bound)) {
    if (owner.admitted.size > 0 || owner.queue.length > 0) {
      throw runtimeError("scheduler_policy_conflict", storePath, "queued or admitted work still uses the previous scheduler policy");
    }
  }
  owner.scheduler = { bound, configRevision };
  delete owner.implicit;
}

export function vnextSchedulerPolicy(storePath: string): OwnerPolicy | undefined {
  return owners.get(storePath)?.scheduler;
}

export function admitVnextRun(
  storePath: string,
  runId: string,
  envelopeRevision: string,
  envelopeBound: number,
): string {
  const owner = record(storePath);
  if (owner.admitted.has(runId)) {
    throw runtimeError("run_busy", runId, `run ${runId} is already admitted`);
  }
  if (owner.queue.some((item) => item.runId === runId)) {
    throw runtimeError("run_busy", runId, `run ${runId} is already queued`);
  }
  const policy = activePolicy(owner);
  if (policy) {
    if (policy.configRevision !== envelopeRevision) {
      throw runtimeError("scheduler_policy_conflict", runId, "run envelope revision does not match the active admission policy");
    }
    if (policy.bound !== envelopeBound) {
      throw runtimeError("scheduler_policy_conflict", runId, "run envelope bound does not match the active admission policy");
    }
  } else {
    owner.implicit = { bound: envelopeBound, configRevision: envelopeRevision };
  }
  const bound = activePolicy(owner)!.bound;
  if (owner.admitted.size >= bound) {
    throw runtimeError("run_admission_exceeded", runId, `project already has ${bound} admitted runs`);
  }
  const token = randomUUID();
  owner.admitted.set(runId, { token, configRevision: envelopeRevision });
  return token;
}

export function releaseVnextRun(storePath: string, runId: string, token: string): void {
  const owner = owners.get(storePath);
  if (!owner) return;
  const current = owner.admitted.get(runId);
  if (!current || current.token !== token) return;
  if (current.gateHold) return;
  owner.admitted.delete(runId);
  pump(storePath, owner);
  clearImplicitIfIdle(owner);
  maybeDelete(storePath, owner);
}

export function armVnextGateHold(
  storePath: string,
  runId: string,
  token: string,
  attemptId: string,
  stop: () => void,
): void {
  const owner = record(storePath);
  const current = owner.admitted.get(runId);
  if (!current || current.token !== token) {
    throw runtimeError("run_events_illegal", runId, "gate hold requires the exact admitted token");
  }
  if (current.gateHold) {
    throw runtimeError("run_events_illegal", runId, "admission already has a gate hold");
  }
  current.gateHold = { attemptId, token, state: "active", stop };
}

export function markVnextGateHoldUnsettled(storePath: string, runId: string, token: string, attemptId: string): void {
  const owner = owners.get(storePath);
  const current = owner?.admitted.get(runId);
  if (!current || current.token !== token) {
    throw runtimeError("run_events_illegal", runId, "unsettled hold requires the exact admitted token");
  }
  const hold = current.gateHold;
  if (!hold || hold.attemptId !== attemptId || hold.token !== token) {
    throw runtimeError("run_events_illegal", runId, "unsettled hold does not match the armed attempt");
  }
  hold.state = "unsettled";
}

export function finishVnextOwnedGate(storePath: string, runId: string, token: string, attemptId: string): void {
  const owner = owners.get(storePath);
  const current = owner?.admitted.get(runId);
  if (!current || current.token !== token) {
    throw runtimeError("run_events_illegal", runId, "owned gate finish requires the exact admitted token");
  }
  const hold = current.gateHold;
  if (!hold || hold.attemptId !== attemptId || hold.token !== token) {
    throw runtimeError("run_events_illegal", runId, "owned gate finish does not match the armed attempt");
  }
  if (hold.state === "unsettled") {
    throw runtimeError("run_events_illegal", runId, "unsettled gate hold cannot be finished");
  }
  delete current.gateHold;
}

export function dropVnextGateStopHook(storePath: string, runId: string, attemptId: string): void {
  const hold = owners.get(storePath)?.admitted.get(runId)?.gateHold;
  if (!hold || hold.attemptId !== attemptId) return;
  delete hold.stop;
}

export function resolveVnextGateHold(storePath: string, runId: string, attemptId: string): void {
  const owner = owners.get(storePath);
  if (!owner) return;
  const current = owner.admitted.get(runId);
  if (!current) return;
  const hold = current.gateHold;
  if (!hold || hold.attemptId !== attemptId) return;
  try {
    hold.stop?.();
  } catch {
    // ignore cleanup errors
  }
  delete current.gateHold;
  owner.admitted.delete(runId);
  pump(storePath, owner);
  clearImplicitIfIdle(owner);
  maybeDelete(storePath, owner);
}

export function vnextGateHold(storePath: string, runId: string): VnextGateHoldView | undefined {
  const hold = owners.get(storePath)?.admitted.get(runId)?.gateHold;
  if (!hold) return undefined;
  return { attemptId: hold.attemptId, token: hold.token, state: hold.state };
}

export function vnextAdmittedToken(storePath: string, runId: string): string | undefined {
  return owners.get(storePath)?.admitted.get(runId)?.token;
}

export function attachVnextDriveSession(
  storePath: string,
  runId: string,
  token: string,
  session: VnextDriveSession,
): void {
  const owner = record(storePath);
  const current = owner.admitted.get(runId);
  if (!current || current.token !== token) {
    throw runtimeError("run_events_illegal", runId, "drive session requires the exact admitted token");
  }
  if (current.driveSession) {
    throw runtimeError("run_busy", runId, `run ${runId} already has a drive session`);
  }
  current.driveSession = session;
}

export function clearVnextDriveSession(storePath: string, runId: string, token: string): void {
  const owner = owners.get(storePath);
  const current = owner?.admitted.get(runId);
  if (!current || current.token !== token) return;
  delete current.driveSession;
}

export function vnextDriveSession(storePath: string, runId: string): VnextDriveSession | undefined {
  return owners.get(storePath)?.admitted.get(runId)?.driveSession;
}

export function vnextOpenDriveSessions(storePath: string): VnextDriveSession[] {
  const owner = owners.get(storePath);
  if (!owner) return [];
  const sessions: VnextDriveSession[] = [];
  for (const current of owner.admitted.values()) {
    if (current.driveSession) sessions.push(current.driveSession);
  }
  return sessions;
}

export function enqueueVnextScheduledRun(
  storePath: string,
  runId: string,
  configRevision: string,
  bound: number,
  start: (token: string) => Promise<unknown>,
): Promise<unknown> {
  const owner = record(storePath);
  if (owner.admitted.has(runId) || owner.queue.some((item) => item.runId === runId)) {
    return Promise.reject(runtimeError("run_busy", runId, `run ${runId} is already admitted or queued`));
  }
  return new Promise((resolve, reject) => {
    owner.queue.push({
      runId,
      configRevision,
      bound,
      start: (token) => start(token).then(resolve, reject),
      fail: (error: unknown) => reject(error),
    });
    pump(storePath, owner);
  });
}

export function vnextActiveScheduledRuns(storePath: string): number {
  return owners.get(storePath)?.admitted.size ?? 0;
}

export function vnextQueuedScheduledRuns(storePath: string): number {
  return owners.get(storePath)?.queue.length ?? 0;
}

function pump(storePath: string, owner: OwnerRecord): void {
  const bound = activePolicy(owner)?.bound ?? 1;
  while (owner.admitted.size < bound && owner.queue.length > 0) {
    const next = owner.queue.shift();
    if (!next) break;
    let token: string;
    try {
      token = admitVnextRun(storePath, next.runId, next.configRevision, next.bound);
    } catch (error) {
      next.fail(error);
      continue;
    }
    void next.start(token).finally(() => {
      releaseVnextRun(storePath, next.runId, token);
    });
  }
}

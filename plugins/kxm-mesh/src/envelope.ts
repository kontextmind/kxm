import { nowIso } from "./protocol.ts";

export const WORKER_SCHEMA = "kxm.worker.v1" as const;
export const WORKER_RESULT_SCHEMA = "kxm.worker-result.v1" as const;

export type WorkerKind = "agent" | "gate";
export type WorkerDriver = "ai" | "code";
export type WorkerOutcome = "passed" | "warning" | "failed" | "running";

/** Shared worker base. Agents and gates are both workers; they differ only by driver. */
export interface WorkerBase {
  schema: typeof WORKER_SCHEMA;
  kind: WorkerKind;
  driver: WorkerDriver;
  name: string;
  project?: string;
  purpose?: string;
}

export interface AgentWorker extends WorkerBase {
  kind: "agent";
  driver: "ai";
  model?: string;
  thinking?: string;
}

export interface GateWorker extends WorkerBase {
  kind: "gate";
  driver: "code";
}

export type Worker = AgentWorker | GateWorker;

/** Standard result envelope emitted by every worker, AI or code. */
export interface WorkerResultEnvelope<T extends Worker = Worker> {
  schema: typeof WORKER_RESULT_SCHEMA;
  worker: T;
  command: string;
  ok: boolean;
  outcome: WorkerOutcome;
  createdAt: string;
  summary: string;
}

export function agentWorker(input: {
  name: string;
  project?: string;
  purpose?: string;
  model?: string;
  thinking?: string;
}): AgentWorker {
  return {
    schema: WORKER_SCHEMA,
    kind: "agent",
    driver: "ai",
    name: input.name,
    ...(input.project ? { project: input.project } : {}),
    ...(input.purpose ? { purpose: input.purpose } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinking ? { thinking: input.thinking } : {}),
  };
}

export function gateWorker(input: {
  name: string;
  project?: string;
  purpose?: string;
}): GateWorker {
  return {
    schema: WORKER_SCHEMA,
    kind: "gate",
    driver: "code",
    name: input.name,
    ...(input.project ? { project: input.project } : {}),
    ...(input.purpose ? { purpose: input.purpose } : {}),
  };
}

/**
 * Build the standard result envelope. Additive payload keys extend the
 * envelope, but hub-owned identity keys (`schema` and `worker`) are written
 * after the payload spread and cannot be clobbered. Caller-owned `summary`,
 * optional `createdAt`, and optional `outcome` are canonical inputs. An explicit `outcome`
 * must not contradict `ok` ("passed" requires ok: true; "failed" requires
 * ok: false); contradictions throw instead of emitting a lying envelope.
 */
export function workerResult<T extends Worker, P extends Record<string, unknown>>(
  worker: T,
  payload: P & {
    command: string;
    ok: boolean;
    summary: string;
    outcome?: WorkerOutcome;
    createdAt?: string;
  },
): WorkerResultEnvelope<T> & P {
  const { summary, outcome, createdAt, ...rest } = payload;
  if (outcome === "passed" && payload.ok === false) {
    throw new Error("workerResult outcome contradicts ok: \"passed\" requires ok: true");
  }
  if (outcome === "failed" && payload.ok === true) {
    throw new Error("workerResult outcome contradicts ok: \"failed\" requires ok: false");
  }
  return {
    ...rest,
    schema: WORKER_RESULT_SCHEMA,
    worker,
    createdAt: createdAt ?? nowIso(),
    outcome: outcome ?? (payload.ok ? "passed" : "failed"),
    summary,
  } as WorkerResultEnvelope<T> & P;
}

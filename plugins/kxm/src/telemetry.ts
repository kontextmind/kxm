import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { nowIso } from "./protocol.ts";
import type { WorkerResultEnvelope } from "./envelope.ts";

export const TELEMETRY_SCHEMA = "kxm.telemetry.v1" as const;

export type ImprovementTarget = "cli" | "project";

export interface TelemetryEvent {
  schema: typeof TELEMETRY_SCHEMA;
  recordedAt: string;
  sessionId?: string;
  host: "local" | "mesh";
  target: ImprovementTarget;
  envelope: WorkerResultEnvelope;
}

export function inferImprovementTarget(input: {
  project?: string;
  workflowId?: string;
  env?: NodeJS.ProcessEnv;
}): ImprovementTarget {
  const explicit = input.env?.KXM_IMPROVE_TARGET?.trim();
  if (explicit === "cli" || explicit === "project") return explicit;
  const project = (input.project ?? input.env?.KXM_PROJECT ?? "").trim();
  const workflowId = (input.workflowId ?? "").trim();
  return project || workflowId ? "project" : "cli";
}

export function appendTelemetry(path: string, event: TelemetryEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readTelemetry(path: string): TelemetryEvent[] {
  try {
    const raw = readFileSync(path, "utf8");
    const events: TelemetryEvent[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as TelemetryEvent;
        if (parsed.schema === TELEMETRY_SCHEMA) events.push(parsed);
      } catch {
        // skip malformed lines
      }
    }
    return events;
  } catch {
    return [];
  }
}

export function telemetryPath(logsDir: string): string {
  return join(logsDir, "telemetry.jsonl");
}

export function makeTelemetryEvent(input: {
  envelope: WorkerResultEnvelope;
  sessionId?: string;
  host?: "local" | "mesh";
  target: ImprovementTarget;
}): TelemetryEvent {
  return {
    schema: TELEMETRY_SCHEMA,
    recordedAt: nowIso(),
    host: input.host ?? "local",
    target: input.target,
    envelope: input.envelope,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}

/** Routing records carried additively on result envelopes (v0.5). */
export function readRoutingRecords(path: string): Array<{ recordedAt: string; routing: import("./routing.ts").RoutingRecord }> {
  const records: Array<{ recordedAt: string; routing: import("./routing.ts").RoutingRecord }> = [];
  for (const event of readTelemetry(path)) {
    const routing = (event.envelope as { routing?: import("./routing.ts").RoutingRecord }).routing;
    if (routing) records.push({ recordedAt: event.recordedAt, routing });
  }
  return records;
}

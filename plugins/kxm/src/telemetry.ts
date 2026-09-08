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
  host: "local" | "hub";
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
  host?: "local" | "hub";
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

type RoutingRecord = import("./routing.ts").RoutingRecord;
type RoutingRecordV2 = import("./routing.ts").RoutingRecordV2;

/** Routing records carried additively on result envelopes (v0.5) or emitted directly (v2). */
export function readRoutingRecords(path: string): Array<{ recordedAt: string; routing: RoutingRecord | RoutingRecordV2 }> {
  const records: Array<{ recordedAt: string; routing: RoutingRecord | RoutingRecordV2 }> = [];
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        let routingObj: unknown;
        const recordedAt = typeof parsed.recordedAt === "string"
          ? parsed.recordedAt
          : (typeof parsed.timestamp === "string" ? parsed.timestamp : new Date().toISOString());

        if (parsed.schema === "kxm.routing-record.v2" || parsed.schema === "kxm.routing-record.v1") {
          routingObj = parsed;
        } else if (parsed.routing && typeof parsed.routing === "object") {
          routingObj = parsed.routing;
        } else if (parsed.envelope && typeof parsed.envelope === "object" && (parsed.envelope as Record<string, unknown>).routing) {
          routingObj = (parsed.envelope as Record<string, unknown>).routing;
        } else if (parsed.eventType === "routing.attempt.recorded" && parsed.payload && typeof parsed.payload === "object") {
          routingObj = (parsed.payload as Record<string, unknown>).routing;
        }

        if (routingObj && typeof routingObj === "object") {
          const r = routingObj as Record<string, unknown>;
          if (r.schema === "kxm.routing-record.v2" || r.schema === "kxm.routing-record.v1") {
            records.push({ recordedAt, routing: r as unknown as (RoutingRecord | RoutingRecordV2) });
          }
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // file unreadable
  }
  return records;
}

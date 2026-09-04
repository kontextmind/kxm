import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "./protocol.ts";
import type { ImprovementTarget, TelemetryEvent } from "./telemetry.ts";

export const IMPROVEMENT_REPORT_SCHEMA = "kxm.improvement-report.v1" as const;

export interface ImprovementProposal {
  target: ImprovementTarget;
  area: "harness" | "gates" | "implementation" | "workflow" | "documentation" | "security" | "other";
  summary: string;
  count: number;
  evidence: string[];
}

export interface ImprovementReport {
  schema: typeof IMPROVEMENT_REPORT_SCHEMA;
  createdAt: string;
  reviewDecision: "proposed";
  events: number;
  targets: ImprovementTarget[];
  proposals: ImprovementProposal[];
}

export function buildImprovementReport(events: TelemetryEvent[], targets: ImprovementTarget[]): ImprovementReport {
  const selected = events.filter((event) => targets.includes(event.target));
  const buckets = new Map<string, ImprovementProposal>();
  for (const event of selected) {
    const area = event.envelope.worker.kind === "gate" ? "gates" : "harness";
    const key = `${event.target}:${area}:${event.envelope.command}:${event.envelope.outcome}`;
    const existing = buckets.get(key);
    const evidence = `${event.envelope.command}:${event.envelope.outcome}:${event.envelope.summary}`.slice(0, 200);
    if (existing) {
      existing.count += 1;
      if (existing.evidence.length < 8) existing.evidence.push(evidence);
      continue;
    }
    buckets.set(key, {
      target: event.target,
      area,
      count: 1,
      summary: `${event.envelope.worker.kind} ${event.envelope.command} ${event.envelope.outcome} (${event.target})`,
      evidence: [evidence],
    });
  }
  const proposals = [...buckets.values()].sort((left, right) => right.count - left.count || left.summary.localeCompare(right.summary));
  return {
    schema: IMPROVEMENT_REPORT_SCHEMA,
    createdAt: nowIso(),
    reviewDecision: "proposed",
    events: selected.length,
    targets,
    proposals,
  };
}

export function writeImprovementReport(improvementsDir: string, report: ImprovementReport, dryRun = false): string {
  const stamp = report.createdAt.replace(/[:.]/g, "-");
  const path = join(improvementsDir, `${stamp}.json`);
  if (!dryRun) {
    mkdirSync(improvementsDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" });
  }
  return path;
}

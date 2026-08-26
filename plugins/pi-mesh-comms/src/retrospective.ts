import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { redactSecrets, redactStringList } from "./redact.ts";
import type { WorkflowJournalEntry, WorkflowRun } from "./workflow.ts";

export interface RetrospectiveV1 {
  schema: "pi-mesh.retrospective.v1";
  runId: string;
  definitionId: string;
  status: WorkflowRun["status"];
  exportedAt: string;
  reviewDecision: "proposed";
  stages: Array<{
    id: string;
    area?: string;
    status: string;
    attempts: number;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
    updatedAt?: string;
    summary?: string;
  }>;
  counts: {
    byCategory: Record<string, number>;
    byArea: Record<string, number>;
    byClass: Record<string, number>;
  };
  openContradictions: Array<{ id: string; summary: string; area: string }>;
  decisions: Array<{ id: string; summary: string; area: string }>;
  recurringErrorClasses: Array<{ class: string; count: number }>;
  entries: Array<{
    id: string;
    category: string;
    area: string;
    severity: string;
    summary: string;
    evidence: string[];
    relatedEntryIds: string[];
    createdAt: string;
  }>;
  proposedImprovements: Array<{ area: string; summary: string; successMeasure: string; status: "proposed" }>;
}

const MAX_RETROSPECTIVE_ENTRIES = 500;
const SAFE_RUN_ID = /^run_[A-Za-z0-9_-]{1,120}$/;

function durationMs(startedAt: string | undefined, completedAt: string | undefined): number | undefined {
  if (!startedAt || !completedAt) return undefined;
  const value = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function classFromEvidence(evidence: string[]): string {
  const match = evidence.find((item) => item.startsWith("class:"));
  return match?.slice("class:".length) || "unknown";
}

export function buildRetrospective(
  run: WorkflowRun,
  journal: WorkflowJournalEntry[],
  exportedAt = new Date().toISOString(),
): RetrospectiveV1 {
  if (!SAFE_RUN_ID.test(run.id)) throw new Error("invalid retrospective run id");
  const entries = journal
    .filter((entry) => entry.runId === run.id)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .slice(-MAX_RETROSPECTIVE_ENTRIES)
    .map((entry) => ({
      id: entry.id,
      category: entry.category,
      area: entry.area,
      severity: entry.severity,
      summary: redactSecrets(entry.summary),
      evidence: redactStringList(entry.evidence),
      relatedEntryIds: entry.relatedEntryIds.slice(0, 16),
      createdAt: entry.createdAt,
    }));
  const byCategory: Record<string, number> = {};
  const byArea: Record<string, number> = {};
  const byClass: Record<string, number> = {};
  for (const entry of entries) {
    increment(byCategory, entry.category);
    increment(byArea, entry.area);
    increment(byClass, classFromEvidence(entry.evidence));
  }
  const recurringErrorClasses = Object.entries(byClass)
    .map(([errorClass, count]) => ({ class: errorClass, count }))
    .sort((left, right) => right.count - left.count || left.class.localeCompare(right.class));
  const resolvedContradictions = new Set(entries.filter((entry) => entry.category === "decision" || entry.category === "lesson").flatMap((entry) => entry.relatedEntryIds));
  const openContradictions = entries
    .filter((entry) => entry.category === "contradiction" && !resolvedContradictions.has(entry.id))
    .map((entry) => ({ id: entry.id, summary: entry.summary, area: entry.area }));
  const decisions = entries
    .filter((entry) => entry.category === "decision")
    .map((entry) => ({ id: entry.id, summary: entry.summary, area: entry.area }));
  const proposedImprovements = entries
    .filter((entry) => entry.category === "lesson" || entry.category === "error")
    .slice(0, 12)
    .map((entry) => ({
      area: entry.area,
      summary: entry.summary,
      successMeasure: "reduce recurrence of this class in the next comparable run",
      status: "proposed" as const,
    }));
  return {
    schema: "pi-mesh.retrospective.v1",
    runId: run.id,
    definitionId: run.definitionId,
    status: run.status,
    exportedAt,
    reviewDecision: "proposed",
    stages: run.stages.map((stage) => {
      const elapsed = durationMs(stage.startedAt, stage.completedAt);
      return { id: stage.id, ...(stage.area ? { area: stage.area } : {}), status: stage.status, attempts: stage.attempts, ...(stage.startedAt ? { startedAt: stage.startedAt } : {}), ...(stage.completedAt ? { completedAt: stage.completedAt } : {}), ...(elapsed !== undefined ? { durationMs: elapsed } : {}), ...(stage.updatedAt ? { updatedAt: stage.updatedAt } : {}), ...(stage.summary ? { summary: redactSecrets(stage.summary) } : {}) };
    }),
    counts: { byCategory, byArea, byClass },
    openContradictions,
    decisions,
    recurringErrorClasses,
    entries,
    proposedImprovements,
  };
}

export function renderRetrospectiveMarkdown(doc: RetrospectiveV1): string {
  const stageRows = doc.stages
    .map((stage) => `| ${stage.id} | ${stage.area ?? ""} | ${stage.status} | ${stage.attempts} | ${stage.durationMs ?? ""} |`)
    .join("\n");
  const contradictionRows = doc.openContradictions
    .map((entry) => `- ${entry.id} (${entry.area}): ${entry.summary}`)
    .join("\n") || "- none";
  const decisionRows = doc.decisions
    .map((entry) => `- ${entry.id} (${entry.area}): ${entry.summary}`)
    .join("\n") || "- none";
  const classRows = doc.recurringErrorClasses
    .map((entry) => `- ${entry.class}: ${entry.count}`)
    .join("\n") || "- none";
  const entryRows = doc.entries.map((entry) => {
    const related = entry.relatedEntryIds.length > 0 ? `; related: ${entry.relatedEntryIds.join(", ")}` : "";
    const evidence = entry.evidence.length > 0 ? `; evidence: ${entry.evidence.join(", ")}` : "";
    return `- ${entry.id} [${entry.category}/${entry.area}/${entry.severity}]: ${entry.summary}${related}${evidence}`;
  }).join("\n") || "- none";
  return [
    `# Workflow retrospective ${doc.runId}`,
    "",
    `- Definition: ${doc.definitionId}`,
    `- Status: ${doc.status}`,
    `- Exported: ${doc.exportedAt}`,
    `- Review decision: ${doc.reviewDecision}`,
    "",
    "## Stages",
    "",
    "| id | area | status | attempts | duration ms |",
    "|---|---|---|---|---|",
    stageRows,
    "",
    "## Decisions",
    "",
    decisionRows,
    "",
    "## Open contradictions",
    "",
    contradictionRows,
    "",
    "## Recurring error classes",
    "",
    classRows,
    "",
    "## Bounded journal evidence",
    "",
    entryRows,
    "",
    "## Proposed improvements",
    "",
    ...doc.proposedImprovements.map((item) => `- [${item.status}] (${item.area}) ${item.summary}`),
    "",
    "Proposed improvements are evidence, not policy. Do not apply them until an explicit review decision.",
    "",
  ].join("\n");
}

export function writeRetrospective(outDir: string, doc: RetrospectiveV1): { jsonPath: string; mdPath: string } {
  if (!SAFE_RUN_ID.test(doc.runId)) throw new Error("invalid retrospective run id");
  mkdirSync(outDir, { recursive: true });
  const root = resolve(outDir);
  const jsonPath = resolve(root, `${doc.runId}.json`);
  const mdPath = resolve(root, `${doc.runId}.md`);
  const prefix = `${root}${process.platform === "win32" ? "\\" : "/"}`;
  if (!jsonPath.startsWith(prefix) || !mdPath.startsWith(prefix)) throw new Error("retrospective path escaped output directory");
  const jsonTmp = `${jsonPath}.tmp`;
  const mdTmp = `${mdPath}.tmp`;
  writeFileSync(jsonTmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  writeFileSync(mdTmp, renderRetrospectiveMarkdown(doc), { encoding: "utf8", mode: 0o600 });
  renameSync(jsonTmp, jsonPath);
  renameSync(mdTmp, mdPath);
  return { jsonPath, mdPath };
}

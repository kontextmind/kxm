import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { RoutingRecord, RoutingRecordV2 } from "./routing.ts";
import { nowIso } from "./protocol.ts";

export const CANDIDATE_SCHEMA = "kxm.candidate.v1" as const;
export const IMPROVEMENT_REPORT_SCHEMA = "kxm.improvement-report.v2" as const;
export const IMPROVEMENT_REPORT_V1_SCHEMA = "kxm.improvement-report.v1" as const;

export type CandidateKind = "gate" | "skill" | "workflow-step";

export interface CandidateBaselineMetrics {
  recurrence: number;
  meanCost: number;
  meanLatency: number;
  verifyPassRate: number;
  rework: number;
}

export interface ImprovementCandidate {
  schema: typeof CANDIDATE_SCHEMA;
  id: string;
  kind: CandidateKind;
  summary: string;
  evidenceRefs: string[];
  baselineMetrics: CandidateBaselineMetrics;
  declaredOutcome: string;
  measure: string;
  proposedDiffPath: string;
  status: "proposed" | "evaluating" | "review-required" | "promoted" | "rejected";
  createdAt: string;
}

export interface ImprovementGroupRow {
  workflowHash: string;
  stepId: string;
  agentRole: string;
  promptHash: string;
  recurrence: number;
  meanCost: number;
  meanLatency: number;
  verifyPassRate: number;
  rework: number;
  evidenceRefs: string[];
  isCandidate: boolean;
  candidateKind?: CandidateKind;
  candidateId?: string;
}

export interface ImprovementReport {
  schema: typeof IMPROVEMENT_REPORT_SCHEMA;
  createdAt: string;
  reviewDecision: "proposed";
  recordsCount: number;
  groups: ImprovementGroupRow[];
  candidates: ImprovementCandidate[];
}

export function classifyCandidateKind(stepId: string, agentRole: string): CandidateKind {
  const s = stepId.toLowerCase();
  const r = agentRole.toLowerCase();
  if (s.includes("verify") || s.includes("gate") || s.includes("test") || s.includes("check") || s.includes("lint") || r === "verifier") {
    return "gate";
  }
  if (s.includes("plan") || s.includes("review") || s.includes("repro") || r === "planner" || r === "reviewer" || r === "critic") {
    return "skill";
  }
  return "workflow-step";
}

function generateCandidateDiff(kind: CandidateKind, stepId: string, agentRole: string, workflowHash: string): { diff: string; declaredOutcome: string; measure: string; summary: string } {
  const safeSlug = stepId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "step";
  if (kind === "gate") {
    const diff = [
      "diff --git a/.kxm/gates.yaml b/.kxm/gates.yaml",
      "--- a/.kxm/gates.yaml",
      "+++ b/.kxm/gates.yaml",
      "@@ -1,3 +1,7 @@",
      " schema: kxm.gate-registry.v1",
      " gates:",
      `+  ${safeSlug}:`,
      `+    kind: command`,
      `+    argv: [npm, run, ${safeSlug}]`,
      `+    timeoutMs: 3600000`,
      "",
    ].join("\n");
    return {
      diff,
      declaredOutcome: `Deterministic exit-code verification replacing LLM turn for ${stepId}`,
      measure: `100% reduction in LLM inference cost and latency for ${stepId}`,
      summary: `Promote deterministic check '${stepId}' (${agentRole}) to coded gate`,
    };
  }
  if (kind === "skill") {
    const rel = `.kxm/skills/candidates/${safeSlug}/SKILL.md`;
    const skillContent = [
      "---",
      `name: ${safeSlug}`,
      `description: Governed repeat skill for ${stepId}`,
      "---",
      "",
      `# ${stepId}`,
      "",
      `Reusable skill instructions for ${stepId} (${agentRole}).`,
      "",
    ].join("\n");
    const diff = [
      `diff --git a/${rel} b/${rel}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${rel}`,
      `@@ -0,0 +1,${skillContent.split("\n").length} @@`,
      ...skillContent.split("\n").map((l) => `+${l}`),
      "",
    ].join("\n");
    return {
      diff,
      declaredOutcome: `Governed reusable skill for ${stepId}`,
      measure: `Reduced prompt drift and consistent model guidance for ${stepId}`,
      summary: `Promote repeated instructions for '${stepId}' (${agentRole}) to governed skill`,
    };
  }
  const rel = `.kxm/workflows/${safeSlug}.yaml`;
  const diff = [
    `diff --git a/${rel} b/${rel}`,
    `--- a/${rel}`,
    `+++ b/${rel}`,
    "@@ -1,3 +1,6 @@",
    " steps:",
    `+  - id: ${stepId}`,
    `+    kind: agent`,
    `+    agent: ${agentRole}`,
    "",
  ].join("\n");
  return {
    diff,
    declaredOutcome: `Dedicated workflow step with typed inputs and transitions for ${stepId}`,
    measure: `Reduced manual coordination and faster stage transitions for ${stepId}`,
    summary: `Automate repetitive step '${stepId}' (${agentRole}) in workflow`,
  };
}

export function groupRoutingRecords(
  records: Array<RoutingRecord | RoutingRecordV2>,
  options: { minRecurrence?: number; minPassRate?: number } = {},
): ImprovementGroupRow[] {
  const minRecurrence = options.minRecurrence ?? 2;
  const minPassRate = options.minPassRate ?? 0.75;

  const map = new Map<string, {
    workflowHash: string;
    stepId: string;
    agentRole: string;
    promptHash: string;
    costs: number[];
    latencies: number[];
    passedCount: number;
    reworkCount: number;
    evidenceRefs: Set<string>;
    total: number;
  }>();

  for (const r of records) {
    const raw = r as unknown as Record<string, unknown>;
    const providerMeta = (raw.providerMetadata && typeof raw.providerMetadata === "object") ? raw.providerMetadata as Record<string, unknown> : {};
    const workflowHash = (raw.workflowDefinitionSha256 as string)
      || (providerMeta.workflowDefinitionSha256 as string)
      || (raw.workflowRunId as string)
      || (raw.runId as string)
      || "standalone";
    const stepId = (raw.stepId as string) || (raw.stageId as string) || "unknown";
    const agentRole = (raw.agentRole as string)?.trim() || "agent";
    const promptHash = (raw.rolePromptSha256 as string)?.trim()
      || (providerMeta.rolePromptSha256 as string)?.trim()
      || "none";

    const key = `${workflowHash}:${stepId}:${agentRole}:${promptHash}`;
    let group = map.get(key);
    if (!group) {
      group = {
        workflowHash,
        stepId,
        agentRole,
        promptHash,
        costs: [],
        latencies: [],
        passedCount: 0,
        reworkCount: 0,
        evidenceRefs: new Set<string>(),
        total: 0,
      };
      map.set(key, group);
    }

    group.total += 1;
    const cost = raw.costUsd;
    if (typeof cost === "number" && !Number.isNaN(cost) && cost >= 0) {
      group.costs.push(cost);
    }
    const latency = raw.latencyMs;
    if (typeof latency === "number" && !Number.isNaN(latency) && latency >= 0) {
      group.latencies.push(latency);
    }

    const verifierOutcome = raw.verifierOutcome;
    const finalOutcome = raw.finalOutcome;
    if (verifierOutcome === "passed" || finalOutcome === "accepted" || finalOutcome === "completed") {
      group.passedCount += 1;
    }

    const retries = raw.retries;
    if (typeof retries === "number") {
      group.reworkCount += retries;
    }

    const ref = (raw.attemptId as string) || (raw.runId as string) || (raw.workflowRunId as string) || (raw.behavioralSha256 as string);
    if (ref && group.evidenceRefs.size < 16) {
      group.evidenceRefs.add(ref);
    }
  }

  const rows: ImprovementGroupRow[] = [];
  for (const group of map.values()) {
    const recurrence = group.total;
    const meanCost = group.costs.length > 0
      ? Number((group.costs.reduce((a, b) => a + b, 0) / group.costs.length).toFixed(4))
      : 0;
    const meanLatency = group.latencies.length > 0
      ? Math.round(group.latencies.reduce((a, b) => a + b, 0) / group.latencies.length)
      : 0;
    const verifyPassRate = recurrence > 0
      ? Number((group.passedCount / recurrence).toFixed(3))
      : 0;
    const rework = group.reworkCount;

    const isCandidate = recurrence >= minRecurrence && verifyPassRate >= minPassRate;
    const candidateKind = isCandidate ? classifyCandidateKind(group.stepId, group.agentRole) : undefined;
    const safeSlug = group.stepId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 16) || "step";
    const keyHash = createHash("sha256").update(`${group.workflowHash}:${group.stepId}:${group.agentRole}:${group.promptHash}`).digest("hex").slice(0, 10);
    const candidateId = isCandidate && candidateKind ? `cand_${candidateKind.replace(/-/g, "_")}_${safeSlug}_${keyHash}` : undefined;

    rows.push({
      workflowHash: group.workflowHash,
      stepId: group.stepId,
      agentRole: group.agentRole,
      promptHash: group.promptHash,
      recurrence,
      meanCost,
      meanLatency,
      verifyPassRate,
      rework,
      evidenceRefs: [...group.evidenceRefs],
      isCandidate,
      ...(candidateKind !== undefined ? { candidateKind } : {}),
      ...(candidateId !== undefined ? { candidateId } : {}),
    });
  }

  return rows.sort((a, b) => {
    if (a.isCandidate !== b.isCandidate) return a.isCandidate ? -1 : 1;
    if (b.recurrence !== a.recurrence) return b.recurrence - a.recurrence;
    return a.stepId.localeCompare(b.stepId);
  });
}

export function buildImprovementReport(
  records: Array<RoutingRecord | RoutingRecordV2>,
  options: {
    minRecurrence?: number;
    minPassRate?: number;
    candidatesDir?: string;
    projectRoot?: string;
    dryRun?: boolean;
  } = {},
): ImprovementReport {
  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : process.cwd();
  const candidatesDir = options.candidatesDir ? resolve(options.candidatesDir) : join(projectRoot, ".kxm", "candidates");

  const groups = groupRoutingRecords(records, options);
  const candidates: ImprovementCandidate[] = [];

  for (const group of groups) {
    if (!group.isCandidate || !group.candidateKind || !group.candidateId) continue;

    const { diff, declaredOutcome, measure, summary } = generateCandidateDiff(
      group.candidateKind,
      group.stepId,
      group.agentRole,
      group.workflowHash,
    );

    const diffFileName = `${group.candidateId}.diff`;
    const diffFilePath = join(candidatesDir, diffFileName);
    const relDiffPath = relative(projectRoot, diffFilePath).replace(/\\/g, "/");

    const candidate: ImprovementCandidate = {
      schema: CANDIDATE_SCHEMA,
      id: group.candidateId,
      kind: group.candidateKind,
      summary,
      evidenceRefs: group.evidenceRefs.length > 0 ? group.evidenceRefs : ["evidence:telemetry"],
      baselineMetrics: {
        recurrence: group.recurrence,
        meanCost: group.meanCost,
        meanLatency: group.meanLatency,
        verifyPassRate: group.verifyPassRate,
        rework: group.rework,
      },
      declaredOutcome,
      measure,
      proposedDiffPath: relDiffPath,
      status: "proposed",
      createdAt: nowIso(),
    };

    if (!options.dryRun) {
      if (!existsSync(candidatesDir)) {
        mkdirSync(candidatesDir, { recursive: true });
      }
      writeFileSync(diffFilePath, diff, "utf8");
      const jsonFilePath = join(candidatesDir, `${group.candidateId}.json`);
      writeFileSync(jsonFilePath, JSON.stringify(candidate, null, 2) + "\n", "utf8");
    }

    candidates.push(candidate);
  }

  return {
    schema: IMPROVEMENT_REPORT_SCHEMA,
    createdAt: nowIso(),
    reviewDecision: "proposed",
    recordsCount: records.length,
    groups,
    candidates,
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

export function formatImprovementReport(report: ImprovementReport): string {
  const lines: string[] = [
    `Improvement Report (${report.recordsCount} record(s), ${report.groups.length} group(s), ${report.candidates.length} candidate(s))`,
    "",
    "Workflow       Step         Role         Prompt       Recurrence  Cost ($)  Latency (ms)  Pass Rate  Rework  Candidate",
    "-------------------------------------------------------------------------------------------------------------------------",
  ];

  for (const g of report.groups) {
    const wf = g.workflowHash.slice(0, 12).padEnd(14);
    const step = g.stepId.slice(0, 11).padEnd(12);
    const role = g.agentRole.slice(0, 11).padEnd(12);
    const prompt = g.promptHash.slice(0, 10).padEnd(12);
    const rec = String(g.recurrence).padStart(10);
    const cost = g.meanCost.toFixed(3).padStart(9);
    const lat = String(g.meanLatency).padStart(13);
    const pass = `${(g.verifyPassRate * 100).toFixed(0)}%`.padStart(10);
    const rework = String(g.rework).padStart(7);
    const cand = g.isCandidate ? `yes (${g.candidateKind})` : "no";
    lines.push(`${wf} ${step} ${role} ${prompt} ${rec} ${cost} ${lat} ${pass} ${rework}  ${cand}`);
  }

  if (report.candidates.length > 0) {
    lines.push("");
    lines.push("Emitted Coded-Repeat Candidates:");
    for (const c of report.candidates) {
      lines.push(`  - ${c.id} [${c.kind}]: ${c.summary}`);
      lines.push(`    Outcome: ${c.declaredOutcome}`);
      lines.push(`    Measure: ${c.measure}`);
      lines.push(`    Proposed diff: ${c.proposedDiffPath}`);
    }
  }

  return lines.join("\n");
}

export interface PromotionDecision {
  eligible: boolean;
  policy: "manual_pr" | "critic_quorum" | "auto_threshold";
  authorized: boolean;
  reason: string;
}

/**
 * Evaluates candidate promotion policy (Decision Q11).
 * Supports:
 * - manual_pr: strict operator signoff via Git PR / CLI (fail-closed anti-privilege-escalation)
 * - critic_quorum: requires dual critic approval before auto-promotion
 * - auto_threshold: requires candidate to exceed recurrence and verifyPassRate thresholds
 */
export function evaluatePromotionPolicy(
  candidate: ImprovementCandidate,
  policy: "manual_pr" | "critic_quorum" | "auto_threshold" = "manual_pr",
  options?: {
    criticApprovals?: string[] | undefined;
    autoThreshold?: {
      minRuns: number;
      minPassRate: number;
      minCostSavings?: number | undefined;
    } | undefined;
  },
): PromotionDecision {
  if (policy === "manual_pr") {
    return {
      eligible: true,
      policy,
      authorized: false,
      reason: "Manual PR review and signoff required by policy (fail-closed anti-privilege-escalation)",
    };
  }

  if (policy === "critic_quorum") {
    const approvals = options?.criticApprovals ?? [];
    const hasQuorum = approvals.length >= 2;
    return {
      eligible: true,
      policy,
      authorized: hasQuorum,
      reason: hasQuorum
        ? `Authorized by critic quorum (${approvals.join(", ")})`
        : `Requires dual critic quorum; current approvals: ${approvals.length}/2`,
    };
  }

  if (policy === "auto_threshold") {
    const threshold = options?.autoThreshold ?? { minRuns: 10, minPassRate: 0.95 };
    const recurrence = candidate.baselineMetrics.recurrence;
    const passRate = candidate.baselineMetrics.verifyPassRate;
    const meetsThreshold = recurrence >= threshold.minRuns && passRate >= threshold.minPassRate;

    return {
      eligible: true,
      policy,
      authorized: meetsThreshold,
      reason: meetsThreshold
        ? `Authorized by auto-threshold (runs=${recurrence}>=${threshold.minRuns}, passRate=${passRate}>=${threshold.minPassRate})`
        : `Auto-threshold not met: runs=${recurrence}/${threshold.minRuns}, passRate=${passRate}/${threshold.minPassRate}`,
    };
  }

  return {
    eligible: false,
    policy,
    authorized: false,
    reason: `Unknown promotion policy: ${String(policy)}`,
  };
}

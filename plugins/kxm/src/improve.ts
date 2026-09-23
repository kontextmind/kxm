import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { computeDecayedWeight, type RoutingRecord, type RoutingRecordV2 } from "./routing.ts";
import { nowIso } from "./protocol.ts";
import { compareCodeUnitIds } from "./relevance.ts";

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

/** Why a group that recurs is still not a coded-repeat candidate. */
export type ImprovementExcludedReason = "writes-repository" | "ask-not-repeated";

export interface ImprovementGroupRow {
  workflowHash: string;
  /** The engine's workflow id when the records carry one. */
  workflowId?: string;
  stepId: string;
  agentRole: string;
  promptHash: string;
  recurrence: number;
  /** Distinct runs among decided records. */
  distinctRuns: number;
  /** Most distinct decided runs that shared one objective (the same ask). */
  askRecurrence: number;
  undecidedRecords: number;
  meanCost: number;
  meanLatency: number;
  /** Accepted share of decided records; a superseded retry never passes. */
  verifyPassRate: number;
  rework: number;
  /** Recency-weighted recurrence. Orders rows; never decides candidacy. */
  weightedRecurrence: number;
  undatedRecords: number;
  costSamples: number;
  writesRepository: boolean;
  evidenceRefs: string[];
  isCandidate: boolean;
  excludedReason?: ImprovementExcludedReason;
  candidateKind?: CandidateKind;
  candidateId?: string;
}

export interface ImprovementPromotionEntry extends PromotionReadiness {
  candidateId: string;
}

export interface ImprovementReport {
  schema: typeof IMPROVEMENT_REPORT_SCHEMA;
  createdAt: string;
  reviewDecision: "proposed";
  recordsCount: number;
  groups: ImprovementGroupRow[];
  candidates: ImprovementCandidate[];
  promotionPolicy: string;
  promotion: ImprovementPromotionEntry[];
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

function candidateSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "step";
}

function generateCandidateDiff(
  kind: CandidateKind,
  stepId: string,
  agentRole: string,
  workflowId?: string | undefined,
): { diff: string; declaredOutcome: string; measure: string; summary: string } {
  const safeSlug = candidateSlug(stepId);
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
      summary: `Consolidate repeated instructions for '${stepId}' (${agentRole}) into a governed skill (consolidation, not a coded step)`,
    };
  }
  // A workflow-step candidate proposes the coded step itself: the agent turn
  // becomes a command gate the operator writes and reviews.
  const rel = `.kxm/workflows/${workflowId !== undefined ? candidateSlug(workflowId) : safeSlug}.yaml`;
  const diff = [
    `diff --git a/${rel} b/${rel}`,
    `--- a/${rel}`,
    `+++ b/${rel}`,
    "@@ -1,3 +1,3 @@",
    `   - id: ${stepId}`,
    "-    kind: agent",
    `-    agent: ${agentRole}`,
    "+    kind: gate",
    `+    gate: ${safeSlug}`,
    "diff --git a/.kxm/gates.yaml b/.kxm/gates.yaml",
    "--- a/.kxm/gates.yaml",
    "+++ b/.kxm/gates.yaml",
    "@@ -1,2 +1,6 @@",
    " schema: kxm.gate-registry.v1",
    " gates:",
    `+  ${safeSlug}:`,
    "+    kind: command",
    `+    argv: [node, scripts/${safeSlug}.mjs]`,
    "+    timeoutMs: 600000",
    "",
  ].join("\n");
  return {
    diff,
    declaredOutcome: `Coded gate replaces the model turn for ${stepId}; the operator writes scripts/${safeSlug}.mjs`,
    measure: `Model cost and latency for ${stepId} drop to zero while its accepted rate holds`,
    summary: `Replace the model turn for '${stepId}' (${agentRole}) with a coded gate step`,
  };
}

/** A trimmed, non-empty string, or undefined. */
function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function roundThree(value: number): number {
  return Number(value.toFixed(3));
}

interface GroupAccumulator {
  key: string;
  workflowHash: string;
  workflowId?: string;
  stepId: string;
  agentRole: string;
  promptHash: string;
  costs: number[];
  latencies: number[];
  total: number;
  decided: number;
  passed: number;
  undecided: number;
  reworkCount: number;
  weight: number;
  undated: number;
  writes: boolean;
  decidedRuns: Set<string>;
  /** Decided runs per objective digest; one '(unkeyed)' bucket for records without one. */
  askRuns: Map<string, Set<string>>;
  evidenceRefs: Set<string>;
}

export interface GroupRoutingOptions {
  minRecurrence?: number | undefined;
  minPassRate?: number | undefined;
  /** improvement.telemetryHalfLifeDays; weights order rows and never decide candidacy. */
  halfLifeDays?: number | undefined;
  /** Epoch milliseconds the recency weights are measured against. */
  now?: number | undefined;
}

/**
 * Group routing records by (workflowHash, step, role, promptHash) across runs.
 *
 * Identity: workflowHash is the engine's workflowId when present, then a
 * workflow definition digest, then the run; promptHash is the engine's
 * askSha256 (stable across runs, independent of the objective), then a v1
 * rolePromptSha256. A group is a coded-repeat candidate only when the same
 * objective was decided in at least minRecurrence runs, the accepted rate over
 * decided records reaches minPassRate, and the step writes no repository.
 */
export function groupRoutingRecords(
  records: Array<RoutingRecord | RoutingRecordV2>,
  options: GroupRoutingOptions = {},
): ImprovementGroupRow[] {
  const minRecurrence = options.minRecurrence ?? 2;
  const minPassRate = options.minPassRate ?? 0.75;
  const halfLifeDays = options.halfLifeDays ?? 14;
  const now = options.now ?? Date.now();

  const raws = records.map((record) => record as unknown as Record<string, unknown>);
  const runKeys = raws.map((raw, index) => nonEmptyText(raw.runId) ?? nonEmptyText(raw.workflowRunId) ?? `record:${index}`);
  const stepIds = raws.map((raw) => nonEmptyText(raw.stepId) ?? nonEmptyText(raw.stageId) ?? "unknown");
  const retriesOf = (raw: Record<string, unknown>): number =>
    typeof raw.retries === "number" && Number.isFinite(raw.retries) ? raw.retries : 0;
  // A retry of the same step in the same run supersedes every earlier attempt.
  const maxRetries = new Map<string, number>();
  raws.forEach((raw, index) => {
    const attemptKey = `${runKeys[index]}\u0000${stepIds[index]}`;
    maxRetries.set(attemptKey, Math.max(maxRetries.get(attemptKey) ?? 0, retriesOf(raw)));
  });

  const map = new Map<string, GroupAccumulator>();
  raws.forEach((raw, index) => {
    const providerMeta = raw.providerMetadata && typeof raw.providerMetadata === "object" && !Array.isArray(raw.providerMetadata)
      ? raw.providerMetadata as Record<string, unknown>
      : {};
    const workflowId = nonEmptyText(providerMeta.workflowId);
    const workflowHash = workflowId
      ?? nonEmptyText(raw.workflowDefinitionSha256)
      ?? nonEmptyText(providerMeta.workflowDefinitionSha256)
      ?? nonEmptyText(raw.workflowRunId)
      ?? nonEmptyText(raw.runId)
      ?? "standalone";
    const stepId = stepIds[index]!;
    const agentRole = nonEmptyText(raw.agentRole) ?? "agent";
    const promptHash = nonEmptyText(providerMeta.askSha256) ?? nonEmptyText(raw.rolePromptSha256) ?? "none";
    const runKey = runKeys[index]!;

    const key = `${workflowHash}:${stepId}:${agentRole}:${promptHash}`;
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        workflowHash,
        stepId,
        agentRole,
        promptHash,
        costs: [],
        latencies: [],
        total: 0,
        decided: 0,
        passed: 0,
        undecided: 0,
        reworkCount: 0,
        weight: 0,
        undated: 0,
        writes: false,
        decidedRuns: new Set<string>(),
        askRuns: new Map<string, Set<string>>(),
        evidenceRefs: new Set<string>(),
      };
      map.set(key, group);
    }
    if (group.workflowId === undefined && workflowId !== undefined) group.workflowId = workflowId;

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
    const decided = (verifierOutcome !== undefined && verifierOutcome !== null)
      || (finalOutcome !== undefined && finalOutcome !== null && finalOutcome !== "pending");
    if (decided) {
      group.decided += 1;
      group.decidedRuns.add(runKey);
      const ask = nonEmptyText(providerMeta.objectiveSha256) ?? "(unkeyed)";
      let askRuns = group.askRuns.get(ask);
      if (!askRuns) {
        askRuns = new Set<string>();
        group.askRuns.set(ask, askRuns);
      }
      askRuns.add(runKey);
      const superseded = (maxRetries.get(`${runKey}\u0000${stepId}`) ?? 0) > retriesOf(raw);
      if (!superseded && (verifierOutcome === "passed" || finalOutcome === "accepted" || finalOutcome === "completed")) {
        group.passed += 1;
      }
    } else {
      group.undecided += 1;
    }

    const retries = raw.retries;
    if (typeof retries === "number") {
      group.reworkCount += retries;
    }

    const recordedAt = nonEmptyText(raw.recordedAt);
    if (recordedAt === undefined || !Number.isFinite(Date.parse(recordedAt))) group.undated += 1;
    group.weight += computeDecayedWeight(recordedAt ?? "", halfLifeDays, now);
    if (providerMeta.stepWrites === true) group.writes = true;

    const ref = (raw.attemptId as string) || (raw.runId as string) || (raw.workflowRunId as string) || (raw.behavioralSha256 as string);
    if (ref && group.evidenceRefs.size < 16) {
      group.evidenceRefs.add(ref);
    }
  });

  const keyed: Array<{ key: string; row: ImprovementGroupRow }> = [];
  for (const group of map.values()) {
    const recurrence = group.total;
    const meanCost = group.costs.length > 0
      ? Number((group.costs.reduce((a, b) => a + b, 0) / group.costs.length).toFixed(4))
      : 0;
    const meanLatency = group.latencies.length > 0
      ? Math.round(group.latencies.reduce((a, b) => a + b, 0) / group.latencies.length)
      : 0;
    const verifyPassRate = group.decided > 0 ? roundThree(group.passed / group.decided) : 0;
    const distinctRuns = group.decidedRuns.size;
    const askRecurrence = Math.max(0, ...[...group.askRuns.values()].map((runs) => runs.size));
    const passes = verifyPassRate >= minPassRate;

    const isCandidate = askRecurrence >= minRecurrence && passes && !group.writes;
    let excludedReason: ImprovementExcludedReason | undefined;
    if (!isCandidate && passes) {
      if (askRecurrence >= minRecurrence && group.writes) excludedReason = "writes-repository";
      else if (distinctRuns >= minRecurrence && askRecurrence < minRecurrence) excludedReason = "ask-not-repeated";
    }
    const candidateKind = isCandidate ? classifyCandidateKind(group.stepId, group.agentRole) : undefined;
    const safeSlug = group.stepId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 16) || "step";
    const keyHash = createHash("sha256").update(`${group.workflowHash}:${group.stepId}:${group.agentRole}:${group.promptHash}`).digest("hex").slice(0, 10);
    const candidateId = isCandidate && candidateKind ? `cand_${candidateKind.replace(/-/g, "_")}_${safeSlug}_${keyHash}` : undefined;

    keyed.push({
      key: group.key,
      row: {
        workflowHash: group.workflowHash,
        ...(group.workflowId !== undefined ? { workflowId: group.workflowId } : {}),
        stepId: group.stepId,
        agentRole: group.agentRole,
        promptHash: group.promptHash,
        recurrence,
        distinctRuns,
        askRecurrence,
        undecidedRecords: group.undecided,
        meanCost,
        meanLatency,
        verifyPassRate,
        rework: group.reworkCount,
        weightedRecurrence: roundThree(group.weight),
        undatedRecords: group.undated,
        costSamples: group.costs.length,
        writesRepository: group.writes,
        evidenceRefs: [...group.evidenceRefs],
        isCandidate,
        ...(excludedReason !== undefined ? { excludedReason } : {}),
        ...(candidateKind !== undefined ? { candidateKind } : {}),
        ...(candidateId !== undefined ? { candidateId } : {}),
      },
    });
  }

  return keyed
    .sort((left, right) => {
      const a = left.row;
      const b = right.row;
      if (a.isCandidate !== b.isCandidate) return a.isCandidate ? -1 : 1;
      if (b.weightedRecurrence !== a.weightedRecurrence) return b.weightedRecurrence - a.weightedRecurrence;
      if (b.recurrence !== a.recurrence) return b.recurrence - a.recurrence;
      return compareCodeUnitIds(a.stepId, b.stepId) || compareCodeUnitIds(left.key, right.key);
    })
    .map((entry) => entry.row);
}

export interface BuildImprovementReportOptions extends GroupRoutingOptions {
  candidatesDir?: string | undefined;
  projectRoot?: string | undefined;
  dryRun?: boolean | undefined;
  /** improvement.promotionPolicy; reported as readiness only. */
  promotionPolicy?: string | undefined;
  autoThreshold?: PromotionAutoThreshold | undefined;
}

export function buildImprovementReport(
  records: Array<RoutingRecord | RoutingRecordV2>,
  options: BuildImprovementReportOptions = {},
): ImprovementReport {
  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : process.cwd();
  const candidatesDir = options.candidatesDir ? resolve(options.candidatesDir) : join(projectRoot, ".kxm", "candidates");
  const promotionPolicy = options.promotionPolicy ?? "manual_pr";

  const groups = groupRoutingRecords(records, options);
  const candidates: ImprovementCandidate[] = [];
  const promotion: ImprovementPromotionEntry[] = [];

  for (const group of groups) {
    if (!group.isCandidate || !group.candidateKind || !group.candidateId) continue;

    const { diff, declaredOutcome, measure, summary } = generateCandidateDiff(
      group.candidateKind,
      group.stepId,
      group.agentRole,
      group.workflowId,
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

  const rowsByCandidate = new Map(groups.flatMap((row) => row.candidateId !== undefined ? [[row.candidateId, row] as const] : []));
  for (const candidate of candidates) {
    const row = rowsByCandidate.get(candidate.id);
    promotion.push({
      candidateId: candidate.id,
      ...evaluatePromotionPolicy(candidate, promotionPolicy, {
        autoThreshold: options.autoThreshold,
        ...(row ? { costSamples: row.costSamples, distinctRuns: row.distinctRuns } : {}),
      }),
    });
  }

  return {
    schema: IMPROVEMENT_REPORT_SCHEMA,
    createdAt: nowIso(),
    reviewDecision: "proposed",
    recordsCount: records.length,
    groups,
    candidates,
    promotionPolicy,
    promotion,
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
    `Improvement Report (${report.recordsCount} record(s), ${report.groups.length} group(s), ${report.candidates.length} candidate(s); promotion policy ${report.promotionPolicy})`,
    "",
    "Workflow       Step         Role         Prompt       Records  Runs  Asks  Weighted  Cost ($)  Latency (ms)  Accepted  Rework  Candidate",
    "------------------------------------------------------------------------------------------------------------------------------------------",
  ];

  for (const g of report.groups) {
    const wf = g.workflowHash.slice(0, 12).padEnd(14);
    const step = g.stepId.slice(0, 11).padEnd(12);
    const role = g.agentRole.slice(0, 11).padEnd(12);
    const prompt = g.promptHash.replace(/^sha256:/, "").slice(0, 10).padEnd(12);
    const rec = String(g.recurrence).padStart(7);
    const runs = String(g.distinctRuns).padStart(5);
    const asks = String(g.askRecurrence).padStart(5);
    const weighted = g.weightedRecurrence.toFixed(3).padStart(9);
    const cost = g.meanCost.toFixed(3).padStart(9);
    const lat = String(g.meanLatency).padStart(13);
    const accepted = `${(g.verifyPassRate * 100).toFixed(0)}%`.padStart(9);
    const rework = String(g.rework).padStart(7);
    const cand = g.isCandidate
      ? `yes (${g.candidateKind})`
      : g.excludedReason !== undefined ? `no (${g.excludedReason})` : "no";
    lines.push(`${wf} ${step} ${role} ${prompt} ${rec} ${runs} ${asks} ${weighted} ${cost} ${lat} ${accepted} ${rework}  ${cand}`);
  }

  if (report.candidates.length > 0) {
    const readiness = new Map(report.promotion.map((entry) => [entry.candidateId, entry]));
    lines.push("");
    lines.push("Emitted Coded-Repeat Candidates:");
    for (const c of report.candidates) {
      lines.push(`  - ${c.id} [${c.kind}]: ${c.summary}`);
      lines.push(`    Outcome: ${c.declaredOutcome}`);
      lines.push(`    Measure: ${c.measure}`);
      lines.push(`    Proposed diff: ${c.proposedDiffPath}`);
      const entry = readiness.get(c.id);
      if (entry) {
        lines.push(`    Promotion (${entry.policy}): ${entry.readyForReview ? "ready for review" : "not ready for review"}; ${entry.reason}`);
      }
    }
    lines.push("");
    lines.push("Candidates are proposals: readiness never authorizes, and activation is a reviewed Git change.");
  }

  return lines.join("\n");
}

/** Review readiness of one candidate under improvement.promotionPolicy. */
export interface PromotionReadiness {
  policy: string;
  readyForReview: boolean;
  reason: string;
}

export interface PromotionAutoThreshold {
  minRuns?: number | undefined;
  minPassRate?: number | undefined;
  minCostSavings?: number | undefined;
}

/**
 * Report whether a candidate is ready for operator review (Decision Q11).
 *
 * No policy authorizes anything. AGENTS.md:141 forbids auto-promoting skills
 * or gates from telemetry, and ADR-001 (docs/contracts/architecture.md:177-180)
 * rejects automatic learned-policy activation: activation is a reviewed Git
 * change. Every policy therefore ends at an operator PR:
 * - manual_pr: always ready; the operator reviews the proposed diff.
 * - critic_quorum: ready once two distinct critic receipts are cited.
 * - auto_threshold: ready once the candidate's distinct runs and accepted rate
 *   reach the thresholds and, when minCostSavings is set, recorded cost samples
 *   show at least that mean cost; a group without cost samples is never ready.
 * Any other policy is not ready.
 */
export function evaluatePromotionPolicy(
  candidate: ImprovementCandidate,
  policy: string = "manual_pr",
  options: {
    criticReceipts?: string[] | undefined;
    autoThreshold?: PromotionAutoThreshold | undefined;
    costSamples?: number | undefined;
    distinctRuns?: number | undefined;
  } = {},
): PromotionReadiness {
  if (policy === "manual_pr") {
    return { policy, readyForReview: true, reason: `operator PR applying ${candidate.proposedDiffPath} required` };
  }

  if (policy === "critic_quorum") {
    const receipts = new Set((options.criticReceipts ?? []).map((receipt) => receipt.trim()).filter((receipt) => receipt.length > 0));
    return receipts.size >= 2
      ? { policy, readyForReview: true, reason: "two critic receipts cited; operator PR still required" }
      : { policy, readyForReview: false, reason: `awaiting 2 distinct critic receipts (have ${receipts.size})` };
  }

  if (policy === "auto_threshold") {
    const minRuns = options.autoThreshold?.minRuns ?? 10;
    const minPassRate = options.autoThreshold?.minPassRate ?? 0.95;
    const minCostSavings = options.autoThreshold?.minCostSavings;
    const runs = options.distinctRuns ?? candidate.baselineMetrics.recurrence;
    const passRate = candidate.baselineMetrics.verifyPassRate;
    const costSamples = options.costSamples ?? 0;
    const meanCost = candidate.baselineMetrics.meanCost;
    const costMet = minCostSavings === undefined || (costSamples > 0 && meanCost >= minCostSavings);
    const ready = runs >= minRuns && passRate >= minPassRate && costMet;
    const detail = [
      `runs=${runs}/${minRuns}`,
      `passRate=${passRate}/${minPassRate}`,
      ...(minCostSavings === undefined ? [] : [`meanCost=${meanCost}/${minCostSavings} over ${costSamples} cost sample(s)`]),
    ].join(", ");
    return ready
      ? { policy, readyForReview: true, reason: `auto-threshold met (${detail}); operator PR still required` }
      : { policy, readyForReview: false, reason: `auto-threshold not met (${detail})` };
  }

  return { policy, readyForReview: false, reason: "unknown promotion policy" };
}

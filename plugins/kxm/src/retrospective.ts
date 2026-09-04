import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { redactSecrets, redactStringList } from "./redact.ts";
import {
  canonicalWorkflowEvidenceKey,
  journalPromotionState,
  normalizeVerifiedWorkflowEvidence,
  type WorkflowJournalEntry,
  type WorkflowRun,
} from "./workflow.ts";

export interface RetrospectiveEvidenceAuditV1 {
  stageId: string;
  requirementKey: string;
  attempt: number;
  policy: {
    kind: "peer-reply";
    minProducers: number;
    effectiveMinProducers: number;
    acceptedStatuses: ["replied"];
  };
  eligibleProducers: Array<{ id: string; name: string }>;
  verifiedProducerIds: string[];
  verifiedMessages: Array<{
    schema: "pi-mesh.verified-peer-evidence.v1";
    messageId: string;
    producerId: string;
    producerName: string;
    context: {
      schema: "pi-mesh.workflow-message-context.v1";
      runId: string;
      stageId: string;
      requirementKey: string;
      attempt: number;
    };
    status: "replied";
    hashes: {
      requestSha256: string;
      replySha256: string;
    };
    timestamps: {
      createdAt: string;
      replyCreatedAt: string;
      repliedAt: string;
      verifiedAt: string;
    };
  }>;
  degraded: boolean;
  degradationApprovals: Array<{
    schema: "pi-mesh.workflow-degradation-approval.v1";
    id: string;
    requirementKey: string;
    attempt: number;
    policyMinProducers: number;
    approvedMinProducers: number;
    approvedBy: "kxm-admin";
    reason: string;
    approvedAt: string;
  }>;
}

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
    stageId?: string;
    attempt?: number;
    /** Governed promotion lifecycle state for promotable categories.
     * Absent on v0.4 records and non-promotable categories. */
    promotionState?: string;
  }>;
  proposedImprovements: Array<{ area: string; summary: string; successMeasure: string; status: "proposed" }>;
  /** Additive metadata-only provenance audit. Optional for v1 consumers and
   * absent from runs created before peer-evidence policies existed. */
  evidenceAudit?: RetrospectiveEvidenceAuditV1[];
  /** Stage IDs that completed through an explicit, attempt-bound admin
   * degradation approval. */
  degradedStageIds?: string[];
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

function buildEvidenceAudit(run: WorkflowRun): RetrospectiveEvidenceAuditV1[] {
  const audit: RetrospectiveEvidenceAuditV1[] = [];
  for (const stage of run.stages) {
    const verifiedEvidence = normalizeVerifiedWorkflowEvidence(stage.verifiedEvidence);
    const degradedRequirements = new Set(
      (stage.degradedRequirements ?? []).map(canonicalWorkflowEvidenceKey),
    );
    const policies = Object.entries(stage.resolvedEvidencePolicies ?? {})
      .sort(([left], [right]) => left.localeCompare(right));
    for (const [rawRequirement, policy] of policies) {
      const requirementKey = canonicalWorkflowEvidenceKey(rawRequirement);
      const attempt = stage.status === "passed" || stage.status === "failed"
        ? Math.max(1, stage.attempts)
        : stage.attempts + 1;
      const verifiedMessages = [...(verifiedEvidence[requirementKey] ?? [])]
        .filter((snapshot) => (
          snapshot.context.runId === run.id
          && snapshot.context.stageId === stage.id
          && snapshot.context.requirementKey === requirementKey
          && snapshot.context.attempt === attempt
        ))
        .sort((left, right) => left.messageId.localeCompare(right.messageId))
        .map((snapshot) => ({
          schema: snapshot.schema,
          messageId: snapshot.messageId,
          producerId: snapshot.producerId,
          producerName: snapshot.producerName,
          context: {
            schema: snapshot.context.schema,
            runId: snapshot.context.runId,
            stageId: snapshot.context.stageId,
            requirementKey: snapshot.context.requirementKey,
            attempt: snapshot.context.attempt,
          },
          status: snapshot.status,
          hashes: {
            requestSha256: snapshot.requestSha256,
            replySha256: snapshot.replySha256,
          },
          timestamps: {
            createdAt: snapshot.createdAt,
            replyCreatedAt: snapshot.replyCreatedAt,
            repliedAt: snapshot.repliedAt,
            verifiedAt: snapshot.verifiedAt,
          },
        }));
      const degradationApprovals = (stage.degradationApprovals ?? [])
        .filter((approval) => (
          approval.schema === "pi-mesh.workflow-degradation-approval.v1"
          && approval.requirementKey === requirementKey
          && approval.attempt === attempt
        ))
        .sort((left, right) => left.attempt - right.attempt
          || left.approvedAt.localeCompare(right.approvedAt)
          || left.id.localeCompare(right.id))
        .map((approval) => ({
          schema: approval.schema,
          id: approval.id,
          requirementKey: approval.requirementKey,
          attempt: approval.attempt,
          policyMinProducers: approval.policyMinProducers,
          approvedMinProducers: approval.approvedMinProducers,
          approvedBy: approval.approvedBy,
          reason: redactSecrets(approval.reason).replace(/\s+/gu, " ").trim(),
          approvedAt: approval.approvedAt,
        }));
      const degraded = Boolean(stage.degraded && degradedRequirements.has(requirementKey));
      const appliedApproval = degradationApprovals.at(-1);
      audit.push({
        stageId: stage.id,
        requirementKey,
        attempt,
        policy: {
          kind: policy.kind,
          minProducers: policy.minProducers,
          effectiveMinProducers: appliedApproval?.approvedMinProducers ?? policy.minProducers,
          acceptedStatuses: ["replied"],
        },
        eligibleProducers: [...policy.eligibleProducers]
          .sort((left, right) => left.id.localeCompare(right.id) || left.name.localeCompare(right.name))
          .map((producer) => ({ id: producer.id, name: producer.name })),
        verifiedProducerIds: [...new Set(verifiedMessages.map((snapshot) => snapshot.producerId))].sort(),
        verifiedMessages,
        degraded,
        degradationApprovals,
      });
    }
  }
  return audit;
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
    .map((entry) => {
      const promotionState = journalPromotionState(entry);
      const exported: RetrospectiveV1["entries"][number] = {
        id: entry.id,
        category: entry.category,
        area: entry.area,
        severity: entry.severity,
        summary: redactSecrets(entry.summary),
        evidence: redactStringList(entry.evidence),
        relatedEntryIds: entry.relatedEntryIds.slice(0, 16),
        createdAt: entry.createdAt,
      };
      if (entry.stageId !== undefined) exported.stageId = entry.stageId;
      if (entry.attempt !== undefined) exported.attempt = entry.attempt;
      if (promotionState !== undefined) exported.promotionState = promotionState;
      return exported;
    });
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
  const evidenceAudit = buildEvidenceAudit(run);
  const degradedStageIds = run.stages
    .filter((stage) => stage.degraded)
    .map((stage) => stage.id);
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
    ...(evidenceAudit.length ? { evidenceAudit } : {}),
    ...(degradedStageIds.length ? { degradedStageIds } : {}),
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
  const evidenceAuditRows = (doc.evidenceAudit ?? []).flatMap((audit) => {
    const producerNames = audit.eligibleProducers
      .map((producer) => `${producer.name} (${producer.id})`)
      .join(", ") || "none";
    const verified = audit.verifiedMessages.length
      ? audit.verifiedMessages.map((snapshot) => (
        `  - ${snapshot.messageId}: producer ${snapshot.producerName} (${snapshot.producerId}), attempt ${snapshot.context.attempt}, request ${snapshot.hashes.requestSha256}, reply ${snapshot.hashes.replySha256}, replied ${snapshot.timestamps.repliedAt}, verified ${snapshot.timestamps.verifiedAt}`
      ))
      : ["  - no verified messages"];
    const approvals = audit.degradationApprovals.map((approval) => (
      `  - approval ${approval.id}: attempt ${approval.attempt}, ${approval.policyMinProducers} -> ${approval.approvedMinProducers} producers, ${approval.approvedBy}, ${approval.approvedAt}; reason: ${approval.reason}`
    ));
    return [
      `- ${audit.stageId} / ${audit.requirementKey} / attempt ${audit.attempt}: ${audit.verifiedProducerIds.length}/${audit.policy.effectiveMinProducers} verified producers; policy minimum ${audit.policy.minProducers}; degraded: ${audit.degraded}`,
      `  - eligible: ${producerNames}`,
      ...verified,
      ...(approvals.length ? ["  - degradation approvals:", ...approvals] : []),
    ];
  });
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
    ...(doc.evidenceAudit?.length ? [
      "## Peer-evidence audit",
      "",
      "This section contains immutable provenance metadata and content hashes only; prompt and reply bodies are excluded.",
      "",
      ...evidenceAuditRows,
      "",
    ] : []),
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

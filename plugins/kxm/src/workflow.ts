import { createHash } from "node:crypto";
import {
  IMPROVEMENT_AREAS,
  MAX_MESSAGE_TTL_MS,
  MIN_MESSAGE_TTL_MS,
  ProtocolError,
  TERMINAL_RECEIPT_SCHEMA,
  newId,
  requireString,
  validateTerminalReceipt,
  type ImprovementArea,
  type JournalCategory,
  type MessageRecord,
  type TerminalReceipt,
  type TerminalReceiptEvidence,
  type TerminalReceiptMetrics,
  type TerminalReceiptStatus,
  type WorkflowCheckpointStatus,
  type WorkflowEvidenceInput,
  type WorkflowEvidenceReference,
  type WorkflowEvidenceReferenceInput,
  type WorkflowMessageContext,
} from "./protocol.ts";
import { redactSecrets } from "./redact.ts";
import { compareCodeUnitIds } from "./relevance.ts";

export type {
  ImprovementArea,
  JournalCategory,
  TerminalReceipt,
  TerminalReceiptEvidence,
  TerminalReceiptMetrics,
  TerminalReceiptStatus,
  WorkflowCheckpointStatus,
  WorkflowEvidenceInput,
  WorkflowEvidenceReference,
  WorkflowEvidenceReferenceInput,
} from "./protocol.ts";
export { TERMINAL_RECEIPT_SCHEMA, validateTerminalReceipt } from "./protocol.ts";

export type WorkflowRunStatus = "running" | "waiting" | "completed" | "failed";
export type WorkflowStageStatus = "pending" | "in_progress" | "waiting" | WorkflowCheckpointStatus;

/** Every journal category this runtime accepts. v0.4 records only use the
 * first five; the v0.5 additions turn the journal into the canonical episode
 * and learning substrate. */
export const JOURNAL_CATEGORIES: readonly JournalCategory[] = [
  "plan",
  "decision",
  "contradiction",
  "error",
  "lesson",
  "observation",
  "hypothesis",
  "experiment",
  "state-change",
  "skill-candidate",
];

/** Categories that must cite durable evidence references. A lesson without
 * evidence is an opinion; a skill-candidate without verified receipts is a
 * wish. Both fail closed at the hub. */
export const EVIDENCE_REQUIRED_JOURNAL_CATEGORIES: readonly JournalCategory[] = ["lesson", "skill-candidate"];

/** Categories that participate in the governed promotion lifecycle. */
export const PROMOTABLE_JOURNAL_CATEGORIES: readonly JournalCategory[] = ["skill-candidate", "hypothesis", "experiment"];

export function parseJournalCategory(value: unknown): JournalCategory {
  if (typeof value !== "string" || !JOURNAL_CATEGORIES.includes(value as JournalCategory)) {
    throw new ProtocolError(
      400,
      `invalid journal category: must be one of ${JOURNAL_CATEGORIES.join(", ")}`,
      "invalid_journal_category",
    );
  }
  return value as JournalCategory;
}

export function journalEvidenceRequired(category: JournalCategory): boolean {
  return EVIDENCE_REQUIRED_JOURNAL_CATEGORIES.includes(category);
}

export type JournalPromotionState = "proposed" | "approved" | "rejected" | "quarantined";
export const JOURNAL_PROMOTION_STATES: readonly JournalPromotionState[] = ["proposed", "approved", "rejected", "quarantined"];
const JOURNAL_PROMOTION_TERMINAL: readonly JournalPromotionState[] = ["approved", "rejected", "quarantined"];

/** Durable, append-only promotion decision for a journal entry. Journals are
 * evidence, never executable policy: a promotion record changes the learning
 * lifecycle of an entry, and nothing else. */
export interface JournalPromotionRecord {
  schema: "kxm.journal-promotion.v1";
  from: JournalPromotionState;
  to: JournalPromotionState;
  evidenceRefs: string[];
  decidedBy: string;
  reason: string;
  decidedAt: string;
}

/** Durable evidence accumulated across local work, retries, and an external
 * signal. A legacy string array can still be read from pre-0.4 databases, but
 * it never satisfies a keyed requirement. */
export type WorkflowEvidence = Record<string, string[]>;

export interface PeerReplyDegradationPolicy {
  minProducers: number;
}

export interface PeerReplyEvidencePolicy {
  kind: "peer-reply";
  minProducers: number;
  eligibleAgents: string[];
  acceptedStatuses?: ["replied"];
  degradation?: PeerReplyDegradationPolicy;
}

export type WorkflowEvidencePolicy = PeerReplyEvidencePolicy;
export type WorkflowEvidencePolicies = Record<string, WorkflowEvidencePolicy>;

export interface EligiblePeerProducer {
  id: string;
  name: string;
}

export interface ResolvedPeerReplyEvidencePolicy {
  kind: "peer-reply";
  minProducers: number;
  eligibleProducers: EligiblePeerProducer[];
  acceptedStatuses: ["replied"];
  degradation?: PeerReplyDegradationPolicy;
}

export type ResolvedWorkflowEvidencePolicies = Record<string, ResolvedPeerReplyEvidencePolicy>;

export interface VerifiedPeerEvidenceSnapshot {
  schema: "pi-mesh.verified-peer-evidence.v1";
  messageId: string;
  producerId: string;
  producerName: string;
  context: WorkflowMessageContext;
  status: "replied";
  requestSha256: string;
  replySha256: string;
  createdAt: string;
  replyCreatedAt: string;
  repliedAt: string;
  verifiedAt: string;
}

export type WorkflowVerifiedEvidence = Record<string, VerifiedPeerEvidenceSnapshot[]>;

export interface WorkflowDegradationApproval {
  schema: "pi-mesh.workflow-degradation-approval.v1";
  id: string;
  requirementKey: string;
  attempt: number;
  policyMinProducers: number;
  approvedMinProducers: number;
  approvedBy: "kxm-admin";
  reason: string;
  approvedAt: string;
}

export interface WorkflowStageDefinition {
  id: string;
  label: string;
  instructions: string;
  requiredEvidence: string[];
  maxAttempts: number;
  /** Bounded in-place retry limit before audit escalation (default: 2). */
  autoResumeLimit?: number;
  area?: ImprovementArea;
  evidencePolicies?: WorkflowEvidencePolicies;
  /** Typed outcome map (v0.5). Keys are outcome identities ("passed",
   * "failed", or declared custom outcomes); values are stage IDs or
   * "$terminal". Only declared keys create transitions; undeclared outcomes
   * keep the v0.4 default edges (forward-next, attempt-bounded retry). */
  on?: WorkflowOutcomeMap;
  /** Per-stage budget on transitions taken from this stage. */
  maxTransitions?: number;
}

/** A declared transition: a target stage ID, "$terminal", or a rule with a
 * per-edge budget. */
export interface WorkflowTransitionRule {
  target: string;
  maxTransitions?: number;
}

export type WorkflowOutcomeValue = string | WorkflowTransitionRule;
export type WorkflowOutcomeMap = Record<string, WorkflowOutcomeValue>;

export const WORKFLOW_TERMINAL_TARGET = "$terminal";

/** One durably journaled typed transition. */
export interface WorkflowTransitionRecord {
  id: string;
  fromStage: string;
  toStage: string;
  outcome: string;
  attempt: number;
  evidenceKeys: string[];
  at: string;
}

export function normalizeOutcomeValue(value: WorkflowOutcomeValue, field: string): WorkflowTransitionRule {
  if (typeof value === "string") return { target: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a stage ID, "$terminal", or a { target, maxTransitions } rule`);
  }
  const rule = value as Partial<WorkflowTransitionRule>;
  if (typeof rule.target !== "string" || !rule.target.trim()) {
    throw new Error(`${field}.target must be a non-empty stage ID or "$terminal"`);
  }
  if (rule.maxTransitions !== undefined
    && (!Number.isInteger(rule.maxTransitions) || (rule.maxTransitions as number) < 1 || (rule.maxTransitions as number) > 100)) {
    throw new Error(`${field}.maxTransitions must be an integer between 1 and 100`);
  }
  return { target: rule.target, ...(rule.maxTransitions !== undefined ? { maxTransitions: rule.maxTransitions } : {}) };
}

export interface WebhookWorkflowDefinition {
  id: string;
  source: "jira" | "github" | "generic";
  project: string;
  target: string;
  secret: string;
  signalSecret?: string;
  event?: string;
  filter?: { path: string; equals: string };
  delivery: "steer" | "followUp";
  ttlMs?: number;
  promptTemplate: string;
  stages: WorkflowStageDefinition[];
  /** Global budget on typed transitions per run. Required whenever any stage
   * declares a back-edge (a cycle without a budget is rejected at load). */
  maxTransitions?: number;
  /** Immutable reproduction oracle (v0.5 /fix): when `stageId` passes, the
   * sha256 of `evidenceKey`'s value is captured on the run. Any later
   * checkpoint citing the same evidence key with different values is
   * rejected — a confirmed reproduction may not be weakened to make the
   * fix pass. */
  reproOracle?: WorkflowOracleConfig;
  /** Approved-plan hash: when `stageId` passes, the sha256 of `evidenceKey`'s
   * value is captured on the run. */
  planHash?: WorkflowOracleConfig;
  /** Stages that cannot checkpoint until the plan hash is captured. */
  requirePlanHash?: string[];
}

export interface WorkflowOracleConfig {
  stageId: string;
  evidenceKey: string;
}

export interface WorkflowStageState extends WorkflowStageDefinition {
  status: WorkflowStageStatus;
  attempts: number;
  summary?: string;
  evidence: WorkflowEvidence | string[];
  resolvedEvidencePolicies?: ResolvedWorkflowEvidencePolicies;
  verifiedEvidence?: WorkflowVerifiedEvidence;
  degradationApprovals?: WorkflowDegradationApproval[];
  degraded?: boolean;
  degradedRequirements?: string[];
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  receipt?: TerminalReceipt;
  auditEscalation?: {
    reason: string;
    timestamp: string;
    ruling?: string;
    receipt?: TerminalReceipt;
  };
}

export interface CapturedOracle {
  evidenceKey: string;
  sha256: string;
  capturedAt: string;
}

export interface WorkflowWaitState {
  stageId: string;
  signalKey: string;
  summary: string;
  createdAt: string;
  expiresAt: string;
}

export interface WorkflowSignalReceipt {
  deliveryId: string;
  payloadHash: string;
  signalKey: string;
  stageId: string;
  status: WorkflowCheckpointStatus;
  degraded?: boolean;
  degradedRequirements?: string[];
  messageId?: string;
  receivedAt: string;
}

export interface WorkflowRun {
  id: string;
  definitionId: string;
  source: WebhookWorkflowDefinition["source"];
  deliveryId: string;
  payloadHash: string;
  /** sha256 of the canonical workflow definition JSON, stamped at run
   * creation. Optional on read: runs persisted before this field existed
   * still load, they simply have no hash to compare. */
  definitionHash?: string;
  event?: string;
  project: string;
  targetAgentId: string;
  targetAgentName: string;
  messageId: string;
  status: WorkflowRunStatus;
  currentStage?: string;
  waiting?: WorkflowWaitState;
  signalReceipts?: WorkflowSignalReceipt[];
  stages: WorkflowStageState[];
  /** Durable typed-transition journal (v0.5), oldest first, bounded by the
   * definition's maxTransitions. Absent on v0.4 runs. */
  transitions?: WorkflowTransitionRecord[];
  /** Global transition budget copied from the definition at run creation. */
  maxTransitions?: number;
  /** Captured immutable reproduction oracle (sha256 of the repro evidence). */
  oracle?: CapturedOracle;
  /** Captured approved-plan hash. */
  planHash?: CapturedOracle;
  /** Stages that require the plan hash before checkpointing. */
  requirePlanHash?: string[];
  /** Oracle config copied from the definition at run creation. */
  reproOracle?: WorkflowOracleConfig;
  planHashConfig?: WorkflowOracleConfig;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkflowJournalEntry {
  id: string;
  runId: string;
  agentId: string;
  category: JournalCategory;
  area: ImprovementArea;
  severity: "info" | "warning" | "error";
  summary: string;
  details?: string;
  evidence: string[];
  relatedEntryIds: string[];
  createdAt: string;
  /** Stage the entry was recorded against. Optional: v0.4 entries and
   * run-level entries have no stage binding. */
  stageId?: string;
  /** Attempt the entry was recorded against, when stage-bound. */
  attempt?: number;
  /** Governed promotion history. Absent on v0.4 records and on entries that
   * never entered the promotion lifecycle. */
  promotion?: JournalPromotionRecord[];
}

/** Current promotion lifecycle state of an entry. Entries without promotion
 * records are implicitly `proposed` when they belong to a promotable
 * category. */
export function journalPromotionState(entry: WorkflowJournalEntry): JournalPromotionState | undefined {
  if (!PROMOTABLE_JOURNAL_CATEGORIES.includes(entry.category)) return undefined;
  const records = entry.promotion ?? [];
  return records.length === 0 ? "proposed" : records[records.length - 1]?.to;
}

export interface JournalPromotionDecision {
  to: Exclude<JournalPromotionState, "proposed">;
  evidenceRefs: string[];
  decidedBy: string;
  reason: string;
}

/** Apply a governed promotion transition. Returns a new entry; never mutates
 * in place. Rules: only promotable categories; `proposed` is the only
 * non-terminal state; the author of an entry can never decide its promotion;
 * evidence references are required. */
export function applyJournalPromotion(
  entry: WorkflowJournalEntry,
  decision: JournalPromotionDecision,
  decidedAt: string,
): WorkflowJournalEntry {
  if (!PROMOTABLE_JOURNAL_CATEGORIES.includes(entry.category)) {
    throw new ProtocolError(
      400,
      `journal entries of category ${entry.category} do not participate in promotion`,
      "journal_promotion_invalid",
    );
  }
  if (decision.decidedBy === entry.agentId) {
    throw new ProtocolError(
      400,
      "the author of a journal entry cannot decide its promotion",
      "journal_promotion_invalid",
    );
  }
  if (!Array.isArray(decision.evidenceRefs) || decision.evidenceRefs.length < 1
    || decision.evidenceRefs.some((ref) => typeof ref !== "string" || !ref.trim())) {
    throw new ProtocolError(
      400,
      "journal promotion requires at least one durable evidence reference",
      "journal_promotion_invalid",
    );
  }
  const current = journalPromotionState(entry);
  if (current !== "proposed") {
    throw new ProtocolError(
      400,
      `journal entry promotion already reached terminal state ${current}`,
      "journal_promotion_invalid",
    );
  }
  const record: JournalPromotionRecord = {
    schema: "kxm.journal-promotion.v1",
    from: "proposed",
    to: decision.to,
    evidenceRefs: decision.evidenceRefs.map((ref) => ref.trim()),
    decidedBy: decision.decidedBy,
    reason: decision.reason,
    decidedAt,
  };
  return { ...entry, promotion: [...(entry.promotion ?? []), record] };
}

export interface ImprovementAreaReport {
  area: ImprovementArea;
  total: number;
  errors: number;
  contradictions: number;
  lessons: number;
  priorities: WorkflowJournalEntry[];
}

export function improvementReport(entries: WorkflowJournalEntry[]): ImprovementAreaReport[] {
  const severityWeight = { error: 3, warning: 2, info: 1 } as const;
  return IMPROVEMENT_AREAS.map((area) => {
    const matching = entries.filter((entry) => entry.area === area);
    const priorities = [...matching]
      .filter((entry) => entry.category === "error" || entry.category === "contradiction" || entry.category === "lesson" || entry.category === "skill-candidate")
      .sort((left, right) => severityWeight[right.severity] - severityWeight[left.severity])
      .slice(0, 10);
    return {
      area,
      total: matching.length,
      errors: matching.filter((entry) => entry.category === "error").length,
      contradictions: matching.filter((entry) => entry.category === "contradiction").length,
      lessons: matching.filter((entry) => entry.category === "lesson").length,
      priorities,
    };
  }).filter((report) => report.total > 0);
}

/** Diagnostic classes that put a signal in the security tier regardless of
 * its priority (diagnostics.ts). */
export const SECURITY_SIGNAL_CLASSES: readonly string[] = ["invalid_auth", "invalid_identity", "signal_mismatch"];

const SIGNAL_CATEGORIES: readonly JournalCategory[] = ["error", "contradiction", "lesson", "skill-candidate"];
const SIGNAL_SEVERITY_WEIGHT = { error: 3, warning: 2, info: 1 } as const;
const SIGNAL_CLASS = /^[a-z0-9_]{1,64}$/;
const MAX_SIGNAL_IDS = 16;
const MAX_SIGNAL_SUMMARY_KEY_CHARS = 160;

/** Collapse volatile tokens so the same failure in two runs keys the same.
 * Callers redact first: lowercasing and digit folding would otherwise defeat
 * the secret patterns. */
export function normalizeSignalSummary(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/\b[a-z]+_[0-9a-f]{8,}\b/g, "<id>")
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/\b[0-9a-f]{7,}\b/g, "<hex>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SIGNAL_SUMMARY_KEY_CHARS);
}

/** One improvement signal: journal entries from one or more runs that share
 * a key, scored by frequency x severity x run-attempt cost x evidence
 * confidence. Text is redacted; the key never carries raw summary text. */
export interface ImprovementSignal {
  key: string;
  /** Which rule produced the key: an evidence class, an error's stage, or the
   * normalized summary. */
  basis: "class" | "stage" | "summary";
  category: JournalCategory;
  /** Modal area of the grouped entries; ties follow IMPROVEMENT_AREAS order. */
  area: ImprovementArea;
  /** Security signals rank ahead of every priority. */
  overrideTier?: "security";
  /** Distinct runs that recorded this signal. */
  frequency: number;
  runIds: string[];
  entryIds: string[];
  severity: WorkflowJournalEntry["severity"];
  severityWeight: number;
  /** Mean run attempts (stage attempts plus transitions) over the known runs;
   * null when none of the runs is known. */
  workflowCost: number | null;
  costBasis: "run-attempts" | "unknown";
  /** 0.5 plus half the fraction of entries that cite evidence. */
  confidence: number;
  priority: number;
  /** Redacted summary of the latest entry. */
  summary: string;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function signalKeyOf(
  entry: WorkflowJournalEntry,
  runs: ReadonlyMap<string, WorkflowRun>,
): { key: string; basis: ImprovementSignal["basis"]; signalClass?: string } {
  const classRef = entry.evidence.find((ref) => ref.startsWith("class:"));
  const signalClass = classRef?.slice("class:".length);
  if (signalClass !== undefined && SIGNAL_CLASS.test(signalClass) && signalClass !== "unknown") {
    return { key: `${entry.category}|class:${signalClass}`, basis: "class", signalClass };
  }
  const run = runs.get(entry.runId);
  if (entry.category === "error" && entry.stageId !== undefined && run) {
    return { key: `error|stage:${run.definitionId}/${entry.stageId}`, basis: "stage" };
  }
  return {
    key: `${entry.category}|summary:${normalizeSignalSummary(redactSecrets(entry.summary))}`,
    basis: "summary",
  };
}

function runAttemptCost(run: WorkflowRun): number {
  let attempts = 0;
  for (const stage of run.stages) attempts += stage.attempts;
  return Math.max(1, attempts + (run.transitions?.length ?? 0));
}

/** Merge journal learning across runs into ranked, redacted signals. Only
 * errors, open contradictions, lessons and still-proposed skill candidates
 * count. Security signals come first, then priority, frequency and key; no
 * id or insertion order decides a tie. */
export function rankImprovementSignals(
  entries: readonly WorkflowJournalEntry[],
  runs: ReadonlyMap<string, WorkflowRun>,
  limit = 20,
): ImprovementSignal[] {
  const resolvedContradictions = new Set<string>();
  for (const entry of entries) {
    if (entry.category !== "decision" && entry.category !== "lesson") continue;
    for (const related of entry.relatedEntryIds) resolvedContradictions.add(`${entry.runId}\u0000${related}`);
  }

  const groups = new Map<string, {
    basis: ImprovementSignal["basis"];
    category: JournalCategory;
    signalClass?: string;
    entries: WorkflowJournalEntry[];
  }>();
  for (const entry of entries) {
    if (!SIGNAL_CATEGORIES.includes(entry.category)) continue;
    if (entry.category === "contradiction" && resolvedContradictions.has(`${entry.runId}\u0000${entry.id}`)) continue;
    const promotionState = journalPromotionState(entry);
    if (promotionState !== undefined && promotionState !== "proposed") continue;
    const { key, basis, signalClass } = signalKeyOf(entry, runs);
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { basis, category: entry.category, ...(signalClass !== undefined ? { signalClass } : {}), entries: [entry] });
  }

  const areaRank = (area: string): number => {
    const index = IMPROVEMENT_AREAS.indexOf(area as ImprovementArea);
    return index === -1 ? IMPROVEMENT_AREAS.length : index;
  };

  const signals: ImprovementSignal[] = [];
  for (const [key, group] of groups) {
    const runIds = [...new Set(group.entries.map((entry) => entry.runId))].sort(compareCodeUnitIds);
    const entryIds = group.entries.map((entry) => entry.id).sort(compareCodeUnitIds);

    let severity: WorkflowJournalEntry["severity"] = "info";
    for (const entry of group.entries) {
      if ((SIGNAL_SEVERITY_WEIGHT[entry.severity] ?? 0) > SIGNAL_SEVERITY_WEIGHT[severity]) severity = entry.severity;
    }
    const severityWeight = SIGNAL_SEVERITY_WEIGHT[severity];

    const knownRuns = runIds.map((runId) => runs.get(runId)).filter((run): run is WorkflowRun => run !== undefined);
    const workflowCost = knownRuns.length > 0
      ? knownRuns.reduce((total, run) => total + runAttemptCost(run), 0) / knownRuns.length
      : null;

    const withEvidence = group.entries.filter((entry) => entry.evidence.length > 0).length;
    const confidence = 0.5 + 0.5 * (withEvidence / group.entries.length);

    const areaCounts = new Map<ImprovementArea, number>();
    for (const entry of group.entries) areaCounts.set(entry.area, (areaCounts.get(entry.area) ?? 0) + 1);
    const area = [...areaCounts].sort((left, right) => right[1] - left[1] || areaRank(left[0]) - areaRank(right[0]))[0]![0];

    const latest = [...group.entries].sort((left, right) =>
      compareCodeUnitIds(left.createdAt, right.createdAt) || compareCodeUnitIds(left.id, right.id)).at(-1)!;

    const security = area === "security"
      || (group.signalClass !== undefined && SECURITY_SIGNAL_CLASSES.includes(group.signalClass));

    signals.push({
      key,
      basis: group.basis,
      category: group.category,
      area,
      ...(security ? { overrideTier: "security" as const } : {}),
      frequency: runIds.length,
      runIds: runIds.slice(0, MAX_SIGNAL_IDS),
      entryIds: entryIds.slice(0, MAX_SIGNAL_IDS),
      severity,
      severityWeight,
      workflowCost,
      costBasis: workflowCost === null ? "unknown" : "run-attempts",
      confidence,
      priority: round3(runIds.length * severityWeight * (workflowCost ?? 1) * confidence),
      summary: redactSecrets(latest.summary),
    });
  }

  return signals
    .sort((left, right) =>
      (right.overrideTier === "security" ? 1 : 0) - (left.overrideTier === "security" ? 1 : 0)
      || right.priority - left.priority
      || right.frequency - left.frequency
      || compareCodeUnitIds(left.key, right.key))
    .slice(0, limit);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return value.map((item) => (item as string).trim());
}

/** Canonical requirement identity used for matching and durable storage. */
export function canonicalWorkflowEvidenceKey(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

export function normalizeWorkflowEvidence(value: unknown): WorkflowEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized = new Map<string, string[]>();
  for (const [requirement, candidate] of Object.entries(value as Record<string, unknown>)) {
    const key = canonicalWorkflowEvidenceKey(requirement);
    if (!key) continue;
    const values = Array.isArray(candidate) ? candidate : [candidate];
    const safeValues = values
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .map((item) => item.trim());
    if (safeValues.length > 0) {
      normalized.set(key, [...new Set([...(normalized.get(key) ?? []), ...safeValues])]);
    }
  }
  return Object.fromEntries(normalized);
}

export function normalizeVerifiedWorkflowEvidence(value: unknown): WorkflowVerifiedEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = new Map<string, VerifiedPeerEvidenceSnapshot[]>();
  for (const [rawRequirement, rawSnapshots] of Object.entries(value as Record<string, unknown>)) {
    const requirement = canonicalWorkflowEvidenceKey(rawRequirement);
    if (!requirement || !Array.isArray(rawSnapshots)) continue;
    const snapshots = rawSnapshots.filter((candidate): candidate is VerifiedPeerEvidenceSnapshot => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const snapshot = candidate as Partial<VerifiedPeerEvidenceSnapshot>;
      return snapshot.schema === "pi-mesh.verified-peer-evidence.v1"
        && typeof snapshot.messageId === "string"
        && typeof snapshot.producerId === "string"
        && typeof snapshot.producerName === "string"
        && snapshot.status === "replied"
        && typeof snapshot.requestSha256 === "string"
        && typeof snapshot.replySha256 === "string"
        && typeof snapshot.createdAt === "string"
        && typeof snapshot.replyCreatedAt === "string"
        && typeof snapshot.repliedAt === "string"
        && typeof snapshot.verifiedAt === "string"
        && snapshot.context?.schema === "pi-mesh.workflow-message-context.v1";
    });
    if (snapshots.length) result.set(requirement, snapshots);
  }
  return Object.fromEntries(result);
}

export function mergeVerifiedWorkflowEvidence(
  current: WorkflowVerifiedEvidence | undefined,
  incoming: WorkflowVerifiedEvidence = {},
): WorkflowVerifiedEvidence {
  const merged = new Map(Object.entries(normalizeVerifiedWorkflowEvidence(current)));
  for (const [rawRequirement, snapshots] of Object.entries(incoming)) {
    const requirement = canonicalWorkflowEvidenceKey(rawRequirement);
    if (!requirement) continue;
    const values = [...(merged.get(requirement) ?? [])];
    for (const snapshot of snapshots) {
      if (!values.some((candidate) => candidate.messageId === snapshot.messageId)) values.push(snapshot);
    }
    if (values.length) merged.set(requirement, values);
  }
  return Object.fromEntries(merged);
}

export function mergeWorkflowEvidence(
  current: WorkflowEvidence | string[] | undefined,
  incoming: WorkflowEvidenceInput = {},
): WorkflowEvidence {
  const merged = new Map(Object.entries(normalizeWorkflowEvidence(current)));
  const seen = new Set<string>();
  for (const [rawRequirement, rawValue] of Object.entries(incoming)) {
    const requirement = canonicalWorkflowEvidenceKey(rawRequirement);
    if (!requirement || typeof rawValue !== "string" || !rawValue.trim()) {
      throw new ProtocolError(400, "evidence must contain non-empty keyed string values", "invalid_workflow_evidence");
    }
    if (seen.has(requirement)) {
      throw new ProtocolError(
        400,
        `evidence contains duplicate normalized requirement identity: ${requirement}`,
        "invalid_workflow_evidence",
      );
    }
    seen.add(requirement);
    const value = rawValue.trim();
    const values = merged.get(requirement) ?? [];
    if (!values.includes(value)) values.push(value);
    merged.set(requirement, values);
  }
  return Object.fromEntries(merged);
}

export function missingWorkflowEvidence(required: string[], evidence: WorkflowEvidence): string[] {
  return required
    .map(canonicalWorkflowEvidenceKey)
    .filter((requirement) => !evidence[requirement]?.length);
}

export function workflowEvidenceStrings(evidence: WorkflowEvidenceInput | WorkflowEvidence): string[] {
  return Object.entries(evidence).flatMap(([requirement, candidate]) => {
    const values = Array.isArray(candidate) ? candidate : [candidate];
    return values.map((value) => `${requirement}: ${value}`);
  });
}

export function activeWorkflowAttempt(stage: Pick<WorkflowStageState, "attempts">): number {
  return stage.attempts + 1;
}

/** The attempt a stage-bound journal entry belongs to. An active or waiting
 * stage is on its next attempt; a finished stage is on the last attempt it
 * consumed; a pending stage that never ran has no attempt yet. The caller
 * never supplies it. */
export function journalAttemptFor(stage: Pick<WorkflowStageState, "status" | "attempts">): number | undefined {
  switch (stage.status) {
    case "in_progress":
    case "waiting":
      return stage.attempts + 1;
    case "pending":
      return stage.attempts > 0 ? stage.attempts : undefined;
    case "passed":
    case "warning":
    case "failed":
      return Math.max(1, stage.attempts);
  }
}

export interface EvidenceLookup {
  getMessage(id: string): MessageRecord | undefined;
}

function validIsoTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Verify a complete reference batch without mutating the run. */
export function verifyWorkflowEvidenceReferences(
  run: WorkflowRun,
  stage: WorkflowStageState,
  references: WorkflowEvidenceReferenceInput,
  lookup: EvidenceLookup,
  verifiedAt: string,
): WorkflowVerifiedEvidence {
  const expectedAttempt = activeWorkflowAttempt(stage);
  const result = new Map<string, VerifiedPeerEvidenceSnapshot[]>();
  const seenRequirements = new Set<string>();
  const seenMessageIds = new Set<string>();

  for (const [rawRequirement, reference] of Object.entries(references)) {
    const requirementKey = canonicalWorkflowEvidenceKey(rawRequirement);
    if (!requirementKey || seenRequirements.has(requirementKey)) {
      throw new ProtocolError(
        400,
        `evidenceRefs contains duplicate or empty requirement identity: ${requirementKey || "(empty)"}`,
        "invalid_workflow_evidence_refs",
      );
    }
    seenRequirements.add(requirementKey);
    const policy = stage.resolvedEvidencePolicies?.[requirementKey];
    if (!policy) {
      throw new ProtocolError(
        400,
        `requirement ${requirementKey} does not declare a resolved peer evidence policy`,
        "workflow_evidence_policy_missing",
      );
    }
    if (!reference || !Array.isArray(reference.messageIds) || reference.messageIds.length < 1 || reference.messageIds.length > 16) {
      throw new ProtocolError(
        400,
        `evidenceRefs.${requirementKey}.messageIds must contain between 1 and 16 message IDs`,
        "invalid_workflow_evidence_refs",
      );
    }

    const eligibleProducerIds = new Set(policy.eligibleProducers.map((producer) => producer.id));
    const snapshots: VerifiedPeerEvidenceSnapshot[] = [];
    for (const rawMessageId of reference.messageIds) {
      const messageId = typeof rawMessageId === "string" ? rawMessageId.trim() : "";
      if (!messageId || seenMessageIds.has(messageId)) {
        throw new ProtocolError(
          400,
          `evidenceRefs contains an empty or duplicate message ID: ${messageId || "(empty)"}`,
          "invalid_workflow_evidence_refs",
        );
      }
      seenMessageIds.add(messageId);
      const message = lookup.getMessage(messageId);
      if (!message) {
        throw new ProtocolError(400, `peer evidence message not found: ${messageId}`, "workflow_provenance_invalid");
      }
      const context = message.workflowContext;
      if (
        context?.schema !== "pi-mesh.workflow-message-context.v1"
        || context.runId !== run.id
        || context.stageId !== stage.id
        || context.requirementKey !== requirementKey
        || context.attempt !== expectedAttempt
      ) {
        throw new ProtocolError(
          400,
          `peer evidence message ${messageId} is not bound to ${run.id}/${stage.id}/${requirementKey}/attempt-${expectedAttempt}`,
          "workflow_provenance_invalid",
        );
      }
      if (message.project !== run.project || message.from !== run.targetAgentId || message.to === run.targetAgentId) {
        throw new ProtocolError(
          400,
          `peer evidence message ${messageId} has an invalid project or direction`,
          "workflow_provenance_invalid",
        );
      }
      if (!eligibleProducerIds.has(message.to)) {
        throw new ProtocolError(
          400,
          `peer evidence producer ${message.toName} is not eligible for ${requirementKey}`,
          "workflow_provenance_invalid",
        );
      }
      if (message.correlationId !== run.id || message.status !== "replied" || !message.reply?.content.trim()) {
        throw new ProtocolError(
          400,
          `peer evidence message ${messageId} is not a replied message for run ${run.id}`,
          "workflow_provenance_invalid",
        );
      }
      const createdAt = validIsoTimestamp(message.createdAt);
      const deliveredAt = message.deliveredAt === undefined ? undefined : validIsoTimestamp(message.deliveredAt);
      const replyCreatedAt = validIsoTimestamp(message.reply.createdAt);
      const repliedAt = validIsoTimestamp(message.repliedAt);
      if (
        createdAt === undefined
        || replyCreatedAt === undefined
        || repliedAt === undefined
        || (message.deliveredAt !== undefined && deliveredAt === undefined)
        || (deliveredAt !== undefined && (deliveredAt < createdAt || deliveredAt > repliedAt))
        || replyCreatedAt < createdAt
        || repliedAt < replyCreatedAt
      ) {
        throw new ProtocolError(
          400,
          `peer evidence message ${messageId} has incoherent reply timestamps`,
          "workflow_provenance_invalid",
        );
      }
      snapshots.push({
        schema: "pi-mesh.verified-peer-evidence.v1",
        messageId: message.id,
        producerId: message.to,
        producerName: message.toName,
        context: { ...context },
        status: "replied",
        requestSha256: createHash("sha256").update(message.content, "utf8").digest("hex"),
        replySha256: createHash("sha256").update(message.reply.content, "utf8").digest("hex"),
        createdAt: message.createdAt,
        replyCreatedAt: message.reply.createdAt,
        repliedAt: message.repliedAt!,
        verifiedAt,
      });
    }
    result.set(requirementKey, snapshots);
  }
  return Object.fromEntries(result);
}

export interface PeerEvidenceRequirementStatus {
  requirementKey: string;
  policyMinProducers: number;
  effectiveMinProducers: number;
  producers: string[];
  met: boolean;
  degraded: boolean;
  approval?: WorkflowDegradationApproval;
}

export function peerEvidenceRequirementStatus(
  stage: WorkflowStageState,
  requirementKey: string,
  runId: string,
  verifiedEvidence: WorkflowVerifiedEvidence = normalizeVerifiedWorkflowEvidence(stage.verifiedEvidence),
): PeerEvidenceRequirementStatus | undefined {
  const canonicalKey = canonicalWorkflowEvidenceKey(requirementKey);
  const policy = stage.resolvedEvidencePolicies?.[canonicalKey];
  if (!policy) return undefined;
  const attempt = activeWorkflowAttempt(stage);
  const eligibleIds = new Set(policy.eligibleProducers.map((producer) => producer.id));
  const producers = new Set<string>();
  for (const snapshot of verifiedEvidence[canonicalKey] ?? []) {
    if (
      snapshot.schema === "pi-mesh.verified-peer-evidence.v1"
      && snapshot.status === "replied"
      && snapshot.context?.schema === "pi-mesh.workflow-message-context.v1"
      && snapshot.context.runId === runId
      && snapshot.context.stageId === stage.id
      && snapshot.context.requirementKey === canonicalKey
      && snapshot.context.attempt === attempt
      && eligibleIds.has(snapshot.producerId)
      && /^[a-f0-9]{64}$/.test(snapshot.requestSha256)
      && /^[a-f0-9]{64}$/.test(snapshot.replySha256)
      && validIsoTimestamp(snapshot.createdAt) !== undefined
      && validIsoTimestamp(snapshot.replyCreatedAt) !== undefined
      && validIsoTimestamp(snapshot.repliedAt) !== undefined
      && validIsoTimestamp(snapshot.verifiedAt) !== undefined
    ) producers.add(snapshot.producerId);
  }
  const approval = stage.degradationApprovals?.find(
    (candidate) => candidate.requirementKey === canonicalKey && candidate.attempt === attempt,
  );
  const effectiveMinProducers = approval?.approvedMinProducers ?? policy.minProducers;
  return {
    requirementKey: canonicalKey,
    policyMinProducers: policy.minProducers,
    effectiveMinProducers,
    producers: [...producers],
    met: producers.size >= effectiveMinProducers,
    degraded: Boolean(approval && producers.size < policy.minProducers && producers.size >= effectiveMinProducers),
    ...(approval ? { approval } : {}),
  };
}

function requireCompleteEvidence(
  stage: WorkflowStageState,
  evidence: WorkflowEvidence,
  verifiedEvidence: WorkflowVerifiedEvidence,
  runId: string,
): PeerEvidenceRequirementStatus[] {
  const missing: string[] = [];
  const peerStatuses: PeerEvidenceRequirementStatus[] = [];
  for (const rawRequirement of stage.requiredEvidence) {
    const requirement = canonicalWorkflowEvidenceKey(rawRequirement);
    const peerStatus = peerEvidenceRequirementStatus(stage, requirement, runId, verifiedEvidence);
    if (peerStatus) {
      peerStatuses.push(peerStatus);
      if (!peerStatus.met) missing.push(requirement);
    } else if (stage.evidencePolicies?.[requirement]) {
      throw new ProtocolError(
        409,
        `stage ${stage.id} evidence policy ${requirement} was not resolved when the run started`,
        "workflow_evidence_policy_unresolved",
      );
    } else if (!evidence[requirement]?.length) {
      missing.push(requirement);
    }
  }
  if (missing.length === 0) return peerStatuses;
  throw new ProtocolError(
    400,
    `stage ${stage.id} is missing required evidence: ${missing.join(", ")}`,
    "workflow_evidence_incomplete",
    {
      missingRequirements: missing,
      providedRequirements: Object.keys(evidence),
      peerRequirements: peerStatuses,
    },
  );
}

function parseWorkflowEvidencePolicies(
  value: unknown,
  stageId: string,
  requiredEvidence: string[],
  workflowId: string,
  targetName: string,
  warn: (message: string) => void,
): WorkflowEvidencePolicies | undefined {
  if (value === undefined) return undefined;
  const rawPolicies = object(value, `stage ${stageId} evidencePolicies`);
  const policies = new Map<string, WorkflowEvidencePolicy>();
  for (const [rawRequirement, rawPolicy] of Object.entries(rawPolicies)) {
    const requirementKey = canonicalWorkflowEvidenceKey(
      requireString(rawRequirement, `stage ${stageId} evidencePolicies requirement`, { max: 128 }),
    );
    if (!requiredEvidence.includes(requirementKey)) {
      throw new Error(`stage ${stageId} evidence policy ${requirementKey} must match requiredEvidence`);
    }
    if (policies.has(requirementKey)) {
      throw new Error(`stage ${stageId} evidencePolicies keys must be unique after normalization`);
    }
    const policy = object(rawPolicy, `stage ${stageId} evidencePolicies.${requirementKey}`);
    const supportedPolicyFields = new Set([
      "kind",
      "minProducers",
      "eligibleAgents",
      "acceptedStatuses",
      "degradation",
    ]);
    const unsupportedPolicyFields = Object.keys(policy).filter((field) => !supportedPolicyFields.has(field));
    if (unsupportedPolicyFields.length) {
      throw new Error(
        `stage ${stageId} evidencePolicies.${requirementKey} contains unsupported fields: ${unsupportedPolicyFields.join(", ")}`,
      );
    }
    if (policy.kind !== "peer-reply") {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.kind must be peer-reply`);
    }
    const minProducers = policy.minProducers;
    if (!Number.isInteger(minProducers) || (minProducers as number) < 1 || (minProducers as number) > 8) {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.minProducers must be an integer between 1 and 8`);
    }
    const eligibleAgents = stringArray(
      policy.eligibleAgents,
      `stage ${stageId} evidencePolicies.${requirementKey}.eligibleAgents`,
    );
    if (eligibleAgents.length < 1 || eligibleAgents.length > 16) {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.eligibleAgents must contain between 1 and 16 selectors`);
    }
    const normalizedSelectors = eligibleAgents.map((selector) => selector.toLowerCase());
    if (new Set(normalizedSelectors).size !== normalizedSelectors.length) {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.eligibleAgents must be unique`);
    }
    // The workflow target can never produce peer evidence for its own run:
    // the hub requires evidence messages from the target to a peer that is
    // not the target, so a coordinator in its own quorum is structurally
    // unable to produce. Reject the configuration instead of shipping a
    // stage that can only pass via degradation.
    if (normalizedSelectors.includes(targetName)) {
      throw new Error(
        `workflow ${workflowId} stage ${stageId} evidencePolicies.${requirementKey}.eligibleAgents must not include the workflow target ${targetName}: the target cannot produce peer evidence for its own run`,
      );
    }
    if ((minProducers as number) > normalizedSelectors.length) {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.minProducers exceeds eligibleAgents`);
    }
    if (policy.acceptedStatuses !== undefined) {
      const statuses = stringArray(
        policy.acceptedStatuses,
        `stage ${stageId} evidencePolicies.${requirementKey}.acceptedStatuses`,
      );
      if (statuses.length !== 1 || statuses[0] !== "replied") {
        throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.acceptedStatuses must be ["replied"]`);
      }
    }
    let degradation: PeerReplyDegradationPolicy | undefined;
    if (policy.degradation !== undefined) {
      const rawDegradation = object(
        policy.degradation,
        `stage ${stageId} evidencePolicies.${requirementKey}.degradation`,
      );
      const unsupportedDegradationFields = Object.keys(rawDegradation)
        .filter((field) => field !== "minProducers");
      if (unsupportedDegradationFields.length) {
        throw new Error(
          `stage ${stageId} evidencePolicies.${requirementKey}.degradation contains unsupported fields: ${unsupportedDegradationFields.join(", ")}`,
        );
      }
      const degradedMin = rawDegradation.minProducers;
      if (
        !Number.isInteger(degradedMin)
        || (degradedMin as number) < 1
        || (degradedMin as number) >= (minProducers as number)
      ) {
        throw new Error(
          `stage ${stageId} evidencePolicies.${requirementKey}.degradation.minProducers must be at least 1 and lower than minProducers`,
        );
      }
      degradation = { minProducers: degradedMin as number };
      if (degradation.minProducers < 2) {
        // Warning, not a hard failure: a floor of 1 is legal for
        // non-independent requirements, but operators should see that one
        // producer can satisfy this degraded peer-reply quorum.
        warn(
          `workflow ${workflowId} stage ${stageId} evidence policy ${requirementKey}: degradation.minProducers is ${degradation.minProducers} (< 2); a single producer can satisfy the degraded peer-reply quorum`,
        );
      }
    }
    policies.set(requirementKey, {
      kind: "peer-reply",
      minProducers: minProducers as number,
      eligibleAgents,
      acceptedStatuses: ["replied"],
      ...(degradation ? { degradation } : {}),
    });
  }
  return policies.size ? Object.fromEntries(policies) : undefined;
}

export function parseWorkflowDefinitions(
  raw: string | undefined,
  environment: Record<string, string | undefined> = process.env,
  onWarning?: (warning: string) => void,
): WebhookWorkflowDefinition[] {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("KXM_WEBHOOK_WORKFLOWS must be a JSON array");
  const warn = (message: string): void => { onWarning?.(message); };
  const ids = new Set<string>();
  return parsed.map((entry, definitionIndex) => {
    const value = object(entry, `workflow ${definitionIndex}`);
    const id = requireString(value.id, "workflow.id", { max: 64 });
    if (ids.has(id)) throw new Error(`duplicate workflow id: ${id}`);
    ids.add(id);
    const source = value.source ?? "generic";
    if (source !== "jira" && source !== "github" && source !== "generic") {
      throw new Error(`workflow ${id} source must be jira, github, or generic`);
    }
    const delivery = value.delivery ?? "followUp";
    if (delivery !== "steer" && delivery !== "followUp") {
      throw new Error(`workflow ${id} delivery must be steer or followUp`);
    }
    const secretEnv = value.secretEnv === undefined
      ? undefined
      : requireString(value.secretEnv, "workflow.secretEnv", { max: 128 });
    if (value.secret !== undefined && secretEnv) {
      throw new Error(`workflow ${id} must configure only one of secret or secretEnv`);
    }
    const secret = requireString(secretEnv ? environment[secretEnv] : value.secret, "workflow.secret", { max: 512 });
    if (secret.length < 16) throw new Error(`workflow ${id} secret must contain at least 16 characters`);
    const signalSecretEnv = value.signalSecretEnv === undefined
      ? undefined
      : requireString(value.signalSecretEnv, "workflow.signalSecretEnv", { max: 128 });
    if (value.signalSecret !== undefined && signalSecretEnv) {
      throw new Error(`workflow ${id} must configure only one of signalSecret or signalSecretEnv`);
    }
    const signalSecret = signalSecretEnv
      ? requireString(environment[signalSecretEnv], "workflow.signalSecret", { max: 512 })
      : value.signalSecret === undefined
        ? undefined
        : requireString(value.signalSecret, "workflow.signalSecret", { max: 512 });
    if (signalSecret && signalSecret.length < 16) {
      throw new Error(`workflow ${id} signalSecret must contain at least 16 characters`);
    }
    const target = requireString(value.target, "workflow.target", { max: 80 });
    const targetName = target.toLowerCase();
    if (!Array.isArray(value.stages) || value.stages.length === 0 || value.stages.length > 32) {
      throw new Error(`workflow ${id} must define between 1 and 32 stages`);
    }
    const stageIds = new Set<string>();
    const stages = value.stages.map((stageEntry, stageIndex) => {
      const stage = object(stageEntry, `workflow ${id} stage ${stageIndex}`);
      const stageId = requireString(stage.id, "stage.id", { max: 64 });
      if (stageIds.has(stageId)) throw new Error(`duplicate stage id ${stageId} in workflow ${id}`);
      stageIds.add(stageId);
      const maxAttempts = stage.maxAttempts ?? 3;
      if (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1 || (maxAttempts as number) > 20) {
        throw new Error(`stage ${stageId} maxAttempts must be an integer between 1 and 20`);
      }
      const area = stage.area
        ? requireString(stage.area, "stage.area", { max: 24 }) as ImprovementArea
        : undefined;
      if (area && !IMPROVEMENT_AREAS.includes(area)) {
        throw new Error(`stage ${stageId} area is invalid`);
      }
      const requiredEvidence = stringArray(stage.requiredEvidence ?? [], "stage.requiredEvidence")
        .map((requirement, requirementIndex) => canonicalWorkflowEvidenceKey(
          requireString(requirement, `stage.requiredEvidence[${requirementIndex}]`, { max: 128 }),
        ));
      if (requiredEvidence.length > 32) throw new Error(`stage ${stageId} may require at most 32 evidence keys`);
      if (new Set(requiredEvidence).size !== requiredEvidence.length) {
        throw new Error(`stage ${stageId} requiredEvidence keys must be unique`);
      }
      const evidencePolicies = parseWorkflowEvidencePolicies(
        stage.evidencePolicies,
        stageId,
        requiredEvidence,
        id,
        targetName,
        warn,
      );
      const on = parseOutcomeMap(stageId, stage.on);
      const stageMaxTransitions = stage.maxTransitions;
      if (stageMaxTransitions !== undefined
        && (!Number.isInteger(stageMaxTransitions) || (stageMaxTransitions as number) < 1 || (stageMaxTransitions as number) > 100)) {
        throw new Error(`stage ${stageId} maxTransitions must be an integer between 1 and 100`);
      }
      const autoResumeLimit = stage.autoResumeLimit;
      if (autoResumeLimit !== undefined
        && (!Number.isInteger(autoResumeLimit) || (autoResumeLimit as number) < 1 || (autoResumeLimit as number) > 20)) {
        throw new Error(`stage ${stageId} autoResumeLimit must be an integer between 1 and 20`);
      }
      return {
        id: stageId,
        label: requireString(stage.label ?? stageId, "stage.label", { max: 128 }),
        instructions: requireString(stage.instructions, "stage.instructions", { max: 4_000 }),
        requiredEvidence,
        maxAttempts: maxAttempts as number,
        ...(autoResumeLimit !== undefined ? { autoResumeLimit: autoResumeLimit as number } : {}),
        ...(area ? { area } : {}),
        ...(evidencePolicies ? { evidencePolicies } : {}),
        ...(on ? { on } : {}),
        ...(stageMaxTransitions !== undefined ? { maxTransitions: stageMaxTransitions as number } : {}),
      };
    });
    const definitionMaxTransitions = value.maxTransitions as number | undefined;
    if (definitionMaxTransitions !== undefined) validateWorkflowTransitions({ id, stages: stages as WorkflowStageDefinition[], maxTransitions: definitionMaxTransitions });
    else validateWorkflowTransitions({ id, stages: stages as WorkflowStageDefinition[] });
    const stageIdSet = new Set(stages.map((stage) => stage.id));
    const parseOracleConfig = (raw: unknown, field: string): WorkflowOracleConfig | undefined => {
      if (raw === undefined) return undefined;
      const candidate = object(raw, `workflow ${id} ${field}`);
      const stageId = requireString(candidate.stageId, `workflow ${id} ${field}.stageId`, { max: 64 });
      if (!stageIdSet.has(stageId)) {
        throw new Error(`workflow ${id} ${field}.stageId references unknown stage ${stageId}`);
      }
      const evidenceKey = canonicalWorkflowEvidenceKey(requireString(candidate.evidenceKey, `workflow ${id} ${field}.evidenceKey`, { max: 128 }));
      return { stageId, evidenceKey };
    };
    const reproOracle = parseOracleConfig(value.reproOracle, "reproOracle");
    const planHash = parseOracleConfig(value.planHash, "planHash");
    let requirePlanHash: string[] | undefined;
    if (value.requirePlanHash !== undefined) {
      const required = stringArray(value.requirePlanHash, `workflow ${id} requirePlanHash`);
      for (const stageId of required) {
        if (!stageIdSet.has(stageId)) {
          throw new Error(`workflow ${id} requirePlanHash references unknown stage ${stageId}`);
        }
      }
      requirePlanHash = [...new Set(required)].sort();
    }
    let filter: WebhookWorkflowDefinition["filter"];
    if (value.filter !== undefined) {
      const candidate = object(value.filter, `workflow ${id} filter`);
      filter = {
        path: requireString(candidate.path, "filter.path", { max: 256 }),
        equals: requireString(candidate.equals, "filter.equals", { max: 512 }),
      };
    }
    if (
      value.ttlMs !== undefined
      && (!Number.isInteger(value.ttlMs)
        || (value.ttlMs as number) < MIN_MESSAGE_TTL_MS
        || (value.ttlMs as number) > MAX_MESSAGE_TTL_MS)
    ) {
      throw new Error(`workflow ${id} ttlMs must be an integer between ${MIN_MESSAGE_TTL_MS} and ${MAX_MESSAGE_TTL_MS}`);
    }
    return {
      id,
      source,
      project: requireString(value.project, "workflow.project", { max: 128 }),
      target,
      secret,
      ...(signalSecret ? { signalSecret } : {}),
      ...(value.event ? { event: requireString(value.event, "workflow.event", { max: 128 }) } : {}),
      ...(filter ? { filter } : {}),
      delivery,
      ...(value.ttlMs !== undefined ? { ttlMs: value.ttlMs as number } : {}),
      ...(value.maxTransitions !== undefined ? { maxTransitions: value.maxTransitions as number } : {}),
      ...(reproOracle ? { reproOracle } : {}),
      ...(planHash ? { planHash } : {}),
      ...(requirePlanHash ? { requirePlanHash } : {}),
      promptTemplate: requireString(value.promptTemplate, "workflow.promptTemplate", { max: 20_000 }),
      stages,
    };
  });
}

/** Validate typed transitions at definition load: targets must exist,
 * forward transitions may never skip an intermediate stage (approvals and
 * gates cannot be bypassed), and back-edges require global and bounded
 * budgets. */
export function validateWorkflowTransitions(definition: Pick<WebhookWorkflowDefinition, "id" | "stages"> & { maxTransitions?: number }): void {
  const stageIndex = new Map(definition.stages.map((stage, index) => [stage.id, index]));
  let hasBackEdge = false;
  for (const stage of definition.stages) {
    if (!stage.on) continue;
    for (const [outcome, rawValue] of Object.entries(stage.on)) {
      if (!outcome.trim()) throw new Error(`stage ${stage.id} declares an empty outcome key`);
      const rule = normalizeOutcomeValue(rawValue, `stage ${stage.id} on.${outcome}`);
      if (rule.target === WORKFLOW_TERMINAL_TARGET) continue;
      const targetIndex = stageIndex.get(rule.target);
      if (targetIndex === undefined) {
        throw new Error(`stage ${stage.id} on.${outcome} targets unknown stage ${rule.target}`);
      }
      const sourceIndex = stageIndex.get(stage.id)!;
      if (targetIndex > sourceIndex + 1) {
        throw new Error(
          `stage ${stage.id} on.${outcome} skips intermediate stages by targeting ${rule.target}; forward transitions must target the next stage so approvals and gates cannot be bypassed`,
        );
      }
      if (targetIndex <= sourceIndex) hasBackEdge = true;
    }
  }
  if (definition.maxTransitions !== undefined
    && (!Number.isInteger(definition.maxTransitions) || (definition.maxTransitions as number) < 1 || (definition.maxTransitions as number) > 200)) {
    throw new Error(`workflow ${definition.id} maxTransitions must be an integer between 1 and 200`);
  }
  if (hasBackEdge && (definition.maxTransitions === undefined || definition.maxTransitions < 1)) {
    throw new Error(`workflow ${definition.id} declares a back-edge but no maxTransitions budget; cycles without budgets are rejected`);
  }
}

function parseOutcomeMap(stageId: string, raw: unknown): WorkflowOutcomeMap | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`stage ${stageId} on must be an object`);
  }
  const map: WorkflowOutcomeMap = {};
  for (const [outcome, value] of Object.entries(raw as Record<string, unknown>)) {
    map[outcome] = normalizeOutcomeValue(value as WorkflowOutcomeValue, `stage ${stageId} on.${outcome}`);
  }
  return map;
}

export function valueAtPath(payload: unknown, path: string): unknown {
  let current = payload;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function renderWorkflowPrompt(template: string, payload: unknown): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, path: string) => {
    const value = valueAtPath(payload, path);
    if (value === undefined || value === null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, candidate]) => candidate !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, candidate]) => [key, canonicalizeForHash(candidate)]),
    );
  }
  return value;
}

/** Stable, secret-free JSON serialization of a workflow definition. Object
 * keys are sorted recursively and undefined fields are dropped, so hash
 * equality is semantic and credential rotation does not create false drift. */
export function canonicalWorkflowDefinitionJson(definition: WebhookWorkflowDefinition): string {
  const { secret: _secret, signalSecret: _signalSecret, ...publicDefinition } = definition;
  return JSON.stringify(canonicalizeForHash(publicDefinition));
}

/** sha256 of the canonical workflow definition JSON. Stamped on runs at
 * creation so a later resume or audit can detect that the definition changed
 * underneath the run. */
export function workflowDefinitionHash(definition: WebhookWorkflowDefinition): string {
  return createHash("sha256").update(canonicalWorkflowDefinitionJson(definition), "utf8").digest("hex");
}

/** Resolve a declared transition rule for a stage outcome, or undefined when
 * the outcome keeps the v0.4 default edges. */
function resolveOutcomeRule(stage: WorkflowStageState, outcomeKey: string): WorkflowTransitionRule | undefined {
  const raw = stage.on?.[outcomeKey];
  return raw === undefined ? undefined : normalizeOutcomeValue(raw, `stage ${stage.id} on.${outcomeKey}`);
}

/** Transition budgets are derived from the durable journal: global count is
 * the record count, per-stage counts filter by source stage, per-edge counts
 * filter by source+outcome+target. Restart-safe with no extra state. */
function transitionCounts(
  run: WorkflowRun,
  fromStage: string,
  outcome: string,
  target: string,
): { total: number; fromStage: number; forEdge: number } {
  const records = run.transitions ?? [];
  return {
    total: records.length,
    fromStage: records.filter((record) => record.fromStage === fromStage).length,
    forEdge: records.filter((record) => record.fromStage === fromStage && record.outcome === outcome && record.toStage === target).length,
  };
}

function recordTransition(
  run: WorkflowRun,
  fromStage: string,
  rule: WorkflowTransitionRule,
  outcome: string,
  attempt: number,
  evidenceKeys: string[],
  timestamp: string,
): WorkflowTransitionRecord {
  const record: WorkflowTransitionRecord = {
    id: newId("trans"),
    fromStage,
    toStage: rule.target,
    outcome,
    attempt,
    evidenceKeys,
    at: timestamp,
  };
  run.transitions = [...(run.transitions ?? []), record];
  return record;
}

/** Enter (or re-enter) a stage with attempt-bound state: previous evidence
 * never satisfies a later attempt unless policy explicitly allows it. */
function enterStage(run: WorkflowRun, stage: WorkflowStageState, timestamp: string): void {
  stage.status = "in_progress";
  stage.attempts = 0;
  stage.evidence = {};
  stage.verifiedEvidence = {};
  stage.startedAt = timestamp;
  stage.updatedAt = timestamp;
  delete stage.summary;
  run.currentStage = stage.id;
  run.updatedAt = timestamp;
}

/** Execute a declared transition with global/per-stage/per-edge budgets.
 * Budget exhaustion fails safely: the run fails with actionable retrospective
 * evidence rather than looping unbounded. */
function takeDeclaredTransition(
  run: WorkflowRun,
  stage: WorkflowStageState,
  rule: WorkflowTransitionRule,
  outcome: string,
  summary: string,
  attempt: number,
  timestamp: string,
  evidenceKeys: string[],
): { retry: boolean; completed: boolean; run: WorkflowRun; transition?: WorkflowTransitionRecord; exhausted?: boolean } {
  const definitionBudget = run.maxTransitions;
  const counts = transitionCounts(run, stage.id, outcome, rule.target);
  const edgeExhausted = rule.maxTransitions !== undefined && counts.forEdge >= rule.maxTransitions;
  const stageExhausted = stage.maxTransitions !== undefined && counts.fromStage >= stage.maxTransitions;
  const globalExhausted = definitionBudget !== undefined && counts.total >= definitionBudget;
  if (edgeExhausted || stageExhausted || globalExhausted) {
    stage.completedAt = timestamp;
    run.status = "failed";
    delete run.currentStage;
    run.updatedAt = timestamp;
    return {
      retry: false,
      completed: false,
      run,
      exhausted: true,
    };
  }
  const record = recordTransition(run, stage.id, rule, outcome, attempt, evidenceKeys.slice(0, 32), timestamp);
  if (rule.target === WORKFLOW_TERMINAL_TARGET) {
    stage.completedAt = timestamp;
    run.status = "completed";
    delete run.currentStage;
    run.completedAt = timestamp;
    run.updatedAt = timestamp;
    return { retry: false, completed: true, run, transition: record };
  }
  const target = run.stages.find((candidate) => candidate.id === rule.target);
  if (!target) {
    // Definition validation prevents this; fail closed anyway.
    run.status = "failed";
    delete run.currentStage;
    return { retry: false, completed: false, run, exhausted: true };
  }
  stage.summary = summary;
  enterStage(run, target, timestamp);
  return { retry: false, completed: false, run, transition: record };
}


/** sha256 over the canonical values of one evidence key. */
export function evidenceValueSha256(evidence: WorkflowEvidence | WorkflowEvidenceInput, key: string): string | undefined {
  const values = evidence[canonicalWorkflowEvidenceKey(key)];
  if (!values || values.length === 0) return undefined;
  return createHash("sha256").update([...values].sort().join("\n"), "utf8").digest("hex");
}

/** Enforce the immutable reproduction oracle and plan-hash prerequisites.
 * Called before a checkpoint mutates the run. */
function enforceOracles(
  run: WorkflowRun,
  stageId: string,
  evidence: WorkflowEvidence,
): void {
  if (run.oracle) {
    const presented = evidenceValueSha256(evidence, run.oracle.evidenceKey);
    if (presented !== undefined && presented !== run.oracle.sha256) {
      throw new ProtocolError(
        400,
        `evidence ${run.oracle.evidenceKey} does not match the immutable reproduction oracle captured at ${run.oracle.capturedAt}; the confirmed reproduction may not be weakened`,
        "weakened_reproduction",
      );
    }
  }
  if (run.requirePlanHash?.includes(stageId) && !run.planHash) {
    throw new ProtocolError(
      400,
      `stage ${stageId} requires an approved plan hash before it can checkpoint`,
      "plan_hash_required",
    );
  }
}

/** Capture oracle/plan-hash snapshots when their defining stage passes. */
function captureOracles(run: WorkflowRun, stageId: string, evidence: WorkflowEvidence, timestamp: string): void {
  if (run.reproOracle?.stageId === stageId) {
    const sha256 = evidenceValueSha256(evidence, run.reproOracle.evidenceKey);
    if (sha256 !== undefined) {
      run.oracle = { evidenceKey: run.reproOracle.evidenceKey, sha256, capturedAt: timestamp };
    }
  }
  if (run.planHashConfig?.stageId === stageId) {
    const sha256 = evidenceValueSha256(evidence, run.planHashConfig.evidenceKey);
    if (sha256 !== undefined) {
      run.planHash = { evidenceKey: run.planHashConfig.evidenceKey, sha256, capturedAt: timestamp };
    }
  }
}

export function checkpointRun(
  run: WorkflowRun,
  stageId: string,
  status: WorkflowCheckpointStatus,
  summary: string,
  evidence: WorkflowEvidenceInput,
  timestamp: string,
  verifiedEvidence: WorkflowVerifiedEvidence = {},
  outcome?: string,
): { retry: boolean; completed: boolean; run: WorkflowRun; degraded?: boolean; transition?: WorkflowTransitionRecord; exhausted?: boolean } {
  if (run.status !== "running") throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_terminal");
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new ProtocolError(404, `workflow stage not found: ${stageId}`, "workflow_stage_not_found");
  if (stage.id !== run.currentStage || stage.status !== "in_progress") {
    throw new ProtocolError(409, `stage ${stageId} is not currently active`, "workflow_stage_out_of_order");
  }
  const accumulatedEvidence = mergeWorkflowEvidence(stage.evidence, evidence);
  const accumulatedVerifiedEvidence = mergeVerifiedWorkflowEvidence(stage.verifiedEvidence, verifiedEvidence);
  enforceOracles(run, stageId, accumulatedEvidence);
  const peerStatuses = status === "passed"
    ? requireCompleteEvidence(stage, accumulatedEvidence, accumulatedVerifiedEvidence, run.id)
    : [];
  const degradedRequirements = peerStatuses.filter((peerStatus) => peerStatus.degraded);
  stage.attempts += 1;
  stage.summary = summary;
  // Failed or warning evidence remains available in the journal, but it is
  // intentionally not trusted to satisfy a later passing attempt.
  if (status === "passed") {
    stage.evidence = accumulatedEvidence;
    if (Object.keys(accumulatedVerifiedEvidence).length) stage.verifiedEvidence = accumulatedVerifiedEvidence;
    captureOracles(run, stageId, accumulatedEvidence, timestamp);
    if (degradedRequirements.length) {
      stage.degraded = true;
      stage.degradedRequirements = degradedRequirements.map((peerStatus) => peerStatus.requirementKey);
    }
  }
  stage.updatedAt = timestamp;
  run.updatedAt = timestamp;
  if (status !== "passed") {
    stage.status = status;
    if (stage.attempts >= stage.maxAttempts) {
      stage.completedAt = timestamp;
      run.status = "failed";
      delete run.currentStage;
      return { retry: false, completed: false, run };
    }
    if (stage.autoResumeLimit !== undefined && stage.attempts >= stage.autoResumeLimit) {
      stage.status = "in_progress";
      const reason = summary || `autoResumeLimit of ${stage.autoResumeLimit} reached on stage ${stage.id}`;
      const receipt = validateTerminalReceipt({
        schema: TERMINAL_RECEIPT_SCHEMA,
        status: "audit_escalation",
        seat: stage.id,
        runId: run.id,
        stageId: stage.id,
        timestamp,
        host: "pi",
        model: "default",
        escalationReason: reason,
      });
      const expiresAt = new Date(Date.parse(timestamp) + 24 * 60 * 60 * 1000).toISOString();
      waitForWorkflowSignal(run, stage.id, "audit_escalation", reason, timestamp, expiresAt);
      stage.receipt = receipt;
      stage.auditEscalation = {
        reason,
        timestamp,
        receipt,
      };
      return { retry: false, completed: false, run };
    }
    stage.status = status;
    // Declared failure outcomes create typed transitions (bounded); the
    // outcome identity defaults to the checkpoint status.
    const outcomeKey = outcome ?? status;
    const rule = resolveOutcomeRule(stage, outcomeKey);
    if (rule && stage.attempts < stage.maxAttempts) {
      const result = takeDeclaredTransition(run, stage, rule, outcomeKey, summary, stage.attempts, timestamp, Object.keys(accumulatedEvidence));
      // Re-arm the source stage for future re-entry (the durable journal
      // already captured the failed attempt). Self-edges stay in_progress.
      if (result.transition !== undefined && !result.completed && rule.target !== stage.id) {
        stage.status = "pending";
      }
      return result;
    }
    stage.status = "in_progress";
    return { retry: true, completed: false, run };
  }
  stage.status = "passed";
  stage.completedAt = timestamp;
  const passedRule = resolveOutcomeRule(stage, outcome ?? "passed");
  if (passedRule) {
    return takeDeclaredTransition(run, stage, passedRule, outcome ?? "passed", summary, stage.attempts, timestamp, Object.keys(accumulatedEvidence));
  }
  const next = run.stages.find((candidate) => candidate.status === "pending");
  if (next) {
    next.status = "in_progress";
    next.startedAt = timestamp;
    next.updatedAt = timestamp;
    run.currentStage = next.id;
    return {
      retry: false,
      completed: false,
      run,
      ...(degradedRequirements.length ? { degraded: true } : {}),
    };
  }
  run.status = "completed";
  delete run.currentStage;
  run.completedAt = timestamp;
  return {
    retry: false,
    completed: true,
    run,
    ...(degradedRequirements.length ? { degraded: true } : {}),
  };
}

export function waitForWorkflowSignal(
  run: WorkflowRun,
  stageId: string,
  signalKey: string,
  summary: string,
  timestamp: string,
  expiresAt: string,
  evidence: WorkflowEvidenceInput = {},
  verifiedEvidence: WorkflowVerifiedEvidence = {},
): WorkflowRun {
  if (run.status !== "running") throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_not_running");
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new ProtocolError(404, `workflow stage not found: ${stageId}`, "workflow_stage_not_found");
  if (stage.id !== run.currentStage || stage.status !== "in_progress") {
    throw new ProtocolError(409, `stage ${stageId} is not currently active`, "workflow_stage_out_of_order");
  }
  if (Date.parse(expiresAt) <= Date.parse(timestamp)) {
    throw new ProtocolError(400, "workflow signal expiry must be in the future", "workflow_wait_invalid");
  }
  stage.evidence = mergeWorkflowEvidence(stage.evidence, evidence);
  const accumulatedVerifiedEvidence = mergeVerifiedWorkflowEvidence(stage.verifiedEvidence, verifiedEvidence);
  if (Object.keys(accumulatedVerifiedEvidence).length) stage.verifiedEvidence = accumulatedVerifiedEvidence;
  stage.status = "waiting";
  stage.updatedAt = timestamp;
  run.status = "waiting";
  run.waiting = { stageId, signalKey, summary, createdAt: timestamp, expiresAt };
  run.updatedAt = timestamp;
  return run;
}

export function resumeWorkflowFromSignal(
  run: WorkflowRun,
  signalKey: string,
  status: WorkflowCheckpointStatus,
  summary: string,
  evidence: WorkflowEvidenceInput,
  timestamp: string,
): { retry: boolean; completed: boolean; run: WorkflowRun; stageId: string; degraded?: boolean } {
  if (run.status !== "waiting" || !run.waiting) {
    throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_not_waiting");
  }
  if (run.waiting.signalKey !== signalKey) {
    throw new ProtocolError(409, `workflow is waiting for ${run.waiting.signalKey}`, "workflow_signal_mismatch");
  }
  const stageId = run.waiting.stageId;
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage || stage.id !== run.currentStage || stage.status !== "waiting") {
    throw new ProtocolError(409, "workflow wait state is inconsistent", "workflow_wait_inconsistent");
  }
  const accumulatedEvidence = mergeWorkflowEvidence(stage.evidence, evidence);
  if (status === "passed") {
    requireCompleteEvidence(
      stage,
      accumulatedEvidence,
      normalizeVerifiedWorkflowEvidence(stage.verifiedEvidence),
      run.id,
    );
  }
  run.status = "running";
  stage.status = "in_progress";
  delete run.waiting;
  const result = checkpointRun(run, stageId, status, summary, evidence, timestamp);
  return { ...result, stageId };
}

export function approveWorkflowDegradation(
  run: WorkflowRun,
  stageId: string,
  requirement: string,
  reason: string,
  approvalId: string,
  timestamp: string,
): { run: WorkflowRun; approval: WorkflowDegradationApproval; created: boolean } {
  if (run.status !== "running" && run.status !== "waiting") {
    throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_terminal");
  }
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new ProtocolError(404, `workflow stage not found: ${stageId}`, "workflow_stage_not_found");
  if (
    stage.id !== run.currentStage
    || (stage.status !== "in_progress" && stage.status !== "waiting")
  ) {
    throw new ProtocolError(409, `stage ${stageId} is not currently active`, "workflow_stage_out_of_order");
  }
  const requirementKey = canonicalWorkflowEvidenceKey(requirement);
  const policy = stage.resolvedEvidencePolicies?.[requirementKey];
  if (!policy?.degradation) {
    throw new ProtocolError(
      400,
      `requirement ${requirementKey} does not permit degraded quorum`,
      "workflow_degradation_forbidden",
    );
  }
  const attempt = activeWorkflowAttempt(stage);
  const existing = stage.degradationApprovals?.find(
    (candidate) => candidate.requirementKey === requirementKey && candidate.attempt === attempt,
  );
  if (existing) {
    if (existing.reason !== reason.trim()) {
      throw new ProtocolError(
        409,
        `degradation was already approved for ${requirementKey} attempt ${attempt}`,
        "workflow_degradation_conflict",
      );
    }
    return { run, approval: existing, created: false };
  }
  const approval: WorkflowDegradationApproval = {
    schema: "pi-mesh.workflow-degradation-approval.v1",
    id: approvalId,
    requirementKey,
    attempt,
    policyMinProducers: policy.minProducers,
    approvedMinProducers: policy.degradation.minProducers,
    approvedBy: "kxm-admin",
    reason: requireString(reason, "reason", { max: 1_000 }),
    approvedAt: timestamp,
  };
  (stage.degradationApprovals ??= []).push(approval);
  stage.updatedAt = timestamp;
  run.updatedAt = timestamp;
  return { run, approval, created: true };
}

export function escalateWorkflowStage(
  run: WorkflowRun,
  stageId: string,
  reason: string,
  timestamp: string,
  options: {
    seat?: string;
    host?: string;
    model?: string;
    evidence?: TerminalReceiptEvidence;
    metrics?: TerminalReceiptMetrics;
  } = {},
): { run: WorkflowRun; receipt: TerminalReceipt } {
  if (run.status !== "running") throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_terminal");
  const stage = run.stages.find((s) => s.id === stageId);
  if (!stage) throw new ProtocolError(404, `workflow stage not found: ${stageId}`, "workflow_stage_not_found");
  if (stage.id !== run.currentStage || stage.status !== "in_progress") {
    throw new ProtocolError(409, `stage ${stageId} is not currently active`, "workflow_stage_out_of_order");
  }

  const receipt: TerminalReceipt = validateTerminalReceipt({
    schema: TERMINAL_RECEIPT_SCHEMA,
    status: "audit_escalation",
    seat: options.seat ?? stage.id,
    runId: run.id,
    stageId,
    timestamp,
    host: options.host ?? "pi",
    model: options.model ?? "default",
    escalationReason: reason,
    ...(options.evidence ? { evidence: options.evidence } : {}),
    ...(options.metrics ? { metrics: options.metrics } : {}),
  });

  const expiresAt = new Date(Date.parse(timestamp) + 24 * 60 * 60 * 1000).toISOString();
  waitForWorkflowSignal(run, stageId, "audit_escalation", reason, timestamp, expiresAt);

  stage.receipt = receipt;
  stage.auditEscalation = {
    reason,
    timestamp,
    receipt,
  };

  return { run, receipt };
}

export function resumeWorkflowFromRuling(
  run: WorkflowRun,
  ruling: string,
  timestamp: string,
  options: {
    status?: WorkflowCheckpointStatus;
    evidence?: WorkflowEvidenceInput;
  } = {},
): { retry: boolean; completed: boolean; run: WorkflowRun; stageId: string } {
  if (run.status !== "waiting" || !run.waiting) {
    throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_not_waiting");
  }
  if (run.waiting.signalKey !== "audit_escalation") {
    throw new ProtocolError(
      409,
      `workflow is waiting for signal '${run.waiting.signalKey}', not 'audit_escalation'`,
      "workflow_signal_mismatch",
    );
  }

  const stageId = run.waiting.stageId;
  const stage = run.stages.find((s) => s.id === stageId);
  if (!stage) throw new ProtocolError(404, `workflow stage not found: ${stageId}`, "workflow_stage_not_found");

  const status = options.status ?? "passed";
  const evidence = options.evidence ?? {};

  if (stage.auditEscalation) {
    stage.auditEscalation.ruling = ruling;
    if (stage.auditEscalation.receipt) {
      stage.auditEscalation.receipt.ruling = ruling;
    }
  }
  stage.summary = `Resumed by operator ruling: ${ruling}`;

  return resumeWorkflowFromSignal(
    run,
    "audit_escalation",
    status,
    `Resumed: ${ruling}`,
    evidence,
    timestamp,
  );
}


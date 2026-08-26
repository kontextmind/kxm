import { createHash } from "node:crypto";
import {
  MAX_MESSAGE_TTL_MS,
  MIN_MESSAGE_TTL_MS,
  ProtocolError,
  requireString,
  type MessageRecord,
  type WorkflowMessageContext,
} from "./protocol.ts";

export type WorkflowCheckpointStatus = "passed" | "warning" | "failed";
export type WorkflowRunStatus = "running" | "waiting" | "completed" | "failed";
export type WorkflowStageStatus = "pending" | "in_progress" | "waiting" | WorkflowCheckpointStatus;
export type JournalCategory = "plan" | "decision" | "contradiction" | "error" | "lesson";
export type ImprovementArea = "harness" | "gates" | "implementation" | "workflow" | "documentation" | "security" | "other";

/** Evidence submitted for one checkpoint or external signal, keyed by a
 * requirement from WorkflowStageDefinition.requiredEvidence. */
export type WorkflowEvidenceInput = Record<string, string>;

/** Durable evidence accumulated across local work, retries, and an external
 * signal. A legacy string array can still be read from pre-0.4 databases, but
 * it never satisfies a keyed requirement. */
export type WorkflowEvidence = Record<string, string[]>;

/** Callers cite durable message IDs only. Producer identity and the evidence
 * snapshot are derived by the hub from the stored message. */
export interface WorkflowEvidenceReference {
  messageIds: string[];
}

export type WorkflowEvidenceReferenceInput = Record<string, WorkflowEvidenceReference>;

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
  approvedBy: "mesh-admin";
  reason: string;
  approvedAt: string;
}

export interface WorkflowStageDefinition {
  id: string;
  label: string;
  instructions: string;
  requiredEvidence: string[];
  maxAttempts: number;
  area?: ImprovementArea;
  evidencePolicies?: WorkflowEvidencePolicies;
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
  const areas: ImprovementArea[] = [
    "harness",
    "gates",
    "implementation",
    "workflow",
    "documentation",
    "security",
    "other",
  ];
  const severityWeight = { error: 3, warning: 2, info: 1 } as const;
  return areas.map((area) => {
    const matching = entries.filter((entry) => entry.area === area);
    const priorities = [...matching]
      .filter((entry) => entry.category === "error" || entry.category === "contradiction" || entry.category === "lesson")
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
    if ((minProducers as number) > eligibleAgents.length) {
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
): WebhookWorkflowDefinition[] {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("PI_MESH_WEBHOOK_WORKFLOWS must be a JSON array");
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
      if (area && !["harness", "gates", "implementation", "workflow", "documentation", "security", "other"].includes(area)) {
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
      const evidencePolicies = parseWorkflowEvidencePolicies(stage.evidencePolicies, stageId, requiredEvidence);
      return {
        id: stageId,
        label: requireString(stage.label ?? stageId, "stage.label", { max: 128 }),
        instructions: requireString(stage.instructions, "stage.instructions", { max: 4_000 }),
        requiredEvidence,
        maxAttempts: maxAttempts as number,
        ...(area ? { area } : {}),
        ...(evidencePolicies ? { evidencePolicies } : {}),
      };
    });
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
      target: requireString(value.target, "workflow.target", { max: 80 }),
      secret,
      ...(signalSecret ? { signalSecret } : {}),
      ...(value.event ? { event: requireString(value.event, "workflow.event", { max: 128 }) } : {}),
      ...(filter ? { filter } : {}),
      delivery,
      ...(value.ttlMs !== undefined ? { ttlMs: value.ttlMs as number } : {}),
      promptTemplate: requireString(value.promptTemplate, "workflow.promptTemplate", { max: 20_000 }),
      stages,
    };
  });
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

export function checkpointRun(
  run: WorkflowRun,
  stageId: string,
  status: WorkflowCheckpointStatus,
  summary: string,
  evidence: WorkflowEvidenceInput,
  timestamp: string,
  verifiedEvidence: WorkflowVerifiedEvidence = {},
): { retry: boolean; completed: boolean; run: WorkflowRun; degraded?: boolean } {
  if (run.status !== "running") throw new ProtocolError(409, `workflow is ${run.status}`, "workflow_terminal");
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new ProtocolError(404, `workflow stage not found: ${stageId}`, "workflow_stage_not_found");
  if (stage.id !== run.currentStage || stage.status !== "in_progress") {
    throw new ProtocolError(409, `stage ${stageId} is not currently active`, "workflow_stage_out_of_order");
  }
  const accumulatedEvidence = mergeWorkflowEvidence(stage.evidence, evidence);
  const accumulatedVerifiedEvidence = mergeVerifiedWorkflowEvidence(stage.verifiedEvidence, verifiedEvidence);
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
    stage.status = "in_progress";
    return { retry: true, completed: false, run };
  }
  stage.status = "passed";
  stage.completedAt = timestamp;
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
    approvedBy: "mesh-admin",
    reason: requireString(reason, "reason", { max: 1_000 }),
    approvedAt: timestamp,
  };
  (stage.degradationApprovals ??= []).push(approval);
  stage.updatedAt = timestamp;
  run.updatedAt = timestamp;
  return { run, approval, created: true };
}

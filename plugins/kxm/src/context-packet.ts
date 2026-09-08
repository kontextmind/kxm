/**
 * KXM Formal Context Packet (v2) & Structured Handoff Manifest (v1)
 * Governs per-step role-bounded context assembly and inter-role transitions.
 */

import { randomUUID } from "node:crypto";
import type { ContextItem } from "./context.ts";

export const CONTEXT_PACKET_SCHEMA = "kxm.context-packet.v2" as const;
export const HANDOFF_MANIFEST_SCHEMA = "kxm.handoff-manifest.v1" as const;

export interface ContextPacketTask {
  taskId: string;
  stepId: string;
  stepAttempt: number;
  objective: string;
  allowedOutcomes: string[];
  permissionCeiling: "read-only" | "edit" | "admin";
}

export interface ContextPacketAcceptanceCriterion {
  id: string;
  description: string;
  verificationKind: "gate" | "witness" | "critic" | "human";
  targetRef?: string | undefined;
  required: boolean;
}

export interface ContextPacketPlan {
  planHash: string;
  activeStepIndex: number;
  totalSteps: number;
  settledDecisions: string[];
}

export interface ContextPacketArtifact {
  name: string;
  kind: "patch" | "report" | "log" | "plan" | "repro_script" | "doc";
  artifactRef: string;
  contentSnippet?: string | undefined;
}

export interface ContextPacketPredecessor {
  stepId: string;
  role: string;
  status: "passed" | "warning" | "failed" | "settled";
  summary: string;
  settledAt: string;
  artifacts: ContextPacketArtifact[];
  decisions: string[];
}

export interface ContextPacketEnvironment {
  sharedDefaults: Array<{ id: string; summary: string }>;
  projectKnowledge: ContextItem[];
  currentState: ContextItem[];
  contradictions: ContextItem[];
  activeSkills: ContextItem[];
}

export interface ContextPacketBudget {
  allocatedTokens: number;
  estimatedTokens: number;
  unresolvedGaps: string[];
  provenanceSummary: Record<string, number>;
}

export interface FormalContextPacketV2 {
  schema: typeof CONTEXT_PACKET_SCHEMA;
  packetId: string;
  project: string;
  generatedAt: string;
  targetRole: string;
  task: ContextPacketTask;
  acceptanceCriteria: ContextPacketAcceptanceCriterion[];
  plan: ContextPacketPlan;
  predecessors: ContextPacketPredecessor[];
  environment: ContextPacketEnvironment;
  budget: ContextPacketBudget;
}

export interface CriticVerdict {
  critic: string;
  verdict: "PASS" | "FAIL" | "WARN" | "UNKNOWN";
  summary?: string | undefined;
}

export interface HandoffDeliverables {
  patches: string[];
  reports: string[];
  artifacts: Array<{ name: string; artifactRef: string }>;
}

export interface HandoffVerificationEvidence {
  witnessExitCode: number;
  witnessPassed: boolean;
  criticVerdicts: CriticVerdict[];
}

export interface HandoffManifestV1 {
  schema: typeof HANDOFF_MANIFEST_SCHEMA;
  handoffId: string;
  taskId: string;
  workflowRunId: string;
  reworkOf?: string | null | undefined;
  source: {
    role: string;
    agentId: string;
    harness: string;
    model?: string | undefined;
    stepId: string;
    attemptId: string;
  };
  target: {
    role: string;
    permission: "read-only" | "edit" | "admin";
  };
  intent: "request_review" | "dispatch_fix" | "request_approval" | "complete_workflow";
  status: "pending" | "accepted" | "rejected" | "superseded";
  baseCommit: string;
  candidateTreeHash?: string | undefined;
  deliverables: HandoffDeliverables;
  verificationEvidence: HandoffVerificationEvidence;
  openQuestions?: string[] | undefined;
  suggestedNextStep?: {
    stepId?: string | undefined;
    action?: string | undefined;
  } | undefined;
  createdAt: string;
}

/**
 * Builds a formal context packet for a step execution.
 */
export function buildFormalContextPacket(input: {
  project: string;
  targetRole: string;
  task: ContextPacketTask;
  acceptanceCriteria?: ContextPacketAcceptanceCriterion[] | undefined;
  plan: ContextPacketPlan;
  predecessors?: ContextPacketPredecessor[] | undefined;
  environment?: Partial<ContextPacketEnvironment> | undefined;
  tokenBudget?: number | undefined;
  arbitratedItems?: ContextItem[] | undefined;
}): FormalContextPacketV2 {
  const packetId = `ctxpkt_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const now = new Date().toISOString();

  const items = input.arbitratedItems ?? [];
  const sharedDefaults: Array<{ id: string; summary: string }> = [];
  const projectKnowledge: ContextItem[] = [];
  const currentState: ContextItem[] = [];
  const contradictions: ContextItem[] = [];
  const activeSkills: ContextItem[] = [];
  const provenanceSummary: Record<string, number> = {};

  for (const item of items) {
    provenanceSummary[item.kind] = (provenanceSummary[item.kind] ?? 0) + 1;
    if (item.project === "_shared") {
      sharedDefaults.push({ id: item.id, summary: item.summary });
    } else if (item.kind === "knowledge") {
      projectKnowledge.push(item);
    } else if (item.kind === "state" || item.kind === "episode") {
      currentState.push(item);
    } else if (item.kind === "skill") {
      activeSkills.push(item);
    } else {
      projectKnowledge.push(item);
    }
  }

  // Merge explicitly provided environment items
  if (input.environment) {
    if (input.environment.sharedDefaults) sharedDefaults.push(...input.environment.sharedDefaults);
    if (input.environment.projectKnowledge) projectKnowledge.push(...input.environment.projectKnowledge);
    if (input.environment.currentState) currentState.push(...input.environment.currentState);
    if (input.environment.contradictions) contradictions.push(...input.environment.contradictions);
    if (input.environment.activeSkills) activeSkills.push(...input.environment.activeSkills);
  }

  const allocatedTokens = input.tokenBudget ?? 16000;
  // Estimate tokens (roughly 4 chars per token)
  const estimatedTokens = Math.ceil(
    (JSON.stringify(input.task).length +
      JSON.stringify(input.plan).length +
      JSON.stringify(input.predecessors ?? []).length +
      JSON.stringify(items).length) /
      4,
  );

  return {
    schema: CONTEXT_PACKET_SCHEMA,
    packetId,
    project: input.project,
    generatedAt: now,
    targetRole: input.targetRole,
    task: input.task,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    plan: input.plan,
    predecessors: input.predecessors ?? [],
    environment: {
      sharedDefaults,
      projectKnowledge,
      currentState,
      contradictions,
      activeSkills,
    },
    budget: {
      allocatedTokens,
      estimatedTokens,
      unresolvedGaps: [],
      provenanceSummary,
    },
  };
}

/**
 * Formats a formal context packet into clean, bounded Markdown for injection into agent prompts.
 */
export function formatContextPacketForPrompt(packet: FormalContextPacketV2): string {
  const sections: string[] = [];

  sections.push(`# Context Packet [${packet.packetId}]`);
  sections.push(`**Project:** ${packet.project} | **Role:** ${packet.targetRole} | **Step:** ${packet.task.stepId} (Attempt ${packet.task.stepAttempt})`);
  sections.push(`**Permission:** ${packet.task.permissionCeiling} | **Allowed Outcomes:** ${packet.task.allowedOutcomes.join(", ")}`);
  sections.push("");

  sections.push(`## 1. Objective`);
  sections.push(packet.task.objective);
  sections.push("");

  if (packet.acceptanceCriteria.length > 0) {
    sections.push(`## 2. Acceptance Criteria`);
    for (const c of packet.acceptanceCriteria) {
      sections.push(`- [ ] **${c.id}** (${c.verificationKind}${c.required ? ", required" : ""}): ${c.description}${c.targetRef ? ` [${c.targetRef}]` : ""}`);
    }
    sections.push("");
  }

  sections.push(`## 3. Plan Pointer`);
  sections.push(`Plan Hash: \`${packet.plan.planHash}\` | Step ${packet.plan.activeStepIndex + 1} of ${packet.plan.totalSteps}`);
  if (packet.plan.settledDecisions.length > 0) {
    sections.push(`Settled Decisions:`);
    for (const d of packet.plan.settledDecisions) {
      sections.push(`  - ${d}`);
    }
  }
  sections.push("");

  if (packet.predecessors.length > 0) {
    sections.push(`## 4. Predecessor Outputs`);
    for (const p of packet.predecessors) {
      sections.push(`### Predecessor: ${p.stepId} (${p.role}) - ${p.status}`);
      sections.push(p.summary);
      if (p.artifacts.length > 0) {
        sections.push(`Artifacts:`);
        for (const a of p.artifacts) {
          sections.push(`  - \`${a.name}\` [${a.kind}] (${a.artifactRef})`);
          if (a.contentSnippet) {
            sections.push(`    \`\`\`\n    ${a.contentSnippet.trim()}\n    \`\`\``);
          }
        }
      }
    }
    sections.push("");
  }

  if (packet.environment.projectKnowledge.length > 0 || packet.environment.sharedDefaults.length > 0) {
    sections.push(`## 5. Environment & Memory`);
    if (packet.environment.sharedDefaults.length > 0) {
      sections.push(`### Shared Defaults`);
      for (const d of packet.environment.sharedDefaults) {
        sections.push(`- ${d.summary}`);
      }
    }
    if (packet.environment.projectKnowledge.length > 0) {
      sections.push(`### Project Knowledge`);
      for (const k of packet.environment.projectKnowledge.slice(0, 5)) {
        sections.push(`- [${k.authority}] ${k.summary}`);
      }
    }
    if (packet.environment.contradictions.length > 0) {
      sections.push(`### Active Contradictions`);
      for (const c of packet.environment.contradictions) {
        sections.push(`- ⚠️ ${c.summary}`);
      }
    }
    sections.push("");
  }

  return sections.join("\n").trim();
}

/**
 * Builds a structured handoff manifest between workflow roles.
 */
export function buildHandoffManifest(input: {
  taskId: string;
  workflowRunId: string;
  reworkOf?: string | null | undefined;
  source: HandoffManifestV1["source"];
  target: HandoffManifestV1["target"];
  intent: HandoffManifestV1["intent"];
  baseCommit: string;
  candidateTreeHash?: string | undefined;
  deliverables: HandoffDeliverables;
  verificationEvidence: HandoffVerificationEvidence;
  openQuestions?: string[] | undefined;
  suggestedNextStep?: HandoffManifestV1["suggestedNextStep"];
}): HandoffManifestV1 {
  const handoffId = `hnd_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const createdAt = new Date().toISOString();

  return {
    schema: HANDOFF_MANIFEST_SCHEMA,
    handoffId,
    taskId: input.taskId,
    workflowRunId: input.workflowRunId,
    reworkOf: input.reworkOf ?? null,
    source: input.source,
    target: input.target,
    intent: input.intent,
    status: "pending",
    baseCommit: input.baseCommit,
    ...(input.candidateTreeHash ? { candidateTreeHash: input.candidateTreeHash } : {}),
    deliverables: input.deliverables,
    verificationEvidence: input.verificationEvidence,
    openQuestions: input.openQuestions ?? [],
    ...(input.suggestedNextStep ? { suggestedNextStep: input.suggestedNextStep } : {}),
    createdAt,
  };
}

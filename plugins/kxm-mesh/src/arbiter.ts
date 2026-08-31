import {
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  MAX_CONTEXT_ITEMS,
  estimateContextTokens,
  parseContextItem,
  parseContextRequest,
  provenanceSummaryOf,
  validateContextPacketContents,
  type ContextItem,
  type ContextItemKind,
  type ContextPacket,
  type ContextRequest,
} from "./context.ts";
import { ProtocolError } from "./protocol.ts";
import type { JournalCategory, WorkflowJournalEntry } from "./workflow.ts";

/**
 * Role-aware context arbiter (v0.5, issue #34).
 *
 * The arbiter assembles context packets from the durable pool (journal
 * evidence, temporal state, knowledge, episodes, skills) for one role, task,
 * and token budget. Selection is deterministic: the same pool and request
 * always produce the same packet, so packets are testable, explainable, and
 * reproducible.
 */

export interface RoleContextPolicy {
  role: string;
  label: string;
  /** Item kinds this role receives, in priority order. */
  kinds: ContextItemKind[];
  /** Journal categories this role recalls from, in priority order. */
  journalCategories: JournalCategory[];
  /** Fixed default token budget for this role. */
  budgetTokens: number;
}

export const ROLE_POLICIES: readonly RoleContextPolicy[] = [
  {
    role: "repro",
    label: "Reproduction specialist",
    kinds: ["episode", "knowledge"],
    journalCategories: ["error", "lesson", "observation", "contradiction"],
    budgetTokens: 8_000,
  },
  {
    role: "planner",
    label: "Planner",
    kinds: ["state", "knowledge", "evidence"],
    journalCategories: ["plan", "decision", "contradiction", "observation", "hypothesis", "experiment"],
    budgetTokens: 16_000,
  },
  {
    role: "critic",
    label: "Independent critic",
    kinds: ["knowledge", "evidence", "episode"],
    journalCategories: ["contradiction", "error", "lesson", "experiment"],
    budgetTokens: 12_000,
  },
  {
    role: "implementer",
    label: "Implementer",
    kinds: ["knowledge", "state", "skill", "episode"],
    journalCategories: ["plan", "decision", "lesson", "state-change"],
    budgetTokens: 16_000,
  },
  {
    role: "verifier",
    label: "Verifier",
    kinds: ["evidence", "knowledge", "episode"],
    journalCategories: ["plan", "error", "lesson", "contradiction"],
    budgetTokens: 8_000,
  },
];

export function rolePolicy(role: string): RoleContextPolicy {
  return ROLE_POLICIES.find((policy) => policy.role === role) ?? {
    role,
    label: role,
    kinds: ["knowledge", "evidence"],
    journalCategories: ["lesson", "observation"],
    budgetTokens: DEFAULT_CONTEXT_BUDGET_TOKENS,
  };
}

const CONFIDENCE_RANK: Record<ContextItem["confidence"], number> = { verified: 3, probable: 2, uncertain: 1 };
const AUTHORITY_WEIGHT: Record<ContextItem["authority"], number> = { policy: 3, instruction: 2, evidence: 1, hypothesis: 0 };

export interface ArbiterOptions {
  /** Hub-owned working state (run/stage/attempt) delivered verbatim. */
  workingState?: Record<string, unknown>;
  /** Pool item IDs that represent open contradictions; they are routed to the
   * packet's contradictions section instead of their kind's section. */
  contradictionIds?: string[];
}

export interface ArbiterOutcome {
  packet: ContextPacket;
  /** Metadata-only telemetry: what was selected, from where, at what cost.
   * Never includes raw bodies. */
  audit: {
    request: { project: string; role: string; task: string; workflowRunId?: string; stageId?: string };
    selectedIds: string[];
    provenanceSummary: Record<string, number>;
    estimatedTokens: number;
    budgetTokens: number;
    candidateCount: number;
    excludedSuperseded: number;
    unresolvedGaps: string[];
  };
}

/** Deterministically assemble a role-aware context packet. Superseded and
 * rejected records are excluded by default; cross-project content fails
 * closed; the token budget is enforced on the serialized selection. */
export function arbitrate(
  requestInput: unknown,
  pool: ContextItem[],
  options: ArbiterOptions = {},
): ArbiterOutcome {
  const request = parseContextRequest(requestInput);
  const policy = rolePolicy(request.role);
  const budget = request.budgetTokens ?? policy.budgetTokens;
  const contradictions = new Set(options.contradictionIds ?? []);

  const candidates: ContextItem[] = [];
  let excludedSuperseded = 0;
  for (const candidate of pool) {
    if (candidate.project !== request.project) {
      // Defense in depth: the hub pre-filters by project, so a foreign item
      // in the pool is a bug — fail closed rather than silently filter.
      throw new ProtocolError(
        403,
        `context pool contains cross-project item ${candidate.id}`,
        "context_isolation_violation",
      );
    }
    if (candidate.status === "superseded" || candidate.status === "rejected") {
      excludedSuperseded += 1;
      continue;
    }
    candidates.push(candidate);
  }

  const kindRank = new Map<string, number>();
  const requestedKinds = request.includeKinds ?? policy.kinds;
  requestedKinds.forEach((kind, index) => kindRank.set(kind, index));
  const kindPreference = (item: ContextItem): number => {
    const rank = kindRank.get(item.kind);
    return rank === undefined ? requestedKinds.length : rank;
  };

  const ordered = [...candidates].sort((left, right) =>
    (contradictions.has(right.id) ? 1 : 0) - (contradictions.has(left.id) ? 1 : 0)
    || kindPreference(left) - kindPreference(right)
    || CONFIDENCE_RANK[right.confidence] - CONFIDENCE_RANK[left.confidence]
    || AUTHORITY_WEIGHT[right.authority] - AUTHORITY_WEIGHT[left.authority]
    || left.id.localeCompare(right.id),
  );

  const kindAllowed = (item: ContextItem): boolean =>
    (request.includeKinds ?? policy.kinds).includes(item.kind)
    || contradictions.has(item.id);

  const selected: ContextItem[] = [];
  const unresolvedGaps: string[] = [];
  for (const item of ordered) {
    if (selected.length >= MAX_CONTEXT_ITEMS) {
      unresolvedGaps.push("context item limit reached; refine the task or kinds");
      break;
    }
    if (!kindAllowed(item)) continue;
    const nextTokens = estimateContextTokens([...selected, item]);
    if (nextTokens > budget) {
      if (selected.length === 0) {
        unresolvedGaps.push(`budget of ${budget} tokens cannot fit any selected context`);
        break;
      }
      unresolvedGaps.push(`budget of ${budget} tokens reached; ${ordered.length - selected.length} candidates deferred`);
      break;
    }
    selected.push(item);
  }
  if (candidates.length === 0) {
    unresolvedGaps.push("no context records exist for this project yet");
  }

  const bySection = (kind: ContextItemKind): ContextItem[] =>
    selected.filter((item) => item.kind === kind && !contradictions.has(item.id));

  const packet: ContextPacket = {
    workingState: options.workingState ?? {},
    currentState: bySection("state").filter((item) => item.status === "current" || item.status === undefined),
    knowledge: bySection("knowledge"),
    episodes: bySection("episode"),
    skills: bySection("skill"),
    contradictions: selected.filter((item) => contradictions.has(item.id)),
    unresolvedGaps,
    provenanceSummary: provenanceSummaryOf(selected),
    estimatedTokens: estimateContextTokens(selected),
  };
  validateContextPacketContents(request, packet);

  return {
    packet,
    audit: {
      request: {
        project: request.project,
        role: request.role,
        task: request.task,
        ...(request.workflowRunId !== undefined ? { workflowRunId: request.workflowRunId } : {}),
        ...(request.stageId !== undefined ? { stageId: request.stageId } : {}),
      },
      selectedIds: selected.map((item) => item.id),
      provenanceSummary: packet.provenanceSummary,
      estimatedTokens: packet.estimatedTokens,
      budgetTokens: budget,
      candidateCount: candidates.length,
      excludedSuperseded,
      unresolvedGaps,
    },
  };
}

/** Convert a durable journal entry into a pool context item. Journal content
 * is evidence about work, never policy: entries become `evidence` or
 * `knowledge` items with workflow provenance and the entry as sourceRef. */
export function journalEntryToContextItem(entry: WorkflowJournalEntry, project: string): ContextItem {
  const kind: ContextItemKind = entry.category === "plan" || entry.category === "decision" || entry.category === "lesson"
    ? "knowledge"
    : entry.category === "skill-candidate"
      ? "skill"
      : "evidence";
  const item: ContextItem = {
    id: `journal_${entry.id}`,
    kind,
    project,
    summary: entry.summary,
    provenance: {
      sourceType: "workflow",
      sourceRef: `journal:${entry.id}`,
    },
    authority: entry.category === "decision" || entry.category === "plan" ? "evidence" : "evidence",
    confidence: entry.severity === "error" ? "probable" : "probable",
    ...(entry.stageId !== undefined ? { observedAt: entry.createdAt } : {}),
    evidenceRefs: entry.evidence
      .filter((ref) => ref.length > 0 && ref.length <= 200)
      .slice(0, 16),
  };
  if (entry.stageId !== undefined) item.observedAt = entry.createdAt;
  if (kind === "skill") item.status = "proposed";
  return parseContextItem(item);
}

/** Which pool records support a claim: the item itself plus its full
 * derivation lineage and evidence refs, metadata only (no raw bodies). */
export function explainContextItem(id: string, pool: ContextItem[]): {
  item: ContextItem | undefined;
  lineage: string[];
  evidenceRefs: string[];
  sources: { id: string; sourceType: string; sourceRef?: string }[];
} {
  const byId = new Map(pool.map((item) => [item.id, item]));
  const item = byId.get(id);
  if (!item) return { item: undefined, lineage: [], evidenceRefs: [], sources: [] };
  const lineage: string[] = [];
  const queue = [...(item.provenance.derivedFrom ?? [])];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const ancestorId = queue.shift()!;
    if (seen.has(ancestorId)) continue;
    seen.add(ancestorId);
    lineage.push(ancestorId);
    const ancestor = byId.get(ancestorId);
    for (const older of ancestor?.provenance.derivedFrom ?? []) queue.push(older);
  }
  lineage.sort();
  const sources = [item, ...lineage.map((ancestorId) => byId.get(ancestorId))]
    .filter((candidate): candidate is ContextItem => candidate !== undefined)
    .map((candidate) => ({
      id: candidate.id,
      sourceType: candidate.provenance.sourceType,
      ...(candidate.provenance.sourceRef !== undefined ? { sourceRef: candidate.provenance.sourceRef } : {}),
    }));
  return {
    item,
    lineage,
    evidenceRefs: item.evidenceRefs ?? [],
    sources,
  };
}

import { ProtocolError, newId, nowIso } from "./protocol.ts";
import { parseContextItem, type ContextItem } from "./context.ts";
import type { StateChangeProposal, StateProvider } from "./context/providers.ts";
import type { MeshStore } from "./store.ts";

/**
 * Authoritative temporal project state (v0.5, issue #33).
 *
 * State items are ContextItems of kind `state` addressed by `stateKey`. The
 * lifecycle is explicit: `proposed` → `current` → `superseded` (or
 * `rejected`). Queries are deterministic and historical (`asOf`), and every
 * mutation is evidence-bound and audited through durable records.
 *
 * The native implementation persists through the MeshStore SQLite context
 * table; the `StateProvider` seam (issue #31) keeps this replaceable by a
 * temporal-graph adapter without changing KXM's public API.
 */

export type StateLifecycle = "current" | "superseded" | "proposed" | "rejected";

/** Keys that are explicitly declared set-valued: more than one current item
 * may exist at a time and callers must use `currentSet` instead of `get`. */
export type SetValuedStateKeys = ReadonlySet<string>;

export const MAX_STATE_EVIDENCE_REFS = 32;

function timestampMs(value: string | undefined): number {
  if (value === undefined) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/** True when the item's validity window contains `atMs`. Items without
 * `validFrom` are treated as valid since the beginning of time; items without
 * `validUntil` remain valid indefinitely. */
export function stateActiveAt(item: ContextItem, atMs: number): boolean {
  if (item.kind !== "state") return false;
  if (item.status !== "current" && item.status !== "superseded") return false;
  const from = timestampMs(item.validFrom);
  const until = item.validUntil === undefined ? Number.POSITIVE_INFINITY : timestampMs(item.validUntil);
  return from <= atMs && atMs < until;
}

/** Deterministic winner among active items for one key: greatest validFrom,
 * then greatest id. Identical inputs always produce identical results. */
export function latestActive(items: ContextItem[]): ContextItem | undefined {
  let best: ContextItem | undefined;
  for (const item of items) {
    if (best === undefined
      || timestampMs(item.validFrom) > timestampMs(best.validFrom)
      || (timestampMs(item.validFrom) === timestampMs(best.validFrom) && item.id > best.id)) {
      best = item;
    }
  }
  return best;
}

/** The item that directly superseded `id`, if any. */
export function findSuperseder(items: ContextItem[], id: string): ContextItem | undefined {
  return items.find((item) => (item.supersedes ?? []).includes(id));
}

export interface StateContradiction {
  project: string;
  stateKey: string;
  /** More than one current item for a single-valued key. */
  competingCurrentIds: string[];
  /** Competing unresolved proposals for the same key. */
  competingProposalIds: string[];
}

/** Detect contradictions in a project's state: single-valued keys with more
 * than one current item, and keys with competing unresolved proposals. Open
 * contradictions are surfaced (wiki, arbiter) — never silently resolved. */
export function detectStateContradictions(
  project: string,
  items: ContextItem[],
  setValuedKeys: SetValuedStateKeys = new Set(),
): StateContradiction[] {
  const byKey = new Map<string, ContextItem[]>();
  for (const item of items) {
    if (item.kind !== "state" || item.project !== project) continue;
    const key = item.stateKey ?? "";
    const bucket = byKey.get(key) ?? [];
    bucket.push(item);
    byKey.set(key, bucket);
  }
  const contradictions: StateContradiction[] = [];
  for (const [stateKey, bucket] of [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (setValuedKeys.has(stateKey)) continue;
    const competingCurrentIds = bucket
      .filter((item) => item.status === "current")
      .map((item) => item.id)
      .sort();
    const competingProposalIds = bucket
      .filter((item) => item.status === "proposed")
      .map((item) => item.id)
      .sort();
    if (competingCurrentIds.length > 1 || competingProposalIds.length > 1) {
      contradictions.push({ project, stateKey, competingCurrentIds, competingProposalIds });
    }
  }
  return contradictions;
}

/** Parse a state item from untrusted input. State items must carry a key and
 * an explicit lifecycle status. */
export function parseStateItem(value: unknown): ContextItem {
  const item = parseContextItem(value);
  if (item.kind !== "state") {
    throw new ProtocolError(400, "state layer accepts only state items", "invalid_state_item");
  }
  return item;
}

/** Native SQLite-backed temporal state provider. Agents may propose; only
 * the control plane (hub admin routes) may promote, and never the proposal
 * author. All mutations are durable and evidence-bound. */
export class NativeStateProvider implements StateProvider {
  readonly name = "native-sqlite";
  private readonly store: MeshStore;
  private readonly now: () => string;
  private readonly setValuedKeys: SetValuedStateKeys;

  constructor(store: MeshStore, options: { now?: () => string; setValuedKeys?: SetValuedStateKeys } = {}) {
    this.store = store;
    this.now = options.now ?? nowIso;
    this.setValuedKeys = options.setValuedKeys ?? new Set();
  }

  private projectState(project: string): ContextItem[] {
    return this.store.listContextItems(project, ["state"]);
  }

  private itemsForKey(project: string, key: string): ContextItem[] {
    return this.projectState(project).filter((item) => item.stateKey === key);
  }

  /** Current value for a key at a point in time. Superseded values never
   * appear as current: historical queries return the item that *was* current
   * at `asOf` via its validity window. Fails closed when a single-valued key
   * holds competing current items. */
  async get(project: string, key: string, asOf?: string): Promise<ContextItem | null> {
    const scopedProject = requireNonEmpty(project, "project");
    const scopedKey = requireNonEmpty(key, "key");
    if (this.setValuedKeys.has(scopedKey)) {
      throw new ProtocolError(
        400,
        `state key ${scopedKey} is set-valued; use currentSet`,
        "state_key_set_valued",
      );
    }
    const atMs = asOf === undefined
      ? Date.parse(this.now())
      : requireIso(asOf, "asOf");
    const active = this.itemsForKey(scopedProject, scopedKey).filter((item) => stateActiveAt(item, atMs));
    const currents = active.filter((item) => item.status === "current");
    if (currents.length > 1) {
      throw new ProtocolError(
        409,
        `state key ${scopedKey} has competing current items; resolve the contradiction first`,
        "state_contradiction",
      );
    }
    const winner = currents.length === 1 ? currents[0] : latestActive(active);
    return winner ?? null;
  }

  /** All current items for a set-valued key. */
  async currentSet(project: string, key: string): Promise<ContextItem[]> {
    const scopedProject = requireNonEmpty(project, "project");
    const scopedKey = requireNonEmpty(key, "key");
    if (!this.setValuedKeys.has(scopedKey)) {
      throw new ProtocolError(400, `state key ${scopedKey} is single-valued`, "state_key_single_valued");
    }
    return this.itemsForKey(scopedProject, scopedKey)
      .filter((item) => item.status === "current")
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Record a proposal. Proposing changes nothing until an authorized,
   * evidence-bound promotion runs. Returns the durable proposal item ID. */
  async propose(change: StateChangeProposal): Promise<string> {
    if (change?.schema !== "kxm.state-change-proposal.v1") {
      throw new ProtocolError(400, "invalid state change proposal schema", "invalid_state_proposal");
    }
    if (change.origin !== "peer" && change.origin !== "human") {
      throw new ProtocolError(400, "state change proposal origin must be peer or human", "invalid_state_proposal");
    }
    const project = requireNonEmpty(change.project, "proposal project");
    const key = requireNonEmpty(change.key, "proposal key");
    const evidenceRefs = boundedRefs(change.evidenceRefs, "proposal evidenceRefs");
    const proposal: ContextItem = parseStateItem({
      id: newId("ctx"),
      kind: "state",
      project,
      summary: change.summary,
      provenance: {
        sourceType: change.origin,
        sourceRef: `proposed-by:${change.proposedBy}`,
      },
      authority: change.authority,
      confidence: change.confidence,
      stateKey: key,
      status: "proposed",
      validFrom: this.now(),
      evidenceRefs,
      ...(change.supersedes ? { supersedes: boundedRefs(change.supersedes, "proposal supersedes") } : {}),
    });
    this.store.saveContextItem(proposal);
    return proposal.id;
  }

  /** Promote a proposal to current with durable evidence. The promoter must
   * differ from the proposal author (agents may propose but never silently
   * promote). Superseded previous values get an explicit validity window so
   * historical queries stay deterministic. */
  async promote(proposalId: string, evidence: string[], promotedBy: string): Promise<ContextItem> {
    const id = requireNonEmpty(proposalId, "proposalId");
    const promoter = requireNonEmpty(promotedBy, "promotedBy");
    const evidenceRefs = boundedRefs(evidence, "promotion evidence");
    const proposal = this.store.getContextItem(id);
    if (!proposal || proposal.kind !== "state") {
      throw new ProtocolError(404, `state proposal ${id} not found`, "state_proposal_not_found");
    }
    if (proposal.status !== "proposed") {
      throw new ProtocolError(
        400,
        `state proposal ${id} already reached lifecycle state ${proposal.status}`,
        "state_proposal_not_promotable",
      );
    }
    const proposedBy = proposal.provenance.sourceRef?.startsWith("proposed-by:")
      ? proposal.provenance.sourceRef.slice("proposed-by:".length)
      : undefined;
    if (proposedBy === promoter) {
      throw new ProtocolError(
        400,
        "the author of a state proposal cannot promote it",
        "state_promotion_invalid",
      );
    }
    const now = this.now();
    const key = proposal.stateKey ?? "";
    if (!key) {
      throw new ProtocolError(400, "state proposal has no stateKey", "state_promotion_invalid");
    }
    // Capture the identities that hold current authority *before* stamping,
    // so the supersession graph reflects who was actually superseded.
    let supersededIds: string[] = [];
    if (!this.setValuedKeys.has(key)) {
      const atMs = Date.parse(now);
      const supersededItems = this.itemsForKey(proposal.project, key)
        .filter((item) => item.status === "current" && stateActiveAt(item, atMs));
      supersededIds = supersededItems.map((item) => item.id);
      for (const item of supersededItems) {
        this.store.saveContextItem({
          ...item,
          status: "superseded",
          validUntil: now,
        });
      }
    }
    const promoted: ContextItem = parseStateItem({
      ...proposal,
      id: newId("ctx"),
      status: "current",
      validFrom: now,
      validUntil: undefined,
      supersedes: [...new Set([...(proposal.supersedes ?? []), ...supersededIds])].sort(),
      evidenceRefs: [...new Set([...(proposal.evidenceRefs ?? []), ...evidenceRefs])].sort(),
      provenance: {
        ...proposal.provenance,
        sourceRef: `promoted-by:${promoter}`,
      },
    });
    // Resolve the proposal record itself: it has been consumed by promotion.
    this.store.saveContextItem({ ...proposal, status: "rejected", validUntil: now });
    this.store.saveContextItem(promoted);
    return promoted;
  }

  /** Which item superseded `id`, if any. */
  async supersededBy(project: string, id: string): Promise<ContextItem | null> {
    const scopedProject = requireNonEmpty(project, "project");
    const superseder = findSuperseder(this.projectState(scopedProject), id);
    return superseder ?? null;
  }

  /** Audit trail for one key: proposals, promotions, and supersessions in
   * deterministic order. */
  stateHistory(project: string, key: string): ContextItem[] {
    return this.itemsForKey(project, key)
      .sort((left, right) =>
        timestampMs(left.validFrom) - timestampMs(right.validFrom) || left.id.localeCompare(right.id),
      );
  }

  contradictions(): StateContradiction[] {
    const projects = [...new Set([...this.store.contextItems.values()].map((item) => item.project))];
    return projects.flatMap((project) => detectStateContradictions(project, this.projectState(project), this.setValuedKeys));
  }
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProtocolError(400, `${field} cannot be empty`, "invalid_state_request");
  }
  return value.trim();
}

function requireIso(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ProtocolError(400, `${field} must be an ISO-8601 timestamp`, "invalid_state_request");
  }
  return parsed;
}

function boundedRefs(value: string[], field: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_STATE_EVIDENCE_REFS) {
    throw new ProtocolError(
      400,
      `${field} must contain between 1 and ${MAX_STATE_EVIDENCE_REFS} references`,
      "state_promotion_invalid",
    );
  }
  return value.map((ref) => requireNonEmpty(ref, `${field} entry`));
}

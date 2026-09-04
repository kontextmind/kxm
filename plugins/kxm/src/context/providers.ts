import type { ContextItem, ContextItemKind } from "../context.ts";

/**
 * Internal context provider seams. These interfaces exist so optional backends
 * (a native SQLite provider, a Graphiti temporal-graph adapter, an
 * experimental Hindsight adapter, or a filesystem/Git wiki provider) can be
 * evaluated later without changing KXM's public API.
 *
 * Agents NEVER bind to these interfaces. Agent-facing surfaces are the
 * `kxm context` CLI and the `kxm_context`/`kxm_recall`/`kxm_state`/
 * `kxm_episode`/`kxm_promote` Pi/MCP tools, which route exclusively through
 * the KXM context engine. Provider details, credentials, and failure modes
 * must remain invisible to agent prompts.
 */

/** Bounded recall request scoped to exactly one project. Providers must fail
 * closed (return nothing) rather than approximate across project bounds. */
export interface ProviderRecallRequest {
  project: string;
  kinds: ContextItemKind[];
  /** Maximum items a provider may return. Hard ceiling. */
  limit: number;
}

/** Recall providers surface candidate context items. They cannot grant
 * authority: every returned item still passes arbiter provenance/authority
 * rules before reaching an agent. */
export interface ContextProvider {
  readonly name: string;
  recall(request: ProviderRecallRequest): Promise<ContextItem[]>;
  /** Health signal for telemetry. Unhealthy providers shrink context; they
   * never widen authority or scope. */
  healthy(): Promise<boolean>;
}

/** A proposed change to one state key. Proposal alone changes nothing: state
 * only moves on an evidence-backed, authorized promotion. */
export interface StateChangeProposal {
  schema: "kxm.state-change-proposal.v1";
  project: string;
  key: string;
  summary: string;
  authority: ContextItem["authority"];
  confidence: ContextItem["confidence"];
  evidenceRefs: string[];
  proposedBy: string;
  supersedes?: string[];
}

/** Temporal state providers implement current/superseded/proposed/rejected
 * lifecycle with historical queries. One current value per key unless the
 * state schema explicitly declares a set-valued key. */
export interface StateProvider {
  readonly name: string;
  /** Current value for a key at a point in time, or null when absent. */
  get(project: string, key: string, asOf?: string): Promise<ContextItem | null>;
  /** Record a proposal; returns the durable proposal ID. */
  propose(change: StateChangeProposal): Promise<string>;
  /** Promote a proposal with durable evidence. Callers must be authorized by
   * the control plane; agents may propose but never silently promote. */
  promote(proposalId: string, evidence: string[], promotedBy: string): Promise<ContextItem>;
  /** Supersession graph query: the item superseded by `id`, if any. */
  supersededBy(project: string, id: string): Promise<ContextItem | null>;
}

/** Registry of internal providers. Bounded, named, and project-scoped; a
 * provider failure fails closed to a smaller context, never broader
 * authority. */
export class ContextProviderRegistry {
  private readonly contextProviders = new Map<string, ContextProvider>();
  private readonly stateProviders = new Map<string, StateProvider>();

  registerContextProvider(provider: ContextProvider): void {
    this.contextProviders.set(provider.name, provider);
  }

  registerStateProvider(provider: StateProvider): void {
    this.stateProviders.set(provider.name, provider);
  }

  get contextProviderNames(): string[] {
    return [...this.contextProviders.keys()].sort();
  }

  get stateProviderNames(): string[] {
    return [...this.stateProviders.keys()].sort();
  }

  async recallFromAll(request: ProviderRecallRequest): Promise<ContextItem[]> {
    const collected: ContextItem[] = [];
    for (const provider of this.contextProviders.values()) {
      try {
        const items = await provider.recall(request);
        collected.push(...items.slice(0, request.limit));
      } catch {
        // Fail closed: an unhealthy provider contributes nothing.
      }
    }
    return collected.slice(0, request.limit);
  }
}

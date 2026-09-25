/**
 * Model Selector & Provider Authentication Model.
 *
 * Provides fast fuzzy filtering, capability inspection, and
 * provider readiness status across all supported harnesses.
 */

export interface ModelOptionItem {
  readonly id: string;
  readonly selector: string;
  readonly name: string;
  readonly provider: string;
  readonly harness: string;
  readonly contextWindow: number;
  readonly maxTokens?: number | undefined;
  readonly reasoning: boolean;
  readonly thinkingLevels?: readonly string[] | undefined;
  readonly cost: {
    readonly inputPerMillion: number;
    readonly outputPerMillion: number;
    readonly cacheReadPerMillion?: number | undefined;
  };
  readonly authStatus: "ready" | "missing_auth" | "unprobed";
  readonly authHint?: string | undefined;
}

export function filterModelOptions(
  models: readonly ModelOptionItem[],
  query?: string | undefined,
  providerFilter?: string | undefined,
): ModelOptionItem[] {
  const q = query?.trim().toLowerCase();
  const prov = providerFilter?.trim().toLowerCase();

  return models.filter((m) => {
    if (prov && m.provider.toLowerCase() !== prov && m.harness.toLowerCase() !== prov) {
      return false;
    }
    if (!q) return true;
    const matchTarget = `${m.id} ${m.selector} ${m.name} ${m.provider} ${m.harness}`.toLowerCase();
    return matchTarget.includes(q);
  });
}

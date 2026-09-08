export const PRICES_SCHEMA = "kxm.prices.v1";

export interface PriceTier {
  readonly upToContextTokens?: number | null | undefined;
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly cacheReadPerMillion?: number | null | undefined;
  readonly cacheWritePerMillion?: number | null | undefined;
}

export interface ModelPriceRow {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly aliases?: readonly string[] | undefined;
  readonly tiers: readonly PriceTier[];
}

export interface PriceCatalog {
  readonly schema: typeof PRICES_SCHEMA;
  readonly date: string;
  readonly sha256: string;
  readonly currency?: string | undefined;
  readonly models: readonly ModelPriceRow[];
}

export function findModelPrice(catalog: PriceCatalog, model: string, provider?: string): ModelPriceRow | undefined {
  const normalizedModel = model.trim().toLowerCase();
  const normalizedProvider = provider?.trim().toLowerCase();

  for (const entry of catalog.models) {
    if (normalizedProvider && entry.provider.toLowerCase() !== normalizedProvider) {
      const matchesAlias = entry.aliases?.some((a) => a.toLowerCase() === normalizedModel);
      if (!matchesAlias) continue;
    }
    if (entry.id.toLowerCase() === normalizedModel || entry.model.toLowerCase() === normalizedModel) {
      return entry;
    }
    if (entry.aliases?.some((a) => a.toLowerCase() === normalizedModel)) {
      return entry;
    }
  }
  return undefined;
}

export function calculateModelCost(
  catalog: PriceCatalog,
  params: {
    model: string;
    provider?: string;
    tokensIn?: number | null;
    tokensOut?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    contextTokens?: number | null;
  },
): { costUsd: number; priceRef: string } | undefined {
  const row = findModelPrice(catalog, params.model, params.provider);
  if (!row || row.tiers.length === 0) return undefined;

  const context = params.contextTokens ?? params.tokensIn ?? 0;
  let selectedTier = row.tiers[0]!;
  for (const tier of row.tiers) {
    if (tier.upToContextTokens !== undefined && tier.upToContextTokens !== null && context > tier.upToContextTokens) {
      continue;
    }
    selectedTier = tier;
    break;
  }

  const tokensIn = params.tokensIn ?? 0;
  const tokensOut = params.tokensOut ?? 0;
  const cacheRead = params.cacheReadTokens ?? 0;
  const cacheWrite = params.cacheWriteTokens ?? 0;

  const cost =
    (tokensIn / 1_000_000) * selectedTier.inputPerMillion +
    (tokensOut / 1_000_000) * selectedTier.outputPerMillion +
    (cacheRead / 1_000_000) * (selectedTier.cacheReadPerMillion ?? 0) +
    (cacheWrite / 1_000_000) * (selectedTier.cacheWritePerMillion ?? 0);

  const priceRef = `${catalog.date}#${row.id}`;
  return {
    costUsd: Math.round(cost * 1_000_000) / 1_000_000,
    priceRef,
  };
}

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
    if (normalizedProvider && entry.provider.toLowerCase() !== normalizedProvider) continue;
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

  if (catalog.currency !== undefined && catalog.currency !== "USD") return undefined;
  const validCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const tokensIn = params.tokensIn;
  const tokensOut = params.tokensOut;
  const cacheRead = params.cacheReadTokens;
  const cacheWrite = params.cacheWriteTokens;
  if (!validCount(tokensIn) || !validCount(tokensOut) || !validCount(cacheRead) || !validCount(cacheWrite)) return undefined;
  // Cumulative usage is not context occupancy. Only an unbounded flat tier can
  // be selected when the caller has no context measurement.
  const context = params.contextTokens;
  if (context != null && !validCount(context)) return undefined;
  const selectedTier = context == null
    ? (row.tiers.length === 1 && row.tiers[0]!.upToContextTokens == null ? row.tiers[0] : undefined)
    : row.tiers.find((tier) => tier.upToContextTokens == null || context <= tier.upToContextTokens);
  if (!selectedTier || (cacheRead > 0 && selectedTier.cacheReadPerMillion == null) || (cacheWrite > 0 && selectedTier.cacheWritePerMillion == null)) return undefined;

  const cost =
    (tokensIn / 1_000_000) * selectedTier.inputPerMillion +
    (tokensOut / 1_000_000) * selectedTier.outputPerMillion +
    (cacheRead / 1_000_000) * (selectedTier.cacheReadPerMillion ?? 0) +
    (cacheWrite / 1_000_000) * (selectedTier.cacheWritePerMillion ?? 0);

  if (!Number.isFinite(cost) || cost < 0) return undefined;
  const priceRef = `${catalog.date}#${row.id}`;
  return {
    costUsd: Math.round(cost * 1_000_000) / 1_000_000,
    priceRef,
  };
}

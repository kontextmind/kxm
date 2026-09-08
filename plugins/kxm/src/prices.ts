import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export * from "./price-calc.ts";
import type { PriceCatalog, ModelPriceRow, PriceTier } from "./price-calc.ts";
import { PRICES_SCHEMA } from "./price-calc.ts";

export function hashPriceCatalog(catalog: Omit<PriceCatalog, "sha256">): string {
  const canonical = {
    schema: catalog.schema,
    date: catalog.date,
    currency: catalog.currency ?? "USD",
    models: catalog.models.map((m) => ({
      id: m.id,
      provider: m.provider,
      model: m.model,
      aliases: m.aliases ? [...m.aliases].sort() : [],
      tiers: m.tiers.map((t) => ({
        upToContextTokens: t.upToContextTokens ?? null,
        inputPerMillion: t.inputPerMillion,
        outputPerMillion: t.outputPerMillion,
        cacheReadPerMillion: t.cacheReadPerMillion ?? null,
        cacheWritePerMillion: t.cacheWritePerMillion ?? null,
      })),
    })).sort((a, b) => a.id.localeCompare(b.id)),
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function parsePriceCatalog(text: string): PriceCatalog {
  const parsed = parse(text) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("price catalog must be an object");
  }
  if (parsed.schema !== PRICES_SCHEMA) {
    throw new Error(`price catalog schema must be ${PRICES_SCHEMA}`);
  }
  if (typeof parsed.date !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(parsed.date)) {
    throw new Error("price catalog date must be YYYY-MM-DD");
  }
  if (typeof parsed.sha256 !== "string" || !/^(?:sha256:)?[a-f0-9]{64}$/.test(parsed.sha256)) {
    throw new Error("price catalog sha256 must be a 64-character hex digest");
  }
  if (!Array.isArray(parsed.models) || parsed.models.length === 0) {
    throw new Error("price catalog models must be a non-empty array");
  }
  const models: ModelPriceRow[] = parsed.models.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`price catalog model at index ${index} must be an object`);
    }
    const m = item as Record<string, unknown>;
    if (typeof m.id !== "string" || !m.id) {
      throw new Error(`price catalog model at index ${index} must have a non-empty id`);
    }
    if (typeof m.provider !== "string" || !m.provider) {
      throw new Error(`price catalog model at index ${index} must have a non-empty provider`);
    }
    if (typeof m.model !== "string" || !m.model) {
      throw new Error(`price catalog model at index ${index} must have a non-empty model`);
    }
    const aliases = Array.isArray(m.aliases)
      ? m.aliases.filter((a): a is string => typeof a === "string" && Boolean(a))
      : undefined;
    if (!Array.isArray(m.tiers) || m.tiers.length === 0) {
      throw new Error(`price catalog model ${m.id} must have at least one tier`);
    }
    const tiers: PriceTier[] = m.tiers.map((tItem, tIndex) => {
      if (!tItem || typeof tItem !== "object" || Array.isArray(tItem)) {
        throw new Error(`tier at index ${tIndex} for model ${m.id} must be an object`);
      }
      const t = tItem as Record<string, unknown>;
      const inputRate = typeof t.inputPerMillion === "number" ? t.inputPerMillion : (typeof t.input === "number" ? t.input : undefined);
      const outputRate = typeof t.outputPerMillion === "number" ? t.outputPerMillion : (typeof t.output === "number" ? t.output : undefined);
      if (inputRate === undefined || inputRate < 0) {
        throw new Error(`tier at index ${tIndex} for model ${m.id} must have a non-negative inputPerMillion`);
      }
      if (outputRate === undefined || outputRate < 0) {
        throw new Error(`tier at index ${tIndex} for model ${m.id} must have a non-negative outputPerMillion`);
      }
      return {
        upToContextTokens: typeof t.upToContextTokens === "number" ? t.upToContextTokens : null,
        inputPerMillion: inputRate,
        outputPerMillion: outputRate,
        cacheReadPerMillion: typeof t.cacheReadPerMillion === "number" ? t.cacheReadPerMillion : (typeof t.cacheRead === "number" ? t.cacheRead : null),
        cacheWritePerMillion: typeof t.cacheWritePerMillion === "number" ? t.cacheWritePerMillion : (typeof t.cacheWrite === "number" ? t.cacheWrite : null),
      };
    });
    return {
      id: m.id,
      provider: m.provider,
      model: m.model,
      aliases,
      tiers,
    };
  });

  return {
    schema: PRICES_SCHEMA,
    date: parsed.date,
    sha256: parsed.sha256.replace(/^sha256:/, ""),
    currency: typeof parsed.currency === "string" ? parsed.currency : "USD",
    models,
  };
}

export function loadPriceCatalog(rootOrPath: string): PriceCatalog | undefined {
  const candidatePath = existsSync(join(rootOrPath, ".kxm", "prices.yaml"))
    ? join(rootOrPath, ".kxm", "prices.yaml")
    : (existsSync(join(rootOrPath, "prices.yaml"))
      ? join(rootOrPath, "prices.yaml")
      : (existsSync(rootOrPath) && !rootOrPath.endsWith("/") ? rootOrPath : undefined));

  if (!candidatePath || !existsSync(candidatePath)) {
    return undefined;
  }
  const content = readFileSync(candidatePath, "utf8");
  return parsePriceCatalog(content);
}


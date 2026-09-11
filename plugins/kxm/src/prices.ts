import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
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
  if (!Number.isFinite(Date.parse(parsed.date)) || new Date(parsed.date).toISOString().slice(0, 10) !== parsed.date) {
    throw new Error("price catalog date must be a valid calendar date");
  }
  if (parsed.currency !== undefined && parsed.currency !== "USD") throw new Error("price catalog currency must be USD");
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
    const rawTiers = m.tiers;
    let previousBound = 0;
    const tiers: PriceTier[] = rawTiers.map((tItem, tIndex) => {
      if (!tItem || typeof tItem !== "object" || Array.isArray(tItem)) {
        throw new Error(`tier at index ${tIndex} for model ${m.id} must be an object`);
      }
      const t = tItem as Record<string, unknown>;
      const rate = (field: string, short: string, required = false): number | null => {
        const value = t[field] !== undefined ? t[field] : t[short];
        if (value == null && !required) return null;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw new Error(`tier ${tIndex} for model ${m.id} requires finite non-negative ${field}`);
        }
        return value;
      };
      const bound = t.upToContextTokens ?? null;
      if (bound === null) {
        if (tIndex !== rawTiers.length - 1) throw new Error("unbounded price tier must be last");
      } else {
        if (typeof bound !== "number" || !Number.isSafeInteger(bound) || bound <= previousBound) throw new Error("price tier bounds must be positive and strictly increasing");
        previousBound = bound;
      }
      return {
        upToContextTokens: bound,
        inputPerMillion: rate("inputPerMillion", "input", true)!,
        outputPerMillion: rate("outputPerMillion", "output", true)!,
        cacheReadPerMillion: rate("cacheReadPerMillion", "cacheRead"),
        cacheWritePerMillion: rate("cacheWritePerMillion", "cacheWrite"),
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

  const catalog: PriceCatalog = {
    schema: PRICES_SCHEMA,
    date: parsed.date,
    sha256: parsed.sha256.replace(/^sha256:/, ""),
    currency: typeof parsed.currency === "string" ? parsed.currency : "USD",
    models,
  };
  if (new Set(models.map((row) => row.id)).size !== models.length) throw new Error("duplicate price catalog model id");
  if (hashPriceCatalog(catalog) !== catalog.sha256) throw new Error("price catalog hash mismatch");
  return catalog;
}

export function loadPriceCatalog(rootOrPath: string): PriceCatalog | undefined {
  const candidatePath = existsSync(join(rootOrPath, ".kxm", "prices.yaml"))
    ? join(rootOrPath, ".kxm", "prices.yaml")
    : (existsSync(join(rootOrPath, "prices.yaml"))
      ? join(rootOrPath, "prices.yaml")
      : (existsSync(rootOrPath) && statSync(rootOrPath).isFile() ? rootOrPath : undefined));

  if (!candidatePath || !existsSync(candidatePath)) {
    return undefined;
  }
  const content = readFileSync(candidatePath, "utf8");
  return parsePriceCatalog(content);
}


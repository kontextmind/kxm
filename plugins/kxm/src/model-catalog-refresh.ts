import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isAlias, isMap, isSeq, parse, parseDocument, stringify, type YAMLMap, type YAMLSeq } from "yaml";
import type { PriceCatalog } from "./price-calc.ts";
import { hashPriceCatalog, parsePriceCatalog } from "./prices.ts";
import {
  OPENROUTER_MODELS_URL,
  inventoryModelFromAggregatorItem,
  type InventoryModel,
  type InventoryPrice,
  type ModelInventory,
} from "./model-inventory.ts";

export { OPENROUTER_MODELS_URL };

const RATE_FIELDS = ["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"] as const;
type RateField = (typeof RATE_FIELDS)[number];
const LIST_CAP = 40;

export interface CatalogReference {
  label: string;
  ids: readonly string[];
}

export interface RateChange {
  field: RateField;
  before: number | null;
  after: number | null;
  /** Absolute relative change. Infinite when a numeric rate becomes null or leaves zero. */
  ratio: number;
}

export interface FlaggedModel {
  id: string;
  kind: "disappeared" | "repriced";
  detail: string;
  references: string[];
}

export interface CatalogRefreshPlan {
  inventoryText: string;
  pricesText: string;
  changed: boolean;
  guardFailed: boolean;
  summary: string;
  added: string[];
  removed: string[];
  repriced: Array<{ id: string; changes: RateChange[] }>;
  priceRepriced: Array<{ id: string; changes: RateChange[] }>;
  retained: FlaggedModel[];
  flaggedRepriced: FlaggedModel[];
  tieredUnchanged: FlaggedModel[];
  ambiguousPrices: string[];
  date: string;
  pricedDate: string | null;
}

interface LoosePriceRow {
  id: string;
  provider: string;
  model: string;
  aliases?: string[];
  tiers: Array<Record<string, unknown>>;
}

function nearlyEqual(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= 1e-8 * scale;
}

function canonicalRate(value: number | null): number | null {
  if (value === null) return null;
  return Number(value.toFixed(10));
}

function ratesNearlyEqual(left: InventoryPrice | undefined, right: InventoryPrice | undefined): boolean {
  return rateChanges(left, right).length === 0;
}

export function rateChanges(before: InventoryPrice | undefined, after: InventoryPrice | undefined): RateChange[] {
  const changes: RateChange[] = [];
  for (const field of RATE_FIELDS) {
    const previous = before?.[field] ?? null;
    const next = after?.[field] ?? null;
    if (previous === null && next === null) continue;
    if (previous !== null && next !== null && nearlyEqual(previous, next)) continue;
    let ratio = Infinity;
    if (previous !== null && next !== null) {
      ratio = previous === 0 ? (next === 0 ? 0 : Infinity) : Math.abs(next - previous) / Math.abs(previous);
    }
    if (ratio === 0) continue;
    changes.push({ field, before: previous, after: next, ratio });
  }
  return changes;
}

function isSignificant(change: RateChange): boolean {
  if (change.before === null) return false;
  if (!Number.isFinite(change.ratio)) {
    return change.field === "inputPerMillion" || change.field === "outputPerMillion";
  }
  return change.ratio > 0.2;
}

function expandIds(raw: string): string[] {
  const out = new Set<string>();
  const addOne = (value: string): void => {
    const token = value.trim().toLowerCase();
    if (!token || out.has(token)) return;
    out.add(token);
    if (token.startsWith("openrouter/")) addOne(token.slice("openrouter/".length));
    const slash = token.indexOf("/");
    if (slash <= 0) return;
    const vendor = token.slice(0, slash);
    const rest = token.slice(slash + 1);
    if (vendor === "xai") addOne(`x-ai/${rest}`);
    else if (vendor === "x-ai") addOne(`xai/${rest}`);
    const effort = rest.match(/^(.*)-(low|medium|high|max)$/);
    if (effort?.[1]) addOne(`${vendor}/${effort[1]}`);
  };
  addOne(raw);
  return [...out];
}

function priceRowTokens(row: LoosePriceRow): string[] {
  const tokens = new Set<string>();
  const add = (value: string): void => {
    for (const id of expandIds(value)) tokens.add(id);
  };
  add(row.id);
  if (row.model.includes("/")) add(row.model);
  else add(`${row.provider}/${row.model}`);
  // Aliases on native and OpenRouter rows point at the catalog id. A different
  // plan (qwen-token-plan, zai-coding-cn) keeps its own rate. A YAML anchor that
  // a non-OpenRouter row depends on is not rewritten: the OpenRouter row is
  // detached onto its own tier and the plan row keeps the anchored rates.
  const trackAliases = new Set(["anthropic", "openai", "google", "xai", "openrouter"]);
  if (trackAliases.has(row.provider)) {
    for (const alias of row.aliases ?? []) add(alias.includes("/") ? alias : `${row.provider}/${alias}`);
  }
  return [...tokens];
}

function readLoosePrices(text: string): { date: string; rows: LoosePriceRow[] } {
  const parsed = parse(text) as { date?: unknown; models?: unknown };
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.models)) {
    throw new Error("price catalog must contain a models array");
  }
  if (typeof parsed.date !== "string") throw new Error("price catalog date must be a string");
  const rows: LoosePriceRow[] = parsed.models.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`price catalog model at index ${index} must be an object`);
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.provider !== "string" || typeof row.model !== "string") {
      throw new Error(`price catalog model at index ${index} is missing id, provider, or model`);
    }
    const aliases = Array.isArray(row.aliases) ? row.aliases.filter((alias): alias is string => typeof alias === "string") : undefined;
    const tiers = Array.isArray(row.tiers) ? row.tiers.filter((tier): tier is Record<string, unknown> => Boolean(tier) && typeof tier === "object") : [];
    return { id: row.id, provider: row.provider, model: row.model, ...(aliases ? { aliases } : {}), tiers };
  });
  return { date: parsed.date, rows };
}

function tierRates(tier: Record<string, unknown> | undefined): InventoryPrice | undefined {
  if (!tier) return undefined;
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const input = num(tier.inputPerMillion);
  const output = num(tier.outputPerMillion);
  if (input === null && output === null) return undefined;
  return {
    inputPerMillion: input,
    outputPerMillion: output,
    cacheReadPerMillion: num(tier.cacheReadPerMillion),
    cacheWritePerMillion: num(tier.cacheWritePerMillion),
  };
}

function formatRate(value: number | null): string {
  if (value === null) return "none";
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(10)));
}

function formatRatio(change: RateChange): string {
  if (!Number.isFinite(change.ratio) || change.before === null || change.after === null || change.before === 0) return "";
  const signed = (change.after - change.before) / Math.abs(change.before);
  const pct = Math.round(signed * 1000) / 10;
  const text = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  return ` (${pct > 0 ? "+" : ""}${text}%)`;
}

export function formatRateChanges(changes: readonly RateChange[]): string {
  return changes.map((change) => `${change.field} ${formatRate(change.before)} → ${formatRate(change.after)}${formatRatio(change)}`).join(", ");
}

function remember(map: Map<string, string[]>, token: string, label: string): void {
  const labels = map.get(token) ?? [];
  if (!labels.includes(label)) labels.push(label);
  map.set(token, labels);
}

function labelsFor(map: Map<string, string[]>, id: string): string[] {
  const labels = new Set<string>();
  for (const token of expandIds(id)) {
    for (const label of map.get(token) ?? []) labels.add(label);
  }
  return [...labels].sort((left, right) => left.localeCompare(right));
}

function indexOpenRouter(items: readonly unknown[]): Map<string, InventoryModel> {
  const byId = new Map<string, InventoryModel>();
  for (const item of items) {
    const model = inventoryModelFromAggregatorItem(item, "openrouter", "standard");
    if (!model) continue;
    byId.set(model.id.toLowerCase(), model);
  }
  if (byId.size === 0) throw new Error("OpenRouter catalog is empty");
  return byId;
}

function assignRates(target: InventoryPrice, incoming: InventoryPrice): boolean {
  let changed = false;
  for (const field of RATE_FIELDS) {
    const before = target[field];
    const after = canonicalRate(incoming[field]);
    if (before === null && after === null) continue;
    if (before !== null && after !== null && nearlyEqual(before, after)) continue;
    target[field] = after;
    changed = true;
  }
  return changed;
}

function desiredRates(matches: readonly InventoryModel[]): { rates?: InventoryPrice; ambiguous: boolean } {
  const priced = matches.filter((model) => model.standard);
  if (priced.length === 0) return { ambiguous: false };
  const first = priced[0]?.standard;
  if (!first) return { ambiguous: false };
  const ambiguous = priced.slice(1).some((model) => !ratesNearlyEqual(first, model.standard));
  return ambiguous ? { ambiguous: true } : { rates: first, ambiguous: false };
}

function writeTierRates(map: YAMLMap, previous: InventoryPrice, incoming: InventoryPrice): boolean {
  let changed = false;
  for (const field of RATE_FIELDS) {
    const before = previous[field];
    const after = canonicalRate(incoming[field]);
    if (before === null && after === null) continue;
    if (before !== null && after !== null && nearlyEqual(before, after)) continue;
    map.set(field, after);
    changed = true;
  }
  return changed;
}

function mapString(row: YAMLMap, key: string): string | undefined {
  const value = row.get(key);
  return typeof value === "string" ? value : undefined;
}

function soleTier(row: YAMLMap): { tiers: YAMLSeq; tier: unknown } | undefined {
  const tiers = row.get("tiers", true);
  if (!isSeq(tiers) || tiers.items.length !== 1) return undefined;
  return { tiers, tier: tiers.items[0] };
}

function anchorName(tier: unknown): string | undefined {
  if (isMap(tier) && tier.anchor) return tier.anchor;
  if (isAlias(tier)) return tier.source;
  return undefined;
}

function nonOpenRouterDependsOn(models: YAMLSeq, anchor: string): boolean {
  for (const row of models.items) {
    if (!isMap(row) || mapString(row, "provider") === "openrouter") continue;
    const sole = soleTier(row);
    if (sole && anchorName(sole.tier) === anchor) return true;
  }
  return false;
}

function rateTierNode(doc: ReturnType<typeof parseDocument>, rates: InventoryPrice, anchor?: string): YAMLMap {
  const node = doc.createNode({
    inputPerMillion: rates.inputPerMillion,
    outputPerMillion: rates.outputPerMillion,
    cacheReadPerMillion: rates.cacheReadPerMillion,
    cacheWritePerMillion: rates.cacheWritePerMillion,
  });
  if (!isMap(node)) throw new Error("price tier must be a map");
  if (anchor) node.anchor = anchor;
  return node;
}

/**
 * Gives an OpenRouter row its own tier. The shared anchor, and every
 * non-OpenRouter row that uses it, keep the rates they had.
 */
function detachOpenRouterTier(doc: ReturnType<typeof parseDocument>, models: YAMLSeq, row: YAMLMap, anchor: string, incoming: InventoryPrice): boolean {
  const sole = soleTier(row);
  if (!sole) return false;
  const { tiers, tier } = sole;
  if (isAlias(tier)) {
    tiers.items[0] = rateTierNode(doc, incoming);
    return true;
  }
  if (!isMap(tier) || tier.anchor !== anchor) return false;
  const previous = tierRates(tier.toJSON() as Record<string, unknown>);
  if (!previous) return false;
  for (const other of models.items) {
    if (!isMap(other) || other === row || mapString(other, "provider") === "openrouter") continue;
    const alias = soleTier(other);
    if (!alias || !isAlias(alias.tier) || alias.tier.source !== anchor) continue;
    delete tier.anchor;
    alias.tiers.items[0] = rateTierNode(doc, previous, anchor);
    tiers.items[0] = rateTierNode(doc, incoming);
    return true;
  }
  return false;
}

function updatePrices(text: string, updates: Map<string, InventoryPrice>, date: string): { text: string; dateChanged: boolean } {
  if (updates.size === 0) return { text, dateChanged: false };
  const doc = parseDocument(text);
  const models = doc.get("models", true);
  if (!isSeq(models)) throw new Error("price catalog models must be a sequence");
  const maps = new Map<string, YAMLMap>();
  let wrote = false;
  for (const row of models.items) {
    if (!isMap(row)) continue;
    const tiers = row.get("tiers", true);
    if (!isSeq(tiers) || tiers.items.length !== 1) continue;
    const tier = tiers.items[0];
    if (isMap(tier) && tier.anchor) maps.set(String(tier.anchor), tier);
  }
  const seen = new Set<YAMLMap>();
  for (const row of models.items) {
    if (!isMap(row)) continue;
    const id = row.get("id");
    if (typeof id !== "string" || !updates.has(id)) continue;
    const incoming = updates.get(id);
    if (!incoming) continue;
    const sole = soleTier(row);
    if (!sole) continue;
    const { tier } = sole;
    const name = anchorName(tier);
    if (name && mapString(row, "provider") === "openrouter" && nonOpenRouterDependsOn(models, name)) {
      if (detachOpenRouterTier(doc, models, row, name, incoming)) wrote = true;
      continue;
    }
    const target = isMap(tier) ? tier : (isAlias(tier) ? maps.get(String(tier.source)) : undefined);
    if (!target || seen.has(target)) continue;
    seen.add(target);
    const previous = tierRates(target.toJSON() as Record<string, unknown>);
    if (!previous) continue;
    if (writeTierRates(target, previous, incoming)) wrote = true;
  }
  if (!wrote) return { text, dateChanged: false };
  doc.set("date", date);
  const draft = doc.toString();
  const body = parse(draft) as { sha256?: string; schema: "kxm.prices.v1"; date: string; currency?: string; models: LoosePriceRow[] };
  const { sha256: _ignored, ...rest } = body;
  doc.set("sha256", hashPriceCatalog(rest as unknown as Omit<PriceCatalog, "sha256">));
  const next = doc.toString();
  parsePriceCatalog(next);
  return { text: next, dateChanged: true };
}

function listLines(title: string, ids: readonly string[]): string[] {
  const lines = [`- ${title}: ${ids.length}`];
  const shown = ids.slice(0, LIST_CAP);
  for (const id of shown) lines.push(`  - \`${id}\``);
  if (ids.length > LIST_CAP) lines.push(`  - … and ${ids.length - LIST_CAP} more`);
  return lines;
}

export function renderCatalogSummary(plan: Omit<CatalogRefreshPlan, "summary">): string {
  const lines: string[] = ["## Needs a human", ""];
  if (plan.retained.length === 0 && plan.flaggedRepriced.length === 0 && plan.tieredUnchanged.length === 0) {
    lines.push("No admitted route or roster model disappeared or was repriced by more than 20%.");
  } else {
    for (const flag of plan.retained) {
      lines.push(`- **Disappeared, kept:** \`${flag.id}\` — ${flag.references.join("; ") || "referenced model"}`);
    }
    for (const flag of plan.flaggedRepriced) {
      lines.push(`- **Repriced more than 20%:** \`${flag.id}\` ${flag.detail}${flag.references.length ? ` — ${flag.references.join("; ")}` : ""}`);
    }
    for (const flag of plan.tieredUnchanged) {
      lines.push(`- **Tiered price left unchanged:** \`${flag.id}\` ${flag.detail}${flag.references.length ? ` — ${flag.references.join("; ")}` : ""}`);
    }
  }
  lines.push("", "## Inventory", "");
  lines.push(...listLines("Added", plan.added));
  lines.push(...listLines("Removed", plan.removed));
  lines.push(`- Repriced: ${plan.repriced.length}`);
  for (const row of plan.repriced.slice(0, LIST_CAP)) lines.push(`  - \`${row.id}\` ${formatRateChanges(row.changes)}`);
  if (plan.repriced.length > LIST_CAP) lines.push(`  - … and ${plan.repriced.length - LIST_CAP} more`);
  lines.push("", "## Prices", "");
  lines.push(`- Repriced: ${plan.priceRepriced.length}`);
  for (const row of plan.priceRepriced.slice(0, LIST_CAP)) lines.push(`  - \`${row.id}\` ${formatRateChanges(row.changes)}`);
  if (plan.priceRepriced.length > LIST_CAP) lines.push(`  - … and ${plan.priceRepriced.length - LIST_CAP} more`);
  if (plan.pricedDate) lines.push(`- Date: ${plan.pricedDate}`);
  if (plan.ambiguousPrices.length > 0) {
    lines.push(`- Ambiguous OpenRouter matches left unchanged: ${plan.ambiguousPrices.length}`);
    for (const id of plan.ambiguousPrices.slice(0, LIST_CAP)) lines.push(`  - \`${id}\``);
  }
  lines.push("");
  return lines.join("\n");
}

function sortFlags(flags: FlaggedModel[]): FlaggedModel[] {
  return flags.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Applies an OpenRouter models payload to the checked-in inventory and price catalog.
 * The dated price field and inventory `fetchedAt` change only when the catalog content changes.
 * `fetchedAt` is midnight UTC on `date`, not a clock timestamp.
 */
export function planModelCatalogRefresh(input: {
  inventory: ModelInventory;
  inventoryText: string;
  pricesText: string;
  openRouterItems: readonly unknown[];
  references: readonly CatalogReference[];
  date: string;
  openRouterUrl?: string;
}): CatalogRefreshPlan {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("date must be YYYY-MM-DD");
  const feed = indexOpenRouter(input.openRouterItems);
  const loose = readLoosePrices(input.pricesText);
  const labelMap = new Map<string, string[]>();
  for (const reference of input.references) {
    for (const id of reference.ids) {
      for (const token of expandIds(id)) remember(labelMap, token, reference.label);
    }
  }
  for (const row of loose.rows) {
    const tokens = priceRowTokens(row);
    const labels = [...new Set(tokens.flatMap((token) => labelMap.get(token) ?? []))].sort((left, right) => left.localeCompare(right));
    if (labels.length === 0) continue;
    for (const token of tokens) {
      for (const label of labels) remember(labelMap, token, label);
    }
  }
  const referenced = (id: string): string[] => labelsFor(labelMap, id);

  const next = structuredClone(input.inventory) as ModelInventory;
  const previousRates = new Map(input.inventory.models.map((model) => [model.id, model.standard ? { ...model.standard } : undefined]));
  const present = new Set(feed.keys());
  const added: string[] = [];
  const removed: string[] = [];
  const retained: FlaggedModel[] = [];

  for (const [id, incoming] of feed) {
    const current = next.models.find((model) => model.id.toLowerCase() === id);
    if (!current) {
      const created: InventoryModel = {
        id: incoming.id,
        ...(incoming.name ? { name: incoming.name } : {}),
        ...(incoming.contextLength !== undefined ? { contextLength: incoming.contextLength } : {}),
        capabilities: incoming.capabilities,
        sources: ["openrouter"],
        ...(incoming.standard ? { standard: incoming.standard } : {}),
      };
      next.models.push(created);
      added.push(incoming.id);
      continue;
    }
    if (incoming.standard) {
      if (current.standard) assignRates(current.standard, incoming.standard);
      else current.standard = { ...incoming.standard };
    }
    if (!current.sources.includes("openrouter")) current.sources.push("openrouter");
    if (!current.name && incoming.name) current.name = incoming.name;
    if (current.contextLength === undefined && incoming.contextLength !== undefined) current.contextLength = incoming.contextLength;
    if (current.missingUpstream) delete current.missingUpstream;
  }

  next.models = next.models.filter((model) => {
    const key = model.id.toLowerCase();
    if (present.has(key) || !model.sources.includes("openrouter")) return true;
    const references = referenced(model.id);
    if (references.length > 0) {
      if (!model.missingUpstream) {
        model.missingUpstream = true;
        retained.push({ id: model.id, kind: "disappeared", detail: "left the OpenRouter catalog; previous row kept", references });
      }
      return true;
    }
    model.sources = model.sources.filter((source) => source !== "openrouter");
    delete model.standard;
    if (model.sources.length === 0) {
      removed.push(model.id);
      return false;
    }
    return true;
  });
  next.models.sort((left, right) => left.id.localeCompare(right.id));
  added.sort((left, right) => left.localeCompare(right));
  removed.sort((left, right) => left.localeCompare(right));

  const url = input.openRouterUrl ?? OPENROUTER_MODELS_URL;
  const source = next.sources.openrouter ?? { url, ok: true };
  if (source.url !== url || source.ok !== true || source.error) {
    next.sources.openrouter = { url, ok: true };
  } else if (source !== next.sources.openrouter) {
    next.sources.openrouter = source;
  }

  const repriced: Array<{ id: string; changes: RateChange[] }> = [];
  const flaggedRepriced: FlaggedModel[] = [];
  for (const model of next.models) {
    if (!previousRates.has(model.id)) continue;
    const changes = rateChanges(previousRates.get(model.id), model.standard);
    if (changes.length === 0) continue;
    repriced.push({ id: model.id, changes });
    if (!changes.some(isSignificant)) continue;
    const references = referenced(model.id);
    if (references.length === 0) continue;
    flaggedRepriced.push({ id: model.id, kind: "repriced", detail: formatRateChanges(changes), references });
  }
  repriced.sort((left, right) => left.id.localeCompare(right.id));

  const priceUpdates = new Map<string, InventoryPrice>();
  const tieredUnchanged: FlaggedModel[] = [];
  const ambiguousPrices: string[] = [];
  const beforeTiers = new Map(loose.rows.map((row) => [row.id, tierRates(row.tiers[0])]));
  for (const row of loose.rows) {
    const matched = new Map<string, InventoryModel>();
    for (const token of priceRowTokens(row)) {
      const hit = feed.get(token);
      if (hit) matched.set(hit.id.toLowerCase(), hit);
    }
    const desired = desiredRates([...matched.values()].sort((left, right) => left.id.localeCompare(right.id)));
    const current = beforeTiers.get(row.id);
    if (desired.ambiguous) {
      ambiguousPrices.push(row.id);
      continue;
    }
    if (!desired.rates || !current) continue;
    const canonical: InventoryPrice = {
      inputPerMillion: canonicalRate(desired.rates.inputPerMillion),
      outputPerMillion: canonicalRate(desired.rates.outputPerMillion),
      cacheReadPerMillion: canonicalRate(desired.rates.cacheReadPerMillion),
      cacheWritePerMillion: canonicalRate(desired.rates.cacheWritePerMillion),
    };
    const changes = rateChanges(current, canonical);
    if (changes.length === 0) continue;
    const references = referenced(row.id);
    if (row.tiers.length !== 1) {
      if (references.length > 0 && changes.some(isSignificant)) {
        tieredUnchanged.push({ id: row.id, kind: "repriced", detail: formatRateChanges(changes), references });
      }
      continue;
    }
    priceUpdates.set(row.id, canonical);
  }
  ambiguousPrices.sort((left, right) => left.localeCompare(right));

  const priced = updatePrices(input.pricesText, priceUpdates, input.date);
  const priceRepriced: Array<{ id: string; changes: RateChange[] }> = [];
  for (const row of readLoosePrices(priced.text).rows) {
    const changes = rateChanges(beforeTiers.get(row.id), tierRates(row.tiers[0]));
    if (changes.length === 0) continue;
    priceRepriced.push({ id: row.id, changes });
    const references = referenced(row.id);
    if (references.length > 0 && changes.some(isSignificant)) {
      flaggedRepriced.push({ id: row.id, kind: "repriced", detail: formatRateChanges(changes), references });
    }
  }
  priceRepriced.sort((left, right) => left.id.localeCompare(right.id));
  const inventoryChanged = JSON.stringify({ sources: next.sources, models: next.models }) !== JSON.stringify({ sources: input.inventory.sources, models: input.inventory.models });
  let inventoryText = input.inventoryText;
  if (inventoryChanged) {
    next.fetchedAt = `${input.date}T00:00:00.000Z`;
    inventoryText = stringify(next);
  }
  const pricedDate = priced.dateChanged ? `${loose.date} → ${input.date}` : null;
  const plan: Omit<CatalogRefreshPlan, "summary"> = {
    inventoryText,
    pricesText: priced.text,
    changed: inventoryText !== input.inventoryText || priced.text !== input.pricesText,
    guardFailed: retained.length > 0,
    added,
    removed,
    repriced,
    priceRepriced,
    retained: sortFlags(retained),
    flaggedRepriced: sortFlags(flaggedRepriced),
    tieredUnchanged: sortFlags(tieredUnchanged),
    ambiguousPrices,
    date: input.date,
    pricedDate,
  };
  return { ...plan, summary: renderCatalogSummary(plan) };
}

export function loadCatalogReferences(root: string): CatalogReference[] {
  const references: CatalogReference[] = [];
  const routesPath = join(root, ".kxm", "routes.yaml");
  if (!existsSync(routesPath)) throw new Error(`missing ${routesPath}`);
  const routes = parse(readFileSync(routesPath, "utf8")) as { admitted?: unknown; disabled?: unknown };
  const collect = (ids: unknown, kind: "admitted" | "disabled"): void => {
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      if (typeof id !== "string" || !id) continue;
      references.push({ label: `routes.yaml ${kind} \`${id}\``, ids: [id] });
    }
  };
  collect(routes.admitted, "admitted");
  collect(routes.disabled, "disabled");
  const rolesDir = join(root, ".kxm", "roles");
  if (!existsSync(rolesDir)) return references;
  for (const file of readdirSync(rolesDir).filter((name) => name.endsWith(".yaml")).sort()) {
    const role = parse(readFileSync(join(rolesDir, file), "utf8")) as { id?: unknown; roster?: unknown };
    const roleId = typeof role.id === "string" ? role.id : file.replace(/\.yaml$/, "");
    if (!Array.isArray(role.roster)) continue;
    for (const entry of role.roster) {
      if (!entry || typeof entry !== "object") continue;
      const route = (entry as { route?: unknown }).route;
      if (typeof route !== "string" || !route) continue;
      const ids = [route];
      const modelPath = join(root, ".kxm", "models", `${route}.yaml`);
      if (existsSync(modelPath)) {
        const model = parse(readFileSync(modelPath, "utf8")) as { model?: unknown; vendor?: unknown };
        if (typeof model.model === "string" && model.model) {
          ids.push(model.model);
          if (typeof model.vendor === "string" && model.vendor && !model.model.includes("/")) ids.push(`${model.vendor}/${model.model}`);
        }
      }
      references.push({ label: `roster ${roleId} \`${route}\``, ids });
    }
  }
  return references;
}

export function readCatalogFiles(root: string): { inventory: ModelInventory; inventoryText: string; pricesText: string } {
  const inventoryText = readFileSync(join(root, ".kxm", "models", "inventory.yaml"), "utf8");
  const pricesText = readFileSync(join(root, ".kxm", "prices.yaml"), "utf8");
  const inventory = parse(inventoryText) as ModelInventory;
  if (inventory.schema !== "kxm.model-inventory.v1" || !Array.isArray(inventory.models)) {
    throw new Error("inventory.yaml is not a kxm.model-inventory.v1 catalog");
  }
  return { inventory, inventoryText, pricesText };
}

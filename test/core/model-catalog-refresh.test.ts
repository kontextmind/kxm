import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import type { PriceCatalog } from "../../plugins/kxm/src/price-calc.ts";
import { hashPriceCatalog, parsePriceCatalog } from "../../plugins/kxm/src/prices.ts";
import {
  loadCatalogReferences,
  planModelCatalogRefresh,
  type CatalogReference,
} from "../../plugins/kxm/src/model-catalog-refresh.ts";
import type { InventoryModel, InventoryPrice, ModelInventory } from "../../plugins/kxm/src/model-inventory.ts";

const DATE = "2026-10-19";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

function rates(input: number, output: number, cacheRead: number | null = null, cacheWrite: number | null = null): InventoryPrice {
  return {
    inputPerMillion: input,
    outputPerMillion: output,
    cacheReadPerMillion: cacheRead,
    cacheWritePerMillion: cacheWrite,
  };
}

function inventoryModel(id: string, standard?: InventoryPrice, sources: string[] = ["openrouter"], extra: Partial<InventoryModel> = {}): InventoryModel {
  return {
    id,
    name: id,
    contextLength: 128000,
    capabilities: {
      thinking: { supported: null, source: "unknown" },
      speed: { fast: null, source: "unknown" },
    },
    sources,
    ...(standard ? { standard } : {}),
    ...extra,
  };
}

function inventoryFile(models: InventoryModel[], fetchedAt = "2026-10-17T13:45:00.000Z"): { inventory: ModelInventory; text: string } {
  const inventory: ModelInventory = {
    schema: "kxm.model-inventory.v1",
    fetchedAt,
    currency: "USD",
    sources: {
      pi: { url: "pi --list-models", ok: false, error: "spawn pi ENOENT" },
      openrouter: { url: OPENROUTER_URL, ok: true },
    },
    models,
  };
  return { inventory, text: stringify(inventory) };
}

function priceText(models: Array<Record<string, unknown>>, date = "2026-10-17"): string {
  const body = {
    schema: "kxm.prices.v1" as const,
    date,
    currency: "USD",
    models,
  };
  const sha256 = hashPriceCatalog(body as unknown as Omit<PriceCatalog, "sha256">);
  return stringify({ schema: body.schema, date: body.date, sha256, currency: body.currency, models: body.models });
}

function orItem(id: string, input: number, output: number, cacheRead?: number, cacheWrite?: number) {
  return {
    id,
    name: id,
    context_length: 128000,
    pricing: {
      prompt: String(input / 1_000_000),
      completion: String(output / 1_000_000),
      ...(cacheRead !== undefined ? { input_cache_read: String(cacheRead / 1_000_000) } : {}),
      ...(cacheWrite !== undefined ? { input_cache_write: String(cacheWrite / 1_000_000) } : {}),
    },
  };
}

function plan(options: {
  models: InventoryModel[];
  prices: string;
  items: unknown[];
  references?: CatalogReference[];
  date?: string;
}) {
  const { inventory, text } = inventoryFile(options.models);
  return planModelCatalogRefresh({
    inventory,
    inventoryText: text,
    pricesText: options.prices,
    openRouterItems: options.items,
    references: options.references ?? [],
    date: options.date ?? DATE,
  });
}

test("summary lists added, removed, and repriced models in stable order", () => {
  const prices = priceText([
    { id: "openrouter/keep/model", provider: "openrouter", model: "keep/model", tiers: [rates(1, 2)] },
  ]);
  const result = plan({
    models: [
      inventoryModel("keep/model", rates(1, 2)),
      inventoryModel("zeta/old", rates(1, 1)),
      inventoryModel("alpha/old", rates(1, 1)),
    ],
    prices,
    items: [
      orItem("keep/model", 1, 3),
      orItem("m/new", 4, 5),
      orItem("a/new", 4, 5),
    ],
  });
  assert.deepEqual(result.added, ["a/new", "m/new"]);
  assert.deepEqual(result.removed, ["alpha/old", "zeta/old"]);
  assert.deepEqual(result.repriced.map((row) => row.id), ["keep/model"]);
  assert.match(result.summary, /## Needs a human\n\nNo admitted route/);
  assert.match(result.summary, /Added: 2\n {2}- `a\/new`\n {2}- `m\/new`/);
  assert.match(result.summary, /Removed: 2\n {2}- `alpha\/old`/);
  assert.equal(result.guardFailed, false);
  assert.equal(result.inventoryText.includes("fetchedAt: 2026-10-19T00:00:00.000Z"), true);
  assert.equal(result.inventoryText.includes("T13:45"), false);
});

test("a referenced model that leaves OpenRouter is kept and fails the guard", () => {
  const prices = priceText([
    { id: "openrouter/qwen/qwen3.8-flash", provider: "openrouter", model: "qwen/qwen3.8-flash", tiers: [rates(0.15, 0.47, 0.016, null)] },
  ]);
  const result = plan({
    models: [inventoryModel("qwen/qwen3.8-flash", rates(0.15, 0.47, 0.016, null), ["openrouter", "nous"])],
    prices,
    items: [orItem("other/model", 1, 1)],
    references: [{ label: "routes.yaml admitted `openrouter/qwen/qwen3.8-flash`", ids: ["openrouter/qwen/qwen3.8-flash"] }],
  });
  assert.equal(result.guardFailed, true);
  assert.equal(result.removed.includes("qwen/qwen3.8-flash"), false);
  const kept = parse(result.inventoryText) as ModelInventory;
  const row = kept.models.find((model) => model.id === "qwen/qwen3.8-flash");
  assert.equal(row?.missingUpstream, true);
  assert.equal(row?.standard?.inputPerMillion, 0.15);
  assert.match(result.summary, /## Needs a human\n\n- \*\*Disappeared, kept:\*\* `qwen\/qwen3\.8-flash`/);
  assert.match(result.summary, /routes\.yaml admitted `openrouter\/qwen\/qwen3\.8-flash`/);
  const again = planModelCatalogRefresh({
    inventory: kept,
    inventoryText: result.inventoryText,
    pricesText: result.pricesText,
    openRouterItems: [orItem("other/model", 1, 1)],
    references: [{ label: "routes.yaml admitted `openrouter/qwen/qwen3.8-flash`", ids: ["openrouter/qwen/qwen3.8-flash"] }],
    date: DATE,
  });
  assert.equal(again.guardFailed, false);
  assert.equal(again.changed, false);
});

test("an unreferenced OpenRouter-only model is removed and a Nous row keeps its discount", () => {
  const prices = priceText([
    { id: "openrouter/stay/model", provider: "openrouter", model: "stay/model", tiers: [rates(1, 1)] },
  ]);
  const discount = rates(0.5, 0.5);
  const result = plan({
    models: [
      inventoryModel("gone/model", rates(3, 3)),
      inventoryModel("nous/only", rates(2, 2), ["openrouter", "nous"], { discount }),
    ],
    prices,
    items: [orItem("stay/model", 1, 1)],
  });
  assert.deepEqual(result.removed, ["gone/model"]);
  const next = parse(result.inventoryText) as ModelInventory;
  const nous = next.models.find((model) => model.id === "nous/only");
  assert.deepEqual(nous?.sources, ["nous"]);
  assert.equal(nous?.standard, undefined);
  assert.deepEqual(nous?.discount, discount);
  assert.equal(result.guardFailed, false);
});

test("reprices above 20 percent are flagged and a 20 percent change is not", () => {
  const prices = priceText([
    { id: "xai/grok-4.7", provider: "xai", model: "grok-4.7", aliases: ["x-ai/grok-4.7"], tiers: [rates(2, 6, 0.5, null)] },
    { id: "openrouter/edge/model", provider: "openrouter", model: "edge/model", tiers: [rates(2, 6)] },
  ]);
  const result = plan({
    models: [
      inventoryModel("x-ai/grok-4.7", rates(2, 6, 0.5, null)),
      inventoryModel("edge/model", rates(2, 6)),
    ],
    prices,
    items: [orItem("x-ai/grok-4.7", 2.5, 6, 0.5), orItem("edge/model", 2.4, 6)],
    references: [
      { label: "routes.yaml admitted `xai/grok-4.7`", ids: ["xai/grok-4.7"] },
      { label: "roster writer `grok-grok-4-7`", ids: ["grok-4.7", "xai/grok-4.7"] },
    ],
  });
  assert.equal(result.guardFailed, false);
  assert.ok(result.flaggedRepriced.some((flag) => flag.id === "x-ai/grok-4.7"));
  assert.equal(result.flaggedRepriced.some((flag) => flag.id === "edge/model"), false);
  assert.match(result.summary, /## Needs a human\n\n- \*\*Repriced more than 20%:\*\* `x-ai\/grok-4\.7`/);
  assert.match(result.summary, /inputPerMillion 2 → 2\.5 \(\+25%\)/);
  assert.equal(result.summary.indexOf("## Needs a human"), 0);
  const priced = parsePriceCatalog(result.pricesText);
  assert.equal(priced.date, DATE);
  const grok = priced.models.find((model) => model.id === "xai/grok-4.7");
  assert.equal(grok?.tiers[0]?.inputPerMillion, 2.5);
  const edge = priced.models.find((model) => model.id === "openrouter/edge/model");
  assert.equal(edge?.tiers[0]?.inputPerMillion, 2.4);
});

test("float noise and an unchanged catalog do not rewrite the dated fields", () => {
  const prices = priceText([
    { id: "google/gemini-3.8-flash-medium", provider: "google", model: "gemini-3.8-flash-medium", tiers: [rates(0.825, 4.125, 0.0825, 0.0416666666666667)] },
  ]);
  const original = inventoryFile([
    inventoryModel("google/gemini-3.8-flash", rates(0.8250000000000001, 4.125, 0.0825, 0.0416666666666667)),
  ]);
  const result = planModelCatalogRefresh({
    inventory: original.inventory,
    inventoryText: original.text,
    pricesText: prices,
    openRouterItems: [orItem("google/gemini-3.8-flash", 0.8250000000000001, 4.125, 0.0825, 0.0416666666666667)],
    references: [{ label: "routes.yaml admitted `google/gemini-3.8-flash-medium`", ids: ["google/gemini-3.8-flash-medium"] }],
    date: DATE,
  });
  assert.equal(result.changed, false);
  assert.equal(result.pricesText, prices);
  assert.equal(result.inventoryText, original.text);
  assert.equal(result.guardFailed, false);
});

test("shared price anchors stay intact and a comment survives a real reprice", () => {
  const bare = [
    "# weekly refresh keeps this note",
    "schema: kxm.prices.v1",
    "date: \"2026-10-17\"",
    "sha256: placeholder",
    "currency: USD",
    "models:",
    "  - id: openrouter/qwen/qwen3.8-flash",
    "    provider: openrouter",
    "    model: qwen/qwen3.8-flash",
    "    tiers:",
    "      - &a3",
    "        inputPerMillion: 0.15",
    "        outputPerMillion: 0.47",
    "        cacheReadPerMillion: 0.016",
    "        cacheWritePerMillion: null",
    "  - id: qwen-token-plan/qwen3.8-flash",
    "    provider: qwen-token-plan",
    "    model: qwen3.8-flash",
    "    tiers:",
    "      - *a3",
    "",
  ].join("\n");
  const parsed = parse(bare) as { sha256?: string; schema: "kxm.prices.v1"; date: string; currency: string; models: unknown[] };
  const { sha256: _ignored, ...rest } = parsed;
  const prices = bare.replace("sha256: placeholder", `sha256: ${hashPriceCatalog(rest as unknown as Omit<PriceCatalog, "sha256">)}`);
  parsePriceCatalog(prices);
  const result = plan({
    models: [inventoryModel("qwen/qwen3.8-flash", rates(0.15, 0.47, 0.016, null))],
    prices,
    items: [orItem("qwen/qwen3.8-flash", 0.2, 0.47, 0.016)],
    references: [{ label: "roster planner `pi-qwen3-8-flash-openrouter`", ids: ["openrouter/qwen/qwen3.8-flash"] }],
  });
  assert.match(result.pricesText, /# weekly refresh keeps this note/);
  assert.match(result.pricesText, /&a3/);
  assert.equal(parsePriceCatalog(result.pricesText).date, DATE);
  const priced = parsePriceCatalog(result.pricesText);
  assert.equal(priced.models.find((model) => model.id === "openrouter/qwen/qwen3.8-flash")?.tiers[0]?.inputPerMillion, 0.2);
  assert.equal(priced.models.find((model) => model.id === "qwen-token-plan/qwen3.8-flash")?.tiers[0]?.inputPerMillion, 0.15);
  assert.ok(result.priceRepriced.some((row) => row.id === "openrouter/qwen/qwen3.8-flash"));
  assert.equal(result.priceRepriced.some((row) => row.id === "qwen-token-plan/qwen3.8-flash"), false);
  assert.match(result.summary, /Repriced more than 20%:.*qwen\/qwen3\.8-flash/);
});

test("a shared anchor that a non-OpenRouter row depends on is not rewritten", () => {
  const bare = [
    "schema: kxm.prices.v1",
    "date: \"2026-10-17\"",
    "sha256: placeholder",
    "currency: USD",
    "models:",
    "  - id: openrouter/z-ai/glm-5.3-flash",
    "    provider: openrouter",
    "    model: z-ai/glm-5.3-flash",
    "    tiers:",
    "      - &a1",
    "        inputPerMillion: 0.15",
    "        outputPerMillion: 0.5",
    "        cacheReadPerMillion: 0.03",
    "        cacheWritePerMillion: null",
    "  - id: zai-coding-cn/glm-5.3-flash",
    "    provider: zai-coding-cn",
    "    model: glm-5.3-flash",
    "    aliases:",
    "      - z-ai/glm-5.3-flash",
    "    tiers:",
    "      - *a1",
    "  - id: zai-coding-cn/glm-5.3",
    "    provider: zai-coding-cn",
    "    model: glm-5.3",
    "    tiers:",
    "      - &plan",
    "        inputPerMillion: 0.079",
    "        outputPerMillion: 4.8",
    "        cacheReadPerMillion: 0.078",
    "        cacheWritePerMillion: null",
    "  - id: openrouter/z-ai/glm-5.3",
    "    provider: openrouter",
    "    model: z-ai/glm-5.3",
    "    tiers:",
    "      - *plan",
    "",
  ].join("\n");
  const parsed = parse(bare) as { sha256?: string; schema: "kxm.prices.v1"; date: string; currency: string; models: unknown[] };
  const { sha256: _ignored, ...rest } = parsed;
  const prices = bare.replace("sha256: placeholder", `sha256: ${hashPriceCatalog(rest as unknown as Omit<PriceCatalog, "sha256">)}`);
  parsePriceCatalog(prices);
  const result = plan({
    models: [
      inventoryModel("z-ai/glm-5.3-flash", rates(0.15, 0.5, 0.03, null)),
      inventoryModel("z-ai/glm-5.3", rates(0.079, 4.8, 0.078, null)),
    ],
    prices,
    items: [
      orItem("z-ai/glm-5.3-flash", 0.047076, 0.12, 0.006),
      orItem("z-ai/glm-5.3", 0.079, 1.4, 0.078),
    ],
  });
  const priced = parsePriceCatalog(result.pricesText);
  const openRouterFlash = priced.models.find((model) => model.id === "openrouter/z-ai/glm-5.3-flash");
  const planFlash = priced.models.find((model) => model.id === "zai-coding-cn/glm-5.3-flash");
  const planFull = priced.models.find((model) => model.id === "zai-coding-cn/glm-5.3");
  const openRouterFull = priced.models.find((model) => model.id === "openrouter/z-ai/glm-5.3");
  assert.equal(openRouterFlash?.tiers[0]?.inputPerMillion, 0.047076);
  assert.equal(openRouterFlash?.tiers[0]?.outputPerMillion, 0.12);
  assert.equal(openRouterFlash?.tiers[0]?.cacheReadPerMillion, 0.006);
  assert.equal(planFlash?.tiers[0]?.inputPerMillion, 0.15);
  assert.equal(planFlash?.tiers[0]?.outputPerMillion, 0.5);
  assert.equal(planFlash?.tiers[0]?.cacheReadPerMillion, 0.03);
  assert.equal(planFull?.tiers[0]?.outputPerMillion, 4.8);
  assert.equal(openRouterFull?.tiers[0]?.outputPerMillion, 1.4);
  assert.match(result.pricesText, /&a1/);
  assert.match(result.pricesText, /&plan/);
  assert.equal(result.priceRepriced.some((row) => row.id === "zai-coding-cn/glm-5.3-flash"), false);
  assert.equal(result.priceRepriced.some((row) => row.id === "zai-coding-cn/glm-5.3"), false);
  assert.ok(result.priceRepriced.some((row) => row.id === "openrouter/z-ai/glm-5.3-flash"));
  assert.ok(result.priceRepriced.some((row) => row.id === "openrouter/z-ai/glm-5.3"));
  const doc = parse(result.pricesText) as { models: Array<{ id: string; tiers: Array<{ inputPerMillion: number; outputPerMillion: number }> }> };
  const anchored = doc.models.find((model) => model.id === "zai-coding-cn/glm-5.3-flash");
  assert.equal(anchored?.tiers[0]?.inputPerMillion, 0.15);
  assert.equal(anchored?.tiers[0]?.outputPerMillion, 0.5);
});

test("non-OpenRouter rows that share an anchor still take one OpenRouter reprice", () => {
  const bare = [
    "schema: kxm.prices.v1",
    "date: \"2026-10-17\"",
    "sha256: placeholder",
    "currency: USD",
    "models:",
    "  - id: google/gemini-3.8-flash-medium",
    "    provider: google",
    "    model: gemini-3.8-flash-medium",
    "    tiers:",
    "      - &a2",
    "        inputPerMillion: 0.825",
    "        outputPerMillion: 4.125",
    "        cacheReadPerMillion: 0.0825",
    "        cacheWritePerMillion: null",
    "  - id: google/gemini-3.8-flash-high",
    "    provider: google",
    "    model: gemini-3.8-flash-high",
    "    tiers:",
    "      - *a2",
    "",
  ].join("\n");
  const parsed = parse(bare) as { sha256?: string; schema: "kxm.prices.v1"; date: string; currency: string; models: unknown[] };
  const { sha256: _ignored, ...rest } = parsed;
  const prices = bare.replace("sha256: placeholder", `sha256: ${hashPriceCatalog(rest as unknown as Omit<PriceCatalog, "sha256">)}`);
  parsePriceCatalog(prices);
  const result = plan({
    models: [inventoryModel("google/gemini-3.8-flash", rates(0.825, 4.125, 0.0825, null))],
    prices,
    items: [orItem("google/gemini-3.8-flash", 1, 5, 0.1)],
  });
  const priced = parsePriceCatalog(result.pricesText);
  assert.equal(priced.models.find((model) => model.id === "google/gemini-3.8-flash-medium")?.tiers[0]?.inputPerMillion, 1);
  assert.equal(priced.models.find((model) => model.id === "google/gemini-3.8-flash-high")?.tiers[0]?.inputPerMillion, 1);
  assert.match(result.pricesText, /&a2/);
  assert.match(result.pricesText, /\*a2/);
  assert.equal(result.priceRepriced.length, 2);
});

test("a different provider's alias is not overwritten from the OpenRouter list price", () => {
  const prices = priceText([
    {
      id: "zai-coding-cn/glm-5.3",
      provider: "zai-coding-cn",
      model: "glm-5.3",
      aliases: ["z-ai/glm-5.3"],
      tiers: [rates(0.079, 4.8, 0.078, null)],
    },
  ]);
  const result = plan({
    models: [inventoryModel("z-ai/glm-5.3", rates(1, 2))],
    prices,
    items: [orItem("z-ai/glm-5.3", 1, 2)],
  });
  assert.equal(result.pricesText, prices);
  assert.equal(result.priceRepriced.length, 0);
});

test("a tiered referenced price that moves more than 20 percent is flagged and left unchanged", () => {
  const prices = priceText([
    {
      id: "openai/gpt-6.1-sol",
      provider: "openai",
      model: "gpt-6.1-sol",
      tiers: [
        { ...rates(2, 10, 0.1, 2.5), upToContextTokens: 272000 },
        rates(4, 15, 0.1, 2.5),
      ],
    },
  ]);
  const result = plan({
    models: [inventoryModel("openai/gpt-6.1-sol", rates(2, 10, 0.1, 2.5))],
    prices,
    items: [orItem("openai/gpt-6.1-sol", 3, 12, 0.1, 2.5)],
    references: [{ label: "routes.yaml admitted `openai/gpt-6.1-sol`", ids: ["openai/gpt-6.1-sol"] }],
  });
  assert.equal(result.pricesText, prices);
  assert.equal(result.guardFailed, false);
  assert.equal(result.tieredUnchanged.length, 1);
  assert.match(result.summary, /Tiered price left unchanged:.*openai\/gpt-6\.1-sol/);
});

test("ambiguous alias targets are not rewritten", () => {
  const prices = priceText([
    {
      id: "anthropic/fable",
      provider: "anthropic",
      model: "fable",
      aliases: ["claude-fable-5", "claude-fable-5.1"],
      tiers: [rates(10, 50, 0.25, 12.5)],
    },
  ]);
  const result = plan({
    models: [
      inventoryModel("anthropic/claude-fable-5", rates(10, 50, 0.25, 12.5)),
      inventoryModel("anthropic/claude-fable-5.1", rates(12, 60, 0.25, 12.5)),
    ],
    prices,
    items: [
      orItem("anthropic/claude-fable-5", 10, 50, 0.25, 12.5),
      orItem("anthropic/claude-fable-5.1", 12, 60, 0.25, 12.5),
    ],
    references: [{ label: "routes.yaml admitted `anthropic/fable`", ids: ["anthropic/fable"] }],
  });
  assert.deepEqual(result.ambiguousPrices, ["anthropic/fable"]);
  assert.equal(result.pricesText, prices);
  assert.match(result.summary, /Ambiguous OpenRouter matches left unchanged: 1/);
  const kept = parse(result.inventoryText) as ModelInventory;
  assert.equal(kept.models.some((model) => model.id === "anthropic/claude-fable-5.1"), true);
});

test("long added lists are capped", () => {
  const prices = priceText([
    { id: "openrouter/keep/model", provider: "openrouter", model: "keep/model", tiers: [rates(1, 1)] },
  ]);
  const items = [orItem("keep/model", 1, 1)];
  for (let index = 0; index < 41; index += 1) items.push(orItem(`new/model-${String(index).padStart(2, "0")}`, 1, 1));
  const result = plan({
    models: [inventoryModel("keep/model", rates(1, 1))],
    prices,
    items,
  });
  assert.equal(result.added.length, 41);
  assert.match(result.summary, /Added: 41/);
  assert.match(result.summary, /… and 1 more/);
});

test("an empty OpenRouter payload does not refresh", () => {
  const prices = priceText([
    { id: "openrouter/keep/model", provider: "openrouter", model: "keep/model", tiers: [rates(1, 1)] },
  ]);
  assert.throws(
    () => plan({ models: [inventoryModel("keep/model", rates(1, 1))], prices, items: [] }),
    /OpenRouter catalog is empty/,
  );
});

test("repository routes and rosters name the admitted models and skip the retired coder route", () => {
  const refs = loadCatalogReferences(process.cwd());
  const ids = new Set(refs.flatMap((reference) => reference.ids));
  assert.equal(ids.has("openrouter/qwen/qwen3.7-plus"), true);
  assert.equal(ids.has("xai/grok-4.7"), true);
  assert.equal(ids.has("openrouter/qwen/qwen3-coder-plus"), false);
  assert.ok(refs.some((reference) => reference.label.includes("roster writer")));
});

test("the weekly workflow opens the pull request with the model-refresh GitHub App", () => {
  const text = readFileSync(".github/workflows/refresh-models.yml", "utf8");
  assert.match(text, /cron: "0 13 \* \* 1"/);
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /actions\/create-github-app-token@v3/);
  assert.match(text, /app-id: \$\{\{ secrets\.KXM_REFRESH_APP_ID \}\}/);
  assert.match(text, /private-key: \$\{\{ secrets\.KXM_REFRESH_APP_PRIVATE_KEY \}\}/);
  assert.match(text, /permission-contents: write/);
  assert.match(text, /permission-pull-requests: write/);
  assert.match(text, /repositories: kxm/);
  assert.match(text, /Missing repository secret/);
  assert.match(text, /KXM_REFRESH_APP_ID \(the GitHub App id\)/);
  assert.match(text, /KXM_REFRESH_APP_PRIVATE_KEY \(the App PEM private key\)/);
  assert.match(text, /steps\.app-token\.outputs\.token/);
  assert.match(text, /automation\/model-refresh/);
  assert.match(text, /model-catalog-guard/);
  assert.equal(text.includes("MODELS_TOKEN"), false);
  assert.equal(text.includes("OPENROUTER_API_KEY:"), false);
});

test("the refresh script dry-run writes nothing and reports JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-catalog-refresh-"));
  try {
    const prices = priceText([
      { id: "openrouter/keep/model", provider: "openrouter", model: "keep/model", tiers: [rates(1, 2)] },
    ]);
    const { text } = inventoryFile([inventoryModel("keep/model", rates(1, 2))]);
    const kxm = join(root, ".kxm");
    const modelsDir = join(kxm, "models");
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(join(kxm, "prices.yaml"), prices);
    writeFileSync(join(modelsDir, "inventory.yaml"), text);
    writeFileSync(join(kxm, "routes.yaml"), "schema: kxm.routes.v2\nadmitted:\n  - openrouter/keep/model\ndisabled: []\n");
    const fixture = join(root, "openrouter.json");
    writeFileSync(fixture, JSON.stringify([orItem("keep/model", 1, 4)]));
    const result = spawnSync(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      "scripts/refresh-model-catalog.mjs",
      "--dry-run",
      "--json",
      "--root",
      root,
      "--date",
      DATE,
      "--openrouter-file",
      fixture,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { changed: boolean; dryRun: boolean; priceRepriced: string[] };
    assert.equal(report.dryRun, true);
    assert.equal(report.changed, true);
    assert.deepEqual(report.priceRepriced, ["openrouter/keep/model"]);
    assert.equal(readFileSync(join(kxm, "prices.yaml"), "utf8"), prices);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

#!/usr/bin/env node
// Refresh .kxm/prices.yaml and the OpenRouter slice of .kxm/models/inventory.yaml.
// Usage:
//   node --disable-warning=ExperimentalWarning --experimental-strip-types scripts/refresh-model-catalog.mjs [--dry-run] [--json] [--date YYYY-MM-DD] [--root dir] [--openrouter-file path]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { OPENROUTER_MODELS_URL, loadCatalogReferences, planModelCatalogRefresh, readCatalogFiles } from "../plugins/kxm/src/model-catalog-refresh.ts";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const dryRun = args.includes("--dry-run");
const json = args.includes("--json");
const root = resolve(option("--root") ?? process.cwd());
const date = option("--date") ?? new Date().toISOString().slice(0, 10);
const fixture = option("--openrouter-file");

async function loadOpenRouter() {
  if (fixture) return JSON.parse(readFileSync(resolve(fixture), "utf8"));
  const url = process.env.KXM_OPENROUTER_MODELS_URL?.trim() || OPENROUTER_MODELS_URL;
  const headers = { Accept: "application/json" };
  if (process.env.OPENROUTER_API_KEY?.trim()) headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY.trim()}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`OpenRouter models request failed: HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) {
    throw new Error("OpenRouter models response has no data array");
  }
  return payload.data;
}

const items = await loadOpenRouter();
const catalog = readCatalogFiles(root);
const plan = planModelCatalogRefresh({
  ...catalog,
  openRouterItems: items,
  references: loadCatalogReferences(root),
  date,
  openRouterUrl: process.env.KXM_OPENROUTER_MODELS_URL?.trim() || OPENROUTER_MODELS_URL,
});

if (!dryRun && plan.changed) {
  writeFileSync(resolve(root, ".kxm", "models", "inventory.yaml"), plan.inventoryText);
  writeFileSync(resolve(root, ".kxm", "prices.yaml"), plan.pricesText);
}

const report = {
  ok: !plan.guardFailed,
  changed: plan.changed,
  guardFailed: plan.guardFailed,
  dryRun,
  date,
  added: plan.added,
  removed: plan.removed,
  repriced: plan.repriced.map((row) => row.id),
  priceRepriced: plan.priceRepriced.map((row) => row.id),
  retained: plan.retained.map((row) => row.id),
  flaggedRepriced: plan.flaggedRepriced.map((row) => row.id),
  summary: plan.summary,
};

if (json) console.log(JSON.stringify(report, null, 2));
else console.log(plan.summary);

process.exitCode = plan.guardFailed ? 2 : 0;

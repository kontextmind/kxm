import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { calculateModelCost, findModelPrice, hashPriceCatalog, loadPriceCatalogForEstimate, parsePriceCatalog, type PriceCatalog, type PriceTier } from "../../plugins/kxm/src/prices.ts";

const tier = { upToContextTokens: null, inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 0.2 };
function catalog(tiers: readonly PriceTier[] = [tier]): PriceCatalog {
  const body = { schema: "kxm.prices.v1" as const, date: "2026-09-10", currency: "USD", models: [{ id: "test/model", provider: "test", model: "model", aliases: ["alias"], tiers }] };
  return { ...body, sha256: hashPriceCatalog(body) };
}
const complete = { model: "model", provider: "test", tokensIn: 100, tokensOut: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };

test("price catalogs verify their canonical digest before use", () => {
  assert.deepEqual(parsePriceCatalog(stringify(catalog())), catalog());
  assert.throws(() => parsePriceCatalog(stringify({ ...catalog(), sha256: "0".repeat(64) })), /hash|digest/i);
});

for (const field of ["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"] as const) {
  test(`price catalog rejects invalid ${field}`, () => {
    for (const value of [-1, NaN, Infinity]) {
      assert.throws(() => parsePriceCatalog(stringify(catalog([{ ...tier, [field]: value }]))), /finite|non-negative/i);
    }
  });
}

test("price tier bounds are positive integers and strictly ordered; unbounded is last", () => {
  for (const bounds of [[-1], [1.5], [Infinity], [100, 50], [100, 100], [null, 100]]) {
    assert.throws(() => parsePriceCatalog(stringify(catalog(bounds.map((bound) => ({ ...tier, upToContextTokens: bound }))))), /tier|bound/i);
  }
  assert.throws(() => parsePriceCatalog(stringify({ ...catalog(), currency: "EUR" })), /currency/i);
});

test("price aliases cannot cross provider boundaries", () => {
  assert.equal(findModelPrice(catalog(), "alias", "other"), undefined);
});

test("cost estimates never turn missing usage or context into free tokens or the cheapest tier", () => {
  assert.equal(calculateModelCost(catalog(), { model: "model" }), undefined);
  assert.equal(calculateModelCost(catalog(), { ...complete, cacheWriteTokens: null }), undefined);
  const bounded = catalog([{ ...tier, upToContextTokens: 100 }]);
  assert.equal(calculateModelCost(bounded, complete), undefined);
  assert.equal(calculateModelCost(bounded, { ...complete, contextTokens: 101 }), undefined);
  assert.ok(calculateModelCost(bounded, { ...complete, contextTokens: 99 }));
});

test("list-estimate catalog loads verify digest, drop stale snapshots, and never throw", () => {
  const todayBody = {
    schema: "kxm.prices.v1" as const,
    date: new Date().toISOString().slice(0, 10),
    currency: "USD" as const,
    models: catalog().models,
  };
  const today = { ...todayBody, sha256: hashPriceCatalog(todayBody) };
  const ok = loadPriceCatalogForEstimate({ priceCatalog: today });
  assert.equal(ok.unavailable, false);
  assert.equal(ok.stale, false);
  assert.equal(ok.catalog?.sha256, today.sha256);

  const corrupt = loadPriceCatalogForEstimate({ priceCatalog: { ...today, sha256: "0".repeat(64) } });
  assert.equal(corrupt.unavailable, true);
  assert.equal(corrupt.stale, false);
  assert.equal(corrupt.catalog, undefined);

  const staleBody = { ...todayBody, date: "2020-01-01" };
  const staleCatalog = { ...staleBody, sha256: hashPriceCatalog(staleBody) };
  const stale = loadPriceCatalogForEstimate({ priceCatalog: staleCatalog });
  assert.equal(stale.stale, true);
  assert.equal(stale.unavailable, false);
  assert.equal(stale.catalog, undefined);

  const missingDir = mkdtempSync(join(tmpdir(), "kxm-prices-missing-"));
  try {
    const missing = loadPriceCatalogForEstimate({ projectRoot: missingDir });
    assert.equal(missing.catalog, undefined);
    assert.equal(missing.unavailable, false);
    assert.equal(missing.stale, false);
  } finally {
    rmSync(missingDir, { recursive: true, force: true });
  }

  const corruptDir = mkdtempSync(join(tmpdir(), "kxm-prices-corrupt-"));
  try {
    mkdirSync(join(corruptDir, ".kxm"), { recursive: true });
    writeFileSync(join(corruptDir, ".kxm", "prices.yaml"), stringify({ ...today, sha256: "0".repeat(64) }), "utf8");
    const failed = loadPriceCatalogForEstimate({ projectRoot: corruptDir });
    assert.equal(failed.unavailable, true);
    assert.equal(failed.catalog, undefined);
  } finally {
    rmSync(corruptDir, { recursive: true, force: true });
  }
});

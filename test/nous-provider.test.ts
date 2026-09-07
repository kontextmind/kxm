import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { looksLikeSecret, redactSecrets } from "../plugins/kxm/src/redact.ts";
import {
  NOUS_CATALOG_SCHEMA,
  NOUS_PRICE_UNITS,
  buildModelConfigs,
  catalogHash,
  fetchNousModels,
  guidanceFor,
  isLoopbackUrl,
  parseCatalogPin,
  parseModelsResponse,
  parseNousEnv,
  sanitizeNousText,
  type NousCatalogPin,
} from "../plugins/kxm/src/nous-provider.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "nous");

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
}

test("parseNousEnv is unset when empty and fails closed on unknown tokens", () => {
  assert.equal(parseNousEnv({}).status, "unset");
  assert.equal(parseNousEnv({ KXM_NOUS_PROVIDERS: "  " }).status, "unset");
  const invalid = parseNousEnv({ KXM_NOUS_PROVIDERS: "direct,nous,proxy" });
  assert.equal(invalid.status, "invalid");
  if (invalid.status === "invalid") {
    assert.deepEqual(invalid.unknownTokens, ["nous"]);
    assert.match(invalid.error, /unknown/);
  }
  const ready = parseNousEnv({ KXM_NOUS_PROVIDERS: "proxy,direct,direct" });
  assert.equal(ready.status, "ready");
  if (ready.status === "ready") {
    assert.deepEqual(ready.providers, ["proxy", "direct"]);
    assert.equal(ready.timeoutMs, 5000);
    assert.equal(ready.proxyUrl, "http://127.0.0.1:8645/v1");
  }
});

test("loopback URL check requires http(s) and exact loopback hosts", () => {
  assert.equal(isLoopbackUrl("http://127.0.0.1:8645/v1"), true);
  assert.equal(isLoopbackUrl("http://localhost:8645/v1"), true);
  assert.equal(isLoopbackUrl("http://[::1]:8645/v1"), true);
  assert.equal(isLoopbackUrl("https://127.0.0.1/v1"), true);
  assert.equal(isLoopbackUrl("127.0.0.1:8645/v1"), false);
  assert.equal(isLoopbackUrl("http://example.com:8645/v1"), false);
  assert.equal(isLoopbackUrl("http://10.0.0.1:8645/v1"), false);
  assert.equal(isLoopbackUrl("http://127.0.0.2:8645/v1"), false);
  assert.equal(isLoopbackUrl("http://[2001:db8::1]:8645/v1"), false);
  assert.equal(isLoopbackUrl("http://user:pass@127.0.0.1:8645/v1"), false);
});

test("ids-only models without a pin are all unpriced", () => {
  const parsed = parseModelsResponse(readJson("models-ids-only.json"));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const built = buildModelConfigs(parsed.models, undefined, "direct");
  assert.equal(built.registered.length, 0);
  assert.equal(built.skipped.length, parsed.models.length);
  assert.ok(built.skipped.every((item) => item.reason.includes("unpriced")));
});

test("full numeric capacity and verified rates register without a pin", () => {
  const parsed = parseModelsResponse(readJson("models-with-capacity.json"));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const built = buildModelConfigs(parsed.models, undefined, "direct");
  assert.equal(built.registered.length, 1);
  assert.equal(built.registered[0]?.id, "hermes-3");
  assert.equal(built.registered[0]?.billing, "metered");
  assert.equal(built.registered[0]?.cost.input, 0.8);
});

test("string pricing is not guessed into zeros", () => {
  const parsed = parseModelsResponse({
    data: [{
      id: "guess-me",
      contextWindow: 8192,
      maxTokens: 1024,
      units: NOUS_PRICE_UNITS,
      verified: true,
      pricing: { input: "$0.00/M", output: "$0.00/M", cache_input: "$0.00/M", cache_write: "$0.00/M" },
    }],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const built = buildModelConfigs(parsed.models, undefined, "direct");
  assert.equal(built.registered.length, 0);
  assert.match(built.skipped[0]?.reason ?? "", /unpriced/);
});

test("catalog pin supplies capacity and preserves upper-bound plus verified zeros", () => {
  const pinFile = readJson("catalog-pin.json");
  const loaded = parseCatalogPin(pinFile);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const idsOnly = parseModelsResponse(readJson("models-ids-only.json"));
  assert.equal(idsOnly.ok, true);
  if (!idsOnly.ok) return;
  const direct = buildModelConfigs(idsOnly.models, loaded.pin, "direct");
  assert.deepEqual(direct.registered.map((model) => model.id).sort(), ["free-zero", "hermes-3"]);
  assert.ok(direct.skipped.some((item) => item.id === "unknown-unpriced"));
  assert.ok(direct.skipped.some((item) => item.id === "hermes-3-proxy"));
  const zero = direct.registered.find((model) => model.id === "free-zero");
  assert.equal(zero?.verified, true);
  assert.equal(zero?.cost.input, 0);

  const proxy = buildModelConfigs(idsOnly.models, loaded.pin, "proxy");
  assert.equal(proxy.registered.length, 1);
  assert.equal(proxy.registered[0]?.id, "hermes-3-proxy");
  assert.match(proxy.registered[0]?.name ?? "", /subscription proxy, market ref/);
  assert.equal(proxy.registered[0]?.billing, "subscription");
  assert.equal(proxy.registered[0]?.cost.output, 2.4);

  const tiers = parseCatalogPin(readJson("catalog-tiers.json"));
  assert.equal(tiers.ok, true);
  if (!tiers.ok) return;
  const tiered = buildModelConfigs([{ id: "tiered-model" }], tiers.pin, "direct");
  assert.equal(tiered.registered[0]?.priceBasis, "upper-bound");
  assert.equal(tiered.registered[0]?.cost.input, 3);
  assert.equal(tiered.registered[0]?.cost.output, 6);
});

test("malformed, stale, unit-less, and unverified-zero pins fail closed", () => {
  assert.equal(parseCatalogPin({}).ok, false);
  const missingDate = parseCatalogPin({ schema: NOUS_CATALOG_SCHEMA });
  assert.equal(missingDate.ok, false);
  if (!missingDate.ok) assert.match(missingDate.reason, /recordedAt/);
  const base = {
    schema: NOUS_CATALOG_SCHEMA,
    recordedAt: "2026-09-07T00:00:00.000Z",
    source: "test",
    units: NOUS_PRICE_UNITS,
    models: {
      bad: {
        contextWindow: 8,
        maxTokens: 4,
        cost: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 },
        priceBasis: "list",
        billing: "metered",
        verified: true,
      },
    },
  };
  const negative = { ...base, hash: catalogHash(base) };
  assert.equal(parseCatalogPin(negative).ok, false);

  const unverifiedZeroModels = {
    ...base,
    models: {
      bad: {
        contextWindow: 8,
        maxTokens: 4,
        cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
        priceBasis: "list",
        billing: "metered",
        verified: false,
      },
    },
  };
  assert.equal(parseCatalogPin({ ...unverifiedZeroModels, hash: catalogHash(unverifiedZeroModels) }).ok, false);

  const unitless = { ...base, units: "tokens", models: {} };
  assert.equal(parseCatalogPin({ ...unitless, hash: catalogHash(unitless) }).ok, false);

  const empty = readJson("catalog-empty.json") as NousCatalogPin;
  const stale = parseCatalogPin(empty, Date.parse("2026-11-01T00:00:00.000Z"));
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.reason, /stale/);

  const wrongHash = { ...empty, hash: "sha256:" + "ab".repeat(32) };
  assert.equal(parseCatalogPin(wrongHash).ok, false);
});

test("discovery timeout, 401, and connection refused are classified without leaking secrets", async () => {
  const timeout = await fetchNousModels({
    url: "http://127.0.0.1:1/v1/models",
    timeoutMs: 20,
    authorization: "sk-secret-nous-key-value",
    fetchImpl: (_url, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }),
  });
  assert.equal(timeout.ok, false);
  if (!timeout.ok) assert.equal(timeout.error, "timeout");

  const auth = await fetchNousModels({
    url: "http://127.0.0.1:1/v1/models",
    timeoutMs: 50,
    fetchImpl: async () => new Response(JSON.stringify({ error: "Bearer sk-leaked" }), { status: 401 }),
  });
  assert.equal(auth.ok, false);
  if (!auth.ok) {
    assert.equal(auth.error, "auth");
    assert.equal(looksLikeSecret(auth.reason), false);
  }

  const refused = await fetchNousModels({
    url: "http://127.0.0.1:1/v1/models",
    timeoutMs: 50,
    fetchImpl: async () => {
      const error = new Error("connect ECONNREFUSED 127.0.0.1:1");
      (error as { code?: string }).code = "ECONNREFUSED";
      throw error;
    },
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error, "connection-refused");
});

test("guidance names installed Hermes login first and never includes bearers", () => {
  const messages = guidanceFor({
    parsed: parseNousEnv({ KXM_NOUS_PROVIDERS: "direct,proxy" }),
    directHasKey: false,
    proxyUrlInvalid: true,
    proxyDiscovery: { ok: false, error: "connection-refused", reason: "connection refused" },
    catalogError: "catalog hash does not match",
    skipped: [{ id: "x", reason: "unpriced, not registered" }],
  });
  const text = messages.map((item) => item.message).join("\n");
  assert.match(text, /NOUS_API_KEY/);
  assert.doesNotMatch(text, /\/login nous/);
  assert.match(text, /hermes proxy start/);
  assert.match(text, /hermes proxy status/);
  const auth = guidanceFor({
    parsed: parseNousEnv({ KXM_NOUS_PROVIDERS: "proxy" }),
    proxyDiscovery: { ok: false, error: "auth", status: 401, reason: "HTTP 401" },
  });
  assert.match(auth[0]?.message ?? "", /hermes login --provider nous/);
  assert.match(auth[0]?.message ?? "", /hermes setup --portal/);
  for (const item of [...messages, ...auth]) {
    assert.equal(looksLikeSecret(item.message), false);
    assert.equal(redactSecrets(item.message), item.message);
    assert.equal(sanitizeNousText(item.message), item.message);
  }
});

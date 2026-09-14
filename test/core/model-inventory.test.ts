import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
  refreshModelInventory,
  type ModelInventory,
} from "../../plugins/kxm/src/model-inventory.ts";

test("refreshModelInventory parses aggregator feeds and writes valid inventory YAML", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-models-test-"));
  try {
    const mockOpenRouter = {
      data: [
        {
          id: "anthropic/claude-3.7-sonnet",
          name: "Claude 3.7 Sonnet",
          context_length: 200000,
          pricing: {
            prompt: "0.000003",
            completion: "0.000015",
            input_cache_read: "0.0000003",
            input_cache_write: "0.00000375",
          },
          supported_parameters: ["reasoning", "max_tokens"],
        },
        {
          id: "openai/gpt-4o",
          name: "GPT-4o",
          context_length: 128000,
          pricing: {
            prompt: 0.0000025,
            completion: 0.00001,
          },
          supported_parameters: ["tools"],
        },
      ],
    };

    const mockNous = {
      data: [
        {
          id: "anthropic/claude-3.7-sonnet",
          pricing: {
            prompt: "0.000002",
            completion: "0.000010",
          },
        },
      ],
    };

    // Use a custom local mock server or override URLs
    const env = {
      ...process.env,
      KXM_OPENROUTER_MODELS_URL: `data:application/json,${encodeURIComponent(JSON.stringify(mockOpenRouter))}`,
      KXM_NOUS_MODELS_URL: `data:application/json,${encodeURIComponent(JSON.stringify(mockNous))}`,
    };

    const inventory = await refreshModelInventory({
      outputRoot: root,
      env,
      now: new Date("2026-09-14T19:00:00.000Z"),
    });

    assert.equal(inventory.schema, "kxm.model-inventory.v1");
    assert.equal(inventory.currency, "USD");
    assert.equal(inventory.fetchedAt, "2026-09-14T19:00:00.000Z");

    const outputPath = join(root, ".kxm", "models", "inventory.yaml");
    assert.ok(existsSync(outputPath), "inventory.yaml should exist");

    const yamlContent = parse(readFileSync(outputPath, "utf8")) as ModelInventory;
    assert.equal(yamlContent.schema, "kxm.model-inventory.v1");

    const sonnet = inventory.models.find((m) => m.id === "anthropic/claude-3.7-sonnet");
    assert.ok(sonnet, "Sonnet should be present in inventory");
    assert.equal(sonnet?.name, "Claude 3.7 Sonnet");
    assert.equal(sonnet?.contextLength, 200000);
    assert.equal(sonnet?.capabilities.thinking.supported, true);

    // Check pricing converted to per-million
    assert.equal(sonnet?.standard?.inputPerMillion, 3);
    assert.equal(sonnet?.standard?.outputPerMillion, 15);
    assert.equal(sonnet?.standard?.cacheReadPerMillion, 0.3);
    assert.equal(sonnet?.standard?.cacheWritePerMillion, 3.75);

    // Check discount pricing from Nous
    assert.equal(sonnet?.discount?.inputPerMillion, 2);
    assert.equal(sonnet?.discount?.outputPerMillion, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

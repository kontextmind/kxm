import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  DEFAULT_MODES_CONFIG,
  loadModesConfig,
  resolveActiveMode,
  calculatePromptFootprint,
  formatModesExplainReport,
  estimateTokens,
  type ModesConfig,
} from "../../plugins/kxm/src/modes.ts";
import { hashPriceCatalog, type PriceCatalog } from "../../plugins/kxm/src/prices.ts";

describe("KXM Declarative Workflow Modes and Explain", () => {
  it("loads default modes config when no file exists", () => {
    const config = loadModesConfig();
    assert.strictEqual(config.schema, "kxm.modes.v1");
    assert.ok(config.majorModes.coder);
    assert.ok(config.majorModes.planner);
    assert.ok(config.majorModes.auditor);
    assert.ok(config.majorModes.browser);
    assert.ok(config.domains?.git);
    assert.ok(config.domains?.k8s);

    const configEmpty = loadModesConfig("");
    assert.strictEqual(configEmpty.schema, "kxm.modes.v1");
  });

  it("loads and parses custom .kxm/modes.yaml from project root", () => {
    const dir = mkdtempSync(join(tmpdir(), "kxm-modes-test-"));
    try {
      mkdirSync(join(dir, ".kxm"), { recursive: true });
      writeFileSync(
        join(dir, ".kxm", "modes.yaml"),
        `schema: kxm.modes.v1
majorModes:
  custom-coder:
    description: "Specialized coder"
    baseTools: ["read", "write"]
    contextFiles: ["README.md"]
    thinkingLevel: "low"
    model: "test/model-v1"
domains:
  custom-domain:
    tools: ["custom_tool"]
    promptSnippet: "Special domain prompt"
`
      );

      const config = loadModesConfig(dir);
      assert.strictEqual(config.schema, "kxm.modes.v1");
      assert.ok(config.majorModes["custom-coder"]);
      assert.strictEqual(config.majorModes["custom-coder"]?.thinkingLevel, "low");
      assert.ok(config.domains?.["custom-domain"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves active mode with selective tool filtering and domain prompts", () => {
    const resolved = resolveActiveMode(DEFAULT_MODES_CONFIG, "coder", ["git", "database"]);
    assert.strictEqual(resolved.majorMode, "coder");
    assert.ok(resolved.tools.includes("read"));
    assert.ok(resolved.tools.includes("git_status"));
    assert.ok(resolved.tools.includes("sqlite_query"));
    assert.strictEqual(resolved.enabledDomains.length, 2);
    assert.ok(resolved.promptSnippets.length >= 2);
  });

  it("handles malformed modes.yaml and unknown modes gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "kxm-modes-malformed-"));
    try {
      mkdirSync(join(dir, ".kxm"), { recursive: true });
      writeFileSync(join(dir, ".kxm", "modes.yaml"), "invalid: yaml: [unterminated");
      const fallbackConfig = loadModesConfig(dir);
      assert.strictEqual(fallbackConfig.schema, "kxm.modes.v1");
      assert.ok(fallbackConfig.majorModes.coder);

      // Unknown mode resolves to default coder
      const resolved = resolveActiveMode(fallbackConfig, "unknown-mode", ["unknown-domain", "git"]);
      assert.ok(resolved.tools.includes("read"));
      assert.ok(resolved.tools.includes("git_status"));
      assert.strictEqual(resolved.enabledDomains.length, 1);
      assert.strictEqual(resolved.enabledDomains[0], "git");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("calculates prompt footprint with missing context files and custom catalog", () => {
    const resolved = resolveActiveMode(DEFAULT_MODES_CONFIG, "coder", ["git"]);
    const tempDir = mkdtempSync(join(tmpdir(), "kxm-dir-catch-"));
    resolved.contextFiles = ["package.json", "non-existent-file.md", tempDir];
    resolved.model = "claude/fable";

    const customBody = {
      schema: "kxm.prices.v1" as const,
      date: new Date().toISOString().slice(0, 10),
      currency: "USD" as const,
      models: [
        {
          id: "claude/fable",
          provider: "claude",
          model: "fable",
          tiers: [
            {
              inputPerMillion: 3,
              outputPerMillion: 15,
              cacheReadPerMillion: 0.3,
            },
          ],
        },
      ],
    };
    const customCatalog: PriceCatalog = { ...customBody, sha256: hashPriceCatalog(customBody) };

    try {
      const footprint = calculatePromptFootprint(resolved, process.cwd(), customCatalog);
      assert.strictEqual(footprint.model, "claude/fable");
      assert.ok(footprint.totalTokens > 0);
      assert.ok(footprint.projectedCost.inputCostUsd !== null);
      assert.ok(footprint.projectedCost.cacheReadCostUsd !== null);
      assert.ok(footprint.projectedCost.outputCostEstimateUsd !== null);
      assert.strictEqual(footprint.catalogStatus, "verified");
      assert.strictEqual(footprint.catalogReason, "price catalog verified");

      const report = formatModesExplainReport(footprint);
      assert.ok(report.includes("coder"));
      assert.ok(report.includes("git"));
      assert.ok(report.includes("Initial Turn Input Cost:"));
      assert.ok(report.includes("price catalog verified"));
      assert.ok(report.includes(`$${footprint.projectedCost.inputCostUsd!.toFixed(4)}`));
      assert.ok(report.includes(`$${footprint.projectedCost.cacheReadCostUsd!.toFixed(4)}`));
      assert.ok(report.includes(`$${footprint.projectedCost.outputCostEstimateUsd!.toFixed(4)}`));
      assert.ok(!report.includes("unmetered/unknown"));
      assert.ok(!report.includes(customCatalog.sha256));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles empty domains and missing catalog branches", () => {
    const emptyConfig: ModesConfig = {
      schema: "kxm.modes.v1",
      majorModes: {
        custom: {
          baseTools: ["custom"],
        },
      },
    };

    const resolved = resolveActiveMode(emptyConfig, "custom", ["non-existent"]);
    assert.strictEqual(resolved.majorMode, "custom");
    assert.strictEqual(resolved.enabledDomains.length, 0);
    assert.strictEqual(resolved.contextFiles.length, 0);
    assert.strictEqual(resolved.promptSnippets.length, 0);

    // Calculate footprint when no catalog exists
    const missingRoot = "/non/existent/root";
    const footprint = calculatePromptFootprint(resolved, missingRoot);
    assert.strictEqual(footprint.projectedCost.inputCostUsd, null);
    assert.strictEqual(footprint.projectedCost.cacheReadCostUsd, null);
    assert.strictEqual(footprint.projectedCost.outputCostEstimateUsd, null);
    assert.strictEqual(footprint.catalogStatus, "missing");
    assert.strictEqual(footprint.catalogReason, "price catalog missing");

    const report = formatModesExplainReport(footprint);
    assert.ok(report.includes("(none)"));
    assert.ok(report.includes("price catalog missing"));
    assert.ok(!report.includes("unmetered/unknown"));
    assert.ok(!report.includes(missingRoot));
  });

  it("fails closed on corrupt-hash, stale, and missing catalogs", () => {
    const resolved = resolveActiveMode(DEFAULT_MODES_CONFIG, "coder", []);
    resolved.model = "claude/fable";
    const body = {
      schema: "kxm.prices.v1" as const,
      date: new Date().toISOString().slice(0, 10),
      currency: "USD" as const,
      models: [
        {
          id: "claude/fable",
          provider: "claude",
          model: "fable",
          tiers: [{ inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 }],
        },
      ],
    };
    const hashed: PriceCatalog = { ...body, sha256: hashPriceCatalog(body) };

    const badDigest = "0".repeat(64);
    const corrupt = calculatePromptFootprint(resolved, process.cwd(), { ...hashed, sha256: badDigest });
    assert.strictEqual(corrupt.projectedCost.inputCostUsd, null);
    assert.strictEqual(corrupt.projectedCost.cacheReadCostUsd, null);
    assert.strictEqual(corrupt.projectedCost.outputCostEstimateUsd, null);
    assert.strictEqual(corrupt.catalogStatus, "corrupt");
    assert.strictEqual(corrupt.catalogReason, "price catalog corrupt");
    const corruptReport = formatModesExplainReport(corrupt);
    assert.ok(corruptReport.includes("price catalog corrupt"));
    assert.ok(!corruptReport.includes("unmetered/unknown"));
    assert.ok(!corruptReport.includes(badDigest));

    const staleBody = { ...body, date: "2020-01-01" };
    const staleCatalog: PriceCatalog = { ...staleBody, sha256: hashPriceCatalog(staleBody) };
    const stale = calculatePromptFootprint(resolved, process.cwd(), staleCatalog);
    assert.strictEqual(stale.projectedCost.inputCostUsd, null);
    assert.strictEqual(stale.projectedCost.cacheReadCostUsd, null);
    assert.strictEqual(stale.projectedCost.outputCostEstimateUsd, null);
    assert.strictEqual(stale.catalogStatus, "stale");
    assert.strictEqual(stale.catalogReason, "price catalog stale (dated 2020-01-01)");
    const staleReport = formatModesExplainReport(stale);
    assert.ok(staleReport.includes("price catalog stale (dated 2020-01-01)"));
    assert.ok(!staleReport.includes("unmetered/unknown"));
    assert.ok(!staleReport.includes(staleCatalog.sha256));

    const unpriced = calculatePromptFootprint(
      { ...resolved, model: "unknown/unpriced" },
      process.cwd(),
      hashed,
    );
    assert.strictEqual(unpriced.catalogStatus, "verified");
    assert.strictEqual(unpriced.catalogReason, "price catalog verified");
    assert.strictEqual(unpriced.projectedCost.inputCostUsd, null);
    const unpricedReport = formatModesExplainReport(unpriced);
    assert.ok(unpricedReport.includes("price catalog verified"));
    assert.ok(unpricedReport.includes("unmetered/unknown"));
    assert.ok(!unpricedReport.includes(hashed.sha256));

    const missingRoot = "/non/existent/root";
    const missing = calculatePromptFootprint(resolved, missingRoot);
    assert.strictEqual(missing.projectedCost.inputCostUsd, null);
    assert.strictEqual(missing.catalogStatus, "missing");
    assert.strictEqual(missing.catalogReason, "price catalog missing");
    const missingReport = formatModesExplainReport(missing);
    assert.ok(missingReport.includes("price catalog missing"));
    assert.ok(!missingReport.includes("unmetered/unknown"));
    assert.ok(!missingReport.includes(missingRoot));

    const dir = mkdtempSync(join(tmpdir(), "kxm-explain-catalog-"));
    try {
      mkdirSync(join(dir, ".kxm"), { recursive: true });
      writeFileSync(join(dir, ".kxm", "prices.yaml"), stringify({ ...hashed, sha256: badDigest }), "utf8");
      const fromDiskCorrupt = calculatePromptFootprint(resolved, dir);
      assert.strictEqual(fromDiskCorrupt.projectedCost.inputCostUsd, null);
      assert.strictEqual(fromDiskCorrupt.projectedCost.outputCostEstimateUsd, null);
      assert.strictEqual(fromDiskCorrupt.catalogStatus, "corrupt");
      assert.strictEqual(fromDiskCorrupt.catalogReason, "price catalog corrupt");
      const fromDiskCorruptReport = formatModesExplainReport(fromDiskCorrupt);
      assert.ok(fromDiskCorruptReport.includes("price catalog corrupt"));
      assert.ok(!fromDiskCorruptReport.includes(dir));
      assert.ok(!fromDiskCorruptReport.includes("prices.yaml"));
      assert.ok(!fromDiskCorruptReport.includes(badDigest));

      const diskStaleBody = { ...body, date: "2020-01-01" };
      const diskStale: PriceCatalog = { ...diskStaleBody, sha256: hashPriceCatalog(diskStaleBody) };
      writeFileSync(join(dir, ".kxm", "prices.yaml"), stringify(diskStale), "utf8");
      const fromDiskStale = calculatePromptFootprint(resolved, dir);
      assert.strictEqual(fromDiskStale.projectedCost.inputCostUsd, null);
      assert.strictEqual(fromDiskStale.catalogStatus, "stale");
      assert.strictEqual(fromDiskStale.catalogReason, "price catalog stale (dated 2020-01-01)");
      const fromDiskStaleReport = formatModesExplainReport(fromDiskStale);
      assert.ok(fromDiskStaleReport.includes("price catalog stale (dated 2020-01-01)"));
      assert.ok(!fromDiskStaleReport.includes(dir));
      assert.ok(!fromDiskStaleReport.includes(diskStale.sha256));

      const diskVerified: PriceCatalog = { ...hashed };
      writeFileSync(join(dir, ".kxm", "prices.yaml"), stringify(diskVerified), "utf8");
      const fromDiskVerified = calculatePromptFootprint(resolved, dir);
      assert.strictEqual(fromDiskVerified.catalogStatus, "verified");
      assert.strictEqual(fromDiskVerified.catalogReason, "price catalog verified");
      assert.ok(fromDiskVerified.projectedCost.inputCostUsd !== null);
      assert.ok(fromDiskVerified.projectedCost.cacheReadCostUsd !== null);
      assert.ok(fromDiskVerified.projectedCost.outputCostEstimateUsd !== null);
      const fromDiskVerifiedReport = formatModesExplainReport(fromDiskVerified);
      assert.ok(fromDiskVerifiedReport.includes("price catalog verified"));
      assert.ok(fromDiskVerifiedReport.includes(`$${fromDiskVerified.projectedCost.inputCostUsd!.toFixed(4)}`));
      assert.ok(!fromDiskVerifiedReport.includes("unmetered/unknown"));
      assert.ok(!fromDiskVerifiedReport.includes(dir));
      assert.ok(!fromDiskVerifiedReport.includes(diskVerified.sha256));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

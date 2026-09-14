import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MODES_CONFIG,
  loadModesConfig,
  resolveActiveMode,
  calculatePromptFootprint,
  formatModesExplainReport,
  estimateTokens,
  type ModesConfig,
} from "../../plugins/kxm/src/modes.ts";

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

    const customCatalog = {
      schema: "kxm.prices.v1" as const,
      date: "2026-09-14",
      currency: "USD" as const,
      sha256: "mock",
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

    try {
      const footprint = calculatePromptFootprint(resolved, process.cwd(), customCatalog);
      assert.strictEqual(footprint.model, "claude/fable");
      assert.ok(footprint.totalTokens > 0);
      assert.ok(footprint.projectedCost.inputCostUsd !== null);
      assert.ok(footprint.projectedCost.cacheReadCostUsd !== null);
      assert.ok(footprint.projectedCost.outputCostEstimateUsd !== null);

      const report = formatModesExplainReport(footprint);
      assert.ok(report.includes("coder"));
      assert.ok(report.includes("git"));
      assert.ok(report.includes("Initial Turn Input Cost:"));
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
    const footprint = calculatePromptFootprint(resolved, "/non/existent/root");
    assert.strictEqual(footprint.projectedCost.inputCostUsd, null);
    assert.strictEqual(footprint.projectedCost.cacheReadCostUsd, null);
    assert.strictEqual(footprint.projectedCost.outputCostEstimateUsd, null);

    const report = formatModesExplainReport(footprint);
    assert.ok(report.includes("(none)"));
    assert.ok(report.includes("unmetered/unknown"));
  });
});

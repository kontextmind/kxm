/**
 * KXM Declarative Workflow Modes, Domain Isolation, and Pre-Flight Explain
 *
 * Implements major modes (base role + tools + prompt) and stackable domain
 * toolkits to eliminate prompt bloat and calculate pre-flight token costs.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { calculateModelCost, type PriceCatalog, loadPriceCatalogForEstimate } from "./prices.ts";

export interface MajorMode {
  description?: string | undefined;
  baseTools: string[];
  contextFiles?: string[] | undefined;
  thinkingLevel?: "low" | "medium" | "high" | "xhigh" | undefined;
  model?: string | undefined;
}

export interface Domain {
  description?: string | undefined;
  tools: string[];
  contextFiles?: string[] | undefined;
  promptSnippet?: string | undefined;
}

export interface ModesConfig {
  schema: "kxm.modes.v1";
  majorModes: Record<string, MajorMode>;
  domains?: Record<string, Domain> | undefined;
}

export interface ResolvedMode {
  majorMode: string;
  enabledDomains: string[];
  tools: string[];
  contextFiles: string[];
  promptSnippets: string[];
  thinkingLevel?: string | undefined;
  model?: string | undefined;
}

export interface ContextBreakdownItem {
  name: string;
  chars: number;
  estimatedTokens: number;
}

export interface PromptFootprint {
  majorMode: string;
  enabledDomains: string[];
  model: string;
  breakdown: ContextBreakdownItem[];
  totalChars: number;
  totalTokens: number;
  contextWindowRatio: number;
  projectedCost: {
    inputCostUsd: number | null;
    cacheReadCostUsd: number | null;
    outputCostEstimateUsd: number | null;
  };
}

export const DEFAULT_MODES_CONFIG: ModesConfig = Object.freeze({
  schema: "kxm.modes.v1",
  majorModes: {
    coder: {
      description: "First-pass implementation, bug fixing, and test authoring",
      baseTools: ["read", "edit", "write", "bash"],
      contextFiles: ["AGENTS.md"],
      thinkingLevel: "medium" as const,
      model: "grok/grok-4.6",
    },
    planner: {
      description: "High-level architectural planning, scoping, and decomposition",
      baseTools: ["read", "grep", "find"],
      contextFiles: ["plans/implementation-plan.md"],
      thinkingLevel: "high" as const,
      model: "claude/fable",
    },
    auditor: {
      description: "Security, compliance, and code quality verification",
      baseTools: ["read", "grep"],
      contextFiles: ["SECURITY.md"],
      thinkingLevel: "high" as const,
      model: "codex/gpt-5.6-sol",
    },
    browser: {
      description: "Web application exploration, screenshotting, and UI testing",
      baseTools: ["read", "bash"],
      contextFiles: ["docs/browser-automation.md"],
      thinkingLevel: "medium" as const,
      model: "grok/grok-4.6",
    },
  },
  domains: {
    git: {
      description: "Git version control operations",
      tools: ["git_status", "git_diff", "git_commit"],
      promptSnippet: "Follow git branch conventions; never commit directly to main.",
    },
    k8s: {
      description: "Kubernetes cluster inspection and deployment",
      tools: ["kubectl_get", "kubectl_describe"],
      promptSnippet: "Target local dev cluster; verify namespaces before mutating.",
    },
    database: {
      description: "Database queries and schema verification",
      tools: ["sqlite_query", "sqlite_schema"],
      promptSnippet: "Database is SQLite at .kxm/state/kxm.db; use read-only queries.",
    },
    browser: {
      description: "Remote Steel browser sessions and visual testing",
      tools: ["steel_session", "steel_scrape", "steel_screenshot"],
      promptSnippet: "Use Steel on DOKS for browser automation; invoke takeover on MFA.",
    },
  },
});

/**
 * Estimate tokens from character count using standard ~4 chars/token heuristic.
 */
export function estimateTokens(charCount: number): number {
  return Math.ceil(charCount / 3.8);
}

/**
 * Load and validate `.kxm/modes.yaml` from project root or return defaults.
 */
export function loadModesConfig(projectRoot?: string): ModesConfig {
  if (!projectRoot) {
    return DEFAULT_MODES_CONFIG;
  }

  const modesPath = join(projectRoot, ".kxm", "modes.yaml");
  if (!existsSync(modesPath)) {
    return DEFAULT_MODES_CONFIG;
  }

  try {
    const raw = readFileSync(modesPath, "utf8");
    const parsed = parse(raw) as Partial<ModesConfig>;
    if (parsed && parsed.schema === "kxm.modes.v1" && parsed.majorModes) {
      return {
        schema: "kxm.modes.v1",
        majorModes: { ...DEFAULT_MODES_CONFIG.majorModes, ...parsed.majorModes },
        domains: { ...DEFAULT_MODES_CONFIG.domains, ...parsed.domains },
      };
    }
  } catch {
    // Malformed config falls back to default safely
  }

  return DEFAULT_MODES_CONFIG;
}

/**
 * Resolve active tools, context files, and prompt snippets for a major mode and domain set.
 */
export function resolveActiveMode(
  config: ModesConfig,
  majorModeName = "coder",
  domainNames: string[] = []
): ResolvedMode {
  const major = config.majorModes[majorModeName] || config.majorModes["coder"] || DEFAULT_MODES_CONFIG.majorModes["coder"]!;
  const tools = new Set<string>(major.baseTools);
  const contextFiles = new Set<string>(major.contextFiles || []);
  const promptSnippets: string[] = [];

  const enabledDomains: string[] = [];

  if (config.domains) {
    for (const dName of domainNames) {
      const d = config.domains[dName.toLowerCase().trim()];
      if (d) {
        enabledDomains.push(dName.toLowerCase().trim());
        d.tools.forEach((t) => tools.add(t));
        (d.contextFiles || []).forEach((f) => contextFiles.add(f));
        if (d.promptSnippet) {
          promptSnippets.push(d.promptSnippet);
        }
      }
    }
  }

  return {
    majorMode: majorModeName,
    enabledDomains,
    tools: Array.from(tools),
    contextFiles: Array.from(contextFiles),
    promptSnippets,
    thinkingLevel: major.thinkingLevel,
    model: major.model || "grok/grok-4.6",
  };
}

/**
 * Calculate the exact prompt token footprint and projected costs for a mode configuration.
 */
export function calculatePromptFootprint(
  resolved: ResolvedMode,
  projectRoot: string = process.cwd(),
  catalog?: PriceCatalog
): PromptFootprint {
  const breakdown: ContextBreakdownItem[] = [];

  // 1. Base System Prompt
  const baseSystemPromptChars = 3200; // ~850 tokens base system prompt
  breakdown.push({
    name: `Base System Prompt (${resolved.majorMode})`,
    chars: baseSystemPromptChars,
    estimatedTokens: estimateTokens(baseSystemPromptChars),
  });

  // 2. Context Files
  for (const relPath of resolved.contextFiles) {
    const fullPath = join(projectRoot, relPath);
    let chars = 0;
    if (existsSync(fullPath)) {
      try {
        chars = readFileSync(fullPath, "utf8").length;
      } catch {
        chars = 0;
      }
    }
    if (chars === 0) {
      chars = 1500; // Estimated fallback if missing
    }
    breakdown.push({
      name: `Context File: ${relPath}`,
      chars,
      estimatedTokens: estimateTokens(chars),
    });
  }

  // 3. Domain Prompts
  if (resolved.promptSnippets.length > 0) {
    const snippetChars = resolved.promptSnippets.join("\n").length;
    breakdown.push({
      name: `Domain Prompts (${resolved.enabledDomains.join(", ")})`,
      chars: snippetChars,
      estimatedTokens: estimateTokens(snippetChars),
    });
  }

  // 4. Tool Schemas
  // Each MCP / standard tool schema consumes ~150-200 tokens
  const toolSchemaChars = resolved.tools.length * 650;
  breakdown.push({
    name: `Tool Schemas (${resolved.tools.length} active tools)`,
    chars: toolSchemaChars,
    estimatedTokens: estimateTokens(toolSchemaChars),
  });

  const totalChars = breakdown.reduce((sum, item) => sum + item.chars, 0);
  const totalTokens = breakdown.reduce((sum, item) => sum + item.estimatedTokens, 0);
  const maxContextWindow = 200000;
  const contextWindowRatio = Math.round((totalTokens / maxContextWindow) * 1000) / 10;

  // 5. Projected Costs — unverified or stale catalogs stay unknown.
  const loaded = loadPriceCatalogForEstimate(
    catalog ? { priceCatalog: catalog } : { projectRoot },
  );
  const cat = loaded.catalog;
  const rawModel = resolved.model || "grok/grok-4.6";
  const [prov, mod] = rawModel.includes("/") ? rawModel.split("/", 2) : [undefined, rawModel];

  const inputCost = cat
    ? calculateModelCost(cat, {
        model: mod || rawModel,
        ...(prov !== undefined ? { provider: prov } : {}),
        tokensIn: totalTokens,
        tokensOut: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })
    : undefined;

  const cacheReadCost = cat
    ? calculateModelCost(cat, {
        model: mod || rawModel,
        ...(prov !== undefined ? { provider: prov } : {}),
        tokensIn: 0,
        tokensOut: 0,
        cacheReadTokens: totalTokens,
        cacheWriteTokens: 0,
      })
    : undefined;

  const outputEstimateCost = cat
    ? calculateModelCost(cat, {
        model: mod || rawModel,
        ...(prov !== undefined ? { provider: prov } : {}),
        tokensIn: 0,
        tokensOut: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })
    : undefined;

  return {
    majorMode: resolved.majorMode,
    enabledDomains: resolved.enabledDomains,
    model: resolved.model || "grok/grok-4.6",
    breakdown,
    totalChars,
    totalTokens,
    contextWindowRatio,
    projectedCost: {
      inputCostUsd: inputCost?.costUsd ?? null,
      cacheReadCostUsd: cacheReadCost?.costUsd ?? null,
      outputCostEstimateUsd: outputEstimateCost?.costUsd ?? null,
    },
  };
}

/**
 * Format a human-readable ASCII report for `kxm explain`.
 */
export function formatModesExplainReport(footprint: PromptFootprint): string {
  const divider = "═".repeat(60);
  const subDivider = "─".repeat(60);

  let out = `\n${divider}\n`;
  out += `KXM PRE-FLIGHT CONTEXT EXPLAIN\n`;
  out += `${divider}\n`;
  out += `Major Mode:       ${footprint.majorMode}\n`;
  out += `Enabled Domains:  ${footprint.enabledDomains.length > 0 ? footprint.enabledDomains.join(", ") : "(none)"}\n`;
  out += `Target Model:     ${footprint.model}\n\n`;

  out += `CONTEXT BREAKDOWN:\n`;
  for (const item of footprint.breakdown) {
    const padName = item.name.padEnd(38, " ");
    const tokenStr = `${item.estimatedTokens.toLocaleString()} tokens`.padStart(16, " ");
    out += `  • ${padName} ${tokenStr}\n`;
  }

  out += `${subDivider}\n`;
  const totalPad = `TOTAL PROMPT FOOTPRINT:`.padEnd(38, " ");
  const totalStr = `${footprint.totalTokens.toLocaleString()} tokens`.padStart(16, " ");
  out += `  ${totalPad} ${totalStr} (${footprint.contextWindowRatio}% of 200k window)\n\n`;

  out += `PROJECTED COSTS (per turn):\n`;
  out += `  • Initial Turn Input Cost:   ${footprint.projectedCost.inputCostUsd !== null ? `$${footprint.projectedCost.inputCostUsd.toFixed(4)}` : "unmetered/unknown"}\n`;
  out += `  • Subsequent Cache-Read Cost: ${footprint.projectedCost.cacheReadCostUsd !== null ? `$${footprint.projectedCost.cacheReadCostUsd.toFixed(4)} (approx 90% savings)` : "unmetered/unknown"}\n`;
  out += `  • Output Estimate (1k tokens): ${footprint.projectedCost.outputCostEstimateUsd !== null ? `$${footprint.projectedCost.outputCostEstimateUsd.toFixed(4)}` : "unmetered/unknown"}\n`;
  out += `${divider}\n`;

  return out;
}

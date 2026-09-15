import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LongContextSettings } from "./models.ts";

export interface ClaudeBridgeConfig {
  provider?: {
    strictMcpConfig?: boolean;
    autoMemoryEnabled?: boolean;
    pathToClaudeCodeExecutable?: string;
    plan?: "pro" | "max";
    longContextExtraUsage?: boolean;
  };
}

export function tryParseJson(path: string): Partial<ClaudeBridgeConfig> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Partial<ClaudeBridgeConfig>;
  } catch (error) {
    console.error(`claude-bridge: failed to parse ${path}: ${error}`);
    return {};
  }
}

export function globalConfigPath(home = homedir()): string {
  return join(home, ".pi", "agent", "claude-bridge.json");
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "claude-bridge.json");
}

export function loadConfig(cwd: string, home = homedir()): ClaudeBridgeConfig {
  const global = tryParseJson(globalConfigPath(home));
  const project = tryParseJson(projectConfigPath(cwd));
  return {
    provider: { ...global.provider, ...project.provider },
  };
}

export function longContextFromConfig(config: ClaudeBridgeConfig): LongContextSettings {
  return {
    plan: config.provider?.plan === "max" ? "max" : "pro",
    longContextExtraUsage: Boolean(config.provider?.longContextExtraUsage),
  };
}

export function claudeCodeSettings(provider: ClaudeBridgeConfig["provider"] = {}): {
  autoMemoryEnabled: boolean;
} {
  return { autoMemoryEnabled: provider.autoMemoryEnabled ?? false };
}

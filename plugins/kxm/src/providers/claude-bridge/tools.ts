// @ts-nocheck — vendored snapshot; host tsconfig is stricter than upstream.
import type { Context, Tool } from "./pi-compat.ts";

export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export type McpContent = Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
>;

export interface McpResult {
  content: McpContent;
  isError?: boolean;
  toolCallId?: string;
  [key: string]: unknown;
}

export function pascalCase(name: string): string {
  return name
    .replace(/[-_\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))
    .replace(/^(.)/, (c) => c.toUpperCase());
}

export const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
};

export function sanitizeToolId(id: string, cache: Map<string, string>): string {
  const existing = cache.get(id);
  if (existing) return existing;
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  cache.set(id, clean);
  return clean;
}

export function mapPiToolNameToSdk(name: string, customToolNameToSdk?: Map<string, string>): string {
  if (!name) return "";
  const normalized = name.toLowerCase();
  if (normalized.startsWith(MCP_TOOL_PREFIX)) {
    throw new Error(`mapPiToolNameToSdk: "${name}" is already an SDK tool name — pi history holds pi tool names`);
  }
  if (!customToolNameToSdk) return PI_TO_SDK_TOOL_NAME[normalized] ?? pascalCase(name);
  return customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized) ?? `${MCP_TOOL_PREFIX}${name}`;
}

export function piToolNameFor(name: string, customToolNameToPi: Map<string, string>): string | undefined {
  return customToolNameToPi.get(name) ?? customToolNameToPi.get(name.toLowerCase());
}

const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
  read: { file_path: "path" },
  write: { file_path: "path" },
  edit: {
    file_path: "path",
    old_string: "oldText",
    new_string: "newText",
    old_text: "oldText",
    new_text: "newText",
  },
};

export function mapToolArgs(toolName: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
  const input = args ?? {};
  const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const piKey = renames?.[key] ?? key;
    if (!(piKey in result)) result[piKey] = value;
  }
  if (toolName.toLowerCase() === "bash" && result.timeout == null) {
    result.timeout = 120;
  }
  return result;
}

export function toolResultToMcpContent(
  content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): McpContent {
  if (typeof content === "string") return [{ type: "text", text: content || "" }];
  if (!Array.isArray(content)) return [{ type: "text", text: "" }];
  const blocks: McpContent = [];
  for (const block of content) {
    if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
    else if (block.type === "image" && block.data && block.mimeType) {
      blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
  return blocks.length ? blocks : [{ type: "text", text: "" }];
}

export function extractAllToolResults(
  messages: Array<{ role: string; content?: unknown; toolCallId?: string; isError?: boolean; [key: string]: unknown }>,
): { results: McpResult[]; stopIdx: number } {
  const results: McpResult[] = [];
  let stopIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "toolResult") {
      results.unshift({
        content: toolResultToMcpContent(
          msg.content as string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
        ),
        isError: msg.isError,
        toolCallId: msg.toolCallId,
      });
    } else if (msg.role === "assistant") {
      stopIdx = i;
      break;
    }
  }
  return { results, stopIdx };
}

export function resolveMcpTools(
  context: Context,
  excludeToolName?: string,
): {
  mcpTools: Tool[];
  customToolNameToSdk: Map<string, string>;
  customToolNameToPi: Map<string, string>;
} {
  const mcpTools: Tool[] = [];
  const customToolNameToSdk = new Map<string, string>();
  const customToolNameToPi = new Map<string, string>();
  if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };
  for (const tool of context.tools) {
    if (tool.name === excludeToolName) continue;
    const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
    mcpTools.push(tool);
    customToolNameToSdk.set(tool.name, sdkName);
    customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
    customToolNameToPi.set(sdkName, tool.name);
    customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
  }
  return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

// @ts-nocheck — vendored snapshot; host tsconfig is stricter than upstream.
// In-process MCP server that exposes pi tools to Claude Code.
// From pi-claude-bridge 0.7.0. Not a user-facing MCP product.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpResult } from "./tools.ts";

const TOOL_USE_ID_META = "claudecode/toolUseId";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (toolCallId: string) => Promise<McpResult>;
}

export function assertObjectSchema(tool: McpToolDef): void {
  const schema = tool.inputSchema as Record<string, unknown> | undefined;
  if (!schema || schema.type !== "object") {
    throw new Error(`${tool.name}: MCP tool parameters must be an object schema, got ${JSON.stringify(schema)}`);
  }
}

export function createToolServer(name: string, tools: McpToolDef[]) {
  const server = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const tool of tools) assertObjectSchema(tool);

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
    })),
  }));

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => dispatchToolCall(byName, request));

  return { type: "sdk" as const, name, instance: server };
}

export async function dispatchToolCall(
  byName: Map<string, McpToolDef>,
  request: { params: { name: string; _meta?: Record<string, unknown> } },
) {
  const tool = byName.get(request.params.name);
  if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
  const toolCallId = request.params._meta?.[TOOL_USE_ID_META];
  if (typeof toolCallId !== "string") {
    throw new Error(
      `${tool.name}: tools/call is missing _meta["${TOOL_USE_ID_META}"] — cannot pair the result with its tool call`,
    );
  }
  const { content, isError } = await tool.handler(toolCallId);
  return { content, isError };
}

export { TOOL_USE_ID_META };

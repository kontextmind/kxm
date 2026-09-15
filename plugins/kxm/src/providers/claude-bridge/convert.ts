// @ts-nocheck — vendored snapshot; host tsconfig is stricter than upstream.
import type { ImageContent, Message, TextContent, UserMessage } from "./pi-compat.ts";
import { PROVIDER_ID } from "./models.ts";
import { MCP_TOOL_PREFIX, mapPiToolNameToSdk, sanitizeToolId } from "./tools.ts";

export { PROVIDER_ID };

export function messageContentToText(
  content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  let hasText = false;
  for (const block of content) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
      hasText = true;
    } else if (block.type !== "text" && block.type !== "image") {
      parts.push(`[${block.type}]`);
    }
  }
  return hasText ? parts.join("\n") : "";
}

function toolResultContent(
  content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string | Array<Record<string, unknown>> {
  if (typeof content === "string" || !Array.isArray(content)) return messageContentToText(content) || "";
  const images = content.filter((b) => b.type === "image" && b.data && b.mimeType);
  if (!images.length) return messageContentToText(content) || "";
  const blocks: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
    else if (block.type === "image" && block.data && block.mimeType) {
      blocks.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
    } else if (block.type !== "text" && block.type !== "image") {
      blocks.push({ type: "text", text: `[${block.type}]` });
    }
  }
  return blocks;
}

export type DroppedContent = {
  thinking: number;
  abortedTurns: number;
  providers: Set<string>;
  other: Map<string, number>;
};

export type AnthropicMessage = { role: string; content: unknown };

export function convertPiMessages(
  messages: Message[],
  customToolNameToSdk?: Map<string, string>,
): { anthropicMessages: AnthropicMessage[]; sanitizedIds: Map<string, string>; dropped: DroppedContent } {
  const anthropicMessages: AnthropicMessage[] = [];
  const sanitizedIds = new Map<string, string>();
  const dropped: DroppedContent = { thinking: 0, abortedTurns: 0, providers: new Set(), other: new Map() };
  let turnResults: { role: "user"; content: Array<Record<string, unknown>> } | null = null;
  let turnAssistantIdx: number | null = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        anthropicMessages.push({ role: "user", content: msg.content || "[empty]" });
      } else if (Array.isArray(msg.content)) {
        const parts = [];
        for (const block of msg.content) {
          if (block.type === "text" && block.text) parts.push({ type: "text", text: block.text });
          else if (block.type === "image" && block.data && block.mimeType) {
            parts.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
          }
        }
        anthropicMessages.push({ role: "user", content: parts.length ? parts : "[image]" });
      } else {
        anthropicMessages.push({ role: "user", content: "[empty]" });
      }
    } else if (msg.role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const blocks = [];
      for (const block of content) {
        if (block.type === "text" && block.text) {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
          const sig = block.thinkingSignature;
          if (msg.provider === PROVIDER_ID && sig) {
            blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature: sig });
          } else {
            dropped.thinking++;
            dropped.providers.add(msg.provider ?? "unknown");
          }
        } else if (block.type === "toolCall") {
          const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
          blocks.push({
            type: "tool_use",
            id: sanitizeToolId(block.id, sanitizedIds),
            name: toolName,
            input: block.arguments ?? {},
          });
        } else {
          dropped.other.set(block.type, (dropped.other.get(block.type) ?? 0) + 1);
        }
      }
      if (!content.length) {
        dropped.abortedTurns++;
        continue;
      }
      if (!blocks.length) blocks.push({ type: "text", text: "[incompatible content omitted]" });
      turnResults = null;
      turnAssistantIdx = anthropicMessages.length;
      anthropicMessages.push({ role: "assistant", content: blocks });
    } else if (msg.role === "toolResult") {
      const block = {
        type: "tool_result",
        tool_use_id: sanitizeToolId(msg.toolCallId, sanitizedIds),
        content: toolResultContent(msg.content),
        is_error: msg.isError,
      };
      if (turnResults) {
        turnResults.content.push(block);
      } else {
        turnResults = { role: "user", content: [block] };
        anthropicMessages.splice(turnAssistantIdx === null ? anthropicMessages.length : turnAssistantIdx + 1, 0, turnResults);
      }
    }
  }

  return { anthropicMessages, sanitizedIds, dropped };
}

export function turnStart(messages: Message[]): number {
  let i = messages.length;
  while (i > 0 && messages[i - 1].role === "user") i--;
  return i;
}

export function extractUserPrompt(messages: Message[]): string | null {
  const turn = messages.slice(turnStart(messages)) as UserMessage[];
  if (turn.length === 0) return null;
  return turn
    .map((m) => (typeof m.content === "string" ? m.content : messageContentToText(m.content)))
    .filter((text) => text)
    .join("\n");
}

export function extractUserPromptBlocks(
  messages: Message[],
): Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }> | null {
  const turn = messages.slice(turnStart(messages)) as UserMessage[];
  if (turn.length === 0) return null;
  let hasImage = false;
  const blocks = [];
  for (const message of turn) {
    const content: Array<TextContent | ImageContent> =
      typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (!Array.isArray(content)) {
      throw new Error(
        `extractUserPromptBlocks: user message content must be a string or block array, got ${typeof content}`,
      );
    }
    for (const block of content) {
      if (block.type === "text" && block.text) {
        blocks.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        if (!block.data || !block.mimeType) continue;
        hasImage = true;
        blocks.push({
          type: "image",
          source: { type: "base64" as const, media_type: block.mimeType, data: block.data },
        });
      }
    }
  }
  return hasImage ? blocks : null;
}

export function alreadySdkToolName(name: string): boolean {
  return name.toLowerCase().startsWith(MCP_TOOL_PREFIX);
}

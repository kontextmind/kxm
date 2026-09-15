import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HubClient } from "./client.ts";
import { defaultProjectName } from "./project-name.ts";
import { AGENT_COMMANDS_MAP, enforceToolPolicy, getMcpTools, reconcileInbox } from "./commands.ts";
import { deliverInboxNotification } from "./inbox.ts";
import type { HubEvent, MessageRecord } from "./protocol.ts";

const VERSION = "0.7.1";
const inbox = new Map<string, MessageRecord>();
const notifiedInbox = new Set<string>();
let meshClient: HubClient | undefined;
let starting: Promise<HubClient> | undefined;

const mcp = new Server(
  { name: "kxm", version: VERSION },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      'KXM peer requests can arrive as <channel source="kxm" message_id="..."> events.',
      "Handle the request using normal safety rules, then call kxm_reply with message_id and the final response.",
      "Use kxm_inbox as a fallback when channel delivery is not enabled.",
      "For durable workflow requests, call kxm_workflow_get, record material plans/decisions/contradictions/errors/lessons, and pass every checkpoint before replying.",
      "If work is running in an external system, call kxm_workflow_wait and then kxm_reply so a signed callback can resume the workflow later.",
    ].join(" "),
  },
);

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function onHubEvent(event: HubEvent): Promise<void> {
  if (event.type === "cancelled" || event.type === "expired") {
    inbox.delete(event.message.id);
    notifiedInbox.delete(event.message.id);
    return;
  }
  if (event.type !== "message") return;
  const client = meshClient;
  if (!client) return;
  if (event.message.status === "queued") await client.acknowledge(event.message.id);
  inbox.set(event.message.id, event.message);
  const meta: Record<string, string> = {
    message_id: event.message.id,
    from_agent: event.message.fromName,
    delivery: event.message.delivery,
  };
  if (event.message.correlationId) meta.correlation_id = event.message.correlationId;
  await deliverInboxNotification(event.message.id, notifiedInbox, async () => {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: [
          `Peer request from ${event.message.fromName}:`,
          "",
          event.message.content,
          "",
          `When complete, call kxm_reply with messageId ${event.message.id}.`,
        ].join("\n"),
        meta,
      },
    });
  });
}

async function ensureClient(): Promise<HubClient> {
  if (meshClient?.agent) return meshClient;
  if (starting) return starting;
  starting = (async () => {
    const projectDir = process.env.KXM_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const authToken = optionalString(process.env.KXM_AUTH_TOKEN);
    const candidate = new HubClient({
      serverUrl: process.env.KXM_SERVER_URL?.trim() || "http://127.0.0.1:7331",
      name: process.env.KXM_AGENT_NAME?.trim() || `claude-${process.pid}`,
      purpose: process.env.KXM_AGENT_PURPOSE?.trim() || "Claude Code implementation and review agent",
      project: defaultProjectName(projectDir, process.env),
      model: "claude-code",
      ...(authToken ? { authToken } : {}),
    });
    try {
      await candidate.start(onHubEvent);
      meshClient = candidate;
      return candidate;
    } catch (error) {
      await candidate.stop();
      throw error;
    }
  })();
  try {
    return await starting;
  } finally {
    starting = undefined;
  }
}

const tools = getMcpTools();

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    const policy = enforceToolPolicy(request.params.name);
    if (!policy.allowed) {
      throw new Error(`tool_policy_denied: ${policy.detail ?? policy.error}`);
    }
    const client = await ensureClient();
    const cmd = AGENT_COMMANDS_MAP.get(request.params.name);
    if (!cmd) throw new Error(`unknown tool: ${request.params.name}`);
    const args = asRecord(request.params.arguments);
    const result = await cmd.execute(client, args, { signal: extra.signal, inbox, notifiedInbox });
    return textResult(result);
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
});

await mcp.connect(new StdioServerTransport());

async function shutdown(): Promise<void> {
  await meshClient?.stop();
  await mcp.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

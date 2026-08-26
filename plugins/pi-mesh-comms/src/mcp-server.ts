import { basename } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MeshClient } from "./client.ts";
import type { DeliveryMode, HubEvent, MessageRecord } from "./protocol.ts";
import type { ImprovementArea, JournalCategory, WorkflowCheckpointStatus } from "./workflow.ts";

const VERSION = "0.3.1";
const inbox = new Map<string, MessageRecord>();
let meshClient: MeshClient | undefined;
let starting: Promise<MeshClient> | undefined;

const mcp = new Server(
  { name: "pi-mesh", version: VERSION },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      "Pi mesh peer requests can arrive as <channel source=\"pi-mesh\" message_id=\"...\"> events.",
      "Handle the request using normal safety rules, then call mesh_reply with message_id and the final response.",
      "Use mesh_inbox as a fallback when channel delivery is not enabled.",
      "For durable workflow requests, call mesh_workflow_get, record material plans/decisions/contradictions/errors/lessons, and pass every checkpoint before replying.",
      "If work is running in an external system, call mesh_workflow_wait and then mesh_reply so a signed callback can resume the workflow later.",
    ].join(" "),
  },
);

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function onHubEvent(event: HubEvent): Promise<void> {
  if (event.type !== "message") return;
  const client = meshClient;
  if (!client) return;
  await client.acknowledge(event.message.id);
  inbox.set(event.message.id, event.message);
  const meta: Record<string, string> = {
    message_id: event.message.id,
    from_agent: event.message.fromName,
    delivery: event.message.delivery,
  };
  if (event.message.correlationId) meta.correlation_id = event.message.correlationId;
  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: [
        `Peer request from ${event.message.fromName}:`,
        "",
        event.message.content,
        "",
        `When complete, call mesh_reply with messageId ${event.message.id}.`,
      ].join("\n"),
      meta,
    },
  });
}

async function ensureClient(): Promise<MeshClient> {
  if (meshClient?.agent) return meshClient;
  if (starting) return starting;
  starting = (async () => {
    const projectDir = process.env.PI_MESH_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const authToken = optionalString(process.env.PI_MESH_AUTH_TOKEN);
    const candidate = new MeshClient({
      serverUrl: process.env.PI_MESH_SERVER_URL?.trim() || "http://127.0.0.1:7331",
      name: process.env.PI_MESH_AGENT_NAME?.trim() || `claude-${process.pid}`,
      purpose: process.env.PI_MESH_AGENT_PURPOSE?.trim() || "Claude Code implementation and review agent",
      project: process.env.PI_MESH_PROJECT?.trim() || basename(projectDir),
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

const tools = [
  {
    name: "mesh_list",
    description: "List online peer agents in the current mesh project.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mesh_send",
    description: "Send a focused request to a peer. Returns a message ID for mesh_get or mesh_await.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Peer name or agent ID" },
        content: { type: "string", description: "Focused request and expected result" },
        delivery: { type: "string", enum: ["steer", "followUp", "nextTurn"], default: "followUp" },
        correlationId: { type: "string", description: "Optional workflow or task ID" },
        idempotencyKey: { type: "string", description: "Retry-safe key unique to this request" },
        ttlMs: { type: "number", minimum: 1_000, maximum: 604_800_000 },
      },
      required: ["target", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_get",
    description: "Check the status and optional reply for a previously sent request.",
    inputSchema: {
      type: "object",
      properties: { messageId: { type: "string" } },
      required: ["messageId"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_fanout",
    description: "Ask one through three peers independently and return all replies for comparison and synthesis. In durable workflows, use the run ID as correlationId and a stage-specific idempotencyKeyPrefix.",
    inputSchema: {
      type: "object",
      properties: {
        targets: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
        content: { type: "string" },
        correlationId: { type: "string", description: "Workflow run ID or other stable request scope" },
        idempotencyKeyPrefix: { type: "string", description: "Stable stage-specific retry key prefix" },
        ttlMs: { type: "number", minimum: 1_000, maximum: 604_800_000 },
        timeoutMs: { type: "number", minimum: 100, maximum: 1_800_000 },
      },
      required: ["targets", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_await",
    description: "Wait until a sent request receives a reply or reaches a terminal error.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string" },
        timeoutMs: { type: "number", minimum: 100, maximum: 1_800_000, default: 1_800_000 },
      },
      required: ["messageId"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_cancel",
    description: "Cancel a queued or delivered request sent by this agent.",
    inputSchema: {
      type: "object",
      properties: { messageId: { type: "string" } },
      required: ["messageId"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_inbox",
    description: "List inbound peer requests awaiting a reply. Use when Claude channel delivery is unavailable.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mesh_reply",
    description: "Reply to an inbound peer request using its message ID.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string" },
        content: { type: "string", description: "Final response with evidence and remaining risks" },
      },
      required: ["messageId", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_workflow_list",
    description: "List durable webhook workflows assigned to this agent.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mesh_workflow_get",
    description: "Get one workflow run and its structured journal.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_workflow_checkpoint",
    description: "Checkpoint the active workflow stage; warnings and failures must be retried.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        stageId: { type: "string" },
        status: { type: "string", enum: ["passed", "warning", "failed"] },
        summary: { type: "string" },
        evidence: { type: "array", items: { type: "string" }, maxItems: 32 },
      },
      required: ["runId", "stageId", "status", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_workflow_record",
    description: "Record a plan, decision, contradiction, error, or lesson for continuous improvement.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        category: { type: "string", enum: ["plan", "decision", "contradiction", "error", "lesson"] },
        area: {
          type: "string",
          enum: ["harness", "gates", "implementation", "workflow", "documentation", "security", "other"],
        },
        severity: { type: "string", enum: ["info", "warning", "error"], default: "info" },
        summary: { type: "string" },
        details: { type: "string" },
        evidence: { type: "array", items: { type: "string" }, maxItems: 32 },
        relatedEntryIds: { type: "array", items: { type: "string" }, maxItems: 16 },
      },
      required: ["runId", "category", "area", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_workflow_wait",
    description: "Pause the active stage until a signed external callback checkpoints it and resumes the coordinator.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        stageId: { type: "string" },
        signalKey: { type: "string", description: "Stable callback key, such as github-pr-42-checks" },
        summary: { type: "string", description: "What is running externally and what result is expected" },
        timeoutMs: { type: "number", minimum: 1_000, maximum: 2_592_000_000 },
      },
      required: ["runId", "stageId", "signalKey", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "mesh_improvement_report",
    description: "Summarize workflow errors, contradictions, and lessons by improvement area.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const client = await ensureClient();
    const args = asRecord(request.params.arguments);
    switch (request.params.name) {
      case "mesh_list":
        return textResult({ agents: await client.listAgents() });
      case "mesh_send": {
        const delivery = optionalString(args.delivery) as DeliveryMode | undefined;
        const correlationId = optionalString(args.correlationId);
        const idempotencyKey = optionalString(args.idempotencyKey);
        const message = await client.send({
          target: requiredString(args.target, "target"),
          content: requiredString(args.content, "content"),
          ...(delivery ? { delivery } : {}),
          ...(correlationId ? { correlationId } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(typeof args.ttlMs === "number" ? { ttlMs: args.ttlMs } : {}),
        });
        return textResult({ messageId: message.id, status: message.status, target: message.toName });
      }
      case "mesh_get":
        return textResult(await client.getMessage(requiredString(args.messageId, "messageId")));
      case "mesh_fanout":
        return textResult({ responses: await client.fanout({
          targets: Array.isArray(args.targets) ? args.targets.map((target) => requiredString(target, "target")) : [],
          content: requiredString(args.content, "content"),
          ...(optionalString(args.correlationId) ? { correlationId: optionalString(args.correlationId)! } : {}),
          ...(optionalString(args.idempotencyKeyPrefix) ? {
            idempotencyKeyPrefix: optionalString(args.idempotencyKeyPrefix)!,
          } : {}),
          ...(typeof args.ttlMs === "number" ? { ttlMs: args.ttlMs } : {}),
          ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
        }) });
      case "mesh_await":
        return textResult(await client.awaitResponse(
          requiredString(args.messageId, "messageId"),
          typeof args.timeoutMs === "number" ? args.timeoutMs : 1_800_000,
        ));
      case "mesh_cancel":
        return textResult(await client.cancel(requiredString(args.messageId, "messageId")));
      case "mesh_inbox":
        return textResult({ messages: [...inbox.values()] });
      case "mesh_reply": {
        const messageId = requiredString(args.messageId, "messageId");
        const message = await client.reply(messageId, requiredString(args.content, "content"));
        inbox.delete(messageId);
        return textResult({ messageId, status: message.status, recipient: message.fromName });
      }
      case "mesh_workflow_list":
        return textResult({ runs: await client.listWorkflows() });
      case "mesh_workflow_get":
        return textResult(await client.getWorkflow(requiredString(args.runId, "runId")));
      case "mesh_workflow_checkpoint":
        return textResult(await client.checkpointWorkflow(requiredString(args.runId, "runId"), {
          stageId: requiredString(args.stageId, "stageId"),
          status: requiredString(args.status, "status") as WorkflowCheckpointStatus,
          summary: requiredString(args.summary, "summary"),
          ...(Array.isArray(args.evidence) ? { evidence: args.evidence as string[] } : {}),
        }));
      case "mesh_workflow_wait":
        return textResult(await client.waitForWorkflowSignal(requiredString(args.runId, "runId"), {
          stageId: requiredString(args.stageId, "stageId"),
          signalKey: requiredString(args.signalKey, "signalKey"),
          summary: requiredString(args.summary, "summary"),
          ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
        }));
      case "mesh_workflow_record":
        return textResult(await client.recordWorkflowEntry(requiredString(args.runId, "runId"), {
          category: requiredString(args.category, "category") as JournalCategory,
          area: requiredString(args.area, "area") as ImprovementArea,
          ...(optionalString(args.severity) ? {
            severity: optionalString(args.severity) as "info" | "warning" | "error",
          } : {}),
          summary: requiredString(args.summary, "summary"),
          ...(optionalString(args.details) ? { details: optionalString(args.details)! } : {}),
          ...(Array.isArray(args.evidence) ? { evidence: args.evidence as string[] } : {}),
          ...(Array.isArray(args.relatedEntryIds) ? { relatedEntryIds: args.relatedEntryIds as string[] } : {}),
        }));
      case "mesh_improvement_report":
        return textResult(await client.improvementReport());
      default:
        throw new Error(`unknown tool: ${request.params.name}`);
    }
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

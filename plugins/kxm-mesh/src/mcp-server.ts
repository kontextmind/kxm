import { basename } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MeshClient, MeshHttpError } from "./client.ts";
import { deliverInboxNotification } from "./inbox.ts";
import type { DeliveryMode, HubEvent, MessageRecord, WorkflowMessageContext } from "./protocol.ts";
import type {
  ImprovementArea,
  JournalCategory,
  WorkflowCheckpointStatus,
  WorkflowEvidenceInput,
  WorkflowEvidenceReferenceInput,
} from "./workflow.ts";

const VERSION = "0.5.0";
const inbox = new Map<string, MessageRecord>();
const notifiedInbox = new Set<string>();
let meshClient: MeshClient | undefined;
let starting: Promise<MeshClient> | undefined;

const mcp = new Server(
  { name: "kxm-mesh", version: VERSION },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      "KXM Mesh peer requests can arrive as <channel source=\"kxm-mesh\" message_id=\"...\"> events.",
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

function optionalWorkflowContext(
  value: unknown,
): Omit<WorkflowMessageContext, "schema"> | undefined {
  if (value === undefined) return undefined;
  const context = asRecord(value);
  if (!Number.isInteger(context.attempt) || (context.attempt as number) < 1 || (context.attempt as number) > 20) {
    throw new Error("workflowContext.attempt must be an integer between 1 and 20");
  }
  return {
    runId: requiredString(context.runId, "workflowContext.runId"),
    stageId: requiredString(context.stageId, "workflowContext.stageId"),
    requirementKey: requiredString(context.requirementKey, "workflowContext.requirementKey"),
    attempt: context.attempt as number,
  };
}

function optionalEvidenceRefs(value: unknown): WorkflowEvidenceReferenceInput | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as WorkflowEvidenceReferenceInput
    : undefined;
}

function isTerminalMessageError(error: unknown): boolean {
  return error instanceof MeshHttpError
    && (error.statusCode === 409
      || (error.statusCode === 404 && error.code === "message_not_found"));
}

function isTerminalMessage(message: MessageRecord): boolean {
  return message.status === "replied"
    || message.status === "cancelled"
    || message.status === "expired"
    || message.status === "error";
}

async function reconcileInbox(client: MeshClient): Promise<void> {
  await Promise.all([...inbox.keys()].map(async (messageId) => {
    try {
      const current = await client.getMessage(messageId);
      if (isTerminalMessage(current)) {
        inbox.delete(messageId);
        notifiedInbox.delete(messageId);
      } else inbox.set(messageId, current);
    } catch (error) {
      if (isTerminalMessageError(error)) {
        inbox.delete(messageId);
        notifiedInbox.delete(messageId);
        return;
      }
      throw error;
    }
  }));
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
          `When complete, call mesh_reply with messageId ${event.message.id}.`,
        ].join("\n"),
        meta,
      },
    });
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
    description: "Send a focused request to a peer. Returns a message ID for mesh_get or mesh_await. For durable peer evidence, workflowContext is the hub-authorized provenance scope; correlation and idempotency are transport concerns and do not establish evidence provenance.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Peer name or agent ID" },
        content: { type: "string", description: "Focused request and expected result" },
        delivery: { type: "string", enum: ["steer", "followUp", "nextTurn"], default: "followUp" },
        correlationId: { type: "string", description: "Optional task grouping; the hub binds it to runId when workflowContext is supplied" },
        idempotencyKey: { type: "string", description: "Retry/deduplication key only; not a workflow security or evidence binding" },
        workflowContext: {
          type: "object",
          description: "Requested provenance scope; the hub authorizes and persists the canonical binding",
          properties: {
            runId: { type: "string", description: "Active durable workflow run ID" },
            stageId: { type: "string", description: "Active workflow stage ID" },
            requirementKey: { type: "string", description: "Required evidence identity this peer reply may satisfy" },
            attempt: { type: "integer", minimum: 1, maximum: 20, description: "Current one-based stage attempt" },
          },
          required: ["runId", "stageId", "requirementKey", "attempt"],
          additionalProperties: false,
        },
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
    description: "Ask one through three peers independently and return replies for comparison and synthesis. A local timeout or request cancellation returns a pending response with a durable messageId for mesh_get or an exact retry. For durable peer evidence, supply workflowContext; correlation and idempotency are transport concerns and do not establish evidence provenance.",
    inputSchema: {
      type: "object",
      properties: {
        targets: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
        content: { type: "string" },
        correlationId: { type: "string", description: "Optional task grouping; the hub binds it to runId when workflowContext is supplied" },
        idempotencyKeyPrefix: { type: "string", description: "Stable retry/deduplication prefix only; not a workflow security or evidence binding" },
        workflowContext: {
          type: "object",
          description: "Requested provenance scope shared by each request; the hub authorizes and persists the canonical binding",
          properties: {
            runId: { type: "string", description: "Active durable workflow run ID" },
            stageId: { type: "string", description: "Active workflow stage ID" },
            requirementKey: { type: "string", description: "Required evidence identity these peer replies may satisfy" },
            attempt: { type: "integer", minimum: 1, maximum: 20, description: "Current one-based stage attempt" },
          },
          required: ["runId", "stageId", "requirementKey", "attempt"],
          additionalProperties: false,
        },
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
    description: "Checkpoint the active workflow stage with evidence keyed by required evidence identity. Cite peer-reply requirements through evidenceRefs so the hub can verify provenance and quorum; caller-authored evidence strings cannot satisfy those policies. Warnings and failures must be retried.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        stageId: { type: "string" },
        status: { type: "string", enum: ["passed", "warning", "failed"] },
        summary: { type: "string" },
        evidence: { type: "object", additionalProperties: { type: "string" }, maxProperties: 64 },
        evidenceRefs: {
          type: "object",
          description: "Peer evidence references keyed by required evidence identity; the hub verifies messages and derives producer metadata",
          additionalProperties: {
            type: "object",
            properties: {
              messageIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 },
            },
            required: ["messageIds"],
            additionalProperties: false,
          },
          maxProperties: 32,
        },
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
    description: "Pause the active stage until a signed external callback checkpoints it and resumes the coordinator. Cite peer-reply requirements through evidenceRefs so the hub can verify provenance and quorum; verified evidence is accumulated with callback evidence.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        stageId: { type: "string" },
        signalKey: { type: "string", description: "Stable callback key, such as github-pr-42-checks" },
        summary: { type: "string", description: "What is running externally and what result is expected" },
        evidence: { type: "object", additionalProperties: { type: "string" }, maxProperties: 64 },
        evidenceRefs: {
          type: "object",
          description: "Peer evidence references keyed by required evidence identity; the hub verifies messages and derives producer metadata",
          additionalProperties: {
            type: "object",
            properties: {
              messageIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 },
            },
            required: ["messageIds"],
            additionalProperties: false,
          },
          maxProperties: 32,
        },
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
  {
    name: "kxm_context",
    description: "Normal entry point for KXM context. Assembles a token-budgeted role-aware context packet from durable journal evidence, temporal state, knowledge, episodes, and skills. Superseded and rejected records are excluded. Use KXM context tools instead of provider-specific memory APIs.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project scope (must be the client's project)" },
        role: { type: "string", description: "Requesting role: repro, planner, critic, implementer, verifier, or custom" },
        task: { type: "string", description: "What the role is trying to accomplish" },
        workflowRunId: { type: "string", description: "Workflow run scope" },
        stageId: { type: "string", description: "Workflow stage scope" },
        budgetTokens: { type: "integer", description: "Token budget; defaults to the role policy" },
        includeKinds: { type: "array", items: { type: "string", enum: ["evidence", "state", "episode", "knowledge", "skill"] }, description: "Restrict packet to these item kinds" },
      },
      required: ["project", "role", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "kxm_recall",
    description: "Search durable context records for a project by query; returns bounded metadata only.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        query: { type: "string" },
        kinds: { type: "array", items: { type: "string" } },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "kxm_state",
    description: "Current value for one temporal state key, optionally as of a historical timestamp.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        key: { type: "string" },
        asOf: { type: "string", description: "ISO-8601 timestamp for historical queries" },
      },
      required: ["project", "key"],
      additionalProperties: false,
    },
  },
  {
    name: "kxm_episode",
    description: "Episodic learning from workflow journals: errors, lessons, observations, experiments for a project, optionally scoped to one run.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        workflowRunId: { type: "string" },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "kxm_promote",
    description: "Propose a change to one authoritative state key. Proposing changes nothing: promotion requires durable evidence and an authorized control-plane decision.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        key: { type: "string" },
        summary: { type: "string" },
        authority: { type: "string", enum: ["policy", "instruction", "evidence", "hypothesis"] },
        confidence: { type: "string", enum: ["verified", "probable", "uncertain"] },
        evidenceRefs: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 32 },
      },
      required: ["project", "key", "summary", "authority", "confidence", "evidenceRefs"],
      additionalProperties: false,
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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
        const workflowContext = optionalWorkflowContext(args.workflowContext);
        const message = await client.send({
          target: requiredString(args.target, "target"),
          content: requiredString(args.content, "content"),
          ...(delivery ? { delivery } : {}),
          ...(correlationId ? { correlationId } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(workflowContext ? { workflowContext } : {}),
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
          ...(optionalWorkflowContext(args.workflowContext) ? {
            workflowContext: optionalWorkflowContext(args.workflowContext)!,
          } : {}),
          ...(typeof args.ttlMs === "number" ? { ttlMs: args.ttlMs } : {}),
          ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
          signal: extra.signal,
        }) });
      case "mesh_await":
        return textResult(await client.awaitResponse(
          requiredString(args.messageId, "messageId"),
          typeof args.timeoutMs === "number" ? args.timeoutMs : 1_800_000,
        ));
      case "mesh_cancel":
        return textResult(await client.cancel(requiredString(args.messageId, "messageId")));
      case "mesh_inbox":
        await reconcileInbox(client);
        return textResult({ messages: [...inbox.values()] });
      case "mesh_reply": {
        const messageId = requiredString(args.messageId, "messageId");
        try {
          const message = await client.reply(messageId, requiredString(args.content, "content"));
          inbox.delete(messageId);
          notifiedInbox.delete(messageId);
          return textResult({ messageId, status: message.status, recipient: message.fromName });
        } catch (error) {
          if (isTerminalMessageError(error)) {
            inbox.delete(messageId);
            notifiedInbox.delete(messageId);
          }
          throw error;
        }
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
          ...(args.evidence && typeof args.evidence === "object" && !Array.isArray(args.evidence)
            ? { evidence: args.evidence as WorkflowEvidenceInput }
            : {}),
          ...(optionalEvidenceRefs(args.evidenceRefs) ? { evidenceRefs: optionalEvidenceRefs(args.evidenceRefs)! } : {}),
        }));
      case "mesh_workflow_wait":
        return textResult(await client.waitForWorkflowSignal(requiredString(args.runId, "runId"), {
          stageId: requiredString(args.stageId, "stageId"),
          signalKey: requiredString(args.signalKey, "signalKey"),
          summary: requiredString(args.summary, "summary"),
          ...(args.evidence && typeof args.evidence === "object" && !Array.isArray(args.evidence)
            ? { evidence: args.evidence as WorkflowEvidenceInput }
            : {}),
          ...(optionalEvidenceRefs(args.evidenceRefs) ? { evidenceRefs: optionalEvidenceRefs(args.evidenceRefs)! } : {}),
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
      case "kxm_context":
        return textResult(await client.contextGet(asRecord(args) as unknown as Parameters<MeshClient["contextGet"]>[0]));
      case "kxm_recall":
        return textResult(await client.contextRecall(asRecord(args) as unknown as Parameters<MeshClient["contextRecall"]>[0]));
      case "kxm_state":
        return textResult(await client.contextState(asRecord(args) as unknown as Parameters<MeshClient["contextState"]>[0]));
      case "kxm_episode":
        return textResult(await client.contextEpisode(asRecord(args) as unknown as Parameters<MeshClient["contextEpisode"]>[0]));
      case "kxm_promote":
        return textResult(await client.contextStatePropose(asRecord(args) as unknown as Parameters<MeshClient["contextStatePropose"]>[0]));
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

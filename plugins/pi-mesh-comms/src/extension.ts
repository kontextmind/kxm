import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MeshClient } from "./client.ts";
import type { DeliveryMode, HubEvent, MessageRecord } from "./protocol.ts";
import type { ImprovementArea, JournalCategory, WorkflowCheckpointStatus } from "./workflow.ts";

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function assistantText(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content.trim();
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((item) => {
          const part = item as { type?: string; text?: string };
          return part.type === "text" ? part.text ?? "" : "";
        })
        .join("")
        .trim();
      if (text) return text;
    }
  }
  return undefined;
}

export default function piMeshExtension(pi: ExtensionAPI) {
  let client: MeshClient | undefined;
  let pending: MessageRecord[] = [];
  let awaitingActivation: MessageRecord | undefined;
  let activeInbound: MessageRecord | undefined;
  let activeReply: string | undefined;

  function requireClient(): MeshClient {
    if (!client?.agent) throw new Error("pi-mesh is not connected; check PI_MESH_SERVER_URL and /mesh-status");
    return client;
  }

  function activateNext(): void {
    if (!client || awaitingActivation || activeInbound || pending.length === 0) return;
    const message = pending.shift()!;
    awaitingActivation = message;
    pi.sendMessage({
      customType: "pi-mesh-inbound",
      content: [
        `Peer request from ${message.fromName} (message ${message.id}):`,
        "",
        message.content,
        "",
        "Respond directly to the peer request. Your settled final response will be returned automatically.",
      ].join("\n"),
      display: true,
      details: { messageId: message.id, from: message.fromName },
    }, {
      triggerTurn: message.delivery !== "nextTurn",
      deliverAs: message.delivery,
    });
  }

  async function receive(event: HubEvent): Promise<void> {
    if (event.type === "message") {
      await client?.acknowledge(event.message.id);
      pending.push(event.message);
      activateNext();
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const serverUrl = process.env.PI_MESH_SERVER_URL ?? "http://127.0.0.1:7331";
    const project = process.env.PI_MESH_PROJECT ?? basename(ctx.cwd);
    const name = process.env.PI_MESH_AGENT_NAME ?? pi.getSessionName() ?? `pi-${process.pid}`;
    const purpose = process.env.PI_MESH_AGENT_PURPOSE ?? "General-purpose coding agent";
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    client = new MeshClient({
      serverUrl,
      name,
      purpose,
      project,
      ...(process.env.PI_MESH_AUTH_TOKEN ? { authToken: process.env.PI_MESH_AUTH_TOKEN } : {}),
      ...(model ? { model } : {}),
    });
    try {
      const agent = await client.start(receive);
      ctx.ui.setStatus("pi-mesh", `mesh:${agent.name}`);
      ctx.ui.notify(`Connected to pi-mesh as ${agent.name}`, "info");
    } catch (error) {
      client = undefined;
      ctx.ui.setStatus("pi-mesh", "mesh:offline");
      ctx.ui.notify(`pi-mesh connection failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  pi.on("message_start", (event) => {
    const message = event.message as { customType?: string; details?: { messageId?: string } };
    if (message.customType !== "pi-mesh-inbound" || !awaitingActivation) return;
    if (message.details?.messageId !== awaitingActivation.id) return;
    activeInbound = awaitingActivation;
    awaitingActivation = undefined;
    activeReply = undefined;
  });

  pi.on("agent_end", (event) => {
    if (!activeInbound) return;
    activeReply = assistantText(event.messages as unknown[]) ?? activeReply;
  });

  pi.on("tool_result", async (event) => {
    if (!activeInbound?.correlationId?.startsWith("run_") || !client) return;
    const resultEvent = event as { toolName?: string; toolCallId?: string; isError?: boolean };
    if (!resultEvent.isError) return;
    try {
      await client.recordWorkflowEntry(activeInbound.correlationId, {
        category: "error",
        area: "implementation",
        severity: "error",
        summary: `Tool ${resultEvent.toolName ?? "unknown"} failed during workflow execution`,
        evidence: [
          `tool:${resultEvent.toolName ?? "unknown"}`,
          ...(resultEvent.toolCallId ? [`tool-call:${resultEvent.toolCallId}`] : []),
        ],
      });
    } catch {
      // A workflow may already be terminal or the hub may be reconnecting; agent execution should continue.
    }
  });

  pi.on("agent_settled", async () => {
    if (!activeInbound || !client) return;
    const message = activeInbound;
    const reply = activeReply ?? "The peer agent completed without a textual response.";
    activeInbound = undefined;
    activeReply = undefined;
    try {
      await client.reply(message.id, reply);
    } finally {
      activateNext();
    }
  });

  pi.on("session_shutdown", async () => {
    pending = [];
    awaitingActivation = undefined;
    activeInbound = undefined;
    await client?.stop();
    client = undefined;
  });

  pi.registerTool({
    name: "mesh_list",
    label: "List mesh peers",
    description: "List online peer agents in this project's pi-mesh pool, including their names and purposes.",
    parameters: Type.Object({}),
    async execute() {
      return result({ agents: await requireClient().listAgents() });
    },
  });

  pi.registerTool({
    name: "mesh_send",
    label: "Send peer request",
    description: "Send a focused request to a peer agent. Returns a message ID for mesh_get or mesh_await.",
    parameters: Type.Object({
      target: Type.String({ description: "Peer name or agent ID" }),
      content: Type.String({ description: "Focused request with the expected response or artifact" }),
      delivery: Type.Optional(Type.Union([
        Type.Literal("steer"),
        Type.Literal("followUp"),
        Type.Literal("nextTurn"),
      ], { description: "followUp is the safe default; use steer only for active blockers" })),
      correlationId: Type.Optional(Type.String({ description: "Optional workflow or task ID" })),
      idempotencyKey: Type.Optional(Type.String({ description: "Retry-safe key unique to this request" })),
      ttlMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 604_800_000 })),
    }),
    async execute(_toolCallId, params) {
      const message = await requireClient().send({
        target: params.target,
        content: params.content,
        ...(params.delivery ? { delivery: params.delivery as DeliveryMode } : {}),
        ...(params.correlationId ? { correlationId: params.correlationId } : {}),
        ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
        ...(params.ttlMs ? { ttlMs: params.ttlMs } : {}),
      });
      return result({ messageId: message.id, status: message.status, target: message.toName });
    },
  });

  pi.registerTool({
    name: "mesh_get",
    label: "Get peer response",
    description: "Check a peer request without blocking. Returns its current status and optional reply.",
    parameters: Type.Object({ messageId: Type.String() }),
    async execute(_toolCallId, params) {
      return result(await requireClient().getMessage(params.messageId));
    },
  });

  pi.registerTool({
    name: "mesh_fanout",
    label: "Ask planning panel",
    description: "Send the same independent request to one through three peers and return all replies for comparison and synthesis.",
    parameters: Type.Object({
      targets: Type.Array(Type.String(), { minItems: 1, maxItems: 3 }),
      content: Type.String(),
      correlationId: Type.Optional(Type.String()),
      idempotencyKeyPrefix: Type.Optional(Type.String()),
      ttlMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 604_800_000 })),
      timeoutMs: Type.Optional(Type.Number({ minimum: 100, maximum: 1_800_000 })),
    }),
    async execute(_toolCallId, params) {
      return result({ responses: await requireClient().fanout({
        targets: params.targets,
        content: params.content,
        ...(params.correlationId ? { correlationId: params.correlationId } : {}),
        ...(params.idempotencyKeyPrefix ? { idempotencyKeyPrefix: params.idempotencyKeyPrefix } : {}),
        ...(params.ttlMs ? { ttlMs: params.ttlMs } : {}),
        ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
      }) });
    },
  });

  pi.registerTool({
    name: "mesh_await",
    label: "Await peer response",
    description: "Wait for a peer request to receive a reply. Prefer mesh_get when useful work can continue meanwhile.",
    parameters: Type.Object({
      messageId: Type.String(),
      timeoutMs: Type.Optional(Type.Number({ minimum: 100, maximum: 1_800_000 })),
    }),
    async execute(_toolCallId, params, signal) {
      return result(await requireClient().awaitResponse(params.messageId, params.timeoutMs, signal));
    },
  });

  pi.registerTool({
    name: "mesh_cancel",
    label: "Cancel peer request",
    description: "Cancel a queued or delivered request that this agent sent.",
    parameters: Type.Object({ messageId: Type.String() }),
    async execute(_toolCallId, params) {
      return result(await requireClient().cancel(params.messageId));
    },
  });

  pi.registerTool({
    name: "mesh_workflow_list",
    label: "List workflow runs",
    description: "List durable webhook workflow runs assigned to this long-lived agent.",
    parameters: Type.Object({}),
    async execute() {
      return result({ runs: await requireClient().listWorkflows() });
    },
  });

  pi.registerTool({
    name: "mesh_workflow_get",
    label: "Get workflow run",
    description: "Get a workflow's stages and journal of plans, decisions, contradictions, errors, and lessons.",
    parameters: Type.Object({ runId: Type.String() }),
    async execute(_toolCallId, params) {
      return result(await requireClient().getWorkflow(params.runId));
    },
  });

  pi.registerTool({
    name: "mesh_workflow_checkpoint",
    label: "Checkpoint workflow stage",
    description: "Record a stage result. Warnings and failures require another attempt until passed or exhausted.",
    parameters: Type.Object({
      runId: Type.String(),
      stageId: Type.String(),
      status: Type.Union([Type.Literal("passed"), Type.Literal("warning"), Type.Literal("failed")]),
      summary: Type.String(),
      evidence: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
    }),
    async execute(_toolCallId, params) {
      return result(await requireClient().checkpointWorkflow(params.runId, {
        stageId: params.stageId,
        status: params.status as WorkflowCheckpointStatus,
        summary: params.summary,
        ...(params.evidence ? { evidence: params.evidence } : {}),
      }));
    },
  });

  pi.registerTool({
    name: "mesh_workflow_record",
    label: "Record workflow knowledge",
    description: "Capture a plan, decision, contradiction, error, or lesson as evidence for workflow improvement.",
    parameters: Type.Object({
      runId: Type.String(),
      category: Type.Union([
        Type.Literal("plan"),
        Type.Literal("decision"),
        Type.Literal("contradiction"),
        Type.Literal("error"),
        Type.Literal("lesson"),
      ]),
      area: Type.Union([
        Type.Literal("harness"),
        Type.Literal("gates"),
        Type.Literal("implementation"),
        Type.Literal("workflow"),
        Type.Literal("documentation"),
        Type.Literal("security"),
        Type.Literal("other"),
      ]),
      severity: Type.Optional(Type.Union([
        Type.Literal("info"),
        Type.Literal("warning"),
        Type.Literal("error"),
      ])),
      summary: Type.String(),
      details: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
      relatedEntryIds: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })),
    }),
    async execute(_toolCallId, params) {
      return result(await requireClient().recordWorkflowEntry(params.runId, {
        category: params.category as JournalCategory,
        area: params.area as ImprovementArea,
        ...(params.severity ? { severity: params.severity as "info" | "warning" | "error" } : {}),
        summary: params.summary,
        ...(params.details ? { details: params.details } : {}),
        ...(params.evidence ? { evidence: params.evidence } : {}),
        ...(params.relatedEntryIds ? { relatedEntryIds: params.relatedEntryIds } : {}),
      }));
    },
  });

  pi.registerTool({
    name: "mesh_improvement_report",
    label: "Review workflow improvements",
    description: "Summarize recorded errors, contradictions, and lessons by improvement area across this project.",
    parameters: Type.Object({}),
    async execute() {
      return result(await requireClient().improvementReport());
    },
  });

  pi.registerCommand("mesh-status", {
    description: "Show pi-mesh connection and peer status",
    handler: async (_args, ctx) => {
      if (!client?.agent) {
        ctx.ui.notify("pi-mesh is offline", "warning");
        return;
      }
      const peers = await client.listAgents();
      ctx.ui.notify(`pi-mesh: ${client.agent.name}; ${peers.length} online agent(s)`, "info");
    },
  });
}

import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MeshClient } from "./client.ts";
import type { DeliveryMode, HubEvent, MessageRecord } from "./protocol.ts";

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
      authToken: process.env.PI_MESH_AUTH_TOKEN,
      name,
      purpose,
      project,
      model,
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
    }),
    async execute(_toolCallId, params) {
      const message = await requireClient().send({
        target: params.target,
        content: params.content,
        delivery: params.delivery as DeliveryMode | undefined,
        correlationId: params.correlationId,
      });
      return result({ messageId: message.id, status: message.status, target: message.toName });
    },
  });

  pi.registerTool({
    name: "mesh_get",
    label: "Get peer response",
    description: "Check a peer request without blocking. Returns queued, delivered, replied, or error.",
    parameters: Type.Object({ messageId: Type.String() }),
    async execute(_toolCallId, params) {
      return result(await requireClient().getMessage(params.messageId));
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


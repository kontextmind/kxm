import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MeshClient, MeshHttpError } from "./client.ts";
import { areaForTool, classifyFailure, diagnosticEvidence, diagnosticSummary } from "./diagnostics.ts";
import { MAX_CONTENT_CHARS, type DeliveryMode, type HubEvent, type MessageRecord } from "./protocol.ts";
import type { ImprovementArea, JournalCategory, WorkflowCheckpointStatus } from "./workflow.ts";
import { consumeWorkerRecoveryEnvelope } from "./recovery.ts";

const SETTLEMENT_RETRY_BASE_MS = 250;
const SETTLEMENT_RETRY_MAX_MS = 30_000;

function boundedPeerReply(reply: string): string {
  if (reply.length <= MAX_CONTENT_CHARS) return reply;
  const suffix = `\n\n[pi-mesh: response truncated from ${reply.length} characters to fit the message limit; the full output may remain in the replying agent's local session or worker log]`;
  return reply.slice(0, MAX_CONTENT_CHARS - suffix.length) + suffix;
}

function isTerminalMessage(message: MessageRecord): boolean {
  return message.status === "replied"
    || message.status === "cancelled"
    || message.status === "expired"
    || message.status === "error";
}

function isTerminalMessageError(error: unknown): boolean {
  return error instanceof MeshHttpError
    && (error.statusCode === 409
      || (error.statusCode === 404 && error.code === "message_not_found"));
}

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
  let settlementReply: string | undefined;
  let activeTurnSettled = false;
  let settlementInProgress = false;
  let settlementRetryAttempt = 0;
  let settlementRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let shuttingDown = false;
  let notify: ((message: string, type: "error") => void) | undefined;
  let stateDir = process.env.PI_MESH_STATE_DIR ?? "";
  let agentName = process.env.PI_MESH_AGENT_NAME ?? "";
  let projectName = process.env.PI_MESH_PROJECT ?? "";
  let recoveryStageId: string | undefined;
  let recoveryArtifacts: string[] = [];

  function recoveryContextPath(): string | undefined {
    if (!stateDir || !agentName) return undefined;
    return join(stateDir, `worker-context-${agentName.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  }

  function persistRecoveryContext(): void {
    const path = recoveryContextPath();
    if (!path) return;
    const recoveryMessage = [activeInbound, awaitingActivation, ...pending]
      .find((message) => message?.correlationId?.startsWith("run_"));
    const runId = recoveryMessage?.correlationId;
    const pendingMessageIds = [activeInbound?.id, awaitingActivation?.id, ...pending.map((message) => message.id)].filter((id): id is string => Boolean(id)).slice(0, 16);
    if (!runId && pendingMessageIds.length === 0) { rmSync(path, { force: true }); return; }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, agentName, project: projectName, runId: runId ?? null, stageId: recoveryStageId ?? null, pendingMessageIds, artifactPointers: recoveryArtifacts.slice(0, 16), updatedAt: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  }

  async function workflowCall<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (!(error instanceof MeshHttpError)) throw error;
      const assigned = typeof error.extras?.assignedCoordinatorName === "string" ? ` assignedCoordinator=${error.extras.assignedCoordinatorName}` : "";
      const nextAction = typeof error.extras?.nextAction === "string" ? ` nextAction=${error.extras.nextAction}` : "";
      const operationName = typeof error.extras?.operation === "string" ? ` operation=${error.extras.operation}` : "";
      throw new Error(`${error.message} [code=${error.code ?? "http_error"}${operationName}${assigned}${nextAction}]`);
    }
  }

  function requireClient(): MeshClient {
    if (!client?.agent) throw new Error("pi-mesh is not connected; check PI_MESH_SERVER_URL and /mesh-status");
    return client;
  }

  function activateNext(): void {
    if (shuttingDown || !client || awaitingActivation || activeInbound) return;
    let message = pending.shift();
    while (message && (isTerminalMessage(message) || Date.parse(message.expiresAt) <= Date.now())) {
      message = pending.shift();
    }
    if (!message) {
      persistRecoveryContext();
      return;
    }
    awaitingActivation = message;
    persistRecoveryContext();
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
    if (shuttingDown) return;
    if (event.type === "message") {
      if (activeInbound?.id === event.message.id || awaitingActivation?.id === event.message.id) return;
      if (pending.some((message) => message.id === event.message.id)) {
        activateNext();
        return;
      }
      if (isTerminalMessage(event.message) || Date.parse(event.message.expiresAt) <= Date.now()) return;
      if (event.message.status === "queued") {
        try {
          await client?.acknowledge(event.message.id);
        } catch (error) {
          if (isTerminalMessageError(error)) return;
          throw error;
        }
      }
      if (shuttingDown) return;
      pending.push(event.message);
      persistRecoveryContext();
      activateNext();
      return;
    }

    if (event.type !== "cancelled" && event.type !== "expired" && event.type !== "reply") return;
    const messageId = event.message.id;
    const pendingLength = pending.length;
    pending = pending.filter((message) => message.id !== messageId);
    let changed = pending.length !== pendingLength;
    if (awaitingActivation?.id === messageId) {
      awaitingActivation = undefined;
      changed = true;
    }
    if (activeInbound?.id === messageId) {
      activeInbound = event.message;
      changed = true;
    }
    if (!changed) return;
    persistRecoveryContext();
    if (activeInbound?.id === messageId && activeTurnSettled && !settlementInProgress) {
      finishActiveInbound(messageId);
      return;
    }
    activateNext();
  }

  function finishActiveInbound(messageId: string): void {
    if (activeInbound?.id !== messageId) return;
    if (settlementRetryTimer) clearTimeout(settlementRetryTimer);
    settlementRetryTimer = undefined;
    settlementRetryAttempt = 0;
    activeInbound = undefined;
    activeReply = undefined;
    settlementReply = undefined;
    activeTurnSettled = false;
    recoveryStageId = undefined;
    recoveryArtifacts = [];
    persistRecoveryContext();
    if (!shuttingDown) activateNext();
  }

  function scheduleSettlementRetry(messageId: string, error: unknown): void {
    if (shuttingDown || !client || activeInbound?.id !== messageId || settlementRetryTimer) return;
    const delayMs = Math.min(
      SETTLEMENT_RETRY_BASE_MS * (2 ** Math.min(settlementRetryAttempt, 7)),
      SETTLEMENT_RETRY_MAX_MS,
    );
    settlementRetryAttempt += 1;
    persistRecoveryContext();
    notify?.(
      `pi-mesh could not return reply for ${messageId}; recovery state was retained and settlement will retry in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    settlementRetryTimer = setTimeout(() => {
      settlementRetryTimer = undefined;
      void settleActiveInbound(messageId);
    }, delayMs);
    settlementRetryTimer.unref?.();
  }

  async function settleActiveInbound(messageId: string): Promise<void> {
    if (!activeInbound || activeInbound.id !== messageId || !client || settlementInProgress) return;
    settlementInProgress = true;
    const message = activeInbound;
    const activeClient = client;
    const reply = settlementReply
      ?? boundedPeerReply(activeReply ?? "The peer agent completed without a textual response.");
    try {
      let current: MessageRecord;
      try {
        current = await activeClient.getMessage(message.id);
      } catch (error) {
        if (isTerminalMessageError(error)) {
          finishActiveInbound(message.id);
          return;
        }
        throw error;
      }
      if (isTerminalMessage(current)) {
        finishActiveInbound(message.id);
        return;
      }
      await activeClient.reply(message.id, reply);
      finishActiveInbound(message.id);
    } catch (error) {
      if (isTerminalMessageError(error)) {
        finishActiveInbound(message.id);
        return;
      }
      scheduleSettlementRetry(message.id, error);
    } finally {
      settlementInProgress = false;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;
    const serverUrl = process.env.PI_MESH_SERVER_URL ?? "http://127.0.0.1:7331";
    const project = process.env.PI_MESH_PROJECT ?? basename(ctx.cwd);
    const name = process.env.PI_MESH_AGENT_NAME ?? pi.getSessionName() ?? `pi-${process.pid}`;
    agentName = name;
    projectName = project;
    stateDir = process.env.PI_MESH_STATE_DIR ?? stateDir;
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
      notify = (message, type) => ctx.ui.notify(message, type);
      ctx.ui.setStatus("pi-mesh", `mesh:${agent.name}`);
      ctx.ui.notify(`Connected to pi-mesh as ${agent.name}`, "info");
      const recovered = stateDir ? await consumeWorkerRecoveryEnvelope(client, stateDir, agent.name) : undefined;
      if (recovered?.freshSession && recovered.runId) {
        pi.sendMessage({ customType: "pi-mesh-recovery", content: [`Resume durable workflow run ${recovered.runId} after an unresumable Pi session.`, recovered.stageId ? `Last recorded stage: ${recovered.stageId}.` : "Resolve the current stage from mesh_workflow_get.", `Recovery reason: ${recovered.reason}.`, "Call mesh_workflow_get, inspect its journal and stage evidence, then continue the current stage without repeating completed work.", "Record the recovery decision and checkpoint only after the required evidence is satisfied."].join("\n"), display: true, details: { runId: recovered.runId, stageId: recovered.stageId, reason: recovered.reason } }, { triggerTurn: true, deliverAs: "followUp" });
      }
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
    settlementReply = undefined;
    activeTurnSettled = false;
    settlementRetryAttempt = 0;
    recoveryStageId = undefined;
    recoveryArtifacts = [];
    persistRecoveryContext();
  });

  pi.on("agent_end", (event) => {
    if (!activeInbound || activeTurnSettled) return;
    activeReply = assistantText(event.messages as unknown[]) ?? activeReply;
  });

  pi.on("tool_result", async (event) => {
    if (!activeInbound?.correlationId?.startsWith("run_") || !client) return;
    const resultEvent = event as {
      toolName?: string;
      toolCallId?: string;
      isError?: boolean;
      text?: string;
      error?: string;
      code?: string;
      statusCode?: number;
      details?: unknown;
    };
    const serializedDetails = JSON.stringify(resultEvent.details ?? {});
    const stageMatch = serializedDetails.match(/"(?:currentStage|stageId)"\s*:\s*"([A-Za-z0-9_.-]{1,64})"/);
    if (stageMatch?.[1]) recoveryStageId = stageMatch[1];
    recoveryArtifacts = [...new Set([...recoveryArtifacts, ...(serializedDetails.match(/(?:artifact:|\.kxm[\\/]assets[\\/])[A-Za-z0-9_./\\:-]{1,240}/g) ?? [])])].slice(0, 16);
    persistRecoveryContext();
    if (!resultEvent.isError) return;
    const diagnostic = classifyFailure({
      ...(resultEvent.toolName ? { toolName: resultEvent.toolName } : {}),
      ...((resultEvent.error ?? resultEvent.text) ? { message: resultEvent.error ?? resultEvent.text } : {}),
      ...(resultEvent.code ? { code: resultEvent.code } : {}),
      ...(resultEvent.statusCode !== undefined ? { statusCode: resultEvent.statusCode } : {}),
    });
    try {
      await client.recordWorkflowEntry(activeInbound.correlationId, {
        category: "error",
        area: areaForTool(resultEvent.toolName),
        severity: "error",
        summary: diagnosticSummary(diagnostic),
        evidence: diagnosticEvidence(diagnostic, resultEvent.toolCallId),
      });
    } catch {
      // A workflow may already be terminal or the hub may be reconnecting; agent execution should continue.
    }
  });

  pi.on("agent_settled", async () => {
    if (!activeInbound || !client || settlementInProgress) return;
    if (!activeTurnSettled) {
      settlementReply = boundedPeerReply(
        activeReply ?? "The peer agent completed without a textual response.",
      );
    }
    activeTurnSettled = true;
    await settleActiveInbound(activeInbound.id);
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    persistRecoveryContext();
    if (settlementRetryTimer) clearTimeout(settlementRetryTimer);
    settlementRetryTimer = undefined;
    await client?.stop();
    client = undefined;
    notify = undefined;
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
    description: "Send the same independent request to one through three peers and return replies for comparison and synthesis. A local timeout or prompt interruption returns a pending response with a durable messageId for mesh_get or an exact retry. In durable workflows, use the run ID as correlationId and a stage-specific idempotencyKeyPrefix.",
    parameters: Type.Object({
      targets: Type.Array(Type.String(), { minItems: 1, maxItems: 3 }),
      content: Type.String(),
      correlationId: Type.Optional(Type.String({ description: "Workflow run ID or other stable request scope" })),
      idempotencyKeyPrefix: Type.Optional(Type.String({ description: "Stable stage-specific retry key prefix" })),
      ttlMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 604_800_000 })),
      timeoutMs: Type.Optional(Type.Number({ minimum: 100, maximum: 1_800_000 })),
    }),
    async execute(_toolCallId, params, signal) {
      return result({ responses: await requireClient().fanout({
        targets: params.targets,
        content: params.content,
        ...(params.correlationId ? { correlationId: params.correlationId } : {}),
        ...(params.idempotencyKeyPrefix ? { idempotencyKeyPrefix: params.idempotencyKeyPrefix } : {}),
        ...(params.ttlMs ? { ttlMs: params.ttlMs } : {}),
        ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
        ...(signal ? { signal } : {}),
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
      return result({ runs: await workflowCall(() => requireClient().listWorkflows()) });
    },
  });

  pi.registerTool({
    name: "mesh_workflow_get",
    label: "Get workflow run",
    description: "Get a workflow's stages and journal of plans, decisions, contradictions, errors, and lessons.",
    parameters: Type.Object({ runId: Type.String() }),
    async execute(_toolCallId, params) {
      return result(await workflowCall(() => requireClient().getWorkflow(params.runId)));
    },
  });

  pi.registerTool({
    name: "mesh_workflow_checkpoint",
    label: "Checkpoint workflow stage",
    description: "Record a stage result with evidence keyed by the stage's required evidence identities. Unrelated keys do not satisfy requirements. Warnings and failures require another attempt until passed or exhausted.",
    parameters: Type.Object({
      runId: Type.String(),
      stageId: Type.String(),
      status: Type.Union([Type.Literal("passed"), Type.Literal("warning"), Type.Literal("failed")]),
      summary: Type.String(),
      evidence: Type.Optional(Type.Record(Type.String(), Type.String(), { maxProperties: 64 })),
    }),
    async execute(_toolCallId, params) {
      return result(await workflowCall(() => requireClient().checkpointWorkflow(params.runId, {
        stageId: params.stageId,
        status: params.status as WorkflowCheckpointStatus,
        summary: params.summary,
        ...(params.evidence ? { evidence: params.evidence } : {}),
      })));
    },
  });

  pi.registerTool({
    name: "mesh_workflow_wait",
    label: "Wait for workflow signal",
    description: "Pause the active workflow stage until a signed external callback reports its result. Supply already-verified evidence keyed by requirement; it is accumulated with callback evidence. The current agent turn may settle after this succeeds.",
    parameters: Type.Object({
      runId: Type.String(),
      stageId: Type.String(),
      signalKey: Type.String({ description: "Stable callback key, such as github-pr-42-checks" }),
      summary: Type.String({ description: "What is running externally and what result is expected" }),
      evidence: Type.Optional(Type.Record(Type.String(), Type.String(), { maxProperties: 64 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 2_592_000_000 })),
    }),
    async execute(_toolCallId, params) {
      return result(await workflowCall(() => requireClient().waitForWorkflowSignal(params.runId, {
        stageId: params.stageId,
        signalKey: params.signalKey,
        summary: params.summary,
        ...(params.evidence ? { evidence: params.evidence } : {}),
        ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
      })));
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
      return result(await workflowCall(() => requireClient().recordWorkflowEntry(params.runId, {
        category: params.category as JournalCategory,
        area: params.area as ImprovementArea,
        ...(params.severity ? { severity: params.severity as "info" | "warning" | "error" } : {}),
        summary: params.summary,
        ...(params.details ? { details: params.details } : {}),
        ...(params.evidence ? { evidence: params.evidence } : {}),
        ...(params.relatedEntryIds ? { relatedEntryIds: params.relatedEntryIds } : {}),
      })));
    },
  });

  pi.registerTool({
    name: "mesh_improvement_report",
    label: "Review workflow improvements",
    description: "Summarize recorded errors, contradictions, and lessons by improvement area across this project.",
    parameters: Type.Object({}),
    async execute() {
      return result(await workflowCall(() => requireClient().improvementReport()));
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

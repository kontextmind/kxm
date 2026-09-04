import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MeshClient, MeshHttpError } from "./client.ts";
import { areaForTool, classifyFailure, diagnosticEvidence, diagnosticSummary, type Diagnostic } from "./diagnostics.ts";
import { MAX_CONTENT_CHARS, type DeliveryMode, type HubEvent, type MessageRecord } from "./protocol.ts";
import type { ContextItemKind } from "./context.ts";
import type { ImprovementArea, JournalCategory, WorkflowCheckpointStatus } from "./workflow.ts";
import { consumeWorkerRecoveryEnvelope, workerStateKey } from "./recovery.ts";

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

const WORKFLOW_RUN_ID = /^run_[a-f0-9]{32}$/;
const PI_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

type WorkerSessionBinding = { kind: "default" } | { kind: "workflow"; runId: string };

/** Return only hub-authorized workflow affinity. The legacy internal-message
 * fallback supports durable messages created before workflowRunId was added;
 * caller-controlled correlation IDs alone never establish affinity. */
export function workflowRunIdForMessage(message: Pick<MessageRecord, "workflowRunId" | "workflowContext" | "correlationId" | "from">): string | undefined {
  if (message.workflowRunId !== undefined) {
    if (!WORKFLOW_RUN_ID.test(message.workflowRunId)) return undefined;
    if (message.workflowContext?.runId && message.workflowContext.runId !== message.workflowRunId) return undefined;
    return message.workflowRunId;
  }
  if (message.workflowContext?.runId && WORKFLOW_RUN_ID.test(message.workflowContext.runId)) {
    return message.workflowContext.runId;
  }
  if (
    message.correlationId
    && WORKFLOW_RUN_ID.test(message.correlationId)
    && message.from === `workflow:${message.correlationId}`
  ) return message.correlationId;
  return undefined;
}

export function bindingForMessage(message: Pick<MessageRecord, "workflowRunId" | "workflowContext" | "correlationId" | "from">): WorkerSessionBinding {
  const runId = workflowRunIdForMessage(message);
  if (message.workflowRunId !== undefined && !runId) {
    throw new Error("hub workflow affinity is malformed or conflicts with workflow context");
  }
  if (message.workflowContext?.runId && !WORKFLOW_RUN_ID.test(message.workflowContext.runId)) {
    throw new Error("hub workflow context contains a malformed run identity");
  }
  return runId ? { kind: "workflow", runId } : { kind: "default" };
}

function bindingFromEnvironment(): WorkerSessionBinding {
  if (process.env.KXM_WORKER_SESSION_ISOLATION !== "workflow") return { kind: "default" };
  const scope = process.env.KXM_WORKER_SESSION_SCOPE?.trim();
  if (scope === "default") return { kind: "default" };
  if (scope?.startsWith("workflow:")) {
    const runId = scope.slice("workflow:".length);
    if (WORKFLOW_RUN_ID.test(runId)) return { kind: "workflow", runId };
  }
  throw new Error("KXM_WORKER_SESSION_SCOPE must be default or workflow:<canonical-run-id>");
}

function sameBinding(left: WorkerSessionBinding, right: WorkerSessionBinding): boolean {
  return left.kind === right.kind
    && (left.kind === "default" || (right.kind === "workflow" && left.runId === right.runId));
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function latestAssistantMessage(messages: unknown[]): {
  content?: unknown;
  errorMessage?: unknown;
  role?: unknown;
  stopReason?: unknown;
} | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown };
    if (message?.role === "assistant") return messages[index] as ReturnType<typeof latestAssistantMessage>;
  }
  return undefined;
}

function assistantText(messages: unknown[]): string | undefined {
  const message = latestAssistantMessage(messages);
  if (!message) return undefined;
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .map((item) => {
      const part = item as { type?: string; text?: string };
      return part.type === "text" ? part.text ?? "" : "";
    })
    .join("")
    .trim();
  return text || undefined;
}

function assistantFailure(messages: unknown[]): Diagnostic | undefined {
  const message = latestAssistantMessage(messages);
  if (!message || (message.stopReason !== "error" && message.stopReason !== "aborted")) return undefined;
  if (message.stopReason === "aborted") {
    return classifyFailure({
      toolName: "provider",
      message: "cancelled",
    });
  }
  const failureMessage = typeof message.errorMessage === "string" ? message.errorMessage : "provider error";
  const quota = /\b(quota reached|quota exceeded|rate limit(?:ed)?|too many requests|resource exhausted|http 429)\b/i.test(failureMessage);
  return classifyFailure({
    toolName: "provider",
    code: quota ? "provider_quota" : "provider_error",
    message: failureMessage,
  });
}

export default function piMeshExtension(pi: ExtensionAPI) {
  let client: MeshClient | undefined;
  let pending: MessageRecord[] = [];
  let activatingInbound: MessageRecord | undefined;
  let awaitingActivation: MessageRecord | undefined;
  let activeInbound: MessageRecord | undefined;
  let activationInProgress = false;
  let activationPromise: Promise<void> | undefined;
  let activationRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let activationRetryAttempt = 0;
  let activationStartTimer: ReturnType<typeof setTimeout> | undefined;
  let activationStartMessageId: string | undefined;
  let requestWorkerRestart: (() => void) | undefined;
  let activeReply: string | undefined;
  let settlementReply: string | undefined;
  let activeTurnSettled = false;
  let settlementInProgress = false;
  let settlementRetryAttempt = 0;
  let settlementRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let activeFailure: Diagnostic | undefined;
  let activeFailureRecorded = false;
  let shuttingDown = false;
  let notify: ((message: string, type: "error") => void) | undefined;
  let stateDir = process.env.KXM_STATE_DIR ?? "";
  let agentName = process.env.KXM_AGENT_NAME ?? "";
  let projectName = process.env.KXM_PROJECT ?? "";
  let recoveryStageId: string | undefined;
  let recoveryArtifacts: string[] = [];
  let currentPiSessionId: string | undefined;
  let currentSessionBinding: WorkerSessionBinding = { kind: "default" };

  function recoveryContextPath(): string | undefined {
    if (!stateDir || !agentName || !projectName) return undefined;
    return join(stateDir, `worker-context-${workerStateKey(projectName, agentName)}.json`);
  }

  function sessionRouteRequestPath(): string | undefined {
    const workerKey = process.env.KXM_WORKER_IDENTITY_KEY?.trim();
    if (!stateDir || !workerKey) return undefined;
    return join(stateDir, `worker-session-request-${workerKey}.json`);
  }

  function requestSessionRoute(message: MessageRecord, target: WorkerSessionBinding): boolean {
    if (process.env.KXM_WORKER_SESSION_ISOLATION !== "workflow" || sameBinding(currentSessionBinding, target)) {
      return false;
    }
    const path = sessionRouteRequestPath();
    const workerKey = process.env.KXM_WORKER_IDENTITY_KEY?.trim();
    const generation = process.env.KXM_WORKER_GENERATION?.trim();
    const childIncarnation = Number(process.env.KXM_WORKER_CHILD_INCARCATION);
    if (!path || !workerKey || !generation || !Number.isInteger(childIncarnation) || childIncarnation < 1 || !currentPiSessionId || !PI_SESSION_ID.test(currentPiSessionId)) {
      throw new Error("supervised workflow session routing is missing a valid worker generation, child incarnation, or Pi session identity");
    }
    const request = {
      version: 1,
      agentName,
      project: projectName,
      workerKey,
      generation,
      childIncarnation,
      from: currentSessionBinding,
      to: target,
      sourceSessionId: currentPiSessionId,
      messageId: message.id,
      createdAt: new Date().toISOString(),
    };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(request)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
    return true;
  }

  function removeMatchingLegacyRecoveryContext(): void {
    if (!stateDir || !agentName || !projectName) return;
    const legacy = join(stateDir, `worker-context-${agentName.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
    if (legacy === recoveryContextPath()) return;
    try {
      const candidate = JSON.parse(readFileSync(legacy, "utf8")) as { version?: number; agentName?: string; project?: string };
      if (candidate.version === 1 && candidate.agentName === agentName && candidate.project === projectName) {
        rmSync(legacy, { force: true });
      }
    } catch {
      // A missing, malformed, or differently-owned legacy context is not ours.
    }
  }

  function persistRecoveryContext(): void {
    const path = recoveryContextPath();
    if (!path) return;
    // Bind recovery only to work that entered activation in this Pi scope.
    // Merely queued future workflow work must not receive a failure from the
    // current ordinary or sibling-run turn.
    const recoveryMessage = [activeInbound, awaitingActivation, activatingInbound]
      .find((message) => message && workflowRunIdForMessage(message));
    const runId = recoveryMessage ? workflowRunIdForMessage(recoveryMessage) : undefined;
    const activeMessageIds = [activeInbound?.id, awaitingActivation?.id, activatingInbound?.id]
      .filter((id): id is string => Boolean(id)).slice(0, 3);
    const pendingMessageIds = [...activeMessageIds, ...pending.map((message) => message.id)]
      .filter((id, index, values): id is string => Boolean(id) && values.indexOf(id) === index).slice(0, 16);
    if (!runId && pendingMessageIds.length === 0) {
      rmSync(path, { force: true });
      removeMatchingLegacyRecoveryContext();
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, agentName, project: projectName, runId: runId ?? null, stageId: recoveryStageId ?? null, activeMessageIds, pendingMessageIds, artifactPointers: recoveryArtifacts.slice(0, 16), updatedAt: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
    removeMatchingLegacyRecoveryContext();
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
    if (!client?.agent) throw new Error("pi-mesh is not connected; check KXM_SERVER_URL and /mesh-status");
    return client;
  }

  function clearActivationWatchdog(messageId?: string): void {
    if (messageId && activationStartMessageId !== messageId) return;
    if (activationStartTimer) clearTimeout(activationStartTimer);
    activationStartTimer = undefined;
    activationStartMessageId = undefined;
  }

  function startActivationWatchdog(messageId: string): void {
    clearActivationWatchdog();
    if (!process.env.KXM_WORKER_IDENTITY_KEY) return;
    const configured = Number(process.env.KXM_WORKER_ACTIVATION_TIMEOUT_MS?.trim() || 60_000);
    const timeoutMs = Number.isInteger(configured) && configured >= 1_000 && configured <= 600_000
      ? configured
      : 60_000;
    activationStartMessageId = messageId;
    activationStartTimer = setTimeout(() => {
      activationStartTimer = undefined;
      if (shuttingDown || activeInbound || awaitingActivation?.id !== messageId) return;
      notify?.(
        `pi-mesh worker is stuck: delivered message ${messageId} did not start a model turn within ${timeoutMs}ms; requesting supervised restart`,
        "error",
      );
      persistRecoveryContext();
      requestWorkerRestart?.();
    }, timeoutMs);
    activationStartTimer.unref?.();
  }

  function enqueue(message: MessageRecord, front = false): void {
    if (front) {
      pending.unshift(message);
      return;
    }
    const priority = (delivery: DeliveryMode): number => delivery === "steer" ? 0 : delivery === "followUp" ? 1 : 2;
    const messagePriority = priority(message.delivery);
    const firstLowerPriority = pending.findIndex((candidate) => priority(candidate.delivery) > messagePriority);
    if (firstLowerPriority < 0) pending.push(message);
    else pending.splice(firstLowerPriority, 0, message);
  }

  function requestActivation(): void {
    if (activationPromise || shuttingDown) return;
    const task = activateNext();
    activationPromise = task;
    void task.finally(() => {
      if (activationPromise === task) activationPromise = undefined;
      if (
        !shuttingDown
        && !activationRetryTimer
        && !activatingInbound
        && !awaitingActivation
        && !activeInbound
        && pending.length > 0
      ) requestActivation();
    });
  }

  function scheduleActivationRetry(error: unknown): void {
    if (shuttingDown || activationRetryTimer) return;
    const delayMs = Math.min(
      SETTLEMENT_RETRY_BASE_MS * (2 ** Math.min(activationRetryAttempt, 7)),
      SETTLEMENT_RETRY_MAX_MS,
    );
    activationRetryAttempt += 1;
    notify?.(
      `pi-mesh could not activate the next hub message; it remains durable and activation will retry in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    activationRetryTimer = setTimeout(() => {
      activationRetryTimer = undefined;
      requestActivation();
    }, delayMs);
    activationRetryTimer.unref?.();
  }

  async function activateNext(): Promise<void> {
    if (
      shuttingDown
      || !client
      || activationInProgress
      || activationRetryTimer
      || activatingInbound
      || awaitingActivation
      || activeInbound
    ) return;
    activationInProgress = true;
    try {
      let message = pending.shift();
      while (message && (isTerminalMessage(message) || Date.parse(message.expiresAt) <= Date.now())) {
        message = pending.shift();
      }
      if (!message) {
        persistRecoveryContext();
        return;
      }
      try {
        const targetBinding = bindingForMessage(message);
        if (requestSessionRoute(message, targetBinding)) {
          // The hub remains authoritative: do not acknowledge before the
          // destination Pi session is active. The replacement extension will
          // receive this still-queued message after the supervisor swaps the
          // single child process.
          enqueue(message, true);
          persistRecoveryContext();
          shuttingDown = true;
          queueMicrotask(() => requestWorkerRestart?.());
          return;
        }
      } catch (error) {
        enqueue(message, true);
        persistRecoveryContext();
        scheduleActivationRetry(error);
        return;
      }
      activatingInbound = message;
      persistRecoveryContext();
      let acknowledged: MessageRecord;
      try {
        acknowledged = await client.acknowledge(message.id);
      } catch (error) {
        if (isTerminalMessageError(error)) {
          activatingInbound = undefined;
          activationRetryAttempt = 0;
          persistRecoveryContext();
          return;
        }
        if (activatingInbound?.id === message.id) {
          activatingInbound = undefined;
          enqueue(message, true);
          persistRecoveryContext();
        }
        scheduleActivationRetry(error);
        return;
      }
      if (activatingInbound?.id !== message.id || shuttingDown) return;
      activationRetryAttempt = 0;
      activatingInbound = undefined;
      awaitingActivation = acknowledged;
      persistRecoveryContext();
      startActivationWatchdog(acknowledged.id);
      try {
        pi.sendMessage({
          customType: "pi-mesh-inbound",
          content: [
            `Peer request from ${acknowledged.fromName} (message ${acknowledged.id}):`,
            "",
            acknowledged.content,
            "",
            "Respond directly to the peer request. Your settled final response will be returned automatically.",
          ].join("\n"),
          display: true,
          details: { messageId: acknowledged.id, from: acknowledged.fromName },
        }, {
          // Pi's nextTurn mode deliberately waits for a future human prompt. An
          // autonomous worker has no such prompt, so its durable next item is
          // normalized to an immediately-triggered follow-up turn.
          triggerTurn: true,
          deliverAs: acknowledged.delivery === "nextTurn" ? "followUp" : acknowledged.delivery,
        });
      } catch (error) {
        clearActivationWatchdog(acknowledged.id);
        awaitingActivation = undefined;
        enqueue(acknowledged, true);
        persistRecoveryContext();
        scheduleActivationRetry(error);
      }
    } finally {
      activationInProgress = false;
    }
  }

  async function receive(event: HubEvent): Promise<void> {
    if (shuttingDown) return;
    if (event.type === "message") {
      if (
        activeInbound?.id === event.message.id
        || awaitingActivation?.id === event.message.id
        || activatingInbound?.id === event.message.id
      ) return;
      if (pending.some((message) => message.id === event.message.id)) {
        requestActivation();
        return;
      }
      if (isTerminalMessage(event.message) || Date.parse(event.message.expiresAt) <= Date.now()) return;
      if (shuttingDown) return;
      // The hub remains the durable queue. Waiting messages stay queued there;
      // only activateNext acknowledges the single item entering a model turn.
      enqueue(event.message);
      persistRecoveryContext();
      requestActivation();
      return;
    }

    if (event.type !== "cancelled" && event.type !== "expired" && event.type !== "reply") return;
    const messageId = event.message.id;
    const pendingLength = pending.length;
    pending = pending.filter((message) => message.id !== messageId);
    let changed = pending.length !== pendingLength;
    if (activatingInbound?.id === messageId) {
      activatingInbound = undefined;
      changed = true;
    }
    if (awaitingActivation?.id === messageId) {
      clearActivationWatchdog(messageId);
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
    requestActivation();
  }

  function finishActiveInbound(messageId: string): void {
    if (activeInbound?.id !== messageId) return;
    if (settlementRetryTimer) clearTimeout(settlementRetryTimer);
    settlementRetryTimer = undefined;
    settlementRetryAttempt = 0;
    clearActivationWatchdog(messageId);
    activeInbound = undefined;
    activeReply = undefined;
    settlementReply = undefined;
    activeTurnSettled = false;
    activeFailure = undefined;
    activeFailureRecorded = false;
    recoveryStageId = undefined;
    recoveryArtifacts = [];
    persistRecoveryContext();
    if (!shuttingDown) requestActivation();
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
    try {
      currentSessionBinding = bindingFromEnvironment();
    } catch (error) {
      ctx.ui.setStatus("pi-mesh", "mesh:offline");
      ctx.ui.notify(`pi-mesh session routing configuration failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      void ctx.shutdown();
      return;
    }
    currentPiSessionId = ctx.sessionManager?.getSessionId();
    const serverUrl = process.env.KXM_SERVER_URL ?? "http://127.0.0.1:7331";
    const project = process.env.KXM_PROJECT ?? basename(ctx.cwd);
    const name = process.env.KXM_AGENT_NAME ?? pi.getSessionName() ?? `pi-${process.pid}`;
    agentName = name;
    projectName = project;
    stateDir = process.env.KXM_STATE_DIR ?? stateDir;
    removeMatchingLegacyRecoveryContext();
    const purpose = process.env.KXM_AGENT_PURPOSE ?? "General-purpose coding agent";
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    client = new MeshClient({
      serverUrl,
      name,
      purpose,
      project,
      ...(process.env.KXM_AUTH_TOKEN ? { authToken: process.env.KXM_AUTH_TOKEN } : {}),
      ...(model ? { model } : {}),
    });
    notify = (message, type) => ctx.ui.notify(message, type);
    requestWorkerRestart = () => { void ctx.shutdown(); };
    try {
      const agent = await client.start(receive);
      ctx.ui.setStatus("pi-mesh", `mesh:${agent.name}`);
      ctx.ui.notify(`Connected to pi-mesh as ${agent.name}`, "info");
      const recovered = stateDir ? await consumeWorkerRecoveryEnvelope(client, stateDir, agent.name, project) : undefined;
      const recoveryReplayIds = recovered?.activeMessageIds ?? recovered?.pendingMessageIds ?? [];
      const replayCandidates = await Promise.all(recoveryReplayIds.slice(0, 16).map(async (messageId) => {
        try {
          const message = await client!.getMessage(messageId);
          return message.status === "queued" || message.status === "delivered";
        } catch {
          return false;
        }
      }));
      const durableInboundWillReplay = replayCandidates.some(Boolean);
      const recoveryMatchesSession = process.env.KXM_WORKER_SESSION_ISOLATION !== "workflow"
        || (currentSessionBinding.kind === "workflow" && recovered?.runId === currentSessionBinding.runId);
      if (recovered?.freshSession && recovered.runId && !recovered.peerLocal && recoveryMatchesSession && !durableInboundWillReplay) {
        pi.sendMessage({ customType: "pi-mesh-recovery", content: [`Resume durable workflow run ${recovered.runId} after a fresh-session worker recovery.`, recovered.stageId ? `Last recorded stage: ${recovered.stageId}.` : "Resolve the current stage from kxm_workflow_get.", `Recovery reason: ${recovered.reason}.`, "Call kxm_workflow_get, inspect its journal and stage evidence, then continue the current stage without repeating completed work.", "Record the recovery decision and checkpoint only after the required evidence is satisfied."].join("\n"), display: true, details: { runId: recovered.runId, stageId: recovered.stageId, reason: recovered.reason } }, { triggerTurn: true, deliverAs: "followUp" });
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
    clearActivationWatchdog(awaitingActivation.id);
    activeInbound = awaitingActivation;
    awaitingActivation = undefined;
    activeReply = undefined;
    settlementReply = undefined;
    activeTurnSettled = false;
    activeFailure = undefined;
    activeFailureRecorded = false;
    settlementRetryAttempt = 0;
    recoveryStageId = undefined;
    recoveryArtifacts = [];
    persistRecoveryContext();
  });

  pi.on("agent_end", (event) => {
    if (!activeInbound || activeTurnSettled) return;
    const latest = latestAssistantMessage(event.messages as unknown[]);
    if (!latest) return;
    const failure = assistantFailure(event.messages as unknown[]);
    if (failure) {
      activeFailure = failure;
      activeFailureRecorded = false;
      activeReply = undefined;
      persistRecoveryContext();
      return;
    }
    activeFailure = undefined;
    activeFailureRecorded = false;
    activeReply = assistantText(event.messages as unknown[]) ?? activeReply;
  });

  pi.on("tool_result", async (event) => {
    const activeRunId = activeInbound ? workflowRunIdForMessage(activeInbound) : undefined;
    if (!activeRunId || !client) return;
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
      await client.recordWorkflowEntry(activeRunId, {
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
    if (activeFailure) {
      persistRecoveryContext();
      if (!activeFailureRecorded) {
        try {
          const activeRunId = workflowRunIdForMessage(activeInbound);
          if (activeRunId) {
            await client.recordWorkflowEntry(activeRunId, {
              category: "error",
              area: "harness",
              severity: "error",
              summary: diagnosticSummary(activeFailure),
              evidence: diagnosticEvidence(activeFailure),
            });
          }
          activeFailureRecorded = true;
        } catch {
          // Preserve the message and retry metadata journaling after recovery.
        }
      }
      notify?.(
        `pi-mesh retained ${activeInbound.id} after ${activeFailure.class}; switch the model or let the supervised worker recover it`,
        "error",
      );
      return;
    }
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
    clearActivationWatchdog();
    persistRecoveryContext();
    if (activationRetryTimer) clearTimeout(activationRetryTimer);
    activationRetryTimer = undefined;
    activationRetryAttempt = 0;
    await activationPromise?.catch(() => undefined);
    if (settlementRetryTimer) clearTimeout(settlementRetryTimer);
    settlementRetryTimer = undefined;
    await client?.stop();
    client = undefined;
    notify = undefined;
    requestWorkerRestart = undefined;
  });

  pi.registerTool({
    name: "kxm_list",
    label: "List mesh peers",
    description: "List online peer agents in this project's pi-mesh pool, including their names and purposes.",
    parameters: Type.Object({}),
    async execute() {
      return result({ agents: await requireClient().listAgents() });
    },
  });

  pi.registerTool({
    name: "kxm_send",
    label: "Send peer request",
    description: "Send a focused request to a peer agent. Returns a message ID for kxm_get or kxm_await. For durable peer evidence, workflowContext is the hub-authorized provenance scope; correlation and idempotency are transport concerns and do not establish evidence provenance.",
    parameters: Type.Object({
      target: Type.String({ description: "Peer name or agent ID" }),
      content: Type.String({ description: "Focused request with the expected response or artifact" }),
      delivery: Type.Optional(Type.Union([
        Type.Literal("steer"),
        Type.Literal("followUp"),
        Type.Literal("nextTurn"),
      ], { description: "followUp is the safe default; use steer only for active blockers" })),
      correlationId: Type.Optional(Type.String({ description: "Optional task grouping; the hub binds it to runId when workflowContext is supplied" })),
      idempotencyKey: Type.Optional(Type.String({ description: "Retry/deduplication key only; not a workflow security or evidence binding" })),
      workflowContext: Type.Optional(Type.Object({
        runId: Type.String({ description: "Active durable workflow run ID" }),
        stageId: Type.String({ description: "Active workflow stage ID" }),
        requirementKey: Type.String({ description: "Required evidence identity this peer reply may satisfy" }),
        attempt: Type.Integer({ minimum: 1, maximum: 20, description: "Current one-based stage attempt" }),
      }, {
        additionalProperties: false,
        description: "Requested provenance scope; the hub authorizes and persists the canonical binding",
      })),
      ttlMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 604_800_000 })),
    }),
    async execute(_toolCallId, params) {
      const message = await requireClient().send({
        target: params.target,
        content: params.content,
        ...(params.delivery ? { delivery: params.delivery as DeliveryMode } : {}),
        ...(params.correlationId ? { correlationId: params.correlationId } : {}),
        ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
        ...(params.workflowContext ? { workflowContext: params.workflowContext } : {}),
        ...(params.ttlMs ? { ttlMs: params.ttlMs } : {}),
      });
      return result({ messageId: message.id, status: message.status, target: message.toName });
    },
  });

  pi.registerTool({
    name: "kxm_get",
    label: "Get peer response",
    description: "Check a peer request without blocking. Returns its current status and optional reply.",
    parameters: Type.Object({ messageId: Type.String() }),
    async execute(_toolCallId, params) {
      return result(await requireClient().getMessage(params.messageId));
    },
  });

  pi.registerTool({
    name: "kxm_fanout",
    label: "Ask planning panel",
    description: "Send the same independent request to one through three peers and return replies for comparison and synthesis. A local timeout or prompt interruption returns a pending response with a durable messageId for kxm_get or an exact retry. For durable peer evidence, supply workflowContext; correlation and idempotency are transport concerns and do not establish evidence provenance.",
    parameters: Type.Object({
      targets: Type.Array(Type.String(), { minItems: 1, maxItems: 3 }),
      content: Type.String(),
      correlationId: Type.Optional(Type.String({ description: "Optional task grouping; the hub binds it to runId when workflowContext is supplied" })),
      idempotencyKeyPrefix: Type.Optional(Type.String({ description: "Stable retry/deduplication prefix only; not a workflow security or evidence binding" })),
      workflowContext: Type.Optional(Type.Object({
        runId: Type.String({ description: "Active durable workflow run ID" }),
        stageId: Type.String({ description: "Active workflow stage ID" }),
        requirementKey: Type.String({ description: "Required evidence identity these peer replies may satisfy" }),
        attempt: Type.Integer({ minimum: 1, maximum: 20, description: "Current one-based stage attempt" }),
      }, {
        additionalProperties: false,
        description: "Requested provenance scope shared by each request; the hub authorizes and persists the canonical binding",
      })),
      ttlMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 604_800_000 })),
      timeoutMs: Type.Optional(Type.Number({ minimum: 100, maximum: 1_800_000 })),
    }),
    async execute(_toolCallId, params, signal) {
      return result({ responses: await requireClient().fanout({
        targets: params.targets,
        content: params.content,
        ...(params.correlationId ? { correlationId: params.correlationId } : {}),
        ...(params.idempotencyKeyPrefix ? { idempotencyKeyPrefix: params.idempotencyKeyPrefix } : {}),
        ...(params.workflowContext ? { workflowContext: params.workflowContext } : {}),
        ...(params.ttlMs ? { ttlMs: params.ttlMs } : {}),
        ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
        ...(signal ? { signal } : {}),
      }) });
    },
  });

  pi.registerTool({
    name: "kxm_await",
    label: "Await peer response",
    description: "Wait for a peer request to receive a reply. Prefer kxm_get when useful work can continue meanwhile.",
    parameters: Type.Object({
      messageId: Type.String(),
      timeoutMs: Type.Optional(Type.Number({ minimum: 100, maximum: 1_800_000 })),
    }),
    async execute(_toolCallId, params, signal) {
      return result(await requireClient().awaitResponse(params.messageId, params.timeoutMs, signal));
    },
  });

  pi.registerTool({
    name: "kxm_cancel",
    label: "Cancel peer request",
    description: "Cancel a queued or delivered request that this agent sent.",
    parameters: Type.Object({ messageId: Type.String() }),
    async execute(_toolCallId, params) {
      return result(await requireClient().cancel(params.messageId));
    },
  });

  pi.registerTool({
    name: "kxm_workflow_list",
    label: "List workflow runs",
    description: "List durable webhook workflow runs assigned to this long-lived agent.",
    parameters: Type.Object({}),
    async execute() {
      return result({ runs: await workflowCall(() => requireClient().listWorkflows()) });
    },
  });

  pi.registerTool({
    name: "kxm_workflow_get",
    label: "Get workflow run",
    description: "Get a workflow's stages and journal of plans, decisions, contradictions, errors, and lessons.",
    parameters: Type.Object({ runId: Type.String() }),
    async execute(_toolCallId, params) {
      return result(await workflowCall(() => requireClient().getWorkflow(params.runId)));
    },
  });

  pi.registerTool({
    name: "kxm_workflow_checkpoint",
    label: "Checkpoint workflow stage",
    description: "Record a stage result with evidence keyed by the stage's required evidence identities. Cite peer-reply requirements through evidenceRefs so the hub can verify provenance and quorum; caller-authored evidence strings cannot satisfy those policies. Warnings and failures require another attempt until passed or exhausted.",
    parameters: Type.Object({
      runId: Type.String(),
      stageId: Type.String(),
      status: Type.Union([Type.Literal("passed"), Type.Literal("warning"), Type.Literal("failed")]),
      summary: Type.String(),
      evidence: Type.Optional(Type.Record(Type.String(), Type.String(), { maxProperties: 64 })),
      evidenceRefs: Type.Optional(Type.Record(
        Type.String(),
        Type.Object({
          messageIds: Type.Array(Type.String(), { minItems: 1, maxItems: 16 }),
        }, { additionalProperties: false }),
        {
          maxProperties: 32,
          description: "Peer evidence references keyed by required evidence identity; the hub verifies messages and derives producer metadata",
        },
      )),
    }),
    async execute(_toolCallId, params) {
      return result(await workflowCall(() => requireClient().checkpointWorkflow(params.runId, {
        stageId: params.stageId,
        status: params.status as WorkflowCheckpointStatus,
        summary: params.summary,
        ...(params.evidence ? { evidence: params.evidence } : {}),
        ...(params.evidenceRefs ? { evidenceRefs: params.evidenceRefs } : {}),
      })));
    },
  });

  pi.registerTool({
    name: "kxm_workflow_wait",
    label: "Wait for workflow signal",
    description: "Pause the active workflow stage until a signed external callback reports its result. Supply caller-authored evidence by key and cite peer-reply requirements through evidenceRefs so the hub can verify provenance and quorum. Verified evidence is accumulated with callback evidence. The current agent turn may settle after this succeeds.",
    parameters: Type.Object({
      runId: Type.String(),
      stageId: Type.String(),
      signalKey: Type.String({ description: "Stable callback key, such as github-pr-42-checks" }),
      summary: Type.String({ description: "What is running externally and what result is expected" }),
      evidence: Type.Optional(Type.Record(Type.String(), Type.String(), { maxProperties: 64 })),
      evidenceRefs: Type.Optional(Type.Record(
        Type.String(),
        Type.Object({
          messageIds: Type.Array(Type.String(), { minItems: 1, maxItems: 16 }),
        }, { additionalProperties: false }),
        {
          maxProperties: 32,
          description: "Peer evidence references keyed by required evidence identity; the hub verifies messages and derives producer metadata",
        },
      )),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 2_592_000_000 })),
    }),
    async execute(_toolCallId, params) {
      return result(await workflowCall(() => requireClient().waitForWorkflowSignal(params.runId, {
        stageId: params.stageId,
        signalKey: params.signalKey,
        summary: params.summary,
        ...(params.evidence ? { evidence: params.evidence } : {}),
        ...(params.evidenceRefs ? { evidenceRefs: params.evidenceRefs } : {}),
        ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
      })));
    },
  });

  pi.registerTool({
    name: "kxm_workflow_record",
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
    name: "kxm_improvement_report",
    label: "Review workflow improvements",
    description: "Summarize recorded errors, contradictions, and lessons by improvement area across this project.",
    parameters: Type.Object({}),
    async execute() {
      return result(await workflowCall(() => requireClient().improvementReport()));
    },
  });

  // ----- KXM context operating system (v0.5) -----

  pi.registerTool({
    name: "kxm_context",
    label: "Assemble role-aware context packet",
    description: "Normal entry point for KXM context. Assembles a token-budgeted context packet for your role and task from durable journal evidence, temporal state, knowledge, episodes, and skills. Superseded and rejected records are excluded. Do not query memory providers directly; use KXM context tools.",
    parameters: Type.Object({
      role: Type.String({ description: "Your role for this task: repro, planner, critic, implementer, verifier, or a custom role" }),
      task: Type.String({ description: "What you are trying to accomplish" }),
      workflowRunId: Type.Optional(Type.String({ description: "Workflow run scope, when working a run" })),
      stageId: Type.Optional(Type.String({ description: "Workflow stage scope" })),
      budgetTokens: Type.Optional(Type.Integer({ description: "Token budget; defaults to the role policy" })),
      includeKinds: Type.Optional(Type.Array(Type.Union([
        Type.Literal("evidence"),
        Type.Literal("state"),
        Type.Literal("episode"),
        Type.Literal("knowledge"),
        Type.Literal("skill"),
      ]), { description: "Restrict packet to these item kinds" })),
    }),
    async execute(_toolCallId, params) {
      const client = requireClient();
      return result(await workflowCall(() => client.contextGet({
        project: client.agent!.project,
        role: params.role,
        task: params.task,
        ...(params.workflowRunId ? { workflowRunId: params.workflowRunId } : {}),
        ...(params.stageId ? { stageId: params.stageId } : {}),
        ...(params.budgetTokens !== undefined ? { budgetTokens: params.budgetTokens } : {}),
        ...(params.includeKinds ? { includeKinds: params.includeKinds } : {}),
      })));
    },
  });

  pi.registerTool({
    name: "kxm_recall",
    label: "Recall durable context records",
    description: "Search durable context records for this project by query. Returns bounded metadata only; use kxm_context for role-aware packets.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Substring query against summaries and state keys" })),
      kinds: Type.Optional(Type.Array(Type.String(), { description: "Item kinds to include" })),
      limit: Type.Optional(Type.Integer({ description: "Maximum results (1-100)" })),
    }),
    async execute(_toolCallId, params) {
      const client = requireClient();
      return result(await workflowCall(() => client.contextRecall({
        project: client.agent!.project,
        ...(params.query ? { query: params.query } : {}),
        ...(params.kinds ? { kinds: params.kinds as ContextItemKind[] } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      })));
    },
  });

  pi.registerTool({
    name: "kxm_state",
    label: "Query authoritative project state",
    description: "Current value for one temporal state key, optionally as of a historical timestamp. Superseded values never appear as current.",
    parameters: Type.Object({
      key: Type.String({ description: "State key" }),
      asOf: Type.Optional(Type.String({ description: "ISO-8601 timestamp for historical queries" })),
    }),
    async execute(_toolCallId, params) {
      const client = requireClient();
      return result(await workflowCall(() => client.contextState({
        project: client.agent!.project,
        key: params.key,
        ...(params.asOf ? { asOf: params.asOf } : {}),
      })));
    },
  });

  pi.registerTool({
    name: "kxm_episode",
    label: "Recall episodic learning records",
    description: "Episodic learning from workflow journals: errors, lessons, observations, and experiments for this project, optionally scoped to one run.",
    parameters: Type.Object({
      workflowRunId: Type.Optional(Type.String({ description: "Limit to one workflow run" })),
    }),
    async execute(_toolCallId, params) {
      const client = requireClient();
      return result(await workflowCall(() => client.contextEpisode({
        project: client.agent!.project,
        ...(params.workflowRunId ? { workflowRunId: params.workflowRunId } : {}),
      })));
    },
  });

  pi.registerTool({
    name: "kxm_promote",
    label: "Propose temporal state change",
    description: "Propose a change to one authoritative state key. Proposing changes nothing: promotion requires durable evidence and an authorized control-plane decision. Peers can claim evidence authority at most.",
    parameters: Type.Object({
      key: Type.String({ description: "State key to propose a change for" }),
      summary: Type.String({ description: "Proposed value and rationale" }),
      authority: Type.Union([
        Type.Literal("policy"),
        Type.Literal("instruction"),
        Type.Literal("evidence"),
        Type.Literal("hypothesis"),
      ]),
      confidence: Type.Union([
        Type.Literal("verified"),
        Type.Literal("probable"),
        Type.Literal("uncertain"),
      ]),
      evidenceRefs: Type.Array(Type.String(), { minItems: 1, maxItems: 32, description: "Durable references backing the proposal" }),
    }),
    async execute(_toolCallId, params) {
      const client = requireClient();
      return result(await workflowCall(() => client.contextStatePropose({
        project: client.agent!.project,
        key: params.key,
        summary: params.summary,
        authority: params.authority,
        confidence: params.confidence,
        evidenceRefs: params.evidenceRefs,
      })));
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

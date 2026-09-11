import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENT_COMMANDS, enforceToolPolicy } from "./commands.ts";
import { HubClient, HubHttpError } from "./client.ts";
import { nousFactoryWork, type NousRegistrationReport } from "./nous-pi.ts";
import { areaForTool, classifyFailure, diagnosticEvidence, diagnosticSummary, type Diagnostic } from "./diagnostics.ts";
import {
  MAX_CONTENT_CHARS,
  type DeliveryMode,
  type HubEvent,
  type MessageRecord,
} from "./protocol.ts";
import { consumeWorkerRecoveryEnvelope, workerStateKey } from "./recovery.ts";
import {
  itemFromChoice,
  kxmSlashCompletions,
  loadSessionBrief,
  loadSessionBriefAsync,
  parseKxmSlashArgs,
  sessionBriefChoices,
  sessionBriefPickerEnabled,
  type SessionHubStatus,
  type SessionWorkItem,
} from "./session-work.ts";
import {
  loadActiveWorkflowProgress,
  renderWorkflowTuiText,
  renderWorkflowWidgetLines,
} from "./workflow-tui.ts";

const SETTLEMENT_RETRY_BASE_MS = 250;
const SETTLEMENT_RETRY_MAX_MS = 30_000;

function boundedPeerReply(reply: string): string {
  if (reply.length <= MAX_CONTENT_CHARS) return reply;
  const suffix = `\n\n[kxm: response truncated from ${reply.length} characters to fit the message limit; the full output may remain in the replying agent's local session or worker log]`;
  return reply.slice(0, MAX_CONTENT_CHARS - suffix.length) + suffix;
}

function isTerminalMessage(message: MessageRecord): boolean {
  return message.status === "replied"
    || message.status === "cancelled"
    || message.status === "expired"
    || message.status === "error";
}

function isTerminalMessageError(error: unknown): boolean {
  return error instanceof HubHttpError
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

export function assistantFailure(messages: unknown[]): Diagnostic | undefined {
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

export default function piMeshExtension(pi: ExtensionAPI): void | Promise<void> {
  let client: HubClient | undefined;
  let nousReport: NousRegistrationReport | undefined;
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
      if (!(error instanceof HubHttpError)) throw error;
      const assigned = typeof error.extras?.assignedCoordinatorName === "string" ? ` assignedCoordinator=${error.extras.assignedCoordinatorName}` : "";
      const nextAction = typeof error.extras?.nextAction === "string" ? ` nextAction=${error.extras.nextAction}` : "";
      const operationName = typeof error.extras?.operation === "string" ? ` operation=${error.extras.operation}` : "";
      throw new Error(`${error.message} [code=${error.code ?? "http_error"}${operationName}${assigned}${nextAction}]`);
    }
  }

  function requireClient(): HubClient {
    if (!client?.agent) throw new Error("kxm hub is not connected; check KXM_SERVER_URL and /kxm hub");
    return client;
  }

  let currentWork: SessionWorkItem | undefined;

  async function applySessionChrome(
    ctx: {
      cwd?: string;
      mode?: string;
      ui: {
        setStatus?: (key: string, value: string | undefined) => void;
        setWidget?: (key: string, lines: string[] | undefined) => void;
        setEditorText?: (text: string) => void;
        select?: (title: string, options: string[]) => Promise<string | undefined>;
      };
    },
    event: { reason?: string },
    offerPicker: boolean,
  ): Promise<void> {
    const cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
    const hub: SessionHubStatus | undefined = client?.agent
      ? { state: "on", evidence: "process", online: true }
      : undefined;
    const brief = await loadSessionBriefAsync(cwd, process.env, currentWork, hub);
    ctx.ui.setStatus?.("kxm", brief.statusLine);
    ctx.ui.setWidget?.("kxm-work", brief.widgetLines);
    const progress = loadActiveWorkflowProgress(cwd);
    if (progress) {
      ctx.ui.setWidget?.("kxm-progress", renderWorkflowWidgetLines(progress));
    }
    if (!offerPicker || !sessionBriefPickerEnabled({
      env: process.env,
      ...(ctx.mode ? { mode: ctx.mode } : {}),
      ...(event.reason ? { reason: event.reason } : {}),
    })) return;
    if (brief.tasks.length === 0 && brief.plans.length === 0) return;
    if (typeof ctx.ui.select !== "function") return;
    const choice = await ctx.ui.select("Continue KXM work?", sessionBriefChoices(brief));
    const item = itemFromChoice(brief, choice);
    if (!item) return;
    currentWork = item;
    const selected = await loadSessionBriefAsync(cwd, process.env, item, hub);
    ctx.ui.setStatus?.("kxm", selected.statusLine);
    ctx.ui.setWidget?.("kxm-work", selected.widgetLines);
    ctx.ui.setEditorText?.(item.prompt);
  }

  async function showKxmHub(ctx: { ui: { notify: (message: string, type: "info" | "warning" | "error") => void } }): Promise<void> {
    const url = (process.env.KXM_SERVER_URL ?? "http://127.0.0.1:7331").replace(/\/$/, "");
    let health = "unreachable";
    try {
      const response = await fetch(`${url}/health`);
      health = response.ok ? "ok" : `http_${response.status}`;
    } catch {
      health = "unreachable";
    }
    if (!client?.agent) {
      ctx.ui.notify(`kxm hub view: health=${health}; no agent connected`, "warning");
      return;
    }
    const peers = await client.listAgents();
    ctx.ui.notify(`kxm hub view: health=${health}; ${client.agent.name}; ${peers.length} online agent(s)`, "info");
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
        `kxm worker is stuck: delivered message ${messageId} did not start a model turn within ${timeoutMs}ms; requesting supervised restart`,
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
      `kxm could not activate the next hub message; it remains durable and activation will retry in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`,
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
          customType: "kxm-inbound",
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
      `kxm could not return reply for ${messageId}; recovery state was retained and settlement will retry in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`,
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

  pi.on("session_start", async (event: { reason?: string }, ctx) => {
    shuttingDown = false;
    if (nousReport?.guidance.length) {
      for (const item of nousReport.guidance) {
        ctx.ui.notify(item.message, item.level);
      }
    }
    await client?.stop();
    client = undefined;
    try {
      currentSessionBinding = bindingFromEnvironment();
    } catch (error) {
      await applySessionChrome(ctx, event, false);
      ctx.ui.notify(`kxm session routing configuration failed: ${error instanceof Error ? error.message : String(error)}`, "error");
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
    client = new HubClient({
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
      ctx.ui.notify(`Connected to the KXM hub as ${agent.name}`, "info");
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
        pi.sendMessage({ customType: "kxm-recovery", content: [`Resume durable workflow run ${recovered.runId} after a fresh-session worker recovery.`, recovered.stageId ? `Last recorded stage: ${recovered.stageId}.` : "Resolve the current stage from kxm_workflow_get.", `Recovery reason: ${recovered.reason}.`, "Call kxm_workflow_get, inspect its journal and stage evidence, then continue the current stage without repeating completed work.", "Record the recovery decision and checkpoint only after the required evidence is satisfied."].join("\n"), display: true, details: { runId: recovered.runId, stageId: recovered.stageId, reason: recovered.reason } }, { triggerTurn: true, deliverAs: "followUp" });
        await applySessionChrome(ctx, event, false);
        return;
      }
    } catch (error) {
      client = undefined;
      ctx.ui.notify(`kxm connection failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
    await applySessionChrome(ctx, event, true);
  });

  pi.on("message_start", (event) => {
    const message = event.message as { customType?: string; details?: { messageId?: string } };
    if (message.customType !== "kxm-inbound" || !awaitingActivation) return;
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
        `kxm retained ${activeInbound.id} after ${activeFailure.class}; switch the model or let the supervised worker recover it`,
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

  pi.on("turn_end", async (_event, ctx) => {
    await applySessionChrome(ctx, { reason: "turn_end" }, false);
  });

  for (const cmd of AGENT_COMMANDS) {
    pi.registerTool({
      name: cmd.name,
      label: cmd.label,
      description: cmd.description,
      parameters: cmd.parameters as unknown as Record<string, unknown>,
      async execute(_toolCallId, params, signal) {
        const policy = enforceToolPolicy(cmd.name);
        if (!policy.allowed) {
          throw new Error(`tool_policy_denied: ${policy.detail ?? policy.error}`);
        }
        return result(
          await workflowCall(() =>
            cmd.execute(requireClient(), (params ?? {}) as Record<string, unknown>, { signal }),
          ),
        );
      },
    });
  }

  pi.registerCommand("kxm", {
    description: "Hub session brief, status line, and hub view",
    getArgumentCompletions: (prefix: string) => {
      const items = kxmSlashCompletions(prefix);
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const command = parseKxmSlashArgs(typeof args === "string" ? args : undefined);
      if (command === "hub") {
        await showKxmHub(ctx);
        return;
      }
      if (command === "status") {
        const cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
        const hub: SessionHubStatus | undefined = client?.agent
          ? { state: "on", evidence: "process", online: true }
          : undefined;
        const brief = await loadSessionBriefAsync(cwd, process.env, currentWork, hub);
        ctx.ui.setStatus?.("kxm", brief.statusLine);
        ctx.ui.setWidget?.("kxm-work", brief.widgetLines);
        ctx.ui.notify(brief.statusLine, "info");
        return;
      }
      if (command === "progress" || command === "workflow") {
        const cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
        const progress = loadActiveWorkflowProgress(cwd);
        if (progress) {
          const lines = renderWorkflowWidgetLines(progress);
          ctx.ui.setWidget?.("kxm-progress", lines);
          ctx.ui.notify(renderWorkflowTuiText(progress), "info");
        } else {
          ctx.ui.notify("kxm: no active workflow run found in state.", "info");
        }
        return;
      }
      if (command === "help") {
        ctx.ui.notify("kxm: /kxm | /kxm status | /kxm progress | /kxm workflow | /kxm hub | /kxm memory | /kxm help. CLI: kxm session brief, kxm hub view, kxm memory brief", "info");
        return;
      }
      if (command === "memory") {
        const cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
        const kxmBin = process.env.KXM_BIN || "kxm";
        const res = spawnSync(kxmBin, ["memory", "brief"], { cwd, encoding: "utf8", windowsHide: true });
        let memText = res.status === 0 && res.stdout ? res.stdout.trim() : "";
        if (!memText) {
          const script = join(cwd, "scripts", "kxm.mjs");
          if (existsSync(script)) {
            const scriptRes = spawnSync(process.execPath, [script, "memory", "brief"], { cwd, encoding: "utf8", windowsHide: true });
            if (scriptRes.status === 0 && scriptRes.stdout) memText = scriptRes.stdout.trim();
          }
        }
        ctx.ui.notify(memText || "No active project memory facts.", "info");
        return;
      }
      await applySessionChrome(ctx, { reason: "new" }, command === "brief");
    },
  });

  pi.registerCommand("workflow", {
    description: "Display active KXM workflow stage progress, assigned roles, and model metrics",
    handler: async (_args, ctx) => {
      const cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
      const progress = loadActiveWorkflowProgress(cwd);
      if (progress) {
        ctx.ui.setWidget?.("kxm-progress", renderWorkflowWidgetLines(progress));
        ctx.ui.notify(renderWorkflowTuiText(progress), "info");
      } else {
        ctx.ui.notify("kxm: no active workflow run found in state.", "info");
      }
    },
  });

  return nousFactoryWork(pi, (report) => {
    nousReport = report;
  });
}

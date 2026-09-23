import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HubClient, HubHttpError } from "./client.ts";
import { IMPROVEMENT_AREAS } from "./protocol.ts";
import { JOURNAL_CATEGORIES } from "./workflow.ts";
import type {
  DeliveryMode,
  ImprovementArea,
  JournalCategory,
  MessageRecord,
  WorkflowCheckpointStatus,
  WorkflowEvidenceInput,
  WorkflowEvidenceReferenceInput,
} from "./protocol.ts";

export interface CommandSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array";
  description?: string;
  enum?: readonly string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  maxProperties?: number;
  items?: Record<string, unknown>;
  patternProperties?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  required?: readonly string[];
  additionalProperties?: boolean | Record<string, unknown>;
}

export interface CommandJsonSchema {
  type: "object";
  properties: Record<string, CommandSchemaProperty>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

export interface ToolPolicy {
  preset?: string;
  allow?: string[];
  deny?: string[];
  allowedTools?: string[];
  deniedTools?: string[];
}

export interface AttemptTokenPayload {
  schema: "kxm.attempt-token.v1";
  runId: string;
  stepId: string;
  stepAttempt: number;
  assignmentId: string;
  attemptId: string;
  agentId: string;
  stageId?: string;
  attempt?: number;
  toolPolicy?: ToolPolicy;
  issuedAt?: string;
}

export interface SessionTokenPayload {
  schema: "kxm.session-token.v1";
  sessionId: string;
  agentName?: string;
  toolPolicy?: ToolPolicy;
  issuedAt: string;
  expiresAt?: string;
}

export interface CommandExecutionContext {
  signal?: AbortSignal | undefined;
  /** An event-fed inbox the caller keeps (the MCP server); `kxm_inbox` reconciles it. */
  inbox?: Map<string, MessageRecord> | undefined;
  notifiedInbox?: Set<string> | undefined;
  /** The caller keeps no inbox and reads its open requests from the hub (a one-shot CLI
   * call). A caller with neither this nor `inbox` activates inbound requests itself (Pi). */
  hubInbox?: boolean | undefined;
  /** Inbound requests this session is handling: the Pi extension's active request, the MCP
   * server's open inbox. A request sent meanwhile is one more hop along their chain. */
  handling?: readonly Pick<MessageRecord, "hops" | "maxHops">[] | undefined;
}

/**
 * Hop fields for a request sent while handling inbound work: one hop past the furthest
 * handled request, under the tightest limit among them, so the hub's `hop_limit_reached`
 * refusal bounds a chain of agents forwarding to each other. Handling nothing starts a new
 * chain with the hub defaults. When several requests are open the furthest one counts, so a
 * forwarding loop cannot reset its count because an unrelated request arrived beside it.
 */
export function forwardedHops(
  handling: CommandExecutionContext["handling"],
): { hops: number; maxHops: number } | undefined {
  if (!handling?.length) return undefined;
  return {
    hops: Math.max(...handling.map((message) => message.hops)) + 1,
    maxHops: Math.min(...handling.map((message) => message.maxHops)),
  };
}

export interface AgentCommand {
  /** Tool name exposed in MCP and Pi, e.g. "kxm_send" */
  name: string;
  /** Primary CLI group, e.g. "peer" or "workflow" or "context" */
  group: "peer" | "workflow" | "context";
  /** Subcommand verb in CLI, e.g. "send" or "checkpoint" */
  verb: string;
  /** Label for UI displays */
  label: string;
  /** Human-readable and LLM description */
  description: string;
  /** JSON Schema parameters */
  parameters: CommandJsonSchema;
  /** Shared implementation over HubClient */
  execute: (
    client: HubClient,
    args: Record<string, unknown>,
    context?: CommandExecutionContext,
  ) => Promise<unknown>;
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
    ? (value as Record<string, unknown>)
    : {};
}

function optionalWorkflowContext(
  value: unknown,
): { runId: string; stageId: string; requirementKey: string; attempt: number } | undefined {
  if (value === undefined) return undefined;
  const context = asRecord(value);
  if (
    !Number.isInteger(context.attempt)
    || (context.attempt as number) < 1
    || (context.attempt as number) > 20
  ) {
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
    ? (value as WorkflowEvidenceReferenceInput)
    : undefined;
}

function isTerminalMessageError(error: unknown): boolean {
  return (
    error instanceof HubHttpError
    && (error.statusCode === 409
      || (error.statusCode === 404 && error.code === "message_not_found"))
  );
}

function isTerminalMessage(message: MessageRecord): boolean {
  return (
    message.status === "replied"
    || message.status === "cancelled"
    || message.status === "expired"
    || message.status === "error"
  );
}

export async function reconcileInbox(
  client: HubClient,
  inbox: Map<string, MessageRecord>,
  notifiedInbox?: Set<string>,
): Promise<void> {
  await Promise.all(
    [...inbox.keys()].map(async (messageId) => {
      try {
        const current = await client.getMessage(messageId);
        if (isTerminalMessage(current)) {
          inbox.delete(messageId);
          notifiedInbox?.delete(messageId);
        } else {
          inbox.set(messageId, current);
        }
      } catch (error) {
        if (isTerminalMessageError(error)) {
          inbox.delete(messageId);
          notifiedInbox?.delete(messageId);
          return;
        }
        throw error;
      }
    }),
  );
}

function resolveProject(client: HubClient, projectArg: unknown): string {
  const proj = optionalString(projectArg) ?? client.agent?.project;
  if (!proj) {
    throw new Error('missing required parameter "project"');
  }
  return proj;
}

export const AGENT_COMMANDS: readonly AgentCommand[] = [
  {
    name: "kxm_list",
    group: "peer",
    verb: "list",
    label: "List hub peers",
    description:
      "List peer agents in this project's hub pool with their names, purposes, host label, and hub-clocked presence (online, stale, offline). Registered offline peers are listed only when includeOffline is set.",
    parameters: {
      type: "object",
      properties: {
        includeOffline: {
          type: "boolean",
          description: "Also list registered peers whose hub lease has expired",
        },
      },
      additionalProperties: false,
    },
    async execute(client, args) {
      return { agents: await client.listAgents({ includeOffline: args.includeOffline === true }) };
    },
  },
  {
    name: "kxm_send",
    group: "peer",
    verb: "send",
    label: "Send peer request",
    description:
      "Send a focused request to a peer agent. Returns a message ID for kxm_get or kxm_await. For durable peer evidence, workflowContext is the hub-authorized provenance scope; correlation and idempotency are transport concerns and do not establish evidence provenance.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Peer name or agent ID" },
        content: { type: "string", description: "Focused request with the expected response or artifact" },
        delivery: {
          type: "string",
          enum: ["steer", "followUp", "nextTurn"],
          default: "followUp",
          description: "followUp is the safe default; use steer only for active blockers",
        },
        correlationId: {
          type: "string",
          description: "Optional task grouping; the hub binds it to runId when workflowContext is supplied",
        },
        idempotencyKey: {
          type: "string",
          description: "Retry/deduplication key only; not a workflow security or evidence binding",
        },
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
        ttlMs: { type: "number", minimum: 1_000, maximum: 604_800_000, description: "Message TTL in milliseconds" },
        allowOffline: {
          type: "boolean",
          default: false,
          description: "Queue the request if the target is a registered offline agent in this project",
        },
      },
      required: ["target", "content"],
      additionalProperties: false,
    },
    async execute(client, args, context) {
      const delivery = optionalString(args.delivery) as DeliveryMode | undefined;
      const correlationId = optionalString(args.correlationId);
      const idempotencyKey = optionalString(args.idempotencyKey);
      const workflowContext = optionalWorkflowContext(args.workflowContext);
      const message = await client.send({
        ...forwardedHops(context?.handling),
        target: requiredString(args.target, "target"),
        content: requiredString(args.content, "content"),
        ...(delivery ? { delivery } : {}),
        ...(correlationId ? { correlationId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(workflowContext ? { workflowContext } : {}),
        ...(typeof args.ttlMs === "number" ? { ttlMs: args.ttlMs } : {}),
        ...(args.allowOffline === true ? { allowOffline: true } : {}),
      });
      return { messageId: message.id, status: message.status, target: message.toName };
    },
  },
  {
    name: "kxm_get",
    group: "peer",
    verb: "get",
    label: "Get peer request",
    description: "Check the status and optional reply for a previously sent request.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID of the sent request" },
      },
      required: ["messageId"],
      additionalProperties: false,
    },
    async execute(client, args) {
      return await client.getMessage(requiredString(args.messageId, "messageId"));
    },
  },
  {
    name: "kxm_fanout",
    group: "peer",
    verb: "fanout",
    label: "Fanout peer requests",
    description:
      "Ask one through three peers independently and return replies for comparison and synthesis. A local timeout or request cancellation returns a pending response with a durable messageId for kxm_get or an exact retry.",
    parameters: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 3,
          description: "One through three target peer names or agent IDs",
        },
        content: { type: "string", description: "Task description sent to all targets" },
        correlationId: {
          type: "string",
          description: "Optional task grouping; the hub binds it to runId when workflowContext is supplied",
        },
        idempotencyKeyPrefix: {
          type: "string",
          description: "Stable retry/deduplication prefix only; not a workflow security or evidence binding",
        },
        workflowContext: {
          type: "object",
          description: "Requested provenance scope shared by each request",
          properties: {
            runId: { type: "string", description: "Active durable workflow run ID" },
            stageId: { type: "string", description: "Active workflow stage ID" },
            requirementKey: { type: "string", description: "Required evidence identity these peer replies may satisfy" },
            attempt: { type: "integer", minimum: 1, maximum: 20, description: "Current one-based stage attempt" },
          },
          required: ["runId", "stageId", "requirementKey", "attempt"],
          additionalProperties: false,
        },
        ttlMs: { type: "number", minimum: 1_000, maximum: 604_800_000, description: "Message TTL in milliseconds" },
        timeoutMs: { type: "number", minimum: 100, maximum: 1_800_000, description: "Client wait timeout in milliseconds" },
      },
      required: ["targets", "content"],
      additionalProperties: false,
    },
    async execute(client, args, context) {
      const targets = Array.isArray(args.targets)
        ? args.targets.map((t) => requiredString(t, "target"))
        : [];
      return {
        responses: await client.fanout({
          ...forwardedHops(context?.handling),
          targets,
          content: requiredString(args.content, "content"),
          ...(optionalString(args.correlationId) ? { correlationId: optionalString(args.correlationId)! } : {}),
          ...(optionalString(args.idempotencyKeyPrefix)
            ? { idempotencyKeyPrefix: optionalString(args.idempotencyKeyPrefix)! }
            : {}),
          ...(optionalWorkflowContext(args.workflowContext)
            ? { workflowContext: optionalWorkflowContext(args.workflowContext)! }
            : {}),
          ...(typeof args.ttlMs === "number" ? { ttlMs: args.ttlMs } : {}),
          ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
          ...(context?.signal ? { signal: context.signal } : {}),
        }),
      };
    },
  },
  {
    name: "kxm_await",
    group: "peer",
    verb: "await",
    label: "Await peer response",
    description:
      "Wait until a sent request receives a reply or reaches a terminal error. Capped at 60 seconds (60000ms); longer waits are workflow wait steps.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID of the sent request" },
        timeoutMs: {
          type: "number",
          minimum: 100,
          maximum: 60_000,
          default: 60_000,
          description: "Timeout in milliseconds (capped at 60 seconds)",
        },
      },
      required: ["messageId"],
      additionalProperties: false,
    },
    async execute(client, args, context) {
      const timeoutMs = Math.min(
        typeof args.timeoutMs === "number" ? args.timeoutMs : 60_000,
        60_000,
      );
      return await client.awaitResponse(
        requiredString(args.messageId, "messageId"),
        timeoutMs,
        context?.signal,
      );
    },
  },
  {
    name: "kxm_cancel",
    group: "peer",
    verb: "cancel",
    label: "Cancel peer request",
    description: "Cancel a queued or delivered request sent by this agent.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID of the request to cancel" },
      },
      required: ["messageId"],
      additionalProperties: false,
    },
    async execute(client, args) {
      return await client.cancel(requiredString(args.messageId, "messageId"));
    },
  },
  {
    name: "kxm_inbox",
    group: "peer",
    verb: "inbox",
    label: "List inbound requests",
    description: "List inbound peer requests awaiting a reply.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(client, _args, context) {
      if (context?.inbox) {
        await reconcileInbox(client, context.inbox, context.notifiedInbox);
        return { messages: [...context.inbox.values()] };
      }
      if (context?.hubInbox) return { messages: await client.listInbox() };
      // Listing would offer requests this session's own activation queue is about to hand
      // it as turns, and an empty list would hide them, so it refuses.
      throw new Error(
        "kxm_inbox is not available in this session: it activates each inbound request as a turn, and that turn's final response is the reply",
      );
    },
  },
  {
    name: "kxm_reply",
    group: "peer",
    verb: "reply",
    label: "Reply to peer request",
    description: "Reply to an inbound peer request using its message ID.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message ID of the inbound request" },
        content: { type: "string", description: "Final response with evidence and remaining risks" },
      },
      required: ["messageId", "content"],
      additionalProperties: false,
    },
    async execute(client, args, context) {
      const messageId = requiredString(args.messageId, "messageId");
      try {
        const message = await client.reply(messageId, requiredString(args.content, "content"));
        if (context?.inbox) {
          context.inbox.delete(messageId);
          context.notifiedInbox?.delete(messageId);
        }
        return { messageId, status: message.status, recipient: message.fromName };
      } catch (error) {
        if (context?.inbox && isTerminalMessageError(error)) {
          context.inbox.delete(messageId);
          context.notifiedInbox?.delete(messageId);
        }
        throw error;
      }
    },
  },
  {
    name: "kxm_workflow_list",
    group: "workflow",
    verb: "runs",
    label: "List workflow runs",
    description: "List durable webhook workflows assigned to this agent.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(client) {
      return { runs: await client.listWorkflows() };
    },
  },
  {
    name: "kxm_workflow_get",
    group: "workflow",
    verb: "run",
    label: "Get workflow run",
    description: "Get a workflow's stages and its learning journal (plans, decisions, contradictions, errors, lessons, and the other journal categories).",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Workflow run ID" },
      },
      required: ["runId"],
      additionalProperties: false,
    },
    async execute(client, args) {
      return await client.getWorkflow(requiredString(args.runId, "runId"));
    },
  },
  {
    name: "kxm_workflow_checkpoint",
    group: "workflow",
    verb: "checkpoint",
    label: "Checkpoint workflow stage",
    description:
      "Record a stage result with evidence keyed by the stage's required evidence identities. Cite peer-reply requirements through evidenceRefs so the hub can verify provenance and quorum; caller-authored evidence strings cannot satisfy those policies. Warnings and failures require another attempt until passed or exhausted.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Active durable workflow run ID" },
        stageId: { type: "string", description: "Active stage ID" },
        status: { type: "string", enum: ["passed", "warning", "failed"], description: "Stage outcome" },
        summary: { type: "string", description: "Summary of changes, verification, and remaining risks" },
        evidence: {
          type: "object",
          additionalProperties: { type: "string" },
          maxProperties: 64,
          description: "Key-value evidence mapping required keys to proof strings",
        },
        evidenceRefs: {
          type: "object",
          description: "Peer evidence references keyed by required evidence identity",
          patternProperties: {
            "^(.*)$": {
              type: "object",
              properties: {
                messageIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 },
              },
              required: ["messageIds"],
              additionalProperties: false,
            },
          },
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
    async execute(client, args) {
      return await client.checkpointWorkflow(requiredString(args.runId, "runId"), {
        stageId: requiredString(args.stageId, "stageId"),
        status: requiredString(args.status, "status") as WorkflowCheckpointStatus,
        summary: requiredString(args.summary, "summary"),
        ...(args.evidence && typeof args.evidence === "object" && !Array.isArray(args.evidence)
          ? { evidence: args.evidence as WorkflowEvidenceInput }
          : {}),
        ...(optionalEvidenceRefs(args.evidenceRefs)
          ? { evidenceRefs: optionalEvidenceRefs(args.evidenceRefs)! }
          : {}),
      });
    },
  },
  {
    name: "kxm_workflow_record",
    group: "workflow",
    verb: "record",
    label: "Record workflow journal entry",
    description:
      "Record a plan, decision, contradiction, error, lesson, observation, hypothesis, experiment, state-change, or skill-candidate for continuous improvement. Pass stageId to bind the entry to that stage: the hub derives the attempt, and area defaults to the stage's declared area. Lessons and skill-candidates require evidence.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Active durable workflow run ID" },
        category: {
          type: "string",
          enum: [...JOURNAL_CATEGORIES],
          description: "Category of journal entry",
        },
        area: {
          type: "string",
          enum: [...IMPROVEMENT_AREAS],
          description: "System area; required unless stageId names a stage that declares an area",
        },
        stageId: {
          type: "string",
          description: "Stage the entry belongs to; the hub binds the attempt from the stage's state",
        },
        severity: {
          type: "string",
          enum: ["info", "warning", "error"],
          default: "info",
          description: "Severity level",
        },
        summary: { type: "string", description: "Concise description of the observation or decision" },
        details: { type: "string", description: "Extended details, context, and reasoning" },
        evidence: {
          type: "array",
          items: { type: "string" },
          maxItems: 32,
          description: "Durable evidence strings or URIs",
        },
        relatedEntryIds: {
          type: "array",
          items: { type: "string" },
          maxItems: 16,
          description: "Related previous journal entry IDs",
        },
      },
      required: ["runId", "category", "summary"],
      additionalProperties: false,
    },
    async execute(client, args) {
      return await client.recordWorkflowEntry(requiredString(args.runId, "runId"), {
        category: requiredString(args.category, "category") as JournalCategory,
        ...(optionalString(args.area) ? { area: optionalString(args.area) as ImprovementArea } : {}),
        ...(optionalString(args.stageId) ? { stageId: optionalString(args.stageId)! } : {}),
        ...(optionalString(args.severity)
          ? { severity: optionalString(args.severity) as "info" | "warning" | "error" }
          : {}),
        summary: requiredString(args.summary, "summary"),
        ...(optionalString(args.details) ? { details: optionalString(args.details)! } : {}),
        ...(Array.isArray(args.evidence) ? { evidence: args.evidence as string[] } : {}),
        ...(Array.isArray(args.relatedEntryIds) ? { relatedEntryIds: args.relatedEntryIds as string[] } : {}),
      });
    },
  },
  {
    name: "kxm_workflow_wait",
    group: "workflow",
    verb: "wait",
    label: "Wait for workflow signal",
    description:
      "Pause the active stage until a signed external callback checkpoints it and resumes the coordinator. Cite peer-reply requirements through evidenceRefs so the hub can verify provenance and quorum; verified evidence is accumulated with callback evidence.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Active durable workflow run ID" },
        stageId: { type: "string", description: "Active stage ID" },
        signalKey: { type: "string", description: "Stable callback key, such as github-pr-42-checks" },
        summary: { type: "string", description: "What is running externally and what result is expected" },
        evidence: {
          type: "object",
          additionalProperties: { type: "string" },
          maxProperties: 64,
          description: "Evidence gathered before the wait",
        },
        evidenceRefs: {
          type: "object",
          description: "Peer evidence references verified before waiting",
          patternProperties: {
            "^(.*)$": {
              type: "object",
              properties: {
                messageIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 },
              },
              required: ["messageIds"],
              additionalProperties: false,
            },
          },
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
        timeoutMs: {
          type: "number",
          minimum: 1_000,
          maximum: 2_592_000_000,
          description: "Maximum wait duration in milliseconds",
        },
      },
      required: ["runId", "stageId", "signalKey", "summary"],
      additionalProperties: false,
    },
    async execute(client, args) {
      return await client.waitForWorkflowSignal(requiredString(args.runId, "runId"), {
        stageId: requiredString(args.stageId, "stageId"),
        signalKey: requiredString(args.signalKey, "signalKey"),
        summary: requiredString(args.summary, "summary"),
        ...(args.evidence && typeof args.evidence === "object" && !Array.isArray(args.evidence)
          ? { evidence: args.evidence as WorkflowEvidenceInput }
          : {}),
        ...(optionalEvidenceRefs(args.evidenceRefs)
          ? { evidenceRefs: optionalEvidenceRefs(args.evidenceRefs)! }
          : {}),
        ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
      });
    },
  },
  {
    name: "kxm_improvement_report",
    group: "workflow",
    verb: "improve-report",
    label: "Summarize improvement report",
    description:
      "Summarize workflow errors, contradictions, lessons, and skill candidates by improvement area, plus ranked cross-run signals: duplicates merged across runs and scored by frequency x severity x run-attempt cost x evidence confidence, security first, with redacted text.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(client) {
      return await client.improvementReport();
    },
  },
  {
    name: "kxm_context",
    group: "context",
    verb: "get",
    label: "Get KXM context packet",
    description:
      "Normal entry point for KXM context. Assembles a token-budgeted role-aware context packet from durable journal evidence, temporal state, knowledge, episodes, and skills. Superseded and rejected records are excluded. Use KXM context tools instead of provider-specific memory APIs.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project scope (must be the client's project)" },
        role: {
          type: "string",
          description: "Requesting role: repro, planner, critic, implementer, verifier, or custom",
        },
        task: { type: "string", description: "What the role is trying to accomplish" },
        workflowRunId: { type: "string", description: "Workflow run scope" },
        stageId: { type: "string", description: "Workflow stage scope" },
        budgetTokens: { type: "integer", description: "Token budget; defaults to the role policy" },
        includeKinds: {
          type: "array",
          items: { type: "string", enum: ["evidence", "state", "episode", "knowledge", "skill"] },
          description: "Restrict packet to these item kinds",
        },
      },
      required: ["role", "task"],
      additionalProperties: false,
    },
    async execute(client, args) {
      return await client.contextGet({
        project: resolveProject(client, args.project),
        role: requiredString(args.role, "role"),
        task: requiredString(args.task, "task"),
        ...(optionalString(args.workflowRunId) ? { workflowRunId: optionalString(args.workflowRunId)! } : {}),
        ...(optionalString(args.stageId) ? { stageId: optionalString(args.stageId)! } : {}),
        ...(typeof args.budgetTokens === "number" ? { budgetTokens: args.budgetTokens } : {}),
        ...(Array.isArray(args.includeKinds) ? { includeKinds: args.includeKinds as any } : {}),
      });
    },
  },
  {
    name: "kxm_recall",
    group: "context",
    verb: "recall",
    label: "Recall context metadata",
    description:
      "Search durable context records for a project by query. Ranks exact-phrase matches first, then token relevance, then id; returns bounded metadata with a numeric relevance per item, never summaries.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project identifier" },
        query: { type: "string", description: "Query string" },
        kinds: { type: "array", items: { type: "string" }, description: "Kinds filter" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum results" },
      },
      additionalProperties: false,
    },
    async execute(client, args) {
      return await client.contextRecall({
        project: resolveProject(client, args.project),
        ...(optionalString(args.query) ? { query: optionalString(args.query)! } : {}),
        ...(Array.isArray(args.kinds) ? { kinds: args.kinds as any } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      });
    },
  },
  {
    name: "kxm_state",
    group: "context",
    verb: "state",
    label: "Get temporal state",
    description: "Current value for one temporal state key, optionally as of a historical timestamp.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project identifier" },
        key: { type: "string", description: "State key" },
        asOf: { type: "string", description: "ISO-8601 timestamp for historical queries" },
      },
      required: ["key"],
      additionalProperties: false,
    },
    async execute(client, args) {
      return await client.contextState({
        project: resolveProject(client, args.project),
        key: requiredString(args.key, "key"),
        ...(optionalString(args.asOf) ? { asOf: optionalString(args.asOf)! } : {}),
      });
    },
  },
  {
    name: "kxm_episode",
    group: "context",
    verb: "episode",
    label: "Get workflow episodes",
    description: "Episodic learning from workflow journals: errors, lessons, observations, experiments for a project.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project identifier" },
        workflowRunId: { type: "string", description: "Optional workflow run scope" },
      },
      additionalProperties: false,
    },
    async execute(client, args) {
      return await client.contextEpisode({
        project: resolveProject(client, args.project),
        ...(optionalString(args.workflowRunId) ? { workflowRunId: optionalString(args.workflowRunId)! } : {}),
      });
    },
  },
  {
    name: "kxm_promote",
    group: "context",
    verb: "promote",
    label: "Propose state promotion",
    description: "Propose a change to one authoritative state key. Promotion requires durable evidence.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project identifier" },
        key: { type: "string", description: "State key to promote" },
        summary: { type: "string", description: "Promotion summary" },
        authority: {
          type: "string",
          enum: ["evidence", "hypothesis"],
          description: "Authority class; an agent's proposal is peer origin, so evidence at most",
        },
        confidence: {
          type: "string",
          enum: ["verified", "probable", "uncertain"],
          description: "Confidence level",
        },
        evidenceRefs: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 32,
          description: "Evidence item references backing the promotion",
        },
      },
      required: ["key", "summary", "authority", "confidence", "evidenceRefs"],
      additionalProperties: false,
    },
    async execute(client, args) {
      return await client.contextStatePropose({
        project: resolveProject(client, args.project),
        key: requiredString(args.key, "key"),
        summary: requiredString(args.summary, "summary"),
        authority: requiredString(args.authority, "authority") as any,
        confidence: requiredString(args.confidence, "confidence") as any,
        evidenceRefs: Array.isArray(args.evidenceRefs) ? (args.evidenceRefs as string[]) : [],
      });
    },
  },
];

export const AGENT_COMMANDS_MAP: ReadonlyMap<string, AgentCommand> = new Map(
  AGENT_COMMANDS.map((cmd) => [cmd.name, cmd]),
);

export function getMcpTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return AGENT_COMMANDS.map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    inputSchema: cmd.parameters as unknown as Record<string, unknown>,
  }));
}

export function getPiToolDefinitions(): Array<{
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
}> {
  return AGENT_COMMANDS.map((cmd) => ({
    name: cmd.name,
    label: cmd.label,
    description: cmd.description,
    parameters: cmd.parameters as unknown as Record<string, unknown>,
  }));
}

export function getCliAgentCommands(): readonly AgentCommand[] {
  return AGENT_COMMANDS;
}

export function mintAttemptToken(input: {
  runId: string;
  stepId?: string;
  stepAttempt?: number;
  assignmentId?: string;
  attemptId?: string;
  agentId?: string;
  toolPolicy?: ToolPolicy;
  stageId?: string;
  attempt?: number;
  allowedTools?: string[];
  deniedTools?: string[];
  preset?: string;
}): string {
  const toolPolicy: ToolPolicy | undefined = input.toolPolicy ?? (
    input.allowedTools || input.deniedTools || input.preset
      ? {
          ...(input.preset ? { preset: input.preset } : {}),
          ...(input.allowedTools ? { allow: input.allowedTools, allowedTools: input.allowedTools } : {}),
          ...(input.deniedTools ? { deny: input.deniedTools, deniedTools: input.deniedTools } : {}),
        }
      : undefined
  );
  const payload: AttemptTokenPayload = {
    schema: "kxm.attempt-token.v1",
    runId: input.runId,
    stepId: input.stepId ?? input.stageId ?? "step-1",
    stepAttempt: input.stepAttempt ?? input.attempt ?? 1,
    stageId: input.stageId ?? input.stepId ?? "step-1",
    attempt: input.attempt ?? input.stepAttempt ?? 1,
    assignmentId: input.assignmentId ?? `assign-${randomUUID()}`,
    attemptId: input.attemptId ?? `attempt-${randomUUID()}`,
    agentId: input.agentId ?? "agent-worker",
    issuedAt: new Date().toISOString(),
    ...(toolPolicy ? { toolPolicy } : {}),
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function parseAttemptToken(token: string): AttemptTokenPayload | undefined {
  try {
    const raw = Buffer.from(token.trim(), "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed
      && typeof parsed === "object"
      && parsed.schema === "kxm.attempt-token.v1"
      && typeof parsed.runId === "string"
    ) {
      return parsed as AttemptTokenPayload;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function timingSafeStringCompare(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

export function mintSessionToken(input?: {
  sessionId?: string;
  agentName?: string;
  toolPolicy?: ToolPolicy;
  preset?: string;
  allowedTools?: string[];
  deniedTools?: string[];
  expiresAt?: string;
  ttlMs?: number;
}): string {
  const toolPolicy: ToolPolicy | undefined = input?.toolPolicy ?? (
    input?.allowedTools || input?.deniedTools || input?.preset
      ? {
          ...(input?.preset ? { preset: input.preset } : {}),
          ...(input?.allowedTools ? { allow: input.allowedTools, allowedTools: input.allowedTools } : {}),
          ...(input?.deniedTools ? { deny: input.deniedTools, deniedTools: input.deniedTools } : {}),
        }
      : undefined
  );
  const issuedAt = new Date().toISOString();
  // Decision Q2: Default 24-hour TTL for disk SessionToken
  const defaultTtlMs = 24 * 60 * 60 * 1000;
  const ttlMs = typeof input?.ttlMs === "number" && input.ttlMs > 0 ? input.ttlMs : defaultTtlMs;
  const expiresAt = input?.expiresAt ?? new Date(Date.now() + ttlMs).toISOString();

  const payload: SessionTokenPayload = {
    schema: "kxm.session-token.v1",
    sessionId: input?.sessionId ?? `session-${randomUUID()}`,
    issuedAt,
    expiresAt,
    ...(input?.agentName ? { agentName: input.agentName } : {}),
    ...(toolPolicy ? { toolPolicy } : {}),
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function isSessionTokenExpired(payloadOrToken: SessionTokenPayload | string): boolean {
  let payload: SessionTokenPayload | undefined;
  if (typeof payloadOrToken === "string") {
    try {
      const raw = Buffer.from(payloadOrToken.trim(), "base64url").toString("utf8");
      payload = JSON.parse(raw) as SessionTokenPayload;
    } catch {
      return true;
    }
  } else {
    payload = payloadOrToken;
  }
  if (!payload || !payload.expiresAt) return false;
  const expiryTime = new Date(payload.expiresAt).getTime();
  if (Number.isNaN(expiryTime)) return true;
  return Date.now() >= expiryTime;
}

export function parseSessionToken(token: string): SessionTokenPayload | undefined {
  try {
    const raw = Buffer.from(token.trim(), "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed
      && typeof parsed === "object"
      && parsed.schema === "kxm.session-token.v1"
      && typeof parsed.sessionId === "string"
    ) {
      if (parsed.expiresAt) {
        const expiryTime = new Date(parsed.expiresAt).getTime();
        if (!Number.isNaN(expiryTime) && Date.now() >= expiryTime) {
          return undefined; // Expired token fails closed
        }
      }
      return parsed as SessionTokenPayload;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveUserConfigDirectory(overrideDir?: string | undefined): string {
  if (overrideDir) return resolve(overrideDir);
  return resolve(process.env.KXM_USER_CONFIG_DIR?.trim() || join(homedir(), ".config", "kxm"));
}

export function sessionTokenPath(userConfigDir?: string | undefined): string {
  return join(resolveUserConfigDirectory(userConfigDir), "session.token");
}

export function persistSessionTokenToDisk(
  token: string,
  options?: { userConfigDir?: string | undefined; mode?: number | undefined } | undefined,
): string {
  const filePath = sessionTokenPath(options?.userConfigDir);
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mode = options?.mode ?? 0o600;
  writeFileSync(filePath, `${token.trim()}\n`, { encoding: "utf8", mode });
  try {
    chmodSync(filePath, mode);
  } catch {
    // Ignore permissions error on filesystems that do not support POSIX modes
  }
  return filePath;
}

export function readSessionTokenFromDisk(options?: {
  userConfigDir?: string | undefined;
} | undefined): { token: string; payload: SessionTokenPayload } | undefined {
  const filePath = sessionTokenPath(options?.userConfigDir);
  if (!existsSync(filePath)) return undefined;
  try {
    const token = readFileSync(filePath, "utf8").trim();
    if (!token) return undefined;
    const payload = parseSessionToken(token);
    if (!payload) return undefined;
    return { token, payload };
  } catch {
    return undefined;
  }
}

export function clearSessionTokenFromDisk(options?: {
  userConfigDir?: string | undefined;
} | undefined): boolean {
  const filePath = sessionTokenPath(options?.userConfigDir);
  if (!existsSync(filePath)) return false;
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function matchToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === "*" || pattern === toolName) return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }
  return false;
}

export function isToolAllowed(commandName: string, policy?: ToolPolicy): boolean {
  if (!policy) return true;
  const canonical = commandName.startsWith("kxm_") ? commandName : `kxm_${commandName}`;
  const bare = commandName.replace(/^kxm_/, "");

  const denyList = policy.deny ?? policy.deniedTools;
  if (Array.isArray(denyList)) {
    for (const d of denyList) {
      if (d === canonical || d === commandName || d === bare || matchToolPattern(d, canonical)) {
        return false;
      }
    }
  }

  const allowList = policy.allow ?? policy.allowedTools;
  if (Array.isArray(allowList) && allowList.length > 0) {
    const matched = allowList.some(
      (a) => a === canonical || a === commandName || a === bare || a === "*" || matchToolPattern(a, canonical),
    );
    if (!matched) return false;
  }

  if (policy.preset === "read-only") {
    const mutating = [
      "kxm_send",
      "kxm_reply",
      "kxm_cancel",
      "kxm_fanout",
      "kxm_workflow_checkpoint",
      "kxm_workflow_record",
      "kxm_workflow_wait",
      "kxm_promote",
    ];
    if (mutating.includes(canonical)) return false;
  }

  return true;
}

export function enforceToolPolicy(
  commandName: string,
  env: NodeJS.ProcessEnv = process.env,
  options?: { runId?: string; stageId?: string },
): { allowed: boolean; error?: string; detail?: string } {
  const attemptTokenRaw = env.KXM_ATTEMPT_TOKEN?.trim();
  if (attemptTokenRaw) {
    const attempt = parseAttemptToken(attemptTokenRaw);
    if (!attempt) {
      return { allowed: false, error: "attempt_token_invalid", detail: "KXM_ATTEMPT_TOKEN is malformed" };
    }
    if (!isToolAllowed(commandName, attempt.toolPolicy)) {
      return {
        allowed: false,
        error: "tool_policy_denied",
        detail: `command ${commandName} is denied by attempt tool policy`,
      };
    }
    // AttemptToken boundary: AttemptTokens are strictly worker tokens.
    // They cannot execute administrative state promotion unless explicitly allowed in toolPolicy
    if (commandName === "kxm_promote" || commandName === "promote") {
      const explicitAllow = attempt.toolPolicy?.allow ?? attempt.toolPolicy?.allowedTools;
      if (!Array.isArray(explicitAllow) || (!explicitAllow.includes("kxm_promote") && !explicitAllow.includes("promote") && !explicitAllow.includes("*"))) {
        return {
          allowed: false,
          error: "attempt_token_admin_denied",
          detail: "AttemptToken worker cannot perform operator state promotion without explicit policy grant",
        };
      }
    }
    // AttemptToken boundary: Scoped strictly to runId if provided in execution options
    if (options?.runId && attempt.runId && options.runId !== attempt.runId) {
      return {
        allowed: false,
        error: "attempt_token_scope_violation",
        detail: `attempt token runId ${attempt.runId} does not match request runId ${options.runId}`,
      };
    }
    return { allowed: true };
  }

  const envSessionRaw = env.KXM_SESSION_TOKEN?.trim();
  if (envSessionRaw) {
    const session = parseSessionToken(envSessionRaw);
    if (!session) {
      return { allowed: false, error: "session_token_invalid", detail: "KXM_SESSION_TOKEN is malformed or expired" };
    }
    if (!isToolAllowed(commandName, session.toolPolicy)) {
      return {
        allowed: false,
        error: "tool_policy_denied",
        detail: `command ${commandName} is denied by session tool policy`,
      };
    }
    return { allowed: true };
  }

  const tokenFile = sessionTokenPath(env.KXM_USER_CONFIG_DIR);
  if (existsSync(tokenFile)) {
    let tokenRaw: string | undefined;
    try {
      tokenRaw = readFileSync(tokenFile, "utf8").trim();
    } catch {
      return { allowed: false, error: "session_token_invalid", detail: "Session token file on disk could not be read" };
    }
    const session = tokenRaw ? parseSessionToken(tokenRaw) : undefined;
    if (!session) {
      return { allowed: false, error: "session_token_invalid", detail: "Session token on disk is malformed or expired" };
    }
    if (!isToolAllowed(commandName, session.toolPolicy)) {
      return {
        allowed: false,
        error: "tool_policy_denied",
        detail: `command ${commandName} is denied by session tool policy`,
      };
    }
    return { allowed: true };
  }

  return { allowed: true };
}

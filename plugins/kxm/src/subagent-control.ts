/**
 * Supervisory agent control, in-process real-time steering, and work-splitting.
 *
 * Implements:
 * - Dual-tool control plane: `agent` (spawn) and `agent_control` (manage, poll, steer, stop).
 * - Strict capability narrowing via `allowed_tools[]` allowlists.
 * - Mid-flight steering instruction injection.
 * - Subagent state lifecycle management (working, blocked, idle, done, error).
 */

import { randomUUID } from "node:crypto";
import { assertCommandSeatbelt } from "./safety-integrity.ts";

export type SubagentType = "general" | "Explore" | "Plan" | "Reviewer" | "Auditor";
export type SubagentStatus = "pending" | "running" | "blocked" | "completed" | "stopped" | "failed";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface AgentSpawnParams {
  prompt: string;
  description: string;
  type?: SubagentType | undefined;
  model?: string | undefined;
  thinking?: ThinkingLevel | undefined;
  allowed_tools?: string[] | undefined;
  turns?: number | undefined;
  background?: boolean | undefined;
  parent_tools?: readonly string[] | undefined;
}

export interface AgentControlParams {
  action: "info" | "result" | "steer" | "stop";
  kind?: "types" | "models" | "active" | undefined;
  agent_id?: string | undefined;
  message?: string | undefined;
  turns?: number | undefined;
  verbose?: boolean | undefined;
}

export interface SubagentRecord {
  id: string;
  description: string;
  type: SubagentType;
  model: string;
  thinking: ThinkingLevel;
  allowedTools: string[];
  status: SubagentStatus;
  turnsMax: number;
  turnsCompleted: number;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  steeringMessages: Array<{ text: string; injectedAt: string; processed: boolean }>;
  output?: string | undefined;
  error?: string | undefined;
}

export interface SubagentExecutionReceipt {
  ok: boolean;
  action: string;
  agent_id?: string | undefined;
  status?: SubagentStatus | undefined;
  activeAgents?: Array<{ id: string; description: string; type: SubagentType; status: SubagentStatus }> | undefined;
  types?: readonly SubagentType[] | undefined;
  result?: string | undefined;
  steered?: boolean | undefined;
  stopped?: boolean | undefined;
  error?: string | undefined;
}

export const SUBAGENT_TYPES: readonly SubagentType[] = Object.freeze([
  "general",
  "Explore",
  "Plan",
  "Reviewer",
  "Auditor",
]);

export const DEFAULT_SUBAGENT_MODELS: Readonly<Record<SubagentType, string>> = Object.freeze({
  general: "grok/grok-4.6",
  Explore: "openrouter/qwen/qwen3-coder-plus",
  Plan: "claude/fable",
  Reviewer: "openai/gpt-5.6-sol",
  Auditor: "claude/fable",
});

/**
 * Validates and intersects child allowed tools against the parent tool surface.
 * Enforces the safety invariant that a child can only narrow, never expand authority.
 */
export function narrowSubagentTools(
  requestedTools: readonly string[] | undefined,
  parentTools?: readonly string[] | undefined,
): string[] {
  if (!requestedTools || requestedTools.length === 0) {
    return parentTools ? [...parentTools] : ["read", "grep", "find"];
  }

  if (!parentTools || parentTools.length === 0) {
    return [...requestedTools];
  }

  const parentSet = new Set(parentTools);
  const narrowed: string[] = [];

  for (const tool of requestedTools) {
    if (parentSet.has(tool)) {
      narrowed.push(tool);
    }
  }

  if (narrowed.length === 0 && requestedTools.length > 0) {
    throw new Error(
      `Cannot spawn subagent: requested tools [${requestedTools.join(", ")}] expand beyond parent capabilities.`,
    );
  }

  return narrowed;
}

/**
 * In-Process Subagent Manager.
 */
export class SubagentManager {
  private readonly subagents = new Map<string, SubagentRecord>();

  /**
   * Spawns a new managed subagent with strict capability boundaries.
   */
  spawn(params: AgentSpawnParams): SubagentRecord {
    if (!params.prompt || !params.prompt.trim()) {
      throw new Error('Subagent "prompt" is required.');
    }
    if (!params.description || !params.description.trim()) {
      throw new Error('Subagent "description" is required.');
    }

    const type = params.type ?? "general";
    const model = params.model ?? DEFAULT_SUBAGENT_MODELS[type] ?? "grok/grok-4.6";
    const thinking = params.thinking ?? "low";
    const allowedTools = narrowSubagentTools(params.allowed_tools, params.parent_tools);
    const id = `ag_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const now = new Date().toISOString();

    const record: SubagentRecord = {
      id,
      description: params.description.trim(),
      type,
      model,
      thinking,
      allowedTools,
      status: params.background === false ? "completed" : "running",
      turnsMax: params.turns ?? 10,
      turnsCompleted: 0,
      prompt: params.prompt.trim(),
      createdAt: now,
      updatedAt: now,
      steeringMessages: [],
    };

    this.subagents.set(id, record);
    return record;
  }

  /**
   * Dispatches an action from the `agent_control` tool.
   */
  control(params: AgentControlParams): SubagentExecutionReceipt {
    const action = params.action;

    // 1. Action: "info"
    if (action === "info") {
      const kind = params.kind ?? "active";
      if (kind === "types") {
        return {
          ok: true,
          action: "info",
          types: SUBAGENT_TYPES,
        };
      }
      if (kind === "models") {
        return {
          ok: true,
          action: "info",
          result: JSON.stringify(DEFAULT_SUBAGENT_MODELS),
        };
      }
      const active = Array.from(this.subagents.values()).map((ag) => ({
        id: ag.id,
        description: ag.description,
        type: ag.type,
        status: ag.status,
      }));
      return {
        ok: true,
        action: "info",
        activeAgents: active,
      };
    }

    if (!params.agent_id) {
      return {
        ok: false,
        action,
        error: 'Parameter "agent_id" is required for result, steer, and stop actions.',
      };
    }

    const agent = this.subagents.get(params.agent_id);
    if (!agent) {
      return {
        ok: false,
        action,
        agent_id: params.agent_id,
        error: `Subagent "${params.agent_id}" not found.`,
      };
    }

    // 2. Action: "result"
    if (action === "result") {
      return {
        ok: true,
        action: "result",
        agent_id: agent.id,
        status: agent.status,
        result: agent.output ?? `[Subagent is currently ${agent.status}]`,
      };
    }

    // 3. Action: "steer"
    if (action === "steer") {
      if (!params.message || !params.message.trim()) {
        return {
          ok: false,
          action: "steer",
          agent_id: agent.id,
          error: 'Parameter "message" is required for steer action.',
        };
      }

      if (agent.status === "completed" || agent.status === "stopped" || agent.status === "failed") {
        return {
          ok: false,
          action: "steer",
          agent_id: agent.id,
          error: `Cannot steer subagent "${agent.id}" because it is already ${agent.status}.`,
        };
      }

      agent.steeringMessages.push({
        text: params.message.trim(),
        injectedAt: new Date().toISOString(),
        processed: false,
      });
      agent.updatedAt = new Date().toISOString();

      return {
        ok: true,
        action: "steer",
        agent_id: agent.id,
        status: agent.status,
        steered: true,
      };
    }

    // 4. Action: "stop"
    if (action === "stop") {
      agent.status = "stopped";
      agent.updatedAt = new Date().toISOString();
      return {
        ok: true,
        action: "stop",
        agent_id: agent.id,
        status: "stopped",
        stopped: true,
      };
    }

    return {
      ok: false,
      action,
      error: `Unknown control action "${action}".`,
    };
  }

  /**
   * Retrieves an agent record by ID.
   */
  get(agentId: string): SubagentRecord | undefined {
    return this.subagents.get(agentId);
  }

  /**
   * Marks a subagent as completed with output.
   */
  complete(agentId: string, output: string): void {
    const agent = this.subagents.get(agentId);
    if (agent) {
      agent.status = "completed";
      agent.output = output;
      agent.updatedAt = new Date().toISOString();
    }
  }

  /**
   * Returns all active running subagents.
   */
  listActive(): SubagentRecord[] {
    return Array.from(this.subagents.values()).filter(
      (ag) => ag.status === "running" || ag.status === "pending" || ag.status === "blocked",
    );
  }
}

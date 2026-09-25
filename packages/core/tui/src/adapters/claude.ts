/**
 * Claude Code TUI & Channel Adapter.
 *
 * Formats KXM goals, tasks, upcoming lookaheads, retries, and workflow
 * histories for Claude Code's terminal output, hook contexts, and channel events.
 *
 * Supports:
 * - Single-line and boxed HUD banners for terminal output
 * - Lookahead upcoming queue with dependency annotations
 * - Formatted history timeline for channel delivery and SessionStart hooks
 * - Plan optimizer proposals formatting
 */

import { type HistoryEventItem, renderWorkflowHistoryMarkdown } from "../tui/history.ts";
import { type QueuedTaskItem } from "../tui/queue.ts";
import { type OptimizerResult } from "../tui/optimizer.ts";
import { type RoleBudgetState, type RoleBudgetConfig } from "../tui/roleBudget.ts";

export interface ClaudeTaskHudOptions {
  readonly goal: string;
  readonly stageName: string;
  readonly stageIndex: number;
  readonly totalStages: number;
  readonly completedTasks: number;
  readonly totalTasks: number;
  readonly activeTaskTitle?: string | undefined;
  readonly activeRole?: string | undefined;
  readonly activeModel?: string | undefined;
  readonly attempt?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly elapsedSeconds?: number | undefined;
  readonly tokensIn?: number | undefined;
  readonly tokensOut?: number | undefined;
  readonly autoDispatch?: boolean | undefined;
}

/**
 * Format a high-visibility, single-line or framed HUD for Claude Code terminal output.
 */
export function formatClaudeTaskHud(options: ClaudeTaskHudOptions, compact = false): string {
  const percent = options.totalTasks > 0
    ? Math.round((options.completedTasks / options.totalTasks) * 100)
    : 0;
  const filled = Math.round((percent / 100) * 10);
  const bar = `[${"█".repeat(filled)}${"░".repeat(10 - filled)}] ${percent}%`;
  const modeTag = options.autoDispatch ? "[AUTO]" : "[STEP]";
  const attemptTag = options.attempt && options.attempt > 1 ? ` (Attempt ${options.attempt}/${options.maxAttempts ?? 3})` : "";
  const timeTag = options.elapsedSeconds !== undefined ? ` ⏱ ${options.elapsedSeconds}s` : "";

  if (compact) {
    return `[KXM ${modeTag}] ${options.goal} ── Stage ${options.stageIndex}/${options.totalStages} ${bar}${attemptTag}${timeTag}`;
  }

  const activeTask = options.activeTaskTitle
    ? `\n│  Active Task: ${options.activeTaskTitle}${attemptTag} [${options.activeRole ?? "agent"} (${options.activeModel ?? "default"})]`
    : "";

  return [
    `┌── KXM TASK HUD ─────────────────────────────────────────────────────────────┐`,
    `│  Goal: ${options.goal}`,
    `│  Stage ${options.stageIndex}/${options.totalStages}: ${options.stageName}  │ Progress: ${bar}${timeTag} │ Mode: ${modeTag}${activeTask}`,
    `└─────────────────────────────────────────────────────────────────────────────┘`,
  ].join("\n");
}

/**
 * Format the upcoming lookahead queue for Claude Code context and channel streams.
 */
export function formatClaudeUpcomingQueue(tasks: readonly QueuedTaskItem[]): string {
  if (tasks.length === 0) return "No upcoming tasks in queue.";

  const lines = ["### KXM Upcoming Task Queue:"];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    const deps = t.dependencies.length > 0 ? ` (Requires: ${t.dependencies.join(", ")})` : " (Ready)";
    lines.push(`${i + 1}. [${t.status.toUpperCase()}] **${t.title}** (\`${t.id}\`)`);
    lines.push(`   Role: \`${t.role}\` [${t.harness}/${t.model}]${deps}`);
  }
  return lines.join("\n");
}

/**
 * Format plan optimizer proposals for Claude Code review prompts.
 */
export function formatClaudeOptimizerReport(result: OptimizerResult): string {
  if (result.proposals.length === 0) {
    return "Plan Optimizer: No pending optimization proposals.";
  }

  const lines = [
    `### KXM Plan Optimizer Proposals:`,
    `Total Projected Savings: -${result.totalProjectedTimeSavingsSeconds}s execution time, -${result.totalProjectedCostSavingsPercent}% token cost`,
    "",
  ];

  for (const p of result.proposals) {
    const icon = p.category === "concurrency" ? "⚡" : "💰";
    lines.push(`${icon} **${p.title}** (\`${p.id}\`)`);
    lines.push(`   ${p.description}`);
    if (p.suggestedModel) {
      lines.push(`   Suggested Routing: \`${p.suggestedHarness ?? "pi"}/${p.suggestedModel}\``);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Format role budget and subscription status for Claude Code channel info.
 */
export function formatClaudeRoleBudget(config: RoleBudgetConfig, state: RoleBudgetState): string {
  const runCap = config.runSpendCapUsd !== undefined ? `$${config.runSpendCapUsd.toFixed(2)}` : "Unmetered";
  const monthlyCap = config.monthlySpendCapUsd !== undefined ? `$${config.monthlySpendCapUsd.toFixed(2)}` : "Unmetered";
  const currentRun = `$${state.currentRunSpendUsd.toFixed(4)}`;
  const currentMonthly = `$${state.currentMonthlySpendUsd.toFixed(2)}`;

  return [
    `Role: ${config.roleId} (${config.type})`,
    `Run Spend: ${currentRun} / ${runCap}`,
    `Monthly Spend: ${currentMonthly} / ${monthlyCap}`,
    `On Exhausted: ${config.onExhausted}${config.fallbackModel ? ` (Fallback: ${config.fallbackModel})` : ""}`,
  ].join(" │ ");
}

/**
 * Format history for Claude Code channel updates.
 */
export function formatClaudeWorkflowHistory(runId: string, events: readonly HistoryEventItem[]): string {
  return renderWorkflowHistoryMarkdown(runId, events);
}

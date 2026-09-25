/**
 * Workflow History & Journal View Engine.
 *
 * Tracks the complete chronological lifecycle of the active run:
 * - Event classification (Tasks, Gates, Retries, Peers, State)
 * - Filtering by category and search query
 * - Dual format generators: clean Markdown retrospective + JSONL audit ledger
 */

export type HistoryCategory = "all" | "task" | "gate" | "retry" | "peer" | "state";

export interface HistoryEventItem {
  readonly id: string;
  readonly timestamp: string;
  readonly category: Exclude<HistoryCategory, "all">;
  readonly title: string;
  readonly stageId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly role?: string | undefined;
  readonly harness?: string | undefined;
  readonly model?: string | undefined;
  readonly attempt?: number | undefined;
  readonly status: "passed" | "failed" | "warning" | "in_flight" | "degraded";
  readonly durationMs?: number | undefined;
  readonly tokensIn?: number | undefined;
  readonly tokensOut?: number | undefined;
  readonly costUsd?: number | undefined;
  readonly artifacts?: readonly string[] | undefined;
  readonly evidenceHashes?: readonly string[] | undefined;
  readonly journalSummary?: string | undefined;
}

export interface HistoryFilterOptions {
  readonly category?: HistoryCategory | undefined;
  readonly query?: string | undefined;
}

/**
 * Filter history items by category and substring query.
 */
export function filterHistoryEvents(
  events: readonly HistoryEventItem[],
  options: HistoryFilterOptions = {},
): HistoryEventItem[] {
  const category = options.category ?? "all";
  const query = options.query?.trim().toLowerCase();

  return events.filter((ev) => {
    if (category !== "all" && ev.category !== category) return false;
    if (!query) return true;
    const matchTarget = `${ev.id} ${ev.title} ${ev.stageId ?? ""} ${ev.taskId ?? ""} ${ev.role ?? ""} ${ev.model ?? ""} ${ev.journalSummary ?? ""}`.toLowerCase();
    return matchTarget.includes(query);
  });
}

/**
 * Render retrospective markdown text from workflow events.
 */
export function renderWorkflowHistoryMarkdown(
  runId: string,
  events: readonly HistoryEventItem[],
): string {
  const totalSpend = events.reduce((acc, ev) => acc + (ev.costUsd ?? 0), 0);
  const passedCount = events.filter((ev) => ev.status === "passed").length;
  const failedCount = events.filter((ev) => ev.status === "failed").length;

  let mdContent = `# KXM Workflow Retrospective: ${runId}\n\n`;
  mdContent += `**Total Events:** ${events.length} (Passed: ${passedCount}, Failed: ${failedCount})\n`;
  mdContent += `**Total Spend:** $${totalSpend.toFixed(4)} USD\n\n`;
  mdContent += `## Chronological Event Journal\n\n`;
  mdContent += `| Timestamp | Category | Title | Status | Role / Model | Duration | Spend |\n`;
  mdContent += `|---|---|---|---|---|---|---|\n`;

  for (const ev of events) {
    const elapsed = ev.durationMs !== undefined ? `${(ev.durationMs / 1000).toFixed(1)}s` : "-";
    const spend = ev.costUsd !== undefined ? `$${ev.costUsd.toFixed(4)}` : "-";
    const roleModel = ev.role ? `${ev.role} (${ev.harness ?? "-"}/${ev.model ?? "-"})` : "-";
    mdContent += `| ${ev.timestamp} | ${ev.category} | ${ev.title} | ${ev.status} | ${roleModel} | ${elapsed} | ${spend} |\n`;
  }

  mdContent += `\n## Produced Artifacts & Proofs\n\n`;
  for (const ev of events) {
    if (ev.artifacts && ev.artifacts.length > 0) {
      mdContent += `### ${ev.title} (${ev.id})\n`;
      for (const art of ev.artifacts) {
        mdContent += `- \`${art}\`\n`;
      }
    }
  }

  return mdContent;
}

/**
 * Format JSONL audit ledger lines from workflow events.
 */
export function formatWorkflowHistoryJsonl(
  runId: string,
  events: readonly HistoryEventItem[],
): string {
  return events.map((ev) => JSON.stringify({
    schema: "kxm.workflow-history-event.v1",
    runId,
    ...ev,
  })).join("\n") + "\n";
}

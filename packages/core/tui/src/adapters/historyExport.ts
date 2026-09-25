/**
 * History export adapter for local disk persistence.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderWorkflowHistoryMarkdown,
  formatWorkflowHistoryJsonl,
  type HistoryEventItem,
} from "../tui/history.ts";

export interface ExportedHistoryFiles {
  readonly mdPath: string;
  readonly jsonlPath: string;
}

/**
 * Export workflow history into both Markdown retrospective and JSONL audit logs on disk.
 */
export function exportWorkflowHistory(
  runId: string,
  events: readonly HistoryEventItem[],
  destinationDir: string,
): ExportedHistoryFiles {
  mkdirSync(destinationDir, { recursive: true });
  const sanitizedRunId = runId.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  const mdPath = join(destinationDir, `retrospective-${sanitizedRunId}.md`);
  const jsonlPath = join(destinationDir, `history-${sanitizedRunId}.jsonl`);

  writeFileSync(mdPath, renderWorkflowHistoryMarkdown(runId, events), "utf8");
  writeFileSync(jsonlPath, formatWorkflowHistoryJsonl(runId, events), "utf8");

  return { mdPath, jsonlPath };
}

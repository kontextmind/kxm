export const DIAGNOSTIC_CLASSES = [
  "command_not_found",
  "typecheck_error",
  "test_failure",
  "timeout",
  "cancelled",
  "workflow_scope",
  "invalid_identity",
  "invalid_auth",
  "signal_mismatch",
  "not_waiting",
  "network",
  "parse_error",
  "unresumable_session",
  "quota",
  "provider_error",
  "unknown",
] as const;

export type DiagnosticClass = (typeof DIAGNOSTIC_CLASSES)[number];

export const DIAGNOSTIC_OPERATIONS = [
  "get",
  "wait",
  "checkpoint",
  "journal",
  "signal",
  "await",
  "other",
] as const;

export type DiagnosticOperation = (typeof DIAGNOSTIC_OPERATIONS)[number];

export const NEXT_ACTIONS = [
  "use_assigned_coordinator",
  "wait_then_checkpoint",
  "record_journal_as_coordinator",
  "reconnect_with_current_agent_key",
  "check_project_token",
  "export_retrospective",
  "post_signal",
  "restart_fresh_session",
  "switch_model_or_retry",
] as const;

export type NextAction = (typeof NEXT_ACTIONS)[number];

export interface Diagnostic {
  class: DiagnosticClass;
  tool: string;
  operation: DiagnosticOperation;
  httpStatus?: number;
  code?: string;
  assignedCoordinatorName?: string;
  nextAction?: NextAction;
  exitCode?: number;
  durationMs?: number;
}

export interface ClassifyFailureInput {
  toolName?: string;
  message?: string;
  code?: string;
  statusCode?: number;
  exitCode?: number;
  durationMs?: number;
  assignedCoordinatorName?: string;
  nextAction?: NextAction;
}

const CODE_TO_CLASS: Record<string, DiagnosticClass> = {
  workflow_forbidden: "workflow_scope",
  invalid_agent_identity: "invalid_identity",
  invalid_auth: "invalid_auth",
  workflow_signal_mismatch: "signal_mismatch",
  workflow_not_waiting: "not_waiting",
  workflow_terminal: "not_waiting",
  workflow_not_running: "not_waiting",
  unresumable_session: "unresumable_session",
  provider_quota: "quota",
  provider_error: "provider_error",
};

export function operationForTool(toolName: string | undefined): DiagnosticOperation {
  switch (toolName) {
    case "mesh_workflow_get":
    case "mesh_workflow_list":
      return "get";
    case "mesh_workflow_wait":
      return "wait";
    case "mesh_workflow_checkpoint":
      return "checkpoint";
    case "mesh_workflow_record":
      return "journal";
    case "mesh_await":
      return "await";
    default:
      return "other";
  }
}

export function areaForTool(toolName: string | undefined): "workflow" | "harness" | "implementation" {
  if (toolName?.startsWith("mesh_workflow_")) return "workflow";
  if (toolName?.startsWith("mesh_")) return "harness";
  return "implementation";
}

export function nextActionForCode(code: string | undefined, operation: DiagnosticOperation): NextAction | undefined {
  if (code === "workflow_forbidden") return "use_assigned_coordinator";
  if (code === "invalid_agent_identity") return "reconnect_with_current_agent_key";
  if (code === "invalid_auth") return "check_project_token";
  if (code === "workflow_not_waiting" || code === "workflow_terminal" || code === "workflow_not_running") {
    return operation === "checkpoint" ? "wait_then_checkpoint" : "export_retrospective";
  }
  if (code === "workflow_signal_mismatch") return "post_signal";
  if (code === "unresumable_session") return "restart_fresh_session";
  if (code === "provider_quota" || code === "provider_error") return "switch_model_or_retry";
  return undefined;
}

function classFromTokens(text: string): DiagnosticClass | undefined {
  const value = text.toLowerCase();
  if (/\b(enoent|not recognized|command not found|is not recognized)\b/.test(value)) return "command_not_found";
  if (/\b(ts\d{3,4}|typecheck|type error)\b/.test(value)) return "typecheck_error";
  if (/\b(test failed|assertionerror|not equal)\b/.test(value)) return "test_failure";
  if (/\b(timed out|timeout|deadline)\b/.test(value)) return "timeout";
  if (/\b(aborted|cancelled|canceled|sigint|sigterm)\b/.test(value)) return "cancelled";
  if (/\b(econnrefused|enotfound|fetch failed|network)\b/.test(value)) return "network";
  if (/\b(invalid json|unexpected token|parse error)\b/.test(value)) return "parse_error";
  if (/\b(invalid_request_error|missing_tool_result|unresumable)\b/.test(value)) return "unresumable_session";
  if (/\b(quota reached|quota exceeded|rate limit(?:ed)?|too many requests|resource exhausted|http 429)\b/.test(value)) return "quota";
  if (/\b(not visible|only the assigned coordinator)\b/.test(value)) return "workflow_scope";
  return undefined;
}

export function classifyFailure(input: ClassifyFailureInput): Diagnostic {
  const tool = input.toolName?.trim() || "unknown";
  const operation = operationForTool(input.toolName);
  const fromCode = input.code ? CODE_TO_CLASS[input.code] : undefined;
  const fromTokens = input.message ? classFromTokens(input.message) : undefined;
  const diagnosticClass = fromCode ?? fromTokens ?? "unknown";
  const messageCoordinator = input.message?.match(/assignedCoordinator=([A-Za-z0-9_.-]{1,64})/)?.[1];
  const messageAction = input.message?.match(/nextAction=([a-z_]{1,64})/)?.[1];
  const parsedAction = NEXT_ACTIONS.includes(messageAction as NextAction) ? messageAction as NextAction : undefined;
  const nextAction = input.nextAction ?? parsedAction ?? nextActionForCode(input.code, operation);
  const assignedCoordinatorName = input.assignedCoordinatorName ?? messageCoordinator;
  return {
    class: diagnosticClass,
    tool,
    operation,
    ...(input.statusCode !== undefined ? { httpStatus: input.statusCode } : {}),
    ...(input.code ? { code: input.code } : {}),
    ...(assignedCoordinatorName ? { assignedCoordinatorName } : {}),
    ...(nextAction ? { nextAction } : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  };
}

export function diagnosticEvidence(diagnostic: Diagnostic, toolCallId?: string): string[] {
  return [
    `tool:${diagnostic.tool}`,
    ...(toolCallId ? [`tool-call:${toolCallId}`] : []),
    `class:${diagnostic.class}`,
    `operation:${diagnostic.operation}`,
    ...(diagnostic.code ? [`code:${diagnostic.code}`] : []),
    ...(diagnostic.nextAction ? [`nextAction:${diagnostic.nextAction}`] : []),
    ...(diagnostic.assignedCoordinatorName ? [`assignedCoordinator:${diagnostic.assignedCoordinatorName}`] : []),
  ];
}

export function diagnosticSummary(diagnostic: Diagnostic): string {
  const coordinator = diagnostic.assignedCoordinatorName ? `; assigned coordinator: ${diagnostic.assignedCoordinatorName}` : "";
  const next = diagnostic.nextAction ? `; next action: ${diagnostic.nextAction}` : "";
  return `Tool ${diagnostic.tool} failed: ${diagnostic.class}${coordinator}${next}`;
}

export function workflowScopeExtras(operation: DiagnosticOperation, assignedCoordinatorName: string) {
  return {
    operation,
    assignedCoordinatorName,
    nextAction: "use_assigned_coordinator" as const,
  };
}

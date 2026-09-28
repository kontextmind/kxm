/**
 * Route-switch records for reports.
 *
 * This module stays free of harness, route, and YAML imports so the Pi
 * extension load graph can read a switch without pulling the fallback walker.
 */

export const WALKABLE_CLASSES = ["rate_limit", "transport", "provider_unavailable", "context_overflow"] as const;
export type WalkableClass = (typeof WALKABLE_CLASSES)[number];

export const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface RouteSwitchRecord {
  from: string;
  to: string;
  reason: WalkableClass;
  effort?: string;
  attemptId: string;
  stepId: string;
  runId?: string;
}

export function parseRouteSwitchRecord(
  payload: unknown,
  identity: { attemptId?: string | undefined; stepId?: string | undefined; runId?: string | undefined } = {},
): RouteSwitchRecord | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const routeSwitch = (payload as { routeSwitch?: unknown }).routeSwitch;
  if (!routeSwitch || typeof routeSwitch !== "object" || Array.isArray(routeSwitch)) return undefined;
  const record = routeSwitch as Record<string, unknown>;
  const from = record.from;
  const to = record.to;
  const reason = record.reason;
  if (typeof from !== "string" || typeof to !== "string" || typeof reason !== "string") return undefined;
  if (!(WALKABLE_CLASSES as readonly string[]).includes(reason)) return undefined;
  const attemptId = typeof identity.attemptId === "string" ? identity.attemptId : typeof (payload as { attemptId?: unknown }).attemptId === "string" ? (payload as { attemptId: string }).attemptId : "";
  const stepId = typeof identity.stepId === "string" ? identity.stepId : typeof (payload as { stepId?: unknown }).stepId === "string" ? (payload as { stepId: string }).stepId : "";
  if (!attemptId || !stepId) return undefined;
  const effort = typeof record.effort === "string" && EFFORTS.has(record.effort) ? record.effort : undefined;
  return {
    from,
    to,
    reason: reason as WalkableClass,
    attemptId,
    stepId,
    ...(effort ? { effort } : {}),
    ...(identity.runId ? { runId: identity.runId } : {}),
  };
}

import { hubBindingScope } from "./hub-binding.ts";

export const TENANT_STATUS_SCHEMA = "kxm.tenant-status.v1" as const;

/**
 * One upstream of the tenant view, with its own reachability. A source that could not be
 * read is reported as `unavailable` with a stable reason — never silently filled from the
 * other source, because the two sources answer different questions: the hub holds
 * *metadata* (agent roster, message queue, its own workflow runs), the Runtime holds the
 * *authoritative* run state on the box that owns the run. Blurring them is how a portal
 * ends up rendering one as the other.
 */
export type TenantSourceState = "ok" | "unavailable";

export interface TenantSource<T> {
  state: TenantSourceState;
  /** When this source was read (or attempted), so a consumer can age the data itself. */
  observedAt: string;
  /** Stable machine code (`hub_unreachable`, `hub_timeout`, `runtime_supervisor_not_running`, …). */
  reason?: string;
  value?: T;
}

/** Hub-side roster entry: presence and liveness, per the hub's own observation. */
export interface TenantHubAgent {
  id: string;
  name: string;
  online: boolean;
}

export interface TenantHubStage {
  id: string;
  status: string;
  attempts?: number | undefined;
}

/**
 * A run as the hub records it. The hub mints its own run ids at workflow start; this is a
 * hub workflow run — metadata about work, not the Runtime's state for it.
 */
export interface TenantHubRun {
  id: string;
  status: string;
  definitionId: string;
  currentStage?: string | undefined;
  targetAgentName?: string | undefined;
  updatedAt?: string | undefined;
  progress?: { done: number; total: number };
  stages?: TenantHubStage[];
  source: "hub-projection";
}

export interface TenantHubPlan {
  id: string;
  runId: string;
  summary: string;
  createdAt: string;
  stageId?: string | undefined;
  severity?: string | undefined;
}

export interface TenantHubValue {
  project: string;
  fetchedAt: string;
  agents: TenantHubAgent[];
  openMessageTotal: number;
  runTotal: number;
  runs: TenantHubRun[];
  plans: TenantHubPlan[];
}

/** A run as the Runtime that owns it records it. This is the authoritative state. */
export interface TenantRuntimeRun {
  runId: string;
  status: string;
  homeRuntimeId: string;
  workflowId?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  /** Set when the stored row exists but the event-log fold refused; `status` is then the
   * cached row, and a consumer must not present it as folded state. */
  projectionError?: string | undefined;
  /** `runtime-cached` exactly when `projectionError` is set: the row is the cache, not the
   * folded state, and neither the label nor the cross-check may treat it as authoritative. */
  source: "runtime-authoritative" | "runtime-cached";
}

export interface TenantRuntimeValue {
  runs: TenantRuntimeRun[];
}

export interface TenantRunDiscrepancy {
  runId: string;
  hubStatus: string;
  runtimeStatus: string;
}

/**
 * Cross-check between the two run populations. Hub runs and Runtime runs mint their ids
 * independently (`newId("run")` on each side), so an id appearing in both means a hub run
 * that this box drove — and only then is a status comparison meaningful. With no overlap
 * the comparison is **unverified, not agreed**: "no matching ids" says the populations did
 * not intersect, nothing more, and reporting agreement there would fabricate a green light
 * out of an empty set.
 */
export interface TenantRunComparison {
  state: "compared" | "unverified" | "unavailable";
  reason?: string;
  matched?: number;
  /** Shared ids whose Runtime row failed to fold: present in both stores, but the
   * authoritative side could not be read, so those runs are unverified rather than agreed. */
  unverifiedFoldRuns?: number;
  discrepancies?: TenantRunDiscrepancy[];
}

export interface TenantStatusPayload {
  schema: typeof TENANT_STATUS_SCHEMA;
  project: string;
  generatedAt: string;
  hubUrl: string;
  /** Reuses the `kxm hub bind` classification: `loopback` and `remote` ship different rules. */
  bindingScope: "loopback" | "remote";
  hub: TenantSource<TenantHubValue>;
  runtime: TenantSource<TenantRuntimeValue>;
  runComparison: TenantRunComparison;
  /** True when any source is unavailable. Assembling a payload is not the same as seeing. */
  degraded: boolean;
}

export interface TenantStatusRuntimeReader {
  listRuns(): Promise<TenantRuntimeRun[]>;
}

const DEFAULT_HUB_TIMEOUT_MS = 5_000;

function hubSourceReason(status: number): string {
  if (status === 401 || status === 403) return "hub_unauthorized";
  if (status === 404) return "hub_not_found";
  return `hub_http_${status}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compose the tenant view from the two authorities that actually hold the data.
 *
 * Both sources are read **concurrently and independently**: a hub that hangs to its
 * deadline cannot delay or suppress the Runtime half of the view, and a Runtime that is
 * not running cannot take the hub metadata down with it. The hub is read over HTTP
 * (`/v1/ops/snapshot`, admin credential); the Runtime is read through an injected reader
 * so this function stays pure and testable — the CLI passes a reader that attaches to the
 * live supervisor, and a test passes whatever it likes.
 */
export async function assembleTenantStatus(input: {
  project: string;
  hubUrl: string;
  /** Resolves the admin credential. May throw on a malformed persisted record; that
   * failure belongs to the hub source alone and never aborts the Runtime read. */
  resolveAdminToken: () => string | undefined;
  fetchImpl: typeof fetch;
  runtime: TenantStatusRuntimeReader;
  hubTimeoutMs?: number | undefined;
  now?: () => Date;
}): Promise<TenantStatusPayload> {
  const now = input.now ?? ((): Date => new Date());
  const base = input.hubUrl.replace(/\/$/, "");
  const at = (): string => now().toISOString();

  const readHub = async (): Promise<TenantSource<TenantHubValue>> => {
    const attemptedAt = at();
    let token: string | undefined;
    try {
      token = input.resolveAdminToken();
    } catch (error) {
      // A malformed hub-env record is a configuration failure with a specific repair.
      // It belongs to this source; the Runtime read proceeds regardless.
      void error;
      return { state: "unavailable", observedAt: attemptedAt, reason: "hub_credential_unreadable" };
    }
    try {
      const response = await input.fetchImpl(`${base}/v1/ops/snapshot?project=${encodeURIComponent(input.project)}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(input.hubTimeoutMs ?? DEFAULT_HUB_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { state: "unavailable", observedAt: attemptedAt, reason: hubSourceReason(response.status) };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        // A deadline can expire mid-body; that is a timeout, not malformed content, and
        // classifying it as `hub_response_invalid` would hide the one fact that matters.
        const name = error instanceof Error ? error.name : undefined;
        if (name === "TimeoutError" || name === "AbortError") {
          return { state: "unavailable", observedAt: attemptedAt, reason: "hub_timeout" };
        }
        // Reachable but not a JSON document: a different failure than a dead socket.
        return { state: "unavailable", observedAt: attemptedAt, reason: "hub_response_invalid" };
      }
      if (!isObject(body)
        || typeof body.project !== "string"
        || typeof body.fetchedAt !== "string"
        || !Array.isArray(body.agents)
        || !Array.isArray(body.runs)
        || !Array.isArray(body.plans ?? [])
        || typeof body.openMessageTotal !== "number"
        || typeof body.runTotal !== "number") {
        // A 200 with an unusable body must not become a healthy empty snapshot.
        return { state: "unavailable", observedAt: attemptedAt, reason: "hub_response_invalid" };
      }
      if (body.project !== input.project) {
        return { state: "unavailable", observedAt: attemptedAt, reason: "hub_project_mismatch" };
      }
      const runRows = body.runs.filter(isObject);
      const value: TenantHubValue = {
        project: body.project,
        fetchedAt: body.fetchedAt,
        agents: body.agents.filter(isObject).map((agent) => ({
          id: asString(agent.id) ?? "",
          name: asString(agent.name) ?? "",
          online: agent.online === true,
        })),
        openMessageTotal: body.openMessageTotal,
        runTotal: body.runTotal,
        runs: runRows.map((run) => {
          const stages = Array.isArray(run.stages)
            ? run.stages.filter(isObject).map((stage) => ({
              id: asString(stage.id) ?? "",
              status: asString(stage.status) ?? "unknown",
              ...(typeof stage.attempts === "number" ? { attempts: stage.attempts } : {}),
            }))
            : undefined;
          const done = stages?.filter((stage) => stage.status === "passed" || stage.status === "failed" || stage.status === "warning").length;
          return {
            id: asString(run.id) ?? "",
            status: asString(run.status) ?? "unknown",
            definitionId: asString(run.definitionId) ?? "",
            ...(asString(run.currentStage) ? { currentStage: asString(run.currentStage) } : {}),
            ...(asString(run.targetAgentName) ? { targetAgentName: asString(run.targetAgentName) } : {}),
            ...(asString(run.updatedAt) ? { updatedAt: asString(run.updatedAt) } : {}),
            ...(stages !== undefined ? { progress: { done: done ?? 0, total: stages.length }, stages } : {}),
            source: "hub-projection" as const,
          };
        }),
        plans: (Array.isArray(body.plans) ? body.plans : []).filter(isObject).map((plan) => ({
          id: asString(plan.id) ?? "",
          runId: asString(plan.runId) ?? "",
          summary: asString(plan.summary) ?? "",
          createdAt: asString(plan.createdAt) ?? "",
          ...(asString(plan.stageId) ? { stageId: asString(plan.stageId) } : {}),
          ...(asString(plan.severity) ? { severity: asString(plan.severity) } : {}),
        })),
      };
      return { state: "ok", observedAt: attemptedAt, value };
    } catch (error) {
      const name = error instanceof Error ? error.name : undefined;
      if (name === "TimeoutError" || name === "AbortError") {
        return { state: "unavailable", observedAt: attemptedAt, reason: "hub_timeout" };
      }
      return { state: "unavailable", observedAt: attemptedAt, reason: "hub_unreachable" };
    }
  };

  const readRuntime = async (): Promise<TenantSource<TenantRuntimeValue>> => {
    const attemptedAt = at();
    try {
      const runs = await input.runtime.listRuns();
      return { state: "ok", observedAt: attemptedAt, value: { runs } };
    } catch (error) {
      const code = error instanceof Error && "issues" in error
        && Array.isArray((error as { issues: Array<{ code?: unknown }> }).issues)
        && typeof (error as { issues: Array<{ code?: unknown }> }).issues[0]?.code === "string"
        ? (error as { issues: Array<{ code: string }> }).issues[0]!.code
        : undefined;
      return { state: "unavailable", observedAt: attemptedAt, reason: code ?? "runtime_unavailable" };
    }
  };

  const [hub, runtime] = await Promise.all([readHub(), readRuntime()]);

  let runComparison: TenantRunComparison;
  if (!hub.value || !runtime.value) {
    runComparison = {
      state: "unavailable",
      reason: !hub.value ? `hub_${hub.reason ?? "unavailable"}` : `runtime_${runtime.reason ?? "unavailable"}`,
    };
  } else {
    // Only cleanly folded rows are authoritative. A row whose fold failed is the cache, and
    // counting it as agreement is precisely the lie this comparison exists to prevent: a
    // corrupt event log under a hub run's id would otherwise print "agree".
    const authoritative = new Map(
      runtime.value.runs
        .filter((run) => run.projectionError === undefined)
        .map((run) => [run.runId, run.status] as const),
    );
    const hubIds = new Set(hub.value.runs.map((run) => run.id));
    const foldFailed = runtime.value.runs.filter((run) => run.projectionError !== undefined && hubIds.has(run.runId));
    const discrepancies: TenantRunDiscrepancy[] = [];
    let matched = 0;
    for (const projected of hub.value.runs) {
      const runtimeStatus = authoritative.get(projected.id);
      if (runtimeStatus === undefined) continue;
      matched += 1;
      if (runtimeStatus !== projected.status) {
        discrepancies.push({ runId: projected.id, hubStatus: projected.status, runtimeStatus });
      }
    }
    if (matched > 0) {
      runComparison = {
        state: "compared",
        matched,
        ...(foldFailed.length > 0 ? { unverifiedFoldRuns: foldFailed.length } : {}),
        ...(discrepancies.length > 0 ? { discrepancies } : {}),
      };
    } else {
      runComparison = foldFailed.length > 0
        ? { state: "unverified", reason: "runtime_fold_failed", matched: 0, unverifiedFoldRuns: foldFailed.length }
        : { state: "unverified", reason: "run_identity_link_absent", matched: 0 };
    }
  }

  return {
    schema: TENANT_STATUS_SCHEMA,
    project: input.project,
    generatedAt: at(),
    hubUrl: input.hubUrl,
    bindingScope: hubBindingScope(input.hubUrl),
    hub,
    runtime,
    runComparison,
    degraded: hub.state !== "ok" || runtime.state !== "ok",
  };
}

/** One line per source for humans; the portal reads the JSON, operators read this. */
export function formatTenantStatus(payload: TenantStatusPayload): string {
  const hubLine = payload.hub.state === "ok" && payload.hub.value
    ? `hub ${payload.hub.value.agents.filter((agent) => agent.online).length}/${payload.hub.value.agents.length} agents online, ${payload.hub.value.runs.length} hub runs, ${payload.hub.value.openMessageTotal} open messages`
    : `hub unavailable (${payload.hub.reason ?? "unknown"})`;
  const runtimeLine = payload.runtime.state === "ok" && payload.runtime.value
    ? (() => {
      const cached = payload.runtime.value!.runs.filter((run) => run.projectionError !== undefined).length;
      const authoritative = payload.runtime.value!.runs.length - cached;
      // A fold-failed row is the cache; printing it under "authoritative" would put the
      // lie back in exactly the place an operator reads first.
      return `runtime ${authoritative} runs (authoritative, on this box)${cached > 0 ? `, ${cached} cached (fold failed, not state)` : ""}`;
    })()
    : `runtime unavailable (${payload.runtime.reason ?? "unknown"})`;
  const comparisonLine = payload.runComparison.state === "compared"
    ? payload.runComparison.discrepancies && payload.runComparison.discrepancies.length > 0
      ? `cross-check: ${payload.runComparison.discrepancies.length} of ${payload.runComparison.matched} matched run(s) disagree${payload.runComparison.unverifiedFoldRuns ? ` (${payload.runComparison.unverifiedFoldRuns} unverified: fold failed)` : ""}`
      : `cross-check: ${payload.runComparison.matched} matched run(s) agree${payload.runComparison.unverifiedFoldRuns ? ` (${payload.runComparison.unverifiedFoldRuns} unverified: fold failed)` : ""}`
    : payload.runComparison.state === "unverified"
      ? payload.runComparison.reason === "runtime_fold_failed"
        ? `cross-check: unavailable — ${payload.runComparison.unverifiedFoldRuns ?? 0} shared run(s) could not be verified (runtime fold failed)`
        : "cross-check: unavailable — no run id appears in both sources (independent id spaces)"
      : `cross-check: unavailable (${payload.runComparison.reason ?? "unknown"})`;
  return [
    `tenant ${payload.project} @ ${payload.hubUrl} (${payload.bindingScope})`,
    hubLine,
    runtimeLine,
    comparisonLine,
  ].join("\n");
}

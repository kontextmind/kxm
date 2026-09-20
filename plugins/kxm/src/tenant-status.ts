import { hubBindingScope } from "./hub-binding.ts";

export const TENANT_STATUS_SCHEMA = "kxm.tenant-status.v1" as const;

/**
 * One upstream of the tenant view, with its own reachability. A source that could not be
 * read is reported as `unavailable` with a stable reason — never silently filled from the
 * other source, because the two sources answer different questions: the hub holds
 * *metadata* (agent roster, message queue, its projection of workflow runs), the Runtime
 * holds the *authoritative* run state on the box that owns the run. Blurring them is how a
 * portal ends up rendering a projection as if it were the run itself.
 */
export type TenantSourceState = "ok" | "unavailable";

export interface TenantSource<T> {
  state: TenantSourceState;
  /** When this source was read (or attempted), so a consumer can age the data itself. */
  observedAt: string;
  /** Stable machine code (`hub_unreachable`, `runtime_supervisor_not_running`, …). */
  reason?: string;
  value?: T;
}

/** Hub-side roster summary. Presence and liveness, per the hub's own observation. */
export interface TenantHubAgents {
  online: number;
  total: number;
}

/** A run as the hub projects it. This is metadata about a run, not the run's state. */
export interface TenantHubRun {
  id: string;
  status: string;
  definitionId: string;
  currentStage?: string | undefined;
  updatedAt?: string | undefined;
  source: "hub-projection";
}

export interface TenantHubValue {
  project: string;
  fetchedAt: string;
  agents: TenantHubAgents;
  openMessageTotal: number;
  runTotal: number;
  runs: TenantHubRun[];
}

/** A run as the Runtime that owns it records it. This is the authoritative state. */
export interface TenantRuntimeRun {
  runId: string;
  status: string;
  homeRuntimeId: string;
  workflowId?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  source: "runtime-authoritative";
}

export interface TenantRuntimeValue {
  runs: TenantRuntimeRun[];
}

export interface TenantRunDiscrepancy {
  runId: string;
  hubStatus: string;
  runtimeStatus: string;
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
  /** Runs both sources know about whose recorded statuses disagree. Informational: the two
   * vocabularies are set by their owners, and a mismatch is data, not a verdict. */
  discrepancies: TenantRunDiscrepancy[];
  /** True when any source is unavailable. Assembling a payload is not the same as seeing. */
  degraded: boolean;
}

export interface TenantStatusRuntimeReader {
  listRuns(): Promise<TenantRuntimeRun[]>;
}

interface HubSnapshotBody {
  project?: unknown;
  fetchedAt?: unknown;
  agents?: unknown;
  openMessageTotal?: unknown;
  runTotal?: unknown;
  runs?: unknown;
}

function hubSourceReason(status: number): string {
  if (status === 401 || status === 403) return "hub_unauthorized";
  if (status === 404) return "hub_not_found";
  return `hub_http_${status}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Compose the tenant view from the two authorities that actually hold the data.
 *
 * The hub is read over HTTP (`/v1/ops/snapshot`, admin token); the Runtime is read through
 * an injected reader so this function stays pure and testable — the CLI passes a reader
 * that attaches to the live supervisor, and a test passes whatever it likes. Neither
 * source's failure affects the other: the payload reports both and sets `degraded`.
 */
export async function assembleTenantStatus(input: {
  project: string;
  hubUrl: string;
  token?: string | undefined;
  fetchImpl: typeof fetch;
  runtime: TenantStatusRuntimeReader;
  now?: () => Date;
}): Promise<TenantStatusPayload> {
  const now = input.now ?? ((): Date => new Date());
  const base = input.hubUrl.replace(/\/$/, "");
  const at = (): string => now().toISOString();

  let hub: TenantSource<TenantHubValue> = { state: "unavailable", observedAt: at(), reason: "hub_unreachable" };
  try {
    const response = await input.fetchImpl(`${base}/v1/ops/snapshot?project=${encodeURIComponent(input.project)}`, {
      headers: {
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      },
    });
    if (!response.ok) {
      hub = { state: "unavailable", observedAt: at(), reason: hubSourceReason(response.status) };
    } else {
      const body = (await response.json()) as HubSnapshotBody;
      const echoedProject = asString(body.project);
      if (echoedProject !== undefined && echoedProject !== input.project) {
        hub = { state: "unavailable", observedAt: at(), reason: "hub_project_mismatch" };
      } else {
        const agents = Array.isArray(body.agents) ? body.agents : [];
        const runs = (Array.isArray(body.runs) ? body.runs : []) as Array<Record<string, unknown>>;
        hub = {
          state: "ok",
          observedAt: at(),
          value: {
            project: echoedProject ?? input.project,
            fetchedAt: asString(body.fetchedAt) ?? at(),
            agents: {
              online: agents.filter((agent) => (agent as Record<string, unknown>).online === true).length,
              total: agents.length,
            },
            openMessageTotal: typeof body.openMessageTotal === "number" ? body.openMessageTotal : 0,
            runTotal: typeof body.runTotal === "number" ? body.runTotal : runs.length,
            runs: runs.map((run) => ({
              id: asString(run.id) ?? "",
              status: asString(run.status) ?? "unknown",
              definitionId: asString(run.definitionId) ?? "",
              ...(asString(run.currentStage) ? { currentStage: asString(run.currentStage) } : {}),
              ...(asString(run.updatedAt) ? { updatedAt: asString(run.updatedAt) } : {}),
              source: "hub-projection" as const,
            })),
          },
        };
      }
    }
  } catch {
    hub = { state: "unavailable", observedAt: at(), reason: "hub_unreachable" };
  }

  let runtime: TenantSource<TenantRuntimeValue> = { state: "unavailable", observedAt: at(), reason: "runtime_unavailable" };
  try {
    const runs = await input.runtime.listRuns();
    runtime = { state: "ok", observedAt: at(), value: { runs } };
  } catch (error) {
    const code = error instanceof Error && "issues" in error
      && Array.isArray((error as { issues: Array<{ code?: unknown }> }).issues)
      && typeof (error as { issues: Array<{ code?: unknown }> }).issues[0]?.code === "string"
      ? (error as { issues: Array<{ code: string }> }).issues[0]!.code
      : undefined;
    runtime = { state: "unavailable", observedAt: at(), reason: code ?? "runtime_unavailable" };
  }

  const discrepancies: TenantRunDiscrepancy[] = [];
  if (hub.value && runtime.value) {
    const authoritative = new Map(runtime.value.runs.map((run) => [run.runId, run.status] as const));
    for (const projected of hub.value.runs) {
      const runtimeStatus = authoritative.get(projected.id);
      if (runtimeStatus !== undefined && runtimeStatus !== projected.status) {
        discrepancies.push({ runId: projected.id, hubStatus: projected.status, runtimeStatus });
      }
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
    discrepancies,
    degraded: hub.state !== "ok" || runtime.state !== "ok",
  };
}

/** One line per source for humans; the portal reads the JSON, operators read this. */
export function formatTenantStatus(payload: TenantStatusPayload): string {
  const hubLine = payload.hub.state === "ok" && payload.hub.value
    ? `hub ${payload.hub.value.agents.online}/${payload.hub.value.agents.total} agents online, ${payload.hub.value.runs.length} runs (projection), ${payload.hub.value.openMessageTotal} open messages`
    : `hub unavailable (${payload.hub.reason ?? "unknown"})`;
  const runtimeLine = payload.runtime.state === "ok" && payload.runtime.value
    ? `runtime ${payload.runtime.value.runs.length} runs (authoritative, on this box)`
    : `runtime unavailable (${payload.runtime.reason ?? "unknown"})`;
  const discrepancyLine = payload.discrepancies.length > 0
    ? `${payload.discrepancies.length} run(s) disagree between hub projection and runtime state`
    : "hub projection and runtime state agree";
  return [
    `tenant ${payload.project} @ ${payload.hubUrl} (${payload.bindingScope})`,
    hubLine,
    runtimeLine,
    discrepancyLine,
  ].join("\n");
}

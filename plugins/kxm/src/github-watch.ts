import { randomUUID } from "node:crypto";
import { redactSecrets } from "./redact.ts";
import { workflowWebhookHeaders, type WorkflowEvidenceInput } from "./workflow.ts";

export type WatchStatus = "passed" | "failed" | "warning";

export interface GithubCheckRun {
  name: string;
  status: string;
  conclusion?: string | null;
  html_url?: string;
  completed_at?: string | null;
}

export interface GithubWatchInput {
  serverUrl: string;
  definitionId: string;
  signalSecret: string;
  runId: string;
  stageId: string;
  signalKey: string;
  repo: string;
  pr: number;
  required?: string[];
  timeoutMs: number;
  intervalMs: number;
  token?: string;
  deliveryId?: string;
  dryRun?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export interface GithubWatchResult {
  exitCode: number;
  posted: boolean;
  duplicate?: boolean;
  status?: WatchStatus;
  summary: string;
  evidence: WorkflowEvidenceInput;
  deliveryId?: string;
  skipped?: boolean;
}

async function fetchWithTimeout(fetchImpl: typeof fetch, input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function requiredToken(token: string | undefined): string | undefined {
  const value = token?.trim();
  return value || undefined;
}

const FAILED_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
]);
const SUCCESS_CONCLUSIONS = new Set(["success"]);
const CHECK_RUNS_PER_PAGE = 100;
const MAX_CHECK_RUN_PAGES = 100;

export function mapCheckConclusion(
  runs: GithubCheckRun[],
  required: string[] = [],
): { status: WatchStatus | "pending"; evidence: WorkflowEvidenceInput } {
  const names = required.length > 0 ? required : [...new Set(runs.map((run) => run.name))];
  const interesting = names.map((name) => runs.find((run) => run.name === name));
  const evidence = Object.fromEntries(interesting.slice(0, 32).map((run, index) => {
    const name = names[index] ?? "unknown";
    const conclusion = run?.conclusion ?? run?.status ?? "missing";
    const url = run?.html_url ? ` url:${run.html_url}` : "";
    const completed = run?.completed_at ? ` at:${run.completed_at}` : "";
    return [`github.check:${name}`, redactSecrets(`conclusion:${conclusion}${url}${completed}`).slice(0, 500)];
  }));
  if (names.length === 0 || interesting.some((run) => !run || run.status !== "completed")) {
    return { status: "pending", evidence };
  }
  if (interesting.some((run) => FAILED_CONCLUSIONS.has(run?.conclusion ?? ""))) {
    return { status: "failed", evidence };
  }
  if (interesting.every((run) => SUCCESS_CONCLUSIONS.has(run?.conclusion ?? ""))) {
    return { status: "passed", evidence };
  }
  return { status: "pending", evidence };
}

export async function postWorkflowSignal(input: {
  serverUrl: string;
  definitionId: string;
  signalSecret: string;
  runId: string;
  signalKey: string;
  status: WatchStatus;
  summary: string;
  evidence: WorkflowEvidenceInput;
  deliveryId: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ httpStatus: number; duplicate: boolean }> {
  const body = JSON.stringify({ status: input.status, summary: input.summary, evidence: input.evidence });
  const endpoint = [
    input.serverUrl.replace(/\/$/, ""),
    "v1/webhooks",
    encodeURIComponent(input.definitionId),
    "runs",
    encodeURIComponent(input.runId),
    "signals",
    encodeURIComponent(input.signalKey),
  ].join("/");
  const response = await fetchWithTimeout(input.fetchImpl ?? fetch, endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...workflowWebhookHeaders({
        secret: input.signalSecret,
        scope: { definitionId: input.definitionId, runId: input.runId, signalKey: input.signalKey },
        deliveryId: input.deliveryId,
        body,
      }),
    },
    body,
  }, input.timeoutMs ?? 15_000);
  const text = await response.text();
  let duplicate = false;
  try {
    const parsed = JSON.parse(text) as { duplicate?: boolean };
    duplicate = parsed.duplicate === true;
  } catch {
    // Non-JSON responses are treated as adapter failures below.
  }
  if (!response.ok && response.status !== 200) {
    throw new Error(`signal_http_${response.status}`);
  }
  return { httpStatus: response.status, duplicate };
}

export async function watchGithubChecks(input: GithubWatchInput): Promise<GithubWatchResult> {
  const token = requiredToken(input.token);
  if (!token) {
    return { exitCode: 1, posted: false, skipped: true, summary: "github_auth_unavailable", evidence: {} };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + input.timeoutMs;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "kxm-github-watch",
  };
  const contextEvidence: WorkflowEvidenceInput = {
    "workflow.run": input.runId,
    "workflow.stage": input.stageId,
    "workflow.signal": input.signalKey,
  };
  const explicitDeliveryId = input.deliveryId?.trim();
  const deliveryGeneration = randomUUID();
  let deliveryId = explicitDeliveryId || `github-watch:${deliveryGeneration}:pr-${input.pr}`;
  const deliver = async (
    status: WatchStatus,
    summary: string,
    evidence: WorkflowEvidenceInput,
  ): Promise<GithubWatchResult> => {
    const boundedEvidence = Object.fromEntries(Object.entries({ ...contextEvidence, ...evidence }).slice(0, 64));
    if (input.dryRun) return { exitCode: status === "failed" && summary === "github_watch_timeout" ? 4 : 0, posted: false, status, summary, evidence: boundedEvidence, deliveryId };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const posted = await postWorkflowSignal({ serverUrl: input.serverUrl, definitionId: input.definitionId, signalSecret: input.signalSecret, runId: input.runId, signalKey: input.signalKey, status, summary, evidence: boundedEvidence, deliveryId, timeoutMs: Math.min(15_000, Math.max(1_000, input.intervalMs)), fetchImpl });
        return { exitCode: status === "failed" && summary === "github_watch_timeout" ? 4 : 0, posted: true, duplicate: posted.duplicate, status, summary, evidence: boundedEvidence, deliveryId };
      } catch (error) {
        const message = error instanceof Error ? error.message : "signal_failed";
        if (/signal_http_(404|409)\b/.test(message)) return { exitCode: 1, posted: false, summary: "workflow_not_waiting", evidence: boundedEvidence, deliveryId };
        const transient = /signal_http_(429|5\d\d)\b/.test(message) || message === "signal_failed" || /abort|timeout|fetch/i.test(message);
        if (!transient || attempt === 3) return { exitCode: 1, posted: false, summary: "signal_failed", evidence: boundedEvidence, deliveryId };
        await sleep(Math.min(250 * (2 ** (attempt - 1)), 1_000));
      }
    }
    return { exitCode: 1, posted: false, summary: "signal_failed", evidence: boundedEvidence, deliveryId };
  };
  const githubGet = async (url: string): Promise<Response | undefined> => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const remaining = deadline - now();
      if (remaining <= 0) return undefined;
      try {
        const response = await fetchWithTimeout(fetchImpl, url, { headers }, Math.min(15_000, remaining));
        if (response.status !== 429 && response.status < 500) return response;
        if (attempt === 3) return response;
      } catch {
        if (attempt === 3 || now() >= deadline) return undefined;
      }
      await sleep(Math.min(250 * (2 ** (attempt - 1)), Math.max(1, deadline - now())));
    }
    return undefined;
  };
  const prResponse = await githubGet(`https://api.github.com/repos/${input.repo}/pulls/${input.pr}`);
  if (!prResponse) return deliver("failed", "github_watch_timeout", {});
  if (!prResponse.ok) {
    return { exitCode: 1, posted: false, summary: "github_pr_unavailable", evidence: { "github.http": String(prResponse.status) } };
  }
  const pull = await prResponse.json() as { head?: { sha?: string } };
  const headSha = pull.head?.sha;
  if (!headSha) {
    return { exitCode: 1, posted: false, summary: "github_head_unavailable", evidence: {} };
  }
  if (!explicitDeliveryId) deliveryId = `github-watch:${deliveryGeneration}:${headSha.slice(0, 40)}`;
  let lastEvidence: WorkflowEvidenceInput = {};
  while (now() <= deadline) {
    const checkRuns: GithubCheckRun[] = [];
    for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page += 1) {
      const checksUrl = new URL(`https://api.github.com/repos/${input.repo}/commits/${headSha}/check-runs`);
      checksUrl.searchParams.set("per_page", String(CHECK_RUNS_PER_PAGE));
      checksUrl.searchParams.set("page", String(page));
      const checksResponse = await githubGet(checksUrl.toString());
      if (!checksResponse) return deliver("failed", "github_watch_timeout", lastEvidence);
      if (!checksResponse.ok) {
        return { exitCode: 1, posted: false, summary: "github_checks_unavailable", evidence: { "github.http": String(checksResponse.status) } };
      }
      const payload = await checksResponse.json() as { total_count?: number; check_runs?: GithubCheckRun[] };
      const pageRuns = Array.isArray(payload.check_runs) ? payload.check_runs : [];
      checkRuns.push(...pageRuns);
      const totalCount = Number.isInteger(payload.total_count) && payload.total_count! >= 0
        ? payload.total_count!
        : undefined;
      const complete = totalCount === undefined
        ? pageRuns.length < CHECK_RUNS_PER_PAGE
        : checkRuns.length >= totalCount;
      if (complete) break;
      if (pageRuns.length === 0 || page === MAX_CHECK_RUN_PAGES) {
        return {
          exitCode: 1,
          posted: false,
          summary: "github_checks_unavailable",
          evidence: { "github.pagination": pageRuns.length === 0 ? "incomplete" : "limit_exceeded" },
        };
      }
    }
    const mapped = mapCheckConclusion(checkRuns, input.required ?? []);
    lastEvidence = mapped.evidence;
    if (mapped.status !== "pending") {
      const summary = mapped.status === "passed" ? "required GitHub checks passed" : "required GitHub checks failed";
      return deliver(mapped.status, summary, mapped.evidence);
    }
    if (now() + input.intervalMs > deadline) break;
    await sleep(input.intervalMs);
  }
  return deliver("failed", "github_watch_timeout", lastEvidence);
}

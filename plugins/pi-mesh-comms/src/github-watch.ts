import { createHmac } from "node:crypto";
import { redactSecrets } from "./redact.ts";

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
  signalKey: string;
  repo: string;
  pr: number;
  required?: string[];
  timeoutMs: number;
  intervalMs: number;
  token?: string;
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
  evidence: string[];
  deliveryId?: string;
  skipped?: boolean;
}

function requiredToken(token: string | undefined): string | undefined {
  const value = token?.trim();
  return value || undefined;
}

const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "stale"]);
const SUCCESS_CONCLUSIONS = new Set(["success"]);

export function mapCheckConclusion(runs: GithubCheckRun[], required: string[] = []): { status: WatchStatus | "pending"; evidence: string[] } {
  const names = required.length > 0 ? required : [...new Set(runs.map((run) => run.name))];
  const interesting = names.map((name) => runs.find((run) => run.name === name));
  const evidence = interesting.slice(0, 32).map((run, index) => {
    const name = names[index] ?? "unknown";
    const conclusion = run?.conclusion ?? run?.status ?? "missing";
    const url = run?.html_url ? ` url:${run.html_url}` : "";
    const completed = run?.completed_at ? ` at:${run.completed_at}` : "";
    return redactSecrets(`conclusion:${name}=${conclusion}${url}${completed}`);
  });
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
  evidence: string[];
  deliveryId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ httpStatus: number; duplicate: boolean }> {
  const body = JSON.stringify({ status: input.status, summary: input.summary, evidence: input.evidence });
  const signature = `sha256=${createHmac("sha256", input.signalSecret).update(body).digest("hex")}`;
  const endpoint = [
    input.serverUrl.replace(/\/$/, ""),
    "v1/webhooks",
    encodeURIComponent(input.definitionId),
    "runs",
    encodeURIComponent(input.runId),
    "signals",
    encodeURIComponent(input.signalKey),
  ].join("/");
  const response = await (input.fetchImpl ?? fetch)(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-mesh-delivery-id": input.deliveryId,
    },
    body,
  });
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
    return { exitCode: 1, posted: false, skipped: true, summary: "github_auth_unavailable", evidence: [] };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + input.timeoutMs;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "pi-mesh-github-watch",
  };
  const prResponse = await fetchImpl(`https://api.github.com/repos/${input.repo}/pulls/${input.pr}`, { headers });
  if (!prResponse.ok) {
    return { exitCode: 1, posted: false, summary: "github_pr_unavailable", evidence: [`http:${prResponse.status}`] };
  }
  const pull = await prResponse.json() as { head?: { sha?: string } };
  const headSha = pull.head?.sha;
  if (!headSha) {
    return { exitCode: 1, posted: false, summary: "github_head_unavailable", evidence: [] };
  }
  let lastEvidence: string[] = [];
  while (now() <= deadline) {
    const checksResponse = await fetchImpl(
      `https://api.github.com/repos/${input.repo}/commits/${headSha}/check-runs`,
      { headers },
    );
    if (!checksResponse.ok) {
      return { exitCode: 1, posted: false, summary: "github_checks_unavailable", evidence: [`http:${checksResponse.status}`] };
    }
    const payload = await checksResponse.json() as { check_runs?: GithubCheckRun[] };
    const mapped = mapCheckConclusion(payload.check_runs ?? [], input.required ?? []);
    lastEvidence = mapped.evidence;
    if (mapped.status !== "pending") {
      const deliveryId = `github-watch:${input.runId}:${input.signalKey}:${input.pr}:${headSha}`;
      const summary = mapped.status === "passed" ? "required GitHub checks passed" : "required GitHub checks failed";
      if (input.dryRun) {
        return { exitCode: 0, posted: false, status: mapped.status, summary, evidence: mapped.evidence, deliveryId };
      }
      try {
        const posted = await postWorkflowSignal({
          serverUrl: input.serverUrl,
          definitionId: input.definitionId,
          signalSecret: input.signalSecret,
          runId: input.runId,
          signalKey: input.signalKey,
          status: mapped.status,
          summary,
          evidence: mapped.evidence,
          deliveryId,
          fetchImpl,
        });
        return {
          exitCode: 0,
          posted: true,
          duplicate: posted.duplicate,
          status: mapped.status,
          summary,
          evidence: mapped.evidence,
          deliveryId,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "signal_failed";
        const stale = message.includes("409") || message.includes("404") || /signal_http_409|signal_http_404/.test(message);
        return { exitCode: 1, posted: false, summary: stale ? "workflow_not_waiting" : "signal_failed", evidence: mapped.evidence };
      }
    }
    if (now() + input.intervalMs > deadline) break;
    await sleep(input.intervalMs);
  }
  return { exitCode: 4, posted: false, summary: "github_watch_timeout", evidence: lastEvidence };
}

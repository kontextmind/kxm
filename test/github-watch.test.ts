import assert from "node:assert/strict";
import test from "node:test";
import { mapCheckConclusion, watchGithubChecks } from "../plugins/kxm/src/github-watch.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("maps required check conclusions", () => {
  assert.equal(mapCheckConclusion([{ name: "ci", status: "completed", conclusion: "success" }]).status, "passed");
  assert.equal(mapCheckConclusion([{ name: "ci", status: "in_progress" }]).status, "pending");
  assert.equal(mapCheckConclusion([{ name: "ci", status: "completed", conclusion: "failure" }]).status, "failed");
  assert.equal(mapCheckConclusion([{ name: "ci", status: "completed", conclusion: "startup_failure" }]).status, "failed");
  assert.equal(mapCheckConclusion([{ name: "ci", status: "completed", conclusion: "skipped" }]).status, "pending");
  assert.equal(mapCheckConclusion([{ name: "ci", status: "completed", conclusion: "neutral" }]).status, "pending");
  assert.equal(mapCheckConclusion([{ name: "other", status: "completed", conclusion: "success" }], ["ci"]).status, "pending");
  assert.equal(mapCheckConclusion(
    [{ name: "ci", status: "completed", conclusion: "success" }, { name: "other", status: "in_progress" }],
    ["ci"],
  ).status, "passed");
  assert.equal(
    mapCheckConclusion([{ name: "ci", status: "completed", conclusion: "success", html_url: "https://example.test/ci" }], ["ci"])
      .evidence["github.check:ci"],
    "conclusion:success url:https://example.test/ci",
  );
});

test("watch requests 100 check runs per page and finds required checks after page one", async () => {
  const requestedPages: number[] = [];
  const result = await watchGithubChecks({
    serverUrl: "http://127.0.0.1:9",
    definitionId: "wf",
    signalSecret: "signal-secret-16chars",
    runId: "run_paginated",
    stageId: "review",
    signalKey: "pr-4-checks",
    repo: "acme/app",
    pr: 4,
    required: ["required-after-page-one"],
    timeoutMs: 1_000,
    intervalMs: 10,
    token: "ghs_test_token_not_logged",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("/pulls/4")) return jsonResponse(200, { head: { sha: "page123" } });
      if (url.includes("/check-runs")) {
        const parsed = new URL(url);
        assert.equal(parsed.searchParams.get("per_page"), "100");
        const page = Number(parsed.searchParams.get("page"));
        requestedPages.push(page);
        return page === 1
          ? jsonResponse(200, {
            total_count: 101,
            check_runs: Array.from({ length: 100 }, (_, index) => ({
              name: `other-${index}`,
              status: "completed",
              conclusion: "success",
            })),
          })
          : jsonResponse(200, {
            total_count: 101,
            check_runs: [{ name: "required-after-page-one", status: "completed", conclusion: "success" }],
          });
      }
      if (url.includes("/signals/")) return jsonResponse(202, { duplicate: false });
      return jsonResponse(404, {});
    },
  });
  assert.equal(result.status, "passed");
  assert.deepEqual(requestedPages, [1, 2]);
  assert.match(result.evidence["github.check:required-after-page-one"]!, /conclusion:success/);
});

test("each watcher invocation uses a new delivery generation for fail then re-wait and pass", async () => {
  let conclusion = "failure";
  const deliveries = new Map<string, string>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/pulls/5")) return jsonResponse(200, { head: { sha: "same-head" } });
    if (url.includes("/check-runs")) {
      return jsonResponse(200, {
        total_count: 1,
        check_runs: [{ name: "ci", status: "completed", conclusion }],
      });
    }
    if (url.includes("/signals/")) {
      const deliveryId = new Headers(init?.headers).get("x-kxm-delivery-id") ?? "";
      const body = String(init?.body ?? "");
      const previous = deliveries.get(deliveryId);
      if (previous !== undefined && previous !== body) return jsonResponse(409, { code: "workflow_signal_delivery_conflict" });
      deliveries.set(deliveryId, body);
      return jsonResponse(202, { duplicate: previous !== undefined });
    }
    return jsonResponse(404, {});
  };
  const input = {
    serverUrl: "http://127.0.0.1:9",
    definitionId: "wf",
    signalSecret: "signal-secret-16chars",
    runId: "run_generation",
    stageId: "review",
    signalKey: "same-signal-key",
    repo: "acme/app",
    pr: 5,
    required: ["ci"],
    timeoutMs: 1_000,
    intervalMs: 10,
    token: "ghs_test_token_not_logged",
    fetchImpl,
  };
  const failed = await watchGithubChecks(input);
  assert.equal(failed.status, "failed");
  conclusion = "success";
  const passed = await watchGithubChecks(input);
  assert.equal(passed.status, "passed");
  assert.notEqual(failed.deliveryId, passed.deliveryId);
  assert.equal(deliveries.size, 2);
  assert.ok([...deliveries.keys()].every((deliveryId) => /^github-watch:[0-9a-f-]{36}:same-head$/.test(deliveryId)));
});

test("watch posts passed and treats duplicate delivery as success", async () => {
  const calls: string[] = [];
  const result = await watchGithubChecks({
    serverUrl: "http://127.0.0.1:9",
    definitionId: "wf",
    signalSecret: "signal-secret-16chars",
    runId: "run_1",
    stageId: "review",
    signalKey: "pr-1-checks",
    repo: "acme/app",
    pr: 1,
    timeoutMs: 1_000,
    intervalMs: 10,
    token: "ghs_test_token_not_logged",
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/pulls/1")) return jsonResponse(200, { head: { sha: "abc123" } });
      if (url.includes("/check-runs")) {
        return jsonResponse(200, { check_runs: [{ name: "ci", status: "completed", conclusion: "success", html_url: "https://example.test/ci" }] });
      }
      if (url.includes("/signals/")) return jsonResponse(200, { duplicate: true });
      return jsonResponse(404, {});
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.posted, true);
  assert.equal(result.duplicate, true);
  assert.equal(result.status, "passed");
  assert.ok(calls.some((url) => url.includes("/signals/")));
  assert.doesNotMatch(JSON.stringify(result), /ghs_test_token_not_logged/);
});

test("watch timeout posts an exact failed workflow signal", async () => {
  let now = 0;
  let posts = 0;
  const result = await watchGithubChecks({
    serverUrl: "http://127.0.0.1:9",
    definitionId: "wf",
    signalSecret: "signal-secret-16chars",
    runId: "run_1",
    stageId: "review",
    signalKey: "pr-1-checks",
    repo: "acme/app",
    pr: 1,
    timeoutMs: 20,
    intervalMs: 10,
    token: "ghs_test_token_not_logged",
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("/pulls/1")) return jsonResponse(200, { head: { sha: "abc123" } });
      if (url.includes("/check-runs")) return jsonResponse(200, { check_runs: [{ name: "ci", status: "in_progress" }] });
      posts += 1;
      return jsonResponse(202, {});
    },
  });
  assert.equal(result.exitCode, 4);
  assert.equal(result.posted, true);
  assert.equal(posts, 1);
  assert.equal(result.status, "failed");
  assert.equal(result.summary, "github_watch_timeout");
  assert.equal(result.evidence["workflow.run"], "run_1");
  assert.equal(result.evidence["workflow.stage"], "review");
  assert.equal(result.evidence["workflow.signal"], "pr-1-checks");
  assert.equal(result.evidence["github.check:ci"], "conclusion:in_progress");
});

test("missing GitHub auth does not print a token", async () => {
  const result = await watchGithubChecks({
    serverUrl: "http://127.0.0.1:9",
    definitionId: "wf",
    signalSecret: "signal-secret-16chars",
    runId: "run_1",
    stageId: "review",
    signalKey: "pr-1-checks",
    repo: "acme/app",
    pr: 1,
    timeoutMs: 10,
    intervalMs: 10,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.skipped, true);
  assert.equal(result.summary, "github_auth_unavailable");
});

test("stale workflow signal is a terminal adapter error", async () => {
  const result = await watchGithubChecks({
    serverUrl: "http://127.0.0.1:9",
    definitionId: "wf",
    signalSecret: "signal-secret-16chars",
    runId: "run_1",
    stageId: "review",
    signalKey: "pr-1-checks",
    repo: "acme/app",
    pr: 1,
    timeoutMs: 1_000,
    intervalMs: 10,
    token: "ghs_test_token_not_logged",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("/pulls/1")) return jsonResponse(200, { head: { sha: "abc123" } });
      if (url.includes("/check-runs")) {
        return jsonResponse(200, { check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] });
      }
      return jsonResponse(409, { code: "workflow_not_waiting" });
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.posted, false);
  assert.equal(result.summary, "workflow_not_waiting");
});

test("signal delivery retries transient hub failures with a stable delivery id", async () => {
  const deliveries: string[] = [];
  let posts = 0;
  const result = await watchGithubChecks({
    serverUrl: "http://127.0.0.1:9",
    definitionId: "wf",
    signalSecret: "signal-secret-16chars",
    runId: "run_retry",
    stageId: "review",
    signalKey: "pr-2-checks",
    repo: "acme/app",
    pr: 2,
    timeoutMs: 1_000,
    intervalMs: 10,
    token: "ghs_test_token_not_logged",
    sleep: async () => {},
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.includes("/pulls/2")) return jsonResponse(200, { head: { sha: "def456" } });
      if (url.includes("/check-runs")) return jsonResponse(200, { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] });
      posts += 1;
      deliveries.push(new Headers(init?.headers).get("x-kxm-delivery-id") ?? "");
      return posts === 1 ? jsonResponse(503, {}) : jsonResponse(202, { duplicate: false });
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(posts, 2);
  assert.equal(new Set(deliveries).size, 1);
  assert.match(deliveries[0]!, /^github-watch:[0-9a-f-]{36}:def456$/);
});

test("a stalled GitHub request is aborted and posts the required timeout signal", async () => {
  let postedBody = "";
  const result = await watchGithubChecks({
    serverUrl: "http://127.0.0.1:9",
    definitionId: "wf",
    signalSecret: "signal-secret-16chars",
    runId: "run_stalled",
    stageId: "review",
    signalKey: "pr-3-checks",
    repo: "acme/app",
    pr: 3,
    timeoutMs: 25,
    intervalMs: 10,
    token: "ghs_test_token_not_logged",
    fetchImpl: async (input, init) => {
      if (!String(input).startsWith("https://api.github.com/")) {
        postedBody = String(init?.body ?? "");
        return jsonResponse(202, { duplicate: false });
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    },
  });
  assert.equal(result.exitCode, 4);
  assert.equal(result.posted, true);
  assert.equal(result.summary, "github_watch_timeout");
  assert.match(postedBody, /"status":"failed"/);
  assert.match(postedBody, /github_watch_timeout/);
});

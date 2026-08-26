import assert from "node:assert/strict";
import test from "node:test";
import { mapCheckConclusion, watchGithubChecks } from "../plugins/pi-mesh-comms/src/github-watch.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("maps required check conclusions", () => {
  assert.equal(mapCheckConclusion([{ name: "ci", status: "completed", conclusion: "success" }]).status, "passed");
  assert.equal(mapCheckConclusion([{ name: "ci", status: "in_progress" }]).status, "pending");
  assert.equal(mapCheckConclusion([{ name: "ci", status: "completed", conclusion: "failure" }]).status, "failed");
  assert.equal(mapCheckConclusion([{ name: "ci", status: "completed", conclusion: "skipped" }]).status, "pending");
  assert.equal(mapCheckConclusion([{ name: "ci", status: "completed", conclusion: "neutral" }]).status, "pending");
  assert.equal(mapCheckConclusion([{ name: "other", status: "completed", conclusion: "success" }], ["ci"]).status, "pending");
  assert.equal(mapCheckConclusion(
    [{ name: "ci", status: "completed", conclusion: "success" }, { name: "other", status: "in_progress" }],
    ["ci"],
  ).status, "passed");
});

test("watch posts passed and treats duplicate delivery as success", async () => {
  const calls: string[] = [];
  const result = await watchGithubChecks({
    serverUrl: "http://127.0.0.1:9",
    definitionId: "wf",
    signalSecret: "signal-secret-16chars",
    runId: "run_1",
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

test("watch timeout does not post a signal", async () => {
  let now = 0;
  let posts = 0;
  const result = await watchGithubChecks({
    serverUrl: "http://127.0.0.1:9",
    definitionId: "wf",
    signalSecret: "signal-secret-16chars",
    runId: "run_1",
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
  assert.equal(result.posted, false);
  assert.equal(posts, 0);
  assert.equal(result.summary, "github_watch_timeout");
});

test("missing GitHub auth does not print a token", async () => {
  const result = await watchGithubChecks({
    serverUrl: "http://127.0.0.1:9",
    definitionId: "wf",
    signalSecret: "signal-secret-16chars",
    runId: "run_1",
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

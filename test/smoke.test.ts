import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
// The production harness is JavaScript so it can run directly on a bare Pi runner.
// @ts-expect-error The harness intentionally has no separate declaration artifact.
import { boundedSafeMessage, buildSmokeRequest, parseSmokeModels, runSmokePhases } from "../scripts/smoke-multi-pi.mjs";

const script = resolve("scripts/smoke-multi-pi.mjs");

test("real Pi smoke remains opt-in in ordinary test runs", () => {
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, PI_MESH_SMOKE: "0" },
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    ok: true,
    skipped: true,
    reason: "PI_MESH_SMOKE is not 1",
  });
});

test("real Pi smoke rejects an enabled run without two configured models", () => {
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, PI_MESH_SMOKE: "1", PI_MESH_SMOKE_MODELS: "one/model" },
  });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout.trim()) as { ok: boolean; skipped: boolean; error: string };
  assert.equal(output.ok, false);
  assert.equal(output.skipped, false);
  assert.match(output.error, /at least two distinct models/);
});

test("smoke model parsing is stable and output sanitization is bounded", () => {
  assert.deepEqual(parseSmokeModels(" xai/grok, anthropic/claude, xai/grok , "), [
    "xai/grok",
    "anthropic/claude",
  ]);
  const secret = "test-secret-value-123456789";
  const safe = boundedSafeMessage(`failed with ${secret} and sk-live-12345678901234567890${"x".repeat(1_000)}`, [secret]);
  assert.ok(safe.length <= 500);
  assert.doesNotMatch(safe, /test-secret-value/);
  assert.doesNotMatch(safe, /sk-live/);
});

test("real Pi smoke does not couple message TTL to its local phase timeout", () => {
  assert.deepEqual(buildSmokeRequest("reviewer", "Review this", "review-1"), {
    target: "reviewer",
    content: "Review this",
    delivery: "followUp",
    idempotencyKey: "review-1",
  });
  assert.equal("ttlMs" in buildSmokeRequest("reviewer", "Review this", "review-1"), false);
});

test("smoke phases run in order, pass prior results, and always clean up on failure", async () => {
  const events: string[] = [];
  const successful = await runSmokePhases([
    ["discovery", async () => { events.push("discovery"); return ["alpha", "beta"]; }],
    ["restart", async (values: Record<string, unknown>) => { events.push(`restart:${(values.discovery as string[]).join(",")}`); return "resumed"; }],
    ["post-restart", async (values: Record<string, unknown>) => { events.push(`exchange:${values.restart}`); return true; }],
  ], async () => { events.push("cleanup-success"); });
  assert.deepEqual(successful.completed, ["discovery", "restart", "post-restart"]);
  assert.deepEqual(events, ["discovery", "restart:alpha,beta", "exchange:resumed", "cleanup-success"]);

  const failedEvents: string[] = [];
  await assert.rejects(() => runSmokePhases([
    ["start", async () => { failedEvents.push("start"); return true; }],
    ["restart", async () => { failedEvents.push("restart"); throw new Error("restart failed"); }],
    ["never", async () => { failedEvents.push("never"); }],
  ], async () => { failedEvents.push("cleanup-failure"); }), /restart failed/);
  assert.deepEqual(failedEvents, ["start", "restart", "cleanup-failure"]);
});

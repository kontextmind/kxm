import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKER_RESULT_SCHEMA,
  WORKER_SCHEMA,
  agentWorker,
  gateWorker,
  workerResult,
} from "../plugins/kxm/src/envelope.ts";

test("workerResult hub-owned keys cannot be clobbered by additive payload fields", () => {
  const agent = agentWorker({ name: "kimi", project: "payk12", model: "kimi-coding/k3" });
  const hostile = {
    schema: "kxm.forged.v9",
    worker: { schema: WORKER_SCHEMA, kind: "gate", driver: "code", name: "forged-gate" },
  };
  const payload = { ...hostile, command: "cross", ok: true, summary: "real summary" } as unknown as {
    command: string;
    ok: boolean;
    summary: string;
  };
  const result = workerResult(agent, payload);

  assert.equal(result.schema, WORKER_RESULT_SCHEMA);
  assert.equal(result.worker.schema, WORKER_SCHEMA);
  assert.equal(result.worker.kind, "agent");
  assert.equal(result.worker.name, "kimi");
  assert.equal(result.summary, "real summary");
  assert.equal(result.outcome, "passed");
  assert.equal(result.command, "cross");
  assert.equal(result.ok, true);
});

test("workerResult preserves a caller-owned createdAt", () => {
  const createdAt = "1970-01-01T00:00:00.000Z";
  const result = workerResult(agentWorker({ name: "kimi" }), {
    command: "cross",
    ok: true,
    summary: "deterministic result",
    createdAt,
  });
  assert.equal(result.createdAt, createdAt);
});

test("workerResult throws when an explicit outcome contradicts ok", () => {
  const agent = agentWorker({ name: "kimi" });
  const gate = gateWorker({ name: "validate" });

  assert.throws(
    () => workerResult(agent, { command: "c", ok: false, summary: "s", outcome: "passed" }),
    /contradicts ok/,
  );
  assert.throws(
    () => workerResult(gate, { command: "c", ok: true, summary: "s", outcome: "failed" }),
    /contradicts ok/,
  );
});

test("workerResult allows warning and running with either ok value", () => {
  const agent = agentWorker({ name: "kimi" });
  assert.equal(workerResult(agent, { command: "c", ok: true, summary: "s", outcome: "warning" }).outcome, "warning");
  assert.equal(workerResult(agent, { command: "c", ok: false, summary: "s", outcome: "warning" }).outcome, "warning");
  assert.equal(workerResult(agent, { command: "c", ok: true, summary: "s", outcome: "running" }).outcome, "running");
  assert.equal(workerResult(agent, { command: "c", ok: false, summary: "s", outcome: "running" }).outcome, "running");
});

test("workerResult keeps the default outcome mapping and additive fields", () => {
  const gate = gateWorker({ name: "artifacts-exist" });
  const passed = workerResult(gate, {
    command: "artifacts-exist",
    ok: true,
    summary: "all present",
    artifacts: [".kxm/assets/x/plan.md"],
  });
  assert.equal(passed.outcome, "passed");
  assert.equal(passed.ok, true);
  assert.deepEqual(passed.artifacts, [".kxm/assets/x/plan.md"]);

  const failed = workerResult(gate, { command: "artifacts-exist", ok: false, summary: "missing plan.md" });
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.ok, false);
});

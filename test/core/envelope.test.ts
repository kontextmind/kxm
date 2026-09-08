import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKER_RESULT_SCHEMA,
  WORKER_SCHEMA,
  agentWorker,
  gateWorker,
  workerResult,
} from "../../plugins/kxm/src/envelope.ts";

test("agents and gates share the worker base and result envelope", () => {
  const agent = agentWorker({ name: "coordinator", project: "demo", model: "xai/grok-4.6" });
  const gate = gateWorker({ name: "validate", project: "demo" });

  assert.equal(agent.schema, WORKER_SCHEMA);
  assert.equal(gate.schema, WORKER_SCHEMA);
  assert.equal(agent.kind, "agent");
  assert.equal(agent.driver, "ai");
  assert.equal(gate.kind, "gate");
  assert.equal(gate.driver, "code");

  const agentResult = workerResult(agent, { ok: true, command: "worker", summary: "would start worker" });
  const gateResult = workerResult(gate, { ok: false, command: "validate", summary: "missing file", error: "file_not_found" });

  assert.equal(agentResult.schema, WORKER_RESULT_SCHEMA);
  assert.equal(gateResult.schema, WORKER_RESULT_SCHEMA);
  assert.equal(agentResult.worker.schema, WORKER_SCHEMA);
  assert.equal(gateResult.worker.schema, WORKER_SCHEMA);
  assert.equal(agentResult.worker.kind, "agent");
  assert.equal(gateResult.worker.kind, "gate");
  assert.equal(agentResult.outcome, "passed");
  assert.equal(gateResult.outcome, "failed");
  assert.equal(agentResult.ok, true);
  assert.equal(gateResult.ok, false);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkerResultEnvelope } from "../plugins/kxm-mesh/src/envelope.ts";
import {
  appendTelemetry,
  inferImprovementTarget,
  makeTelemetryEvent,
  readTelemetry,
  telemetryPath,
} from "../plugins/kxm-mesh/src/telemetry.ts";

const envelope = {
  schema: "kxm.worker-result.v1",
  worker: { schema: "kxm.worker.v1", kind: "gate", driver: "code", name: "validate" },
  command: "validate",
  ok: true,
  outcome: "passed",
  createdAt: "2026-08-28T00:00:00.000Z",
  summary: "validated",
} as WorkerResultEnvelope;

test("improvement telemetry classifies every named project generically and honors an explicit target", () => {
  assert.equal(inferImprovementTarget({ project: "any-product" }), "project");
  assert.equal(inferImprovementTarget({ workflowId: "release-review" }), "project");
  assert.equal(inferImprovementTarget({ env: { PI_MESH_PROJECT: "from-env" } }), "project");
  assert.equal(inferImprovementTarget({}), "cli");
  assert.equal(inferImprovementTarget({ project: "product", env: { KXM_IMPROVE_TARGET: "cli" } }), "cli");
  assert.equal(inferImprovementTarget({ env: { KXM_IMPROVE_TARGET: "project" } }), "project");
});

test("telemetry JSONL persists valid events and skips malformed lines", () => {
  const directory = mkdtempSync(join(tmpdir(), "kxm-telemetry-"));
  try {
    const path = telemetryPath(directory);
    const event = makeTelemetryEvent({ envelope, target: "project", sessionId: "session-1" });
    appendTelemetry(path, event);
    assert.deepEqual(readTelemetry(path), [event]);
    writeFileSync(path, `not-json\n${JSON.stringify(event)}\n`, "utf8");
    assert.deepEqual(readTelemetry(path), [event]);
    assert.deepEqual(readTelemetry(join(directory, "missing.jsonl")), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

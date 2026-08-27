import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyFailure,
  diagnosticEvidence,
  diagnosticSummary,
  operationForTool,
} from "../plugins/kxm-mesh/src/diagnostics.ts";
import { looksLikeSecret, redactSecrets } from "../plugins/kxm-mesh/src/redact.ts";

test("classifies workflow scope and identity failures without copying raw output", () => {
  const forbidden = classifyFailure({
    toolName: "mesh_workflow_get",
    code: "workflow_forbidden",
    statusCode: 403,
    message: "workflow run is not visible to this agent and contains sk-secretvalue",
    assignedCoordinatorName: "coordinator",
  });
  assert.equal(forbidden.class, "workflow_scope");
  assert.equal(forbidden.operation, "get");
  assert.equal(forbidden.nextAction, "use_assigned_coordinator");
  assert.equal(diagnosticSummary(forbidden), "Tool mesh_workflow_get failed: workflow_scope; assigned coordinator: coordinator; next action: use_assigned_coordinator");
  assert.deepEqual(diagnosticEvidence(forbidden, "call-1"), [
    "tool:mesh_workflow_get",
    "tool-call:call-1",
    "class:workflow_scope",
    "operation:get",
    "code:workflow_forbidden",
    "nextAction:use_assigned_coordinator",
    "assignedCoordinator:coordinator",
  ]);
  assert.doesNotMatch(JSON.stringify(forbidden), /sk-secretvalue/);
});

test("maps token classes from bounded failure text", () => {
  assert.equal(classifyFailure({ toolName: "bash", message: "ENOENT" }).class, "command_not_found");
  assert.equal(classifyFailure({ toolName: "bash", message: "error TS2304" }).class, "typecheck_error");
  assert.equal(classifyFailure({ toolName: "bash", message: "AssertionError: not equal" }).class, "test_failure");
  assert.equal(classifyFailure({ toolName: "mesh_await", message: "timed out waiting" }).class, "timeout");
  assert.equal(classifyFailure({ toolName: "mesh_await", message: "await cancelled" }).class, "cancelled");
  assert.equal(classifyFailure({ code: "invalid_agent_identity" }).class, "invalid_identity");
  assert.equal(classifyFailure({ code: "invalid_auth" }).nextAction, "check_project_token");
  assert.equal(classifyFailure({ code: "workflow_not_waiting", toolName: "mesh_workflow_checkpoint" }).class, "not_waiting");
  assert.equal(classifyFailure({ toolName: "provider", message: "Quota reached. Please wait." }).class, "quota");
  assert.equal(classifyFailure({ toolName: "provider", code: "provider_error" }).nextAction, "switch_model_or_retry");
  assert.equal(operationForTool("mesh_workflow_record"), "journal");
});

test("parses coordinator and recovery guidance from bounded extension errors", () => {
  const diagnostic = classifyFailure({
    toolName: "mesh_workflow_checkpoint",
    code: "workflow_forbidden",
    message: "not visible [assignedCoordinator=lead-agent nextAction=use_assigned_coordinator]",
  });
  assert.equal(diagnostic.assignedCoordinatorName, "lead-agent");
  assert.equal(diagnostic.nextAction, "use_assigned_coordinator");
  assert.match(diagnosticSummary(diagnostic), /lead-agent/);
});

test("redacts tokens and long hex dumps", () => {
  const text = "Authorization Bearer abcdef.token ghp_abcdefghijklmnopqrstuv sk-abcdefgh PI_MESH_AUTH_TOKEN=supersecret";
  const redacted = redactSecrets(text);
  assert.match(redacted, /\[redacted\]/);
  assert.equal(looksLikeSecret(text), true);
  assert.doesNotMatch(redacted, /supersecret/);
  assert.doesNotMatch(redacted, /ghp_/);
});

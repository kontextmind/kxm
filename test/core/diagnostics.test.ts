import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyFailure,
  diagnosticEvidence,
  diagnosticSummary,
  operationForTool,
} from "../../plugins/kxm/src/diagnostics.ts";
import { looksLikeSecret, redactSecrets } from "../../plugins/kxm/src/redact.ts";

test("classifies workflow scope and identity failures without copying raw output", () => {
  const forbidden = classifyFailure({
    toolName: "kxm_workflow_get",
    code: "workflow_forbidden",
    statusCode: 403,
    message: "workflow run is not visible to this agent and contains sk-secretvalue",
    assignedCoordinatorName: "coordinator",
  });
  assert.equal(forbidden.class, "workflow_scope");
  assert.equal(forbidden.operation, "get");
  assert.equal(forbidden.nextAction, "use_assigned_coordinator");
  assert.equal(diagnosticSummary(forbidden), "Tool kxm_workflow_get failed: workflow_scope; assigned coordinator: coordinator; next action: use_assigned_coordinator");
  assert.deepEqual(diagnosticEvidence(forbidden, "call-1"), [
    "tool:kxm_workflow_get",
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
  assert.equal(classifyFailure({ toolName: "kxm_await", message: "timed out waiting" }).class, "timeout");
  assert.equal(classifyFailure({ toolName: "kxm_await", message: "await cancelled" }).class, "cancelled");
  assert.equal(classifyFailure({ code: "invalid_agent_identity" }).class, "invalid_identity");
  assert.equal(classifyFailure({ code: "invalid_auth" }).nextAction, "check_project_token");
  assert.equal(classifyFailure({ code: "workflow_not_waiting", toolName: "kxm_workflow_checkpoint" }).class, "not_waiting");
  assert.equal(classifyFailure({ toolName: "provider", message: "Quota reached. Please wait." }).class, "quota");
  assert.equal(classifyFailure({ toolName: "provider", code: "provider_error" }).nextAction, "switch_model_or_retry");
  assert.equal(operationForTool("kxm_workflow_record"), "journal");
});

test("parses coordinator and recovery guidance from bounded extension errors", () => {
  const diagnostic = classifyFailure({
    toolName: "kxm_workflow_checkpoint",
    code: "workflow_forbidden",
    message: "not visible [assignedCoordinator=lead-agent nextAction=use_assigned_coordinator]",
  });
  assert.equal(diagnostic.assignedCoordinatorName, "lead-agent");
  assert.equal(diagnostic.nextAction, "use_assigned_coordinator");
  assert.match(diagnosticSummary(diagnostic), /lead-agent/);
});

test("redacts tokens and long hex dumps", () => {
  const text = "Authorization Bearer abcdef.token ghp_abcdefghijklmnopqrstuv sk-abcdefgh KXM_AUTH_TOKEN=supersecret";
  const redacted = redactSecrets(text);
  assert.match(redacted, /\[redacted\]/);
  assert.equal(looksLikeSecret(text), true);
  assert.doesNotMatch(redacted, /supersecret/);
  assert.doesNotMatch(redacted, /ghp_/);
});

test("redacts Google OAuth access and refresh tokens", () => {
  const text = 'Authorization: Bearer ya29.a0AfH6-googleapis access_token="ya29.secret" refresh=1/0gK8abcdefghijklmnopqrstuvwxyzABCD google=1//0eA7abcdefghijklmnopqrstuvwxyzABCD';
  const redacted = redactSecrets(text);
  assert.equal(looksLikeSecret(text), true);
  assert.doesNotMatch(redacted, /ya29\.[A-Za-z0-9]/);
  assert.doesNotMatch(redacted, /1\/0gK8abcdefghijklmnopqrstuvwxyzABCD/);
  assert.doesNotMatch(redacted, /1\/\/0eA7abcdefghijklmnopqrstuvwxyzABCD/);
});

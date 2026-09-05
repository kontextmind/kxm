import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piMeshExtension, { bindingForMessage, workflowRunIdForMessage } from "../plugins/kxm/src/extension.ts";
import { recoveryEnvelopePath, workerStateKey } from "../plugins/kxm/src/recovery.ts";
import { SESSION_BRIEF_SKIP_LABEL } from "../plugins/kxm/src/session-work.ts";
import { createTestMesh, waitFor } from "./helpers.ts";

type EventHandler = (...args: unknown[]) => unknown | Promise<unknown>;
type Tool = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute: (...args: unknown[]) => Promise<{ details: unknown }>;
};
type Command = {
  handler: (...args: unknown[]) => unknown | Promise<unknown>;
};

function fakePi() {
  const handlers = new Map<string, EventHandler[]>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const api = {
    on(name: string, handler: EventHandler) {
      const existing = handlers.get(name) ?? [];
      existing.push(handler);
      handlers.set(name, existing);
    },
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    sendMessage(message: Record<string, unknown>, options: Record<string, unknown>) {
      sent.push({ message, options });
    },
    getSessionName() {
      return "pi-extension-test";
    },
  } as unknown as ExtensionAPI;

  async function emit(name: string, ...args: unknown[]): Promise<void> {
    for (const handler of handlers.get(name) ?? []) await handler(...args);
  }
  return { api, tools, commands, sent, emit };
}

test("workflow session affinity accepts only hub-owned or legacy-internal run bindings", () => {
  const runId = `run_${"a".repeat(32)}`;
  assert.equal(workflowRunIdForMessage({ workflowRunId: runId, from: "peer", correlationId: "unrelated" }), runId);
  assert.equal(workflowRunIdForMessage({
    workflowContext: { schema: "pi-mesh.workflow-message-context.v1", runId, stageId: "review", requirementKey: "approval", attempt: 1 },
    from: "peer",
  }), runId);
  assert.equal(workflowRunIdForMessage({ from: `workflow:${runId}`, correlationId: runId }), runId);
  assert.equal(workflowRunIdForMessage({ from: "peer", correlationId: runId }), undefined);
  const malformed = { workflowRunId: "run_../escape", from: `workflow:${runId}`, correlationId: runId };
  assert.equal(workflowRunIdForMessage(malformed), undefined);
  assert.throws(() => bindingForMessage(malformed), /malformed or conflicts/);
  assert.throws(() => bindingForMessage({
    workflowRunId: runId,
    workflowContext: { schema: "pi-mesh.workflow-message-context.v1", runId: `run_${"b".repeat(32)}`, stageId: "review", requirementKey: "approval", attempt: 1 },
    from: "peer",
  }), /malformed or conflicts/);
});

test("Pi extension registers tools, exchanges work, queues inbound turns, and reports status", async (context) => {
  const webhookSecret = "extension-webhook-secret-value";
  const mesh = await createTestMesh(context, {
    webhookWorkflows: [{
      id: "extension-workflow",
      source: "generic",
      project: "test-project",
      target: "pi-under-test",
      secret: webhookSecret,
      delivery: "followUp",
      promptTemplate: "Handle {{task.id}}",
      stages: [{
        id: "work",
        label: "Work",
        instructions: "Do the work",
        requiredEvidence: ["test"],
        maxAttempts: 2,
        evidencePolicies: {
          test: {
            kind: "peer-reply",
            minProducers: 1,
            eligibleAgents: ["reviewer"],
            acceptedStatuses: ["replied"],
          },
        },
      }],
    }],
  });
  const peer = mesh.makeClient("reviewer");
  await peer.start(async (event) => {
    if (event.type !== "message") return;
    await peer.acknowledge(event.message.id);
    if (
      event.message.content === "outbound review"
      || event.message.content === "workflow provenance send"
      || event.message.content === "workflow provenance fanout"
    ) {
      await peer.reply(event.message.id, "outbound approved");
    }
  });

  const previous = {
    url: process.env.KXM_SERVER_URL,
    token: process.env.KXM_AUTH_TOKEN,
    project: process.env.KXM_PROJECT,
    name: process.env.KXM_AGENT_NAME,
    purpose: process.env.KXM_AGENT_PURPOSE,
  };
  Object.assign(process.env, {
    KXM_SERVER_URL: mesh.address.url,
    KXM_AUTH_TOKEN: mesh.token,
    KXM_PROJECT: "test-project",
    KXM_AGENT_NAME: "pi-under-test",
    KXM_AGENT_PURPOSE: "Tests native Pi integration",
  });
  context.after(() => {
    for (const [key, value] of Object.entries({
      KXM_SERVER_URL: previous.url,
      KXM_AUTH_TOKEN: previous.token,
      KXM_PROJECT: previous.project,
      KXM_AGENT_NAME: previous.name,
      KXM_AGENT_PURPOSE: previous.purpose,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const fake = fakePi();
  piMeshExtension(fake.api);
  assert.deepEqual([...fake.tools.keys()], [
    "kxm_list",
    "kxm_send",
    "kxm_get",
    "kxm_fanout",
    "kxm_await",
    "kxm_cancel",
    "kxm_workflow_list",
    "kxm_workflow_get",
    "kxm_workflow_checkpoint",
    "kxm_workflow_wait",
    "kxm_workflow_record",
    "kxm_improvement_report",
    "kxm_context",
    "kxm_recall",
    "kxm_state",
    "kxm_episode",
    "kxm_promote",
  ]);
  const sendTool = fake.tools.get("kxm_send")!;
  const sendProperties = (sendTool.parameters as {
    properties: Record<string, Record<string, unknown>>;
  }).properties;
  assert.deepEqual(
    (sendProperties.workflowContext!.required as string[]),
    ["runId", "stageId", "requirementKey", "attempt"],
  );
  assert.match(String(sendProperties.idempotencyKey!.description), /not a workflow security or evidence binding/);
  const checkpointProperties = (fake.tools.get("kxm_workflow_checkpoint")!.parameters as {
    properties: Record<string, Record<string, unknown>>;
  }).properties;
  const evidenceRefValue = checkpointProperties.evidenceRefs!.patternProperties as Record<
    string,
    { properties: { messageIds: { maxItems: number } } }
  >;
  assert.equal(Object.values(evidenceRefValue)[0]!.properties.messageIds.maxItems, 16);
  assert.ok(fake.commands.has("kxm"));
  assert.equal(fake.commands.has("mesh-status"), false);

  const statuses: string[] = [];
  const notices: Array<{ message: string; type: string }> = [];
  const ui = {
    setStatus(_key: string, value: string) {
      statuses.push(value);
    },
    notify(message: string, type: string) {
      notices.push({ message, type });
    },
  };
  await fake.emit("session_start", {}, {
    cwd: process.cwd(),
    model: { provider: "test", id: "model" },
    ui,
  });
  assert.ok(statuses.includes("hub:pi-under-test"));
  await waitFor(async () => (await peer.listAgents()).some((agent) => agent.name === "pi-under-test"));

  const listed = await fake.tools.get("kxm_list")!.execute("call-list", {});
  assert.match(JSON.stringify(listed.details), /reviewer/);
  const sent = await fake.tools.get("kxm_send")!.execute("call-send", {
    target: "reviewer",
    content: "outbound review",
    delivery: "followUp",
    correlationId: "extension-test",
    idempotencyKey: "extension-send-1",
    ttlMs: 5_000,
  });
  const sentId = (sent.details as { messageId: string }).messageId;
  const awaited = await fake.tools.get("kxm_await")!.execute("call-await", { messageId: sentId, timeoutMs: 2_000 });
  assert.match(JSON.stringify(awaited.details), /outbound approved/);
  const fetched = await fake.tools.get("kxm_get")!.execute("call-get", { messageId: sentId });
  assert.match(JSON.stringify(fetched.details), /replied/);
  const panel = await fake.tools.get("kxm_fanout")!.execute("call-fanout", {
    targets: ["reviewer"],
    content: "outbound review",
    correlationId: "extension-panel",
    idempotencyKeyPrefix: "extension-panel",
    timeoutMs: 2_000,
  });
  assert.match(JSON.stringify(panel.details), /outbound approved/);
  const fanoutAbort = new AbortController();
  setTimeout(() => fanoutAbort.abort(), 30).unref();
  const interruptedPanel = await fake.tools.get("kxm_fanout")!.execute("call-fanout-abort", {
    targets: ["reviewer"],
    content: "continue this review after prompt interruption",
    correlationId: "extension-panel-abort",
    idempotencyKeyPrefix: "extension-panel-abort",
    timeoutMs: 2_000,
  }, fanoutAbort.signal);
  const [interruptedResponse] = (interruptedPanel.details as {
    responses: Array<Record<string, unknown>>;
  }).responses;
  assert.equal(interruptedResponse?.status, "pending");
  assert.equal(interruptedResponse?.waitStatus, "aborted");
  assert.ok(interruptedResponse?.messageId);
  assert.ok(interruptedResponse?.expiresAt);
  assert.ok(interruptedResponse?.messageStatus === "queued" || interruptedResponse?.messageStatus === "delivered");

  const firstInbound = await peer.send({ target: "pi-under-test", content: "first inbound", delivery: "followUp" });
  const secondInbound = await peer.send({ target: "pi-under-test", content: "second inbound", delivery: "nextTurn" });
  await waitFor(() => fake.sent.length === 1);
  assert.equal(fake.sent[0]!.options.triggerTurn, true);
  assert.equal(fake.sent[0]!.options.deliverAs, "followUp");
  assert.equal((await peer.getMessage(firstInbound.id)).status, "delivered");
  assert.equal((await peer.getMessage(secondInbound.id)).status, "queued", "waiting work must remain durable in the hub queue");
  await fake.emit("message_start", { message: fake.sent[0]!.message });
  await fake.emit("agent_end", {
    messages: [{ role: "assistant", content: [{ type: "text", text: "first result" }] }],
  });
  await fake.emit("agent_settled");
  assert.equal((await peer.awaitResponse(firstInbound.id, 2_000)).reply?.content, "first result");
  await waitFor(() => fake.sent.length === 2);
  assert.equal(fake.sent[1]!.options.triggerTurn, true, "an idle autonomous worker must start its next turn");
  assert.equal(fake.sent[1]!.options.deliverAs, "followUp", "hub nextTurn is normalized because workers have no future human prompt");
  assert.equal((await peer.getMessage(secondInbound.id)).status, "delivered");
  await fake.emit("message_start", { message: fake.sent[1]!.message });
  const normalQueued = await peer.send({ target: "pi-under-test", content: "normal queued work", delivery: "followUp" });
  const steeringQueued = await peer.send({ target: "pi-under-test", content: "priority course correction", delivery: "steer" });
  assert.equal((await peer.getMessage(normalQueued.id)).status, "queued");
  assert.equal((await peer.getMessage(steeringQueued.id)).status, "queued");
  await fake.emit("agent_end", { messages: [{ role: "assistant", content: "second result" }] });
  await fake.emit("agent_settled");
  assert.equal((await peer.awaitResponse(secondInbound.id, 2_000)).reply?.content, "second result");

  await waitFor(() => fake.sent.length === 3);
  assert.equal(fake.sent[2]!.options.deliverAs, "steer");
  assert.match(String(fake.sent[2]!.message.content), /priority course correction/);
  assert.equal((await peer.getMessage(normalQueued.id)).status, "queued");
  await fake.emit("message_start", { message: fake.sent[2]!.message });
  await fake.emit("agent_end", { messages: [{ role: "assistant", content: "course corrected" }] });
  await fake.emit("agent_settled");
  assert.equal((await peer.awaitResponse(steeringQueued.id, 2_000)).reply?.content, "course corrected");

  await waitFor(() => fake.sent.length === 4);
  assert.match(String(fake.sent[3]!.message.content), /normal queued work/);
  await fake.emit("message_start", { message: fake.sent[3]!.message });
  await fake.emit("agent_end", { messages: [{ role: "assistant", content: "normal work complete" }] });
  await fake.emit("agent_settled");
  assert.equal((await peer.awaitResponse(normalQueued.id, 2_000)).reply?.content, "normal work complete");

  const workflowPayload = JSON.stringify({ event: "task", task: { id: "TASK-7" } });
  const workflowResponse = await fetch(`${mesh.address.url}/v1/webhooks/extension-workflow`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kxm-delivery-id": "extension-delivery-7",
      "x-hub-signature": `sha256=${createHmac("sha256", webhookSecret).update(workflowPayload).digest("hex")}`,
    },
    body: workflowPayload,
  });
  const workflowBody = await workflowResponse.json() as { run: { id: string } };
  await waitFor(() => fake.sent.length === 5);
  const workflowRunId = workflowBody.run.id;
  await fake.emit("message_start", { message: fake.sent[4]!.message });
  await fake.emit("tool_result", {
    toolName: "bash",
    toolCallId: "tool-failure-1",
    isError: true,
    text: "ENOENT command not found",
  });
  const afterToolFailure = await fake.tools.get("kxm_workflow_get")!.execute("workflow-get-after-tool", { runId: workflowRunId });
  assert.match(JSON.stringify(afterToolFailure.details), /Tool bash failed: command_not_found/);
  assert.doesNotMatch(JSON.stringify(afterToolFailure.details), /sk-|ghp_|Bearer |prompt body|stdout dump/);
  assert.match(JSON.stringify((await fake.tools.get("kxm_workflow_list")!.execute("workflow-list", {})).details), /TASK|extension-workflow/);
  assert.match(JSON.stringify((await fake.tools.get("kxm_workflow_get")!.execute("workflow-get", { runId: workflowRunId })).details), /in_progress/);
  const provenanceContext = {
    runId: workflowRunId,
    stageId: "work",
    requirementKey: "test",
    attempt: 1,
  };
  const provenanceSend = await fake.tools.get("kxm_send")!.execute("workflow-provenance-send", {
    target: "reviewer",
    content: "workflow provenance send",
    correlationId: workflowRunId,
    idempotencyKey: "workflow-provenance-send-1",
    workflowContext: provenanceContext,
  });
  const provenanceSendId = (provenanceSend.details as { messageId: string }).messageId;
  await fake.tools.get("kxm_await")!.execute("workflow-provenance-send-await", {
    messageId: provenanceSendId,
    timeoutMs: 2_000,
  });
  const provenanceMessage = await fake.tools.get("kxm_get")!.execute("workflow-provenance-send-get", {
    messageId: provenanceSendId,
  });
  const provenanceMessageDetails = provenanceMessage.details as {
    workflowRunId?: string;
    workflowContext: Record<string, unknown>;
  };
  assert.equal(provenanceMessageDetails.workflowRunId, workflowRunId);
  assert.deepEqual(provenanceMessageDetails.workflowContext, {
    schema: "pi-mesh.workflow-message-context.v1",
    ...provenanceContext,
  });
  const provenanceFanout = await fake.tools.get("kxm_fanout")!.execute("workflow-provenance-fanout", {
    targets: ["reviewer"],
    content: "workflow provenance fanout",
    correlationId: workflowRunId,
    idempotencyKeyPrefix: "workflow-provenance-fanout",
    workflowContext: provenanceContext,
    timeoutMs: 2_000,
  });
  const [provenanceFanoutResult] = (provenanceFanout.details as {
    responses: Array<{ messageId: string }>;
  }).responses;
  const provenanceFanoutMessage = await fake.tools.get("kxm_get")!.execute("workflow-provenance-fanout-get", {
    messageId: provenanceFanoutResult!.messageId,
  });
  const provenanceFanoutDetails = provenanceFanoutMessage.details as {
    workflowRunId?: string;
    workflowContext: Record<string, unknown>;
  };
  assert.equal(provenanceFanoutDetails.workflowRunId, workflowRunId);
  assert.deepEqual(provenanceFanoutDetails.workflowContext, {
    schema: "pi-mesh.workflow-message-context.v1",
    ...provenanceContext,
  });
  await fake.tools.get("kxm_workflow_record")!.execute("workflow-record", {
    runId: workflowRunId,
    category: "decision",
    area: "implementation",
    summary: "Use the smallest safe change",
  });
  await assert.rejects(() => fake.tools.get("kxm_workflow_wait")!.execute("workflow-wait-invalid", {
    runId: workflowRunId,
    stageId: "work",
    signalKey: "external-check",
    summary: "Wait for external check",
    evidenceRefs: { test: { messageIds: ["msg_missing_surface_reference"] } },
  }), /peer evidence message not found/);
  const checkpoint = await fake.tools.get("kxm_workflow_checkpoint")!.execute("workflow-checkpoint", {
    runId: workflowRunId,
    stageId: "work",
    status: "passed",
    summary: "Work and test complete",
    evidenceRefs: { test: { messageIds: [provenanceSendId] } },
  });
  assert.equal((checkpoint.details as { completed: boolean }).completed, true);
  assert.match(JSON.stringify((await fake.tools.get("kxm_improvement_report")!.execute("improvements", {})).details), /implementation/);
  await fake.emit("agent_end", { messages: [{ role: "assistant", content: "workflow complete" }] });
  await fake.emit("agent_settled");

  const exactLimitInbound = await peer.send({
    target: "pi-under-test",
    content: "return an exact-limit response",
    delivery: "followUp",
  });
  await waitFor(() => fake.sent.length === 6);
  await fake.emit("message_start", { message: fake.sent[5]!.message });
  const exactLimitReply = "x".repeat(32_000);
  await fake.emit("agent_end", { messages: [{ role: "assistant", content: exactLimitReply }] });
  await fake.emit("agent_settled");
  assert.equal((await peer.awaitResponse(exactLimitInbound.id, 2_000)).reply?.content, exactLimitReply);

  const oversizedInbound = await peer.send({
    target: "pi-under-test",
    content: "return an oversized response",
    delivery: "followUp",
  });
  await waitFor(() => fake.sent.length === 7);
  await fake.emit("message_start", { message: fake.sent[6]!.message });
  const oversizedReply = "x".repeat(32_001);
  await fake.emit("agent_end", { messages: [{ role: "assistant", content: oversizedReply }] });
  await fake.emit("agent_settled");
  const boundedReply = (await peer.awaitResponse(oversizedInbound.id, 2_000)).reply?.content ?? "";
  assert.equal(boundedReply.length, 32_000);
  assert.match(boundedReply, /response truncated from 32001 characters to fit the message limit/);

  const cancellable = await fake.tools.get("kxm_send")!.execute("call-send-cancel", {
    target: "reviewer",
    content: "do not complete",
  });
  const cancelled = await fake.tools.get("kxm_cancel")!.execute("call-cancel", {
    messageId: (cancellable.details as { messageId: string }).messageId,
  });
  assert.match(JSON.stringify(cancelled.details), /cancelled/);

  await fake.commands.get("kxm")!.handler("hub", { ui });
  assert.ok(notices.some((notice) => notice.message.includes("pi-under-test") && notice.type === "info"));
  await fake.emit("session_shutdown");
  await fake.commands.get("kxm")!.handler("hub", { ui });
  assert.ok(notices.some((notice) => notice.message.includes("no agent connected") && notice.type === "warning"));
  await assert.rejects(() => fake.tools.get("kxm_list")!.execute("offline", {}), /not connected/);
});

test("fresh Pi session receives a durable workflow recovery turn", async (context) => {
  const secret = "recovery-webhook-secret-value";
  const mesh = await createTestMesh(context, {
    webhookWorkflows: [{
      id: "recovery-workflow",
      source: "generic",
      project: "recovery-project",
      target: "recovering-agent",
      secret,
      delivery: "followUp",
      promptTemplate: "Recover {{task}}",
      stages: [{ id: "implement", label: "Implement", instructions: "Continue safely", requiredEvidence: ["test"], maxAttempts: 2 }],
    }],
  });
  const bootstrap = mesh.makeClient("recovering-agent", {
    purpose: "durable recovery target",
    project: "recovery-project",
  });
  await bootstrap.start(() => undefined);
  await bootstrap.stop();
  const body = JSON.stringify({ task: "REC-1" });
  const started = await fetch(`${mesh.address.url}/v1/webhooks/recovery-workflow`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kxm-delivery-id": "recovery-delivery-1",
      "x-hub-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  });
  const runId = ((await started.json()) as { run: { id: string } }).run.id;
  const stateDir = mkdtempSync(join(tmpdir(), "pi-mesh-extension-recovery-"));
  context.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const envelopePath = recoveryEnvelopePath(stateDir, "recovering-agent");
  writeFileSync(envelopePath, JSON.stringify({
    version: 1,
    reason: "unresumable_session",
    agentName: "recovering-agent",
    project: "recovery-project",
    previousContinue: true,
    freshSession: true,
    createdAt: "2026-08-26T00:00:00.000Z",
    runId,
    stageId: "implement",
    pendingMessageIds: [],
  }));
  const keys = ["KXM_SERVER_URL", "KXM_AUTH_TOKEN", "KXM_PROJECT", "KXM_AGENT_NAME", "KXM_STATE_DIR"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    KXM_SERVER_URL: mesh.address.url,
    KXM_AUTH_TOKEN: mesh.token,
    KXM_PROJECT: "recovery-project",
    KXM_AGENT_NAME: "recovering-agent",
    KXM_STATE_DIR: stateDir,
  });
  context.after(() => {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const fake = fakePi();
  piMeshExtension(fake.api);
  const ui = { setStatus() {}, notify() {} };
  await fake.emit("session_start", {}, { cwd: process.cwd(), model: { provider: "test", id: "model" }, ui });
  await waitFor(() => fake.sent.some(({ message }) => message.customType === "kxm-recovery"));
  const recovered = fake.sent.find(({ message }) => message.customType === "kxm-recovery")!;
  assert.match(String(recovered.message.content), new RegExp(runId));
  assert.match(String(recovered.message.content), /Last recorded stage: implement/);
  assert.equal(recovered.options.triggerTurn, true);
  assert.equal(existsSync(envelopePath), false);
  const workflow = await fake.tools.get("kxm_workflow_get")!.execute("recovered-run", { runId });
  assert.match(JSON.stringify(workflow.details), /Worker recovered with unresumable_session/);
  await fake.emit("session_shutdown");
});

test("fresh tool-timeout recovery relies on one durable inbound replay", async (context) => {
  const secret = "tool-timeout-recovery-secret";
  const mesh = await createTestMesh(context, {
    webhookWorkflows: [{
      id: "tool-timeout-recovery-workflow",
      source: "generic",
      project: "tool-timeout-recovery-project",
      target: "tool-timeout-agent",
      secret,
      delivery: "followUp",
      promptTemplate: "Recover {{task}}",
      stages: [{ id: "review", label: "Review", instructions: "Continue safely", requiredEvidence: [], maxAttempts: 2 }],
    }],
  });
  const bootstrap = mesh.makeClient("tool-timeout-agent", {
    purpose: "durable timeout recovery target",
    project: "tool-timeout-recovery-project",
  });
  await bootstrap.start(() => undefined);
  await bootstrap.stop();

  const body = JSON.stringify({ task: "TIMEOUT-1" });
  const started = await fetch(`${mesh.address.url}/v1/webhooks/tool-timeout-recovery-workflow`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kxm-delivery-id": "tool-timeout-recovery-delivery-1",
      "x-hub-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  });
  assert.equal(started.status, 202);
  const run = ((await started.json()) as { run: { id: string; messageId: string } }).run;

  const stateDir = mkdtempSync(join(tmpdir(), "pi-mesh-tool-timeout-recovery-"));
  context.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const envelopePath = recoveryEnvelopePath(stateDir, "tool-timeout-agent");
  writeFileSync(envelopePath, JSON.stringify({
    version: 1,
    reason: "tool_timeout",
    agentName: "tool-timeout-agent",
    project: "tool-timeout-recovery-project",
    previousContinue: false,
    freshSession: true,
    failureClass: "timeout",
    createdAt: "2026-08-26T00:00:00.000Z",
    runId: run.id,
    stageId: "review",
    pendingMessageIds: [run.messageId],
  }));

  const keys = ["KXM_SERVER_URL", "KXM_AUTH_TOKEN", "KXM_PROJECT", "KXM_AGENT_NAME", "KXM_STATE_DIR"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    KXM_SERVER_URL: mesh.address.url,
    KXM_AUTH_TOKEN: mesh.token,
    KXM_PROJECT: "tool-timeout-recovery-project",
    KXM_AGENT_NAME: "tool-timeout-agent",
    KXM_STATE_DIR: stateDir,
  });
  context.after(() => {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const fake = fakePi();
  piMeshExtension(fake.api);
  const ui = { setStatus() {}, notify() {} };
  await fake.emit("session_start", {}, { cwd: process.cwd(), model: { provider: "test", id: "model" }, ui });
  await waitFor(() => fake.sent.some(({ message }) => message.customType === "kxm-inbound"));
  assert.equal(fake.sent.filter(({ message }) => message.customType === "kxm-inbound").length, 1);
  assert.equal(fake.sent.some(({ message }) => message.customType === "kxm-recovery"), false);
  assert.equal(
    (fake.sent.find(({ message }) => message.customType === "kxm-inbound")?.message.details as { messageId?: string } | undefined)?.messageId,
    run.messageId,
  );
  assert.equal(existsSync(envelopePath), false);
  const workflow = await fake.tools.get("kxm_workflow_get")!.execute("tool-timeout-recovered-run", { runId: run.id });
  assert.match(JSON.stringify(workflow.details), /Worker recovered with tool_timeout/);
  await fake.emit("session_shutdown");
});

test("Pi extension preserves workflow work after a settled provider error and allows retry", async (context) => {
  const secret = "provider-recovery-webhook-secret";
  const mesh = await createTestMesh(context, {
    webhookWorkflows: [{
      id: "provider-recovery-workflow",
      source: "generic",
      project: "provider-recovery-project",
      target: "provider-recovery-agent",
      secret,
      delivery: "followUp",
      promptTemplate: "Recover {{task}}",
      stages: [{
        id: "review",
        label: "Review",
        instructions: "Complete the review",
        requiredEvidence: [],
        maxAttempts: 2,
      }],
    }],
  });
  const stateDir = mkdtempSync(join(tmpdir(), "pi-mesh-provider-recovery-"));
  const legacyContextPath = join(stateDir, "worker-context-provider-recovery-agent.json");
  writeFileSync(legacyContextPath, JSON.stringify({
    version: 1,
    agentName: "provider-recovery-agent",
    project: "provider-recovery-project",
    runId: "run_stale_legacy",
  }));
  context.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const keys = ["KXM_SERVER_URL", "KXM_AUTH_TOKEN", "KXM_PROJECT", "KXM_AGENT_NAME", "KXM_STATE_DIR"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    KXM_SERVER_URL: mesh.address.url,
    KXM_AUTH_TOKEN: mesh.token,
    KXM_PROJECT: "provider-recovery-project",
    KXM_AGENT_NAME: "provider-recovery-agent",
    KXM_STATE_DIR: stateDir,
  });
  context.after(() => {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const fake = fakePi();
  piMeshExtension(fake.api);
  const notices: Array<{ message: string; type: string }> = [];
  await fake.emit("session_start", {}, {
    cwd: process.cwd(),
    model: { provider: "test", id: "model" },
    ui: {
      setStatus() {},
      notify(message: string, type: string) { notices.push({ message, type }); },
    },
  });
  const body = JSON.stringify({ task: "RECOVER-QUOTA" });
  const started = await fetch(`${mesh.address.url}/v1/webhooks/provider-recovery-workflow`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kxm-delivery-id": "provider-recovery-delivery-1",
      "x-hub-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  });
  assert.equal(started.status, 202);
  const runId = ((await started.json()) as { run: { id: string } }).run.id;
  await waitFor(() => fake.sent.length === 1);
  await fake.emit("message_start", { message: fake.sent[0]!.message });
  await fake.emit("agent_end", {
    messages: [{
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Quota reached. Secret provider body sk-must-not-be-journaled.",
    }],
  });
  await fake.emit("agent_settled");

  const run = mesh.hub.state.workflowRuns.get(runId)!;
  const message = mesh.hub.state.messages.get(run.messageId)!;
  assert.equal(message.status, "delivered");
  assert.equal(run.status, "running");
  const recoveryContext = JSON.parse(readFileSync(join(stateDir, `worker-context-${workerStateKey("provider-recovery-project", "provider-recovery-agent")}.json`), "utf8")) as {
    pendingMessageIds: string[];
  };
  assert.ok(recoveryContext.pendingMessageIds.includes(message.id));
  assert.equal(existsSync(legacyContextPath), false);
  const afterFailure = await fake.tools.get("kxm_workflow_get")!.execute("provider-error-run", { runId });
  const serialized = JSON.stringify(afterFailure.details);
  assert.match(serialized, /Tool provider failed: quota/);
  assert.match(serialized, /nextAction:switch_model_or_retry/);
  assert.doesNotMatch(serialized, /Secret provider body|sk-must-not-be-journaled/);
  assert.ok(notices.some((notice) => notice.type === "error" && notice.message.includes("retained") && notice.message.includes("quota")));

  // A successful retry before settlement must overwrite the failed outcome so
  // Pi's own retries and an operator-initiated retry can complete normally.
  await fake.emit("agent_end", {
    messages: [{ role: "assistant", content: "recovered response", stopReason: "stop" }],
  });
  await fake.tools.get("kxm_workflow_checkpoint")!.execute("provider-recovery-checkpoint", {
    runId,
    stageId: "review",
    status: "passed",
    summary: "Provider fallback completed the review",
  });
  await fake.emit("agent_settled");
  await waitFor(() => mesh.hub.state.messages.get(message.id)?.status === "replied");
  assert.equal(mesh.hub.state.messages.get(message.id)?.reply?.content, "recovered response");
  assert.equal(mesh.hub.state.workflowRuns.get(runId)?.status, "completed");
  await fake.emit("session_shutdown");
});

test("Pi extension drops terminal work, advances its queue, and exposes transient reply failures", async (context) => {
  const mesh = await createTestMesh(context, { messageRetentionMs: 1_000, cleanupIntervalMs: 25 });
  const peer = mesh.makeClient("queue-sender", { requestTimeoutMs: 5_000 });
  await peer.start(() => undefined);
  const stateDir = mkdtempSync(join(tmpdir(), "pi-mesh-extension-queue-"));
  context.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const keys = ["KXM_SERVER_URL", "KXM_AUTH_TOKEN", "KXM_PROJECT", "KXM_AGENT_NAME", "KXM_STATE_DIR"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    KXM_SERVER_URL: mesh.address.url,
    KXM_AUTH_TOKEN: mesh.token,
    KXM_PROJECT: "test-project",
    KXM_AGENT_NAME: "queue-worker",
    KXM_STATE_DIR: stateDir,
  });
  context.after(() => {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const fake = fakePi();
  piMeshExtension(fake.api);
  const notices: Array<{ message: string; type: string }> = [];
  try {
    await fake.emit("session_start", {}, {
      cwd: process.cwd(),
      model: { provider: "test", id: "model" },
      ui: {
        setStatus() {},
        notify(message: string, type: string) { notices.push({ message, type }); },
      },
    });

    const first = await peer.send({ target: "queue-worker", content: "hold the queue" });
    await waitFor(() => fake.sent.length === 1);
    await fake.emit("message_start", { message: fake.sent[0]!.message });
    const expiring = await peer.send({ target: "queue-worker", content: "must never run", ttlMs: 1_000 });
    const next = await peer.send({ target: "queue-worker", content: "run after the first" });
    const contextPath = join(stateDir, `worker-context-${workerStateKey("test-project", "queue-worker")}.json`);
    await waitFor(() => {
      if (!existsSync(contextPath)) return false;
      const envelope = JSON.parse(readFileSync(contextPath, "utf8")) as { pendingMessageIds: string[] };
      return envelope.pendingMessageIds.includes(expiring.id) && envelope.pendingMessageIds.includes(next.id);
    });
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    assert.equal((await peer.getMessage(expiring.id)).status, "expired");
    await waitFor(() => {
      const envelope = JSON.parse(readFileSync(contextPath, "utf8")) as { pendingMessageIds: string[] };
      return !envelope.pendingMessageIds.includes(expiring.id) && envelope.pendingMessageIds.includes(next.id);
    });

    await fake.emit("agent_end", { messages: [{ role: "assistant", content: "first complete" }] });
    await fake.emit("agent_settled");
    assert.equal((await peer.awaitResponse(first.id, 2_000)).reply?.content, "first complete");
    await waitFor(() => fake.sent.length === 2);
    assert.match(String(fake.sent[1]!.message.content), /run after the first/);
    assert.doesNotMatch(String(fake.sent[1]!.message.content), /must never run/);
    await fake.emit("message_start", { message: fake.sent[1]!.message });
    await fake.emit("agent_end", { messages: [{ role: "assistant", content: "next complete" }] });
    await fake.emit("agent_settled");
    assert.equal((await peer.awaitResponse(next.id, 2_000)).reply?.content, "next complete");

    const expiredActive = await peer.send({
      target: "queue-worker",
      content: "expire while active",
      ttlMs: 1_000,
    });
    await waitFor(() => fake.sent.length === 3);
    await fake.emit("message_start", { message: fake.sent[2]!.message });
    await fake.emit("agent_end", { messages: [{ role: "assistant", content: "late result" }] });
    const afterExpiration = await peer.send({ target: "queue-worker", content: "run after active expiration" });
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    assert.equal((await peer.getMessage(expiredActive.id)).status, "expired");
    await waitFor(() => !mesh.hub.state.messages.has(expiredActive.id), 2_000);
    await fake.emit("agent_settled");
    await waitFor(() => fake.sent.length === 4);
    assert.match(String(fake.sent[3]!.message.content), /run after active expiration/);
    await fake.emit("message_start", { message: fake.sent[3]!.message });
    await fake.emit("agent_end", { messages: [{ role: "assistant", content: "expiration recovery complete" }] });
    await fake.emit("agent_settled");
    assert.equal((await peer.awaitResponse(afterExpiration.id, 2_000)).reply?.content, "expiration recovery complete");

    const cancellationRace = await peer.send({ target: "queue-worker", content: "race cancellation with settlement" });
    await waitFor(() => fake.sent.length === 5);
    await fake.emit("message_start", { message: fake.sent[4]!.message });
    await fake.emit("agent_end", { messages: [{ role: "assistant", content: "must be rejected" }] });
    const afterConflict = await peer.send({ target: "queue-worker", content: "run after terminal conflict" });
    const conflictFetch = globalThis.fetch;
    let cancellationSent = false;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith(`/v1/messages/${cancellationRace.id}/reply`) && init?.method === "POST") {
        if (!cancellationSent) {
          cancellationSent = true;
          await peer.cancel(cancellationRace.id);
        }
      }
      return await conflictFetch(input, init);
    };
    try {
      await fake.emit("agent_settled");
    } finally {
      globalThis.fetch = conflictFetch;
    }
    assert.equal((await peer.getMessage(cancellationRace.id)).status, "cancelled");
    await waitFor(() => fake.sent.length === 6);
    assert.match(String(fake.sent[5]!.message.content), /run after terminal conflict/);
    await fake.emit("message_start", { message: fake.sent[5]!.message });
    await fake.emit("agent_end", { messages: [{ role: "assistant", content: "conflict recovery complete" }] });
    await fake.emit("agent_settled");
    assert.equal((await peer.awaitResponse(afterConflict.id, 2_000)).reply?.content, "conflict recovery complete");

    const transient = await peer.send({ target: "queue-worker", content: "retry a transient reply" });
    await waitFor(() => fake.sent.length === 7);
    await fake.emit("message_start", { message: fake.sent[6]!.message });
    await fake.emit("agent_end", { messages: [{ role: "assistant", content: "eventual reply" }] });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith(`/v1/messages/${transient.id}/reply`) && init?.method === "POST") {
        throw new Error("simulated transient reply outage");
      }
      return await originalFetch(input, init);
    };
    try {
      await fake.emit("agent_settled");
    } finally {
      globalThis.fetch = originalFetch;
    }
    const retained = JSON.parse(readFileSync(contextPath, "utf8")) as { pendingMessageIds: string[] };
    assert.ok(retained.pendingMessageIds.includes(transient.id));
    assert.ok(notices.some((notice) => notice.type === "error" && notice.message.includes("recovery state was retained")));
    await fake.emit("agent_end", { messages: [{ role: "assistant", content: "unrelated later turn" }] });
    assert.equal((await peer.awaitResponse(transient.id, 2_000)).reply?.content, "eventual reply");
    assert.equal(existsSync(contextPath), false);

    const ackFetch = globalThis.fetch;
    let ackFailed = false;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!ackFailed && url.endsWith("/ack") && init?.method === "POST") {
        ackFailed = true;
        throw new Error("simulated transient acknowledgement outage");
      }
      return await ackFetch(input, init);
    };
    let ackRecovery: Awaited<ReturnType<typeof peer.send>>;
    try {
      ackRecovery = await peer.send({ target: "queue-worker", content: "recover acknowledgement replay" });
      await waitFor(() => ackFailed);
    } finally {
      globalThis.fetch = ackFetch;
    }
    await waitFor(() => fake.sent.length === 8, 3_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fake.sent.length, 8);
    await fake.emit("message_start", { message: fake.sent[7]!.message });
    await fake.emit("agent_end", { messages: [{ role: "assistant", content: "ack recovery complete" }] });
    await fake.emit("agent_settled");
    assert.equal((await peer.awaitResponse(ackRecovery!.id, 2_000)).reply?.content, "ack recovery complete");

    const shutdownRace = await peer.send({ target: "queue-worker", content: "retain settlement during shutdown" });
    await waitFor(() => fake.sent.length === 9);
    await fake.emit("message_start", { message: fake.sent[8]!.message });
    await fake.emit("agent_end", { messages: [{ role: "assistant", content: "shutdown reply" }] });
    await peer.send({ target: "queue-worker", content: "must not activate during shutdown" });
    const shutdownFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith(`/v1/messages/${shutdownRace.id}/reply`) && init?.method === "POST") {
        throw new Error("simulated shutdown settlement outage");
      }
      return await shutdownFetch(input, init);
    };
    try {
      await fake.emit("agent_settled");
    } finally {
      globalThis.fetch = shutdownFetch;
    }
    await fake.emit("session_shutdown");
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(fake.sent.length, 9);
  } finally {
    await shutdownExtension(fake);
  }
});

test("supervised Pi routes a workflow prompt before acknowledgement and replays it in the run session", async (context) => {
  const secret = "session-isolation-webhook-secret";
  const mesh = await createTestMesh(context, {
    webhookWorkflows: [{
      id: "session-isolation",
      source: "generic",
      project: "test-project",
      target: "isolation-worker",
      secret,
      delivery: "followUp",
      promptTemplate: "Isolate {{task}}",
      stages: [{
        id: "work",
        label: "Work",
        instructions: "Complete isolated work",
        requiredEvidence: ["result"],
        maxAttempts: 2,
      }],
    }],
  });
  const stateDir = mkdtempSync(join(tmpdir(), "pi-mesh-extension-session-route-"));
  context.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const keys = [
    "KXM_SERVER_URL",
    "KXM_AUTH_TOKEN",
    "KXM_PROJECT",
    "KXM_AGENT_NAME",
    "KXM_STATE_DIR",
    "KXM_WORKER_IDENTITY_KEY",
    "KXM_WORKER_GENERATION",
    "KXM_WORKER_CHILD_INCARCATION",
    "KXM_WORKER_SESSION_ISOLATION",
    "KXM_WORKER_SESSION_SCOPE",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const identityKey = workerStateKey("test-project", "isolation-worker");
  Object.assign(process.env, {
    KXM_SERVER_URL: mesh.address.url,
    KXM_AUTH_TOKEN: mesh.token,
    KXM_PROJECT: "test-project",
    KXM_AGENT_NAME: "isolation-worker",
    KXM_STATE_DIR: stateDir,
    KXM_WORKER_IDENTITY_KEY: identityKey,
    KXM_WORKER_GENERATION: "generation-one",
    KXM_WORKER_CHILD_INCARCATION: "1",
    KXM_WORKER_SESSION_ISOLATION: "workflow",
    KXM_WORKER_SESSION_SCOPE: "default",
  });
  context.after(() => {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const first = fakePi();
  piMeshExtension(first.api);
  let shutdowns = 0;
  const ui = { setStatus() {}, notify() {} };
  await first.emit("session_start", {}, {
    cwd: process.cwd(),
    model: { provider: "test", id: "model" },
    sessionManager: { getSessionId: () => "11111111-1111-4111-8111-111111111111" },
    ui,
    shutdown() { shutdowns += 1; },
  });
  const body = JSON.stringify({ task: "workflow context" });
  const response = await fetch(`${mesh.address.url}/v1/webhooks/session-isolation`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kxm-delivery-id": "session-isolation-delivery",
      "x-hub-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  });
  assert.equal(response.status, 202);
  const started = await response.json() as { run: { id: string; messageId: string } };
  const requestPath = join(stateDir, `worker-session-request-${identityKey}.json`);
  await waitFor(() => existsSync(requestPath) && shutdowns === 1);
  assert.equal(first.sent.length, 0, "the source session must never activate workflow work");
  assert.equal(mesh.hub.state.messages.get(started.run.messageId)?.status, "queued");
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  assert.deepEqual(request.from, { kind: "default" });
  assert.deepEqual(request.to, { kind: "workflow", runId: started.run.id });
  assert.equal(request.messageId, started.run.messageId);
  assert.equal("content" in request, false);
  await first.emit("session_shutdown");

  rmSync(requestPath, { force: true });
  process.env.KXM_WORKER_SESSION_SCOPE = `workflow:${started.run.id}`;
  const replacement = fakePi();
  piMeshExtension(replacement.api);
  await replacement.emit("session_start", {}, {
    cwd: process.cwd(),
    model: { provider: "test", id: "model" },
    sessionManager: { getSessionId: () => "22222222-2222-4222-8222-222222222222" },
    ui,
    shutdown() { shutdowns += 1; },
  });
  await waitFor(() => replacement.sent.length === 1);
  assert.equal(mesh.hub.state.messages.get(started.run.messageId)?.status, "delivered");
  assert.match(String(replacement.sent[0]!.message.content), /Isolate workflow context/);

  const generalSender = mesh.makeClient("general-sender", { project: "test-project" });
  await generalSender.start(() => undefined);
  const general = await generalSender.send({ target: "isolation-worker", content: "ordinary non-workflow work" });
  const contextPath = join(stateDir, `worker-context-${workerStateKey("test-project", "isolation-worker")}.json`);
  await waitFor(() => existsSync(contextPath) && readFileSync(contextPath, "utf8").includes(general.id));
  assert.equal(existsSync(requestPath), false, "a different binding must not route during an awaiting/active turn");
  assert.equal(mesh.hub.state.messages.get(general.id)?.status, "queued");

  await replacement.emit("message_start", { message: replacement.sent[0]!.message });
  await replacement.emit("agent_end", { messages: [{ role: "assistant", content: "isolated result" }] });
  await replacement.emit("agent_settled");
  const terminal = mesh.hub.state.messages.get(started.run.messageId);
  assert.equal(terminal?.status, "replied");
  assert.equal(terminal?.reply?.content, "isolated result");
  await waitFor(() => existsSync(requestPath) && shutdowns === 2);
  assert.equal(replacement.sent.length, 1, "ordinary work must not activate inside the workflow session");
  assert.equal(mesh.hub.state.messages.get(general.id)?.status, "queued");
  const returnRequest = JSON.parse(readFileSync(requestPath, "utf8"));
  assert.deepEqual(returnRequest.from, { kind: "workflow", runId: started.run.id });
  assert.deepEqual(returnRequest.to, { kind: "default" });
  await replacement.emit("session_shutdown");

  rmSync(requestPath, { force: true });
  process.env.KXM_WORKER_SESSION_SCOPE = "default";
  const defaultReplacement = fakePi();
  piMeshExtension(defaultReplacement.api);
  await defaultReplacement.emit("session_start", {}, {
    cwd: process.cwd(),
    model: { provider: "test", id: "model" },
    sessionManager: { getSessionId: () => "33333333-3333-4333-8333-333333333333" },
    ui,
    shutdown() { shutdowns += 1; },
  });
  await waitFor(() => defaultReplacement.sent.length === 1);
  assert.match(String(defaultReplacement.sent[0]!.message.content), /ordinary non-workflow work/);
  assert.equal(mesh.hub.state.messages.get(general.id)?.status, "delivered");
  await defaultReplacement.emit("message_start", { message: defaultReplacement.sent[0]!.message });
  await defaultReplacement.emit("agent_end", { messages: [{ role: "assistant", content: "default result" }] });
  await defaultReplacement.emit("agent_settled");
  assert.equal(mesh.hub.state.messages.get(general.id)?.reply?.content, "default result");
  await defaultReplacement.emit("session_shutdown");
  await generalSender.stop();
});

test("Pi extension defers post-ack activation during shutdown and replays the message after restart", async (context) => {
  const mesh = await createTestMesh(context);
  const peer = mesh.makeClient("shutdown-ack-sender");
  await peer.start(() => undefined);
  const stateDir = mkdtempSync(join(tmpdir(), "pi-mesh-extension-shutdown-ack-"));
  context.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const keys = [
    "KXM_SERVER_URL",
    "KXM_AUTH_TOKEN",
    "KXM_PROJECT",
    "KXM_AGENT_NAME",
    "KXM_STATE_DIR",
    "KXM_WORKER_IDENTITY_KEY",
    "KXM_WORKER_ACTIVATION_TIMEOUT_MS",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    KXM_SERVER_URL: mesh.address.url,
    KXM_AUTH_TOKEN: mesh.token,
    KXM_PROJECT: "test-project",
    KXM_AGENT_NAME: "shutdown-ack-worker",
    KXM_STATE_DIR: stateDir,
    KXM_WORKER_IDENTITY_KEY: "shutdown-ack-test-worker",
    KXM_WORKER_ACTIVATION_TIMEOUT_MS: "1000",
  });
  context.after(() => {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const first = fakePi();
  piMeshExtension(first.api);
  const ui = { setStatus() {}, notify() {} };
  let watchdogRestarts = 0;
  const sessionContext = {
    cwd: process.cwd(),
    model: { provider: "test", id: "model" },
    ui,
    shutdown() { watchdogRestarts += 1; },
  };
  await first.emit("session_start", {}, sessionContext);

  let releaseAck!: () => void;
  const ackGate = new Promise<void>((resolve) => { releaseAck = resolve; });
  const originalFetch = globalThis.fetch;
  let deferred = false;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!deferred && url.endsWith("/ack") && init?.method === "POST") {
      deferred = true;
      await ackGate;
    }
    return await originalFetch(input, init);
  };

  let message: Awaited<ReturnType<typeof peer.send>>;
  try {
    message = await peer.send({ target: "shutdown-ack-worker", content: "replay after shutdown" });
    await waitFor(() => deferred);
    const shutdown = first.emit("session_shutdown");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(first.sent.length, 0);
    releaseAck();
    await shutdown;
  } finally {
    releaseAck();
    globalThis.fetch = originalFetch;
  }
  assert.equal(first.sent.length, 0);
  assert.equal((await peer.getMessage(message!.id)).status, "delivered");

  const restarted = fakePi();
  piMeshExtension(restarted.api);
  await restarted.emit("session_start", {}, sessionContext);
  await waitFor(() => restarted.sent.length === 1, 5_000);
  assert.match(String(restarted.sent[0]!.message.content), /replay after shutdown/);
  await restarted.emit("message_start", { message: restarted.sent[0]!.message });
  await restarted.emit("agent_end", { messages: [{ role: "assistant", content: "replayed safely" }] });
  await restarted.emit("agent_settled");
  assert.equal((await peer.awaitResponse(message!.id, 2_000)).reply?.content, "replayed safely");

  const stuck = await peer.send({ target: "shutdown-ack-worker", content: "detect missing model activation" });
  await waitFor(() => restarted.sent.length === 2);
  assert.equal((await peer.getMessage(stuck.id)).status, "delivered");
  await waitFor(() => watchdogRestarts === 1, 2_000);
  assert.equal((await peer.getMessage(stuck.id)).status, "delivered", "watchdog restart must preserve the active durable claim");
  await restarted.emit("session_shutdown");
});


test("Pi extension retries activation when sendMessage throws", async (context) => {
  const mesh = await createTestMesh(context);
  const peer = mesh.makeClient("activation-retry-sender");
  await peer.start(() => undefined);
  const stateDir = mkdtempSync(join(tmpdir(), "pi-mesh-extension-send-retry-"));
  context.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const keys = ["KXM_SERVER_URL", "KXM_AUTH_TOKEN", "KXM_PROJECT", "KXM_AGENT_NAME", "KXM_STATE_DIR"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    KXM_SERVER_URL: mesh.address.url,
    KXM_AUTH_TOKEN: mesh.token,
    KXM_PROJECT: "test-project",
    KXM_AGENT_NAME: "send-retry-worker",
    KXM_STATE_DIR: stateDir,
  });
  context.after(() => {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const fake = fakePi();
  let sendAttempts = 0;
  const piApi = fake.api as unknown as {
    sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => void;
  };
  const originalSend = piApi.sendMessage.bind(piApi);
  piApi.sendMessage = (message, options) => {
    sendAttempts += 1;
    if (sendAttempts === 1) throw new Error("simulated sendMessage failure");
    originalSend(message, options);
  };
  piMeshExtension(fake.api);
  const notices: Array<{ message: string; type: string }> = [];
  await fake.emit("session_start", {}, {
    cwd: process.cwd(),
    model: { provider: "test", id: "model" },
    ui: {
      setStatus() {},
      notify(message: string, type: string) { notices.push({ message, type }); },
    },
  });

  const inbound = await peer.send({ target: "send-retry-worker", content: "retry after sendMessage throws" });
  await waitFor(() => notices.some((notice) => notice.type === "error" && notice.message.includes("activation will retry")));
  assert.equal(fake.sent.length, 0);
  await waitFor(() => fake.sent.length === 1, 3_000);
  assert.equal(sendAttempts, 2);
  assert.match(String(fake.sent[0]!.message.content), /retry after sendMessage throws/);
  await fake.emit("message_start", { message: fake.sent[0]!.message });
  await fake.emit("agent_end", { messages: [{ role: "assistant", content: "send retry complete" }] });
  await fake.emit("agent_settled");
  assert.equal((await peer.awaitResponse(inbound.id, 2_000)).reply?.content, "send retry complete");
  await fake.emit("session_shutdown");
});

test("Pi extension drops a message when acknowledgement is already terminal", async (context) => {
  const mesh = await createTestMesh(context);
  const peer = mesh.makeClient("terminal-ack-sender");
  await peer.start(() => undefined);
  const stateDir = mkdtempSync(join(tmpdir(), "pi-mesh-extension-terminal-ack-"));
  context.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const keys = ["KXM_SERVER_URL", "KXM_AUTH_TOKEN", "KXM_PROJECT", "KXM_AGENT_NAME", "KXM_STATE_DIR"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    KXM_SERVER_URL: mesh.address.url,
    KXM_AUTH_TOKEN: mesh.token,
    KXM_PROJECT: "test-project",
    KXM_AGENT_NAME: "terminal-ack-worker",
    KXM_STATE_DIR: stateDir,
  });
  context.after(() => {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const fake = fakePi();
  piMeshExtension(fake.api);
  await fake.emit("session_start", {}, {
    cwd: process.cwd(),
    model: { provider: "test", id: "model" },
    ui: { setStatus() {}, notify() {} },
  });

  const originalFetch = globalThis.fetch;
  let terminalAck = false;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!terminalAck && url.includes("/ack") && init?.method === "POST") {
      terminalAck = true;
      return new Response(JSON.stringify({
        error: "cannot acknowledge a replied message",
        code: "invalid_message_state",
      }), { status: 409, headers: { "content-type": "application/json" } });
    }
    return await originalFetch(input, init);
  };
  try {
    await peer.send({ target: "terminal-ack-worker", content: "must not activate after terminal ack" });
    await waitFor(() => terminalAck);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fake.sent.length, 0);
    const next = await peer.send({ target: "terminal-ack-worker", content: "activate after terminal ack skip" });
    await waitFor(() => fake.sent.length === 1);
    assert.match(String(fake.sent[0]!.message.content), /activate after terminal ack skip/);
    assert.doesNotMatch(String(fake.sent[0]!.message.content), /must not activate after terminal ack/);
    await fake.emit("message_start", { message: fake.sent[0]!.message });
    await fake.emit("agent_end", { messages: [{ role: "assistant", content: "terminal ack skip complete" }] });
    await fake.emit("agent_settled");
    assert.equal((await peer.awaitResponse(next.id, 2_000)).reply?.content, "terminal ack skip complete");
  } finally {
    globalThis.fetch = originalFetch;
  }
  await fake.emit("session_shutdown");
});

const SESSION_ENV_KEYS = [
  "KXM_SERVER_URL",
  "KXM_AUTH_TOKEN",
  "KXM_PROJECT",
  "KXM_AGENT_NAME",
  "KXM_AGENT_PURPOSE",
  "KXM_STATE_DIR",
  "KXM_DATA_PATH",
  "KXM_SESSION_BRIEF",
] as const;

function swapSessionEnv(context: { after: (fn: () => void) => void }, next: Record<string, string | undefined>): void {
  const previous = Object.fromEntries(SESSION_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of SESSION_ENV_KEYS) {
    const value = next[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  context.after(() => {
    for (const key of SESSION_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function recordingUi(selectImpl?: (title: string, options: string[]) => Promise<string | undefined>) {
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
  const notices: Array<{ message: string; type: string }> = [];
  const selects: Array<{ title: string; options: string[] }> = [];
  const editors: string[] = [];
  return {
    statuses,
    widgets,
    notices,
    selects,
    editors,
    ui: {
      setStatus(key: string, value: string | undefined) {
        statuses.push({ key, value });
      },
      setWidget(key: string, lines: string[] | undefined) {
        widgets.push({ key, lines });
      },
      notify(message: string, type: string) {
        notices.push({ message, type });
      },
      setEditorText(text: string) {
        editors.push(text);
      },
      async select(title: string, options: string[]) {
        selects.push({ title, options });
        return selectImpl ? await selectImpl(title, options) : undefined;
      },
    },
  };
}

async function shutdownExtension(fake: ReturnType<typeof fakePi>, timeoutMs = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fake.emit("session_shutdown"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`session_shutdown timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function lastKxmStatus(statuses: Array<{ key: string; value: string | undefined }>): string {
  const hit = [...statuses].reverse().find((item) => item.key === "kxm");
  assert.ok(typeof hit?.value === "string", "expected kxm status");
  return hit.value;
}

function lastKxmWidget(widgets: Array<{ key: string; lines: string[] | undefined }>): string[] {
  const hit = [...widgets].reverse().find((item) => item.key === "kxm-work");
  assert.ok(Array.isArray(hit?.lines) && hit.lines.length > 0, "expected kxm-work widget");
  return hit.lines;
}

function sessionCtx(cwd: string, ui: ReturnType<typeof recordingUi>["ui"], mode = "tui") {
  return {
    cwd,
    mode,
    model: { provider: "test", id: "model" },
    ui,
  };
}

async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function seedSessionSnapshot(root: string): void {
  const stateDir = join(root, ".kxm", "state");
  mkdirSync(stateDir, { recursive: true });
  const database = new DatabaseSync(join(stateDir, "kxm.db"));
  try {
    database.exec("CREATE TABLE agents (record TEXT NOT NULL); CREATE TABLE messages (record TEXT NOT NULL); CREATE TABLE workflow_runs (record TEXT NOT NULL); CREATE TABLE workflow_journal (category TEXT, record TEXT NOT NULL);");
    database.prepare("INSERT INTO workflow_runs(record) VALUES (?)").run(JSON.stringify({
      id: "run_ready1",
      status: "running",
      definitionId: "default",
      project: "demo",
      currentStage: "implement",
      stages: [
        { id: "plan", status: "passed" },
        { id: "implement", status: "in_progress" },
      ],
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    }));
    database.prepare("INSERT INTO workflow_journal(category, record) VALUES (?, ?)").run("plan", JSON.stringify({
      id: "plan_ready1",
      runId: "run_ready1",
      category: "plan",
      summary: "Continue the session-ready plan",
      createdAt: "2026-09-01T00:00:00.000Z",
    }));
  } finally {
    database.close();
  }
}

function assertOnlineChrome(rec: ReturnType<typeof recordingUi>): void {
  assert.match(lastKxmStatus(rec.statuses), /^kxm hub:on/);
  assert.match(lastKxmWidget(rec.widgets)[0]!, /hub:on/);
}

test("Pi extension session readiness keeps a single hub registration across startup, new, and fork", async (context) => {
  const mesh = await createTestMesh(context);
  const peer = mesh.makeClient("session-ready-observer");
  await peer.start(() => undefined);
  const cwd = mkdtempSync(join(tmpdir(), "kxm-session-ready-"));
  const fake = fakePi();
  context.after(async () => {
    await shutdownExtension(fake);
    rmSync(cwd, { recursive: true, force: true });
  });
  swapSessionEnv(context, {
    KXM_SERVER_URL: mesh.address.url,
    KXM_AUTH_TOKEN: mesh.token,
    KXM_PROJECT: "test-project",
    KXM_AGENT_NAME: "pi-session-ready",
    KXM_AGENT_PURPOSE: "Session readiness",
  });

  piMeshExtension(fake.api);
  const startup = recordingUi();
  await fake.emit("session_start", { reason: "startup" }, sessionCtx(cwd, startup.ui));
  assertOnlineChrome(startup);
  assert.equal(startup.selects.length, 0);
  await waitFor(async () => (await peer.listAgents()).filter((agent) => agent.name === "pi-session-ready").length === 1);

  await shutdownExtension(fake);
  const startedNew = recordingUi();
  await fake.emit("session_start", { reason: "new" }, sessionCtx(cwd, startedNew.ui));
  assertOnlineChrome(startedNew);
  assert.equal((await peer.listAgents()).filter((agent) => agent.name === "pi-session-ready").length, 1);

  const forked = recordingUi();
  await fake.emit("session_start", { reason: "fork" }, sessionCtx(cwd, forked.ui));
  assertOnlineChrome(forked);
  assert.equal((await peer.listAgents()).filter((agent) => agent.name === "pi-session-ready").length, 1);
  await shutdownExtension(fake);
});

test("Pi extension session readiness reports offline chrome and reapplies /kxm", async (context) => {
  const port = await closedLoopbackPort();
  const cwd = mkdtempSync(join(tmpdir(), "kxm-session-offline-"));
  const fake = fakePi();
  context.after(async () => {
    await shutdownExtension(fake);
    rmSync(cwd, { recursive: true, force: true });
  });
  swapSessionEnv(context, {
    KXM_SERVER_URL: `http://127.0.0.1:${port}`,
    KXM_PROJECT: "test-project",
    KXM_AGENT_NAME: "pi-session-offline",
  });

  piMeshExtension(fake.api);
  const offline = recordingUi();
  const ctx = sessionCtx(cwd, offline.ui);
  await fake.emit("session_start", { reason: "new" }, ctx);
  assert.match(lastKxmStatus(offline.statuses), /^kxm hub:off/);
  assert.match(lastKxmWidget(offline.widgets)[0]!, /hub:off/);
  assert.ok(offline.notices.some((notice) => notice.type === "error" && /kxm connection failed/.test(notice.message)));

  await fake.commands.get("kxm")!.handler("", ctx);
  assert.match(lastKxmStatus(offline.statuses), /^kxm hub:off/);
  assert.match(lastKxmWidget(offline.widgets)[0]!, /hub:off/);
  await shutdownExtension(fake);
});

test("Pi extension TUI picker can skip or select a populated snapshot, writes editor text, and skips RPC and opt-out", async (context) => {
  const mesh = await createTestMesh(context);
  const cwd = mkdtempSync(join(tmpdir(), "kxm-session-picker-"));
  seedSessionSnapshot(cwd);
  const fake = fakePi();
  context.after(async () => {
    await shutdownExtension(fake);
    rmSync(cwd, { recursive: true, force: true });
  });
  swapSessionEnv(context, {
    KXM_SERVER_URL: mesh.address.url,
    KXM_AUTH_TOKEN: mesh.token,
    KXM_PROJECT: "test-project",
    KXM_AGENT_NAME: "pi-session-picker",
  });

  piMeshExtension(fake.api);

  const skipped = recordingUi(async (_title, options) => {
    assert.equal(options[0], SESSION_BRIEF_SKIP_LABEL);
    assert.ok(options.some((option) => /Task/.test(option)));
    assert.ok(options.some((option) => /Plan/.test(option)));
    return SESSION_BRIEF_SKIP_LABEL;
  });
  await fake.emit("session_start", { reason: "startup" }, sessionCtx(cwd, skipped.ui));
  assert.equal(skipped.selects.length, 1);
  assert.equal(skipped.editors.length, 0);
  assertOnlineChrome(skipped);
  assert.doesNotMatch(lastKxmWidget(skipped.widgets).join("\n"), /now  task/);
  assert.doesNotMatch(lastKxmStatus(skipped.statuses), /default\/implement/);
  await shutdownExtension(fake);

  const selected = recordingUi(async (_title, options) => options.find((option) => option.startsWith("Task")));
  await fake.emit("session_start", { reason: "new" }, sessionCtx(cwd, selected.ui));
  assert.equal(selected.selects.length, 1);
  assertOnlineChrome(selected);
  assert.match(lastKxmStatus(selected.statuses), /default\/implement/);
  assert.match(lastKxmWidget(selected.widgets).join("\n"), /now  task/);
  assert.equal(selected.editors.length, 1);
  assert.match(selected.editors[0]!, /Continue KXM task `default`/);
  await shutdownExtension(fake);

  const rpc = recordingUi();
  await fake.emit("session_start", { reason: "fork" }, sessionCtx(cwd, rpc.ui, "rpc"));
  assert.equal(rpc.selects.length, 0);
  assert.equal(rpc.editors.length, 0);
  assertOnlineChrome(rpc);
  await shutdownExtension(fake);

  swapSessionEnv(context, {
    KXM_SERVER_URL: mesh.address.url,
    KXM_AUTH_TOKEN: mesh.token,
    KXM_PROJECT: "test-project",
    KXM_AGENT_NAME: "pi-session-picker",
    KXM_SESSION_BRIEF: "off",
  });
  const optedOut = recordingUi();
  await fake.emit("session_start", { reason: "fork" }, sessionCtx(cwd, optedOut.ui));
  assert.equal(optedOut.selects.length, 0);
  assertOnlineChrome(optedOut);
  await shutdownExtension(fake);
});
